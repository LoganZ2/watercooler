import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  orderSchema,
  planFill,
  shareAmountSchema,
  type ExchangeOrder,
  type ExchangeState,
  type MarketDetail,
  type OrderInput,
} from '@watercooler/shared';
import clsx from 'clsx';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import {
  bookOf,
  displayPrice,
  formatPrice,
  isMultiExchange,
  sameShare,
  shareName,
  sharePair,
  type ShareRef,
} from '../lib/exchange';
import { formatDate, formatMoney, formatSigned, toLocalInput } from '../lib/format';
import { Badge, Button, Card, DateTimeInput, Field, Input, Segmented, Spinner } from './ui';

/** A request from elsewhere on the page (a book level, a position's 卖出) to set up the ticket. */
export interface TicketIntent {
  side: OrderInput['side'];
  mode: 'market' | 'limit';
  price?: string;
  quantity?: string;
  seq: number;
}

const ORDER_TYPE_LABEL: Record<ExchangeOrder['type'], string> = {
  GTC: '限价',
  GTD: '限时',
  FOK: '市价 FOK',
  FAK: '市价',
};

function useExchangeAction(marketId: number, success = '操作成功') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (run: () => Promise<unknown>) => run(),
    onSuccess: () => {
      toast.success(success);
      void qc.invalidateQueries();
    },
    onError: (err) => {
      toast.error(errorMessage(err));
      void qc.invalidateQueries({ queryKey: ['exchange', marketId] });
    },
  });
}

