/**
 * Lego 小手机 · 微信 — UI（阶段 3）
 * 批次 1：底部导航、消息列表、添加菜单。
 * 批次 2：openChat、loadChatHistory、displayMessage、sendMessage、更多面板 onMoreItemClick / toggleMorePanel。
 *
 * 依赖全局：app.js 气泡与 API 管线（buildMessageBubbles、escapeHtml、HeartbeatMonitor、navigateTo 等）、
 * wechat-store、window.__chatUiBridge（currentPage / isReceiving；多选与引用由 wechat-chat-pipeline.js patch）。
 *
 * 加载顺序：… → wechat-ui.js → wechat-chat-pipeline.js → wechat-wallet.js → wechat-ui-settings.js
 */
(function (global) {
    'use strict';

    var _chatListRefreshTimer = null;
    var _chatListLoadId = 0;
    var _wechatUiDomReady = false;

    function showWechatSearch() {
        showWechatMessages();
        var bar = document.getElementById('wechat-search-bar');
        var input = document.getElementById('wechat-conversation-search');
        if (bar) bar.hidden = false;
        if (input) input.focus();
    }

    function closeWechatSearch() {
        var bar = document.getElementById('wechat-search-bar');
        var input = document.getElementById('wechat-conversation-search');
        if (bar) bar.hidden = true;
        if (input) input.value = '';
        filterWechatConversations('');
        document.querySelector('#wechat-page [aria-label="搜索会话"]')?.focus();
    }

    function filterWechatConversations(query) {
        var value = String(query || '').trim().toLocaleLowerCase();
        var matches = 0;
        document.querySelectorAll('#wechat-page .wechat-chat-item').forEach(function (item) {
            var visible = !value || String(item.dataset.searchText || '').includes(value);
            item.hidden = !visible;
            if (visible) matches++;
        });
        var empty = document.getElementById('wechat-search-empty');
        var list = document.querySelector('#wechat-page .wechat-chat-list');
        if (empty) empty.hidden = !value || matches > 0 || (list && list.dataset.ready !== 'true');
        var chatEmpty = document.getElementById('wechat-chat-empty');
        if (chatEmpty) chatEmpty.hidden = !!value;
    }

    function showWechatAdd() {
        showNotification('显示添加菜单');
    }

    function toggleWechatAddMenu() {
        var addMenu = document.getElementById('wechat-add-menu');
        var trigger = document.getElementById('wechat-add-trigger');
        if (!addMenu) return;
        var open = addMenu.classList.toggle('show');
        if (trigger) trigger.setAttribute('aria-expanded', String(open));
    }

    function closeWechatAddMenu() {
        document.getElementById('wechat-add-menu')?.classList.remove('show');
        document.getElementById('wechat-add-trigger')?.setAttribute('aria-expanded', 'false');
    }

    function setWechatActiveTab(tab) {
        closeWechatAddMenu();
        document.querySelectorAll('.wechat-nav-item').forEach(function (item, index) {
            var name = item.dataset.wechatTab || ['messages', 'discover', 'me'][index % 3];
            var active = name === tab;
            item.classList.toggle('active', active);
            if (active) item.setAttribute('aria-current', 'page');
            else item.removeAttribute('aria-current');
        });
    }

    function showWechatMessages() {
        document.getElementById('wechat-page').classList.add('active');
        document.getElementById('wechat-me-page').classList.remove('active');
        document.getElementById('wechat-discover-page').classList.remove('active');
        setWechatActiveTab('messages');
        scheduleLoadChatList();
    }

    function showWechatDiscover() {
        document.getElementById('wechat-page').classList.remove('active');
        document.getElementById('wechat-me-page').classList.remove('active');
        document.getElementById('wechat-discover-page').classList.add('active');
        setWechatActiveTab('discover');
    }

    function closeWechatSettingsPage() {
        document.querySelector('.wechat-me-header')?.classList.remove('hidden');
        document.querySelector('.wechat-me-profile')?.classList.remove('hidden');
        document.querySelector('.wechat-me-functions')?.classList.remove('hidden');
        document.getElementById('wechat-settings-page')?.classList.remove('show');
    }

    function showWechatMe() {
        closeWechatSettingsPage();
        ['favorites-page', 'wallet-page', 'kinship-page', 'wallet-bills-page'].forEach(function (id) {
            document.getElementById(id)?.classList.remove('show');
        });
        document.getElementById('wechat-page').classList.remove('active');
        document.getElementById('wechat-me-page').classList.add('active');
        document.getElementById('wechat-discover-page').classList.remove('active');
        setWechatActiveTab('me');
        try {
            if (typeof global.loadUserInfo === 'function') {
                global.loadUserInfo();
            }
        } catch (e) {}
    }

    function formatMessageTime(timestamp) {
        var now = new Date();
        var messageDate = new Date(timestamp);
        var nowYear = now.getFullYear();
        var messageYear = messageDate.getFullYear();
        var nowMonth = now.getMonth();
        var messageMonth = messageDate.getMonth();
        var messageDateDay = messageDate.getDate();

        var diffTime = Math.abs(now - messageDate);
        var diffDays = Math.floor(diffTime / (1000 * 60 * 60 * 24));

        if (nowYear !== messageYear) {
            return messageYear + '-' + (messageMonth + 1).toString().padStart(2, '0') + '-' + messageDateDay.toString().padStart(2, '0');
        }
        if (nowMonth !== messageMonth || diffDays > 7) {
            return (messageMonth + 1).toString().padStart(2, '0') + '-' + messageDateDay.toString().padStart(2, '0');
        }
        if (diffDays === 1) return '昨天';
        if (diffDays === 0) {
            var hours = messageDate.getHours().toString().padStart(2, '0');
            var minutes = messageDate.getMinutes().toString().padStart(2, '0');
            return hours + ':' + minutes;
        }
        var weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
        return weekdays[messageDate.getDay()];
    }

    function addChatItem(chatList, friend) {
        var nickname = String(friend.nickname || '未命名会话');
        var chatItem = document.createElement('button');
        chatItem.type = 'button';
        chatItem.className = 'wechat-chat-item' + (friend.unreadCount > 0 ? ' unread' : '') + (friend.pinned ? ' pinned' : '');
        chatItem.dataset.friendId = friend.id;
        chatItem.dataset.searchText = (nickname + '\n' + String(friend.lastMessage || '')).toLocaleLowerCase();
        chatItem.setAttribute('aria-label', '打开与' + nickname + '的聊天');
        chatItem.onclick = function () {
            void (async function () {
                try {
                    if (typeof global.ensureFriendsCacheHydrated === 'function') {
                        await global.ensureFriendsCacheHydrated();
                    }
                } catch (e) {}
                if (friend.unreadCount > 0) {
                    friend.unreadCount = 0;
                    var friends = loadFriendsFromStorage();
                    var updatedFriends = friends.map(function (f) {
                        return f.id == friend.id ? Object.assign({}, f, { unreadCount: 0 }) : f;
                    });
                    try { saveFriendsToStorage(updatedFriends); } catch (e) {}
                }
                openChat(friend.nickname, friend.id);
            })();
        };

        var avatarElement = document.createElement('span');
        avatarElement.className = 'wechat-chat-avatar';

        var friendAvatarSrc = typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(friend)
            : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || '');
        if (friendAvatarSrc) {
            var cleanAvatar = friendAvatarSrc;
            avatarElement.style.backgroundImage = 'url(' + cleanAvatar + ')';
            avatarElement.style.backgroundSize = 'cover';
            avatarElement.style.backgroundPosition = 'center';
            avatarElement.textContent = '';
        } else {
            avatarElement.textContent = nickname.charAt(0);
        }

        var messagePreview = String(friend.lastMessage || '开始聊天吧！');

        var timeString = formatMessageTime(friend.lastMessageTime);

        var contentElement = document.createElement('span');
        contentElement.className = 'wechat-chat-content';
        var headerElement = document.createElement('span');
        headerElement.className = 'wechat-chat-header';
        var nameElement = document.createElement('span');
        nameElement.className = 'wechat-chat-name';
        nameElement.textContent = nickname;
        var timeElement = document.createElement('span');
        timeElement.className = 'wechat-chat-time';
        timeElement.textContent = timeString;
        var previewElement = document.createElement('span');
        previewElement.className = 'wechat-chat-message';
        previewElement.textContent = messagePreview;
        headerElement.appendChild(nameElement);
        headerElement.appendChild(timeElement);
        contentElement.appendChild(headerElement);
        contentElement.appendChild(previewElement);
        if (friend.unreadCount > 0) {
            var unreadElement = document.createElement('span');
            unreadElement.className = 'wechat-chat-unread';
            unreadElement.textContent = friend.unreadCount > 99 ? '99+' : String(friend.unreadCount);
            unreadElement.setAttribute('aria-label', friend.unreadCount + '条未读消息');
            avatarElement.appendChild(unreadElement);
        }
        chatItem.appendChild(avatarElement);
        chatItem.appendChild(contentElement);
        chatList.appendChild(chatItem);
    }

    async function loadChatList() {
        var chatList = document.querySelector('#wechat-page .wechat-chat-list');
        if (!chatList) return;
        var loadId = ++_chatListLoadId;
        var hydrated = true;
        chatList.dataset.ready = 'false';
        document.getElementById('wechat-search-empty')?.setAttribute('hidden', '');

        try {
            if (typeof global.ensureFriendsCacheHydrated === 'function') {
                await global.ensureFriendsCacheHydrated();
            }
        } catch (e) { hydrated = false; }
        if (loadId !== _chatListLoadId) return;

        var friends = [];
        var friendsRead = false;
        try {
            friends = loadFriendsFromStorage();
            friendsRead = Array.isArray(friends);
        } catch (e) {
            friends = [];
        }
        if (!friendsRead) return;

        if (friends.length > 0) {
            try {
                friends = await syncFriendsLastMessagePreviewsFromStorage(friends);
            } catch (e) {}
            if (loadId !== _chatListLoadId) return;
            friends = friends.map(function (friend) {
                return Object.assign({}, friend, {
                    pinned: friend.pinned || false,
                    lastMessageTime: friend.lastMessageTime || new Date().getTime(),
                    unreadCount: friend.unreadCount || 0
                });
            });
            friends.sort(function (a, b) {
                if (a.pinned && !b.pinned) return -1;
                if (!a.pinned && b.pinned) return 1;
                return b.lastMessageTime - a.lastMessageTime;
            });
        }
        if (loadId !== _chatListLoadId) return;
        var dataReady = hydrated && (typeof global.areWechatFriendsReadyForMutation !== 'function' || global.areWechatFriendsReadyForMutation());
        chatList.innerHTML = '';
        chatList.dataset.ready = String(dataReady);
        friends.forEach(function (friend) {
            addChatItem(chatList, friend);
        });
        if (dataReady && friends.length === 0) {
            var emptyState = document.createElement('div');
            emptyState.className = 'wechat-chat-empty';
            emptyState.id = 'wechat-chat-empty';
            var emptyTitle = document.createElement('p');
            emptyTitle.textContent = '暂无会话';
            var emptyHint = document.createElement('p');
            emptyHint.textContent = '添加好友，开始聊天';
            var addFriendButton = document.createElement('button');
            addFriendButton.type = 'button';
            addFriendButton.textContent = '添加好友';
            addFriendButton.onclick = function () {
                if (typeof global.openAddFriendModal === 'function') global.openAddFriendModal();
            };
            emptyState.appendChild(emptyTitle);
            emptyState.appendChild(emptyHint);
            emptyState.appendChild(addFriendButton);
            chatList.appendChild(emptyState);
        }
        var input = document.getElementById('wechat-conversation-search');
        filterWechatConversations(input ? input.value : '');
    }

    function scheduleLoadChatList() {
        if (_chatListRefreshTimer) return;
        _chatListRefreshTimer = setTimeout(function () {
            _chatListRefreshTimer = null;
            Promise.resolve(loadChatList()).catch(function () {});
        }, 120);
    }


    // ========== 批次 2：聊天页（openChat / loadChatHistory / displayMessage / sendMessage / 更多面板）==========
/** 将聊天滚动条定位到最后一条消息（页面刚显示、图片后加载等情况下需多次尝试） */
function scrollChatContentToBottom() {
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) return;
    const fid = document.getElementById('chat-page')?.dataset?.friendId;
    const requestId = ++_chatScrollRequestId;
    const run = () => {
        if (requestId !== _chatScrollRequestId || !isCurrentChatVisible(fid)) return;
        chatContent.scrollTop = chatContent.scrollHeight;
    };
    run();
    requestAnimationFrame(() => {
        requestAnimationFrame(run);
    });
    setTimeout(run, 0);
    setTimeout(run, 120);
    setTimeout(run, 400);
}

