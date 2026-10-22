import { randomBytes } from 'node:crypto';
import type { Category } from '@watercooler/shared';
import type { DB } from '../db';
import { HOUR, MINUTE } from '../lib/time';
import { audit } from '../services/admin';
import { getOutcomeRows, recordPriceSnapshot, type MarketRow, type OutcomeRow } from '../services/markets';
import { adjustBalance } from '../services/users';
import type { PolymarketClient, PolymarketEvent, PolymarketMarket } from './client';

/**
 * The Polymarket mirror: copies polymarket.com's busiest events into Polymarket-mode markets and
 * settles everyone's positions at Polymarket's results. Trading lives in services/mimic.ts.
 */

/** Most options a mirrored multi-market event keeps (the likeliest ones when it is copied). */
export const MAX_MIMIC_OPTIONS = 12;
export const MIMIC_SYNC_EVERY = 5 * MINUTE;
export const DEFAULT_TOP_K = 50;

export interface MimicOutcomeRow extends OutcomeRow {
  mimic_market_id: string | null;
  mimic_yes_token: string | null;
  mimic_no_token: string | null;
  mimic_bid: number | null;
  mimic_ask: number | null;
  mimic_open: 0 | 1;
  mimic_final: number | null;
}

export function getMimicTopK(db: DB): number {
  const row = db.prepare(`SELECT value FROM settings WHERE key = 'mimic.topK'`).get() as { value: string } | undefined;
  const k = Number(row?.value);
  return Number.isInteger(k) && k > 0 ? k : DEFAULT_TOP_K;
}

export function setMimicTopK(db: DB, adminId: number, topK: number, now: number): void {
  db.transaction(() => {
    db.prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES ('mimic.topK', ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    ).run(String(topK), now);
    audit(db, adminId, 'feature', `Polymarket 镜像盘改为镜像前 ${topK} 个热门事件`, now);
  })();
}

