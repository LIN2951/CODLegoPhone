'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../wechat-proactive-core.js');
const source = file => fs.readFileSync(path.join(__dirname, '..', file), 'utf8');
const settle = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };

function harness(options = {}) {
    let now = options.now || new Date(2026, 8, 8, 10, 0).getTime(), timerId = 0;
    const values = options.values || new Map(), timers = new Map(), events = {};
    const friends = options.friends || [{ id: 'a', nickname: '林舟', roleSetting: '安静，喜欢做饭。', persona: { nickname: '小夏', identity: '设计师' } }];
    const histories = options.histories || { a: [] };
    const calls = [], previews = [];
    const localStorage = new Proxy({ getItem: k => values.get(k) || null, setItem: (k, v) => values.set(k, String(v)), removeItem: k => values.delete(k) }, {
        ownKeys: () => Array.from(values.keys()),
        getOwnPropertyDescriptor: (target, key) => Object.getOwnPropertyDescriptor(target, key) ||
            (values.has(key) ? { enumerable: true, configurable: true, writable: true, value: values.get(key) } : undefined)
    });
    class Clock extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
    const settings = { enabled: true, intervalMinutes: 1, timeStart: '00:00', timeEnd: '00:00', candidateIds: friends.map(f => f.id) };
    if (!values.has('proactiveMessageSettingsV1')) localStorage.setItem('proactiveMessageSettingsV1', JSON.stringify(settings));
    if (!values.has('apiSettings')) localStorage.setItem('apiSettings', JSON.stringify({ apiUrl: 'https://example.invalid', apiKey: 'fixture', model: 'fixture', memoryCount: 2 }));
    const commands = [
        { name: '核心指令①', content: 'CORE_ONE Char 与 User', active: true },
        { name: '核心指令②禁八股', content: 'CORE_TWO', active: true },
        { name: '微信聊天规范①', content: 'WECHAT_TEXT', active: true },
        { name: '微信聊天规范⑤线下模式', content: 'OFFLINE_ONLY', active: true },
        { name: '入侵好友手机', content: 'PHONE_ONLY', active: true }
    ];
    const sandbox = { console: { warn() {}, log() {} }, Date: Clock, Math, AbortController, Promise,
        document: { getElementById: () => null, addEventListener: () => {}, hidden: false },
        localStorage, Wechat: {}, LegoProactiveCore: core, isReceiving: false, receiveController: null,
        navigator: { locks: { request: async (_n, _o, fn) => fn({}) } },
        setTimeout: (fn, ms) => { timers.set(++timerId, { fn, at: now + ms }); return timerId; },
        clearTimeout: id => timers.delete(id), setInterval: () => ++timerId, clearInterval: () => {},
        addEventListener: (name, fn) => { (events[name] ||= []).push(fn); },
        loadFriendsFromStorage: () => friends, ensureFriendsCacheHydrated: async () => {},
        getChatHistoryArray: id => histories[id] ||= [], ensureChatHistoryReady: async id => histories[id] ||= [],
        invalidateChatHistoryMem: () => {},
        safeReadJsonFromStorage: (key, fallback) => JSON.parse(localStorage.getItem(key) || 'null') || fallback,
        parseJsonFromPossiblyEncodedStorage: (key, fallback) => key.startsWith('chatHistory_') ? histories[key.slice(12)] || [] : JSON.parse(localStorage.getItem(key) || 'null') || fallback,
        compactChatMessageContentForApi: m => String(m.content || ''), formatMessageForApi: text => text,
        getWorldBookData: () => ({ entries: options.books || [] }),
        CommandManager: { getActiveCommands: () => commands }, _loadChatLongMemories: () => [],
        _getOfflineSettingsForFriend: () => ({ enabled: false }),
        queueWechatMessagePreview: (fid, item) => previews.push({ fid, item }), loadChatHistory: () => {},
        loadProactiveAutoApiConnection: () => options.specific || null,
        commitProactiveChatBatch: async (fid, items, valid) => { if (options.failStorage) throw Error('storage full'); if (!valid()) return false; histories[fid].push(...items); return true; }
    };
    sandbox.FeatureCommandMapper = { callApiModel: async (prompt, controller, opts) => {
        calls.push({ prompt, controller, opts });
        if (options.model) return options.model(prompt, controller, opts, calls.length);
        return JSON.stringify({ messages: ['生活分享' + calls.length], emotion: prompt.includes('requireEmotion=true') ? '收好杯子过了片刻，我去准备晚饭，心情轻松了些。' : '' });
    } };
    sandbox.window = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(source('wechat-prompts.js'), sandbox);
    vm.runInContext(source('wechat-proactive-runtime.js'), sandbox);
    const api = sandbox.Wechat.proactive;
    const stateKey = fid => 'proactiveMessageRuntimeV2:' + encodeURIComponent(core.scope(friends.find(f => f.id === fid), {}));
    return { sandbox, api, calls, values, friends, histories, previews, timers,
        state: (fid = 'a') => JSON.parse(localStorage.getItem(stateKey(fid)) || '{}'),
        setState: (patch, fid = 'a') => localStorage.setItem(stateKey(fid), JSON.stringify({ ...JSON.parse(localStorage.getItem(stateKey(fid)) || '{}'), ...patch })),
        setSettings: patch => localStorage.setItem('proactiveMessageSettingsV1', JSON.stringify({ ...JSON.parse(localStorage.getItem('proactiveMessageSettingsV1')), ...patch })),
        advance: ms => { now += ms; for (const [id, t] of timers) if (t.at <= now) { timers.delete(id); t.fn(); } },
        user: (body, fid = 'a') => { const item = { type: 'user', content: body, timestamp: now }; histories[fid].push(item); api.onMessage(fid, item); },
        friend: (body, fid = 'a') => { const item = { type: 'friend', content: body, timestamp: now }; histories[fid].push(item); api.onMessage(fid, item); },
        emit: (name, event) => (events[name] || []).forEach(fn => fn(event)), now: () => now };
}

