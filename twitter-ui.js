/**
 * Lego 小手机 · 推特/X — UI 与事件（阶段 2）
 *
 * 仅操作 DOM；时间轴与资料经 Twitter.store。依赖 app.js：CommandManager、FeatureCommandMapper、
 * showNotification、loadFriendsFromStorage、safeReadJsonFromStorage、compressImageDataUrl、
 * escHtml（若全局无则本文件末尾定义）、twitterResolveFriendAuthorDisplayName / twitterExtractRoleCardDisplayName。
 *
 * 加载顺序：twitter-store.js → app.js → twitter-ui.js
 */
(function (global) {
    'use strict';

    function s() {
        return global.Twitter && global.Twitter.store;
    }
    function loadTwitterProfile() { return s().loadTwitterProfile(); }
    function getTwitterFeedsFromStorage() { return s().getTwitterFeedsFromStorage(); }
    function saveTwitterFeedsToStorage(feeds) { return s().saveTwitterFeedsToStorage(feeds); }
    function loadTwitterFollowingFriendIdListRaw() { return s().loadTwitterFollowingFriendIdListRaw(); }
    function saveTwitterFollowingFriendIdList(ids) { return s().saveTwitterFollowingFriendIdList(ids); }
    function getTwitterFollowingSelectedCount() { return s().getTwitterFollowingSelectedCount(); }
    function loadTwitterUserPosts() { return s().loadTwitterUserPosts(); }
    function getTwitterUserPostById(postId) { return s().getTwitterUserPostById(postId); }
    function upsertTwitterUserPost(post) { return s().upsertTwitterUserPost(post); }
    function appendTwitterUserPostComments(postId, comments) { return s().appendTwitterUserPostComments(postId, comments); }
    function parseTwitterJoinedParts(j) { return s().parseTwitterJoinedParts(j); }
    function twitterDeriveHandleFromDisplayName(a, b) { return s().twitterDeriveHandleFromDisplayName(a, b); }
    function defaultTwitterFriendHandle(f) { return s().defaultTwitterFriendHandle(f); }
    function twitterNormalizeKeyLoose(x) { return s().twitterNormalizeKeyLoose(x); }
    function twitterAddFriendToTweetHandleMap(m, f) { return s().twitterAddFriendToTweetHandleMap(m, f); }
    function twitterLookupFriendInHandleMap(m, k) { return s().twitterLookupFriendInHandleMap(m, k); }
    function getEffectiveTwitterUserHandle(p) { return s().getEffectiveTwitterUserHandle(p); }
    function twitterStripHtmlToPlain(h) { return s().twitterStripHtmlToPlain(h); }
    function twitterAppendDetailExtraHtml(a, b) { return s().twitterAppendDetailExtraHtml(a, b); }
    function twitterApplyDetailExtraHtml(el, k) { return s().twitterApplyDetailExtraHtml(el, k); }
    function twitterSetDetailPageContext(p, k) { return s().twitterSetDetailPageContext(p, k); }
    function _twitterDetailCacheKey(p, i) { return s().twitterDetailCacheKey(p, i); }
    var TWITTER_FRIEND_HANDLE_PREFIX = s().TWITTER_FRIEND_HANDLE_PREFIX;

function getCurrentTwitterFeedKind() {
    const activeTab = document.querySelector('.twitter-feed-tab.active');
    return activeTab ? (activeTab.dataset.twitterFeedTab || 'forYou') : 'forYou';
}

function switchTwitterFeedTab(feedKind) {
    document.querySelectorAll('.twitter-feed-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.twitterFeedTab === feedKind);
    });
    document.querySelectorAll('.twitter-feed-panel').forEach(panel => {
        panel.classList.toggle('active', panel.dataset.feed === feedKind);
    });
}

function switchTwitterBottomTab(view) {
    document.querySelectorAll('.twitter-bottom-btn').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.twitterBottom === view);
    });
    document.querySelectorAll('.twitter-view').forEach(vw => {
        const isActive = vw.dataset.twitterView === view;
        vw.classList.toggle('twitter-view-active', isActive);
        vw.hidden = !isActive;
    });
    if (view === 'profile') refreshTwitterProfileUI();
    toggleTwitterComposeButton(view);
}

function switchTwitterProfileSubTab(subTab) {
    document.querySelectorAll('.twitter-profile-tab').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.profileTab === subTab);
    });
    document.querySelectorAll('.twitter-profile-tab-panel').forEach(panel => {
        const isActive = panel.dataset.profilePanel === subTab;
        panel.classList.toggle('active', isActive);
        panel.hidden = !isActive;
    });
}

function toggleTwitterComposeButton(viewOpt) {
    const btn = document.getElementById('twitter-compose-fab');
    if (!btn) return;
    const view = viewOpt || (document.querySelector('.twitter-view.twitter-view-active')?.dataset.twitterView || 'home');
    btn.hidden = !(view === 'home' || view === 'profile');
}

function twitterGetCurrentUserIdentity() {
    const twProfile = loadTwitterProfile() || {};
    const myProfile = safeReadJsonFromStorage('myProfile', null);
    const userInfo = safeReadJsonFromStorage('userInfo', null);
    const displayName = twProfile.displayName || (myProfile && myProfile.nickname) || '用户';
    const handle = getEffectiveTwitterUserHandle(twProfile);
    const avatarSrc = twProfile.avatarDataUrl || (userInfo && userInfo.avatar) || '';
    return {
        displayName,
        handle,
        avatarSrc,
        letter: (displayName.charAt(0) || '我').toUpperCase()
    };
}

function twitterBuildCurrentUserAvatarHtml(sizeClass) {
    const user = twitterGetCurrentUserIdentity();
    if (user.avatarSrc) {
        return '<div class="' + sizeClass + '"><img src="' + escHtml(user.avatarSrc) + '" alt=""></div>';
    }
    return '<div class="' + sizeClass + ' ' + sizeClass + '--ph">' + escHtml(user.letter) + '</div>';
}

function twitterFormatRelativeTime(ts) {
    const diffMs = Math.max(0, Date.now() - (Number(ts) || Date.now()));
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return '刚刚';
    if (mins < 60) return mins + '分钟前';
    const hours = Math.floor(mins / 60);
    if (hours < 24) return hours + '小时前';
    const days = Math.floor(hours / 24);
    if (days < 30) return days + '天前';
    return Math.floor(days / 30) + '个月前';
}

function twitterRenderUserProfilePanels() {
    const postsPanel = document.getElementById('twitter-profile-panel-posts');
    const repliesPanel = document.getElementById('twitter-profile-panel-replies');
    if (!postsPanel && !repliesPanel) return;
    const posts = loadTwitterUserPosts();
    if (postsPanel) {
        if (!posts.length) {
            postsPanel.innerHTML = '<p class="twitter-profile-empty">你还没有发布过帖子</p>';
        } else {
            postsPanel.innerHTML = posts.map(twitterBuildUserPostCardHtml).join('');
        }
    }
    if (repliesPanel) {
        const replyRows = [];
        posts.forEach(post => {
            (post.comments || []).forEach(comment => {
                if (comment.role === 'user') {
                    replyRows.push({ post: post, comment: comment });
                }
            });
        });
        replyRows.sort((a, b) => (b.comment.createdAt || 0) - (a.comment.createdAt || 0));
        if (!replyRows.length) {
            repliesPanel.innerHTML = '<p class="twitter-profile-empty">你还没有发过回复</p>';
        } else {
            repliesPanel.innerHTML = replyRows.map(twitterBuildUserReplyActivityHtml).join('');
        }
    }
}

function twitterBuildUserPostCardHtml(post) {
    const user = twitterGetCurrentUserIdentity();
    const commentCount = Math.max(0, Number(post.commentCountBase) || 0) + (Array.isArray(post.comments) ? post.comments.length : 0);
    const avatarHtml = user.avatarSrc
        ? '<div class="twitter-user-post-avatar"><img src="' + escHtml(user.avatarSrc) + '" alt=""></div>'
        : '<div class="twitter-user-post-avatar twitter-user-post-avatar--ph">' + escHtml(user.letter) + '</div>';
    return (
        '<article class="twitter-user-post-card" data-twitter-user-post-id="' + escHtml(post.id) + '">' +
        avatarHtml +
        '<div class="twitter-user-post-main">' +
        '<div class="twitter-user-post-header"><span class="twitter-user-post-name">' + escHtml(user.displayName) + '</span><span class="twitter-user-post-handle">@' + escHtml(user.handle) + ' · ' + escHtml(twitterFormatRelativeTime(post.createdAt)) + '</span></div>' +
        '<div class="twitter-user-post-text">' + escHtml(post.text || '').replace(/\n/g, '<br>') + '</div>' +
        '<div class="twitter-user-post-meta"><span>💬 ' + commentCount + '</span><span>🔄 ' + Math.max(0, Number(post.repostCount) || 0) + '</span><span>❤️ ' + Math.max(0, Number(post.likeCount) || 0) + '</span><span>👁 ' + Math.max(0, Number(post.viewCount) || 0) + '</span></div>' +
        '</div>' +
        '</article>'
    );
}

function twitterBuildUserReplyActivityHtml(item) {
    const post = item.post;
    const comment = item.comment;
    return (
        '<article class="twitter-user-reply-activity" data-twitter-user-post-id="' + escHtml(post.id) + '">' +
        '<div class="twitter-user-reply-label">回复了评论</div>' +
        '<div class="twitter-user-reply-text">' + escHtml(comment.text || '') + '</div>' +
        '<div class="twitter-user-reply-origin">原帖：' + escHtml((post.text || '').slice(0, 100) || '（无正文）') + '</div>' +
        '</article>'
    );
}

function twitterBuildLocalDetailCommentRow(comment) {
    const user = twitterGetCurrentUserIdentity();
    const isUser = comment.role === 'user';
    let avatarHtml = '';
    if (isUser) {
        avatarHtml = user.avatarSrc
            ? '<div class="tweet-avatar-wrap twitter-user-post-comment-avatar"><img src="' + escHtml(user.avatarSrc) + '" alt=""></div>'
            : '<div class="tweet-avatar-wrap twitter-user-post-comment-avatar">' + escHtml(user.letter) + '</div>';
    } else {
        const friend = comment.friendId ? loadFriendsFromStorage().find(function (f) { return String(f.id) === String(comment.friendId); }) : null;
        const avatar = friend
            ? (typeof getFirstUsableAvatarUrl === 'function'
                ? getFirstUsableAvatarUrl(friend.avatar, friend.chatAvatar, friend.persona && friend.persona.avatar)
                : (normalizeAvatarUrl(friend.avatar) || normalizeAvatarUrl(friend.chatAvatar) || normalizeAvatarUrl(friend.persona && friend.persona.avatar) || ''))
            : '';
        const letter = ((comment.authorName || '友').charAt(0) || '友').toUpperCase();
        avatarHtml = avatar
            ? '<div class="tweet-avatar-wrap twitter-user-post-comment-avatar"><img src="' + escHtml(avatar) + '" alt=""></div>'
            : '<div class="tweet-avatar-wrap twitter-user-post-comment-avatar">' + escHtml(letter) + '</div>';
    }
    const displayName = isUser ? user.displayName : (comment.authorName || '好友');
    const handle = isUser ? user.handle : (comment.handle || '');
    const replyTo = comment.replyToAuthorName ? '<div class="twitter-user-post-comment-replyto">回复 @' + escHtml(comment.replyToAuthorName) + '</div>' : '';
    const friendAttr = !isUser && comment.friendId ? ' data-friend-id="' + escHtml(comment.friendId) + '"' : '';
    const roleAttr = ' data-comment-role="' + (isUser ? 'user' : 'friend') + '"';
    return (
        '<div class="tweet-reply twitter-x-reply twitter-user-post-comment-row" data-comment-id="' + escHtml(comment.id) + '"' + friendAttr + roleAttr + ' style="display:flex;gap:10px;align-items:flex-start;padding:10px 0 10px 60px;border-top:1px solid #eff3f4;">' +
        avatarHtml +
        '<div style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;">' +
        '<span class="tweet-name" style="font-weight:700;font-size:14px;color:#0f1419;">' + escHtml(displayName) + '</span>' +
        '<span class="tweet-handle" style="font-size:13px;color:#536471;">' + (handle ? '@' + escHtml(String(handle).replace(/^@/, '')) + ' · ' : '') + escHtml(twitterFormatRelativeTime(comment.createdAt)) + '</span>' +
        '</div>' +
        replyTo +
        '<div class="tweet-text" style="margin-top:2px;font-size:14px;line-height:1.45;color:#0f1419;">' + escHtml(comment.text || '').replace(/\n/g, '<br>') + '</div>' +
        '</div>' +
        '</div>'
    );
}

function twitterBuildUserPostDetailHtml(post) {
    const user = twitterGetCurrentUserIdentity();
    const avatarHtml = user.avatarSrc
        ? '<div class="tweet-avatar-wrap twitter-user-post-detail-avatar"><img src="' + escHtml(user.avatarSrc) + '" alt=""></div>'
        : '<div class="tweet-avatar-wrap twitter-user-post-detail-avatar">' + escHtml(user.letter) + '</div>';
    const comments = Array.isArray(post.comments) ? post.comments : [];
    return (
        '<div class="twitter-x-detail-root twitter-user-post-detail-root" data-twitter-user-post-id="' + escHtml(post.id) + '">' +
        '<article class="tweet twitter-user-post-detail-tweet" style="display:flex;gap:12px;align-items:flex-start;padding:12px 0;border-bottom:1px solid #cdd0d4;">' +
        avatarHtml +
        '<div class="tweet-main" style="flex:1;min-width:0;">' +
        '<div style="display:flex;align-items:center;gap:4px;flex-wrap:wrap;"><span class="tweet-name" style="font-weight:700;font-size:15px;color:#0f1419;">' + escHtml(user.displayName) + '</span><span class="tweet-handle" style="font-size:14px;color:#536471;">@' + escHtml(user.handle) + ' · ' + escHtml(twitterFormatRelativeTime(post.createdAt)) + '</span></div>' +
        '<div class="tweet-text" style="margin-top:4px;font-size:15px;line-height:1.5;color:#0f1419;">' + escHtml(post.text || '').replace(/\n/g, '<br>') + '</div>' +
        '</div>' +
        '</article>' +
        '<div class="twitter-user-post-detail-comments">' +
        (comments.length
            ? comments.map(twitterBuildLocalDetailCommentRow).join('')
            : '<div class="twitter-user-post-detail-empty">好友留言生成后会显示在这里</div>') +
        '</div>' +
        '</div>'
    );
}

function openTwitterUserPostDetail(postId) {
    const post = getTwitterUserPostById(postId);
    const detailPage = document.getElementById('twitter-detail-page');
    const detailContent = document.getElementById('twitter-detail-content');
    if (!post || !detailPage || !detailContent) return;
    try {
        if (window.__twitterDetailAbort && typeof window.__twitterDetailAbort.abort === 'function') {
            window.__twitterDetailAbort.abort();
        }
    } catch (e) {}
    window.__twitterDetailAbort = null;
    window.__twitterUserPostContext = { postId: String(post.id) };
    window.__twitterReplyParentHint = '';
    window.__twitterReplyTargetCommentId = '';
    window.__twitterReplyTargetFriendId = '';
    window.__twitterDetailPayload = { textHtml: escHtml(post.text || '').replace(/\n/g, '<br>') };
    window.__twitterDetailCacheKey = '';
    window.__twitterDetailFriend = null;
    detailPage.classList.add('show');
    detailContent.innerHTML = twitterBuildUserPostDetailHtml(post);
    twitterPrepareTwitterDetailBody(detailContent);
    initTwitterCommentBar();
    const input = document.getElementById('twitter-comment-input');
    if (input) input.placeholder = '回复评论…';
}

function refreshTwitterUserPostDetailIfOpen(postId) {
    const ctx = window.__twitterUserPostContext;
    if (!ctx || String(ctx.postId || '') !== String(postId || '')) return;
    openTwitterUserPostDetail(postId);
    const detailContent = document.getElementById('twitter-detail-content');
    if (detailContent) detailContent.scrollTop = detailContent.scrollHeight;
}

