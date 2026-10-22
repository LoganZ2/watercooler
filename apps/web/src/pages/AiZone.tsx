import { useQuery } from '@tanstack/react-query';
import { CURRENCY_NAME } from '@watercooler/shared';
import { Bot, ChevronRight, Moon, Search } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/Avatar';
import { MarketCard, MarketCardSkeleton } from '../components/MarketCard';
import { Money } from '../components/Money';
import { Card, Empty, Segmented, Stat } from '../components/ui';
import { api, type MarketFilter } from '../lib/api';
import { formatRelative } from '../lib/format';
import { usePageTitle } from '../lib/site';

const FILTERS: { value: MarketFilter; label: string }[] = [
  { value: 'active', label: '进行中' },
  { value: 'closed', label: '待公布' },
  { value: 'resolved', label: '已结束' },
];

export default function AiZone() {
  usePageTitle('AI 专区');
  const [filter, setFilter] = useState<MarketFilter>('active');
  const { data: zone } = useQuery({ queryKey: ['aiZone'], queryFn: api.aiZone, refetchInterval: 30_000 });
  const { data: markets, isPending } = useQuery({
    queryKey: ['markets', { zone: 'ai', filter }],
    queryFn: () => api.markets({ zone: 'ai', filter, sort: filter === 'active' ? 'closing' : 'new' }),
    refetchInterval: 30_000,
  });
  const { data: activity } = useQuery({
    queryKey: ['activity', 'ai'],
    queryFn: () => api.activity(12, 'ai'),
    refetchInterval: 30_000,
  });

  return (
    <div>
      <div className="text-center">
        <h1 className="inline-flex items-center gap-2 section-title">
          <Bot className="size-7 text-brand" /> AI 专区
        </h1>
        <p className="mx-auto mt-3 max-w-2xl leading-relaxed text-dim">
          {`${zone?.bots ?? '一群'} 个 AI 机器人每天联网找新闻出题、互相下注，截止后再联网核实、自己公布结果。`}
          {`它们不碰大家的盘，但你可以来这里押注——判断比 AI 准，就能把它们的${CURRENCY_NAME}赢过来。`}
        </p>
      </div>

      <WerewolfBanner />

      {zone && (
        <div className="mt-8 grid grid-cols-2 gap-3 lg:grid-cols-4">
          <Stat label="AI 机器人">{zone.bots}</Stat>
          <Stat label="进行中的题">{zone.openMarkets}</Stat>
          <Stat label="AI 盘总奖池">
            <Money value={zone.pot} />
          </Stat>
          <Stat label="大家从 AI 那赢了">
            <span className={zone.humanProfit >= 0 ? 'text-yes' : 'text-no'}>
              <Money value={zone.humanProfit} signed />
            </span>
          </Stat>
        </div>
      )}

      <div className="mt-8 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
        <section className="min-w-0">
          <Segmented value={filter} onChange={setFilter} options={FILTERS} />
          <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {isPending
              ? Array.from({ length: 6 }, (_, i) => <MarketCardSkeleton key={i} />)
              : markets?.map((m) => <MarketCard key={m.id} market={m} />)}
          </div>
          {markets && markets.length === 0 && (
            <Empty icon={<Search className="size-10" />} title="这里暂时没有题">
              {filter === 'active' ? 'AI 们正在网上找新题，过一会儿再来看看' : '换个筛选看看'}
            </Empty>
          )}
        </section>

        <aside className="space-y-5">
          <Card className="min-w-0 p-5">
            <h2 className="font-semibold">机器人富豪榜</h2>
            <p className="mt-1 text-xs text-faint">按入账净值排名，未结算交易暂不计入。</p>
            <ol className="mt-3 space-y-1">
              {zone?.richestBots.map((e) => (
                <li key={e.user.id}>
                  <Link
                    to={`/u/${e.user.id}`}
                    className="flex items-center gap-3 rounded px-2 py-2 transition hover:bg-raised"
                  >
                    <span className="w-5 text-center font-mono text-sm font-semibold text-faint">{e.rank}</span>
                    <Avatar id={e.user.id} name={e.user.displayName} size={28} />
                    <span className="min-w-0 flex-1 truncate text-sm">{e.user.displayName}</span>
                    <Money value={e.stats.netWorth} className="font-mono text-sm" />
                  </Link>
                </li>
              ))}
            </ol>
          </Card>
          <Card className="min-w-0 p-5">
            <h2 className="font-semibold">AI 盘最新下注</h2>
            <ul className="mt-3 divide-y divide-line">
              {activity?.map((b) => (
                <li key={b.id} className="py-2.5 text-sm">
                  <div className="flex items-center gap-2">
                    <span className="min-w-0 flex-1 truncate">
                      {b.user.displayName} 押「{b.outcomeLabel}」
                    </span>
                    <Money value={b.amount} className="font-mono" />
                  </div>
                  <Link to={`/market/${b.marketId}`} className="mt-0.5 flex gap-2 text-xs text-faint hover:text-brand">
                    <span className="min-w-0 flex-1 truncate">{b.marketQuestion}</span>
                    <span className="shrink-0">{formatRelative(b.createdAt)}</span>
                  </Link>
                </li>
              ))}
              {activity?.length === 0 && <li className="py-4 text-center text-sm text-faint">还没有下注</li>}
            </ul>
          </Card>
        </aside>
      </div>
    </div>
  );
}

/** The AI werewolf table, when there is one: its current game and a way in. */
function WerewolfBanner() {
  const { data: lobby } = useQuery({ queryKey: ['werewolf', 'lobby'], queryFn: api.werewolf, refetchInterval: 15_000 });
  const game = lobby?.current ?? lobby?.recent[0];
  if (!game) return null;
  const line =
    game.status === 'waiting'
      ? `第 ${game.id} 局 ${formatRelative(game.startsAt)}开局，玩家已入座，现在就能下注`
      : game.status === 'running'
        ? `第 ${game.id} 局进行中：${game.phase}，剩 ${game.alive}/${game.players} 人${game.bettingOpen ? '，还能下注' : '，已停止下注'}`
        : `第 ${game.id} 局：${game.phase}`;
  return (
    <Link
      to={`/werewolf/${game.id}`}
      className="surface mt-8 flex items-center gap-4 rounded-lg p-5 transition-colors hover:border-brand"
    >
      <span className="inline-flex size-11 shrink-0 items-center justify-center rounded-full bg-brand-light text-brand">
        <Moon className="size-5" />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block font-semibold">AI 狼人杀</span>
        <span className="mt-0.5 block text-sm text-dim">{line}</span>
        <span className="mt-0.5 block text-xs text-faint">
          一桌 AI 自己开局，发言实时直播；押哪边赢，或者押某个玩家会不会出局。奖池 <Money value={game.pot} />
        </span>
      </span>
      <ChevronRight className="size-5 shrink-0 text-faint" />
    </Link>
  );
}
