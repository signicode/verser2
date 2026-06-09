import asyncio
import os

from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    if scope["path"] == "/first-chunk":
        event = await receive()
        await send(
            {
                "type": "http.response.start",
                "status": 215,
                "headers": [(b"x-guest", b"python"), (b"x-stream", b"request")],
            }
        )
        await send(
            {
                "type": "http.response.body",
                "body": b"first:" + event.get("body", b""),
                "more_body": False,
            }
        )
        while event.get("more_body", False):
            event = await receive()
        return

    body = b""
    while True:
        event = await receive()
        body += event.get("body", b"")
        if not event.get("more_body", False):
            break

    if scope["path"] == "/slow-response":
        await send(
            {
                "type": "http.response.start",
                "status": 216,
                "headers": [(b"x-guest", b"python"), (b"x-stream", b"response")],
            }
        )
        await send({"type": "http.response.body", "body": b"one-", "more_body": True})
        await asyncio.sleep(0.1)
        await send({"type": "http.response.body", "body": b"two", "more_body": False})
        return

    header_map = {name: value for name, value in scope["headers"]}
    await send(
        {
            "type": "http.response.start",
            "status": 214,
            "headers": [(b"x-guest", b"python")],
        }
    )
    await send(
        {
            "type": "http.response.body",
            "body": b" ".join(
                [
                    scope["method"].encode("ascii"),
                    scope["path"].encode("utf-8"),
                    scope["query_string"],
                    header_map.get(b"x-input", b""),
                    body,
                ]
            ),
        }
    )


async def main():
    guest = create_verser_guest(
        host_url=os.environ["VERSER_HOST_URL"],
        guest_id=os.environ.get("VERSER_GUEST_ID", "python-guest-basic"),
        app=app,
        routed_domains=[os.environ.get("VERSER_GUEST_DOMAIN", "python-basic.local.test")],
        tls_ca_file=os.environ.get("VERSER_TLS_CA_FILE"),
    )
    await guest.connect()
    print("python guest ready", flush=True)
    try:
        await asyncio.Event().wait()
    finally:
        await guest.close()


if __name__ == "__main__":
    asyncio.run(main())