/** The account mirror markets are "created by": a bot that never logs in, trades or ranks. */
export function mirrorCreatorId(db: DB, now: number): number {
  const saved = db.prepare(`SELECT value FROM settings WHERE key = 'mimic.creator'`).get() as
    { value: string } | undefined;
  if (saved && db.prepare('SELECT 1 FROM users WHERE id = ?').get(Number(saved.value))) return Number(saved.value);
  let username = 'polymarket';
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username))
    username = `polymarket-${randomBytes(3).toString('hex')}`;
  const id = Number(
    db
      .prepare(
        `INSERT INTO users (username, display_name, password_hash, is_bot, created_at) VALUES (?, 'Polymarket', ?, 1, ?)`,
      )
      .run(username, `!${randomBytes(24).toString('hex')}`, now).lastInsertRowid,
  );
  db.prepare(
    `INSERT INTO settings (key, value, updated_at) VALUES ('mimic.creator', ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(String(id), now);
  return id;
}

const CATEGORY_TAGS: [Category, string[]][] = [
  [
    '体育',
    ['sports', 'soccer', 'nba', 'nfl', 'mlb', 'nhl', 'tennis', 'f1', 'ufc', 'golf', 'esports', 'cricket', 'boxing'],
  ],
  [
    '行情',
    ['crypto', 'bitcoin', 'ethereum', 'finance', 'economy', 'fed', 'stocks', 'business', 'commodities', 'earnings'],
  ],
  ['科技', ['tech', 'ai', 'science', 'space', 'openai']],
  ['娱乐', ['pop-culture', 'culture', 'movies', 'music', 'entertainment', 'awards', 'celebrities', 'tv']],
];

const categoryOf = (tags: string[]): Category =>
  CATEGORY_TAGS.find(([, slugs]) => slugs.some((s) => tags.includes(s)))?.[0] ?? '其他';

/** One option of a mirror and where its prices come from. */
interface OptionSpec {
  label: string;
  marketId: string;
  /** The token people buy as this option (binary: the outcome's own token; multi: the Yes token). */
  yesToken: string;
  noToken: string | null;
  /** Polymarket's price of yesToken, best bid/ask of it, and the final price once resolved (0..1). */
  price: number;
  bid: number | null;
  ask: number | null;
  open: boolean;
  final: number | null;
}

const flip = (p: number | null) => (p === null ? null : Math.round((1 - p) * 1e6) / 1e6);

/** A single-market event becomes a binary market of its two outcomes. */
function binaryOptions(m: PolymarketMarket): OptionSpec[] {
  return m.outcomes.map((label, i) => ({
    label,
    marketId: m.id,
    yesToken: m.tokens[i]!,
    noToken: null,
    price: m.outcomePrices[i]!,
    bid: i === 0 ? m.bestBid : flip(m.bestAsk),
    ask: i === 0 ? m.bestAsk : flip(m.bestBid),
    open: m.acceptingOrders,
    final: m.resolved ? m.outcomePrices[i]! : null,
  }));
}

/** In a multi-market event each market is an option with its own Yes / No. */
function multiOption(m: PolymarketMarket): OptionSpec {
  return {
    label: (m.groupItemTitle ?? m.question).slice(0, 40),
    marketId: m.id,
    yesToken: m.tokens[0]!,
    noToken: m.tokens[1]!,
    price: m.outcomePrices[0]!,
    bid: m.bestBid,
    ask: m.bestAsk,
    open: m.acceptingOrders,
    final: m.resolved ? m.outcomePrices[0]! : null,
  };
}

/**
 * Worth copying: still trading and actually quoted. Events often carry placeholder markets (a
 * "Team H" with an empty book that shows 50%), which would crowd out the real options.
 */
const live = (m: PolymarketMarket) => m.acceptingOrders && ((m.bestBid ?? 0) > 0 || (m.bestAsk ?? 1) < 1);

/** Options for a new mirror, or null when the event has nothing worth copying. */
function newOptions(event: PolymarketEvent): { multi: boolean; options: OptionSpec[] } | null {
  if (event.markets.length === 1) {
    const m = event.markets[0]!;
    return live(m) ? { multi: false, options: binaryOptions(m) } : null;
  }
  const options = event.markets
    .filter(live)
    .sort((a, b) => b.outcomePrices[0]! - a.outcomePrices[0]!)
    .slice(0, MAX_MIMIC_OPTIONS)
    .map(multiOption);
  const seen = new Map<string, number>();
  for (const o of options) {
    const n = (seen.get(o.label) ?? 0) + 1;
    seen.set(o.label, n);
    if (n > 1) o.label = `${o.label.slice(0, 36)} #${n}`;
  }
  return options.length >= 2 ? { multi: true, options } : null;
}

/** Still trading on Polymarket: open until its end date, then hour by hour while it keeps trading. */
const closeAtFor = (event: PolymarketEvent, now: number) =>
  event.endDate !== null && event.endDate > now ? event.endDate : now + HOUR;

const cents = (p: number | null) => (p === null ? null : Math.round(p * 100000) / 1000);