test('settings retain zero, validate time, and bound random intervals', () => {
    const s = core.settings({ intervalMinutes: 0, timeStart: '25:90', timeEnd: '9:00', candidateIds: [1, '1', null, {}] });
    assert.equal(s.intervalMinutes, 0); assert.equal(s.timeStart, '09:00'); assert.equal(s.timeEnd, '09:00');
    assert.deepEqual(s.candidateIds, ['1']);
    assert.equal(core.delay(s, () => 0), 600000); assert.equal(core.delay(s, () => .9999), 3600000);
});
test('allowed windows include start, exclude end, and work across midnight', () => {
    const s = core.settings({ timeStart: '22:00', timeEnd: '08:00' });
    const date = (h, m = 0) => new Date(2026, 8, 8, h, m);
    assert.equal(core.within(s, date(22)), true); assert.equal(core.within(s, date(7, 59)), true);
    assert.equal(core.within(s, date(8)), false); assert.equal(core.within(s, date(12)), false);
    assert.equal(core.nextAllowed(s, +date(12)), +date(22));
});
test('output validation isolates emotion and rejects invalid dialogue', () => {
    const parse = (messages, emotion, context = {}) => core.parseOutput(JSON.stringify({ messages, emotion }), context);
    assert.equal(parse(['hi'], 'private').emotion, '');
    assert.equal(parse(['hi'], '', { requireEmotion: true }), null);
    assert.equal(parse(['hi'], '心'.repeat(501), { requireEmotion: true }), null);
    for (const body of ['*hi*', '<img src=x>', 'Char hi', '我是AI', '字'.repeat(221)]) assert.equal(parse([body], ''), null);
    assert.equal(parse(['same', 'same'], ''), null);
    assert.equal(parse(['a', 'b', 'c', 'd'], ''), null);
    assert.equal(parse(['a', 'b', 'c', 'd', 'e', 'f'], '', { talkative: true }).messages.length, 6);
    assert.equal(core.talkative({ role: '不是话唠' }), false);
});
test('recent history retains proactive batches and pending user messages without duplication', () => {
    const h = [{ type: 'user', content: 'old' }, { type: 'friend', content: 'old reply' },
        { type: 'friend', content: 'share1', proactiveBatchId: '1', proactiveKind: 'share' },
        { type: 'friend', content: 'share2', proactiveBatchId: '2', proactiveKind: 'share' },
        { type: 'user', content: 'latest' }, { type: 'system', content: 'hidden' }];
    assert.deepEqual(core.recentHistory(h, 2).map(m => m.content), ['share2', 'latest']);
    assert.deepEqual(core.recentHistory(h, 0), []);
});
test('prompt follows five sections, actual names, scoped books, and current persona', () => {
    const h = harness({ books: [{ id: 1, name: '世界甲', content: 'BOOK_ONE' }, { id: 2, content: 'UNBOUND' }, { id: 3, name: '未提及', activationMode: 'keyword', content: 'INACTIVE_KEYWORD' }] });
    h.friends[0].worldBookIds = ['1', 3];
    h.user('LATEST_SINGLE');
    const prompt = h.sandbox.Wechat.prompts.buildProactiveMessageContent('a', { round: 2, requireEmotion: true, allowedNow: true });
    const offsets = ['【核心指令】', '【已挂载世界书】', '【林舟的角色卡】', '【最新聊天记录】', '【微信聊天规范】'].map(s => prompt.indexOf(s));
    assert.ok(offsets.every((n, i) => n >= 0 && (i === 0 || n > offsets[i - 1])));
    for (const s of ['CORE_ONE 林舟 与 小夏', 'CORE_TWO', 'BOOK_ONE', '设计师', 'requireEmotion=true']) assert.ok(prompt.includes(s), s);
    for (const s of ['UNBOUND', 'INACTIVE_KEYWORD', 'OFFLINE_ONLY', 'PHONE_ONLY']) assert.ok(!prompt.includes(s), s);
    assert.equal(prompt.split('LATEST_SINGLE').length - 1, 1);
});
test('no-user conversation initiates sharing and continues without reply; emotion alternates', async () => {
    const h = harness(); await h.api.tick(); assert.equal(h.calls.length, 0);
    for (let round = 1; round <= 4; round++) {
        h.advance(60000); await h.api.tick();
        assert.equal(h.state().round, round);
        assert.equal(!!h.histories.a.at(-1).proactiveEmotion, round % 2 === 0);
    }
    assert.equal(h.previews.length, 4);
});
test('35 seconds follow the latest user message and auto reply does not increment share rounds', async () => {
    const h = harness(); await h.api.tick(); h.user('one');
    h.advance(20000); h.user('two'); h.advance(34999); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.advance(1); await h.api.tick(); assert.equal(h.calls.length, 1);
    assert.equal(h.state().round, 0); assert.equal(h.histories.a.at(-1).proactiveKind, 'reply');
    assert.ok(h.calls[0].prompt.includes('one')); assert.ok(h.calls[0].prompt.includes('two'));
    h.advance(60000); await h.api.tick(); assert.equal(h.state().round, 1);
});
test('refresh keeps deadlines and round count, while persona scopes are independent', async () => {
    const h = harness(); await h.api.tick(); h.advance(60000); await h.api.tick();
    const next = h.state().nextAt;
    const fresh = harness({ values: h.values, histories: h.histories, friends: h.friends });
    await fresh.api.tick(); assert.equal(fresh.state().nextAt, next); assert.equal(fresh.state().round, 1);
    fresh.friends[0].persona = { nickname: '新身份', identity: '另一人设' };
    await fresh.api.tick(); assert.equal(fresh.state().round, 0);
});
test('out-of-window ticks make zero calls and do not catch up a burst', async () => {
    const h = harness(); h.setSettings({ timeStart: '11:00', timeEnd: '12:00' });
    await h.api.tick(); h.setState({ nextAt: h.now() - 100000 }); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.advance(3600000); await h.api.tick(); await h.api.tick(); assert.equal(h.calls.length, 1);
});
test('manual receive suspends both clocks until the complete reply is sent', async () => {
    const h = harness(); h.user('reply'); assert.ok(h.state().replyAt);
    assert.equal(h.api.handleReceiveClick('a'), false);
    const job = h.api.manualStarted('a'); assert.equal(h.state().replyAt, 0); assert.equal(h.state().nextAt, 0);
    h.advance(35000); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.friend('first bubble'); h.advance(10000); h.friend('second bubble');
    assert.equal(h.state().nextAt, 0); h.api.manualFinished(job);
    assert.equal(h.state().nextAt, h.now() + 60000); assert.equal(h.state().replyAt, 0);
    h.advance(59999); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.advance(1); await h.api.tick(); assert.equal(h.calls.length, 1);
});

