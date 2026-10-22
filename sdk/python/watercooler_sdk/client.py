"""Synchronous, dependency-free client for Watercooler's JSON trading API."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from http.cookiejar import CookieJar
from http.client import HTTPException
import json
import math
import re
from typing import Any, Literal
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode, urlsplit
from urllib.request import HTTPCookieProcessor, Request, build_opener
from uuid import uuid4

Side = Literal["buy", "sell"]
Token = Literal["yes", "no"]
JSON = dict[str, Any]


class APIError(Exception):
    """A non-success HTTP response. `status` and `body` retain server details."""

    def __init__(self, status: int, message: str, body: Any = None):
        super().__init__(message)
        self.status = status
        self.body = body


class ProtocolError(Exception):
    """The server returned an unexpected, non-JSON success response."""

    client_order_id: str | None = None


class TransportError(Exception):
    """Connection failure; a submitted mutation may already have executed."""

    client_order_id: str | None = None


def _integer(value: int, name: str, maximum: int = 2**53 - 1) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or not 1 <= value <= maximum:
        raise ValueError(f"{name} must be an integer between 1 and {maximum}")
    return value


def _price(value: Decimal | str | float) -> float:
    if isinstance(value, bool):
        raise ValueError("price must be 0.01–0.99 in increments of 0.01")
    try:
        price = Decimal(str(value))
        if not price.is_finite() or not Decimal("0.01") <= price <= Decimal("0.99") or price * 100 != (price * 100).to_integral_value():
            raise ValueError("price must be 0.01–0.99 in increments of 0.01")
    except InvalidOperation as exc:
        raise ValueError("invalid price") from exc
    return float(price)


def _amount(value: Decimal | str | float) -> float:
    if isinstance(value, bool):
        raise ValueError("amount must be 0.01–1000000 in increments of 0.01")
    try:
        amount = Decimal(str(value))
        if not amount.is_finite() or not Decimal("0.01") <= amount <= Decimal("1000000") or amount * 100 != (amount * 100).to_integral_value():
            raise ValueError("amount must be 0.01–1000000 in increments of 0.01")
    except InvalidOperation as exc:
        raise ValueError("invalid amount") from exc
    return float(amount)


def _timestamp(value: int | datetime, name: str) -> int:
    if isinstance(value, datetime):
        if value.utcoffset() is None:
            raise ValueError(f"{name} datetime must include a timezone")
        value = int(value.timestamp() * 1000)
    return _integer(value, name)


def _client_order_id(client_order_id: str | None) -> str:
    key = uuid4().hex if client_order_id is None else client_order_id
    if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", key):
        raise ValueError("invalid client_order_id")
    return key


class WatercoolerClient:
    """One in-memory CookieJar per client; no automatic retries or credential persistence.

    `base_url` accepts a site root, deployment subpath, or a URL ending in `/api`.
    Use one client per account/thread. Decimal JSON numbers are returned as Decimal.
    """

    def __init__(self, base_url: str = "http://localhost:3000", *, timeout: float = 15):
        url = urlsplit(base_url)
        if url.scheme not in ("http", "https") or not url.hostname or url.username is not None or url.password is not None or url.query or url.fragment:
            raise ValueError("base_url must be an HTTP(S) site URL without credentials, query or fragment")
        if isinstance(timeout, bool) or not math.isfinite(timeout) or timeout <= 0:
            raise ValueError("timeout must be positive and finite")
        root = base_url.rstrip("/")
        self.api_url = root if url.path.rstrip("/").endswith("/api") else root + "/api"
        self.timeout = timeout
        self._cookies = CookieJar()
        self._opener = build_opener(HTTPCookieProcessor(self._cookies))

    def __enter__(self) -> WatercoolerClient:
        return self

    def __exit__(self, *_: Any) -> None:
        self.close()

    def close(self) -> None:
        """Discard local cookies. Call logout() to revoke the server session as well."""
        self._cookies.clear()
        self._opener.close()

    def _request(self, method: str, path: str, body: JSON | None = None, query: JSON | None = None) -> Any:
        url = self.api_url + path
        if query:
            encoded = urlencode({key: value for key, value in query.items() if value is not None})
            if encoded:
                url += "?" + encoded
        headers = {"Accept": "application/json", "User-Agent": "watercooler-sdk/0.1.0"}
        data = None
        if method == "POST":
            headers["Content-Type"] = "application/json"
            data = json.dumps(body if body is not None else {}, ensure_ascii=False, allow_nan=False).encode("utf-8")
        request = Request(url, data=data, headers=headers, method=method)
        try:
            with self._opener.open(request, timeout=self.timeout) as response:
                payload = response.read()
        except HTTPError as exc:
            try:
                with exc:
                    error = json.loads(exc.read(), parse_float=Decimal)
            except (ValueError, UnicodeError):
                error = None
            message = error.get("error", str(exc.reason)) if isinstance(error, dict) else str(exc.reason)
            raise APIError(exc.code, message, error) from exc
        except (URLError, OSError, HTTPException) as exc:
            raise TransportError(f"Request failed; mutation outcome may be unknown: {exc}") from exc
        try:
            return json.loads(payload, parse_float=Decimal)
        except (ValueError, UnicodeError) as exc:
            raise ProtocolError("Expected a JSON response; check the server URL and proxy configuration") from exc

    def config(self) -> JSON:
        return self._request("GET", "/config")

    def register(self, username: str, password: str, *, display_name: str | None = None, invite_code: str | None = None) -> JSON:
        body = {"username": username, "password": password, "displayName": display_name or username}
        if invite_code is not None:
            body["inviteCode"] = invite_code
        return self._request("POST", "/auth/register", body)["user"]

    def login(self, username: str, password: str) -> JSON:
        return self._request("POST", "/auth/login", {"username": username, "password": password})["user"]

    def logout(self) -> None:
        self._request("POST", "/auth/logout")
        self._cookies.clear()

    def me(self) -> JSON | None:
        return self._request("GET", "/auth/me")["user"]

    def markets(self, *, mode: Literal["pool", "polymarket"] | None = "polymarket", filter: str = "active", sort: str = "new", limit: int = 100, search: str | None = None) -> list[JSON]:
        return self._request("GET", "/markets", query={"mode": mode, "filter": filter, "sort": sort, "limit": _integer(limit, "limit", 200), "q": search})

    def market(self, market_id: int) -> JSON:
        return self._request("GET", f"/markets/{_integer(market_id, 'market_id')}")

    def create_market(self, question: str, close_at: int | datetime, *, settle_at: int | datetime | None = None, category: str = "其他", description: str = "", mode: Literal["pool", "polymarket"] = "polymarket", outcomes: list[str] | None = None) -> JSON:
        """Polymarket markets take ["Yes", "No"] (the default) or 3+ options, each with its own Yes/No book."""
        close_ms = _timestamp(close_at, "close_at")
        settle_ms = close_ms if settle_at is None else _timestamp(settle_at, "settle_at")
        if settle_ms < close_ms:
            raise ValueError("settle_at must be at or after close_at")
        return self._request("POST", "/markets", {"question": question, "closeAt": close_ms, "settleAt": settle_ms, "category": category,
            "description": description, "mode": mode, "outcomes": outcomes if outcomes is not None else ["Yes", "No"]})

    def book(self, market_id: int) -> JSON:
        return self._request("GET", f"/trading/markets/{_integer(market_id, 'market_id')}/book")

    def account(self) -> JSON:
        return self._request("GET", "/trading/account")

    def positions(self) -> list[JSON]:
        return self._request("GET", "/trading/positions")

    @staticmethod
    def _page(limit: int, before: int | None, market_id: int | None = None) -> JSON:
        return {"limit": _integer(limit, "limit", 200), "before": None if before is None else _integer(before, "before"),
            "marketId": None if market_id is None else _integer(market_id, "market_id")}

    def orders(self, *, market_id: int | None = None, status: Literal["open", "filled", "cancelled"] | None = None, client_order_id: str | None = None, limit: int = 50, before: int | None = None) -> JSON:
        return self._request("GET", "/trading/orders", query={**self._page(limit, before, market_id), "status": status, "clientOrderId": client_order_id})

    def order(self, order_id: int) -> JSON:
        return self._request("GET", f"/trading/orders/{_integer(order_id, 'order_id')}")

    def order_by_client_id(self, client_order_id: str) -> JSON | None:
        if not isinstance(client_order_id, str) or not re.fullmatch(r"[A-Za-z0-9._:-]{1,64}", client_order_id):
            raise ValueError("invalid client_order_id")
        items = self.orders(client_order_id=client_order_id, limit=1)["items"]
        return items[0] if items else None

    def place_order(self, market_id: int, outcome_id: int, side: Side, price: Decimal | str | float, quantity: int, *, token: Token = "yes", order_type: Literal["GTC", "GTD"] = "GTC", expires_at: int | datetime | None = None, client_order_id: str | None = None, post_only: bool = False) -> JSON:
        """A resting limit order. GTD orders need `expires_at`; the unfilled rest is cancelled then."""
        if not isinstance(post_only, bool):
            raise ValueError("post_only must be a bool")
        if order_type not in ("GTC", "GTD"):
            raise ValueError("order_type must be GTC or GTD; use market_order for FOK/FAK")
        if (order_type == "GTD") != (expires_at is not None):
            raise ValueError("expires_at is required for GTD orders and only allowed for them")
        body = {"price": _price(price), "quantity": _integer(quantity, "quantity", 1_000_000), "postOnly": post_only, "type": order_type}
        if expires_at is not None:
            body["expiresAt"] = _timestamp(expires_at, "expires_at")
        return self._submit(market_id, outcome_id, side, token, body, client_order_id)

    def market_order(self, market_id: int, outcome_id: int, side: Side, *, amount: Decimal | str | float | None = None, quantity: int | None = None, worst_price: Decimal | str | float | None = None, token: Token = "yes", order_type: Literal["FOK", "FAK"] = "FAK", client_order_id: str | None = None) -> JSON:
        """Execute at once against the book, never resting. Buys spend `amount` (in whole shares) or take
        `quantity`; sells take `quantity`. FOK fills completely or not at all, FAK cancels the unfilled rest.
        `worst_price` bounds the prices touched (defaults: 0.99 for buys, 0.01 for sells)."""
        if order_type not in ("FOK", "FAK"):
            raise ValueError("order_type must be FOK or FAK")
        if (amount is None) == (quantity is None):
            raise ValueError("pass exactly one of amount and quantity")
        if amount is not None and side != "buy":
            raise ValueError("amount is only for buys; sell a quantity")
        body: JSON = {"type": order_type}
        if amount is not None:
            body["amount"] = _amount(amount)
        if quantity is not None:
            body["quantity"] = _integer(quantity, "quantity", 1_000_000)
        if worst_price is not None:
            body["price"] = _price(worst_price)
        return self._submit(market_id, outcome_id, side, token, body, client_order_id)

    def _submit(self, market_id: int, outcome_id: int, side: Side, token: Token, fields: JSON, client_order_id: str | None) -> JSON:
        key = _client_order_id(client_order_id)
        if side not in ("buy", "sell"):
            raise ValueError("side must be buy or sell")
        if token not in ("yes", "no"):
            raise ValueError("token must be yes or no")
        body = {"marketId": _integer(market_id, "market_id"), "outcomeId": _integer(outcome_id, "outcome_id"), "side": side,
            "token": token, "clientOrderId": key, **fields}
        try:
            return self._request("POST", "/trading/orders", body)
        except (TransportError, ProtocolError) as exc:
            exc.client_order_id = key
            raise

    def cancel_order(self, order_id: int) -> JSON:
        return self._request("POST", f"/trading/orders/{_integer(order_id, 'order_id')}/cancel")

    def trades(self, *, market_id: int | None = None, limit: int = 50, before: int | None = None) -> JSON:
        """Own fills, with the price expressed in the outcome owned by this client."""
        return self._request("GET", "/trading/trades", query=self._page(limit, before, market_id))

    def market_trades(self, market_id: int, *, limit: int = 50, before: int | None = None) -> JSON:
        return self._request("GET", f"/trading/markets/{_integer(market_id, 'market_id')}/trades", query=self._page(limit, before))

    def _pairs(self, action: str, market_id: int, quantity: int, outcome_id: int | None) -> JSON:
        body: JSON = {"quantity": _integer(quantity, "quantity", 1_000_000)}
        if outcome_id is not None:
            body["outcomeId"] = _integer(outcome_id, "outcome_id")
        return self._request("POST", f"/trading/markets/{_integer(market_id, 'market_id')}/{action}", body)

    def split(self, market_id: int, quantity: int, *, outcome_id: int | None = None) -> JSON:
        """1 → 1 Yes + 1 No. Multi-outcome markets name the option (`outcome_id`)."""
        return self._pairs("split", market_id, quantity, outcome_id)

    def merge(self, market_id: int, quantity: int, *, outcome_id: int | None = None) -> JSON:
        return self._pairs("merge", market_id, quantity, outcome_id)

    def convert(self, market_id: int, outcome_ids: list[int], quantity: int) -> JSON:
        """Multi-outcome markets: No shares of k options → (k − 1) cash + one Yes of every other option, per unit."""
        if not isinstance(outcome_ids, list) or not outcome_ids:
            raise ValueError("outcome_ids must be a non-empty list")
        body = {"outcomeIds": [_integer(i, "outcome_id") for i in outcome_ids], "quantity": _integer(quantity, "quantity", 1_000_000)}
        return self._request("POST", f"/trading/markets/{_integer(market_id, 'market_id')}/convert", body)

    def holders(self, market_id: int) -> list[JSON]:
        """Biggest holders of each share, with their average price."""
        return self._request("GET", f"/markets/{_integer(market_id, 'market_id')}/exchange/holders")

    def activity(self, market_id: int, *, before: int | None = None) -> list[JSON]:
        """Both sides of the market's trades, newest first; page with the last `tradeId` as `before`."""
        return self._request("GET", f"/markets/{_integer(market_id, 'market_id')}/exchange/activity",
            query={"before": None if before is None else _integer(before, "before")})

    def resolve_market(self, market_id: int, outcome_id: int, *, note: str = "") -> JSON:
        return self._request("POST", f"/markets/{_integer(market_id, 'market_id')}/resolve", {"outcomeId": _integer(outcome_id, "outcome_id"), "note": note})

    def cancel_market(self, market_id: int, *, note: str = "") -> JSON:
        return self._request("POST", f"/markets/{_integer(market_id, 'market_id')}/cancel", {"note": note})
