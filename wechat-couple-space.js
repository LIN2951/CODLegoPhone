/**
 * Lego 小手机 · 微信「情侣空间」（发现页入口）
 *
 * 数据/规则：`Wechat.store.coupleSpace`（wechat-store.js）
 * Prompt/API：`Wechat.prompts.buildCoupleSpaceInviteDecisionSendContent` + `CommandManager.*`（wechat-prompts.js / app.js）
 * 渲染：`buildCoupleSpaceCardFrameHtml` + `displayMessage`（app.js / wechat-ui.js）
 */
(function (global) {
    'use strict';

    function store() {
        return global.Wechat && global.Wechat.store && global.Wechat.store.coupleSpace ? global.Wechat.store.coupleSpace : null;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escAttrUrl(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '')
            .replace(/>/g, '')
            .replace(/`/g, '');
    }

    function cleanAvatarData(avatar) {
        return normalizeAvatarUrl(avatar);
    }

    function getUserDisplayName() {
        var userInfo = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('userInfo', {}) : {};
        var myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        var n = (userInfo && userInfo.nickname) || (myProfile && (myProfile.nickname || myProfile.name)) || '';
        n = String(n).trim();
        return n || '我';
    }

    function getUserAvatarUrl() {
        var userInfo = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('userInfo', {}) : {};
        if (userInfo && userInfo.avatar) return cleanAvatarData(String(userInfo.avatar));
        var myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        if (myProfile && myProfile.avatar) return cleanAvatarData(String(myProfile.avatar));
        return '';
    }

    function getFriendById(friendId) {
        var list = typeof loadFriendsFromStorage === 'function' ? loadFriendsFromStorage() : [];
        if (!Array.isArray(list)) list = [];
        var fid = String(friendId);
        for (var i = 0; i < list.length; i++) {
            if (String(list[i] && list[i].id) === fid) return list[i];
        }
        return null;
    }

    function getDefaultPrivateTitle(userName, friendName) {
        return String(friendName || 'TA') + '和' + String(userName || '我') + '的甜蜜空间';
    }

    var LOVE_TAKEOUT_MENU = {
        drinks: [
            { name: '奶茶', price: 18, qty: 1 },
            { name: '杨枝甘露', price: 22, qty: 1 },
            { name: '葡萄冰茶', price: 19, qty: 1 },
            { name: '抹茶拿铁', price: 20, qty: 1 }
        ],
        desserts: [
            { name: '草莓蛋糕', price: 28, qty: 1 },
            { name: '提拉米苏', price: 26, qty: 1 },
            { name: '芒果班戟', price: 24, qty: 1 },
            { name: '焦糖布丁', price: 18, qty: 1 }
        ],
        hotMeals: [
            { name: '炸鸡套餐', price: 32, qty: 1 },
            { name: '双拼披萨', price: 56, qty: 1 },
            { name: '寿司拼盘', price: 46, qty: 1 },
            { name: '麻辣烫', price: 26, qty: 1 }
        ]
    };
    var currentCoupleBillTab = 'takeout';
    var loveTakeoutMenuRefreshPending = false;

    function getActiveCoupleFriendId() {
        var st = store();
        if (!st || typeof st.getActiveCoupleFriendId !== 'function') return '';
        return String(st.getActiveCoupleFriendId() || '');
    }

    /** 刷新后 activeCoupleFriendId / data-friend-id 可能未写回，从持久化 state.pairs 取当前 accepted */
    function getFirstAcceptedCoupleFriendIdFromState(st) {
        if (!st || typeof st.getState !== 'function') return '';
        var state;
        try {
            state = st.getState();
        } catch (e) {
            return '';
        }
        if (!state || !state.pairs || typeof state.pairs !== 'object') return '';
        var pairs = state.pairs;
        for (var k in pairs) {
            if (!Object.prototype.hasOwnProperty.call(pairs, k)) continue;
            var p = pairs[k];
            if (p && String(p.status) === 'accepted') {
                if (p.friendId != null && String(p.friendId) !== '') return String(p.friendId);
                return String(k);
            }
        }
        return '';
    }

    function getPairForBill(friendId) {
        var st = store();
        if (!st || typeof st.getPair !== 'function') return null;
        var pair = st.getPair(String(friendId || ''));
        if (!pair) return null;
        return pair;
    }

    function patchPairBillData(friendId, patch) {
        var st = store();
        if (!st || typeof st.upsertPair !== 'function') return null;
        st.upsertPair(String(friendId || ''), patch || {});
        return st.getPair ? st.getPair(String(friendId || '')) : null;
    }

    function getLoveTakeoutOrder(friendId, orderId) {
        var pair = ensurePairBillState(friendId);
        var orders = pair && Array.isArray(pair.loveTakeoutOrders) ? pair.loveTakeoutOrders : [];
        for (var i = 0; i < orders.length; i++) {
            if (String(orders[i] && orders[i].orderId) === String(orderId || '')) return orders[i];
        }
        return null;
    }

    function updateLoveTakeoutOrder(friendId, orderId, patch) {
        var fid = String(friendId || '');
        var pair = ensurePairBillState(fid);
        if (!pair) return null;
        var orders = Array.isArray(pair.loveTakeoutOrders) ? pair.loveTakeoutOrders.slice() : [];
        var updated = null;
        for (var i = 0; i < orders.length; i++) {
            if (String(orders[i] && orders[i].orderId) === String(orderId || '')) {
                updated = Object.assign({}, orders[i], patch || {});
                orders[i] = updated;
                break;
            }
        }
        if (!updated) return null;
        patchPairBillData(fid, { loveTakeoutOrders: orders, billDataVersion: 1 });
        return updated;
    }

    function ensurePairBillState(friendId) {
        var fid = String(friendId || '');
        var pair = getPairForBill(fid);
        if (!pair) return null;
        var patch = {};
        if (!Array.isArray(pair.loveTakeoutOrders)) patch.loveTakeoutOrders = [];
        if (!Array.isArray(pair.billLedger)) patch.billLedger = [];
        if (!pair.billDataVersion) patch.billDataVersion = 1;
        if (Object.keys(patch).length) pair = patchPairBillData(fid, patch) || pair;
        return pair;
    }

    function safeMoney(v) {
        var n = Number(v);
        if (!Number.isFinite(n)) return 0;
        return Math.round(n * 100) / 100;
    }

    function formatMoney(v) {
        return '¥' + safeMoney(v).toFixed(2);
    }

    function formatBillTime(ts) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) return '';
        var d = new Date(t);
        var hh = String(d.getHours()).padStart(2, '0');
        var mm = String(d.getMinutes()).padStart(2, '0');
        return d.getFullYear() + '/' + (d.getMonth() + 1) + '/' + d.getDate() + ' ' + hh + ':' + mm;
    }

    function buildTakeoutOrderId() {
        return 'lo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    }

    function getMergedUserInfo() {
        var userInfo = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('userInfo', null) : null;
        var myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        return {
            nickname: (myProfile && myProfile.nickname) || (userInfo && userInfo.nickname) || '我',
            avatar: normalizeAvatarUrl((myProfile && myProfile.avatar) || (userInfo && userInfo.avatar) || '') || ''
        };
    }

    function getRoundCountAfterOrder(friendId, orderCardTs) {
        try {
            if (!global.Wechat || !global.Wechat.prompts || typeof global.Wechat.prompts._buildRoundsFromChatHistory !== 'function') return 0;
            var history = getChatHistoryForBill(friendId).filter(function (it) {
                if (!it) return false;
                if (!(it.type === 'user' || it.type === 'friend')) return false;
                if (Number(it.timestamp) <= Number(orderCardTs || 0)) return false;
                if (String(it.subtype || '') === 'love_takeout_order') return false;
                return true;
            });
            var rounds = global.Wechat.prompts._buildRoundsFromChatHistory(history);
            return Array.isArray(rounds) ? rounds.length : 0;
        } catch (e) {
            return 0;
        }
    }

    function canConfirmLoveTakeout(friendId, order) {
        if (!order) return false;
        if (String(order.status || '') === 'received') return false;
        var receiver = String(order.receiver || '');
        var currentChatFriendId = String(friendId || '');
        if (receiver === 'char') return currentChatFriendId === String(friendId || '') && getRoundCountAfterOrder(friendId, order.sourceChatTimestamps && order.sourceChatTimestamps.orderCardTs) >= 1;
        if (receiver === 'user') return getRoundCountAfterOrder(friendId, order.sourceChatTimestamps && order.sourceChatTimestamps.orderCardTs) >= 1;
        return false;
    }

    function buildBillId(prefix, token) {
        return String(prefix || 'bill') + '_' + String(token || Date.now());
    }

    function getChatHistoryForBill(friendId) {
        try {
            if (global.Wechat && global.Wechat.store && typeof global.Wechat.store.getChatHistoryArray === 'function') {
                return global.Wechat.store.getChatHistoryArray(friendId) || [];
            }
        } catch (e) {}
        return [];
    }

    function saveBillChatMessage(friendId, type, content, timestamp, subtype, extra) {
        if (typeof global.saveChatMessage !== 'function') return;
        global.saveChatMessage(friendId, type, content, null, timestamp, subtype, null, extra || null);
    }

    function appendCoupleBillItem(friendId, item) {
        var fid = String(friendId || '');
        var pair = ensurePairBillState(fid);
        if (!pair || !item) return null;
        var list = Array.isArray(pair.billLedger) ? pair.billLedger.slice() : [];
        var id = String(item.billId || '');
        if (!id) return null;
        var found = false;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i] && list[i].billId) === id) {
                list[i] = item;
                found = true;
                break;
            }
        }
        if (!found) list.push(item);
        patchPairBillData(fid, { billLedger: list, billDataVersion: 1 });
        return item;
    }

    function appendLoveTakeoutOrder(friendId, order) {
        var fid = String(friendId || '');
        var pair = ensurePairBillState(fid);
        if (!pair || !order) return null;
        var list = Array.isArray(pair.loveTakeoutOrders) ? pair.loveTakeoutOrders.slice() : [];
        var found = false;
        for (var i = 0; i < list.length; i++) {
            if (String(list[i] && list[i].orderId) === String(order.orderId)) {
                list[i] = order;
                found = true;
                break;
            }
        }
        if (!found) list.push(order);
        patchPairBillData(fid, { loveTakeoutOrders: list, billDataVersion: 1 });
        return order;
    }

    function sumGiftItems(items) {
        if (!Array.isArray(items)) return 0;
        var total = 0;
        for (var i = 0; i < items.length; i++) {
            var it = items[i] || {};
            total += safeMoney(it.price) * Math.max(1, Number(it.qty) || 1);
        }
        return safeMoney(total);
    }

    function normalizeGiftDetails(items) {
        if (!Array.isArray(items)) return [];
        return items.map(function (it) {
            return {
                name: String((it && (it.name || it.title || it.label)) || '礼物'),
                price: safeMoney(it && it.price),
                qty: Math.max(1, Number(it && it.qty) || 1)
            };
        });
    }

    function makeBillItemFromTransfer(friendId, msg) {
        var actor = msg.type === 'friend' ? 'char' : 'user';
        var direction = actor === 'user' ? 'expense' : 'income';
        return {
            billId: buildBillId('transfer', String(msg.timestamp) + '_' + actor),
            category: 'transfer',
            direction: direction,
            actor: actor,
            target: actor === 'user' ? 'char' : 'user',
            title: '微信转账',
            itemName: '转账',
            amount: safeMoney(msg.content),
            itemDetails: [],
            relatedOrderId: '',
            relatedChat: { friendId: String(friendId || ''), timestamp: Number(msg.timestamp) || 0, subtype: String(msg.subtype || '') },
            source: 'chat',
            createdAt: Number(msg.timestamp) || Date.now(),
            status: String(msg.transferStatus || '')
        };
    }

    function makeBillItemFromRedpacket(friendId, msg) {
        return {
            billId: buildBillId('redpacket', String(msg.timestamp) + '_' + (msg.type === 'friend' ? 'char' : 'user')),
            category: 'redpacket',
            direction: msg.type === 'friend' ? 'income' : 'expense',
            actor: msg.type === 'friend' ? 'char' : 'user',
            target: msg.type === 'friend' ? 'user' : 'char',
            title: '微信红包',
            itemName: String(msg.redpacketMsg || '红包'),
            amount: safeMoney(msg.content),
            itemDetails: [],
            relatedOrderId: '',
            relatedChat: { friendId: String(friendId || ''), timestamp: Number(msg.timestamp) || 0, subtype: 'redpacket' },
            source: 'chat',
            createdAt: Number(msg.timestamp) || Date.now()
        };
    }

    function makeBillItemFromGift(friendId, msg) {
        var details = normalizeGiftDetails(msg.giftItems);
        return {
            billId: buildBillId('gift', msg.orderId || msg.timestamp),
            category: 'gift',
            direction: msg.type === 'friend' ? 'income' : 'expense',
            actor: msg.type === 'friend' ? 'char' : 'user',
            target: msg.type === 'friend' ? 'user' : 'char',
            title: '礼物',
            itemName: details.map(function (it) { return it.name; }).join('、') || '礼物包裹',
            amount: sumGiftItems(details),
            itemDetails: details,
            relatedOrderId: String(msg.orderId || ''),
            relatedChat: { friendId: String(friendId || ''), timestamp: Number(msg.timestamp) || 0, subtype: 'gift_bundle' },
            source: 'chat',
            createdAt: Number(msg.timestamp) || Date.now(),
            status: String(msg.giftStatus || '')
        };
    }

    function makeBillItemFromTakeout(order) {
        var direction = String(order && order.direction || '') === 'char_to_user' ? 'income' : 'expense';
        return {
            billId: buildBillId('takeout', order && order.orderId),
            category: 'takeout',
            direction: direction,
            actor: direction === 'expense' ? 'user' : 'char',
            target: direction === 'expense' ? 'char' : 'user',
            title: '爱的外卖',
            itemName: Array.isArray(order && order.items) ? order.items.map(function (it) { return it.name; }).join('、') : '爱的外卖',
            amount: safeMoney(order && order.totalPrice),
            itemDetails: Array.isArray(order && order.items) ? order.items.slice() : [],
            relatedOrderId: String(order && order.orderId || ''),
            relatedChat: { friendId: '', timestamp: Number(order && order.createdAt) || 0, subtype: 'love_takeout_order' },
            source: 'takeout',
            createdAt: Number(order && order.createdAt) || Date.now(),
            status: String(order && order.status || ''),
            payMethod: String(order && order.payMethod || ''),
            deliveryProgress: order && order.delivery ? Number(order.delivery.routeProgress || 0) : 0
        };
    }

    function buildBillItemsFromChatHistory(friendId, messages) {
        var out = [];
        var list = Array.isArray(messages) ? messages : [];
        for (var i = 0; i < list.length; i++) {
            var msg = list[i] || {};
            if (msg.subtype === 'transfer' || msg.subtype === 'friend_transfer') out.push(makeBillItemFromTransfer(friendId, msg));
            else if (msg.subtype === 'redpacket') out.push(makeBillItemFromRedpacket(friendId, msg));
            else if (msg.subtype === 'gift_bundle') out.push(makeBillItemFromGift(friendId, msg));
            else if (msg.subtype === 'love_takeout_order' && msg.loveTakeoutOrderId) {
                out.push({
                    billId: buildBillId('takeout', msg.loveTakeoutOrderId),
                    category: 'takeout',
                    direction: String(msg.loveTakeoutDirection || '') === 'char_to_user' ? 'income' : 'expense',
                    actor: String(msg.loveTakeoutDirection || '') === 'char_to_user' ? 'char' : 'user',
                    target: String(msg.loveTakeoutDirection || '') === 'char_to_user' ? 'user' : 'char',
                    title: '爱的外卖',
                    itemName: Array.isArray(msg.loveTakeoutItems) ? msg.loveTakeoutItems.map(function (it) { return it.name; }).join('、') : '爱的外卖',
                    amount: safeMoney(msg.loveTakeoutTotalPrice),
                    itemDetails: Array.isArray(msg.loveTakeoutItems) ? msg.loveTakeoutItems.slice() : [],
                    relatedOrderId: String(msg.loveTakeoutOrderId || ''),
                    relatedChat: { friendId: String(friendId || ''), timestamp: Number(msg.timestamp) || 0, subtype: 'love_takeout_order' },
                    source: 'chat',
                    createdAt: Number(msg.timestamp) || Date.now(),
                    status: String(msg.loveTakeoutStatus || '')
                });
            }
        }
        return out;
    }

    function buildBillItemsFromLoveTakeoutOrders(pair) {
        var orders = pair && Array.isArray(pair.loveTakeoutOrders) ? pair.loveTakeoutOrders : [];
        return orders.map(makeBillItemFromTakeout);
    }

    function syncCoupleBillLedger(friendId) {
        var fid = String(friendId || '');
        var pair = ensurePairBillState(fid);
        if (!pair) return null;
        var existing = Array.isArray(pair.billLedger) ? pair.billLedger.slice() : [];
        var map = Object.create(null);
        var merged = [];
        function put(item) {
            if (!item || !item.billId) return;
            var id = String(item.billId);
            if (map[id]) return;
            map[id] = true;
            merged.push(item);
        }
        existing.forEach(put);
        buildBillItemsFromChatHistory(fid, getChatHistoryForBill(fid)).forEach(put);
        buildBillItemsFromLoveTakeoutOrders(pair).forEach(put);
        merged.sort(function (a, b) { return Number(b.createdAt || 0) - Number(a.createdAt || 0); });
        patchPairBillData(fid, { billLedger: merged, billDataVersion: 1 });
        return merged;
    }

    function buildCoupleBillSummaryHtml(items) {
        var income = 0;
        var expense = 0;
        var list = Array.isArray(items) ? items : [];
        for (var i = 0; i < list.length; i++) {
            var amount = safeMoney(list[i] && list[i].amount);
            if (String(list[i] && list[i].direction) === 'income') income += amount;
            else expense += amount;
        }
        return '<div class="couple-bill-summary-card"><div class="couple-bill-summary-label">我的收入</div><div class="couple-bill-summary-value is-income">' + esc(formatMoney(income)) + '</div></div>' +
            '<div class="couple-bill-summary-card"><div class="couple-bill-summary-label">我的支出</div><div class="couple-bill-summary-value is-expense">' + esc(formatMoney(expense)) + '</div></div>';
    }

    function normalizeLoveTakeoutMenuData(data) {
        function normalizeList(list, fallback) {
            var src = Array.isArray(list) ? list : fallback;
            var out = [];
            for (var i = 0; i < src.length; i++) {
                var it = src[i] || {};
                var name = String(it.name || '').trim();
                var price = safeMoney(it.price);
                if (!name || !price) continue;
                out.push({ name: name, price: price, qty: 1 });
            }
            return out.slice(0, 4);
        }
        return {
            drinks: normalizeList(data && data.drinks, LOVE_TAKEOUT_MENU.drinks),
            desserts: normalizeList(data && data.desserts, LOVE_TAKEOUT_MENU.desserts),
            hotMeals: normalizeList(data && data.hotMeals, LOVE_TAKEOUT_MENU.hotMeals)
        };
    }

    function getAllLoveTakeoutItems() {
        return []
            .concat(LOVE_TAKEOUT_MENU.drinks || [])
            .concat(LOVE_TAKEOUT_MENU.desserts || [])
            .concat(LOVE_TAKEOUT_MENU.hotMeals || []);
    }

    function buildLoveTakeoutSectionHtml(title, key, list, startIndex) {
        var rows = (Array.isArray(list) ? list : []).map(function (it, idx) {
            return '<label class="couple-bill-food-item"><input type="checkbox" class="couple-bill-food-check" data-group="' + esc(key) + '" data-index="' + (startIndex + idx) + '"><span class="couple-bill-food-name">' + esc(it.name) + '</span><span class="couple-bill-food-price">' + esc(formatMoney(it.price)) + '</span></label>';
        }).join('');
        return '<div class="couple-bill-food-section"><div class="couple-bill-food-section-title">' + esc(title) + '</div><div class="couple-bill-food-grid">' + rows + '</div></div>';
    }

    function buildTakeoutComposerHtml(friendId) {
        var friend = getFriendById(friendId);
        var friendName = friend ? ((friend.remark || friend.nickname || 'TA').trim() || 'TA') : 'TA';
        var drinks = LOVE_TAKEOUT_MENU.drinks || [];
        var desserts = LOVE_TAKEOUT_MENU.desserts || [];
        var hotMeals = LOVE_TAKEOUT_MENU.hotMeals || [];
        var sections = buildLoveTakeoutSectionHtml('饮品', 'drinks', drinks, 0) +
            buildLoveTakeoutSectionHtml('甜品', 'desserts', desserts, drinks.length) +
            buildLoveTakeoutSectionHtml('热菜', 'hotMeals', hotMeals, drinks.length + desserts.length);
        var refreshText = loveTakeoutMenuRefreshPending ? '刷新中…' : '刷新';
        var refreshDisabled = loveTakeoutMenuRefreshPending ? ' disabled' : '';
        return '<div class="couple-bill-card couple-bill-card--takeout"><div class="couple-bill-card-head"><div class="couple-bill-card-title">点给' + esc(friendName) + '</div><button type="button" class="couple-bill-refresh-btn" onclick="refreshLoveTakeoutMenu()"' + refreshDisabled + '>' + esc(refreshText) + '</button></div><div class="couple-bill-food-scroll-tip">长按菜单区域后向下拖动，可查看更多菜品</div><div class="couple-bill-food-list">' + sections + '</div><textarea id="couple-bill-note-input" class="couple-bill-note-input" maxlength="80" placeholder="给TA留一句备注吧"></textarea><div class="couple-bill-actions"><button type="button" class="couple-bill-primary-btn" onclick="submitUserLoveTakeoutOrder()">给TA点外卖</button><button type="button" class="couple-bill-secondary-btn" onclick="requestCharLoveTakeoutOrder()">让TA请我吃</button></div></div>';
    }

    function renderLoveTakeoutTab(friendId) {
        var panel = document.getElementById('couple-bill-panel-takeout');
        if (!panel) return;
        panel.innerHTML = buildTakeoutComposerHtml(friendId);
        bindLoveTakeoutLongPressScroll();
    }

    function buildBillLedgerRowHtml(item) {
        var details = Array.isArray(item && item.itemDetails) ? item.itemDetails : [];
        var sign = String(item && item.direction) === 'income' ? '+' : '-';
        var targetText = String(item && item.direction) === 'income' ? 'TA给我' : '我给TA';
        var isTakeout = String(item && item.category) === 'takeout';
        if (isTakeout) {
            var detailHtml = '<div class="couple-bill-record-detail is-collapsible" style="display:none;">' + details.map(function (it) {
                return '<span>' + esc(String(it.name || '')) + ' / ' + esc(formatMoney(it.price)) + '</span>';
            }).join('') + '</div>';
            var payMethodText = item && item.payMethod === 'kinship' ? '亲属卡支付' : item && item.payMethod === 'wallet' ? '零钱支付' : '';
            return '<button type="button" class="couple-bill-record couple-bill-record--toggle" onclick="toggleCoupleBillTakeoutDetails(event)"><div class="couple-bill-record-head"><span class="couple-bill-record-tag">' + esc(item.title || '') + '</span><span class="couple-bill-record-amount ' + (String(item && item.direction) === 'income' ? 'is-income' : 'is-expense') + '">' + esc(sign + formatMoney(item.amount)) + '</span></div><div class="couple-bill-record-title">外卖总金额</div><div class="couple-bill-record-meta">' + esc(targetText) + ' · ' + esc(formatBillTime(item.createdAt)) + (payMethodText ? ' · ' + esc(payMethodText) : '') + ' · 点击展开</div>' + detailHtml + '</button>';
        }
        var commonDetailHtml = '';
        if (details.length) {
            commonDetailHtml = '<div class="couple-bill-record-detail">' + details.map(function (it) {
                return '<span>' + esc(String(it.name || '')) + ' × ' + esc(String(it.qty || 1)) + ' / ' + esc(formatMoney(it.price)) + '</span>';
            }).join('') + '</div>';
        }
        return '<div class="couple-bill-record"><div class="couple-bill-record-head"><span class="couple-bill-record-tag">' + esc(item.title || '') + '</span><span class="couple-bill-record-amount ' + (String(item && item.direction) === 'income' ? 'is-income' : 'is-expense') + '">' + esc(sign + formatMoney(item.amount)) + '</span></div><div class="couple-bill-record-title">' + esc(item.itemName || '') + '</div><div class="couple-bill-record-meta">' + esc(targetText) + ' · ' + esc(formatBillTime(item.createdAt)) + (item.status ? ' · ' + esc(item.status) : '') + '</div>' + commonDetailHtml + '</div>';
    }

    function renderCoupleBillLedgerTab(friendId) {
        var panel = document.getElementById('couple-bill-panel-ledger');
        if (!panel) return;
        var items = syncCoupleBillLedger(friendId) || [];
        if (!items.length) {
            panel.innerHTML = '<div class="couple-bill-empty">还没有收支明细记录</div>';
            return;
        }
        panel.innerHTML = '<div class="couple-bill-list">' + items.map(buildBillLedgerRowHtml).join('') + '</div>';
    }

    function renderCoupleBillPage(friendId) {
        var fid = String(friendId || getActiveCoupleFriendId() || '');
        if (!fid) return false;
        var pair = ensurePairBillState(fid);
        if (!pair) return false;
        var items = syncCoupleBillLedger(fid) || [];
        var summary = document.getElementById('couple-bill-summary');
        if (summary) summary.innerHTML = buildCoupleBillSummaryHtml(items);
        renderLoveTakeoutTab(fid);
        renderCoupleBillLedgerTab(fid);
        switchCoupleBillTab(currentCoupleBillTab || 'takeout');
        return true;
    }

    function openCoupleBillPage() {
        var fid = getActiveCoupleFriendId();
        var page = document.getElementById('couple-bill-page');
        var root = document.getElementById('couple-space-page');
        if (!page || !fid) return;
        if (!renderCoupleBillPage(fid)) return;
        if (root) root.classList.add('is-bill-open');
        page.classList.add('show');
        page.setAttribute('aria-hidden', 'false');
    }

    function closeCoupleBillPage() {
        var page = document.getElementById('couple-bill-page');
        var root = document.getElementById('couple-space-page');
        if (!page) return;
        page.classList.remove('show');
        page.setAttribute('aria-hidden', 'true');
        if (root) root.classList.remove('is-bill-open');
    }

    function switchCoupleBillTab(tab) {
        currentCoupleBillTab = String(tab || 'takeout') === 'ledger' ? 'ledger' : 'takeout';
        var takeoutBtn = document.getElementById('couple-bill-tab-takeout');
        var ledgerBtn = document.getElementById('couple-bill-tab-ledger');
        var takeoutPanel = document.getElementById('couple-bill-panel-takeout');
        var ledgerPanel = document.getElementById('couple-bill-panel-ledger');
        if (takeoutBtn) takeoutBtn.classList.toggle('is-active', currentCoupleBillTab === 'takeout');
        if (ledgerBtn) ledgerBtn.classList.toggle('is-active', currentCoupleBillTab === 'ledger');
        if (takeoutPanel) takeoutPanel.classList.toggle('show', currentCoupleBillTab === 'takeout');
        if (ledgerPanel) ledgerPanel.classList.toggle('show', currentCoupleBillTab === 'ledger');
    }

    function parseLoveTakeoutMenuFromApiText(raw) {
        var obj = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(String(raw || '').trim()) : null;
        if (!obj || typeof obj !== 'object') return null;
        return normalizeLoveTakeoutMenuData(obj);
    }

    async function refreshLoveTakeoutMenu() {
        var fid = getActiveCoupleFriendId();
        if (!fid || loveTakeoutMenuRefreshPending) return;
        if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined' || typeof CommandManager.buildLoveTakeoutMenuRefreshSendContent !== 'function') {
            if (typeof showNotification === 'function') showNotification('系统未加载外卖菜单刷新模块');
            return;
        }
        loveTakeoutMenuRefreshPending = true;
        renderLoveTakeoutTab(fid);
        var sendContent = CommandManager.buildLoveTakeoutMenuRefreshSendContent(fid);
        var raw = '';
        try {
            raw = await FeatureCommandMapper.callApiModel(sendContent, null, { skipOverlay: true, suppressErrorDialog: true });
        } catch (e) {
            raw = '';
        }
        loveTakeoutMenuRefreshPending = false;
        if (!raw || !String(raw).trim()) {
            renderLoveTakeoutTab(fid);
            if (typeof showNotification === 'function') showNotification('菜单刷新失败，请稍后重试');
            return;
        }
        var menu = parseLoveTakeoutMenuFromApiText(raw);
        if (!menu) {
            renderLoveTakeoutTab(fid);
            if (typeof showNotification === 'function') showNotification('未能解析新的外卖菜单');
            return;
        }
        LOVE_TAKEOUT_MENU = menu;
        renderLoveTakeoutTab(fid);
        if (typeof showNotification === 'function') showNotification('爱的外卖菜单已刷新');
    }

    function buildLoveTakeoutDetailHtml(friendId, order) {
        var friend = getFriendById(friendId);
        var userInfo = getMergedUserInfo();
        var receiverAvatar = String(order && order.receiver || '') === 'user'
            ? String(userInfo.avatar || '')
            : String((friend && (typeof getFriendDisplayAvatar === 'function'
                ? getFriendDisplayAvatar(friend)
                : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || ''))) || '');
        var receiverName = String(order && order.receiver || '') === 'user'
            ? String(userInfo.nickname || '我')
            : String((friend && (friend.remark || friend.nickname)) || 'TA');
        var progress = order && order.delivery && Number(order.delivery.routeProgress);
        if (!Number.isFinite(progress)) progress = String(order && order.status || '') === 'received' ? 1 : 0.45;
        if (String(order && order.status || '') === 'received') progress = 1;
        progress = Math.max(0.08, Math.min(1, progress));
        var items = Array.isArray(order && order.items) ? order.items : [];
        var lines = items.map(function (it) {
            return '<div class="couple-takeout-detail-line"><span>' + esc(String(it.name || '外卖')) + '</span><span>' + esc(formatMoney(it.price)) + '</span></div>';
        }).join('');
        var unlocked = canConfirmLoveTakeout(friendId, order);
        var canConfirm = unlocked && String(order && order.status || '') !== 'received';
        var btnHtml = '';
        if (String(order && order.status || '') === 'received') {
            btnHtml = '<button type="button" class="couple-takeout-confirm-btn is-done" disabled>已收到</button>';
        } else if (canConfirm) {
            btnHtml = '<button type="button" class="couple-takeout-confirm-btn" data-action="confirm_love_takeout_received" data-fid="' + esc(String(friendId || '')) + '" data-order-id="' + esc(String(order.orderId || '')) + '">已收到</button>';
        } else {
            btnHtml = '<button type="button" class="couple-takeout-confirm-btn" disabled>再聊一轮后可确认收餐</button>';
        }
        return '<div class="couple-takeout-detail-map"><div class="couple-takeout-map-head"><span class="couple-takeout-map-brand">吃了么</span><span class="couple-takeout-map-status">' + esc(String(order && order.status || '') === 'received' ? '您的外卖已送达，别忘了好评哦亲！' : '骑手正在赶来路上') + '</span></div><div class="couple-takeout-route"><div class="couple-takeout-route-line"></div><div class="couple-takeout-rider" style="left:calc(' + esc(String(progress * 100)) + '% - 18px)"><span class="couple-takeout-rider-head"></span><span class="couple-takeout-rider-body"></span><span class="couple-takeout-rider-bike"></span></div><div class="couple-takeout-receiver ' + (receiverAvatar ? '' : 'is-placeholder') + '"' + (receiverAvatar ? ' style="background-image:url(' + JSON.stringify(receiverAvatar).slice(1, -1) + ')"' : '') + '>' + (receiverAvatar ? '' : esc(String(receiverName || 'TA').charAt(0) || 'T')) + '</div></div></div><div class="couple-takeout-detail-card"><div class="couple-takeout-detail-title">外卖清单</div><div class="couple-takeout-detail-list">' + lines + '</div><div class="couple-takeout-detail-total"><span>合计</span><span>' + esc(formatMoney(order.totalPrice)) + '</span></div><div class="couple-takeout-detail-actions">' + btnHtml + '</div></div>';
    }

    function openLoveTakeoutDetailPage(friendId, orderId) {
        var fid = String(friendId || '');
        var order = getLoveTakeoutOrder(fid, orderId);
        var page = document.getElementById('couple-takeout-detail-page');
        var body = document.getElementById('couple-takeout-detail-body');
        if (!page || !body || !order) return;
        body.innerHTML = buildLoveTakeoutDetailHtml(fid, order);
        page.classList.add('show');
        page.setAttribute('aria-hidden', 'false');
    }

    function closeLoveTakeoutDetailPage() {
        var page = document.getElementById('couple-takeout-detail-page');
        if (!page) return;
        page.classList.remove('show');
        page.setAttribute('aria-hidden', 'true');
    }

    function confirmLoveTakeoutReceived(friendId, orderId) {
        var fid = String(friendId || '');
        var order = getLoveTakeoutOrder(fid, orderId);
        if (!order || !canConfirmLoveTakeout(fid, order)) return;
        var now = Date.now();
        var updated = updateLoveTakeoutOrder(fid, orderId, {
            status: 'received',
            deliveredAt: now,
            delivery: { phase: 'received', routeProgress: 1 },
            sourceChatTimestamps: Object.assign({}, order.sourceChatTimestamps || {}, { receiveAckTs: now })
        });
        if (!updated) return;
        syncCoupleBillLedger(fid);
        if (String(updated.receiver || '') === 'user') {
            saveBillChatMessage(fid, 'user', '已经收到外卖啦', now, null, null);
        }
        if (typeof CommandManager !== 'undefined' && typeof FeatureCommandMapper !== 'undefined' && typeof CommandManager.buildLoveTakeoutReceiveAckSendContent === 'function') {
            var ackSendContent = CommandManager.buildLoveTakeoutReceiveAckSendContent(fid, {
                direction: updated.direction,
                receiver: updated.receiver,
                amount: updated.totalPrice,
                items: updated.items,
                note: updated.note
            });
            FeatureCommandMapper.callApiModel(ackSendContent, null, { skipOverlay: true, suppressErrorDialog: true }).then(function (raw) {
                var reply = String(raw || '').trim();
                if (reply) saveBillChatMessage(fid, 'friend', reply, now + 1, null, null);
                if (typeof loadChatHistory === 'function') loadChatHistory(fid);
                renderCoupleBillPage(fid);
                openLoveTakeoutDetailPage(fid, orderId);
            }).catch(function () {
                if (typeof loadChatHistory === 'function') loadChatHistory(fid);
                renderCoupleBillPage(fid);
                openLoveTakeoutDetailPage(fid, orderId);
            });
        } else {
            if (typeof loadChatHistory === 'function') loadChatHistory(fid);
            renderCoupleBillPage(fid);
            openLoveTakeoutDetailPage(fid, orderId);
        }
    }

    function toggleCoupleBillTakeoutDetails(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var btn = ev && ev.currentTarget ? ev.currentTarget : null;
        if (!btn) return;
        var detail = btn.querySelector('.couple-bill-record-detail.is-collapsible');
        var meta = btn.querySelector('.couple-bill-record-meta');
        if (!detail) return;
        var open = detail.style.display !== 'none';
        detail.style.display = open ? 'none' : 'flex';
        btn.classList.toggle('is-open', !open);
        if (meta) meta.textContent = meta.textContent.replace(open ? '点击收起' : '点击展开', open ? '点击展开' : '点击收起');
    }

    function bindLoveTakeoutLongPressScroll() {
        var el = document.querySelector('#couple-bill-panel-takeout .couple-bill-food-list');
        if (!el || el.__longPressScrollBound) return;
        el.__longPressScrollBound = true;
        var state = { pressing: false, active: false, timer: null, startY: 0, startScrollTop: 0, lastY: 0, velocity: 0, raf: 0 };

        function stopMomentum() {
            if (state.raf) {
                cancelAnimationFrame(state.raf);
                state.raf = 0;
            }
        }

        function startMomentum() {
            stopMomentum();
            var step = function () {
                if (Math.abs(state.velocity) < 0.2) {
                    state.velocity = 0;
                    state.raf = 0;
                    return;
                }
                el.scrollTop -= state.velocity;
                state.velocity *= 0.95;
                state.raf = requestAnimationFrame(step);
            };
            state.raf = requestAnimationFrame(step);
        }

        function getY(ev) {
            if (ev.touches && ev.touches[0]) return ev.touches[0].clientY;
            if (ev.changedTouches && ev.changedTouches[0]) return ev.changedTouches[0].clientY;
            return ev.clientY;
        }

        function onStart(ev) {
            stopMomentum();
            state.pressing = true;
            state.active = false;
            state.startY = getY(ev);
            state.lastY = state.startY;
            state.startScrollTop = el.scrollTop;
            state.velocity = 0;
            clearTimeout(state.timer);
            state.timer = setTimeout(function () {
                if (!state.pressing) return;
                state.active = true;
                el.classList.add('is-longpress-scrolling');
            }, 180);
        }

        function onMove(ev) {
            if (!state.pressing) return;
            var y = getY(ev);
            if (!state.active && Math.abs(y - state.startY) > 8) {
                clearTimeout(state.timer);
            }
            if (!state.active) return;
            ev.preventDefault();
            var delta = y - state.startY;
            el.scrollTop = state.startScrollTop - delta;
            state.velocity = y - state.lastY;
            state.lastY = y;
        }

        function onEnd() {
            clearTimeout(state.timer);
            if (state.active) startMomentum();
            state.pressing = false;
            state.active = false;
            el.classList.remove('is-longpress-scrolling');
        }

        el.addEventListener('touchstart', onStart, { passive: true });
        el.addEventListener('touchmove', onMove, { passive: false });
        el.addEventListener('touchend', onEnd, { passive: true });
        el.addEventListener('touchcancel', onEnd, { passive: true });
        el.addEventListener('mousedown', onStart);
        el.addEventListener('mousemove', onMove);
        el.addEventListener('mouseup', onEnd);
        el.addEventListener('mouseleave', onEnd);
    }

    function collectSelectedTakeoutItems() {
        var checks = document.querySelectorAll('#couple-bill-panel-takeout .couple-bill-food-check:checked');
        var pool = getAllLoveTakeoutItems();
        var items = [];
        for (var i = 0; i < checks.length; i++) {
            var idx = Number(checks[i].getAttribute('data-index'));
            var base = pool[idx];
            if (!base) continue;
            items.push({ name: base.name, price: safeMoney(base.price), qty: Math.max(1, Number(base.qty) || 1) });
        }
        return items;
    }

    async function notifyKinshipCardOwnerForTakeout(cardOwnerFriendId, usagePayload) {
        var ownerId = String(cardOwnerFriendId || '');
        if (!ownerId) return;
        if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined' || typeof CommandManager.buildKinshipTakeoutUsageNotifySendContent !== 'function') return;
        var sendContent = CommandManager.buildKinshipTakeoutUsageNotifySendContent(ownerId, usagePayload || {});
        if (!sendContent) return;
        var raw = '';
        try {
            raw = await FeatureCommandMapper.callApiModel(sendContent, null, { skipOverlay: true, suppressErrorDialog: true });
        } catch (e) {
            raw = '';
        }
        var parsed = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(String(raw || '').trim()) : null;
        var sms = parsed && parsed.sms ? String(parsed.sms).trim() : '';
        var wechatReply = parsed && parsed.wechatReply ? String(parsed.wechatReply).trim() : '';
        var now = Date.now();
        if (sms) {
            saveBillChatMessage(ownerId, 'system', sms, now, null, { kinshipUsageType: 'sms_takeout_notice' });
            if (typeof displayMessage === 'function') {
                var chatPage = document.getElementById('chat-page');
                var currentFriendId = chatPage ? String(chatPage.dataset.friendId || '') : '';
                if (currentFriendId === ownerId) displayMessage('system', sms, null, now, ownerId, null);
            }
        }
        if (wechatReply) {
            saveBillChatMessage(ownerId, 'friend', wechatReply, now + 1, null, null);
            if (typeof displayMessage === 'function') {
                var chatPage2 = document.getElementById('chat-page');
                var currentFriendId2 = chatPage2 ? String(chatPage2.dataset.friendId || '') : '';
                if (currentFriendId2 === ownerId) displayMessage('friend', wechatReply, null, now + 1, ownerId, null);
            }
        }
        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
    }

    function submitUserLoveTakeoutOrder() {
        var fid = getActiveCoupleFriendId();
        if (!fid) return;
        var items = collectSelectedTakeoutItems();
        if (!items.length) {
            if (typeof showNotification === 'function') showNotification('请先选择外卖菜品');
            return;
        }
        var noteInput = document.getElementById('couple-bill-note-input');
        var note = noteInput ? String(noteInput.value || '').trim() : '';
        var totalPrice = sumGiftItems(items);
        var friend = getFriendById(fid);
        var targetName = friend ? ((friend.remark || friend.nickname || 'TA').trim() || 'TA') : 'TA';
        if (!global.Wechat || !global.Wechat.wallet || typeof global.Wechat.wallet.requestPaymentWithMethod !== 'function') {
            if (typeof showNotification === 'function') showNotification('钱包模块未加载，暂时无法支付外卖');
            return;
        }
        global.Wechat.wallet.requestPaymentWithMethod(totalPrice, '爱的外卖', targetName, function (payMethod, paymentMeta) {
            var ts = Date.now();
            var order = {
                orderId: buildTakeoutOrderId(),
                type: 'love_takeout',
                direction: 'user_to_char',
                payer: 'user',
                receiver: 'char',
                status: 'pending_delivery',
                totalPrice: totalPrice,
                items: items,
                note: note,
                payMethod: payMethod,
                paymentMeta: paymentMeta || null,
                createdAt: ts,
                acceptedAt: ts,
                deliveredAt: null,
                delivery: { phase: 'moving', routeProgress: 0.38 },
                sourceChatTimestamps: { orderCardTs: ts, receiveAckTs: 0 }
            };
            appendLoveTakeoutOrder(fid, order);
            appendCoupleBillItem(fid, makeBillItemFromTakeout(order));
            saveBillChatMessage(fid, 'user', '[爱的外卖] ' + items.map(function (it) { return it.name; }).join('、'), ts, 'love_takeout_order', {
                loveTakeoutOrderId: order.orderId,
                loveTakeoutDirection: order.direction,
                loveTakeoutStatus: order.status,
                loveTakeoutItems: order.items,
                loveTakeoutTotalPrice: order.totalPrice,
                loveTakeoutNote: order.note,
                loveTakeoutPayMethod: payMethod
            });
            if (noteInput) noteInput.value = '';
            renderCoupleBillPage(fid);
            if (typeof showNotification === 'function') showNotification(payMethod === 'kinship' ? '已使用亲属卡给TA点外卖' : '已从钱包支付给TA点外卖');
            if (typeof CommandManager !== 'undefined' && typeof FeatureCommandMapper !== 'undefined' && typeof CommandManager.buildLoveTakeoutOrderNotifySendContent === 'function') {
                var orderSendContent = CommandManager.buildLoveTakeoutOrderNotifySendContent(fid, {
                    direction: order.direction,
                    amount: order.totalPrice,
                    note: order.note,
                    items: order.items,
                    payMethod: order.payMethod || 'wallet'
                });
                FeatureCommandMapper.callApiModel(orderSendContent, null, { skipOverlay: true, suppressErrorDialog: true }).then(function (raw) {
                    var reply = String(raw || '').trim();
                    if (!reply) return;
                    var replyTs = Date.now() + 1;
                    saveBillChatMessage(fid, 'friend', reply, replyTs, null, null);
                    if (typeof loadChatHistory === 'function') loadChatHistory(fid);
                }).catch(function () {});
            }
            if (paymentMeta && paymentMeta.method === 'kinship' && paymentMeta.card && paymentMeta.card.fromFriendId) {
                notifyKinshipCardOwnerForTakeout(paymentMeta.card.fromFriendId, {
                    amount: totalPrice,
                    reason: 'User给' + targetName + '点爱的外卖',
                    targetName: targetName,
                    payer: 'user',
                    useCardFromFriendId: String(paymentMeta.card.fromFriendId || ''),
                    useCardRemainAmount: safeMoney(paymentMeta.remainAmount),
                    itemNames: items.map(function (it) { return it.name; }),
                    itemTotal: items.length
                });
            }
        }, function () {});
    }

    function requestCharLoveTakeoutOrder() {
        var fid = getActiveCoupleFriendId();
        if (!fid) return;
        var noteInput = document.getElementById('couple-bill-note-input');
        var userWish = noteInput ? String(noteInput.value || '').trim() : '';
        requestCharLoveTakeoutOrderFromChat(fid, userWish);
    }

    function requestCharLoveTakeoutOrderFromChat(fid, userWish) {
        fid = String(fid || '');
        if (!fid) return false;
        var pool = getAllLoveTakeoutItems().slice();
        var shuffled = pool.sort(function () { return Math.random() > 0.5 ? 1 : -1; });
        var pickCount = Math.random() > 0.6 ? 2 : 1;
        var items = shuffled.slice(0, pickCount).map(function (it) {
            return { name: it.name, price: safeMoney(it.price), qty: 1 };
        });
        var accepted = Math.random() > 0.2;
        var timestamp = Date.now();
        if (!accepted) {
            saveBillChatMessage(fid, 'friend', userWish ? '今天先不点外卖啦，不过我记住你想吃“' + userWish + '”了。' : '这次先不点外卖啦，下次我补给你吃。', timestamp, null, null);
            if (typeof loadChatHistory === 'function') loadChatHistory(fid);
            if (typeof showNotification === 'function') showNotification('TA 这次没有下单');
            return;
        }
        var order = {
            orderId: buildTakeoutOrderId(),
            type: 'love_takeout',
            direction: 'char_to_user',
            payer: 'char',
            receiver: 'user',
            status: 'pending_delivery',
            totalPrice: sumGiftItems(items),
            items: items,
            note: userWish || '给你点了你会喜欢的',
            createdAt: timestamp,
            acceptedAt: timestamp,
            deliveredAt: null,
            delivery: { phase: 'moving', routeProgress: 0.34 },
            sourceChatTimestamps: { orderCardTs: timestamp, receiveAckTs: 0 }
        };
        appendLoveTakeoutOrder(fid, order);
        appendCoupleBillItem(fid, makeBillItemFromTakeout(order));
        saveBillChatMessage(fid, 'friend', '给你点了爱的外卖，记得趁热吃。', timestamp - 1, null, null);
        saveBillChatMessage(fid, 'friend', '[爱的外卖] ' + items.map(function (it) { return it.name; }).join('、'), timestamp, 'love_takeout_order', {
            loveTakeoutOrderId: order.orderId,
            loveTakeoutDirection: order.direction,
            loveTakeoutStatus: order.status,
            loveTakeoutItems: order.items,
            loveTakeoutTotalPrice: order.totalPrice,
            loveTakeoutNote: order.note
        });
        renderCoupleBillPage(fid);
        if (typeof CommandManager !== 'undefined' && typeof FeatureCommandMapper !== 'undefined' && typeof CommandManager.buildLoveTakeoutOrderNotifySendContent === 'function') {
            var charOrderSendContent = CommandManager.buildLoveTakeoutOrderNotifySendContent(fid, {
                direction: order.direction,
                amount: order.totalPrice,
                note: order.note,
                items: order.items,
                payMethod: 'char'
            });
            FeatureCommandMapper.callApiModel(charOrderSendContent, null, { skipOverlay: true, suppressErrorDialog: true }).then(function (raw) {
                var reply = String(raw || '').trim();
                if (!reply) return;
                saveBillChatMessage(fid, 'friend', reply, Date.now() + 2, null, null);
                if (typeof loadChatHistory === 'function') loadChatHistory(fid);
            }).catch(function () {
                if (typeof loadChatHistory === 'function') loadChatHistory(fid);
            });
        } else if (typeof loadChatHistory === 'function') {
            loadChatHistory(fid);
        }
        if (typeof showNotification === 'function') showNotification('TA 给你点了爱的外卖');
        return true;
    }

    function setAvatarNode(node, name, avatarUrl) {
        if (!node) return;
        var src = cleanAvatarData(String(avatarUrl || ''));
        if (src) {
            node.style.backgroundImage = "url('" + escAttrUrl(src) + "')";
            node.style.backgroundColor = '#fff';
            node.textContent = '';
        } else {
            node.style.backgroundImage = '';
            node.style.backgroundColor = '#bbb';
            node.textContent = String(name || '?').charAt(0);
        }
    }

    function formatCoupleDateLine(ts) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) t = Date.now();
        var d = new Date(t);
        return '于 ' + d.getFullYear() + ' 年 ' + (d.getMonth() + 1) + '月' + d.getDate() + '日 牵手成为情侣';
    }

    function formatCoupleDaysLine(ts) {
        var t = Number(ts);
        if (!Number.isFinite(t) || t <= 0) t = Date.now();
        var base = new Date(t);
        var now = new Date();
        var a = new Date(base.getFullYear(), base.getMonth(), base.getDate()).getTime();
        var b = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
        var days = Math.floor((b - a) / 86400000) + 1;
        if (!Number.isFinite(days) || days < 1) days = 1;
        return '相伴彼此的第 ' + days + ' 天';
    }

    function closeCoupleSpaceAddMenu() {
        var menu = document.getElementById('couple-space-add-menu');
        if (menu) menu.classList.remove('is-open');
    }

    function toggleCoupleSpaceAddMenu(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var menu = document.getElementById('couple-space-add-menu');
        if (!menu) return;
        var willOpen = !menu.classList.contains('is-open');
        closeCoupleSpaceAddMenu();
        if (willOpen) {
            renderCoupleSpaceInviteMenu();
            menu.classList.add('is-open');
        }
    }

    function bindCoupleSpaceMenuOutsideCloseOnce() {
        if (global.__coupleSpaceMenuOutsideBound) return;
        global.__coupleSpaceMenuOutsideBound = true;
        document.addEventListener('click', function () {
            closeCoupleSpaceAddMenu();
        });
    }

    function renderCoupleSpaceInviteMenu() {
        var menu = document.getElementById('couple-space-add-menu');
        if (!menu) return;
        var st = store();
        if (!st) {
            menu.innerHTML = '<div class="couple-space-add-empty">Wechat.store 未就绪</div>';
            return;
        }
        var list = st.getInviteEligibleFriends() || [];
        menu.innerHTML = '';
        if (!list.length) {
            var empty = document.createElement('div');
            empty.className = 'couple-space-add-empty';
            empty.textContent =
                '暂无可邀请好友：角色卡需体现为单身/无婚恋对象；已写明恋人、妻子等婚恋关系、与User血缘兄姐、闺蜜/铁哥们等关系的好友不会出现在此列表（文本启发式判断）。';
            menu.appendChild(empty);
            return;
        }
        list.forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'couple-space-add-item';
            row.setAttribute('role', 'menuitem');
            var av = document.createElement('div');
            av.className = 'couple-space-add-avatar';
            var src = typeof getFriendDisplayAvatar === 'function'
                ? getFriendDisplayAvatar(f)
                : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '');
            src = cleanAvatarData(String(src || ''));
            if (src) {
                av.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
                av.textContent = '';
            } else {
                var name = (f.remark || f.nickname || '?').trim() || '?';
                av.textContent = name.charAt(0);
                av.style.background = '#bbb';
            }
            var meta = document.createElement('div');
            meta.className = 'couple-space-add-meta';
            var nm = document.createElement('div');
            nm.className = 'couple-space-add-name';
            nm.textContent = (f.remark || f.nickname || '未命名').trim() || '未命名';
            var sub = document.createElement('div');
            sub.className = 'couple-space-add-sub';
            sub.textContent =
                typeof st.getInviteRowSubtitle === 'function' ? st.getInviteRowSubtitle(f) : '可邀请';
            meta.appendChild(nm);
            meta.appendChild(sub);
            row.appendChild(av);
            row.appendChild(meta);
            row.addEventListener('click', function (e) {
                if (e) e.stopPropagation();
                closeCoupleSpaceAddMenu();
                confirmAndInviteCoupleSpaceFriend(f);
            });
            menu.appendChild(row);
        });
    }

    function confirmAndInviteCoupleSpaceFriend(friend) {
        if (!friend || friend.id == null) return;
        var name = (friend.remark || friend.nickname || '这位好友').trim() || '这位好友';
        var ok = false;
        try {
            ok = window.confirm(
                '您确定邀请' + name + '和您建立情侣关系，开启属于你们的甜蜜情侣空间吗？'
            );
        } catch (e) {
            ok = false;
        }
        if (!ok) return;
        return inviteCoupleSpaceFriendFlow(friend);
    }

    function parseCoupleDecisionFromApiText(raw) {
        var text = String(raw || '').trim();
        if (!text) return { decision: 'reject', message: '', raw: text };
        text = text.replace(/^```[\s\S]*?\n?/, '').replace(/```$/, '').trim();
        var obj = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(text) : null;
        if (obj && typeof obj === 'object') {
            var d = String(obj.decision || obj.choice || obj.result || '').trim().toLowerCase();
            var decision = 'reject';
            if (d === 'accept' || d === 'agree' || d === 'yes' || d === 'true' || d === '接受' || d === '同意') decision = 'accept';
            var msg = obj.message != null ? String(obj.message) : (obj.reply != null ? String(obj.reply) : '');
            msg = msg.trim();
            return { decision: decision, message: msg, raw: text };
        }
        // 兜底：从文本中抓关键词（允许模型输出 markdown / 条目式）
        var decision = 'reject';
        if (/同意|接受|好啊|好呀|愿意|行啊|当然可以|accept|agree|yes/i.test(text) && !(/不好意思|抱歉|不行|拒绝|算了|reject|decline|no/i.test(text))) {
            decision = 'accept';
        }

        var cleaned = text
            .replace(/\r/g, '\n')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim();
        var lines = cleaned.split('\n').map(function (l) { return String(l || '').trim(); }).filter(Boolean);
        var kept = lines.filter(function (l) {
            if (/^[-*•\d.)\s]*\s*decision\s*[:：]/i.test(l)) return false;
            if (/^[-*•\d.)\s]*\s*(message|reply|result|choice)\s*[:：]/i.test(l)) return false;
            if (/构思|思维链|推理|chain[- ]?of[- ]?thought|cot|output format|json|decision/i.test(l)) return false;
            if (/accept|reject/i.test(l) && l.length <= 40) return false;
            return true;
        });
        var msg = kept.join('\n').trim();
        return { decision: decision, message: msg, raw: text };
    }

    function isCoupleDecisionMessageInvalid(msg) {
        var s = String(msg || '').trim();
        if (!s) return true;
        if (s.length < 2) return true;
        if (/^[-*•\d.)\s]*\s*decision\s*[:：]/i.test(s)) return true;
        if (/构思|思维链|推理|chain[- ]?of[- ]?thought|cot|output format|json/i.test(s)) return true;
        if (/^(accept|reject|同意|拒绝)[\s。.，,;；:：]*$/i.test(s)) return true;
        return false;
    }

    function buildCoupleDecisionFallbackMessage(decision) {
        if (String(decision) === 'accept') {
            return '好，我答应你。那就一起开启我们的情侣空间吧。';
        }
        return '抱歉，我现在还没准备好进入这段关系。';
    }

    async function inviteCoupleSpaceFriendFlow(friend) {
        var st = store();
        if (!st) {
            if (typeof showNotification === 'function') showNotification('系统未加载 Wechat.store');
            return;
        }
        if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined') {
            if (typeof showNotification === 'function') showNotification('系统未加载 API 模块');
            return;
        }
        var friendId = String(friend.id);
        var inviteId = 'cinv_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
        var ts = Date.now();

        var userName = getUserDisplayName();
        var userAvatar = getUserAvatarUrl();
        var friendName = (friend.remark || friend.nickname || '好友').trim() || '好友';
        var friendAvatar = cleanAvatarData(String(typeof getFriendDisplayAvatar === 'function'
            ? getFriendDisplayAvatar(friend)
            : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || '')));

        var invitePayload = {
            v: 1,
            kind: 'invite',
            inviteId: inviteId,
            fromUserName: userName,
            fromUserAvatar: userAvatar || '',
            toFriendId: friendId,
            toFriendName: friendName,
            toFriendAvatar: friendAvatar || '',
            createdAt: ts
        };

        try {
            st.upsertPair(friendId, { lastInviteId: inviteId, lastInviteStatus: 'pending' });
        } catch (e) {}

        // 1) 邀请卡片（用户侧）
        var json = '';
        try {
            json = JSON.stringify(invitePayload);
        } catch (e) {
            json = '';
        }
        if (!json) {
            if (typeof showNotification === 'function') showNotification('邀请数据生成失败');
            return;
        }

        if (typeof displayMessage === 'function') {
            displayMessage('user', json, null, ts, friendId, 'couple_space_invite_card');
        }
        if (typeof saveChatMessage === 'function') {
            saveChatMessage(friendId, 'user', json, null, ts, 'couple_space_invite_card');
        }
        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();

        // 2) API：让好友表态
        var sendContent =
            typeof CommandManager.buildCoupleSpaceInviteDecisionSendContent === 'function'
                ? CommandManager.buildCoupleSpaceInviteDecisionSendContent(friendId, invitePayload)
                : null;
        if (!sendContent) {
            if (typeof showNotification === 'function') showNotification('无法拼装情侣空间邀请提示词');
            return;
        }

        var raw = '';
        try {
            raw = await FeatureCommandMapper.callApiModel(sendContent, null, { skipOverlay: true });
        } catch (e) {
            console.error(e);
            raw = '';
        }
        if (!raw || !String(raw).trim()) {
            if (typeof showNotification === 'function') showNotification('模型无响应，请稍后再试');
            return;
        }

        var parsed = parseCoupleDecisionFromApiText(raw);
        if (isCoupleDecisionMessageInvalid(parsed.message)) {
            parsed.message = buildCoupleDecisionFallbackMessage(parsed.decision);
        }
        var respTs = Date.now() + 1;

        // 3) 好友文本回复（情绪表达）
        var friendText = parsed.message;
        if (typeof resolveEmojiRefsInMessage === 'function' && typeof EMOJI_DATA_LS_KEY !== 'undefined') {
            try {
                var emojiData = typeof parseJsonFromPossiblyEncodedStorage === 'function'
                    ? parseJsonFromPossiblyEncodedStorage(EMOJI_DATA_LS_KEY, {})
                    : {};
                var all = [];
                for (var c in emojiData) all = all.concat(emojiData[c] || []);
                friendText = resolveEmojiRefsInMessage(friendText, all);
            } catch (e) {}
        }

        if (typeof displayMessage === 'function') {
            displayMessage('friend', friendText, null, respTs, friendId, null);
        }
        if (typeof saveChatMessage === 'function') {
            saveChatMessage(friendId, 'friend', friendText, null, respTs, null);
        }

        // 4) 同意：追加「答应邀请」卡片 + 写入情侣空间状态
        if (parsed.decision === 'accept') {
            var acceptPayload = {
                v: 1,
                kind: 'accept',
                inviteId: inviteId,
                friendId: friendId,
                friendName: friendName,
                friendAvatar: friendAvatar || '',
                userName: userName,
                userAvatar: userAvatar || '',
                acceptedAt: respTs + 1
            };
            var json2 = '';
            try {
                json2 = JSON.stringify(acceptPayload);
            } catch (e) {
                json2 = '';
            }
            var cardTs = respTs + 2;
            if (json2) {
                if (typeof displayMessage === 'function') {
                    displayMessage('friend', json2, null, cardTs, friendId, 'couple_space_accept_card');
                }
                if (typeof saveChatMessage === 'function') {
                    saveChatMessage(friendId, 'friend', json2, null, cardTs, 'couple_space_accept_card');
                }
            }
            try {
                st.markAccepted(friendId, { inviteId: inviteId });
                st.setActiveCoupleFriendId(friendId);
            } catch (e) {}
            renderCoupleSpaceMainCard();
            if (typeof showNotification === 'function') showNotification('对方已接受情侣空间邀请');
        } else {
            try {
                st.markRejected(friendId, { inviteId: inviteId });
            } catch (e) {}
            if (typeof showNotification === 'function') showNotification('对方婉拒了邀请');
        }

        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
    }

    function renderCoupleSpaceMainCard() {
        var host = document.getElementById('couple-space-card-host');
        var hint = document.getElementById('couple-space-hint');
        var st = store();
        if (!host || !st) return;

        var state = st.getState ? st.getState() : { pairs: {} };
        var pairs = state && state.pairs && typeof state.pairs === 'object' ? state.pairs : {};

        var friends = typeof loadFriendsFromStorage === 'function' ? loadFriendsFromStorage() : [];
        var friendsById = new Map((friends || []).map(function (f) { return [String(f.id), f]; }));

        var acceptedPairs = Object.keys(pairs)
            .map(function (k) { return pairs[k]; })
            .filter(function (p) {
                if (!p || String(p.status) !== 'accepted' || p.friendId == null) return false;
                var fid = String(p.friendId);
                if (friendsById.has(fid)) return true;
                var fn = String(p.friendName || '').trim();
                var fa = String(p.friendAvatar || '').trim();
                return !!(fn || fa);
            })
            .sort(function (a, b) { return (Number(b.acceptedAt) || 0) - (Number(a.acceptedAt) || 0); });

        if (!acceptedPairs.length) {
            host.style.display = 'none';
            host.innerHTML = '';
            if (hint) hint.style.display = '';
            return;
        }

        var userName = getUserDisplayName();
        var userAvatar = getUserAvatarUrl();

        function buildCardHtml(pair, idx) {
            var fid = String(pair.friendId);
            var f = friendsById.get(fid) || null;
            var friendName = f ? ((f.remark || f.nickname || '好友').trim() || '好友') : (String(pair.friendName || '').trim() || '好友');
            var friendAvatar = f
                ? cleanAvatarData(String(typeof getFriendDisplayAvatar === 'function'
                    ? getFriendDisplayAvatar(f)
                    : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '')))
                : cleanAvatarData(String(pair.friendAvatar || ''));

            var userAv =
                userAvatar
                    ? '<div class="couple-space-entry-avatar" style="background-image:url(\'' + escAttrUrl(userAvatar) + '\')"></div>'
                    : '<div class="couple-space-entry-avatar" style="background:#bbb">' + esc(userName.charAt(0)) + '</div>';
            var friendAv =
                friendAvatar
                    ? '<div class="couple-space-entry-avatar" style="background-image:url(\'' + escAttrUrl(friendAvatar) + '\')"></div>'
                    : '<div class="couple-space-entry-avatar" style="background:#bbb">' + esc(friendName.charAt(0)) + '</div>';

            var gradId = 'csHeartGrad_' + String(idx);
            var connector =
                '<svg class="couple-space-entry-connector" viewBox="0 0 120 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">\n' +
                '  <defs>\n' +
                '    <linearGradient id="' + gradId + '" x1="0" y1="0" x2="1" y2="1">\n' +
                '      <stop offset="0%" stop-color="#F4B0A5"/>\n' +
                '      <stop offset="100%" stop-color="#F7F0EA"/>\n' +
                '    </linearGradient>\n' +
                '  </defs>\n' +
                '  <path d="M18 22h62" fill="none" stroke="url(#' + gradId + ')" stroke-width="2.6" stroke-linecap="round"/>\n' +
                '  <path d="M78 22 L92 14 L92 30 Z" fill="none" stroke="url(#' + gradId + ')" stroke-width="2.6" stroke-linejoin="round"/>\n' +
                '  <path d="M22 22c-6-10-18-9-18 2 0 9 10 14 18 18 8-4 18-9 18-18 0-11-12-12-18-2z" fill="none" stroke="#F4B0A5" stroke-width="2.2" stroke-linejoin="round"/>\n' +
                '  <path d="M86 22c-6-10-18-9-18 2 0 9 10 14 18 18 8-4 18-9 18-18 0-11-12-12-18-2z" fill="none" stroke="#F4B0A5" stroke-width="2.2" stroke-linejoin="round"/>\n' +
                '</svg>';

            return (
                '<div class="couple-space-entry-card" role="button" tabindex="0" data-friend-id="' + esc(fid) + '" title="进入情侣空间">\n' +
                '  <div class="couple-space-entry-card-title">我们的情侣空间</div>\n' +
                '  <div class="couple-space-entry-row">\n' +
                '    ' + friendAv + '\n' +
                '    ' + connector + '\n' +
                '    ' + userAv + '\n' +
                '  </div>\n' +
                '  <div class="couple-space-entry-foot">点击进入私密空间</div>\n' +
                '</div>'
            );
        }

        if (hint) hint.style.display = 'none';
        host.style.display = 'block';
        host.innerHTML = acceptedPairs.map(function (p, i) { return buildCardHtml(p, i); }).join('');
    }

    function bindCoupleEntryOpenOnce() {
        if (global.__coupleEntryOpenBound) return;
        global.__coupleEntryOpenBound = true;
        var host = document.getElementById('couple-space-card-host');
        if (!host) return;
        host.addEventListener('click', function (e) {
            var card = e && e.target && e.target.closest ? e.target.closest('.couple-space-entry-card') : null;
            if (!card) return;
            var fid = card.getAttribute('data-friend-id') || '';
            if (!fid) return;
            openCouplePrivateSpace(fid);
        });
        host.addEventListener('keydown', function (e) {
            var key = e && e.key ? e.key : '';
            if (key !== 'Enter' && key !== ' ') return;
            var card = e && e.target && e.target.closest ? e.target.closest('.couple-space-entry-card') : null;
            if (!card) return;
            e.preventDefault();
            var fid = card.getAttribute('data-friend-id') || '';
            if (!fid) return;
            openCouplePrivateSpace(fid);
        });
    }

    function renderCouplePrivateSpace(friendId) {
        var st = store();
        if (!st) return false;
        var fid = String(friendId || '');
        if (!fid) return false;
        var pair = st.getPair ? st.getPair(fid) : null;
        if (!pair || String(pair.status) !== 'accepted') {
            if (typeof showNotification === 'function') showNotification('仅可进入已确认关系的情侣空间');
            return false;
        }
        var friend = getFriendById(fid);
        var userName = getUserDisplayName();
        var userAvatar = getUserAvatarUrl();
        var friendName = friend ? ((friend.remark || friend.nickname || '好友').trim() || '好友') : (String(pair.friendName || '好友').trim() || '好友');
        var friendAvatar = friend
            ? cleanAvatarData(String(typeof getFriendDisplayAvatar === 'function'
                ? getFriendDisplayAvatar(friend)
                : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || '')))
            : cleanAvatarData(String(pair.friendAvatar || ''));

        var hero = document.getElementById('couple-private-hero');
        var titleNode = document.getElementById('couple-private-editable-title');
        var userAvatarNode = document.getElementById('couple-private-user-avatar');
        var friendAvatarNode = document.getElementById('couple-private-friend-avatar');
        var dateNode = document.getElementById('couple-private-meta-date');
        var daysNode = document.getElementById('couple-private-meta-days');
        var breakBtn = document.getElementById('couple-private-break-btn');
        if (breakBtn) breakBtn.setAttribute('data-friend-id', fid);
        if (titleNode) titleNode.setAttribute('data-friend-id', fid);
        if (!hero || !titleNode || !userAvatarNode || !friendAvatarNode) return false;

        setAvatarNode(userAvatarNode, userName, userAvatar);
        setAvatarNode(friendAvatarNode, friendName, friendAvatar);

        var bg = cleanAvatarData(String(pair.privateBgDataUrl || ''));
        if (bg) {
            hero.classList.remove('is-empty');
            hero.style.backgroundImage =
                'linear-gradient(145deg, rgba(247, 237, 235, 0.95) 0%, rgba(219, 226, 236, 0.88) 60%, rgba(231, 173, 172, 0.82) 120%),url(' +
                JSON.stringify(bg) +
                ')';
        } else {
            hero.classList.add('is-empty');
            hero.style.backgroundImage = '';
        }

        var title = String(pair.privateTitle || '').trim();
        if (!title) title = getDefaultPrivateTitle(userName, friendName);
        titleNode.textContent = title;
        titleNode.setAttribute('data-friend-id', fid);
        var sinceTs = Number(pair.acceptedAt || pair.updatedAt || Date.now());
        if (dateNode) dateNode.textContent = formatCoupleDateLine(sinceTs);
        if (daysNode) daysNode.textContent = formatCoupleDaysLine(sinceTs);
        return true;
    }

    function openCouplePrivateSpace(friendId) {
        ensureCoupleSpaceBreakClickDelegate();
        var page = document.getElementById('couple-private-page');
        var root = document.getElementById('couple-space-page');
        if (!page) return;
        var ok = renderCouplePrivateSpace(friendId);
        if (!ok) return;
        var st = store();
        try {
            if (st && typeof st.setActiveCoupleFriendId === 'function') st.setActiveCoupleFriendId(friendId);
        } catch (e) {}
        closeCoupleSpaceAddMenu();
        if (root) root.classList.add('is-private-open');
        page.classList.add('show');
        page.setAttribute('aria-hidden', 'false');
    }

    function closeCouplePrivateSpace(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var page = document.getElementById('couple-private-page');
        var root = document.getElementById('couple-space-page');
        if (!page) return;
        page.classList.remove('show');
        page.setAttribute('aria-hidden', 'true');
        if (root) root.classList.remove('is-private-open');
        if (typeof global.closeCoupleDiaryPage === 'function') global.closeCoupleDiaryPage();
        closeCoupleBillPage();
    }

    function triggerCouplePrivateBgUpload(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var input = document.getElementById('couple-private-bg-input');
        if (input) input.click();
    }

    function handleCouplePrivateBgSelect(ev) {
        var input = ev && ev.target ? ev.target : document.getElementById('couple-private-bg-input');
        if (!input || !input.files || !input.files[0]) return;
        var file = input.files[0];
        var titleNode = document.getElementById('couple-private-editable-title');
        var fid = titleNode ? String(titleNode.getAttribute('data-friend-id') || '') : '';
        if (!fid) return;
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
            if (typeof showNotification === 'function') showNotification('请选择 JPEG、PNG 或 GIF 图片');
            input.value = '';
            return;
        }
        var st = store();
        if (!st || typeof st.upsertPair !== 'function') return;
        var reader = new FileReader();
        reader.onload = function () {
            var dataUrl = String(reader.result || '');
            if (!dataUrl) return;
            (async function () {
                var out = dataUrl;
                if (typeof compressDataUrlImage === 'function') {
                    try {
                        out = await compressDataUrlImage(out, { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' });
                    } catch (e0) {}
                }
                try {
                    st.upsertPair(fid, { privateBgDataUrl: out });
                } catch (e1) {}
                if (global.__coupleSpaceStateLastPersistOk === false && typeof compressDataUrlImage === 'function') {
                    try {
                        var smaller = await compressDataUrlImage(out, { maxDim: 960, quality: 0.72, mime: 'image/jpeg' });
                        st.upsertPair(fid, { privateBgDataUrl: smaller });
                    } catch (e2) {}
                }
                renderCouplePrivateSpace(fid);
                if (global.__coupleSpaceStateLastPersistOk === false && typeof showNotification === 'function') {
                    showNotification('背景已显示；写入本地失败（存储空间不足）。清理聊天记录或图片后重试，否则刷新页面可能丢失。');
                }
            })();
        };
        reader.readAsDataURL(file);
        input.value = '';
    }

    function confirmBreakCoupleRelation(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var now = Date.now();
        if (global.__lastConfirmBreakAt != null && now - global.__lastConfirmBreakAt < 500) {
            return;
        }
        global.__lastConfirmBreakAt = now;
        var st = store();
        var btn = document.getElementById('couple-private-break-btn');
        var titleNode = document.getElementById('couple-private-editable-title');
        var fid = btn ? String(btn.getAttribute('data-friend-id') || '') : '';
        if (!fid && st && typeof st.getActiveCoupleFriendId === 'function') {
            fid = String(st.getActiveCoupleFriendId() || '');
        }
        if (!fid && titleNode) {
            fid = String(titleNode.getAttribute('data-friend-id') || '');
        }
        if (!fid && st) {
            fid = getFirstAcceptedCoupleFriendIdFromState(st);
        }
        if (!fid) {
            if (typeof showNotification === 'function') {
                showNotification('无法确定当前情侣，请从「我们的情侣空间」重新进入后重试');
            }
            return;
        }
        if (!st || typeof st.upsertPair !== 'function') {
            if (typeof showNotification === 'function') {
                showNotification('系统未就绪，请稍后再试');
            }
            return;
        }
        var friend = getFriendById(fid);
        var name = friend ? ((friend.remark || friend.nickname || '这位好友').trim() || '这位好友') : '这位好友';
        var msg = '确定要和' + name + '解除情侣关系吗？解除后将关闭甜蜜空间。';

        function doBreakCoupleRelation() {
            try {
                st.upsertPair(fid, { status: 'ended', endedAt: Date.now() });
                if (typeof st.getActiveCoupleFriendId === 'function' && String(st.getActiveCoupleFriendId() || '') === fid) {
                    st.setActiveCoupleFriendId('');
                }
            } catch (e) {}
            closeCouplePrivateSpace();
            renderCoupleSpaceMainCard();
            if (typeof showNotification === 'function') {
                showNotification('已解除情侣关系');
            }
        }

        // 微信 WebView 等常拦截 window.confirm；优先 window.showConfirmDialog（app.js 显式挂载且 DOM 挂到 #app 内）
        var confirmFn = null;
        if (typeof global !== 'undefined' && typeof global.showConfirmDialog === 'function') {
            confirmFn = global.showConfirmDialog;
        } else if (typeof window !== 'undefined' && typeof window.showConfirmDialog === 'function') {
            confirmFn = window.showConfirmDialog;
        } else if (typeof showConfirmDialog === 'function') {
            confirmFn = showConfirmDialog;
        }
        if (confirmFn) {
            try {
                confirmFn('解除情侣关系', msg, doBreakCoupleRelation, { variant: 'danger' });
            } catch (err) {
                if (typeof console !== 'undefined' && console.error) {
                    console.error('[情侣空间] 确认框无法展示', err);
                }
                if (typeof showNotification === 'function') {
                    showNotification('确认框无法展示：' + (err && err.message ? String(err.message) : '请换系统浏览器重试'));
                }
            }
            return;
        }
        var ok = false;
        try {
            ok = window.confirm(msg);
        } catch (e) {
            if (typeof showNotification === 'function') {
                showNotification('无法弹出确认，请重试或更换环境');
            }
            return;
        }
        if (ok) {
            doBreakCoupleRelation();
        }
    }

    /** 点击目标可能是 #text 文本节点，无 .closest；Cursor 内置浏览器等下会导致委托静默无效 */
    function eventPathIncludesBreakButton(e) {
        if (!e) return null;
        if (typeof e.composedPath === 'function') {
            var path = e.composedPath();
            for (var i = 0; i < path.length; i++) {
                var n = path[i];
                if (n && n.nodeType === 1 && n.id === 'couple-private-break-btn') {
                    return n;
                }
            }
        }
        var t = e.target;
        if (t && t.nodeType === 3 && t.parentElement) t = t.parentElement;
        if (t && t.nodeType === 1 && t.closest) {
            return t.closest('#couple-private-break-btn');
        }
        return null;
    }

    /**
     * 在 #couple-space-page 上委托捕获阶段点击。避免仅绑定子按钮时：首次绑定时机早于 DOM/或 getElementById 失败
     * 已误设 __couplePrivateBreakBound 导致永久无监听（内置浏览器/刷新后易发）。
     */
    function ensureCoupleSpaceBreakClickDelegate() {
        if (global.__coupleSpaceBreakDelegateBound) return;
        var host = document.getElementById('couple-space-page');
        if (!host) return;
        global.__coupleSpaceBreakDelegateBound = true;
        function onBreakHostPointerEvent(e) {
            var el = eventPathIncludesBreakButton(e);
            if (!el) return;
            e.preventDefault();
            e.stopPropagation();
            confirmBreakCoupleRelation(e);
        }
        host.addEventListener('click', onBreakHostPointerEvent, true);
        host.addEventListener('pointerup', onBreakHostPointerEvent, true);
    }

    function bindCouplePrivateTitleEditOnce() {
        if (global.__couplePrivateTitleBound) return;
        global.__couplePrivateTitleBound = true;
        var titleNode = document.getElementById('couple-private-editable-title');
        if (!titleNode) return;
        titleNode.addEventListener('blur', function () {
            var fid = String(titleNode.getAttribute('data-friend-id') || '');
            if (!fid) return;
            var st = store();
            if (!st || typeof st.upsertPair !== 'function') return;
            var v = String(titleNode.textContent || '').replace(/\s+/g, ' ').trim();
            if (!v) {
                var f = getFriendById(fid);
                v = getDefaultPrivateTitle(getUserDisplayName(), (f && (f.remark || f.nickname)) || 'TA');
                titleNode.textContent = v;
            }
            if (v.length > 36) {
                v = v.slice(0, 36);
                titleNode.textContent = v;
            }
            try {
                st.upsertPair(fid, { privateTitle: v });
            } catch (e) {}
        });
    }

    function openCoupleSpacePage() {
        bindCoupleSpaceMenuOutsideCloseOnce();
        bindCoupleEntryOpenOnce();
        ensureCoupleSpaceBreakClickDelegate();
        bindCouplePrivateTitleEditOnce();
        var dp = document.getElementById('wechat-discover-page');
        if (dp) dp.classList.add('wechat-discover-couple-open');
        var page = document.getElementById('couple-space-page');
        if (page) {
            page.classList.add('show');
            page.setAttribute('aria-hidden', 'false');
        }
        closeCouplePrivateSpace();
        if (typeof global.closeCoupleDiaryPage === 'function') global.closeCoupleDiaryPage();
        renderCoupleSpaceMainCard();
    }

    function closeCoupleSpacePage() {
        closeCoupleSpaceAddMenu();
        if (typeof global.closeCoupleDiaryPage === 'function') global.closeCoupleDiaryPage();
        closeCouplePrivateSpace();
        var dp = document.getElementById('wechat-discover-page');
        if (dp) dp.classList.remove('wechat-discover-couple-open');
        var page = document.getElementById('couple-space-page');
        if (page) {
            page.classList.remove('show');
            page.setAttribute('aria-hidden', 'true');
        }
    }

    // 暴露给 index.html onclick / 其它模块
    global.openCoupleSpacePage = openCoupleSpacePage;
    global.closeCoupleSpacePage = closeCoupleSpacePage;
    global.toggleCoupleSpaceAddMenu = toggleCoupleSpaceAddMenu;
    global.openCouplePrivateSpace = openCouplePrivateSpace;
    global.closeCouplePrivateSpace = closeCouplePrivateSpace;
    global.getLoveTakeoutOrderForChat = getLoveTakeoutOrder;
    global.openCoupleBillPage = openCoupleBillPage;
    global.closeCoupleBillPage = closeCoupleBillPage;
    global.openLoveTakeoutDetailPage = openLoveTakeoutDetailPage;
    global.closeLoveTakeoutDetailPage = closeLoveTakeoutDetailPage;
    global.confirmLoveTakeoutReceived = confirmLoveTakeoutReceived;
    global.switchCoupleBillTab = switchCoupleBillTab;
    global.refreshLoveTakeoutMenu = refreshLoveTakeoutMenu;
    global.toggleCoupleBillTakeoutDetails = toggleCoupleBillTakeoutDetails;
    global.submitUserLoveTakeoutOrder = submitUserLoveTakeoutOrder;
    global.requestCharLoveTakeoutOrder = requestCharLoveTakeoutOrder;
    global.requestCharLoveTakeoutOrderFromChat = requestCharLoveTakeoutOrderFromChat;
    global.triggerCouplePrivateBgUpload = triggerCouplePrivateBgUpload;
    global.handleCouplePrivateBgSelect = handleCouplePrivateBgSelect;
    global.confirmBreakCoupleRelation = confirmBreakCoupleRelation;
    global.ensureCoupleSpaceBreakClickDelegate = ensureCoupleSpaceBreakClickDelegate;
    /** 导入备份等场景下刷新发现页「情侣空间」入口卡片（不写 localStorage） */
    global.refreshCoupleSpaceDiscoverCard = renderCoupleSpaceMainCard;

    function scheduleCoupleSpaceBreakDelegateInit() {
        ensureCoupleSpaceBreakClickDelegate();
        if (global.__coupleSpaceBreakDelegateBound) return;
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', ensureCoupleSpaceBreakClickDelegate);
        }
        setTimeout(ensureCoupleSpaceBreakClickDelegate, 0);
    }
    scheduleCoupleSpaceBreakDelegateInit();
})(typeof window !== 'undefined' ? window : globalThis);
