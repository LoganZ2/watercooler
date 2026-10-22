import { Link } from 'react-router';
import { buttonClass } from '../components/ui';
import { COPY, usePageTitle } from '../lib/site';

export default function NotFound() {
  usePageTitle('页面不存在');
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center gap-4 text-center">
      <div className="text-8xl font-bold text-brand">404</div>
      <p className="text-dim">{COPY.notFound}</p>
      <Link to="/" className={buttonClass({ variant: 'outline' })}>
        回到首页
      </Link>
    </div>
  );
}
