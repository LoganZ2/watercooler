import type { Config } from '../config';

/**
 * Read-only access to polymarket.com's public APIs: Gamma for events and markets, the CLOB for
 * live order books. Nothing here needs an account; tests pass a fake PolymarketClient instead.
 */

export interface PolymarketMarket {
  id: string;
  question: string;
  /** The option's name inside a multi-market event (e.g. "50+ bps decrease"). */
  groupItemTitle: string | null;
  outcomes: string[];
  /** Polymarket's displayed price of each outcome, 0..1. */
  outcomePrices: number[];
  /** CLOB token of each outcome, in the same order. */
  tokens: string[];
  /** Best bid/ask of the first outcome's token. */
  bestBid: number | null;
  bestAsk: number | null;
  closed: boolean;
  acceptingOrders: boolean;
  /** Settled: closed, with every outcome priced at exactly 0, 0.5 or 1. */
  resolved: boolean;
}

export interface PolymarketEvent {
  id: string;
  slug: string;
  title: string;
  description: string;
  endDate: number | null;
  volume24hr: number;
  tags: string[];
  markets: PolymarketMarket[];
}

export interface PolymarketBookLevel {
  price: number;
  size: number;
}

export interface PolymarketBook {
  bids: PolymarketBookLevel[];
  asks: PolymarketBookLevel[];
}

export interface PolymarketClient {
  /** Open events with the most 24h volume, busiest first. */
  topEvents(limit: number): Promise<PolymarketEvent[]>;
  /** Events by id, open or closed. */
  events(ids: string[]): Promise<PolymarketEvent[]>;
  /** The live order book of one outcome token. */
  book(token: string): Promise<PolymarketBook>;
}

type Json = Record<string, unknown>;

const num = (v: unknown): number | null => {
  const n = typeof v === 'string' ? Number(v) : typeof v === 'number' ? v : NaN;
  return Number.isFinite(n) ? n : null;
};

/** Gamma returns some arrays as JSON strings ("[\"Yes\", \"No\"]"). */
function list(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== 'string') return [];
  try {
    const parsed = JSON.parse(v) as unknown;
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseMarket(m: Json): PolymarketMarket | null {
  const outcomes = list(m.outcomes).map(String);
  const outcomePrices = list(m.outcomePrices).map((p) => num(p) ?? 0);
  const tokens = list(m.clobTokenIds).map(String);
  if (!m.id || outcomes.length !== 2 || tokens.length !== 2 || outcomePrices.length !== 2) return null;
  const closed = m.closed === true;
  const final = outcomePrices.every((p) => p === 0 || p === 0.5 || p === 1);
  return {
    id: String(m.id),
    question: String(m.question ?? ''),
    groupItemTitle: typeof m.groupItemTitle === 'string' && m.groupItemTitle.trim() ? m.groupItemTitle.trim() : null,
    outcomes,
    outcomePrices,
    tokens,
    bestBid: num(m.bestBid),
    bestAsk: num(m.bestAsk),
    closed,
    acceptingOrders: m.acceptingOrders === true && !closed,
    resolved: closed && final && Math.abs(outcomePrices[0]! + outcomePrices[1]! - 1) < 1e-9,
  };
}

export function parseEvent(e: Json): PolymarketEvent | null {
  if (!e.id) return null;
  const end = typeof e.endDate === 'string' ? Date.parse(e.endDate) : NaN;
  return {
    id: String(e.id),
    slug: String(e.slug ?? ''),
    title: String(e.title ?? ''),
    description: String(e.description ?? ''),
    endDate: Number.isFinite(end) ? end : null,
    volume24hr: num(e.volume24hr) ?? 0,
    tags: list(e.tags).flatMap((t) => (t && typeof t === 'object' && 'slug' in t ? [String((t as Json).slug)] : [])),
    markets: list(e.markets).flatMap((m) => (m && typeof m === 'object' ? (parseMarket(m as Json) ?? []) : [])),
  };
}

export function createPolymarketClient(
  config: Pick<Config, 'polymarketGammaUrl' | 'polymarketClobUrl'>,
  fetchImpl: typeof fetch = fetch,
): PolymarketClient {
  async function get(url: string): Promise<unknown> {
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(15_000), headers: { accept: 'application/json' } });
    if (!res.ok) throw new Error(`Polymarket ${res.status}: ${url.replace(/\?.*/, '')}`);
    return res.json();
  }
  const events = (data: unknown) =>
    (Array.isArray(data) ? data : []).flatMap((e) => (e && typeof e === 'object' ? (parseEvent(e as Json) ?? []) : []));
  return {
    async topEvents(limit) {
      const q = new URLSearchParams({
        active: 'true',
        closed: 'false',
        archived: 'false',
        order: 'volume24hr',
        ascending: 'false',
        limit: String(limit),
      });
      return events(await get(`${config.polymarketGammaUrl}/events?${q}`));
    },
    async events(ids) {
      const found: PolymarketEvent[] = [];
      for (let i = 0; i < ids.length; i += 50) {
        const q = new URLSearchParams(ids.slice(i, i + 50).map((id): [string, string] => ['id', id]));
        found.push(...events(await get(`${config.polymarketGammaUrl}/events?${q}`)));
      }
      return found;
    },
    async book(token) {
      const data = (await get(`${config.polymarketClobUrl}/book?token_id=${encodeURIComponent(token)}`)) as Json;
      const levels = (v: unknown) =>
        list(v).flatMap((l) => {
          const price = num((l as Json)?.price);
          const size = num((l as Json)?.size);
          return price !== null && size !== null && size > 0 ? [{ price, size }] : [];
        });
      return { bids: levels(data.bids), asks: levels(data.asks) };
    },
  };
}
