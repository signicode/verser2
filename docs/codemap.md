# docs/

## Responsibility

User-facing task documentation for the Verser2 system. Explains how to create and configure a Host, attach Guests (Node, Bun, Python), connect Brokers and send routed requests, manage TLS/mTLS certificates, understand route advertisement and matching, handle lifecycle events and errors, work with authorization, and navigate common development issues.

Also covers the package publishing runbook (version policy, staging, CI) and repository development setup. The docs are written for **consumers** of the published packages — they do not document internal implementation details of the packages themselves.

## Design/Patterns

- **Index + specialized pages** — `docs/index.md` is the landing page with role definitions, getting-started links, transport summary, and terminology table. Each remaining page covers one topic.
- **11 documentation files** covering:
  - `connecting.md` — Host creation, Guests (Node/Bun/Python), Broker connection
  - `exposing-http.md` — Node `http.Server`, Bun `fetch` handler, Python ASGI 3 attachment
  - `making-requests.md` — Broker.request(), Agent, Dispatcher, Fetch helper
  - `routes.md` — Route registration, exact hostname matching, control frames, getRoutes/get_routes
  - `certificates.md` — TLS config (PEM/PFX), mTLS client auth, cert reloading, self-signed
  - `authorization.md` — Registration-time authorization callback
  - `lifecycle-and-errors.md` — Host/Guest lifecycle events, Broker errors, reconnection
  - `development.md` — Repository setup, build, test, lint, package staging commands
  - `common-issues.md` — Non-terminating read-loop mocks, OOM debugging, flow control guidance
  - `package-publishing.md` — Version/dist-tag policy, staging, pack, CI publish workflow
  - `index.md` — Landing page, role definitions, terminology
- **README.md link rewriting** — The root `README.md` and package READMEs link into `docs/` via relative paths. The `stage-packages.js` script rewrites these to GitHub blob URLs (`https://github.com/signicode/verser2/blob/<ref>/...`) for published package consumers.
- **Cross-reference style** — Pages link to each other with `[text](./other-page.md)` relative references. No absolute or external doc host links.
- **Code-first** — All API usage is demonstrated with TypeScript/Python code blocks. No prose-driven tutorial narrative beyond setup steps.

## Data & Control Flow

```
Root README.md
  └─ links to docs/index.md
       ├─ connecting.md      → Host, Guest, Broker setup
       ├─ exposing-http.md   → handler attachment (Node/Bun/Python)
       ├─ making-requests.md → Broker API, Agent, Dispatcher, Fetch
       ├─ routes.md          → advertisement, matching, control frames
       ├─ certificates.md    → TLS, mTLS, self-signed, reloading
       ├─ authorization.md   → registration-time auth
       ├─ lifecycle-and-errors.md → events, errors, reconnection
       └─ development.md     → repository setup, validation

Package READMEs (packages/*/README.md)
  └─ link to relevant docs/ pages (exposing-http.md, making-requests.md, connecting.md)

Staging (stage-packages.js)
  └─ rewrites docs/ links in package READMEs to GitHub blob URLs
     based on current commit SHA or VERSER_PACKAGE_DOCS_REF
```

## Integration

- **Root README** — The repository README.md links to docs/index.md from its "Documentation" section and references all package links.
- **Package READMEs** — Each workspace package's README.md links to specific docs/ pages. These relative links are rewritten to GitHub blob URLs at staging time.
- **Scripts** — `scripts/stage-packages.js` reads package READMEs and rewrites relative links to `../../docs/...` into GitHub blob references. `VERSER_PACKAGE_DOCS_REF` env var controls the ref (default: current commit SHA).
- **Tests** — `test/docs.test.js` and `test/python-guest-documentation.test.js` assert that documentation covers required topics, package mentions, and API names. They verify that docs reference implemented APIs and avoid exposing internal symbols (e.g., `dispatchVerserBunRequest`).
- **Conductor** — `conductor/tech-stack.md` references the docs structure.