/** 首次打开编辑弹窗时填充年/月/日下拉选项 */
function ensureTwitterJoinedSelectsPopulated() {
    const ySel = document.getElementById('twitter-edit-joined-year');
    const mSel = document.getElementById('twitter-edit-joined-month');
    const dSel = document.getElementById('twitter-edit-joined-day');
    if (!ySel || !mSel || !dSel) return;
    if (ySel.options.length > 0) return;
    const now = new Date();
    const startY = 2005;
    const endY = now.getFullYear() + 2;
    for (let y = startY; y <= endY; y++) {
        const o = document.createElement('option');
        o.value = String(y);
        o.textContent = y + '年';
        ySel.appendChild(o);
    }
    for (let m = 1; m <= 12; m++) {
        const o = document.createElement('option');
        o.value = String(m);
        o.textContent = m + '月';
        mSel.appendChild(o);
    }
    for (let d = 1; d <= 31; d++) {
        const o = document.createElement('option');
        o.value = String(d);
        o.textContent = d + '日';
        dSel.appendChild(o);
    }
}

function refreshTwitterProfileUI() {
    const profile = loadTwitterProfile() || {};
    let mainAvatar = '';
    let mainBg = '';
    try {
        mainAvatar = localStorage.getItem('userAvatar') || '';
        mainBg = localStorage.getItem('backgroundImage') || '';
    } catch (e) {}
    const avatarDataUrl = (profile.avatarDataUrl && String(profile.avatarDataUrl).trim()) || mainAvatar || '';
    const bannerDataUrl = (profile.bannerDataUrl && String(profile.bannerDataUrl).trim()) || mainBg || '';
    const name = profile.displayName || '用户';
    const handle = '@' + getEffectiveTwitterUserHandle(profile);
    const bio = profile.bio || '';
    const joined = profile.joined || new Date().getFullYear() + '年3月 加入';
    const letter = (name.charAt(0) || '我').toUpperCase();
    const byId = (id) => document.getElementById(id);
    if (byId('twitter-profile-display-name')) byId('twitter-profile-display-name').textContent = name;
    if (byId('twitter-profile-handle-text')) byId('twitter-profile-handle-text').textContent = handle;
    if (byId('twitter-profile-bio')) {
        byId('twitter-profile-bio').textContent = bio;
        byId('twitter-profile-bio').style.display = bio ? '' : 'none';
    }
    if (byId('twitter-profile-joined-label')) byId('twitter-profile-joined-label').textContent = joined;
    if (byId('twitter-profile-joined')) byId('twitter-profile-joined').style.display = '';
    if (byId('twitter-stat-following')) byId('twitter-stat-following').textContent = String(getTwitterFollowingSelectedCount());
    if (byId('twitter-stat-followers')) byId('twitter-stat-followers').textContent = profile.followers || 0;
    if (byId('twitter-profile-avatar-letter')) byId('twitter-profile-avatar-letter').textContent = letter;
    if (byId('twitter-profile-banner')) {
        const ban = byId('twitter-profile-banner');
        if (bannerDataUrl) {
            ban.style.background = '';
            ban.style.backgroundColor = 'transparent';
            ban.style.backgroundImage = 'url(' + JSON.stringify(bannerDataUrl) + ')';
            ban.style.backgroundSize = 'cover';
            ban.style.backgroundPosition = 'center';
        } else {
            ban.style.backgroundImage = '';
            ban.style.background = '';
            ban.style.backgroundColor = profile.bannerColor || '#1d9bf0';
        }
    }
    if (byId('twitter-profile-avatar-img') && byId('twitter-profile-avatar-letter')) {
        if (avatarDataUrl) {
            byId('twitter-profile-avatar-img').src = avatarDataUrl;
            byId('twitter-profile-avatar-img').hidden = false;
            byId('twitter-profile-avatar-letter').hidden = true;
        } else {
            byId('twitter-profile-avatar-img').src = '';
            byId('twitter-profile-avatar-img').hidden = true;
            byId('twitter-profile-avatar-letter').hidden = false;
        }
    }
    twitterRenderUserProfilePanels();
}

/* ── 推特「正在关注」好友选择器 ───────────────────────────── */
function openTwitterFollowingPicker() {
    const modal = document.getElementById('twitter-following-picker-modal');
    const list = document.getElementById('twitter-following-picker-list');
    const empty = document.getElementById('twitter-following-picker-empty');
    if (!modal || !list) return;

    const allFriends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
    const selectedIds = new Set(loadTwitterFollowingFriendIdListRaw() || allFriends.map(f => String(f.id)));
    window.__twitterFollowingPickerState = selectedIds;

    if (!allFriends.length) {
        list.innerHTML = '';
        if (empty) empty.style.display = '';
        return;
    }
    if (empty) empty.style.display = 'none';

    list.innerHTML = '';
    allFriends.forEach(f => {
        const isSelected = selectedIds.has(String(f.id));
        const av = typeof getFirstUsableAvatarUrl === 'function'
            ? getFirstUsableAvatarUrl(f.avatar, f.persona && f.persona.avatar, f.chatAvatar)
            : (normalizeAvatarUrl(f.avatar) || normalizeAvatarUrl(f.persona && f.persona.avatar) || normalizeAvatarUrl(f.chatAvatar) || '');
        const avUsable = /^(https?:|data:image|blob:)/i.test(av);
        const handle = defaultTwitterFriendHandle(f);
        const displayName = (f.remark || f.nickname || '好友').trim() || '好友';
        const item = document.createElement('button');
        item.type = 'button';
        item.className = 'twitter-following-picker-item' + (isSelected ? ' selected' : '');
        item.dataset.friendId = String(f.id);
        item.setAttribute('aria-pressed', String(isSelected));
        item.onclick = function () {
            const fid = String(f.id);
            if (window.__twitterFollowingPickerState.has(fid)) {
                window.__twitterFollowingPickerState.delete(fid);
                item.classList.remove('selected');
                item.setAttribute('aria-pressed', 'false');
            } else {
                window.__twitterFollowingPickerState.add(fid);
                item.classList.add('selected');
                item.setAttribute('aria-pressed', 'true');
            }
        };
        const avatarColor = ['#1d9bf0','#7856ff','#e0245e','#17bf63','#ffad1f'][Math.abs(f.id) % 5];
        const letter = displayName.charAt(0).toUpperCase();
        item.innerHTML =
            '<div class="twitter-following-picker-avatar">' +
                (avUsable
                    ? `<img src="${Moments.store.escapeAttrUrl(av)}" alt="" class="avatar-letter" style="object-fit:cover;">`
                    : `<div class="avatar-letter" style="background:${avatarColor}">${escHtml(letter)}</div>`) +
                '<div class="twitter-following-picker-check">' +
                    '<svg viewBox="0 0 12 12"><path d="M10 3L4.5 8.5 2 6"/></svg>' +
                '</div>' +
            '</div>' +
            '<div class="twitter-following-picker-info">' +
                `<div class="twitter-following-picker-name">${escHtml(displayName)}</div>` +
                `<div class="twitter-following-picker-handle">@${escHtml(handle)}</div>` +
            '</div>';
        list.appendChild(item);
    });

    modal.classList.add('show');
}

function saveTwitterFollowingPicker() {
    const ids = Array.from(window.__twitterFollowingPickerState || []);
    saveTwitterFollowingFriendIdList(ids);
    const count = getTwitterFollowingSelectedCount();
    const statEl = document.getElementById('twitter-stat-following');
    if (statEl) statEl.textContent = String(count);
    closeTwitterFollowingPicker();
    showNotification(ids.length > 0 ? `已保存 ${ids.length} 位关注好友` : '已取消全部关注');
}

function closeTwitterFollowingPicker() {
    const modal = document.getElementById('twitter-following-picker-modal');
    if (modal) modal.classList.remove('show');
    window.__twitterFollowingPickerState = null;
}

function openTwitterProfileEdit() {
    ensureTwitterJoinedSelectsPopulated();
    const profile = loadTwitterProfile() || {};
    const dnEl = document.getElementById('twitter-edit-display-name');
    const bioEl = document.getElementById('twitter-edit-bio');
    const hHidden = document.getElementById('twitter-edit-handle');
    const hHint = document.getElementById('twitter-edit-handle-hint');
    if (dnEl) dnEl.value = profile.displayName || '';
    if (bioEl) bioEl.value = profile.bio || '';
    const rawHandle = getEffectiveTwitterUserHandle(profile);
    if (hHidden) hHidden.value = rawHandle;
    if (hHint) {
        hHint.textContent =
            '提示：当前 @ 为 @' +
            rawHandle +
            '。若原为默认 user，保存时会根据「名称」自动生成英文标识；与模型生成推文中的 @ 一致。';
    }

    const parts = parseTwitterJoinedParts(profile.joined);
    const ySel = document.getElementById('twitter-edit-joined-year');
    const mSel = document.getElementById('twitter-edit-joined-month');
    const dSel = document.getElementById('twitter-edit-joined-day');
    if (ySel) ySel.value = String(parts.y);
    if (mSel) mSel.value = String(parts.m);
    if (dSel) dSel.value = String(parts.d);

    document.getElementById('twitter-profile-edit-modal').classList.add('show');
}

function closeTwitterProfileEdit() {
    document.getElementById('twitter-profile-edit-modal').classList.remove('show');
}

function saveTwitterProfileEdit() {
    const existing = loadTwitterProfile() || {};
    const displayName = (document.getElementById('twitter-edit-display-name').value.trim() || '用户');
    let handle = (document.getElementById('twitter-edit-handle') && document.getElementById('twitter-edit-handle').value || '')
        .trim()
        .replace(/^@/, '');
    const prevDn = (existing.displayName || '').trim();
    if (!handle || handle.toLowerCase() === 'user') {
        const ex = (existing.handle || '').toString().replace(/^@/, '').trim();
        const fb = ex && ex.toLowerCase() !== 'user' ? ex : '';
        handle = twitterDeriveHandleFromDisplayName(displayName, fb);
    } else {
        const derivedFromOld = twitterDeriveHandleFromDisplayName(prevDn, '');
        if (displayName !== prevDn && handle === derivedFromOld) {
            handle = twitterDeriveHandleFromDisplayName(displayName, '');
        }
    }
    const y = document.getElementById('twitter-edit-joined-year') && document.getElementById('twitter-edit-joined-year').value;
    const mo = document.getElementById('twitter-edit-joined-month') && document.getElementById('twitter-edit-joined-month').value;
    const da = document.getElementById('twitter-edit-joined-day') && document.getElementById('twitter-edit-joined-day').value;
    const joined = (y && mo && da)
        ? `${y}年${mo}月${da}日 加入`
        : (new Date().getFullYear() + '年3月1日 加入');

    const profile = {
        displayName,
        handle,
        bio: document.getElementById('twitter-edit-bio').value.trim(),
        joined,
        following: existing.following != null ? existing.following : 0,
        followers: existing.followers != null ? existing.followers : 0,
        avatarDataUrl: existing.avatarDataUrl || '',
        bannerDataUrl: existing.bannerDataUrl || ''
    };
    try { Twitter.store.saveTwitterProfile(profile); } catch (e) {}
    closeTwitterProfileEdit();
    refreshTwitterProfileUI();
}

/** 触发背景图上传 */
function triggerTwitterBannerUpload() {
    const input = document.getElementById('twitter-upload-banner-input');
    if (input) input.click();
}

/** 触发头像上传 */
function triggerTwitterAvatarUpload() {
    const input = document.getElementById('twitter-upload-avatar-input');
    if (input) input.click();
}

/** 处理背景图上传：读取文件 → 转为 dataURL → 存入 LS → 更新 UI */
function handleTwitterBannerUpload(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (typeof isLegoUploadableRasterImageFile === 'function' ? !isLegoUploadableRasterImageFile(file) : !file.type.startsWith('image/')) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        const dataUrl = e.target.result;
        if (dataUrl.length > 5000000) {
            showNotification('图片过大，请选择更小的文件');
            return;
        }
        const profile = Object.assign(loadTwitterProfile() || {}, { bannerDataUrl: dataUrl });
        try {
            Twitter.store.saveTwitterProfile(profile);
        } catch (er) {
            showNotification('保存失败：浏览器存储可能已满，请换更小的背景图或清理数据');
            return;
        }
        const v = loadTwitterProfile();
        if (!v || v.bannerDataUrl !== dataUrl) {
            showNotification('背景图保存失败，请重试');
            return;
        }
        refreshTwitterProfileUI();
        showNotification('背景图已更新');
    };
    reader.onerror = function () { showNotification('图片读取失败'); };
    reader.readAsDataURL(file);
    input.value = '';
}

/** 处理头像上传：读取文件 → 压缩为较小 JPEG dataURL → 存入 LS → 更新 UI */
function handleTwitterAvatarUpload(input) {
    const file = input && input.files && input.files[0];
    if (!file) return;
    if (typeof isLegoUploadableRasterImageFile === 'function' ? !isLegoUploadableRasterImageFile(file) : !file.type.startsWith('image/')) {
        showNotification('请选择 JPEG、PNG 或 GIF 图片');
        return;
    }
    const reader = new FileReader();
    reader.onload = function (e) {
        const raw = e.target.result;
        compressImageDataUrl(raw, 256, 0.82).then(function (dataUrl) {
            if (!dataUrl || typeof dataUrl !== 'string') {
                showNotification('图片处理失败，请换一张试试');
                return;
            }
            if (dataUrl.length > 650000) {
                showNotification('图片处理后仍过大，请选择更小的图片');
                return;
            }
            const profile = Object.assign(loadTwitterProfile() || {}, { avatarDataUrl: dataUrl });
            try {
                Twitter.store.saveTwitterProfile(profile);
            } catch (er) {
                showNotification('保存失败：浏览器存储可能已满，请清理本站数据或缩小图片');
                return;
            }
            const verify = loadTwitterProfile();
            if (!verify || verify.avatarDataUrl !== dataUrl) {
                showNotification('保存失败，请重试');
                return;
            }
            refreshTwitterProfileUI();
            showNotification('头像已更新');
        });
    };
    reader.onerror = function () { showNotification('图片读取失败'); };
    reader.readAsDataURL(file);
    input.value = '';
}

function openTwitterComposer() {
    const modal = document.getElementById('twitter-compose-modal');
    const input = document.getElementById('twitter-compose-input');
    const count = document.getElementById('twitter-compose-count');
    const submitBtn = document.getElementById('twitter-compose-submit-btn');
    if (!modal || !input) return;
    input.value = '';
    if (count) count.textContent = '0/280';
    if (submitBtn) submitBtn.disabled = false;
    modal.classList.add('show');
    setTimeout(function () {
        try { input.focus(); } catch (e) {}
    }, 0);
}

function closeTwitterComposer() {
    const modal = document.getElementById('twitter-compose-modal');
    const input = document.getElementById('twitter-compose-input');
    const count = document.getElementById('twitter-compose-count');
    const submitBtn = document.getElementById('twitter-compose-submit-btn');
    if (modal) modal.classList.remove('show');
    if (input) input.value = '';
    if (count) count.textContent = '0/280';
    if (submitBtn) submitBtn.disabled = false;
}

function updateTwitterComposeCount() {
    const input = document.getElementById('twitter-compose-input');
    const count = document.getElementById('twitter-compose-count');
    if (!input || !count) return;
    count.textContent = String((input.value || '').length) + '/280';
}

