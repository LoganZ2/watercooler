import { useQuery } from '@tanstack/react-query';
import clsx from 'clsx';
import { Crown, Medal, Trophy } from 'lucide-react';
import { useState } from 'react';
import { Link } from 'react-router';
import { Avatar } from '../components/Avatar';
import { Money } from '../components/Money';
import { Card, PageLoader, Segmented } from '../components/ui';
import { api, type LeaderboardSort } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatSigned } from '../lib/format';
import { COPY, usePageTitle } from '../lib/site';

/** Podium order on screen is 2nd, 1st, 3rd. */
const PODIUM = [
  { place: 2, ring: '#c9cdd4', text: '#86909c', icon: Medal, h: 'sm:mt-8' },
  { place: 1, ring: '#f7ba1e', text: '#e09600', icon: Crown, h: '' },
  { place: 3, ring: '#e6965a', text: '#d0763a', icon: Medal, h: 'sm:mt-12' },
];

export default function Leaderboard() {
  usePageTitle('预言家排行榜');
  const { me } = useMe();
  const [sort, setSort] = useState<LeaderboardSort>('profit');
  const { data } = useQuery({ queryKey: ['leaderboard', sort], queryFn: () => api.leaderboard(sort) });
  if (!data) return <PageLoader />;
  const metric = (e: (typeof data)[number]) =>
    sort === 'profit' ? (
      <span className={e.stats.profit >= 0 ? 'text-yes' : 'text-no'}>{formatSigned(e.stats.profit)}</span>
    ) : sort === 'netWorth' ? (
      <Money value={e.stats.netWorth} />
    ) : (
      <span>{e.stats.betCount} 笔</span>
    );
  const top = data.slice(0, 3);
  // Display order: 2nd, 1st, 3rd
  const podium = [top[1], top[0], top[2]];

  return (
    <div className="mx-auto max-w-4xl">
      <div className="text-center">
        <h1 className="section-title inline-flex items-center gap-2">
          <Trophy className="size-7 text-brand" /> 预言家排行榜
        </h1>
        <p className="mt-3 text-dim">{COPY.leaderboardSubtitle}</p>
      </div>
      <Segmented
        variant="tabs"
        underline={false}
        className="mt-8 justify-center gap-14"
        value={sort}
        onChange={setSort}
        options={[
          { value: 'profit', label: '已结算盈利' },
          { value: 'netWorth', label: '入账净值' },
          { value: 'bets', label: '下注次数' },
        ]}
      />
      <p className="mt-3 text-center text-xs text-faint">
        盈利只统计已结算市场的净收支；入账净值 = 注册及签到奖励 + 已结算盈利。未结算交易暂不计入。
      </p>

      <div className="mt-10 grid grid-cols-3 items-start gap-3 sm:gap-6">
        {podium.map((e, i) => {
          const slot = PODIUM[i]!;
          const Icon = slot.icon;
          return e ? (
            <Link key={e.user.id} to={`/u/${e.user.id}`} className={clsx('group', slot.h)}>
              <Card className="card-hover flex flex-col items-center px-2 py-7 text-center">
                <div className="rounded-full p-[5px]" style={{ background: slot.ring }}>
                  <Avatar
                    id={e.user.id}
                    name={e.user.displayName}
                    size={slot.place === 1 ? 76 : 60}
                    className="ring-[3px] ring-panel"
                  />
                </div>
                <div className="mt-3 flex items-center gap-1 text-sm" style={{ color: slot.text }}>
                  <Icon className="size-4" />
                  <span className="font-mono font-bold">No.{slot.place}</span>
                </div>
                <div className="mt-1 max-w-full truncate font-semibold group-hover:text-brand">
                  {e.user.displayName}
                </div>
                <div className="mt-1 font-mono text-sm sm:text-base">{metric(e)}</div>
              </Card>
            </Link>
          ) : (
            <div key={i} />
          );
        })}
      </div>

      <Card className="mt-8 overflow-hidden">
        {data.slice(3).map((e) => (
          <Link
            key={e.user.id}
            to={`/u/${e.user.id}`}
            className={clsx(
              'flex items-center gap-4 border-b border-line px-5 py-3.5 transition last:border-0 hover:bg-raised',
              e.user.id === me?.id && 'bg-brand-light',
            )}
          >
            <span className="w-6 text-center font-mono font-semibold text-faint">{e.rank}</span>
            <Avatar id={e.user.id} name={e.user.displayName} size={34} />
            <div className="min-w-0 flex-1">
              <div className="truncate">
                {e.user.displayName} {e.user.id === me?.id && <span className="text-xs text-brand">（你）</span>}
              </div>
              <div className="text-xs text-faint">
                {e.stats.betCount} 笔下注 · {e.stats.marketsBet} 个市场
              </div>
            </div>
            <div className="text-right font-mono">{metric(e)}</div>
          </Link>
        ))}
        {data.length <= 3 && <div className="py-8 text-center text-sm text-faint">{COPY.inviteMore}</div>}
      </Card>
    </div>
  );
}
