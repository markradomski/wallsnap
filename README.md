# WallSnap

Precise placement of wall-mounted artworks in a FloorGen project. React + strict TypeScript + Vite, an SVG wall-elevation editor, an optional Three.js preview of an imported FloorGen 3D export, and a small Node adapter that talks to the FloorGen MCP server.

Flow: **load a wall from FloorGen → edit locally (drag, handles, arrow keys, typed centimetres) → Apply all changes → read back and verify.** Nothing is written while you drag or type.

## Setup

```bash
npm install
cp .env.example .env     # then fill in FLOORGEN_API_KEY
npm run dev              # API on :8787 (WALLSNAP_API_PORT), web on http://localhost:5173
```

### Environment variables (`.env`, git-ignored)

| Variable | Purpose |
| --- | --- |
| `FLOORGEN_API_KEY` | FloorGen API key (`fg_live_…`, *Read & edit*). Server-side only; never sent to the browser. |
| `FLOORGEN_PROJECT_ID` | Must be the development copy `p_1ii0qmfr58hv4`. The server refuses to start with anything else. |
| `FLOORGEN_MCP_URL` | Defaults to `https://floorgen.app/mcp?toolsets=core,more,stairs`. |
| `WALLSNAP_ADAPTER` | `floorgen` (default) or `mock`. |
| `WALLSNAP_API_PORT` | API port, default `8787`. |

Create the key in FloorGen under **Agents & MCP** with *Read & edit* access to the development copy.

No key yet? `WALLSNAP_ADAPTER=mock npm run dev` runs against in-memory synthetic geometry and the UI shows a yellow **MOCK ADAPTER** banner. Mock mode is not a FloorGen integration.

## Commands

```bash
npm run dev         # API + web together (concurrently)
npm run typecheck   # tsc --noEmit
npm test            # Vitest unit tests
npm run e2e         # Playwright browser tests (starts its own mock API + Vite; one worker)
npm run build       # typecheck + production build
```

## Testing and verification status

Automated tests and live FloorGen verification are separate, and only the second touches FloorGen.

**Automated (no FloorGen access):**

- **Vitest** (`npm test`): geometry and coordinate conversions, opening collisions, resize, image validation and storage, save states, the MCP boundary validation, the write guard, the adapter and HTTP routes against a mock gateway, 3D placement transforms, model checks, stand-in matching and walk collision. Latest run (2026-10-30): typecheck clean, **369 tests passed** in 15 files.
- **Playwright** (`npm run e2e`): drag, numeric edits, keyboard nudging, validation, openings, resize handles, images, reload, multiple artworks, batch Apply, delete, the 3D preview and Walk mode. It runs only against the mock adapter and a synthetic GLB; it does not verify FloorGen. Not re-run in the latest documentation pass.

**Live FloorGen (development copy only):**

- Verified on 2026-10-25: authenticated MCP connection, reading real walls, and `place_on_wall` + `update_items` to create an artwork (south wall, rotation 180) and update one (north wall), with read-back. Cross-checked through a separate FloorGen connection and the 2D render.
- The 3D preview was checked in a browser with the real townhouse GLB export.
- **Not yet verified live:** multiple artworks per wall, batch Apply, delete (`soft_delete`), FloorGen's own 3D view of the result, walls with openings, diagonal real walls, and the stale-revision path against the real server.

## The editor

One screen: a top bar (floor and wall pickers, save status, 2D/3D switch, theme), the wall elevation in the middle, and an inspector on the right (it stacks under the editor on narrow screens).

### 2D elevation

- The SVG draws the selected wall to scale, endpoint **A** on the left and **B** on the right whatever direction FloorGen stores the wall in, with its doors and windows drawn and labelled.
- Drag an artwork to move it, or use its eight resize handles. Dragging uses SVG coordinate transforms, so it stays accurate when the editor scales.
- Every action also works without a pointer: the inspector has labelled inputs for width, height, horizontal position (`u`) and bottom elevation (`v`). With the artwork focused, the arrow keys move it 1 cm and Shift+arrow 10 cm.
- Themes are **System** (default, follows the OS), **Light** and **Dark**. An explicit choice is kept in `localStorage` (`wallsnap.theme`).

