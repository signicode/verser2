const assert = require('node:assert/strict');
const { test } = require('node:test');

const common = require('../packages/verser-common/dist/index.js');

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
