/**
 * Lego 小手机 · 微信聊天管线（从 app.js 迁出）
 * 含：send/receive 绑定、saveChatMessage 与预览/转账/礼物解析、内置相机、表情面板、
 * 消息长按菜单与多选/转发/收藏选中/删除/回溯/编辑等。
 * 依赖 app.js、wechat-ui.js、wechat-store；须在 wechat-ui.js 之后加载。
 */

// —— 好友列表预览批量刷新（自 app.js 迁入）——
let _friendUpdateFlushTimer = null;
/** 按好友 id 合并待写回，避免同一 macrotask 内多个会话各发一条时互相覆盖只保留最后一个 */
let __pendingFriendUpdates = Object.create(null);
/** 防抖计数器：连续更新时延长等待时间，避免频繁写入 */
let _friendUpdateDebounceCount = 0;

function flushPendingFriendListMeta() {
    _friendUpdateFlushTimer = null;
    _friendUpdateDebounceCount = 0;
    const pending = __pendingFriendUpdates;
    __pendingFriendUpdates = Object.create(null);
    const ids = Object.keys(pending);
    if (ids.length === 0) return;
    void (async function () {
        try {
            if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
        } catch (e) {}
        try {
            const friends = loadFriendsFromStorage();
            const updatedFriends = friends.map((friend) => {
                const fid = String(friend.id);
                const p = pending[fid];
                if (!p) return friend;
                const ft = p.type;
                const ts = p.timestamp;
                const fc = p.content;
                const fs = p.subtype;
                let preview = fc != null ? buildChatListPreviewForLastMessage(ft, fc, fs) : '';
                if (!preview && (ft === 'friend' || ft === 'user')) preview = '[消息]';
                if (ft === 'friend') {
                    return {
                        ...friend,
                        lastMessageTime: ts,
                        lastMessage: preview,
                        lastMessageType: ft,
                        unreadCount: (friend.unreadCount || 0) + 1
                    };
                }
                return { ...friend, lastMessageTime: ts, lastMessage: preview, lastMessageType: ft };
            });
            saveFriendsToStorageDebounced(updatedFriends);
            scheduleLoadChatList();
        } catch (e) {}
        if (Object.keys(__pendingFriendUpdates).length > 0) {
            _friendUpdateFlushTimer = setTimeout(flushPendingFriendListMeta, 0);
        }
    })();
}

function chatMessageContentsMatch(stored, domOrOther) {
    if (stored === domOrOther) return true;
    if (stored == null || domOrOther == null) return false;
    if (isChatEmojiContent(stored) && isChatEmojiContent(domOrOther)) {
        return normalizeChatMediaUrl(stored) === normalizeChatMediaUrl(domOrOther);
    }
    return false;
}

/**
 * 持久化/渲染用引用快照：必须可 JSON 序列化，且含 type 供气泡内显示「我/对方」。
 */
function buildChatQuoteSnapshot(m) {
    if (!m || typeof m !== 'object') return null;
    const t = m.type;
    if (t !== 'user' && t !== 'friend') return null;
    let c = m.content;
    if (c == null) c = '';
    c = typeof c === 'string' ? c : String(c);
    if (!c.trim()) return null;
    const ts = Number(m.timestamp);
    return {
        type: t,
        content: c,
        timestamp: !Number.isNaN(ts) ? ts : Date.now()
    };
}

