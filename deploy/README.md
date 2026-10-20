# 部署到服务器（GitHub Actions）

同一份代码在服务器上跑成多个**互相独立的实例**，每个实例有自己的目录、端口、访问路径和数据库（账号、市场、水滴都不互通）：

| 实例          | 访问地址                        | 服务器目录      | 端口   | 站点名称      | 文案                    |
| ------------- | ------------------------------- | --------------- | ------ | ------------- | ----------------------- |
| `watercooler` | `https://ky-z.com/watercooler/` | `~/watercooler` | `3000` | `Watercooler` | `watercooler`（茶水间） |
| `gang-bet`    | `https://ky-z.com/gang-bet/`    | `~/gang-bet`    | `3001` | `gang-bet`    | `neutral`（中性）       |

实例列表写在 [`.github/workflows/deploy.yml`](../.github/workflows/deploy.yml) 的 `matrix.include` 里。推送到 `main` 分支，或者在 GitHub 的 **Actions → Deploy → Run workflow** 手动触发，每个实例各跑一个部署任务（一个失败不影响另一个）：

1. 在 GitHub 上安装依赖、跑类型检查和测试，用这个实例的 `BASE_PATH`（如 `/gang-bet`）、`SITE_NAME` 和 `SITE_COPY` 构建前后端
2. 通过 SSH 上传到服务器上部署用户家目录下的 `~/<实例>/releases/<时间>-<commit>/`
3. 在服务器上安装生产依赖（用 nvm 的 Node；`better-sqlite3` 是原生模块，在服务器上安装才能和服务器的 Node 版本匹配）
4. 把 `~/<实例>/current` 指向新版本，用 `~/<实例>/<实例>.sh restart` 在后台重启
5. 检查 `http://127.0.0.1:<端口>/api/config`；如果没起来，**自动切回上一个版本**并让这个任务失败

不用 systemd，也不需要 sudo：进程由控制脚本用 `nohup` 在后台运行，pid 和日志放在 `shared/` 里。

服务器上的目录结构（`~` 是 `DEPLOY_USER` 的家目录），以 `gang-bet` 为例：

```
~/gang-bet/
  gang-bet.sh                   启动/停止/重启脚本（每次部署自动更新）
  current -> releases/20261017093000-1a2b3c4   正在运行的版本
  releases/                     最近 5 个版本
  shared/data/gang-bet.db       数据库（部署不会动它）
  shared/logs/gang-bet.log      日志（超过 10 MB 自动轮转）
  shared/gang-bet.pid           进程号
  shared/.env                   可选配置（邀请码等）
```

`~/watercooler/` 完全一样，文件名换成 `watercooler`。

每个版本里有一个部署时生成的 `instance.env`（`INSTANCE`、`PORT`、`BASE_PATH`），控制脚本 [`deploy/watercooler.sh`](watercooler.sh) 从这里读端口和路径，所以运行参数总是和构建时一致。另外固定 `HOST=127.0.0.1`（只监听本机，必须经过 nginx）。

## 一、服务器一次性准备

全部以**部署用户**（`DEPLOY_USER`）身份执行，不需要 root：

```bash
# 1. 用 nvm 装 Node 22，并设为默认版本（部署脚本和控制脚本会自动加载 ~/.nvm/nvm.sh）
nvm install 22
nvm alias default 22

# 2. 服务器重启后自动拉起（每个实例一行；第一次部署之前加也没关系）
(crontab -l 2>/dev/null; echo '@reboot $HOME/watercooler/watercooler.sh start') | crontab -
(crontab -l 2>/dev/null; echo '@reboot $HOME/gang-bet/gang-bet.sh start') | crontab -

# 3. 可选：额外配置，比如邀请码（每个实例单独一份）
mkdir -p ~/gang-bet/shared
tee ~/gang-bet/shared/.env <<'CONF'
INVITE_CODE=换成你的邀请码
# PRIVATE_MODE=true
CONF
```

改完 `.env` 后执行 `~/<实例>/<实例>.sh restart` 生效。`HOST`、`PORT`、`BASE_PATH`、数据库路径由控制脚本决定，不会被 `.env` 覆盖。

