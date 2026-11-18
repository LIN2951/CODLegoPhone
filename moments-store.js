/**
 * Lego 小手机 · 微信朋友圈 — 存储与领域（阶段 1）
 *
 * 单入口：`window.Moments.store`（app.js 保留同名全局函数作薄封装，便于无回归迁移）。
 * 数据契约见本文件前半 JSDoc（阶段 0）。
 *
 * 依赖（由 app.js / wechat-store.js 在同页稍后提供，仅在运行时调用）：LZString、readChunkedStringFromLocalStorage、
 * wechatKvSet、wechatKvGet、isQuotaExceededError、loadFriendsFromStorage。
 *
 * 与 app.js 一致的 localStorage 键与前缀（勿擅自改动，否则与压缩/IDB 补丁不一致）：
 */
(function (global) {
    'use strict';

    var MOMENTS_POSTS_LS_KEY = 'momentsPosts';
    var LS_LZ_PREFIX = 'LZUTF16:';
    var LS_CHUNK_PREFIX = 'CHUNKED:';
    var LS_IDB_PREFIX = 'IDB:';
    /** 单设备本地帖子条数上限；仅当超出时从最旧开始删，优先删 API 批次帖，尽量保留「我」与手动内容 */
    var MOMENTS_MAX_STORED = 4000;

    /** IDB 回退时的同步读缓存；与 localStorage 补丁、`parseJsonFromPossiblyEncodedStorage` 共用 `Moments.store` 上此字段。 */
    var api = { __momentsPostsCache: null };

    function escapeHtmlMoments(s) {
        if (s == null) return '';
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** 用于 img src / CSS url，勿用 escapeHtmlMoments（会破坏 data URL 中的 &） */
    function escapeAttrUrl(u) {
        if (u == null) return '';
        return String(u).replace(/"/g, '&quot;').replace(/</g, '').replace(/`/g, '');
    }

    function normalizeFriendAvatarForMoments(f) {
        var avatar = f.avatar || null;
        if (avatar && String(avatar).startsWith('url(') && String(avatar).endsWith(')')) avatar = avatar.slice(4, -1);
        return avatar;
    }

    function normalizeMomentsPost(p) {
        if (!p || typeof p !== 'object') return p;
        var likes = Array.isArray(p.likes) ? p.likes : [];
        var comments = (Array.isArray(p.comments) ? p.comments : []).filter(
            function (c) { return c && String(c.text || c.body || c.content || '').trim(); }
        );
        return Object.assign({}, p, { likes: likes, comments: comments });
    }

    function sanitizeBingPolaroidQuery(q) {
        return String(q || '').replace(/[^a-zA-Z0-9+]/g, '').slice(0, 220);
    }

    /** 按微信聊天规范③生成拍立得 HTML（URL 由系统拼接，防止注入） */
    function buildMomentsPolaroidHtml(searchQuery, caption) {
        var q = sanitizeBingPolaroidQuery(searchQuery);
        if (!q) return '';
        var cap = String(caption || '').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
        var keyword = encodeURIComponent(q.replace(/\+/g, ' '));
        var src = 'https://picsum.photos/seed/' + keyword + '/750/1000';
        return '<div class="wechat-polaroid-wrap moments-polaroid-in-feed">\n  <div class="wechat-polaroid-imgbox">\n    <img class="wechat-polaroid-img" src="' + src + '" alt="" data-seed="' + keyword + '" referrerpolicy="no-referrer" loading="lazy" decoding="async" onerror="var _fb=[\'https://picsum.photos/750/1000\',\'https://api.dujin.org/bing/m.php\'];var _p=0;var _n=function(){if(_p&gt;=_fb.length)return;this.src=_fb[_p++];this.onerror=_n;};this.onerror=_n;_n.call(this);">\n  </div>\n  <div class="wechat-polaroid-text">\n    <div class="wechat-polaroid-line"></div>\n    <div class="wechat-polaroid-caption">' + (cap || ' ') + '</div>\n    <div class="wechat-polaroid-meta">\n      <span>Daily Record</span>\n      <span>Moment</span>\n    </div>\n  </div>\n</div>';
    }

    function loadMomentsPostsRaw() {
        try {
            var raw = localStorage.getItem('momentsPosts');
            if (typeof raw !== 'string' || !raw) return [];

            if (raw.startsWith(LS_LZ_PREFIX)) {
                var dec = typeof LZString !== 'undefined' && LZString.decompressFromUTF16
                    ? LZString.decompressFromUTF16(raw.slice(LS_LZ_PREFIX.length))
                    : '';
                raw = typeof dec === 'string' ? dec : '';
            } else if (raw.startsWith(LS_CHUNK_PREFIX)) {
                var full = typeof readChunkedStringFromLocalStorage === 'function'
                    ? readChunkedStringFromLocalStorage(MOMENTS_POSTS_LS_KEY)
                    : null;
                raw = typeof full === 'string' ? full : '';
            } else if (raw.startsWith(LS_IDB_PREFIX)) {
                try { preloadMomentsPostsFromIdbIfNeeded(); } catch (e) {}
                var c = api.__momentsPostsCache;
                return Array.isArray(c) ? c : [];
            }

            if (!raw) return [];
            var parsed = JSON.parse(raw);
            var list = Array.isArray(parsed) ? parsed : [];
            list.forEach(function (p) {
                if (p && p.polaroidHtml && typeof p.polaroidHtml === 'string') {
                    p.polaroidHtml = p.polaroidHtml.replace(/<img\s[^>]*src="https?:\/\/[^"]*bing\.net[^"]*"[^>]*>/gi, function (imgTag) {
                        var m = imgTag.match(/data-pq="([^"]*)"/i);
                        var kw = m && m[1] ? m[1] : 'moment';
                        var seed = encodeURIComponent(kw.replace(/\+/g, ' '));
                        var newsrc = 'https://picsum.photos/seed/' + seed + '/750/1000';
                        return imgTag.replace(/src="[^"]*"/, 'src="' + newsrc + '"');
                    });
                }
            });
            return list;
        } catch (e) {
            return [];
        }
    }

    /**
     * 主存：优先写入 IndexedDB（wechatKv），localStorage 仅保留 `IDB:` 标记或小体积回退。
     * 同步更新内存缓存，保证同会话内读写一致。
     */
    function saveMomentsPostsRaw(list) {
        var arr = Array.isArray(list) ? list : [];
        api.__momentsPostsCache = arr.slice();
        if (typeof wechatKvSet === 'function') {
            saveMomentsPostsToIdb(arr).catch(function () {
                try {
                    localStorage.setItem(MOMENTS_POSTS_LS_KEY, JSON.stringify(arr));
                } catch (e) {
                    if (typeof isQuotaExceededError === 'function' && isQuotaExceededError(e)) {
                        saveMomentsPostsToIdb(arr).catch(function () {});
                    }
                }
            });
            return;
        }
        try {
            localStorage.setItem(MOMENTS_POSTS_LS_KEY, JSON.stringify(arr));
        } catch (e) {
            if (typeof isQuotaExceededError === 'function' && isQuotaExceededError(e)) {
                saveMomentsPostsToIdb(arr).catch(function () {});
            }
        }
    }

    function getMomentsPosts() {
        var list = loadMomentsPostsRaw();
        if (list.length === 0) {
            var friends = typeof loadFriendsFromStorage === 'function'
                ? loadFriendsFromStorage().filter(function (x) { return x && !x.isGroup; })
                : [];
            if (friends.length > 0) {
                var f = friends[0];
                var avatar = f.avatar || null;
                if (avatar && avatar.startsWith('url(') && avatar.endsWith(')')) avatar = avatar.slice(4, -1);
                list = [{
                    id: 1,
                    friendId: f.id,
                    friendName: f.nickname || f.remark || '好友',
                    friendAvatar: avatar,
                    text: '今天天气真好～',
                    images: [],
                    timestamp: Date.now() - 3600000,
                    likes: [],
                    comments: []
                }];
                saveMomentsPostsRaw(list);
            }
        }
        return list.map(normalizeMomentsPost).sort(function (a, b) { return (b.timestamp || 0) - (a.timestamp || 0); });
    }

    /** 超出条数时裁剪：优先删最旧的 source=moments_api，再删最旧非「我」；尽量不删 friendId=me */
    function trimMomentsPostsIfOverCapacity(list) {
        if (!Array.isArray(list) || list.length <= MOMENTS_MAX_STORED) return list;
        var need = list.length - MOMENTS_MAX_STORED;
        var indexed = list.map(function (p, idx) {
            return {
                idx: idx,
                t: p && (p.timestamp || 0),
                isMe: p && String(p.friendId) === 'me',
                isApi: p && p.source === 'moments_api'
            };
        });
        indexed.sort(function (a, b) { return a.t - b.t; });
        var drop = new Set();
        var i = 0;
        while (need > 0 && i < indexed.length) {
            if (!indexed[i].isMe && indexed[i].isApi) {
                drop.add(indexed[i].idx);
                need--;
            }
            i++;
        }
        i = 0;
        while (need > 0 && i < indexed.length) {
            if (!indexed[i].isMe && !drop.has(indexed[i].idx)) {
                drop.add(indexed[i].idx);
                need--;
            }
            i++;
        }
        return list.filter(function (_, idx) { return !drop.has(idx); });
    }

    /**
     * 将 API 返回的 posts 合并入本地：**追加**新帖，不删除历史（含以往 moments_api）。
     * 每条新帖带 `refreshBatchId`（本次刷新唯一），便于以后按批次做 UI 或清理。
     */
    function applyMomentsApiPostsToStorage(apiPosts, eligibleFriends) {
        var list = loadMomentsPostsRaw();
        var friendById = new Map(eligibleFriends.map(function (f) { return [String(f.id), f]; }));
        var now = Date.now();
        var batchId = now;
        (Array.isArray(apiPosts) ? apiPosts : []).forEach(function (item, idx) {
            if (!item || item.friendId == null) return;
            var f = friendById.get(String(item.friendId));
            if (!f) return;
            var textRaw = String(item.text != null ? item.text : '').slice(0, 800);
            var images = [];
            if (Array.isArray(item.images)) {
                item.images.slice(0, 9).forEach(function (u) {
                    var s = String(u || '').trim();
                    if (/^https?:\/\//i.test(s) || /^data:image\//i.test(s)) images.push(s);
                });
            }
            var polaroidHtml = '';
            if (item.polaroid && item.polaroid.searchQuery && item.polaroid.caption) {
                polaroidHtml = buildMomentsPolaroidHtml(item.polaroid.searchQuery, item.polaroid.caption);
            }
            var has = (textRaw && textRaw.trim()) || images.length > 0 || polaroidHtml;
            if (!has) return;
            var displayName = f.remark || f.nickname || '好友';

            var rawLikes = Array.isArray(item.likes) ? item.likes : [];
            var likes = rawLikes.map(function (l) {
                return {
                    authorName: String(l.authorName || l.name || '好友').slice(0, 50),
                    authorId: String(l.authorId || 'like_' + Math.random().toString(36).slice(2, 7)),
                    isFriendCard: Boolean(l.isFriendCard)
                };
            });

            var rawComments = Array.isArray(item.comments) ? item.comments : [];
            var comments = rawComments.map(function (c) {
                return {
                    authorName: String(c.authorName || c.name || '好友').slice(0, 50),
                    authorId: String(c.authorId || 'comment_' + Math.random().toString(36).slice(2, 7)),
                    text: String(c.text || c.body || c.content || '').slice(0, 200),
                    isFriendCard: Boolean(c.isFriendCard),
                    replyTo: c.replyTo ? String(c.replyTo).slice(0, 50) : ''
                };
            }).filter(function (c) { return c.text && String(c.text).trim(); });

            // 同批次内按 idx 递减时间戳，保证排序稳定且新帖整体排在旧帖之上；与 unshift 顺序一致
            list.unshift({
                id: now + idx,
                friendId: f.id,
                friendName: displayName,
                friendAvatar: normalizeFriendAvatarForMoments(f),
                text: textRaw,
                images: images,
                polaroidHtml: polaroidHtml || undefined,
                timestamp: now - idx,
                likes: likes,
                comments: comments,
                source: 'moments_api',
                refreshBatchId: batchId
            });
        });
        list = trimMomentsPostsIfOverCapacity(list);
        saveMomentsPostsRaw(list);
    }

    async function saveMomentsPostsToIdb(list) {
        var json = JSON.stringify(Array.isArray(list) ? list : []);
        if (typeof wechatKvSet !== 'function') return;
        await wechatKvSet(MOMENTS_POSTS_LS_KEY, json);
        api.__momentsPostsCache = Array.isArray(list) ? list : [];
        try { localStorage.setItem(MOMENTS_POSTS_LS_KEY, LS_IDB_PREFIX + '1'); } catch (e) {}
    }

    async function preloadMomentsPostsFromIdbIfNeeded() {
        try {
            if (api.__momentsPostsCache != null) return;
            var marker = localStorage.getItem(MOMENTS_POSTS_LS_KEY);
            if (typeof marker !== 'string' || !marker.startsWith(LS_IDB_PREFIX)) return;
            if (typeof wechatKvGet !== 'function') return;
            var raw = await wechatKvGet(MOMENTS_POSTS_LS_KEY);
            if (typeof raw === 'string' && raw) {
                var parsed = JSON.parse(raw);
                api.__momentsPostsCache = Array.isArray(parsed) ? parsed : [];
            } else {
                api.__momentsPostsCache = [];
            }
        } catch (e) {
            api.__momentsPostsCache = api.__momentsPostsCache || [];
        }
    }

    Object.assign(api, {
        MOMENTS_POSTS_LS_KEY: MOMENTS_POSTS_LS_KEY,
        escapeHtmlMoments: escapeHtmlMoments,
        escapeAttrUrl: escapeAttrUrl,
        normalizeFriendAvatarForMoments: normalizeFriendAvatarForMoments,
        normalizeMomentsPost: normalizeMomentsPost,
        sanitizeBingPolaroidQuery: sanitizeBingPolaroidQuery,
        buildMomentsPolaroidHtml: buildMomentsPolaroidHtml,
        loadMomentsPostsRaw: loadMomentsPostsRaw,
        saveMomentsPostsRaw: saveMomentsPostsRaw,
        getMomentsPosts: getMomentsPosts,
        applyMomentsApiPostsToStorage: applyMomentsApiPostsToStorage,
        saveMomentsPostsToIdb: saveMomentsPostsToIdb,
        preloadMomentsPostsFromIdbIfNeeded: preloadMomentsPostsFromIdbIfNeeded,
        MOMENTS_MAX_STORED: MOMENTS_MAX_STORED
    });

    var M = global.Moments || {};
    global.Moments = Object.assign(M, {
        __momentsBoundaryInitialized: true,
        boundaryVersion: '1.1.0-phase5-scale',
        store: api,
        ui: M.ui || {},
        prompts: M.prompts || {}
    });
})(typeof window !== 'undefined' ? window : globalThis);

/**
 * ---------------------------------------------------------------------------
 * 以下为阶段 0 数据契约 JSDoc（保留供编辑器与后续维护）
 * ---------------------------------------------------------------------------
 *
 * @typedef {Object} MomentsPost
 * @property {string|number} id
 * @property {string|number} friendId
 * @property {string} [friendName]
 * @property {string|null} [friendAvatar]
 * @property {string} [text]
 * @property {string[]} [images]
 * @property {string} [polaroidHtml]
 * @property {number} [timestamp]
 * @property {MomentsLike[]} [likes]
 * @property {MomentsComment[]} [comments]
 * @property {'moments_api'|string} [source]
 * @property {number} [refreshBatchId] 一次「刷新朋友圈」API 调用对应同一时间戳批次
 * @property {MomentsForwardRef|undefined} [forwardOf]
 *
 * @typedef {Object} MomentsForwardRef
 * @property {string|number} [originalPostId]
 * @property {string|number} [originalFriendId]
 * @property {string} [snapshotText]
 *
 * @typedef {Object} MomentsLike
 * @property {string} authorName
 * @property {string} authorId
 * @property {boolean} [isFriendCard]
 * @property {boolean} [isMe]
 *
 * @typedef {Object} MomentsComment
 * @property {string|number} [id]
 * @property {string} authorName
 * @property {string} authorId
 * @property {string} text
 * @property {string} [replyTo]
 * @property {boolean} [isFriendCard]
 * @property {number} [timestamp]
 *
 * @typedef {Object} MomentsApiPostItem
 * @property {string|number} friendId
 * @property {string} [text]
 * @property {string[]} [images]
 * @property {{ searchQuery: string, caption: string }} [polaroid]
 */
