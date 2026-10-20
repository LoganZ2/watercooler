import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCY_NAME, type AdminOverview, type Feature, type FeatureState } from '@watercooler/shared';
import clsx from 'clsx';
import { RotateCw, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Money } from '../components/Money';
import { Badge, Button, Card, Empty, Field, Input, Modal, PageLoader, Segmented, Stat } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { formatDate, formatRelative } from '../lib/format';

type Tab = 'overview' | 'features' | 'money' | 'admins' | 'audit';
const TABS: { value: Tab; label: string }[] = [
  { value: 'overview', label: '概览' },
  { value: 'features', label: '功能开关' },
  { value: 'money', label: `${CURRENCY_NAME}运维` },
  { value: 'admins', label: '管理员' },
  { value: 'audit', label: '操作记录' },
];

const FEATURE_TEXT: Record<Feature, { title: string; hint: string }> = {
  aiBots: { title: 'AI 机器人', hint: '机器人联网出题、下注并公布 AI 专区的结果。需要服务器上的 bot.json。' },
  wecom: { title: '企业微信机器人', hint: '群里 @机器人 绑定账号、聊天下注。需要 bot.json 里的 wecom 配置。' },
  polymarket: {
    title: 'Polymarket 模式',
    hint: '允许新建订单簿（Yes / No 份额）市场。关闭后已有的这类市场照常交易和结算。',
  },
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Instance management. Every request behind it is checked for admin rights on the server too. */
export default function AdminPage() {
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
        {tab === 'features' && <FeaturesTab features={overview.data.features} />}
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

function OverviewTab({ data }: { data: AdminOverview }) {
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
              ? '改了服务器上的 .env 之类的配置后需要重启。重启时网站会中断几秒钟。'
              : '只有服务器上部署的实例可以在线重启。'}
          </p>
        </div>
        <Button
          variant="outline"
          disabled={!data.restartAvailable || restarting}
          loading={restarting}
          onClick={() => setConfirming(true)}
        >
          {!restarting && <RotateCw className="size-4" />}
          {restarting ? '正在重启…' : '重启'}
        </Button>
      </Card>
      <Modal open={confirming} onClose={() => setConfirming(false)} title="重启实例">
        <p className="text-sm leading-relaxed text-dim">
          网站会中断几秒钟，正在进行的请求会失败；数据不受影响。确定重启 {data.instance} 吗？
        </p>
        <Button className="mt-5 w-full" loading={restart.isPending} onClick={() => restart.mutate()}>
          确认重启
        </Button>
      </Modal>
    </div>
  );
}

function FeatureStatus({ feature }: { feature: FeatureState }) {
  if (!feature.enabled) return <span className="text-faint">已关闭</span>;
  if (feature.active) return <span className="text-yes">运行中</span>;
  return <span className="text-right text-gold">{feature.problem ?? '未运行'}</span>;
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

function FeaturesTab({ features }: { features: FeatureState[] }) {
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
          </div>
          <Switch
            label={FEATURE_TEXT[f.key].title}
            checked={f.enabled}
            disabled={toggle.isPending}
            onChange={(enabled) => toggle.mutate({ key: f.key, enabled })}
          />
        </div>
      ))}
      <p className="p-5 text-xs leading-relaxed text-faint">
        开关立即生效，不用重启。AI 机器人和企业微信机器人还需要服务器上的 bot.json 提供密钥；改了 bot.json
        后在这里关掉再打开对应开关，就会按新配置重新启动。
      </p>
    </Card>
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
            <Field label="用户名">
              <Input
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="在下方列表点选或直接输入"
              />
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
            <Input value={username} onChange={(e) => setUsername(e.target.value)} />
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
