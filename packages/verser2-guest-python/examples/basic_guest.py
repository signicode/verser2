import asyncio
import os

from verser2_guest_python import create_verser_guest


async def app(scope, receive, send):
    body = b""
    while True:
        event = await receive()
        body += event.get("body", b"")
        if not event.get("more_body", False):
            break

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