注意：

- nvm 是按用户安装的，必须装在 `DEPLOY_USER` 这个账号下。
- 服务器要能访问 npm 仓库来安装依赖。`better-sqlite3` 会从 GitHub 下载预编译文件，下载失败时会从源码编译，需要 `python3`、`make`、`g++`（`sudo apt install -y build-essential python3`）。
- 每个实例的端口（3000、3001）不能被别的程序占用。
- 市场由发起人自己公布结果，管理员管不了市场。管理员负责实例本身（见下面的「实例管理」）；第一个管理员和忘记密码都在服务器上用命令处理。
- 如果发现 SSH 断开后进程被杀（`/etc/systemd/logind.conf` 里 `KillUserProcesses=yes`），执行 `sudo loginctl enable-linger <部署用户>`。Ubuntu 默认不会杀。

## 二、SSH 密钥

在自己电脑上生成一对**专门用于部署**的密钥（不设密码）：

```bash
ssh-keygen -t ed25519 -N '' -C github-actions-deploy -f watercooler_deploy

# 公钥加到服务器 deploy 用户的 authorized_keys
ssh-copy-id -i watercooler_deploy.pub deploy@ky-z.com

# 记下服务器的主机公钥，用于 DEPLOY_KNOWN_HOSTS（防止中间人攻击）
ssh-keyscan -p 22 ky-z.com
```

所有实例共用这一套密钥和 Secrets。

## 三、GitHub 配置

仓库 **Settings → Secrets and variables → Actions**。

**Secrets**

| 名称                 | 内容                                 |
| -------------------- | ------------------------------------ |
| `DEPLOY_HOST`        | 服务器域名或 IP，如 `ky-z.com`       |
| `DEPLOY_USER`        | `deploy`                             |
| `DEPLOY_SSH_KEY`     | 私钥 `watercooler_deploy` 的完整内容 |
| `DEPLOY_KNOWN_HOSTS` | 上面 `ssh-keyscan` 的完整输出        |
| `DEPLOY_PORT`        | 可选，SSH 端口，默认 `22`            |

**Variables**（可选）

| 名称      | 说明                                                                                    |
| --------- | --------------------------------------------------------------------------------------- |
| `APP_URL` | 站点地址，如 `https://ky-z.com`，设置后部署完会从公网访问每个实例的子路径一次做冒烟测试 |

`DEPLOY_KNOWN_HOSTS` 直接粘贴 `ssh-keyscan` 的全部输出即可（`ssh-rsa`、`ecdsa-sha2-nistp256`、`ssh-ed25519` 几行都要，`#` 开头的注释行留着也没关系）。

workflow 使用名为 `production` 的 environment（第一次运行时 GitHub 会自动创建）。Secrets 放在仓库级别或这个 environment 里都可以；放在 environment 里还可以设置「需要审批才能部署」之类的保护规则。

## 四、nginx

nginx 负责 HTTPS，并在转发时去掉子路径前缀。每个实例一组 `location`：

