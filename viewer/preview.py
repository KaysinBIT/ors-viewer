"""Bounded, explicitly approximate display previews of independent ORS exports."""
import hashlib
import json
import math
from pathlib import Path
import struct
import threading

import numpy as np

QUALITY = {'fast': 64, 'balanced': 112, 'fine': 176}
PREVIEW_VERSION = 3


def safe_file(root, name):
    path = (Path(root) / name).resolve()
    if Path(root).resolve() not in path.parents or not path.is_file():
        raise ValueError('文件不在选定的解析目录中，或文件不存在')
    return path


def array(root, name):
    data = np.load(safe_file(root, name), mmap_mode='r', allow_pickle=False)
    if data.dtype.hasobject or data.dtype.kind not in 'biuf':
        raise ValueError('仅支持数值数组')
    return data


def packet(meta, arrays):
    blocks, descriptors, offset = [], {}, 0
    for name, data in arrays.items():
        data = np.ascontiguousarray(data)
        if data.dtype.itemsize > 1:
            data = data.astype(data.dtype.newbyteorder('<'), copy=False)
        raw = data.tobytes()
        descriptors[name] = {'dtype': data.dtype.str, 'shape': list(data.shape),
                             'offset': offset, 'bytes': len(raw)}
        padding = (-len(raw)) % 4
        blocks.append(raw + b'\0' * padding)
        offset += len(raw) + padding
    header = json.dumps(dict(meta, arrays=descriptors), ensure_ascii=False, allow_nan=False).encode('utf-8')
    return struct.pack('<I', len(header)) + header + b'\0' * ((-len(header)) % 4) + b''.join(blocks)


def unit_of(column):
    node = column.get('dimension_unit') or {}
    for child in node.get('children', []):
        if child.get('tag') == 'unitAbbreviation':
            return child.get('text') or ''
    return ''


def original_mesh(folder, meta):
    """No welding, deduplication, clustering, or discarded faces at 100%."""
    vertices = array(folder, 'vertices.npy');faces = array(folder, 'triangles.npy')
    if vertices.ndim != 2 or vertices.shape[1] != 3 or faces.ndim != 2 or faces.shape[1] != 3 or not len(faces):
        raise ValueError('网格数组维度不正确或没有三角面')
    if faces.min() < 0 or faces.max() >= len(vertices) or not np.isfinite(vertices).all():
        raise ValueError('网格索引或坐标无效')
    arrays = {'positions': np.asarray(vertices, dtype='<f4'), 'indices': np.asarray(faces, dtype='<u4')}
    normal_path = folder / 'normals.npy'
    if normal_path.is_file():
        normals = array(folder, 'normals.npy')
        if normals.shape == vertices.shape: arrays['normals'] = np.asarray(normals, dtype='<f4')
    scalars = []
    for table in meta.get('tables', []):
        if table.get('row_kind') != 'vertex_index': continue
        for column in table.get('columns', [])[:8]:
            if not column.get('file', '').endswith('.npy'): continue
            values = array(folder, column['file'])
            if values.shape != (len(vertices),): continue
            values = np.asarray(values, dtype='<f4') * column.get('slope', 1) + column.get('offset', 0)
            valid = values[np.isfinite(values)];key = 'scalar_%d' % len(scalars);arrays[key] = values.astype('<f4')
            scalars.append({'key': key, 'name': column.get('name', key), 'unit': unit_of(column),
                            'min': float(valid.min()) if len(valid) else 0, 'max': float(valid.max()) if len(valid) else 1})
    return packet({'kind': 'mesh', 'original_vertices': len(vertices), 'original_triangles': len(faces),
                   'preview_vertices': len(vertices), 'preview_triangles': len(faces), 'base_triangles': len(faces),
                   'requested_retention': 100, 'actual_retention': 100, 'simplified': False,
                   'bounds': [vertices.min(0).tolist(), vertices.max(0).tolist()], 'scalars': scalars,
                   'approximation': '原始网格：全部顶点与三角面，未进行简化。显示坐标使用 float32；源数组保持原精度。'}, arrays)


