import { useQuery } from '@tanstack/react-query';
import { CATEGORIES, CURRENCY_NAME, type MarketSummary } from '@watercooler/shared';
import clsx from 'clsx';
import { ChevronRight, Flame, Plus, Search, Sparkles, TrendingUp } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { CategoryIcon } from '../components/CategoryIcon';
import { MarketCard, MarketCardSkeleton } from '../components/MarketCard';
import { Money } from '../components/Money';
import { OutcomeQuote } from '../components/OutcomeQuote';
import { buttonClass, Card, Empty, Segmented } from '../components/ui';
import { api, type MarketFilter, type MarketSort } from '../lib/api';
import { useConfig, useMe } from '../lib/auth';
import { outcomeColor } from '../lib/colors';
import { formatCompact, formatPct, formatRelative, formatSigned } from '../lib/format';
import { COPY, usePageTitle } from '../lib/site';

const PriceChart = lazy(() => import('../components/PriceChart'));

/** Thin isometric line grid in the brand blue, a nod to ft.tech's isometric illustrations. */
const GRID_LINE = 'color-mix(in srgb, var(--color-brand) 14%, transparent)';
const ISO_GRID = {
  backgroundImage: `repeating-linear-gradient(30deg, ${GRID_LINE} 0 1px, transparent 1px 34px), repeating-linear-gradient(150deg, ${GRID_LINE} 0 1px, transparent 1px 34px)`,
  maskImage: 'linear-gradient(100deg, transparent 20%, #000 75%)',
  WebkitMaskImage: 'linear-gradient(100deg, transparent 20%, #000 75%)',
};

function FeaturedMarket({ market }: { market: MarketSummary }) {
  const navigate = useNavigate();
  const { data: history } = useQuery({
    queryKey: ['history', market.id, 'all'],
    queryFn: () => api.history(market.id, 'all'),
    enabled: market.mode === 'pool',
  });
  const lead = market.isBinary
    ? market.outcomes[0]!
    : [...market.outcomes].sort((a, b) => b.probability - a.probability)[0]!;

  return (
    <Card className="flex h-full flex-col p-6 shadow-[0_12px_40px_rgb(29_33_41/0.08)]">
      <div className="flex items-center gap-1.5 text-sm text-gold">
        <Flame className="size-4" /> 今日最热
      </div>
      <Link to={`/market/${market.id}`} className="group mt-3 flex items-start gap-3">
        <CategoryIcon category={market.category} size={44} />
        <h2 className="flex-1 text-xl leading-snug font-semibold transition-colors group-hover:text-brand">
          {market.question}
        </h2>
      </Link>
      {market.mode === 'polymarket' && market.isBinary ? (
        <div className="mt-5 flex-1">
          <p className="text-xs text-faint">挂单价 · 水滴/份</p>
          <div className="mt-3 grid gap-3">
            {market.outcomes.map((o) => (
              <button
                key={o.id}
                type="button"
                onClick={() => navigate(`/market/${market.id}?outcome=${o.id}`)}
                className="rounded bg-raised p-4 transition-colors hover:bg-fill"
              >
                <OutcomeQuote outcome={o} />
              </button>
            ))}
          </div>
        </div>
      ) : (
        <>
          <div className="mt-4 flex items-end gap-3">
            <span className="font-mono text-4xl font-bold text-brand">{formatPct(lead.probability)}</span>
            <span className="pb-1 text-sm text-dim">
              {market.mode === 'polymarket' ? `「${lead.label}」概率` : `押「${lead.label}」占比`}
            </span>
            {lead.change24h !== null && Math.abs(lead.change24h) >= 0.005 && (
              <span className={clsx('pb-1 font-mono text-sm', lead.change24h > 0 ? 'text-yes' : 'text-no')}>
                {lead.change24h > 0 ? '▲' : '▼'} {formatSigned(lead.change24h * 100, 0)}%
              </span>
            )}
          </div>
          <div className="mt-2 h-40 min-h-40 flex-1">
            {history && (
              <Suspense fallback={null}>
                <PriceChart market={market} points={history} />
              </Suspense>
            )}
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            {(market.isBinary
              ? market.outcomes
              : market.outcomes
                  .slice()
                  .sort((a, b) => b.probability - a.probability)
                  .slice(0, 3)
            ).map((o) => {
              const c = outcomeColor(o.index, market.isBinary);
              return (
                <button
                  key={o.id}
                  onClick={() => navigate(`/market/${market.id}?outcome=${o.id}`)}
                  className="flex flex-1 items-center justify-between gap-3 rounded px-4 py-2.5 text-sm font-semibold transition hover:brightness-95"
                  style={{ background: `${c}14`, color: c }}
                >
                  <span className="truncate">押 {o.label}</span>
                  <span className="font-mono text-xs">{formatPct(o.probability)}</span>
                </button>
              );
            })}
          </div>
        </>
      )}
      <div className="mt-4 flex items-center gap-3 text-xs text-faint">
        {market.mode === 'polymarket' ? '抵押' : '奖池'} <Money value={market.pot} compact className="text-dim" />
        <span>·</span>
        <span>
          {market.bettorCount} 人{market.mode === 'polymarket' ? '持仓' : '下注'}
        </span>
        <span className="ml-auto">{formatRelative(market.closeAt)}截止</span>
      </div>
    </Card>
  );
}

