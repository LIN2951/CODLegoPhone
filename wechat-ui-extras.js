/**
 * Lego 小手机 · 微信 UI — 收藏、线下模式、聊天记忆总结/长记忆、processFriendResponse
 * 从 app.js 迁出。依赖全局 CommandManager、FeatureCommandMapper、splitApiResponseIntoMessages、
 * formatMessageTime、escapeHtml、EMOJI_DATA_LS_KEY 等。
 * 加载顺序：在 wechat-ui-profile.js 之后。
 */

// —— 收藏（我 → 收藏）——

let currentFavoritesTab = 'all';

function getFavoritesList() {
    let list;
    try {
        list = JSON.parse(localStorage.getItem('wechatFavorites') || '[]');
        if (!Array.isArray(list)) list = [];
    } catch (e) {
        list = [];
    }
    list = list.sort((a, b) => (b.collectedAt || 0) - (a.collectedAt || 0));
    if (currentFavoritesTab === 'chat') {
        return list.filter(f => (f.sourceType || 'chat') === 'chat');
    }
    if (currentFavoritesTab === 'moments') {
        return list.filter(f => f.sourceType === 'moments');
    }
    return list;
}

function switchFavoritesTab(tab) {
    currentFavoritesTab = tab;
    document.querySelectorAll('.favorites-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    renderFavoritesList();
    if (tab === 'moments' && typeof Moments !== 'undefined' && typeof Moments.renderFeed === 'function') {
        try { Moments.renderFeed(); } catch (e) {}
    }
}

function showFavorites() {
    document.querySelector('.wechat-me-header')?.classList.add('hidden');
    document.querySelector('.wechat-me-profile')?.classList.add('hidden');
    document.querySelector('.wechat-me-functions')?.classList.add('hidden');
    document.getElementById('wechat-settings-page')?.classList.remove('show');
    const page = document.getElementById('favorites-page');
    if (page) {
        page.classList.add('show');
        renderFavoritesList();
    }
}

function closeFavoritesPage() {
    document.querySelector('.wechat-me-header')?.classList.remove('hidden');
    document.querySelector('.wechat-me-profile')?.classList.remove('hidden');
    document.querySelector('.wechat-me-functions')?.classList.remove('hidden');
    const page = document.getElementById('favorites-page');
    if (page) page.classList.remove('show');
}

function renderFavoritesList() {
    const listEl = document.getElementById('favorites-list');
    const emptyEl = document.getElementById('favorites-empty');
    if (!listEl) return;
    listEl.innerHTML = '';
    const favorites = getFavoritesList();
    if (favorites.length === 0) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    listEl.style.display = 'block';
    if (emptyEl) emptyEl.style.display = 'none';
    favorites.forEach(item => {
        const row = document.createElement('div');
        row.className = 'favorites-item';
        row.dataset.favoriteId = String(item.id);
        const contentWrap = document.createElement('div');
        contentWrap.className = 'favorites-item-content';
        const isMoments = item.sourceType === 'moments';
        if (isMoments && item.momentsData) {
            const data = item.momentsData;
            if (data.text) {
                const textDiv = document.createElement('div');
                textDiv.className = 'favorites-item-text';
                textDiv.textContent = data.text;
                contentWrap.appendChild(textDiv);
            }
            if (data.images && data.images.length > 0) {
                const imgWrap = document.createElement('div');
                imgWrap.className = 'favorites-item-images';
                data.images.forEach(url => {
                    const img = document.createElement('img');
                    img.src = url;
                    img.alt = '图片';
                    imgWrap.appendChild(img);
                });
                contentWrap.appendChild(imgWrap);
            }
            const metaDiv = document.createElement('div');
            metaDiv.className = 'favorites-item-meta';
            metaDiv.innerHTML = `朋友圈 · ${item.sourceFriendName || '未知'} · ${formatFavoriteTime(item.collectedAt)}`;
            contentWrap.appendChild(metaDiv);
        } else if (isChatEmojiContent(item.content)) {
            const img = document.createElement('img');
            img.src = item.content;
            img.alt = '表情';
            img.className = 'favorites-item-emoji';
            contentWrap.appendChild(img);
            const metaDiv = document.createElement('div');
            metaDiv.className = 'favorites-item-meta';
            metaDiv.textContent = `来自 ${item.sourceFriendName || '未知'} · ${formatFavoriteTime(item.collectedAt)}`;
            contentWrap.appendChild(metaDiv);
        } else {
            const textDiv = document.createElement('div');
            textDiv.className = 'favorites-item-text';
            textDiv.textContent = item.content || '[空消息]';
            contentWrap.appendChild(textDiv);
            const metaDiv = document.createElement('div');
            metaDiv.className = 'favorites-item-meta';
            metaDiv.textContent = `来自 ${item.sourceFriendName || '未知'} · ${formatFavoriteTime(item.collectedAt)}`;
            contentWrap.appendChild(metaDiv);
        }
        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'favorites-item-delete';
        delBtn.textContent = '删除';
        delBtn.onclick = (e) => { e.stopPropagation(); deleteFavorite(item.id); };
        row.appendChild(contentWrap);
        row.appendChild(delBtn);
        listEl.appendChild(row);
    });
}

function formatFavoriteTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const now = new Date();
    const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diff = today - new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const h = String(d.getHours()).padStart(2, '0');
    const m = String(d.getMinutes()).padStart(2, '0');
    if (diff === 0) return `今天 ${h}:${m}`;
    if (diff === 86400000) return `昨天 ${h}:${m}`;
    if (diff < 604800000) return `${['周日','周一','周二','周三','周四','周五','周六'][d.getDay()]} ${h}:${m}`;
    return `${d.getMonth() + 1}/${d.getDate()} ${h}:${m}`;
}

function deleteFavorite(id) {
    let favorites;
    try { favorites = JSON.parse(localStorage.getItem('wechatFavorites') || '[]'); if (!Array.isArray(favorites)) favorites = []; } catch (e) { favorites = []; }
    favorites = favorites.filter(f => f.id !== id);
    localStorage.setItem('wechatFavorites', JSON.stringify(favorites));
    renderFavoritesList();
}

// 显示确认删除模态框


// —— 线下模式 + 聊天记忆总结 / 长记忆 ——
// =========================
// 线下模式：设置 UI（先做界面与存储）
// =========================
const OFFLINE_MODE_SETTINGS_PREFIX = 'offlineModeSettings_';
const OFFLINE_WRITING_STYLES_LS_KEY = 'offlineWritingStyles';
const CHAT_SUMMARY_PROMPTS_LS_KEY = 'chatSummaryPrompts';
const CHAT_SUMMARY_DRAFT_PREFIX = 'chatSummaryDraft_';
const CHAT_SUMMARY_LAST_DONE_PREFIX = 'chatSummaryLastDoneRounds_';
const CHAT_LONG_MEMORIES_PREFIX = 'chatLongMemories_';
const CHAT_LONG_MEMORY_INJECT_MAX = 50;

let currentOfflineFriendId = null;
let tempOfflineSettings = null;

function _getCurrentChatFriendId() {
    const chatPage = document.getElementById('chat-page');
    return chatPage ? chatPage.dataset.friendId : null;
}

function _getOfflineSettingsKey(friendId) {
    return OFFLINE_MODE_SETTINGS_PREFIX + String(friendId);
}

function _defaultOfflineSettings() {
    return {
        enabled: false,
        outputLimit: 2000,
        friendPov: 'second',
        userPov: 'first',
        styleId: null
    };
}

function _getOfflineSettingsForFriend(friendId) {
    if (!friendId) return _defaultOfflineSettings();
    const key = _getOfflineSettingsKey(String(friendId));
    const saved = parseJsonFromPossiblyEncodedStorage(key, null);
    const base = _defaultOfflineSettings();
    const merged = Object.assign({}, base, (saved && typeof saved === 'object') ? saved : {});
    merged.enabled = !!merged.enabled;
    merged.outputLimit = _clampIntSafe(merged.outputLimit, 0, 10000, base.outputLimit);
    if (!['first', 'second', 'third'].includes(merged.friendPov)) merged.friendPov = base.friendPov;
    if (!['first', 'second', 'third'].includes(merged.userPov)) merged.userPov = base.userPov;
    return merged;
}