/** 语音电话中好友回复：去掉表情占位与表情包 URL，仅保留可作口语的文字 */
function sanitizeFriendVoiceCallPlainText(s) {
    let t = s == null ? '' : String(s);
    t = t.replace(/\[发送表情:[^\]\n]+\]/g, '').replace(/\[\s*发送\s*表情\s*:[^\]\n]+\]/g, '');
    t = t.replace(/https?:\/\/[^\s<>"']+|data:image\/[^\s<>"']+/gi, (url) =>
        typeof isChatEmojiContent === 'function' && isChatEmojiContent(url) ? '' : url
    );
    return t.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function formatQuotePreviewForInputBar(msg) {
    if (!msg || typeof msg !== 'object') return '';
    let c = msg.content;
    if (c == null) c = '';
    c = typeof c === 'string' ? c : String(c);
    if (typeof isChatEmojiContent === 'function' && isChatEmojiContent(c)) return '[表情]';
    if (c.length > 55) return c.substring(0, 55) + '...';
    return c;
}

function quoteSenderLabelForInputBar(msg) {
    if (!msg || typeof msg !== 'object') return '引用';
    if (msg.type === 'user') return '我';
    if (msg.type === 'friend') return '对方';
    if (msg.type === 'system') return '系统';
    return '回复';
}

function openChatQuoteDetailModal(quote) {
    if (!quote || typeof quote !== 'object') return;
    const modal = document.getElementById('chat-quote-detail-modal');
    const nameEl = document.getElementById('chat-quote-detail-name');
    const contentEl = document.getElementById('chat-quote-detail-content');
    if (!modal || !nameEl || !contentEl) return;
    nameEl.textContent = quoteSenderLabelForInputBar(quote);
    let content = quote.content;
    if (content == null) content = '';
    content = typeof content === 'string' ? content : String(content);
    if (typeof isChatEmojiContent === 'function' && isChatEmojiContent(content)) {
        content = '[表情]\n' + content;
    }
    contentEl.textContent = content;
    modal.classList.add('show');
}

function closeChatQuoteDetailModal() {
    const modal = document.getElementById('chat-quote-detail-modal');
    if (modal) modal.classList.remove('show');
}

function showMessageActionMenu(event, messageElement) {
    const menu = document.getElementById('message-action-menu');
    if (!menu) return;
    
    // 隐藏之前的菜单
    menu.classList.remove('show');
    
    // 获取当前聊天的好友ID
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    
    // 存储当前消息信息（用于回溯和引用功能）
    if (friendId) {
        // 确保获取到聊天气泡元素
        let bubble = event.target;
        // 如果点击的不是聊天气泡，向上查找
        while (bubble && !bubble.classList.contains('chat-message-bubble')) {
            bubble = bubble.parentElement;
        }
        
        if (bubble) {
            const chatHistory = getChatHistoryArray(friendId);
            const row = bubble.closest('.chat-message');
            const idxAttr = row && row.dataset.messageIndex;
            let message = null;
            if (idxAttr != null && idxAttr !== '') {
                const idx = parseInt(idxAttr, 10);
                if (!Number.isNaN(idx) && idx >= 0 && idx < chatHistory.length) {
                    message = chatHistory[idx];
                }
            }
            const tsAttr = row && row.dataset.messageTimestamp;
            if (!message && tsAttr != null && tsAttr !== '') {
                const t = Number(tsAttr);
                const sameTs = chatHistory.filter(m => Number(m.timestamp) === t);
                if (sameTs.length === 1) {
                    message = sameTs[0];
                } else if (sameTs.length > 1) {
                    let messageText = bubble.textContent.trim();
                    const imgElement = bubble.querySelector('img.chat-emoji');
                    if (imgElement) {
                        messageText = imgElement.src;
                    }
                    for (let j = sameTs.length - 1; j >= 0; j--) {
                        const historyContent = sameTs[j].content;
                        if (historyContent === messageText || chatMessageContentsMatch(historyContent, messageText)) {
                            message = sameTs[j];
                            break;
                        }
                    }
                    if (!message) {
                        message = sameTs[sameTs.length - 1];
                    }
                }
            }
            if (!message) {
                let messageText = bubble.textContent.trim();
                const imgElement = bubble.querySelector('img.chat-emoji');
                if (imgElement) {
                    messageText = imgElement.src;
                }
                for (let i = chatHistory.length - 1; i >= 0; i--) {
                    const historyContent = chatHistory[i].content;
                    if (historyContent === messageText || chatMessageContentsMatch(historyContent, messageText)) {
                        message = chatHistory[i];
                        break;
                    }
                }
            }
            if (message) {
                currentBacktrackMessage = message;
                currentBacktrackFriendId = friendId;
                currentQuoteMessage = message;
                currentEditMessage = message;
                currentEditFriendId = friendId;
                let resolvedIdx = null;
                if (idxAttr != null && idxAttr !== '') {
                    const pi = parseInt(idxAttr, 10);
                    if (
                        !Number.isNaN(pi) &&
                        pi >= 0 &&
                        pi < chatHistory.length &&
                        chatHistory[pi] === message
                    ) {
                        resolvedIdx = pi;
                    }
                }
                if (resolvedIdx == null) {
                    const io = chatHistory.indexOf(message);
                    resolvedIdx = io >= 0 ? io : null;
                }
                currentEditMessageIndex = resolvedIdx;
                currentBacktrackMessageIndex = resolvedIdx;
            } else {
                currentBacktrackMessage = null;
                currentBacktrackFriendId = null;
                currentBacktrackMessageIndex = null;
                currentQuoteMessage = null;
                currentEditMessage = null;
                currentEditFriendId = null;
                currentEditMessageIndex = null;
            }
        }
    }
    
    // 计算菜单位置
    let bubbleRect;
    // 确保使用正确的聊天气泡元素
    let targetBubble = event.target;
    while (targetBubble && !targetBubble.classList.contains('chat-message-bubble')) {
        targetBubble = targetBubble.parentElement;
    }
    if (targetBubble) {
        bubbleRect = targetBubble.getBoundingClientRect();
    } else {
        bubbleRect = event.target.getBoundingClientRect();
    }
    const chatContentRect = document.querySelector('.chat-content').getBoundingClientRect();
    
    // 计算菜单居中位置
    let left = bubbleRect.left - chatContentRect.left + (bubbleRect.width / 2) - 165; // 330px / 2 = 165
    let top = bubbleRect.bottom - chatContentRect.top + 10; // 总是显示在气泡下方
    
    // 调整位置，确保菜单在可视范围内
    if (left < 0) {
        left = 0;
    }
    if (left + 330 > chatContentRect.width) {
        left = chatContentRect.width - 330;
    }
    
    menu.style.left = left + 'px';
    menu.style.top = top + 'px';
    menu.classList.add('show');
    
    // 点击或右键其他地方关闭菜单
    setTimeout(() => {
        document.addEventListener('click', closeMessageActionMenu);
        document.addEventListener('contextmenu', closeMessageActionMenu);
    }, 100);
}

// 关闭消息操作菜单
function closeMessageActionMenu() {
    const menu = document.getElementById('message-action-menu');
    if (menu) {
        menu.classList.remove('show');
    }
    document.removeEventListener('click', closeMessageActionMenu);
    document.removeEventListener('contextmenu', closeMessageActionMenu);
}

// 存储当前操作的消息信息
let currentBacktrackMessage = null;
let currentBacktrackFriendId = null;
let currentBacktrackMessageIndex = null;

// 存储当前引用的消息信息
let currentQuoteMessage = null;

// 存储当前编辑的消息信息
let currentEditMessage = null;
let currentEditFriendId = null;
/** 与 DOM .chat-message[data-message-index] 一致，供 confirmEditMessage 在「同 timestamp 多条」时唯一对应 */
let currentEditMessageIndex = null;

// 存储多选模式状态
let isMultiselectMode = false;
let selectedMessages = new Set();
let currentMultiselectFriendId = null;

// 多选转发：待发送的聊天记录副本、已选接收好友 id（字符串）
let pendingForwardMessages = [];
/** 转发来源会话（当前多选所在聊天），用于写入「转发自 xxx」 */
let pendingForwardSourceMeta = null;
let forwardTargetFriendIds = new Set();

// 发起群聊：已选好友 id（字符串）
let groupchatSelectedFriendIds = new Set();

// 消息操作功能
function initMessageActionMenu() {
    const menu = document.getElementById('message-action-menu');
    if (!menu) return;
    if (menu.dataset.boundMessageMenu === '1') return;
    menu.dataset.boundMessageMenu = '1';
    const items = menu.querySelectorAll('.message-action-item');
    items.forEach((item) => {
        item.addEventListener('click', function(e) {
            e.stopPropagation();
            const action = item.dataset.action;
            handleMessageAction(action);
            closeMessageActionMenu();
        });
    });
}

// 处理消息操作
function handleMessageAction(action) {
    switch (action) {
        case 'backtrack':
            openBacktrackConfirm();
            break;
        case 'quote':
            handleQuoteMessage();
            break;
        case 'edit':
            openEditMessageModal();
            break;
        case 'multiselect':
            enterMultiselectMode();
            break;
        default:
            break;
    }
}

// 显示回溯确认模态框
function openBacktrackConfirm() {
    if (!currentBacktrackMessage || !currentBacktrackFriendId) {
        showNotification('无法定位该消息，请重新长按或点击气泡打开菜单');
        return;
    }
    const modal = document.getElementById('backtrack-confirm-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 取消回溯
function cancelBacktrack() {
    const modal = document.getElementById('backtrack-confirm-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    // 清空存储的消息信息
    currentBacktrackMessage = null;
    currentBacktrackFriendId = null;
    currentBacktrackMessageIndex = null;
}

// 处理引用消息
function handleQuoteMessage() {
    console.log('=== 开始处理引用消息 ===');
    console.log('当前引用消息:', currentQuoteMessage);
    
    if (!currentQuoteMessage) {
        console.log('错误：缺少引用消息');
        showNotification('操作失败，请重试');
        return;
    }
    
    // 显示引用框架
    const quoteFrame = document.getElementById('chat-quote-frame');
    const quoteName = document.getElementById('chat-quote-name');
    const quoteContent = document.getElementById('chat-quote-content');
    
    if (quoteFrame && quoteName && quoteContent) {
        quoteName.textContent = quoteSenderLabelForInputBar(currentQuoteMessage);
        quoteContent.textContent = formatQuotePreviewForInputBar(currentQuoteMessage);
        quoteFrame.classList.add('show');
        console.log('引用框架已显示');
    }
    
    console.log('=== 引用消息处理完成 ===');
}

// 关闭引用
function closeQuote() {
    const quoteFrame = document.getElementById('chat-quote-frame');
    if (quoteFrame) {
        quoteFrame.classList.remove('show');
    }
    currentQuoteMessage = null;
}

// 显示编辑消息模态框
function openEditMessageModal() {
    console.log('=== 开始处理编辑消息 ===');
    console.log('当前编辑消息:', currentEditMessage);
    console.log('当前好友ID:', currentEditFriendId);
    
    if (!currentEditMessage || !currentEditFriendId) {
        console.log('错误：缺少消息或好友ID');
        showNotification('操作失败，请重试');
        return;
    }
    
    // 显示编辑消息模态框
    const modal = document.getElementById('edit-message-modal');
    const editInput = document.getElementById('edit-message-input');
    
    if (modal && editInput) {
        // 设置编辑框的初始内容
        editInput.value = currentEditMessage.content;
        
        // 显示模态框
        modal.classList.add('show');
        
        console.log('编辑消息模态框已显示');
    }
    
    console.log('=== 编辑消息模态框处理完成 ===');
}

// 取消编辑消息
function cancelEditMessage() {
    const modal = document.getElementById('edit-message-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    currentEditMessageIndex = null;
    console.log('编辑消息已取消');
}

// 确认编辑消息
function confirmEditMessage() {
    console.log('=== 开始处理确认编辑 ===');
    console.log('当前编辑消息:', currentEditMessage);
    console.log('当前好友ID:', currentEditFriendId);
    
    if (!currentEditMessage || !currentEditFriendId) {
        console.log('错误：缺少消息或好友ID');
        showNotification('操作失败，请重试');
        return;
    }
    
    // 获取编辑后的内容
    const editInput = document.getElementById('edit-message-input');
    if (!editInput) {
        console.log('错误：未找到编辑输入框');
        showNotification('操作失败，请重试');
        return;
    }
    
    const newContent = editInput.value.trim();
    if (!newContent) {
        showNotification('消息内容不能为空');
        return;
    }
    
    const chatHistory = getChatHistoryArray(currentEditFriendId);
    console.log('当前聊天历史长度:', chatHistory.length);
    
    let messageFound = false;
    if (currentEditMessageIndex != null) {
        const i = currentEditMessageIndex;
        if (i >= 0 && i < chatHistory.length) {
            const m = chatHistory[i];
            if (
                m &&
                m.type === currentEditMessage.type &&
                Number(m.timestamp) === Number(currentEditMessage.timestamp)
            ) {
                m.content = newContent;
                messageFound = true;
            }
        }
    }
    const targetTs = Number(currentEditMessage.timestamp);
    if (!messageFound && !Number.isNaN(targetTs)) {
        for (let i = 0; i < chatHistory.length; i++) {
            if (
                Number(chatHistory[i].timestamp) === targetTs &&
                chatHistory[i].type === currentEditMessage.type
            ) {
                const c = chatHistory[i].content;
                if (c === currentEditMessage.content || chatMessageContentsMatch(c, currentEditMessage.content)) {
                    chatHistory[i].content = newContent;
                    messageFound = true;
                    break;
                }
            }
        }
    }
    if (!messageFound) {
        for (let i = 0; i < chatHistory.length; i++) {
            if (chatHistory[i].content === currentEditMessage.content && chatHistory[i].type === currentEditMessage.type) {
                chatHistory[i].content = newContent;
                messageFound = true;
                break;
            }
        }
    }
    
    if (!messageFound) {
        console.log('错误：未找到要编辑的消息');
        showNotification('操作失败，未找到要编辑的消息');
        return;
    }
    
    flushChatHistoryPendingSync(currentEditFriendId);
    console.log('聊天历史已更新');
    
    // 重新加载聊天历史
    loadChatHistory(currentEditFriendId);
    
    // 关闭编辑消息模态框
    const modal = document.getElementById('edit-message-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    
    currentEditMessageIndex = null;
    // 显示成功通知
    showNotification('消息编辑成功');
    console.log('=== 编辑消息处理完成 ===');
}

// 进入多选模式
function enterMultiselectMode() {
    console.log('=== 进入多选模式 ===');
    
    // 获取当前好友ID
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    
    if (!friendId) {
        console.log('错误：缺少好友ID');
        showNotification('操作失败，请重试');
        return;
    }
    
    // 设置多选模式状态
    isMultiselectMode = true;
    currentMultiselectFriendId = friendId;
    selectedMessages.clear();
    // 再次进入多选前先清掉旧勾选框，避免叠两层导致索引/点击错乱
    removeSelectorsFromMessages();
    
    // 显示多选操作栏
    const multiselectBar = document.getElementById('chat-multiselect-bar');
    if (multiselectBar) {
        multiselectBar.classList.add('show');
    }
    
    // 隐藏聊天输入区域
    const chatInputArea = document.querySelector('.chat-input-area');
    if (chatInputArea) {
        chatInputArea.style.display = 'none';
    }
    
    // 为所有消息添加选择框
    addSelectorsToMessages();
    
    // 更新选中数量
    updateSelectedCount();
    
    console.log('=== 已进入多选模式 ===');
}

// 退出多选模式
function exitMultiselectMode() {
    console.log('=== 退出多选模式 ===');
    
    // 隐藏多选操作栏
    const multiselectBar = document.getElementById('chat-multiselect-bar');
    if (multiselectBar) {
        multiselectBar.classList.remove('show');
    }
    
    // 显示聊天输入区域
    const chatInputArea = document.querySelector('.chat-input-area');
    if (chatInputArea) {
        chatInputArea.style.display = 'flex';
    }
    
    // 移除所有选择框
    removeSelectorsFromMessages();
    
    // 重置多选模式状态
    isMultiselectMode = false;
    selectedMessages.clear();
    currentMultiselectFriendId = null;
    
    console.log('=== 已退出多选模式 ===');
}

// 为消息添加选择框（messageIndex 与 chatHistory 数组下标一致，含「仅显示最近 N 条」时的偏移）
function addSelectorsToMessages() {
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) return;
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) return;
    const all = getChatHistoryArray(friendId);
    let startIdx;
    let limit;
    if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.getChatListViewportForSelectors === 'function') {
        const vp = Wechat.ui.getChatListViewportForSelectors(friendId);
        startIdx = vp.startIdx;
        limit = vp.limit;
    } else {
        const CHAT_INITIAL_RENDER_LIMIT = 220;
        limit = Math.max(20, Math.min(all.length, CHAT_INITIAL_RENDER_LIMIT));
        startIdx = Math.max(0, all.length - limit);
    }
    const children = Array.from(chatContent.children);
    // 必须与 loadChatHistory 的 DOM 顺序一致：每条历史记录对应一个子节点（含 system → .chat-system-message）。
    // 若仅用「第几条 .chat-message」计数，中间夹了系统消息时会把下标整体错位，出现「日志显示删了、画面上那条还在」。
    let slot = 0;
    children.forEach((message) => {
        if (message.classList.contains('chat-load-more') || message.classList.contains('proactive-typing-row')) return;
        const historyIndex = startIdx + slot;
        slot++;
        if (!message.classList.contains('chat-message')) return;
        if (historyIndex >= all.length) return;
        message.dataset.messageIndex = String(historyIndex);
        const selector = document.createElement('div');
        selector.className = 'chat-message-selector';
        selector.dataset.messageIndex = String(historyIndex);
        
        // 确定选择框的位置
        const bubble = message.querySelector('.chat-message-bubble');
        if (bubble) {
            if (message.classList.contains('my-message')) {
                selector.style.left = '22px';
            } else {
                selector.style.right = '22px';
            }
            selector.style.top = '50%';
            selector.style.transform = 'translateY(-50%)';
        }
        
        selector.addEventListener('click', function(e) {
            e.stopPropagation();
            toggleMessageSelection(historyIndex);
        });
        
        message.addEventListener('click', function(e) {
            if (!e.target.closest('.chat-message-bubble')) {
                e.stopPropagation();
                toggleMessageSelection(historyIndex);
            }
        });
        
        message.style.position = 'relative';
        message.appendChild(selector);
    });
}

// 移除消息的选择框
function removeSelectorsFromMessages() {
    const selectors = document.querySelectorAll('.chat-message-selector');
    selectors.forEach(selector => {
        selector.remove();
    });
    
    // 移除选中状态
    const selectedMessageElements = document.querySelectorAll('.chat-message.selected');
    selectedMessageElements.forEach(message => {
        message.classList.remove('selected');
    });
}

// 切换消息选择状态
function toggleMessageSelection(index) {
    const idx = typeof index === 'number' && Number.isFinite(index) ? index : parseInt(index, 10);
    if (!Number.isFinite(idx) || idx < 0) {
        console.log('错误：无效的消息索引', index);
        return;
    }
    const message = document.querySelector(`.chat-message[data-message-index="${idx}"]`);
    if (!message) {
        console.log('错误：未找到消息元素', idx);
        return;
    }
    
    const selector = message.querySelector('.chat-message-selector');
    if (!selector) {
        console.log('错误：未找到选择框元素', idx);
        return;
    }
    
    if (selectedMessages.has(idx)) {
        // 取消选择
        selectedMessages.delete(idx);
        message.classList.remove('selected');
        selector.classList.remove('selected');
        console.log('取消选择消息', idx);
    } else {
        // 选择（统一用数字下标，避免 Set 中混入字符串导致删除时 has(数字) 为 false）
        selectedMessages.add(idx);
        message.classList.add('selected');
        selector.classList.add('selected');
        console.log('选择消息', idx);
    }
    
    // 更新选中数量
    updateSelectedCount();
}

// 更新选中消息数量
function updateSelectedCount() {
    const countElement = document.getElementById('selected-count');
    if (countElement) {
        countElement.textContent = `已选择 ${selectedMessages.size} 条消息`;
    }
}

// 全选功能已移除，用户不需要此功能

function cloneForwardMessageEntry(msg) {
    const o = {
        type: msg.type,
        content: msg.content,
    };
    if (msg.speakerId != null && String(msg.speakerId) !== '') o.speakerId = String(msg.speakerId);
    try { o.quote = msg.quote ? JSON.parse(JSON.stringify(msg.quote)) : null; } catch (e) { o.quote = null; }
    if (msg.forwardFrom && typeof msg.forwardFrom === 'object') {
        try {
            o.forwardFrom = JSON.parse(JSON.stringify(msg.forwardFrom));
        } catch (e) {
            o.forwardFrom = { friendId: msg.forwardFrom.friendId, name: msg.forwardFrom.name };
        }
    }
    if (msg.subtype) o.subtype = msg.subtype;
    if (msg.transferStatus) o.transferStatus = msg.transferStatus;
    if (msg.giftStatus) o.giftStatus = msg.giftStatus;
    try { if (msg.giftItems) o.giftItems = JSON.parse(JSON.stringify(msg.giftItems)); } catch (e) { o.giftItems = null; }
    if (msg.giftTotalQty != null) o.giftTotalQty = msg.giftTotalQty;
    if (msg.giftKindCount != null) o.giftKindCount = msg.giftKindCount;
    return o;
}

function updateForwardSendButtonEnabled() {
    const btn = document.querySelector('#forward-friends-modal .forward-friends-send-btn');
    if (btn) {
        btn.disabled = forwardTargetFriendIds.size === 0;
    }
}

function updateCreateGroupChatConfirmEnabled() {
    const btn = document.getElementById('create-groupchat-confirm-btn');
    if (btn) btn.disabled = groupchatSelectedFriendIds.size < 2;
    const hint = document.getElementById('create-groupchat-hint');
    if (hint) hint.textContent = `已选 ${groupchatSelectedFriendIds.size} 位好友（至少 2 位）`;
}

function renderCreateGroupChatFriendsList() {
    const listEl = document.getElementById('create-groupchat-friends-list');
    const emptyEl = document.getElementById('create-groupchat-empty');
    if (!listEl) return;
    listEl.innerHTML = '';
    groupchatSelectedFriendIds.clear();

    let friends = [];
    try {
        friends = loadFriendsFromStorage();
    } catch (e) {
        friends = [];
    }
    friends = friends.filter(f => !f.blacklisted && !f.isGroup);

    friends.forEach(f => {
        const row = document.createElement('div');
        row.className = 'forward-friend-row';
        row.dataset.friendId = String(f.id);

        const check = document.createElement('div');
        check.className = 'forward-friend-checkbox';

        const avatar = document.createElement('div');
        avatar.className = 'forward-friend-avatar';
        const av = typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(f)
            : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '');
        if (av) {
            avatar.style.backgroundImage = `url(${av})`;
            avatar.textContent = '';
        } else {
            avatar.textContent = (f.nickname || '?').charAt(0);
        }

        const name = document.createElement('span');
        name.className = 'forward-friend-name';
        name.textContent = f.remark || f.nickname || '未命名';

        row.appendChild(check);
        row.appendChild(avatar);
        row.appendChild(name);

        row.addEventListener('click', function () {
            const id = String(f.id);
            if (groupchatSelectedFriendIds.has(id)) {
                groupchatSelectedFriendIds.delete(id);
                row.classList.remove('selected');
            } else {
                groupchatSelectedFriendIds.add(id);
                row.classList.add('selected');
            }
            updateCreateGroupChatConfirmEnabled();
        });

        listEl.appendChild(row);
    });

    if (emptyEl) {
        const has = listEl.children.length > 0;
        emptyEl.style.display = has ? 'none' : 'block';
        listEl.style.display = has ? 'block' : 'none';
    }
    updateCreateGroupChatConfirmEnabled();
}

function openCreateGroupChatModal() {
    try {
        const addMenu = document.getElementById('wechat-add-menu');
        if (addMenu) addMenu.classList.remove('show');
    } catch (e) {}
    renderCreateGroupChatFriendsList();
    const modal = document.getElementById('create-groupchat-modal');
    if (modal) modal.classList.add('show');
}

function cancelCreateGroupChatModal() {
    const modal = document.getElementById('create-groupchat-modal');
    if (modal) modal.classList.remove('show');
    groupchatSelectedFriendIds.clear();
}

function buildDefaultGroupChatName(selectedIds, friends) {
    const map = new Map(friends.map(f => [String(f.id), f]));
    const names = selectedIds
        .map(id => map.get(String(id)))
        .filter(Boolean)
        .map(f => (f.remark || f.nickname || '好友').trim())
        .filter(Boolean);
    const head = names.slice(0, 3).join('、');
    if (!head) return '群聊';
    return names.length > 3 ? `${head}等` : head;
}

async function confirmCreateGroupChat() {
    if (groupchatSelectedFriendIds.size < 2) {
        showNotification('请选择至少2位好友');
        return;
    }

    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}

    let friends = [];
    try {
        friends = loadFriendsFromStorage();
    } catch (e) {
        friends = [];
    }

    const selectedIds = Array.from(groupchatSelectedFriendIds);
    const groupId = 'g_' + Date.now();
    const groupName = buildDefaultGroupChatName(selectedIds, friends);
    const group = {
        id: groupId,
        nickname: groupName,
        remark: '',
        roleSetting: '',
        avatar: '',
        persona: null,
        isGroup: true,
        memberIds: selectedIds,
        createdAt: Date.now()
    };

    friends.push(group);
    try {
        saveFriendsToStorage(friends);
    } catch (e) {
        showErrorDialog('创建群聊失败', String(e && (e.message || e) || '保存失败'));
        return;
    }

    const modal = document.getElementById('create-groupchat-modal');
    if (modal) modal.classList.remove('show');
    groupchatSelectedFriendIds.clear();
    await loadChatList();
    showNotification('群聊创建成功');
}

function renderForwardFriendsList() {
    const listEl = document.getElementById('forward-friends-list');
    const emptyEl = document.getElementById('forward-friends-empty');
    if (!listEl) return;
    listEl.innerHTML = '';
    forwardTargetFriendIds.clear();
    let friends = loadFriendsFromStorage();
    const curId = String(currentMultiselectFriendId || '');
    friends = friends.filter(f => String(f.id) !== curId && !f.blacklisted && !f.isGroup);
    friends.forEach(f => {
        const row = document.createElement('div');
        row.className = 'forward-friend-row';
        row.dataset.friendId = String(f.id);
        const check = document.createElement('div');
        check.className = 'forward-friend-checkbox';
        const avatar = document.createElement('div');
        avatar.className = 'forward-friend-avatar';
        const fwdAv = typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(f)
            : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '');
        if (fwdAv) {
            avatar.style.backgroundImage = `url(${fwdAv})`;
            avatar.textContent = '';
        } else {
            avatar.textContent = (f.nickname || '?').charAt(0);
        }
        const name = document.createElement('span');
        name.className = 'forward-friend-name';
        name.textContent = f.nickname || '未命名';
        row.appendChild(check);
        row.appendChild(avatar);
        row.appendChild(name);
        row.addEventListener('click', function() {
            const id = String(f.id);
            if (forwardTargetFriendIds.has(id)) {
                forwardTargetFriendIds.delete(id);
                row.classList.remove('selected');
            } else {
                forwardTargetFriendIds.add(id);
                row.classList.add('selected');
            }
            updateForwardSendButtonEnabled();
        });
        listEl.appendChild(row);
    });
    if (emptyEl) {
        const has = listEl.children.length > 0;
        emptyEl.style.display = has ? 'none' : 'block';
        listEl.style.display = has ? 'block' : 'none';
    }
    updateForwardSendButtonEnabled();
}

