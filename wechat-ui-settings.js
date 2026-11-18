/**
 * Lego 小手机 · 微信 UI — 聊天设置弹层 + 全局外观与「我 → 设置」页
 * 从 app.js 迁出；依赖全局 loadFriendsFromStorage、isOfflineModeEnabled、navigateTo、
 * clearChunkedStorage、invalidateChatHistoryMem、updateOfflineFloatingButtonForCurrentChat 等。
 * 加载顺序：在 app.js、wechat-wallet.js 之后（导出/导入仍用 WECHAT_LS_* 全局键名）。
 */

/**
 * 全局自定义 TTF 的 @font-face unicode-range：覆盖拉丁/希腊/西里尔/多数符号，止于 U+2FFF 之前。
 * U+3000 起为全角/CJK 标点与汉字等；不纳入自定义字体，回退为苹方/雅黑/系统无衬线，避免部分 .ttf
 * 对简体字缺形而出现「□」、乱码或异常替换字。
 */
var WECHAT_GLOBAL_FONT_UNICODE_RANGE = 'U+0000-2FFF';

/** 内置全局字体（同源，避免外链 403/防盗链） */
var WECHAT_BUNDLED_GLOBAL_FONT_PATH = '/assets/FangZhengKaiTiJianTi-1.ttf';

/** 已失效或需登录的外链字体（自动迁移为内置路径） */
var WECHAT_LEGACY_GLOBAL_FONT_URL_RE = /file\.icve\.com\.cn|2421769730088624\.ttf/i;

function isWechatBundledGlobalFontRef(ref) {
    const r = String(ref || '').trim();
    if (!r) return false;
    if (r === WECHAT_BUNDLED_GLOBAL_FONT_PATH) return true;
    return /FangZhengKaiTiJianTi-1\.ttf(\?|#|$)/i.test(r);
}

function normalizeWechatGlobalFontStorageRef(ref) {
    const r = String(ref || '').trim();
    if (!r) return '';
    if (WECHAT_LEGACY_GLOBAL_FONT_URL_RE.test(r)) return WECHAT_BUNDLED_GLOBAL_FONT_PATH;
    return r;
}

function toWechatGlobalFontLocalPath(ref) {
    const r = String(ref || '').trim();
    if (!r) return '';
    if (r.startsWith('/')) return r;
    if (/^assets\//i.test(r)) return '/' + r;
    return '';
}

function getWechatGlobalFontUnicodeRangeClause(ref) {
    if (isWechatBundledGlobalFontRef(ref)) return '';
    return 'unicode-range:' + WECHAT_GLOBAL_FONT_UNICODE_RANGE + ';';
}

function buildWechatGlobalFontFaceRule(family, src, ref) {
    const range = getWechatGlobalFontUnicodeRangeClause(ref);
    return '@font-face{font-family:' + JSON.stringify(family) + ';src:url(' + JSON.stringify(src) + ") format('truetype');font-display:swap;" + range + '}';
}

// —— 单聊/群聊 · 聊天设置（置顶、黑名单、背景、搜索、清空、删除会话）——

// 打开聊天设置模态框
async function openChatSettings(friendId) {
    const modal = document.getElementById('chat-settings-modal');
    if (modal) {
        try {
            if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
        } catch (e) {}
        // 保存当前操作的好友ID
        modal.dataset.friendId = friendId;
        const friends = loadFriendsFromStorage();
        const friend = friends.find(f => f.id == friendId);
        const isGroup = !!(friend && friend.isGroup);

        // 群聊：隐藏黑名单/朋友圈开关，显示自动聊天
        const blacklistItem = document.getElementById('chat-settings-blacklist-item');
        const momentsItem = document.getElementById('chat-settings-moments-hide-item');
        const autochatItem = document.getElementById('chat-settings-autochat-item');
        const offlineModeItem = document.getElementById('chat-settings-offline-mode-item');
        if (blacklistItem) blacklistItem.style.display = isGroup ? 'none' : '';
        if (momentsItem) momentsItem.style.display = isGroup ? 'none' : '';
        if (autochatItem) autochatItem.style.display = isGroup ? '' : 'none';
        if (offlineModeItem) offlineModeItem.style.display = isGroup ? 'none' : '';

        // 系统默认好友：隐藏删除并退出按钮
        const deleteBtn = document.getElementById('delete-and-exit-btn');
        if (deleteBtn) deleteBtn.style.display = isSystemDefaultFriend(friendId) ? 'none' : '';

        // 设置置顶状态开关
        const pinToggle = document.getElementById('pin-toggle');
        if (pinToggle && friendId) {
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                pinToggle.checked = friend.pinned || false;
            } else {
                pinToggle.checked = false;
            }
        }
        
        // 设置黑名单状态开关
        const blacklistToggle = document.getElementById('blacklist-toggle');
        if (blacklistToggle && friendId) {
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                blacklistToggle.checked = friend.blacklisted || false;
            } else {
                blacklistToggle.checked = false;
            }
        }

        const momentsHideToggle = document.getElementById('moments-hide-toggle');
        if (momentsHideToggle && friendId) {
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                momentsHideToggle.checked = !!friend.momentsHidden;
            } else {
                momentsHideToggle.checked = false;
            }
        }

        const autoChatToggle = document.getElementById('group-autochat-toggle');
        if (autoChatToggle) {
            autoChatToggle.checked = isGroup ? !!(friend && friend.groupAutoChatEnabled) : false;
        }

        const offlineToggle = document.getElementById('offline-mode-toggle');
        if (offlineToggle) {
            // isOfflineModeEnabled 定义在 wechat-ui-extras.js，弱网/缓存等原因可能未加载完成，加 typeof 兜底
            offlineToggle.checked = (!isGroup && friendId && typeof isOfflineModeEnabled === 'function')
                ? isOfflineModeEnabled(friendId)
                : false;
        }
        
        modal.classList.add('show');
    }
}

