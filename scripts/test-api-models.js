'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { once } = require('node:events');
const { handleModelsListRequest, normalizeTargetBaseUrl, buildOpenAICompatUrl, server } = require('../server.js');
const app = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

function between(start, end) {
    const a = app.indexOf(start), b = app.indexOf(end, a);
    assert.ok(a >= 0 && b > a, start);
    return app.slice(a, b);
}
function frontend(fetchImpl, options = {}) {
    const events = { calls: [], success: [], errors: [], notices: [], final: 0, timers: new Map() };
    let nextTimer = 0;
    const context = {
        URL, AbortController, console: { warn() {} },
        document: { getElementById: id => options.elements && options.elements[id] || null },
        window: { location: { origin: 'http://127.0.0.1:1030' } },
        setTimeout(fn, ms) {
            const id = ++nextTimer;
            if (ms === 35000) events.timers.set(id, fn);
            else queueMicrotask(fn);
            return id;
        },
        clearTimeout(id) { events.timers.delete(id); },
        showNotification: text => events.notices.push(text),
        showErrorDialog: (title, text) => events.errors.push({ title, text }),
        fetch: async (...args) => { events.calls.push(args); return fetchImpl(...args); },
    };
    vm.createContext(context);
    vm.runInContext(between('function apiUrlNeedsLocalProxy(', '/**\n * 构建 OpenAI 兼容').replace(/\r\n/g, '\n'), context);
    vm.runInContext(between('function stripMatchingApiKeyQuotes(', 'function expandMinimaxVoiceErrorHint('), context);
    vm.runInContext(between('const modelListRequests =', 'function fetchFloatingModels('), context);
    return { context, events, run: (extra = {}) => context.fetchModelsForInputs(extra.url || 'https://example.invalid', extra.key || 'fixture-secret-key',
        models => events.success.push(Array.from(models)), () => events.final++, extra),
        timeout: () => { for (const fn of events.timers.values()) fn(); } };
}
function response(status, body, source = 'upstream') {
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: source ? { 'X-Lego-Proxy-Source': source } : {} });
}
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
async function listen(t, handler) {
    const service = handler === server ? server : http.createServer(handler);
    await new Promise(resolve => service.listen(0, '127.0.0.1', resolve));
    t.after(async () => { service.closeAllConnections(); await new Promise(resolve => service.close(resolve)); });
    return 'http://127.0.0.1:' + service.address().port;
}
async function post(base, target, authorization = 'Bearer fixture-secret-key') {
    const r = await fetch(base + '/api/models/list', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetBaseUrl: target, authorization }) });
    return { status: r.status, headers: r.headers, data: await r.json() };
}

