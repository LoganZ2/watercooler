import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCY_NAME, payoutFor, type MarketDetail, type Stake } from '@watercooler/shared';
import clsx from 'clsx';
import {
  Ban,
  CalendarClock,
  ChevronLeft,
  Crown,
  ExternalLink,
  Gavel,
  MessageCircle,
  ScrollText,
  Trash2,
  Users,
} from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Avatar } from '../components/Avatar';
import { BetPanel } from '../components/BetPanel';
import { ExchangePanel, ExchangePositions, type TicketIntent } from '../components/ExchangePanel';
import { ExchangeBook } from '../components/ExchangeBook';
import { ExchangeActivityList, ExchangeHolders, ExchangeOutcomes } from '../components/ExchangeLists';
import { CategoryIcon } from '../components/CategoryIcon';
import { Money } from '../components/Money';
import { StatusBadge } from '../components/StatusBadge';
import { Badge, Button, Card, Empty, Modal, PageLoader, Segmented, Spinner, Textarea } from '../components/ui';
import { api, errorMessage, type HistoryRange } from '../lib/api';
import { useMe } from '../lib/auth';
import { outcomeColor } from '../lib/colors';
import { isMultiExchange, type ShareRef } from '../lib/exchange';
import {
  formatDate,
  formatMoney,
  formatMultiplier,
  formatPct,
  formatRelative,
  formatSigned,
  formatUsd,
} from '../lib/format';
import { usePageTitle } from '../lib/site';

const PriceChart = lazy(() => import('../components/PriceChart'));

function ChartCard({ market }: { market: MarketDetail }) {
  const [range, setRange] = useState<HistoryRange>('all');
  const { data, isPending } = useQuery({
    queryKey: ['history', market.id, range],
    queryFn: () => api.history(market.id, range),
    refetchInterval: market.status === 'open' ? 15_000 : false,
  });
  const lead = market.outcomes[0]!;
  const sorted = [...market.outcomes].sort((a, b) => b.probability - a.probability);

  return (
    <Card className="p-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        {market.isBinary ? (
          <div className="flex items-end gap-3">
            <span className="font-mono text-5xl font-bold text-brand">{formatPct(lead.probability)}</span>
            <span className="pb-2 text-sm text-dim">
              {market.mode === 'polymarket' ? `「${lead.label}」概率` : `押「${lead.label}」占比`}
            </span>
            {lead.change24h !== null && Math.abs(lead.change24h) >= 0.001 && (
              <span className={clsx('pb-2 font-mono text-sm', lead.change24h > 0 ? 'text-yes' : 'text-no')}>
                {lead.change24h > 0 ? '▲' : '▼'} {formatSigned(lead.change24h * 100, 1)}% 24h
              </span>
            )}
          </div>
        ) : (
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {sorted.slice(0, 6).map((o) => (
              <span key={o.id} className="inline-flex items-center gap-1.5 text-sm">
                <span className="size-2 rounded-full" style={{ background: outcomeColor(o.index, false) }} />
                <span className="text-dim">{o.label}</span>
                <span className="font-mono font-semibold">{formatPct(o.probability)}</span>
              </span>
            ))}
          </div>
        )}
        <Segmented
          size="sm"
          value={range}
          onChange={setRange}
          options={[
            { value: '1d', label: '1天' },
            { value: '1w', label: '1周' },
            { value: '1m', label: '1月' },
            { value: 'all', label: '全部' },
          ]}
        />
      </div>
      <div className="mt-4 h-72">
        {market.mode === 'pool' && market.pot === 0 ? (
          <Empty icon={<Users className="size-10" />} title="还没有人下注">
            第一笔下注之后，这里会显示大家押注比例的变化
          </Empty>
        ) : isPending || !data ? (
          <div className="flex h-full items-center justify-center">
            <Spinner />
          </div>
        ) : (
          <Suspense fallback={null}>
            <PriceChart market={market} points={data} />
          </Suspense>
        )}
      </div>
    </Card>
  );
}

