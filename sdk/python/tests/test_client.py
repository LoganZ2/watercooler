from decimal import Decimal
from datetime import datetime, timedelta, timezone
from io import BytesIO
import json
import unittest
from unittest.mock import Mock
from urllib.error import HTTPError, URLError

from watercooler_sdk import APIError, ProtocolError, TransportError, WatercoolerClient


class ClientTests(unittest.TestCase):
    def setUp(self):
        self.client = WatercoolerClient("https://example.test/desk/")
        self.client._opener = Mock()

    def test_json_body_prefix_and_decimal_response(self):
        self.client._opener.open.return_value = BytesIO(b'{"id": 1, "price": 0.29}')
        order = self.client.place_order(1, 2, "buy", Decimal("0.29"), 3, client_order_id="bot:1", post_only=True)
        self.assertEqual(order["price"], Decimal("0.29"))
        request = self.client._opener.open.call_args.args[0]
        self.assertEqual(request.full_url, "https://example.test/desk/api/trading/orders")
        self.assertEqual(request.get_header("Content-type"), "application/json")
        self.assertEqual(json.loads(request.data)["clientOrderId"], "bot:1")
        self.assertEqual(json.loads(request.data)["quantity"], 3)
        self.assertIs(json.loads(request.data)["postOnly"], True)

    def test_validates_financial_inputs_before_sending(self):
        for value in ["NaN", "Infinity", "0", "1", "0.501", "abc", True]:
            with self.subTest(price=value), self.assertRaises(ValueError):
                self.client.place_order(1, 2, "buy", value, 1)
        for quantity in [True, 0, -1, 1.5, 1000001]:
            with self.subTest(quantity=quantity), self.assertRaises(ValueError):
                self.client.split(1, quantity)
        with self.assertRaises(ValueError):
            self.client.order_by_client_id("")
        with self.assertRaises(ValueError):
            self.client.place_order(1, 2, "buy", ".4", 1, client_order_id="")
        self.client._opener.open.assert_not_called()

    def test_post_only_requires_boolean_and_defaults_to_false(self):
        for flag in [1, "true", None]:
            with self.subTest(flag=flag), self.assertRaises(ValueError):
                self.client.place_order(1, 2, "buy", ".4", 1, post_only=flag)
        self.client._opener.open.assert_not_called()
        self.client._opener.open.return_value = BytesIO(b'{"id":1}')
        self.client.place_order(1, 2, "buy", ".4", 1)
        self.assertIs(json.loads(self.client._opener.open.call_args.args[0].data)["postOnly"], False)

    def test_market_orders_gtd_and_convert_validate_before_sending(self):
        bad = [
            lambda: self.client.market_order(1, 2, "buy"),
            lambda: self.client.market_order(1, 2, "buy", amount="1", quantity=1),
            lambda: self.client.market_order(1, 2, "sell", amount="1"),
            lambda: self.client.market_order(1, 2, "buy", amount="0.001"),
            lambda: self.client.market_order(1, 2, "buy", amount=True),
            lambda: self.client.market_order(1, 2, "buy", quantity=1, order_type="GTC"),
            lambda: self.client.market_order(1, 2, "buy", quantity=1, token="maybe"),
            lambda: self.client.place_order(1, 2, "buy", ".4", 1, order_type="GTD"),
            lambda: self.client.place_order(1, 2, "buy", ".4", 1, expires_at=1),
            lambda: self.client.place_order(1, 2, "buy", ".4", 1, order_type="FOK"),
            lambda: self.client.convert(1, [], 1),
        ]
        for i, call in enumerate(bad):
            with self.subTest(case=i), self.assertRaises(ValueError):
                call()
        self.client._opener.open.assert_not_called()
        self.client._opener.open.return_value = BytesIO(b'{"id":1}')
        self.client.market_order(1, 2, "buy", amount="12.50", worst_price=".6", token="no", client_order_id="m:1")
        body = json.loads(self.client._opener.open.call_args.args[0].data)
        self.assertEqual(body, {"marketId": 1, "outcomeId": 2, "side": "buy", "token": "no", "clientOrderId": "m:1",
            "type": "FAK", "amount": 12.5, "price": 0.6})
        self.client._opener.open.return_value = BytesIO(b'{"id":2}')
        expires = datetime(2027, 1, 1, tzinfo=timezone.utc)
        self.client.place_order(1, 2, "sell", ".4", 3, order_type="GTD", expires_at=expires)
        body = json.loads(self.client._opener.open.call_args.args[0].data)
        self.assertEqual((body["type"], body["expiresAt"]), ("GTD", int(expires.timestamp() * 1000)))
        self.client._opener.open.return_value = BytesIO(b'{"ok":true}')
        self.client.split(1, 5, outcome_id=7)
        self.assertEqual(json.loads(self.client._opener.open.call_args.args[0].data), {"quantity": 5, "outcomeId": 7})

    def test_http_errors_retain_status_and_message(self):
        self.client._opener.open.side_effect = HTTPError("https://example.test", 409, "Conflict", {}, BytesIO(b'{"error":"duplicate key"}'))
        with self.assertRaises(APIError) as raised:
            self.client.cancel_order(1)
        self.assertEqual(raised.exception.status, 409)
        self.assertEqual(str(raised.exception), "duplicate key")

    def test_separate_trading_and_settlement_times(self):
        close = datetime(2027, 1, 1, tzinfo=timezone.utc)
        settle = close + timedelta(days=10)
        for invalid in [close - timedelta(seconds=1), datetime(2027, 1, 2), True, "invalid"]:
            with self.subTest(settle=invalid), self.assertRaises(ValueError):
                self.client.create_market("test market", close, settle_at=invalid)
        self.client._opener.open.assert_not_called()
        self.client._opener.open.return_value = BytesIO(b'{"id":1}')
        self.client.create_market("test market", close, settle_at=settle)
        body = json.loads(self.client._opener.open.call_args.args[0].data)
        self.assertEqual(body["closeAt"], int(close.timestamp() * 1000))
        self.assertEqual(body["settleAt"], int(settle.timestamp() * 1000))
        self.client._opener.open.return_value = BytesIO(b'{"id":2}')
        self.client.create_market("test market", close)
        body = json.loads(self.client._opener.open.call_args.args[0].data)
        self.assertEqual(body["settleAt"], body["closeAt"])

    def test_transport_failure_does_not_retry_and_exposes_recovery_key(self):
        self.client._opener.open.side_effect = URLError("timed out")
        with self.assertRaises(TransportError) as raised:
            self.client.place_order(1, 2, "buy", ".4", 1)
        self.assertEqual(len(raised.exception.client_order_id), 32)
        self.client._opener.open.assert_called_once()

    def test_rejects_non_json_response(self):
        self.client._opener.open.return_value = BytesIO(b"<html>proxy</html>")
        with self.assertRaises(ProtocolError):
            self.client.account()

    def test_url_validation_and_api_suffix(self):
        self.assertEqual(WatercoolerClient("https://example.test/desk/api/").api_url, "https://example.test/desk/api")
        for url in ["file:///data", "https://user:secret@example.test", "https://example.test?a=b", "https://example.test#x"]:
            with self.subTest(url=url), self.assertRaises(ValueError):
                WatercoolerClient(url)
        for timeout in [0, -1, float("nan"), True]:
            with self.subTest(timeout=timeout), self.assertRaises(ValueError):
                WatercoolerClient(timeout=timeout)


if __name__ == "__main__":
    unittest.main()
