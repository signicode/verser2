# Implementation Plan: Move Shared Interface Helpers into Common

## Phase 1: Inventory, grouping, and test baseline

- [x] Task: Review common library and draft move inventory
    - [x] Read `docs/draft-interface-moves.md` and group items by functional area.
    - [x] Review existing `packages/verser-common/src/lib/*` exports before adding new package-local or common code.
    - [x] Identify which existing modules should receive new exports and which areas justify new modules.
    - [x] Record deferred or kept-local candidates in this plan before implementation begins.
- [x] Task: Establish current validation baseline
    - [x] Run the narrowest relevant existing tests for common, host, guest-node, and guest-js-common behavior if available.
    - [x] Run `npm run build` to confirm the starting build state.
    - [x] Record any preexisting validation failures before making implementation changes.
- [x] Task: Prepare TDD coverage map
    - [x] Locate tests covering registration, headers, errors, NDJSON/control frames, and routing behavior.
    - [x] Decide which tests should move to common with unchanged assertions and which package tests should remain adapter-level.
    - [x] Add failing or relocated tests first for helpers that will move into common.
- [x] Task: Conductor - User Manual Verification 'Phase 1: Inventory, grouping, and test baseline' (Protocol in workflow.md)

## Phase 2: Registration and route/control protocol moves

- [x] Task: Write or move registration/control-frame tests first
    - [x] Fixer guidance: delegate this task only after listing the exact tests to move or add and requiring unchanged assertions except import/source updates.
    - [x] Add or relocate tests for peer role, registration request parsing, registration response shape/parsing, and broker route-control frames.
    - [x] Preserve test assertions where tests are moved; change only imports/source locations when possible.
    - [x] Confirm the tests fail for missing common exports before implementation.
- [x] Task: Move registration/control-frame contracts into common
    - [x] Fixer guidance: delegate as one bounded refactor after tests fail, limited to common registration/control-frame exports and corresponding Host/Guest import updates.
    - [x] Move `VerserPeerRole` into common.
    - [x] Move and rename `VerserHostRegistrationRequest` to `VerserRegistrationRequest` in common.
    - [x] Move `parseRegistrationRequest` into common, strengthening validation only where compatible with current behavior.
    - [x] Move registration response and broker control frame protocol types into common.
- [x] Task: Update package usage
    - [x] Fixer guidance: delegate only with explicit allowed files and focused validation commands for the registration/control-frame area.
    - [x] Update Host and Guest package imports to use common registration/control-frame contracts.
    - [x] Keep Host/Guest transport mechanics and state machines package-local.
    - [x] Run focused tests and build for affected packages.
- [x] Task: Record phase decisions and helper placement check
    - [x] Mark completed, deferred, or kept-local registration/control-frame items in `docs/draft-interface-moves.md`.
    - [x] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable registration/control helpers that should have gone to common.
    - [x] Record the helper placement result before phase checkpointing.
- [x] Task: Conductor - User Manual Verification 'Phase 2: Registration and route/control protocol moves' (Protocol in workflow.md)

## Phase 3: Header and protocol-header commonization

- [x] Task: Write or move header tests first
    - [x] Fixer guidance: delegate test movement only with a list of exact source tests and the requirement that assertions remain unchanged except import/source updates.
    - [x] Add or relocate tests for header flattening, header map decoding, lease acquire timeout parsing, HTTP/2 pseudo-header stripping, and runtime-neutral header normalization.
    - [x] Preserve existing test contents where tests move; change imports/source locations only as needed.
    - [x] Confirm new common tests fail before implementation.
- [x] Task: Combine common header abstractions
    - [x] Fixer guidance: delegate by sub-area when possible, for example header serialization separately from runtime-neutral header normalization, so each change can be reviewed and reverted independently.
    - [x] Combine Host `flattenValidatedHeaders` and Guest `flattenHeaders` into a common `flattenVerserHeaders` helper.
    - [x] Move `decodeHeaderMap` into common and add a paired encoder only if current call sites need it.
    - [x] Extract lease acquire timeout parsing and protocol header constants into common when appropriate.
    - [x] Combine JS common `flattenHeaderValue`, `normalizeHeaders`, header-name validation, and header-value validation with existing common header helpers.
    - [x] Extract `normalHeaders` into a clearly named HTTP/2 helper such as `stripHttp2PseudoHeaders` if reuse is confirmed.
- [x] Task: Update package usage
    - [x] Fixer guidance: delegate import rewiring only after common helper names and exports are fixed, and include focused header validation commands.
    - [x] Update Host, Guest Node, and Guest JS Common imports to use shared header helpers.
    - [x] Keep Node `OutgoingHttpHeaders`, Undici raw header list, and JS URL adaptation local unless only a pure helper is extracted.
    - [x] Run focused header tests and build for affected packages.
