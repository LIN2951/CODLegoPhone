import { changeCompanionState, readCompanionScope, readCompanionState } from './companion-store.js?v=3';
import { buildCompanionPrompt, MESSAGE_LIMIT, normalizePassage, readCompanionReply } from './companion-prompt.js?v=3';

export const REPLY_DELAY_MS = 30000;
const REQUEST_LIMIT_MS = 16 * 60 * 1000;
// An interrupted tab cannot prove whether a request reached the API. Keep its
// lease longer than the API's maximum wait and recover it for manual retry.
const REQUEST_LEASE_MS = 17 * 60 * 1000;

function key(value, label) {
    const result = String(value ?? '').trim();
    if (!result || result.length > 256) throw new Error(`无法识别${label}，请重新进入。`);
    return result;
}

function makeId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, '0')).join('');
}

function normalizeState(raw, scope, bookId) {
    return {
        scope, bookId, active: !!raw?.active, messages: Array.isArray(raw?.messages) ? raw.messages : [],
        lastPassage: raw?.lastPassage ?? null, batches: Array.isArray(raw?.batches) ? raw.batches : []
    };
}

function currentWork({ active, batches }) {
    if (!active) return { pending: null, queued: null, failed: null, failureCount: 0 };
    const pending = batches.find(batch => batch.status === 'pending') ?? null;
    const queued = batches.filter(batch => batch.status === 'queued')
        .sort((a, b) => a.dueAt - b.dueAt)[0] ?? null;
    const failures = batches.filter(batch => batch.status === 'failed');
    return { pending, queued, failed: failures[0] ?? null, failureCount: failures.length };
}

function summary(batch, details) {
    return batch ? { id: batch.id, kind: 'comment', messageIds: batch.items.map(item => item.id), ...details } : null;
}

function view(state) {
    const { active, bookId, scope, messages, lastPassage } = state;
    const { pending, queued, failed, failureCount } = currentWork(state);
    return {
        active, bookId, scope, messages, lastPassage, failureCount,
        queued: summary(queued, queued && { dueAt: queued.dueAt }),
        pending: summary(pending, pending && { id: pending.attemptId, startedAt: pending.startedAt, expiresAt: pending.expiresAt }),
        failed: summary(failed, failed && { error: failed.error })
    };
}

function snapshotPassage(input) {
    return {
        ...normalizePassage(input),
        bookId: key(input?.bookId, '这本书'),
        chapterIndex: Number.isSafeInteger(input?.chapterIndex) && input.chapterIndex >= 0 ? input.chapterIndex : null,
        readChapterIndices: [...new Set((Array.isArray(input?.readChapterIndices) ? input.readChapterIndices : [])
            .filter(index => Number.isSafeInteger(index) && index >= 0))]
    };
}

function batchFailure(batch, error) {
    const { attemptId, startedAt, expiresAt, ...rest } = batch;
    return { ...rest, status: 'failed', error };
}

function checkSignal(signal) {
    if (signal.aborted) throw new DOMException('已停止等待共读回应。', 'AbortError');
}

function recoverExpired(state) {
    const now = Date.now();
    const expired = state.batches.some(batch => batch.status === 'pending' && batch.expiresAt <= now);
    if (!expired) return state;
    return {
        ...state,
        batches: state.batches.map(batch => batch.status === 'pending' && batch.expiresAt <= now
            ? batchFailure(batch, '上次等待已中断，可以重试这组留言。') : batch)
    };
}

function promptContext(state, batch) {
    const anchors = new Map(batch.items.map(item => [item.id, item.passage]));
    const transcript = state.messages.map(item => {
        const passage = anchors.get(item.id);
        return passage ? { ...item, pending: true, passage } : item;
    });
    const items = transcript.filter(item => item.pending);
    const history = transcript.filter(item => !item.pending);
    return { items, history, transcript };
}

