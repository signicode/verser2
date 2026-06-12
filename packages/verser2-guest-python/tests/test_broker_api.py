import asyncio
import importlib
import inspect
import unittest
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch


def _build_broker_response(**kwargs):
    package = importlib.import_module("verser2_guest_python")
    response_type = getattr(package, "VerserBrokerResponse", None)
    if response_type is None:
        raise AssertionError("VerserBrokerResponse should be exported from verser2_guest_python")

    body = kwargs.get("body", b"")
    status = kwargs.get("status", 200)
    headers = kwargs.get("headers", {})
    request_id = kwargs.get("request_id", "req-broker-1")

    try:
        return response_type(status=status, headers=headers, request_id=request_id, body=body)
    except TypeError as error:
        raise AssertionError(
            "VerserBrokerResponse should accept status, headers, request_id, and body"
        ) from error


class BrokerPublicApiTest(unittest.TestCase):
    def _broker_factory(self):
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker", None)
        self.assertIsNotNone(
            create_verser_broker,
            "create_verser_broker is not exported from verser2_guest_python",
        )
        assert create_verser_broker is not None
        return create_verser_broker(
            host_url="https://127.0.0.1:1",
            broker_id="python-unit-broker",
        )

    def test_package_exports_create_verser_broker(self) -> None:
        package = importlib.import_module("verser2_guest_python")

        self.assertTrue(
            hasattr(package, "create_verser_broker"),
            "create_verser_broker should be exported from package",
        )

    def test_create_verser_broker_returns_async_context_manager(self) -> None:
        broker = self._broker_factory()

        self.assertTrue(
            inspect.iscoroutinefunction(broker.__aenter__),
            "create_verser_broker result should implement async __aenter__",
        )
        self.assertTrue(
            inspect.iscoroutinefunction(broker.__aexit__),
            "create_verser_broker result should implement async __aexit__",
        )

        original_connect = broker.connect
        original_close = broker.close
        mock_connect = AsyncMock(return_value=None)
        mock_close = AsyncMock(return_value=None)
        broker.connect = mock_connect
        broker.close = mock_close

        async def run() -> None:
            async with broker:
                pass

        try:
            asyncio.run(run())
        finally:
            broker.connect = original_connect
            broker.close = original_close

        self.assertEqual(mock_connect.await_count, 1)
        self.assertEqual(mock_close.await_count, 1)

    def test_create_verser_broker_exposes_lifecycle_methods(self) -> None:
        broker = self._broker_factory()

        self.assertTrue(callable(getattr(broker, "connect", None)))
        self.assertTrue(callable(getattr(broker, "close", None)))
        self.assertTrue(
            inspect.iscoroutinefunction(getattr(broker, "connect", None)),
            "connect should be an async method",
        )
        self.assertTrue(
            inspect.iscoroutinefunction(getattr(broker, "close", None)),
            "close should be an async method",
        )

    def test_create_verser_broker_exposes_request_helpers(self) -> None:
        broker = self._broker_factory()

        for helper in ("request", "get", "post", "put", "patch", "delete"):
            self.assertTrue(
                callable(getattr(broker, helper, None)),
                f"{helper} helper should exist on broker",
            )


class VerserBrokerResponseTest(unittest.TestCase):
    def _response(self, body: bytes = b"", request_id: str = "req-1") -> Any:
        return _build_broker_response(
            status=200,
            headers={"content-type": "application/json", "x-request-id": request_id},
            request_id=request_id,
            body=body,
        )

    def _assert_actionable_exception(self, exc: Exception) -> None:
        message = str(exc).lower()
        self.assertTrue(message, "exception should include an actionable message")
        self.assertTrue(
            any(keyword in message for keyword in ("consume", "consumed", "stream", "already")),
            f"exception should explain body-consumption state: {exc}",
        )

    def _run(self, coroutine):
        return asyncio.run(coroutine)

    def test_response_exposes_core_properties_and_helpers(self) -> None:
        response = self._response(body=b"{}")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.request_id, "req-1")
        self.assertIsInstance(response.headers, dict)
        self.assertEqual(response.headers["content-type"], "application/json")

        self.assertTrue(callable(getattr(response, "read", None)))
        self.assertTrue(callable(getattr(response, "text", None)))
        self.assertTrue(callable(getattr(response, "json", None)))
        self.assertTrue(callable(getattr(response, "aiter_bytes", None)))

        self.assertTrue(inspect.iscoroutinefunction(response.read))
        self.assertTrue(inspect.iscoroutinefunction(response.text))
        self.assertTrue(inspect.iscoroutinefunction(response.json))
        self.assertTrue(
            inspect.iscoroutinefunction(response.aiter_bytes)
            or inspect.isasyncgenfunction(response.aiter_bytes)
        )

        self.assertEqual(self._run(self._response(body=b"raw-bytes").read()), b"raw-bytes")
        self.assertEqual(self._run(self._response(body=b"hello text").text()), "hello text")
        self.assertEqual(
            self._run(self._response(body=b'{"ok": true}').json()),
            {"ok": True},
        )

    def test_full_body_helpers_are_single_use(self) -> None:
        response = self._response(body=b"hello")

        body = self._run(response.read())
        self.assertEqual(body, b"hello")

        for helper in (response.read, response.text, response.json):
            with self.assertRaises(Exception) as context:
                self._run(helper())
            self._assert_actionable_exception(context.exception)

    def test_full_body_then_stream_raises(self) -> None:
        response = self._response(body=b"streamed-body")

        text = self._run(response.text())
        self.assertEqual(text, "streamed-body")

        with self.assertRaises(Exception) as context:
            async def consume() -> None:
                async for _chunk in response.aiter_bytes():
                    pass

            self._run(consume())
        self._assert_actionable_exception(context.exception)

    def test_stream_then_full_body_raises(self) -> None:
        response = self._response(body=b'{"a":1}')

        async def collect_chunks():
            chunks = []
            async for chunk in response.aiter_bytes():
                chunks.append(chunk)
            return b"".join(chunks)

        streamed = self._run(collect_chunks())
        self.assertEqual(streamed, b"{\"a\":1}")

        for helper in (response.read, response.text, response.json):
            with self.assertRaises(Exception) as context:
                self._run(helper())
            self._assert_actionable_exception(context.exception)


