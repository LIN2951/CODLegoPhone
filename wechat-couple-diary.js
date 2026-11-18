/**
 * 情侣空间 · 情侣日记（方案 B：多篇日记翻页；保存后 API 生成 Char 读后回应）
 * 数据：pair.diaryEntries[]、pair.diaryCoverDataUrl；兼容旧 pair.diaryLines 迁移
 */
(function (global) {
    'use strict';

    var DIARY_LINE_COUNT = 14;

    function store() {
        return global.Wechat && global.Wechat.store && global.Wechat.store.coupleSpace ? global.Wechat.store.coupleSpace : null;
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function escAttrUrl(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')
            .replace(/</g, '')
            .replace(/>/g, '')
            .replace(/`/g, '');
    }

    var draftLines = [];
    var currentFriendId = '';
    /** @type {Array<{id:string,savedAt:number,lines:string[],charReply?:string,charReplyAt?:number}>} */
    var workingEntries = [];
    var currentEntryIndex = 0;
    var editingLineIndex = -1;
    /** 当前篇上次成功写入 pair 的正文快照，用于判断是否有未保存修改 */
    var lastSavedLinesSig = '';

    function linesSnapshot(lines) {
        try {
            return JSON.stringify(normalizeLines(lines));
        } catch (e) {
            return '';
        }
    }

    function updateSaveButtonAppearance() {
        var btn = document.getElementById('couple-diary-save-btn');
        if (!btn) return;
        var body = linesToDiaryBody(draftLines);
        var dirty = linesSnapshot(draftLines) !== lastSavedLinesSig;
        if (body && !dirty) btn.classList.add('is-saved-clean');
        else btn.classList.remove('is-saved-clean');
    }

    function newEntryId() {
        return 'de_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8);
    }

    function normalizeLines(raw) {
        var arr = [];
        if (Array.isArray(raw)) {
            arr = raw.map(function (x) { return String(x == null ? '' : x); });
        } else if (raw && typeof raw === 'string') {
            try {
                var p = JSON.parse(raw);
                if (Array.isArray(p)) arr = p.map(function (x) { return String(x == null ? '' : x); });
            } catch (e) {
                arr = [];
            }
        }
        while (arr.length < DIARY_LINE_COUNT) arr.push('');
        if (arr.length > DIARY_LINE_COUNT) arr = arr.slice(0, DIARY_LINE_COUNT);
        return arr;
    }

    function linesToDiaryBody(lines) {
        return lines
            .map(function (l) { return String(l || '').trim(); })
            .filter(Boolean)
            .join('\n')
            .trim();
    }

    function migrateLegacyEntries(pair) {
        if (!pair || typeof pair !== 'object') return [];
        if (Array.isArray(pair.diaryEntries) && pair.diaryEntries.length) {
            return pair.diaryEntries.map(function (e) {
                if (!e || typeof e !== 'object') return null;
                return {
                    id: String(e.id || newEntryId()),
                    savedAt: Number(e.savedAt) || Date.now(),
                    lines: normalizeLines(e.lines),
                    charReply: e.charReply != null ? String(e.charReply) : '',
                    charReplyAt: e.charReplyAt != null ? Number(e.charReplyAt) : undefined
                };
            }).filter(Boolean);
        }
        if (pair.diaryLines && (Array.isArray(pair.diaryLines) || typeof pair.diaryLines === 'string')) {
            var L = normalizeLines(pair.diaryLines);
            if (linesToDiaryBody(L)) {
                return [{
                    id: newEntryId(),
                    savedAt: Number(pair.diarySavedAt) || Date.now(),
                    lines: L,
                    charReply: '',
                    charReplyAt: undefined
                }];
            }
        }
        return [];
    }

    function persistWorkingEntries() {
        var st = store();
        if (!st || typeof st.upsertPair !== 'function' || !currentFriendId) return;
        try {
            st.upsertPair(currentFriendId, { diaryEntries: JSON.parse(JSON.stringify(workingEntries)) });
        } catch (e) {}
    }

    function getActiveFriendIdFromPrivateContext() {
        var t = document.getElementById('couple-private-editable-title');
        return t ? String(t.getAttribute('data-friend-id') || '').trim() : '';
    }

    function renderCoverBg() {
        var node = document.getElementById('couple-diary-cover-bg');
        var face = document.getElementById('couple-diary-cover-face');
        if (!node) return;
        var st = store();
        var fidForPair = currentFriendId || getActiveFriendIdFromPrivateContext();
        if (!st || !fidForPair) return;
        var pair = st.getPair ? st.getPair(fidForPair) : null;
        var url = pair && pair.diaryCoverDataUrl ? String(pair.diaryCoverDataUrl) : '';
        if (url) {
            node.style.backgroundImage = 'url(' + JSON.stringify(url) + ')';
            node.classList.add('has-image');
            if (face) face.classList.add('has-cover-image');
        } else {
            node.style.backgroundImage = '';
            node.classList.remove('has-image');
            if (face) face.classList.remove('has-cover-image');
        }
    }

    function renderLineRows() {
        var host = document.getElementById('couple-diary-lined-rows');
        if (!host) return;
        host.innerHTML = '';
        for (var i = 0; i < DIARY_LINE_COUNT; i++) {
            var row = document.createElement('button');
            row.type = 'button';
            row.className = 'couple-diary-line-row';
            row.setAttribute('data-line-index', String(i));
            var text = String(draftLines[i] || '').trim();
            row.textContent = text || '　';
            if (!text) row.classList.add('is-empty');
            row.addEventListener('click', function (ev) {
                ev.preventDefault();
                var idx = parseInt(ev.currentTarget.getAttribute('data-line-index'), 10);
                if (!Number.isFinite(idx)) return;
                openDiaryLineEditor(idx);
            });
            host.appendChild(row);
        }
    }

    function renderCharReply() {
        var el = document.getElementById('couple-diary-char-reply');
        if (!el) return;
        var ent = workingEntries[currentEntryIndex];
        var t = ent && ent.charReply ? String(ent.charReply).trim() : '';
        if (t) {
            el.textContent = t;
            el.classList.remove('is-placeholder');
        } else {
            el.textContent = '保存日记后，TA 的读后感受会显示在这里';
            el.classList.add('is-placeholder');
        }
    }

    function renderDiaryNav() {
        var prev = document.getElementById('couple-diary-prev');
        var next = document.getElementById('couple-diary-next');
        var lab = document.getElementById('couple-diary-nav-label');
        var n = workingEntries.length;
        var idx = currentEntryIndex;
        if (lab) lab.textContent = '第 ' + (n ? (idx + 1) : 0) + ' / ' + n + ' 篇';
        if (prev) prev.disabled = n < 2 || idx <= 0;
        if (next) next.disabled = n < 2 || idx >= n - 1;
    }

    function commitDraftToCurrentEntry() {
        if (!workingEntries.length || currentEntryIndex < 0 || currentEntryIndex >= workingEntries.length) return;
        workingEntries[currentEntryIndex].lines = normalizeLines(draftLines.slice());
    }

    function loadEntryAtIndex(idx) {
        if (idx < 0 || idx >= workingEntries.length) return;
        currentEntryIndex = idx;
        draftLines = normalizeLines(workingEntries[idx].lines);
        lastSavedLinesSig = linesSnapshot(draftLines);
        renderLineRows();
        renderCharReply();
        renderDiaryNav();
        updateSaveButtonAppearance();
    }

    function setFlipOpen(open) {
        var flip = document.getElementById('couple-diary-flip');
        if (!flip) return;
        if (open) flip.classList.add('is-open');
        else flip.classList.remove('is-open');
    }

    function onCoupleDiaryCoverClick(ev) {
        if (ev && ev.target && ev.target.closest && ev.target.closest('.couple-diary-cover-upload-btn')) return;
        setFlipOpen(true);
    }

    function triggerCoupleDiaryCoverUpload(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var input = document.getElementById('couple-diary-cover-input');
        if (input) input.click();
    }

    function handleCoupleDiaryCoverSelect(ev) {
        var input = ev && ev.target ? ev.target : document.getElementById('couple-diary-cover-input');
        if (!input || !input.files || !input.files[0]) return;
        var fid = currentFriendId || getActiveFriendIdFromPrivateContext();
        if (!fid) {
            if (typeof showNotification === 'function') showNotification('无法保存封面：请从情侣私密空间重新打开日记');
            input.value = '';
            return;
        }
        var file0 = input.files[0];
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file0)) {
            if (typeof showNotification === 'function') showNotification('请选择 JPEG、PNG 或 GIF 图片');
            input.value = '';
            return;
        }
        var st = store();
        if (!st || typeof st.upsertPair !== 'function') return;
        var reader = new FileReader();
        reader.onload = function () {
            var dataUrl = String(reader.result || '');
            if (!dataUrl) return;
            (async function () {
                var out = dataUrl;
                if (typeof compressDataUrlImage === 'function') {
                    try {
                        out = await compressDataUrlImage(out, { maxDim: 1200, quality: 0.82, mime: 'image/jpeg' });
                    } catch (e0) {}
                }
                try {
                    st.upsertPair(fid, { diaryCoverDataUrl: out });
                } catch (e1) {}
                if (global.__coupleSpaceStateLastPersistOk === false && typeof compressDataUrlImage === 'function') {
                    try {
                        var smaller = await compressDataUrlImage(out, { maxDim: 800, quality: 0.72, mime: 'image/jpeg' });
                        st.upsertPair(fid, { diaryCoverDataUrl: smaller });
                    } catch (e2) {}
                }
                if (fid && !currentFriendId) currentFriendId = fid;
                renderCoverBg();
                if (global.__coupleSpaceStateLastPersistOk === false && typeof showNotification === 'function') {
                    showNotification('封面已显示；写入本地失败（存储空间不足）。清理聊天记录或图片后重试。');
                }
            })();
        };
        reader.readAsDataURL(input.files[0]);
        input.value = '';
    }

    function openDiaryLineEditor(lineIndex) {
        editingLineIndex = lineIndex;
        var sheet = document.getElementById('couple-diary-line-sheet');
        var ta = document.getElementById('couple-diary-line-textarea');
        if (!sheet || !ta) return;
        ta.value = String(draftLines[lineIndex] || '');
        sheet.classList.add('show');
        sheet.setAttribute('aria-hidden', 'false');
        try {
            ta.focus();
        } catch (e) {}
    }

    function closeDiaryLineEditor() {
        var sheet = document.getElementById('couple-diary-line-sheet');
        if (sheet) {
            sheet.classList.remove('show');
            sheet.setAttribute('aria-hidden', 'true');
        }
        editingLineIndex = -1;
    }

    function confirmDiaryLineEditor() {
        var ta = document.getElementById('couple-diary-line-textarea');
        if (!ta || editingLineIndex < 0 || editingLineIndex >= DIARY_LINE_COUNT) {
            closeDiaryLineEditor();
            return;
        }
        var v = String(ta.value || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        var lines = v.split('\n');
        draftLines[editingLineIndex] = lines[0] != null ? lines[0] : '';
        for (var k = 1; k < lines.length && editingLineIndex + k < DIARY_LINE_COUNT; k++) {
            draftLines[editingLineIndex + k] = lines[k];
        }
        closeDiaryLineEditor();
        renderLineRows();
        commitDraftToCurrentEntry();
        updateSaveButtonAppearance();
    }

    function parseDiaryReplyFromApiText(raw) {
        var text = String(raw || '').trim();
        if (!text) return '';
        text = text.replace(/^```[\s\S]*?\n?/, '').replace(/```$/, '').trim();
        var obj = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(text) : null;
        if (obj && typeof obj === 'object' && obj.reply != null) {
            return String(obj.reply).trim();
        }
        if (/构思|思维链|chain[- ]?of[- ]?thought|output format|json/i.test(text)) return '';
        if (text.length < 4000 && !/^\s*\{\s*"reply"/.test(text)) return text;
        return '';
    }

    function isDiaryReplyInvalid(msg) {
        var s = String(msg || '').trim();
        if (!s) return true;
        if (/构思|思维链|推理|chain[- ]?of[- ]?thought|output format/i.test(s)) return true;
        return false;
    }

    function fallbackDiaryReply() {
        return '我读完了。想说的太多，一时不知道从哪里说起……下次见面再慢慢聊，好吗？';
    }

    function setCharLoading(on) {
        var el = document.getElementById('couple-diary-char-loading');
        if (!el) return;
        el.style.display = on ? 'block' : 'none';
    }

    function goCoupleDiaryPrev() {
        commitDraftToCurrentEntry();
        if (currentEntryIndex <= 0) return;
        loadEntryAtIndex(currentEntryIndex - 1);
    }

    function goCoupleDiaryNext() {
        commitDraftToCurrentEntry();
        if (currentEntryIndex >= workingEntries.length - 1) return;
        loadEntryAtIndex(currentEntryIndex + 1);
    }

    function createNewCoupleDiaryEntry() {
        commitDraftToCurrentEntry();
        workingEntries.push({
            id: newEntryId(),
            savedAt: Date.now(),
            lines: normalizeLines([]),
            charReply: '',
            charReplyAt: undefined
        });
        currentEntryIndex = workingEntries.length - 1;
        draftLines = normalizeLines([]);
        persistWorkingEntries();
        renderLineRows();
        renderCharReply();
        renderDiaryNav();
        lastSavedLinesSig = linesSnapshot(draftLines);
        updateSaveButtonAppearance();
        if (typeof showNotification === 'function') showNotification('已新建一篇日记');
    }

    async function saveCoupleDiaryDraft(ev) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        var st = store();
        if (!st || typeof st.upsertPair !== 'function' || !currentFriendId) {
            if (typeof showNotification === 'function') showNotification('无法保存：未选择情侣');
            return;
        }
        commitDraftToCurrentEntry();
        var ent = workingEntries[currentEntryIndex];
        if (!ent) {
            if (typeof showNotification === 'function') showNotification('日记数据异常');
            return;
        }
        var body = linesToDiaryBody(ent.lines);
        if (!body) {
            if (typeof showNotification === 'function') showNotification('请先写一点日记内容再保存');
            return;
        }

        ent.savedAt = Date.now();
        persistWorkingEntries();
        lastSavedLinesSig = linesSnapshot(ent.lines);
        updateSaveButtonAppearance();

        if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined') {
            if (typeof showNotification === 'function') showNotification('系统未加载 API 模块');
            return;
        }

        var sendContent = CommandManager.buildCoupleDiaryCharReplySendContent(currentFriendId, {
            entryId: ent.id,
            diaryText: body
        });
        if (!sendContent) {
            if (typeof showNotification === 'function') showNotification('无法构建日记回应请求');
            return;
        }

        setCharLoading(true);
        var raw = null;
        try {
            raw = await FeatureCommandMapper.callApiModel(sendContent, null, {
                skipOverlay: true,
                suppressErrorDialog: true
            });
        } catch (e) {
            raw = null;
        }
        setCharLoading(false);

        if (raw == null || !String(raw).trim()) {
            if (typeof showNotification === 'function') showNotification('API 无响应或失败，日记已保存，可稍后重试保存以生成回应');
            return;
        }

        var reply = parseDiaryReplyFromApiText(raw);
        if (isDiaryReplyInvalid(reply)) reply = fallbackDiaryReply();
        ent.charReply = reply;
        ent.charReplyAt = Date.now();
        persistWorkingEntries();
        renderCharReply();
        if (typeof showNotification === 'function') showNotification('已保存，Char 的回应已更新');
    }

    function openCoupleDiaryPage() {
        var fid = getActiveFriendIdFromPrivateContext();
        if (!fid) {
            if (typeof showNotification === 'function') showNotification('请先进入情侣私密空间');
            return;
        }
        var st = store();
        if (!st) return;
        var pair = st.getPair ? st.getPair(fid) : null;
        if (!pair || String(pair.status) !== 'accepted') {
            if (typeof showNotification === 'function') showNotification('仅已确定关系的情侣可使用日记');
            return;
        }

        currentFriendId = fid;
        workingEntries = migrateLegacyEntries(pair);
        if (!workingEntries.length) {
            workingEntries.push({
                id: newEntryId(),
                savedAt: Date.now(),
                lines: normalizeLines([]),
                charReply: '',
                charReplyAt: undefined
            });
            persistWorkingEntries();
        }
        currentEntryIndex = workingEntries.length - 1;
        loadEntryAtIndex(currentEntryIndex);

        setFlipOpen(false);
        renderCoverBg();

        var page = document.getElementById('couple-diary-page');
        var root = document.getElementById('couple-space-page');
        if (page) {
            page.classList.add('show');
            page.setAttribute('aria-hidden', 'false');
        }
        if (root) root.classList.add('is-diary-open');
    }

    function closeCoupleDiaryPage() {
        closeDiaryLineEditor();
        commitDraftToCurrentEntry();
        persistWorkingEntries();
        var page = document.getElementById('couple-diary-page');
        var root = document.getElementById('couple-space-page');
        if (page) {
            page.classList.remove('show');
            page.setAttribute('aria-hidden', 'true');
        }
        if (root) root.classList.remove('is-diary-open');
        setFlipOpen(false);
        currentFriendId = '';
        workingEntries = [];
        currentEntryIndex = 0;
    }

    function bindDiaryFeatureButtonOnce() {
        if (global.__coupleDiaryBtnBound) return;
        global.__coupleDiaryBtnBound = true;
        var btn = document.getElementById('couple-private-diary-btn');
        if (btn) {
            btn.addEventListener('click', function (e) {
                if (e) e.preventDefault();
                openCoupleDiaryPage();
            });
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindDiaryFeatureButtonOnce);
    } else {
        bindDiaryFeatureButtonOnce();
    }

    global.openCoupleDiaryPage = openCoupleDiaryPage;
    global.closeCoupleDiaryPage = closeCoupleDiaryPage;
    global.onCoupleDiaryCoverClick = onCoupleDiaryCoverClick;
    global.triggerCoupleDiaryCoverUpload = triggerCoupleDiaryCoverUpload;
    global.handleCoupleDiaryCoverSelect = handleCoupleDiaryCoverSelect;
    global.confirmCoupleDiaryLineEditor = confirmDiaryLineEditor;
    global.closeCoupleDiaryLineEditor = closeDiaryLineEditor;
    global.saveCoupleDiaryDraft = saveCoupleDiaryDraft;
    global.goCoupleDiaryPrev = goCoupleDiaryPrev;
    global.goCoupleDiaryNext = goCoupleDiaryNext;
    global.createNewCoupleDiaryEntry = createNewCoupleDiaryEntry;
})(typeof window !== 'undefined' ? window : globalThis);
