/**
 * Lego 小手机 · 微信钱包与亲属卡（从 app.js 迁出）
 * 零钱、支付密码、充值提现、支付方式选择、亲属卡页与赠送/领取流程。
 * getFriendName 仍留在 app.js（购物/聊天等多处共用）。
 * 加载顺序：在 app.js、wechat-store、wechat-chat-pipeline 之后均可（依赖全局 saveChatMessage、displayMessage、loadChatList 等）。
 */

const WALLET_INITIAL_BALANCE = 52000;

function getWalletBalance() {
    const stored = localStorage.getItem('walletBalance');
    if (stored == null || stored === '') return WALLET_INITIAL_BALANCE;
    const n = parseFloat(stored);
    return isNaN(n) ? WALLET_INITIAL_BALANCE : n;
}

function setWalletBalance(amount) {
    const val = Math.max(0, Number(amount) || 0);
    localStorage.setItem('walletBalance', String(val));
    updateWalletBalanceDisplay();
}

function formatWalletBalance(amount) {
    return '¥ ' + (Number(amount) || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function updateWalletBalanceDisplay() {
    const el = document.getElementById('wallet-balance-display');
    if (el) el.textContent = formatWalletBalance(getWalletBalance());
}

function showWallet() {
    document.querySelector('.wechat-me-header')?.classList.add('hidden');
    document.querySelector('.wechat-me-profile')?.classList.add('hidden');
    document.querySelector('.wechat-me-functions')?.classList.add('hidden');
    const walletPage = document.getElementById('wallet-page');
    if (walletPage) {
        if (localStorage.getItem('walletBalance') == null || localStorage.getItem('walletBalance') === '') {
            localStorage.setItem('walletBalance', String(WALLET_INITIAL_BALANCE));
        }
        document.getElementById('favorites-page')?.classList.remove('show');
        document.getElementById('kinship-page')?.classList.remove('show');
        document.getElementById('wallet-bills-page')?.classList.remove('show');
        document.getElementById('wechat-settings-page')?.classList.remove('show');
        walletPage.classList.add('show');
        updateWalletBalanceDisplay();
        updatePaymentPasswordStatusDisplay();
    }
}

function closeWalletPage() {
    document.querySelector('.wechat-me-header')?.classList.remove('hidden');
    document.querySelector('.wechat-me-profile')?.classList.remove('hidden');
    document.querySelector('.wechat-me-functions')?.classList.remove('hidden');
    const walletPage = document.getElementById('wallet-page');
    const kinshipPage = document.getElementById('kinship-page');
    const billsPage = document.getElementById('wallet-bills-page');
    if (walletPage) walletPage.classList.remove('show');
    if (kinshipPage) kinshipPage.classList.remove('show');
    if (billsPage) billsPage.classList.remove('show');
}

// ========== 支付密码相关 ==========
const WALLET_PASSWORD_KEY = 'walletPaymentPassword';

function hasPaymentPassword() {
    return !!(localStorage.getItem(WALLET_PASSWORD_KEY) || '').trim();
}

function getStoredPaymentPassword() {
    const raw = localStorage.getItem(WALLET_PASSWORD_KEY) || '';
    if (!raw.trim()) return null;
    try {
        return atob(raw);
    } catch (e) {
        return raw;
    }
}

function setStoredPaymentPassword(pwd) {
    if (!pwd || pwd.length !== 6) return false;
    localStorage.setItem(WALLET_PASSWORD_KEY, btoa(pwd));
    return true;
}

function updatePaymentPasswordStatusDisplay() {
    const el = document.getElementById('wallet-payment-password-status');
    if (el) el.textContent = hasPaymentPassword() ? '已设置' : '未设置';
}

function walletPaymentPassword() {
    const modal = document.getElementById('set-payment-password-modal');
    const input = document.getElementById('payment-password-input');
    const errEl = document.getElementById('payment-password-error');
    if (!modal || !input || !errEl) return;
    input.value = '';
    errEl.textContent = '';
    modal.classList.add('show');
}

function closeSetPaymentPasswordModal() {
    const modal = document.getElementById('set-payment-password-modal');
    const input = document.getElementById('payment-password-input');
    const errEl = document.getElementById('payment-password-error');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (errEl) errEl.textContent = '';
}

function confirmSetPaymentPassword() {
    const input = document.getElementById('payment-password-input');
    const errEl = document.getElementById('payment-password-error');
    if (!input || !errEl) return;
    const pwd = input.value.replace(/\D/g, '');
    if (pwd.length !== 6) {
        errEl.textContent = '请输入6位数字密码';
        return;
    }
    setStoredPaymentPassword(pwd);
    closeSetPaymentPasswordModal();
    updatePaymentPasswordStatusDisplay();
    showNotification('支付密码设置成功');
}

// 验证支付密码：支出前调用，密码正确后执行 onSuccess，取消执行 onCancel
let _pendingPaymentAmount = 0;
let _pendingPaymentDesc = '';
let _pendingPaymentOnSuccess = null;
let _pendingPaymentOnCancel = null;

function requirePaymentPassword(amount, description, onSuccess, onCancel) {
    if (!hasPaymentPassword()) {
        showNotification('请先在钱包中设置支付密码');
        if (onCancel) onCancel();
        return;
    }
    const balance = getWalletBalance();
    if (amount > 0 && balance < amount) {
        showNotification('余额不足');
        if (onCancel) onCancel();
        return;
    }
    _pendingPaymentAmount = amount;
    _pendingPaymentDesc = description;
    _pendingPaymentOnSuccess = onSuccess;
    _pendingPaymentOnCancel = onCancel;

    const modal = document.getElementById('verify-payment-password-modal');
    const hint = document.getElementById('verify-password-hint');
    const input = document.getElementById('verify-payment-password-input');
    const errEl = document.getElementById('verify-payment-password-error');
    if (!modal || !hint || !input || !errEl) return;
    hint.textContent = amount > 0 ? `请输入支付密码（支出 ¥${amount.toFixed(2)}）` : '请输入支付密码';
    input.value = '';
    errEl.textContent = '';
    modal.classList.add('show');
}

function closeVerifyPaymentPasswordModal() {
    const modal = document.getElementById('verify-payment-password-modal');
    const input = document.getElementById('verify-payment-password-input');
    const errEl = document.getElementById('verify-payment-password-error');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (errEl) errEl.textContent = '';
    _pendingPaymentAmount = 0;
    _pendingPaymentDesc = '';
    _pendingPaymentOnSuccess = null;
    if (_pendingPaymentOnCancel) _pendingPaymentOnCancel();
    _pendingPaymentOnCancel = null;
}

function confirmVerifyPaymentPassword() {
    const input = document.getElementById('verify-payment-password-input');
    const errEl = document.getElementById('verify-payment-password-error');
    if (!input || !errEl) return;
    const pwd = input.value.replace(/\D/g, '');
    if (pwd.length !== 6) {
        errEl.textContent = '请输入6位数字密码';
        return;
    }
    const stored = getStoredPaymentPassword();
    if (pwd !== stored) {
        errEl.textContent = '密码错误';
        return;
    }
    const onSuccess = _pendingPaymentOnSuccess;
    closeVerifyPaymentPasswordModal();
    if (onSuccess) onSuccess();
}

function deductFromWallet(amount) {
    const n = Number(amount) || 0;
    if (n <= 0) return;
    const balance = getWalletBalance();
    setWalletBalance(Math.max(0, balance - n));
}

function addToWallet(amount) {
    const n = Number(amount) || 0;
    if (n <= 0) return;
    setWalletBalance(getWalletBalance() + n);
}

function openRechargeModal() {
    const modal = document.getElementById('recharge-amount-modal');
    const input = document.getElementById('recharge-amount-input');
    const errEl = document.getElementById('recharge-amount-error');
    if (!modal || !input || !errEl) return;
    input.value = '';
    errEl.textContent = '';
    modal.classList.add('show');
}

function closeRechargeModal() {
    const modal = document.getElementById('recharge-amount-modal');
    const input = document.getElementById('recharge-amount-input');
    const errEl = document.getElementById('recharge-amount-error');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (errEl) errEl.textContent = '';
}

function confirmRechargeAmount() {
    const input = document.getElementById('recharge-amount-input');
    const errEl = document.getElementById('recharge-amount-error');
    if (!input || !errEl) return;
    const amount = parseFloat(input.value);
    if (isNaN(amount) || amount <= 0) {
        errEl.textContent = '请输入有效金额';
        return;
    }
    closeRechargeModal();
    addToWallet(amount);
    showNotification(`充值成功，+¥${amount.toFixed(2)}`);
}

function walletRecharge() {
    openRechargeModal();
}

function openWithdrawModal() {
    const modal = document.getElementById('withdraw-amount-modal');
    const input = document.getElementById('withdraw-amount-input');
    const balanceEl = document.getElementById('withdraw-balance-display');
    const errEl = document.getElementById('withdraw-amount-error');
    if (!modal || !input || !balanceEl || !errEl) return;
    input.value = '';
    errEl.textContent = '';
    balanceEl.textContent = getWalletBalance().toFixed(2);
    modal.classList.add('show');
}

function closeWithdrawModal() {
    const modal = document.getElementById('withdraw-amount-modal');
    const input = document.getElementById('withdraw-amount-input');
    const errEl = document.getElementById('withdraw-amount-error');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (errEl) errEl.textContent = '';
}

function confirmWithdrawAmount() {
    const input = document.getElementById('withdraw-amount-input');
    const errEl = document.getElementById('withdraw-amount-error');
    if (!input || !errEl) return;
    const amount = parseFloat(input.value);
    if (isNaN(amount) || amount <= 0) {
        errEl.textContent = '请输入有效金额';
        return;
    }
    const walletBal = getWalletBalance();
    const receivedCards = getKinshipCards().received.filter(c => c.amount >= amount);
    if (walletBal < amount && receivedCards.length === 0) {
        errEl.textContent = '余额不足';
        return;
    }
    closeWithdrawModal();
    requestPaymentWithMethod(amount, '提现', '提现', function() {
        showNotification(`提现成功，-¥${amount.toFixed(2)}`);
    }, function() {});
}

function walletWithdraw() {
    openWithdrawModal();
}

// ========== 亲属卡相关 ==========
const KINSHIP_STORAGE_KEY = 'kinshipCards';

function getKinshipCards() {
    try {
        const raw = localStorage.getItem(KINSHIP_STORAGE_KEY);
        const data = raw ? JSON.parse(raw) : {};
        return {
            received: Array.isArray(data.received) ? data.received : [],
            sent: Array.isArray(data.sent) ? data.sent : []
        };
    } catch (e) {
        return { received: [], sent: [] };
    }
}

function saveKinshipCards(data) {
    localStorage.setItem(KINSHIP_STORAGE_KEY, JSON.stringify(data));
}

function genKinshipId() {
    return 'kc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9);
}
function sendKinshipUsageMessageToCardOwner(cardOwnerFriendId, amount, purpose, targetName) {
    const content = purpose === '转账'
        ? `您的亲属卡被使用：转账${amount.toFixed(2)}元给${targetName}`
        : purpose === '红包'
        ? `您的亲属卡被使用：发红包${amount.toFixed(2)}元给${targetName}`
        : purpose === '购物'
        ? `您的亲属卡被使用：购物付款${amount.toFixed(2)}元（${targetName}）`
        : `您的亲属卡被使用：${purpose}${amount.toFixed(2)}元`;
    const timestamp = new Date().getTime();
    saveChatMessage(cardOwnerFriendId, 'system', content, null, timestamp);
    const chatPage = document.getElementById('chat-page');
    const currentFriendId = chatPage ? chatPage.dataset.friendId : null;
    if (currentFriendId && String(currentFriendId) === String(cardOwnerFriendId)) {
        displayMessage('system', content, null, timestamp, cardOwnerFriendId);
    }
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
}

function sendMyCardUsedByFriendMessage(toFriendId, amount, purpose, targetName) {
    const content = purpose === '转账'
        ? `${getFriendName(toFriendId)}使用您赠送的亲属卡：转账${amount.toFixed(2)}元给${targetName}`
        : purpose === '红包'
        ? `${getFriendName(toFriendId)}使用您赠送的亲属卡：发红包${amount.toFixed(2)}元给${targetName}`
        : purpose === '购物'
        ? `${getFriendName(toFriendId)}使用您赠送的亲属卡：购物付款${amount.toFixed(2)}元（${targetName}）`
        : `${getFriendName(toFriendId)}使用您赠送的亲属卡：${purpose}${amount.toFixed(2)}元`;
    const timestamp = new Date().getTime();
    saveChatMessage(toFriendId, 'system', content, null, timestamp);
    const chatPage = document.getElementById('chat-page');
    const currentFriendId = chatPage ? chatPage.dataset.friendId : null;
    if (currentFriendId && String(currentFriendId) === String(toFriendId)) {
        displayMessage('system', content, null, timestamp, toFriendId);
    }
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
}

function useReceivedKinshipCard(cardId, amount, purpose, targetFriendName) {
    const data = getKinshipCards();
    const card = data.received.find(c => c.id === cardId);
    if (!card || card.amount < amount) return false;
    card.amount = Math.max(0, card.amount - amount);
    const usedCard = { ...card };
    if (card.amount <= 0) {
        data.received = data.received.filter(c => c.id !== cardId);
    }
    saveKinshipCards(data);
    sendKinshipUsageMessageToCardOwner(card.fromFriendId, amount, purpose, targetFriendName);
    return { ok: true, card: usedCard, remainAmount: card.amount };
}

function useSentKinshipCardByFriend(cardId, amount, purpose, targetName) {
    const data = getKinshipCards();
    const card = data.sent.find(c => c.id === cardId);
    if (!card || card.amount < amount) return false;
    card.amount = Math.max(0, card.amount - amount);
    if (card.amount <= 0) {
        data.sent = data.sent.filter(c => c.id !== cardId);
    }
    saveKinshipCards(data);
    sendMyCardUsedByFriendMessage(card.toFriendId, amount, purpose, targetName);
    return true;
}

function showKinshipPage() {
    document.getElementById('wechat-settings-page')?.classList.remove('show');
    document.getElementById('kinship-page')?.classList.add('show');
    switchKinshipTab('received');
}

function closeKinshipPage() {
    document.getElementById('kinship-page')?.classList.remove('show');
}

function switchKinshipTab(tab) {
    document.querySelectorAll('.kinship-tab').forEach(t => {
        t.classList.toggle('active', t.dataset.tab === tab);
    });
    const receivedSec = document.getElementById('kinship-received-section');
    const sentSec = document.getElementById('kinship-sent-section');
    if (receivedSec) receivedSec.style.display = tab === 'received' ? 'block' : 'none';
    if (sentSec) sentSec.style.display = tab === 'sent' ? 'block' : 'none';
    if (tab === 'received') renderKinshipReceivedList();
    else renderKinshipSentList();
}

function renderKinshipReceivedList() {
    const list = document.getElementById('kinship-received-list');
    const empty = document.getElementById('kinship-received-empty');
    if (!list || !empty) return;
    const data = getKinshipCards();
    const received = data.received.filter(c => c.amount > 0);
    list.innerHTML = '';
    received.forEach(card => {
        const div = document.createElement('div');
        div.className = 'kinship-card-item';
        div.innerHTML = `<span class="kinship-card-friend">${getFriendName(card.fromFriendId)}</span><span class="kinship-card-amount">¥ ${card.amount.toFixed(2)}</span>`;
        list.appendChild(div);
    });
    empty.style.display = received.length === 0 ? 'flex' : 'none';
}

function renderKinshipSentList() {
    const list = document.getElementById('kinship-sent-list');
    const empty = document.getElementById('kinship-sent-empty');
    if (!list || !empty) return;
    const data = getKinshipCards();
    const sent = data.sent.filter(c => c.amount > 0);
    list.innerHTML = '';
    sent.forEach(card => {
        const div = document.createElement('div');
        div.className = 'kinship-card-item';
        div.innerHTML = `<span class="kinship-card-friend">${getFriendName(card.toFriendId)}</span><span class="kinship-card-amount">¥ ${card.amount.toFixed(2)}/¥ ${(card.limit || card.amount).toFixed(2)}</span>`;
        list.appendChild(div);
    });
    empty.style.display = sent.length === 0 ? 'flex' : 'none';
}

let _giveKinshipSelectedFriendId = null;

function openGiveKinshipCardModal() {
    _giveKinshipSelectedFriendId = null;
    const listEl = document.getElementById('give-kinship-friend-list');
    const limitInput = document.getElementById('give-kinship-limit-input');
    const errEl = document.getElementById('give-kinship-error');
    if (!listEl || !limitInput || !errEl) return;
    limitInput.value = '';
    errEl.textContent = '';
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted);
    listEl.innerHTML = friends.map(f => {
        const avatar = typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(f)
            : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '');
        return `<div class="kinship-friend-item" data-id="${f.id}" onclick="selectGiveKinshipFriend('${f.id}')"><div class="kinship-friend-item-avatar" style="${avatar ? 'background-image:url(' + avatar + ');background-size:cover' : ''}"></div><span class="kinship-friend-item-name">${f.remark || f.nickname || '好友'}</span></div>`;
    }).join('');
    document.getElementById('give-kinship-card-modal')?.classList.add('show');
}