// 微信相关功能
async function openChat(contactName, friendId) {
    const openId = ++_chatOpenRequestId;
    try {
        if (typeof global.ensureFriendsCacheHydrated === 'function') {
            await global.ensureFriendsCacheHydrated();
        }
    } catch (e) {}
    if (openId !== _chatOpenRequestId) return;
    const chatPage = document.getElementById('chat-page');
    const contactNameElement = document.getElementById('chat-contact-name');
    
    // 从本地存储中获取好友信息
    const friends = loadFriendsFromStorage();
    let friend;
    
    if (friendId) {
        // 优先使用friendId查找
        friend = friends.find(f => f.id == friendId);
    } else {
        // 否则使用昵称查找
        friend = friends.find(f => f.nickname === contactName);
    }
    if (friend && typeof global.ensureChatHistoryReady === 'function') {
        try { await global.ensureChatHistoryReady(friend.id); }
        catch (e) { showNotification('聊天记录暂未加载完成，请稍后重试'); return; }
        if (openId !== _chatOpenRequestId) return;
    }
    if (contactNameElement) contactNameElement.textContent = contactName;
    
    const chatContent = document.querySelector('.chat-content');
    const renderedFriendId = chatContent ? (chatContent.dataset.renderedFriendId || '') : '';

    // 保存当前聊天的好友ID
    if (friend) {
        chatPage.dataset.friendId = friend.id;
        chatPage.dataset.isGroup = friend.isGroup ? '1' : '0';
        // 进入聊天时恢复心跳监控数据（若之前有记录）
        try { HeartbeatMonitor.restore(friend.id); } catch (e) {}
        
        // 加载聊天背景
        if (friend.chatBackground) {
            chatPage.style.backgroundImage = `url(${friend.chatBackground})`;
            chatPage.style.backgroundSize = 'cover';
            chatPage.style.backgroundPosition = 'center';
            chatPage.style.backgroundRepeat = 'no-repeat';
        } else {
            chatPage.style.backgroundImage = '';
            chatPage.style.backgroundSize = 'auto';
            chatPage.style.backgroundPosition = 'initial';
            chatPage.style.backgroundRepeat = 'repeat';
        }
    }

    applyGroupBubbleCssForCurrentChat();
    if (friend && friend.isGroup) {
        updateGroupMyAvatarDisplayIfActive(friend.id, friend.groupMyChatAvatar, friend.groupMyPersona);
    }

    // 若已渲染同一聊天内容，直接复用（避免切出再进入时重复渲染导致卡顿）
    const sameFriendAlreadyRendered =
        !!friend &&
        !!chatContent &&
        String(renderedFriendId || '') === String(friend.id) &&
        chatContent.dataset.renderedHistorySig === chatHistoryViewSignature(getChatHistoryArray(friend.id)) &&
        chatContent.children.length > 0 &&
        (!_activeChatHistoryRender || String(_activeChatHistoryRender.friendId || '') !== String(friend.id));
    
    // 导航到聊天页面（showPage 在非聊天页切入聊天时有约 500ms 过渡，过早 loadChatHistory 会因容器未显示导致无法滚到底）
    const needsPageSwitch = (global.__chatUiBridge || {}).currentPage !== 'chat';
    navigateTo('chat');
    if (typeof initMessageActionMenu === 'function') {
        try { initMessageActionMenu(); } catch (e) {}
    }

    if (sameFriendAlreadyRendered) {
        // 仅同步一次滚动与浮动按钮，不再重复 loadChatHistory
        setTimeout(() => {
            if (openId !== _chatOpenRequestId || !isCurrentChatVisible(friend.id)) return;
            scrollChatContentToBottom();
            try { updateOfflineFloatingButtonForCurrentChat(); } catch (e) {}
        }, needsPageSwitch ? 560 : 0);
        return;
    }

    // 不同聊天或未渲染过：正常渲染
    if (chatContent) {
        chatContent.innerHTML = '';
    }
    if (friend && friend.id != null) {
        _chatRenderState.set(String(friend.id), { rounds: CHAT_INITIAL_RENDER_ROUNDS });
    }
    const loadDelay = needsPageSwitch ? 550 : 0;
    setTimeout(() => {
        if (openId !== _chatOpenRequestId || !friend || !isCurrentChatVisible(friend.id)) return;
        if (friend) {
            loadChatHistory(friend.id);
        }
        showNotification(`打开与${contactName}的聊天`);
        try { updateOfflineFloatingButtonForCurrentChat(); } catch (e) {}
    }, loadDelay);
}