```nginx
location = /watercooler {
    return 301 /watercooler/;
}

location /watercooler/ {
    proxy_pass http://127.0.0.1:3000/;   # 末尾的 / 会把 /watercooler 前缀去掉
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}

location = /gang-bet {
    return 301 /gang-bet/;
}

location /gang-bet/ {
    proxy_pass http://127.0.0.1:3001/;   # 末尾的 / 会把 /gang-bet 前缀去掉
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

`X-Forwarded-Proto` 让登录 Cookie 在 HTTPS 下带上 `Secure` 标记，`X-Forwarded-For` 用于按 IP 限制注册频率。登录 Cookie 的 path 是各自的子路径，所以两个实例的登录状态互不影响。

## 五、再加一个实例

1. 在 `deploy.yml` 的 `matrix.include` 里加一项：`instance`（目录名）、`base_path`、`port`（没被占用的端口）、`site_name`、`site_copy`（[`site-copy.ts`](../apps/web/src/lib/site-copy.ts) 里的一套文案，也可以在那里新加一套）
2. 服务器上：nginx 加一组 `location`（同上），crontab 加一行 `@reboot $HOME/<实例>/<实例>.sh start`
3. 推送到 `main`

## 六、AI 机器人（可选）

每个实例可以跑一群 AI 机器人：它们用大模型联网找新闻出题、互相下注，截止后再联网核实结果并公布。机器人只在网站的「AI 专区」里玩，碰不到大家建的市场；人可以去 AI 专区下注，把机器人的水滴赢过来。

机器人用的密钥和参数放在实例的 `shared/bot.json`。最方便的是管理员在网站的 `/admin` →「配置」→「AI 模型」里填写，保存后重启实例，再到「功能开关」打开「AI 机器人」。也可以直接在服务器上写这个文件（改完同样要重启）：

```bash
tee ~/gang-bet/shared/bot.json <<'JSON'
{
  "endpoint": "https://api.anthropic.com",
  "apiKey": "sk-ant-换成你的 key",
  "model": "claude-opus-5-5",
  "bots": 50,
  "marketsPerDay": 2,
  "betsPerDay": 50,
  "flipProbability": 0.2
}
JSON
chmod 600 ~/gang-bet/shared/bot.json
~/gang-bet/gang-bet.sh restart
~/gang-bet/gang-bet.sh logs     # 能看到「🤖 50 AI bots running」和 [bots] 开头的出题、下注记录
```

| 字段                                         | 说明                                                                                       |
| -------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `endpoint`                                   | Anthropic Messages API 的地址，官方或兼容的中转都行，写不写 `/v1/messages` 都可以          |
| `apiKey` / `model`                           | API key 和模型名                                                                           |
| `bots`                                       | 机器人数量，默认 50；第一次启动时自动创建账号（`ai_bot_01`……，昵称以 🤖 开头），不能登录   |
| `marketsPerDay`                              | 每 24 小时最多出几道题，默认 2。出题要联网搜好几次，是最花钱的部分；失败的尝试也计入       |
| `betsPerDay`                                 | 每 24 小时最多下几注，默认 50。每注调用一次模型、最多联网搜一次                            |
| `flipProbability`                            | 机器人故意押反的概率，默认 0.2                                                             |
| `effort`、`webSearchTool`、`refusalFallback` | 可选：模型思考力度、联网搜索工具版本、拒答时自动换模型（官方 endpoint 上的新模型默认开启） |

AI 盘截止后，出题的机器人联网核实结果并公布；查不到会 12 小时后再查，截止 7 天还没结果就自动取消、全额退款。在 `/admin` 关掉「AI 机器人」就停掉机器人，已有的 AI 盘照常可以访问。

## 七、企业微信机器人（可选，目前只给 watercooler 用）

在企业微信里建一个**智能机器人**，连接方式选「长连接」（API 模式），记下 Bot ID 和 Secret。服务器主动连企业微信，不需要公网回调地址，也不用改 nginx。

在**这个实例**的 `/admin` →「配置」→「企业微信机器人」里填写 Bot ID、Secret 和网站地址，保存后重启实例，再到「功能开关」打开「企业微信机器人」。也可以直接在 `bot.json` 里加一段 `wecom`：

```json
{
  "endpoint": "https://api.anthropic.com",
  "apiKey": "sk-ant-…",
  "model": "claude-opus-5-5",
  "wecom": {
    "botId": "企业微信里的 Bot ID",
    "secret": "企业微信里的 Secret",
    "siteUrl": "https://ky-z.com/watercooler"
  }
}
```

然后重启实例（`/admin` 里的「重启实例」或 `~/watercooler/watercooler.sh restart`），在「功能开关」打开「企业微信机器人」。日志里能看到 `[wecom] connected`，管理页上显示「运行中」。

| 字段              | 说明                                                              |
| ----------------- | ----------------------------------------------------------------- |
| `botId`、`secret` | 企业微信智能机器人的凭证                                          |
| `siteUrl`         | 这个实例的公网地址，用来生成绑定链接和市场链接                    |
| `siteName`        | 机器人回复里怎么称呼网站，默认 `Watercooler`                      |
| `messagesPerHour` | 每人每小时最多让机器人调用几次大模型，默认 30（查链接、解绑不算） |

聊天用的是同一个 `apiKey` 和 `model`（不联网搜索）。

怎么用：

1. 把机器人拉进群。只能在群里用，私聊会被拒绝。
2. 没绑定的人 @机器人，机器人只回一个专属绑定链接（10 分钟有效、只能用一次），**不会调用大模型**。打开链接 → 登录 → 确认绑定，群里会收到「<昵称> 绑定成功」。企业微信账号是加密的，机器人的消息和网页上都不会显示它，只用网站昵称称呼人。
3. 绑定后在群里 @机器人 用自然语言聊天：查盘、查余额和排名、签到、下注、开盘、公布结果、取消市场。下注、开盘、公布、取消会先发一张确认卡片，只有发起人本人点「确认」才执行；10 分钟内不点就作废。
4. 市场结算后，押过注的人会在自己最近 @机器人 的那个群里收到结果；自己建的盘截止后、以及自动取消前一天，会收到「该公布结果了」的提醒。
5. 对机器人说「解绑」，或者在网站的「账号设置」里点「解除绑定」，就能解除。

同一个机器人只能有一个长连接：如果本地开发也用了同一套 Bot ID/Secret，后连上的会把先连上的踢掉（日志里会提示）。

## 八、实例管理（/admin）

每个实例都有自己的管理页：`https://ky-z.com/watercooler/admin`、`https://ky-z.com/gang-bet/admin`。两个实例的管理员互不相通。

