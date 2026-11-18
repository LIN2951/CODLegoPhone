/**
 * Lego 小手机 · 微信 UI — 好友资料 / 群设置（从 app.js 迁出）
 * 依赖：wechat-temp-state.js 的 tempFriendData、tempGroupData；全局 loadFriendsFromStorage、saveFriendsToStorage、
 * loadChatList、loadChatHistory、closeChatSettings、applyGroupBubbleCssForCurrentChat、
 * getWorldBookData、showNotification、showErrorDialog、showLoading、hideLoading、handleChatAvatarClick 等。
 * 加载顺序：在 wechat-ui-settings.js 之后、wechat-ui-extras.js 之前。
 */

/**
 * 草稿人设（selectPersona 等）与已持久化数据合并：避免临时对象 `{}` 因 `||` 判真而覆盖完整人设，导致头像等丢失。
 */
function resolvePersonaDraftForSave(draft, persisted) {
    if (draft == null) return persisted != null ? persisted : null;
    if (typeof draft !== 'object' || draft === null) return persisted != null ? persisted : null;
    if (Object.keys(draft).length === 0) return persisted != null ? persisted : null;
    return draft;
}

function getWechatAvatarForStorage(value) {
    return normalizeAvatarUrl(value) || '';
}

function pickWechatAvatarForSave(primary, fallback) {
    return getWechatAvatarForStorage(primary) || getWechatAvatarForStorage(fallback) || '';
}

async function compressWechatAvatarForStorage(value, opts) {
    const avatar = getWechatAvatarForStorage(value);
    if (!avatar || !/^data:image\//i.test(avatar)) return avatar;
    const options = opts || { maxDim: 512, quality: 0.78, mime: 'image/jpeg' };
    if (typeof compressDataUrlImage === 'function') {
        return getWechatAvatarForStorage(await compressDataUrlImage(avatar, options));
    }
    if (typeof compressImageDataUrl === 'function') {
        return getWechatAvatarForStorage(await compressImageDataUrl(avatar, options.maxDim || 512, options.quality || 0.78));
    }
    return avatar;
}

function resolveFriendAvatarForDisplay(friend) {
    if (!friend) return '';
    if (typeof getFriendDisplayAvatar === 'function') return getFriendDisplayAvatar(friend);
    return getWechatAvatarForStorage(friend.avatar) || getWechatAvatarForStorage(friend.persona && friend.persona.avatar) || '';
}

/**
 * IndexedDB 好友列表预热完成后再读写；否则 loadFriendsFromStorage 可能仍是「仅系统预设」快照，整表保存会冲掉其它角色自定义头像。
 * @param {{ silent?: boolean }} options silent 为 true 时不弹错误框（用于打开设置时轻量重试）
 * @returns {Promise<boolean>}
 */
async function ensureFriendsListReadyBeforeSave(options) {
    var silent = options && options.silent;
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    if (typeof areWechatFriendsReadyForMutation === 'function' && !areWechatFriendsReadyForMutation()) {
        await new Promise(function (resolve) {
            setTimeout(resolve, 80);
        });
        try {
            if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
        } catch (e2) {}
    }
    if (typeof areWechatFriendsReadyForMutation === 'function' && !areWechatFriendsReadyForMutation()) {
        if (!silent) {
            showErrorDialog('请稍后再试', '好友数据仍在加载，请等待几秒后保存；若多次失败请刷新页面。');
        }
        return false;
    }
    return true;
}

/** 仅同步「微信-我」页内资料，避免 document级 querySelector 命中错误节点或片段未注入时写丢 */
function getWechatMeProfileScope() {
    return document.getElementById('wechat-me-page');
}

function renderWechatMeAvatar(avatar) {
    const scope = getWechatMeProfileScope();
    const wechatMeAvatar = scope ? scope.querySelector('.wechat-me-avatar') : null;
    if (!wechatMeAvatar) return;
    const url = normalizeAvatarUrl(avatar);
    if (url) {
        wechatMeAvatar.innerHTML = `<img src="${url}" alt="头像" class="wechat-me-avatar-img">`;
    } else {
        wechatMeAvatar.innerHTML = `<span class="wechat-me-avatar-placeholder"></span>`;
    }
}

function formatWechatMeIdText(wechatId) {
    var id = wechatId != null ? String(wechatId).trim() : '';
    if (!id) id = 'wx_id_...';
    return '微信号：' + id;
}

function syncWechatMeId(wechatId) {
    const scope = getWechatMeProfileScope();
    const wechatMeId = scope ? scope.querySelector('.wechat-me-id') : null;
    if (wechatMeId) {
        wechatMeId.textContent = formatWechatMeIdText(wechatId);
    }
}

function syncWechatMeProfile(userInfo) {
    const info = userInfo && typeof userInfo === 'object' ? userInfo : null;
    const scope = getWechatMeProfileScope();
    const wechatMeName = scope ? scope.querySelector('.wechat-me-name') : null;
    if (wechatMeName && info) {
        var nick = info.nickname != null ? String(info.nickname).trim() : '';
        if (nick) wechatMeName.textContent = nick;
    }
    renderWechatMeAvatar(info && info.avatar ? info.avatar : '');
    syncWechatMeId(info && info.wechatId != null ? info.wechatId : '');
}

function syncWechatMeNameAndAvatar(nickname, avatar, wechatId) {
    const scope = getWechatMeProfileScope();
    const wechatMeName = scope ? scope.querySelector('.wechat-me-name') : null;
    if (wechatMeName && nickname != null && String(nickname).trim() !== '') {
        wechatMeName.textContent = String(nickname).trim();
    }
    renderWechatMeAvatar(avatar || '');
    if (arguments.length >= 3) {
        syncWechatMeId(wechatId);
    }
}

// 打开好友设置模态框
async function showFriendSettings() {
    const modal = document.getElementById('friend-settings-modal');
    const chatSettingsModal = document.getElementById('chat-settings-modal');
    
    // 从聊天设置模态框中获取好友ID
    const friendId = chatSettingsModal ? chatSettingsModal.dataset.friendId : null;
    if (!friendId) return;

    if (!(await ensureFriendsListReadyBeforeSave({ silent: true }))) {
        showNotification('好友数据加载中，请稍候再打开');
        return;
    }

    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);
    if (friend && friend.isGroup) {
        await openGroupSettings(friendId);
        closeChatSettings();
        return;
    }

    if (modal) {
        // 保存当前操作的好友ID
        modal.dataset.friendId = friendId;
        // 加载好友信息
        loadFriendInfo(friendId);
        modal.classList.add('show');
        closeChatSettings();

        setTimeout(() => {
            const chatAvatarPlaceholder = document.querySelector('.chat-avatar-placeholder');
            if (chatAvatarPlaceholder) {
                chatAvatarPlaceholder.removeEventListener('click', handleChatAvatarClick);
                chatAvatarPlaceholder.addEventListener('click', handleChatAvatarClick);
            }
        }, 100);
    }
}

// 关闭好友设置模态框
function closeFriendSettings() {
    const personaModal = document.getElementById('select-persona-modal');
    if (personaModal && personaModal.classList.contains('show')) {
        closeSelectPersonaModal();
    }
    const worldModal = document.getElementById('select-world-book-modal');
    if (worldModal && worldModal.classList.contains('show')) {
        if (typeof closeSelectWorldBookModal === 'function') closeSelectWorldBookModal();
    }
    const modal = document.getElementById('friend-settings-modal');
    if (modal) {
        // 清除临时存储中的数据
        const friendId = modal.dataset.friendId;
        if (friendId && tempFriendData[friendId]) {
            delete tempFriendData[friendId];
        }
        modal.classList.remove('show');
    }
}

async function openGroupSettings(groupId) {
    const modal = document.getElementById('group-settings-modal');
    if (!modal || !groupId) return;
    modal.dataset.groupId = groupId;
    if (!(await ensureFriendsListReadyBeforeSave({ silent: true }))) {
        showNotification('好友数据加载中，请稍候再试');
        return;
    }
    loadGroupInfo(groupId);
    modal.classList.add('show');
}

