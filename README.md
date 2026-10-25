# WallSnap

Precise placement of one wall-mounted artwork in a FloorGen project. React + TypeScript + Vite, SVG elevation editor, small Node adapter that talks to the FloorGen MCP server.

Flow: **load wall from FloorGen → edit locally (drag, arrows, numbers) → Apply → read back and verify.**

## Setup

```bash
npm install
cp .env.example .env     # then fill in FLOORGEN_API_KEY
npm run dev              # API on :8787 (WALLSNAP_API_PORT), web on http://localhost:5173
```

### Credentials

1. In FloorGen, open **Agents & MCP** and create an API key (`fg_live_…`) with *Read & edit* access to the development copy.
2. Put it in `.env` as `FLOORGEN_API_KEY`. `.env` is git-ignored; the key stays on the server and is never sent to the browser.
3. `FLOORGEN_PROJECT_ID` must be the development copy `p_1ii0qmfr58hv4` (see Safety rules); the server refuses to start with anything else.

No key yet? `WALLSNAP_ADAPTER=mock npm run dev` runs against in-memory synthetic geometry. The UI shows a yellow **MOCK ADAPTER** banner. This is not a FloorGen integration.

## Tests

```bash
npm test        # Vitest: geometry, adapter, safety guard, MCP boundary (mock gateway only)
npm run e2e     # Playwright: drag, numeric edit, validation, Apply (mock adapter)
npm run typecheck
```

## Interface

A full-height workspace: a dark navy top bar (floor and wall pickers, save status, theme), the wall elevation in the middle, and a properties inspector on the right (stacks under the editor on narrow screens). Themes are **System** (default, follows the OS live), **Light** and **Dark**; an explicit choice is stored in `localStorage` (`wallsnap.theme`). Colours are semantic CSS variables in `src/global.css`; the artwork keeps its own colour in every theme.

Save status is always one of: not saved yet, unsaved changes, saving, saved · verified (only after read-back verification and until the next edit), loaded from FloorGen, revision conflict, partially saved, save failed, or fix validation errors. A multi-step write that stops part-way says exactly what FloorGen holds.

## Reload from FloorGen

If the artwork is moved or resized directly in FloorGen, **Reload from FloorGen** (in the inspector) re-reads it by its persistent FloorGen item id and refreshes the SVG, the numeric inputs and the known project revision together. It is manual (no polling or subscriptions) and read-only: it never creates, resizes or moves anything.

- **Local edits** are never discarded silently: Reload asks first (*Keep editing* is the default; Escape cancels).
- **Off the wall:** FloorGen has no permanent wall constraint, so the item is checked for being flush on this wall's plane (within 2 cm), facing into the room (within 2°) and centred along the wall. If not, WallSnap says *Artwork is no longer positioned on this wall* with the reason, draws no artwork and invents no coordinates. *Place back on this wall* drafts it with its own size; Apply then moves that same FloorGen object (by id, never a duplicate).
- **Deleted artwork / missing wall / failed fetch** are errors; nothing stale is loaded and local edits stay as they were.
- **Revisions:** the wall is read in several calls that must all report the same project revision (re-read if it changed part-way, otherwise reported as stale). The next Apply uses the reloaded revision and keeps the stale-edit protection.

## Coordinates

- `u` (shown as *Horizontal position*): distance from wall **endpoint A** to the artwork centre, in cm. Endpoint A is authoritative whatever direction the wall is stored in or which face you view; the SVG always draws A on the left and labels A and B.
- `v` (shown as *Bottom elevation*): the artwork's bottom edge above the floor, in cm. The artwork occupies `[u - w/2, u + w/2] x [v, v + h]`.
- FloorGen item `x,y` is the item centre, `elevation` is its underside height and `rotation` is degrees clockwise. The adapter converts `u` to a plan point along A→B, pushes it out by `wall thickness/2 + item depth/2` towards the room so the picture sits flush, and sets the rotation to face the room.
- A catalogue `picture-large` is placed once, resized with `update_items`, tagged `wallsnap`, and reused on later Applies.

## Apply

Re-reads the project; rejects with 409 if its `rev` differs from the loaded one (the UI offers *Reload*); validates; writes with `expected_rev`; reads back; reports success only if width/height/`u`/`v` match within 0.1 cm and the item is flush within 0.5 cm. No writes happen while dragging.

## Safety rules

- Only `p_1ii0qmfr58hv4` (WallSnap DEV) is writable. `server/safety.ts` checks the project ID on **every** write tool call, before the MCP transport is reached, and refuses any other ID, including the original `p_128q3xq17slpfi`. Tools other than `list_floors`, `list_entities`, `describe_project`, `get_entity`, `search_catalog`, `place_item`, `place_on_wall` and `update_items` are refused outright (no duplicate/delete).
- The server also refuses to start if `FLOORGEN_PROJECT_ID` is anything other than the dev copy.
- Data returned by MCP is validated at the boundary (`server/boundary.ts`) before use.

## Rules enforced

Height <= 200 cm; inside wall bounds; no overlap with doors or windows; ground-floor walls >= 650 cm are treated as the reserved studio wall and disabled.

## Known limitations

- Reload and Apply act on the artwork id known in this session (from loading the wall, or from Apply). If an artwork was moved off its wall *before* the wall was opened in WallSnap, WallSnap cannot tell which wall it belonged to, so that wall opens as having no artwork.
- An artwork that still hangs on the wall but has an out-of-range size or elevation (for example taller than 200 cm) is shown with its real numbers and the usual validation errors, not treated as detached.

- Live-verified (2026-10-25, dev copy only): authenticated MCP connection; read of real walls; `place_on_wall` + `update_items` create (south wall, rotation 180) and update (north wall) with read-back, cross-checked through a separate FloorGen connection and the 2D render. **Not verified:** FloorGen's 3D view, walls with openings, diagonal real walls, and the stale-revision path against the real server. Unit and e2e tests use the mock gateway and synthetic geometry.
- Apply uses `place_on_wall` (FloorGen sets flush contact and facing) and `update_items` for size. `place_on_wall` validates the item's *current* size, so Apply resizes first and moves last: an existing item is resized (`update_items`) then moved (`place_on_wall`); a new 100×70 catalogue picture is first hung where it fits, then resized, then moved to the exact `u`/`v` (up to three writes). FloorGen's error `code`, `message` and `hint` are shown in the UI.
- The reserved-wall rule is a length heuristic. Lighting obstructions are not checked. One artwork per wall; walls bounding no room are not offered; for walls shared by two rooms the first room's face is used.
- Whether the item's width/height are the visible picture face (versus including its frame) is unconfirmed.

## Layout

`src/geometry.ts` pure geometry (tested) · `src/Elevation.tsx` SVG editor · `src/App.tsx` screen · `server/adapter.ts` placement logic · `server/safety.ts` write guard · `server/boundary.ts` MCP validation · `server/gateway.ts` MCP client · `server/mock.ts` + `fixture.ts` mock with synthetic geometry.
