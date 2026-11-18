/**
 * Lego 小手机 · 微信「情侣空间 - 思念距离」
 *
 * 功能：
 * 1. 矢量地图显示（模仿高德/谷歌地图）
 * 2. 位置设置和距离计算（三层降级：API → 联网搜索 → AI模型兜底）
 * 3. 地图聊天功能（纯文字，地图作为背景）
 * 4. 总结功能
 */
(function (global) {
    'use strict';

    var currentFriendId = '';
    var mapChatHistory = []; // 地图聊天记录
    var distanceData = null; // { distance: number, timeDiff: number, charLocation: string, userLocation: string }
    var apiSettings = { apiUrl: '', apiKey: '' }; // 地图API设置
    var activeMapMessageIndex = -1;
    var currentMapQuoteMessage = null;
    var editingMapMessageIndex = -1;
    var isMapMultiselectMode = false;
    var selectedMapMessageIndexes = new Set();

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

    function getActiveFriendIdFromPrivateContext() {
        var t = document.getElementById('couple-private-editable-title');
        var fid = t ? String(t.getAttribute('data-friend-id') || '').trim() : '';
        if (fid) return fid;

        var br = document.getElementById('couple-private-break-btn');
        fid = br ? String(br.getAttribute('data-friend-id') || '').trim() : '';
        if (fid) return fid;

        var st = store();
        if (st && typeof st.getActiveCoupleFriendId === 'function') {
            fid = String(st.getActiveCoupleFriendId() || '').trim();
            if (fid) return fid;
        }
        return '';
    }

    function getFriendById(friendId) {
        var list = typeof loadFriendsFromStorage === 'function' ? loadFriendsFromStorage() : [];
        if (!Array.isArray(list)) list = [];
        var fid = String(friendId);
        for (var i = 0; i < list.length; i++) {
            if (String(list[i] && list[i].id) === fid) return list[i];
        }
        return null;
    }

    function getUserDisplayName() {
        var userInfo = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('userInfo', {}) : {};
        var myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        var n = (userInfo && userInfo.nickname) || (myProfile && (myProfile.nickname || myProfile.name)) || '';
        n = String(n).trim();
        return n || '我';
    }

    // ==================== 数据持久化 ====================

    function loadMissingDistanceData(friendId) {
        var st = store();
        if (!st || typeof st.getPair !== 'function') return null;
        var pair = st.getPair(String(friendId || ''));
        if (!pair) return null;

        return {
            distanceData: pair.missingDistanceData || null,
            apiSettings: pair.missingDistanceApiSettings || { apiUrl: '', apiKey: '' },
            chatHistory: Array.isArray(pair.missingDistanceChatHistory) ? pair.missingDistanceChatHistory : [],
            charLocation: pair.missingDistanceCharLocation || '',
            userLocation: pair.missingDistanceUserLocation || ''
        };
    }

    function saveMissingDistanceData(friendId, data) {
        var st = store();
        if (!st || typeof st.upsertPair !== 'function') return;
        try {
            st.upsertPair(String(friendId || ''), data || {});
        } catch (e) {
            console.error('保存思念距离数据失败:', e);
        }
    }

    // ==================== 地图渲染 ====================

    var charAvatarImage = null;
    var userAvatarImage = null;

    function loadAvatarImages() {
        // 加载Char头像
        var friend = getFriendById(currentFriendId);
        if (friend && friend.avatar) {
            charAvatarImage = new Image();
            charAvatarImage.crossOrigin = 'anonymous';
            charAvatarImage.src = friend.avatar;
            charAvatarImage.onload = function() {
                renderMapCanvas();
            };
        }

        // 加载User头像
        var userInfo = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('userInfo', {}) : {};
        var myProfile = typeof safeReadJsonFromStorage === 'function' ? safeReadJsonFromStorage('myProfile', null) : null;
        var userAvatar = (userInfo && userInfo.avatar) || (myProfile && myProfile.avatar) || '';

        if (userAvatar) {
            userAvatarImage = new Image();
            userAvatarImage.crossOrigin = 'anonymous';
            userAvatarImage.src = userAvatar;
            userAvatarImage.onload = function() {
                renderMapCanvas();
            };
        }
    }

    function calculateAvatarPositions(distance, canvasWidth, canvasHeight) {
        // 根据距离计算头像位置
        // distance: 公里数
        // 返回 { charX, charY, userX, userY }

        var centerX = canvasWidth / 4; // 实际宽度的一半（因为scale(2,2)）
        var centerY = canvasHeight / 4;

        if (!distance || distance === 0) {
            // 同一地点，头像重叠在中心
            return {
                charX: centerX - 15,
                charY: centerY,
                userX: centerX + 15,
                userY: centerY
            };
        }

        // 根据距离计算偏移量
        // 距离越大，偏移越大，但有上限
        // 使用对数函数让距离映射更合理
        var maxOffset = Math.min(canvasWidth / 6, canvasHeight / 6);
        var normalizedDistance = Math.min(distance / 20000, 1); // 20000公里为最大参考距离
        var offset = maxOffset * normalizedDistance;

        // Char在左侧，User在右侧
        return {
            charX: centerX - offset,
            charY: centerY,
            userX: centerX + offset,
            userY: centerY
        };
    }

    function drawRoundedImage(ctx, img, x, y, size, borderColor) {
        if (!img || !img.complete) return;

        ctx.save();

        // 绘制圆形边框
        ctx.beginPath();
        ctx.arc(x, y, size / 2 + 2, 0, Math.PI * 2);
        ctx.strokeStyle = borderColor;
        ctx.lineWidth = 3;
        ctx.stroke();

        // 裁剪为圆形
        ctx.beginPath();
        ctx.arc(x, y, size / 2, 0, Math.PI * 2);
        ctx.closePath();
        ctx.clip();

        // 绘制头像
        ctx.drawImage(img, x - size / 2, y - size / 2, size, size);

        ctx.restore();
    }

    function drawLocationText(ctx, text, x, y, color) {
        ctx.save();
        ctx.font = '12px -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';

        // 绘制文字背景
        var metrics = ctx.measureText(text);
        var textWidth = metrics.width;
        var padding = 6;

        ctx.fillStyle = 'rgba(255, 255, 255, 0.9)';
        ctx.fillRect(x - textWidth / 2 - padding, y, textWidth + padding * 2, 20);

        // 绘制文字
        ctx.fillStyle = color;
        ctx.fillText(text, x, y + 4);

        ctx.restore();
    }

    function renderMapCanvas() {
        var canvas = document.getElementById('missing-distance-map-canvas');
        if (!canvas) return;

        var ctx = canvas.getContext('2d');
        var w = canvas.width = canvas.offsetWidth * 2; // 高清显示
        var h = canvas.height = canvas.offsetHeight * 2;
        ctx.scale(2, 2);

        // 绘制矢量地图背景（模仿高德地图风格）
        // 背景色
        ctx.fillStyle = '#F5F5F5';
        ctx.fillRect(0, 0, w / 2, h / 2);

        // 绘制网格线
        ctx.strokeStyle = '#E0E0E0';
        ctx.lineWidth = 0.5;
        for (var i = 0; i < w / 2; i += 40) {
            ctx.beginPath();
            ctx.moveTo(i, 0);
            ctx.lineTo(i, h / 2);
            ctx.stroke();
        }
        for (var j = 0; j < h / 2; j += 40) {
            ctx.beginPath();
            ctx.moveTo(0, j);
            ctx.lineTo(w / 2, j);
            ctx.stroke();
        }

        // 绘制道路（随机生成几条）
        ctx.strokeStyle = '#FFFFFF';
        ctx.lineWidth = 3;
        ctx.beginPath();
        ctx.moveTo(0, h / 4);
        ctx.lineTo(w / 2, h / 4);
        ctx.stroke();

        ctx.beginPath();
        ctx.moveTo(w / 4, 0);
        ctx.lineTo(w / 4, h / 2);
        ctx.stroke();

        // 绘制头像和位置信息（如果有距离数据）
        if (distanceData && distanceData.charLocation && distanceData.userLocation) {
            var distance = distanceData.distance || 0;
            var positions = calculateAvatarPositions(distance, w, h);

            // 绘制连接线
            if (distance > 0) {
                ctx.strokeStyle = '#FF6B9D';
                ctx.lineWidth = 2;
                ctx.setLineDash([5, 5]);
                ctx.beginPath();
                ctx.moveTo(positions.charX, positions.charY);
                ctx.lineTo(positions.userX, positions.userY);
                ctx.stroke();
                ctx.setLineDash([]);
            }

            var avatarSize = 50;

            // 绘制Char头像
            if (charAvatarImage && charAvatarImage.complete) {
                drawRoundedImage(ctx, charAvatarImage, positions.charX, positions.charY, avatarSize, '#FF6B9D');
            } else {
                // 降级：绘制圆形标记
                ctx.fillStyle = '#FF6B9D';
                ctx.beginPath();
                ctx.arc(positions.charX, positions.charY, avatarSize / 2, 0, Math.PI * 2);
                ctx.fill();
            }

            // 绘制User头像
            if (userAvatarImage && userAvatarImage.complete) {
                drawRoundedImage(ctx, userAvatarImage, positions.userX, positions.userY, avatarSize, '#6B9DFF');
            } else {
                // 降级：绘制圆形标记
                ctx.fillStyle = '#6B9DFF';
                ctx.beginPath();
                ctx.arc(positions.userX, positions.userY, avatarSize / 2, 0, Math.PI * 2);
                ctx.fill();
            }

            // 绘制位置文字
            var charLocationText = distanceData.charLocation || 'TA的位置';
            var userLocationText = distanceData.userLocation || '你的位置';

            drawLocationText(ctx, charLocationText, positions.charX, positions.charY + avatarSize / 2 + 8, '#FF6B9D');
            drawLocationText(ctx, userLocationText, positions.userX, positions.userY + avatarSize / 2 + 8, '#6B9DFF');
        }
    }

    // ==================== 距离计算（三层降级策略） ====================

    async function calculateDistance() {
        var charLoc = document.getElementById('missing-distance-char-location').value.trim();
        var userLoc = document.getElementById('missing-distance-user-location').value.trim();

        if (!charLoc || !userLoc) {
            if (typeof showNotification === 'function') showNotification('请先输入双方的位置信息');
            return;
        }

        // 显示加载状态
        var resultDiv = document.getElementById('missing-distance-result');
        if (resultDiv) resultDiv.textContent = '正在计算距离和时差...';

        var result = null;

        // 第一层：尝试使用用户配置的地图API
        if (apiSettings.apiUrl && apiSettings.apiKey) {
            result = await tryMapApi(charLoc, userLoc);
        }

        // 第二层：联网搜索
        if (!result) {
            result = await tryOnlineSearch(charLoc, userLoc);
        }

        // 第三层：AI模型兜底
        if (!result) {
            result = await tryAiModel(charLoc, userLoc);
        }

        if (result) {
            distanceData = {
                distance: result.distance,
                timeDiff: result.timeDiff,
                charLocation: charLoc,
                userLocation: userLoc
            };

            // 保存数据
            saveMissingDistanceData(currentFriendId, {
                missingDistanceData: distanceData,
                missingDistanceCharLocation: charLoc,
                missingDistanceUserLocation: userLoc
            });

            // 显示结果
            displayDistanceResult(result);
            renderMapCanvas();
        } else {
            if (typeof showNotification === 'function') {
                showNotification('无法计算距离（请确认已填双方位置且 API 可用），已为你在结果区留了说明');
            }
            if (resultDiv) resultDiv.textContent = '计算失败：可检查地图 API / 联网 / 或在 API 设置中确认位置是否正确';
        }
    }

    async function tryMapApi(charLoc, userLoc) {
        try {
            // 这里应该调用实际的地图API
            // 由于是示例，返回null表示未配置或失败
            return null;
        } catch (e) {
            console.error('地图API调用失败:', e);
            return null;
        }
    }

    async function tryOnlineSearch(charLoc, userLoc) {
        try {
            // 尝试使用WebSearch工具
            if (typeof global.searchWeb === 'function') {
                var query = charLoc + ' 到 ' + userLoc + ' 距离 时差';
                var searchResult = await global.searchWeb(query);
                // 解析搜索结果...
                // 这里简化处理，实际需要解析搜索结果
                return null;
            }
            return null;
        } catch (e) {
            console.error('联网搜索失败:', e);
            return null;
        }
    }

    async function tryAiModel(charLoc, userLoc) {
        try {
            if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined') {
                return null;
            }

            var sendContent = CommandManager.buildMissingDistanceCalculateSendContent(currentFriendId, {
                charLocation: charLoc,
                userLocation: userLoc
            });

            if (!sendContent) return null;

            var raw = await FeatureCommandMapper.callApiModel(sendContent, null, {
                skipOverlay: true,
                suppressErrorDialog: true
            });

            if (!raw || !String(raw).trim()) return null;

            // 解析AI返回的结果
            var parsed = parseDistanceFromApiText(raw);
            return parsed;
        } catch (e) {
            console.error('AI模型调用失败:', e);
            return null;
        }
    }

    function parseDistanceFromApiText(raw) {
        var text = String(raw || '').trim();
        if (!text) return null;

        var obj = typeof extractJsonObjectFromApiText === 'function' ? extractJsonObjectFromApiText(text) : null;
        if (obj && typeof obj === 'object') {
            return {
                distance: Number(obj.distance) || 0,
                timeDiff: Number(obj.timeDiff) || 0
            };
        }

        // 尝试从文本中提取数字
        var distMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:公里|千米|km)/i);
        var timeMatch = text.match(/(\d+(?:\.\d+)?)\s*(?:小时|hour)/i);

        if (distMatch || timeMatch) {
            return {
                distance: distMatch ? parseFloat(distMatch[1]) : 0,
                timeDiff: timeMatch ? parseFloat(timeMatch[1]) : 0
            };
        }

        return null;
    }

    function displayDistanceResult(result) {
        var resultDiv = document.getElementById('missing-distance-result');
        if (!resultDiv) return;

        var distText = result.distance > 0 ?
            'TA距离你 ' + result.distance.toFixed(2) + ' 公里' : '';
        var timeText = result.timeDiff !== 0 ?
            '你们之间的时差是 ' + Math.abs(result.timeDiff).toFixed(1) + ' 小时' :
            '你们在同一时区';

        resultDiv.innerHTML = '<div class="missing-distance-result-item">' + esc(distText) + '</div>' +
            '<div class="missing-distance-result-item">' + esc(timeText) + '</div>';
    }

    // ==================== 地图聊天功能 ====================

    function getMissingDistancePage() {
        return document.getElementById('missing-distance-page');
    }

    function getMapMessageByIndex(index) {
        var idx = Number(index);
        if (!Number.isFinite(idx) || idx < 0 || idx >= mapChatHistory.length) return null;
        return mapChatHistory[idx] || null;
    }

    function cloneMapQuoteSnapshot(msg) {
        if (!msg || typeof msg !== 'object') return null;
        var t = msg.type === 'user' ? 'user' : 'friend';
        var c = msg.content == null ? '' : String(msg.content);
        if (!c.trim()) return null;
        return {
            type: t,
            content: c,
            timestamp: Number(msg.timestamp) || Date.now()
        };
    }

    function mapSenderLabel(msg) {
        if (!msg || typeof msg !== 'object') return '消息';
        return msg.type === 'user' ? '我' : 'TA';
    }

    function mapQuotePreview(msg, maxLen) {
        var c = msg && msg.content != null ? String(msg.content) : '';
        c = c.replace(/\s+/g, ' ').trim();
        var n = maxLen || 52;
        return c.length > n ? c.slice(0, n) + '...' : c;
    }

    function saveMapChatHistory() {
        saveMissingDistanceData(currentFriendId, {
            missingDistanceChatHistory: mapChatHistory
        });
    }

    function ensureMissingDistanceInteractionUi() {
        var page = getMissingDistancePage();
        if (!page) return;

        if (!document.getElementById('missing-distance-action-menu')) {
            var menu = document.createElement('div');
            menu.id = 'missing-distance-action-menu';
            menu.className = 'missing-distance-action-menu';
            menu.setAttribute('role', 'menu');
            menu.innerHTML =
                '<button type="button" class="missing-distance-action-item" data-action="backtrack" role="menuitem">' +
                '<span class="missing-distance-action-icon">↩</span><span>回溯</span></button>' +
                '<button type="button" class="missing-distance-action-item" data-action="edit" role="menuitem">' +
                '<span class="missing-distance-action-icon">✎</span><span>编辑</span></button>' +
                '<button type="button" class="missing-distance-action-item" data-action="quote" role="menuitem">' +
                '<span class="missing-distance-action-icon">”</span><span>引用</span></button>' +
                '<button type="button" class="missing-distance-action-item" data-action="multiselect" role="menuitem">' +
                '<span class="missing-distance-action-icon">✓</span><span>多选</span></button>';
            page.appendChild(menu);
            menu.addEventListener('click', function (e) {
                var item = e.target && e.target.closest ? e.target.closest('.missing-distance-action-item') : null;
                if (!item) return;
                e.preventDefault();
                e.stopPropagation();
                handleMissingDistanceMessageAction(item.getAttribute('data-action') || '');
            });
        }

        if (!document.getElementById('missing-distance-quote-frame')) {
            var quote = document.createElement('div');
            quote.id = 'missing-distance-quote-frame';
            quote.className = 'missing-distance-quote-frame';
            quote.innerHTML =
                '<div class="missing-distance-quote-head">' +
                '<span class="missing-distance-quote-name" id="missing-distance-quote-name"></span>' +
                '<button type="button" class="missing-distance-quote-close" aria-label="关闭引用">×</button>' +
                '</div>' +
                '<div class="missing-distance-quote-content" id="missing-distance-quote-content"></div>';
            page.appendChild(quote);
            quote.addEventListener('click', function (e) {
                if (e.target && e.target.closest && e.target.closest('.missing-distance-quote-close')) {
                    e.preventDefault();
                    e.stopPropagation();
                    closeMissingDistanceQuote();
                    return;
                }
                if (currentMapQuoteMessage) openMissingDistanceQuoteDetail(currentMapQuoteMessage);
            });
        }

        if (!document.getElementById('missing-distance-multiselect-bar')) {
            var multi = document.createElement('div');
            multi.id = 'missing-distance-multiselect-bar';
            multi.className = 'missing-distance-multiselect-bar';
            multi.innerHTML =
                '<span class="missing-distance-selected-count" id="missing-distance-selected-count">已选择 0 条消息</span>' +
                '<div class="missing-distance-multiselect-actions">' +
                '<button type="button" class="missing-distance-mini-btn" data-action="select-all">全选</button>' +
                '<button type="button" class="missing-distance-mini-btn" data-action="favorite">收藏</button>' +
                '<button type="button" class="missing-distance-mini-btn danger" data-action="delete">删除</button>' +
                '<button type="button" class="missing-distance-mini-btn" data-action="cancel">取消</button>' +
                '</div>';
            page.appendChild(multi);
            multi.addEventListener('click', function (e) {
                var btn = e.target && e.target.closest ? e.target.closest('button[data-action]') : null;
                if (!btn) return;
                var action = btn.getAttribute('data-action');
                if (action === 'select-all') selectAllMissingDistanceMessages();
                if (action === 'favorite') favoriteSelectedMissingDistanceMessages();
                if (action === 'delete') openMissingDistanceDeleteConfirm();
                if (action === 'cancel') exitMissingDistanceMultiselectMode();
            });
        }

        if (!document.getElementById('missing-distance-backtrack-dialog')) {
            var backtrack = document.createElement('div');
            backtrack.id = 'missing-distance-backtrack-dialog';
            backtrack.className = 'missing-distance-dialog missing-distance-confirm-dialog';
            backtrack.setAttribute('aria-hidden', 'true');
            backtrack.innerHTML =
                '<div class="missing-distance-dialog-scrim" data-md-close="backtrack"></div>' +
                '<div class="missing-distance-dialog-panel" role="dialog" aria-labelledby="missing-distance-backtrack-title">' +
                '<div class="missing-distance-dialog-body">' +
                '<div class="missing-distance-confirm-title" id="missing-distance-backtrack-title">回溯消息</div>' +
                '<div class="missing-distance-confirm-text">回溯后，此消息之后的思念距离聊天记录将被删除，是否确定？</div>' +
                '</div>' +
                '<div class="missing-distance-dialog-footer">' +
                '<button type="button" class="missing-distance-dialog-btn" data-md-close="backtrack">取消</button>' +
                '<button type="button" class="missing-distance-dialog-btn missing-distance-dialog-btn--primary" data-md-confirm="backtrack">确定</button>' +
                '</div></div>';
            page.appendChild(backtrack);
        }

        if (!document.getElementById('missing-distance-edit-dialog')) {
            var edit = document.createElement('div');
            edit.id = 'missing-distance-edit-dialog';
            edit.className = 'missing-distance-dialog';
            edit.setAttribute('aria-hidden', 'true');
            edit.innerHTML =
                '<div class="missing-distance-dialog-scrim" data-md-close="edit"></div>' +
                '<div class="missing-distance-dialog-panel" role="dialog" aria-labelledby="missing-distance-edit-title">' +
                '<div class="missing-distance-dialog-head">' +
                '<span id="missing-distance-edit-title">编辑消息</span>' +
                '<button type="button" class="missing-distance-dialog-close" data-md-close="edit" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="missing-distance-dialog-body">' +
                '<textarea class="missing-distance-edit-input" id="missing-distance-edit-input" maxlength="500" placeholder="编辑消息内容..."></textarea>' +
                '</div>' +
                '<div class="missing-distance-dialog-footer">' +
                '<button type="button" class="missing-distance-dialog-btn" data-md-close="edit">取消</button>' +
                '<button type="button" class="missing-distance-dialog-btn missing-distance-dialog-btn--primary" data-md-confirm="edit">确定</button>' +
                '</div></div>';
            page.appendChild(edit);
        }

        if (!document.getElementById('missing-distance-delete-dialog')) {
            var del = document.createElement('div');
            del.id = 'missing-distance-delete-dialog';
            del.className = 'missing-distance-dialog missing-distance-confirm-dialog';
            del.setAttribute('aria-hidden', 'true');
            del.innerHTML =
                '<div class="missing-distance-dialog-scrim" data-md-close="delete"></div>' +
                '<div class="missing-distance-dialog-panel" role="dialog" aria-labelledby="missing-distance-delete-title">' +
                '<div class="missing-distance-dialog-body">' +
                '<div class="missing-distance-confirm-title" id="missing-distance-delete-title">删除消息</div>' +
                '<div class="missing-distance-confirm-text">是否确认删除选中的思念距离聊天记录？</div>' +
                '</div>' +
                '<div class="missing-distance-dialog-footer">' +
                '<button type="button" class="missing-distance-dialog-btn" data-md-close="delete">取消</button>' +
                '<button type="button" class="missing-distance-dialog-btn missing-distance-dialog-btn--primary" data-md-confirm="delete">确定</button>' +
                '</div></div>';
            page.appendChild(del);
        }

        if (!document.getElementById('missing-distance-quote-detail-dialog')) {
            var detail = document.createElement('div');
            detail.id = 'missing-distance-quote-detail-dialog';
            detail.className = 'missing-distance-dialog';
            detail.setAttribute('aria-hidden', 'true');
            detail.innerHTML =
                '<div class="missing-distance-dialog-scrim" data-md-close="quote-detail"></div>' +
                '<div class="missing-distance-dialog-panel" role="dialog" aria-labelledby="missing-distance-quote-detail-title">' +
                '<div class="missing-distance-dialog-head">' +
                '<span id="missing-distance-quote-detail-title">引用原文</span>' +
                '<button type="button" class="missing-distance-dialog-close" data-md-close="quote-detail" aria-label="关闭">×</button>' +
                '</div>' +
                '<div class="missing-distance-dialog-body">' +
                '<div class="missing-distance-quote-detail-name" id="missing-distance-quote-detail-name"></div>' +
                '<div class="missing-distance-quote-detail-content" id="missing-distance-quote-detail-content"></div>' +
                '</div></div>';
            page.appendChild(detail);
        }

        if (page.dataset.boundMissingDistanceDialogs !== '1') {
            page.dataset.boundMissingDistanceDialogs = '1';
            page.addEventListener('click', function (e) {
                var closeEl = e.target && e.target.closest ? e.target.closest('[data-md-close]') : null;
                if (closeEl) {
                    closeMissingDistanceDialog(closeEl.getAttribute('data-md-close'));
                    return;
                }
                var confirmEl = e.target && e.target.closest ? e.target.closest('[data-md-confirm]') : null;
                if (confirmEl) {
                    var what = confirmEl.getAttribute('data-md-confirm');
                    if (what === 'backtrack') confirmMissingDistanceBacktrack();
                    if (what === 'edit') confirmMissingDistanceEdit();
                    if (what === 'delete') confirmMissingDistanceDelete();
                }
            });
        }
    }

    function showMissingDistanceDialog(kind) {
        ensureMissingDistanceInteractionUi();
        var dialog = document.getElementById('missing-distance-' + kind + '-dialog');
        if (!dialog) return;
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
    }

    function closeMissingDistanceDialog(kind) {
        var dialog = document.getElementById('missing-distance-' + kind + '-dialog');
        if (!dialog) return;
        dialog.classList.remove('show');
        dialog.setAttribute('aria-hidden', 'true');
        if (kind === 'edit') editingMapMessageIndex = -1;
    }

    function closeMissingDistanceActionMenu() {
        var menu = document.getElementById('missing-distance-action-menu');
        if (menu) menu.classList.remove('show');
        document.removeEventListener('click', closeMissingDistanceActionMenu);
        document.removeEventListener('contextmenu', closeMissingDistanceActionMenu);
    }

    function showMissingDistanceActionMenu(event, bubble) {
        if (isMapMultiselectMode) return;
        ensureMissingDistanceInteractionUi();
        var menu = document.getElementById('missing-distance-action-menu');
        var page = getMissingDistancePage();
        if (!menu || !page || !bubble) return;

        var idx = Number(bubble.getAttribute('data-message-index'));
        if (!Number.isFinite(idx) || !getMapMessageByIndex(idx)) return;
        activeMapMessageIndex = idx;

        closeMissingDistanceActionMenu();
        var bubbleRect = bubble.getBoundingClientRect();
        var pageRect = page.getBoundingClientRect();
        var menuWidth = 292;
        var menuHeight = 66;
        var left = bubbleRect.left - pageRect.left + (bubbleRect.width / 2) - (menuWidth / 2);
        var top = bubbleRect.top - pageRect.top - menuHeight - 8;
        if (top < 8) top = bubbleRect.bottom - pageRect.top + 8;
        if (left < 8) left = 8;
        if (left + menuWidth > pageRect.width - 8) left = Math.max(8, pageRect.width - menuWidth - 8);

        menu.style.left = left + 'px';
        menu.style.top = top + 'px';
        menu.classList.add('show');

        setTimeout(function () {
            document.addEventListener('click', closeMissingDistanceActionMenu);
            document.addEventListener('contextmenu', closeMissingDistanceActionMenu);
        }, 100);

        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        if (event && typeof event.stopPropagation === 'function') event.stopPropagation();
    }

    function handleMissingDistanceMessageAction(action) {
        closeMissingDistanceActionMenu();
        var msg = getMapMessageByIndex(activeMapMessageIndex);
        if (!msg) {
            if (typeof showNotification === 'function') showNotification('无法定位该消息，请重新长按气泡');
            return;
        }

        if (action === 'backtrack') {
            showMissingDistanceDialog('backtrack');
        } else if (action === 'edit') {
            openMissingDistanceEditDialog(activeMapMessageIndex);
        } else if (action === 'quote') {
            currentMapQuoteMessage = cloneMapQuoteSnapshot(msg);
            renderMissingDistanceQuoteFrame();
            var input = document.getElementById('missing-distance-chat-input');
            if (input) {
                try { input.focus(); } catch (e) {}
            }
        } else if (action === 'multiselect') {
            enterMissingDistanceMultiselectMode(activeMapMessageIndex);
        }
    }

    function confirmMissingDistanceBacktrack() {
        var msg = getMapMessageByIndex(activeMapMessageIndex);
        if (!msg) {
            closeMissingDistanceDialog('backtrack');
            if (typeof showNotification === 'function') showNotification('消息未找到');
            return;
        }
        mapChatHistory = mapChatHistory.slice(0, activeMapMessageIndex + 1);
        saveMapChatHistory();
        closeMissingDistanceDialog('backtrack');
        activeMapMessageIndex = -1;
        renderMapChatMessages();
        if (typeof showNotification === 'function') showNotification('回溯成功');
    }

    function openMissingDistanceEditDialog(index) {
        var msg = getMapMessageByIndex(index);
        if (!msg) {
            if (typeof showNotification === 'function') showNotification('消息未找到');
            return;
        }
        editingMapMessageIndex = index;
        showMissingDistanceDialog('edit');
        var input = document.getElementById('missing-distance-edit-input');
        if (input) {
            input.value = msg.content == null ? '' : String(msg.content);
            setTimeout(function () {
                try {
                    input.focus();
                    input.select();
                } catch (e) {}
            }, 30);
        }
    }

    function confirmMissingDistanceEdit() {
        var msg = getMapMessageByIndex(editingMapMessageIndex);
        var input = document.getElementById('missing-distance-edit-input');
        if (!msg || !input) {
            if (typeof showNotification === 'function') showNotification('操作失败，请重试');
            return;
        }
        var val = String(input.value || '').trim();
        if (!val) {
            if (typeof showNotification === 'function') showNotification('消息内容不能为空');
            return;
        }
        msg.content = val;
        saveMapChatHistory();
        closeMissingDistanceDialog('edit');
        renderMapChatMessages();
        if (typeof showNotification === 'function') showNotification('消息编辑成功');
    }

    function renderMissingDistanceQuoteFrame() {
        ensureMissingDistanceInteractionUi();
        var frame = document.getElementById('missing-distance-quote-frame');
        var name = document.getElementById('missing-distance-quote-name');
        var content = document.getElementById('missing-distance-quote-content');
        if (!frame || !name || !content) return;
        if (!currentMapQuoteMessage) {
            frame.classList.remove('show');
            return;
        }
        name.textContent = mapSenderLabel(currentMapQuoteMessage);
        content.textContent = mapQuotePreview(currentMapQuoteMessage, 80);
        frame.classList.add('show');
    }

    function closeMissingDistanceQuote() {
        currentMapQuoteMessage = null;
        renderMissingDistanceQuoteFrame();
    }

    function openMissingDistanceQuoteDetail(msg) {
        if (!msg) return;
        showMissingDistanceDialog('quote-detail');
        var name = document.getElementById('missing-distance-quote-detail-name');
        var content = document.getElementById('missing-distance-quote-detail-content');
        if (name) name.textContent = mapSenderLabel(msg);
        if (content) content.textContent = msg.content == null ? '' : String(msg.content);
    }

    function enterMissingDistanceMultiselectMode(seedIndex) {
        ensureMissingDistanceInteractionUi();
        isMapMultiselectMode = true;
        selectedMapMessageIndexes.clear();
        var idx = Number(seedIndex);
        if (Number.isFinite(idx) && getMapMessageByIndex(idx)) {
            selectedMapMessageIndexes.add(idx);
        }
        var page = getMissingDistancePage();
        if (page) page.classList.add('is-map-multiselect');
        renderMapChatMessages(true);
        updateMissingDistanceSelectedCount();
    }

    function exitMissingDistanceMultiselectMode() {
        isMapMultiselectMode = false;
        selectedMapMessageIndexes.clear();
        var page = getMissingDistancePage();
        if (page) page.classList.remove('is-map-multiselect');
        closeMissingDistanceDialog('delete');
        renderMapChatMessages(true);
    }

    function toggleMissingDistanceSelection(index) {
        var idx = Number(index);
        if (!Number.isFinite(idx) || !getMapMessageByIndex(idx)) return;
        if (selectedMapMessageIndexes.has(idx)) {
            selectedMapMessageIndexes.delete(idx);
        } else {
            selectedMapMessageIndexes.add(idx);
        }
        renderMapChatMessages(true);
        updateMissingDistanceSelectedCount();
    }

    function selectAllMissingDistanceMessages() {
        selectedMapMessageIndexes.clear();
        for (var i = 0; i < mapChatHistory.length; i++) {
            selectedMapMessageIndexes.add(i);
        }
        renderMapChatMessages(true);
        updateMissingDistanceSelectedCount();
    }

    function updateMissingDistanceSelectedCount() {
        var bar = document.getElementById('missing-distance-multiselect-bar');
        var count = document.getElementById('missing-distance-selected-count');
        if (bar) bar.classList.toggle('show', isMapMultiselectMode);
        if (count) count.textContent = '已选择 ' + selectedMapMessageIndexes.size + ' 条消息';
    }

    function favoriteSelectedMissingDistanceMessages() {
        if (!selectedMapMessageIndexes.size) {
            if (typeof showNotification === 'function') showNotification('请先选择要收藏的消息');
            return;
        }
        var favorites;
        try {
            favorites = JSON.parse(localStorage.getItem('wechatFavorites') || '[]');
            if (!Array.isArray(favorites)) favorites = [];
        } catch (e) {
            favorites = [];
        }
        var friend = getFriendById(currentFriendId);
        var sourceName = (friend && (friend.remark || friend.nickname)) || '思念距离';
        var indexes = Array.from(selectedMapMessageIndexes).sort(function (a, b) { return a - b; });
        var now = Date.now();
        indexes.forEach(function (idx, offset) {
            var msg = getMapMessageByIndex(idx);
            if (!msg) return;
            favorites.push({
                id: now + offset,
                sourceType: 'missing_distance_map',
                type: msg.type === 'user' ? 'user' : 'friend',
                content: msg.content == null ? '' : String(msg.content),
                quote: msg.quote ? cloneMapQuoteSnapshot(msg.quote) : null,
                sourceFriendId: currentFriendId,
                sourceFriendName: sourceName + ' · 思念距离',
                collectedAt: now + offset
            });
        });
        try {
            localStorage.setItem('wechatFavorites', JSON.stringify(favorites));
        } catch (e2) {
            if (typeof showNotification === 'function') showNotification('收藏失败：存储空间不足');
            return;
        }
        exitMissingDistanceMultiselectMode();
        if (typeof showNotification === 'function') showNotification('已收藏 ' + indexes.length + ' 条消息');
    }

    function openMissingDistanceDeleteConfirm() {
        if (!selectedMapMessageIndexes.size) {
            if (typeof showNotification === 'function') showNotification('请先选择要删除的消息');
            return;
        }
        showMissingDistanceDialog('delete');
    }

    function confirmMissingDistanceDelete() {
        if (!selectedMapMessageIndexes.size) {
            closeMissingDistanceDialog('delete');
            return;
        }
        var remove = new Set(selectedMapMessageIndexes);
        var deleted = remove.size;
        mapChatHistory = mapChatHistory.filter(function (_, idx) {
            return !remove.has(idx);
        });
        saveMapChatHistory();
        exitMissingDistanceMultiselectMode();
        if (typeof showNotification === 'function') showNotification('成功删除 ' + deleted + ' 条消息');
    }

    function appendMissingDistanceBubbleContent(bubble, msg) {
        bubble.innerHTML = '';
        if (msg && msg.quote) {
            var quote = document.createElement('div');
            quote.className = 'missing-distance-chat-quote';
            quote.setAttribute('role', 'button');
            quote.setAttribute('tabindex', '0');
            quote.title = '查看引用原文';
            var qName = document.createElement('span');
            qName.className = 'missing-distance-chat-quote-name';
            qName.textContent = mapSenderLabel(msg.quote);
            var qText = document.createElement('span');
            qText.className = 'missing-distance-chat-quote-text';
            qText.textContent = mapQuotePreview(msg.quote, 48);
            quote.appendChild(qName);
            quote.appendChild(qText);
            quote.addEventListener('click', function (e) {
                e.preventDefault();
                e.stopPropagation();
                openMissingDistanceQuoteDetail(msg.quote);
            });
            quote.addEventListener('keydown', function (e) {
                if (e.key !== 'Enter' && e.key !== ' ') return;
                e.preventDefault();
                e.stopPropagation();
                openMissingDistanceQuoteDetail(msg.quote);
            });
            bubble.appendChild(quote);
        }
        var text = document.createElement('div');
        text.className = 'missing-distance-chat-text';
        text.textContent = msg && msg.content != null ? String(msg.content) : '';
        bubble.appendChild(text);
    }

    function bindMissingDistanceBubbleEvents(bubble) {
        bubble.addEventListener('click', function (e) {
            if (!isMapMultiselectMode) return;
            e.preventDefault();
            e.stopPropagation();
            toggleMissingDistanceSelection(bubble.getAttribute('data-message-index'));
        });

        bubble.addEventListener('contextmenu', function (e) {
            e.preventDefault();
            e.stopPropagation();
            showMissingDistanceActionMenu(e, bubble);
        });

        var timer = null;
        var startX = 0;
        var startY = 0;
        bubble.addEventListener('touchstart', function (e) {
            if (isMapMultiselectMode) return;
            var touch = e.touches && e.touches[0];
            startX = touch ? touch.clientX : 0;
            startY = touch ? touch.clientY : 0;
            timer = setTimeout(function () {
                timer = null;
                showMissingDistanceActionMenu({ target: bubble }, bubble);
            }, 500);
        }, { passive: true });
        bubble.addEventListener('touchmove', function (e) {
            if (!timer) return;
            var touch = e.touches && e.touches[0];
            if (!touch) return;
            if (Math.abs(touch.clientX - startX) > 10 || Math.abs(touch.clientY - startY) > 10) {
                clearTimeout(timer);
                timer = null;
            }
        }, { passive: true });
        bubble.addEventListener('touchend', function () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }, { passive: true });
        bubble.addEventListener('touchcancel', function () {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }, { passive: true });
    }

    function resetMissingDistanceInteractionState() {
        closeMissingDistanceActionMenu();
        activeMapMessageIndex = -1;
        editingMapMessageIndex = -1;
        currentMapQuoteMessage = null;
        isMapMultiselectMode = false;
        selectedMapMessageIndexes.clear();
        var page = getMissingDistancePage();
        if (page) page.classList.remove('is-map-multiselect');
        ['backtrack', 'edit', 'delete', 'quote-detail'].forEach(closeMissingDistanceDialog);
        renderMissingDistanceQuoteFrame();
        updateMissingDistanceSelectedCount();
    }

    function renderMapChatMessages() {
        var container = document.getElementById('missing-distance-chat-messages');
        if (!container) return;

        container.innerHTML = '';
        container.classList.toggle('is-multiselect', isMapMultiselectMode);

        for (var i = 0; i < mapChatHistory.length; i++) {
            var msg = mapChatHistory[i];
            var bubble = document.createElement('div');
            bubble.className = 'missing-distance-chat-bubble ' +
                (msg.type === 'user' ? 'is-user' : 'is-friend');
            bubble.setAttribute('data-message-index', String(i));
            if (msg.timestamp != null) bubble.setAttribute('data-message-timestamp', String(msg.timestamp));
            bubble.setAttribute('role', 'button');
            bubble.setAttribute('tabindex', '0');
            appendMissingDistanceBubbleContent(bubble, msg);
            if (isMapMultiselectMode) {
                bubble.classList.add('has-selector');
                if (selectedMapMessageIndexes.has(i)) bubble.classList.add('selected');
                var selector = document.createElement('span');
                selector.className = 'missing-distance-chat-selector';
                selector.setAttribute('aria-hidden', 'true');
                bubble.appendChild(selector);
            }
            bindMissingDistanceBubbleEvents(bubble);
            container.appendChild(bubble);
        }
        updateMissingDistanceSelectedCount();

        // 滚动到底部
        if (!isMapMultiselectMode) container.scrollTop = container.scrollHeight;
    }

    function sendMapChatMessage() {
        var input = document.getElementById('missing-distance-chat-input');
        if (!input) return;

        var content = input.value.trim();
        if (!content) {
            if (typeof showNotification === 'function') showNotification('请输入消息内容');
            return;
        }

        // 添加用户消息
        var userMsg = {
            type: 'user',
            content: content,
            timestamp: Date.now()
        };
        if (currentMapQuoteMessage) {
            userMsg.quote = cloneMapQuoteSnapshot(currentMapQuoteMessage);
        }
        mapChatHistory.push(userMsg);

        // 保存到存储
        saveMapChatHistory();

        // 渲染消息
        renderMapChatMessages();

        // 清空输入框
        input.value = '';
        closeMissingDistanceQuote();
    }

    function sanitizeMissingDistanceFriendReply(raw) {
        var t = String(raw == null ? '' : raw).trim();
        if (!t) return '';
        if (typeof sanitizeWechatFriendApiResponseText === 'function') {
            var cleaned = sanitizeWechatFriendApiResponseText(t, { noOriginalFallback: true });
            cleaned = String(cleaned == null ? '' : cleaned).trim();
            if (cleaned.length) return cleaned;
        }
        var m = t.match(/<reply\s*>([\s\S]*?)<\/reply\s*>/i);
        if (m && String(m[1] || '').trim()) return String(m[1]).trim();
        return t.replace(/<\/?reply[^>]*>/gi, '').trim();
    }

    function setMissingDistanceReceiveLoading(on) {
        var btn = document.getElementById('missing-distance-receive-btn');
        if (!btn) return null;
        if (on) {
            if (btn._recvDotsTimer) {
                try {
                    clearInterval(btn._recvDotsTimer);
                } catch (e2) {}
                btn._recvDotsTimer = null;
            }
            btn._recvOrigLabel = btn._recvOrigLabel || String(btn.textContent || '接收').trim() || '接收';
            btn.disabled = true;
            btn.setAttribute('aria-busy', 'true');
            var phase = 1;
            btn.textContent = '·';
            btn._recvDotsTimer = setInterval(function () {
                phase = phase >= 3 ? 1 : phase + 1;
                btn.textContent = '···'.slice(0, phase);
            }, 320);
        } else {
            if (btn._recvDotsTimer) {
                try {
                    clearInterval(btn._recvDotsTimer);
                } catch (e3) {}
                btn._recvDotsTimer = null;
            }
            btn.disabled = false;
            btn.removeAttribute('aria-busy');
            btn.textContent = btn._recvOrigLabel || '接收';
        }
        return btn;
    }

    async function receiveMapChatMessage() {
        if (typeof CommandManager === 'undefined' || typeof FeatureCommandMapper === 'undefined') {
            if (typeof showNotification === 'function') showNotification('系统未加载API模块');
            return;
        }

        var sendContent = CommandManager.buildMissingDistanceReceiveSendContent(currentFriendId, {
            mapChatHistory: mapChatHistory.slice(),
            distanceData: distanceData
        });

        if (!sendContent) {
            if (typeof showNotification === 'function') showNotification('无法构建接收请求');
            return;
        }

        setMissingDistanceReceiveLoading(true);

        try {
            if (typeof showNotification === 'function') showNotification('正在接收消息...');

            var raw = null;
            try {
                raw = await FeatureCommandMapper.callApiModel(sendContent, null, {
                    skipOverlay: true,
                    suppressErrorDialog: true
                });
            } catch (e) {
                console.error('接收消息失败:', e);
            }

            if (!raw || !String(raw).trim()) {
                if (typeof showNotification === 'function') showNotification('接收失败，请稍后重试');
                return;
            }

            var reply = sanitizeMissingDistanceFriendReply(raw);
            if (!reply || !String(reply).trim()) {
                if (typeof showNotification === 'function') showNotification('收到内容为空或被过滤，请重试');
                return;
            }

            var friendMsg = {
                type: 'friend',
                content: reply,
                timestamp: Date.now()
            };
            mapChatHistory.push(friendMsg);

            saveMapChatHistory();

            renderMapChatMessages();

            if (typeof showNotification === 'function') showNotification('已收到TA的回复');
        } finally {
            setMissingDistanceReceiveLoading(false);
        }
    }

    // ==================== 总结功能 ====================

    function summarizeMapChat() {
        if (!currentFriendId) {
            if (typeof showNotification === 'function') showNotification('请先进入思念距离界面');
            return;
        }

        var hist = mapChatHistory && mapChatHistory.length ? mapChatHistory : [];
        if (!hist.length) {
            var dataSnap = loadMissingDistanceData(currentFriendId);
            if (dataSnap && Array.isArray(dataSnap.chatHistory) && dataSnap.chatHistory.length) {
                hist = dataSnap.chatHistory;
            }
        }
        if (!hist.length) {
            if (typeof showNotification === 'function') showNotification('还没有地图聊天记录可以总结');
            return;
        }

        // 对齐微信「聊天记忆总结」弹窗；确认后生成的长记忆写入与主聊天相同的长记忆库，便于接续微信对话
        if (typeof global.openChatSummaryModalForFriend === 'function') {
            global.openChatSummaryModalForFriend(String(currentFriendId), { source: 'missing_distance_map' });
            return;
        }
        if (typeof showNotification === 'function') showNotification('聊天总结模块未加载，请刷新页面');
    }

    function showSummaryDialog(summary) {
        var dialog = document.getElementById('missing-distance-summary-dialog');
        var content = document.getElementById('missing-distance-summary-content');

        if (!dialog || !content) return;

        content.textContent = summary;
        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
    }

    function closeSummaryDialog() {
        var dialog = document.getElementById('missing-distance-summary-dialog');
        if (!dialog) return;

        dialog.classList.remove('show');
        dialog.setAttribute('aria-hidden', 'true');
    }

    function copySummaryToClipboard() {
        var content = document.getElementById('missing-distance-summary-content');
        if (!content) return;

        var text = content.textContent;

        // 尝试复制到剪贴板
        if (navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(text).then(function() {
                if (typeof showNotification === 'function') showNotification('已复制到剪贴板');
                closeSummaryDialog();
            }).catch(function(e) {
                console.error('复制失败:', e);
                if (typeof showNotification === 'function') showNotification('复制失败');
            });
        } else {
            // 降级方案
            var textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            try {
                document.execCommand('copy');
                if (typeof showNotification === 'function') showNotification('已复制到剪贴板');
                closeSummaryDialog();
            } catch (e) {
                console.error('复制失败:', e);
                if (typeof showNotification === 'function') showNotification('复制失败');
            }
            document.body.removeChild(textarea);
        }
    }

    // ==================== API设置 ====================

    function openMissingDistanceApiSettings() {
        var dialog = document.getElementById('missing-distance-api-dialog');
        var urlInput = document.getElementById('missing-distance-api-url');
        var keyInput = document.getElementById('missing-distance-api-key');

        if (!dialog) return;

        // 加载当前设置
        if (urlInput) urlInput.value = apiSettings.apiUrl || '';
        if (keyInput) keyInput.value = apiSettings.apiKey || '';

        dialog.classList.add('show');
        dialog.setAttribute('aria-hidden', 'false');
    }

    function closeMissingDistanceApiSettings() {
        var dialog = document.getElementById('missing-distance-api-dialog');
        if (!dialog) return;

        dialog.classList.remove('show');
        dialog.setAttribute('aria-hidden', 'true');
    }

    /** 打开地图 API / 位置设置弹窗，并聚焦到指定位置输入框（输入框仅在弹窗可见时填写） */
    function openMissingDistanceLocationEditor(field) {
        var which = field === 'user' ? 'user' : 'char';
        openMissingDistanceApiSettings();

        window.setTimeout(function () {
            var el =
                document.getElementById(
                    which === 'user' ? 'missing-distance-user-location' : 'missing-distance-char-location'
                );
            if (el) {
                try {
                    el.focus();
                    if (typeof el.select === 'function') el.select();
                } catch (e) {}
            }
        }, 80);
    }

    function saveMissingDistanceApiSettings() {
        var urlInput = document.getElementById('missing-distance-api-url');
        var keyInput = document.getElementById('missing-distance-api-key');

        if (!urlInput || !keyInput) return;

        apiSettings = {
            apiUrl: urlInput.value.trim(),
            apiKey: keyInput.value.trim()
        };

        var charLocInputDlg = document.getElementById('missing-distance-char-location');
        var userLocInputDlg = document.getElementById('missing-distance-user-location');

        // 保存到存储（地理位置与 API 一起保存，便于「思念距离」直接读取）
        saveMissingDistanceData(currentFriendId, {
            missingDistanceApiSettings: apiSettings,
            missingDistanceCharLocation: charLocInputDlg ? String(charLocInputDlg.value || '').trim() : '',
            missingDistanceUserLocation: userLocInputDlg ? String(userLocInputDlg.value || '').trim() : ''
        });

        if (typeof showNotification === 'function') showNotification('API设置已保存');
        closeMissingDistanceApiSettings();
    }

    // ==================== 页面控制 ====================

    function openMissingDistancePage() {
        try {
            var fid = getActiveFriendIdFromPrivateContext();
            if (!fid) {
                if (typeof showNotification === 'function') showNotification('无法识别当前情侣，请返回情侣空间主页再进入私密空间');
                return;
            }

            var st = store();
            if (!st || typeof st.getPair !== 'function') {
                if (typeof showNotification === 'function') showNotification('情侣空间数据未加载，请稍后再试或刷新页面');
                return;
            }
            var pair = st.getPair(fid);
            if (!pair || String(pair.status) !== 'accepted') {
                if (typeof showNotification === 'function') showNotification('仅已确定关系的情侣可使用思念距离');
                return;
            }

            currentFriendId = fid;
            ensureMissingDistanceInteractionUi();
            resetMissingDistanceInteractionState();

            loadAvatarImages();

            var data = loadMissingDistanceData(fid);
            if (data) {
                distanceData = data.distanceData;
                apiSettings = data.apiSettings;
                mapChatHistory = Array.isArray(data.chatHistory) ? data.chatHistory.slice() : [];

                var charLocInput = document.getElementById('missing-distance-char-location');
                var userLocInput = document.getElementById('missing-distance-user-location');
                if (charLocInput) charLocInput.value = data.charLocation || '';
                if (userLocInput) userLocInput.value = data.userLocation || '';

                if (distanceData) {
                    displayDistanceResult(distanceData);
                }
            } else {
                mapChatHistory = [];
                distanceData = null;
                apiSettings = { apiUrl: '', apiKey: '' };
            }

            window.setTimeout(function () {
                try {
                    renderMapCanvas();
                } catch (e1) {}
            }, 100);
            try {
                renderMapChatMessages();
            } catch (e2) {}

            var page = document.getElementById('missing-distance-page');
            var root = document.getElementById('couple-space-page');
            if (page) {
                page.classList.add('show');
                page.setAttribute('aria-hidden', 'false');
            }
            if (root) root.classList.add('is-missing-distance-open');
        } catch (err) {
            console.error('[思念距离]', err);
            if (typeof showNotification === 'function') showNotification('打开思念距离失败，请重试');
        }
    }

    function closeMissingDistancePage() {
        var page = document.getElementById('missing-distance-page');
        var root = document.getElementById('couple-space-page');
        resetMissingDistanceInteractionState();
        if (page) {
            page.classList.remove('show');
            page.setAttribute('aria-hidden', 'true');
        }
        if (root) root.classList.remove('is-missing-distance-open');

        currentFriendId = '';
        mapChatHistory = [];
        distanceData = null;
    }

    // ==================== 初始化 ====================

    function bindMissingDistanceButtonOnce() {
        if (global.__missingDistanceBtnBound) return;

        function routeClick(e) {
            var tgt = e.target;
            var hit =
                tgt && typeof tgt.closest === 'function'
                    ? tgt.closest('#couple-private-missing-distance-btn')
                    : null;
            if (!hit) return;
            e.preventDefault();
            e.stopPropagation();
            openMissingDistancePage();
        }

        var root = document.getElementById('couple-space-page');
        if (root) {
            root.addEventListener('click', routeClick);
            global.__missingDistanceBtnBound = true;
            return;
        }

        var btn = document.getElementById('couple-private-missing-distance-btn');
        if (btn) {
            btn.addEventListener('click', function (ev) {
                if (ev) ev.preventDefault();
                openMissingDistancePage();
            });
            global.__missingDistanceBtnBound = true;
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindMissingDistanceButtonOnce);
    } else {
        bindMissingDistanceButtonOnce();
    }

    // 暴露全局函数
    global.openMissingDistancePage = openMissingDistancePage;
    global.closeMissingDistancePage = closeMissingDistancePage;
    global.calculateDistance = calculateDistance;
    global.sendMapChatMessage = sendMapChatMessage;
    global.receiveMapChatMessage = receiveMapChatMessage;
    global.summarizeMapChat = summarizeMapChat;
    global.openMissingDistanceApiSettings = openMissingDistanceApiSettings;
    global.closeMissingDistanceApiSettings = closeMissingDistanceApiSettings;
    global.saveMissingDistanceApiSettings = saveMissingDistanceApiSettings;
    global.closeSummaryDialog = closeSummaryDialog;
    global.copySummaryToClipboard = copySummaryToClipboard;
    global.openMissingDistanceLocationEditor = openMissingDistanceLocationEditor;

})(typeof window !== 'undefined' ? window : globalThis);
