# Watercooler Python SDK

本项目虚拟水滴市场的同步 Python SDK，Python ≥ 3.10，运行时只使用标准库。通过真实 HTTP API 交易，自动管理登录 Cookie；不是官方 Polymarket 链上 SDK。

## 安装

在仓库根目录创建 D 盘虚拟环境，安装和缓存均留在项目内：

```powershell
New-Item -ItemType Directory -Force .local/tmp | Out-Null
$env:TEMP = "$PWD\.local\tmp"
$env:TMP = $env:TEMP
$env:PIP_CACHE_DIR = "$PWD\.local\cache\pip"
python -m venv .local/python
.\.local\python\Scripts\python.exe -m pip install ./sdk/python
```

本机配置后可直接用 `.\.local\python\Scripts\python.exe` 运行脚本。也可设置 `PYTHONPATH=sdk/python` 从源码导入，无需安装。

## 示例

启动项目 API（默认 `http://localhost:3000`）后：

```python
from watercooler_sdk import WatercoolerClient

with WatercoolerClient("http://localhost:3000") as client:
    client.login("xiaoming", "demo123")
    markets = client.markets()  # 默认只列出进行中的 Polymarket 市场
    market = markets[0]       # 需要先在网页创建一个 Polymarket 市场
    yes = market["outcomes"][0]["id"]

    print(client.book(market["id"]))
    print(client.account())

    # 这是限价挂单，可能立即或部分成交，也可能保留在订单簿。
    order = client.place_order(
        market["id"], yes, "buy", price="0.40", quantity=10,
        client_order_id="strategy-20261018-001",
    )
    print(order["id"], order["status"], order["remaining"])

    # 仅在订单仍有未成交部分时撤单；已成交部分不会撤回。
    if order["status"] == "open":
        client.cancel_order(order["id"])
    client.logout()
```

市价单和限时挂单：

```python
# 花 25 水滴按盘口逐档买 Yes（只买整份），买不到的部分取消；最差成交价 0.60
client.market_order(market_id, yes, "buy", amount="25", worst_price="0.60")
# 卖出 10 份，不能全部成交就整单取消
client.market_order(market_id, yes, "sell", quantity=10, order_type="FOK")
# 挂单到明天这个时候，到期自动撤销剩余部分
client.place_order(market_id, yes, "buy", "0.35", 20, order_type="GTD", expires_at=tomorrow)
```

拆分与合并：

```python
client.split(market_id, quantity=10)  # 花费 10 水滴，得到 10 Yes + 10 No
client.merge(market_id, quantity=3)   # 消耗各 3 份未冻结的 Yes/No，取回 3 水滴
```

多选题（3 个以上选项）每个选项各有 Yes / No 两种份额，用 `token` 区分；拆分、合并要指定选项，No 份额可以转换：

```python
a, b, c = [o["id"] for o in client.market(market_id)["market"]["outcomes"]]
client.market_order(market_id, b, "buy", amount="10", token="no")  # 买「b 不会赢」
client.split(market_id, 5, outcome_id=a)                             # 5 份 a·Yes + 5 份 a·No
client.convert(market_id, [a], 5)                                    # 5 份 a·No → b·Yes 和 c·Yes 各 5 份
```

## 方法

| 方法                                                                                                                                         | 用途                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- |
| `register(username, password, display_name=..., invite_code=...)`                                                                            | 注册并登录，返回用户                                      |
| `login(username, password)` / `me()` / `logout()`                                                                                            | 登录、读取用户、撤销当前会话                              |
| `config()`                                                                                                                                   | 站点配置                                                  |
| `markets(mode="polymarket", filter="active", sort="new", limit=100, search=...)`                                                             | 搜索市场；`mode=None` 可列出两种模式                      |
| `market(market_id)`                                                                                                                          | 市场详情，返回 `{market, stakes}`                         |
| `create_market(question, close_at, settle_at=..., category=..., description=...)`                                                            | 分别设置停止交易和结算时间；毫秒整数或带时区的 `datetime` |
| `book(market_id)`                                                                                                                            | 每个份额的 bid/ask（已合并互补挂单）                      |
| `account()` / `positions()`                                                                                                                  | 余额、资产统计、持仓及未成交订单                          |
| `place_order(market_id, outcome_id, side, price, quantity, token=..., order_type="GTC", expires_at=..., post_only=..., client_order_id=...)` | 下限价单；`order_type="GTD"` 时需要 `expires_at`          |
| `market_order(market_id, outcome_id, side, amount=... 或 quantity=..., worst_price=..., token=..., order_type="FAK", client_order_id=...)`   | 市价单（FAK/FOK），买入可按金额                           |
| `order(order_id)` / `order_by_client_id(client_order_id)`                                                                                    | 查询自己的订单；按客户端编号查询未找到时返回 `None`       |
| `orders(market_id=..., status=..., client_order_id=..., limit=50, before=...)`                                                               | 分页查询自己的订单                                        |
| `cancel_order(order_id)`                                                                                                                     | 撤销未成交部分，重复撤销已撤订单安全                      |
| `trades(market_id=..., limit=50, before=...)`                                                                                                | 本人的成交，价格按自己的 Yes/No 方向返回                  |
| `market_trades(market_id, limit=50, before=...)`                                                                                             | 市场公开成交记录                                          |
| `split(market_id, quantity, outcome_id=...)` / `merge(...)`                                                                                  | 抵押生成/合并赎回完整份额；多选题要给 `outcome_id`        |
| `convert(market_id, outcome_ids, quantity)`                                                                                                  | 多选题：No 份额 → 现金 + 其余选项的 Yes                   |
| `holders(market_id)` / `activity(market_id, before=...)`                                                                                     | 持有者排行、成交动态（双方）                              |
| `resolve_market(market_id, outcome_id, note=...)` / `cancel_market(market_id, note=...)`                                                     | 创建者结算；取消仅限奖池市场                              |

