const assert = require('node:assert/strict');
const { PassThrough } = require('node:stream');
const { test } = require('node:test');

const { loadVerserCommon } = require('./support/verser-package-imports.cjs');

const common = loadVerserCommon();

test('shared envelope helpers encode request, response, and error metadata', () => {
  const requestEnvelope = common.encodeVerserEnvelope({
    type: 'request',
    metadata: {
      requestId: 'req-envelope-1',
      sourceId: 'broker-1',
      targetId: 'guest-1',
      method: 'POST',
      path: '/upload',
      headers: { 'content-type': 'application/octet-stream' },
      timeoutMs: 250,
    },
  });
  const responseEnvelope = common.encodeVerserEnvelope({
    type: 'response',
    metadata: {
      requestId: 'req-envelope-1',
      statusCode: 201,
      headers: { 'x-result': 'ok' },
    },
  });
  const errorEnvelope = common.encodeVerserEnvelope({
    type: 'error',
    metadata: {
      requestId: 'req-envelope-1',
      code: 'timeout',
      message: 'Lease timed out',
      context: { targetId: 'guest-1', timeoutMs: 250, retryable: false },
    },
  });

  assert.equal(requestEnvelope[0], common.VERSER_ENVELOPE_VERSION);
  assert.equal(requestEnvelope[1], common.VERSER_ENVELOPE_TYPES.request);
  assert.equal(responseEnvelope[1], common.VERSER_ENVELOPE_TYPES.response);
  assert.equal(errorEnvelope[1], common.VERSER_ENVELOPE_TYPES.error);
  assert.equal(requestEnvelope.readUInt32BE(2), requestEnvelope.length - 6);
});

test('shared envelope parser supports partial prefix, partial metadata, and body remainder', () => {
  const envelope = common.encodeVerserEnvelope({
    type: 'request',
    metadata: {
      requestId: 'req-parser-1',
      sourceId: 'broker-1',
      targetId: 'guest-1',
      method: 'PUT',
      path: '/binary',
      headers: { 'x-mode': 'chunked' },
    },
  });
  const body = Buffer.from([0, 1, 2, 255, 10]);
  const parser = common.createVerserEnvelopeParser({ maxMetadataBytes: 1024 });

  assert.equal(parser.push(envelope.subarray(0, 2)), undefined);
  assert.equal(parser.push(envelope.subarray(2, 5)), undefined);
  assert.equal(parser.push(envelope.subarray(5, envelope.length - 3)), undefined);

  const parsed = parser.push(Buffer.concat([envelope.subarray(envelope.length - 3), body]));

  assert.deepEqual(parsed, {
    type: 'request',
    metadata: {
      requestId: 'req-parser-1',
      sourceId: 'broker-1',
      targetId: 'guest-1',
      method: 'PUT',
      path: '/binary',
      headers: { 'x-mode': 'chunked' },
    },
    bodyRemainder: body,
  });
});

test('shared envelope parser rejects invalid envelopes with contextual errors', () => {
  assert.throws(
    () => common.createVerserEnvelopeParser().push(Buffer.from([2, 1, 0, 0, 0, 2, 123, 125])),
    /invalid envelope version/i,
  );
  assert.throws(
    () => common.createVerserEnvelopeParser().push(Buffer.from([1, 99, 0, 0, 0, 2, 123, 125])),
    /unknown envelope type/i,
  );
  assert.throws(
    () =>
      common
        .createVerserEnvelopeParser({ maxMetadataBytes: 1 })
        .push(Buffer.from([1, 1, 0, 0, 0, 2, 123, 125])),
    /metadata length exceeds/i,
  );
  assert.throws(
    () => common.createVerserEnvelopeParser().push(Buffer.from([1, 1, 0, 0, 0, 1, 123])),
    /invalid envelope metadata json/i,
  );
});

test('shared metadata validation rejects invalid and forbidden headers', () => {
  const headers = common.validateVerserHeaders({
    'content-type': 'text/plain',
    'x-tags': ['a', 'b'],
  });

  assert.deepEqual(headers, {
    'content-type': 'text/plain',
    'x-tags': ['a', 'b'],
  });
  assert.throws(
    () => common.validateVerserHeaders({ 'bad header': 'nope' }),
    /invalid header name/i,
  );
  assert.throws(() => common.validateVerserHeaders({ connection: 'close' }), /forbidden header/i);
  assert.throws(() => common.validateVerserHeaders({ upgrade: 'websocket' }), /forbidden header/i);
  assert.throws(() => common.validateVerserHeaders({ 'keep-alive': '1' }), /forbidden header/i);
});