/** Full-width hero with a big headline, laid out like the ft.tech home hero. */
function Hero() {
  const { me } = useMe();
  const config = useConfig();
  const { data: stats } = useQuery({ queryKey: ['stats'], queryFn: api.stats });
  const { data: trending } = useQuery({
    queryKey: ['markets', { sort: 'trending', limit: 1 }],
    queryFn: () => api.markets({ sort: 'trending', limit: 1 }),
  });
  const featured = trending?.[0];

  return (
    <section className="relative overflow-hidden border-b border-line bg-panel">
      <div className="pointer-events-none absolute inset-0" style={ISO_GRID} aria-hidden />
      <div className="relative mx-auto grid max-w-7xl gap-10 px-4 pt-14 pb-24 lg:grid-cols-[1.05fr_1fr] lg:pt-16 lg:pb-28">
        <div className="flex flex-col justify-center">
          <div className="inline-flex w-fit items-center gap-2 rounded-full bg-fill px-3 py-1 text-xs text-dim">
            <span className="size-1.5 animate-pulse-ring rounded-full bg-yes" />
            {stats ? `${stats.openMarkets} 个市场正在下注` : '实时下注中'}
          </div>
          <h1 className="mt-6 text-4xl leading-tight font-semibold text-fg sm:text-[44px] sm:leading-[1.4]">
            {COPY.heroLead}
            <br />
            变成<span className="text-brand">概率</span>
          </h1>
          <p className="mt-4 max-w-lg text-base leading-relaxed text-dim">
            {COPY.heroTopics}……用{CURRENCY_NAME}表达你的判断。选择奖池模式按比例分奖池，或用 Polymarket 模式交易 Yes /
            No 份额，猜中每份兑回 1 水滴。
          </p>
          <div className="mt-8 flex flex-wrap gap-3">
            <a href="#markets" className={buttonClass({ size: 'lg' })}>
              <TrendingUp className="size-4" />
              开始预测
            </a>
            <Link to={me ? '/create' : '/register'} className={buttonClass({ size: 'lg', variant: 'outline' })}>
              {me ? <Plus className="size-4" /> : <Sparkles className="size-4" />}
              {me ? '发起一个市场' : `注册领 ${config?.startingBalance ?? 1000} ${CURRENCY_NAME}`}
            </Link>
          </div>
          {stats && (
            <dl className="mt-12 grid max-w-md grid-cols-3 gap-6">
              {[
                ['活跃市场', String(stats.openMarkets)],
                ['累计参与金额', formatCompact(stats.totalStaked)],
                ['参与人数', String(stats.bettors)],
              ].map(([label, value]) => (
                <div key={label}>
                  <dd className="font-mono text-3xl font-semibold text-brand">{value}</dd>
                  <dt className="mt-1 text-sm text-dim">{label}</dt>
                </div>
              ))}
            </dl>
          )}
        </div>
        <div className="min-h-[420px]">
          {featured ? (
            <FeaturedMarket market={featured} />
          ) : (
            <Card className="flex h-full items-center justify-center p-6">
              <Empty icon={<Sparkles className="size-10" />} title="还没有市场">
                {me ? '来创建第一个吧' : '登录后创建第一个市场'}
              </Empty>
            </Card>
          )}
        </div>
      </div>
    </section>
  );
}

