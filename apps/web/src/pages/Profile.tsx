import { useQuery } from '@tanstack/react-query';
import { CalendarDays } from 'lucide-react';
import { useState } from 'react';
import { Link, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { MarketCard } from '../components/MarketCard';
import { Money } from '../components/Money';
import { BetsTable } from '../components/BetsTable';
import { Card, Empty, PageLoader, Segmented, Stat } from '../components/ui';
import { api } from '../lib/api';
import { formatDay, formatRelative } from '../lib/format';
import { usePageTitle } from '../lib/site';

export default function Profile() {
  const id = Number(useParams().id);
  const [tab, setTab] = useState<'bets' | 'history' | 'markets'>('bets');
  const { data, error } = useQuery({ queryKey: ['user', id], queryFn: () => api.user(id) });
  usePageTitle(data ? `${data.user.displayName}的主页` : null);
  if (error) return <Empty title="用户不存在" />;
  if (!data) return <PageLoader />;
  const { user, stats, rank, bets, recentBets, createdMarkets } = data;

  return (
    <div>
      <Card className="relative overflow-hidden p-6 sm:p-8">
        <div className="relative flex flex-wrap items-center gap-5">
          <div className="rounded-full bg-brand p-[5px]">
            <Avatar id={user.id} name={user.displayName} size={84} className="ring-[3px] ring-panel" />
          </div>
          <div className="min-w-0 flex-1">
            <h1 className="flex items-center gap-2 section-title">{user.displayName}</h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-dim">
              <span>@{user.username}</span>
              <span className="inline-flex items-center gap-1">
                <CalendarDays className="size-4" /> {formatDay(user.createdAt)} 加入
              </span>
            </div>
          </div>
          {rank === null ? (
            <span className="rounded bg-brand-light px-2.5 py-1 text-sm text-brand">AI 机器人 · 只在 AI 专区下注</span>
          ) : (
            <div className="text-right">
              <div className="text-xs text-faint">排名</div>
              <div className="font-mono text-5xl font-bold text-brand">#{rank}</div>
            </div>
          )}
        </div>
      </Card>

      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="入账净值">
          <Money value={stats.netWorth} />
        </Stat>
        <Stat label="已结算盈亏">
          <span className={stats.profit >= 0 ? 'text-yes' : 'text-no'}>
            <Money value={stats.profit} signed />
          </span>
        </Stat>
        <Stat label="下注次数">{stats.betCount}</Stat>
        <Stat label="参与市场">{stats.marketsBet}</Stat>
      </div>
      <p className="mt-3 text-xs text-faint">净值和排名只计入已结算市场的盈亏，未结算交易暂不计入。</p>

      <Card className="mt-6 p-5">
        <Segmented
          variant="tabs"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'bets', label: '下注' },
            { value: 'history', label: '下注记录' },
            { value: 'markets', label: `发起的市场 ${createdMarkets.length || ''}` },
          ]}
        />
        <div className="mt-4">
          {tab === 'bets' && <BetsTable bets={bets} empty="暂无下注" />}
          {tab === 'history' &&
            (recentBets.length === 0 ? (
              <Empty title="还没有下注" />
            ) : (
              <ul className="divide-y divide-line">
                {recentBets.map((b) => (
                  <li key={b.id} className="flex items-center gap-3 py-3 text-sm">
                    <span className="rounded-md bg-brand-light px-2 py-0.5 text-xs font-semibold text-brand">押</span>
                    <div className="min-w-0 flex-1">
                      <Link to={`/market/${b.marketId}`} className="line-clamp-1 hover:underline">
                        {b.marketQuestion}
                      </Link>
                      <div className="text-xs text-faint">
                        「{b.outcomeLabel}」 · {formatRelative(b.createdAt)}
                      </div>
                    </div>
                    <Money value={b.amount} className="font-mono" />
                  </li>
                ))}
              </ul>
            ))}
          {tab === 'markets' &&
            (createdMarkets.length === 0 ? (
              <Empty title="还没有发起过市场" />
            ) : (
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {createdMarkets.map((m) => (
                  <MarketCard key={m.id} market={m} />
                ))}
              </div>
            ))}
        </div>
      </Card>
    </div>
  );
}