function closeGroupSettings() {
    const personaModal = document.getElementById('select-persona-modal');
    if (personaModal && personaModal.classList.contains('show')) {
        closeSelectPersonaModal();
    }
    const worldModal = document.getElementById('select-world-book-modal');
    if (worldModal && worldModal.classList.contains('show')) {
        if (typeof closeSelectWorldBookModal === 'function') closeSelectWorldBookModal();
    }
    const modal = document.getElementById('group-settings-modal');
    if (!modal) return;
    const groupId = modal.dataset.groupId;
    if (groupId && tempGroupData[groupId]) delete tempGroupData[groupId];
    modal.classList.remove('show');
    delete modal.dataset.groupId;
}

function triggerGroupAvatarUpload() {
    const input = document.getElementById('group-avatar-upload');
    if (input) input.click();
}

function loadGroupInfo(groupId) {
    const friends = loadFriendsFromStorage();
    const group = friends.find(f => f.id == groupId);
    if (!group) return;

    tempGroupData[groupId] = {
        nickname: (group.nickname || '').trim() || '群聊',
        avatar: group.avatar || '',
        memberIds: Array.isArray(group.memberIds) ? group.memberIds.map(String) : [],
        groupMemoryRounds: group.groupMemoryRounds != null ? Number(group.groupMemoryRounds) : 20,
        worldBookIds: Array.isArray(group.worldBookIds) ? group.worldBookIds : (group.worldBookId ? [group.worldBookId] : []),
        privateSyncRounds: group.privateSyncRounds != null ? Number(group.privateSyncRounds) : 0,
        privateSyncMemberIds: Array.isArray(group.privateSyncMemberIds) ? group.privateSyncMemberIds.map(String) : [],
        groupMyPersona: group.groupMyPersona || null,
        groupMyChatAvatar: group.groupMyChatAvatar || '',
        groupBubbleCss: group.groupBubbleCss || ''
    };

    const t = tempGroupData[groupId];

    const nameInput = document.getElementById('group-name-input');
    if (nameInput) nameInput.value = t.nickname;

    const memInput = document.getElementById('group-memory-rounds-input');
    if (memInput) memInput.value = String(Math.max(0, Math.min(50, t.groupMemoryRounds || 0)));

    const syncRoundsInput = document.getElementById('group-private-sync-rounds-input');
    if (syncRoundsInput) syncRoundsInput.value = String(Math.max(0, Math.min(15, t.privateSyncRounds || 0)));

    const ph = document.getElementById('group-avatar-placeholder');
    if (ph) {
        const gAv = normalizeAvatarUrl(t.avatar);
        if (gAv) {
            ph.style.backgroundImage = `url(${gAv})`;
            ph.style.backgroundSize = 'cover';
            ph.style.backgroundPosition = 'center';
            ph.textContent = '';
        } else {
            ph.style.backgroundImage = '';
            ph.textContent = (t.nickname || '群聊').charAt(0);
        }
    }

    renderGroupMembersList(groupId);
    renderGroupSyncMembersList(groupId);
    renderGroupWorldBookDisplay(groupId);

    const personaDisplay = document.getElementById('group-selected-persona-display');
    if (personaDisplay) {
        personaDisplay.textContent = (t.groupMyPersona && (t.groupMyPersona.nickname || t.groupMyPersona.name)) ? (t.groupMyPersona.nickname || t.groupMyPersona.name) : '点击选择 >';
    }

    const bubbleTa = document.getElementById('group-bubble-css-textarea');
    if (bubbleTa) bubbleTa.value = String(t.groupBubbleCss || '');

    const avatarBox = document.getElementById('group-chat-avatar-preview');
    const avatarHint = document.getElementById('group-chat-avatar-hint');
    if (avatarBox) {
        const avatarData =
            normalizeAvatarUrl(t.groupMyChatAvatar) ||
            normalizeAvatarUrl(t.groupMyPersona && t.groupMyPersona.avatar) ||
            '';
        if (avatarData) {
            avatarBox.style.backgroundImage = `url(${avatarData})`;
            avatarBox.style.backgroundSize = 'cover';
            avatarBox.style.backgroundPosition = 'center';
            if (avatarHint) avatarHint.style.display = 'none';
        } else {
            avatarBox.style.backgroundImage = '';
            if (avatarHint) avatarHint.style.display = 'block';
        }
    }
}

function openGroupChatAvatarUpload() {
    const input = document.getElementById('group-chat-avatar-input');
    if (input) input.click();
}

