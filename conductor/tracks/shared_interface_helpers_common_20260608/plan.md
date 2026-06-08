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
    - [ ] Fixer guidance: delegate this task only after listing the exact tests to move or add and requiring unchanged assertions except import/source updates.
    - [ ] Add or relocate tests for peer role, registration request parsing, registration response shape/parsing, and broker route-control frames.
    - [ ] Preserve test assertions where tests are moved; change only imports/source locations when possible.
    - [ ] Confirm the tests fail for missing common exports before implementation.
- [ ] Task: Move registration/control-frame contracts into common
    - [ ] Fixer guidance: delegate as one bounded refactor after tests fail, limited to common registration/control-frame exports and corresponding Host/Guest import updates.
    - [ ] Move `VerserPeerRole` into common.
    - [ ] Move and rename `VerserHostRegistrationRequest` to `VerserRegistrationRequest` in common.
    - [ ] Move `parseRegistrationRequest` into common, strengthening validation only where compatible with current behavior.
    - [ ] Move registration response and broker control frame protocol types into common.
- [ ] Task: Update package usage
    - [ ] Fixer guidance: delegate only with explicit allowed files and focused validation commands for the registration/control-frame area.
    - [ ] Update Host and Guest package imports to use common registration/control-frame contracts.
    - [ ] Keep Host/Guest transport mechanics and state machines package-local.
    - [ ] Run focused tests and build for affected packages.
- [ ] Task: Record phase decisions and helper placement check
    - [ ] Mark completed, deferred, or kept-local registration/control-frame items in `docs/draft-interface-moves.md`.
    - [ ] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable registration/control helpers that should have gone to common.
    - [ ] Record the helper placement result before phase checkpointing.
- [ ] Task: Conductor - User Manual Verification 'Phase 2: Registration and route/control protocol moves' (Protocol in workflow.md)

## Phase 3: Header and protocol-header commonization

- [ ] Task: Write or move header tests first
    - [ ] Fixer guidance: delegate test movement only with a list of exact source tests and the requirement that assertions remain unchanged except import/source updates.
    - [ ] Add or relocate tests for header flattening, header map decoding, lease acquire timeout parsing, HTTP/2 pseudo-header stripping, and runtime-neutral header normalization.
    - [ ] Preserve existing test contents where tests move; change imports/source locations only as needed.
    - [ ] Confirm new common tests fail before implementation.
- [ ] Task: Combine common header abstractions
    - [ ] Fixer guidance: delegate by sub-area when possible, for example header serialization separately from runtime-neutral header normalization, so each change can be reviewed and reverted independently.
    - [ ] Combine Host `flattenValidatedHeaders` and Guest `flattenHeaders` into a common `flattenVerserHeaders` helper.
    - [ ] Move `decodeHeaderMap` into common and add a paired encoder only if current call sites need it.
    - [ ] Extract lease acquire timeout parsing and protocol header constants into common when appropriate.
    - [ ] Combine JS common `flattenHeaderValue`, `normalizeHeaders`, header-name validation, and header-value validation with existing common header helpers.
    - [ ] Extract `normalHeaders` into a clearly named HTTP/2 helper such as `stripHttp2PseudoHeaders` if reuse is confirmed.
- [ ] Task: Update package usage
    - [ ] Fixer guidance: delegate import rewiring only after common helper names and exports are fixed, and include focused header validation commands.
    - [ ] Update Host, Guest Node, and Guest JS Common imports to use shared header helpers.
    - [ ] Keep Node `OutgoingHttpHeaders`, Undici raw header list, and JS URL adaptation local unless only a pure helper is extracted.
    - [ ] Run focused header tests and build for affected packages.
- [ ] Task: Record phase decisions and helper placement check
    - [ ] Mark completed, deferred, or kept-local header/protocol-header items in `docs/draft-interface-moves.md`.
    - [ ] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable header helpers that should have gone to common.
    - [ ] Record the helper placement result before phase checkpointing.
- [ ] Task: Conductor - User Manual Verification 'Phase 3: Header and protocol-header commonization' (Protocol in workflow.md)

## Phase 4: Error response, coercion, and NDJSON extraction