class VerserBrokerApiRouteControlTest(unittest.TestCase):
    def _broker_factory(self):
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker", None)
        self.assertIsNotNone(
            create_verser_broker,
            "create_verser_broker should be exported from verser2_guest_python",
        )
        assert create_verser_broker is not None
        return create_verser_broker(
            host_url="https://127.0.0.1",
            broker_id="python-unit-broker",
        )

    def _run(self, coroutine):
        return asyncio.run(coroutine)

    def _set_default_registration_patch(self, broker: Any) -> Any:
        for name in ("_register", "register"):
            method = getattr(type(broker), name, None)
            if method is not None:
                if inspect.iscoroutinefunction(method):
                    return patch.object(type(broker), name, new=AsyncMock(return_value=None))
                return patch.object(type(broker), name, new=MagicMock(return_value=None))
        self.fail("Broker should expose _register to allow unit-level connect testing")

    def _set_default_optional_patch(self, broker: Any, method_name: str):
        method = getattr(type(broker), method_name, None)
        if method is None:
            return None
        if inspect.iscoroutinefunction(method):
            return patch.object(type(broker), method_name, new=AsyncMock(return_value=None))
        return patch.object(type(broker), method_name, new=MagicMock(return_value=None))

    def _registration_payload(self, broker: Any) -> dict[str, Any]:
        for method_name in ("_registration_payload", "_build_registration_payload", "registration_payload"):
            method = getattr(type(broker), method_name, None)
            if method is None:
                continue
            if inspect.iscoroutinefunction(method):
                return self._run(method(broker))
            return method(broker)
        self.fail("Broker should expose a _registration_payload helper for request generation")

    def _handle_control_frame(self, broker: Any, frame: dict[str, Any]) -> None:
        for method_name in ("_handle_control_frame", "handle_control_frame", "_handleFrame", "handleFrame"):
            method = getattr(type(broker), method_name, None)
            if method is None:
                continue
            result = method(broker, frame)
            if inspect.isawaitable(result):
                self._run(result)
            return
        self.fail("Broker should expose a control-frame handler for routes updates")

    def _registration_response_validator(self, broker: Any):
        for method_name in (
            "_parse_registration_response",
            "parse_registration_response",
            "_handle_registration_response",
            "_validate_registration_response",
            "handle_registration_response",
        ):
            method = getattr(type(broker), method_name, None)
            if method is not None:
                return method_name, method
        return None

    def test_connect_uses_tls_http2_with_h2_alpn(self) -> None:
        broker = self._broker_factory()

        captured: dict[str, Any] = {}

        async def fake_open_connection(*args, **kwargs):
            captured["args"] = args
            captured["kwargs"] = kwargs
            reader = AsyncMock()
            reader.read = AsyncMock(return_value=b"")
            writer = AsyncMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            return reader, writer

        registration_patch = self._set_default_registration_patch(broker)
        control_patch = self._set_default_optional_patch(broker, "_open_control_stream")
        lease_patch = self._set_default_optional_patch(broker, "_start_lease_task")

        ssl_context = MagicMock()
        with patch("asyncio.open_connection", side_effect=fake_open_connection), patch(
            "ssl.create_default_context", return_value=ssl_context
        ), registration_patch:
            if control_patch is not None:
                with control_patch:
                    if lease_patch is not None:
                        with lease_patch:
                            self._run(broker.connect())
                    else:
                        self._run(broker.connect())
            elif lease_patch is not None:
                with lease_patch:
                    self._run(broker.connect())
            else:
                self._run(broker.connect())

        self.assertEqual(captured["args"][0], "127.0.0.1")
        self.assertEqual(captured["args"][1], 443)
        context = captured["kwargs"].get("ssl")
        self.assertIs(context, ssl_context)
        ssl_context.set_alpn_protocols.assert_called_once_with(["h2"])
        self.assertEqual(captured["kwargs"].get("server_hostname"), "127.0.0.1")

    def test_broker_registration_payload_uses_role_and_peer_id(self) -> None:
        broker = self._broker_factory()
        payload = self._registration_payload(broker)

        self.assertEqual(payload.get("peerId"), "python-unit-broker")
        self.assertEqual(payload.get("role"), "broker")

    def test_invalid_registration_response_is_actionable(self) -> None:
        broker = self._broker_factory()
        locator = self._registration_response_validator(broker)
        self.assertIsNotNone(locator, "Broker should expose registration response validator")
        assert locator is not None
        method_name, method = locator
        _ = method_name
        self.assertIsNotNone(method)
        assert method is not None

        payload = "{\"status\": \"denied\"}"
        if inspect.iscoroutinefunction(method):
            result = method(broker, payload)
            with self.assertRaises(Exception) as context:
                self._run(result)
        else:
            with self.assertRaises(Exception) as context:
                method(broker, payload)

        message = str(context.exception).lower()
        self.assertIn("registration", message)
        self.assertIn("python-unit-broker", message)

    def test_host_route_advertisement_populates_get_routes(self) -> None:
        broker = self._broker_factory()
        get_routes = getattr(type(broker), "get_routes", None)
        self.assertTrue(callable(get_routes), "Broker should expose get_routes()")
        assert get_routes is not None

        self._handle_control_frame(
            broker,
            {
                "type": "routes",
                "routes": [
                    {"targetId": "guest-a", "domain": "alpha.local"},
                    {"targetId": "guest-b", "domain": "beta.local"},
                ],
            },
        )

        routes = get_routes(broker)
        self.assertEqual(
            routes,
            [
                {"targetId": "guest-a", "domain": "alpha.local"},
                {"targetId": "guest-b", "domain": "beta.local"},
            ],
        )

    def test_host_route_retraction_updates_get_routes(self) -> None:
        broker = self._broker_factory()
        get_routes = getattr(type(broker), "get_routes", None)
        self.assertTrue(callable(get_routes), "Broker should expose get_routes()")
        assert get_routes is not None

        self._handle_control_frame(
            broker,
            {
                "type": "routes",
                "routes": [
                    {"targetId": "guest-a", "domain": "alpha.local"},
                    {"targetId": "guest-b", "domain": "beta.local"},
                ],
            },
        )
        self._handle_control_frame(
            broker,
            {
                "type": "routes",
                "routes": [{"targetId": "guest-a", "domain": "alpha.local"}],
            },
        )

        routes = get_routes(broker)
        self.assertEqual(routes, [{"targetId": "guest-a", "domain": "alpha.local"}])

    def test_wait_for_route_resolves_immediately_for_known_routes(self) -> None:
        broker = self._broker_factory()
        wait_for_route = getattr(type(broker), "wait_for_route", None)
        self.assertTrue(
            callable(wait_for_route),
            "Broker should expose wait_for_route(domain) to await route advertisements",
        )
        assert wait_for_route is not None

        self._handle_control_frame(
            broker,
            {
                "type": "routes",
                "routes": [{"targetId": "guest-1", "domain": "already.local"}],
            },
        )

        # Should resolve without any async waiting if route is already present.
        self._run(wait_for_route(broker, "already.local"))

    def test_wait_for_route_resolves_for_future_advertisements(self) -> None:
        broker = self._broker_factory()
        wait_for_route = getattr(type(broker), "wait_for_route", None)
        self.assertTrue(
            callable(wait_for_route),
            "Broker should expose wait_for_route(domain) to await route advertisements",
        )
        assert wait_for_route is not None

        async def run() -> None:
            waiter = asyncio.create_task(wait_for_route(broker, "future.local"))
            await asyncio.sleep(0)
            self.assertFalse(waiter.done())
            self._handle_control_frame(
                broker,
                {
                    "type": "routes",
                    "routes": [{"targetId": "guest-f", "domain": "future.local"}],
                },
            )
            await asyncio.wait_for(waiter, timeout=1)

        self._run(run())


if __name__ == "__main__":
    unittest.main()