function handleGroupChatAvatarUpload(event) {
    event.stopPropagation();
    const file = event.target.files && event.target.files[0];
    const groupModal = document.getElementById('group-settings-modal');
    const groupId = groupModal ? groupModal.dataset.groupId : null;
    if (!file || !groupId) return;
    if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        const url = e && e.target ? e.target.result : null;
        if (!url) return;
        if (tempGroupData[groupId]) tempGroupData[groupId].groupMyChatAvatar = url;
        const preview = document.getElementById('group-chat-avatar-preview');
        const hint = document.getElementById('group-chat-avatar-hint');
        if (preview) {
            preview.style.backgroundImage = `url(${url})`;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
        }
        if (hint) hint.style.display = 'none';
        updateGroupMyAvatarDisplayIfActive(groupId, url, tempGroupData[groupId] ? tempGroupData[groupId].groupMyPersona : null);
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function applyGroupBubbleCssFromEditor() {
    const groupModal = document.getElementById('group-settings-modal');
    const groupId = groupModal ? groupModal.dataset.groupId : null;
    const ta = document.getElementById('group-bubble-css-textarea');
    if (!groupId || !ta || !tempGroupData[groupId]) return;
    tempGroupData[groupId].groupBubbleCss = String(ta.value || '');
    applyGroupBubbleCssForCurrentChat();
    showNotification('群聊气泡样式已应用');
}

function clearGroupBubbleCss() {
    const groupModal = document.getElementById('group-settings-modal');
    const groupId = groupModal ? groupModal.dataset.groupId : null;
    const ta = document.getElementById('group-bubble-css-textarea');
    if (ta) ta.value = '';
    if (groupId && tempGroupData[groupId]) tempGroupData[groupId].groupBubbleCss = '';
    applyGroupBubbleCssForCurrentChat();
    showNotification('群聊气泡样式已清空');
}

function renderGroupWorldBookDisplay(groupId) {
    const display = document.getElementById('group-selected-world-book-display');
    if (!display) return;
    const temp = tempGroupData[groupId];
    const wbIds = temp && Array.isArray(temp.worldBookIds) ? temp.worldBookIds : [];
    if (!wbIds.length) {
        display.textContent = '点击选择 >';
        return;
    }
    const wbData = getWorldBookData();
    const names = (wbIds || []).map(id => {
        const e = (wbData.entries || []).find(x => x.id === id);
        return e ? e.name : '';
    }).filter(Boolean);
    display.textContent = names.length > 2 ? names.slice(0, 2).join('、') + ' 等' + (names.length - 2) + '本' : names.join('、');
}

function renderGroupMembersList(groupId) {
    const listEl = document.getElementById('group-members-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const all = loadFriendsFromStorage();
    const temp = tempGroupData[groupId] || {};
    const ids = Array.isArray(temp.memberIds) ? temp.memberIds.map(String) : [];
    ids.forEach(mid => {
        const member = all.find(f => String(f.id) === String(mid));
        const row = document.createElement('div');
        row.className = 'group-member-row';
        const left = document.createElement('div');
        left.className = 'group-member-left';
        const avatar = document.createElement('div');
        avatar.className = 'group-member-avatar';
        const memAv = resolveFriendAvatarForDisplay(member);
        if (memAv) {
            avatar.style.backgroundImage = `url(${memAv})`;
            avatar.textContent = '';
        } else {
            avatar.textContent = (member ? (member.remark || member.nickname || '？') : '？').charAt(0);
        }
        const name = document.createElement('div');
        name.className = 'group-member-name';
        name.textContent = member ? ((member.remark || member.nickname || '成员').trim() || '成员') : String(mid);
        left.appendChild(avatar);
        left.appendChild(name);

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'group-member-remove-btn';
        btn.textContent = '移除';
        btn.addEventListener('click', (e) => {
            e.stopPropagation();
            removeGroupMember(groupId, mid);
        });

        row.appendChild(left);
        row.appendChild(btn);
        listEl.appendChild(row);
    });
}

function renderGroupSyncMembersList(groupId) {
    const listEl = document.getElementById('group-sync-members-list');
    if (!listEl) return;
    listEl.innerHTML = '';
    const all = loadFriendsFromStorage();
    const temp = tempGroupData[groupId] || {};
    const ids = Array.isArray(temp.memberIds) ? temp.memberIds.map(String) : [];
    const selected = new Set(Array.isArray(temp.privateSyncMemberIds) ? temp.privateSyncMemberIds.map(String) : []);

    ids.forEach(mid => {
        const member = all.find(f => String(f.id) === String(mid));
        const row = document.createElement('div');
        row.className = 'group-sync-row';
        const left = document.createElement('div');
        left.className = 'group-member-left';
        const avatar = document.createElement('div');
        avatar.className = 'group-member-avatar';
        const memAv = resolveFriendAvatarForDisplay(member);
        if (memAv) {
            avatar.style.backgroundImage = `url(${memAv})`;
            avatar.textContent = '';
        } else {
            avatar.textContent = (member ? (member.remark || member.nickname || '？') : '？').charAt(0);
        }
        const name = document.createElement('div');
        name.className = 'group-member-name';
        name.textContent = member ? ((member.remark || member.nickname || '成员').trim() || '成员') : String(mid);
        left.appendChild(avatar);
        left.appendChild(name);

        const toggleWrap = document.createElement('span');
        toggleWrap.className = 'chat-settings-toggle';
        const input = document.createElement('input');
        const uid = `group-sync-${groupId}-${mid}`;
        input.type = 'checkbox';
        input.id = uid;
        input.checked = selected.has(String(mid));
        input.addEventListener('change', () => {
            const t = tempGroupData[groupId];
            if (!t) return;
            const s = new Set(Array.isArray(t.privateSyncMemberIds) ? t.privateSyncMemberIds.map(String) : []);
            if (input.checked) s.add(String(mid));
            else s.delete(String(mid));
            t.privateSyncMemberIds = Array.from(s);
            const syncRoundsInput = document.getElementById('group-private-sync-rounds-input');
            const curRounds = syncRoundsInput ? Number(syncRoundsInput.value) : Number(t.privateSyncRounds || 0);
            const effectiveRounds = Number.isFinite(curRounds) ? curRounds : 0;
            if (input.checked && s.size > 0 && (!effectiveRounds || effectiveRounds < 1)) {
                const def = 5;
                t.privateSyncRounds = def;
                if (syncRoundsInput) syncRoundsInput.value = String(def);
            }
        });
        const label = document.createElement('label');
        label.className = 'toggle-slider';
        label.setAttribute('for', uid);
        toggleWrap.appendChild(input);
        toggleWrap.appendChild(label);

        row.appendChild(left);
        row.appendChild(toggleWrap);
        listEl.appendChild(row);
    });
}

function handleGroupAvatarUpload(event) {
    event.stopPropagation();
    const file = event.target.files && event.target.files[0];
    const modal = document.getElementById('group-settings-modal');
    const groupId = modal ? modal.dataset.groupId : null;
    if (!file || !groupId) return;
    if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        const url = e && e.target ? e.target.result : null;
        if (!url) return;
        if (tempGroupData[groupId]) tempGroupData[groupId].avatar = url;
        const ph = document.getElementById('group-avatar-placeholder');
        if (ph) {
            ph.style.backgroundImage = `url(${url})`;
            ph.style.backgroundSize = 'cover';
            ph.style.backgroundPosition = 'center';
            ph.textContent = '';
        }
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function removeGroupMember(groupId, memberId) {
    const t = tempGroupData[groupId];
    if (!t) return;
    const cur = Array.isArray(t.memberIds) ? t.memberIds.map(String) : [];
    const next = cur.filter(id => String(id) !== String(memberId));
    if (next.length < 2) {
        showNotification('群聊至少需要 2 位成员');
        return;
    }
    t.memberIds = next;
    t.privateSyncMemberIds = (Array.isArray(t.privateSyncMemberIds) ? t.privateSyncMemberIds : []).filter(id => next.includes(String(id)));
    renderGroupMembersList(groupId);
    renderGroupSyncMembersList(groupId);
}

let addGroupMembersSelectedIds = new Set();

function openAddGroupMembersModal() {
    const groupModal = document.getElementById('group-settings-modal');
    const groupId = groupModal ? groupModal.dataset.groupId : null;
    if (!groupId) return;
    renderAddGroupMembersList(groupId);
    const modal = document.getElementById('add-group-members-modal');
    if (modal) modal.classList.add('show');
}

function closeAddGroupMembersModal() {
    const modal = document.getElementById('add-group-members-modal');
    if (modal) modal.classList.remove('show');
    addGroupMembersSelectedIds.clear();
}

function updateAddGroupMembersConfirmEnabled() {
    const btn = document.getElementById('add-group-members-confirm-btn');
    if (btn) btn.disabled = addGroupMembersSelectedIds.size === 0;
    const hint = document.getElementById('add-group-members-hint');
    if (hint) hint.textContent = addGroupMembersSelectedIds.size ? `已选 ${addGroupMembersSelectedIds.size} 位好友` : '请选择要加入群聊的好友';
}

function renderAddGroupMembersList(groupId) {
    const listEl = document.getElementById('add-group-members-list');
    const emptyEl = document.getElementById('add-group-members-empty');
    if (!listEl) return;
    listEl.innerHTML = '';
    addGroupMembersSelectedIds.clear();

    const all = loadFriendsFromStorage();
    const group = all.find(f => f.id == groupId);
    const baseIds = tempGroupData[groupId] ? tempGroupData[groupId].memberIds : (group ? group.memberIds : []);
    const existing = new Set(Array.isArray(baseIds) ? baseIds.map(String) : []);
    const candidates = all.filter(f => !f.blacklisted && !f.isGroup && !existing.has(String(f.id)));

    candidates.forEach(f => {
        const row = document.createElement('div');
        row.className = 'forward-friend-row';
        row.dataset.friendId = String(f.id);
        const check = document.createElement('div');
        check.className = 'forward-friend-checkbox';
        const avatar = document.createElement('div');
        avatar.className = 'forward-friend-avatar';
        const rowAv = resolveFriendAvatarForDisplay(f);
        if (rowAv) {
            avatar.style.backgroundImage = `url(${rowAv})`;
            avatar.textContent = '';
        } else {
            avatar.textContent = (f.nickname || '?').charAt(0);
        }
        const name = document.createElement('span');
        name.className = 'forward-friend-name';
        name.textContent = (f.remark || f.nickname || '好友').trim() || '好友';
        row.appendChild(check);
        row.appendChild(avatar);
        row.appendChild(name);
        row.addEventListener('click', function () {
            const id = String(f.id);
            if (addGroupMembersSelectedIds.has(id)) {
                addGroupMembersSelectedIds.delete(id);
                row.classList.remove('selected');
            } else {
                addGroupMembersSelectedIds.add(id);
                row.classList.add('selected');
            }
            updateAddGroupMembersConfirmEnabled();
        });
        listEl.appendChild(row);
    });

    if (emptyEl) {
        const has = listEl.children.length > 0;
        emptyEl.style.display = has ? 'none' : 'block';
        listEl.style.display = has ? 'block' : 'none';
    }
    updateAddGroupMembersConfirmEnabled();
}

function confirmAddGroupMembers() {
    const groupModal = document.getElementById('group-settings-modal');
    const groupId = groupModal ? groupModal.dataset.groupId : null;
    if (!groupId) return;
    const t = tempGroupData[groupId];
    if (!t) return;
    const cur = Array.isArray(t.memberIds) ? t.memberIds.map(String) : [];
    const add = Array.from(addGroupMembersSelectedIds).map(String);
    t.memberIds = Array.from(new Set([...cur, ...add]));
    closeAddGroupMembersModal();
    renderGroupMembersList(groupId);
    renderGroupSyncMembersList(groupId);
}

async function saveGroupSettings() {
    const modal = document.getElementById('group-settings-modal');
    const groupId = modal ? modal.dataset.groupId : null;
    if (!groupId || !tempGroupData[groupId]) return;

    if (!(await ensureFriendsListReadyBeforeSave())) return;

    const t = tempGroupData[groupId];
    const nameInput = document.getElementById('group-name-input');
    const memInput = document.getElementById('group-memory-rounds-input');
    const syncInput = document.getElementById('group-private-sync-rounds-input');

    t.nickname = (nameInput ? nameInput.value : t.nickname).trim() || '群聊';
    const mr = memInput ? Number(memInput.value) : Number(t.groupMemoryRounds || 0);
    t.groupMemoryRounds = Number.isFinite(mr) ? Math.max(0, Math.min(50, mr)) : 0;
    let pr = syncInput ? Number(syncInput.value) : Number(t.privateSyncRounds || 0);
    pr = Number.isFinite(pr) ? Math.max(0, Math.min(15, pr)) : 0;
    const memberIdsForSync = Array.isArray(t.privateSyncMemberIds) ? t.privateSyncMemberIds.map(String).filter(Boolean) : [];
    if (!pr && memberIdsForSync.length > 0) {
        pr = 5;
        if (syncInput) syncInput.value = String(pr);
    }
    t.privateSyncRounds = pr;
    if (!t.privateSyncRounds) t.privateSyncMemberIds = [];

    let friends = loadFriendsFromStorage();
    const idx = friends.findIndex(f => f.id == groupId);
    if (idx === -1) return;

    const prevRow = friends[idx];
    friends[idx] = {
        ...prevRow,
        nickname: t.nickname,
        avatar: t.avatar,
        memberIds: Array.isArray(t.memberIds) ? t.memberIds.map(String) : [],
        groupMemoryRounds: t.groupMemoryRounds,
        worldBookIds: Array.isArray(t.worldBookIds) ? t.worldBookIds : [],
        privateSyncRounds: t.privateSyncRounds,
        privateSyncMemberIds: Array.isArray(t.privateSyncMemberIds) ? t.privateSyncMemberIds.map(String) : [],
        groupMyPersona: resolvePersonaDraftForSave(t.groupMyPersona, prevRow.groupMyPersona),
        groupMyChatAvatar: t.groupMyChatAvatar || '',
        groupBubbleCss: t.groupBubbleCss || ''
    };
    delete friends[idx].worldBookId;

    let persisted =
        typeof saveFriendsToStorageAsync === 'function'
            ? await saveFriendsToStorageAsync(friends)
            : (function () {
                  try {
                      return saveFriendsToStorage(friends);
                  } catch (e) {
                      return false;
                  }
              })();
    if (persisted === false) {
        showErrorDialog('保存失败', '群聊数据可能过大或存储空间不足，请清理缓存或重新导入备份后再试');
        return;
    }

    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
    applyGroupBubbleCssForCurrentChat();
    updateGroupMyAvatarDisplayIfActive(groupId, friends[idx].groupMyChatAvatar, friends[idx].groupMyPersona);
    showNotification('设置已保存');
    closeGroupSettings();
}

/** 好友设置 · 角色设定：预览仅展示前若干字，全文在点击进入编辑后查看 */
var ROLE_SETTING_PREVIEW_MAX_CHARS = 300;

function truncateRoleSettingForPreview(fullText) {
    var s = fullText == null ? '' : String(fullText);
    if (!String(s).trim()) return { text: '', empty: true, truncated: false };
    var chars = Array.from(s);
    if (chars.length <= ROLE_SETTING_PREVIEW_MAX_CHARS) {
        return { text: s, empty: false, truncated: false };
    }
    return {
        text: chars.slice(0, ROLE_SETTING_PREVIEW_MAX_CHARS).join('') + '…',
        empty: false,
        truncated: true
    };
}

function renderRoleSettingPreview(fullRoleText) {
    var display = document.getElementById('role-display');
    if (!display) return;
    var info = truncateRoleSettingForPreview(fullRoleText);
    display.textContent = '';
    if (info.empty) {
        var ph = document.createElement('span');
        ph.textContent = '角色设定（可选）';
        display.appendChild(ph);
        return;
    }
    var main = document.createElement('span');
    main.textContent = info.text;
    display.appendChild(main);
    if (info.truncated) {
        var hint = document.createElement('div');
        hint.className = 'role-setting-preview-truncated-hint';
        hint.textContent = '点击进入编辑可查看与修改全文';
        display.appendChild(hint);
    }
}

// 加载好友信息
function loadFriendInfo(friendId) {
    // 从本地存储中获取好友列表
    const friends = loadFriendsFromStorage();

    // 查找指定ID的好友
    const friend = friends.find(f => f.id == friendId);

    if (friend) {
        const patPatSanitized =
            friend.patPat && String(friend.patPat).trim() !== '__SYS_UNSET__' ? friend.patPat : '';
        // 重置为展示态，避免切换好友后仍停留在上一人的编辑 UI
        cancelEdit('nickname');
        cancelEdit('remark');
        cancelEdit('role');
        cancelEdit('patpat');
        cancelEdit('voiceId');
        cancelEdit('voiceLanguage');
        cancelEdit('outputLanguage');

        // 保存到临时存储
        tempFriendData[friendId] = {
            nickname: friend.nickname,
            remark: friend.remark || '',
            roleSetting: friend.roleSetting || '',
            patPat: patPatSanitized,
            avatar: getWechatAvatarForStorage(friend.avatar),
            chatAvatar: getWechatAvatarForStorage(friend.chatAvatar),
            persona: friend.persona || null,
            worldBookIds: Array.isArray(friend.worldBookIds) ? friend.worldBookIds : (friend.worldBookId ? [friend.worldBookId] : []),
            voiceId: friend.voiceId || '',
            voiceLanguage: friend.voiceLanguage || 'zh',
            outputLanguage: friend.outputLanguage || 'zh'
        };
        
        // 显示好友头像（显式头像 > 角色卡头像）
        const avatarPlaceholder = document.querySelector('#friend-settings-modal .avatar-placeholder');
        const friendAvatarForDisplay = resolveFriendAvatarForDisplay(friend);
        if (avatarPlaceholder) {
            if (friendAvatarForDisplay) {
                avatarPlaceholder.style.backgroundImage = `url(${friendAvatarForDisplay})`;
                avatarPlaceholder.style.backgroundSize = 'cover';
                avatarPlaceholder.style.backgroundPosition = 'center';
                // 清空占位符文本
                avatarPlaceholder.textContent = '';
                // 隐藏加号图标
                const avatarPlus = avatarPlaceholder.querySelector('.avatar-plus');
                if (avatarPlus) {
                    avatarPlus.style.display = 'none';
                }
            } else {
                // 显示默认头像（昵称首字母）
                avatarPlaceholder.style.backgroundImage = '';
                avatarPlaceholder.textContent = friend.nickname.charAt(0);
                // 显示加号图标
                const avatarPlus = avatarPlaceholder.querySelector('.avatar-plus');
                if (avatarPlus) {
                    avatarPlus.style.display = 'block';
                }
            }
        }
        
        // 显示我在该聊天中的头像
        const avatarBox = document.querySelector('.chat-avatar-box');
        const avatarPreview = document.getElementById('chat-avatar-preview');
        const chatAvatarHint = document.querySelector('.chat-avatar-hint');
        if (avatarBox && avatarPreview) {
            var gUiAv = '';
            var gMpAv = '';
            if (typeof safeReadJsonFromStorage === 'function') {
                var gUi0 = safeReadJsonFromStorage('userInfo', null);
                var gMp0 = safeReadJsonFromStorage('myProfile', null);
                gUiAv = normalizeAvatarUrl(gUi0 && gUi0.avatar);
                gMpAv = normalizeAvatarUrl(gMp0 && gMp0.avatar);
            }
            const avatarData =
                normalizeAvatarUrl(friend.chatAvatar) ||
                normalizeAvatarUrl(friend.persona && friend.persona.avatar) ||
                gUiAv ||
                gMpAv ||
                '';
            if (avatarData) {
                avatarPreview.style.backgroundImage = `url(${avatarData})`;
                avatarPreview.style.backgroundSize = 'cover';
                avatarPreview.style.backgroundPosition = 'center';
                // 隐藏提示文字
                if (chatAvatarHint) {
                    chatAvatarHint.style.display = 'none';
                }
            } else {
                // 显示默认状态
                avatarPreview.style.backgroundImage = '';
                if (chatAvatarHint) {
                    chatAvatarHint.style.display = 'block';
                }
            }
        }
        
        // 显示我的人设
        const selectedPersonaDisplay = document.getElementById('selected-persona-display');
        if (selectedPersonaDisplay) {
            var perNick = friend.persona && (friend.persona.nickname || friend.persona.name);
            if (perNick) {
                selectedPersonaDisplay.textContent = String(perNick).trim();
            } else if (typeof safeReadJsonFromStorage === 'function') {
                var gMpSel = safeReadJsonFromStorage('myProfile', null);
                var gMpName = gMpSel && (gMpSel.nickname || gMpSel.name);
                selectedPersonaDisplay.textContent = gMpName ? String(gMpName).trim() : '点击选择 >';
            } else {
                selectedPersonaDisplay.textContent = '点击选择 >';
            }
        }
        
        // 显示好友昵称
        const nicknameDisplay = document.getElementById('nickname-display');
        const nicknameInput = document.getElementById('fs-nickname-input');
        if (nicknameDisplay) nicknameDisplay.textContent = friend.nickname;
        if (nicknameInput) nicknameInput.value = friend.nickname;
        
        // 显示好友备注
        const remarkDisplay = document.getElementById('remark-display');
        const remarkInput = document.getElementById('remark-input');
        if (remarkDisplay) remarkDisplay.textContent = friend.remark || '设置备注名';
        if (remarkInput) remarkInput.value = friend.remark || '';
        
        // 显示好友角色设定（预览最多 300 字，全文见编辑框）
        const roleInput = document.getElementById('role-input');
        if (roleInput) roleInput.value = friend.roleSetting || '';
        renderRoleSettingPreview(friend.roleSetting || '');
        
        // 显示拍一拍设置
        const patpatDisplay = document.getElementById('patpat-display');
        const patpatInput = document.getElementById('patpat-input');
        if (patpatDisplay) patpatDisplay.textContent = patPatSanitized ? `例如：${patPatSanitized}` : '例如：的头';
        if (patpatInput) patpatInput.value = patPatSanitized || '';

        // 显示音色ID
        const voiceIdDisplay = document.getElementById('voice-id-display');
        const voiceIdInput = document.getElementById('fs-voice-id-input');
        const friendVoiceId = friend.voiceId || '';
        if (voiceIdDisplay) voiceIdDisplay.textContent = friendVoiceId || '未设置';
        if (voiceIdInput) voiceIdInput.value = friendVoiceId;

        // 显示音色语言
        const voiceLanguageDisplay = document.getElementById('voice-language-display');
        const voiceLanguageSelect = document.getElementById('fs-voice-language-select');
        const friendVoiceLanguage = friend.voiceLanguage || 'zh';
        const languageNames = {
            'zh': '中文',
            'en': '英文',
            'de': '德语',
            'yue': '粤语',
            'ja': '日语',
            'ko': '韩语',
            'fr': '法语',
            'es': '西班牙语'
        };
        if (voiceLanguageDisplay) voiceLanguageDisplay.textContent = languageNames[friendVoiceLanguage] || '中文';
        if (voiceLanguageSelect) voiceLanguageSelect.value = friendVoiceLanguage;

        const outputLanguageDisplay = document.getElementById('output-language-display');
        const outputLanguageSelect = document.getElementById('fs-output-language-select');
        const friendOutputLanguage = friend.outputLanguage || 'zh';
        const outputLangLabels = {
            zh: '中文（默认）',
            en: '英语',
            de: '德语',
            ru: '俄语',
            fr: '法语',
            es: '西班牙语',
            yue: '粤语',
            ja: '日语'
        };
        if (outputLanguageDisplay) outputLanguageDisplay.textContent = outputLangLabels[friendOutputLanguage] || '中文（默认）';
        if (outputLanguageSelect) outputLanguageSelect.value = outputLangLabels[friendOutputLanguage] ? friendOutputLanguage : 'zh';

        // 显示世界书
        const worldBookDisplay = document.getElementById('selected-world-book-display');
        if (worldBookDisplay) {
            const wbIds = Array.isArray(friend.worldBookIds) ? friend.worldBookIds : (friend.worldBookId ? [friend.worldBookId] : []);
            if (wbIds.length > 0) {
                const wbData = getWorldBookData();
                const names = wbIds.map(id => {
                    const e = (wbData.entries || []).find(x => x.id === id);
                    return e ? e.name : '';
                }).filter(Boolean);
                worldBookDisplay.textContent = names.length > 2
                    ? names.slice(0, 2).join('、') + ' 等' + (names.length - 2) + '本'
                    : names.join('、');
            } else {
                worldBookDisplay.textContent = '点击选择 >';
            }
        }
        
        // 显示时间戳开关状态
        const timestampToggle = document.getElementById('timestamp-toggle');
        if (timestampToggle) {
            timestampToggle.checked = friend.showTimestamp || false;
            
            // 添加时间戳开关变更事件监听器
            timestampToggle.onchange = function() {
                void (async () => {
                    try {
                        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
                    } catch (e) {}
                    const friends = loadFriendsFromStorage();
                    const friendIndex = friends.findIndex(f => f.id == friendId);
                    if (friendIndex !== -1) {
                        friends[friendIndex].showTimestamp = timestampToggle.checked;
                        saveFriendsToStorage(friends);
                        showNotification(`时间戳${timestampToggle.checked ? '已开启' : '已关闭'}`);
                    }
                })();
            };
        }
        
        // 显示隐藏头像开关状态
        const hideAvatarToggle = document.getElementById('hide-avatar-toggle');
        if (hideAvatarToggle) {
            hideAvatarToggle.checked = friend.hideAvatar || false;
            
            // 添加隐藏头像开关变更事件监听器
            hideAvatarToggle.onchange = function() {
                void (async () => {
                    try {
                        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
                    } catch (e) {}
                    const friends = loadFriendsFromStorage();
                    const friendIndex = friends.findIndex(f => f.id == friendId);
                    if (friendIndex !== -1) {
                        friends[friendIndex].hideAvatar = hideAvatarToggle.checked;
                        saveFriendsToStorage(friends);
                        showNotification(`隐藏头像${hideAvatarToggle.checked ? '已开启' : '已关闭'}`);
                    }
                })();
            };
        }
    }
}

// 处理好友头像上传
function handleFriendAvatarUpload(event) {
    // 阻止事件冒泡，防止文件选择器重复弹出
    event.stopPropagation();
    
    const file = event.target.files[0];
    if (file) {
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
            showNotification('请选择 JPEG、PNG 或 GIF 图片');
            event.target.value = '';
            return;
        }
        // 获取当前文件输入框的父元素，确定是哪个模态框
        const fileInput = event.target;
        const container = fileInput.closest('.avatar-container') || fileInput.closest('.avatar-upload-area');
        const avatarPlaceholder = container ? container.querySelector('.avatar-placeholder') : null;
        
        if (avatarPlaceholder) {
            // 创建进度条
            // 移除旧的进度条
            const oldProgress = avatarPlaceholder.querySelector('.avatar-upload-progress');
            if (oldProgress) {
                oldProgress.remove();
            }
            // 创建新的进度条
            const progress = document.createElement('div');
            progress.className = 'avatar-upload-progress';
            avatarPlaceholder.appendChild(progress);

            // 模拟上传进度
            let progressValue = 0;
            const interval = setInterval(() => {
                progressValue += 10;
                progress.style.width = `${progressValue}%`;
                if (progressValue >= 100) {
                    clearInterval(interval);
                    // 上传完成后显示新头像
                    const reader = new FileReader();
                    reader.onload = async function(e) {
                        if (avatarPlaceholder) {
                            // 设置头像占位符的背景图片
                            const rawAvatarData = e.target.result;
                            let avatarData = getWechatAvatarForStorage(rawAvatarData);
                            try {
                                avatarData = await compressWechatAvatarForStorage(avatarData, { maxDim: 512, quality: 0.78, mime: 'image/jpeg' });
                            } catch (compressErr) {
                                console.warn('好友头像压缩失败，使用原图:', compressErr);
                            }
                            avatarPlaceholder.style.backgroundImage = `url(${avatarData})`;
                            avatarPlaceholder.style.backgroundSize = 'cover';
                            avatarPlaceholder.style.backgroundPosition = 'center';
                            // 去掉昵称首字母等文本节点，避免叠在背景图上；file input 与占位 div 同级，不受影响
                            avatarPlaceholder.childNodes.forEach(node => {
                                if (node.nodeType === Node.TEXT_NODE) node.remove();
                            });
                            const avatarPlus = avatarPlaceholder.querySelector('.avatar-plus');
                            if (avatarPlus) {
                                avatarPlus.style.display = 'none';
                            }
                            
                            // 检查是否是好友设置模态框
                            const friendSettingsModal = document.getElementById('friend-settings-modal');
                            if (friendSettingsModal && friendSettingsModal.classList.contains('show')) {
                                // 获取好友ID
                                const friendId = friendSettingsModal.dataset.friendId;
                                if (friendId && tempFriendData[friendId]) {
                                    // 更新临时存储中的头像（保存纯数据，不带url()）
                                    tempFriendData[friendId].avatar = avatarData;
                                    console.log('好友设置模态框：头像已保存到tempFriendData:', avatarData.substring(0, 50) + '...');
                                }
                            }
                            
                            // 检查是否是添加好友模态框
                            const addFriendModal = document.getElementById('add-friend-modal');
                            if (addFriendModal && addFriendModal.classList.contains('show')) {
                                // 添加好友模态框的头像会在addFriend函数中处理
                                console.log('添加好友模态框：头像已设置到placeholder');
                            }
                        }
                        // 移除进度条
                        setTimeout(() => {
                            progress.remove();
                        }, 500);
                        showNotification('头像已更新');
                    };
                    reader.onerror = function(error) {
                        console.error('文件读取错误:', error);
                        progress.remove();
                        showNotification('上传失败，请重试');
                    };
                    reader.readAsDataURL(file);
                }
            }, 100);
        }
    }
}

// 打开聊天头像上传
function openChatAvatarUpload() {
    const fileInput = document.getElementById('chat-avatar-input');
    if (fileInput) {
        try {
            fileInput.click();
        } catch (_) {}
    }
}

// 处理聊天中的我的头像上传
function handleChatAvatarUpload(event) {
    const file = event.target.files[0];
    if (file) {
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
            showNotification('请选择 JPEG、PNG 或 GIF 图片');
            event.target.value = '';
            return;
        }
        const avatarBox = document.querySelector('.chat-avatar-box');
        const avatarPreview = document.getElementById('chat-avatar-preview');
        
        if (avatarBox && avatarPreview) {
            // 显示加载状态
            showLoading('上传中...');

            // 读取文件
            const reader = new FileReader();
            reader.onload = async function(e) {
                // 隐藏加载状态
                hideLoading();
                
                // 设置预览图片
                let avatarData = getWechatAvatarForStorage(e.target.result);
                try {
                    avatarData = await compressWechatAvatarForStorage(avatarData, { maxDim: 512, quality: 0.78, mime: 'image/jpeg' });
                } catch (compressErr) {
                    console.warn('聊天头像压缩失败，使用原图:', compressErr);
                }
                avatarPreview.style.backgroundImage = `url(${avatarData})`;
                
                // 添加has-avatar类
                avatarBox.classList.add('has-avatar');
                
                // 保存到临时存储（保存纯数据，不带url()）
                const friendSettingsModal = document.getElementById('friend-settings-modal');
                const friendId = friendSettingsModal ? friendSettingsModal.dataset.friendId : null;
                if (friendId && tempFriendData[friendId]) {
                    tempFriendData[friendId].chatAvatar = avatarData;
                }
                
                showNotification('头像已更新');
            };
            reader.onerror = function(error) {
                hideLoading();
                console.error('文件读取错误:', error);
                showNotification('上传失败，请重试');
            };
            reader.readAsDataURL(file);
        }
    }
}

// 更新好友头像
async function updateFriendAvatar(friendId, avatarUrl) {
    if (!(await ensureFriendsListReadyBeforeSave({ silent: true }))) {
        showNotification('好友数据加载中，请稍候再试');
        return;
    }
    // 从本地存储中获取好友列表
    const friends = loadFriendsFromStorage();
    
    // 查找指定ID的好友
    const friendIndex = friends.findIndex(f => f.id == friendId);
    
    if (friendIndex !== -1) {
        // 更新好友头像
        friends[friendIndex].avatar = avatarUrl;
        
        var okAv =
            typeof saveFriendsToStorageAsync === 'function'
                ? await saveFriendsToStorageAsync(friends)
                : saveFriendsToStorage(friends);
        if (okAv === false) {
            showNotification('头像保存失败，请缩小图片或清理存储后重试');
            return;
        }
        
        // 同步更新其他位置的头像
        
        // 1. 聊天对话框中显示的头像
        const chatPage = document.getElementById('chat-page');
        if (chatPage && chatPage.classList.contains('active')) {
            const otherAvatars = chatPage.querySelectorAll('.chat-message.other-message .chat-message-avatar');
            otherAvatars.forEach(avatar => {
                // 查找与当前好友相关的头像
                // 这里简化处理，实际应该根据好友名称或ID匹配
                const friend = friends[friendIndex];
                if (friend) {
                    // 假设聊天页面显示的是当前好友
                    avatar.style.backgroundImage = avatarUrl;
                    avatar.style.backgroundSize = 'cover';
                    avatar.style.backgroundPosition = 'center';
                    avatar.textContent = '';
                }
            });
        }
        
        // 2. 微信消息界面的好友列表中该好友的头像
        const wechatPage = document.getElementById('wechat-page');
        if (wechatPage && wechatPage.classList.contains('active')) {
            Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
        }
    }
}

// 更新聊天界面中的头像显示
function updateChatAvatarDisplay(friendId, friendAvatar, chatAvatar, persona) {
    // 1. 聊天页面的好友头像
    const chatPage = document.getElementById('chat-page');
    if (chatPage && chatPage.classList.contains('active')) {
        // 好友头像 - 聊天消息中的头像
        const otherAvatars = chatPage.querySelectorAll('.chat-message.other-message .chat-message-avatar');
        otherAvatars.forEach(avatar => {
            const cleanAvatar = normalizeAvatarUrl(friendAvatar || '');
            if (cleanAvatar) {
                avatar.innerHTML = `<img src="${cleanAvatar}" alt="好友头像" class="chat-avatar-img">`;
                avatar.classList.remove('transparent-avatar');
            } else {
                // 没有头像时显示透明
                avatar.innerHTML = '';
                avatar.classList.add('transparent-avatar');
            }
        });
        
        // 用户在该聊天中的头像
        const userAvatarElements = chatPage.querySelectorAll('.chat-message.my-message .chat-message-avatar');
        // 按照权重顺序：专属头像＞我的人设头像
        var gUiUpd = '';
        var gMpUpd = '';
        if (typeof safeReadJsonFromStorage === 'function') {
            var _u = safeReadJsonFromStorage('userInfo', null);
            var _m = safeReadJsonFromStorage('myProfile', null);
            gUiUpd = normalizeAvatarUrl(_u && _u.avatar);
            gMpUpd = normalizeAvatarUrl(_m && _m.avatar);
        }
        const userAvatar =
            normalizeAvatarUrl(chatAvatar) ||
            normalizeAvatarUrl(persona && persona.avatar) ||
            gUiUpd ||
            gMpUpd ||
            '';
        userAvatarElements.forEach(avatar => {
            if (userAvatar) {
                avatar.innerHTML = `<img src="${userAvatar}" alt="我的头像" class="chat-avatar-img">`;
                avatar.classList.remove('transparent-avatar');
            } else {
                // 没有头像时显示透明
                avatar.innerHTML = '';
                avatar.classList.add('transparent-avatar');
            }
        });
    }
    
    // 2. 微信消息界面的好友列表中该好友的头像
    const wechatPage = document.getElementById('wechat-page');
    if (wechatPage && wechatPage.classList.contains('active')) {
        Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
    }
}

function updateGroupMyAvatarDisplayIfActive(groupId, groupMyChatAvatar, groupMyPersona) {
    const chatPage = document.getElementById('chat-page');
    const activeId = chatPage ? chatPage.dataset.friendId : null;
    if (!chatPage || !chatPage.classList.contains('active')) return;
    if (!activeId || String(activeId) !== String(groupId)) return;
    const userAvatarElements = chatPage.querySelectorAll('.chat-message.my-message .chat-message-avatar');
    const clean =
        normalizeAvatarUrl(groupMyChatAvatar) ||
        normalizeAvatarUrl(groupMyPersona && groupMyPersona.avatar) ||
        '';
    userAvatarElements.forEach(el => {
        if (clean) {
            el.innerHTML = `<img src="${clean}" alt="我的头像" class="chat-avatar-img">`;
            el.classList.remove('transparent-avatar');
        } else {
            el.innerHTML = '';
            el.classList.add('transparent-avatar');
        }
    });
}

// 编辑好友昵称
function editFriendNickname() {
    document.getElementById('nickname-display').style.display = 'none';
    document.getElementById('nickname-edit').style.display = 'block';
    const nickInp = document.getElementById('fs-nickname-input');
    if (nickInp) nickInp.focus();
}

// 保存好友昵称
function saveNickname() {
    const input = document.getElementById('fs-nickname-input');
    const display = document.getElementById('nickname-display');
    if (input && display) {
        const newNickname = input.value.trim();
        if (newNickname) {
            display.textContent = newNickname;
            // 保存到临时存储
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].nickname = newNickname;
            }
        }
        cancelEdit('nickname');
    }
}