### Validation

Apply stays disabled until every pending artwork passes, and each problem is shown in centimetres. Invalid positions are rejected, never moved silently.

- Height at most 200 cm, and a positive width and height.
- Inside the wall: `[u − w/2, u + w/2]` within the wall length and `[v, v + h]` within the wall height read from FloorGen.
- No overlap with a door or window. Overlaps are hatched in the elevation as well as described in text, so colour is never the only signal.
- Ground-floor walls 650 cm or longer count as the reserved studio wall and are not offered (a length heuristic).

### Multiple artworks on a wall

- Opening a wall loads every WallSnap artwork lying flush on it. The inspector lists them with a thumbnail and a status: *Not saved yet*, *Unsaved changes*, *Saved*, *Not on this wall* or *Fix before applying* (with the reasons).
- **+ Add artwork** adds another at a default 60 × 45 cm near the middle of the wall, offset so it does not hide the previous one. A new one is always created as a new FloorGen object, never merged into one already on the wall.
- Select an artwork in the list or the elevation to edit it. Each artwork keeps its own edits, so switching between them loses nothing.
- Unsaved work on a wall is kept in this session while you look at another wall.
- **Delete** discards a never-saved artwork locally. For a saved one it asks first, then moves the item to FloorGen's trash with `soft_delete` (recoverable there with FloorGen's *restore trash*). Only items tagged `wallsnap` can be deleted, only at the revision you loaded, and success is reported only once a read-back shows the item is gone.

### Apply all changes

The button (**Apply all changes**, with a count when more than one is pending) saves every pending artwork on the current wall:

1. Every pending artwork is validated first. If any fails, nothing is sent and the blocking artworks are named.
2. They are saved **one after another, never in parallel**. Each write carries the revision the previous one produced.
3. For each one the server re-reads the project, rejects it with 409 if the revision differs from the expected one, validates, writes with `expected_rev`, and reads it back. It reports success only if width, height, `u` and `v` match within 0.1 cm and the item is flush within 0.5 cm.
4. Each artwork is marked saved, with its FloorGen id, as soon as it is verified. If a later one fails, the saved ones stay saved (and are never created twice), the rest stay pending, and the message says which is which. A revision conflict offers *Reload*.

How one artwork is written: `place_on_wall` sets flush contact and facing; `update_items` sets the size. `place_on_wall` validates the item's *current* size, so an existing item is resized first and moved last. A new one starts as a catalogue `picture-large` hung where it fits, is tagged `wallsnap`, resized, then moved to the exact `u`/`v` (up to three writes). FloorGen's error `code`, `message` and `hint` are shown in the UI.

The save status is one of: not saved yet, unsaved changes, saving, saved · verified (only after read-back, and only until the next edit), loaded from FloorGen, revision conflict, partially saved, save failed, or fix validation errors. If any artwork on the wall is pending, the wall shows *unsaved changes* even when the selected one is saved.

### Reload from FloorGen

**Reload from FloorGen** re-reads the wall and the selected artwork by its persistent FloorGen item id, refreshing the elevation, the inputs and the known revision together. It is manual (no polling) and read-only.

- It discards local edits to **every** artwork on the wall, so it asks first when there are any (*Keep editing* is the default; Escape cancels).
- **Off the wall:** FloorGen has no permanent wall attachment, so an item counts as on this wall only if it is flush with the wall plane (within 2 cm), faces the room (within 2°) and lies along the wall. Otherwise WallSnap says *Artwork is no longer positioned on this wall* with the reason, draws nothing and invents no coordinates. *Place back on this wall* drafts it with its own size, and Apply moves that same FloorGen object by id.
- A deleted artwork, missing wall or failed fetch is reported as an error; nothing stale is loaded and local edits stay as they were.
- The wall is read in several calls that must all report the same revision; it is re-read if the revision changed part-way, otherwise reported as stale.

## Coordinates

