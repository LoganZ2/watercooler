# 交易 API

所有 URL 以站点根路径下的 `/api` 开头，JSON 请求/响应。写请求使用 `POST` 和 `Content-Type: application/json`，没有参数时发送 `{}`。金额单位为水滴，价格 0.01–0.99，整数份额；不收手续费。

## 认证

`POST /auth/login` 发送 `{username, password}`，保存响应的 `wc_session` Cookie，此后在同一站点的请求中携带该 Cookie。`POST /auth/register` 可注册并登录，`GET /auth/me` 查询当前用户，`POST /auth/logout` 撤销当前会话。会话有效期、密码保护、登录限流和私有模式与网页一致；不得跨账户共用 Cookie。

一般情况下市场行情公开，`PRIVATE_MODE=true` 时也需要先登录。自己的订单、成交、持仓和交易操作始终要求登录。查询或取消他人的订单返回 404。

## 接口

| 方法 | 路径                                     | 参数/响应                                                                                                                          |
| ---- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| GET  | `/markets?mode=polymarket&filter=active` | 现有市场列表，可用 `mode=pool` 或省略 mode；`limit` 最多 200                                                                       |
| GET  | `/markets/:id`                           | 现有市场详情与选项 ID                                                                                                              |
| POST | `/markets`                               | `{question, category, closeAt, mode:"polymarket", outcomes, description?}`；`outcomes` 为 `["Yes","No"]` 或 3 个以上选项（多选题） |
| GET  | `/trading/markets/:id/book`              | `{marketId, status, collateral, books, serverTime}`；每个 book 有 `outcomeId,token,bids,asks,lastPrice`，已合并互补挂单            |
| GET  | `/trading/markets/:id/trades`            | 分页公开成交，`limit,before`                                                                                                       |
| GET  | `/trading/account`                       | `{user, stats, positions, openOrders}`                                                                                             |
| GET  | `/trading/positions`                     | 本人的份额列表：数量、冻结量、`token`、成本 `cost`、均价 `avgPrice`、现价 `price`、估值 `value` 和 `pnl`（只供参考）、市场状态     |
| POST | `/trading/orders`                        | `{marketId, outcomeId, token?, side, type?, price?, quantity 或 amount, expiresAt?, postOnly?, clientOrderId?}`，见下文            |
| GET  | `/trading/orders/:id`                    | 本人单笔订单                                                                                                                       |
| GET  | `/trading/orders`                        | 分页本人订单；可按 `marketId,status,clientOrderId` 过滤                                                                            |
| POST | `/trading/orders/:id/cancel`             | 撤销剩余数量，返回订单最新状态；已撤订单重复调用安全，已全部成交则 409                                                             |
| GET  | `/trading/trades`                        | 分页本人成交；可按 `marketId` 过滤                                                                                                 |
| POST | `/trading/markets/:id/split`             | `{quantity, outcomeId?}`；每 1 水滴生成 1 Yes + 1 No；多选题必须指定选项                                                           |
| POST | `/trading/markets/:id/merge`             | `{quantity, outcomeId?}`；每对未冻结的 Yes/No 兑换 1 水滴                                                                          |
| POST | `/trading/markets/:id/convert`           | `{outcomeIds, quantity}`；多选题：k 个选项的 No 各 1 份 → k−1 水滴 + 其余每个选项 1 份 Yes                                         |
| GET  | `/markets/:id/exchange/holders`          | 每个份额持仓最多的人：`user,outcomeId,token,quantity,avgPrice`                                                                     |
| GET  | `/markets/:id/exchange/activity`         | 成交动态（每笔成交的双方），`before` 为上一页最后的 `tradeId`                                                                      |
| POST | `/markets/:id/resolve`                   | 创建者公布 `{outcomeId, note?}`，获胜每份兑付 1                                                                                    |
| POST | `/markets/:id/cancel`                    | 仅奖池市场允许创建者取消 `{note?}`；Polymarket 返回 403                                                                            |

已有网页使用的 `/markets/:id/orders`、`/exchange`、`/split`、`/merge` 等接口继续保留，共用同一个撮合与账本实现。

`/trading/account`、`/portfolio` 和用户统计中的 `stats.profit` 只统计已结算市场的全部账本净收支；`stats.netWorth = stats.funded + stats.profit` 为入账净值，不按挂单或最近成交价重估持仓。未结算市场的交易盈亏（即使已平仓）暂不计入这两项排名。`stats.balance` 是实际可用余额；`stats.staked = stats.netWorth - stats.balance` 为未结算净投入（含订单冻结资金），回款超过投入时可为负。保留现有字段名以兼容客户端，此口径无需数据库迁移，也适用于历史流水。

## 停止交易与结算时间

创建市场使用 `closeAt` 设置停止交易时间，另用 `settleAt` 设置结算时间，均为 Unix 毫秒；`settleAt >= closeAt`，两者均不能超过未来 5 年。省略 `settleAt` 时默认为 `closeAt`，旧市场也迁移为这两个时间相同。

到 `closeAt` 停止下注、下单和拆分/合并，未成交订单撤销并释放冻结资产；持仓保留。Polymarket 市场到 `settleAt` 后创建者才可调用 `/resolve` 公布结果并立即兑付，提前调用返回 409；奖池市场的创建者随时可以公布，提前公布会立即停止下注。Polymarket 市场不可取消，包括创建者手动取消和超时自动取消；未公布结果时保留持仓和抵押资金，一直等待结算，不会自动选择 Yes/No。撤销未成交订单仍受支持。列表和详情返回 `closeAt, settleAt`，详情另外返回实际结算时间 `resolvedAt`，Polymarket 不返回 `resolveBy`。奖池市场仍可由创建者主动取消，也会在 `settleAt + 7 天` 未公布时自动取消、全额退款，详情返回对应的 `resolveBy`。

