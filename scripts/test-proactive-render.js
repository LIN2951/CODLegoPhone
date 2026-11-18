'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const core = require('../wechat-proactive-core.js');
const settle = async () => { for (let i = 0; i < 25; i++) await Promise.resolve(); };

// Exercise the real history selection, navigation and RAF lifecycle. Only bubble painting is
// replaced; complete HTML/bilingual bubbles are additionally verified in the browser fixture.
function harness() {
    let sequence = 0;
    const frames = new Map(), timers = new Map(), events = {}, warnings = [];
    class Element {
        constructor() { this.dataset = {}; this.children = []; this.scrollTop = 0; this.clientHeight = 100; this.textContent = ''; this.className = ''; }
        get classList() { const self = this; return { contains: c => self.className.split(' ').includes(c), add: c => { self.className += ' ' + c; }, remove: c => { self.className = self.className.split(' ').filter(x => x !== c).join(' '); } }; }
        get innerHTML() { return ''; }
        set innerHTML(_value) { this.children = []; }
        get textContent() { return (this._text || '') + this.children.map(n => n.textContent).join(''); }
        set textContent(value) { this._text = String(value); this.children = []; }
        get lastChild() { return this.children[this.children.length - 1]; }
        get lastElementChild() { return this.lastChild; }
        get scrollHeight() { return this.children.length * 30; }
        appendChild(node) { if (node.fragment) node.children.forEach(n => this.appendChild(n)); else this.children.push(node); return node; }
        removeChild(node) { this.children = this.children.filter(n => n !== node); return node; }
        addEventListener() {} removeEventListener() {}
        setAttribute(key, value) { this[key] = value; }
        querySelector() { return null; }
        querySelectorAll() { return []; }
    }
    const area = new Element(), page = new Element(); page.dataset.friendId = 'a'; page.className = 'page active'; page.style = {};
    const histories = { a: [{ type: 'user', content: 'question', timestamp: 1 }, ...Array.from({ length: 49 }, (_, i) => ({ type: 'friend', content: 'reply ' + i, timestamp: i + 2 }))], b: [{ type: 'user', content: 'B only', timestamp: 101 }] };
    const friends = [{ id: 'a', nickname: '林舟' }, { id: 'b', nickname: '陈默' }];
    const s = { console: { warn: (...args) => warnings.push(args), error: (...args) => warnings.push(args) }, Date, Math, Map, Promise,
        Wechat: { init() {}, proactive: { syncUI() {} } }, LegoProactiveCore: core,
        __chatUiBridge: { currentPage: 'chat' }, perfLog() {}, showNotification() {}, HeartbeatMonitor: { restore() {} },
        loadFriendsFromStorage: () => friends, ensureFriendsCacheHydrated: async () => {},
        getChatHistoryArray: fid => histories[fid], ensureChatHistoryReady: async fid => histories[fid],
        document: { hidden: false, head: new Element(), getElementById: id => id === 'chat-page' ? page : null,
            querySelector: selector => selector === '.chat-content' || selector === '#chat-page .chat-content' ? area : null,
            querySelectorAll: () => [], createElement: () => new Element(), createDocumentFragment: () => Object.assign(new Element(), { fragment: true }),
            addEventListener: (name, fn) => (events[name] ||= []).push(fn) },
        addEventListener: (name, fn) => (events[name] ||= []).push(fn),
        requestAnimationFrame: fn => { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame: id => frames.delete(id),
        setTimeout: fn => { timers.set(++sequence, fn); return sequence; }, clearTimeout: id => timers.delete(id),
        navigateTo: name => { s.__chatUiBridge.currentPage = name; page.className = name === 'chat' ? 'page active' : 'page'; },
        testPaint: (type, content, _quote, timestamp, fid, _sub, _tr, _gift, _qty, _kind, _speaker, _forward, _ctx, index) => {
            const node = new Element(); node.textContent = content; node.className = 'chat-message ' + (type === 'friend' ? 'other-message' : 'my-message');
            node.dataset.messageTimestamp = String(timestamp); node.dataset.messageIndex = String(index); area.appendChild(node);
        }
    };
    s.window = s; page.querySelector = selector => selector === '.chat-content' ? area : null;
    let code = fs.readFileSync(path.join(__dirname, '..', 'wechat-ui.js'), 'utf8');
    const start = code.indexOf('\nfunction displayMessage('), end = code.indexOf('// 发送消息（', start);
    assert.ok(start > 0 && end > start);
    code = code.slice(0, start) + '\nfunction displayMessage(...args) { global.testPaint(...args); }\n' + code.slice(end);
    vm.createContext(s); vm.runInContext(code, s);
    const frame = () => { const current = [...frames.values()]; frames.clear(); current.forEach(fn => fn()); };
    return { s, ui: s.Wechat.ui, histories, area, page, frames, timers, warnings, frame,
        drain: async () => { for (let i = 0; i < 50; i++) { await settle(); if (!frames.size && !timers.size) return; frame(); const todo = [...timers.values()]; timers.clear(); todo.forEach(fn => fn()); } throw Error('render never settled'); },
        text: () => area.children.map(n => n.textContent), emit: name => (events[name] || []).forEach(fn => fn()) };
}

test('a delayed callback for another friend must not erase the currently visible conversation', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); await h.drain(); const before = h.text();
    h.ui.loadChatHistory('b'); await h.drain(); assert.deepEqual(h.text(), before);
});