function applyGroupBubbleCssForCurrentChat() {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    let css = '';
    if (chatPage && friendId) {
        const friends = loadFriendsFromStorage();
        const f = friends.find(x => x.id == friendId);
        if (f && f.isGroup && typeof f.groupBubbleCss === 'string') css = f.groupBubbleCss;
    }
    let el = document.getElementById('groupchat-user-bubble-css');
    if (!el) {
        el = document.createElement('style');
        el.id = 'groupchat-user-bubble-css';
        document.head.appendChild(el);
    }
    el.textContent = css || '';
}
// ===== 性能：聊天渲染状态（默认仅渲染最近 3 轮；上滑再增量加载） =====
const CHAT_INITIAL_RENDER_ROUNDS = 3; // 初次/回收时仅渲染最近 3 轮
const CHAT_RENDER_ROUNDS_STEP = 3; // 上滑触顶每次多加载 3 轮
const CHAT_FALLBACK_RECENT_MESSAGES = 80; // 无完整轮数据时兜底最近消息条数
const CHAT_RENDER_CHUNK_SIZE = 20; // 每帧渲染条数（降低以减少单帧阻塞时间）
const _chatRenderState = new Map(); // friendId -> { rounds: number }
let _activeChatHistoryRender = null; // { id, friendId, raf }
let _bulkChatRenderCtx = null; // { renderId, friendId, friends, friendsById, friend, isGroup, showTimestamp, hideAvatar, suppressScroll }
let _batchAppendTarget = null; // 批量 append 的目标容器，null = 直接 appendChild
let _batchAppendQueue = []; // 待批量插入的 DOM 节点数组
let _chatHistoryLazyLoadBoundFriendId = null;
let _chatHistoryLazyLoadHandler = null;
let _chatHistoryLazyLoadInFlight = false;
let _chatOpenRequestId = 0;
let _chatScrollRequestId = 0;
const _chatHistoryRefreshes = new Map();

function isCurrentChatVisible(friendId) {
    const page = document.getElementById('chat-page');
    return !!(page && String(page.dataset.friendId || '') === String(friendId || '') &&
        !document.hidden && (page.classList.contains('active') || (global.__chatUiBridge || {}).currentPage === 'chat'));
}

function chatHistoryViewSignature(history) {
    const all = Array.isArray(history) ? history : [];
    const core = global.LegoProactiveCore;
    const last = core ? core.lastDialogue(all) : all[all.length - 1];
    return core ? core.signature([all.length, last]) : JSON.stringify([all.length, last]);
}

/** 只同步已保存的聊天，不调用模型。合并同一会话的通知，等待 IDB 载入后再核对画面。 */
function requestChatHistoryRefresh(friendId, options) {
    const fid = String(friendId || ''), opts = options || {};
    if (!fid || !isCurrentChatVisible(fid) || (global.__chatUiBridge || {}).isMultiselectMode) return Promise.resolve(false);
    const area = document.querySelector('.chat-content');
    if (!area) return Promise.resolve(false);
    if (opts.expectedHistorySig && area.dataset.renderedFriendId === fid && area.dataset.renderedHistorySig === opts.expectedHistorySig) return Promise.resolve(false);
    if (_chatHistoryRefreshes.has(fid)) return _chatHistoryRefreshes.get(fid);
    const pending = Promise.resolve().then(async () => {
        const history = typeof global.ensureChatHistoryReady === 'function' ? await global.ensureChatHistoryReady(fid) : getChatHistoryArray(fid);
        if (!isCurrentChatVisible(fid) || (global.__chatUiBridge || {}).isMultiselectMode) return false;
        const signature = chatHistoryViewSignature(history);
        if (area.dataset.renderedFriendId === fid && area.dataset.renderedHistorySig === signature) return false;
        if (_activeChatHistoryRender && _activeChatHistoryRender.friendId === fid && _activeChatHistoryRender.historySig === signature) return false;
        loadChatHistory(fid, { scrollToBottom: opts.scrollToBottom !== false });
        return true;
    }).catch(e => {
        console.warn('[微信] 聊天画面同步暂缓', e && e.message);
        return false;
    }).finally(() => { if (_chatHistoryRefreshes.get(fid) === pending) _chatHistoryRefreshes.delete(fid); });
    _chatHistoryRefreshes.set(fid, pending);
    return pending;
}

/** 批量插入：将节点入队，积累到一定数量时一次性 appendChild（减少 reflow） */
function batchAppend(el) {
    if (!_batchAppendTarget) {
        if (_batchAppendTarget && _batchAppendTarget.appendChild) {
            _batchAppendTarget.appendChild(el);
        }
        return;
    }
    _batchAppendQueue.push(el);
    // 每 10 个节点批量插入一次，减少单次操作的 DOM 节点数
    if (_batchAppendQueue.length >= 10) {
        const frag = document.createDocumentFragment();
        _batchAppendQueue.forEach(n => frag.appendChild(n));
        _batchAppendTarget.appendChild(frag);
        _batchAppendQueue = [];
    }
}

/** 渲染 chunk 结束时，flush 剩余节点 */
function flushBatchAppend() {
    if (!_batchAppendTarget || _batchAppendQueue.length === 0) return;
    const frag = document.createDocumentFragment();
    _batchAppendQueue.forEach(n => frag.appendChild(n));
    _batchAppendTarget.appendChild(frag);
    _batchAppendQueue = [];
}

/** 开始批量插入模式（指定目标容器） */
function startBatchAppend(container) {
    flushBatchAppend();
    _batchAppendTarget = container || _batchAppendTarget;
}

/** 结束批量插入模式，flush 剩余节点 */
function endBatchAppend() {
    flushBatchAppend();
    _batchAppendTarget = null;
}

function cancelActiveChatHistoryRender(expectedId) {
    if (expectedId && (!_activeChatHistoryRender || _activeChatHistoryRender.id !== expectedId)) return;
    if (_activeChatHistoryRender && _activeChatHistoryRender.raf) {
        try { cancelAnimationFrame(_activeChatHistoryRender.raf); } catch (e) {}
    }
    _activeChatHistoryRender = null;
    _bulkChatRenderCtx = null;
    _batchAppendQueue = [];
    _batchAppendTarget = null;
}

/** 从聊天数组提取“轮”元数据：一轮 = 用户连续消息 + 好友连续消息（跳过 system 等） */
function getChatRoundWindows(chatHistory) {
    const arr = Array.isArray(chatHistory) ? chatHistory : [];
    const rounds = [];
    let i = 0;
    while (i < arr.length) {
        if (!arr[i]) { i++; continue; }
        let start = -1;
        let end = -1;
        let userCount = 0;
        let friendCount = 0;
        while (i < arr.length && arr[i] && arr[i].type === 'user') {
            if (start === -1) start = i;
            end = i;
            userCount++;
            i++;
        }
        while (i < arr.length && arr[i] && arr[i].type === 'friend') {
            if (start === -1) start = i;
            end = i;
            friendCount++;
            i++;
        }
        if (userCount > 0 && friendCount > 0 && start >= 0 && end >= start) {
            rounds.push({ startIdx: start, endIdx: end });
        }
        while (i < arr.length && arr[i] && arr[i].type !== 'user' && arr[i].type !== 'friend') i++;
    }
    return rounds;
}

function unbindChatHistoryLazyLoad() {
    const chatContent = document.querySelector('.chat-content');
    if (chatContent && _chatHistoryLazyLoadHandler) {
        chatContent.removeEventListener('scroll', _chatHistoryLazyLoadHandler);
    }
    _chatHistoryLazyLoadHandler = null;
    _chatHistoryLazyLoadBoundFriendId = null;
    _chatHistoryLazyLoadInFlight = false;
}

function bindChatHistoryLazyLoad(friendId, totalRounds) {
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) return;
    unbindChatHistoryLazyLoad();
    _chatHistoryLazyLoadBoundFriendId = String(friendId);
    _chatHistoryLazyLoadInFlight = false;
    _chatHistoryLazyLoadHandler = function () {
        if (_chatHistoryLazyLoadInFlight) return;
        const currentFid = String(document.getElementById('chat-page')?.dataset?.friendId || '');
        if (currentFid !== _chatHistoryLazyLoadBoundFriendId) return;
        if (chatContent.scrollTop > 36) return;
        const st = _chatRenderState.get(String(friendId)) || { rounds: CHAT_INITIAL_RENDER_ROUNDS };
        const curRounds = Math.max(1, Number(st.rounds) || CHAT_INITIAL_RENDER_ROUNDS);
        if (curRounds >= totalRounds) return;
        _chatHistoryLazyLoadInFlight = true;
        const nextRounds = Math.min(totalRounds, curRounds + CHAT_RENDER_ROUNDS_STEP);
        _chatRenderState.set(String(friendId), { rounds: nextRounds });
        loadChatHistory(friendId, {
            preserveViewportOnPrepend: true,
            prevScrollTop: chatContent.scrollTop,
            prevScrollHeight: chatContent.scrollHeight
        });
        requestAnimationFrame(function () {
            _chatHistoryLazyLoadInFlight = false;
        });
    };
    chatContent.addEventListener('scroll', _chatHistoryLazyLoadHandler, { passive: true });
}