- `u` (*Horizontal position*): distance from wall **endpoint A** to the artwork **centre**, in cm.
- `v` (*Bottom elevation*): the artwork's **bottom edge** above the floor, in cm.
- FloorGen item `x,y` is the item centre, `elevation` its underside and `rotation` degrees clockwise. The adapter converts `u` to a plan point along A→B, pushes it out by `wall thickness/2 + item depth/2` towards the room so the picture sits flush, and sets the rotation to face the room. All of this comes from the returned wall endpoints, so reversed and non-axis-aligned walls work the same way.

## Artwork images (local only)

Choose a JPEG, PNG or WebP (up to 15 MB and 12,000 px per side) in the inspector's **Artwork image** section to see a real picture instead of a plain rectangle.

- **Stored only in this browser (IndexedDB).** FloorGen receives only the artwork's size and position; custom images never appear in FloorGen. FloorGen has no documented image or texture field for items (`update_items.appearance` takes only per-part colours and named materials).
- The file's real content is checked, not its name, so renamed files, GIF and SVG are refused. A refused file never changes the current image or frame.
- A first image gets a 60 cm wide frame at the image's aspect ratio (shrunk to fit 200 cm or the wall). An artwork already saved or edited keeps its width and takes its height from the image, as an ordinary unsaved edit.
- **Lock proportions** (on by default with an image) keeps the frame's ratio while resizing. Untick it to resize freely; the image is then shown whole inside the frame, and **Match image proportions** restores the ratio.
- Images are keyed by project and FloorGen item id (`<project>/item/<id>`). Before the first save an image is a draft for that wall and is re-keyed when Apply saves the artwork. Deleting an artwork removes its image. Missing or blocked storage falls back to "no image" with a message and never blocks editing or Apply.

## 3D preview (imported GLB)

The **2D / 3D** switch shows your artworks, with their images, in the furnished townhouse. 3D is read-only: it shows the current local state (a badge says whether that is unsaved or saved), and entering, orbiting, walking or switching back writes nothing.

- **Model:** FloorGen's 3D export is a snapshot. *Import 3D model…* loads a local `.glb` (up to 100 MB). It is validated (must parse as glTF, contain a floor group with walls, and be a plausibly sized building in metres) and kept in IndexedDB so it survives reloads. *Replace 3D model…* swaps it in one step without touching images, ids, edits or the selected wall. After changing the building in FloorGen, export again and replace; there is no automatic export. `*.glb` is git-ignored.
- **Placement** is computed from the same wall endpoints, thickness and storey heights the server reads (`GET /api/plan`, read-only), so it matches what Apply saves, slanted walls included.
- **All saved artworks** in the project are shown (`GET /api/artworks`, read-only), as well as every artwork on the current wall.
- **Generic stand-ins:** FloorGen exports a saved artwork as a plain block. When the model contains one it is matched by geometry and hidden behind the image; if the match is ambiguous nothing is hidden and a note says so.
- **Floors:** upper floors are hidden by default so the selected floor is visible; *Show upper floors* restores the whole building.
- Three.js loads only when you enter 3D. Without WebGL, 3D shows an explanation and 2D keeps working.

### Orbit and Walk modes

**Orbit** (default) is a drag-to-orbit, scroll-to-zoom camera.

**Walk** puts you in the selected room at eye level (160 cm, 70° field of view), 2.5 m in front of the artwork and facing it. W/S move, A/D strafe, Shift is faster, the mouse looks (click to capture, Esc releases), and the arrow keys move and turn, so it also works without mouse capture. *Exit Walk* or *Orbit* restores the orbit camera exactly as it was. Walk only moves the camera.

Collision is a 25 cm circle among plan rectangles (`src/viewer3d/walkGeometry.ts`, `walkMove.ts`), built from FloorGen data read through `GET /api/walk?floor=…` (read-only):

- **Walls:** real endpoints and thickness. Interior doorways (no sill, 170 cm or more clear) are gaps; windows, high sills, low lintels and exterior doors are solid.
- **Furniture:** each item's own footprint. Items hung 90 cm or higher, rugs and WallSnap artworks do not block.
- **Stairs:** no climbing. A stair on this floor is an obstacle; a stair from below that cuts the slab is a hole.
- Movement is split into small steps and pushed out along the contact normal, so you slide along walls and cannot pass through thin ones. Speed does not depend on frame rate.

