// Own display-mode transitions in one place; geometry and pane state stay in MPRView.
export const VOLUME_MODES = Object.freeze({mpr:'mpr', projection:'mip', surface:'iso', slices:'slices'});

export function createViewControls({state, scene, mpr, element, updateSection}) {
  function applyMPRLayout(active) {
    element('section-controls').hidden = active;
    element('mpr-toggle').setAttribute('aria-pressed', String(active));
    if (active) {
      element('section-enabled').checked = false;
      state.faceSection = false;
      if (scene?.camera.isOrthographicCamera) scene.perspective();
    }
    mpr.setActive(active);
  }

  function updateVolumeMode() {
    const mode = element('volume-mode').value;
    const active = mode === VOLUME_MODES.mpr && state.object?.kind === 'volume';
    element('slice-fields').hidden = !active && mode !== VOLUME_MODES.slices;
    element('iso-field').hidden = mode !== VOLUME_MODES.surface;
    element('mpr-help').hidden = !active;
    applyMPRLayout(active);
    scene?.volumeMode(active ? VOLUME_MODES.slices : mode);
    scene?.showGrid(!active && element('show-grid').checked);
    if (state.preview?.meta.kind === 'volume') updateSection();
  }

  function updateMeshMode() {
    const active = Boolean(state.meshMPR);
    element('mesh-mpr-controls').hidden = !active;
    applyMPRLayout(active);
    scene?.showGrid(element('show-grid').checked);
    if (state.preview) updateSection();
  }

  function show3D() {
    state.faceSection = false;
    if (state.object?.kind === 'mesh') {
      state.meshMPR = false;
      updateMeshMode();
    } else if (state.object?.kind === 'volume' && element('volume-mode').value === VOLUME_MODES.mpr) {
      // Read the selected mode even while the preview is still loading.
      element('volume-mode').value = VOLUME_MODES.projection;
      updateVolumeMode();
    }
    scene?.perspective();
    element('auto-rotate').setAttribute('aria-pressed', 'false');
  }

  function toggleMPR() {
    if (state.object?.kind === 'mesh') {
      state.meshMPR = !state.meshMPR;
      updateMeshMode();
      return;
    }
    element('volume-mode').value = mpr.active ? VOLUME_MODES.projection : VOLUME_MODES.mpr;
    updateVolumeMode();
  }

  return {updateVolumeMode, updateMeshMode, show3D, toggleMPR};
}
