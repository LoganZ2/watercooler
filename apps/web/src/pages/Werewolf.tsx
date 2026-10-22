import { useQuery } from '@tanstack/react-query';
import type {
  MarketSummary,
  WerewolfEvent,
  WerewolfGame,
  WerewolfGameSummary,
  WerewolfLobby,
  WerewolfRole,
  WerewolfSeat,
} from '@watercooler/shared';
import clsx from 'clsx';
import { Brain, ChevronLeft, Crown, Hourglass, Lock, Moon, Sun, Swords } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Avatar } from '../components/Avatar';
import { BetPanel } from '../components/BetPanel';
import { Money } from '../components/Money';
import { Badge, Card, Empty, PageLoader, Spinner } from '../components/ui';
import { api } from '../lib/api';
import { outcomeColor } from '../lib/colors';
import { formatPct, formatRelative } from '../lib/format';
import { usePageTitle } from '../lib/site';

const ROLE_NAME: Record<WerewolfRole, string> = {
  wolf: '狼人',
  seer: '预言家',
  witch: '女巫',
  hunter: '猎人',
  villager: '平民',
};

const over = (g: Pick<WerewolfGameSummary, 'status'>) => g.status === 'ended' || g.status === 'aborted';

/** The AI werewolf table: the game being played (or a past one), its live log and its bets. */
export default function WerewolfPage() {
  const { id } = useParams();
  const lobby = useQuery({ queryKey: ['werewolf', 'lobby'], queryFn: api.werewolf, refetchInterval: 10_000 });
  const gameId = id ? Number(id) : (lobby.data?.current?.id ?? lobby.data?.recent[0]?.id);
  usePageTitle(gameId ? `AI 狼人杀第 ${gameId} 局` : 'AI 狼人杀');

  if (!gameId) {
    if (lobby.isPending) return <PageLoader />;
    return (
      <Empty icon={<Moon className="size-10" />} title="还没有对局">
        {lobby.data?.enabled ? '第一局正在发牌，过一会儿再来' : '管理员还没有打开 AI 狼人杀'}
      </Empty>
    );
  }
  return <Game key={gameId} id={gameId} lobby={lobby.data} />;
}

function useNow(ms: number): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

const clock = (t: number) => new Date(t).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });

function Game({ id, lobby }: { id: number; lobby?: WerewolfLobby }) {
  const { data: game, error } = useQuery({
    queryKey: ['werewolf', id],
    queryFn: () => api.werewolfGame(id),
    refetchInterval: (q) => (q.state.data && over(q.state.data) ? 60_000 : 4_000),
  });
  // What the bet ticket is on: the winning side by default, a seat once one is picked.
  const [pick, setPick] = useState<{ marketId: number; outcomeId: number } | null>(null);
  const marketId = pick?.marketId ?? game?.sideMarket.id;
  const ticket = useQuery({
    queryKey: ['market', marketId],
    queryFn: () => api.market(marketId!),
    enabled: marketId !== undefined,
    refetchInterval: 10_000,
  });

  if (error) return <Empty title="这局狼人杀不存在" />;
  if (!game) return <PageLoader />;

  const select = (m: MarketSummary, outcomeIndex = 0) =>
    setPick({ marketId: m.id, outcomeId: m.outcomes[outcomeIndex]!.id });
  const seatOf = (n: number | null) => game.seats.find((s) => s.seat === n);
  const picked = game.seatMarkets.find((m) => m.id === marketId);
  const pickedSeat = seatOf(picked?.werewolf?.seat ?? null);

  return (
    <div>
      <Link to="/ai" className="inline-flex items-center gap-1 text-sm text-dim hover:text-brand">
        <ChevronLeft className="size-4" /> AI 专区
      </Link>
      <div className="mt-3 flex flex-wrap items-end justify-between gap-3">
        <div className="min-w-0">
          <h1 className="flex items-center gap-2 text-2xl font-bold">
            <Moon className="size-6 shrink-0 text-brand" /> AI 狼人杀 · 第 {game.id} 局
          </h1>
          <div className="mt-2 flex flex-wrap gap-1.5">
            {game.roles.map((r) => (
              <Badge key={r.role} className={r.role === 'wolf' ? 'bg-no/10 text-no' : undefined}>
                {r.count > 1 ? `${r.count} ` : ''}
                {ROLE_NAME[r.role]}
              </Badge>
            ))}
          </div>
        </div>
        <div className="text-right text-sm text-dim">
          全局奖池 <Money value={game.pot} className="font-semibold text-fg" />
        </div>
      </div>

      <StatusBanner game={game} lobby={lobby} />

      <div className="mt-6 grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_340px]">
        <div className="min-w-0 space-y-6">
          <section>
            <h2 className="mb-3 font-semibold">座位</h2>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {game.seats.map((s) => (
                <SeatCard
                  key={s.seat}
                  seat={s}
                  market={game.seatMarkets.find((m) => m.id === s.marketId)}
                  selected={s.marketId === marketId}
                  onPick={select}
                />
              ))}
            </div>
          </section>
          <GameLog game={game} seatOf={seatOf} />
        </div>

        <aside className="space-y-5">
          <SideCard game={game} selected={marketId === game.sideMarket.id} onPick={select} />
          {ticket.data && ticket.data.market.id === marketId ? (
            <BetPanel
              market={ticket.data.market}
              stakes={ticket.data.stakes}
              outcomeId={pick?.outcomeId ?? ticket.data.market.outcomes[0]!.id}
              onOutcomeChange={(outcomeId) => setPick({ marketId: ticket.data.market.id, outcomeId })}
              heading={pickedSeat ? `${pickedSeat.seat} 号「${pickedSeat.name}」会出局吗？` : '押哪边赢'}
            />
          ) : (
            <Card className="p-5">
              <Spinner />
            </Card>
          )}
          {lobby && <PastGames lobby={lobby} current={game.id} />}
        </aside>
      </div>
    </div>
  );
}