test('enabling starts a full interval for empty, user-last, and friend-last histories', async () => {
    for (const type of [null, 'user', 'friend']) {
        const h = harness({ histories: { a: type ? [{ type, content: 'existing conversation', timestamp: 1 }] : [] } });
        h.setSettings({ intervalMinutes: 10 }); await h.api.tick();
        assert.equal(h.state().mode, 'interval'); assert.equal(h.state().replyAt, 0);
        assert.equal(h.state().nextAt, h.now() + 600000);
        h.advance(35000); await h.api.tick(); assert.equal(h.calls.length, 0, String(type));
        h.advance(565000); await h.api.tick(); assert.equal(h.calls.length, 1, String(type));
        assert.equal(h.histories.a.at(-1).proactiveKind, 'share');
        assert.ok(h.calls[0].prompt.includes('如果最新一组对方消息尚未得到回应'));
        assert.ok(h.calls[0].prompt.includes('优先延续最新对话'));
    }
});

test('ten-minute interval stops on user input and restarts only after successful generation', async () => {
    let resolve;
    const h = harness({ model: (prompt, _ctrl, _opts, n) => n === 1 ? new Promise(r => { resolve = r; }) :
        JSON.stringify({ messages: ['接着聊书里的想法' + n], emotion: prompt.includes('requireEmotion=true') ? '翻了几页后放松下来，起身倒杯水。' : '' }) });
    h.setSettings({ intervalMinutes: 10 }); await h.api.tick(); h.advance(590000);
    h.user('你现在在干什么？'); assert.equal(h.state().nextAt, 0);
    h.advance(10000); await h.api.tick(); assert.equal(h.calls.length, 0, 'old interval must not fire');
    h.advance(24999); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.advance(1); const pending = h.api.tick(); await settle();
    assert.equal(h.calls.length, 1); assert.equal(h.state().nextAt, 0);
    h.advance(20000); resolve('{"messages":["我在看书。"],"emotion":""}'); await pending;
    assert.equal(h.state().nextAt, h.now() + 600000); assert.equal(h.state().replyAt, 0);
    h.advance(599999); await h.api.tick(); assert.equal(h.calls.length, 1);
    h.advance(1); await h.api.tick(); assert.equal(h.calls.length, 2);
    assert.ok(h.calls[1].prompt.includes('我在看书。')); assert.equal(h.state().round, 1);
    h.advance(600000); await h.api.tick(); assert.equal(h.calls.length, 3); assert.equal(h.state().round, 2);
    h.user('哪一本？'); h.advance(20000); h.user('有趣吗？'); assert.equal(h.state().nextAt, 0);
    h.advance(34999); await h.api.tick(); assert.equal(h.calls.length, 3);
    h.advance(1); await h.api.tick(); assert.equal(h.calls.length, 4); assert.equal(h.state().round, 2);
    assert.equal(h.state().nextAt, h.now() + 600000);
});