function saveOfflineModeToggleSetting() {
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    const toggle = document.getElementById('offline-mode-toggle');
    if (!friendId || !toggle) return;
    const friends = loadFriendsFromStorage();
    const f = friends.find(x => x.id == friendId);
    if (f && f.isGroup) return;
    // 线下模式相关函数定义在 wechat-ui-extras.js，弱网/缓存等原因可能未加载完成，加 typeof 兜底避免抛出未定义错误
    if (typeof _getOfflineSettingsForFriend !== 'function' || typeof _saveOfflineSettingsForFriend !== 'function') {
        showNotification('线下模式功能加载失败，请刷新页面后重试');
        return;
    }
    const s = _getOfflineSettingsForFriend(friendId);
    s.enabled = !!toggle.checked;
    _saveOfflineSettingsForFriend(friendId, s);
    showNotification(toggle.checked ? '已开启线下模式' : '已关闭线下模式');
    if (typeof updateOfflineFloatingButtonForCurrentChat === 'function') updateOfflineFloatingButtonForCurrentChat();
}

async function saveGroupAutoChatSetting() {
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    const toggle = document.getElementById('group-autochat-toggle');
    if (!friendId || !toggle) return;
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    const friends = loadFriendsFromStorage();
    const idx = friends.findIndex(f => f.id == friendId);
    if (idx === -1) return;
    if (!friends[idx].isGroup) return;
    friends[idx].groupAutoChatEnabled = !!toggle.checked;
    friends[idx].groupAutoChatLastAt = friends[idx].groupAutoChatLastAt || 0;
    try { saveFriendsToStorage(friends); } catch (e) {}
    showNotification(toggle.checked ? '已开启自动聊天' : '已关闭自动聊天');
}

// 从聊天页面打开聊天设置，并传递好友ID
function openChatSettingsWithFriendId() {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    openChatSettings(friendId);
}

