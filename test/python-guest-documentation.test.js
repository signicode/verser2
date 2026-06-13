const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

function readText(relativePath) {
  return fs.readFileSync(path.join(rootDirectory, relativePath), 'utf8');
}

test('README documents the implemented Python ASGI Guest and Broker package', () => {
  const readme = readText('README.md');

  assert.match(readme, /@signicode\/verser2-guest-python/);
  assert.match(readme, /Python ASGI Guest and Broker/);
  assert.match(readme, /docs\/exposing-http\.md/);
  assert.match(readme, /docs\/making-requests\.md/);
});

test('task docs document Python ASGI Guest usage', () => {
  const exposingDocs = readText('docs/exposing-http.md');

  assert.match(exposingDocs, /## Python Guest/);
  assert.match(exposingDocs, /ASGI 3/);
  assert.match(exposingDocs, /create_verser_guest/);
  assert.match(exposingDocs, /FastAPI compatibility/);
});

test('Python package README documents usage, streaming, and limits', () => {
  const readme = readText('packages/verser2-guest-python/README.md');

  assert.match(readme, /create_verser_guest/);
  assert.match(readme, /create_verser_broker/);
  assert.match(readme, /ASGI 3/);
  assert.match(readme, /Streaming behavior/);
  assert.match(readme, /Known limits/);
  assert.match(readme, /FastAPI-compatible/);
  assert.doesNotMatch(readme, /full Python Broker/);
});

test('Tech stack lists Python Guest as implemented with uv and h2', () => {
  const techStack = readText('conductor/tech-stack.md');

  assert.match(techStack, /@signicode\/verser2-guest-python/);
  assert.match(techStack, /Python ASGI Guest/);
  assert.match(techStack, /uv/);
  assert.match(techStack, /h2/);
});
