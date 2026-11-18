/**
 * 设置 · 主动发消息：本文件管理表单，wechat-proactive-runtime.js 管理每位好友的分享与回复。
 * 依赖：wechat-proactive-core.js、wechat-proactive-runtime.js、wechat-store。
 * 专用 API：localStorage proactiveAutoApiSettingsV1，见主设置 · 自动消息API设置。
 */
(function () {
    var LS_KEY = 'proactiveMessageSettingsV1';
    /** @type {Set<string>} */
    var modalSelectedIds = new Set();

    function clampInt(n, min, max, fallback) {
        var x = parseInt(n, 10);
        if (!Number.isFinite(x)) return fallback;
        return Math.min(max, Math.max(min, x));
    }

    function loadSettings() {
        return Wechat.proactive.settings();
    }

    function saveSettings(s) {
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(LegoProactiveCore.settings(s)));
        } catch (e) {
            if (typeof showNotification === 'function') showNotification('主动消息设置保存失败，请检查存储空间');
        }
    }

    function updateDetailPanelVisibility() {
        var toggle = document.getElementById('auto-message-toggle');
        var panel = document.getElementById('auto-message-detail-panel');
        if (!toggle || !panel) return;
        panel.style.display = toggle.checked ? 'block' : 'none';
    }

    function syncFormFromSettings() {
        var s = loadSettings();
        var toggle = document.getElementById('auto-message-toggle');
        var intervalEl = document.getElementById('auto-message-interval-min');
        var ts = document.getElementById('auto-message-time-start');
        var te = document.getElementById('auto-message-time-end');
        var sysT = document.getElementById('auto-message-system-notify-toggle');
        if (toggle) toggle.checked = s.enabled;
        if (intervalEl) intervalEl.value = String(s.intervalMinutes);
        if (ts) ts.value = s.timeStart.length === 5 ? s.timeStart : '09:00';
        if (te) te.value = s.timeEnd.length === 5 ? s.timeEnd : '23:00';
        if (sysT) sysT.checked = s.systemNotify;
        updateDetailPanelVisibility();
        updateCandidatesSummary();
    }

    function readFormIntoSettings(base) {
        var s = Object.assign({}, base || loadSettings());
        var toggle = document.getElementById('auto-message-toggle');
        var intervalEl = document.getElementById('auto-message-interval-min');
        var ts = document.getElementById('auto-message-time-start');
        var te = document.getElementById('auto-message-time-end');
        var sysT = document.getElementById('auto-message-system-notify-toggle');
        if (toggle) s.enabled = !!toggle.checked;
        if (intervalEl) s.intervalMinutes = clampInt(intervalEl.value, 0, 1440, 30);
        if (ts && ts.value) s.timeStart = ts.value;
        if (te && te.value) s.timeEnd = te.value;
        if (sysT) s.systemNotify = !!sysT.checked;
        return s;
    }

    function updateCandidatesSummary() {
        var el = document.getElementById('auto-message-candidates-summary');
        if (!el) return;
        var s = loadSettings();
        var n = Array.isArray(s.candidateIds) ? s.candidateIds.length : 0;
        el.textContent = n > 0 ? '已选 ' + n + ' 位好友' : '未选择好友（不会主动发消息）';
    }

    async function requestNotifyPermissionIfNeeded() {
        if (typeof Notification === 'undefined') return;
        var sysT = document.getElementById('auto-message-system-notify-toggle');
        if (!sysT || !sysT.checked) return;
        if (Notification.permission === 'granted') return;
        if (Notification.permission === 'denied') {
            if (typeof showNotification === 'function') showNotification('浏览器已禁止本站通知');
            return;
        }
        try {
            await Notification.requestPermission();
        } catch (e) {}
    }

    function renderProactiveCandidatesList() {
        var listEl = document.getElementById('proactive-candidates-list');
        var emptyEl = document.getElementById('proactive-candidates-empty');
        if (!listEl) return;
        listEl.innerHTML = '';
        var friends = [];
        try {
            if (typeof loadFriendsFromStorage === 'function') friends = loadFriendsFromStorage();
        } catch (e) {
            friends = [];
        }
        friends = friends.filter(function (f) {
            return f && !f.isGroup && !f.blacklisted && f.id != null;
        });
        var saved = loadSettings().candidateIds.map(String);
        modalSelectedIds = new Set(saved);

        friends.forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'forward-friend-row';
            row.dataset.friendId = String(f.id);
            var check = document.createElement('div');
            check.className = 'forward-friend-checkbox';
            var avatar = document.createElement('div');
            avatar.className = 'forward-friend-avatar';
            var fwdAv = '';
            try {
                fwdAv =
                    typeof getFriendDisplayAvatar === 'function'
                        ? getFriendDisplayAvatar(f)
                        : (typeof normalizeAvatarUrl === 'function'
                            ? (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || '')
                            : '');
            } catch (eAv) {}
            if (fwdAv) {
                avatar.style.backgroundImage = 'url(' + fwdAv + ')';
                avatar.textContent = '';
            } else {
                avatar.textContent = (f.nickname || '?').charAt(0);
            }
            var name = document.createElement('span');
            name.className = 'forward-friend-name';
            name.textContent = (f.remark || f.nickname || '未命名').trim() || '未命名';
            row.appendChild(check);
            row.appendChild(avatar);
            row.appendChild(name);
            var fid = String(f.id);
            if (modalSelectedIds.has(fid)) row.classList.add('selected');
            row.addEventListener('click', function () {
                if (modalSelectedIds.has(fid)) {
                    modalSelectedIds.delete(fid);
                    row.classList.remove('selected');
                } else {
                    modalSelectedIds.add(fid);
                    row.classList.add('selected');
                }
            });
            listEl.appendChild(row);
        });

        if (emptyEl) {
            var has = listEl.children.length > 0;
            emptyEl.style.display = has ? 'none' : 'block';
        }
    }

    function openProactiveCandidatesModal() {
        renderProactiveCandidatesList();
        var modal = document.getElementById('proactive-candidates-modal');
        if (modal) modal.classList.add('show');
    }

    function closeProactiveCandidatesModal() {
        var modal = document.getElementById('proactive-candidates-modal');
        if (modal) modal.classList.remove('show');
    }

    function confirmProactiveCandidatesModal() {
        var s = readFormIntoSettings();
        s.candidateIds = Array.from(modalSelectedIds);
        saveSettings(s);
        closeProactiveCandidatesModal();
        updateCandidatesSummary();
        rescheduleTimer();
    }

    function rescheduleTimer() {
        Wechat.proactive.reschedule();
    }

    function bindSettingsUi() {
        var toggle = document.getElementById('auto-message-toggle');
        var intervalEl = document.getElementById('auto-message-interval-min');
        var ts = document.getElementById('auto-message-time-start');
        var te = document.getElementById('auto-message-time-end');
        var sysT = document.getElementById('auto-message-system-notify-toggle');
        var candRow = document.getElementById('auto-message-candidates-row');

        if (toggle) {
            toggle.addEventListener('change', function () {
                var s = readFormIntoSettings();
                saveSettings(s);
                updateDetailPanelVisibility();
                rescheduleTimer();
            });
        }
        function persistFromForm() {
            var s = readFormIntoSettings();
            saveSettings(s);
            rescheduleTimer();
        }
        if (intervalEl) intervalEl.addEventListener('change', persistFromForm);
        if (ts) ts.addEventListener('change', persistFromForm);
        if (te) te.addEventListener('change', persistFromForm);
        if (sysT) {
            sysT.addEventListener('change', function () {
                persistFromForm();
                requestNotifyPermissionIfNeeded();
            });
        }
        if (candRow) {
            candRow.addEventListener('click', function () {
                openProactiveCandidatesModal();
            });
        }

        syncFormFromSettings();
        rescheduleTimer();
    }

    window.openProactiveCandidatesModal = openProactiveCandidatesModal;
    window.closeProactiveCandidatesModal = closeProactiveCandidatesModal;
    window.confirmProactiveCandidatesModal = confirmProactiveCandidatesModal;

    document.addEventListener('DOMContentLoaded', function () {
        bindSettingsUi();
    });
})();
