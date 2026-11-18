const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const root = __dirname;

let sharpLib = null;
try {
    sharpLib = require('sharp');
} catch (e) {
    console.warn('[购物图片] 未安装 sharp，商品图将跳过压缩直接转发（建议执行 npm install）：', e && e.message);
}

function normalizeTargetBaseUrl(input) {
    if (!input || typeof input !== 'string') return null;
    const trimmed = input.trim();
    if (!trimmed) return null;
    // 允许用户配置成 http(s)://host 或 http(s)://host/，统一补齐尾部 /
    let u;
    try { u = new URL(trimmed); } catch (_) { return null; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (u.username || u.password) return null;
    u.hash = '';
    // 用户若误粘贴完整 endpoint（如 .../v1/models 或 .../v1/chat/completions），先还原为 base
    let p = (u.pathname || '/').replace(/\/+$/, '') || '';
    const endpointSuffixes = [
        /\/chat\/completions$/i,
        /\/models$/i,
    ];
    for (const re of endpointSuffixes) {
        if (re.test(p)) {
            p = p.replace(re, '');
            break;
        }
    }
    u.pathname = (p ? p + '/' : '/');
    return u.toString();
}

/** 访问上游 OpenAI-compatible API 时的通用请求选项（优先 IPv4，缓解 Windows 下 IPv6 连接失败导致 502） */
function buildUpstreamRequestOptions(apiUrlObj, method, headers) {
    return {
        protocol: apiUrlObj.protocol,
        hostname: apiUrlObj.hostname,
        port: apiUrlObj.port || (apiUrlObj.protocol === 'https:' ? 443 : 80),
        path: apiUrlObj.pathname + apiUrlObj.search,
        method,
        family: 4,
        headers: Object.assign({
            Accept: 'application/json',
            'User-Agent': 'LegoMiniphone/1.2',
        }, headers || {}),
    };
}

function stripMatchingApiKeyQuotes(value) {
    const s = String(value || '').trim();
    if (s.length < 2) return s;
    const first = s[0];
    const last = s[s.length - 1];
    const matching =
        (first === '"' && last === '"') ||
        (first === "'" && last === "'") ||
        (first === '`' && last === '`') ||
        (first === '“' && last === '”') ||
        (first === '‘' && last === '’');
    return matching ? s.slice(1, -1).trim() : s;
}

/**
 * 清理浏览器粘贴 API Key 时常见的换行、零宽字符和成对引号，并在交给 Node HTTP 前做最终校验。
 * 不记录、不回显 token；非 ASCII 可见字符直接拒绝，避免 ERR_INVALID_CHAR 与请求头注入。
 */
function normalizeProxyAuthorizationHeader(input) {
    if (typeof input !== 'string' || !input.trim()) {
        return { ok: false, code: 'MISSING_AUTHORIZATION', message: 'API Key 为空，请重新填写。' };
    }
    let normalized = input
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .trim();
    const bearerMatch = normalized.match(/^Bearer(?:\s|:)+([\s\S]*)$/i);
    if (!bearerMatch) {
        return { ok: false, code: 'INVALID_AUTHORIZATION_HEADER', message: 'API Key 格式无效，请只粘贴纯文本密钥。' };
    }
    let token = stripMatchingApiKeyQuotes(bearerMatch[1]);
    token = token.replace(/\s+/g, '');
    if (!token) {
        return { ok: false, code: 'MISSING_AUTHORIZATION', message: 'API Key 为空，请重新填写。' };
    }
    if (!/^[\x21-\x7E]+$/.test(token)) {
        return { ok: false, code: 'INVALID_AUTHORIZATION_HEADER', message: 'API Key 含有不支持的字符，请重新粘贴纯文本密钥。' };
    }
    return { ok: true, value: 'Bearer ' + token };
}

function buildOpenAICompatUrl(base, pathAfterV1) {
    // 允许用户把 API 地址填成：
    // - https://host
    // - https://host/
    // - https://host/v1
    // - https://host/v1/
    // 统一生成可用的 OpenAI-compatible URL
    const u = new URL(base);
    const p = u.pathname || '/';
    const normalizedPath = p.endsWith('/') ? p : (p + '/');
    const hasV1 = normalizedPath.toLowerCase().endsWith('/v1/');
    u.pathname = hasV1 ? (normalizedPath + pathAfterV1) : (normalizedPath + 'v1/' + pathAfterV1);
    return u.toString();
}

/** MiniMax T2A 上游根（可用环境变量覆盖，如大陆线路 https://api.minimaxi.chat） */
function minimaxT2aRequestUrl(groupId) {
    const base = (process.env.MINIMAX_API_BASE || 'https://api.minimax.io').replace(/\/$/, '');
    const q = new URLSearchParams();
    const gid = String(groupId || '').trim();
    if (gid) q.set('GroupId', gid);
    const qs = q.toString();
    return `${base}/v1/t2a_v2${qs ? `?${qs}` : ''}`;
}

/** speech-01 / speech-02：官方音色 ID 列表与 speech-2.x 的「音色_mini65」不互通；默认改用文档列出的中文通用音色以便连通性测试 */
function resolveMinimaxVoiceId(model, voiceId) {
    const vid = String(voiceId || '').trim();
    const m = String(model || '');
    if (/^speech-0[12]-/i.test(m)) {
        if (!vid || vid === '音色_mini65') return 'Chinese (Mandarin)_Lyrical_Voice';
    }
    return vid || '音色_mini65';
}

function looksLikeMp3Magic(buf) {
    if (!buf || buf.length < 4) return false;
    if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return true;
    if (buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33) return true;
    return false;
}

/** MiniMax data.audio：文档为 hex；部分应答可能为 base64 */
function minimaxDecodeAudioPayload(audioStr, rawJson) {
    const s = String(audioStr || '').trim();
    if (!s) return { error: 'missing' };
    if (/^https?:\/\//i.test(s)) return { error: 'url_output' };

    const hexBuf = Buffer.from(s, 'hex');
    if (looksLikeMp3Magic(hexBuf)) return { buffer: hexBuf };

    const b64Buf = Buffer.from(s, 'base64');
    if (looksLikeMp3Magic(b64Buf)) return { buffer: b64Buf };

    if (hexBuf.length >= 80) return { buffer: hexBuf };
    if (b64Buf.length >= 80) return { buffer: b64Buf };

    try {
        console.log(
            '[代理 /api/voice] audio decode 失败 — hexLen=%s b64Len=%s keys=%s',
            hexBuf.length,
            b64Buf.length,
            rawJson && typeof rawJson === 'object' ? Object.keys(rawJson).join(',') : ''
        );
    } catch (_) {}
    return { error: 'decode_bad' };
}

function minimaxBuildT2aBody(base) {
    const out = Object.assign({}, base);
    delete out.groupId;
    if (process.env.MINIMAX_INCLUDE_EXTRA_GROUP === '1' && base.groupId) {
        out.extra = { group_id: String(base.groupId).trim() };
    }
    return out;
}

function formatUpstreamError(e) {
    if (!e) return 'Unknown upstream error';
    const code = e.code ? String(e.code) : '';
    const msg = e.message ? String(e.message) : String(e);
    // 常见网络/证书问题给出更可读的提示
    if (code === 'EACCES' || code === 'EPERM') {
        return '本地 Node 进程的出站连接被系统或当前运行环境拒绝（' + code + '）：' + msg;
    }
    if (code === 'ENOTFOUND') return 'DNS 解析失败（找不到域名）：' + msg;
    if (code === 'ECONNREFUSED') return '连接被拒绝（上游未启动或端口不通）：' + msg;
    if (code === 'ETIMEDOUT') return '连接超时：' + msg;
    if (code === 'ECONNRESET') return '连接被重置：' + msg;
    if (code === 'CERT_HAS_EXPIRED') return 'TLS 证书已过期：' + msg;
    if (code === 'DEPTH_ZERO_SELF_SIGNED_CERT' || code === 'SELF_SIGNED_CERT_IN_CHAIN') return 'TLS 证书校验失败（自签名/证书链问题）：' + msg;
    return (code ? (code + ': ') : '') + msg;
}

function classifyUpstreamError(e) {
    const code = e && e.code ? String(e.code) : '';
    if (code === 'EACCES' || code === 'EPERM') return 'UPSTREAM_CONNECT_DENIED';
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'UPSTREAM_DNS_FAILED';
    if (code === 'ETIMEDOUT') return 'UPSTREAM_CONNECT_TIMEOUT';
    if (code === 'ECONNREFUSED') return 'UPSTREAM_CONNECTION_REFUSED';
    if (code === 'ECONNRESET') return 'UPSTREAM_CONNECTION_RESET';
    if (/CERT|TLS|SSL/.test(code) || code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') return 'UPSTREAM_TLS_FAILED';
    return 'UPSTREAM_ERROR';
}

/**
 * 将 data 分片 Buffers 合并后一次性按 UTF-8 解码为字符串。
 * 逐块用 `str += chunk` 会在 UTF-8 码点被 TCP 拆到两包边界时把字节误解析为 �（U+FFFD），导致聊天中文偶发缺字/乱码。
 */
function bufferChunksToUtf8String(chunks) {
    if (!chunks || !chunks.length) return '';
    return Buffer.concat(chunks).toString('utf8');
}

// ── 购物商品图片：真实商品图搜索 + 落盘缓存 + 等比例压缩 ──────────
// 说明：无付费图片搜索 API，采用公开搜索引擎的公开 JSON/HTML 响应做「尽力而为」检索；
// 找不到或上游改版导致解析失败时优雅降级为 404，前端会自动回退到占位配色卡片，不影响主流程。
const SHOPPING_IMG_CACHE_DIR = path.join(root, 'cache', 'shopping-images');
const SHOPPING_IMG_MAX_DIM = 640;           // 商品展示图最长边（等比例缩放，不放大）
const SHOPPING_IMG_MAX_DOWNLOAD_BYTES = 8 * 1024 * 1024;
const SHOPPING_IMG_MIN_PIXELS = 150;        // 低于此边长的候选图视为图标/水印，跳过
const SHOPPING_IMG_MAX_CONCURRENT_FETCH = 3; // 限制同时向搜索引擎发起的检索数，降低被限流概率
const SHOPPING_IMG_MISS_TTL_MS = 6 * 60 * 60 * 1000; // 「未搜到」的负缓存有效期，避免短时间内重复无谓请求
const SHOPPING_IMG_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

try {
    fs.mkdirSync(SHOPPING_IMG_CACHE_DIR, { recursive: true });
} catch (e) {
    console.warn('[购物图片] 创建缓存目录失败:', e && e.message);
}

let shoppingImgActiveFetches = 0;
const shoppingImgWaitQueue = [];
const shoppingImgInFlight = new Map(); // hash -> Promise<boolean>
const shoppingImgMissCache = new Map(); // hash -> 过期时间戳

function shoppingImgDrainQueue() {
    if (shoppingImgWaitQueue.length && shoppingImgActiveFetches < SHOPPING_IMG_MAX_CONCURRENT_FETCH) {
        const next = shoppingImgWaitQueue.shift();
        next();
    }
}

function withShoppingImgFetchSlot(fn) {
    return new Promise((resolve) => {
        const run = () => {
            shoppingImgActiveFetches++;
            Promise.resolve()
                .then(fn)
                .catch((e) => {
                    console.warn('[购物图片] 检索/下载异常:', e && e.message);
                    return false;
                })
                .then((v) => {
                    shoppingImgActiveFetches--;
                    shoppingImgDrainQueue();
                    resolve(v);
                });
        };
        if (shoppingImgActiveFetches < SHOPPING_IMG_MAX_CONCURRENT_FETCH) run();
        else shoppingImgWaitQueue.push(run);
    });
}

function shoppingImgHash(str) {
    return crypto.createHash('sha1').update(String(str)).digest('hex');
}

function sanitizeShoppingImageQuery(raw) {
    return String(raw || '')
        .replace(/[\r\n\t\u0000]/g, ' ')
        .replace(/https?:\/\/\S+/gi, ' ')
        .trim()
        .slice(0, 80);
}

/** 通用 GET 文本请求（用于 DDG i.js / Bing 图片搜索页），带浏览器 UA 避免被直接判定为爬虫 */
function httpGetText(urlStr, extraHeaders, timeoutMs) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(urlStr);
        } catch (e) {
            reject(e);
            return;
        }
        const requester = u.protocol === 'https:' ? https : http;
        const reqObj = requester.get(u, {
            headers: Object.assign({ 'User-Agent': SHOPPING_IMG_UA }, extraHeaders || {}),
            timeout: timeoutMs || 9000,
        }, (r) => {
            reqObj.setTimeout(0);
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            r.on('error', reject);
        });
        reqObj.on('timeout', () => { reqObj.destroy(); reject(new Error('timeout')); });
        reqObj.on('error', reject);
    });
}

