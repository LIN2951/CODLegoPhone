/* Lego host adapter. All tarot business logic, state and cache live in this directory. */
(function (global) {
    'use strict';
    const base = new URL('./', document.currentScript.src);
    let opened = null, opening = false;
    const notify = message => { if (typeof global.showNotification === 'function') global.showNotification(message); };
    const read = key => { try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) { return {}; } };
    const bounded = (value, max) => String(value || '').slice(0, max);
    function snapshot() {
        const page = document.getElementById('couple-private-page');
        const title = document.getElementById('couple-private-editable-title');
        const friendId = title?.getAttribute('data-friend-id');
        const store = global.Wechat?.store?.coupleSpace;
        const pair = friendId && store?.getPair(friendId);
        if (!page?.classList.contains('show') || !page.getClientRects().length || pair?.status !== 'accepted') throw new Error('请从已确认关系的情侣空间进入迷恋塔罗');
        const friends = typeof global.loadFriendsFromStorage === 'function' ? global.loadFriendsFromStorage() : [];
        const friend = friends.find(f => String(f.id) === String(friendId));
        if (!friend) throw new Error('好友数据未就绪，请稍后再试');
        const profile = read('myProfile');
        const persona = friend.persona && (friend.persona.id || friend.persona.nickname || friend.persona.identity) ? friend.persona : profile;
        const identity = persona.id ? ['id', String(persona.id)] : ['profile', String(persona.nickname || ''), String(persona.identity || '')];
        const scopeInput = JSON.stringify([String(friendId), identity, String(pair.acceptedAt || '')]);
        return { page, friendId: String(friendId), scopeInput,
            binding: JSON.stringify([scopeInput, friend.roleSetting || friend.role || '', persona.nickname || '', persona.identity || '']),
            userName: bounded(persona.nickname || read('userInfo').nickname || '我', 100),
            friendName: bounded(friend.remark || friend.nickname || 'TA', 100),
            role: bounded(friend.roleSetting || friend.role, 14000), persona: bounded(persona.identity, 8000), friend };
    }
    function assertCaller(caller, scope) {
        if (!opened || opened.closing || caller !== opened.frame.contentWindow || (scope && scope !== opened.scope)) throw new Error('当前塔罗页面已关闭或切换，请重新进入');
        const fresh = snapshot();
        if (fresh.binding !== opened.binding) throw new Error('好友或人设已变更，本次解读已停止');
        return fresh;
    }
    async function close(fromHistory) {
        const current = opened;
        if (!current || current.closing) return;
        current.closing = true;
        clearInterval(current.watch);
        if (current.controller) current.controller.abort();
        try {
            const prepare = current.frame.contentWindow?.LegoTarotPage?.prepareClose;
            if (prepare) await Promise.race([prepare(), new Promise(resolve => setTimeout(resolve, 1500))]);
        } catch (_) {}
        current.layer.remove();
        for (const [node, previous] of current.inert) node.inert = previous;
        if (!fromHistory && history.state?.legoMilianTarot === current.historyId) {
            await new Promise(resolve => {
                let timer;
                const finish = () => { clearTimeout(timer); global.removeEventListener('popstate', finish); resolve(); };
                global.addEventListener('popstate', finish, { once: true });
                timer = setTimeout(finish, 600); history.back();
            });
        }
        if (opened === current) opened = null;
        document.getElementById('couple-private-tarot-btn')?.focus();
    }
    async function open() {
        if (opened || opening) return;
        opening = true;
        try {
            if (typeof global.loadFriendsFromStorageAsync === 'function') await global.loadFriendsFromStorageAsync();
            const initial = snapshot();
            const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(initial.scopeInput));
            const scope = 'sc_' + [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2, '0')).join('');
            if (snapshot().binding !== initial.binding) throw new Error('情侣空间已变更，请重新打开');
            const layer = document.createElement('div'); layer.id = 'lego-milian-tarot-layer';
            layer.style.cssText = 'position:absolute;inset:0;z-index:90;background:#181223;border-radius:inherit;overflow:hidden';
            const frame = document.createElement('iframe');
            frame.title = '迷恋塔罗'; frame.allow = 'clipboard-write';
            frame.style.cssText = 'display:block;width:100%;height:100%;border:0;color-scheme:dark';
            const inert = [...initial.page.children].map(node => [node, node.inert]);
            for (const [node] of inert) node.inert = true;
            const historyId = crypto.randomUUID();
            opened = { ...initial, scope, frame, layer, inert, historyId, closing: false };
            frame.src = new URL('index.html?v=1.0.1', base).href;
            layer.append(frame); initial.page.append(layer);
            history.pushState({ ...history.state, legoMilianTarot: historyId }, '');
            opened.watch = setInterval(() => {
                try { assertCaller(frame.contentWindow, scope); } catch (_) { void close(false); }
            }, 750);
            frame.focus();
        } catch (error) { notify(error.message || '迷恋塔罗暂时无法打开'); }
        finally { opening = false; }
    }
    global.LegoMilianTarot = {
        open, close,
        context(caller, includeConversation) {
            const fresh = assertCaller(caller);
            let conversation = '', world = '';
            if (includeConversation) {
                const messages = typeof global.getChatHistoryArray === 'function' ? global.getChatHistoryArray(fresh.friendId) : [];
                conversation = messages.filter(m => /^(user|friend)$/.test(m.type) && !m.voiceCallSuppressMainChat && typeof m.content === 'string')
                    .slice(-10).map(m => (m.type === 'user' ? fresh.userName : fresh.friendName) + '：' + bounded(m.content, 800)).join('\n');
                try {
                    const ids = new Set((fresh.friend.worldBookIds || [fresh.friend.worldBookId]).filter(Boolean).map(String));
                    world = (global.getWorldBookData?.().entries || []).filter(e => ids.has(String(e.id)))
                        .map(e => bounded(e.name, 100) + '\n' + bounded(e.content, 2500)).join('\n').slice(0, 6000);
                } catch (_) {}
            }
            return { scope: opened.scope, userName: fresh.userName, friendName: fresh.friendName,
                ...(includeConversation ? { role: fresh.role, persona: fresh.persona, conversation, world } : {}) };
        },
        configuration(caller) {
            assertCaller(caller);
            const settings = read('apiSettings');
            return { ready: !!(settings.apiUrl && settings.apiKey && settings.model), model: bounded(settings.model, 256) };
        },
        async request(caller, scope, prompt, signal) {
            assertCaller(caller, scope);
            if (typeof prompt !== 'string' || prompt.length > 65000) throw new Error('解读内容超出大小限制');
            const current = opened;
            if (current.controller) throw new Error('已有解读进行中');
            const config = this.configuration(caller);
            if (!config.ready) throw new Error('请先在 Lego 的 API 设置中填写接口并选择模型');
            const controller = new AbortController(); current.controller = controller;
            const abort = () => controller.abort();
            signal?.addEventListener('abort', abort, { once: true });
            if (signal?.aborted) abort();
            const timer = setTimeout(abort, 90000);
            try {
                const output = await global.FeatureCommandMapper.callApiModel(prompt, controller, {
                    skipOverlay: true, suppressErrorDialog: true, apiRetry: false
                });
                assertCaller(caller, scope);
                if (controller.signal.aborted) throw new Error('已停止等待；本次请求可能已计费');
                if (typeof output !== 'string' || !output.trim()) throw new Error('未收到有效解读，请检查 API 设置后手动重试');
                if (output.length > 32000) throw new Error('解读过长，未写入记录；请缩小 API 的输出预算后重试');
                return { text: output.trim(), model: config.model };
            } finally {
                clearTimeout(timer); signal?.removeEventListener('abort', abort);
                if (current.controller === controller) current.controller = null;
            }
        },
        exportBackup: async () => (await import(new URL('storage.js', base).href)).exportBackup(),
        importBackup: async backup => {
            await close(false);
            return (await import(new URL('storage.js', base).href)).importBackup(backup);
        },
        clearAllData: async () => {
            await close(false);
            await (await import(new URL('storage.js', base).href)).clearAllData();
            await (await import(new URL('cache.js', base).href)).clearTarotCache();
        }
    };
    document.addEventListener('click', event => {
        if (event.target.closest?.('#couple-private-tarot-btn')) { event.preventDefault(); void open(); }
    });
    global.addEventListener('popstate', () => { if (opened && history.state?.legoMilianTarot !== opened.historyId) void close(true); });
    global.addEventListener('keydown', event => { if (opened && event.key === 'Escape') { event.preventDefault(); void close(false); } });
})(window);
