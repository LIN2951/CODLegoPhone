'use strict';
// Isolated random origin, in-memory settings, local model fixtures; no upstream forwarding.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
let mode = 'success', calls = 0;
const bootstrap = `
(function () {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) || null,
        setItem: (key, value) => values.set(key, String(value)),
        removeItem: key => values.delete(key), clear: () => values.clear(),
        key: index => Array.from(values.keys())[index] || null,
        get length() { return values.size; }
    };
    Object.defineProperty(window, 'localStorage', { value: storage });
    storage.setItem('apiSettings', JSON.stringify({apiUrl:'https://fixture.invalid',apiKey:'fixture-only',model:'original-model',memoryCount:5}));
    window.addEventListener('load', () => {
        const toolbar = document.createElement('div');
        toolbar.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:999999;background:#fff;padding:6px;display:flex;gap:8px;font:14px sans-serif';
        for (const [name, value] of [['成功场景','success'],['权限失败场景','denied'],['延迟场景','delayed']]) {
            const b = document.createElement('button'); b.textContent=name;
            b.onclick = async () => { await fetch('/fixture-mode', {method:'POST', body:value}); output.textContent='场景：'+name; };
            toolbar.appendChild(b);
        }
        const output=document.createElement('output'); output.id='fixture-status'; output.textContent='隔离测试'; toolbar.appendChild(output);
        document.body.appendChild(toolbar);
        const app=document.getElementById('app'); app.style.marginTop='50px'; app.style.height='calc(var(--lego-vv-h) - 65px)';
        setInterval(async () => { const s=await (await fetch('/fixture-state')).json(); output.textContent='请求 '+s.calls+'；场景 '+s.mode; }, 200);
        navigateTo('api-settings');
    });
})();`;
const mime = { '.html': 'text/html; charset=utf-8', '.js': 'application/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf' };
const service = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/fixture-bootstrap.js') { res.setHeader('Content-Type', mime['.js']); res.end(bootstrap); return; }
    if (pathname === '/fixture-state') { res.setHeader('Content-Type', mime['.json']); res.end(JSON.stringify({ mode, calls })); return; }
    if (pathname === '/fixture-mode' && req.method === 'POST') {
        let value = ''; req.on('data', chunk => { value += chunk; }); req.on('end', () => { if (['success', 'denied', 'delayed'].includes(value)) { mode = value; calls = 0; } res.end('OK'); }); return;
    }
    if (pathname === '/api/models/list' && req.method === 'POST') {
        req.resume(); calls++;
        const selectedMode = mode;
        const send = () => {
            if (res.destroyed) return;
            res.setHeader('Content-Type', mime['.json']);
            res.setHeader('X-Lego-Proxy-Source', selectedMode === 'denied' ? 'local' : 'upstream');
            res.statusCode = selectedMode === 'denied' ? 502 : 200;
            res.end(JSON.stringify(selectedMode === 'denied'
                ? { code: 'UPSTREAM_CONNECT_DENIED', networkCode: 'EACCES', error: 'connect EACCES', retryable: false, servicePid: 999 }
                : { data: [null, { id: 'fixture-model-a', name: 'Display A' }, 'fixture-model-b', { id: 'fixture-model-a' }, {}] }));
        };
        if (selectedMode === 'delayed') { const timer = setTimeout(send, 3000); res.on('close', () => clearTimeout(timer)); }
        else send();
        return;
    }
    if (req.method !== 'GET' || pathname.startsWith('/api/')) { res.writeHead(403); res.end('No upstream APIs in fixture'); return; }
    const file = path.resolve(root, '.' + (pathname === '/' ? '/index.html' : decodeURIComponent(pathname)));
    if (!file.startsWith(root + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[path.extname(file)] || 'application/octet-stream');
    if (pathname === '/') res.end(fs.readFileSync(file, 'utf8').replace('<head>', '<head><script src="/fixture-bootstrap.js"></script>'));
    else fs.createReadStream(file).pipe(res);
});
service.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ port: service.address().port, pid: process.pid })));