test('an obsolete RAF cannot cancel the newer render that owns the screen', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); h.frame(); const obsolete = [...h.frames.values()][0];
    h.histories.a.push({ type: 'friend', content: 'NEWEST', timestamp: 100 }); h.ui.loadChatHistory('a');
    obsolete(); await h.drain(); assert.equal(h.text().at(-1), 'NEWEST');
});

test('returning to the same friend detects saved messages instead of reusing an old screen', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); await h.drain();
    h.s.navigateTo('home'); h.histories.a.push({ type: 'friend', content: 'SAVED WHILE AWAY', timestamp: 100 });
    await h.ui.openChat('林舟', 'a'); await h.drain(); assert.equal(h.text().at(-1), 'SAVED WHILE AWAY');
});

test('a history mutation between render chunks is reconciled before marking the view complete', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); h.frame();
    h.histories.a.push({ type: 'friend', content: 'ARRIVED DURING RENDER', timestamp: 100 });
    await h.drain(); assert.equal(h.text().at(-1), 'ARRIVED DURING RENDER');
});

test('visible refresh coalesces notifications and renders already saved data without another generation', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); await h.drain();
    h.histories.a.push({ type: 'friend', content: 'REMOTE COMMIT', timestamp: 100 });
    const one = h.ui.requestChatHistoryRefresh('a'), two = h.ui.requestChatHistoryRefresh('a'); assert.equal(one, two);
    await one; await h.drain(); assert.equal(h.text().at(-1), 'REMOTE COMMIT');
    assert.equal(h.text().filter(t => t === 'REMOTE COMMIT').length, 1);
    assert.equal(await h.ui.requestChatHistoryRefresh('a'), false);
});

test('hidden-page commits are shown on resume without clearing the old view in the background', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); await h.drain(); const before = h.text();
    h.s.document.hidden = true; h.histories.a.push({ type: 'friend', content: 'BACKGROUND COMMIT', timestamp: 100 });
    await h.ui.requestChatHistoryRefresh('a'); assert.deepEqual(h.text(), before);
    h.s.document.hidden = false; await h.ui.requestChatHistoryRefresh('a'); await h.drain();
    assert.equal(h.text().at(-1), 'BACKGROUND COMMIT');
});

test('delayed IDB readiness cannot repaint a friend the user has already left', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); await h.drain(); let resolve;
    h.s.ensureChatHistoryReady = () => new Promise(r => { resolve = r; });
    const pending = h.ui.requestChatHistoryRefresh('a'); await settle();
    h.page.dataset.friendId = 'b'; h.ui.loadChatHistory('b'); await h.drain();
    resolve(h.histories.a); await pending; await h.drain(); assert.deepEqual(h.text(), ['B only']);
});

test('refresh notifications do not repeatedly cancel a valid multi-frame render', async () => {
    const h = harness(); h.ui.loadChatHistory('a'); h.frame(); const frameId = [...h.frames.keys()][0];
    assert.equal(await h.ui.requestChatHistoryRefresh('a'), false); assert.ok(h.frames.has(frameId));
    await h.drain(); assert.equal(h.text().length, 50); assert.equal(h.ui.isActiveChatHistoryRenderingForFriend('a'), false);
});

test('one bubble failure cannot leave the renderer locked or hide subsequent replies', async () => {
    for (const afterAppend of [false, true]) {
        const h = harness(), paint = h.s.testPaint;
        h.s.testPaint = (...args) => {
            if (args[1] === 'reply 10') { if (afterAppend) paint(...args); throw Error('synthetic bubble error'); }
            paint(...args);
        };
        h.ui.loadChatHistory('a'); await h.drain();
        assert.equal(h.ui.isActiveChatHistoryRenderingForFriend('a'), false); assert.equal(h.text().at(-1), 'reply 48');
        assert.equal(h.area.children.length, 50); assert.equal(h.warnings.length, 1);
        assert.equal(h.text().filter(text => text === 'reply 10').length, 1);
    }
});

test('null history records cannot stall the round scanner and hide the newest reply', async () => {
    const h = harness(); h.histories.a.splice(20, 0, null);
    h.ui.loadChatHistory('a'); await h.drain(); assert.equal(h.text().at(-1), 'reply 48'); assert.equal(h.area.children.length, 50);
});