export function ExchangePanel({
  market,
  data,
  error,
  share,
  onShareChange,
  intent,
}: {
  market: MarketDetail;
  data: ExchangeState | undefined;
  error: Error | null;
  share: ShareRef;
  onShareChange: (share: ShareRef) => void;
  intent: TicketIntent | null;
}) {
  const { me } = useMe();
  const [side, setSide] = useState<OrderInput['side']>('buy');
  const [mode, setMode] = useState<'market' | 'limit'>('market');
  const [amount, setAmount] = useState('10');
  const [shares, setShares] = useState('10');
  const [price, setPrice] = useState('0.50');
  const [fok, setFok] = useState(false);
  const [gtd, setGtd] = useState(false);
  const [expires, setExpires] = useState(() => toLocalInput(Date.now() + 86_400_000));
  const [postOnly, setPostOnly] = useState(false);
  const action = useExchangeAction(market.id, '已提交');
  // Mirrors trade at Polymarket's live book: market orders only, against the site.
  const mirror = Boolean(market.mimic);

  useEffect(() => {
    if (!intent) return;
    setSide(intent.side);
    setMode(mirror ? 'market' : intent.mode);
    if (intent.price) setPrice(intent.price);
    if (intent.quantity) setShares(intent.quantity);
  }, [intent, mirror]);

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
  const name = shareName(market, share);
  const holding = data.positions.find((p) => sameShare(p, share));
  const available = (holding?.quantity ?? 0) - (holding?.reserved ?? 0);
  const balance = me?.balance ?? 0;
  const open = market.status === 'open';
  const buy = side === 'buy';

  const base = { outcomeId: share.outcomeId, token: share.token, side };
  const input: OrderInput =
    mode === 'market'
      ? { ...base, type: fok ? 'FOK' : 'FAK', ...(buy ? { amount: Number(amount) } : { quantity: Number(shares) }) }
      : {
          ...base,
          type: gtd ? 'GTD' : 'GTC',
          price: Number(price),
          quantity: Number(shares),
          ...(gtd ? { expiresAt: new Date(expires).getTime() } : {}),
          postOnly,
        };
  const valid = orderSchema.safeParse(input).success;
  const plan =
    mode === 'market' && book
      ? planFill(
          buy ? book.asks : book.bids,
          side,
          buy ? { amount: Number(amount) || 0 } : { quantity: Number(shares) || 0 },
        )
      : null;
  const limitTotal = Number(price) * Number(shares);
  const affordable = buy
    ? mode === 'market'
      ? Number(amount) <= balance + 1e-8
      : limitTotal <= balance + 1e-8
    : Number(shares) <= available;

  return (
    <>
      <Card className="space-y-4 p-5">
        <div className="flex items-center justify-between gap-3">
          <Segmented
            variant="tabs"
            value={side}
            onChange={setSide}
            options={[
              { value: 'buy', label: '买入' },
              { value: 'sell', label: '卖出' },
            ]}
          />
          {mirror ? (
            <span className="text-xs text-faint">按 Polymarket 实时价</span>
          ) : (
            <Segmented
              size="sm"
              value={mode}
              onChange={setMode}
              options={[
                { value: 'market', label: '市价' },
                { value: 'limit', label: '限价' },
              ]}
            />
          )}
        </div>
        {isMultiExchange(market) && (
          <p className="text-sm font-medium">{market.outcomes.find((o) => o.id === share.outcomeId)?.label}</p>
        )}
        <div className="grid grid-cols-2 gap-2">
          {sharePair(market, share.outcomeId).map((s, i) => {
            const b = bookOf(data, s);
            const quote = buy ? b?.asks[0]?.price : b?.bids[0]?.price;
            const selected = sameShare(s, share);
            return (
              <button
                key={`${s.outcomeId}:${s.token}`}
                type="button"
                onClick={() => onShareChange(s)}
                className={clsx(
                  'flex h-11 items-center justify-between rounded px-3 text-sm font-semibold transition-colors',
                  selected
                    ? i === 0
                      ? 'bg-yes text-white'
                      : 'bg-no text-white'
                    : i === 0
                      ? 'bg-yes/8 text-yes hover:bg-yes/15'
                      : 'bg-no/8 text-no hover:bg-no/15',
                )}
              >
                <span className="truncate">
                  {isMultiExchange(market) ? (s.token === 'no' ? 'No' : 'Yes') : shareName(market, s)}
                </span>
                <span className="font-mono">{formatPrice(quote ?? displayPrice(b))}</span>
              </button>
            );
          })}
        </div>

        {!open ? (
          <p className="text-sm text-dim">
            {market.status === 'closed'
              ? '交易已截止，等待创建者公布结果；完整的一对份额仍有 1 水滴抵押。'
              : '市场已结算，获胜份额已按每份 1 水滴自动兑付。'}
          </p>
        ) : !me ? (
          <Link
            to={`/login?next=${encodeURIComponent(`/market/${market.id}`)}`}
            className="block text-center text-brand"
          >
            登录后交易
          </Link>
        ) : (
          <form
            className="space-y-3"
            onSubmit={(e) => {
              e.preventDefault();
              if (!valid || !affordable) return;
              if (mirror && input.type !== 'GTC' && input.type !== 'GTD') {
                const { outcomeId, token, side, type, amount, quantity } = input;
                action.mutate(() => api.mimicOrder(market.id, { outcomeId, token, side, type, amount, quantity }));
              } else action.mutate(() => api.order(market.id, input));
            }}
          >
            {mode === 'market' ? (
              buy ? (
                <Field label="金额（水滴）" hint={`可用余额 ${formatMoney(balance)}`}>
                  <Input
                    type="number"
                    min="0.01"
                    step="0.01"
                    value={amount}
                    onChange={(e) => setAmount(e.target.value)}
                    required
                  />
                  <span className="mt-2 flex gap-2">
                    {[1, 10, 100].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className="rounded border border-line px-2 py-0.5 text-xs text-dim hover:border-brand hover:text-brand"
                        onClick={() => setAmount(String(Math.round(((Number(amount) || 0) + n) * 100) / 100))}
                      >
                        +{n}
                      </button>
                    ))}
                    <button
                      type="button"
                      className="rounded border border-line px-2 py-0.5 text-xs text-dim hover:border-brand hover:text-brand"
                      onClick={() => setAmount(String(Math.floor(balance * 100) / 100))}
                    >
                      全部
                    </button>
                  </span>
                </Field>
              ) : (
                <SharesField value={shares} onChange={setShares} available={available} name={name} />
              )
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <Field label="限价（每份）">
                  <Input
                    type="number"
                    min="0.01"
                    max="0.99"
                    step="0.01"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    required
                  />
                </Field>
                <SharesField value={shares} onChange={setShares} available={buy ? null : available} name={name} />
              </div>
            )}

            <dl className="space-y-1 rounded bg-raised p-3 text-sm">
              {mode === 'market' ? (
                plan && plan.quantity > 0 ? (
                  <>
                    <Row label="均价">{formatPrice(plan.avgPrice)}</Row>
                    <Row label={buy ? '预计买到' : '预计卖出'}>{plan.quantity} 份</Row>
                    <Row label={buy ? '花费' : '收到'}>{formatMoney(plan.total)} 水滴</Row>
                    {buy && (
                      <Row label="赢了可得">
                        <span className="text-yes">
                          {formatMoney(plan.quantity)}（{formatSigned(plan.quantity - plan.total)}）
                        </span>
                      </Row>
                    )}
                    {!plan.complete && <p className="text-xs text-gold">盘口不够，只能成交这么多。</p>}
                  </>
                ) : (
                  <p className="text-xs text-faint">
                    {buy ? '暂时没有卖单' : '暂时没有买单'}，可以改挂限价单等别人成交。
                  </p>
                )
              ) : (
                <>
                  <Row label={buy ? '最多冻结' : '最少收到'}>
                    {Number.isFinite(limitTotal) ? formatMoney(limitTotal) : '—'} 水滴
                  </Row>
                  {buy && Number(shares) > 0 && (
                    <Row label="赢了可得">
                      <span className="text-yes">
                        {formatMoney(Number(shares))}（{formatSigned(Number(shares) - limitTotal)}）
                      </span>
                    </Row>
                  )}
                </>
              )}
            </dl>

            {mode === 'market' ? (
              <label className="flex items-center gap-2 text-sm text-dim">
                <input
                  type="checkbox"
                  checked={fok}
                  onChange={(e) => setFok(e.target.checked)}
                  className="accent-brand"
                />
                不能全部成交就整单取消（FOK）
              </label>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm text-dim">
                  <input
                    type="checkbox"
                    checked={gtd}
                    onChange={(e) => setGtd(e.target.checked)}
                    className="accent-brand"
                  />
                  到期自动撤单（GTD）
                </label>
                {gtd && (
                  <DateTimeInput
                    label="到期时间"
                    value={expires}
                    min={toLocalInput(Date.now())}
                    onChange={setExpires}
                  />
                )}
                <label className="flex items-center gap-2 text-sm text-dim">
                  <input
                    type="checkbox"
                    checked={postOnly}
                    onChange={(e) => setPostOnly(e.target.checked)}
                    className="accent-brand"
                  />
                  只挂单（Post-only），会立即成交就拒绝
                </label>
              </>
            )}

            <Button
              type="submit"
              variant={buy ? 'yes' : 'no'}
              className="w-full"
              loading={action.isPending}
              disabled={!valid || !affordable || (mode === 'market' && !plan?.quantity)}
            >
              {buy ? '买入' : '卖出'} {name}
            </Button>
            <p className="text-xs leading-relaxed text-faint">
              {mirror
                ? '按 Polymarket 的实时盘口从最优价逐档成交，只买整份；对手是本站，你的买卖不影响 Polymarket。结果以 Polymarket 为准。'
                : mode === 'market'
                  ? '市价单按盘口从最优价逐档成交，只买整份，不会挂单；没成交的部分直接取消。'
                  : '限价单按价格、时间优先撮合，可部分成交；没成交的部分挂在订单簿上，可随时撤销。'}
              无交易手续费。
            </p>
          </form>
        )}
      </Card>
      {me && <MyOrders market={market} data={data} />}
    </>
  );
}