function openForwardFriendsModal() {
    const hint = document.getElementById('forward-friends-hint');
    if (hint) {
        hint.textContent = `已选 ${pendingForwardMessages.length} 条消息，请选择接收好友（可多选）`;
    }
    renderForwardFriendsList();
    const modal = document.getElementById('forward-friends-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

function cancelForwardFriendsModal() {
    const modal = document.getElementById('forward-friends-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    forwardTargetFriendIds.clear();
    pendingForwardMessages = [];
    pendingForwardSourceMeta = null;
}

async function applyFriendListMetaAfterForward(friendId, lastTimestamp, friendTypeUnreadDelta) {
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    const friends = loadFriendsFromStorage();
    const updated = friends.map(friend => {
        if (String(friend.id) !== String(friendId)) return friend;
        return {
            ...friend,
            lastMessageTime: lastTimestamp,
            lastMessage: '[转发]',
            lastMessageType: 'user',
            unreadCount: (friend.unreadCount || 0) + (friendTypeUnreadDelta || 0)
        };
    });
    saveFriendsToStorage(updated);
}

async function confirmForwardToSelectedFriends() {
    if (!pendingForwardMessages.length) {
        showNotification('没有可转发的消息');
        cancelForwardFriendsModal();
        return;
    }
    if (forwardTargetFriendIds.size === 0) {
        showNotification('请选择接收好友');
        return;
    }
    const sourceMeta = pendingForwardSourceMeta;
    const messages = pendingForwardMessages.map(cloneForwardMessageEntry).map(m => {
        const base = { ...m, type: 'user', subtype: 'forward' };
        if (sourceMeta && sourceMeta.name) {
            base.forwardFrom = { friendId: String(sourceMeta.friendId), name: String(sourceMeta.name) };
        }
        return base;
    });
    const targetIds = Array.from(forwardTargetFriendIds);
    const friendUnreadDelta = 0;
    let ts = Date.now();
    for (let ti = 0; ti < targetIds.length; ti++) {
        const fid = targetIds[ti];
        const chatHistory = getChatHistoryArray(fid);
        let lastTs = ts;
        messages.forEach(msg => {
            const entry = {
                type: msg.type,
                content: msg.content,
                timestamp: ts,
                quote: msg.quote
            };
            entry.subtype = 'forward';
            if (msg.forwardFrom && typeof msg.forwardFrom === 'object') {
                entry.forwardFrom = {
                    friendId: String(msg.forwardFrom.friendId || ''),
                    name: String(msg.forwardFrom.name || '')
                };
            }
            if (msg.transferStatus) entry.transferStatus = msg.transferStatus;
            if (msg.giftStatus) entry.giftStatus = msg.giftStatus;
            try { if (msg.giftItems) entry.giftItems = JSON.parse(JSON.stringify(msg.giftItems)); } catch (e) { entry.giftItems = null; }
            if (msg.giftTotalQty != null) entry.giftTotalQty = msg.giftTotalQty;
            if (msg.giftKindCount != null) entry.giftKindCount = msg.giftKindCount;
            chatHistory.push(entry);
            lastTs = ts;
            ts += 1;
        });
        flushChatHistoryPendingSync(fid);
        await applyFriendListMetaAfterForward(fid, lastTs, friendUnreadDelta);
    }
    const modal = document.getElementById('forward-friends-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    forwardTargetFriendIds.clear();
    pendingForwardMessages = [];
    pendingForwardSourceMeta = null;
    await loadChatList();
    exitMultiselectMode();
    showNotification(`已转发 ${messages.length} 条消息给 ${targetIds.length} 位好友`);
}

// 转发选中的消息
function forwardSelectedMessages() {
    if (selectedMessages.size === 0) {
        showNotification('请先选择要转发的消息');
        return;
    }
    if (!currentMultiselectFriendId) {
        showNotification('操作失败，请重试');
        return;
    }
    const chatHistory = getChatHistoryArray(currentMultiselectFriendId);
    const friends = loadFriendsFromStorage();
    const srcFriend = friends.find(f => String(f.id) === String(currentMultiselectFriendId));
    let sourceLabel = '聊天';
    if (srcFriend) {
        if (srcFriend.isGroup) {
            sourceLabel = (srcFriend.nickname || srcFriend.remark || '群聊').trim() || '群聊';
        } else {
            sourceLabel = (srcFriend.remark || srcFriend.nickname || '').trim() || '聊天';
        }
    }
    pendingForwardSourceMeta = {
        friendId: String(currentMultiselectFriendId),
        name: sourceLabel
    };
    const sortedIdx = Array.from(selectedMessages)
        .map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : parseInt(x, 10)))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
    pendingForwardMessages = [];
    for (let i = 0; i < sortedIdx.length; i++) {
        const idx = sortedIdx[i];
        if (idx < 0 || idx >= chatHistory.length) {
            showNotification('消息数据异常，请退出多选后重试');
            pendingForwardMessages = [];
            pendingForwardSourceMeta = null;
            return;
        }
        pendingForwardMessages.push(cloneForwardMessageEntry(chatHistory[idx]));
    }
    openForwardFriendsModal();
}

// 收藏选中的消息
function favoriteSelectedMessages() {
    if (selectedMessages.size === 0) {
        showNotification('请先选择要收藏的消息');
        return;
    }
    if (!currentMultiselectFriendId) {
        showNotification('操作失败，请重试');
        return;
    }
    const chatHistory = getChatHistoryArray(currentMultiselectFriendId);
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == currentMultiselectFriendId);
    const sourceFriendName = friend ? (friend.nickname || friend.remark || '未知') : '未知';
    let favorites;
    try { favorites = JSON.parse(localStorage.getItem('wechatFavorites') || '[]'); if (!Array.isArray(favorites)) favorites = []; } catch (e) { favorites = []; }
    const sortedIdx = Array.from(selectedMessages)
        .map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : parseInt(x, 10)))
        .filter((n) => Number.isFinite(n) && n >= 0)
        .sort((a, b) => a - b);
    const collectedAt = Date.now();
    sortedIdx.forEach((index, i) => {
        if (index < 0 || index >= chatHistory.length) return;
        const msg = chatHistory[index];
        favorites.push({
            id: collectedAt + i,
            sourceType: 'chat',
            type: msg.type,
            content: msg.content,
            quote: (function () {
                try { return msg.quote ? JSON.parse(JSON.stringify(msg.quote)) : null; } catch (e) { return null; }
            })(),
            sourceFriendId: currentMultiselectFriendId,
            sourceFriendName: sourceFriendName,
            collectedAt: collectedAt + i
        });
    });
    localStorage.setItem('wechatFavorites', JSON.stringify(favorites));
    exitMultiselectMode();
    showNotification(`已收藏 ${sortedIdx.length} 条消息`);
}
function showConfirmDeleteModal() {
    if (selectedMessages.size === 0) {
        showNotification('请先选择要删除的消息');
        return;
    }
    
    const modal = document.getElementById('confirm-delete-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 取消删除
function cancelDelete() {
    const modal = document.getElementById('confirm-delete-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 根据聊天记录末尾更新会话列表预览（回溯/删除后）
function syncFriendPreviewFromChatHistoryEnd(friendId, historyArr) {
    const fid = String(friendId);
    const arr = Array.isArray(historyArr) ? historyArr : [];
    void (async function () {
        try {
            if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
        } catch (e) {}
        let friends;
        try {
            friends = loadFriendsFromStorage();
        } catch (e) {
            return;
        }
        const last = arr.length === 0 ? null : arr[arr.length - 1];
        const updated = friends.map((f) => {
            if (String(f.id) !== fid) return f;
            if (!last) {
                return { ...f, lastMessage: '开始聊天吧！', lastMessageTime: Date.now(), lastMessageType: 'user' };
            }
            let preview = buildChatListPreviewForLastMessage(last.type, last.content, last.subtype);
            if (!preview && (last.type === 'friend' || last.type === 'user')) preview = '[消息]';
            const ts = Number(last.timestamp);
            return {
                ...f,
                lastMessage: preview || f.lastMessage || '开始聊天吧！',
                lastMessageTime: Number.isFinite(ts) ? ts : f.lastMessageTime,
                lastMessageType: last.type
            };
        });
        try {
            saveFriendsToStorageDebounced(updated);
        } catch (e) {}
        scheduleLoadChatList();
    })();
}

// 确认删除（仅删除选中的消息）
function confirmDelete() {
    const fid = currentMultiselectFriendId;
    if (!fid) {
        console.log('错误：缺少好友ID');
        showNotification('操作失败，请重试');
        return;
    }
    const rawIdx = Array.from(selectedMessages).map((x) => (typeof x === 'number' && Number.isFinite(x) ? x : parseInt(x, 10))).filter((n) => Number.isFinite(n) && n >= 0);
    if (rawIdx.length === 0) {
        showNotification('没有可删除的选中项，请重新选择');
        const modalEmpty = document.getElementById('confirm-delete-modal');
        if (modalEmpty) modalEmpty.classList.remove('show');
        return;
    }
    // 先落盘待写入的聊天记录，避免 getChatHistoryArray 从旧 localStorage 拉回导致删不掉
    try {
        flushChatHistoryPendingSync(fid);
    } catch (e) {}
    const chatHistory = getChatHistoryArray(fid);
    const len = chatHistory.length;
    const removeSet = new Set(rawIdx.filter((n) => n < len));
    const deletedCount = removeSet.size;
    if (deletedCount === 0) {
        showNotification('选中项已失效，请退出多选后重试');
        const modalBad = document.getElementById('confirm-delete-modal');
        if (modalBad) modalBad.classList.remove('show');
        return;
    }
    // 只删除用户勾选的条目；不要额外删除“最新回复整组/选中之后所有消息”
    const updatedHistory = chatHistory.filter((_, i) => !removeSet.has(i));
    
    replaceChatHistoryAndPersist(fid, updatedHistory);
    syncFriendPreviewFromChatHistoryEnd(fid, updatedHistory);
    
    loadChatHistory(fid);
    
    exitMultiselectMode();
    
    const modal = document.getElementById('confirm-delete-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    
    showNotification(`成功删除 ${deletedCount} 条消息`);
    console.log(`=== 已删除 ${deletedCount} 条消息 ===`);
}

// 删除选中的消息（现在显示确认模态框）
function deleteSelectedMessages() {
    showConfirmDeleteModal();
}

// 确认回溯
function confirmBacktrack() {
    console.log('=== 开始回溯 ===');
    console.log('currentBacktrackFriendId:', currentBacktrackFriendId);
    console.log('currentBacktrackMessage:', currentBacktrackMessage);
    
    if (!currentBacktrackFriendId || !currentBacktrackMessage) {
        showNotification('操作失败，请重试');
        cancelBacktrack();
        return;
    }
    // 与批量删除一致：先落盘待写入的聊天记录，避免 getChatHistoryArray 从延迟写盘/IDB 等路径与内存不一致
    try {
        if (typeof flushChatHistoryPendingSync === 'function') {
            flushChatHistoryPendingSync(currentBacktrackFriendId);
        }
    } catch (e) {}
    const chatHistory = getChatHistoryArray(currentBacktrackFriendId);
    console.log('聊天历史数量:', chatHistory.length);
    
    let messageIndex = -1;
    if (currentBacktrackMessageIndex != null) {
        const i = currentBacktrackMessageIndex;
        if (i >= 0 && i < chatHistory.length) {
            const row = chatHistory[i];
            if (
                row &&
                Number(row.timestamp) === Number(currentBacktrackMessage.timestamp) &&
                row.type === currentBacktrackMessage.type
            ) {
                messageIndex = i;
            }
        }
    }
    if (messageIndex === -1) {
        const targetTs = Number(currentBacktrackMessage.timestamp);
        const sameRow = chatHistory
            .map((msg, idx) => ({ msg, idx }))
            .filter(
                (x) =>
                    Number(x.msg.timestamp) === targetTs && x.msg.type === currentBacktrackMessage.type
            );
        if (sameRow.length === 1) {
            messageIndex = sameRow[0].idx;
        } else if (sameRow.length > 1) {
            let hit = sameRow.find((x) => x.msg.content === currentBacktrackMessage.content);
            if (!hit) {
                hit = sameRow.find((x) =>
                    chatMessageContentsMatch(x.msg.content, currentBacktrackMessage.content)
                );
            }
            if (hit) messageIndex = hit.idx;
        }
    }
    if (messageIndex === -1) {
        const targetTs = Number(currentBacktrackMessage.timestamp);
        messageIndex = chatHistory.findIndex(
            (msg) =>
                Number(msg.timestamp) === targetTs &&
                msg.type === currentBacktrackMessage.type &&
                (msg.content === currentBacktrackMessage.content ||
                    chatMessageContentsMatch(msg.content, currentBacktrackMessage.content))
        );
    }
    if (messageIndex === -1) {
        messageIndex = chatHistory.findIndex(
            (msg) =>
                msg.content === currentBacktrackMessage.content ||
                chatMessageContentsMatch(msg.content, currentBacktrackMessage.content)
        );
    }
    console.log('回溯定位索引:', messageIndex);
    
    if (messageIndex === -1) {
        showNotification('消息未找到');
        cancelBacktrack();
        return;
    }
    // 保留从开头到本消息（含）为止，删除之后的记录（与确认文案一致）
    const updatedHistory = chatHistory.slice(0, messageIndex + 1);
    console.log('更新后的历史记录数量:', updatedHistory.length);
    
    replaceChatHistoryAndPersist(currentBacktrackFriendId, updatedHistory);
    syncFriendPreviewFromChatHistoryEnd(currentBacktrackFriendId, updatedHistory);
    
    const friendIdCopy = currentBacktrackFriendId;
    
    // 关闭确认模态框
    cancelBacktrack();
    
    // 重新加载聊天历史
    loadChatHistory(friendIdCopy);
    
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
    
    // 显示成功提示
    showNotification('回溯成功');
    console.log('=== 回溯完成 ===');
}

// 页面加载完成后初始化消息操作菜单（仅 initMessageActionMenu，勿重复绑定菜单项以免「引用/回溯」触发两次）
window.addEventListener('DOMContentLoaded', function() {
    initMessageActionMenu();
});
// 保存聊天消息到本地存储。transferStatus 可选：'pending'|'received'|'rejected'；extra 可选：合并写入 giftStatus/giftItems 等字段
// messageMode（从 extra.messageMode 读取）可选：'online'|'offline'，由调用方传入以避免在消息体内同步读取好友数据

// 根据最后一条消息生成会话列表预览文案
function buildChatListPreviewForLastMessage(type, content, subtype) {
    const sub = subtype != null ? String(subtype) : '';
    if (sub === 'transfer') return '[转账]';
    if (sub === 'friend_transfer') return '[转账]';
    if (sub === 'redpacket') return '[微信红包]';
    if (sub === 'gift_bundle') return '[礼物]';
    if (sub === 'photo_card') return '[拍立得]';
    if (sub === 'forward') return '[转发]';
    if (sub === 'moments_forward_card') return '[朋友圈转发]';
    if (sub === 'couple_space_invite_card') return '[情侣空间邀请]';
    if (sub === 'couple_space_accept_card') return '[情侣空间·已答应]';
    if (sub === 'love_takeout_order') return '[爱的外卖]';
    if (sub === 'voice_note_fake') return '[语音消息]';
    if (sub === 'voice_call_bundle') return '[语音通话]';
    let c = content == null ? '' : String(content);
    if (type === 'system') {
        try {
            const d = document.createElement('div');
            d.innerHTML = c;
            c = (d.textContent || '').replace(/\s+/g, ' ').trim();
        } catch (e) {
            c = c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
        if (c) return c;
    }
    if (/^\s*data:image\//i.test(c) || /^\s*https?:\/\//i.test(c)) {
        if (/\.(png|jpe?g|gif|webp)(\?|$)/i.test(c) || /data:image\//i.test(c)) return '[图片]';
    }
    if (c.includes('[图片]')) return '[图片]';
    if (c.includes('[语音]')) return '[语音]';
    if (c.includes('[视频]')) return '[视频]';
    if (/<[^>]+>/.test(c)) {
        try {
            const d = document.createElement('div');
            d.innerHTML = c;
            c = (d.textContent || '').replace(/\s+/g, ' ').trim();
        } catch (e) {
            c = c.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        }
    }
    c = c.trim();
    if (!c) {
        if (type === 'friend' || type === 'user') return '[消息]';
        return '';
    }
    return c;
}

// 从 chatHistory_* 对齐好友的 lastMessage / lastMessageTime（列表刷新时与会话末尾一致）
// friendsArg 已弃用读取：await ensureFriendsCacheHydrated 之后须重新 load，否则会在用户保存群设置等操作后仍用旧快照写回，覆盖群聊记忆轮数/私聊互通轮数等字段。
async function syncFriendsLastMessagePreviewsFromStorage(friendsArg) {
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    let friends;
    try {
        friends = loadFriendsFromStorage();
    } catch (e) {
        return [];
    }
    if (!Array.isArray(friends) || friends.length === 0) return friends;
    let changed = false;
    const updated = friends.map((friend) => {
        if (!friend || friend.id == null) return friend;
        const hist = getChatHistoryArray(friend.id);
        if (!Array.isArray(hist) || hist.length === 0) return friend;
        const last = hist[hist.length - 1];
        if (!last) return friend;
        let preview = buildChatListPreviewForLastMessage(last.type, last.content, last.subtype);
        if (!preview && (last.type === 'friend' || last.type === 'user')) preview = '[消息]';
        if (!preview) return friend;
        const ts = Number(last.timestamp);
        const safeTs = Number.isFinite(ts) ? ts : (Number(friend.lastMessageTime) || 0);
        const friendTs = Number(friend.lastMessageTime) || 0;
        if (safeTs < friendTs) return friend;
        if (friend.lastMessage === preview && friendTs === safeTs) return friend;
        changed = true;
        return { ...friend, lastMessage: preview, lastMessageTime: safeTs, lastMessageType: last.type };
    });
    if (changed) {
        try { saveFriendsToStorage(updated); } catch (e) {}
    }
    return updated;
}

function shouldTriggerLoveTakeoutFromUserMessage(friendId, msg) {
    const text = String(msg || '').trim();
    if (!text) return false;
    const pair = window.Wechat && window.Wechat.store && window.Wechat.store.coupleSpace && typeof window.Wechat.store.coupleSpace.getPair === 'function'
        ? window.Wechat.store.coupleSpace.getPair(String(friendId || ''))
        : null;
    if (!pair || String(pair.status || 'accepted') === 'rejected') return false;
    const patterns = [/好饿/i, /不知道吃什么/i, /还没吃饭/i, /没吃饭/i, /想吃点/i, /饿死/i];
    return patterns.some(re => re.test(text));
}

async function maybeTriggerCharLoveTakeoutFromChat(friendId, userText) {
    if (!shouldTriggerLoveTakeoutFromUserMessage(friendId, userText)) return false;
    if (typeof window.requestCharLoveTakeoutOrderFromChat !== 'function') return false;
    return window.requestCharLoveTakeoutOrderFromChat(friendId, userText);
}

function saveChatMessage(friendId, type, content, quote = null, fixedTimestamp = null, subtype = null, transferStatus = null, extra = null) {
    if (!friendId) return;
    
    const chatHistory = getChatHistoryArray(friendId);
    const timestamp = fixedTimestamp != null ? fixedTimestamp : new Date().getTime();
    
    const item = { type, content, timestamp, quote };
    // 线下模式：给消息打标（mode 由调用方通过 extra.messageMode 传入，避免在此同步读取好友数据）
    if ((type === 'user' || type === 'friend') && (!extra || extra.mode == null)) {
        const msgMode = extra && extra.messageMode;
        if (msgMode === 'offline') item.mode = 'offline';
        else if (msgMode === 'online') item.mode = 'online';
    }
    if (subtype) item.subtype = subtype;
    if (transferStatus != null && transferStatus !== '') item.transferStatus = transferStatus;
    if (extra && typeof extra === 'object') {
        Object.keys(extra).forEach((k) => {
            if (extra[k] !== undefined && k !== 'messageMode') item[k] = extra[k];
        });
    }
    try {
        const vct =
            typeof window !== 'undefined' && window._voiceCallFriendReplyTag ? window._voiceCallFriendReplyTag : null;
        if ((type === 'friend' || type === 'user') && vct && vct.sessionId) {
            if (item.voiceCallSessionId == null) item.voiceCallSessionId = vct.sessionId;
            if (!item.voiceCallSuppressMainChat) item.voiceCallSuppressMainChat = true;
        }
    } catch (eVc) {}
    chatHistory.push(item);
    
    schedulePersistChatHistory(friendId);
    queueWechatMessagePreview(friendId, item);
    if (window.Wechat && Wechat.proactive) {
        try { Wechat.proactive.onMessage(friendId, item); } catch (e) { console.warn('[主动发消息] 更新计时失败', e.message); }
    }
}

function queueWechatMessagePreview(friendId, item) {
    const { type, timestamp, content, subtype } = item;
    
    // 延迟批量更新好友 lastMessageTime/lastMessage：将同步写 localStorage 移出主线程；
    // 同一好友多条消息合并为最后一次；不同好友在同一 tick 内各保留一条待写入。
    let previewMeta = { friendId, type, timestamp, content, subtype };
    try {
        if (item.voiceCallSuppressMainChat && (type === 'user' || type === 'friend')) {
            previewMeta = { friendId, type, timestamp, content: '[语音通话]', subtype };
        }
    } catch (ePv) {}
    __pendingFriendUpdates[String(friendId)] = previewMeta;
    if (!_friendUpdateFlushTimer) {
        // 使用防抖机制：连续更新时延长等待时间
        _friendUpdateDebounceCount++;
        const delay = Math.min(100, _friendUpdateDebounceCount * 20);
        _friendUpdateFlushTimer = setTimeout(flushPendingFriendListMeta, delay);
    }
}

// 更新转账消息状态（pending -> received 或 rejected）
function updateTransferMessageStatus(friendId, messageTimestamp, newStatus) {
    let chatHistory;
    try {
        chatHistory = getChatHistoryArray(friendId);
    } catch (_) {
        return;
    }
    const msg = chatHistory.find(m => m.type === 'user' && m.subtype === 'transfer' && Number(m.timestamp) === Number(messageTimestamp));
    if (msg) {
        msg.transferStatus = newStatus;
        try {
            schedulePersistChatHistory(friendId);
        } catch (_) {}
        loadChatHistory(friendId);
    }
}

function updateGiftBundleMessageStatus(friendId, messageTimestamp, newStatus) {
    let chatHistory;
    try {
        chatHistory = getChatHistoryArray(friendId);
    } catch (_) {
        return;
    }
    const msg = chatHistory.find(
        (m) =>
            m.type === 'user' &&
            m.subtype === 'gift_bundle' &&
            Number(m.timestamp) === Number(messageTimestamp)
    );
    if (msg) {
        msg.giftStatus = newStatus;
        try {
            schedulePersistChatHistory(friendId);
        } catch (_) {}
    }
}

async function processGiftBundleApiResponse(friendId, messageTimestamp, response) {
    if (!response) return;
    updateGiftBundleMessageStatus(friendId, messageTimestamp, 'received');
    loadChatHistory(friendId);
    let messages = splitApiResponseIntoMessages(response);
    const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    let allEmojis = [];
    for (const c in emojiData) {
        allEmojis = allEmojis.concat(emojiData[c] || []);
    }
    messages = messages.map((m) => {
        const raw = typeof m === 'string' ? m : (m.content || '');
        const resolved = typeof resolveEmojiRefsInMessage === 'function'
            ? resolveEmojiRefsInMessage(raw, allEmojis)
            : raw;
        return { content: resolved, polaroidOnly: !!(m && m.polaroidOnly) };
    });
    for (const msg of messages) {
        const rawContent = msg.content || '';
        const polaroidOnly = !!msg.polaroidOnly;
        const ts = new Date().getTime();
        let body, friendSubtype;
        if (polaroidOnly) {
            body = rawContent;
            friendSubtype = 'photo_card';
        } else {
            const parsed = parseFriendPhotoCardMessage(rawContent);
            body = parsed ? parsed.content : rawContent;
            friendSubtype = parsed ? parsed.subtype : null;
        }
        if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && body) {
            body = sanitizeWechatOutgoingBubbleBody(body, friendSubtype);
        }
        displayMessage('friend', body, null, ts, friendId, friendSubtype);
        saveChatMessage(friendId, 'friend', body, null, ts, friendSubtype);
        await new Promise((r) => setTimeout(r, 200));
    }
}

async function receiveGiftBundleFromChat(friendId, messageTimestamp) {
    if (!friendId || messageTimestamp == null || Number.isNaN(Number(messageTimestamp))) return;
    if (isReceiving) {
        showNotification('请等待当前接收完成');
        return;
    }
    const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    const msg = chatHistory.find(
        (m) =>
            m.type === 'user' &&
            m.subtype === 'gift_bundle' &&
            Number(m.timestamp) === Number(messageTimestamp)
    );
    if (!msg) {
        showNotification('找不到该礼物消息');
        return;
    }
    if (msg.giftStatus !== 'pending_receive') {
        showNotification('礼物已拆开');
        return;
    }
    const friends = loadFriendsFromStorage();
    const friend = friends.find((f) => String(f.id) === String(friendId));
    if (friend && friend.blacklisted) {
        showNotification('请先解除黑名单');
        return;
    }
    const sendContent = CommandManager.buildGiftBundleReceiveSendContent(friendId, msg.giftItems || []);
    if (!sendContent) {
        showNotification('无法发起请求');
        return;
    }
    isReceiving = true;
    document.querySelector('.receive-btn')?.classList.add('loading');
    receiveController = new AbortController();
    try {
        const response = await FeatureCommandMapper.callApiModel(sendContent, receiveController);
        await processGiftBundleApiResponse(friendId, messageTimestamp, response);
    } catch (e) {
        console.error(e);
        showNotification('接收失败，请重试');
    } finally {
        isReceiving = false;
        document.querySelector('.receive-btn')?.classList.remove('loading');
        receiveController = null;
    }
}

// 解析转账收款API回复，返回 { action: 'accept'|'reject', response: string }
function parseTransferReceiveResponse(text) {
    const t = String(text || '').trim();
    const lines = t.split(/\r?\n/).map(l => l.trim());
    const first = lines[0] || '';
    if (first.includes('拒收')) {
        const response = lines.slice(1).filter(Boolean).join(' ').trim() || '不用啦。';
        return { action: 'reject', response };
    }
    const response = (first.includes('收款') ? lines.slice(1) : lines).filter(Boolean).join(' ').trim() || '谢谢！';
    return { action: 'accept', response };
}

async function performWechatReceiveForFriendId(friendId, options) {
    const opts = options || {};
    const receiveBtnEl = opts.receiveBtn || null;
    const proactive = !!opts.proactive;

    if (isReceiving) return { ok: false, reason: 'busy' };

    if (friendId == null || friendId === '') {
        return { ok: false, reason: 'no_friend' };
    }

    let friends = loadFriendsFromStorage();
    const friend = friends.find((f) => String(f.id) === String(friendId));

    if (friend && friend.blacklisted) {
        if (!proactive) showNotification('请先解除黑名单');
        return { ok: false, reason: 'blacklisted' };
    }

    const displayNameForNotify = friend
        ? String((friend.remark || friend.nickname || '').trim() || '好友')
        : '好友';

    const proactiveEngine = !proactive && window.Wechat && Wechat.proactive;
    const manualTicket = proactiveEngine ? proactiveEngine.manualStarted(friendId) : null;
    if (manualTicket && manualTicket.busy) {
        showNotification('好友正在回复，请稍候');
        return { ok: false, reason: 'busy' };
    }
    try {

    let sendContent = null;
    let lastUserContentForPat = null;
    let pendingTransferContext = null;
    let pendingGiftContext = null;
    /** 当前会话最后一条用户消息，用于 Char 回复气泡上的「引用」快照 */
    let lastUserMessageRef = null;
    const currentChatFriend = friend;

    let isListenTogetherReceive = false;
    let listenTogetherSongName = '';
    let listenTogetherArtist = '';
    if (!proactive && listenTogetherActive) {
        const song = getMusicPlayerCurrentSong();
        if (!song) {
            showNotification('请先在灵动岛播放歌曲');
            return { ok: false, reason: 'no_song' };
        }
        sendContent = CommandManager.buildListenTogetherSendContent(friendId, song.name, song.artist, song.lyrics || '');
        lastUserContentForPat = null;
        isListenTogetherReceive = true;
        listenTogetherSongName = song.name;
        listenTogetherArtist = song.artist;
    }

    if (!sendContent) {
    const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    const lastUserMessage = chatHistory.filter(msg => msg.type === 'user').pop();
    if (lastUserMessage) {
        lastUserMessageRef = lastUserMessage;
        if (lastUserMessage.subtype === 'transfer' && lastUserMessage.transferStatus === 'pending') {
            sendContent = CommandManager.buildTransferReceiveSendContent(friendId, lastUserMessage.content);
            if (sendContent) {
                lastUserContentForPat = null;
                pendingTransferContext = { friendId, amount: parseFloat(lastUserMessage.content) || 0, timestamp: lastUserMessage.timestamp };
            }
        } else if (lastUserMessage.subtype === 'location') {
            sendContent = CommandManager.buildLocationShareSendContent(friendId, lastUserMessage.content);
        } else if (lastUserMessage.subtype === 'photo_card') {
            sendContent = CommandManager.buildPhotoCardSendContent(friendId, lastUserMessage.content);
        } else if (lastUserMessage.subtype === 'listen') {
            const m = String(lastUserMessage.content || '').match(/\[一起听\]\s*(.+?)\s*[-–—]\s*(.+)/);
            const songName = m ? m[1].trim() : '';
            const artist = m ? m[2].trim() : '';
            sendContent = CommandManager.buildListenTogetherSendContent(friendId, songName || '未知', artist || '未知', '');
        } else if (
            lastUserMessage.subtype === 'gift_bundle' &&
            lastUserMessage.giftStatus === 'pending_receive'
        ) {
            sendContent = CommandManager.buildGiftBundleReceiveSendContent(
                friendId,
                lastUserMessage.giftItems || []
            );
            if (sendContent) {
                pendingGiftContext = { friendId, timestamp: lastUserMessage.timestamp };
            }
        } else {
            const pendingUserContents = [];
            let j = chatHistory.length - 1;
            while (j >= 0 && chatHistory[j].type === 'user') {
                const entry = chatHistory[j];
                pendingUserContents.unshift(
                    typeof compactChatMessageContentForApi === 'function'
                        ? compactChatMessageContentForApi(entry)
                        : entry.content
                );
                j--;
            }
            const mentionedBooks = findMentionedBooksFromMessages(friendId, pendingUserContents);
            if (await maybeTriggerCharLoveTakeoutFromChat(friendId, lastUserMessage.content)) {
                sendContent = null;
            } else {
                const sendOpts =
                    mentionedBooks.length > 0 ? { mentionedBooks: mentionedBooks.slice() } : {};
                if (
                    typeof window !== 'undefined' &&
                    window._voiceCallFriendReplyTag &&
                    window._voiceCallFriendReplyTag.sessionId
                ) {
                    sendOpts.voicePhoneCallMode = true;
                }
                sendContent = CommandManager.buildWechatSendContent(
                    friendId,
                    lastUserMessage.content,
                    Object.keys(sendOpts).length ? sendOpts : undefined
                );
            }
        }
        lastUserContentForPat =
            pendingTransferContext || pendingGiftContext ? null : lastUserMessage.content;
    }
    }

    const receiveQuoteForFriend =
        lastUserMessageRef &&
        sendContent &&
        !pendingTransferContext &&
        !pendingGiftContext &&
        !isListenTogetherReceive
            ? buildChatQuoteSnapshot(lastUserMessageRef)
            : null;

    if (sendContent) {
        if (manualTicket && !proactiveEngine.manualValid(manualTicket)) return { ok: false, reason: 'new_message' };
        // 开始接收
        isReceiving = true;
        if (receiveBtnEl) receiveBtnEl.classList.add('loading');
        receiveController = new AbortController();
        const thisReceiveController = receiveController;
        if (manualTicket) manualTicket.controller = thisReceiveController;
        try {
            let response = null;
            if (
                proactive &&
                typeof loadProactiveAutoApiConnection === 'function'
            ) {
                const oc = loadProactiveAutoApiConnection();
                if (oc && oc.apiUrl && oc.apiKey && oc.model) {
                    response = await FeatureCommandMapper.callApiModel(
                        sendContent,
                        thisReceiveController,
                        {
                            skipOverlay: true,
                            suppressErrorDialog: true,
                            overrideConnection: oc
                        }
                    );
                }
            }
            if (!response) {
                response = await FeatureCommandMapper.callApiModel(sendContent, thisReceiveController, {
                    skipOverlay: !!proactive,
                    suppressErrorDialog: !!proactive
                });
            }
            if (thisReceiveController.signal.aborted || (manualTicket && !proactiveEngine.manualValid(manualTicket))) {
                return { ok: false, reason: 'cancelled_or_new_message' };
            }

        if (response) {
            if (pendingTransferContext) {
                const { friendId: ctxFid, amount, timestamp: transferTs } = pendingTransferContext;
                const parsed = parseTransferReceiveResponse(response);
                if (parsed.action === 'accept') {
                    updateTransferMessageStatus(ctxFid, transferTs, 'received');
                    const respTs = Date.now();
                    displayMessage('friend', parsed.response, null, respTs, ctxFid);
                    saveChatMessage(ctxFid, 'friend', parsed.response, null, respTs);
                } else {
                    updateTransferMessageStatus(ctxFid, transferTs, 'rejected');
                    addToWallet(amount);
                    const sysTs = Date.now();
                    const sysContent = '好友拒绝收款，零钱已原路返回';
                    displayMessage('system', sysContent, null, sysTs, ctxFid);
                    saveChatMessage(ctxFid, 'system', sysContent, null, sysTs);
                    const respTs = sysTs + 1;
                    displayMessage('friend', parsed.response, null, respTs, ctxFid);
                    saveChatMessage(ctxFid, 'friend', parsed.response, null, respTs);
                }
            } else if (pendingGiftContext) {
                await processGiftBundleApiResponse(
                    pendingGiftContext.friendId,
                    pendingGiftContext.timestamp,
                    response
                );
            } else if (isListenTogetherReceive && listenTogetherSongName) {
                const sysTs = Date.now();
                const sysContent = '正在一起听：' + listenTogetherSongName + ' - ' + listenTogetherArtist;
                displayMessage('system', sysContent, null, sysTs);
                saveChatMessage(friendId, 'system', sysContent, null, sysTs);
                await new Promise(resolve => setTimeout(resolve, 300));
            }
            if (!pendingTransferContext && !pendingGiftContext) {
            // 群聊：优先解析④要求的 JSON 输出，确保区分每个成员发言
            let groupJsonHandled = false;
            if (currentChatFriend && currentChatFriend.isGroup) {
                const responseForGroup = sanitizeWechatFriendApiResponseText(String(response || '')) || String(response || '');
                const parsedGroup = CommandManager._extractGroupChatMessagesFromApiText(responseForGroup);
                if (parsedGroup) {
                    const friendsNorm = loadFriendsFromStorage();
                    const gfNorm =
                        friendsNorm.find((f) => f && f.isGroup && String(f.id) === String(friendId)) || currentChatFriend;
                    const groupBatchItems = [];
                    parsedGroup.forEach((m) => {
                        const resolved =
                            gfNorm && typeof resolveGroupChatSpeakerMember === 'function'
                                ? resolveGroupChatSpeakerMember(m.speakerId, gfNorm, friendsNorm)
                                : null;
                        const sid = resolved ? String(resolved.id) : String(m.speakerId);
                        const rawLine = m.text != null ? String(m.text) : '';
                        const lead =
                            typeof tryParseLeadingFinanceJsonPayload === 'function'
                                ? tryParseLeadingFinanceJsonPayload(rawLine)
                                : null;
                        const segments = lead
                            ? [lead.jsonSource].concat(
                                  lead.rest && String(lead.rest).trim() ? [String(lead.rest).trim()] : []
                              )
                            : [rawLine];
                        segments.forEach((seg) => {
                            let body = seg;
                            let subtype = null;
                            let financeExtra = null;
                            if (typeof normalizeFriendFinanceJsonBubbleIfAny === 'function') {
                                const fin = normalizeFriendFinanceJsonBubbleIfAny(body);
                                if (fin) {
                                    body = fin.body;
                                    subtype = fin.subtype;
                                    financeExtra = fin.extra || null;
                                }
                            }
                            if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && body) {
                                body = sanitizeWechatOutgoingBubbleBody(body, subtype);
                            }
                            groupBatchItems.push({
                                text: body,
                                speakerId: sid,
                                subtype: subtype,
                                financeExtra: financeExtra
                            });
                        });
                    });
                    groupBatchItems.forEach((m) => {
                        const ex = { speakerId: m.speakerId };
                        if (m.financeExtra && typeof m.financeExtra === 'object') {
                            Object.assign(ex, m.financeExtra);
                        }
                        saveChatMessage(friendId, 'friend', m.text, null, null, m.subtype, null, ex);
                    });
                    let displayedCount = 0;
                    const rafRender = () => {
                        const chatContent = document.querySelector('.chat-content');
                        const chatPage = document.getElementById('chat-page');
                        const curFid = chatPage ? chatPage.dataset.friendId : null;
                        if (String(curFid) !== String(friendId)) return;
                        const chunk = groupBatchItems.slice(displayedCount, displayedCount + 8);
                        chunk.forEach(item => {
                            displayMessage(
                                'friend',
                                item.text,
                                null,
                                null,
                                friendId,
                                item.subtype,
                                null,
                                null,
                                null,
                                null,
                                item.speakerId
                            );
                            displayedCount++;
                        });
                        if (displayedCount < groupBatchItems.length) {
                            requestAnimationFrame(rafRender);
                        } else {
                            requestAnimationFrame(() => scrollChatContentToBottom());
                        }
                    };
                    requestAnimationFrame(rafRender);
                    groupJsonHandled = true;
                }
            }

            const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
            let allEmojis = [];
            for (const c in emojiData) allEmojis = allEmojis.concat(emojiData[c] || []);
            let messages = groupJsonHandled ? [] : splitApiResponseIntoMessages(response);
            /** 语音电话「接收」链路：不向回复串注入表情包解析结果 */
            const voiceCallPlainCharReply =
                !!(typeof window !== 'undefined' &&
                    window._voiceCallFriendReplyTag &&
                    window._voiceCallFriendReplyTag.sessionId);
            if (messages.length > 0) {
                messages = messages.map(m => {
                    if (typeof m !== 'object' || m === null) {
                        const resolved = voiceCallPlainCharReply
                            ? String(m || '')
                            : typeof resolveEmojiRefsInMessage === 'function'
                              ? resolveEmojiRefsInMessage(String(m || ''), allEmojis)
                              : String(m || '');
                        return { content: resolved, polaroidOnly: false };
                    }
                    if (m.polaroidOnly) return m;
                    const raw = m.content || '';
                    const resolved = voiceCallPlainCharReply
                        ? raw
                        : typeof resolveEmojiRefsInMessage === 'function'
                          ? resolveEmojiRefsInMessage(raw, allEmojis)
                          : raw;
                    return { content: resolved, polaroidOnly: false };
                });
            }

            if (lastUserContentForPat && !(typeof isVoicePhoneCallActive === 'function' && isVoicePhoneCallActive())) {
                checkAndTriggerPatPat(friendId, lastUserContentForPat);
                await new Promise(resolve => setTimeout(resolve, 1200));
            }

            // 逐个显示和保存消息
            if (Array.isArray(messages)) {
                // 获取好友的音色设置（提前获取，供文字消息配音用）
                const friends = loadFriendsFromStorage();
                const friend = friends.find(f => String(f.id) === String(friendId));
                const friendVoiceIdRaw = friend?.voiceId != null ? String(friend.voiceId).trim() : '';
                const friendVoiceId = friendVoiceIdRaw || null;
                const friendLanguage = String(friend?.voiceLanguage || 'zh').trim() || 'zh';

                const dialogueLines = [];
                const vcFriendSuppressBatch =
                    !!(typeof window !== 'undefined' &&
                        window._voiceCallFriendReplyTag &&
                        window._voiceCallFriendReplyTag.sessionId);

                // ── 第一步：预处理所有消息（同步，不触发布局） ───────────────
                const batchItems = [];
                let needsPolaroidPostProcess = false;
                let friendQuoteSlotLeft = receiveQuoteForFriend;
                let friendQuoteUsedInBatch = false;

                for (const msg of messages) {
                    const rawContent = typeof msg === 'string' ? msg : (msg.content || '');
                    const polaroidOnly = !!(msg && msg.polaroidOnly);
                    const timestamp = new Date().getTime();
                    let body = rawContent;
                    let friendSubtype = null;

                    // ── 拦截资金往来 JSON ─────────────────────────────
                    if (!polaroidOnly && rawContent.trim().startsWith('{')) {
                        try {
                            let parsed;
                            try {
                                parsed = JSON.parse(rawContent.trim());
                            } catch (eJson) {
                                const lead =
                                    typeof tryParseLeadingJsonObject === 'function'
                                        ? tryParseLeadingJsonObject(rawContent)
                                        : null;
                                if (!lead) throw eJson;
                                parsed = lead.parsed;
                            }
                            const t = String(parsed.type || '').trim();
                            if (vcFriendSuppressBatch && (t === 'transfer' || t === 'redpacket')) {
                                continue;
                            }
                            if (t === 'transfer') {
                                friendSubtype = 'friend_transfer';
                                let qJson = null;
                                if (friendQuoteSlotLeft && !friendQuoteUsedInBatch) {
                                    qJson = friendQuoteSlotLeft;
                                    friendQuoteUsedInBatch = true;
                                }
                                let txBody = String(parsed.content || '').trim();
                                if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && txBody) {
                                    txBody = sanitizeWechatOutgoingBubbleBody(txBody, friendSubtype);
                                }
                                saveChatMessage(friendId, 'friend', txBody, qJson, timestamp, friendSubtype);
                                batchItems.push({
                                    body: txBody,
                                    friendSubtype,
                                    polaroidOnly: false,
                                    timestamp,
                                    quote: qJson,
                                    suppressMainChat: !!vcFriendSuppressBatch
                                });
                                continue;
                            }
                            if (t === 'redpacket') {
                                friendSubtype = 'redpacket';
                                let qRp = null;
                                if (friendQuoteSlotLeft && !friendQuoteUsedInBatch) {
                                    qRp = friendQuoteSlotLeft;
                                    friendQuoteUsedInBatch = true;
                                }
                                let rpBody = String(parsed.content || '').trim();
                                if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && rpBody) {
                                    rpBody = sanitizeWechatOutgoingBubbleBody(rpBody, friendSubtype);
                                }
                                saveChatMessage(friendId, 'friend', rpBody, qRp, timestamp, friendSubtype, null, null, { redpacketMsg: String(parsed.message || '').trim() });
                                batchItems.push({
                                    body: rpBody,
                                    friendSubtype,
                                    polaroidOnly: false,
                                    timestamp,
                                    quote: qRp,
                                    suppressMainChat: !!vcFriendSuppressBatch
                                });
                                continue;
                            }
                        } catch (_) {}
                    }

                    if (polaroidOnly) {
                        if (vcFriendSuppressBatch) {
                            body = String(rawContent || '')
                                .replace(/<[^>]*>/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim()
                                .slice(0, 1800);
                            if (!body) body = '（通话中略去图片类展示）';
                            friendSubtype = null;
                        } else {
                            body = rawContent;
                            friendSubtype = 'photo_card';
                            needsPolaroidPostProcess = true;
                        }
                    } else {
                        const parsed = parseFriendPhotoCardMessage(rawContent);
                        body = parsed ? parsed.content : rawContent;
                        friendSubtype = parsed ? parsed.subtype : null;
                        if (vcFriendSuppressBatch && friendSubtype === 'photo_card') {
                            body =
                                String(body || '')
                                    .replace(/<[^>]*>/g, ' ')
                                    .replace(/\s+/g, ' ')
                                    .trim() || '（通话中略去图片类展示）';
                            friendSubtype = null;
                        }
                        if (body) {
                            const dialogues = extractDialogueFromText(body);
                            dialogueLines.push(...dialogues);
                        }
                    }

                    let qAttach = null;
                    if (friendQuoteSlotLeft && !friendQuoteUsedInBatch) {
                        qAttach = friendQuoteSlotLeft;
                        friendQuoteUsedInBatch = true;
                    }
                    if (vcFriendSuppressBatch && body) {
                        body = sanitizeFriendVoiceCallPlainText(body);
                    }
                    if (vcFriendSuppressBatch && (!body || !String(body).trim())) {
                        body = '好。';
                    }
                    if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && body) {
                        body = sanitizeWechatOutgoingBubbleBody(body, friendSubtype);
                    }
                    saveChatMessage(friendId, 'friend', body, qAttach, timestamp, friendSubtype);
                    batchItems.push({
                        body,
                        friendSubtype,
                        polaroidOnly: !!(polaroidOnly && !vcFriendSuppressBatch),
                        timestamp,
                        quote: qAttach,
                        suppressMainChat: !!vcFriendSuppressBatch
                    });
                }

                let ttsText = '';
                if (dialogueLines.length > 0) {
                    ttsText = dialogueLines.join(' ').replace(/\s+/g, ' ').trim().slice(0, 1500);
                } else {
                    const bodies = batchItems
                        .filter(
                            (i) =>
                                !i.suppressMainChat &&
                                i.body &&
                                !i.polaroidOnly &&
                                !i.friendSubtype
                        )
                        .map((i) =>
                            String(i.body)
                                .replace(/<[^>]*>/g, ' ')
                                .replace(/\s+/g, ' ')
                                .trim()
                        )
                        .filter(Boolean);
                    ttsText = bodies.join(' ').trim().slice(0, 1500);
                }

                const voiceCfg =
                    typeof collectVoiceSettings === 'function' ? collectVoiceSettings() : {};
                const minimaxReady = !!(voiceCfg && voiceCfg.groupId && voiceCfg.apiKey);

                // 心跳监控：仅在「接收」成功且本条回复已写入聊天记录后拉取；与下方 RAF 渲染并行，展开面板不会触发请求
                HeartbeatMonitor.fetchAndRender(friendId, null);

                // ── 第二步：批量渲染（非阻塞 RAF，每条直接 appendChild） ──
                let displayedCount = 0;
                const RAF_CHUNK = 8; // 每帧最多渲染 N 条（够快又不卡主线程）
                let rafId = null;

                const renderNextChunk = () => {
                    const chatContent = document.querySelector('.chat-content');
                    const chatPage = document.getElementById('chat-page');
                    const curFid = chatPage ? chatPage.dataset.friendId : null;
                    // 切走了就停
                    if (String(curFid) !== String(friendId)) {
                        if (rafId) cancelAnimationFrame(rafId);
                        return;
                    }
                    const chunk = batchItems.slice(displayedCount, displayedCount + RAF_CHUNK);
                    for (const item of chunk) {
                        displayedCount++;
                        if (!item.suppressMainChat) {
                            displayMessage(
                                'friend',
                                item.body,
                                item.quote || null,
                                item.timestamp,
                                friendId,
                                item.friendSubtype
                            );
                        }
                    }
                    if (displayedCount < batchItems.length) {
                        rafId = requestAnimationFrame(renderNextChunk);
                    } else {
                        // 全部渲染完后统一滚到底 + 拍立得后处理
                        requestAnimationFrame(() => {
                            if (needsPolaroidPostProcess) {
                                const newEls = chatContent.querySelectorAll('.chat-message.other-message');
                                newEls.forEach(el => {
                                    normalizeWechatPolaroidDom(el);
                                    attachWechatPolaroidImgGuards(el);
                                });
                            }
                            scrollChatContentToBottom();
                        });
                        // Minimax 配音（语音通话 overlay 内回复不在主界面播）；整段合成 + 气泡下「播放语音」满足移动端点击播放策略
                        if (!vcFriendSuppressBatch && ttsText && minimaxReady) {
                            const ttsOpts = { language: friendLanguage };
                            if (friendVoiceId) ttsOpts.voiceId = friendVoiceId;
                            generateVoice(ttsText, ttsOpts).then((url) => {
                                if (url) {
                                    if (typeof attachPlayableTtsToLastFriendBubble === 'function') {
                                        attachPlayableTtsToLastFriendBubble(url);
                                    } else if (typeof playVoice === 'function') {
                                        playVoice(url);
                                    }
                                } else if (typeof showNotification === 'function') {
                                    showNotification(
                                        '语音合成失败，请确认使用带 Node 的部署（含 /api/voice）、Minimax 密钥与音色 ID 正确'
                                    );
                                }
                            });
                        }
                    }
                };

                rafId = requestAnimationFrame(renderNextChunk);
            }
            }
        }
            return { ok: !!response, displayName: displayNameForNotify };
        } catch (eRecv) {
            console.error(eRecv);
            if (!proactive) showNotification('接收失败，请重试');
            return { ok: false, reason: 'error' };
        } finally {
            try {
                if (typeof window !== 'undefined' && window._voiceCallFriendReplyTag) delete window._voiceCallFriendReplyTag;
            } catch (eTag) {}
            if (receiveController === thisReceiveController) {
                isReceiving = false;
                if (receiveBtnEl) receiveBtnEl.classList.remove('loading');
                receiveController = null;
            }
        }
    } else {
        if (!proactive) showNotification('没有可接收的消息');
        try {
            if (typeof window !== 'undefined' && window._voiceCallFriendReplyTag) delete window._voiceCallFriendReplyTag;
        } catch (eTag) {}
        return { ok: false, reason: 'no_content' };
    }
    } finally {
        if (manualTicket) proactiveEngine.manualFinished(manualTicket);
    }
}

/** 更多 / 表情面板打开时，点在会话空白处收起（触摸屏上 scroll 容器内 click 常不可靠，故用 document 捕获 pointerdown） */
function ensureChatPanelOutsideDismiss() {
    var root = document.documentElement;
    if (!root || root.dataset.boundChatPanelOutsideDismiss === '1') return;
    root.dataset.boundChatPanelOutsideDismiss = '1';
    document.addEventListener(
        'pointerdown',
        function (ev) {
            if (ev.pointerType === 'mouse' && ev.button != null && ev.button !== 0) return;
            var chatPage = document.getElementById('chat-page');
            if (!chatPage || !chatPage.classList.contains('active')) return;
            var t = ev.target;
            if (!t || !t.closest) return;

            var morePanelEl = document.getElementById('chat-more-panel');
            var emojiPanelEl = document.getElementById('emoji-panel');
            var moreOpen = morePanelEl && morePanelEl.classList.contains('show');
            var emojiOpen = emojiPanelEl && emojiPanelEl.classList.contains('show');
            if (!moreOpen && !emojiOpen) return;

            if (!chatPage.contains(t)) return;

            if (t.closest('#chat-more-panel')) return;
            if (t.closest('#emoji-panel')) return;
            if (t.closest('.chat-input-area')) return;
            if (t.closest('.modal.show')) return;
            if (t.closest('.chat-multiselect-bar.show')) return;
            if (t.closest('.message-action-menu.show')) return;

            if (t.closest('.chat-content') && t.closest('.chat-message')) return;
            if (t.closest('.chat-header') && t.closest('button, summary, a, input, textarea, select, label')) return;

            if (typeof closeEmojiPanel === 'function') closeEmojiPanel();
            if (typeof closeMorePanel === 'function') closeMorePanel();
        },
        true
    );
}

function bindWechatChatPipelineDom() {
ensureChatPanelOutsideDismiss();
const chatPageRoot = document.getElementById('chat-page') || document;
// 发送按钮点击事件
const sendBtn = chatPageRoot.querySelector('.send-btn');
const chatInput = chatPageRoot.querySelector('.chat-input');
if (sendBtn && chatInput && sendBtn.dataset.boundChatSend !== '1') {
    sendBtn.dataset.boundChatSend = '1';
    if (chatInput.dataset.boundChatEnter !== '1') {
        chatInput.dataset.boundChatEnter = '1';
    }
    // 统一的消息发送逻辑（由按钮点击 / 回车键触发）
    // 核心操作（displayMessage + saveChatMessage）全部放入 requestIdleCallback 或 setTimeout defer 执行，
    // 让点击事件同步返回，避免阻塞 UI 导致整屏无响应。
    sendBtn.addEventListener('click', function() {
        const message = chatInput.value.trim();
        if (!message) return;
        const chatPage = document.getElementById('chat-page');
        const friendId = chatPage ? chatPage.dataset.friendId : null;
        if (!friendId) return;

        // 黑名单检查（只读，无写入操作）
        const friends = loadFriendsFromStorage();
        const friend = friends.find(f => f.id == friendId);
        if (friend && friend.blacklisted) {
            showNotification('请先解除黑名单');
            return;
        }

        // 引用消息
        let quote = null;
        const quoteFrame = document.getElementById('chat-quote-frame');
        if (quoteFrame && quoteFrame.classList.contains('show') && currentQuoteMessage) {
            quote = currentQuoteMessage;
            quoteFrame.classList.remove('show');
            currentQuoteMessage = null;
        }

        // 清空输入（同步执行，用户立刻看到）
        chatInput.value = '';

        // displayMessage + saveChatMessage 全部 defer，让浏览器先完成当前帧渲染
        const _fid = friendId;
        const _msg = message;
        const _quote = quote;
        const run = function() {
            const ts = new Date().getTime();
            displayMessage('user', _msg, _quote, ts);
            saveChatMessage(_fid, 'user', _msg, _quote, ts);
        };
        // 优先使用 requestIdleCallback，降低对主线程的影响
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(run, { timeout: 100 });
        } else {
            setTimeout(run, 0);
        }
    });

    // 回车键发送消息
    chatInput.addEventListener('keypress', function(e) {
        if (e.key === 'Enter') {
            sendBtn.click();
        }
    });
}

const quoteFrameForDetail = chatPageRoot.querySelector('#chat-quote-frame');
if (quoteFrameForDetail && quoteFrameForDetail.dataset.boundQuoteDetailClick !== '1') {
    quoteFrameForDetail.dataset.boundQuoteDetailClick = '1';
    quoteFrameForDetail.addEventListener('click', function (ev) {
        if (ev.target.closest('.chat-quote-close')) return;
        if (!quoteFrameForDetail.classList.contains('show')) return;
        if (typeof openChatQuoteDetailModal !== 'function') return;
        if (!currentQuoteMessage) return;
        ev.stopPropagation();
        openChatQuoteDetailModal(currentQuoteMessage);
    });
}

// 其他功能按钮：接收（表情/更多仅用 HTML onclick，勿重复绑定）
const receiveBtn = chatPageRoot.querySelector('.receive-btn');

if (receiveBtn && receiveBtn.dataset.boundChatReceive !== '1') {
    receiveBtn.dataset.boundChatReceive = '1';
    receiveBtn.addEventListener('click', async function() {
        const autoFriendId = chatPageRoot.dataset.friendId;
        if (window.Wechat && Wechat.proactive && Wechat.proactive.handleReceiveClick(autoFriendId)) return;
        if (isReceiving) {
            // 如果正在接收，取消请求
            if (receiveController) {
                receiveController.abort();
                receiveController = null;
            }
            isReceiving = false;
            receiveBtn.classList.remove('loading');
            showNotification('已取消接收');
            return;
        }
        
        // 获取当前好友ID
        const chatPage = document.getElementById('chat-page');
        const friendId = chatPage ? chatPage.dataset.friendId : null;
        
        if (!friendId) return;
        await performWechatReceiveForFriendId(String(friendId), { receiveBtn: receiveBtn, proactive: false });
    });
}



// 表情 / 更多：仅用 index.html 上的 onclick="toggleEmojiPanel()" / toggleMorePanel()
// 勿再 addEventListener，否则会与内联处理器各触发一次 → toggle 两次 ≡ 面板保持关闭。
}

// 切换表情面板
function toggleEmojiPanel() {
    if (typeof isVoicePhoneCallActive === 'function' && isVoicePhoneCallActive()) {
        try {
            closeEmojiPanel();
        } catch (eCe) {}
        showNotification('语音通话中仅可发送文字消息');
        return;
    }
    closeMorePanel();
    const emojiPanel = document.getElementById('emoji-panel');
    if (emojiPanel) {
        emojiPanel.classList.toggle('show');
    }
}

// 关闭表情面板
function closeEmojiPanel() {
    const emojiPanel = document.getElementById('emoji-panel');
    if (emojiPanel) {
        emojiPanel.classList.remove('show');
    }
}

// toggleMorePanel / closeMorePanel / onMoreItemClick：见 wechat-ui.js

// —— 聊天 · 内置拍摄（getUserMedia）——
let _chatCameraStream = null;
let _chatCameraFacingMode = 'user';

function stopChatCameraStream() {
    if (_chatCameraStream) {
        try {
            _chatCameraStream.getTracks().forEach(function (t) { t.stop(); });
        } catch (e) {}
        _chatCameraStream = null;
    }
    const video = document.getElementById('chat-camera-video');
    if (video) {
        try { video.srcObject = null; } catch (e) {}
    }
}

function _applyChatCameraMirror(video) {
    if (!video) return;
    video.style.transform = _chatCameraFacingMode === 'user' ? 'scaleX(-1)' : 'none';
}

async function startChatCameraStream() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        throw new Error('当前环境不支持摄像头');
    }
    stopChatCameraStream();
    const video = document.getElementById('chat-camera-video');
    const hint = document.getElementById('chat-camera-hint');
    if (!video) throw new Error('界面未就绪');
    const constraints = {
        audio: false,
        video: {
            facingMode: _chatCameraFacingMode,
            width: { ideal: 1280 },
            height: { ideal: 720 }
        }
    };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    _chatCameraStream = stream;
    video.srcObject = stream;
    _applyChatCameraMirror(video);
    try {
        await video.play();
    } catch (ePlay) {
        try {
            video.muted = true;
            await video.play();
        } catch (e2) {}
    }
    if (hint) hint.textContent = '对准画面后点击中间按钮拍摄';
}

