import type { MarketSummary } from '@watercooler/shared';
import clsx from 'clsx';
import { Clock, MessageCircle, Users } from 'lucide-react';
import { Link, useNavigate } from 'react-router';
import { outcomeColor } from '../lib/colors';
import { formatPct, formatRelative } from '../lib/format';
import { CategoryIcon } from './CategoryIcon';
import { Money } from './Money';
import { OutcomeQuote } from './OutcomeQuote';
import { ProbabilityRing } from './ProbabilityRing';
import { Sparkline } from './Sparkline';
import { StatusBadge } from './StatusBadge';

/** `preview` renders a non-interactive card (used on the create page). */
export function MarketCard({ market, preview }: { market: MarketSummary; preview?: boolean }) {
  const navigate = useNavigate();
  const href = `/market/${market.id}`;
  const live = market.status === 'open';
  const sorted = market.isBinary ? market.outcomes : [...market.outcomes].sort((a, b) => b.probability - a.probability);
  const yesNoLabels = market.isBinary && market.outcomes[0]?.label === '是';

  return (
    <article className="surface card-hover group relative flex flex-col rounded-lg p-5">
      {!preview && <Link to={href} className="absolute inset-0 z-[1] rounded-lg" aria-label={market.question} />}
      <div className="flex items-start gap-3">
        <CategoryIcon category={market.category} size={40} />
        <h3 className="line-clamp-2 min-h-[2.75rem] flex-1 text-[15px] leading-snug font-semibold text-fg transition-colors group-hover:text-brand">
          {market.question}
        </h3>
        {market.isBinary && market.outcomes[0] && (
          <ProbabilityRing
            value={market.outcomes[0].probability}
            size={56}
            label={market.mode === 'polymarket' ? '概率' : yesNoLabels ? '押是' : market.outcomes[0].label.slice(0, 4)}
          />
        )}
      </div>

      <div className="mt-3 flex flex-1 flex-col justify-end">
        {market.mode === 'polymarket' && market.isBinary ? (
          <>
            <span className="mb-2 text-xs text-faint">挂单价 · 水滴/份</span>
            <div className="grid grid-cols-2 gap-2">
              {market.outcomes.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  disabled={!live || preview}
                  onClick={() => navigate(`${href}?outcome=${o.id}`)}
                  className="relative z-10 rounded bg-raised p-3 text-sm transition-colors hover:bg-fill disabled:pointer-events-none"
                >
                  <OutcomeQuote outcome={o} />
                </button>
              ))}
            </div>
          </>
        ) : market.isBinary ? (
          <>
            {market.spark.length > 1 ? (
              <div className="relative mb-3">
                <Sparkline values={market.spark} className="h-9 w-full" />
                <span className="absolute top-0 right-0 text-[10px] text-faint">7天</span>
              </div>
            ) : (
              <div className="flex-1" />
            )}
            <div className="grid grid-cols-2 gap-2">
              {market.outcomes.map((o, i) => (
                <button
                  key={o.id}
                  disabled={!live || preview}
                  onClick={() => navigate(`${href}?outcome=${o.id}`)}
                  className={clsx(
                    'relative z-10 flex h-9 items-center justify-between rounded px-3 text-sm font-semibold transition-colors',
                    'disabled:pointer-events-none disabled:opacity-60',
                    i === 0
                      ? 'bg-yes/8 text-yes hover:bg-yes hover:text-white'
                      : 'bg-no/8 text-no hover:bg-no hover:text-white',
                  )}
                >
                  <span className="truncate">{o.label}</span>
                  <span className="font-mono text-xs">{formatPct(o.probability)}</span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <ul className="space-y-1.5">
            {sorted.slice(0, 3).map((o) => (
              <li key={o.id} className="relative overflow-hidden rounded px-2.5 py-1.5 text-sm">
                <div
                  className="absolute inset-y-0 left-0 rounded opacity-[0.12] transition-all duration-500"
                  style={{ width: `${o.probability * 100}%`, background: outcomeColor(o.index, false) }}
                />
                <div className="relative flex items-center justify-between gap-2">
                  <span className="flex min-w-0 items-center gap-2">
                    <span
                      className="size-2 shrink-0 rounded-full"
                      style={{ background: outcomeColor(o.index, false) }}
                    />
                    <span className="truncate text-fg">{o.label}</span>
                  </span>
                  <span className="font-mono text-xs font-semibold">{formatPct(o.probability)}</span>
                </div>
              </li>
            ))}
            {sorted.length > 3 && <li className="px-2.5 text-xs text-faint">还有 {sorted.length - 3} 个选项</li>}
          </ul>
        )}
      </div>

      <footer className="mt-4 flex items-center gap-3 border-t border-line pt-3 text-xs text-faint">
        {market.isAi && (
          <span className="rounded bg-brand-light px-1.5 py-0.5 text-[10px] font-semibold text-brand">AI</span>
        )}
        <span className="inline-flex items-center gap-1">
          {market.mode === 'polymarket' ? '抵押' : '奖池'} <Money value={market.pot} compact className="text-dim" />
        </span>
        <span className="inline-flex items-center gap-1">
          <Users className="size-3.5" />
          {market.bettorCount}
        </span>
        {market.commentCount > 0 && (
          <span className="inline-flex items-center gap-1">
            <MessageCircle className="size-3.5" />
            {market.commentCount}
          </span>
        )}
        <span className="ml-auto">
          {live ? (
            <span className="inline-flex items-center gap-1">
              <Clock className="size-3.5" />
              {formatRelative(market.closeAt)}截止
            </span>
          ) : (
            <StatusBadge market={market} />
          )}
        </span>
      </footer>
    </article>
  );
}

export function MarketCardSkeleton() {
  return (
    <div className="surface h-[196px] animate-pulse rounded-lg p-5">
      <div className="flex gap-3">
        <div className="size-10 rounded-md bg-fill" />
        <div className="flex-1 space-y-2">
          <div className="h-3.5 w-full rounded bg-fill" />
          <div className="h-3.5 w-2/3 rounded bg-fill" />
        </div>
      </div>
      <div className="mt-6 grid grid-cols-2 gap-2">
        <div className="h-9 rounded bg-fill" />
        <div className="h-9 rounded bg-fill" />
      </div>
    </div>
  );
}
