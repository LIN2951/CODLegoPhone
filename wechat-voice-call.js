/**
 * 微信 · 更多功能「语音通话」：语音消息（仿 INS 语音条）+ 语音电话（接通判定 + 仿 INS 通话中界面）
 * 依赖：app.js（escapeHtml）、wechat-ui.js（displayMessage）、wechat-chat-pipeline（saveChatMessage/getChatHistoryArray）、FeatureCommandMapper
 */
(function (global) {
    'use strict';

    var CALL_STATE = {
        friendId: null,
        startTs: 0,
        /** 接通后本条通话唯一 id，挂断前写入消息的 voiceCallSessionId */
        voiceSessionId: null,
        /** 通话进行中累计秒数，用于挂断卡片展示 */
        durationSec: 0,
        timerId: null,
        pollId: null,
        abort: null,
        volume: 85,
        muted: false,
        minimized: false
    };

    function _esc(s) {
        if (typeof escapeHtml === 'function') return escapeHtml(s);
        return String(s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    /** INS 风格语音条外壳（无真实音频，点击展开正文） — 挂到全局供 wechat-ui displayMessage 使用 */
    global.buildVoiceNoteFakeBubbleHtml = function (text) {
        var raw = text == null ? '' : String(text);
        var sec = Math.max(1, Math.min(180, Math.round(raw.length / 6) || 1));
        var mm = Math.floor(sec / 60);
        var ss = sec % 60;
        var dur = mm + ':' + (ss < 10 ? '0' + ss : ss);
        var bars = '';
        var i = 0;
        for (; i < 14; i++) {
            var h = 4 + (((i * 17 + raw.length + (raw.charCodeAt(i % raw.length) || 0)) % 18));
            bars += '<span class="wechat-voice-note-wave-bar" style="height:' + h + 'px"></span>';
        }
        return (
            '<div class="wechat-voice-note-fake-inner">' +
            '<button type="button" class="wechat-voice-note-toggle" tabindex="0" aria-expanded="false">' +
            '<span class="wechat-voice-note-mic">' +
            '<svg viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M12 14a4 4 0 004-4V5a4 4 0 10-8 0v5a4 4 0 004 4zm7-4a7 7 0 01-14 0H3a9 9 0 0018 0h-2z"/><path fill="currentColor" d="M8 21h8v-2H8v2z"/></svg>' +
            '</span>' +
            '<span class="wechat-voice-note-wave">' + bars + '</span>' +
            '<span class="wechat-voice-note-dur">' + _esc(dur) + '</span>' +
            '<span class="wechat-voice-note-hint">轻点查看文字</span>' +
            '</button>' +
            '<div class="wechat-voice-note-expanded" hidden>' +
            '<div class="wechat-voice-note-expanded-text">' +
            _esc(raw).replace(/\n/g, '<br>') +
            '</div></div>' +
            '</div>'
        );
    };

    function toggleVoiceNoteFromButton(btn) {
        if (!btn) return;
        var wrap = btn.closest('.wechat-voice-note-fake-inner');
        if (!wrap) return;
        var exp = wrap.querySelector('.wechat-voice-note-expanded');
        if (!exp) return;
        var open = !!exp.hidden;
        exp.hidden = !open;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        try {
            wrap.closest('.chat-message') && wrap.closest('.chat-message').classList.toggle('wechat-voice-note-expanded-open', open);
        } catch (e) {}
    }

    function bindVoiceNoteDelegation() {
        var cp = document.getElementById('chat-page');
        if (!cp || cp.dataset.voiceNoteBound === '1') return;
        cp.dataset.voiceNoteBound = '1';
        cp.addEventListener(
            'click',
            function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('.wechat-voice-note-toggle') : null;
                if (!btn || !cp.contains(btn)) return;
                var bridge =
                    typeof global.__chatUiBridge !== 'undefined' && global.__chatUiBridge
                        ? global.__chatUiBridge
                        : {};
                if (bridge.isMultiselectMode) return;
                e.preventDefault();
                e.stopPropagation();
                toggleVoiceNoteFromButton(btn);
            },
            true
        );
        cp.addEventListener('keydown', function (e) {
            if (e.key !== 'Enter' && e.key !== ' ') return;
            var btn = e.target && e.target.closest ? e.target.closest('.wechat-voice-note-toggle') : null;
            if (!btn || !cp.contains(btn)) return;
            var bridge =
                typeof global.__chatUiBridge !== 'undefined' && global.__chatUiBridge
                    ? global.__chatUiBridge
                    : {};
            if (bridge.isMultiselectMode) return;
            e.preventDefault();
            e.stopPropagation();
            toggleVoiceNoteFromButton(btn);
        });
    }

    // -------------------------------------------------------------------------
    function _getFriendForVoice(fid) {
        if (typeof loadFriendsFromStorage !== 'function') return null;
        var friends = loadFriendsFromStorage();
        return friends.filter(function (f) { return f && String(f.id) === String(fid); })[0] || null;
    }

    /**
     * 语音通话记录展开区：显示 User 与 Char 的本帐号昵称（与主聊天用户气泡「我的人设」、对方备注/昵称一致），不用「我/对方」指代。
     */
    function _getVoiceCallTranscriptNameLabels(fid) {
        var f = _getFriendForVoice(fid);
        var charLabel = '好友';
        var userLabel = '用户';
        if (!f) {
            return { user: userLabel, friend: charLabel };
        }
        charLabel = String(f.remark || f.nickname || '好友').trim() || '好友';
        var myP =
            typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        var p = f.persona && typeof f.persona === 'object' ? f.persona : null;
        var nick = '';
        if (p) {
            if (p.nickname != null && String(p.nickname).trim()) nick = String(p.nickname).trim();
            else if (p.name != null && String(p.name).trim()) nick = String(p.name).trim();
        }
        if (!nick && myP && myP.nickname != null) {
            nick = String(myP.nickname).trim();
        }
        if (!nick && typeof safeReadJsonFromStorage === 'function') {
            try {
                var ui = safeReadJsonFromStorage('userInfo', null);
                if (ui && ui.nickname != null) nick = String(ui.nickname).trim();
            } catch (eUi) {}
        }
        if (nick) {
            userLabel = nick.length > 36 ? nick.slice(0, 36) + '…' : nick;
        }
        if (charLabel.length > 36) {
            charLabel = charLabel.slice(0, 36) + '…';
        }
        return { user: userLabel, friend: charLabel };
    }

    function _formatHistorySnip(fid) {
        var h = typeof getChatHistoryArray === 'function' ? getChatHistoryArray(fid) : [];
        if (!h || !h.length) return '(暂无记录)';
        var lines = [];
        var i = Math.max(0, h.length - 48);
        for (; i < h.length; i++) {
            var m = h[i];
            var tag = m.type === 'user' ? '用户' : m.type === 'friend' ? '对方' : '系统';
            var c = String(m.content == null ? '' : m.content).replace(/\s+/g, ' ');
            if (c.length > 220) c = c.slice(0, 220) + '…';
            lines.push(tag + ':' + c);
        }
        return lines.join('\n');
    }

    global.buildVoiceCallDecisionPrompt = function (fid) {
        var f = _getFriendForVoice(fid);
        var nickname = f ? ((f.remark || f.nickname || '好友').trim()) : '好友';
        var persona = '';
        try {
            if (f && f.persona && typeof f.persona === 'object') {
                persona =
                    String(f.persona.name || '') +
                    '\n' +
                    String((f.persona.description || f.persona.background || '').slice(0, 900));
            }
        } catch (e) {}
        var roleSetting = (f && f.roleSetting) ? String(f.roleSetting).slice(0, 1200) : '';
        return (
            '你是对话模拟器裁判。请以第一人称代入「该角色」（即对方好友），判断是否愿意在这个时刻接通用户打来的语音电话。\n\n' +
            '【称呼】\n' +
            nickname +
            '\n【角色自述/设定节选】\n' +
            (roleSetting || '（未写长设定）') +
            '\n【人设与世界观节选】\n' +
            (persona.trim() ? persona : '（暂无）') +
            '\n【最近聊天记录（截断摘要）】\n' +
            _formatHistorySnip(fid) +
            '\n\n规则：\n' +
            '1）若眼下不适合接听（工作在身、公共场合、情绪低落、需要时间独处、与对方刚吵过等情况），应拒绝。\n' +
            '2）若环境合适并愿意聊，可以接听。\n' +
            '3）只输出 JSON，勿用 markdown 代码块，勿加其他说明。\n' +
            '格式：{"answer":"accept" 或 "reject","reason":"一句中文原因；接听时也可简短写心情"}\n'
        );
    };

    function parseVoiceCallDecisionJson(raw) {
        var t = String(raw == null ? '' : raw).trim();
        var m = t.match(/\{[\s\S]*\}/);
        if (m) t = m[0];
        try {
            var o = JSON.parse(t);
            var a = String(o.answer || o.decision || '').toLowerCase();
            if (a === 'accept' || a === 'yes' || a === 'true') {
                return { answer: 'accept', reason: String(o.reason || o.reason_zh || '好，我接一下。') };
            }
            if (a === 'reject' || a === 'no' || a === 'false') {
                return { answer: 'reject', reason: String(o.reason || o.reason_zh || '现在不太方便。') };
            }
        } catch (e) {}
        if (/拒|不便|忙|开会|睡觉|公共|不太|不要/i.test(t)) {
            return { answer: 'reject', reason: '现在不太方便接听。' };
        }
        return { answer: 'accept', reason: '喂？我接啦。' };
    }

    // -------------------------------------------------------------------------
    global.openVoiceFeatureChoiceModal = function () {
        var fid = typeof _getCurrentChatFriendId === 'function' ? _getCurrentChatFriendId() : null;
        if (!fid) {
            showNotification('请先进入聊天');
            return;
        }
        var m = document.getElementById('voice-feature-choice-modal');
        if (m) m.classList.add('show');
    };

    global.closeVoiceFeatureChoiceModal = function () {
        var m = document.getElementById('voice-feature-choice-modal');
        if (m) m.classList.remove('show');
    };

    global.onVoiceFeaturePick = function (mode) {
        closeVoiceFeatureChoiceModal();
        if (mode === 'msg') {
            openVoiceMessageComposeModal();
        } else if (mode === 'call') {
            startVoicePhoneFlow();
        }
    };

    global.openVoiceMessageComposeModal = function () {
        var ta = document.getElementById('voice-msg-compose-text');
        if (ta) ta.value = '';
        var m = document.getElementById('voice-msg-compose-modal');
        if (m) m.classList.add('show');
    };

    global.closeVoiceMessageComposeModal = function () {
        var m = document.getElementById('voice-msg-compose-modal');
        if (m) m.classList.remove('show');
    };

    global.submitVoiceMessageCompose = function () {
        var ta = document.getElementById('voice-msg-compose-text');
        var text = ta ? String(ta.value || '').trim() : '';
        if (!text) {
            showNotification('请输入要发送的内容');
            return;
        }
        var chatPage = document.getElementById('chat-page');
        var friendId = chatPage ? chatPage.dataset.friendId : null;
        if (!friendId) return;
        closeVoiceMessageComposeModal();
        var ts = new Date().getTime();
        displayMessage('user', text, null, ts, friendId, 'voice_note_fake');
        saveChatMessage(friendId, 'user', text, null, ts, 'voice_note_fake');
    };

    // -------------------------------------------------------------------------
    function _overlay() {
        return document.getElementById('voice-call-overlay');
    }

    function _setOverlayVisible(v) {
        var o = _overlay();
        if (!o) return;
        o.style.display = v ? 'flex' : 'none';
        try {
            o.setAttribute('aria-hidden', v ? 'false' : 'true');
        } catch (e) {}
        if (!v) {
            o.classList.remove('voice-call-overlay--ringing', 'voice-call-overlay--rejected', 'voice-call-overlay--connected');
            o.classList.remove('voice-call-overlay--minimized');
        }
    }

    function _stopCallTimers() {
        if (CALL_STATE.timerId) {
            clearInterval(CALL_STATE.timerId);
            CALL_STATE.timerId = null;
        }
        if (CALL_STATE.pollId) {
            clearInterval(CALL_STATE.pollId);
            CALL_STATE.pollId = null;
        }
        if (CALL_STATE.abort) {
            try {
                CALL_STATE.abort.abort();
            } catch (e) {}
            CALL_STATE.abort = null;
        }
    }

    function _fmtVoiceCallHangupDur(sec) {
        var s = Math.max(0, Math.floor(Number(sec) || 0));
        var mm = Math.floor(s / 60);
        var rs = s % 60;
        return mm + ':' + (rs < 10 ? '0' + rs : rs);
    }

    /** 主聊天「语音通话结束」折叠卡片 DOM（由 wechat-ui displayMessage 渲染） */
    global.buildVoiceCallEndedBundleHtml = function (summaryText, sessionId, durationSec, friendId, messageTimestamp) {
        var sum = summaryText == null ? '' : String(summaryText);
        var sid = sessionId == null ? '' : String(sessionId);
        var fid = friendId == null ? '' : String(friendId);
        var ds = durationSec != null && durationSec !== '' ? Math.max(0, Math.floor(Number(durationSec))) : null;
        var ts = messageTimestamp != null ? String(messageTimestamp) : '';
        var durLabel = ds != null && !Number.isNaN(ds) ? _fmtVoiceCallHangupDur(ds) : '';
        return (
            '<div class="chat-voice-call-bundle" data-voice-call-friend="' +
                _esc(fid) +
                '" data-voice-session="' +
                _esc(sid) +
                '" data-msg-ts="' +
                _esc(ts) +
                '">' +
                '<button type="button" class="chat-voice-call-bundle-toggle" aria-expanded="false">' +
                '<span class="chat-voice-call-bundle-icon">📞</span>' +
                '<span class="chat-voice-call-bundle-title">' +
                _esc(sum || '语音通话已结束') +
                '</span>' +
                (durLabel ? '<span class="chat-voice-call-bundle-dur">' + _esc(durLabel) + '</span>' : '') +
                '<span class="chat-voice-call-bundle-hint">点击查看记录</span>' +
                '</button>' +
                '<div class="chat-voice-call-bundle-expanded" hidden></div>' +
                '</div>'
        );
    };

    function appendVoiceCallEndedBundleCard(friendId, sessionId, durationSec) {
        if (!friendId || !sessionId || typeof saveChatMessage !== 'function') return;
        var dur = Math.max(0, Math.floor(Number(durationSec) || 0));
        var summary = '语音通话已结束 · 时长 ' + _fmtVoiceCallHangupDur(dur);
        var ts = new Date().getTime();
        saveChatMessage(friendId, 'system', summary, null, ts, 'voice_call_bundle', null, {
            voiceCallSessionId: sessionId,
            voiceCallDurationSec: dur,
            voiceCallEndedAt: ts
        });
        var cp = document.getElementById('chat-page');
        var cur = cp ? cp.dataset.friendId : null;
        var onChat =
            !!(cp && cp.classList.contains('active') && cur && String(cur) === String(friendId));
        if (onChat && typeof loadChatHistory === 'function') loadChatHistory(friendId);
        else if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
        else if (typeof loadChatList === 'function') Promise.resolve(loadChatList()).catch(function () {});
    }

    function endVoiceCallImpl(fromUser) {
        var fid = CALL_STATE.friendId;
        var sess = CALL_STATE.voiceSessionId;
        var dur = CALL_STATE.durationSec || 0;
        var wasConnected = !!sess;

        _stopCallTimers();
        try {
            var ox = document.getElementById('voice-call-overlay');
            if (ox) ox.classList.remove('voice-call-overlay--minimized');
        } catch (eClear) {}
        _setOverlayVisible(false);
        CALL_STATE.friendId = null;
        CALL_STATE.voiceSessionId = null;
        CALL_STATE.durationSec = 0;
        CALL_STATE.minimized = false;
        try {
            if (wasConnected && fid && sess) appendVoiceCallEndedBundleCard(fid, sess, dur);
        } catch (eBund) {}

        if (fromUser) showNotification('已结束语音通话');
    }

    global.endVoiceCall = endVoiceCallImpl;

    function _fmtClock(sec) {
        var s = Math.max(0, Math.floor(sec));
        var mm = Math.floor(s / 60);
        var rs = s % 60;
        return mm + ':' + (rs < 10 ? '0' + rs : rs);
    }

    global.refreshVoiceCallMessageList = function () {
        var box = document.getElementById('voice-call-msg-list');
        if (!box) return;
        var fid = CALL_STATE.friendId;
        if (!fid) return;
        var start = CALL_STATE.startTs || 0;
        var h = typeof getChatHistoryArray === 'function' ? getChatHistoryArray(fid) : [];
        var vcSid = CALL_STATE.voiceSessionId || '';
        var rows = [];
        var i = 0;
        for (; i < h.length; i++) {
            var m = h[i];
            if (vcSid && m.voiceCallSessionId != null && String(m.voiceCallSessionId) !== String(vcSid)) continue;
            if (Number(m.timestamp) < start) continue;
            if (m.type === 'system' && String(m.subtype || '') === 'voice_call_bundle') continue;
            if (m.type !== 'user' && m.type !== 'friend' && m.type !== 'system') continue;
            var side = m.type === 'user' ? 'me' : m.type === 'friend' ? 'them' : 'sys';
            var prev = String(m.content == null ? '' : m.content);
            if (prev.length > 600) prev = prev.slice(0, 600) + '…';
            var safe = _esc(prev).replace(/\n/g, '<br>');
            rows.push(
                '<div class="voice-call-msg voice-call-msg--' +
                    side +
                    '"><div class="voice-call-msg-bubble">' +
                    safe +
                    '</div></div>'
            );
        }
        box.innerHTML = rows.length ? rows.join('') : '<div class="voice-call-msg-empty">暂无消息，在下方输入并发送</div>';
        box.scrollTop = box.scrollHeight;
    };

    function applyVoiceCallFriendChrome(fid) {
        var f = _getFriendForVoice(fid);
        var nickname = f && (f.remark || f.nickname) ? String(f.remark || f.nickname).trim() : '好友';

        function paintAvatar(el) {
            if (!el) return;
            var src = '';
            try {
                src = f
                    ? (typeof getFriendDisplayAvatar === 'function'
                        ? getFriendDisplayAvatar(f)
                        : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || ''))
                    : '';
            } catch (e1) {}
            if (src) {
                try {
                    el.style.backgroundImage = 'url(' + JSON.stringify(src) + ')';
                } catch (e2) {
                    el.style.backgroundImage = '';
                }
                el.classList.remove('voice-call-avatar--empty');
            } else {
                el.style.backgroundImage = '';
                el.classList.add('voice-call-avatar--empty');
            }
        }

        var nLarge = document.getElementById('voice-call-peer-name');
        var nSm = document.getElementById('voice-call-peer-name-sm');
        var nCompact = document.getElementById('voice-call-compact-name');
        if (nLarge) nLarge.textContent = nickname;
        if (nSm) nSm.textContent = nickname;
        if (nCompact) nCompact.textContent = nickname;

        paintAvatar(document.getElementById('voice-call-peer-avatar'));
        paintAvatar(document.getElementById('voice-call-peer-avatar-mini'));
        paintAvatar(document.getElementById('voice-call-compact-avatar'));
    }

    global.startVoicePhoneFlow = function () {
        var chatPage = document.getElementById('chat-page');
        var friendId = chatPage ? chatPage.dataset.friendId : null;
        if (!friendId) return;
        _stopCallTimers();
        CALL_STATE.friendId = friendId;
        CALL_STATE.startTs = new Date().getTime();
        CALL_STATE.voiceSessionId = null;
        CALL_STATE.durationSec = 0;
        CALL_STATE.muted = false;
        CALL_STATE.minimized = false;
        CALL_STATE.volume = 85;

        var o = _overlay();
        if (!o) return;
        o.classList.remove('voice-call-overlay--rejected', 'voice-call-overlay--connected');
        o.classList.add('voice-call-overlay--ringing');
        o.classList.remove('voice-call-overlay--minimized');
        _setOverlayVisible(true);

        applyVoiceCallFriendChrome(friendId);

        var status = document.getElementById('voice-call-status');
        if (status) status.textContent = '正在呼叫…';

        CALL_STATE.abort = new AbortController();
        var prompt = global.buildVoiceCallDecisionPrompt(friendId);
        if (typeof FeatureCommandMapper === 'undefined' || !FeatureCommandMapper.callApiModel) {
            showNotification('无法调用模型');
            endVoiceCallImpl(false);
            return;
        }

        FeatureCommandMapper.callApiModel(prompt, CALL_STATE.abort, {
            skipOverlay: true,
            suppressErrorDialog: true,
        }).then(function (raw) {
            if (!raw) {
                showNotification('接听判定失败，请检查 API');
                endVoiceCallImpl(false);
                return;
            }
            var dec = parseVoiceCallDecisionJson(raw);
            if (dec.answer === 'reject') {
                o.classList.remove('voice-call-overlay--ringing');
                o.classList.add('voice-call-overlay--rejected');
                var rej = document.getElementById('voice-call-reject-reason');
                if (rej) rej.textContent = dec.reason || '对方未接听';
                if (status) status.textContent = '未接听';
                return;
            }
            o.classList.remove('voice-call-overlay--ringing');
            o.classList.add('voice-call-overlay--connected');
            if (status) status.textContent = '通话中';
            CALL_STATE.startTs = new Date().getTime();
            CALL_STATE.voiceSessionId =
                'vc_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 10);
            CALL_STATE.durationSec = 0;
            var tick = 0;
            var clock = document.getElementById('voice-call-timer');
            var clockC = document.getElementById('voice-call-compact-timer');
            if (clock) clock.textContent = '0:00';
            if (clockC) clockC.textContent = '0:00';
            CALL_STATE.timerId = setInterval(function () {
                tick++;
                CALL_STATE.durationSec = tick;
                var t = _fmtClock(tick);
                if (clock) clock.textContent = t;
                if (clockC) clockC.textContent = t;
            }, 1000);
            refreshVoiceCallMessageList();
            CALL_STATE.pollId = setInterval(function () {
                refreshVoiceCallMessageList();
            }, 800);

            var vol = document.getElementById('voice-call-volume');
            if (vol) {
                vol.value = String(CALL_STATE.volume);
                vol.oninput = function () {
                    CALL_STATE.volume = Number(vol.value) || 0;
                };
            }
        });
    };

    global.abortVoiceOutgoingCall = function () {
        endVoiceCallImpl(false);
        showNotification('已取消呼叫');
    };

    global.onVoiceCallRejectClose = function () {
        endVoiceCallImpl(false);
    };

    global.toggleVoiceCallMute = function () {
        CALL_STATE.muted = !CALL_STATE.muted;
        var b = document.getElementById('voice-call-mute-btn');
        if (b) b.classList.toggle('voice-call-ctl--active', CALL_STATE.muted);
    };

    global.toggleVoiceCallMinimize = function () {
        var o = _overlay();
        if (!o || !o.classList.contains('voice-call-overlay--connected')) return;
        CALL_STATE.minimized = !CALL_STATE.minimized;
        o.classList.toggle('voice-call-overlay--minimized', CALL_STATE.minimized);
    };

    global.sendVoiceCallPanelMessage = function () {
        var inp = document.getElementById('voice-call-input');
        if (!inp) return;
        var message = String(inp.value || '').trim();
        if (!message) return;
        var chatPage = document.getElementById('chat-page');
        var friendId = chatPage ? chatPage.dataset.friendId : null;
        if (!friendId) return;
        var sess = CALL_STATE.voiceSessionId;
        if (!sess) {
            showNotification('请等待接通后再发送');
            return;
        }
        var bridge = typeof global.__chatUiBridge !== 'undefined' && global.__chatUiBridge ? global.__chatUiBridge : {};
        if (bridge.isReceiving) {
            showNotification('请等待当前接收完成');
            return;
        }
        inp.value = '';
        var ts = new Date().getTime();
        var extra = { voiceCallSessionId: sess, voiceCallSuppressMainChat: true };
        saveChatMessage(friendId, 'user', message, null, ts, null, null, extra);
        try {
            window._voiceCallFriendReplyTag = { sessionId: sess };
        } catch (eTag) {}
        var rb = document.querySelector('.receive-btn');
        if (rb) rb.click();
        setTimeout(function () {
            if (typeof refreshVoiceCallMessageList === 'function') refreshVoiceCallMessageList();
        }, 0);
        setTimeout(function () {
            if (typeof refreshVoiceCallMessageList === 'function') refreshVoiceCallMessageList();
        }, 600);
    };

    global.onVoiceCallInputKeydown = function (e) {
        if (e.key === 'Enter') {
            e.preventDefault();
            sendVoiceCallPanelMessage();
        }
    };

    function bindVoiceCallBundleDelegation() {
        var cp = document.getElementById('chat-page');
        if (!cp || cp.dataset.voiceCallBundleBound === '1') return;
        cp.dataset.voiceCallBundleBound = '1';
        function fillVoiceCallBundleExpanded(expEl, fid, sid) {
            if (!expEl || !fid || !sid || typeof getChatHistoryArray !== 'function') return;
            var h = getChatHistoryArray(fid);
            var rows = [];
            var nameLab = _getVoiceCallTranscriptNameLabels(fid);
            var i = 0;
            for (; i < h.length; i++) {
                var m = h[i];
                if (!m || String(m.voiceCallSessionId || '') !== String(sid)) continue;
                if (!m.voiceCallSuppressMainChat) continue;
                if (m.type !== 'user' && m.type !== 'friend') continue;
                var side = m.type === 'user' ? 'me' : 'them';
                var lab = m.type === 'user' ? nameLab.user : nameLab.friend;
                var txt = String(m.content == null ? '' : m.content);
                if (txt.length > 4000) txt = txt.slice(0, 4000) + '…';
                rows.push(
                    '<div class="chat-voice-call-inline chat-voice-call-inline--' +
                        side +
                        '"><span class="chat-voice-call-inline-label">' +
                        _esc(lab) +
                        '</span><div class="chat-voice-call-inline-text">' +
                        _esc(txt).replace(/\n/g, '<br>') +
                        '</div></div>'
                );
            }
            expEl.innerHTML = rows.length ? rows.join('') : '<div class="chat-voice-call-inline-empty">暂无通话内记录</div>';
        }
        cp.addEventListener(
            'click',
            function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('.chat-voice-call-bundle-toggle') : null;
                if (!btn || !cp.contains(btn)) return;
                var bridge =
                    typeof global.__chatUiBridge !== 'undefined' && global.__chatUiBridge
                        ? global.__chatUiBridge
                        : {};
                if (bridge.isMultiselectMode) return;
                e.preventDefault();
                e.stopPropagation();
                var root = btn.closest('.chat-voice-call-bundle');
                if (!root) return;
                var exp = root.querySelector('.chat-voice-call-bundle-expanded');
                if (!exp) return;
                var fid = root.getAttribute('data-voice-call-friend');
                var sid = root.getAttribute('data-voice-session');
                var open = !!exp.hidden;
                if (open && fid && sid) fillVoiceCallBundleExpanded(exp, fid, sid);
                exp.hidden = !open;
                btn.setAttribute('aria-expanded', open ? 'true' : 'false');
            },
            true
        );
    }

    document.addEventListener('DOMContentLoaded', function () {
        bindVoiceNoteDelegation();
        bindVoiceCallBundleDelegation();
    });

    /** 语音电话已接通且叠加层尚在：用于禁用表情、拍一拍、转账/红包等入口 */
    global.isVoicePhoneCallActive = function () {
        try {
            if (!CALL_STATE.voiceSessionId) return false;
            var ox = global.document ? global.document.getElementById('voice-call-overlay') : null;
            if (!ox) return false;
            if (ox.style.display === 'none') return false;
            return !!(ox.classList && ox.classList.contains('voice-call-overlay--connected'));
        } catch (e) {
            return false;
        }
    };
})(typeof window !== 'undefined' ? window : this);
