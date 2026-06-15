# Routes

Route records map domain names to registered Guests or imported federated route
candidates. The Host maintains the route table and advertises changes to
connected Brokers.

## Route registration

When a Guest connects, it advertises one or more routed domains:

```ts
const guest = createVerserNodeGuest({
  hostUrl: 'https://localhost:8443',
  guestId: 'client-a',
  routedDomains: ['app.example.com', 'api.example.com'],
});
```

Alternatively, supply the domain at `attach()` time:

```ts
guest.attach(server, 'app.example.com');
```

The domain sent to `attach()` takes precedence over the Guest constructor's
`routedDomains`.

Local Host Guests attached with `host.attachLocalGuest()` register their
`routedDomains` through the same Host route table as remote TLS HTTP/2 Guests.

## Route matching

Route matching is **exact URL hostname equality**. There is no wildcard, suffix,
or prefix domain matching:

| Registered domain   | Incoming hostname      | Match? |
|---------------------|------------------------|--------|
| `app.example.com`   | `app.example.com`      | Yes    |
| `app.example.com`   | `api.app.example.com`  | No     |
| `app.example.com`   | `example.com`          | No     |
| `*.example.com`     | `app.example.com`      | No     |

## Route control frames

After registration, the Host sends route-control frames to Brokers with the
full current route table. Each frame contains `routes: [{ domain, targetId }]`.
Federated routes are projected into this legacy Broker shape after the Host can
forward requests for the imported candidate; Brokers do not need to understand
Host federation metadata.

Later route frames **replace** the Broker's route state entirely. A shorter or
empty route list signals retraction of previously advertised routes.

Brokers update their internal route state from these control frames. Application
code can inspect the current route table with `getRoutes()` on Node/Bun Brokers
and local Brokers, or `get_routes()` on the Python Broker.

Local Brokers returned by `host.attachLocalBroker()` receive the same full
route-table replacement semantics as remote Brokers, including initial snapshots,
additions, retractions, `getRoutes()`, and `waitForRoute()`.

## Federated route candidates

When Host federation is enabled, a Host can hold multiple candidates for the same
`domain`/`targetId`: local Guests plus routes imported from upstream or
downstream Hosts. Candidate selection is deterministic:

1. local Guest routes first;
2. imported federated routes with a shorter hop count;
3. stable target/domain/next-hop/owner ordering.

Imported routes include loop-prevention metadata (`originHostId`,
`nextHopHostId`, `hopCount`, and `viaHostIds`). Routes that would revisit a Host
or exceed the configured hop limit are suppressed. When a Guest, upstream link,
or downstream Host disconnects, imported routes owned by that link are withdrawn
and Brokers receive a replacement route table.

## waitForRoute

Brokers use `waitForRoute(domain)` to wait until a domain appears in the route
table:

```ts
await broker.connect();
await broker.waitForRoute('client-a.local.test');
```

This resolves when the Broker observes a route-control frame for the requested
domain. Close or timeout behavior should be handled at the application boundary
if waiting forever is not acceptable.

## Local dispatch (Bun only)

The Bun Guest `attach()` handler can include a local `routes` table for
in-process path matching. This is purely local — it does not affect Host route
advertisements:

```ts
bunGuest.attach({
  routes: {
    '/health': new Response('ok'),
    '/users/:id': (request) => Response.json({ id: request.params.id }),
    '/api/*': () => Response.json({ wildcard: true }),
    '/items': {
      GET: new Response('list'),
      POST: () => new Response('created', { status: 201 }),
    },
  },
  fetch: (request) => {
    return Response.json({ path: new URL(request.url).pathname, fallback: true });
  },
}, 'client-a.local.test');
```

Matching precedence within the local routes table is:
1. Exact path match
2. `:param` parameterized paths
3. `*` wildcard path
4. `fetch()` fallback handler (if provided)

## Duplicate peer IDs

The Host rejects registration attempts with duplicate peer IDs. Each Guest and
Broker must have a unique `guestId` / `brokerId`.
