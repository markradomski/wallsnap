# CLAUDE.md — WallSnap

## Operating contract

You are the implementation engineer for **WallSnap**, a small React/TypeScript frontend demonstrating precise placement of wall-mounted artwork in an existing FloorGen project. The project owner is an experienced frontend developer and visual artist. Treat them as the product authority. Implement approved requirements directly, identify real blockers, and avoid speculative features or refactors.

**Ship the vertical slice quickly. Do not turn this into a framework, design-system exercise, or FloorGen clone.** Preserve existing work. If an instruction conflicts with safety, source-project protection, or a major architectural constraint, explain the conflict before changing anything.

## Product goal and definition of done

The user can select a real FloorGen wall, view its elevation to scale, position **one** dimensioned artwork by dragging or entering exact centimetre values, then explicitly apply and verify the wall-mounted item in FloorGen.

The minimum complete workflow is:

1. Load a floor and one wall from the **WallSnap DEV** FloorGen project.
2. Render the wall and openings in an SVG elevation.
3. Add or select one artwork placeholder with editable width and height.
4. Move it in wall-local coordinates using pointer drag or numeric inputs.
5. Keep its rectangle within wall limits and clear of door/window openings.
6. Click **Apply to FloorGen**; create or update a wall-mounted catalogue item.
7. Read back its saved identity, dimensions, wall, offset, elevation, and orientation; inspect the result in FloorGen's 3D view.

Do not claim completion from a successful HTTP/MCP response alone. A visually correct saved placement is the final acceptance test.

## Source project protection — non-negotiable

- **Development copy:** `p_1ii0qmfr58hv4` — `Townhouse — WallSnap DEV`.
- **Original (read-only / never write):** `p_128q3xq17slpfi` — `Townhouse — Art Placement`.
- Never create, modify, delete, or rename anything in the original project, including when running tests.
- Default all mutations to the development project; validate the project ID server-side before every write. Reject attempts to target the original, rather than merely warning.
- FloorGen duplication assigns **new entity IDs**. Never reuse original-project wall or item IDs in the copy. Discover current IDs at runtime.
- Before edits, check the project's current revision. Use revision-aware operations where available, handle conflicts explicitly, and never silently overwrite intervening changes.
- Use dry-run before potentially destructive/bulk operations. Track the IDs of WallSnap-created items to update only those; never casually alter existing furniture.
- Do not bake personal location or unrelated project data into the public demo/repository. Keep the development project ID configurable outside source code where practical.

## Approved technology

- React + strict TypeScript + Vite.
- SVG for a **single-wall 2D elevation**; React owns its DOM and interaction state.
- CSS Modules and restrained, accessible HTML controls.
- Minimal Node.js server adapter connecting to FloorGen's documented MCP server.
- Vitest for coordinate/geometry logic and Playwright for one critical browser workflow.
- Use existing dependencies if the repo already exists. Add dependencies only when they solve a demonstrated need.

No Three.js, separate 3D renderer, canvas framework, global state library, database, user accounts, cloud sync, or elaborate design system for the MVP. Do not implement a second floor-plan editor.

## FloorGen integration contract

- Docs: `https://floorgen.app/docs/mcp`.
- MCP endpoint documented for relevant toolsets: `https://floorgen.app/mcp?toolsets=core,more,stairs`.
- Verify exact tool names, schemas, auth and session behaviour against the actual MCP server. Do not invent REST endpoints or assume the ChatGPT connector is the app's runtime connection.
- Relevant documented operations include `list_entities`, `search_catalog`, `get_catalog_item`, `place_on_wall`, `update_items`, `describe_project`, and project revisions. Discover tool capabilities before relying on them.
- Keep secrets and credentials **server-side only**. Use environment variables; provide `.env.example` with placeholders and a suitable `.gitignore`.
- Treat MCP results as untrusted runtime data. Validate wall endpoints, lengths, openings, floor/storey heights, item dimensions, project IDs, revision tokens, and returned placement fields at the boundary.
- The UI uses **Load → Edit locally → Apply**. No continuous bidirectional live sync or write-on-drag.
- `place_on_wall` positions an item on a wall face with offset and bottom elevation. Confirm that the chosen catalogue item can be resized and that saved coordinates read back consistently.
- If real integration is blocked by account access or credentials, clearly label mock mode and report exactly what is unverified. Never report a mock as a real FloorGen write.

## Geometry and coordinate conventions

- Store canonical distances in **centimetres**. Keep world coordinates, wall-local coordinates and screen/SVG pixels distinctly typed and converted in pure functions.
- Represent the wall with its FloorGen endpoints A/B, length, height, ID, floor ID and relevant openings.
- Define horizontal `u` as distance along the wall from endpoint A to the **artwork centre**. Define vertical `v` as the artwork's **bottom edge above the floor**.
- Artwork occupies `[u - width/2, u + width/2]` horizontally and `[v, v + height]` vertically.
- Enforce bounds and opening intersection checks before enabling Apply; reject invalid positions with clear UI feedback rather than silently moving artwork.
- Support wall reversal/orientation by deriving all placement geometry from the returned wall endpoints. Do not assume only axis-aligned walls.
- Calculate pointer deltas using SVG coordinate transforms so dragging is accurate under scaling and responsive resizing. Keep preview updates local and immediate.
- Derive wall-facing orientation and depth from FloorGen's placement operation; do not make users adjust depth or rotation manually in the MVP.
- A FloorGen item may include a frame and depth: verify whether width/height fields represent the visible face and ensure the preview matches as closely as available catalogue functionality permits.