function selectGiveKinshipFriend(friendId) {
    _giveKinshipSelectedFriendId = friendId;
    document.querySelectorAll('#give-kinship-friend-list .kinship-friend-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.id === friendId);
    });
}

function closeGiveKinshipCardModal() {
    document.getElementById('give-kinship-card-modal')?.classList.remove('show');
}

function confirmGiveKinshipCard() {
    const limitInput = document.getElementById('give-kinship-limit-input');
    const errEl = document.getElementById('give-kinship-error');
    if (!limitInput || !errEl) return;
    if (!_giveKinshipSelectedFriendId) {
        errEl.textContent = '请选择好友';
        return;
    }
    const limit = parseFloat(limitInput.value);
    if (isNaN(limit) || limit <= 0) {
        errEl.textContent = '请输入有效限额';
        return;
    }
    const data = getKinshipCards();
    data.sent.push({
        id: genKinshipId(),
        toFriendId: _giveKinshipSelectedFriendId,
        amount: limit,
        limit: limit,
        createdAt: Date.now()
    });
    saveKinshipCards(data);
    closeGiveKinshipCardModal();
    renderKinshipSentList();
    showNotification('亲属卡赠送成功');
}

let _addReceivedSelectedFriendId = null;

function openAddReceivedKinshipModal() {
    _addReceivedSelectedFriendId = null;
    const listEl = document.getElementById('add-received-kinship-friend-list');
    const amountInput = document.getElementById('add-received-kinship-amount-input');
    const errEl = document.getElementById('add-received-kinship-error');
    if (!listEl || !amountInput || !errEl) return;
    amountInput.value = '';
    errEl.textContent = '';
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted);
    listEl.innerHTML = friends.map(f => {
        const avatar = typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(f)
            : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '');
        return `<div class="kinship-friend-item" data-id="${f.id}" onclick="selectAddReceivedKinshipFriend('${f.id}')"><div class="kinship-friend-item-avatar" style="${avatar ? 'background-image:url(' + avatar + ');background-size:cover' : ''}"></div><span class="kinship-friend-item-name">${f.remark || f.nickname || '好友'}</span></div>`;
    }).join('');
    document.getElementById('add-received-kinship-modal')?.classList.add('show');
}

