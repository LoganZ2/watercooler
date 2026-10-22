import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Link2Off, MessagesSquare } from 'lucide-react';
import { Link, useNavigate, useParams } from 'react-router';
import { Button, buttonClass, Card, Empty, PageLoader } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePageTitle } from '../lib/site';

/** Opened from the link the WeCom bot posts in a group: confirm before tying the accounts together. */
export default function BindWecom() {
  usePageTitle('绑定企业微信');
  const { token = '' } = useParams();
  const { me } = useMe();
  const navigate = useNavigate();
  const qc = useQueryClient();
  const request = useQuery({
    queryKey: ['wecomBindRequest', token],
    queryFn: () => api.wecomBindRequest(token),
    retry: false,
    staleTime: Infinity,
  });
  const bind = useMutation({
    mutationFn: () => api.wecomBind(token),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['wecomBinding'] }),
  });

  if (request.isPending) return <PageLoader />;

  return (
    <div className="flex min-h-[60vh] items-center justify-center py-8">
      <Card className="w-full max-w-md p-8">
        {bind.isSuccess ? (
          <div className="text-center">
            <CircleCheck className="mx-auto size-12 text-yes" />
            <h1 className="mt-4 text-xl font-semibold">绑定成功</h1>
            <p className="mt-2 text-sm leading-relaxed text-dim">
              回到企业微信群里 @机器人
              试试，比如「现在有什么盘」「我的余额」。下注、开盘这类操作，机器人会发确认卡片，你点了确认才会执行。
            </p>
            <Link to="/" className={buttonClass({ className: 'mt-6' })}>
              回到首页
            </Link>
          </div>
        ) : request.isError ? (
          <Empty icon={<Link2Off className="size-10" />} title={errorMessage(request.error)}>
            <Link to="/settings" className="text-brand hover:underline">
              查看我的绑定
            </Link>
          </Empty>
        ) : (
          <>
            <MessagesSquare className="mx-auto size-10 text-brand" />
            <h1 className="mt-4 text-center text-xl font-semibold">绑定企业微信</h1>
            <dl className="mt-6 rounded bg-fill px-4 py-3 text-sm">
              <div className="flex justify-between gap-4">
                <dt className="text-faint">绑定到</dt>
                <dd className="font-semibold">
                  {me?.displayName} <span className="font-normal text-faint">（{me?.username}）</span>
                </dd>
              </div>
            </dl>
            <p className="mt-4 text-sm leading-relaxed text-dim">
              绑定后，你在群里 @机器人
              就能用这个账号查盘、下注、开盘、公布结果。只确认你自己在群里要到的链接；链接是别人发的就不要确认。
            </p>
            {request.data.current && request.data.current.wecomUserId !== request.data.wecomUserId && (
              <p className="mt-3 rounded border border-line px-3 py-2 text-sm text-dim">
                这个账号已经绑定过另一个企业微信，确认后会换成你现在这个。
              </p>
            )}
            {bind.isError && <p className="mt-3 text-sm text-no">{errorMessage(bind.error)}</p>}
            <div className="mt-6 grid grid-cols-2 gap-3">
              <Button variant="outline" onClick={() => navigate('/')}>
                取消
              </Button>
              <Button onClick={() => bind.mutate()} loading={bind.isPending}>
                确认绑定
              </Button>
            </div>
          </>
        )}
      </Card>
    </div>
  );
}
