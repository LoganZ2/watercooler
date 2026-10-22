import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type { ExchangeState, MarketDetail } from '@watercooler/shared';
import clsx from 'clsx';
import { Crown } from 'lucide-react';
import { Link } from 'react-router';
import { api } from '../lib/api';
import { outcomeColor } from '../lib/colors';
import { bookOf, formatPrice, isMultiExchange, shareName, sharePair, type ShareRef } from '../lib/exchange';
import { formatMoney, formatPct, formatRelative } from '../lib/format';
import { Avatar } from './Avatar';
import { Button, Card, Empty, Spinner } from './ui';

/** Multi-outcome markets: every option with its chance and one-tap Yes / No buys, like a Polymarket event. */
export function ExchangeOutcomes({
  market,
  data,
  selected,
  onPick,
}: {
  market: MarketDetail;
  data: ExchangeState | undefined;
  selected: number;
  onPick: (share: ShareRef) => void;
}) {
  const sorted = [...market.outcomes].sort((a, b) => b.probability - a.probability);
  const open = market.status === 'open';
  return (
    <Card className="overflow-hidden">
      <div className="grid grid-cols-[1fr_auto] gap-4 border-b border-line px-5 py-2.5 text-xs text-faint sm:grid-cols-[1fr_auto_auto]">
        <span>选项</span>
        <span className="w-16 text-right">概率</span>
        <span className="hidden w-48 sm:block" />
      </div>
      {sorted.map((o) => {
        const c = outcomeColor(o.index, false);
        const [yes, no] = sharePair(market, o.id);
        const ask = (s: ShareRef) => bookOf(data, s)?.asks[0]?.price;
        return (
          <div
            key={o.id}
            className={clsx(
              'relative grid grid-cols-[1fr_auto] items-center gap-x-4 gap-y-2 border-b border-line px-5 py-3 last:border-0 sm:grid-cols-[1fr_auto_auto]',
              selected === o.id ? 'bg-fill' : 'hover:bg-raised',
            )}
          >
            <button type="button" onClick={() => onPick(yes)} className="flex min-w-0 items-center gap-3 text-left">
              <span className="h-8 w-1 shrink-0 rounded-full" style={{ background: c }} />
              <span className="truncate font-medium">{o.label}</span>
              {market.resolvedOutcomeId === o.id && <Crown className="size-4 shrink-0 text-gold" />}
              {o.change24h !== null && Math.abs(o.change24h) >= 0.005 && (
                <span className={clsx('shrink-0 font-mono text-xs', o.change24h > 0 ? 'text-yes' : 'text-no')}>
                  {o.change24h > 0 ? '▲' : '▼'}
                  {Math.abs(Math.round(o.change24h * 100))}
                </span>
              )}
            </button>
            <span className="w-16 text-right font-mono text-xl font-semibold">{formatPct(o.probability)}</span>
            {open && (
              <div className="col-span-2 grid grid-cols-2 gap-2 sm:col-span-1 sm:w-48">
                {[yes, no].map((s, i) => (
                  <button
                    key={s.token}
                    type="button"
                    onClick={() => onPick(s)}
                    className={clsx(
                      'flex h-8 items-center justify-between rounded px-2.5 text-xs font-semibold transition-colors',
                      i === 0
                        ? 'bg-yes/8 text-yes hover:bg-yes hover:text-white'
                        : 'bg-no/8 text-no hover:bg-no hover:text-white',
                    )}
                  >
                    <span>买 {i === 0 ? 'Yes' : 'No'}</span>
                    <span className="font-mono">{formatPrice(ask(s))}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </Card>
  );
}

/** The biggest holders of each side; in multi-outcome markets, of the selected option. */
export function ExchangeHolders({ market, outcomeId }: { market: MarketDetail; outcomeId: number }) {
  const { data } = useQuery({
    queryKey: ['exchangeHolders', market.id],
    queryFn: () => api.exchangeHolders(market.id),
  });
  if (!data) return <Spinner />;
  const shares = sharePair(market, isMultiExchange(market) ? outcomeId : market.outcomes[0]!.id);
  const groups = shares.map((s) => ({
    share: s,
    holders: data.filter((h) => h.outcomeId === s.outcomeId && h.token === s.token),
  }));
  if (groups.every((g) => g.holders.length === 0)) return <Empty title="还没有人持有份额" />;
  return (
    <div className="grid gap-6 sm:grid-cols-2">
      {groups.map(({ share, holders }, i) => (
        <div key={`${share.outcomeId}:${share.token}`}>
          <div className={clsx('mb-2 text-sm font-semibold', i === 0 ? 'text-yes' : 'text-no')}>
            持有「{shareName(market, share)}」
          </div>
          {holders.length === 0 && <p className="px-2 text-xs text-faint">暂无</p>}
          <ul className="space-y-1">
            {holders.map((h) => (
              <li key={h.user.id}>
                <Link
                  to={`/u/${h.user.id}`}
                  className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-sm hover:bg-raised"
                >
                  <Avatar id={h.user.id} name={h.user.displayName} size={24} />
                  <span className="flex-1 truncate">{h.user.displayName}</span>
                  <span className="font-mono text-xs text-dim">
                    {h.quantity} 份 · 均价 {formatPrice(h.avgPrice)}
                  </span>
                </Link>
              </li>
            ))}
          </ul>
        </div>
      ))}
    </div>
  );
}

/** Who bought and sold what, newest first. */
export function ExchangeActivityList({ market }: { market: MarketDetail }) {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } = useInfiniteQuery({
    queryKey: ['exchangeActivity', market.id],
    queryFn: ({ pageParam }) => api.exchangeActivity(market.id, pageParam),
    initialPageParam: undefined as number | undefined,
    // A page holds both sides of up to 50 trades.
    getNextPageParam: (last) => (last.length >= 100 ? last.at(-1)!.tradeId : undefined),
  });
  if (isPending) return <Spinner />;
  const rows = data?.pages.flat() ?? [];
  if (rows.length === 0) return <Empty title="还没有成交" />;
  return (
    <div>
      <ul className="divide-y divide-line">
        {rows.map((a) => (
          <li
            key={`${a.tradeId}:${a.user.id}:${a.side}:${a.outcomeId}:${a.token}`}
            className="flex items-center gap-3 py-2.5 text-sm"
          >
            <Avatar id={a.user.id} name={a.user.displayName} size={24} />
            <span className="min-w-0 flex-1">
              <Link to={`/u/${a.user.id}`} className="font-medium hover:text-brand">
                {a.user.displayName}
              </Link>{' '}
              <span className={a.side === 'buy' ? 'text-yes' : 'text-no'}>{a.side === 'buy' ? '买入' : '卖出'}</span>{' '}
              {a.quantity} 份 {shareName(market, a)}
              <span className="text-dim"> @ {a.price.toFixed(2)}</span>
            </span>
            <span className="shrink-0 text-right text-xs text-faint">
              <span className="block font-mono text-dim">{formatMoney(a.price * a.quantity)}</span>
              {formatRelative(a.createdAt)}
            </span>
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          loading={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          加载更多
        </Button>
      )}
    </div>
  );
}