test('shared stream helpers read exact bytes and unshift envelope body remainder', async () => {
  const stream = new PassThrough();
  const envelope = common.encodeVerserEnvelope({
    type: 'response',
    metadata: {
      requestId: 'req-stream-helper-1',
      statusCode: 204,
      headers: { 'x-stream': 'common' },
    },
  });
  const body = Buffer.from('body-remainder');

  stream.write(envelope.subarray(0, 2));
  setTimeout(() => stream.write(Buffer.concat([envelope.subarray(2), body])), 10);

  const parsed = await common.readLeaseResponseMetadataFromStream(stream, {
    requestId: 'req-stream-helper-1',
    targetId: 'guest-stream-helper-1',
  });

  assert.deepEqual(parsed, {
    requestId: 'req-stream-helper-1',
    statusCode: 204,
    headers: { 'x-stream': 'common' },
  });
  assert.deepEqual(stream.read(body.length), body);
});

test('shared stream helpers read request metadata without consuming body bytes', async () => {
  const stream = new PassThrough();
  const envelope = common.encodeVerserEnvelope({
    type: 'request',
    metadata: {
      requestId: 'req-stream-helper-2',
      sourceId: 'broker-stream-helper-1',
      targetId: 'guest-stream-helper-2',
      method: 'POST',
      path: '/common-stream',
      headers: { 'x-common': 'request' },
    },
  });
  const body = Buffer.from('request-body');

  stream.end(Buffer.concat([envelope, body]));

  const parsed = await common.readLeaseRequestMetadataFromStream(stream, {
    guestId: 'guest-stream-helper-2',
    leaseId: 'lease-stream-helper-2',
  });

  assert.equal(parsed.requestId, 'req-stream-helper-2');
  assert.equal(parsed.method, 'POST');
  assert.deepEqual(stream.read(body.length), body);
});

test('shared stream helpers reject oversized metadata before reading the full payload', async () => {
  const stream = new PassThrough();
  const prefix = Buffer.from([
    common.VERSER_ENVELOPE_VERSION,
    common.VERSER_ENVELOPE_TYPES.response,
  ]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(1024, 0);

  stream.end(Buffer.concat([prefix, length]));

  await assert.rejects(
    () =>
      common.readLeaseResponseMetadataFromStream(stream, {
        requestId: 'req-oversized-stream-1',
        targetId: 'guest-oversized-stream-1',
        maxMetadataBytes: 1,
      }),
    /metadata length exceeds limit/i,
  );
});

test('shared NDJSON parser uses data chunks and parses split lines', () => {
  const stream = new PassThrough();
  const frames = [];

  common.readNdjsonLines(stream, (frame) => frames.push(frame));
  stream.write('{"type":"one"}\n{"type"');
  stream.write(':"two"}\n\n');

  assert.deepEqual(frames, [{ type: 'one' }, { type: 'two' }]);
});

test('shared NDJSON parser reports invalid JSON without throwing from data handlers', () => {
  const stream = new PassThrough();
  let reportedError;

  common.readNdjsonLines(
    stream,
    () => {},
    (error) => {
      reportedError = error;
    },
  );

  assert.doesNotThrow(() => stream.write('{bad json}\n'));
  assert.equal(reportedError.code, 'protocol-error');
  assert.match(reportedError.message, /invalid ndjson/i);
  assert.equal(stream.destroyed, true);
});

test('shared NDJSON serialization writes JSON text lines with newline', () => {
  const encoded = common.encodeJsonLine({ type: 'routes', routes: [] });
  const serialized = Buffer.isBuffer(encoded) ? encoded.toString('utf8') : String(encoded);

  assert.equal(serialized, '{"type":"routes","routes":[]}\n');
});

test('shared Verser error body parser extracts known error metadata', () => {
  const body = Buffer.from(
    JSON.stringify({
      error: {
        code: 'missing-guest',
        message: 'Missing',
        context: { targetId: 'guest-1' },
      },
    }),
  );
  const parsed = common.verserErrorFromResponseBody(body, 'guest-1');

  assert.equal(parsed.code, 'missing-guest');
  assert.match(parsed.message, /\[missing-guest\] Missing \(targetId=guest-1/);
  assert.equal(parsed.context.targetId, 'guest-1');
});
