/** 主动分享与回复调度。持久化绝对截止时间；成功一批算一轮；不补发错过的批次。 */
(function (g) {
    'use strict';
    var core = g.LegoProactiveCore;
    var SETTINGS_KEY = 'proactiveMessageSettingsV1';
    var STATE_PREFIX = 'proactiveMessageRuntimeV2:';
    var CHANGE_KEY = 'proactiveMessageChangeV2';
    var LEASE_KEY = 'proactiveMessageLeaseV2';
    var MAINTENANCE_KEY = 'proactiveMessageMaintenanceV2';
    var owner = Date.now().toString(36) + '-' + Math.random().toString(36).slice(2);
    var active = null, ticking = false, timer = null, settingsSnapshot = '', uiScope = '';
    var REPLY_DELAY = 35000, REQUEST_TIMEOUT = 90000;
    var pauseDepth = 0, pauseHeartbeat = null, hydrationRetry = Object.create(null), manualJobs = Object.create(null);

    function read(key, fallback) {
        try { var v = JSON.parse(localStorage.getItem(key) || 'null'); return v && typeof v === 'object' ? v : fallback; }
        catch (_) { return fallback; }
    }
    function settings() { return core.settings(read(SETTINGS_KEY, {})); }
    function cadence(s) { return JSON.stringify([s.enabled, s.intervalMinutes, s.timeStart, s.timeEnd, s.candidateIds.slice().sort()]); }
    function timing(s) { return JSON.stringify([s.intervalMinutes, s.timeStart, s.timeEnd]); }
    function profile() { return typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', {}) : {}; }
    function findFriend(fid) { return loadFriendsFromStorage().find(function (f) { return String(f.id) === String(fid); }); }
    function allowedFriend(f, s) {
        if (!f || f.isGroup || f.blacklisted || !s.enabled || !s.candidateIds.includes(String(f.id))) return false;
        if (typeof _getOfflineSettingsForFriend === 'function' && (_getOfflineSettingsForFriend(f.id) || {}).enabled) return false;
        return true;
    }
    function manualBusy() {
        return Object.keys(manualJobs).some(function (id) {
            var state = read(manualJobs[id].key, {});
            return state.manualId === id && state.manualUntil > Date.now();
        });
    }
    function busy() {
        return (typeof isReceiving !== 'undefined' && isReceiving) || manualBusy() || !!g._voiceCallFriendReplyTag ||
            !!(typeof g.isVoicePhoneCallActive === 'function' && g.isVoicePhoneCallActive());
    }
    function paused() { return pauseDepth > 0 || read(MAINTENANCE_KEY, {}).until > Date.now(); }
    function sharedHistorySig(history) { return core.signature([history.length, core.lastDialogue(history)]); }
    function keyFor(f) { return STATE_PREFIX + encodeURIComponent(core.scope(f, profile())); }
    function friendStateKeys(fid) {
        var prefix = STATE_PREFIX + encodeURIComponent(String(fid) + ':');
        return Object.keys(localStorage).filter(function (key) { return key.startsWith(prefix); });
    }
    function lastUserSignature(history) {
        var last = core.lastDialogue(history);
        return last && last.type === 'user' ? core.signature(last) : '';
    }
    // 两条线路互斥；manual 仅在用户手动接收期间暂挂，不能提前计算下一轮间隔。
    function schedule(state, s, mode) {
        state.mode = mode;
        state.nextAt = mode === 'interval' ? core.nextAllowed(s, Date.now() + core.delay(s)) : 0;
        state.replyAt = mode === 'reply' ? Date.now() + REPLY_DELAY : 0;
        state.retryAt = 0; state.failures = 0; state.error = '';
        delete state.manualId; delete state.manualUntil; delete state.manualResume; delete state.manualSent;
    }
    function persist(info, history) {
        info.state.changedBy = owner; info.state.historySig = sharedHistorySig(history);
        writeState(info.key, info.state);
    }
    function loadState(f, s, history, observeChanges) {
        var key = keyFor(f), saved = read(key, null), now = Date.now();
        var state = saved || { round: 0, revision: 0 };
        ['nextAt', 'replyAt', 'retryAt', 'round', 'revision', 'failures', 'lastSentAt'].forEach(function (field) {
            state[field] = core.int(state[field], 0, Number.MAX_SAFE_INTEGER, 0);
        });
        var scope = core.scope(f, profile()), userSig = lastUserSignature(history), changed = !saved;
        var fresh = !saved || state.enabled === false;
        if (fresh) {
            // 开启/重新开启时记录历史基线；已有用户消息不是刚刚发生的回复事件。
            schedule(state, s, 'interval'); state.userSig = userSig; changed = true;
        } else if (state.version !== 3 || !['interval', 'reply', 'manual'].includes(state.mode)) {
            // 兼容上版双截止时间：已在等待回复则保留 35 秒截止时间，只清掉并行间隔。
            state.mode = state.replyAt ? 'reply' : 'interval';
            if (state.mode === 'reply') state.nextAt = 0;
            else if (!state.nextAt) schedule(state, s, 'interval');
            state.userSig = typeof state.userSig === 'string' ? state.userSig : userSig;
            changed = true;
        }
        if (state.mode === 'manual' && !(state.manualUntil > now)) {
            schedule(state, s, state.manualSent ? 'interval' : state.manualResume === 'reply' ? 'reply' : 'interval');
            changed = true;
        }
        var newestSentAt = 0;
        history.forEach(function (m) {
            if (m.proactiveScope === scope) {
                state.round = Math.max(state.round, Number(m.proactiveRound) || 0);
                newestSentAt = Math.max(newestSentAt, Number(m.timestamp) || 0);
            }
        });
        if (newestSentAt > state.lastSentAt) {
            state.lastSentAt = newestSentAt;
            if (!fresh) schedule(state, s, 'interval');
            changed = true;
        }
        if (!fresh && observeChanges !== false && userSig !== state.userSig) {
            state.userSig = userSig;
            if (state.mode === 'manual' && !userSig) state.manualSent = true;
            else schedule(state, s, userSig ? 'reply' : 'interval');
            changed = true;
        }
        if (!fresh && state.timing && state.timing !== timing(s)) {
            // 改间隔/允许时段不会吞掉尚未回复的消息，也不会重置其 35 秒。
            if (state.mode === 'interval') schedule(state, s, 'interval');
            changed = true;
        }
        state.version = 3; state.enabled = true; state.timing = timing(s);
        var info = { key: key, state: state, scope: scope };
        if (changed) { state.revision++; persist(info, history); }
        return info;
    }
    function writeState(key, state) { localStorage.setItem(key, JSON.stringify(state)); }
    function announce(fid) {
        try { localStorage.setItem(CHANGE_KEY, JSON.stringify({ fid: String(fid), token: owner + ':' + Date.now() + ':' + Math.random() })); }
        catch (_) {}
    }
    function invalidate(fid) {
        if (active && (fid == null || String(active.fid) === String(fid))) active.controller.abort();
    }
    function onMessage(fid, item) {
        if (!item || !/^(user|friend)$/.test(item.type) || item.voiceCallSuppressMainChat) return;
        invalidate(fid);
        var s = settings(), f = findFriend(fid);
        if (!allowedFriend(f, s)) return;
        var history = getChatHistoryArray(fid), info = loadState(f, s, history, false), state = info.state;
        state.revision++;
        state.userSig = lastUserSignature(history);
        if (item.type === 'friend' && state.mode === 'manual') state.manualSent = true;
        else {
            var job = manualJobs[state.manualId];
            if (item.type === 'user' && job && job.controller) job.controller.abort();
            schedule(state, s, item.type === 'user' ? 'reply' : 'interval');
        }
        persist(info, history);
        announce(fid);
        syncUI();
    }
    function manualStarted(fid) {
        var s = settings(), f = findFriend(fid);
        if (!allowedFriend(f, s)) return null;
        if (manualBusy()) return { busy: true };
        invalidate(fid);
        var history = getChatHistoryArray(fid), info = loadState(f, s, history), state = info.state;
        if (state.mode === 'manual' && state.manualUntil > Date.now()) return { busy: true };
        var job = { id: owner + ':manual:' + Date.now() + ':' + Math.random(), fid: String(fid), key: info.key,
            scope: info.scope, configSig: configSignature(f), historySig: core.signature(history), controller: null };
        state.manualResume = state.mode === 'reply' ? 'reply' : 'interval';
        state.mode = 'manual'; state.manualSent = false; state.manualId = job.id;
        state.manualUntil = Date.now() + 120000;
        state.nextAt = 0; state.replyAt = 0; state.retryAt = 0; state.error = ''; state.revision++;
        persist(info, history);
        manualJobs[job.id] = job;
        job.timer = setInterval(function () {
            var current = read(job.key, {});
            if (current.manualId !== job.id) { clearInterval(job.timer); return; }
            current.manualUntil = Date.now() + 120000;
            try { writeState(job.key, current); } catch (_) { if (job.controller) job.controller.abort(); }
        }, 30000);
        announce(fid); syncUI();
        return job;
    }
    function manualValid(job) {
        if (!job) return true;
        var f = findFriend(job.fid);
        return read(job.key, {}).manualId === job.id && !!f && !f.blacklisted &&
            core.scope(f, profile()) === job.scope && configSignature(f) === job.configSig &&
            (!job.controller || !job.controller.signal.aborted) && core.signature(getChatHistoryArray(job.fid)) === job.historySig;
    }
    function manualFinished(job) {
        if (!job) return;
        clearInterval(job.timer); delete manualJobs[job.id];
        var state = read(job.key, null), f = findFriend(job.fid), s = settings();
        if (!state || state.manualId !== job.id || !allowedFriend(f, s) || keyFor(f) !== job.key) return;
        // 仅已保存的好友消息结束回复等待；取消/失败则恢复原线路，留 35 秒避免立即重试。
        schedule(state, s, state.manualSent ? 'interval' : state.manualResume === 'reply' ? 'reply' : 'interval');
        state.revision++;
        persist({ key: job.key, state: state }, getChatHistoryArray(job.fid));
        announce(job.fid); syncUI();
    }
    function configSignature(f) {
        var books = typeof getWorldBookData === 'function' ? getWorldBookData() : {};
        return core.signature([f.roleSetting, f.role, f.persona, f.worldBookIds, f.worldBookId, profile(),
            books, read('apiSettings', {}).memoryCount, CommandManager.getActiveCommands()]);
    }
    function requestValid(req) {
        if (!req || req.controller.signal.aborted || active !== req || paused()) return false;
        if (g._voiceCallFriendReplyTag || (typeof g.isVoicePhoneCallActive === 'function' && g.isVoicePhoneCallActive())) return false;
        if (req.lease && read(LEASE_KEY, {}).owner !== owner) return false;
        var s = settings(), f = findFriend(req.fid);
        if (!allowedFriend(f, s) || !core.within(s, new Date()) || cadence(s) !== req.settingsSig) return false;
        if (core.scope(f, profile()) !== req.scope || configSignature(f) !== req.configSig) return false;
        var state = read(req.key, {});
        return state.revision === req.revision && core.signature(getChatHistoryArray(req.fid)) === req.historySig;
    }
    function completeConnection(c) { return c && c.apiUrl && c.apiKey && c.model; }
    async function callModel(content, req) {
        var specific = typeof loadProactiveAutoApiConnection === 'function' ? loadProactiveAutoApiConnection() : null;
        var main = read('apiSettings', {}), connections = [];
        if (completeConnection(specific)) connections.push(specific);
        if (completeConnection(main) && (!completeConnection(specific) ||
            ['apiUrl', 'apiKey', 'model'].some(function (k) { return specific[k] !== main[k]; }))) connections.push(main);
        if (!connections.length) throw new Error('API 设置未完成');
        var abortPromise = new Promise(function (_, reject) {
            req.controller.signal.addEventListener('abort', function () { reject(new Error(req.timedOut ? '请求超时' : '已取消')); }, { once: true });
        });
        var invalidFormat = false;
        for (var i = 0; i < connections.length; i++) {
            if (!requestValid(req)) return null;
            var response;
            try {
                response = await Promise.race([abortPromise, FeatureCommandMapper.callApiModel(content, req.controller, {
                    skipOverlay: true, suppressErrorDialog: true, apiRetry: false, overrideConnection: connections[i]
                })]);
            } catch (e) { if (req.controller.signal.aborted) throw e; response = null; }
            if (!requestValid(req)) return null;
            if (response && String(response).trim()) {
                if (core.parseOutput(response, req.context)) return response;
                invalidFormat = true;
            }
        }
        throw new Error(invalidFormat ? '返回格式不符合主动消息规范' : '消息生成失败');
    }
    function notify(f) {
        if (!settings().systemNotify || typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
        try { new Notification(f.remark || f.nickname || '微信', { body: '发来一条消息', tag: 'lego-proactive-' + f.id }); } catch (_) {}
    }
    function refreshVisibleChat(fid, expectedHistorySig) {
        if (fid == null) return;
        try {
            if (Wechat.ui && typeof Wechat.ui.requestChatHistoryRefresh === 'function') {
                void Wechat.ui.requestChatHistoryRefresh(fid, { expectedHistorySig: expectedHistorySig, scrollToBottom: true });
            } else {
                var page = document.getElementById('chat-page');
                if (page && !document.hidden && page.classList.contains('active') && String(page.dataset.friendId) === String(fid)) loadChatHistory(fid, { scrollToBottom: true });
            }
        } catch (e) { console.warn('[主动发消息] 消息已保存，画面同步暂缓', e && e.message); }
    }
    async function run(f, info, s) {
        if (busy() || paused()) return;
        var history = getChatHistoryArray(f.id), state = info.state, now = Date.now();
        var kind = state.mode === 'reply' ? 'reply' : 'share';
        var round = state.round + 1;
        var previousShare = history.filter(function (m) { return m.proactiveScope === info.scope && m.proactiveKind === 'share'; }).slice(-1)[0];
        var lastUserIndex = -1;
        history.forEach(function (m, i) { if (m.type === 'user' && !m.voiceCallSuppressMainChat) lastUserIndex = i; });
        var unanswered = history.slice(lastUserIndex + 1).find(function (m) { return m.type === 'friend' && !m.voiceCallSuppressMainChat; });
        var waiting = kind === 'reply' ? 0 : unanswered ? Math.max(0, Math.min(360, Math.floor((now - Number(unanswered.timestamp)) / 60000))) : 30;
        var context = { kind: kind, round: round, requireEmotion: kind === 'share' && round % 2 === 0,
            waitingMinutes: waiting, talkative: core.talkative(f), allowedNow: true, now: now,
            timeStart: s.timeStart, timeEnd: s.timeEnd };
        var req = { fid: String(f.id), key: info.key, scope: info.scope, revision: state.revision,
            historySig: core.signature(history), settingsSig: cadence(s), configSig: configSignature(f),
            controller: new AbortController(), kind: kind, context: context, timedOut: false,
            lease: !(typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) };
        active = req;
        isReceiving = true;
        receiveController = req.controller;
        syncUI();
        var timeout = setTimeout(function () { req.timedOut = true; req.controller.abort(); }, REQUEST_TIMEOUT), published = false;
        try {
            var content = Wechat.prompts.buildProactiveMessageContent(f.id, context);
            if (!content) return;
            var raw = await callModel(content, req);
            if (!requestValid(req)) return;
            var output = core.parseOutput(raw, context);
            if (!output) throw new Error('返回格式不符合主动消息规范');
            // 整批与最近主动分享完全相同则跳过，不刷屏、不推进轮次。
            var lastBatch = previousShare && previousShare.proactiveBatchId;
            var lastBodies = lastBatch ? history.filter(function (m) { return m.proactiveBatchId === lastBatch; }).map(function (m) { return m.content; }) : [];
            if (kind === 'share' && JSON.stringify(lastBodies) === JSON.stringify(output.messages)) throw new Error('重复的主动消息已跳过');
            var batchId = owner + ':' + now;
            var startTs = Math.max(Date.now(), history.reduce(function (max, m) { return Math.max(max, Number(m.timestamp) || 0); }, 0) + 1);
            var items = output.messages.map(function (body, index) {
                return { type: 'friend', content: body, timestamp: startTs + index, quote: null, mode: 'online',
                    proactiveBatchId: batchId, proactiveScope: info.scope, proactiveKind: kind,
                    proactiveRound: kind === 'share' ? round : state.round,
                    proactiveEmotion: index === output.messages.length - 1 ? output.emotion : '' };
            });
            if (!await commitProactiveChatBatch(f.id, items, function () { return requestValid(req); }, req.controller.signal)) return;
            published = true;
            // 元数据和下一次时间只在整批落库后更新；即使状态写入失败，也能从消息元数据恢复轮数。
            state.round = kind === 'share' ? round : state.round;
            state.lastSentAt = items[items.length - 1].timestamp;
            state.userSig = '';
            schedule(state, s, 'interval'); state.revision++;
            state.changedBy = owner; state.historySig = sharedHistorySig(getChatHistoryArray(f.id));
            try { writeState(info.key, state); } catch (_) { /* 聊天中已保存轮数，下一轮再恢复 */ }
            refreshVisibleChat(f.id, state.historySig);
            try { queueWechatMessagePreview(f.id, items[items.length - 1]); } catch (_) {}
            announce(f.id);
            notify(f);
        } catch (e) {
            if (published) {
                // 显示错误只能重试显示，不能把已落盘的回复再向模型请求一次。
                refreshVisibleChat(f.id);
                console.warn('[主动发消息] 已保存的消息等待画面同步', e && e.message);
                return;
            }
            if (!req.controller.signal.aborted || req.timedOut) {
                var current = read(info.key, null);
                if (current && current.revision === req.revision) {
                    current.failures = Math.min(5, (current.failures || 0) + 1);
                    current.retryAt = Date.now() + Math.min(900000, 60000 * Math.pow(2, current.failures - 1));
                    current.error = req.timedOut ? '请求超时' : (e.message || '消息生成失败');
                    try { writeState(info.key, current); } catch (_) {}
                }
                console.warn('[主动发消息]', req.timedOut ? '请求超时' : (e.message || '消息生成失败'));
            }
        } finally {
            clearTimeout(timeout);
            if (active === req) active = null;
            if (receiveController === req.controller) { receiveController = null; isReceiving = false; }
            syncUI();
        }
    }
    async function lead(work) {
        if (typeof navigator !== 'undefined' && navigator.locks && navigator.locks.request) {
            return navigator.locks.request('lego-proactive-v2', { ifAvailable: true }, function (lock) { if (lock) return work(); });
        }
        // 旧浏览器退化为有到期时间的租约；页面冻结时，请求也须通过共享修订号复核。
        var lease = read(LEASE_KEY, {});
        if (lease.owner !== owner && lease.until > Date.now()) return;
        localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: owner, until: Date.now() + 120000 }));
        await new Promise(function (resolve) { setTimeout(resolve, 60); });
        if (read(LEASE_KEY, {}).owner !== owner) return;
        var refresh = setInterval(function () {
            if (read(LEASE_KEY, {}).owner === owner) localStorage.setItem(LEASE_KEY, JSON.stringify({ owner: owner, until: Date.now() + 120000 }));
            else invalidate();
        }, 10000);
        try { await work(); }
        finally { clearInterval(refresh); if (read(LEASE_KEY, {}).owner === owner) localStorage.removeItem(LEASE_KEY); }
    }
    async function tick() {
        syncUI();
        if (ticking || active || !settings().enabled || busy() || paused()) return;
        ticking = true;
        try {
            await lead(async function () {
                if (typeof ensureFriendsCacheHydrated === 'function') await ensureFriendsCacheHydrated();
                var s = settings();
                if (!s.enabled || paused()) return;
                var due = [];
                for (var fid of s.candidateIds) {
                    var f = findFriend(fid);
                    if (!allowedFriend(f, s)) continue;
                    if (hydrationRetry[fid] > Date.now()) continue;
                    var history;
                    try { history = await ensureChatHistoryReady(fid); }
                    catch (_) { hydrationRetry[fid] = Date.now() + 60000; continue; }
                    // 另一标签页可能先更新计时、稍后才完成聊天落盘。未读到对应消息前不能覆写其计时。
                    var shared = read(keyFor(f), {});
                    if (shared.changedBy && shared.changedBy !== owner && shared.historySig && shared.historySig !== sharedHistorySig(history)) {
                        invalidateChatHistoryMem(fid);
                        try { history = await ensureChatHistoryReady(fid); } catch (_) { continue; }
                        if (shared.historySig !== sharedHistorySig(history)) continue;
                    }
                    var info = loadState(f, s, history);
                    if (info.state.mode === 'manual') continue;
                    var deadline = info.state.mode === 'reply' ? info.state.replyAt : info.state.nextAt;
                    var at = Math.max(deadline, info.state.retryAt || 0);
                    if (deadline > 0 && at <= Date.now()) due.push({ friend: f, info: info, at: at });
                }
                // 先回复，再按截止时间排序；只执行一位，防止恢复页面后集中补发。
                due.sort(function (a, b) { return Number(!!b.info.state.replyAt) - Number(!!a.info.state.replyAt) || a.at - b.at; });
                if (due.length && core.within(s, new Date()) && cadence(s) === cadence(settings())) await run(due[0].friend, due[0].info, s);
            });
        } catch (e) { console.warn('[主动发消息] 调度暂缓', e.message || e); }
        finally { ticking = false; }
    }
    function syncUI() {
        var page = document.getElementById('chat-page'), button = page && page.querySelector('.receive-btn');
        var area = page && page.querySelector('.chat-content');
        if (!button || !area) return;
        var fid = String(page.dataset.friendId || ''), f = findFriend(fid), s = settings();
        var state = f ? read(keyFor(f), {}) : {}, status = '', label = '';
        // 倒计时刷新同时核对“存储版本”和“可见版本”；补回遗漏的成功通知，不补调用 API。
        if (state.historySig) refreshVisibleChat(fid, state.historySig);
        if (allowedFriend(f, s) && core.within(s, new Date()) && !paused()) {
            if ((active && active.fid === fid && !active.controller.signal.aborted) ||
                (state.mode === 'manual' && state.manualUntil > Date.now())) {
                status = '正在输入回复中……'; label = '生成中';
            } else if (state.mode === 'reply' && state.replyAt) {
                var left = Math.max(0, Math.ceil((Math.max(state.replyAt, state.retryAt || 0) - Date.now()) / 1000));
                status = state.error ? state.error + '，稍后重试' : '正在输入回复中……';
                label = left ? (state.retryAt > Date.now() ? '重试 ' : '') + left + '秒' : '等待回复';
            }
        } else if (allowedFriend(f, s) && state.replyAt) label = '时段外暂停';
        var badge = button.querySelector('.proactive-receive-countdown');
        if (label) {
            if (!badge) { badge = document.createElement('span'); badge.className = 'proactive-receive-countdown'; button.appendChild(badge); }
            badge.textContent = label;
            button.setAttribute('aria-label', '接收回复：' + label);
            button.title = label + (state.error ? '：' + state.error : '，点击可立即接收或取消生成');
        } else {
            if (badge) badge.remove();
            button.setAttribute('aria-label', '接收回复'); button.title = '接收';
        }
        var row = area.querySelector('.proactive-typing-row');
        if (!status || uiScope !== fid) { if (row) row.remove(); row = null; }
        if (status) {
            if (!row) {
                row = document.createElement('div'); row.className = 'chat-message other-message proactive-typing-row';
                row.setAttribute('role', 'status');
                var avatar = document.createElement('div'); avatar.className = 'chat-message-avatar chat-message-avatar-letter';
                avatar.textContent = String(f.remark || f.nickname || '友').slice(0, 1);
                var avatarUrl = typeof getFriendDisplayAvatar === 'function' ? getFriendDisplayAvatar(f) : '';
                if (avatarUrl) {
                    var avatarImage = document.createElement('img'); avatarImage.className = 'chat-avatar-img';
                    avatarImage.src = avatarUrl; avatarImage.alt = f.remark || f.nickname || '好友';
                    avatar.textContent = ''; avatar.appendChild(avatarImage);
                }
                var body = document.createElement('div'); body.className = 'chat-message-content';
                var bubble = document.createElement('div'); bubble.className = 'chat-message-bubble';
                body.appendChild(bubble); if (!f.hideAvatar) row.appendChild(avatar); row.appendChild(body); area.appendChild(row);
            }
            var bubbleEl = row.querySelector('.chat-message-bubble');
            if (bubbleEl.textContent !== status) bubbleEl.textContent = status;
            // 重载聊天的分批渲染可能继续追加消息，输入状态始终位于末尾。
            if (area.lastElementChild !== row) area.appendChild(row);
        }
        uiScope = fid;
    }
    function handleReceiveClick(fid) {
        if (active) {
            if (active.fid === String(fid)) {
                invalidate(fid);
                var f = findFriend(fid), s = settings();
                if (allowedFriend(f, s)) {
                    var history = getChatHistoryArray(fid), info = loadState(f, s, history);
                    info.state.retryAt = Date.now() + (info.state.mode === 'reply' ? REPLY_DELAY : core.delay(s));
                    info.state.error = '已取消生成'; info.state.revision++;
                    persist(info, history); announce(fid); syncUI();
                }
            }
            else if (typeof showNotification === 'function') showNotification('另一位好友正在生成消息，请稍候');
            return true;
        }
        // 手动入口真正启动时暂挂计时；无可接收内容或生成失败不能冒充已发送回复。
        return false;
    }
    function reschedule() {
        var s = settings(), nextSnapshot = cadence(s), changed = settingsSnapshot && nextSnapshot !== settingsSnapshot;
        if (changed) invalidate();
        var previousIds = settingsSnapshot ? JSON.parse(settingsSnapshot)[4] : [];
        // 禁用/移除后保留轮数，但下次启用从完整间隔起步，历史末条是谁都不影响。
        Array.from(new Set(previousIds.concat(s.candidateIds))).forEach(function (fid) {
            if (s.enabled && s.candidateIds.includes(String(fid))) return;
            friendStateKeys(fid).forEach(function (key) {
                var state = read(key, null);
                if (!state) return;
                state.enabled = false; state.mode = 'interval'; state.nextAt = 0; state.replyAt = 0;
                state.retryAt = 0; state.error = ''; state.revision++;
                delete state.manualId; delete state.manualUntil;
                writeState(key, state);
            });
        });
        settingsSnapshot = nextSnapshot;
        if (timer != null) clearInterval(timer);
        timer = null;
        if (s.enabled) {
            timer = setInterval(function () { void tick(); }, 1000);
            void tick();
        }
        syncUI();
    }
    function historyReplaced(fid) {
        invalidate(fid);
        hydrationRetry[fid] = 0;
        var f = findFriend(fid);
        if (!f) return;
        friendStateKeys(fid).forEach(function (key) { localStorage.removeItem(key); });
        // 导入/清空完成后先由 tick 等待存储预热，再以新历史建立计时基线。
        announce(fid); syncUI();
    }
    function suspend() {
        pauseDepth++; invalidate();
        var renew = function () {
            try { localStorage.setItem(MAINTENANCE_KEY, JSON.stringify({ owner: owner, until: Date.now() + 120000 })); }
            catch (_) { /* 当前页面仍保持暂停，不能因配额不足阻断用户的导入流程。 */ }
        };
        renew();
        if (pauseHeartbeat == null) pauseHeartbeat = setInterval(renew, 30000);
        var released = false;
        return function () {
            if (released) return;
            released = true; pauseDepth = Math.max(0, pauseDepth - 1);
            if (!pauseDepth) {
                clearInterval(pauseHeartbeat); pauseHeartbeat = null;
                if (read(MAINTENANCE_KEY, {}).owner === owner) localStorage.removeItem(MAINTENANCE_KEY);
                settings().candidateIds.forEach(function (fid) { try { historyReplaced(fid); } catch (_) {} });
                try { reschedule(); } catch (_) { /* 计时写入失败时维持无发送状态，不中断备份恢复。 */ }
            }
        };
    }
    function reset() {
        invalidate();
        Object.keys(localStorage).forEach(function (key) {
            if (key.startsWith(STATE_PREFIX) || [SETTINGS_KEY, 'proactiveAutoApiSettingsV1', CHANGE_KEY, LEASE_KEY].includes(key)) localStorage.removeItem(key);
        });
        reschedule();
    }
    g.Wechat.proactive = { settings: settings, reschedule: reschedule, tick: tick, syncUI: syncUI,
        onMessage: onMessage, invalidate: invalidate, manualStarted: manualStarted,
        manualFinished: manualFinished, manualValid: manualValid,
        handleReceiveClick: handleReceiveClick, historyReplaced: historyReplaced, suspend: suspend, reset: reset };
    g.addEventListener('storage', function (event) {
        if (event.key === SETTINGS_KEY) { reschedule(); return; }
        if (event.key === CHANGE_KEY || (event.key && event.key.startsWith('chatHistory_'))) {
            var changed;
            if (event.key !== CHANGE_KEY) changed = { fid: event.key.slice('chatHistory_'.length) };
            else {
                try { changed = event.newValue ? JSON.parse(event.newValue) : read(CHANGE_KEY, {}); }
                catch (_) { changed = {}; }
            }
            if (!changed || changed.fid == null) return;
            invalidate(changed.fid);
            hydrationRetry[changed.fid] = 0;
            invalidateChatHistoryMem(changed.fid);
            refreshVisibleChat(changed.fid);
            syncUI();
        } else if (event.key === MAINTENANCE_KEY || event.key === null || event.key === 'friends' || event.key === 'myProfile' ||
            event.key === 'systemCommands' || event.key === 'worldBookData') invalidate();
    });
    g.addEventListener('pagehide', function () { invalidate(); });
    function resumeVisibleChat() {
        var page = document.getElementById('chat-page');
        if (page && !document.hidden) refreshVisibleChat(page.dataset.friendId);
    }
    g.addEventListener('pageshow', function () { reschedule(); resumeVisibleChat(); });
    document.addEventListener('visibilitychange', function () { if (!document.hidden) { resumeVisibleChat(); void tick(); } });
})(window);