// 编辑好友备注
function editFriendRemark() {
    document.getElementById('remark-display').style.display = 'none';
    document.getElementById('remark-edit').style.display = 'block';
    document.getElementById('remark-input').focus();
}

// 保存好友备注
function saveRemark() {
    const input = document.getElementById('remark-input');
    const display = document.getElementById('remark-display');
    if (input && display) {
        const newRemark = input.value.trim();
        if (newRemark) {
            display.textContent = newRemark;
            // 保存到临时存储
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].remark = newRemark;
            }
        } else {
            display.textContent = '设置备注名';
            // 保存到临时存储（清空备注）
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].remark = '';
            }
        }
        cancelEdit('remark');
    }
}

// 编辑角色设定
function editRoleSetting() {
    document.getElementById('role-display').style.display = 'none';
    document.getElementById('role-edit').style.display = 'block';
    document.getElementById('role-input').focus();
}

// 保存角色设定
function saveRoleSetting() {
    const input = document.getElementById('role-input');
    const display = document.getElementById('role-display');
    if (input && display) {
        const newRole = input.value.trim();
        if (newRole) {
            renderRoleSettingPreview(newRole);
            // 保存到临时存储
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].roleSetting = newRole;
            }
        } else {
            renderRoleSettingPreview('');
            // 保存到临时存储（清空角色设定）
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].roleSetting = '';
            }
        }
        cancelEdit('role');
    }
}