function _saveOfflineSettingsForFriend(friendId, settingsObj) {
    if (!friendId) return false;
    const base = _defaultOfflineSettings();
    const s = Object.assign({}, base, (settingsObj && typeof settingsObj === 'object') ? settingsObj : {});
    s.enabled = !!s.enabled;
    s.outputLimit = _clampIntSafe(s.outputLimit, 0, 10000, base.outputLimit);
    if (!['first', 'second', 'third'].includes(s.friendPov)) s.friendPov = base.friendPov;
    if (!['first', 'second', 'third'].includes(s.userPov)) s.userPov = base.userPov;
    const key = _getOfflineSettingsKey(String(friendId));
    try {
        saveJsonToStorageWithCompression(key, s);
        return true;
    } catch (e) {
        console.error('线下模式设置保存失败:', e);
        showNotification('线下模式设置保存失败，存储空间可能已满');
        return false;
    }
}

/** 文风变更后同步写入当前好友的 offlineModeSettings（避免只点「文风已保存」却未点主弹窗「保存」导致刷新丢失 styleId） */
function _persistOfflineDraftToFriendStorage() {
    const fid = currentOfflineFriendId || _getCurrentChatFriendId();
    if (!fid || !tempOfflineSettings) return;
    _syncTempOfflineFromOfflineModalDom();
    _saveOfflineSettingsForFriend(String(fid), tempOfflineSettings);
}

function isOfflineModeEnabled(friendId) {
    return !!_getOfflineSettingsForFriend(friendId).enabled;
}

function _getOfflineFloatPosKey(friendId) {
    return `offlineFloatPos_${String(friendId)}`;
}

/** Lego 主容器 #app（居中「手机框」）。悬浮按钮为 position:fixed（相对视口），必须与该矩形相交，否则会落在框外（宽屏网页端尤为明显）。 */
function _getOfflineFloatLegoScreenRect() {
    let r = null;
    try {
        const app = document.getElementById('app');
        if (app && typeof app.getBoundingClientRect === 'function') r = app.getBoundingClientRect();
    } catch (e) {
        r = null;
    }
    const ww = typeof window.innerWidth === 'number' ? window.innerWidth : 400;
    const hh = typeof window.innerHeight === 'number' ? window.innerHeight : 700;
    if (!r || !(r.width > 32) || !(r.height > 32)) {
        return { left: 0, top: 0, width: ww, height: hh, right: ww, bottom: hh };
    }
    return {
        left: r.left,
        top: r.top,
        width: r.width,
        height: r.height,
        right: r.right,
        bottom: r.bottom
    };
}

function _clampOfflineFloatBtnToLegoScreen(x, y, btn) {
    const bounds = _getOfflineFloatLegoScreenRect();
    let w = 52;
    let h = 52;
    try {
        if (btn && typeof btn.getBoundingClientRect === 'function') {
            const br = btn.getBoundingClientRect();
            if (br.width > 0) w = br.width;
            if (br.height > 0) h = br.height;
        }
    } catch (e) {}
    const margin = 6;
    let minX = bounds.left + margin;
    let maxX = bounds.left + bounds.width - w - margin;
    let minY = bounds.top + margin;
    let maxY = bounds.top + bounds.height - h - margin;
    if (!Number.isFinite(maxX) || maxX < minX) minX = maxX = bounds.left + (bounds.width - w) / 2;
    if (!Number.isFinite(maxY) || maxY < minY) minY = maxY = bounds.top + (bounds.height - h) / 2;
    const cx = Math.max(minX, Math.min(maxX, x));
    const cy = Math.max(minY, Math.min(maxY, y));
    return { x: cx, y: cy };
}