function openChatCameraModal() {
    const friendId = typeof _getCurrentChatFriendId === 'function' ? _getCurrentChatFriendId() : null;
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    const modal = document.getElementById('chat-camera-modal');
    const hint = document.getElementById('chat-camera-hint');
    if (!modal) return;
    if (hint) hint.textContent = '正在启动摄像头…';
    modal.classList.add('show');
    const run = function () {
        startChatCameraStream().catch(function (err) {
            console.error(err);
            if (hint) {
                hint.textContent = '无法打开摄像头（请检查权限，并尽量使用 HTTPS 或 localhost）';
            }
            showNotification('摄像头启动失败');
        });
    };
    /* 等弹层完成布局后再取流，避免部分 WebView 中 video 尺寸为 0 或纹理白屏 */
    if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(function () {
            requestAnimationFrame(run);
        });
    } else {
        setTimeout(run, 0);
    }
}

function closeChatCameraModal() {
    const modal = document.getElementById('chat-camera-modal');
    if (modal) modal.classList.remove('show');
    stopChatCameraStream();
}

function flipChatCamera() {
    _chatCameraFacingMode = _chatCameraFacingMode === 'user' ? 'environment' : 'user';
    const hint = document.getElementById('chat-camera-hint');
    startChatCameraStream().catch(function () {
        if (hint) hint.textContent = '切换摄像头失败，请重试';
        showNotification('切换摄像头失败');
    });
}

