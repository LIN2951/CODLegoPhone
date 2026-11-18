'use strict';
const http = require('node:http'), fs = require('node:fs'), path = require('node:path');
const root = path.resolve(__dirname, '../../..');
const mime = { '.js': 'text/javascript; charset=utf-8', '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.md': 'text/plain; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ttf': 'font/ttf', '.woff2': 'font/woff2' };
function createFixture() {
  const state = { mode: 'success', calls: 0, prompts: [] };
  const service = http.createServer((req, res) => {
    const pathname = new URL(req.url, 'http://localhost').pathname;
    res.setHeader('Cache-Control', 'no-store');
    if (pathname === '/api/chat/completions' && req.method === 'POST') {
      let body = ''; req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        state.calls++;
        let parsed; try { parsed = JSON.parse(body); } catch (_) { parsed = {}; }
        const data = parsed.body || parsed.payload || parsed.requestBody || parsed;
        const prompt = data.messages?.[0]?.content || ''; state.prompts.push(prompt);
        const mode = state.mode;
        const send = () => {
          if (res.destroyed) return;
          res.setHeader('Content-Type', 'application/json');
          if (mode === 'failure') { res.writeHead(401); res.end(JSON.stringify({ error: { message: 'Fixture key rejected' } })); return; }
          const companion = prompt.includes('正在情侣空间里陪');
          res.end(JSON.stringify({ choices: [{ message: { content: companion
            ? '看见这组牌，我想和你先从一件小事开始：今晚散步时，轮流说说今天最希望被理解的事。'
            : '### 牌阵总览\n这组牌提醒我们观察沟通中的期待。\n### 逐位解读\n请把牌位当作反思的入口，而不是确定的预测。\n### 综合信息\n让彼此的需要变得具体，关系会有更多沟通的空间。\n### 建议\n- 今晚一起散步，轮流表达一件小愿望。\n- 留出安静倾听的时间。' } }] }));
        };
        if (mode === 'delayed') { const timer = setTimeout(send, 3500); res.on('close', () => clearTimeout(timer)); } else send();
      }); return;
    }
    if (pathname.startsWith('/api/') && pathname !== '/api/commands') { res.writeHead(403); res.end('Fixture never forwards APIs'); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    let relative;
    try { relative = pathname === '/' ? '/index.html' : pathname === '/api/commands' ? '/system_commands.json' : decodeURIComponent(pathname); }
    catch (_) { res.writeHead(400); res.end(); return; }
    const filename = path.resolve(root, '.' + relative);
    if (!filename.startsWith(root + path.sep) || !fs.existsSync(filename) || !fs.statSync(filename).isFile()) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', mime[path.extname(filename)] || 'application/octet-stream');
    if (relative === '/index.html') res.end(fs.readFileSync(filename, 'utf8').replace('<head>', '<head><script src="/modules/milian-tarot/tests/fixture-bootstrap.js"></script>'));
    else fs.createReadStream(filename).pipe(res);
  });
  return { service, state };
}
module.exports = { createFixture };
if (require.main === module) {
  const { service } = createFixture();
  service.listen(0, '127.0.0.1', () => console.log(JSON.stringify({ url: 'http://127.0.0.1:' + service.address().port + '/', pid: process.pid })));
}
