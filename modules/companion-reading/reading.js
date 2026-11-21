import { createShelfStore } from './shelf-store.js?v=2';
import { sample } from './sample-book.js';
import { createReader } from './reader-view.js?v=3';
import { MESSAGE_LIMIT } from './companion-prompt.js?v=3';
import { bindCoverHold } from './cover-hold.js';

const $ = id => document.getElementById(id);
const drawer = $('drawer');
const viewport = $('reading-viewport');
const panels = Object.fromEntries(['settings', 'contents', 'companion', 'book', 'delete'].map(name => [name, $(`panel-${name}`)]));
const panelTitles = { settings: '阅读设置', contents: '目录与书签', companion: '共读留言', book: '编辑书籍', delete: '删除书籍' };
const formats = { txt: 'TXT', doc: 'Word', docx: 'Word', pdf: 'PDF', epub: 'EPUB' };
const THEMES = ['mist', 'peach', 'lilac', 'cream'];
const defaults = { theme: 'mist', mode: 'horizontal', size: 20 };
let host, context, store, companion, books = [], book, editedBook, position, atEnd, settings = defaults;
let panel, previousFocus, listMode = 'chapters', filter = 'all', loadingBook = false, importing = false, closing = false;
let deleteFromEditor = false, deleting = false;
let coverUrls = [], toastTimer, progressTimer, pendingWrite, lastWrite, prefsWrite;
let coState, coError = '', coSending = false, stopCompanionWatch, countdownTimer;
let renderedMessages = [];
const drafts = new Map();

function node(tag, className, text) {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text) item.textContent = text;
    return item;
}

function icon(name) {
    const symbol = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    const use = document.createElementNS('http://www.w3.org/2000/svg', 'use');
    symbol.setAttribute('aria-hidden', 'true');
    use.setAttribute('href', `#i-${name}`);
    symbol.append(use);
    return symbol;
}

function button(label, className, action) {
    const item = node('button', className, label);
    item.type = 'button';
    item.addEventListener('click', action);
    return item;
}

function notify(message) {
    const target = drawer.open ? $('drawer-status') : $('toast');
    const other = target === $('toast') ? $('drawer-status') : $('toast');
    other.hidden = true;
    target.textContent = message;
    target.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { target.hidden = true; }, 4300);
}

function errorMessage(error, fallback) {
    if (error?.name === 'QuotaExceededError') return '浏览器可用空间不足，请移除不再阅读的书籍后重试。';
    return error?.message || fallback;
}

function recordList(records) {
    const entries = records.some(record => record.id === sample.id) ? records : [...records, sample];
    return entries.filter(record => !record.hidden)
        .sort((a, b) => (b.touchedAt || b.addedAt || 0) - (a.touchedAt || a.addedAt || 0));
}

async function reloadShelf() {
    books = recordList(await store.list());
    renderShelf();
}

function displayProgress(record) {
    if (record.progress?.finished) return 100;
    const place = record.progress;
    if (!place?.started) return 0;
    return Math.min(99, Math.round(((place.chapter || 0) + (place.offset || 0)) / record.chapterCount * 100));
}

