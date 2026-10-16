export const AXES = ['X', 'Y', 'Z'];
export const COLORS = ['#ff4545', '#31e65f', '#4585ff'];
export const IN_PLANE = [[1, 2], [0, 2], [0, 1]];

export function clampIndex(value, size) { return Math.max(0, Math.min(size - 1, Math.round(value))); }

// Project the actual affine basis into the plane; preserve spacing and shear.
// Image rows run downward, whereas source in-plane indices increase upward.
export function planeTransform(shapeXYZ, matrix, axis, width, height) {
  const [u, v] = IN_PLANE[axis], cols = shapeXYZ[u], rows = shapeXYZ[v];
  const a = matrix.slice(0, 3).map(row => row[u]), b = matrix.slice(0, 3).map(row => row[v]);
  const unit = Math.hypot(...a), along = a.reduce((sum, x, i) => sum + x * b[i], 0) / unit;
  const perpendicular = Math.sqrt(Math.max(0, b.reduce((sum, x) => sum + x*x, 0) - along*along));
  if (!(unit > 0 && perpendicular > 0)) throw new Error('体素空间变换退化，无法显示切面比例');
  const minX = Math.min(0, rows * along), physicalWidth = cols * unit + Math.abs(rows * along);
  const physicalHeight = rows * perpendicular;
  const scale = Math.min(Math.max(1, width-24)/physicalWidth, Math.max(1, height-24)/physicalHeight);
  const transform = {a:unit*scale, c:-along*scale, d:perpendicular*scale,
    e:(width-physicalWidth*scale)/2+(rows*along-minX)*scale, f:(height-physicalHeight*scale)/2, cols, rows};
  return transform;
}
export function imageToScreen(t, u, v) { return [t.a*u+t.c*v+t.e, t.d*v+t.f]; }
export function screenToIndices(t, x, y) {
  const row = (y-t.f)/t.d, col = (x-t.e-t.c*row)/t.a;
  if (col < 0 || col >= t.cols || row < 0 || row >= t.rows) return null;
  return [Math.floor(col), t.rows-1-Math.floor(row)];
}

// One active request, one replaceable pending request; stale results never apply.
export class LatestRequest {
  constructor(fetcher, accept, fail, progressive=false) { this.fetcher=fetcher;this.accept=accept;this.fail=fail;this.revision=0;this.progressive=progressive;this.minimumRevision=0;this.lastAcceptedRevision=0; }
  submit(value) { this.pending={value, revision:++this.revision};this.dispatch(); }
  reset(cancel=true) {
    this.minimumRevision=++this.revision;this.lastAcceptedRevision=this.revision;this.pending=null;
    // CPU reslicing cannot cancel a server computation. Keep the slot occupied
    // until it finishes, discard its old generation and then send only the latest pose.
    if(cancel)this.controller?.abort();
  }
  async dispatch() {
    if (this.busy || !this.pending) return;
    this.busy=true;const job=this.pending;this.pending=null;this.controller=new AbortController();
    try { const result=await this.fetcher(job.value,this.controller.signal);if(job.revision>=this.minimumRevision&&(job.revision===this.revision||(this.progressive&&job.revision>this.lastAcceptedRevision))){this.lastAcceptedRevision=job.revision;this.accept(result,job.value);} }
    catch(error) { if(job.revision===this.revision && error.name!=='AbortError')this.fail(error,job.value); }
    finally { this.busy=false;this.controller=null;this.dispatch(); }
  }
}