async function captureChatCamera() {
    const video = document.getElementById('chat-camera-video');
    const friendId = typeof _getCurrentChatFriendId === 'function' ? _getCurrentChatFriendId() : null;
    if (!video || !friendId || !video.videoWidth) {
        showNotification('相机未就绪');
        return;
    }
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');
    if (!ctx) {
        showNotification('拍摄失败');
        return;
    }
    if (_chatCameraFacingMode === 'user') {
        ctx.translate(canvas.width, 0);
        ctx.scale(-1, 1);
    }
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    let dataUrl = canvas.toDataURL('image/jpeg', 0.92);
    closeChatCameraModal();
    if (typeof compressDataUrlImage === 'function') {
        try {
            dataUrl = await compressDataUrlImage(dataUrl, { maxDim: 1600, quality: 0.85, mime: 'image/jpeg' });
        } catch (e) {}
    }
    const ts = Date.now();
    const run = function () {
        if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.isActiveChatHistoryRenderingForFriend === 'function' &&
            Wechat.ui.isActiveChatHistoryRenderingForFriend(friendId)) {
            requestAnimationFrame(run);
            return;
        }
        displayMessage('user', dataUrl, null, ts);
        saveChatMessage(friendId, 'user', dataUrl, null, ts);
        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
        else if (typeof loadChatList === 'function') Promise.resolve(loadChatList()).catch(function () {});
    };
    requestAnimationFrame(run);
    showNotification('图片已发送');
}
// 管理表情：进入/退出管理模式
let emojiManageMode = false;
let emojiSelectedIndices = new Set();