- [x] Task: Record phase decisions and helper placement check
    - [x] Mark completed, deferred, or kept-local header/protocol-header items in `docs/draft-interface-moves.md`.
    - [x] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable header helpers that should have gone to common.
    - [x] Record the helper placement result before phase checkpointing.
- [x] Task: Conductor - User Manual Verification 'Phase 3: Header and protocol-header commonization' (Protocol in workflow.md)

## Phase 4: Error response, coercion, and NDJSON extraction

- [x] Task: Write or move error and NDJSON tests first
    - [x] Fixer guidance: delegate only after identifying exact Host/Guest tests to move or add and requiring unchanged assertions except import/source updates.
    - [x] Add or relocate tests for serialized HTTP error response shape, error response parsing, error code coercion, unknown-error coercion, and NDJSON line encoding.
    - [x] Preserve assertions where tests move from Host or Guest packages to common.
    - [x] Confirm new common tests fail before implementation.
- [x] Task: Move error response helpers into common
    - [x] Fixer guidance: delegate as a bounded error-response refactor with explicit source helpers, destination exports, and package import updates.
    - [x] Move and rename `ErrorResponse` to a common serialized error response type.
    - [x] Move `toErrorResponse` into common as the shared serialization helper.
    - [x] Move or extract `errorFromBody` into common as the matching parser.
    - [x] Move `toVerserErrorCode` into common near `VerserErrorCode`.
    - [x] Export or adapt common `getErrorMessage` and combine Host/Guest `toVerserError` variants behind a shared helper if compatible.
- [x] Task: Extract NDJSON serialization
    - [x] Fixer guidance: delegate only the pure serialization extraction and import rewiring; keep HTTP/2 response behavior out of the delegated common change.
    - [x] Extract the pure serialization part of `writeJsonLine` into common, such as `encodeJsonLine`.
    - [x] Keep HTTP/2 stream response behavior local to Host.
    - [x] Ensure `sendError` uses common error serialization while retaining Host-local send mechanics.
- [x] Task: Update package usage and validate
    - [x] Fixer guidance: delegate validation assistance only with the focused error/NDJSON test commands and expected successful build scope.
    - [x] Update Host and Guest imports to use common error and NDJSON helpers.
    - [x] Run focused error/NDJSON tests and build for affected packages.
- [x] Task: Record phase decisions and helper placement check
    - [x] Mark completed, deferred, or kept-local error/NDJSON items in `docs/draft-interface-moves.md`.
    - [x] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable error or NDJSON helpers that should have gone to common.
    - [x] Record the helper placement result before phase checkpointing.
- [x] Task: Conductor - User Manual Verification 'Phase 4: Error response, coercion, and NDJSON extraction' (Protocol in workflow.md)

## Phase 5: Isolated non-strong candidates

- [x] Task: Evaluate non-strong candidates as isolated reversible tasks
    - [x] Fixer guidance: delegate each non-strong candidate independently with one candidate group, allowed files, and rollback expectations per delegated task.
    - [x] Consider route alias/resolution moves, broker request normalization, body guards, content-length parsing, and query string utilities independently.
    - [x] Implement only candidates that clearly improve shared interfaces without pulling runtime-specific adapters into common.
    - [x] Leave package-specific transport, Undici, Node HTTP shim, and state-machine helpers local or inline as documented.
- [x] Task: Delegate bounded refactors to fixer where useful
    - [x] Fixer guidance: use fixer for scoped implementation or test moves only after candidate scope, expected behavior, allowed files, and validation commands are written down.
    - [x] Provide each delegated fixer task with the specific candidate group, expected tests, allowed files, and validation command.
    - [x] Review delegated changes before marking tasks complete.
    - [x] Record delegated findings and any intentionally deferred candidates in the plan notes.
- [x] Task: Record phase decisions and helper placement check
    - [x] Mark completed, deferred, or kept-local non-strong candidate items in `docs/draft-interface-moves.md`.
    - [x] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable helpers that should have gone to common.
    - [x] Record the helper placement result before phase checkpointing.
- [x] Task: Phase deduplication and documentation pass
    - [x] Fixer guidance: delegate only read-only search support or tightly scoped documentation/export updates; keep final decisions with the orchestrator.
    - [x] Re-scan affected Host, Guest Node, Guest JS Common, and Common modules for remaining duplicated helpers.
    - [x] Update package exports and documentation comments where public API changed.
    - [x] Ensure `docs/draft-interface-moves.md` is reflected by implemented, deferred, or kept-local decisions.
- [x] Task: Conductor - User Manual Verification 'Phase 5: Isolated non-strong candidates' (Protocol in workflow.md)

## Phase 6: Final draft completion and solution structure