function updateOfflineFloatingButtonForCurrentChat() {
    const btn = document.getElementById('offline-float-btn');
    const fid = _getCurrentChatFriendId();
    if (!btn) return;
    if (!fid) {
        btn.style.display = 'none';
        return;
    }
    const friends = loadFriendsFromStorage();
    const f = friends.find(x => x && x.id == fid);
    const isGroup = !!(f && f.isGroup);
    const enabled = !isGroup && isOfflineModeEnabled(fid);
    btn.style.display = enabled ? '' : 'none';
    if (!enabled) return;

    const clampToLegoScreen = (x, y) => _clampOfflineFloatBtnToLegoScreen(x, y, btn);

    const applyXY = (x, y) => {
        const next = clampToLegoScreen(x, y);
        btn.style.left = `${next.x}px`;
        btn.style.top = `${next.y}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
        return next;
    };

    const computeDefaultPos = () => {
        // 默认贴近聊天内容滚动条右上侧
        const cc = document.querySelector('.chat-content');
        if (cc && typeof cc.getBoundingClientRect === 'function') {
            const r = cc.getBoundingClientRect();
            // 右侧贴近滚动条，顶部略下移以避开 header
            const x = r.right - (btn.getBoundingClientRect().width || 52) - 2;
            const y = r.top + 10;
            return clampToLegoScreen(x, y);
        }
        const fb = _getOfflineFloatLegoScreenRect();
        const bw = btn.getBoundingClientRect().width || 52;
        return clampToLegoScreen(fb.left + fb.width - bw - 10, fb.top + 96);
    };

    // 应用已保存位置；若没有，则用默认位置；同时防止越界导致溢出小屏
    try {
        const pos = parseJsonFromPossiblyEncodedStorage(_getOfflineFloatPosKey(fid), null);
        if (pos && typeof pos === 'object') {
            const x = Number(pos.x);
            const y = Number(pos.y);
            if (Number.isFinite(x) && Number.isFinite(y)) {
                const next = applyXY(x, y);
                // 若旧位置越界（或屏幕尺寸变化）则写回夹紧后的值
                if (next.x !== x || next.y !== y) {
                    saveJsonToStorageWithCompression(_getOfflineFloatPosKey(fid), { x: next.x, y: next.y, ts: Date.now() });
                }
                return;
            }
        }
    } catch (e) {}

    const d = computeDefaultPos();
    applyXY(d.x, d.y);
}

function initOfflineFloatingButtonDrag() {
    const btn = document.getElementById('offline-float-btn');
    if (!btn) return;
    if (btn.dataset.dragInit === '1') return;
    btn.dataset.dragInit = '1';

    let pressTimer = null;
    let dragging = false;
    let startX = 0;
    let startY = 0;
    let startLeft = 0;
    let startTop = 0;

    const getBtnRectLeftTop = () => {
        const r = btn.getBoundingClientRect();
        return { left: r.left, top: r.top };
    };

    const clampToLegoScreen = (x, y) => _clampOfflineFloatBtnToLegoScreen(x, y, btn);

    const onPointerMove = (e) => {
        if (!dragging) return;
        e.preventDefault();
        const dx = e.clientX - startX;
        const dy = e.clientY - startY;
        const next = clampToLegoScreen(startLeft + dx, startTop + dy);
        btn.style.left = `${next.x}px`;
        btn.style.top = `${next.y}px`;
        btn.style.right = 'auto';
        btn.style.bottom = 'auto';
    };

    const endDrag = () => {
        if (pressTimer) {
            clearTimeout(pressTimer);
            pressTimer = null;
        }
        if (!dragging) return;
        dragging = false;
        btn.classList.remove('dragging');
        try { btn.releasePointerCapture && btn.releasePointerCapture(btn._ptrId); } catch (e) {}
        btn._ptrId = null;

        // 保存位置（按聊天对象）
        const fid = _getCurrentChatFriendId();
        if (fid) {
            const rect = btn.getBoundingClientRect();
            const next = clampToLegoScreen(rect.left, rect.top);
            saveJsonToStorageWithCompression(_getOfflineFloatPosKey(fid), { x: next.x, y: next.y, ts: Date.now() });
        }
    };

    btn.addEventListener('pointerdown', (e) => {
        if (btn.style.display === 'none') return;
        // 长按进入拖拽；短按仍然走 onclick 打开设置
        startX = e.clientX;
        startY = e.clientY;
        const lt = getBtnRectLeftTop();
        startLeft = lt.left;
        startTop = lt.top;
        dragging = false;

        btn._ptrId = e.pointerId;
        try { btn.setPointerCapture && btn.setPointerCapture(e.pointerId); } catch (err) {}

        if (pressTimer) clearTimeout(pressTimer);
        pressTimer = setTimeout(() => {
            dragging = true;
            btn.classList.add('dragging');
        }, 450);
    });

    btn.addEventListener('pointermove', (e) => {
        if (!pressTimer && !dragging) return;
        // 如果手指/鼠标明显移动，就不触发 click（避免误开设置）
        const moved = Math.abs(e.clientX - startX) + Math.abs(e.clientY - startY);
        if (!dragging && moved > 10) {
            // 仍需等长按触发拖拽，这里只是抑制 click
        }
        onPointerMove(e);
    });

    btn.addEventListener('pointerup', endDrag);
    btn.addEventListener('pointercancel', endDrag);

    /** 浏览器窗口或 visualViewport 变化后 #app 矩形会变，重新夹紧避免按钮卡在框外 */
    function reflowOfflineFloatClamp() {
        try {
            updateOfflineFloatingButtonForCurrentChat();
        } catch (err) {}
    }
    window.addEventListener('resize', reflowOfflineFloatClamp, { passive: true });
    if (window.visualViewport) {
        window.visualViewport.addEventListener('resize', reflowOfflineFloatClamp, { passive: true });
    }
}
function _clampIntSafe(n, min, max, fallback) {
    const v = parseInt(n, 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

function _offlineModeModalEl() {
    return document.getElementById('offline-mode-modal');
}

/** 优先在线下模式弹窗内查找，避免与其它页面同名节点冲突 */
function _offlineOutputLimitInputEl() {
    const root = _offlineModeModalEl();
    if (root) {
        const scoped = root.querySelector('[data-offline-field="output-limit"]');
        if (scoped) return scoped;
    }
    return document.getElementById('offline-output-limit-input');
}

/**
 * 将线下模式主弹窗当前表单同步进 tempOfflineSettings。
 * 须在「选择文风」等会触发 _persistOfflineDraftToFriendStorage 的路径之前调用，
 * 否则输入框已改但内存仍为默认 outputLimit:2000，会覆盖 localStorage。
 */
function _syncTempOfflineFromOfflineModalDom() {
    if (!tempOfflineSettings) return;
    const modal = _offlineModeModalEl();
    if (!modal || !modal.classList.contains('show')) return;
    const outputInput = _offlineOutputLimitInputEl();
    const friendPov = modal.querySelector('#offline-friend-pov-select');
    const userPov = modal.querySelector('#offline-user-pov-select');
    const prevLimit = Number(tempOfflineSettings.outputLimit);
    const fallbackLimit = Number.isFinite(prevLimit) ? prevLimit : _defaultOfflineSettings().outputLimit;
    if (outputInput) {
        tempOfflineSettings.outputLimit = _clampIntSafe(outputInput.value, 0, 10000, fallbackLimit);
    }
    if (friendPov && ['first', 'second', 'third'].includes(friendPov.value)) {
        tempOfflineSettings.friendPov = friendPov.value;
    }
    if (userPov && ['first', 'second', 'third'].includes(userPov.value)) {
        tempOfflineSettings.userPov = userPov.value;
    }
}

function _bindOfflineOutputLimitLiveSync() {
    const outputInput = _offlineOutputLimitInputEl();
    if (!outputInput || outputInput.dataset.offlineLimitLiveBound === '1') return;
    outputInput.dataset.offlineLimitLiveBound = '1';
    const syncOne = () => {
        if (!tempOfflineSettings) return;
        const prev = Number(tempOfflineSettings.outputLimit);
        const fb = Number.isFinite(prev) ? prev : _defaultOfflineSettings().outputLimit;
        tempOfflineSettings.outputLimit = _clampIntSafe(outputInput.value, 0, 10000, fb);
    };
    outputInput.addEventListener('input', syncOne);
    outputInput.addEventListener('change', syncOne);
}

function _cleanAvatarDataForOffline(avatar) {
    return normalizeAvatarUrl(avatar);
}

function _renderOfflineAvatar(el, avatarUrl, fallbackText) {
    if (!el) return;
    const clean = _cleanAvatarDataForOffline(avatarUrl);
    if (clean) {
        el.innerHTML = `<img src="${clean}" alt="">`;
        return;
    }
    el.innerHTML = '';
    el.textContent = (fallbackText || '？').toString().trim().charAt(0) || '？';
}

function _getOfflineWritingStyles() {
    const styles = parseJsonFromPossiblyEncodedStorage(OFFLINE_WRITING_STYLES_LS_KEY, []);
    return Array.isArray(styles) ? styles : [];
}

function _saveOfflineWritingStyles(styles) {
    try {
        saveJsonToStorageWithCompression(OFFLINE_WRITING_STYLES_LS_KEY, Array.isArray(styles) ? styles : []);
        return true;
    } catch (e) {
        console.error('线下文风列表保存失败:', e);
        showNotification('文风保存失败，存储空间可能已满，请清理后重试');
        return false;
    }
}

function _deleteOfflineWritingStyleById(styleId) {
    const id = String(styleId);
    const styles = _getOfflineWritingStyles().filter(s => String(s.id) !== id);
    if (!_saveOfflineWritingStyles(styles)) return;
    if (tempOfflineSettings && String(tempOfflineSettings.styleId) === id) {
        tempOfflineSettings.styleId = null;
        const display = document.getElementById('offline-style-display-input');
        if (display) display.value = '';
        _persistOfflineDraftToFriendStorage();
    }
    renderOfflineStyleList();
    showNotification('文风已删除');
}

function promptDeleteOfflineWritingStyle(styleId, styleTitle) {
    const name = ((styleTitle != null ? String(styleTitle) : '').trim()) || '未命名文风';
    const msg = '确定要删除文风「' + name + '」吗？删除后不可恢复。';
    const fn = typeof showConfirmDialog === 'function'
        ? showConfirmDialog
        : (typeof window !== 'undefined' && typeof window.showConfirmDialog === 'function'
            ? window.showConfirmDialog.bind(window)
            : null);
    if (fn) {
        fn('删除文风', msg, function () {
            _deleteOfflineWritingStyleById(styleId);
        }, { variant: 'danger' });
    } else if (typeof window !== 'undefined' && typeof window.confirm === 'function' && window.confirm(msg)) {
        _deleteOfflineWritingStyleById(styleId);
    }
}

function _getOfflineStyleTitleById(styleId) {
    if (!styleId) return '';
    const styles = _getOfflineWritingStyles();
    const hit = styles.find(s => String(s.id) === String(styleId));
    return hit && hit.title ? String(hit.title) : '';
}

function _getOfflineStyleIdByTitle(title) {
    if (!title) return null;
    const styles = _getOfflineWritingStyles();
    const hit = styles.find(s => String(s.title || '') === String(title));
    return hit && hit.id ? String(hit.id) : null;
}

function openOfflineModeModal() {
    const friendId = _getCurrentChatFriendId();
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    currentOfflineFriendId = String(friendId);
    tempOfflineSettings = _getOfflineSettingsForFriend(currentOfflineFriendId);
    const hadEnabled = !!tempOfflineSettings.enabled;
    if (!hadEnabled) {
        tempOfflineSettings.enabled = true;
    }

    const modal = document.getElementById('offline-mode-modal');
    if (!modal) return;

    const outputInput = _offlineOutputLimitInputEl();
    const friendPov = modal.querySelector('#offline-friend-pov-select');
    const userPov = modal.querySelector('#offline-user-pov-select');
    const styleDisplay = modal.querySelector('#offline-style-display-input');

    if (outputInput) outputInput.value = String(_clampIntSafe(tempOfflineSettings.outputLimit, 0, 10000, 2000));
    _bindOfflineOutputLimitLiveSync();
    if (friendPov) friendPov.value = (tempOfflineSettings.friendPov || 'second');
    if (userPov) userPov.value = (tempOfflineSettings.userPov || 'first');
    if (styleDisplay) styleDisplay.value = _getOfflineStyleTitleById(tempOfflineSettings.styleId) || '';

    // 顶部卡片信息：好友/我（头像+名字）
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => String(f.id) === String(currentOfflineFriendId)) || null;

    const friendNameEl = document.getElementById('offline-friend-name');
    const userNameEl = document.getElementById('offline-user-name');
    const friendAvatarEl = document.getElementById('offline-friend-avatar');
    const userAvatarEl = document.getElementById('offline-user-avatar');

    const friendName = friend ? (friend.remark || friend.nickname || '好友') : '好友';
    if (friendNameEl) friendNameEl.textContent = friendName;

    const userInfo = parseJsonFromPossiblyEncodedStorage(USER_INFO_LS_KEY, null);
    const myProfile = parseJsonFromPossiblyEncodedStorage(MY_PROFILE_LS_KEY, null);
    const userName = (userInfo && userInfo.nickname) ? userInfo.nickname : (myProfile && myProfile.nickname ? myProfile.nickname : '我');
    if (userNameEl) userNameEl.textContent = userName;

    const friendAvatar = friend
        ? (typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(friend)
            : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || ''))
        : '';
    const userAvatar = (userInfo && userInfo.avatar) ? userInfo.avatar : (myProfile && myProfile.avatar ? myProfile.avatar : '');

    _renderOfflineAvatar(friendAvatarEl, friendAvatar, friendName);
    _renderOfflineAvatar(userAvatarEl, userAvatar, userName);

    modal.classList.add('show');
}

function closeOfflineModeModal() {
    const modal = document.getElementById('offline-mode-modal');
    if (modal) modal.classList.remove('show');
    currentOfflineFriendId = null;
    tempOfflineSettings = null;
}

function saveOfflineModeSettings() {
    if (!currentOfflineFriendId) {
        closeOfflineModeModal();
        return;
    }
    const modal = _offlineModeModalEl();
    _syncTempOfflineFromOfflineModalDom();

    const outputInput = _offlineOutputLimitInputEl();
    const friendPov = modal ? modal.querySelector('#offline-friend-pov-select') : null;
    const userPov = modal ? modal.querySelector('#offline-user-pov-select') : null;
    const styleDisplay = modal ? modal.querySelector('#offline-style-display-input') : document.getElementById('offline-style-display-input');

    tempOfflineSettings = tempOfflineSettings || _defaultOfflineSettings();
    const prevLimit = Number(tempOfflineSettings.outputLimit);
    const fallbackLimit = Number.isFinite(prevLimit) ? prevLimit : _defaultOfflineSettings().outputLimit;
    tempOfflineSettings.outputLimit = _clampIntSafe(outputInput ? outputInput.value : fallbackLimit, 0, 10000, fallbackLimit);
    tempOfflineSettings.friendPov = friendPov ? friendPov.value : tempOfflineSettings.friendPov;
    tempOfflineSettings.userPov = userPov ? userPov.value : tempOfflineSettings.userPov;
    if (styleDisplay) tempOfflineSettings.styleId = (_getOfflineStyleIdByTitle((styleDisplay.value || '').trim()) || tempOfflineSettings.styleId || null);
    if (!_saveOfflineSettingsForFriend(currentOfflineFriendId, tempOfflineSettings)) return;

    if (styleDisplay) styleDisplay.value = _getOfflineStyleTitleById(tempOfflineSettings.styleId) || '';
    closeOfflineModeModal();
    showNotification('线下模式设置已保存');
    updateOfflineFloatingButtonForCurrentChat();
}

function openOfflineStylePickerModal() {
    if (!tempOfflineSettings) {
        const fid = currentOfflineFriendId || _getCurrentChatFriendId();
        tempOfflineSettings = fid ? _getOfflineSettingsForFriend(fid) : _defaultOfflineSettings();
    }
    const modal = document.getElementById('offline-style-picker-modal');
    if (!modal) return;
    renderOfflineStyleList();
    modal.classList.add('show');
}

function closeOfflineStylePickerModal() {
    const modal = document.getElementById('offline-style-picker-modal');
    if (modal) modal.classList.remove('show');
}

function renderOfflineStyleList() {
    const listEl = document.getElementById('offline-style-list');
    const emptyEl = document.getElementById('offline-style-empty');
    if (!listEl || !emptyEl) return;

    const styles = _getOfflineWritingStyles();
    listEl.innerHTML = '';
    emptyEl.style.display = styles.length ? 'none' : 'block';

    styles.forEach(s => {
        const row = document.createElement('div');
        row.className = 'offline-style-item' + (tempOfflineSettings && String(tempOfflineSettings.styleId) === String(s.id) ? ' active' : '');

        const main = document.createElement('div');
        main.className = 'offline-style-item-main';
        main.innerHTML = `
            <div class="offline-style-name">${escapeHtml(String(s.title || '未命名文风'))}</div>
            <div class="offline-style-badge">选择</div>
        `;
        main.onclick = () => {
            if (!tempOfflineSettings) {
                const fid = currentOfflineFriendId || _getCurrentChatFriendId();
                tempOfflineSettings = fid ? _getOfflineSettingsForFriend(fid) : _defaultOfflineSettings();
            }
            tempOfflineSettings.styleId = s.id;
            const display = document.getElementById('offline-style-display-input');
            if (display) display.value = String(s.title || '');
            closeOfflineStylePickerModal();
            _persistOfflineDraftToFriendStorage();
        };

        const delBtn = document.createElement('button');
        delBtn.type = 'button';
        delBtn.className = 'offline-style-delete-btn';
        delBtn.textContent = '删除';
        delBtn.setAttribute('aria-label', '删除文风');
        delBtn.onclick = (e) => {
            e.stopPropagation();
            e.preventDefault();
            promptDeleteOfflineWritingStyle(s.id, s.title);
        };

        row.appendChild(main);
        row.appendChild(delBtn);
        listEl.appendChild(row);
    });
}

function openOfflineNewStyleModal() {
    const picker = document.getElementById('offline-style-picker-modal');
    const modal = document.getElementById('offline-style-new-modal');
    if (!modal) return;
    if (picker) picker.classList.remove('show');

    const titleInput = document.getElementById('offline-style-new-title');
    const contentInput = document.getElementById('offline-style-new-content');
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';

    modal.classList.add('show');
    setTimeout(() => titleInput && titleInput.focus(), 60);
}

function cancelOfflineNewStyle(returnToPicker) {
    const modal = document.getElementById('offline-style-new-modal');
    if (modal) modal.classList.remove('show');

    const titleInput = document.getElementById('offline-style-new-title');
    const contentInput = document.getElementById('offline-style-new-content');
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';

    if (returnToPicker) {
        const picker = document.getElementById('offline-style-picker-modal');
        if (picker) {
            renderOfflineStyleList();
            picker.classList.add('show');
        }
    }
}

function saveOfflineNewStyle() {
    const titleInput = document.getElementById('offline-style-new-title');
    const contentInput = document.getElementById('offline-style-new-content');
    const title = (titleInput ? titleInput.value : '').trim();
    const content = (contentInput ? contentInput.value : '').trim();
    if (!title || !content) {
        showNotification('请填写标题和内容');
        return;
    }
    const styles = _getOfflineWritingStyles();
    const id = 'style_' + Date.now();
    const nextStyles = [{ id, title, content, createdAt: Date.now() }].concat(styles);
    if (!_saveOfflineWritingStyles(nextStyles)) return;

    if (!tempOfflineSettings) {
        const fid = currentOfflineFriendId || _getCurrentChatFriendId();
        tempOfflineSettings = fid ? _getOfflineSettingsForFriend(fid) : _defaultOfflineSettings();
    }
    tempOfflineSettings.styleId = id;
    const display = document.getElementById('offline-style-display-input');
    if (display) display.value = title;

    _persistOfflineDraftToFriendStorage();

    cancelOfflineNewStyle(true);
    showNotification('文风已保存');
}

// =========================
// 聊天记忆总结：UI（先做界面与存储）
// =========================
let currentChatSummaryFriendId = null;
let tempChatSummaryDraft = null;
/** 'wechat_chat' | 'missing_distance_map' — 控制 saveChatSummaryDraft 从主微信还是思念距离地图取轮数 */
let _chatSummaryContentSource = 'wechat_chat';

function _loadMissingDistanceMapChatForSummary(friendId) {
    try {
        const st =
            typeof Wechat !== 'undefined' && Wechat.store && Wechat.store.coupleSpace
                ? Wechat.store.coupleSpace
                : null;
        if (!st || typeof st.getPair !== 'function') return [];
        const pair = st.getPair(String(friendId || ''));
        if (!pair || !Array.isArray(pair.missingDistanceChatHistory)) return [];
        return pair.missingDistanceChatHistory;
    } catch (e) {
        return [];
    }
}

function _getChatSummaryDraftKey(friendId) {
    return CHAT_SUMMARY_DRAFT_PREFIX + String(friendId);
}

function _getChatSummaryLastDoneKey(friendId) {
    return CHAT_SUMMARY_LAST_DONE_PREFIX + String(friendId);
}

function _getChatSummaryPrompts() {
    const arr = parseJsonFromPossiblyEncodedStorage(CHAT_SUMMARY_PROMPTS_LS_KEY, []);
    return Array.isArray(arr) ? arr : [];
}

function _saveChatSummaryPrompts(arr) {
    saveJsonToStorageWithCompression(CHAT_SUMMARY_PROMPTS_LS_KEY, Array.isArray(arr) ? arr : []);
}

function _ensureDefaultChatSummaryPrompt() {
    const arr = _getChatSummaryPrompts();
    const desiredTitle = '系统默认总结设定';
    const desiredContent =
        '* 现在停止生成任何正文创作，请对聊天记录进行总结。*\n' +
        '\n' +
        '必须遵循以下记录格式：\n' +
        '\n' +
        '【总结】\n' +
        '\n' +
        '[时间段1-时间段2]:事件描述\n' +
        '[时间段3-时间段4]:事件描述\n' +
        '……\n' +
        '\n' +
        '\n' +
        '————\n' +
        '\n' +
        '总结要求:\n' +
        '\n' +
        '- 每次事件描述尽量详细，重点描写事件本身，以及Char和user发生了什么变化\n' +
        '\n' +
        '- 每一个事件描述180字左右，对Char和user要以他们的名字进行记录\n' +
        '\n' +
        '\n' +
        '举例：\n' +
        '\n' +
        '假设Char的角色名称是König，user的设定名称是Naomi\n' +
        '\n' +
        '[2026年3月9日12:23]Naomi通过线上聊天邀请刚结束训练的König来家里品尝番茄炖牛腩，并向König发送了开启“情侣空间”的特殊邀请，König欣然接受了这份公开关系的绑定，随后迅速洗澡并赶到Naomi的公寓。\n';

    // 若用户本地已存在默认项，进行覆盖迁移，确保默认设定始终是“最新版本”
    if (arr.length > 0) {
        const idx = arr.findIndex(p => p && String(p.id) === 'default');
        if (idx !== -1) {
            const cur = arr[idx] || {};
            if (cur.title !== desiredTitle || cur.content !== desiredContent) {
                arr[idx] = { ...cur, id: 'default', title: desiredTitle, content: desiredContent };
                try { _saveChatSummaryPrompts(arr); } catch (e) {}
            }
        } else {
            arr.unshift({ id: 'default', title: desiredTitle, content: desiredContent, createdAt: Date.now() });
            try { _saveChatSummaryPrompts(arr); } catch (e) {}
        }
        return arr;
    }
    const def = {
        id: 'default',
        title: desiredTitle,
        content: desiredContent,
        createdAt: Date.now()
    };
    _saveChatSummaryPrompts([def]);
    return [def];
}

function _getChatSummaryPromptTitleById(id) {
    if (!id) return '';
    const arr = _getChatSummaryPrompts();
    const hit = arr.find(p => String(p.id) === String(id));
    return hit ? String(hit.title || '') : '';
}

function _defaultChatSummaryDraft() {
    return {
        roundsToProcess: 10,
        promptId: 'default',
        longMemoryInjectCount: 10,
        longMemoryInjectMode: 'every_round'
    };
}

function _getChatLongMemoryInjectInterval() {
    let apiSettings = {};
    try {
        apiSettings = JSON.parse(localStorage.getItem('apiSettings') || '{}');
    } catch (e) {
        apiSettings = {};
    }
    return _clampIntSafe(apiSettings.memoryCount, 1, 100, 50);
}

function _normalizeChatLongMemoryInjectMode(value) {
    return value === 'memory_rounds' ? 'memory_rounds' : 'every_round';
}

function _updateChatLongMemoryInjectHint() {
    const countInput = document.getElementById('chat-long-memory-inject-count-input');
    const modeSelect = document.getElementById('chat-long-memory-inject-mode-select');
    const countHint = document.getElementById('chat-long-memory-count-hint');
    const modeHint = document.getElementById('chat-long-memory-inject-mode-hint');
    const count = _clampIntSafe(
        countInput ? countInput.value : 10,
        0,
        CHAT_LONG_MEMORY_INJECT_MAX,
        10
    );
    const mode = _normalizeChatLongMemoryInjectMode(modeSelect ? modeSelect.value : 'every_round');
    const savedCount = currentChatSummaryFriendId
        ? _loadChatLongMemories(String(currentChatSummaryFriendId)).filter(
              (m) => m && String(m.content || '').trim()
          ).length
        : 0;

    if (countHint) {
        countHint.textContent =
            count === 0
                ? `长记忆注入已关闭；当前已保存 ${savedCount} 条长记忆。`
                : `每次取最近 ${count} 条有效长记忆；当前已保存 ${savedCount} 条，不足时注入已有全部。`;
    }
    if (modeHint) {
        if (mode === 'memory_rounds') {
            const interval = _getChatLongMemoryInjectInterval();
            modeHint.textContent =
                `跟随 API 设置中的「记忆条数」(${interval} 轮)：在第 1、${interval + 1}、${interval * 2 + 1}…轮注入。`;
        } else {
            modeHint.textContent = '每一轮正常私聊都会把长记忆作为摘要参考加入模型指令。';
        }
    }
}

function openChatSummaryModal() {
    const friendId = _getCurrentChatFriendId();
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    openChatSummaryModalForFriend(String(friendId), { source: 'wechat_chat' });
}

function openChatSummaryModalForFriend(friendId, opts) {
    const o = opts || {};
    const source = o.source === 'missing_distance_map' ? 'missing_distance_map' : 'wechat_chat';

    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    const fid = String(friendId);

    if (source === 'missing_distance_map') {
        const flat = _loadMissingDistanceMapChatForSummary(fid);
        const chatLike = Array.isArray(flat)
            ? flat.map((m) => {
                  const ty = m && String(m.type) === 'user' ? 'user' : 'friend';
                  const content = m && m.content != null ? String(m.content) : '';
                  return { type: ty, content };
              })
            : [];
        const mapRounds =
            CommandManager && typeof CommandManager._buildRoundsFromChatHistory === 'function'
                ? CommandManager._buildRoundsFromChatHistory(chatLike)
                : [];
        const totalMapRounds = Array.isArray(mapRounds) ? mapRounds.length : 0;
        if (totalMapRounds <= 0) {
            showNotification('暂无思念距离地图聊天记录可总结');
            return;
        }
    }

    currentChatSummaryFriendId = fid;
    _chatSummaryContentSource = source;
    _ensureDefaultChatSummaryPrompt();

    const modal = document.getElementById('chat-summary-modal');
    if (!modal) return;

    const saved = parseJsonFromPossiblyEncodedStorage(_getChatSummaryDraftKey(fid), null);
    tempChatSummaryDraft = Object.assign({}, _defaultChatSummaryDraft(), (saved && typeof saved === 'object') ? saved : {});
    tempChatSummaryDraft.roundsToProcess = _clampIntSafe(tempChatSummaryDraft.roundsToProcess, 1, 100, 10);
    tempChatSummaryDraft.longMemoryInjectCount = _clampIntSafe(
        tempChatSummaryDraft.longMemoryInjectCount,
        0,
        CHAT_LONG_MEMORY_INJECT_MAX,
        10
    );
    tempChatSummaryDraft.longMemoryInjectMode = _normalizeChatLongMemoryInjectMode(
        tempChatSummaryDraft.longMemoryInjectMode
    );
    if (!tempChatSummaryDraft.promptId) tempChatSummaryDraft.promptId = 'default';

    const detectEl = document.getElementById('chat-summary-detect-text');

    if (source === 'missing_distance_map') {
        const flat = _loadMissingDistanceMapChatForSummary(fid);
        const chatLike = Array.isArray(flat)
            ? flat.map((m) => {
                  const ty = m && String(m.type) === 'user' ? 'user' : 'friend';
                  const content = m && m.content != null ? String(m.content) : '';
                  return { type: ty, content };
              })
            : [];
        const mapRounds =
            CommandManager && typeof CommandManager._buildRoundsFromChatHistory === 'function'
                ? CommandManager._buildRoundsFromChatHistory(chatLike)
                : [];
        const totalRounds = Array.isArray(mapRounds) ? mapRounds.length : 0;
        if (detectEl) {
            detectEl.textContent = `当前「思念距离」地图聊天共计 ${totalRounds} 轮，请输入本次要总结处理的轮数（与主微信「记忆条数」逻辑相同：一轮 = 用户一方 + Char 一方往复）`;
        }
    } else {
        const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${fid}`, []);
        const rounds =
            CommandManager && typeof CommandManager._buildRoundsFromChatHistory === 'function'
                ? CommandManager._buildRoundsFromChatHistory(chatHistory)
                : [];
        const totalRounds = Array.isArray(rounds) ? rounds.length : 0;
        const lastDone = _clampIntSafe(parseJsonFromPossiblyEncodedStorage(_getChatSummaryLastDoneKey(fid), 0), 0, 1000000, 0);
        const newRounds = Math.max(0, totalRounds - lastDone);
        if (detectEl) detectEl.textContent = `当前检测到 ${newRounds} 轮新对话未总结，请输入本次要处理的轮数`;
    }

    const roundsInput = document.getElementById('chat-summary-rounds-input');
    if (roundsInput) roundsInput.value = String(tempChatSummaryDraft.roundsToProcess || 10);

    const longMemoryCountInput = document.getElementById('chat-long-memory-inject-count-input');
    if (longMemoryCountInput) {
        longMemoryCountInput.value = String(tempChatSummaryDraft.longMemoryInjectCount);
        longMemoryCountInput.oninput = _updateChatLongMemoryInjectHint;
    }

    const longMemoryModeSelect = document.getElementById('chat-long-memory-inject-mode-select');
    if (longMemoryModeSelect) longMemoryModeSelect.value = tempChatSummaryDraft.longMemoryInjectMode;

    const promptDisplay = document.getElementById('chat-summary-prompt-display');
    if (promptDisplay) promptDisplay.value = _getChatSummaryPromptTitleById(tempChatSummaryDraft.promptId) || '';

    _updateChatLongMemoryInjectHint();
    modal.classList.add('show');
}

