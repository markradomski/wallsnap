# WallSnap technical notes

Detailed behaviour of the editor, saving, images and the 3D preview. Setup, safety and limitations are in the [README](../README.md).

## The editor

One screen: a top bar (floor and wall pickers, save status, 2D/3D switch, theme), the wall elevation in the middle, and an inspector on the right (it stacks under the editor on narrow screens).

### 2D elevation

- The SVG draws the selected wall to scale, endpoint **A** on the left and **B** on the right whatever direction FloorGen stores the wall in, with its doors and windows drawn and labelled.
- Drag an artwork to move it, or use its eight resize handles. Dragging uses SVG coordinate transforms, so it stays accurate when the editor scales.
- Every action also works without a pointer: the inspector has labelled inputs for width, height, horizontal position (`u`) and bottom elevation (`v`). With the artwork focused, the arrow keys move it 1 cm and Shift+arrow 10 cm.
- Themes are **System** (default, follows the OS), **Light** and **Dark**. An explicit choice is kept in `localStorage` (`wallsnap.theme`).

### Validation

Apply stays disabled until every pending artwork passes, and each problem is shown in centimetres. A typed value that breaks a rule is kept and reported, never corrected silently. Dragging and arrow-key nudges stop at the wall's edges (they can still overlap a door or window, which is then reported).

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