第一个管理员在服务器上设置（这个账号要先在网站上注册）：

```bash
~/watercooler/watercooler.sh make-admin <用户名>
```

之后管理员可以在 `/admin` 里：

| 功能     | 说明                                                                                                                                                                                                     |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 功能开关 | AI 机器人、企业微信机器人、Polymarket 模式，切换立即生效。功能开不开只看开关：没有凭证的功能打不开，开着但凭证没了会显示红色的「缺少配置」。升级到这个版本时，按当时 `bot.json` 里有没有凭证自动设好一次 |
| 配置     | AI 模型、企业微信凭证、站点设置（邀请码、私有模式、注册赠送、每日签到、时区），写到 `shared/bot.json` 和 `shared/.env`，重启后生效；密钥只显示末四位                                                     |
| 重启实例 | 改过配置后页面顶部会提示需要重启；网站会中断几秒                                                                                                                                                         |
| 水滴运维 | 给某个人加或减水滴、全员发放，必须写原因；记在对方流水里（「管理员调整」），算作发放的资金，不影响盈利排行                                                                                               |
| 管理员   | 任命或取消其他管理员（不能取消自己，所以至少会留一个）                                                                                                                                                   |
| 操作记录 | 以上所有操作都记录谁、什么时候、做了什么                                                                                                                                                                 |

管理员不能替人公布或取消市场。在线重启靠控制脚本：服务进程在后台调用 `<实例>.sh restart`，所以只有用这个脚本启动的实例才能在线重启。

## 九、日常运维

以部署用户身份（把 `gang-bet` 换成要操作的实例）：

```bash
~/gang-bet/gang-bet.sh status      # 是否在运行
~/gang-bet/gang-bet.sh logs        # 跟踪日志
~/gang-bet/gang-bet.sh restart     # 重启（也有 start / stop）
ls ~/gang-bet/releases             # 已部署的版本

# 有人忘记密码：重置后这个账号会在所有设备上退出登录
~/gang-bet/gang-bet.sh reset-password <用户名> <新密码>

# 设置管理员（一般只用来设第一个，之后在 /admin 里加）
~/gang-bet/gang-bet.sh make-admin <用户名>

# 手动回滚到某个版本（注意：数据库结构升级过的话，不能回滚到升级之前的版本，
# 比如改成奖池模式之前的版本）
ln -sfn ~/gang-bet/releases/<版本> ~/gang-bet/current
~/gang-bet/gang-bet.sh restart

# 备份数据库（WAL 模式，不要直接复制 db 文件）
sqlite3 ~/gang-bet/shared/data/gang-bet.db ".backup '$HOME/gang-bet/shared/backup-$(date +%F).db'"
```
