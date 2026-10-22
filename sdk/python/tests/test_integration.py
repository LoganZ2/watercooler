"""Real HTTP test against an isolated in-memory Node/Hono server, including subpath cookies."""

from datetime import datetime, timedelta, timezone
from decimal import Decimal
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest

from watercooler_sdk import APIError, WatercoolerClient


class TradingIntegrationTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parents[3]
        local = root / ".local"
        temp_root = local / "tmp"
        temp_root.mkdir(parents=True, exist_ok=True)
        cls.temp = tempfile.TemporaryDirectory(dir=temp_root)
        ready = Path(cls.temp.name) / "ready.txt"
        portable = sorted(local.glob("node-v22.*-win-x64/node.exe"))
        node = os.environ.get("WATERCOOLER_NODE") or (str(portable[-1]) if portable else shutil.which("node"))
        if not node:
            cls.temp.cleanup()
            raise RuntimeError("Node.js is required for SDK integration tests")
        env = {**os.environ, "TEMP": str(temp_root), "TMP": str(temp_root), "WATERCOOLER_READY_FILE": str(ready),
               "NODE_COMPILE_CACHE": str(local / "cache" / "node-compile")}
        cls.process = subprocess.Popen(
            [node, "--import", "tsx", str(root / "apps/server/test/python-server.ts")],
            cwd=root / "apps/server", env=env, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE,
            creationflags=subprocess.CREATE_NO_WINDOW if os.name == "nt" else 0,
        )
        deadline = time.monotonic() + 20
        while not ready.exists() and cls.process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        if not ready.exists():
            cls.process.terminate()
            _, errors = cls.process.communicate(timeout=5)
            cls.temp.cleanup()
            raise RuntimeError(f"Test server did not start: {errors.decode(errors='replace')}")
        cls.url = ready.read_text()

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        try:
            cls.process.communicate(timeout=5)
        except subprocess.TimeoutExpired:
            cls.process.kill()
            cls.process.communicate()
        cls.temp.cleanup()

    def test_full_trading_lifecycle_with_actual_sdk(self):
        with WatercoolerClient(self.url) as seller, WatercoolerClient(self.url + "/api") as buyer, WatercoolerClient(self.url) as anonymous:
            with self.assertRaises(APIError) as error:
                anonymous.account()
            self.assertEqual(error.exception.status, 401)
            seller.register("sdk_seller", "secret123")
            buyer.register("sdk_buyer", "secret123")
            buyer.logout()
            self.assertIsNone(buyer.me())
            self.assertEqual(buyer.login("sdk_buyer", "secret123")["username"], "sdk_buyer")
            market_id = seller.create_market("SDK 验证：明天会下雨吗？", datetime.now(timezone.utc) + timedelta(days=1))["id"]
            self.assertEqual(len(buyer.markets()), 1)
            market = buyer.market(market_id)["market"]
            yes, no = [o["id"] for o in market["outcomes"]]
            seller.split(market_id, 20)
            ask = seller.place_order(market_id, yes, "sell", ".60", 10, client_order_id="ask-1")
            with self.assertRaises(APIError) as self_cross:
                seller.place_order(market_id, yes, "buy", ".60", 1, client_order_id="self-rejected")
            self.assertEqual(self_cross.exception.status, 409)
            self.assertIsNone(seller.order_by_client_id("self-rejected"))
            self.assertEqual(seller.me()["balance"], 980)
            with self.assertRaises(APIError) as crossing:
                buyer.place_order(market_id, yes, "buy", ".70", 4, post_only=True, client_order_id="post-rejected")
            self.assertEqual(crossing.exception.status, 409)
            self.assertEqual(buyer.me()["balance"], 1000)
            self.assertIsNone(buyer.order_by_client_id("post-rejected"))
            self.assertEqual(buyer.book(market_id)["books"][0]["asks"][0]["price"], Decimal(".60"))
            bought = buyer.place_order(market_id, yes, "buy", ".70", 4, client_order_id="buy-1")
            self.assertEqual(bought["status"], "filled")
            self.assertEqual(buyer.me()["balance"], Decimal("997.60"))
            stats = buyer.account()["stats"]
            self.assertEqual(stats["profit"], 0)
            self.assertEqual(stats["netWorth"], 1000)
            self.assertEqual(stats["staked"], Decimal("2.40"))
            self.assertEqual(buyer.place_order(market_id, yes, "buy", ".70", 4, client_order_id="buy-1")["id"], bought["id"])
            self.assertEqual(buyer.order_by_client_id("buy-1")["id"], bought["id"])
            self.assertIsNone(buyer.order_by_client_id("missing"))
            with self.assertRaises(APIError) as conflict:
                buyer.place_order(market_id, yes, "buy", ".71", 4, client_order_id="buy-1")
            self.assertEqual(conflict.exception.status, 409)
            self.assertEqual(buyer.order(bought["id"])["quantity"], 4)
            with self.assertRaises(APIError) as forbidden:
                seller.order(bought["id"])
            self.assertEqual(forbidden.exception.status, 404)
            seller.place_order(market_id, yes, "buy", ".40", 5, client_order_id="mint-yes")
            buyer.place_order(market_id, no, "buy", ".60", 5, client_order_id="mint-no")
            self.assertEqual(seller.trades(limit=1)["items"][0]["price"], Decimal(".40"))
            self.assertEqual(buyer.trades(limit=1)["items"][0]["price"], Decimal(".60"))
            self.assertEqual(buyer.market_trades(market_id)["items"][0]["kind"], "mint")
            page = buyer.orders(limit=1)
            older = buyer.orders(limit=1, before=page["nextCursor"])
            self.assertNotEqual(page["items"][0]["id"], older["items"][0]["id"])
            self.assertEqual(seller.cancel_order(ask["id"])["status"], "cancelled")
            self.assertEqual(seller.cancel_order(ask["id"])["status"], "cancelled")
            post = seller.place_order(market_id, yes, "sell", ".80", 1, post_only=True)
            self.assertTrue(post["postOnly"])
            self.assertEqual(post["status"], "open")
            buyer.place_order(market_id, yes, "buy", ".80", 1)
            self.assertEqual(seller.order(post["id"])["status"], "filled")
            self.assertEqual(seller.trades(limit=1)["items"][0]["role"], "maker")
            pending = buyer.place_order(market_id, yes, "buy", ".10", 1)
            self.assertTrue(buyer.account()["openOrders"])
            buyer.cancel_order(pending["id"])
            seller.merge(market_id, 3)
            self.assertTrue(buyer.positions())
            with self.assertRaises(APIError) as early:
                seller.resolve_market(market_id, yes)
            self.assertEqual(early.exception.status, 409)
            advanced = seller._request("POST", "/__test/advance")["now"]
            seller.resolve_market(market_id, yes)
            self.assertEqual(seller.book(market_id)["collateral"], 0)
            self.assertEqual(seller.account()["user"]["balance"] + buyer.account()["user"]["balance"], 2000)
            second = seller.create_market("SDK 验证：取消另一个市场？", advanced + 86400000)["id"]
            seller.split(second, 2)
            with self.assertRaises(APIError) as cancellation:
                seller.cancel_market(second)
            self.assertEqual(cancellation.exception.status, 403)
            self.assertEqual(seller.market(second)["market"]["status"], "open")
            self.assertEqual(seller.book(second)["collateral"], 2)
            pool = seller.create_market("SDK 验证：仍可取消奖池市场？", advanced + 86400000, mode="pool")["id"]
            seller.cancel_market(pool)
            self.assertEqual(seller.market(pool)["market"]["status"], "cancelled")

    def test_market_orders_and_multi_outcome_markets(self):
        with WatercoolerClient(self.url) as maker, WatercoolerClient(self.url) as taker:
            maker.register("sdk_mm", "secret123")
            taker.register("sdk_taker", "secret123")
            now = maker._request("POST", "/__test/advance")["now"]
            market_id = maker.create_market("SDK 验证：谁会拿到年度最佳？", now + 86400000, outcomes=["甲", "乙", "丙"])["id"]
            a, b, c = [o["id"] for o in taker.market(market_id)["market"]["outcomes"]]
            self.assertEqual([(x["outcomeId"], x["token"]) for x in maker.book(market_id)["books"]],
                [(a, "yes"), (a, "no"), (b, "yes"), (b, "no"), (c, "yes"), (c, "no")])
            with self.assertRaises(APIError) as missing:
                maker.split(market_id, 10)
            self.assertEqual(missing.exception.status, 400)
            maker.split(market_id, 10, outcome_id=a)
            maker.place_order(market_id, a, "sell", ".40", 10)
            gtd = maker.place_order(market_id, a, "sell", ".70", 10, token="no", order_type="GTD", expires_at=now + 3600000)
            self.assertEqual((gtd["type"], gtd["token"], gtd["expiresAt"]), ("GTD", "no", now + 3600000))

            bought = taker.market_order(market_id, a, "buy", amount="2.00", client_order_id="mkt-a")
            self.assertEqual((bought["quantity"], bought["status"], bought["type"]), (5, "filled", "FAK"))
            self.assertEqual(taker.market_order(market_id, a, "buy", amount="2.00", client_order_id="mkt-a")["id"], bought["id"])
            with self.assertRaises(APIError) as fok:
                taker.market_order(market_id, a, "buy", quantity=50, order_type="FOK")
            self.assertEqual(fok.exception.status, 409)
            taker.market_order(market_id, a, "buy", quantity=4, token="no", worst_price=".70")

            converted = taker.convert(market_id, [a], 4)
            held = {(p["outcomeId"], p["token"]): p["quantity"] for p in converted["positions"]}
            self.assertEqual((held[(a, "no")], held[(b, "yes")], held[(c, "yes")]), (0, 4, 4))
            self.assertEqual(maker.holders(market_id)[0]["user"]["username"], "sdk_mm")
            latest = maker.activity(market_id)[0]
            self.assertEqual((latest["user"]["username"], latest["side"], latest["token"], latest["price"]),
                ("sdk_taker", "buy", "no", Decimal(".7")))
            positions = {(p["outcomeId"], p["token"]): p for p in taker.positions()}
            self.assertEqual(positions[(a, "yes")]["avgPrice"], Decimal(".4"))
            self.assertEqual(positions[(b, "yes")]["outcomeLabel"], "乙 · Yes")


if __name__ == "__main__":
    unittest.main()
