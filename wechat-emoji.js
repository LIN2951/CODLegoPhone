/**
 * Lego 小手机 · 微信表情与消息格式化模块
 *
 * 含：emoji IndexedDB 回退缓存、消息中的表情占位符解析、发送给 API 的消息压缩与表情格式化。
 * 依赖 app.js / wechat-store.js 中已存在的通用存储与媒体工具；需在 wechat-store.js 之后加载。
 */
(function (global) {
    'use strict';

    var g = global;
    var EMOJI_DATA_LS_KEY = 'emojiData';
    var EMOJI_CATEGORIES_LS_KEY = 'emojiCategories';
    var LS_IDB_PREFIX = 'IDB:';

    var __emojiDataCache = null;
    var __emojiCategoriesCache = null;

    async function saveEmojiDataToIdb(emojiDataObj) {
        var json = JSON.stringify(emojiDataObj && typeof emojiDataObj === 'object' ? emojiDataObj : {});
        await g.wechatKvSet(EMOJI_DATA_LS_KEY, json);
        __emojiDataCache = emojiDataObj && typeof emojiDataObj === 'object' ? emojiDataObj : {};
        try { localStorage.setItem(EMOJI_DATA_LS_KEY, LS_IDB_PREFIX + '1'); } catch (e) {}
    }

    async function saveEmojiCategoriesToIdb(list) {
        var json = JSON.stringify(list == null ? null : list);
        await g.wechatKvSet(EMOJI_CATEGORIES_LS_KEY, json);
        __emojiCategoriesCache = list == null ? null : list;
        try { localStorage.setItem(EMOJI_CATEGORIES_LS_KEY, LS_IDB_PREFIX + '1'); } catch (e) {}
    }

    async function preloadEmojiFromIdbIfNeeded() {
        try {
            var marker = localStorage.getItem(EMOJI_DATA_LS_KEY);
            if (typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX)) {
                if (__emojiDataCache == null) {
                    var raw = await g.wechatKvGet(EMOJI_DATA_LS_KEY);
                    if (typeof raw === 'string') {
                        var parsed = JSON.parse(raw);
                        __emojiDataCache = parsed && typeof parsed === 'object' ? parsed : {};
                    } else {
                        __emojiDataCache = {};
                    }
                }
            }
            var marker2 = localStorage.getItem(EMOJI_CATEGORIES_LS_KEY);
            if (typeof marker2 === 'string' && marker2.startsWith(LS_IDB_PREFIX)) {
                if (__emojiCategoriesCache == null) {
                    var raw2 = await g.wechatKvGet(EMOJI_CATEGORIES_LS_KEY);
                    if (typeof raw2 === 'string') {
                        __emojiCategoriesCache = JSON.parse(raw2);
                    } else {
                        __emojiCategoriesCache = null;
                    }
                }
            }
        } catch (e) {
            if (__emojiDataCache == null) __emojiDataCache = {};
            if (__emojiCategoriesCache == null) __emojiCategoriesCache = null;
        }
    }

    function getEmojiDataCache() {
        return __emojiDataCache;
    }

    function getEmojiCategoriesCache() {
        return __emojiCategoriesCache;
    }

    function resolveEmojiRefsInMessage(content, emojiList) {
        if (!content || typeof content !== 'string') return content;
        var findEmoji = function (rawName) {
            var n = String(rawName).trim();
            return (emojiList || []).find(function (e) {
                return e && e.name && (e.name === n || e.name.includes(n) || n.includes(e.name));
            });
        };
        var imgTag = function (url) {
            return '<img src="' + String(url).replace(/"/g, '&quot;') + '" alt="表情" class="chat-emoji" referrerpolicy="no-referrer" loading="lazy" onerror="this.onerror=null;this.classList.add(\'chat-emoji-broken\');this.alt=\'加载失败\';">';
        };
        var out = content;
        out = out.replace(/\[发送表情:([^\]]+)\]/g, function (_, name) {
            var emoji = findEmoji(name);
            return emoji && emoji.url ? imgTag(emoji.url) : '';
        });
        var urlTail = '(https?:\\/\\/[^\\s<>"\']+|\\/\\/[^\\s<>"\']+|data:image[^\\s<>"\']*)';
        out = out.replace(
            new RegExp('\\[表情\\s*[:：]\\s*([^\\]]+)\\](?:\\s*)?(?:\\r?\\n\\s*)?(' + urlTail + ')?', 'g'),
            function (full, name, urlAfter) {
                var emoji = findEmoji(name);
                if (!emoji || !emoji.url) return '';
                var tag = imgTag(emoji.url);
                if (!urlAfter) return tag;
                if (g.normalizeChatMediaUrl(urlAfter) === g.normalizeChatMediaUrl(emoji.url)) return tag;
                return tag + '\n' + urlAfter;
            }
        );
        return out;
    }

    function compactChatMessageContentForApi(msg) {
        if (msg == null) return '';
        if (typeof msg === 'string') return msg;
        if (typeof msg !== 'object') return String(msg);
        var sub = msg.subtype ? String(msg.subtype) : '';
        var raw = msg.content != null ? String(msg.content) : '';
        if (msg.type === 'system' && sub === 'voice_call_bundle') {
            return '【语音通话记录】（详情已收纳在会话中的折叠卡片）';
        }
        if (sub === 'moments_forward_card') {
            try {
                var data = JSON.parse(raw);
                var snap = data && data.snapshot;
                if (!snap || typeof snap !== 'object') return '【朋友圈转发】（快照无效）';
                var name = String(snap.friendName || '好友').trim() || '好友';
                var text = String(snap.text || '').trim();
                var textShort = text.length > 800 ? text.slice(0, 800) + '…' : text;
                var nImg = Array.isArray(snap.images) ? Math.min(snap.images.length, 9) : 0;
                var hasPolaroid = !!(snap.polaroidHtml && String(snap.polaroidHtml).trim());
                var likes = Array.isArray(snap.likes) ? snap.likes : [];
                var comments = Array.isArray(snap.comments) ? snap.comments : [];
                var likeNames = likes
                    .map(function (l) { return l && (l.authorName || l.name) ? String(l.authorName || l.name).trim() : ''; })
                    .filter(Boolean)
                    .slice(0, 20);
                var likeLine = likeNames.length ? ('点赞：' + likeNames.join('、')) : '';
                var commentLines = comments.slice(0, 20).map(function (c, idx) {
                    var who = c && c.authorName ? String(c.authorName).trim() : '某人';
                    var rt = c && c.replyTo ? ('（回复 ' + String(c.replyTo).trim() + '）') : '';
                    var t = c && c.text ? String(c.text) : '';
                    var tShort = t.length > 200 ? t.slice(0, 200) + '…' : t;
                    return '  ' + (idx + 1) + '. ' + who + rt + '：' + tShort;
                });
                return [
                    '【朋友圈转发】来自「' + name + '」',
                    textShort ? ('正文：' + textShort) : '',
                    nImg ? ('（附图 ' + nImg + ' 张）') : '',
                    hasPolaroid ? '（含拍立得卡片）' : '',
                    likeLine,
                    comments.length ? ('评论区（共 ' + comments.length + ' 条，节选）：\n' + commentLines.join('\n')) : ''
                ].filter(Boolean).join('\n');
            } catch (e) {
                return '【朋友圈转发】（快照解析失败）';
            }
        }
        if (sub === 'couple_space_invite_card' || sub === 'couple_space_accept_card') {
            try {
                var d = JSON.parse(raw);
                var k = d && d.kind ? String(d.kind) : '';
                var u = d && (d.fromUserName || d.userName) ? String(d.fromUserName || d.userName) : '我';
                var f = d && (d.toFriendName || d.friendName) ? String(d.toFriendName || d.friendName) : '好友';
                if (k === 'accept') return '【情侣空间·已答应】' + u + ' / ' + f;
                return '【情侣空间邀请】' + u + ' -> ' + f;
            } catch (e2) {
                return sub === 'couple_space_accept_card' ? '【情侣空间·已答应】' : '【情侣空间邀请】';
            }
        }
        if (sub === 'forward' && raw.length > 12000) {
            return raw.slice(0, 12000) + '…（转发内容过长已截断）';
        }
        if (raw.length > 100000) {
            return raw.slice(0, 50000) + '…（消息过长已截断）';
        }
        return raw;
    }

    function formatMessageForApi(rawContent, emojiList) {
        if (!rawContent || typeof rawContent !== 'string') return rawContent || '';
        if (!g.isChatEmojiContent(rawContent)) return rawContent;
        var norm = g.normalizeChatMediaUrl(rawContent);
        for (var i = 0; i < (emojiList || []).length; i++) {
            var emoji = emojiList[i];
            if (emoji && emoji.url && g.normalizeChatMediaUrl(emoji.url) === norm && emoji.name) {
                return '[表情: ' + emoji.name + ']';
            }
        }
        return '[表情/图片]';
    }

    g.saveEmojiDataToIdb = saveEmojiDataToIdb;
    g.saveEmojiCategoriesToIdb = saveEmojiCategoriesToIdb;
    g.preloadEmojiFromIdbIfNeeded = preloadEmojiFromIdbIfNeeded;
    g.resolveEmojiRefsInMessage = resolveEmojiRefsInMessage;
    g.compactChatMessageContentForApi = compactChatMessageContentForApi;
    g.formatMessageForApi = formatMessageForApi;

    if (typeof g.Wechat !== 'undefined' && g.Wechat) {
        g.Wechat.emoji = {
            version: '0.1.0',
            EMOJI_DATA_LS_KEY: EMOJI_DATA_LS_KEY,
            EMOJI_CATEGORIES_LS_KEY: EMOJI_CATEGORIES_LS_KEY,
            saveEmojiDataToIdb: saveEmojiDataToIdb,
            saveEmojiCategoriesToIdb: saveEmojiCategoriesToIdb,
            preloadEmojiFromIdbIfNeeded: preloadEmojiFromIdbIfNeeded,
            getEmojiDataCache: getEmojiDataCache,
            getEmojiCategoriesCache: getEmojiCategoriesCache,
            resolveEmojiRefsInMessage: resolveEmojiRefsInMessage,
            compactChatMessageContentForApi: compactChatMessageContentForApi,
            formatMessageForApi: formatMessageForApi,
        };
    }
})(typeof window !== 'undefined' ? window : this);