// 关闭聊天设置模态框
function closeChatSettings() {
    const modal = document.getElementById('chat-settings-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 处理聊天头像点击事件
function handleChatAvatarClick() {
    const fileInput = this.querySelector('input[type="file"]');
    if (fileInput) {
        fileInput.click();
    }
}

// 更改聊天背景
function changeChatBackground() {
    const modal = document.getElementById('chat-background-modal');
    if (modal) {
        modal.classList.add('show');
        closeChatSettings();
    }
}

// 关闭聊天背景设置模态框
function closeChatBackgroundModal() {
    const modal = document.getElementById('chat-background-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 处理聊天背景上传（独立文件域 id，避免与主卡片冲突）
function handleChatBackgroundFileSelect(event) {
    const file = event.target.files[0];
    if (file) {
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
            showNotification('请选择 JPEG、PNG 或 GIF 图片');
            event.target.value = '';
            return;
        }
        // 显示加载状态
        showLoading('上传中...');

        // 读取文件
        const reader = new FileReader();
        reader.onload = function(e) {
            void (async function () {
            // 隐藏加载状态
            hideLoading();
            
            // 设置预览图片
            const backgroundUrl = e.target.result;
            const backgroundPreview = document.getElementById('background-preview');
            
            if (backgroundPreview) {
                // 移除旧的预览图片
                const oldImage = backgroundPreview.querySelector('.background-preview-image');
                if (oldImage) {
                    backgroundPreview.removeChild(oldImage);
                }
                
                // 创建新的预览图片
                const previewImage = document.createElement('img');
                previewImage.className = 'background-preview-image';
                previewImage.src = backgroundUrl;
                backgroundPreview.appendChild(previewImage);
                
                // 添加has-background类
                backgroundPreview.classList.add('has-background');
                
                // 保存背景图片到本地存储
                const chatPage = document.getElementById('chat-page');
                const friendId = chatPage ? chatPage.dataset.friendId : null;
                if (friendId) {
                    try {
                        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
                    } catch (err) {}
                    let friends = loadFriendsFromStorage();
                    const friend = friends.find(f => f.id == friendId);
                    if (friend) {
                        friend.chatBackground = backgroundUrl;
                        saveFriendsToStorage(friends);
                        
                        // 更新聊天界面背景
                        updateChatBackground(friendId, backgroundUrl);
                    }
                }
                
                showNotification('聊天背景已更新');
            }
            })();
        };
        reader.onerror = function(error) {
            hideLoading();
            console.error('文件读取错误:', error);
            showNotification('上传失败，请重试');
        };
        reader.readAsDataURL(file);
    }
    event.target.value = '';
}

// 清除聊天背景
async function clearChatBackground() {
    const backgroundPreview = document.getElementById('background-preview');
    if (backgroundPreview) {
        // 移除预览图片
        const previewImage = backgroundPreview.querySelector('.background-preview-image');
        if (previewImage) {
            backgroundPreview.removeChild(previewImage);
        }
        
        // 移除has-background类
        backgroundPreview.classList.remove('has-background');
        
        // 从本地存储中清除背景
        const chatPage = document.getElementById('chat-page');
        const friendId = chatPage ? chatPage.dataset.friendId : null;
        if (friendId) {
            try {
                if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
            } catch (e) {}
            let friends = loadFriendsFromStorage();
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                delete friend.chatBackground;
                saveFriendsToStorage(friends);
                
                // 更新聊天界面背景
                updateChatBackground(friendId, null);
            }
        }
        
        showNotification('聊天背景已清除');
    }
}

// 更新聊天界面背景
function updateChatBackground(friendId, backgroundUrl) {
    const chatPage = document.getElementById('chat-page');
    if (chatPage && chatPage.classList.contains('active')) {
        if (backgroundUrl) {
            chatPage.style.backgroundImage = `url(${backgroundUrl})`;
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
}

// 切换置顶状态
async function togglePinChat() {
    const pinToggle = document.getElementById('pin-toggle');
    if (pinToggle) {
        const isPinned = pinToggle.checked;
        
        // 获取当前好友ID
        const chatPage = document.getElementById('chat-page');
        const friendId = chatPage ? chatPage.dataset.friendId : null;
        
        if (friendId) {
            try {
                if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
            } catch (e) {}
            // 更新本地存储中的置顶状态
            let friends = loadFriendsFromStorage();
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                friend.pinned = isPinned;
                saveFriendsToStorage(friends);
                
                // 重新加载聊天列表
                Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
            }
        }
        
        showNotification(isPinned ? '已置顶聊天' : '已取消置顶');
    }
}

// 查找聊天记录
function searchChatHistory() {
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    
    if (friendId) {
        const searchModal = document.getElementById('search-chat-modal');
        if (searchModal) {
            searchModal.dataset.friendId = friendId;
            searchModal.classList.add('show');
            
            // 清空搜索框和结果
            const searchInput = document.getElementById('search-chat-input');
            const searchResults = document.getElementById('search-results');
            if (searchInput) {
                searchInput.value = '';
            }
            if (searchResults) {
                searchResults.innerHTML = '<div class="search-placeholder">搜索聊天记录</div>';
            }
            
            // 聚焦搜索框
            setTimeout(() => {
                if (searchInput) {
                    searchInput.focus();
                }
            }, 100);
        }
    }
    closeChatSettings();
}

// 关闭查找聊天记录模态框
function closeSearchChatModal() {
    const searchModal = document.getElementById('search-chat-modal');
    if (searchModal) {
        searchModal.classList.remove('show');
    }
}

// 执行搜索聊天记录
function performSearchChat() {
    const searchModal = document.getElementById('search-chat-modal');
    const friendId = searchModal ? searchModal.dataset.friendId : null;
    const searchInput = document.getElementById('search-chat-input');
    const searchResults = document.getElementById('search-results');
    
    if (!friendId || !searchInput || !searchResults) return;
    
    const searchText = searchInput.value.trim().toLowerCase();
    
    if (!searchText) {
        searchResults.innerHTML = '<div class="search-placeholder">搜索聊天记录</div>';
        return;
    }
    
    const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    const results = chatHistory.filter(msg => 
        msg.content && msg.content.toLowerCase().includes(searchText)
    );
    
    if (results.length === 0) {
        searchResults.innerHTML = '<div class="search-no-result">没有找到相关内容</div>';
        return;
    }
    
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);
    const friendName = friend?.nickname || '好友';
    
    let resultsHtml = '';
    results.forEach((msg, index) => {
        const label = msg.type === 'user' ? '我' : friendName;
        const highlightedContent = highlightText(msg.content, searchText);
        resultsHtml += `
            <div class="search-result-item" onclick="goToSearchResult(${index})" data-index="${index}">
                <div class="search-result-label">${label}</div>
                <div class="search-result-content">${highlightedContent}</div>
            </div>
        `;
    });
    
    searchResults.innerHTML = resultsHtml;
}

// 高亮搜索文本
function highlightText(text, searchText) {
    if (!searchText) return text;
    const regex = new RegExp(`(${escapeRegExp(searchText)})`, 'gi');
    return text.replace(regex, '<span class="highlight">$1</span>');
}

// 转义正则表达式特殊字符
function escapeRegExp(string) {
    return string.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// 跳转到搜索结果
function goToSearchResult(index) {
    const searchModal = document.getElementById('search-chat-modal');
    const friendId = searchModal ? searchModal.dataset.friendId : null;
    
    if (friendId) {
        closeSearchChatModal();
        showNotification('已定位到该条消息');
    }
}

// 清空聊天记录 - 显示确认提示框
function clearChatHistory() {
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    
    if (!friendId) {
        showNotification('操作失败，请重试');
        return;
    }
    
    // 保存当前好友ID到确认提示框
    const clearChatConfirmModal = document.getElementById('clear-chat-confirm-modal');
    if (clearChatConfirmModal) {
        clearChatConfirmModal.dataset.friendId = friendId;
        clearChatConfirmModal.classList.add('show');
    }
    
    // 关闭聊天设置
    closeChatSettings();
}

// 取消清空聊天记录
function cancelClearChatHistory() {
    const clearChatConfirmModal = document.getElementById('clear-chat-confirm-modal');
    if (clearChatConfirmModal) {
        clearChatConfirmModal.classList.remove('show');
    }
    
    // 重新打开聊天设置
    const friendId = clearChatConfirmModal ? clearChatConfirmModal.dataset.friendId : null;
    if (friendId) {
        openChatSettings(friendId);
    }
}

// 确认清空聊天记录
function confirmClearChatHistory() {
    const clearChatConfirmModal = document.getElementById('clear-chat-confirm-modal');
    const friendId = clearChatConfirmModal ? clearChatConfirmModal.dataset.friendId : null;
    
    if (!friendId) {
        showNotification('操作失败，请重试');
        return;
    }
    
    // 清空聊天记录（含分片键）
    try {
        clearChunkedStorage(`chatHistory_${friendId}`);
    } catch (e) {}
    try {
        localStorage.removeItem(`chatHistory_${friendId}`);
    } catch (e) {}
    try {
        invalidateChatHistoryMem(friendId);
    } catch (e) {}
    if (global.Wechat && Wechat.proactive) Wechat.proactive.historyReplaced(friendId);
    
    // 清空聊天界面
    const chatContent = document.querySelector('.chat-content');
    if (chatContent) {
        chatContent.innerHTML = '';
    }
    
    // 关闭确认提示框
    if (clearChatConfirmModal) {
        clearChatConfirmModal.classList.remove('show');
    }
    
    showNotification('聊天记录已清空');
}

// 加入黑名单
async function addToBlacklist() {
    const blacklistToggle = document.getElementById('blacklist-toggle');
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    
    if (blacklistToggle && chatSettingsModal) {
        const friendId = chatSettingsModal.dataset.friendId;
        const isBlacklisted = blacklistToggle.checked;
        
        // 保存黑名单状态到本地存储
        if (friendId) {
            try {
                if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
            } catch (e) {}
            const friends = loadFriendsFromStorage();
            const friend = friends.find(f => f.id == friendId);
            if (friend) {
                friend.blacklisted = isBlacklisted;
                saveFriendsToStorage(friends);
            }
        }
        
        showNotification(isBlacklisted ? '已加入黑名单' : '已移除黑名单');
    }
}

// 不看他的朋友圈（刷新朋友圈 API 时不带入该好友；动态流仍可按需展示已有数据）
async function saveMomentsHideSetting() {
    const modal = document.getElementById('chat-settings-modal');
    const friendId = modal ? modal.dataset.friendId : null;
    const toggle = document.getElementById('moments-hide-toggle');
    if (!friendId || !toggle) return;
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);
    if (friend) {
        friend.momentsHidden = !!toggle.checked;
        saveFriendsToStorage(friends);
        showNotification(toggle.checked ? '已开启不看他的朋友圈' : '已恢复可能参与朋友圈刷新');
    }
}

// 删除并退出 - 显示确认提示框
function deleteAndExit() {
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    
    if (!friendId) {
        showNotification('操作失败，请重试');
        return;
    }
    
    // 保存当前好友ID到确认提示框
    const deleteFriendConfirmModal = document.getElementById('delete-friend-confirm-modal');
    if (deleteFriendConfirmModal) {
        deleteFriendConfirmModal.dataset.friendId = friendId;
        deleteFriendConfirmModal.classList.add('show');
    }
    
    // 关闭聊天设置
    closeChatSettings();
}

// 取消删除并退出
function cancelDeleteFriend() {
    const deleteFriendConfirmModal = document.getElementById('delete-friend-confirm-modal');
    if (deleteFriendConfirmModal) {
        deleteFriendConfirmModal.classList.remove('show');
    }
    
    // 重新打开聊天设置
    const friendId = deleteFriendConfirmModal ? deleteFriendConfirmModal.dataset.friendId : null;
    if (friendId) {
        openChatSettings(friendId);
    }
}

// 确认删除并退出
async function confirmDeleteFriend() {
    const deleteFriendConfirmModal = document.getElementById('delete-friend-confirm-modal');
    const friendId = deleteFriendConfirmModal ? deleteFriendConfirmModal.dataset.friendId : null;

    console.log('confirmDeleteFriend - friendId:', friendId);

    if (!friendId) {
        showNotification('操作失败，请重试');
        return;
    }

    // 系统默认好友禁止删除
    if (isSystemDefaultFriend(friendId)) {
        showNotification('系统默认好友无法删除');
        deleteFriendConfirmModal && deleteFriendConfirmModal.classList.remove('show');
        return;
    }

    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}

    // 删除好友设定信息
    const friends = loadFriendsFromStorage();
    console.log('confirmDeleteFriend - 删除前的好友列表:', friends);
    
    const updatedFriends = friends.filter(f => String(f.id) !== String(friendId));
    console.log('confirmDeleteFriend - 删除后的好友列表:', updatedFriends);
    
    saveFriendsToStorage(updatedFriends);
    
    // 删除聊天记录（含分片键）
    try {
        clearChunkedStorage(`chatHistory_${friendId}`);
    } catch (e) {}
    try {
        localStorage.removeItem(`chatHistory_${friendId}`);
    } catch (e) {}
    try {
        invalidateChatHistoryMem(friendId);
    } catch (e) {}
    
    // 关闭确认提示框
    if (deleteFriendConfirmModal) {
        deleteFriendConfirmModal.classList.remove('show');
    }
    
    // 重新加载聊天列表
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
    
    // 显示成功通知并返回消息界面
    showNotification('好友已删除');
    navigateTo('wechat');
}

// —— 微信-我-设置：全局背景 / 聊天气泡 CSS / 全局字体 ——
/* var 便于 app.js 内导入/导出逻辑在同页环境下读取全局键名 */
var WECHAT_LS_GLOBAL_BG = 'wechatGlobalBackgroundImageDataUrl';
var WECHAT_LS_BUBBLE_CSS = 'wechatBubbleCustomCss';
var WECHAT_LS_GLOBAL_FONT = 'wechatGlobalFontDataUrl';
const WECHAT_FONT_MAX_BYTES = 3 * 1024 * 1024;

let wechatBubbleCssDebounceTimer = null;
let wechatFontPreviewDebounceTimer = null;

/** 当前全局背景用的 Blob URL，切换/清除时需 revoke */
let wechatGlobalBgBlobUrl = null;
/** 最近一次从 storage 应用全局字体是否失败（外链 403/跨域等） */
let wechatGlobalFontLoadFailed = false;
/** 递增序号，避免异步校验完成时覆盖较新的清除/保存操作 */
let wechatGlobalFontApplyGen = 0;

function getWechatFontProxyUrl(originalUrl) {
    return '/api/font-proxy?url=' + encodeURIComponent(String(originalUrl || '').trim());
}

async function probeWechatFontUrl(url, refForRange) {
    const u = String(url || '').trim();
    if (!u) return false;
    if (typeof FontFace !== 'function') return true;
    const probeName = 'WechatUserGlobalFontProbe_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    try {
        const opts = { style: 'normal', weight: '400' };
        const rangeClause = getWechatGlobalFontUnicodeRangeClause(refForRange != null ? refForRange : u);
        if (rangeClause) opts.unicodeRange = WECHAT_GLOBAL_FONT_UNICODE_RANGE;
        const ff = new FontFace(probeName, 'url(' + JSON.stringify(u) + ')', opts);
        await ff.load();
        return true;
    } catch (e) {
        return false;
    }
}