function collapseActiveChatHistoryToLatestRounds() {
    const chatPage = document.getElementById('chat-page');
    const fid = chatPage ? chatPage.dataset.friendId : null;
    if (!fid) return;
    const st = _chatRenderState.get(String(fid)) || { rounds: CHAT_INITIAL_RENDER_ROUNDS };
    const rounds = Math.max(1, Number(st.rounds) || CHAT_INITIAL_RENDER_ROUNDS);
    if (rounds <= CHAT_INITIAL_RENDER_ROUNDS) return;
    _chatRenderState.set(String(fid), { rounds: CHAT_INITIAL_RENDER_ROUNDS });
    loadChatHistory(fid, { scrollToBottom: true });
}

// 加载聊天历史记录
function loadChatHistory(friendId, options) {
    perfLog('=== 开始加载聊天历史 ===', friendId);
    
    if (!friendId) {
        perfLog('错误：缺少好友ID');
        return;
    }
    // 迟到的旧好友/隐藏页面回调不能先清空当前好友的画面。
    if (!isCurrentChatVisible(friendId)) return;
    
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) {
        perfLog('错误：未找到聊天内容容器');
        return;
    }

    const opts = options || {};
    ++_chatScrollRequestId;

    // 取消上一轮渲染任务（避免切换聊天/返回时继续卡）
    cancelActiveChatHistoryRender();
    unbindChatHistoryLazyLoad();

    // 清空现有聊天内容
    chatContent.innerHTML = '';
    try { delete chatContent.dataset.renderedFriendId; } catch (e) {}
    try { delete chatContent.dataset.renderedHistorySig; } catch (e) {}

    // 开启批量插入模式，减少 reflow
    startBatchAppend(chatContent);

    const chatHistory = getChatHistoryArray(friendId);
    const all = Array.isArray(chatHistory) ? chatHistory : [];
    const historySig = chatHistoryViewSignature(all);

    const rounds = getChatRoundWindows(all);
    const totalRounds = rounds.length;
    const st = _chatRenderState.get(String(friendId)) || { rounds: CHAT_INITIAL_RENDER_ROUNDS };
    const wantedRounds = Math.max(1, Number(st.rounds) || CHAT_INITIAL_RENDER_ROUNDS);
    const renderRounds = totalRounds > 0 ? Math.min(totalRounds, wantedRounds) : CHAT_INITIAL_RENDER_ROUNDS;
    _chatRenderState.set(String(friendId), { rounds: renderRounds });

    let startIdx = 0;
    if (totalRounds > 0) {
        const firstRound = rounds[Math.max(0, totalRounds - renderRounds)];
        startIdx = firstRound ? firstRound.startIdx : 0;
    } else {
        // 没有完整“轮”时兜底：显示最近若干条，避免空白
        startIdx = Math.max(0, all.length - CHAT_FALLBACK_RECENT_MESSAGES);
    }
    const visible = all.slice(startIdx);

    const renderId = Date.now().toString(36) + '_' + Math.random().toString(36).slice(2);
    _activeChatHistoryRender = { id: renderId, friendId: String(friendId), historySig: historySig, raf: null };

    // 预加载本聊天所需信息，供 displayMessage 复用（避免每条消息都 loadFriendsFromStorage）
    let friends = [];
    try { friends = loadFriendsFromStorage(); } catch (e) { friends = []; }
    const friend = friends.find((f) => f && f.id == friendId) || null;
    const isGroup = !!(friend && friend.isGroup);
    const friendsById = new Map(friends.map((f) => [String(f.id), f]));
    const showTimestamp = !!(friend && friend.showTimestamp);
    const hideAvatar = !!(friend && friend.hideAvatar);
    _bulkChatRenderCtx = {
        renderId,
        friendId: String(friendId),
        friends,
        friendsById,
        friend,
        isGroup,
        showTimestamp,
        hideAvatar,
        suppressScroll: true
    };

    // 顶部提示：可上滑加载更早记录
    if (startIdx > 0) {
        const more = document.createElement('div');
        more.className = 'chat-system-message chat-load-more';
        more.textContent = '上滑查看更多消息';
        chatContent.appendChild(more);
    }

    // 分批渲染：每帧渲染一小段，保证切页/点击不冻结
    let i = 0;
    const renderChunk = () => {
        // 若切走页面/切换聊天/新一轮渲染启动，则立刻停止
        if (!_activeChatHistoryRender || _activeChatHistoryRender.id !== renderId) return;
        if (!isCurrentChatVisible(friendId)) {
            cancelActiveChatHistoryRender(renderId);
            return;
        }
        // 模型返回/IDB 载入发生在两个 RAF 之间时，不能把旧快照标成最新画面。
        if (chatHistoryViewSignature(getChatHistoryArray(friendId)) !== historySig) {
            cancelActiveChatHistoryRender(renderId);
            loadChatHistory(friendId, opts);
            return;
        }
        const end = Math.min(visible.length, i + CHAT_RENDER_CHUNK_SIZE);
        for (; i < end; i++) {
            const chatItem = visible[i];
            if (!chatItem) continue;
            if (
                (chatItem.type === 'user' || chatItem.type === 'friend') &&
                chatItem.voiceCallSuppressMainChat
            ) {
                continue;
            }
            let gtq = chatItem.giftTotalQty;
            let gkc = chatItem.giftKindCount;
            if (Array.isArray(chatItem.giftItems)) {
                if (gtq == null) gtq = chatItem.giftItems.reduce((s, it) => s + (it ? (it.qty != null ? it.qty : 1) : 0), 0);
                if (gkc == null) gkc = chatItem.giftItems.length;
            }
            const childCountBefore = chatContent.children.length;
            try { displayMessage(
                chatItem.type,
                chatItem.content,
                chatItem.quote,
                chatItem.timestamp,
                friendId,
                chatItem.subtype,
                chatItem.transferStatus,
                chatItem.giftStatus,
                gtq,
                gkc,
                chatItem.speakerId,
                chatItem.forwardFrom || null,
                _bulkChatRenderCtx,
                startIdx + i
            ); } catch (e) {
                // 一条复杂消息渲染失败时保留可读正文，不能卡住整轮和后续输入。
                while (chatContent.children.length > childCountBefore) chatContent.removeChild(chatContent.lastChild);
                const row = document.createElement('div');
                row.className = 'chat-message ' + (chatItem.type === 'user' ? 'my-message' : 'other-message');
                row.dataset.messageTimestamp = String(chatItem.timestamp || '');
                row.dataset.messageIndex = String(startIdx + i);
                const body = document.createElement('div'); body.className = 'chat-message-content';
                const bubble = document.createElement('div'); bubble.className = 'chat-message-bubble';
                bubble.textContent = String(chatItem.content || ''); body.appendChild(bubble); row.appendChild(body); chatContent.appendChild(row);
                console.warn('[微信] 单条消息使用纯文字显示', e && e.message);
            }
        }
        if (i < visible.length) {
            _activeChatHistoryRender.raf = requestAnimationFrame(renderChunk);
        } else {
            perfLog('=== 聊天历史加载完成 ===', friendId, { total: all.length, rendered: visible.length, totalRounds: totalRounds, renderRounds: renderRounds });
            endBatchAppend();
            cancelActiveChatHistoryRender(renderId);
            try { chatContent.dataset.renderedFriendId = String(friendId); } catch (e) {}
            try { chatContent.dataset.renderedHistorySig = historySig; } catch (e) {}
            if (global.Wechat && Wechat.proactive) Wechat.proactive.syncUI();
            if (opts.preserveViewportOnPrepend) {
                const prevHeight = Number(opts.prevScrollHeight) || 0;
                const prevTop = Number(opts.prevScrollTop) || 0;
                const delta = chatContent.scrollHeight - prevHeight;
                chatContent.scrollTop = Math.max(0, prevTop + delta);
            } else if (opts.scrollToBottom !== false) {
                scrollChatContentToBottom();
            }
            bindChatHistoryLazyLoad(friendId, totalRounds);
        }
    };
    // 渲染完成后退出批量模式，flush 剩余节点
    _activeChatHistoryRender.raf = requestAnimationFrame(() => {
        renderChunk();
    });
}

