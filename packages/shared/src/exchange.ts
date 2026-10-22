import type { BookLevel } from './types';

export interface FillPlan {
  /** Whole shares that would fill. */
  quantity: number;
  /** Cash paid (buy) or received (sell), in currency units. */
  total: number;
  /** total / quantity, or null when nothing fills. */
  avgPrice: number | null;
  /** The last (worst) price touched, or null when nothing fills. */
  worstPrice: number | null;
  /**
   * Whether the request is fully met: every share asked for, or (spending an amount) the
   * budget left over cannot buy one more share within the limit.
   */
  complete: boolean;
}

const cents = (n: number) => Math.round(n * 100);

/**
 * Walk a merged book the way an immediate (FOK/FAK) order fills: best price first, each level at
 * its own price, whole shares only. Buys take asks at or below `limit`, sells take bids at or
 * above it. The server executes orders with this same walk, so browser previews match fills.
 */
export function planFill(
  levels: readonly BookLevel[],
  side: 'buy' | 'sell',
  want: { quantity: number } | { amount: number },
  limit = side === 'buy' ? 0.99 : 0.01,
): FillPlan {
  const max = cents(limit);
  let budget = 'amount' in want ? cents(want.amount) : Infinity;
  let left = 'quantity' in want ? want.quantity : Infinity;
  let quantity = 0;
  let total = 0;
  let worst: number | null = null;
  let next: number | null = null;
  for (const level of levels) {
    const p = cents(level.price);
    if (side === 'buy' ? p > max : p < max) break;
    if (left === 0) {
      next = p;
      break;
    }
    const affordable = side === 'buy' ? Math.floor(budget / p) : Infinity;
    const n = Math.min(level.quantity, left, affordable);
    if (n > 0) {
      quantity += n;
      total += n * p;
      worst = p;
      left -= n;
      if (side === 'buy') budget -= n * p;
    }
    if (n < level.quantity) {
      next = p;
      break;
    }
  }
  const complete = 'quantity' in want ? left === 0 : budget < (next ?? max);
  return {
    quantity,
    total: total / 100,
    avgPrice: quantity ? total / quantity / 100 : null,
    worstPrice: worst === null ? null : worst / 100,
    complete,
  };
}
