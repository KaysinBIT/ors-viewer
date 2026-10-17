# Changelog

## 1.2.0RC4 (local fix candidate)

- Remove BLAS/LAPACK calls from spatial transforms, preview coordinate conversion and reslicing to prevent the Windows native access violation reproduced under concurrent slice requests. Preserve interpolation, source arrays and coordinate units.
- Show the complete CT model in MPR, with locator outlines. Share maximum-intensity-projection / isosurface selection and display settings with the independent 3D view; keep explicit 3D slice mode available.
- Explain disconnected local-service requests and restore mesh crosshair navigation after the prior frame-generation guard.
- Add affine, concurrent-packet and shared-rendering regressions. Browser page verification remains pending.

## 1.2.0RC3 (local fix candidate)

- Keep the last valid 2D planes visible while a new orientation is calculated. Retained frames use their own dimensions and affine, with pending status and point-picking protection.
- Render immediate fixed-axis CT locator slices from the existing user-selected preview texture, then replace them with full-resolution slices. Do not change or downsample source arrays.
- Include pose generations in slice keys and clear stale locator metadata on resource cleanup.
- Add focused delayed-update, image-aspect and preview-texture lifecycle regression tests. Browser page verification remains pending.

## 1.2.0RC2 (prerelease)

- Add independent X/Y/Z dataset mirror switches, applied after rotation about the shared dataset pivot. Meshes, CT and segmentation use the same transform for rendering and sections.
- Preserve mirrors during face/three-point alignment; save and restore them with pose preferences. Legacy rotation-only settings remain compatible. Reset clears both rotation and mirrors.
- Make file selection the first and default import mode; retain local-path and decoded-directory import.
- Default to the ocean (deep blue) theme across 3D/MPR and the initial page; retain explicitly saved theme preferences.
- Keep source arrays and PLY exports unchanged. 210 automated tests pass; browser visual acceptance is not performed for this release.

## 1.2.0rc1 (candidate)

- Add dataset-wide rigid orientation with a shared source-space pivot, manual XYZ angles, quarter-turn buttons, reference faces and three-point alignment.
- Keep XYZ slicing axes fixed; rotate mesh intersection planes back into source space without changing or reducing the original mesh.
- Reslice CT with linear interpolation and dense/sparse segmentation with nearest-neighbour label IDs; synchronize world-axis 3D locator planes.
- Save alignment preferences separately and restore the original pose. Source arrays, measurement tables and PLY exports remain unchanged.
- Extend automated coverage and the offline manual. Browser interaction and visual acceptance remain pending.

## 1.1.0

- Fill arbitrary-angle mesh and segmentation sections, preserving holes and rejecting unverified contours.
- Add line/fill/outline choices and fill opacity; discard stale caps during movement without modifying source geometry.
- Add per-plane maximize/restore buttons and Escape restoration for volume and mesh MPR.
- Preserve pane position, zoom and pan; export the visible maximized plane in screenshots.
- Update the offline manual. Automated tests pass; browser visual acceptance has not been completed.

## 1.0.0

- Stable release retaining the v0.9.1RC2 file formats, UI operations and numerical algorithms.
- Centralize 3D/MPR mode transitions and extract request, PLY export and UI constants modules.
- Split preview loading, object reset and measurement table rendering into focused functions.
- Separate HTTP object, settings and upload handlers while preserving authorization, errors and limits.
- Add pre-refactor state and binary export characterization tests; verify mesh, volume and label workflows.
- Retain manual desktop startup, complete original meshes and independent parsing without Dragonfly.

## 0.9.1RC2

- Make the 3D button exit the three-plane layout for both meshes and volumes, synchronizing the mode controls and hiding section panes.
- Return volume MPR to 3D maximum-intensity projection; preserve section positions and per-pane zoom when reopening MPR.
- Preserve the manual desktop startup workflow from 0.9.1RC.

## 0.9.1RC