export function createCompanion({ scope, userName, friendName, getRoleContext, getReadingContext, request }) {
    const scopeId = key(scope, '当前情侣空间');
    const runtimes = new Map();
    const unsavedReplies = new Map();
    const channel = typeof BroadcastChannel === 'function' ? new BroadcastChannel('LegoCompanionReadingUpdates') : null;
    let disposed = false;

    function runtime(bookId) {
        if (!runtimes.has(bookId)) runtimes.set(bookId, { subscribers: new Set(), timer: null, job: null });
        return runtimes.get(bookId);
    }

    function notifyError(bookId, error) {
        for (const observer of runtimes.get(bookId)?.subscribers ?? []) {
            try { observer.error?.(error); } catch (callbackError) { console.error(callbackError); }
        }
    }

    function publish(state) {
        const result = view(state);
        if (disposed) return result;
        const unsaved = unsavedReplies.get(state.bookId);
        if (unsaved) {
            const outstanding = new Set(state.batches.map(batch => batch.id));
            for (const id of unsaved.keys()) if (!outstanding.has(id)) unsaved.delete(id);
            if (!unsaved.size) unsavedReplies.delete(state.bookId);
        }
        const slot = runtime(state.bookId);
        clearTimeout(slot.timer);
        slot.timer = null;
        const wakeAt = result.pending?.expiresAt ?? result.queued?.dueAt;
        if (wakeAt !== undefined && !slot.job) {
            slot.timer = setTimeout(() => { void pump(state.bookId); }, Math.max(0, wakeAt - Date.now()));
        }
        for (const observer of slot.subscribers) {
            try { observer.state(result); } catch (error) { console.error(error); }
        }
        if (!slot.subscribers.size && !slot.timer && !slot.job) runtimes.delete(state.bookId);
        return result;
    }

    async function change(bookId, apply) {
        const next = await changeCompanionState(scopeId, bookId, raw => apply(normalizeState(raw, scopeId, bookId)));
        if (next) {
            publish(next);
            if (!disposed) channel?.postMessage([scopeId, bookId]);
        }
        return next;
    }

    async function sync(bookId) {
        const state = normalizeState(await readCompanionState(scopeId, bookId), scopeId, bookId);
        if (recoverExpired(state) !== state) {
            const recovered = await change(bookId, current => {
                const next = recoverExpired(current);
                if (next !== current) return next;
            });
            if (recovered) return view(recovered);
            return publish(normalizeState(await readCompanionState(scopeId, bookId), scopeId, bookId));
        }
        return publish(state);
    }

    async function runRequest(bookId, claimed, job) {
        const batch = currentWork(claimed).pending;
        const controller = job.controller;
        const signal = controller.signal;
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; controller.abort(); }, REQUEST_LIMIT_MS);
        let replies = unsavedReplies.get(bookId)?.get(batch.id);
        try {
            if (!replies) {
                if (typeof request !== 'function') throw new Error('请先在 Lego 的 API 设置中配置接口和模型。');
                const { items, history, transcript } = promptContext(claimed, batch);
                const message = items.map(item => item.text).join('\n');
                const roleContext = await getRoleContext?.({ message, signal });
                checkSignal(signal);
                const readingContext = await getReadingContext?.(batch.passage, signal);
                checkSignal(signal);
                const prompt = buildCompanionPrompt({
                    userName: roleContext?.userName || userName, friendName: roleContext?.friendName || friendName,
                    kind: 'comment', roleContext, readingContext, passage: batch.passage, message, batch: items, history, transcript
                });
                replies = readCompanionReply(await request(prompt, signal, roleContext), roleContext?.outputLanguage, {
                    names: [roleContext?.userName || userName, roleContext?.friendName || friendName]
                });
            }
            checkSignal(signal);

            await change(bookId, state => {
                if (!state.batches.some(item => item.attemptId === job.id && item.expiresAt > Date.now())) return;
                checkSignal(signal);
                const { chapter, locator } = batch.passage;
                const createdAt = Date.now();
                const messages = replies.map((reply, index) => ({
                    id: `${batch.id}-char-${index}`, role: 'char', kind: 'comment', text: reply,
                    chapter, locator, createdAt
                }));
                return {
                    ...state, batches: state.batches.filter(item => item.attemptId !== job.id),
                    lastPassage: { chapter, locator }, messages: [...state.messages, ...messages]
                };
            });
        } catch (error) {
            if (replies && !signal.aborted) {
                const unsaved = unsavedReplies.get(bookId) ?? new Map();
                unsaved.set(batch.id, replies);
                unsavedReplies.set(bookId, unsaved);
            }
            let message = error?.message || '共读回应失败，请稍后重试。';
            if (replies) message = '回应已返回，请重试保存共读记录。';
            if (error?.name === 'AbortError') message = '这次回应已中断，可以重试这组留言。';
            if (timedOut) message = '等待共读回应超时，请稍后重试。';
            await change(bookId, state => {
                if (!state.batches.some(batch => batch.attemptId === job.id)) return;
                return {
                    ...state,
                    batches: state.batches.map(batch => batch.attemptId === job.id ? batchFailure(batch, message) : batch)
                };
            });
        } finally {
            clearTimeout(timer);
        }
    }

    async function pump(bookId) {
        if (disposed) return;
        const slot = runtime(bookId);
        if (slot.job) return;
        const job = { id: makeId(), controller: new AbortController() };
        slot.job = job;
        try {
            const claimed = await change(bookId, raw => {
                const state = recoverExpired(raw);
                const { pending, queued } = currentWork(state);
                const startedAt = Date.now();
                if (disposed || pending || !queued || queued.dueAt > startedAt) {
                    if (state !== raw) return state;
                    return;
                }
                const batch = { ...queued, status: 'pending', attemptId: job.id, startedAt, expiresAt: startedAt + REQUEST_LEASE_MS };
                return { ...state, batches: state.batches.map(item => item.id === batch.id ? batch : item) };
            });
            if (claimed && currentWork(claimed).pending?.attemptId === job.id) {
                job.claimed = true;
                await runRequest(bookId, claimed, job);
            }
        } catch (error) {
            notifyError(bookId, error);
        } finally {
            slot.job = null;
            if (!disposed) {
                try { await sync(bookId); } catch (error) { notifyError(bookId, error); }
            }
        }
    }

    if (channel) channel.onmessage = event => {
        const [otherScope, bookId] = Array.isArray(event.data) ? event.data : [];
        if (otherScope !== scopeId || !runtimes.has(bookId)) return;
        void sync(bookId).then(state => {
            const job = runtimes.get(bookId)?.job;
            if (job?.claimed && state.pending?.id !== job.id) job.controller.abort();
        }).catch(error => notifyError(bookId, error));
    };

    return {
        get: bookId => sync(key(bookId, '这本书')),
        watch(bookId, onState, onError) {
            const id = key(bookId, '这本书');
            const slot = runtime(id);
            const observer = { state: onState, error: onError };
            slot.subscribers.add(observer);
            void sync(id).catch(error => notifyError(id, error));
            return () => {
                slot.subscribers.delete(observer);
                if (!slot.subscribers.size && !slot.timer && !slot.job) runtimes.delete(id);
            };
        },
        async send(input, rawText) {
            if (disposed) throw new Error('共读页面已关闭，请重新进入。');
            const passage = snapshotPassage(input);
            const text = String(rawText ?? '').trim();
            if (!text) throw new Error('请先写下想和 TA 说的话。');
            if (text.length > MESSAGE_LIMIT) throw new Error(`一条留言最多 ${MESSAGE_LIMIT} 个字符。`);
            const batchId = makeId();
            const messageId = makeId();

            return view(await change(passage.bookId, raw => {
                const state = recoverExpired(raw);
                const createdAt = Date.now();
                const { title, chapter, locator, excerpt, chapterIndex } = passage;
                const item = { id: messageId, passage: { title, chapter, locator, excerpt, chapterIndex } };
                const message = { id: messageId, role: 'user', kind: 'comment', text, chapter, locator, createdAt };
                const queued = state.batches.find(batch => batch.status === 'queued' && batch.resettable && batch.dueAt > createdAt);
                const updated = {
                    id: queued?.id ?? batchId, status: 'queued', resettable: true,
                    dueAt: createdAt + REPLY_DELAY_MS, items: [...(queued?.items ?? []), item], passage
                };
                const batches = queued ? state.batches.map(batch => batch.id === queued.id ? updated : batch) : [...state.batches, updated];
                return { ...state, active: true, messages: [...state.messages, message], batches };
            }));
        },
        async retry(bookId, batchId) {
            const id = key(bookId, '这本书');
            const next = await change(id, state => {
                const failed = state.batches.find(batch => batch.status === 'failed' && (!batchId || batch.id === batchId));
                if (!failed) return;
                const { error, ...batch } = failed;
                const updated = { ...batch, status: 'queued', resettable: false, dueAt: Date.now() };
                return { ...state, active: true, batches: state.batches.map(item => item.id === updated.id ? updated : item) };
            });
            return next ? view(next) : sync(id);
        },
        async cancel(bookId, workId) {
            const id = key(bookId, '这本书');
            let removedAttempt;
            const next = await change(id, state => {
                const { pending, queued } = currentWork(state);
                const batch = workId ? state.batches.find(item => item.id === workId || item.attemptId === workId) : pending ?? queued;
                if (!batch || batch.status === 'failed') return;
                removedAttempt = batch.attemptId;
                return { ...state, batches: state.batches.filter(item => item.id !== batch.id) };
            });
            const job = runtimes.get(id)?.job;
            if (job && job.id === removedAttempt) job.controller.abort();
            return next ? view(next) : sync(id);
        },
        async leave(bookId) {
            const id = key(bookId, '这本书');
            const state = await change(id, current => ({ ...current, active: false, batches: [] }));
            runtimes.get(id)?.job?.controller.abort();
            return view(state);
        },
        async remove(bookId) {
            const id = key(bookId, '这本书');
            await changeCompanionState(scopeId, id, () => null);
            runtimes.get(id)?.job?.controller.abort();
            publish(normalizeState(null, scopeId, id));
            channel?.postMessage([scopeId, id]);
        },
        async resume() {
            for (const { bookId, active, batches } of await readCompanionScope(scopeId)) {
                if (active && batches?.some(batch => batch.status !== 'failed')) await sync(bookId);
            }
        },
        dispose() {
            if (disposed) return;
            disposed = true;
            channel?.close();
            unsavedReplies.clear();
            for (const slot of runtimes.values()) {
                clearTimeout(slot.timer);
                slot.job?.controller.abort();
                slot.subscribers.clear();
            }
            runtimes.clear();
        }
    };
}
