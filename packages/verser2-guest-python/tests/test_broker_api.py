import asyncio
import builtins
import importlib
import inspect
import json
import ssl
import unittest
from io import BytesIO
from typing import Any
from unittest.mock import AsyncMock, MagicMock, patch

import h2.events


def _build_broker_response(**kwargs):
    package = importlib.import_module("verser2_guest_python")
    response_type = getattr(package, "VerserBrokerResponse", None)
    if response_type is None:
        raise AssertionError(
            "VerserBrokerResponse should be exported from verser2_guest_python"
        )

    body = kwargs.get("body", b"")
    status = kwargs.get("status", 200)
    headers = kwargs.get("headers", {})
    request_id = kwargs.get("request_id", "req-broker-1")

    try:
        return response_type(
            status=status, headers=headers, request_id=request_id, body=body
        )
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
            any(
                keyword in message
                for keyword in ("consume", "consumed", "stream", "already")
            ),
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

        self.assertEqual(
            self._run(self._response(body=b"raw-bytes").read()), b"raw-bytes"
        )
        self.assertEqual(
            self._run(self._response(body=b"hello text").text()), "hello text"
        )
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
        self.assertEqual(streamed, b'{"a":1}')

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
                    return patch.object(
                        type(broker), name, new=AsyncMock(return_value=None)
                    )
                return patch.object(
                    type(broker), name, new=MagicMock(return_value=None)
                )
        self.fail("Broker should expose _register to allow unit-level connect testing")

    def _set_default_optional_patch(self, broker: Any, method_name: str):
        method = getattr(type(broker), method_name, None)
        if method is None:
            return None
        if inspect.iscoroutinefunction(method):
            return patch.object(
                type(broker), method_name, new=AsyncMock(return_value=None)
            )
        return patch.object(type(broker), method_name, new=MagicMock(return_value=None))

    def _registration_payload(self, broker: Any) -> dict[str, Any]:
        for method_name in (
            "_registration_payload",
            "_build_registration_payload",
            "registration_payload",
        ):
            method = getattr(type(broker), method_name, None)
            if method is None:
                continue
            if inspect.iscoroutinefunction(method):
                return self._run(method(broker))
            return method(broker)
        self.fail(
            "Broker should expose a _registration_payload helper for request generation"
        )

    def _handle_control_frame(self, broker: Any, frame: dict[str, Any]) -> None:
        for method_name in (
            "_handle_control_frame",
            "handle_control_frame",
            "_handleFrame",
            "handleFrame",
        ):
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
            writer = MagicMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            ssl_obj = MagicMock()
            ssl_obj.selected_alpn_protocol.return_value = "h2"
            writer.get_extra_info.return_value = ssl_obj
            return reader, writer

        registration_patch = self._set_default_registration_patch(broker)
        control_patch = self._set_default_optional_patch(broker, "_open_control_stream")
        lease_patch = self._set_default_optional_patch(broker, "_start_lease_task")

        ssl_context = MagicMock()
        with (
            patch("asyncio.open_connection", side_effect=fake_open_connection),
            patch("ssl.create_default_context", return_value=ssl_context),
            registration_patch,
        ):
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
        self.assertIsNotNone(
            locator, "Broker should expose registration response validator"
        )
        assert locator is not None
        method_name, method = locator
        _ = method_name
        self.assertIsNotNone(method)
        assert method is not None

        payload = '{"status": "denied"}'
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

    def test_malformed_registration_response_is_actionable(self) -> None:
        broker = self._broker_factory()
        method = getattr(type(broker), "_coerce_registration_response", None)
        self.assertIsNotNone(method, "Broker should expose registration parser")
        assert method is not None

        with self.assertRaises(Exception) as context:
            if inspect.iscoroutinefunction(method):
                self._run(method(broker, b"not-json"))
            else:
                method(broker, b"not-json")

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

    def test_registration_payload_includes_peer_id_and_role_with_tls_options(
        self,
    ) -> None:
        """Registration payload still carries ``peerId`` and ``role`` even when
        TLS client identity options are supplied."""
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker")
        broker = create_verser_broker(
            host_url="https://127.0.0.1",
            broker_id="python-unit-broker",
            tls_ca_file="/ca.pem",
            tls_cert_file="/client.pem",
            tls_key_file="/client-key.pem",
            tls_key_password="secret",
        )
        payload = self._registration_payload(broker)
        self.assertEqual(payload.get("peerId"), "python-unit-broker")
        self.assertEqual(payload.get("role"), "broker")

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