function _getChatLongMemoriesKey(friendId) {
    return CHAT_LONG_MEMORIES_PREFIX + String(friendId);
}

function _loadChatLongMemories(friendId) {
    const arr = parseJsonFromPossiblyEncodedStorage(_getChatLongMemoriesKey(friendId), []);
    return Array.isArray(arr) ? arr : [];
}

function _saveChatLongMemories(friendId, arr) {
    const key = _getChatLongMemoriesKey(friendId);
    let list = Array.isArray(arr) ? arr.slice() : [];
    let trimmed = 0;
    while (true) {
        try {
            saveJsonToStorageWithCompression(key, list);
            if (trimmed > 0) {
                showNotification(`存储空间紧张，已自动删除最旧的 ${trimmed} 条长记忆以腾出空间`);
            }
            return;
        } catch (e) {
            if (!isQuotaExceededError(e)) throw e;
            if (list.length <= 1) {
                try {
                    clearChunkedStorage(key);
                    localStorage.removeItem(key);
                    saveJsonToStorageWithCompression(key, list);
                    return;
                } catch (e2) {
                    showErrorDialog(
                        '存储空间不足',
                        '浏览器 localStorage 已满，无法保存长记忆。请尝试：清理浏览器站点数据、导出备份后删除部分聊天记录或图片，或换用隐私模式测试。'
                    );
                    throw e2;
                }
            }
            list.pop();
            trimmed++;
        }
    }
}

