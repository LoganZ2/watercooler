import type {
  AppConfig,
  Bet,
  BetInput,
  BetResult,
  Comment,
  CreateMarketInput,
  Holder,
  LeaderboardEntry,
  LedgerEntry,
  MarketDetail,
  MarketDetailResponse,
  MarketSummary,
  Me,
  Portfolio,
  PricePoint,
  SiteStats,
  UserProfile,
  ExchangeState,
  ExchangeOrder,
  ExchangeActivity,
  ExchangeHolder,
  OrderInput,
  MimicOrderInput,
  MimicTradeResult,
  AdminAuditEntry,
  AdminInstanceConfig,
  AdminOverview,
  AdminSiteConfig,
  AdminUser,
  Feature,
} from '@watercooler/shared';

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  // BASE_URL is Vite's `base` (always ends with '/'), so this also works under a sub-path.
  const res = await fetch(`${import.meta.env.BASE_URL}api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as (T & { error?: string }) | null;
  if (!res.ok) throw new ApiError(res.status, data?.error ?? `请求失败（${res.status}）`);
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body: unknown = {}) => request<T>('POST', path, body);

export type MarketFilter = 'active' | 'closed' | 'resolved' | 'all';
export type MarketSort = 'trending' | 'pot' | 'new' | 'closing';
export type HistoryRange = '1d' | '1w' | '1m' | 'all';
export type LeaderboardSort = 'profit' | 'netWorth' | 'bets';

function qs(params: Record<string, string | number | undefined>): string {
  const s = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== '') s.set(k, String(v));
  const str = s.toString();
  return str ? `?${str}` : '';
}

export const api = {
  config: () => get<AppConfig>('/config'),
  me: () => get<{ user: Me | null }>('/auth/me'),
  login: (username: string, password: string) => post<{ user: Me }>('/auth/login', { username, password }),
  register: (input: { username: string; displayName: string; password: string; inviteCode?: string }) =>
    post<{ user: Me }>('/auth/register', input),
  logout: () => post<{ ok: true }>('/auth/logout'),
  changePassword: (oldPassword: string, newPassword: string) => post('/auth/password', { oldPassword, newPassword }),
  updateProfile: (displayName: string) => post<{ user: Me }>('/me/profile', { displayName }),
  claimBonus: () => post<{ balance: number; amount: number }>('/me/bonus'),

  admin: {
    overview: () => get<AdminOverview>('/admin/overview'),
    setFeature: (key: Feature, enabled: boolean) => post<AdminOverview>('/admin/features', { key, enabled }),
    setMimicTopK: (topK: number) => post<AdminOverview>('/admin/mimic', { topK }),
    restart: () => post<{ ok: true }>('/admin/restart'),
    users: (q = '', limit?: number) => get<AdminUser[]>(`/admin/users${qs({ q, limit })}`),
    adjustBalance: (username: string, amount: number, reason: string) =>
      post<AdminUser>('/admin/balance', { username, amount, reason }),
    grantAll: (amount: number, reason: string) => post<{ users: number }>('/admin/balance/all', { amount, reason }),
    addAdmin: (username: string) => post<AdminUser>('/admin/admins', { username }),
    removeAdmin: (username: string) => post<AdminUser>('/admin/admins/remove', { username }),
    audit: (before?: number) => get<AdminAuditEntry[]>(`/admin/audit${qs({ before })}`),
    config: () => get<AdminInstanceConfig>('/admin/config'),
    saveSite: (input: AdminSiteConfig) => post<AdminInstanceConfig>('/admin/config/site', input),
  },

  stats: () => get<SiteStats>('/stats'),
  activity: (limit = 30) => get<Bet[]>(`/activity${qs({ limit })}`),
  markets: (
    p: {
      filter?: MarketFilter;
      sort?: MarketSort;
      category?: string;
      q?: string;
      limit?: number;
      zone?: 'mimic';
    } = {},
  ) => get<MarketSummary[]>(`/markets${qs(p)}`),
  market: (id: number) => get<MarketDetailResponse>(`/markets/${id}`),
  /** Mirrors show the live Polymarket book of `outcome` (default: the first option). */
  exchange: (id: number, outcome?: number) => get<ExchangeState>(`/markets/${id}/exchange${qs({ outcome })}`),
  mimicOrder: (id: number, input: MimicOrderInput) => post<MimicTradeResult>(`/markets/${id}/mimic/order`, input),
  order: (id: number, input: OrderInput) => post<ExchangeOrder>(`/markets/${id}/orders`, input),
  cancelOrder: (id: number, orderId: number) => post(`/markets/${id}/orders/${orderId}/cancel`),
  splitMerge: (id: number, quantity: number, action: 'split' | 'merge', outcomeId?: number) =>
    post(`/markets/${id}/${action}`, { quantity, outcomeId }),
  convert: (id: number, outcomeIds: number[], quantity: number) =>
    post(`/markets/${id}/convert`, { outcomeIds, quantity }),
  exchangeHolders: (id: number) => get<ExchangeHolder[]>(`/markets/${id}/exchange/holders`),
  exchangeActivity: (id: number, before?: number) =>
    get<ExchangeActivity[]>(`/markets/${id}/exchange/activity${qs({ before })}`),
  history: (id: number, range: HistoryRange) => get<PricePoint[]>(`/markets/${id}/history${qs({ range })}`),
  marketBets: (id: number) => get<Bet[]>(`/markets/${id}/bets`),
  holders: (id: number) => get<Holder[]>(`/markets/${id}/holders`),
  comments: (id: number) => get<Comment[]>(`/markets/${id}/comments`),
  addComment: (id: number, body: string) => post<Comment>(`/markets/${id}/comments`, { body }),
  deleteComment: (id: number) => request<{ ok: true }>('DELETE', `/comments/${id}`),
  createMarket: (input: CreateMarketInput) => post<{ id: number }>('/markets', input),
  bet: (id: number, input: BetInput) => post<BetResult>(`/markets/${id}/bets`, input),
  resolve: (id: number, outcomeId: number, note?: string) =>
    post<MarketDetail>(`/markets/${id}/resolve`, { outcomeId, note }),
  cancel: (id: number, note?: string) => post<MarketDetail>(`/markets/${id}/cancel`, { note }),

  portfolio: () => get<Portfolio>('/portfolio'),
  ledger: (before?: number) => get<LedgerEntry[]>(`/portfolio/ledger${qs({ before })}`),
  leaderboard: (sort: LeaderboardSort) => get<LeaderboardEntry[]>(`/leaderboard${qs({ sort })}`),
  user: (id: number) => get<UserProfile>(`/users/${id}`),
};

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : '出错了，请稍后再试';
}