function StatusBanner({ game, lobby }: { game: WerewolfGame; lobby?: WerewolfLobby }) {
  const now = useNow(1000);
  const next = lobby?.current && lobby.current.id !== game.id ? lobby.current : null;
  let icon = <Swords className="size-5 shrink-0 text-brand" />;
  let text: React.ReactNode;
  if (game.status === 'waiting') {
    const left = Math.max(0, game.startsAt - now);
    const mm = String(Math.floor(left / 60_000)).padStart(2, '0');
    const ss = String(Math.floor((left % 60_000) / 1000)).padStart(2, '0');
    icon = <Hourglass className="size-5 shrink-0 text-gold" />;
    text = (
      <>
        {clock(game.startsAt)} 开局，还有 <span className="font-mono font-semibold text-fg">{`${mm}:${ss}`}</span>。
        玩家已入座、身份保密，现在就可以下注；场上只剩 {game.cutoff} 人时停止下注。
      </>
    );
  } else if (game.status === 'running') {
    text = (
      <>
        <span className="font-semibold text-fg">{game.phase}</span>，场上还剩 {game.alive}/{game.players} 人。
        {game.bettingOpen ? `剩 ${game.cutoff} 人时停止下注。` : '已停止下注，游戏一结束就结算。'}
      </>
    );
  } else {
    icon =
      game.status === 'ended' ? (
        <Crown className="size-5 shrink-0 text-gold" />
      ) : (
        <Lock className="size-5 shrink-0 text-faint" />
      );
    text = (
      <>
        <span className="font-semibold text-fg">{game.phase}</span>
        {game.status === 'ended' ? '，所有下注已结算。身份、夜间行动和每个人的想法都已公开。' : '。'}
      </>
    );
  }
  return (
    <Card className="mt-5 flex flex-wrap items-center gap-3 p-4 text-sm text-dim">
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
      {next && (
        <Link to={`/werewolf/${next.id}`} className="shrink-0 font-semibold text-brand hover:underline">
          {next.status === 'waiting' ? '下一局正在下注' : `第 ${next.id} 局进行中`} →
        </Link>
      )}
    </Card>
  );
}

function deathText(s: WerewolfSeat): string {
  if (s.alive) return '存活';
  return s.death === 'night'
    ? `第 ${s.diedDay} 夜出局`
    : s.death === 'exile'
      ? `第 ${s.diedDay} 天被放逐`
      : `第 ${s.diedDay} 天被枪杀`;
}

function RoleBadge({ role }: { role: WerewolfRole }) {
  return (
    <Badge
      className={role === 'wolf' ? 'bg-no/10 text-no' : role === 'villager' ? undefined : 'bg-brand-light text-brand'}
    >
      {ROLE_NAME[role]}
    </Badge>
  );
}