function manageEmojis() {
    emojiManageMode = !emojiManageMode;
    if (!emojiManageMode) {
        emojiSelectedIndices.clear();
        exitEmojiManageMode();
    } else {
        enterEmojiManageMode();
    }
}

function enterEmojiManageMode() {
    const manageBtn = document.getElementById('emoji-manage-btn');
    const deleteBtn = document.getElementById('emoji-delete-btn');
    const panel = document.getElementById('emoji-panel');
    if (manageBtn) manageBtn.textContent = '完成';
    if (deleteBtn) {
        deleteBtn.style.display = 'inline-block';
        deleteBtn.textContent = '删除';
        deleteBtn.disabled = true;
    }
    if (panel) panel.classList.add('manage-mode');
    // 重新渲染表情列表，使点击变为勾选而非发送
    const activeCategory = document.querySelector('.emoji-category-item.active');
    if (activeCategory) updateEmojiDisplay(activeCategory.textContent);
}

function exitEmojiManageMode() {
    const manageBtn = document.getElementById('emoji-manage-btn');
    const deleteBtn = document.getElementById('emoji-delete-btn');
    const panel = document.getElementById('emoji-panel');
    if (manageBtn) manageBtn.textContent = '管理';
    if (deleteBtn) deleteBtn.style.display = 'none';
    if (panel) panel.classList.remove('manage-mode');
    const activeCategory = document.querySelector('.emoji-category-item.active');
    if (activeCategory) updateEmojiDisplay(activeCategory.textContent);
}