function selectAddReceivedKinshipFriend(friendId) {
    _addReceivedSelectedFriendId = friendId;
    document.querySelectorAll('#add-received-kinship-friend-list .kinship-friend-item').forEach(el => {
        el.classList.toggle('selected', el.dataset.id === friendId);
    });
}

function closeAddReceivedKinshipModal() {
    document.getElementById('add-received-kinship-modal')?.classList.remove('show');
}

function confirmAddReceivedKinship() {
    const amountInput = document.getElementById('add-received-kinship-amount-input');
    const errEl = document.getElementById('add-received-kinship-error');
    if (!amountInput || !errEl) return;
    if (!_addReceivedSelectedFriendId) {
        errEl.textContent = '请选择赠送好友';
        return;
    }
    const amount = parseFloat(amountInput.value);
    if (isNaN(amount) || amount <= 0) {
        errEl.textContent = '请输入有效额度';
        return;
    }
    const data = getKinshipCards();
    data.received.push({
        id: genKinshipId(),
        fromFriendId: _addReceivedSelectedFriendId,
        amount: amount,
        limit: amount,
        createdAt: Date.now()
    });
    saveKinshipCards(data);
    closeAddReceivedKinshipModal();
    renderKinshipReceivedList();
    showNotification('亲属卡领取成功');
}

