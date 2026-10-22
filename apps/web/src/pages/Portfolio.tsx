import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { LedgerKind } from '@watercooler/shared';
import clsx from 'clsx';
import { useState } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { Money } from '../components/Money';
import { BetsTable } from '../components/BetsTable';
import { Button, Card, PageLoader, Segmented, Stat } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { formatDate, formatMoney, formatSigned } from '../lib/format';

const LEDGER_LABEL: Record<LedgerKind, string> = {
  signup: '注册奖励',
  bonus: '每日签到',
  bet: '下注',
  payout: '押中奖金',
  refund: '退款',
  split: '抵押生成 Yes + No',
  merge: '合并赎回',
  order_lock: '买单冻结资金',
  order_release: '订单解冻 / 价差退回',
  sell: '卖出份额',
  grant: '管理员调整',
};

function Ledger() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage } = useInfiniteQuery({
    queryKey: ['ledger'],
    queryFn: ({ pageParam }) => api.ledger(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 50 ? last[last.length - 1]!.id : undefined),
  });
  const rows = data?.pages.flat() ?? [];
  return (
    <div>
      <ul className="divide-y divide-line">
        {rows.map((l) => (
          <li key={l.id} className="flex items-center gap-4 py-3 text-sm">
            <div className="min-w-0 flex-1">
              <div className="font-medium">{LEDGER_LABEL[l.kind]}</div>
              <div className="truncate text-xs text-faint">
                {l.marketId ? (
                  <Link to={`/market/${l.marketId}`} className="hover:text-dim">
                    {l.marketQuestion}
                  </Link>
                ) : (
                  l.note
                )}
              </div>
            </div>
            <div className="text-right">
              <div className={clsx('font-mono tabular', l.amount >= 0 ? 'text-yes' : 'text-no')}>
                {formatSigned(l.amount)}
              </div>
              <div className="text-xs text-faint">{formatDate(l.createdAt)}</div>
            </div>
          </li>
        ))}
      </ul>
      {hasNextPage && (
        <div className="mt-4 text-center">
          <Button variant="outline" size="sm" loading={isFetchingNextPage} onClick={() => fetchNextPage()}>
            加载更多
          </Button>
        </div>
      )}
    </div>
  );
}

export default function PortfolioPage() {
  const [tab, setTab] = useState<'active' | 'closed' | 'ledger'>('active');
  const qc = useQueryClient();
  const cancel = useMutation({
    mutationFn: ({ marketId, orderId }: { marketId: number; orderId: number }) => api.cancelOrder(marketId, orderId),
    onSuccess: () => {
      toast.success('订单已撤销，剩余冻结资产已释放');
      void qc.invalidateQueries();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void qc.invalidateQueries();
    },
  });
  const { data } = useQuery({ queryKey: ['portfolio'], queryFn: api.portfolio, refetchInterval: 15_000 });
  if (!data) return <PageLoader />;
  const { stats, bets } = data;
  const active = bets.filter((b) => b.state === 'active');
  const closed = bets.filter((b) => b.state !== 'active');

  return (
    <div>
      <h1 className="section-title">我的下注</h1>
      <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="入账净值">
          <Money value={stats.netWorth} />
        </Stat>
        <Stat label="可用余额">
          <Money value={stats.balance} />
        </Stat>
        <Stat label="未结算净投入">
          <Money value={stats.staked} />
        </Stat>
        <Stat label="已结算盈亏">
          <span className={stats.profit >= 0 ? 'text-yes' : 'text-no'}>
            <Money value={stats.profit} signed />
          </span>
        </Stat>
      </div>
      <p className="mt-3 text-xs text-faint">
        入账净值 = 注册及签到奖励 +
        已结算盈亏。未结算净投入含冻结资金，回款超过投入时可为负；交易盈亏等市场最终结算后计入排名。
      </p>
      {data.exchangeOrders.length > 0 && (
        <Card className="mt-6 p-5">
          <h2 className="font-semibold">Polymarket 未成交订单</h2>
          <ul className="mt-3 divide-y divide-line">
            {data.exchangeOrders.map((o) => (
              <li key={o.id} className="flex items-center justify-between gap-3 py-3 text-sm">
                <div className="min-w-0">
                  <Link to={`/market/${o.marketId}`} className="text-brand">
                    {o.question}
                  </Link>
                  <p className="mt-1 text-xs text-dim">
                    #{o.id} {o.side === 'buy' ? '买' : '卖'} {o.outcomeLabel} @ {o.price.toFixed(2)} · 剩余{' '}
                    {o.remaining} 份 ·{' '}
                    {o.side === 'buy' ? `冻结 ${(o.price * o.remaining).toFixed(2)} 水滴` : `冻结 ${o.remaining} 份`}
                    {o.expiresAt !== null && ` · ${formatDate(o.expiresAt)} 到期`}
                  </p>
                </div>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="shrink-0"
                  disabled={cancel.isPending}
                  loading={cancel.isPending && cancel.variables?.orderId === o.id}
                  aria-label={`撤销订单 #${o.id}`}
                  onClick={() => cancel.mutate({ marketId: o.marketId, orderId: o.id })}
                >
                  撤单
                </Button>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {data.exchangePositions.length > 0 && (
        <Card className="mt-6 p-5">
          <h2 className="font-semibold">Polymarket 持仓</h2>
          <p className="mt-1 text-xs text-faint">
            估值按当前显示价格计算，只供参考，不计入净值和排行；已结算的份额按 1 / 0 兑付，见资金流水。
          </p>
          <div className="mt-3 overflow-x-auto">
            <table className="w-full min-w-[560px] text-sm">
              <thead className="text-left text-xs text-faint">
                <tr>
                  <th className="py-2 font-normal">市场 · 份额</th>
                  <th className="py-2 text-right font-normal">份数</th>
                  <th className="py-2 text-right font-normal">均价</th>
                  <th className="py-2 text-right font-normal">现价</th>
                  <th className="py-2 text-right font-normal">估值</th>
                  <th className="py-2 text-right font-normal">盈亏</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {data.exchangePositions.map((p) => (
                  <tr key={`${p.outcomeId}:${p.token}`}>
                    <td className="max-w-64 py-3 pr-3">
                      <Link to={`/market/${p.marketId}`} className="block truncate text-brand">
                        {p.question}
                      </Link>
                      <span className="text-xs text-dim">
                        {p.outcomeLabel}
                        {p.status === 'resolved' && ' · 已结算'}
                        {p.reserved > 0 && ` · 挂卖 ${p.reserved}`}
                      </span>
                    </td>
                    <td className="py-3 text-right font-mono">{p.quantity}</td>
                    <td className="py-3 text-right font-mono">{p.avgPrice?.toFixed(2) ?? '—'}</td>
                    <td className="py-3 text-right font-mono">{p.price.toFixed(2)}</td>
                    <td className="py-3 text-right font-mono">{formatMoney(p.value)}</td>
                    <td className={clsx('py-3 text-right font-mono', p.pnl >= 0 ? 'text-yes' : 'text-no')}>
                      {formatSigned(p.pnl)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}
      <Card className="mt-6 p-5">
        <Segmented
          variant="tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'active', label: `等待结果 ${active.length || ''}` },
            { value: 'closed', label: '已结束' },
            { value: 'ledger', label: '资金流水' },
          ]}
        />
        <div className="mt-4">
          {tab === 'active' && <BetsTable bets={active} empty="还没有下注，去市场里看看吧" />}
          {tab === 'closed' && <BetsTable bets={closed} empty="还没有已结束的下注" />}
          {tab === 'ledger' && <Ledger />}
        </div>
      </Card>
    </div>
  );
}