// 编辑拍一拍
function editPatPat() {
    document.getElementById('patpat-display').style.display = 'none';
    document.getElementById('patpat-edit').style.display = 'block';
    document.getElementById('patpat-input').focus();
}

// 保存拍一拍
function savePatPat() {
    const input = document.getElementById('patpat-input');
    const display = document.getElementById('patpat-display');
    if (input && display) {
        const newPatPat = input.value.trim();
        if (newPatPat) {
            display.textContent = `例如：${newPatPat}`;
            // 保存到临时存储
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].patPat = newPatPat;
            }
        } else {
            display.textContent = '例如：的头';
            // 保存到临时存储（清空拍一拍）
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].patPat = '';
            }
        }
        // 不需要调用cancelEdit，因为保存操作在saveFriendSettings中统一处理
    }
}

// 编辑音色ID
function editVoiceId() {
    document.getElementById('voice-id-display').style.display = 'none';
    document.getElementById('voice-id-edit').style.display = 'block';
    document.getElementById('fs-voice-id-input').focus();
}

// 保存音色ID
function saveVoiceId() {
    const input = document.getElementById('fs-voice-id-input');
    const display = document.getElementById('voice-id-display');
    if (input && display) {
        const newVoiceId = input.value.trim();
        if (newVoiceId) {
            display.textContent = newVoiceId;
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].voiceId = newVoiceId;
            }
        } else {
            display.textContent = '未设置';
            const modal = document.getElementById('friend-settings-modal');
            const friendId = modal ? modal.dataset.friendId : null;
            if (friendId && tempFriendData[friendId]) {
                tempFriendData[friendId].voiceId = '';
            }
        }
    }
}

