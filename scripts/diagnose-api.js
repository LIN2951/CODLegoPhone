'use strict';
// Connection-only diagnostics: always uses an invalid placeholder key, never saved user credentials.
const http = require('node:http');
const https = require('node:https');
const { normalizeTargetBaseUrl, buildOpenAICompatUrl } = require('../server.js');

function probe(url, options = {}, body) {
    return new Promise(resolve => {
        const started = Date.now();
        let finished = false, request, response;
        const finish = result => {
            if (finished) return;
            finished = true;
            clearTimeout(timer);
            if (response && !response.complete) response.destroy();
            if (request && !request.destroyed) request.destroy();
            resolve({ ...result, elapsedMs: Date.now() - started });
        };
        const timer = setTimeout(() => finish({ networkCode: 'ETIMEDOUT' }), 15000);
        try {
            request = (url.startsWith('https:') ? https : http).request(url, { family: 4, ...options }, incoming => {
                response = incoming;
                let text = '';
                incoming.on('data', chunk => { if (text.length < 8192) text += chunk.toString('utf8'); });
                incoming.on('error', e => finish({ networkCode: e.code || 'RESPONSE_ERROR' }));
                incoming.on('end', () => {
                    let payload = null;
                    try { payload = JSON.parse(text); } catch (_) {}
                    finish({ status: incoming.statusCode, code: payload && typeof payload.code === 'string' ? payload.code : undefined,
                        networkCode: payload && payload.networkCode || undefined,
                        pid: payload && (payload.pid || payload.servicePid) || undefined,
                        revision: payload && payload.revision || undefined });
                });
            });
            request.on('error', e => finish({ networkCode: e.code || 'REQUEST_ERROR' }));
            request.end(body);
        } catch (e) { finish({ networkCode: e.code || 'INVALID_REQUEST' }); }
    });
}

async function main() {
    const args = process.argv.slice(2);
    const input = args.includes('--url') ? args[args.indexOf('--url') + 1] : '';
    const base = normalizeTargetBaseUrl(input);
    const port = args.includes('--port') ? Number(args[args.indexOf('--port') + 1]) : 1030;
    if (!base || !Number.isInteger(port) || port < 1 || port > 65535) {
        console.error('Usage: npm run diagnose:api -- --url https://your-api-host [--port 1030]');
        process.exitCode = 1; return;
    }
    const endpoint = buildOpenAICompatUrl(base, 'models');
    const auth = 'Bearer diagnostic-invalid-key';
    const body = JSON.stringify({ targetBaseUrl: base, authorization: auth });
    const [health, local, direct] = await Promise.all([
        probe('http://127.0.0.1:' + port + '/api/health'),
        probe('http://127.0.0.1:' + port + '/api/models/list', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } }, body),
        probe(endpoint, { headers: { Authorization: auth, Accept: 'application/json', 'User-Agent': 'LegoMiniphone/1.2' } }),
    ]);
    const safeUrl = new URL(endpoint);
    console.log(JSON.stringify({ endpoint: safeUrl.origin + safeUrl.pathname, health, local, direct }, null, 2));
    if (local.networkCode === 'EACCES' || local.networkCode === 'EPERM') {
        console.log(direct.status ? '当前服务进程的出站连接受限；当前终端可到达上游。请用本终端的启动脚本重启服务。' : '当前服务的出站连接被拒绝。请在普通 PowerShell 中重试，并检查系统网络策略。');
        process.exitCode = 1;
    } else if (local.status === 401 || local.status === 200) {
        console.log('本地代理已到达上游。测试使用无效占位密钥，401 属于预期结果；未验证你的真实密钥。');
    } else {
        console.log('请根据 local/direct 的 HTTP 状态与 networkCode 检查连接；此诊断不读取或保存真实密钥。');
        process.exitCode = 1;
    }
}
main().catch(() => { console.error('诊断未能完成，请检查参数和本地服务。'); process.exitCode = 1; });