function SeatCard({
  seat,
  market,
  selected,
  onPick,
}: {
  seat: WerewolfSeat;
  market?: MarketSummary;
  selected: boolean;
  onPick: (m: MarketSummary, outcomeIndex?: number) => void;
}) {
  const out = market?.outcomes[0];
  return (
    <button
      type="button"
      onClick={() => market && onPick(market)}
      className={clsx(
        'surface min-w-0 rounded-lg p-3 text-left transition-colors hover:border-brand',
        selected && 'border-brand! ring-2 ring-brand/15',
      )}
    >
      <div className="flex items-center gap-2.5">
        <span className={clsx('relative', !seat.alive && 'opacity-40 grayscale')}>
          <Avatar id={seat.seat} name={seat.name} size={34} />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-1.5">
            <span className="font-mono text-xs text-faint">{seat.seat}号</span>
            <span className={clsx('truncate font-semibold', !seat.alive && 'text-faint line-through')}>
              {seat.name}
            </span>
          </div>
          <div className="truncate text-xs text-faint" title={seat.persona}>
            {seat.persona}
          </div>
        </div>
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-1 text-xs">
        <span className={seat.alive ? 'text-yes' : 'text-no'}>{deathText(seat)}</span>
        {seat.role && <RoleBadge role={seat.role} />}
      </div>
      {market && out && (
        <div className="mt-1.5 flex items-center justify-between text-xs text-dim">
          <span>
            出局 <span className="font-mono">{formatPct(out.probability)}</span>
          </span>
          <Money value={market.pot} className="font-mono text-faint" />
        </div>
      )}
    </button>
  );
}

function SideCard({
  game,
  selected,
  onPick,
}: {
  game: WerewolfGame;
  selected: boolean;
  onPick: (m: MarketSummary, outcomeIndex?: number) => void;
}) {
  const m = game.sideMarket;
  return (
    <Card className={clsx('p-5', selected && 'border-brand')}>
      <h2 className="font-semibold">哪边赢？</h2>
      <div className="mt-3 grid grid-cols-2 gap-2">
        {m.outcomes.map((o, i) => {
          const c = outcomeColor(o.index, true);
          const won = m.resolvedOutcomeId === o.id;
          return (
            <button
              key={o.id}
              type="button"
              onClick={() => onPick(m, i)}
              className="rounded border border-line bg-panel px-3 py-2.5 text-left transition-colors hover:border-brand"
            >
              <div className="flex items-center justify-between gap-2 font-semibold" style={{ color: c }}>
                <span className="flex items-center gap-1">
                  {won && <Crown className="size-4 text-gold" />}
                  {o.label}
                </span>
                <span className="font-mono text-sm">{formatPct(o.probability)}</span>
              </div>
              <div className="mt-1 text-xs text-faint">
                奖池 <Money value={o.pool} />
              </div>
            </button>
          );
        })}
      </div>
      <p className="mt-3 text-xs leading-relaxed text-faint">
        点座位可以押单个玩家会不会出局。场上只剩 {game.cutoff} 人时全部停止下注，玩家一出局他那份就结算。
      </p>
    </Card>
  );
}

type LogItem = { kind: 'event'; event: WerewolfEvent } | { kind: 'votes'; day: number; votes: WerewolfEvent[] };

/** Consecutive votes of a day are shown together, as everyone cast them at once. */
function group(events: WerewolfEvent[]): LogItem[] {
  const items: LogItem[] = [];
  for (const e of events) {
    const last = items.at(-1);
    if (e.kind === 'vote' && last?.kind === 'votes' && last.day === e.day) last.votes.push(e);
    else if (e.kind === 'vote') items.push({ kind: 'votes', day: e.day, votes: [e] });
    else items.push({ kind: 'event', event: e });
  }
  return items;
}