test('pending reply survives refresh, interval edits, and candidate changes with its original deadline', async () => {
    const h = harness({ friends: [{ id: 'a' }, { id: 'b' }], histories: { a: [], b: [] } });
    h.api.reschedule(); await settle(); h.user('pending'); h.advance(20000);
    const deadline = h.state().replyAt;
    h.setSettings({ intervalMinutes: 10, timeEnd: '23:59', candidateIds: ['a'] }); h.api.reschedule(); await settle();
    assert.equal(h.state().replyAt, deadline); assert.equal(h.state().nextAt, 0);
    const fresh = harness({ now: h.now(), values: h.values, histories: h.histories, friends: h.friends });
    fresh.api.reschedule(); await settle(); assert.equal(fresh.state().replyAt, deadline);
    fresh.advance(14999); await fresh.api.tick(); assert.equal(fresh.calls.length, 0);
    fresh.advance(1); await fresh.api.tick(); assert.equal(fresh.calls.length, 1);
    assert.equal(fresh.state().nextAt, fresh.now() + 600000);
});

test('disable and re-enable resets the interval without treating old user messages as new', async () => {
    const h = harness(); h.api.reschedule(); await settle(); h.user('old pending reply');
    h.setSettings({ enabled: false }); h.api.reschedule(); h.advance(600000);
    h.setSettings({ enabled: true, intervalMinutes: 10 }); h.api.reschedule(); await settle();
    assert.equal(h.state().replyAt, 0); assert.equal(h.state().nextAt, h.now() + 600000);
    h.advance(35000); await h.api.tick(); assert.equal(h.calls.length, 0);
    h.advance(565000); await h.api.tick(); assert.equal(h.calls.length, 1);
});

test('legacy parallel deadlines migrate to one reply route without restarting it', async () => {
    const h = harness(); h.user('pending'); const deadline = h.state().replyAt;
    h.setState({ version: 2, mode: undefined, nextAt: h.now() + 60000 }); h.advance(20000);
    await h.api.tick(); assert.equal(h.state().nextAt, 0); assert.equal(h.state().replyAt, deadline);
    h.advance(15000); await h.api.tick(); assert.equal(h.calls.length, 1);
});

test('failed auto reply keeps the reply route and new user input resets its retry delay', async () => {
    const h = harness({ model: () => null }); await h.api.tick(); h.user('pending');
    h.advance(35000); await h.api.tick(); assert.equal(h.state().mode, 'reply'); assert.equal(h.state().nextAt, 0);
    assert.ok(h.state().retryAt > h.now()); h.advance(10000); h.user('more detail');
    assert.equal(h.state().retryAt, 0); assert.equal(h.state().replyAt, h.now() + 35000);
    h.advance(34999); await h.api.tick(); assert.equal(h.calls.length, 1);
    h.advance(1); await h.api.tick(); assert.equal(h.calls.length, 2); assert.equal(h.state().round, 0);
});