// 编辑音色语言
function editVoiceLanguage() {
    document.getElementById('voice-language-display').style.display = 'none';
    document.getElementById('voice-language-edit').style.display = 'block';
    document.getElementById('fs-voice-language-select').focus();
}

// 保存音色语言
function saveVoiceLanguage() {
    const select = document.getElementById('fs-voice-language-select');
    const display = document.getElementById('voice-language-display');
    if (select && display) {
        const newLanguage = select.value;
        const languageNames = {
            'zh': '中文',
            'en': '英文',
            'de': '德语',
            'yue': '粤语',
            'ja': '日语',
            'ko': '韩语',
            'fr': '法语',
            'es': '西班牙语'
        };
        display.textContent = languageNames[newLanguage] || '中文';
        const modal = document.getElementById('friend-settings-modal');
        const friendId = modal ? modal.dataset.friendId : null;
        if (friendId && tempFriendData[friendId]) {
            tempFriendData[friendId].voiceLanguage = newLanguage;
        }
    }
}

function editOutputLanguage() {
    const disp = document.getElementById('output-language-display');
    const edit = document.getElementById('output-language-edit');
    const sel = document.getElementById('fs-output-language-select');
    if (disp) disp.style.display = 'none';
    if (edit) edit.style.display = 'block';
    if (sel) sel.focus();
}