let _currentLongMemoryEditId = null;

function openChatLongMemoryModalForFriend(friendId) {
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    currentChatSummaryFriendId = String(friendId);
    const modal = document.getElementById('chat-long-memory-modal');
    if (!modal) return;

    const friends = loadFriendsFromStorage();
    const f = friends.find((x) => x && String(x.id) === String(friendId));
    const name = (f ? (f.remark || f.nickname || '好友') : '好友').trim() || '好友';
    const titleEl = document.getElementById('chat-long-memory-title');
    if (titleEl) titleEl.textContent = `${name}的长记忆`;

    renderChatLongMemoryList(String(friendId));
    modal.classList.add('show');
}

function openChatLongMemoryModal() {
    const friendId = _getCurrentChatFriendId();
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    openChatLongMemoryModalForFriend(String(friendId));
}

function closeChatLongMemoryModal() {
    const modal = document.getElementById('chat-long-memory-modal');
    if (modal) modal.classList.remove('show');
}

function openChatSummaryModalFromLongMemory() {
    // 右上角编辑按钮：打开“聊天记忆总结”操作界面
    if (!currentChatSummaryFriendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    openChatSummaryModalForFriend(String(currentChatSummaryFriendId), { source: 'wechat_chat' });
}

function renderChatLongMemoryList(friendId) {
    const listEl = document.getElementById('chat-long-memory-list');
    const emptyEl = document.getElementById('chat-long-memory-empty');
    if (!listEl || !emptyEl) return;
    const arr = _loadChatLongMemories(friendId);
    listEl.innerHTML = '';
    emptyEl.style.display = arr.length ? 'none' : 'block';
    if (!arr.length) return;

    arr.forEach((m) => {
        const card = document.createElement('div');
        card.className = 'chat-long-memory-card';
        const when = m && m.createdAt ? formatMessageTime(m.createdAt) : '';
        const meta = when ? `更新于 ${when}` : '长记忆';

        card.innerHTML = `
            <div class="chat-long-memory-card-top">
                <div class="chat-long-memory-card-meta">${escapeHtml(meta)}</div>
                <div class="chat-long-memory-card-actions">
                    <button type="button" class="chat-long-memory-icon-btn" data-action="edit" aria-label="编辑">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M12 20h9"/>
                            <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
                        </svg>
                    </button>
                    <button type="button" class="chat-long-memory-icon-btn danger" data-action="delete" aria-label="删除">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                            <path d="M3 6h18"/>
                            <path d="M8 6V4h8v2"/>
                            <path d="M19 6l-1 14H6L5 6"/>
                            <path d="M10 11v6"/>
                            <path d="M14 11v6"/>
                        </svg>
                    </button>
                </div>
            </div>
            <div class="chat-long-memory-card-body">${escapeHtml(String((m && m.content) || ''))}</div>
        `;

        const btnEdit = card.querySelector('[data-action="edit"]');
        const btnDel = card.querySelector('[data-action="delete"]');
        if (btnEdit) {
            btnEdit.onclick = () => openChatLongMemoryEditModal(friendId, String(m.id || ''));
        }
        if (btnDel) {
            btnDel.onclick = () => deleteChatLongMemoryItem(friendId, String(m.id || ''));
        }
        listEl.appendChild(card);
    });
}

function openChatLongMemoryEditModal(friendId, memoryId) {
    const modal = document.getElementById('chat-long-memory-edit-modal');
    const textarea = document.getElementById('chat-long-memory-edit-textarea');
    if (!modal || !textarea) return;
    const arr = _loadChatLongMemories(friendId);
    const item = arr.find(x => String(x.id) === String(memoryId));
    if (!item) return;
    _currentLongMemoryEditId = String(memoryId);
    textarea.value = String(item.content || '');
    modal.dataset.friendId = String(friendId);
    modal.classList.add('show');
    setTimeout(() => textarea.focus(), 60);
}

function closeChatLongMemoryEditModal() {
    const modal = document.getElementById('chat-long-memory-edit-modal');
    const textarea = document.getElementById('chat-long-memory-edit-textarea');
    if (modal) modal.classList.remove('show');
    if (textarea) textarea.value = '';
    _currentLongMemoryEditId = null;
}

function saveChatLongMemoryEdit() {
    const modal = document.getElementById('chat-long-memory-edit-modal');
    const friendId = modal ? modal.dataset.friendId : null;
    const textarea = document.getElementById('chat-long-memory-edit-textarea');
    if (!friendId || !textarea || !_currentLongMemoryEditId) return;
    const content = (textarea.value || '').trim();
    const arr = _loadChatLongMemories(friendId);
    const idx = arr.findIndex(x => String(x.id) === String(_currentLongMemoryEditId));
    if (idx === -1) return;
    arr[idx] = { ...arr[idx], content, createdAt: Date.now() };
    try {
        _saveChatLongMemories(friendId, arr);
    } catch (e) {
        showNotification('保存失败，存储空间可能已满');
        return;
    }
    closeChatLongMemoryEditModal();
    renderChatLongMemoryList(friendId);
    showNotification('已保存');
}

function deleteChatLongMemoryItem(friendId, memoryId) {
    const ok = window.confirm('确定删除这条长记忆吗？');
    if (!ok) return;
    const arr = _loadChatLongMemories(friendId).filter(x => String(x.id) !== String(memoryId));
    try {
        _saveChatLongMemories(friendId, arr);
    } catch (e) {
        showNotification('删除后保存失败，请重试');
        return;
    }
    renderChatLongMemoryList(friendId);
    showNotification('已删除');
}

function closeChatSummaryModal() {
    const modal = document.getElementById('chat-summary-modal');
    if (modal) modal.classList.remove('show');
    currentChatSummaryFriendId = null;
    tempChatSummaryDraft = null;
    _chatSummaryContentSource = 'wechat_chat';
}

function saveChatSummaryDraft() {
    (async () => {
        if (!currentChatSummaryFriendId) return closeChatSummaryModal();
        const friendId = String(currentChatSummaryFriendId);
        const summarySourceAtStart = _chatSummaryContentSource || 'wechat_chat';
        const roundsInput = document.getElementById('chat-summary-rounds-input');
        const roundsToProcess = _clampIntSafe(roundsInput ? roundsInput.value : '', 1, 100, 10);
        const longMemoryCountInput = document.getElementById('chat-long-memory-inject-count-input');
        const longMemoryModeSelect = document.getElementById('chat-long-memory-inject-mode-select');
        const longMemoryInjectCount = _clampIntSafe(
            longMemoryCountInput ? longMemoryCountInput.value : '',
            0,
            CHAT_LONG_MEMORY_INJECT_MAX,
            10
        );
        const longMemoryInjectMode = _normalizeChatLongMemoryInjectMode(
            longMemoryModeSelect ? longMemoryModeSelect.value : 'every_round'
        );

        tempChatSummaryDraft = tempChatSummaryDraft || _defaultChatSummaryDraft();
        tempChatSummaryDraft.roundsToProcess = roundsToProcess;
        tempChatSummaryDraft.longMemoryInjectCount = longMemoryInjectCount;
        tempChatSummaryDraft.longMemoryInjectMode = longMemoryInjectMode;

        // 保存草稿（设定/轮数）
        saveJsonToStorageWithCompression(_getChatSummaryDraftKey(friendId), tempChatSummaryDraft);

        // 组装要发给模型的内容：
        // - 总结提示设定（原文）
        // - 最新 N 轮聊天内容
        const prompts = _ensureDefaultChatSummaryPrompt();
        const prompt = prompts.find(p => String(p.id) === String(tempChatSummaryDraft.promptId)) || prompts[0];
        const promptTitle = prompt ? String(prompt.title || '') : '';
        const promptContent = prompt ? String(prompt.content || '') : '';

        // 取 Char/User 名称与角色卡（否则模型容易用 User/Char 占位）
        const friends = loadFriendsFromStorage();
        const friend = friends.find(f => f && String(f.id) === String(friendId)) || null;
        const charName = friend ? String((friend.remark || friend.nickname || 'Char')).trim() || 'Char' : 'Char';
        const charRoleCard = friend ? String(friend.roleSetting || friend.role || '无') : '无';
        const myProfile = parseJsonFromPossiblyEncodedStorage(MY_PROFILE_LS_KEY, null);
        const userPersona = friend ? (friend.persona || myProfile) : myProfile;
        const userName = userPersona && userPersona.nickname ? String(userPersona.nickname).trim() : (myProfile && myProfile.nickname ? String(myProfile.nickname).trim() : 'user');
        const userRoleCard = userPersona
            ? `昵称: ${userPersona.nickname || ''}\n身份: ${userPersona.identity || ''}`
            : `昵称: ${userName}\n身份: `;

        let chatHistory;
        let roundsAll;
        let totalRounds;

        if (summarySourceAtStart === 'missing_distance_map') {
            const flat = _loadMissingDistanceMapChatForSummary(friendId);
            chatHistory = Array.isArray(flat)
                ? flat.map((m) => {
                      const ty = m && String(m.type) === 'user' ? 'user' : 'friend';
                      const content = m && m.content != null ? String(m.content) : '';
                      return { type: ty, content };
                  })
                : [];
            roundsAll =
                CommandManager && typeof CommandManager._buildRoundsFromChatHistory === 'function'
                    ? CommandManager._buildRoundsFromChatHistory(chatHistory)
                    : [];
            totalRounds = Array.isArray(roundsAll) ? roundsAll.length : 0;
        } else {
            chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
            roundsAll =
                CommandManager && typeof CommandManager._buildRoundsFromChatHistory === 'function'
                    ? CommandManager._buildRoundsFromChatHistory(chatHistory)
                    : [];
            totalRounds = Array.isArray(roundsAll) ? roundsAll.length : 0;
        }
        const pickN = Math.min(roundsToProcess, totalRounds);
        const roundsPicked = Array.isArray(roundsAll) ? roundsAll.slice(-pickN) : [];

        // emoji 格式化（复用现有格式化逻辑，让表情URL更可读）
        const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
        let allEmojis = [];
        for (const category in (emojiData || {})) {
            allEmojis = allEmojis.concat((emojiData || {})[category] || []);
        }
        const fmt = (c) => typeof formatMessageForApi === 'function' ? formatMessageForApi(c, allEmojis) : c;

        const lines = [];
        roundsPicked.forEach((r, idx) => {
            const rn = totalRounds - pickN + idx + 1;
            lines.push(`【第${rn}轮】`);
            (r.user || []).forEach((it) => {
                const compact =
                    typeof compactChatMessageContentForApi === 'function'
                        ? compactChatMessageContentForApi(it)
                        : String((it && it.content) || '');
                lines.push(`用户: ${fmt(compact)}`);
            });
            (r.friend || []).forEach((it) => {
                const compact =
                    typeof compactChatMessageContentForApi === 'function'
                        ? compactChatMessageContentForApi(it)
                        : String((it && it.content) || '');
                lines.push(`好友: ${fmt(compact)}`);
            });
            lines.push('');
        });

        const transcriptHead =
            summarySourceAtStart === 'missing_distance_map'
                ? `【数据来源：情侣空间「思念距离」地图聊天界面｜所选轮次的对话摘录】`
                : `【用户设定需要处理的记忆轮数内容聊天记录内容】`;

        const sendContent =
            `【好友角色卡+用户角色卡】\n` +
            `Char名称: ${charName}\n` +
            `user名称: ${userName}\n` +
            `\n---\n【Char角色卡】\n${charRoleCard || '无'}\n` +
            `\n---\n【user角色卡】\n${userRoleCard || '无'}\n` +
            (summarySourceAtStart === 'missing_distance_map'
                ? `\n\n---\n【说明】本条总结仅针对地图上纯文字会话；可作为主微信接续记忆注入，避免与气泡术/表情占位混淆。\n`
                : `\n`) +
            `\n\n---\n${transcriptHead}\n` +
            `${lines.join('\n').trim() || '（无可用对话轮）'}\n` +
            `\n---\n【系统默认总结设定】${promptTitle ? ' ' + promptTitle : ''}\n` +
            `${promptContent || '（无）'}\n` +
            `\n【重要】总结中必须用“${charName}”与“${userName}”这两个名字指代双方，禁止使用“User/Char/用户/好友”作为名字占位。`;

        closeChatSummaryModal();
        showNotification('记忆正在总结中');
        showLoading('记忆正在总结中');
        let response = null;
        try {
            const controller = new AbortController();
            response = await FeatureCommandMapper.callApiModel(sendContent, controller);
        } catch (e) {
            console.error(e);
        } finally {
            hideLoading();
        }

        if (!response) {
            showNotification('总结生成失败，请重试');
            return;
        }

        // 写入长记忆（先按“每次生成一条记忆卡片”落库）
        const memories = _loadChatLongMemories(friendId);
        const id = 'mem_' + Date.now();
        const item = {
            id,
            createdAt: Date.now(),
            content: String(response || '').trim(),
            source: {
                kind: summarySourceAtStart === 'missing_distance_map' ? 'missing_distance_map' : 'wechat_chat',
                roundsToProcess: pickN,
                totalRounds,
                promptId: prompt ? prompt.id : null,
                promptTitle
            }
        };
        memories.unshift(item);
        try {
            _saveChatLongMemories(friendId, memories);
        } catch (saveErr) {
            console.error(saveErr);
            showNotification('总结已生成，但保存长记忆失败（存储空间可能已满）');
            return;
        }

        // 标记“已总结到当前总轮数”（仅针对主微信；地图聊天不参与该计数）
        if (summarySourceAtStart !== 'missing_distance_map') {
            try {
                saveJsonToStorageWithCompression(_getChatSummaryLastDoneKey(friendId), totalRounds);
            } catch (e) {}
        }

        // 打开长记忆管理界面展示
        try {
            openChatLongMemoryModalForFriend(friendId);
        } catch (e) {}
        showNotification('总结已生成并保存到长记忆');
    })();
}

function openChatSummaryPromptPicker() {
    _ensureDefaultChatSummaryPrompt();
    const modal = document.getElementById('chat-summary-prompt-picker-modal');
    if (!modal) return;
    renderChatSummaryPromptList();
    modal.classList.add('show');
}

function closeChatSummaryPromptPicker() {
    const modal = document.getElementById('chat-summary-prompt-picker-modal');
    if (modal) modal.classList.remove('show');
}

function renderChatSummaryPromptList() {
    const listEl = document.getElementById('chat-summary-prompt-list');
    const emptyEl = document.getElementById('chat-summary-prompt-empty');
    if (!listEl || !emptyEl) return;
    const arr = _ensureDefaultChatSummaryPrompt();
    listEl.innerHTML = '';
    emptyEl.style.display = arr.length ? 'none' : 'block';

    arr.forEach(p => {
        const row = document.createElement('div');
        row.className = 'chat-summary-prompt-item' + (tempChatSummaryDraft && String(tempChatSummaryDraft.promptId) === String(p.id) ? ' active' : '');
        row.innerHTML = `
            <div class="chat-summary-prompt-name">${escapeHtml(String(p.title || '未命名'))}</div>
            <div class="chat-summary-prompt-badge">选择</div>
        `;
        row.onclick = () => {
            tempChatSummaryDraft = tempChatSummaryDraft || _defaultChatSummaryDraft();
            tempChatSummaryDraft.promptId = p.id;
            const display = document.getElementById('chat-summary-prompt-display');
            if (display) display.value = String(p.title || '');
            closeChatSummaryPromptPicker();
        };
        listEl.appendChild(row);
    });
}

function openChatSummaryPromptCreate() {
    const picker = document.getElementById('chat-summary-prompt-picker-modal');
    const modal = document.getElementById('chat-summary-prompt-create-modal');
    if (!modal) return;
    if (picker) picker.classList.remove('show');
    const titleInput = document.getElementById('chat-summary-prompt-title-input');
    const contentInput = document.getElementById('chat-summary-prompt-content-input');
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';
    modal.classList.add('show');
    setTimeout(() => titleInput && titleInput.focus(), 60);
}

function cancelChatSummaryPromptCreate(returnToPicker) {
    const modal = document.getElementById('chat-summary-prompt-create-modal');
    if (modal) modal.classList.remove('show');
    const titleInput = document.getElementById('chat-summary-prompt-title-input');
    const contentInput = document.getElementById('chat-summary-prompt-content-input');
    if (titleInput) titleInput.value = '';
    if (contentInput) contentInput.value = '';
    if (returnToPicker) {
        const picker = document.getElementById('chat-summary-prompt-picker-modal');
        if (picker) {
            renderChatSummaryPromptList();
            picker.classList.add('show');
        }
    }
}

function saveChatSummaryPromptCreate() {
    const titleInput = document.getElementById('chat-summary-prompt-title-input');
    const contentInput = document.getElementById('chat-summary-prompt-content-input');
    const title = (titleInput ? titleInput.value : '').trim();
    const content = (contentInput ? contentInput.value : '').trim();
    if (!title || !content) {
        showNotification('请填写标题和内容');
        return;
    }
    const arr = _ensureDefaultChatSummaryPrompt();
    const id = 'prompt_' + Date.now();
    arr.unshift({ id, title, content, createdAt: Date.now() });
    _saveChatSummaryPrompts(arr);

    tempChatSummaryDraft = tempChatSummaryDraft || _defaultChatSummaryDraft();
    tempChatSummaryDraft.promptId = id;
    const display = document.getElementById('chat-summary-prompt-display');
    if (display) display.value = title;

    cancelChatSummaryPromptCreate(true);
    showNotification('总结设定已保存');
}

// —— 处理好友回复（表情列表 + API）——
// sendMessage：见 wechat-ui.js（引用消息经 __chatUiBridge.currentQuoteMessage，由 wechat-chat-pipeline.js patch）


// 处理好友回复
function processFriendResponse(friendId, userMessage) {
    // 获取用户上传的表情
    const emojiData = parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {});
    let allEmojis = [];
    
    // 收集所有表情
    for (const category in emojiData) {
        allEmojis = allEmojis.concat(emojiData[category]);
    }
    
    // 构建发送内容，包含用户消息和所有表情
    let sendContent = `用户发送了消息: ${userMessage.content}\n\n`;
    
    if (allEmojis.length > 0) {
        sendContent += '可用表情:\n';
        allEmojis.forEach((emoji, index) => {
            sendContent += `${index + 1}. ${emoji.name}: ${emoji.url}\n`;
        });
    }
    
    // 调用API模型获取回复
    FeatureCommandMapper.callApiModel(sendContent).then(async (response) => {
        if (response) {
            let messages = splitApiResponseIntoMessages(response);
            messages = messages.map(m => {
                const raw = typeof m === 'string' ? m : (m.content || '');
                const resolved = typeof resolveEmojiRefsInMessage === 'function'
                    ? resolveEmojiRefsInMessage(raw, allEmojis)
                    : raw;
                return { content: resolved, polaroidOnly: !!(m && m.polaroidOnly) };
            });
            for (const msg of messages) {
                const rawContent = msg.content || '';
                const polaroidOnly = !!msg.polaroidOnly;
                const timestamp = new Date().getTime();
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
                displayMessage('friend', body, null, timestamp, friendId, friendSubtype);
                saveChatMessage(friendId, 'friend', body, null, timestamp, friendSubtype);
                await new Promise(resolve => setTimeout(resolve, 200));
            }
        }
    });
}






(function (g) {
  var W = g.Wechat;
  if (!W || !W.ui) return;
  Object.assign(W.ui, {
    isOfflineModeEnabled: typeof isOfflineModeEnabled === 'function' ? isOfflineModeEnabled : undefined,
    updateOfflineFloatingButtonForCurrentChat: typeof updateOfflineFloatingButtonForCurrentChat === 'function' ? updateOfflineFloatingButtonForCurrentChat : undefined
  });
})(typeof window !== 'undefined' ? window : globalThis);

if (typeof window !== 'undefined') {
    window.openChatSummaryModalForFriend =
        typeof openChatSummaryModalForFriend === 'function' ? openChatSummaryModalForFriend : undefined;
    window.openChatLongMemoryModalForFriend =
        typeof openChatLongMemoryModalForFriend === 'function' ? openChatLongMemoryModalForFriend : undefined;
}