def controlled_mesh(folder, meta, retention):
    if retention == 100: return original_mesh(folder, meta)
    from .simplify import unpack
    faces = array(folder, 'triangles.npy');target = max(4, len(faces) * retention / 100)
    resolution = max(4, min(8192, round(math.sqrt(target / 14))))
    best = None;error = float('inf')
    for _ in range(3):
        data = mesh_preview(folder, meta, resolution)
        header, arrays = unpack(data);count = header['preview_triangles']
        if count and abs(count - target) < error:
            best = data;error = abs(count - target)
        if count and abs(count-target)/target < .03: break
        resolution = max(4, min(8192, round(resolution * math.sqrt(target / max(count, 1)))))
    if best is None: best = original_mesh(folder, meta)
    header, arrays = unpack(best)
    header.update(base_triangles=len(faces), requested_retention=retention,
                  actual_retention=header['preview_triangles'] / len(faces) * 100, simplified=True)
    header['approximation'] = '用户指定的聚类简化预览；目标比例相对原始网格，实际面数可能略有偏差。源网格保持完整。'
    return packet(header, arrays)


def mesh_preview(folder, meta, resolution):
    vertices = array(folder, 'vertices.npy')
    faces = array(folder, 'triangles.npy')
    if vertices.ndim != 2 or vertices.shape[1] != 3 or faces.ndim != 2 or faces.shape[1] != 3:
        raise ValueError('网格数组维度不正确')
    if not len(vertices) or not len(faces):
        raise ValueError('该网格为空')
    lo = np.min(vertices, axis=0).astype('float64')
    hi = np.max(vertices, axis=0).astype('float64')
    if not np.isfinite(lo).all() or not np.isfinite(hi).all():
        raise ValueError('网格含无效坐标')
    extent = max(float(np.max(hi - lo)), 1e-20)
    # One common physical cell size keeps thin and wide dimensions proportional.
    q = np.floor((vertices - lo) / extent * (resolution - 1)).astype(np.int64)
    keys = q[:, 0] + resolution * (q[:, 1] + resolution * q[:, 2])
    del q
    _, inv = np.unique(keys, return_inverse=True)
    del keys
    inv = inv.astype(np.uint32)
    counts = np.bincount(inv)
    positions = np.column_stack([np.bincount(inv, weights=vertices[:, a], minlength=len(counts)) / counts
                                 for a in range(3)]).astype('<f4')
    pieces = []
    for begin in range(0, len(faces), 262144):
        source = np.asarray(faces[begin:begin + 262144])
        if source.min() < 0 or source.max() >= len(vertices):
            raise ValueError('网格顶点索引越界')
        mapped = inv[source]
        keep = (mapped[:, 0] != mapped[:, 1]) & (mapped[:, 1] != mapped[:, 2]) & (mapped[:, 0] != mapped[:, 2])
        pieces.append(mapped[keep])
    indices = np.concatenate(pieces) if pieces else np.empty((0, 3), dtype='<u4')
    del pieces
    if len(indices):
        _, selected = np.unique(np.sort(indices, axis=1), axis=0, return_index=True)
        indices = indices[np.sort(selected)]
    scalars, scalar_info = {}, []
    for table in meta.get('tables', []):
        if table.get('row_kind') != 'vertex_index':
            continue
        for column in table.get('columns', [])[:8]:
            if not column.get('file', '').endswith('.npy'):
                continue
            values = array(folder, column['file'])
            if values.ndim != 1 or len(values) != len(vertices):
                continue
            finite = np.isfinite(values)
            denom = np.bincount(inv, weights=finite, minlength=len(counts))
            total = np.bincount(inv, weights=np.where(finite, values, 0), minlength=len(counts))
            reduced = np.divide(total, denom, out=np.full(len(counts), np.nan), where=denom > 0)
            reduced = reduced * column.get('slope', 1) + column.get('offset', 0)
            valid = reduced[np.isfinite(reduced)]
            key = 'scalar_%d' % len(scalar_info)
            scalars[key] = reduced.astype('<f4')
            scalar_info.append({'key': key, 'name': column.get('name', key), 'unit': unit_of(column),
                                'min': float(valid.min()) if len(valid) else 0,
                                'max': float(valid.max()) if len(valid) else 1})
    return packet({'kind': 'mesh', 'original_vertices': len(vertices), 'original_triangles': len(faces),
                   'preview_vertices': len(positions), 'preview_triangles': len(indices),
                   'bounds': [lo.tolist(), hi.tolist()], 'scalars': scalar_info,
                   'approximation': '顶点聚类简化；标量显示聚类均值。原始数据未修改。'},
                  {'positions': positions, 'indices': indices.astype('<u4'), **scalars})


