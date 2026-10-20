// API data-transfer objects shared by server and web.
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
  /** Whether the AI zone exists (bots are running or there are AI markets). */
  aiZone: boolean;
  /** Whether the WeCom (企业微信) bot is connected, so accounts can be bound to it. */
  wecom: boolean;
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
  /** Created by an AI bot; lives in the AI zone. */
  isAi: boolean;
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
  | 'grant';

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
  quantity: number;
  reserved: number;
}
export interface ExchangePortfolioPosition extends ExchangePosition {
  marketId: number;
  question: string;
  outcomeLabel: string;
  status: MarketStatus;
  price: number;
}
export interface ExchangeOrder {
  postOnly: boolean;
  clientOrderId: string | null;
  id: number;
  outcomeId: number;
  side: 'buy' | 'sell';
  price: number;
  quantity: number;
  remaining: number;
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
export interface ExchangeState {
  collateral: number;
  books: { outcomeId: number; bids: BookLevel[]; asks: BookLevel[]; lastPrice: number | null }[];
  positions: ExchangePosition[];
  orders: ExchangeOrder[];
  trades: {
    id: number;
    outcomeId: number;
    price: number;
    quantity: number;
    kind: 'transfer' | 'mint' | 'merge';
    createdAt: number;
  }[];
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

/** The AI zone at a glance. */
export interface AiZoneSummary {
  bots: number;
  openMarkets: number;
  /** Total staked in AI markets so far. */
  pot: number;
  /** What people (not bots) have won or lost on settled AI markets. */
  humanProfit: number;
  /** The bots with the most money. */
  richestBots: LeaderboardEntry[];
}

/** Stats for markets made by people (the AI zone has its own summary). */
export interface SiteStats {
  openMarkets: number;
  totalStaked: number;
  bettors: number;
  users: number;
}

/** A site account's link to a WeCom (企业微信) account. */
export interface WecomBinding {
  wecomUserId: string;
  createdAt: number;
}

/** What a binding link would do, shown before the user confirms. */
export interface WecomBindRequest {
  wecomUserId: string;
  expiresAt: number;
  /** The signed-in user's current binding, which confirming would replace. */
  current: WecomBinding | null;
}

/** Instance features an admin can switch on and off while the site runs. */
export const FEATURES = ['aiBots', 'wecom', 'polymarket'] as const;
export type Feature = (typeof FEATURES)[number];

export interface FeatureState {
  key: Feature;
  enabled: boolean;
  /** For features that need bot.json: whether it is there and valid. Null when nothing is needed. */
  configured: boolean | null;
  /** Whether the feature is actually running right now. */
  active: boolean;
  /** Why it is not active although enabled (missing config, failed to start, ...). */
  problem: string | null;
}

export interface AdminOverview {
  instance: string;
  /** Deployed release, e.g. 20261019084706-b5e65c3; null when not run from a deploy. */
  release: string | null;
  startedAt: number;
  restartAvailable: boolean;
  features: FeatureState[];
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