function SharesField({
  value,
  onChange,
  available,
  name,
}: {
  value: string;
  onChange: (v: string) => void;
  available: number | null;
  name: string;
}) {
  return (
    <Field label="份数" hint={available === null ? undefined : `可卖 ${name} ${available} 份`}>
      <Input type="number" min="1" step="1" value={value} onChange={(e) => onChange(e.target.value)} required />
      {available !== null && available > 0 && (
        <span className="mt-2 flex gap-2">
          {[0.25, 0.5, 1].map((f) => (
            <button
              key={f}
              type="button"
              className="rounded border border-line px-2 py-0.5 text-xs text-dim hover:border-brand hover:text-brand"
              onClick={() => onChange(String(Math.max(1, Math.floor(available * f))))}
            >
              {f === 1 ? '全部' : `${f * 100}%`}
            </button>
          ))}
        </span>
      )}
    </Field>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex justify-between gap-3">
      <dt className="text-dim">{label}</dt>
      <dd className="font-mono">{children}</dd>
    </div>
  );
}

function MyOrders({ market, data }: { market: MarketDetail; data: ExchangeState }) {
  const action = useExchangeAction(market.id, '已撤单');
  const openCount = data.orders.filter((o) => o.status === 'open').length;
  return (
    <Card className="p-5">
      {market.mimic ? (
        <h3 className="mb-2 font-semibold">我的成交</h3>
      ) : (
        <>
          <h3 className="mb-1 font-semibold">我的订单 · 未成交 {openCount} 笔</h3>
          <p className="mb-2 text-xs text-faint">撤单释放未成交部分的冻结资金或份额，已成交部分保留。</p>
        </>
      )}
      <ul className="max-h-56 divide-y divide-line overflow-y-auto">
        {data.orders.map((o) => (
          <li key={o.id} className="py-3 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="flex min-w-0 flex-wrap items-center gap-1.5">
                <Badge>{ORDER_TYPE_LABEL[o.type]}</Badge>
                <span className={o.side === 'buy' ? 'text-yes' : 'text-no'}>{o.side === 'buy' ? '买' : '卖'}</span>
                <span className="truncate">{shareName(market, o)}</span>
                {(o.type === 'GTC' || o.type === 'GTD') && <span className="font-mono">@ {o.price.toFixed(2)}</span>}
                {o.postOnly && <span className="text-faint">Post-only</span>}
              </span>
              {o.status === 'open' ? (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  aria-label={`撤销订单 #${o.id}`}
                  loading={action.isPending}
                  onClick={() => action.mutate(() => api.cancelOrder(market.id, o.id))}
                >
                  撤单
                </Button>
              ) : (
                <span className="shrink-0 text-faint">
                  {o.status === 'filled' ? '全部成交' : o.quantity > o.remaining ? '部分成交' : '已撤销'}
                </span>
              )}
            </div>
            <p className="mt-1 text-faint">
              #{o.id} · 成交 {o.quantity - o.remaining} / {o.quantity} 份
              {o.amount !== null && ` · 按 ${formatMoney(o.amount)} 水滴买入`}
              {o.expiresAt !== null && o.status === 'open' && ` · ${formatDate(o.expiresAt)} 到期`}
            </p>
          </li>
        ))}
      </ul>
      {!data.orders.length && <p className="text-xs text-faint">暂无订单</p>}
    </Card>
  );
}