/** 引用条在气泡内展示：来源标签 + 正文预览（含表情 URL → [表情]） */
function chatQuoteLabelForBubble(quote) {
    if (!quote || typeof quote !== 'object') return '回复';
    if (quote.type === 'user') return '我';
    if (quote.type === 'friend') return '对方';
    return '回复';
}
function chatQuoteBodyPreviewForBubble(quote) {
    if (!quote) return '';
    var s = quote.content != null ? String(quote.content) : '';
    if (typeof isChatEmojiContent === 'function' && isChatEmojiContent(s)) return '[表情]';
    if (s.length > 55) return s.substring(0, 55) + '...';
    return s;
}

/** 将引用对象放入 data-quote，避免引号/尖括号等破坏 HTML 属性或 JSON */
function encodeQuoteForDataAttribute(quote) {
    if (!quote || typeof quote !== 'object') return '';
    try {
        return encodeURIComponent(JSON.stringify(quote));
    } catch (e) {
        return '';
    }
}

function parseQuoteFromDataAttribute(el) {
    if (!el) return null;
    const raw = el.getAttribute('data-quote');
    if (raw == null || raw === '') return null;
    try {
        return JSON.parse(decodeURIComponent(raw));
    } catch (e1) {
        try {
            return JSON.parse(raw);
        } catch (e2) {
            return null;
        }
    }
}

