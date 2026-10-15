"""Approximate target face retention by vertex clustering, never by deleting random faces."""
import json
import math
import struct
import numpy as np


def unpack(data):
    length = struct.unpack_from('<I', data)[0]
    meta = json.loads(data[4:4 + length]);base = 4 + (length + 3) // 4 * 4
    arrays = {k: np.frombuffer(data, dtype=v['dtype'], count=v['bytes'] // np.dtype(v['dtype']).itemsize,
                              offset=base + v['offset']).reshape(v['shape']) for k, v in meta['arrays'].items()}
    return meta, arrays


def reduce_arrays(positions, faces, scalar_arrays, percent):
    """All remapped faces survive unless collapsed or duplicated. Winding is retained."""
    if percent == 100 or len(faces) < 8: return positions, faces, scalar_arrays
    used, compact = np.unique(faces, return_inverse=True)
    positions = positions[used];faces = compact.reshape(-1, 3)
    scalar_arrays = {k: a[used] for k, a in scalar_arrays.items()}
    lo = positions.min(0).astype('float64');extent = max(float(np.ptp(positions, axis=0).max()), 1e-30)
    target = max(4, round(len(faces) * percent / 100))
    best = (positions, faces, scalar_arrays);best_error = abs(len(faces) - target)
    lower, upper = 1, 4096
    for _ in range(12):
        resolution = (lower + upper) // 2
        quantized = np.floor((positions.astype('float64') - lo) / extent * resolution).astype(np.int64)
        _, inverse = np.unique(quantized, axis=0, return_inverse=True)
        mapped = inverse[faces]
        keep = (mapped[:, 0] != mapped[:, 1]) & (mapped[:, 0] != mapped[:, 2]) & (mapped[:, 1] != mapped[:, 2])
        mapped = mapped[keep]
        if len(mapped):
            _, selected = np.unique(np.sort(mapped, axis=1), axis=0, return_index=True)
            mapped = mapped[np.sort(selected)]
        error = abs(len(mapped) - target)
        if len(mapped) and error < best_error:
            counts = np.bincount(inverse)
            reduced = np.column_stack([np.bincount(inverse, weights=positions[:, a]) / counts for a in range(3)]).astype('<f4')
            scalars = {}
            for k, a in scalar_arrays.items():
                valid = np.isfinite(a);denom = np.bincount(inverse, weights=valid)
                totals = np.bincount(inverse, weights=np.where(valid, a, 0))
                scalars[k] = np.divide(totals, denom, out=np.full(len(counts), np.nan), where=denom > 0).astype('<f4')
            best = reduced, mapped.astype('<u4'), scalars;best_error = error
        if len(mapped) > target: upper = resolution - 1
        else: lower = resolution + 1
        if lower > upper or best_error <= max(1, target * .015): break
    return best


def simplify_packet(data, percent):
    from .preview import packet
    if not math.isfinite(percent) or not 1 <= percent <= 100: raise ValueError('保留比例须在 1–100% 之间')
    meta, arrays = unpack(data)
    if meta['kind'] == 'volume': return data
    original = meta['preview_triangles']
    if meta['kind'] == 'labels':
        positions, indices, groups = [], [], []
        offset = 0;start = 0
        for group in meta['groups']:
            faces = arrays['indices'].reshape(-1)[group['start']:group['start'] + group['count']].reshape(-1, 3)
            p, f, _ = reduce_arrays(arrays['positions'], faces, {}, percent)
            # Compact per-label arrays; labels never merge into each other.
            used, inverse = np.unique(f, return_inverse=True);p = p[used];f = inverse.reshape(-1, 3).astype('<u4')
            groups.append(dict(group, start=start, count=f.size));start += f.size
            positions.append(p);indices.append(f + offset);offset += len(p)
        if positions:
            arrays = {'positions': np.concatenate(positions), 'indices': np.concatenate(indices).astype('<u4')}
        meta['groups'] = groups
    else:
        scalars = {k: a for k, a in arrays.items() if k.startswith('scalar_')}
        p, f, scalars = reduce_arrays(arrays['positions'], arrays['indices'], scalars, percent)
        arrays = {'positions': p, 'indices': f.astype('<u4'), **scalars}
    meta.update(base_triangles=original, requested_retention=percent,
                actual_retention=100 * len(arrays['indices']) / max(original, 1),
                preview_vertices=len(arrays['positions']), preview_triangles=len(arrays['indices']))
    meta['approximation'] += ' 三角面按目标比例聚类简化（相对当前精度），实际面数可能略有偏差。'
    return packet(meta, arrays)