class VerserBrokerRequestAndStreamingTest(unittest.TestCase):
    def _broker_factory(self):
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker", None)
        self.assertIsNotNone(
            create_verser_broker,
            "create_verser_broker is not exported from verser2_guest_python",
        )
        assert create_verser_broker is not None
        return create_verser_broker(
            host_url="https://127.0.0.1",
            broker_id="python-unit-broker",
        )

    def _run(self, coroutine):
        return asyncio.run(coroutine)

    def _assert_verser_request_metadata(
        self, payload: dict[str, Any], *, target_id: str, path: str
    ) -> None:
        self.assertEqual(payload.get("targetId"), target_id)
        self.assertEqual(payload.get("sourceId"), "python-unit-broker")
        self.assertEqual(payload.get("method"), "GET")
        self.assertEqual(payload.get("path"), path)
        self.assertIn("requestId", payload)
        self.assertIsInstance(payload.get("requestId"), str)

    def test_routed_get_sends_request_payload_to_target(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        headers_calls: list[dict[str, Any]] = []
        data_calls: list[tuple[int, bytes, bool]] = []

        async def fake_send_headers(
            _headers: list[tuple[str, str]],
            *,
            end_stream: bool,
            create_queue: bool = True,
        ) -> int:
            headers_calls.append(
                {
                    "headers": [tuple(item) for item in _headers],
                    "end_stream": end_stream,
                    "create_queue": create_queue,
                },
            )
            return 17

        async def fake_send_data(stream_id: int, data: bytes, end_stream: bool) -> None:
            data_calls.append((stream_id, data, end_stream))

        async def fake_collect_response(stream_id: int, request_id: str) -> Any:
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            return response_type(
                status=200,
                headers={"content-type": "text/plain"},
                request_id=request_id,
                body=b"ok",
            )

        with (
            patch.object(
                type(broker),
                "_send_headers",
                new=AsyncMock(side_effect=fake_send_headers),
            ),
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(side_effect=fake_send_data),
            ),
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(side_effect=fake_collect_response),
            ),
        ):
            response = self._run(
                broker.get(
                    "http://external.local:8443/health?x=1",
                    headers={"x-test": "yes", "HoSt": "public.example:9443"},
                    route_domain="alpha.local",
                )
            )
            self._run(
                broker.get("http://[2001:db8::1]:8443/ipv6", route_domain="alpha.local")
            )

        self.assertIsNotNone(response)
        self.assertEqual(len(headers_calls), 2)

        request_headers = dict(headers_calls[0]["headers"])
        self.assertEqual(request_headers.get(":method"), "POST")
        self.assertEqual(request_headers.get(":path"), "/verser/request")

        stream_id, body, end_stream = data_calls[0]
        self.assertEqual(stream_id, 17)
        self.assertTrue(end_stream)
        self.assertEqual(body, b"")

        self.assertEqual(request_headers.get("x-verser-target-id"), "guest-a")
        self.assertEqual(request_headers.get("x-verser-route-domain"), "alpha.local")
        self.assertEqual(
            request_headers.get("x-verser-source-id"), "python-unit-broker"
        )
        self.assertEqual(request_headers.get("x-verser-method"), "GET")
        self.assertEqual(request_headers.get("x-verser-path"), "/health?x=1")
        self.assertIn("x-verser-request-id", request_headers)

        request_headers_meta = request_headers.get("x-verser-headers")
        self.assertIsInstance(request_headers_meta, str)
        self.assertIsNotNone(request_headers_meta)
        if request_headers_meta is None:
            self.fail("expected x-verser-headers value for JSON request headers")
        self.assertIn("x-test", request_headers_meta)
        self.assertEqual(
            json.loads(request_headers_meta).get("HoSt"), "public.example:9443"
        )
        ipv6_headers = dict(headers_calls[1]["headers"])
        self.assertEqual(
            json.loads(ipv6_headers["x-verser-headers"])["host"],
            "[2001:db8::1]:8443",
        )

    def test_missing_advertised_route_raises_actionable_exception(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        with self.assertRaises(Exception) as context:
            self._run(broker.get("http://unknown.local/health"))

        message = str(context.exception).lower()
        self.assertIn("route", message)
        self.assertIn("unknown.local", message)

    def test_binary_request_body_chunks_are_not_utf8_coerced(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        chunked = [b"\xff", b"\x00", b"hello"]

        data_calls: list[tuple[int, bytes, bool]] = []

        async def fake_collect_response(_stream_id: int, request_id: str) -> Any:
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            return response_type(
                status=200, headers={}, request_id=request_id, body=b""
            )

        with (
            patch.object(
                type(broker),
                "_send_headers",
                new=AsyncMock(side_effect=lambda *args, **kwargs: 17),
            ),
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(
                    side_effect=lambda stream_id, chunk, end_stream: data_calls.append(
                        (stream_id, chunk, end_stream)
                    )
                ),
            ),
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(side_effect=fake_collect_response),
            ),
        ):
            self._run(
                broker.post(
                    "http://alpha.local/upload",
                    body=chunked,
                    headers={"content-type": "application/octet-stream"},
                )
            )

        self.assertEqual(data_calls[0][1], b"\xff")
        self.assertEqual(data_calls[1][1], b"\x00")
        self.assertEqual(data_calls[2][1], b"hello")

    def test_request_text_and_json_convenience_set_content_type(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        text_headers: list[dict[str, Any]] = []
        text_data: list[tuple[int, bytes, bool]] = []

        async def fake_collect_response(_stream_id: int, request_id: str) -> Any:
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            return response_type(
                status=200, headers={}, request_id=request_id, body=b""
            )

        with (
            patch.object(
                type(broker),
                "_send_headers",
                new=AsyncMock(return_value=17),
            ) as send_headers_mock,
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(
                    side_effect=lambda stream_id, data, end_stream: text_data.append(
                        (stream_id, data, end_stream)
                    )
                ),
            ) as send_data_mock,
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(side_effect=fake_collect_response),
            ),
        ):
            self._run(broker.post("http://alpha.local/text", body="hello"))
            self._run(broker.post("http://alpha.local/json", json={"ok": True}))

            self.assertEqual(len(send_headers_mock.call_args_list), 2)
            for call in send_headers_mock.call_args_list:
                headers = dict(call.args[0])
                text_headers.append(headers)

        self.assertGreaterEqual(len(text_data), 2)
        self.assertEqual(text_data[0][1], b"hello")
        self.assertEqual(text_data[1][1], json.dumps({"ok": True}).encode("utf-8"))
        self.assertIn(
            "content-type",
            text_headers[0],
            "text convenience requests should include a content-type hint when useful",
        )
        self.assertIn(
            "content-type",
            text_headers[1],
            "json convenience requests should include a content-type hint",
        )

    def test_streaming_request_body_forwards_chunks(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        async def request_body() -> Any:
            yield b"one"
            yield b""
            yield b"two"

        stream_calls: list[tuple[bytes, bool]] = []

        async def fake_collect_response(_stream_id: int, request_id: str) -> Any:
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            return response_type(
                status=200, headers={}, request_id=request_id, body=b""
            )

        with (
            patch.object(
                type(broker),
                "_send_headers",
                new=AsyncMock(return_value=17),
            ),
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(
                    side_effect=lambda _stream_id, chunk, end_stream: (
                        stream_calls.append((chunk, end_stream))
                    )
                ),
            ),
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(side_effect=fake_collect_response),
            ),
        ):
            self._run(broker.post("http://alpha.local/stream", body=request_body()))

        self.assertEqual(stream_calls[0], (b"one", False))
        self.assertEqual(stream_calls[1], (b"", False))
        self.assertEqual(stream_calls[2], (b"two", True))

    def test_empty_async_streaming_request_body_ends_stream(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        async def request_body() -> Any:
            if False:
                yield b"unreachable"

        stream_calls: list[tuple[bytes, bool]] = []

        async def fake_collect_response(_stream_id: int, request_id: str) -> Any:
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            return response_type(
                status=200, headers={}, request_id=request_id, body=b""
            )

        with (
            patch.object(type(broker), "_send_headers", new=AsyncMock(return_value=17)),
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(
                    side_effect=lambda _stream_id, chunk, end_stream: (
                        stream_calls.append((chunk, end_stream))
                    )
                ),
            ),
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(side_effect=fake_collect_response),
            ),
        ):
            self._run(broker.post("http://alpha.local/empty", body=request_body()))

        self.assertEqual(stream_calls, [(b"", True)])

    def test_collect_response_streams_body_and_acknowledges_flow_control(self) -> None:
        broker = self._broker_factory()
        broker._events[17] = asyncio.Queue()
        broker._events[17].put_nowait(
            h2.events.ResponseReceived(
                stream_id=17,
                headers=[(":status", "200"), ("x-stream", "yes")],
            )
        )
        broker._events[17].put_nowait(
            h2.events.DataReceived(stream_id=17, data=b"one", flow_controlled_length=3)
        )
        broker._events[17].put_nowait(
            h2.events.DataReceived(stream_id=17, data=b"two", flow_controlled_length=5)
        )
        broker._events[17].put_nowait(h2.events.StreamEnded(stream_id=17))
        acknowledged: list[tuple[int, int]] = []

        async def fake_ack(stream_id: int, length: int) -> None:
            acknowledged.append((stream_id, length))

        with patch.object(
            type(broker),
            "_acknowledge_received_data",
            new=AsyncMock(side_effect=fake_ack),
        ):
            response = self._run(broker._collect_response(17, "req-stream"))

            async def collect() -> bytes:
                chunks = []
                async for chunk in response.aiter_bytes():
                    chunks.append(chunk)
                return b"".join(chunks)

            self.assertEqual(self._run(collect()), b"onetwo")

        self.assertEqual(response.status, 200)
        self.assertEqual(response.headers, {"x-stream": "yes"})
        self.assertEqual(acknowledged, [(17, 3), (17, 5)])

    def test_response_stream_reset_raises_actionable_error(self) -> None:
        broker = self._broker_factory()
        broker._events[17] = asyncio.Queue()
        broker._events[17].put_nowait(
            h2.events.ResponseReceived(stream_id=17, headers=[(":status", "200")])
        )
        broker._events[17].put_nowait(h2.events.StreamReset(stream_id=17, error_code=0))

        response = self._run(broker._collect_response(17, "req-reset"))

        async def collect() -> None:
            async for _chunk in response.aiter_bytes():
                pass

        with self.assertRaises(Exception) as context:
            self._run(collect())
        self.assertIn("reset", str(context.exception).lower())

    def test_send_data_splits_large_chunks_by_h2_frame_size(self) -> None:
        broker = self._broker_factory()
        sent: list[tuple[int, bytes, bool]] = []

        class FakeConn:
            max_outbound_frame_size = 4

            def send_data(
                self, stream_id: int, data: bytes, end_stream: bool = False
            ) -> None:
                sent.append((stream_id, data, end_stream))

            def local_flow_control_window(self, _stream_id: int) -> int:
                return 65535

            def data_to_send(self) -> bytes:
                return b""

        broker._conn = FakeConn()

        self._run(broker._send_data(3, b"abcdefghi", True))

        self.assertEqual(
            sent, [(3, b"abcd", False), (3, b"efgh", False), (3, b"i", True)]
        )

    def test_read_loop_fails_pending_streams_on_connection_close(self) -> None:
        broker = self._broker_factory()
        broker._events[17] = asyncio.Queue()

        class FakeReader:
            async def read(self, _size: int) -> bytes:
                return b""

        broker._reader = FakeReader()

        self._run(broker._read_loop())

        event = broker._events[17].get_nowait()
        self.assertIsInstance(event, RuntimeError)
        self.assertIn("closed", str(event).lower())

    def test_binary_request_and_response_chunks_are_preserved(self) -> None:
        broker = self._broker_factory()
        broker._routes = [{"targetId": "guest-a", "domain": "alpha.local"}]

        with (
            patch.object(
                type(broker),
                "_send_headers",
                new=AsyncMock(return_value=17),
            ),
            patch.object(
                type(broker),
                "_send_data",
                new=AsyncMock(side_effect=lambda *args, **kwargs: None),
            ),
            patch.object(
                type(broker),
                "_collect_response",
                new=AsyncMock(return_value=None),
            ),
        ):
            package = importlib.import_module("verser2_guest_python")
            response_type = getattr(package, "VerserBrokerResponse")
            response = response_type(
                status=200,
                headers={"content-type": "application/octet-stream"},
                request_id="req-binary",
                body=b"\x00\xffchunk",
            )

            self.assertEqual(response._body, b"\x00\xffchunk")

            async def collect() -> bytes:
                chunks = []
                async for chunk in response.aiter_bytes(3):
                    chunks.append(chunk)
                return b"".join(chunks)

            collected = self._run(collect())
            self.assertEqual(collected, b"\x00\xffchunk")


