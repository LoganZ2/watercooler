import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { toast } from 'sonner';
import { Button, Card, Field, Input } from '../components/ui';
import { api, errorMessage } from '../lib/api';
import { useMe } from '../lib/auth';
import { usePageTitle } from '../lib/site';

export default function SettingsPage() {
  usePageTitle('账号设置');
  const { me } = useMe();
  const qc = useQueryClient();
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const profile = useMutation({
    mutationFn: () => api.updateProfile(displayName.trim()),
    onSuccess: (res) => {
      qc.setQueryData(['me'], res);
      void qc.invalidateQueries();
      toast.success('昵称已更新');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });
  const password = useMutation({
    mutationFn: () => api.changePassword(oldPassword, newPassword),
    onSuccess: () => {
      setOldPassword('');
      setNewPassword('');
      toast.success('密码已修改，其他设备已退出登录');
    },
    onError: (err) => toast.error(errorMessage(err)),
  });

  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h1 className="section-title">账号设置</h1>
      <Card className="space-y-4 p-6">
        <h2 className="font-semibold">个人资料</h2>
        <Field label="用户名" hint="用户名不可修改">
          <Input value={me?.username ?? ''} disabled className="opacity-60" />
        </Field>
        <Field label="昵称">
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} maxLength={24} />
        </Field>
        <Button
          onClick={() => profile.mutate()}
          loading={profile.isPending}
          disabled={!displayName.trim() || displayName.trim() === me?.displayName}
        >
          保存
        </Button>
      </Card>
      <Card className="space-y-4 p-6">
        <h2 className="font-semibold">修改密码</h2>
        <Field label="当前密码">
          <Input
            type="password"
            value={oldPassword}
            onChange={(e) => setOldPassword(e.target.value)}
            autoComplete="current-password"
          />
        </Field>
        <Field label="新密码" hint="至少 6 位">
          <Input
            type="password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            autoComplete="new-password"
          />
        </Field>
        <Button
          onClick={() => password.mutate()}
          loading={password.isPending}
          disabled={!oldPassword || newPassword.length < 6}
        >
          修改密码
        </Button>
      </Card>
    </div>
  );
}