test('frontend and proxy normalize roots, endpoints, query strings, and reject invalid schemes', () => {
    const h = frontend(() => {});
    for (const [url, expected] of [
        ['https://example.com', 'https://example.com/v1/models'],
        ['https://example.com/v1/', 'https://example.com/v1/models'],
        ['https://example.com/v1/models/', 'https://example.com/v1/models'],
        ['https://example.com/openai/v1/chat/completions?route=a#ignore', 'https://example.com/openai/v1/models?route=a'],
        ['https://example.com/models?route=a', 'https://example.com/v1/models?route=a'],
    ]) {
        assert.equal(h.context.buildOpenAIModelsListUrl(url), expected);
        assert.equal(buildOpenAICompatUrl(normalizeTargetBaseUrl(url), 'models'), expected);
    }
    for (const url of ['file:///tmp/a', 'ftp://example.com', 'not a url', 'https://user:pass@example.com']) {
        assert.equal(normalizeTargetBaseUrl(url), null);
        assert.equal(h.context.normalizeApiBaseUrlForProxy(url), '');
    }
});
test('valid arrays are normalized, invalid entries filtered, ids preferred, and duplicates removed', async () => {
    for (const data of [{ data: [null, {}, { id: ' a ', name: 'display' }, 'b', { id: 'a' }] }, { models: [{ name: 'a' }, { id: 'b' }] }, ['a', 'b', 'a']]) {
        const h = frontend(() => response(200, data));
        assert.equal(await h.run(), true);
        assert.deepEqual(h.events.success, [['a', 'b']]);
        assert.equal(h.events.calls.length, 1);
        assert.equal(h.events.final, 1);
        assert.equal(h.events.timers.size, 0);
    }
});
test('EACCES is not retried and diagnostics retain code without exposing credentials', async () => {
    const h = frontend(() => response(502, { code: 'UPSTREAM_CONNECT_DENIED', networkCode: 'EACCES', retryable: false, servicePid: 123,
        error: 'connect EACCES fixture-secret-key https://example.invalid/v1/models?key=hidden' }, 'local'));
    assert.equal(await h.run(), false);
    assert.equal(h.events.calls.length, 1);
    assert.match(h.events.errors[0].text, /EACCES/);
    assert.match(h.events.errors[0].text, /123/);
    assert.doesNotMatch(h.events.errors[0].text, /fixture-secret-key|key=hidden/);
    assert.equal(h.events.final, 1);
});
test('401, 403, 404 and 429 stop immediately and never replace the current models', async () => {
    for (const status of [401, 403, 404, 429]) {
        const h = frontend(() => response(status, { error: { message: 'upstream refusal' } }));
        await h.run();
        assert.equal(h.events.calls.length, 1, String(status));
        assert.equal(h.events.success.length, 0);
        assert.match(h.events.errors[0].text, new RegExp('HTTP ' + status));
    }
});
test('upstream error text mentioning EACCES or numbers does not misclassify HTTP status', async () => {
    const h = frontend(() => response(403, { error: { message: 'request 40120 upstream EACCES', code: 'UPSTREAM_CONNECT_DENIED' } }));
    await h.run();
    assert.match(h.events.errors[0].text, /上游拒绝访问/);
    assert.doesNotMatch(h.events.errors[0].text, /本地服务连接上游时被/);
});
test('transient failures retry to success and stop at three attempts on persistent failure', async () => {
    let count = 0;
    const h = frontend(() => ++count < 3 ? response(503, { error: 'temporary unavailable' }) : response(200, { data: [{ id: 'ok' }] }));
    assert.equal(await h.run(), true);
    assert.equal(h.events.calls.length, 3);
    const bad = frontend(() => response(502, { error: 'bad gateway' }));
    assert.equal(await bad.run(), false);
    assert.equal(bad.events.calls.length, 3);
    assert.equal(bad.events.errors.length, 1);
});
test('network exceptions retry; DNS/TLS and explicit non-retryable proxy failures stop', async () => {
    const network = frontend(() => { throw new TypeError('Failed to fetch'); });
    await network.run();
    assert.equal(network.events.calls.length, 3);
    for (const code of ['UPSTREAM_DNS_FAILED', 'UPSTREAM_TLS_FAILED', 'UPSTREAM_RESPONSE_TOO_LARGE']) {
        const h = frontend(() => response(502, { code, error: code, retryable: false }, 'local'));
        await h.run(); assert.equal(h.events.calls.length, 1);
    }
});
test('HTML, invalid JSON, malformed arrays and empty lists finish once without retry', async () => {
    for (const body of ['<!doctype html><html>login</html>', '{broken', { data: {} }, { data: [] }, { data: [null, {}, 2] }, { error: { message: 'provider error' } }]) {
        const h = frontend(() => response(200, body));
        assert.equal(await h.run(), false);
        assert.equal(h.events.calls.length, 1);
        assert.equal(h.events.errors.length, 1);
        assert.equal(h.events.final, 1);
    }
});
test('front deadline aborts hung fetch and hung response body, always clears loading', async () => {
    for (const phase of ['fetch', 'body']) {
        const h = frontend((_url, options) => {
            const pending = () => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
            return phase === 'fetch' ? pending() : { ok: true, text: pending };
        });
        const running = h.run(); await tick(); h.timeout();
        assert.equal(await running, false);
        assert.match(h.events.errors[0].text, /超时/);
        assert.equal(h.events.calls.length, 1);
        assert.equal(h.events.final, 1);
    }
});
test('configuration changes suppress late success and errors without writing the list', async () => {
    let resolve, current = true;
    const h = frontend(() => new Promise(r => { resolve = r; }));
    const running = h.run({ isCurrent: () => current });
    current = false; resolve(response(200, ['late-model']));
    assert.equal(await running, false);
    assert.equal(h.events.success.length, 0);
    assert.equal(h.events.errors.length, 0);
    assert.equal(h.events.final, 1);
});
test('a second request cancels the old request; old cleanup cannot reset new loading', async () => {
    let resolveOld, count = 0;
    const h = frontend(() => ++count === 1 ? new Promise(r => { resolveOld = r; }) : response(200, ['new-model']));
    const old = h.run();
    const fresh = h.run();
    assert.equal(h.events.calls[0][1].signal.aborted, true);
    assert.equal(await fresh, true);
    resolveOld(response(200, ['old-model']));
    assert.equal(await old, false);
    assert.deepEqual(h.events.success, [['new-model']]);
    assert.equal(h.events.final, 1);
});
test('input edits cancel and remove temporary listeners', async () => {
    const input = new EventTarget();
    const h = frontend((_url, options) => new Promise((_resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })));
    const pending = h.run({ inputs: [input] });
    input.dispatchEvent(new Event('input'));
    assert.equal(await pending, false);
    assert.equal(h.events.errors.length, 0);
    assert.equal(h.events.final, 1);
});
test('all three model-list entry points use independent form scopes', () => {
    for (const entry of ["modelListFormContext('main', 'api-url', 'api-key')", "modelListFormContext('floating', 'floating-api-url', 'floating-api-key')", "modelListFormContext('proactive', 'proactive-auto-api-url', 'proactive-auto-api-key')"]) assert.ok(app.includes(entry));
});

