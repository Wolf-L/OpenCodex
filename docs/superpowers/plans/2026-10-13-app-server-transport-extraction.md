# App Server transport extraction implementation plan

Approved design: [Stage 4A](../specs/2026-10-13-app-server-transport-extraction-design.md). User approved implementation with “继续”.

## Scope and execution

Keep the existing Electron/app-host/CLI chain and service ownership. No second CLI, new endpoint, dependency, account/config/session change, or performance claim. Implement this tightly coupled extraction in the current `fix/runtime-recovery` checkout; do not count unavailable agent reports as independent review.

1. **Regression tests first** — add controllable fake-child tests for deferred middleware/write callbacks across replacement, attachment validation, request/error lifecycle, and disposal. Run the old implementation and record the expected failures.
2. **Separate policies** — move the unchanged method descriptors/conflict rules to `app-server/request-order.cjs`; move private IDs, tombstones, filtering and late cleanup to `model-router/internal-sessions.cjs`.
3. **Generic core and facade** — implement per-attachment ownership, atomic stream replacement, request correlation, framing/backpressure, owned listeners and disposal in `app-server/transport.cjs`. Keep the old transport path as a composition-only facade with shared error/Symbol identity. Switch service disposal to full transport disposal.
4. **Contract verification** — add isolated generic import/roundtrip tests, exception privacy tests, health-listener preservation and normal EOF drain tests. Add all test files to the explicit package test list. Run focused suites, inspect diffs and resolve defects, then run the full suite (including build/types/boundaries).
5. **Delivery** — commit and push tested changes, verify all platform CI jobs. Back up changed installed application files, deploy/restart only verified OpenCodex processes, compare installed hashes and check Gateway/IPC/CLI/compatibility/prepare lock. Inspect the actual homepage, existing history, model menu, draft UI and connection without sending a message. Record evidence and exact remaining limitations.

## Required invariants

- IDs monotonically increase across generations; the facade retains `opencodex.router:`.
- Old work captures its original connection, is retired without replay, and cannot affect new requests/private state.
- Replacement does not synthesize a physical close callback; disposal never kills the child.
- Preserve 64-frame input pressure, output pause/drain/resume, default timeouts, method rules, 5-minute/512 private tombstones, and compatibility point IDs/count.
- Public middleware failures fall back to original frames; owned/private processing failures fail closed.
- Only owned listeners are removed. Invalid/immutable child attachment leaves streams unchanged.

## Evidence

- Initial regression run: 3 expected failures confirmed stale middleware/write forwarding and partial attachment in the old implementation (local artifact: runtime-stage4-red.log).
- Extracted method descriptors/conflict rules without changing the audited method lists. Generic transport has no router/plugin/Electron/configuration import.
- Added 21 tests covering isolated use, identity/privacy, attachment rollback, native write error races, EOF drain, disposal, async context and generation-bound cleanup. The original routing/history/health suites remain unchanged.
- Focused suites: 82 passed. Full pnpm test (including build, types and boundaries): 812 total, 801 passed, 11 skipped, 0 failed.
- Manual contract review found a native write error after retirement could be unhandled. Added a real Writable regression and a temporary native-write error guard, released on native callback/close; business work is rejected immediately. No independent-agent review is claimed.
- CI, installed-file hashes, backup and live browser evidence are recorded in the local delivery report after deployment.