### FloorGen's own 3D viewer

The inspector links to **Open in FloorGen 3D** for the development project. There, WallSnap artworks appear as FloorGen's generic picture item (a plain block in its catalogue colour), because FloorGen has no custom image field. WallSnap's preview is a placement preview built from FloorGen's data and export, not FloorGen's renderer.

## Safety rules

- **Only `p_1ii0qmfr58hv4` (Townhouse — WallSnap DEV) is writable.** `server/safety.ts` wraps the MCP transport and checks the project ID on **every** write call before it is sent, refusing any other ID, including the original `p_128q3xq17slpfi`.
- Only these tools can be sent. Reads: `list_floors`, `list_entities`, `describe_project`, `get_entity`, `search_catalog`. Writes: `place_item`, `place_on_wall`, `update_items`, `soft_delete`. Anything else (for example `duplicate_project` or a permanent delete) is refused.
- The adapter sends `soft_delete` only for a single item tagged `wallsnap`, and only at the revision the user loaded.
- The server refuses to start if `FLOORGEN_PROJECT_ID` is anything other than the development copy.
- Every write carries `expected_rev`; Apply and Delete re-read the project first and return 409 on a revision mismatch rather than overwriting.
- Data returned by MCP is validated at the boundary (`server/boundary.ts`) before use.

## Known limitations

- Images and the imported GLB live in one browser profile: not shared between browsers or devices, lost if site data is cleared. A draft image for a wall that is never saved stays in that browser's storage.
- Apply all changes covers the current wall only. Unsaved artworks on other walls are kept for the session but must be applied from their own wall.
- An artwork moved off its wall *before* the wall was opened in WallSnap cannot be traced back to that wall, so it does not appear there. Reload checks the selected artwork by id.
- An artwork that still hangs on the wall but has an out-of-range size or elevation is shown with its real numbers and the usual validation errors.
- The reserved-wall rule is a length heuristic. Lighting is not checked. Walls bounding no room are not offered; for a wall shared by two rooms the first room's face is used.
- Whether FloorGen's item width/height is the visible picture face or includes a frame is unconfirmed.
- 3D: the model is only as current as its export. Matching the stand-in relies on FloorGen's generic artwork colour. There is no 3D dragging.
- Walk: FloorGen does not report whether a door is open, so every interior doorway is treated as open. Stair footprints are conservative rectangles, so on the DEV first floor the only interior door (to the stairwell) cannot be passed. Fixed eye height, no stairs, gravity or jumping. Headless Chromium and the in-app browser refuse mouse capture, so real capture has not been verified.

## Layout

| Path | Contents |
| --- | --- |
| `src/geometry.ts` | Pure geometry: wall frames, `u`/`v` conversions, bounds, opening collisions, resize (tested) |
| `src/App.tsx` | Screen state: walls, artwork slots, batch Apply, delete, reload |
| `src/Elevation.tsx` | SVG editor (drag, handles, keyboard) |
| `src/Inspector.tsx`, `src/TopBar.tsx` | Controls, artwork list, status |
| `src/saveState.ts`, `src/image.ts`, `src/imageStore.ts` | Save-state derivation, image validation, IndexedDB storage |
| `src/viewer3d/` | Lazy Three.js preview: GLB checks and storage, placement transforms, stand-in matching, Walk mode |
| `server/index.ts` | Express API and startup project check |
| `server/adapter.ts` | Reading walls and artworks, placement, Apply, delete, read-back |
| `server/safety.ts` | Write guard and tool allowlist |
| `server/boundary.ts` | Validation of MCP results |
| `server/gateway.ts` | MCP client |
| `server/mock.ts`, `server/fixture.ts` | Mock gateway with synthetic geometry |
| `e2e/` | Playwright tests (mock adapter only) |
| `spike3d/` | Earlier standalone 3D feasibility spike; not part of the app or the build (see its README) |
