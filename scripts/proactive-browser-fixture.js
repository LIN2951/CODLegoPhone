// Only injected by proactive-browser-smoke-server.js on its separate, random origin.
(function () {
    'use strict';
    const NativeDate = Date;
    let fixtureTime = NativeDate.now(), count = 0;
    window.Date = class extends NativeDate {
        constructor(...args) { super(...(args.length ? args : [fixtureTime])); }
        static now() { return fixtureTime; }
    };
    const data = Object.create(null);
    const store = {
        getItem(key) { return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null; },
        setItem(key, value) { data[key] = String(value); }, removeItem(key) { delete data[key]; },
        clear() { Object.keys(data).forEach(key => delete data[key]); },
        key(index) { return Object.keys(data)[index] || null; }, get length() { return Object.keys(data).length; }
    };
    Object.defineProperty(window, 'localStorage', { value: new Proxy(store, {
        ownKeys: () => Object.keys(data), getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true })
    }) });
    localStorage.setItem('apiSettings', JSON.stringify({ apiUrl: 'https://example.invalid', apiKey: 'fixture-only', model: 'fixture', memoryCount: 2 }));
    localStorage.setItem('myProfile', JSON.stringify({ nickname: '小夏', identity: '设计师' }));
    const friends = ['a', 'b'].map((id, i) => ({ id: 'proactive-smoke-' + id, nickname: i ? '陈默' : '林舟',
        roleSetting: '安静独立，喜欢做饭和散步。', persona: { nickname: '小夏', identity: '设计师' }, unreadCount: 0 }));
    localStorage.setItem('friends', JSON.stringify(friends));
    window.addEventListener('load', function () {
        FeatureCommandMapper.callApiModel = async function (prompt) {
            count++;
            if (!prompt.includes('【微信聊天规范 · 主动发消息】')) return '在看书，刚翻到挺有意思的一段。';
            return JSON.stringify({ messages: [count === 1 ? '我在看书。' : '刚读到一处有趣的想法，想和你聊聊。' + count],
                emotion: prompt.includes('requireEmotion=true') ? '消息发出去，过了一会儿还是没动静。我把锅洗了，切好明早要用的菜，那点想找人聊聊的兴头也慢慢落下来。她可能在忙，先把自己的事做完。' : '' });
        };
        const bar = document.createElement('div');
        bar.id = 'proactive-smoke-toolbar';
        bar.style.cssText = 'position:fixed;z-index:999999;top:0;left:0;right:0;padding:5px;background:#fff;border-bottom:1px solid #ccc;display:flex;gap:5px;flex-wrap:wrap;font:12px sans-serif';
        const status = document.createElement('output'); status.id = 'proactive-smoke-status';
        function update() {
            const f = document.getElementById('chat-page').dataset.friendId || friends[0].id;
            const history = getChatHistoryArray(f);
            const friend = friends.find(item => item.id === f);
            const state = friend ? JSON.parse(localStorage.getItem('proactiveMessageRuntimeV2:' + encodeURIComponent(LegoProactiveCore.scope(friend, { nickname: '小夏', identity: '设计师' }))) || '{}') : {};
            status.textContent = '请求 ' + count + '；消息 ' + history.length + '；心绪 ' + history.filter(m => m.proactiveEmotion).length +
                '；线路 ' + (state.mode || '未开启') + '；间隔 ' + (state.nextAt ? Math.max(0, Math.ceil((state.nextAt - Date.now()) / 1000)) : '停止') +
                '；回复 ' + (state.replyAt ? Math.max(0, Math.ceil((state.replyAt - Date.now()) / 1000)) : '停止');
        }
        function button(label, action) {
            const b = document.createElement('button'); b.textContent = label;
            b.onclick = async () => { try { await action(); update(); } catch (e) { status.textContent = 'ERROR: ' + e.message; } };
            bar.appendChild(b);
        }
        button('准备测试对话', async () => {
            await saveFriendsToStorageAsync(friends);
            saveChatMessage(friends[0].id, 'user', '你现在在干什么？', null, Date.now());
            localStorage.setItem('proactiveMessageSettingsV1', JSON.stringify({ enabled: true, intervalMinutes: 10, timeStart: '00:00', timeEnd: '00:00', candidateIds: [friends[0].id] }));
            await openChat('林舟', friends[0].id);
            Wechat.proactive.reschedule(); await Wechat.proactive.tick();
        });
        button('发送测试消息', () => {
            saveChatMessage(friends[0].id, 'user', '这本书好看吗？', null, Date.now());
            loadChatHistory(friends[0].id, { scrollToBottom: true });
        });
        for (const seconds of [1, 34, 60, 565, 600]) button('推进' + seconds + '秒', async () => {
            fixtureTime += seconds * 1000; await Wechat.proactive.tick();
        });
        button('手动接收测试', async () => { await performWechatReceiveForFriendId(friends[0].id, {}); Wechat.proactive.syncUI(); });
        button('准备长记录', async () => {
            await saveFriendsToStorageAsync(friends);
            const history = getChatHistoryArray(friends[0].id); history.length = 0;
            let ts = Date.now() - 3600000;
            for (let round = 0; round < 6; round++) {
                history.push({ type: 'user', content: '聊聊今天读的书 ' + round, timestamp: ts++ });
                for (let i = 0; i < 40; i++) history.push({ type: 'friend', content: 'A thought about the book ' + round + '-' + i + '.（关于这本书的一点想法。）', timestamp: ts++ });
            }
            localStorage.setItem('chatHistory_' + friends[0].id, JSON.stringify(history));
            Wechat.proactive.historyReplaced(friends[0].id);
            localStorage.setItem('proactiveMessageSettingsV1', JSON.stringify({ enabled: true, intervalMinutes: 10, timeStart: '00:00', timeEnd: '00:00', candidateIds: [friends[0].id] }));
            await openChat('林舟', friends[0].id); loadChatHistory(friends[0].id);
            Wechat.proactive.reschedule(); await Wechat.proactive.tick();
        });
        async function simulateRemoteReply(storageMode = 'plain', notify = true) {
            const fid = friends[0].id, old = getChatHistoryArray(fid);
            const scope = LegoProactiveCore.scope(friends[0], {}), batch = 'remote-fixture-' + (++count);
            const firstTs = Math.max(Date.now(), ...old.map(m => (Number(m.timestamp) || 0) + 1));
            const items = [1, 2, 3].map(i => ({ type: 'friend', content: '跨页新回复 ' + count + '-' + i + '（无需刷新应可见）',
                timestamp: firstTs + i, proactiveBatchId: batch, proactiveScope: scope, proactiveKind: 'reply', proactiveRound: 0 }));
            const next = old.concat(items), key = 'proactiveMessageRuntimeV2:' + encodeURIComponent(scope);
            const state = JSON.parse(localStorage.getItem(key) || '{}');
            Object.assign(state, { mode: 'interval', replyAt: 0, nextAt: Date.now() + 600000, userSig: '', lastSentAt: items[2].timestamp,
                revision: (state.revision || 0) + 1, changedBy: 'fixture-other-page', historySig: LegoProactiveCore.signature([next.length, items[2]]) });
            if (storageMode === 'idb') {
                await wechatKvSet('chatHistory_' + fid, JSON.stringify(next));
                localStorage.setItem('chatHistory_' + fid, 'IDB:1');
            } else localStorage.setItem('chatHistory_' + fid, JSON.stringify(next));
            localStorage.setItem(key, JSON.stringify(state));
            const change = JSON.stringify({ fid, token: batch }); localStorage.setItem('proactiveMessageChangeV2', change);
            if (notify) window.dispatchEvent(new StorageEvent('storage', { key: 'proactiveMessageChangeV2', newValue: change }));
        }
        button('模拟其他页面回复', () => simulateRemoteReply());
        button('模拟IDB跨页回复', () => simulateRemoteReply('idb'));
        button('模拟遗漏通知', () => simulateRemoteReply('plain', false));
        button('离开聊天', () => navigateTo('home'));
        button('回到林舟', async () => { await openChat('林舟', friends[0].id); });
        button('切换好友', async () => {
            const fid = document.getElementById('chat-page').dataset.friendId;
            const f = fid === friends[0].id ? friends[1] : friends[0];
            await openChat(f.nickname, f.id); Wechat.proactive.syncUI();
        });
        button('关闭主动消息', () => {
            const settings = Wechat.proactive.settings(); settings.enabled = false;
            localStorage.setItem('proactiveMessageSettingsV1', JSON.stringify(settings)); Wechat.proactive.reschedule();
        });
        bar.appendChild(status); document.body.appendChild(bar);
        const app = document.getElementById('app');
        app.style.marginTop = '100px'; app.style.height = 'calc(var(--lego-vv-h) - 120px)';
        app.style.minHeight = '0'; update();
    });
})();
