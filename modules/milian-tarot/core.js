import { DECK, byId } from './upstream/tarot/cards.js';
import { SPREADS, autoSpread } from './upstream/tarot/spreads.js';
import { canonicalDraw, buildResult } from './upstream/companion/result.js';

export { DECK, byId, SPREADS, autoSpread };
export const VERSION = 1;
export const MAX_RECORDS = 500;
export const MAX_TEXT = 32000;
export const REQUEST_LEASE_MS = 110000;
export const REQUEST_TIMEOUT_MS = 90000;
export const uid = () => 'mt_' + crypto.randomUUID().replaceAll('-', '');
const identifier = /^[A-Za-z0-9_-]{1,128}$/;
const fail = text => { throw new Error(text); };
const text = (value, max) => typeof value === 'string' && value.length <= max && !value.includes('\0')
  ? value : fail('备份中的文字长度或格式不正确');
const integer = (value, max = Number.MAX_SAFE_INTEGER) => Number.isSafeInteger(value) && value >= 0 && value <= max
  ? value : fail('记录中的数字格式不正确');

export function randomInt(max, source = array => crypto.getRandomValues(array)) {
  if (!Number.isInteger(max) || max < 1 || max > 0x100000000) throw new Error('Invalid random range');
  const limit = Math.floor(0x100000000 / max) * max;
  const buffer = new Uint32Array(1);
  do { source(buffer); } while (buffer[0] >= limit);
  return buffer[0] % max;
}

export function shuffleDeck(reversals = true, random = randomInt) {
  const cards = DECK.map(card => ({ cardId: card.id, reversed: reversals && random(2) === 1 }));
  for (let i = cards.length - 1; i > 0; i--) {
    const j = random(i + 1);
    [cards[i], cards[j]] = [cards[j], cards[i]];
  }
  return cards;
}

export function createSession(context, question, spreadId, reversals) {
  const trimmed = String(question || '').trim();
  if (!trimmed || trimmed.length > 1000) throw new Error('请写下问题，最多 1000 字');
  if (!SPREADS.some(s => s.id === spreadId)) throw new Error('请选择有效牌阵');
  const now = Date.now();
  return {
    id: uid(), scope: context.scope, revision: 1, createdAt: now, updatedAt: now,
    names: { user: String(context.userName || '我').slice(0, 100), friend: String(context.friendName || 'TA').slice(0, 100) },
    question: trimmed, spreadId, deck: shuffleDeck(reversals), selected: [], revealed: false,
    reading: { status: 'idle', text: '' }, companion: { status: 'idle', text: '' }
  };
}

export function placedCards(session) {
  const spread = SPREADS.find(s => s.id === session.spreadId);
  return session.selected.map((index, i) => ({ card: byId[session.deck[index].cardId],
    reversed: session.deck[index].reversed, slot: spread.slots[i] }));
}

export function selectCard(session, index) {
  const spread = SPREADS.find(s => s.id === session.spreadId);
  if (session.revealed || session.selected.length >= spread.count) throw new Error('这组牌已抽齐');
  if (!Number.isInteger(index) || index < 0 || index >= 78 || session.selected.includes(index)) throw new Error('这张牌已经选过，请选另一张');
  return { ...session, selected: [...session.selected, index] };
}

export function revealCards(session) {
  const placed = placedCards(session);
  canonicalDraw({ question: session.question, spread_id: session.spreadId,
    draws: placed.map((p, position) => ({ position, card_id: p.card.id, reversed: p.reversed })) }, { deck: DECK, spreads: SPREADS });
  return { ...session, revealed: true };
}

