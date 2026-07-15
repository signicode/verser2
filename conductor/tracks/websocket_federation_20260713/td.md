# Deferred Findings

- [ ] P2: Python Broker reserves six times UTF-8 payload size before VWS/1 serialization, rejecting valid text/ping/pong frames below the documented 1 MiB encoded-frame limit; use exact serialized-size admission and reservation accounting. (scope: track; owner: implementation; verification: focused Python Broker WebSocket size-boundary tests)
