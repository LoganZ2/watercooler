import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORIES,
  createMarketSchema,
  MAX_OUTCOMES,
  MIN_MULTI_OUTCOMES,
  type MarketSummary,
} from '@watercooler/shared';
import clsx from 'clsx';
import { Gavel, Plus, Sparkles, X } from 'lucide-react';
import { useState } from 'react';
import { useNavigate } from 'react-router';
import { toast } from 'sonner';
import { MarketCard } from '../components/MarketCard';
import { Button, Card, DateTimeInput, Field, Input, Textarea } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useConfig, useMe } from '../lib/auth';
import { toLocalInput } from '../lib/format';
import { COPY, usePageTitle } from '../lib/site';

const QUICK_CLOSE = [
  { label: '明天', days: 1 },
  { label: '一周', days: 7 },
  { label: '一个月', days: 30 },
  { label: '三个月', days: 90 },
];

export default function CreateMarket() {
  usePageTitle('创建预测');
  const navigate = useNavigate();
  const qc = useQueryClient();
  const { me } = useMe();
  const config = useConfig();
  const [question, setQuestion] = useState('');
  const [description, setDescription] = useState('');
  const [category, setCategory] = useState<string>(CATEGORIES[0]);
  const [kind, setKind] = useState<'binary' | 'multi'>('binary');
  const [mode, setMode] = useState<'pool' | 'polymarket'>('pool');
  const [options, setOptions] = useState<string[]>(['', '', '']);
  const [closeAt, setCloseAt] = useState(() => toLocalInput(Date.now() + 7 * 86_400_000));
  const [settleAt, setSettleAt] = useState(() => toLocalInput(Date.now() + 8 * 86_400_000));
  const [submitted, setSubmitted] = useState(false);

  const outcomes =
    kind === 'binary'
      ? mode === 'polymarket'
        ? ['Yes', 'No']
        : ['是', '否']
      : options.map((o) => o.trim()).filter(Boolean);
  const closeTs = new Date(closeAt).getTime();
  const settleTs = new Date(settleAt).getTime();

  const payload = {
    mode,
    question: question.trim(),
    description: description.trim(),
    category,
    closeAt: closeTs,
    settleAt: settleTs,
    outcomes,
  };
  const validation = createMarketSchema.safeParse(payload);
  const firstError = validation.success ? null : validation.error.issues[0]?.message;

  const preview: MarketSummary = (() => {
    const labels = outcomes.length >= 2 ? outcomes : ['选项 A', '选项 B'];
    return {
      mode,
      id: 0,
      question: question.trim() || '你的问题会显示在这里？',
      category,
      status: 'open',
      isBinary: labels.length === 2,
      isAi: false,
      pot: 0,
      closeAt: Number.isFinite(closeTs) ? closeTs : Date.now(),
      settleAt: Number.isFinite(settleTs) ? settleTs : Date.now(),
      createdAt: Date.now(),
      resolvedOutcomeId: null,
      bettorCount: 0,
      commentCount: 0,
      creator: { id: me?.id ?? 0, username: me?.username ?? '', displayName: me?.displayName ?? '' },
      outcomes: labels.map((label, i) => ({
        id: -i - 1,
        index: i,
        label,
        pool: 0,
        probability: 1 / labels.length,
        change24h: null,
      })),
      spark: [],
    };
  })();

  const mutation = useMutation({
    mutationFn: () => api.createMarket(payload),
    onSuccess: ({ id }) => {
      toast.success('市场已创建');
      void qc.invalidateQueries({ queryKey: ['markets'] });
      void qc.invalidateQueries({ queryKey: ['stats'] });
      navigate(`/market/${id}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const publish = () => {
    setSubmitted(true);
    if (!validation.success) {
      toast.error(firstError ?? '请检查预测内容');
      return;
    }
    mutation.mutate();
  };

  return (
    <div className="mx-auto max-w-6xl">
      <h1 className="flex items-center gap-2 section-title">
        <Sparkles className="size-6 text-brand" /> 创建预测
      </h1>
      <p className="mt-2 text-dim">填写预测问题，确认模式和时间后，点击「创建预测」发布。</p>

      <div className="mt-8 grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <Card className="space-y-6 p-6">
          <div>
            <span className="text-sm font-medium text-dim">交易模式</span>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {(
                [
                  ['pool', '奖池模式', '押中的人按比例瓜分奖池'],
                  ['polymarket', 'Polymarket', 'Yes / No 份额 · bid / ask 订单簿'],
                ] as const
              )
                // Admins can switch the order-book mode off for this instance.
                .filter(([value]) => value === 'pool' || config?.polymarket !== false)
                .map(([value, title, hint]) => (
                  <button
                    key={value}
                    type="button"
                    onClick={() => setMode(value)}
                    className={clsx(
                      'rounded-lg border p-4 text-left',
                      mode === value ? 'border-brand bg-brand-light' : 'border-line',
                    )}
                  >
                    <div className="font-semibold">{title}</div>
                    <div className="mt-1 text-xs text-faint">{hint}</div>
                  </button>
                ))}
            </div>
          </div>
          <Field label="预测问题（必填）" hint={`至少 5 个字 · ${question.trim().length}/200`}>
            <Input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder={COPY.questionPlaceholder}
              maxLength={200}
              autoFocus
            />
          </Field>

          <div>
            <span className="text-sm font-medium text-dim">分类</span>
            <div className="mt-2 flex flex-wrap gap-2">
              {CATEGORIES.map((c) => (
                <button
                  key={c}
                  type="button"
                  onClick={() => setCategory(c)}
                  className={clsx(
                    'rounded border px-3.5 py-1.5 text-sm transition',
                    category === c
                      ? 'border-brand bg-brand-light text-brand'
                      : 'border-line text-dim hover:border-brand hover:text-brand',
                  )}
                >
                  {c}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="text-sm font-medium text-dim">类型</span>
            <div className="mt-2 grid grid-cols-2 gap-3">
              {(mode === 'polymarket'
                ? ([
                    ['binary', 'Yes / No', '一个订单簿，买 Yes 或买 No'],
                    ['multi', '多选一', `${MIN_MULTI_OUTCOMES}–${MAX_OUTCOMES} 个选项，每个选项各有一对 Yes / No`],
                  ] as const)
                : ([
                    ['binary', '是 / 否', '经典二元问题'],
                    ['multi', '多选一', `2–${MAX_OUTCOMES} 个互斥选项`],
                  ] as const)
              ).map(([value, title, hint]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => setKind(value)}
                  className={clsx(
                    'rounded-lg border p-4 text-left transition',
                    kind === value ? 'border-brand bg-brand-light' : 'border-line hover:border-brand',
                  )}
                >
                  <div className="font-semibold">{title}</div>
                  <div className="mt-0.5 text-xs text-faint">{hint}</div>
                </button>
              ))}
            </div>
          </div>

          {kind === 'multi' && (
            <div>
              <span className="text-sm font-medium text-dim">选项（只会有一个成真）</span>
              <div className="mt-2 space-y-2">
                {options.map((o, i) => (
                  <div key={i} className="flex gap-2">
                    <Input
                      value={o}
                      maxLength={40}
                      placeholder={`选项 ${i + 1}`}
                      onChange={(e) => setOptions((xs) => xs.map((x, j) => (j === i ? e.target.value : x)))}
                    />
                    {options.length > 2 && (
                      <Button
                        variant="ghost"
                        className="h-11 w-11 shrink-0 px-0"
                        onClick={() => setOptions((xs) => xs.filter((_, j) => j !== i))}
                        aria-label="删除选项"
                      >
                        <X className="size-4" />
                      </Button>
                    )}
                  </div>
                ))}
                {options.length < MAX_OUTCOMES && (
                  <Button variant="outline" size="sm" onClick={() => setOptions((xs) => [...xs, ''])}>
                    <Plus className="size-4" /> 添加选项
                  </Button>
                )}
              </div>
            </div>
          )}

          <Field label="停止交易时间" hint="到时停止下注和份额交易，未成交订单自动撤销并解冻">
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <DateTimeInput label="停止交易时间" value={closeAt} onChange={setCloseAt} />
              <div className="flex gap-1.5">
                {QUICK_CLOSE.map((q) => (
                  <button
                    key={q.label}
                    type="button"
                    onClick={() => {
                      const d = new Date(Date.now() + q.days * 86_400_000);
                      d.setHours(18, 0, 0, 0);
                      setCloseAt(toLocalInput(d.getTime()));
                    }}
                    className="h-10 rounded border border-line px-2.5 text-xs text-dim transition hover:border-brand hover:text-brand"
                  >
                    {q.label}
                  </button>
                ))}
              </div>
            </div>
          </Field>

          <Field
            label="结算时间"
            hint={
              mode === 'polymarket'
                ? '到时起可公布结果并兑付；未公布则继续等待，不会自动取消'
                : '预计知道结果的时间，结果确定后可以提前公布；到时 7 天后还没公布会自动取消退款'
            }
          >
            <DateTimeInput label="结算时间" value={settleAt} min={closeAt} onChange={setSettleAt} />
          </Field>

          <Field label="结算规则" hint="写清楚以什么为准、边界情况怎么算，避免扯皮">
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={COPY.criteriaPlaceholder}
              rows={4}
              maxLength={5000}
            />
          </Field>
        </Card>

        <div className="space-y-4 lg:sticky lg:top-24 lg:self-start">
          <div className="text-xs font-medium tracking-wider text-faint">预览</div>
          <MarketCard market={preview} preview />
          <Button size="lg" className="w-full" loading={mutation.isPending} onClick={publish}>
            创建预测
          </Button>
          <p className="text-center text-xs text-faint">填写预测问题后点击创建，创建成功会自动进入预测详情。</p>
          <div className="flex gap-2.5 rounded bg-raised p-3.5 text-xs leading-relaxed text-dim">
            <Gavel className="mt-0.5 size-4 shrink-0 text-brand" />
            <span>
              {mode === 'polymarket'
                ? '获胜份额每份兑回 1 水滴，落败份额兑回 0；Polymarket 市场不可取消。'
                : '押中的人按比例瓜分奖池，取消时全额退款。'}
              {mode === 'polymarket' ? '结果由你在结算时间到达后公布。' : '结果确定后由你随时公布，公布后停止下注。'}
              {mode === 'polymarket'
                ? '未公布时保留持仓和资金，继续等待结算，不会自动取消。'
                : '结算时间后 7 天未公布，自动取消并全额退款。'}
            </span>
          </div>
          {firstError && (submitted || question || options.some(Boolean)) && (
            <p role="alert" className="text-center text-sm text-no">
              {firstError}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
