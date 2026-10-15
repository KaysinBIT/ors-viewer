# Changelog

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