/** 解析可用的字体 src：data URL / 同源路径直用；http(s) 先直连，失败再走 /api/font-proxy */
async function resolveWechatGlobalFontSrc(ref) {
    const r = String(ref || '').trim();
    if (!r) return '';
    if (r.startsWith('data:')) return r;
    const localPath = toWechatGlobalFontLocalPath(r);
    if (localPath && /\.ttf(\?|#|$)/i.test(localPath)) {
        if (await probeWechatFontUrl(localPath, r)) return localPath;
        return '';
    }
    if (!/^https?:\/\//i.test(r)) return '';
    if (await probeWechatFontUrl(r, r)) return r;
    const proxy = getWechatFontProxyUrl(r);
    if (await probeWechatFontUrl(proxy, r)) return proxy;
    return '';
}

const WECHAT_GLOBAL_BG_TARGET_IDS = [
    'wechat-page',
    'wechat-discover-page',
    'wechat-me-page',
    'moments-page',
    'wallet-page',
    'favorites-page',
    'kinship-page',
    'wechat-settings-page'
];

/** 将 Data URL 转为短 Blob URL，避免超长字符串写入 CSS 变量/行内样式时被浏览器截断导致背景不显示 */
function wechatDataUrlToBlobUrl(dataUrl) {
    const comma = dataUrl.indexOf(',');
    if (comma === -1) throw new Error('invalid data url');
    const header = dataUrl.slice(0, comma);
    const dataPart = dataUrl.slice(comma + 1);
    const isBase64 = /;base64/i.test(header);
    const mimeMatch = header.match(/data:([^;,]+)/);
    const mime = mimeMatch ? mimeMatch[1] : 'image/png';
    let bytes;
    if (isBase64) {
        const binary = atob(dataPart);
        const len = binary.length;
        bytes = new Uint8Array(len);
        for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
    } else {
        bytes = new TextEncoder().encode(decodeURIComponent(dataPart));
    }
    return URL.createObjectURL(new Blob([bytes], { type: mime }));
}

function clearWechatGlobalBgInlineOnElement(el) {
    if (!el) return;
    el.style.removeProperty('background-image');
    el.style.removeProperty('background-size');
    el.style.removeProperty('background-position');
    el.style.removeProperty('background-repeat');
}

function applyWechatThemeFromStorage() {
    applyWechatGlobalBackgroundFromStorage();
    applyWechatBubbleCssFromStorage();
    void applyWechatGlobalFontFromStorage();
}

function applyWechatGlobalBackgroundFromStorage() {
    const root = document.documentElement;
    const dataUrl = parseJsonFromPossiblyEncodedStorage(WECHAT_LS_GLOBAL_BG, '') || '';

    if (wechatGlobalBgBlobUrl) {
        try {
            URL.revokeObjectURL(wechatGlobalBgBlobUrl);
        } catch (e) { /* ignore */ }
        wechatGlobalBgBlobUrl = null;
    }
    root.style.removeProperty('--wechat-global-bg-image');

    if (!dataUrl) {
        root.classList.remove('wechat-global-bg-on');
        WECHAT_GLOBAL_BG_TARGET_IDS.forEach(id => clearWechatGlobalBgInlineOnElement(document.getElementById(id)));
        return;
    }

    root.classList.add('wechat-global-bg-on');

    let bgRef = '';
    try {
        wechatGlobalBgBlobUrl = wechatDataUrlToBlobUrl(dataUrl);
        bgRef = wechatGlobalBgBlobUrl;
    } catch (e) {
        console.warn('全局背景 Blob URL 创建失败，回退为 Data URL', e);
        bgRef = dataUrl;
    }

    const cssUrl = `url(${JSON.stringify(bgRef)})`;
    WECHAT_GLOBAL_BG_TARGET_IDS.forEach(id => {
        const el = document.getElementById(id);
        if (!el) return;
        el.style.backgroundImage = cssUrl;
        el.style.backgroundSize = 'cover';
        el.style.backgroundPosition = 'center';
        el.style.backgroundRepeat = 'no-repeat';
    });
}

function applyWechatBubbleCssFromStorage() {
    let el = document.getElementById('wechat-user-bubble-css');
    if (!el) {
        el = document.createElement('style');
        el.id = 'wechat-user-bubble-css';
        document.head.appendChild(el);
    }
    el.textContent = localStorage.getItem(WECHAT_LS_BUBBLE_CSS) || '';
}

async function applyWechatGlobalFontFromStorage() {
    const gen = ++wechatGlobalFontApplyGen;
    const root = document.documentElement;
    let el = document.getElementById('wechat-user-font-style');
    if (!el) {
        el = document.createElement('style');
        el.id = 'wechat-user-font-style';
        document.head.appendChild(el);
    }
    let ref = localStorage.getItem(WECHAT_LS_GLOBAL_FONT) || '';
    const normalized = normalizeWechatGlobalFontStorageRef(ref);
    if (normalized !== ref) {
        try {
            if (normalized) localStorage.setItem(WECHAT_LS_GLOBAL_FONT, normalized);
            else localStorage.removeItem(WECHAT_LS_GLOBAL_FONT);
        } catch (e) { /* ignore */ }
        ref = normalized;
    }
    if (!ref) {
        el.textContent = '';
        root.classList.remove('wechat-global-font-on');
        wechatGlobalFontLoadFailed = false;
        return;
    }

    el.textContent = '';
    root.classList.remove('wechat-global-font-on');

    let src = await resolveWechatGlobalFontSrc(ref);
    if (!src && !isWechatBundledGlobalFontRef(ref)) {
        const bundled = WECHAT_BUNDLED_GLOBAL_FONT_PATH;
        src = await resolveWechatGlobalFontSrc(bundled);
        if (src) {
            ref = bundled;
            try {
                localStorage.setItem(WECHAT_LS_GLOBAL_FONT, bundled);
            } catch (e) { /* ignore */ }
        }
    }
    if (gen !== wechatGlobalFontApplyGen) return;

    if (!src) {
        wechatGlobalFontLoadFailed = true;
        console.warn('[Lego 小手机] 全局字体加载失败，已回退系统字体。可改用内置路径 ' + WECHAT_BUNDLED_GLOBAL_FONT_PATH + ' 或更换可用 .ttf 链接：', ref);
        refreshWechatSettingsStatus();
        return;
    }

    wechatGlobalFontLoadFailed = false;
    el.textContent = buildWechatGlobalFontFaceRule('WechatUserGlobalFont', src, ref);
    root.classList.add('wechat-global-font-on');
}

function refreshWechatSettingsStatus() {
    const bg = parseJsonFromPossiblyEncodedStorage(WECHAT_LS_GLOBAL_BG, '');
    const elBg = document.getElementById('wechat-settings-bg-status');
    if (elBg) elBg.textContent = bg ? '已设置并已应用到微信界面' : '未设置';
    const bgBlock = document.getElementById('wechat-settings-bg-preview-block');
    const bgThumb = document.getElementById('wechat-settings-bg-thumb');
    if (bgBlock && bgThumb) {
        if (bg) {
            bgThumb.src = bg;
            bgBlock.hidden = false;
        } else {
            bgThumb.removeAttribute('src');
            bgBlock.hidden = true;
        }
    }

    updateWechatBubbleCssStatusLine();

    const font = localStorage.getItem(WECHAT_LS_GLOBAL_FONT) || '';
    const elF = document.getElementById('wechat-settings-font-status');
    if (elF) {
        if (!font) elF.textContent = '未设置';
        else if (wechatGlobalFontLoadFailed) elF.textContent = '链接已保存但加载失败（请换可用链接或点「清除」）';
        else elF.textContent = '已启用并已应用到小手机';
    }
    const fontBlock = document.getElementById('wechat-settings-font-preview-block');
    if (fontBlock) fontBlock.hidden = !font;
    const urlInp = document.getElementById('wechat-global-font-url-input');
    if (urlInp) {
        if (font) {
            // 旧版可能保存的是 dataURL；此时不回填到输入框（避免超长）
            if (
                String(font).startsWith('http://') ||
                String(font).startsWith('https://') ||
                String(font).startsWith('/')
            ) {
                urlInp.value = String(font);
            } else {
                urlInp.value = '';
            }
        } else {
            urlInp.value = '';
        }
    }
}

function handleWechatGlobalBgFile(event) {
    const file = event.target.files && event.target.files[0];
    if (event.target) event.target.value = '';
    if (!file || !isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    const reader = new FileReader();
    reader.onload = function() {
        void (async function () {
            try {
                if (typeof showLoading === 'function') showLoading('处理背景图…');
                let dataUrl = reader.result;
                if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) {
                    showNotification('无法读取该图片');
                    return;
                }
                if (typeof compressDataUrlImage === 'function') {
                    dataUrl = await compressDataUrlImage(dataUrl, {
                        maxDim: 1920,
                        quality: 0.85,
                        mime: 'image/jpeg'
                    });
                }
                localStorage.setItem(WECHAT_LS_GLOBAL_BG, dataUrl);
                applyWechatGlobalBackgroundFromStorage();
                refreshWechatSettingsStatus();
                showNotification('全局背景已更新');
            } catch (e) {
                const quota =
                    typeof isQuotaExceededError === 'function' && isQuotaExceededError(e);
                showNotification(
                    quota
                        ? '浏览器存储空间不足，无法保存背景。请清理聊天记录或导出备份后删减数据再试'
                        : '保存失败，请换一张图片或稍后再试'
                );
            } finally {
                if (typeof hideLoading === 'function') hideLoading();
            }
        })();
    };
    reader.readAsDataURL(file);
}

function clearWechatGlobalBg() {
    localStorage.removeItem(WECHAT_LS_GLOBAL_BG);
    applyWechatGlobalBackgroundFromStorage();
    refreshWechatSettingsStatus();
    showNotification('已清除全局背景');
}

function syncWechatBubbleCssTextareaFromStorage() {
    const ta = document.getElementById('wechat-bubble-css-textarea');
    if (ta) ta.value = localStorage.getItem(WECHAT_LS_BUBBLE_CSS) || '';
}

function updateWechatBubbleCssStatusLine() {
    const ta = document.getElementById('wechat-bubble-css-textarea');
    const el = document.getElementById('wechat-settings-css-status');
    if (!el) return;
    const saved = localStorage.getItem(WECHAT_LS_BUBBLE_CSS) || '';
    const cur = ta ? ta.value : '';
    if (!cur.trim() && !saved.trim()) {
        el.textContent = '未填写';
        return;
    }
    if (cur === saved) {
        el.textContent = saved ? `已保存并生效（${saved.length} 字符）` : '已清空';
    } else {
        el.textContent = `未保存 · 本地 ${saved.length} 字符 · 当前 ${cur.length} 字符（编辑后已实时预览）`;
    }
}

function onWechatBubbleCssTextareaInput() {
    if (wechatBubbleCssDebounceTimer) clearTimeout(wechatBubbleCssDebounceTimer);
    wechatBubbleCssDebounceTimer = setTimeout(function() {
        wechatBubbleCssDebounceTimer = null;
        const ta = document.getElementById('wechat-bubble-css-textarea');
        if (!ta) return;
        const styleEl = document.getElementById('wechat-user-bubble-css');
        if (styleEl) styleEl.textContent = ta.value;
        updateWechatBubbleCssStatusLine();
    }, 280);
}

function applyWechatBubbleCssFromEditor() {
    const ta = document.getElementById('wechat-bubble-css-textarea');
    const text = (ta && ta.value) || '';
    try {
        localStorage.setItem(WECHAT_LS_BUBBLE_CSS, text);
        applyWechatBubbleCssFromStorage();
        updateWechatBubbleCssStatusLine();
        showNotification('聊天气泡样式已保存');
    } catch (e) {
        showNotification('保存失败');
    }
}

function clearWechatBubbleCss() {
    localStorage.removeItem(WECHAT_LS_BUBBLE_CSS);
    const ta = document.getElementById('wechat-bubble-css-textarea');
    if (ta) ta.value = '';
    applyWechatBubbleCssFromStorage();
    updateWechatBubbleCssStatusLine();
    showNotification('已清除自定义气泡样式');
}

function getWechatGlobalFontPreviewStyleEl() {
    let el = document.getElementById('wechat-user-font-preview-style');
    if (!el) {
        el = document.createElement('style');
        el.id = 'wechat-user-font-preview-style';
        document.head.appendChild(el);
    }
    return el;
}

async function tryLoadFontForPreview(url) {
    const sample = document.getElementById('wechat-settings-font-sample');
    const block = document.getElementById('wechat-settings-font-preview-block');
    if (!sample || !block) return;
    const u = String(url || '').trim();
    if (!u) {
        block.hidden = true;
        sample.style.fontFamily = '';
        getWechatGlobalFontPreviewStyleEl().textContent = '';
        return;
    }
    block.hidden = false;
    const src = await resolveWechatGlobalFontSrc(u);
    if (!src) {
        getWechatGlobalFontPreviewStyleEl().textContent = '';
        sample.style.fontFamily =
            '-apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif';
        showNotification('字体预览加载失败：链接无法访问（403/跨域/失效），请换公开 .ttf 地址');
        return;
    }
    getWechatGlobalFontPreviewStyleEl().textContent = buildWechatGlobalFontFaceRule(
        'WechatUserGlobalFontPreview',
        src,
        u
    );
    sample.style.fontFamily =
        `'WechatUserGlobalFontPreview', -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif`;
}

function onWechatGlobalFontUrlInput() {
    if (wechatFontPreviewDebounceTimer) clearTimeout(wechatFontPreviewDebounceTimer);
    wechatFontPreviewDebounceTimer = setTimeout(function () {
        wechatFontPreviewDebounceTimer = null;
        const inp = document.getElementById('wechat-global-font-url-input');
        tryLoadFontForPreview(inp ? inp.value : '');
    }, 240);
}

/** 彻底清除全局字体：含大文件分片键（app.js 的 clearChunkedStorage） */
function clearWechatGlobalFontState() {
    wechatGlobalFontApplyGen++;
    try {
        if (typeof clearChunkedStorage === 'function') {
            clearChunkedStorage(WECHAT_LS_GLOBAL_FONT);
        } else {
            try {
                localStorage.removeItem(WECHAT_LS_GLOBAL_FONT);
            } catch (e) {}
        }
    } catch (e) {}
    applyWechatGlobalFontFromStorage();
    refreshWechatSettingsStatus();
    const inp = document.getElementById('wechat-global-font-url-input');
    if (inp) inp.value = '';
    const sample = document.getElementById('wechat-settings-font-sample');
    if (sample) sample.style.fontFamily = '';
    getWechatGlobalFontPreviewStyleEl().textContent = '';
}

async function saveWechatGlobalFontUrl() {
    const inp = document.getElementById('wechat-global-font-url-input');
    const u = String((inp && inp.value) || '').trim();
    // 与「清除」等效：空内容保存 = 不再使用全局自定义字体
    if (!u) {
        clearWechatGlobalFontState();
        showNotification('已清除全局字体');
        return;
    }
    const isHttp = /^https?:\/\//i.test(u);
    const isLocal = !!toWechatGlobalFontLocalPath(u) && /\.ttf(\?|#|$)/i.test(u);
    if (!isHttp && !isLocal) {
        showNotification('请填写 http/https 链接，或本站 .ttf 路径（如 ' + WECHAT_BUNDLED_GLOBAL_FONT_PATH + '）');
        return;
    }
    if (!/\.ttf(\?|#|$)/i.test(u)) {
        showNotification('请填写 .ttf 字体链接或路径');
        return;
    }
    const saveRef = isLocal ? toWechatGlobalFontLocalPath(u) : u;
    if (typeof showLoading === 'function') showLoading('校验字体链接…');
    const src = await resolveWechatGlobalFontSrc(saveRef);
    if (typeof hideLoading === 'function') hideLoading();
    if (!src) {
        showNotification('字体无法加载（403/跨域/失效）。可使用内置 ' + WECHAT_BUNDLED_GLOBAL_FONT_PATH);
        return;
    }
    try {
        localStorage.setItem(WECHAT_LS_GLOBAL_FONT, saveRef);
        void applyWechatGlobalFontFromStorage();
        refreshWechatSettingsStatus();
        showNotification('全局字体已保存并生效');
    } catch (e) {
        showNotification('保存失败');
    }
}

function clearWechatGlobalFont() {
    clearWechatGlobalFontState();
    showNotification('已恢复默认字体');
}

function showWechatSettingsPage() {
    document.querySelector('.wechat-me-header')?.classList.add('hidden');
    document.querySelector('.wechat-me-profile')?.classList.add('hidden');
    document.querySelector('.wechat-me-functions')?.classList.add('hidden');
    document.getElementById('favorites-page')?.classList.remove('show');
    document.getElementById('wallet-page')?.classList.remove('show');
    document.getElementById('kinship-page')?.classList.remove('show');
    const p = document.getElementById('wechat-settings-page');
    if (p) {
        p.classList.add('show');
        syncWechatBubbleCssTextareaFromStorage();
        refreshWechatSettingsStatus();
    }
}

// closeWechatSettingsPage：见 wechat-ui.js

// 显示设置（微信-我）
function showSettings() {
    showWechatSettingsPage();
}

(function (g) {
  var W = g.Wechat;
  if (!W || !W.ui) return;
  Object.assign(W.ui, {
    applyWechatThemeFromStorage: typeof applyWechatThemeFromStorage === 'function' ? applyWechatThemeFromStorage : undefined,
    showWechatSettingsPage: typeof showWechatSettingsPage === 'function' ? showWechatSettingsPage : undefined,
    refreshWechatSettingsStatus: typeof refreshWechatSettingsStatus === 'function' ? refreshWechatSettingsStatus : undefined
  });
})(typeof window !== 'undefined' ? window : globalThis);
