import { useMutation, useQueryClient } from '@tanstack/react-query';
import { CURRENCY_NAME, registerSchema } from '@watercooler/shared';
import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router';
import { toast } from 'sonner';
import { Logo } from '../components/Layout';
import { Drop } from '../components/Money';
import { Button, Field, Input } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useConfig, useMe } from '../lib/auth';
import { COPY, usePageTitle } from '../lib/site';

function AuthShell({ title, subtitle, children }: { title: string; subtitle: ReactNode; children: ReactNode }) {
  return (
    <div className="flex min-h-[70vh] items-center justify-center py-8">
      <div className="relative w-full max-w-md">
        <div className="surface relative rounded-lg p-8 shadow-[0_12px_40px_rgb(29_33_41/0.06)]">
          <div className="mb-6 flex justify-center">
            <Logo />
          </div>
          <h1 className="text-center text-2xl font-semibold">{title}</h1>
          <p className="mt-1.5 text-center text-sm text-dim">{subtitle}</p>
          <div className="mt-7">{children}</div>
        </div>
      </div>
    </div>
  );
}

function useAfterAuth() {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const next = params.get('next');
  return (user: Awaited<ReturnType<typeof api.login>>['user']) => {
    qc.setQueryData(['me'], { user });
    void qc.invalidateQueries();
    navigate(next && next.startsWith('/') && !next.startsWith('//') ? next : '/', { replace: true });
  };
}

export function Login() {
  usePageTitle('登录');
  const { me } = useMe();
  const done = useAfterAuth();
  const [params] = useSearchParams();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const mutation = useMutation({
    mutationFn: () => api.login(username.trim(), password),
    onSuccess: (res) => done(res.user),
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (me && !mutation.isSuccess) return <Navigate to="/" replace />;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    mutation.mutate();
  };

  return (
    <AuthShell title="欢迎回来" subtitle="登录后继续你的预测">
      <form onSubmit={submit} className="space-y-4">
        <Field label="用户名">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>
        <Field label="密码">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>
        <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
          登录
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-dim">
        还没有账号？{' '}
        <Link to={`/register${params.toString() ? `?${params}` : ''}`} className="text-brand hover:underline">
          注册一个
        </Link>
      </p>
      <p className="mt-2 text-center text-xs text-faint">忘记密码请联系站长重置</p>
    </AuthShell>
  );
}

export function Register() {
  usePageTitle('注册');
  const { me } = useMe();
  const config = useConfig();
  const done = useAfterAuth();
  const [params] = useSearchParams();
  const [form, setForm] = useState({ username: '', displayName: '', password: '', inviteCode: '' });
  const set = (key: keyof typeof form) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm((f) => ({ ...f, [key]: e.target.value }));
  const mutation = useMutation({
    mutationFn: () => {
      const parsed = registerSchema.safeParse({ ...form, inviteCode: form.inviteCode || undefined });
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message);
      return api.register(parsed.data);
    },
    onSuccess: (res) => {
      toast.success(`注册成功，送你 ${config?.startingBalance ?? ''} ${CURRENCY_NAME}`);
      done(res.user);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  if (me && !mutation.isSuccess) return <Navigate to="/" replace />;

  return (
    <AuthShell
      title={COPY.registerTitle}
      subtitle={
        <span className="inline-flex items-center gap-1">
          注册即送 <Drop /> <b className="text-fg">{config?.startingBalance ?? 1000}</b> {CURRENCY_NAME}
          {config && config.dailyBonus > 0 && <>，每日签到再领 {config.dailyBonus}</>}
        </span>
      }
    >
      <form
        onSubmit={(e) => {
          e.preventDefault();
          mutation.mutate();
        }}
        className="space-y-4"
      >
        <Field label="用户名" hint="登录用，字母数字下划线，注册后不可修改">
          <Input value={form.username} onChange={set('username')} autoComplete="username" autoFocus required />
        </Field>
        <Field label="昵称" hint="其他人看到的名字，比如你的花名">
          <Input value={form.displayName} onChange={set('displayName')} required maxLength={24} />
        </Field>
        <Field label="密码" hint="至少 6 位">
          <Input
            type="password"
            value={form.password}
            onChange={set('password')}
            autoComplete="new-password"
            required
          />
        </Field>
        {config?.inviteRequired && (
          <Field label="邀请码" hint="问问拉你进来的人">
            <Input value={form.inviteCode} onChange={set('inviteCode')} required />
          </Field>
        )}
        <Button type="submit" size="lg" className="w-full" loading={mutation.isPending}>
          注册
        </Button>
      </form>
      <p className="mt-6 text-center text-sm text-dim">
        已有账号？{' '}
        <Link to={`/login${params.toString() ? `?${params}` : ''}`} className="text-brand hover:underline">
          去登录
        </Link>
      </p>
    </AuthShell>
  );
}
