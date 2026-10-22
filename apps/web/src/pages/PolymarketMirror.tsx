import { useQuery } from '@tanstack/react-query';
import { CURRENCY_NAME } from '@watercooler/shared';
import { Globe, Search } from 'lucide-react';
import { useState } from 'react';
import { MarketCard, MarketCardSkeleton } from '../components/MarketCard';
import { Empty, Segmented } from '../components/ui';
import { api, type MarketFilter } from '../lib/api';
import { useConfig } from '../lib/auth';
import { usePageTitle } from '../lib/site';

const FILTERS: { value: MarketFilter; label: string }[] = [
  { value: 'active', label: '正在交易' },
  { value: 'closed', label: '等结果' },
  { value: 'resolved', label: '已结算' },
];

/** polymarket.com's busiest markets, copied here to trade with 水滴 at Polymarket's prices. */
export default function PolymarketMirror() {
  usePageTitle('Polymarket 热门');
  const config = useConfig();
  const [filter, setFilter] = useState<MarketFilter>('active');
  const { data: markets, isPending } = useQuery({
    queryKey: ['markets', { zone: 'mimic', filter }],
    queryFn: () => api.markets({ zone: 'mimic', filter, sort: filter === 'active' ? 'trending' : 'new', limit: 100 }),
    refetchInterval: 60_000,
  });

  return (
    <div>
      <div className="text-center">
        <h1 className="inline-flex items-center gap-2 section-title">
          <Globe className="size-7 text-brand" /> Polymarket 热门
        </h1>
        <p className="mx-auto mt-3 max-w-2xl leading-relaxed text-dim">
          {`polymarket.com 上现在最热门的盘，每 5 分钟同步一次。用${CURRENCY_NAME}按 Polymarket 的实时盘口买卖 Yes / No，`}
          {`你的买卖只影响自己的输赢，不会改变 Polymarket 的价格；结果出来后按 Polymarket 的结果结算，每份获胜兑回 1 ${CURRENCY_NAME}。`}
        </p>
      </div>

      {config && !config.mimic && (
        <Empty icon={<Globe className="size-10" />} title="管理员没有打开 Polymarket 镜像盘">
          已经持有的份额照常按 Polymarket 的结果结算
        </Empty>
      )}

      <section className="mt-8">
        <Segmented value={filter} onChange={setFilter} options={FILTERS} />
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {isPending
            ? Array.from({ length: 6 }, (_, i) => <MarketCardSkeleton key={i} />)
            : markets?.map((m) => <MarketCard key={m.id} market={m} />)}
        </div>
        {markets && markets.length === 0 && (
          <Empty icon={<Search className="size-10" />} title="这里暂时没有盘">
            {filter === 'active' ? '第一次同步要等几分钟' : '换个筛选看看'}
          </Empty>
        )}
      </section>
    </div>
  );
}