function renderShelf() {
    const grid = $('book-grid');
    const query = $('shelf-search').value.trim().toLocaleLowerCase();
    const visible = books.filter(item => {
        if (filter === 'finished' && !item.progress?.finished) return false;
        if (filter === 'reading' && (!item.progress?.started || item.progress?.finished)) return false;
        return !query || `${item.title} ${item.author}`.toLocaleLowerCase().includes(query);
    });
    coverUrls.forEach(url => URL.revokeObjectURL(url));
    coverUrls = [];
    grid.replaceChildren();
    for (const record of visible) {
        const wrapper = node('article', 'book-item');
        const open = button('', 'book-open', () => void openBook(record.id));
        open.setAttribute('aria-label', `阅读《${record.title}》`);
        open.dataset.bookId = record.id;
        const hasCover = record.cover instanceof Blob;
        const cover = node('span', `book-cover${hasCover ? ' from-file' : ''}`);
        const art = document.createElement('img');
        if (hasCover) {
            const url = URL.createObjectURL(record.cover);
            coverUrls.push(url);
            art.src = url;
            art.addEventListener('error', () => {
                cover.classList.remove('from-file');
                art.remove();
                cover.append(node('span', 'cover-title', record.title));
            }, { once: true });
        } else {
            art.src = record.builtin ? 'art/shelf.jpg' : 'art/chapter.jpg';
            cover.style.setProperty('--binding', ['#415665', '#5c5371', '#6d514a'][record.title.length % 3]);
            cover.append(node('span', 'cover-title', record.title));
        }
        art.alt = '';
        art.loading = 'lazy';
        art.draggable = false;
        cover.title = '长按删除书籍';
        cover.prepend(art);
        open.append(cover, node('span', 'book-name', record.title));
        const format = formats[record.format] || record.format;
        const subtitle = record.progress?.started ? `${format} · ${displayProgress(record)}%` : (record.author || format);
        const manage = button('', 'icon book-more', () => record.builtin ? confirmBookDeletion(record, manage) : showBookOptions(record));
        manage.setAttribute('aria-label', `${record.builtin ? '删除' : '管理'}《${record.title}》`);
        manage.append(icon('more'));
        wrapper.append(open, manage, node('span', 'book-meta', subtitle));
        grid.append(wrapper);
    }
    if (filter === 'all' && !query) {
        const add = button('', 'add-book', chooseFiles);
        add.disabled = importing;
        const sign = node('span', 'add-cover');
        sign.append(icon('plus'), node('span', '', '添加书籍'));
        add.append(sign, node('small', 'add-caption', 'TXT · Word · PDF · EPUB'));
        grid.append(add);
    }
    $('book-count').textContent = `${visible.length} 本`;
    $('shelf-message').textContent = visible.length ? '' : query ? '没有找到符合条件的书。' : '这里还没有书。';
}

const reader = createReader({ onPosition: updatePosition, onNotice: notify });

function sampleRecord() {
    const { chapters, ...metadata } = sample;
    return metadata;
}

function writeProgress() {
    clearTimeout(progressTimer);
    if (!pendingWrite) return lastWrite;
    const { id, progress } = pendingWrite;
    pendingWrite = null;
    lastWrite = store.update(id, record => ({
        progress: { ...progress, readChapters: [...new Set([...(record.progress?.readChapters || []), ...progress.readChapters])] },
        touchedAt: Date.now()
    }), id === sample.id ? sampleRecord() : undefined)
        .catch(error => notify(errorMessage(error, '阅读进度保存失败。')));
    return lastWrite;
}

function updatePosition(layout, end) {
    if (!book || closing) return;
    position = layout;
    atEnd = end;
    const previous = book.progress;
    let readChapters = previous?.readChapters ?? (previous?.finished ? book.chapters.map((_, index) => index) : []);
    if (end && !readChapters.includes(layout.chapter)) readChapters = [...readChapters, layout.chapter];
    const progress = { chapter: position.chapter, offset: position.offset, started: true, finished: !!previous?.finished, readChapters };
    if (!previous || previous.chapter !== progress.chapter || Math.abs(previous.offset - progress.offset) > .0005 || previous.readChapters !== readChapters) {
        book.progress = progress;
        pendingWrite = { id: book.id, progress };
        clearTimeout(progressTimer);
        progressTimer = setTimeout(writeProgress, 120);
    }
    const percent = displayProgress(book);
    $('read-progress').value = percent;
    $('percent-label').textContent = `${percent}%`;
    $('position-label').textContent = `第 ${layout.page} / ${layout.total} 页`;
    $('prev-page').disabled = !position.chapter && layout.page === 1 && position.offset < .002;
    const lastChapter = position.chapter === book.chapters.length - 1;
    const nextLabel = lastChapter && end ? '读完' : '下页';
    $('next-page').disabled = lastChapter && end && progress.finished;
    $('next-page').querySelector('span').textContent = nextLabel;
    $('next-page').setAttribute('aria-label', nextLabel === '读完' ? '标记为已读完' : '下一页');
    syncBookmark();
}