let _pendingPaymentWithKinship = null;

function requestPaymentWithMethod(amount, purpose, targetFriendName, onSuccess, onCancel) {
    const received = getKinshipCards().received.filter(c => c.amount >= amount);
    const hasWallet = getWalletBalance() >= amount;
    if (!hasWallet && received.length === 0) {
        showNotification('余额不足且无可用的亲属卡');
        if (onCancel) onCancel();
        return;
    }
    if (hasWallet && received.length === 0) {
        if (purpose === '提现') {
            requirePaymentPassword(amount, purpose, function() {
                deductFromWallet(amount);
                if (onSuccess) onSuccess('wallet');
            }, onCancel);
        } else {
            requirePaymentPassword(amount, purpose, function() {
                deductFromWallet(amount);
                if (onSuccess) onSuccess('wallet');
            }, onCancel);
        }
        return;
    }
    if (hasWallet && received.length > 0) {
        _pendingPaymentWithKinship = { amount, purpose, targetFriendName, onSuccess, onCancel };
        openPaymentMethodModal(amount, purpose, targetFriendName);
        return;
    }
    if (received.length > 0) {
        _pendingPaymentWithKinship = { amount, purpose, targetFriendName, onSuccess, onCancel };
        openPaymentMethodModal(amount, purpose, targetFriendName);
    }
}

