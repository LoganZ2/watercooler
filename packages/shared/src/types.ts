// API data-transfer objects shared by server and web.
import type { OrderType, Token } from './constants';

// Money amounts are expressed in currency units (2 decimal places); timestamps are unix ms.

export interface UserRef {
  id: number;
  username: string;
  displayName: string;
}

export interface PublicUser extends UserRef {
  createdAt: number;
  /** AI bot account: only plays in the AI zone and is left off the leaderboard. */
  isBot: boolean;
}

export interface Me extends PublicUser {
  balance: number;
  canClaimBonus: boolean;
  isAdmin: boolean;
}

export interface AppConfig {
  inviteRequired: boolean;
  startingBalance: number;
  dailyBonus: number;
  privateMode: boolean;
  /** Whether the Polymarket mirror (top markets copied from polymarket.com) is on. */
  mimic: boolean;
  /** Whether new markets may use the Polymarket (order book) mode. */
  polymarket: boolean;
}

/** `closed` is derived: betting time is over but the creator has not announced the result yet. */
export type MarketStatus = 'open' | 'closed' | 'resolved' | 'cancelled';

export interface Outcome {
  id: number;
  index: number;
  label: string;
  /** Total staked on this outcome. */
  pool: number;
  /** Share of the pot on this outcome, read as the crowd's probability. */
  probability: number;
  /** Probability change over the last 24h, or null when unknown. */
  change24h: number | null;
  /** Actual best resting prices for Polymarket outcomes; null when that side has no orders. */
  bestBid?: number | null;
  bestAsk?: number | null;
}

export interface MarketSummary {
  mode: 'pool' | 'polymarket';
  id: number;
  question: string;
  category: string;
  status: MarketStatus;
  isBinary: boolean;
  /** Pool pot, or currently locked complete-set collateral for a Polymarket market. */
  pot: number;
  closeAt: number;
  /** Earliest time the creator may publish the result and settle. */
  settleAt: number;
  createdAt: number;
  resolvedOutcomeId: number | null;
  bettorCount: number;
  commentCount: number;
  creator: UserRef;
  outcomes: Outcome[];
  /** Recent probability of the first outcome (open binary markets only, else empty). */
  spark: number[];
  /**
   * Mirrors of polymarket.com markets: prices come from Polymarket and people trade against the
   * site at those prices, so trades here never move them. Results follow Polymarket's.
   */
  mimic?: MimicInfo;
}

/** A filled Polymarket mirror order. */
export interface MimicTradeResult {
  side: 'buy' | 'sell';
  label: string;
  quantity: number;
  total: number;
  avgPrice: number;
  balance: number;
}

export interface MimicInfo {
  /** Place among Polymarket's busiest events right now, or null once it dropped out of the top K. */
  rank: number | null;
  /** Polymarket's 24h volume in USD. */
  volume24h: number;
  url: string;
}

export interface MarketDetail extends MarketSummary {
  /** Pool-only automatic refund deadline; Polymarket markets never time out. */
  resolveBy?: number;
  description: string;
  resolvedAt: number | null;
  resolutionNote: string | null;
}

/** A user's total stake on one outcome. */
export interface Stake {
  outcomeId: number;
  amount: number;
}

export interface MarketDetailResponse {
  market: MarketDetail;
  /** The current user's stakes in this market (empty when logged out). */
  stakes: Stake[];
}

export interface PricePoint {
  t: number;
  probs: number[];
}

export interface Bet {
  id: number;
  user: UserRef;
  marketId: number;
  marketQuestion: string;
  outcomeId: number;
  outcomeLabel: string;
  amount: number;
  createdAt: number;
}

export interface Holder {
  user: UserRef;
  outcomeId: number;
  amount: number;
}

export interface Comment {
  id: number;
  user: UserRef;
  body: string;
  createdAt: number;
}

export interface BetResult {
  bet: Bet;
  balance: number;
  market: MarketDetail;
  stakes: Stake[];
}

export type PortfolioState = 'active' | 'won' | 'lost' | 'refunded';

export interface PortfolioBet {
  market: Pick<MarketSummary, 'id' | 'question' | 'status' | 'closeAt' | 'isBinary' | 'resolvedOutcomeId'>;
  outcomeId: number;
  outcomeLabel: string;
  stake: number;
  /** Payout if it wins with the pools as they are now (active), or what was actually paid out. */
  payout: number;
  /** Settled result (payout - stake); null while the market is still undecided. */
  pnl: number | null;
  state: PortfolioState;
}

export type LedgerKind =
  | 'signup'
  | 'bonus'
  | 'bet'
  | 'payout'
  | 'refund'
  | 'split'
  | 'merge'
  | 'order_lock'
  | 'order_release'
  | 'sell'
  | 'grant'
  | 'buy';

export interface LedgerEntry {
  id: number;
  kind: LedgerKind;
  amount: number;
  balanceAfter: number;
  marketId: number | null;
  marketQuestion: string | null;
  note: string | null;
  createdAt: number;
}

export interface UserStats {
  balance: number;
  /** Net cash invested in unresolved markets, including order escrow; may be negative after sales/merges. */
  staked: number;
  /** Book value: funded + profit (also balance + staked); excludes all unresolved market P&L. */
  netWorth: number;
  /** Total currency received for free (signup and daily bonus). */
  funded: number;
  /** Net ledger cash flow from resolved/cancelled markets only, including all trades and payouts. */
  profit: number;
  betCount: number;
  marketsBet: number;
}