function httpPostFormText(urlStr, formBody, extraHeaders, timeoutMs) {
    return new Promise((resolve, reject) => {
        let u;
        try {
            u = new URL(urlStr);
        } catch (e) {
            reject(e);
            return;
        }
        const requester = u.protocol === 'https:' ? https : http;
        const reqObj = requester.request(u, {
            method: 'POST',
            headers: Object.assign({
                'User-Agent': SHOPPING_IMG_UA,
                'Content-Type': 'application/x-www-form-urlencoded',
            }, extraHeaders || {}),
            timeout: timeoutMs || 9000,
        }, (r) => {
            reqObj.setTimeout(0);
            const chunks = [];
            r.on('data', (c) => chunks.push(c));
            r.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            r.on('error', reject);
        });
        reqObj.on('timeout', () => { reqObj.destroy(); reject(new Error('timeout')); });
        reqObj.on('error', reject);
        reqObj.write(formBody);
        reqObj.end();
    });
}

/** DuckDuckGo 图片搜索（无官方 API）：先取 vqd 校验令牌，再请求 i.js 拿结构化结果 */
async function ddgImageSearch(query, limit) {
    try {
        const html = await httpPostFormText(
            'https://duckduckgo.com/',
            'q=' + encodeURIComponent(query),
            { Referer: 'https://duckduckgo.com/' },
            6000
        );
        const m = html.match(/vqd=([\d-]+)&/) || html.match(/vqd=(["'])([\d-]+)\1/);
        const vqd = m ? (m[2] || m[1]) : '';
        if (!vqd) return [];
        const qs = new URLSearchParams({ l: 'zh-cn', o: 'json', q: query, vqd, f: ',,,', p: '1' }).toString();
        const jsonText = await httpGetText('https://duckduckgo.com/i.js?' + qs, {
            Accept: 'application/json, text/javascript, */*; q=0.01',
            'X-Requested-With': 'XMLHttpRequest',
            Referer: 'https://duckduckgo.com/',
        }, 6000);
        const data = JSON.parse(jsonText);
        const results = Array.isArray(data.results) ? data.results : [];
        return results
            .filter((r) => r && typeof r.image === 'string' && /^https?:\/\//i.test(r.image))
            .filter((r) => !(Number(r.width) > 0 && Number(r.width) < SHOPPING_IMG_MIN_PIXELS) )
            .slice(0, limit)
            .map((r) => r.image);
    } catch (e) {
        console.warn('[购物图片] DuckDuckGo 检索失败:', e && e.message);
        return [];
    }
}

/** Bing 图片搜索兜底（DDG 无结果/被限流时使用）：从搜索结果页 HTML 中提取 murl 字段 */
async function bingImageSearch(query, limit) {
    try {
        const url = 'https://www.bing.com/images/search?q=' + encodeURIComponent(query) + '&form=HDRSC2&first=1';
        const html = await httpGetText(url, { Accept: 'text/html,*/*' }, 9000);
        const urls = [];
        const patterns = [/"murl":"(https?:\\?\/\\?\/[^"]+)"/g, /murl&quot;:&quot;(https?:[^&]+)&quot;/g];
        for (const re of patterns) {
            let mm;
            while ((mm = re.exec(html)) && urls.length < limit * 2) {
                let raw = mm[1].replace(/\\\//g, '/');
                if (/^https?:\/\//i.test(raw)) urls.push(raw);
            }
            if (urls.length) break;
        }
        return Array.from(new Set(urls)).slice(0, limit);
    } catch (e) {
        console.warn('[购物图片] Bing 检索失败:', e && e.message);
        return [];
    }
}

async function resolveShoppingImageCandidates(query, limit) {
    // 实测 Bing 图片搜索页在国内网络环境下更稳定；DuckDuckGo 的 vqd 校验偶发被拦截，仅作兜底
    let urls = await bingImageSearch(query, limit);
    if (!urls.length) urls = await ddgImageSearch(query, limit);
    return urls;
}

/** 多个候选并发下载+校验，谁先成功用谁，避免逐个尝试导致最坏情况下等待过久 */
function raceFirstTruthy(factories) {
    return new Promise((resolve) => {
        if (!factories.length) {
            resolve(null);
            return;
        }
        let remaining = factories.length;
        let settled = false;
        factories.forEach((factory) => {
            Promise.resolve()
                .then(factory)
                .catch(() => null)
                .then((v) => {
                    if (settled) return;
                    if (v) {
                        settled = true;
                        resolve(v);
                        return;
                    }
                    remaining--;
                    if (remaining === 0) resolve(null);
                });
        });
    });
}

function withHardTimeout(promise, ms, fallbackValue) {
    return new Promise((resolve) => {
        let done = false;
        const timer = setTimeout(() => {
            if (done) return;
            done = true;
            resolve(fallbackValue);
        }, ms);
        promise.then((v) => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(v);
        }).catch(() => {
            if (done) return;
            done = true;
            clearTimeout(timer);
            resolve(fallbackValue);
        });
    });
}

function downloadImageBuffer(urlStr, maxBytes, timeoutMs) {
    return new Promise((resolve) => {
        let u;
        try {
            u = new URL(urlStr);
        } catch (e) {
            resolve(null);
            return;
        }
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
            resolve(null);
            return;
        }
        const requester = u.protocol === 'https:' ? https : http;
        const reqObj = requester.get(u, {
            headers: {
                'User-Agent': SHOPPING_IMG_UA,
                Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
            },
            timeout: timeoutMs || 9000,
        }, (r) => {
            reqObj.setTimeout(0);
            const status = r.statusCode || 0;
            const ct = String(r.headers['content-type'] || '');
            if (status !== 200 || !/^image\//i.test(ct)) {
                r.resume();
                resolve(null);
                return;
            }
            const chunks = [];
            let total = 0;
            let aborted = false;
            r.on('data', (c) => {
                total += c.length;
                if (total > maxBytes) {
                    aborted = true;
                    try { reqObj.destroy(); } catch (e) {}
                    return;
                }
                chunks.push(c);
            });
            r.on('end', () => {
                resolve(aborted ? null : Buffer.concat(chunks));
            });
            r.on('error', () => resolve(null));
        });
        reqObj.on('timeout', () => { reqObj.destroy(); resolve(null); });
        reqObj.on('error', () => resolve(null));
    });
}

/** 等比例压缩：最长边限制在 SHOPPING_IMG_MAX_DIM 内、不放大小图，统一转为白底 JPEG 便于商品卡片展示 */
async function resizeProductImage(buf) {
    if (!sharpLib) {
        return buf.length <= 1.5 * 1024 * 1024 ? buf : null;
    }
    try {
        const img = sharpLib(buf, { failOn: 'none' });
        const meta = await img.metadata();
        const w = Number(meta.width) || 0;
        const h = Number(meta.height) || 0;
        if (w && h && Math.max(w, h) < SHOPPING_IMG_MIN_PIXELS) return null;
        return await img
            .rotate()
            .resize({
                width: SHOPPING_IMG_MAX_DIM,
                height: SHOPPING_IMG_MAX_DIM,
                fit: 'inside',
                withoutEnlargement: true,
            })
            .flatten({ background: '#ffffff' })
            .jpeg({ quality: 82, mozjpeg: true })
            .toBuffer();
    } catch (e) {
        return null;
    }
}

async function downloadAndResizeCandidate(url) {
    const buf = await downloadImageBuffer(url, SHOPPING_IMG_MAX_DOWNLOAD_BYTES, 6000);
    if (!buf || !buf.length) return null;
    const resized = await resizeProductImage(buf);
    if (!resized || !resized.length) return null;
    return resized;
}

async function fetchAndCacheShoppingImageInner(query, cachePath) {
    const candidates = await resolveShoppingImageCandidates(query, 6);
    if (!candidates.length) return false;

    // 前 4 个候选并发下载+压缩校验，取最先成功的一个；仍失败再尝试剩余候选，控制最坏情况耗时
    const firstBatch = candidates.slice(0, 4);
    const restBatch = candidates.slice(4);
    let winner = await raceFirstTruthy(firstBatch.map((u) => () => downloadAndResizeCandidate(u)));
    if (!winner && restBatch.length) {
        winner = await raceFirstTruthy(restBatch.map((u) => () => downloadAndResizeCandidate(u)));
    }
    if (!winner) return false;

    try {
        const tmpPath = cachePath + '.' + process.pid + '.tmp';
        fs.writeFileSync(tmpPath, winner);
        fs.renameSync(tmpPath, cachePath);
        return true;
    } catch (e) {
        console.warn('[购物图片] 写入缓存失败:', e && e.message);
        return false;
    }
}

/** 整体硬超时（含检索+下载+压缩全流程）：即便上游持续挂起也能按时释放并发名额，前端按时收到 404 回退占位图 */
function fetchAndCacheShoppingImage(query, cachePath) {
    return withHardTimeout(fetchAndCacheShoppingImageInner(query, cachePath), 16000, false);
}

function streamShoppingImageFile(res, filePath) {
    res.writeHead(200, {
        'Content-Type': 'image/jpeg',
        'Cache-Control': 'public, max-age=2592000, immutable',
        'Access-Control-Allow-Origin': '*',
    });
    fs.createReadStream(filePath).pipe(res);
}

async function handleShoppingImageRequest(req, res) {
    let q = '';
    let cat = '';
    try {
        const parsed = new URL(req.url, 'http://127.0.0.1');
        q = sanitizeShoppingImageQuery(parsed.searchParams.get('q'));
        cat = sanitizeShoppingImageQuery(parsed.searchParams.get('cat'));
    } catch (e) {
        q = '';
    }
    if (!q) {
        res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify({ error: 'missing q' }));
        return;
    }

    const searchQuery = (cat ? q + ' ' + cat : q) + ' 商品图 白底';
    const hash = shoppingImgHash(searchQuery);
    const cachePath = path.join(SHOPPING_IMG_CACHE_DIR, hash + '.jpg');

    try {
        if (fs.existsSync(cachePath)) {
            streamShoppingImageFile(res, cachePath);
            return;
        }

        const missUntil = shoppingImgMissCache.get(hash);
        if (missUntil && Date.now() < missUntil) {
            res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
            res.end();
            return;
        }

        let inFlight = shoppingImgInFlight.get(hash);
        if (!inFlight) {
            inFlight = withShoppingImgFetchSlot(() => fetchAndCacheShoppingImage(searchQuery, cachePath));
            shoppingImgInFlight.set(hash, inFlight);
            inFlight.finally(() => shoppingImgInFlight.delete(hash));
        }

        const ok = await inFlight;
        if (ok && fs.existsSync(cachePath)) {
            streamShoppingImageFile(res, cachePath);
            return;
        }
        shoppingImgMissCache.set(hash, Date.now() + SHOPPING_IMG_MISS_TTL_MS);
        res.writeHead(404, { 'Access-Control-Allow-Origin': '*' });
        res.end();
    } catch (e) {
        console.warn('[购物图片] 处理请求失败:', e && e.message);
        if (!res.headersSent) {
            res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
            res.end();
        }
    }
}

const MUSIC_SEARCH_API_URL = 'https://music-api.gdstudio.xyz/api.php';
const MUSIC_SEARCH_SOURCE = 'netease';
const MUSIC_SEARCH_MAX_RESULTS = 20;
const MUSIC_AUDIO_MAX_BYTES = 45 * 1024 * 1024;

function sendMusicJson(res, statusCode, payload) {
    res.writeHead(statusCode, {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(payload));
}

function requestMusicResource(target, maxBytes, timeoutMs, redirectsLeft, urlValidator) {
    return new Promise((resolve, reject) => {
        let targetObj;
        try {
            targetObj = new URL(target);
        } catch (e) {
            reject(new Error('音乐上游返回了无效地址'));
            return;
        }
        if (targetObj.protocol !== 'https:') {
            reject(new Error('音乐上游地址不是安全 HTTPS'));
            return;
        }
        if (typeof urlValidator === 'function' && !urlValidator(targetObj)) {
            reject(new Error('音乐上游地址未通过安全校验'));
            return;
        }
        const reqObj = https.get({
            protocol: targetObj.protocol,
            hostname: targetObj.hostname,
            port: targetObj.port || 443,
            path: targetObj.pathname + targetObj.search,
            family: 4,
            headers: {
                'User-Agent': 'LegoMiniphone/1.2 (music-search)',
                'Accept': '*/*',
                'Cache-Control': 'no-cache',
            },
        }, (upstreamRes) => {
            const status = Number(upstreamRes.statusCode) || 502;
            if (status >= 300 && status < 400 && upstreamRes.headers.location) {
                upstreamRes.resume();
                if (!(redirectsLeft > 0)) {
                    reject(new Error('音乐上游重定向次数过多'));
                    return;
                }
                const nextUrl = new URL(upstreamRes.headers.location, targetObj).toString();
                requestMusicResource(nextUrl, maxBytes, timeoutMs, redirectsLeft - 1, urlValidator).then(resolve, reject);
                return;
            }
            const declared = Number(upstreamRes.headers['content-length']) || 0;
            if (declared > maxBytes) {
                upstreamRes.resume();
                reject(new Error('音乐文件超过本地缓存大小限制'));
                return;
            }
            const chunks = [];
            let total = 0;
            upstreamRes.on('data', (chunk) => {
                total += chunk.length;
                if (total > maxBytes) {
                    upstreamRes.destroy(new Error('音乐文件超过本地缓存大小限制'));
                    return;
                }
                chunks.push(chunk);
            });
            upstreamRes.on('end', () => {
                resolve({
                    status,
                    headers: upstreamRes.headers,
                    body: Buffer.concat(chunks, total),
                    finalUrl: targetObj.toString(),
                });
            });
            upstreamRes.on('error', reject);
        });
        reqObj.setTimeout(timeoutMs, () => {
            reqObj.destroy(new Error('音乐上游请求超时'));
        });
        reqObj.on('error', reject);
    });
}

function isAllowedMusicSearchApiUrl(input) {
    try {
        const u = input instanceof URL ? input : new URL(input);
        return u.protocol === 'https:' &&
            u.hostname.toLowerCase() === 'music-api.gdstudio.xyz' &&
            u.pathname === '/api.php';
    } catch (e) {
        return false;
    }
}

function isAllowedNeteaseAudioUrl(input) {
    try {
        const u = input instanceof URL ? input : new URL(input);
        if (u.protocol !== 'https:') return false;
        const host = u.hostname.toLowerCase();
        return host === 'music.163.com' ||
            host.endsWith('.music.126.net') ||
            host.endsWith('.vod.126.net');
    } catch (e) {
        return false;
    }
}

async function handleMusicSearchRequest(req, res) {
    try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const title = String(requestUrl.searchParams.get('title') || '').trim().slice(0, 80);
        const artist = String(requestUrl.searchParams.get('artist') || '').trim().slice(0, 80);
        const limit = Math.max(1, Math.min(MUSIC_SEARCH_MAX_RESULTS, Number(requestUrl.searchParams.get('limit')) || MUSIC_SEARCH_MAX_RESULTS));
        const query = [title, artist].filter(Boolean).join(' ').trim();
        if (!query) {
            sendMusicJson(res, 400, { error: '请至少输入歌名或歌手名称' });
            return;
        }

        const params = new URLSearchParams({
            types: 'search',
            source: MUSIC_SEARCH_SOURCE,
            name: query,
            count: String(limit),
        });
        const upstream = await requestMusicResource(`${MUSIC_SEARCH_API_URL}?${params.toString()}`, 1024 * 1024, 20000, 2, isAllowedMusicSearchApiUrl);
        if (upstream.status < 200 || upstream.status >= 300) {
            sendMusicJson(res, 502, { error: `在线音乐服务暂时不可用（${upstream.status}）` });
            return;
        }
        let rows;
        try {
            rows = JSON.parse(upstream.body.toString('utf8'));
        } catch (e) {
            sendMusicJson(res, 502, { error: '在线音乐服务返回了无法识别的数据' });
            return;
        }
        if (!Array.isArray(rows)) rows = [];
        const seen = new Set();
        const results = [];
        rows.forEach((row) => {
            if (results.length >= limit || !row) return;
            const id = String(row.id || row.url_id || '').trim();
            const source = String(row.source || MUSIC_SEARCH_SOURCE).trim().toLowerCase();
            const titleText = String(row.name || '').trim();
            if (!/^\d{1,32}$/.test(id) || source !== MUSIC_SEARCH_SOURCE || !titleText || seen.has(id)) return;
            seen.add(id);
            const artists = Array.isArray(row.artist) ? row.artist : [row.artist];
            results.push({
                id,
                source,
                title: titleText.slice(0, 200),
                artist: artists.map(v => String(v || '').trim()).filter(Boolean).join(' / ').slice(0, 200) || '未知歌手',
                album: String(row.album || '').trim().slice(0, 200),
            });
        });
        sendMusicJson(res, 200, { results, provider: 'GD Music' });
    } catch (e) {
        console.warn('[音乐搜索] 请求失败:', e && e.message);
        sendMusicJson(res, 502, { error: e && e.message ? e.message : '在线音乐搜索失败' });
    }
}

async function handleMusicAudioRequest(req, res) {
    try {
        const requestUrl = new URL(req.url, 'http://127.0.0.1');
        const id = String(requestUrl.searchParams.get('id') || '').trim();
        const source = String(requestUrl.searchParams.get('source') || MUSIC_SEARCH_SOURCE).trim().toLowerCase();
        if (!/^\d{1,32}$/.test(id) || source !== MUSIC_SEARCH_SOURCE) {
            sendMusicJson(res, 400, { error: '歌曲标识无效' });
            return;
        }

        const params = new URLSearchParams({ types: 'url', source, id, br: '128' });
        const resolved = await requestMusicResource(`${MUSIC_SEARCH_API_URL}?${params.toString()}`, 128 * 1024, 20000, 2, isAllowedMusicSearchApiUrl);
        if (resolved.status < 200 || resolved.status >= 300) {
            sendMusicJson(res, 502, { error: `无法解析歌曲地址（${resolved.status}）` });
            return;
        }
        let info;
        try {
            info = JSON.parse(resolved.body.toString('utf8'));
        } catch (e) {
            sendMusicJson(res, 502, { error: '歌曲地址解析结果无效' });
            return;
        }
        const audioUrl = String(info && info.url || '').trim();
        const announcedSize = Number(info && info.size) || 0;
        if (!audioUrl) {
            sendMusicJson(res, 404, { error: '这首歌曲暂时没有可播放音源，请选择其他结果' });
            return;
        }
        if (!isAllowedNeteaseAudioUrl(audioUrl)) {
            sendMusicJson(res, 502, { error: '歌曲地址未通过安全校验' });
            return;
        }
        if (announcedSize > MUSIC_AUDIO_MAX_BYTES) {
            sendMusicJson(res, 413, { error: '这首歌曲超过 45MB 本地缓存上限' });
            return;
        }

        const audio = await requestMusicResource(audioUrl, MUSIC_AUDIO_MAX_BYTES, 90000, 3, isAllowedNeteaseAudioUrl);
        if (audio.status < 200 || audio.status >= 300) {
            sendMusicJson(res, 502, { error: `音频下载失败（${audio.status}）` });
            return;
        }
        const upstreamType = String(audio.headers['content-type'] || '').toLowerCase();
        const looksAudio = upstreamType.startsWith('audio/') ||
            upstreamType.includes('octet-stream') ||
            looksLikeMp3Magic(audio.body);
        if (!looksAudio || !audio.body.length) {
            sendMusicJson(res, 502, { error: '上游没有返回有效音频文件' });
            return;
        }
        res.writeHead(200, {
            'Content-Type': upstreamType.startsWith('audio/') ? upstreamType.split(';')[0] : 'audio/mpeg',
            'Content-Length': String(audio.body.length),
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff',
        });
        res.end(audio.body);
    } catch (e) {
        console.warn('[音乐缓存] 请求失败:', e && e.message);
        sendMusicJson(res, /超过.*限制/.test(String(e && e.message || '')) ? 413 : 502, {
            error: e && e.message ? e.message : '歌曲缓存失败',
        });
    }
}

const MIME_MAP = {
    '.html': 'text/html; charset=utf-8',
    '.css':  'text/css',
    '.js':   'application/javascript',
    '.json': 'application/json',
    '.png':  'image/png',
    '.jpg':  'image/jpeg',
    '.svg':  'image/svg+xml',
    '.ico':  'image/x-icon',
    '.map':  'application/json',
    '.ttf':  'font/ttf',
    '.otf':  'font/otf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
};

const SERVER_RUNTIME = Object.freeze({
    service: 'lego-miniphone',
    pid: process.pid,
    startedAt: new Date().toISOString(),
    revision: crypto.createHash('sha256').update(fs.readFileSync(__filename)).digest('hex').slice(0, 16),
    workspaceId: crypto.createHash('sha256').update(path.resolve(root).toLowerCase()).digest('hex').slice(0, 16),
});

function safeUpstreamEndpoint(input) {
    const u = new URL(input);
    return u.origin + u.pathname;
}

/** 总期限覆盖 DNS、连接和完整响应体；浏览器取消时立即释放上游连接。 */
function handleModelsListRequest(req, res, options = {}) {
    let finished = false, proxyReq = null, proxyRes = null, endpoint = '';
    const requestChunks = [];
    let requestBytes = 0;
    const deadline = setTimeout(() => {
        fail(504, proxyReq ? 'UPSTREAM_CONNECT_TIMEOUT' : 'REQUEST_TIMEOUT',
            proxyReq ? '模型列表请求超时（包含连接和响应读取），请稍后重试。' : '读取请求超时。', true, 'ETIMEDOUT');
    }, options.timeoutMs || 30000);

    function cleanup() {
        clearTimeout(deadline);
        if (proxyRes && !proxyRes.complete) proxyRes.destroy();
        if (proxyReq && !proxyReq.destroyed) proxyReq.destroy();
    }
    function send(status, body, source = 'local', retryAfter) {
        if (finished) return;
        finished = true;
        if (!res.destroyed && !res.headersSent) {
            const headers = {
                'Content-Type': 'application/json; charset=utf-8',
                'Cache-Control': 'no-store',
                'Access-Control-Allow-Origin': '*',
                'X-Lego-Proxy-Source': source,
                'X-Lego-Server-Pid': String(process.pid),
            };
            if (retryAfter) headers['Retry-After'] = retryAfter;
            res.writeHead(status, headers);
            res.end(body);
        }
        cleanup();
    }
    function fail(status, code, detail, retryable = false, networkCode = '') {
        send(status, JSON.stringify({ error: detail, code, networkCode, retryable,
            upstream: endpoint, servicePid: process.pid }));
    }
    function upstreamFailed(e) {
        if (finished) return;
        const code = classifyUpstreamError(e);
        const networkCode = e && e.code ? String(e.code) : '';
        const retryable = ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'EPIPE'].includes(networkCode);
        // 不打印 URL 查询串、Authorization 或上游响应体。
        console.warn('[模型列表] 上游连接失败:', networkCode || code, '| endpoint:', endpoint);
        fail(networkCode === 'ETIMEDOUT' ? 504 : 502, code, formatUpstreamError(e), retryable, networkCode);
    }
    res.on('close', () => { if (!finished) { finished = true; cleanup(); } });
    req.on('error', () => { if (!finished) { finished = true; cleanup(); } });
    req.on('data', chunk => {
        if (finished) return;
        requestBytes += chunk.length;
        if (requestBytes > 64 * 1024) {
            requestChunks.length = 0;
            fail(413, 'REQUEST_TOO_LARGE', '模型列表请求过大，请检查 API 地址和密钥。');
            return;
        }
        requestChunks.push(chunk);
    });
    req.on('end', () => {
        if (finished) return;
        let parsed;
        try { parsed = JSON.parse(bufferChunksToUtf8String(requestChunks)); }
        catch (_) { fail(400, 'INVALID_REQUEST_BODY', '请求必须是有效 JSON。'); return; }
        requestChunks.length = 0;
        const base = normalizeTargetBaseUrl(parsed && parsed.targetBaseUrl);
        if (!base) {
            fail(400, 'INVALID_TARGET_URL', 'API 地址必须是有效的 HTTP(S) 地址，且不能包含用户名或密码。');
            return;
        }
        const auth = normalizeProxyAuthorizationHeader(parsed && parsed.authorization);
        if (!auth.ok) { fail(400, auth.code, auth.message); return; }
        const apiUrl = new URL(buildOpenAICompatUrl(base, 'models'));
        endpoint = safeUpstreamEndpoint(apiUrl);
        const requestOptions = buildUpstreamRequestOptions(apiUrl, 'GET', { Authorization: auth.value });
        const requester = apiUrl.protocol === 'https:' ? https : http;
        try {
            proxyReq = (options.request || requester.request)(requestOptions, upstream => {
                proxyRes = upstream;
                if (finished) { upstream.destroy(); return; }
                const chunks = [];
                let size = 0;
                upstream.on('data', chunk => {
                    if (finished) return;
                    size += chunk.length;
                    if (size > 8 * 1024 * 1024) {
                        chunks.length = 0;
                        fail(502, 'UPSTREAM_RESPONSE_TOO_LARGE', '上游模型列表超过 8 MB，请检查 API 地址。');
                        return;
                    }
                    chunks.push(chunk);
                });
                upstream.on('error', upstreamFailed);
                upstream.on('close', () => {
                    if (!upstream.complete) upstreamFailed(Object.assign(new Error('上游响应未接收完整。'), { code: 'ECONNRESET' }));
                });
                upstream.on('end', () => {
                    if (finished) return;
                    if (!upstream.complete) { upstreamFailed(Object.assign(new Error('上游响应未接收完整。'), { code: 'ECONNRESET' })); return; }
                    const status = upstream.statusCode || 502;
                    // 不自动向重定向后的主机发送用户密钥。
                    if (status >= 300 && status < 400) {
                        fail(502, 'UPSTREAM_REDIRECT', '上游重定向了模型接口，请填写提供商给出的最终 API 地址。');
                        return;
                    }
                    send(status, bufferChunksToUtf8String(chunks), 'upstream', upstream.headers['retry-after']);
                });
            });
            proxyReq.on('error', upstreamFailed);
            proxyReq.end();
        } catch (e) { upstreamFailed(e); }
    });
}

const server = http.createServer((req, res) => {
    let urlPath = req.url.split('?')[0];

    // ── API 代理路由 ──────────────────────────────────────────────
    if (urlPath === '/api/health' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(SERVER_RUNTIME));
        return;
    }
    if (urlPath === '/api/music/search' && req.method === 'GET') {
        handleMusicSearchRequest(req, res);
        return;
    }

    if (urlPath === '/api/music/audio' && req.method === 'GET') {
        handleMusicAudioRequest(req, res);
        return;
    }

    if (urlPath === '/api/chat/completions' && req.method === 'POST') {
        const bodyChunks = [];
        req.on('data', (chunk) => { bodyChunks.push(chunk); });
        req.on('end', async () => {
            try {
                const body = bufferChunksToUtf8String(bodyChunks);
                const { targetBaseUrl, authorization, payload } = JSON.parse(body);
                const base = normalizeTargetBaseUrl(targetBaseUrl);
                if (!base) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ error: 'Invalid targetBaseUrl' }));
                    return;
                }

                const normalizedAuthorization = normalizeProxyAuthorizationHeader(authorization);
                if (!normalizedAuthorization.ok) {
                    res.writeHead(400, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
                    res.end(JSON.stringify({
                        error: normalizedAuthorization.message,
                        code: normalizedAuthorization.code,
                    }));
                    return;
                }

                const apiUrl = buildOpenAICompatUrl(base, 'chat/completions');
                const apiUrlObj = new URL(apiUrl);
                const requester = apiUrlObj.protocol === 'https:' ? https : http;
                const upstreamOpts = buildUpstreamRequestOptions(apiUrlObj, 'POST', {
                    'Content-Type': 'application/json',
                    Authorization: normalizedAuthorization.value,
                });
                let proxyResponded = false;
                function sendProxyClientOnce(statusCode, bodyStr, extraHeaders) {
                    if (proxyResponded || res.headersSent) return;
                    proxyResponded = true;
                    try {
                        const h = Object.assign(
                            { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
                            extraHeaders || {}
                        );
                        res.writeHead(statusCode, h);
                        res.end(bodyStr);
                    } catch (_) {}
                }

                const proxyReq = requester.request(upstreamOpts, (proxyRes) => {
                    proxyReq.setTimeout(0);
                    const resChunks = [];
                    proxyRes.on('data', (c) => { resChunks.push(c); });
                    proxyRes.on('end', () => {
                        const data = bufferChunksToUtf8String(resChunks);
                        sendProxyClientOnce(proxyRes.statusCode, data, {});
                    });
                });

                proxyReq.setTimeout(600000, () => {  // 10 分钟，兼容长 prompt（如心跳监控多段描写）与慢上游
                    console.log('[代理 /api/chat/completions] upstream TIMEOUT');
                    proxyReq.destroy();
                    sendProxyClientOnce(504, JSON.stringify({ error: 'Upstream timeout' }));
                });

                proxyReq.on('error', e => {
                    console.log('[代理 /api/chat/completions] upstream ERROR:', e.message);
                    sendProxyClientOnce(502, JSON.stringify({
                        error: 'Upstream error',
                        detail: formatUpstreamError(e),
                        upstream: apiUrl,
                    }));
                });

                // 注意：上游需要的是 OpenAI-compatible 的 payload，不是我们客户端包装的 body
                proxyReq.write(JSON.stringify(payload));
                proxyReq.end();
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // ── 模型列表代理路由 ──────────────────────────────────────────
    if (urlPath === '/api/models/list' && req.method === 'POST') {
        handleModelsListRequest(req, res);
        return;
    }

    // ── MiniMax 语音合成（T2A v2）代理路由 ────────────────────────
    if (urlPath === '/api/voice' && req.method === 'POST') {
        const bodyChunks = [];
        req.on('data', (chunk) => { bodyChunks.push(chunk); });
        req.on('end', async () => {
            try {
                const body = bufferChunksToUtf8String(bodyChunks);
                const parsedBody = JSON.parse(body);
                let apiKey =
                    parsedBody.apiKey != null ? String(parsedBody.apiKey).trim().replace(/^Bearer\s+/i, '').trim() : '';
                let groupIdRaw =
                    parsedBody.groupId != null ? String(parsedBody.groupId).trim().replace(/^Bearer\s+/i, '').trim() : '';
                const {
                    model,
                    text,
                    voice_id,
                    speed,
                    volume,
                    pitch,
                    language,
                } = parsedBody;

                const groupId = groupIdRaw;

                if (!apiKey || !groupId) {
                    res.writeHead(400);
                    res.end(JSON.stringify({ message: 'Missing apiKey or groupId' }));
                    return;
                }

                const upstreamUrl = minimaxT2aRequestUrl(groupId);
                let responded = false;
                function sendOnce(statusCode, bodyData, headers) {
                    if (responded || res.headersSent) return;
                    responded = true;
                    try {
                        res.writeHead(statusCode, Object.assign({
                            'Access-Control-Allow-Origin': '*',
                        }, headers || {}));
                        res.end(bodyData);
                    } catch (_) {}
                }

                const LANGUAGE_BOOST_MAP = {
                    zh: 'Chinese',
                    en: 'English',
                    ja: 'Japanese',
                    ko: 'Korean',
                    yue: 'Chinese,Yue',
                    de: 'German',
                    fr: 'French',
                    es: 'Spanish',
                    ru: 'Russian',
                };
                const language_boost = language && LANGUAGE_BOOST_MAP[language]
                    ? LANGUAGE_BOOST_MAP[language]
                    : 'auto';

                const postData = JSON.stringify(minimaxBuildT2aBody({
                    groupId,
                    model,
                    text,
                    stream: false,
                    output_format: 'hex',
                    language_boost,
                    voice_setting: {
                        voice_id: resolveMinimaxVoiceId(model, voice_id),
                        speed: speed != null ? speed : 1.0,
                        vol: volume != null ? volume : 1.0,
                        pitch: pitch != null ? pitch : 0,
                    },
                    audio_setting: {
                        sample_rate: 32000,
                        bitrate: 128000,
                        format: 'mp3',
                        channel: 1,
                    },
                }));

                const reqObj = https.request(upstreamUrl, {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': 'Bearer ' + apiKey,
                    },
                }, (upstreamRes) => {
                    reqObj.setTimeout(0);
                    const chunks = [];
                    upstreamRes.on('data', (chunk) => { chunks.push(chunk); });
                    upstreamRes.on('end', () => {
                        const raw = Buffer.concat(chunks);
                        const status = upstreamRes.statusCode;
                        const ct = (upstreamRes.headers['content-type'] || '').toLowerCase();

                        if (status !== 200) {
                            const rawStr = raw.toString('utf8');
                            console.log('[代理 /api/voice] 上游 HTTP', status, 'bodyHead=', rawStr.slice(0, 500));
                            let clientMsg = 'MiniMax HTTP ' + status;
                            try {
                                const ej = JSON.parse(rawStr);
                                const br = ej.base_resp;
                                if (br && br.status_msg) clientMsg = br.status_msg + ' (upstream HTTP ' + status + ')';
                                else if (ej.message) clientMsg = String(ej.message);
                            } catch (_) {}
                            sendOnce(status >= 400 && status < 600 ? status : 502, JSON.stringify({
                                message: clientMsg,
                                upstreamHttp: status,
                            }), { 'Content-Type': 'application/json; charset=utf-8' });
                            return;
                        }

                        if (ct.includes('audio/')) {
                            sendOnce(200, raw, {
                                'Content-Type': ct.includes('mpeg') || ct.includes('mp3') ? 'audio/mpeg' : upstreamRes.headers['content-type'],
                            });
                            return;
                        }

                        try {
                            const json = JSON.parse(raw.toString('utf8'));
                            const br = json.base_resp;
                            if (br && typeof br.status_code === 'number' && br.status_code !== 0) {
                                console.log('[代理 /api/voice] base_resp', br.status_code, br.status_msg);
                                sendOnce(502, JSON.stringify({
                                    message: br.status_msg || 'MiniMax T2A error',
                                    code: br.status_code,
                                }), { 'Content-Type': 'application/json; charset=utf-8' });
                                return;
                            }
                            const hex = json.data && json.data.audio;
                            if (!hex || typeof hex !== 'string') {
                                console.log('[代理 /api/voice] 缺 data.audio keys=', json.data ? Object.keys(json.data) : []);
                                sendOnce(502, JSON.stringify({ message: 'T2A 响应缺少 data.audio' }), {
                                    'Content-Type': 'application/json; charset=utf-8',
                                });
                                return;
                            }
                            const decoded = minimaxDecodeAudioPayload(hex, json);
                            if (decoded.error === 'url_output') {
                                sendOnce(502, JSON.stringify({ message: '当前代理仅支持 hex/base64 内联音频，请勿使用 output_format: url' }), {
                                    'Content-Type': 'application/json; charset=utf-8',
                                });
                                return;
                            }
                            if (decoded.error || !decoded.buffer || !decoded.buffer.length) {
                                sendOnce(502, JSON.stringify({ message: 'T2A 音频解码失败（非有效 hex/base64 mp3）' }), {
                                    'Content-Type': 'application/json; charset=utf-8',
                                });
                                return;
                            }
                            sendOnce(200, decoded.buffer, { 'Content-Type': 'audio/mpeg' });
                        } catch (e) {
                            sendOnce(502, JSON.stringify({ message: '解析 T2A 响应失败: ' + e.message }), {
                                'Content-Type': 'application/json; charset=utf-8',
                            });
                        }
                    });
                    upstreamRes.on('error', (e) => {
                        sendOnce(502, JSON.stringify({ message: '读取上游响应失败: ' + e.message }), {
                            'Content-Type': 'application/json; charset=utf-8',
                        });
                    });
                });

                reqObj.setTimeout(60000, () => {
                    console.log('[代理 /api/voice] upstream TIMEOUT');
                    reqObj.destroy();
                    sendOnce(504, JSON.stringify({ message: 'Upstream timeout' }));
                });

                reqObj.on('error', e => {
                    console.log('[代理 /api/voice] upstream ERROR:', e.message);
                    sendOnce(502, JSON.stringify({ message: 'Upstream error: ' + e.message }));
                });

                reqObj.write(postData);
                reqObj.end();
            } catch (e) {
                res.writeHead(400);
                res.end(JSON.stringify({ message: e.message }));
            }
        });
        return;
    }

    // ── 购物商品图片：搜索真实商品图 + 等比例压缩 + 落盘缓存 ─────────
    if (urlPath === '/api/shopping-image' && req.method === 'GET') {
        handleShoppingImageRequest(req, res);
        return;
    }

    // ── 全局字体代理（缓解外链 Referer/CORS 限制；无法绕过需登录的上游 403）──
    if (urlPath === '/api/font-proxy' && req.method === 'GET') {
        let target = '';
        try {
            target = new URL(req.url, 'http://127.0.0.1').searchParams.get('url') || '';
        } catch (_) {
            target = '';
        }
        if (!target || !/^https?:\/\//i.test(target) || !/\.ttf(\?|#|$)/i.test(target)) {
            res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
            res.end('Invalid font url');
            return;
        }
        let targetObj;
        try {
            targetObj = new URL(target);
        } catch (_) {
            res.writeHead(400, { 'Access-Control-Allow-Origin': '*' });
            res.end('Invalid font url');
            return;
        }
        const requester = targetObj.protocol === 'https:' ? https : http;
        const proxyReq = requester.get(target, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (compatible; LegoMiniphone/1.0)',
                'Referer': targetObj.origin + '/',
                'Accept': 'font/ttf,application/octet-stream,*/*',
            },
            timeout: 30000,
        }, (proxyRes) => {
            proxyReq.setTimeout(0);
            const status = proxyRes.statusCode || 502;
            if (status !== 200) {
                res.writeHead(status, { 'Access-Control-Allow-Origin': '*' });
                proxyRes.resume();
                res.end();
                return;
            }
            res.writeHead(200, {
                'Content-Type': 'font/ttf',
                'Access-Control-Allow-Origin': '*',
                'Cache-Control': 'private, max-age=86400',
            });
            proxyRes.pipe(res);
        });
        proxyReq.on('timeout', () => {
            proxyReq.destroy();
            if (!res.headersSent) {
                res.writeHead(504, { 'Access-Control-Allow-Origin': '*' });
                res.end();
            }
        });
        proxyReq.on('error', () => {
            if (!res.headersSent) {
                res.writeHead(502, { 'Access-Control-Allow-Origin': '*' });
                res.end();
            }
        });
        return;
    }

    // ── CORS 预检 & 通配 ──────────────────────────────────────────
    if (req.method === 'OPTIONS') {
        res.writeHead(204, {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        });
        res.end();
        return;
    }

    // ── 静态文件服务 ──────────────────────────────────────────────
    let fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
    try {
        if (fs.existsSync(fp)) {
            const ext  = path.extname(fp).toLowerCase();
            const mime = MIME_MAP[ext] || 'application/octet-stream';
            res.writeHead(200, { 'Content-Type': mime });
            fs.createReadStream(fp).pipe(res);
        } else {
            res.writeHead(404);
            res.end('Not found: ' + fp);
        }
    } catch (e) {
        res.writeHead(500);
        res.end(e.message);
    }
});