function OutcomeTable({
  market,
  selected,
  onSelect,
}: {
  market: MarketDetail;
  selected: number;
  onSelect: (id: number) => void;
}) {
  const sorted = [...market.outcomes].sort((a, b) => b.probability - a.probability);
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[1fr_auto_auto] gap-4 border-b border-line px-5 py-2.5 text-xs text-faint">
        <span>选项</span>
        <span className="w-20 text-right">奖池占比</span>
        <span className="w-20" />
      </div>
      {sorted.map((o) => {
        const c = outcomeColor(o.index, market.isBinary);
        const isWinner = market.resolvedOutcomeId === o.id;
        return (
          <div
            key={o.id}
            className={clsx(
              'relative grid grid-cols-[1fr_auto_auto] items-center gap-4 border-b border-line px-5 py-3.5 transition last:border-0',
              selected === o.id ? 'bg-fill' : 'hover:bg-raised',
            )}
          >
            <div
              className="absolute inset-y-0 left-0 opacity-[0.07] transition-all duration-500"
              style={{ width: `${o.probability * 100}%`, background: c }}
            />
            <div className="relative flex min-w-0 items-center gap-3">
              <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: c }} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5">
                  <span className="truncate font-medium">{o.label}</span>
                  {isWinner && <Crown className="size-4 shrink-0 text-gold" />}
                </span>
                <span className="block text-xs text-faint">
                  奖池 {formatMoney(o.pool)}
                  {o.pool > 0 && market.status === 'open' && ` · 赔率 ${formatMultiplier(market.pot / o.pool)}`}
                </span>
              </span>
              {o.change24h !== null && Math.abs(o.change24h) >= 0.005 && (
                <span className={clsx('shrink-0 font-mono text-xs', o.change24h > 0 ? 'text-yes' : 'text-no')}>
                  {o.change24h > 0 ? '▲' : '▼'}
                  {Math.abs(Math.round(o.change24h * 100))}
                </span>
              )}
            </div>
            <span className="relative w-20 text-right font-mono text-xl font-semibold">{formatPct(o.probability)}</span>
            <div className="relative w-20 text-right">
              {market.status === 'open' && (
                <button
                  onClick={() => onSelect(o.id)}
                  className="rounded-lg border px-3 py-1.5 text-xs font-semibold transition hover:brightness-125"
                  style={{ borderColor: `${c}55`, background: `${c}1a`, color: c }}
                >
                  押注
                </button>
              )}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

function ResolutionBanner({ market }: { market: MarketDetail }) {
  if (market.status === 'open') return null;
  const winner = market.outcomes.find((o) => o.id === market.resolvedOutcomeId);
  const styles = {
    closed: 'border-gold/30 bg-gold/[0.07] text-gold',
    resolved: 'border-brand/30 bg-brand/[0.07] text-brand',
    cancelled: 'border-line-strong bg-fill text-dim',
  }[market.status];
  return (
    <div className={clsx('flex items-start gap-3 rounded-lg border p-4', styles)}>
      {market.status === 'resolved' ? (
        <Crown className="mt-0.5 size-5 shrink-0" />
      ) : market.status === 'cancelled' ? (
        <Ban className="mt-0.5 size-5 shrink-0" />
      ) : (
        <CalendarClock className="mt-0.5 size-5 shrink-0" />
      )}
      <div className="text-sm">
        <div className="font-semibold">
          {market.status === 'resolved'
            ? market.mimic
              ? `已按 Polymarket 的结果结算${winner ? `：「${winner.label}」` : ''}`
              : `已公布结果：「${winner?.label}」`
            : market.mimic
              ? 'Polymarket 已停止交易，等它公布结果后自动结算'
              : market.status === 'cancelled'
                ? market.mode === 'polymarket'
                  ? '市场已取消，Yes / No 每份已兑回 0.50 水滴'
                  : '市场已取消，所有下注已全额退回'
                : market.mode === 'polymarket'
                  ? `交易已停止，等待 ${market.creator.displayName} 在结算时间到达后公布结果`
                  : `下注已截止，等待 ${market.creator.displayName} 公布结果`}
        </div>
        {market.resolutionNote && <div className="mt-1 text-fg/70">{market.resolutionNote}</div>}
        <div className="mt-1 text-xs opacity-70">
          {market.status === 'closed'
            ? market.mimic
              ? '持仓和资金一直保留，Polymarket 公布结果后按每份 1 / 0 兑付。'
              : market.mode === 'polymarket'
                ? `结算时间：${formatDate(market.settleAt)}；未公布时保留持仓和资金，继续等待结算。`
                : `结算时间：${formatDate(market.settleAt)}；${formatDate(market.resolveBy!)} 前未公布会自动取消退款。`
            : market.resolvedAt && formatDate(market.resolvedAt)}
        </div>
      </div>
    </div>
  );
}

function Comments({ marketId }: { marketId: number }) {
  const { me } = useMe();
  const qc = useQueryClient();
  const [body, setBody] = useState('');
  const { data } = useQuery({ queryKey: ['comments', marketId], queryFn: () => api.comments(marketId) });
  const add = useMutation({
    mutationFn: () => api.addComment(marketId, body.trim()),
    onSuccess: () => {
      setBody('');
      void qc.invalidateQueries({ queryKey: ['comments', marketId] });
      void qc.invalidateQueries({ queryKey: ['market', marketId] });
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.deleteComment(id),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['comments', marketId] }),
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div>
      {me ? (
        <div className="flex gap-3">
          <Avatar id={me.id} name={me.displayName} size={36} />
          <div className="flex-1">
            <Textarea
              value={body}
              onChange={(e) => setBody(e.target.value)}
              placeholder="说说你的判断依据……"
              maxLength={1000}
              className="min-h-20"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey) && body.trim()) add.mutate();
              }}
            />
            <div className="mt-2 flex items-center justify-end gap-3">
              <span className="text-xs text-faint">Ctrl/⌘ + Enter 发送</span>
              <Button size="sm" disabled={!body.trim()} loading={add.isPending} onClick={() => add.mutate()}>
                发表
              </Button>
            </div>
          </div>
        </div>
      ) : (
        <div className="rounded border border-dashed border-line-strong p-4 text-center text-sm text-faint">
          <Link to="/login" className="text-brand hover:underline">
            登录
          </Link>{' '}
          后参与讨论
        </div>
      )}
      <ul className="mt-6 space-y-5">
        {data?.map((c) => (
          <li key={c.id} className="group flex gap-3">
            <Link to={`/u/${c.user.id}`}>
              <Avatar id={c.user.id} name={c.user.displayName} size={36} />
            </Link>
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2 text-sm">
                <Link to={`/u/${c.user.id}`} className="font-medium hover:underline">
                  {c.user.displayName}
                </Link>
                <span className="text-xs text-faint">{formatRelative(c.createdAt)}</span>
                {me?.id === c.user.id && (
                  <button
                    onClick={() => remove.mutate(c.id)}
                    className="ml-auto text-faint opacity-0 transition group-hover:opacity-100 hover:text-no"
                    aria-label="删除评论"
                  >
                    <Trash2 className="size-3.5" />
                  </button>
                )}
              </div>
              <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-fg">{c.body}</p>
            </div>
          </li>
        ))}
        {data?.length === 0 && <li className="py-6 text-center text-sm text-faint">还没有评论，来抢沙发</li>}
      </ul>
    </div>
  );
}

