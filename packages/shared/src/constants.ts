/** Display name of the play-money currency. */
export const CURRENCY_NAME = '水滴';

export const CATEGORIES = ['公司', '行情', '科技', '体育', '生活', '娱乐', '其他'] as const;
export type Category = (typeof CATEGORIES)[number];

export const MIN_OUTCOMES = 2;
export const MAX_OUTCOMES = 10;

/** Smallest and largest single bet, in currency units. */
export const MIN_BET = 1;
export const MAX_BET = 1_000_000;

/** Pool markets refund after this many days without a result, measured from settleAt. */
export const RESOLVE_GRACE_DAYS = 7;

/**
 * Polymarket order types. GTC rests until filled or cancelled; GTD also expires at a set time;
 * FOK fills completely at once or not at all; FAK fills what it can at once and cancels the rest.
 * Market orders are FOK/FAK orders whose limit is the worst acceptable price.
 */
export const ORDER_TYPES = ['GTC', 'GTD', 'FOK', 'FAK'] as const;
export type OrderType = (typeof ORDER_TYPES)[number];

/** Each option of a multi-outcome Polymarket market has its own Yes and No shares. */
export const TOKENS = ['yes', 'no'] as const;
export type Token = (typeof TOKENS)[number];

/** Polymarket markets with this many options or more are multi-outcome (one Yes/No book per option). */
export const MIN_MULTI_OUTCOMES = 3;

/** AI werewolf (狼人杀) table sizes the role sets are made for. */
export const WEREWOLF_MIN_PLAYERS = 6;
export const WEREWOLF_MAX_PLAYERS = 12;

/** Betting on an AI werewolf game stops once at most half the table (rounded up) is still alive. */
export const werewolfCutoff = (players: number) => Math.ceil(players / 2);