## Initial constraints

- Maximum artwork height: **200 cm**.
- Expected model wall height: **220 cm**; read and trust current project data over hardcoded assumptions.
- No special lighting exclusion zones are needed.
- Do not offer the **ground-floor 7 m studio wall** for hanging artwork; it is reserved for painting and drawing directly on the wall.
- Doors/windows occupy exclusion rectangles. Their swing arcs may be used for warnings later; never remove or remodel doors to gain hanging space.
- Start with one real wall and one artwork placeholder, not an inventory or automatic curator.

## MVP interface and accessibility

One compact screen: floor/wall selection, real wall dimensions, SVG elevation, one draggable artwork rectangle, and numeric controls for artwork width, height, horizontal centre (`u`), and bottom elevation (`v`). Display current position and validation errors in centimetres.

- Pointer dragging is a convenience; all placement actions must be possible using labelled numeric inputs and the keyboard.
- Arrow keys nudge by **1 cm**; Shift+Arrow nudges by **10 cm**, when the artwork is selected and an input field is not consuming the keystroke.
- Maintain visible focus, accessible names/instructions, reasonable contrast and focus order. Do not rely on colour alone for invalid placements.
- Ensure the SVG editor scales responsively without corrupting geometry. No excessive animation or unnecessary hover effects.
- Never show Apply as successful before the server confirms the saved state and read-back verification.
- Report connection, authentication, revision-conflict, invalid-placement and unsupported-object errors clearly.

## Explicitly out of scope until approved

- Automatic artwork curation, gallery/salon layout algorithms, multiple artwork collections.
- Uploading artwork images or custom textures.
- Continuous 3D wall-constrained dragging, surface snapping between walls, raycasting.
- Smart alignment guides, multi-selection, complex undo/redo or simultaneous collaboration.
- Native FloorGen editor plugins, modifying FloorGen's source, building a new 3D model/viewer.
- Bulk furniture moves, changes to townhouse walls/doors/stairs, production deployment, accounts or analytics.

A persistent wall attachment during 3D dragging is a **nice-to-have**, not an MVP blocker.

## Implementation order and gates

### Gate 0 — Prove one real FloorGen write

Inspect repository and docs. Connect independently via MCP. Fetch a wall from the **DEV** project, select a suitable supported catalogue artwork, use `place_on_wall`, read the item back, and verify its actual location in the FloorGen editor/3D view. Confirm resize support before proceeding.

If the connection is blocked, isolate it behind a typed mock adapter while clearly recording the blocker; do not disguise mock output as live integration.

### Gate 1 — Pure geometry

Implement typed conversions, bounds, opening collisions and editable artwork dimensions; add Vitest tests for reversed walls, corners, exactly-on-boundary placements, invalid dimensions and coordinate round-tripping.

### Gate 2 — React/SVG editor

Implement wall selection, SVG elevation, pointer drag, numeric controls, keyboard nudging, and visible validation. One wall, one artwork.

### Gate 3 — Read/edit/apply

Load current FloorGen state; explicitly apply the artwork using its wall ID, `u` offset and `v` elevation. Reuse the existing item ID when updating. Respect revisions and validate the actual persisted result. No writes during pointer move.

### Gate 4 — Demo verification

Run typecheck, tests and production build. Run one Playwright workflow and a real FloorGen 3D verification. Document what was tested and any unverified limitations. Record a brief walkthrough only when the workflow actually works.

Do not start the next gate because the code merely compiles; meet the gate's acceptance criterion first.

## Engineering and repository discipline

- Strict TypeScript; avoid `any`. Use explicit domain types and `unknown` at untrusted boundaries.
- Keep geometry and coordinate calculations in pure, testable modules; keep React components focused on presentation and interactions.
- Avoid duplicate state representations; preserve one canonical source for artwork placement.
- Don't introduce general abstractions, large dependencies, UI kits or premature performance optimisations.
- Comments should explain non-obvious decisions, not narrate obvious code. Do not add assistant transcripts or scratch reports to the repository.
- Inspect `git status` and relevant diffs before edits and commits. Make coherent commits with clear messages. Never force-push or rewrite history without approval.
- Do not commit API keys, `.env`, private project exports or credentials. Stop and report if a secret appears in tracked files.
- Do not weaken tests to make them pass; fix behaviour or explain why a test must change.
- Provide a concise README with setup, environment variables, local run/test commands, dev project safety constraints and known limitations.

## Progress and reporting

Execute clear work directly. Ask only when an unavailable credential, irreversible change, or truly material ambiguity prevents safe progress. Do not repeatedly request information already provided.

At each completed gate, report briefly:
1. What works **now** and what remains unverified.
2. Files changed and meaningful architectural decisions.
3. Tests/build run and their actual results.
4. Exact blocker, if any, and the next smallest action.

**Stop at the agreed MVP.** Additional ideas go into a short follow-up note, not into the implementation.
