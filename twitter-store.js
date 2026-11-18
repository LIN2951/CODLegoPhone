/**
 * Lego 小手机 · 推特/X — 存储与领域（阶段 1）
 *
 * 单入口：`window.Twitter.store`
 * 数据契约：localStorage `twitterFeeds_v2` 为 `{ following, forYou, entertainment }` 三字符串（HTML 片段）；
 * `twitterProfile_v1`、`twitterFollowingFriendIds_v1`、`twitterDetailUserExtra_v1` 见 app 内既有语义。
 *
 * 依赖（由 app.js 在同页提供，仅在运行时调用）：`loadFriendsFromStorage`
 */
(function (global) {
    'use strict';

    var TWITTER_FEEDS_LS_KEY = 'twitterFeeds_v2';
    var TWITTER_PROFILE_LS_KEY = 'twitterProfile_v1';
    var DARKWEB_FEEDS_LS_KEY = 'darkwebFeeds_v1';
    var DARKWEB_PROFILE_LS_KEY = 'darkwebProfile_v1';
    /** 关注板块：用户勾选的好友 id；未写入 key 前视为「全部非群非拉黑好友」 */
    var TWITTER_FOLLOWING_IDS_LS_KEY = 'twitterFollowingFriendIds_v1';
    var TWITTER_DETAIL_USER_EXTRA_LS_KEY = 'twitterDetailUserExtra_v1';
    var TWITTER_USER_POSTS_LS_KEY = 'twitterUserPosts_v1';
    /** 未单独设置推特 @ 的好友，默认英文 ID 前缀 */
    var TWITTER_FRIEND_HANDLE_PREFIX = 'Lego';

    /** 详情 HTML 内存缓存（与 app.js 详情 API 命中逻辑共用同一对象引用） */
    var _twitterDetailCache = {};

    function extractRoleCardDisplayName(roleText) {
        var t = String(roleText || '').trim();
        if (!t) return '';
        var labelRe = /(?:^|[\r\n])(?:名字|姓名|名稱|名称|称呼|角色名|Char(?:acter)?\s*name|Name)[：:\s]*([^\r\n]{1,100})/i;
        var lm = t.match(labelRe);
        if (lm) {
            var s = lm[1].trim().replace(/\*\*/g, '').replace(/^[\s"'「『【]+|[\s"'」』】]+$/g, '').trim();
            if (s.length >= 1 && s.length <= 80) return s;
        }
        var yamlName = t.match(/(?:^|[\r\n])[\s\-*]*name\s*[：:]\s*([^\r\n]+)/i);
        if (yamlName) {
            var yn = yamlName[1].trim().replace(/\*\*/g, '').replace(/^[\s"'「『【]+|[\s"'」』】]+$/g, '').trim();
            if (yn.length >= 1 && yn.length <= 80) return yn;
        }
        var lines = t.split(/\r?\n/).map(function (l) { return l.trim(); }).filter(Boolean);
        for (var i = 0; i < lines.length; i++) {
            var first = lines[i];
            if (!first) continue;
            if (/^basic_info\s*:?\s*$/i.test(first)) continue;
            if (/^basic_info\s*:/i.test(first)) continue;
            if (/^\w[\w_]*\s*:\s*$/.test(first)) continue;
            if (first.length > 70 || /^#{1,6}\s/.test(first) || /^【/.test(first)) continue;
            var cleaned = first.replace(/^\*\*?|\*\*?$/g, '').replace(/^#+\s+/, '').trim();
            if (/。\s*$/.test(cleaned) && cleaned.length > 35) continue;
            if (cleaned.length >= 1 && cleaned.length <= 60) return cleaned;
            break;
        }
        return '';
    }

    function resolveFriendAuthorDisplayName(f) {
        if (!f || f.isGroup) return '';
        var fromCard = extractRoleCardDisplayName(f.roleSetting || f.role || '');
        if (fromCard) return fromCard;
        var nick = String(f.nickname || '').trim();
        var rem = String(f.remark || '').trim();
        var lat = function (s) { return /[A-Za-zÀ-ÿ\u0100-\u024f]/.test(s); };
        var nickLat = lat(nick);
        var remLat = lat(rem);
        if (nickLat && !remLat) return nick || rem;
        if (remLat && !nickLat) return rem || nick;
        if (nick && rem && nickLat && remLat) return nick.length >= rem.length ? nick : rem;
        return nick || rem || '';
    }

    /**
     * 仅角色卡中解析出的姓名/称呼（暗网论坛未自定义代号时作为默认显示名）。不含好友列表昵称、备注。
     */
    function resolveFriendAuthorRoleCardNameForDarkWeb(f) {
        if (!f || f.isGroup) return '';
        return String(extractRoleCardDisplayName(f.roleSetting || f.role || '') || '').trim();
    }

    function loadTwitterFollowingFriendIdListRaw() {
        try {
            var raw = localStorage.getItem(TWITTER_FOLLOWING_IDS_LS_KEY);
            if (raw === null) return null;
            var arr = JSON.parse(raw);
            return Array.isArray(arr) ? arr.map(String) : null;
        } catch (e) {
            return null;
        }
    }

    function saveTwitterFollowingFriendIdList(ids) {
        try {
            localStorage.setItem(TWITTER_FOLLOWING_IDS_LS_KEY, JSON.stringify((ids || []).map(String)));
        } catch (e) {}
    }

    function getFriendsForTwitterFollowingFeed() {
        var all = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted && !f.isGroup; });
        var ids = loadTwitterFollowingFriendIdListRaw();
        if (ids === null) return all;
        if (ids.length === 0) return [];
        var set = new Set(ids);
        return all.filter(function (f) { return set.has(String(f.id)); });
    }

    function getTwitterFollowingSelectedCount() {
        return getFriendsForTwitterFollowingFeed().length;
    }

    function twitterStripHtmlToPlain(html) {
        if (!html || typeof html !== 'string') return '';
        var d = document.createElement('div');
        d.innerHTML = html;
        return (d.textContent || '').replace(/\s+/g, ' ').trim();
    }

    function twitterGetDetailExtraBlocksStore() {
        try {
            return JSON.parse(localStorage.getItem(TWITTER_DETAIL_USER_EXTRA_LS_KEY) || '{}');
        } catch (e) {
            return {};
        }
    }

    function twitterSaveDetailExtraBlocksStore(obj) {
        try {
            localStorage.setItem(TWITTER_DETAIL_USER_EXTRA_LS_KEY, JSON.stringify(obj));
        } catch (e) {}
    }

    function twitterAppendDetailExtraHtml(cacheKey, htmlFragment) {
        if (!cacheKey || !htmlFragment) return;
        var s = twitterGetDetailExtraBlocksStore();
        if (!Array.isArray(s[cacheKey])) s[cacheKey] = [];
        s[cacheKey].push(htmlFragment);
        twitterSaveDetailExtraBlocksStore(s);
    }

    function twitterApplyDetailExtraHtml(detailContentEl, cacheKey) {
        if (!detailContentEl || !cacheKey) return;
        var arr = twitterGetDetailExtraBlocksStore()[cacheKey];
        if (!Array.isArray(arr) || !arr.length) return;
        arr.forEach(function (h) {
            if (h) detailContentEl.insertAdjacentHTML('beforeend', h);
        });
    }

    function twitterSetDetailPageContext(payload, cacheKey) {
        global.__twitterDetailPayload = payload || null;
        global.__twitterDetailCacheKey = cacheKey || '';
        global.__twitterDetailFriend = payload && payload.friend ? payload.friend : null;
    }

    function getTwitterFeedsFromStorage() {
        try {
            return JSON.parse(localStorage.getItem(TWITTER_FEEDS_LS_KEY) || '{"following":"","forYou":"","entertainment":""}');
        } catch (e) {
            return { following: '', forYou: '', entertainment: '' };
        }
    }

    function getDarkWebFeedsFromStorage() {
        try {
            var o = JSON.parse(localStorage.getItem(DARKWEB_FEEDS_LS_KEY) || '{"following":"","forYou":"","entertainment":"","hub":""}');
            if (!o || typeof o !== 'object') return { following: '', forYou: '', entertainment: '', hub: '' };
            if (o.hub == null) o.hub = '';
            return o;
        } catch (e) {
            return { following: '', forYou: '', entertainment: '', hub: '' };
        }
    }

    function getFeedsByMode(mode) {
        return mode === 'darkweb' ? getDarkWebFeedsFromStorage() : getTwitterFeedsFromStorage();
    }

    function saveTwitterFeedsToStorage(feeds) {
        try {
            localStorage.setItem(TWITTER_FEEDS_LS_KEY, JSON.stringify(feeds));
        } catch (e) {}
    }

    function saveDarkWebFeedsToStorage(feeds) {
        try {
            localStorage.setItem(DARKWEB_FEEDS_LS_KEY, JSON.stringify(feeds));
        } catch (e) {}
    }

    function saveFeedsByMode(mode, feeds) {
        if (mode === 'darkweb') saveDarkWebFeedsToStorage(feeds);
        else saveTwitterFeedsToStorage(feeds);
    }

    /**
     * 阶段 5 可改为合并追加；当前等价于整段替换 following。
     * @param {string} normalizedHtml 已规范化、可写入面板 innerHTML 的字符串
     */
    /** 关注流：单次刷新最多保留的批次数（最旧批次先删） */
    var TWITTER_FOLLOWING_MAX_BATCHES = 16;
    /** 关注流：localStorage 字符串总长度软上限 */
    var TWITTER_FOLLOWING_MAX_STORED_CHARS = 750000;

    function splitFollowingFeedIntoBatches(html) {
        var h = String(html || '').trim();
        if (!h) return [];
        if (h.indexOf('twitter-feed-batch') < 0) return [h];
        var parts = h.split(/(?=<div\b[^>]*class="[^"]*twitter-feed-batch[^"]*"[^>]*>)/i);
        return parts.map(function (p) { return p.trim(); }).filter(Boolean);
    }

    /**
     * 阶段 5：关注 Tab 刷新时在**顶部**追加新批次（带 `data-refresh-batch-id`），保留历史；推荐/娱乐仍为整段替换。
     * @param {string} normalizedHtml 已规范化、可写入面板 innerHTML 的字符串
     * @param {number} [batchId] 可选时间戳；默认 `Date.now()`
     * @returns {string} 合并并裁剪后的 following 全文
     */
    function appendFollowingFeedBatch(normalizedHtml, batchId) {
        var inner = String(normalizedHtml || '').trim();
        if (!inner) {
            return getTwitterFeedsFromStorage().following || '';
        }
        var id = typeof batchId === 'number' && batchId > 0 ? batchId : Date.now();
        var wrapped = '<div class="twitter-feed-batch" data-refresh-batch-id="' + id + '">' + inner + '</div>';
        var feeds = getTwitterFeedsFromStorage();
        var prev = feeds.following || '';
        var merged;
        if (!prev.trim()) {
            merged = wrapped;
        } else if (prev.indexOf('twitter-feed-batch') >= 0) {
            merged = wrapped + prev;
        } else {
            merged = wrapped + '<div class="twitter-feed-batch" data-refresh-batch-id="0">' + prev + '</div>';
        }
        merged = trimFollowingFeedStoredHtml(merged);
        feeds.following = merged;
        saveTwitterFeedsToStorage(feeds);
        return merged;
    }

    function trimFollowingFeedStoredHtml(html) {
        var batches = splitFollowingFeedIntoBatches(html);
        var totalLen = function () {
            return batches.join('').length;
        };
        while (batches.length > TWITTER_FOLLOWING_MAX_BATCHES || totalLen() > TWITTER_FOLLOWING_MAX_STORED_CHARS) {
            if (batches.length > 1) {
                batches.pop();
            } else {
                var only = batches[0] || '';
                if (only.length > TWITTER_FOLLOWING_MAX_STORED_CHARS) {
                    batches[0] = only.slice(0, TWITTER_FOLLOWING_MAX_STORED_CHARS);
                }
                break;
            }
        }
        return batches.join('');
    }

    /** 整段替换 following（兼容旧名；全量覆盖场景可继续调用） */
    function mergeFollowingFeedFromApi(normalizedHtml) {
        var feeds = getTwitterFeedsFromStorage();
        feeds.following = normalizedHtml || '';
        saveTwitterFeedsToStorage(feeds);
    }

    /**
     * 生成可发往微信输入框的纯文本摘要（由 UI 组装 `parts`）。
     * @param {{ tab?: string, displayName?: string, handle?: string, time?: string, bodyPlain?: string }} parts
     */
    function buildTwitterSharePayload(parts) {
        parts = parts || {};
        var lines = ['[分享·推特]'];
        var dn = String(parts.displayName || '').trim();
        var hk = String(parts.handle || '').replace(/^@/, '').trim();
        if (dn) lines.push(dn);
        if (hk) lines.push('@' + hk);
        var tm = String(parts.time || '').trim();
        if (tm) lines.push(tm);
        lines.push('');
        var body = String(parts.bodyPlain != null ? parts.bodyPlain : '').trim();
        if (!body && parts.plainText) body = String(parts.plainText).trim();
        lines.push(body || '（无正文）');
        var plainText = lines.join('\n').slice(0, 8000);
        return {
            source: 'twitter',
            tab: String(parts.tab || ''),
            displayName: dn,
            handle: hk,
            plainText: plainText
        };
    }

    function loadTwitterProfile() {
        try {
            return JSON.parse(localStorage.getItem(TWITTER_PROFILE_LS_KEY) || 'null');
        } catch (e) {
            return null;
        }
    }

    function loadDarkWebProfile() {
        try {
            return JSON.parse(localStorage.getItem(DARKWEB_PROFILE_LS_KEY) || 'null');
        } catch (e) {
            return null;
        }
    }

    function loadProfileByMode(mode) {
        return mode === 'darkweb' ? loadDarkWebProfile() : loadTwitterProfile();
    }

    function saveTwitterProfile(profile) {
        try {
            localStorage.setItem(TWITTER_PROFILE_LS_KEY, JSON.stringify(profile));
        } catch (e) {}
    }

    function saveDarkWebProfile(profile) {
        try {
            localStorage.setItem(DARKWEB_PROFILE_LS_KEY, JSON.stringify(profile));
        } catch (e) {}
    }

    function saveProfileByMode(mode, profile) {
        if (mode === 'darkweb') saveDarkWebProfile(profile);
        else saveTwitterProfile(profile);
    }

    function normalizeTwitterUserComment(comment) {
        var c = comment || {};
        return {
            id: c.id != null ? String(c.id) : ('twc_' + Math.random().toString(36).slice(2, 9)),
            friendId: c.friendId != null ? String(c.friendId) : '',
            authorName: String(c.authorName || '').slice(0, 80),
            handle: String(c.handle || '').replace(/^@/, '').slice(0, 40),
            text: String(c.text || '').slice(0, 500),
            role: c.role === 'user' ? 'user' : 'friend',
            createdAt: Number(c.createdAt) || Date.now(),
            replyToCommentId: c.replyToCommentId != null ? String(c.replyToCommentId) : '',
            replyToAuthorName: String(c.replyToAuthorName || '').slice(0, 80)
        };
    }

    function normalizeTwitterUserPost(post) {
        var p = post || {};
        var comments = Array.isArray(p.comments) ? p.comments.map(normalizeTwitterUserComment) : [];
        comments.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        return {
            id: p.id != null ? String(p.id) : ('twp_' + Date.now()),
            text: String(p.text || '').slice(0, 280),
            createdAt: Number(p.createdAt) || Date.now(),
            commentCountBase: Math.max(0, Number(p.commentCountBase) || 0),
            repostCount: Math.max(0, Number(p.repostCount) || 0),
            likeCount: Math.max(0, Number(p.likeCount) || 0),
            viewCount: Math.max(0, Number(p.viewCount) || 0),
            comments: comments
        };
    }

    function loadTwitterUserPosts() {
        try {
            var raw = JSON.parse(localStorage.getItem(TWITTER_USER_POSTS_LS_KEY) || '[]');
            var list = Array.isArray(raw) ? raw.map(normalizeTwitterUserPost) : [];
            list.sort(function (a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
            return list;
        } catch (e) {
            return [];
        }
    }

    function saveTwitterUserPosts(posts) {
        try {
            localStorage.setItem(TWITTER_USER_POSTS_LS_KEY, JSON.stringify(Array.isArray(posts) ? posts : []));
        } catch (e) {}
    }

    function getTwitterUserPostById(postId) {
        if (postId == null) return null;
        var list = loadTwitterUserPosts();
        for (var i = 0; i < list.length; i++) {
            if (String(list[i].id) === String(postId)) return list[i];
        }
        return null;
    }

    function upsertTwitterUserPost(post) {
        var next = normalizeTwitterUserPost(post);
        var list = loadTwitterUserPosts();
        var idx = list.findIndex(function (item) { return String(item.id) === String(next.id); });
        if (idx >= 0) list[idx] = next;
        else list.unshift(next);
        saveTwitterUserPosts(list);
        return next;
    }

    function appendTwitterUserPostComments(postId, comments) {
        var post = getTwitterUserPostById(postId);
        if (!post) return null;
        var baseTs = Date.now();
        (Array.isArray(comments) ? comments : []).forEach(function (comment, idx) {
            var normalized = normalizeTwitterUserComment(Object.assign({}, comment, {
                createdAt: Number(comment && comment.createdAt) || (baseTs + idx)
            }));
            if (!normalized.text) return;
            post.comments.push(normalized);
        });
        post.comments.sort(function (a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        return upsertTwitterUserPost(post);
    }

    function parseTwitterJoinedParts(joinedStr) {
        var s = (joinedStr || '').trim();
        var y = new Date().getFullYear();
        var m = 3;
        var d = 1;
        var re = /(\d{4})年(\d{1,2})月(?:\s*(\d{1,2})日)?/;
        var match = s.match(re);
        if (match) {
            y = parseInt(match[1], 10) || y;
            m = parseInt(match[2], 10) || m;
            if (match[3]) d = parseInt(match[3], 10) || d;
        }
        m = Math.min(12, Math.max(1, m));
        d = Math.min(31, Math.max(1, d));
        return { y: y, m: m, d: d };
    }

    function twitterDeriveHandleFromDisplayName(name, fallback) {
        var t0 = (name || '').trim();
        var t = t0;
        try {
            t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        } catch (e) {
            t = t0;
        }
        var ascii = t
            .replace(/[^\x20-\x7E]/g, '')
            .replace(/\s+/g, '_')
            .replace(/[^a-zA-Z0-9_]/g, '')
            .replace(/_+/g, '_')
            .replace(/^_|_$/g, '');
        if (ascii.length >= 2) return ascii.slice(0, 20).toLowerCase();
        var fb = (fallback || '').toString().replace(/^@/, '').trim();
        if (fb) return fb.slice(0, 30);
        return 'lego';
    }

    function defaultTwitterFriendHandle(f) {
        if (!f) return TWITTER_FRIEND_HANDLE_PREFIX + '_0';
        var custom = (f.twitterHandle || '').toString().replace(/^@/, '').trim();
        if (custom) return custom;
        return TWITTER_FRIEND_HANDLE_PREFIX + '_' + f.id;
    }

    function twitterNormalizeKeyLoose(s) {
        var raw = String(s || '').trim();
        if (!raw) return '';
        var out = raw;
        try {
            out = out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
        } catch (e) {}
        out = out
            .replace(/[\u201c\u201d"\u2018\u2019]/g, '')
            .replace(/[()（）[\]【】]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();
        return out;
    }

    function twitterExtractCodenameAliasesFromDisplayName(name) {
        var out = [];
        var s = String(name || '');
        var re = /["'「『]([^"'」』]+)["'」』]/g;
        var m;
        while ((m = re.exec(s))) {
            var part = String(m[1] || '').trim();
            if (part.length >= 2) out.push(part);
        }
        return out;
    }

    function twitterAddFriendToTweetHandleMap(byHandle, f) {
        if (!f || !byHandle || f.isGroup) return;
        var h = String(defaultTwitterFriendHandle(f)).replace(/^@/, '').toLowerCase();
        byHandle.set(h, f);
        byHandle.set(String(TWITTER_FRIEND_HANDLE_PREFIX + '_' + f.id).toLowerCase(), f);
        byHandle.set(String('user_' + f.id).toLowerCase(), f);
        var alias = function (k) {
            if (!k || String(k).length < 2) return;
            var low = String(k).toLowerCase();
            if (!byHandle.has(low)) byHandle.set(low, f);
            var norm = twitterNormalizeKeyLoose(k);
            if (norm && norm.length >= 2 && !byHandle.has(norm)) byHandle.set(norm, f);
            var derived = twitterDeriveHandleFromDisplayName(k, '');
            if (derived && derived.length >= 2 && !byHandle.has(derived)) byHandle.set(derived, f);
        };
        var card = resolveFriendAuthorDisplayName(f);
        if (card) {
            var first = card.split(/\s+/)[0].replace(/[^a-zA-Z0-9\u00C0-\u024F]/gi, '');
            alias(first);
            alias(card);
            twitterExtractCodenameAliasesFromDisplayName(card).forEach(alias);
        }
        var derived = twitterDeriveHandleFromDisplayName(card || String(f.nickname || '').trim() || '', String(f.id));
        if (derived) {
            alias(derived);
            var seg0 = derived.split('_').filter(Boolean)[0];
            alias(seg0);
        }
        var nick = String(f.nickname || '').trim();
        var rem = String(f.remark || '').trim();
        if (nick) alias(nick);
        if (rem) alias(rem);
    }

    /** 模型自拟 @Ghost_141 / @Soap_141 等：前缀与代号回退匹配 */
    function twitterLookupFriendInHandleMap(byHandle, key) {
        if (!byHandle || key == null || key === '') return null;
        var raw = String(key).replace(/^@/, '').trim().toLowerCase();
        if (!raw) return null;
        if (byHandle.get(raw)) return byHandle.get(raw);
        var norm = twitterNormalizeKeyLoose(raw);
        if (norm && byHandle.get(norm)) return byHandle.get(norm);
        var prefixNum = raw.match(/^([a-z][a-z0-9_]{1,24})_\d+$/i);
        if (prefixNum) {
            var base = prefixNum[1].toLowerCase();
            if (byHandle.get(base)) return byHandle.get(base);
            var baseSeg = base.split('_').filter(Boolean)[0];
            if (baseSeg && baseSeg.length >= 2 && byHandle.get(baseSeg)) return byHandle.get(baseSeg);
        }
        var seg0 = raw.split('_').filter(Boolean)[0];
        if (seg0 && seg0.length >= 2 && byHandle.get(seg0)) return byHandle.get(seg0);
        return null;
    }

    function getEffectiveTwitterUserHandle(profile) {
        var p = profile || loadTwitterProfile() || {};
        var raw = (p.handle || '').toString().replace(/^@/, '').trim();
        if (raw && raw.toLowerCase() !== 'user') return raw;
        var derived = twitterDeriveHandleFromDisplayName((p.displayName || '').trim(), '');
        if (derived && derived.toLowerCase() !== 'user') return derived;
        return 'lego';
    }

    function getTwitterUserAvatarDataUrl() {
        var profile = loadTwitterProfile() || {};
        var tw = (profile.avatarDataUrl && String(profile.avatarDataUrl).trim()) || '';
        if (tw) return tw;
        try {
            return localStorage.getItem('userAvatar') || '';
        } catch (e) {
            return '';
        }
    }

    function getTwitterUserHandle() {
        return getEffectiveTwitterUserHandle(loadTwitterProfile());
    }

    function twitterDetailCacheKey(payload, clickedIndex) {
        if (!payload) return null;
        var textChunk = (payload.textHtml || '').replace(/<[^>]+>/g, '').slice(0, 80);
        var timeRaw = payload.timeRaw || payload.time || '';
        var tweetDigest = (payload.tweetPlainText || '').slice(0, 100);
        var titleChunk = String(payload.threadTitle || '').slice(0, 80);
        var idx = String(typeof clickedIndex === 'number' && clickedIndex >= 0 ? clickedIndex : 0);
        var raw = [payload.displayName || '', payload.handle || '', timeRaw, titleChunk, textChunk, tweetDigest, idx].join('|');
        var h = 0;
        for (var i = 0; i < raw.length; i++) h = Math.imul(31, h) + raw.charCodeAt(i) | 0;
        return 'twd2_' + Math.abs(h).toString(36);
    }

    var api = {
        TWITTER_FEEDS_LS_KEY: TWITTER_FEEDS_LS_KEY,
        TWITTER_PROFILE_LS_KEY: TWITTER_PROFILE_LS_KEY,
        TWITTER_FOLLOWING_IDS_LS_KEY: TWITTER_FOLLOWING_IDS_LS_KEY,
        TWITTER_DETAIL_USER_EXTRA_LS_KEY: TWITTER_DETAIL_USER_EXTRA_LS_KEY,
        TWITTER_USER_POSTS_LS_KEY: TWITTER_USER_POSTS_LS_KEY,
        TWITTER_FRIEND_HANDLE_PREFIX: TWITTER_FRIEND_HANDLE_PREFIX,
        _twitterDetailCache: _twitterDetailCache,
        extractRoleCardDisplayName: extractRoleCardDisplayName,
        resolveFriendAuthorDisplayName: resolveFriendAuthorDisplayName,
        resolveFriendAuthorRoleCardNameForDarkWeb: resolveFriendAuthorRoleCardNameForDarkWeb,
        loadTwitterFollowingFriendIdListRaw: loadTwitterFollowingFriendIdListRaw,
        saveTwitterFollowingFriendIdList: saveTwitterFollowingFriendIdList,
        getFriendsForTwitterFollowingFeed: getFriendsForTwitterFollowingFeed,
        getTwitterFollowingSelectedCount: getTwitterFollowingSelectedCount,
        twitterStripHtmlToPlain: twitterStripHtmlToPlain,
        twitterGetDetailExtraBlocksStore: twitterGetDetailExtraBlocksStore,
        twitterSaveDetailExtraBlocksStore: twitterSaveDetailExtraBlocksStore,
        twitterAppendDetailExtraHtml: twitterAppendDetailExtraHtml,
        twitterApplyDetailExtraHtml: twitterApplyDetailExtraHtml,
        twitterSetDetailPageContext: twitterSetDetailPageContext,
        getTwitterFeedsFromStorage: getTwitterFeedsFromStorage,
        getDarkWebFeedsFromStorage: getDarkWebFeedsFromStorage,
        getFeedsByMode: getFeedsByMode,
        saveTwitterFeedsToStorage: saveTwitterFeedsToStorage,
        saveDarkWebFeedsToStorage: saveDarkWebFeedsToStorage,
        saveFeedsByMode: saveFeedsByMode,
        mergeFollowingFeedFromApi: mergeFollowingFeedFromApi,
        appendFollowingFeedBatch: appendFollowingFeedBatch,
        splitFollowingFeedIntoBatches: splitFollowingFeedIntoBatches,
        TWITTER_FOLLOWING_MAX_BATCHES: TWITTER_FOLLOWING_MAX_BATCHES,
        TWITTER_FOLLOWING_MAX_STORED_CHARS: TWITTER_FOLLOWING_MAX_STORED_CHARS,
        buildTwitterSharePayload: buildTwitterSharePayload,
        loadTwitterProfile: loadTwitterProfile,
        loadDarkWebProfile: loadDarkWebProfile,
        loadProfileByMode: loadProfileByMode,
        saveTwitterProfile: saveTwitterProfile,
        saveDarkWebProfile: saveDarkWebProfile,
        saveProfileByMode: saveProfileByMode,
        normalizeTwitterUserPost: normalizeTwitterUserPost,
        normalizeTwitterUserComment: normalizeTwitterUserComment,
        loadTwitterUserPosts: loadTwitterUserPosts,
        saveTwitterUserPosts: saveTwitterUserPosts,
        getTwitterUserPostById: getTwitterUserPostById,
        upsertTwitterUserPost: upsertTwitterUserPost,
        appendTwitterUserPostComments: appendTwitterUserPostComments,
        parseTwitterJoinedParts: parseTwitterJoinedParts,
        twitterDeriveHandleFromDisplayName: twitterDeriveHandleFromDisplayName,
        defaultTwitterFriendHandle: defaultTwitterFriendHandle,
        twitterNormalizeKeyLoose: twitterNormalizeKeyLoose,
        twitterAddFriendToTweetHandleMap: twitterAddFriendToTweetHandleMap,
        twitterLookupFriendInHandleMap: twitterLookupFriendInHandleMap,
        twitterExtractCodenameAliasesFromDisplayName: twitterExtractCodenameAliasesFromDisplayName,
        getEffectiveTwitterUserHandle: getEffectiveTwitterUserHandle,
        getTwitterUserAvatarDataUrl: getTwitterUserAvatarDataUrl,
        getTwitterUserHandle: getTwitterUserHandle,
        twitterDetailCacheKey: twitterDetailCacheKey
    };

    global.Twitter = global.Twitter || {};
    global.Twitter.store = api;
    global.Twitter.buildSharePayload = buildTwitterSharePayload;
})(typeof window !== 'undefined' ? window : this);