async function openBook(id) {
    if (loadingBook || closing) return;
    loadingBook = true;
    try {
        const record = await store.record(id) ?? (id === sample.id ? sampleRecord() : undefined);
        const content = id === sample.id ? { chapters: sample.chapters } : await store.content(id);
        if (closing) return;
        if (!record || record.hidden || !content?.chapters?.length) throw new Error('这本书暂时无法打开，请再试一次。');
        book = { ...record, ...content };
        position = null;
        listMode = 'chapters';
        coState = null;
        coError = '';
        $('companion-input').value = drafts.get(id) || '';
        resetCompanionLog();
        $('shelf').hidden = true;
        $('reader').hidden = false;
        reader.show(book, book.progress, settings);
        viewport.focus({ preventScroll: true });
    } catch (error) { notify(errorMessage(error, '无法打开这本书。')); }
    finally { loadingBook = false; }
}

async function backToShelf() {
    if (!book) return;
    stopWatchingCompanion();
    if (position) updatePosition(reader.location(), reader.atEnd());
    await writeProgress();
    reader.clear();
    book = null;
    $('reader').hidden = true;
    $('shelf').hidden = false;
    $('close-module').focus({ preventScroll: true });
    try { await reloadShelf(); } catch (_) { notify('无法刷新书架。'); }
}

function changeChapter(chapter, offset = 0) {
    if (!book || chapter < 0 || chapter >= book.chapters.length) return;
    position = { chapter, offset };
    reader.show(book, position, settings);
}

function move(direction) {
    if (!book || !position || reader.scrollPage(direction)) return;
    const target = position.chapter + direction;
    if (target >= 0 && target < book.chapters.length) {
        changeChapter(target, direction < 0 ? 1 : 0);
    } else if (direction > 0 && atEnd && !book.progress?.finished) {
        book.progress = { ...book.progress, finished: true };
        pendingWrite = { id: book.id, progress: book.progress };
        void writeProgress();
        updatePosition(reader.location(), true);
        notify('已标记为读完');
    }
}

function pressOptions(attribute, value) {
    document.querySelectorAll(`[data-${attribute}]`).forEach(item => {
        item.setAttribute('aria-pressed', String(item.getAttribute(`data-${attribute}`) === value));
    });
}

function refreshSettings() {
    document.body.dataset.theme = settings.theme;
    pressOptions('theme-choice', settings.theme);
    pressOptions('mode', settings.mode);
    $('mode-hint').textContent = settings.mode === 'horizontal' ? '点击正文左侧或右侧翻页。' : '上下滑动正文，或点击正文上侧、下侧滑页。';
    $('font-size').textContent = `${settings.size} px`;
    $('size-down').disabled = settings.size <= 14;
    $('size-up').disabled = settings.size >= 32;
}

function setSettings(change) {
    settings = { ...settings, ...change };
    refreshSettings();
    reader.configure(settings);
    prefsWrite = store.saveSettings(settings).catch(error => notify(errorMessage(error, '设置保存失败。')));
}

function openPanel(name, trigger = document.activeElement) {
    if (!store || (name === 'companion' || name === 'contents') && !position) return;
    panel = name;
    drawer.dataset.panel = name;
    $('drawer-status').hidden = true;
    $('drawer-title').textContent = panelTitles[name];
    for (const [key, item] of Object.entries(panels)) item.hidden = key !== name;
    if (name === 'contents') renderContents();
    if (!drawer.open) {
        previousFocus = trigger;
        drawer.showModal();
    }
    $('close-drawer').focus();
    if (name === 'companion') watchCompanion();
}

drawer.addEventListener('close', () => {
    if (drawer.open) return;
    stopWatchingCompanion();
    panel = null;
    if (previousFocus?.isConnected && previousFocus.getClientRects().length) previousFocus.focus({ preventScroll: true });
});
drawer.addEventListener('click', event => { if (event.target === drawer && !deleting) drawer.close(); });
drawer.addEventListener('cancel', event => { if (deleting) event.preventDefault(); });

function currentBookmark() {
    if (!book || !position) return undefined;
    return book.bookmarks?.find(mark => mark.chapter === position.chapter && Math.abs(mark.offset - position.offset) <= .005);
}

function syncBookmark() {
    const active = !!currentBookmark();
    $('toggle-bookmark').setAttribute('aria-pressed', String(active));
    $('toggle-bookmark').setAttribute('aria-label', active ? '移除此处书签' : '添加书签');
}

