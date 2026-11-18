/**
 * Lego 小手机 · 微信数据层（好友 / 聊天记录 / IndexedDB KV）
 *
 * 存储键名与 app.js 中既有常量保持一致；依赖 app.js 已提供的全局函数：
 * mergeSystemDefaults、mergeSystemDefaultsSave、saveJsonToStorageWithCompression、
 * parseJsonFromPossiblyEncodedStorage、isQuotaExceededError、LZString、
 * storeChunkedCompressedJsonToLocalStorage、readChunkedStoragePayload、
 * readChunkedStringFromLocalStorage、scheduleLoadChatList
 *
 * 须在 app.js 之后加载。
 * 依赖 wechat-temp-state.js：将 window.tempFriendData / tempGroupData 挂到 Wechat.store（与全局同名变量同一引用）。
 */
(function (global) {
    'use strict';

    var g = global;
    /** 情侣空间状态内存缓存：localStorage 因配额写入失败时仍能在当前会话内读写 pair（背景图、日记封面等） */
    var __coupleSpaceStateMem = null;
    function coupleSpaceInvalidateMemCache() {
        __coupleSpaceStateMem = null;
    }

    // 与 app.js 中 LS_* / 分片前缀一致（勿单方改名）
    var LS_LZ_PREFIX = 'LZUTF16:';
    var LS_CHUNK_PREFIX = 'CHUNKED:';
    var LS_CHUNK_LZ_PREFIX = 'CHUNKEDLZ:';
    var LS_CHUNK_SEP = '__chunk__';
    var LS_IDB_PREFIX = 'IDB:';

    var FRIENDS_LS_KEY = 'friends';
    var FRIENDS_BACKUP_KEY = FRIENDS_LS_KEY + '_backup';

    var WECHAT_DB_NAME = 'LegoWechatDB';
    var WECHAT_DB_VERSION = 1;
    var WECHAT_KV_STORE = 'kv';

    var __wechatKvDbPromise = null;

    function openWechatKvDB() {
        if (__wechatKvDbPromise) return __wechatKvDbPromise;
        __wechatKvDbPromise = new Promise(function (resolve, reject) {
            if (typeof indexedDB === 'undefined') return reject(new Error('indexedDB unavailable'));
            var req = indexedDB.open(WECHAT_DB_NAME, WECHAT_DB_VERSION);
            req.onupgradeneeded = function () {
                var db = req.result;
                if (!db.objectStoreNames.contains(WECHAT_KV_STORE)) {
                    db.createObjectStore(WECHAT_KV_STORE, { keyPath: 'key' });
                }
            };
            req.onsuccess = function () { resolve(req.result); };
            req.onerror = function () { reject(req.error || new Error('open wechat db failed')); };
        });
        return __wechatKvDbPromise;
    }

    async function wechatKvSet(key, value) {
        var db = await openWechatKvDB();
        return await new Promise(function (resolve, reject) {
            var tx = db.transaction(WECHAT_KV_STORE, 'readwrite');
            var store = tx.objectStore(WECHAT_KV_STORE);
            store.put({ key: key, value: value });
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { reject(tx.error || new Error('kv set failed')); };
        });
    }

    async function wechatKvGet(key) {
        var db = await openWechatKvDB();
        return await new Promise(function (resolve, reject) {
            var tx = db.transaction(WECHAT_KV_STORE, 'readonly');
            var store = tx.objectStore(WECHAT_KV_STORE);
            var req = store.get(key);
            req.onsuccess = function () { resolve(req.result ? req.result.value : null); };
            req.onerror = function () { reject(req.error || new Error('kv get failed')); };
        });
    }

    async function wechatKvDelete(key) {
        var db = await openWechatKvDB();
        return await new Promise(function (resolve, reject) {
            var tx = db.transaction(WECHAT_KV_STORE, 'readwrite');
            var store = tx.objectStore(WECHAT_KV_STORE);
            store.delete(key);
            tx.oncomplete = function () { resolve(true); };
            tx.onerror = function () { reject(tx.error || new Error('kv delete failed')); };
        });
    }

    /**
     * 清空 LegoWechatDB 全部 KV（好友副本、表情 IDB、朋友圈 IDB 等）。
     * 「清除所有数据」必须调用此函数，否则仅 delete('friends') 仍可能留下旧好友 JSON（含 lastMessage），列表与聊天会显示残留。
     */
    function clearEntireWechatKvStore() {
        return openWechatKvDB().then(function (db) {
            return new Promise(function (resolve, reject) {
                try {
                    var tx = db.transaction(WECHAT_KV_STORE, 'readwrite');
                    var store = tx.objectStore(WECHAT_KV_STORE);
                    store.clear();
                    tx.oncomplete = function () { resolve(true); };
                    tx.onerror = function () { reject(tx.error || new Error('kv clear failed')); };
                } catch (e) {
                    reject(e);
                }
            });
        }).catch(function (e) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[Wechat KV] clearEntireWechatKvStore:', e && (e.message || e));
            }
            return false;
        });
    }

    var __friendsCache = null;
    /** IndexedDB 模式下：已为当前会话成功解析过「好友 JSON」（含确认为空的 []），避免误用「仅系统预设」覆盖 IDB */
    var __friendsIdbHydratedOk = false;

    function getCachedSystemDefaults() {
        return Array.isArray(g._cachedSystemDefaults) ? g._cachedSystemDefaults : null;
    }

    function getSystemDefaultFriendsFiles() {
        return Array.isArray(g.SYSTEM_DEFAULT_FRIENDS_FILES) ? g.SYSTEM_DEFAULT_FRIENDS_FILES : [];
    }

    function getSystemDefaultFriendIds() {
        return getSystemDefaultFriendsFiles().map(function (f) {
            var m = String(f).match(/system_friend_(.+)\.json$/);
            return m ? ('system_' + String(m[1]).toLowerCase()) : null;
        }).filter(Boolean);
    }

    function isSystemDefaultFriend(friendId) {
        return getSystemDefaultFriendIds().includes(String(friendId).toLowerCase());
    }

    /** 同一 id 多条记录时保留首次出现（导入/历史数据可能重复） */
    function dedupeFriendsByIdPreserveOrder(userFriends) {
        if (!Array.isArray(userFriends) || userFriends.length === 0) {
            return Array.isArray(userFriends) ? userFriends.slice() : [];
        }
        if (userFriends.length < 2) return userFriends.slice();
        var seen = Object.create(null);
        var out = [];
        for (var i = 0; i < userFriends.length; i++) {
            var f = userFriends[i];
            if (!f) continue;
            var idRaw = f.id;
            if (idRaw == null || String(idRaw).trim() === '') {
                out.push(f);
                continue;
            }
            var k = String(idRaw).toLowerCase();
            if (seen[k]) continue;
            seen[k] = true;
            out.push(f);
        }
        return out;
    }

    /** 与 mergeImportedWechatBundleByNickname、stripOrphanSystemFlaggedFriends 共用 */
    function normalizeNicknameMergeKey(nickname) {
        if (nickname == null || String(nickname).trim() === '') return '';
        var s = String(nickname).trim().toLowerCase();
        try {
            if (typeof s.normalize === 'function') s = s.normalize('NFKC');
        } catch (e) {}
        s = s.replace(/\s+/g, ' ');
        return s.trim();
    }

    /**
     * 根因修复：mergeSystemDefaults 会把「id 非 system_* 但 isSystemDefault」的旧数据与真正的 system_* 同时保留，
     * 昵称相同时在列表中出现两个预设。去掉：已有对应 system_*行且规范化昵称相同、且本条 id 不在系统 id 集合内的「冒牌」预设行。
     */
    function stripOrphanSystemFlaggedFriends(merged, sysIds) {
        if (!Array.isArray(merged) || merged.length < 2) return merged;
        var nickFromSystemRow = Object.create(null);
        var i;
        var f;
        var nk;
        for (i = 0; i < merged.length; i++) {
            f = merged[i];
            if (!f || f.isGroup) continue;
            if (!sysIds.has(String(f.id).toLowerCase())) continue;
            nk = normalizeNicknameMergeKey(f.nickname || '');
            if (nk) nickFromSystemRow[nk] = true;
        }
        return merged.filter(function (f) {
            if (!f || f.isGroup) return true;
            var fid = String(f.id).toLowerCase();
            if (sysIds.has(fid)) return true;
            if (!f.isSystemDefault) return true;
            nk = normalizeNicknameMergeKey(f.nickname || '');
            if (!nk) return true;
            return !nickFromSystemRow[nk];
        });
    }

    function mergeSystemDefaults(userFriends) {
        if (!Array.isArray(userFriends)) userFriends = [];
        userFriends = dedupeFriendsByIdPreserveOrder(userFriends);
        var cached = getCachedSystemDefaults();
        if (cached === null) return userFriends.slice();
        var sysIds = new Set(getSystemDefaultFriendIds());
        var userIds = new Set(userFriends.map(function (f) { return String(f.id).toLowerCase(); }));
        var merged = userFriends.filter(function (f) {
            return !sysIds.has(String(f.id).toLowerCase());
        });
        var cachedDeduped = dedupeFriendsByIdPreserveOrder(cached);
        cachedDeduped.forEach(function (sys) {
            var uid = String(sys.id).toLowerCase();
            if (userIds.has(uid)) {
                var existing = userFriends.find(function (f) { return String(f.id).toLowerCase() === uid; });
                if (existing) merged.push(existing);
            } else {
                merged.push(sys);
            }
        });
        return dedupeFriendsByIdPreserveOrder(stripOrphanSystemFlaggedFriends(merged, sysIds));
    }

    function mergeSystemDefaultsSave(userFriends) {
        if (!Array.isArray(userFriends)) userFriends = [];
        var result = dedupeFriendsByIdPreserveOrder(userFriends.slice());
        var cached = getCachedSystemDefaults();
        var sysIds = new Set(getSystemDefaultFriendIds());
        if (cached !== null) {
            dedupeFriendsByIdPreserveOrder(cached).forEach(function (sys) {
                var uid = String(sys.id).toLowerCase();
                if (!result.some(function (f) { return String(f.id).toLowerCase() === uid; })) {
                    result.push(sys);
                }
            });
        }
        return dedupeFriendsByIdPreserveOrder(stripOrphanSystemFlaggedFriends(result, sysIds));
    }

    function getFriendsRawFromStorage() {
        var raw;
        try {
            raw = localStorage.getItem(FRIENDS_LS_KEY);
        } catch (_) {
            return '';
        }
        if (typeof raw !== 'string' || !raw) return '';
        if (raw.startsWith(LS_LZ_PREFIX)) {
            try {
                var dec = g.LZString.decompressFromUTF16(raw.slice(LS_LZ_PREFIX.length));
                return typeof dec === 'string' ? dec : '';
            } catch (_) {
                return '';
            }
        }
        return raw;
    }

    function tryCloneJsonForFriendField(val) {
        if (val == null) return val;
        try {
            return JSON.parse(JSON.stringify(val));
        } catch (e) {
            return null;
        }
    }

    /** 同步解析 friends_backup（与 loadFriendsFromStorage 中逻辑一致），失败返回 null */
    function tryLoadFriendsArrayFromFriendsBackupKeySync() {
        try {
            var backupRaw = localStorage.getItem(FRIENDS_BACKUP_KEY);
            if (typeof backupRaw !== 'string' || !backupRaw) return null;
            var raw = backupRaw;
            if (raw.startsWith(LS_LZ_PREFIX)) {
                raw = g.LZString.decompressFromUTF16(raw.slice(LS_LZ_PREFIX.length)) || '';
            } else if (raw.startsWith(LS_CHUNK_LZ_PREFIX)) {
                raw = g.readChunkedStoragePayload(FRIENDS_BACKUP_KEY) || '';
            } else if (raw.startsWith(LS_CHUNK_PREFIX)) {
                raw =
                    typeof g.readChunkedStringFromLocalStorage === 'function'
                        ? g.readChunkedStringFromLocalStorage(FRIENDS_BACKUP_KEY) || ''
                        : '';
            }
            if (!raw) return null;
            var val = JSON.parse(raw);
            return Array.isArray(val) ? val : null;
        } catch (e) {
            return null;
        }
    }

    /**
     * 逐条克隆为可 JSON 持久化的纯对象；避免某一条含循环引用/异常字段导致整表无法保存。
     */
    function cloneFriendsArrayJsonSafe(arr) {
        if (!Array.isArray(arr)) return [];
        function one(f) {
            if (f == null || typeof f !== 'object') return f;
            try {
                return JSON.parse(JSON.stringify(f));
            } catch (e1) {
                try {
                    var s = Object.assign({}, f);
                    delete s.persona;
                    delete s.groupMyPersona;
                    return JSON.parse(JSON.stringify(s));
                } catch (e2) {
                    try {
                        var slim = {
                            id: f.id,
                            nickname: f.nickname != null ? String(f.nickname) : '',
                            remark: f.remark != null ? String(f.remark) : '',
                            roleSetting:
                                typeof f.roleSetting === 'string'
                                    ? f.roleSetting.slice(0, 200000)
                                    : f.roleSetting != null
                                      ? String(f.roleSetting).slice(0, 200000)
                                      : '',
                            avatar: typeof f.avatar === 'string' ? f.avatar : '',
                            chatAvatar: typeof f.chatAvatar === 'string' ? f.chatAvatar : '',
                            isGroup: !!f.isGroup,
                            memberIds: Array.isArray(f.memberIds) ? f.memberIds.map(String) : [],
                            pinned: !!f.pinned,
                            blacklisted: !!f.blacklisted,
                            isSystemDefault: !!f.isSystemDefault,
                            patPat: f.patPat != null ? String(f.patPat).slice(0, 5000) : '',
                            voiceId: f.voiceId != null ? String(f.voiceId) : '',
                            voiceLanguage: f.voiceLanguage != null ? String(f.voiceLanguage) : 'zh',
                            outputLanguage: f.outputLanguage != null ? String(f.outputLanguage) : 'zh',
                            worldBookIds: Array.isArray(f.worldBookIds) ? f.worldBookIds.map(String) : [],
                            worldBookId: f.worldBookId,
                            groupMemoryRounds: f.groupMemoryRounds,
                            privateSyncRounds: f.privateSyncRounds,
                            privateSyncMemberIds: Array.isArray(f.privateSyncMemberIds)
                                ? f.privateSyncMemberIds.map(String)
                                : [],
                            groupAutoChatEnabled: f.groupAutoChatEnabled,
                            groupAutoChatLastAt: f.groupAutoChatLastAt,
                            groupMyChatAvatar: typeof f.groupMyChatAvatar === 'string' ? f.groupMyChatAvatar : '',
                            groupBubbleCss: typeof f.groupBubbleCss === 'string' ? f.groupBubbleCss : '',
                            persona: tryCloneJsonForFriendField(f.persona),
                            groupMyPersona: tryCloneJsonForFriendField(f.groupMyPersona),
                            lastMessage: f.lastMessage != null ? String(f.lastMessage).slice(0, 2000) : '',
                            lastMessageTime: f.lastMessageTime,
                            lastMessageType: f.lastMessageType,
                            unreadCount: f.unreadCount
                        };
                        return JSON.parse(JSON.stringify(slim));
                    } catch (e3) {
                        if (typeof console !== 'undefined' && console.warn) {
                            console.warn('[好友] 单条无法序列化，已跳过:', f && f.id, e3 && (e3.message || e3));
                        }
                        return null;
                    }
                }
            }
        }
        var out = [];
        var i;
        for (i = 0; i < arr.length; i++) {
            var c = one(arr[i]);
            if (c != null) out.push(c);
        }
        return out;
    }

    async function saveFriendsToIndexedDB(friendsArr, options) {
        var alreadyMerged = options && options.alreadyMerged;
        var arr = alreadyMerged
            ? (Array.isArray(friendsArr) ? friendsArr : [])
            : mergeSystemDefaultsSave(Array.isArray(friendsArr) ? friendsArr : []);
        var payload = createFriendsStoragePayload(arr);
        var previousMarker = null;
        try {
            previousMarker = localStorage.getItem(FRIENDS_LS_KEY);
        } catch (e0) {}
        try {
            await wechatKvSet(FRIENDS_LS_KEY, payload.json);
        } catch (e) {
            try {
                var rebound = await fetchFriendsArrayFromIndexedDB();
                if (rebound != null) {
                    __friendsCache = mergeSystemDefaults(rebound);
                    __friendsIdbHydratedOk = true;
                }
            } catch (e2) {}
            throw e;
        }
        try {
            localStorage.setItem(FRIENDS_LS_KEY, LS_IDB_PREFIX + '1');
        } catch (markerErr) {
            if (g.isQuotaExceededError(markerErr)) {
                tryClearStaleLocalStorageForFriends();
                try {
                    localStorage.setItem(FRIENDS_LS_KEY, LS_IDB_PREFIX + '1');
                } catch (markerErr2) {
                    if (!(typeof previousMarker === 'string' && previousMarker.startsWith(LS_IDB_PREFIX))) {
                        console.warn('IDB标记写入仍失败（配额严重不足）：', markerErr2 && (markerErr2.message || markerErr2));
                        throw markerErr2;
                    }
                }
            } else {
                if (!(typeof previousMarker === 'string' && previousMarker.startsWith(LS_IDB_PREFIX))) {
                    console.error('写入IDB标记时出现非配额错误:', markerErr);
                    throw markerErr;
                }
            }
        }
        __friendsCache = mergeSystemDefaults(Array.isArray(payload.sanitized) ? payload.sanitized : []);
        __friendsIdbHydratedOk = true;
    }

    function createFriendsStoragePayload(merged) {
        var sanitized = cloneFriendsArrayJsonSafe(Array.isArray(merged) ? merged : []);
        var json;
        try {
            json = JSON.stringify(sanitized);
        } catch (e) {
            console.error('好友数据 JSON 序列化失败（体积过大或循环引用）:', e);
            throw e;
        }
        return { sanitized: sanitized, json: json };
    }

    function applyFriendsPayloadCache(payload) {
        __friendsCache = mergeSystemDefaults(Array.isArray(payload && payload.sanitized) ? payload.sanitized : []);
        __friendsIdbHydratedOk = true;
    }

    function tryClearStaleLocalStorageForFriends() {
        try {
            var staleKeys = [
                FRIENDS_BACKUP_KEY,
                FRIENDS_BACKUP_KEY + '_backup',
                FRIENDS_LS_KEY + '_backup',
            ];
            var keys = Object.keys(localStorage);
            keys.forEach(function (k) {
                if (
                    k.startsWith(FRIENDS_LS_KEY + LS_CHUNK_SEP) ||
                    k.startsWith('friendsData_chunks') ||
                    k.startsWith('friendsData' + LS_CHUNK_SEP)
                ) {
                    staleKeys.push(k);
                }
            });
            staleKeys.forEach(function (k) {
                try { localStorage.removeItem(k); } catch (e) {}
            });
        } catch (e) {}
    }

    function writeFriendsPayloadToLocalStorage(payload) {
        if (!payload || typeof payload.json !== 'string') return false;

        try {
            localStorage.setItem(FRIENDS_LS_KEY, payload.json);
            applyFriendsPayloadCache(payload);
            return true;
        } catch (err) {
            if (!g.isQuotaExceededError(err)) {
                console.error('保存好友数据失败（非配额问题）:', err);
                return false;
            }
        }

        try {
            if (!g.LZString || typeof g.LZString.compressToUTF16 !== 'function') {
                throw new Error('LZString.compressToUTF16 unavailable');
            }
            var compressed = LS_LZ_PREFIX + g.LZString.compressToUTF16(payload.json);
            localStorage.setItem(FRIENDS_LS_KEY, compressed);
            applyFriendsPayloadCache(payload);
            return true;
        } catch (err2) {
            if (!g.isQuotaExceededError(err2) && (!err2 || err2.message !== 'LZString.compressToUTF16 unavailable')) {
                console.error('保存好友数据失败（非配额问题）:', err2);
                return false;
            }
        }

        try {
            g.storeChunkedCompressedJsonToLocalStorage(FRIENDS_LS_KEY, payload.json);
            applyFriendsPayloadCache(payload);
            return true;
        } catch (err3) {
            if (!g.isQuotaExceededError(err3)) {
                console.error('保存好友数据失败（非配额问题）:', err3);
            }
        }

        return false;
    }

    /** 仅从 IndexedDB 读取好友数组；无记录/解析失败返回 null；合法空列表返回 [] */
    async function fetchFriendsArrayFromIndexedDB() {
        var raw = await wechatKvGet(FRIENDS_LS_KEY);
        if (typeof raw !== 'string' || !String(raw).trim()) return null;
        try {
            var parsed = JSON.parse(raw);
            if (!Array.isArray(parsed)) return null;
            return parsed;
        } catch (e) {
            return null;
        }
    }

    /** 兼容旧调用名：拉取 IDB 并写入内存缓存（成功时） */
    async function loadFriendsFromIndexedDB() {
        var arr = await fetchFriendsArrayFromIndexedDB();
        if (arr == null) return null;
        __friendsCache = mergeSystemDefaults(arr);
        __friendsIdbHydratedOk = true;
        return __friendsCache;
    }

    function saveFriendsToStorage(friendsArr) {
        var friendsMarker = null;
        try {
            friendsMarker = localStorage.getItem(FRIENDS_LS_KEY);
        } catch (e) {}
        if (typeof friendsMarker === 'string' && friendsMarker.startsWith(LS_IDB_PREFIX) && !__friendsIdbHydratedOk) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn(
                    '[好友] 已跳过同步保存：好友列表尚未从 IndexedDB 完成预热（请使用 saveFriendsToStorageAsync 或稍后重试）'
                );
            }
            return false;
        }

        var merged = mergeSystemDefaultsSave(Array.isArray(friendsArr) ? friendsArr : []);
        __friendsCache = merged;

        if (typeof friendsMarker === 'string' && friendsMarker.startsWith(LS_IDB_PREFIX)) {
            saveFriendsToIndexedDB(merged, { alreadyMerged: true })
                .then(function () { console.log('好友数据已保存到 IndexedDB'); })
                .catch(function (err4) { console.error('好友写入 IndexedDB 失败:', err4); });
            return true;
        }

        try {
            var payload = createFriendsStoragePayload(merged);
            if (writeFriendsPayloadToLocalStorage(payload)) return true;
        } catch (payloadErr) {
            console.error('保存好友数据失败（序列化异常）:', payloadErr);
            return false;
        }

        try {
            saveFriendsToIndexedDB(merged, { alreadyMerged: true })
                .then(function () { console.log('好友数据已保存到 IndexedDB'); })
                .catch(function (err4) { console.error('好友写入 IndexedDB 失败:', err4); });
            return true;
        } catch (err4) {
            console.error('所有存储方法均失败:', err4);
            return false;
        }
    }

    /**
     * 等待好友真正落盘（IndexedDB 模式下须 await，否则调用方会误以为已保存而 UI 与磁盘不一致）。
     * @returns {Promise<boolean>}
     */
    async function saveFriendsToStorageAsync(friendsArr) {
        try {
            await initFriendsFromIndexedDBIfNeeded();
        } catch (e) {}
        var merged = mergeSystemDefaultsSave(Array.isArray(friendsArr) ? friendsArr : []);
        __friendsCache = merged;
        var payload;
        try {
            payload = createFriendsStoragePayload(merged);
        } catch (payloadErr) {
            console.error('好友数据 JSON 序列化失败:', payloadErr);
            return false;
        }
        var friendsMarker = null;
        try {
            friendsMarker = localStorage.getItem(FRIENDS_LS_KEY);
        } catch (e) {}
        if (typeof friendsMarker === 'string' && friendsMarker.startsWith(LS_IDB_PREFIX)) {
            try {
                await saveFriendsToIndexedDB(merged, { alreadyMerged: true });
                return true;
            } catch (err) {
                console.error('好友写入 IndexedDB 失败:', err);
                return writeFriendsPayloadToLocalStorage(payload);
            }
        }
        if (writeFriendsPayloadToLocalStorage(payload)) return true;
        try {
            await saveFriendsToIndexedDB(merged, { alreadyMerged: true });
            return true;
        } catch (err2) {
            console.error('好友数据写入 IndexedDB 失败:', err2);
            return false;
        }
    }

    /**
     * 导入备份：昵称相同（规范化后）的非群好友合并为一条，并重映射 chatHistory / 背景 / 共读。
     * 不使用备注名；无昵称的条目按 id 单独成组不合并。
     */
    function nicknameImportBucketKey(friend) {
        if (!friend) return '__nil__';
        if (friend.isGroup) return '__gid__:' + String(friend.id);
        var nk = normalizeNicknameMergeKey(friend.nickname || '');
        if (!nk) return '__nid__:' + String(friend.id);
        return nk;
    }

    function isUnsetAvatarVal(av) {
        if (av == null) return true;
        var s = String(av).trim();
        return !s || s === '__SYS_UNSET__';
    }

    function pickBetterAvatarField(a, b) {
        if (isUnsetAvatarVal(a)) return isUnsetAvatarVal(b) ? a : b;
        if (isUnsetAvatarVal(b)) return a;
        return String(a).length >= String(b).length ? a : b;
    }

    /** 人设是否包含有效展示信息（空对象 {} 视为无效，避免阻断导入合并） */
    function personaHasMeaningfulData(p) {
        if (p == null || typeof p !== 'object') return false;
        if (!isUnsetAvatarVal(p.avatar)) return true;
        var nick = String(p.nickname != null ? p.nickname : '').trim() || String(p.name != null ? p.name : '').trim();
        if (nick) return true;
        var iden = String(p.identity != null ? p.identity : '').trim();
        if (iden) return true;
        var pp = String(p.patPat != null ? p.patPat : '').trim();
        return !!pp && pp !== '__SYS_UNSET__';
    }

    function mergePersonaObjectsForImport(primary, secondary) {
        var a = primary && typeof primary === 'object' ? primary : {};
        var b = secondary && typeof secondary === 'object' ? secondary : {};
        if (!personaHasMeaningfulData(a)) return deepCloneFriendJson(b);
        if (!personaHasMeaningfulData(b)) return deepCloneFriendJson(a);
        var out = deepCloneFriendJson(a);
        out.avatar = pickBetterAvatarField(out.avatar, b.avatar);
        var an = String(out.nickname || out.name || '').trim();
        var bn = String(b.nickname || b.name || '').trim();
        if (bn.length > an.length) {
            if (b.nickname) out.nickname = b.nickname;
            if (b.name) out.name = b.name;
        } else if (!out.nickname && b.nickname) out.nickname = b.nickname;
        else if (!out.name && b.name) out.name = b.name;
        var ai = String(out.identity || '').trim();
        var bi = String(b.identity || '').trim();
        if (bi.length > ai.length) out.identity = b.identity;
        if (isUnsetAvatarVal(out.patPat) && b.patPat && String(b.patPat).trim() !== '__SYS_UNSET__') out.patPat = b.patPat;
        return out;
    }

    function deepCloneFriendJson(f) {
        try {
            return JSON.parse(JSON.stringify(f));
        } catch (e) {
            return Object.assign({}, f);
        }
    }

    function pickCanonicalFriendForImportMerge(arr) {
        return arr
            .slice()
            .sort(function (a, b) {
                var sys = function (x) {
                    return (x.isSystemDefault ? 4 : 0) + (String(x.id).toLowerCase().indexOf('system_') === 0 ? 2 : 0);
                };
                var ds = sys(b) - sys(a);
                if (ds !== 0) return ds;
                var la = String(a.roleSetting || a.role || '').length;
                var lb = String(b.roleSetting || b.role || '').length;
                if (lb !== la) return lb - la;
                return String(a.id).localeCompare(String(b.id));
            })[0];
    }

    function mergeFriendObjectsForImport(arr, base) {
        var out = deepCloneFriendJson(base);
        var maxLm = Number(out.lastMessageTime) || 0;
        var bestLm = out.lastMessage;
        var bestLt = out.lastMessageType;
        var i;
        var f;
        for (i = 0; i < arr.length; i++) {
            f = arr[i];
            if (!f || String(f.id) === String(out.id)) continue;
            if (!out.remark && f.remark) out.remark = f.remark;
            var oRs = String(out.roleSetting || '');
            var fRs = String(f.roleSetting || '');
            if (fRs.length > oRs.length) out.roleSetting = f.roleSetting;
            var oR = String(out.role || '');
            var fR = String(f.role || '');
            if (fR.length > oR.length) out.role = f.role;
            out.avatar = pickBetterAvatarField(out.avatar, f.avatar);
            out.chatAvatar = pickBetterAvatarField(out.chatAvatar, f.chatAvatar);
            if (personaHasMeaningfulData(f.persona)) {
                if (!personaHasMeaningfulData(out.persona)) {
                    out.persona = deepCloneFriendJson(f.persona);
                } else {
                    out.persona = mergePersonaObjectsForImport(out.persona, f.persona);
                }
            }
            if (!out.voiceId && f.voiceId) out.voiceId = f.voiceId;
            if (!out.voiceLanguage && f.voiceLanguage) out.voiceLanguage = f.voiceLanguage;
            if (!out.outputLanguage && f.outputLanguage) out.outputLanguage = f.outputLanguage;
            if (out.worldBookIds == null || out.worldBookIds === '__SYS_UNSET__') {
                if (f.worldBookIds != null && f.worldBookIds !== '__SYS_UNSET__') out.worldBookIds = f.worldBookIds;
            }
            if (!out.patPat && f.patPat) out.patPat = f.patPat;
            var t = Number(f.lastMessageTime) || 0;
            if (t > maxLm) {
                maxLm = t;
                bestLm = f.lastMessage;
                bestLt = f.lastMessageType;
            }
            out.pinned = !!(out.pinned || f.pinned);
            out.unreadCount = Math.max(Number(out.unreadCount) || 0, Number(f.unreadCount) || 0);
        }
        out.nickname = base.nickname || out.nickname;
        out.lastMessageTime = maxLm;
        out.lastMessage = bestLm;
        out.lastMessageType = bestLt;
        return out;
    }

    function dedupeChatMessagesBySignature(messages) {
        var seen = Object.create(null);
        var out = [];
        var i;
        var m;
        var sig;
        for (i = 0; i < messages.length; i++) {
            m = messages[i];
            if (!m) continue;
            sig =
                String(Number(m.timestamp) || 0) +
                '|' +
                String(m.type || '') +
                '|' +
                String(m.content || '') +
                '|' +
                String(m.subtype || '');
            if (seen[sig]) continue;
            seen[sig] = true;
            out.push(m);
        }
        return out;
    }

    function resolveIdRemapChain(idRemap, oldId) {
        var cur = String(oldId);
        var g0;
        for (g0 = 0; g0 < 48; g0++) {
            var next = idRemap[cur];
            if (!next || next === cur) return cur;
            cur = next;
        }
        return cur;
    }

    function remapChatHistoriesForImportMerge(chatHistories, idRemap) {
        var merged = Object.create(null);
        var keys = Object.keys(chatHistories || {});
        var i;
        var key;
        var oid;
        var nid;
        var nk;
        var arr;
        var j;
        for (i = 0; i < keys.length; i++) {
            key = keys[i];
            if (!key || key.indexOf('chatHistory_') !== 0) continue;
            oid = key.slice('chatHistory_'.length);
            nid = resolveIdRemapChain(idRemap, oid);
            nk = 'chatHistory_' + nid;
            arr = chatHistories[key];
            if (!Array.isArray(arr)) continue;
            if (!merged[nk]) merged[nk] = [];
            for (j = 0; j < arr.length; j++) merged[nk].push(arr[j]);
        }
        for (nk in merged) {
            if (!Object.prototype.hasOwnProperty.call(merged, nk)) continue;
            merged[nk].sort(function (a, b) {
                return (Number(a.timestamp) || 0) - (Number(b.timestamp) || 0);
            });
            merged[nk] = dedupeChatMessagesBySignature(merged[nk]);
        }
        return merged;
    }

    function remapChatBackgroundsForImportMerge(bgObj, idRemap) {
        var out = Object.create(null);
        var keys = Object.keys(bgObj || {});
        var i;
        var key;
        var oid;
        var nid;
        var nk;
        var val;
        for (i = 0; i < keys.length; i++) {
            key = keys[i];
            if (!key || key.indexOf('chatBackground_') !== 0) continue;
            oid = key.slice('chatBackground_'.length);
            nid = resolveIdRemapChain(idRemap, oid);
            nk = 'chatBackground_' + nid;
            val = bgObj[key];
            if (out[nk] == null || out[nk] === '') out[nk] = val;
            else if (val && String(val).length > String(out[nk]).length) out[nk] = val;
        }
        return out;
    }

    function remapReadTogetherForImportMerge(readTogether, idRemap) {
        var merged = Object.create(null);
        var keys = Object.keys(readTogether || {});
        var i;
        var key;
        var oid;
        var nid;
        var nk;
        var val;
        var a;
        var b;
        var books;
        for (i = 0; i < keys.length; i++) {
            key = keys[i];
            if (!key || key.indexOf('readTogether_') !== 0) continue;
            oid = key.slice('readTogether_'.length);
            nid = resolveIdRemapChain(idRemap, oid);
            nk = 'readTogether_' + nid;
            val = readTogether[key];
            if (merged[nk] == null) {
                merged[nk] = val;
                continue;
            }
            try {
                a = typeof val === 'string' ? JSON.parse(val) : val;
                b = typeof merged[nk] === 'string' ? JSON.parse(merged[nk]) : merged[nk];
                books = (a && a.books) || [];
                books = books.concat((b && b.books) || []);
                merged[nk] = JSON.stringify({ books: books, lastUpdated: Date.now() });
            } catch (e) {
                merged[nk] = val;
            }
        }
        return merged;
    }

    function mergeImportedWechatBundleByNickname(friendsArr, chatHistoriesObj, chatBackgroundsObj, readTogetherObj) {
        var chatHistories = chatHistoriesObj && typeof chatHistoriesObj === 'object' ? chatHistoriesObj : {};
        var chatBgs = chatBackgroundsObj && typeof chatBackgroundsObj === 'object' ? chatBackgroundsObj : {};
        var readTogether = readTogetherObj && typeof readTogetherObj === 'object' ? readTogetherObj : {};
        var idRemap = Object.create(null);
        if (!Array.isArray(friendsArr) || friendsArr.length === 0) {
            return {
                friends: [],
                chatHistories: chatHistories,
                chatBackgrounds: chatBgs,
                readTogether: readTogether,
                idRemap: idRemap
            };
        }

        var buckets = new Map();
        var fi;
        var f;
        var bk;
        for (fi = 0; fi < friendsArr.length; fi++) {
            f = friendsArr[fi];
            if (!f) continue;
            bk = nicknameImportBucketKey(f);
            if (!buckets.has(bk)) buckets.set(bk, []);
            buckets.get(bk).push(f);
        }

        var mergedFriendByBucket = new Map();
        buckets.forEach(function (arr, bkey) {
            if (arr.length === 1) {
                var one = deepCloneFriendJson(arr[0]);
                mergedFriendByBucket.set(bkey, one);
                idRemap[String(one.id)] = String(one.id);
            } else {
                var base = pickCanonicalFriendForImportMerge(arr);
                var mf = mergeFriendObjectsForImport(arr, base);
                mergedFriendByBucket.set(bkey, mf);
                for (var j = 0; j < arr.length; j++) {
                    idRemap[String(arr[j].id)] = String(mf.id);
                }
            }
        });

        var seen = new Set();
        var outFriends = [];
        for (fi = 0; fi < friendsArr.length; fi++) {
            f = friendsArr[fi];
            if (!f) continue;
            bk = nicknameImportBucketKey(f);
            var mf2 = mergedFriendByBucket.get(bk);
            if (!mf2) continue;
            var cid = String(mf2.id);
            if (seen.has(cid)) continue;
            seen.add(cid);
            outFriends.push(mf2);
        }

        var mergedChat = remapChatHistoriesForImportMerge(chatHistories, idRemap);
        var mergedBg = remapChatBackgroundsForImportMerge(chatBgs, idRemap);
        var mergedRt = remapReadTogetherForImportMerge(readTogether, idRemap);

        var gi;
        var gf;
        var mi;
        var rid;
        var newIds;
        var seenM;
        for (gi = 0; gi < outFriends.length; gi++) {
            gf = outFriends[gi];
            if (!gf || !gf.isGroup || !Array.isArray(gf.memberIds)) continue;
            newIds = [];
            seenM = Object.create(null);
            for (mi = 0; mi < gf.memberIds.length; mi++) {
                rid = resolveIdRemapChain(idRemap, gf.memberIds[mi]);
                if (seenM[rid]) continue;
                seenM[rid] = true;
                newIds.push(rid);
            }
            gf.memberIds = newIds;
        }

        return {
            friends: outFriends,
            chatHistories: mergedChat,
            chatBackgrounds: mergedBg,
            readTogether: mergedRt,
            idRemap: idRemap
        };
    }

    /**
     * 导入完成后：单聊的 per-chat persona 为空但全局 myProfile 有效时，用全局人设回补。
     * 与「我的人设」弹窗数据源对齐，修复历史备份/合并后 persona 被空对象占位导致的设置与气泡无头像。
     */
    function hydrateImportedFriendsPersonaGaps(friendsArr) {
        if (!Array.isArray(friendsArr) || friendsArr.length === 0) return friendsArr;
        var mp = null;
        try {
            mp = g.parseJsonFromPossiblyEncodedStorage('myProfile', null);
        } catch (e) {
            mp = null;
        }
        if (!mp || typeof mp !== 'object' || !personaHasMeaningfulData(mp)) return friendsArr;
        var pp = String(mp.patPat != null ? mp.patPat : '').trim();
        var template = {
            nickname: String(mp.nickname != null ? mp.nickname : '').trim() || String(mp.name != null ? mp.name : '').trim(),
            name: String(mp.name != null ? mp.name : '').trim() || String(mp.nickname != null ? mp.nickname : '').trim(),
            avatar: mp.avatar,
            identity: mp.identity || '',
            patPat: pp && pp !== '__SYS_UNSET__' ? pp : ''
        };
        if (!personaHasMeaningfulData(template)) return friendsArr;
        var changed = false;
        var out = [];
        var i;
        var f;
        for (i = 0; i < friendsArr.length; i++) {
            f = friendsArr[i];
            if (!f) {
                out.push(f);
                continue;
            }
            if (f.isGroup || personaHasMeaningfulData(f.persona)) {
                out.push(f);
                continue;
            }
            changed = true;
            out.push(Object.assign({}, f, { persona: Object.assign({}, template) }));
        }
        return changed ? out : friendsArr;
    }

    /**
     * 导入「全部数据」微信好友：以备份数组覆盖本地持久化（仅按 id 去重，不调用 mergeSystemDefaultsSave）。
     * 读取时仍会经 mergeSystemDefaults 补全备份中缺失的系统预设，避免列表缺人。
     */
    function saveImportedFriendsOverwrite(friendsArr) {
        var arr = dedupeFriendsByIdPreserveOrder(Array.isArray(friendsArr) ? friendsArr : []);
        __friendsCache = arr;
        __friendsIdbHydratedOk = true;

        var friendsMarker = null;
        try {
            friendsMarker = localStorage.getItem(FRIENDS_LS_KEY);
        } catch (e) {}
        if (typeof friendsMarker === 'string' && friendsMarker.startsWith(LS_IDB_PREFIX)) {
            saveFriendsToIndexedDB(arr, { alreadyMerged: true })
                .then(function () { console.log('好友数据已保存到 IndexedDB（导入覆盖）'); })
                .catch(function (err4) { console.error('好友写入 IndexedDB 失败:', err4); });
            return true;
        }

        var arrSan = cloneFriendsArrayJsonSafe(arr);
        var json = JSON.stringify(arrSan);

        try {
            localStorage.setItem(FRIENDS_LS_KEY, json);
            __friendsCache = mergeSystemDefaults(arrSan);
            __friendsIdbHydratedOk = true;
            return true;
        } catch (err) {
            if (!g.isQuotaExceededError(err)) {
                console.error('导入覆盖好友失败（非配额问题）:', err);
                return false;
            }
        }

        try {
            if (!g.LZString || typeof g.LZString.compressToUTF16 !== 'function') {
                throw new Error('LZString.compressToUTF16 unavailable');
            }
            var compressed = LS_LZ_PREFIX + g.LZString.compressToUTF16(json);
            localStorage.setItem(FRIENDS_LS_KEY, compressed);
            __friendsCache = mergeSystemDefaults(arrSan);
            __friendsIdbHydratedOk = true;
            return true;
        } catch (err2) {
            if (!g.isQuotaExceededError(err2) && (!err2 || err2.message !== 'LZString.compressToUTF16 unavailable')) {
                console.error('导入覆盖好友失败（非配额问题）:', err2);
                return false;
            }
        }

        try {
            g.storeChunkedCompressedJsonToLocalStorage(FRIENDS_LS_KEY, json);
            __friendsCache = mergeSystemDefaults(arrSan);
            __friendsIdbHydratedOk = true;
            return true;
        } catch (err3) {
            if (!g.isQuotaExceededError(err3)) {
                console.error('导入覆盖好友失败（非配额问题）:', err3);
            }
        }

        try {
            saveFriendsToIndexedDB(arr, { alreadyMerged: true })
                .then(function () { console.log('好友数据已保存到 IndexedDB（导入覆盖）'); })
                .catch(function (err4) { console.error('好友写入 IndexedDB 失败:', err4); });
            __friendsIdbHydratedOk = true;
            return true;
        } catch (err4) {
            console.error('导入覆盖好友失败:', err4);
            return false;
        }
    }

    function loadFriendsFromStorage() {
        try {
            var marker = localStorage.getItem(FRIENDS_LS_KEY);
            if (typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX)) {
                if (__friendsIdbHydratedOk && __friendsCache != null) {
                    var idbCached = mergeSystemDefaults(Array.isArray(__friendsCache) ? __friendsCache : []);
                    __friendsCache = idbCached;
                    return idbCached;
                }
                // 未预热：不写入 __friendsCache / 不标记 hydrated，由 initFriendsFromIndexedDBIfNeeded 从 IDB（及 friends_backup）拉全量
                return mergeSystemDefaults([]);
            }

            var raw2 = getFriendsRawFromStorage();
            if (!raw2) {
                var noRaw = g.mergeSystemDefaults([]);
                __friendsCache = noRaw;
                __friendsIdbHydratedOk = true;
                return noRaw;
            }
            var val = JSON.parse(raw2);
            var result = Array.isArray(val) ? val : [];
            var mergedLocal = mergeSystemDefaults(result);
            __friendsCache = mergedLocal;
            __friendsIdbHydratedOk = true;
            return mergedLocal;
        } catch (e) {
            return g.mergeSystemDefaults([]);
        }
    }

    async function initFriendsFromIndexedDBIfNeeded() {
        try {
            var marker = localStorage.getItem(FRIENDS_LS_KEY);
            if (typeof marker !== 'string' || !marker.startsWith(LS_IDB_PREFIX)) return;
            if (__friendsIdbHydratedOk) return;

            var friendsRaw = await fetchFriendsArrayFromIndexedDB();
            var merged;
            if (friendsRaw !== null) {
                merged = mergeSystemDefaults(friendsRaw);
            } else if (Array.isArray(__friendsCache) && __friendsCache.length > 0) {
                merged = mergeSystemDefaults(__friendsCache);
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[好友] IndexedDB 中暂无好友 JSON，已沿用当前会话内存缓存');
                }
            } else {
                var backupArr = tryLoadFriendsArrayFromFriendsBackupKeySync();
                if (backupArr != null) {
                    merged = mergeSystemDefaults(backupArr);
                    if (typeof console !== 'undefined' && console.warn) {
                        console.warn('[好友] IndexedDB 中暂无好友 JSON，已使用 friends_backup 回退');
                    }
                } else {
                    merged = mergeSystemDefaults([]);
                    if (typeof console !== 'undefined' && console.warn) {
                        console.warn('[好友] IndexedDB 与 friends_backup 均无数据，列表暂为系统预设');
                    }
                }
            }
            __friendsCache = merged;
            __friendsIdbHydratedOk = true;
            if (typeof g.scheduleLoadChatList === 'function') g.scheduleLoadChatList();
        } catch (e) {
            console.error('从IndexedDB加载好友数据失败:', e);
        }
    }

    /** 在任意 load→修改→save 路径前调用：避免 IDB 模式下 __friendsCache 未就绪时读到「仅系统预设」并覆盖持久化 */
    function ensureFriendsCacheHydrated() {
        return initFriendsFromIndexedDBIfNeeded();
    }

    /**
     * IndexedDB 模式下：已从 IDB（或 backup）完成好友列表预热前，禁止用 loadFriendsFromStorage 的旧快照整表写回，
     * 否则会误把其它角色已保存的自定义头像覆盖成系统预设 JSON 里的图。
     */
    function areWechatFriendsReadyForMutation() {
        try {
            var marker = localStorage.getItem(FRIENDS_LS_KEY);
            if (typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX)) {
                return !!__friendsIdbHydratedOk;
            }
        } catch (e) {}
        return true;
    }

    async function exportFriendsToIndexedDB() {
        await saveFriendsToIndexedDB(__friendsCache || []);
    }

    function refreshFriendsCache(friendsArr) {
        __friendsCache = Array.isArray(friendsArr) ? dedupeFriendsByIdPreserveOrder(friendsArr) : friendsArr;
    }

    var __chatHistoryMem = new Map();
    var __chatHistoryPersistTimers = Object.create(null);
    /** chatHistory_* 仅落在 IndexedDB 时，同步读路径使用的缓存（与 parseJsonFromPossiblyEncodedStorage 配合） */
    var __chatHistoryIdbCache = new Map();
    var __chatHistoryIdbLoading = Object.create(null);
    /**
     * 每 invalidate / replace 时递增。IndexedDB 的 wechatKvGet 为异步，晚到的旧读若写回 mem，会冲掉已回溯/已截断的聊天（如拍一拍等仍居中显示）。
     */
    var __chatHistoryIdbApplyEpoch = Object.create(null);
    var __chatHistoryGlobalEpoch = 0;

    g.__chatHistoryMem = __chatHistoryMem;
    g.__chatHistoryPersistTimers = __chatHistoryPersistTimers;
    g.__chatHistoryIdbCache = __chatHistoryIdbCache;

    function chatHistoryStorageKey(friendId) {
        return 'chatHistory_' + friendId;
    }

    /**
     * 启动时把「localStorage 仅保留 IDB: 标记」的聊天记录从 IndexedDB 拉进内存，避免首屏/导出读到空数组。
     */
    async function initChatHistoriesFromIndexedDBIfNeeded() {
        try {
            if (typeof indexedDB === 'undefined' || typeof wechatKvGet !== 'function') return;
            var keys = Object.keys(localStorage);
            var jobs = [];
            var i;
            var k;
            var marker;
            var fid;
            for (i = 0; i < keys.length; i++) {
                k = keys[i];
                if (k.indexOf('chatHistory_') !== 0) continue;
                if (k.indexOf(LS_CHUNK_SEP) !== -1) continue;
                try {
                    marker = localStorage.getItem(k);
                } catch (e) {
                    marker = '';
                }
                if (typeof marker !== 'string' || !marker.startsWith(LS_IDB_PREFIX)) continue;
                fid = k.slice('chatHistory_'.length);
                (function (storageKey, friendId) {
                    var epoch0 = __chatHistoryIdbApplyEpoch[String(friendId)] | 0;
                    var globalEpoch0 = __chatHistoryGlobalEpoch;
                    jobs.push(
                        wechatKvGet(storageKey).then(function (raw) {
                            if (globalEpoch0 !== __chatHistoryGlobalEpoch || epoch0 !== (__chatHistoryIdbApplyEpoch[String(friendId)] | 0)) {
                                return;
                            }
                            if (typeof raw !== 'string' || !raw) throw new Error('聊天记录缺失');
                            var arr = JSON.parse(raw);
                            if (!Array.isArray(arr)) throw new Error('聊天记录格式错误');
                            // 同时有惰性预热或新消息时，不能以启动时的旧快照覆盖当前内存。
                            if (__chatHistoryMem.has(String(friendId)) && __chatHistoryMem.get(String(friendId)).length) return;
                            __chatHistoryIdbCache.set(String(friendId), arr);
                            __chatHistoryMem.set(String(friendId), arr);
                        }).catch(function (e) {
                            if (typeof console !== 'undefined' && console.warn) {
                                console.warn('[chatHistory IDB] 预加载失败', storageKey, e && (e.message || e));
                            }
                        })
                    );
                })(k, fid);
            }
            if (jobs.length) await Promise.all(jobs);
            try {
                var chatPage = typeof document !== 'undefined' ? document.getElementById('chat-page') : null;
                var cur = chatPage ? chatPage.dataset.friendId : null;
                if (cur != null && typeof g.loadChatHistory === 'function') {
                    g.loadChatHistory(cur, { scrollToBottom: true });
                }
            } catch (e2) {}
        } catch (e) {
            if (typeof console !== 'undefined' && console.warn) {
                console.warn('[chatHistory IDB] 批量预加载失败:', e && (e.message || e));
            }
        }
    }

    /**
     * 懒加载单聊 IDB 记录（parseJson 遇到 IDB 标记且缓存未命中时触发）
     */
    function preloadChatHistoryFromIdbIfNeeded(friendId) {
        var fid = String(friendId);
        if (__chatHistoryIdbLoading[fid]) return __chatHistoryIdbLoading[fid];
        if (__chatHistoryIdbCache.has(fid)) return Promise.resolve();
        var storageKey = chatHistoryStorageKey(fid);
        var epoch0 = __chatHistoryIdbApplyEpoch[fid] | 0;
        var globalEpoch0 = __chatHistoryGlobalEpoch;
        var pending = wechatKvGet(storageKey)
            .then(function (raw) {
                if (globalEpoch0 !== __chatHistoryGlobalEpoch || epoch0 !== (__chatHistoryIdbApplyEpoch[fid] | 0)) {
                    return;
                }
                if (typeof raw !== 'string' || !raw) throw new Error('聊天记录缺失');
                var arr = JSON.parse(raw);
                if (!Array.isArray(arr)) throw new Error('聊天记录格式错误');
                var live = __chatHistoryMem.get(fid);
                if (Array.isArray(live)) {
                    live.length = 0;
                    var j;
                    for (j = 0; j < arr.length; j++) live.push(arr[j]);
                    __chatHistoryIdbCache.set(fid, live);
                } else {
                    __chatHistoryMem.set(fid, arr);
                    __chatHistoryIdbCache.set(fid, arr);
                }
                try {
                    if (typeof g.scheduleLoadChatList === 'function') g.scheduleLoadChatList();
                } catch (e) {}
                try {
                    var chatPage = typeof document !== 'undefined' ? document.getElementById('chat-page') : null;
                    var cur = chatPage ? chatPage.dataset.friendId : null;
                    if (cur != null && String(cur) === String(fid) && typeof g.loadChatHistory === 'function') {
                        g.loadChatHistory(fid, { scrollToBottom: true });
                    }
                } catch (e2) {}
            })
            .catch(function (e) {
                if (typeof console !== 'undefined' && console.warn) {
                    console.warn('[chatHistory IDB] 单聊加载失败', fid, e && (e.message || e));
                }
            })
            .then(function () {
                if (__chatHistoryIdbLoading[fid] === pending) delete __chatHistoryIdbLoading[fid];
            });
        __chatHistoryIdbLoading[fid] = pending;
        return pending;
    }

    async function ensureChatHistoryReady(friendId) {
        getChatHistoryArray(friendId);
        var marker = localStorage.getItem(chatHistoryStorageKey(friendId));
        if (typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX)) {
            await preloadChatHistoryFromIdbIfNeeded(friendId);
            if (!__chatHistoryIdbCache.has(String(friendId))) throw new Error('聊天记录尚未载入');
        }
        return getChatHistoryArray(friendId);
    }

    /** 主动消息整批持久化成功才发布到内存；不会走配额不足时截断旧聊天的兜底。 */
    async function commitProactiveChatBatch(friendId, items, validate, signal) {
        var fid = String(friendId), key = chatHistoryStorageKey(fid);
        var live = getChatHistoryArray(fid), epoch = __chatHistoryIdbApplyEpoch[fid] | 0;
        var globalEpoch = __chatHistoryGlobalEpoch;
        var before = JSON.stringify(live), json = JSON.stringify(live.concat(items));
        var valid = function () {
            return !(signal && signal.aborted) && globalEpoch === __chatHistoryGlobalEpoch && epoch === (__chatHistoryIdbApplyEpoch[fid] | 0) &&
                __chatHistoryMem.get(fid) === live && JSON.stringify(live) === before && validate();
        };
        if (!valid()) return false;
        var marker = localStorage.getItem(key), stored = false;
        if (!(typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX))) {
            try { localStorage.setItem(key, json); stored = true; }
            catch (plainError) {
                if (!g.isQuotaExceededError(plainError)) throw plainError;
                var compressor = typeof LZString !== 'undefined' ? LZString : g.LZString;
                try { if (compressor) { localStorage.setItem(key, LS_LZ_PREFIX + compressor.compressToUTF16(json)); stored = true; } }
                catch (compressedError) { if (!g.isQuotaExceededError(compressedError)) throw compressedError; }
            }
        }
        if (!stored) {
            var db = await openWechatKvDB();
            if (!valid()) return false;
            stored = await new Promise(function (resolve, reject) {
                var tx = db.transaction(WECHAT_KV_STORE, 'readwrite');
                var cancelled = false;
                var abort = function () { cancelled = true; try { tx.abort(); } catch (_) {} };
                if (signal) signal.addEventListener('abort', abort, { once: true });
                var cleanup = function () { if (signal) signal.removeEventListener('abort', abort); };
                var req = tx.objectStore(WECHAT_KV_STORE).put({ key: key, value: json });
                req.onsuccess = function () { if (!valid()) abort(); };
                tx.onabort = function () { cleanup(); if (cancelled) resolve(false); else reject(tx.error || new Error('聊天保存失败')); };
                tx.onerror = function () { /* onabort 统一报告，避免提前发布 */ };
                tx.oncomplete = function () {
                    cleanup();
                    try { if (valid()) localStorage.setItem(key, LS_IDB_PREFIX + '1'); resolve(true); }
                    catch (e) { reject(e); }
                };
            });
            if (!stored) return false;
            // 若关闭/清空/新消息恰好发生在事务提交与完成回调之间，撤回未发布的批次。
            if (!valid()) {
                var latest = __chatHistoryMem.get(fid);
                if (latest) await wechatKvSet(key, JSON.stringify(latest));
                else await wechatKvDelete(key);
                return false;
            }
        }
        items.forEach(function (item) { live.push(item); });
        __chatHistoryIdbCache.set(fid, live);
        return true;
    }

    function invalidateChatHistoryMem(friendId) {
        if (g.Wechat && g.Wechat.proactive) g.Wechat.proactive.invalidate(friendId);
        var fid = String(friendId);
        var h = __chatHistoryPersistTimers[fid];
        if (h != null) {
            if (typeof cancelIdleCallback === 'function') {
                try {
                    cancelIdleCallback(h);
                } catch (e) {
                    try { clearTimeout(h); } catch (e2) {}
                }
            } else {
                try { clearTimeout(h); } catch (e) {}
            }
            delete __chatHistoryPersistTimers[fid];
        }
        __chatHistoryMem.delete(fid);
        __chatHistoryIdbCache.delete(fid);
        __chatHistoryIdbApplyEpoch[fid] = (__chatHistoryIdbApplyEpoch[fid] | 0) + 1;
    }

    function clearChatHistoryMemCache() {
        if (g.Wechat && g.Wechat.proactive) g.Wechat.proactive.invalidate();
        __chatHistoryGlobalEpoch++;
        Object.keys(__chatHistoryPersistTimers).forEach(function (fid) {
            var h = __chatHistoryPersistTimers[fid];
            if (h != null) {
                if (typeof cancelIdleCallback === 'function') {
                    try {
                        cancelIdleCallback(h);
                    } catch (e) {
                        try { clearTimeout(h); } catch (e2) {}
                    }
                } else {
                    try { clearTimeout(h); } catch (e) {}
                }
                delete __chatHistoryPersistTimers[fid];
            }
        });
        __chatHistoryMem.clear();
        __chatHistoryIdbCache.clear();
        __chatHistoryIdbLoading = Object.create(null);
    }

    /**
     * 清空所有微信内存态待落盘任务，避免「清除数据」后 beforeunload / 延迟写盘把旧聊天、旧好友列表写回存储。
     */
    function discardWechatPendingPersistence() {
        clearChatHistoryMemCache();
        if (_persistFriendsDiskTimer) {
            try { clearTimeout(_persistFriendsDiskTimer); } catch (e) {}
            _persistFriendsDiskTimer = null;
        }
        if (_persistFriendsIdleHandle != null) {
            if (typeof cancelIdleCallback === 'function') {
                try { cancelIdleCallback(_persistFriendsIdleHandle); } catch (e) {}
            }
            _persistFriendsIdleHandle = null;
        }
        __friendsCache = null;
        __friendsIdbHydratedOk = false;
        try {
            coupleSpaceInvalidateMemCache();
        } catch (eInv) {}
    }

    function getChatHistoryArray(friendId) {
        var fid = String(friendId);
        if (__chatHistoryMem.has(fid)) {
            return __chatHistoryMem.get(fid);
        }
        var key = chatHistoryStorageKey(friendId);
        var marker = null;
        try {
            marker = localStorage.getItem(key);
        } catch (e) {
            marker = null;
        }
        if (typeof marker === 'string' && marker.startsWith(LS_IDB_PREFIX)) {
            if (__chatHistoryIdbCache.has(fid)) {
                var hit = __chatHistoryIdbCache.get(fid);
                var arrHit = Array.isArray(hit) ? hit : [];
                __chatHistoryMem.set(fid, arrHit);
                return arrHit;
            }
            var shell = [];
            __chatHistoryMem.set(fid, shell);
            preloadChatHistoryFromIdbIfNeeded(fid);
            return shell;
        }
        var raw = g.parseJsonFromPossiblyEncodedStorage(key, []);
        var arr = Array.isArray(raw) ? raw : [];
        __chatHistoryMem.set(fid, arr);
        return arr;
    }

    function schedulePersistChatHistory(friendId) {
        var fid = String(friendId);
        if (__chatHistoryPersistTimers[fid] != null) return;
        var run = function () {
            __chatHistoryPersistTimers[fid] = null;
            var arr = __chatHistoryMem.get(fid);
            if (!arr) return;
            try {
                g.saveJsonToStorageWithCompression(chatHistoryStorageKey(friendId), arr);
            } catch (e) {}
        };
        if (typeof requestIdleCallback === 'function') {
            __chatHistoryPersistTimers[fid] = requestIdleCallback(run, { timeout: 1200 });
        } else {
            __chatHistoryPersistTimers[fid] = setTimeout(run, 100);
        }
    }

    function flushChatHistoryPendingSync(friendId) {
        var fid = String(friendId);
        var h = __chatHistoryPersistTimers[fid];
        if (h != null) {
            if (typeof cancelIdleCallback === 'function') {
                try {
                    cancelIdleCallback(h);
                } catch (e) {
                    try { clearTimeout(h); } catch (e2) {}
                }
            } else {
                try { clearTimeout(h); } catch (e) {}
            }
            __chatHistoryPersistTimers[fid] = null;
        }
        var arr = __chatHistoryMem.get(fid);
        if (arr) {
            try {
                g.saveJsonToStorageWithCompression(chatHistoryStorageKey(friendId), arr);
            } catch (e) {}
        }
    }

    function replaceChatHistoryAndPersist(friendId, newArray) {
        var fid = String(friendId);
        var arr = Array.isArray(newArray) ? newArray : [];
        invalidateChatHistoryMem(friendId);
        __chatHistoryMem.set(fid, arr);
        try {
            g.saveJsonToStorageWithCompression(chatHistoryStorageKey(friendId), arr);
        } catch (e) {}
        if (g.Wechat && g.Wechat.proactive) g.Wechat.proactive.historyReplaced(friendId);
    }

    function flushAllChatHistoryPendingSync() {
        var fids = new Set(__chatHistoryMem.keys());
        Object.keys(__chatHistoryPersistTimers).forEach(function (k) { fids.add(k); });
        fids.forEach(function (fid) { flushChatHistoryPendingSync(fid); });
    }

    var _persistFriendsDiskTimer = null;
    var _persistFriendsIdleHandle = null;

    /**
     * 延迟落盘常用于仅更新会话列表预览字段；若直接用旧快照整体替换 __friendsCache，会在 await 空档后覆盖其它路径刚保存的群设置等字段。
     * 以当前 loadFriendsFromStorage 为底，只覆盖 lastMessage / unread 等列表相关键。
     */
    function mergeFriendsForPreviewPersist(baseArr, overlayArr) {
        var base = Array.isArray(baseArr) ? baseArr : [];
        var ov = Array.isArray(overlayArr) ? overlayArr : [];
        var byId = Object.create(null);
        var i;
        for (i = 0; i < ov.length; i++) {
            var f = ov[i];
            if (!f || f.id == null) continue;
            byId[String(f.id)] = f;
        }
        return base.map(function (f) {
            if (!f || f.id == null) return f;
            var o = byId[String(f.id)];
            if (!o) return f;
            var out = Object.assign({}, f);
            if (o.lastMessage !== undefined) out.lastMessage = o.lastMessage;
            if (o.lastMessageTime !== undefined) out.lastMessageTime = o.lastMessageTime;
            if (o.lastMessageType !== undefined) out.lastMessageType = o.lastMessageType;
            if (o.unreadCount !== undefined) out.unreadCount = o.unreadCount;
            return out;
        });
    }

    function saveFriendsToStorageDebounced(friendsArr) {
        var overlay = mergeSystemDefaultsSave(Array.isArray(friendsArr) ? friendsArr : []);
        var base = mergeSystemDefaultsSave(loadFriendsFromStorage());
        var merged = mergeFriendsForPreviewPersist(base, overlay);
        __friendsCache = merged;
        if (_persistFriendsDiskTimer) clearTimeout(_persistFriendsDiskTimer);
        if (_persistFriendsIdleHandle != null) {
            if (typeof cancelIdleCallback === 'function') {
                try {
                    cancelIdleCallback(_persistFriendsIdleHandle);
                } catch (e) {
                    _persistFriendsIdleHandle = null;
                }
            }
            _persistFriendsIdleHandle = null;
        }
        _persistFriendsDiskTimer = setTimeout(function () {
            _persistFriendsDiskTimer = null;
            var run = function () {
                _persistFriendsIdleHandle = null;
                Promise.resolve()
                    .then(function () {
                        if (__friendsCache == null) return true;
                        return saveFriendsToStorageAsync(__friendsCache);
                    })
                    .then(function (ok) {
                        if (ok === false && typeof console !== 'undefined' && console.warn) {
                            console.warn('[好友] 延迟落盘失败，请检查存储配额或缩小头像/角色卡');
                        }
                    })
                    .catch(function (e) {
                        if (typeof console !== 'undefined' && console.warn) {
                            console.warn('[好友] 延迟落盘异常:', e && (e.message || e));
                        }
                    });
            };
            if (typeof requestIdleCallback === 'function') {
                _persistFriendsIdleHandle = requestIdleCallback(run, { timeout: 2000 });
            } else {
                run();
            }
        }, 450);
    }

    try {
        window.addEventListener('beforeunload', function () {
            try {
                flushAllChatHistoryPendingSync();
                var needFriendsFlush = false;
                if (_persistFriendsDiskTimer) {
                    clearTimeout(_persistFriendsDiskTimer);
                    _persistFriendsDiskTimer = null;
                    needFriendsFlush = true;
                }
                if (_persistFriendsIdleHandle != null) {
                    if (typeof cancelIdleCallback === 'function') {
                        try {
                            cancelIdleCallback(_persistFriendsIdleHandle);
                        } catch (e) {}
                    }
                    _persistFriendsIdleHandle = null;
                    needFriendsFlush = true;
                }
                if (needFriendsFlush && __friendsCache != null) saveFriendsToStorage(__friendsCache);
            } catch (e) {}
        });
    } catch (e) {}

    // 全局（与历史 app.js 行为一致，供 HTML onclick / 其它脚本调用）
    g.openWechatKvDB = openWechatKvDB;
    g.wechatKvSet = wechatKvSet;
    g.wechatKvGet = wechatKvGet;
    g.wechatKvDelete = wechatKvDelete;
    g.clearEntireWechatKvStore = clearEntireWechatKvStore;
    g.getSystemDefaultFriendIds = getSystemDefaultFriendIds;
    g.isSystemDefaultFriend = isSystemDefaultFriend;
    g.dedupeFriendsByIdPreserveOrder = dedupeFriendsByIdPreserveOrder;
    g.mergeSystemDefaults = mergeSystemDefaults;
    g.mergeSystemDefaultsSave = mergeSystemDefaultsSave;
    g.getFriendsRawFromStorage = getFriendsRawFromStorage;
    g.saveFriendsToIndexedDB = saveFriendsToIndexedDB;
    g.tryClearStaleLocalStorageForFriends = tryClearStaleLocalStorageForFriends;
    g.loadFriendsFromIndexedDB = loadFriendsFromIndexedDB;
    g.saveFriendsToStorage = saveFriendsToStorage;
    g.saveFriendsToStorageAsync = saveFriendsToStorageAsync;
    g.saveImportedFriendsOverwrite = saveImportedFriendsOverwrite;
    g.mergeImportedWechatBundleByNickname = mergeImportedWechatBundleByNickname;
    g.hydrateImportedFriendsPersonaGaps = hydrateImportedFriendsPersonaGaps;
    g.loadFriendsFromStorage = loadFriendsFromStorage;
    g.initFriendsFromIndexedDBIfNeeded = initFriendsFromIndexedDBIfNeeded;
    g.ensureFriendsCacheHydrated = ensureFriendsCacheHydrated;
    g.areWechatFriendsReadyForMutation = areWechatFriendsReadyForMutation;
    g.initChatHistoriesFromIndexedDBIfNeeded = initChatHistoriesFromIndexedDBIfNeeded;
    g.preloadChatHistoryFromIdbIfNeeded = preloadChatHistoryFromIdbIfNeeded;
    g.ensureChatHistoryReady = ensureChatHistoryReady;
    g.commitProactiveChatBatch = commitProactiveChatBatch;
    g.exportFriendsToIndexedDB = exportFriendsToIndexedDB;
    g.refreshFriendsCache = refreshFriendsCache;
    g.chatHistoryStorageKey = chatHistoryStorageKey;
    g.invalidateChatHistoryMem = invalidateChatHistoryMem;
    g.clearChatHistoryMemCache = clearChatHistoryMemCache;
    g.discardWechatPendingPersistence = discardWechatPendingPersistence;
    g.getChatHistoryArray = getChatHistoryArray;
    g.schedulePersistChatHistory = schedulePersistChatHistory;
    g.flushChatHistoryPendingSync = flushChatHistoryPendingSync;
    g.replaceChatHistoryAndPersist = replaceChatHistoryAndPersist;
    g.flushAllChatHistoryPendingSync = flushAllChatHistoryPendingSync;
    g.saveFriendsToStorageDebounced = saveFriendsToStorageDebounced;

    if (typeof g.Wechat !== 'undefined' && g.Wechat) {
        var COUPLE_SPACE_STATE_KEY = 'wechatCoupleSpaceStateV1';

        function __coupleSpaceLoadStateRaw() {
            if (__coupleSpaceStateMem !== null) return __coupleSpaceStateMem;
            try {
                var raw = localStorage.getItem(COUPLE_SPACE_STATE_KEY);
                var obj;
                if (!raw) {
                    obj = { v: 1, activeCoupleFriendId: '', pairs: {} };
                } else {
                    obj = JSON.parse(raw);
                    if (!obj || typeof obj !== 'object') obj = { v: 1, activeCoupleFriendId: '', pairs: {} };
                    if (!obj.pairs || typeof obj.pairs !== 'object') obj.pairs = {};
                    if (obj.activeCoupleFriendId == null) obj.activeCoupleFriendId = '';
                    obj.v = 1;
                }
                __coupleSpaceStateMem = obj;
                return __coupleSpaceStateMem;
            } catch (e) {
                __coupleSpaceStateMem = { v: 1, activeCoupleFriendId: '', pairs: {} };
                return __coupleSpaceStateMem;
            }
        }

        function __coupleSpaceSaveStateRaw(state) {
            __coupleSpaceStateMem = state;
            try {
                localStorage.setItem(COUPLE_SPACE_STATE_KEY, JSON.stringify(state));
                g.__coupleSpaceStateLastPersistOk = true;
                return true;
            } catch (e) {
                g.__coupleSpaceStateLastPersistOk = false;
                return false;
            }
        }

        function __coupleSpaceNormalizeTextForScan(friend) {
            if (!friend || typeof friend !== 'object') return '';
            var chunks = [];
            if (friend.roleSetting) chunks.push(String(friend.roleSetting));
            if (friend.role) chunks.push(String(friend.role));
            if (friend.persona) {
                try {
                    chunks.push(JSON.stringify(friend.persona));
                } catch (e) {
                    chunks.push(String(friend.persona));
                }
            }
            return chunks.join('\n');
        }

        /**
         * 角色卡中已存在恋爱/婚姻对象（有恋人、有妻子等）——此类好友不出现在可邀请列表。
         * 启发式：匹配常见「已有对象」表述；避免单独用「恋」字误伤「无恋人」等。
         */
        function coupleSpaceHasRomanticPartnerOrSpouseInRoleCard(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return false;
            var strongNeedles = [
                '有恋人', '已有恋人', '我的恋人', '现任恋人',
                '有女朋友', '有男朋友', '有女友', '有男友',
                '有妻子', '有丈夫', '有老公', '有老婆', '有配偶',
                '未婚妻', '未婚夫',
                '已婚', '结婚了', '结了婚', '领证了', '婚姻状况：已婚', '婚姻：已婚',
                '热恋中', '交往中', '在交往', '异地恋中',
                '两口子', '小两口', '夫妻俩', '夫妻二人', '婚姻关系', '合法夫妻'
            ];
            var i;
            for (i = 0; i < strongNeedles.length; i++) {
                if (t.indexOf(strongNeedles[i]) !== -1) return true;
            }
            if (/(?:^|[\n。；;])\s*(?:妻子|丈夫|老公|老婆|男朋友|女朋友)\s*[:：]/.test(t)) return true;
            if (/(?:妻子|丈夫|老公|老婆|男朋友|女朋友|男友|女友)(?:叫|是|为|名叫|名为)/.test(t)) return true;
            return false;
        }

        /** 与 User 仅为血缘关系哥哥/姐姐（按角色卡文本启发式） */
        function coupleSpaceIsBloodSiblingToUserInRoleCard(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return false;
            if (t.indexOf('血缘') === -1) return false;
            if (/血缘[^ \n]{0,12}(哥哥|姐姐|兄长|姊姊|哥|姐)/.test(t)) return true;
            if (/(哥哥|姐姐)[^ \n]{0,12}血缘/.test(t)) return true;
            if (t.indexOf('血缘关系哥哥') !== -1 || t.indexOf('血缘关系姐姐') !== -1) return true;
            return false;
        }

        /** 闺蜜 / 铁哥们 / 非常好的姐们哥们（纯友谊向，不出现在可邀请列表） */
        function coupleSpaceIsBestieOrBroPlatonicInRoleCard(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return false;
            var needles = [
                '闺蜜', '好闺蜜', '姐妹淘', '铁闺蜜',
                '姐们', '好姐们', '铁姐们', '非常好的姐们',
                '哥们', '好哥们', '铁哥们', '好兄弟', '好弟兄', '好哥儿们', '非常好的哥们',
                '铁杆兄弟', '死党', '铁瓷',
                '纯友谊', '挚友（友）', '兄弟情', '兄妹情无恋爱'
            ];
            var i;
            for (i = 0; i < needles.length; i++) {
                if (t.indexOf(needles[i]) !== -1) return true;
            }
            return false;
        }

        /**
         * 角色卡是否体现为「单身」可发展恋爱：无婚恋对象信息时默认视为可邀请；
         * 若出现明确「非单身」用语则排除。
         */
        function coupleSpaceIsSingleOrUnknownSingleInRoleCard(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return true;
            if (/非单身|不是单身|已有对象|名花有主|名草有主|心有所属|有主了/.test(t)) return false;
            if (coupleSpaceHasRomanticPartnerOrSpouseInRoleCard(friend)) return false;
            return true;
        }

        /**
         * 从角色卡文本中解析「好感度」数值（启发式）：
         * - 支持：好感度: 92 / 好感度 92 / Favorability 92 / Affinity:92
         * - 若找不到，返回 null（上层可自行决定是否展示）
         */
        function coupleSpaceParseAffectionScoreFromFriend(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return null;
            var m =
                t.match(/(?:好感度|好感|亲密度|喜欢度|羁绊值|羁绊)\s*[:：]?\s*(\d{1,3})(?:\s*%|\s*分)?/i) ||
                t.match(/\b(?:favor|favorability|affinity|affection|intimacy)\b\s*[:：]?\s*(\d{1,3})\b/i);
            if (!m) return null;
            var n = parseInt(m[1], 10);
            if (!Number.isFinite(n)) return null;
            if (n < 0) n = 0;
            if (n > 999) n = 999;
            return n;
        }

        function coupleSpaceGetInviteEligibleFriends(options) {
            void options;
            var friends = typeof g.loadFriendsFromStorage === 'function' ? g.loadFriendsFromStorage() : [];
            if (!Array.isArray(friends)) friends = [];
            var st = __coupleSpaceLoadStateRaw();
            var acceptedMap = st && st.pairs && typeof st.pairs === 'object' ? st.pairs : {};
            return friends.filter(function (f) {
                if (!f || f.isGroup) return false;
                if (f.blacklisted) return false;
                var fid = String(f.id);
                var pair = acceptedMap[fid];
                if (pair && String(pair.status) === 'accepted') return false; // 已确认关系：不再出现在可邀请列表
                if (coupleSpaceHasRomanticPartnerOrSpouseInRoleCard(f)) return false;
                if (coupleSpaceIsBloodSiblingToUserInRoleCard(f)) return false;
                if (coupleSpaceIsBestieOrBroPlatonicInRoleCard(f)) return false;
                if (!coupleSpaceIsSingleOrUnknownSingleInRoleCard(f)) return false;
                return true;
            });
        }

        /** 下拉列表副标题：不依赖好感度 */
        function coupleSpaceGetInviteRowSubtitle(friend) {
            var t = __coupleSpaceNormalizeTextForScan(friend);
            if (!t) return '角色卡未写关系（默认可邀请）';
            if (/单身|未婚|独身/.test(t)) return '角色卡：单身/未婚';
            return '无恋人·非闺蜜哥们·非血缘兄姐';
        }

        function coupleSpaceGetState() {
            return __coupleSpaceLoadStateRaw();
        }

        function coupleSpaceSetActiveCoupleFriendId(friendId) {
            var st = __coupleSpaceLoadStateRaw();
            st.activeCoupleFriendId = friendId != null ? String(friendId) : '';
            __coupleSpaceSaveStateRaw(st);
            return st;
        }

        function coupleSpaceGetActiveCoupleFriendId() {
            return String(__coupleSpaceLoadStateRaw().activeCoupleFriendId || '');
        }

        function coupleSpaceUpsertPair(friendId, patch) {
            var fid = String(friendId);
            var st = __coupleSpaceLoadStateRaw();
            var prev = st.pairs[fid] && typeof st.pairs[fid] === 'object' ? st.pairs[fid] : {};
            var next = Object.assign({}, prev, patch || {});
            next.friendId = fid;
            next.updatedAt = Date.now();
            st.pairs[fid] = next;
            __coupleSpaceSaveStateRaw(st);
            return next;
        }

        function coupleSpaceGetPair(friendId) {
            var st = __coupleSpaceLoadStateRaw();
            return st.pairs[String(friendId)] || null;
        }

        function coupleSpaceMarkAccepted(friendId, meta) {
            var m = meta && typeof meta === 'object' ? meta : {};
            return coupleSpaceUpsertPair(friendId, {
                status: 'accepted',
                acceptedAt: Date.now(),
                lastInviteId: m.inviteId != null ? String(m.inviteId) : (m.lastInviteId != null ? String(m.lastInviteId) : undefined)
            });
        }

        function coupleSpaceMarkRejected(friendId, meta) {
            var m = meta && typeof meta === 'object' ? meta : {};
            return coupleSpaceUpsertPair(friendId, {
                status: 'rejected',
                rejectedAt: Date.now(),
                lastInviteId: m.inviteId != null ? String(m.inviteId) : undefined
            });
        }

        function coupleSpaceIsAccepted(friendId) {
            var p = coupleSpaceGetPair(friendId);
            return !!(p && String(p.status) === 'accepted');
        }

        g.Wechat.store = {
            version: '1.0.0',
            /** 好友/群设置表单未提交草稿（非持久化；与 window.tempFriendData 同一引用） */
            tempFriendData: g.tempFriendData,
            /** 同上（与 window.tempGroupData 同一引用） */
            tempGroupData: g.tempGroupData,
            FRIENDS_LS_KEY: FRIENDS_LS_KEY,
            getSystemDefaultFriendIds: getSystemDefaultFriendIds,
            isSystemDefaultFriend: isSystemDefaultFriend,
            mergeSystemDefaults: mergeSystemDefaults,
            mergeSystemDefaultsSave: mergeSystemDefaultsSave,
            saveImportedFriendsOverwrite: saveImportedFriendsOverwrite,
            mergeImportedWechatBundleByNickname: mergeImportedWechatBundleByNickname,
            hydrateImportedFriendsPersonaGaps: hydrateImportedFriendsPersonaGaps,
            openWechatKvDB: openWechatKvDB,
            wechatKvSet: wechatKvSet,
            wechatKvGet: wechatKvGet,
            wechatKvDelete: wechatKvDelete,
            clearEntireWechatKvStore: clearEntireWechatKvStore,
            getFriendsRawFromStorage: getFriendsRawFromStorage,
            saveFriendsToIndexedDB: saveFriendsToIndexedDB,
            tryClearStaleLocalStorageForFriends: tryClearStaleLocalStorageForFriends,
            loadFriendsFromIndexedDB: loadFriendsFromIndexedDB,
            saveFriendsToStorage: saveFriendsToStorage,
            saveFriendsToStorageAsync: saveFriendsToStorageAsync,
            loadFriendsFromStorage: loadFriendsFromStorage,
            initFriendsFromIndexedDBIfNeeded: initFriendsFromIndexedDBIfNeeded,
            ensureFriendsCacheHydrated: ensureFriendsCacheHydrated,
            areWechatFriendsReadyForMutation: areWechatFriendsReadyForMutation,
            initChatHistoriesFromIndexedDBIfNeeded: initChatHistoriesFromIndexedDBIfNeeded,
            preloadChatHistoryFromIdbIfNeeded: preloadChatHistoryFromIdbIfNeeded,
            __chatHistoryIdbCache: __chatHistoryIdbCache,
            exportFriendsToIndexedDB: exportFriendsToIndexedDB,
            refreshFriendsCache: refreshFriendsCache,
            chatHistoryStorageKey: chatHistoryStorageKey,
            invalidateChatHistoryMem: invalidateChatHistoryMem,
            clearChatHistoryMemCache: clearChatHistoryMemCache,
            discardWechatPendingPersistence: discardWechatPendingPersistence,
            getChatHistoryArray: getChatHistoryArray,
            schedulePersistChatHistory: schedulePersistChatHistory,
            flushChatHistoryPendingSync: flushChatHistoryPendingSync,
            replaceChatHistoryAndPersist: replaceChatHistoryAndPersist,
            flushAllChatHistoryPendingSync: flushAllChatHistoryPendingSync,
            saveFriendsToStorageDebounced: saveFriendsToStorageDebounced,
            _chatHistoryMem: __chatHistoryMem,

            /**
             * 情侣空间（发现页入口）状态与规则
             * - 可邀请名单：读好友 roleSetting/role/persona（单身/无婚恋对象；排除恋人妻子、血缘兄姐、闺蜜铁哥们等，启发式）
             * - 持久化：localStorage `wechatCoupleSpaceStateV1`
             */
            coupleSpace: {
                STATE_KEY: COUPLE_SPACE_STATE_KEY,
                invalidateMemCache: coupleSpaceInvalidateMemCache,
                parseAffectionScoreFromFriend: coupleSpaceParseAffectionScoreFromFriend,
                hasRomanticPartnerOrSpouseInRoleCard: coupleSpaceHasRomanticPartnerOrSpouseInRoleCard,
                isBloodSiblingToUserInRoleCard: coupleSpaceIsBloodSiblingToUserInRoleCard,
                isBestieOrBroPlatonicInRoleCard: coupleSpaceIsBestieOrBroPlatonicInRoleCard,
                isSingleOrUnknownSingleInRoleCard: coupleSpaceIsSingleOrUnknownSingleInRoleCard,
                getInviteRowSubtitle: coupleSpaceGetInviteRowSubtitle,
                getInviteEligibleFriends: coupleSpaceGetInviteEligibleFriends,
                getState: coupleSpaceGetState,
                setActiveCoupleFriendId: coupleSpaceSetActiveCoupleFriendId,
                getActiveCoupleFriendId: coupleSpaceGetActiveCoupleFriendId,
                upsertPair: coupleSpaceUpsertPair,
                getPair: coupleSpaceGetPair,
                markAccepted: coupleSpaceMarkAccepted,
                markRejected: coupleSpaceMarkRejected,
                isAccepted: coupleSpaceIsAccepted
            }
        };
    }
})(typeof window !== 'undefined' ? window : this);