test('manual failure, new user input, and abandoned-tab recovery cannot turn pending replies into idle sharing', async () => {
    const h = harness(); h.user('pending'); const failed = h.api.manualStarted('a'); h.advance(5000);
    h.api.manualFinished(failed); assert.equal(h.state().nextAt, 0); assert.equal(h.state().replyAt, h.now() + 35000);
    const superseded = h.api.manualStarted('a'); superseded.controller = new AbortController(); h.advance(5000); h.user('new');
    const deadline = h.state().replyAt; assert.equal(superseded.controller.signal.aborted, true);
    assert.equal(h.api.manualValid(superseded), false); h.api.manualFinished(superseded);
    assert.equal(h.state().replyAt, deadline); assert.equal(h.state().nextAt, 0);
    h.api.manualStarted('a'); const other = harness({ now: h.now(), values: h.values, histories: h.histories });
    other.advance(60000); await other.api.tick(); assert.equal(other.calls.length, 0);
    other.advance(60000); await other.api.tick(); assert.equal(other.calls.length, 0);
    assert.equal(other.state().nextAt, 0); assert.equal(other.state().replyAt, other.now() + 35000);
    other.advance(35000); await other.api.tick(); assert.equal(other.calls.length, 1);
});

test('manual preparation rejects another tab without losing the pending reply route', async () => {
    const h = harness(); h.user('pending'); const job = h.api.manualStarted('a');
    const other = harness({ values: h.values, histories: h.histories });
    assert.equal(other.api.manualStarted('a').busy, true); assert.equal(h.state().manualId, job.id);
    assert.equal(h.api.manualValid(job), true);
    h.api.manualFinished(job); assert.equal(h.state().nextAt, 0); assert.equal(h.state().mode, 'reply');
});

test('manual prompt preparation prevents another friend from starting a competing request', async () => {
    const h = harness({ friends: [{ id: 'a' }, { id: 'b' }], histories: { a: [], b: [] } });
    await h.api.tick(); h.user('pending A'); const job = h.api.manualStarted('a');
    h.advance(60000); await h.api.tick(); assert.equal(h.calls.length, 0);
    assert.equal(h.api.manualStarted('b').busy, true);
    h.api.manualFinished(job); await h.api.tick(); assert.equal(h.calls.length, 1);
    assert.equal(h.histories.b.length, 1); assert.equal(h.state().nextAt, 0);
});

test('disabling and clearing also reset inactive persona clocks', async () => {
    const h = harness(); h.api.reschedule(); await settle(); h.user('old persona pending');
    const persona = h.friends[0].persona;
    h.friends[0].persona = { nickname: '另一个人设' }; await h.api.tick();
    h.setSettings({ enabled: false }); h.api.reschedule(); h.advance(600000);
    h.friends[0].persona = persona; h.setSettings({ enabled: true }); h.api.reschedule(); await settle();
    assert.equal(h.state().replyAt, 0); assert.equal(h.state().nextAt, h.now() + 60000);
    h.api.historyReplaced('a');
    assert.equal([...h.values.keys()].filter(key => key.startsWith('proactiveMessageRuntimeV2:')).length, 0);
});