async function writeBookmarks(transform) {
    const currentBook = book;
    if (!currentBook) return;
    try {
        const saved = await store.update(currentBook.id, record => ({ bookmarks: transform(record.bookmarks || []) }),
            currentBook.builtin ? sampleRecord() : undefined);
        if (!saved) return;
        currentBook.bookmarks = saved.bookmarks;
        if (book === currentBook) {
            syncBookmark();
            if (panel === 'contents') renderContents();
        }
    } catch (error) { notify(errorMessage(error, '书签保存失败。')); }
}

function toggleBookmark() {
    if (!book || !position) return;
    const current = currentBookmark();
    const { chapter, offset, page } = position;
    void writeBookmarks(marks => current ? marks.filter(mark => mark.id !== current.id) : [...marks, { id: makeId(), chapter, offset, page }]);
}

function renderContents() {
    pressOptions('list', listMode);
    const list = $('contents-list');
    list.replaceChildren();
    if (listMode === 'chapters') {
        book.chapters.forEach((chapter, index) => {
            const row = node('li');
            const jump = button(chapter.title, '', () => { drawer.close(); changeChapter(index); });
            if (index === position.chapter) jump.setAttribute('aria-current', 'location');
            row.append(jump);
            list.append(row);
        });
        return;
    }
    for (const mark of book.bookmarks || []) {
        const row = node('li', 'bookmark-row');
        const title = book.chapters[mark.chapter]?.title || '正文';
        const jump = button(`${title} · 第 ${mark.page} 页`, '', () => { drawer.close(); changeChapter(mark.chapter, mark.offset); });
        const remove = button('移除', 'remove-mark', () => void writeBookmarks(marks => marks.filter(item => item.id !== mark.id)));
        remove.setAttribute('aria-label', `移除${title}的书签`);
        row.append(jump, remove);
        list.append(row);
    }
    if (!list.children.length) list.append(node('li', 'inline-note', '还没有书签。可在阅读页顶部添加。'));
}

function makeId() {
    return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}

