# 💧 Watercooler · 茶水间预测市场

一个给同事们自己玩的 Polymarket 风格预测市场。用虚拟货币「水滴」押注团建去哪、周会多久、指数收在几点……所有下注汇成奖池，猜对的人按比例瓜分。

> 水滴没有任何现实价值，仅供娱乐。

## 功能

- **账号**：用户名 + 密码注册登录，可选邀请码；会话用 httpOnly Cookie，密码 scrypt 加盐哈希
- **市场**：是/否二元市场和多选一市场（2–10 个互斥选项），任何人都能发起
- **下注**：奖池模式，随时下注，前端实时显示奖池占比、预计赔率和猜中可得
- **时间与结算**：分别设置停止交易和结算时间。奖池市场的结果确定后，发起人随时可以公布（提前公布会立即停止下注），押中的人按比例瓜分全部奖池；Polymarket 市场要到结算时间后才能公布。奖池模式到结算时间后 7 天未公布会自动取消并退款；奖池市场的发起人也可以主动取消市场全额退款。Polymarket 市场不可取消，只能等待结算
- **社交**：评论区、下注榜、下注记录、全站下注滚动条、个人主页
- **排行榜**：按已结算盈利 / 入账净值 / 下注次数排名
- **经济系统**：注册送 1000 水滴，每日签到 +100，系统不做庄、不补贴
- **Polymarket 镜像盘**：默认开启（需要先开 Polymarket 模式）。每 5 分钟从 polymarket.com 同步 24 小时成交最多的前 K 个事件（默认 50，管理员可改），放在「Polymarket」页面。大家按 Polymarket 的实时盘口用水滴买卖 Yes / No（只有市价单，价格按对自己不利的方向取整到 0.01、整份成交），对手是本站，所以买卖只影响自己的输赢，不会改变 Polymarket 的价格；Polymarket 出结果后自动按每份 1 / 0（平局 0.5）兑付，关闭镜像后已有持仓照样结算。因为对手是本站，镜像盘的输赢会让全站水滴总量增减
- **实例管理**：管理员在网站的 `/admin` 开关功能（Polymarket 模式和镜像盘）、修改站点设置、在线重启实例、给人加减水滴、任命其他管理员，所有操作都有记录。第一个管理员和忘记密码都由站长在服务器上用命令处理（见 [`deploy/README.md`](deploy/README.md)）。管理员不能替人公布市场结果
- **移动端适配**：底部导航栏，下注面板自动排在图表下方
- **日间 / 黑夜模式**：一键切换，界面风格参照非凸科技官网

## 技术栈

pnpm monorepo，前后端全部 TypeScript：

```
apps/
  server/     Node.js + Hono + better-sqlite3（SQLite）
  web/        React 19 + Vite + Tailwind CSS v4 + TanStack Query + Recharts
packages/
  shared/     前后端共用：奖池分配算法、API 类型、zod 校验规则
```

没有用 Next.js：这个项目就是一个 SPA + 一个 JSON API，分开更简单直接，部署时也只是一个 Node 进程（API 和前端静态文件由同一个服务提供）。前端的赔率预估和后端的派奖用的是 `packages/shared` 里同一份奖池代码，保证看到的和实际拿到的一致。

## Polymarket 份额模式

创建市场时可选择「奖池模式」或「Polymarket」。Polymarket 市场可以是 Yes / No 是非题，也可以是 3 个以上选项的多选题（每个选项各有一对 Yes / No 份额和自己的订单簿，和 Polymarket 的多选事件一样），使用虚拟水滴。

- **完整抵押**：1 水滴拆分为 1 Yes + 1 No（多选题按选项拆分）；持有未被冻结的一对份额时可合并赎回 1 水滴。
- **订单簿**：价格 0.01–0.99 水滴，精度 0.01，整数份额。盘口合并互补挂单：买 No @0.40 显示为卖 Yes @0.60，两边会直接撮合。显示价格为买一卖一中间价，价差超过 0.10 时用最近成交价。
- **订单类型**：限价单 GTC（一直挂到成交或撤单）、GTD（到期自动撤单）；市价单 FAK（能成交多少成交多少，其余取消）、FOK（不能全部成交就整单取消）。市价买入可以按金额下单（花多少水滴，只买整份），按盘口逐档成交，只冻结实际花费；可选最差成交价。Post-only 只挂不吃。
- **撮合**：价格优先、同价按订单先后顺序，按挂单方价格成交，支持部分成交。直接转手和互补订单统一按有效价格竞争，不允许自成交；会与自己挂单交叉的新单整笔拒绝（含等价和互补订单）。限价买单成交价优于限价时立即退回差额。
- **多选题转换**：只有一个选项会赢，所以选中 k 个选项的 No 各 1 份，可以换回 k−1 水滴加上其余每个选项 1 份 Yes。
- **持仓**：每个持仓记录均价（加权平均成本，拆分按每份 0.50 计），并按显示价格估算价值和盈亏，只供参考；排行榜和净值仍只在结算后计入。市场页有持有者排行和带用户名的成交动态。
- **结算**：沿用本项目创建者公布结果的流程，获胜份额每份兑回 1 水滴，失败份额兑回 0（多选题：获胜选项的 Yes 和其余选项的 No 兑回 1）。市场不可取消，未公布结果时保留持仓和抵押资金，一直等待结算；未成交订单仍可撤销。全部兑付自动完成。