export interface Portfolio {
  stats: UserStats;
  bets: PortfolioBet[];
  exchangePositions: ExchangePortfolioPosition[];
  exchangeOrders: ExchangePortfolioOrder[];
}

export interface ExchangePosition {
  outcomeId: number;
  /** For multi-outcome markets, the option's Yes or No share; binary markets always say yes. */
  token: Token;
  quantity: number;
  reserved: number;
  /** Cost basis of the shares held (average cost), in currency units. */
  cost: number;
  /** cost / quantity, or null without shares. */
  avgPrice: number | null;
}
export interface ExchangePortfolioPosition extends ExchangePosition {
  marketId: number;
  question: string;
  /** The option's label, with Yes / No appended for multi-outcome markets. */
  outcomeLabel: string;
  status: MarketStatus;
  /** Current mark price of this share (1 or 0 once settled). */
  price: number;
  /** quantity × price: an estimate for display only, never counted in rankings. */
  value: number;
  /** value - cost, display only. */
  pnl: number;
}
export interface ExchangeOrder {
  postOnly: boolean;
  clientOrderId: string | null;
  id: number;
  outcomeId: number;
  token: Token;
  side: 'buy' | 'sell';
  type: OrderType;
  /** Limit price; for FOK/FAK orders the worst acceptable price. */
  price: number;
  quantity: number;
  remaining: number;
  /** FOK/FAK buys placed by amount: how much was offered. */
  amount: number | null;
  /** GTD orders: when the unfilled rest is cancelled. */
  expiresAt: number | null;
  status: 'open' | 'filled' | 'cancelled';
  createdAt: number;
}
export interface ExchangePortfolioOrder extends ExchangeOrder {
  marketId: number;
  question: string;
  outcomeLabel: string;
}
export interface BookLevel {
  price: number;
  quantity: number;
}
/**
 * One share's order book. Liquidity on the complementary share is folded in, the way Polymarket
 * shows it: a No bid at 0.40 is a Yes ask at 0.60, and fills against Yes buyers by minting.
 */
export interface ExchangeBook {
  outcomeId: number;
  token: Token;
  bids: BookLevel[];
  asks: BookLevel[];
  lastPrice: number | null;
}
export interface ExchangeTrade {
  id: number;
  outcomeId: number;
  token: Token;
  price: number;
  quantity: number;
  kind: 'transfer' | 'mint' | 'merge';
  createdAt: number;
}
export interface ExchangeState {
  collateral: number;
  books: ExchangeBook[];
  positions: ExchangePosition[];
  orders: ExchangeOrder[];
  trades: ExchangeTrade[];
}

/** One side of a trade, for a market's public activity feed. */
export interface ExchangeActivity {
  tradeId: number;
  user: UserRef;
  side: 'buy' | 'sell';
  outcomeId: number;
  token: Token;
  price: number;
  quantity: number;
  createdAt: number;
}

/** A Polymarket market's biggest holders of one share. */
export interface ExchangeHolder {
  user: UserRef;
  outcomeId: number;
  token: Token;
  quantity: number;
  avgPrice: number | null;
}

export interface UserProfile {
  user: PublicUser;
  stats: UserStats;
  /** Leaderboard position; null for bots, which are not ranked. */
  rank: number | null;
  bets: PortfolioBet[];
  recentBets: Bet[];
  createdMarkets: MarketSummary[];
}

export interface LeaderboardEntry {
  rank: number;
  user: UserRef;
  stats: UserStats;
}

/** Stats for markets made by people. */
export interface SiteStats {
  openMarkets: number;
  totalStaked: number;
  bettors: number;
  users: number;
}

/** Instance features an admin can switch on and off while the site runs. */
export const FEATURES = ['polymarket', 'mimic'] as const;
export type Feature = (typeof FEATURES)[number];

export interface FeatureState {
  key: Feature;
  enabled: boolean;
  /** Whether the feature is actually running right now. */
  active: boolean;
  /** Why it is not active although enabled (e.g. a failed Polymarket sync). */
  problem: string | null;
  /** Another feature that has to be on before this one can be switched on. */
  requires?: Feature;
  /** A line about what it is doing, e.g. the last Polymarket sync. */
  status?: string | null;
}

export interface AdminOverview {
  instance: string;
  /** Deployed release, e.g. 20261019084706-b5e65c3; null when not run from a deploy. */
  release: string | null;
  startedAt: number;
  restartAvailable: boolean;
  /** Saved configuration differs from what this process started with. */
  restartNeeded: boolean;
  features: FeatureState[];
  /** How many of Polymarket's busiest events the mirror copies. */
  mimicTopK: number;
  money: {
    users: number;
    /** Spendable balances of people (not bots). */
    balances: number;
    /** Money of people sitting in unsettled markets (stakes and order escrow, net of sales). */
    inMarkets: number;
    /** Everything handed out: signup, daily bonus and admin grants. */
    funded: number;
  };
}

export interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  balance: number;
  isAdmin: boolean;
  createdAt: number;
}

export interface AdminAuditEntry {
  id: number;
  admin: UserRef;
  action: string;
  detail: string;
  createdAt: number;
}

/** Site settings kept in the instance's .env. */
export interface AdminSiteConfig {
  /** Empty when registration needs no invite code. */
  inviteCode: string;
  privateMode: boolean;
  startingBalance: number;
  dailyBonus: number;
  timezone: string;
}

/** What /admin shows of the saved configuration. */
export interface AdminInstanceConfig {
  site: AdminSiteConfig;
  restartNeeded: boolean;
}
