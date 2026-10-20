import { wecomBindSchema, type WecomBinding, type WecomBindRequest } from '@watercooler/shared';
import { Hono } from 'hono';
import { requireUser, type AppDeps, type AppEnv } from '../context';
import { notFound, parseBody } from '../lib/http';
import { confirmBinding, describeBindToken, getBindingByUser, toWecomBinding, unbindUser } from '../wecom/bindings';

export function wecomRoutes({ db, now, runtime }: AppDeps) {
  const app = new Hono<AppEnv>();

  app.get('/wecom/bind/:token', (c) => {
    const user = requireUser(c);
    if (!runtime?.wecom()) throw notFound('企业微信机器人没有开启');
    return c.json<WecomBindRequest>(describeBindToken(db, c.req.param('token'), user.id, now()));
  });

  app.post('/wecom/bind', async (c) => {
    const user = requireUser(c);
    const wecom = runtime?.wecom();
    if (!wecom) throw notFound('企业微信机器人没有开启');
    const { token } = await parseBody(c, wecomBindSchema);
    const binding = confirmBinding(db, token, user.id, now());
    wecom.announceBinding(binding, user);
    return c.json<WecomBinding>(toWecomBinding(binding));
  });

  app.get('/me/wecom', (c) => {
    const user = requireUser(c);
    const binding = getBindingByUser(db, user.id);
    return c.json<{ binding: WecomBinding | null }>({ binding: binding ? toWecomBinding(binding) : null });
  });

  app.post('/me/wecom/unbind', (c) => {
    const user = requireUser(c);
    unbindUser(db, user.id);
    return c.json({ ok: true });
  });

  return app;
}
