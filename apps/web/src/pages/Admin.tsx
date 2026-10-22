import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CURRENCY_NAME,
  WEREWOLF_MAX_PLAYERS,
  WEREWOLF_MIN_PLAYERS,
  type AdminInstanceConfig,
  type AdminOverview,
  type Feature,
  type FeatureState,
} from '@watercooler/shared';
import clsx from 'clsx';
import { RotateCw, ShieldAlert, TriangleAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Money } from '../components/Money';
import { UserPicker } from '../components/UserPicker';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageLoader, Segmented, Stat } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDate, formatRelative } from '../lib/format';
import { usePageTitle } from '../lib/site';

type Tab = 'overview' | 'features' | 'config' | 'money' | 'admins' | 'audit';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: '概览' },
  { value: 'features', label: '功能开关' },
  { value: 'config', label: '配置' },
  { value: 'money', label: `${CURRENCY_NAME}运维` },
  { value: 'admins', label: '管理员' },
  { value: 'audit', label: '操作记录' },
];

const FEATURE_TEXT: Record<Feature, { title: string; hint: string }> = {
  aiBots: { title: 'AI 机器人', hint: '机器人联网出题、下注并公布 AI 专区的结果。需要「配置」里的 AI 模型。' },
  wecom: {
    title: '企业微信机器人',
    hint: '群里 @机器人 绑定账号、聊天下注。需要「配置」里的 AI 模型和企业微信凭证。',
  },
  polymarket: {
    title: 'Polymarket 模式',
    hint: '允许新建订单簿（Yes / No 份额）市场。关闭后已有的这类市场照常交易和结算。',
  },
  werewolf: {
    title: 'AI 狼人杀',
    hint: '一桌 AI 玩家自己打狼人杀，一局接一局、每局之间休息一会儿，发言实时直播，大家押哪边赢或某个玩家会不会出局（奖池模式）。需要「配置」里的 AI 模型，人数也在那里改。每局要调用几十次模型，注意费用。',
  },
  mimic: {
    title: 'Polymarket 镜像盘',
    hint: '每 5 分钟从 polymarket.com 复制最热门的前 K 个事件，大家按它的实时盘口用水滴买卖（对手是本站，不影响 Polymarket），按它的结果自动结算。关闭后已有持仓照常结算。',
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Instance management. Every request behind it is checked for admin rights on the server too. */
export default function AdminPage() {
  usePageTitle('实例管理');
  const { me } = useMe();
  const [params, setParams] = useSearchParams();
  const tab = (TABS.some((t) => t.value === params.get('tab')) ? params.get('tab') : 'overview') as Tab;
  const overview = useQuery({
    queryKey: ['admin', 'overview'],
    queryFn: api.admin.overview,
    enabled: Boolean(me?.isAdmin),
    refetchInterval: 15_000,
  });

  if (!me?.isAdmin) {
    return (
      <Empty icon={<ShieldAlert className="size-10" />} title="需要管理员权限">
        只有管理员可以管理这个实例。
      </Empty>
    );
  }
  if (!overview.data) return <PageLoader />;

  return (
    <div>
      <h1 className="section-title">实例管理</h1>
      {overview.data.restartNeeded && (
        <Card className="mt-4 flex flex-col gap-3 border-gold/40 p-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-start gap-2.5 text-sm">
            <TriangleAlert className="mt-0.5 size-4 shrink-0 text-gold" />
            <span>
              配置已修改，重启实例后才会生效。
              {!overview.data.restartAvailable && ` 在服务器上执行 ${overview.data.instance}.sh restart。`}
            </span>
          </div>
          {overview.data.restartAvailable && <RestartButton data={overview.data} />}
        </Card>
      )}
      <p className="mt-2 text-sm text-dim">
        {`实例 ${overview.data.instance} · ${overview.data.release ? `版本 ${overview.data.release}` : '本地开发环境'} · 启动于 ${formatRelative(overview.data.startedAt)}`}
      </p>
      {/* Five tabs do not fit a phone: let the strip scroll instead of the page. */}
      <div className="mt-6 overflow-x-auto">
        <Segmented
          className="min-w-max"
          variant="tabs"
          value={tab}
          onChange={(t) => setParams(t === 'overview' ? {} : { tab: t }, { replace: true })}
          options={TABS}
        />
      </div>
      <div className="mt-6">
        {tab === 'overview' && <OverviewTab data={overview.data} />}
        {tab === 'features' && <FeaturesTab features={overview.data.features} topK={overview.data.mimicTopK} />}
        {tab === 'config' && <ConfigTab />}
        {tab === 'money' && <MoneyTab money={overview.data.money} />}
        {tab === 'admins' && <AdminsTab myId={me.id} />}
        {tab === 'audit' && <AuditTab />}
      </div>
    </div>
  );
}

function MoneyStats({ money }: { money: AdminOverview['money'] }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      <Stat label="用户">{money.users}</Stat>
      <Stat label="可用余额合计">
        <Money value={money.balances} />
      </Stat>
      <Stat label="押在未结算市场">
        <Money value={money.inMarkets} />
      </Stat>
      <Stat label="累计发放">
        <Money value={money.funded} />
      </Stat>
    </div>
  );
}

/** Restart with a confirmation, then wait until the new process answers. */
function RestartButton({ data, variant = 'primary' }: { data: AdminOverview; variant?: 'primary' | 'outline' }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const restart = useMutation({
    mutationFn: api.admin.restart,
    onSuccess: async () => {
      setConfirming(false);
      setRestarting(true);
      // The new process reports a later start time once it is back.
      for (let i = 0; i < 60; i++) {
        await sleep(1500);
        const fresh = await api.admin.overview().catch(() => null);
        if (fresh && fresh.startedAt > data.startedAt + 1000) {
          qc.setQueryData(['admin', 'overview'], fresh);
          void qc.invalidateQueries();
          setRestarting(false);
          toast.success('实例已重启');
          return;
        }
      }
      setRestarting(false);
      toast.error('等了一分半还没恢复，请到服务器上看日志');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <>
      <Button
        variant={variant}
        disabled={!data.restartAvailable || restarting}
        loading={restarting}
        onClick={() => setConfirming(true)}
      >
        {!restarting && <RotateCw className="size-4" />}
        {restarting ? '正在重启…' : '重启实例'}
      </Button>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="重启实例">
        <p className="text-sm leading-relaxed text-dim">
          网站会中断几秒钟，正在进行的请求会失败；数据不受影响。确定重启 {data.instance} 吗？
        </p>
        <Button className="mt-5 w-full" loading={restart.isPending} onClick={() => restart.mutate()}>
          确认重启
        </Button>
      </Modal>
    </>
  );
}

function OverviewTab({ data }: { data: AdminOverview }) {
  return (
    <div className="space-y-6">
      <MoneyStats money={data.money} />
      <Card className="p-6">
        <h2 className="font-semibold">功能状态</h2>
        <ul className="mt-3 divide-y divide-line">
          {data.features.map((f) => (
            <li key={f.key} className="flex items-center justify-between gap-4 py-2.5 text-sm">
              <span>{FEATURE_TEXT[f.key].title}</span>
              <FeatureStatus feature={f} />
            </li>
          ))}
        </ul>
      </Card>
      <Card className="flex flex-col gap-4 p-6 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h2 className="font-semibold">重启实例</h2>
          <p className="mt-1 text-sm text-dim">
            {data.restartAvailable
              ? '在「配置」里改过设置后需要重启才生效。重启时网站会中断几秒钟。'
              : '只有服务器上部署的实例可以在线重启。'}
          </p>
        </div>
        <RestartButton data={data} variant="outline" />
      </Card>
    </div>
  );
}

function FeatureStatus({ feature }: { feature: FeatureState }) {
  if (!feature.enabled) return <span className="text-faint">已关闭</span>;
  if (feature.active) return <span className="text-yes">运行中</span>;
  // On without its credentials is a misconfiguration, not "off".
  return (
    <span className={clsx('text-right', feature.configured === false ? 'text-no' : 'text-gold')}>
      {feature.problem ?? '未运行'}
    </span>
  );
}

function Switch({
  checked,
  disabled,
  onChange,
  label,
}: {
  checked: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={clsx(
        'relative h-6 w-11 shrink-0 rounded-full transition-colors disabled:opacity-50',
        checked ? 'bg-brand' : 'bg-line-strong',
      )}
    >
      <span
        className={clsx(
          'absolute top-0.5 size-5 rounded-full bg-panel shadow transition-all',
          checked ? 'left-[22px]' : 'left-0.5',
        )}
      />
    </button>
  );
}

function FeaturesTab({ features, topK }: { features: FeatureState[]; topK: number }) {
  const qc = useQueryClient();
  const toggle = useMutation({
    mutationFn: ({ key, enabled }: { key: Feature; enabled: boolean }) => api.admin.setFeature(key, enabled),
    onSuccess: (data, { key, enabled }) => {
      qc.setQueryData(['admin', 'overview'], data);
      // The site's own config (AI zone, WeCom, Polymarket) changes with the flags.
      void qc.invalidateQueries({ queryKey: ['config'] });
      toast.success(`已${enabled ? '开启' : '关闭'}「${FEATURE_TEXT[key].title}」`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const blocked = (f: FeatureState) => f.requires !== undefined && !features.find((x) => x.key === f.requires)?.enabled;

  return (
    <Card className="divide-y divide-line">
      {features.map((f) => (
        <div key={f.key} className="flex items-start gap-4 p-5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{FEATURE_TEXT[f.key].title}</span>
              {f.configured === false && <Badge>缺少配置</Badge>}
            </div>
            <p className="mt-1 text-sm text-dim">{FEATURE_TEXT[f.key].hint}</p>
            <p className="mt-1.5 text-xs">
              <FeatureStatus feature={f} />
            </p>
            {f.enabled && f.status && <p className="mt-1 text-xs text-faint">{f.status}</p>}
            {!f.enabled && f.configured === false && (
              <p className="mt-1 text-xs text-faint">先在「配置」里填好并重启实例，才能打开。</p>
            )}
            {!f.enabled && blocked(f) && (
              <p className="mt-1 text-xs text-faint">先打开「{FEATURE_TEXT[f.requires!].title}」才能打开。</p>
            )}
            {f.key === 'mimic' && <MimicTopK topK={topK} />}
          </div>
          <Switch
            label={FEATURE_TEXT[f.key].title}
            checked={f.enabled}
            // Without credentials, or what it builds on, a feature can only be switched off, never on.
            disabled={toggle.isPending || (!f.enabled && (f.configured === false || blocked(f)))}
            onChange={(enabled) => toggle.mutate({ key: f.key, enabled })}
          />
        </div>
      ))}
      <p className="p-5 text-xs leading-relaxed text-faint">
        开关立即生效，不用重启。AI 机器人、企业微信机器人和 AI
        狼人杀要用到「配置」里的凭证，凭证改过后要重启实例才生效。
      </p>
    </Card>
  );
}

function MimicTopK({ topK }: { topK: number }) {
  const qc = useQueryClient();
  const [value, setValue] = useState(String(topK));
  const save = useMutation({
    mutationFn: () => api.admin.setMimicTopK(Number(value)),
    onSuccess: (data) => {
      qc.setQueryData(['admin', 'overview'], data);
      toast.success(`改为镜像前 ${data.mimicTopK} 个，马上同步一次`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const n = Number(value);
  return (
    <form
      className="mt-3 flex items-center gap-2 text-sm"
      onSubmit={(e) => {
        e.preventDefault();
        save.mutate();
      }}
    >
      <span className="shrink-0 whitespace-nowrap text-dim">镜像前</span>
      <span className="w-20 shrink-0">
        <Input
          type="number"
          min={1}
          max={100}
          className="h-8"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          aria-label="镜像前 K 个热门事件"
        />
      </span>
      <span className="shrink-0 whitespace-nowrap text-dim">个热门事件</span>
      <Button
        type="submit"
        size="sm"
        variant="outline"
        loading={save.isPending}
        disabled={!Number.isInteger(n) || n < 1 || n > 100 || n === topK}
      >
        保存
      </Button>
    </form>
  );
}

function MoneyTab({ money }: { money: AdminOverview['money'] }) {
  const qc = useQueryClient();
  const [q, setQ] = useState('');
  const users = useQuery({ queryKey: ['admin', 'users', q], queryFn: () => api.admin.users(q) });
  const [username, setUsername] = useState('');
  const [direction, setDirection] = useState<'add' | 'take'>('add');
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [allAmount, setAllAmount] = useState('');
  const [allReason, setAllReason] = useState('');
  const [confirm, setConfirm] = useState<'one' | 'all' | null>(null);

  const done = (message: string) => {
    setConfirm(null);
    void qc.invalidateQueries({ queryKey: ['admin'] });
    void qc.invalidateQueries({ queryKey: ['me'] });
    toast.success(message);
  };
  const adjust = useMutation({
    mutationFn: () => api.admin.adjustBalance(username, (direction === 'add' ? 1 : -1) * Number(amount), reason),
    onSuccess: (u) => {
      setAmount('');
      setReason('');
      done(`${u.displayName} 现在有 ${u.balance} ${CURRENCY_NAME}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const grantAll = useMutation({
    mutationFn: () => api.admin.grantAll(Number(allAmount), allReason),
    onSuccess: (r) => {
      setAllAmount('');
      setAllReason('');
      done(`已给 ${r.users} 人每人发放 ${allAmount} ${CURRENCY_NAME}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  const oneReady = username.trim() && Number(amount) > 0 && reason.trim().length >= 2;
  const allReady = Number(allAmount) > 0 && allReason.trim().length >= 2;
  const submit = (kind: 'one' | 'all') => (e: FormEvent) => {
    e.preventDefault();
    if (kind === 'one' ? oneReady : allReady) setConfirm(kind);
  };

  return (
    <div className="space-y-6">
      <MoneyStats money={money} />
      <p className="text-xs text-faint">
        管理员发放和扣除都记在流水里（「管理员调整」），算作发放的资金，不计入盈利排行。
      </p>
      <div className="grid gap-6 lg:grid-cols-2">
        <Card className="p-6">
          <h2 className="font-semibold">给一个人加减{CURRENCY_NAME}</h2>
          <form className="mt-4 space-y-4" onSubmit={submit('one')}>
            <Field label="用户名" hint="输入用户名或昵称的几个字母，或在下方列表点选">
              <UserPicker value={username} onChange={setUsername} />
            </Field>
            <Segmented
              value={direction}
              onChange={setDirection}
              options={[
                { value: 'add', label: '发放' },
                { value: 'take', label: '扣除' },
              ]}
            />
            <Field label={`金额（${CURRENCY_NAME}）`}>
              <Input type="number" min={0} step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </Field>
            <Field label="原因" hint="会写进对方的流水和操作记录">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={200} />
            </Field>
            <Button type="submit" disabled={!oneReady}>
              {direction === 'add' ? '发放' : '扣除'}
            </Button>
          </form>
        </Card>
        <Card className="p-6">
          <h2 className="font-semibold">全员发放</h2>
          <form className="mt-4 space-y-4" onSubmit={submit('all')}>
            <Field label={`每人金额（${CURRENCY_NAME}）`}>
              <Input
                type="number"
                min={0}
                step="0.01"
                value={allAmount}
                onChange={(e) => setAllAmount(e.target.value)}
              />
            </Field>
            <Field label="原因" hint="比如节日福利、补偿">
              <Input value={allReason} onChange={(e) => setAllReason(e.target.value)} maxLength={200} />
            </Field>
            <Button type="submit" disabled={!allReady}>
              发给所有人
            </Button>
          </form>
        </Card>
      </div>

      <Card className="p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="font-semibold">用户</h2>
          <Input
            className="sm:max-w-60"
            placeholder="搜索用户名或昵称"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <ul className="mt-3 divide-y divide-line">
          {users.data?.map((u) => (
            <li key={u.id}>
              <button
                type="button"
                onClick={() => setUsername(u.username)}
                className="flex w-full items-center gap-3 py-2.5 text-left text-sm transition hover:text-brand"
              >
                <span className="min-w-0 flex-1 truncate">
                  {u.displayName} <span className="text-faint">@{u.username}</span>
                </span>
                {u.isAdmin && <Badge>管理员</Badge>}
                <Money value={u.balance} className="font-mono" />
              </button>
            </li>
          ))}
          {users.data?.length === 0 && <li className="py-4 text-center text-sm text-faint">没有找到用户</li>}
        </ul>
      </Card>

      <Modal
        open={confirm !== null}
        onClose={() => setConfirm(null)}
        title={confirm === 'all' ? '确认全员发放' : '确认调整'}
      >
        <p className="text-sm leading-relaxed text-dim">
          {confirm === 'all'
            ? `给全部 ${money.users} 位用户每人发放 ${allAmount} ${CURRENCY_NAME}，原因：${allReason}`
            : `${direction === 'add' ? '给' : '从'} ${username} ${direction === 'add' ? '发放' : '扣除'} ${amount} ${CURRENCY_NAME}，原因：${reason}`}
        </p>
        <Button
          className="mt-5 w-full"
          loading={adjust.isPending || grantAll.isPending}
          onClick={() => (confirm === 'all' ? grantAll.mutate() : adjust.mutate())}
        >
          确认
        </Button>
      </Modal>
    </div>
  );
}

function AdminsTab({ myId }: { myId: number }) {
  const qc = useQueryClient();
  const users = useQuery({ queryKey: ['admin', 'users', ''], queryFn: () => api.admin.users() });
  const [username, setUsername] = useState('');
  const onDone = (message: string) => {
    void qc.invalidateQueries({ queryKey: ['admin'] });
    toast.success(message);
  };
  const add = useMutation({
    mutationFn: () => api.admin.addAdmin(username),
    onSuccess: (u) => {
      setUsername('');
      onDone(`${u.displayName} 已设为管理员`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const remove = useMutation({
    mutationFn: api.admin.removeAdmin,
    onSuccess: (u) => onDone(`已取消 ${u.displayName} 的管理员身份`),
    onError: (err) => toast.error(errorMessage(err)),
  });
  const admins = users.data?.filter((u) => u.isAdmin) ?? [];

  return (
    <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
      <Card className="p-6">
        <h2 className="font-semibold">现在的管理员</h2>
        <ul className="mt-3 divide-y divide-line">
          {admins.map((u) => (
            <li key={u.id} className="flex items-center gap-3 py-2.5 text-sm">
              <span className="min-w-0 flex-1 truncate">
                {u.displayName} <span className="text-faint">@{u.username}</span>
              </span>
              {u.id === myId ? (
                <span className="text-xs text-faint">你自己</span>
              ) : (
                <Button
                  size="sm"
                  variant="danger"
                  loading={remove.isPending && remove.variables === u.username}
                  onClick={() => remove.mutate(u.username)}
                >
                  取消管理员
                </Button>
              )}
            </li>
          ))}
        </ul>
      </Card>
      <Card className="p-6">
        <h2 className="font-semibold">添加管理员</h2>
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (username.trim()) add.mutate();
          }}
        >
          <Field label="用户名" hint="管理员可以开关功能、重启实例、调整任何人的余额">
            <UserPicker value={username} onChange={setUsername} exclude={(u) => u.isAdmin} />
          </Field>
          <Button type="submit" disabled={!username.trim()} loading={add.isPending}>
            设为管理员
          </Button>
        </form>
      </Card>
    </div>
  );
}

function AuditTab() {
  const { data, fetchNextPage, hasNextPage, isFetchingNextPage, isPending } = useInfiniteQuery({
    queryKey: ['admin', 'audit'],
    queryFn: ({ pageParam }) => api.admin.audit(pageParam),
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last) => (last.length === 50 ? last.at(-1)!.id : undefined),
  });
  const entries = data?.pages.flat() ?? [];
  if (isPending) return <PageLoader />;
  return (
    <Card className="p-6">
      <ul className="divide-y divide-line">
        {entries.map((a) => (
          <li key={a.id} className="flex flex-col gap-1 py-3 text-sm sm:flex-row sm:items-start sm:gap-4">
            <span className="shrink-0 text-xs text-faint sm:w-36 sm:pt-0.5">{formatDate(a.createdAt)}</span>
            <span className="shrink-0 font-medium sm:w-28 sm:truncate">{a.admin.displayName}</span>
            <span className="min-w-0 flex-1 text-dim">{a.detail}</span>
          </li>
        ))}
        {entries.length === 0 && <li className="py-6 text-center text-sm text-faint">还没有管理操作</li>}
      </ul>
      {hasNextPage && (
        <Button
          className="mt-4"
          variant="outline"
          size="sm"
          loading={isFetchingNextPage}
          onClick={() => fetchNextPage()}
        >
          加载更多
        </Button>
      )}
    </Card>
  );
}

/** Save a config form: the server writes the file, and the restart banner appears. */
function useSaveConfig<T>(save: (input: T) => Promise<AdminInstanceConfig>, done = '已保存，重启实例后生效') {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: save,
    onSuccess: (config) => {
      qc.setQueryData(['admin', 'config'], config);
      void qc.invalidateQueries({ queryKey: ['admin', 'overview'] });
      void qc.invalidateQueries({ queryKey: ['admin', 'audit'] });
      toast.success(done);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
}

/** Numbers typed into inputs; empty stays empty instead of becoming 0. */
const numberField = (value: string) => (value.trim() === '' ? NaN : Number(value));

function ConfigTab() {
  const { data } = useQuery({ queryKey: ['admin', 'config'], queryFn: api.admin.config });
  if (!data) return <PageLoader />;
  return (
    <div className="space-y-6">
      <p className="text-sm text-dim">
        这里改的是服务器上的 bot.json 和 .env，保存后要重启实例才生效。密钥只显示末四位，留空表示不改。
      </p>
      {data.botError && (
        <p className="rounded border border-no/40 px-4 py-3 text-sm text-no">
          服务器上的 bot.json 有问题：{data.botError}
        </p>
      )}
      <div className="grid gap-6 lg:grid-cols-2">
        {/* Keyed by the saved values so each form starts over after a save; the prefixes keep the keys distinct. */}
        <AiConfigForm key={`ai:${JSON.stringify(data.ai)}`} ai={data.ai} />
        <WecomConfigForm key={`wecom:${JSON.stringify(data.wecom)}`} wecom={data.wecom} hasAi={data.ai !== null} />
      </div>
      <div className="grid gap-6 lg:grid-cols-2">
        <WerewolfConfigForm key={`werewolf:${JSON.stringify(data.werewolf)}`} werewolf={data.werewolf} />
      </div>
      <SiteConfigForm key={`site:${JSON.stringify(data.site)}`} site={data.site} />
    </div>
  );
}

function AiConfigForm({ ai }: { ai: AdminInstanceConfig['ai'] }) {
  const [endpoint, setEndpoint] = useState(ai?.endpoint ?? 'https://api.anthropic.com');
  const [apiKey, setApiKey] = useState('');
  const [model, setModel] = useState(ai?.model ?? '');
  const [bots, setBots] = useState(String(ai?.bots ?? 50));
  const [marketsPerDay, setMarketsPerDay] = useState(String(ai?.marketsPerDay ?? 2));
  const [betsPerDay, setBetsPerDay] = useState(String(ai?.betsPerDay ?? 50));
  const [flip, setFlip] = useState(String(ai?.flipProbability ?? 0.2));
  const save = useSaveConfig(api.admin.saveAi);

  return (
    <Card className="p-6">
      <h2 className="font-semibold">AI 模型</h2>
      <p className="mt-1 text-xs text-faint">AI 机器人和企业微信聊天共用；Anthropic Messages API 或兼容的中转。</p>
      <form
        className="mt-4 space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate(
            {
              endpoint: endpoint.trim(),
              apiKey: apiKey.trim() || undefined,
              model: model.trim(),
              bots: numberField(bots),
              marketsPerDay: numberField(marketsPerDay),
              betsPerDay: numberField(betsPerDay),
              flipProbability: numberField(flip),
            },
            // Never keep a typed secret around once it is saved.
            { onSuccess: () => setApiKey('') },
          );
        }}
      >
        <Field label="Endpoint">
          <Input value={endpoint} onChange={(e) => setEndpoint(e.target.value)} />
        </Field>
        <Field label="API key" hint={ai?.apiKeyHint ? `${ai.apiKeyHint}，留空不改` : undefined}>
          <Input
            type="password"
            autoComplete="off"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={ai?.apiKeyHint ? '留空表示不改' : '必填'}
          />
        </Field>
        <Field label="模型">
          <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="例如 claude-opus-5-5" />
        </Field>
        <div className="grid grid-cols-2 gap-4">
          <Field label="机器人数量">
            <Input type="number" min={1} value={bots} onChange={(e) => setBots(e.target.value)} />
          </Field>
          <Field label="押反概率" hint="0 到 1">
            <Input type="number" min={0} max={1} step="0.05" value={flip} onChange={(e) => setFlip(e.target.value)} />
          </Field>
          <Field label="每天出题上限" hint="最花钱的部分">
            <Input type="number" min={0} value={marketsPerDay} onChange={(e) => setMarketsPerDay(e.target.value)} />
          </Field>
          <Field label="每天下注上限">
            <Input type="number" min={0} value={betsPerDay} onChange={(e) => setBetsPerDay(e.target.value)} />
          </Field>
        </div>
        <Button type="submit" loading={save.isPending} disabled={!endpoint.trim() || !model.trim()}>
          保存
        </Button>
      </form>
    </Card>
  );
}

function WecomConfigForm({ wecom, hasAi }: { wecom: AdminInstanceConfig['wecom']; hasAi: boolean }) {
  const [botId, setBotId] = useState(wecom?.botId ?? '');
  const [secret, setSecret] = useState('');
  const [siteUrl, setSiteUrl] = useState(
    wecom?.siteUrl ?? `${window.location.origin}${import.meta.env.BASE_URL}`.replace(/\/+$/, ''),
  );
  const [siteName, setSiteName] = useState(wecom?.siteName ?? 'Watercooler');
  const [perHour, setPerHour] = useState(String(wecom?.messagesPerHour ?? 30));
  const save = useSaveConfig(api.admin.saveWecom);
  const remove = useSaveConfig(api.admin.removeWecom, '已移除，重启实例后生效');

  return (
    <Card className="p-6">
      <h2 className="font-semibold">企业微信机器人</h2>
      <p className="mt-1 text-xs text-faint">企业微信智能机器人，连接方式选「长连接」。</p>
      {!hasAi ? (
        <p className="mt-4 text-sm text-dim">先保存左边的 AI 模型配置：企业微信聊天用的是同一个模型。</p>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate(
              {
                botId: botId.trim(),
                secret: secret.trim() || undefined,
                siteUrl: siteUrl.trim(),
                siteName: siteName.trim(),
                messagesPerHour: numberField(perHour),
              },
              { onSuccess: () => setSecret('') },
            );
          }}
        >
          <Field label="Bot ID">
            <Input value={botId} onChange={(e) => setBotId(e.target.value)} />
          </Field>
          <Field label="Secret" hint={wecom?.secretHint ? `${wecom.secretHint}，留空不改` : undefined}>
            <Input
              type="password"
              autoComplete="off"
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={wecom?.secretHint ? '留空表示不改' : '必填'}
            />
          </Field>
          <Field label="网站地址" hint="绑定链接和市场链接用这个地址">
            <Input value={siteUrl} onChange={(e) => setSiteUrl(e.target.value)} />
          </Field>
          <div className="grid grid-cols-2 gap-4">
            <Field label="网站名称">
              <Input value={siteName} onChange={(e) => setSiteName(e.target.value)} />
            </Field>
            <Field label="每人每小时消息上限">
              <Input type="number" min={1} value={perHour} onChange={(e) => setPerHour(e.target.value)} />
            </Field>
          </div>
          <div className="flex flex-wrap gap-3">
            <Button type="submit" loading={save.isPending} disabled={!botId.trim() || !siteUrl.trim()}>
              保存
            </Button>
            {wecom && (
              <Button
                type="button"
                variant="danger"
                loading={remove.isPending}
                onClick={() => remove.mutate(undefined)}
              >
                移除企业微信配置
              </Button>
            )}
          </div>
        </form>
      )}
    </Card>
  );
}

function WerewolfConfigForm({ werewolf }: { werewolf: AdminInstanceConfig['werewolf'] }) {
  const [players, setPlayers] = useState(String(werewolf?.players ?? 9));
  const [rest, setRest] = useState(String(werewolf?.restMinutes ?? 10));
  const [model, setModel] = useState(werewolf?.model ?? '');
  const save = useSaveConfig(api.admin.saveWerewolf);

  return (
    <Card className="p-6">
      <h2 className="font-semibold">AI 狼人杀</h2>
      <p className="mt-1 text-xs text-faint">
        {`${WEREWOLF_MIN_PLAYERS} 到 ${WEREWOLF_MAX_PLAYERS} 人，三分之一是狼人，配预言家、女巫，8 人起加猎人。场上剩一半人时停止下注。新设置从重启后的下一局开始。`}
      </p>
      {!werewolf ? (
        <p className="mt-4 text-sm text-dim">先保存 AI 模型配置：狼人杀的玩家用的是同一个 API key。</p>
      ) : (
        <form
          className="mt-4 space-y-4"
          onSubmit={(e) => {
            e.preventDefault();
            save.mutate({ players: numberField(players), restMinutes: numberField(rest), model: model.trim() });
          }}
        >
          <div className="grid grid-cols-2 gap-4">
            <Field label="玩家人数">
              <Input
                type="number"
                min={WEREWOLF_MIN_PLAYERS}
                max={WEREWOLF_MAX_PLAYERS}
                value={players}
                onChange={(e) => setPlayers(e.target.value)}
              />
            </Field>
            <Field label="每局之间休息（分钟）">
              <Input type="number" min={1} max={120} value={rest} onChange={(e) => setRest(e.target.value)} />
            </Field>
          </div>
          <Field label="玩家用的模型" hint="留空和 AI 模型配置一样；可以换成更便宜的模型省钱">
            <Input value={model} onChange={(e) => setModel(e.target.value)} placeholder="和 AI 模型一样" />
          </Field>
          <Button type="submit" loading={save.isPending}>
            保存
          </Button>
        </form>
      )}
    </Card>
  );
}

function SiteConfigForm({ site }: { site: AdminInstanceConfig['site'] }) {
  const [inviteCode, setInviteCode] = useState(site.inviteCode);
  const [privateMode, setPrivateMode] = useState(site.privateMode);
  const [startingBalance, setStartingBalance] = useState(String(site.startingBalance));
  const [dailyBonus, setDailyBonus] = useState(String(site.dailyBonus));
  const [timezone, setTimezone] = useState(site.timezone);
  const save = useSaveConfig(api.admin.saveSite);

  return (
    <Card className="p-6">
      <h2 className="font-semibold">站点设置</h2>
      <form
        className="mt-4 grid gap-4 sm:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          save.mutate({
            inviteCode: inviteCode.trim(),
            privateMode,
            startingBalance: numberField(startingBalance),
            dailyBonus: numberField(dailyBonus),
            timezone: timezone.trim(),
          });
        }}
      >
        <Field label="邀请码" hint="留空表示注册不需要邀请码">
          <Input value={inviteCode} onChange={(e) => setInviteCode(e.target.value)} />
        </Field>
        <Field label="时区" hint="「每日」签到按这个时区算">
          <Input value={timezone} onChange={(e) => setTimezone(e.target.value)} />
        </Field>
        <Field label={`注册赠送（${CURRENCY_NAME}）`}>
          <Input type="number" min={0} value={startingBalance} onChange={(e) => setStartingBalance(e.target.value)} />
        </Field>
        <Field label={`每日签到（${CURRENCY_NAME}）`} hint="0 表示关闭签到">
          <Input type="number" min={0} value={dailyBonus} onChange={(e) => setDailyBonus(e.target.value)} />
        </Field>
        <div className="flex items-center justify-between gap-4 rounded border border-line px-4 py-3 sm:col-span-2">
          <div>
            <div className="text-sm">私有模式</div>
            <div className="text-xs text-faint">打开后，没登录的人什么都看不到</div>
          </div>
          <Switch label="私有模式" checked={privateMode} onChange={setPrivateMode} />
        </div>
        <div className="sm:col-span-2">
          <Button type="submit" loading={save.isPending}>
            保存
          </Button>
        </div>
      </form>
    </Card>
  );
}
