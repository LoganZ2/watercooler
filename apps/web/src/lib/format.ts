const compactFmt = new Intl.NumberFormat('zh-CN', { notation: 'compact', maximumFractionDigits: 1 });
const moneyFmt = new Intl.NumberFormat('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 0 });
const sharesFmt = new Intl.NumberFormat('zh-CN', { maximumFractionDigits: 2 });

/** 1,234.56 */
export const formatMoney = (n: number) => moneyFmt.format(n);
/** 1.2万 for big numbers, 1,234 otherwise. */
export const formatCompact = (n: number) => (Math.abs(n) >= 10_000 ? compactFmt.format(n) : intFmt.format(n));
export const formatShares = (n: number) => sharesFmt.format(n);

/** Probability 0..1 as a whole percent, with <1% / >99% at the edges. */
export function formatPct(p: number): string {
  if (p > 0 && p < 0.005) return '<1%';
  if (p < 1 && p > 0.995) return '>99%';
  return `${Math.round(p * 100)}%`;
}

export const formatPct1 = (p: number) => `${(p * 100).toFixed(1)}%`;

/** Payout per unit staked, e.g. ×2.35. */
export const formatMultiplier = (m: number) => `×${m.toFixed(2)}`;

export function formatSigned(n: number, digits = 2): string {
  const abs = Math.abs(n).toLocaleString('zh-CN', { minimumFractionDigits: digits, maximumFractionDigits: digits });
  const threshold = 0.5 * 10 ** -digits;
  return n >= threshold ? `+${abs}` : n <= -threshold ? `-${abs}` : abs;
}

const rtf = new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ['year', 365 * 86_400_000],
  ['month', 30 * 86_400_000],
  ['week', 7 * 86_400_000],
  ['day', 86_400_000],
  ['hour', 3_600_000],
  ['minute', 60_000],
];

export function formatRelative(t: number, now = Date.now()): string {
  const diff = t - now;
  for (const [unit, ms] of UNITS) {
    if (Math.abs(diff) >= ms) return rtf.format(Math.round(diff / ms), unit);
  }
  return diff >= 0 ? '马上' : '刚刚';
}

const dateFmt = new Intl.DateTimeFormat('zh-CN', {
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const fullDateFmt = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: '2-digit',
  minute: '2-digit',
});
const dayFmt = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });

export function formatDate(t: number): string {
  return new Date(t).getFullYear() === new Date().getFullYear() ? dateFmt.format(t) : fullDateFmt.format(t);
}
export const formatDay = (t: number) => dayFmt.format(t);

/** A timestamp as the value of a <input type="datetime-local">, in the browser's time zone. */
export function toLocalInput(t: number): string {
  const d = new Date(t);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