例如 Alice 挂 100 份 Yes 买单，价格 0.40；Bob 挂 100 份 No 买单，价格 0.60。成交后 Alice 付 40、Bob 付 60，市场保管 100 水滴抵押。Yes 胜出时 Alice 收到 100，Bob 收到 0。整个模式不额外发行水滴、不收交易手续费，无需链上钱包。

接口：`GET /api/markets/:id/exchange` 读取盘口、本人份额/订单与最近成交；`POST /api/markets/:id/orders` 下单（`outcomeId, token?, side, type?, price?, quantity | amount, expiresAt?, postOnly?`）；`POST /api/markets/:id/orders/:orderId/cancel` 撤单；`POST /api/markets/:id/split` 与 `/merge` 拆分/合并（`quantity, outcomeId?`）；`POST /api/markets/:id/convert` 转换 No 份额；`GET /api/markets/:id/exchange/holders` 与 `/exchange/activity` 读取持有者和成交动态。原有 `/resolve`、`/cancel` 按市场模式处理结算。

## 本地运行

交易接口说明见 [交易 API](docs/trading-api.md)，配套的零运行时依赖 [Python SDK](sdk/python/README.md) 支持登录、行情、幂等下单、撤单、分页成交、账户持仓及份额拆分/合并。Python 测试可用 `pnpm test:python` 运行。

需要 Node.js ≥ 20.19 和 pnpm（`corepack enable` 即可）。

```bash
pnpm install
pnpm seed        # 可选：生成演示用户和市场（xiaoming、lili…，密码都是 demo123）
pnpm dev         # 前端 http://localhost:5173 ，API http://localhost:3000
```

常用命令：

| 命令                | 作用                                     |
| ------------------- | ---------------------------------------- |
| `pnpm dev`          | 同时启动前后端（热更新）                 |
| `pnpm test`         | 运行测试（奖池算法 + API 集成测试）      |
| `pnpm typecheck`    | 全部包类型检查                           |
| `pnpm format`       | Prettier 格式化                          |
| `pnpm build`        | 构建前端和后端                           |
| `pnpm start`        | 用构建产物启动生产服务（默认 3000 端口） |
| `pnpm seed --reset` | 删除数据库并重新生成演示数据             |

## 部署

### GitHub Actions 自动部署

推送到 `main` 后自动构建、测试并通过 SSH 部署到服务器（后台脚本运行 + nginx 反向代理，支持部署在子路径下，失败自动回滚，不需要 systemd 和 sudo）。同一份代码部署成两个互相独立的实例：`/watercooler` 和 `/gang-bet`，各用各的数据库。服务器一次性准备、需要配置的 Secrets 和怎么再加实例见 [`deploy/README.md`](deploy/README.md)。

### 直接运行

```bash
pnpm install
pnpm build
cp .env.example .env   # 按需修改
pnpm start             # http://<服务器>:3000
```

数据都在 `data/watercooler.db`（SQLite）。

### Docker

```bash
docker build -t watercooler .
docker run -d --name watercooler -p 3000:3000 -v watercooler-data:/data \
  -e INVITE_CODE=change-me watercooler
```

数据库在容器内的 `/data/watercooler.db`，挂载卷即可持久化。

### 备份

SQLite 开了 WAL 模式，不要直接复制正在使用的 db 文件，用：

```bash
sqlite3 data/watercooler.db ".backup 'backup-$(date +%F).db'"
```

## 配置

通过环境变量或仓库根目录的 `.env` 文件配置，全部可选，详见 [`.env.example`](.env.example)：

