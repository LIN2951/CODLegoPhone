// 全局变量
let currentPage = 'home';
let backgroundImage = null;
let globalAvatarImage = null;
let isReceiving = false; // 是否正在接收API响应
let receiveController = null; // AbortController用于取消API请求
// 好友 lastMessage 批量刷新：wechat-chat-pipeline.js（__pendingFriendUpdates / flushPendingFriendListMeta）
// 聊天记录内存：见 wechat-store.js（挂载 window.__chatHistoryMem / __chatHistoryPersistTimers）

/**
 * Token 最大输出量：默认 45000，最高 1M（可在「API 设置」中调整）。
 * 上下文窗口不等于输出上限；超出上游自身限额时仍会被上游拒绝并触发兼容下调重试。
 */
const API_MAX_OUTPUT_TOKENS_DEFAULT = 45000;
const API_MAX_OUTPUT_TOKENS_MAX = 1000000;
const API_WAIT_TIMEOUT_MINUTES_DEFAULT = 3;
const API_WAIT_TIMEOUT_MINUTES_MIN = 0.5;
const API_WAIT_TIMEOUT_MINUTES_MAX = 15;

function readApiSettingsRawForRuntime() {
    try {
        const o = JSON.parse(localStorage.getItem('apiSettings') || '{}');
        return o && typeof o === 'object' ? o : {};
    } catch (_) {
        return {};
    }
}

function resolveApiChatMaxTokens(settings) {
    const src = settings && typeof settings === 'object' ? settings : readApiSettingsRawForRuntime();
    const n = parseInt(src.maxOutputTokens, 10);
    if (!Number.isFinite(n) || n < 1) return API_MAX_OUTPUT_TOKENS_DEFAULT;
    return Math.min(n, API_MAX_OUTPUT_TOKENS_MAX);
}

/** 「等待上限时长」分钟数 → 毫秒；非法值回落默认 3 分钟，范围 [0.5, 15]。 */
function resolveApiWaitTimeoutMs(settings) {
    const src = settings && typeof settings === 'object' ? settings : readApiSettingsRawForRuntime();
    const n = parseFloat(src.waitTimeoutMinutes);
    const minutes = Number.isFinite(n) && n > 0 ? n : API_WAIT_TIMEOUT_MINUTES_DEFAULT;
    return Math.min(Math.max(minutes, API_WAIT_TIMEOUT_MINUTES_MIN), API_WAIT_TIMEOUT_MINUTES_MAX) * 60 * 1000;
}

function resolveApiStreamEnabled(settings) {
    const src = settings && typeof settings === 'object' ? settings : readApiSettingsRawForRuntime();
    return src.streamOutput === true || src.streamOutput === 'true';
}

/**
 * 将外部取消信号与「等待上限时长」合并为统一请求信号。
 * 返回 { controller, timedOut, timer }：timedOut=true 表示是超时而非用户取消。
 */
function combineAbortWithTimeout(externalController, timeoutMs) {
    const ctrl = new AbortController();
    const state = { controller: ctrl, timedOut: false, timer: null };
    const ms = Number(timeoutMs);
    if (Number.isFinite(ms) && ms > 0) {
        state.timer = setTimeout(function () {
            state.timedOut = true;
            try { ctrl.abort(); } catch (_) {}
        }, ms);
    }
    if (externalController && externalController.signal) {
        const s = externalController.signal;
        if (s.aborted) {
            try { ctrl.abort(); } catch (_) {}
        } else {
            s.addEventListener('abort', function () {
                try { ctrl.abort(); } catch (_) {}
            }, { once: true });
        }
    }
    return state;
}

/** 解析单个 SSE 事件块中的 data: 行，把 delta/message 片段累加进 acc。 */
function consumeChatCompletionSseEvent(rawEvent, acc) {
    const lines = String(rawEvent || '').split(/\r\n|\n|\r/);
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (!line || line.charAt(0) === ':' || line.indexOf('data:') !== 0) continue;
        const dataStr = line.slice(5).trim();
        if (!dataStr) continue;
        if (dataStr === '[DONE]') {
            acc.done = true;
            continue;
        }
        let json;
        try { json = JSON.parse(dataStr); } catch (_) { continue; }
        if (!json || typeof json !== 'object') continue;
        if (json.error) acc.error = json.error;
        if (json.usage) acc.usage = json.usage;
        const choice = Array.isArray(json.choices) ? json.choices[0] : null;
        if (!choice) continue;
        const delta = choice.delta || null;
        const piece =
            delta && typeof delta.content === 'string' ? delta.content :
            delta && Array.isArray(delta.content) ? delta.content.map(function (p) { return (p && (p.text || p.content)) || ''; }).join('') :
            !delta && choice.message && typeof choice.message.content === 'string' ? choice.message.content : '';
        if (piece) acc.content += piece;
        if (choice.finish_reason) acc.finishReason = choice.finish_reason;
    }
}

/** 把一整段 SSE 文本（或残缺的流）聚合为 chat.completion 兼容对象。 */
function parseChatCompletionStreamText(text) {
    const acc = { content: '', done: false, finishReason: null, usage: null, error: null };
    const events = String(text || '').split(/\r\n\r\n|\n\n|\r\r/);
    for (let i = 0; i < events.length; i++) {
        consumeChatCompletionSseEvent(events[i], acc);
    }
    return acc;
}

/**
 * 读取 chat/completions 响应：上游返回 SSE 则逐段聚合；
 * 若上游忽略了 stream 参数而返回普通 JSON，则按原样解析。
 * 返回结构与 response.json() 一致，调用方无需区分两种传输。
 */
async function readChatCompletionStream(response) {
    const contentType = String((response.headers && response.headers.get('content-type')) || '').toLowerCase();
    if (contentType.indexOf('text/event-stream') === -1) {
        return await response.json();
    }
    const acc = { content: '', done: false, finishReason: null, usage: null, error: null };
    if (!response.body || typeof response.body.getReader !== 'function') {
        // 老 WebView 无 ReadableStream：退化为整体读取后按 SSE 文本解析
        const whole = await response.text();
        const parsed = parseChatCompletionStreamText(whole);
        Object.assign(acc, parsed);
    } else {
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        let buffer = '';
        while (true) {
            const r = await reader.read();
            if (r.done) break;
            buffer += decoder.decode(r.value, { stream: true });
            let m;
            const sep = /\r\n\r\n|\n\n|\r\r/g;
            let lastEnd = 0;
            while ((m = sep.exec(buffer)) !== null) {
                consumeChatCompletionSseEvent(buffer.slice(lastEnd, m.index), acc);
                lastEnd = m.index + m[0].length;
            }
            buffer = buffer.slice(lastEnd);
        }
        buffer += decoder.decode();
        if (buffer.trim()) consumeChatCompletionSseEvent(buffer, acc);
    }
    if (acc.error) {
        const em = typeof acc.error === 'object' && acc.error && acc.error.message != null
            ? String(acc.error.message)
            : String(acc.error);
        throw new Error('上游流式返回错误: ' + em);
    }
    return {
        choices: [{
            message: { role: 'assistant', content: acc.content },
            finish_reason: acc.finishReason || 'stop'
        }],
        usage: acc.usage || undefined
    };
}

/** 从常见上游 400 文案中提取实际允许的最大输出 token；仅用于参数校验失败后的无计费兼容重试。 */
function parseSupportedMaxOutputTokens(detailText) {
    const detail = String(detailText || '');
    let match = detail.match(/supported range[\s\S]*?to\s+([\d,]+)\s*\(exclusive\)/i);
    if (match) return Math.max(1, Number(match[1].replace(/,/g, '')) - 1);
    match = detail.match(/(?:less than or equal to|at most|maximum(?: allowed)?(?: is|:))\s*([\d,]+)/i);
    if (match) return Math.max(1, Number(match[1].replace(/,/g, '')));
    match = detail.match(/(?:must be less than|below)\s+([\d,]+)/i);
    if (match) return Math.max(1, Number(match[1].replace(/,/g, '')) - 1);
    return 0;
}

// 运行时错误可视化（避免“按钮没反应但其实报错了”）
try {
    const describeLzKeys = () => {
        try {
            const keys = Object.keys(localStorage || {});
            const lz = [];
            for (let i = 0; i < keys.length; i++) {
                const k = keys[i];
                const v = localStorage.getItem(k);
                if (typeof v === 'string' && v.startsWith('LZUTF16:')) {
                    lz.push(k);
                    if (lz.length >= 12) break;
                }
            }
            return lz.length ? `\n\n检测到压缩存储的 key: ${lz.join(', ')}` : '';
        } catch (e) {
            return '';
        }
    };

    /** 来自浏览器扩展注入脚本的全局错误不应弹窗（否则会误判为站点故障）。 */
    const isBrowserExtensionScriptUrl = (url) => {
        if (!url || typeof url !== 'string') return false;
        return /^[a-z-]+-extension:/i.test(url.trim());
    };
    const errorEventFromExtension = (ev) => {
        if (isBrowserExtensionScriptUrl(ev?.filename)) return true;
        const stack = ev?.error?.stack ? String(ev.error.stack) : '';
        return stack ? /-extension:\/\//i.test(stack) : false;
    };
    const rejectionFromExtension = (ev) => {
        const r = ev?.reason;
        const stack = r && typeof r.stack === 'string' ? r.stack : '';
        const msg = r && r.message != null ? String(r.message) : String(r || '');
        const combined = stack + '\n' + msg;
        if (/-extension:\/\//i.test(combined)) return true;
        if (/Receiving end does not exist/i.test(msg)) return true;
        return false;
    };

    window.addEventListener('error', (ev) => {
        if (errorEventFromExtension(ev)) {
            try { console.debug('[Lego] 已忽略浏览器扩展脚本报错:', ev?.message || ev?.error); } catch (e) {}
            return;
        }
        const msg = ev?.error?.message || ev?.message || '未知错误';
        const stack = ev?.error?.stack ? `\n\n${ev.error.stack}` : '';
        const extra = String(msg || '').includes('LZUTF16') ? describeLzKeys() : '';
        try { showErrorDialog('运行错误', String(msg) + extra + stack); } catch (e) {}
    });
    window.addEventListener('unhandledrejection', (ev) => {
        if (rejectionFromExtension(ev)) {
            try { console.debug('[Lego] 已忽略扩展相关未捕获 Promise:', ev?.reason); } catch (e) {}
            return;
        }
        const msg = ev?.reason?.message || ev?.reason || '未知错误';
        const stack = ev?.reason?.stack ? `\n\n${ev.reason.stack}` : '';
        const extra = String(msg || '').includes('LZUTF16') ? describeLzKeys() : '';
        try { showErrorDialog('运行错误', String(msg) + extra + stack); } catch (e) {}
    });
} catch (e) {}

/**
 * 将存储中的头像字段规范为可用的图片 URL。
 * 空串、纯空白、占位符 __SYS_UNSET__ 视为无头像（避免浏览器请求 /__SYS_UNSET__ 导致 404）。
 */
function normalizeAvatarUrl(value) {
    if (value == null) return '';
    var s = String(value).trim();
    if (!s || s === '__SYS_UNSET__') return '';
    if (s.startsWith('url(') && s.endsWith(')')) {
        s = s.slice(4, -1).trim();
        if (
            (s.startsWith('"') && s.endsWith('"')) ||
            (s.startsWith("'") && s.endsWith("'"))
        ) {
            s = s.slice(1, -1).trim();
        }
    }
    if (!s || s === '__SYS_UNSET__') return '';
    // 协议相对 URL（//host/...）在 file:// 或部分 WebView 下无法作为图片地址加载，统一为 https
    if (/^\/\//.test(s)) {
        s = 'https:' + s;
    }
    return s;
}

function getFirstUsableAvatarUrl() {
    for (var i = 0; i < arguments.length; i++) {
        var url = normalizeAvatarUrl(arguments[i]);
        if (url) return url;
    }
    return '';
}

function getFriendDisplayAvatar(friend) {
    if (!friend) return '';
    return getFirstUsableAvatarUrl(friend.avatar, friend.persona && friend.persona.avatar);
}

/**
 * 群聊 API 返回的 speakerId 有时与好友 id 不一致（误填昵称、引号、Unicode 变体等）。
 * 在群 memberIds 范围内解析为真实成员对象，供头像/昵称展示与落盘 id 规范化。
 */
function resolveGroupChatSpeakerMember(speakerId, groupFriend, allFriends) {
    if (!groupFriend || !groupFriend.isGroup) return null;
    var raw = speakerId != null ? String(speakerId).trim() : '';
    if (!raw) return null;
    raw = raw.replace(/^[\s"'「」]+|[\s"'」]+$/g, '');
    var list = Array.isArray(allFriends) ? allFriends : [];
    var findById = function (id) {
        return list.find(function (f) {
            return f && String(f.id) === String(id);
        });
    };
    var memberIdSet = {};
    var mids = Array.isArray(groupFriend.memberIds) ? groupFriend.memberIds.map(String) : [];
    for (var z = 0; z < mids.length; z++) memberIdSet[mids[z]] = true;
    var cand = findById(raw);
    if (cand && !cand.isGroup && memberIdSet[String(cand.id)]) return cand;
    var normKey = function (s) {
        var t = String(s || '')
            .trim()
            .toLowerCase();
        try {
            t = t.normalize('NFKC');
        } catch (eNorm) {}
        return t.replace(/\s+/g, '');
    };
    var rawKey = normKey(raw);
    for (var i = 0; i < mids.length; i++) {
        var mf = findById(mids[i]);
        if (!mf || mf.isGroup) continue;
        var names = [mf.remark, mf.nickname, mf.persona && mf.persona.nickname, mf.persona && mf.persona.name];
        for (var j = 0; j < names.length; j++) {
            var nk = normKey(names[j]);
            if (nk && nk === rawKey) return mf;
        }
    }
    if (rawKey.length >= 2) {
        for (var a = 0; a < mids.length; a++) {
            var mf2 = findById(mids[a]);
            if (!mf2 || mf2.isGroup) continue;
            var names2 = [mf2.remark, mf2.nickname, mf2.persona && mf2.persona.nickname, mf2.persona && mf2.persona.name];
            for (var b = 0; b < names2.length; b++) {
                var nk2 = normKey(names2[b]);
                if (!nk2 || nk2.length < 2) continue;
                if (nk2 === rawKey || nk2.indexOf(rawKey) >= 0 || rawKey.indexOf(nk2) >= 0) return mf2;
            }
        }
    }
    return null;
}

/** 用户上传位图：JPEG / PNG / GIF（与各 file input 的 accept 一致；部分环境 MIME 为空时按扩展名识别） */
var LEGO_UPLOAD_IMAGE_ACCEPT = 'image/jpeg,image/jpg,image/png,image/gif,.jpg,.jpeg,.png,.gif';

function isLegoUploadableRasterImageFile(file) {
    if (!file) return false;
    var t = (file.type || '').trim().toLowerCase();
    if (
        t === 'image/jpeg' ||
        t === 'image/jpg' ||
        t === 'image/pjpeg' ||
        t === 'image/png' ||
        t === 'image/gif' ||
        t === 'image/x-png'
    ) {
        return true;
    }
    var name = (file.name || '').toLowerCase();
    return /\.(jpe?g|png|gif)$/i.test(name);
}

/**
 * 合并「个人资料 userInfo」与「我的人设 myProfile」用于「微信-我」页与全局昵称/头像展示。
 * 人设中非空的昵称、头像优先（与聊天侧人设数据源一致）。
 */
function getEffectiveWechatMeProfileForDisplay() {
    const userInfo = safeReadJsonFromStorage('userInfo', null);
    const myProfile = safeReadJsonFromStorage('myProfile', null);
    const base =
        userInfo && typeof userInfo === 'object'
            ? {
                nickname: userInfo.nickname,
                avatar: userInfo.avatar,
                wechatId: (userInfo.wechatId != null && String(userInfo.wechatId).trim())
                    ? String(userInfo.wechatId).trim()
                    : 'wx_id_...'
            }
            : { nickname: '可点击编辑', avatar: '', wechatId: 'wx_id_...' };
    if (myProfile && typeof myProfile === 'object') {
        const mn = String(myProfile.nickname != null ? myProfile.nickname : '').trim();
        if (mn) base.nickname = myProfile.nickname;
        if (normalizeAvatarUrl(myProfile.avatar)) base.avatar = myProfile.avatar;
    }
    return base;
}

// 音乐播放器
const MAX_MUSIC_SIZE_MB = 45;
const MusicPlayer = {
    playlist: [],
    currentIndex: -1,
    audio: null,
    isPlaying: false,
    repeat: 0, // 0=关闭 1=单曲 2=全部
    customCover: null, // 用户上传的封面图
    volume: 1,
    get currentTrack() {
        return this.playlist[this.currentIndex] || null;
    }
};

// 推特存储层常量（twitter-store.js 为唯一来源；collectTwitterData 等早于推特 UI 段落的代码会引用）
var TWITTER_FEEDS_LS_KEY = Twitter.store.TWITTER_FEEDS_LS_KEY;
var TWITTER_PROFILE_LS_KEY = Twitter.store.TWITTER_PROFILE_LS_KEY;
var TWITTER_FOLLOWING_IDS_LS_KEY = Twitter.store.TWITTER_FOLLOWING_IDS_LS_KEY;
var TWITTER_DETAIL_USER_EXTRA_LS_KEY = Twitter.store.TWITTER_DETAIL_USER_EXTRA_LS_KEY;
var TWITTER_FRIEND_HANDLE_PREFIX = Twitter.store.TWITTER_FRIEND_HANDLE_PREFIX;

// 指令管理系统
const CommandManager = {
    /**
     * fetch 失败时用于补全本地缺失的随附指令（与 system_commands.json 中对应 id 一致）
     */
    _BUNDLED_MISSING_PATCH: [],

    /** 将文件中存在而本地没有的指令（按 id）追加到本地，保留用户已有条目与自定义指令 */
    mergeMissingCommandsFromFile: function (local, file) {
        const fileArr = Array.isArray(file) ? file : [];
        let localArr = Array.isArray(local) ? local.slice() : [];
        if (fileArr.length === 0) return localArr;
        if (localArr.length === 0) {
            return fileArr.map(function (c) { return Object.assign({}, c); });
        }
        const existing = new Set();
        localArr.forEach(function (c) {
            if (c && c.id != null) existing.add(String(c.id));
        });
        fileArr.forEach(function (cmd) {
            if (!cmd || cmd.id == null) return;
            var k = String(cmd.id);
            if (existing.has(k)) return;
            localArr.push(Object.assign({}, cmd));
            existing.add(k);
        });
        return localArr;
    },

    /**
     * 用随附 system_commands.json 中同 id 条目的 name/content/active 覆盖本地已有项，
     * 便于无法打开系统页时仍可通过改仓库内 JSON 更新规范正文（本地单独新增的 id 不受影响）。
     */
    syncExistingCommandsContentFromFile: function (localArr, fileArr) {
        const fileById = new Map();
        (Array.isArray(fileArr) ? fileArr : []).forEach(function (c) {
            if (c && c.id != null) fileById.set(String(c.id), c);
        });
        if (fileById.size === 0) return localArr;
        return (Array.isArray(localArr) ? localArr : []).map(function (loc) {
            if (!loc || loc.id == null) return loc;
            // 用户在系统页改过的指令必须以本地为准，避免每次 loadCommandList 都被 system_commands.json 覆盖回滚
            if (loc.userEditedAt != null || loc.userEdited === true) return loc;
            const f = fileById.get(String(loc.id));
            if (!f) return loc;
            const o = Object.assign({}, loc);
            if (f.name != null) o.name = f.name;
            if (f.content != null) o.content = f.content;
            if (f.active !== undefined) o.active = f.active;
            return o;
        });
    },

    // 同步指令到工作区文件：需自行实现 POST /api/commands；默认不请求，避免静态/本仓库 http 服务无此路由时在控制台出现 404
    // 需要写回时在控制台执行：localStorage.setItem('commandsFileSyncEnabled','1')
    syncCommandsToFile: async function(commands) {
        try {
            if (localStorage.getItem('commandsFileSyncEnabled') !== '1') {
                return false;
            }
        } catch (_) {
            return false;
        }
        try {
            const response = await fetch('/api/commands', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json; charset=utf-8'
                },
                body: JSON.stringify(commands)
            });
            return response.ok;
        } catch (error) {
            return false;
        }
    },
    
    // 从文件加载指令到localStorage（与本地合并：仅追加文件中多出的 id，不覆盖用户已有指令）
    loadCommandsFromFile: async function() {
        var mergeAndSave = function (fileCommands) {
            var local = [];
            try {
                local = JSON.parse(localStorage.getItem('systemCommands') || '[]');
            } catch (e) {
                local = [];
            }
            var merged = CommandManager.mergeMissingCommandsFromFile(local, fileCommands);
            merged = CommandManager.syncExistingCommandsContentFromFile(merged, fileCommands);
            localStorage.setItem('systemCommands', JSON.stringify(merged));
            console.log('已合并系统指令，本地条数:', local.length, '合并后:', merged.length);
            return merged;
        };

        // 带超时的 fetch（避免 API 端点不存在时长时间阻塞）
        var fetchWithTimeout = function (url, ms) {
            var timer;
            return Promise.race([
                fetch(url),
                new Promise(function (_, reject) {
                    timer = setTimeout(function () {
                        reject(new Error('fetch timeout'));
                    }, ms);
                })
            ]).finally(function () { clearTimeout(timer); });
        };

        try {
            console.log('开始从文件加载指令');
            const response = await fetch('system_commands.json');
            console.log('本地文件响应状态:', response.status);
            if (response.ok) {
                const commands = await response.json();
                console.log('从本地文件获取的指令数量:', commands.length);
                const merged = mergeAndSave(commands);
                const patched = CommandManager.mergeMissingCommandsFromFile(merged, CommandManager._BUNDLED_MISSING_PATCH);
                try {
                    localStorage.setItem('systemCommands', JSON.stringify(patched));
                } catch (e) {
                    console.error('合并内置指令补丁失败:', e);
                }
                return patched;
            }
        } catch (error) {
            console.error('从本地文件加载指令失败:', error);
            try {
                // API 端点最多等 4 秒，不存在则快速降级
                const response = await fetchWithTimeout('/api/commands', 4000);
                console.log('API响应状态:', response.status);
                if (response.ok) {
                    const commands = await response.json();
                    console.log('从API获取的指令数量:', commands.length);
                    const merged = mergeAndSave(commands);
                    const patched = CommandManager.mergeMissingCommandsFromFile(merged, CommandManager._BUNDLED_MISSING_PATCH);
                    try {
                        localStorage.setItem('systemCommands', JSON.stringify(patched));
                    } catch (e) {
                        console.error('合并内置指令补丁失败:', e);
                    }
                    return patched;
                }
            } catch (apiError) {
                console.error('从API加载指令失败（4s超时）:', apiError && apiError.message);
            }
        }
        // 离线或无法读取 JSON：用内嵌补丁补全缺失项（当前为空则跳过）
        var prevArr = [];
        try {
            prevArr = JSON.parse(localStorage.getItem('systemCommands') || '[]');
            if (!Array.isArray(prevArr)) prevArr = [];
        } catch (e) {
            prevArr = [];
        }
        var patched = CommandManager.mergeMissingCommandsFromFile(prevArr, CommandManager._BUNDLED_MISSING_PATCH);
        try {
            localStorage.setItem('systemCommands', JSON.stringify(patched));
        } catch (e) {
            console.error('补丁合并系统指令失败:', e);
        }
        return patched;
    },
    
    // 获取所有指令
    getAllCommands: function() {
        try {
            const storedCommands = localStorage.getItem('systemCommands');
            if (storedCommands) {
                const commands = JSON.parse(storedCommands);
                // 如果指令为空，返回硬编码的默认指令
                if (commands && commands.length > 0) {
                    return commands;
                }
            }
        } catch (e) {
            console.error('解析系统指令失败:', e);
        }
        // 如果localStorage中没有指令或解析失败，返回硬编码的默认指令
        return DEFAULT_SYSTEM_COMMANDS;
    },
    
    // 获取激活的指令
    getActiveCommands: function() {
        const commands = this.getAllCommands();
        return commands.filter(cmd => cmd.active);
    },
    
    // 获取核心指令
    getCoreCommands: function() {
        const commands = this.getAllCommands();
        return commands.filter(cmd => cmd.name === '核心指令' && cmd.active);
    },
    
    // 切换指令状态
    toggleCommandStatus: function(commandId) {
        const commands = this.getAllCommands();
        const commandIndex = commands.findIndex(cmd => cmd.id == commandId);
        
        if (commandIndex !== -1) {
            commands[commandIndex].active = !commands[commandIndex].active;
            localStorage.setItem('systemCommands', JSON.stringify(commands));
            // 确保同步到文件
            this.syncCommandsToFile(commands).then(success => {
                console.log('切换指令状态同步到文件:', success);
                // 重新加载指令列表
                loadCommandList();
            });
            showNotification(`指令已${commands[commandIndex].active ? '激活' : '停用'}`);
        }
    },
    
    // 保存指令
    saveCommand: function(commandName, commandContent, commandId = null) {
        const commands = this.getAllCommands();
        
        if (commandId) {
            // 更新现有指令
            const commandIndex = commands.findIndex(cmd => cmd.id == commandId);
            if (commandIndex !== -1) {
                commands[commandIndex].name = commandName;
                commands[commandIndex].content = commandContent;
                commands[commandIndex].userEdited = true;
                commands[commandIndex].userEditedAt = Date.now();
                localStorage.setItem('systemCommands', JSON.stringify(commands));
                // 确保同步到文件
                this.syncCommandsToFile(commands).then(success => {
                    console.log('更新指令同步到文件:', success);
                    // 关闭模态框
                    closeAddCommandModal();
                    // 更新指令列表
                    loadCommandList();
                });
                showNotification('指令已更新');
            }
        } else {
            // 创建新指令
            const newCommand = {
                id: Date.now(),
                name: commandName,
                content: commandContent,
                createdAt: new Date().getTime(),
                active: true,
                userEdited: true,
                userEditedAt: Date.now()
            };
            
            commands.push(newCommand);
            localStorage.setItem('systemCommands', JSON.stringify(commands));
            // 确保同步到文件
            this.syncCommandsToFile(commands).then(success => {
                console.log('新建指令同步到文件:', success);
                // 关闭模态框
                closeAddCommandModal();
                // 更新指令列表
                loadCommandList();
            });
            showNotification('命令保存并执行成功');
            
            // 执行命令
            this.executeCommand(commandContent);
        }
    },
    
    // 执行命令
    executeCommand: function(commandContent) {
        // 解析命令内容并执行相应的功能
        if (commandContent.includes('允许后台运行小手机')) {
            // 激活后台运行功能
            enableBackgroundMode();
        }
        // 可以添加更多命令解析逻辑
    },
    
    // 构建发送内容（按照优先级顺序）
    buildSendContent: function(functionalContent) {
        const content = [];
        
        // 1. 添加核心指令（最高优先级）
        const coreCommands = this.getCoreCommands();
        coreCommands.forEach(cmd => {
            content.push(cmd.content);
        });
        
        // 2. 添加功能相关内容（包含好友角色卡信息、用户身份设定信息、聊天历史记录）
        if (functionalContent) {
            content.push(functionalContent);
        }
        
        // 3. 添加其他激活的指令（功能指令）
        const activeCommands = this.getActiveCommands().filter(cmd => cmd.name !== '核心指令');
        activeCommands.forEach(cmd => {
            content.push(cmd.content);
        });
        
        return content.join('\n');
    },

    // 微信提示词拼装：见 wechat-prompts.js（Wechat.prompts）
    _clampInt: function (v, min, max, fallback) {
        return Wechat.prompts._clampInt(v, min, max, fallback);
    },
    _buildRoundsFromChatHistory: function (chatHistory) {
        return Wechat.prompts._buildRoundsFromChatHistory(chatHistory);
    },
    _formatHistoryLines: function (rounds, maxRounds, fmt, options) {
        return Wechat.prompts._formatHistoryLines(rounds, maxRounds, fmt, options);
    },
    _extractGroupChatMessagesFromApiText: function (text) {
        return Wechat.prompts._extractGroupChatMessagesFromApiText(text);
    },
    buildWechatSendContent: function(friendId, message, options) {
        return Wechat.prompts.buildWechatSendContent(friendId, message, options);
    },
    buildListenTogetherSendContent: function (friendId, songName, artist, lyrics) {
        return Wechat.prompts.buildListenTogetherSendContent(friendId, songName, artist, lyrics);
    },
    buildLocationShareSendContent: function (friendId, locationText) {
        return Wechat.prompts.buildLocationShareSendContent(friendId, locationText);
    },
    buildPhotoCardSendContent: function (friendId, descriptionText) {
        return Wechat.prompts.buildPhotoCardSendContent(friendId, descriptionText);
    },
    buildTransferReceiveSendContent: function (friendId, amount) {
        return Wechat.prompts.buildTransferReceiveSendContent(friendId, amount);
    },
    buildGiftBundleReceiveSendContent: function (friendId, giftItems) {
        return Wechat.prompts.buildGiftBundleReceiveSendContent(friendId, giftItems);
    },
    buildCoupleSpaceInviteDecisionSendContent: function (friendId, invitePayload) {
        return Wechat.prompts.buildCoupleSpaceInviteDecisionSendContent(friendId, invitePayload);
    },
    buildKinshipTakeoutUsageNotifySendContent: function (friendId, usagePayload) {
        return Wechat.prompts.buildKinshipTakeoutUsageNotifySendContent(friendId, usagePayload);
    },
    buildLoveTakeoutOrderNotifySendContent: function (friendId, orderPayload) {
        return Wechat.prompts.buildLoveTakeoutOrderNotifySendContent(friendId, orderPayload);
    },
    buildLoveTakeoutReceiveAckSendContent: function (friendId, ackPayload) {
        return Wechat.prompts.buildLoveTakeoutReceiveAckSendContent(friendId, ackPayload);
    },
    buildLoveTakeoutMenuRefreshSendContent: function (friendId) {
        return Wechat.prompts.buildLoveTakeoutMenuRefreshSendContent(friendId);
    },
    buildCoupleDiaryCharReplySendContent: function (friendId, diaryPayload) {
        return Wechat.prompts.buildCoupleDiaryCharReplySendContent(friendId, diaryPayload);
    },
    buildMissingDistanceCalculateSendContent: function (friendId, locationPayload) {
        return Wechat.prompts.buildMissingDistanceCalculateSendContent(friendId, locationPayload);
    },
    buildMissingDistanceReceiveSendContent: function (friendId, chatPayload) {
        return Wechat.prompts.buildMissingDistanceReceiveSendContent(friendId, chatPayload);
    },
    buildMissingDistanceSummarizeSendContent: function (friendId, summaryPayload) {
        return Wechat.prompts.buildMissingDistanceSummarizeSendContent(friendId, summaryPayload);
    },
};
if (typeof window !== 'undefined') window.CommandManager = CommandManager;

// 心跳监控模块：见 wechat-heartbeat.js（Wechat.heartbeat / HeartbeatMonitor）

/**
 * 配置的 API 与当前页面是否跨源（跨源时浏览器会拦 CORS，需经本机 server.js 同源代理）
 */
function apiUrlNeedsLocalProxy(apiUrlStr) {
    try {
        const loc = window.location;
        if (!loc.origin || loc.origin === 'null') return false;
        const target = new URL(apiUrlStr);
        return target.origin !== loc.origin;
    } catch (e) {
        return false;
    }
}

/**
 * 构建 OpenAI 兼容 chat/completions 请求：跨源则 POST 到 /api/chat/completions 由 Node 转发
 */
function buildOpenAiChatFetch(settings, requestData, controller) {
    const base = (settings.apiUrl || '').trim();
    const bearer = `Bearer ${normalizeApiKeyForBearer(settings.apiKey || '')}`;
    const options = {
        method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
        body: JSON.stringify(requestData),
        cache: 'no-store',
    };
    if (controller && controller.signal) {
        options.signal = controller.signal;
    }

    if (apiUrlNeedsLocalProxy(base)) {
        const normalized = base.endsWith('/') ? base : base + '/';
        options.body = JSON.stringify({
            targetBaseUrl: normalized,
            authorization: bearer,
            payload: requestData,
        });
        // 使用相对路径，保证与当前页面主机一致（避免 127.0.0.1 / localhost 混用）
        return { url: '/api/chat/completions', options };
    }

    let apiUrl = base.endsWith('/') ? base : base + '/';
    apiUrl += 'v1/chat/completions';
    options.headers = {
        Authorization: bearer,
        'Content-Type': 'application/json',
    };
    options.body = JSON.stringify(requestData);
    return { url: apiUrl, options };
}

/**
 * 根据 HTTP 状态与上游返回文案，拼接面向用户的中文排障提示（与截图中 502/503 场景对齐）。
 */
function getApiErrorUserHint(status, detailText) {
    const d = String(detailText || '');
    const dl = d.toLowerCase();
    const parts = [];
    if (status === 502 || status === 504) {
        if (/eacces|eperm|upstream_connect_denied|出站连接被.*拒绝/i.test(d)) {
            parts.push(
                '【说明】本地 node server.js 进程被系统或当前运行环境阻止访问外网；请求尚未到达 API 上游，这不是余额不足造成的。'
            );
            parts.push(
                '【处理】关闭当前服务后，在普通 PowerShell 或“启动服务.bat”中重新启动；并确认防火墙、VPN/TUN 允许 node.exe 访问 HTTPS。'
            );
        } else {
            parts.push(
                '【说明】502/504 多为网关或本地代理（node server.js）访问上游 API 时失败。'
            );
            parts.push(
                '【可尝试】① 检查网络/VPN；② 确认 API 设置里的地址与密钥有效；③ 查看运行 server 的终端是否有报错；④ 稍后重试。'
            );
        }
    }
    if (status === 503) {
        if (/无可用渠道/.test(d) || /distributor|no available channel/i.test(dl)) {
            parts.push(
                '【说明】当前所选模型在中转站暂无可用线路（渠道）。'
            );
            parts.push('【可尝试】在「API 设置」中更换其他模型或分组，或联系服务商检查渠道配置。');
        } else {
            parts.push('【说明】服务暂时不可用，可能是上游过载或维护。');
            parts.push('【可尝试】稍后重试或更换模型/API 端点。');
        }
    }
    if (status === 429) {
        parts.push('【说明】触发限流。这是你的 API 提供商（模型服务）繁忙或额度不足，与本小手机系统无关。');
        parts.push('【可尝试】① 等待几秒后重试；② 降低请求频率（减少连续快速操作）；③ 检查 API 账号额度或套餐是否用完；④ 稍后换用其他模型或分组。');
    }
    if (
        (status === 200 && /no capacity|no available|rate limit|too many requests|quota exceeded|模型不可用|无可用容量/i.test(dl)) ||
        (status === 0 && /failed to fetch|network error/i.test(dl))
    ) {
        if (parts.length === 0) {
            parts.push('【说明】模型服务不可用。这是你的 API 提供商（模型服务）繁忙或额度不足，与本小手机系统无关。');
            parts.push('【可尝试】① 等待几秒后重试；② 检查 API 额度；③ 换用其他模型或分组。');
        }
    }
    if (status === 524) {
        parts.push(
            '【说明】524 多为网关/上游在等待模型输出时超时（生成长内容或排队过久）。'
        );
        parts.push(
            '【可尝试】① 已自动重试；若仍失败可再点刷新；② 换更快模型或提高上游超时；③ 减少单次生成量（娱乐时间轴已改为仅主帖、评论进详情页）。'
        );
    }
    if (status === 401 || status === 403) {
        parts.push('【可尝试】检查 API Key 是否过期、是否有权限访问该模型。');
    }
    if (status === 500) {
        parts.push(
            '【说明】500 多为上游模型服务异常，也可能与单次请求过大、排队超时有关（控制台若出现「Prompt 较大」提示更易触发）。'
        );
        parts.push(
            '【可尝试】① 在「API 设置」中适当调低「记忆条数」；② 精简好友角色卡/世界书条目；③ 稍后重试或更换模型与 API 端点。'
        );
    }
    return parts.length ? '\n\n' + parts.join('\n') : '';
}

/** 502/504 及非「无渠道」类 503 可自动重试；明确无可用渠道的 503 重试无意义 */
function shouldRetryApiHttpError(status, detailText) {
    if (
        status === 502 &&
        /eacces|eperm|upstream_connect_denied|出站连接被.*拒绝/i.test(String(detailText || ''))
    ) {
        // 同一受限进程内重试不会改变出站权限，避免连续发起三次无效请求。
        return false;
    }
    if (status === 502 || status === 504 || status === 524) return true;
    if (status === 503) {
        const d = String(detailText || '');
        if (/无可用渠道|no available channel/i.test(d)) return false;
        return true;
    }
    return false;
}

/**
 * 将 prompt 内的 data:image base64 替换为短占位说明，避免请求体过大或超出上游上下文导致 400。
 */
function redactDataImageUrlsForApiPrompt(text) {
    if (!text || typeof text !== 'string') return text;
    return text.replace(/data:image\/[^;]+;base64,[A-Za-z0-9+/=\r\n]+/gi, function (full) {
        var kb = Math.max(1, Math.round(full.length / 1024));
        return '[圖片 data URL 已省略（約 ' + kb + 'KB）；請依角色與佔位規則生成版面，勿還原像素]';
    });
}

// 功能-指令关联系统
const FeatureCommandMapper = {
    // 功能与指令的映射关系
    mappings: {
        'wechat': '微信聊天指令',
        'shopping': '购物指令',
        'books': '世界书指令',
        'theme': '主题指令',
        'settings': '设置指令',
        'phone': '手机指令',
        'twitter': '推特指令',
        'system': '系统指令'
    },
    
    // 根据功能名称获取相关指令
    getCommandsByFeature: function(featureName) {
        const commandName = this.mappings[featureName];
        if (!commandName) {
            return [];
        }
        
        const commands = CommandManager.getAllCommands();
        return commands.filter(cmd => cmd.name === commandName && cmd.active);
    },
    
    // 执行功能相关的指令
    executeFeatureCommands: function(featureName, additionalContent = '') {
        const commands = this.getCommandsByFeature(featureName);
        const content = [];
        
        commands.forEach(cmd => {
            content.push(cmd.content);
        });
        
        if (additionalContent) {
            content.push(additionalContent);
        }
        
        const fullContent = content.join('\n');
        if (fullContent) {
            // 这里可以调用API模型
            this.callApiModel(fullContent);
        }
    },
    
    // 调用API模型。options 可选，如 { apiRetry: false 关闭普通网络重试 }；输出预算统一由全局兼容规则处理。
    // options.overrideConnection: { apiUrl, apiKey, model } 与 apiSettings 合并后发起请求（用于主动发消息专用接口）
    callApiModel: async function(content, controller = null, options = {}) {
        const mobileUa =
            typeof navigator !== 'undefined' &&
            /iPhone|iPad|iPod|Android/i.test(String(navigator.userAgent || ''));
        const maxAttempts =
            options.apiRetry === false ? 1 : mobileUa ? 5 : 3;
        const retryDelaysMs = mobileUa ? [0, 800, 1800, 3200, 5000] : [0, 900, 2200];

        try {
            let settings = {};
            try {
                settings = JSON.parse(localStorage.getItem('apiSettings') || '{}');
                if (!settings || typeof settings !== 'object') settings = {};
            } catch (_) {
                settings = {};
            }
            const oc =
                options.overrideConnection &&
                typeof options.overrideConnection === 'object' &&
                options.overrideConnection;
            if (oc) {
                const u = String(oc.apiUrl || '').trim();
                const k = String(oc.apiKey || '').trim();
                const m = String(oc.model || '').trim();
                if (u && k && m) {
                    settings = Object.assign({}, settings, { apiUrl: u, apiKey: k, model: m });
                }
            }
            if (!settings.apiUrl || !settings.apiKey || !settings.model) {
                showNotification('API设置未完成，请先配置API');
                return;
            }

            if (!options.skipOverlay) {
                showLoading();
            }

            const requestData = {
                model: settings.model,
                messages: [{ role: 'user', content: content }],
                stream: resolveApiStreamEnabled(settings),
                max_tokens: resolveApiChatMaxTokens(settings)
            };

            // ── Prompt 大小预检（与长上下文模型对齐；仍防极端超大 body 超时） ───
            const promptLen = content.length;
            const estimatedTokens = Math.ceil(promptLen / 4) + 2; // 乐观估算：中文约2字符≈1token，英文约4字符≈1token
            const REQUEST_SIZE_WARN_KB = 420;
            const REQUEST_SIZE_BLOCK_KB = 720;
            const TOKEN_WARN = 140000;
            const TOKEN_BLOCK = 185000;

            if (promptLen > REQUEST_SIZE_BLOCK_KB * 1024 || estimatedTokens > TOKEN_BLOCK) {
                const sizeKb = Math.round(promptLen / 1024);
                console.warn('[API] Prompt 过大，已拦截本次请求。size=' + sizeKb + 'KB est_tokens≈' + estimatedTokens);
                if (!options.skipOverlay) hideLoading();
                showNotification('请求内容过大（' + sizeKb + 'KB / ~' + estimatedTokens + ' tokens），请减少好友数量或聊天记录条数后再试。');
                return null;
            }

            if (promptLen > REQUEST_SIZE_WARN_KB * 1024 || estimatedTokens > TOKEN_WARN) {
                console.warn('[API] Prompt 较大（' + Math.round(promptLen / 1024) + 'KB / ~' + estimatedTokens + ' tokens），可能出现超时。');
            }

            let lastError = null;
            let maxTokensCompatibilityAdjusted = false;

            // 「等待上限时长」与外部取消信号合并为统一请求信号；timedOut 用于区分超时与用户手动取消
            const waitTimeoutMs = resolveApiWaitTimeoutMs(settings);
            const waitState = combineAbortWithTimeout(controller, waitTimeoutMs);
            const effectiveController = waitState.controller;
            const waitMinutesLabel = String(Math.round((waitTimeoutMs / 60000) * 100) / 100);
            const waitTimeoutError = function () {
                return new Error(
                    '等待模型返回超过 ' + waitMinutesLabel + ' 分钟上限，已自动取消本次请求。' +
                    '可在「API 设置」调长等待上限时长（最高 15 分钟），或检查上游模型是否卡顿。'
                );
            };

            try {
            for (let attempt = 0; attempt < maxAttempts; attempt++) {
                if (effectiveController.signal && effectiveController.signal.aborted) {
                    if (waitState.timedOut) throw waitTimeoutError();
                    throw new DOMException('Aborted', 'AbortError');
                }
                if (retryDelaysMs[attempt]) {
                    await new Promise(function (r) { setTimeout(r, retryDelaysMs[attempt]); });
                }

                try {
                    const built = buildOpenAiChatFetch(settings, requestData, effectiveController);
                    const fetchUrl = built.url;
                    const fetchOptions = built.options;
                    console.log('[API] 开始请求 attempt=' + (attempt + 1) + ' url=' + fetchUrl + ' bodySize=' + Math.round(fetchOptions.body.length / 1024) + 'KB');
                    const t0 = Date.now();
                    const response = await fetch(fetchUrl, fetchOptions);
                    const elapsed = Date.now() - t0;
                    console.log('[API] 响应状态=' + response.status + ' elapsed=' + elapsed + 'ms');

                    if (!response.ok) {
                        let detail = '';
                        try {
                            const errText = await response.text();
                            if (errText) {
                                try {
                                    const j = JSON.parse(errText);
                                    if (j && typeof j === 'object') {
                                        if (j.error && typeof j.error === 'object' && j.error.message != null) {
                                            detail = String(j.error.message);
                                        } else if (typeof j.error === 'string') {
                                            detail = j.error;
                                        } else if (j.message != null) {
                                            detail = String(j.message);
                                        }
                                    }
                                } catch (_) {
                                    if (errText.length < 800) detail = errText.trim();
                                }
                            }
                        } catch (_) {}

                        if (
                            response.status === 405 &&
                            String(fetchUrl).indexOf('/api/chat/completions') !== -1
                        ) {
                            throw new Error(
                                '本地服务未提供 API 代理（405）。请关闭仅静态的服务器，在项目目录运行 npm start 或 node server.js，再用本页地址打开。'
                            );
                        }

                        const supportedMaxTokens = parseSupportedMaxOutputTokens(detail);
                        if (
                            response.status === 400 &&
                            !maxTokensCompatibilityAdjusted &&
                            supportedMaxTokens > 0 &&
                            requestData.max_tokens > supportedMaxTokens
                        ) {
                            console.warn(
                                '[API] 上游输出上限为 ' + supportedMaxTokens +
                                '，已将 max_tokens 从 ' + requestData.max_tokens + ' 下调后重试一次。'
                            );
                            requestData.max_tokens = supportedMaxTokens;
                            maxTokensCompatibilityAdjusted = true;
                            // 参数校验已在生成前失败，不占用普通网络重试次数。
                            attempt -= 1;
                            continue;
                        }

                        if (shouldRetryApiHttpError(response.status, detail) && attempt < maxAttempts - 1) {
                            console.warn('[API] HTTP ' + response.status + '，将自动重试（第 ' + (attempt + 2) + '/' + maxAttempts + ' 次）');
                            continue;
                        }

                        const baseMsg = 'API请求失败: ' + response.status + ' ' + response.statusText;
                        const hint = getApiErrorUserHint(response.status, detail);
                        throw new Error((detail ? baseMsg + ' — ' + detail : baseMsg) + hint);
                    }

                    const data = requestData.stream === true
                        ? await readChatCompletionStream(response)
                        : await response.json();

                    if (!options.skipOverlay) {
                        hideLoading();
                    }

                    if (data.choices && data.choices.length > 0) {
                        return data.choices[0].message.content;
                    }
                    throw new Error('API返回数据格式错误');
                } catch (error) {
                    lastError = error;
                    if (waitState.timedOut) {
                        throw waitTimeoutError();
                    }
                    if (error.name === 'AbortError') {
                        throw error;
                    }

                    const msg = String(error.message || '');
                    if (
                        msg.startsWith('API请求失败:') ||
                        msg.indexOf('本地服务未提供 API 代理') !== -1 ||
                        msg === 'API返回数据格式错误'
                    ) {
                        throw error;
                    }

                    const networkFail =
                        msg === 'Failed to fetch' ||
                        /networkerror|load failed|fetch failed|net::err|failed to fetch/i.test(msg);
                    if (networkFail && attempt < maxAttempts - 1) {
                        console.warn('[API] 网络异常，将自动重试（第 ' + (attempt + 2) + '/' + maxAttempts + ' 次）', error);
                        continue;
                    }
                    if (networkFail) {
                        let hostingHint = '';
                        try {
                            if (String(fetchUrl || '').startsWith('/api/')) {
                                hostingHint =
                                    '\n\n【补充】若本站为纯静态托管（无 Node 转发），浏览器访问 /api/ 会失败。请使用带 server.js 的部署方式，或将 API 配成与当前页面同源且可访问的代理地址。';
                            }
                        } catch (e) {}
                        throw new Error(
                            msg +
                                '\n\n【说明】无法完成网络请求，常见于本地代理未启动、上游不可达或跨域被拦。\n【可尝试】用 node server.js / npm start 打开本页；检查 API 地址、网络与 VPN；查看终端代理日志。' +
                                hostingHint
                        );
                    }
                    throw error;
                }
            }
            } finally {
                clearTimeout(waitState.timer);
            }

            if (lastError) {
                throw lastError;
            }
            throw new Error('API请求失败');
        } catch (error) {
            if (!options.skipOverlay) {
                hideLoading();
            }
            if (error.name !== 'AbortError') {
                if (!options.suppressErrorDialog) {
                    showErrorDialog('API调用失败', error.message);
                }
                console.error('API调用失败:', error);
            }
            return null;
        }
    }
};
if (typeof window !== 'undefined') window.FeatureCommandMapper = FeatureCommandMapper;

// 微信聊天规范④（群聊）短版正文：见 wechat-prompts.js 内 WECHAT_SPEC_4_GROUPCHAT_BILINGUAL_SHORT

// 临时好友/群编辑：见 wechat-temp-state.js（window.tempFriendData / tempGroupData）

// 状态栏相关变量
let signalStrength = 4; // 信号强度（0-4）
let networkType = 'wifi'; // 网络类型：wifi, mobile
let batteryLevel = 85; // 电池电量（0-100）
let isCharging = false; // 是否正在充电
let batteryStatus = 'normal'; // 电池状态：normal, low, charging

// 预设管理函数
// 打开保存预设模态框
function openSavePreset() {
    const modal = document.getElementById('save-preset-modal');
    modal.classList.add('show');
    document.getElementById('preset-name').value = '';
}



// 选择预设
function selectPreset(preset) {
    // 填充API地址和API Key
    const apiUrlInput = document.getElementById('api-url');
    const apiKeyInput = document.getElementById('api-key');
    
    if (apiUrlInput) apiUrlInput.value = preset.apiUrl;
    if (apiKeyInput) {
        try {
            apiKeyInput.value = atob(preset.apiKey || '');
        } catch (e) {
            apiKeyInput.value = preset.apiKey || '';
        }
    }
    
    markApiSettingsFormDirty();
    // 检查输入并更新按钮状态
    checkApiInputs();
    
    // 关闭模态框
    closePresetSelect();
    
    showNotification(`已选择预设: ${preset.name}`);
}



// 硬编码的默认系统指令（作为系统核心功能）
const DEFAULT_SYSTEM_COMMANDS = [
    {
        id: 1774213251,
        name: '核心指令',
        content: '你是一个智能助手，能够帮助用户完成各种任务',
        createdAt: 1774213251,
        active: true
    },
    {
        id: 1774213252,
        name: '微信助手',
        content: '你是一个微信助手，能够帮助用户管理微信消息和好友',
        createdAt: 1774213251,
        active: true
    },
    {
        id: 1774213253,
        name: '音乐助手',
        content: '你是一个音乐助手，能够帮助用户管理音乐播放',
        createdAt: 1774213251,
        active: true
    }
];

// 初始化默认系统指令
function initDefaultSystemCommands() {
    // 从localStorage获取指令
    let commands = [];
    try {
        const storedCommands = localStorage.getItem('systemCommands');
        if (storedCommands) {
            commands = JSON.parse(storedCommands);
        }
    } catch (e) {
        console.error('解析系统指令失败:', e);
        commands = [];
    }
    
    // 检查指令是否为空
    const isEmpty = !commands || commands.length === 0;
    console.log('系统指令状态:', { isEmpty, commandCount: commands.length });
    
    // 如果没有系统指令或指令为空数组，添加默认指令
    if (isEmpty) {
        localStorage.setItem('systemCommands', JSON.stringify(DEFAULT_SYSTEM_COMMANDS));
        console.log('已初始化默认系统指令');
        
        // 同步默认指令到文件
        CommandManager.syncCommandsToFile(DEFAULT_SYSTEM_COMMANDS).then(success => {
            console.log('同步指令到文件:', success);
        });
    }
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', async function() {
    // 必须先完成：mergeSystemDefaults 依赖 _cachedSystemDefaults；若晚于 loadFriendsFromStorage / loadChatList，系统预设好友会整段缺失（表现为微信列表空白）
    try {
        await loadSystemDefaultFriends();
    } catch (e) {
        console.warn('[系统好友] 预加载失败:', e);
    }

    // 从文件加载系统指令到localStorage
    await CommandManager.loadCommandsFromFile();

    // 初始化默认系统指令
    initDefaultSystemCommands();

    // —— 推特规范指令初始化（实现见 twitter-prompts.js · bootstrapTwitterSystemCommands）——
    if (typeof bootstrapTwitterSystemCommands === 'function') bootstrapTwitterSystemCommands();

    // —— 微信聊天规范⑥资金往来 bootstrap：见 wechat-bootstrap.js · Wechat.bootstrapSystemCommands ——
    if (typeof Wechat !== 'undefined' && typeof Wechat.bootstrapSystemCommands === 'function') {
        try {
            Wechat.bootstrapSystemCommands();
        } catch (e) {
            console.error('[Wechat bootstrap] 调用失败:', e);
        }
    }


    // 从localStorage中读取保存的头像
    const savedAvatarRaw = localStorage.getItem('userAvatar');
    const savedAvatar = normalizeAvatarUrl(savedAvatarRaw);
    const avatarImageElement = document.getElementById('avatar-image');
    
    if (avatarImageElement && savedAvatar) {
        avatarImageElement.src = savedAvatar;
        globalAvatarImage = savedAvatar;
    } else if (avatarImageElement && savedAvatarRaw && !savedAvatar) {
        try { localStorage.removeItem('userAvatar'); } catch (e) {}
    }

    // 头像文件输入框已覆盖整个头像框，不需要额外绑定点击事件
    // 点击头像框时会直接触发文件输入框的点击事件

    // 须先于 Wechat.init（会 scheduleLoadChatList）：IDB 模式下避免首帧 loadFriendsFromStorage 读到「仅系统预设」并污染/覆盖持久化
    try {
        await initFriendsFromIndexedDBIfNeeded();
    } catch (e) {
        console.warn('[好友] IndexedDB 预加载失败:', e);
    }
    try {
        if (typeof initChatHistoriesFromIndexedDBIfNeeded === 'function') {
            await initChatHistoriesFromIndexedDBIfNeeded();
        }
    } catch (e) {
        console.warn('[聊天] IndexedDB 预加载失败:', e);
    }

    await initApp();
    try { loadUserInfo(); } catch (e) {}
    try {
        requestAnimationFrame(function () {
            try { loadUserInfo(); } catch (e) {}
        });
    } catch (e) {}
    try { initOfflineFloatingButtonDrag(); } catch (e) {}
    try {
        if (typeof applyThemeRuntime === 'function') applyThemeRuntime();
    } catch (e) {
        console.warn('应用主题失败:', e);
    }
    updateTime();
    setInterval(updateTime, 1000);

    // 初始化可调整大小的文本框
    initResizeableTextareas();
    
    // 加载API设置
    try { migrateApiSettingsStorageIfNeeded(); } catch (e) {}
    loadApiSettings({ forceFormSync: true });
    try { initApiFloatingBall(); } catch (e) { console.warn('初始化悬浮球失败:', e); }

    setTimeout(() => {
        try {
            Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});
        } catch (e) {}
    }, 0);
    
    // 导入后：刷新完成自动预热，减少用户首次点进微信/朋友圈/表情的等待
    try { startPostImportPrewarmIfNeeded(); } catch (e) {}
    
    applyWechatThemeFromStorage();
    try { loadUserInfo(); } catch (e) {}
});

// 初始化可调整大小的文本框
function initResizeableTextareas() {
    const handles = document.querySelectorAll('.resize-handle');
    handles.forEach(handle => {
        handle.addEventListener('mousedown', startResize);
    });
}

// 开始调整大小
function startResize(e) {
    e.preventDefault();
    
    const handle = e.target;
    const container = handle.closest('.resizeable-textarea-container');
    const textarea = container.querySelector('.resizeable-textarea');
    
    if (!container || !textarea) return;
    
    // 检查是否在我的人设操作界面
    const myProfileModal = document.getElementById('my-profile-modal');
    const isInMyProfileModal = myProfileModal && myProfileModal.classList.contains('show');
    
    // 获取初始位置
    const startX = e.clientX;
    const startY = e.clientY;
    const startWidth = container.offsetWidth;
    const startHeight = container.offsetHeight;
    
    // 获取初始模态框大小（如果在我的人设界面）
    let startModalHeight = 0;
    if (isInMyProfileModal) {
        const modalContent = myProfileModal.querySelector('.modal-content');
        if (modalContent) {
            startModalHeight = modalContent.offsetHeight;
        }
    }
    
    // 计算限制值
    const minWidth = 300;
    const minHeight = 100;
    
    // 计算基于屏幕大小的最大限制
    const screenWidth = window.innerWidth;
    const screenHeight = window.innerHeight;
    const maxWidth = Math.min(container.parentElement.offsetWidth * 0.9, screenWidth * 0.9);
    const maxHeight = Math.min(screenHeight * 0.8, screenHeight - 100); // 留一些空间给其他元素
    
    // 添加鼠标移动和释放事件监听器
    function resize(e) {
        const deltaX = e.clientX - startX;
        const deltaY = e.clientY - startY;
        
        // 计算新尺寸
        let newWidth = startWidth + deltaX;
        let newHeight = startHeight + deltaY;
        
        // 应用限制
        newWidth = Math.max(minWidth, Math.min(maxWidth, newWidth));
        newHeight = Math.max(minHeight, Math.min(maxHeight, newHeight));
        
        // 计算高度变化
        const heightChange = newHeight - startHeight;
        
        // 更新容器和文本框尺寸
        container.style.width = `${newWidth}px`;
        container.style.height = `${newHeight}px`;
        textarea.style.width = `${newWidth}px`;
        textarea.style.height = `${newHeight}px`;
        
        // 如果在我的人设界面，同时调整模态框大小
        if (isInMyProfileModal) {
            const modalContent = myProfileModal.querySelector('.modal-content');
            if (modalContent) {
                const newModalHeight = startModalHeight + heightChange;
                // 确保模态框高度不超过屏幕高度
                const maxModalHeight = screenHeight * 0.9;
                const finalModalHeight = Math.min(newModalHeight, maxModalHeight);
                modalContent.style.height = `${finalModalHeight}px`;
            }
        }
    }
    
    function stopResize() {
        document.removeEventListener('mousemove', resize);
        document.removeEventListener('mouseup', stopResize);
    }
    
    document.addEventListener('mousemove', resize);
    document.addEventListener('mouseup', stopResize);
}

// 初始化应用（须 await：Wechat.init 会异步注入 fragments/wechat-page.html，未就绪时 loadChatList 无法命中 #wechat-page）
async function initApp() {
    // 绑定事件
    bindEvents();
    if (typeof bindWechatChatPipelineDom === 'function') {
        bindWechatChatPipelineDom();
    }

    // 加载主卡片已保存的编辑文字
    loadMainCardText();

    // 初始化快捷功能
    initQuickFunctions();

    // 初始化音乐播放器
    initMusicPlayer();

    // 初始化底部导航
    initBottomNav();

    // 初始化状态栏
    initStatusBar();

    // 微信：先注入 #wechat-page / 通讯录等 DOM，再允许后续 loadChatList 渲染
    if (typeof Wechat !== 'undefined' && typeof Wechat.init === 'function') {
        await Wechat.init();
    }
}

// 绑定事件
function bindEvents() {
    // 签名和位置：仅绑定主屏幕主卡片，避免命中小手机内预览等同 class 节点
    const mainCardRoot = document.querySelector('.main-card');
    if (mainCardRoot) {
        const sigEl = mainCardRoot.querySelector('.card-signature');
        const locEl = mainCardRoot.querySelector('.card-location');
        const decoEl = mainCardRoot.querySelector('.decorative-icons');
        if (sigEl) sigEl.addEventListener('click', openEditModal);
        if (locEl) locEl.addEventListener('click', openEditModal);
        if (decoEl) decoEl.addEventListener('click', openEditModal);
    }
    
    // 保存按钮点击事件（只绑定编辑模态框中的按钮）
    const editSaveBtn = document.querySelector('#edit-modal .save-btn');
    if (editSaveBtn) {
        editSaveBtn.addEventListener('click', saveEdit);
    }
    
    // 取消按钮点击事件（只绑定编辑模态框中的按钮）
    const editCancelBtn = document.querySelector('#edit-modal .cancel-btn');
    if (editCancelBtn) {
        editCancelBtn.addEventListener('click', closeEditModal);
    }
    
    // 模态框外部点击事件
    document.querySelectorAll('.modal').forEach(modal => {
        modal.addEventListener('click', function(e) {
            if (e.target === this) {
                if (this.id === 'edit-modal') {
                    closeEditModal();
                } else if (this.id === 'save-preset-modal') {
                    closeSavePreset();
                } else if (this.id === 'select-preset-modal') {
                    closePresetSelect();
                }
            }
        });
    });
    
}

// 初始化快捷功能
function initQuickFunctions() {
    const functionItems = document.querySelectorAll('.function-item');
    functionItems.forEach(item => {
        item.addEventListener('click', function() {
            const page = this.dataset.page;
            if (page === 'system' && !__SYSTEM_DEV_MODE__) {
                showNotification('系统功能已锁定');
                return;
            }
            showPage(page);
        });
    });
}

// 初始化底部导航
function initBottomNav() {
    const navItems = document.querySelectorAll('.nav-item');
    navItems.forEach(item => {
        const pageKey = item.dataset.page;
        if (pageKey === 'system' && !__SYSTEM_DEV_MODE__) {
            item.classList.add('nav-item--locked');
            item.setAttribute('aria-disabled', 'true');
            item.title = '系统功能已锁定';
        }
        item.addEventListener('click', function() {
            const page = this.dataset.page;
            if (page === 'system' && !__SYSTEM_DEV_MODE__) {
                showNotification('系统功能已锁定');
                return;
            }
            showPage(page);
        });
    });
}

// 打开编辑模态框
function openEditModal() {
    const modal = document.getElementById('edit-modal');
    const decorativeIconsInput = document.getElementById('decorative-icons-input');
    const signatureInput = document.getElementById('signature-input');
    const locationInput = document.getElementById('location-input');
    const mainCardRoot = document.querySelector('.main-card');
    if (!modal || !decorativeIconsInput || !signatureInput || !locationInput || !mainCardRoot) return;

    // 填充当前值（仅主卡片）
    const decorativeIcons = mainCardRoot.querySelectorAll('.decorative-icon');
    let iconsText = '';
    decorativeIcons.forEach(icon => {
        iconsText += icon.textContent + ' ';
    });
    const savedMainCardText = readMainCardTextPayload();
    decorativeIconsInput.value = decorativeIcons.length ? iconsText.trim() : (savedMainCardText?.decorativeIcons ?? MAIN_CARD_DEFAULTS.decorativeIcons);

    const sigP = mainCardRoot.querySelector('.card-signature p');
    const signature = sigP ? sigP.textContent : (savedMainCardText?.signature ?? MAIN_CARD_DEFAULTS.signature);
    signatureInput.value = signature;

    const locSpan = mainCardRoot.querySelector('.card-location span');
    const location = locSpan ? locSpan.textContent : (savedMainCardText?.location ?? MAIN_CARD_DEFAULTS.location);
    locationInput.value = location;

    modal.classList.add('show');
}

// 关闭编辑模态框
function closeEditModal() {
    const modal = document.getElementById('edit-modal');
    modal.classList.remove('show');
}

// 主卡片可编辑文字默认值
const MAIN_CARD_DEFAULTS = {
    decorativeIcons: '· ♡ ·',
    signature: '把日子过成喜欢的样子。',
    location: '长沙'
};

function readMainCardTextPayload() {
    try {
        let data =
            typeof parseJsonFromPossiblyEncodedStorage === 'function'
                ? parseJsonFromPossiblyEncodedStorage('mainCardText', null)
                : null;
        if (data && typeof data === 'object' && !Array.isArray(data)) return data;
        const raw = localStorage.getItem('mainCardText');
        if (typeof raw !== 'string' || !raw) return null;
        data = JSON.parse(raw);
        if (typeof data === 'string') {
            try {
                data = JSON.parse(data);
            } catch (_) {
                return null;
            }
        }
        return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
    } catch (e) {
        return null;
    }
}

// 加载主卡片已保存的编辑文字
function loadMainCardText() {
    try {
        const data = readMainCardTextPayload();
        const icons = (data?.decorativeIcons ?? MAIN_CARD_DEFAULTS.decorativeIcons).trim();
        const signature = data?.signature ?? MAIN_CARD_DEFAULTS.signature;
        const location = data?.location ?? MAIN_CARD_DEFAULTS.location;

        const mainCardRoot = document.querySelector('.main-card');
        const decorativeIconsContainer = mainCardRoot
            ? mainCardRoot.querySelector('.decorative-icons')
            : document.querySelector('.main-card .decorative-icons');
        if (decorativeIconsContainer) {
            decorativeIconsContainer.innerHTML = '';
            icons.split(/\s+/).forEach(icon => {
                if (icon) {
                    const el = document.createElement('span');
                    el.className = 'decorative-icon';
                    el.textContent = icon;
                    decorativeIconsContainer.appendChild(el);
                }
            });
        }

        const sigEl = mainCardRoot
            ? mainCardRoot.querySelector('.card-signature p')
            : document.querySelector('.main-card .card-signature p');
        if (sigEl) sigEl.textContent = signature;

        const locEl = mainCardRoot
            ? mainCardRoot.querySelector('.card-location span')
            : document.querySelector('.main-card .card-location span');
        if (locEl) locEl.textContent = location;
    } catch (e) {
        console.error('加载主卡片文字失败:', e);
    }
}

// 保存编辑
function saveEdit() {
    const decorativeIconsInput = document.getElementById('decorative-icons-input');
    const signatureInput = document.getElementById('signature-input');
    const locationInput = document.getElementById('location-input');
    const mainCardRoot = document.querySelector('.main-card');
    if (!decorativeIconsInput || !signatureInput || !locationInput || !mainCardRoot) return;

    const iconsArr = decorativeIconsInput.value.split(/\s+/).filter(s => s.trim());
    const iconsStr = iconsArr.join(' ');

    const decorativeIconsContainer = mainCardRoot.querySelector('.decorative-icons');
    if (decorativeIconsContainer) {
        decorativeIconsContainer.innerHTML = '';
        iconsArr.forEach(icon => {
            const iconElement = document.createElement('span');
            iconElement.className = 'decorative-icon';
            iconElement.textContent = icon;
            decorativeIconsContainer.appendChild(iconElement);
        });
    }

    const sigP = mainCardRoot.querySelector('.card-signature p');
    const locSpan = mainCardRoot.querySelector('.card-location span');
    const signatureRaw = String(signatureInput.value || '').replace(/\r\n/g, '\n');
    const signatureToSave = signatureRaw.trim();
    if (sigP) sigP.textContent = signatureToSave;
    if (locSpan) locSpan.textContent = locationInput.value;

    const payload = {
        decorativeIcons: iconsStr,
        signature: signatureToSave,
        location: locationInput.value
    };
    try {
        if (typeof saveJsonToStorageWithCompression === 'function') {
            saveJsonToStorageWithCompression('mainCardText', payload);
        } else {
            localStorage.setItem('mainCardText', JSON.stringify(payload));
        }
    } catch (e) {
        console.error('保存主卡片文字失败:', e);
        const quota = typeof isQuotaExceededError === 'function' && isQuotaExceededError(e);
        showNotification(
            quota ? '保存失败：存储空间已满，请清理聊天记录或图片后再试' : '保存失败，请重试或检查浏览器存储权限'
        );
        return;
    }

    closeEditModal();
    showNotification('保存成功');
}

// 页面进入钩子：较重的初始化（如恢复推特信息流）放在首帧绘制之后，避免阻塞切换
function runPageEnterHooks(page) {
    // 当导航到世界书页面时，加载世界书列表
    if (page === 'books') {
        loadWorldBookList();
    }
    if (page === 'theme') {
        initThemeEditorDraftFromSaved();
        refreshThemeEditorPanel();
    }
    if (page === 'shopping') {
        initShoppingPage();
    }
    if (page === 'twitter') {
        onEnterTwitterPage();
    }
    if (page === 'phone') {
        phoneOnEnterPhonePage();
    }
    if (page === 'voice-settings') {
        // 延迟一下，确保页面完全渲染
        setTimeout(() => {
            loadVoiceSettings();
        }, 100);
    }
    if (page === 'auto-message-api-settings') {
        setTimeout(() => {
            try {
                syncProactiveAutoApiFormFromStorage();
                checkProactiveAutoApiInputs();
            } catch (e) {}
        }, 100);
    }
    if (page === 'api-settings') {
        setTimeout(function () {
            try {
                // 勿再次从 localStorage 覆写表单：导入后用户修改 API 时，重复 load 会把字段刷回备份中的旧值
                if (__apiSettingsFormDirty) {
                    refreshApiConnectionStatusFromStorage();
                    checkApiInputs();
                } else {
                    loadApiSettings({ syncForm: true, forceFormSync: true });
                }
            } catch (e) {}
        }, 80);
    }
    if (page === 'system') {
        try { loadCommandList(); } catch (e) {}
    }
}

// 显示页面
function showPage(page) {
    if (currentPage === page) return;

    if (currentPage === 'books' && page !== 'books') {
        exitWorldBookListSelectModeIfNeeded();
    }

    if (page === 'system' && !__SYSTEM_DEV_MODE__) {
        showNotification('系统功能已锁定');
        return;
    }

    // 立即切换：不再使用「加载中」遮罩 + 人为 500ms 延迟
    document.querySelectorAll('.page').forEach(p => {
        p.classList.remove('active');
    });

    let targetPage;
    if (page === 'home') {
        targetPage = document.getElementById('home-screen');
    } else {
        targetPage = document.getElementById(`${page}-page`);
    }
    if (targetPage) {
        targetPage.classList.add('active');
    }

    // 显示页面切换提示
    showNotification(`切换到${getPageName(page)}`);

    currentPage = page;
    try { updateApiFloatingBallVisibility(); } catch (e) {}

    // 等首帧绘制后再执行进入钩子，让页面先显示出来
    var hooksRan = false;
    function runEnterHooksOnce() {
        if (hooksRan) return;
        hooksRan = true;
        try { runPageEnterHooks(page); } catch (e) { console.error('[页面初始化]', e); }
    }
    requestAnimationFrame(function() {
        setTimeout(runEnterHooksOnce, 0);
    });
    // 兜底：后台标签页 rAF 不触发时，钩子仍会执行
    setTimeout(runEnterHooksOnce, 120);
}

// 导航到指定页面
function navigateTo(page) {
    // 若离开聊天页，取消可能进行中的历史渲染，避免返回/切页无响应
    if (page !== 'chat') {
        try { cancelActiveChatHistoryRender(); } catch (e) {}
    }
    if (page === 'system' && !__SYSTEM_DEV_MODE__) {
        showNotification('系统功能已锁定');
        return;
    }
    showPage(page);
    
    // 当导航到聊天页面时，重新加载用户信息，确保头像显示正确
    if (page === 'chat') {
        // 延迟一下，确保聊天页面已经完全显示
        setTimeout(() => {
            loadUserInfo();
        }, 100);
    }
    
    // 当导航到语音设置页面时，加载语音设置
    if (page === 'voice-settings') {
        // 延迟一下，确保页面已经完全显示
        setTimeout(() => {
            loadVoiceSettings();
        }, 600); // 增加延迟时间，确保页面完全渲染
    }
}

// 打开添加系统命令模态框
function openAddCommandModal() {
    if (!__SYSTEM_DEV_MODE__) { showNotification('此功能已锁定'); return; }
    const modal = document.getElementById('add-command-modal');
    if (modal) {
        delete modal.dataset.commandId;
        const nameEl = document.getElementById('command-name');
        const contentEl = document.getElementById('command-content');
        if (nameEl) nameEl.value = '';
        if (contentEl) contentEl.value = '';
        modal.classList.add('show');
    }
}

// 关闭添加系统命令模态框
function closeAddCommandModal() {
    const modal = document.getElementById('add-command-modal');
    if (modal) {
        modal.classList.remove('show');
        // 清空表单
        document.getElementById('command-name').value = '';
        document.getElementById('command-content').value = '';
        // 清除命令ID
        delete modal.dataset.commandId;
    }
}

// ========== 世界书模块 ==========
function getWorldBookData() {
    try {
        const parsed =
            typeof parseJsonFromPossiblyEncodedStorage === 'function'
                ? parseJsonFromPossiblyEncodedStorage('worldBookData', { folders: [], entries: [] })
                : null;
        const base = parsed && typeof parsed === 'object' ? parsed : { folders: [], entries: [] };
        const folders = Array.isArray(base.folders) ? base.folders : [];
        const entries = Array.isArray(base.entries) ? base.entries : [];
        return { folders, entries };
    } catch (e) {
        return { folders: [], entries: [] };
    }
}

function saveWorldBookData(data) {
    if (typeof saveJsonToStorageWithCompression !== 'function') {
        localStorage.setItem('worldBookData', JSON.stringify(data));
        return;
    }
    saveJsonToStorageWithCompression('worldBookData', data);
}

/** 世界书落盘；失败时提示并返回 false（避免调用方误关弹窗或误报成功） */
function trySaveWorldBookDataWithNotify(data) {
    try {
        saveWorldBookData(data);
        return true;
    } catch (e) {
        const quota = typeof isQuotaExceededError === 'function' && isQuotaExceededError(e);
        showNotification(
            quota
                ? '保存失败：浏览器存储空间已满。请删减世界书正文、删除不需要的条目，或清理聊天记录/图片后再试。'
                : '保存失败：' + (e && e.message ? e.message : String(e))
        );
        return false;
    }
}

function loadWorldBookList() {
    const listEl = document.getElementById('world-book-list');
    const emptyEl = document.getElementById('world-book-empty');
    if (!listEl || !emptyEl) return;

    const data = getWorldBookData();
    const entries = data.entries || [];
    const folders = data.folders || [];

    if (entries.length === 0) {
        listEl.classList.remove('has-items');
        emptyEl.classList.remove('has-items');
        listEl.innerHTML = '';
        updateWorldBookDeleteFabUI();
        return;
    }

    listEl.classList.add('has-items');
    emptyEl.classList.add('has-items');

    const byFolder = {};
    entries.forEach(entry => {
        const fid = entry.folderId || '';
        if (!byFolder[fid]) byFolder[fid] = [];
        byFolder[fid].push(entry);
    });

    let html = '';
    const folderOrder = ['', ...folders.map(f => f.id)];
    folderOrder.forEach(fid => {
        const list = byFolder[fid] || [];
        if (list.length === 0) return;
        const folder = folders.find(f => f.id === fid);
        const headerText = folder ? folder.name : '未分组';
        html += `<div class="world-book-folder-section">
            <div class="world-book-folder-header">${escapeHtml(headerText)}</div>
            ${list.map(entry => {
                const eid = String(entry.id).replace(/\\/g, '\\\\').replace(/'/g, '\\\'');
                const preview = escapeHtml((entry.content || '').replace(/<[^>]+>/g, '').substring(0, 60));
                const title = escapeHtml(entry.name || '未命名');
                if (worldBookListSelectMode) {
                    const sel = worldBookListDeleteSelectedIds.has(String(entry.id));
                    return `<div class="world-book-item world-book-item-multi ${sel ? 'checked' : ''}" onclick="if(!event.target.closest('input')) toggleWorldBookListDeleteItem('${eid}', this)">
                    <input type="checkbox" class="world-book-item-cb" ${sel ? 'checked' : ''} onclick="event.stopPropagation()" onchange="syncWorldBookListDeleteFromCheckbox('${eid}', this)">
                    <div class="world-book-item-text">
                        <div class="world-book-item-title">${title}</div>
                        <div class="world-book-item-preview">${preview}</div>
                    </div>
                </div>`;
                }
                return `<div class="world-book-item" onclick="openAddWorldBookModal('${eid}')">
                    <div class="world-book-item-title">${title}</div>
                    <div class="world-book-item-preview">${preview}</div>
                </div>`;
            }).join('')}
        </div>`;
    });
    listEl.innerHTML = html;
    updateWorldBookDeleteFabUI();
}

function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

function openAddWorldBookModal(editId) {
    if (worldBookListSelectMode) {
        exitWorldBookListSelectModeIfNeeded();
        loadWorldBookList();
    }
    const modal = document.getElementById('add-world-book-modal');
    const titleEl = document.getElementById('add-world-book-modal-title');
    const nameInput = document.getElementById('world-book-name-input');
    const contentInput = document.getElementById('world-book-content-input');
    const folderSelect = document.getElementById('world-book-folder-select');
    const activationSelect = document.getElementById('world-book-activation-select');
    const activationHint = document.getElementById('world-book-activation-hint');
    if (!modal || !titleEl || !nameInput || !contentInput || !folderSelect) return;

    const data = getWorldBookData();
    const folders = data.folders || [];
    folderSelect.innerHTML = '<option value="">未分组</option>' +
        folders.map(f => `<option value="${f.id}">${escapeHtml(f.name)}</option>`).join('');

    if (editId) {
        const entry = (data.entries || []).find(e => String(e.id) === String(editId));
        if (entry) {
            titleEl.textContent = '编辑世界书';
            nameInput.value = entry.name || '';
            contentInput.value = entry.content || '';
            folderSelect.value = entry.folderId || '';
            if (activationSelect) activationSelect.value = entry.activationMode === 'keyword' ? 'keyword' : 'global';
            modal.dataset.editId = editId;
        }
    } else {
        titleEl.textContent = '新建世界书';
        nameInput.value = '';
        contentInput.value = '';
        folderSelect.value = '';
        if (activationSelect) activationSelect.value = 'global';
        delete modal.dataset.editId;
    }
    updateWorldBookActivationHint();
    modal.classList.add('show');
}

function updateWorldBookActivationHint() {
    const activationSelect = document.getElementById('world-book-activation-select');
    const activationHint = document.getElementById('world-book-activation-hint');
    if (activationHint && activationSelect) {
        activationHint.textContent = activationSelect.value === 'keyword'
            ? '关键词=世界书标题，用户消息提到时才会发送'
            : '每次激活 API 时都会发送此世界书';
    }
}

function closeAddWorldBookModal() {
    const modal = document.getElementById('add-world-book-modal');
    if (modal) {
        modal.classList.remove('show');
        delete modal.dataset.editId;
    }
}

function saveWorldBookEntry() {
    const nameInput = document.getElementById('world-book-name-input');
    const contentInput = document.getElementById('world-book-content-input');
    const folderSelect = document.getElementById('world-book-folder-select');
    const activationSelect = document.getElementById('world-book-activation-select');
    const modal = document.getElementById('add-world-book-modal');
    if (!nameInput || !contentInput || !modal) return;

    const name = nameInput.value.trim();
    if (!name) {
        showNotification('请输入世界书标题');
        return;
    }
    const folderId = folderSelect ? (folderSelect.value || null) : null;
    const activationMode = activationSelect ? (activationSelect.value === 'keyword' ? 'keyword' : 'global') : 'global';

    const data = getWorldBookData();
    const editId = modal.dataset.editId;

    if (editId) {
        const idx = (data.entries || []).findIndex(e => String(e.id) === String(editId));
        if (idx !== -1) {
            data.entries[idx].name = name;
            data.entries[idx].content = contentInput.value;
            data.entries[idx].folderId = folderId;
            data.entries[idx].activationMode = activationMode;
            data.entries[idx].updatedAt = Date.now();
        }
    } else {
        const newEntry = {
            id: 'wb_' + Date.now(),
            name,
            content: contentInput.value,
            folderId,
            activationMode,
            createdAt: Date.now()
        };
        data.entries = data.entries || [];
        data.entries.unshift(newEntry);
    }
    if (!trySaveWorldBookDataWithNotify(data)) return;
    closeAddWorldBookModal();
    loadWorldBookList();
    showNotification('保存成功');
}

function renderWorldBookFolderListModal() {
    const body = document.getElementById('world-book-folder-list-body');
    if (!body) return;
    const data = getWorldBookData();
    const folders = data.folders || [];
    if (folders.length === 0) {
        body.innerHTML = '<div class="world-book-folder-list-empty">暂无分组</div>';
        return;
    }
    body.innerHTML = folders.map(folder => `
        <div class="world-book-folder-list-item">
            <div class="world-book-folder-list-name">${escapeHtml(folder.name || '未命名分组')}</div>
            <div class="world-book-folder-list-item-actions">
                <button type="button" class="world-book-folder-list-action-btn" onclick="openWorldBookFolderEditorModal('${String(folder.id).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')">编辑</button>
                <button type="button" class="world-book-folder-list-action-btn world-book-folder-list-action-danger" onclick="deleteWorldBookFolder('${String(folder.id).replace(/\\/g, '\\\\').replace(/'/g, '\\\'')}')">删除</button>
            </div>
        </div>
    `).join('');
}

function openWorldBookFolderModal() {
    if (worldBookListSelectMode) {
        exitWorldBookListSelectModeIfNeeded();
        loadWorldBookList();
    }
    renderWorldBookFolderListModal();
    const modal = document.getElementById('world-book-folder-list-modal');
    if (modal) modal.classList.add('show');
}

function closeWorldBookFolderListModal() {
    const modal = document.getElementById('world-book-folder-list-modal');
    if (modal) modal.classList.remove('show');
}

function openWorldBookFolderEditorModal(editId) {
    const listModal = document.getElementById('world-book-folder-list-modal');
    const modal = document.getElementById('new-folder-modal');
    const input = document.getElementById('new-folder-name-input');
    const title = document.getElementById('world-book-folder-editor-title');
    const confirmBtn = document.getElementById('world-book-folder-editor-confirm-btn');
    if (!modal || !input) return;
    const data = getWorldBookData();
    const folder = editId ? (data.folders || []).find(item => String(item.id) === String(editId)) : null;
    if (title) title.textContent = folder ? '编辑分组' : '新建分组';
    if (confirmBtn) confirmBtn.textContent = folder ? '保存' : '创建';
    input.value = folder ? (folder.name || '') : '';
    if (folder) {
        modal.dataset.editId = String(folder.id);
    } else {
        delete modal.dataset.editId;
    }
    if (listModal) listModal.classList.remove('show');
    modal.classList.add('show');
    setTimeout(() => input.focus(), 100);
}

function closeNewFolderModal() {
    const listModal = document.getElementById('world-book-folder-list-modal');
    const modal = document.getElementById('new-folder-modal');
    const input = document.getElementById('new-folder-name-input');
    const title = document.getElementById('world-book-folder-editor-title');
    const confirmBtn = document.getElementById('world-book-folder-editor-confirm-btn');
    if (modal) {
        modal.classList.remove('show');
        delete modal.dataset.editId;
    }
    if (input) input.value = '';
    if (title) title.textContent = '新建分组';
    if (confirmBtn) confirmBtn.textContent = '创建';
    renderWorldBookFolderListModal();
    if (listModal) listModal.classList.add('show');
}

function createWorldBookFolder() {
    const input = document.getElementById('new-folder-name-input');
    const modal = document.getElementById('new-folder-modal');
    if (!input || !modal) return;
    const name = input.value.trim();
    if (!name) {
        showNotification('请输入文件夹名称');
        return;
    }
    const data = getWorldBookData();
    data.folders = data.folders || [];
    const editId = modal.dataset.editId;
    const duplicate = data.folders.find(item => String(item.id) !== String(editId || '') && (item.name || '').trim() === name);
    if (duplicate) {
        showNotification('该分组名称已存在');
        return;
    }
    if (editId) {
        const folder = data.folders.find(item => String(item.id) === String(editId));
        if (!folder) return;
        folder.name = name;
        folder.updatedAt = Date.now();
    } else {
        const newFolder = {
            id: 'fd_' + Date.now(),
            name,
            createdAt: Date.now()
        };
        data.folders.push(newFolder);
    }
    if (!trySaveWorldBookDataWithNotify(data)) return;
    closeNewFolderModal();
    loadWorldBookList();
    showNotification(editId ? '分组已更新' : '文件夹已创建');
}

function deleteWorldBookFolder(folderId) {
    const id = String(folderId);
    const data = getWorldBookData();
    const folder = (data.folders || []).find(item => String(item.id) === id);
    const modal = document.getElementById('world-book-folder-delete-confirm-modal');
    const message = document.getElementById('world-book-folder-delete-confirm-message');
    if (!folder || !modal || !message) return;
    const affectedCount = (data.entries || []).filter(entry => String(entry.folderId || '') === id).length;
    modal.dataset.folderId = id;
    message.textContent = affectedCount > 0
        ? `删除分组“${folder.name}”后，分组内的 ${affectedCount} 本世界书会变为未分组状态。此操作不可撤销，确定继续吗？`
        : `将删除分组“${folder.name}”。此操作不可撤销，确定继续吗？`;
    modal.classList.add('show');
}

function closeWorldBookFolderDeleteConfirmModal() {
    const modal = document.getElementById('world-book-folder-delete-confirm-modal');
    if (!modal) return;
    modal.classList.remove('show');
    delete modal.dataset.folderId;
}

function executeDeleteWorldBookFolder() {
    const modal = document.getElementById('world-book-folder-delete-confirm-modal');
    if (!modal || !modal.dataset.folderId) return;
    const id = String(modal.dataset.folderId);
    closeWorldBookFolderDeleteConfirmModal();
    const data = getWorldBookData();
    const folders = data.folders || [];
    const folder = folders.find(item => String(item.id) === id);
    if (!folder) return;
    data.folders = folders.filter(item => String(item.id) !== id);
    data.entries = (data.entries || []).map(entry => {
        if (String(entry.folderId || '') !== id) return entry;
        return { ...entry, folderId: null, updatedAt: Date.now() };
    });
    if (!trySaveWorldBookDataWithNotify(data)) return;
    renderWorldBookFolderListModal();
    loadWorldBookList();
    showNotification(`已删除分组“${folder.name}”`);
}

let worldBookListSelectMode = false;
let worldBookListDeleteSelectedIds = new Set();
let worldBookCollapsedFolderIds = new Set();

function toggleWorldBookFolder(folderId) {
    const id = String(folderId || '__ungrouped__');
    if (worldBookCollapsedFolderIds.has(id)) {
        worldBookCollapsedFolderIds.delete(id);
    } else {
        worldBookCollapsedFolderIds.add(id);
    }
    loadWorldBookList();
}

function exitWorldBookListSelectModeIfNeeded() {
    if (!worldBookListSelectMode) return;
    worldBookListSelectMode = false;
    worldBookListDeleteSelectedIds.clear();
    const btn = document.getElementById('world-book-select-mode-btn');
    const booksContent = document.getElementById('books-content');
    if (btn) btn.classList.remove('world-book-select-mode-on');
    if (booksContent) booksContent.classList.remove('world-book-delete-mode');
    updateWorldBookDeleteFabUI();
}

function toggleWorldBookListSelectMode() {
    worldBookListSelectMode = !worldBookListSelectMode;
    if (!worldBookListSelectMode) {
        worldBookListDeleteSelectedIds.clear();
    }
    const btn = document.getElementById('world-book-select-mode-btn');
    const booksContent = document.getElementById('books-content');
    if (btn) btn.classList.toggle('world-book-select-mode-on', worldBookListSelectMode);
    if (booksContent) booksContent.classList.toggle('world-book-delete-mode', worldBookListSelectMode);
    loadWorldBookList();
    updateWorldBookDeleteFabUI();
}

function updateWorldBookDeleteFabUI() {
    const fab = document.getElementById('world-book-delete-fab');
    if (!fab) return;
    if (!worldBookListSelectMode) {
        fab.style.display = 'none';
        return;
    }
    const n = worldBookListDeleteSelectedIds.size;
    fab.style.display = n > 0 ? 'block' : 'none';
}

function toggleWorldBookListDeleteItem(entryId, el) {
    const id = String(entryId);
    if (worldBookListDeleteSelectedIds.has(id)) {
        worldBookListDeleteSelectedIds.delete(id);
    } else {
        worldBookListDeleteSelectedIds.add(id);
    }
    const checkbox = el ? el.querySelector('input[type="checkbox"]') : null;
    if (checkbox) checkbox.checked = worldBookListDeleteSelectedIds.has(id);
    if (el) el.classList.toggle('checked', worldBookListDeleteSelectedIds.has(id));
    updateWorldBookDeleteFabUI();
}

function syncWorldBookListDeleteFromCheckbox(entryId, checkbox) {
    const id = String(entryId);
    if (checkbox.checked) {
        worldBookListDeleteSelectedIds.add(id);
    } else {
        worldBookListDeleteSelectedIds.delete(id);
    }
    const el = checkbox ? checkbox.closest('.world-book-item-multi') : null;
    if (el) el.classList.toggle('checked', checkbox.checked);
    updateWorldBookDeleteFabUI();
}

async function removeWorldBookRefsFromStoredFriends(deletedIds) {
    const del = new Set((deletedIds || []).map(id => String(id)));
    if (del.size === 0) return;
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}
    const friends = loadFriendsFromStorage();
    let changed = false;
    for (let i = 0; i < friends.length; i++) {
        const f = friends[i];
        if (!f) continue;
        if (Array.isArray(f.worldBookIds)) {
            const next = f.worldBookIds.filter(id => !del.has(String(id)));
            if (next.length !== f.worldBookIds.length) {
                changed = true;
                if (next.length) {
                    f.worldBookIds = next;
                    delete f.worldBookId;
                } else {
                    delete f.worldBookIds;
                    delete f.worldBookId;
                }
            }
        } else if (f.worldBookId != null && del.has(String(f.worldBookId))) {
            delete f.worldBookId;
            changed = true;
        }
    }
    if (changed) saveFriendsToStorage(friends);

    function stripTemp(container) {
        if (!container || typeof container !== 'object') return;
        Object.keys(container).forEach(key => {
            const t = container[key];
            if (!t) return;
            if (Array.isArray(t.worldBookIds)) {
                const next = t.worldBookIds.filter(id => !del.has(String(id)));
                if (next.length !== t.worldBookIds.length) {
                    if (next.length) {
                        t.worldBookIds = next;
                    } else {
                        delete t.worldBookIds;
                    }
                    delete t.worldBookId;
                }
            } else if (t.worldBookId != null && del.has(String(t.worldBookId))) {
                delete t.worldBookId;
            }
        });
    }
    stripTemp(tempFriendData);
    stripTemp(tempGroupData);
}

function closeWorldBookDeleteConfirmModal() {
    const modal = document.getElementById('world-book-delete-confirm-modal');
    if (modal) modal.classList.remove('show');
}

function confirmDeleteSelectedWorldBooks() {
    const ids = Array.from(worldBookListDeleteSelectedIds, id => String(id));
    if (ids.length === 0 || !worldBookListSelectMode) {
        showNotification('请先勾选要删除的世界书');
        return;
    }
    const modal = document.getElementById('world-book-delete-confirm-modal');
    const msgEl = document.getElementById('world-book-delete-confirm-message');
    if (msgEl) {
        msgEl.textContent = '此操作不可逆，请慎重。将永久删除已选中的 ' + ids.length + ' 本世界书，且无法恢复。点「取消」不会删除任何内容。';
    }
    if (modal) modal.classList.add('show');
}

async function executeDeleteSelectedWorldBooks() {
    const ids = Array.from(worldBookListDeleteSelectedIds, id => String(id));
    closeWorldBookDeleteConfirmModal();
    if (ids.length === 0 || !worldBookListSelectMode) return;
    const data = getWorldBookData();
    const del = new Set(ids.map(String));
    data.entries = (data.entries || []).filter(e => !del.has(String(e.id)));
    if (!trySaveWorldBookDataWithNotify(data)) return;
    await removeWorldBookRefsFromStoredFriends(ids);
    worldBookListDeleteSelectedIds.clear();
    worldBookListSelectMode = false;
    const btn = document.getElementById('world-book-select-mode-btn');
    const booksContent = document.getElementById('books-content');
    if (btn) btn.classList.remove('world-book-select-mode-on');
    if (booksContent) booksContent.classList.remove('world-book-delete-mode');
    loadWorldBookList();
    updateWorldBookDeleteFabUI();
    showNotification('已删除选中的世界书');
}

let worldBookSelectSelectedIds = new Set();

function openSelectWorldBookModal() {
    const modal = document.getElementById('select-world-book-modal');
    const listEl = document.getElementById('world-book-select-list');
    const emptyEl = document.getElementById('world-book-select-empty');
    const footerEl = document.getElementById('world-book-select-footer');
    const friendSettingsModal = document.getElementById('friend-settings-modal');
    const groupSettingsModal = document.getElementById('group-settings-modal');
    const friendId =
        (friendSettingsModal && friendSettingsModal.classList.contains('show') && friendSettingsModal.dataset.friendId)
            ? friendSettingsModal.dataset.friendId
            : (groupSettingsModal && groupSettingsModal.classList.contains('show') ? groupSettingsModal.dataset.groupId : null);
    if (!modal || !listEl || !emptyEl || !friendId) return;

    const data = getWorldBookData();
    const entries = data.entries || [];
    const folders = data.folders || [];
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);

    let selectedIds = [];
    if (friend) {
        if (Array.isArray(friend.worldBookIds)) {
            selectedIds = friend.worldBookIds.filter(Boolean);
        } else if (friend.worldBookId) {
            selectedIds = [friend.worldBookId];
        }
    }
    worldBookSelectSelectedIds = new Set(selectedIds);

    modal.dataset.selectForFriendId = friendId;

    if (entries.length === 0) {
        listEl.style.display = 'none';
        emptyEl.style.display = 'block';
        if (footerEl) footerEl.style.display = 'none';
    } else {
        listEl.style.display = 'block';
        emptyEl.style.display = 'none';
        if (footerEl) footerEl.style.display = 'block';

        const byFolder = {};
        entries.forEach(entry => {
            const fid = entry.folderId || '';
            if (!byFolder[fid]) byFolder[fid] = [];
            byFolder[fid].push(entry);
        });
        const folderOrder = ['', ...folders.map(f => f.id)];

        listEl.innerHTML = folderOrder.map(fid => {
            const list = byFolder[fid] || [];
            if (list.length === 0) return '';
            const folder = folders.find(f => f.id === fid);
            const headerText = folder ? folder.name : '未分组';
            const folderHtmlId = 'wb-folder-' + (fid || 'ungrouped');
            return `
                <div class="world-book-select-folder" id="${folderHtmlId}" data-folder-id="${fid}">
                    <div class="world-book-select-folder-header" onclick="toggleWorldBookSelectFolder('${folderHtmlId}')">
                        <span>${escapeHtml(headerText)}</span>
                    </div>
                    <div class="world-book-select-folder-entries">
                        ${list.map(entry => `
                            <div class="world-book-select-item ${worldBookSelectSelectedIds.has(entry.id) ? 'checked' : ''}" 
                                onclick="if(!event.target.matches('input')) toggleWorldBookSelectItem('${entry.id}', this)">
                                <input type="checkbox" ${worldBookSelectSelectedIds.has(entry.id) ? 'checked' : ''} onchange="syncWorldBookSelectFromCheckbox('${entry.id}', this)">
                                <span class="world-book-item-title">${escapeHtml(entry.name || '未命名')}</span>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `;
        }).join('');
    }
    modal.classList.add('show');
}

function toggleWorldBookSelectFolder(folderHtmlId) {
    const el = document.getElementById(folderHtmlId);
    if (el) el.classList.toggle('expanded');
}

function toggleWorldBookSelectItem(entryId, el) {
    if (worldBookSelectSelectedIds.has(entryId)) {
        worldBookSelectSelectedIds.delete(entryId);
    } else {
        worldBookSelectSelectedIds.add(entryId);
    }
    const checkbox = el ? el.querySelector('input[type="checkbox"]') : null;
    if (checkbox) checkbox.checked = worldBookSelectSelectedIds.has(entryId);
    if (el) el.classList.toggle('checked', worldBookSelectSelectedIds.has(entryId));
}

function syncWorldBookSelectFromCheckbox(entryId, checkbox) {
    if (checkbox.checked) {
        worldBookSelectSelectedIds.add(entryId);
    } else {
        worldBookSelectSelectedIds.delete(entryId);
    }
    const el = checkbox ? checkbox.closest('.world-book-select-item') : null;
    if (el) el.classList.toggle('checked', checkbox.checked);
}

async function confirmSelectWorldBooksForFriend() {
    const modal = document.getElementById('select-world-book-modal');
    const friendId = modal ? modal.dataset.selectForFriendId : null;
    if (!friendId) return;

    const worldBookIds = Array.from(worldBookSelectSelectedIds);

    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}

    let friends = loadFriendsFromStorage();
    const idx = friends.findIndex(f => f.id == friendId);
    if (idx === -1) return;

    friends[idx].worldBookIds = worldBookIds;
    delete friends[idx].worldBookId;

    const data = getWorldBookData();
    const entries = data.entries || [];
    const names = worldBookIds.map(id => {
        const e = entries.find(x => x.id === id);
        return e ? e.name : '';
    }).filter(Boolean);
    const displayText = names.length > 0
        ? (names.length > 2 ? names.slice(0, 2).join('、') + ' 等' + (names.length - 2) + '本' : names.join('、'))
        : '点击选择 >';

    const friendSettingsModal = document.getElementById('friend-settings-modal');
    const groupSettingsModal = document.getElementById('group-settings-modal');
    const isGroup = !!(groupSettingsModal && groupSettingsModal.classList.contains('show') && groupSettingsModal.dataset.groupId === friendId);
    const displayEl = document.getElementById(isGroup ? 'group-selected-world-book-display' : 'selected-world-book-display');
    if (displayEl) displayEl.textContent = displayText;

    if (tempFriendData[friendId]) {
        tempFriendData[friendId].worldBookIds = worldBookIds;
        delete tempFriendData[friendId].worldBookId;
    }
    if (tempGroupData[friendId]) {
        tempGroupData[friendId].worldBookIds = worldBookIds;
        delete tempGroupData[friendId].worldBookId;
    }
    var wbOk =
        typeof saveFriendsToStorageAsync === 'function'
            ? await saveFriendsToStorageAsync(friends)
            : (function () {
                  try {
                      return saveFriendsToStorage(friends);
                  } catch (e) {
                      return false;
                  }
              })();
    if (wbOk === false) {
        showNotification('保存失败：好友列表可能过大，请清理存储后重试');
        return;
    }
    closeSelectWorldBookModal();
    showNotification(names.length > 0 ? `已配备 ${names.length} 本世界书` : '已取消配备');
}

function closeSelectWorldBookModal() {
    const modal = document.getElementById('select-world-book-modal');
    if (modal) {
        modal.classList.remove('show');
        delete modal.dataset.selectForFriendId;
    }
}

// 保存系统命令
function saveCommand() {
    if (!__SYSTEM_DEV_MODE__) { showNotification('此功能已锁定'); return; }
    const commandName = document.getElementById('command-name').value.trim();
    const commandContent = document.getElementById('command-content').value.trim();
    
    if (!commandName || !commandContent) {
        showNotification('请输入指令名称和命令详细内容');
        return;
    }
    
    // 保存命令到本地存储
    let commands;
    try {
        commands = JSON.parse(localStorage.getItem('systemCommands') || '[]');
        if (!Array.isArray(commands)) commands = [];
    } catch (e) {
        commands = [];
    }
    const modal = document.getElementById('add-command-modal');
    const commandId = modal ? modal.dataset.commandId : null;
    
    if (commandId) {
        // 更新现有指令
        const commandIndex = commands.findIndex(cmd => cmd.id == commandId);
        if (commandIndex !== -1) {
            commands[commandIndex].name = commandName;
            commands[commandIndex].content = commandContent;
            commands[commandIndex].userEdited = true;
            commands[commandIndex].userEditedAt = Date.now();
            localStorage.setItem('systemCommands', JSON.stringify(commands));
            // 确保同步到文件
            CommandManager.syncCommandsToFile(commands).then(success => {
                console.log('更新指令同步到文件:', success);
                // 关闭模态框
                closeAddCommandModal();
                // 更新指令列表
                loadCommandList();
            });
            showNotification('指令已更新');
        }
    } else {
        // 创建新指令
        const newCommand = {
            id: Date.now(),
            name: commandName,
            content: commandContent,
            createdAt: new Date().getTime(),
            active: true,
            userEdited: true,
            userEditedAt: Date.now()
        };
        
        commands.push(newCommand);
        localStorage.setItem('systemCommands', JSON.stringify(commands));
        // 确保同步到文件
        CommandManager.syncCommandsToFile(commands).then(success => {
            console.log('新建指令同步到文件:', success);
            // 关闭模态框
            closeAddCommandModal();
            // 更新指令列表
            loadCommandList();
        });
        showNotification('命令保存并执行成功');
        
        // 执行命令
        executeCommand(commandContent);
    }
}

// 加载指令列表
async function loadCommandList() {
    const commandList = document.getElementById('command-list');
    if (!commandList) return;
    
    // 只有在本地没有指令时，才从文件/API 拉取并合并；
    // 否则以本地为准，避免用户编辑后的指令被较旧的 system_commands.json 覆盖回滚。
    try {
        const stored = localStorage.getItem('systemCommands');
        const arr = stored ? JSON.parse(stored) : [];
        if (!Array.isArray(arr) || arr.length === 0) {
            await CommandManager.loadCommandsFromFile();
        }
    } catch (e) {
        await CommandManager.loadCommandsFromFile();
    }
    
    // 清空现有列表
    commandList.innerHTML = '';
    
    // 加载指令，优先使用localStorage中的指令，如果没有则使用硬编码的默认指令
    let commands;
    try {
        const storedCommands = localStorage.getItem('systemCommands');
        if (storedCommands) {
            commands = JSON.parse(storedCommands);
            if (!commands || commands.length === 0) {
                commands = DEFAULT_SYSTEM_COMMANDS;
            }
        } else {
            commands = DEFAULT_SYSTEM_COMMANDS;
        }
    } catch (e) {
        console.error('解析系统指令失败:', e);
        commands = DEFAULT_SYSTEM_COMMANDS;
    }
    
    // 按指令名称排序
    commands.sort((a, b) => a.name.localeCompare(b.name));
    
    if (commands.length === 0) {
        const emptyMessage = document.createElement('div');
        emptyMessage.className = 'empty-message';
        emptyMessage.textContent = '暂无保存的指令';
        emptyMessage.style.padding = '20px';
        emptyMessage.style.textAlign = 'center';
        emptyMessage.style.color = '#999';
        commandList.appendChild(emptyMessage);
        return;
    }
    
    // 添加指令到列表
    commands.forEach(command => {
        const commandItem = document.createElement('div');
        commandItem.className = 'command-item command-item-tappable';
        commandItem.setAttribute('role', 'button');
        commandItem.tabIndex = 0;
        commandItem.addEventListener('click', function (e) {
            if (e.target.closest('.command-actions')) return;
            editCommand(command);
        });
        commandItem.addEventListener('keydown', function (e) {
            if (e.target.closest('.command-actions')) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                editCommand(command);
            }
        });
        
        const commandInfo = document.createElement('div');
        commandInfo.className = 'command-info';
        
        const commandName = document.createElement('div');
        commandName.className = 'command-name';
        commandName.textContent = command.name;
        
        const commandStatus = document.createElement('div');
        commandStatus.className = `command-status ${command.active ? 'active' : ''}`;
        commandStatus.textContent = command.active ? '已激活' : '未激活';
        
        commandInfo.appendChild(commandName);
        commandInfo.appendChild(commandStatus);
        
        const commandActions = document.createElement('div');
        commandActions.className = 'command-actions';
        
        const toggleBtn = document.createElement('button');
        toggleBtn.type = 'button';
        toggleBtn.className = `command-btn ${command.active ? 'deactivate' : 'activate'}`;
        toggleBtn.textContent = command.active ? '停用' : '激活';
        toggleBtn.onclick = function (e) {
            e.stopPropagation();
            toggleCommandStatus(command.id);
        };
        
        const deleteBtn = document.createElement('button');
        deleteBtn.type = 'button';
        deleteBtn.className = 'command-btn delete';
        deleteBtn.textContent = '删除';
        // 使用立即执行函数创建闭包，确保每个按钮都能获取到正确的command.id
        (function(cmdId) {
            deleteBtn.onclick = function(e) {
                e.stopPropagation(); // 阻止事件冒泡
                deleteCommand(cmdId);
            };
        })(command.id);
        
        commandActions.appendChild(toggleBtn);
        commandActions.appendChild(deleteBtn);
        
        commandItem.appendChild(commandInfo);
        commandItem.appendChild(commandActions);
        
        commandList.appendChild(commandItem);
    });
}

// 切换指令状态
function toggleCommandStatus(commandId) {
    if (!__SYSTEM_DEV_MODE__) { showNotification('此功能已锁定'); return; }
    // 优先使用localStorage中的指令，如果没有则使用硬编码的默认指令
    let commands;
    try {
        const storedCommands = localStorage.getItem('systemCommands');
        if (storedCommands) {
            commands = JSON.parse(storedCommands);
            if (!commands || commands.length === 0) {
                commands = [...DEFAULT_SYSTEM_COMMANDS];
            }
        } else {
            commands = [...DEFAULT_SYSTEM_COMMANDS];
        }
    } catch (e) {
        console.error('解析系统指令失败:', e);
        commands = [...DEFAULT_SYSTEM_COMMANDS];
    }
    
    const commandIndex = commands.findIndex(cmd => cmd.id == commandId);

    if (commandIndex !== -1) {
        commands[commandIndex].active = !commands[commandIndex].active;
        commands[commandIndex].userEdited = true;
        commands[commandIndex].userEditedAt = Date.now();
        localStorage.setItem('systemCommands', JSON.stringify(commands));
        // 确保同步到文件
        CommandManager.syncCommandsToFile(commands).then(success => {
            console.log('切换指令状态同步到文件:', success);
            // 重新加载指令列表
            loadCommandList();
        });
        showNotification(`指令已${commands[commandIndex].active ? '激活' : '停用'}`);
    }
}

// 删除指令
function deleteCommand(commandId) {
    if (!__SYSTEM_DEV_MODE__) { showNotification('此功能已锁定'); return; }
    console.log('开始删除指令，指令ID:', commandId);
    
    // 弹出确认提示框
    var result = window.confirm('确定要删除这个指令吗？');
    console.log('用户确认结果:', result);
    
    // 确保只有用户明确点击确定后才执行删除操作
    if (result) {
        try {
            // 优先使用localStorage中的指令，如果没有则使用硬编码的默认指令
            let currentCommands;
            try {
                const storedCommands = localStorage.getItem('systemCommands');
                if (storedCommands) {
                    currentCommands = JSON.parse(storedCommands);
                    if (!currentCommands || currentCommands.length === 0) {
                        currentCommands = [...DEFAULT_SYSTEM_COMMANDS];
                    }
                } else {
                    currentCommands = [...DEFAULT_SYSTEM_COMMANDS];
                }
            } catch (e) {
                console.error('解析系统指令失败:', e);
                currentCommands = [...DEFAULT_SYSTEM_COMMANDS];
            }
            
            console.log('当前指令列表:', currentCommands);
            
            // 过滤掉要删除的指令
            var updatedCommands = currentCommands.filter(function(cmd) {
                console.log('比较指令ID:', cmd.id, '与', commandId, '是否相等:', cmd.id == commandId);
                return cmd.id != commandId;
            });
            console.log('过滤后的指令列表:', updatedCommands);
            
            // 保存更新后的指令列表
            localStorage.setItem('systemCommands', JSON.stringify(updatedCommands));
            console.log('保存更新后的指令列表成功');
            
            // 同步到文件
            CommandManager.syncCommandsToFile(updatedCommands).then(success => {
                console.log('删除指令同步到文件:', success);
                // 重新加载指令列表
                loadCommandList();
                console.log('重新加载指令列表成功');
            });
            
            // 显示删除成功提示
            showNotification('指令已删除');
            console.log('删除指令成功');
        } catch (error) {
            console.error('删除指令时出错:', error);
            showNotification('删除指令失败，请重试');
        }
    } else {
        // 用户点击取消，不执行任何操作
        console.log('用户取消删除操作');
        // 可以添加一个提示，告知用户操作已取消
        showNotification('删除操作已取消');
    }
}

// 编辑指令
function editCommand(command) {
    if (!__SYSTEM_DEV_MODE__) { showNotification('此功能已锁定'); return; }
    // 打开添加命令模态框
    const modal = document.getElementById('add-command-modal');
    if (modal) {
        modal.classList.add('show');
        
        // 填充当前指令的名称和内容
        document.getElementById('command-name').value = command.name;
        document.getElementById('command-content').value = command.content;
        
        // 保存当前编辑的指令ID
        modal.dataset.commandId = command.id;
    }
}

// 执行系统命令
function executeCommand(commandContent) {
    // 解析命令内容并执行相应的功能
    if (commandContent.includes('允许后台运行小手机')) {
        // 激活后台运行功能
        enableBackgroundMode();
    }
    // 可以添加更多命令解析逻辑
}

// 获取激活的指令
function getActiveCommands() {
    let commands;
    try {
        commands = JSON.parse(localStorage.getItem('systemCommands') || '[]');
        if (!Array.isArray(commands)) commands = [];
    } catch (e) {
        commands = [];
    }
    return commands.filter(cmd => cmd.active);
}

// 获取核心指令（永久激活的指令）
function getCoreCommands() {
    let commands;
    try {
        commands = JSON.parse(localStorage.getItem('systemCommands') || '[]');
        if (!Array.isArray(commands)) commands = [];
    } catch (e) {
        commands = [];
    }
    return commands.filter(cmd => cmd.name === '核心指令' && cmd.content.includes('永久激活') && cmd.active);
}

// 构建发送内容（按照优先级顺序）
function buildSendContent(functionalContent) {
    const content = [];
    
    // 1. 添加核心指令（最高优先级）
    const coreCommands = getCoreCommands();
    coreCommands.forEach(cmd => {
        content.push(cmd.content);
    });
    
    // 2. 添加其他激活的指令
    const activeCommands = getActiveCommands().filter(cmd => cmd.name !== '核心指令' || !cmd.content.includes('永久激活'));
    activeCommands.forEach(cmd => {
        content.push(cmd.content);
    });
    
    // 3. 添加功能相关内容
    if (functionalContent) {
        content.push(functionalContent);
    }
    
    return content.join('\n');
}

// 启用后台运行模式
function enableBackgroundMode() {
    // 模拟启用后台运行功能
    console.log('启用后台运行模式');
    showNotification('已启用后台运行模式');
    
    // 这里可以添加实际的后台运行逻辑
    // 例如使用 Service Worker 或其他技术实现
}

// 显示消息通知
function showNotification(message) {
    // 只对特定操作进行通知
    const allowedNotifications = [
        '你拍了拍',
        '打开与',
        '好友添加成功',
        '聊天背景已更新',
        '已置顶聊天',
        '已取消置顶',
        '聊天记录已清空',
        '已加入黑名单',
        '已移除黑名单',
        '聊天已删除',
        '头像已更新',
        '数据导入成功',
        '数据导入失败',
        '导入失败',
        '导入数据失败',
        '导入格式错误',
        '用户数据错误无法识别',
        '数据已全部导出',
        '数据导出失败',
        '读取文件失败',
        '已删除',
        '成功添加',
        '已存在',
        '数据已全部清除'
        ,
        // 朋友圈相关（公开域名首次打开常为空，必须能提示原因）
        '系统未加载朋友圈刷新模块',
        '没有可生成动态的好友',
        '未能解析模型返回的朋友圈 JSON',
        '好友朋友圈已更新',
        '请先在设置中填写API配置',
        'API',
        '模型'
        ,
        // 群聊
        '群聊创建成功',
        '请选择至少2位好友',
        // 红包
        '收到红包',
        '已收款',
        '已拒绝',
        // 个人资料 / 人设（须在白名单内，否则 showNotification 会直接丢弃，用户误以为保存无效）
        '个人资料已更新',
        '请输入昵称',
        '保存失败',
        '人设信息已更新',
        // Lego 小手机 / 查手机（原先多条提示未列入白名单，真机上会「点了像没反应」）
        '已刷新',
        '刷新失败',
        '已重置',
        '发来一条消息',
        '功能开发中',
        '浏览器已禁止本站通知'
    ];
    
    // 检查消息是否属于允许的通知类型
    const isAllowed = allowedNotifications.some(allowed => message.includes(allowed));
    
    // 只显示允许的通知
    if (!isAllowed) {
        return;
    }
    
    // 创建通知元素
    const notification = document.createElement('div');
    notification.className = 'notification';
    notification.textContent = message;
    
    // 添加到页面
    document.body.appendChild(notification);
    
    // 添加动画效果
    setTimeout(() => {
        notification.classList.add('show');
    }, 10);
    
    // 3秒后移除
    setTimeout(() => {
        notification.classList.remove('show');
        setTimeout(() => {
            notification.remove();
        }, 300);
    }, 3000);
}

// 预加载：让 momentsPosts（若落在 IndexedDB）能尽快显示
try {
    if (document && typeof document.addEventListener === 'function') {
        document.addEventListener('DOMContentLoaded', () => {
            Moments.store.preloadMomentsPostsFromIdbIfNeeded();
        });
    }
} catch (e) {}

// ========== 音乐播放器 ==========
const MUSIC_DB_NAME = 'LegoMusicDB';
const MUSIC_DB_VERSION = 2;
const MUSIC_STORE_NAME = 'playlist';
const MUSIC_PLAYLIST_KEY = 'playlist';
const MUSIC_ONLINE_SEARCH_LIMIT = 20;
const MUSIC_ONLINE_REQUEST_TIMEOUT_MS = 30000;
const MUSIC_ONLINE_DOWNLOAD_TIMEOUT_MS = 120000;
const MUSIC_AUDIO_EXT_RE = /\.(mp3|wav|ogg|m4a|aac|flac)$/i;
let musicPlaylistPersistQueue = Promise.resolve();
const MusicOnlineSearchState = {
    results: [],
    searchController: null,
    downloadController: null,
    activeDownloadKey: '',
    searchSequence: 0,
    downloadSequence: 0
};

function buildPersistedMusicTrack(track) {
    const t = track || {};
    const obj = {
        id: t.id,
        title: t.title,
        artist: t.artist,
        album: t.album || '',
        cover: t.cover || null,
        lyrics: t.lyrics || '',
        remoteId: t.remoteId || '',
        remoteSource: t.remoteSource || '',
        cachedAt: Number(t.cachedAt) || 0,
        localFileKey: t.localFileKey || '',
        byteSize: Number(t.byteSize) || (t.blob && Number(t.blob.size)) || 0
    };
    if (t.blob) obj.blob = t.blob;
    else if (t.fileMissing) obj.fileMissing = true;
    return obj;
}

function openMusicDB() {
    return new Promise((resolve, reject) => {
        if (typeof indexedDB === 'undefined') {
            reject(new Error('IndexedDB not supported'));
            return;
        }
        const req = indexedDB.open(MUSIC_DB_NAME, MUSIC_DB_VERSION);
        req.onerror = () => reject(req.error);
        req.onsuccess = () => resolve(req.result);
        req.onupgradeneeded = (e) => {
            const db = e.target.result;
            if (!db.objectStoreNames.contains(MUSIC_STORE_NAME)) {
                db.createObjectStore(MUSIC_STORE_NAME);
            }
        };
    });
}

function savePlaylistToIndexedDB() {
    const commit = () => {
        // 在队列真正执行时读取最新列表，避免较慢的旧快照覆盖刚完成的添加/删除。
        const tracks = MusicPlayer.playlist.map(buildPersistedMusicTrack);
        const meta = tracks.map(t => ({
            id: t.id,
            title: t.title,
            artist: t.artist,
            album: t.album || '',
            remoteId: t.remoteId || '',
            remoteSource: t.remoteSource || '',
            localFileKey: t.localFileKey || '',
            byteSize: t.byteSize || 0
        }));
        return openMusicDB().then(db => {
            return new Promise((resolve, reject) => {
                const tx = db.transaction(MUSIC_STORE_NAME, 'readwrite');
                const store = tx.objectStore(MUSIC_STORE_NAME);
                store.put({ key: MUSIC_PLAYLIST_KEY, tracks }, MUSIC_PLAYLIST_KEY);
                tx.oncomplete = () => { db.close(); resolve(); };
                tx.onerror = () => { db.close(); reject(tx.error); };
                tx.onabort = () => { db.close(); reject(tx.error || new Error('音乐数据库写入已中止')); };
            });
        }).then(() => {
            try {
                localStorage.setItem('musicPlaylistMeta', JSON.stringify(meta));
            } catch (e) {}
            return true;
        }).catch(e => {
            console.warn('保存播放列表失败:', e);
            return false;
        });
    };
    const pending = musicPlaylistPersistQueue.then(commit, commit);
    musicPlaylistPersistQueue = pending.then(() => undefined, () => undefined);
    return pending;
}

function loadPlaylistFromIndexedDB() {
    if (typeof indexedDB === 'undefined') {
        return Promise.resolve(loadPlaylistFromLocalStorageFallback());
    }
    return openMusicDB().then(db => {
        return new Promise((resolve, reject) => {
            const tx = db.transaction(MUSIC_STORE_NAME, 'readonly');
            const req = tx.objectStore(MUSIC_STORE_NAME).get(MUSIC_PLAYLIST_KEY);
            req.onsuccess = () => {
                db.close();
                const data = req.result;
                const tracks = (data && data.tracks) || [];
                if (tracks.length === 0) {
                    const fallback = loadPlaylistFromLocalStorageFallback();
                    resolve(fallback);
                    return;
                }
                const restored = tracks.map(t => {
                    const track = {
                        id: t.id,
                        title: t.title || '未知',
                        artist: t.artist || '未知',
                        album: t.album || '',
                        cover: t.cover || null,
                        lyrics: t.lyrics || '',
                        remoteId: t.remoteId || '',
                        remoteSource: t.remoteSource || '',
                        cachedAt: Number(t.cachedAt) || 0,
                        localFileKey: t.localFileKey || '',
                        byteSize: Number(t.byteSize) || (t.blob && Number(t.blob.size)) || 0
                    };
                    if (t.blob) {
                        track.blob = t.blob;
                        track.src = URL.createObjectURL(t.blob);
                    } else {
                        track.fileMissing = true;
                        track.src = null;
                    }
                    return track;
                });
                resolve(restored);
            };
            req.onerror = () => {
                db.close();
                resolve(loadPlaylistFromLocalStorageFallback());
            };
        });
    }).catch(() => loadPlaylistFromLocalStorageFallback());
}

function loadPlaylistFromLocalStorageFallback() {
    try {
        const meta = localStorage.getItem('musicPlaylistMeta');
        if (!meta) return [];
        const list = JSON.parse(meta);
        return list.map(t => ({
            id: t.id,
            title: t.title || '未知',
            artist: t.artist || '未知',
            album: t.album || '',
            cover: null,
            lyrics: '',
            remoteId: t.remoteId || '',
            remoteSource: t.remoteSource || '',
            localFileKey: t.localFileKey || '',
            byteSize: Number(t.byteSize) || 0,
            fileMissing: true,
            src: null
        }));
    } catch (e) {
        return [];
    }
}

function initMusicPlayer() {
    MusicPlayer.audio = new Audio();
    MusicPlayer.audio.addEventListener('ended', () => {
        musicNext();
    });
    MusicPlayer.audio.addEventListener('timeupdate', updateMusicProgress);
    MusicPlayer.audio.addEventListener('loadedmetadata', () => {
        updateMusicProgress();
    });
    try {
        const saved = localStorage.getItem('musicPlayerCover');
        if (saved && String(saved).trim()) MusicPlayer.customCover = saved;
        const vol = localStorage.getItem('musicVolume');
        if (vol != null) {
            MusicPlayer.volume = Math.max(0, Math.min(1, parseFloat(vol)));
        }
        MusicPlayer.audio.volume = MusicPlayer.volume;
        const slider = document.getElementById('music-volume-slider');
        if (slider) slider.value = Math.round(MusicPlayer.volume * 100);
    } catch (e) {}
    loadPlaylistFromIndexedDB().then(tracks => {
        MusicPlayer.playlist = tracks || [];
        if (MusicPlayer.playlist.length > 0 && MusicPlayer.currentIndex < 0) {
            MusicPlayer.currentIndex = 0;
        }
        updateMusicUI();
    }).catch(() => updateMusicUI());
    document.addEventListener('keydown', handleMusicModalKeydown);
}

function parseFilenameForTrack(name) {
    const base = (name || '').replace(/\.[^.]+$/, '').trim();
    const sep = base.includes(' - ') ? ' - ' : (base.includes('-') ? '-' : null);
    if (sep) {
        const p = base.split(sep, 2);
        return { title: (p[0] || '').trim() || base, artist: (p[1] || '').trim() || '未知' };
    }
    return { title: base || '未知', artist: '未知' };
}

function handleMusicCoverUpload(event) {
    const files = event.target.files;
    if (!files || files.length === 0) return;
    const file = files[0];
    if (!isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function () {
        (async function () {
            const raw = reader.result;
            const coverOpts = { maxDim: 1024, quality: 0.82, mime: 'image/jpeg' };
            let dataUrl = raw;
            try {
                if (typeof compressDataUrlImage === 'function') {
                    dataUrl = await compressDataUrlImage(String(raw), coverOpts);
                }
            } catch (e) {
                dataUrl = raw;
            }
            let stored = dataUrl;
            try {
                if (typeof setLocalStorageStringWithQuotaFallback === 'function') {
                    stored = await setLocalStorageStringWithQuotaFallback(MUSIC_PLAYER_COVER_LS_KEY, dataUrl, coverOpts);
                } else {
                    localStorage.setItem(MUSIC_PLAYER_COVER_LS_KEY, dataUrl);
                }
            } catch (e) {
                console.warn('音乐封面写入存储失败', e);
                stored = '';
            }
            MusicPlayer.customCover = stored && String(stored).trim() ? stored : dataUrl;
            updateMusicUI();
            if (stored && String(stored).trim()) {
                showNotification('封面已更新');
            } else {
                showNotification('封面已应用（本页有效）。存储空间不足或图片过大，刷新后可能丢失，请换小图重试');
            }
        })();
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function getLocalMusicFileKey(file) {
    return `local:${String(file && file.name || '').toLowerCase()}:${Number(file && file.size) || 0}:${Number(file && file.lastModified) || 0}`;
}

function isSupportedLocalMusicFile(file) {
    if (!file || !file.name) return false;
    const type = String(file.type || '').toLowerCase();
    return MUSIC_AUDIO_EXT_RE.test(file.name) || type.startsWith('audio/');
}

function validateMusicBlobPlayable(blob, timeoutMs) {
    return new Promise((resolve) => {
        if (!blob || !blob.size) {
            resolve(false);
            return;
        }
        const audio = new Audio();
        const objectUrl = URL.createObjectURL(blob);
        let settled = false;
        const finish = (ok) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            audio.removeAttribute('src');
            try { audio.load(); } catch (e) {}
            URL.revokeObjectURL(objectUrl);
            resolve(!!ok);
        };
        const timer = setTimeout(() => finish(false), Math.max(3000, Number(timeoutMs) || 12000));
        audio.preload = 'metadata';
        audio.addEventListener('loadedmetadata', () => finish(true), { once: true });
        audio.addEventListener('canplay', () => finish(true), { once: true });
        audio.addEventListener('error', () => finish(false), { once: true });
        audio.src = objectUrl;
        try { audio.load(); } catch (e) { finish(false); }
    });
}

async function handleMusicUpload(event) {
    const input = event && event.target;
    const files = input && input.files ? Array.from(input.files) : [];
    if (input) input.value = '';
    closeMusicAddMenu();
    if (files.length === 0) return;

    const existingKeys = new Set(MusicPlayer.playlist.map(t => t.localFileKey).filter(Boolean));
    const pendingKeys = new Set();
    const accepted = [];
    let oversized = 0;
    let unsupported = 0;
    let duplicate = 0;

    files.forEach((file) => {
        const key = getLocalMusicFileKey(file);
        if (!isSupportedLocalMusicFile(file) || !file.size) {
            unsupported++;
            return;
        }
        if (file.size > MAX_MUSIC_SIZE_MB * 1024 * 1024) {
            oversized++;
            return;
        }
        if (existingKeys.has(key) || pendingKeys.has(key)) {
            duplicate++;
            return;
        }
        pendingKeys.add(key);
        accepted.push({ file, key });
    });

    if (accepted.length === 0) {
        const reasons = [];
        if (duplicate) reasons.push(`${duplicate} 首重复`);
        if (oversized) reasons.push(`${oversized} 首超过 ${MAX_MUSIC_SIZE_MB}MB`);
        if (unsupported) reasons.push(`${unsupported} 个文件格式不支持或为空`);
        showNotification(reasons.length ? `未添加：${reasons.join('，')}` : '没有可添加的音频文件');
        return;
    }

    showNotification('正在检查并缓存本地音频…');
    const checked = await Promise.all(accepted.map(async (item) => ({
        item,
        playable: await validateMusicBlobPlayable(item.file, 12000)
    })));
    const playable = checked.filter(row => row.playable).map(row => row.item);
    unsupported += checked.length - playable.length;
    if (playable.length === 0) {
        showNotification('所选文件无法被当前设备解码，请改用 MP3、M4A、WAV、AAC、OGG 或 FLAC');
        return;
    }

    const previousIndex = MusicPlayer.currentIndex;
    const addedTracks = playable.map(({ file, key }, index) => {
        const meta = parseFilenameForTrack(file.name);
        return {
            id: Date.now() + '_' + index + '_' + Math.random().toString(36).slice(2),
            blob: file,
            src: URL.createObjectURL(file),
            title: meta.title,
            artist: meta.artist,
            album: '',
            cover: null,
            lyrics: '',
            localFileKey: key,
            byteSize: file.size,
            cachedAt: Date.now()
        };
    });
    MusicPlayer.playlist.push(...addedTracks);
    if (MusicPlayer.currentIndex < 0) MusicPlayer.currentIndex = 0;

    const saved = await savePlaylistToIndexedDB();
    if (!saved) {
        const ids = new Set(addedTracks.map(t => t.id));
        MusicPlayer.playlist = MusicPlayer.playlist.filter(t => !ids.has(t.id));
        addedTracks.forEach(t => { if (t.src) URL.revokeObjectURL(t.src); });
        MusicPlayer.currentIndex = previousIndex;
        updateMusicUI();
        showNotification('添加失败：本地音乐数据库不可用或存储空间不足');
        return;
    }

    updateMusicUI();
    const notes = [];
    if (duplicate) notes.push(`${duplicate} 首重复已跳过`);
    if (oversized) notes.push(`${oversized} 首超过 ${MAX_MUSIC_SIZE_MB}MB`);
    if (unsupported) notes.push(`${unsupported} 首无法解码`);
    showNotification(`已缓存 ${addedTracks.length} 首歌曲${notes.length ? `（${notes.join('，')}）` : ''}`);
}

function loadAndPlayTrack(index) {
    const t = MusicPlayer.playlist[index];
    if (!t) return;
    if (t.fileMissing || !t.src) {
        showNotification('未能找到本地文件，请重新导入歌曲');
        return;
    }
    if (MusicPlayer.audio.src) MusicPlayer.audio.pause();
    MusicPlayer.audio.src = t.src;
    MusicPlayer.audio.load();
    MusicPlayer.audio.play().catch(() => {});
    MusicPlayer.isPlaying = true;
    MusicPlayer.currentIndex = index;
    updateMusicUI();
    updateMusicPlayPauseBtn();
}

function toggleMusicPlay() {
    if (MusicPlayer.playlist.length === 0) {
        showNotification('请先添加音乐');
        return;
    }
    if (MusicPlayer.currentIndex < 0) {
        MusicPlayer.currentIndex = 0;
    }
    if (!MusicPlayer.audio.src || (MusicPlayer.currentTrack && MusicPlayer.audio.src !== MusicPlayer.currentTrack.src)) {
        if (MusicPlayer.currentTrack && (MusicPlayer.currentTrack.fileMissing || !MusicPlayer.currentTrack.src)) {
            showNotification('未能找到本地文件，请重新导入歌曲');
            return;
        }
        loadAndPlayTrack(MusicPlayer.currentIndex);
        return;
    }
    if (MusicPlayer.isPlaying) {
        MusicPlayer.audio.pause();
        MusicPlayer.isPlaying = false;
    } else {
        MusicPlayer.audio.play().catch(() => {});
        MusicPlayer.isPlaying = true;
    }
    updateMusicPlayPauseBtn();
    if (listenTogetherActive) updateDynamicIslandUI();
}

function musicPrev() {
    if (MusicPlayer.playlist.length === 0) return;
    const idx = MusicPlayer.currentIndex <= 0 ? MusicPlayer.playlist.length - 1 : MusicPlayer.currentIndex - 1;
    loadAndPlayTrack(idx);
}

function musicNext() {
    if (MusicPlayer.playlist.length === 0) return;
    let idx;
    if (MusicPlayer.repeat === 1) {
        idx = MusicPlayer.currentIndex;
    } else {
        idx = MusicPlayer.currentIndex >= MusicPlayer.playlist.length - 1 ? 0 : MusicPlayer.currentIndex + 1;
    }
    loadAndPlayTrack(idx);
}

function toggleMusicRepeat(e) {
    if (e) e.stopPropagation();
    MusicPlayer.repeat = (MusicPlayer.repeat + 1) % 3;
    const el = document.getElementById('music-repeat-btn');
    if (el) {
        el.textContent = '↻';
        el.title = MusicPlayer.repeat === 0 ? '循环' : (MusicPlayer.repeat === 1 ? '单曲循环' : '列表循环');
        el.classList.toggle('active', MusicPlayer.repeat > 0);
    }
}

function openMusicPlaylistModal() {
    renderMusicPlaylist();
    const modal = document.getElementById('music-playlist-modal');
    if (modal) modal.classList.add('show');
}

function closeMusicPlaylistModal() {
    const modal = document.getElementById('music-playlist-modal');
    if (modal) modal.classList.remove('show');
}

function openMusicAddMenu() {
    const modal = document.getElementById('music-add-source-modal');
    if (!modal) return;
    modal.classList.add('show');
    setTimeout(() => {
        const first = modal.querySelector('.music-add-source-option');
        if (first) first.focus();
    }, 0);
}

function closeMusicAddMenu() {
    const modal = document.getElementById('music-add-source-modal');
    if (modal) modal.classList.remove('show');
}

function chooseLocalMusicUpload() {
    closeMusicAddMenu();
    const input = document.getElementById('music-upload-input');
    if (input) input.click();
}

function openMusicOnlineSearch() {
    closeMusicAddMenu();
    const modal = document.getElementById('music-online-search-modal');
    if (!modal) return;
    modal.classList.add('show');
    renderMusicOnlineResults();
    setTimeout(() => {
        const titleInput = document.getElementById('music-search-title');
        if (titleInput) titleInput.focus();
    }, 0);
}

function closeMusicOnlineSearch() {
    const modal = document.getElementById('music-online-search-modal');
    if (modal) modal.classList.remove('show');
    MusicOnlineSearchState.searchSequence++;
    MusicOnlineSearchState.downloadSequence++;
    if (MusicOnlineSearchState.searchController) MusicOnlineSearchState.searchController.abort();
    if (MusicOnlineSearchState.downloadController) MusicOnlineSearchState.downloadController.abort();
    MusicOnlineSearchState.searchController = null;
    MusicOnlineSearchState.downloadController = null;
    const searchButton = document.getElementById('music-online-search-btn');
    if (searchButton) searchButton.disabled = false;
}

function backToMusicAddMenu() {
    closeMusicOnlineSearch();
    openMusicAddMenu();
}

function handleMusicModalKeydown(event) {
    if (!event || event.key !== 'Escape') return;
    const searchModal = document.getElementById('music-online-search-modal');
    if (searchModal && searchModal.classList.contains('show')) {
        event.preventDefault();
        closeMusicOnlineSearch();
        return;
    }
    const sourceModal = document.getElementById('music-add-source-modal');
    if (sourceModal && sourceModal.classList.contains('show')) {
        event.preventDefault();
        closeMusicAddMenu();
        return;
    }
    const playlistModal = document.getElementById('music-playlist-modal');
    if (playlistModal && playlistModal.classList.contains('show')) {
        event.preventDefault();
        closeMusicPlaylistModal();
    }
}

function setMusicOnlineStatus(message, isError) {
    const el = document.getElementById('music-online-search-status');
    if (!el) return;
    el.textContent = String(message || '');
    el.classList.toggle('is-error', !!isError);
}

function findCachedOnlineMusic(result) {
    const id = String(result && result.id || '');
    const source = String(result && result.source || 'netease');
    return MusicPlayer.playlist.find(t => String(t.remoteId || '') === id && String(t.remoteSource || '') === source) || null;
}

function renderMusicOnlineResults() {
    const list = document.getElementById('music-online-results');
    if (!list) return;
    const activeKey = MusicOnlineSearchState.activeDownloadKey;
    list.innerHTML = MusicOnlineSearchState.results.map((result, index) => {
        const key = String(result.source || 'netease') + ':' + String(result.id || '');
        const added = !!findCachedOnlineMusic(result);
        const downloading = key === activeKey;
        const disabled = added || !!activeKey;
        const artist = result.artist || '未知歌手';
        const album = result.album ? ` · ${result.album}` : '';
        return `<div class="music-online-result${added ? ' is-added' : ''}">
            <div class="music-online-result-copy">
                <div class="music-online-result-title">${escapeHtml(result.title || '未知歌曲')}</div>
                <div class="music-online-result-meta">${escapeHtml(artist + album)}</div>
            </div>
            <button class="music-online-result-add" type="button" onclick="cacheOnlineMusic(${index})"${disabled ? ' disabled' : ''}>${added ? '已缓存' : (downloading ? '缓存中…' : '缓存并添加')}</button>
        </div>`;
    }).join('');
}

async function readMusicApiError(response, fallback) {
    try {
        const data = await response.json();
        return String(data && (data.error || data.message) || fallback);
    } catch (e) {
        return fallback;
    }
}

async function searchOnlineMusic(event) {
    if (event) event.preventDefault();
    const titleInput = document.getElementById('music-search-title');
    const artistInput = document.getElementById('music-search-artist');
    const button = document.getElementById('music-online-search-btn');
    const title = String(titleInput && titleInput.value || '').trim();
    const artist = String(artistInput && artistInput.value || '').trim();
    if (!title && !artist) {
        setMusicOnlineStatus('请至少输入歌名或歌手名称', true);
        if (titleInput) titleInput.focus();
        return;
    }

    if (MusicOnlineSearchState.searchController) MusicOnlineSearchState.searchController.abort();
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const sequence = ++MusicOnlineSearchState.searchSequence;
    MusicOnlineSearchState.searchController = controller;
    MusicOnlineSearchState.results = [];
    renderMusicOnlineResults();
    if (button) button.disabled = true;
    setMusicOnlineStatus('正在联网搜索…', false);
    const timer = controller ? setTimeout(() => controller.abort(), MUSIC_ONLINE_REQUEST_TIMEOUT_MS) : null;

    try {
        const params = new URLSearchParams({ title, artist, limit: String(MUSIC_ONLINE_SEARCH_LIMIT) });
        const options = controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' };
        const response = await fetch('/api/music/search?' + params.toString(), options);
        if (sequence !== MusicOnlineSearchState.searchSequence) return;
        if (!response.ok) throw new Error(await readMusicApiError(response, `搜索服务返回 ${response.status}`));
        const data = await response.json();
        if (sequence !== MusicOnlineSearchState.searchSequence) return;
        const results = Array.isArray(data && data.results) ? data.results.slice(0, MUSIC_ONLINE_SEARCH_LIMIT) : [];
        MusicOnlineSearchState.results = results.filter(row => row && row.id && row.title).map(row => ({
            id: String(row.id),
            source: String(row.source || 'netease'),
            title: String(row.title || '未知歌曲'),
            artist: String(row.artist || '未知歌手'),
            album: String(row.album || '')
        }));
        renderMusicOnlineResults();
        setMusicOnlineStatus(
            MusicOnlineSearchState.results.length ? `找到 ${MusicOnlineSearchState.results.length} 首，选择歌曲缓存` : '未找到匹配歌曲，请调整歌名或歌手',
            false
        );
    } catch (error) {
        if (sequence !== MusicOnlineSearchState.searchSequence) return;
        if (error && error.name === 'AbortError') {
            setMusicOnlineStatus('搜索超时或已取消，请重试', true);
        } else {
            console.warn('联网搜索歌曲失败:', error);
            setMusicOnlineStatus(`搜索失败：${error && error.message ? error.message : '请确认本地服务和网络连接正常'}`, true);
        }
    } finally {
        if (timer) clearTimeout(timer);
        if (MusicOnlineSearchState.searchController === controller) MusicOnlineSearchState.searchController = null;
        if (button && sequence === MusicOnlineSearchState.searchSequence) button.disabled = false;
    }
}

async function cacheOnlineMusic(index) {
    const result = MusicOnlineSearchState.results[index];
    if (!result || MusicOnlineSearchState.activeDownloadKey) return;
    const duplicate = findCachedOnlineMusic(result);
    if (duplicate) {
        setMusicOnlineStatus('这首歌曲已经缓存到播放列表', false);
        renderMusicOnlineResults();
        return;
    }

    const key = String(result.source || 'netease') + ':' + String(result.id);
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const sequence = ++MusicOnlineSearchState.downloadSequence;
    MusicOnlineSearchState.downloadController = controller;
    MusicOnlineSearchState.activeDownloadKey = key;
    renderMusicOnlineResults();
    setMusicOnlineStatus(`正在缓存《${result.title}》，请稍候…`, false);
    const timer = controller ? setTimeout(() => controller.abort(), MUSIC_ONLINE_DOWNLOAD_TIMEOUT_MS) : null;
    let objectUrl = '';
    let addedTrack = null;
    const previousIndex = MusicPlayer.currentIndex;

    try {
        const params = new URLSearchParams({ id: String(result.id), source: String(result.source || 'netease') });
        const options = controller ? { signal: controller.signal, cache: 'no-store' } : { cache: 'no-store' };
        const response = await fetch('/api/music/audio?' + params.toString(), options);
        if (sequence !== MusicOnlineSearchState.downloadSequence) return;
        if (!response.ok) throw new Error(await readMusicApiError(response, `音频服务返回 ${response.status}`));
        const declaredSize = Number(response.headers.get('content-length')) || 0;
        if (declaredSize > MAX_MUSIC_SIZE_MB * 1024 * 1024) {
            throw new Error(`音频超过 ${MAX_MUSIC_SIZE_MB}MB 缓存上限`);
        }
        const blob = await response.blob();
        if (sequence !== MusicOnlineSearchState.downloadSequence) return;
        if (!blob.size) throw new Error('没有收到有效音频数据');
        if (blob.size > MAX_MUSIC_SIZE_MB * 1024 * 1024) {
            throw new Error(`音频超过 ${MAX_MUSIC_SIZE_MB}MB 缓存上限`);
        }
        const playable = await validateMusicBlobPlayable(blob, 15000);
        if (sequence !== MusicOnlineSearchState.downloadSequence) return;
        if (!playable) throw new Error('当前设备无法解码这首歌曲的音频格式');
        if (findCachedOnlineMusic(result)) {
            setMusicOnlineStatus('这首歌曲已经由另一个操作缓存完成', false);
            return;
        }

        objectUrl = URL.createObjectURL(blob);
        addedTrack = {
            id: `online_${result.source}_${result.id}`,
            blob,
            src: objectUrl,
            title: result.title,
            artist: result.artist,
            album: result.album || '',
            cover: null,
            lyrics: '',
            remoteId: String(result.id),
            remoteSource: String(result.source || 'netease'),
            byteSize: blob.size,
            cachedAt: Date.now()
        };
        MusicPlayer.playlist.push(addedTrack);
        if (MusicPlayer.currentIndex < 0) MusicPlayer.currentIndex = 0;
        const saved = await savePlaylistToIndexedDB();
        if (!saved) {
            MusicPlayer.playlist = MusicPlayer.playlist.filter(t => t !== addedTrack);
            MusicPlayer.currentIndex = previousIndex;
            URL.revokeObjectURL(objectUrl);
            objectUrl = '';
            addedTrack = null;
            throw new Error('本地存储空间不足或音乐数据库不可用');
        }

        updateMusicUI();
        renderMusicPlaylist();
        if (sequence === MusicOnlineSearchState.downloadSequence) {
            setMusicOnlineStatus(`《${result.title}》已缓存并加入播放列表`, false);
        }
        showNotification('歌曲已缓存到本地');
    } catch (error) {
        if (addedTrack) {
            MusicPlayer.playlist = MusicPlayer.playlist.filter(t => t !== addedTrack);
            MusicPlayer.currentIndex = previousIndex;
        }
        if (objectUrl) URL.revokeObjectURL(objectUrl);
        if (sequence !== MusicOnlineSearchState.downloadSequence) {
            // 用户关闭或切换了当前搜索，旧任务只做清理，不覆盖新界面的状态。
        } else if (error && error.name === 'AbortError') {
            setMusicOnlineStatus('缓存超时或已取消，请重试', true);
        } else {
            console.warn('缓存联网歌曲失败:', error);
            setMusicOnlineStatus(`缓存失败：${error && error.message ? error.message : '未知错误'}`, true);
        }
        updateMusicUI();
    } finally {
        if (timer) clearTimeout(timer);
        if (MusicOnlineSearchState.downloadController === controller) MusicOnlineSearchState.downloadController = null;
        if (MusicOnlineSearchState.activeDownloadKey === key) MusicOnlineSearchState.activeDownloadKey = '';
        renderMusicOnlineResults();
    }
}

function renderMusicPlaylist() {
    const listEl = document.getElementById('music-playlist-list');
    const emptyEl = document.getElementById('music-playlist-empty');
    if (!listEl) return;
    if (MusicPlayer.playlist.length === 0) {
        listEl.innerHTML = '';
        if (emptyEl) emptyEl.style.display = 'block';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.innerHTML = MusicPlayer.playlist.map((t, i) => {
        const active = i === MusicPlayer.currentIndex ? ' active' : '';
        const missing = t.fileMissing ? ' music-playlist-item-missing' : '';
        const titleAttr = escapeHtml(t.title).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
        return `<div class="music-playlist-item${active}${missing}" data-index="${i}" role="button" tabindex="0"${active ? ' aria-current="true"' : ''} aria-label="选择 ${titleAttr}" onclick="selectPlaylistTrack(${i}, true)" onkeydown="handleMusicPlaylistItemKeydown(event, ${i})">
            <span class="music-playlist-item-index">${i + 1}</span>
            <div class="music-playlist-item-info">
                <div class="music-playlist-item-title">${escapeHtml(t.title)}${t.fileMissing ? ' (文件缺失)' : ''}</div>
                <div class="music-playlist-item-artist">${escapeHtml(t.artist)}</div>
            </div>
            <button class="music-playlist-item-delete" type="button" onclick="deletePlaylistTrack(${i}, event)" aria-label="删除 ${titleAttr}" title="删除">×</button>
        </div>`;
    }).join('');
}

function handleMusicPlaylistItemKeydown(event, index) {
    if (!event || event.target !== event.currentTarget || (event.key !== 'Enter' && event.key !== ' ')) return;
    event.preventDefault();
    selectPlaylistTrack(index, true);
}

function selectPlaylistTrack(index, closeModal) {
    if (index >= 0 && index < MusicPlayer.playlist.length) {
        const t = MusicPlayer.playlist[index];
        if (t.fileMissing || !t.src) {
            showNotification('未能找到本地文件，请重新导入歌曲');
        } else {
            MusicPlayer.currentIndex = index;
            updateMusicUI();
        }
        if (closeModal) closeMusicPlaylistModal();
    }
}

function deletePlaylistTrack(index, e) {
    if (e) e.stopPropagation();
    if (index < 0 || index >= MusicPlayer.playlist.length) return;
    const t = MusicPlayer.playlist[index];
    if (t.src) URL.revokeObjectURL(t.src);
    MusicPlayer.playlist.splice(index, 1);
    if (MusicPlayer.currentIndex >= MusicPlayer.playlist.length) {
        MusicPlayer.currentIndex = MusicPlayer.playlist.length - 1;
    } else if (MusicPlayer.currentIndex >= index && MusicPlayer.currentIndex > 0) {
        MusicPlayer.currentIndex--;
    }
    savePlaylistToIndexedDB();
    updateMusicUI();
    renderMusicPlaylist();
    showNotification('已删除');
}

function toggleMusicVolumePanel(e) {
    if (e) e.stopPropagation();
    const panel = document.getElementById('music-volume-panel');
    if (!panel) return;
    const isShow = panel.classList.toggle('show');
    if (isShow) {
        const slider = document.getElementById('music-volume-slider');
        if (slider) slider.value = Math.round(MusicPlayer.volume * 100);
        document.addEventListener('click', closeMusicVolumePanelOnClick);
    } else {
        document.removeEventListener('click', closeMusicVolumePanelOnClick);
    }
}

function closeMusicVolumePanelOnClick(e) {
    const panel = document.getElementById('music-volume-panel');
    const btn = document.getElementById('music-volume-btn');
    if (panel && btn && !panel.contains(e.target) && !btn.contains(e.target)) {
        panel.classList.remove('show');
        document.removeEventListener('click', closeMusicVolumePanelOnClick);
    }
}

function setMusicVolume(val) {
    const v = Math.max(0, Math.min(100, parseInt(val, 10) || 0)) / 100;
    MusicPlayer.volume = v;
    if (MusicPlayer.audio) MusicPlayer.audio.volume = v;
    try {
        localStorage.setItem('musicVolume', String(v));
    } catch (e) {}
}

function seekMusic(e) {
    const bar = e.currentTarget;
    if (!bar || !MusicPlayer.audio.duration) return;
    const rect = bar.getBoundingClientRect();
    const p = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
    MusicPlayer.audio.currentTime = p * MusicPlayer.audio.duration;
    updateMusicProgress();
}

function updateMusicProgress() {
    const a = MusicPlayer.audio;
    const cur = a.currentTime || 0;
    const dur = a.duration || 0;
    const pct = dur > 0 ? (cur / dur) * 100 : 0;
    const fill = document.getElementById('music-progress-fill');
    const thumb = document.getElementById('music-progress-thumb');
    if (fill) fill.style.width = pct + '%';
    if (thumb) thumb.style.left = pct + '%';
    const fmt = (s) => {
        const m = Math.floor(s / 60);
        const sec = Math.floor(s % 60);
        return m + ':' + (sec < 10 ? '0' : '') + sec;
    };
    const elapsed = document.getElementById('music-time-elapsed');
    const remain = document.getElementById('music-time-remain');
    if (elapsed) elapsed.textContent = fmt(cur);
    if (remain) remain.textContent = dur > 0 ? '-' + fmt(dur - cur) : '-0:00';
}

function updateMusicUI() {
    const t = MusicPlayer.currentTrack;
    const titleEl = document.getElementById('music-title');
    const artistEl = document.getElementById('music-artist');
    const artEl = document.getElementById('music-album-art');
    if (titleEl) titleEl.textContent = t ? t.title : '暂无歌曲';
    if (artistEl) artistEl.textContent = t ? t.artist : '—';
    if (artEl) {
        const cover = (t && t.cover) || MusicPlayer.customCover;
        artEl.classList.toggle('has-cover', !!cover);
        artEl.style.backgroundImage = cover ? `url(${cover})` : '';
    }
    renderMusicPlaylist();
    if (listenTogetherActive && typeof updateDynamicIslandUI === 'function') {
        updateDynamicIslandUI();
    }
}

function updateMusicPlayPauseBtn() {
    const btn = document.querySelector('.music-play-btn');
    if (!btn) return;
    const playIcon = btn.querySelector('.music-play-icon');
    const pauseIcon = btn.querySelector('.music-pause-icon');
    if (playIcon) playIcon.style.display = MusicPlayer.isPlaying ? 'none' : '';
    if (pauseIcon) pauseIcon.style.display = MusicPlayer.isPlaying ? '' : 'none';
}

function getMusicPlayerCurrentSong() {
    const t = MusicPlayer.currentTrack;
    return t ? { name: t.title, artist: t.artist, lyrics: t.lyrics || '' } : null;
}

// 一起听 - 灵动岛
let listenTogetherActive = false;

function openListenTogetherIsland() {
    closeMorePanel();
    listenTogetherActive = true;
    const island = document.getElementById('chat-dynamic-island');
    const chatContent = document.querySelector('.chat-content');
    if (island) island.classList.add('show');
    if (chatContent) chatContent.classList.add('dynamic-island-open');
    updateDynamicIslandUI();
}

function closeListenTogetherIsland() {
    listenTogetherActive = false;
    const island = document.getElementById('chat-dynamic-island');
    const chatContent = document.querySelector('.chat-content');
    if (island) island.classList.remove('show');
    if (chatContent) chatContent.classList.remove('dynamic-island-open');
}

function updateDynamicIslandUI() {
    const island = document.getElementById('chat-dynamic-island');
    if (!island || !island.classList.contains('show')) return;
    const song = getMusicPlayerCurrentSong();
    const cover = (MusicPlayer.currentTrack && MusicPlayer.currentTrack.cover) || MusicPlayer.customCover;
    const coverEl = document.getElementById('dynamic-island-cover');
    const trackEl = document.getElementById('dynamic-island-track');
    const artistEl = document.getElementById('dynamic-island-artist');
    const playIcon = island.querySelector('.dynamic-island-play-icon');
    const pauseIcon = island.querySelector('.dynamic-island-pause-icon');
    if (coverEl) {
        coverEl.classList.toggle('has-cover', !!cover);
        coverEl.style.backgroundImage = cover ? `url(${cover})` : '';
    }
    if (trackEl) trackEl.textContent = song ? song.name : '暂无歌曲';
    if (artistEl) artistEl.textContent = song ? song.artist : '—';
    if (playIcon) playIcon.style.display = MusicPlayer.isPlaying ? 'none' : '';
    if (pauseIcon) pauseIcon.style.display = MusicPlayer.isPlaying ? '' : 'none';
}

async function triggerListenTogetherReply(friendId, songName, artist, lyrics) {
    const sendContent = CommandManager.buildListenTogetherSendContent(friendId, songName, artist || '未知', lyrics);
    if (!sendContent) return;
    let settings;
    try { settings = JSON.parse(localStorage.getItem('apiSettings') || '{}'); if (!settings || typeof settings !== 'object') settings = {}; } catch (e) { settings = {}; }
    if (!settings.apiUrl || !settings.apiKey || !settings.model) {
        showNotification('请先在设置中配置API');
        return;
    }
    isReceiving = true;
    if (receiveController) receiveController.abort();
    receiveController = new AbortController();
    const listenPayload = {
        model: settings.model || 'gpt-4o-mini',
        messages: [{ role: 'user', content: sendContent }],
        stream: resolveApiStreamEnabled(settings),
        max_tokens: resolveApiChatMaxTokens(settings)
    };
    const listenWaitState = combineAbortWithTimeout(receiveController, resolveApiWaitTimeoutMs(settings));
    try {
        const { url: chatUrl, options: chatOpts } = buildOpenAiChatFetch(settings, listenPayload, listenWaitState.controller);
        const res = await fetch(chatUrl, chatOpts);
        if (!res.ok) throw new Error(res.statusText);
        const data = listenPayload.stream ? await readChatCompletionStream(res) : await res.json();
        const text = (data.choices && data.choices[0] && data.choices[0].message?.content) || '';
        if (text) {
            const timestamp = Date.now();
            displayMessage('friend', text, null, timestamp, friendId);
            saveChatMessage(friendId, 'friend', text, null, timestamp);
        }
    } catch (err) {
        if (listenWaitState.timedOut) {
            showNotification('一起听回复超时：等待模型返回超过上限');
        } else if (err.name !== 'AbortError') {
            showNotification('一起听回复失败: ' + (err.message || '网络错误'));
        }
    } finally {
        clearTimeout(listenWaitState.timer);
        isReceiving = false;
    }
}

// 初始化输入框大小调整功能
function initResizeableInputs() {
    const resizeHandles = document.querySelectorAll('.resize-handle');
    
    resizeHandles.forEach(handle => {
        let isResizing = false;
        let startY = 0;
        let startHeight = 0;
        
        handle.addEventListener('mousedown', (e) => {
            isResizing = true;
            startY = e.clientY;
            startHeight = handle.parentElement.querySelector('textarea').offsetHeight;
            document.body.style.cursor = 'nwse-resize';
        });
        
        document.addEventListener('mousemove', (e) => {
            if (!isResizing) return;
            
            const deltaY = e.clientY - startY;
            const newHeight = startHeight + deltaY;
            
            // 限制最小和最大高度
            if (newHeight >= 120 && newHeight <= 200) {
                handle.parentElement.querySelector('textarea').style.height = `${newHeight}px`;
            }
        });
        
        document.addEventListener('mouseup', () => {
            isResizing = false;
            document.body.style.cursor = '';
        });
    });
}

// 页面加载完成后初始化
window.addEventListener('DOMContentLoaded', async () => {
    initResizeableInputs();
    // 从文件加载系统指令到localStorage（不阻塞，失败最多等 4s）
    CommandManager.loadCommandsFromFile().catch(() => {});
    // 初始化指令列表
    loadCommandList();
    // 加载用户信息
    loadUserInfo();
    if (typeof Moments !== 'undefined' && Moments.ui && typeof Moments.ui.initMomentsPostMenuOutsideClose === 'function') {
        Moments.ui.initMomentsPostMenuOutsideClose();
    }
});

// 加载用户信息
function loadUserInfo() {
    let userInfo = safeReadJsonFromStorage('userInfo', null);
    if (!userInfo) {
        const defaultUserInfo = {
            nickname: '可点击编辑',
            avatar: '',
            wechatId: 'wx_id_...'
        };
        localStorage.setItem('userInfo', JSON.stringify(defaultUserInfo));
        userInfo = defaultUserInfo;
    } else if (userInfo.wechatId == null || String(userInfo.wechatId).trim() === '') {
        userInfo.wechatId = 'wx_id_...';
        try { localStorage.setItem('userInfo', JSON.stringify(userInfo)); } catch (e) {}
    }
    const effective = getEffectiveWechatMeProfileForDisplay();
    if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.syncWechatMeProfile === 'function') {
        Wechat.ui.syncWechatMeProfile(effective);
    }
    updateGlobalUserInfo(effective.nickname, effective.avatar);
}

// 获取页面名称
function getPageName(page) {
    const pageNames = {
        'home': '首页',
        'shopping': '购物',
        'books': '世界书',
        'theme': '主题',
        'settings': '设置',
        'phone': '手机',
        'twitter': '推特',
        'wechat': '微信',
        'system': '系统',
        'api-settings': 'API设置',
        'auto-message-api-settings': '自动消息API设置'
    };
    return pageNames[page] || page;
}

// 显示导入进度（更新 loading 文字，不阻塞 JS 线程）
function updateImportProgress(msg) {
    try {
        const el = document.getElementById('loading-overlay') || document.getElementById('global-loading-overlay');
        if (el) {
            const txt = el.querySelector('.loading-text');
            if (txt) txt.textContent = msg;
        }
    } catch (e) {}
}

// 显示加载状态
function showLoading() {
    // 兼容：部分页面（如设置页）不在 home-screen 内，看不到 #loading-overlay
    let loadingOverlay = document.getElementById('loading-overlay');
    if (!loadingOverlay) {
        loadingOverlay = document.getElementById('global-loading-overlay');
    }
    if (!loadingOverlay) {
        loadingOverlay = document.createElement('div');
        loadingOverlay.id = 'global-loading-overlay';
        loadingOverlay.className = 'loading-overlay';
        loadingOverlay.innerHTML = `
            <div class="loading-spinner"></div>
            <span class="loading-text">加载中...</span>
        `;
        document.body.appendChild(loadingOverlay);
    }
    loadingOverlay.classList.add('show');
}

// 隐藏加载状态
function hideLoading() {
    const loadingOverlay = document.getElementById('loading-overlay') || document.getElementById('global-loading-overlay');
    if (!loadingOverlay) return;
    loadingOverlay.classList.remove('show');
}

// 手机功能已拆分到 phone-feature.js（保持主屏点击“手机”入口不变）

// 显示错误弹框
function showErrorDialog(title, message) {
    // 若已存在则移除旧弹框
    var old = document.querySelector('.error-dialog-container');
    if (old) { try { document.body.removeChild(old); } catch (_) {} }

    // 创建弹框容器
    var dialogContainer = document.createElement('div');
    dialogContainer.className = 'error-dialog-container';

    // 创建弹框
    var dialog = document.createElement('div');
    dialog.className = 'error-dialog';

    // 弹框标题
    var dialogTitle = document.createElement('div');
    dialogTitle.className = 'error-dialog-title';
    dialogTitle.textContent = title;

    // 弹框内容（支持多行文本，含换行符保持格式）
    var dialogContent = document.createElement('div');
    dialogContent.className = 'error-dialog-content';
    dialogContent.textContent = message;

    // 按钮行容器
    var btnRow = document.createElement('div');
    btnRow.className = 'error-dialog-buttons';

    // 复制按钮（错误信息较长时方便用户复制给开发者）
    var copyBtn = document.createElement('button');
    copyBtn.className = 'error-dialog-copy-btn';
    copyBtn.textContent = '复制错误';
    copyBtn.onclick = function () {
        var txt = (title || '') + '\n' + (message || '');
        try {
            navigator.clipboard.writeText(txt).then(function () {
                copyBtn.textContent = '已复制 ✓';
                setTimeout(function () { copyBtn.textContent = '复制错误'; }, 1800);
            }).catch(function () {
                var ta = document.createElement('textarea');
                ta.value = txt;
                ta.style.cssText = 'position:fixed;top:-9999px;left:-9999px;opacity:0';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                copyBtn.textContent = '已复制 ✓';
                setTimeout(function () { copyBtn.textContent = '复制错误'; }, 1800);
            });
        } catch (_) {
            copyBtn.textContent = '复制失败';
            setTimeout(function () { copyBtn.textContent = '复制错误'; }, 1800);
        }
    };

    // 确定按钮
    var dialogButton = document.createElement('button');
    dialogButton.className = 'error-dialog-button';
    dialogButton.textContent = '确定';
    dialogButton.onclick = function () {
        try { document.body.removeChild(dialogContainer); } catch (_) {}
    };

    btnRow.appendChild(copyBtn);
    btnRow.appendChild(dialogButton);

    dialog.appendChild(dialogTitle);
    dialog.appendChild(dialogContent);
    dialog.appendChild(btnRow);
    dialogContainer.appendChild(dialog);
    document.body.appendChild(dialogContainer);

    // ESC 或点击遮罩关闭
    var escHandler = function (e) {
        if (e.key === 'Escape') {
            document.removeEventListener('keydown', escHandler);
            try { document.body.removeChild(dialogContainer); } catch (_) {}
        }
    };
    document.addEventListener('keydown', escHandler);
    dialogContainer.addEventListener('click', function (e) {
        if (e.target === dialogContainer) {
            document.removeEventListener('keydown', escHandler);
            try { document.body.removeChild(dialogContainer); } catch (_) {}
        }
    });

    // 显示弹框
    setTimeout(function () { dialogContainer.classList.add('show'); }, 10);
}

/** 通用确认对话框：取消 / 确定。options.variant === 'danger' 时用于删除等破坏性操作（确认钮为红色） */
function showConfirmDialog(title, message, onConfirm, options) {
    options = options || {};
    var danger = options.variant === 'danger';

    var old = document.querySelector('.confirm-dialog-container');
    if (old) {
        try {
            if (old.parentNode) old.parentNode.removeChild(old);
        } catch (_) {}
    }

    var dialogContainer = document.createElement('div');
    dialogContainer.className = 'confirm-dialog-container error-dialog-container';

    var dialog = document.createElement('div');
    dialog.className = 'error-dialog confirm-dialog';

    var dialogTitle = document.createElement('div');
    dialogTitle.className = 'error-dialog-title';
    dialogTitle.textContent = title;

    var dialogContent = document.createElement('div');
    dialogContent.className = 'error-dialog-content';
    dialogContent.textContent = message;

    var btnRow = document.createElement('div');
    btnRow.className = 'error-dialog-buttons confirm-dialog-buttons-row';

    function remove() {
        document.removeEventListener('keydown', escHandler);
        try {
            if (dialogContainer.parentNode) {
                dialogContainer.parentNode.removeChild(dialogContainer);
            }
        } catch (_) {}
    }

    var cancelBtn = document.createElement('button');
    cancelBtn.type = 'button';
    cancelBtn.className = 'confirm-dialog-btn confirm-dialog-btn-secondary';
    cancelBtn.textContent = '取消';
    cancelBtn.onclick = function () { remove(); };

    var okBtn = document.createElement('button');
    okBtn.type = 'button';
    okBtn.className = danger ? 'confirm-dialog-btn confirm-dialog-btn-danger' : 'confirm-dialog-btn confirm-dialog-btn-primary';
    okBtn.textContent = '确定';
    okBtn.onclick = function () {
        remove();
        try { if (typeof onConfirm === 'function') onConfirm(); } catch (e) { console.error(e); }
    };

    btnRow.appendChild(cancelBtn);
    btnRow.appendChild(okBtn);

    dialog.appendChild(dialogTitle);
    dialog.appendChild(dialogContent);
    dialog.appendChild(btnRow);
    dialogContainer.appendChild(dialog);
    // 须挂到 body：多数 .modal 在 #app 闭合之后，与 #app(z-index:1) 同级；挂 #app 内时整棵子树永远压在模态下方
    document.body.appendChild(dialogContainer);

    var escHandler = function (e) {
        if (e.key === 'Escape') remove();
    };
    document.addEventListener('keydown', escHandler);
    dialogContainer.addEventListener('click', function (e) {
        if (e.target === dialogContainer) remove();
    });

    setTimeout(function () { dialogContainer.classList.add('show'); }, 10);
}
try {
    if (typeof window !== 'undefined') {
        window.showConfirmDialog = showConfirmDialog;
    }
} catch (e) {}

function closePresetSelect() {
    closePresetSelectDialog();
}

// 更新时间
function updateTime() {
    const now = new Date();
    const hours = now.getHours().toString().padStart(2, '0');
    const minutes = now.getMinutes().toString().padStart(2, '0');
    const seconds = now.getSeconds().toString().padStart(2, '0');
    const timeString = `${hours}:${minutes}:${seconds}`;
    
    // 更新所有状态栏时间
    const statusTimes = document.querySelectorAll('.status-bar .current-time');
    statusTimes.forEach(statusTime => {
        statusTime.textContent = timeString;
    });
    
    // 更新底部时间
    const bottomTime = document.querySelector('.bottom-time');
    if (bottomTime) {
        bottomTime.textContent = timeString;
    }
    
    // 更新主界面模拟时钟
    const hourHand = document.querySelector('.hour-hand');
    const minuteHand = document.querySelector('.minute-hand');
    const secondHand = document.querySelector('.second-hand');
    const clockDay = document.querySelector('.clock-day');
    
    if (hourHand && minuteHand && secondHand) {
        // 计算指针旋转角度
        const hoursAngle = (hours % 12) * 30 + minutes * 0.5;
        const minutesAngle = minutes * 6;
        const secondsAngle = seconds * 6;
        
        // 更新指针位置
        hourHand.style.transform = `rotate(${hoursAngle}deg)`;
        minuteHand.style.transform = `rotate(${minutesAngle}deg)`;
        secondHand.style.transform = `rotate(${secondsAngle}deg)`;
    }
    
    if (clockDay) {
        // 更新星期显示
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        clockDay.textContent = days[now.getDay()];
    }
}

// 触发主卡片背景上传
function triggerBackgroundUpload() {
    document.getElementById('main-card-background-upload')?.click();
}

// 主卡片背景（与聊天背景上传分离，避免 id/handler 冲突）
function handleMainCardBackgroundUpload(event) {
    const file = event.target.files[0];
    if (file) {
        if (!isLegoUploadableRasterImageFile(file)) {
            showNotification('请选择 JPEG、PNG 或 GIF 图片');
            event.target.value = '';
            return;
        }
        showLoading();
        const reader = new FileReader();
        reader.onload = function(e) {
            backgroundImage = e.target.result;
            try {
                localStorage.setItem('backgroundImage', e.target.result);
            } catch (err) {
                console.warn('保存主卡片背景失败（可能超出存储配额）:', err);
            }
            const cardBackground = document.querySelector('.card-background');
            if (cardBackground) {
                cardBackground.style.backgroundImage = `url(${backgroundImage})`;
                cardBackground.style.backgroundSize = 'cover';
                cardBackground.style.backgroundPosition = 'center';
            }
            hideLoading();
            showNotification('背景更换成功');
        };
        reader.readAsDataURL(file);
    }
    event.target.value = '';
}

// 处理头像上传
function handleAvatarUpload(event) {
    console.log('开始处理头像上传');
    
    // 确保事件对象存在
    if (!event || !event.target || !event.target.files) {
        console.error('事件对象或文件不存在');
        showNotification('上传失败，请重试');
        return;
    }
    
    const file = event.target.files[0];
    console.log('选择的文件:', file);
    
    // 检查文件是否存在
    if (!file) {
        console.log('未选择文件');
        return;
    }
    
    // 检查文件类型（JPEG / PNG / GIF）
    if (!isLegoUploadableRasterImageFile(file)) {
        console.log('文件类型不正确:', file.type);
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    
    // 获取头像图片元素
    const avatarImage = document.getElementById('avatar-image');
    console.log('头像图片元素:', avatarImage);
    
    if (!avatarImage) {
        console.error('头像图片元素未找到');
        showNotification('头像元素未找到');
        return;
    }
    
    showLoading();
    console.log('显示加载状态');
    
    const reader = new FileReader();
    
    reader.onload = function(e) {
        console.log('文件读取完成');

        // 确保结果存在
        if (!e || !e.target || !e.target.result) {
            console.error('文件读取结果不存在');
            hideLoading();
            showNotification('文件读取失败，请重试');
            return;
        }

        try {
            // 先显示预览（原始图）
            avatarImage.src = e.target.result;
            console.log('头像图片src已更新');

            // 压缩后再保存（避免 localStorage 配额超限）
            compressImageDataUrl(e.target.result, 256, 0.82).then(function(compressed) {
                localStorage.setItem('userAvatar', compressed);
                console.log('头像已保存到localStorage（已压缩）');
                hideLoading();
                showNotification('头像上传成功');
            }).catch(function(err) {
                console.error('头像压缩失败:', err);
                // 压缩失败时尝试直接保存（兜底，兼容极小图片）
                try {
                    localStorage.setItem('userAvatar', e.target.result);
                } catch (qe) {
                    showNotification('头像保存失败：图片可能过大');
                }
                hideLoading();
            });
        } catch (error) {
            console.error('设置头像时出错:', error);
            hideLoading();
            showNotification('设置头像失败，请重试');
        }
    };
    
    reader.onerror = function(error) {
        console.error('文件读取错误:', error);
        hideLoading();
        showNotification('文件读取失败，请重新选择图片');
    };
    
    reader.onabort = function() {
        console.log('文件读取被中止');
        hideLoading();
        showNotification('上传被中止，请重试');
    };
    
    try {
        reader.readAsDataURL(file);
        console.log('开始读取文件');
    } catch (error) {
        console.error('开始读取文件时出错:', error);
        hideLoading();
        showNotification('读取文件失败，请重试');
    }
}

// 保存头像到系统目录文件夹
function saveAvatarToSystem(avatarData) {
    // 在实际应用中，这里会使用文件系统API将图片保存到系统目录
    // 由于浏览器环境限制，我们这里模拟保存过程
    console.log('保存头像到系统目录:', avatarData);
    // 实际项目中可以使用Node.js的fs模块或其他文件系统API
}

/** 用于比对聊天中的图片/表情 URL（img.src 为绝对地址，历史里可能是 // 或 http/https 混用） */
function normalizeChatMediaUrl(url) {
    if (!url || typeof url !== 'string') return '';
    const s = url.trim();
    if (s.startsWith('data:image')) return s;
    try {
        const abs = s.startsWith('//') ? 'https:' + s : s;
        const u = new URL(abs, window.location.href);
        u.hash = '';
        return `${u.host.toLowerCase()}${u.pathname}${u.search}`;
    } catch (e) {
        return s;
    }
}

function isChatEmojiContent(content) {
    if (!content || typeof content !== 'string') return false;
    return content.startsWith('http://') || content.startsWith('https://') || content.startsWith('//') ||
        content.startsWith('data:image');
}

// buildMessageBubbles / sanitizeChatHtml / 拍立得 DOM 修正等：见 wechat-bubbles.js（在 wechat-emoji 之后加载）

// 表情解析与消息格式化：见 wechat-emoji.js（Wechat.emoji）

/** 地址图标（倒水滴形+内部实心圆点） */
const ADDRESS_ICON_SVG = '<svg viewBox="0 0 24 30" xmlns="http://www.w3.org/2000/svg"><path d="M12 2C6.5 2 2 6.5 2 12c0 7 10 16 10 16s10-9 10-16c0-5.5-4.5-10-10-10z" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="10" r="3" fill="#B5BAC0"/></svg>';

/** 构建转账消息气泡 HTML。transferStatus: 'pending'|'received'|'rejected' */
function buildTransferBubbleHtml(amountStr, transferStatus = 'pending', messageTimestamp = null) {
    const amount = parseFloat(amountStr) || 0;
    const displayAmount = amount.toFixed(2);
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const statusText = transferStatus === 'received' ? '已收款' : transferStatus === 'rejected' ? '已退还' : '待对方确认';
    const statusClass = transferStatus === 'received' ? 'transfer-received' : transferStatus === 'rejected' ? 'transfer-rejected' : 'transfer-pending';
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    return `<div class="chat-message-bubble"${tsAttr}><div class="chat-transfer-bubble ${statusClass}"><div class="chat-transfer-label">微信转账</div><div class="chat-transfer-amount">¥ ${esc(displayAmount)}</div><div class="chat-transfer-status">${esc(statusText)}</div></div></div>`;
}

/** 构建好友发给用户的转账气泡。消息 ID 用 timestamp。transferStatus: pending | received | rejected */
function buildFriendTransferBubbleHtml(amountStr, messageStr, messageTimestamp, transferStatus) {
    const amount = parseFloat(amountStr) || 0;
    const displayAmount = amount.toFixed(2);
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    const msgText = messageStr ? esc(String(messageStr)) : '';
    const status = transferStatus || 'pending';
    const isPending = status === 'pending';
    const isReceived = status === 'received';
    const isRejected = status === 'rejected';
    // 用 data 属性传参，避免 onclick 参数中空引号导致 HTML 解析错误
    const actionsHtml = isPending
        ? `<div class="chat-transfer-actions"><button type="button" class="chat-transfer-action-btn chat-transfer-reject" data-action="reject_transfer" data-ts="${esc(String(messageTimestamp))}">拒绝</button><button type="button" class="chat-transfer-action-btn chat-transfer-accept" data-action="accept_transfer" data-ts="${esc(String(messageTimestamp))}">收款</button></div>`
        : '';
    const statusText = isReceived ? '已收款' : isRejected ? '已退还' : '待对方确认';
    const bubbleClass = isReceived ? 'transfer-received' : isRejected ? 'transfer-rejected' : 'transfer-pending';
    return `<div class="chat-message-bubble"${tsAttr}><div class="chat-transfer-bubble chat-transfer-friend ${bubbleClass}"><div class="chat-transfer-label">微信转账</div><div class="chat-transfer-amount">¥ ${esc(displayAmount)}</div>${msgText ? `<div class="chat-transfer-msg">${msgText}</div>` : ''}<div class="chat-transfer-status">${esc(statusText)}</div>${actionsHtml}</div></div>`;
}

/** 构建好友发给用户的红包气泡（待拆样式）。消息 ID 用 timestamp。 */
function buildFriendRedpacketBubbleHtml(amountStr, messageTimestamp, friendId) {
    const esc = (s) => String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    const tsNum = Number(messageTimestamp) || 0;
    // 立即从聊天历史读取附言（saveChatMessage 已先写入，可立即读到）
    let msgText = '';
    try {
        const hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
        const m = hist.find(h => h.type === 'friend' && h.subtype === 'redpacket' && Number(h.timestamp) === tsNum);
        if (m && m.redpacketMsg) msgText = esc(String(m.redpacketMsg));
    } catch (_) {}
    return `<div class="chat-message-bubble"${tsAttr}><div class="chat-redpacket-bubble chat-redpacket-friend"><div class="chat-redpacket-inner"><div class="chat-redpacket-open-btn" data-ts="${esc(String(messageTimestamp))}" data-fid="${esc(String(friendId))}"><span class="chat-redpacket-open-text">拆</span></div><div class="chat-redpacket-amount" style="display:none"></div></div>${msgText ? `<div class="chat-redpacket-msg">${msgText}</div>` : ''}</div></div>`;
}

/** 红包拆开动画：点击后先显示动画，再 reveal 金额并入账 */
function openRedpacketFromChat(btnEl) {
    if (!btnEl) return;
    const wrap = btnEl.closest('.chat-redpacket-bubble');
    const amtEl = wrap ? wrap.querySelector('.chat-redpacket-amount') : null;
    const openEl = wrap ? wrap.querySelector('.chat-redpacket-open-text') : null;
    // 动画：文字变"拆"
    if (openEl) openEl.textContent = '…';
    if (btnEl) btnEl.style.pointerEvents = 'none';
    setTimeout(() => {
        // 从 data 属性读取（避免 onclick 参数传递的引号编码问题）
        const messageTimestamp = btnEl.dataset.ts;
        const friendId = btnEl.dataset.fid;
        const ts = Number(messageTimestamp);
        let amount = 0;
        if (friendId) {
            try {
                const hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
                const msg = hist.find(m => m.type === 'friend' && m.subtype === 'redpacket' && Number(m.timestamp) === ts);
                if (msg && msg.content) {
                    amount = parseFloat(String(msg.content)) || 0;
                }
            } catch (_) {}
        }
        // 显示金额
        if (amtEl) {
            amtEl.style.display = 'block';
            amtEl.textContent = '¥ ' + amount.toFixed(2);
        }
        if (openEl) {
            openEl.parentElement.style.display = 'none';
        }
        // 入账
        if (amount > 0) {
            addToWallet(amount);
            showNotification(`收到红包 ¥${amount.toFixed(2)}`);
        }
        // 更新消息状态
        if (friendId) {
            try {
                const hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
                const msg = hist.find(m => m.type === 'friend' && m.subtype === 'redpacket' && Number(m.timestamp) === ts);
                if (msg) {
                    msg.redpacketOpened = true;
                    saveJsonToStorageWithCompression(`chatHistory_${friendId}`, hist);
                }
            } catch (_) {}
        }
    }, 1200);
}

/** 用户点击「收款」（好友转给用户的转账）——通过 data-action="accept_transfer" 事件委托调用 */
function acceptTransferFromChat(messageTimestamp) {
    const ts = Number(messageTimestamp);
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) return;
    let hist;
    try {
        hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    } catch (_) {
        hist = [];
    }
    const msg = hist.find(m => m.type === 'friend' && m.subtype === 'friend_transfer' && Number(m.timestamp) === ts);
    if (!msg) return;
    const amount = parseFloat(String(msg.content || '0')) || 0;
    if (amount > 0) addToWallet(amount);
    msg.transferStatus = 'received';
    try {
        saveJsonToStorageWithCompression(`chatHistory_${friendId}`, hist);
    } catch (_) {}
    showNotification(amount > 0 ? `已收款 ¥${amount.toFixed(2)}` : '已收款');
    loadChatHistory(friendId);
}

/** 用户点击「拒绝」（好友转给用户的转账）——通过 data-action="reject_transfer" 事件委托调用 */
function rejectTransferFromChat(messageTimestamp) {
    const ts = Number(messageTimestamp);
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) return;
    let hist;
    try {
        hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    } catch (_) {
        hist = [];
    }
    const msg = hist.find(m => m.type === 'friend' && m.subtype === 'friend_transfer' && Number(m.timestamp) === ts);
    if (!msg) return;
    msg.transferStatus = 'rejected';
    try {
        saveJsonToStorageWithCompression(`chatHistory_${friendId}`, hist);
    } catch (_) {}
    showNotification('已拒绝，金额退还给对方');
    loadChatHistory(friendId);
}

// 事件委托（capture phase）：统一处理红包拆开按钮、转账收款/拒绝按钮、礼盒接收按钮
// 必须用 capture phase，否则 .chat-message-bubble 的 click 监听器会 stopPropagation 阻止冒泡
document.addEventListener('click', function(e) {
    const target = e.target;
    // 红包拆开按钮（点击可能落在 span 上，用 closest 向上查找）
    const rpBtn = target.closest('.chat-redpacket-open-btn');
    if (rpBtn) {
        openRedpacketFromChat(rpBtn);
        return;
    }
    // 转账按钮（与红包一致：点击可能不落在 button 元素上，用 closest）
    const transferAct = target.closest('[data-action="accept_transfer"], [data-action="reject_transfer"]');
    if (transferAct) {
        const action = transferAct.dataset.action;
        if (action === 'accept_transfer') {
            acceptTransferFromChat(transferAct.dataset.ts);
            return;
        }
        if (action === 'reject_transfer') {
            rejectTransferFromChat(transferAct.dataset.ts);
            return;
        }
    }
    const giftAct = target.closest('[data-action="receive_gift_bundle"]');
    if (giftAct) {
        receiveGiftBundleFromChat(giftAct.dataset.fid, Number(giftAct.dataset.ts));
        return;
    }
    const takeoutAct = target.closest('[data-action="open_love_takeout_detail"], [data-action="confirm_love_takeout_received"]');
    if (takeoutAct) {
        const action = takeoutAct.dataset.action;
        if (action === 'open_love_takeout_detail' && typeof openLoveTakeoutDetailPage === 'function') {
            openLoveTakeoutDetailPage(takeoutAct.dataset.fid, takeoutAct.dataset.orderId, takeoutAct.dataset.ts);
            return;
        }
        if (action === 'confirm_love_takeout_received' && typeof confirmLoveTakeoutReceived === 'function') {
            confirmLoveTakeoutReceived(takeoutAct.dataset.fid, takeoutAct.dataset.orderId);
            return;
        }
    }
}, true); // capture: true —— 在事件冒泡到 .chat-message-bubble 的 stopPropagation 之前先拦截

/** 购物礼盒气泡（奶油风包裹图，不展示具体商品图）giftStatus: pending_receive|received */
function buildGiftBundleBubbleHtml(messageTimestamp, giftStatus, giftTotalQty, giftKindCount, friendIdForReceive) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    const pending = giftStatus === 'pending_receive';
    const statusText = pending ? '轻触「接收」拆开' : '已拆开';
    const total = Math.max(1, Number(giftTotalQty) || 1);
    const kinds = Math.max(1, Number(giftKindCount) || 1);
    const metaLine = kinds > 1 || total > 1 ? `${kinds} 款 · 共 ${total} 件` : '一份小心意';
    const tsNum = Number(messageTimestamp) || 0;
    // 用 data 属性传参，避免 onclick 参数中空引号导致 HTML 解析错误
    const receiveBtn = pending
        ? `<button type="button" class="chat-gift-bundle-receive" data-action="receive_gift_bundle" data-ts="${esc(String(messageTimestamp))}" data-fid="${esc(String(friendIdForReceive != null ? friendIdForReceive : ''))}">接收</button>`
        : '';
    const bowSvg = `<svg class="chat-gift-bundle-bow-svg" viewBox="0 0 120 48" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs><linearGradient id="gbow" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="#F8B8C4"/><stop offset="100%" stop-color="#E8A0B8"/></linearGradient></defs><path fill="url(#gbow)" d="M60 8c-8 0-14 6-16 14-4-6-10-10-18-10-10 0-18 8-18 18s8 18 18 18c6 0 11-3 14-8 3 8 10 14 18 14 8 0 15-6 18-14 3 5 8 8 14 8 10 0 18-8 18-18s-8-18-18-18c-8 0-14 4-18 10-2-8-8-14-16-14Z"/><ellipse cx="60" cy="20" rx="10" ry="6" fill="#FFDCE6" opacity=".9"/></svg>`;
    return `<div class="chat-message-bubble chat-message-bubble--gift-bundle"${tsAttr}><div class="chat-gift-bundle-card"><div class="chat-gift-bundle-ribbon chat-gift-bundle-ribbon--v"></div><div class="chat-gift-bundle-ribbon chat-gift-bundle-ribbon--h"></div>${bowSvg}<div class="chat-gift-bundle-inner"><div class="chat-gift-bundle-tag">Gift</div><div class="chat-gift-bundle-title">送你一份礼盒</div><div class="chat-gift-bundle-meta">${esc(metaLine)}</div><p class="chat-gift-bundle-note">打开前仅显示包裹样式</p><div class="chat-gift-bundle-status">${esc(statusText)}</div>${receiveBtn}</div></div></div>`;
}

/** 聊天内可翻转「描述型照片」卡片（背面灰色示意，正面为文字描述） */
function toggleChatPhotoFlip(root, ev) {
    if (!root || !root.classList.contains('chat-photo-flip-root')) return;
    const _ms = (window.__chatUiBridge || {}).isMultiselectMode;
    if (_ms) {
        const messageDiv = root.closest('.chat-message');
        if (messageDiv) {
            const messageIndex = parseInt(messageDiv.dataset.messageIndex, 10) || 0;
            if (typeof toggleMessageSelection === 'function') {
                toggleMessageSelection(messageIndex);
            }
        }
        return;
    }
    if (ev && typeof ev.stopPropagation === 'function') ev.stopPropagation();
    root.classList.toggle('is-flipped');
}

/** 解析好友回复中的描述型照片（与 buildPhotoCardSendContent 中的约定一致） */
function parseFriendPhotoCardMessage(text) {
    const s = String(text || '').trim();
    if (!s.startsWith('【描述型照片】')) return null;
    const rest = s.slice('【描述型照片】'.length).replace(/^\s*\n?/, '').trim();
    if (!rest) return null;
    return { subtype: 'photo_card', content: rest };
}

function buildPhotoCardBubbleHtml(description, messageTimestamp = null) {
    const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    const raw = String(description || '').trim();
    const frontHtml = raw ? esc(raw).replace(/\n/g, '<br>') : '（无描述）';
    return `<div class="chat-message-bubble chat-message-bubble--polaroid"${tsAttr}><div class="chat-photo-flip-root" onclick="toggleChatPhotoFlip(this, event)"><div class="chat-photo-flip-inner"><div class="chat-photo-face chat-photo-back"><div class="chat-photo-polaroid-frame"><div class="chat-photo-polaroid-imgarea chat-photo-polaroid-imgarea--back"><div class="chat-photo-polaroid-emulsion"></div><div class="chat-photo-back-inner"><span class="chat-photo-back-label">文字照片</span><span class="chat-photo-back-hint">轻触翻面查看描述</span></div></div><div class="chat-photo-polaroid-chin chat-photo-polaroid-chin--back"><span class="chat-photo-polaroid-brand">POLAROID</span></div></div></div><div class="chat-photo-face chat-photo-front"><div class="chat-photo-polaroid-frame"><div class="chat-photo-polaroid-imgarea chat-photo-polaroid-imgarea--front"><div class="chat-photo-front-text">${frontHtml}</div></div><div class="chat-photo-polaroid-chin chat-photo-polaroid-chin--front"><div class="chat-photo-polaroid-line"></div><div class="chat-photo-polaroid-meta"><span>Daily Record</span><span>Moment</span></div></div></div></div></div></div></div>`;
}

/** photo_card 分流：规范③ .wechat-polaroid-wrap 与朋友圈同源直接渲染 HTML；仅「【描述型照片】」纯文字用翻面卡 */
function buildPhotoCardBubblesHtml(content, messageTimestamp) {
    const c = String(content || '').trim();
    if (/\bwechat-polaroid-wrap\b/i.test(c)) {
        // 不走 buildMessageBubbles：避免 splitHtmlIntoSeparateChatBubbles / 按 <img> 拆段把相框、图、配文拆成多段，
        // 在 inline-flex 气泡里表现为左侧空灰条 + 右侧挤成一列（模型常在结构内嵌 <style> 更易触发解析差异）。
        const sanitized = sanitizeChatHtml(c).trim();
        if (!sanitized) return '';
        const tsAttr =
            messageTimestamp != null && !Number.isNaN(Number(messageTimestamp))
                ? ` data-message-timestamp="${String(messageTimestamp).replace(/"/g, '&quot;')}"`
                : '';
        return (
            '<div class="chat-message-bubble chat-message-bubble--polaroid-html"' +
            tsAttr +
            '>' +
            sanitized +
            '</div>'
        );
    }
    return buildPhotoCardBubbleHtml(content, messageTimestamp);
}

/** 聊天内展示「朋友圈转发」：独立名片框，含正文/图/拍立得/赞/评论区（非聊天气泡样式） */
function buildMomentsForwardCardFrameHtml(content, messageTimestamp) {
    const esc = (s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    const escUrl = (u) => String(u || '').replace(/"/g, '&quot;').replace(/</g, '').replace(/`/g, '');
    let data;
    try {
        data = JSON.parse(String(content || ''));
    } catch (e) {
        return (
            '<div class="chat-moments-forward-surface"><div class="chat-moments-forward-card chat-moments-forward-card--err">' +
            esc('无法显示该朋友圈转发') +
            '</div></div>'
        );
    }
    if (!data || !data.snapshot || typeof data.snapshot !== 'object') {
        return (
            '<div class="chat-moments-forward-surface"><div class="chat-moments-forward-card chat-moments-forward-card--err">' +
            esc('数据格式无效') +
            '</div></div>'
        );
    }
    const snap = data.snapshot;
    const tsAttr =
        messageTimestamp != null && !Number.isNaN(Number(messageTimestamp))
            ? ' data-message-timestamp="' + String(messageTimestamp).replace(/"/g, '&quot;') + '"'
            : '';
    const author = esc(snap.friendName || '好友');
    const tline = typeof formatFavoriteTime === 'function' ? formatFavoriteTime(snap.timestamp) : '';
    let avatarHtml = '';
    if (snap.friendAvatar && String(snap.friendAvatar).trim()) {
        avatarHtml =
            '<div class="chat-moments-forward-avatar" style="background-image:url(' +
            escUrl(snap.friendAvatar) +
            ')"></div>';
    } else {
        avatarHtml =
            '<div class="chat-moments-forward-avatar chat-moments-forward-avatar--ph">' +
            esc((snap.friendName || '?').charAt(0)) +
            '</div>';
    }
    const comments = Array.isArray(snap.comments) ? snap.comments : [];
    let textInnerHtml = '';
    if (snap.text && String(snap.text).trim()) {
        const raw = String(snap.text);
        const withEmoji =
            typeof resolveEmojiRefsInMessage === 'function' &&
            typeof Moments !== 'undefined' &&
            Moments.ui &&
            typeof Moments.ui.momentsCollectAllEmojis === 'function'
                ? resolveEmojiRefsInMessage(raw, Moments.ui.momentsCollectAllEmojis())
                : raw;
        if (withEmoji && withEmoji.includes('<img')) {
            const parts = withEmoji.split(/(<img\b[^>]*\/?>)/gi);
            textInnerHtml = parts
                .map((p) => {
                    if (/^<img\b/i.test(p)) return p;
                    return esc(p).replace(/\n/g, '<br>');
                })
                .join('');
        } else {
            textInnerHtml = esc(withEmoji).replace(/\n/g, '<br>');
        }
    } else {
        textInnerHtml = esc('（仅文字动态）');
    }
    const hasHiddenDiscussion = comments.length > 0;
    const textHint = hasHiddenDiscussion ? '<span class="chat-moments-forward-text-hint">点开查看评论区</span>' : '';
    const textHtml =
        '<button type="button" class="chat-moments-forward-text chat-moments-forward-text--trigger" onclick="toggleChatMomentsForwardDetails(this)" aria-expanded="false">' +
        '<span class="chat-moments-forward-text-body">' + textInnerHtml + '</span>' +
        textHint +
        '</button>';
    const likes = Array.isArray(snap.likes) ? snap.likes : [];
    const likeNames = likes.map((l) => esc((l && (l.authorName || l.name)) || '')).filter(Boolean);
    let likeStrip = '';
    if (likeNames.length) {
        likeStrip =
            '<div class="chat-moments-forward-like-strip"><span class="chat-moments-forward-like-ico" aria-hidden="true">♥</span> ' +
            likeNames.join('、') +
            '</div>';
    }
    let commentsHtml = '';
    if (comments.length) {
        commentsHtml =
            '<div class="chat-moments-forward-comments">' +
            comments
                .map((c) => {
                    const replyTo =
                        c && c.replyTo
                            ? '<span class="chat-moments-forward-c-reply">回复 ' + esc(c.replyTo) + '：</span>'
                            : '';
                    const name = esc((c && c.authorName) || '');
                    const cx = esc((c && c.text) || '');
                    return (
                        '<div class="chat-moments-forward-c-line"><span class="chat-moments-forward-c-author">' +
                        name +
                        '</span>' +
                        (replyTo ? '' : '：') +
                        replyTo +
                        cx +
                        '</div>'
                    );
                })
                .join('') +
            '</div>';
    }
    const social =
        likeStrip || commentsHtml
            ? '<div class="chat-moments-forward-social chat-moments-forward-details" hidden>' + likeStrip + commentsHtml + '</div>'
            : '';
    return (
        '<div class="chat-moments-forward-surface"' +
        tsAttr +
        '>' +
        '<div class="chat-moments-forward-card">' +
        '<div class="chat-moments-forward-badge">朋友圈动态</div>' +
        '<div class="chat-moments-forward-author-row">' +
        avatarHtml +
        '<div class="chat-moments-forward-author-meta"><div class="chat-moments-forward-author-name">' +
        author +
        '</div>' +
        (tline ? '<div class="chat-moments-forward-author-time">' + esc(tline) + '</div>' : '') +
        '</div></div>' +
        textHtml +
        social +
        '</div></div>'
    );
}

function toggleChatMomentsForwardDetails(triggerEl) {
    if (!triggerEl || !triggerEl.closest) return;
    const card = triggerEl.closest('.chat-moments-forward-card');
    if (!card) return;
    const details = card.querySelector('.chat-moments-forward-details');
    if (!details) return;
    const expanded = details.hasAttribute('hidden');
    if (expanded) details.removeAttribute('hidden');
    else details.setAttribute('hidden', 'hidden');
    triggerEl.setAttribute('aria-expanded', expanded ? 'true' : 'false');
    triggerEl.classList.toggle('is-expanded', expanded);
}

/** 聊天内展示「情侣空间邀请/答应」卡片（独立视觉，不复用朋友圈转发卡） */
function buildCoupleSpaceCardFrameHtml(content, messageTimestamp) {
    const esc = (s) =>
        String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    const escAttrUrl = (u) =>
        String(u || '')
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '')
            .replace(/>/g, '')
            .replace(/`/g, '');

    let data;
    try {
        data = JSON.parse(String(content || ''));
    } catch (e) {
        return (
            '<div class="chat-couple-space-surface"><div class="chat-couple-space-scallop"><div class="chat-couple-space-card chat-couple-space-card--err">' +
            esc('无法显示该情侣空间卡片') +
            '</div></div></div>'
        );
    }

    const kind = String((data && data.kind) || '').toLowerCase();
    const tsAttr =
        messageTimestamp != null && !Number.isNaN(Number(messageTimestamp))
            ? ' data-message-timestamp="' + String(messageTimestamp).replace(/"/g, '&quot;') + '"'
            : '';

    const title = kind === 'accept' ? '已答应邀请' : '情侣空间邀请';
    const subtitle =
        kind === 'accept'
            ? '你们的情侣空间已开启'
            : '邀请你成为情侣，开启甜蜜情侣空间';

    const userName = esc((data && data.fromUserName) || (data && data.userName) || '我');
    const friendName = esc((data && data.toFriendName) || (data && data.friendName) || '好友');

    const userAvatarRaw = String((data && data.fromUserAvatar) || (data && data.userAvatar) || '').trim();
    const friendAvatarRaw = String((data && data.toFriendAvatar) || (data && data.friendAvatar) || '').trim();

    const userAvatar =
        userAvatarRaw && userAvatarRaw !== 'null'
            ? '<div class="chat-couple-space-avatar" style="background-image:url(\'' + escAttrUrl(userAvatarRaw) + '\')"></div>'
            : '<div class="chat-couple-space-avatar chat-couple-space-avatar--ph">' + esc(String(userName).charAt(0) || '我') + '</div>';
    const friendAvatar =
        friendAvatarRaw && friendAvatarRaw !== 'null'
            ? '<div class="chat-couple-space-avatar" style="background-image:url(\'' + escAttrUrl(friendAvatarRaw) + '\')"></div>'
            : '<div class="chat-couple-space-avatar chat-couple-space-avatar--ph">' + esc(String(friendName).charAt(0) || '友') + '</div>';

    const connector =
        '<svg class="chat-couple-space-connector" viewBox="0 0 120 44" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">' +
        '<defs>' +
        '<linearGradient id="chatCsHeartGrad" x1="0" y1="0" x2="1" y2="1">' +
        '<stop offset="0%" stop-color="#F4B0A5"/>' +
        '<stop offset="100%" stop-color="#F7F0EA"/>' +
        '</linearGradient>' +
        '</defs>' +
        '<path d="M18 22h62" fill="none" stroke="url(#chatCsHeartGrad)" stroke-width="2.6" stroke-linecap="round"/>' +
        '<path d="M78 22 L92 14 L92 30 Z" fill="none" stroke="url(#chatCsHeartGrad)" stroke-width="2.6" stroke-linejoin="round"/>' +
        '<path d="M22 22c-6-10-18-9-18 2 0 9 10 14 18 18 8-4 18-9 18-18 0-11-12-12-18-2z" fill="none" stroke="#F4B0A5" stroke-width="2.2" stroke-linejoin="round"/>' +
        '<path d="M86 22c-6-10-18-9-18 2 0 9 10 14 18 18 8-4 18-9 18-18 0-11-12-12-18-2z" fill="none" stroke="#F4B0A5" stroke-width="2.2" stroke-linejoin="round"/>' +
        '</svg>';

    return (
        '<div class="chat-couple-space-surface"' +
        tsAttr +
        '>' +
        '<div class="chat-couple-space-scallop">' +
        '<div class="chat-couple-space-card">' +
        '<div class="chat-couple-space-badge">' +
        esc(title) +
        '</div>' +
        '<div class="chat-couple-space-sub">' +
        esc(subtitle) +
        '</div>' +
        '<div class="chat-couple-space-row">' +
        friendAvatar +
        connector +
        userAvatar +
        '</div>' +
        '<div class="chat-couple-space-names">' +
        '<span class="chat-couple-space-name">' +
        friendName +
        '</span>' +
        '<span class="chat-couple-space-dot" aria-hidden="true">·</span>' +
        '<span class="chat-couple-space-name">' +
        userName +
        '</span>' +
        '</div>' +
        '</div></div></div>'
    );
}

function buildLocationBubbleHtml(placeName, address, esc) {
    const linearMapSvg = `<svg class="chat-location-map-art" viewBox="0 0 220 112" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
<rect width="220" height="112" fill="#F5F1E8"/>
<path d="M0 62 Q55 52 110 58 T220 54" fill="none" stroke="#D8D3C9" stroke-width="9" stroke-linecap="round"/>
<path d="M0 62 Q55 52 110 58 T220 54" fill="none" stroke="#F5F1E8" stroke-width="3" stroke-linecap="round" opacity=".8"/>
<path d="M88 0 L88 46 Q88 58 100 62 L220 68" fill="none" stroke="#D8D3C9" stroke-width="7" stroke-linecap="round"/>
<path d="M88 0 L88 46 Q88 58 100 62 L220 68" fill="none" stroke="#F5F1E8" stroke-width="2.4" stroke-linecap="round" opacity=".8"/>
<path d="M0 88 Q40 80 80 84 Q120 88 160 78 Q190 70 220 72" fill="none" stroke="#C8C4BC" stroke-width="1.4" stroke-linecap="round"/>
<path d="M0 38 Q30 32 60 36 L88 40" fill="none" stroke="#C8C4BC" stroke-width="1.2" stroke-linecap="round"/>
<path d="M140 0 L140 44 Q140 54 152 58 L220 62" fill="none" stroke="#C8C4BC" stroke-width="1.2" stroke-linecap="round"/>
<path d="M0 104 Q50 96 100 100 Q150 104 220 94" fill="none" stroke="#C8C4BC" stroke-width="1" stroke-linecap="round" opacity=".6"/>
<path d="M155 112 Q168 98 178 88 Q188 78 200 72 Q210 68 220 66" fill="none" stroke="#9DBDBA" stroke-width="2.2" stroke-linecap="round" opacity=".55"/>
<path d="M155 112 Q168 98 178 88 Q188 78 200 72 Q210 68 220 66" fill="none" stroke="#B8D4D2" stroke-width="1" stroke-linecap="round" opacity=".7"/>
<g fill="none" stroke="#8A9E9C" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.2">
<rect x="8" y="22" width="14" height="18" rx="1"/>
<path d="M5 22 L15 14 L25 22"/>
<path d="M12 40 V32 H18 V40"/>
<rect x="26" y="28" width="10" height="12" rx="1"/>
<path d="M24 28 L31 22 L38 28"/>
<path d="M29 40 V34 H33 V40"/>
<rect x="40" y="18" width="18" height="22" rx="1"/>
<path d="M37 18 L49 10 L61 18"/>
<path d="M44 40 V31 H52 V40"/>
<path d="M47 31 V26"/>
</g>
<g fill="none" stroke="#8A9E9C" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.1">
<path d="M170 40 L178 26 L186 40"/>
<path d="M182 40 L192 22 L202 40"/>
<path d="M196 40 L204 28 L212 40"/>
<path d="M8 72 L14 62 L20 72"/>
<path d="M18 72 L25 60 L32 72"/>
<circle cx="42" cy="68" r="5"/>
<path d="M42 73 V76"/>
<circle cx="56" cy="70" r="4"/>
<path d="M56 74 V77"/>
<circle cx="68" cy="66" r="3.5"/>
<path d="M68 70 V73"/>
</g>
<circle cx="110" cy="58" r="18" fill="none" stroke="#6B7473" stroke-width="1" opacity=".12"/>
<circle cx="110" cy="58" r="10" fill="none" stroke="#6B7473" stroke-width="1" opacity=".1"/>
<circle cx="110" cy="58" r="4" fill="#6B7473" opacity=".5"/>
<circle cx="110" cy="58" r="2" fill="#6B7473" opacity=".85"/>
</svg>`;
    const pinHtml = `<span class="chat-location-map-pin" style="color:#6B7473">${ADDRESS_ICON_SVG}</span>`;
    const footerIcon = '<svg class="chat-location-footer-icon" viewBox="0 0 24 30" aria-hidden="true"><path d="M12 2C6.5 2 2 6.5 2 12c0 7 10 16 10 16s10-9 10-16c0-5.5-4.5-10-10-10z" fill="none" stroke="#FBF7EC" stroke-width="1.2"/><circle cx="12" cy="10" r="3" fill="#FBF7EC" opacity=".75"/></svg>';
    return `<div class="chat-message-bubble"><div class="chat-location-bubble"><div class="chat-location-map">${linearMapSvg}${pinHtml}</div><div class="chat-location-info"><div class="chat-location-place">${esc(placeName)}</div>${address ? `<div class="chat-location-address">${esc(address)}</div>` : ''}</div><div class="chat-location-footer">LOCATION${footerIcon}</div></div></div>`;
}

function buildLoveTakeoutCardFrameHtml(content, messageTimestamp, friendId, senderType) {
    const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    let payload = null;
    let liveOrder = null;
    try {
        const hist = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
        payload = hist.find(m => Number(m.timestamp) === Number(messageTimestamp) && m.subtype === 'love_takeout_order') || null;
    } catch (e) {}
    try {
        if (payload && payload.loveTakeoutOrderId && window.getLoveTakeoutOrderForChat) {
            liveOrder = window.getLoveTakeoutOrderForChat(friendId, payload.loveTakeoutOrderId) || null;
        }
    } catch (e) {}
    const items = liveOrder && Array.isArray(liveOrder.items) ? liveOrder.items : payload && Array.isArray(payload.loveTakeoutItems) ? payload.loveTakeoutItems : [];
    const totalPrice = liveOrder ? Number(liveOrder.totalPrice || 0) : payload ? Number(payload.loveTakeoutTotalPrice || 0) : 0;
    const status = liveOrder ? String(liveOrder.status || 'pending_delivery') : payload ? String(payload.loveTakeoutStatus || 'pending_delivery') : 'pending_delivery';
    const direction = liveOrder ? String(liveOrder.direction || '') : payload ? String(payload.loveTakeoutDirection || '') : '';
    const title = direction === 'char_to_user' ? '给你送来一份外卖' : '给你点了一份外卖';
    const itemLine = items.length ? items.map(it => String(it.name || '')).join('、') : String(content || '[爱的外卖]');
    const statusText = status === 'received' ? '已送达' : status === 'ready_to_receive' ? '待确认收餐' : '配送中';
    const statusClass = status === 'received' ? 'is-received' : status === 'ready_to_receive' ? 'is-ready' : 'is-pending';
    const ctaText = status === 'received' ? '查看详情' : '查看地图';
    const tsAttr = messageTimestamp != null ? ` data-message-timestamp="${esc(String(messageTimestamp))}"` : '';
    return `<div class="chat-message-bubble chat-message-bubble--love-takeout"${tsAttr}><button type="button" class="chat-love-takeout-card ${statusClass}" data-action="open_love_takeout_detail" data-order-id="${esc(String(payload && payload.loveTakeoutOrderId || ''))}" data-fid="${esc(String(friendId || ''))}" data-ts="${esc(String(messageTimestamp || ''))}"><div class="chat-love-takeout-badge">吃了么</div><div class="chat-love-takeout-title">${esc(title)}</div><div class="chat-love-takeout-items">${esc(itemLine)}</div><div class="chat-love-takeout-meta"><span class="chat-love-takeout-status ${statusClass}">${esc(statusText)}</span><span>¥ ${esc(totalPrice.toFixed(2))}</span></div><div class="chat-love-takeout-cta">${esc(ctaText)}</div></button></div>`;
}

// displayMessage：见 wechat-ui.js（Wechat.ui）

/** 取好友与 User 最近 maxRounds 轮完整来回，格式化为 API 文本（与 buildWechatSendContent 轮定义一致） */
function getRecentChatHistoryLinesForMoments(friendId, maxRounds, fmt) {
    const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    const rounds = [];
    let i = 0;
    while (i < chatHistory.length) {
        const round = { user: [], friend: [] };
        while (i < chatHistory.length && chatHistory[i].type === 'user') {
            const msg = chatHistory[i];
            round.user.push(
                typeof compactChatMessageContentForApi === 'function'
                    ? compactChatMessageContentForApi(msg)
                    : msg.content
            );
            i++;
        }
        while (i < chatHistory.length && chatHistory[i].type === 'friend') {
            const msg = chatHistory[i];
            round.friend.push(
                typeof compactChatMessageContentForApi === 'function'
                    ? compactChatMessageContentForApi(msg)
                    : msg.content
            );
            i++;
        }
        if (round.user.length > 0 && round.friend.length > 0) rounds.push(round);
        while (i < chatHistory.length && chatHistory[i].type !== 'user' && chatHistory[i].type !== 'friend') i++;
    }
    const recent = rounds.slice(-(maxRounds || 20));
    const lines = [];
    recent.forEach(r => {
        r.user.forEach(c => lines.push(`用户: ${fmt(c)}`));
        r.friend.forEach(c => lines.push(`好友: ${fmt(c)}`));
    });
    if (lines.length === 0) return '（暂无完整来回记录，仅依据角色卡与关系发一条合理的生活向朋友圈即可）';
    return lines.join('\n');
}

/** 朋友圈新评论 prompt 专用别名（与 getRecentChatHistoryLinesForMoments 逻辑完全一致） */
function _buildMomentsChatHistoryLines(friendId, maxRounds, fmt) {
    return getRecentChatHistoryLinesForMoments(friendId, maxRounds, fmt);
}
if (typeof Moments !== 'undefined') {
    Moments.buildMomentsChatHistoryLines = _buildMomentsChatHistoryLines;
}

/** 仅移除 JSON 结构层的尾逗号（不触碰字符串内的逗号） */
function removeTrailingCommasFromJsonLike(s) {
    if (!s || typeof s !== 'string') return s;
    const out = [];
    let inString = false;
    let escape = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (escape) {
            out.push(c);
            escape = false;
            continue;
        }
        if (inString) {
            if (c === '\\') {
                out.push(c);
                escape = true;
                continue;
            }
            if (c === '"') {
                inString = false;
                out.push(c);
                continue;
            }
            out.push(c);
            continue;
        }
        if (c === '"') {
            inString = true;
            out.push(c);
            continue;
        }
        if (c === ',' && i + 1 < s.length) {
            let j = i + 1;
            while (j < s.length && (s[j] === ' ' || s[j] === '\t' || s[j] === '\n' || s[j] === '\r')) j++;
            if (j < s.length && (s[j] === '}' || s[j] === ']')) continue;
        }
        out.push(c);
    }
    return out.join('');
}

function extractJsonObjectFromApiText(text) {
    if (!text || typeof text !== 'string') return null;
    let s = text.trim().replace(/^\uFEFF/, '');
    const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(s);
    if (fence) s = fence[1].trim();
    function tryParseFragment(fragment) {
        if (!fragment || typeof fragment !== 'string') return null;
        const candidates = [fragment, removeTrailingCommasFromJsonLike(fragment)];
        for (let k = 0; k < candidates.length; k++) {
            try {
                const parsed = JSON.parse(candidates[k]);
                if (parsed !== null && typeof parsed === 'object') return parsed;
            } catch (_) {}
        }
        return null;
    }
    let parsed = tryParseFragment(s);
    if (parsed) return parsed;

    const arrStart = s.indexOf('[');
    const arrEnd = s.lastIndexOf(']');
    if (arrStart !== -1 && arrEnd > arrStart) {
        parsed = tryParseFragment(s.slice(arrStart, arrEnd + 1));
        if (parsed) return parsed;
    }
    const start = s.indexOf('{');
    const end = s.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    parsed = tryParseFragment(s.slice(start, end + 1));
    if (parsed) return parsed;
    console.warn('JSON 解析失败: 模型输出无法解析为 JSON 对象');
    return null;
}

/** 朋友圈 · 转发（由 Moments.ui.openMomentsForwardPicker 实现） */
function forwardMomentsPost(postId) {
    if (typeof Moments !== 'undefined' && Moments.ui && typeof Moments.ui.openMomentsForwardPicker === 'function') {
        Moments.ui.openMomentsForwardPicker(postId);
    }
}
if (typeof Moments !== 'undefined') {
    Moments.forwardMomentsPost = forwardMomentsPost;
}

// 收藏 / 线下模式 / 长记忆 / processFriendResponse：见 wechat-ui-extras.js

// 更新头像显示（传入已压缩的 data URL，避免 localStorage 配额超限）
function updateAvatarDisplay(avatarData) {
    const avatarPreview = document.getElementById('avatarPreview');
    if (avatarPreview) {
        avatarPreview.src = avatarData;
    }

    if (!avatarData) { hideLoading(); return; }
    compressImageDataUrl(avatarData, 256, 0.82).then(function(compressed) {
        localStorage.setItem('userAvatar', compressed);
        hideLoading();
    }).catch(function() {
        try { localStorage.setItem('userAvatar', avatarData); } catch (e) {}
        hideLoading();
    });
}

// 打开编辑个人资料模态框
function openEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    if (modal) {
        modal.classList.add('show');
        
        const effective = getEffectiveWechatMeProfileForDisplay();
        
        // 预填当前昵称
        const nicknameInput = document.getElementById('nickname-input');
        if (nicknameInput) {
            nicknameInput.value = (effective && effective.nickname) ? effective.nickname : '可点击编辑';
        }

        // 预填当前微信号
        const wechatIdInput = document.getElementById('wechat-id-input');
        if (wechatIdInput) {
            wechatIdInput.value = (effective && effective.wechatId) ? effective.wechatId : 'wx_id_...';
        }
        
        // 预填当前头像（与人设卡一致）
        const avatarPreview = document.getElementById('avatar-preview-img');
        if (avatarPreview) {
            const av = normalizeAvatarUrl(effective && effective.avatar);
            avatarPreview.src = av || '';
        }
    }
}

// 关闭编辑个人资料模态框
function closeEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 打开选择人设模态框（可从好友设置或添加好友模态框调用）
function openSelectPersonaModal() {
    window._personaSelectContext = 'friendSettings';
    const modal = document.getElementById('select-persona-modal');
    if (modal) {
        modal.classList.add('show');
        loadPersonaList();
    }
}

function openSelectPersonaModalForGroup() {
    window._personaSelectContext = 'groupSettings';
    const modal = document.getElementById('select-persona-modal');
    if (modal) {
        modal.classList.add('show');
        loadPersonaList();
    }
}

// 从添加好友模态框打开角色卡选择
function openAddFriendPersonaSelect() {
    window._personaSelectContext = 'addFriend';
    const modal = document.getElementById('select-persona-modal');
    if (modal) {
        modal.classList.add('show');
        loadPersonaList();
    }
}

// 关闭选择人设模态框
function closeSelectPersonaModal() {
    const modal = document.getElementById('select-persona-modal');
    if (modal) {
        modal.classList.remove('show');
    }
    window._personaSelectContext = null;
}

// 加载人设列表
function loadPersonaList() {
    const personaList = document.getElementById('persona-list');
    if (!personaList) return;
    
    // 从localStorage中读取保存的人设
    const myProfile = safeReadJsonFromStorage('myProfile', null);
    
    if (!myProfile || !myProfile.nickname) {
        personaList.innerHTML = '<div class="empty-persona">暂无保存的人设</div><div class="persona-empty-hint">可在「我 → 我的人设」先保存人设，或点击空白处关闭</div>';
        return;
    }
    
    personaList.innerHTML = '';
    
    // 创建人设项
    const personaItem = document.createElement('div');
    personaItem.className = 'persona-item';
    personaItem.textContent = myProfile.nickname;
    personaItem.onclick = function () {
        try {
            selectPersona(JSON.parse(JSON.stringify(myProfile)));
        } catch (e) {
            selectPersona(myProfile);
        }
    };
    personaList.appendChild(personaItem);
}

// 选择人设
function selectPersona(persona) {
    const context = window._personaSelectContext || 'friendSettings';
    window._personaSelectContext = null;
    
    if (context === 'addFriend') {
        try {
            window._addFriendSelectedPersona = persona ? JSON.parse(JSON.stringify(persona)) : null;
        } catch (e) {
            console.warn('[添加好友] 人设深拷贝失败，使用引用:', e && (e.message || e));
            window._addFriendSelectedPersona = persona;
        }
        const addFriendModal = document.getElementById('add-friend-modal');
        const avatarPlaceholder = addFriendModal ? addFriendModal.querySelector('.avatar-placeholder') : null;
        const addFriendAv = normalizeAvatarUrl(persona && persona.avatar);
        if (avatarPlaceholder && addFriendAv) {
            avatarPlaceholder.style.backgroundImage = `url(${addFriendAv})`;
            avatarPlaceholder.style.backgroundSize = 'cover';
            avatarPlaceholder.style.backgroundPosition = 'center';
            avatarPlaceholder.textContent = '';
            const avatarPlus = avatarPlaceholder.querySelector('.avatar-plus');
            if (avatarPlus) avatarPlus.style.display = 'none';
        }
        closeSelectPersonaModal();
        return;
    }

    if (context === 'groupSettings') {
        const groupModal = document.getElementById('group-settings-modal');
        const groupId = groupModal ? groupModal.dataset.groupId : null;
        const selectedPersonaDisplay = document.getElementById('group-selected-persona-display');
        if (selectedPersonaDisplay) {
            selectedPersonaDisplay.textContent = persona.nickname || persona.name;
        }
        if (groupId && tempGroupData[groupId]) {
            try {
                tempGroupData[groupId].groupMyPersona = persona ? JSON.parse(JSON.stringify(persona)) : null;
            } catch (e) {
                tempGroupData[groupId].groupMyPersona = persona;
            }
        }
        // 立即同步到当前群聊聊天界面的“我方头像”（无需重新进入）
        updateGroupMyAvatarDisplayIfActive(
            groupId,
            tempGroupData[groupId] ? tempGroupData[groupId].groupMyChatAvatar : '',
            persona
        );
        // 若尚未上传群聊专属头像，则用人设头像做预览
        const preview = document.getElementById('group-chat-avatar-preview');
        const hint = document.getElementById('group-chat-avatar-hint');
        const groupPersonaAv = normalizeAvatarUrl(persona && persona.avatar);
        if (preview && groupPersonaAv) {
            if (hint) hint.style.display = 'none';
            preview.style.backgroundImage = `url(${groupPersonaAv})`;
            preview.style.backgroundSize = 'cover';
            preview.style.backgroundPosition = 'center';
        }
        closeSelectPersonaModal();
        return;
    }
    
    // 好友设置场景
    const friendSettingsModal = document.getElementById('friend-settings-modal');
    const friendId = friendSettingsModal ? friendSettingsModal.dataset.friendId : null;
    
    // 更新显示
    const selectedPersonaDisplay = document.getElementById('selected-persona-display');
    if (selectedPersonaDisplay) {
        selectedPersonaDisplay.textContent = persona.nickname || persona.name;
    }
    
    // 更新聊天中的头像预览
    const chatAvatarPreview = document.getElementById('chat-avatar-preview');
    const friendSettingsPersonaAv = normalizeAvatarUrl(persona && persona.avatar);
    if (chatAvatarPreview && friendSettingsPersonaAv) {
        chatAvatarPreview.style.backgroundImage = `url(${friendSettingsPersonaAv})`;
        chatAvatarPreview.style.backgroundSize = 'cover';
        chatAvatarPreview.style.backgroundPosition = 'center';
        // 隐藏提示文字
        const chatAvatarHint = document.querySelector('.chat-avatar-hint');
        if (chatAvatarHint) {
            chatAvatarHint.style.display = 'none';
        }
    }
    
    // 保存到临时数据（深拷贝，避免与 myProfile 引用共享导致后续编辑/存储异常）
    if (friendId) {
        if (!tempFriendData[friendId]) {
            tempFriendData[friendId] = {};
        }
        try {
            tempFriendData[friendId].persona = persona ? JSON.parse(JSON.stringify(persona)) : null;
        } catch (e) {
            tempFriendData[friendId].persona = persona;
        }
    }
    
    // 关闭模态框
    closeSelectPersonaModal();
}

// 触发头像上传
function triggerAvatarUpload() {
    const fileInput = document.getElementById('avatar-upload');
    if (fileInput) {
        fileInput.click();
    }
}

// 处理个人资料头像上传
function handleProfileAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        if (!e.target.result) return;
        const avatarPreview = document.getElementById('avatar-preview-img');
        if (!avatarPreview) return;
        // 先显示原始预览，再用压缩结果覆盖
        avatarPreview.src = e.target.result;
        compressImageDataUrl(e.target.result, 256, 0.82).then(function(compressed) {
            avatarPreview.dataset.compressed = compressed;
        }).catch(function() {});
    };
    reader.readAsDataURL(file);
}

// 保存个人资料
function saveProfile() {
    const nicknameInput = document.getElementById('nickname-input');
    const wechatIdInput = document.getElementById('wechat-id-input');
    const avatarPreview = document.getElementById('avatar-preview-img');

    if (!nicknameInput) return;
    const newNickname = nicknameInput.value.trim();
    if (!newNickname) { showNotification('请输入昵称'); return; }

    const newWechatId = wechatIdInput ? wechatIdInput.value.trim() : '';
    if (!newWechatId) { showNotification('请输入微信号'); return; }

    const avatarSrc = avatarPreview && avatarPreview.dataset && avatarPreview.dataset.compressed
        ? avatarPreview.dataset.compressed
        : (avatarPreview ? avatarPreview.src : '');

    const saveToStorage = function(avatar) {
        const payload = { nickname: newNickname, avatar: avatar, wechatId: newWechatId };
        try {
            localStorage.setItem('userInfo', JSON.stringify(payload));
            try {
                const mp = safeReadJsonFromStorage('myProfile', null);
                if (mp && typeof mp === 'object') {
                    mp.nickname = newNickname;
                    if (normalizeAvatarUrl(avatar)) mp.avatar = avatar;
                    localStorage.setItem('myProfile', JSON.stringify(mp));
                }
            } catch (e) {}
            if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.syncWechatMeNameAndAvatar === 'function') {
                Wechat.ui.syncWechatMeNameAndAvatar(newNickname, avatar, newWechatId);
            } else if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.syncWechatMeId === 'function') {
                Wechat.ui.syncWechatMeId(newWechatId);
            }
            updateGlobalUserInfo(newNickname, avatar);
            showNotification('个人资料已更新');
            closeEditProfileModal();
        } catch (err) {
            if (err.name === 'QuotaExceededError') {
                showNotification('保存失败：头像图片过大，请换用更小的图片');
            } else {
                showNotification('保存失败');
            }
        }
    };

    // avatar 已是压缩格式（data URL）时直接保存；否则压缩后再存
    if (avatarSrc && typeof avatarSrc === 'string' && avatarSrc.startsWith('data:')) {
        saveToStorage(avatarSrc);
    } else {
        compressImageDataUrl(avatarSrc, 256, 0.82).then(function(compressed) {
            saveToStorage(compressed);
        }).catch(function() {
            saveToStorage(avatarSrc);
        });
    }
}

// 更新全局用户信息
function updateGlobalUserInfo(nickname, avatar) {
    // 更新微信聊天界面的用户信息
    const chatHeaders = document.querySelectorAll('.chat-header h1');
    chatHeaders.forEach(header => {
        if (header.textContent === '可点击编辑') {
            header.textContent = nickname;
        }
    });
    
    if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.renderWechatMeAvatar === 'function') {
        Wechat.ui.renderWechatMeAvatar(avatar);
    }
    
    // 更新其他需要显示用户信息的地方（仅用于朋友圈等，不影响聊天界面）
    if (typeof Moments !== 'undefined' && Moments.ui && typeof Moments.ui.refreshMomentsProfileHeader === 'function') {
        Moments.ui.refreshMomentsProfileHeader();
    }
}

// 关闭编辑个人资料模态框
function closeEditProfileModal() {
    const modal = document.getElementById('edit-profile-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 添加通知样式
const style = document.createElement('style');
style.textContent = `
    .notification {
        position: fixed;
        top: 20px;
        left: 50%;
        transform: translateX(-50%) translateY(-100px);
        background: rgba(0, 0, 0, 0.8);
        color: white;
        padding: 12px 20px;
        border-radius: 20px;
        font-size: 14px;
        font-weight: 500;
        z-index: 2000;
        transition: all 0.3s ease;
        box-shadow: 0 4px 12px rgba(0, 0, 0, 0.2);
    }
    
    .notification.show {
        transform: translateX(-50%) translateY(0);
    }
`;
document.head.appendChild(style);

// 初始化时钟
function initClock() {
    updateClock();
    // 每秒更新一次时钟
    setInterval(updateClock, 1000);
}

// 更新时钟
function updateClock() {
    const now = new Date();
    
    // 更新时钟指针
    const hourHand = document.querySelector('.hour-hand');
    const minuteHand = document.querySelector('.minute-hand');
    const secondHand = document.querySelector('.second-hand');
    
    if (hourHand && minuteHand && secondHand) {
        const hours = now.getHours() % 12;
        const minutes = now.getMinutes();
        const seconds = now.getSeconds();
        
        const hourAngle = (hours * 30) + (minutes * 0.5);
        const minuteAngle = minutes * 6;
        const secondAngle = seconds * 6;
        
        hourHand.style.transform = `rotate(${hourAngle}deg)`;
        minuteHand.style.transform = `rotate(${minuteAngle}deg)`;
        secondHand.style.transform = `rotate(${secondAngle}deg)`;
    }
    
    // 更新星期
    const clockDay = document.querySelector('.clock-day');
    if (clockDay) {
        const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const dayIndex = now.getDay();
        clockDay.textContent = days[dayIndex];
    }
}

// 初始化状态栏
function initStatusBar() {
    // 初始化信号强度和电池电量显示
    updateSignalStrength();
    updateBatteryStatus();
    
    // 初始化时间并设置定时更新
    updateTime();
    setInterval(updateTime, 1000);
    
    // 模拟信号强度变化
    setInterval(simulateSignalChange, 5000);
    
    // 模拟电池电量变化
    setInterval(simulateBatteryChange, 10000);
    
    // 模拟充电状态变化
    setInterval(simulateChargingChange, 15000);
}

// 更新信号强度
function updateSignalStrength() {
    const signalIcon = document.querySelector('.status-icon:nth-child(1) img');
    if (signalIcon) {
        // 根据信号强度和网络类型更新图标
        // 这里使用模拟数据，实际应用中应从系统获取
        signalIcon.src = getSignalIconPath();
    }
}

// 更新电池状态
function updateBatteryStatus() {
    const batteryIcon = document.querySelector('.status-icon:nth-child(2) img');
    if (batteryIcon) {
        // 根据电池电量和充电状态更新图标
        // 这里使用模拟数据，实际应用中应从系统获取
        batteryIcon.src = getBatteryIconPath();
    }
}

// 获取信号图标路径
function getSignalIconPath() {
    // 这里返回模拟的图标路径，实际应用中应根据网络类型和信号强度返回不同的图标
    // 由于我们只有一个信号图标文件，这里直接返回signal.png
    return 'data:image/png;base64,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';
}

// 获取电池图标路径
function getBatteryIconPath() {
    // 这里返回模拟的图标路径，实际应用中应根据电池电量和充电状态返回不同的图标
    // 由于我们只有一个电池图标文件，这里直接返回battery.png
    return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAT8AAADJCAYAAABVGjUbAAAAAXNSR0IArs4c6QAAIABJREFUeF7tnQfUXVP6xl8TXXQSRAnRE8GMMlmIhSUFEVGj1ygTUYLRuyjRmcEoI7rBjDaiS0R0wui9G51EL2P812/7729Obu69p95zz73n2Wt9S6x7yn6f/e7nvG3vPZ2Z/WJqQkAICIGSITCdyK9kIy5xhYAQcAiI/KQIQkAIlBIBkV8ph11CCwEhIPKTDggBIVBKBER+pRx2CS0EhIDITzogBIRAKREQ+ZVy2CW0EBACIj/pgBAQAqVEQORXymGX0EJACIj8pANCQAiUEgGRXymHXUILASEg8pMOCAEhUEoERH6lHHYJLQSEgMhPOiAEhEApERD5lXLYJbQQEAIiP+mAEBACpURA5FfKYZfQQkAIiPykA0JACJQSAZFfKYddQgsBISDykw4IASFQSgREfqUcdgktBISAyE86IASEQCkREPmVctgltBAQAiI/6YAQEAKlREDkV8phl9BCQAiI/KQDQkAIlBIBkV8ph11CCwEhIPKTDggBIVBKBER+pRx2CS0EhIDITzogBIRAKREQ+ZVy2CW0EBACIj/pgBAQAqVEQORXymGX0EJACIj8pANCQAiUEgGRXymHXUILASEg8pMOCAEhUEoERH6lHHYJLQSEgMhPOiAEhEApERD5lXLYJbQQEAIiP+mAEBACpURA5FfKYZfQQkAIiPzq6MCMM85os802m80000z2m9/8RtoiBEqJwE8//WTff/+9fffdd/af//ynbTAQ+QWGcoYZZrAePXpY79693X8XWmgh69q1q80111w2/fTT2y+//NI2Ay9BhEBUBL755hv75JNP7P3337c333zTXn75ZXvxxRftiy++iPqIQl4n8jOzBRdc0NZbbz1be+21rVevXrbAAgvYrLPO6iw+rD+Ib7rpgEpNCJQPAaw9rL8ffvjBWX+ff/65I8EHHnjA7rrrLnv11Vfdb63WSk1+3bp1s4033tgGDx5syy23nM0999yO9CA6b+WJ9FpNpdXfRiDAfODPzwfIcPLkyfbGG284ArzhhhucRdhKbnEpyW+WWWaxddZZx3beeWfr06ePzTfffM7CCw7uf//73w4CrIz3iRAbMb30zCIi4EnPzw10P2gcME8gQdzga6+91v7xj3/Yhx9+WERR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';
}

// 模拟信号强度变化
function simulateSignalChange() {
    // 随机变化信号强度
    signalStrength = Math.floor(Math.random() * 5);
    // 随机切换网络类型
    if (Math.random() > 0.7) {
        networkType = networkType === 'wifi' ? 'mobile' : 'wifi';
    }
    // 更新信号图标
    updateSignalStrength();
}

// 模拟电池电量变化
function simulateBatteryChange() {
    // 随机减少1-3%的电量
    batteryLevel = Math.max(0, batteryLevel - Math.floor(Math.random() * 3) - 1);
    // 更新电池状态
    updateBatteryStatus();
    
    // 当电量低于20%时，标记为低电量状态
    if (batteryLevel < 20) {
        batteryStatus = 'low';
    } else {
        batteryStatus = 'normal';
    }
    
    // 当电量为0时，重置为85%
    if (batteryLevel === 0) {
        batteryLevel = 85;
    }
}

// 模拟充电状态变化
function simulateChargingChange() {
    // 随机切换充电状态
    isCharging = !isCharging;
    // 更新电池状态
    updateBatteryStatus();
    
    // 如果正在充电，增加电量
    if (isCharging) {
        batteryStatus = 'charging';
        // 模拟充电增加电量
        batteryLevel = Math.min(100, batteryLevel + 5);
        updateBatteryStatus();
    } else {
        // 恢复正常状态
        batteryStatus = batteryLevel < 20 ? 'low' : 'normal';
    }
}

// 打开子设置页面
function openSubSettings(subPage) {
    // 根据subPage参数执行不同的操作
    switch (subPage) {
        case 'export-full':
            exportAllData();
            break;
        case 'import':
            openImportModal();
            break;
        case 'voice':
            navigateTo('voice-settings');
            loadVoiceSettings();
            break;
        default:
            showNotification(`打开${subPage}设置`);
    }
}

// 打开导入数据模态框
function openImportModal() {
    // 创建文件输入元素
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.json';
    
    // 监听文件选择
    input.onchange = function(e) {
        const file = e.target.files[0];
        if (file) {
            importData(file);
        }
    };
    
    // 触发文件选择
    input.click();
}

const BACKUP_IDENTIFIER = 'Lego小手机';
const FRIENDS_LS_KEY = 'friends';

// ========== 系统指令开发者锁 ==========
// 设为 false = 完全锁定（任何修改指令的操作均被拦截）
// 设为 true  = 解锁，可正常进入系统页并添加/编辑/删除/切换系统指令
const __SYSTEM_DEV_MODE__ = false;

// ========== 系统默认好友（系统角色，不可删除） ==========
const SYSTEM_DEFAULT_FRIENDS_FILES = [
    'system_friend_Ghost.json',
    'system_friend_Keegan.json',
    'system_friend_Krueger.json',
    'system_friend_Nikto.json',
    'system_friend_Konig.json',
];

/**
 * 外置 system_friend_*.json 无法 fetch 时（离线、错误根路径、部分内置浏览器拦截等）仍保证消息列表有预设好友。
 * 完整人设以仓库内 JSON 为准；此处仅保证列表可渲染与对话可用。
 */
const SYSTEM_DEFAULT_FRIENDS_FALLBACK_MINIMAL = [
    { id: 'system_ghost', isSystemDefault: true, nickname: 'Ghost', remark: '', roleSetting: '系统内置预设角色。完整人设以程序目录 system_friend_Ghost.json 为准。', avatar: '', chatAvatar: '', persona: null, isGroup: false, blacklisted: false, momentsHidden: false, memoryRounds: 0, voiceId: '', voiceLanguage: 'en', outputLanguage: 'zh', showTimestamp: false, hideAvatar: false },
    { id: 'system_keegan', isSystemDefault: true, nickname: 'Keegan', remark: '', roleSetting: '系统内置预设角色。完整人设以 system_friend_Keegan.json 为准。', avatar: '', chatAvatar: '', persona: null, isGroup: false, blacklisted: false, momentsHidden: false, memoryRounds: 0, voiceId: '', voiceLanguage: 'en', outputLanguage: 'zh', showTimestamp: false, hideAvatar: false },
    { id: 'system_krueger', isSystemDefault: true, nickname: 'Krueger', remark: '', roleSetting: '系统内置预设角色。完整人设以 system_friend_Krueger.json 为准。', avatar: '', chatAvatar: '', persona: null, isGroup: false, blacklisted: false, momentsHidden: false, memoryRounds: 0, voiceId: '', voiceLanguage: 'en', outputLanguage: 'zh', showTimestamp: false, hideAvatar: false },
    { id: 'system_nikto', isSystemDefault: true, nickname: 'Nikto', remark: '', roleSetting: '系统内置预设角色。完整人设以 system_friend_Nikto.json 为准。', avatar: '', chatAvatar: '', persona: null, isGroup: false, blacklisted: false, momentsHidden: false, memoryRounds: 0, voiceId: '', voiceLanguage: 'en', outputLanguage: 'zh', showTimestamp: false, hideAvatar: false },
    { id: 'system_konig', isSystemDefault: true, nickname: 'König', remark: '', roleSetting: '系统内置预设角色。完整人设以 system_friend_Konig.json 为准。', avatar: '', chatAvatar: '', persona: null, isGroup: false, blacklisted: false, momentsHidden: false, memoryRounds: 0, voiceId: '', voiceLanguage: 'en', outputLanguage: 'zh', showTimestamp: false, hideAvatar: false }
];

// 注意：顶层 let 不会挂到 window；wechat-store.js 通过 globalThis._cachedSystemDefaults 参与合并，必须同步
let _cachedSystemDefaults = null;

function syncCachedSystemDefaultsToGlobal() {
    try {
        if (typeof globalThis !== 'undefined') {
            globalThis._cachedSystemDefaults = _cachedSystemDefaults;
        }
    } catch (e) {}
}

/** 解析 system_friend_*.json 的可选 URL（页面在 dist/ 子目录或嵌套路由时，相对当前页的路径会 404） */
/** 说明：仓库根目录与 dist/ 下可能各有一份同名 JSON（便于只部署 dist）；fetch 在「每个文件名」上首次成功即停止，不会把两份都加载进列表。若列表出现双份预设，根因是 _cachedSystemDefaults 或合并结果里同一 id 出现多次，由 dedupe 兜底。 */
function getSystemFriendJsonCandidateUrls(filename) {
    const out = [];
    const push = (u) => {
        if (u && out.indexOf(u) === -1) out.push(u);
    };
    push(filename);
    try {
        push(new URL(filename, window.location.href).href);
    } catch (e) {}
    try {
        const sc = document.querySelector('script[src*="app.js"]');
        if (sc && sc.src) push(new URL(filename, sc.src).href);
    } catch (e) {}
    try {
        push(new URL('../' + filename, window.location.href).href);
    } catch (e) {}
    return out;
}

async function loadSystemDefaultFriends() {
    if (_cachedSystemDefaults !== null) return _cachedSystemDefaults;
    let friends = [];
    for (const file of SYSTEM_DEFAULT_FRIENDS_FILES) {
        let loaded = null;
        const urls = getSystemFriendJsonCandidateUrls(file);
        for (let u = 0; u < urls.length; u++) {
            try {
                const resp = await fetch(urls[u], { cache: 'no-cache' });
                if (!resp.ok) continue;
                const data = await resp.json();
                if (data && typeof data === 'object') {
                    loaded = data;
                    break;
                }
            } catch (e) {}
        }
        if (loaded) {
            friends.push(loaded);
        } else {
            console.warn('[系统好友] 所有路径均加载失败:', file, urls);
        }
    }
    if (friends.length === 0 && Array.isArray(SYSTEM_DEFAULT_FRIENDS_FALLBACK_MINIMAL) && SYSTEM_DEFAULT_FRIENDS_FALLBACK_MINIMAL.length > 0) {
        console.warn('[系统好友] 外置 JSON 全部未能加载，已启用内置最小预设（请检查网络、静态资源路径或是否拦截 fetch）');
        friends = SYSTEM_DEFAULT_FRIENDS_FALLBACK_MINIMAL.map(function (row) {
            return JSON.parse(JSON.stringify(row));
        });
    }
    try {
        if (typeof dedupeFriendsByIdPreserveOrder === 'function') {
            friends = dedupeFriendsByIdPreserveOrder(friends);
        }
    } catch (e) {}
    _cachedSystemDefaults = friends;
    syncCachedSystemDefaultsToGlobal();
    return friends;
}

function getSystemDefaultFriendIds() {
    if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.getSystemDefaultFriendIds === 'function') {
        return Wechat.store.getSystemDefaultFriendIds();
    }
    return SYSTEM_DEFAULT_FRIENDS_FILES.map(f => {
        const m = f.match(/system_friend_(.+)\.json$/);
        return m ? 'system_' + m[1].toLowerCase() : null;
    }).filter(Boolean);
}

function isSystemDefaultFriend(friendId) {
    if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.isSystemDefaultFriend === 'function') {
        return Wechat.store.isSystemDefaultFriend(friendId);
    }
    const ids = getSystemDefaultFriendIds();
    return ids.includes(String(friendId).toLowerCase());
}

function mergeSystemDefaults(userFriends) {
    if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.mergeSystemDefaults === 'function') {
        return Wechat.store.mergeSystemDefaults(userFriends);
    }
    if (!Array.isArray(userFriends)) userFriends = [];
    if (_cachedSystemDefaults === null) {
        return userFriends.slice();
    }
    const sysIds = new Set(getSystemDefaultFriendIds());
    const userIds = new Set(userFriends.map(f => String(f.id).toLowerCase()));
    const merged = userFriends.filter(f => !sysIds.has(String(f.id).toLowerCase()));
    const cachedDeduped =
        typeof dedupeFriendsByIdPreserveOrder === 'function'
            ? dedupeFriendsByIdPreserveOrder(_cachedSystemDefaults)
            : _cachedSystemDefaults;
    for (const sys of cachedDeduped) {
        const uid = String(sys.id).toLowerCase();
        if (userIds.has(uid)) {
            const existing = userFriends.find(f => String(f.id).toLowerCase() === uid);
            if (existing) merged.push(existing);
        } else {
            merged.push(sys);
        }
    }
    return typeof dedupeFriendsByIdPreserveOrder === 'function' ? dedupeFriendsByIdPreserveOrder(merged) : merged;
}

// 保存时合并（同时适用于正常保存与导入）：
//   - 普通好友：原样保留
//   - 系统预设好友：以用户数据为准（优先保留用户在导入数据中修改过的头像/角色卡等信息）
//     若导入数据中没有某系统好友，则用系统默认值补入
function mergeSystemDefaultsSave(userFriends) {
    if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.mergeSystemDefaultsSave === 'function') {
        return Wechat.store.mergeSystemDefaultsSave(userFriends);
    }
    if (!Array.isArray(userFriends)) userFriends = [];
    const result = userFriends.slice();
    if (_cachedSystemDefaults !== null) {
        const cachedDeduped =
            typeof dedupeFriendsByIdPreserveOrder === 'function'
                ? dedupeFriendsByIdPreserveOrder(_cachedSystemDefaults)
                : _cachedSystemDefaults;
        for (const sys of cachedDeduped) {
            const uid = String(sys.id).toLowerCase();
            if (!result.some(f => String(f.id).toLowerCase() === uid)) {
                result.push(sys);
            }
        }
    }
    return typeof dedupeFriendsByIdPreserveOrder === 'function' ? dedupeFriendsByIdPreserveOrder(result) : result;
}
const MOMENTS_POSTS_LS_KEY = 'momentsPosts';
const WECHAT_FAVORITES_LS_KEY = 'wechatFavorites';
const EMOJI_DATA_LS_KEY = 'emojiData';
const EMOJI_CATEGORIES_LS_KEY = 'emojiCategories';
const WECHAT_DATA_LS_KEY = 'wechatData';
const USER_INFO_LS_KEY = 'userInfo';
const MY_PROFILE_LS_KEY = 'myProfile';
const WECHAT_GLOBAL_BG_LS_KEY = 'wechatGlobalBackgroundImageDataUrl';
const WECHAT_BUBBLE_CSS_LS_KEY = 'wechatBubbleCustomCss';
const WECHAT_GLOBAL_FONT_LS_KEY = 'wechatGlobalFontDataUrl';
const MUSIC_PLAYER_COVER_LS_KEY = 'musicPlayerCover';
const MOMENTS_COVER_LS_KEY = 'momentsCoverImageDataUrl';
const LS_LZ_PREFIX = 'LZUTF16:';
const LS_CHUNK_PREFIX = 'CHUNKED:';
/** 分片存 LZ 压缩后的 UTF16 串，体积远小于 CHUNKED: 明文，缓解总配额爆满 */
const LS_CHUNK_LZ_PREFIX = 'CHUNKEDLZ:';
const LS_CHUNK_SEP = '__chunk__';
const LS_IDB_PREFIX = 'IDB:';

// IndexedDB KV（openWechatKvDB / wechatKvSet 等）：见 wechat-store.js

// 批量清理 IndexedDB 数据
async function clearIndexedDBKeys(keys) {
    for (const key of keys) {
        try {
            await wechatKvDelete(key);
        } catch (e) {}
    }
}

// emojiData / emojiCategories 的 IDB 回退与缓存：见 wechat-emoji.js（Wechat.emoji）

// momentsPosts：IDB 与同步读缓存在 moments-store.js（Moments.store.__momentsPostsCache）

// 导入数据
function importData(file) {
    showLoading('正在导入数据...');
    
    const reader = new FileReader();
    
    reader.onload = async function(e) {
        let backupData;
        try {
            let content = e.target.result;
            // 兼容：部分浏览器/编辑器会在文件头写入 BOM，导致识别码判断失败
            if (typeof content === 'string') content = content.replace(/^\uFEFF/, '');
            
            const headerOk =
                content.startsWith(BACKUP_IDENTIFIER + '\n') ||
                content.startsWith(BACKUP_IDENTIFIER + '\r\n') ||
                content.startsWith('Logan 小手机\n') ||
                content.startsWith('Logan 小手机\r\n');
            if (!headerOk) {
                hideLoading();
                showNotification('用户数据错误无法识别');
                return;
            }
            
            const jsonContent = content.replace(/^(Lego小手机|Logan 小手机)(\r?\n)/, '');
            backupData = JSON.parse(jsonContent);
            
            if (!backupData.data) {
                hideLoading();
                showNotification('导入格式错误：无效的备份数据结构');
                return;
            }
        } catch (parseError) {
            hideLoading();
            showNotification(`导入格式错误：${parseError.message || '无法解析备份文件'}`);
            return;
        }

        try {
            await strictImportAllData(backupData);
        } catch (err) {
            console.error('数据导入失败:', err);
            hideLoading();
            showNotification('数据导入失败');
            try {
                showErrorDialog('数据导入失败', String(err && (err.message || err) || '未知错误'));
            } catch (e) {}
            return;
        }

        hideLoading();
        showNotification('数据导入成功');
        try {
            loadApiSettings({ forceFormSync: true });
            checkApiInputs();
        } catch (e) {}
        // 标记：刷新后进行渐进式预热，改善首次进入微信等页面的等待
        try { sessionStorage.setItem('__POST_IMPORT_PREWARM__', '1'); } catch (e) {}
        setTimeout(() => location.reload(), 2500);
    };
    
    reader.onerror = function() {
        hideLoading();
        showNotification('读取文件失败');
    };
    
    reader.readAsText(file);
}

function assertBackup(condition, message) {
    if (!condition) throw new Error(message || 'invalid backup');
}

function requireKey(obj, key, message) {
    if (!obj || typeof obj !== 'object') return false;
    if (!(key in obj)) throw new Error(message || `缺少字段：${key}`);
    return true;
}

function parseJsonFromPossiblyEncodedStorage(key, fallback) {
    try {
        if (typeof key === 'string' && key.indexOf('chatHistory_') === 0) {
            const fid = String(key.slice('chatHistory_'.length));
            const mem = typeof __chatHistoryMem !== 'undefined' ? __chatHistoryMem : null;
            if (mem && mem.has(fid)) {
                const arr = mem.get(fid);
                return Array.isArray(arr) ? arr : fallback;
            }
        }
        let raw = localStorage.getItem(key);
        if (typeof raw !== 'string' || !raw) return fallback;
        if (raw.startsWith(LS_LZ_PREFIX)) {
            const dec = LZString.decompressFromUTF16(raw.slice(LS_LZ_PREFIX.length));
            raw = typeof dec === 'string' ? dec : '';
        } else if (raw.startsWith(LS_CHUNK_PREFIX) || raw.startsWith(LS_CHUNK_LZ_PREFIX)) {
            const full = readChunkedStoragePayload(key);
            raw = typeof full === 'string' ? full : '';
        } else if (raw.startsWith(LS_IDB_PREFIX)) {
            if (typeof key === 'string' && key.indexOf('chatHistory_') === 0) {
                const fid = String(key.slice('chatHistory_'.length));
                const idbCache =
                    typeof __chatHistoryIdbCache !== 'undefined' ? __chatHistoryIdbCache : null;
                if (idbCache && idbCache.has(fid)) {
                    const c = idbCache.get(fid);
                    return Array.isArray(c) ? c : fallback;
                }
                if (typeof preloadChatHistoryFromIdbIfNeeded === 'function') {
                    preloadChatHistoryFromIdbIfNeeded(fid);
                }
                return fallback;
            }
            if (key === MOMENTS_POSTS_LS_KEY) {
                try { Moments.store.preloadMomentsPostsFromIdbIfNeeded(); } catch (e) {}
                return Array.isArray(Moments.store.__momentsPostsCache) ? Moments.store.__momentsPostsCache : fallback;
            }
            if (key === EMOJI_DATA_LS_KEY) {
                const emojiMod = (typeof Wechat !== 'undefined' && Wechat.emoji) ? Wechat.emoji : null;
                if (emojiMod) {
                    try { emojiMod.preloadEmojiFromIdbIfNeeded(); } catch (e) {}
                    const cache = typeof emojiMod.getEmojiDataCache === 'function'
                        ? emojiMod.getEmojiDataCache()
                        : null;
                    return (cache && typeof cache === 'object') ? cache : fallback;
                }
                return fallback;
            }
            if (key === EMOJI_CATEGORIES_LS_KEY) {
                const emojiMod = (typeof Wechat !== 'undefined' && Wechat.emoji) ? Wechat.emoji : null;
                if (emojiMod) {
                    try { emojiMod.preloadEmojiFromIdbIfNeeded(); } catch (e) {}
                    const cache = typeof emojiMod.getEmojiCategoriesCache === 'function'
                        ? emojiMod.getEmojiCategoriesCache()
                        : null;
                    return cache != null ? cache : fallback;
                }
                return fallback;
            }
        }
        if (!raw) return fallback;
        if (key === WECHAT_GLOBAL_BG_LS_KEY || key === WECHAT_BUBBLE_CSS_LS_KEY || key === WECHAT_GLOBAL_FONT_LS_KEY) {
            return raw;
        }
        return JSON.parse(raw);
    } catch (e) {
        return fallback;
    }
}

// ========== localStorage 大对象压缩存储（解决 quota 超限） ==========
// 采用 LZ-String（UTF16）压缩，保持同步读写能力
const LZString = (function () {
    // LZ-String 1.4.x (MIT) - compressToUTF16 / decompressFromUTF16
    const f = String.fromCharCode;

    function _compress(uncompressed, bitsPerChar, getCharFromInt) {
        if (uncompressed == null) return "";
        let i, value;
        const context_dictionary = {};
        const context_dictionaryToCreate = {};
        let context_c = "";
        let context_wc = "";
        let context_w = "";
        let context_enlargeIn = 2;
        let context_dictSize = 3;
        let context_numBits = 2;
        const context_data = [];
        let context_data_val = 0;
        let context_data_position = 0;

        const writeBit = (bit) => {
            context_data_val = (context_data_val << 1) | bit;
            if (context_data_position === bitsPerChar - 1) {
                context_data_position = 0;
                context_data.push(getCharFromInt(context_data_val));
                context_data_val = 0;
            } else {
                context_data_position++;
            }
        };

        const writeBits = (numBits, v) => {
            for (let j = 0; j < numBits; j++) {
                writeBit(v & 1);
                v = v >> 1;
            }
        };

        for (i = 0; i < uncompressed.length; i += 1) {
            context_c = uncompressed.charAt(i);
            if (!Object.prototype.hasOwnProperty.call(context_dictionary, context_c)) {
                context_dictionary[context_c] = context_dictSize++;
                context_dictionaryToCreate[context_c] = true;
            }

            context_wc = context_w + context_c;
            if (Object.prototype.hasOwnProperty.call(context_dictionary, context_wc)) {
                context_w = context_wc;
            } else {
                if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                    if (context_w.charCodeAt(0) < 256) {
                        writeBits(context_numBits, 0);
                        writeBits(8, context_w.charCodeAt(0));
                    } else {
                        writeBits(context_numBits, 1);
                        writeBits(16, context_w.charCodeAt(0));
                    }
                    context_enlargeIn--;
                    if (context_enlargeIn === 0) {
                        context_enlargeIn = Math.pow(2, context_numBits);
                        context_numBits++;
                    }
                    delete context_dictionaryToCreate[context_w];
                } else {
                    value = context_dictionary[context_w];
                    writeBits(context_numBits, value);
                }

                context_enlargeIn--;
                if (context_enlargeIn === 0) {
                    context_enlargeIn = Math.pow(2, context_numBits);
                    context_numBits++;
                }
                context_dictionary[context_wc] = context_dictSize++;
                context_w = String(context_c);
            }
        }

        if (context_w !== "") {
            if (Object.prototype.hasOwnProperty.call(context_dictionaryToCreate, context_w)) {
                if (context_w.charCodeAt(0) < 256) {
                    writeBits(context_numBits, 0);
                    writeBits(8, context_w.charCodeAt(0));
                } else {
                    writeBits(context_numBits, 1);
                    writeBits(16, context_w.charCodeAt(0));
                }
                context_enlargeIn--;
                if (context_enlargeIn === 0) {
                    context_enlargeIn = Math.pow(2, context_numBits);
                    context_numBits++;
                }
                delete context_dictionaryToCreate[context_w];
            } else {
                value = context_dictionary[context_w];
                writeBits(context_numBits, value);
            }

            context_enlargeIn--;
            if (context_enlargeIn === 0) {
                context_enlargeIn = Math.pow(2, context_numBits);
                context_numBits++;
            }
        }

        // Mark the end of the stream
        writeBits(context_numBits, 2);

        // Flush the last char
        while (true) {
            context_data_val = (context_data_val << 1);
            if (context_data_position === bitsPerChar - 1) {
                context_data.push(getCharFromInt(context_data_val));
                break;
            } else {
                context_data_position++;
            }
        }

        return context_data.join('');
    }

    function _decompress(length, resetValue, getNextValue) {
        const dictionary = [];
        let next;
        let enlargeIn = 4;
        let dictSize = 4;
        let numBits = 3;
        let entry = "";
        const result = [];
        let i;
        let w;
        let bits, resb, maxpower, power;
        const data = { val: getNextValue(0), position: resetValue, index: 1 };

        const readBit = () => {
            resb = data.val & data.position;
            data.position >>= 1;
            if (data.position === 0) {
                data.position = resetValue;
                data.val = getNextValue(data.index++);
            }
            return resb > 0 ? 1 : 0;
        };

        const readBits = (n) => {
            bits = 0;
            maxpower = Math.pow(2, n);
            power = 1;
            while (power !== maxpower) {
                bits |= readBit() * power;
                power <<= 1;
            }
            return bits;
        };

        for (i = 0; i < 3; i += 1) dictionary[i] = i;

        next = readBits(2);
        switch (next) {
            case 0:
                w = f(readBits(8));
                break;
            case 1:
                w = f(readBits(16));
                break;
            case 2:
                return "";
        }

        dictionary[3] = w;
        result.push(w);

        while (true) {
            if (data.index > length) return "";

            next = readBits(numBits);
            switch (next) {
                case 0:
                    dictionary[dictSize++] = f(readBits(8));
                    next = dictSize - 1;
                    enlargeIn--;
                    break;
                case 1:
                    dictionary[dictSize++] = f(readBits(16));
                    next = dictSize - 1;
                    enlargeIn--;
                    break;
                case 2:
                    return result.join('');
            }

            if (enlargeIn === 0) {
                enlargeIn = Math.pow(2, numBits);
                numBits++;
            }

            if (dictionary[next]) {
                entry = dictionary[next];
            } else {
                if (next === dictSize) entry = w + w.charAt(0);
                else return null;
            }
            result.push(entry);

            // Add w+entry[0] to the dictionary.
            dictionary[dictSize++] = w + entry.charAt(0);
            enlargeIn--;
            w = entry;

            if (enlargeIn === 0) {
                enlargeIn = Math.pow(2, numBits);
                numBits++;
            }
        }
    }

    function compressToUTF16(input) {
        if (input == null) return "";
        return _compress(input, 15, function (a) { return f(a + 32); }) + " ";
    }

    function decompressFromUTF16(compressed) {
        if (compressed == null) return "";
        if (compressed === "") return null;
        return _decompress(compressed.length, 16384, function (index) {
            return compressed.charCodeAt(index) - 32;
        });
    }

    return { compressToUTF16, decompressFromUTF16 };
})();

// 好友 / 聊天记录 / KV：见 wechat-store.js

function saveJsonToStorageWithCompression(key, value, _prunePass) {
    let json;
    try {
        json = JSON.stringify(value);
    } catch (e) {
        console.warn('[saveJsonToStorageWithCompression] JSON.stringify 失败，使用占位数据:', key, e);
        json = JSON.stringify({ _serializationError: true, key: String(key) });
    }
    try {
        localStorage.setItem(key, json);
        return;
    } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        const compressed = LS_LZ_PREFIX + LZString.compressToUTF16(json);
        try {
            localStorage.setItem(key, compressed);
        } catch (err2) {
            if (!isQuotaExceededError(err2)) throw err2;
            // 优先：压缩后分片（比明文分片小很多，缓解总配额）
            try {
                storeChunkedCompressedJsonToLocalStorage(key, json);
            } catch (errLzChunk) {
                if (!isQuotaExceededError(errLzChunk)) throw errLzChunk;
                // 兜底：明文分片（兼容极短 JSON 或压缩异常）
                try {
                    storeChunkedStringToLocalStorage(key, json);
                } catch (err3) {
                    if (!isQuotaExceededError(err3)) throw err3;
                    if (
                        !_prunePass &&
                        typeof key === 'string' &&
                        key.indexOf('chatHistory_') === 0 &&
                        Array.isArray(value) &&
                        value.length > 1200
                    ) {
                        const fid = key.slice('chatHistory_'.length);
                        const pruned = value.slice(-1200);
                        try {
                            if (typeof __chatHistoryMem !== 'undefined' && __chatHistoryMem) {
                                __chatHistoryMem.set(String(fid), pruned);
                            }
                            if (typeof __chatHistoryIdbCache !== 'undefined' && __chatHistoryIdbCache) {
                                __chatHistoryIdbCache.set(String(fid), pruned);
                            }
                        } catch (ePrune) {}
                        saveJsonToStorageWithCompression(key, pruned, true);
                        try {
                            showNotification('聊天记录过长，已自动保留最近 1200 条以释放存储空间');
                        } catch (eN) {}
                        return;
                    }
                    if (key === MOMENTS_POSTS_LS_KEY) {
                        throw new Error('__NEED_IDB_MOMENTS__');
                    }
                    if (
                        typeof key === 'string' &&
                        key.indexOf('chatHistory_') === 0 &&
                        typeof wechatKvSet === 'function'
                    ) {
                        try {
                            clearChunkedStorage(key);
                            try {
                                localStorage.removeItem(key);
                            } catch (eRm) {}
                            const fid = key.slice('chatHistory_'.length);
                            let arrSync = value;
                            try {
                                arrSync = JSON.parse(json);
                            } catch (eJ) {
                                arrSync = [];
                            }
                            if (!Array.isArray(arrSync)) arrSync = [];
                            try {
                                if (typeof __chatHistoryMem !== 'undefined' && __chatHistoryMem) {
                                    __chatHistoryMem.set(String(fid), arrSync);
                                }
                                if (typeof __chatHistoryIdbCache !== 'undefined' && __chatHistoryIdbCache) {
                                    __chatHistoryIdbCache.set(String(fid), arrSync);
                                }
                            } catch (eMem) {}
                            wechatKvSet(key, json)
                                .then(function () {
                                    try {
                                        localStorage.setItem(key, LS_IDB_PREFIX + '1');
                                    } catch (eMark) {
                                        console.warn('[chatHistory IDB] localStorage 标记写入失败:', eMark);
                                    }
                                })
                                .catch(function (eIdb) {
                                    console.warn('[chatHistory IDB] IndexedDB 写入失败:', eIdb);
                                });
                            return;
                        } catch (eFallback) {
                            if (!isQuotaExceededError(eFallback)) {
                                console.warn('[chatHistory IDB] 回退异常:', eFallback);
                            }
                        }
                    }
                    throw err3;
                }
            }
        }
    }
}

// 聊天记录落盘 / saveFriendsToStorageDebounced / beforeunload：见 wechat-store.js

function clearChunkedStorage(key) {
    try {
        const marker = localStorage.getItem(key);
        if (typeof marker !== 'string') return;
        let n = NaN;
        if (marker.startsWith(LS_CHUNK_PREFIX)) {
            n = parseInt(marker.slice(LS_CHUNK_PREFIX.length), 10);
        } else if (marker.startsWith(LS_CHUNK_LZ_PREFIX)) {
            n = parseInt(marker.slice(LS_CHUNK_LZ_PREFIX.length), 10);
        }
        if (Number.isFinite(n) && n > 0 && n < 5000) {
            for (let i = 0; i < n; i++) localStorage.removeItem(key + LS_CHUNK_SEP + i);
        }
    } catch (e) {}
    try { localStorage.removeItem(key); } catch (e) {}
}

/** 读取 CHUNKED: 明文分片 或 CHUNKEDLZ: 压缩分片，返回 JSON 源字符串 */
function readChunkedStoragePayload(key) {
    const marker = localStorage.getItem(key);
    if (typeof marker !== 'string') return null;
    if (marker.startsWith(LS_CHUNK_LZ_PREFIX)) {
        const n = parseInt(marker.slice(LS_CHUNK_LZ_PREFIX.length), 10);
        if (!Number.isFinite(n) || n <= 0 || n > 5000) return null;
        let joined = '';
        for (let i = 0; i < n; i++) {
            const part = localStorage.getItem(key + LS_CHUNK_SEP + i);
            if (typeof part !== 'string') return null;
            joined += part;
        }
        const dec = LZString.decompressFromUTF16(joined);
        return typeof dec === 'string' ? dec : null;
    }
    if (marker.startsWith(LS_CHUNK_PREFIX)) {
        return readChunkedStringFromLocalStorage(key);
    }
    return null;
}

/**
 * 安全读取 localStorage JSON：自动兼容普通存储 / LZ压缩存储 / 分片存储
 * 读取失败返回 null，不会抛出异常
 */
function safeReadJsonFromStorage(key, fallback) {
    try {
        const raw = localStorage.getItem(key);
        if (raw == null) return fallback !== undefined ? fallback : null;

        // 1. 分片存储（明文 CHUNKED:N 或 LZ压缩 CHUNKEDLZ:N）
        if (raw.startsWith(LS_CHUNK_LZ_PREFIX) || raw.startsWith(LS_CHUNK_PREFIX)) {
            const jsonStr = readChunkedStoragePayload(key);
            if (jsonStr != null) {
                try { return JSON.parse(jsonStr); } catch (_) {}
            }
            return fallback !== undefined ? fallback : null;
        }

        // 2. LZ 压缩单条（CHUNKEDLZ 已在上面处理，正常走到这里）
        if (raw.startsWith(LS_LZ_PREFIX)) {
            try {
                const dec = LZString.decompressFromUTF16(raw.slice(LS_LZ_PREFIX.length));
                return JSON.parse(dec);
            } catch (_) {
                return fallback !== undefined ? fallback : null;
            }
        }

        // 3. 普通 JSON
        return JSON.parse(raw);
    } catch (e) {
        return fallback !== undefined ? fallback : null;
    }
}

function storeChunkedStringToLocalStorage(key, rawString) {
    const s = String(rawString || '');
    clearChunkedStorage(key);
    // 每片大小保守一点，避免某些浏览器对单项 value 有更小限制
    const CHUNK_SIZE = 380000;
    const parts = [];
    for (let i = 0; i < s.length; i += CHUNK_SIZE) {
        parts.push(s.slice(i, i + CHUNK_SIZE));
    }
    // 先写 marker，再写各片；任意一步超限都清理残留，避免半残分片破坏读取
    localStorage.setItem(key, LS_CHUNK_PREFIX + String(parts.length));
    try {
        for (let i = 0; i < parts.length; i++) {
            localStorage.setItem(key + LS_CHUNK_SEP + i, parts[i]);
        }
    } catch (errWrite) {
        clearChunkedStorage(key);
        throw errWrite;
    }
}

/** 先 LZ 压缩再分片，显著降低占用（长记忆等大 JSON 优先走此路径） */
function storeChunkedCompressedJsonToLocalStorage(key, rawString) {
    const compressed = LZString.compressToUTF16(String(rawString || '')) || '';
    clearChunkedStorage(key);
    const CHUNK_SIZE = 180000;
    const parts = [];
    for (let i = 0; i < compressed.length; i += CHUNK_SIZE) {
        parts.push(compressed.slice(i, i + CHUNK_SIZE));
    }
    if (parts.length === 0) parts.push('');
    localStorage.setItem(key, LS_CHUNK_LZ_PREFIX + String(parts.length));
    try {
        for (let i = 0; i < parts.length; i++) {
            localStorage.setItem(key + LS_CHUNK_SEP + i, parts[i]);
        }
    } catch (errWrite) {
        clearChunkedStorage(key);
        throw errWrite;
    }
}

function readChunkedStringFromLocalStorage(key) {
    const marker = localStorage.getItem(key);
    if (typeof marker !== 'string' || !marker.startsWith(LS_CHUNK_PREFIX)) return null;
    const n = parseInt(marker.slice(LS_CHUNK_PREFIX.length), 10);
    if (!Number.isFinite(n) || n <= 0 || n > 5000) return null;
    let out = '';
    for (let i = 0; i < n; i++) {
        const part = localStorage.getItem(key + LS_CHUNK_SEP + i);
        if (typeof part !== 'string') return null; // chunk 缺失 → 视为半残，返回 null
        out += part;
    }
    return out;
}

// 兼容旧代码：部分路径曾直接 JSON.parse(localStorage.getItem('friends'))，在压缩存储时会报错。
// 业务代码应统一使用 loadFriendsFromStorage()/saveFriendsToStorage()；此处仍对 localStorage 做补丁：
// 当 friends 被压缩存储时，getItem 返回解压后的 JSON 字符串；
// 当 setItem('friends', <json>) 触发 quota 时自动转为压缩存储。
(function patchLocalStorageForFriendsCompression() {
    try {
        if (typeof localStorage === 'undefined') return;
        if (localStorage.__legoFriendsPatched) return;
        localStorage.__legoFriendsPatched = true;

        const origGet = localStorage.getItem.bind(localStorage);
        const origSet = localStorage.setItem.bind(localStorage);

        const COMPRESS_KEYS = new Set([
            FRIENDS_LS_KEY,
            MOMENTS_POSTS_LS_KEY,
            WECHAT_FAVORITES_LS_KEY,
            EMOJI_DATA_LS_KEY,
            EMOJI_CATEGORIES_LS_KEY,
            WECHAT_DATA_LS_KEY,
            USER_INFO_LS_KEY,
            MY_PROFILE_LS_KEY,
            WECHAT_GLOBAL_BG_LS_KEY,
            WECHAT_BUBBLE_CSS_LS_KEY,
            WECHAT_GLOBAL_FONT_LS_KEY,
            MUSIC_PLAYER_COVER_LS_KEY,
            MOMENTS_COVER_LS_KEY
        ]);

        localStorage.getItem = function (key) {
            const v = origGet(key);
            if (COMPRESS_KEYS.has(key) && typeof v === 'string' && v.startsWith(LS_LZ_PREFIX)) {
                const dec = LZString.decompressFromUTF16(v.slice(LS_LZ_PREFIX.length));
                return typeof dec === 'string' ? dec : null;
            }
            if (COMPRESS_KEYS.has(key) && typeof v === 'string' && v.startsWith(LS_CHUNK_PREFIX)) {
                const full = readChunkedStringFromLocalStorage(key);
                return typeof full === 'string' ? full : null;
            }
            if (key === MOMENTS_POSTS_LS_KEY && typeof v === 'string' && v.startsWith(LS_IDB_PREFIX)) {
                // 同步读取只能返回缓存；缓存由 preloadMomentsPostsFromIdbIfNeeded 异步填充
                return JSON.stringify(Array.isArray(Moments.store.__momentsPostsCache) ? Moments.store.__momentsPostsCache : []);
            }
            return v;
        };

        localStorage.setItem = function (key, value) {
            if (COMPRESS_KEYS.has(key) && typeof value === 'string' && value && !value.startsWith(LS_LZ_PREFIX)) {
                try {
                    return origSet(key, value);
                } catch (err) {
                    if (!isQuotaExceededError(err)) throw err;
                    // 1) LZ 文本压缩；超长 Data URL 上 compressToUTF16 可能抛错，须继续尝试分片
                    try {
                        const compressed = LS_LZ_PREFIX + LZString.compressToUTF16(value);
                        return origSet(key, compressed);
                    } catch (err2) {
                        try {
                            storeChunkedStringToLocalStorage(key, value);
                            return;
                        } catch (err3) {
                            throw err3;
                        }
                    }
                }
            }
            return origSet(key, value);
        };
    } catch (e) {
        // ignore
    }
})();

function isQuotaExceededError(err) {
    const msg = String(err && (err.message || err) || '');
    return (
        err?.name === 'QuotaExceededError' ||
        err?.code === 22 ||
        msg.includes('exceeded the quota') ||
        msg.includes('QuotaExceededError') ||
        msg.includes('quota')
    );
}

async function compressDataUrlImage(dataUrl, opts) {
    const o = opts && typeof opts === 'object' ? opts : {};
    const maxDim = Number.isFinite(o.maxDim) ? o.maxDim : 1280;
    const quality = Number.isFinite(o.quality) ? o.quality : 0.82;
    const mime = typeof o.mime === 'string' ? o.mime : 'image/jpeg';

    if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/')) return dataUrl;
    return await new Promise((resolve) => {
        const img = new Image();
        img.onload = () => {
            try {
                const w = img.naturalWidth || img.width || 0;
                const h = img.naturalHeight || img.height || 0;
                if (!w || !h) return resolve(dataUrl);
                const scale = Math.min(1, maxDim / Math.max(w, h));
                const cw = Math.max(1, Math.round(w * scale));
                const ch = Math.max(1, Math.round(h * scale));
                const canvas = document.createElement('canvas');
                canvas.width = cw;
                canvas.height = ch;
                const ctx = canvas.getContext('2d');
                if (!ctx) return resolve(dataUrl);
                ctx.drawImage(img, 0, 0, cw, ch);
                const out = canvas.toDataURL(mime, quality);
                resolve(typeof out === 'string' && out.startsWith('data:image/') ? out : dataUrl);
            } catch (e) {
                resolve(dataUrl);
            }
        };
        img.onerror = () => resolve(dataUrl);
        img.src = dataUrl;
    });
}

async function compressThemeSettingsForStorage(themeObj) {
    const t = themeObj && typeof themeObj === 'object' ? { ...themeObj } : {};
    if (typeof t.homeScreenBg === 'string' && t.homeScreenBg.startsWith('data:image/')) {
        t.homeScreenBg = await compressDataUrlImage(t.homeScreenBg, { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' });
    }
    if (typeof t.globalAppBg === 'string' && t.globalAppBg.startsWith('data:image/')) {
        t.globalAppBg = await compressDataUrlImage(t.globalAppBg, { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' });
    }
    if (t.functionIcons && typeof t.functionIcons === 'object') {
        const icons = { ...t.functionIcons };
        for (const k of Object.keys(icons)) {
            const v = icons[k];
            if (typeof v === 'string' && v.startsWith('data:image/')) {
                icons[k] = await compressDataUrlImage(v, { maxDim: 512, quality: 0.8, mime: 'image/jpeg' });
            }
        }
        t.functionIcons = icons;
    }
    return t;
}

async function setThemeSettingsWithQuotaFallback(themePayload) {
    try {
        localStorage.setItem(THEME_LS_KEY, JSON.stringify(themePayload));
        return themePayload;
    } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        const compressed = await compressThemeSettingsForStorage(themePayload);
        try {
            localStorage.setItem(THEME_LS_KEY, JSON.stringify(compressed));
            return compressed;
        } catch (err2) {
            throw new Error('主题图片过大，超过浏览器存储上限。请在主题里换更小的图片后再备份/导入。');
        }
    }
}

async function setLocalStorageStringWithQuotaFallback(key, value, compressOpts) {
    const val = value != null ? String(value) : '';
    const safeSetEmpty = () => {
        try {
            try {
                localStorage.removeItem(key);
            } catch (_) {}
            localStorage.setItem(key, '');
        } catch (_) {}
    };
    if (!val) {
        safeSetEmpty();
        return '';
    }
    try {
        localStorage.setItem(key, val);
        return val;
    } catch (err) {
        if (!isQuotaExceededError(err)) throw err;
        if (typeof val === 'string' && val.startsWith('data:image/')) {
            const base = compressOpts || { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' };
            const tries = [
                base,
                { ...base, maxDim: Math.min(base.maxDim || 1440, 1024), quality: Math.min(base.quality || 0.82, 0.78) },
                { ...base, maxDim: Math.min(base.maxDim || 1440, 768), quality: Math.min(base.quality || 0.82, 0.72) },
                { ...base, maxDim: Math.min(base.maxDim || 1440, 512), quality: Math.min(base.quality || 0.82, 0.66) },
                { maxDim: 384, quality: 0.6, mime: 'image/jpeg' },
                { maxDim: 256, quality: 0.55, mime: 'image/jpeg' }
            ];
            for (const t of tries) {
                let compressed;
                try {
                    compressed = await compressDataUrlImage(val, t);
                } catch (_) {
                    continue;
                }
                try {
                    localStorage.setItem(key, compressed);
                    return compressed;
                } catch (e2) {
                    if (!isQuotaExceededError(e2)) throw e2;
                }
            }
            safeSetEmpty();
            return '';
        }
        safeSetEmpty();
        return '';
    }
}

function normalizeLegacyBackupShape(raw) {
    if (!raw || typeof raw !== 'object') return raw;
    // 兼容旧版：把顶层 data.api / data.voice 等映射到新版 settings/api 结构
    if (raw.data && raw.data.api && !raw.data.settings) {
        raw.data.settings = { api: raw.data.api };
    }
    // 旧版：emoji / userProfile 独立在顶层 data 下；新版将其并入 wechat
    if (raw.data && raw.data.wechat && raw.data.emoji && !raw.data.wechat.emoji) {
        raw.data.wechat.emoji = raw.data.emoji;
    }
    if (raw.data && raw.data.wechat && raw.data.userProfile && !raw.data.wechat.myProfile) {
        raw.data.wechat.myProfile = raw.data.userProfile;
    }
    return raw;
}

/** 将 localStorage/API 导出中的 model 规整为单行模型 id 字符串（兼容对象备份与别名字段） */
function coerceApiModelToString(raw) {
    if (raw == null || raw === '') return '';
    if (typeof raw === 'string') return raw.trim();
    if (typeof raw === 'object') {
        const id = raw.id != null ? String(raw.id).trim() : '';
        const name = raw.name != null ? String(raw.name).trim() : '';
        const oid = raw.modelId != null ? String(raw.modelId).trim()
            : raw.model_id != null ? String(raw.model_id).trim()
            : raw.value != null ? String(raw.value).trim() : '';
        const pick = id || oid || name;
        if (pick) return pick;
    }
    const s = String(raw).trim();
    return s === '[object Object]' ? '' : s;
}

/** 导入备份时统一 API 块中的模型字段名，避免因旧导出/字段不一致导致写入后 model 为空 */
function normalizeImportedApiSettingsShape(apiIn) {
    const api = apiIn && typeof apiIn === 'object' ? { ...apiIn } : {};
    let cur = coerceApiModelToString(api.model);
    if (!cur) {
        const alt = [api.modelName, api.selectedModel, api.model_id, api.chatModel].find(
            (x) => x != null && String(x).trim() !== ''
        );
        if (alt != null) cur = coerceApiModelToString(alt);
    }
    api.model = cur;
    return api;
}

const API_SETTINGS_LS_KEY = 'apiSettings';
let __apiSettingsFormDirty = false;

function markApiSettingsFormDirty() {
    __apiSettingsFormDirty = true;
}

function clearApiSettingsFormDirty() {
    __apiSettingsFormDirty = false;
}

/** 规整 apiSettings 记录，剥离误写入的 apiPresets 等字段，避免导入/保存后配置被旧预设锁死 */
function sanitizeApiSettingsRecord(raw) {
    const src = raw && typeof raw === 'object' ? raw : {};
    const model = coerceApiModelToString(src.model);
    const memoryRaw = src.memoryCount;
    const maxTokensRaw = src.maxOutputTokens;
    const waitRaw = src.waitTimeoutMinutes;
    return {
        apiUrl: src.apiUrl != null ? String(src.apiUrl).trim() : '',
        apiKey: normalizeApiKeyForBearer(src.apiKey),
        model,
        memoryCount: memoryRaw != null && memoryRaw !== '' ? memoryRaw : '50',
        streamOutput: src.streamOutput !== undefined ? !!src.streamOutput : false,
        maxOutputTokens: maxTokensRaw != null && maxTokensRaw !== '' ? String(maxTokensRaw) : '45000',
        waitTimeoutMinutes: waitRaw != null && waitRaw !== '' ? String(waitRaw) : '3',
        timeAwareness: src.timeAwareness !== undefined ? !!src.timeAwareness : false,
        connectionStatus: src.connectionStatus != null ? String(src.connectionStatus) : 'disconnected'
    };
}

function readApiSettingsFromStorage() {
    try {
        let parsed = JSON.parse(localStorage.getItem(API_SETTINGS_LS_KEY) || '{}');
        if (!parsed || typeof parsed !== 'object') parsed = {};
        return sanitizeApiSettingsRecord(parsed);
    } catch (e) {
        return sanitizeApiSettingsRecord({});
    }
}

function writeApiSettingsToStorage(updates) {
    const merged = sanitizeApiSettingsRecord({
        ...readApiSettingsFromStorage(),
        ...(updates && typeof updates === 'object' ? updates : {})
    });
    localStorage.setItem(API_SETTINGS_LS_KEY, JSON.stringify(merged));
    return merged;
}

function syncApiSettingsFormFromRecord(settings, options) {
    options = options || {};
    const urlEl = document.getElementById('api-url');
    const keyEl = document.getElementById('api-key');
    const modelEl = document.getElementById('model-name');
    const memoryEl = document.getElementById('memory-count');
    const streamEl = document.getElementById('stream-output-toggle');
    const maxTokensEl = document.getElementById('max-output-tokens');
    const waitTimeoutEl = document.getElementById('wait-timeout-minutes');
    const timeAwareEl = document.getElementById('time-awareness-toggle');

    if (urlEl) urlEl.value = settings.apiUrl || '';
    if (keyEl) keyEl.value = settings.apiKey || '';
    if (modelEl) modelEl.value = settings.model || '';
    if (memoryEl && settings.memoryCount != null && settings.memoryCount !== '') {
        memoryEl.value = settings.memoryCount;
    }
    if (streamEl) streamEl.checked = !!settings.streamOutput;
    if (maxTokensEl && settings.maxOutputTokens != null && settings.maxOutputTokens !== '') {
        maxTokensEl.value = settings.maxOutputTokens;
    }
    if (waitTimeoutEl && settings.waitTimeoutMinutes != null && settings.waitTimeoutMinutes !== '') {
        waitTimeoutEl.value = settings.waitTimeoutMinutes;
    }
    if (timeAwareEl) timeAwareEl.checked = !!settings.timeAwareness;

    if (options.syncFloating !== false) {
        try { syncFloatingApiSettingsFromStorage({ syncForm: true }); } catch (e) {}
    }
    try { checkApiInputs(); } catch (e) {}
}

function refreshApiConnectionStatusFromStorage() {
    const settings = readApiSettingsFromStorage();
    const hasCred = !!(settings.apiUrl && settings.apiKey);
    const hasModelPick = !!(settings.model && settings.model.trim());
    if (!hasCred) {
        updateConnectionStatus('disconnected', '未连接');
        return;
    }
    if (!hasModelPick) {
        updateConnectionStatus('disconnected', '请先填写或拉取模型');
        return;
    }
    if (settings.connectionStatus === 'connected') {
        updateConnectionStatus('connected', 'API连接已激活');
    } else if (settings.connectionStatus === 'connecting') {
        updateConnectionStatus('connecting', '正在激活API连接...');
    } else {
        updateConnectionStatus('disconnected', '未连接');
    }
}

function initApiSettingsFormDirtyTracking() {
    const ids = ['api-url', 'api-key', 'model-name', 'memory-count', 'stream-output-toggle', 'max-output-tokens', 'wait-timeout-minutes', 'time-awareness-toggle'];
    ids.forEach(function (id) {
        const el = document.getElementById(id);
        if (!el || el.dataset.apiDirtyBound === '1') return;
        el.dataset.apiDirtyBound = '1';
        el.addEventListener('input', markApiSettingsFormDirty);
        el.addEventListener('change', markApiSettingsFormDirty);
    });
    const timeAwareEl = document.getElementById('time-awareness-toggle');
    if (timeAwareEl && timeAwareEl.dataset.apiDirtyBound !== '1') {
        timeAwareEl.dataset.apiDirtyBound = '1';
        timeAwareEl.addEventListener('change', markApiSettingsFormDirty);
    }
}

/** 启动时清理历史脏数据（如 apiPresets 误写入 apiSettings、model 为对象等） */
function migrateApiSettingsStorageIfNeeded() {
    try {
        const raw = localStorage.getItem(API_SETTINGS_LS_KEY);
        if (!raw) return;
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object') return;
        const sanitized = sanitizeApiSettingsRecord(parsed);
        if (
            'apiPresets' in parsed ||
            (parsed.model != null && typeof parsed.model === 'object') ||
            String(parsed.apiKey || '') !== sanitized.apiKey
        ) {
            writeApiSettingsToStorage(sanitized);
        }
    } catch (e) {}
}

async function strictImportAllData(backupDataRaw) {
    const backupData = normalizeLegacyBackupShape(backupDataRaw);
    assertBackup(backupData && typeof backupData === 'object', '备份为空');
    assertBackup(backupData.data && typeof backupData.data === 'object', '无效的备份数据结构');

    const d = backupData.data;

    // Validate optional desktop widgets before any existing host/module data changes.
    if (d.desktop != null && !window.LegoDesktop) throw new Error('桌面模块尚未载入，未导入备份');
    const desktopBackup = window.LegoDesktop ? await window.LegoDesktop.validateBackup(d.desktop) : null;

    // Fail before clearing host data if the independent tarot payload cannot be restored.
    if (d.wechat && d.wechat.milianTarot != null) {
        if (!window.LegoMilianTarot) throw new Error('迷恋塔罗模块尚未载入，未导入备份');
        await window.LegoMilianTarot.importBackup(d.wechat.milianTarot);
    }

    if (window.LegoDesktop) {
        // A legacy backup has no widget payload: preserve the current note drafts.
        if (desktopBackup === null) window.LegoDesktop.collectBackup();
        window.LegoDesktop.discardPending();
    }

    const resumeProactiveAfterImport = window.Wechat && Wechat.proactive ? Wechat.proactive.suspend() : function () {};
    try {

    try {
        if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.discardWechatPendingPersistence === 'function') {
            Wechat.store.discardWechatPendingPersistence();
        } else {
            clearChatHistoryMemCache();
        }
    } catch (e) {}

    // 导入前：清理可能占用大量空间的旧 key（含分片），腾出 localStorage 配额
    try {
        [
            THEME_LS_KEY,
            'backgroundImage',
            'userAvatar',
            'mainCardText',
            'worldBookData',
            MUSIC_PLAYER_COVER_LS_KEY,
            FRIENDS_LS_KEY,
            MOMENTS_POSTS_LS_KEY,
            WECHAT_FAVORITES_LS_KEY,
            EMOJI_DATA_LS_KEY,
            EMOJI_CATEGORIES_LS_KEY,
            WECHAT_DATA_LS_KEY,
            USER_INFO_LS_KEY,
            MY_PROFILE_LS_KEY,
            WECHAT_LS_GLOBAL_BG,
            WECHAT_LS_BUBBLE_CSS,
            WECHAT_LS_GLOBAL_FONT,
            'wechatCoupleSpaceStateV1'
        ].forEach((k) => {
            try { clearChunkedStorage(k); } catch (e) {}
        });
        try {
            if (typeof Wechat !== 'undefined' && Wechat.store && Wechat.store.coupleSpace && typeof Wechat.store.coupleSpace.invalidateMemCache === 'function') {
                Wechat.store.coupleSpace.invalidateMemCache();
            }
        } catch (e) {}
        // 清理 IndexedDB 中的相关数据（腾出 IndexedDB 配额）
        try {
            await clearIndexedDBKeys([
                FRIENDS_LS_KEY,
                MOMENTS_POSTS_LS_KEY,
                EMOJI_DATA_LS_KEY,
                EMOJI_CATEGORIES_LS_KEY,
                WECHAT_FAVORITES_LS_KEY,
                USER_INFO_LS_KEY,
                MY_PROFILE_LS_KEY,
                WECHAT_DATA_LS_KEY,
                'worldBookData'
            ]);
        } catch (e) {}
    } catch (e) {}

    // 必需模块：主卡片 / 音乐 / 世界书 / 主题 / 设置(API) / 微信（含朋友圈与我的资料）
    assertBackup(d.mainCard && typeof d.mainCard === 'object', '缺少 mainCard');
    assertBackup(d.music && typeof d.music === 'object', '缺少 music');
    assertBackup(d.worldBook != null, '缺少 worldBook');
    assertBackup(d.theme && typeof d.theme === 'object', '缺少 theme');
    assertBackup(d.settings && typeof d.settings === 'object' && d.settings.api && typeof d.settings.api === 'object', '缺少 settings.api');
    assertBackup(d.wechat && typeof d.wechat === 'object', '缺少 wechat');

    updateImportProgress('导入基础设置...');
    await new Promise(r => setTimeout(r, 0));

    // 主题：补充 mainCardBg（若有）
    const themePayload = { ...d.theme };
    if (themePayload.mainCardBg == null && d.mainCard && typeof d.mainCard.backgroundImage === 'string') {
        themePayload.mainCardBg = d.mainCard.backgroundImage;
    }

    // 1) 设置（API）——写入前规整字段，避免 apiPresets 嵌套进 apiSettings 导致后续保存/加载异常
    {
        const api = normalizeImportedApiSettingsShape(d.settings.api);
        const { apiPresets, ...settings } = api;
        try {
            writeApiSettingsToStorage(settings);
            clearApiSettingsFormDirty();
        } catch (e) { console.warn('导入API设置失败（存储配额不足）'); }
        if (apiPresets != null) { try { localStorage.setItem('apiPresets', JSON.stringify(apiPresets)); } catch (e) { console.warn('导入API预设失败（存储配额不足）'); } }
    }

    // 2) 世界书
    updateImportProgress('导入世界书...');
    await new Promise(r => setTimeout(r, 0));
    try {
        if (typeof saveJsonToStorageWithCompression === 'function') {
            saveJsonToStorageWithCompression('worldBookData', d.worldBook);
        } else {
            localStorage.setItem('worldBookData', JSON.stringify(d.worldBook));
        }
    } catch (e) {
        console.warn('导入世界书数据失败（存储配额不足）:', e);
    }

    // 3) 主题
    updateImportProgress('导入主题...');
    await new Promise(r => setTimeout(r, 0));
    try { await setThemeSettingsWithQuotaFallback(themePayload); } catch (e) { console.warn('导入主题数据失败（存储配额不足）:', e && (e.message || e)); }

    // 4) 主卡片（头像/背景/签名等文本）
    updateImportProgress('导入主卡片...');
    await new Promise(r => setTimeout(r, 0));
    {
        const mc = d.mainCard;
        requireKey(mc, 'userAvatar', 'mainCard 缺少 userAvatar');
        requireKey(mc, 'backgroundImage', 'mainCard 缺少 backgroundImage');
        await setLocalStorageStringWithQuotaFallback('userAvatar', mc.userAvatar != null ? String(mc.userAvatar) : '', { maxDim: 1024, quality: 0.82, mime: 'image/jpeg' });
        await setLocalStorageStringWithQuotaFallback('backgroundImage', mc.backgroundImage != null ? String(mc.backgroundImage) : '', { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' });
        if (mc.text != null && typeof mc.text === 'object') {
            try {
                if (typeof saveJsonToStorageWithCompression === 'function') {
                    saveJsonToStorageWithCompression('mainCardText', mc.text);
                } else {
                    localStorage.setItem('mainCardText', JSON.stringify(mc.text));
                }
            } catch (e) {
                console.warn('导入主卡片文本失败（存储配额不足）:', e);
            }
        }
    }

    // Optional desktop widgets; older backups leave the current widgets intact.
    if (desktopBackup !== null) await window.LegoDesktop.restoreBackup(desktopBackup);

    // 5) 微信（好友/角色卡/聊天/表情/朋友圈/我的）
    updateImportProgress('导入微信数据...');
    await new Promise(r => setTimeout(r, 0));
    {
        const w = d.wechat;
        if (typeof Wechat !== 'undefined' && Wechat.backup && typeof Wechat.backup.importWechatData === 'function') {
            await Wechat.backup.importWechatData(w);
        }
        try {
            if (typeof refreshCoupleSpaceDiscoverCard === 'function') refreshCoupleSpaceDiscoverCard();
        } catch (e) {}
    }

    // 6) 音乐播放器（播放列表 + 封面）
    updateImportProgress('导入音乐播放列表...');
    await new Promise(r => setTimeout(r, 0));
    {
        const mus = d.music;
        requireKey(mus, 'playlist', 'music 缺少 playlist');
        requireKey(mus, 'cover', 'music 缺少 cover');
        const rawList = Array.isArray(mus.playlist) ? mus.playlist : null;
        assertBackup(rawList != null, 'music.playlist 无效（应为数组）');

        const tracks = [];
        for (let i = 0; i < rawList.length; i++) {
            const t = rawList[i] || {};
            const track = {
                id: t.id || ('imp_' + Date.now() + '_' + i),
                title: t.title || '未知',
                artist: t.artist || '未知',
                album: t.album || '',
                lyrics: t.lyrics || '',
                cover: t.cover || null,
                remoteId: t.remoteId || '',
                remoteSource: t.remoteSource || '',
                cachedAt: Number(t.cachedAt) || 0,
                localFileKey: t.localFileKey || '',
                byteSize: Number(t.byteSize) || 0
            };
            if (t.audioBase64) {
                track.blob = base64ToBlob(t.audioBase64);
                track.src = URL.createObjectURL(track.blob);
            } else {
                track.fileMissing = true;
                track.src = null;
            }
            tracks.push(track);
            if ((i + 1) % 20 === 0) {
                updateImportProgress(`导入音乐 ${i + 1}/${rawList.length}...`);
                await new Promise(r => setTimeout(r, 0));
            }
        }

        MusicPlayer.playlist = tracks;

        // 写入 IndexedDB（用于下次打开仍能播放）
        updateImportProgress('保存音乐数据库...');
        await new Promise(r => setTimeout(r, 0));
        const db = await openMusicDB();
        await new Promise((res, rej) => {
            const tx = db.transaction(MUSIC_STORE_NAME, 'readwrite');
            const store = tx.objectStore(MUSIC_STORE_NAME);
            const toStore = tracks.map(buildPersistedMusicTrack);
            store.put({ tracks: toStore }, MUSIC_PLAYLIST_KEY);
            tx.oncomplete = () => { db.close(); res(); };
            tx.onerror = () => { db.close(); rej(new Error('写入音乐数据库失败')); };
        });

        try {
            localStorage.setItem('musicPlaylistMeta', JSON.stringify(tracks.map(tr => ({
                id: tr.id,
                title: tr.title,
                artist: tr.artist,
                album: tr.album || '',
                remoteId: tr.remoteId || '',
                remoteSource: tr.remoteSource || '',
                localFileKey: tr.localFileKey || '',
                byteSize: Number(tr.byteSize) || 0
            }))));
        } catch (e) { console.warn('导入播放列表元数据失败（存储配额不足）'); }
        let coverStr = String(mus.cover || '');
        if (coverStr && coverStr.startsWith('data:image/')) {
            try {
                coverStr = await compressDataUrlImage(coverStr, { maxDim: 1024, quality: 0.82, mime: 'image/jpeg' });
            } catch (e) {
                console.warn('导入：音乐封面预压缩失败，将尝试后续写入', e);
            }
        }
        try {
            const saved = await setLocalStorageStringWithQuotaFallback(MUSIC_PLAYER_COVER_LS_KEY, coverStr, { maxDim: 512, quality: 0.72, mime: 'image/jpeg' });
            MusicPlayer.customCover = saved && String(saved).trim() ? saved : coverStr;
        } catch (e) {
            console.warn('导入：音乐封面未写入本地存储（本次会话仍可使用）', e);
            MusicPlayer.customCover = coverStr;
        }
    }

    // 导入后刷新好友缓存和聊天列表（须先 await IDB 预热，避免 loadFriendsFromStorage 暂态读到「仅系统预设」并污染内存）
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
        if (typeof refreshFriendsCache === 'function' && typeof loadFriendsFromStorage === 'function') {
            refreshFriendsCache(loadFriendsFromStorage());
        }
    } catch (e) {
        console.warn('导入后刷新好友缓存失败:', e && (e.message || e));
    }

    // 导入后尽量立即刷新主卡片显示（失败不影响数据完整性校验）
    try {
        if (typeof loadMainCardText === 'function') loadMainCardText();
    } catch (e) {}

    try {
        loadApiSettings({ forceFormSync: true });
        checkApiInputs();
    } catch (e) {}
    } finally {
        resumeProactiveAfterImport();
    }
}

// 导出全部数据（备份）
async function exportAllData() {
    showLoading('正在导出数据...');

    try {
        const desktopData = window.LegoDesktop ? window.LegoDesktop.collectBackup() : undefined;

        // 主界面主卡片
        const mainCardData = collectMainCardData();

        // 音乐播放器（异步，包含音频base64）
        const musicData = await collectMusicData();

        // 世界书
        const worldBookData = collectWorldBookData();

        // 主题（补齐主卡片背景，并对两个背景图进行等比例压缩）
        const rawTheme = collectThemeSettings();
        const [homeScreenBg, globalAppBg] = await Promise.all([
            compressImageDataUrl(rawTheme.homeScreenBg, 1440, 0.82),
            compressImageDataUrl(rawTheme.globalAppBg, 1440, 0.82)
        ]);
        const themeSettings = {
            homeScreenBg,
            globalAppBg,
            functionIcons: rawTheme.functionIcons || {},
            mainCardBg: typeof mainCardData.backgroundImage === 'string' ? mainCardData.backgroundImage : (rawTheme.mainCardBg || '')
        };

        // 设置（API 设置全部数据）
        const apiSettings = collectApiSettings();
        const settingsData = { api: apiSettings };

        // 导出前确保 IndexedDB 好友已进内存、系统预设已加载，否则 collectWechatData 会得到空好友/空聊天
        await Promise.all([
            initFriendsFromIndexedDBIfNeeded(),
            typeof initChatHistoriesFromIndexedDBIfNeeded === 'function'
                ? initChatHistoriesFromIndexedDBIfNeeded()
                : Promise.resolve(),
            loadSystemDefaultFriends()
        ]);

        // 微信（好友/角色卡/聊天/表情包/朋友圈/我的）
        const wechatData =
            typeof Wechat !== 'undefined' && Wechat.backup && typeof Wechat.backup.collectWechatData === 'function'
                ? (typeof Wechat.backup.collectWechatDataAsync === 'function'
                    ? await Wechat.backup.collectWechatDataAsync()
                    : Wechat.backup.collectWechatData())
                : collectWechatData();
        wechatData.emoji =
            typeof Wechat !== 'undefined' && Wechat.backup && typeof Wechat.backup.collectEmojiData === 'function'
                ? Wechat.backup.collectEmojiData()
                : collectEmojiData();

        // 压缩好友/角色卡/群聊侧头像（避免导出的 JSON 过大导致导入时 localStorage 配额不足）
        if (Array.isArray(wechatData.friends)) {
            const avatarPromises = wechatData.friends.map(async (f) => {
                if (!f || typeof f !== 'object') return f;
                const c = async (s) => {
                    if (typeof s !== 'string' || !s.startsWith('data:')) return s;
                    try {
                        return await compressImageDataUrl(s, 256, 0.82);
                    } catch (e) {
                        return s;
                    }
                };
                if (f.avatar) f.avatar = await c(f.avatar);
                if (f.chatAvatar) f.chatAvatar = await c(f.chatAvatar);
                if (f.groupMyChatAvatar) f.groupMyChatAvatar = await c(f.groupMyChatAvatar);
                if (f.persona && typeof f.persona === 'object' && f.persona.avatar) {
                    f.persona.avatar = await c(f.persona.avatar);
                }
                if (f.groupMyPersona && typeof f.groupMyPersona === 'object' && f.groupMyPersona.avatar) {
                    f.groupMyPersona.avatar = await c(f.groupMyPersona.avatar);
                }
                return f;
            });
            wechatData.friends = await Promise.all(avatarPromises);
        }

        if (wechatData.myProfile && typeof wechatData.myProfile === 'object' && wechatData.myProfile.avatar) {
            try {
                const a = wechatData.myProfile.avatar;
                if (typeof a === 'string' && a.startsWith('data:')) {
                    wechatData.myProfile.avatar = await compressImageDataUrl(a, 256, 0.82);
                }
            } catch (e) {}
        }

        // 微信外观背景图：globalBg（全局背景）也做等比例压缩
        if (wechatData.wechatAppearance && wechatData.wechatAppearance.globalBg) {
            wechatData.wechatAppearance.globalBg = await compressImageDataUrl(
                wechatData.wechatAppearance.globalBg, 1440, 0.82
            );
        }

        // 微信主卡片头像：压缩
        if (wechatData.userInfo && wechatData.userInfo.avatar) {
            wechatData.userInfo.avatar = await compressImageDataUrl(
                wechatData.userInfo.avatar, 256, 0.82
            );
        }

        // 组织数据结构（不包含推文/系统指令/购物）
        const backupData = {
            version: '2.0',
            exportTime: new Date().toISOString(),
            identifier: BACKUP_IDENTIFIER,
            data: {
                mainCard: mainCardData,
                desktop: desktopData,
                music: musicData,
                worldBook: worldBookData,
                theme: themeSettings,
                settings: settingsData,
                wechat: wechatData
            }
        };

        // 生成备份文件，在开头添加识别文字
        const backupJson = JSON.stringify(backupData, null, 2);
        const backupContent = `${BACKUP_IDENTIFIER}
${backupJson}`;
        const blob = new Blob([backupContent], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        // 创建下载链接
        const a = document.createElement('a');
        a.href = url;
        const now = new Date();
        const pad = n => String(n).padStart(2, '0');
        a.download = `Lego-${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}.json`;
        document.body.appendChild(a);

        // 触发下载
        a.click();

        // 清理
        setTimeout(() => {
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
            hideLoading();
            showNotification('数据已全部导出到默认下载目录');
        }, 1000);
    } catch (error) {
        console.error('导出数据失败:', error);
        hideLoading();
        showNotification(`数据导出失败：${error.message}`);
    }
}

// 收集API设置信息
function collectApiSettings() {
    try {
        return {
            ...readApiSettingsFromStorage(),
            apiPresets: getPresets()
        };
    } catch (e) {
        console.error('收集API设置失败:', e);
        return { apiPresets: [] };
    }
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

// 规范化 API Key：去 Bearer 前缀、换行/控制符、零宽字符、成对引号及意外空白。
function normalizeMiniMaxApiKey(apiKey) {
    if (apiKey == null) return '';
    let s = String(apiKey)
        .replace(/[\u200B-\u200D\u2060\uFEFF]/g, '')
        .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
        .trim();
    s = stripMatchingApiKeyQuotes(s);
    if (/^Bearer(?:\s|:)+/i.test(s)) s = s.replace(/^Bearer(?:\s|:)+/i, '').trim();
    s = stripMatchingApiKeyQuotes(s);
    return s.replace(/\s+/g, '');
}

/** 与 server.js normalizeTargetBaseUrl 对齐：去掉误粘贴的 endpoint 后缀 */
function normalizeApiBaseUrlForProxy(apiUrl) {
    const trimmed = String(apiUrl || '').trim();
    if (!trimmed) return '';
    try {
        const u = new URL(trimmed);
        if (!/^https?:$/.test(u.protocol) || u.username || u.password) return '';
        u.hash = '';
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
    } catch (e) {
        return '';
    }
}

/** 由 API base 生成 OpenAI-compatible /v1/models 地址 */
function buildOpenAIModelsListUrl(apiUrl) {
    const base = normalizeApiBaseUrlForProxy(apiUrl);
    if (!base) return '';
    const u = new URL(base);
    const p = u.pathname || '/';
    const normalizedPath = p.endsWith('/') ? p : (p + '/');
    const hasV1 = normalizedPath.toLowerCase().endsWith('/v1/');
    u.pathname = hasV1 ? (normalizedPath + 'models') : (normalizedPath + 'v1/models');
    return u.toString();
}

function normalizeApiKeyForBearer(apiKey) {
    return normalizeMiniMaxApiKey(apiKey);
}

function isValidApiKeyToken(apiKey) {
    const normalized = normalizeApiKeyForBearer(apiKey);
    return !!normalized && /^[\x21-\x7E]+$/.test(normalized);
}

function expandMinimaxVoiceErrorHint(message, shortHint) {
    const m = String(message || '').toLowerCase();
    if (!m) return message;
    if (m.includes('invalid') && (m.includes('api') || m.includes('key'))) {
        if (shortHint) {
            return (
                String(message) +
                '（须使用 MiniMax「语音合成/T2A」API Key，并与当前服务访问的线路一致；国内控制台可设 MINIMAX_API_BASE=https://api.minimaxi.chat 后重启服务）'
            );
        }
        return (
            String(message) +
            '。请到 MiniMax 开放平台核对：① API Key 须为「语音合成（T2A）」可用密钥，不是其它产品的 Key；② Group ID 与该 Key 所属账号一致；③ 国际站默认请求 api.minimax.io；若账号在国内控制台开通，请将启动环境变量设为 MINIMAX_API_BASE=https://api.minimaxi.chat 后重启 Lego 的 Node 服务再测。'
        );
    }
    return message;
}

// 收集克隆音色设置信息
function collectVoiceSettings() {
    try {
        const voiceSettings = localStorage.getItem('voiceSettings');

        if (voiceSettings === null) {
            return {};
        }

        try {
            const parsed = JSON.parse(voiceSettings);
            if (!parsed || typeof parsed !== 'object') return {};

            parsed.groupId = parsed.groupId != null ? String(parsed.groupId).trim() : '';
            parsed.apiKey = normalizeMiniMaxApiKey(parsed.apiKey);
            if (parsed.voiceModel != null) parsed.voiceModel = String(parsed.voiceModel).trim();
            if (parsed.voiceId != null) parsed.voiceId = String(parsed.voiceId).trim();

            return parsed;
        } catch (parseError) {
            console.error('解析voiceSettings失败:', parseError);
            localStorage.removeItem('voiceSettings');
            return {};
        }
    } catch (e) {
        console.error('收集克隆音色设置失败:', e);
        return {};
    }
}

// 加载语音设置
function loadVoiceSettings(retryCount = 0) {
    try {
        const voiceSettings = collectVoiceSettings();

        const groupIdInput = document.getElementById('minimax-group-id');
        const apiKeyInput = document.getElementById('minimax-api-key');
        const voiceModelSelect = document.getElementById('minimax-voice-model');

        if (groupIdInput && apiKeyInput && voiceModelSelect) {
            groupIdInput.value = voiceSettings.groupId || '';
            apiKeyInput.value = voiceSettings.apiKey || '';
            voiceModelSelect.value = voiceSettings.voiceModel || 'speech-2.8-turbo';
        } else if (retryCount < 10) {
            setTimeout(() => loadVoiceSettings(retryCount + 1), 200);
        } else {
            console.error('超过最大重试次数，无法加载语音设置');
        }
    } catch (e) {
        console.error('加载克隆音色设置失败:', e);
        if (retryCount < 10) {
            setTimeout(() => loadVoiceSettings(retryCount + 1), 200);
        }
    }
}

// 更新连接状态显示
function updateConnectionStatus(status, message) {
    const statusEl = document.getElementById('minimax-connection-status');
    if (!statusEl) return;
    
    const dotEl = statusEl.querySelector('.status-dot');
    const textEl = statusEl.querySelector('.status-text');
    
    statusEl.className = 'connection-status';
    if (dotEl) dotEl.className = 'status-dot';
    
    if (status === 'success') {
        statusEl.classList.add('status-success');
        if (dotEl) dotEl.classList.add('success');
        if (textEl) textEl.textContent = message || '连接成功';
    } else if (status === 'error') {
        statusEl.classList.add('status-error');
        if (dotEl) dotEl.classList.add('error');
        if (textEl) textEl.textContent = message || '连接失败';
    } else if (status === 'testing') {
        statusEl.classList.add('status-testing');
        if (dotEl) dotEl.classList.add('testing');
        if (textEl) textEl.textContent = message || '测试中...';
    } else {
        if (textEl) textEl.textContent = message || '未测试';
    }
}

/** 连接测试用：speech-01/02 与「音色_mini65」不兼容；中文测试文案用官方中文版音色 ID */
function pickMinimaxConnectionTestVoice(model) {
    const m = String(model || '');
    if (/^speech-0[12]-/i.test(m)) return 'Chinese (Mandarin)_Lyrical_Voice';
    return '音色_mini65';
}

// 保存语音设置
async function saveVoiceSettings() {
    try {
        const voiceSettings = {
            groupId: document.getElementById('minimax-group-id').value.trim(),
            apiKey: normalizeMiniMaxApiKey(document.getElementById('minimax-api-key').value),
            voiceModel: (document.getElementById('minimax-voice-model') || {}).value || 'speech-2.8-turbo',
        };
        if (voiceSettings.voiceModel) voiceSettings.voiceModel = String(voiceSettings.voiceModel).trim();

        if (!voiceSettings.groupId || !voiceSettings.apiKey) {
            showNotification('请先填写Group ID和API密钥');
            return;
        }

        // 先保存设置到 localStorage，确保用户信息不会因连接失败而丢失
        try {
            localStorage.setItem('voiceSettings', JSON.stringify(voiceSettings));
            showNotification('克隆音色设置已保存，正在测试连接...');
        } catch (saveError) {
            console.error('保存设置到localStorage失败:', saveError);
            showNotification('保存设置失败，请检查浏览器存储权限');
            return;
        }
        
        // 显示测试中状态
        updateConnectionStatus('testing', '测试中...');
        showLoading('正在测试连接...');
        
        // 后台测试连接
        const testResult = await testMinimaxConnection(true);
        
        hideLoading();
        
        if (testResult.success) {
            // 连接成功
            updateConnectionStatus('success', '连接成功');
            showNotification('克隆音色设置保存成功，连接测试通过');
        } else {
            // 连接失败，但设置已保存
            updateConnectionStatus('error', `连接失败: ${expandMinimaxVoiceErrorHint(testResult.message, false)}`);
            showNotification(
                '克隆音色设置已保存。连接测试失败：' +
                    expandMinimaxVoiceErrorHint(testResult.message || '未知错误', true)
            );
        }
    } catch (e) {
        hideLoading();
        console.error('保存克隆音色设置失败:', e);
        updateConnectionStatus('error', '连接失败: 网络错误');
        showNotification('保存设置失败，请重试');
    }
}

// 测试Minimax连接
async function testMinimaxConnection(isInternal = false) {
    try {
        const voiceSettings = {
            groupId: document.getElementById('minimax-group-id').value.trim(),
            apiKey: normalizeMiniMaxApiKey(document.getElementById('minimax-api-key').value),
            voiceModel: (document.getElementById('minimax-voice-model') || {}).value || 'speech-2.8-turbo',
        };
        
        if (!voiceSettings.groupId || !voiceSettings.apiKey) {
            const msg = '请先填写Group ID和API密钥';
            if (!isInternal) {
                updateConnectionStatus('error', msg);
                showNotification(msg);
            }
            return { success: false, message: msg };
        }
        
        if (!isInternal) {
            updateConnectionStatus('testing', '测试中...');
            showLoading('正在测试连接...');
        }
        
        // 测试连接，使用本地代理 API（相对路径，与当前页面主机一致，避免 127.0.0.1 / localhost 混用）
        const response = await fetch('/api/voice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: voiceSettings.apiKey,
                groupId: voiceSettings.groupId,
                model: voiceSettings.voiceModel,
                text: '测试连接成功',
                voice_id: pickMinimaxConnectionTestVoice(voiceSettings.voiceModel),
                speed: 1.0,
                volume: 1.0,
                pitch: 0
            })
        });
        
        if (!isInternal) {
            hideLoading();
        }
        
        if (response.ok) {
            const successMsg = '连接成功';
            if (!isInternal) {
                updateConnectionStatus('success', successMsg);
                showNotification('Minimax连接成功');
            }
            return { success: true, message: successMsg };
        } else {
            let errorMsg = '未知错误';
            try {
                const errorData = await response.json();
                errorMsg = errorData.message || `HTTP ${response.status}`;
                if (errorData.code != null) {
                    errorMsg += ' (code ' + errorData.code + ')';
                }
            } catch (e) {
                errorMsg = `HTTP ${response.status}`;
            }
            
            if (!isInternal) {
                const uiLong = expandMinimaxVoiceErrorHint(errorMsg, false);
                const uiShort = expandMinimaxVoiceErrorHint(errorMsg, true);
                updateConnectionStatus('error', `连接失败: ${uiLong}`);
                showNotification(`连接失败: ${uiShort}`);
            }
            return { success: false, message: errorMsg };
        }
    } catch (e) {
        if (!isInternal) {
            hideLoading();
        }
        
        const errorMsg = e.message || '网络错误';
        console.error('测试连接失败:', e);
        
        if (!isInternal) {
            updateConnectionStatus('error', `连接失败: ${errorMsg}`);
            showNotification('连接失败，请检查网络和配置');
        }
        return { success: false, message: errorMsg };
    }
}

/**
 * 从文本中提取对白台词
 * 线下模式对白台词用 " " 包裹，并有常见标点结尾
 * 线上模式每句话都是对白台词
 * 返回提取出的对白文本数组
 */
function extractDialogueFromText(text) {
    if (!text || typeof text !== 'string') return [];

    const dialogues = [];

    // 模式1: 提取被 " " 双引号包裹的内容（线下模式）
    // 支持中文双引号 "" 和英文双引号 ""
    const quotedPattern = /"([^""]+)"|"([^"]+)"/g;
    let match;
    while ((match = quotedPattern.exec(text)) !== null) {
        const dialogue = (match[1] || match[2] || '').trim();
        if (dialogue) dialogues.push(dialogue.length <= 1200 ? dialogue : dialogue.slice(0, 1200));
    }

    // 如果找到了引号包裹的内容，返回这些
    if (dialogues.length > 0) {
        return dialogues;
    }

    // 模式2: 如果没有引号包裹的内容，则按句子分割（线上模式）
    // 使用常见标点分割：句号、问号、感叹号
    const sentences = text.split(/[。！？!?.]/).map(s => s.trim()).filter(s => s.length > 0);

    // 过滤掉可能是动作描述的内容（通常以括号或特殊符号开头）
    for (const sentence of sentences) {
        // 跳过明显的动作描述（括号开头、星号包裹等）
        if (/^[\[【（(（]/.test(sentence) && !/[。！？!?]$/.test(sentence)) continue;
        if (/^\*|^～/.test(sentence)) continue;

        // 保留可作 TTS 的片段（放宽长度上限，避免长句无标点时整段被丢弃）
        if (sentence.length >= 2) {
            dialogues.push(sentence.length <= 1200 ? sentence : sentence.slice(0, 1200));
        }
    }

    return dialogues;
}

// 生成语音（支持好友特定的音色ID和语言）
async function generateVoice(text, options = {}) {
    try {
        const voiceSettings = collectVoiceSettings();

        if (!voiceSettings.groupId || !voiceSettings.apiKey) {
            return null;
        }

        // 从选项中获取好友特定的设置
        const rawOptVid = options.voiceId != null ? String(options.voiceId).trim() : '';
        const friendVoiceId = rawOptVid || null;
        const friendLanguage = options.language || 'zh';

        const rawGlobalVid =
            voiceSettings.voiceId != null ? String(voiceSettings.voiceId).trim() : '';
        // 决定使用哪个 voice_id：优先好友音色，其次全局设置，最后官方预设（勿用 'default'，Minimax 不认）
        const voiceId = friendVoiceId || rawGlobalVid || '音色_mini65';

        const response = await fetch('/api/voice', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                apiKey: voiceSettings.apiKey,
                groupId: voiceSettings.groupId,
                model: voiceSettings.voiceModel,
                text: text,
                voice_id: voiceId,
                speed: 1.0,
                volume: 1.0,
                pitch: 0,
                language: friendLanguage
            })
        });

        if (response.ok) {
            const blob = await response.blob();
            const url = URL.createObjectURL(blob);
            return url;
        } else {
            let errDetail = 'HTTP ' + response.status;
            try {
                const ct = (response.headers && response.headers.get && response.headers.get('content-type')) || '';
                if (ct.includes('json')) {
                    const j = await response.json();
                    errDetail = j.message || j.error || JSON.stringify(j);
                } else {
                    const t = await response.text();
                    if (t) errDetail = t.slice(0, 240);
                }
            } catch (e) {
                /* ignore */
            }
            console.error('生成语音失败:', expandMinimaxVoiceErrorHint(errDetail, true));
            return null;
        }
    } catch (e) {
        console.error('生成语音失败:', e);
        return null;
    }
}

// 播放语音（桌面端可直接调用；移动端常受自动播放策略限制，优先用 attachPlayableTtsToLastFriendBubble）
function playVoice(url) {
    if (!url) return;

    const audio = new Audio(url);
    audio.play().catch(e => {
        console.error('播放语音失败:', e);
    });
}

/**
 * 在最近一条好友气泡下添加可点击的语音播放条（满足移动端「需用户手势触发播放」）。
 */
function attachPlayableTtsToLastFriendBubble(audioUrl) {
    if (!audioUrl) return;
    const chatContent = document.querySelector('.chat-content');
    if (!chatContent) {
        playVoice(audioUrl);
        return;
    }
    const msgs = chatContent.querySelectorAll('.chat-message.other-message');
    const last = msgs[msgs.length - 1];
    if (!last) {
        playVoice(audioUrl);
        return;
    }
    last.querySelectorAll('.chat-minimax-tts-row').forEach((el) => el.remove());

    const row = document.createElement('div');
    row.className = 'chat-minimax-tts-row';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'chat-minimax-tts-play-btn';
    btn.textContent = '播放语音';
    row.appendChild(btn);

    const contentWrap = last.querySelector('.chat-message-content');
    if (contentWrap) {
        contentWrap.appendChild(row);
    } else {
        last.appendChild(row);
    }

    let audioEl = null;
    btn.addEventListener('click', () => {
        if (!audioEl) audioEl = new Audio(audioUrl);
        audioEl.play().catch((e) => {
            console.error('播放语音失败:', e);
            if (typeof showNotification === 'function') {
                showNotification('无法播放语音，请检查浏览器是否静音或重试');
            }
        });
    });

    try {
        chatContent.scrollTop = chatContent.scrollHeight;
    } catch (eSc) {}
}

// 收集世界书模块数据
function collectWorldBookData() {
    try {
        return getWorldBookData();
    } catch (e) {
        console.error('收集世界书数据失败:', e);
        return { folders: [], entries: [] };
    }
}

// ========== 小手机主题（主界面背景 / 功能图标 / 主卡片背景 / 全局背景）==========
const THEME_LS_KEY = 'themeSettings';
const THEME_ICON_DEFAULT_SRC = {
    shopping: 'assets/desktop/shopping.png',
    books: 'assets/desktop/books.png',
    theme: 'assets/desktop/theme.png',
    settings: 'assets/desktop/settings.png',
    phone: 'assets/desktop/phone.png',
    twitter: 'assets/desktop/twitter.png',
    wechat: 'assets/desktop/wechat.png',
    system: 'assets/desktop/system.png'
};
const THEME_ICON_KEYS = Object.keys(THEME_ICON_DEFAULT_SRC);
const THEME_GLOBAL_BG_PAGE_IDS = [
    'system-page',
    'books-page',
    'settings-page',
    'api-settings-page',
    'auto-message-api-settings-page',
    'theme-page',
    'shopping-page',
    'phone-page',
    'twitter-page'
];

let themeEditorDraft = null;
let themeEditorIconPickKey = null;

function getThemeSettingsFromStorage() {
    try {
        const raw = localStorage.getItem(THEME_LS_KEY);
        return raw ? JSON.parse(raw) : {};
    } catch (e) {
        return {};
    }
}

function normalizeThemeSettingsPayload(obj) {
    const o = obj && typeof obj === 'object' ? obj : {};
    const iconsRaw = o.functionIcons && typeof o.functionIcons === 'object' ? o.functionIcons : {};
    const functionIcons = {};
    THEME_ICON_KEYS.forEach((k) => {
        const v = iconsRaw[k];
        if (typeof v === 'string' && v.length > 0) functionIcons[k] = v;
    });
    return {
        homeScreenBg: typeof o.homeScreenBg === 'string' && o.homeScreenBg ? o.homeScreenBg : null,
        globalAppBg: typeof o.globalAppBg === 'string' && o.globalAppBg ? o.globalAppBg : null,
        functionIcons
    };
}

function applyHomeScreenBackgroundLayer(url) {
    const layer = document.getElementById('home-screen-bg-layer');
    if (!layer) return;
    if (url) {
        layer.style.backgroundImage = 'url(' + JSON.stringify(url) + ')';
        layer.style.backgroundSize = 'cover';
        layer.style.backgroundPosition = 'center';
        layer.style.backgroundRepeat = 'no-repeat';
    } else {
        layer.style.backgroundImage = '';
        layer.style.backgroundSize = '';
        layer.style.backgroundPosition = '';
        layer.style.backgroundRepeat = '';
    }
}

function applyGlobalAppBackgroundFromTheme(url) {
    const u = url || null;
    THEME_GLOBAL_BG_PAGE_IDS.forEach((id) => {
        const el = document.getElementById(id);
        if (!el) return;
        if (u) {
            el.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.style.backgroundRepeat = 'no-repeat';
        } else {
            el.style.removeProperty('background-image');
            el.style.removeProperty('background-size');
            el.style.removeProperty('background-position');
            el.style.removeProperty('background-repeat');
        }
    });
    // 主题「全局背景图」需要同步影响推特界面内部各板块容器的背景
    try { applyTwitterGlobalBackgroundFromTheme(u); } catch (e) {}
}

function applyTwitterGlobalBackgroundFromTheme(url) {
    const page = document.getElementById('twitter-page');
    if (!page) return;
    const u = url || null;
    const targets = page.querySelectorAll(
        [
            '.twitter-app-main',
            '.twitter-feed-panels',
            '.twitter-feed-panel',
            '.twitter-view-profile',
            '.twitter-profile-scroll',
            '.twitter-view'
        ].join(',')
    );
    targets.forEach((el) => {
        if (!el || !(el instanceof HTMLElement)) return;
        if (u) {
            el.style.backgroundImage = 'url(' + JSON.stringify(u) + ')';
            el.style.backgroundSize = 'cover';
            el.style.backgroundPosition = 'center';
            el.style.backgroundRepeat = 'no-repeat';
        } else {
            el.style.removeProperty('background-image');
            el.style.removeProperty('background-size');
            el.style.removeProperty('background-position');
            el.style.removeProperty('background-repeat');
        }
    });
}

function applyFunctionIconsFromTheme(icons) {
    const map = icons && typeof icons === 'object' ? icons : {};
    document.querySelectorAll('.function-item[data-page], .nav-item[data-page]').forEach((item) => {
        const key = item.dataset.page;
        if (!key || !THEME_ICON_DEFAULT_SRC[key]) return;
        const img = item.querySelector('.function-icon img, .nav-icon img');
        if (!img) return;
        img.src = map[key] || THEME_ICON_DEFAULT_SRC[key];
    });
}

function applyMainCardBackgroundFromStorage() {
    const url = localStorage.getItem('backgroundImage') || '';
    const cardBackground = document.querySelector('.card-background');
    if (!cardBackground) return;
    if (url) {
        cardBackground.style.backgroundImage = 'url(' + JSON.stringify(url) + ')';
        cardBackground.style.backgroundSize = 'cover';
        cardBackground.style.backgroundPosition = 'center';
    } else {
        cardBackground.style.backgroundImage = '';
    }
}

function applyThemeRuntime() {
    const ts = normalizeThemeSettingsPayload(getThemeSettingsFromStorage());
    applyHomeScreenBackgroundLayer(ts.homeScreenBg);
    applyGlobalAppBackgroundFromTheme(ts.globalAppBg);
    applyFunctionIconsFromTheme(ts.functionIcons);
    applyMainCardBackgroundFromStorage();
}

function initThemeEditorDraftFromSaved() {
    const saved = normalizeThemeSettingsPayload(getThemeSettingsFromStorage());
    themeEditorDraft = {
        homeScreenBg: saved.homeScreenBg,
        globalAppBg: saved.globalAppBg,
        mainCardBg: localStorage.getItem('backgroundImage') || null,
        functionIcons: { ...saved.functionIcons }
    };
}

function refreshThemeEditorPanel() {
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    const d = themeEditorDraft;

    function setThumb(imgId, phId, wrapId, url) {
        const img = document.getElementById(imgId);
        const ph = document.getElementById(phId);
        const wrap = document.getElementById(wrapId);
        if (!img || !ph) return;
        if (url) {
            img.src = url;
            img.style.display = 'block';
            ph.style.display = 'none';
            if (wrap) wrap.classList.add('has-image');
        } else {
            img.removeAttribute('src');
            img.style.display = 'none';
            ph.style.display = '';
            if (wrap) wrap.classList.remove('has-image');
        }
    }

    setThumb('theme-thumb-img-home', 'theme-thumb-ph-home', 'theme-thumb-wrap-home', d.homeScreenBg);
    setThumb('theme-thumb-img-global', 'theme-thumb-ph-global', 'theme-thumb-wrap-global', d.globalAppBg);
    setThumb('theme-thumb-img-card', 'theme-thumb-ph-card', 'theme-thumb-wrap-card', d.mainCardBg);

    THEME_ICON_KEYS.forEach((key) => {
        const el = document.getElementById('theme-icon-draft-' + key);
        if (!el) return;
        const custom = d.functionIcons && d.functionIcons[key];
        el.src = custom || THEME_ICON_DEFAULT_SRC[key];
    });
}

function themeEditorPickFile(kind) {
    const map = {
        home: 'theme-editor-file-home',
        mainCard: 'theme-editor-file-mainCard',
        global: 'theme-editor-file-global'
    };
    const id = map[kind];
    if (id) document.getElementById(id)?.click();
}

function themeEditorConsumeFile(field, event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    if (!file) return;
    if (!isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    const reader = new FileReader();
    reader.onload = function (e) {
        themeEditorDraft[field] = e.target.result;
        refreshThemeEditorPanel();
    };
    reader.readAsDataURL(file);
}

function themeEditorClearDraft(field) {
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    if (field === 'homeScreenBg' || field === 'globalAppBg' || field === 'mainCardBg') {
        themeEditorDraft[field] = null;
    }
    refreshThemeEditorPanel();
}

function themeEditorPickIcon(key) {
    themeEditorIconPickKey = key;
    document.getElementById('theme-editor-file-icon')?.click();
}

function themeEditorConsumeIconFile(event) {
    const input = event.target;
    const file = input.files && input.files[0];
    input.value = '';
    const key = themeEditorIconPickKey;
    themeEditorIconPickKey = null;
    if (!file || !key) return;
    if (!isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    if (!themeEditorDraft.functionIcons) themeEditorDraft.functionIcons = {};
    const reader = new FileReader();
    reader.onload = function (e) {
        themeEditorDraft.functionIcons[key] = e.target.result;
        refreshThemeEditorPanel();
    };
    reader.readAsDataURL(file);
}

function themeEditorClearIcon(key) {
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    if (themeEditorDraft.functionIcons && themeEditorDraft.functionIcons[key]) {
        delete themeEditorDraft.functionIcons[key];
    }
    refreshThemeEditorPanel();
}

async function saveThemeEditor() {
    if (!themeEditorDraft) initThemeEditorDraftFromSaved();
    const draft = themeEditorDraft;
    showLoading();
    updateImportProgress('正在压缩图片…');
    try {
        const [homeScreenBg, globalAppBg, mainCardBg] = await Promise.all([
            compressImageDataUrl(draft.homeScreenBg, 1440, 0.82),
            compressImageDataUrl(draft.globalAppBg, 1440, 0.82),
            compressImageDataUrl(draft.mainCardBg, 1440, 0.82)
        ]);
        const iconKeys = Object.keys(draft.functionIcons || {});
        const functionIcons = {};
        if (iconKeys.length) {
            const compressed = await Promise.all(
                iconKeys.map((k) => compressImageDataUrl(draft.functionIcons[k], 256, 0.82))
            );
            iconKeys.forEach((k, i) => {
                if (compressed[i]) functionIcons[k] = compressed[i];
            });
        }
        const next = normalizeThemeSettingsPayload({
            homeScreenBg,
            globalAppBg,
            functionIcons
        });
        localStorage.setItem(THEME_LS_KEY, JSON.stringify(next));
        if (mainCardBg) {
            localStorage.setItem('backgroundImage', mainCardBg);
        } else {
            localStorage.removeItem('backgroundImage');
        }
    } catch (err) {
        console.error(err);
        const msg = err && err.name === 'QuotaExceededError'
            ? '保存失败：浏览器存储空间已满，请清理本站数据或换用更小的图片'
            : ('保存失败：' + (err.message || '图片可能过大'));
        showNotification(msg);
        hideLoading();
        return;
    }
    hideLoading();
    themeEditorDraft = null;
    applyThemeRuntime();
    showNotification('主题已保存');
}

function cancelThemeEditor() {
    themeEditorDraft = null;
    themeEditorIconPickKey = null;
    showPage('home');
}

// 收集主题模块配置（导出备份用）
function collectThemeSettings() {
    try {
        const raw = normalizeThemeSettingsPayload(getThemeSettingsFromStorage());
        return {
            homeScreenBg: raw.homeScreenBg || null,
            globalAppBg: raw.globalAppBg || null,
            functionIcons: raw.functionIcons || {}
        };
    } catch (e) {
        console.error('收集主题设置失败:', e);
        return { homeScreenBg: null, globalAppBg: null, functionIcons: {} };
    }
}

function compressImageDataUrl(dataUrl, maxDim, quality) {
    return new Promise((resolve) => {
        if (!dataUrl || typeof dataUrl !== 'string') { resolve(dataUrl); return; }
        if (!dataUrl.startsWith('data:image')) { resolve(dataUrl); return; }
        const img = new Image();
        img.onload = function () {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
            canvas.width = Math.round(img.width * scale);
            canvas.height = Math.round(img.height * scale);
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = function () { resolve(dataUrl); };
        img.src = dataUrl;
    });
}

// 微信备份导出收集：见 wechat-backup.js（Wechat.backup.collectWechatData）

// 收集购物记录
function collectShoppingData() {
    try {
        return parseJsonFromPossiblyEncodedStorage('shoppingData', {}) || {};
    } catch (e) {
        console.error('收集购物记录失败:', e);
        return {};
    }
}

// ========== 购物（分类 + API 刷新商品）==========
const SHOPPING_CATEGORIES = ['推荐', '服装', '美妆', '食品', '数码', '家居', '情趣', '护肤', '车行', '奢侈品'];

function getShoppingState() {
    try {
        const raw = parseJsonFromPossiblyEncodedStorage('shoppingData', {}) || {};
        if (!raw.productsByCategory || typeof raw.productsByCategory !== 'object') raw.productsByCategory = {};
        if (!raw.currentCategory || !SHOPPING_CATEGORIES.includes(raw.currentCategory)) {
            raw.currentCategory = '推荐';
        }
        if (typeof raw.searchKeyword !== 'string') raw.searchKeyword = '';
        if (!['home', 'cart', 'profile'].includes(raw.shoppingTab)) raw.shoppingTab = 'home';
        if (!Array.isArray(raw.cartItems)) raw.cartItems = [];
        raw.cartItems.forEach((line) => {
            if (line.selected == null) line.selected = true;
            if (line.qty == null || line.qty < 1) line.qty = 1;
        });
        if (!raw.profile || typeof raw.profile !== 'object') raw.profile = {};
        if (typeof raw.profile.avatarDataUrl !== 'string') raw.profile.avatarDataUrl = '';
        if (typeof raw.profile.address !== 'string') raw.profile.address = '';
        if (typeof raw.profile.phone !== 'string') raw.profile.phone = '';
        raw.profile.nickname = String(raw.profile.nickname != null ? raw.profile.nickname : '')
            .trim()
            .slice(0, 24) || '可点击编辑';
        raw.profile.address = String(raw.profile.address || '')
            .replace(/\u0000/g, '')
            .trim()
            .slice(0, 500);
        raw.profile.phone = String(raw.profile.phone || '')
            .replace(/\u0000/g, '')
            .trim()
            .slice(0, 32);
        if (raw.profile.avatarDataUrl.length > 650000) raw.profile.avatarDataUrl = '';
        if (!Array.isArray(raw.orders)) raw.orders = [];
        // 旧版：按好友存礼物；新版：全局礼物库存（任意聊天可见，送出后扣减）
        if (!raw.chatGiftsByFriend || typeof raw.chatGiftsByFriend !== 'object') raw.chatGiftsByFriend = {};
        if (!Array.isArray(raw.giftPool)) raw.giftPool = [];
        return raw;
    } catch (e) {
        return {
            productsByCategory: {},
            currentCategory: '推荐',
            searchKeyword: '',
            shoppingTab: 'home',
            cartItems: [],
            profile: {
                nickname: '可点击编辑',
                avatarDataUrl: '',
                address: '',
                phone: ''
            },
            orders: [],
            chatGiftsByFriend: {},
            giftPool: []
        };
    }
}

function saveShoppingState(data) {
    try {
        saveJsonToStorageWithCompression('shoppingData', data);
        return true;
    } catch (err) {
        console.error('保存购物数据失败:', err);
        showNotification('保存失败，数据可能过大');
        return false;
    }
}

function sanitizeShoppingKeyword(kw) {
    return String(kw || '').replace(/[\r\n"\u0000]/g, ' ').trim().slice(0, 48);
}

function formatShoppingPrice(n) {
    const x = Math.round(Number(n) * 100) / 100;
    if (!Number.isFinite(x) || x < 0) return '¥0';
    const t = x.toFixed(2).replace(/\.?0+$/, '');
    return '¥' + t;
}

function buildShoppingApiTask(category, keyword) {
    const kw = keyword ? `「${keyword}」` : '（无，请按分类做综合推荐）';
    return `【购物商品生成·系统任务】
当前分类：「${category}」
用户搜索关键词：${kw}

请只输出一个 JSON 对象（可使用 \`\`\`json 代码块包裹，不要其它解释文字）。
结构示例字段名必须一致：
{"products":[{"name":"商品标准全称","imageQuery":"品牌 型号 品类","price":29.9,"lineStyle":3}]}

硬性要求：
1. 恰好 12 条商品，放在 products 数组内，且必须是中国大陆电商平台（淘宝/天猫/京东/拼多多等）真实在售或曾经真实在售过的商品，禁止虚构不存在的品牌、型号或产品。
2. name 使用该商品的规范全称（品牌+型号/系列，如「小米14 Pro 16GB+512GB」「农夫山泉 天然水 550ml×24瓶」），不得使用「好物」「礼盒装」「精选」等模糊词，也不要加emoji或营销感叹号。
3. imageQuery 是专门用于图片检索的极简关键词（品牌+型号/品类核心词，通常比 name 更短更精确，去掉容量颜色等次要规格），便于搜到该商品的真实实拍图；找不到更精确写法时可与 name 相同。
4. price 为数字（人民币元），保留一位或两位小数均可；12 条价格必须严格按从低到高递增（低价到高价都要有梯度）。
5. lineStyle 为 1～6 的整数，用于图片搜索失败时的前端占位配色，可自行分配。
6. 商品须符合当前分类；若有关键词，优先与关键词相关。`;
}

function normalizeShoppingProducts(arr) {
    const raw = Array.isArray(arr) ? arr : [];
    const list = raw.map((p, i) => {
        const name = String(p.name != null ? p.name : '').trim().slice(0, 160);
        const imageQuery = String(p.imageQuery != null ? p.imageQuery : '').trim().slice(0, 80) || name;
        let price = parseFloat(p.price);
        if (!Number.isFinite(price) || price < 0) price = 0;
        price = Math.round(price * 100) / 100;
        let lineStyle = parseInt(p.lineStyle, 10);
        if (!Number.isFinite(lineStyle) || lineStyle < 1 || lineStyle > 6) lineStyle = (i % 6) + 1;
        return {
            id: 'sp_' + Date.now() + '_' + i + '_' + Math.random().toString(36).slice(2, 8),
            name,
            imageQuery,
            price,
            lineStyle
        };
    }).filter((p) => p.name.length > 0);
    list.sort((a, b) => a.price - b.price);
    return list.slice(0, 12);
}

/**
 * 商品展示图地址：由服务端 /api/shopping-image 负责真实商品图检索 + 等比例压缩 + 落盘缓存，
 * 前端只需拼接查询串；找不到图时接口 404，<img> 走 onerror 移除自身，回退到线性占位配色卡片。
 */
function shoppingProductImageUrl(query, category) {
    const q = String(query || '').trim().slice(0, 80);
    if (!q) return '';
    const params = new URLSearchParams();
    params.set('q', q);
    // 「推荐」是聚合标签而非真实商品类目，作为检索关键词反而降低命中率，不下发
    const catTrim = String(category || '').trim();
    if (catTrim && catTrim !== '推荐') params.set('cat', catTrim.slice(0, 20));
    return '/api/shopping-image?' + params.toString();
}

function shoppingProductThumbHtml(imageQuery, category, lineStyle, thumbClass) {
    const ls = Math.min(6, Math.max(1, parseInt(lineStyle, 10) || 1));
    const cls = 'shopping-line-art' + (thumbClass ? ' ' + thumbClass : '');
    const src = shoppingProductImageUrl(imageQuery, category);
    const img = src
        ? '<img class="shopping-thumb-img" src="' + src + '" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.remove()">'
        : '';
    return '<div class="' + cls + '" data-line="' + ls + '">' + img + '</div>';
}

function renderShoppingProductGrid() {
    const st = getShoppingState();
    const grid = document.getElementById('shopping-product-grid');
    const empty = document.getElementById('shopping-empty-hint');
    if (!grid) return;
    const products = (st.productsByCategory && st.productsByCategory[st.currentCategory]) || [];
    if (!products.length) {
        grid.innerHTML = '';
        if (empty) empty.style.display = 'block';
        return;
    }
    if (empty) empty.style.display = 'none';
    grid.innerHTML = products
        .map((p) => {
            const nameEsc = escapeHtml(p.name);
            const price = formatShoppingPrice(p.price);
            return (
                '<div class="shopping-product-card" role="button" tabindex="0" data-spid="' +
                String(p.id).replace(/"/g, '') +
                '">' +
                shoppingProductThumbHtml(p.imageQuery || p.name, st.currentCategory, p.lineStyle) +
                '<div class="shopping-product-info">' +
                '<div class="shopping-product-name" title="' +
                nameEsc +
                '">' +
                nameEsc +
                '</div>' +
                '<div class="shopping-product-price">' +
                price +
                '</div>' +
                '</div></div>'
            );
        })
        .join('');

    grid.querySelectorAll('.shopping-product-card').forEach((el) => {
        el.addEventListener('click', function () {
            const id = this.getAttribute('data-spid');
            onShoppingProductCardTap(id);
        });
    });
}

function getShoppingProductByIdInCurrentCategory(productId) {
    const st = getShoppingState();
    const list = (st.productsByCategory && st.productsByCategory[st.currentCategory]) || [];
    return list.find((p) => String(p.id) === String(productId)) || null;
}

function addProductToShoppingCart(productId) {
    const st = getShoppingState();
    const p = getShoppingProductByIdInCurrentCategory(productId);
    if (!p) {
        showNotification('商品已失效，请刷新列表');
        return;
    }
    if (!Array.isArray(st.cartItems)) st.cartItems = [];
    const existing = st.cartItems.find(
        (c) => String(c.productId) === String(p.id) && c.category === st.currentCategory
    );
    if (existing) {
        existing.qty = (existing.qty || 1) + 1;
    } else {
        st.cartItems.push({
            cartLineId: 'cl_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
            productId: p.id,
            name: p.name,
            imageQuery: p.imageQuery || p.name,
            price: p.price,
            lineStyle: p.lineStyle,
            category: st.currentCategory,
            qty: 1,
            selected: true
        });
    }
    saveShoppingState(st);
    updateShoppingCartBadge();
    showNotification('已加入购物车');
}

function onShoppingProductCardTap(id) {
    addProductToShoppingCart(id);
}

function applyShoppingTabUI(tab) {
    const tabs = ['home', 'cart', 'profile'];
    if (!tabs.includes(tab)) tab = 'home';
    tabs.forEach((t) => {
        document.getElementById('shopping-view-' + t)?.classList.toggle('is-active', t === tab);
    });
    const hHome = document.getElementById('shopping-toolbar-home');
    const hCart = document.getElementById('shopping-toolbar-cart');
    const hProf = document.getElementById('shopping-toolbar-profile');
    if (hHome) hHome.style.display = tab === 'home' ? '' : 'none';
    if (hCart) hCart.style.display = tab === 'cart' ? '' : 'none';
    if (hProf) hProf.style.display = tab === 'profile' ? '' : 'none';
    document.querySelectorAll('.shopping-tab-btn').forEach((btn) => {
        btn.classList.toggle('is-active', btn.getAttribute('data-shop-tab') === tab);
    });
}

function switchShoppingTab(tab) {
    if (!['home', 'cart', 'profile'].includes(tab)) return;
    const st = getShoppingState();
    st.shoppingTab = tab;
    saveShoppingState(st);
    applyShoppingTabUI(tab);
    if (tab === 'cart') {
        renderShoppingCartList();
    }
    if (tab === 'profile') {
        syncShoppingProfileUI();
    }
}

function updateShoppingCartBadge() {
    const st = getShoppingState();
    const n = (st.cartItems || []).reduce((s, c) => s + (c.qty || 1), 0);
    const badge = document.getElementById('shopping-tab-cart-badge');
    if (!badge) return;
    if (n > 0) {
        badge.textContent = n > 99 ? '99+' : String(n);
        badge.style.display = '';
    } else {
        badge.style.display = 'none';
    }
}

function renderShoppingCartList() {
    const st = getShoppingState();
    const listEl = document.getElementById('shopping-cart-list');
    const storeEl = document.querySelector('.shopping-cart-store');
    const emptyEl = document.getElementById('shopping-cart-empty');
    if (!listEl) return;

    const items = st.cartItems || [];
    if (items.length === 0) {
        listEl.innerHTML = '';
        if (storeEl) storeEl.style.display = 'none';
        if (emptyEl) emptyEl.classList.add('is-visible');
    } else {
        if (storeEl) storeEl.style.display = '';
        if (emptyEl) emptyEl.classList.remove('is-visible');
        listEl.innerHTML = items
            .map((line) => {
                const nameEsc = escapeHtml(line.name);
                const catEsc = escapeHtml(line.category || '');
                const checked = line.selected !== false ? ' checked' : '';
                const priceStr = formatShoppingPrice(line.price);
                const lid = String(line.cartLineId).replace(/"/g, '');
                return (
                    '<div class="shopping-cart-row" data-line-id="' +
                    lid +
                    '">' +
                    '<input type="checkbox" class="shopping-cart-check"' +
                    checked +
                    ' onchange="onShoppingCartLineToggle(\'' +
                    lid +
                    '\', this.checked)">' +
                    '<div class="shopping-cart-row-main">' +
                    shoppingProductThumbHtml(line.imageQuery || line.name, line.category, line.lineStyle, 'shopping-line-art--thumb') +
                    '<div class="shopping-cart-info">' +
                    '<div class="shopping-cart-name">' +
                    nameEsc +
                    '</div>' +
                    '<div class="shopping-cart-meta">分类：' +
                    catEsc +
                    '</div>' +
                    '<div class="shopping-cart-price-row">' +
                    '<span class="shopping-cart-unit">' +
                    priceStr +
                    '</span>' +
                    '<div class="shopping-cart-qty">' +
                    '<button type="button" aria-label="减" onclick="changeShoppingCartQty(\'' +
                    lid +
                    '\',-1)">−</button>' +
                    '<span>' +
                    (line.qty || 1) +
                    '</span>' +
                    '<button type="button" aria-label="加" onclick="changeShoppingCartQty(\'' +
                    lid +
                    '\',1)">+</button>' +
                    '</div></div>' +
                    '<button type="button" class="shopping-cart-del" onclick="removeShoppingCartLine(\'' +
                    lid +
                    '\')">删除</button>' +
                    '</div></div></div>'
                );
            })
            .join('');
    }

    const all = document.getElementById('shopping-cart-check-all');
    if (all) {
        if (items.length === 0) {
            all.checked = false;
            all.indeterminate = false;
        } else {
            const sel = items.filter((c) => c.selected !== false).length;
            all.checked = sel === items.length;
            all.indeterminate = sel > 0 && sel < items.length;
        }
    }
    updateShoppingCartSummary();
    updateShoppingCartBadge();
}

function onShoppingCartLineToggle(cartLineId, checked) {
    const st = getShoppingState();
    const line = st.cartItems.find((c) => String(c.cartLineId) === String(cartLineId));
    if (!line) return;
    line.selected = !!checked;
    saveShoppingState(st);
    renderShoppingCartList();
}

function onShoppingCartToggleAll(inp) {
    const st = getShoppingState();
    const checked = inp.checked;
    (st.cartItems || []).forEach((c) => {
        c.selected = checked;
    });
    saveShoppingState(st);
    renderShoppingCartList();
}

function changeShoppingCartQty(cartLineId, delta) {
    const st = getShoppingState();
    const line = st.cartItems.find((c) => String(c.cartLineId) === String(cartLineId));
    if (!line) return;
    const q = (line.qty || 1) + delta;
    if (q < 1) {
        st.cartItems = st.cartItems.filter((c) => String(c.cartLineId) !== String(cartLineId));
    } else {
        line.qty = q;
    }
    saveShoppingState(st);
    renderShoppingCartList();
}

function removeShoppingCartLine(cartLineId) {
    const st = getShoppingState();
    st.cartItems = (st.cartItems || []).filter((c) => String(c.cartLineId) !== String(cartLineId));
    saveShoppingState(st);
    renderShoppingCartList();
}

function updateShoppingCartSummary() {
    const st = getShoppingState();
    let total = 0;
    (st.cartItems || []).forEach((c) => {
        if (c.selected !== false) {
            total += (Number(c.price) || 0) * (c.qty || 1);
        }
    });
    total = Math.round(total * 100) / 100;
    const selQty = (st.cartItems || []).reduce((s, c) => {
        if (c.selected === false) return s;
        return s + (c.qty || 1);
    }, 0);
    const totalEl = document.getElementById('shopping-cart-total');
    const numEl = document.getElementById('shopping-cart-settle-num');
    if (totalEl) totalEl.textContent = formatShoppingPrice(total);
    if (numEl) numEl.textContent = String(selQty);
}

// —— 购物订单 / 付款 / 礼物（数据在 shoppingData.orders / shoppingData.giftPool）——
let _shoppingCheckoutCtx = null;
let _shoppingPaySelected = null;
let _shoppingOrderListMode = null;

function cloneShoppingOrderLines(lines) {
    return (lines || []).map((l) => ({
        cartLineId: l.cartLineId,
        productId: l.productId,
        name: l.name,
        imageQuery: l.imageQuery || l.name,
        price: l.price,
        lineStyle: l.lineStyle,
        category: l.category,
        qty: l.qty != null ? l.qty : 1
    }));
}

function computeShoppingLinesTotal(lines) {
    let t = 0;
    (lines || []).forEach((l) => {
        t += (Number(l.price) || 0) * (l.qty != null ? l.qty : 1);
    });
    return Math.round(t * 100) / 100;
}

function shoppingCheckoutHasPayOption(total) {
    if (total <= 0) return false;
    if (getWalletBalance() >= total) return true;
    return getKinshipCards().received.some((c) => c.amount >= total);
}

function closeShoppingCheckoutPayModal() {
    document.getElementById('shopping-checkout-pay-modal')?.classList.remove('show');
    _shoppingCheckoutCtx = null;
    _shoppingPaySelected = null;
}

function selectShoppingPayRow(rowEl, sel) {
    document.querySelectorAll('#shopping-checkout-method-list .payment-method-item').forEach((el) => {
        el.classList.remove('is-selected');
    });
    if (rowEl) rowEl.classList.add('is-selected');
    _shoppingPaySelected = sel;
}

function openShoppingCheckoutPayModal(ctx) {
    _shoppingCheckoutCtx = ctx;
    _shoppingPaySelected = null;
    const modal = document.getElementById('shopping-checkout-pay-modal');
    const totalEl = document.getElementById('shopping-checkout-total-display');
    const list = document.getElementById('shopping-checkout-method-list');
    if (!modal || !list || !ctx || !ctx.lines || ctx.lines.length === 0) return;
    const total = ctx.total;
    if (totalEl) totalEl.textContent = '¥' + total.toFixed(2);
    list.innerHTML = '';

    const walletBal = getWalletBalance();
    const walletOk = walletBal >= total;
    const walletRow = document.createElement('div');
    walletRow.className = 'payment-method-item' + (walletOk ? '' : ' is-disabled');
    walletRow.innerHTML =
        '<span class="payment-method-label">微信零钱</span><span class="payment-method-amount">' +
        (walletOk ? '¥ ' + walletBal.toFixed(2) : '余额不足（¥' + walletBal.toFixed(2) + '）') +
        '</span>';
    if (walletOk) {
        walletRow.addEventListener('click', () => selectShoppingPayRow(walletRow, { type: 'wallet' }));
    }
    list.appendChild(walletRow);

    const received = getKinshipCards().received.filter((c) => c.amount >= total);
    received.forEach((card) => {
        const row = document.createElement('div');
        row.className = 'payment-method-item';
        row.dataset.kinshipCardId = card.id;
        row.innerHTML =
            '<span class="payment-method-label">亲属卡（' +
            escapeHtml(getFriendName(card.fromFriendId)) +
            '）</span><span class="payment-method-amount">¥ ' +
            card.amount.toFixed(2) +
            '</span>';
        row.addEventListener('click', () =>
            selectShoppingPayRow(row, { type: 'kinship', cardId: card.id })
        );
        list.appendChild(row);
    });

    if (walletOk) {
        selectShoppingPayRow(walletRow, { type: 'wallet' });
    } else if (received.length > 0) {
        const firstKinRow = list.querySelector('.payment-method-item[data-kinship-card-id]');
        if (firstKinRow) {
            selectShoppingPayRow(firstKinRow, { type: 'kinship', cardId: received[0].id });
        }
    }

    updateShoppingCheckoutShipInfo();
    modal.classList.add('show');
}

function updateShoppingCheckoutShipInfo() {
    const st = getShoppingState();
    const p = st.profile || {};
    const addr = String(p.address || '').trim();
    const phone = String(p.phone || '').trim();
    const lineAddr = document.getElementById('shopping-checkout-ship-address');
    const linePhone = document.getElementById('shopping-checkout-ship-phone');
    if (lineAddr) {
        lineAddr.textContent = addr
            ? '收货地址：' + addr
            : '收货地址：未填写（可在购物 · 我的中点击昵称旁编辑）';
    }
    if (linePhone) {
        linePhone.textContent = phone ? '联系电话：' + phone : '联系电话：未填写';
    }
}

function onShoppingCheckoutPayCancel() {
    const ctx = _shoppingCheckoutCtx;
    if (!ctx) {
        closeShoppingCheckoutPayModal();
        return;
    }
    if (ctx.mode === 'cart') {
        const st = getShoppingState();
        const lines = cloneShoppingOrderLines(ctx.lines);
        st.orders.push({
            orderId: 'so_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
            status: 'pending_pay',
            lines,
            total: ctx.total,
            createdAt: Date.now()
        });
        const ids = new Set(lines.map((l) => l.cartLineId));
        st.cartItems = (st.cartItems || []).filter((c) => !ids.has(c.cartLineId));
        saveShoppingState(st);
        renderShoppingCartList();
        updateShoppingOrderBadges();
        refreshShoppingOrderListModalBody();
        showNotification('订单已放入待付款');
    }
    closeShoppingCheckoutPayModal();
}

function finalizeShoppingPaySuccess(paymentMethod, kinshipCardId) {
    const ctx = _shoppingCheckoutCtx;
    if (!ctx) return;
    const st = getShoppingState();
    const now = Date.now();
    const linesSnapshot = cloneShoppingOrderLines(ctx.lines);
    if (ctx.mode === 'order') {
        const o = st.orders.find((x) => x.orderId === ctx.orderId);
        if (o) {
            o.status = 'pending_ship';
            o.paidAt = now;
            o.paymentMethod = paymentMethod;
            o.kinshipCardId = kinshipCardId || undefined;
        }
    } else {
        const ids = new Set(ctx.lines.map((l) => l.cartLineId));
        st.cartItems = (st.cartItems || []).filter((c) => !ids.has(c.cartLineId));
        st.orders.push({
            orderId: 'so_' + Date.now() + '_' + Math.random().toString(36).slice(2, 9),
            status: 'pending_ship',
            lines: linesSnapshot,
            total: ctx.total,
            createdAt: now,
            paidAt: now,
            paymentMethod,
            kinshipCardId: kinshipCardId || undefined
        });
    }
    saveShoppingState(st);
    closeShoppingCheckoutPayModal();
    renderShoppingCartList();
    updateShoppingOrderBadges();
    refreshShoppingOrderListModalBody();
    showNotification('支付成功，请在我的 · 待发货中操作发货');
}

function onShoppingCheckoutPayConfirm() {
    if (!_shoppingCheckoutCtx) return;
    const sel = _shoppingPaySelected;
    if (!sel) {
        showNotification('请选择付款方式');
        return;
    }
    const total = _shoppingCheckoutCtx.total;
    if (sel.type === 'wallet') {
        requirePaymentPassword(
            total,
            '购物',
            function () {
                deductFromWallet(total);
                finalizeShoppingPaySuccess('wallet', null);
            },
            function () {}
        );
    } else if (sel.type === 'kinship' && sel.cardId) {
        const ok = useReceivedKinshipCard(sel.cardId, total, '购物', '购物订单');
        if (ok) {
            renderKinshipReceivedList();
            finalizeShoppingPaySuccess('kinship', sel.cardId);
        } else {
            showNotification('亲属卡扣款失败');
        }
    }
}

function shoppingCartCheckout() {
    const st = getShoppingState();
    const sel = (st.cartItems || []).filter((c) => c.selected !== false);
    if (sel.length === 0) {
        showNotification('请先勾选要结算的商品');
        return;
    }
    const lines = cloneShoppingOrderLines(sel);
    const total = computeShoppingLinesTotal(lines);
    if (total <= 0) {
        showNotification('金额异常');
        return;
    }
    openShoppingCheckoutPayModal({ mode: 'cart', orderId: null, lines, total });
}

function updateShoppingOrderBadges() {
    const st = getShoppingState();
    const statuses = [
        ['pending_pay', 'shop-order-badge-pay'],
        ['pending_ship', 'shop-order-badge-ship'],
        ['pending_receive', 'shop-order-badge-receive']
    ];
    statuses.forEach(([status, id]) => {
        const n = (st.orders || []).filter((o) => o.status === status).length;
        const el = document.getElementById(id);
        if (!el) return;
        if (n > 0) {
            el.textContent = n > 99 ? '99+' : String(n);
            el.style.display = '';
        } else {
            el.style.display = 'none';
        }
    });
}

function closeShoppingOrderListModal() {
    document.getElementById('shopping-order-list-modal')?.classList.remove('show');
    _shoppingOrderListMode = null;
}

function refreshShoppingOrderListModalBody() {
    const container = document.getElementById('shopping-order-list-container');
    if (!container || !_shoppingOrderListMode) return;
    const st = getShoppingState();
    const orders = (st.orders || []).filter((o) => o.status === _shoppingOrderListMode);
    if (orders.length === 0) {
        container.innerHTML = '<p class="shopping-order-empty">暂无订单</p>';
        return;
    }
    container.innerHTML = orders.map((o) => renderShoppingOrderCardHtml(o)).join('');
}

function renderShoppingOrderCardHtml(o) {
    const linesHtml = o.lines
        .map((l) => {
            const name = escapeHtml(l.name);
            return (
                '<div class="shopping-order-line">' +
                name +
                ' ×' +
                (l.qty != null ? l.qty : 1) +
                ' · ' +
                formatShoppingPrice(l.price) +
                '</div>'
            );
        })
        .join('');
    let action = '';
    if (o.status === 'pending_pay') {
        action =
            '<button type="button" class="shopping-order-action-btn" onclick="payShoppingPendingOrder(\'' +
            String(o.orderId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
            '\')">去付款</button>';
    } else if (o.status === 'pending_ship') {
        action =
            '<button type="button" class="shopping-order-action-btn" onclick="shipShoppingOrder(\'' +
            String(o.orderId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
            '\')">发货</button>';
    } else if (o.status === 'pending_receive') {
        action =
            '<button type="button" class="shopping-order-action-btn" onclick="confirmReceiveShoppingOrder(\'' +
            String(o.orderId).replace(/\\/g, '\\\\').replace(/'/g, "\\'") +
            '\')">确认收货</button>';
    }
    return (
        '<div class="shopping-order-card">' +
        '<div class="shopping-order-lines">' +
        linesHtml +
        '</div><div class="shopping-order-footer"><span class="shopping-order-total">合计 ' +
        formatShoppingPrice(o.total) +
        '</span>' +
        action +
        '</div></div>'
    );
}

function openShoppingOrderListModal(mode) {
    if (!['pending_pay', 'pending_ship', 'pending_receive'].includes(mode)) return;
    _shoppingOrderListMode = mode;
    const modal = document.getElementById('shopping-order-list-modal');
    const title = document.getElementById('shopping-order-list-title');
    const titles = { pending_pay: '待付款', pending_ship: '待发货', pending_receive: '待收货' };
    if (title) title.textContent = titles[mode] || '订单';
    refreshShoppingOrderListModalBody();
    modal?.classList.add('show');
}

function payShoppingPendingOrder(orderId) {
    const st = getShoppingState();
    const o = st.orders.find((x) => x.orderId === orderId && x.status === 'pending_pay');
    if (!o) return;
    if (!shoppingCheckoutHasPayOption(o.total)) {
        showNotification('余额不足且没有可用亲属卡');
        return;
    }
    openShoppingCheckoutPayModal({
        mode: 'order',
        orderId: o.orderId,
        lines: o.lines,
        total: o.total
    });
}

function appendShoppingGiftsToPoolFromOrder(st, order) {
    if (!st || !order) return;
    if (!Array.isArray(st.giftPool)) st.giftPool = [];
    const now = Date.now();
    for (let i = 0; i < order.lines.length; i++) {
        const line = order.lines[i] || {};
        const qty = line.qty != null ? line.qty : 1;
        if (qty <= 0) continue;
        st.giftPool.push({
            id: 'gp_' + now + '_' + i + '_' + Math.random().toString(36).slice(2, 9),
            orderId: order.orderId,
            name: String(line.name || '').slice(0, 160),
            imageQuery: String(line.imageQuery || line.name || '').slice(0, 80),
            price: Number(line.price) || 0,
            lineStyle: line.lineStyle,
            qty: qty,
            category: line.category || '',
            stockedAt: now
        });
    }
}

function shipShoppingOrder(orderId) {
    const st = getShoppingState();
    const o = st.orders.find((x) => x.orderId === orderId && x.status === 'pending_ship');
    if (!o) return;
    // 注意：必须在同一个 st 上写入 giftPool，并只保存一次；否则会被后续 save 覆盖导致礼物丢失
    appendShoppingGiftsToPoolFromOrder(st, o);
    const now = Date.now();
    o.status = 'pending_receive';
    o.shippedAt = now;
    o.shipMode = 'gift_pool';
    saveShoppingState(st);
    updateShoppingOrderBadges();
    refreshShoppingOrderListModalBody();
    showNotification(
        '已发货：礼物已进入库存，在任意聊天「更多 · 礼物」中都可送出；送出后礼物库存会扣减'
    );
}

function confirmReceiveShoppingOrder(orderId) {
    const st = getShoppingState();
    const o = st.orders.find((x) => x.orderId === orderId && x.status === 'pending_receive');
    if (!o) return;
    o.status = 'completed';
    o.completedAt = Date.now();
    saveShoppingState(st);
    updateShoppingOrderBadges();
    refreshShoppingOrderListModalBody();
    showNotification('已确认收货');
}

function openChatGiftShelf() {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('请先打开与好友的聊天');
        return;
    }
    const st = getShoppingState();
    const gifts = Array.isArray(st.giftPool) ? st.giftPool : [];
    const modal = document.getElementById('chat-gift-shelf-modal');
    const list = document.getElementById('chat-gift-shelf-list');
    const nameEl = document.getElementById('chat-gift-shelf-friend-name');
    const mergeBtn = document.getElementById('chat-gift-merge-send-btn');
    if (!modal || !list) return;
    if (nameEl) nameEl.textContent = getFriendName(friendId);
    if (mergeBtn) mergeBtn.style.display = gifts.length ? '' : 'none';
    if (gifts.length === 0) {
        list.innerHTML = '<p class="chat-gift-empty">暂无可送出的购物礼物：先在购物 · 待发货中点击发货，礼物会进入库存</p>';
    } else {
        list.innerHTML = gifts
            .map((g) => {
                const gid = String(g.id || '').replace(/\\/g, '\\\\').replace(/'/g, "\\'");
                const gidAttr = String(g.id || '')
                    .replace(/&/g, '&amp;')
                    .replace(/"/g, '&quot;');
                return (
                    '<div class="chat-gift-item">' +
                    '<label class="chat-gift-check">' +
                    '<input type="checkbox" class="chat-gift-select-cb" value="' +
                    gidAttr +
                    '">' +
                    '</label>' +
                    shoppingProductThumbHtml(g.imageQuery || g.name, g.category, g.lineStyle, 'shopping-line-art--thumb') +
                    '<div class="chat-gift-item-info">' +
                    '<div class="chat-gift-item-name">' +
                    escapeHtml(g.name) +
                    '</div>' +
                    '<div class="chat-gift-item-meta">' +
                    escapeHtml(g.category || '') +
                    ' · ×' +
                    (g.qty != null ? g.qty : 1) +
                    ' · ' +
                    formatShoppingPrice(g.price) +
                    '</div>' +
                    '</div>' +
                    '<button type="button" class="chat-gift-send-btn" onclick="sendGiftFromPoolToCurrentFriend(\'' +
                    gid +
                    '\')">送出</button>' +
                    '</div>'
                );
            })
            .join('');
    }
    modal.classList.add('show');
}

function closeChatGiftShelfModal() {
    document.getElementById('chat-gift-shelf-modal')?.classList.remove('show');
}

function sendGiftPoolItemsToChatAsBundle(friendId, giftIds) {
    if (!friendId || !Array.isArray(giftIds) || giftIds.length === 0) return;
    const st = getShoppingState();
    const pool = Array.isArray(st.giftPool) ? st.giftPool : [];
    const taken = [];
    giftIds.forEach((id) => {
        const g = pool.find((x) => String(x.id) === String(id));
        if (g) { try { taken.push(JSON.parse(JSON.stringify(g))); } catch (e) {} }
    });
    if (taken.length === 0) {
        showNotification('所选礼物不存在或已送出');
        openChatGiftShelf();
        return;
    }
    const idSet = new Set(taken.map((t) => String(t.id)));
    st.giftPool = pool.filter((x) => !idSet.has(String(x.id)));
    saveShoppingState(st);

    const giftItems = taken.map((t) => ({
        id: t.id,
        name: t.name,
        qty: t.qty != null ? t.qty : 1,
        price: t.price,
        category: t.category || '',
        orderId: t.orderId || ''
    }));
    const totalQty = giftItems.reduce((s, it) => s + (it.qty != null ? it.qty : 1), 0);
    const kindCount = giftItems.length;
    const summary = giftItems.map((it) => `${it.name}×${it.qty != null ? it.qty : 1}`).join('、');
    let content = '[礼物包裹] ' + summary;
    if (content.length > 480) content = content.slice(0, 477) + '…';
    const ts = Date.now();
    saveChatMessage(friendId, 'user', content, null, ts, 'gift_bundle', null, {
        giftStatus: 'pending_receive',
        giftItems,
        giftTotalQty: totalQty,
        giftKindCount: kindCount
    });
    const cur = document.getElementById('chat-page') && document.getElementById('chat-page').dataset.friendId;
    if (cur != null && String(cur) === String(friendId)) {
        displayMessage(
            'user',
            content,
            null,
            ts,
            friendId,
            'gift_bundle',
            null,
            'pending_receive',
            totalQty,
            kindCount
        );
        scrollChatContentToBottom();
    }
    closeChatGiftShelfModal();
    showNotification('礼盒已发到聊天，点击「接收」或聊天栏「接收」听对方反应');
}

function sendMergedSelectedGiftsFromPool() {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('请先打开与好友的聊天');
        return;
    }
    const modal = document.getElementById('chat-gift-shelf-modal');
    const checked = modal ? modal.querySelectorAll('.chat-gift-select-cb:checked') : [];
    const ids = Array.from(checked).map((cb) => cb.value);
    if (ids.length === 0) {
        showNotification('请勾选要放进同一礼盒的礼物');
        return;
    }
    sendGiftPoolItemsToChatAsBundle(friendId, ids);
}

function sendGiftFromPoolToCurrentFriend(giftId) {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('请先打开与好友的聊天');
        return;
    }
    sendGiftPoolItemsToChatAsBundle(friendId, [giftId]);
}

function syncShoppingProfileUI() {
    const st = getShoppingState();
    const nick = (st.profile && st.profile.nickname) || '可点击编辑';
    const btn = document.getElementById('shop-profile-nick-btn');
    const ph = document.getElementById('shop-profile-avatar-ph');
    const img = document.getElementById('shop-profile-avatar-img');
    const avatarUrl = (st.profile && st.profile.avatarDataUrl) || '';
    if (btn) btn.textContent = nick;
    if (avatarUrl && img) {
        img.src = avatarUrl;
        img.style.display = '';
        if (ph) ph.style.display = 'none';
    } else if (img) {
        img.removeAttribute('src');
        img.style.display = 'none';
        if (ph) {
            ph.style.display = '';
            const ch = nick.trim().charAt(0) || '我';
            ph.textContent = ch;
        }
    } else if (ph) {
        const ch = nick.trim().charAt(0) || '我';
        ph.textContent = ch;
    }
    updateShoppingOrderBadges();
}

let _shoppingProfileEditorAvatarDraft = '';

function openShoppingProfileEditor() {
    const st = getShoppingState();
    const p = st.profile || {};
    _shoppingProfileEditorAvatarDraft =
        typeof p.avatarDataUrl === 'string' ? p.avatarDataUrl : '';

    const nickInp = document.getElementById('shopping-profile-nickname-input');
    const addrInp = document.getElementById('shopping-profile-address-input');
    const phoneInp = document.getElementById('shopping-profile-phone-input');
    const fileInp = document.getElementById('shopping-profile-avatar-file');
    if (nickInp) nickInp.value = p.nickname || '可点击编辑';
    if (addrInp) addrInp.value = p.address || '';
    if (phoneInp) phoneInp.value = p.phone || '';
    if (fileInp) fileInp.value = '';

    shoppingProfileEditorRefreshAvatarPreview();
    document.getElementById('shopping-profile-edit-modal')?.classList.add('show');
}

function shoppingProfileEditorRefreshAvatarPreview() {
    const prev = document.getElementById('shopping-profile-avatar-preview');
    const placeholder = document.getElementById('shopping-profile-avatar-preview-ph');
    if (!prev || !placeholder) return;
    const d = _shoppingProfileEditorAvatarDraft;
    if (d) {
        prev.src = d;
        prev.style.display = '';
        placeholder.style.display = 'none';
    } else {
        prev.removeAttribute('src');
        prev.style.display = 'none';
        placeholder.style.display = '';
    }
}

function onShoppingProfileAvatarFileChange(input) {
    const f = input && input.files && input.files[0];
    if (!f) return;
    if (!f.type || !isLegoUploadableRasterImageFile(f)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        input.value = '';
        return;
    }
    if (f.size > 400 * 1024) {
        showNotification('图片请小于 400KB');
        input.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function () {
        const url = String(reader.result || '');
        if (url.length > 650000) {
            showNotification('图片过大，未能保存');
            input.value = '';
            return;
        }
        _shoppingProfileEditorAvatarDraft = url;
        shoppingProfileEditorRefreshAvatarPreview();
    };
    reader.readAsDataURL(f);
}

function shoppingProfileEditorClearAvatar() {
    _shoppingProfileEditorAvatarDraft = '';
    const fileInp = document.getElementById('shopping-profile-avatar-file');
    if (fileInp) fileInp.value = '';
    shoppingProfileEditorRefreshAvatarPreview();
}

function cancelShoppingProfileEditor() {
    document.getElementById('shopping-profile-edit-modal')?.classList.remove('show');
    _shoppingProfileEditorAvatarDraft = '';
}

function saveShoppingProfileEditor() {
    const st = getShoppingState();
    st.profile = st.profile || {};
    const nickInp = document.getElementById('shopping-profile-nickname-input');
    const addrInp = document.getElementById('shopping-profile-address-input');
    const phoneInp = document.getElementById('shopping-profile-phone-input');
    st.profile.nickname =
        String((nickInp && nickInp.value) || '')
            .trim()
            .slice(0, 24) || '可点击编辑';
    st.profile.address = String((addrInp && addrInp.value) || '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, 500);
    st.profile.phone = String((phoneInp && phoneInp.value) || '')
        .replace(/\u0000/g, '')
        .trim()
        .slice(0, 32);
    st.profile.avatarDataUrl =
        typeof _shoppingProfileEditorAvatarDraft === 'string'
            ? _shoppingProfileEditorAvatarDraft
            : '';
    if (st.profile.avatarDataUrl.length > 650000) st.profile.avatarDataUrl = '';
    const ok = saveShoppingState(st);
    if (!ok) return;
    syncShoppingProfileUI();
    document.getElementById('shopping-profile-edit-modal')?.classList.remove('show');
    _shoppingProfileEditorAvatarDraft = '';
    showNotification('资料已保存');
}

function editShoppingProfileNickname() {
    openShoppingProfileEditor();
}

function selectShoppingCategory(cat) {
    if (!SHOPPING_CATEGORIES.includes(cat)) return;
    const st = getShoppingState();
    st.currentCategory = cat;
    saveShoppingState(st);
    document.querySelectorAll('.shopping-cat-pill').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-cat') === cat);
    });
    renderShoppingProductGrid();
}

function syncShoppingUIFromState() {
    const st = getShoppingState();
    const inp = document.getElementById('shopping-search-input');
    if (inp) inp.value = st.searchKeyword || '';
    document.querySelectorAll('.shopping-cat-pill').forEach((b) => {
        b.classList.toggle('is-active', b.getAttribute('data-cat') === st.currentCategory);
    });
    renderShoppingProductGrid();
}

function initShoppingPage() {
    const strip = document.getElementById('shopping-category-strip');
    if (!window.__shoppingEventsBound) {
        window.__shoppingEventsBound = true;
        strip?.addEventListener('click', function (e) {
            const btn = e.target.closest('.shopping-cat-pill');
            if (!btn) return;
            selectShoppingCategory(btn.getAttribute('data-cat'));
        });
        strip?.addEventListener(
            'wheel',
            function (e) {
                if (!strip || Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
                e.preventDefault();
                strip.scrollLeft += e.deltaY;
            },
            { passive: false }
        );
        let drag = false;
        let startX = 0;
        let startScroll = 0;
        strip?.addEventListener('mousedown', function (e) {
            if (e.button !== 0) return;
            drag = true;
            startX = e.clientX;
            startScroll = strip.scrollLeft;
        });
        window.addEventListener('mouseup', function () {
            drag = false;
        });
        window.addEventListener('mousemove', function (e) {
            if (!drag || !strip) return;
            e.preventDefault();
            strip.scrollLeft = startScroll - (e.clientX - startX);
        });
        document.getElementById('shopping-search-input')?.addEventListener('keydown', function (e) {
            if (e.key === 'Enter') {
                e.preventDefault();
                refreshShoppingProducts();
            }
        });
    }
    const st = getShoppingState();
    applyShoppingTabUI(st.shoppingTab || 'home');
    syncShoppingUIFromState();
    renderShoppingCartList();
    syncShoppingProfileUI();
    updateShoppingCartBadge();
}

async function refreshShoppingProducts() {
    const st = getShoppingState();
    const inp = document.getElementById('shopping-search-input');
    const keyword = sanitizeShoppingKeyword(inp ? inp.value : '');
    st.searchKeyword = keyword;
    saveShoppingState(st);

    const cmdBlock = FeatureCommandMapper.getCommandsByFeature('shopping')
        .map((c) => c.content)
        .join('\n');
    const task = buildShoppingApiTask(st.currentCategory, keyword);
    const full = cmdBlock ? cmdBlock + '\n\n' + task : task;

    const overlay = document.getElementById('shopping-loading-overlay');
    try {
        if (overlay) overlay.classList.add('show');
        const raw = await FeatureCommandMapper.callApiModel(full, null, { skipOverlay: true });
        if (!raw) return;
        const data = extractJsonObjectFromApiText(raw);
        if (!data || !Array.isArray(data.products)) {
            showNotification('未能解析商品 JSON');
            return;
        }
        const products = normalizeShoppingProducts(data.products);
        if (products.length === 0) {
            showNotification('未得到有效商品');
            return;
        }
        st.productsByCategory = st.productsByCategory || {};
        st.productsByCategory[st.currentCategory] = products;
        saveShoppingState(st);
        renderShoppingProductGrid();
        showNotification('已刷新「' + st.currentCategory + '」商品');
    } finally {
        if (overlay) overlay.classList.remove('show');
    }
}

// 收集手机系统信息
function collectPhoneSystemData() {
    try {
        const phoneSystemData = localStorage.getItem('phoneSystemData');
        return phoneSystemData ? JSON.parse(phoneSystemData) : {};
    } catch (e) {
        console.error('收集手机系统信息失败:', e);
        return {};
    }
}

// 收集推特数据
function collectTwitterData() {
    // 仅导出推特「我的个人资料」里与账号相关的部分：头像/背景图等静态资产
    // 不导出时间轴/推文动态流缓存，避免把推特板块内容打包进备份
    // 资料读取经 Twitter.store.loadTwitterProfile（与 UI/持久化同一来源）
    try {
        const p = (Twitter.store && typeof Twitter.store.loadTwitterProfile === 'function'
            ? Twitter.store.loadTwitterProfile()
            : null) || {};
        return {
            // 账号基础信息（不含推文/时间轴）
            displayName: p.displayName || '',
            handle: p.handle || '',
            bio: p.bio || '',
            // 静态资产：头像与背景（banner）
            avatarDataUrl: p.avatarDataUrl || '',
            bannerDataUrl: p.bannerDataUrl || '',
            bannerColor: p.bannerColor || ''
        };
    } catch (e) {
        console.error('收集推特数据失败:', e);
        return {};
    }
}

// 收集主界面主卡片数据
function collectMainCardData() {
    try {
        const userAvatar = localStorage.getItem('userAvatar');
        const backgroundImage = localStorage.getItem('backgroundImage');
        const data = {
            userAvatar: userAvatar,
            backgroundImage: backgroundImage
        };
        const textPayload = readMainCardTextPayload();
        if (textPayload) data.text = textPayload;
        return data;
    } catch (e) {
        console.error('收集主界面主卡片数据失败:', e);
        return {};
    }
}

// 收集音乐播放器数据（含音频base64）
function collectMusicData() {
    return new Promise(async (resolve) => {
        try {
            const cover = MusicPlayer.customCover || localStorage.getItem('musicPlayerCover') || '';
            const playlist = MusicPlayer.playlist || [];
            const list = [];
            for (let i = 0; i < playlist.length; i++) {
                const t = playlist[i];
                const item = {
                    id: t.id,
                    title: t.title,
                    artist: t.artist,
                    album: t.album || '',
                    lyrics: t.lyrics || '',
                    cover: t.cover || null,
                    remoteId: t.remoteId || '',
                    remoteSource: t.remoteSource || '',
                    cachedAt: Number(t.cachedAt) || 0,
                    localFileKey: t.localFileKey || '',
                    byteSize: Number(t.byteSize) || (t.blob && Number(t.blob.size)) || 0
                };
                if (t.blob) {
                    try {
                        item.audioBase64 = await blobToBase64(t.blob);
                    } catch (e) {
                        item.fileMissing = true;
                    }
                } else if (t.fileMissing) {
                    item.fileMissing = true;
                }
                list.push(item);
            }
            resolve({ playlist: list, cover });
        } catch (e) {
            console.error('收集音乐播放器数据失败:', e);
            resolve({});
        }
    });
}

function blobToBase64(blob) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
            const base64 = reader.result.split(',')[1];
            resolve(base64 || '');
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
    });
}

function base64ToBlob(base64, mimeType) {
    const byteChars = atob(base64);
    const byteNumbers = new Array(byteChars.length);
    for (let i = 0; i < byteChars.length; i++) {
        byteNumbers[i] = byteChars.charCodeAt(i);
    }
    const byteArray = new Uint8Array(byteNumbers);
    return new Blob([byteArray], { type: mimeType || 'audio/mpeg' });
}

// 收集系统指令
// 系统指令不再导出（绑定在系统目录文件中，用户无需备份）
function collectSystemCommands() {
    return [];
}

// 微信表情导出收集：见 wechat-backup.js（Wechat.backup.collectEmojiData）

// 收集用户个人人设信息
function collectUserProfileData() {
    try {
        const myProfile = localStorage.getItem('myProfile');
        return myProfile ? JSON.parse(myProfile) : {};
    } catch (e) {
        console.error('收集用户个人人设信息失败:', e);
        return {};
    }
}

// 打开清空所有数据确认框
function openClearAllDataConfirm() {
    const modal = document.getElementById('clear-all-data-confirm-modal');
    if (modal) modal.classList.add('show');
}

// 取消清空所有数据
function cancelClearAllData() {
    const modal = document.getElementById('clear-all-data-confirm-modal');
    if (modal) modal.classList.remove('show');
}

// 执行清空所有数据
async function executeClearAllData() {
    if (window.LegoMilianTarot) {
        try { await window.LegoMilianTarot.clearAllData(); }
        catch (error) { showNotification('塔罗数据清理失败，请重试后再清空全部数据'); return; }
    }
    if (window.LegoDesktop) {
        try { window.LegoDesktop.clearData(); }
        catch (error) { showNotification('桌面数据清理失败，请检查浏览器存储权限后重试'); return; }
    }
    if (window.Wechat && Wechat.proactive) Wechat.proactive.reset();
    const modal = document.getElementById('clear-all-data-confirm-modal');
    if (modal) modal.classList.remove('show');

    // 必须先丢弃内存中的聊天记录与待落盘任务，否则 beforeunload 里 flushAllChatHistoryPendingSync 会把旧聊天写回 localStorage
    try {
        if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.discardWechatPendingPersistence === 'function') {
            Wechat.store.discardWechatPendingPersistence();
        } else if (typeof clearChatHistoryMemCache === 'function') {
            clearChatHistoryMemCache();
        }
    } catch (e) {}

    const chunkedKeysFirst = [
        'themeSettings', 'backgroundImage', 'userAvatar', MUSIC_PLAYER_COVER_LS_KEY,
        'friends', FRIENDS_LS_KEY + '_backup', 'momentsPosts', 'wechatFavorites',
        'emojiData', 'emojiCategories', 'wechatData', 'userInfo', 'myProfile',
        'worldBookData'
    ];
    chunkedKeysFirst.forEach((k) => {
        try { clearChunkedStorage(k); } catch (e) {}
    });

    const keysToRemove = [
        'apiSettings', 'apiPresets', 'voiceSettings', 'worldBookData', 'themeSettings',
        'wechatData', 'friends', 'myProfile', 'userInfo',
        'wechatFavorites', 'momentsPosts', 'momentsCoverImageDataUrl', 'walletBalance', 'walletPaymentPassword', 'kinshipCards',
        'shoppingData', 'phoneSystemData', 'twitterData',
        'userAvatar', 'backgroundImage', 'mainCardText',
        'legoDesktopNoteV1', 'legoDesktopMemoV1', 'legoDesktopPhotoV1',
        'musicPlaylist', 'musicPlaylistMeta', 'musicCover', 'musicPlayerCover',
        'systemCommands', 'emojiData', 'emojiCategories',
        'wechatCoupleSpaceStateV1'
    ];
    keysToRemove.forEach(k => localStorage.removeItem(k));
    try {
        if (typeof Wechat !== 'undefined' && Wechat.store && Wechat.store.coupleSpace && typeof Wechat.store.coupleSpace.invalidateMemCache === 'function') {
            Wechat.store.coupleSpace.invalidateMemCache();
        }
    } catch (e) {}

    try {
        if (typeof Wechat !== 'undefined' && Wechat.backup && typeof Wechat.backup.clearPerChatExtensionStorage === 'function') {
            Wechat.backup.clearPerChatExtensionStorage();
        }
    } catch (e) {}

    try {
        const chatBaseSeen = Object.create(null);
        Object.keys(localStorage).forEach((key) => {
            if (!key.startsWith('chatHistory_')) return;
            const sepAt = key.indexOf(LS_CHUNK_SEP);
            const base = sepAt !== -1 ? key.slice(0, sepAt) : key;
            if (chatBaseSeen[base]) return;
            chatBaseSeen[base] = true;
            try { clearChunkedStorage(base); } catch (e) {}
        });
        Object.keys(localStorage).forEach((key) => {
            if (key.startsWith('chatHistory_')) {
                try { localStorage.removeItem(key); } catch (e) {}
            }
        });
    } catch (e) {}

    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('chatBackground_')) localStorage.removeItem(key);
    });

    Object.keys(localStorage).forEach(key => {
        if (key.startsWith('readTogether_')) localStorage.removeItem(key);
    });

    try {
        const extraPrefixes = [
            'chatBackground_', 'readTogether_',
            'offlineModeSettings_', 'offlineFloatPos_', 'chatSummaryDraft_',
            'chatSummaryLastDoneRounds_', 'chatLongMemories_'
        ];
        const extraExact = new Set(['offlineWritingStyles', 'chatSummaryPrompts']);
        const seenChunkBase = Object.create(null);
        Object.keys(localStorage).forEach((key) => {
            if (extraExact.has(key)) {
                try { clearChunkedStorage(key); } catch (e) {}
                try { localStorage.removeItem(key); } catch (e) {}
                return;
            }
            let hit = false;
            for (let i = 0; i < extraPrefixes.length; i++) {
                if (key.indexOf(extraPrefixes[i]) === 0) {
                    hit = true;
                    break;
                }
            }
            if (!hit) return;
            const sepAt = key.indexOf(LS_CHUNK_SEP);
            const base = sepAt !== -1 ? key.slice(0, sepAt) : key;
            if (seenChunkBase[base]) return;
            seenChunkBase[base] = true;
            try { clearChunkedStorage(base); } catch (e) {}
        });
        Object.keys(localStorage).forEach((key) => {
            if (extraExact.has(key)) {
                try { localStorage.removeItem(key); } catch (e) {}
                return;
            }
            for (let i = 0; i < extraPrefixes.length; i++) {
                if (key.indexOf(extraPrefixes[i]) === 0) {
                    try { localStorage.removeItem(key); } catch (e) {}
                    return;
                }
            }
        });
    } catch (e) {}

    try {
        if (typeof Wechat !== 'undefined' && Wechat.store && typeof Wechat.store.clearEntireWechatKvStore === 'function') {
            await Wechat.store.clearEntireWechatKvStore();
        } else {
            await clearIndexedDBKeys([
                FRIENDS_LS_KEY,
                MOMENTS_POSTS_LS_KEY,
                EMOJI_DATA_LS_KEY,
                EMOJI_CATEGORIES_LS_KEY,
                WECHAT_FAVORITES_LS_KEY,
                USER_INFO_LS_KEY,
                MY_PROFILE_LS_KEY,
                WECHAT_DATA_LS_KEY
            ]);
        }
    } catch (e) {}

    try {
        if (typeof mergeSystemDefaultsSave === 'function' && typeof saveFriendsToStorage === 'function') {
            saveFriendsToStorage(mergeSystemDefaultsSave([]));
        }
    } catch (e) {
        console.warn('[清除全部数据] 写回纯净系统好友失败:', e);
    }

    showNotification('数据已全部清除完毕');
    if (typeof navigateTo === 'function') navigateTo('home');
    setTimeout(() => location.reload(), 1500);
}

// 清空API Key
function clearApiKey() {
    const apiKeyInput = document.getElementById('api-key');
    apiKeyInput.value = '';
    markApiSettingsFormDirty();
    checkApiInputs();
}

// 打开保存预设对话框
function openSavePresetDialog() {
    document.getElementById('save-preset-modal').classList.add('show');
    document.getElementById('preset-name').value = '';
    document.getElementById('preset-name-error').textContent = '';
}

// 关闭保存预设对话框
function closeSavePresetDialog() {
    document.getElementById('save-preset-modal').classList.remove('show');
}

// 验证预设名称
function validatePresetName(name) {
    if (!name || name.trim() === '') {
        return '预设名称不能为空';
    }
    
    if (name.length > 20) {
        return '预设名称不能超过20个字符';
    }
    
    // 检查预设名称是否重复
    const presets = getPresets();
    if (presets.some(preset => preset.name === name.trim())) {
        return '预设名称已存在';
    }
    
    return null;
}

const API_FLOATING_BALL_STORAGE_KEY = 'apiFloatingBallEnabled';
const API_FLOATING_BALL_IDLE_MS = 4500;
const API_FLOATING_BALL_POSITION_KEY = 'apiFloatingBallPosition';
const API_FLOATING_BALL_DRAG_HOLD_MS = 320;
let apiFloatingBallIdleTimer = null;
let apiFloatingBallPressTimer = null;
let apiFloatingBallDragging = false;
let apiFloatingBallMoved = false;
let apiFloatingBallPointerId = null;

// 获取所有预设
function getPresets() {
    try {
        const presets = localStorage.getItem('apiPresets');
        return presets ? JSON.parse(presets) : [];
    } catch (e) {
        console.error('获取预设失败:', e);
        return [];
    }
}

function getApiFloatingBallEnabled() {
    return localStorage.getItem(API_FLOATING_BALL_STORAGE_KEY) === 'true';
}

function setApiFloatingBallEnabled(enabled) {
    localStorage.setItem(API_FLOATING_BALL_STORAGE_KEY, enabled ? 'true' : 'false');
}

function getApiFloatingBallSavedPosition() {
    try {
        const raw = localStorage.getItem(API_FLOATING_BALL_POSITION_KEY);
        if (!raw) return null;
        const pos = JSON.parse(raw);
        if (!pos || typeof pos.x !== 'number' || typeof pos.y !== 'number') return null;
        return pos;
    } catch (e) {
        return null;
    }
}

function saveApiFloatingBallPosition(ball) {
    const bounds = clampApiFloatingBallPosition(Infinity, Infinity, ball);
    const x = (ball.offsetLeft - 8) / Math.max(1, bounds.x - 8);
    const y = (ball.offsetTop - 8) / Math.max(1, bounds.y - 8);
    localStorage.setItem(API_FLOATING_BALL_POSITION_KEY, JSON.stringify({ x, y, relative: true }));
}

function clampApiFloatingBallPosition(x, y, ball) {
    const size = ball ? ball.offsetWidth || 46 : 46;
    const minX = 8;
    const minY = 8;
    const maxX = Math.max(minX, ball.parentElement.clientWidth - size - 8);
    const maxY = Math.max(minY, ball.parentElement.clientHeight - ball.offsetHeight - 8);
    return {
        x: Math.min(Math.max(x, minX), maxX),
        y: Math.min(Math.max(y, minY), maxY)
    };
}

function applyApiFloatingBallPosition(pos) {
    const ball = document.getElementById('api-floating-ball');
    if (!ball) return;
    const bounds = clampApiFloatingBallPosition(Infinity, Infinity, ball);
    const frame = ball.parentElement.getBoundingClientRect();
    const x = !pos ? bounds.x - 6 : pos.relative ? 8 + pos.x * (bounds.x - 8) : pos.x - frame.left;
    const y = !pos ? 112 : pos.relative ? 8 + pos.y * (bounds.y - 8) : pos.y - frame.top;
    const finalPos = clampApiFloatingBallPosition(x, y, ball);
    ball.style.left = `${finalPos.x}px`;
    ball.style.top = `${finalPos.y}px`;
    ball.style.right = 'auto';
}

function updateApiFloatingBallVisibility() {
    const ball = document.getElementById('api-floating-ball');
    const toggle = document.getElementById('api-floating-ball-toggle');
    const enabled = getApiFloatingBallEnabled();
    if (toggle) toggle.checked = enabled;
    if (!ball) return;
    ball.classList.toggle('show', enabled);
    ball.classList.remove('idle');
    if (!enabled) {
        if (apiFloatingBallIdleTimer) clearTimeout(apiFloatingBallIdleTimer);
        return;
    }
    applyApiFloatingBallPosition(getApiFloatingBallSavedPosition());
    resetApiFloatingBallIdle();
}

function resetApiFloatingBallIdle() {
    const ball = document.getElementById('api-floating-ball');
    if (!ball || !ball.classList.contains('show')) return;
    ball.classList.remove('idle');
    if (apiFloatingBallIdleTimer) clearTimeout(apiFloatingBallIdleTimer);
    apiFloatingBallIdleTimer = setTimeout(() => {
        const latestBall = document.getElementById('api-floating-ball');
        if (latestBall && latestBall.classList.contains('show') && !apiFloatingBallDragging) {
            latestBall.classList.add('idle');
        }
    }, API_FLOATING_BALL_IDLE_MS);
}

function fillFloatingPresetSelect() {
    const select = document.getElementById('floating-api-preset-select');
    if (!select) return;
    const presets = getPresets();
    const currentValue = select.value;
    select.innerHTML = '<option value="">不使用预设</option>';
    presets.forEach(preset => {
        const option = document.createElement('option');
        option.value = preset.name;
        option.textContent = preset.name;
        select.appendChild(option);
    });
    select.value = presets.some(p => p.name === currentValue) ? currentValue : '';
}

function syncFloatingApiSettingsFromStorage(options) {
    options = options || {};
    fillFloatingPresetSelect();
    const settings = readApiSettingsFromStorage();
    if (options.syncForm === false) return;
    const apiUrlInput = document.getElementById('floating-api-url');
    const apiKeyInput = document.getElementById('floating-api-key');
    const modelInput = document.getElementById('floating-model-name');
    const modelsList = document.getElementById('floating-models-list');
    if (apiUrlInput) apiUrlInput.value = settings.apiUrl || '';
    if (apiKeyInput) apiKeyInput.value = settings.apiKey || '';
    if (modelInput) modelInput.value = settings.model || '';
    if (modelsList) modelsList.innerHTML = '';
    const presetSelect = document.getElementById('floating-api-preset-select');
    if (presetSelect) presetSelect.value = '';
}

function applyPresetToFloatingSettings(presetName) {
    if (!presetName) return;
    const preset = getPresets().find(p => p.name === presetName);
    if (!preset) return;
    const apiUrlInput = document.getElementById('floating-api-url');
    const apiKeyInput = document.getElementById('floating-api-key');
    if (apiUrlInput) apiUrlInput.value = preset.apiUrl || '';
    if (apiKeyInput) {
        try {
            apiKeyInput.value = atob(preset.apiKey || '');
        } catch (e) {
            apiKeyInput.value = '';
        }
    }
}

function openApiFloatingSettingsModal() {
    const modal = document.getElementById('api-floating-settings-modal');
    if (!modal) return;
    syncFloatingApiSettingsFromStorage();
    modal.classList.add('show');
    resetApiFloatingBallIdle();
}

function closeApiFloatingSettingsModal() {
    const modal = document.getElementById('api-floating-settings-modal');
    if (modal) modal.classList.remove('show');
    resetApiFloatingBallIdle();
}

function renderFloatingModels(models) {
    const modelsList = document.getElementById('floating-models-list');
    if (!modelsList) return;
    modelsList.innerHTML = '';
    models.forEach(model => {
        const modelItem = document.createElement('div');
        modelItem.className = 'model-item';
        modelItem.textContent = model;
        modelItem.onclick = () => {
            const modelInput = document.getElementById('floating-model-name');
            if (modelInput) modelInput.value = model;
            modelsList.innerHTML = '';
            showNotification('模型选择成功');
        };
        modelsList.appendChild(modelItem);
    });
}

const modelListRequests = new Map();

function parseModelList(data) {
    const entries = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data
        : data && Array.isArray(data.models) ? data.models : null;
    if (!entries) throw Object.assign(new Error('上游未返回可识别的模型列表，请核对 API 地址是否提供 /v1/models。'), { code: 'INVALID_MODEL_LIST' });
    const models = Array.from(new Set(entries.map(function (item) {
        if (typeof item === 'string') return item.trim();
        if (!item || typeof item !== 'object') return '';
        return typeof item.id === 'string' && item.id.trim() ? item.id.trim()
            : typeof item.name === 'string' ? item.name.trim() : '';
    }).filter(Boolean)));
    if (!models.length) throw Object.assign(new Error('上游返回的模型列表为空，请检查该密钥的模型权限或分组。'), { code: 'EMPTY_MODEL_LIST' });
    return models;
}

function modelListErrorFromResponse(response, data, proxied) {
    const payload = data && typeof data === 'object' ? data : {};
    const source = response.headers.get('X-Lego-Proxy-Source');
    const local = proxied && (source === 'local' || (!source && payload.error === 'Upstream error' && payload.networkCode));
    const detail = typeof payload.detail === 'string' ? payload.detail
        : payload.error && typeof payload.error.message === 'string' ? payload.error.message
        : typeof payload.error === 'string' ? payload.error : typeof payload.message === 'string' ? payload.message : '';
    const error = new Error(detail || '模型接口请求失败');
    error.status = response.status;
    error.code = local && typeof payload.code === 'string' ? payload.code : 'UPSTREAM_HTTP_ERROR';
    error.networkCode = local && typeof payload.networkCode === 'string' ? payload.networkCode : '';
    error.servicePid = local && Number.isInteger(payload.servicePid) ? payload.servicePid : null;
    error.retryable = local ? payload.retryable === true
        : [500, 502, 503, 504, 524].includes(response.status) && !/无可用渠道|no available channel/i.test(detail);
    if (proxied && !source && !data && [404, 405].includes(response.status)) {
        error.code = 'LOCAL_PROXY_UNAVAILABLE';
        error.retryable = false;
    }
    return error;
}

function formatModelListFailure(error, apiUrl, apiKey) {
    const code = error.code || '';
    let message;
    if (code === 'UPSTREAM_CONNECT_DENIED') {
        message = '本地服务连接上游时被运行环境或系统拒绝，请求尚未到达 API 鉴权。请用项目中的“启动服务.bat”重启服务后重试；若仍失败，运行 npm run diagnose:api -- --url ' + new URL(apiUrl).origin + ' 检查连接。';
    } else if (code === 'UPSTREAM_DNS_FAILED') message = '无法解析 API 域名，请检查地址拼写、DNS 或 VPN 连接。';
    else if (code === 'UPSTREAM_TLS_FAILED') message = '上游 HTTPS 证书校验失败，请检查系统时间、代理证书或联系 API 提供商。';
    else if (code === 'UPSTREAM_CONNECTION_REFUSED') message = 'API 连接被拒绝，请检查上游服务和端口是否可用。';
    else if (code === 'MODEL_LIST_TIMEOUT' || code === 'UPSTREAM_CONNECT_TIMEOUT') message = '拉取模型列表超时，连接已取消。请检查网络或稍后重试。';
    else if (code === 'LOCAL_PROXY_UNAVAILABLE') message = '当前页面的本地服务未提供模型列表代理，请用项目中的“启动服务.bat”启动服务后刷新页面。';
    else if (code === 'MODEL_LIST_NETWORK_ERROR') message = '无法连接模型列表接口，请确认本地服务仍在运行，并检查网络连接。';
    else if (error.status === 401) message = '上游已收到请求，但拒绝了 API Key。请检查密钥是否正确或已过期。';
    else if (error.status === 403) message = '上游拒绝访问，请检查密钥权限、IP 限制或站点访问规则。';
    else if (error.status === 404) message = '上游没有找到模型接口，请核对 API 根地址或 /v1 地址。';
    else if (error.status === 405) message = '上游模型接口不支持 GET 请求，请向提供商核对模型列表地址。';
    else if (error.status === 429) message = '上游已限流，请稍后重试，并检查账号额度与请求频率。';
    else message = error.message || '拉取模型列表失败';

    // 错误可复制用于排查，但不显示密钥、URL 查询串或认证信息。
    function redact(text) {
        let value = String(text || '');
        if (apiKey) value = value.split(apiKey).join('[已隐藏密钥]');
        return value.replace(/https?:\/\/[^\s<>"']+/gi, function (url) {
            try { const u = new URL(url); return u.origin + u.pathname; } catch (_) { return '[API 地址]'; }
        }).replace(/Bearer\s+[^\s]+/gi, 'Bearer [已隐藏密钥]').slice(0, 800);
    }
    let endpoint = '';
    try { const u = new URL(buildOpenAIModelsListUrl(apiUrl)); endpoint = u.origin + u.pathname; } catch (_) {}
    const diagnostic = [error.status ? 'HTTP ' + error.status : '', code, error.networkCode].filter(Boolean).join(' · ');
    const detail = error.message && message !== error.message ? '\n上游/代理说明：' + redact(error.message).slice(0, 300) : '';
    return redact(message) + detail + (diagnostic ? '\n\n诊断：' + redact(diagnostic) : '')
        + (endpoint ? '\n接口：' + endpoint : '') + (error.servicePid ? '\n本地服务进程：' + error.servicePid : '');
}

function modelListFormContext(scope, urlId, keyId) {
    const urlInput = document.getElementById(urlId), keyInput = document.getElementById(keyId);
    const url = urlInput ? urlInput.value.trim() : '';
    const key = normalizeApiKeyForBearer(keyInput ? keyInput.value : '');
    return { scope, inputs: [urlInput, keyInput].filter(Boolean), isCurrent: function () {
        return !!urlInput && !!keyInput && urlInput.value.trim() === url && normalizeApiKeyForBearer(keyInput.value) === key;
    } };
}

function fetchModelsForInputs(apiUrl, apiKey, onSuccess, onFinally, options = {}) {
    const scope = options.scope || 'main';
    const previous = modelListRequests.get(scope);
    if (previous) { previous.cancel(); modelListRequests.delete(scope); }
    if (!apiUrl || !apiKey) {
        showNotification('请填写API地址和API Key');
        onFinally && onFinally();
        return;
    }
    const baseForProxy = normalizeApiBaseUrlForProxy(apiUrl);
    if (!baseForProxy) {
        showNotification('请填写有效的 HTTP(S) API 地址，不要包含用户名或密码');
        onFinally && onFinally();
        return;
    }

    const normalizedApiKey = normalizeApiKeyForBearer(apiKey);
    if (!isValidApiKeyToken(normalizedApiKey)) {
        showErrorDialog('拉取模型列表失败', 'API Key 含有无法用于请求头的字符。请只粘贴密钥本身，不要包含说明文字。');
        onFinally && onFinally();
        return;
    }

    const bearer = `Bearer ${normalizedApiKey}`;
    const modelsEndpoint = buildOpenAIModelsListUrl(apiUrl);
    const maxAttempts = 3;
    const retryDelaysMs = [0, 800, 2000];
    const controller = new AbortController();
    const task = { cancelled: false, cancel: function () { task.cancelled = true; controller.abort(); } };
    modelListRequests.set(scope, task);
    const current = function () { return modelListRequests.get(scope) === task && !task.cancelled && (!options.isCurrent || options.isCurrent()); };
    const inputs = options.inputs || [];
    inputs.forEach(function (input) { input.addEventListener('input', task.cancel); });
    let timedOut = false;
    const deadline = setTimeout(function () { timedOut = true; controller.abort(); }, 35000);
    const proxied = apiUrlNeedsLocalProxy(apiUrl);

    return (async function () {
        let lastError = null;
        for (let attempt = 0; attempt < maxAttempts; attempt++) {
            if (retryDelaysMs[attempt]) {
                await new Promise(function (r) { setTimeout(r, retryDelaysMs[attempt]); });
            }
            if (!current()) return false;
            try {
                if (timedOut) throw Object.assign(new Error('模型列表请求超时'), { code: 'MODEL_LIST_TIMEOUT' });
                const modelsFetch = proxied
                    ? fetch('/api/models/list', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json; charset=UTF-8' },
                        signal: controller.signal,
                        cache: 'no-store',
                        body: JSON.stringify({ targetBaseUrl: baseForProxy, authorization: bearer })
                    })
                    : fetch(modelsEndpoint, {
                        method: 'GET',
                        signal: controller.signal,
                        cache: 'no-store',
                        headers: { Authorization: bearer, Accept: 'application/json' }
                    });
                const response = await modelsFetch;

                const text = await response.text();
                let data = null;
                try { data = JSON.parse(text); } catch (_) {}
                if (!current()) return false;
                if (!response.ok || (data && data.error)) throw modelListErrorFromResponse(response, data, proxied);
                if (data === null) throw Object.assign(new Error('上游返回了网页或无效 JSON，请检查 API 地址是否为模型接口。'), { code: 'INVALID_MODEL_LIST' });
                const models = parseModelList(data);
                onSuccess(models);
                showNotification('模型列表拉取成功');
                return true;
            } catch (error) {
                if (!current()) return false;
                if (timedOut) error = Object.assign(new Error('模型列表请求超时'), { code: 'MODEL_LIST_TIMEOUT', retryable: false });
                else if (!error.code && /failed to fetch|network.?error|load failed|fetch failed/i.test(String(error.message || ''))) {
                    error.code = 'MODEL_LIST_NETWORK_ERROR';
                    error.retryable = true;
                }
                lastError = error;
                if (!error.retryable || attempt === maxAttempts - 1) break;
            }
        }

        const error = lastError || new Error('拉取模型列表失败');
        const errorDetails = formatModelListFailure(error, apiUrl, normalizedApiKey);
        showErrorDialog('拉取模型列表失败', errorDetails);
        console.warn('[模型列表]', error.code || 'ERROR', error.status || '');
        return false;
    })().finally(function () {
        clearTimeout(deadline);
        inputs.forEach(function (input) { input.removeEventListener('input', task.cancel); });
        if (modelListRequests.get(scope) === task) {
            modelListRequests.delete(scope);
            onFinally && onFinally();
        }
    });
}

function fetchFloatingModels() {
    const apiUrl = document.getElementById('floating-api-url').value.trim();
    const apiKeyInput = document.getElementById('floating-api-key');
    const apiKey = normalizeApiKeyForBearer(apiKeyInput.value);
    apiKeyInput.value = apiKey;
    const fetchBtn = document.querySelector('.floating-fetch-models-btn');
    showLoading('正在连接API...');
    if (fetchBtn) {
        fetchBtn.disabled = true;
        fetchBtn.innerHTML = '<span class="fetch-icon">🔄</span> 连接中...';
    }
    return fetchModelsForInputs(apiUrl, apiKey, renderFloatingModels, function() {
        hideLoading();
        if (fetchBtn) {
            fetchBtn.disabled = false;
            fetchBtn.innerHTML = '☁️ 拉取模型列表';
        }
    }, modelListFormContext('floating', 'floating-api-url', 'floating-api-key'));
}

function saveFloatingApiSettings() {
    const apiUrl = document.getElementById('floating-api-url').value.trim();
    const floatingApiKeyEl = document.getElementById('floating-api-key');
    const apiKey = normalizeApiKeyForBearer(floatingApiKeyEl.value);
    const floatModelEl = document.getElementById('floating-model-name');
    const model = coerceApiModelToString(floatModelEl ? floatModelEl.value : '');
    if (!apiUrl || !apiKey) {
        showNotification('请填写API地址和API Key');
        return;
    }
    if (!isValidApiKeyToken(apiKey)) {
        showNotification('API Key 含有非法字符，请重新粘贴纯文本密钥');
        return;
    }
    floatingApiKeyEl.value = apiKey;
    if (!isValidUrl(apiUrl)) {
        showNotification('API地址格式不正确');
        return;
    }
    if (!model) {
        showNotification('请选择模型');
        return;
    }
    try {
        writeApiSettingsToStorage({ apiUrl, apiKey, model });
        clearApiSettingsFormDirty();
    } catch (e) {
        console.error('保存 API 设置失败:', e);
        showNotification('API 设置保存失败，请检查浏览器存储空间');
        return;
    }
    const apiUrlInput = document.getElementById('api-url');
    const apiKeyInput = document.getElementById('api-key');
    const modelInput = document.getElementById('model-name');
    if (apiUrlInput) apiUrlInput.value = apiUrl;
    if (apiKeyInput) apiKeyInput.value = apiKey;
    if (modelInput) modelInput.value = model;
    activateApiConnection(apiUrl, apiKey, model);
    closeApiFloatingSettingsModal();
    showNotification('简易API设置已保存并生效');
}

function cancelApiFloatingBallPressTimer() {
    if (apiFloatingBallPressTimer) {
        clearTimeout(apiFloatingBallPressTimer);
        apiFloatingBallPressTimer = null;
    }
}

function endApiFloatingBallDrag() {
    const ball = document.getElementById('api-floating-ball');
    if (ball) ball.classList.remove('dragging');
    apiFloatingBallDragging = false;
    apiFloatingBallPointerId = null;
    cancelApiFloatingBallPressTimer();
    resetApiFloatingBallIdle();
}

function startApiFloatingBallDrag(ball, event) {
    apiFloatingBallDragging = true;
    apiFloatingBallMoved = false;
    apiFloatingBallPointerId = event.pointerId;
    ball.classList.add('dragging');
    try { ball.setPointerCapture(event.pointerId); } catch (e) {}
}

function handleApiFloatingBallPointerDown(event) {
    const ball = event.currentTarget;
    if (!ball || !getApiFloatingBallEnabled() || !event.isPrimary || event.button !== 0 || apiFloatingBallPointerId !== null) return;
    apiFloatingBallPointerId = event.pointerId;
    try { ball.setPointerCapture(event.pointerId); } catch (e) {}
    resetApiFloatingBallIdle();
    apiFloatingBallMoved = false;
    cancelApiFloatingBallPressTimer();
    const startX = event.clientX;
    const startY = event.clientY;
    const rect = ball.getBoundingClientRect();
    const offsetX = startX - rect.left;
    const offsetY = startY - rect.top;
    apiFloatingBallPressTimer = setTimeout(() => {
        startApiFloatingBallDrag(ball, event);
    }, API_FLOATING_BALL_DRAG_HOLD_MS);

    function onPointerMove(moveEvent) {
        if (moveEvent.pointerId !== event.pointerId || !ball.classList.contains('show')) return;
        if (!apiFloatingBallDragging) {
            if (Math.abs(moveEvent.clientX - startX) > 8 || Math.abs(moveEvent.clientY - startY) > 8) {
                cancelApiFloatingBallPressTimer();
                apiFloatingBallMoved = true;
            }
            return;
        }
        apiFloatingBallMoved = true;
        const frame = ball.parentElement.getBoundingClientRect();
        const pos = clampApiFloatingBallPosition(moveEvent.clientX - offsetX - frame.left, moveEvent.clientY - offsetY - frame.top, ball);
        ball.style.left = `${pos.x}px`;
        ball.style.top = `${pos.y}px`;
        ball.style.right = 'auto';
    }

    function onPointerEnd(endEvent) {
        if (endEvent.pointerId !== event.pointerId) return;
        ball.removeEventListener('lostpointercapture', onPointerEnd);
        document.removeEventListener('pointermove', onPointerMove);
        document.removeEventListener('pointerup', onPointerEnd);
        document.removeEventListener('pointercancel', onPointerEnd);
        cancelApiFloatingBallPressTimer();
        const tap = !apiFloatingBallDragging && !apiFloatingBallMoved && endEvent.type === 'pointerup';
        if (apiFloatingBallDragging && ball.offsetWidth) saveApiFloatingBallPosition(ball);
        endApiFloatingBallDrag();
        if (tap && ball.classList.contains('show')) openApiFloatingSettingsModal();
    }

    document.addEventListener('pointermove', onPointerMove);
    ball.addEventListener('lostpointercapture', onPointerEnd);
    document.addEventListener('pointerup', onPointerEnd);
    document.addEventListener('pointercancel', onPointerEnd);
}

function initApiFloatingBall() {
    const ball = document.getElementById('api-floating-ball');
    const toggle = document.getElementById('api-floating-ball-toggle');
    const presetSelect = document.getElementById('floating-api-preset-select');
    if (toggle) {
        toggle.checked = getApiFloatingBallEnabled();
        toggle.addEventListener('change', function() {
            setApiFloatingBallEnabled(!!toggle.checked);
            updateApiFloatingBallVisibility();
            showNotification(toggle.checked ? '已开启悬浮球' : '已关闭悬浮球');
        });
    }
    if (ball) {
        ball.addEventListener('pointerdown', handleApiFloatingBallPointerDown);
        ball.addEventListener('contextmenu', event => event.preventDefault());
        ball.addEventListener('click', event => { if (event.detail === 0) openApiFloatingSettingsModal(); });
        ball.addEventListener('pointerenter', resetApiFloatingBallIdle);
        ball.addEventListener('focus', resetApiFloatingBallIdle);
    }
    if (presetSelect) {
        presetSelect.addEventListener('change', function() {
            applyPresetToFloatingSettings(this.value);
        });
    }
    const fitToScreen = () => {
        if (ball && ball.offsetWidth && !apiFloatingBallDragging) applyApiFloatingBallPosition(getApiFloatingBallSavedPosition());
    };
    if (ball && window.ResizeObserver) new ResizeObserver(fitToScreen).observe(ball.parentElement);
    window.addEventListener('resize', fitToScreen);
    updateApiFloatingBallVisibility();
}

// 保存预设
function savePreset() {
    const presetName = document.getElementById('preset-name').value.trim();
    const errorElement = document.getElementById('preset-name-error');
    
    // 验证预设名称
    const error = validatePresetName(presetName);
    if (error) {
        errorElement.textContent = error;
        return;
    }
    
    // 获取当前API配置
    const apiUrl = document.getElementById('api-url').value;
    const apiKey = normalizeApiKeyForBearer(document.getElementById('api-key').value);
    
    // 验证API配置
    if (!apiUrl || !apiKey) {
        errorElement.textContent = '请先填写API地址和API Key';
        return;
    }
    if (!isValidApiKeyToken(apiKey)) {
        errorElement.textContent = 'API Key 含有非法字符，请重新粘贴纯文本密钥';
        return;
    }
    
    // 获取现有预设
    const presets = getPresets();
    
    // 添加新预设
    presets.push({
        name: presetName,
        apiUrl: apiUrl,
        apiKey: btoa(apiKey) // 加密存储API Key
    });
    
    // 保存到本地存储
    try {
        localStorage.setItem('apiPresets', JSON.stringify(presets));
        
        // 关闭对话框
        closeSavePresetDialog();
        
        // 显示成功提示
        alert('预设保存成功');
    } catch (e) {
        console.error('保存预设失败:', e);
        errorElement.textContent = '保存预设失败，请重试';
    }
}

// 删除 API 预设（不可恢复）
function deleteApiPreset(presetName) {
    if (!presetName) return;
    showConfirmDialog(
        '删除 API 预设',
        '此操作不可逆，请慎重操作。确定要永久删除该预设吗？',
        function () {
            const presets = getPresets().filter(p => p.name !== presetName);
            try {
                localStorage.setItem('apiPresets', JSON.stringify(presets));
                showNotification('已删除预设：' + presetName);
                openPresetSelectDialog();
            } catch (e) {
                console.error(e);
                showNotification('删除失败，请重试');
            }
        },
        { variant: 'danger' }
    );
}

// 打开选择预设对话框
function openPresetSelectDialog() {
    const selectPresetModal = document.getElementById('select-preset-modal');
    const presetList = document.getElementById('preset-list');
    
    // 清空预设列表
    presetList.innerHTML = '';
    
    // 获取所有预设
    const presets = getPresets();
    
    if (presets.length === 0) {
        // 没有预设时显示提示
        const noPresetItem = document.createElement('div');
        noPresetItem.className = 'preset-item';
        noPresetItem.textContent = '暂无预设';
        noPresetItem.style.textAlign = 'center';
        noPresetItem.style.color = '#999';
        presetList.appendChild(noPresetItem);
    } else {
        presets.forEach(preset => {
            const row = document.createElement('div');
            row.className = 'preset-item preset-item-row';

            const nameBtn = document.createElement('button');
            nameBtn.type = 'button';
            nameBtn.className = 'preset-item-name-btn';
            nameBtn.textContent = preset.name;
            nameBtn.title = '加载此预设';
            nameBtn.onclick = () => {
                loadPreset(preset.name);
                closePresetSelectDialog();
            };

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'preset-item-delete-btn';
            delBtn.textContent = '删除';
            delBtn.title = '删除此预设';
            delBtn.onclick = (e) => {
                e.stopPropagation();
                deleteApiPreset(preset.name);
            };

            row.appendChild(nameBtn);
            row.appendChild(delBtn);
            presetList.appendChild(row);
        });
    }
    
    // 显示模态框
    selectPresetModal.classList.add('show');
}

// 关闭选择预设对话框
function closePresetSelectDialog() {
    document.getElementById('select-preset-modal').classList.remove('show');
}

// 加载预设
function loadPreset(presetName) {
    if (!presetName) return;
    
    // 获取所有预设
    const presets = getPresets();
    
    // 找到选中的预设
    const preset = presets.find(p => p.name === presetName);
    if (!preset) return;
    
    // 填充API配置
    const apiUrlEl = document.getElementById('api-url');
    const apiKeyInput = document.getElementById('api-key');
    if (apiUrlEl) apiUrlEl.value = preset.apiUrl || '';
    if (apiKeyInput) {
        try {
            apiKeyInput.value = atob(preset.apiKey || '');
        } catch (e) {
            apiKeyInput.value = '';
        }
    }
    markApiSettingsFormDirty();
    checkApiInputs();
    showNotification('预设已填入表单，修改后请点击「保存全部设置」生效');
}



// 验证URL格式
function isValidUrl(url) {
    try {
        const u = new URL(url);
        return /^https?:$/.test(u.protocol) && !u.username && !u.password;
    } catch (e) {
        return false;
    }
}

// 检查API输入并启用/禁用拉取模型按钮
function checkApiInputs() {
    const apiUrl = document.getElementById('api-url');
    const apiKey = document.getElementById('api-key');
    const urlTrim = apiUrl ? apiUrl.value.trim() : '';
    const keyTrim = apiKey ? apiKey.value.trim() : '';

    document.querySelectorAll('.fetch-models-btn').forEach(function (fetchModelsBtn) {
        fetchModelsBtn.disabled = !(urlTrim && keyTrim && isValidUrl(urlTrim));
    });
}

// 拉取模型列表
function fetchModels() {
    const apiUrl = document.getElementById('api-url').value.trim();
    const apiKey = document.getElementById('api-key').value.trim();
    const modelsList = document.getElementById('models-list');
    const fetchModelsBtn = document.querySelector('.fetch-models-btn');
    showLoading('正在连接API...');
    if (fetchModelsBtn) {
        fetchModelsBtn.disabled = true;
        fetchModelsBtn.innerHTML = '<span class="fetch-icon">🔄</span> 连接中...';
    }
    return fetchModelsForInputs(apiUrl, apiKey, function(models) {
        if (modelsList) {
            modelsList.innerHTML = '';
            models.forEach(model => {
                const modelItem = document.createElement('div');
                modelItem.className = 'model-item';
                modelItem.textContent = model;
                modelItem.onclick = () => {
                    document.getElementById('model-name').value = model;
                    markApiSettingsFormDirty();
                    modelsList.innerHTML = '';
                    showNotification('模型选择成功，请点击「保存全部设置」生效');
                };
                modelsList.appendChild(modelItem);
            });
        }
    }, function() {
        hideLoading();
        if (fetchModelsBtn) {
            fetchModelsBtn.disabled = false;
            fetchModelsBtn.innerHTML = '<span class="fetch-icon">🔄</span> 拉取模型列表';
        }
        checkApiInputs();
    }, modelListFormContext('main', 'api-url', 'api-key'));
}

/** 设置 · 主动发消息专用的 OpenAI 兼容接口（未完成三项时退回主 API 设置） */
const PROACTIVE_AUTO_API_LS_KEY = 'proactiveAutoApiSettingsV1';

function loadProactiveAutoApiConnection() {
    try {
        const o = JSON.parse(localStorage.getItem(PROACTIVE_AUTO_API_LS_KEY) || '{}');
        if (!o || typeof o !== 'object') return { apiUrl: '', apiKey: '', model: '' };
        return {
            apiUrl: String(o.apiUrl || '').trim(),
            apiKey: normalizeApiKeyForBearer(o.apiKey),
            model: String(o.model || '').trim()
        };
    } catch (e) {
        return { apiUrl: '', apiKey: '', model: '' };
    }
}

function syncProactiveAutoApiFormFromStorage() {
    const s = loadProactiveAutoApiConnection();
    const urlEl = document.getElementById('proactive-auto-api-url');
    const keyEl = document.getElementById('proactive-auto-api-key');
    const modelEl = document.getElementById('proactive-auto-model-name');
    const listEl = document.getElementById('proactive-auto-models-list');
    if (urlEl) urlEl.value = s.apiUrl || '';
    if (keyEl) keyEl.value = s.apiKey || '';
    if (modelEl) modelEl.value = s.model || '';
    if (listEl) listEl.innerHTML = '';
}

function checkProactiveAutoApiInputs() {
    const apiUrl = (document.getElementById('proactive-auto-api-url') || {}).value;
    const apiKey = (document.getElementById('proactive-auto-api-key') || {}).value;
    const fetchBtn = document.getElementById('proactive-auto-fetch-models-btn');
    const u = apiUrl ? String(apiUrl).trim() : '';
    const k = apiKey ? String(apiKey).trim() : '';
    if (fetchBtn) {
        fetchBtn.disabled = !(u && k && isValidUrl(u));
    }
}

function fetchProactiveAutoModels() {
    const apiUrl = document.getElementById('proactive-auto-api-url')
        ? document.getElementById('proactive-auto-api-url').value.trim()
        : '';
    const apiKeyEl = document.getElementById('proactive-auto-api-key');
    const apiKey = apiKeyEl ? normalizeApiKeyForBearer(apiKeyEl.value) : '';
    if (apiKeyEl) apiKeyEl.value = apiKey;
    const modelsList = document.getElementById('proactive-auto-models-list');
    const fetchModelsBtn = document.getElementById('proactive-auto-fetch-models-btn');
    showLoading('正在连接API...');
    if (fetchModelsBtn) {
        fetchModelsBtn.disabled = true;
        fetchModelsBtn.innerHTML = '<span class="fetch-icon">🔄</span> 连接中...';
    }
    return fetchModelsForInputs(apiUrl, apiKey, function (models) {
        if (modelsList) {
            modelsList.innerHTML = '';
            models.forEach((model) => {
                const modelItem = document.createElement('div');
                modelItem.className = 'model-item';
                modelItem.textContent = model;
                modelItem.onclick = () => {
                    const inp = document.getElementById('proactive-auto-model-name');
                    if (inp) inp.value = model;
                    modelsList.innerHTML = '';
                    showNotification('模型选择成功');
                };
                modelsList.appendChild(modelItem);
            });
        }
    }, function () {
        hideLoading();
        if (fetchModelsBtn) {
            fetchModelsBtn.disabled = false;
            fetchModelsBtn.innerHTML = '<span class="fetch-icon">🔄</span> 拉取模型列表';
        }
        checkProactiveAutoApiInputs();
    }, modelListFormContext('proactive', 'proactive-auto-api-url', 'proactive-auto-api-key'));
}

function saveProactiveAutoApiSettings() {
    const apiUrlEl = document.getElementById('proactive-auto-api-url');
    const apiKeyEl = document.getElementById('proactive-auto-api-key');
    const modelEl = document.getElementById('proactive-auto-model-name');
    const apiUrl = apiUrlEl ? apiUrlEl.value.trim() : '';
    const apiKey = apiKeyEl ? normalizeApiKeyForBearer(apiKeyEl.value) : '';
    const model = modelEl ? modelEl.value.trim() : '';

    if (!apiUrl && !apiKey && !model) {
        try {
            localStorage.removeItem(PROACTIVE_AUTO_API_LS_KEY);
        } catch (e) {}
        showNotification('已清空自动消息专用 API（将始终使用主 API 设置）');
        navigateTo('settings');
        return;
    }

    if (!apiUrl || !apiKey || !model) {
        showNotification('请填写完整的 API 地址、API Key 与模型名称后再保存');
        return;
    }
    if (!isValidApiKeyToken(apiKey)) {
        showNotification('API Key 含有非法字符，请重新粘贴纯文本密钥');
        return;
    }
    if (apiKeyEl) apiKeyEl.value = apiKey;
    if (!isValidUrl(apiUrl)) {
        showNotification('API地址格式不正确');
        return;
    }

    showLoading('正在保存设置...');
    setTimeout(function () {
        hideLoading();
        try {
            localStorage.setItem(
                PROACTIVE_AUTO_API_LS_KEY,
                JSON.stringify({ apiUrl, apiKey, model })
            );
        } catch (e) {
            showNotification('保存失败');
            return;
        }
        showNotification('自动消息 API 已保存');
        navigateTo('settings');
    }, 200);
}

function clearProactiveAutoApiKey() {
    const el = document.getElementById('proactive-auto-api-key');
    if (el) el.value = '';
    checkProactiveAutoApiInputs();
}

// 保存API设置
function saveApiSettings() {
    const apiUrlEl = document.getElementById('api-url');
    const apiKeyEl = document.getElementById('api-key');
    const modelEl = document.getElementById('model-name');
    if (!apiUrlEl || !apiKeyEl || !modelEl) {
        showNotification('API 表单未就绪，请稍后重试');
        return;
    }
    const apiUrl = apiUrlEl.value.trim();
    const apiKey = normalizeApiKeyForBearer(apiKeyEl.value);
    const model = coerceApiModelToString(modelEl.value);
    const memoryCount = document.getElementById('memory-count').value;
    const streamEl = document.getElementById('stream-output-toggle');
    const maxTokensEl = document.getElementById('max-output-tokens');
    const waitTimeoutEl = document.getElementById('wait-timeout-minutes');
    const timeAwareness = document.getElementById('time-awareness-toggle').checked;

    const streamOutput = streamEl ? !!streamEl.checked : false;

    let maxOutputTokens = parseInt(maxTokensEl ? maxTokensEl.value : '', 10);
    if (!Number.isFinite(maxOutputTokens) || maxOutputTokens < 1) maxOutputTokens = API_MAX_OUTPUT_TOKENS_DEFAULT;
    if (maxOutputTokens > API_MAX_OUTPUT_TOKENS_MAX) maxOutputTokens = API_MAX_OUTPUT_TOKENS_MAX;
    if (maxTokensEl) maxTokensEl.value = String(maxOutputTokens);

    let waitTimeoutMinutes = parseFloat(waitTimeoutEl ? waitTimeoutEl.value : '');
    if (!Number.isFinite(waitTimeoutMinutes) || waitTimeoutMinutes <= 0) waitTimeoutMinutes = API_WAIT_TIMEOUT_MINUTES_DEFAULT;
    waitTimeoutMinutes = Math.min(Math.max(waitTimeoutMinutes, API_WAIT_TIMEOUT_MINUTES_MIN), API_WAIT_TIMEOUT_MINUTES_MAX);
    if (waitTimeoutEl) waitTimeoutEl.value = String(waitTimeoutMinutes);

    if (!apiUrl || !apiKey) {
        showNotification('请填写API地址和API Key');
        return;
    }
    if (!isValidApiKeyToken(apiKey)) {
        showNotification('API Key 含有非法字符，请重新粘贴纯文本密钥');
        return;
    }
    apiKeyEl.value = apiKey;
    if (!isValidUrl(apiUrl)) {
        showNotification('API地址格式不正确');
        return;
    }
    if (!model) {
        showNotification('请选择模型');
        return;
    }

    try {
        const settings = writeApiSettingsToStorage({
            apiUrl,
            apiKey,
            model,
            memoryCount,
            streamOutput,
            maxOutputTokens: String(maxOutputTokens),
            waitTimeoutMinutes: String(waitTimeoutMinutes),
            timeAwareness
        });
        clearApiSettingsFormDirty();
        modelEl.value = settings.model;
        activateApiConnection(apiUrl, apiKey, model);
        showNotification('API设置保存成功并已激活');
    } catch (e) {
        console.error('保存 API 设置失败:', e);
        const quota = typeof isQuotaExceededError === 'function' && isQuotaExceededError(e);
        showNotification(
            quota
                ? '保存失败：浏览器存储空间已满，无法写入 API 设置。可先导出备份，再精简聊天记录等内容后重试。'
                : 'API 设置保存失败，请检查浏览器是否禁用本地存储或隐私模式权限。'
        );
    }
}

// 重置当前 API 连接（保留高级设置），便于导入备份后重新配置
function resetActiveApiSettings() {
    showConfirmDialog(
        '重置 API 连接',
        '将清空当前 API 地址、Key 与模型（预设列表不受影响）。确定继续吗？',
        function () {
            try {
                const current = readApiSettingsFromStorage();
                writeApiSettingsToStorage({
                    apiUrl: '',
                    apiKey: '',
                    model: '',
                    connectionStatus: 'disconnected',
                    memoryCount: current.memoryCount,
                    streamOutput: current.streamOutput,
                    maxOutputTokens: current.maxOutputTokens,
                    waitTimeoutMinutes: current.waitTimeoutMinutes,
                    timeAwareness: current.timeAwareness
                });
                clearApiSettingsFormDirty();
                loadApiSettings({ syncForm: true, forceFormSync: true });
                showNotification('已重置 API 连接，请填写新配置后拉取模型并保存');
            } catch (e) {
                console.error(e);
                showNotification('重置失败，请重试');
            }
        },
        { variant: 'danger' }
    );
}

// 激活API连接
function activateApiConnection(apiUrl, apiKey, model) {
    updateConnectionStatus('connecting', '正在激活API连接...');

    try {
        const updates = { connectionStatus: 'connecting' };
        if (apiUrl != null && String(apiUrl).trim() !== '') updates.apiUrl = String(apiUrl).trim();
        if (apiKey != null && normalizeApiKeyForBearer(apiKey) !== '') {
            updates.apiKey = normalizeApiKeyForBearer(apiKey);
        }
        const modelNorm = coerceApiModelToString(model);
        if (modelNorm) updates.model = modelNorm;
        writeApiSettingsToStorage(updates);
    } catch (e) {}

    setTimeout(function() {
        updateConnectionStatus('connected', 'API连接已激活');
        try {
            writeApiSettingsToStorage({ connectionStatus: 'connected' });
        } catch (e) {}
    }, 450);
}

// 加载API设置
function loadApiSettings(options) {
    options = options || {};
    const forceFormSync = !!options.forceFormSync;
    const syncForm = options.syncForm !== false && (forceFormSync || !__apiSettingsFormDirty);

    let settings = readApiSettingsFromStorage();
    if (settings.model !== coerceApiModelToString(settings.model)) {
        settings = writeApiSettingsToStorage({ model: coerceApiModelToString(settings.model) });
    }

    if (syncForm) {
        syncApiSettingsFormFromRecord(settings);
        if (forceFormSync) clearApiSettingsFormDirty();
    } else {
        try { syncFloatingApiSettingsFromStorage({ syncForm: false }); } catch (e) {}
        try { checkApiInputs(); } catch (e) {}
    }

    const hasCred = !!(settings.apiUrl && settings.apiKey);
    const hasModelPick = !!(settings.model && settings.model.trim());
    if (!hasCred) {
        updateConnectionStatus('disconnected', '未连接');
        return;
    }
    if (!hasModelPick) {
        updateConnectionStatus('disconnected', '请先填写或拉取模型');
        return;
    }

    if (settings.connectionStatus === 'connected') {
        updateConnectionStatus('connected', 'API连接已激活');
    } else if (settings.connectionStatus === 'connecting') {
        updateConnectionStatus('connecting', '正在激活API连接...');
    } else {
        activateApiConnection(settings.apiUrl, settings.apiKey, settings.model);
    }
}

// 加载模型列表
function loadModelList() {
    // 模型列表现在通过拉取模型列表按钮动态生成
    // 这里不需要做任何操作
}



// 验证API地址可访问性
async function validateApiAccessibility(apiUrl) {
    try {
        const response = await fetch(apiUrl, {
            method: 'GET',
            timeout: 5000 // 5秒超时
        });
        return response.ok;
    } catch (error) {
        return false;
    }
}

// 更新API连接状态
function updateConnectionStatus(status, message) {
    const statusIndicator = document.getElementById('status-indicator');
    const statusText = document.getElementById('status-text');
    
    if (statusIndicator && statusText) {
        statusIndicator.className = 'status-indicator';
        
        switch (status) {
            case 'connecting':
                statusIndicator.classList.add('connecting');
                statusText.textContent = message || '连接中...';
                break;
            case 'connected':
                statusIndicator.classList.add('connected');
                statusText.textContent = message || '已连接';
                break;
            case 'disconnected':
                statusText.textContent = message || '未连接';
                break;
            case 'error':
                statusIndicator.classList.add('error');
                statusText.textContent = message || '连接错误';
                break;
            default:
                statusText.textContent = message || '未连接';
        }
    }
}

// 拍一拍功能 - 用户拍好友
function patPat() {
    if (typeof isVoicePhoneCallActive === 'function' && isVoicePhoneCallActive()) {
        showNotification('语音通话中仅可发送文字消息');
        return;
    }
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    
    if (friendId) {
        // 从本地存储中获取好友信息
        const friends = loadFriendsFromStorage();
        const friend = friends.find(f => f.id == friendId);
        
        if (friend) {
            // 获取拍一拍后缀
            const patPatSuffix = friend.patPat || '的头';
            const patPatContent = `你拍了拍 ${friend.nickname}${patPatSuffix}`;
            const timestamp = new Date().getTime();
            
            // 保存拍一拍消息到聊天历史
            saveChatMessage(friendId, 'system', patPatContent, null, timestamp);
            var patIndex = 0;
            if (typeof getChatHistoryArray === 'function') {
                var _histAfterPat = getChatHistoryArray(friendId);
                if (Array.isArray(_histAfterPat) && _histAfterPat.length > 0) {
                    patIndex = _histAfterPat.length - 1;
                }
            }
            // 添加拍一拍消息到界面
            const chatContent = document.querySelector('.chat-content');
            if (chatContent) {
                const patMessage = document.createElement('div');
                patMessage.className = 'chat-system-message';
                patMessage.textContent = patPatContent;
                if (timestamp) patMessage.dataset.messageTimestamp = String(timestamp);
                patMessage.dataset.messageIndex = String(patIndex);
                
                // 添加动画效果
                patMessage.style.opacity = '0';
                patMessage.style.transform = 'translateY(10px)';
                patMessage.style.transition = 'all 0.3s ease';
                
                chatContent.appendChild(patMessage);
                
                setTimeout(() => {
                    patMessage.style.opacity = '1';
                    patMessage.style.transform = 'translateY(0)';
                }, 10);
                
                chatContent.scrollTop = chatContent.scrollHeight;
                
                if (navigator.vibrate) {
                    navigator.vibrate(100);
                }
                
                showNotification(`你拍了拍 ${friend.nickname}${patPatSuffix}`);
            }
        }
    }
}

// 拍一拍功能 - 好友拍用户
function friendPatPat(friendId) {
    // 从本地存储中获取好友信息
    const friends = loadFriendsFromStorage();
    const friend = friends.find(f => f.id == friendId);
    
    if (friend) {
        // 获取用户昵称和拍一拍后缀（使用用户在人设中编辑保存的后缀）
        const myProfile = safeReadJsonFromStorage('myProfile', null);
        const myNickname = myProfile?.nickname || '我';
        const patPatSuffix = (myProfile?.patPat || '').trim() || '的头';
        
        // 生成时间戳
        const timestamp = new Date().getTime();
        
        // 构建拍一拍消息内容
        const patPatContent = `${friend.nickname} 拍了拍 ${myNickname}${patPatSuffix}`;
        
        // 保存拍一拍消息到聊天历史记录（与 wechat-store 内存缓存一致，避免重复解析/整表写盘）
        const fid = String(friendId);
        const chatHistory =
            typeof getChatHistoryArray === 'function'
                ? getChatHistoryArray(fid)
                : parseJsonFromPossiblyEncodedStorage(`chatHistory_${fid}`, []);
        chatHistory.push({
            type: 'system',
            content: patPatContent,
            timestamp: timestamp
        });
        if (typeof schedulePersistChatHistory === 'function') {
            schedulePersistChatHistory(fid);
        } else {
            saveJsonToStorageWithCompression(`chatHistory_${fid}`, chatHistory);
        }
        var patIndexAfterPush = Array.isArray(chatHistory) && chatHistory.length > 0 ? chatHistory.length - 1 : 0;
        // 添加拍一拍消息到聊天界面
        const chatContent = document.querySelector('.chat-content');
        if (chatContent) {
            const patMessage = document.createElement('div');
            patMessage.className = 'chat-system-message';
            patMessage.textContent = patPatContent;
            if (timestamp) patMessage.dataset.messageTimestamp = String(timestamp);
            patMessage.dataset.messageIndex = String(patIndexAfterPush);
            
            // 添加动画效果
            patMessage.style.opacity = '0';
            patMessage.style.transform = 'translateY(10px)';
            patMessage.style.transition = 'all 0.3s ease';
            
            chatContent.appendChild(patMessage);
            
            // 触发动画
            setTimeout(() => {
                patMessage.style.opacity = '1';
                patMessage.style.transform = 'translateY(0)';
            }, 10);
            
            // 滚动到底部
            chatContent.scrollTop = chatContent.scrollHeight;
            
            // 震动提示
            if (navigator.vibrate) {
                navigator.vibrate(100);
            }
            
            // 显示通知
            showNotification(`${friend.nickname} 拍了拍你`);
        }
    }
}

// 智能拍一拍触发
function checkAndTriggerPatPat(friendId, message) {
    // 情绪关键词列表
    const emotionalKeywords = {
        sad: ['难过', '伤心', '沮丧', '哭', '难过', '悲痛', '痛苦', '失落', '绝望'],
        angry: ['生气', '愤怒', '恼火', '烦躁', '不爽', '郁闷', '发脾气'],
       撒娇: ['撒娇', '可爱', '要抱抱', '要亲亲', '想你', '爱你', '宝贝'],
        happy: ['开心', '高兴', '快乐', '兴奋', '喜悦', '愉快']
    };
    
    // 拍一拍请求关键词
    const patPatKeywords = ['拍一拍', '拍拍', '拍我', '拍你'];
    
    // 检查消息中是否包含拍一拍请求
    let hasPatPatRequest = false;
    for (const keyword of patPatKeywords) {
        if (message.includes(keyword)) {
            hasPatPatRequest = true;
            break;
        }
    }
    
    // 检查消息中是否包含情绪关键词
    let hasEmotionalContent = false;
    for (const emotion in emotionalKeywords) {
        for (const keyword of emotionalKeywords[emotion]) {
            if (message.includes(keyword)) {
                hasEmotionalContent = true;
                break;
            }
        }
        if (hasEmotionalContent) break;
    }
    
    // 如果检测到拍一拍请求，直接触发拍一拍
    if (hasPatPatRequest) {
        setTimeout(() => {
            friendPatPat(friendId);
        }, 1000);
    }
    // 如果检测到情绪内容，触发拍一拍
    else if (hasEmotionalContent) {
        // 随机决定是否触发拍一拍（70%概率）
        if (Math.random() > 0.3) {
            setTimeout(() => {
                friendPatPat(friendId);
            }, 1000);
        }
    }
}

// scrollChatContentToBottom / openChat / applyGroupBubbleCssForCurrentChat：见 wechat-ui.js

// ===== 性能：调试日志开关（Netlify/移动端默认关闭） =====
const PERF_DEBUG_LOGS = false;
function perfLog(...args) {
    if (!PERF_DEBUG_LOGS) return;
    try { console.log(...args); } catch (e) {}
}

// ===== 导入后预热（渐进式，不阻塞 UI） =====
function runIdleTask(fn, timeoutMs) {
    const t = Math.max(200, timeoutMs || 800);
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => {
            try { fn(); } catch (e) {}
        }, { timeout: t });
    } else {
        setTimeout(() => {
            try { fn(); } catch (e) {}
        }, 30);
    }
}

function startPostImportPrewarmIfNeeded() {
    let flag = '';
    try { flag = sessionStorage.getItem('__POST_IMPORT_PREWARM__') || ''; } catch (e) { flag = ''; }
    if (!flag) return;
    try { sessionStorage.removeItem('__POST_IMPORT_PREWARM__'); } catch (e) {}

    // 1) 预热好友列表数据（不触发 DOM，全内存）
    runIdleTask(() => {
        try {
            const friends = loadFriendsFromStorage();
            // 轻量遍历一次，避免后续首次进入微信时解析/排序突然卡顿
            (friends || []).forEach((f) => {
                if (!f) return;
                // 触发字段默认值规范化（与 loadChatList 一致）
                f.pinned = !!f.pinned;
                f.unreadCount = f.unreadCount || 0;
                f.lastMessageTime = f.lastMessageTime || 0;
            });
        } catch (e) {}
    }, 800);

    // 2) 预热表情（若落在 IDB，提前把缓存拉起来）
    runIdleTask(() => {
        try { preloadEmojiFromIdbIfNeeded(); } catch (e) {}
    }, 1200);

    // 3) 预热朋友圈（若落在 IDB，提前把缓存拉起来）
    runIdleTask(() => {
        try { Moments.store.preloadMomentsPostsFromIdbIfNeeded(); } catch (e) {}
    }, 1500);

    // 4) 预热世界书与微信外观（轻量读取，减少首次打开的等待）
    runIdleTask(() => {
        try { getWorldBookData(); } catch (e) {}
        try { applyWechatThemeFromStorage(); } catch (e) {}
    }, 1500);

    // 5) 预热聊天列表 DOM（仍然渐进+节流）：在主界面空闲时先构建一次，用户点进微信更快
    runIdleTask(() => {
        try { scheduleLoadChatList(); } catch (e) {}
    }, 2000);
}

// 聊天渲染状态 / loadChatHistory / cancelActiveChatHistoryRender：见 wechat-ui.js

/**
 * 更新聊天页「心跳监控」展开区正文（供后续接入真心话等逻辑）
 * @param {string} htmlOrText - 若为 HTML 请确保来源可信
 */
function setChatHeartbeatMonitorContent(htmlOrText) {
    const el = document.getElementById('chat-heartbeat-monitor-content');
    if (!el) return;
    el.textContent = htmlOrText == null ? '' : String(htmlOrText);
}

// 微信底部导航 / 消息列表 / 添加菜单：见 wechat-ui.js（Wechat.ui）

// 编辑个人资料
function editProfile() {
    showNotification('编辑个人资料');
}

// 关闭我的人设模态框
function closeMyProfileModal() {
    const modal = document.getElementById('my-profile-modal');
    if (modal) {
        modal.classList.remove('show');
    }
}

// 处理人设头像上传
function handleMyProfileAvatarUpload(event) {
    const file = event.target.files[0];
    if (!file) return;
    if (!isLegoUploadableRasterImageFile(file)) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        event.target.value = '';
        return;
    }
    const reader = new FileReader();
    reader.onload = function(e) {
        if (!e.target.result) return;
        const avatarPreview = document.getElementById('my-profile-avatar-preview-img');
        if (!avatarPreview) return;
        avatarPreview.src = e.target.result;
        avatarPreview.style.display = 'block';
        compressImageDataUrl(e.target.result, 256, 0.82).then(function(compressed) {
            avatarPreview.dataset.compressed = compressed;
        }).catch(function() {});
    };
    reader.readAsDataURL(file);
}

// 加载人设信息
function loadMyProfile() {
    const myProfile = safeReadJsonFromStorage('myProfile', null);
    if (myProfile) {
        // 加载头像
        const avatarPreview = document.getElementById('my-profile-avatar-preview-img');
        if (avatarPreview) {
            if (myProfile.avatar) {
                avatarPreview.src = myProfile.avatar;
                avatarPreview.style.display = 'block';
            } else {
                avatarPreview.src = '';
                avatarPreview.style.display = 'none';
            }
        }
        
        // 加载昵称
        const nicknameInput = document.getElementById('my-profile-nickname-input');
        if (nicknameInput) {
            nicknameInput.value = myProfile.nickname || '';
        }
        
        // 加载身份
        const identityInput = document.getElementById('my-profile-identity-input');
        if (identityInput) {
            identityInput.value = myProfile.identity || '';
        }
        
        // 加载拍一拍后缀
        const patpatInput = document.getElementById('my-profile-patpat-input');
        if (patpatInput) {
            patpatInput.value = myProfile.patPat || '';
        }
    }
}

// 保存人设信息
function saveMyProfile() {
    const nicknameInput = document.getElementById('my-profile-nickname-input');
    const identityInput = document.getElementById('my-profile-identity-input');
    const patpatInput = document.getElementById('my-profile-patpat-input');
    const avatarPreview = document.getElementById('my-profile-avatar-preview-img');

    if (!nicknameInput || !identityInput) return;
    const newNickname = nicknameInput.value.trim();
    const newIdentity = identityInput.value.trim();
    const newPatPat = patpatInput ? patpatInput.value.trim() : '';
    const existing = safeReadJsonFromStorage('myProfile', null);

    const rawAvatar = avatarPreview && avatarPreview.dataset && avatarPreview.dataset.compressed
        ? avatarPreview.dataset.compressed
        : (avatarPreview ? avatarPreview.src : (existing?.avatar || ''));

    const saveToStorage = function(avatar) {
        const myProfile = {
            nickname: newNickname,
            identity: newIdentity,
            patPat: newPatPat,
            avatar: avatar
        };
        try {
            localStorage.setItem('myProfile', JSON.stringify(myProfile));
            try {
                const prevUi = safeReadJsonFromStorage('userInfo', null);
                const uiPayload = {
                    nickname: newNickname || (prevUi && prevUi.nickname) || '可点击编辑',
                    avatar: getFirstUsableAvatarUrl(avatar, prevUi && prevUi.avatar),
                    wechatId: (prevUi && prevUi.wechatId != null && String(prevUi.wechatId).trim())
                        ? String(prevUi.wechatId).trim()
                        : 'wx_id_...'
                };
                localStorage.setItem('userInfo', JSON.stringify(uiPayload));
                if (typeof Wechat !== 'undefined' && Wechat.ui && typeof Wechat.ui.syncWechatMeNameAndAvatar === 'function') {
                    Wechat.ui.syncWechatMeNameAndAvatar(uiPayload.nickname, uiPayload.avatar || '', uiPayload.wechatId);
                }
                if (typeof updateGlobalUserInfo === 'function') {
                    updateGlobalUserInfo(uiPayload.nickname, uiPayload.avatar || '');
                }
            } catch (e) {}
            showNotification('人设信息已更新');
            closeMyProfileModal();
        } catch (err) {
            if (err.name === 'QuotaExceededError') {
                showNotification('保存失败：头像图片过大，请换用更小的图片');
            } else {
                showNotification('保存失败');
            }
        }
    };

    if (rawAvatar && typeof rawAvatar === 'string' && rawAvatar.startsWith('data:')) {
        saveToStorage(rawAvatar);
    } else {
        compressImageDataUrl(rawAvatar, 256, 0.82).then(function(compressed) {
            saveToStorage(compressed);
        }).catch(function() {
            saveToStorage(rawAvatar);
        });
    }
}

// 当页面加载完成时初始化
window.addEventListener('load', function() {
    // 初始化可调整大小的文本框
    setTimeout(initResizeableTextareas, 100);

    // 启动过渡页：约 3 秒完成（2.1s 起渐隐 0.9s，后台并行加载数据），之后消失
    var splash = document.getElementById('splash-screen');
    if (splash) {
        setTimeout(function () {
            splash.classList.add('fade-out');
            setTimeout(function () { splash.style.display = 'none'; }, 900);
        }, 2100);
    }
});

// 当打开我的人设模态框时重新初始化
function showMyProfile() {
    const modal = document.getElementById('my-profile-modal');
    if (modal) {
        modal.classList.add('show');
        
        // 加载已保存的人设信息
        loadMyProfile();
        
        // 延迟初始化，确保模态框已经完全显示
        setTimeout(initResizeableTextareas, 100);
    }
}

// 零钱、支付密码、充值提现、亲属卡、支付方式：见 wechat-wallet.js
function getFriendName(friendId) {
    const friends = loadFriendsFromStorage();
    const f = friends.find(x => String(x.id) === String(friendId));
    return f ? (f.remark || f.nickname || '好友') : '好友';
}

// 聊天设置弹层、全局背景/气泡CSS/字体、showWechatSettingsPage：见 wechat-ui-settings.js

// 添加菜单项点击 / 点空白关菜单：见 wechat-ui.js · initWechatUiDom

// 打开添加好友模态框
function openAddFriendModal() {
    const modal = document.getElementById('add-friend-modal');
    if (modal) {
        modal.classList.add('show');
    }
}

// 关闭添加好友模态框
function closeAddFriendModal() {
    const modal = document.getElementById('add-friend-modal');
    if (modal) {
        modal.classList.remove('show');
        window._addFriendSelectedPersona = null;
    }
}

// 处理好友头像上传
// 已移除重复的 handleFriendAvatarUpload 函数，保留下面的完整实现

// 添加好友
async function addFriend() {
    try {
        await addFriendCore();
    } catch (e) {
        console.error('[添加好友] 未捕获异常:', e);
        showNotification('添加好友失败：' + (e && e.message ? e.message : String(e)));
    }
}

async function addFriendCore() {
    const nickname = document.getElementById('friend-nickname').value.trim();
    if (!nickname) {
        showNotification('请输入好友昵称');
        return;
    }
    
    const remark = document.getElementById('friend-remark').value.trim();
    const role = document.getElementById('friend-role').value.trim();
    
    try {
        if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
    } catch (e) {}

    // 保存好友信息到本地存储
    const friends = loadFriendsFromStorage();
    // 获取添加好友模态框中的头像占位符
    const addFriendModal = document.getElementById('add-friend-modal');
    const avatarPlaceholder = addFriendModal ? addFriendModal.querySelector('.avatar-placeholder') : null;
    const avatarStyle = avatarPlaceholder ? avatarPlaceholder.style.backgroundImage : '';
    perfLog('addFriend - 头像样式:', avatarStyle);
    
    // 清理头像数据：移除 url() 包装及首尾引号，兼容多种格式
    let cleanAvatar = normalizeAvatarUrl((avatarStyle || '').replace(/^url\s*\(\s*["']?|["']?\s*\)\s*$/g, '').trim());
    
    // 若未上传头像但有选中的角色卡，使用角色卡头像
    const addFriendPersona = window._addFriendSelectedPersona;
    let avatarToUse = getFirstUsableAvatarUrl(cleanAvatar, addFriendPersona && addFriendPersona.avatar);

    if (avatarToUse && /^\s*data:image\//i.test(avatarToUse) && typeof compressDataUrlImage === 'function') {
        try {
            avatarToUse = await compressDataUrlImage(avatarToUse, { maxDim: 720, quality: 0.8, mime: 'image/jpeg' });
        } catch (e) {}
    }

    let personaOut = null;
    if (addFriendPersona) {
        try {
            personaOut = JSON.parse(JSON.stringify(addFriendPersona));
        } catch (e) {
            console.error('[添加好友] 角色卡 JSON 克隆失败:', e);
            showNotification('角色卡数据无法保存，请从「我的人设」重新选择或精简角色卡后重试');
            return;
        }
        const pav = personaOut.avatar;
        if (pav && /^\s*data:image\//i.test(String(pav)) && typeof compressDataUrlImage === 'function') {
            try {
                personaOut.avatar = await compressDataUrlImage(String(pav), { maxDim: 720, quality: 0.8, mime: 'image/jpeg' });
            } catch (e) {}
        }
    }

    const newFriend = {
        id: Date.now(),
        nickname: nickname,
        remark: remark,
        roleSetting: role,
        avatar: avatarToUse,
        persona: personaOut
    };
    
    perfLog('addFriend - 新好友:', {
        ...newFriend,
        avatar: newFriend.avatar ? newFriend.avatar.substring(0, 50) + '...' : '无头像'
    });
    friends.push(newFriend);
    var savedOk =
        typeof saveFriendsToStorageAsync === 'function'
            ? await saveFriendsToStorageAsync(friends)
            : saveFriendsToStorage(friends);
    if (savedOk === false) {
        friends.pop();
        showNotification('保存失败：存储空间不足或写入出错，请清理聊天记录/图片后重试（大头像/长角色卡可先压缩或删减后再试）');
        return;
    }
    perfLog('addFriend - 保存后的好友列表:', friends.map(f => ({
        ...f,
        avatar: f.avatar ? f.avatar.substring(0, 50) + '...' : '无头像'
    })));
    
    // 显示成功提示
    showNotification('好友添加成功');
    
    // 关闭模态框
    closeAddFriendModal();
    
    // 清空表单
    document.getElementById('friend-nickname').value = '';
    document.getElementById('friend-remark').value = '';
    document.getElementById('friend-role').value = '';
    // 清空头像和选中的角色卡
    if (avatarPlaceholder) {
        avatarPlaceholder.style.backgroundImage = '';
        const avatarPlus = avatarPlaceholder.querySelector('.avatar-plus');
        if (avatarPlus) {
            avatarPlus.style.display = 'block';
        }
    }
    window._addFriendSelectedPersona = null;
    // 重置文件输入框，确保下次可以重新选择文件
    const fileInput = document.getElementById('friend-avatar-upload');
    if (fileInput) {
        fileInput.value = '';
    }
    
    // 刷新消息列表
    scheduleLoadChatList();
}


// loadChatList / scheduleLoadChatList / formatMessageTime：见 wechat-ui.js


function openTransferModal() {
    if (typeof isVoicePhoneCallActive === 'function' && isVoicePhoneCallActive()) {
        showNotification('语音通话中仅可发送文字消息');
        return;
    }
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('无法获取聊天对象');
        return;
    }
    const targetNameEl = document.getElementById('transfer-target-name');
    const balanceEl = document.getElementById('transfer-balance-display');
    const input = document.getElementById('transfer-amount-input');
    const errEl = document.getElementById('transfer-amount-error');
    const modal = document.getElementById('transfer-modal');
    if (!targetNameEl || !balanceEl || !input || !errEl || !modal) return;
    targetNameEl.textContent = getFriendName(friendId);
    balanceEl.textContent = getWalletBalance().toFixed(2);
    input.value = '';
    errEl.textContent = '';
    modal.classList.add('show');
}

function closeTransferModal() {
    const modal = document.getElementById('transfer-modal');
    const input = document.getElementById('transfer-amount-input');
    const errEl = document.getElementById('transfer-amount-error');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (errEl) errEl.textContent = '';
}

function confirmTransfer() {
    if (typeof isVoicePhoneCallActive === 'function' && isVoicePhoneCallActive()) {
        showNotification('语音通话中仅可发送文字消息');
        closeTransferModal();
        return;
    }
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('无法获取聊天对象');
        closeTransferModal();
        return;
    }
    const input = document.getElementById('transfer-amount-input');
    const errEl = document.getElementById('transfer-amount-error');
    if (!input || !errEl) return;
    const amount = parseFloat(input.value);
    if (isNaN(amount) || amount <= 0) {
        errEl.textContent = '请输入有效金额';
        return;
    }
    const walletBalance = getWalletBalance();
    if (amount > walletBalance) {
        errEl.textContent = '余额不足，当前余额 ¥' + walletBalance.toFixed(2);
        return;
    }
    closeTransferModal();
    requirePaymentPassword(amount, '转账', function() {
        deductFromWallet(amount);
        const content = String(amount.toFixed(2));
        const timestamp = new Date().getTime();
        saveChatMessage(friendId, 'user', content, null, timestamp, 'transfer', 'pending');
        loadChatHistory(friendId);
        showNotification('转账已发送，等待对方确认');
    }, function() {
        closeTransferModal();
    });
}

// 重回：删除末尾连续的好友回复（不删用户消息），再按与「接收」相同的 API 组装方式重新请求并写入新回复
function redoFriendReply() {
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage ? chatPage.dataset.friendId : null;
    if (!friendId) {
        showNotification('无法重回');
        return;
    }
    if (isReceiving) {
        showNotification('正在接收中，请稍候或先取消');
        return;
    }
    let settings = {};
    try {
        settings = JSON.parse(localStorage.getItem('apiSettings') || '{}');
    } catch (e) {
        settings = {};
    }
    if (!settings.apiUrl || !settings.apiKey || !settings.model) {
        showNotification('请先在设置中配置API');
        return;
    }

    const chatHistory = parseJsonFromPossiblyEncodedStorage(`chatHistory_${friendId}`, []);
    if (chatHistory.length === 0) {
        showNotification('没有可重回的聊天记录');
        return;
    }
    if (chatHistory[chatHistory.length - 1].type !== 'friend') {
        showNotification('没有可重回的好友回复');
        return;
    }
    let end = chatHistory.length - 1;
    while (end >= 0 && chatHistory[end].type === 'friend') {
        end--;
    }
    if (end < 0) {
        showNotification('无法重回');
        return;
    }
    const updatedHistory = chatHistory.slice(0, end + 1);
    if (!updatedHistory.some((m) => m.type === 'user')) {
        showNotification('无法重回：缺少对应的用户消息');
        return;
    }

    replaceChatHistoryAndPersist(friendId, updatedHistory);
    syncFriendPreviewFromChatHistoryEnd(friendId, updatedHistory);
    loadChatHistory(friendId);
    Promise.resolve(typeof loadChatList === 'function' ? loadChatList() : undefined).catch(function () {});

    const receiveBtn = document.querySelector('.receive-btn');
    if (!receiveBtn) {
        showNotification('界面异常，请重试');
        return;
    }
    const prevListen = listenTogetherActive;
    listenTogetherActive = false;
    try {
        receiveBtn.click();
    } finally {
        listenTogetherActive = prevListen;
    }
}

// onMoreItemClick：见 wechat-ui.js


// 打开位置分享弹窗
function openLocationModal() {
    closeMorePanel();
    const modal = document.getElementById('location-modal');
    const placeInput = document.getElementById('location-place-name');
    const addressInput = document.getElementById('location-address');
    if (modal && placeInput && addressInput) {
        placeInput.value = '';
        addressInput.value = '';
        modal.classList.add('show');
    }
}

// 关闭位置分享弹窗
function closeLocationModal() {
    const modal = document.getElementById('location-modal');
    if (modal) modal.classList.remove('show');
}

function openPhotoCardModal() {
    closeMorePanel();
    const modal = document.getElementById('photo-card-modal');
    const textarea = document.getElementById('photo-card-description');
    if (modal && textarea) {
        textarea.value = '';
        modal.classList.add('show');
        setTimeout(() => textarea.focus(), 100);
    }
}

function closePhotoCardModal() {
    const modal = document.getElementById('photo-card-modal');
    if (modal) modal.classList.remove('show');
}

function confirmPhotoCardSend() {
    const textarea = document.getElementById('photo-card-description');
    const description = (textarea?.value || '').trim();
    if (!description) {
        showNotification('请用文字描述这张照片的画面');
        return;
    }
    closePhotoCardModal();
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage?.dataset?.friendId;
    if (!friendId) {
        showNotification('未找到当前聊天');
        return;
    }
    const timestamp = Date.now();
    displayMessage('user', description, null, timestamp, null, 'photo_card');
    saveChatMessage(friendId, 'user', description, null, timestamp, 'photo_card');
    showNotification('照片已发送');
}

// 确认发送位置
function confirmLocationShare() {
    const placeInput = document.getElementById('location-place-name');
    const addressInput = document.getElementById('location-address');
    const placeName = (placeInput?.value || '').trim();
    const address = (addressInput?.value || '').trim();
    if (!placeName && !address) {
        showNotification('请至少输入地点名称或详细地址');
        return;
    }
    closeLocationModal();
    const chatPage = document.getElementById('chat-page');
    const friendId = chatPage?.dataset?.friendId;
    if (!friendId) {
        showNotification('未找到当前聊天');
        return;
    }
    const locationText = address ? `${placeName || '位置'}\n${address}` : (placeName || address);
    const timestamp = new Date().getTime();
    displayMessage('user', locationText, null, timestamp, null, 'location');
    saveChatMessage(friendId, 'user', locationText, null, timestamp, 'location');
    showNotification('位置已发送');
}

// 兼容旧书单，供现有聊天在提到这些书时读取读后感
function loadReadTogetherBooks(friendId) {
    if (!friendId) return [];
    try {
        const raw = localStorage.getItem(`readTogether_${friendId}`);
        if (!raw) return [];
        const data = JSON.parse(raw);
        return Array.isArray(data.books) ? data.books : [];
    } catch (e) { return []; }
}

// 从用户消息中检测提到的书籍（与保存的一起看书书单匹配）
function findMentionedBooksFromMessages(friendId, messageContents) {
    const saved = loadReadTogetherBooks(friendId);
    if (!saved.length) return [];
    const contents = Array.isArray(messageContents) ? messageContents : [String(messageContents || '')];
    const mentioned = [];
    saved.forEach(book => {
        const title = (book.title || '').trim();
        if (!title) return;
        const hasMatch = contents.some(c => {
            const text = String(c || '').replace(/<[^>]+>/g, '');
            return text.includes(title) || text.includes('《' + title + '》');
        });
        if (hasMatch && !mentioned.find(m => m.title === title)) mentioned.push(book);
    });
    return mentioned;
}

// 去除好友回复中不应存在的整条包裹式双引号（仅当整条消息被引号包住时去除；引用他人时的内部引号保留）
function stripUnnecessaryOuterQuotes(text) {
    if (!text || typeof text !== 'string') return text;
    const t = text.trim();
    if (t.length < 2) return t;
    // 英文双引号 " " 或中文双引号 " "
    if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith('"') && t.endsWith('"'))) {
        return t.slice(1, -1).trim();
    }
    // 直角引号 「 」
    if (t.startsWith('「') && t.endsWith('」')) {
        return t.slice(1, -1).trim();
    }
    return t;
}

/** 截取点若落在未闭合的英文/中文括号内，则顺延到闭合之后，避免「）」单独成条 */
function adjustSplitEndForBalancedParens(text, end) {
    if (!text || end <= 0) return end;
    let depth = 0;
    const lim = Math.min(end, text.length);
    for (let i = 0; i < lim; i++) {
        const c = text[i];
        if (c === '(' || c === '（') depth++;
        else if (c === ')' || c === '）') depth = Math.max(0, depth - 1);
    }
    if (depth === 0) return Math.min(end, text.length);
    let j = lim;
    const cap = Math.min(text.length, lim + 500);
    while (depth > 0 && j < cap) {
        const c = text[j];
        if (c === '(' || c === '（') depth++;
        else if (c === ')' || c === '）') depth--;
        j++;
    }
    return j;
}

/** 在 UTF-16 上截取前调整 end，避免在代理对（增补汉字/emoji 等）中间切开导致界面出现 � */
function ensureUtf16SafeStringSplitEnd(str, end) {
    if (end <= 0) return 0;
    if (end >= str.length) return str.length;
    const a = str.charCodeAt(end - 1);
    const b = str.charCodeAt(end);
    if (a >= 0xd800 && a <= 0xdbff && b >= 0xdc00 && b <= 0xdfff) {
        return end + 1;
    }
    return end;
}

function countSentenceEndsInLine(line) {
    const t = String(line || '').trim();
    if (!t) return 0;
    const m = t.match(/[。！？!?]|\.(?=\s|$|\s*[\(（])/g);
    return Math.max(1, m ? m.length : 1);
}

/** 整行仅为括号内翻译（英文下一句换行的中文），不计入「句数」上限，避免与上一行英文拆成两条气泡 */
function isLikelyParenTranslationLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    return /^[\(（][\s\S]*[\)）]\s*$/.test(t);
}

/**
 * 从一段文本中提取文字部分与拍立得 HTML 部分，返回 { text, polaroid }。
 * text  为去除 HTML 标签后的纯文字（不含 wechat-polaroid-wrap 等卡片结构），
 * polaroid 为独立的拍立得 HTML 片段（仅含 <div class="wechat-polaroid-wrap"...）。
 * 二者不重叠，均可能为空字符串。
 */
function extractPolaroidFromText(raw) {
    const s = String(raw || '');
    if (!s) return { text: '', polaroid: '' };
    if (!/<div/i.test(s)) return { text: s, polaroid: '' };

    // ── 1. 收集所有 wechat-polaroid-wrap 完整块 ──────────────────────────
    const pwRe = /<div\b[^>]*\bclass\s*=\s*["'][^"']*wechat-polaroid[^"']*["'][^>]*>[\s\S]*?<\/div>/gi;
    const pieces = [];
    let lastIdx = 0;
    let m;
    const foundPolaroids = [];
    while ((m = pwRe.exec(s)) !== null) {
        pieces.push({ start: lastIdx, end: m.index });
        foundPolaroids.push(m[0]);
        lastIdx = pwRe.lastIndex;
    }
    pieces.push({ start: lastIdx, end: s.length });

    // ── 2. 提取关联的 <style>（含有 .wechat-polaroid 等关键选择器）───────
    //    一并收集，避免 <style> 单独成条气泡
    const styleRe = /<style\b[^>]*>([\s\S]*?)<\/style>/gi;
    const extraStyles = [];
    while ((m = styleRe.exec(s)) !== null) {
        const content = m[1];
        // 只要含有拍立得相关选择器就保留
        if (/\bwechat-polaroid|\.wechat-msg-polaroid|\.polaroid-avatar/i.test(content)) {
            extraStyles.push(m[0]);
        }
    }

    // ── 3. 合并：polaroid HTML + 关联 style ──────────────────────────────
    const allPolaroidParts = [...foundPolaroids, ...extraStyles];
    const polaroid = allPolaroidParts.length > 0 ? allPolaroidParts.join('\n') : '';

    // ── 4. 文字部分（排除已摘走的 polaroid 与 style 区域）───────────────
    //    记录所有被摘走片段的区间（按 end 排序后从后往前擦除）
    const removedRanges = [];
    // wechat-polaroid-wrap 区间
    pwRe.lastIndex = 0;
    while ((m = pwRe.exec(s)) !== null) {
        removedRanges.push({ start: m.index, end: pwRe.lastIndex });
    }
    // style 区间
    styleRe.lastIndex = 0;
    while ((m = styleRe.exec(s)) !== null) {
        removedRanges.push({ start: m.index, end: styleRe.lastIndex });
    }
    // 按 end 从大到小排序，从后往前擦除（不影响前面的索引）
    removedRanges.sort((a, b) => b.end - a.end);
    let textBase = s;
    for (const r of removedRanges) {
        textBase = textBase.slice(0, r.start) + textBase.slice(r.end);
    }

    const plainText = textBase
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;|&#160;/gi, ' ')
        .replace(/&amp;|&#39;|&lt;|&gt;|&quot;/g, ' ')
        .replace(/\s{2,}/g, ' ')
        .trim();

    return { text: plainText, polaroid: polaroid };
}

/**
 * 判断一段内容是否「仅含」拍立得 HTML（无实质文字描述），
 * 应作为独立图片消息处理，不归入文字气泡。
 */
function isPolaroidOnlyMessage(raw) {
    const s = String(raw || '').trim();
    if (!s) return false;
    const { text } = extractPolaroidFromText(s);
    // 去掉空格标点后无实质文字
    const bare = text.replace(/[\s\u200b\p{P}]/gu, '');
    return bare.length === 0 && /wechat-polaroid/i.test(s);
}

/**
 * 判断单行是否像模型「思维链 / 格式自检 / 英文角色笔记」而非微信对白。
 */
function _isWechatApiCoTMetaLine(L) {
    if (!L || typeof L !== 'string') return false;
    const t = L.trim();
    if (!t) return false;
    if (/\bchecks?\)\s*[:*]*\s*-?\s*\d+\s*messages?\b/i.test(t)) return true;
    if (/\bchecks?\)\s*:\s*\*\*/i.test(t)) return true;
    if (/^\s*[-*•]\s*No quotes\b/i.test(t)) return true;
    if (/^\s*[-*•]\s*English followed by/i.test(t)) return true;
    if (/^\s*[-*•]\s*[A-Za-z0-9]+(?:'s|')?\s*personality\s*:/i.test(t)) return true;
    if (/^\s*[-*•]\s*Mentioning (?:he|she|his|her|the |that |it )\b/i.test(t)) return true;
    if (/^\s*[-*•]\s*User (?:asked|said|wants|is |message)\b/i.test(t)) return true;
    if (/^\s*[-*•]\s*Output (?:must|should|only|will)\b/i.test(t)) return true;
    if (/^\s*[-*•]\s*(?:Ensure |Do not |Must not |Should not |Keep the |Remember to )\b/i.test(t)) return true;
    if (/formatting instructions|output constraints|chain[- ]of[- ]thought|\bCoT\b/i.test(t)) return true;
    if (/^#{1,6}\s*(Reasoning|Analysis|Thinking|Plan|Notes)\b/i.test(t)) return true;
    if (/^\s*```\s*(?:think|thinking|reasoning|analysis)/i.test(t)) return true;
    if (/^\s*[-*•]\s*(?:I'll |I will |I need to |Let's |First, |Second, )\b/i.test(t) && /(?:reply|output|character|roleplay|JSON|format)/i.test(t)) return true;
    // 常见中文「思维链 / 自检 / 草稿区」单行（排除普通对白里偶发用词）
    if (/^(?:\*{1,2})?\s*(?:思考|推演|自检|校对|草稿|提纲|内心戏(?:过程)?|思维链(?:过程)?)[:：…\.]\s*$/.test(t)) return true;
    if (/^(?:\*{1,2})?\s*(?:思考|推演|自检|草稿|提纲)[:：]/.test(t) && (!/[。！？…」』"]$/.test(t) || /^[*•\-\d]+\s*\S{0,40}$/.test(t))) return true;
    if (/^【(?:思考|推演|自检|草稿|提纲|推理|备注|INTERNAL)】/.test(t)) return true;
    if (/^\[(?:Thought|Thinking|INTERNAL|scratchpad|草稿|思考)\]/i.test(t)) return true;
    if (/^(?:步骤|STEP)\s*\d+[:：．.]/.test(t) && /(?:输出|回复|JSON|符合|规范|用户)/.test(t)) return true;
    return false;
}

/**
 * 去掉 ```thinking / ```cot 一类围栏块（常见于模型漏出的中间格式）。
 */
function stripWechatThoughtCodeFences(s) {
    let t = String(s == null ? '' : s);
    let prev;
    do {
        prev = t;
        t = t.replace(
            /```[^\S\r\n]*(?:think|thinking|reasoning|cot|scratchpad|analysis|reflection|budget_thinking|thought|草稿|思考|推演)[^\S\r\n]*(?:\r?\n|\s)[\s\S]*?```/gim,
            ''
        );
    } while (t !== prev);
    return t.trim();
}

/**
 * 去掉各类「思维链」标签块（含未闭合尾段），与 sanitize 逻辑保持一致。
 */
function stripWechatCoTXmlBlocks(s) {
    let t = String(s == null ? '' : s);
    const pair = new RegExp(
        '<\\s*(?:think|thinking|reasoning|redacted_reasoning|redacted_thinking|analysis|thought|reflection|budget_thinking|WORKFLOW|workflow)\\s*>[\\s\\S]*?<\\s*\\/\\s*(?:think|thinking|reasoning|redacted_reasoning|redacted_thinking|analysis|thought|reflection|budget_thinking|WORKFLOW|workflow)\\s*>',
        'gi'
    );
    let prev;
    do {
        prev = t;
        t = t.replace(pair, '');
    } while (t !== prev);
    t = t.replace(
        /<\s*(?:think|thinking|reasoning|redacted_reasoning|redacted_thinking|analysis|thought|reflection|budget_thinking)\b[^>]*>[\s\S]*$/gi,
        ''
    );
    return t;
}

/**
 * DeepSeek Reasoner 等：换行后以 `think`（反引号包裹）分隔推理段与对用户可见正文。
 */
function stripWechatTrailingCoTDelimiter(original) {
    const t = String(original == null ? '' : original);
    const delimRe = new RegExp('\\r?\\n\\s*(?:\\r?\\n\\s*)*`think`', 'i');
    const m = delimRe.exec(t);
    if (!m || m.index < 24) return t;
    const tail = t.slice(m.index + m[0].length).replace(/^\s+/, '');
    return tail.length >= 3 ? tail : t;
}

function _wechatApiParagraphLooksLikeEnglishOnlyCoT(text) {
    const t = String(text || '').trim();
    if (!t || t.length > 600) return false;
    const cjk = (t.match(/[\u4e00-\u9fff]/g) || []).length;
    if (cjk >= 8) return false;
    return /\b(personality|pragmatic|formatting|armory|rifle|mentioning|without breaking|rather than|shows his|consistent with)\b/i.test(t);
}

function _fallbackBestWechatChatParagraph(original) {
    const paras = String(original)
        .split(/\n{2,}/)
        .map((p) => p.trim())
        .filter(Boolean);
    const candidates = paras.filter((p) => {
        if (_wechatApiParagraphLooksLikeEnglishOnlyCoT(p)) return false;
        const lines = p.split(/\n/).map((l) => l.trim()).filter(Boolean);
        if (lines.length && lines.every((l) => _isWechatApiCoTMetaLine(l))) return false;
        if (/[\u4e00-\u9fff]/.test(p)) return true;
        if (p.length >= 20 && !/^\s*[-*•]/.test(p) && !/\bpersonality\s*:/i.test(p)) return true;
        return false;
    });
    if (!candidates.length) return String(original).trim();
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0];
}

/**
 * 从微信「接收/好友回复」API 原始输出中移除思维链标签、英文自检与角色设计笔记等，
 * 避免误入聊天气泡。供 splitApiResponseIntoMessages 与群聊 JSON 抽取前使用。
 * opts.noOriginalFallback：单条气泡二次清洗时若为 true，不向原文回退（避免漏网思维链回灌）。
 */
function sanitizeWechatFriendApiResponseText(raw, opts) {
    const original = String(raw == null ? '' : raw);
    if (!original.trim()) return original;
    const noOriginalFallback = !!(opts && opts.noOriginalFallback);

    const replyTagged = original.match(/<reply\s*>([\s\S]*?)<\/reply\s*>/i);
    if (replyTagged && replyTagged[1].trim().length > 2) {
        let innerRaw = stripWechatTrailingCoTDelimiter(replyTagged[1].trim());
        let inner = stripWechatCoTXmlBlocks(innerRaw).trim();
        inner = stripWechatThoughtCodeFences(inner);
        const lf = sanitizeWechatFriendApiResponseLineFilter(inner);
        const ok = lf && lf.length > 2;
        if (ok) return lf;
        return noOriginalFallback ? lf : replyTagged[1].trim();
    }

    let s = stripWechatTrailingCoTDelimiter(original);

    s = stripWechatThoughtCodeFences(stripWechatCoTXmlBlocks(s)).trim();

    let out = sanitizeWechatFriendApiResponseLineFilter(s);

    if (!out || out.length < 2) {
        if (noOriginalFallback) return '';
        return _fallbackBestWechatChatParagraph(original);
    }
    if (_wechatApiParagraphLooksLikeEnglishOnlyCoT(out) && /[\u4e00-\u9fff]/.test(original)) {
        const fb = _fallbackBestWechatChatParagraph(original);
        if (fb && fb.length > out.length * 0.85) return fb;
    }
    return out;
}

function sanitizeWechatFriendApiResponseLineFilter(s) {
    const lines = String(s == null ? '' : s).split(/\n/);
    const kept = [];
    for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const L = line.trim();
        if (!L) {
            kept.push('');
            continue;
        }
        if (_isWechatApiCoTMetaLine(L)) continue;
        kept.push(line);
    }
    return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/** 发往聊天气泡前再清一次漏网的思维链/标签杂讯（不改变拍立得等 HTML）。 */
function sanitizeWechatOutgoingBubbleBody(body, friendSubtype) {
    let s = String(body == null ? '' : body);
    if (!s.trim()) return s;
    if (friendSubtype === 'photo_card' && /wechat-polaroid/i.test(s)) {
        return stripWechatThoughtCodeFences(stripWechatCoTXmlBlocks(s)).trimEnd();
    }
    if (typeof looksLikeHtml === 'function' && looksLikeHtml(s) && !/\bwechat-polaroid\b/i.test(s)) {
        return stripWechatThoughtCodeFences(stripWechatCoTXmlBlocks(s)).trimEnd();
    }
    return sanitizeWechatFriendApiResponseText(s, { noOriginalFallback: true });
}

/**
 * 从文本开头切出第一个完整 `{...}` 并 JSON.parse（支持后面还粘着对白）。
 * 单引号包串、未闭合括号等情况返回 null。
 */
function tryParseLeadingJsonObject(text) {
    const s = String(text || '').trim();
    if (!s.startsWith('{')) return null;
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = 0; i < s.length; i++) {
        const c = s[i];
        if (inStr) {
            if (esc) {
                esc = false;
                continue;
            }
            if (c === '\\') {
                esc = true;
                continue;
            }
            if (c === '"') inStr = false;
            continue;
        }
        if (c === '"') {
            inStr = true;
            continue;
        }
        if (c === '{') depth++;
        else if (c === '}') {
            depth--;
            if (depth === 0) {
                const jsonStr = s.slice(0, i + 1);
                const rest = s.slice(i + 1).trim();
                try {
                    const parsed = JSON.parse(jsonStr);
                    return { parsed, rest, jsonSource: jsonStr };
                } catch (e) {
                    return null;
                }
            }
        }
    }
    return null;
}

function tryParseLeadingFinanceJsonPayload(text) {
    const lead = tryParseLeadingJsonObject(text);
    if (!lead) return null;
    const typ = String(lead.parsed.type || '').trim();
    if (typ !== 'transfer' && typ !== 'redpacket') return null;
    return lead;
}

/**
 * 单条气泡文本若以微信资金 JSON 开头则解析为结构化子类型（Char→User 转账/红包）。
 */
function normalizeFriendFinanceJsonBubbleIfAny(text) {
    const t = String(text || '').trim();
    if (!t.startsWith('{')) return null;
    let parsed = null;
    try {
        parsed = JSON.parse(t);
    } catch (e) {
        const lead = tryParseLeadingJsonObject(t);
        if (!lead) return null;
        parsed = lead.parsed;
    }
    const typ = String(parsed.type || '').trim();
    if (typ === 'transfer') {
        return {
            body: String(parsed.content || '').trim(),
            subtype: 'friend_transfer',
            extra: {}
        };
    }
    if (typ === 'redpacket') {
        return {
            body: String(parsed.content || '').trim(),
            subtype: 'redpacket',
            extra: { redpacketMsg: String(parsed.message || '').trim() }
        };
    }
    return null;
}

/**
 * 将「微信资金 JSON + 后续正文」拆成多条消息，避免 JSON.parse 整段失败导致红包/转账以纯文本显示。
 */
function expandMessagesSplitLeadingFinanceJson(messages) {
    if (!Array.isArray(messages) || !messages.length) return messages;
    const out = [];
    for (let i = 0; i < messages.length; i++) {
        const msg = messages[i];
        if (msg && msg.polaroidOnly) {
            out.push(msg);
            continue;
        }
        const raw = typeof msg === 'string' ? msg : msg && msg.content != null ? msg.content : '';
        const lead = tryParseLeadingFinanceJsonPayload(raw);
        if (!lead) {
            out.push(msg);
            continue;
        }
        const wrap = (text) =>
            typeof msg === 'string' ? text : Object.assign({}, msg, { content: text });
        out.push(wrap(lead.jsonSource));
        const tail = lead.rest ? String(lead.rest).trim() : '';
        if (tail) out.push(wrap(tail));
    }
    return out;
}

/**
 * 将 API 返回的完整消息文本拆分为独立消息数组。
 * 关键规则：文字+拍立得 HTML 共存时，拆成「文字消息 + 拍立得消息」两条；
 * 纯文字/纯 HTML 各一条；避免文字消息里夹带 HTML 结构。
 * 重要：含 wechat-polaroid 的回复在行拆分前先提取 polaroid，避免 <style> 被切碎。
 * 返回值中：polaroidOnly === true 表示该条目为独立图片消息，content 为拍立得 HTML。
 */
function splitApiResponseIntoMessages(responseText) {
    if (!responseText || responseText.trim() === '') {
        return [];
    }
    let trimmed = responseText.trim();
    const sanitized = sanitizeWechatFriendApiResponseText(trimmed);
    if (sanitized && sanitized.length > 0) trimmed = sanitized;

    // ── 含 wechat-polaroid 时：先提取 polaroid 再分段，防止 <style> 被 \n+ 切碎 ──
    const hasPolaroid = /wechat-polaroid/i.test(trimmed);
    let preExtractedPolaroid = '';

    if (hasPolaroid) {
        const { text, polaroid } = extractPolaroidFromText(trimmed);
        preExtractedPolaroid = polaroid;
        // 用剔除 polaroid 后的纯文字走后续分段逻辑
        const afterRemove = text;
        if (!afterRemove.trim()) {
            // 只有 polaroid，无文字 → 直接返回一条图片消息
        return expandMessagesSplitLeadingFinanceJson(
            preExtractedPolaroid ? [{ content: preExtractedPolaroid, polaroidOnly: true }] : []
        );
        }
        // 注意：这里不直接返回，而是继续走下面的段落拆分逻辑（只用纯文字部分）
        // 为了不让 polaroid 被行拆分破坏，我们把 polaroid 暂时从 trimmed 里"挖掉"
        // 用一个占位符代替，稍后在合并结果时再塞回去
        const safeText = afterRemove;
        return splitApiResponseIntoMessagesWithPolaroid(safeText, preExtractedPolaroid);
    }

    // ── 普通 HTML（不含拍立得）直接返回 ────────────────────────────────
    if (typeof looksLikeHtml === 'function' && looksLikeHtml(trimmed) && !/wechat-polaroid/i.test(trimmed)) {
        return expandMessagesSplitLeadingFinanceJson([
            { content: stripUnnecessaryOuterQuotes(trimmed), polaroidOnly: false }
        ]);
    }

    const maxWordsPerMessage = 160;
    const maxSentencesPerMessage = 2;

    const paragraphs = trimmed.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    const inner = paragraphs.length > 1
        ? paragraphs.flatMap(p => splitApiResponseIntoMessagesInner(p, maxWordsPerMessage, maxSentencesPerMessage))
        : splitApiResponseIntoMessagesInner(trimmed, maxWordsPerMessage, maxSentencesPerMessage);

    const result = [];
    for (const raw of inner) {
        const stripped = stripUnnecessaryOuterQuotes(String(raw || ''));
        if (!stripped) continue;
        if (isPolaroidOnlyMessage(stripped)) {
            result.push({ content: stripped, polaroidOnly: true });
            continue;
        }
        const { text, polaroid } = extractPolaroidFromText(stripped);
        if (text && polaroid) {
            result.push({ content: text, polaroidOnly: false });
            result.push({ content: polaroid, polaroidOnly: true });
        } else if (polaroid) {
            result.push({ content: polaroid, polaroidOnly: true });
        } else {
            result.push({ content: text || stripped, polaroidOnly: false });
        }
    }
    return expandMessagesSplitLeadingFinanceJson(result);
}

/**
 * 含拍立得回复的专用拆分逻辑：纯文字部分走标准段落拆分，最后追加一条拍立得消息。
 * polaroidHtml 若非空，会作为最后一条（polaroidOnly: true）消息返回。
 */
function splitApiResponseIntoMessagesWithPolaroid(pureText, polaroidHtml) {
    const maxWordsPerMessage = 160;
    const maxSentencesPerMessage = 2;

    const paragraphs = pureText.split(/\n{2,}/).map(s => s.trim()).filter(Boolean);
    const inner = paragraphs.length > 1
        ? paragraphs.flatMap(p => splitApiResponseIntoMessagesInner(p, maxWordsPerMessage, maxSentencesPerMessage))
        : splitApiResponseIntoMessagesInner(pureText, maxWordsPerMessage, maxSentencesPerMessage);

    const result = [];
    for (const raw of inner) {
        const stripped = stripUnnecessaryOuterQuotes(String(raw || ''));
        if (!stripped) continue;
        // 纯拍立得段落 → 整条作为图片消息
        if (isPolaroidOnlyMessage(stripped)) {
            result.push({ content: stripped, polaroidOnly: true });
            continue;
        }
        // 这里 raw 是纯文字（polaroid 已被 extractPolaroidFromText 剔掉），直接保留
        result.push({ content: stripped, polaroidOnly: false });
    }

    // 最后追加拍立得消息（不重复追加）
    if (polaroidHtml) {
        result.push({ content: polaroidHtml, polaroidOnly: true });
    }
    return expandMessagesSplitLeadingFinanceJson(result);
}

function splitApiResponseIntoMessagesInner(responseText, maxWordsPerMessage, maxSentencesPerMessage) {
    const messages = [];
    let parts = responseText.split(/\n+/).filter(part => part.trim() !== '');
    if (parts.length === 0) parts = [responseText];

    let currentMessage = '';
    let currentSentences = 0;

    for (const part of parts) {
        const trimmedPart = part.trim();
        const sentenceCount = isLikelyParenTranslationLine(trimmedPart)
            ? 0
            : countSentenceEndsInLine(trimmedPart);
        const newLength = (currentMessage ? currentMessage + '\n' + trimmedPart : trimmedPart).length;

        if (currentMessage !== '' &&
            (newLength > maxWordsPerMessage || currentSentences + sentenceCount > maxSentencesPerMessage)) {
            messages.push(currentMessage.trim());
            currentMessage = trimmedPart;
            currentSentences = sentenceCount;
        } else {
            if (currentMessage !== '') currentMessage += '\n';
            currentMessage += trimmedPart;
            currentSentences += sentenceCount;
            if (currentMessage.length > maxWordsPerMessage || currentSentences > maxSentencesPerMessage) {
                const subMessages = splitLongMessage(currentMessage, maxWordsPerMessage, maxSentencesPerMessage);
                messages.push(...subMessages.slice(0, -1));
                const last = subMessages[subMessages.length - 1];
                currentMessage = last || '';
                currentSentences = countSentenceEndsInLine(currentMessage);
            }
        }
    }
    if (currentMessage.trim() !== '') {
        messages.push(currentMessage.trim());
    }
    return messages.length ? messages : splitLongMessage(responseText, maxWordsPerMessage, maxSentencesPerMessage);
}

// 拆分长消息（英文句末 . 亦算断句；不在括号中间硬切）
function splitLongMessage(text, maxLength, maxSentences) {
    const messages = [];
    let remainingText = String(text || '').trim();
    if (!remainingText) return messages;

    while (remainingText.length > 0) {
        if (remainingText.length <= maxLength) {
            messages.push(remainingText);
            break;
        }
        let endIndex = Math.min(remainingText.length, maxLength);
        let sentences = 0;
        let lastSentenceEnd = -1;

        for (let i = 0; i < endIndex; i++) {
            const ch = remainingText[i];
            const next = remainingText[i + 1];
            let isEnd = false;
            if (/[。！？!?]/.test(ch)) isEnd = true;
            else if (ch === '.' && (next === undefined || /\s/.test(next))) isEnd = true;
            else if (ch === '.' && (next === '(' || next === '（'))
                isEnd = true;
            if (isEnd) {
                sentences++;
                lastSentenceEnd = i + 1;
                if (sentences >= maxSentences) {
                    endIndex = i + 1;
                    break;
                }
            }
        }

        if (sentences < maxSentences && lastSentenceEnd > 0) {
            endIndex = lastSentenceEnd;
        }

        if (sentences === 0 || endIndex === 0) {
            for (let i = endIndex; i > Math.max(0, endIndex - 80); i--) {
                if (!/[，,；;\s　\t]/.test(remainingText[i])) continue;
                let depth = 0;
                for (let k = 0; k < i; k++) {
                    const c = remainingText[k];
                    if (c === '(' || c === '（') depth++;
                    else if (c === ')' || c === '）') depth = Math.max(0, depth - 1);
                }
                if (depth === 0) {
                    endIndex = i + 1;
                    break;
                }
            }
        }

        endIndex = adjustSplitEndForBalancedParens(remainingText, endIndex);
        endIndex = ensureUtf16SafeStringSplitEnd(remainingText, endIndex);
        endIndex = Math.max(1, Math.min(endIndex, remainingText.length));
        let piece = remainingText.substring(0, endIndex).trim();
        if (!piece) {
            endIndex = Math.min(remainingText.length, Math.max(1, maxLength));
            piece = remainingText.substring(0, endIndex).trim();
        }
        if (piece) messages.push(piece);
        remainingText = remainingText.substring(endIndex).trim();
        if (!remainingText && !piece) break;
    }
    return messages;
}

// 好友设置 / 群设置：见 wechat-ui-profile.js


// 实现可调整大小的输入框功能
document.addEventListener('DOMContentLoaded', function() {
    const resizeHandles = document.querySelectorAll('.resize-handle');
    
    resizeHandles.forEach(handle => {
        let isResizing = false;
        let startX, startY, startWidth, startHeight;
        
        handle.addEventListener('mousedown', function(e) {
            isResizing = true;
            startX = e.clientX;
            startY = e.clientY;
            
            const textarea = this.parentElement.querySelector('.resizeable-textarea');
            const container = this.parentElement;
            startWidth = container.offsetWidth;
            startHeight = container.offsetHeight;
            
            // 防止默认行为和冒泡
            e.preventDefault();
            
            // 添加鼠标移动和释放事件监听器
            document.addEventListener('mousemove', resize);
            document.addEventListener('mouseup', stopResize);
        });
        
        function resize(e) {
            if (!isResizing) return;
            
            const textarea = handle.parentElement.querySelector('.resizeable-textarea');
            const container = handle.parentElement;
            
            // 计算新的尺寸
            const newWidth = startWidth + (e.clientX - startX);
            const newHeight = startHeight + (e.clientY - startY);
            
            // 应用最小和最大尺寸限制
            const minWidth = container.parentElement.offsetWidth;
            const minHeight = 100;
            const maxWidth = container.parentElement.offsetWidth;
            const maxHeight = 250;
            
            const finalWidth = Math.min(Math.max(newWidth, minWidth), maxWidth);
            const finalHeight = Math.min(Math.max(newHeight, minHeight), maxHeight);
            
            // 更新容器和文本区域尺寸
            container.style.width = finalWidth + 'px';
            container.style.height = finalHeight + 'px';
            textarea.style.width = finalWidth + 'px';
            textarea.style.height = finalHeight + 'px';
        }
        
        function stopResize() {
            isResizing = false;
            // 移除事件监听器
            document.removeEventListener('mousemove', resize);
            document.removeEventListener('mouseup', stopResize);
        }
    });
    
    // 为聊天头像占位符添加点击事件
    const chatAvatarPlaceholder = document.querySelector('.chat-avatar-placeholder');
    if (chatAvatarPlaceholder) {
        chatAvatarPlaceholder.addEventListener('click', function() {
            const fileInput = this.querySelector('input[type="file"]');
            if (fileInput) {
                fileInput.click();
            }
        });
    }
});

// 页面加载完成后初始化（系统好友已在 DOMContentLoaded 中 await 预加载，此处仅防抖刷新列表）
window.onload = function() {
    initClock();

    scheduleLoadChatList();
    
    // 绑定API输入事件
    const apiUrlInput = document.getElementById('api-url');
    const apiKeyInput = document.getElementById('api-key');
    
    if (apiUrlInput) {
        apiUrlInput.addEventListener('input', checkApiInputs);
    }
    
    if (apiKeyInput) {
        apiKeyInput.addEventListener('input', checkApiInputs);
    }
    
    // 加载模型列表
    loadModelList();

    // API 表单与 localStorage 已在 DOMContentLoaded 中由 loadApiSettings() 同步；此处切勿再次覆写输入框，
    // 否则在 window.onload 晚于用户编辑时会把「模型名称」等字段刷回旧值，表现为保存无效或跳回旧模型。

    try {
        checkApiInputs();
    } catch (e) {}

    try { initApiSettingsFormDirtyTracking(); } catch (e) {}

    // 绑定模型选择事件
    const modelSelect = document.getElementById('model-select');
    if (modelSelect) {
        modelSelect.addEventListener('change', function() {
            // 模型选择变更时的处理
            const selectedModel = this.value;
            if (selectedModel) {
                console.log('选择了模型:', selectedModel);
            }
        });
    }

    const proactiveAutoUrl = document.getElementById('proactive-auto-api-url');
    const proactiveAutoKey = document.getElementById('proactive-auto-api-key');
    if (proactiveAutoUrl) proactiveAutoUrl.addEventListener('input', checkProactiveAutoApiInputs);
    if (proactiveAutoKey) proactiveAutoKey.addEventListener('input', checkProactiveAutoApiInputs);
    
    // 聊天列表已在 DOMContentLoaded 中 setTimeout(0) 与上方 scheduleLoadChatList 刷新；此处不再同步 loadChatList，避免在极少数顺序下重复抢跑

    // 群聊自动聊天：后台轮询（每分钟检查一次，满足30分钟则触发一次）
    try { startGroupAutoChatScheduler(); } catch (e) {}
};

const GROUP_AUTOCHAT_INTERVAL_MS = 30 * 60 * 1000;
let _groupAutoChatTimer = null;
let _groupAutoChatRunning = false;

function startGroupAutoChatScheduler() {
    if (_groupAutoChatTimer) return;
    _groupAutoChatTimer = setInterval(tickGroupAutoChatScheduler, 60 * 1000);
    // 启动后立刻检查一次
    tickGroupAutoChatScheduler();
}

async function tickGroupAutoChatScheduler() {
    if (_groupAutoChatRunning) return;
    if (isReceiving) return;
    const friends = loadFriendsFromStorage();
    const groups = friends.filter(f => f && f.isGroup && f.groupAutoChatEnabled);
    if (!groups.length) return;
    const now = Date.now();
    for (const g of groups) {
        const lastAt = Number(g.groupAutoChatLastAt || 0);
        if (now - lastAt < GROUP_AUTOCHAT_INTERVAL_MS) continue;
        await runGroupAutoChatOnce(String(g.id));
    }
}

async function runGroupAutoChatOnce(groupId) {
    if (!groupId) return;
    const friends = loadFriendsFromStorage();
    const idx = friends.findIndex(f => f && f.isGroup && String(f.id) === String(groupId));
    if (idx === -1) return;
    if (!friends[idx].groupAutoChatEnabled) return;

    _groupAutoChatRunning = true;
    const now = Date.now();
    // 先写入 lastAt，避免重复触发
    friends[idx].groupAutoChatLastAt = now;
    try { saveFriendsToStorage(friends); } catch (e) {}

    try {
        const sendContent = CommandManager.buildWechatSendContent(groupId, '__AUTO_CHAT__');
        if (!sendContent) return;
        const response = await FeatureCommandMapper.callApiModel(sendContent, null, { skipOverlay: true });
        const responseForGroup = sanitizeWechatFriendApiResponseText(String(response || '')) || String(response || '');
        const parsedGroup = CommandManager._extractGroupChatMessagesFromApiText(responseForGroup);
        if (parsedGroup) {
            const groupFriendRef = friends[idx];
            for (const m of parsedGroup) {
                const resolved =
                    groupFriendRef && typeof resolveGroupChatSpeakerMember === 'function'
                        ? resolveGroupChatSpeakerMember(m.speakerId, groupFriendRef, friends)
                        : null;
                const sid = resolved ? String(resolved.id) : String(m.speakerId);
                const rawLine = m.text != null ? String(m.text) : '';
                const lead =
                    typeof tryParseLeadingFinanceJsonPayload === 'function'
                        ? tryParseLeadingFinanceJsonPayload(rawLine)
                        : null;
                const segments = lead
                    ? [lead.jsonSource].concat(
                          lead.rest && String(lead.rest).trim() ? [String(lead.rest).trim()] : []
                      )
                    : [rawLine];
                for (const seg of segments) {
                    const ts = Date.now();
                    let line = seg;
                    let subtype = null;
                    let finExtra = null;
                    if (typeof normalizeFriendFinanceJsonBubbleIfAny === 'function') {
                        const fin = normalizeFriendFinanceJsonBubbleIfAny(line);
                        if (fin) {
                            line = fin.body;
                            subtype = fin.subtype;
                            finExtra = fin.extra || null;
                        }
                    }
                    if (typeof sanitizeWechatOutgoingBubbleBody === 'function' && line) {
                        line = sanitizeWechatOutgoingBubbleBody(line, subtype);
                    }
                    const ex = { speakerId: sid };
                    if (finExtra && typeof finExtra === 'object') Object.assign(ex, finExtra);
                    displayMessage('friend', line, null, ts, groupId, subtype, null, null, null, null, sid);
                    saveChatMessage(groupId, 'friend', line, null, ts, subtype, null, ex);
                    await new Promise(r => setTimeout(r, 80));
                }
            }
        } else if (response) {
            // 兜底：若模型未按 JSON 输出，则当作系统消息写入，避免丢失
            const ts = Date.now();
            saveChatMessage(groupId, 'system', '（自动聊天输出未结构化，已忽略显示）', null, ts);
        }
    } catch (e) {
        console.error('group auto chat failed', e);
    } finally {
        _groupAutoChatRunning = false;
    }
}

// ========== 推特 / X 功能 ==========
// 存储与领域见 twitter-store.js（Twitter.store）；localStorage 键名与本文件开头 var 一致。

function loadTwitterFollowingFriendIdListRaw() { return Twitter.store.loadTwitterFollowingFriendIdListRaw(); }
function saveTwitterFollowingFriendIdList(ids) { return Twitter.store.saveTwitterFollowingFriendIdList(ids); }
function getFriendsForTwitterFollowingFeed() { return Twitter.store.getFriendsForTwitterFollowingFeed(); }
function getTwitterFollowingSelectedCount() { return Twitter.store.getTwitterFollowingSelectedCount(); }

function twitterStripHtmlToPlain(html) { return Twitter.store.twitterStripHtmlToPlain(html); }
function twitterGetDetailExtraBlocksStore() { return Twitter.store.twitterGetDetailExtraBlocksStore(); }
function twitterSaveDetailExtraBlocksStore(obj) { return Twitter.store.twitterSaveDetailExtraBlocksStore(obj); }
function twitterAppendDetailExtraHtml(cacheKey, htmlFragment) { return Twitter.store.twitterAppendDetailExtraHtml(cacheKey, htmlFragment); }
function twitterApplyDetailExtraHtml(detailContentEl, cacheKey) { return Twitter.store.twitterApplyDetailExtraHtml(detailContentEl, cacheKey); }
function twitterSetDetailPageContext(payload, cacheKey) { return Twitter.store.twitterSetDetailPageContext(payload, cacheKey); }

function getTwitterFeedsFromStorage() { return Twitter.store.getTwitterFeedsFromStorage(); }
function saveTwitterFeedsToStorage(feeds) { return Twitter.store.saveTwitterFeedsToStorage(feeds); }

/** CommandManager.buildTwitter* 等在运行时仍通过全局名调用 store */
function loadTwitterProfile() { return Twitter.store.loadTwitterProfile(); }
function defaultTwitterFriendHandle(f) { return Twitter.store.defaultTwitterFriendHandle(f); }
function getEffectiveTwitterUserHandle(profile) { return Twitter.store.getEffectiveTwitterUserHandle(profile); }

/** 供 wechat-ui.js 读取 app.js 顶层 let；多选/引用由 wechat-chat-pipeline.js 在加载时 patch */
window.__chatUiBridge = {
    get currentPage() { return currentPage; },
    get isReceiving() { return isReceiving; }
};