class VerserBrokerRouteLifecycleTest(unittest.TestCase):
    """Tests for Broker route lifecycle events (route-change subscription)."""

    def _broker_factory(self):
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker", None)
        self.assertIsNotNone(create_verser_broker)
        assert create_verser_broker is not None
        return create_verser_broker(
            host_url="https://127.0.0.1",
            broker_id="python-lifecycle-broker",
        )

    def test_on_route_change_returns_unsubscribe_callable(self) -> None:
        broker = self._broker_factory()
        unsub = broker.on_route_change(lambda e: None)
        self.assertTrue(callable(unsub))
        # Calling the unsub should not raise
        unsub()

    def test_snapshot_frame_emits_added_and_removed_events(self) -> None:
        broker = self._broker_factory()

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        # First snapshot
        broker._handle_control_frame(
            {
                "type": "routes",
                "routes": [
                    {"targetId": "guest-a", "domain": "alpha.local"},
                    {"targetId": "guest-b", "domain": "beta.local"},
                ],
            }
        )

        # Expect two 'added' events
        added = [e for e in events if e.get("type") == "added"]
        self.assertEqual(len(added), 2)
        self.assertEqual(added[0]["domain"], "alpha.local")
        self.assertEqual(added[1]["domain"], "beta.local")

        events.clear()

        # Second snapshot removes beta
        broker._handle_control_frame(
            {
                "type": "routes",
                "routes": [
                    {"targetId": "guest-a", "domain": "alpha.local"},
                ],
            }
        )

        removed = [e for e in events if e.get("type") == "removed"]
        self.assertEqual(len(removed), 1)
        self.assertEqual(removed[0]["domain"], "beta.local")

    def test_lifecycle_frame_added_event_updates_snapshot(self) -> None:
        broker = self._broker_factory()

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "added",
                        "targetId": "guest-c",
                        "domain": "charlie.local",
                        "reason": "registered",
                    },
                ],
            }
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "added")
        self.assertEqual(events[0]["targetId"], "guest-c")
        self.assertEqual(events[0]["domain"], "charlie.local")
        self.assertEqual(events[0].get("reason"), "registered")

        # Snapshot should be updated
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0], {"targetId": "guest-c", "domain": "charlie.local"})

    def test_lifecycle_frame_removed_event_removes_from_snapshot(self) -> None:
        broker = self._broker_factory()
        broker._routes = [
            {"targetId": "guest-a", "domain": "alpha.local"},
            {"targetId": "guest-b", "domain": "beta.local"},
        ]

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "removed",
                        "targetId": "guest-a",
                        "domain": "alpha.local",
                        "reason": "revoked",
                    },
                ],
            }
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "removed")
        self.assertEqual(events[0]["reason"], "revoked")

        # Snapshot should have only beta
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0], {"targetId": "guest-b", "domain": "beta.local"})

    def test_lifecycle_frame_changed_event_updates_snapshot(self) -> None:
        broker = self._broker_factory()
        broker._routes = [
            {"targetId": "guest-a", "domain": "alpha.local"},
        ]

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "changed",
                        "targetId": "guest-a",
                        "domain": "alpha.local",
                        "reason": "restored",
                        "generation": {"generationId": "gen-2", "sessionId": "sess-2"},
                    },
                ],
            }
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "changed")
        self.assertEqual(events[0].get("reason"), "restored")
        self.assertIsNotNone(events[0].get("generation"))
        self.assertEqual(events[0]["generation"]["generationId"], "gen-2")

        # Snapshot unchanged but route remains
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)

    def test_lifecycle_frame_degraded_event_adds_to_snapshot_if_absent(self) -> None:
        broker = self._broker_factory()

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "degraded",
                        "targetId": "guest-d",
                        "domain": "delta.local",
                        "reason": "disconnected",
                    },
                ],
            }
        )

        self.assertEqual(len(events), 1)
        self.assertEqual(events[0]["type"], "degraded")

        # Degraded route should appear in snapshot
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0], {"targetId": "guest-d", "domain": "delta.local"})

    def test_lifecycle_frame_keeps_degraded_route_in_snapshot_if_already_present(
        self,
    ) -> None:
        broker = self._broker_factory()
        broker._routes = [
            {"targetId": "guest-e", "domain": "echo.local"},
        ]

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "degraded",
                        "targetId": "guest-e",
                        "domain": "echo.local",
                        "reason": "disconnected",
                    },
                ],
            }
        )

        # Should still have exactly 1 route
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)

    def test_lifecycle_frame_multiple_events_processed_in_order(self) -> None:
        broker = self._broker_factory()

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {"type": "added", "targetId": "guest-a", "domain": "alpha.local"},
                    {"type": "added", "targetId": "guest-b", "domain": "beta.local"},
                    {"type": "removed", "targetId": "guest-a", "domain": "alpha.local"},
                ],
            }
        )

        # Three events: added, added, removed
        self.assertEqual(len(events), 3)
        self.assertEqual(events[0]["type"], "added")
        self.assertEqual(events[2]["type"], "removed")

        # Snapshot should have only beta
        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0]["domain"], "beta.local")

    def test_lifecycle_frame_changed_adds_route_if_missing(self) -> None:
        """'changed' event for a route not in snapshot should add it."""
        broker = self._broker_factory()

        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {
                        "type": "changed",
                        "targetId": "guest-f",
                        "domain": "foxtrot.local",
                        "reason": "restored",
                    },
                ],
            }
        )

        routes = broker.get_routes()
        self.assertEqual(len(routes), 1)
        self.assertEqual(routes[0], {"targetId": "guest-f", "domain": "foxtrot.local"})

    def test_unknown_control_frame_is_safely_ignored(self) -> None:
        broker = self._broker_factory()

        events: list[dict[str, Any]] = []
        broker.on_route_change(events.append)

        # Should not crash
        broker._handle_control_frame({"type": "unknown", "data": "whatever"})
        self.assertEqual(events, [])

    def test_snapshot_consistency_after_lifecycle_frames(self) -> None:
        """Route snapshots remain consistent after a sequence of lifecycle frames."""
        broker = self._broker_factory()

        # Start with a full snapshot
        broker._handle_control_frame(
            {
                "type": "routes",
                "routes": [{"targetId": "guest-1", "domain": "one.local"}],
            }
        )
        self.assertEqual(len(broker.get_routes()), 1)

        # Lifecycle events
        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {"type": "added", "targetId": "guest-2", "domain": "two.local"},
                    {
                        "type": "degraded",
                        "targetId": "guest-3",
                        "domain": "three.local",
                    },
                ],
            }
        )

        # Snapshot should include all three
        self.assertEqual(len(broker.get_routes()), 3)

        # Remove one via lifecycle
        broker._handle_control_frame(
            {
                "type": "route-lifecycle",
                "events": [
                    {"type": "removed", "targetId": "guest-2", "domain": "two.local"},
                ],
            }
        )

        self.assertEqual(len(broker.get_routes()), 2)

    def test_wait_for_route_resolves_on_lifecycle_added_event(self) -> None:
        broker = self._broker_factory()

        async def run() -> None:
            waiter = asyncio.create_task(broker.wait_for_route("newly-added.local"))
            await asyncio.sleep(0)
            self.assertFalse(waiter.done())

            broker._handle_control_frame(
                {
                    "type": "route-lifecycle",
                    "events": [
                        {
                            "type": "added",
                            "targetId": "guest-new",
                            "domain": "newly-added.local",
                        },
                    ],
                }
            )
            await asyncio.wait_for(waiter, timeout=1)

        asyncio.run(run())


