(function (global) {
    'use strict';

    var SECTION_LABELS = {
        following: '风向',
        forYou: '深海',
        entertainment: '清扫'
    };

    function getPhoneState() {
        if (!global.PhoneFeature || !global.PhoneFeature.state) return null;
        return global.PhoneFeature.state;
    }

    function getFriend() {
        var state = getPhoneState();
        return state && state.friend ? state.friend : null;
    }

    function getModeStore() {
        return global.Twitter && global.Twitter.store ? global.Twitter.store : null;
    }

    function escapeHtml(s) {
        return String(s || '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function getFeedKindLabel(kind) {
        return SECTION_LABELS[kind] || '风向';
    }

    function notify(message) {
        var fn = typeof globalThis !== 'undefined' ? globalThis.showNotification : null;
        if (typeof fn === 'function') fn(message);
    }

    /** 刷新中替代「刷新」二字的圆点动效（与 .friend-darkweb-refresh--busy 同用） */
    var DARKWEB_REFRESH_DOTS_HTML = '<span class="friend-darkweb-refresh-dots" aria-hidden="true">' +
        '<span class="friend-darkweb-refresh-dot"></span>' +
        '<span class="friend-darkweb-refresh-dot"></span>' +
        '<span class="friend-darkweb-refresh-dot"></span></span>';

    /**
     * 将暗网内「刷新」按钮切为圆点/恢复为原文；在请求前 true，渲染完成后 false。
     * 注：若中途 renderCurrent 已整页重绘，新按钮上无 data-darkweb-refresh-saved，false 时仅作清理。
     */
    function setDarkwebRefreshButtonsBusy(busy) {
        var host = global.document.getElementById('phone-friend-app-body');
        if (!host) return;
        var btns = host.querySelectorAll(
            'button[data-fapp="darkweb-refresh"],button[data-fapp="darkweb-detail-refresh-comments"]'
        );
        Array.prototype.forEach.call(btns, function (btn) {
            if (busy) {
                if (btn.classList.contains('friend-darkweb-refresh--busy')) return;
                btn.dataset.darkwebRefreshSaved = btn.innerHTML;
                btn.classList.add('friend-darkweb-refresh--busy');
                btn.disabled = true;
                btn.setAttribute('aria-busy', 'true');
                btn.setAttribute('aria-label', '加载中');
                btn.innerHTML = DARKWEB_REFRESH_DOTS_HTML;
            } else {
                if (btn.dataset.darkwebRefreshSaved) {
                    btn.innerHTML = btn.dataset.darkwebRefreshSaved;
                    delete btn.dataset.darkwebRefreshSaved;
                }
                btn.classList.remove('friend-darkweb-refresh--busy');
                btn.disabled = false;
                btn.removeAttribute('aria-busy');
                btn.removeAttribute('aria-label');
            }
        });
    }

    /** 与 twitter-ui 一致；历史上仅挂在 Twitter.ui 上，暗网进详情会静默失败，故优先支持全局 + ui 两路 */
    function getExtractTwitterTweetPayload() {
        if (typeof global.extractTwitterTweetPayload === 'function') {
            return global.extractTwitterTweetPayload;
        }
        if (global.Twitter && global.Twitter.ui && typeof global.Twitter.ui.extractTwitterTweetPayload === 'function') {
            return global.Twitter.ui.extractTwitterTweetPayload;
        }
        return null;
    }

    function getFeatureCommandMapper() {
        var w = global;
        if (w.FeatureCommandMapper && typeof w.FeatureCommandMapper.callApiModel === 'function') {
            return w.FeatureCommandMapper;
        }
        try {
            if (typeof FeatureCommandMapper !== 'undefined' && FeatureCommandMapper &&
                typeof FeatureCommandMapper.callApiModel === 'function') {
                return FeatureCommandMapper;
            }
        } catch (e) {}
        return null;
    }

    /** 详情 HTML 跨会话持久化，避免同帖二次请求模型；仅用户点「刷新」时更新评论等 */
    var DARKWEB_DETAIL_CACHE_LS = 'legoFriendDarkWebDetailHtmlCache_v1';
    var DARKWEB_DETAIL_CACHE_MAX = 24;

    function looksLikeDarkwebDetailLoadingOrError(html) {
        return /正在生成|正在重新生成|生成失败|触发了敏感|未就绪|无法构造|模型接口|详情全页生成器|主楼解析为空|解析失败/.test(
            String(html || '')
        );
    }

    function isUsableDarkwebDetailCacheEntry(main, comments) {
        if (!String(main || '').trim() || looksLikeDarkwebDetailLoadingOrError(main)) return false;
        if (!String(comments || '').trim() || looksLikeDarkwebDetailLoadingOrError(comments)) return false;
        return true;
    }

    /**
     * 与列表项一一对应：好友、入口（首页热帖/板块）与帖文摘要。不使用列表序号，避免刷列表后错位。
     */
    function computeDarkwebDetailCacheKey(payload, dw) {
        var friend = getFriend();
        var fid = friend && friend.id != null ? String(friend.id) : '0';
        var path =
            dw && dw.detailFromNav === 'section'
                ? 'sec:' + String((dw && dw.feedKind) || '')
                : 'hub';
        var title = String((payload && payload.threadTitle) || '').trim();
        var hk = String((payload && payload.handle) || '')
            .replace(/\s+/g, ' ')
            .trim();
        var plain = String((payload && payload.tweetPlainText) || '')
            .replace(/\s+/g, ' ')
            .trim();
        var tex = String((payload && payload.textHtml) || '')
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 320);
        var body = plain || tex;
        return [fid, path, title, hk, body].join('\u001e');
    }

    function readDarkwebDetailCacheStore() {
        try {
            if (typeof localStorage === 'undefined') return { order: [], entries: {} };
            var raw = localStorage.getItem(DARKWEB_DETAIL_CACHE_LS);
            if (!raw) return { order: [], entries: {} };
            var p = JSON.parse(raw);
            if (!p || typeof p !== 'object' || !p.entries) return { order: [], entries: {} };
            if (!Array.isArray(p.order)) p.order = [];
            return p;
        } catch (e) {
            return { order: [], entries: {} };
        }
    }

    function writeDarkwebDetailCacheStore(store) {
        if (typeof localStorage === 'undefined') return;
        try {
            localStorage.setItem(DARKWEB_DETAIL_CACHE_LS, JSON.stringify(store));
        } catch (e) {
            try {
                var st = store;
                var ord = (st.order || []).slice();
                var half = Math.max(1, Math.floor(ord.length / 2));
                for (var i = 0; i < half; i++) {
                    var k = ord.pop();
                    if (k && st.entries) delete st.entries[k];
                }
                st.order = ord;
                localStorage.setItem(DARKWEB_DETAIL_CACHE_LS, JSON.stringify(st));
            } catch (e2) {
                try {
                    localStorage.removeItem(DARKWEB_DETAIL_CACHE_LS);
                } catch (e3) {}
            }
        }
    }

    function getDarkwebDetailCache(key) {
        if (!key) return null;
        var st = readDarkwebDetailCacheStore();
        var e = st.entries && st.entries[key];
        if (!e || !isUsableDarkwebDetailCacheEntry(e.main, e.comments)) return null;
        return { main: e.main, comments: e.comments };
    }

    function saveDarkwebDetailCache(key, main, comments) {
        if (!key || !isUsableDarkwebDetailCacheEntry(main, comments)) return;
        var st = readDarkwebDetailCacheStore();
        st.order = st.order || [];
        st.entries = st.entries || {};
        st.entries[key] = { main: main, comments: comments, t: Date.now() };
        st.order = st.order.filter(function (k) {
            return k !== key;
        });
        st.order.unshift(key);
        while (st.order.length > DARKWEB_DETAIL_CACHE_MAX) {
            var rem = st.order.pop();
            if (rem) delete st.entries[rem];
        }
        writeDarkwebDetailCacheStore(st);
    }

    function migrateNavState(dw) {
        if (dw.navLevel) return;
        if (dw.currentView === 'detail') {
            dw.navLevel = 'detail';
        } else {
            dw.navLevel = 'hub';
        }
        if (dw.detailFromNav == null) dw.detailFromNav = 'hub';
    }

    function ensureState() {
        var state = getPhoneState();
        if (!state) return null;
        if (!state.friendDarkWeb) {
            state.friendDarkWeb = {
                feedKind: 'following',
                navLevel: 'hub',
                detailFromNav: 'hub',
                sidebarOpen: false,
                sidebarView: 'menu',
                detailHtml: '',
                detailPostHtml: '',
                detailCommentsHtml: '',
                detailPayload: null,
                loading: false
            };
        }
        if (state.friendDarkWeb.detailPostHtml == null) state.friendDarkWeb.detailPostHtml = '';
        if (state.friendDarkWeb.detailCommentsHtml == null) state.friendDarkWeb.detailCommentsHtml = '';
        migrateNavState(state.friendDarkWeb);
        return state.friendDarkWeb;
    }

    function getCharDarkwebAliasMap(profile) {
        var m = (profile && profile.charDarkwebAliasByFriendId) || null;
        if (m && typeof m === 'object' && !Array.isArray(m)) {
            return m;
        }
        return {};
    }

    /** 用户为当前 Char 在档案中保存的暗网代号（无保存则为空，表示用角色卡姓名）。 */
    function getUserSetCharDarkwebAlias(profile) {
        var fr = getFriend();
        if (!fr || fr.id == null) return '';
        var id = String(fr.id);
        var m = getCharDarkwebAliasMap(profile);
        if (m[id] == null) return '';
        return String(m[id]).trim();
    }

    function getRoleCardNameForDarkWebOnly() {
        var store = getModeStore();
        var fr = getFriend();
        if (!fr || !store || typeof store.resolveFriendAuthorRoleCardNameForDarkWeb !== 'function') {
            return '';
        }
        return String(store.resolveFriendAuthorRoleCardNameForDarkWeb(fr) || '').trim();
    }

    /** 论坛展示与未填代号时提示：先用户代号，再角色卡内姓名。 */
    function getResolvedCharDarkwebDisplayName(profile) {
        var custom = getUserSetCharDarkwebAlias(profile);
        if (custom) return custom;
        var card = getRoleCardNameForDarkWebOnly();
        if (card) return card;
        return '该机主';
    }

    function getForumPermissionLabel(profile) {
        var raw = String(profile && profile.level || '').trim();
        if (!raw || raw === '高级ID') return '最高等级';
        return raw;
    }

    function loadProfile() {
        var store = getModeStore();
        if (!store || typeof store.loadProfileByMode !== 'function') return null;
        return store.loadProfileByMode('darkweb') || null;
    }

    function saveProfile(profile) {
        var store = getModeStore();
        if (!store || typeof store.saveProfileByMode !== 'function') return;
        store.saveProfileByMode('darkweb', profile);
    }

    function maybeFixDarkWebProfileOwnerAlias() {
        if (!getFriend()) return;
        var f = getFriend();
        var fid = f.id != null ? String(f.id) : '';
        var profile = loadProfile() || {};
        var map = Object.assign({}, getCharDarkwebAliasMap(profile));
        var changed = false;
        if (String(profile.level || '').trim() === '高级ID') {
            profile.level = '最高等级';
            changed = true;
        }
        if (fid && map[fid] == null) {
            var leg = String(profile.displayName || '').trim();
            if (leg) {
                map[fid] = leg;
                profile.displayName = '';
                profile.charDarkwebAliasByFriendId = map;
                changed = true;
            }
        }
        var my = typeof global.safeReadJsonFromStorage === 'function' ? global.safeReadJsonFromStorage('myProfile', null) : null;
        var myNick = String(my && my.nickname || '').trim();
        if (myNick) {
            var disp = String(profile.displayName || '').trim();
            if (disp && disp === myNick) {
                profile.displayName = '';
                changed = true;
            }
        }
        if (changed) saveProfile(profile);
    }

    function loadFeeds() {
        var store = getModeStore();
        if (!store || typeof store.getFeedsByMode !== 'function') {
            return { following: '', forYou: '', entertainment: '', hub: '' };
        }
        var feeds = store.getFeedsByMode('darkweb') || {};
        if (feeds.hub == null) feeds.hub = '';
        return feeds;
    }

    function saveFeeds(feeds) {
        var store = getModeStore();
        if (!store || typeof store.saveFeedsByMode !== 'function') return;
        store.saveFeedsByMode('darkweb', feeds);
    }

    function aggressiveStripMarkdownFences(s) {
        var t = String(s || '');
        for (var j = 0; j < 4; j++) {
            t = t.replace(/(?:^|[\r\n])\s*```[a-zA-Z0-9]*\s*(?:$|[\r\n])/g, '\n');
        }
        for (var i = 0; i < 10; i++) {
            var next = t
                .replace(/^\s*```[a-zA-Z0-9]*\s*\r?\n?/m, '')
                .replace(/\r?\n?\s*```\s*$/m, '')
                .trim();
            if (next === t) break;
            t = next;
        }
        t = t.replace(/```[a-zA-Z0-9]*/g, '');
        return t.trim();
    }

    function sanitizeOutput(html) {
        var t = String(html || '').trim();
        if (!t) return '';
        if (typeof global.stripTwitterApiHtmlFence === 'function') t = global.stripTwitterApiHtmlFence(t);
        if (typeof global.sanitizeTwitterApiHtmlOutput === 'function') t = global.sanitizeTwitterApiHtmlOutput(t);
        t = aggressiveStripMarkdownFences(t);
        if (typeof global.normalizeTwitterHtmlString === 'function') t = global.normalizeTwitterHtmlString(t);
        if (/\b(?:Char|User|\{\{char\}\}|\{\{user\}\})\b/.test(t)) return '';
        return t;
    }

    /**
     * 解析单次 API 返回：必须含 .friend-darkweb-detail-api-main 与内层评论；失败时兜底整段作主楼。
     */
    function parseDarkwebDetailFullPageHtml(sanitized) {
        var s = String(sanitized || '').trim();
        if (!s) {
            return {
                main: '<div class="friend-darkweb-empty">内容为空</div>',
                comments: '<div class="friend-darkweb-empty">暂无评论</div>'
            };
        }
        var wrap = global.document.createElement('div');
        try {
            wrap.innerHTML = s;
        } catch (e) {
            return { main: s, comments: '<div class="friend-darkweb-empty">解析失败</div>' };
        }
        var mainHost = wrap.querySelector('.friend-darkweb-detail-api-main');
        var comHost = wrap.querySelector('.friend-darkweb-detail-api-comments');
        var mainInner = mainHost
            ? mainHost.innerHTML.trim()
            : '';
        var commentsInner = '';
        if (comHost) {
            var inner = comHost.querySelector('.friend-darkweb-comments-list-inner');
            commentsInner = inner ? inner.innerHTML.trim() : comHost.innerHTML.trim();
        }
        if (!commentsInner) {
            var loose = wrap.querySelector('.friend-darkweb-comments-list-inner');
            if (loose) commentsInner = loose.innerHTML.trim();
        }
        if (!mainInner) {
            var dmain = wrap.querySelector('.twitter-x-detail-root.friend-darkweb-detail-main, .friend-darkweb-detail-main');
            if (dmain) mainInner = dmain.outerHTML;
        }
        if (!mainInner) {
            mainInner = s;
        }
        if (!commentsInner) {
            commentsInner = '<div class="friend-darkweb-empty">暂无评论</div>';
        }
        return { main: mainInner, comments: commentsInner };
    }

    function renderRulesCard() {
        return '' +
            '<section class="friend-darkweb-rules-card">' +
            '  <div class="friend-darkweb-rules-title">论坛规则</div>' +
            '  <ul class="friend-darkweb-rules-list">' +
            '    <li>风向区仅限匿名闲谈，真假自辨，别把传闻当军令。</li>' +
            '    <li>深海区涉及权限分级与高价情报，未授权内容禁止外传。</li>' +
            '    <li>清扫区任务多为黑话委托，接单前先确认代价与回收线。</li>' +
            '    <li>截图、转存、泄露身份都会被清理，违规记录不另行通知。</li>' +
            '  </ul>' +
            '</section>';
    }

    function renderSectionEntryButtons() {
        return '' +
            '<div class="friend-darkweb-section-grid">' +
            '  <button type="button" class="friend-darkweb-section-entry" data-fapp="darkweb-open-section" data-kind="following">风向</button>' +
            '  <button type="button" class="friend-darkweb-section-entry" data-fapp="darkweb-open-section" data-kind="forYou">深海</button>' +
            '  <button type="button" class="friend-darkweb-section-entry" data-fapp="darkweb-open-section" data-kind="entertainment">清扫</button>' +
            '</div>';
    }

    /** 点击空白处关闭档案层（全屏轻遮罩，顶栏/底栏另设 z-index 可继续点） */
    function renderDarkwebSidebarScrimIfOpen(dw) {
        if (!dw || !dw.sidebarOpen) return '';
        return (
            '<div class="friend-darkweb-sidebar-scrim" data-fapp="darkweb-sidebar-dismiss" role="button" ' +
            '  tabindex="0" aria-label="关闭档案" title="点击关闭"></div>'
        );
    }

    function renderSidebar(profile, dw) {
        var mod =
            ' friend-darkweb-sidebar--' + (dw && dw.sidebarView === 'settings' ? 'settings' : 'menu');
        var cls = (dw.sidebarOpen ? ' friend-darkweb-sidebar-open' : '') + mod;
        var p = profile || {};
        var charAliasForm = escapeHtml(getUserSetCharDarkwebAlias(p));
        var cardRef = escapeHtml(
            getRoleCardNameForDarkWebOnly() || '（未从角色卡解析到姓名，请自填暗网代号）'
        );
        var bio = escapeHtml(String(p.bio || '该身份只在暗网流通，不与外部台面信息互通。').trim());
        if (dw.sidebarView === 'settings') {
            var rawLv = String(p.level || '').trim();
            if (!rawLv || rawLv === '高级ID') rawLv = '最高等级';
            var levelInput = escapeHtml(rawLv);
            return '' +
                '<aside class="friend-darkweb-sidebar' + cls + '">' +
                '  <div class="friend-darkweb-sidebar-head">身份设置</div>' +
                '  <label class="friend-darkweb-field friend-darkweb-field--char-alias">' +
                '    <span>Char 暗网代号</span>' +
                '    <input id="friend-darkweb-char-alias" type="text" maxlength="24" ' +
                '      placeholder="不填则使用角色卡内姓名" value="' + charAliasForm + '">' +
                '  </label>' +
                '  <p class="friend-darkweb-field-hint">与好友列表、备注及真名无关；不填写时，论坛与模型生成将统一使用角色卡中的姓名称呼。' +
                ' 当前角色卡参考名：<strong class="friend-darkweb-card-ref">' + cardRef + '</strong></p>' +
                '  <label class="friend-darkweb-field"><span>权限</span><input id="friend-darkweb-level" maxlength="24" value="' + levelInput + '"></label>' +
                '  <label class="friend-darkweb-field"><span>签名</span><textarea id="friend-darkweb-bio" maxlength="140">' + bio + '</textarea></label>' +
                '  <div class="friend-darkweb-sidebar-actions">' +
                '    <button type="button" class="friend-darkweb-mini-btn" data-fapp="darkweb-sidebar-home">返回</button>' +
                '    <button type="button" class="friend-darkweb-mini-btn friend-darkweb-mini-btn-primary" data-fapp="darkweb-settings-save">保存</button>' +
                '  </div>' +
                '</aside>';
        }
        var invadedCharName = escapeHtml(getResolvedCharDarkwebDisplayName(p));
        var permLabel = escapeHtml(getForumPermissionLabel(p));
        return '' +
            '<aside class="friend-darkweb-sidebar' + cls + '">' +
            '  <div class="friend-darkweb-sidebar-head">身份面板</div>' +
            '  <div class="friend-darkweb-id-card">' +
            '    <button type="button" class="friend-darkweb-id-alias friend-darkweb-id-alias--btn" data-fapp="darkweb-sidebar-settings" ' +
            '      title="设置 Char 在暗网论坛的代号（勿用真名/列表常用昵称）">' +
            '      <span class="friend-darkweb-id-alias-label">暗网代号</span>' +
            '      <span class="friend-darkweb-id-alias-value">' + invadedCharName + '</span>' +
            '      <span class="friend-darkweb-id-edit" aria-hidden="true">设置</span>' +
            '    </button>' +
            '    <div class="friend-darkweb-id-level">权限：' + permLabel + '</div>' +
            '    <div class="friend-darkweb-id-bio">' + bio + '</div>' +
            '  </div>' +
            '  <div class="friend-darkweb-sidebar-panels">' +
            '    <div class="friend-darkweb-sidebar-panel">' +
            '      <div class="friend-darkweb-sidebar-panel-title">工单</div>' +
            '      <div class="friend-darkweb-sidebar-panel-placeholder">占位：后续接入工单逻辑</div>' +
            '    </div>' +
            '    <div class="friend-darkweb-sidebar-panel">' +
            '      <div class="friend-darkweb-sidebar-panel-title">浏览</div>' +
            '      <div class="friend-darkweb-sidebar-panel-placeholder">占位：后续接入浏览逻辑</div>' +
            '    </div>' +
            '  </div>' +
            '  <button type="button" class="friend-darkweb-sidebar-link" data-fapp="darkweb-sidebar-settings">个人信息设置</button>' +
            '  <div class="friend-darkweb-sidebar-note">再次点击「档案」可收回侧栏。</div>' +
            '</aside>';
    }

    function renderEmptyHub() {
        return '<div class="friend-darkweb-empty">暂无首页热帖预览，点击右上角「刷新」生成 2～4 条热门帖。</div>';
    }

    function renderEmptySection(kind) {
        return '<div class="friend-darkweb-empty">当前「' + getFeedKindLabel(kind) + '」还没有内容，点击右上角「刷新」向模型生成帖子。</div>';
    }

    function renderHub(dw, profile, feeds) {
        var hubHtml = sanitizeOutput(feeds.hub || '');
        var contentHtml = hubHtml || renderEmptyHub();
        return '' +
            '<div class="friend-darkweb-shell friend-darkweb-shell-hub">' +
            '  <div class="friend-darkweb-topbar">' +
            '    <button type="button" class="friend-darkweb-mini-btn" data-fapp="darkweb-phone-back">返回</button>' +
            '    <div class="friend-darkweb-topbar-title">暗网论坛</div>' +
            '    <div class="friend-darkweb-top-actions">' +
            '      <button type="button" class="friend-darkweb-sidebar-toggle" data-fapp="darkweb-sidebar-toggle">档案</button>' +
            '      <button type="button" class="friend-darkweb-mini-btn friend-darkweb-mini-btn-primary" data-fapp="darkweb-refresh" title="刷新首页热帖">刷新</button>' +
            '    </div>' +
            '  </div>' +
            renderRulesCard() +
            '  <div class="friend-darkweb-content-wrap">' +
            '    <section class="friend-darkweb-feed" id="friend-darkweb-feed">' + contentHtml + '</section>' +
            '  </div>' +
            renderSectionEntryButtons() +
            renderDarkwebSidebarScrimIfOpen(dw) +
            renderSidebar(profile, dw) +
            '</div>';
    }

    function renderSection(dw, profile, feeds) {
        var secHtml = sanitizeOutput(feeds[dw.feedKind] || '');
        var contentHtml = secHtml || renderEmptySection(dw.feedKind);
        return '' +
            '<div class="friend-darkweb-shell">' +
            '  <div class="friend-darkweb-topbar">' +
            '    <button type="button" class="friend-darkweb-mini-btn" data-fapp="darkweb-back-to-hub">返回</button>' +
            '    <div class="friend-darkweb-topbar-title">' + escapeHtml(getFeedKindLabel(dw.feedKind)) + '</div>' +
            '    <div class="friend-darkweb-top-actions">' +
            '      <button type="button" class="friend-darkweb-sidebar-toggle" data-fapp="darkweb-sidebar-toggle">档案</button>' +
            '      <button type="button" class="friend-darkweb-mini-btn friend-darkweb-mini-btn-primary" data-fapp="darkweb-refresh" title="刷新本板块">刷新</button>' +
            '    </div>' +
            '  </div>' +
            '  <div class="friend-darkweb-content-wrap friend-darkweb-content-wrap-grow">' +
            '    <section class="friend-darkweb-feed" id="friend-darkweb-feed">' + contentHtml + '</section>' +
            '  </div>' +
            renderDarkwebSidebarScrimIfOpen(dw) +
            renderSidebar(profile, dw) +
            '</div>';
    }

    function renderDetail(dw) {
        var main = dw.detailPostHtml;
        if (!main || !String(main).trim()) {
            main = '<div class="friend-darkweb-empty">暂无主楼或正在加载…</div>';
        }
        var comments = typeof dw.detailCommentsHtml === 'string' ? dw.detailCommentsHtml : '';
        if (!String(comments).trim()) {
            comments = '<div class="friend-darkweb-empty friend-darkweb-comments-placeholder">正在加载或暂无评论</div>';
        }
        return '' +
            '<div class="friend-darkweb-detail-page">' +
            '  <div class="friend-darkweb-detail-bar">' +
            '    <button type="button" class="friend-darkweb-mini-btn" data-fapp="darkweb-detail-back">返回</button>' +
            '    <div class="friend-darkweb-detail-title">帖子详情</div>' +
            '    <button type="button" class="friend-darkweb-mini-btn friend-darkweb-mini-btn-primary" data-fapp="darkweb-detail-refresh-comments" title="仅刷新本页评论区">刷新</button>' +
            '  </div>' +
            '  <div class="friend-darkweb-detail-content" id="friend-darkweb-detail-content">' +
            '    <div class="friend-darkweb-detail-main-wrap" id="friend-darkweb-detail-main-wrap">' + main + '</div>' +
            '    <section class="friend-darkweb-comments-wrap" aria-label="评论">' +
            '      <div class="friend-darkweb-comments-heading">全部回复</div>' +
            '      <div class="friend-darkweb-comments-list" id="friend-darkweb-comments-list">' + comments + '</div>' +
            '    </section>' +
            '  </div>' +
            '</div>';
    }

    function renderMain(dw) {
        maybeFixDarkWebProfileOwnerAlias();
        var feeds = loadFeeds();
        var profile = loadProfile() || {};
        if (dw.navLevel === 'hub') return renderHub(dw, profile, feeds);
        if (dw.navLevel === 'section') return renderSection(dw, profile, feeds);
        return renderHub(dw, profile, feeds);
    }

    function renderCurrent() {
        var state = ensureState();
        if (!state) return;
        var host = global.document.getElementById('phone-friend-app-body');
        if (!host) return;
        host.innerHTML = state.navLevel === 'detail' ? renderDetail(state) : renderMain(state);
        var feedEl = host.querySelector('#friend-darkweb-feed');
        if (feedEl && typeof global.initTwitterFeedAfterInsert === 'function') {
            global.initTwitterFeedAfterInsert(feedEl);
        }
        var detEl = host.querySelector('#friend-darkweb-detail-content');
        if (detEl && typeof global.initTwitterFeedAfterInsert === 'function') {
            global.initTwitterFeedAfterInsert(detEl);
        }
        bindDynamic(host);
        bindDarkwebFeedClickCapture(host);
    }

    function getForumListFromFeed(scope) {
        if (!scope) return null;
        var fl = scope.querySelector('.friend-darkweb-forum-list');
        if (fl) return fl;
        var wrap = scope.querySelector('.tweet-container') || scope.querySelector('.twitter-feed-batch');
        if (wrap) return wrap;
        return scope;
    }

    /** 列表内点击是否视为暗网应用态（不依赖仅 appKind，且识别 #friend-darkweb-feed 存在时即认为在列表，避免 .friend-darkweb-shell 被改版后失效） */
    function isPhoneDarkwebListUiActive() {
        var st = getPhoneState();
        if (st && String(st.appKind || '') === 'darkweb') return true;
        try {
            var appView = global.document.getElementById('phone-view-app');
            if (!appView || !appView.classList.contains('phone-view-active')) return false;
            var body = global.document.getElementById('phone-friend-app-body');
            if (!body) return false;
            if (body.querySelector('.friend-darkweb-detail-page')) return false;
            if (body.querySelector('#friend-darkweb-feed')) {
                return true;
            }
            return !!body.querySelector('.friend-darkweb-shell');
        } catch (e) {
            return false;
        }
    }

    function isTopLevelThreadCardUnderList(list, el) {
        if (!el || !list) return false;
        if (!list.contains(el)) return false;
        if (el.classList && el.classList.contains('friend-darkweb-cfloor')) return false;
        if (!el.classList || !el.classList.contains('friend-darkweb-thread')) return false;
        var p = el.parentElement;
        while (p && p !== list) {
            if (p.classList && p.classList.contains('friend-darkweb-thread')) return false;
            p = p.parentElement;
        }
        return p === list;
    }

    /** 模型未带 friend-darkweb-thread 时，用「列表区直接子级」当帖卡（排除容器节点） */
    function isDarkwebListPostCardNode(el) {
        if (!el || el.nodeType !== 1) return false;
        var tag = el.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE' || tag === 'NAV') return false;
        if (el.classList) {
            if (el.classList.contains('friend-darkweb-cfloor')) return false;
            if (el.classList.contains('friend-darkweb-forum-list')) return false;
            if (el.classList.contains('tweet-container')) return false;
            if (el.classList.contains('twitter-feed-batch')) return false;
        }
        if (el.classList && (el.classList.contains('tweet') || el.classList.contains('friend-darkweb-thread'))) {
            return true;
        }
        if (tag === 'ARTICLE') {
            return ((el.textContent || '').replace(/\s+/g, ' ').trim().length > 20);
        }
        var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
        return t.length > 24 && t.length < 20000;
    }

    /**
     * 从事件目标向上找「列表帖」根节点。模型可能输出 article 或 div，只要带 .friend-darkweb-thread 即可。
     */
    function findDarkwebFeedListRowFromTarget(target) {
        if (!target) return null;
        var feed = global.document.getElementById('friend-darkweb-feed');
        if (!feed) return null;
        if (typeof target === 'string') return null;
        var tnode = target.nodeType === 3 ? target.parentElement : target;
        if (!tnode || !feed.contains(tnode)) return null;
        var list = getForumListFromFeed(feed);
        if (list && !list.contains(tnode)) return null;
        var scope = list || feed;
        if (typeof target.closest === 'function') {
            var n = tnode;
            while (n && n !== feed) {
                if (n.nodeType === 1) {
                    if (isTopLevelThreadCardUnderList(scope, n)) {
                        return n;
                    }
                }
                n = n.parentElement;
            }
            var rootTweet = target.closest('[data-twitter-thread-root="1"].tweet');
            if (rootTweet && feed.contains(rootTweet) && (!list || list.contains(rootTweet))) {
                if (!rootTweet.classList || !rootTweet.classList.contains('friend-darkweb-cfloor')) {
                    return rootTweet;
                }
            }
        }
        if (list) {
            var el = tnode;
            while (el) {
                if (el === list) break;
                if (el.parentNode === list && isDarkwebListPostCardNode(el)) {
                    return el;
                }
                el = el.parentElement;
            }
        }
        return null;
    }

    /**
     * 与 twitterEnsureFeedStructure 后 DOM 可能不一致时仍要能找到列表帖。
     * 取 .friend-darkweb-forum-list 下所有 .friend-darkweb-thread 顶层；回退 [data-twitter-thread-root="1"].tweet
     */
    function queryThreadRootsForBinding(scope) {
        if (!scope) return [];
        var list = getForumListFromFeed(scope);
        if (!list) {
            return Array.prototype.slice.call(scope.querySelectorAll('[data-twitter-thread-root="1"].tweet'), 0);
        }
        var all = list.querySelectorAll('.friend-darkweb-thread');
        var out = Array.prototype.filter.call(all, function (el) {
            return isTopLevelThreadCardUnderList(list, el);
        });
        if (out && out.length) {
            return out;
        }
        var byTweet = Array.prototype.slice.call(scope.querySelectorAll('[data-twitter-thread-root="1"].tweet'), 0);
        if (byTweet.length) {
            return byTweet;
        }
        var fromChildren = Array.prototype.filter.call(list.children, isDarkwebListPostCardNode);
        if (fromChildren.length) {
            return fromChildren;
        }
        return [];
    }

    function bindDynamic(host) {
        if (!host) return;
        var scope = host.querySelector('#friend-darkweb-feed');
        if (!scope) return;
        var roots = queryThreadRootsForBinding(scope);
        Array.prototype.forEach.call(roots, function (el) {
            if (el.dataset.friendDarkwebBound === '1') return;
            el.dataset.friendDarkwebBound = '1';
            if (!el.getAttribute('role')) el.setAttribute('role', 'button');
        });
    }

    /**
     * 在 #friend-darkweb-feed 上使用 capture 阶段监听，避免子节点 stopPropagation 或 WebView 冒泡链异常导致进不了详情。
     * 每次 render 后绑定在新 feed 上（旧 DOM 会随 innerHTML 丢弃）。
     */
    function bindDarkwebFeedClickCapture(host) {
        if (!host) return;
        var feed = host.querySelector('#friend-darkweb-feed');
        if (!feed) return;
        feed.addEventListener(
            'click',
            function (e) {
                if (!isPhoneDarkwebListUiActive()) return;
                var dw = ensureState();
                if (!dw || (dw.navLevel !== 'hub' && dw.navLevel !== 'section')) return;
                if (e.target && e.target.closest) {
                    var t = e.target;
                    if (t.closest('button, a[href]') && !findDarkwebFeedListRowFromTarget(t)) {
                        return;
                    }
                }
                var row = findDarkwebFeedListRowFromTarget(e.target);
                if (!row) return;
                var roots = queryThreadRootsForBinding(feed);
                var idx = Array.prototype.indexOf.call(roots, row);
                if (idx < 0) idx = 0;
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                openDetailFromElement(row, idx);
            },
            true
        );
    }

    function openApp() {
        var dw = ensureState();
        if (!dw) return;
        dw.navLevel = 'hub';
        dw.detailFromNav = 'hub';
        dw.sidebarOpen = false;
        dw.sidebarView = 'menu';
        renderCurrent();
    }

    async function refreshSectionInternal(kind) {
        var dw = ensureState();
        if (!dw || dw.loading) return;
        if (typeof global.CommandManager === 'undefined' || typeof global.CommandManager.buildDarkWebSendContent !== 'function') {
            notify('暗网生成器未就绪');
            return;
        }
        var fcm = getFeatureCommandMapper();
        if (!fcm) {
            notify('模型接口未就绪，请确认主程序已加载完成');
            return;
        }
        setDarkwebRefreshButtonsBusy(true);
        dw.loading = true;
        if (typeof global.showLoading === 'function') global.showLoading();
        try {
            var content = global.CommandManager.buildDarkWebSendContent(kind);
            var raw = await fcm.callApiModel(content, null, { skipOverlay: true, suppressErrorDialog: true });
            var html = sanitizeOutput(raw);
            if (!html) {
                notify('生成失败，请重试');
                return;
            }
            var feeds = loadFeeds();
            feeds[kind] = html;
            saveFeeds(feeds);
            renderCurrent();
            notify('已刷新「' + getFeedKindLabel(kind) + '」板块');
        } finally {
            dw.loading = false;
            if (typeof global.hideLoading === 'function') global.hideLoading();
            setDarkwebRefreshButtonsBusy(false);
        }
    }

    async function refreshHubInternal() {
        var dw = ensureState();
        if (!dw || dw.loading) return;
        if (typeof global.CommandManager === 'undefined' || typeof global.CommandManager.buildDarkWebHubSendContent !== 'function') {
            notify('暗网首页生成器未就绪');
            return;
        }
        var fcm = getFeatureCommandMapper();
        if (!fcm) {
            notify('模型接口未就绪，请确认主程序已加载完成');
            return;
        }
        setDarkwebRefreshButtonsBusy(true);
        dw.loading = true;
        if (typeof global.showLoading === 'function') global.showLoading();
        try {
            var content = global.CommandManager.buildDarkWebHubSendContent();
            var raw = await fcm.callApiModel(content, null, { skipOverlay: true, suppressErrorDialog: true });
            var html = sanitizeOutput(raw);
            if (!html) {
                notify('生成失败，请重试');
                return;
            }
            var feeds = loadFeeds();
            feeds.hub = html;
            saveFeeds(feeds);
            renderCurrent();
            notify('已刷新首页热帖');
        } finally {
            dw.loading = false;
            if (typeof global.hideLoading === 'function') global.hideLoading();
            setDarkwebRefreshButtonsBusy(false);
        }
    }

    async function refreshDetailCommentsOnly() {
        var dw = ensureState();
        if (!dw || dw.loading) return;
        if (dw.navLevel !== 'detail' || !dw.detailPayload) {
            notify('当前不在帖子详情页');
            return;
        }
        if (typeof global.CommandManager === 'undefined' || typeof global.CommandManager.buildDarkWebDetailCommentsSendContent !== 'function') {
            notify('评论生成器未就绪');
            return;
        }
        var fcm = getFeatureCommandMapper();
        if (!fcm) {
            notify('模型接口未就绪，请确认主程序已加载完成');
            return;
        }
        var mainEl = global.document.getElementById('friend-darkweb-detail-main-wrap');
        var postHtml = (mainEl && mainEl.innerHTML) ? String(mainEl.innerHTML) : String(dw.detailPostHtml || '');
        if (!String(postHtml).trim()) {
            notify('主楼未加载，无法生成评论');
            return;
        }
        var mainPlain = '';
        if (typeof global.twitterStripHtmlToPlain === 'function') {
            mainPlain = global.twitterStripHtmlToPlain(postHtml) || '';
        }
        setDarkwebRefreshButtonsBusy(true);
        dw.loading = true;
        if (typeof global.showLoading === 'function') global.showLoading();
        try {
            var listEl = global.document.getElementById('friend-darkweb-comments-list');
            if (listEl) {
                listEl.innerHTML = '<div class="friend-darkweb-empty">正在重新生成评论…</div>';
            }
            var content = global.CommandManager.buildDarkWebDetailCommentsSendContent(dw.detailPayload, {
                clickedIndex: dw.detailPayload._clickedIndex,
                mainBodyHtml: postHtml,
                mainBodyPlain: mainPlain
            });
            var raw = await fcm.callApiModel(content, null, { skipOverlay: true, suppressErrorDialog: true });
            var html = sanitizeOutput(raw);
            dw.detailCommentsHtml = html || '<div class="friend-darkweb-empty">评论生成失败，请重试</div>';
            dw.detailPostHtml = postHtml;
            if (isUsableDarkwebDetailCacheEntry(dw.detailPostHtml, dw.detailCommentsHtml)) {
                saveDarkwebDetailCache(computeDarkwebDetailCacheKey(dw.detailPayload, dw), dw.detailPostHtml, dw.detailCommentsHtml);
            }
            if (listEl) {
                listEl.innerHTML = dw.detailCommentsHtml;
                if (typeof global.initTwitterFeedAfterInsert === 'function') {
                    global.initTwitterFeedAfterInsert(listEl);
                }
            } else {
                renderCurrent();
            }
            notify('已刷新评论区');
        } finally {
            dw.loading = false;
            if (typeof global.hideLoading === 'function') global.hideLoading();
            setDarkwebRefreshButtonsBusy(false);
        }
    }

    async function refreshFeed() {
        var dw = ensureState();
        if (!dw || dw.loading) return;
        if (dw.navLevel === 'hub') {
            await refreshHubInternal();
            return;
        }
        if (dw.navLevel === 'detail') {
            await refreshDetailCommentsOnly();
            return;
        }
        await refreshSectionInternal(dw.feedKind);
    }

    function collectProfile() {
        var current = loadProfile() || {};
        var map = Object.assign({}, getCharDarkwebAliasMap(current));
        var fr = getFriend();
        if (fr && fr.id != null) {
            var el = global.document.getElementById('friend-darkweb-char-alias');
            var raw = el ? String(el.value).trim() : '';
            if (raw) {
                map[String(fr.id)] = raw;
            } else {
                delete map[String(fr.id)];
            }
        }
        var levelEl = global.document.getElementById('friend-darkweb-level');
        var bioEl = global.document.getElementById('friend-darkweb-bio');
        return {
            charDarkwebAliasByFriendId: map,
            level: String(levelEl && levelEl.value || '').trim() || '最高等级',
            bio: String(bioEl && bioEl.value || '').trim(),
            handle: String(current.handle || 'shadow_gate').trim(),
            joined: String(current.joined || '已接入离岸节点').trim()
        };
    }

    function saveProfileFromForm() {
        var current = loadProfile() || {};
        var profile = Object.assign({}, current, collectProfile());
        try {
            delete profile.displayName;
        } catch (e) {
            profile.displayName = '';
        }
        saveProfile(profile);
        var dw = ensureState();
        if (!dw) return;
        dw.sidebarView = 'menu';
        dw.sidebarOpen = true;
        renderCurrent();
        notify('身份信息已更新');
    }

    async function openDetailFromElement(tweetEl, clickedIndex) {
        if (!tweetEl) return;
        var dw = ensureState();
        if (!dw) return;
        var ext = getExtractTwitterTweetPayload();
        var payload = ext ? ext(tweetEl) : null;
        if (!payload) {
            notify('无法读取帖子信息（extractTwitterTweetPayload 未就绪）');
            return;
        }
        var friend = getFriend();
        if (friend) payload.friend = friend;
        payload._clickedIndex = clickedIndex;
        dw.detailFromNav = dw.navLevel === 'hub' ? 'hub' : 'section';
        if (dw.detailFromNav === 'section') {
            payload.darkWebSectionName = getFeedKindLabel(dw.feedKind);
        } else {
            payload.darkWebSectionName = '';
        }
        dw.navLevel = 'detail';
        dw.detailPayload = payload;
        var detailCacheKey = computeDarkwebDetailCacheKey(payload, dw);
        var cached = getDarkwebDetailCache(detailCacheKey);
        if (cached) {
            dw.detailPostHtml = cached.main;
            dw.detailCommentsHtml = cached.comments;
            renderCurrent();
            return;
        }
        dw.detailPostHtml = '<div class="friend-darkweb-empty">正在生成主楼与评论…</div>';
        dw.detailCommentsHtml = '<div class="friend-darkweb-empty">正在生成主楼与评论…</div>';
        renderCurrent();
        var buildMain =
            global.CommandManager && typeof global.CommandManager.buildDarkWebDetailMainSendContent === 'function'
                ? global.CommandManager.buildDarkWebDetailMainSendContent
                : null;
        var buildComments =
            global.CommandManager && typeof global.CommandManager.buildDarkWebDetailCommentsSendContent === 'function'
                ? global.CommandManager.buildDarkWebDetailCommentsSendContent
                : null;
        var buildFull = global.CommandManager && (
            typeof global.CommandManager.buildDarkWebDetailFullPageSendContent === 'function'
                ? global.CommandManager.buildDarkWebDetailFullPageSendContent
                : (typeof global.CommandManager.buildDarkWebDetailPageSendContent === 'function'
                    ? global.CommandManager.buildDarkWebDetailPageSendContent
                    : null)
        );
        if (typeof global.CommandManager === 'undefined' || (!(buildMain && buildComments) && !buildFull)) {
            dw.detailPostHtml = '<div class="friend-darkweb-empty">详情全页生成器未就绪</div>';
            dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
            renderCurrent();
            return;
        }
        var fcm = getFeatureCommandMapper();
        if (!fcm) {
            dw.detailPostHtml = '<div class="friend-darkweb-empty">模型接口未就绪，请确认主程序已加载完成</div>';
            dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
            renderCurrent();
            return;
        }
        dw.loading = true;
        if (typeof global.showLoading === 'function') global.showLoading();
        try {
            if (buildMain && buildComments) {
                var mainContent = buildMain.call(global.CommandManager, payload, { clickedIndex: clickedIndex });
                if (!mainContent) {
                    dw.detailPostHtml = '<div class="friend-darkweb-empty">无法构造主楼任务</div>';
                    dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
                    renderCurrent();
                    return;
                }
                var mainRaw = await fcm.callApiModel(mainContent, null, {
                    skipOverlay: true,
                    suppressErrorDialog: true
                });
                var mainSan = sanitizeOutput(mainRaw);
                if (!mainSan) {
                    dw.detailPostHtml =
                        '<div class="friend-darkweb-empty">主楼与评论生成失败或触发了敏感过滤，请返回后重试</div>';
                    dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
                    renderCurrent();
                    return;
                }
                var mainSplit = parseDarkwebDetailFullPageHtml(mainSan);
                var postHtml = mainSplit.main || '<div class="friend-darkweb-empty">主楼解析为空</div>';
                var mainPlain = '';
                if (typeof global.twitterStripHtmlToPlain === 'function') {
                    mainPlain = global.twitterStripHtmlToPlain(postHtml) || '';
                }
                dw.detailPostHtml = postHtml;
                dw.detailCommentsHtml = '<div class="friend-darkweb-empty">正在生成评论…</div>';
                renderCurrent();

                var comContent = buildComments.call(global.CommandManager, payload, {
                    clickedIndex: clickedIndex,
                    mainBodyHtml: postHtml,
                    mainBodyPlain: mainPlain
                });
                if (!comContent) {
                    dw.detailCommentsHtml =
                        '<div class="friend-darkweb-empty">评论区任务构造异常，请点本页「刷新」重试</div>';
                    saveDarkwebDetailCache(detailCacheKey, dw.detailPostHtml, dw.detailCommentsHtml);
                    renderCurrent();
                    return;
                }
                var comRaw = await fcm.callApiModel(comContent, null, {
                    skipOverlay: true,
                    suppressErrorDialog: true
                });
                var comSan = sanitizeOutput(comRaw);
                if (!comSan) {
                    dw.detailCommentsHtml =
                        '<div class="friend-darkweb-empty">评论区超时或敏感过滤，请点本页「刷新」重试</div>';
                    notify('若评论区空白，可点本页「刷新」仅重试评论');
                } else {
                    dw.detailCommentsHtml = comSan;
                }
                saveDarkwebDetailCache(detailCacheKey, dw.detailPostHtml, dw.detailCommentsHtml);
                renderCurrent();
                return;
            }
            if (!buildFull) {
                dw.detailPostHtml = '<div class="friend-darkweb-empty">详情全页生成器未就绪</div>';
                dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
                renderCurrent();
                return;
            }
            var fullContent = buildFull.call(global.CommandManager, payload, { clickedIndex: clickedIndex });
            if (!fullContent) {
                dw.detailPostHtml = '<div class="friend-darkweb-empty">无法构造详情任务</div>';
                dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
                renderCurrent();
                return;
            }
            var fullRaw = await fcm.callApiModel(fullContent, null, {
                skipOverlay: true,
                suppressErrorDialog: true
            });
            var fullSan = sanitizeOutput(fullRaw);
            if (!fullSan) {
                dw.detailPostHtml = '<div class="friend-darkweb-empty">主楼与评论生成失败或触发了敏感过滤，请返回后重试</div>';
                dw.detailCommentsHtml = '<div class="friend-darkweb-empty">—</div>';
                renderCurrent();
                return;
            }
            var split = parseDarkwebDetailFullPageHtml(fullSan);
            dw.detailPostHtml = split.main || '<div class="friend-darkweb-empty">主楼解析为空</div>';
            dw.detailCommentsHtml = split.comments || '<div class="friend-darkweb-empty">评论生成失败，请点刷新重试</div>';
            saveDarkwebDetailCache(detailCacheKey, dw.detailPostHtml, dw.detailCommentsHtml);
            renderCurrent();
        } finally {
            dw.loading = false;
            if (typeof global.hideLoading === 'function') global.hideLoading();
        }
    }

    function handleAction(act, el) {
        var dw = ensureState();
        if (!dw) return false;
        if (act === 'darkweb-phone-back') {
            if (typeof global.phonePageHeaderBack === 'function') global.phonePageHeaderBack();
            return true;
        }
        if (act === 'darkweb-back-to-hub') {
            dw.navLevel = 'hub';
            dw.sidebarView = 'menu';
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-open-section') {
            dw.feedKind = String(el.getAttribute('data-kind') || 'following');
            dw.navLevel = 'section';
            dw.sidebarView = 'menu';
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-refresh') {
            refreshFeed();
            return true;
        }
        if (act === 'darkweb-sidebar-toggle') {
            if (dw.sidebarOpen && dw.sidebarView === 'menu') {
                dw.sidebarOpen = false;
            } else {
                dw.sidebarOpen = true;
                dw.sidebarView = 'menu';
            }
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-sidebar-dismiss') {
            dw.sidebarOpen = false;
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-sidebar-settings') {
            dw.sidebarOpen = true;
            dw.sidebarView = 'settings';
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-sidebar-home') {
            dw.sidebarView = 'menu';
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-settings-save') {
            saveProfileFromForm();
            return true;
        }
        if (act === 'darkweb-detail-back') {
            dw.navLevel = dw.detailFromNav === 'hub' ? 'hub' : 'section';
            renderCurrent();
            return true;
        }
        if (act === 'darkweb-open-detail') {
            var tweetEl = el.closest('.tweet');
            var idx = Number(el.getAttribute('data-index') || '0');
            openDetailFromElement(tweetEl, idx);
            return true;
        }
        if (act === 'darkweb-detail-refresh-comments') {
            refreshDetailCommentsOnly();
            return true;
        }
        return false;
    }

    global.FriendDarkWeb = {
        openApp: openApp,
        refreshFeed: refreshFeed,
        refreshDetailCommentsOnly: refreshDetailCommentsOnly,
        handleAction: handleAction,
        renderCurrent: renderCurrent,
        setRefreshButtonsBusy: setDarkwebRefreshButtonsBusy
    };
})(window);