- [ ] Task: Write or move error and NDJSON tests first
    - [ ] Fixer guidance: delegate only after identifying exact Host/Guest tests to move or add and requiring unchanged assertions except import/source updates.
    - [ ] Add or relocate tests for serialized HTTP error response shape, error response parsing, error code coercion, unknown-error coercion, and NDJSON line encoding.
    - [ ] Preserve assertions where tests move from Host or Guest packages to common.
    - [ ] Confirm new common tests fail before implementation.
- [ ] Task: Move error response helpers into common
    - [ ] Fixer guidance: delegate as a bounded error-response refactor with explicit source helpers, destination exports, and package import updates.
    - [ ] Move and rename `ErrorResponse` to a common serialized error response type.
    - [ ] Move `toErrorResponse` into common as the shared serialization helper.
    - [ ] Move or extract `errorFromBody` into common as the matching parser.
    - [ ] Move `toVerserErrorCode` into common near `VerserErrorCode`.
    - [ ] Export or adapt common `getErrorMessage` and combine Host/Guest `toVerserError` variants behind a shared helper if compatible.
- [ ] Task: Extract NDJSON serialization
    - [ ] Fixer guidance: delegate only the pure serialization extraction and import rewiring; keep HTTP/2 response behavior out of the delegated common change.
    - [ ] Extract the pure serialization part of `writeJsonLine` into common, such as `encodeJsonLine`.
    - [ ] Keep HTTP/2 stream response behavior local to Host.
    - [ ] Ensure `sendError` uses common error serialization while retaining Host-local send mechanics.
- [ ] Task: Update package usage and validate
    - [ ] Fixer guidance: delegate validation assistance only with the focused error/NDJSON test commands and expected successful build scope.
    - [ ] Update Host and Guest imports to use common error and NDJSON helpers.
    - [ ] Run focused error/NDJSON tests and build for affected packages.
- [ ] Task: Record phase decisions and helper placement check
    - [ ] Mark completed, deferred, or kept-local error/NDJSON items in `docs/draft-interface-moves.md`.
    - [ ] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable error or NDJSON helpers that should have gone to common.
    - [ ] Record the helper placement result before phase checkpointing.
- [ ] Task: Conductor - User Manual Verification 'Phase 4: Error response, coercion, and NDJSON extraction' (Protocol in workflow.md)

## Phase 5: Isolated non-strong candidates

- [ ] Task: Evaluate non-strong candidates as isolated reversible tasks
    - [ ] Fixer guidance: delegate each non-strong candidate independently with one candidate group, allowed files, and rollback expectations per delegated task.
    - [ ] Consider route alias/resolution moves, broker request normalization, body guards, content-length parsing, and query string utilities independently.
    - [ ] Implement only candidates that clearly improve shared interfaces without pulling runtime-specific adapters into common.
    - [ ] Leave package-specific transport, Undici, Node HTTP shim, and state-machine helpers local or inline as documented.
- [ ] Task: Delegate bounded refactors to fixer where useful
    - [ ] Fixer guidance: use fixer for scoped implementation or test moves only after candidate scope, expected behavior, allowed files, and validation commands are written down.
    - [ ] Provide each delegated fixer task with the specific candidate group, expected tests, allowed files, and validation command.
    - [ ] Review delegated changes before marking tasks complete.
    - [ ] Record delegated findings and any intentionally deferred candidates in the plan notes.
- [ ] Task: Record phase decisions and helper placement check
    - [ ] Mark completed, deferred, or kept-local non-strong candidate items in `docs/draft-interface-moves.md`.
    - [ ] Check `packages/verser2-guest-node/` and `packages/verser2-host/` for newly introduced reusable helpers that should have gone to common.
    - [ ] Record the helper placement result before phase checkpointing.
- [ ] Task: Phase deduplication and documentation pass
    - [ ] Fixer guidance: delegate only read-only search support or tightly scoped documentation/export updates; keep final decisions with the orchestrator.
    - [ ] Re-scan affected Host, Guest Node, Guest JS Common, and Common modules for remaining duplicated helpers.
    - [ ] Update package exports and documentation comments where public API changed.
    - [ ] Ensure `docs/draft-interface-moves.md` is reflected by implemented, deferred, or kept-local decisions.
- [ ] Task: Conductor - User Manual Verification 'Phase 5: Isolated non-strong candidates' (Protocol in workflow.md)

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
