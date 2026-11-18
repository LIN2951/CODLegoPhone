/**
 * 微信好友/群设置表单中「未提交」编辑的临时字典（从 app.js 迁出）。
 * 键名与引用方式不变：全局 tempFriendData / tempGroupData，供 app.js、wechat-ui-profile.js 等共用。
 * 命名空间：wechat-store.js 载入后可用 Wechat.store.tempFriendData / tempGroupData（与全局为同一对象引用）。
 * 加载顺序：紧接 wechat-shell.js 之后、app.js 之前（须先于任意读写二者的脚本）。
 */
(function (g) {
    'use strict';
    var tf = {};
    var tg = {};
    g.tempFriendData = tf;
    g.tempGroupData = tg;
})(typeof window !== 'undefined' ? window : globalThis);