// 显示消息。transferStatus 用于转账；giftStatus/giftTotalQty/giftKindCount 用于购物礼盒；forwardFrom 为合并转发来源 { name, friendId }
function displayMessage(
    type,
    content,
    quote = null,
    timestamp = null,
    messageFriendId = null,
    subtype = null,
    transferStatus = null,
    giftStatus = null,
    giftTotalQty = null,
    giftKindCount = null,
    speakerId = null,
    forwardFrom = null,
    renderCtx = null,
    historyArrayIndex = null
) {
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) return;
    
    // 获取当前聊天的好友ID
    const chatPage = document.getElementById('chat-page');
    const currentFriendId = chatPage ? chatPage.dataset.friendId : null;
    
    // 检查消息的好友ID是否与当前聊天的好友ID匹配
    if (messageFriendId && currentFriendId && messageFriendId != currentFriendId) {
        // 如果不匹配，只保存消息到聊天历史，不显示在当前界面
        return;
    }
    
    // 处理系统消息（包括拍一拍）
    if (type === 'system') {
        const systemMessage = document.createElement('div');
        systemMessage.className = 'chat-system-message';
        const subForSys = subtype != null ? String(subtype) : '';
        if (subForSys === 'voice_call_bundle') {
            let fidForBundle = messageFriendId || currentFriendId;
            let bundleMeta = null;
            try {
                const bh = typeof getChatHistoryArray === 'function' ? getChatHistoryArray(fidForBundle) : [];
                bundleMeta =
                    bh.find(
                        (m) =>
                            m &&
                            m.type === 'system' &&
                            String(m.subtype || '') === 'voice_call_bundle' &&
                            Number(m.timestamp) === Number(timestamp)
                    ) || null;
            } catch (eBd) {}
            const sidBm = bundleMeta && bundleMeta.voiceCallSessionId != null ? bundleMeta.voiceCallSessionId : '';
            const durBm =
                bundleMeta && bundleMeta.voiceCallDurationSec != null ? bundleMeta.voiceCallDurationSec : null;
            const summaryText = content != null ? String(content) : '';
            if (typeof buildVoiceCallEndedBundleHtml === 'function') {
                systemMessage.innerHTML = buildVoiceCallEndedBundleHtml(
                    summaryText,
                    sidBm,
                    durBm,
                    fidForBundle,
                    timestamp
                );
                systemMessage.classList.add('chat-system-message--voice-call-bundle-wrap');
            } else {
                systemMessage.textContent = summaryText || '语音通话已结束';
            }
        } else {
            systemMessage.textContent = content;
        }
        if (timestamp != null && timestamp !== undefined && !Number.isNaN(Number(timestamp))) {
            systemMessage.dataset.messageTimestamp = String(timestamp);
        }
        if (historyArrayIndex != null && historyArrayIndex !== undefined) {
            const hi = Number(historyArrayIndex);
            if (Number.isFinite(hi) && hi >= 0) {
                systemMessage.dataset.messageIndex = String(hi);
            }
        }
        chatContent.appendChild(systemMessage);
        if (!(renderCtx && renderCtx.suppressScroll)) {
            chatContent.scrollTop = chatContent.scrollHeight;
        }
        return;
    }
    
    const messageDiv = document.createElement('div');
    messageDiv.className = `chat-message ${type === 'user' ? 'my-message' : 'other-message'}`;
    
    // 工具函数：清理头像数据（占位符 __SYS_UNSET__ 等视为无头像）
    function cleanAvatarData(avatar) {
        var s = normalizeAvatarUrl(avatar);
        return s || null;
    }
    
    // 使用当前聊天的好友ID
    const friendId = currentFriendId;
    
    // 检查是否显示时间戳/隐藏头像（批量渲染时走缓存）
    let showTimestamp = false;
    let hideAvatar = false;
    /** 与当前聊天好友相关的列表，避免 user 分支内重复 loadFriendsFromStorage */
    let friendsLoadedOnce = null;
    if (renderCtx && String(renderCtx.friendId) === String(friendId)) {
        showTimestamp = !!renderCtx.showTimestamp;
        hideAvatar = !!renderCtx.hideAvatar;
    } else if (friendId) {
        friendsLoadedOnce = loadFriendsFromStorage();
        const friend = friendsLoadedOnce.find(f => f.id == friendId);
        showTimestamp = friend?.showTimestamp || false;
        hideAvatar = friend?.hideAvatar || false;
    }
    
    // 获取消息时间
    const messageDate = timestamp ? new Date(timestamp) : new Date();
    const hours = messageDate.getHours().toString().padStart(2, '0');
    const minutes = messageDate.getMinutes().toString().padStart(2, '0');
    const timeString = `${hours}:${minutes}`;
    
    if (type === 'user') {
        // 按照权重顺序获取头像：专属头像＞我的人设头像
        let userAvatar = null;
        if (friendId) {
            const friends = (renderCtx && renderCtx.friends && String(renderCtx.friendId) === String(friendId))
                ? renderCtx.friends
                : (friendsLoadedOnce != null ? friendsLoadedOnce : loadFriendsFromStorage());
            const friend = (renderCtx && renderCtx.friend && String(renderCtx.friendId) === String(friendId)) ? renderCtx.friend : friends.find(f => f.id == friendId);
            if (friend) {
                if (friend.isGroup) {
                    if (friend.groupMyChatAvatar) {
                        userAvatar = cleanAvatarData(friend.groupMyChatAvatar);
                    } else if (friend.groupMyPersona && friend.groupMyPersona.avatar) {
                        userAvatar = cleanAvatarData(friend.groupMyPersona.avatar);
                    }
                }
                // 1. 优先使用专属头像
                if (!userAvatar && friend.chatAvatar) {
                    userAvatar = cleanAvatarData(friend.chatAvatar);
                }
                // 2. 其次使用我的人设头像
                else if (!userAvatar && friend.persona && friend.persona.avatar) {
                    userAvatar = cleanAvatarData(friend.persona.avatar);
                }
            }
        }
        // 全局「我的人设 / 用户信息」回退：与情侣卡片、发现页一致，避免仅写了全局人设但 per-chat persona 为空时气泡无头像
        if (!userAvatar && typeof safeReadJsonFromStorage === 'function') {
            var _gUi = safeReadJsonFromStorage('userInfo', null);
            var _gMp = safeReadJsonFromStorage('myProfile', null);
            userAvatar = cleanAvatarData((_gUi && _gUi.avatar) || (_gMp && _gMp.avatar));
        }
        
        let quoteHtml = '';
        if (quote) {
            const quoteSender = escapeHtml(chatQuoteLabelForBubble(quote));
            const quoteContent = escapeHtml(chatQuoteBodyPreviewForBubble(quote));
            const qd = encodeQuoteForDataAttribute(quote);
            quoteHtml = `
                <div class="chat-message-quote" role="button" tabindex="0" title="查看引用原文" data-quote="${qd}">
                    <span class="quote-name">${quoteSender}</span>
                    <span class="quote-content">${quoteContent}</span>
                </div>
            `;
        }
        
        // 构建时间戳HTML
        const timestampHtml = showTimestamp ? `<div class="chat-message-timestamp">${timeString}</div>` : '';
        const forwardBannerHtml =
            forwardFrom && String(forwardFrom.name || '').trim()
                ? `<div class="chat-forward-banner">${escapeHtml('转发自：' + String(forwardFrom.name).trim())}</div>`
                : '';
        
        // 位置消息：线性地图卡片样式 | 转账消息：转账卡片样式
        let bubblesHtml;
        if (subtype === 'location') {
            const parts = String(content || '').split('\n');
            const placeName = (parts[0] || '').trim() || '位置';
            const address = (parts.slice(1).join('\n') || '').trim();
            const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            bubblesHtml = buildLocationBubbleHtml(placeName, address, esc);
        } else if (subtype === 'transfer') {
            bubblesHtml = buildTransferBubbleHtml(content || '0', transferStatus || 'pending', timestamp);
        } else if (subtype === 'gift_bundle') {
            bubblesHtml = buildGiftBundleBubbleHtml(
                timestamp,
                giftStatus || 'pending_receive',
                giftTotalQty,
                giftKindCount,
                friendId
            );
        } else if (subtype === 'photo_card') {
            bubblesHtml = buildPhotoCardBubblesHtml(content, timestamp);
        } else if (subtype === 'moments_forward_card') {
            bubblesHtml = buildMomentsForwardCardFrameHtml(content, timestamp);
        } else if (subtype === 'couple_space_invite_card' || subtype === 'couple_space_accept_card') {
            bubblesHtml = buildCoupleSpaceCardFrameHtml(content, timestamp);
        } else if (subtype === 'love_takeout_order') {
            bubblesHtml = buildLoveTakeoutCardFrameHtml(content, timestamp, friendId, 'user');
        } else if (subtype === 'voice_note_fake') {
            bubblesHtml =
                '<div class="chat-message-bubble chat-message-bubble--voice-note-fake">' +
                (typeof buildVoiceNoteFakeBubbleHtml === 'function'
                    ? buildVoiceNoteFakeBubbleHtml(content || '')
                    : mapPartsToChatMessageBubblesHtml(buildMessageBubbles(content || ''))) +
                '</div>';
        } else {
            bubblesHtml = mapPartsToChatMessageBubblesHtml(buildMessageBubbles(content));
        }

        if (!hideAvatar) {
            if (userAvatar) {
                messageDiv.innerHTML = `
                    <div class="chat-message-content">
                        ${forwardBannerHtml}
                        ${bubblesHtml}
                        ${quoteHtml}
                        ${timestampHtml}
                    </div>
                    <div class="chat-message-avatar" style="background-image: url('${userAvatar}'); background-size: cover; background-position: center;"></div>
                `;
            } else {
                messageDiv.innerHTML = `
                    <div class="chat-message-content">
                        ${forwardBannerHtml}
                        ${bubblesHtml}
                        ${quoteHtml}
                        ${timestampHtml}
                    </div>
                    <div class="chat-message-avatar transparent-avatar"></div>
                `;
            }
        } else {
            messageDiv.innerHTML = `
                <div class="chat-message-content">
                    ${forwardBannerHtml}
                    ${bubblesHtml}
                    ${quoteHtml}
                    ${timestampHtml}
                </div>
            `;
        }
    } else {
        const friends = loadFriendsFromStorage();
        const currentChat = friends.find(f => f.id == friendId);
        const isGroupChat = !!(currentChat && currentChat.isGroup);
        let friend = currentChat;
        if (isGroupChat) {
            if (speakerId != null && String(speakerId) !== '') {
                friend =
                    typeof resolveGroupChatSpeakerMember === 'function'
                        ? resolveGroupChatSpeakerMember(speakerId, currentChat, friends)
                        : friends.find(f => String(f.id) === String(speakerId)) || null;
            } else {
                friend = null;
            }
        }
        // 使用批量渲染上下文中的好友数据，避免重复加载
        if (renderCtx && String(renderCtx.friendId) === String(friendId)) {
            const friendsFromCtx = renderCtx.friends || friends;
            const currentChatFromCtx = renderCtx.friend || currentChat;
            if (isGroupChat && speakerId != null && String(speakerId) !== '') {
                friend = typeof resolveGroupChatSpeakerMember === 'function'
                    ? resolveGroupChatSpeakerMember(speakerId, currentChatFromCtx, friendsFromCtx)
                    : friendsFromCtx.find(f => String(f.id) === String(speakerId)) || null;
            }
        }
        const displaySpeakerName = isGroupChat
            ? (friend ? (((friend.remark || friend.nickname) || '').trim() || '成员') : '群成员')
            : '';
        const nameHtml = isGroupChat ? `<div class="chat-message-name">${escapeHtml(displaySpeakerName)}</div>` : '';
        
        let quoteHtml = '';
        if (quote) {
            const quoteSender = escapeHtml(chatQuoteLabelForBubble(quote));
            const quoteContent = escapeHtml(chatQuoteBodyPreviewForBubble(quote));
            const qd = encodeQuoteForDataAttribute(quote);
            quoteHtml = `
                <div class="chat-message-quote" role="button" tabindex="0" title="查看引用原文" data-quote="${qd}">
                    <span class="quote-name">${quoteSender}</span>
                    <span class="quote-content">${quoteContent}</span>
                </div>
            `;
        }
        
        // 构建时间戳HTML
        const timestampHtml = showTimestamp ? `<div class="chat-message-timestamp">${timeString}</div>` : '';
        
        // 位置消息：线性地图卡片样式 | 转账消息：转账卡片样式
        let bubblesHtml;
        if (subtype === 'location') {
            const parts = String(content || '').split('\n');
            const placeName = (parts[0] || '').trim() || '位置';
            const address = (parts.slice(1).join('\n') || '').trim();
            const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
            bubblesHtml = buildLocationBubbleHtml(placeName, address, esc);
        } else if (subtype === 'transfer') {
            bubblesHtml = buildTransferBubbleHtml(content || '0', transferStatus || 'pending', timestamp);
        } else if (subtype === 'friend_transfer') {
            let friendTransferStatus = 'pending';
            try {
                const h = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
                const m = h.find(x => x.type === 'friend' && x.subtype === 'friend_transfer' && Number(x.timestamp) === Number(timestamp));
                if (m && m.transferStatus) friendTransferStatus = m.transferStatus;
            } catch (_) {}
            bubblesHtml = buildFriendTransferBubbleHtml(content || '0', '', timestamp, friendTransferStatus);
        } else if (subtype === 'redpacket') {
            let friendId = currentFriendId;
            try {
                bubblesHtml = buildFriendRedpacketBubbleHtml(content || '0', timestamp, friendId);
            } catch (_) {
                bubblesHtml = `<div class="chat-message-bubble">[微信红包]</div>`;
            }
        } else if (subtype === 'gift_bundle') {
            bubblesHtml = buildGiftBundleBubbleHtml(
                timestamp,
                giftStatus || 'pending_receive',
                giftTotalQty,
                giftKindCount,
                friendId
            );
        } else if (subtype === 'photo_card') {
            bubblesHtml = buildPhotoCardBubblesHtml(content, timestamp);
        } else if (subtype === 'moments_forward_card') {
            bubblesHtml = buildMomentsForwardCardFrameHtml(content, timestamp);
        } else if (subtype === 'couple_space_invite_card' || subtype === 'couple_space_accept_card') {
            bubblesHtml = buildCoupleSpaceCardFrameHtml(content, timestamp);
        } else if (subtype === 'love_takeout_order') {
            bubblesHtml = buildLoveTakeoutCardFrameHtml(content, timestamp, friendId, 'friend');
        } else if (subtype === 'voice_note_fake') {
            bubblesHtml =
                '<div class="chat-message-bubble chat-message-bubble--voice-note-fake">' +
                (typeof buildVoiceNoteFakeBubbleHtml === 'function'
                    ? buildVoiceNoteFakeBubbleHtml(content || '')
                    : mapPartsToChatMessageBubblesHtml(buildMessageBubbles(content || '', {
                        collapsibleTranslation: !!(friend && String(friend.outputLanguage || 'zh') !== 'zh')
                    }))) +
                '</div>';
        } else {
            bubblesHtml = mapPartsToChatMessageBubblesHtml(buildMessageBubbles(content, {
                collapsibleTranslation: !!(friend && String(friend.outputLanguage || 'zh') !== 'zh')
            }));
        }

        if (!hideAvatar) {
            // 好友头像优先级：显式设置的头像 > 角色卡(persona)中的头像；无图时用首字占位（避免群聊误匹配时整块空白）
            const friendAvatarSrc = friend
                ? (typeof getFriendDisplayAvatar === 'function'
                    ? getFriendDisplayAvatar(friend)
                    : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || ''))
                : null;
            const initialChar = (() => {
                const s = String(displaySpeakerName || (friend && (friend.remark || friend.nickname)) || '').trim();
                if (!s) return '?';
                try {
                    const arr = Array.from(s);
                    return arr[0] || '?';
                } catch (e) {
                    return s.charAt(0) || '?';
                }
            })();
            const initialHtml = escapeHtml(initialChar);
            if (friend && friendAvatarSrc) {
                const cleanAvatar = friendAvatarSrc;
                messageDiv.innerHTML = `
                    <div class="chat-message-avatar" style="background-image: url('${cleanAvatar}'); background-size: cover; background-position: center;"></div>
                    <div class="chat-message-content">
                        ${nameHtml}
                        ${bubblesHtml}
                        ${quoteHtml}
                        ${timestampHtml}
                    </div>
                `;
            } else if (friend) {
                messageDiv.innerHTML = `
                    <div class="chat-message-avatar chat-message-avatar-letter" aria-hidden="true">${initialHtml}</div>
                    <div class="chat-message-content">
                        ${nameHtml}
                        ${bubblesHtml}
                        ${quoteHtml}
                        ${timestampHtml}
                    </div>
                `;
            } else {
                messageDiv.innerHTML = `
                    <div class="chat-message-avatar chat-message-avatar-letter chat-message-avatar-letter--unknown" aria-hidden="true">?</div>
                    <div class="chat-message-content">
                        ${nameHtml}
                        ${bubblesHtml}
                        ${quoteHtml}
                        ${timestampHtml}
                    </div>
                `;
            }
        } else {
            messageDiv.innerHTML = `
                <div class="chat-message-content">
                    ${nameHtml}
                    ${bubblesHtml}
                    ${quoteHtml}
                    ${timestampHtml}
                </div>
            `;
        }
    }
    
    if (timestamp != null && timestamp !== undefined && !Number.isNaN(Number(timestamp))) {
        messageDiv.dataset.messageTimestamp = String(timestamp);
    }
    if (historyArrayIndex != null && historyArrayIndex !== undefined) {
        const hi = Number(historyArrayIndex);
        if (Number.isFinite(hi) && hi >= 0) {
            messageDiv.dataset.messageIndex = String(hi);
        }
    }

    if (type === 'friend' && messageFriendId && timestamp != null) {
        const history = getChatHistoryArray(messageFriendId);
        const last = history[history.length - 1];
        const saved = Number.isInteger(historyArrayIndex) ? history[historyArrayIndex] :
            last && Number(last.timestamp) === Number(timestamp) ? last :
                history.find(m => Number(m.timestamp) === Number(timestamp) && m.type === 'friend');
        if (saved && saved.proactiveEmotion) {
            const details = document.createElement('details');
            details.className = 'proactive-emotion';
            const summary = document.createElement('summary');
            summary.textContent = '此刻的心绪';
            const body = document.createElement('p');
            body.textContent = saved.proactiveEmotion;
            details.appendChild(summary);
            details.appendChild(body);
            (messageDiv.querySelector('.chat-message-content') || messageDiv).appendChild(details);
        }
    }
    chatContent.appendChild(messageDiv);
    // 拍立得专属处理：普通文字/转账/红包消息不需要这两个函数调用
    if (subtype === 'photo_card' || subtype === 'moments_forward_card') {
        normalizeWechatPolaroidDom(messageDiv);
        attachWechatPolaroidImgGuards(messageDiv);
    }
    // 接收消息批量渲染时不在此滚动（由外层 RAF 批次统一滚底）
    // 使用 _batchAppendTarget 判断是否在批量渲染模式中
    if (!_batchAppendTarget && !(global.__chatUiBridge || {}).isReceiving) {
        requestAnimationFrame(function () {
            try {
                chatContent.scrollTop = chatContent.scrollHeight;
            } catch (e) {}
        });
    }
    // 为聊天气泡添加事件：手机端长按、电脑端右键唤起菜单；多选模式下点击切换选择
    const bubbles = messageDiv.querySelectorAll('.chat-message-bubble, .chat-moments-forward-surface, .chat-couple-space-surface');
    const quoteCard = messageDiv.querySelector('.chat-message-quote');
    if (quoteCard) {
        const openQuoteDetail = function() {
            if (typeof openChatQuoteDetailModal !== 'function') return;
            const q = parseQuoteFromDataAttribute(quoteCard);
            if (q) openChatQuoteDetailModal(q);
        };
        quoteCard.addEventListener('click', function(e) {
            e.stopPropagation();
            openQuoteDetail();
        });
        quoteCard.addEventListener('keydown', function(e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            e.preventDefault();
            e.stopPropagation();
            openQuoteDetail();
        });
    }
    bubbles.forEach(function(bubble) {
        // 多选模式：点击切换选择状态
        bubble.addEventListener('click', function(e) {
            // 仿语音条内部的展开按钮需冒泡到 #chat-page，由 wechat-voice-call.js 委托处理；在此处 stopPropagation 会拦截导致无法展开
            if (!(global.__chatUiBridge || {}).isMultiselectMode) {
                if (e.target.closest && e.target.closest('.wechat-voice-note-toggle')) {
                    return;
                }
            }
            e.stopPropagation();
            if ((global.__chatUiBridge || {}).isMultiselectMode) {
                const messageIndex = parseInt(messageDiv.dataset.messageIndex) || 0;
                toggleMessageSelection(messageIndex);
            }
        });
        // 电脑端：鼠标右键唤起菜单
        bubble.addEventListener('contextmenu', function(e) {
            e.preventDefault();
            e.stopPropagation();
            if (!(global.__chatUiBridge || {}).isMultiselectMode) {
                showMessageActionMenu(e, messageDiv);
            }
        });
        // 手机端：长按唤起菜单
        let longPressTimer = null;
        let longPressBubble = null;
        bubble.addEventListener('touchstart', function(e) {
            if ((global.__chatUiBridge || {}).isMultiselectMode) return;
            longPressBubble = bubble;
            longPressTimer = setTimeout(function() {
                longPressTimer = null;
                const syntheticEvent = { target: longPressBubble };
                showMessageActionMenu(syntheticEvent, messageDiv);
            }, 500);
        }, { passive: true });
        bubble.addEventListener('touchend', function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            longPressBubble = null;
        }, { passive: true });
        bubble.addEventListener('touchmove', function() {
            if (longPressTimer) {
                clearTimeout(longPressTimer);
                longPressTimer = null;
            }
            longPressBubble = null;
        }, { passive: true });
    });
}
// 发送消息（独立调用入口，与发送按钮 handler 逻辑同步）
function sendMessage() {
    const chatInput = document.getElementById('chat-input');
    const message = chatInput.value.trim();
    if (!message) return;
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) return;

    // 黑名单检查（只读）
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);
    if (friend && friend.blacklisted) {
        showNotification('请先解除黑名单');
        return;
    }

    // 引用消息
    let quote = null;
    const quoteFrame = document.getElementById('chat-quote-frame');
    const _qb = global.__chatUiBridge;
    if (quoteFrame && quoteFrame.classList.contains('show') && _qb && _qb.currentQuoteMessage != null) {
        quote = _qb.currentQuoteMessage;
        quoteFrame.classList.remove('show');
        _qb.currentQuoteMessage = null;
    }

    // 清空输入（同步，用户立刻看到）
    chatInput.value = '';

    // displayMessage + saveChatMessage defer，让浏览器先完成当前帧渲染
    // 额外检查：如果 loadChatHistory 正在对本好友进行首帧渲染，等它完成后再 append
    // 否则 loadChatHistory 的 innerHTML='' 会把用户消息冲掉
    const _fid = friendId;
    const _msg = message;
    const _quote = quote;
    const run = function () {
        const ts = new Date().getTime();
        // 等 loadChatHistory 首帧渲染完再 append（_activeChatHistoryRender 非空表示正在渲染）
        if (_activeChatHistoryRender && String(_activeChatHistoryRender.friendId) === String(_fid)) {
            requestAnimationFrame(run);
            return;
        }
        displayMessage('user', _msg, _quote, ts);
        saveChatMessage(_fid, 'user', _msg, _quote, ts);
    };
    requestAnimationFrame(run);
}
// 切换更多功能面板
function toggleMorePanel() {
    if (typeof closeEmojiPanel === 'function') closeEmojiPanel();
    const morePanel = document.getElementById('chat-more-panel');
    const chatContent = document.querySelector('.chat-content');
    if (morePanel) {
        const isOpening = !morePanel.classList.contains('show');
        morePanel.classList.toggle('show');
        if (chatContent) {
            if (isOpening) {
                chatContent.classList.add('more-panel-open');
                requestAnimationFrame(() => {
                    chatContent.scrollTop = chatContent.scrollHeight;
                });
            } else {
                chatContent.classList.remove('more-panel-open');
            }
        }
    }
}

