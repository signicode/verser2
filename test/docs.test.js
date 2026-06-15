const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const rootDirectory = path.resolve(__dirname, '..');

test('development docs document workspace setup commands', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const developmentDocs = fs.readFileSync(path.join(rootDirectory, 'docs/development.md'), 'utf8');

  assert.match(readme, /docs\/development\.md/);
  assert.match(developmentDocs, /# Development guide/);
  assert.match(developmentDocs, /npm install/);
  assert.match(developmentDocs, /npm run build/);
  assert.match(developmentDocs, /npm test/);
  assert.match(developmentDocs, /npm run test:bounded/);
  assert.match(developmentDocs, /512 MiB/);
  assert.match(developmentDocs, /--max-old-space-size=512/);
  assert.match(developmentDocs, /node --test test\/<name>\.test\.js/);
  assert.match(developmentDocs, /npm run test:package-consumers/);
  assert.match(developmentDocs, /npm run test:package-tarballs/);
  assert.match(developmentDocs, /Bun/);
  assert.match(developmentDocs, /Python\/`uv`|Python and `uv`/);
  assert.match(developmentDocs, /virtual-memory cap/i);
  assert.match(developmentDocs, /npm run lint/);
  assert.match(developmentDocs, /@signicode\/verser-common/);
  assert.match(developmentDocs, /packages\/verser-common/);
  assert.match(developmentDocs, /@signicode\/verser2-host/);
  assert.match(developmentDocs, /packages\/verser2-host/);
  assert.match(developmentDocs, /@signicode\/verser2-guest-node/);
  assert.match(developmentDocs, /packages\/verser2-guest-node/);
  assert.match(developmentDocs, /@signicode\/verser2-guest-bun/);
  assert.match(developmentDocs, /packages\/verser2-guest-bun/);
  assert.match(developmentDocs, /VERSER_PACKAGE_DOCS_REF/);
});

test('task docs document Bun Guest usage and non-listen behavior', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const exposingDocs = fs.readFileSync(path.join(rootDirectory, 'docs/exposing-http.md'), 'utf8');
  const makingRequestsDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/making-requests.md'),
    'utf8',
  );

  assert.match(readme, /verser2-guest-bun/);
  assert.match(exposingDocs, /createVerserBunGuest/);
  assert.match(makingRequestsDocs, /createFetch/);
  assert.match(makingRequestsDocs, /createDispatcher/);
  assert.match(exposingDocs, /route advertisement/);
  assert.match(exposingDocs, /fetch\(request, server\)/);
  assert.doesNotMatch(exposingDocs, /dispatchVerserBunRequest/);
  assert.match(exposingDocs, /routes\s*:/);
  assert.match(exposingDocs, /WebSocket/i);
  assert.match(exposingDocs, /server\.upgrade\(request\)[\s\S]*`false`/i);
  assert.match(exposingDocs, /never needs\s+to call/i);
  assert.match(exposingDocs, /listen\(\)/);
});

test('user docs document local Host peer attachment APIs', () => {
  const hostReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser2-host/README.md'),
    'utf8',
  );
  const indexDocs = fs.readFileSync(path.join(rootDirectory, 'docs/index.md'), 'utf8');
  const connectingDocs = fs.readFileSync(path.join(rootDirectory, 'docs/connecting.md'), 'utf8');
  const exposingDocs = fs.readFileSync(path.join(rootDirectory, 'docs/exposing-http.md'), 'utf8');
  const makingRequestsDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/making-requests.md'),
    'utf8',
  );
  const routesDocs = fs.readFileSync(path.join(rootDirectory, 'docs/routes.md'), 'utf8');
  const authorizationDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/authorization.md'),
    'utf8',
  );
  const lifecycleDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/lifecycle-and-errors.md'),
    'utf8',
  );

  assert.match(hostReadme, /attachLocalGuest/);
  assert.match(hostReadme, /attachLocalBroker/);
  assert.match(hostReadme, /VerserLocalGuestHandle/);
  assert.match(hostReadme, /VerserLocalBrokerHandle/);
  assert.match(connectingDocs, /Local Host peers/);
  assert.match(connectingDocs, /attachLocalGuest/);
  assert.match(connectingDocs, /attachLocalBroker/);
  assert.match(exposingDocs, /VerserLocalGuestRequestListener|attachLocalGuest/);
  assert.match(makingRequestsDocs, /Local Broker/);
  assert.match(makingRequestsDocs, /VerserLocalBrokerRequest|attachLocalBroker/);
  assert.match(routesDocs, /local Brokers/i);
  assert.match(authorizationDocs, /local peer authorization/i);
  assert.match(authorizationDocs, /local: true/);
  assert.match(authorizationDocs, /certificate: undefined/);
  assert.match(lifecycleDocs, /local peers/i);
  assert.match(indexDocs, /in-process local peers/i);
});