- Configure the port and data folder in the desktop launcher before starting the local service.
- Open the 3D page only when the user clicks the browser button; startup never opens it automatically.
- Default the first data folder to the executable directory and retain saved selections.
- Add folder selection, explicit stop/reconfigure controls, validation messages and startup guidance.
- Keep command-line overrides temporary and preserve loopback-only listening.
- Publish as a release candidate (Python package version 0.9.1rc1) and update offline manuals.

## 0.9.0

- Add independent 25–800% zoom sliders, right-button panning, crosshair centering and fit controls to all three 2D planes.
- Add line, fill and fill-with-outline mesh section modes with adjustable fill opacity.
- Preserve holes and nested islands; reject open, branched, self-intersecting or ambiguous contours instead of inventing a fill.
- Refresh sections continuously during movement using spatial candidate indexing and cached unchanged planes, without decimation.
- Publish contour frames before fill validation and label displayed positions when computation trails input.
- Preserve zoom, pan and fill appearance in four-window screenshots and update the offline manuals.

## 0.8.1

- Release retained mesh packet references when leaving mesh views or switching to volume data, reducing memory use after viewing large meshes.
- Include all mesh three-plane and unified theme features from 0.8.0.

## 0.8.0

- Extend linked three-plane views to STL and ORS triangle meshes with exact plane intersections of the displayed geometry.
- Add crosshair navigation, wheel and keyboard movement, source-coordinate inputs and synchronized 3D locators for meshes.
- Compute mesh contours in a background worker without automatic mesh reduction; handle coplanar triangles explicitly.
- Unify 3D and three-plane palettes with persistent monochrome, light and ocean themes.
- Apply shared colors to backgrounds, solid mesh materials, guides, contour lines and exported screenshots.
- Update the offline HTML and PDF user manuals.

## 0.7.1

- Add a persistent web port setting with automatic and custom port modes.
- Apply saved ports on the next launch; command-line overrides affect only the current run.
- Report occupied saved ports and use a temporary loopback port; explicit command-line conflicts fail clearly.
- Preserve data-directory preferences and require exclusive socket binding on Windows.
- Add an independent implementation and third-party rights statement, available offline and in distributions.
- Update the HTML/PDF user manual with port configuration instructions.

## 0.7.0

- Linked CT views: three original-resolution 2D planes and a synchronized 3D locator.
- Drag crosshairs, scroll slices, navigate with keyboard or X/Y/Z sliders, and inspect original voxel values.
- Shared grayscale window, time-step navigation, affine-aware aspect ratio, and four-view PNG export.
- Light gray controls, black grayscale images, red/green/blue axes, and a blue 3D background.
- Bounded slice requests reject stale results during rapid movement. Original arrays and full mesh defaults remain unchanged.
- Updated offline HTML and PDF manuals with CT navigation instructions.

## 0.6.2

- Add local file and directory selection buttons with a browsable filesystem picker.
- Fill selected paths automatically and read source files directly without upload copies.
- Require explicit data-directory selection on first launch before imports or caches are created.
- Persist the selected directory, check write access and reopen setup when it becomes unavailable.
- Support new-folder creation, directory search and existing decoded-directory selection.
- Update the offline HTML and PDF user manuals for the new setup and import workflow.

## 0.6.1

- Update clipping planes and volume slices immediately while dragging section controls.
- Display live mesh intersections while exact contours are computed in a background worker.
- Reuse section display resources and discard superseded contour results.
- Preserve orthographic zoom while following a moving section.
- Add an eight-chapter offline Chinese user manual, printable PDF and in-app help link.

## 0.6.0

- Independent Windows x64 distribution with a desktop launcher and bundled Python runtime.
- Local import of ORSSession, ORSObject, STL and NPY files.
- Raw container extraction, typed objects, mesh and measurement exports.
- Complete original meshes by default; user-controlled face retention with actual counts.
- Arbitrary plane sections, signed distance, reversed clipping and orthographic section views.
- CT projections, isosurfaces, orthogonal and oblique slices, segmentation views and scalar coloring.
- Persistent import catalog, separate application data directory and command-line tools.
