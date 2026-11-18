/** 微信聊天控件的显示状态；消息发送、接收与持久化仍由原聊天管线负责。 */
(function (global) {
    'use strict';

    global.openWechatNativeVoiceMessage = function () {
        var page = document.getElementById('chat-page');
        if (!page || !page.dataset.friendId) return;
        if (typeof global.isVoicePhoneCallActive === 'function' && global.isVoicePhoneCallActive()) {
            if (typeof global.showNotification === 'function') global.showNotification('语音通话中仅可发送文字消息');
            return;
        }
        if (typeof global.closeEmojiPanel === 'function') global.closeEmojiPanel();
        if (typeof global.closeMorePanel === 'function') global.closeMorePanel();
        if (typeof global.openVoiceMessageComposeModal === 'function') {
            global.openVoiceMessageComposeModal();
        } else if (typeof global.showNotification === 'function') {
            global.showNotification('语音模块未加载，请刷新页面');
        }
    };

    function bindNativeChatControls() {
        var page = document.getElementById('chat-page');
        var input = document.getElementById('chat-input');
        var area = page && page.querySelector('.chat-input-area');
        if (!page || !input || !area || area.dataset.nativeControlsBound === '1') return;
        area.dataset.nativeControlsBound = '1';
        var send = area.querySelector('.send-btn');
        var receive = area.querySelector('.receive-btn');
        var receiveLabel = area.querySelector('.chat-native-receive-label');
        var emojiButton = area.querySelector('.emoji-btn');
        var moreButton = area.querySelector('.more-btn');
        var emojiPanel = document.getElementById('emoji-panel');
        var morePanel = document.getElementById('chat-more-panel');

        function sync() {
            var hasText = String(input.value || '').trim().length > 0;
            area.classList.toggle('has-text', hasText);
            if (send) send.hidden = !hasText;
            if (receive) {
                var busy = receive.classList.contains('loading');
                var countdownBadge = receive.querySelector('.proactive-receive-countdown');
                var countdown = countdownBadge ? String(countdownBadge.textContent || '').trim() : '';
                receive.setAttribute('aria-busy', String(busy));
                receive.setAttribute('aria-label', busy ? '正在接收，点击取消' : countdown ? '接收回复：' + countdown : '接收回复');
                if (busy) receive.title = '正在接收，点击取消';
                else if (!countdown) receive.title = '接收好友回复';
                else if (!receive.title || receive.title === '正在接收，点击取消' || receive.title === '接收好友回复') {
                    receive.title = countdown + '，点击可立即接收或取消生成';
                }
                if (receiveLabel) receiveLabel.textContent = busy ? '停止' : '接收';
            }
            if (emojiButton) emojiButton.setAttribute('aria-expanded', String(!!emojiPanel && emojiPanel.classList.contains('show')));
            if (moreButton) moreButton.setAttribute('aria-expanded', String(!!morePanel && morePanel.classList.contains('show')));
        }

        input.addEventListener('input', sync);
        input.addEventListener('change', sync);
        input.addEventListener('keyup', sync);
        // 原发送与表情插入会直接写 input.value，在它们的原有 handler 结束后同步显示。
        page.addEventListener('click', function () { Promise.resolve().then(sync); });
        if (typeof MutationObserver === 'function') {
            var observer = new MutationObserver(sync);
            [page, receive, emojiPanel, morePanel].forEach(function (element) {
                if (element) observer.observe(element, { attributes: true, attributeFilter: ['class', 'data-friend-id'] });
            });
        }
        sync();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', bindNativeChatControls, { once: true });
    } else {
        bindNativeChatControls();
    }
})(window);