function openPaymentMethodModal(amount, purpose, targetFriendName) {
    const modal = document.getElementById('payment-method-modal');
    const hint = document.getElementById('payment-method-hint');
    const list = document.getElementById('payment-method-list');
    if (!modal || !hint || !list) return;
    hint.textContent = `支付 ¥${amount.toFixed(2)}（${purpose}）`;
    list.innerHTML = '';
    const walletBal = getWalletBalance();
    if (walletBal >= amount) {
        const div = document.createElement('div');
        div.className = 'payment-method-item';
        div.dataset.method = 'wallet';
        div.innerHTML = `<span class="payment-method-label">零钱</span><span class="payment-method-amount">¥ ${walletBal.toFixed(2)}</span>`;
        div.onclick = () => selectPaymentMethod('wallet');
        list.appendChild(div);
    }
    const received = getKinshipCards().received.filter(c => c.amount >= amount);
    received.forEach(card => {
        const div = document.createElement('div');
        div.className = 'payment-method-item';
        div.dataset.cardId = card.id;
        div.innerHTML = `<span class="payment-method-label">${getFriendName(card.fromFriendId)}的亲属卡</span><span class="payment-method-amount">¥ ${card.amount.toFixed(2)}</span>`;
        div.onclick = () => selectPaymentMethod('kinship', card.id);
        list.appendChild(div);
    });
    modal.classList.add('show');
}

