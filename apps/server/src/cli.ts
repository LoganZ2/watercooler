/**
 * Maintenance commands for whoever runs the server.
 *   pnpm --filter @watercooler/server cli reset-password <username> <new-password>
 *   pnpm --filter @watercooler/server cli make-admin <username>
 * On a deployed server: ~/<instance>/<instance>.sh reset-password|make-admin ...
 * make-admin creates the first admin; after that admins appoint each other at /admin.
 */
import { registerSchema } from '@watercooler/shared';
import { loadConfig, loadDotEnv } from './config';
import { openDatabase } from './db';
import { hashPassword } from './lib/password';
import { revokeSessions } from './lib/session';
import { audit } from './services/admin';
import { getUserByUsername } from './services/users';

const USAGE = 'usage: cli reset-password <username> <new-password> | make-admin <username>';

loadDotEnv();
const [command, ...args] = process.argv.slice(2);

if (command === 'reset-password') {
  const [username, password] = args;
  if (!username || !password) fail(USAGE);
  const checked = registerSchema.shape.password.safeParse(password);
  if (!checked.success) fail(checked.error.issues[0]?.message ?? '密码不符合要求');
  const db = openDatabase(loadConfig().databasePath);
  const user = getUserByUsername(db, username);
  if (!user) fail(`用户 ${username} 不存在`);
  db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(await hashPassword(password), user.id);
  revokeSessions(null, db, user.id, false);
  db.close();
  console.log(`已重置 ${user.username}（${user.display_name}）的密码，这个账号已在所有设备上退出登录。`);
} else if (command === 'make-admin') {
  const [username] = args;
  if (!username) fail(USAGE);
  const db = openDatabase(loadConfig().databasePath);
  const user = getUserByUsername(db, username);
  if (!user || user.is_bot) fail(`用户 ${username} 不存在`);
  db.transaction(() => {
    db.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').run(user.id);
    audit(
      db,
      user.id,
      'admin',
      `设为管理员：${user.display_name}（${user.username}），在服务器上用命令行设置`,
      Date.now(),
    );
  })();
  db.close();
  console.log(`${user.username}（${user.display_name}）现在是管理员，可以打开网站的 /admin 管理这个实例。`);
} else {
  fail(USAGE);
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}