test('real manual receive releases timers on empty output and discards late replies after new input', async () => {
    for (const late of [false, true]) {
        let resolve;
        const h = harness({ model: () => late ? new Promise(r => { resolve = r; }) : null }), s = h.sandbox;
        h.user('pending'); s.listenTogetherActive = false;
        s.findMentionedBooksFromMessages = () => []; s.maybeTriggerCharLoveTakeoutFromChat = async () => false;
        s.CommandManager.buildWechatSendContent = () => 'manual prompt'; s.buildChatQuoteSnapshot = () => null;
        s.showNotification = () => {}; s.console.error = () => {};
        const pipeline = source('wechat-chat-pipeline.js');
        vm.runInContext(pipeline.slice(pipeline.indexOf('async function performWechatReceiveForFriendId'), pipeline.indexOf('/** 更多 / 表情面板')), s);
        const pending = s.performWechatReceiveForFriendId('a', {}); await settle();
        if (late) { h.advance(5000); h.user('latest detail'); resolve('must not be saved'); }
        const result = await pending;
        assert.equal(result.ok, false); assert.equal(h.state().nextAt, 0);
        assert.equal(h.state().replyAt, h.now() + 35000); assert.equal(s.isReceiving, false);
        assert.ok(h.histories.a.every(m => m.type === 'user'));
    }
});
test('late responses after new user input, disable, blacklist, persona edits, or deadline are discarded', async t => {
    for (const change of ['user', 'disable', 'blacklist', 'persona', 'window']) {
        await t.test(change, async () => {
            let resolve; const h = harness({ model: () => new Promise(r => { resolve = r; }) });
            if (change === 'window') h.setSettings({ timeStart: '09:00', timeEnd: '10:02' });
            await h.api.tick(); h.advance(60000); const pending = h.api.tick(); await settle(); assert.equal(typeof resolve, 'function');
            if (change === 'user') h.user('changed');
            if (change === 'disable') h.setSettings({ enabled: false });
            if (change === 'blacklist') h.friends[0].blacklisted = true;
            if (change === 'persona') h.friends[0].persona.nickname = 'Changed';
            if (change === 'window') h.advance(60000);
            resolve('{"messages":["stale"],"emotion":""}'); await pending;
            assert.equal(h.histories.a.filter(m => m.type === 'friend').length, 0);
        });
    }
});
test('specific API failure falls back once and cancellation never falls back', async () => {
    const specific = { apiUrl: 'https://specific.invalid', apiKey: 'fixture', model: 'other' };
    const h = harness({ specific, model: (_p, _c, _o, n) => n === 1 ? null : '{"messages":["fallback"],"emotion":""}' });
    await h.api.tick(); h.advance(60000); await h.api.tick(); assert.equal(h.calls.length, 2);
    assert.equal(h.calls[0].opts.overrideConnection.model, 'other'); assert.equal(h.calls[1].opts.overrideConnection.model, 'fixture');
    let resolve; const c = harness({ specific, model: () => new Promise(r => { resolve = r; }) });
    await c.api.tick(); c.advance(60000); const pending = c.api.tick(); await settle(); c.api.handleReceiveClick('a');
    resolve(null); await pending; assert.equal(c.calls.length, 1); assert.equal(c.histories.a.length, 0);
});
test('invalid output and failed storage back off without incrementing round', async () => {
    for (const opts of [{ model: () => 'not json' }, { failStorage: true }]) {
        const h = harness(opts); await h.api.tick(); h.advance(60000); await h.api.tick();
        assert.equal(h.state().round, 0); assert.equal(h.histories.a.length, 0);
        await h.api.tick(); assert.equal(h.calls.length, 1); assert.ok(h.state().retryAt > h.now());
    }
});
test('timeout releases receive state and backs off', async () => {
    const h = harness({ model: () => new Promise(() => {}) }); await h.api.tick(); h.advance(60000);
    const pending = h.api.tick(); await settle(); assert.equal(h.calls.length, 1);
    h.advance(90000); await pending; assert.equal(h.sandbox.isReceiving, false); assert.ok(h.state().retryAt > h.now());
});
test('multiple friends have independent clocks; busy, offline, blacklisted and groups do not trigger', async () => {
    const h = harness({ friends: [{ id: 'a', nickname: 'A' }, { id: 'b', nickname: 'B' }], histories: { a: [], b: [] } });
    await h.api.tick(); h.user('reply A'); h.advance(35000); await h.api.tick(); assert.equal(h.histories.a.length, 2); assert.equal(h.histories.b.length, 0);
    h.advance(25000); await h.api.tick(); assert.equal(h.histories.b.length, 1);
    for (const mode of ['busy', 'offline', 'blacklisted', 'group']) {
        const x = harness(); await x.api.tick(); x.advance(60000);
        if (mode === 'busy') x.sandbox.isReceiving = true;
        if (mode === 'offline') x.sandbox._getOfflineSettingsForFriend = () => ({ enabled: true });
        if (mode === 'blacklisted') x.friends[0].blacklisted = true;
        if (mode === 'group') x.friends[0].isGroup = true;
        await x.api.tick(); assert.equal(x.calls.length, 0, mode);
    }
});
test('two tabs use one navigator lock for the whole generation', async () => {
    let locked = false, resolve;
    const request = async (_n, _o, fn) => { if (locked) return fn(null); locked = true; try { return await fn({}); } finally { locked = false; } };
    const h = harness({ model: () => new Promise(r => { resolve = r; }) });
    const other = harness({ values: h.values, histories: h.histories });
    h.sandbox.navigator.locks.request = other.sandbox.navigator.locks.request = request;
    await h.api.tick(); h.advance(60000); other.advance(60000);
    const pending = h.api.tick(); await settle(); await other.api.tick(); assert.equal(other.calls.length, 0);
    resolve('{"messages":["one batch"],"emotion":""}'); await pending; await other.api.tick(); assert.equal(other.calls.length, 0);
});