function closePaymentMethodModal() {
    document.getElementById('payment-method-modal')?.classList.remove('show');
    const pending = _pendingPaymentWithKinship;
    _pendingPaymentWithKinship = null;
    if (pending && pending.onCancel) pending.onCancel();
}

function selectPaymentMethod(method, cardId) {
    const pending = _pendingPaymentWithKinship;
    if (!pending) return;
    closePaymentMethodModal();
    const { amount, purpose, targetFriendName, onSuccess, onCancel } = pending;
    _pendingPaymentWithKinship = null;
    if (method === 'wallet') {
        requirePaymentPassword(amount, purpose, function() {
            deductFromWallet(amount);
            if (onSuccess) onSuccess('wallet', { method: 'wallet', amount: amount });
        }, onCancel);
    } else if (method === 'kinship' && cardId) {
        const usage = useReceivedKinshipCard(cardId, amount, purpose, targetFriendName || '对方');
        if (usage && usage.ok) {
            renderKinshipReceivedList();
            if (onSuccess) onSuccess('kinship', { method: 'kinship', amount: amount, card: usage.card, remainAmount: usage.remainAmount });
        } else {
            showNotification('亲属卡扣款失败');
            if (onCancel) onCancel();
        }
    }
}

function walletFamilyCard() {
    showKinshipPage();
}

function getAllBillChatFriendIds() {
    const ids = new Set();
    const friends = typeof loadFriendsFromStorage === 'function' ? loadFriendsFromStorage() : [];
    friends.forEach(friend => {
        if (friend && !friend.isGroup && friend.id != null) ids.add(String(friend.id));
    });
    for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (!key || !key.startsWith('chatHistory_')) continue;
        ids.add(String(key.slice('chatHistory_'.length)));
    }
    return Array.from(ids);
}

function safeParseMoney(value) {
    const n = parseFloat(value);
    return isNaN(n) ? 0 : n;
}

function buildWalletBillId(prefix, rawId) {
    return `${prefix}_${String(rawId || '').trim() || Date.now()}`;
}

function normalizeWalletGiftItems(items) {
    if (!Array.isArray(items)) return [];
    return items.map(it => ({
        name: String((it && (it.name || it.title || it.label)) || '商品'),
        price: safeParseMoney(it && it.price),
        qty: Math.max(1, Number(it && it.qty) || 1)
    }));
}

function sumWalletGiftItems(items) {
    return normalizeWalletGiftItems(items).reduce((sum, item) => sum + item.price * item.qty, 0);
}

function getWalletBillFriendName(friendId) {
    if (!friendId) return '对方';
    if (typeof getFriendName === 'function') return getFriendName(friendId) || '对方';
    return '对方';
}

function getWalletBillStatusText(item) {
    if (!item) return '';
    if (item.category === 'transfer') {
        if (item.status === 'received') return '已收款';
        if (item.status === 'rejected') return '已退还';
        if (item.status === 'pending') return item.direction === 'expense' ? '待对方确认' : '待收款';
    }
    if (item.category === 'gift') {
        if (item.status === 'received') return '已接收';
        if (item.status === 'expired') return '已失效';
        if (item.status === 'pending_receive') return '待接收';
    }
    if (item.category === 'takeout') {
        if (item.status === 'completed') return '已完成';
        if (item.status) return item.status;
    }
    return '';
}