- [ ] Task: Verify `docs/draft-interface-moves.md` completion status
    - [ ] Fixer guidance: do not delegate final approval, but a fixer may perform read-only checks for unchecked draft items and mismatches.
    - [ ] Check every item in `docs/draft-interface-moves.md` is marked completed, deferred, or kept local with enough context to understand the final decision.
    - [ ] Confirm no draft move remains ambiguous or unreviewed.
- [ ] Task: List final common structure in the solution
    - [ ] Fixer guidance: delegate only read-only collection of common exports/modules if useful; the orchestrator must verify and record the final structure.
    - [ ] List final `packages/verser-common/src/lib/*` modules that contain moved or generalized helpers.
    - [ ] List new or changed common exports and the Host/Guest packages that consume them.
    - [ ] Record any intentionally deferred candidates and why they remain outside common.
- [ ] Task: Final helper placement and deduplication check
    - [ ] Fixer guidance: delegate only bounded read-only scans for newly introduced helpers under Host and Guest Node packages.
    - [ ] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for new reusable helpers introduced during the track.
    - [ ] Move any in-scope reusable helpers into common or record why they remain package-local.
- [ ] Task: Final validation
    - [ ] Fixer guidance: validation command execution may be delegated, but failure classification and final acceptance remain with the orchestrator.
    - [ ] Run `npm run build`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Record coverage status or why coverage could not be measured separately.
- [ ] Task: Conductor - User Manual Verification 'Phase 6: Final draft completion and solution structure' (Protocol in workflow.md)

## Notes

- Phase commits should be created only after phase completion verification.
- Tests moved into common should preserve behavior and assertions; import/source changes are allowed when required by the move.
- Runtime-specific adapters should stay local unless a pure lower-level helper is extracted.
- Phase 1 has no required fixer guidance; fixer may still be used for bounded read-only or implementation support when appropriate.
- Every task after Phase 1 includes fixer guidance so delegated refactors remain bounded and reviewable.
- Each phase must update `docs/draft-interface-moves.md` for the items evaluated in that phase.
- Phase 1 inventory grouping:
    - Strong/common candidates: registration/control protocol contracts (`VerserPeerRole`, `VerserRegistrationRequest`, registration parsing/response parsing, broker route-control frames), header serialization/protocol-header helpers (`decodeHeaderMap`, `flattenVerserHeaders`, lease acquire timeout parsing, HTTP/2 pseudo-header stripping), serialized HTTP error response helpers, `toVerserErrorCode`, response-body error parsing, existing common `getErrorMessage`, pure NDJSON line encoding, and exact hostname route resolution.
    - Existing common modules to extend where fitting: `types.ts`, `routing.ts`, `headers.ts`, `http2-headers.ts`, `errors.ts`, `utils.ts`, and `ndjson.ts`.
    - New common modules likely justified for clarity: `registration.ts`, `header-serialization.ts`, `protocol-headers.ts`, and `error-response.ts`.
    - Deferred candidates: broad JS `VerserHeaderInput` policy and runtime-neutral header input normalization, broker request/body normalization, `parseContentLength`, `appendQueryString`, URL-to-route resolution, generic `coerceVerserError`, and route type reconciliation until naming/API policy is fixed.
    - Kept local candidates: HTTP/2 send/read mechanics, Node/Undici adapters, local HTTP shim classes, lease bookkeeping keys, dispatcher state, and stream consumers.
- Phase 1 validation baseline:
    - `npm run build` passed before implementation changes.
    - `node --test test/common-protocol.test.js test/common-envelope.test.js test/host.test.js test/guest-node.test.js test/broker-routing.test.js` passed with 55 tests before implementation changes.
    - No preexisting validation failures were observed in the baseline commands.
    - Phase checkpoint commit: `44813bf`.
- Phase 1 TDD coverage map:
    - Move or add common tests first in `test/common-protocol.test.js` and `test/common-envelope.test.js` for common registration/control contracts, header serialization/protocol header parsing, error response serialization/parsing, and NDJSON encoding.
    - Keep `test/host.test.js`, `test/guest-node.test.js`, and `test/broker-routing.test.js` as adapter/integration coverage for Host/Guest/Broker behavior after imports are rewired.
    - Keep route behavior integration coverage in `test/dispatcher.test.js`, `test/agent.test.js`, and `test/end-to-end.test.js`; add common exact-hostname route selection tests only if `resolveRouteForHostname` moves to common.
    - Run moved common tests first and confirm they fail for missing common exports before implementing each helper group.
    - The first failing/relocated tests for each helper group will be added at the start of the corresponding implementation phase before common exports are implemented.
