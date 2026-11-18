import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DECK, SPREADS, createSession, selectCard, revealCards, normalizeSession, randomInt,
  makeBackup, parseBackup, placedCards, companionResult, autoSpread } from '../core.js';
import { readingPrompt, companionPrompt } from '../prompts.js';
import { mdToHtml } from '../upstream/tarot/reading.js';
const context = { scope: 'fixture_scope_a', userName: '小夏', friendName: '林舟' };
const fresh = (spread = 'three') => createSession(context, '我们怎样更好地靠近彼此？', spread, true);
const complete = (spread = 'three') => {
  let value = fresh(spread);
  for (let i = 0; i < SPREADS.find(s => s.id === spread).count; i++) value = selectCard(value, i);
  return revealCards(value);
};
test('pinned catalog: 78 unique cards and five original spreads', () => {
  assert.equal(DECK.length, 78); assert.equal(new Set(DECK.map(c => c.id)).size, 78);
  assert.deepEqual(SPREADS.map(s => s.count), [1, 3, 5, 7, 10]);
  for (const card of DECK) assert.ok(card.up && card.rev && card.k_up && card.k_rev);
});
test('secure rejection sampling rejects biased tail values', () => {
  const values = [0xffffffff, 17]; let calls = 0;
  assert.equal(randomInt(10, out => { out[0] = values[calls++]; }), 7);
  assert.equal(calls, 2); assert.throws(() => randomInt(0));
});
test('shuffle and serialization preserve all cards and boolean orientations', () => {
  for (let n = 0; n < 30; n++) {
    const session = fresh(); assert.equal(new Set(session.deck.map(d => d.cardId)).size, 78);
    assert.ok(session.deck.every(d => typeof d.reversed === 'boolean'));
    assert.deepEqual(normalizeSession(JSON.parse(JSON.stringify(session))), session);
  }
});
test('disabling reversals persists only upright cards', () => {
  assert.ok(createSession(context, '今日指引', 'single', false).deck.every(d => !d.reversed));
});
test('duplicate and out-of-range selections fail without mutating original', () => {
  const original = fresh(); const next = selectCard(original, 7);
  assert.deepEqual(original.selected, []); assert.throws(() => selectCard(next, 7));
  assert.throws(() => selectCard(next, -1)); assert.throws(() => selectCard(next, 78));
});
for (const spread of SPREADS) test(spread.id + ': whole-group reveal and backup preserve canonical facts', () => {
  let session = fresh(spread.id); assert.throws(() => revealCards(session));
  for (let i = 0; i < spread.count; i++) session = selectCard(session, 77 - i);
  session = revealCards(session); assert.throws(() => selectCard(session, 15));
  const restored = parseBackup(makeBackup([session]))[0];
  assert.deepEqual(placedCards(restored), placedCards(session));
  assert.equal(companionResult(restored).cards.length, spread.count);
});
test('invalid question, unknown cards, duplicated positions and early reveal fail closed', () => {
  assert.throws(() => createSession(context, '', 'single', true));
  assert.throws(() => createSession(context, 'x'.repeat(1001), 'single', true));
  for (const tamper of [s => { s.deck[1] = s.deck[0]; }, s => { s.deck[0].cardId = 'made-up'; },
    s => { s.selected = [1, 1]; }, s => { s.revealed = true; }, s => { s.reading = { status: 'succeeded', text: '' }; }]) {
    const value = fresh(); tamper(value); assert.throws(() => normalizeSession(value));
  }
});
test('backup removes unknown credential fields and restores interrupted work as unknown', () => {
  const value = complete(); value.apiKey = 'never-export-this';
  value.reading = { status: 'running', requestId: 'fixture_request', leaseUntil: Date.now() + 1000, text: '', apiKey: 'secret' };
  const backup = makeBackup([value]); assert.ok(!JSON.stringify(backup).includes('apiKey'));
  assert.equal(parseBackup(backup)[0].reading.status, 'unknown');
  assert.throws(() => parseBackup({ ...backup, version: 999 }));
  assert.throws(() => parseBackup({ ...backup, records: [value, value] }));
});
test('unrevealed cards cannot enter companion output or prompts', () => {
  const session = fresh(); assert.throws(() => companionResult(session)); assert.throws(() => readingPrompt(session));
});
test('companion uses original synthesis and preserves missing synthesis', () => {
  const session = complete(); assert.equal(companionResult(session).synthesis.missing, true);
  session.reading = { status: 'succeeded', text: '### 逐位解读\n其他正文\n### 综合信息\n先表达具体需要。\n### 建议\n一起散步。' };
  const result = companionResult(session); assert.equal(result.synthesis.missing, false);
  assert.ok(result.synthesis.text.includes('先表达具体需要')); assert.ok(!result.synthesis.text.includes('其他正文'));
  const prompt = companionPrompt(session, context); assert.ok(prompt.includes('不得重新抽牌'));
  assert.ok(prompt.includes(result.cards[0].zh));
});
test('neutral prompts retain each card, slot and reflective boundaries', () => {
  const session = complete('celtic'); const prompt = readingPrompt(session);
  for (const draw of placedCards(session)) { assert.ok(prompt.includes(draw.card.zh)); assert.ok(prompt.includes(draw.slot.label)); }
  assert.ok(prompt.includes('不把牌面视为事实预测'));
  assert.equal(autoSpread('我们的感情如何相处').spread.id, 'relationship');
});
test('AI text cannot become executable HTML', () => {
  const html = mdToHtml('<img src=x onerror=alert(1)>\n### 标题\n**安全**\n<script>alert(1)</script>');
  assert.ok(!html.includes('<img')); assert.ok(!html.includes('<script'));
  assert.ok(html.includes('&lt;img')); assert.ok(html.includes('<strong>安全</strong>'));
});
test('service worker never intercepts host/API/private/foreign-origin paths', () => {
  const handlers = {};
  const worker = { registration: { scope: 'http://127.0.0.1:1234/modules/milian-tarot/' },
    location: { origin: 'http://127.0.0.1:1234' }, addEventListener: (type, fn) => { handlers[type] = fn; } };
  vm.runInNewContext(fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), { self: worker, URL, Request });
  for (const url of ['http://127.0.0.1:1234/', 'http://127.0.0.1:1234/api/chat/completions',
    'http://127.0.0.1:1234/modules/milian-tarot/records.json', 'https://other.invalid/modules/milian-tarot/app.js']) {
    let intercepted = false; handlers.fetch({ request: { url, method: 'GET' }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, url);
  }
});