function saveOutputLanguage() {
    const select = document.getElementById('fs-output-language-select');
    const display = document.getElementById('output-language-display');
    const labels = {
        zh: '中文（默认）',
        en: '英语',
        de: '德语',
        ru: '俄语',
        fr: '法语',
        es: '西班牙语',
        yue: '粤语',
        ja: '日语'
    };
    if (!select || !display) return;
    var code = String(select.value || 'zh').trim();
    if (!labels.hasOwnProperty(code)) code = 'zh';
    display.textContent = labels[code];
    const modal = document.getElementById('friend-settings-modal');
    const friendId = modal ? modal.dataset.friendId : null;
    if (friendId && tempFriendData[friendId]) {
        tempFriendData[friendId].outputLanguage = code;
    }
}

// 取消编辑
function cancelEdit(type) {
    if (type === 'nickname') {
        document.getElementById('nickname-display').style.display = 'block';
        document.getElementById('nickname-edit').style.display = 'none';
    } else if (type === 'remark') {
        document.getElementById('remark-display').style.display = 'block';
        document.getElementById('remark-edit').style.display = 'none';
    } else if (type === 'role') {
        document.getElementById('role-display').style.display = 'block';
        document.getElementById('role-edit').style.display = 'none';
    } else if (type === 'patpat') {
        document.getElementById('patpat-display').style.display = 'block';
        document.getElementById('patpat-edit').style.display = 'none';
    } else if (type === 'voiceId') {
        document.getElementById('voice-id-display').style.display = 'block';
        document.getElementById('voice-id-edit').style.display = 'none';
    } else if (type === 'voiceLanguage') {
        document.getElementById('voice-language-display').style.display = 'block';
        document.getElementById('voice-language-edit').style.display = 'none';
    } else if (type === 'outputLanguage') {
        document.getElementById('output-language-display').style.display = 'block';
        document.getElementById('output-language-edit').style.display = 'none';
    }
}