// 关闭更多功能面板
function closeMorePanel() {
    const morePanel = document.getElementById('chat-more-panel');
    const chatContent = document.querySelector('.chat-content');
    if (morePanel) morePanel.classList.remove('show');
    if (chatContent) chatContent.classList.remove('more-panel-open');
}
// 更多功能项点击
function onMoreItemClick(action) {
    closeMorePanel();
    /** 语音电话中：仅允许用文字输入框发纯文字；此处拦截非文字类入口 */
    var _vcBlock = {
        transfer: 1,
        pat: 1,
        gift: 1,
        photos: 1,
        camera: 1,
        location: 1,
        listen: 1,
        voice: 1,
        video: 1,
        offline: 1,
        summary: 1,
        redoReply: 1
    };
    if (
        _vcBlock[action] &&
        typeof isVoicePhoneCallActive === 'function' &&
        isVoicePhoneCallActive()
    ) {
        showNotification('语音通话中仅可发送文字消息');
        return;
    }
    const actions = {
        location: '位置',
        summary: '总结',
        offline: '线下模式',
        gift: '礼物',
        photos: '照片',
        camera: '拍摄',
        voice: '语音通话',
        video: '视频通话',
        transfer: '转账',
        pat: '拍一拍'
    };
    const name = actions[action] || action;
    if (action === 'transfer') {
        openTransferModal();
    } else if (action === 'pat') {
        patPat();
    } else if (action === 'redoReply') {
        redoFriendReply();
    } else if (action === 'listen') {
        openListenTogetherIsland();
    } else if (action === 'location') {
        openLocationModal();
    } else if (action === 'photos') {
        openPhotoCardModal();
    } else if (action === 'camera') {
        openChatCameraModal();
    } else if (action === 'gift') {
        openChatGiftShelf();
    } else if (action === 'offline') {
        // 线下模式相关函数定义在 wechat-ui-extras.js，若该脚本因弱网/缓存未加载完成则整体降级并提示，避免抛出未定义错误
        if (typeof isOfflineModeEnabled !== 'function' || typeof openOfflineModeModal !== 'function') {
            showNotification('线下模式功能加载失败，请刷新页面后重试');
            return;
        }
        const fid = _getCurrentChatFriendId();
        if (fid && isOfflineModeEnabled(fid)) {
            const ok = window.confirm('当前处于线下模式。\n\n是否退出线下模式，回到线上对白聊天模式？');
            if (ok) {
                const s = _getOfflineSettingsForFriend(fid);
                s.enabled = false;
                _saveOfflineSettingsForFriend(fid, s);
                if (typeof updateOfflineFloatingButtonForCurrentChat === 'function') updateOfflineFloatingButtonForCurrentChat();
                showNotification('已退出线下模式');
            }
        } else {
            openOfflineModeModal();
        }
    } else if (action === 'summary') {
        openChatLongMemoryModal();
    } else if (action === 'voice') {
        if (typeof openVoiceFeatureChoiceModal === 'function') {
            openVoiceFeatureChoiceModal();
        } else {
            showNotification('语音模块未加载，请刷新页面');
        }
    } else {
        showNotification(name + ' 功能开发中');
    }
}

    function getChatListViewportForSelectors(friendId) {
        var all = getChatHistoryArray(friendId);
        var arr = Array.isArray(all) ? all : [];
        var rounds = getChatRoundWindows(arr);
        var totalRounds = rounds.length;
        var st = _chatRenderState.get(String(friendId)) || { rounds: CHAT_INITIAL_RENDER_ROUNDS };
        var wantRounds = Math.max(1, Number(st.rounds) || CHAT_INITIAL_RENDER_ROUNDS);
        var renderRounds = totalRounds > 0 ? Math.min(totalRounds, wantRounds) : CHAT_INITIAL_RENDER_ROUNDS;
        var startIdx = 0;
        if (totalRounds > 0) {
            var firstRound = rounds[Math.max(0, totalRounds - renderRounds)];
            startIdx = firstRound ? firstRound.startIdx : 0;
        } else {
            startIdx = Math.max(0, arr.length - CHAT_FALLBACK_RECENT_MESSAGES);
        }
        var visibleCount = Math.max(0, arr.length - startIdx);
        return { startIdx: startIdx, limit: visibleCount, total: arr.length };
    }

    function isActiveChatHistoryRenderingForFriend(friendId) {
        return !!(_activeChatHistoryRender && String(_activeChatHistoryRender.friendId) === String(friendId));
    }

    function initWechatUiDom() {
        if (_wechatUiDomReady) return;
        _wechatUiDomReady = true;

        document.addEventListener('click', function (e) {
            var addMenu = document.getElementById('wechat-add-menu');
            var addButton = document.getElementById('wechat-add-trigger');
            if (
                addMenu &&
                addMenu.classList.contains('show') &&
                !addMenu.contains(e.target) &&
                addButton &&
                !addButton.contains(e.target)
            ) {
                closeWechatAddMenu();
            }
        });
        document.addEventListener('keydown', function (e) {
            if (e.key !== 'Escape') return;
            var addMenu = document.getElementById('wechat-add-menu');
            if (addMenu && addMenu.classList.contains('show')) {
                closeWechatAddMenu();
                document.getElementById('wechat-add-trigger')?.focus();
            }
        });

        // 回到输入框时，自动收敛到最近 3 轮（隐藏更早记录，保持聊天顺滑）
        var chatInput = document.getElementById('chat-input');
        if (chatInput) {
            var collapseFn = function () {
                collapseActiveChatHistoryToLatestRounds();
            };
            chatInput.addEventListener('focus', collapseFn);
            chatInput.addEventListener('click', collapseFn);
            chatInput.addEventListener('touchstart', collapseFn, { passive: true });
        }
    }

    var W = global.Wechat;
    if (W && typeof W.init === 'function') {
        var prevInit = W.init;
        W.init = function () {
            prevInit.call(W);
            initWechatUiDom();
        };
    } else {
        initWechatUiDom();
    }

    var ui = {
        version: '0.2.0-ui2',
        showWechatSearch: showWechatSearch,
        closeWechatSearch: closeWechatSearch,
        filterWechatConversations: filterWechatConversations,
        showWechatAdd: showWechatAdd,
        toggleWechatAddMenu: toggleWechatAddMenu,
        closeWechatAddMenu: closeWechatAddMenu,
        showWechatMessages: showWechatMessages,
        showWechatDiscover: showWechatDiscover,
        showWechatMe: showWechatMe,
        closeWechatSettingsPage: closeWechatSettingsPage,
        formatMessageTime: formatMessageTime,
        loadChatList: loadChatList,
        scheduleLoadChatList: scheduleLoadChatList,
        scrollChatContentToBottom: scrollChatContentToBottom,
        openChat: openChat,
        applyGroupBubbleCssForCurrentChat: applyGroupBubbleCssForCurrentChat,
        loadChatHistory: loadChatHistory,
        cancelActiveChatHistoryRender: cancelActiveChatHistoryRender,
        displayMessage: displayMessage,
        sendMessage: sendMessage,
        toggleMorePanel: toggleMorePanel,
        closeMorePanel: closeMorePanel,
        onMoreItemClick: onMoreItemClick,
        getChatListViewportForSelectors: getChatListViewportForSelectors,
        isActiveChatHistoryRenderingForFriend: isActiveChatHistoryRenderingForFriend,
        requestChatHistoryRefresh: requestChatHistoryRefresh
    };

    global.Wechat = global.Wechat || {};
    global.Wechat.ui = Object.assign({}, global.Wechat.ui || {}, ui);

    global.showWechatSearch = showWechatSearch;
    global.closeWechatSearch = closeWechatSearch;
    global.filterWechatConversations = filterWechatConversations;
    global.showWechatAdd = showWechatAdd;
    global.toggleWechatAddMenu = toggleWechatAddMenu;
    global.closeWechatAddMenu = closeWechatAddMenu;
    global.showWechatMessages = showWechatMessages;
    global.showWechatDiscover = showWechatDiscover;
    global.showWechatMe = showWechatMe;
    global.closeWechatSettingsPage = closeWechatSettingsPage;
    global.formatMessageTime = formatMessageTime;
    global.loadChatList = loadChatList;
    global.scheduleLoadChatList = scheduleLoadChatList;
    global.scrollChatContentToBottom = scrollChatContentToBottom;
    global.openChat = openChat;
    global.applyGroupBubbleCssForCurrentChat = applyGroupBubbleCssForCurrentChat;
    global.loadChatHistory = loadChatHistory;
    global.cancelActiveChatHistoryRender = cancelActiveChatHistoryRender;
    global.displayMessage = displayMessage;
    global.sendMessage = sendMessage;
    global.toggleMorePanel = toggleMorePanel;
    global.closeMorePanel = closeMorePanel;
    global.onMoreItemClick = onMoreItemClick;
})(typeof window !== 'undefined' ? window : globalThis);