export function normalizeSession(raw) {
  if (!raw || typeof raw !== 'object' || !identifier.test(raw.id) || !identifier.test(raw.scope)) throw new Error('记录标识无效');
  const spread = SPREADS.find(s => s.id === raw.spreadId);
  if (!spread || !Array.isArray(raw.deck) || raw.deck.length !== 78) throw new Error('牌库或牌阵不完整');
  const deck = raw.deck.map(item => {
    if (!item || !byId[item.cardId] || typeof item.reversed !== 'boolean') throw new Error('存在未知牌名或无效正逆位');
    return { cardId: item.cardId, reversed: item.reversed };
  });
  if (new Set(deck.map(d => d.cardId)).size !== 78) throw new Error('牌库包含重复牌');
  if (!Array.isArray(raw.selected) || raw.selected.length > spread.count) throw new Error('抽牌数量错误');
  const selected = raw.selected.map(v => integer(v, 77));
  if (new Set(selected).size !== selected.length || typeof raw.revealed !== 'boolean') throw new Error('抽牌状态错误');
  if (raw.revealed && selected.length !== spread.count) throw new Error('尚未抽齐，不能揭示');
  function reading(value) {
    if (!value || !['idle', 'running', 'succeeded', 'failed', 'unknown'].includes(value.status)) throw new Error('解读状态错误');
    if (value.status !== 'idle' && !raw.revealed) throw new Error('未翻开的牌不能生成解读');
    const out = { status: value.status, text: text(value.text || '', MAX_TEXT) };
    if (value.status === 'succeeded' && !out.text.trim()) throw new Error('已完成的解读缺少正文');
    if (value.requestId != null) {
      if (!identifier.test(value.requestId)) throw new Error('请求标识错误');
      out.requestId = value.requestId;
    }
    if (value.status === 'running' && !out.requestId) throw new Error('进行中的请求缺少标识');
    for (const key of ['startedAt', 'leaseUntil', 'finishedAt']) if (value[key] != null) out[key] = integer(value[key]);
    if (value.status === 'running' && !out.leaseUntil) throw new Error('进行中的请求缺少期限');
    if (value.model != null) out.model = text(value.model, 256);
    return out;
  }
  const result = {
    id: raw.id, scope: raw.scope, revision: integer(raw.revision), createdAt: integer(raw.createdAt), updatedAt: integer(raw.updatedAt),
    names: { user: text(raw.names?.user || '我', 100), friend: text(raw.names?.friend || 'TA', 100) },
    question: text(raw.question, 1000), spreadId: spread.id, deck, selected, revealed: raw.revealed,
    reading: reading(raw.reading), companion: reading(raw.companion)
  };
  if (!result.question.trim() || !result.revision) throw new Error('记录正文或版本无效');
  return result;
}

export function makeBackup(records) {
  if (records.length > 5000) throw new Error('塔罗记录超过整体备份上限，请先按空间分别导出并整理记录');
  return { format: 'lego-milian-tarot', version: VERSION, exportedAt: new Date().toISOString(), records: records.map(normalizeSession) };
}

export function parseBackup(value, targetScope) {
  if (!value || value.format !== 'lego-milian-tarot' || value.version !== VERSION || !Array.isArray(value.records) || value.records.length > 5000) throw new Error('这不是受支持的迷恋塔罗备份');
  const seen = new Set();
  return value.records.map(raw => {
    const record = normalizeSession(raw);
    if (seen.has(record.id)) throw new Error('备份有重复记录，请检查文件');
    seen.add(record.id);
    if (targetScope) record.scope = targetScope;
    for (const kind of ['reading', 'companion']) if (record[kind].status === 'running') record[kind].status = 'unknown';
    return record;
  });
}

export function companionResult(session) {
  if (!session.revealed) throw new Error('请先翻开全部牌');
  return buildResult({ id: session.id, conversation_id: session.scope, revision: session.revision,
    question: session.question, spread_id: session.spreadId, phase: 'revealed',
    draws: placedCards(session).map((p, position) => ({ position, card_id: p.card.id, reversed: p.reversed, revealed: true })),
    reading: { state: session.reading.status === 'idle' ? 'missing' : session.reading.status, text: session.reading.text,
      id: session.reading.requestId || null, ...(session.reading.model ? { model: session.reading.model } : {}) }
  }, { deck: DECK, spreads: SPREADS, maxChars: 12000 });
}