function getWalletBillCategoryIcon(category, direction) {
    if (category === 'redpacket') return '🧧';
    if (category === 'transfer') return '💸';
    if (category === 'gift') return '🛍';
    if (category === 'takeout') return '🍱';
    return direction === 'income' ? '💰' : '💳';
}

function makeWalletBillFromTransfer(friendId, msg) {
    const actor = msg.type === 'friend' ? 'char' : 'user';
    return {
        billId: buildWalletBillId('transfer', String(msg.timestamp) + '_' + actor),
        category: 'transfer',
        direction: actor === 'user' ? 'expense' : 'income',
        title: '微信转账',
        itemName: actor === 'user' ? `向${getWalletBillFriendName(friendId)}转账` : `${getWalletBillFriendName(friendId)}向你转账`,
        amount: safeParseMoney(msg.content),
        createdAt: Number(msg.timestamp) || Date.now(),
        status: String(msg.transferStatus || ''),
        friendName: getWalletBillFriendName(friendId)
    };
}

function makeWalletBillFromRedpacket(friendId, msg) {
    return {
        billId: buildWalletBillId('redpacket', String(msg.timestamp) + '_' + msg.type),
        category: 'redpacket',
        direction: msg.type === 'friend' ? 'income' : 'expense',
        title: '微信红包',
        itemName: String(msg.redpacketMsg || (msg.type === 'friend' ? `收到${getWalletBillFriendName(friendId)}的红包` : `发给${getWalletBillFriendName(friendId)}的红包`)),
        amount: safeParseMoney(msg.content),
        createdAt: Number(msg.timestamp) || Date.now(),
        status: msg.type === 'friend' ? (msg.redpacketOpened ? 'received' : 'pending') : 'received',
        friendName: getWalletBillFriendName(friendId)
    };
}

function makeWalletBillFromGift(friendId, msg) {
    const items = normalizeWalletGiftItems(msg.giftItems);
    return {
        billId: buildWalletBillId('gift', msg.orderId || msg.timestamp),
        category: 'gift',
        direction: msg.type === 'friend' ? 'income' : 'expense',
        title: '购物消费',
        itemName: items.map(it => it.name).join('、') || '商品',
        amount: sumWalletGiftItems(items),
        createdAt: Number(msg.timestamp) || Date.now(),
        status: String(msg.giftStatus || ''),
        friendName: getWalletBillFriendName(friendId),
        itemDetails: items
    };
}

function makeWalletBillFromTakeout(friendId, msg) {
    const items = Array.isArray(msg.loveTakeoutItems) ? msg.loveTakeoutItems : [];
    const direction = String(msg.loveTakeoutDirection || '') === 'char_to_user' ? 'income' : 'expense';
    return {
        billId: buildWalletBillId('takeout', msg.loveTakeoutOrderId || msg.timestamp),
        category: 'takeout',
        direction: direction,
        title: '爱的外卖',
        itemName: items.map(it => it.name).join('、') || '外卖订单',
        amount: safeParseMoney(msg.loveTakeoutTotalPrice),
        createdAt: Number(msg.timestamp) || Date.now(),
        status: String(msg.loveTakeoutStatus || ''),
        friendName: getWalletBillFriendName(friendId),
        itemDetails: items
    };
}

function buildWalletBillsFromChatHistory(friendId, messages) {
    const list = Array.isArray(messages) ? messages : [];
    const bills = [];
    list.forEach(msg => {
        if (!msg || !msg.subtype) return;
        if (msg.subtype === 'transfer' || msg.subtype === 'friend_transfer') bills.push(makeWalletBillFromTransfer(friendId, msg));
        else if (msg.subtype === 'redpacket') bills.push(makeWalletBillFromRedpacket(friendId, msg));
        else if (msg.subtype === 'gift_bundle') bills.push(makeWalletBillFromGift(friendId, msg));
        else if (msg.subtype === 'love_takeout_order' && msg.loveTakeoutOrderId) bills.push(makeWalletBillFromTakeout(friendId, msg));
    });
    return bills;
}

