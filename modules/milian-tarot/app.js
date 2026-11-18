import { SPREADS, autoSpread, createSession, selectCard, revealCards, placedCards, randomInt,
  uid, REQUEST_LEASE_MS, parseBackup } from './core.js';
import * as storage from './storage.js';
import { readingPrompt, companionPrompt } from './prompts.js';
import { mdToHtml } from './upstream/tarot/reading.js';
import { cardImage, releaseImages, clearTarotCache, cacheInformation, registerOfflineCache } from './cache.js';

const $ = selector => document.querySelector(selector);
const content = $('#content');
const escape = value => String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
const date = value => new Date(value).toLocaleString('zh-CN', { month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit' });
const host = window.parent !== window ? window.parent.LegoMilianTarot : null;
let context, preferences, active = null, view = 'home', previousView = 'home', viewEpoch = 0;
let busy = false, closed = false, activeRequest = null, polling = false, draftTimer, unsaved = null;
let historyRecords = [], historyLimit = 30;
let cacheInfo = { cards: 0, offline: false };

function notify(message) {
  $('#notice').textContent = message; $('#notice').hidden = !message;
}
function apiConfig() {
  try { return host.configuration(window); } catch (_) { return { ready: false, model: '' }; }
}
function hasRunning() { return !!active && ['reading', 'companion'].some(kind => active[kind].status === 'running'); }
function chosenSpread() {
  return preferences.spreadChoice === 'auto' ? autoSpread(preferences.question || '').spread
    : SPREADS.find(s => s.id === preferences.spreadChoice) || SPREADS[2];
}
function footer() { return '<p class="footer-note">塔罗供娱乐与自我反思，牌面不预言未来。</p>'; }
function homeHtml() {
  const spread = chosenSpread();
  return `<section class="hero"><div class="orbit" aria-hidden="true"><span class="star">✦</span></div>
    <p class="eyebrow">a little ritual for two</p><h1>让星光落在<br>我们之间</h1><p class="muted">把心事交给牌，把回应留给彼此。</p></section>
    <section class="panel"><label for="question" class="field-title">此刻，你想问些什么？</label>
    <textarea id="question" maxlength="1000" rows="3" placeholder="比如：我们可以怎样更好地靠近彼此？">${escape(preferences.question || '')}</textarea>
    <div class="field-row"><label for="spread-choice">选择牌阵</label><span class="muted" id="question-count">${(preferences.question || '').length}/1000</span></div>
    <select id="spread-choice"><option value="auto" ${preferences.spreadChoice === 'auto' ? 'selected' : ''}>让问题决定牌阵</option>
    ${SPREADS.map(s => `<option value="${s.id}" ${preferences.spreadChoice === s.id ? 'selected' : ''}>${s.zh} · ${s.count} 张</option>`).join('')}</select>
    <p class="hint spread-info" id="spread-info">${escape(spread.zh + ' · ' + spread.bestFor)}</p>
    <div class="field-row"><label><input type="checkbox" id="reversals" ${preferences.reversals !== false ? 'checked' : ''}>包含逆位牌</label><span class="muted">78 张完整牌库</span></div></section>
    <button class="primary wide" data-action="start" ${busy ? 'disabled' : ''}>${busy ? '正在洗牌…' : '静下心，开始洗牌'}</button>
    ${active ? '<button class="link-button wide" data-action="resume">继续上一次的牌组</button>' : ''}
    <p class="hint" style="text-align:center">抽牌和基础牌义免费离线可用，AI 解读需已配置接口。</p>${footer()}`;
}

function slotHtml(index, revealed) {
  const spread = SPREADS.find(s => s.id === active.spreadId);
  const picked = index < active.selected.length;
  const draw = picked ? placedCards(active)[index] : null;
  return `<div class="slot"><div class="slot-label">${index + 1} · ${escape(spread.slots[index].label)}</div>
    <button class="tarot-card ${revealed ? (draw.reversed ? 'reversed' : '') : 'back'}" ${revealed ? `data-action="detail" data-position="${index}"` : 'disabled'}
      aria-label="${escape(revealed ? draw.card.zh + (draw.reversed ? '逆位' : '正位') + '，查看牌义' : picked ? '已选，尚未翻开' : '等待选牌')}">
      ${revealed ? `<span class="card-fallback" aria-hidden="true">${escape(draw.card.zh)}</span>` : ''}</button>
    <span class="card-title">${revealed ? escape(draw.card.zh) : picked ? '已选定' : '等待相遇'}</span>
    ${revealed ? `<span class="orientation">${draw.reversed ? '逆位' : '正位'}</span>` : ''}</div>`;
}

function readingPanel(kind) {
  const reading = active[kind];
  const title = kind === 'reading' ? '塔罗师解读' : `${escape(context.friendName)} 的视角`;
  const pending = unsaved?.sessionId === active.id && unsaved.kind === kind ? unsaved : null;
  const text = pending?.text || reading.text;
  const messages = {
    idle: kind === 'reading' ? '结合你的问题、牌位和正逆位，解读这组牌。' : '带着同一组牌，请 TA 说说自己的感受。',
    running: activeRequest?.kind === kind ? '正在解读，请稍候…' : '另一页面或上次请求仍在等待，结果将自动同步。',
    succeeded: '解读已保存', failed: '上次解读未完成，牌组已保留。',
    unknown: '上次请求中断，可能已计费；手动重试会再次调用 API。'
  };
  return `<section class="panel"><h3>${title}</h3>
    <p class="reading-status ${reading.status}">${pending ? '解读已收到，但保存失败。请复制留存或重试保存。' : messages[reading.status]}</p>
    ${text ? `<div class="reading">${mdToHtml(text)}</div>` : ''}
    <div class="actions">${pending ? '<button class="primary" data-action="save-result">重试保存</button>'
      : `<button class="${reading.status === 'succeeded' ? 'secondary' : 'primary'}" data-action="generate" data-kind="${kind}" ${busy || hasRunning() || !apiConfig().ready ? 'disabled' : ''}>
      ${reading.status === 'succeeded' ? '重新解读' : reading.status === 'idle' ? (kind === 'reading' ? '请塔罗师解读' : '听听 TA 怎么说') : '手动重试'}</button>`}
      ${activeRequest?.kind === kind ? '<button class="secondary" data-action="cancel">停止等待</button>' : ''}
      ${text ? `<button class="secondary" data-action="copy" data-kind="${kind}">复制解读</button>` : ''}</div></section>`;
}

function readingHtml(revealAnimation) {
  if (!active) { view = 'home'; return homeHtml(); }
  const spread = SPREADS.find(s => s.id === active.spreadId);
  const count = active.selected.length;
  return `<div class="section-head"><h2>${escape(spread.zh)}</h2><span class="badge">${active.revealed ? '牌组已保存' : count + ' / ' + spread.count + ' 张'}</span></div>
    <section class="panel"><p class="question">${escape(active.question)}</p><p class="record-meta">${escape(active.names.user)} × ${escape(active.names.friend)} · ${date(active.createdAt)}</p></section>
    <div class="card-grid ${spread.count === 1 ? 'single' : ''} ${revealAnimation ? 'reveal' : ''}">${spread.slots.map((_, i) => slotHtml(i, active.revealed)).join('')}</div>
    ${!active.revealed && count < spread.count ? `<p class="progress-line">凭直觉，选择「${escape(spread.slots[count].label)}」的位置</p>
      <p class="hint" style="text-align:center">左右滑动牌池，抽齐后一起翻开。</p>
      <div class="deck" aria-label="78 张牌的选牌区">${active.deck.map((_, i) => `<button class="deck-card ${active.selected.includes(i) ? 'selected' : ''}" data-action="pick" data-index="${i}"
      aria-label="选择第 ${i + 1} 张牌" ${busy || active.selected.includes(i) ? 'disabled' : ''}></button>`).join('')}</div>
      <button class="secondary wide" data-action="auto-draw" ${busy ? 'disabled' : ''}>${busy ? '正在为你抽牌…' : '为我抽齐'}</button>` : ''}
    ${!active.revealed && count === spread.count ? `<p class="hint" style="text-align:center">牌已到齐。这次相遇，只有这一组答案。</p><div class="actions"><button class="primary wide" data-action="reveal" ${busy ? 'disabled' : ''}>一起翻开</button></div>` : ''}
    ${active.revealed ? `<p class="hint" style="text-align:center">轻点任意牌面，查看原项目的正逆位牌义。</p>
      <p class="hint">${apiConfig().ready ? `AI 解读使用主 API：${escape(apiConfig().model)}。点击后发送本次问题与牌组；TA 视角还会带入本会话角色和最近对话。` : '尚未配置 API。你仍可查看基础牌义；如需 AI 解读，请到 Lego 的 API 设置中完成配置。'}</p>
      ${readingPanel('reading')}${readingPanel('companion')}` : ''}
    <div class="actions"><button class="secondary" data-action="new" ${busy || hasRunning() || unsaved ? 'disabled' : ''}>再问一个问题</button><button class="secondary" data-action="show-history">塔罗手记</button></div>
    <button class="link-button wide danger" data-action="delete" ${busy || hasRunning() ? 'disabled' : ''}>删除这条记录</button>${footer()}`;
}
function historyHtml() {
  return `<div class="section-head"><h2>塔罗手记</h2><span class="badge">${historyRecords.length} 次相遇</span></div>
    <p class="hint" style="margin-bottom:18px">这里只保留当前好友与人设的记录。再次打开会恢复原牌组。</p>
    ${historyRecords.length ? historyRecords.slice(0, historyLimit).map(record => `<button class="history-item" data-action="open-record" data-id="${record.id}">
      <strong>${escape(record.question)}</strong><span>${date(record.createdAt)} · ${escape(SPREADS.find(s => s.id === record.spreadId)?.zh)} · ${record.revealed ? '已翻开' : '已选 ' + record.selected.length + ' 张'}${record.reading.text ? ' · 有解读' : ''}</span></button>`).join('') : '<div class="empty"><span class="star">✦</span>第一段星光，等你写下。</div>'}
    ${historyRecords.length > historyLimit ? '<button class="secondary wide" data-action="more-history">查看更多</button>' : ''}
    <div class="actions"><button class="primary" data-action="new" ${hasRunning() || busy || unsaved ? 'disabled' : ''}>开始新的提问</button></div>`;
}
function settingsHtml() {
  const config = apiConfig();
  return `<h2>你们的塔罗小屋</h2><section class="panel"><h3>解读接口</h3><p class="hint">${config.ready ? '已连接 Lego 主 API · ' + escape(config.model) : '尚未配置。请返回 Lego 的 API 设置，填写接口并选择模型。'}</p><p class="hint">每次点击解读才发起请求；失败或刷新不会自动重试。</p></section>
    <section class="panel"><h3>记录与缓存</h3><p class="hint">记录按好友和人设独立保存。以下备份只包含当前空间，不包含 API 密钥或聊天记录。</p>
      <div class="settings-list" style="margin-top:15px"><button data-action="export">导出当前空间的塔罗备份</button><button data-action="import" ${busy || hasRunning() || unsaved ? 'disabled' : ''}>导入塔罗备份</button>
      <button data-action="clear-cache">清理塔罗缓存 · ${cacheInfo.cards} 张牌面</button></div><p class="hint">清理只移除塔罗页面与牌面缓存，保留所有塔罗记录。下次联网进入可重新生成缓存。</p>
      <p class="hint">${cacheInfo.offline ? '塔罗页面资源已缓存。' : '页面资源缓存尚未就绪。'} 离线能力限于已加载的塔罗模块。</p></section>
    <section class="panel"><h3>开源来源</h3><p class="hint">本模块改编自 Cove Tarot Companion 与 Tarot Ritual，保留原项目的 78 张牌、五种牌阵、程序化粒子牌面与原解读规则。</p>
      <p class="hint">代码采用 ISC 许可。这里只使用公开的程序绘制牌面。</p>
      <p class="hint"><a href="THIRD_PARTY_NOTICES.md" target="_blank" rel="noopener">许可与修改说明</a> · <a href="https://github.com/moonlin1213/cove-tarot-companion" target="_blank" rel="noopener noreferrer">原项目</a></p></section>${footer()}`;
}

function render({ reveal = false } = {}) {
  if (closed) return;
  const epoch = ++viewEpoch;
  const oldScroll = content.scrollTop;
  const deckScroll = $('.deck')?.scrollLeft || 0;
  content.innerHTML = view === 'home' ? homeHtml() : view === 'history' ? historyHtml() : view === 'settings' ? settingsHtml() : readingHtml(reveal);
  content.scrollTop = oldScroll;
  if ($('.deck')) $('.deck').scrollLeft = deckScroll;
  $('#history').disabled = busy; $('#settings').disabled = busy;
  $('#back').setAttribute('aria-label', view === 'settings' || view === 'history' ? '返回塔罗' : '返回情侣空间');
  if (view === 'reading' && active?.revealed) {
    placedCards(active).forEach((draw, index) => {
      cardImage(draw.card).then(url => {
        if (!url || epoch !== viewEpoch || closed) return;
        const node = content.querySelector(`[data-action="detail"][data-position="${index}"]`);
        if (!node) return;
        const img = new Image(); img.alt = ''; img.src = url; node.prepend(img);
      }).catch(() => { if (epoch === viewEpoch) notify('部分牌面暂时无法绘制，牌名与基础牌义仍可正常使用。'); });
    });
  }
}
async function changeView(next) {
  if (next === 'history') historyRecords = await storage.listSessions(context.scope);
  if (next === 'settings') cacheInfo = await cacheInformation();
  if (next === 'history' || next === 'settings') {
    if (view !== 'history' && view !== 'settings') previousView = view;
  }
  view = next; content.scrollTop = 0; render(); content.focus({ preventScroll: true });
}
async function confirmDialog(title, body) {
  if ($('#dialog').open) return false;
  $('#dialog-title').textContent = title; $('#dialog-body').textContent = body;
  $('#dialog').returnValue = 'cancel'; $('#dialog').showModal();
  return new Promise(resolve => $('#dialog').addEventListener('close', () => resolve($('#dialog').returnValue === 'ok'), { once: true }));
}
async function saveDraft() {
  clearTimeout(draftTimer);
  if (!context || !preferences) return;
  await storage.setPreferences(context.scope, { question: preferences.question, spreadChoice: preferences.spreadChoice, reversals: preferences.reversals });
}
function draftChanged() {
  preferences.question = $('#question').value;
  preferences.spreadChoice = $('#spread-choice').value;
  preferences.reversals = $('#reversals').checked;
  $('#question-count').textContent = preferences.question.length + '/1000';
  const spread = chosenSpread(); $('#spread-info').textContent = spread.zh + ' · ' + spread.bestFor;
  clearTimeout(draftTimer); draftTimer = setTimeout(() => { saveDraft().catch(error => notify(error.message)); }, 250);
}
async function synchronize() {
  if (closed || polling || !active || busy) return;
  polling = true;
  const sessionId = active.id;
  try {
    let fresh = await storage.getSession(sessionId, context.scope);
    if (closed || active?.id !== sessionId) return;
    if (!fresh) { active = null; unsaved = null; notify('这条记录已在另一页面删除。'); if (view === 'reading') await changeView('home'); return; }
    for (const kind of ['reading', 'companion']) {
      if (fresh[kind].status === 'running' && Date.now() > fresh[kind].leaseUntil) {
        fresh = await storage.finishRequest(fresh.id, context.scope, kind, fresh[kind].requestId, { status: 'unknown' }) || fresh;
      }
    }
    if (!closed && active?.id === sessionId && fresh.revision !== active.revision) { active = fresh; if (view === 'reading') render(); }
  } finally { polling = false; }
}
async function mutate(change) {
  const sessionId = active.id;
  const saved = await storage.updateSession(sessionId, context.scope, active.revision, change);
  if (active?.id === sessionId) active = saved;
  return saved;
}
async function start() {
  if (busy || hasRunning()) return;
  draftChanged();
  const record = createSession(context, preferences.question, chosenSpread().id, preferences.reversals !== false);
  busy = true; render();
  try {
    await saveDraft();
    active = await storage.addSession(record);
    releaseImages(); unsaved = null;
    view = 'reading'; content.scrollTop = 0; notify('洗牌完成，牌组已保存。请凭直觉选牌。');
  } finally { busy = false; render(); }
}
async function draw(index, automatically) {
  if (busy || !active || active.revealed) return;
  busy = true;
  const sessionId = active.id;
  try {
    if (!automatically) {
      const deckScroll = $('.deck')?.scrollLeft || 0;
      await mutate(value => selectCard(value, index));
      render(); if ($('.deck')) $('.deck').scrollLeft = deckScroll;
    } else {
      while (!closed && active?.id === sessionId && active.selected.length < chosenCount()) {
        const candidates = active.deck.map((_, i) => i).filter(i => !active.selected.includes(i));
        const selected = candidates[randomInt(candidates.length)];
        await mutate(value => selectCard(value, selected)); render();
        await new Promise(resolve => setTimeout(resolve, matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 190));
      }
    }
  } finally { busy = false; render(); }
}
const chosenCount = () => SPREADS.find(s => s.id === active.spreadId).count;

async function stopRequest() {
  const request = activeRequest;
  if (!request) return;
  request.cancelled = true; request.controller.abort();
  const fresh = await storage.finishRequest(request.sessionId, context.scope, request.kind, request.id, { status: 'unknown' });
  if (fresh && active?.id === fresh.id) active = fresh;
  if (activeRequest === request) activeRequest = null;
  notify('已停止等待，牌组已保留。本次请求可能已计费，请勿连续重试。');
  render();
}
async function generate(kind) {
  if (busy || hasRunning() || !active?.revealed || !['reading', 'companion'].includes(kind) || unsaved) return;
  if (active[kind].text && !(await confirmDialog('重新解读这组牌？', '将再次调用主 API，可能产生费用。成功后替换本条解读；失败仍保留旧正文。'))) return;
  await synchronize();
  if (hasRunning()) { render(); return; }
  const currentContext = host.context(window, kind === 'companion');
  if (currentContext.scope !== context.scope) throw new Error('空间已变更，请重新进入');
  const config = host.configuration(window);
  if (!config.ready) throw new Error('请先配置 Lego 主 API');
  const prompt = kind === 'reading' ? readingPrompt(active) : companionPrompt(active, currentContext);
  if (prompt.length > 65000) throw new Error('角色与问题内容过长，请缩短后重试');
  const request = { id: uid(), sessionId: active.id, kind, controller: new AbortController(), cancelled: false };
  busy = true;
  try {
    await mutate(value => {
      if (['reading', 'companion'].some(k => value[k].status === 'running')) throw new Error('这组牌已有解读进行中');
      return { ...value, [kind]: { ...value[kind], status: 'running', requestId: request.id, startedAt: Date.now(), leaseUntil: Date.now() + REQUEST_LEASE_MS, model: config.model } };
    });
  } finally { busy = false; }
  activeRequest = request; notify(''); render();
  try {
    const result = await host.request(window, context.scope, prompt, request.controller.signal);
    if (closed || request.cancelled) return;
    try {
      const fresh = await storage.finishRequest(request.sessionId, context.scope, kind, request.id, { status: 'succeeded', text: result.text, model: result.model });
      if (fresh && active?.id === fresh.id) active = fresh;
      else notify('记录已经更新或删除，迟到的解读未写入。');
    } catch (_) {
      unsaved = { ...result, sessionId: request.sessionId, kind, requestId: request.id };
      notify('解读已收到，但本地保存失败。请复制留存，或点击重试保存。');
    }
  } catch (error) {
    if (!request.cancelled && !closed) {
      const fresh = await storage.finishRequest(request.sessionId, context.scope, kind, request.id, { status: 'unknown' });
      if (fresh && active?.id === fresh.id) active = fresh;
      notify(error.message || '解读未完成，牌组已保留。');
    }
  } finally { if (activeRequest === request) activeRequest = null; render(); }
}

async function showDetail(position) {
  if (!active?.revealed || $('#dialog').open) return;
  const draw = placedCards(active)[position];
  if (!draw) return;
  $('#dialog-title').textContent = draw.card.zh + (draw.reversed ? ' · 逆位' : ' · 正位');
  $('#dialog-body').textContent = `牌位：${draw.slot.label} · ${draw.slot.hint}\n\n${draw.reversed ? draw.card.k_rev : draw.card.k_up}\n\n${draw.reversed ? draw.card.rev : draw.card.up}\n\n另一方向的牌义：\n${draw.reversed ? draw.card.up : draw.card.rev}\n\n牌面意象：${draw.card.sym || '传统塔罗意象'}`;
  $('#dialog').showModal();
  const url = await cardImage(draw.card);
  if ($('#dialog').open && url) { const img = new Image(); img.className = 'detail-art' + (draw.reversed ? ' reversed' : ''); img.alt = draw.card.zh; img.src = url; $('#dialog-body').prepend(img); }
}
function download(backup) {
  const blob = new Blob([JSON.stringify(backup, null, 2)], { type: 'application/json;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a'); a.href = url; a.download = '迷恋塔罗-' + new Date().toISOString().slice(0, 10) + '.json';
  document.body.append(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function copyReading(kind) {
  const text = unsaved?.sessionId === active.id && unsaved.kind === kind ? unsaved.text : active[kind].text;
  const value = active.question + '\n\n' + placedCards(active).map(p => p.slot.label + '：' + p.card.zh + (p.reversed ? '（逆位）' : '（正位）')).join('\n') + '\n\n' + text;
  try { await navigator.clipboard.writeText(value); notify('已复制问题、牌组与解读。'); }
  catch (_) {
    $('#dialog-title').textContent = '长按文字复制'; $('#dialog-body').textContent = value; $('#dialog').showModal();
  }
}
async function onAction(action, button) {
  if (!context) return;
  switch (action) {
    case 'start': return start();
    case 'pick': return draw(Number(button.dataset.index), false);
    case 'auto-draw': return draw(null, true);
    case 'reveal':
      if (busy) return; busy = true;
      try { await mutate(revealCards); notify('这组牌已揭示并保存。轻点牌面即可查看基础牌义。'); }
      finally { busy = false; render({ reveal: true }); }
      return;
    case 'detail': return showDetail(Number(button.dataset.position));
    case 'generate': return generate(button.dataset.kind);
    case 'cancel': return stopRequest();
    case 'copy': return copyReading(button.dataset.kind);
    case 'save-result': {
      if (!unsaved) return;
      const result = unsaved;
      const fresh = await storage.finishRequest(result.sessionId, context.scope, result.kind, result.requestId, { status: 'succeeded', text: result.text, model: result.model }, true);
      if (!fresh) throw new Error('原记录已改变，请先复制解读留存');
      active = fresh; unsaved = null; notify('解读已保存，没有重新调用 API。'); render(); return;
    }
    case 'new':
      if (busy || hasRunning() || unsaved) throw new Error('请先结束当前解读并保存结果');
      preferences.question = ''; await storage.setPreferences(context.scope, { activeId: '', question: '' });
      return changeView('home');
    case 'resume': return changeView('reading');
    case 'show-history': return changeView('history');
    case 'more-history': historyLimit += 30; render(); return;
    case 'open-record':
      if (busy || activeRequest || unsaved) throw new Error('请先结束当前操作并保存结果');
      active = await storage.getSession(button.dataset.id, context.scope);
      if (!active) throw new Error('这条记录已被删除');
      releaseImages(); await storage.setPreferences(context.scope, { activeId: active.id });
      return changeView('reading');
    case 'delete':
      if (busy || hasRunning()) return;
      if (!(await confirmDialog('删除这条塔罗记录？', '会删除本次问题、牌组和解读。其他记录不受影响；删除后无法撤销。'))) return;
      await storage.deleteSession(active.id, context.scope); active = null; unsaved = null; releaseImages(); notify('记录已删除。'); return changeView('history');
    case 'export': download(await storage.exportBackup(context.scope)); notify('已导出当前空间的塔罗记录。'); return;
    case 'import': $('#import-file').click(); return;
    case 'clear-cache':
      if (!(await confirmDialog('清理塔罗缓存？', '只清理本模块的页面和牌面缓存，所有问题、牌组与解读都会保留。'))) return;
      await clearTarotCache(); cacheInfo = await cacheInformation(); notify('塔罗缓存已清理，记录完整保留。'); render(); return;
  }
}

content.addEventListener('click', event => {
  const button = event.target.closest('button[data-action]');
  if (!button || button.disabled) return;
  onAction(button.dataset.action, button).catch(async error => {
    notify(error.message || '操作未完成，请重试。');
    try { await synchronize(); } catch (_) {}
    if (view !== 'home') render();
  });
});
content.addEventListener('input', event => { if (event.target.id === 'question') draftChanged(); });
content.addEventListener('change', event => { if (['spread-choice', 'reversals'].includes(event.target.id)) draftChanged(); });
$('#history').onclick = () => { if (context) changeView('history').catch(e => notify(e.message)); };
$('#settings').onclick = () => { if (context) changeView('settings').catch(e => notify(e.message)); };
$('#back').onclick = async () => {
  if (view === 'settings' || view === 'history') { await changeView(previousView); return; }
  if (unsaved && !(await confirmDialog('解读尚未保存', '退出前建议先复制解读，或重试保存。仍要退出吗？'))) return;
  if (host) await host.close(false); else history.back();
};
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#dialog').open) { event.preventDefault(); $('#back').click(); }
});
$('#import-file').onchange = async event => {
  const file = event.target.files?.[0]; event.target.value = '';
  if (!file || !context) return;
  try {
    if (hasRunning() || activeRequest || unsaved) throw new Error('请先结束当前解读并保存结果');
    if (file.size > 64 * 1024 * 1024) throw new Error('备份超过 64 MB，请按空间分别导出');
    const backup = JSON.parse(await file.text());
    const checked = parseBackup(backup);
    if (new Set(checked.map(r => r.scope)).size > 1) throw new Error('此备份包含多个空间，请通过微信整体备份导入以保留归属');
    const source = checked[0]?.names;
    if (!(await confirmDialog('导入塔罗备份', `共 ${checked.length} 条记录${source ? '，来自 ' + source.user + ' × ' + source.friend : ''}。\n将合并到当前空间 ${context.userName} × ${context.friendName}，跳过已有记录，不覆盖当前内容。`))) return;
    const result = await storage.importBackup(backup, context.scope);
    notify(`已导入 ${result.added} 条，跳过已有 ${result.skipped} 条。`);
    await changeView('history');
  } catch (error) { notify(error instanceof SyntaxError ? '备份不是有效 JSON 文件' : error.message); }
};

window.LegoTarotPage = {
  async prepareClose() {
    closed = true; clearInterval(pollTimer); clearTimeout(draftTimer);
    try { await stopRequest(); } catch (_) {}
    try { await saveDraft(); } catch (_) {}
    releaseImages();
  }
};
window.addEventListener('pagehide', () => { void window.LegoTarotPage.prepareClose(); });
const pollTimer = setInterval(() => { synchronize().catch(error => notify(error.message)); }, 1200);

try {
  if (!host) throw new Error('请从 Lego 小手机的「微信 → 发现 → 情侣空间 → 迷恋塔罗」进入。');
  context = host.context(window);
  $('#couple-label').textContent = context.userName + ' × ' + context.friendName;
  await storage.openDatabase();
  preferences = { question: '', spreadChoice: 'relationship', reversals: true, ...await storage.getPreferences(context.scope) };
  if (preferences.activeId) active = await storage.getSession(preferences.activeId, context.scope);
  if (active) { view = 'reading'; await synchronize(); }
  render();
  void registerOfflineCache();
} catch (error) {
  content.innerHTML = `<div class="empty"><span class="star">✦</span><p>${escape(error.message)}</p><p class="hint">未开启任何 AI 请求。请返回后重试。</p></div>`;
}