// 保存好友设置
async function saveFriendSettings() {
    const friendSettingsModal = document.getElementById('friend-settings-modal');
    const friendId = friendSettingsModal ? friendSettingsModal.dataset.friendId : null;
    if (!friendId) return;

    if (!(await ensureFriendsListReadyBeforeSave())) return;

    // 直接从各 input 读取最新值（避免依赖可能被中途修改的 tempData 快照）
    const nicknameInput = document.getElementById('fs-nickname-input');
    const remarkInput = document.getElementById('remark-input');
    const roleInput = document.getElementById('role-input');
    const patpatInput = document.getElementById('patpat-input');
    const voiceIdInput = document.getElementById('fs-voice-id-input');
    const voiceLanguageSelect = document.getElementById('fs-voice-language-select');
    const outputLanguageSelect = document.getElementById('fs-output-language-select');
    const newNickname = nicknameInput ? nicknameInput.value.trim() : '';
    const newRemark = remarkInput ? remarkInput.value.trim() : '';
    const newRole = roleInput ? roleInput.value.trim() : '';
    const newPatPat = patpatInput ? patpatInput.value.trim() : '';
    const newVoiceId = voiceIdInput ? voiceIdInput.value.trim() : '';
    const newVoiceLanguage = voiceLanguageSelect ? voiceLanguageSelect.value : 'zh';
    const outputLangAllowed = { zh: 1, en: 1, de: 1, ru: 1, fr: 1, es: 1, yue: 1, ja: 1 };
    var newOutputLanguage = outputLanguageSelect ? String(outputLanguageSelect.value || 'zh').trim() : 'zh';
    if (!outputLangAllowed[newOutputLanguage]) newOutputLanguage = 'zh';

    let friends = loadFriendsFromStorage();
    const friendIndex = friends.findIndex(f => f.id == friendId);
    if (friendIndex === -1) return;

    // 取当前好友的其余字段（头像、世界书等未改动部分从原数据继承）
    const original = friends[friendIndex];
    const tempData = tempFriendData[friendId] || {};
    const worldBookIds = tempData.worldBookIds !== undefined
        ? tempData.worldBookIds
        : (original.worldBookIds || (original.worldBookId ? [original.worldBookId] : []));
    const nextAvatar = await compressWechatAvatarForStorage(
        pickWechatAvatarForSave(tempData.avatar, original.avatar),
        { maxDim: 512, quality: 0.78, mime: 'image/jpeg' }
    );
    const nextChatAvatar = await compressWechatAvatarForStorage(
        pickWechatAvatarForSave(tempData.chatAvatar, original.chatAvatar),
        { maxDim: 512, quality: 0.78, mime: 'image/jpeg' }
    );

    friends[friendIndex] = {
        ...original,
        nickname: newNickname || original.nickname || '好友',
        remark: newRemark,
        roleSetting: newRole,
        patPat: newPatPat,
        avatar: nextAvatar,
        chatAvatar: nextChatAvatar,
        persona: resolvePersonaDraftForSave(tempData.persona, original.persona),
        worldBookIds: worldBookIds,
        voiceId: newVoiceId || original.voiceId || '',
        voiceLanguage: newVoiceLanguage || original.voiceLanguage || 'zh',
        outputLanguage: newOutputLanguage || original.outputLanguage || 'zh'
    };
    delete friends[friendIndex].worldBookId;

    let persistedFs =
        typeof saveFriendsToStorageAsync === 'function'
            ? await saveFriendsToStorageAsync(friends)
            : (function () {
                  try {
                      return saveFriendsToStorage(friends);
                  } catch (e) {
                      return false;
                  }
              })();
    if (persistedFs === false) {
        showErrorDialog('保存失败', '好友数据可能过大或存储空间不足，请清理缓存或重新导入备份后再试');
        return;
    }

    // 刷新聊天列表昵称（立即更新已渲染的 DOM，不用等完整重建）
    refreshChatListFriendName(friendId, friends[friendIndex].nickname, friends[friendIndex].remark);

    // 立即刷新聊天头部标题（若当前正在该好友的聊天中）
    const chatPage = document.getElementById('chat-page');
    if (chatPage && String(chatPage.dataset.friendId) === String(friendId)) {
        const contactNameEl = document.getElementById('chat-contact-name');
        if (contactNameEl) contactNameEl.textContent = friends[friendIndex].nickname || '好友';
    }

    // 立即刷新好友设置弹框内的显示昵称（下次打开时显示正确值）
    const nicknameDisplay = document.getElementById('nickname-display');
    if (nicknameDisplay) nicknameDisplay.textContent = friends[friendIndex].nickname || '好友';

    // 更新聊天界面中的头像
    const resolvedFriendAvatar = resolveFriendAvatarForDisplay(friends[friendIndex]);
    updateChatAvatarDisplay(friendId, resolvedFriendAvatar, friends[friendIndex].chatAvatar, friends[friendIndex].persona);

    // 重新加载聊天历史记录，确保隐藏头像状态立即生效
    loadChatHistory(friendId);

    // 刷新好友列表
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});

    showNotification('设置已保存');
    closeFriendSettings();
}

/** 立即刷新聊天列表中指定好友的昵称（无需全量重建 DOM） */
function refreshChatListFriendName(friendId, nickname, remark) {
    const displayName = (remark || nickname || '好友').trim() || '好友';
    // 仅刷新本体微信列表，避免影响好友手机的微信列表
    const allItems = document.querySelectorAll('#wechat-page .wechat-chat-item');
    allItems.forEach(item => {
        if (String(item.dataset.friendId) === String(friendId)) {
            const nameEl = item.querySelector('.wechat-chat-name');
            if (nameEl) nameEl.textContent = displayName;
            const previewEl = item.querySelector('.wechat-chat-message');
            item.dataset.searchText = (displayName + '\n' + (previewEl ? previewEl.textContent : '')).toLocaleLowerCase();
            item.setAttribute('aria-label', '打开与' + displayName + '的聊天');
            // 头像首字也要同步
            const avatarEl = item.querySelector('.wechat-chat-avatar');
            if (avatarEl && !avatarEl.style.backgroundImage) {
                const unreadBadge = avatarEl.querySelector('.wechat-chat-unread');
                avatarEl.textContent = (nickname || '?').charAt(0).toUpperCase();
                if (unreadBadge) avatarEl.appendChild(unreadBadge);
            }
        }
    });
    const searchInput = document.getElementById('wechat-conversation-search');
    if (searchInput && typeof window.filterWechatConversations === 'function') {
        window.filterWechatConversations(searchInput.value);
    }
}

(function (g) {
  var W = g.Wechat;
  if (!W || !W.ui) return;
  Object.assign(W.ui, {
    showFriendSettings: typeof showFriendSettings === 'function' ? showFriendSettings : undefined,
    closeFriendSettings: typeof closeFriendSettings === 'function' ? closeFriendSettings : undefined,
    openGroupSettings: typeof openGroupSettings === 'function' ? openGroupSettings : undefined,
    closeGroupSettings: typeof closeGroupSettings === 'function' ? closeGroupSettings : undefined,
    saveGroupSettings: typeof saveGroupSettings === 'function' ? saveGroupSettings : undefined,
    saveFriendSettings: typeof saveFriendSettings === 'function' ? saveFriendSettings : undefined,
    syncWechatMeProfile: typeof syncWechatMeProfile === 'function' ? syncWechatMeProfile : undefined,
    syncWechatMeNameAndAvatar: typeof syncWechatMeNameAndAvatar === 'function' ? syncWechatMeNameAndAvatar : undefined,
    syncWechatMeId: typeof syncWechatMeId === 'function' ? syncWechatMeId : undefined,
    renderWechatMeAvatar: typeof renderWechatMeAvatar === 'function' ? renderWechatMeAvatar : undefined,
    updateChatAvatarDisplay: typeof updateChatAvatarDisplay === 'function' ? updateChatAvatarDisplay : undefined,
    updateGroupMyAvatarDisplayIfActive: typeof updateGroupMyAvatarDisplayIfActive === 'function' ? updateGroupMyAvatarDisplayIfActive : undefined
  });
})(typeof window !== 'undefined' ? window : globalThis);
