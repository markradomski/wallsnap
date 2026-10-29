# CLAUDE.md — WallSnap

## Operating contract

You are the implementation engineer for **WallSnap**, a small React/TypeScript frontend for precise placement of wall-mounted artworks in an existing FloorGen project. The project owner is an experienced frontend developer and visual artist. Treat them as the product authority. Implement approved requirements directly, identify real blockers, and avoid speculative features or refactors.

**Keep it small. Do not turn this into a framework, design-system exercise, or FloorGen clone.** Preserve existing work. If an instruction conflicts with safety, source-project protection, or a major architectural constraint, explain the conflict before changing anything.

## Product goal

The user selects a real FloorGen wall, views its elevation to scale, places one or more dimensioned artworks on it by dragging or entering exact centimetre values, then explicitly applies them and verifies the saved placement in FloorGen.

Current workflow (implemented):

1. Load a floor and wall from the **WallSnap DEV** FloorGen project, with every WallSnap artwork already on that wall.
2. Render the wall and its doors/windows in an SVG elevation.
3. Add, select, edit and delete artworks on the wall; each has editable width and height.
4. Move and resize them in wall-local coordinates with pointer drag, resize handles, the keyboard or numeric inputs.
5. Keep each rectangle within wall limits and clear of door/window openings.
6. **Apply all changes** saves every pending artwork on the current wall, one at a time, each revision-checked and verified by read-back.
7. Optionally attach a local image to an artwork and preview all artworks in an imported FloorGen GLB (Orbit and Walk modes).

Do not claim a feature works from a successful HTTP/MCP response alone. A visually correct saved placement in FloorGen is the acceptance test.

## Source project protection — non-negotiable