function realStore(options = {}) {
    const h = harness(), s = h.sandbox, disk = new Map(), reads = [], compressed = new Map();
    let putHook = null;
    const queue = fn => queueMicrotask(fn);
    const db = { objectStoreNames: { contains: () => true }, transaction: () => {
        let aborted = false;
        const tx = { abort() { if (aborted) return; aborted = true; queue(() => tx.onabort && tx.onabort()); }, objectStore: () => ({
            get(key) {
                const req = {};
                const deliver = () => { req.result = disk.has(key) ? { value: disk.get(key) } : null; if (req.onsuccess) req.onsuccess(); };
                if (options.deferReads) reads.push(deliver); else queue(deliver);
                return req;
            },
            put(record) {
                const req = {};
                queue(() => {
                    if (aborted) return;
                    if (putHook) putHook();
                    if (options.failIdb) { tx.error = Error('idb failure'); tx.abort(); return; }
                    if (req.onsuccess) req.onsuccess();
                    queue(() => { if (!aborted) { disk.set(record.key, record.value); if (tx.oncomplete) tx.oncomplete(); } });
                });
                return req;
            },
            delete(key) { queue(() => { disk.delete(key); if (tx.oncomplete) tx.oncomplete(); }); }
        }) };
        return tx;
    } };
    s.indexedDB = { open: () => { const req = { result: db }; queue(() => req.onsuccess()); return req; } };
    s.isQuotaExceededError = err => err.name === 'QuotaExceededError';
    s.LZString = { compressToUTF16: text => { const key = 'compressed-' + compressed.size; compressed.set(key, text); return key; } };
    const set = s.localStorage.setItem;
    s.localStorage.setItem = (key, value) => {
        if (key.startsWith('chatHistory_') && !String(value).startsWith('IDB:') &&
            (options.quota === 'all' || (options.quota === 'plain' && !String(value).startsWith('LZUTF16:')))) {
            const error = Error('quota'); error.name = 'QuotaExceededError'; throw error;
        }
        set(key, value);
    };
    s.parseJsonFromPossiblyEncodedStorage = (key, fallback) => {
        const raw = s.localStorage.getItem(key);
        if (!raw || raw.startsWith('IDB:')) return fallback;
        return JSON.parse(raw.startsWith('LZUTF16:') ? compressed.get(raw.slice(8)) : raw);
    };
    vm.runInContext(source('wechat-store.js'), s);
    // Keep independent synthetic friends; use the real chat-store functions above.
    s.loadFriendsFromStorage = () => h.friends;
    s.ensureFriendsCacheHydrated = async () => {};
    return { ...h, disk, reads, seed: messages => {
        disk.set('chatHistory_a', JSON.stringify(messages));
        set('chatHistory_a', options.idb ? 'IDB:1' : JSON.stringify(messages));
    }, onPut: fn => { putHook = fn; } };
}

test('real store commits a whole batch before publishing, including compressed and IDB paths', async () => {
    for (const options of [{}, { quota: 'plain' }, { quota: 'all' }, { idb: true }]) {
        const h = realStore(options), old = [{ type: 'user', content: 'old', timestamp: 1 }]; h.seed(old);
        const history = await h.sandbox.ensureChatHistoryReady('a'); assert.equal(history.length, 1);
        const items = [{ type: 'friend', content: 'one', timestamp: 2 }, { type: 'friend', content: 'two', timestamp: 3 }];
        const ok = await h.sandbox.commitProactiveChatBatch('a', items, () => true, new AbortController().signal);
        assert.equal(ok, true); assert.equal(history.length, 3);
        if (options.idb || options.quota === 'all') assert.equal(JSON.parse(h.disk.get('chatHistory_a')).length, 3);
        else assert.equal(h.sandbox.parseJsonFromPossiblyEncodedStorage('chatHistory_a', []).length, 3);
    }
});
test('real store awaits IDB hydration and refuses corrupt or missing histories', async () => {
    const h = realStore({ idb: true, deferReads: true }); h.seed([{ type: 'friend', content: 'saved' }]);
    let finished = false; const ready = h.sandbox.ensureChatHistoryReady('a').then(() => { finished = true; });
    await settle(); assert.equal(finished, false); assert.equal(h.reads.length, 1);
    h.reads.shift()(); await ready; assert.equal(h.sandbox.getChatHistoryArray('a')[0].content, 'saved');
    for (const raw of ['bad json', '{}', null]) {
        const bad = realStore({ idb: true }); bad.seed([]);
        if (raw == null) bad.disk.delete('chatHistory_a'); else bad.disk.set('chatHistory_a', raw);
        await assert.rejects(bad.sandbox.ensureChatHistoryReady('a'));
    }
});
test('clear during IDB hydration cannot repopulate a deleted history', async () => {
    const h = realStore({ idb: true, deferReads: true }); h.seed([{ type: 'friend', content: 'stale' }]);
    const ready = h.sandbox.ensureChatHistoryReady('a'); await settle();
    h.sandbox.clearChatHistoryMemCache(); h.values.delete('chatHistory_a'); h.reads.shift()();
    await assert.rejects(ready); assert.equal(h.sandbox.getChatHistoryArray('a').length, 0);
});
test('IDB write failure or cancellation leaves memory and prior disk history intact', async () => {
    const failing = realStore({ idb: true, failIdb: true }); failing.seed([{ type: 'user', content: 'keep' }]);
    await failing.sandbox.ensureChatHistoryReady('a');
    await assert.rejects(failing.sandbox.commitProactiveChatBatch('a', [{ type: 'friend', content: 'lost' }], () => true));
    assert.equal(failing.sandbox.getChatHistoryArray('a').length, 1); assert.equal(JSON.parse(failing.disk.get('chatHistory_a')).length, 1);
    const h = realStore({ idb: true }); h.seed([{ type: 'user', content: 'keep' }]); await h.sandbox.ensureChatHistoryReady('a');
    const ctrl = new AbortController(); h.onPut(() => ctrl.abort());
    assert.equal(await h.sandbox.commitProactiveChatBatch('a', [{ type: 'friend', content: 'stale' }], () => true, ctrl.signal), false);
    assert.equal(h.sandbox.getChatHistoryArray('a').length, 1); assert.equal(JSON.parse(h.disk.get('chatHistory_a')).length, 1);
});
test('secondary tab waits for primary tab message persistence instead of erasing its countdown', async () => {
    const h = harness(); await h.api.tick(); h.user('not yet flushed');
    const other = harness({ values: h.values, histories: { a: [] } }); await other.api.tick();
    assert.equal(other.state().replyAt, h.state().replyAt); assert.ok(other.state().replyAt);
    other.advance(35000); await other.api.tick(); assert.equal(other.calls.length, 0);
    other.histories.a.push(...h.histories.a); await other.api.tick(); assert.equal(other.calls.length, 1);
});