function getWalletBillRecords() {
    const ids = getAllBillChatFriendIds();
    const all = [];
    ids.forEach(friendId => {
        let messages = [];
        try {
            if (typeof getChatHistoryArray === 'function') messages = getChatHistoryArray(friendId);
            else messages = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
        } catch (e) {
            messages = [];
        }
        buildWalletBillsFromChatHistory(friendId, messages).forEach(item => all.push(item));
    });
    all.sort((a, b) => (Number(b.createdAt) || 0) - (Number(a.createdAt) || 0));
    return all;
}

function formatWalletBillDay(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
}

function formatWalletBillTime(timestamp) {
    const date = new Date(Number(timestamp) || Date.now());
    const h = String(date.getHours()).padStart(2, '0');
    const m = String(date.getMinutes()).padStart(2, '0');
    return `${h}:${m}`;
}

function formatWalletBillAmount(amount, direction) {
    const sign = direction === 'income' ? '+' : '-';
    return `${sign}¥${safeParseMoney(amount).toFixed(2)}`;
}

function renderWalletBills() {
    const listEl = document.getElementById('wallet-bills-list');
    const emptyEl = document.getElementById('wallet-bills-empty');
    const incomeEl = document.getElementById('wallet-bills-income');
    const expenseEl = document.getElementById('wallet-bills-expense');
    if (!listEl || !emptyEl || !incomeEl || !expenseEl) return;

    const bills = getWalletBillRecords();
    let income = 0;
    let expense = 0;
    const groups = new Map();

    bills.forEach(item => {
        if (item.direction === 'income') income += safeParseMoney(item.amount);
        else expense += safeParseMoney(item.amount);
        const day = formatWalletBillDay(item.createdAt);
        if (!groups.has(day)) groups.set(day, []);
        groups.get(day).push(item);
    });

    incomeEl.textContent = `¥${income.toFixed(2)}`;
    expenseEl.textContent = `¥${expense.toFixed(2)}`;
    listEl.innerHTML = '';

    if (!bills.length) {
        emptyEl.style.display = 'flex';
        return;
    }
    emptyEl.style.display = 'none';

    groups.forEach((items, day) => {
        const groupEl = document.createElement('div');
        groupEl.className = 'wallet-bill-group';
        const titleEl = document.createElement('div');
        titleEl.className = 'wallet-bill-group-title';
        titleEl.textContent = day;
        groupEl.appendChild(titleEl);

        items.forEach(item => {
            const row = document.createElement('div');
            row.className = 'wallet-bill-item';
            const statusText = getWalletBillStatusText(item);
            const descParts = [];
            if (item.friendName) descParts.push(item.direction === 'income' ? `来自 ${item.friendName}` : `对方 ${item.friendName}`);
            if (Array.isArray(item.itemDetails) && item.itemDetails.length) {
                const totalQty = item.itemDetails.reduce((sum, detail) => sum + Math.max(1, Number(detail.qty) || 1), 0);
                descParts.push(`${totalQty}件商品`);
            }
            row.innerHTML = `
                <div class="wallet-bill-icon">${getWalletBillCategoryIcon(item.category, item.direction)}</div>
                <div class="wallet-bill-main">
                    <div class="wallet-bill-title-row">
                        <span class="wallet-bill-title">${item.title}</span>
                        ${statusText ? `<span class="wallet-bill-status">${statusText}</span>` : ''}
                    </div>
                    <div class="wallet-bill-desc">${item.itemName || item.title}</div>
                    <div class="wallet-bill-meta">${descParts.join(' · ')}</div>
                </div>
                <div class="wallet-bill-side">
                    <div class="wallet-bill-amount ${item.direction}">${formatWalletBillAmount(item.amount, item.direction)}</div>
                    <div class="wallet-bill-time">${formatWalletBillTime(item.createdAt)}</div>
                </div>
            `;
            groupEl.appendChild(row);
        });

        listEl.appendChild(groupEl);
    });
}

function walletBills() {
    document.getElementById('kinship-page')?.classList.remove('show');
    document.getElementById('wallet-bills-page')?.classList.add('show');
    renderWalletBills();
}

function closeWalletBillsPage() {
    document.getElementById('wallet-bills-page')?.classList.remove('show');
}

(function (g) {
  g.Wechat = g.Wechat || {};
  g.Wechat.wallet = {
    version: '0.1.0',
    getWalletBalance: typeof getWalletBalance === 'function' ? getWalletBalance : undefined,
    requestPaymentWithMethod: typeof requestPaymentWithMethod === 'function' ? requestPaymentWithMethod : undefined
  };
})(typeof window !== 'undefined' ? window : globalThis);
