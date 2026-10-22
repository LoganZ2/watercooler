import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_NAME,
  MIN_BET,
  previewBet,
  type MarketDetail,
  type MarketDetailResponse,
  type Stake,
} from '@watercooler/shared';
import clsx from 'clsx';
import { ArrowRight, Ban, Crown, Hourglass, Lock } from 'lucide-react';
import { useState } from 'react';
import { Link, useLocation } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useMe, useSetMe } from '../lib/auth';
import { outcomeColor } from '../lib/colors';
import { formatDate, formatMoney, formatMultiplier, formatPct, formatPct1 } from '../lib/format';
import { Drop, Money } from './Money';
import { Button, buttonClass, Card } from './ui';

export const POOL_RULE = `奖池模式：押中的人按下注比例瓜分全部奖池，没人押中则全部退还。`;

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3 text-sm">
      <span className="text-faint">{label}</span>
      <span className="font-mono tabular text-fg">{children}</span>
    </div>
  );
}

export function BetPanel({
  market,
  stakes,
  outcomeId,
  onOutcomeChange,
  heading,
}: {
  market: MarketDetail;
  stakes: Stake[];
  outcomeId: number;
  onOutcomeChange: (id: number) => void;
  /** What the ticket is for, when the page shows several markets; plain 「下注」 otherwise. */
  heading?: React.ReactNode;
}) {
  const { me } = useMe();
  const setMe = useSetMe();
  const qc = useQueryClient();
  const location = useLocation();
  const [amount, setAmount] = useState('');

  const index = Math.max(
    0,
    market.outcomes.findIndex((o) => o.id === outcomeId),
  );
  const outcome = market.outcomes[index]!;
  const color = outcomeColor(outcome.index, market.isBinary);
  const amountNum = Number(amount);
  const preview =
    amountNum > 0
      ? previewBet(
          market.outcomes.map((o) => o.pool),
          index,
          amountNum,
        )
      : null;

  const mutation = useMutation({
    mutationFn: () => api.bet(market.id, { outcomeId: outcome.id, amount: amountNum }),
    onSuccess: (res) => {
      qc.setQueryData<MarketDetailResponse>(['market', market.id], { market: res.market, stakes: res.stakes });
      setMe((m) => ({ ...m, balance: res.balance }));
      for (const key of [
        'history',
        'marketBets',
        'holders',
        'activity',
        'portfolio',
        'markets',
        'stats',
        'leaderboard',
        'werewolf',
      ]) {
        void qc.invalidateQueries({ queryKey: [key] });
      }
      toast.success(`下注成功：${formatMoney(res.bet.amount)} ${CURRENCY_NAME} 押「${res.bet.outcomeLabel}」`);
      setAmount('');
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ['market', market.id] });
    },
  });

  if (market.status !== 'open') return <ClosedPanel market={market} heading={heading} />;

  const balance = me?.balance ?? 0;
  const insufficient = amountNum > balance;
  const tooSmall = amount !== '' && amountNum < MIN_BET;
  const canSubmit = !!me && !!preview && !insufficient && !tooSmall && !mutation.isPending;
  const addAmount = (n: number) => setAmount((a) => String(Math.round(((Number(a) || 0) + n) * 100) / 100));
  const myStake = stakes.find((s) => s.outcomeId === outcome.id)?.amount ?? 0;

  return (
    <Card className="p-5">
      <h2 className="font-semibold">{heading ?? '下注'}</h2>
      <div
        className={clsx(
          'mt-4 grid gap-2',
          market.isBinary ? 'grid-cols-2' : 'max-h-64 grid-cols-1 overflow-y-auto pr-1',
        )}
      >
        {market.outcomes.map((o) => {
          const c = outcomeColor(o.index, market.isBinary);
          const selected = o.id === outcome.id;
          return (
            <button
              key={o.id}
              onClick={() => onOutcomeChange(o.id)}
              className={clsx(
                'flex items-center justify-between gap-2 rounded border px-3.5 text-left font-semibold transition-colors',
                market.isBinary ? 'h-11' : 'h-10 text-sm',
                selected ? 'text-white' : 'border-line bg-panel text-fg hover:border-brand',
              )}
              style={selected ? { background: c, borderColor: c } : undefined}
            >
              <span className="flex min-w-0 items-center gap-2">
                {!market.isBinary && !selected && (
                  <span className="size-2 shrink-0 rounded-full" style={{ background: c }} />
                )}
                <span className="truncate">{o.label}</span>
              </span>
              <span className="font-mono text-sm">{formatPct(o.probability)}</span>
            </button>
          );
        })}
      </div>

      <div className="mt-5">
        <div className="mb-1.5 flex items-center justify-between text-xs">
          <span className="text-fg">下注金额（{CURRENCY_NAME}）</span>
          {me && (
            <span className="text-faint">
              余额 <Money value={balance} className="text-dim" />
            </span>
          )}
        </div>
        <div className="relative">
          <Drop className="absolute top-1/2 left-3.5 size-5 -translate-y-1/2" />
          <input
            type="number"
            inputMode="decimal"
            min={0}
            placeholder="0"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            className={clsx(
              'h-13 w-full rounded border border-line bg-panel pr-4 pl-11 text-right font-mono text-2xl font-semibold outline-none transition',
              'placeholder:text-line-strong hover:border-line-strong focus:border-brand focus:shadow-[0_0_0_3px_rgb(28_85_251/0.12)]',
            )}
          />
        </div>
        <div className="mt-2 flex gap-1.5">
          {(
            [
              ['+10', () => addAmount(10)],
              ['+50', () => addAmount(50)],
              ['+100', () => addAmount(100)],
              ['全部', () => setAmount(String(Math.floor(balance * 100) / 100))],
            ] as const
          ).map(([label, fn]) => (
            <button
              key={label}
              onClick={fn}
              disabled={!me}
              className="flex-1 rounded border border-line bg-panel py-1.5 text-xs text-dim transition hover:border-brand hover:text-brand disabled:opacity-40"
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-5 space-y-2.5 rounded bg-raised p-4">
        <Row label="奖池占比">
          {preview ? (
            <span className="inline-flex items-center gap-1">
              {formatPct1(outcome.probability)} <ArrowRight className="size-3 text-faint" />
              <span style={{ color }}>{formatPct1(preview.shares[index]!)}</span>
            </span>
          ) : (
            formatPct1(outcome.probability)
          )}
        </Row>
        <Row label="预计赔率">{preview ? formatMultiplier(preview.multiplier) : '—'}</Row>
        {myStake > 0 && (
          <Row label="已押这个选项">
            <Money value={myStake} />
          </Row>
        )}
        <div className="my-1 h-px bg-line" />
        <div className="flex items-end justify-between">
          <span className="text-sm text-faint">这笔猜中预计可得</span>
          <span className="text-right">
            <span className="block text-xl font-semibold text-yes">
              {preview ? <Money value={preview.payout} /> : '—'}
            </span>
            {preview && <span className="text-xs text-yes">收益 +{((preview.multiplier - 1) * 100).toFixed(1)}%</span>}
          </span>
        </div>
        <p className="text-[11px] leading-relaxed text-faint">赔率会随后面的下注变化，最终按截止时的奖池计算。</p>
      </div>

      {me ? (
        <Button
          size="lg"
          className="mt-4 w-full"
          disabled={!canSubmit}
          loading={mutation.isPending}
          onClick={() => mutation.mutate()}
          style={canSubmit ? { background: color, color: '#fff' } : undefined}
        >
          {insufficient ? '余额不足' : tooSmall ? `最少 ${MIN_BET} ${CURRENCY_NAME}` : `押「${outcome.label}」`}
        </Button>
      ) : (
        <Link
          to={`/login?next=${encodeURIComponent(location.pathname)}`}
          className={buttonClass({ size: 'lg', className: 'mt-4 w-full' })}
        >
          <Lock className="size-4" />
          登录后开始下注
        </Link>
      )}
      <p className="mt-3 text-center text-[11px] leading-relaxed text-faint">{POOL_RULE}</p>
    </Card>
  );
}

/** Shown instead of the bet form once betting has stopped. */
function ClosedPanel({ market, heading }: { market: MarketDetail; heading?: React.ReactNode }) {
  const winner = market.outcomes.find((o) => o.id === market.resolvedOutcomeId);
  if (market.status === 'resolved' && winner) {
    const c = outcomeColor(winner.index, market.isBinary);
    return (
      <Card className="p-6 text-center">
        {heading && <h2 className="mb-4 text-left font-semibold">{heading}</h2>}
        <Crown className="mx-auto size-8 text-gold" />
        <div className="mt-3 text-sm text-dim">最终结果</div>
        <div className="mt-1 text-3xl font-bold" style={{ color: c }}>
          {winner.label}
        </div>
        <p className="mt-3 text-xs text-faint">
          {winner.pool > 0
            ? `押「${winner.label}」的人已按下注比例瓜分 ${formatMoney(market.pot)} ${CURRENCY_NAME} 奖池`
            : `没有人押中，所有下注已退回`}
        </p>
      </Card>
    );
  }
  return (
    <Card className="flex flex-wrap items-start gap-3 p-5 text-sm text-dim">
      {heading && <h2 className="w-full font-semibold text-fg">{heading}</h2>}
      {market.status === 'closed' ? (
        <Hourglass className="mt-0.5 size-5 shrink-0 text-gold" />
      ) : (
        <Ban className="mt-0.5 size-5 shrink-0 text-faint" />
      )}
      <div className="min-w-0 flex-1">
        <div className="font-medium text-fg">{market.status === 'closed' ? '下注已截止' : '市场已取消'}</div>
        <div className="mt-1 text-xs leading-relaxed text-faint">
          {market.status !== 'closed'
            ? `所有下注已全额退回${CURRENCY_NAME}余额。`
            : market.werewolf
              ? '场上人数到了停止下注的线，这局狼人杀一结束就自动结算。'
              : `等待 ${market.creator.displayName} 公布结果；${formatDate(market.resolveBy!)} 前没公布会自动取消、全额退款。`}
        </div>
      </div>
    </Card>
  );
}