test('delivery requests a view refresh after the batch is committed, even if preview updating fails', async () => {
    const h = harness(), presented = [];
    h.sandbox.Wechat.ui = { requestChatHistoryRefresh: (fid, opts) => presented.push({ fid, signature: opts.expectedHistorySig, count: h.histories[fid].length }) };
    h.sandbox.queueWechatMessagePreview = () => { throw Error('synthetic preview failure'); };
    h.user('question'); h.advance(35000); await h.api.tick();
    assert.equal(h.calls.length, 1); assert.equal(h.histories.a.length, 2);
    assert.equal(presented[0].count, 2); assert.equal(presented[0].signature, h.state().historySig);
    await h.api.tick(); assert.equal(h.calls.length, 1); assert.equal(h.state().mode, 'interval');
});

test('queued storage events retain each friend and late history persistence requests another view refresh', async () => {
    const h = harness({ friends: [{ id: 'a' }, { id: 'b' }], histories: { a: [], b: [] } }), refreshed = [], invalidated = [];
    h.sandbox.Wechat.ui = { requestChatHistoryRefresh: fid => refreshed.push(fid) };
    h.sandbox.invalidateChatHistoryMem = fid => invalidated.push(fid);
    h.values.set('proactiveMessageChangeV2', JSON.stringify({ fid: 'b', token: 'newer' }));
    h.emit('storage', { key: 'proactiveMessageChangeV2', newValue: JSON.stringify({ fid: 'a', token: 'older' }) });
    h.emit('storage', { key: 'proactiveMessageChangeV2', newValue: JSON.stringify({ fid: 'b', token: 'newer' }) });
    h.emit('storage', { key: 'chatHistory_a', newValue: '[]' });
    assert.deepEqual(refreshed, ['a', 'b', 'a']); assert.deepEqual(invalidated, ['a', 'b', 'a']);
    assert.equal(h.calls.length, 0);
});

test('a failed presentation never retries the already successful model generation', async () => {
    const h = harness(); h.sandbox.Wechat.ui = { requestChatHistoryRefresh: () => { throw Error('view unavailable'); } };
    await h.api.tick(); h.advance(60000); await h.api.tick();
    assert.equal(h.state().round, 1); assert.equal(h.state().retryAt, 0); assert.equal(h.histories.a.length, 1);
    await h.api.tick(); assert.equal(h.calls.length, 1);
});
test('import suspension blocks automatic generation and resumes with a fresh interval', async () => {
    const h = harness(); await h.api.tick(); const release = h.api.suspend(); h.advance(60000);
    await h.api.tick(); assert.equal(h.calls.length, 0); release(); await settle();
    await h.api.tick(); assert.equal(h.calls.length, 0); assert.ok(h.state().nextAt > h.now());
});
test('a broken history does not starve other candidate friends', async () => {
    const h = harness({ friends: [{ id: 'a' }, { id: 'b' }], histories: { a: [], b: [] } });
    h.sandbox.ensureChatHistoryReady = async fid => { if (fid === 'a') throw Error('not ready'); return h.histories.b; };
    await h.api.tick(); h.advance(60000); await h.api.tick(); assert.equal(h.histories.b.length, 1);
});