def grid_matrix(meta):
    grid = meta.get('grid', {})
    matrix = grid.get('voxel_xyz_to_world')
    if matrix is not None:
        result = np.asarray(matrix, dtype='float64')
        if result.shape != (4, 4) or not np.isfinite(result).all():
            raise ValueError('空间变换矩阵无效')
        return result
    steps = grid.get('spacing_xyz', [1, 1, 1])
    return np.diag([*steps, 1.0])


def sampling_axes(shape, resolution):
    return [np.arange(0, int(n), max(1, math.ceil(n / resolution)), dtype=np.int64) for n in shape]


def label_bounds(runs, label_id, shape):
    selected = np.asarray(runs[runs[:, 2] == label_id])
    if not len(selected): raise ValueError('该标签没有前景体素')
    lo, hi = selected[:, 0].astype(np.int64), selected[:, 1].astype(np.int64)
    nz, ny, nx = shape
    bounds = []
    for stride, count in ((nx * ny, nz), (nx, ny), (1, nx)):
        a, b = lo // stride, hi // stride
        if np.any(a // count != b // count):
            bounds.append((0, count - 1))
        else:
            bounds.append((int((a % count).min()), int((b % count).max())))
    return bounds


def sample_labels(folder, meta, resolution, label_id=0):
    shape = meta['grid']['shape_tzyx']
    if shape[0] != 1:
        raise ValueError('当前分割预览只支持单时间步')
    if label_id:
        runs = array(folder, 'label_intervals.npy')
        bounds = label_bounds(runs, label_id, shape[1:])
        z, y, x = [np.arange(lo, hi + 1, max(1, math.ceil((hi - lo + 1) / resolution)), dtype=np.int64)
                   for lo, hi in bounds]
    else:
        z, y, x = sampling_axes(shape[1:], resolution)
    dense = folder / 'labels.npy'
    if dense.is_file():
        data = array(folder, 'labels.npy')
        sampled = np.asarray(data[0][np.ix_(z, y, x)], dtype='<u4')
    else:
        runs = array(folder, 'label_intervals.npy')
        if runs.ndim != 2 or runs.shape[1] != 3:
            raise ValueError('分割区间格式不正确')
        flat = ((z[:, None, None] * shape[2] + y[None, :, None]) * shape[3] + x[None, None, :]).ravel()
        sampled = np.zeros(len(flat), dtype='<u4')
        if len(runs):
            where = np.searchsorted(runs[:, 0], flat, side='right') - 1
            valid = where >= 0
            indices = np.flatnonzero(valid)
            valid[indices] &= flat[indices] <= runs[where[indices], 1]
            sampled[valid] = runs[where[valid], 2]
        sampled = sampled.reshape(len(z), len(y), len(x))
    if label_id: sampled[sampled != label_id] = 0
    return sampled, (z, y, x)


def label_preview(folder, meta, resolution, label_id=0):
    sampled, axes = sample_labels(folder, meta, resolution, label_id)
    shape = meta['grid']['shape_tzyx'][1:]
    matrix = grid_matrix(meta)
    positions, ids = [], []
    # Exposed voxel faces. Different neighboring labels retain their own surfaces.
    for axis in range(3):
        for sign in (-1, 1):
            neighbor = np.zeros_like(sampled)
            dst = [slice(None)] * 3;src = [slice(None)] * 3
            if sign < 0:
                dst[axis], src[axis] = slice(1, None), slice(None, -1)
            else:
                dst[axis], src[axis] = slice(None, -1), slice(1, None)
            neighbor[tuple(dst)] = sampled[tuple(src)]
            idx = np.argwhere((sampled != 0) & (sampled != neighbor))
            if not len(idx):
                continue
            lows = np.column_stack([axes[a][idx[:, a]] - .5 for a in range(3)])
            highs = np.column_stack([np.minimum(axes[a][idx[:, a]] +
                        (int(axes[a][1] - axes[a][0]) if len(axes[a]) > 1 else 1), shape[a]) - .5
                        for a in range(3)])
            a, b = [k for k in range(3) if k != axis]
            quad = np.repeat(lows[:, None, :], 4, axis=1)
            quad[:, :, axis] = (highs[:, axis] if sign > 0 else lows[:, axis])[:, None]
            quad[:, 1, a] = highs[:, a];quad[:, 2, a] = highs[:, a]
            quad[:, 2, b] = highs[:, b];quad[:, 3, b] = highs[:, b]
            xyz = quad[:, :, ::-1]
            world = xyz @ matrix[:3, :3].T + matrix[:3, 3]
            positions.append(world.astype('<f4'))
            ids.append(sampled[tuple(idx.T)])
            if sum(len(p) for p in positions) > 1000000:
                raise ValueError('该精度的表面过大，请降低预览精度或单独选择标签')
    if not positions:
        return packet({'kind': 'labels', 'groups': [], 'preview_triangles': 0,
                       'sample_shape_zyx': list(sampled.shape), 'missing_labels': list(meta.get('label_voxel_counts', {})),
                       'approximation': '当前采样下没有可见表面。可提高精度；原始分割仍完整保留。'},
                      {'positions': np.empty((0, 3), dtype='<f4'), 'indices': np.empty((0, 3), dtype='<u4')})
    quads, lab = np.concatenate(positions), np.concatenate(ids)
    order = np.argsort(lab, kind='stable');quads, lab = quads[order], lab[order]
    pos = quads.reshape(-1, 3)
    base = np.arange(len(quads), dtype=np.uint32)[:, None] * 4
    indices = (base + np.array([0, 1, 2, 0, 2, 3], dtype=np.uint32)[None, :]).reshape(-1, 3)
    labels, first, counts = np.unique(lab, return_index=True, return_counts=True)
    groups = [{'id': int(k), 'start': int(start * 6), 'count': int(n * 6)} for k, start, n in zip(labels, first, counts)]
    all_labels = {label_id} if label_id else {int(k) for k in meta.get('label_voxel_counts', {})}
    return packet({'kind': 'labels', 'groups': groups, 'preview_vertices': len(pos),
                   'preview_triangles': len(indices), 'sample_shape_zyx': list(sampled.shape),
                   'bounds': [pos.min(0).tolist(), pos.max(0).tolist()],
                   'missing_labels': sorted(all_labels - set(map(int, labels))),
                   'focus_label': label_id,
                   'approximation': '采样体素表面预览；细小标签可能不可见。数值统计使用完整分割。'},
                  {'positions': pos, 'indices': indices})


def volume_preview(folder, meta, resolution, time_step=0):
    data = array(folder, 'volume.npy')
    if data.ndim != 4 or not 0 <= time_step < data.shape[0]:
        raise ValueError('体数据或时间步无效')
    axes = sampling_axes(data.shape[1:], resolution)
    sample = np.asarray(data[time_step][np.ix_(*axes)], dtype='float32')
    valid = sample[np.isfinite(sample)]
    if not len(valid):
        raise ValueError('体数据没有有限数值')
    lo, hi = float(valid.min()), float(valid.max())
    limits = np.percentile(valid, [20, 99.5]).tolist()
    if limits[1] <= limits[0]:
        limits = [lo, max(hi, lo + 1)]
    texture = np.clip((np.nan_to_num(sample, nan=lo, posinf=lo, neginf=lo) - lo) / max(hi - lo, 1e-20) * 255, 0, 255).astype('u1')
    matrix = grid_matrix(meta)
    nx, ny, nz = map(int, data.shape[:0:-1])
    local_to_world = np.eye(4)
    local_to_world[:3, :3] = matrix[:3, :3] @ np.diag([nx, ny, nz])
    local_to_world[:3, 3] = matrix[:3, 3] + matrix[:3, :3] @ ((np.array([nx, ny, nz]) - 1) / 2)
    return packet({'kind': 'volume', 'sample_shape_zyx': list(texture.shape),
                   'original_shape_tzyx': list(data.shape), 'time_step': time_step,
                   'range': [lo, hi], 'window': limits, 'matrix': local_to_world.tolist(),
                   'original_dtype': data.dtype.str,
                   'approximation': '降采样、8 位显示纹理；原始 NPY 的位宽和数值不变。'}, {'volume': texture})


class PreviewCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def get(self, folder, meta, quality='balanced', time_step=0, label_id=0, retention=100):
        if quality not in QUALITY:
            raise ValueError('无效预览精度')
        if meta['type'] == 'CxvFaceVertexMesh': quality = 'balanced'  # Quality only controls volume/label sampling.
        if not math.isfinite(retention) or not 1 <= retention <= 100:
            raise ValueError('保留比例须在 1–100% 之间')
        stamp = [(p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in folder.iterdir()
                 if p.is_file() and p.suffix in ('.npy', '.json')]
        key = hashlib.sha256(json.dumps([PREVIEW_VERSION, str(folder), sorted(stamp), quality, time_step, label_id]).encode()).hexdigest()
        if meta['type'] == 'CxvFaceVertexMesh':
            target = self.directory / (key + '-mesh-r' + str(float(retention)) + '.bin')
            with self.lock:
                if not target.exists():
                    result = controlled_mesh(folder, meta, retention)
                    temporary = target.with_suffix('.partial');temporary.write_bytes(result);temporary.replace(target)
            return target
        if retention != 100 and meta['type'] != 'CxvChannel':
            from .simplify import simplify_packet
            base = self.get(folder, meta, quality, time_step, label_id)
            target = self.directory / (key + '-r' + str(float(retention)) + '.bin')
            with self.lock:
                if not target.exists():
                    result = simplify_packet(base.read_bytes(), retention)
                    temporary = target.with_suffix('.partial');temporary.write_bytes(result);temporary.replace(target)
            return target
        target = self.directory / (key + '.bin')
        # Serialize expensive preview construction; cached responses stay cheap.
        if not target.exists():
            with self.lock:
                if not target.exists():
                    resolution = QUALITY[quality]
                    if meta['type'] == 'CxvFaceVertexMesh':
                        result = mesh_preview(folder, meta, resolution)
                    elif meta['type'] in ('CxvVolume_ROI', 'CxvLabeledMultiROI'):
                        result = label_preview(folder, meta, resolution, label_id)
                    elif meta['type'] == 'CxvChannel':
                        result = volume_preview(folder, meta, resolution, time_step)
                    else:
                        raise ValueError('此对象尚不支持三维显示')
                    temporary = target.with_suffix('.partial')
                    temporary.write_bytes(result);temporary.replace(target)
        return target
