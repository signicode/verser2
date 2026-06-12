import asyncio
import importlib
import inspect
import unittest
from typing import Any
from unittest.mock import AsyncMock


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
        broker.connect = AsyncMock(return_value=None)
        broker.close = AsyncMock(return_value=None)

        async def run() -> None:
            async with broker:
                pass

        try:
            asyncio.run(run())
        finally:
            broker.connect = original_connect
            broker.close = original_close

        self.assertEqual(broker.connect.await_count, 1)
        self.assertEqual(broker.close.await_count, 1)

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


if __name__ == "__main__":
    unittest.main()