/** White tab card that overlaps the hero's bottom edge, as on ft.tech. */
function CategoryTabs({ value, onChange }: { value: string; onChange: (category: string) => void }) {
  return (
    <div className="relative z-10 mx-auto -mt-9 max-w-7xl px-4">
      <div className="flex overflow-x-auto rounded-lg border border-line bg-panel px-2 shadow-[0_8px_24px_rgb(29_33_41/0.06)] lg:justify-around">
        {['', ...CATEGORIES].map((c) => {
          const active = value === c;
          return (
            <button
              key={c || 'all'}
              onClick={() => onChange(c)}
              className={clsx(
                'relative shrink-0 px-5 py-4 text-[15px] transition-colors',
                active ? 'font-semibold text-brand' : 'text-fg hover:text-brand',
              )}
            >
              {c || '全部市场'}
              {active && <span className="absolute inset-x-5 bottom-0 h-0.5 bg-brand" />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

const FILTERS: { value: MarketFilter; label: string }[] = [
  { value: 'active', label: '进行中' },
  { value: 'closed', label: '待公布' },
  { value: 'resolved', label: '已结束' },
];

const SORTS: { value: MarketSort; label: string }[] = [
  { value: 'trending', label: '热门' },
  { value: 'pot', label: '奖池' },
  { value: 'new', label: '最新' },
  { value: 'closing', label: '即将截止' },
];

function MarketBrowser() {
  const [params, setParams] = useSearchParams();
  const category = params.get('cat') ?? '';
  const filter = (params.get('status') as MarketFilter) || 'active';
  const sort = (params.get('sort') as MarketSort) || 'trending';
  const [search, setSearch] = useState(params.get('q') ?? '');
  const [debounced, setDebounced] = useState(search);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 250);
    return () => clearTimeout(t);
  }, [search]);

  const update = (key: string, value: string) =>
    setParams(
      (p) => {
        if (value) p.set(key, value);
        else p.delete(key);
        return p;
      },
      { replace: true, preventScrollReset: true },
    );

  const query = { filter, sort, category: category || undefined, q: debounced || undefined };
  const { data, isPending } = useQuery({
    queryKey: ['markets', query],
    queryFn: () => api.markets(query),
    refetchInterval: 20_000,
  });

  return (
    <>
      <CategoryTabs value={category} onChange={(c) => update('cat', c)} />
      <section id="markets" className="mx-auto max-w-7xl scroll-mt-24 px-4 pt-14 pb-20">
        <div className="text-center">
          <h2 className="section-title">预测市场</h2>
          <p className="mt-3 text-dim">选一个你有把握的问题，押你认为会发生的结果</p>
        </div>
        <div className="mt-8 flex flex-col gap-3 sm:flex-row sm:items-center">
          <Segmented value={filter} onChange={(v) => update('status', v === 'active' ? '' : v)} options={FILTERS} />
          <div className="flex gap-2 sm:ml-auto">
            <div className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
              <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-faint" />
              <input
                value={search}
                onChange={(e) => {
                  setSearch(e.target.value);
                  update('q', e.target.value.trim());
                }}
                placeholder="搜索市场"
                className="h-9 w-full rounded border border-line bg-panel pr-3 pl-9 text-sm outline-none placeholder:text-faint hover:border-line-strong focus:border-brand"
              />
            </div>
            <select
              value={sort}
              onChange={(e) => update('sort', e.target.value === 'trending' ? '' : e.target.value)}
              className="h-9 rounded border border-line bg-panel px-3 text-sm text-fg outline-none hover:border-line-strong focus:border-brand"
              aria-label="排序"
            >
              {SORTS.map((s) => (
                <option key={s.value} value={s.value}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="mt-5 grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {isPending
            ? Array.from({ length: 8 }, (_, i) => <MarketCardSkeleton key={i} />)
            : data?.map((m) => <MarketCard key={m.id} market={m} />)}
        </div>
        {data && data.length === 0 && (
          <Empty icon={<Search className="size-10" />} title="没有找到市场">
            换个筛选条件试试，或者自己发起一个
          </Empty>
        )}
      </section>
    </>
  );
}

/** Latest trades and the leaderboard side by side. */
function CommunitySection() {
  const { data: activity } = useQuery({ queryKey: ['activity'], queryFn: () => api.activity(24) });
  const { data: board } = useQuery({ queryKey: ['leaderboard', 'profit'], queryFn: () => api.leaderboard('profit') });
  return (
    <section className="mx-auto max-w-7xl px-4 pb-20">
      <div className="text-center">
        <h2 className="section-title">社区动态</h2>
        <p className="mt-3 text-dim">看看大家都在押什么，谁押得最准</p>
      </div>
      <div className="mt-10 grid grid-cols-1 gap-5 lg:grid-cols-[1.35fr_1fr]">
        <Card className="min-w-0 p-6">
          <h3 className="flex items-center gap-2 text-lg font-semibold">
            <span className="size-2 animate-pulse-ring rounded-full bg-yes" /> 最新下注
          </h3>
          <ul className="mt-4 divide-y divide-line">
            {activity?.slice(0, 7).map((t) => (
              <li key={t.id} className="flex items-center gap-3 py-3 text-sm">
                <Link to={`/u/${t.user.id}`}>
                  <Avatar id={t.user.id} name={t.user.displayName} size={28} />
                </Link>
                <div className="min-w-0 flex-1">
                  <div className="truncate">
                    <Link to={`/u/${t.user.id}`} className="hover:text-brand">
                      {t.user.displayName}
                    </Link>{' '}
                    押「{t.outcomeLabel}」
                  </div>
                  <Link to={`/market/${t.marketId}`} className="block truncate text-xs text-faint hover:text-brand">
                    {t.marketQuestion}
                  </Link>
                </div>
                <div className="text-right">
                  <Money value={t.amount} className="font-mono" />
                  <div className="text-xs text-faint">{formatRelative(t.createdAt)}</div>
                </div>
              </li>
            ))}
            {activity?.length === 0 && <li className="py-6 text-center text-sm text-faint">还没有人下注</li>}
          </ul>
        </Card>
        <Card className="flex min-w-0 flex-col p-6">
          <div className="flex items-center justify-between">
            <h3 className="text-lg font-semibold">预言家榜</h3>
            <Link to="/leaderboard" className="flex items-center text-sm text-brand hover:text-brand-hover">
              完整排行榜 <ChevronRight className="size-4" />
            </Link>
          </div>
          <p className="mt-2 text-xs text-faint">按已结算盈利排名，未结算交易暂不计入。</p>
          <ol className="mt-4 space-y-1">
            {board?.slice(0, 6).map((e) => (
              <li key={e.user.id}>
                <Link
                  to={`/u/${e.user.id}`}
                  className="flex items-center gap-3 rounded px-2 py-2.5 transition hover:bg-raised"
                >
                  <span
                    className={clsx(
                      'w-6 text-center font-mono text-lg font-bold',
                      e.rank <= 3 ? 'text-brand' : 'text-faint',
                    )}
                  >
                    {e.rank}
                  </span>
                  <Avatar id={e.user.id} name={e.user.displayName} size={30} />
                  <span className="flex-1 truncate">{e.user.displayName}</span>
                  <span className={clsx('font-mono', e.stats.profit >= 0 ? 'text-yes' : 'text-no')}>
                    {formatSigned(e.stats.profit, 0)}
                  </span>
                </Link>
              </li>
            ))}
          </ol>
        </Card>
      </div>
    </section>
  );
}

/** Closing call to action above the footer, like ft.tech's "一站式……专家 / 商务合作" block. */
function CallToAction() {
  const { me } = useMe();
  return (
    <section className="border-t border-line bg-panel py-16 text-center">
      <h2 className="text-[28px] font-light text-fg">有想押注的话题？发起一个市场，看看大家怎么想</h2>
      <Link to={me ? '/create' : '/register'} className={buttonClass({ pill: true, className: 'mt-8 px-10' })}>
        {me ? '发起市场' : '注册加入'}
      </Link>
    </section>
  );
}

export default function Home() {
  usePageTitle(null);
  return (
    <>
      <Hero />
      <MarketBrowser />
      <CommunitySection />
      <CallToAction />
    </>
  );
}
