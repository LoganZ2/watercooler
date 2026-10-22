import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CURRENCY_NAME } from '@watercooler/shared';
import clsx from 'clsx';
import {
  BarChart3,
  Bot,
  ChevronUp,
  Gift,
  LayoutGrid,
  LogOut,
  Moon,
  Plus,
  Settings,
  ShieldCheck,
  Sun,
  Trophy,
  User as UserIcon,
  Wallet,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { toast } from 'sonner';
import { api, errorMessage } from '../lib/api';
import { useConfig, useMe, useSetMe } from '../lib/auth';
import { COPY, SITE_NAME } from '../lib/site';
import { setTheme, useTheme } from '../lib/theme';
import { Avatar } from './Avatar';
import { Money } from './Money';
import { buttonClass } from './ui';

/** `compact` hides the wordmark on narrow screens (used in the navbar). */
export function Logo({ compact }: { compact?: boolean }) {
  return (
    <Link to="/" className="flex items-center gap-2.5">
      <span className="flex size-8 items-center justify-center rounded bg-brand">
        <svg viewBox="0 0 32 32" className="size-5 text-white">
          <path d="M16 3c4.8 5.7 8.6 10.4 8.6 14.9a8.6 8.6 0 0 1-17.2 0C7.4 13.4 11.2 8.7 16 3Z" fill="currentColor" />
          <path
            d="M12.3 19a3.9 3.9 0 0 0 3.7 3.7"
            style={{ stroke: 'var(--color-brand)' }}
            strokeWidth="2"
            strokeLinecap="round"
            fill="none"
          />
        </svg>
      </span>
      <span className={clsx('leading-none', compact && 'hidden sm:block')}>
        <span className="block text-[17px] font-bold tracking-tight text-fg">{SITE_NAME}</span>
        <span className="mt-1 block text-[10px] tracking-[0.25em] text-faint">{COPY.tagline}</span>
      </span>
    </Link>
  );
}

const navLinkClass = ({ isActive }: { isActive: boolean }) =>
  clsx(
    'relative flex h-16 items-center px-4 text-[15px] transition-colors',
    isActive ? 'font-semibold text-brand' : 'text-fg hover:text-brand',
  );

function NavItem({ to, children }: { to: string; children: React.ReactNode }) {
  return (
    <NavLink to={to} end={to === '/'} className={navLinkClass}>
      {({ isActive }) => (
        <>
          {children}
          {isActive && <span className="absolute inset-x-4 bottom-0 h-0.5 bg-brand" />}
        </>
      )}
    </NavLink>
  );
}

function BonusButton() {
  const setMe = useSetMe();
  const mutation = useMutation({
    mutationFn: api.claimBonus,
    onSuccess: (res) => {
      setMe((me) => ({ ...me, balance: res.balance, canClaimBonus: false }));
      toast.success(`签到成功，获得 ${res.amount} ${CURRENCY_NAME}`);
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  return (
    <button
      onClick={() => mutation.mutate()}
      disabled={mutation.isPending}
      className="relative inline-flex h-8 items-center gap-1.5 rounded-full border border-gold/40 bg-gold/5 px-2.5 text-sm text-gold transition hover:bg-gold/10 sm:px-3"
      aria-label="每日签到"
    >
      <span className="absolute -top-1 -right-1 size-2.5 animate-ping rounded-full bg-gold" />
      <span className="absolute -top-1 -right-1 size-2.5 rounded-full bg-gold" />
      <Gift className="size-4" />
      <span className="hidden sm:inline">签到</span>
    </button>
  );
}

function ThemeToggle() {
  const theme = useTheme();
  const dark = theme === 'dark';
  return (
    <button
      onClick={() => setTheme(dark ? 'light' : 'dark')}
      className="flex size-8 items-center justify-center rounded-full text-dim transition hover:bg-fill hover:text-brand"
      aria-label={dark ? '切换到日间模式' : '切换到黑夜模式'}
      title={dark ? '日间模式' : '黑夜模式'}
    >
      {dark ? <Sun className="size-[18px]" /> : <Moon className="size-[18px]" />}
    </button>
  );
}

function UserMenu() {
  const { me } = useMe();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const qc = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();

  useEffect(() => {
    setOpen(false);
  }, [location.pathname]);
  useEffect(() => {
    if (!open) return;
    const onClick = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [open]);

  if (!me) return null;

  const logout = async () => {
    await api.logout().catch(() => undefined);
    qc.setQueryData(['me'], { user: null });
    qc.removeQueries({ queryKey: ['portfolio'] });
    await qc.invalidateQueries();
    navigate('/');
  };

  const items = [
    { to: `/u/${me.id}`, icon: UserIcon, label: '个人主页' },
    { to: '/portfolio', icon: Wallet, label: '我的下注' },
    { to: '/settings', icon: Settings, label: '账号设置' },
    ...(me.isAdmin ? [{ to: '/admin', icon: ShieldCheck, label: '实例管理' }] : []),
  ];

  return (
    <div ref={ref} className="relative">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex items-center rounded-full ring-2 ring-transparent transition hover:ring-brand/25"
        aria-label="用户菜单"
      >
        <Avatar id={me.id} name={me.displayName} size={34} />
      </button>
      {open && (
        <div className="absolute right-0 mt-2 w-56 overflow-hidden rounded-lg border border-line bg-panel p-1.5 shadow-[0_8px_24px_rgb(29_33_41/0.12)]">
          <div className="px-3 py-2.5">
            <div className="font-medium">{me.displayName}</div>
            <div className="text-xs text-faint">@{me.username}</div>
          </div>
          <div className="my-1 h-px bg-line" />
          {items.map(({ to, icon: Icon, label }) => (
            <Link
              key={to}
              to={to}
              className="flex items-center gap-2.5 rounded px-3 py-2 text-sm text-dim transition hover:bg-fill hover:text-brand"
            >
              <Icon className="size-4" />
              {label}
            </Link>
          ))}
          <div className="my-1 h-px bg-line" />
          <button
            onClick={logout}
            className="flex w-full items-center gap-2.5 rounded px-3 py-2 text-sm text-dim transition hover:bg-no/5 hover:text-no"
          >
            <LogOut className="size-4" />
            退出登录
          </button>
        </div>
      )}
    </div>
  );
}

function Navbar() {
  const { me, loading } = useMe();
  const creating = useLocation().pathname === '/create';
  const config = useConfig();
  return (
    <header className="sticky top-0 z-40 border-b border-line bg-panel/95 backdrop-blur">
      <div className="mx-auto flex h-16 max-w-7xl items-center gap-8 px-4">
        <Logo compact />
        <nav className="hidden items-center md:flex">
          <NavItem to="/">市场</NavItem>
          {config?.aiZone && <NavItem to="/ai">AI 专区</NavItem>}
          {config?.mimic && <NavItem to="/polymarket">Polymarket</NavItem>}
          <NavItem to="/leaderboard">排行榜</NavItem>
          {me && <NavItem to="/portfolio">我的下注</NavItem>}
        </nav>
        <div className="ml-auto flex items-center gap-3">
          <ThemeToggle />
          {loading ? null : me ? (
            <>
              {me.canClaimBonus && <BonusButton />}
              <Link
                to="/portfolio"
                className="flex h-8 items-center gap-2 rounded-full bg-fill px-3.5 text-sm font-semibold transition hover:bg-brand-light hover:text-brand"
                title="余额"
              >
                <Money value={me.balance} />
              </Link>
              {/* The wrapper does the hiding: `hidden` on the link itself would fight its `inline-flex`. */}
              {!creating && (
                <div className="hidden sm:block">
                  <Link to="/create" className={buttonClass({ size: 'sm', pill: true })}>
                    <Plus className="size-4" />
                    创建市场
                  </Link>
                </div>
              )}
              <UserMenu />
            </>
          ) : (
            <>
              <Link to="/login" className={buttonClass({ variant: 'ghost', size: 'sm', pill: true })}>
                登录
              </Link>
              <Link to="/register" className={buttonClass({ size: 'sm', pill: true })}>
                注册
              </Link>
            </>
          )}
        </div>
      </div>
    </header>
  );
}

/** Scrolling tape of the latest bets across all markets. */
function Ticker() {
  const { data } = useQuery({ queryKey: ['activity'], queryFn: () => api.activity(24), refetchInterval: 15_000 });
  if (!data || data.length === 0) return null;
  const items = data.map((t) => (
    <Link
      key={t.id}
      to={`/market/${t.marketId}`}
      className="flex shrink-0 items-center gap-2 px-5 text-xs text-dim transition hover:text-fg"
    >
      <span className="text-fg">{t.user.displayName}</span>
      <Money value={t.amount} className="font-mono text-fg" />
      <span>押</span>
      <span className="rounded-sm bg-brand-light px-1.5 py-0.5 text-brand">{t.outcomeLabel}</span>
      <span className="max-w-56 truncate">{t.marketQuestion}</span>
      <span className="text-line">|</span>
    </Link>
  ));
  return (
    <div
      className="group relative overflow-hidden border-b border-line bg-panel"
      style={{ ['--marquee-duration' as string]: `${Math.max(30, data.length * 5)}s` }}
    >
      <div className="pointer-events-none absolute inset-y-0 left-0 z-10 w-16 bg-gradient-to-r from-panel to-transparent" />
      <div className="pointer-events-none absolute inset-y-0 right-0 z-10 w-16 bg-gradient-to-l from-panel to-transparent" />
      <div className="flex w-max animate-marquee py-2 group-hover:[animation-play-state:paused]">
        {items}
        <div className="flex" aria-hidden>
          {items}
        </div>
      </div>
    </div>
  );
}

function MobileNav() {
  const { me } = useMe();
  const config = useConfig();
  const items = [
    { to: '/', icon: LayoutGrid, label: '市场' },
    // Five slots: the AI zone takes the leaderboard's (still linked from the home page and footer).
    config?.aiZone ? { to: '/ai', icon: Bot, label: 'AI 专区' } : { to: '/leaderboard', icon: Trophy, label: '排行' },
    { to: '/create', icon: Plus, label: '创建', primary: true },
    { to: me ? '/portfolio' : '/login', icon: BarChart3, label: '下注' },
    { to: me ? `/u/${me.id}` : '/login', icon: UserIcon, label: '我的' },
  ];
  return (
    <nav className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-panel/95 pb-[env(safe-area-inset-bottom)] backdrop-blur md:hidden">
      <div className="grid grid-cols-5">
        {items.map(({ to, icon: Icon, label, primary }) => (
          <NavLink
            key={label}
            to={to}
            aria-label={label}
            end={to === '/'}
            className={({ isActive }) =>
              clsx(
                'flex flex-col items-center gap-0.5 py-2 text-[11px] transition',
                isActive && !primary ? 'text-brand' : 'text-faint',
              )
            }
          >
            {primary ? (
              <span className="-mt-1 flex size-9 items-center justify-center rounded-full bg-brand text-white">
                <Icon className="size-5" />
              </span>
            ) : (
              <Icon className="size-5" />
            )}
            {label}
          </NavLink>
        ))}
      </div>
    </nav>
  );
}

/** Floating buttons on the right edge, like the 联系咨询 dock on ft.tech. */
function SideDock() {
  const creating = useLocation().pathname === '/create';
  return (
    <div className="fixed right-5 bottom-24 z-30 hidden flex-col items-center gap-3 md:flex">
      {!creating && (
        <Link
          to="/create"
          className="flex w-11 flex-col items-center gap-1.5 rounded-full bg-brand py-3 text-white shadow-[0_6px_16px_rgb(28_85_251/0.35)] transition hover:bg-brand-hover"
        >
          <Plus className="size-5" />
          <span className="flex flex-col text-[13px] leading-[1.2]">
            {Array.from('发起市场').map((ch) => (
              <span key={ch}>{ch}</span>
            ))}
          </span>
        </Link>
      )}
      <button
        onClick={() => window.scrollTo({ top: 0, behavior: 'smooth' })}
        className="flex size-11 items-center justify-center rounded-full border border-line bg-panel text-brand shadow-[0_4px_12px_rgb(29_33_41/0.08)] transition hover:border-brand"
        aria-label="回到顶部"
      >
        <ChevronUp className="size-5" />
      </button>
    </div>
  );
}

function Footer() {
  const { me } = useMe();
  const config = useConfig();
  const columns = [
    {
      title: '市场',
      links: [
        { to: '/', label: '全部市场' },
        ...(config?.aiZone ? [{ to: '/ai', label: 'AI 专区' }] : []),
        ...(config?.werewolf ? [{ to: '/werewolf', label: 'AI 狼人杀' }] : []),
        ...(config?.mimic ? [{ to: '/polymarket', label: 'Polymarket 热门' }] : []),
        { to: '/?sort=closing', label: '即将截止' },
        { to: '/?status=resolved', label: '已结束' },
      ],
    },
    {
      title: '社区',
      links: [
        { to: '/leaderboard', label: '预言家榜' },
        { to: '/create', label: '发起市场' },
      ],
    },
    {
      title: '我的',
      links: me
        ? [
            { to: '/portfolio', label: '我的下注' },
            { to: '/settings', label: '账号设置' },
          ]
        : [
            { to: '/login', label: '登录' },
            { to: '/register', label: '注册' },
          ],
    },
  ];
  return (
    <footer className="border-t border-line bg-panel pb-20 text-dim md:pb-0">
      <div className="mx-auto flex max-w-7xl flex-col gap-10 px-4 py-10 md:flex-row md:justify-between">
        <div className="max-w-sm">
          <Logo />
          <p className="mt-5 text-sm leading-relaxed">
            {COPY.tagline}：用{CURRENCY_NAME}押注{COPY.footerTopics}，奖池怎么分布，就是大家的集体预期。
          </p>
        </div>
        <div className="grid grid-cols-3 gap-10 sm:gap-16">
          {columns.map((col) => (
            <div key={col.title}>
              <div className="text-sm font-semibold text-fg">{col.title}</div>
              <ul className="mt-4 space-y-3 text-sm">
                {col.links.map((l) => (
                  <li key={l.label}>
                    <Link to={l.to} className="transition hover:text-brand">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
      <div className="border-t border-line py-5 text-center text-xs text-faint">
        {SITE_NAME} · {COPY.disclaimer}，{CURRENCY_NAME}没有任何现实价值
      </div>
    </footer>
  );
}

export function Layout() {
  const { pathname } = useLocation();
  const { me, loading } = useMe();
  const config = useConfig();
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [pathname]);
  if (config?.privateMode && !loading && !me && pathname !== '/login' && pathname !== '/register') {
    return <Navigate to={`/login?next=${encodeURIComponent(pathname)}`} replace />;
  }
  return (
    <div className="flex min-h-dvh flex-col">
      <Navbar />
      <Ticker />
      {/* The home page brings its own full-width bands; every other page sits in the content column. */}
      <main className={clsx('flex-1', pathname !== '/' && 'mx-auto w-full max-w-7xl px-4 pt-8 pb-16')}>
        <Outlet />
      </main>
      <Footer />
      <SideDock />
      <MobileNav />
    </div>
  );
}