返回普通字典/列表，沿用 API 的 camelCase 字段；JSON 小数解析为 `Decimal`，整数仍为 `int`。价格和金额输入可用字符串、`Decimal` 或浮点数，必须精确到 0.01；数量为 1–1,000,000 的整数。持仓返回均价 `avgPrice` 和按现价估算的 `value`、`pnl`，只供参考，不计入排行。

`settle_at` 不得早于 `close_at`，省略时等于 `close_at`。停止交易后未成交订单解冻；Polymarket 市场到结算时间后才可调用 `resolve_market` 公布结果并兑付，提前调用返回 409；奖池市场的创建者随时可以公布。Polymarket 市场不可取消，未公布时保留持仓和资金一直等待结算；`cancel_market` 返回 403，但 `cancel_order` 仍可撤销未成交订单。奖池模式在结算时间后 7 天未公布时自动退款，创建者也可使用 `cancel_market` 主动取消。

分页返回 `{items, nextCursor}`，按 ID 倒序，`nextCursor=None` 表示结束。把上一页的 `nextCursor` 作为下一页的 `before`，不要在翻页期间改变过滤条件。

```python
cursor = None
while True:
    page = client.trades(limit=100, before=cursor)
    for fill in page["items"]:
        print(fill["outcomeLabel"], fill["price"], fill["quantity"], fill["role"])
    cursor = page["nextCursor"]
    if cursor is None:
        break
```

## 重试与错误

### Post-only：只挂单

```python
order = client.place_order(market_id, yes_id, "buy", "0.39", 10,
                           post_only=True, client_order_id="maker-001")
print(order["postOnly"])  # True
```

`post_only` 默认为 `False`，只接受 Python 布尔值。为 `True` 时，如会立即与其他用户的普通或互补订单成交，整笔拒绝并抛出 `APIError(status=409)`，不会冻结资产；否则挂单等待别人来成交。改变 `post_only` 需要使用新的客户端订单编号。

`clientOrderId` 在同一用户下唯一，可使用 1–64 个字母、数字、`._:-`。相同编号和参数重复提交返回同一个订单的最新状态，不再次冻结或成交；相同编号换参数返回 HTTP 409。两个不同用户可以使用相同编号。

SDK 不自动重试请求。不指定编号时 SDK 自动生成 UUID；请求网络失败时 `TransportError.client_order_id` 保留这个编号。恢复时用该编号查询，或以**相同参数和相同编号**重新提交：

```python
from watercooler_sdk import APIError, TransportError

try:
    order = client.place_order(market_id, yes_id, "buy", "0.40", 10,
                              client_order_id="strategy-order-42")
except TransportError as exc:
    order = client.order_by_client_id(exc.client_order_id)
    # 如仍未查到，可用相同参数、同一个编号再次 place_order。
except APIError as exc:
    print(exc.status, str(exc))  # 400 参数/资产不足；401 未登录；404 无此订单；409 状态/编号冲突
```

`split`、`merge`、创建市场没有请求幂等编号；发生超时后先核对账户、持仓或市场状态，不能直接重复执行。`ProtocolError` 表示成功响应不是合法 JSON，写操作也可能已经执行。会话到期会返回 401，需要重新登录；SDK 不保存用户名密码到磁盘、不自动重新登录。

`base_url` 支持站点根 URL、子路径或以 `/api` 结尾的地址，如 `https://example.com/watercooler`。`timeout` 默认 15 秒。每个账户/线程独立创建一个 client。`close()` 仅清理本地 Cookie，`logout()` 才会撤销服务器会话。

## 测试

在仓库根目录安装 Node 依赖后执行：

```powershell
python -m unittest discover -s sdk/python/tests -t sdk/python -v
```

测试使用独立内存数据库和随机本机端口，覆盖真实 Python → HTTP → Hono → SQLite 的交易流程、会话隔离、私有模式和子路径 Cookie，不接触 `data/watercooler.db`。Node 优先使用项目 `.local` 内的 22 版本，否则使用 PATH 中的 Node；可通过 `WATERCOOLER_NODE` 指定。
