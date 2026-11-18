/**
 * Lego 小手机 · 微信备份模块
 *
 * 从 app.js 迁出：微信导出收集、emoji 导出收集、微信导入子流程。
 * 依赖 app.js 中既有的导入导出总流程、存储工具、Moments / theme / wallet 等公共能力；需在相关微信模块之后加载。
 *
 * 导出说明：friends 来自 loadFriendsFromStorage()，已含列表头像 avatar、聊天专属 chatAvatar、
 * 角色卡 persona（含 persona.avatar）、群聊 groupMyChatAvatar / groupMyPersona / groupBubbleCss 等
 * 持久化在好友条目的字段；另含 wechatPerChatExtension 收纳线下模式/长记忆等独立 localStorage 键。
 */
(function (global) {
    'use strict';

    /** 好友/群聊相关、但不在 friends 数组中的 localStorage（线下模式、长记忆草稿等） */
    var WECHAT_PERCHAT_EXT_PREFIXES = [
        'offlineModeSettings_',
        'offlineFloatPos_',
        'chatSummaryDraft_',
        'chatSummaryLastDoneRounds_',
        'chatLongMemories_',
        'proactiveMessageRuntimeV2:'
    ];
    var WECHAT_PERCHAT_EXT_EXACT_KEYS = ['offlineWritingStyles', 'chatSummaryPrompts', 'proactiveMessageSettingsV1', 'proactiveAutoApiSettingsV1'];

    function isWechatPerChatExtensionKey(key) {
        if (typeof key !== 'string' || !key) return false;
        if (WECHAT_PERCHAT_EXT_EXACT_KEYS.indexOf(key) !== -1) return true;
        var i;
        for (i = 0; i < WECHAT_PERCHAT_EXT_PREFIXES.length; i++) {
            if (key.indexOf(WECHAT_PERCHAT_EXT_PREFIXES[i]) === 0) return true;
        }
        return false;
    }

    function collectWechatPerChatExtension(keys) {
        var out = {};
        var miss = {};
        keys.forEach(function (key) {
            if (!isWechatPerChatExtensionKey(key)) return;
            if (typeof LS_CHUNK_SEP === 'string' && key.indexOf(LS_CHUNK_SEP) !== -1) return;
            var parsed = parseJsonFromPossiblyEncodedStorage(key, miss);
            if (parsed !== miss) {
                out[key] = parsed;
            } else {
                var raw = localStorage.getItem(key);
                if (raw != null) out[key] = raw;
            }
        });
        return out;
    }

    function clearWechatPerChatExtensionStorage() {
        try {
            var seen = Object.create(null);
            Object.keys(localStorage).forEach(function (k) {
                var base = k;
                if (typeof LS_CHUNK_SEP === 'string' && k.indexOf(LS_CHUNK_SEP) !== -1) {
                    base = k.slice(0, k.indexOf(LS_CHUNK_SEP));
                }
                if (!isWechatPerChatExtensionKey(base)) return;
                if (seen[base]) return;
                seen[base] = true;
                clearChunkedStorage(base);
            });
        } catch (e) {}
    }

    function collectWechatData() {
        const safeParse = (raw, fallback) => {
            try {
                if (raw == null || raw === '') return fallback;
                return JSON.parse(raw);
            } catch (e) {
                return fallback;
            }
        };
        try {
            const wechatDataRaw = localStorage.getItem('wechatData');
            const keys = Object.keys(localStorage);

            const chatHistories = {};
            keys.forEach((key) => {
                if (!key.startsWith('chatHistory_')) return;
                if (key.indexOf(LS_CHUNK_SEP) !== -1) return;
                const parsed = parseJsonFromPossiblyEncodedStorage(key, []);
                chatHistories[key] = Array.isArray(parsed) ? parsed : [];
            });

            const chatBackgrounds = {};
            keys.forEach((key) => {
                if (key.startsWith('chatBackground_')) {
                    chatBackgrounds[key] = localStorage.getItem(key) || '';
                }
            });

            const readTogether = {};
            keys.forEach((key) => {
                if (key.startsWith('readTogether_')) {
                    readTogether[key] = safeParse(localStorage.getItem(key), null);
                }
            });

            const favoritesRaw = localStorage.getItem('wechatFavorites');
            const momentsCoverImage = localStorage.getItem('momentsCoverImageDataUrl');
            const walletBalance = localStorage.getItem('walletBalance');
            const walletPaymentPassword = localStorage.getItem('walletPaymentPassword');
            const kinshipCardsRaw = localStorage.getItem('kinshipCards');
            const coupleSpaceStateRaw = localStorage.getItem('wechatCoupleSpaceStateV1');

            const wechatAppearance = {
                globalBg: parseJsonFromPossiblyEncodedStorage(WECHAT_LS_GLOBAL_BG, '') || '',
                bubbleCss: parseJsonFromPossiblyEncodedStorage(WECHAT_LS_BUBBLE_CSS, '') || '',
                globalFont: parseJsonFromPossiblyEncodedStorage(WECHAT_LS_GLOBAL_FONT, '') || ''
            };

            const friendsParsed = loadFriendsFromStorage();
            const wechatPerChatExtension = collectWechatPerChatExtension(keys);
            return {
                wechatData: safeParse(wechatDataRaw, {}),
                friends: friendsParsed,
                friendsRaw: JSON.stringify(friendsParsed),
                friendsCount: Array.isArray(friendsParsed) ? friendsParsed.length : 0,
                myProfile: parseJsonFromPossiblyEncodedStorage(MY_PROFILE_LS_KEY, null),
                userInfo: parseJsonFromPossiblyEncodedStorage(USER_INFO_LS_KEY, null),
                chatHistories,
                chatBackgrounds,
                readTogether,
                favorites: safeParse(favoritesRaw, []),
                momentsPosts: parseJsonFromPossiblyEncodedStorage(MOMENTS_POSTS_LS_KEY, []),
                momentsCoverImage: momentsCoverImage || null,
                walletBalance:
                    walletBalance != null && walletBalance !== '' ? walletBalance : String(WALLET_INITIAL_BALANCE),
                walletPaymentPassword: walletPaymentPassword || null,
                kinshipCards: safeParse(kinshipCardsRaw, null),
                /** 情侣空间（发现页卡片、私密空间标题/背景/日记等）与 localStorage 键名一致，便于对照 */
                wechatCoupleSpaceStateV1: safeParse(coupleSpaceStateRaw, null),
                wechatAppearance,
                /** 线下模式、聊天摘要/长记忆、文风列表等（键与 localStorage 一致） */
                wechatPerChatExtension: wechatPerChatExtension
            };
        } catch (e) {
            console.error('收集微信数据失败:', e);
            return {
                wechatData: {},
                friends: [],
                friendsRaw: '',
                friendsCount: 0,
                myProfile: null,
                userInfo: null,
                chatHistories: {},
                chatBackgrounds: {},
                readTogether: {},
                favorites: [],
                momentsPosts: [],
                momentsCoverImage: null,
                walletBalance: String(WALLET_INITIAL_BALANCE),
                walletPaymentPassword: null,
                kinshipCards: null,
                wechatCoupleSpaceStateV1: null,
                wechatAppearance: { globalBg: '', bubbleCss: '', globalFont: '' },
                wechatPerChatExtension: {}
            };
        }
    }

    function collectEmojiData() {
        try {
            const emojiData = localStorage.getItem('emojiData');
            const emojiCategories = localStorage.getItem('emojiCategories');
            const data = emojiData ? (parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {}) || {}) : {};
            return {
                emojiData: data,
                emojiCategories: emojiCategories ? parseJsonFromPossiblyEncodedStorage(EMOJI_CATEGORIES_LS_KEY, null) : null
            };
        } catch (e) {
            console.error('收集表情数据失败:', e);
            return {};
        }
    }

    async function collectWechatDataAsync() {
        const data = collectWechatData();
        if (global.LegoMilianTarot) data.milianTarot = await global.LegoMilianTarot.exportBackup();
        return data;
    }

    async function importWechatData(w) {
        // Validate and atomically merge the independent module before replacing host data.
        if (w && w.milianTarot != null) {
            if (!global.LegoMilianTarot) throw new Error('迷恋塔罗模块尚未载入，未导入备份');
            await global.LegoMilianTarot.importBackup(w.milianTarot);
        }
        var resumeProactive = global.Wechat && Wechat.proactive ? Wechat.proactive.suspend() : function () {};
        try {
        try {
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith('chatHistory_')) clearChunkedStorage(k);
            });
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith('chatBackground_')) clearChunkedStorage(k);
            });
            Object.keys(localStorage).forEach((k) => {
                if (k.startsWith('readTogether_')) localStorage.removeItem(k);
            });
        } catch (e) {}

        requireKey(w, 'wechatData', 'wechat 缺少 wechatData');
        requireKey(w, 'friends', 'wechat 缺少 friends');
        requireKey(w, 'userInfo', 'wechat 缺少 userInfo');
        requireKey(w, 'myProfile', 'wechat 缺少 myProfile');
        requireKey(w, 'chatHistories', 'wechat 缺少 chatHistories');
        requireKey(w, 'momentsPosts', 'wechat 缺少 momentsPosts');

        const userInfoVal =
            w.userInfo && typeof w.userInfo === 'object'
                ? w.userInfo
                : { nickname: '可点击编辑', avatar: '' };
        const myProfileVal =
            w.myProfile && typeof w.myProfile === 'object'
                ? w.myProfile
                : {};
        const wechatDataVal = w.wechatData && typeof w.wechatData === 'object' ? w.wechatData : {};
        const friendsValRaw = Array.isArray(w.friends) ? w.friends : [];
        const chatHistoriesVal = w.chatHistories && typeof w.chatHistories === 'object' ? w.chatHistories : {};
        const momentsPostsVal = Array.isArray(w.momentsPosts) ? w.momentsPosts : [];

        let friendsVal = friendsValRaw;
        let chatHistoriesForImport = chatHistoriesVal;
        let chatBackgroundsForImport = w.chatBackgrounds && typeof w.chatBackgrounds === 'object' ? w.chatBackgrounds : {};
        let readTogetherForImport = w.readTogether && typeof w.readTogether === 'object' ? w.readTogether : {};

        try { localStorage.setItem('wechatData', JSON.stringify(wechatDataVal)); } catch (e) { console.warn('导入微信数据失败（存储配额不足）'); }
        updateImportProgress('加载系统预设好友...');
        await new Promise(r => setTimeout(r, 0));
        await loadSystemDefaultFriends();
        if (typeof mergeImportedWechatBundleByNickname === 'function') {
            updateImportProgress('合并昵称相同的好友...');
            await new Promise(r => setTimeout(r, 0));
            const pack = mergeImportedWechatBundleByNickname(
                friendsValRaw,
                chatHistoriesVal,
                w.chatBackgrounds,
                w.readTogether
            );
            friendsVal = pack.friends;
            chatHistoriesForImport = pack.chatHistories;
            chatBackgroundsForImport = pack.chatBackgrounds;
            readTogetherForImport = pack.readTogether;
        }
        updateImportProgress('导入好友数据（覆盖备份列表）...');
        await new Promise(r => setTimeout(r, 0));
        try {
            if (typeof saveImportedFriendsOverwrite === 'function') {
                saveImportedFriendsOverwrite(friendsVal);
            } else {
                saveFriendsToStorage(friendsVal);
            }
        } catch (e) { console.warn('导入好友数据失败（存储配额不足）:', e && (e.message || e)); }
        try {
            const fm = localStorage.getItem(FRIENDS_LS_KEY);
            if (typeof fm === 'string' && fm.startsWith(LS_IDB_PREFIX)) {
                if (typeof global.ensureFriendsCacheHydrated === 'function') {
                    await global.ensureFriendsCacheHydrated();
                }
                await saveFriendsToIndexedDB(loadFriendsFromStorage(), { alreadyMerged: true });
            }
        } catch (e) {
            console.warn('导入后确认好友写入 IndexedDB 失败:', e && (e.message || e));
        }

        updateImportProgress('导入用户信息...');
        await new Promise(r => setTimeout(r, 0));
        try { saveJsonToStorageWithCompression(USER_INFO_LS_KEY, userInfoVal); } catch (e) { console.warn('导入用户信息失败（存储配额不足）:', e && (e.message || e)); }
        try {
            saveJsonToStorageWithCompression(MY_PROFILE_LS_KEY, myProfileVal);
        } catch (e) {
            console.warn('导入我的资料失败（存储配额不足）:', e && (e.message || e));
            try {
                localStorage.setItem(MY_PROFILE_LS_KEY, LS_IDB_PREFIX + '1');
                await wechatKvSet(MY_PROFILE_LS_KEY, JSON.stringify(myProfileVal));
            } catch (idbErr) {
                console.warn('导入我的资料写入 IndexedDB 也失败:', idbErr && (idbErr.message || idbErr));
            }
        }

        try {
            if (typeof hydrateImportedFriendsPersonaGaps === 'function') {
                if (typeof global.ensureFriendsCacheHydrated === 'function') {
                    await global.ensureFriendsCacheHydrated();
                }
                const repairedFriends = hydrateImportedFriendsPersonaGaps(loadFriendsFromStorage());
                saveFriendsToStorage(repairedFriends);
                const fmH = localStorage.getItem(FRIENDS_LS_KEY);
                if (typeof fmH === 'string' && fmH.startsWith(LS_IDB_PREFIX)) {
                    if (typeof global.ensureFriendsCacheHydrated === 'function') {
                        await global.ensureFriendsCacheHydrated();
                    }
                    await saveFriendsToIndexedDB(loadFriendsFromStorage(), { alreadyMerged: true });
                }
            }
        } catch (e) {
            console.warn('导入后回补 per-chat 人设失败:', e && (e.message || e));
        }

        const chatKeys = Object.keys(chatHistoriesForImport).filter(k => k.startsWith('chatHistory_'));
        const BATCH = 20;
        for (let i = 0; i < chatKeys.length; i += BATCH) {
            const batch = chatKeys.slice(i, i + BATCH);
            batch.forEach(key => {
                try { saveJsonToStorageWithCompression(key, chatHistoriesForImport[key]); } catch (e) { console.warn('导入聊天记录失败（存储配额不足）:', key); }
            });
            updateImportProgress(`导入聊天记录 ${Math.min(i + BATCH, chatKeys.length)}/${chatKeys.length}...`);
            await new Promise(r => setTimeout(r, 0));
        }

        {
            if (typeof global.ensureFriendsCacheHydrated === 'function') {
                try {
                    await global.ensureFriendsCacheHydrated();
                } catch (e) {}
            }
            const friendsNow = loadFriendsFromStorage();
            let changed = false;
            chatKeys.forEach(key => {
                const fid = key.replace(/^chatHistory_/, '');
                const history = chatHistoriesForImport[key];
                if (Array.isArray(history) && history.length > 0) {
                    const last = history[history.length - 1];
                    const friend = friendsNow.find(f => String(f.id) === fid);
                    if (friend) {
                        const needUpdate = !friend.lastMessageTime || Number(last.timestamp) > Number(friend.lastMessageTime);
                        if (needUpdate) {
                            friend.lastMessageTime = Number(last.timestamp);
                            friend.lastMessage = last.content || '';
                            changed = true;
                        }
                    }
                }
            });
            if (changed) {
                try { saveFriendsToStorage(friendsNow); } catch (e) { console.warn('同步好友最后消息时间失败:', e); }
            }
        }

        updateImportProgress('导入聊天背景...');
        await new Promise(r => setTimeout(r, 0));
        if (chatBackgroundsForImport && typeof chatBackgroundsForImport === 'object') {
            Object.keys(chatBackgroundsForImport).forEach((key) => {
                if (key.startsWith('chatBackground_')) {
                    try { localStorage.setItem(key, String(chatBackgroundsForImport[key] || '')); } catch (e) { console.warn('导入聊天背景失败（存储配额不足）:', key); }
                }
            });
        }

        if (readTogetherForImport && typeof readTogetherForImport === 'object') {
            Object.keys(readTogetherForImport).forEach((key) => {
                if (key.startsWith('readTogether_')) {
                    try { localStorage.setItem(key, JSON.stringify(readTogetherForImport[key])); } catch (e) { console.warn('导入共读数据失败（存储配额不足）:', key); }
                }
            });
        }

        updateImportProgress('导入收藏...');
        await new Promise(r => setTimeout(r, 0));
        try { saveJsonToStorageWithCompression(WECHAT_FAVORITES_LS_KEY, w.favorites); } catch (e) { console.warn('导入收藏失败（存储配额不足）:', e && (e.message || e)); }

        updateImportProgress('导入朋友圈...');
        await new Promise(r => setTimeout(r, 0));
        try {
            saveJsonToStorageWithCompression(MOMENTS_POSTS_LS_KEY, momentsPostsVal);
        } catch (e) {
            if (String(e && e.message || '') === '__NEED_IDB_MOMENTS__') {
                try {
                    localStorage.setItem(MOMENTS_POSTS_LS_KEY, LS_IDB_PREFIX + '1');
                    await Moments.store.saveMomentsPostsToIdb(momentsPostsVal);
                } catch (idbErr) {
                    console.warn('导入朋友圈写入 IndexedDB 失败:', idbErr && (idbErr.message || idbErr));
                }
            } else {
                console.warn('导入朋友圈失败（存储配额不足）:', e && (e.message || e));
            }
        }
        if (w.momentsCoverImage != null) {
            try { await setLocalStorageStringWithQuotaFallback(MOMENTS_COVER_LS_KEY, String(w.momentsCoverImage || ''), { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' }); } catch (e) { console.warn('导入朋友圈封面失败（存储配额不足）:', e && (e.message || e)); }
            try { if (typeof Moments !== 'undefined' && Moments.ui && typeof Moments.ui.applyMomentsCoverFromStorage === 'function') Moments.ui.applyMomentsCoverFromStorage(); } catch (e) {}
        }
        if (w.walletBalance != null) { try { localStorage.setItem('walletBalance', String(w.walletBalance)); } catch (e) { console.warn('导入钱包余额失败（存储配额不足）'); } }
        if (w.walletPaymentPassword != null) { try { localStorage.setItem('walletPaymentPassword', String(w.walletPaymentPassword)); } catch (e) { console.warn('导入支付密码失败（存储配额不足）'); } }
        if (w.kinshipCards != null) { try { localStorage.setItem('kinshipCards', JSON.stringify(w.kinshipCards)); } catch (e) { console.warn('导入亲属卡失败（存储配额不足）'); } }

        updateImportProgress('导入情侣空间状态...');
        await new Promise(r => setTimeout(r, 0));
        if (w.wechatCoupleSpaceStateV1 != null && typeof w.wechatCoupleSpaceStateV1 === 'object') {
            try {
                localStorage.setItem('wechatCoupleSpaceStateV1', JSON.stringify(w.wechatCoupleSpaceStateV1));
            } catch (e) {
                console.warn('导入情侣空间状态失败（存储配额不足）:', e && (e.message || e));
            }
        } else {
            try { localStorage.removeItem('wechatCoupleSpaceStateV1'); } catch (e) {}
        }
        try {
            if (typeof global.Wechat !== 'undefined' && global.Wechat.store && global.Wechat.store.coupleSpace && typeof global.Wechat.store.coupleSpace.invalidateMemCache === 'function') {
                global.Wechat.store.coupleSpace.invalidateMemCache();
            }
        } catch (e) {}

        if (w.wechatAppearance && typeof w.wechatAppearance === 'object') {
            const ap = w.wechatAppearance;
            try { await setLocalStorageStringWithQuotaFallback(WECHAT_LS_GLOBAL_BG, String(ap.globalBg || ''), { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' }); } catch (e) { console.warn('导入微信全局背景失败（存储配额不足）'); }
            try { localStorage.setItem(WECHAT_LS_BUBBLE_CSS, String(ap.bubbleCss || '')); } catch (e) { console.warn('导入微信气泡CSS失败（存储配额不足）'); }
            try { await setLocalStorageStringWithQuotaFallback(WECHAT_LS_GLOBAL_FONT, String(ap.globalFont || ''), { maxDim: 0, quality: 0.92, mime: 'font/ttf' }); } catch (e) { console.warn('导入微信全局字体失败（存储配额不足）'); }
            try { if (typeof applyWechatThemeFromStorage === 'function') applyWechatThemeFromStorage(); } catch (e) {}
        }

        updateImportProgress('导入线下模式与长记忆等扩展设置...');
        await new Promise(r => setTimeout(r, 0));
        if (w.wechatPerChatExtension != null && typeof w.wechatPerChatExtension === 'object') {
            clearWechatPerChatExtensionStorage();
            Object.keys(w.wechatPerChatExtension).forEach(function (key) {
                if (!isWechatPerChatExtensionKey(key)) return;
                var val = w.wechatPerChatExtension[key];
                try {
                    if (typeof val === 'string') {
                        localStorage.setItem(key, val);
                    } else if (val !== undefined && val !== null) {
                        saveJsonToStorageWithCompression(key, val);
                    }
                } catch (e) {
                    console.warn('导入每会话扩展设置失败（存储配额不足）:', key);
                }
            });
        }

        requireKey(w, 'emoji', 'wechat 缺少 emoji');
        const emoji = w.emoji || {};
        const emojiDataVal = emoji.emojiData || emoji;
        assertBackup(emojiDataVal && typeof emojiDataVal === 'object', 'emojiData 无效');
        updateImportProgress('导入表情包...');
        await new Promise(r => setTimeout(r, 0));
        try {
            saveJsonToStorageWithCompression(EMOJI_DATA_LS_KEY, emojiDataVal);
        } catch (e) {
            if (isQuotaExceededError(e)) {
                try {
                    await saveEmojiDataToIdb(emojiDataVal);
                } catch (idbErr) {
                    console.warn('导入 emojiData 到 IndexedDB 失败:', idbErr && (idbErr.message || idbErr));
                }
            }
        }
        if (emoji.emojiCategories != null) {
            try {
                saveJsonToStorageWithCompression(EMOJI_CATEGORIES_LS_KEY, emoji.emojiCategories);
            } catch (e) {
                if (isQuotaExceededError(e)) {
                    try {
                        await saveEmojiCategoriesToIdb(emoji.emojiCategories);
                    } catch (idbErr) {
                        console.warn('导入 emojiCategories 到 IndexedDB 失败:', idbErr && (idbErr.message || idbErr));
                    }
                }
            }
        }
        } finally {
            resumeProactive();
        }
    }

    global.collectWechatData = collectWechatData;
    global.collectEmojiData = collectEmojiData;

    if (typeof global.Wechat !== 'undefined' && global.Wechat) {
        global.Wechat.backup = {
            version: '0.1.0',
            collectWechatData,
            collectWechatDataAsync,
            collectEmojiData,
            importWechatData,
            clearPerChatExtensionStorage: clearWechatPerChatExtensionStorage,
        };
    }
})(typeof window !== 'undefined' ? window : this);