class VerserBrokerTlsConfigTest(unittest.TestCase):
    """Tests for future Python Broker TLS/mTLS behaviour.

    These tests use finite EOF mocks for transport readers so connection setup
    assertions cannot accidentally leave a background read loop running forever.
    """

    def _broker_factory(self, **overrides: Any) -> Any:
        package = importlib.import_module("verser2_guest_python")
        create_verser_broker = getattr(package, "create_verser_broker", None)
        self.assertIsNotNone(
            create_verser_broker,
            "create_verser_broker is not exported from verser2_guest_python",
        )
        assert create_verser_broker is not None
        opts: dict[str, Any] = {
            "host_url": "https://127.0.0.1",
            "broker_id": "python-unit-broker",
        }
        opts.update(overrides)
        return create_verser_broker(**opts)

    def _run(self, coroutine: Any) -> Any:
        return asyncio.run(coroutine)

    # ------------------------------------------------------------------
    # Test 1 — trusted Host CA
    # ------------------------------------------------------------------

    def test_tls_ca_file_passed_to_ssl_context(self) -> None:
        """``tls_ca_file`` is forwarded to ``ssl.create_default_context``."""
        broker = self._broker_factory(tls_ca_file="/ca.pem")
        ssl_context = MagicMock()

        async def fake_open_connection(*args: Any, **kwargs: Any) -> tuple[Any, Any]:
            reader = AsyncMock()
            reader.read = AsyncMock(return_value=b"")
            writer = MagicMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            ssl_obj = MagicMock()
            ssl_obj.selected_alpn_protocol.return_value = "h2"
            writer.get_extra_info.return_value = ssl_obj
            return reader, writer

        with patch("ssl.create_default_context", return_value=ssl_context) as mock_ctx:
            with patch("asyncio.open_connection", side_effect=fake_open_connection):
                with patch.object(type(broker), "_register", new=AsyncMock()):
                    with patch.object(
                        type(broker), "_open_control_stream", new=AsyncMock()
                    ):
                        with patch.object(
                            type(broker), "_start_lease_task", new=MagicMock()
                        ):
                            self._run(broker.connect())

        mock_ctx.assert_called_once_with(cafile="/ca.pem")

    # ------------------------------------------------------------------
    # Test 2 — PEM client identity
    # ------------------------------------------------------------------

    def test_pem_client_identity_configures_cert_chain(self) -> None:
        """``tls_cert_file`` / ``tls_key_file`` / ``tls_key_password`` cause
        ``SSLContext.load_cert_chain`` to be called with the right arguments."""
        broker = self._broker_factory(
            tls_ca_file="/ca.pem",
            tls_cert_file="/client.pem",
            tls_key_file="/client-key.pem",
            tls_key_password="secret",
        )
        ssl_context = MagicMock()

        async def fake_open_connection(*args: Any, **kwargs: Any) -> tuple[Any, Any]:
            reader = AsyncMock()
            reader.read = AsyncMock(return_value=b"")
            writer = MagicMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            ssl_obj = MagicMock()
            ssl_obj.selected_alpn_protocol.return_value = "h2"
            writer.get_extra_info.return_value = ssl_obj
            return reader, writer

        with patch("ssl.create_default_context", return_value=ssl_context):
            with patch("asyncio.open_connection", side_effect=fake_open_connection):
                with patch.object(type(broker), "_register", new=AsyncMock()):
                    with patch.object(
                        type(broker), "_open_control_stream", new=AsyncMock()
                    ):
                        with patch.object(
                            type(broker), "_start_lease_task", new=MagicMock()
                        ):
                            self._run(broker.connect())

        ssl_context.load_cert_chain.assert_called_once_with(
            certfile="/client.pem",
            keyfile="/client-key.pem",
            password="secret",
        )

    # ------------------------------------------------------------------
    # Test 3 — PFX / PKCS12 client identity
    # ------------------------------------------------------------------

    def test_pfx_client_identity_invokes_helper(self) -> None:
        """Options ``tls_pfx_file`` and ``tls_pfx_password`` are accepted and
        cause a broker helper (``_load_pfx_client_identity``) to be invoked."""
        broker = self._broker_factory(
            tls_ca_file="/ca.pem",
            tls_pfx_file="/client.pfx",
            tls_pfx_password="pfx-secret",
        )

        self.assertTrue(
            hasattr(type(broker), "_load_pfx_client_identity"),
            "Broker should expose a _load_pfx_client_identity helper "
            "for PFX/PKCS12 client identity support",
        )

    def test_pfx_client_identity_loads_temp_cert_after_file_close(self) -> None:
        """PFX conversion closes the temporary PEM file before SSL loads it.

        Windows locks open ``NamedTemporaryFile`` handles, so loading the cert
        chain while the temporary file is still open can fail.
        """
        broker = self._broker_factory()
        ssl_context = MagicMock()
        temp_file_state = {"closed": False}

        class FakeTemporaryFile:
            name = "/tmp/verser-python-broker-client.pem"

            def __enter__(self) -> "FakeTemporaryFile":
                return self

            def __exit__(self, _exc_type: Any, _exc: Any, _tb: Any) -> None:
                temp_file_state["closed"] = True

            def write(self, _payload: bytes) -> int:
                return len(_payload)

            def flush(self) -> None:
                return None

        fake_key = MagicMock()
        fake_key.private_bytes.return_value = b"KEY"
        fake_certificate = MagicMock()
        fake_certificate.public_bytes.return_value = b"CERT"

        def assert_closed_before_load(_path: str) -> None:
            self.assertTrue(temp_file_state["closed"])

        ssl_context.load_cert_chain.side_effect = assert_closed_before_load

        with patch(
            "tempfile.NamedTemporaryFile", return_value=FakeTemporaryFile()
        ) as temp_file:
            with patch("os.unlink") as unlink:
                with patch.object(builtins, "open", return_value=BytesIO(b"pfx-bytes")):
                    with patch(
                        "cryptography.hazmat.primitives.serialization.pkcs12.load_key_and_certificates",
                        return_value=(fake_key, fake_certificate, []),
                    ):
                        broker._load_pfx_client_identity(
                            ssl_context, "/client.pfx", "secret"
                        )

        temp_file.assert_called_once_with("wb", delete=False)
        ssl_context.load_cert_chain.assert_called_once_with(
            "/tmp/verser-python-broker-client.pem"
        )
        unlink.assert_called_once_with("/tmp/verser-python-broker-client.pem")

    # ------------------------------------------------------------------
    # Test 4 — ALPN negotiated-protocol validation
    # ------------------------------------------------------------------

    def test_alpn_not_h2_raises_actionable_error(self) -> None:
        """If ``selected_alpn_protocol()`` returns anything other than ``'h2'``,
        ``connect()`` raises an actionable exception mentioning ALPN / HTTP/2."""
        broker = self._broker_factory()
        ssl_context = MagicMock()

        async def fake_open_connection(*args: Any, **kwargs: Any) -> tuple[Any, Any]:
            reader = AsyncMock()
            reader.read = AsyncMock(return_value=b"")
            writer = MagicMock()
            writer.write = MagicMock()
            writer.drain = AsyncMock()
            writer.close = MagicMock()
            writer.wait_closed = AsyncMock()
            # Simulate failed ALPN negotiation
            ssl_obj = MagicMock()
            ssl_obj.selected_alpn_protocol.return_value = "http/1.1"
            writer.get_extra_info.return_value = ssl_obj
            return reader, writer

        with patch("ssl.create_default_context", return_value=ssl_context):
            with patch("asyncio.open_connection", side_effect=fake_open_connection):
                with patch.object(type(broker), "_register", new=AsyncMock()):
                    with patch.object(
                        type(broker), "_open_control_stream", new=AsyncMock()
                    ):
                        with patch.object(
                            type(broker), "_start_lease_task", new=MagicMock()
                        ):
                            with self.assertRaises(Exception) as context:
                                self._run(broker.connect())

        message = str(context.exception).lower()
        self.assertTrue(
            any(word in message for word in ("alpn", "http/2", "h2")),
            f"Exception should mention ALPN or HTTP/2, got: {context.exception}",
        )

    def test_missing_alpn_selection_raises_actionable_error(self) -> None:
        """HTTP/2 over TLS requires ALPN to select ``h2`` explicitly."""
        broker = self._broker_factory()
        writer = MagicMock()
        ssl_obj = MagicMock()
        ssl_obj.selected_alpn_protocol.return_value = None
        writer.get_extra_info.return_value = ssl_obj

        with self.assertRaises(Exception) as context:
            broker._validate_h2_alpn(writer)

        message = str(context.exception).lower()
        self.assertTrue(
            any(word in message for word in ("alpn", "http/2", "h2")),
            f"Exception should mention ALPN or HTTP/2, got: {context.exception}",
        )

    # ------------------------------------------------------------------
    # Test 5 — TLS handshake failure
    # ------------------------------------------------------------------

    def test_tls_handshake_failure_is_actionable(self) -> None:
        """A TLS handshake failure from ``asyncio.open_connection`` is wrapped
        or propagated with an actionable context mentioning TLS / handshake."""
        broker = self._broker_factory()
        ssl_context = MagicMock()

        with patch("ssl.create_default_context", return_value=ssl_context):
            with patch(
                "asyncio.open_connection",
                side_effect=OSError("Connection refused"),
            ):
                with self.assertRaises(Exception) as context:
                    self._run(broker.connect())

        message = str(context.exception).lower()
        self.assertTrue(
            any(word in message for word in ("tls", "handshake")),
            f"Exception should mention TLS or handshake, got: {context.exception}",
        )


if __name__ == "__main__":
    unittest.main()