/** The price shown for an option (the Yes price; No is the rest). */
function markPrice(market: MarketDetail, s: ShareRef): number | null {
  const o = market.outcomes.find((x) => x.id === s.outcomeId);
  if (!o) return null;
  return s.token === 'no' ? 1 - o.probability : o.probability;
}

/** Whether a share paid out in a resolved market. */
function pays(market: MarketDetail, s: ShareRef): boolean {
  const won = s.outcomeId === market.resolvedOutcomeId;
  return s.token === 'no' ? !won : won;
}

/** Shares held in this market with cost and an estimated value, plus split / merge / convert. */
export function ExchangePositions({
  market,
  data,
  onSell,
}: {
  market: MarketDetail;
  data: ExchangeState | undefined;
  onSell: (share: ShareRef, quantity: number) => void;
}) {
  const { me } = useMe();
  const multi = isMultiExchange(market);
  const [pairs, setPairs] = useState('10');
  const [pairOutcome, setPairOutcome] = useState(market.outcomes[0]!.id);
  const [convertIds, setConvertIds] = useState<number[]>([]);
  const action = useExchangeAction(market.id);
  if (!me || !data) return null;
  const held = data.positions.filter((p) => p.quantity > 0);
  const open = market.status === 'open';
  const count = Number(pairs);
  const validCount = shareAmountSchema.safeParse({ quantity: count }).success;
  const free = (s: ShareRef) => {
    const p = data.positions.find((x) => sameShare(x, s));
    return (p?.quantity ?? 0) - (p?.reserved ?? 0);
  };
  const mergeable = Math.min(...sharePair(market, pairOutcome).map(free));
  const convertible = convertIds.length ? Math.min(...convertIds.map((id) => free({ outcomeId: id, token: 'no' }))) : 0;

  return (
    <Card className="space-y-4 p-5">
      <h2 className="font-semibold">我的持仓</h2>
      {held.length === 0 ? (
        <p className="text-sm text-faint">还没有这个市场的份额。</p>
      ) : (
        <ul className="divide-y divide-line">
          {held.map((p) => {
            // Mirrors only load the book of the option in view; the others use the synced price.
            const now =
              market.status === 'resolved'
                ? pays(market, p)
                  ? 1
                  : 0
                : (displayPrice(bookOf(data, p)) ?? markPrice(market, p));
            const value = now === null ? null : now * p.quantity;
            const pnl = value === null ? null : value - p.cost;
            return (
              <li key={`${p.outcomeId}:${p.token}`} className="space-y-1 py-3 text-sm">
                <div className="flex items-center justify-between gap-2">
                  <span className="font-medium">{shareName(market, p)}</span>
                  {open && p.quantity > p.reserved && (
                    <Button size="sm" variant="outline" onClick={() => onSell(p, p.quantity - p.reserved)}>
                      卖出
                    </Button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-3 gap-y-0.5 text-xs text-dim">
                  <span>
                    {p.quantity} 份{p.reserved > 0 && `（挂卖 ${p.reserved}）`}
                  </span>
                  <span>均价 {formatPrice(p.avgPrice)}</span>
                  <span>现价 {formatPrice(now)}</span>
                  <span>
                    估值 {value === null ? '—' : formatMoney(value)}
                    {pnl !== null && (
                      <span className={clsx('ml-1', pnl >= 0 ? 'text-yes' : 'text-no')}>{formatSigned(pnl)}</span>
                    )}
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {held.length > 0 && (
        <p className="text-xs text-faint">估值按当前显示价格计算，只供参考；排行榜和净值只在结算后计入。</p>
      )}
      {open && !market.mimic && (
        <section className="space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">拆分 / 合并</h3>
          {multi && (
            <select
              value={pairOutcome}
              onChange={(e) => setPairOutcome(Number(e.target.value))}
              className="h-9 w-full rounded border border-line bg-panel px-2 text-sm text-fg"
              aria-label="拆分或合并哪个选项"
            >
              {market.outcomes.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label} 的 Yes + No
                </option>
              ))}
            </select>
          )}
          <Input type="number" min="1" step="1" value={pairs} onChange={(e) => setPairs(e.target.value)} />
          <div className="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              disabled={!validCount || count > me.balance}
              loading={action.isPending}
              onClick={() =>
                action.mutate(() => api.splitMerge(market.id, count, 'split', multi ? pairOutcome : undefined))
              }
            >
              抵押生成
            </Button>
            <Button
              variant="outline"
              disabled={!validCount || count > mergeable}
              loading={action.isPending}
              onClick={() =>
                action.mutate(() => api.splitMerge(market.id, count, 'merge', multi ? pairOutcome : undefined))
              }
            >
              合并赎回
            </Button>
          </div>
          <p className="text-xs text-faint">1 水滴 ⇄ 1 Yes + 1 No。合并只用没挂卖的份额，当前可合并 {mergeable} 对。</p>
        </section>
      )}
      {open && multi && !market.mimic && (
        <section className="space-y-3 border-t border-line pt-4">
          <h3 className="text-sm font-semibold">转换 No 份额</h3>
          <div className="flex flex-wrap gap-2">
            {market.outcomes.map((o) => (
              <label key={o.id} className="flex items-center gap-1.5 text-sm text-dim">
                <input
                  type="checkbox"
                  className="accent-brand"
                  checked={convertIds.includes(o.id)}
                  onChange={(e) =>
                    setConvertIds((ids) => (e.target.checked ? [...ids, o.id] : ids.filter((x) => x !== o.id)))
                  }
                />
                {o.label}
              </label>
            ))}
          </div>
          <Button
            variant="outline"
            className="w-full"
            disabled={!validCount || !convertIds.length || count > convertible}
            loading={action.isPending}
            onClick={() => action.mutate(() => api.convert(market.id, convertIds, count))}
          >
            用 {pairs || 0} 份 No 转换
          </Button>
          <p className="text-xs leading-relaxed text-faint">
            只有一个选项会赢：选中 k 个选项的 No 各 1 份，换回 k−1 水滴，外加其余每个选项 1 份 Yes。当前可转换{' '}
            {convertible} 份。
          </p>
        </section>
      )}
    </Card>
  );
}