async function bookId(file) {
    if (!crypto.subtle) return makeId();
    const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function chooseFiles() {
    if (store && !importing) $('file-picker').click();
}

function importStatus(message) {
    $('settings-import-status').textContent = message;
    if (!drawer.open) $('shelf-message').textContent = message;
}

async function importFiles(files) {
    if (!files.length || importing || !store) return;
    importing = true;
    $('settings-upload').disabled = true;
    renderShelf();
    let imported = 0;
    const results = [];
    try {
        const { importBook } = await import('./book-import.js');
        for (const file of files) {
            if (closing) break;
            importStatus(`正在读取《${file.name}》…`);
            try {
                const id = file.size <= 64 * 1024 * 1024 ? await bookId(file) : makeId();
                if (await store.record(id)) {
                    results.push(`${file.name} 已在书架中`);
                    continue;
                }
                const { chapters, pdfSource, cover, warnings, title, author, format } = await importBook(file, {
                    onProgress: ({ message }) => importStatus(message || `正在分析《${file.name}》…`)
                });
                if (closing) break;
                await store.add({ id, title, author, format, cover, warnings, chapterCount: chapters.length }, { chapters, pdfSource });
                imported++;
                for (const warning of warnings || []) results.push(`${title} · ${warning}`);
            } catch (error) {
                results.push(`${file.name} · ${error?.name === 'ConstraintError' ? '已在书架中' : errorMessage(error, '无法导入。')}`);
            }
        }
    } catch (error) { results.push(errorMessage(error, '文件解析器暂时无法加载。')); }
    finally {
        importing = false;
        $('settings-upload').disabled = false;
    }
    if (closing) return;
    try { await reloadShelf(); } catch (_) { results.push('书架暂时无法刷新。'); }
    const summary = [`已导入 ${imported} 本`, ...results].join('。');
    importStatus(summary);
    if (!drawer.open) notify(summary.length < 100 ? summary : `${summary.slice(0, 95)}…`);
}

function showBookOptions(record) {
    editedBook = record;
    $('edit-book-title').value = record.title;
    $('edit-book-author').value = record.author || '';
    $('book-warnings').textContent = (record.warnings || []).join(' ');
    openPanel('book');
}

function confirmBookDeletion(record, trigger) {
    if (!record || deleting) return;
    deleteFromEditor = drawer.open && panel === 'book';
    editedBook = record;
    $('delete-title').textContent = `删除《${record.title}》？`;
    openPanel('delete', trigger);
    $('cancel-delete').focus();
}

function cancelBookDeletion() {
    if (!deleteFromEditor) {
        drawer.close();
        return;
    }
    openPanel('book');
    $('delete-book').focus();
}

async function saveBook(event) {
    event.preventDefault();
    const title = $('edit-book-title').value.trim();
    if (!title || !editedBook) return;
    try {
        await store.update(editedBook.id, { title, author: $('edit-book-author').value.trim() });
        await reloadShelf();
        drawer.close();
        notify('书籍信息已保存');
    } catch (error) { notify(errorMessage(error, '书籍信息保存失败。')); }
}

async function deleteBook() {
    if (!editedBook || deleting) return;
    const { id, builtin } = editedBook;
    deleting = true;
    const controls = [$('confirm-delete'), $('cancel-delete'), $('close-drawer')];
    controls.forEach(control => { control.disabled = true; });
    try {
        await companion.remove(id);
        await store.remove(id, { hide: !!builtin });
        drafts.delete(id);
        await reloadShelf();
        drawer.close();
        $('search-toggle').focus({ preventScroll: true });
        notify('书籍已删除');
    } catch (error) { notify(errorMessage(error, '无法移除书籍。')); }
    finally {
        deleting = false;
        controls.forEach(control => { control.disabled = false; });
    }
}

function setText(id, text) {
    const target = $(id);
    if (target.textContent !== text) target.textContent = text;
}

function resetCompanionLog() {
    $('companion-messages').querySelectorAll('.message').forEach(message => message.remove());
    renderedMessages = [];
}

function renderCompanionLog(messages) {
    const log = $('companion-messages');
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 36;
    if (renderedMessages.some((id, index) => id !== messages[index]?.id)) resetCompanionLog();
    const incoming = messages.slice(renderedMessages.length);
    for (const message of incoming) {
        const entry = node('div', 'message');
        entry.dataset.role = message.role;
        const name = message.role === 'user' ? context.userName : context.friendName;
        entry.append(node('small', '', message.locator ? `${name} · ${message.locator}` : name), node('p', '', message.text));
        log.append(entry);
        renderedMessages.push(message.id);
    }
    $('companion-empty').hidden = messages.length > 0;
    if (incoming.length && (nearBottom || incoming.some(message => message.role === 'user'))) log.scrollTop = log.scrollHeight;
}

function renderCompanionStatus() {
    if (panel !== 'companion') return;
    const { queued, pending, failed } = coState || {};
    const seconds = queued ? Math.max(0, Math.ceil((queued.dueAt - Date.now()) / 1000)) : 0;
    const state = pending ? 'Char 正在回复…' : queued ? (seconds ? '等待继续发送' : '即将请求回复…') : failed ? '这组留言等待重试' : '';
    $('companion-state-row').hidden = !state;
    setText('partner-state', state);
    $('companion-countdown').hidden = !queued || !seconds;
    setText('companion-countdown', seconds ? `${seconds} 秒` : '');
    $('retry-companion').hidden = !failed || !!pending || !!queued;
    $('cancel-companion').hidden = !pending && !queued;
    $('cancel-companion').textContent = pending && queued ? '停止本次回复' : '停止等待';
    setText('companion-error', coError || failed?.error || '');
}

function updateComposer() {
    $('send-companion').disabled = !coState || coSending || !$('companion-input').value.trim();
}

function stopWatchingCompanion() {
    stopCompanionWatch?.();
    stopCompanionWatch = undefined;
    clearInterval(countdownTimer);
}

function watchCompanion() {
    stopWatchingCompanion();
    const currentBook = book;
    if (!currentBook) return;
    const passage = reader.passage();
    setText('companion-place', passage.locator);
    $('companion-scan-note').hidden = !currentBook.chapters[passage.chapterIndex].pdfPages?.length;
    coError = '';
    updateComposer();
    renderCompanionStatus();
    countdownTimer = setInterval(renderCompanionStatus, 200);
    stopCompanionWatch = companion.watch(currentBook.id, state => {
        if (book !== currentBook || panel !== 'companion' || !drawer.open) return;
        coState = state;
        renderCompanionLog(state.messages);
        renderCompanionStatus();
        updateComposer();
    }, error => {
        if (book !== currentBook || panel !== 'companion' || !drawer.open) return;
        coError = errorMessage(error, '共读记录载入失败。');
        renderCompanionStatus();
    });
}

async function sendCompanionMessage() {
    if (!book || !position || coSending || !coState) return;
    const input = $('companion-input');
    const original = input.value;
    const message = original.trim();
    if (!message) return;
    const currentBook = book;
    updatePosition(reader.location(), reader.atEnd());
    const passage = { ...reader.passage(), readChapterIndices: currentBook.progress?.readChapters || [] };
    coSending = true;
    coError = '';
    updateComposer();
    renderCompanionStatus();
    try {
        await companion.send(passage, message);
        if (drafts.get(currentBook.id) === original) drafts.delete(currentBook.id);
        if (book === currentBook && input.value === original) input.value = '';
    } catch (error) {
        if (book === currentBook) coError = errorMessage(error, '留言保存失败，请重试。');
    } finally {
        coSending = false;
        updateComposer();
        renderCompanionStatus();
    }
}

async function changeCompanionRequest(action) {
    if (!book) return;
    const batch = action === 'retry' ? coState?.failed : coState?.pending || coState?.queued;
    if (!batch) return;
    try {
        coError = '';
        await companion[action](book.id, batch.id);
    } catch (error) { coError = errorMessage(error, '操作失败，请重试。'); }
    renderCompanionStatus();
}

function avatar(name, image) {
    const label = node('span', '', Array.from(name)[0] || '·');
    label.setAttribute('aria-hidden', 'true');
    if (image && /^(?:https?:|blob:|data:image\/|\/[^/]|assets\/)/i.test(image)) {
        const pic = document.createElement('img');
        pic.alt = '';
        pic.referrerPolicy = 'no-referrer';
        pic.src = image.startsWith('assets/') ? `../../${image}` : image;
        pic.addEventListener('error', () => { label.textContent = Array.from(name)[0] || '·'; }, { once: true });
        label.replaceChildren(pic);
    }
    return label;
}

const shutdown = async () => {
    if (!closing && book && position) updatePosition(reader.location(), reader.atEnd());
    closing = true;
    stopWatchingCompanion();
    await Promise.allSettled([writeProgress(), prefsWrite]);
};
window.LegoCompanionReadingPage = { prepareClose: shutdown };

function attachControls() {
    bindCoverHold($('book-grid'), trigger => {
        const record = books.find(entry => entry.id === trigger.dataset.bookId);
        confirmBookDeletion(record, trigger);
    });
    document.querySelectorAll('[data-open]').forEach(item => item.addEventListener('click', () => openPanel(item.dataset.open)));
    document.querySelectorAll('[data-filter]').forEach(item => item.addEventListener('click', () => {
        filter = item.dataset.filter;
        pressOptions('filter', filter);
        renderShelf();
    }));
    document.querySelectorAll('[data-theme-choice], [data-mode]').forEach(item => item.addEventListener('click', () => {
        const { themeChoice, mode } = item.dataset;
        setSettings(themeChoice ? { theme: themeChoice } : { mode });
    }));
    document.querySelectorAll('[data-list]').forEach(item => item.addEventListener('click', () => {
        listMode = item.dataset.list;
        renderContents();
    }));
    $('search-toggle').onclick = () => {
        const area = $('search-area');
        area.hidden = !area.hidden;
        $('search-toggle').setAttribute('aria-expanded', String(!area.hidden));
        if (!area.hidden) $('shelf-search').focus();
        else {
            $('shelf-search').value = '';
            renderShelf();
        }
    };
    $('shelf-search').addEventListener('input', renderShelf);
    $('size-down').onclick = () => setSettings({ size: Math.max(14, settings.size - 2) });
    $('size-up').onclick = () => setSettings({ size: Math.min(32, settings.size + 2) });
    $('close-drawer').onclick = () => drawer.close();
    $('back-to-shelf').onclick = () => void backToShelf();
    $('prev-page').onclick = () => move(-1);
    $('next-page').onclick = () => move(1);
    $('toggle-bookmark').onclick = toggleBookmark;
    $('settings-upload').onclick = chooseFiles;
    $('file-picker').onchange = event => {
        const files = Array.from(event.target.files);
        event.target.value = '';
        void importFiles(files);
    };
    $('book-form').onsubmit = saveBook;
    $('delete-book').onclick = () => confirmBookDeletion(editedBook);
    $('cancel-delete').onclick = cancelBookDeletion;
    $('confirm-delete').onclick = () => void deleteBook();
    $('companion-input').maxLength = MESSAGE_LIMIT;
    $('companion-input').oninput = event => {
        if (book) drafts.set(book.id, event.target.value);
        updateComposer();
    };
    $('companion-form').onsubmit = event => { event.preventDefault(); void sendCompanionMessage(); };
    $('retry-companion').onclick = () => void changeCompanionRequest('retry');
    $('cancel-companion').onclick = () => void changeCompanionRequest('cancel');
    viewport.addEventListener('click', event => {
        if (!event.detail || drawer.open || window.getSelection()?.toString()) return;
        const box = viewport.getBoundingClientRect();
        const fraction = settings.mode === 'horizontal' ? (event.clientX - box.left) / box.width : (event.clientY - box.top) / box.height;
        if (fraction < .24) move(-1);
        if (fraction > .76) move(1);
    });
    let touchStart;
    viewport.addEventListener('touchstart', event => { touchStart = event.touches.length === 1 ? event.touches[0].clientY : undefined; }, { passive: true });
    viewport.addEventListener('touchend', event => {
        const delta = touchStart == null ? 0 : touchStart - event.changedTouches[0].clientY;
        touchStart = undefined;
        if (settings.mode !== 'vertical' || !book || !position || Math.abs(delta) < 54) return;
        if (delta > 0 && reader.atEnd() && position.chapter < book.chapters.length - 1) move(1);
        if (delta < 0 && viewport.scrollTop < 2 && position.chapter > 0) move(-1);
    }, { passive: true });
    document.addEventListener('keydown', event => {
        if (drawer.open || event.defaultPrevented || /^(INPUT|TEXTAREA)$/.test(event.target.tagName)) return;
        if (event.key === 'Escape') {
            event.preventDefault();
            if (book) void backToShelf();
            else host?.close(window);
        }
        const keys = settings.mode === 'horizontal' ? ['ArrowLeft', 'ArrowRight'] : ['ArrowUp', 'ArrowDown'];
        if (book && [...keys, 'PageUp', 'PageDown'].includes(event.key)) {
            event.preventDefault();
            move(event.key === keys[0] || event.key === 'PageUp' ? -1 : 1);
        }
    });
    window.addEventListener('pagehide', () => { void shutdown(); }, { once: true });
    document.addEventListener('visibilitychange', () => { if (document.hidden) void writeProgress(); });
}

async function initialize() {
    $('close-module').onclick = () => host?.close(window);
    try {
        host = window.parent.LegoCompanionReadingHost;
        if (!host) throw new Error('请从微信「发现 → 情侣空间 → 相伴阅读」打开。');
        context = host.context(window);
        store = createShelfStore(context.scope);
        companion = await host.companion(window);
        $('partner-names').textContent = `${context.userName} 与 ${context.friendName}`;
        $('partner-avatars').append(avatar(context.userName, context.userAvatar), avatar(context.friendName, context.friendAvatar));
        const saved = await store.settings();
        settings = { theme: THEMES.includes(saved?.theme) ? saved.theme : defaults.theme,
            mode: saved?.mode === 'vertical' ? 'vertical' : defaults.mode,
            size: Math.min(32, Math.max(14, Number(saved?.size) || defaults.size)) };
        refreshSettings();
        attachControls();
        await reloadShelf();
    } catch (error) {
        $('startup-error').textContent = errorMessage(error, '相伴阅读初始化失败，请重新打开。');
        $('startup-error').hidden = false;
    }
}

void initialize();