| 变量                                           | 默认值                | 说明                                                                    |
| ---------------------------------------------- | --------------------- | ----------------------------------------------------------------------- |
| `HOST`                                         | `0.0.0.0`             | 监听地址，放在 nginx 后面时设为 `127.0.0.1`                             |
| `PORT`                                         | `3000`                | 服务端口                                                                |
| `BASE_PATH`                                    | 无（站点根目录）      | 部署在子路径下时设置，如 `/watercooler`；**构建前端和运行服务时都要设** |
| `DATABASE_PATH`                                | `data/watercooler.db` | SQLite 文件路径                                                         |
| `SITE_NAME`                                    | `Watercooler`         | 站点名称（logo、页脚、网页标题），**构建前端时设**                      |
| `SITE_COPY`                                    | `watercooler`         | 文案风格：`watercooler`（茶水间）或 `neutral`（中性），**构建前端时设** |
| `INVITE_CODE`                                  | 无                    | 设置后注册必须填写邀请码                                                |
| `STARTING_BALANCE`                             | `1000`                | 注册赠送水滴                                                            |
| `DAILY_BONUS`                                  | `100`                 | 每日签到奖励，`0` 关闭                                                  |
| `PRIVATE_MODE`                                 | `false`               | 开启后必须登录才能看到任何内容                                          |
| `APP_TIMEZONE`                                 | `Asia/Shanghai`       | 每日签到按哪个时区算「今天」                                            |
| `POLYMARKET_GAMMA_URL` / `POLYMARKET_CLOB_URL` | Polymarket 官方 API   | 镜像盘用的 Polymarket 公开接口，服务器连不上时可换成代理地址            |

## 玩法说明

**奖池模式**：每个选项有一个奖池，你押多少水滴，就往那个选项的奖池里放多少。某个选项奖池占全部奖池的比例，就是大家眼中它发生的概率。

**派奖**：发起人公布结果后，押中的人按各自下注金额的比例瓜分**全部**奖池（包括押错的人的钱）。比如是/否两边分别押了 300 和 100，结果是「否」，押「否」的人就按比例分这 400，相当于赔率 ×4。没有人押中的话，所有下注全额退还。系统不抽成、也不补贴，水滴只在玩家之间流动。

**赔率会变**：下注时看到的赔率是按当时奖池算的，后面有人继续下注，赔率会变化，最终按截止时的奖池计算。下注之后不能撤回。

**发起人**：任何人都能发起市场，由发起人负责公布结果，发起人自己也可以下注。奖池市场结果确定后随时可以公布并兑付，Polymarket 市场要到结算时间后才能公布；奖池模式在结算时间后 7 天未公布会自动取消并退款，Polymarket 模式不可取消，保留持仓和抵押资金一直等结算。奖池市场的题目有歧义时可以主动取消，下注全额退还。

**盈亏与排名**：盈利只统计已结算市场的全部资金流水净额，包含投入、买卖、拆分、合并、订单冻结与释放、最终兑付或退款。入账净值 = 累计获得的水滴（注册、签到）+ 已结算盈利。未结算市场的交易盈亏（包括已经平仓的收益）要等市场最终结算后才入榜，挂单价和成交价不会重估其他人的持仓。可用余额仍是实际资金；未结算净投入 = 入账净值 − 可用余额，含订单冻结资金，回款超过投入时可为负。排行榜默认按已结算盈利排名。

## 安全

这是给熟人用的小工具，但基本的东西都做了：

- 密码使用 scrypt + 随机盐哈希；登录失败按用户名限流（15 分钟 10 次）
- 会话 token 只存哈希，Cookie 为 `httpOnly` + `SameSite=Lax`，HTTPS 下自动加 `Secure`
- 所有写操作只接受 `application/json`，配合 SameSite Cookie 防 CSRF
- 所有输入都经过 zod 校验；SQL 全部参数化
- 资金变动都在 SQLite 事务里完成，并记入 `ledger` 流水表，可审计

默认未登录也能浏览市场、排行榜和个人主页（和 Polymarket 一样，下注需要登录）。如果要放到公网，建议设置 `INVITE_CODE` 和 `PRIVATE_MODE=true`，并在前面加一层 HTTPS 反向代理（Nginx / Caddy）。

## 界面风格与黑夜模式

界面参照非凸科技官网（ft.tech）的设计语言：浅色底、品牌蓝 `#1C55FB`、PingFang / 微软雅黑系统字体、4px 小圆角按钮、蓝色下划线标签页。顶栏右侧的太阳/月亮按钮可以切换**黑夜模式**，选择会记在浏览器里，默认是日间模式。

所有颜色都是 [`apps/web/src/index.css`](apps/web/src/index.css) 里的设计变量：日间模式在顶部的 `@theme` 里，黑夜模式在下面的 `html.dark` 里，改配色只需要改这两处。
