/** 主动消息的纯规则；浏览器与回归测试共用，不读取用户存储。 */
(function (root) {
    'use strict';
    function int(value, min, max, fallback) {
        if (value == null || value === '') return fallback;
        var n = Number(value);
        return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.floor(n))) : fallback;
    }
    function time(value, fallback) {
        var m = /^(\d{1,2}):(\d{2})$/.exec(String(value || ''));
        return m && +m[1] < 24 && +m[2] < 60 ? m[1].padStart(2, '0') + ':' + m[2] : fallback;
    }
    function settings(raw) {
        var s = raw && typeof raw === 'object' ? raw : {};
        return {
            enabled: !!s.enabled,
            intervalMinutes: int(s.intervalMinutes, 0, 1440, 30),
            timeStart: time(s.timeStart, '09:00'), timeEnd: time(s.timeEnd, '23:00'),
            candidateIds: Array.from(new Set((Array.isArray(s.candidateIds) ? s.candidateIds : [])
                .filter(function (id) { return typeof id === 'string' || typeof id === 'number'; })
                .map(String).filter(Boolean))),
            systemNotify: !!s.systemNotify
        };
    }
    function minutes(hm) { var p = hm.split(':'); return +p[0] * 60 + +p[1]; }
    function within(s, date) {
        var cur = date.getHours() * 60 + date.getMinutes();
        var a = minutes(s.timeStart), b = minutes(s.timeEnd);
        // 同值表示全天；结束时刻不再发送。
        return a === b || (a < b ? cur >= a && cur < b : cur >= a || cur < b);
    }
    function nextAllowed(s, at) {
        var d = new Date(at);
        if (within(s, d)) return at;
        var start = minutes(s.timeStart);
        d.setHours(Math.floor(start / 60), start % 60, 0, 0);
        if (d.getTime() < at) d.setDate(d.getDate() + 1);
        return d.getTime();
    }
    function delay(s, random) {
        return (s.intervalMinutes || (10 + Math.floor((random || Math.random)() * 51))) * 60000;
    }
    function hash(value) {
        var str = String(value), h = 2166136261;
        for (var i = 0; i < str.length; i++) h = Math.imul(h ^ str.charCodeAt(i), 16777619);
        return (h >>> 0).toString(36);
    }
    function persona(friend, profile) {
        var p = friend.persona;
        return p && (p.nickname || p.identity || p.id) ? p : (profile || {});
    }
    function scope(friend, profile) {
        var p = persona(friend, profile);
        return String(friend.id) + ':' + hash(JSON.stringify([p.id || '', p.nickname || '', p.identity || '']));
    }
    function signature(history) {
        // 含编辑/回溯/媒体状态，不能只用末条时间戳判断上下文是否仍有效。
        return hash(JSON.stringify(history));
    }
    function lastDialogue(history) {
        for (var i = history.length - 1; i >= 0; i--) {
            if (history[i] && /^(user|friend)$/.test(history[i].type) && !history[i].voiceCallSuppressMainChat) return history[i];
        }
        return null;
    }
    function talkative(friend) {
        var card = String(friend.roleSetting || friend.role || '');
        return /(?:话唠|嘴碎|表达欲(?:很|较|非常)?强|习惯[^。\n]{0,15}(?:短句连发|连发短句)|talkative|chatterbox)/i.test(card)
            && !/(?:不是|并非|不属于|不算|禁止|不要)[^。\n]{0,8}(?:话唠|嘴碎|表达欲强)|not\s+(?:very\s+)?talkative/i.test(card);
    }
    function parseOutput(raw, context) {
        var text = String(raw || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
        var obj;
        try { obj = JSON.parse(text); } catch (_) { return null; }
        if (!obj || !Array.isArray(obj.messages)) return null;
        var max = context.talkative ? 6 : 3;
        if (!obj.messages.length || obj.messages.length > max) return null;
        var limit = context.talkative ? 60 : 220;
        var plain = function (s) {
            return typeof s === 'string' && s.trim() && !/[<>]|```|\*|^\s*(?:#{1,6}\s|[-+]\s|\d+[.)、]\s)/m.test(s)
                && !/\b(?:Char|User)\b|(?:作为|我是)(?:一个)?(?:AI|人工智能|语言模型|模型|系统)/i.test(s);
        };
        if (obj.messages.some(function (s) { return !plain(s) || Array.from(s.trim()).length > limit; })) return null;
        var messages = obj.messages.map(function (s) { return s.trim(); });
        if (new Set(messages).size !== messages.length) return null;
        var emotion = context.requireEmotion && typeof obj.emotion === 'string' ? obj.emotion.trim() : '';
        if (context.requireEmotion && (!plain(emotion) || Array.from(emotion).length > 500 || /\n\s*\n/.test(emotion))) return null;
        // 非心绪轮即使模型误带 emotion，也绝不展示或落库。
        return { messages: messages, emotion: emotion };
    }
    // 一轮为连续用户消息及好友回复；独立主动批次也是一轮，未回复消息保留在最后一轮。
    function recentHistory(history, count) {
        var rounds = [], current = null, previous = null;
        history.forEach(function (m) {
            if (!m || !/^(user|friend)$/.test(m.type) || m.voiceCallSuppressMainChat) return;
            var newRound = !current || (m.type === 'user' && previous.type === 'friend') ||
                (m.proactiveKind === 'share' && m.proactiveBatchId && m.proactiveBatchId !== previous.proactiveBatchId);
            if (newRound) { current = []; rounds.push(current); }
            current.push(m); previous = m;
        });
        return count > 0 ? rounds.slice(-count).flat() : [];
    }
    var api = { settings: settings, int: int, within: within, nextAllowed: nextAllowed, delay: delay,
        hash: hash, persona: persona, scope: scope, signature: signature, lastDialogue: lastDialogue,
        talkative: talkative, parseOutput: parseOutput, recentHistory: recentHistory };
    root.LegoProactiveCore = api;
    if (typeof module === 'object' && module.exports) module.exports = api;
})(typeof window === 'undefined' ? globalThis : window);
