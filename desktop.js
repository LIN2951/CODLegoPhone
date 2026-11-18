(function () {
    'use strict';

    const PAGE_KEY = 'legoDesktopPageV1';
    const PHOTO_KEY = 'legoDesktopPhotoV1';
    const NOTE_KEY = 'legoDesktopNoteV1';
    const MEMO_KEY = 'legoDesktopMemoV1';
    const DEFAULT_NOTE = '慢慢来，\n也很可爱。';
    const DEFAULT_PHOTO = 'assets/desktop/quiet-morning.webp';
    const WEEKDAYS = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const noteControllers = [];
    let photoController = null;
    let dataGeneration = 0;

    function notify(message) {
        if (typeof showNotification === 'function') showNotification(message);
    }

    function readStored(key, fallback) {
        try {
            const value = localStorage.getItem(key);
            return value === null ? fallback : value;
        } catch (_) {
            return fallback;
        }
    }

    function collectBackup() {
        noteControllers.forEach(function (controller) { controller.flush(true); });
        return {
            note: localStorage.getItem(NOTE_KEY),
            memo: localStorage.getItem(MEMO_KEY),
            photo: localStorage.getItem(PHOTO_KEY)
        };
    }

    async function validateBackup(payload) {
        if (payload == null) return null;
        if (typeof payload !== 'object' || Array.isArray(payload)) throw new Error('桌面备份格式无效，未导入备份。');
        const normalized = {};
        ['note', 'memo', 'photo'].forEach(function (field) {
            const value = payload[field];
            if (value !== null && typeof value !== 'string') throw new Error('桌面备份的' + field + '字段无效，未导入备份。');
            normalized[field] = value;
        });
        if (normalized.photo) {
            if (!/^data:image\/(?:jpeg|png|gif|webp);base64,[A-Za-z0-9+/\r\n]+={0,2}$/i.test(normalized.photo)) {
                throw new Error('桌面备份照片必须是有效的位图数据，未导入备份。');
            }
            try { await loadImage(normalized.photo); }
            catch (_) { throw new Error('桌面备份照片无法读取，未导入备份。'); }
        }
        return normalized;
    }

    function discardPending() {
        dataGeneration += 1;
        noteControllers.forEach(function (controller) { controller.discard(); });
        if (photoController) photoController.discard();
    }

    function syncDataFromStorage() {
        noteControllers.forEach(function (controller) { controller.sync(); });
        if (photoController) photoController.sync();
    }

    async function restoreBackup(payload) {
        const restored = await validateBackup(payload);
        if (restored === null) return;
        discardPending();
        const generation = dataGeneration;
        const keys = [NOTE_KEY, MEMO_KEY, PHOTO_KEY];
        const previous = keys.map(function (key) { return localStorage.getItem(key); });
        let photo = restored.photo;
        if (photo && typeof compressDataUrlImage === 'function') {
            photo = await compressDataUrlImage(photo, { maxDim: 1600, quality: 0.86, mime: 'image/jpeg' });
        }
        if (generation !== dataGeneration) throw new Error('桌面数据已变化，本次恢复已取消。');
        try {
            [restored.note, restored.memo].forEach(function (value, index) {
                if (value === null) localStorage.removeItem(keys[index]);
                else localStorage.setItem(keys[index], value);
            });
            if (photo) {
                const saved = typeof setLocalStorageStringWithQuotaFallback === 'function'
                    ? await setLocalStorageStringWithQuotaFallback(PHOTO_KEY, photo, { maxDim: 1600, quality: 0.86, mime: 'image/jpeg' })
                    : (localStorage.setItem(PHOTO_KEY, photo), photo);
                if (!saved) throw new Error('桌面照片超过浏览器存储空间，未能完整恢复桌面。');
            } else {
                localStorage.removeItem(PHOTO_KEY);
            }
        } catch (error) {
            // Restore the previous widget snapshot if one of the three writes fails.
            keys.forEach(function (key) { try { localStorage.removeItem(key); } catch (_) {} });
            keys.forEach(function (key, index) {
                try { if (previous[index] !== null) localStorage.setItem(key, previous[index]); } catch (_) {}
            });
            throw error;
        } finally {
            syncDataFromStorage();
        }
    }

    function clearData() {
        discardPending();
        [NOTE_KEY, MEMO_KEY, PHOTO_KEY].forEach(function (key) { localStorage.removeItem(key); });
        syncDataFromStorage();
    }

    window.LegoDesktop = { collectBackup, validateBackup, restoreBackup, discardPending, clearData };

    function initDesktop() {
        const root = document.getElementById('home-screen');
        if (!root || root.dataset.desktopReady === 'true') return;
        root.dataset.desktopReady = 'true';

        const flushNotes = [];
        initPager(root);
        initKeyboardActions(root);
        initNote('desktop-note', NOTE_KEY, DEFAULT_NOTE);
        initNote('desktop-memo', MEMO_KEY, '');
        initPhoto(root);

        let clockTimer = 0;
        let calendarDate = '';

        function updateDate() {
            clearTimeout(clockTimer);
            const now = new Date();
            const hours = String(now.getHours()).padStart(2, '0');
            const minutes = String(now.getMinutes()).padStart(2, '0');
            setText('desktop-digital-time', hours + ':' + minutes);

            const dateKey = [now.getFullYear(), now.getMonth(), now.getDate()].join('-');
            if (calendarDate !== dateKey) {
                calendarDate = dateKey;
                const weekday = WEEKDAYS[now.getDay()];
                setText('desktop-date-label', (now.getMonth() + 1) + '月' + now.getDate() + '日 · ' + weekday);
                setText('desktop-month-label', now.getFullYear() + '年' + (now.getMonth() + 1) + '月');
                setText('desktop-calendar-full-date', (now.getMonth() + 1) + '月' + now.getDate() + '日');
                setText('desktop-calendar-weekday', weekday);
                setText('desktop-day-number', String(now.getDate()).padStart(2, '0'));
                renderCalendar(now);
            }

            if (!document.hidden) {
                clockTimer = setTimeout(updateDate, (60 - now.getSeconds()) * 1000 - now.getMilliseconds() + 30);
            }
        }

        function setText(id, value) {
            const element = document.getElementById(id);
            if (element) element.textContent = value;
        }

        function renderCalendar(now) {
            const grid = document.getElementById('desktop-calendar-grid');
            if (!grid) return;
            const year = now.getFullYear();
            const month = now.getMonth();
            const firstWeekday = (new Date(year, month, 1).getDay() + 6) % 7;
            const monthDays = new Date(year, month + 1, 0).getDate();
            const fragment = document.createDocumentFragment();
            for (let index = 0; index < firstWeekday; index += 1) {
                const spacer = document.createElement('span');
                spacer.className = 'desktop-calendar-spacer';
                spacer.setAttribute('aria-hidden', 'true');
                fragment.appendChild(spacer);
            }
            for (let day = 1; day <= monthDays; day += 1) {
                const element = document.createElement('span');
                element.className = 'desktop-calendar-day';
                element.textContent = String(day);
                element.setAttribute('aria-label', (month + 1) + '月' + day + '日');
                if (day === now.getDate()) {
                    element.classList.add('is-today');
                    element.setAttribute('aria-current', 'date');
                }
                fragment.appendChild(element);
            }
            grid.replaceChildren(fragment);
            grid.setAttribute('aria-label', year + '年' + (month + 1) + '月月历');
        }

        function initNote(id, key, fallback) {
            const field = document.getElementById(id);
            if (!field) return;
            field.value = readStored(key, fallback);
            let saveTimer = 0;
            let dirty = false;
            let failureShown = false;

            function save(strict) {
                clearTimeout(saveTimer);
                if (!dirty) return;
                try {
                    localStorage.setItem(key, field.value);
                    dirty = false;
                    failureShown = false;
                } catch (_) {
                    if (strict === true) throw new Error('桌面便签尚未保存，请释放浏览器存储空间后重新导出。');
                    if (!failureShown) {
                        notify('便签保存失败，请释放浏览器存储空间后重试；当前文字仍保留在这里。');
                        failureShown = true;
                    }
                }
            }

            field.addEventListener('input', function () {
                dirty = true;
                clearTimeout(saveTimer);
                saveTimer = setTimeout(save, 200);
            });
            field.addEventListener('blur', save);
            flushNotes.push(save);
            noteControllers.push({
                flush: save,
                discard: function () {
                    clearTimeout(saveTimer);
                    dirty = false;
                    failureShown = false;
                },
                sync: function () { field.value = readStored(key, fallback); }
            });
            window.addEventListener('storage', function (event) {
                if (event.key === key && !dirty && document.activeElement !== field) {
                    field.value = event.newValue === null ? fallback : event.newValue;
                }
            });
        }

        document.addEventListener('visibilitychange', function () {
            if (document.hidden) {
                clearTimeout(clockTimer);
                flushNotes.forEach(function (save) { save(); });
            } else {
                updateDate();
            }
        });
        window.addEventListener('pagehide', function () {
            clearTimeout(clockTimer);
            flushNotes.forEach(function (save) { save(); });
        });
        window.addEventListener('pageshow', updateDate);
        updateDate();
    }

    function initPager(root) {
        const pager = document.getElementById('desktop-pager');
        if (!pager) return;
        const panels = Array.from(pager.querySelectorAll('.desktop-panel'));
        const controls = Array.from(root.querySelectorAll('[data-desktop-target]'));
        if (!panels.length) return;
        const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
        const DRAG_THRESHOLD = 8;
        const FLICK_VELOCITY = 0.32;
        const FLICK_MIN_TRAVEL = 10;
        const PAGE_TURN_RATIO = 0.35;
        let currentIndex = 0;
        let scrollFrame = 0;
        let resizeFrame = 0;
        let pendingTarget = null;
        let scrollIdleTimer = 0;
        let settleFrame = 0;
        let gesture = null;
        let suppressClick = false;
        try {
            const saved = Number(sessionStorage.getItem(PAGE_KEY));
            if (Number.isInteger(saved)) currentIndex = Math.max(0, Math.min(panels.length - 1, saved));
        } catch (_) {}

        function panelLeft(index) {
            const pagerRect = pager.getBoundingClientRect();
            return pager.scrollLeft + panels[index].getBoundingClientRect().left - pagerRect.left - pager.clientLeft;
        }

        function updateControls(index) {
            currentIndex = index;
            controls.forEach(function (control) {
                const active = control.dataset.desktopTarget === panels[index].id;
                control.classList.toggle('is-active', active);
                if (active) control.setAttribute('aria-current', 'page');
                else control.removeAttribute('aria-current');
                control.setAttribute('aria-controls', control.dataset.desktopTarget);
            });
            panels.forEach(function (panel, panelIndex) {
                panel.classList.toggle('is-active', panelIndex === index);
                // Offscreen controls must not receive focus during keyboard navigation.
                panel.inert = panelIndex !== index;
            });
            try { sessionStorage.setItem(PAGE_KEY, String(index)); } catch (_) {}
        }

        function pageFraction() {
            return pager.scrollLeft / Math.max(1, pager.clientWidth);
        }

        function setSnapEnabled(enabled) {
            pager.classList.toggle('is-snap-off', !enabled);
        }

        function cancelSettle() {
            if (settleFrame) cancelAnimationFrame(settleFrame);
            settleFrame = 0;
        }

        function finishScroll() {
            clearTimeout(scrollIdleTimer);
            pendingTarget = null;
            syncClosestPanel();
        }

        function finishSettle() {
            setSnapEnabled(true);
            finishScroll();
        }

        function animateTo(targetLeft) {
            cancelSettle();
            const from = pager.scrollLeft;
            const distance = targetLeft - from;
            if (Math.abs(distance) <= 1 || reducedMotion.matches) {
                pager.scrollLeft = targetLeft;
                finishSettle();
                return;
            }
            setSnapEnabled(false);
            const duration = Math.min(430, Math.max(170, 150 + Math.abs(distance) * 0.3));
            const startedAt = performance.now();
            function step(now) {
                const progress = Math.min(1, (now - startedAt) / duration);
                pager.scrollLeft = from + distance * (1 - Math.pow(1 - progress, 3));
                if (progress < 1) settleFrame = requestAnimationFrame(step);
                else {
                    settleFrame = 0;
                    finishSettle();
                }
            }
            settleFrame = requestAnimationFrame(step);
        }

        function goTo(index, animate) {
            const target = Math.max(0, Math.min(panels.length - 1, index));
            const targetLeft = panelLeft(target);
            clearTimeout(scrollIdleTimer);
            pendingTarget = animate ? target : null;
            updateControls(target);
            if (animate) {
                animateTo(targetLeft);
            } else {
                cancelSettle();
                setSnapEnabled(true);
                pager.scrollTo({ left: targetLeft, behavior: 'instant' });
            }
        }

        controls.forEach(function (control) {
            control.addEventListener('click', function () {
                const index = panels.findIndex(function (panel) { return panel.id === control.dataset.desktopTarget; });
                if (index >= 0) goTo(index, true);
            });
        });

        function onKeydown(event) {
            const focusedControl = controls.includes(event.target);
            if (event.target !== pager && !focusedControl) return;
            if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
            let target = currentIndex;
            if (event.key === 'ArrowRight') target += 1;
            else if (event.key === 'ArrowLeft') target -= 1;
            else if (event.key === 'Home') target = 0;
            else if (event.key === 'End') target = panels.length - 1;
            else return;
            event.preventDefault();
            goTo(target, true);
            if (focusedControl) {
                const selected = controls.find(function (control) { return control.dataset.desktopTarget === panels[currentIndex].id; });
                if (selected) selected.focus({ preventScroll: true });
            }
        }

        pager.addEventListener('keydown', onKeydown);
        const pagination = root.querySelector('.desktop-pagination');
        if (pagination) pagination.addEventListener('keydown', onKeydown);

        function syncClosestPanel() {
            let closest = currentIndex;
            let distance = Infinity;
            panels.forEach(function (_, index) {
                const nextDistance = Math.abs(panelLeft(index) - pager.scrollLeft);
                if (nextDistance < distance) {
                    closest = index;
                    distance = nextDistance;
                }
            });
            if (closest !== currentIndex) updateControls(closest);
        }

        function interruptAnimation() {
            cancelSettle();
            pendingTarget = null;
            clearTimeout(scrollIdleTimer);
            setSnapEnabled(true);
            syncClosestPanel();
        }

        function isFormField(target) {
            return !!(target && target.closest && target.closest('input, textarea, select, [contenteditable="true"]'));
        }

        function onPointerDown(event) {
            if (!event.isPrimary || (event.pointerType === 'mouse' && event.button !== 0)) return;
            interruptAnimation();
            suppressClick = false;
            if (isFormField(event.target)) { gesture = null; return; }
            if (gesture && gesture.active) return;
            gesture = {
                id: event.pointerId,
                startX: event.clientX,
                startY: event.clientY,
                startScroll: pager.scrollLeft,
                active: false,
                spent: false,
                samples: [{ t: event.timeStamp, x: event.clientX }]
            };
        }

        function onPointerMove(event) {
            if (!gesture || event.pointerId !== gesture.id || gesture.spent) return;
            if (event.pointerType === 'mouse' && !(event.buttons & 1)) { gesture = null; return; }
            const dx = event.clientX - gesture.startX;
            const dy = event.clientY - gesture.startY;
            if (!gesture.active) {
                const absX = Math.abs(dx);
                const absY = Math.abs(dy);
                if (absX < DRAG_THRESHOLD && absY < DRAG_THRESHOLD) return;
                if (absX <= absY) {
                    gesture.spent = true;
                    suppressClick = true;
                    return;
                }
                gesture.active = true;
                suppressClick = true;
                setSnapEnabled(false);
                pager.classList.add('is-dragging');
                try { pager.setPointerCapture(gesture.id); } catch (_) {}
            }
            event.preventDefault();
            pager.scrollLeft = gesture.startScroll - dx;
            const samples = gesture.samples;
            samples.push({ t: event.timeStamp, x: event.clientX });
            while (samples.length > 2 && event.timeStamp - samples[0].t > 110) samples.shift();
        }

        function onPointerEnd(event) {
            if (!gesture || event.pointerId !== gesture.id) return;
            const done = gesture;
            gesture = null;
            if (!done.active) return;
            pager.classList.remove('is-dragging');
            try { pager.releasePointerCapture(done.id); } catch (_) {}
            const position = pageFraction();
            let target;
            if (event.type === 'pointercancel') {
                target = Math.round(position);
            } else {
                done.samples.push({ t: event.timeStamp, x: event.clientX });
                const last = done.samples[done.samples.length - 1];
                let ref = done.samples[0];
                for (let i = done.samples.length - 1; i >= 0; i -= 1) {
                    if (last.t - done.samples[i].t > 110) break;
                    ref = done.samples[i];
                }
                const elapsed = last.t - ref.t;
                const velocity = elapsed > 0 ? (last.x - ref.x) / elapsed : 0;
                const travel = Math.abs(pager.scrollLeft - done.startScroll);
                if (Math.abs(velocity) >= FLICK_VELOCITY && travel >= FLICK_MIN_TRAVEL) {
                    target = velocity < 0 ? Math.floor(position) + 1 : Math.ceil(position) - 1;
                } else {
                    target = Math.floor(position + (1 - PAGE_TURN_RATIO));
                }
            }
            goTo(target, true);
        }

        if (typeof window.PointerEvent === 'function') {
            pager.classList.add('is-swipe-enabled');
            pager.addEventListener('pointerdown', onPointerDown, { passive: true });
            pager.addEventListener('pointermove', onPointerMove, { passive: false });
            pager.addEventListener('pointerup', onPointerEnd, { passive: true });
            pager.addEventListener('pointercancel', onPointerEnd, { passive: true });
            pager.addEventListener('dragstart', function (event) { event.preventDefault(); });
            pager.addEventListener('click', function (event) {
                if (!suppressClick) return;
                suppressClick = false;
                event.preventDefault();
                event.stopPropagation();
            }, true);
        }

        pager.addEventListener('wheel', interruptAnimation, { passive: true });
        pager.addEventListener('scrollend', finishScroll);
        pager.addEventListener('scroll', function () {
            clearTimeout(scrollIdleTimer);
            scrollIdleTimer = setTimeout(finishScroll, 180);
            if (scrollFrame) return;
            scrollFrame = requestAnimationFrame(function () {
                scrollFrame = 0;
                // Keep the selected destination stable while the page-change
                // animation still passes through the previous page. Direct
                // pointer/wheel input cancels this guard so gestures stay
                // interruptible.
                if (pendingTarget !== null && Math.abs(panelLeft(pendingTarget) - pager.scrollLeft) > 1) return;
                pendingTarget = null;
                syncClosestPanel();
            });
        }, { passive: true });

        function restorePage() {
            cancelAnimationFrame(resizeFrame);
            resizeFrame = requestAnimationFrame(function () {
                if (pager.clientWidth > 0) goTo(currentIndex, false);
            });
        }
        if (typeof ResizeObserver === 'function') new ResizeObserver(restorePage).observe(pager);
        else window.addEventListener('resize', restorePage, { passive: true });
        updateControls(currentIndex);
        restorePage();
    }

    function initKeyboardActions(root) {
        root.querySelectorAll('.function-item[data-page], .nav-item[data-page], .main-card .decorative-icons, .main-card .card-signature, .main-card .card-location').forEach(function (element) {
            if (/^(BUTTON|A|INPUT|TEXTAREA|SELECT)$/.test(element.tagName)) return;
            element.setAttribute('role', 'button');
            element.tabIndex = 0;
            if (!element.getAttribute('aria-label')) {
                const name = element.querySelector('.function-name, .nav-name');
                element.setAttribute('aria-label', name ? '打开' + name.textContent.trim() : '编辑个人卡片文字');
            }
            element.addEventListener('keydown', function (event) {
                if (event.target !== element || event.repeat || (event.key !== 'Enter' && event.key !== ' ')) return;
                event.preventDefault();
                element.click();
            });
        });
    }

    function initPhoto(root) {
        const input = document.getElementById('desktop-photo-input');
        const reset = document.getElementById('desktop-photo-reset');
        const images = Array.from(root.querySelectorAll('img[data-desktop-photo]'));
        const pickers = Array.from(root.querySelectorAll('[data-desktop-photo-pick]'));
        if (!input || !images.length) return;
        input.accept = 'image/*';
        let generation = 0;
        const saved = readStored(PHOTO_KEY, '');
        let customPhoto = /^data:image\/(?:jpeg|png|gif|webp);/i.test(saved) ? saved : '';

        function render() {
            images.forEach(function (image) { image.src = customPhoto || DEFAULT_PHOTO; });
            if (reset) reset.hidden = !customPhoto;
        }

        function setBusy(busy) {
            pickers.forEach(function (button) {
                if (busy) button.setAttribute('aria-busy', 'true');
                else button.removeAttribute('aria-busy');
            });
        }

        photoController = {
            discard: function () {
                generation += 1;
                setBusy(false);
            },
            sync: function () {
                const value = readStored(PHOTO_KEY, '');
                customPhoto = /^data:image\/(?:jpeg|png|gif|webp);/i.test(value) ? value : '';
                render();
            }
        };

        pickers.forEach(function (button) {
            button.addEventListener('click', function () { input.click(); });
        });

        if (reset) reset.addEventListener('click', function () {
            generation += 1;
            setBusy(false);
            try {
                localStorage.removeItem(PHOTO_KEY);
                customPhoto = '';
                render();
            } catch (_) {
                notify('照片恢复失败，请检查浏览器存储权限后重试。');
            }
        });

        input.addEventListener('change', async function () {
            const file = input.files && input.files[0];
            input.value = '';
            if (!file) return;
            const request = ++generation;
            setBusy(false);
            const allowed = typeof isLegoUploadableRasterImageFile === 'function'
                ? isLegoUploadableRasterImageFile(file)
                : /^image\/(jpeg|png|gif|webp)$/i.test(file.type) || /\.(jpe?g|png|gif|webp)$/i.test(file.name || '');
            if (!allowed) {
                notify('请选择 JPEG、PNG 或 GIF 格式的照片。');
                return;
            }
            if (file.size > 20 * 1024 * 1024) {
                notify('照片超过 20 MB，请选择一张较小的照片。');
                return;
            }
            setBusy(true);
            try {
                const source = await readFile(file);
                let compressed = typeof compressDataUrlImage === 'function'
                    ? await compressDataUrlImage(source, { maxDim: 1600, quality: 0.86, mime: 'image/jpeg' })
                    : source;
                const decoded = await loadImage(compressed);
                if (!/^data:image\/(?:jpeg|png|gif|webp);/i.test(compressed) || Math.max(decoded.naturalWidth, decoded.naturalHeight) > 1600) {
                    const scale = Math.min(1, 1600 / Math.max(decoded.naturalWidth, decoded.naturalHeight));
                    const canvas = document.createElement('canvas');
                    canvas.width = Math.max(1, Math.round(decoded.naturalWidth * scale));
                    canvas.height = Math.max(1, Math.round(decoded.naturalHeight * scale));
                    const context = canvas.getContext('2d');
                    if (!context) throw new Error('IMAGE_CANVAS');
                    context.drawImage(decoded, 0, 0, canvas.width, canvas.height);
                    compressed = canvas.toDataURL('image/jpeg', 0.86);
                }
                if (request !== generation) return;
                try {
                    localStorage.setItem(PHOTO_KEY, compressed);
                } catch (_) {
                    notify('照片保存失败，请释放浏览器存储空间后重试。');
                    return;
                }
                customPhoto = compressed;
                render();
            } catch (_) {
                if (request === generation) notify('这张照片未能读取，请换一张 JPEG、PNG 或 GIF 图片重试。');
            } finally {
                if (request === generation) setBusy(false);
            }
        });
        render();
    }

    function readFile(file) {
        return new Promise(function (resolve, reject) {
            const reader = new FileReader();
            reader.onload = function () { resolve(reader.result); };
            reader.onerror = function () { reject(new Error('IMAGE_READ')); };
            reader.onabort = function () { reject(new Error('IMAGE_READ_ABORT')); };
            reader.readAsDataURL(file);
        });
    }

    function loadImage(source) {
        return new Promise(function (resolve, reject) {
            const image = new Image();
            const timer = setTimeout(function () {
                image.onload = null;
                image.onerror = null;
                reject(new Error('IMAGE_DECODE_TIMEOUT'));
            }, 15000);
            image.onload = function () {
                clearTimeout(timer);
                if (!image.naturalWidth || !image.naturalHeight) reject(new Error('IMAGE_DIMENSIONS'));
                else resolve(image);
            };
            image.onerror = function () {
                clearTimeout(timer);
                reject(new Error('IMAGE_DECODE'));
            };
            image.src = source;
        });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initDesktop, { once: true });
    else initDesktop();
})();