function toggleEmojiSelection(index) {
    if (!emojiManageMode) return;
    const idx = parseInt(index, 10);
    if (emojiSelectedIndices.has(idx)) {
        emojiSelectedIndices.delete(idx);
    } else {
        emojiSelectedIndices.add(idx);
    }
    refreshEmojiManageUI();
}

function refreshEmojiManageUI() {
    const deleteBtn = document.getElementById('emoji-delete-btn');
    if (deleteBtn) {
        const n = emojiSelectedIndices.size;
        deleteBtn.textContent = n > 0 ? `删除(${n})` : '删除';
        deleteBtn.disabled = n === 0;
    }
    document.querySelectorAll('.emoji-item.manage-mode-item').forEach(el => {
        const idx = parseInt(el.dataset.emojiIndex, 10);
        el.classList.toggle('selected', emojiSelectedIndices.has(idx));
    });
}

function deleteSelectedEmojis() {
    if (emojiSelectedIndices.size === 0) return;
    const activeCategory = document.querySelector('.emoji-category-item.active');
    if (!activeCategory) return;
    const category = activeCategory.textContent;
    let emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    const emojis = emojiData[category] || [];
    const indicesToRemove = Array.from(emojiSelectedIndices).sort((a, b) => b - a);
    indicesToRemove.forEach(i => emojis.splice(i, 1));
    emojiData[category] = emojis;
    saveJsonToStorageWithCompression(EMOJI_DATA_LS_KEY, emojiData);
    emojiSelectedIndices.clear();
    emojiManageMode = false;
    exitEmojiManageMode();
    showNotification(`已删除 ${indicesToRemove.length} 个表情`);
}