test('proxy reaches mock upstream with normalized endpoint/key and preserves split UTF-8', async t => {
    const upstream = await listen(t, (req, res) => {
        assert.equal(req.url, '/v1/models?route=keep');
        assert.equal(req.headers.authorization, 'Bearer fixture-secret-key');
        const data = Buffer.from(JSON.stringify({ data: [{ id: '中文模型' }] }));
        const cut = data.indexOf(Buffer.from('中')) + 1;
        res.writeHead(200); res.write(data.subarray(0, cut));
        setImmediate(() => res.end(data.subarray(cut)));
    });
    const proxy = await listen(t, handleModelsListRequest);
    const result = await post(proxy, upstream + '/v1/models?route=keep', 'Bearer "fixture-\r\nsecret-key"');
    assert.equal(result.status, 200);
    assert.deepEqual(result.data, { data: [{ id: '中文模型' }] });
    assert.equal(result.headers.get('cache-control'), 'no-store');
    assert.equal(result.headers.get('x-lego-proxy-source'), 'upstream');
});
test('proxy rejects invalid inputs before contacting upstream', async t => {
    let contacted = 0;
    const proxy = await listen(t, (req, res) => handleModelsListRequest(req, res, { request() { contacted++; } }));
    for (const target of ['invalid', 'ftp://example.com', 'https://user:pass@example.com']) {
        const result = await post(proxy, target);
        assert.equal(result.status, 400); assert.equal(result.data.code, 'INVALID_TARGET_URL');
    }
    const badKey = await post(proxy, 'https://example.com', 'Bearer 错误');
    assert.equal(badKey.data.code, 'INVALID_AUTHORIZATION_HEADER');
    assert.equal(contacted, 0);
    const badBody = await fetch(proxy + '/api/models/list', { method: 'POST', body: '{broken' });
    assert.equal(badBody.status, 400);
    const tooLarge = await fetch(proxy + '/api/models/list', { method: 'POST', body: 'a'.repeat(70 * 1024) });
    assert.equal(tooLarge.status, 413);
});
test('proxy reports permission errors with non-retryable metadata', async t => {
    const proxy = await listen(t, (req, res) => handleModelsListRequest(req, res, { request() {
        const upstream = new EventEmitter();
        upstream.end = () => queueMicrotask(() => upstream.emit('error', Object.assign(new Error('connect EACCES'), { code: 'EACCES' })));
        upstream.destroy = () => { upstream.destroyed = true; };
        return upstream;
    } }));
    const result = await post(proxy, 'https://example.com?query=secret');
    assert.equal(result.status, 502);
    assert.equal(result.data.code, 'UPSTREAM_CONNECT_DENIED');
    assert.equal(result.data.retryable, false);
    assert.equal(result.data.networkCode, 'EACCES');
    assert.equal(result.data.upstream, 'https://example.com/v1/models');
    assert.equal(result.headers.get('x-lego-proxy-source'), 'local');
});
test('proxy preserves upstream authentication and rate-limit responses', async t => {
    let status = 401;
    const upstream = await listen(t, (_req, res) => { res.writeHead(status, { 'Retry-After': '30' }); res.end(JSON.stringify({ error: { message: 'Denied' } })); });
    const proxy = await listen(t, handleModelsListRequest);
    for (status of [401, 403, 429, 503]) {
        const result = await post(proxy, upstream);
        assert.equal(result.status, status);
        assert.equal(result.headers.get('retry-after'), '30');
        assert.equal(result.headers.get('x-lego-proxy-source'), 'upstream');
    }
});
test('proxy total deadline covers missing headers and stalled response bodies', async t => {
    let sendHeaders = false;
    const upstream = await listen(t, (_req, res) => { if (sendHeaders) { res.writeHead(200); res.write('{"data":['); } });
    const proxy = await listen(t, (req, res) => handleModelsListRequest(req, res, { timeoutMs: 80 }));
    for (sendHeaders of [false, true]) {
        const result = await post(proxy, upstream);
        assert.equal(result.status, 504);
        assert.equal(result.data.code, 'UPSTREAM_CONNECT_TIMEOUT');
    }
});
test('upstream disconnect becomes structured reset error, not a hanging request', async t => {
    const upstream = await listen(t, (_req, res) => { res.writeHead(200); res.write('{"data":['); setImmediate(() => res.destroy()); });
    const proxy = await listen(t, handleModelsListRequest);
    const result = await post(proxy, upstream);
    assert.equal(result.status, 502);
    assert.equal(result.data.code, 'UPSTREAM_CONNECTION_RESET');
    assert.equal(result.data.retryable, true);
});
test('browser disconnect cancels the upstream socket', async t => {
    let announce, closed;
    const connected = new Promise(resolve => { announce = resolve; });
    const upstream = await listen(t, (_req, res) => { closed = once(res, 'close'); res.writeHead(200); res.write('{'); announce(); });
    const proxy = await listen(t, handleModelsListRequest);
    const request = http.request(proxy + '/api/models/list', { method: 'POST' });
    request.on('error', () => {});
    request.end(JSON.stringify({ targetBaseUrl: upstream, authorization: 'Bearer fixture' }));
    await connected;
    request.destroy();
    await closed;
});
test('proxy bounds response size and refuses credential-bearing redirects', async t => {
    let mode = 'large';
    const upstream = await listen(t, (_req, res) => {
        if (mode === 'redirect') { res.writeHead(302, { Location: 'https://elsewhere.invalid/v1/models' }); res.end(); }
        else res.end(Buffer.alloc(8 * 1024 * 1024 + 1, 32));
    });
    const proxy = await listen(t, handleModelsListRequest);
    assert.equal((await post(proxy, upstream)).data.code, 'UPSTREAM_RESPONSE_TOO_LARGE');
    mode = 'redirect';
    assert.equal((await post(proxy, upstream)).data.code, 'UPSTREAM_REDIRECT');
});
test('health identifies the running source and project without disclosing paths or keys', async t => {
    const base = await listen(t, server);
    const health = await (await fetch(base + '/api/health')).json();
    assert.equal(health.service, 'lego-miniphone');
    assert.equal(health.pid, process.pid);
    assert.match(health.revision, /^[a-f0-9]{16}$/);
    assert.match(health.workspaceId, /^[a-f0-9]{16}$/);
    assert.doesNotMatch(JSON.stringify(health), /apiKey|authorization|[A-Z]:\\/);
});
