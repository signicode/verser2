# Specification: Move Shared Interface Helpers into Common

## Overview

Refactor reusable Host, Guest, Broker, and JS guest common interface helpers into `@signicode/verser-common` using `docs/draft-interface-moves.md` as the source todo list. The track should reduce duplicated protocol, header, registration, routing, error, and framing logic while preserving existing public behavior and protocol compatibility.

This is a refactor/chore track, not a product behavior expansion. The implementation should keep Host, Guest, Broker, and Peer terminology precise and keep runtime-specific adapters out of common unless only a pure, reusable lower-level helper is extracted.

## Functional Requirements

1. Use `docs/draft-interface-moves.md` as the task inventory.
2. Group strong/common candidates by function area before implementation:
   - registration and control frames;
   - protocol headers and header serialization/normalization;
   - error response and error coercion helpers;
   - NDJSON/framing helpers;
   - routing aliases and route resolution where appropriate.
3. Prefer adding exports to existing `packages/verser-common/src/lib/*` modules when they fit the current structure.
4. Create new common modules only when existing modules would become unclear or overloaded.
5. Keep non-strong candidates as isolated implementation tasks that can be reverted independently.
6. Delegate bounded refactor implementation work to `fixer` after the relevant tests, scope, and expected behavior are clear.
7. Move or adapt tests as needed when helpers move into common, but preserve test intent and test contents wherever possible.
8. Update Host, Guest Node, and Guest JS Common package imports to use the new common helpers when common helpers are introduced.
9. Keep package-specific transport helpers local when only a lower-level pure helper belongs in common.
10. Preserve existing public runtime behavior, wire protocol semantics, and generated package entrypoint expectations.

## Non-Functional Requirements

- Use TypeScript strict-mode-compatible code with no explicit `any`.
- Keep common helpers protocol-neutral and runtime-neutral where practical.
- Avoid adding HTTP/2 multiplexing, HTTP/3 behavior, authentication, authorization, routing policy, or non-TypeScript guest implementation work.
- Keep each phase reviewable and reversible.
- Follow the Conductor workflow: TDD first, narrow validation, phase checkpoints, and phase commits.

## Acceptance Criteria

- `docs/draft-interface-moves.md` items are either implemented, intentionally deferred, or marked as kept local with rationale in the track plan/notes.
- Strong candidates are grouped and implemented by functional area rather than as unrelated one-off moves.
- Non-strong candidates are implemented only as isolated, reversible tasks.
- Tests covering moved helpers exist in the appropriate package, preferably common when behavior moves to common.
- Existing test behavior is preserved; moved tests should not change assertions except for import/source-location updates required by the move.
- `npm run build` passes.
- `npm test` passes.
- `npm run lint` passes.
- No unrelated source, generated `dist`, or dependency files are committed.

## Out of Scope

- Changing runtime protocol behavior beyond preserving existing behavior through common helpers.
- Implementing future browser, Bun, Python, Rust, Go, or Java guests.
- Moving Node HTTP adapters, Undici state controllers, or Host/Guest state machines into common.
- Rewriting tests beyond source/import changes required by moving helpers.
- Completing all weak or speculative candidates if they do not clearly improve shared interfaces.
