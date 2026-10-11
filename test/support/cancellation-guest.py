import asyncio
import json
import os
import signal
import sys

from verser2_guest_python import create_verser_guest


def emit(event: str, case_id: str, **details: object) -> None:
    print(
        json.dumps(
            {
                "event": event,
                "caseId": case_id,
                "runtime": "python",
                **details,
            },
            separators=(",", ":"),
        ),
        flush=True,
    )


async def main() -> None:
    host_url = os.environ["VERSER_HOST_URL"]
    guest_id = os.environ["VERSER_GUEST_ID"]
    domain = os.environ["VERSER_GUEST_DOMAIN"]
    ca_file = os.environ["VERSER_TLS_CA_FILE"]
    min_waiting_streams = int(os.environ.get("VERSER_MIN_WAITING_STREAMS", "3"))
    releases: dict[str, asyncio.Event] = {}
    active_requests: set[str] = set()
    cleanup_requested: set[str] = set()
    stop = asyncio.Event()

    def release_gate(case_id: str) -> asyncio.Event:
        return releases.setdefault(case_id, asyncio.Event())

    async def read_commands() -> None:
        while True:
            line = await asyncio.to_thread(sys.stdin.readline)
            if not line:
                return
            try:
                command = json.loads(line)
            except (TypeError, ValueError):
                continue
            if command.get("type") == "release" and isinstance(command.get("caseId"), str):
                release_gate(command["caseId"]).set()

    def read_path(scope: dict[str, object]) -> tuple[str, str, str]:
        parts = [part for part in str(scope["path"]).split("/") if part]
        return (
            parts[0] if parts else "",
            parts[1] if len(parts) > 1 else "",
            parts[2] if len(parts) > 2 else "",
        )

    async def receive_upload(receive) -> tuple[int, bool]:
        received_bytes = 0
        while True:
            event = await receive()
            if event.get("type") == "http.disconnect":
                return received_bytes, False
            if event.get("type") != "http.request":
                continue
            received_bytes += len(event.get("body", b""))
            if not event.get("more_body", False):
                return received_bytes, True

    async def send_complete(send, body: bytes) -> None:
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": body, "more_body": False})

    async def handle_request(scope, receive, send) -> None:
        kind, case_id, mode = read_path(scope)
        if kind == "sibling":
            emit("entered", case_id)
            active_requests.add(case_id)
            try:
                body_bytes, complete = await receive_upload(receive)
                if not complete:
                    return
                emit("upload-ended", case_id, bytes=body_bytes)

                response_completed = False

                async def observe_pending_receive() -> dict[str, object]:
                    event = await receive()
                    if not response_completed:
                        emit("unexpected-disconnect", case_id)
                    return event

                pending_disconnect = asyncio.create_task(observe_pending_receive())
                emit("pending-response-receive", case_id)
                await release_gate(case_id).wait()
                await send_complete(send, b"sibling-ok")
                response_completed = True
                disconnect = await pending_disconnect
                emit("completed", case_id, disconnect=disconnect.get("type"))
            finally:
                active_requests.discard(case_id)
            return

        if kind == "normal":
            emit("entered", case_id)
            active_requests.add(case_id)
            try:
                body_bytes, complete = await receive_upload(receive)
                emit("upload-ended", case_id, bytes=body_bytes)
                if complete:
                    await send_complete(send, b"normal-ok")
                    emit("completed", case_id)
            finally:
                active_requests.discard(case_id)
            return

        if kind != "cancel":
            await send(
                {"type": "http.response.start", "status": 404, "headers": []}
            )
            await send(
                {"type": "http.response.body", "body": b"not-found", "more_body": False}
            )
            return

        emit("entered", case_id)
        active_requests.add(case_id)
        try:
            body_bytes, complete = await receive_upload(receive)
            if not complete:
                return
            emit("upload-ended", case_id, bytes=body_bytes)
            if mode == "stream":
                await send({"type": "http.response.start", "status": 200, "headers": []})
                await send(
                    {"type": "http.response.body", "body": b"first-chunk", "more_body": True}
                )
                emit("response-started", case_id)
            event = await receive()
            if event.get("type") == "http.disconnect":
                emit("disconnect-notified", case_id)
                cleanup_requested.add(case_id)
        finally:
            active_requests.discard(case_id)

    async def app(scope, receive, send) -> None:
        _kind, case_id, _mode = read_path(scope)
        await handle_request(scope, receive, send)
        if case_id in cleanup_requested:
            cleanup_requested.remove(case_id)
            emit("cleanup", case_id, active=case_id in active_requests)

    guest = create_verser_guest(
        host_url=host_url,
        guest_id=guest_id,
        app=app,
        routed_domains=[domain],
        tls_ca_file=ca_file,
        min_waiting_streams=min_waiting_streams,
    )
    command_task: asyncio.Task[None] | None = None
    loop = asyncio.get_running_loop()
    loop.add_signal_handler(signal.SIGTERM, stop.set)
    loop.add_signal_handler(signal.SIGINT, stop.set)
    try:
        await guest.connect()
        command_task = asyncio.create_task(read_commands())
        emit("ready", "")
        await stop.wait()
    finally:
        if command_task is not None:
            command_task.cancel()
            await asyncio.gather(command_task, return_exceptions=True)
        await guest.close("cancellation-integration-shutdown")


if __name__ == "__main__":
    asyncio.run(main())