function GameLog({ game, seatOf }: { game: WerewolfGame; seatOf: (n: number | null) => WerewolfSeat | undefined }) {
  const box = useRef<HTMLDivElement>(null);
  // Live games follow the newest line unless the reader scrolled up.
  const follow = useRef(!over(game));
  const count = game.events.length;
  useEffect(() => {
    const el = box.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [count]);

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-5 py-3">
        <h2 className="font-semibold">对局记录</h2>
        <span className="text-xs text-faint">
          {over(game) ? '已公开夜间行动和每个人的想法' : '只显示所有人都看得到的发言和结果'}
        </span>
      </div>
      <div
        ref={box}
        onScroll={() => {
          const el = box.current!;
          follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
        className="max-h-[70vh] space-y-3 overflow-y-auto px-4 py-4 sm:px-5"
      >
        {count === 0 && (
          <p className="py-8 text-center text-sm text-faint">
            {game.status === 'waiting' ? `${clock(game.startsAt)} 开局，开始后发言会实时出现在这里` : '还没有动静'}
          </p>
        )}
        {group(game.events).map((item) =>
          item.kind === 'votes' ? (
            <Votes key={`v${item.votes[0]!.id}`} day={item.day} votes={item.votes} />
          ) : (
            <LogLine key={item.event.id} e={item.event} seat={seatOf(item.event.seat)} />
          ),
        )}
      </div>
    </Card>
  );
}

function Thought({ text }: { text: string | null }) {
  if (!text) return null;
  return (
    <p className="mt-1 flex gap-1 text-xs leading-relaxed text-faint">
      <Brain className="mt-0.5 size-3.5 shrink-0" />
      <span>{text}</span>
    </p>
  );
}

function Divider({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 pt-2 text-xs font-semibold text-faint">
      <span className="h-px flex-1 bg-line" />
      {icon}
      {children}
      <span className="h-px flex-1 bg-line" />
    </div>
  );
}

function LogLine({ e, seat }: { e: WerewolfEvent; seat?: WerewolfSeat }) {
  if (e.kind === 'night') return <Divider icon={<Moon className="size-3.5" />}>第 {e.day} 夜</Divider>;
  if (e.kind === 'speech' || e.kind === 'last_words' || e.kind === 'wolf') {
    return (
      <div className="flex gap-3">
        <Avatar id={e.seat ?? 0} name={seat?.name ?? '?'} size={30} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
            <span className="font-semibold text-fg">
              {e.seat} 号 {seat?.name}
            </span>
            {seat?.role && <RoleBadge role={seat.role} />}
            {e.kind === 'last_words' && <Badge>遗言</Badge>}
            {e.kind === 'wolf' && (
              <Badge className="bg-no/10 text-no">
                <Lock className="size-3" /> 狼人夜聊 · 提议刀 {e.target} 号
              </Badge>
            )}
          </div>
          <div
            className={clsx(
              'mt-1 rounded-lg rounded-tl-none px-3.5 py-2.5 text-sm leading-relaxed [overflow-wrap:anywhere]',
              e.kind === 'wolf' ? 'bg-no/8' : 'bg-raised',
            )}
          >
            {e.text || '……'}
          </div>
          <Thought text={e.thought} />
        </div>
      </div>
    );
  }
  const line = (
    <p
      className={clsx(
        'flex items-start justify-center gap-1.5 text-center text-sm',
        e.kind === 'end' ? 'font-semibold text-fg' : e.public ? 'text-dim' : 'text-faint',
      )}
    >
      {!e.public && <Lock className="mt-0.5 size-3.5 shrink-0" />}
      {e.kind === 'end' && <Crown className="mt-0.5 size-4 shrink-0 text-gold" />}
      <span>{e.text}</span>
    </p>
  );
  if (e.kind === 'dawn')
    return (
      <div className="space-y-2">
        <Divider icon={<Sun className="size-3.5" />}>第 {e.day} 天</Divider>
        {line}
      </div>
    );
  return (
    <div>
      {line}
      {e.thought && (
        <div className="flex justify-center">
          <Thought text={e.thought} />
        </div>
      )}
    </div>
  );
}

function Votes({ day, votes }: { day: number; votes: WerewolfEvent[] }) {
  return (
    <div className="rounded-lg border border-line px-4 py-3">
      <div className="text-xs font-semibold text-dim">第 {day} 天投票</div>
      <div className="mt-2 flex flex-wrap gap-1.5">
        {votes.map((v) => (
          <span key={v.id} title={v.thought ?? undefined} className="rounded bg-fill px-2 py-0.5 font-mono text-xs">
            {v.seat} → {v.target === null ? '弃票' : v.target}
          </span>
        ))}
      </div>
    </div>
  );
}

function PastGames({ lobby, current }: { lobby: WerewolfLobby; current: number }) {
  const games = [...(lobby.current ? [lobby.current] : []), ...lobby.recent].slice(0, 12);
  if (games.length <= 1) return null;
  return (
    <Card className="p-5">
      <h2 className="font-semibold">对局</h2>
      <ul className="mt-2 divide-y divide-line">
        {games.map((g) => (
          <li key={g.id}>
            <Link
              to={`/werewolf/${g.id}`}
              className={clsx(
                'flex items-center gap-2 py-2 text-sm hover:text-brand',
                g.id === current && 'font-semibold text-brand',
              )}
            >
              <span className="w-14 shrink-0 font-mono text-xs text-faint">第 {g.id} 局</span>
              <span
                className={clsx(
                  'min-w-0 flex-1 truncate',
                  g.winner === 'wolves' && 'text-no',
                  g.winner === 'good' && 'text-yes',
                )}
              >
                {g.phase}
              </span>
              <span className="shrink-0 text-xs text-faint">
                {g.endedAt ? formatRelative(g.endedAt) : <Money value={g.pot} />}
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}