- Phase 2 validation and placement notes:
    - Added common registration/control-frame tests to `test/common-protocol.test.js`; confirmed they failed for missing common exports before implementation.
    - Delegated registration/control-frame commonization and cleanup to fixer with explicit allowed files and timeout guidance.
    - `npm run build` passed after implementation.
    - `npm run lint` initially reported session-introduced import ordering issues; imports were sorted and `npm run build && npm run lint` then passed.
    - `node --test --test-timeout=20000 test/common-protocol.test.js test/host.test.js test/guest-node.test.js test/broker-routing.test.js` passed with 48 tests after implementation.
    - Registration/control reusable helpers now live in `packages/verser-common/src/lib/registration.ts` and shared protocol types in `packages/verser-common/src/lib/types.ts`; Host and Guest Node only retain aliases/imports and transport/state-machine mechanics.
    - Coverage status: changed behavior is covered by new common tests plus existing Host/Guest/Broker integration tests; no separate coverage reporter is configured for this repository.
    - Phase checkpoint commit: `935e694`.
- Phase 3 validation and placement notes:
    - Delegated header/protocol-header implementation to fixer as one bounded task with explicit allowed files and timeout guidance.
    - TDD fail-first check: `npm run build && node --test --test-timeout=20000 test/common-protocol.test.js` failed as expected before implementation because `flattenVerserHeaders`, `parseLeaseAcquireTimeoutMs`, and `stripHttp2PseudoHeaders` common exports were missing.
    - Added common tests for header flattening, serialized header-map decoding, lease-acquire timeout parsing, and HTTP/2 pseudo-header stripping.
    - Moved reusable header helpers into `packages/verser-common/src/lib/header-serialization.ts`, `packages/verser-common/src/lib/protocol-headers.ts`, and `packages/verser-common/src/lib/http2-headers.ts`.
    - Removed the unused Host-local `host-protocol.ts` duplicate helper module after rewiring Host imports to common.
    - Deferred broad JS common header input normalization/value validation and Node-specific header adapters as documented in `docs/draft-interface-moves.md`.
    - `npm run build`, focused header/protocol tests (`60` tests), and `npm run lint` passed after implementation.
    - Coverage status: changed behavior is covered by new common tests plus existing Host/Guest/Broker integration tests; no separate coverage reporter is configured for this repository.
    - Phase checkpoint commit: `fc16bfc`.
- Phase 4 validation and placement notes:
    - Delegated error response and NDJSON extraction as one bounded fixer task; this was larger than ideal and future work should split errors and NDJSON into separate fixer tasks.
    - TDD fail-first check: `npm run build && node --test --test-timeout=20000 test/common-protocol.test.js test/common-envelope.test.js` failed as expected before implementation because `encodeJsonLine`, `verserErrorFromResponseBody`, `toVerserHttpErrorResponse`, and `toVerserErrorCode` exports were missing.
    - Added common tests for serialized HTTP error response shape, error code fallback, serialized error response parsing, and NDJSON line encoding.
    - Moved reusable error response helpers into `packages/verser-common/src/lib/error-response.ts` and pure NDJSON line encoding into `packages/verser-common/src/lib/ndjson.ts`.
    - Preserved the previous Guest unknown error-code fallback as `local-handler-failure` after reviewing the delegated implementation.
    - Deferred shared `coerceVerserError` because Host and Guest unknown-error coercion still need an explicit fallback code/context API decision.
    - `npm run build`, focused error/NDJSON tests (`64` tests), and `npm run lint` passed after implementation.
    - Coverage status: changed behavior is covered by new common tests plus existing Host/Guest/Broker integration tests; no separate coverage reporter is configured for this repository.
    - Phase checkpoint commit: `87f3ac2`.
- Phase 5 validation and placement notes:
    - Used read-only exploration to evaluate isolated non-strong candidates before implementation.
    - Implemented exact hostname route resolution in common and made JS common `VerserRoute` alias common `RoutedDomainRegistration`; validation passed with `npm run build`, route/dispatcher/agent focused tests (`24` tests), and `npm run lint`.
    - Moved `appendQueryString` from Guest Node to JS guest common because it is JS URL/query adaptation rather than core protocol common; validation passed with `npm run build`, dispatcher tests (`6` tests), and `npm run lint`.
    - Replaced duplicate Guest Node local `once` helpers with Node `events.once`; validation passed with `npm run build`, guest-node and broker-routing tests (`33` tests), and `npm run lint`.
    - Deferred broker request normalization, URL-level route resolution, broad header input types, and shared body normalization until their common API policies are explicit.
    - Kept Node HTTP shims, stream readers/writers, active lease keys, dispatch controller state, content-length parsing, and raw header-list adaptation package-local as documented in `docs/draft-interface-moves.md`.
    - Coverage status: changed behavior is covered by new common route tests plus existing Agent/Dispatcher/Guest/Broker integration tests; no separate coverage reporter is configured for this repository.