test('user docs document Host federation and upstream HA behavior', () => {
  const readme = fs.readFileSync(path.join(rootDirectory, 'README.md'), 'utf8');
  const hostReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser2-host/README.md'),
    'utf8',
  );
  const commonReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser-common/README.md'),
    'utf8',
  );
  const indexDocs = fs.readFileSync(path.join(rootDirectory, 'docs/index.md'), 'utf8');
  const federationDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/host-federation.md'),
    'utf8',
  );
  const connectingDocs = fs.readFileSync(path.join(rootDirectory, 'docs/connecting.md'), 'utf8');
  const routesDocs = fs.readFileSync(path.join(rootDirectory, 'docs/routes.md'), 'utf8');
  const authorizationDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/authorization.md'),
    'utf8',
  );
  const certificatesDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/certificates.md'),
    'utf8',
  );
  const lifecycleDocs = fs.readFileSync(
    path.join(rootDirectory, 'docs/lifecycle-and-errors.md'),
    'utf8',
  );

  assert.match(readme, /docs\/host-federation\.md/);
  assert.match(indexDocs, /Host federation and upstreams/);
  assert.match(connectingDocs, /connectUpstream/);
  assert.match(connectingDocs, /hostId/);
  assert.match(hostReadme, /connectUpstream/);
  assert.match(hostReadme, /getUpstreams/);
  assert.match(hostReadme, /VerserHostUpstreamHandle/);
  assert.match(commonReadme, /createFederatedRouteRegistration/);
  assert.match(commonReadme, /upstream-unavailable/);
  assert.match(routesDocs, /Federated route candidates/);
  assert.match(routesDocs, /local Guest routes first/i);
  assert.match(authorizationDocs, /authorizeFederation/);
  assert.match(certificatesDocs, /Upstream Host link TLS/);
  assert.match(lifecycleDocs, /upstream Host links/i);
  assert.match(lifecycleDocs, /route-loop/);
  assert.match(federationDocs, /runner Host/i);
  assert.match(federationDocs, /runner -> hub -> manager/i);
  assert.match(federationDocs, /Broker reaching a downstream Guest/);
  assert.match(federationDocs, /eventually consistent/);
  assert.match(federationDocs, /not\*\* migrate active requests/);
  assert.match(federationDocs, /CONNECT tunneling/);
});

test('Bun package README documents handler and entrypoint semantics', () => {
  const bunReadme = fs.readFileSync(
    path.join(rootDirectory, 'packages/verser2-guest-bun/README.md'),
    'utf8',
  );

  assert.match(bunReadme, /## Basic usage/);
  assert.match(bunReadme, /VERSER2_GUEST_BUN_PACKAGE_NAME/);
  assert.match(bunReadme, /createVerserBunGuest/);
  assert.match(bunReadme, /createVerserBroker/);
  assert.match(bunReadme, /createAgent\(\)/);
  assert.match(bunReadme, /createDispatcher\(\)/);
  assert.match(bunReadme, /createFetch\(\)/);
  assert.match(bunReadme, /fetch\(request\)/);
  assert.doesNotMatch(bunReadme, /dispatchVerserBunRequest/);
  assert.match(bunReadme, /Bun-facing Broker wrapper/i);
  assert.match(bunReadme, /Fetch-style request bodies/i);
  assert.match(bunReadme, /WebSocket/i);
  assert.match(bunReadme, /does \*\*not\*\* call/i);
  assert.match(bunReadme, /`Bun\.serve\(\)`/);
  assert.match(bunReadme, /`listen\(\)`/);
  assert.match(
    bunReadme,
    /upgrade forwarding is \*\*not\*\* implemented|server\.upgrade\(request\)[\s\S]*returns `false`/i,
  );
});
