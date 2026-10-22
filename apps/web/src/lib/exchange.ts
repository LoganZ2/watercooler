import type { ExchangeBook, ExchangeState, MarketSummary, Token } from '@watercooler/shared';

/**
 * A Polymarket share: an option and its Yes or No side. Binary markets trade their Yes and No
 * options directly (token always yes); multi-outcome markets give every option both sides.
 */
export interface ShareRef {
  outcomeId: number;
  token: Token;
}

export const isMultiExchange = (m: Pick<MarketSummary, 'mode' | 'outcomes'>) =>
  m.mode === 'polymarket' && m.outcomes.length > 2;

export const sameShare = (a: ShareRef, b: ShareRef) => a.outcomeId === b.outcomeId && a.token === b.token;

/** 「小王 · Yes」 in multi-outcome markets, just the option label otherwise. */
export function shareName(market: Pick<MarketSummary, 'mode' | 'outcomes'>, s: ShareRef): string {
  const o = market.outcomes.find((x) => x.id === s.outcomeId);
  if (!o) return '';
  return isMultiExchange(market) ? `${o.label} · ${s.token === 'no' ? 'No' : 'Yes'}` : o.label;
}

/** The two shares a ticket offers for an option: its Yes and No (binary: the Yes and No options). */
export function sharePair(market: Pick<MarketSummary, 'mode' | 'outcomes'>, outcomeId: number): [ShareRef, ShareRef] {
  if (isMultiExchange(market))
    return [
      { outcomeId, token: 'yes' },
      { outcomeId, token: 'no' },
    ];
  const [yes, no] = market.outcomes;
  return [
    { outcomeId: yes!.id, token: 'yes' },
    { outcomeId: no!.id, token: 'yes' },
  ];
}

export const bookOf = (data: ExchangeState | undefined, s: ShareRef): ExchangeBook | undefined =>
  data?.books.find((b) => sameShare(b, s));

/** Polymarket's displayed price: the midpoint, or the last trade when the spread is over 0.10. */
export function displayPrice(book: ExchangeBook | undefined): number | null {
  if (!book) return null;
  const bid = book.bids[0]?.price;
  const ask = book.asks[0]?.price;
  if (bid !== undefined && ask !== undefined && ask - bid <= 0.10000001) return (bid + ask) / 2;
  return book.lastPrice;
}

/** 0.345 → 34.5¢-style display in 水滴 per share: 0.35 */
export const formatPrice = (p: number | null | undefined) => (p == null ? '—' : p.toFixed(2));