function Holders({ market }: { market: MarketDetail }) {
  const { data } = useQuery({ queryKey: ['holders', market.id], queryFn: () => api.holders(market.id) });
  if (!data) return <Spinner />;
  if (data.length === 0) return <Empty title="还没有人下注" />;
  const groups = market.outcomes
    .map((o) => ({ outcome: o, holders: data.filter((h) => h.outcomeId === o.id) }))
    .filter((g) => g.holders.length);
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {groups.map(({ outcome, holders }) => (
        <div key={outcome.id}>
          <div
            className="mb-2 flex items-center gap-2 text-sm font-semibold"
            style={{ color: outcomeColor(outcome.index, market.isBinary) }}
          >
            押「{outcome.label}」的人
          </div>
          <ul className="space-y-1">
            {holders.map((h) => (
              <li key={h.user.id}>
                <Link
                  to={`/u/${h.user.id}`}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-raised"
                >
                  <Avatar id={h.user.id} name={h.user.displayName} size={24} />
                  <span className="flex-1 truncate">{h.user.displayName}</span>
                  <Money value={h.amount} className="font-mono text-xs text-dim" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

function BetHistory({ market }: { market: MarketDetail }) {
  const { data } = useQuery({ queryKey: ['marketBets', market.id], queryFn: () => api.marketBets(market.id) });
  if (!data) return <Spinner />;
  if (data.length === 0) return <Empty title="还没有人下注" />;
  return (
    <ul className="divide-y divide-line">
      {data.map((b) => (
        <li key={b.id} className="flex items-center gap-3 py-2.5 text-sm">
          <Avatar id={b.user.id} name={b.user.displayName} size={26} />
          <div className="min-w-0 flex-1 truncate">
            <Link to={`/u/${b.user.id}`} className="font-medium hover:underline">
              {b.user.displayName}
            </Link>{' '}
            押{' '}
            <span
              style={{
                color: outcomeColor(market.outcomes.find((o) => o.id === b.outcomeId)?.index ?? 0, market.isBinary),
              }}
            >
              {b.outcomeLabel}
            </span>
          </div>
          <Money value={b.amount} className="font-mono" />
          <span className="w-16 text-right text-xs text-faint">{formatRelative(b.createdAt)}</span>
        </li>
      ))}
    </ul>
  );
}

function MyStakes({ market, stakes }: { market: MarketDetail; stakes: Stake[] }) {
  if (stakes.length === 0) return null;
  const pools = market.outcomes.map((o) => o.pool);
  const winner = market.outcomes.find((o) => o.id === market.resolvedOutcomeId);
  const refunded = market.status === 'cancelled' || (winner !== undefined && winner.pool === 0);
  return (
    <Card className="p-5">
      <h3 className="mb-3 text-sm font-semibold text-dim">我的下注</h3>
      <div className="space-y-3">
        {stakes.map((s) => {
          const i = market.outcomes.findIndex((x) => x.id === s.outcomeId);
          const o = market.outcomes[i]!;
          const payout = payoutFor(pools, i, s.amount);
          const [label, value, className] = refunded
            ? ['已退回', s.amount, 'text-dim']
            : winner
              ? winner.id === o.id
                ? ['已获得', payout, 'text-yes']
                : ['未押中', 0, 'text-no']
              : ['猜中可得', payout, 'text-yes'];
          return (
            <div key={s.outcomeId} className="rounded bg-raised p-3">
              <div className="flex items-center justify-between">
                <span className="font-semibold" style={{ color: outcomeColor(o.index, market.isBinary) }}>
                  {o.label}
                </span>
                <span className="text-sm">
                  已押 <Money value={s.amount} className="font-mono" />
                </span>
              </div>
              <div className="mt-2 flex items-center justify-between text-xs">
                <span className="text-faint">{label}</span>
                <span className={clsx('font-mono', className)}>
                  {formatMoney(value)}
                  {!winner && !refunded && ` (${formatSigned(value - s.amount)})`}
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}

function CreatorPanel({ market }: { market: MarketDetail }) {
  const qc = useQueryClient();
  const [mode, setMode] = useState<'resolve' | 'cancel' | null>(null);
  const [outcomeId, setOutcomeId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const mutation = useMutation({
    mutationFn: () =>
      mode === 'resolve'
        ? api.resolve(market.id, outcomeId!, note.trim() || undefined)
        : api.cancel(market.id, note.trim() || undefined),
    onSuccess: () => {
      toast.success(mode === 'resolve' ? '结果已公布，资金已结算' : '市场已取消，资金已结算');
      setMode(null);
      void qc.invalidateQueries();
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (market.status === 'resolved' || market.status === 'cancelled') return null;
  // Pool creators may announce as soon as they know; Polymarket waits for the settlement time.
  const canResolve = market.mode === 'pool' || Date.now() >= market.settleAt;

  return (
    <Card className="border-brand/30 p-5">
      <h3 className="flex items-center gap-2 text-sm font-semibold text-brand">
        <Gavel className="size-4" /> 你是创建者
      </h3>
      <p className="mt-1.5 text-xs leading-relaxed text-faint">
        {market.mode === 'polymarket' ? (
          <>
            结算时间到达后由你公布结果，获胜份额每份兑回 1 水滴。Polymarket 市场不可取消。
            停止交易时未成交订单会撤销并解冻；未公布结果时保留持仓和抵押资金，继续等待结算。操作不可撤销。
          </>
        ) : (
          <>
            {`结果确定后就可以公布，公布后立即停止下注；${formatDate(market.resolveBy!)} 前没公布会自动取消并全额退款。`}
            {`押中的人按比例瓜分全部 ${formatMoney(market.pot)} ${CURRENCY_NAME} 奖池；题目出了问题可以取消，所有下注全额退回。操作不可撤销。`}
          </>
        )}
      </p>
      {!canResolve && <p className="mt-2 text-xs text-faint">{formatDate(market.settleAt)} 起可公布结果并结算。</p>}
      <div className="mt-4 flex gap-2">
        <Button size="sm" className="flex-1" disabled={!canResolve} onClick={() => setMode('resolve')}>
          公布结果
        </Button>
        {market.mode === 'pool' && (
          <Button size="sm" variant="danger" className="flex-1" onClick={() => setMode('cancel')}>
            取消市场
          </Button>
        )}
      </div>
      <Modal open={mode !== null} onClose={() => setMode(null)} title={mode === 'resolve' ? '公布结果' : '取消市场'}>
        {mode === 'resolve' && (
          <div className="space-y-2">
            <div className="text-sm text-dim">选择最终结果</div>
            {market.outcomes.map((o) => (
              <button
                key={o.id}
                onClick={() => setOutcomeId(o.id)}
                className={clsx(
                  'flex w-full items-center justify-between rounded border px-4 py-3 text-left text-sm font-medium transition',
                  outcomeId === o.id ? 'border-brand bg-brand-light text-brand' : 'border-line hover:border-brand',
                )}
              >
                {o.label}
                {market.mode === 'pool' && (
                  <span className="font-mono text-xs text-faint">奖池 {formatMoney(o.pool)}</span>
                )}
              </button>
            ))}
          </div>
        )}
        <Textarea
          className="mt-4"
          placeholder={mode === 'resolve' ? '结果说明（可选），比如依据来源' : '取消原因（可选）'}
          value={note}
          onChange={(e) => setNote(e.target.value)}
        />
        <Button
          className="mt-4 w-full"
          variant={mode === 'cancel' ? 'danger' : 'primary'}
          disabled={mode === 'resolve' && (outcomeId === null || !canResolve)}
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          确认{mode === 'resolve' ? '公布' : '取消'}
        </Button>
      </Modal>
    </Card>
  );
}

export default function Market() {
  const id = Number(useParams().id);
  const [params, setParams] = useSearchParams();
  const { me } = useMe();
  const [tab, setTab] = useState<'comments' | 'holders' | 'bets' | 'activity'>('comments');
  const { data, isPending, error } = useQuery({
    queryKey: ['market', id],
    queryFn: () => api.market(id),
    refetchInterval: 10_000,
  });
  const [picked, setPicked] = useState<ShareRef | null>(null);
  const [intent, setIntent] = useState<TicketIntent | null>(null);
  // A mirror's live book is fetched from Polymarket for the option in view only.
  const mirrorFocus = data?.market.mimic ? (picked?.outcomeId ?? null) : null;
  const exchange = useQuery({
    queryKey: ['exchange', id, me?.id, mirrorFocus],
    queryFn: () => api.exchange(id, mirrorFocus ?? undefined),
    enabled: data?.market.mode === 'polymarket',
    refetchInterval: 3000,
  });
  usePageTitle(data?.market.question);

  useEffect(() => {
    setIntent(null);
    setTab('comments');
  }, [id]);

  useEffect(() => {
    const fromUrl = Number(params.get('outcome'));
    if (fromUrl) setPicked({ outcomeId: fromUrl, token: params.get('token') === 'no' ? 'no' : 'yes' });
  }, [params]);

  if (isPending) return <PageLoader />;
  if (error || !data) return <Empty title="市场不存在或已被删除" />;
  const { market, stakes } = data;
  const share: ShareRef =
    picked && market.outcomes.some((o) => o.id === picked.outcomeId)
      ? { outcomeId: picked.outcomeId, token: isMultiExchange(market) ? picked.token : 'yes' }
      : { outcomeId: market.outcomes[0]!.id, token: 'yes' };
  const selected = share.outcomeId;

  const focusTrade = () => {
    if (window.innerWidth < 1024)
      document.getElementById('trade')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };
  const selectShare = (s: ShareRef, scrollToTrade = true) => {
    setPicked(s);
    setParams(
      (p) => {
        p.set('outcome', String(s.outcomeId));
        if (s.token === 'no') p.set('token', 'no');
        else p.delete('token');
        return p;
      },
      { replace: true, preventScrollReset: true },
    );
    if (scrollToTrade) focusTrade();
  };
  const selectOutcome = (oid: number, scrollToTrade = true) =>
    selectShare({ outcomeId: oid, token: 'yes' }, scrollToTrade);
  const ticket = (next: Omit<TicketIntent, 'seq'>) => setIntent((prev) => ({ ...next, seq: (prev?.seq ?? 0) + 1 }));

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_380px]">
      <div className="space-y-5">
        <Link
          to={market.isAi ? '/ai' : market.mimic ? '/polymarket' : '/'}
          className="inline-flex items-center gap-1 text-sm text-dim hover:text-fg"
        >
          <ChevronLeft className="size-4" /> {market.isAi ? 'AI 专区' : market.mimic ? 'Polymarket 热门' : '全部市场'}
        </Link>
        <header className="flex items-start gap-4">
          <CategoryIcon category={market.category} size={60} className="hidden sm:inline-flex" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <Badge>{market.category}</Badge>
              <Badge>
                {market.mimic ? 'Polymarket 镜像' : market.mode === 'polymarket' ? 'Polymarket' : '奖池模式'}
              </Badge>
              {market.isAi && <Badge className="bg-brand-light text-brand">AI 出题</Badge>}
              <StatusBadge market={market} />
            </div>
            <h1 className="mt-2 text-2xl leading-tight font-semibold sm:text-[28px] sm:leading-[1.3]">
              {market.question}
            </h1>
            <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-1.5 text-sm text-dim">
              {market.mimic ? (
                <a
                  href={market.mimic.url}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 hover:text-brand"
                >
                  Polymarket 24h 成交 {formatUsd(market.mimic.volume24h)}
                  <ExternalLink className="size-3.5" />
                </a>
              ) : (
                <span className="inline-flex items-center gap-1.5">
                  {market.mode === 'polymarket' ? '抵押资金' : '奖池'} <Money value={market.pot} />
                </span>
              )}
              <span className="inline-flex items-center gap-1.5">
                <Users className="size-4 text-faint" /> {market.bettorCount} 人
                {market.mode === 'polymarket' ? '持仓' : '下注'}
              </span>
              <span className="inline-flex items-center gap-1.5">
                <CalendarClock className="size-4 text-faint" /> {formatDate(market.closeAt)} 停止交易
              </span>
              {!market.mimic && (
                <Link to={`/u/${market.creator.id}`} className="inline-flex items-center gap-1.5 hover:text-fg">
                  <Avatar id={market.creator.id} name={market.creator.displayName} size={18} />
                  {market.creator.displayName} 发起
                </Link>
              )}
            </div>
          </div>
        </header>
        <ResolutionBanner market={market} />
        <ChartCard market={market} />
        {market.mode === 'polymarket' ? (
          <>
            {!market.isBinary && (
              <ExchangeOutcomes
                market={market}
                selected={selected}
                onPick={(s) => {
                  selectShare(s);
                  ticket({ side: 'buy', mode: 'market' });
                }}
              />
            )}
            <ExchangeBook
              market={market}
              data={exchange.data}
              error={exchange.error}
              share={share}
              onShareChange={(s) => selectShare(s, false)}
              onQuoteSelect={(side, price) => {
                // Mirrors only take market orders against Polymarket's book.
                ticket(market.mimic ? { side, mode: 'market' } : { side, mode: 'limit', price });
                focusTrade();
              }}
            />
          </>
        ) : (
          !market.isBinary && <OutcomeTable market={market} selected={selected} onSelect={selectOutcome} />
        )}
      </div>

      <aside id="trade" className="scroll-mt-20 space-y-4 lg:sticky lg:top-24 lg:row-span-2 lg:self-start">
        {market.mode === 'polymarket' ? (
          <>
            <ExchangePanel
              key={market.id}
              market={market}
              data={exchange.data}
              error={exchange.error}
              share={share}
              onShareChange={(s) => selectShare(s, false)}
              intent={intent}
            />
            <ExchangePositions
              key={`positions-${market.id}`}
              market={market}
              data={exchange.data}
              onSell={(s, quantity) => {
                selectShare(s, false);
                ticket({ side: 'sell', mode: 'market', quantity: String(quantity) });
                document.getElementById('trade')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
              }}
            />
          </>
        ) : (
          <>
            <BetPanel market={market} stakes={stakes} outcomeId={selected} onOutcomeChange={selectOutcome} />
            <MyStakes market={market} stakes={stakes} />
          </>
        )}
        {me?.id === market.creator.id && <CreatorPanel market={market} />}
      </aside>

      <div className="space-y-5">
        <Card className="p-5">
          <h2 className="flex items-center gap-2 font-semibold">
            <ScrollText className="size-4 text-brand" /> 结算规则
          </h2>
          <p className="mt-3 text-sm leading-relaxed whitespace-pre-wrap text-fg">
            {market.description || '发起人没有填写额外说明。以常识和公开信息为准，由发起人公布结果。'}
          </p>
          {market.mimic && (
            <p className="mt-3 rounded bg-raised p-3 text-xs leading-relaxed text-dim">
              这是 polymarket.com 上的盘的镜像，规则和结果都以 Polymarket 为准（上面是它的英文规则原文）。大家在这里按
              Polymarket 的实时盘口用水滴买卖，交易不会影响 Polymarket 的价格；它结算后这里自动兑付。
            </p>
          )}
          {market.isAi && (
            <p className="mt-3 rounded bg-raised p-3 text-xs leading-relaxed text-dim">
              这道题是 AI
              机器人联网找新闻出的，截止后由它再次联网核实并公布结果；查不到会过几个小时再查，题目有问题会取消并全额退款。
            </p>
          )}
          <div className="mt-4 grid grid-cols-2 gap-3 text-xs text-faint sm:grid-cols-3">
            <div>
              <div>创建时间</div>
              <div className="mt-0.5 text-dim">{formatDate(market.createdAt)}</div>
            </div>
            <div>
              <div>停止交易</div>
              <div className="mt-0.5 text-dim">{formatDate(market.closeAt)}</div>
            </div>
            <div>
              <div>结算时间</div>
              <div className="mt-0.5 text-dim">{formatDate(market.settleAt)}</div>
            </div>
            <div>
              <div>实际结算</div>
              <div className="mt-0.5 text-dim">{market.resolvedAt ? formatDate(market.resolvedAt) : '尚未结算'}</div>
            </div>
          </div>
        </Card>

        <Card className="p-5">
          <Segmented
            variant="tabs"
            value={tab}
            onChange={setTab}
            options={[
              {
                value: 'comments',
                label: (
                  <span className="inline-flex items-center gap-1.5">
                    <MessageCircle className="size-3.5" /> 讨论 {market.commentCount > 0 && market.commentCount}
                  </span>
                ),
              },
              ...(market.mode === 'pool'
                ? [
                    { value: 'holders' as const, label: '下注榜' },
                    { value: 'bets' as const, label: '下注记录' },
                  ]
                : [
                    { value: 'holders' as const, label: '持有者' },
                    { value: 'activity' as const, label: '成交动态' },
                  ]),
            ]}
          />
          <div className="mt-5">
            {tab === 'comments' && <Comments marketId={market.id} />}
            {tab === 'holders' &&
              (market.mode === 'pool' ? (
                <Holders market={market} />
              ) : (
                <ExchangeHolders market={market} outcomeId={selected} />
              ))}
            {tab === 'bets' && market.mode === 'pool' && <BetHistory market={market} />}
            {tab === 'activity' && market.mode === 'polymarket' && <ExchangeActivityList market={market} />}
          </div>
        </Card>
      </div>
    </div>
  );
}