function requestTwitterFriendCommentsForUserPost(post) {
    if (!post || typeof CommandManager === 'undefined' || typeof CommandManager.buildTwitterUserPostCommentsSendContent !== 'function') return;
    const sendContent = CommandManager.buildTwitterUserPostCommentsSendContent(post);
    if (!sendContent) return;
    const ac = new AbortController();
    FeatureCommandMapper.callApiModel(sendContent, ac, { skipOverlay: true }).then(function (raw) {
        if (!raw || typeof raw !== 'string') return;
        const data = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(raw) : null;
        const arr = data && Array.isArray(data.comments) ? data.comments : [];
        if (!arr.length) return;
        const friends = loadFriendsFromStorage().filter(function (f) { return f && !f.blacklisted && !f.isGroup; });
        const byId = new Map(friends.map(function (f) { return [String(f.id), f]; }));
        const seen = new Set();
        const baseTs = Date.now();
        const mapped = [];
        arr.forEach(function (item, idx) {
            const fid = item && item.friendId != null ? String(item.friendId) : '';
            if (!fid || seen.has(fid)) return;
            const friend = byId.get(fid);
            if (!friend) return;
            const text = String(item && item.text || '').trim();
            if (!text) return;
            seen.add(fid);
            mapped.push({
                id: 'twc_' + (baseTs + idx),
                friendId: fid,
                authorName: String(item && item.authorName || twitterResolveFriendAuthorDisplayName(friend) || friend.remark || friend.nickname || '好友'),
                handle: defaultTwitterFriendHandle(friend),
                text: text,
                role: 'friend',
                createdAt: baseTs + idx
            });
        });
        if (!mapped.length) return;
        appendTwitterUserPostComments(post.id, mapped);
        twitterRenderUserProfilePanels();
        refreshTwitterUserPostDetailIfOpen(post.id);
        showNotification('已有 ' + mapped.length + ' 位好友来留言');
    }).catch(function (e) {
        if (e && e.name !== 'AbortError') console.error('twitter user post comments failed', e);
    });
}

function submitTwitterComposer() {
    const input = document.getElementById('twitter-compose-input');
    const submitBtn = document.getElementById('twitter-compose-submit-btn');
    if (!input || !submitBtn) return;
    const text = input.value.trim();
    if (!text) {
        showNotification('请输入推文内容');
        return;
    }
    submitBtn.disabled = true;
    const now = Date.now();
    const post = upsertTwitterUserPost({
        id: 'twp_' + now,
        text: text,
        createdAt: now,
        commentCountBase: 0,
        repostCount: Math.floor(Math.random() * 6),
        likeCount: 10 + Math.floor(Math.random() * 90),
        viewCount: 120 + Math.floor(Math.random() * 900),
        comments: []
    });
    closeTwitterComposer();
    switchTwitterBottomTab('profile');
    switchTwitterProfileSubTab('posts');
    refreshTwitterProfileUI();
    openTwitterUserPostDetail(post.id);
    showNotification('已发布推文，正在生成好友留言');
    requestTwitterFriendCommentsForUserPost(post);
}

