# Common development issues

## Non-terminating read-loop mocks can cause OOM

Verser Guest and Broker transports use long-running read loops in both the
Python and JavaScript runtimes. In tests, a mock stream that never signals EOF,
`end`, `close`, or `error` can accidentally create an infinite stream. The loop
keeps waiting for more data, repeatedly receives a truthy mock value, or keeps a
background task alive until memory is exhausted.

### First fix: enforce receiving-side flow control

When the symptom is an OOM, stalled stream, or runaway loop, first check the
receiving side. A receiver must apply flow control and only grant more credit
after data has actually been consumed by the application.

Good receiving-side behavior:

- bound buffers and queues;
- stop reading, pause, or withhold HTTP/2 window credit when consumers fall
  behind;
- acknowledge HTTP/2 `DataReceived.flow_controlled_length` only after the
  corresponding bytes have been consumed;
- treat EOF/end/reset/error as terminal and fail pending waiters;
- reject or close streams that keep sending empty chunks without progress;
- avoid aggregating request or response bodies forever unless there is an
  explicit size limit.

Sending-side fixes, such as chunking writes or adding test timeouts, are still
useful, but they do not replace receiver backpressure. If a receiver keeps
accepting data without bounded queues or flow-control accounting, any sender or
mock can still drive unbounded memory growth.

Python example:

```py
reader = AsyncMock()
# Problem: await reader.read(65535) returns another truthy AsyncMock forever.
```

JavaScript example:

```js
const stream = new PassThrough();
// Problem: test never calls stream.end(), stream.destroy(), or emits an error.
```

Python read loops expect `b""` to mean EOF. Node/Bun stream readers expect the
stream to end, close, or error. If the mocked source never reaches one of those
terminal states, the transport loop can spin, accumulate pending work, retain
buffers/listeners, or keep the process alive until memory is exhausted.

Use an explicit EOF/end result or a finite side effect.

Python:

```py
reader = AsyncMock()
reader.read = AsyncMock(return_value=b"")
```

or:

```py
reader = AsyncMock()
reader.read = AsyncMock(side_effect=[b"frame-bytes", b""])
```

JavaScript:

```js
const stream = new PassThrough();
stream.end(Buffer.from('frame-bytes'));
```

or:

```js
const stream = Readable.from([Buffer.from('frame-bytes')]);
```

For tests that only validate setup logic, prefer patching the read loop itself
to a no-op instead of starting a background loop.

Python:

```py
with patch.object(type(client), "_read_loop", new=AsyncMock(return_value=None)):
    await client.connect()
```

JavaScript:

```js
const readLoop = mock.method(client, 'readLoop', async () => {});
```

### Safe validation after an OOM

After a suspected read-loop OOM, run the smallest target under a timeout and,
where practical, a memory cap before running the full test suite. Prefer limits
that constrain the runtime under test without preventing the test runner itself
from starting.

Python package example:

```sh
ulimit -v 524288
timeout 20s uv run --project . python -m unittest tests.test_broker_api.VerserBrokerTlsConfigTest -v
```

Avoid applying a very low `ulimit -v` to `npm`/Node wrapper commands. V8 may
reserve more virtual address space than it will actually use, so a `512 MiB`
virtual-memory cap can make Node fail during startup before the test runs.

Node package example:

```sh
NODE_OPTIONS=--max-old-space-size=512 timeout 20s node --test test/specific.test.js
```

For full repository validation, use the first-class bounded test command. It
builds, stages, and runs the Node test suite with a 512 MiB default old-space
heap while allowing V8 to reserve virtual address space:

```sh
npm run test:bounded
```

This does not replace fixing the leak or unbounded aggregation. It is a safer
way to verify whether a suspected OOM reproduces under bounded heap conditions.
If the command passes under this limit, continue investigating protocol or test
runner memory behavior only if there is other evidence of growth.

Then widen validation only after the focused test exits safely.