function createMirror(db: DB, event: PolymarketEvent, rank: number, now: number): number | null {
  const spec = newOptions(event);
  if (!spec) return null;
  const closeAt = closeAtFor(event, now);
  const marketId = Number(
    db
      .prepare(
        `INSERT INTO markets (question, description, category, creator_id, close_at, settle_at, created_at, mode, is_ai,
          neg_risk, mimic_id, mimic_slug, mimic_rank, mimic_volume)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'polymarket', 0, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.title.slice(0, 200) || event.slug,
        event.description.slice(0, 5000),
        categoryOf(event.tags),
        mirrorCreatorId(db, now),
        closeAt,
        closeAt,
        now,
        spec.multi ? 1 : 0,
        event.id,
        event.slug,
        rank,
        event.volume24hr,
      ).lastInsertRowid,
  );
  const insert = db.prepare(
    `INSERT INTO outcomes (market_id, idx, label, mark_price, mimic_market_id, mimic_yes_token, mimic_no_token,
      mimic_bid, mimic_ask, mimic_open)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  spec.options.forEach((o, i) =>
    insert.run(
      marketId,
      i,
      o.label,
      cents(o.price),
      o.marketId,
      o.yesToken,
      o.noToken,
      cents(o.bid),
      cents(o.ask),
      Number(o.open),
    ),
  );
  recordPriceSnapshot(
    db,
    marketId,
    spec.options.map((o) => o.price),
    now,
  );
  return marketId;
}

/**
 * Pay every position on a settled option at Polymarket's final price (1, 0, or 0.5 for a tie):
 * its Yes shares get the final price, its No shares (multi-outcome) the rest.
 */
function settleOption(db: DB, market: MarketRow, o: MimicOutcomeRow, final: number, now: number) {
  const positions = db
    .prepare('SELECT user_id, token, quantity FROM exchange_positions WHERE outcome_id = ? AND quantity > 0')
    .all(o.id) as { user_id: number; token: 0 | 1; quantity: number }[];
  for (const p of positions) {
    const price = p.token === 0 ? final : 1 - final;
    const amount = Math.round(p.quantity * price * 100);
    if (amount > 0)
      adjustBalance(db, p.user_id, amount, 'payout', now, {
        marketId: market.id,
        note: `Polymarket 结果：${o.label}${market.neg_risk ? (p.token === 0 ? ' · Yes' : ' · No') : ''} 每份兑回 ${price}`,
      });
  }
  db.prepare('UPDATE outcomes SET mimic_final = ?, mimic_open = 0, mark_price = ? WHERE id = ?').run(
    final * 100,
    final * 100,
    o.id,
  );
}

/** Bring a mirror up to date with its event: prices, trading state, and any settled options. */
function updateMirror(db: DB, market: MarketRow, event: PolymarketEvent, rank: number | null, now: number): number {
  let settled = 0;
  db.transaction(() => {
    const outcomes = getOutcomeRows(db, market.id) as MimicOutcomeRow[];
    const byId = new Map(event.markets.map((m) => [m.id, m]));
    for (const o of outcomes) {
      const m = o.mimic_market_id ? byId.get(o.mimic_market_id) : undefined;
      if (!m || o.mimic_final !== null) continue;
      const spec = market.neg_risk ? multiOption(m) : binaryOptions(m)[o.idx]!;
      if (spec.final !== null) {
        settleOption(db, market, o, spec.final, now);
        settled++;
      } else {
        db.prepare('UPDATE outcomes SET mark_price = ?, mimic_bid = ?, mimic_ask = ?, mimic_open = ? WHERE id = ?').run(
          cents(spec.price),
          cents(spec.bid),
          cents(spec.ask),
          Number(spec.open),
          o.id,
        );
      }
    }
    const fresh = getOutcomeRows(db, market.id) as MimicOutcomeRow[];
    const open = fresh.some((o) => o.mimic_open === 1 && o.mimic_final === null);
    db.prepare(`UPDATE markets SET mimic_rank = ?, mimic_volume = ?, close_at = ?, settle_at = ? WHERE id = ?`).run(
      rank,
      event.volume24hr,
      open ? closeAtFor(event, now) : Math.min(market.close_at, now),
      open ? closeAtFor(event, now) : Math.min(market.settle_at, now),
      market.id,
    );
    if (fresh.every((o) => o.mimic_final !== null)) {
      const winners = fresh.filter((o) => o.mimic_final === 100);
      db.prepare(
        `UPDATE markets SET status = 'resolved', resolved_outcome_id = ?, resolved_at = ?, resolution_note = ?
        WHERE id = ? AND status = 'open'`,
      ).run(winners.length === 1 ? winners[0]!.id : null, now, '按 Polymarket 的结果结算', market.id);
    }
    // A point per sync is plenty for the chart; skip it when nothing moved.
    const probs = fresh.map((o) => o.mark_price / 100);
    const last = db
      .prepare('SELECT probs FROM price_history WHERE market_id = ? ORDER BY id DESC LIMIT 1')
      .get(market.id) as { probs: string } | undefined;
    const before = last ? (JSON.parse(last.probs) as number[]) : [];
    if (probs.some((p, i) => Math.abs(p - (before[i] ?? -1)) >= 0.001)) recordPriceSnapshot(db, market.id, probs, now);
  })();
  return settled;
}

export interface MimicSyncResult {
  listed: number;
  refreshed: number;
  settled: number;
}

/**
 * One pass: with the mirror on, copy or update the top K events and refresh every other open
 * mirror; with it off, only refresh mirrors people hold, so their positions still settle.
 */
export async function syncMimic(
  db: DB,
  client: PolymarketClient,
  now: () => number,
  enabled: boolean,
): Promise<MimicSyncResult> {
  const result: MimicSyncResult = { listed: 0, refreshed: 0, settled: 0 };
  const seen = new Set<string>();
  if (enabled) {
    const top = await client.topEvents(getMimicTopK(db));
    const t = now();
    db.prepare('UPDATE markets SET mimic_rank = NULL WHERE mimic_id IS NOT NULL AND mimic_rank IS NOT NULL').run();
    for (const event of top) {
      const existing = db.prepare('SELECT * FROM markets WHERE mimic_id = ?').get(event.id) as MarketRow | undefined;
      // Already settled mirrors stay as they are; ranks count only the mirrors people can trade.
      if (existing) {
        seen.add(event.id);
        if (existing.status !== 'open') continue;
        result.settled += updateMirror(db, existing, event, result.listed + 1, t);
      } else {
        if (db.transaction(() => createMirror(db, event, result.listed + 1, t))() === null) continue;
        seen.add(event.id);
      }
      result.listed++;
    }
  }
  const stale = (
    db
      .prepare(
        `SELECT * FROM markets m WHERE m.mimic_id IS NOT NULL AND m.status = 'open'
        ${enabled ? '' : 'AND EXISTS (SELECT 1 FROM exchange_positions p WHERE p.market_id = m.id AND p.quantity > 0)'}`,
      )
      .all() as MarketRow[]
  ).filter((m) => !seen.has(m.mimic_id!));
  if (stale.length) {
    const events = new Map((await client.events(stale.map((m) => m.mimic_id!))).map((e) => [e.id, e]));
    const t = now();
    for (const market of stale) {
      const event = events.get(market.mimic_id!);
      if (!event) continue;
      result.settled += updateMirror(db, market, event, null, t);
      result.refreshed++;
    }
  }
  return result;
}

export interface MimicService {
  /** Run a pass now (one at a time); resolves when it is done. */
  syncNow(): Promise<void>;
  status(): { lastSync: number | null; error: string | null; listed: number };
  stop(): void;
}

/** Sync every few minutes, whatever the flag says (`enabled` decides how much a pass does). */
export function startMimic(deps: {
  db: DB;
  client: PolymarketClient;
  now: () => number;
  enabled: () => boolean;
  log: (m: string) => void;
}): MimicService {
  let lastSync: number | null = null;
  let error: string | null = null;
  let listed = 0;
  let running: Promise<void> | null = null;
  const pass = async () => {
    try {
      const r = await syncMimic(deps.db, deps.client, deps.now, deps.enabled());
      lastSync = deps.now();
      error = null;
      listed = r.listed;
      if (r.settled) deps.log(`[mimic] settled ${r.settled} options from Polymarket results`);
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
      deps.log(`[mimic] sync failed: ${error}`);
    }
  };
  const syncNow = () => (running ??= pass().finally(() => (running = null)));
  const timer = setInterval(() => void syncNow(), MIMIC_SYNC_EVERY);
  const first = setTimeout(() => void syncNow(), 3_000);
  return {
    syncNow,
    status: () => ({ lastSync, error, listed }),
    stop() {
      clearInterval(timer);
      clearTimeout(first);
    },
  };
}