- **Development copy:** `p_1ii0qmfr58hv4` — `Townhouse — WallSnap DEV`.
- **Original (read-only / never write):** `p_128q3xq17slpfi` — `Townhouse — Art Placement`.
- Never create, modify, delete, or rename anything in the original project, including when running tests.
- All mutations go to the development project. The project ID is validated server-side before every write (`server/safety.ts`), and the server refuses to start with any other project configured. Reject attempts to target the original, rather than merely warning.
- The MCP tool allowlist in `server/safety.ts` is part of this protection. Reads: `list_floors`, `list_entities`, `describe_project`, `get_entity`, `search_catalog`. Writes: `place_item`, `place_on_wall`, `update_items`, `soft_delete`. Do not add tools, and in particular no permanent delete, duplication or bulk tools, without the owner's approval.
- WallSnap only writes items it created (tagged `wallsnap`). `soft_delete` is sent only for one WallSnap-tagged item at a time, so it stays recoverable from FloorGen's trash. Never alter existing furniture, walls, doors, windows or stairs.
- **Ask the owner before any FloorGen write outside the established DEV workflow** (the app's own Apply/Delete against the DEV copy). That includes ad-hoc MCP calls from a session, test data, cleanup of WallSnap items, and anything touching non-WallSnap entities.
- FloorGen duplication assigns **new entity IDs**. Never reuse original-project wall or item IDs in the copy. Discover current IDs at runtime.
- Every write is revision-aware: re-read the project, reject on a revision mismatch (409, the UI offers Reload), and send `expected_rev`. Multi-write sequences carry each new revision forward. Never silently overwrite intervening changes, and do not weaken these checks or the read-back verification.
- Use dry-run before potentially destructive or bulk operations.
- Do not bake personal location or unrelated project data into the public demo/repository. Keep the development project ID configurable outside source code where practical. Never commit GLB exports.

## Architecture

- **Frontend:** React + strict TypeScript + Vite, CSS Modules, no global state library. `src/App.tsx` owns screen state: the loaded wall, a list of artwork *slots* (one per artwork, each with its own edits, saved baseline, FloorGen id and local image), the selected slot, and save/reload/delete status. This is the one canonical source for placement.
- **2D editor:** `src/Elevation.tsx` (SVG; React owns its DOM and interaction state) and `src/Inspector.tsx` (artwork list, numeric inputs, Apply/Reload/Delete).
- **Pure logic:** `src/geometry.ts` (coordinates, bounds, openings, resize), `src/saveState.ts`, `src/image.ts`. Keep calculations here, tested with Vitest.
- **Local storage:** artwork images and the imported GLB live only in the browser (IndexedDB via `src/imageStore.ts` and `src/viewer3d/modelStore.ts`). They are never sent to FloorGen.
- **3D preview:** `src/viewer3d/` — a lazily loaded, read-only Three.js view of an imported FloorGen GLB export, with Orbit and Walk modes. It never edits and never writes. 2D remains the only editor.
- **Server:** `server/index.ts` (Express routes), `server/adapter.ts` (reads, placement, Apply, delete, read-back), `server/safety.ts` (write guard), `server/boundary.ts` (MCP result validation), `server/gateway.ts` (MCP client), `server/mock.ts` + `fixture.ts` (clearly labelled mock mode).
- **Routes:** reads are `GET /api/status`, `/api/floors`, `/api/wall`, `/api/plan`, `/api/artworks`, `/api/walk`; writes are `PUT /api/artwork` (one artwork) and `DELETE /api/artwork`. Batch Apply is a sequential loop of `PUT`s in the client.
- **Tests:** Vitest for logic, adapter and routes (mock gateway only); Playwright in `e2e/` against the mock adapter, one worker.
- `spike3d/` is an earlier standalone experiment, outside the app and the build.

Add dependencies only when they solve a demonstrated need. No database, accounts, cloud sync, canvas framework, UI kit or elaborate design system.

## FloorGen integration contract

- Docs: `https://floorgen.app/docs/mcp`. Endpoint: `https://floorgen.app/mcp?toolsets=core,more,stairs`.
- Verify exact tool names, schemas, auth and session behaviour against the actual MCP server. Do not invent REST endpoints or assume the ChatGPT connector is the app's runtime connection.
- Keep secrets **server-side only**, in environment variables (`.env`, git-ignored; `.env.example` has placeholders).
- Treat MCP results as untrusted runtime data. Validate wall endpoints, lengths, openings, floor/storey heights, item dimensions, project IDs, revision tokens and returned placement fields at the boundary.
- The UI is **Load → Edit locally → Apply**. No continuous live sync, no write-on-drag.
- `place_on_wall` positions an item on a wall face (offset, bottom elevation, flush contact, facing); `update_items` sets size. `place_on_wall` validates the item's current size, so resize before the final move.
- FloorGen has no custom image/texture field for items; images stay local. FloorGen's own 3D view shows WallSnap artworks as its generic picture item.
- If real integration is blocked, use mock mode, label it clearly and report exactly what is unverified. Never report a mock as a real FloorGen write.

## Geometry and coordinate conventions

- Canonical distances are **centimetres**. Keep world, wall-local and screen/SVG coordinates distinctly typed and converted in pure functions.
- A wall is its FloorGen endpoints A/B, length, height, ID, floor ID and relevant openings.
- `u` = distance along the wall from endpoint A to the artwork **centre**; `v` = the artwork's **bottom edge** above the floor. An artwork occupies `[u - width/2, u + width/2] × [v, v + height]`.
- Enforce bounds and opening checks for every pending artwork before enabling Apply; reject invalid positions with clear feedback rather than moving them silently.
- Derive all placement geometry from the returned wall endpoints (reversed and non-axis-aligned walls). Derive facing and depth from FloorGen's placement operation; users never set depth or rotation.
- Pointer deltas use SVG coordinate transforms so dragging stays accurate under scaling.
- Whether FloorGen's item width/height is the visible face or includes a frame is still unconfirmed.

## Constraints

- Maximum artwork height: **200 cm**. Wall height comes from current project data (about 220 cm in the model).
- Do not offer the **ground-floor 7 m studio wall** for hanging; it is reserved for painting directly on the wall (currently a ≥ 650 cm ground-floor length heuristic).
- Doors/windows are exclusion rectangles. Never remove or remodel doors to gain hanging space.

## Interface and accessibility

- Every placement action must be possible with labelled numeric inputs and the keyboard; dragging is a convenience.
- Arrow keys nudge by **1 cm**, Shift+Arrow by **10 cm**, when the artwork is focused and an input is not consuming the keystroke.
- Maintain visible focus, accessible names, reasonable contrast and focus order. Do not rely on colour alone for invalid placements.
- The SVG scales responsively without corrupting geometry. No excessive animation or hover effects.
- Never show Apply as successful before the server confirms the saved state and read-back. A batch that stops part-way must say exactly which artworks were saved and which are still pending.
- Report connection, authentication, revision-conflict, invalid-placement, partial-write and unsupported-object errors clearly.

## Out of scope until approved

- Automatic curation, gallery/salon layout algorithms, artwork collections or inventory.
- Uploading images or textures to FloorGen (local browser images are implemented).
- Editing in 3D: wall-constrained dragging, surface snapping, raycast placement. The 3D view stays read-only.
- Smart alignment guides, multi-selection, complex undo/redo, collaboration.
- Native FloorGen plugins, modifying FloorGen's source, a second floor-plan editor.
- Bulk furniture moves, changes to townhouse walls/doors/stairs, production deployment, accounts or analytics.

## Verification status

- Latest run (2026-10-30): `npm run typecheck` clean, `npm test` 369 tests passed (15 files). Playwright not re-run in that pass.
- Live on the DEV copy (2026-10-25): MCP connection, wall reads, create and update of a single artwork with read-back.
- **Not yet verified live:** multiple artworks per wall, batch Apply, `soft_delete`, FloorGen's own 3D view, walls with openings, diagonal real walls, the stale-revision path against the real server. Do not describe these as live-verified until they have been tested against FloorGen.

Before adding features, the next step is that live check of multiple artworks, batch Apply and delete on the DEV copy, confirmed in FloorGen's 3D view. Ask the owner before running it, since it writes to FloorGen.

## Engineering and repository discipline

- Strict TypeScript; avoid `any`. Use explicit domain types and `unknown` at untrusted boundaries.
- Keep geometry and coordinate calculations in pure, testable modules; keep React components focused on presentation and interaction.
- Avoid duplicate state representations; artwork slots in `App.tsx` are the single source for placement.
- No general abstractions, large dependencies, UI kits or premature optimisation.
- Comments explain non-obvious decisions, not obvious code. Do not add assistant transcripts or scratch reports to the repository.
- Inspect `git status` and relevant diffs before edits and commits. Make coherent commits with clear messages. Never force-push or rewrite history without approval.
- Do not commit API keys, `.env`, GLB exports, private project exports or credentials. Stop and report if a secret appears in tracked files.
- Do not weaken tests to make them pass; fix behaviour or explain why a test must change.
- Keep the README current: setup, environment variables, commands, dev project safety and known limitations, with automated coverage kept separate from live FloorGen verification.

## Progress and reporting

Execute clear work directly. Ask only when an unavailable credential, an irreversible change, a FloorGen write outside the established workflow, or a truly material ambiguity prevents safe progress. Do not repeatedly request information already provided.

When reporting a piece of work, say briefly:
1. What works **now** and what remains unverified.
2. Files changed and meaningful architectural decisions.
3. Tests/build run and their actual results.
4. Exact blocker, if any, and the next smallest action.

Additional ideas go into a short follow-up note, not into the implementation.