function normalizeTwitterHtmlString(html) {
    if (!html || typeof html !== 'string') return html;
    return html
        .replace(/background(-color)?\s*:\s*#0{1,6}\b/gi, 'background-color:#E7E8EA')
        .replace(/background(-color)?\s*:\s*black\b/gi, 'background-color:#E7E8EA')
        .replace(/background(-color)?\s*:\s*rgb\(\s*0\s*,\s*0\s*,\s*0\s*\)/gi, 'background-color:#E7E8EA')
        .replace(/color\s*:\s*#e7e9ea\b/gi, 'color:#0f1419')
        .replace(/color\s*:\s*#d9d9d9\b/gi, 'color:#536471')
        .replace(/color\s*:\s*#ffffff\b/gi, 'color:#0f1419')
        .replace(/color\s*:\s*#fff\b/gi, 'color:#0f1419')
        .replace(/color\s*:\s*white\b/gi, 'color:#0f1419')
        .replace(/#2f3336/gi, '#cdd0d4');
}

function twitterIsInsideAvatar(el) {
    return !!(el && el.closest && el.closest('.tweet-avatar-wrap, [class*="avatar-wrap"]'));
}

function twitterRgbTripletSum(val) {
    const m = String(val).match(/rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i);
    return m ? (+m[1]) + (+m[2]) + (+m[3]) : null;
}

function twitterApplyLightThemeToDom(root) {
    if (!root) return;
    root.querySelectorAll('[style]').forEach(el => {
        if (twitterIsInsideAvatar(el)) return;
        try {
            const st = el.style;
            const bgc = st.backgroundColor;
            if (bgc) {
                const sum = twitterRgbTripletSum(bgc);
                if (sum !== null && sum < 90) {
                    st.setProperty('background-color', '#E7E8EA', 'important');
                    st.setProperty('background-image', 'none', 'important');
                }
            }
            const bg = (st.background || '').toLowerCase();
            if (bg && (bg.includes('#000') || bg.includes('rgb(0, 0, 0)') || bg === 'black')) {
                if (!twitterIsInsideAvatar(el)) st.setProperty('background-color', '#E7E8EA', 'important');
            }
            const col = st.color;
            if (col && !twitterIsInsideAvatar(el)) {
                const sum = twitterRgbTripletSum(col);
                if (sum !== null && sum > 520) {
                    st.setProperty('color', '#0f1419', 'important');
                } else if (/#e7e9ea|#fff\b|white\b/i.test(col)) {
                    st.setProperty('color', '#0f1419', 'important');
                }
            }
        } catch (err) {}
    });
}

/** 模型误生成的「为你推荐+正在关注」子导航（非推文） */
function twitterLooksLikeFollowingSubTabBar(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (t.length > 240) return false;
    return /为你推荐/.test(t) && /正在关注/.test(t);
}

/**
 * 与 App 顶栏 Tab（关注/推荐/娱乐）重复的伪标题行；若保留会被 ensureFeedStructure 强行加上 .tweet，
 * 破坏时间轴版式并易引发乱码感。仅匹配「整节点可视文案几乎只有这一个词」的浅层块。
 */
function twitterIsRedundantFeedChannelLabel(node) {
    if (!node || node.nodeType !== Node.ELEMENT_NODE) return false;
    const tag = node.tagName;
    if (tag === 'SCRIPT' || tag === 'STYLE') return false;
    if (node.querySelector('img, video, iframe, picture, svg')) return false;
    if (node.querySelector('.tweet-avatar-wrap, .tweet-header, .tweet-content-col, .tweet-text')) return false;
    const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t || t.length > 32) return false;
    return /^(关注|推荐|娱乐|为你推荐)$/.test(t);
}

/** 从时间轴容器（及首个 batch 内）开头连续移除上述伪标题 */
function twitterStripLeadingRedundantFeedLabels(container) {
    if (!container) return;
    let guard = 0;
    while (guard++ < 40) {
        const first = container.firstElementChild;
        if (!first) break;
        if (first.classList && first.classList.contains('twitter-feed-batch')) {
            const htmlBefore = first.innerHTML;
            twitterStripLeadingRedundantFeedLabels(first);
            const emptyBatch = !first.firstElementChild && !(first.textContent || '').trim();
            if (emptyBatch) {
                first.remove();
                continue;
            }
            if (first.innerHTML !== htmlBefore) continue;
            break;
        }
        if (twitterIsRedundantFeedChannelLabel(first)) {
            first.remove();
            continue;
        }
        break;
    }
}

/** 关注流不应出现「为你推荐」区块：从首个该标题起整段删除（含其下帖子） */
function twitterElementOpensForYouBlock(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const head = (el.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 120);
    if (/^为你推荐/.test(head)) return true;
    const fc = el.firstElementChild;
    if (!fc) return false;
    const ft = (fc.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return /^为你推荐/.test(ft);
}

function twitterStripForYouFromFollowingFeed(bodyEl) {
    if (!bodyEl || bodyEl.id !== 'twitter-body-following') return;
    const scanRoots = [];
    const wrap = bodyEl.querySelector(':scope > .tweet-container');
    if (wrap) scanRoots.push(wrap);
    else scanRoots.push(bodyEl);
    for (let r = 0; r < scanRoots.length; r++) {
        const root = scanRoots[r];
        const kids = Array.from(root.children);
        let cut = -1;
        for (let i = 0; i < kids.length; i++) {
            if (twitterLooksLikeFollowingSubTabBar(kids[i]) || twitterElementOpensForYouBlock(kids[i])) {
                cut = i;
                break;
            }
        }
        if (cut < 0) continue;
        for (let j = kids.length - 1; j >= cut; j--) {
            if (kids[j].parentNode === root) root.removeChild(kids[j]);
        }
    }
}

function twitterEnsureFeedStructure(bodyEl) {
    if (!bodyEl) return;
    const followingPanel = bodyEl.id === 'twitter-body-following';
    let container = bodyEl.querySelector(':scope > .tweet-container');
    if (!container) {
        const wrap = document.createElement('div');
        wrap.className = 'tweet-container';
        while (bodyEl.firstChild) wrap.appendChild(bodyEl.firstChild);
        bodyEl.appendChild(wrap);
        container = wrap;
    }
    twitterStripLeadingRedundantFeedLabels(container);
    function markTimelineChildren(parentEl) {
        if (!parentEl) return;
        Array.from(parentEl.children).forEach(node => {
            if (node.nodeType !== Node.ELEMENT_NODE) return;
            if (node.tagName === 'NAV' && twitterIsRedundantFeedChannelLabel(node)) {
                node.remove();
                return;
            }
            if (followingPanel) {
                if (node.tagName === 'NAV' || twitterLooksLikeFollowingSubTabBar(node)) {
                    node.remove();
                    return;
                }
            }
            if (node.classList.contains('twitter-feed-batch')) {
                node.classList.remove('tweet');
                node.removeAttribute('data-twitter-thread-root');
                markTimelineChildren(node);
                return;
            }
            if (node.classList.contains('friend-darkweb-forum-list')) {
                node.classList.remove('tweet');
                node.removeAttribute('data-twitter-thread-root');
                markTimelineChildren(node);
                return;
            }
            if (node.classList.contains('twitter-x-timeline')) {
                node.classList.remove('tweet');
                node.removeAttribute('data-twitter-thread-root');
                markTimelineChildren(node);
                return;
            }
            if (!node.classList.contains('tweet')) node.classList.add('tweet');
            node.setAttribute('data-twitter-thread-root', '1');
        });
    }
    Array.from(container.querySelectorAll('.twitter-feed-batch.tweet')).forEach(function (batch) {
        batch.classList.remove('tweet');
        batch.removeAttribute('data-twitter-thread-root');
    });
    markTimelineChildren(container);
    Array.from(container.querySelectorAll('.twitter-feed-batch')).forEach(function (batch) {
        twitterPromoteNestedTimelineRoots(batch);
    });
    Array.from(container.children).forEach(node => {
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        if (node.classList.contains('twitter-feed-batch')) return;
        if (node.classList.contains('friend-darkweb-forum-list')) return;
        if (!node.classList.contains('tweet')) node.classList.add('tweet');
        if (!node.getAttribute('data-twitter-thread-root')) node.setAttribute('data-twitter-thread-root', '1');
    });
    twitterPromoteNestedTimelineRoots(container);
}

/**
 * 模型常把整条时间线包在一个外层 .tweet 里，导致点击任意帖都归到索引 0。
 * 若容器内仅有一个 timeline 根，且其内部存在多条「彼此之间无 .tweet 祖先」的并列 .tweet，
 * 则把这些内层帖提升为独立的 data-twitter-thread-root（引用帖仍保持在外层帖内部，不会被拆成多条根）。
 */
function twitterPromoteNestedTimelineRoots(container) {
    if (!container) return;
    const directRoots = Array.from(container.children).filter(function (node) {
        return node.nodeType === Node.ELEMENT_NODE && node.getAttribute('data-twitter-thread-root') === '1';
    });
    if (directRoots.length !== 1) return;
    const sole = directRoots[0];
    if (!sole.classList.contains('tweet')) return;
    const innerTweets = Array.from(sole.querySelectorAll('.tweet')).filter(function (t) { return t !== sole; });
    if (innerTweets.length < 2) return;
    const topInner = innerTweets.filter(function (t) {
        var p = t.parentElement;
        while (p && p !== sole) {
            if (p.classList && p.classList.contains('tweet')) return false;
            p = p.parentElement;
        }
        return true;
    });
    if (topInner.length < 2) return;
    sole.removeAttribute('data-twitter-thread-root');
    topInner.forEach(function (node) {
        if (!node.classList.contains('tweet')) node.classList.add('tweet');
        node.setAttribute('data-twitter-thread-root', '1');
    });
}

function initTwitterFeedAfterInsert(bodyEl) {
    if (!bodyEl) return;
    if (bodyEl.id === 'friend-darkweb-detail-content' || bodyEl.id === 'friend-darkweb-comments-list' || (bodyEl.classList && bodyEl.classList.contains('friend-darkweb-comments-list'))) {
        twitterApplyLightThemeToDom(bodyEl);
        return;
    }
    twitterStripForYouFromFollowingFeed(bodyEl);
    twitterEnsureFeedStructure(bodyEl);
    twitterApplyLightThemeToDom(bodyEl);
}

/** 详情页 cacheKey（实现见 twitter-store.js） */
function _twitterDetailCacheKey(payload, clickedIndex) {
    return Twitter.store.twitterDetailCacheKey(payload, clickedIndex);
}

function stripTwitterApiHtmlFence(s) {
    if (!s || typeof s !== 'string') return s;
    let t = s.trim();
    if (t.startsWith('```')) t = t.replace(/^```[a-zA-Z]*\s*/, '').replace(/\s*```\s*$/m, '');
    return t.trim();
}

/** 模型误把 CSS 样式表当正文输出（如 .twitter-x-timeline { … }） */
function twitterLooksLikeRawCssBlob(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    if (!t) return false;
    if (/class\s*=\s*["'][^"']*\btweet\b/i.test(t)) return false;
    if (/<(?:div|article|section)\b[^>]*class\s*=\s*["'][^"']*tweet/i.test(t)) return false;
    const htmlTags = (t.match(/<[a-zA-Z][^>]*>/g) || []).length;
    const cssBlocks = (t.match(/[.#][\w-]+\s*\{/g) || []).length;
    const cssProps = (t.match(/(?:background-color|font-family|display\s*:|margin-right|border-radius|flex-shrink|word-break|line-height|padding-left)\s*:/gi) || []).length;
    if (cssBlocks >= 2 && cssProps >= 3 && htmlTags <= 1) return true;
    if (cssBlocks >= 1 && cssProps >= 2 && !/[<>]/.test(t.slice(0, 120))) return true;
    return false;
}

/** 去掉 <style> 块与 HTML 前的纯 CSS 前缀 */
function twitterStripCssFromApiOutput(t) {
    if (!t || typeof t !== 'string') return t;
    t = t.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    const tagStart = t.search(/<(?:div|article|section|header|nav|main|span|p|ul|ol|li|h[1-6]|blockquote)\b/i);
    if (tagStart > 0) {
        const lead = t.slice(0, tagStart).trim();
        if (twitterLooksLikeRawCssBlob(lead)) t = t.slice(tagStart);
    }
    if (twitterLooksLikeRawCssBlob(t)) return '';
    return t.trim();
}

/** 刷新结果是否含可渲染的推文 HTML */
function twitterApiOutputHasTimelineHtml(t) {
    if (!t || typeof t !== 'string') return false;
    const s = t.trim();
    if (!s || twitterLooksLikeRawCssBlob(s)) return false;
    return /class\s*=\s*["'][^"']*\btweet\b/i.test(s) ||
        /<(?:div|article)\b[^>]*class\s*=\s*["'][^"']*tweet/i.test(s) ||
        /class\s*=\s*["'][^"']*twitter-x-timeline/i.test(s);
}

/** 去掉模型前言、markdown 围栏残留、正文前的纯文本标题，再交给 innerHTML */
function sanitizeTwitterApiHtmlOutput(s) {
    if (!s || typeof s !== 'string') return s;
    let t = s.trim();
    t = t.replace(/\r\n/g, '\n');
    for (let i = 0; i < 3; i++) {
        t = t.replace(/^```[a-zA-Z0-9]*\s*\n?/m, '').replace(/\n?\s*```\s*$/m, '').trim();
    }
    t = t.replace(/```[a-zA-Z0-9]*/g, '');
    t = twitterStripCssFromApiOutput(t);
    const tagStart = t.search(/<[a-zA-Z]/);
    if (tagStart > 0) t = t.slice(tagStart);
    else if (tagStart < 0 && twitterLooksLikeRawCssBlob(t)) return '';
    t = t.replace(/^[\s\uFEFF]*(?:以下是[^<\n]{0,120}\n?)+/i, '');
    t = t.replace(/^(?:<h[1-6][^>]*>\s*(?:关注|推荐|娱乐|为你推荐)\s*<\/h[1-6]>\s*)+/i, '');
    for (let s = 0; s < 6; s++) {
        const next = t.replace(
            /^\s*<(?:div|section|header|nav|aside|p|span|strong)\b[^>]*>\s*(?:<(?:div|span|strong|p)\b[^>]*>\s*){0,2}<h[1-6][^>]*>\s*(?:关注|推荐|娱乐|为你推荐)\s*<\/h[1-6]>\s*(?:<\/(?:div|span|strong|p)>\s*){0,2}<\/(?:div|section|header|nav|aside|p|span|strong)>\s*/i,
            ''
        );
        if (next === t) break;
        t = next;
    }
    for (let s = 0; s < 6; s++) {
        const next = t.replace(
            /^\s*<(?:div|section|header)\b[^>]*>\s*(?:<(?:div|span|strong|p|b)\b[^>]*>\s*){0,2}(?:关注|推荐|娱乐|为你推荐)\s*(?:<\/(?:div|span|strong|p|b)>\s*){0,2}<\/(?:div|section|header)>\s*/i,
            ''
        );
        if (next === t) break;
        t = next;
    }
    return t.trim();
}

/**
 * 保留第 n 条推文（主帖 + 其评论），用于详情页展示用户点击的那一帖。
 * @param {string} html - API 返回的 HTML
 * @param {number} n - 推文索引（0-based）
 */
function twitterKeepNthTweet(html, n) {
    if (!html || typeof html !== 'string') return html;
    n = Math.max(0, Math.floor(Number(n) || 0));
    const container = document.createElement('div');
    container.innerHTML = html;

    // 如果有外层包裹 div（如 twitter-x-detail-root），在其内部查询
    let searchRoot = container;
    const firstChild = container.firstElementChild;
    if (firstChild && /^(DIV|SECTION|ARTICLE|ASIDE)$/i.test(firstChild.tagName)) {
        const cls = (firstChild.className || '').toLowerCase();
        // 跳过非推文结构的外层（如 twitter-x-detail-root）
        if (/twitter-x-detail-root|detail-root/i.test(cls) || !/tweet/i.test(cls)) {
            searchRoot = firstChild;
        }
    }

    // 查找直接子 tweet（娱乐板块模型将多帖包在一个外层 div.tweet 里时，
    // firstChild.className 含 'tweet'，此时 !/tweet/i.test(cls) === false，
    // searchRoot 仍为 container，:scope > .tweet 能找到内部所有嵌套推文）。
    const tweets = searchRoot.querySelectorAll(':scope > .tweet');
    if (tweets.length === 0) {
        // 兜底：在 searchRoot（而非 container）内搜索全部 .tweet
        const all = searchRoot.querySelectorAll('.tweet');
        if (all.length === 0) return html;
        return twitterKeepNthTweetFromResult(html, n, searchRoot, all);
    }
    return twitterKeepNthTweetFromResult(html, n, searchRoot, tweets);
}

function twitterKeepNthTweetFromResult(html, n, searchRoot, tweets) {
    const tweetList = Array.from(tweets);
    const target = tweetList[Math.min(n, tweetList.length - 1)];
    const result = document.createElement('div');
    result.appendChild(target.cloneNode(true));

    // 单帖详情页 API 常把评论区放在主帖 .tweet 的「下一个兄弟节点」里，且外层 class 可能不含 reply/comment 字样；
    // 旧逻辑遇首个“不匹配”的兄弟就 break，会把整段评论区丢掉。改为：一直并入兄弟节点，直到遇到「时间轴下一条主帖」。
    let sib = target.nextElementSibling;
    while (sib) {
        const next = sib.nextElementSibling;
        if (tweetList.indexOf(sib) >= 0) break;
        if (sib.classList && sib.classList.contains('tweet')) break;
        if (sib.querySelector && sib.querySelector(':scope > .tweet')) break;
        result.appendChild(sib.cloneNode(true));
        sib = next;
    }

    // 若无紧邻评论，尝试从 target 内找评论区（含 twitter-comments-section）
    if (!result.querySelector('.tweet-reply, .twitter-x-reply, .twitter-comments-section')) {
        target.querySelectorAll('.tweet-reply, .twitter-x-reply, .tweet-replies, [class*="tweet-repl"], .twitter-comments-section')
            .forEach(r => result.appendChild(r.cloneNode(true)));
        target.querySelectorAll('section, aside').forEach(r => {
            if (!result.querySelector(`[data-uid="${r.getAttribute('data-uid')}"]`)) {
                result.appendChild(r.cloneNode(true));
            }
        });
    }

    // 兜底2：在 searchRoot（外层 wrapper）内找 twitter-comments-section
    if (!result.querySelector('.tweet-reply, .twitter-x-reply, .twitter-comments-section')) {
        searchRoot.querySelectorAll('.twitter-comments-section').forEach(cs => {
            if (!result.querySelector(`[data-uid="${cs.getAttribute('data-uid')}"]`)) {
                result.appendChild(cs.cloneNode(true));
            }
        });
        searchRoot.querySelectorAll('.tweet-reply, .twitter-x-reply').forEach(r => {
            if (!result.querySelector(`[data-uid="${r.getAttribute('data-uid')}"]`)) {
                result.appendChild(r.cloneNode(true));
            }
        });
    }

    return result.innerHTML;
}

/**
 * 仅保留 API 返回 HTML 中的第一帖（主帖 + 其评论），防止多帖拼接。
 * 现已改为调用 twitterKeepNthTweet 实现。
 */
function twitterKeepOnlyFirstTweet(html) {
    return twitterKeepNthTweet(html, 0);
}

function twitterCleanFriendAvatarForTweet(av) {
    if (!av || typeof av !== 'string') return '';
    let s = av.trim();
    if (s.startsWith('url(') && s.endsWith(')')) s = s.slice(4, -1).trim().replace(/^['"]|['"]$/g, '');
    return s;
}

function twitterAvatarUrlUsable(s) {
    if (!s || typeof s !== 'string') return false;
    const t = s.trim();
    return /^(https?:|data:image|blob:)/i.test(t);
}

/** 推特注入用：角色卡字段 avatar 优先，其次微信聊天专属 chatAvatar、人设头像 */
function twitterFriendAvatarUrlForInjection(f) {
    if (!f || f.isGroup) return '';
    const candidates = [f.avatar, f.chatAvatar, f.persona && f.persona.avatar];
    for (let i = 0; i < candidates.length; i++) {
        const s = twitterCleanFriendAvatarForTweet(candidates[i]);
        if (twitterAvatarUrlUsable(s)) return s.trim();
    }
    return '';
}

/** 与 twitterGetTweetFlexAndAvatarColumn 一致：外层包一层 flex 时取内层真正的推文行 */
function twitterResolveTweetFlexRoot(rowEl) {
    if (!rowEl) return null;
    const tweetMain = rowEl.querySelector(':scope > .tweet-main, :scope > [class*="tweet-main"]');
    if (tweetMain) return tweetMain;
    const stTop = rowEl.getAttribute('style') || '';
    let flexRoot = /display:\s*flex/i.test(stTop) ? rowEl : rowEl.querySelector(':scope > div');
    if (!flexRoot) return null;
    const fr0 = flexRoot.getAttribute('style') || '';
    if (!/display:\s*flex/i.test(fr0)) {
        if (flexRoot.querySelector(':scope > .avatar-col, :scope > .content-col')) {
            return flexRoot;
        }
        const inner = flexRoot.querySelector(':scope > div[style*="flex"]');
        if (inner && /display:\s*flex/i.test(inner.getAttribute('style') || '')) flexRoot = inner;
    }
    if (flexRoot.querySelector(':scope > .avatar-col, :scope > .content-col')) return flexRoot;
    return flexRoot;
}

/**
 * 仅从发帖行头栏（昵称、@handle、时间）解析 handle，避免正文/评论里 @mention 误当作发帖人。
 * 支持 Lego_/user_ 默认 ID，以及好友自定义推特 @（如 Ghost、Lego_Soap）。
 */
function twitterExtractAuthorHandleKeyFromTweetRow(rowEl) {
    const handleEl = rowEl && rowEl.querySelector('.author-handle, .tweet-handle, .handle, [class*="tweet-handle"]');
    const reLego = /@?\s*((?:Lego_|user_)[a-zA-Z0-9_]+)/i;
    function keyFromHandleText(s) {
        const t = (s || '').trim();
        const mL = t.match(reLego);
        if (mL) return mL[1].replace(/^@/, '').toLowerCase();
        const mAt = t.match(/@([^\s@·]+)/);
        if (mAt) return mAt[1].toLowerCase();
        return '';
    }
    if (handleEl) {
        const k = keyFromHandleText(handleEl.textContent);
        if (k) return k;
    }
    const flexRoot = twitterResolveTweetFlexRoot(rowEl);
    if (!flexRoot) return '';
    const rightCol = flexRoot.querySelector(':scope > .content-col') ||
        (flexRoot.children.length >= 2 ? flexRoot.children[1] : flexRoot.children[0]);
    if (!rightCol) return '';
    const headerRow = rightCol.querySelector(':scope > .tweet-header, :scope > .reply-header, :scope > div');
    if (!headerRow) return '';
    const spans = headerRow.querySelectorAll(':scope > span');
    if (spans.length >= 2) {
        const second = (spans[1].textContent || '').trim();
        const k = keyFromHandleText(second);
        if (k) return k;
    }
    const full = (headerRow.textContent || '').trim();
    const mL = full.match(reLego);
    if (mL) return mL[1].replace(/^@/, '').toLowerCase();
    const at = full.indexOf('@');
    if (at >= 0) {
        const rest = full.slice(at + 1);
        const mPart = rest.match(/^([^\s@·]+)/);
        if (mPart) return mPart[1].toLowerCase();
    }
    return '';
}

/**
 * 从 flex 行中挑选最像「左侧头像列」的子 div，避免误把正文列或错误嵌套的大块当作头像容器。
 * 模型偶发把非 48px 的圆角块或整行第一列写成巨大占位，会导致注入的 img 跟屏同宽。
 */
function twitterPickAvatarColumnFromFlexRoot(flexRoot) {
    if (!flexRoot) return null;
    const kids = Array.from(flexRoot.children).filter(function (c) {
        return c.nodeType === 1 && c.tagName === 'DIV';
    });
    if (!kids.length) return null;
    const scored = kids.map(function (div, idx) {
        const st = div.getAttribute('style') || '';
        const cls = (div.className && div.className.toString()) || '';
        let score = 0;
        if (/avatar|tweet-avatar|头像/i.test(cls)) score += 120;
        if (/avatar-col|avatar-placeholder|reply-avatar/i.test(cls)) score += 100;
        if (/border-radius:\s*50%|border-radius:\s*\d+px/.test(st) && /50%/.test(st)) score += 90;
        const wm = st.match(/width:\s*([\d.]+)\s*px/i);
        const hm = st.match(/height:\s*([\d.]+)\s*px/i);
        const w = wm ? parseFloat(wm[1]) : NaN;
        const h = hm ? parseFloat(hm[1]) : NaN;
        if (!isNaN(w) && w >= 36 && w <= 56) score += 70;
        if (!isNaN(h) && h >= 36 && h <= 56) score += 70;
        if (!isNaN(w) && w > 96) score -= 250;
        if (!isNaN(h) && h > 120) score -= 250;
        if (/\b(vh|vmin|vw)\b/i.test(st)) score -= 80;
        if (idx === 0) score += 8;
        return { div: div, score: score };
    });
    scored.sort(function (a, b) { return b.score - a.score; });
    return scored[0].div;
}

/** 注入头像前强制容器为时间轴规范尺寸，避免 data URL 大图撑破布局 */
function twitterNormalizeAvatarInjectionHost(avEl) {
    if (!avEl || avEl.nodeType !== 1) return;
    const side = '48px';
    avEl.style.setProperty('width', side, 'important');
    avEl.style.setProperty('height', side, 'important');
    avEl.style.setProperty('min-width', '36px', 'important');
    avEl.style.setProperty('min-height', '36px', 'important');
    avEl.style.setProperty('max-width', '56px', 'important');
    avEl.style.setProperty('max-height', '56px', 'important');
    avEl.style.setProperty('flex-shrink', '0', 'important');
    avEl.style.setProperty('box-sizing', 'border-box', 'important');
    avEl.style.setProperty('overflow', 'hidden', 'important');
    avEl.style.setProperty('border-radius', '50%', 'important');
    /* 模型偶发写 position:sticky，详情页滚动时头像会「钉」在视口，与正文错位 */
    avEl.style.setProperty('position', 'relative', 'important');
    avEl.style.removeProperty('top');
    avEl.style.removeProperty('bottom');
}

/** 详情页：去掉评论行左侧头像列的 sticky / fixed，避免滚动时头像与正文分离 */
function twitterResetStickyAvatarColumnsInDetail(detailRoot) {
    if (!detailRoot || detailRoot.id !== 'twitter-detail-content') return;
    detailRoot.querySelectorAll('.tweet, .tweet-reply, .twitter-x-reply').forEach(function (row) {
        const pair = twitterGetTweetFlexAndAvatarColumn(row);
        if (!pair || !pair.avatarCol) return;
        const col = pair.avatarCol;
        let pos = '';
        try {
            pos = window.getComputedStyle(col).position;
        } catch (e) { return; }
        if (pos !== 'sticky' && pos !== '-webkit-sticky' && pos !== 'fixed') return;
        col.style.setProperty('position', 'relative', 'important');
        col.style.removeProperty('top');
        col.style.removeProperty('bottom');
    });
}

/** 定位推文 flex 行与左侧头像列（与注入逻辑一致） */
function twitterGetTweetFlexAndAvatarColumn(tweetEl) {
    const flexRoot = twitterResolveTweetFlexRoot(tweetEl);
    if (!flexRoot) return null;
    let avatarCol = flexRoot.querySelector(':scope > .avatar-col');
    if (!avatarCol) avatarCol = twitterPickAvatarColumnFromFlexRoot(flexRoot);
    if (!avatarCol || avatarCol.tagName !== 'DIV') return null;
    return { flexRoot, avatarCol };
}

/** 摘掉所有 http(s) 外链 <img>，避免模型臆造图床（如 ltn.com.tw）导致 ERR_CONNECTION_TIMED_OUT；头像由客户端再注入 */
function twitterStripRemoteHttpImagesInTwitterPanels(rootEl) {
    if (!rootEl) return;
    const ok = rootEl.id === 'twitter-body-following' || rootEl.id === 'twitter-body-foryou' ||
        rootEl.id === 'twitter-body-entertainment' || rootEl.id === 'twitter-detail-content';
    if (!ok) return;
    rootEl.querySelectorAll('img[src]').forEach(img => {
        const src = (img.getAttribute('src') || '').trim();
        if (/^https?:\/\//i.test(src)) img.remove();
    });
}

function twitterLooksLikeTwitterTimelineReplySibling(el) {
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return false;
    const st = (el.getAttribute('style') || '').replace(/\s+/g, ' ');
    return /padding-left:\s*(48|52|56|60)px/i.test(st) ||
        (/margin-top:\s*1[0-2]px/i.test(st) && /padding-left:\s*\d+px/i.test(st));
}

/** 时间轴内不展示内嵌评论（详情页再展示）。勿删「推荐」单条 flex 主帖的头像+正文两列 */
function twitterStripInlineRepliesFromTimeline(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.tweet').forEach(tweet => {
        tweet.querySelectorAll('.tweet-replies, .tweet-reply-section, .tweet-reply, .twitter-x-reply').forEach(n => n.remove());
        for (let i = tweet.children.length - 1; i >= 1; i--) {
            const k = tweet.children[i];
            if (twitterLooksLikeTwitterTimelineReplySibling(k)) k.remove();
        }
    });
}

function twitterIsUserAuthoredTweetRow(rowEl) {
    if (!rowEl) return false;
    const userTw = String(getEffectiveTwitterUserHandle(loadTwitterProfile() || {})).toLowerCase();
    const skip = new Set([userTw, 'user']);
    const hk = twitterExtractAuthorHandleKeyFromTweetRow(rowEl);
    if (hk && skip.has(hk)) return true;
    const myProfile = safeReadJsonFromStorage('myProfile', null);
    const twProfile = loadTwitterProfile() || {};
    const userNames = [
        (twProfile.displayName || '').trim(),
        (myProfile && myProfile.nickname) || ''
    ].filter(Boolean).map(function (n) { return twitterNormalizeKeyLoose(n); });
    const dn = twitterExtractAuthorDisplayNameFromTweetRow(rowEl);
    if (dn && userNames.length) {
        const dnNorm = twitterNormalizeKeyLoose(dn);
        if (dnNorm && userNames.indexOf(dnNorm) >= 0) return true;
    }
    return false;
}

/** 移除模型预生成的 User 评论（详情页与 time 轴共用） */
function twitterStripUserAuthoredRepliesFromDom(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.tweet-reply, .twitter-x-reply').forEach(function (row) {
        if (twitterIsUserAuthoredTweetRow(row)) row.remove();
    });
}

function twitterStripUserAuthoredContentFromTimeline(rootEl) {
    if (!rootEl || rootEl.id === 'twitter-detail-content') return;
    twitterStripUserAuthoredRepliesFromDom(rootEl);
    rootEl.querySelectorAll('.tweet-reply-section').forEach(function (sec) {
        if (!sec.querySelector('.tweet-reply, .twitter-x-reply')) sec.remove();
    });
    rootEl.querySelectorAll('.tweet[data-twitter-thread-root="1"]').forEach(function (tweet) {
        if (twitterIsUserAuthoredTweetRow(tweet)) tweet.remove();
    });
}

/** 时间轴（非详情页）去掉模型误插入的「评论」区块（规范②样式），评论仅在单帖详情页展示。 */
function twitterStripFeedCommentSectionsFromTimeline(rootEl) {
    if (!rootEl || rootEl.id === 'twitter-detail-content') return;
    rootEl.querySelectorAll('.twitter-comments-section').forEach(n => n.remove());
    rootEl.querySelectorAll('.tweet').forEach(tweet => {
        tweet.querySelectorAll('.twitter-comments-title').forEach(n => {
            const wrap = n.closest('.twitter-comments-section') || n.parentElement;
            if (wrap && wrap !== tweet) wrap.remove();
            else n.remove();
        });
    });
    rootEl.querySelectorAll('.tweet div, .tweet section').forEach(block => {
        const fc = block.firstElementChild;
        if (!fc) return;
        const ft = (fc.textContent || '').replace(/\s+/g, ' ').trim();
        if (ft !== '评论') return;
        const st = (fc.getAttribute('style') || '').replace(/\s+/g, '');
        const bold = /font-weight:\s*(700|bold)/i.test(st);
        if (!bold && fc.tagName !== 'H2' && fc.tagName !== 'H3') return;
        if (block.querySelector('.tweet-reply, .twitter-x-reply, .tweet-replies')) block.remove();
    });
}

function twitterInjectFriendAvatars(rootEl) {
    if (!rootEl) return;
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
    const byHandle = new Map();
    friends.forEach(f => twitterAddFriendToTweetHandleMap(byHandle, f));
    const userTw = getEffectiveTwitterUserHandle(loadTwitterProfile() || {});
    const skipAuthorKeys = new Set([String(userTw).toLowerCase(), 'user']);
    rootEl.querySelectorAll('.tweet, .tweet-reply, .twitter-x-reply').forEach(tweet => {
        const dn = twitterExtractAuthorDisplayNameFromTweetRow(tweet);
        let handleKey = twitterExtractAuthorHandleKeyFromTweetRow(tweet);
        let friend = null;
        if (handleKey && !skipAuthorKeys.has(handleKey)) {
            friend = twitterLookupFriendInHandleMap(byHandle, handleKey);
            if (!friend) friend = findFriendForTwitterDetail('@' + handleKey, dn);
        }
        if (!friend) friend = findFriendForTwitterDetail('', dn);
        if (!friend) {
            twitterApplyAvatarLetterFallbackToTweet(tweet);
            return;
        }
        const posterH = String(defaultTwitterFriendHandle(friend)).replace(/^@/, '').toLowerCase();
        if (skipAuthorKeys.has(posterH)) return;
        const av = twitterFriendAvatarUrlForInjection(friend);
        twitterApplyAvatarLetterFallbackToTweet(tweet);

        if (!av) return;
        const pair = twitterGetTweetFlexAndAvatarColumn(tweet);
        let avEl = null;
        if (pair) {
            const { avatarCol } = pair;
            avEl = avatarCol.querySelector('.avatar-placeholder, .reply-avatar-placeholder') || avatarCol;
            if (avEl && avEl.tagName !== 'DIV') avEl = avatarCol;
        }
        if (!avEl) {
            tweet.querySelectorAll('div[class*="avatar"]').forEach(div => {
                if (!avEl) avEl = div;
            });
        }
        if (!avEl) {
            tweet.querySelectorAll('div[style*="border-radius"]').forEach(div => {
                if (avEl) return;
                const st = div.getAttribute('style') || '';
                if (/50%/.test(st)) avEl = div;
            });
        }
        if (!avEl) return;
        twitterNormalizeAvatarInjectionHost(avEl);
        avEl.innerHTML = `<img src="${Moments.store.escapeAttrUrl(av)}" alt="" style="width:100%;height:100%;object-fit:cover;border-radius:50%;display:block;">`;
        avEl.style.backgroundImage = 'none';
        avEl.style.backgroundColor = 'transparent';
        avEl.style.padding = '0';
    });
}

/** 外链头像超时/失败时，改用本地好友的 data/blob 头像（避免模型填死链 http） */
function twitterTryRecoverLocalFriendAvatarForTweetImg(tweetEl, imgEl) {
    if (!tweetEl || !imgEl) return false;
    const dn = twitterExtractAuthorDisplayNameFromTweetRow(tweetEl);
    const hk = twitterExtractAuthorHandleKeyFromTweetRow(tweetEl);
    const friend = findFriendForTwitterDetail(hk ? '@' + hk : '', dn);
    if (!friend) return false;
    const userTw = getEffectiveTwitterUserHandle(loadTwitterProfile() || {});
    if (String(userTw).toLowerCase() === String(defaultTwitterFriendHandle(friend)).replace(/^@/, '').toLowerCase()) return false;
    const localAv = twitterFriendAvatarUrlForInjection(friend);
    if (!localAv || /^https?:\/\//i.test(localAv)) return false;
    imgEl.src = localAv;
    imgEl.style.display = '';
    return true;
}

function twitterApplyTweetAvatarLetterFallback(img) {
    if (!img || img.nodeType !== Node.ELEMENT_NODE) return;
    img.style.display = 'none';
    const wrap = img.parentElement;
    if (!wrap) return;
    const tweet = img.closest('.tweet, .tweet-reply, .twitter-x-reply');
    let letter = '?';
    if (tweet) {
        const cand = tweet.querySelector('.tweet-name, [class*="tweet-name"]');
        const ch = cand && cand.textContent ? cand.textContent.trim().charAt(0) : '';
        if (ch) letter = ch.toUpperCase();
        else {
            const sp = tweet.querySelector('span[style*="font-weight:700"], span[style*="font-weight: 700"]');
            if (sp && sp.textContent) letter = sp.textContent.trim().charAt(0).toUpperCase() || '?';
        }
    }
    let fb = wrap.querySelector('.twitter-avatar-fallback-letter');
    if (!fb) {
        fb = document.createElement('span');
        fb.className = 'twitter-avatar-fallback-letter';
        fb.setAttribute('aria-hidden', 'true');
        fb.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;font-weight:700;font-size:18px;color:#fff;background:#1d9bf0;border-radius:50%;';
        const pos = window.getComputedStyle(wrap).position;
        if (pos === 'static' || !pos || pos === 'sticky' || pos === '-webkit-sticky') {
            wrap.style.setProperty('position', 'relative', 'important');
            wrap.style.removeProperty('top');
            wrap.style.removeProperty('bottom');
        }
        wrap.appendChild(fb);
    }
    fb.textContent = letter;
}

/** 外链 JPG 等加载失败时不刷屏报错：先试本地角色卡头像，再首字占位 */
function twitterWireTweetAvatarImgFallbacks(rootEl) {
    if (!rootEl) return;
    rootEl.querySelectorAll('.tweet img[src], .tweet-reply img[src], .twitter-x-reply img[src]').forEach(img => {
        if (img.dataset.twitterAvErrBound === '1') return;
        img.dataset.twitterAvErrBound = '1';
        img.addEventListener('error', function twitterImgErr() {
            const tweet = img.closest('.tweet, .tweet-reply, .twitter-x-reply');
            if (tweet && twitterTryRecoverLocalFriendAvatarForTweetImg(tweet, img)) {
                img.addEventListener('error', function twitterImgErr2() {
                    twitterApplyTweetAvatarLetterFallback(img);
                }, { once: true });
                return;
            }
            twitterApplyTweetAvatarLetterFallback(img);
        }, { once: true });
    });
}

/** 修正模型或缓存 HTML 中的旧占位 @user、user_ 数字 ID（仅遍历推文相关节点文本） */
function twitterRewritePlaceholderHandlesInFeedDom(rootEl) {
    if (!rootEl) return;
    const eff = getEffectiveTwitterUserHandle(loadTwitterProfile());
    const low = String(eff).toLowerCase();
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            let t = node.nodeValue;
            if (!t || (!/@user/i.test(t) && !/(?:^|[^@])user_\d/i.test(t) && !/(?:^|[^@])Lego_\d/i.test(t))) return;
            t = t.replace(/@user_(\d+)\b/gi, '@' + TWITTER_FRIEND_HANDLE_PREFIX + '_$1');
            t = t.replace(/\buser_(\d+)\b/gi, TWITTER_FRIEND_HANDLE_PREFIX + '_$1');
            if (low !== 'user') t = t.replace(/@user\b/gi, '@' + eff);
            node.nodeValue = t;
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        Array.from(node.childNodes).forEach(walk);
    }
    rootEl.querySelectorAll('.tweet, .tweet-reply, .twitter-x-reply').forEach(el => walk(el));
}

/** 与发帖人栏解析一致：右侧第一行容器，用于跳过其中的 @handle（只改正文里的 @好友） */
function twitterGetTweetAuthorHeaderRow(tweetEl) {
    if (!tweetEl) return null;
    const header = tweetEl.querySelector('.tweet-header, .reply-header');
    if (header) return header;
    const stTop = tweetEl.getAttribute('style') || '';
    let flexRoot = /display:\s*flex/i.test(stTop) ? tweetEl : tweetEl.querySelector(':scope > div');
    if (!flexRoot) flexRoot = twitterResolveTweetFlexRoot(tweetEl);
    if (!flexRoot) return null;
    const rightCol = flexRoot.querySelector(':scope > .content-col') ||
        (flexRoot.children.length >= 2 ? flexRoot.children[1] : flexRoot.children[0]);
    if (!rightCol) return null;
    const headerRow = rightCol.querySelector(':scope > .tweet-header, :scope > .reply-header, :scope > div');
    return headerRow && headerRow.nodeType === Node.ELEMENT_NODE ? headerRow : null;
}

/** 正文 @ 展示用：优先微信备注/昵称，否则角色卡顶栏显示名；去掉空格以贴合 @ 形态 */
function twitterFriendMentionDisplayLabel(f) {
    if (!f || f.isGroup) return '';
    const nick = String(f.remark || f.nickname || '').trim().replace(/\s+/g, '');
    if (nick) return nick;
    return (twitterResolveFriendAuthorDisplayName(f) || '').trim().replace(/\s+/g, '');
}

function twitterBuildFriendMentionReplaceList() {
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
    const pairs = [];
    const seenKey = new Set();
    friends.forEach(f => {
        const label = twitterFriendMentionDisplayLabel(f);
        if (!label) return;
        const atLabel = '@' + label;
        const keys = new Set();
        keys.add(String(`${TWITTER_FRIEND_HANDLE_PREFIX}_${f.id}`).toLowerCase());
        keys.add(String(`user_${f.id}`).toLowerCase());
        const dh = String(defaultTwitterFriendHandle(f)).replace(/^@/, '').trim().toLowerCase();
        if (dh) keys.add(dh);
        keys.forEach(k => {
            if (!k || seenKey.has(k)) return;
            seenKey.add(k);
            pairs.push({
                key: k,
                re: new RegExp('@' + escapeRegExp(k) + '(?![a-zA-Z0-9_])', 'gi'),
                atLabel
            });
        });
    });
    pairs.sort((a, b) => b.key.length - a.key.length);
    return pairs;
}

function twitterWalkTweetTextSkippingAuthorHeader(tweetEl, fn) {
    const skipRoot = twitterGetTweetAuthorHeaderRow(tweetEl);
    function walk(node) {
        if (node.nodeType === Node.TEXT_NODE) {
            fn(node);
            return;
        }
        if (node.nodeType !== Node.ELEMENT_NODE) return;
        const tag = node.tagName;
        if (tag === 'SCRIPT' || tag === 'STYLE') return;
        if (skipRoot && node === skipRoot) return;
        Array.from(node.childNodes).forEach(walk);
    }
    walk(tweetEl);
}

/** 将正文中的 @Lego_数字ID / 自定义好友 @ 替换为 @备注或昵称（不修改作者栏灰字 @handle） */
function twitterRewriteFriendMentionsInTweetBodies(rootEl) {
    if (!rootEl) return;
    const list = twitterBuildFriendMentionReplaceList();
    if (!list.length) return;
    rootEl.querySelectorAll('.tweet, .tweet-reply, .twitter-x-reply').forEach(tweet => {
        twitterWalkTweetTextSkippingAuthorHeader(tweet, (textNode) => {
            let t = textNode.nodeValue;
            if (!t || t.indexOf('@') < 0) return;
            let out = t;
            for (let i = 0; i < list.length; i++) {
                out = out.replace(list[i].re, list[i].atLabel);
            }
            if (out !== t) textNode.nodeValue = out;
        });
    });
}

function twitterPrepareTimelineFeedBody(el) {
    if (!el) return;
    initTwitterFeedAfterInsert(el);
    twitterStripInlineRepliesFromTimeline(el);
    twitterStripUserAuthoredContentFromTimeline(el);
    twitterStripFeedCommentSectionsFromTimeline(el);
    twitterStripRemoteHttpImagesInTwitterPanels(el);
    /* 头像/显示名注入必须先于 @handle 替换（前者依赖 API 原格式找到好友；后者规范化格式方便其他处理） */
    twitterRewriteDisplayNamesInTweetDom(el);
    twitterInjectFriendAvatars(el);
    twitterWireTweetAvatarImgFallbacks(el);
    twitterRewritePlaceholderHandlesInFeedDom(el);
    twitterRewriteFriendMentionsInTweetBodies(el);
    /* twitterEnsureFeedStructure 已在 initTwitterFeedAfterInsert 中调用，此处再调用一次是幂等的，确保页面恢复时 wrapper 存在 */
    twitterEnsureFeedStructure(el);
}

/** 详情页：不包一层 tweet-container，仅主题 + handle 修正 + 好友头像注入 */
function twitterPrepareTwitterDetailBody(el) {
    if (!el) return;
    twitterApplyLightThemeToDom(el);
    twitterStripRemoteHttpImagesInTwitterPanels(el);
    twitterStripUserAuthoredRepliesFromDom(el);
    /* 头像/显示名注入先执行 */
    twitterRewriteDisplayNamesInTweetDom(el);
    twitterInjectFriendAvatars(el);
    twitterWireTweetAvatarImgFallbacks(el);
    twitterRewritePlaceholderHandlesInFeedDom(el);
    twitterRewriteFriendMentionsInTweetBodies(el);
    twitterResetStickyAvatarColumnsInDetail(el);
}

/**
 * 解析推文行头部的显示名（加粗 <span style="font-weight:700">）。
 * 避免正文中含「@xxx」被误识别为发帖人显示名。
 */
function twitterExtractAuthorDisplayNameFromTweetRow(rowEl) {
    if (!rowEl) return '';
    const nameEl = rowEl.querySelector('.author-name, .tweet-name, .display-name, [class*="tweet-name"]');
    if (nameEl) return (nameEl.textContent || '').trim();
    const flexRoot = twitterResolveTweetFlexRoot(rowEl);
    if (!flexRoot) return '';
    const rightCol = flexRoot.querySelector(':scope > .content-col') ||
        (flexRoot.children.length >= 2 ? flexRoot.children[1] : flexRoot.children[0]);
    if (!rightCol) return '';
    const headerRow = rightCol.querySelector(':scope > .tweet-header, :scope > .reply-header, :scope > div');
    if (!headerRow) return '';
    const boldSpans = Array.from(headerRow.querySelectorAll('span, .author-name, .tweet-name')).filter(sp => {
        if (sp.matches && sp.matches('.author-name, .tweet-name, .display-name')) return true;
        const s = (sp.getAttribute('style') || '').replace(/\s+/g, '');
        return /font-weight:\s*700/i.test(s) || /font-weight:\s*bold/i.test(s) || sp.style.fontWeight === '700' || sp.style.fontWeight === 'bold';
    });
    if (boldSpans.length > 0) {
        return boldSpans[0].textContent.trim();
    }
    const first = (headerRow.textContent || '').trim();
    const atIdx = first.indexOf('@');
    if (atIdx > 0) return first.slice(0, atIdx).trim();
    return first;
}

/**
 * 将推文中模型生成的显示名替换为角色卡原文显示名。
 * 流程：① 找发帖人 @handle → ② 匹配本地好友 → ③ 若卡面原文显示名不同则覆盖。
 */
function twitterRewriteDisplayNamesInTweetDom(rootEl) {
    if (!rootEl) return;
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
    const byHandle = new Map();
    friends.forEach(f => twitterAddFriendToTweetHandleMap(byHandle, f));

    rootEl.querySelectorAll('.tweet, .tweet-reply, .twitter-x-reply').forEach(tweet => {
        const dn = twitterExtractAuthorDisplayNameFromTweetRow(tweet);
        const handleKey = twitterExtractAuthorHandleKeyFromTweetRow(tweet);
        let friend = null;
        if (handleKey) {
            friend = twitterLookupFriendInHandleMap(byHandle, handleKey);
            if (!friend) friend = findFriendForTwitterDetail('@' + handleKey, dn);
        }
        if (!friend) friend = findFriendForTwitterDetail('', dn);
        if (!friend) return;
        const correctName = twitterResolveFriendAuthorDisplayName(friend);
        if (!correctName) return;
        const currentName = twitterExtractAuthorDisplayNameFromTweetRow(tweet);
        /* 若当前名已是角色卡原文，不动；也跳过编码格式名（防止「正确→编码」误覆盖） */
        if (currentName === correctName) return;
        const encRe = /^(?:Lego_|user_)\d+$/;
        if (currentName && !encRe.test(currentName)) return;
        const flexRoot = twitterResolveTweetFlexRoot(tweet);
        if (!flexRoot) return;
        const rightCol = flexRoot.children.length >= 2 ? flexRoot.children[1] : flexRoot.children[0];
        if (!rightCol) return;
        const headerRow = rightCol.querySelector(':scope > div');
        if (!headerRow) return;
        const boldSpans = Array.from(headerRow.querySelectorAll('span')).filter(sp => {
            const s = (sp.getAttribute('style') || '').replace(/\s+/g, '');
            return /font-weight:\s*700/i.test(s) || /font-weight:\s*bold/i.test(s) || sp.style.fontWeight === '700' || sp.style.fontWeight === 'bold';
        });
        if (boldSpans.length > 0) {
            boldSpans[0].textContent = correctName;
            return;
        }
        const firstSpan = headerRow.querySelector(':scope > span');
        if (firstSpan) {
            const t = firstSpan.textContent || '';
            const atIdx = t.indexOf('@');
            if (atIdx > 0) {
                firstSpan.textContent = correctName + ' ' + t.slice(atIdx);
                return;
            }
            firstSpan.textContent = correctName;
        }
    });
}

function findFriendForTwitterDetail(handleText, displayName) {
    const friends = loadFriendsFromStorage().filter(f => !f.blacklisted && !f.isGroup);
    const bare = String(handleText || '').trim().replace(/^@/, '');
    if (bare) {
        const byHandle = new Map();
        friends.forEach(f => twitterAddFriendToTweetHandleMap(byHandle, f));
        const hit = twitterLookupFriendInHandleMap(byHandle, bare);
        if (hit) return hit;
        const idMatch = bare.match(/^(?:Lego_|user_)(.+)$/i);
        if (idMatch) {
            const rest = idMatch[1];
            const byId = friends.find(x => String(x.id) === String(rest));
            if (byId) return byId;
        }
    }
    const dnRaw = (displayName || '').trim();
    const dnNorm = twitterNormalizeKeyLoose(dnRaw);
    if (dnNorm && dnRaw !== '未知用户') {
        const candidates = [];
        for (const x of friends) {
            const aliases = [
                twitterResolveFriendAuthorDisplayName(x),
                x.nickname,
                x.remark
            ].filter(Boolean);
            for (const a of aliases) {
                const aNorm = twitterNormalizeKeyLoose(a);
                if (aNorm && aNorm === dnNorm) {
                    candidates.push(x);
                    break;
                }
            }
        }
        if (candidates.length === 1) return candidates[0];
        if (candidates.length > 1) return null;
    }
    return null;
}

function extractTwitterTweetPayload(tweetEl) {
    if (!tweetEl) return null;
    const nameEl = tweetEl.querySelector('.tweet-name, .display-name, [class*="tweet-name"]');
    const handleEl = tweetEl.querySelector('.tweet-handle, .handle, [class*="handle"]');
    const threadTitleEl = tweetEl.querySelector('.friend-darkweb-thread-title');
    let textEl = tweetEl.querySelector('.friend-darkweb-thread-summary, .friend-darkweb-thread-body');
    if (!textEl) {
        textEl = tweetEl.querySelector('.tweet-text, .tweet-content, [class*="tweet-text"]');
    }
    if (!textEl) {
        const header = tweetEl.querySelector('.tweet-header, [class*="header"]');
        textEl = Array.from(tweetEl.querySelectorAll('div, p')).find(n => {
            if (header && header.contains(n)) return false;
            if (n.querySelector('.tweet-interactions, [class*="interaction"]')) return false;
            const t = (n.textContent || '').trim();
            return t.length > 15 && n.children.length < 8;
        }) || null;
    }
    const timeEl = tweetEl.querySelector('.tweet-time, .time, [class*="time"]');
    let displayName = nameEl ? nameEl.textContent.trim() : '';
    let handle = handleEl ? handleEl.textContent.trim() : '';
    if (!displayName) {
        const d = twitterExtractAuthorDisplayNameFromTweetRow(tweetEl);
        if (d) displayName = d;
    }
    if (!handle) {
        const hk = twitterExtractAuthorHandleKeyFromTweetRow(tweetEl);
        if (hk) handle = '@' + hk;
    }
    if (!displayName) displayName = '未知用户';
    const time = timeEl ? timeEl.textContent.trim() : '';
    const threadTitle = threadTitleEl ? threadTitleEl.textContent.trim() : '';
    const textHtml = textEl ? textEl.innerHTML : '';
    // 娱乐板块同一好友可能发多条推文，用整个推文 DOM 的纯文本摘要增强缓存 key 区分度
    const tweetPlainText = (function () {
        try {
            const clone = tweetEl.cloneNode(true);
            clone.querySelectorAll('.tweet-interactions, [class*="interaction"]').forEach(el => el.remove());
            clone.querySelectorAll('.friend-darkweb-thread-title').forEach(el => el.remove());
            return (clone.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 200);
        } catch (e) { return ''; }
    })();
    let hint = '';
    try { hint = (tweetEl.outerHTML || '').slice(0, 6000); } catch (e) { hint = ''; }
    let friend = findFriendForTwitterDetail(handle, displayName);
    if (!friend) {
        const hk = twitterExtractAuthorHandleKeyFromTweetRow(tweetEl);
        const dn = twitterExtractAuthorDisplayNameFromTweetRow(tweetEl);
        friend = findFriendForTwitterDetail(hk ? '@' + hk : '', dn || displayName);
    }
    return { displayName, handle, time, textHtml, threadTitle: threadTitle || '', structureHint: hint, friend: friend || null, tweetPlainText: tweetPlainText };
}

/** 供 `Twitter.buildSharePayload`：从当前详情页上下文生成摘要（依赖 `__twitterDetailPayload` 与详情 DOM） */
function buildTwitterSharePayloadFromDetailPage() {
    const p = global.__twitterDetailPayload;
    const detailContent = document.getElementById('twitter-detail-content');
    let body = '';
    if (detailContent) {
        const loading = detailContent.querySelector('.twitter-detail-loading');
        if (!loading) body = twitterStripHtmlToPlain(detailContent.innerHTML || '');
    }
    if (p && p.textHtml) {
        const fromPayload = twitterStripHtmlToPlain(p.textHtml);
        if (fromPayload && (!body || body.indexOf(fromPayload.slice(0, 40)) < 0)) {
            body = body ? fromPayload + '\n' + body : fromPayload;
        }
    }
    return s().buildTwitterSharePayload({
        tab: 'detail',
        displayName: p ? p.displayName : '',
        handle: p ? p.handle : '',
        time: p ? p.time : '',
        bodyPlain: body
    });
}

/**
 * 将 `Twitter.buildSharePayload` 结果填入**首位非群好友**的微信聊天输入框（不自动发送）。
 * 供详情页标题栏与外部模块调用；业务侧请传完整 payload，勿在 app.js 再拼一层。
 */
function shareTwitterToWeChat(payload) {
    const pl = payload || buildTwitterSharePayloadFromDetailPage();
    if (!pl || !String(pl.plainText || '').trim()) {
        if (typeof global.showNotification === 'function') global.showNotification('没有可分享的内容');
        return;
    }
    if (typeof global.loadFriendsFromStorage !== 'function' || typeof global.openChat !== 'function' || typeof global.navigateTo !== 'function') {
        if (typeof global.showNotification === 'function') global.showNotification('微信模块未就绪');
        return;
    }
    const friends = global.loadFriendsFromStorage().filter(function (f) { return !f.isGroup && !f.blacklisted; });
    if (!friends.length) {
        if (typeof global.showNotification === 'function') global.showNotification('没有可聊天的好友');
        global.navigateTo('wechat');
        return;
    }
    const f = friends[0];
    global.openChat(f.nickname, f.id);
    const delay = 580;
    setTimeout(function () {
        const inp = document.getElementById('chat-input');
        if (inp) {
            inp.value = String(pl.plainText).slice(0, 8000);
            inp.dispatchEvent(new Event('input', { bubbles: true }));
        }
        if (typeof global.showNotification === 'function') {
            global.showNotification('已填入「' + f.nickname + '」聊天输入框，可修改后发送');
        }
    }, delay);
}

function shareTwitterDetailToWeChat() {
    shareTwitterToWeChat(buildTwitterSharePayloadFromDetailPage());
}

function renderTwitterDetailFallback(tweetEl, payloadOpt) {
    if (!tweetEl) return;
    const detailPage = document.getElementById('twitter-detail-page');
    const detailContent = document.getElementById('twitter-detail-content');
    if (!detailPage || !detailContent) return;

    const nameEl = tweetEl.querySelector('.tweet-name, .display-name, [class*="tweet-name"]');
    const handleEl = tweetEl.querySelector('.tweet-handle, .handle, [class*="handle"]');
    let textEl = tweetEl.querySelector('.tweet-text, .tweet-content, [class*="tweet-text"]');
    if (!textEl) {
        const header = tweetEl.querySelector('.tweet-header, [class*="header"]');
        textEl = Array.from(tweetEl.querySelectorAll('div, p')).find(n => {
            if (header && header.contains(n)) return false;
            if (n.querySelector('.tweet-interactions, [class*="interaction"]')) return false;
            const t = (n.textContent || '').trim();
            return t.length > 15 && n.children.length < 8;
        }) || null;
    }
    const timeEl = tweetEl.querySelector('.tweet-time, .time, [class*="time"]');
    const avatarWrap = tweetEl.querySelector('.tweet-avatar-wrap, [class*="avatar"]');
    const interactionsEl = tweetEl.querySelector('.tweet-interactions, [class*="interaction"]');
    const name = nameEl ? nameEl.textContent.trim() : '未知用户';
    const avatarLetter = (name.charAt(0) || '?').toUpperCase();
    const avatarImg = tweetEl.querySelector('.tweet-avatar-wrap img, [class*="avatar"] img');
    const avatarHtml = (avatarImg && avatarImg.src)
        ? `<img src="${Moments.store.escapeAttrUrl(avatarImg.src)}" alt="">`
        : `<span>${Moments.store.escapeHtmlMoments(avatarLetter)}</span>`;
    const avStyle = (avatarWrap && avatarWrap.getAttribute('style')) || 'background:#1d9bf0';

    let repliesEl = tweetEl.querySelector('.tweet-replies, .replies, [class*="tweet-repl"]');
    let commentsHtml = '';
    if (repliesEl) commentsHtml = repliesEl.innerHTML;
    if (!commentsHtml) {
        const replyNodes = tweetEl.querySelectorAll('.tweet-reply, .twitter-x-reply');
        if (replyNodes.length) commentsHtml = Array.from(replyNodes).map(n => n.outerHTML).join('');
    }

    detailContent.innerHTML = `
        <div class="tweet">
            <div class="tweet-avatar-col">
                <div class="tweet-avatar-wrap" style="${(avStyle || '').replace(/"/g, '&quot;')}">
                    ${avatarHtml}
                </div>
            </div>
            <div class="tweet-content-col">
                <div class="tweet-header">
                    <span class="tweet-name">${Moments.store.escapeHtmlMoments(name)}</span>
                    <span class="tweet-handle">${Moments.store.escapeHtmlMoments(handleEl ? handleEl.textContent.trim() : '')}</span>
                    <span class="tweet-time">${Moments.store.escapeHtmlMoments(timeEl ? timeEl.textContent.trim() : '')}</span>
                </div>
                <div class="tweet-text">${textEl ? textEl.innerHTML : ''}</div>
                ${interactionsEl ? `<div class="tweet-interactions">${interactionsEl.innerHTML}</div>` : ''}
            </div>
        </div>
        ${commentsHtml ? `<div class="twitter-comments-section"><div class="twitter-comments-title">评论</div><div class="tweet-replies">${commentsHtml}</div></div>` : ''}
    `;
    const payload = payloadOpt || extractTwitterTweetPayload(tweetEl);
    const cacheKey = payload ? _twitterDetailCacheKey(payload, 0) : '';
    twitterSetDetailPageContext(payload, cacheKey);
    twitterPrepareTwitterDetailBody(detailContent);
    twitterApplyDetailExtraHtml(detailContent, cacheKey);
    detailPage.classList.add('show');
    initTwitterCommentBar();
}

function renderTwitterFeed(feedKind, html) {
    const feedIdMap = { following: 'twitter-body-following', forYou: 'twitter-body-foryou', entertainment: 'twitter-body-entertainment' };
    const el = document.getElementById(feedIdMap[feedKind] || 'twitter-body-foryou');
    if (!el) return false;
    const raw = String(html || '').trim();
    const normalized = normalizeTwitterHtmlString(sanitizeTwitterApiHtmlOutput(stripTwitterApiHtmlFence(raw)));
    if (!twitterApiOutputHasTimelineHtml(normalized)) {
        showNotification('推文格式异常（返回了样式代码而非 HTML），请重试');
        return false;
    }
    if (feedKind === 'following') {
        const merged = s().appendFollowingFeedBatch(normalized);
        el.innerHTML = merged;
    } else {
        el.innerHTML = normalized;
        const feeds = getTwitterFeedsFromStorage();
        feeds[feedKind] = el.innerHTML;
        saveTwitterFeedsToStorage(feeds);
    }
    twitterPrepareTimelineFeedBody(el);
    return true;
}

/* 上次进入时各信息流已渲染到 DOM 的存储原文；未变化则跳过 innerHTML 重建与整树后处理 */
var _twitterEnterRenderedFeeds = { following: null, forYou: null, entertainment: null };

function onEnterTwitterPage() {
    if (typeof switchTwitterBottomTab === 'function') {
        switchTwitterBottomTab('home');
    }
    const feeds = getTwitterFeedsFromStorage();
    const feedIdMap = { following: 'twitter-body-following', forYou: 'twitter-body-foryou', entertainment: 'twitter-body-entertainment' };
    let clearedInvalid = false;
    Object.keys(feeds).forEach(kind => {
        const el = document.getElementById(feedIdMap[kind]);
        if (!el) return;
        const stored = String(feeds[kind] || '');
        // DOM 已是该存储版本（页面切换不清空 DOM），无需重新解析/渲染
        if (stored === _twitterEnterRenderedFeeds[kind]) return;
        if (!stored.trim()) {
            _twitterEnterRenderedFeeds[kind] = stored;
            return;
        }
        const restored = normalizeTwitterHtmlString(sanitizeTwitterApiHtmlOutput(stored));
        if (twitterApiOutputHasTimelineHtml(restored)) {
            el.innerHTML = restored;
            twitterPrepareTimelineFeedBody(el);
        } else {
            el.innerHTML = '';
            feeds[kind] = '';
            clearedInvalid = true;
        }
        _twitterEnterRenderedFeeds[kind] = feeds[kind];
    });
    if (clearedInvalid) saveTwitterFeedsToStorage(feeds);
    twitterRenderUserProfilePanels();
    toggleTwitterComposeButton('home');
}

function refreshTwitter(controller) {
    const feedKind = getCurrentTwitterFeedKind();
    const feedIdMap = { following: 'twitter-body-following', forYou: 'twitter-body-foryou', entertainment: 'twitter-body-entertainment' };
    const body = document.getElementById(feedIdMap[feedKind]);
    if (!body) return;

    const content = CommandManager.buildTwitterSendContent(feedKind);
    if (!content) {
        if (feedKind === 'following') {
            showNotification('关注页无法刷新：请先在个人主页「我」中点击「正在关注」，勾选至少一位好友');
        }
        return;
    }

    const btn = document.getElementById('twitter-refresh-btn');
    if (btn) btn.classList.add('refreshing');

    (async () => {
        let html = null;
        try {
            const ctrl = controller || new AbortController();
            const promptSizeKb = Math.round(content.length / 1024);
            const estTokens = Math.ceil(content.length / 4) + 2;
            const TWITTER_PROMPT_WARN_KB = 420;
            const TWITTER_PROMPT_BLOCK_KB = 720;
            if (promptSizeKb > TWITTER_PROMPT_BLOCK_KB || estTokens > 185000) {
                if (btn) btn.classList.remove('refreshing');
                showNotification('请求内容过大（' + promptSizeKb + 'KB / ~' + estTokens + ' tokens），请减少好友数量或聊天记录条数后再试。');
                return;
            }
            if (promptSizeKb > TWITTER_PROMPT_WARN_KB || estTokens > 140000) {
                console.warn('[refreshTwitter] prompt size=' + promptSizeKb + 'KB est_tokens≈' + estTokens);
            }
            const raw = await FeatureCommandMapper.callApiModel(content, ctrl, {
                skipOverlay: true
            });
            if (raw && typeof raw === 'string') html = raw.trim();
        } catch (e) { console.error('refreshTwitter failed', e); }
        if (btn) btn.classList.remove('refreshing');
        if (html) {
            renderTwitterFeed(feedKind, html);
        } else {
            showNotification('推文生成失败，请重试');
        }
    })();
}

async function openTwitterDetail(tweetEl, clickedIndex) {
    if (!tweetEl) return;
    const detailPage = document.getElementById('twitter-detail-page');
    const detailContent = document.getElementById('twitter-detail-content');
    if (!detailPage || !detailContent) {
        console.error('[Twitter详情] 未找到详情页 DOM，detailPage=', detailPage, 'detailContent=', detailContent);
        return;
    }

    try {
        if (window.__twitterDetailAbort && typeof window.__twitterDetailAbort.abort === 'function') {
            window.__twitterDetailAbort.abort();
        }
    } catch (e) {}
    const ac = new AbortController();
    window.__twitterDetailAbort = ac;

    const payload = extractTwitterTweetPayload(tweetEl);
    if (!payload) {
        console.error('[Twitter详情] extractTwitterTweetPayload 返回空，tweetEl=', tweetEl);
        return;
    }

    // 先算索引，再将索引纳入缓存 Key，避免不同位置的同一内容互相覆盖
    const idx = (typeof clickedIndex === 'number' && clickedIndex >= 0) ? clickedIndex : 0;
    const cacheKey = _twitterDetailCacheKey(payload, idx);
    twitterSetDetailPageContext(payload, cacheKey);
    window.__twitterUserPostContext = null;
    window.__twitterReplyTargetCommentId = '';
    window.__twitterReplyTargetFriendId = '';
    console.log('[Twitter详情] 开始，payload.displayName=', payload.displayName, 'handle=', payload.handle, 'idx=', idx, 'cacheKey=', cacheKey);

    // 每次打开都清空旧内容，防止残留
    detailContent.innerHTML = '';

    if (cacheKey && Twitter.store._twitterDetailCache[cacheKey]) {
        // 缓存命中时，用正文哈希二次校验——如果推文正文与缓存时不符，说明是同 key 不同内容（如同好友多帖），放弃缓存重新请求
        const cachedTextHash = Twitter.store._twitterDetailCache[cacheKey].textHash || '';
        const currentTextHash = (function () {
            try {
                return ((tweetEl ? tweetEl.textContent || '' : '').replace(/\s+/g, ' ').trim().slice(0, 200));
            } catch (e) { return ''; }
        })();
        if (cachedTextHash && currentTextHash && cachedTextHash !== currentTextHash) {
            console.warn('[Twitter详情] 缓存 key 命中但正文不匹配（同 key 不同帖），放弃缓存，重新请求');
            delete Twitter.store._twitterDetailCache[cacheKey];
        } else {
            console.log('[Twitter详情] 命中内存缓存，使用缓存渲染');
            detailPage.classList.add('show');
            const cachedHtml = normalizeTwitterHtmlString(sanitizeTwitterApiHtmlOutput(Twitter.store._twitterDetailCache[cacheKey].html));
            detailContent.innerHTML = twitterKeepNthTweet(cachedHtml, idx);
            twitterPrepareTwitterDetailBody(detailContent);
            twitterApplyDetailExtraHtml(detailContent, cacheKey);
            initTwitterCommentBar();
            return;
        }
    }

    detailPage.classList.add('show');
    detailContent.innerHTML = '<div class="twitter-detail-loading"><div class="twitter-detail-loading-spinner" aria-hidden="true"></div><p class="twitter-detail-loading-text">正在生成推文详情页…</p></div>';

    const sendContent = CommandManager.buildTwitterDetailPageSendContent(payload);
    if (!sendContent) {
        console.error('[Twitter详情] buildTwitterDetailPageSendContent 返回空，使用本地兜底');
        renderTwitterDetailFallback(tweetEl, payload);
        return;
    }
    console.log('[Twitter详情] 已组装详情页指令，约', Math.round(sendContent.length / 1024), 'KB，cacheKey=', cacheKey);

    let html = null;
    try {
        const raw = await FeatureCommandMapper.callApiModel(sendContent, ac, { skipOverlay: true });
        if (raw && typeof raw === 'string') html = sanitizeTwitterApiHtmlOutput(stripTwitterApiHtmlFence(raw.trim()));
    } catch (e) {
        if (e && e.name === 'AbortError') {
            console.warn('[Twitter详情] 请求被中止（AbortError）');
            return;
        }
        console.error('[Twitter详情] API 调用出错:', e);
    }

    if (window.__twitterDetailAbort !== ac) {
        console.warn('[Twitter详情] AbortController 已变更，跳过本次结果');
        return;
    }

    if (html) {
        const detailHtml = sanitizeTwitterApiHtmlOutput(html);
        const hasReplyMarkers = /tweet-reply|twitter-x-reply|twitter-comments-section/i.test(detailHtml);
        console.log('[Twitter详情] 模型返回 HTML，长度=', detailHtml.length, '含评论类名=', hasReplyMarkers);
        if (!hasReplyMarkers) console.warn('[Twitter详情] 警告：返回的 HTML 中没有 tweet-reply / twitter-x-reply / twitter-comments-section 类名！');
        if (cacheKey) {
            const tweetTextHash = (function () {
                try {
                    return ((tweetEl ? tweetEl.textContent || '' : '').replace(/\s+/g, ' ').trim().slice(0, 200));
                } catch (e) { return ''; }
            })();
            Twitter.store._twitterDetailCache[cacheKey] = { html: detailHtml, ts: Date.now(), textHash: tweetTextHash };
        }
        detailContent.innerHTML = twitterKeepNthTweet(normalizeTwitterHtmlString(detailHtml), idx);
        twitterPrepareTwitterDetailBody(detailContent);
        twitterApplyDetailExtraHtml(detailContent, cacheKey);
        initTwitterCommentBar();
    } else {
        console.error('[Twitter详情] 模型未返回有效 HTML（可能 API 失败/超时/被拦截），已降级本地预览');
        showNotification('推文详情生成失败，已显示本地预览');
        renderTwitterDetailFallback(tweetEl, payload);
    }
}

/** 对一个推文的全部头像占位容器，隐藏失效 <img> 并在容器内显示首字母占位 */
function twitterApplyAvatarLetterFallbackToTweet(tweet) {
    if (!tweet || tweet.nodeType !== Node.ELEMENT_NODE) return;
    tweet.querySelectorAll('img[src]').forEach(img => {
        const src = (img.getAttribute('src') || '').trim();
        // 跳过 data/blob 图片（本地头像没问题，不需要兜底）
        if (src.startsWith('data:') || src.startsWith('blob:')) return;
        // http(s) 外链头像由 twitterWireTweetAvatarImgFallbacks 处理，这里只处理空 src
        if (!src) twitterApplyTweetAvatarLetterFallback(img);
    });
}

/* ── 推特详情页：用户评论输入 ─────────────────────────────── */
function initTwitterCommentBar() {
    var avatarEl = document.getElementById('twitter-comment-avatar');
    var input = document.getElementById('twitter-comment-input');
    if (!avatarEl || !input) return;

    // 防止多次调用时重复绑定事件（每次打开详情页重新进入时触发）
    if (input.dataset.twitterCommentBarBound) return;
    input.dataset.twitterCommentBarBound = '1';

    // 头像：优先用户自定义头像，其次微信头像
    var twProfile = loadTwitterProfile() || {};
    var userInfo = safeReadJsonFromStorage('userInfo', null);
    var avatarSrc = twProfile.avatarDataUrl || (userInfo && userInfo.avatar) || '';
    if (avatarSrc) {
        avatarEl.innerHTML = '<img src="' + avatarSrc + '" alt="" style="width:100%;height:100%;object-fit:cover;">';
    } else {
        var myP = safeReadJsonFromStorage('myProfile', null);
        var letter = (myP && myP.nickname && myP.nickname.charAt(0)) || '我';
        avatarEl.textContent = letter;
    }

    // textarea 自动增高
    input.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 120) + 'px';
    });

    // 回车（非 Shift+Enter）提交
    input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submitTwitterUserComment();
        }
    });
}

function submitTwitterUserComment() {
    var input = document.getElementById('twitter-comment-input');
    var btn = document.getElementById('twitter-comment-submit-btn');
    if (!input || !btn) return;
    var text = input.value.trim();
    if (!text) return;

    // 禁用按钮防止重复提交
    btn.disabled = true;

    // 获取用户头像和昵称
    var twProfile = loadTwitterProfile() || {};
    var userInfo = safeReadJsonFromStorage('userInfo', null);
    var myProfile = safeReadJsonFromStorage('myProfile', null);
    var displayName = twProfile.displayName || myProfile && myProfile.nickname || '用户';
    var handle = getEffectiveTwitterUserHandle(twProfile);
    var avatarSrc = twProfile.avatarDataUrl || (userInfo && userInfo.avatar) || '';
    var letter = displayName.charAt(0);

    // 头像
    var avatarHtml;
    if (avatarSrc) {
        avatarHtml = '<img src="' + avatarSrc + '" alt="" style="width:100%;height:100%;object-fit:cover;">';
    } else {
        avatarHtml = letter;
    }

    try { window.__twitterReplyParentHint = ''; } catch (e1) {}
    if (typeof document !== 'undefined') {
        var inpPh = document.getElementById('twitter-comment-input');
        if (inpPh) inpPh.placeholder = '发布你的评论…';
    }

    var userPostCtx = window.__twitterUserPostContext;
    if (userPostCtx && userPostCtx.postId) {
        var post = getTwitterUserPostById(userPostCtx.postId);
        if (!post) {
            btn.disabled = false;
            return;
        }
        var targetCommentId = String(window.__twitterReplyTargetCommentId || '');
        var targetFriendId = String(window.__twitterReplyTargetFriendId || '');
        var targetComment = targetCommentId ? (post.comments || []).find(function (c) { return String(c.id) === targetCommentId; }) : null;
        appendTwitterUserPostComments(post.id, [{
            id: 'twc_user_' + Date.now(),
            authorName: displayName,
            handle: handle,
            text: text,
            role: 'user',
            createdAt: Date.now(),
            replyToCommentId: targetCommentId || '',
            replyToAuthorName: targetComment && targetComment.authorName ? targetComment.authorName : ''
        }]);
        twitterRenderUserProfilePanels();
        refreshTwitterUserPostDetailIfOpen(post.id);
        input.value = '';
        input.style.height = 'auto';
        window.__twitterReplyTargetCommentId = '';
        window.__twitterReplyTargetFriendId = '';
        if (inpPh) inpPh.placeholder = '回复评论…';
        btn.disabled = false;

        if (targetFriendId && typeof CommandManager !== 'undefined' && typeof CommandManager.buildTwitterFriendReplyToUserOwnPostCommentSendContent === 'function') {
            var friend = loadFriendsFromStorage().find(function (f) { return String(f.id) === targetFriendId; });
            var sendContent = friend ? CommandManager.buildTwitterFriendReplyToUserOwnPostCommentSendContent(friend, {
                tweetPlainText: post.text || '',
                friendCommentText: targetComment && targetComment.text ? targetComment.text : '',
                userReplyText: text
            }) : null;
            if (sendContent) {
                setTimeout(function () {
                    FeatureCommandMapper.callApiModel(sendContent, new AbortController(), { skipOverlay: true }).then(function (raw) {
                        if (!raw || typeof raw !== 'string') return;
                        var friendText = stripTwitterApiHtmlFence(String(raw).trim()).replace(/<[^>]+>/g, '').trim();
                        if (!friendText) return;
                        appendTwitterUserPostComments(post.id, [{
                            id: 'twc_friend_' + Date.now(),
                            friendId: String(friend.id),
                            authorName: twitterResolveFriendAuthorDisplayName(friend) || friend.remark || friend.nickname || '好友',
                            handle: defaultTwitterFriendHandle(friend),
                            text: friendText,
                            role: 'friend',
                            createdAt: Date.now(),
                            replyToCommentId: targetCommentId || '',
                            replyToAuthorName: displayName
                        }]);
                        twitterRenderUserProfilePanels();
                        refreshTwitterUserPostDetailIfOpen(post.id);
                    }).catch(function (e) {
                        if (e && e.name !== 'AbortError') console.error('twitter own-post friend follow-up failed', e);
                    });
                }, 280);
            }
        }
        return;
    }

    var commentHtml =
        '<div class="twitter-user-comment-block" style="display:flex;gap:10px;align-items:flex-start;padding:10px 0;border-top:1px solid #eff3f4;">' +
        '  <div style="width:40px;height:40px;border-radius:50%;background:#1d9bf0;display:flex;align-items:center;justify-content:center;color:#fff;font-size:16px;font-weight:700;flex-shrink:0;overflow:hidden;">' + avatarHtml + '</div>' +
        '  <div style="flex:1;min-width:0;">' +
        '    <div style="display:flex;align-items:center;gap:4px;">' +
        '      <span style="font-weight:700;font-size:15px;color:#0f1419;">' + escHtml(displayName) + '</span>' +
        '      <span style="font-size:14px;color:#536471;">@' + escHtml(handle) + ' · 刚刚</span>' +
        '    </div>' +
        '    <div style="margin-top:3px;font-size:15px;line-height:1.5;color:#0f1419;">' + escHtml(text) + '</div>' +
        '  </div>' +
        '</div>';

    var detailContent = document.getElementById('twitter-detail-content');
    if (detailContent) {
        detailContent.insertAdjacentHTML('beforeend', commentHtml);
        // 滚动到底部
        detailContent.scrollTop = detailContent.scrollHeight;
    }

    // 持久化：同推文详情缓存键保存用户评论
    var ck = window.__twitterDetailCacheKey || '';
    if (ck) twitterAppendDetailExtraHtml(ck, commentHtml);

    // 触发好友回复 API（传入推文正文纯文、用户留言文本、好友对象）
    var friend = window.__twitterDetailFriend || null;
    var tweetTextPlain = window.__twitterDetailPayload ? twitterStripHtmlToPlain(window.__twitterDetailPayload.textHtml || '') : '';
    if (friend) {
        var userLine = text;
        var ac2 = new AbortController();
        var ctrl = ac2;
        var friendReplyContent = CommandManager.buildTwitterFriendReplyToUserCommentSendContent(friend, {
            tweetPlainText: tweetTextPlain,
            userCommentText: userLine,
            replyParentHint: (typeof window.__twitterReplyParentHint === 'string' ? window.__twitterReplyParentHint : '') || ''
        });
        if (friendReplyContent) {
            (function (fr, ac_inner, sendContent) {
                setTimeout(function () {
                    FeatureCommandMapper.callApiModel(sendContent, ac_inner, { skipOverlay: true }).then(function (raw) {
                        if (!raw || typeof raw !== 'string') return;
                        var h = sanitizeTwitterApiHtmlOutput(stripTwitterApiHtmlFence(raw.trim()));
                        if (!h) return;
                        var wrapper = '<div class="tweet-reply twitter-x-reply twitter-friend-reply-to-user">' + h + '</div>';
                        var dc = document.getElementById('twitter-detail-content');
                        if (dc) {
                            dc.insertAdjacentHTML('beforeend', wrapper);
                            twitterPrepareTwitterDetailBody(dc);
                            dc.scrollTop = dc.scrollHeight;
                        }
                        var ck2 = window.__twitterDetailCacheKey || '';
                        if (ck2) twitterAppendDetailExtraHtml(ck2, wrapper);
                    }).catch(function (e) { if (e && e.name !== 'AbortError') console.error('twitter friend reply failed', e); });
                }, 300);
            })(friend, ac2, friendReplyContent);
        }
    }

    // 清空输入
    input.value = '';
    input.style.height = 'auto';
    btn.disabled = false;
}

/* Twitter：feed 点击兜底（事件委托失败时仍可捕获）；诊断日志需 localStorage.twitterDebug=1 */
(function twitterDebugBootstrap() {
    var dbg = false;
    try { dbg = localStorage.getItem('twitterDebug') === '1'; } catch (_) {}
    if (dbg) {
        console.log('[Twitter诊断] openTwitterDetail=', typeof openTwitterDetail);
        console.log('[Twitter诊断] callApiModel=', typeof FeatureCommandMapper.callApiModel);
        console.log('[Twitter诊断] buildTwitterDetailPageSendContent=', typeof CommandManager.buildTwitterDetailPageSendContent);
    }

    ['twitter-body-following', 'twitter-body-foryou', 'twitter-body-entertainment'].forEach(function (bodyId) {
        var body = document.getElementById(bodyId);
        if (!body) return;
        body.addEventListener('click', function (e) {
            var tweet = e.target.closest('.tweet');
            if (!tweet) return;
            if (dbg) console.log('[Twitter兜底-' + bodyId + ']', e.target.tagName, e.target.className);
        });
    });
})();

function escHtml(str) {
    if (!str) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function closeTwitterDetail() {
    try {
        if (window.__twitterDetailAbort && typeof window.__twitterDetailAbort.abort === 'function') {
            window.__twitterDetailAbort.abort();
        }
    } catch (e) {}
    window.__twitterDetailAbort = null;
    const detailPage = document.getElementById('twitter-detail-page');
    if (detailPage) detailPage.classList.remove('show');

    // 清空评论输入框（但保留 detailContent 中的用户评论和 API 评论区）
    var input = document.getElementById('twitter-comment-input');
    if (input) { input.value = ''; input.style.height = 'auto'; }
    window.__twitterUserPostContext = null;
    window.__twitterReplyTargetCommentId = '';
    window.__twitterReplyTargetFriendId = '';
    window.__twitterReplyParentHint = '';
}

document.addEventListener('click', function twitterTimelineClickDelegate(e) {
    const page = document.getElementById('twitter-page');
    if (!page || !page.classList.contains('active')) return;

    const feedViews = ['twitter-body-following', 'twitter-body-foryou', 'twitter-body-entertainment'];
    const activeBodyId = feedViews.find(id => {
        const el = document.getElementById(id);
        return el && el.contains(e.target);
    });
    if (!activeBodyId) return;
    const body = document.getElementById(activeBodyId);

    if (e.target.closest('a[href]')) return;
    if (e.target.closest('.tweet-interactions, [class*="interaction"]')) return;

    const fromMain = e.target.closest('.tweet-main');
    let tweet = fromMain
        ? (fromMain.closest('.tweet') || fromMain)
        : e.target.closest('.tweet');
    if (!tweet || !body.contains(tweet)) return;

    // 计算被点击推文在 feed 中的索引（用于详情页只展示该帖）。
    // 优先使用 twitterEnsureFeedStructure / twitterPromoteNestedTimelineRoots 写入的 data-twitter-thread-root，
    // 避免模型把整页包在一个 .tweet 里时 topTweets 只有 1 条、索引恒为 0。
    const container = body.querySelector(':scope > .tweet-container') || body;
    const allTweets = Array.from(container.querySelectorAll('.tweet'));
    let topTweets = Array.from(container.querySelectorAll('[data-twitter-thread-root="1"]'));
    if (!topTweets.length) {
        topTweets = allTweets.filter(t => {
            let p = t.parentElement;
            while (p && p !== container) {
                if (allTweets.includes(p)) return false;
                p = p.parentElement;
            }
            return true;
        });
    }
    // 如果点击的是嵌套推文，逐层向外找最近的顶层推文
    let root = tweet;
    while (root && !topTweets.includes(root) && root.parentElement && root.parentElement !== container) {
        root = root.parentElement;
    }
    if (!root || !topTweets.includes(root)) return;
    const clickedIndex = topTweets.indexOf(root);
    console.log('[Twitter点击] 点击推文，activeBodyId=', activeBodyId,
        'allTweets.length=', allTweets.length,
        'topTweets.length=', topTweets.length,
        'clickedIndex=', clickedIndex,
        'displayName=', (tweet.querySelector('.tweet-name') || tweet).textContent.trim().slice(0, 20));

    e.preventDefault();
    void openTwitterDetail(root, clickedIndex);
}, false);

document.addEventListener('click', function twitterProfileUserPostDelegate(e) {
    const card = e.target.closest('.twitter-user-post-card, .twitter-user-reply-activity');
    if (!card) return;
    const postId = card.getAttribute('data-twitter-user-post-id');
    if (!postId) return;
    e.preventDefault();
    openTwitterUserPostDetail(postId);
}, false);

/* 详情页评论区：点击他人评论行 → 设置回复上下文到输入框占位 */
document.addEventListener('click', function twitterDetailReplyDelegate(e) {
    const detailPage = document.getElementById('twitter-detail-page');
    if (!detailPage || !detailPage.classList.contains('show')) return;
    const replyRow = e.target.closest('.tweet-reply, .twitter-x-reply, .twitter-friend-reply-to-user');
    if (!replyRow) return;
    if (e.target.closest('a[href]')) return;
    const nameEl = replyRow.querySelector('.tweet-name, [class*="tweet-name"], span[style*="font-weight:700"], span[style*="font-weight: 700"]');
    const name = nameEl ? (nameEl.textContent || '').trim() : '';
    const inp = document.getElementById('twitter-comment-input');
    if (inp) {
        const isUserPostDetail = !!(window.__twitterUserPostContext && window.__twitterUserPostContext.postId);
        const role = replyRow.getAttribute('data-comment-role') || '';
        const friendId = replyRow.getAttribute('data-friend-id') || '';
        const commentId = replyRow.getAttribute('data-comment-id') || '';
        if (isUserPostDetail && role === 'friend' && friendId && name) {
            inp.placeholder = '回复 @' + name + '…';
            window.__twitterReplyParentHint = name;
            window.__twitterReplyTargetFriendId = friendId;
            window.__twitterReplyTargetCommentId = commentId;
        } else if (!isUserPostDetail && name) {
            inp.placeholder = '回复 @' + name + '…';
            window.__twitterReplyParentHint = name;
            window.__twitterReplyTargetFriendId = '';
            window.__twitterReplyTargetCommentId = '';
        } else {
            inp.placeholder = isUserPostDetail ? '回复评论…' : '发布你的评论…';
            window.__twitterReplyParentHint = '';
            window.__twitterReplyTargetFriendId = '';
            window.__twitterReplyTargetCommentId = '';
        }
    }
}, false);

    var ui = {
        getCurrentTwitterFeedKind: getCurrentTwitterFeedKind,
        switchTwitterFeedTab: switchTwitterFeedTab,
        switchTwitterBottomTab: switchTwitterBottomTab,
        switchTwitterProfileSubTab: switchTwitterProfileSubTab,
        ensureTwitterJoinedSelectsPopulated: ensureTwitterJoinedSelectsPopulated,
        refreshTwitterProfileUI: refreshTwitterProfileUI,
        openTwitterFollowingPicker: openTwitterFollowingPicker,
        saveTwitterFollowingPicker: saveTwitterFollowingPicker,
        closeTwitterFollowingPicker: closeTwitterFollowingPicker,
        openTwitterProfileEdit: openTwitterProfileEdit,
        closeTwitterProfileEdit: closeTwitterProfileEdit,
        saveTwitterProfileEdit: saveTwitterProfileEdit,
        openTwitterComposer: openTwitterComposer,
        closeTwitterComposer: closeTwitterComposer,
        updateTwitterComposeCount: updateTwitterComposeCount,
        submitTwitterComposer: submitTwitterComposer,
        triggerTwitterBannerUpload: triggerTwitterBannerUpload,
        triggerTwitterAvatarUpload: triggerTwitterAvatarUpload,
        handleTwitterBannerUpload: handleTwitterBannerUpload,
        handleTwitterAvatarUpload: handleTwitterAvatarUpload,
        normalizeTwitterHtmlString: normalizeTwitterHtmlString,
        initTwitterFeedAfterInsert: initTwitterFeedAfterInsert,
        stripTwitterApiHtmlFence: stripTwitterApiHtmlFence,
        twitterLooksLikeRawCssBlob: twitterLooksLikeRawCssBlob,
        twitterStripCssFromApiOutput: twitterStripCssFromApiOutput,
        twitterApiOutputHasTimelineHtml: twitterApiOutputHasTimelineHtml,
        sanitizeTwitterApiHtmlOutput: sanitizeTwitterApiHtmlOutput,
        twitterKeepNthTweet: twitterKeepNthTweet,
        twitterKeepNthTweetFromResult: twitterKeepNthTweetFromResult,
        twitterKeepOnlyFirstTweet: twitterKeepOnlyFirstTweet,
        extractTwitterTweetPayload: extractTwitterTweetPayload,
        renderTwitterDetailFallback: renderTwitterDetailFallback,
        renderTwitterFeed: renderTwitterFeed,
        onEnterTwitterPage: onEnterTwitterPage,
        refreshTwitter: refreshTwitter,
        openTwitterDetail: openTwitterDetail,
        initTwitterCommentBar: initTwitterCommentBar,
        submitTwitterUserComment: submitTwitterUserComment,
        closeTwitterDetail: closeTwitterDetail,
        buildTwitterSharePayloadFromDetailPage: buildTwitterSharePayloadFromDetailPage,
        shareTwitterToWeChat: shareTwitterToWeChat,
        shareTwitterDetailToWeChat: shareTwitterDetailToWeChat
    };

    global.Twitter = global.Twitter || {};
    global.Twitter.ui = ui;

    /** index.html onclick 仍用全局名 */
    global.getCurrentTwitterFeedKind = getCurrentTwitterFeedKind;
    global.switchTwitterFeedTab = switchTwitterFeedTab;
    global.switchTwitterBottomTab = switchTwitterBottomTab;
    global.switchTwitterProfileSubTab = switchTwitterProfileSubTab;
    global.refreshTwitterProfileUI = refreshTwitterProfileUI;
    global.openTwitterFollowingPicker = openTwitterFollowingPicker;
    global.saveTwitterFollowingPicker = saveTwitterFollowingPicker;
    global.closeTwitterFollowingPicker = closeTwitterFollowingPicker;
    global.openTwitterProfileEdit = openTwitterProfileEdit;
    global.closeTwitterProfileEdit = closeTwitterProfileEdit;
    global.saveTwitterProfileEdit = saveTwitterProfileEdit;
    global.openTwitterComposer = openTwitterComposer;
    global.closeTwitterComposer = closeTwitterComposer;
    global.updateTwitterComposeCount = updateTwitterComposeCount;
    global.submitTwitterComposer = submitTwitterComposer;
    global.triggerTwitterBannerUpload = triggerTwitterBannerUpload;
    global.triggerTwitterAvatarUpload = triggerTwitterAvatarUpload;
    global.handleTwitterBannerUpload = handleTwitterBannerUpload;
    global.handleTwitterAvatarUpload = handleTwitterAvatarUpload;
    global.normalizeTwitterHtmlString = normalizeTwitterHtmlString;
    global.renderTwitterFeed = renderTwitterFeed;
    global.onEnterTwitterPage = onEnterTwitterPage;
    global.refreshTwitter = refreshTwitter;
    global.openTwitterDetail = openTwitterDetail;
    global.submitTwitterUserComment = submitTwitterUserComment;
    global.closeTwitterDetail = closeTwitterDetail;
    global.shareTwitterToWeChat = shareTwitterToWeChat;
    global.shareTwitterDetailToWeChat = shareTwitterDetailToWeChat;
    global.extractTwitterTweetPayload = extractTwitterTweetPayload;
    global.initTwitterFeedAfterInsert = initTwitterFeedAfterInsert;
    if (typeof global.escHtml !== 'function') {
        global.escHtml = escHtml;
    }
})(typeof window !== 'undefined' ? window : globalThis);