const DEFAULT_PORT = 1030;
const PORT = Number(process.env.PORT) || DEFAULT_PORT;
const HOST = typeof process.env.HOST === 'string' && process.env.HOST.trim()
    ? process.env.HOST.trim()
    : null;

function logListen() {
    console.log('');
    console.log('[Lego 小手机] 静态站 + API 代理已启动');
    console.log('  · 本机访问: http://127.0.0.1:' + PORT + '/');
    console.log('  · 或尝试: http://localhost:' + PORT + '/');
    if (!HOST) {
        console.log('  （默认在 :: 上双栈监听，缓解 Windows 下 localhost→IPv6 仅绑 IPv4 导致无法打开）');
    }
    console.log('  · 修改端口: 设置环境变量 PORT，例如 set PORT=3000 && npm start');
    console.log('');
}

server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
        console.error('');
        console.error('[Lego 小手机] 端口 ' + PORT + ' 已被占用，页面将无法打开。');
        console.error('  请关闭占用该端口的进程，或改用其他端口：');
        console.error('    Windows CMD:  set PORT=3000 && npm start');
        console.error('    PowerShell:   $env:PORT=3000; npm start');
        console.error('');
    } else {
        console.error('[Lego 小手机] 服务启动失败:', err);
    }
    process.exit(1);
});

if (require.main === module) {
    if (HOST) {
        server.listen(PORT, HOST, logListen);
    } else {
        server.listen({ port: PORT, host: '::', ipv6Only: false }, logListen);
    }
}

module.exports = { server, handleModelsListRequest, normalizeTargetBaseUrl, buildOpenAICompatUrl, classifyUpstreamError, SERVER_RUNTIME };
