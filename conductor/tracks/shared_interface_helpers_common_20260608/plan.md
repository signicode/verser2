# Implementation Plan: Move Shared Interface Helpers into Common

## Phase 1: Inventory, grouping, and test baseline

- [ ] Task: Review common library and draft move inventory
    - [ ] Read `docs/draft-interface-moves.md` and group items by functional area.
    - [ ] Review existing `packages/verser-common/src/lib/*` exports before adding new package-local or common code.
    - [ ] Identify which existing modules should receive new exports and which areas justify new modules.
    - [ ] Record deferred or kept-local candidates in this plan before implementation begins.
- [ ] Task: Establish current validation baseline
    - [ ] Run the narrowest relevant existing tests for common, host, guest-node, and guest-js-common behavior if available.
    - [ ] Run `npm run build` to confirm the starting build state.
    - [ ] Record any preexisting validation failures before making implementation changes.
- [ ] Task: Prepare TDD coverage map
    - [ ] Locate tests covering registration, headers, errors, NDJSON/control frames, and routing behavior.
    - [ ] Decide which tests should move to common with unchanged assertions and which package tests should remain adapter-level.
    - [ ] Add failing or relocated tests first for helpers that will move into common.
- [ ] Task: Conductor - User Manual Verification 'Phase 1: Inventory, grouping, and test baseline' (Protocol in workflow.md)

## Phase 2: Registration and route/control protocol moves

- [ ] Task: Write or move registration/control-frame tests first
    - [ ] Add or relocate tests for peer role, registration request parsing, registration response shape/parsing, and broker route-control frames.
    - [ ] Preserve test assertions where tests are moved; change only imports/source locations when possible.
    - [ ] Confirm the tests fail for missing common exports before implementation.
- [ ] Task: Move registration/control-frame contracts into common
    - [ ] Move `VerserPeerRole` into common.
    - [ ] Move and rename `VerserHostRegistrationRequest` to `VerserRegistrationRequest` in common.
    - [ ] Move `parseRegistrationRequest` into common, strengthening validation only where compatible with current behavior.
    - [ ] Move registration response and broker control frame protocol types into common.
- [ ] Task: Update package usage
    - [ ] Update Host and Guest package imports to use common registration/control-frame contracts.
    - [ ] Keep Host/Guest transport mechanics and state machines package-local.
    - [ ] Run focused tests and build for affected packages.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Registration and route/control protocol moves' (Protocol in workflow.md)

## Phase 3: Header and protocol-header commonization

- [ ] Task: Write or move header tests first
    - [ ] Add or relocate tests for header flattening, header map decoding, lease acquire timeout parsing, HTTP/2 pseudo-header stripping, and runtime-neutral header normalization.
    - [ ] Preserve existing test contents where tests move; change imports/source locations only as needed.
    - [ ] Confirm new common tests fail before implementation.
- [ ] Task: Combine common header abstractions
    - [ ] Combine Host `flattenValidatedHeaders` and Guest `flattenHeaders` into a common `flattenVerserHeaders` helper.
    - [ ] Move `decodeHeaderMap` into common and add a paired encoder only if current call sites need it.
    - [ ] Extract lease acquire timeout parsing and protocol header constants into common when appropriate.
    - [ ] Combine JS common `flattenHeaderValue`, `normalizeHeaders`, header-name validation, and header-value validation with existing common header helpers.
    - [ ] Extract `normalHeaders` into a clearly named HTTP/2 helper such as `stripHttp2PseudoHeaders` if reuse is confirmed.
- [ ] Task: Update package usage
    - [ ] Update Host, Guest Node, and Guest JS Common imports to use shared header helpers.
    - [ ] Keep Node `OutgoingHttpHeaders`, Undici raw header list, and JS URL adaptation local unless only a pure helper is extracted.
    - [ ] Run focused header tests and build for affected packages.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Header and protocol-header commonization' (Protocol in workflow.md)

## Phase 4: Error response, coercion, and NDJSON extraction

- [ ] Task: Write or move error and NDJSON tests first
    - [ ] Add or relocate tests for serialized HTTP error response shape, error response parsing, error code coercion, unknown-error coercion, and NDJSON line encoding.
    - [ ] Preserve assertions where tests move from Host or Guest packages to common.
    - [ ] Confirm new common tests fail before implementation.
- [ ] Task: Move error response helpers into common
    - [ ] Move and rename `ErrorResponse` to a common serialized error response type.
    - [ ] Move `toErrorResponse` into common as the shared serialization helper.
    - [ ] Move or extract `errorFromBody` into common as the matching parser.
    - [ ] Move `toVerserErrorCode` into common near `VerserErrorCode`.
    - [ ] Export or adapt common `getErrorMessage` and combine Host/Guest `toVerserError` variants behind a shared helper if compatible.
- [ ] Task: Extract NDJSON serialization
    - [ ] Extract the pure serialization part of `writeJsonLine` into common, such as `encodeJsonLine`.
    - [ ] Keep HTTP/2 stream response behavior local to Host.
    - [ ] Ensure `sendError` uses common error serialization while retaining Host-local send mechanics.
- [ ] Task: Update package usage and validate
    - [ ] Update Host and Guest imports to use common error and NDJSON helpers.
    - [ ] Run focused error/NDJSON tests and build for affected packages.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Error response, coercion, and NDJSON extraction' (Protocol in workflow.md)

## Phase 5: Isolated non-strong candidates and final validation

- [ ] Task: Evaluate non-strong candidates as isolated reversible tasks
    - [ ] Consider route alias/resolution moves, broker request normalization, body guards, content-length parsing, and query string utilities independently.
    - [ ] Implement only candidates that clearly improve shared interfaces without pulling runtime-specific adapters into common.
    - [ ] Leave package-specific transport, Undici, Node HTTP shim, and state-machine helpers local or inline as documented.
- [ ] Task: Delegate bounded refactors to fixer where useful
    - [ ] Provide each delegated fixer task with the specific candidate group, expected tests, allowed files, and validation command.
    - [ ] Review delegated changes before marking tasks complete.
    - [ ] Record delegated findings and any intentionally deferred candidates in the plan notes.
- [ ] Task: Final deduplication and documentation pass
    - [ ] Re-scan affected Host, Guest Node, Guest JS Common, and Common modules for remaining duplicated helpers.
    - [ ] Update package exports and documentation comments where public API changed.
    - [ ] Ensure `docs/draft-interface-moves.md` is reflected by implemented, deferred, or kept-local decisions.
- [ ] Task: Final validation
    - [ ] Run `npm run build`.
    - [ ] Run `npm test`.
    - [ ] Run `npm run lint`.
    - [ ] Record coverage status or why coverage could not be measured separately.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Isolated non-strong candidates and final validation' (Protocol in workflow.md)

## Notes

- Phase commits should be created only after phase completion verification.
- Tests moved into common should preserve behavior and assertions; import/source changes are allowed when required by the move.
- Runtime-specific adapters should stay local unless a pure lower-level helper is extracted.
