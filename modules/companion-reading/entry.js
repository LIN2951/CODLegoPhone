/* Host adapter for the isolated reading screen. */
(function (host) {
    'use strict';

    const moduleUrl = new URL('./', document.currentScript.src);
    const pageUrl = new URL('index.html?v=4', moduleUrl);
    const buttonId = 'couple-private-companion-reading-btn';
    const historyKey = 'legoCompanionReading';
    const MAX_PROMPT_LENGTH = 720 * 1024;
    const engines = new Map();
    let active = null;
    let opening = false;
    let sequence = 0;

    function readObject(key) {
        try { return JSON.parse(localStorage.getItem(key) || '{}') || {}; }
        catch (_) { return {}; }
    }

    function clip(value, limit) {
        return String(value ?? '').trim().slice(0, limit);
    }

    function coupleFor(friendId) {
        const pair = friendId && host.Wechat?.store?.coupleSpace?.getPair(friendId);
        if (pair?.status !== 'accepted') return null;
        const scope = JSON.stringify(['couple', friendId, pair.acceptedAt ?? pair.lastInviteId ?? '']);
        return { friendId, pair, scope };
    }

    function getCouple() {
        const page = document.getElementById('couple-private-page');
        const friendId = document.getElementById('couple-private-editable-title')?.dataset.friendId;
        const couple = coupleFor(friendId);
        if (!page?.classList.contains('show') || !page.getClientRects().length || !couple) {
            throw new Error('请从已确认关系的情侣空间进入。');
        }
        return { ...couple, page };
    }

    function currentBinding(binding) {
        const couple = coupleFor(binding.friendId);
        if (couple?.scope !== binding.scope) throw new Error('当前情侣关系已变更，本次共读回应已停止。');
        return couple;
    }

    function check(state, caller) {
        if (active !== state || state.closing || caller !== state.frame.contentWindow) {
            throw new Error('当前阅读窗口已关闭，请重新进入相伴阅读。');
        }
        const couple = getCouple();
        if (couple.scope !== state.scope || couple.page !== state.page) {
            throw new Error('情侣空间已切换，请重新进入相伴阅读。');
        }
        return couple;
    }

    function avatarUrl(value) {
        const raw = host.normalizeAvatarUrl?.(value);
        if (!raw) return '';
        if (/^data:image\/(?:png|jpe?g|webp|gif|avif);base64,/i.test(raw)) return raw;
        try {
            const url = new URL(raw, document.baseURI);
            return /^(https?:|blob:)$/.test(url.protocol) ? url.href : '';
        } catch (_) { return ''; }
    }

    function people(couple) {
        const friend = host.loadFriendsFromStorage?.().find(item => String(item?.id) === couple.friendId);
        if (!friend || friend.isGroup) throw new Error('情侣资料未就绪，请返回后重新进入。');
        const profile = host.safeReadJsonFromStorage?.('myProfile', {}) || readObject('myProfile');
        const userInfo = readObject('userInfo');
        const persona = friend.persona?.id || friend.persona?.nickname || friend.persona?.identity ? friend.persona : profile;
        return {
            friend, persona, profile,
            userName: clip(persona.nickname || profile.nickname || userInfo.nickname || profile.name, 100) || '我',
            friendName: clip(friend.remark || friend.nickname || couple.pair.friendName, 100) || 'TA',
            userAvatar: avatarUrl(persona.avatar || userInfo.avatar || profile.avatar),
            friendAvatar: avatarUrl(friend.chatAvatar || host.getFriendDisplayAvatar?.(friend) || couple.pair.friendAvatar)
        };
    }

    function configuredLanguage(friend) {
        const options = document.getElementById('fs-output-language-select')?.options || [];
        const selected = Array.from(options).find(option => option.value === friend.outputLanguage);
        return { outputLanguage: selected?.value || 'zh', language: selected?.textContent.trim() || '中文' };
    }

    function boundTextWorldBooks(friend) {
        const ids = Array.isArray(friend.worldBookIds) ? friend.worldBookIds : [friend.worldBookId];
        const wanted = [...new Set(ids.filter(id => id != null && id !== '').map(String))];
        if (!wanted.length) return '';
        const entries = host.getWorldBookData?.()?.entries || [];
        const byId = new Map(entries.filter(Boolean).map(entry => [String(entry.id), entry]));
        return wanted.flatMap(id => {
            const entry = byId.get(id);
            const body = typeof entry?.content === 'string' ? entry.content.trim() : '';
            // Dedicated reading only receives text entries, including entries using normal keyword activation in WeChat.
            if (!body || /<\s*(?:!doctype\b|!--|\/?[a-z][\w:-]*(?:\s+[^<>]*)?\s*\/?>)/i.test(body)) return [];
            return [`世界书《${String(entry.name || '未命名').trim()}》\n${body}`];
        }).join('\n\n');
    }

    function recentChatRounds(history, count) {
        // The WeChat round definition pairs contiguous user messages with contiguous friend replies.
        // Walk from the end, copying only the configured completed rounds.
        const rounds = [];
        let cursor = history.length;
        while (cursor > 0 && rounds.length < count) {
            while (cursor > 0 && history[cursor - 1]?.type !== 'friend') cursor--;
            const friendEnd = cursor;
            while (cursor > 0 && history[cursor - 1]?.type === 'friend') cursor--;
            const userEnd = cursor;
            while (cursor > 0 && history[cursor - 1]?.type === 'user') cursor--;
            if (cursor < userEnd) {
                rounds.push({ user: history.slice(cursor, userEnd), friend: history.slice(userEnd, friendEnd) });
            }
        }
        return rounds.reverse();
    }

    async function roleContext(binding, { signal } = {}) {
        signal?.throwIfAborted();
        const { friendId } = currentBinding(binding);
        const prompts = host.Wechat?.prompts;
        const commands = host.CommandManager;
        if (!prompts?._formatHistoryLines || !commands?.getCoreCommands) throw new Error('微信聊天设置暂未载入，请重试。');
        const roundsLimit = prompts._clampInt(readObject('apiSettings').memoryCount, 0, 100, 50);
        const { count: memoryLimit } = prompts._getLongMemoryInjectionConfig(friendId, roundsLimit);
        const history = roundsLimit ? await host.ensureChatHistoryReady(friendId) : [];
        signal?.throwIfAborted();
        const rounds = recentChatRounds(history, roundsLimit);
        const hasEmoji = rounds.some(round => [...round.user, ...round.friend].some(message => host.isChatEmojiContent?.(message.content)));
        let emojis = [];
        if (hasEmoji) {
            const data = host.parseJsonFromPossiblyEncodedStorage?.('emojiData', {}) || {};
            emojis = Object.values(data).filter(Array.isArray).flat();
        }
        const person = people(currentBinding(binding));
        const { friend, persona, profile, userName, friendName } = person;
        const memory = memoryLimit ? host._loadChatLongMemories(friendId).filter(item => String(item?.content || '').trim()).slice(0, memoryLimit) : [];
        return {
            core: commands.getCoreCommands().map(command => command.content).filter(Boolean).join('\n\n'),
            world: boundTextWorldBooks(friend),
            role: String(friend.roleSetting || friend.role || '').trim(),
            persona: `昵称：${userName}\n身份与设定：${String(persona.identity || profile.identity || '未设置').trim()}`,
            longMemory: memory.map((item, index) => `【长记忆摘要 ${index + 1}/${memory.length}】\n${String(item.content).trim()}`).join('\n\n'),
            conversation: rounds.length ? prompts._formatHistoryLines(rounds, rounds.length,
                text => host.formatMessageForApi?.(text, emojis) ?? text, { userLabel: userName, friendLabel: friendName }).join('\n') : '',
            bindingIdentity: roleIdentity(person),
            userName, friendName,
            ...configuredLanguage(friend)
        };
    }

    function roleIdentity({ friend, persona, profile, userName, friendName }) {
        return JSON.stringify([persona.id, userName, friendName, friend.roleSetting || friend.role, persona.identity || profile.identity, friend.outputLanguage]);
    }

    function configuration() {
        const settings = readObject('apiSettings');
        return {
            ready: !!(clip(settings.apiUrl, 2048) && clip(settings.apiKey, 4096) && clip(settings.model, 256)),
            model: clip(settings.model, 256)
        };
    }

    async function request(binding, prompt, signal, roleSnapshot) {
        const couple = currentBinding(binding);
        if (typeof prompt !== 'string' || !prompt.trim()) throw new Error('这次共读没有可发送的内容。');
        if (prompt.length > MAX_PROMPT_LENGTH) {
            throw new Error('完整共读上下文超出本机 API 的发送上限。可调低微信的记忆轮数或总结长记忆注入数量后重试。');
        }
        const config = configuration();
        const mapper = host.FeatureCommandMapper;
        if (!config.ready || !mapper?.callApiModel) throw new Error('请先在 Lego 的 API 设置中配置接口并选择模型。');
        signal?.throwIfAborted();
        const identity = roleIdentity(people(couple));
        if (roleSnapshot?.bindingIdentity && roleSnapshot.bindingIdentity !== identity) {
            throw new Error('共读角色或输出语言已变更，请重试。');
        }
        const reply = await mapper.callApiModel(prompt, { signal }, {
            skipOverlay: true, suppressErrorDialog: true, apiRetry: false
        });
        signal?.throwIfAborted();
        if (roleIdentity(people(currentBinding(binding))) !== identity) throw new Error('共读角色或输出语言已变更，请重试。');
        if (typeof reply !== 'string' || !reply.trim()) throw new Error('未收到回应，请检查 API 设置。');
        if (reply.length > 32000) throw new Error('收到的回应过长。');
        return { text: reply.trim(), model: config.model };
    }

    function getEngine({ friendId, scope }) {
        const remembered = engines.get(scope);
        if (remembered) return remembered.engine;
        const binding = { friendId, scope };
        const ready = Promise.all([
            import(new URL('companion.js?v=3', moduleUrl).href),
            import(new URL('reading-context.js?v=3', moduleUrl).href)
        ]).then(([{ createCompanion }, { createReadingContext }]) => {
            const { userName, friendName } = people(currentBinding(binding));
            const engine = createCompanion({
                scope, userName, friendName, getReadingContext: createReadingContext(scope),
                getRoleContext: options => roleContext(binding, options),
                request: (prompt, signal, roleSnapshot) => request(binding, prompt, signal, roleSnapshot)
            });
            void engine.resume().catch(() => {});
            return engine;
        }).catch(error => {
            if (engines.get(scope)?.engine === ready) engines.delete(scope);
            throw error;
        });
        engines.set(scope, { binding, engine: ready });
        return ready;
    }

    async function checkedEngine(state, caller) {
        const couple = check(state, caller);
        const engine = await getEngine(couple);
        check(state, caller);
        const methods = Object.fromEntries(['get', 'send', 'retry', 'cancel', 'leave', 'remove'].map(name => [name, (...args) => {
            check(state, caller);
            return engine[name](...args);
        }]));
        return Object.freeze({ ...methods, watch(...args) {
            check(state, caller);
            const stop = engine.watch(...args);
            const release = () => {
                if (state.unsubscribers.delete(release)) stop();
            };
            state.unsubscribers.add(release);
            return release;
        } });
    }

    function retireEndedCouples() {
        for (const [scope, record] of engines) {
            if (coupleFor(record.binding.friendId)?.scope === scope) continue;
            engines.delete(scope);
            void record.engine.then(engine => engine.dispose()).catch(() => {});
        }
    }

    function backFrom(state) {
        if (history.state?.[historyKey] !== state.id) return Promise.resolve();
        return new Promise(resolve => {
            const finish = () => {
                clearTimeout(timer);
                host.removeEventListener('popstate', finish);
                resolve();
            };
            const timer = setTimeout(finish, 700);
            host.addEventListener('popstate', finish, { once: true });
            history.back();
        });
    }

    async function close(state, fromHistory = false) {
        if (active !== state || state.closing) return;
        state.closing = true;
        clearInterval(state.watch);
        for (const stop of state.unsubscribers) stop();
        let timer;
        try {
            await Promise.race([
                state.frame.contentWindow?.LegoCompanionReadingPage?.prepareClose?.(),
                new Promise(resolve => { timer = setTimeout(resolve, 1200); })
            ]);
        } catch (_) {
            // The frame may already have been unloaded via browser history.
        } finally {
            clearTimeout(timer);
            state.layer.remove();
            state.inert.forEach(([element, previous]) => { element.inert = previous; });
            if (host.LegoCompanionReadingHost === state.bridge) delete host.LegoCompanionReadingHost;
            if (!fromHistory) await backFrom(state);
            active = null;
            if (state.button.getClientRects().length) state.button.focus({ preventScroll: true });
        }
    }

    async function open(button) {
        if (active || opening) return;
        opening = true;
        let state;
        try {
            const initial = getCouple();
            await host.initFriendsFromIndexedDBIfNeeded?.();
            const couple = getCouple();
            if (initial.scope !== couple.scope || initial.page !== couple.page) throw new Error('情侣空间已切换，请重新进入。');
            people(couple);
            const app = document.getElementById('app');
            const layer = document.createElement('div');
            layer.id = 'lego-companion-reading-layer';
            layer.setAttribute('role', 'dialog');
            layer.setAttribute('aria-modal', 'true');
            layer.setAttribute('aria-label', '相伴阅读');
            layer.style.cssText = 'position:absolute;inset:0;z-index:3200;overflow:hidden;border-radius:inherit;background:#f7f1e9';
            const frame = document.createElement('iframe');
            frame.title = '相伴阅读';
            frame.style.cssText = 'display:block;width:100%;height:100%;border:0';
            // The floating API ball stays interactive above the reading layer.
            const inert = [...app.children].filter(element => element.id !== 'api-floating-ball')
                .map(element => [element, element.inert]);
            const id = `${Date.now()}-${++sequence}`;
            retireEndedCouples();
            state = { ...couple, id, layer, frame, button, inert, closing: false, unsubscribers: new Set() };
            state.bridge = Object.freeze({
                context(caller) {
                    const { userName, friendName, userAvatar, friendAvatar } = people(check(state, caller));
                    return Object.freeze({ scope: state.scope, userName, friendName, userAvatar, friendAvatar });
                },
                configuration(caller) { check(state, caller); return configuration(); },
                companion: caller => checkedEngine(state, caller),
                close(caller) { check(state, caller); return close(state); }
            });

            history.pushState({ ...history.state, [historyKey]: id }, '');
            active = state;
            host.LegoCompanionReadingHost = state.bridge;
            inert.forEach(([element]) => { element.inert = true; });
            frame.src = pageUrl.href;
            layer.append(frame);
            app.append(layer);
            frame.focus();
            state.watch = setInterval(() => {
                try { check(state, frame.contentWindow); }
                catch (_) { void close(state); }
            }, 800);
        } catch (error) {
            if (state && active === state) await close(state);
            host.showErrorDialog?.('相伴阅读', error.message || '暂时无法打开，请稍后再试。');
        } finally {
            opening = false;
        }
    }

    document.addEventListener('click', event => {
        const button = event.target.closest?.('#' + buttonId);
        if (button) void open(button);
    });
    host.addEventListener('popstate', () => {
        if (active && history.state?.[historyKey] !== active.id) void close(active, true);
    });
    host.addEventListener('keydown', event => {
        if (active && event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault();
            void close(active);
        }
    });
    host.addEventListener('storage', event => {
        const couples = host.Wechat?.store?.coupleSpace;
        if (event.key === couples?.STATE_KEY || event.key === null) {
            couples?.invalidateMemCache?.();
            retireEndedCouples();
        }
    });
})(window);
