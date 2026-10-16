# Changelog

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
