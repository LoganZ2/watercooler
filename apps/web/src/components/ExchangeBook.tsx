import type { BookLevel, ExchangeState, MarketDetail, OrderInput } from '@watercooler/shared';
import clsx from 'clsx';
import { errorMessage } from '../lib/api';
import { bookOf, isMultiExchange, sameShare, shareName, sharePair, type ShareRef } from '../lib/exchange';
import { formatMoney } from '../lib/format';
import { Card, Segmented, Spinner } from './ui';

const LEVELS = 8;

/**
 * Polymarket-style ladder for one share: asks above (best nearest the middle), bids below.
 * Complementary orders are already folded in by the server.
 */
export function ExchangeBook({
  market,
  data,
  error,
  share,
  onShareChange,
  onQuoteSelect,
}: {
  market: MarketDetail;
  data: ExchangeState | undefined;
  error: Error | null;
  share: ShareRef;
  onShareChange: (share: ShareRef) => void;
  onQuoteSelect: (side: OrderInput['side'], price: string) => void;
}) {
  if (error)
    return (
      <Card className="p-5">
        <p className="text-no">{errorMessage(error)}</p>
      </Card>
    );
  if (!data)
    return (
      <Card className="p-5">
        <Spinner />
      </Card>
    );
  const book = bookOf(data, share);
  if (!book) return null;
  const open = market.status === 'open';
  const multi = isMultiExchange(market);
  const pair = sharePair(market, share.outcomeId);
  const asks = book.asks.slice(0, LEVELS);
  const bids = book.bids.slice(0, LEVELS);
  const spread = book.asks[0] && book.bids[0] ? book.asks[0].price - book.bids[0].price : null;

  const rows = (levels: BookLevel[], isAsk: boolean) => {
    // Cumulative cost from the best price outward, like Polymarket's "Total" column.
    let running = 0;
    const totals = levels.map((l) => (running += l.price * l.quantity));
    const max = Math.max(...levels.map((l) => l.quantity), 1);
    const ordered = levels.map((l, i) => ({ ...l, total: totals[i]! }));
    return (isAsk ? ordered.reverse() : ordered).map((r) => (
      <button
        key={r.price}
        type="button"
        disabled={!open}
        onClick={() => onQuoteSelect(isAsk ? 'buy' : 'sell', r.price.toFixed(2))}
        className="relative grid w-full grid-cols-3 px-2 py-1 font-mono text-sm hover:bg-fill disabled:pointer-events-none"
        aria-label={`${isAsk ? '卖单' : '买单'} ${r.price.toFixed(2)}，${r.quantity} 份`}
      >
        <span
          className={clsx('absolute inset-y-0.5 left-0 rounded-sm opacity-15', isAsk ? 'bg-no' : 'bg-yes')}
          style={{ width: `${(r.quantity / max) * 100}%` }}
        />
        <span className={clsx('relative text-left', isAsk ? 'text-no' : 'text-yes')}>{r.price.toFixed(2)}</span>
        <span className="relative text-right">{r.quantity}</span>
        <span className="relative text-right text-dim">{formatMoney(r.total)}</span>
      </button>
    ));
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="font-semibold">
            订单簿{multi && ` · ${market.outcomes.find((o) => o.id === share.outcomeId)?.label}`}
          </h2>
          <p className="mt-1 text-xs text-faint">抵押资金 {formatMoney(data.collateral)} 水滴 · 获胜每份兑回 1</p>
        </div>
        <Segmented
          size="sm"
          value={pair.findIndex((s) => sameShare(s, share)) === 1 ? '1' : '0'}
          onChange={(i) => onShareChange(pair[Number(i)]!)}
          options={pair.map((s, i) => ({
            value: String(i),
            label: multi ? `交易 ${s.token === 'no' ? 'No' : 'Yes'}` : shareName(market, s),
          }))}
        />
      </div>
      <div className="rounded bg-raised py-2">
        <div className="grid grid-cols-3 px-2 pb-1 text-xs text-faint">
          <span>价格</span>
          <span className="text-right">份数</span>
          <span className="text-right">累计（水滴）</span>
        </div>
        {asks.length ? rows(asks, true) : <p className="px-2 py-3 text-xs text-faint">暂无卖单</p>}
        <div className="my-1 flex justify-between border-y border-line px-2 py-1.5 text-xs text-dim">
          <span>价差 {spread === null ? '—' : spread.toFixed(2)}</span>
          <span>最新成交 {book.lastPrice === null ? '—' : book.lastPrice.toFixed(2)}</span>
        </div>
        {bids.length ? rows(bids, false) : <p className="px-2 py-3 text-xs text-faint">暂无买单</p>}
      </div>
      <p className="text-xs leading-relaxed text-faint">
        盘口已合并互补挂单：买 No @0.40 就是卖 Yes
        @0.60，两边会直接撮合。点价格可填入限价单；与自己挂单交叉的新单会被拒绝。
      </p>
    </Card>
  );
}