## 订单与幂等

**份额**：`outcomeId` 加 `token`（`yes` 默认 / `no`）。是非题直接用 Yes 或 No 选项的 `outcomeId`（在 Yes 选项上写 `token:"no"` 等于 No 选项）；多选题每个选项各有 Yes 和 No 两种份额。

**订单类型** `type`：`GTC`（默认，挂到成交或撤单）、`GTD`（需要 `expiresAt` 毫秒时间戳，至少 1 分钟后，到期自动撤销剩余部分，到期后不再成交）、`FOK` / `FAK`（市价单，马上按盘口成交，从不挂单：FOK 不能全部成交就返回 409，FAK 成交能成交的部分、其余取消，状态为 `cancelled`）。限价单必须给 `price`；市价单的 `price` 是最差成交价，默认买 0.99、卖 0.01。`quantity`（份数）和 `amount`（只用于 FOK/FAK 买入：花多少水滴，按整份逐档买入）二选一。市价买单只冻结并扣除实际成交金额。盘口上没有可成交的对手单时返回 409。

下单可增加布尔参数 `postOnly`，默认 `false`。设为 `true` 时只允许挂单：如果会与其他用户的普通订单或互补订单立即成交，即使只会成交一小部分，也返回 HTTP 409 并拒绝整笔订单，不产生订单记录、冻结资产或成交。成功挂入的订单仍可被之后的订单成交，查询响应包含 `postOnly` 标记。

所有新订单（含 Post-only）都禁止与自己的未成交挂单交叉，价格刚好相等也视为交叉；检查包含同一选项的买卖单及互补选项的同方向订单。发现交叉即返回 HTTP 409，提示冲突订单编号并要求先撤旧单或调整价格；旧单保持不变，新单不会冻结资产、产生订单记录或与其他用户部分成交。已成交和已撤销的订单不参与检查；已接受订单的幂等重试仍返回原订单。

`postOnly`、`type`、份额、`price`、`quantity`/`amount` 和 `expiresAt` 都属于订单幂等参数，复用同一个 `clientOrderId` 时不能更改。Post-only 只能用于 GTC/GTD。被拒绝的订单不会占用客户端编号。

下单响应 HTTP 201，包括 `id,marketId,outcomeId,token,outcomeLabel,side,type,price,quantity,remaining,amount,expiresAt,postOnly,status,createdAt,clientOrderId`。按金额买入的订单 `quantity` 是实际买到的份数，`amount` 是给出的金额。`status` 为 `open`、`filled` 或 `cancelled`；部分成交仍为 `open`，`quantity-remaining` 是已成交量。已撤订单的 `remaining` 记录撤销量，已成交部分不会回滚。

`clientOrderId` 为同一用户全局唯一的 1–64 字符编号，只接受字母、数字和 `._:-`。相同编号、相同参数重复提交返回原订单最新状态（仍为 201），包括已经撤销、成交或市场截止的情况；更换参数返回 409。幂等查询和资产冻结在同一个 SQLite 事务中完成。可以通过 `/trading/orders?clientOrderId=...` 恢复请求状态。

未提供编号的原始 API 请求没有下单幂等保护；Python SDK 默认自动生成编号。拆分、合并和创建市场不是幂等操作，不可在网络失败后盲目重试。

## 分页与成交方向

订单和成交列表返回 `{items, nextCursor}`；`limit` 默认 50，范围 1–200。按 ID 倒序；`before` 是上一页的 `nextCursor`，为空表示没有下一页。游标不包含当前记录，翻页时保持过滤参数不变。

本人成交包含 `id,marketId,orderId,outcomeId,token,outcomeLabel,side,price,amount,quantity,role,kind,createdAt`。`role` 为 `maker/taker`，`kind` 为 `transfer/mint/merge`。`price` 始终按本人的选项返回。例如 Yes 买单 0.40 与 No 买单 0.60 成交，Yes 用户看到 0.40，No 用户看到 0.60。`amount=price×quantity`，是该笔成交金额，不是利润；`side` 表示买入或卖出。

公开市场成交以触发成交的订单（taker）的份额和价格记录，一次成交只出现一条；通过 `outcomeId` 和 `token` 区分份额。盘口和 Polymarket 一样合并互补挂单：某份额的卖单 = 它的卖单 + 互补份额的买单按 1−p 换算，买单同理，同价汇总剩余份数，过期的 GTD 订单不显示。自己的订单不会与自己成交。所有时间为 Unix 毫秒。

市场列表及详情的 Polymarket 选项额外返回 `bestBid` / `bestAsk`：该选项（多选题为该选项的 Yes 份额）合并互补挂单后的最高买价和最低卖价，单位为每份水滴；没有对应挂单或交易已截止时为 `null`。`probability` 是显示价格：中间价，价差超过 0.10 时用最近成交价。

## 错误

失败响应为 `{error: "说明"}`。400 表示参数无效、余额/份额不足或模式不符；401 未登录；403 无市场结算权限；404 对象不存在或订单不属于本人；409 市场/订单状态或客户端编号冲突；415 写请求不是 JSON；429 登录/注册限流。网络超时不代表写操作失败，需要先查询状态。

Python 使用方法见 [`sdk/python/README.md`](../sdk/python/README.md)。