// 添加表情
function addEmoji() {
    const modal = document.getElementById('add-emoji-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 取消添加表情
function cancelAddEmoji() {
    const modal = document.getElementById('add-emoji-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    const emojiInfoInput = document.getElementById('emoji-info');
    if (emojiInfoInput) {
        emojiInfoInput.value = '';
    }
}

// 确认添加表情
function confirmAddEmoji() {
    const emojiInfoInput = document.getElementById('emoji-info');
    if (!emojiInfoInput) return;
    const emojiInfo = emojiInfoInput.value.trim();
    if (emojiInfo) {
        // 获取当前选中的表情分组
        const activeCategory = document.querySelector('.emoji-category-item.active');
        if (!activeCategory) return;

        // 处理表情信息
        processEmojiInfo(emojiInfo, activeCategory.textContent);
    } else {
        showNotification('请输入表情信息');
    }
}

// 单次批量添加表情上限
const EMOJI_BATCH_MAX = 100;

// 处理表情信息
function processEmojiInfo(emojiInfo, category) {
    const lines = emojiInfo.split('\n');
    let addedCount = 0;
    let duplicateCount = 0;
    
    let emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    if (!emojiData[category]) {
        emojiData[category] = [];
    }
    
    // 已存在的 URL 集合（当前分组内）
    const existingUrls = new Set((emojiData[category] || []).map(e => (e.url || '').trim().toLowerCase()));
    
    for (let i = 0; i < lines.length && addedCount < EMOJI_BATCH_MAX; i++) {
        const line = lines[i].trim();
        if (!line) continue;
        
        const match = line.match(/^(.*?):\s*(.*)$/);
        if (match) {
            const name = match[1].trim();
            const url = match[2].trim().replace(/\s+/g, ' ');
            if (!url) continue;
            
            const urlKey = url.toLowerCase();
            if (existingUrls.has(urlKey)) {
                duplicateCount++;
                continue;
            }
            
            existingUrls.add(urlKey);
            emojiData[category].push({
                id: Date.now() + Math.random(),
                url: url,
                name: name,
                addedAt: new Date().getTime()
            });
            addedCount++;
        }
    }
    
    if (addedCount > 0) {
        saveJsonToStorageWithCompression(EMOJI_DATA_LS_KEY, emojiData);
        updateEmojiDisplay(category);
        cancelAddEmoji();
        let msg = `成功添加 ${addedCount} 个表情`;
        if (duplicateCount > 0) {
            msg += `，${duplicateCount} 个已存在已跳过`;
        }
        if (addedCount >= EMOJI_BATCH_MAX) {
            msg += `（本次最多添加 ${EMOJI_BATCH_MAX} 个）`;
        }
        showNotification(msg);
    } else {
        const reason = duplicateCount > 0 ? `输入的 ${duplicateCount} 个表情均已存在` : '未找到有效的表情信息';
        showNotification(reason);
    }
}

// 添加表情分组
function addEmojiCategory() {
    const modal = document.getElementById('create-emoji-category-modal');
    modal.classList.add('show');
}

// 取消创建表情分组
function cancelCreateEmojiCategory() {
    const modal = document.getElementById('create-emoji-category-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    const categoryNameInput = document.getElementById('emoji-category-name');
    if (categoryNameInput) {
        categoryNameInput.value = '';
    }
}

// 确认创建表情分组
function confirmCreateEmojiCategory() {
    const categoryNameInput = document.getElementById('emoji-category-name');
    if (!categoryNameInput) return;
    const categoryName = categoryNameInput.value.trim();
    if (categoryName) {
        // 获取现有表情分组
        let emojiCategories = parseJsonFromPossiblyEncodedStorage(EMOJI_CATEGORIES_LS_KEY, []);
        
        // 检查分组名称是否已存在
        if (!emojiCategories.includes(categoryName)) {
            // 添加新分组
            emojiCategories.push(categoryName);
            saveJsonToStorageWithCompression(EMOJI_CATEGORIES_LS_KEY, emojiCategories);
            
            // 更新表情分组列表
            updateEmojiCategories();
            
            // 关闭对话框
            cancelCreateEmojiCategory();
            
            showNotification(`表情分组"${categoryName}"创建成功`);
        } else {
            showNotification('该分组名称已存在');
        }
    } else {
        showNotification('请输入分组名称');
    }
}

// 更新表情分组列表
function updateEmojiCategories() {
    const categoryContainer = document.querySelector('.emoji-category');
    if (!categoryContainer) return;
    const addButton = categoryContainer.querySelector('.emoji-category-add');
    if (!addButton) return;

    // 清空现有分组（保留添加按钮）
    while (categoryContainer.firstChild) {
        if (categoryContainer.firstChild === addButton) break;
        categoryContainer.removeChild(categoryContainer.firstChild);
    }
    
    // 获取表情分组
    let emojiCategories = parseJsonFromPossiblyEncodedStorage(EMOJI_CATEGORIES_LS_KEY, []);
    
    // 添加"未分组"选项
    const ungroupedItem = document.createElement('div');
    ungroupedItem.className = 'emoji-category-item active';
    ungroupedItem.textContent = '未分组';
    ungroupedItem.addEventListener('click', function() {
        // 移除所有分类的激活状态
        document.querySelectorAll('.emoji-category-item').forEach(item => item.classList.remove('active'));
        // 添加当前分类的激活状态
        this.classList.add('active');
        // 更新表情显示
        updateEmojiDisplay('未分组');
    });
    categoryContainer.insertBefore(ungroupedItem, addButton);
    
    // 添加其他分组
    emojiCategories.forEach(category => {
        const categoryItem = document.createElement('div');
        categoryItem.className = 'emoji-category-item';
        categoryItem.textContent = category;
        categoryItem.addEventListener('click', function() {
            // 移除所有分类的激活状态
            document.querySelectorAll('.emoji-category-item').forEach(item => item.classList.remove('active'));
            // 添加当前分类的激活状态
            this.classList.add('active');
            // 更新表情显示
            updateEmojiDisplay(category);
        });
        categoryContainer.insertBefore(categoryItem, addButton);
    });
}

// 初始化表情分组
function initEmojiCategories() {
    if (!document.querySelector('.emoji-category') || !document.querySelector('.emoji-panel-content')) {
        return;
    }

    // 确保表情分组数据存在
    if (!localStorage.getItem('emojiCategories')) {
        localStorage.setItem('emojiCategories', JSON.stringify([]));
    }

    // 确保表情数据存在
    if (!localStorage.getItem('emojiData')) {
        localStorage.setItem('emojiData', JSON.stringify({}));
    }

    // 更新表情分组列表
    updateEmojiCategories();

    // 优先显示第一个有数据的分组；若都没有，再显示当前激活项
    const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    const firstCategoryWithData = ['未分组', ...parseJsonFromPossiblyEncodedStorage(EMOJI_CATEGORIES_LS_KEY, [])]
        .find(category => Array.isArray(emojiData[category]) && emojiData[category].length > 0);

    if (firstCategoryWithData) {
        document.querySelectorAll('.emoji-category-item').forEach(item => {
            item.classList.toggle('active', item.textContent === firstCategoryWithData);
        });
        updateEmojiDisplay(firstCategoryWithData);
        return;
    }

    // 更新表情显示
    const activeCategory = document.querySelector('.emoji-category-item.active');
    if (!activeCategory) return;
    updateEmojiDisplay(activeCategory.textContent);
}

// 更新表情显示
function updateEmojiDisplay(category) {
    const emojiContent = document.querySelector('.emoji-panel-content');
    if (!emojiContent) return;
    emojiContent.dataset.currentCategory = category;
    
    // 获取表情数据
    const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    const rawEmojis = emojiData[category] || [];
    const emojis = rawEmojis.map((emoji, idx) => {
        if (typeof emoji === 'string') {
            return { url: emoji, name: `emoji-${idx}` };
        }
        if (emoji && typeof emoji === 'object') {
            return {
                url: emoji.url || emoji.src || emoji.imageUrl || '',
                name: emoji.name || emoji.title || `emoji-${idx}`
            };
        }
        return { url: '', name: `emoji-${idx}` };
    }).filter(emoji => !!emoji.url);

    if (emojis.length > 0) {
        // 显示表情网格，末尾带 + 号便于添加新表情
        let emojiGrid = '<div class="emoji-grid">';
        emojis.forEach((emoji, idx) => {
            const escapedUrl = (emoji.url || '').replace(/'/g, "\\'").replace(/"/g, '&quot;');
            const escapedName = (emoji.name || '').replace(/"/g, "&quot;");
            const safeUrl = escapedUrl.replace(/\\/g, '\\\\');
            if (emojiManageMode) {
                emojiGrid += `<div class="emoji-item manage-mode-item" data-emoji-index="${idx}" onclick="toggleEmojiSelection(${idx})"><img src="${emoji.url}" alt="${escapedName}"></div>`;
            } else {
                emojiGrid += `<div class="emoji-item" onclick="selectEmoji('${safeUrl}')"><img src="${emoji.url}" alt="${escapedName}"></div>`;
            }
        });
        // 每个分组末尾添加 + 号
        emojiGrid += `<div class="emoji-item emoji-add-item" onclick="addEmoji()"><span class="emoji-add-inline">+</span></div>`;
        emojiGrid += '</div>';
        
        emojiContent.innerHTML = emojiGrid;
        emojiContent.classList.add('has-emoji-grid');
        if (emojiManageMode) refreshEmojiManageUI();
    } else {
        // 显示空状态
        emojiContent.innerHTML = `
            <div class="emoji-empty-state">
                <div class="emoji-add-button" onclick="addEmoji()">
                    <div class="emoji-add-icon">+</div>
                </div>
                <div class="emoji-empty-text">该分组下暂无表情</div>
            </div>
        `;
        emojiContent.classList.remove('has-emoji-grid');
    }
}

// 选择表情
function selectEmoji(emojiUrl) {
    // 发送表情
    sendEmoji(emojiUrl);
    // 关闭表情面板
    closeEmojiPanel();
}

// 发送表情
function sendEmoji(emojiUrl) {
    const chatInput = document.getElementById('chat-input');
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    
    if (friendId) {
        const timestamp = new Date().getTime();
        displayMessage('user', emojiUrl, null, timestamp);
        saveChatMessage(friendId, 'user', emojiUrl, null, timestamp);
        
        // 显示发送中状态
        showNotification('表情发送中...');
        
        // 清空输入框
        chatInput.value = '';
    } else {
        showNotification('请先选择一个好友开始聊天');
    }
}
// 初始化表情面板
function initEmojiPanel() {
    // 初始化表情分组
    initEmojiCategories();
}

// 页面加载完成后初始化表情面板
document.addEventListener('DOMContentLoaded', function() {
    initEmojiPanel();
    bindWechatChatPipelineDom();
});

// 与 initApp 中 bindEvents 同期绑定（脚本在 DOMContentLoaded 之前执行，故在此由 initApp 显式调用）
if (typeof window !== 'undefined') {
  window.performWechatReceiveForFriendId = performWechatReceiveForFriendId;
  window.bindWechatChatPipelineDom = bindWechatChatPipelineDom;
  window.openChatQuoteDetailModal = openChatQuoteDetailModal;
  window.closeChatQuoteDetailModal = closeChatQuoteDetailModal;
  window.closeQuote = closeQuote;
  if (document.getElementById('chat-page')) {
    bindWechatChatPipelineDom();
  }
}

(function patchChatUiBridge() {
  var b = window.__chatUiBridge;
  if (!b) return;
  try {
    Object.defineProperty(b, 'isMultiselectMode', {
      get: function () { return isMultiselectMode; },
      enumerable: true,
      configurable: true
    });
    Object.defineProperty(b, 'currentQuoteMessage', {
      get: function () { return currentQuoteMessage; },
      set: function (v) { currentQuoteMessage = v; },
      enumerable: true,
      configurable: true
    });
  } catch (e) {}
})();
