async def app(scope, receive, send):
    """Minimal ASGI 3 app placeholder for the Python Guest package."""
    assert scope["type"] == "http"

    while True:
        event = await receive()
        if event["type"] == "http.request" and not event.get("more_body", False):
            break

    await send(
        {
            "type": "http.response.start",
            "status": 200,
            "headers": [(b"content-type", b"text/plain")],
        }
    )
    await send({"type": "http.response.body", "body": b"hello from verser2 python guest"})
