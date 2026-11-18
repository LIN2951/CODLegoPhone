/**
 * Lego 小手机 · 微信朋友圈 — UI 与事件（阶段 2）
 *
 * 仅操作 DOM；数据经 Moments.store 读写。依赖 app.js 提供的全局函数：
 * safeReadJsonFromStorage、loadFriendsFromStorage、parseJsonFromPossiblyEncodedStorage、
 * formatFavoriteTime、normalizeWechatPolaroidDom、attachWechatPolaroidImgGuards、
 * showNotification、showErrorDialog、CommandManager、FeatureCommandMapper、extractJsonObjectFromApiText、
 * refreshMomentsFeedFromApi（本文件内实现，并挂到 window 供兼容）。
 *
 * EMOJI_DATA_LS_KEY 在 app.js 中定义；本文件在运行时使用（晚于 app 加载）。
 * 阶段 5：时间线首屏 + 滚动增量挂载（见 MOMENTS_FEED_PAGE_SIZE、moments-ins-scroll）。
 */
(function (global) {
    'use strict';

    var WECHAT_LS_MOMENTS_COVER = 'momentsCoverImageDataUrl';

    var momentsPendingImages = [];
    var momentsCommentingPostId = null;
    var momentsCommentingReplyTo = null;

    /** 时间线首屏条数，向下滚动再增量挂载 DOM（海量历史时减轻卡顿） */
    var MOMENTS_FEED_PAGE_SIZE = 50;
    var momentsFeedPage = { allPosts: [], offset: 0, onScroll: null, scrollEl: null };

    var momentsForwardTargetIds = null;
    var momentsForwardPayloadJson = null;

    function store() {
        return global.Moments && global.Moments.store;
    }

    /** 用于 onclick="foo('…')" 内单层 JS 字符串，避免 JSON.stringify 的双引号截断 HTML 属性 */
    function escapeForHtmlOnclickSingleQuoted(s) {
        return String(s)
            .replace(/\\/g, '\\\\')
            .replace(/'/g, "\\'")
            .replace(/\r/g, '\\r')
            .replace(/\n/g, '\\n');
    }

    function momentsCollectAllEmojis() {
        var key = typeof EMOJI_DATA_LS_KEY !== 'undefined' ? EMOJI_DATA_LS_KEY : 'emojiData';
        var emojiData = parseJsonFromPossiblyEncodedStorage(key, {});
        var all = [];
        for (var category in emojiData) {
            all = all.concat(emojiData[category] || []);
        }
        return all;
    }

    function momentsFormatPostTextForDisplay(raw, emojiList) {
        if (!raw) return '';
        var resolved = typeof resolveEmojiRefsInMessage === 'function'
            ? resolveEmojiRefsInMessage(String(raw), emojiList)
            : String(raw);
        var esc = store().escapeHtmlMoments;
        if (!resolved.includes('<img')) {
            return esc(resolved).replace(/\n/g, '<br>');
        }
        var parts = resolved.split(/(<img\b[^>]*\/?>)/gi);
        return parts.map(function (p) {
            if (/^<img\b/i.test(p)) return p;
            return esc(p).replace(/\n/g, '<br>');
        }).join('');
    }

    function applyMomentsCoverFromStorage() {
        var bg = document.getElementById('moments-cover-bg');
        var hint = document.getElementById('moments-cover-hint');
        var dataUrl = localStorage.getItem(WECHAT_LS_MOMENTS_COVER) || '';
        if (!bg) return;
        if (dataUrl) {
            bg.style.backgroundImage = 'url(' + JSON.stringify(dataUrl) + ')';
            bg.classList.add('has-cover');
            if (hint) hint.style.display = 'none';
        } else {
            bg.style.backgroundImage = '';
            bg.classList.remove('has-cover');
            if (hint) hint.style.display = '';
        }
    }

    function refreshMomentsProfileHeader() {
        var userInfo = safeReadJsonFromStorage('userInfo', {});
        var nick = userInfo.nickname || '可点击编辑';
        var nameEl = document.getElementById('moments-ins-nickname');
        if (nameEl) nameEl.textContent = nick;
        var img = document.getElementById('moments-ins-avatar-img');
        var ph = document.getElementById('moments-ins-avatar-ph');
        if (userInfo.avatar) {
            if (img) {
                img.src = userInfo.avatar;
                img.style.display = 'block';
            }
            if (ph) ph.style.display = 'none';
        } else {
            if (img) img.style.display = 'none';
            if (ph) {
                ph.style.display = 'flex';
                var ch = (nick && nick !== '可点击编辑') ? nick.charAt(0) : '我';
                ph.textContent = ch;
            }
        }
    }

    function triggerMomentsCoverUpload(event) {
        if (event) event.stopPropagation();
        document.getElementById('moments-cover-input') && document.getElementById('moments-cover-input').click();
    }

    function onMomentsCoverAreaClick(event) {
        if (event.target.closest('.moments-cover-bottom-meta')) return;
        triggerMomentsCoverUpload(event);
    }

    function toggleMomentsPostMenu(ev) {
        if (!ev) return;
        ev.preventDefault();
        ev.stopPropagation();
        var btn = ev.currentTarget;
        var wrap = btn.closest('.moments-post-more-wrap');
        var menu = wrap && wrap.querySelector('.moments-post-menu');
        if (!menu) return;
        var willOpen = !menu.classList.contains('is-open');
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        if (willOpen) menu.classList.add('is-open');
    }

    function momentsMenuActionLike(ev, postId) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        toggleMomentsLike(String(postId));
    }

    function momentsMenuActionComment(ev, postId) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        openMomentsCommentModal(String(postId), null);
    }

    function momentsOpenReplyToComment(ev, postId, commentRef) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        var st = store();
        var list = st.loadMomentsPostsRaw();
        var idx = list.findIndex(function (p) { return String(p.id) === String(postId); });
        if (idx === -1) return;
        var post = st.normalizeMomentsPost(list[idx]);
        var comments = post.comments || [];
        var c = null;
        var ref = commentRef != null ? String(commentRef) : '';
        if (ref.startsWith('__idx_')) {
            var ii = parseInt(ref.slice(6), 10);
            if (!Number.isNaN(ii) && ii >= 0 && ii < comments.length) c = comments[ii];
        } else {
            c = comments.find(function (x) { return x && String(x.id) === ref; });
        }
        if (!c) return;
        var name = String(c.authorName || '').trim() || '好友';
        openMomentsCommentModal(String(postId), name);
    }

    function momentsMenuActionFavorite(ev, postId) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        toggleMomentsFavorite(String(postId));
    }

    function buildMomentsForwardPayloadJson(postId) {
        var st = store();
        if (!st) return null;
        var list = st.loadMomentsPostsRaw();
        var idx = list.findIndex(function (p) { return String(p.id) === String(postId); });
        if (idx === -1) return null;
        var post = st.normalizeMomentsPost(list[idx]);
        var likes = (post.likes || []).map(function (l) {
            return {
                authorName: String((l && (l.authorName || l.name)) || '').slice(0, 50),
                authorId: l && l.authorId != null ? String(l.authorId) : '',
                isMe: !!(l && l.isMe)
            };
        });
        var comments = (post.comments || []).map(function (c) {
            return {
                id: c && c.id != null ? c.id : undefined,
                authorName: String((c && c.authorName) || '').slice(0, 50),
                authorId: c && c.authorId != null ? String(c.authorId) : '',
                text: String((c && c.text) || '').slice(0, 500),
                replyTo: c && c.replyTo ? String(c.replyTo).slice(0, 50) : ''
            };
        });
        var snap = {
            postId: String(post.id),
            friendId: post.friendId != null ? String(post.friendId) : '',
            friendName: String(post.friendName || '').slice(0, 80),
            friendAvatar: post.friendAvatar ? String(post.friendAvatar).slice(0, 200000) : '',
            text: post.text != null ? String(post.text).slice(0, 8000) : '',
            images: [],
            polaroidHtml: '',
            likes: likes,
            comments: comments,
            timestamp: Number(post.timestamp) || Date.now(),
            forwardMode: 'text_only'
        };
        try {
            return JSON.stringify({ v: 1, snapshot: snap });
        } catch (e) {
            return null;
        }
    }

    function updateMomentsForwardSendButtonEnabled() {
        var btn = document.getElementById('moments-forward-send-btn');
        if (!btn || !momentsForwardTargetIds) return;
        btn.disabled = momentsForwardTargetIds.size === 0;
    }

    function renderMomentsForwardFriendList() {
        var listEl = document.getElementById('moments-forward-friends-list');
        var emptyEl = document.getElementById('moments-forward-empty');
        if (!listEl) return;
        listEl.innerHTML = '';
        momentsForwardTargetIds = new Set();
        var friends = typeof loadFriendsFromStorage === 'function' ? loadFriendsFromStorage() : [];
        friends = friends.filter(function (f) {
            return f && !f.blacklisted && !f.isGroup;
        });
        friends.forEach(function (f) {
            var row = document.createElement('div');
            row.className = 'forward-friend-row';
            row.dataset.friendId = String(f.id);
            var check = document.createElement('div');
            check.className = 'forward-friend-checkbox';
            var avatar = document.createElement('div');
            avatar.className = 'forward-friend-avatar';
            if (f.avatar) {
                var clean = f.avatar;
                if (clean.indexOf('url(') === 0 && clean.slice(-1) === ')') clean = clean.slice(4, -1);
                avatar.style.backgroundImage = 'url(' + clean + ')';
                avatar.textContent = '';
            } else {
                avatar.textContent = (f.nickname || '?').charAt(0);
            }
            var name = document.createElement('span');
            name.className = 'forward-friend-name';
            name.textContent = f.remark || f.nickname || '未命名';
            row.appendChild(check);
            row.appendChild(avatar);
            row.appendChild(name);
            row.addEventListener('click', function () {
                var id = String(f.id);
                if (momentsForwardTargetIds.has(id)) {
                    momentsForwardTargetIds.delete(id);
                    row.classList.remove('selected');
                } else {
                    momentsForwardTargetIds.add(id);
                    row.classList.add('selected');
                }
                updateMomentsForwardSendButtonEnabled();
            });
            listEl.appendChild(row);
        });
        if (emptyEl) {
            var has = listEl.children.length > 0;
            emptyEl.style.display = has ? 'none' : 'block';
            listEl.style.display = has ? 'block' : 'none';
        }
        updateMomentsForwardSendButtonEnabled();
    }

    function openMomentsForwardPicker(postId) {
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        momentsForwardPayloadJson = buildMomentsForwardPayloadJson(postId);
        if (!momentsForwardPayloadJson) {
            showNotification('无法读取该条动态');
            return;
        }
        var hint = document.getElementById('moments-forward-hint');
        if (hint) hint.textContent = '请选择接收好友（可多选），转发仅保留原文文字，评论需点开文字后查看';
        renderMomentsForwardFriendList();
        var modal = document.getElementById('moments-forward-modal');
        if (modal) modal.classList.add('show');
    }

    function cancelMomentsForwardModal() {
        var modal = document.getElementById('moments-forward-modal');
        if (modal) modal.classList.remove('show');
        momentsForwardTargetIds = null;
        momentsForwardPayloadJson = null;
    }

    function confirmMomentsForwardToFriends() {
        if (!momentsForwardPayloadJson) {
            cancelMomentsForwardModal();
            return;
        }
        if (!momentsForwardTargetIds || momentsForwardTargetIds.size === 0) {
            showNotification('请选择接收好友');
            return;
        }
        var ids = Array.from(momentsForwardTargetIds);
        var baseTs = Date.now();
        ids.forEach(function (fid, i) {
            if (typeof saveChatMessage === 'function') {
                saveChatMessage(fid, 'user', momentsForwardPayloadJson, null, baseTs + i, 'moments_forward_card');
            }
            var chatPage = document.getElementById('chat-page');
            var cur = chatPage && chatPage.dataset.friendId;
            if (cur && String(cur) === String(fid) && typeof displayMessage === 'function') {
                displayMessage('user', momentsForwardPayloadJson, null, baseTs + i, String(fid), 'moments_forward_card');
            }
        });
        if (typeof scheduleLoadChatList === 'function') scheduleLoadChatList();
        cancelMomentsForwardModal();
        showNotification('已转发给 ' + ids.length + ' 位好友');
    }

    function momentsMenuActionForward(ev, postId) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        openMomentsForwardPicker(String(postId));
    }

    function momentsMenuActionDelete(ev, postId) {
        if (ev) {
            ev.preventDefault();
            ev.stopPropagation();
        }
        document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        var ok = window.confirm('删除后无法恢复，确定要删除这条动态吗？');
        if (!ok) return;
        var st = store();
        var list = st.loadMomentsPostsRaw();
        var idx = list.findIndex(function (p) { return String(p.id) === String(postId); });
        if (idx === -1) return;
        list.splice(idx, 1);
        st.saveMomentsPostsRaw(list);
        renderMomentsFeed();
        showNotification('已删除');
    }

    function initMomentsPostMenuOutsideClose() {
        if (window.__momentsMenuOutsideBound) return;
        window.__momentsMenuOutsideBound = true;
        document.addEventListener('click', function () {
            document.querySelectorAll('.moments-post-menu.is-open').forEach(function (m) { m.classList.remove('is-open'); });
        });
    }

    function handleMomentsCoverSelect(event) {
        var file = event.target.files && event.target.files[0];
        if (!file) return;
        if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
            showNotification('请选择 JPEG、PNG 或 GIF 图片');
            event.target.value = '';
            return;
        }
        var reader = new FileReader();
        reader.onload = function (e) {
            var dataUrl = e.target.result;
            function finish(saved) {
                applyMomentsCoverFromStorage();
                if (saved) {
                    showNotification('封面已更新');
                } else {
                    try {
                        showErrorDialog('封面无法保存', '图片压缩后仍超出浏览器本地存储上限，或存储空间已满。请换一张更小的图，或在设置中清理部分本地数据后再试。');
                    } catch (err) {}
                }
            }
            if (typeof setLocalStorageStringWithQuotaFallback === 'function') {
                setLocalStorageStringWithQuotaFallback(WECHAT_LS_MOMENTS_COVER, dataUrl, { maxDim: 1440, quality: 0.82, mime: 'image/jpeg' })
                    .then(finish)
                    .catch(function (err) {
                        console.error('朋友圈封面保存失败:', err);
                        try {
                            showErrorDialog('运行错误', String(err && (err.message || err) || '未知错误'));
                        } catch (e2) {}
                    });
            } else {
                try {
                    localStorage.setItem(WECHAT_LS_MOMENTS_COVER, dataUrl);
                    finish(dataUrl);
                } catch (err) {
                    console.error(err);
                    try {
                        showErrorDialog('运行错误', String(err && (err.message || err) || '未知错误'));
                    } catch (e2) {}
                }
            }
        };
        reader.readAsDataURL(file);
        event.target.value = '';
    }

    function openMomentsPage() {
        if (typeof global.closeCoupleSpacePage === 'function') {
            try { global.closeCoupleSpacePage(); } catch (e) {}
        }
        var dp = document.getElementById('wechat-discover-page');
        if (dp) dp.classList.add('wechat-discover-moments-open');
        var page = document.getElementById('moments-page');
        if (page) {
            page.classList.add('show');
            applyMomentsCoverFromStorage();
            refreshMomentsProfileHeader();
            renderMomentsFeed();
        }
    }

    function closeMomentsPage() {
        var dp = document.getElementById('wechat-discover-page');
        if (dp) dp.classList.remove('wechat-discover-moments-open');
        var page = document.getElementById('moments-page');
        if (page) page.classList.remove('show');
    }

    function setMomentsRefreshButtonLoading(loading) {
        var btn = document.getElementById('moments-refresh-btn');
        if (!btn) return;
        btn.classList.toggle('is-moments-refresh-loading', !!loading);
        btn.setAttribute('aria-busy', loading ? 'true' : 'false');
    }

    /** 调用 API 生成好友朋友圈；成功返回 true（依赖 app.js：CommandManager、FeatureCommandMapper、extractJsonObjectFromApiText 等） */
    async function refreshMomentsFeedFromApi() {
        if (typeof CommandManager === 'undefined' || typeof CommandManager.buildMomentsRefreshSendContent !== 'function') {
            showNotification('系统未加载朋友圈刷新模块');
            return false;
        }
        var content = CommandManager.buildMomentsRefreshSendContent();
        if (!content) {
            showNotification('没有可生成动态的好友（已排除黑名单与「不看他的朋友圈」）');
            return false;
        }
        var eligible = loadFriendsFromStorage().filter(function (f) {
            return !f.blacklisted && !f.momentsHidden && !f.isGroup;
        });
        var raw = await FeatureCommandMapper.callApiModel(content, null);
        if (!raw) return false;
        var data = extractJsonObjectFromApiText(raw);
        if (!data || !Array.isArray(data.posts)) {
            showNotification('未能解析模型返回的朋友圈 JSON');
            return false;
        }
        store().applyMomentsApiPostsToStorage(data.posts, eligible);
        showNotification('好友朋友圈已更新');
        return true;
    }

    async function refreshMomentsPage() {
        var refreshBtn = document.getElementById('moments-refresh-btn');
        if (refreshBtn && refreshBtn.classList.contains('is-moments-refresh-loading')) return;
        setMomentsRefreshButtonLoading(true);
        var scrollEl = document.getElementById('moments-ins-scroll');
        var prevScrollTop = scrollEl ? scrollEl.scrollTop : 0;
        var prevScrollHeight = scrollEl ? scrollEl.scrollHeight : 0;
        try {
            applyMomentsCoverFromStorage();
            refreshMomentsProfileHeader();
            await refreshMomentsFeedFromApi();
            renderMomentsFeed({
                preserveFeedsScroll: true,
                prevScrollTop: prevScrollTop,
                prevScrollHeight: prevScrollHeight
            });
        } catch (e) {
            console.error('刷新朋友圈失败:', e);
            try {
                showErrorDialog('朋友圈刷新失败', String(e && (e.message || e) || '未知错误'));
            } catch (err) {}
        } finally {
            setMomentsRefreshButtonLoading(false);
        }
    }

    function toggleMomentsLike(postId) {
        var nickname = (safeReadJsonFromStorage('userInfo', {}) || {}).nickname || '我';
        var st = store();
        var list = st.loadMomentsPostsRaw();
        var idx = list.findIndex(function (p) { return String(p.id) === String(postId); });
        if (idx === -1) return;
        var post = st.normalizeMomentsPost(list[idx]);
        var meIdx = post.likes.findIndex(function (l) { return l && l.isMe; });
        if (meIdx >= 0) {
            post.likes.splice(meIdx, 1);
        } else {
            post.likes.push({ name: nickname, isMe: true });
        }
        list[idx] = post;
        st.saveMomentsPostsRaw(list);
        renderMomentsFeed();
    }

    function openMomentsCommentModal(postId, replyToName) {
        momentsCommentingPostId = postId;
        momentsCommentingReplyTo = (replyToName && String(replyToName).trim())
            ? String(replyToName).trim().slice(0, 50)
            : null;
        var input = document.getElementById('moments-comment-input');
        if (input) input.value = '';
        var titleEl = document.querySelector('#moments-comment-modal .moments-comment-title');
        if (titleEl) titleEl.textContent = momentsCommentingReplyTo ? ('回复' + momentsCommentingReplyTo) : '评论';
        if (input) {
            input.placeholder = momentsCommentingReplyTo
                ? ('回复 ' + momentsCommentingReplyTo + '：')
                : '说点什么...';
        }
        var modal = document.getElementById('moments-comment-modal');
        if (modal) modal.classList.add('show');
    }

    function closeMomentsCommentModal() {
        momentsCommentingPostId = null;
        momentsCommentingReplyTo = null;
        var modal = document.getElementById('moments-comment-modal');
        if (modal) modal.classList.remove('show');
        var input = document.getElementById('moments-comment-input');
        if (input) input.placeholder = '说点什么...';
        var titleEl = document.querySelector('#moments-comment-modal .moments-comment-title');
        if (titleEl) titleEl.textContent = '评论';
    }

    function submitMomentsComment() {
        var input = document.getElementById('moments-comment-input');
        if (!input || momentsCommentingPostId == null) return;
        var replyToTarget = momentsCommentingReplyTo;
        var text = input.value.trim();
        if (!text) {
            showNotification('请输入评论内容');
            return;
        }
        var userInfo = safeReadJsonFromStorage('userInfo', {});
        var nickname = (userInfo.nickname || '我').trim() || '我';
        var st = store();
        var list = st.loadMomentsPostsRaw();
        var idx = list.findIndex(function (p) { return String(p.id) === String(momentsCommentingPostId); });
        if (idx === -1) return;
        var post = st.normalizeMomentsPost(list[idx]);

        var postId = momentsCommentingPostId;
        var newComment = {
            id: Date.now(),
            authorName: nickname,
            authorId: 'me',
            text: text,
            timestamp: Date.now()
        };
        if (replyToTarget) newComment.replyTo = replyToTarget;
        post.comments.push(newComment);
        list[idx] = post;
        st.saveMomentsPostsRaw(list);
        input.value = '';
        closeMomentsCommentModal();
        renderMomentsFeed();
        showNotification('评论成功');

        if (post.friendId && String(post.friendId) !== 'me') {
            var userCommentText = replyToTarget ? ('（回复 ' + replyToTarget + '）' + text) : text;
            var sendContent = CommandManager.buildMomentsFriendReplySendContent(post, userCommentText);
            if (!sendContent) return;

            (async function () {
                var raw = await FeatureCommandMapper.callApiModel(sendContent, null, { skipOverlay: true });
                if (!raw || !raw.trim()) return;

                var cleaned = raw.replace(/^```[\s\S]*?```$/gm, '').trim();

                var friends = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted; });
                var f = friends.find(function (x) { return String(x.id) === String(post.friendId); });
                var friendName = f ? (f.remark || f.nickname || '好友').trim() : (post.friendName || '好友');

                var list2 = st.loadMomentsPostsRaw();
                var idx2 = list2.findIndex(function (p) { return String(p.id) === String(postId); });
                if (idx2 === -1) return;
                var post2 = st.normalizeMomentsPost(list2[idx2]);
                var replyToUser = nickname ? String(nickname).trim().slice(0, 50) : '';
                var friendReply = {
                    id: Date.now() + 1,
                    authorName: friendName,
                    authorId: String(post.friendId),
                    text: cleaned,
                    timestamp: Date.now()
                };
                if (replyToUser) friendReply.replyTo = replyToUser;
                post2.comments.push(friendReply);
                list2[idx2] = post2;
                st.saveMomentsPostsRaw(list2);

                renderMomentsFeed();
            })();
        }
    }

    function buildMomentsPostCardElement(post, ctx) {
        var esc = ctx.esc;
        var escUrl = ctx.escUrl;
        var favoritedIds = ctx.favoritedIds;
        var emojiListForMoments = ctx.emojiListForMoments;
        var card = document.createElement('div');
        card.className = 'moments-post-card';
        var avatarHtml = post.friendAvatar
            ? '<img src="' + escUrl(post.friendAvatar) + '" alt="" class="moments-post-avatar">'
            : '<div class="moments-post-avatar-placeholder">' + esc((post.friendName || '?').charAt(0)) + '</div>';
        var imgCount = post.images && post.images.length ? post.images.length : 0;
        var gridClass = imgCount > 0 ? ' moments-post-images--n' + Math.min(imgCount, 9) : '';
        var imgsHtml = '';
        if (post.images && post.images.length > 0) {
            imgsHtml = '<div class="moments-post-images' + gridClass + '">' +
                post.images.map(function (url) { return '<img src="' + escUrl(url) + '" alt="">'; }).join('') + '</div>';
        }
        var textHtml = post.text
            ? '<div class="moments-post-content">' + momentsFormatPostTextForDisplay(post.text, emojiListForMoments) + '</div>'
            : '';
        var polaroidHost = post.polaroidHtml
            ? '<div class="moments-post-polaroid-host">' + post.polaroidHtml.replace(/<img\s[^>]*src="https?:\/\/[^"]*bing\.net[^"]*"[^>]*>/gi, function (imgTag) {
                var m = imgTag.match(/data-pq="([^"]*)"/i);
                var kw = m && m[1] ? m[1] : 'moment';
                var seed = encodeURIComponent(kw.replace(/\+/g, ' '));
                var newsrc = 'https://picsum.photos/seed/' + seed + '/750/1000';
                return imgTag.replace(/src="[^"]*"/, 'src="' + newsrc + '"');
            }) + '</div>'
            : '';
        var isFav = favoritedIds.has(String(post.id));
        var userLiked = (post.likes || []).some(function (l) { return l && l.isMe; });
        var likeNames = (post.likes || []).map(function (l) { return esc(l.authorName || l.name || ''); }).filter(Boolean);
        var likeCount = likeNames.length;
        var likeStrip = likeCount > 0
            ? '<div class="moments-post-like-strip"><span class="moments-post-like-icon" aria-hidden="true">♥</span> ' + likeNames.join('、') + '</div>'
            : '';
        var commentsHtml = '';
        if ((post.comments || []).length > 0) {
            commentsHtml = '<div class="moments-post-comments">' + post.comments.map(function (c, i) {
                var replyTo = c.replyTo ? '<span class="moments-post-comment-replyto">回复 ' + esc(c.replyTo) + '：</span>' : '';
                var ref = (c.id != null && c.id !== '') ? String(c.id) : ('__idx_' + i);
                var attrPost = escapeForHtmlOnclickSingleQuoted(String(post.id));
                var attrRef = escapeForHtmlOnclickSingleQuoted(ref);
                return '<div class="moments-post-comment-line moments-post-comment-line--interactive" role="button" tabindex="0" onclick="momentsOpenReplyToComment(event,\'' + attrPost + '\',\'' + attrRef + '\')"><span class="moments-post-comment-author">' +
                    esc(c.authorName || '') + '</span>' + (replyTo ? '' : '：') + replyTo + esc(c.text || '') + '</div>';
            }).join('') + '</div>';
        }
        var pid = esc(post.id);
        var favLabel = isFav ? '取消收藏' : '收藏';
        var likeLabel = userLiked ? '取消' : '赞';
        var icoHeart = '<svg class="moments-menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M20.84 4.61a5.5 5.5 0 0 0-7.78 0L12 5.67l-1.06-1.06a5.5 5.5 0 0 0-7.78 7.78l1.06 1.06L12 21.23l7.78-7.78 1.06-1.06a5.5 5.5 0 0 0 0-7.78z"/></svg>';
        var icoComment = '<svg class="moments-menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>';
        var icoStar = '<svg class="moments-menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
        var icoTrash = '<svg class="moments-menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" d="M3 6h18M8 6V4h8v2M19 6l-1 14H6L5 6"/></svg>';
        var icoShare = '<svg class="moments-menu-ico" viewBox="0 0 24 24" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" d="M4 12v7a2 2 0 002 2h12a2 2 0 002-2v-7M16 6l-4-4-4 4M12 2v13"/></svg>';
        card.innerHTML = '\n            <div class="moments-post-row">\n                <div class="moments-post-avatar-col">' + avatarHtml + '</div>\n                <div class="moments-post-main">\n                    <div class="moments-post-name">' + esc(post.friendName || '未知') + '</div>\n                    ' + textHtml + '\n                    ' + polaroidHost + '\n                    ' + imgsHtml + '\n                    <div class="moments-post-meta-toolbar">\n                        <span class="moments-post-time-inline">' + formatFavoriteTime(post.timestamp) + '</span>\n                        <div class="moments-post-more-wrap">\n                            <button type="button" class="moments-post-more-btn" onclick="toggleMomentsPostMenu(event)" aria-label="更多操作" aria-expanded="false">\n                                <span class="moments-post-more-dot"></span><span class="moments-post-more-dot"></span>\n                            </button>\n                            <div class="moments-post-menu" role="menu" onclick="event.stopPropagation();">\n                                <button type="button" class="moments-post-menu-item" role="menuitem" onclick="momentsMenuActionLike(event,\'' + pid + '\')">' + icoHeart + '<span>' + likeLabel + '</span></button>\n                                <button type="button" class="moments-post-menu-item" role="menuitem" onclick="momentsMenuActionComment(event,\'' + pid + '\')">' + icoComment + '<span>评论</span></button>\n                                <button type="button" class="moments-post-menu-item" role="menuitem" onclick="momentsMenuActionForward(event,\'' + pid + '\')">' + icoShare + '<span>转发</span></button>\n                                <button type="button" class="moments-post-menu-item" role="menuitem" onclick="momentsMenuActionFavorite(event,\'' + pid + '\')">' + icoStar + '<span>' + esc(favLabel) + '</span></button>\n                                <button type="button" class="moments-post-menu-item" role="menuitem" onclick="momentsMenuActionDelete(event,\'' + pid + '\')">' + icoTrash + '<span>删除</span></button>\n                            </div>\n                        </div>\n                    </div>\n                    ' + (likeStrip || commentsHtml ? '<div class="moments-post-social-box">' + likeStrip + commentsHtml + '</div>' : '') + '\n                </div>\n            </div>\n        ';
        return card;
    }

    function appendMomentsFeedCards(feed, ctx, count) {
        var n = typeof count === 'number' ? count : MOMENTS_FEED_PAGE_SIZE;
        var start = momentsFeedPage.offset;
        var end = Math.min(start + n, momentsFeedPage.allPosts.length);
        var i;
        for (i = start; i < end; i++) {
            var card = buildMomentsPostCardElement(momentsFeedPage.allPosts[i], ctx);
            feed.appendChild(card);
            normalizeWechatPolaroidDom(card);
            attachWechatPolaroidImgGuards(card);
        }
        momentsFeedPage.offset = end;
    }

    function unbindMomentsFeedScroll() {
        if (momentsFeedPage.scrollEl && momentsFeedPage.onScroll) {
            momentsFeedPage.scrollEl.removeEventListener('scroll', momentsFeedPage.onScroll);
        }
        momentsFeedPage.onScroll = null;
        momentsFeedPage.scrollEl = null;
    }

    function bindMomentsFeedScroll(feed, ctx) {
        unbindMomentsFeedScroll();
        var scrollEl = document.getElementById('moments-ins-scroll');
        if (!scrollEl) return;
        momentsFeedPage.scrollEl = scrollEl;
        var ticking = false;
        momentsFeedPage.onScroll = function () {
            if (ticking) return;
            ticking = true;
            requestAnimationFrame(function () {
                ticking = false;
                if (momentsFeedPage.offset >= momentsFeedPage.allPosts.length) return;
                if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 100) {
                    appendMomentsFeedCards(feed, ctx, MOMENTS_FEED_PAGE_SIZE);
                }
            });
        };
        scrollEl.addEventListener('scroll', momentsFeedPage.onScroll, { passive: true });
    }

    /**
     * @param {object} [scrollOpts] 刷新后保留阅读位置：prepend 新帖后把滚动条下移，避免视线跳到最顶
     * @param {boolean} [scrollOpts.preserveFeedsScroll]
     * @param {number} [scrollOpts.prevScrollTop]
     * @param {number} [scrollOpts.prevScrollHeight]
     */
    function renderMomentsFeed(scrollOpts) {
        var feed = document.getElementById('moments-feed');
        var empty = document.getElementById('moments-empty');
        if (!feed) return;
        var st = store();
        if (!st) {
            console.error('[Moments.ui] Moments.store 未就绪');
            return;
        }
        var esc = st.escapeHtmlMoments;
        var escUrl = st.escapeAttrUrl;
        try {
            unbindMomentsFeedScroll();
            feed.innerHTML = '';
            momentsFeedPage.allPosts = [];
            momentsFeedPage.offset = 0;
            var posts = st.getMomentsPosts();
            var friendsById = new Map(loadFriendsFromStorage().map(function (f) { return [String(f.id), f]; }));
            posts = posts.filter(function (p) {
                if (String(p.friendId) === 'me') return true;
                var fr = friendsById.get(String(p.friendId));
                if (fr && fr.isGroup) return false;
                return !(fr && fr.momentsHidden);
            });
            if (posts.length === 0) {
                feed.style.display = 'none';
                if (empty) empty.style.display = 'block';
                return;
            }
            feed.style.display = 'flex';
            if (empty) empty.style.display = 'none';
            var scrollEl = document.getElementById('moments-ins-scroll');
            if (scrollEl && !(scrollOpts && scrollOpts.preserveFeedsScroll)) scrollEl.scrollTop = 0;
            var favorites;
            try {
                favorites = JSON.parse(localStorage.getItem('wechatFavorites') || '[]');
                if (!Array.isArray(favorites)) favorites = [];
            } catch (e) {
                favorites = [];
            }
            var favoritedIds = new Set(favorites.filter(function (f) {
                return f.sourceType === 'moments' && f.momentsPostId != null;
            }).map(function (f) { return String(f.momentsPostId); }));
            var emojiListForMoments = momentsCollectAllEmojis();
            var ctx = {
                esc: esc,
                escUrl: escUrl,
                favoritedIds: favoritedIds,
                emojiListForMoments: emojiListForMoments
            };
            momentsFeedPage.allPosts = posts;
            appendMomentsFeedCards(feed, ctx, MOMENTS_FEED_PAGE_SIZE);
            bindMomentsFeedScroll(feed, ctx);
            if (scrollEl && scrollOpts && scrollOpts.preserveFeedsScroll) {
                var delta = scrollEl.scrollHeight - (Number(scrollOpts.prevScrollHeight) || 0);
                scrollEl.scrollTop = (Number(scrollOpts.prevScrollTop) || 0) + delta;
            }
        } catch (e) {
            console.error('渲染朋友圈失败:', e);
            unbindMomentsFeedScroll();
            feed.innerHTML = '';
            feed.style.display = 'none';
            if (empty) {
                empty.style.display = 'block';
                var text = empty.querySelector('.moments-empty-text');
                var hint = empty.querySelector('.moments-empty-hint');
                if (text) text.textContent = '朋友圈加载失败';
                if (hint) hint.textContent = '请打开浏览器控制台查看错误，或重新导入备份/检查 API 设置';
            }
            try {
                showErrorDialog('朋友圈加载失败', String(e && (e.message || e) || '未知错误'));
            } catch (err) {}
        }
    }

    function openPostMomentsModal() {
        var ti = document.getElementById('moments-text-input');
        if (ti) ti.value = '';
        momentsPendingImages = [];
        var previews = document.getElementById('moments-image-previews');
        if (previews) previews.innerHTML = '';
        var modal = document.getElementById('post-moments-modal');
        if (modal) modal.classList.add('show');
    }

    function closePostMomentsModal() {
        var modal = document.getElementById('post-moments-modal');
        if (modal) modal.classList.remove('show');
    }

    function handleMomentsImageSelect(event) {
        var files = event.target.files;
        if (!files || files.length === 0) return;
        var st = store();
        for (var i = 0; i < files.length; i++) {
            (function (file) {
                if (typeof isLegoUploadableRasterImageFile === 'function' && !isLegoUploadableRasterImageFile(file)) {
                    showNotification('已跳过非 JPEG/PNG/GIF 文件：' + (file.name || ''));
                    return;
                }
                var r = new FileReader();
                r.onload = function (e) {
                    momentsPendingImages.push(e.target.result);
                    var previews = document.getElementById('moments-image-previews');
                    if (previews) {
                        var img = document.createElement('img');
                        img.src = e.target.result;
                        previews.appendChild(img);
                    }
                };
                r.readAsDataURL(file);
            })(files[i]);
        }
        event.target.value = '';
    }

    function publishMomentsPost() {
        var ti = document.getElementById('moments-text-input');
        var text = ti ? ti.value.trim() : '';
        if (!text && momentsPendingImages.length === 0) {
            showNotification('请输入文字或添加图片');
            return;
        }
        var userInfo = safeReadJsonFromStorage('userInfo', {});
        var myNickname = (userInfo.nickname || '我').trim() || '我';
        var myAvatar = userInfo.avatar || null;
        var postId = Date.now();
        var post = {
            id: postId,
            friendId: 'me',
            friendName: myNickname,
            friendAvatar: myAvatar,
            text: text || '',
            images: momentsPendingImages.slice(),
            timestamp: Date.now(),
            likes: [],
            comments: []
        };
        var st = store();
        var raw = st.loadMomentsPostsRaw();
        raw.unshift(post);
        st.saveMomentsPostsRaw(raw);
        closePostMomentsModal();
        renderMomentsFeed();
        showNotification('发布成功');

        var friends = loadFriendsFromStorage().filter(function (f) { return !f.blacklisted && !f.isGroup; });
        if (friends.length === 0) return;
        var sendContent = CommandManager.buildMomentsUserPostReactionsSendContent(post);
        if (!sendContent) return;

        (async function () {
            var raw2 = await FeatureCommandMapper.callApiModel(sendContent, null, {
                skipOverlay: true,
                apiRetry: false
            });
            if (!raw2 || !raw2.trim()) return;
            var data = extractJsonObjectFromApiText(raw2);
            var comments = Array.isArray(data) ? data : (data && Array.isArray(data.comments) ? data.comments : null);
            if (!comments || comments.length === 0) {
                console.warn('[朋友圈] 未能从模型返回中解析出评论 JSON（需为数组或含 comments 数组）');
                return;
            }

            var friendById = new Map(friends.map(function (f) { return [String(f.id), f]; }));
            var list = st.loadMomentsPostsRaw();
            var idx = list.findIndex(function (p) { return String(p.id) === String(postId); });
            if (idx === -1) return;
            var post2 = st.normalizeMomentsPost(list[idx]);
            comments.forEach(function (c) {
                if (!c || !c.text || !c.text.trim()) return;
                var f = friendById.get(String(c.friendId));
                var authorName = c.authorName || (f ? (f.remark || f.nickname || '好友').trim() : '好友');
                post2.comments.push({
                    id: Date.now() + Math.random(),
                    authorName: authorName,
                    authorId: String(c.friendId),
                    text: String(c.text).trim().slice(0, 200),
                    timestamp: Date.now()
                });
            });
            list[idx] = post2;
            st.saveMomentsPostsRaw(list);
            renderMomentsFeed();
        })().catch(function (e) {
            console.error('[朋友圈] 好友留言处理失败', e);
        });
    }

    function toggleMomentsFavorite(postId) {
        var st = store();
        var posts = st.getMomentsPosts();
        var post = posts.find(function (p) { return String(p.id) === String(postId); });
        if (!post) return;
        var favorites;
        try {
            favorites = JSON.parse(localStorage.getItem('wechatFavorites') || '[]');
            if (!Array.isArray(favorites)) favorites = [];
        } catch (e) {
            favorites = [];
        }
        var idx = favorites.findIndex(function (f) {
            return f.sourceType === 'moments' && String(f.momentsPostId) === String(postId);
        });
        if (idx >= 0) {
            favorites.splice(idx, 1);
            localStorage.setItem('wechatFavorites', JSON.stringify(favorites));
            showNotification('已取消收藏');
        } else {
            favorites.push({
                id: Date.now(),
                sourceType: 'moments',
                momentsPostId: post.id,
                sourceFriendName: post.friendName || '未知',
                collectedAt: Date.now(),
                momentsData: {
                    text: post.text || '',
                    images: post.images ? post.images.slice() : []
                }
            });
            localStorage.setItem('wechatFavorites', JSON.stringify(favorites));
            showNotification('已收藏');
        }
        renderMomentsFeed();
    }

    var ui = {
        WECHAT_LS_MOMENTS_COVER: WECHAT_LS_MOMENTS_COVER,
        momentsCollectAllEmojis: momentsCollectAllEmojis,
        momentsFormatPostTextForDisplay: momentsFormatPostTextForDisplay,
        applyMomentsCoverFromStorage: applyMomentsCoverFromStorage,
        refreshMomentsProfileHeader: refreshMomentsProfileHeader,
        triggerMomentsCoverUpload: triggerMomentsCoverUpload,
        onMomentsCoverAreaClick: onMomentsCoverAreaClick,
        toggleMomentsPostMenu: toggleMomentsPostMenu,
        momentsMenuActionLike: momentsMenuActionLike,
        momentsMenuActionComment: momentsMenuActionComment,
        momentsOpenReplyToComment: momentsOpenReplyToComment,
        momentsMenuActionFavorite: momentsMenuActionFavorite,
        momentsMenuActionForward: momentsMenuActionForward,
        openMomentsForwardPicker: openMomentsForwardPicker,
        momentsMenuActionDelete: momentsMenuActionDelete,
        initMomentsPostMenuOutsideClose: initMomentsPostMenuOutsideClose,
        handleMomentsCoverSelect: handleMomentsCoverSelect,
        openMomentsPage: openMomentsPage,
        closeMomentsPage: closeMomentsPage,
        setMomentsRefreshButtonLoading: setMomentsRefreshButtonLoading,
        refreshMomentsPage: refreshMomentsPage,
        toggleMomentsLike: toggleMomentsLike,
        openMomentsCommentModal: openMomentsCommentModal,
        closeMomentsCommentModal: closeMomentsCommentModal,
        submitMomentsComment: submitMomentsComment,
        renderMomentsFeed: renderMomentsFeed,
        openPostMomentsModal: openPostMomentsModal,
        closePostMomentsModal: closePostMomentsModal,
        handleMomentsImageSelect: handleMomentsImageSelect,
        publishMomentsPost: publishMomentsPost,
        toggleMomentsFavorite: toggleMomentsFavorite,
        refreshMomentsFeedFromApi: refreshMomentsFeedFromApi
    };

    var M = global.Moments || {};
    global.Moments = Object.assign(M, {
        ui: ui,
        /** 收藏/发现等页如需刷新朋友圈列表，可调用 */
        renderFeed: function () {
            return ui.renderMomentsFeed();
        }
    });

    /** index.html onclick 等仍使用全局名：在此一次性挂到 window */
    global.refreshMomentsFeedFromApi = refreshMomentsFeedFromApi;
    global.openMomentsPage = openMomentsPage;
    global.closeMomentsPage = closeMomentsPage;
    global.refreshMomentsPage = refreshMomentsPage;
    global.openPostMomentsModal = openPostMomentsModal;
    global.closePostMomentsModal = closePostMomentsModal;
    global.publishMomentsPost = publishMomentsPost;
    global.handleMomentsImageSelect = handleMomentsImageSelect;
    global.handleMomentsCoverSelect = handleMomentsCoverSelect;
    global.onMomentsCoverAreaClick = onMomentsCoverAreaClick;
    global.closeMomentsCommentModal = closeMomentsCommentModal;
    global.submitMomentsComment = submitMomentsComment;
    global.toggleMomentsPostMenu = toggleMomentsPostMenu;
    global.momentsOpenReplyToComment = momentsOpenReplyToComment;
    global.momentsMenuActionLike = momentsMenuActionLike;
    global.momentsMenuActionComment = momentsMenuActionComment;
    global.momentsMenuActionFavorite = momentsMenuActionFavorite;
    global.momentsMenuActionForward = momentsMenuActionForward;
    global.cancelMomentsForwardModal = cancelMomentsForwardModal;
    global.confirmMomentsForwardToFriends = confirmMomentsForwardToFriends;
    global.momentsMenuActionDelete = momentsMenuActionDelete;
    global.triggerMomentsCoverUpload = triggerMomentsCoverUpload;
})(typeof window !== 'undefined' ? window : globalThis);
