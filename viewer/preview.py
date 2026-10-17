"""Bounded, explicitly approximate display previews of independent ORS exports."""
import hashlib
import json
import math
from pathlib import Path
import struct
import threading

import numpy as np
from .affine import transform_points

QUALITY = {'fast': 64, 'balanced': 112, 'fine': 176, 'full': None, 'custom': None}
PREVIEW_VERSION = 4
MAX_FULL_VOLUME_BYTES = 2**31 - 1
VOLUME_CHUNK_VOXELS = 1_048_576


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


def packet_header(meta, descriptors):
    header = json.dumps(dict(meta, arrays=descriptors), ensure_ascii=False, allow_nan=False).encode('utf-8')
    return struct.pack('<I', len(header)) + header + b'\0' * ((-len(header)) % 4)


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
    return packet_header(meta, descriptors) + b''.join(blocks)


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
            world = transform_points(xyz, matrix)
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


def volume_metadata(data, meta, shape, time_step, limits, window, full=False):
    matrix = grid_matrix(meta)
    nx, ny, nz = map(int, data.shape[:0:-1])
    local_to_world = np.eye(4)
    local_to_world[:3, :3] = matrix[:3, :3] * np.array([nx, ny, nz])
    local_to_world[:3, 3] = transform_points((np.array([nx, ny, nz]) - 1) / 2, matrix)
    return {'kind': 'volume', 'sample_shape_zyx': list(shape),
            'original_shape_tzyx': list(data.shape), 'time_step': time_step,
            'range': limits, 'window': window, 'matrix': local_to_world.tolist(),
            'original_dtype': data.dtype.str, 'full_resolution': full,
            'approximation': ('全分辨率：原始体素尺寸，不进行空间抽样；8 位显示纹理，默认窗口按抽样估计。' if full else '降采样、8 位显示纹理；') + '原始 NPY 的位宽和数值不变。'}


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
    return packet(volume_metadata(data, meta, texture.shape, time_step, [lo, hi], limits), {'volume': texture})


def parse_sample_counts(value):
    try:
        parts = value.split(',')
        if len(parts) != 3 or any(not p.strip().isascii() or not p.strip().isdigit() for p in parts): raise ValueError
        return tuple(int(p) for p in parts)
    except (AttributeError, ValueError):
        raise ValueError('自定义抽样须提供 X、Y、Z 三个正整数') from None


def validate_sample_counts(counts, shape):
    if not isinstance(counts, (tuple, list)) or len(counts) != 3 or any(type(n) is not int or n <= 0 for n in counts):
        raise ValueError('自定义抽样须提供 X、Y、Z 三个正整数')
    if len(shape) != 4 or any(n > size for n, size in zip(counts, shape[:0:-1])):
        raise ValueError('各轴抽样数不能超过原始体素数量')
    if math.prod(counts) > MAX_FULL_VOLUME_BYTES:
        raise ValueError('自定义抽样的 8 位纹理超过 2 GiB 限制，请手动减少抽样数')
    return tuple(counts)


def sample_indices(size, count, positions):
    # Include both ends; a one-sample axis uses its central source voxel.
    if count == 1: return np.full_like(positions, (size-1)//2, dtype=np.int64)
    return np.rint(positions * ((size-1)/(count-1))).astype(np.int64)


def full_volume_preview(folder, meta, destination, time_step=0):
    return write_volume_preview(folder, meta, destination, time_step)


def write_volume_preview(folder, meta, destination, time_step=0, sample_counts=None):
    """Stream full or explicitly sampled voxels with bounded working memory.

    Custom counts are XYZ; array and packet dimensions remain ZYX. Only the
    initial window estimate uses fewer samples than the requested texture.
    """
    data = array(folder, 'volume.npy')
    if data.ndim != 4 or not 0 <= time_step < data.shape[0] or any(n <= 0 for n in data.shape):
        raise ValueError('体数据或时间步无效')
    if sample_counts is not None: sample_counts = validate_sample_counts(sample_counts, data.shape)
    shape = tuple(reversed(sample_counts)) if sample_counts is not None else data.shape[1:]
    size = math.prod(shape)
    if size > MAX_FULL_VOLUME_BYTES:
        raise ValueError('全分辨率 8 位纹理超过 2 GiB 的单纹理限制；请手动选择其他预览精度。没有自动降采样。')
    def chunks():
        if sample_counts is None:
            yield from np.nditer(data[time_step], flags=['external_loop', 'buffered'], order='C',
                                op_dtypes=['float32'], casting='unsafe', buffersize=VOLUME_CHUNK_VOXELS)
            return
        nz, ny, nx = shape
        for start in range(0, size, VOLUME_CHUNK_VOXELS):
            offsets = np.arange(start, min(start+VOLUME_CHUNK_VOXELS, size))
            z = sample_indices(data.shape[1], nz, offsets//(ny*nx))
            y = sample_indices(data.shape[2], ny, (offsets//nx)%ny)
            x = sample_indices(data.shape[3], nx, offsets%nx)
            yield np.asarray(data[time_step, z, y, x], dtype='float32')
    lo, hi = math.inf, -math.inf
    for block in chunks():
        valid = block[np.isfinite(block)]
        if len(valid): lo, hi = min(lo, float(valid.min())), max(hi, float(valid.max()))
    if not math.isfinite(lo): raise ValueError('体数据没有有限数值')
    axes = sampling_axes(shape, QUALITY['balanced'])
    if sample_counts is not None:
        axes = [sample_indices(n, count, indices) for n, count, indices in zip(data.shape[1:], shape, axes)]
    sample = np.asarray(data[time_step][np.ix_(*axes)], dtype='float32')
    valid = sample[np.isfinite(sample)]
    limits = np.percentile(valid, [20, 99.5]).tolist() if len(valid) else [lo, hi]
    if limits[1] <= limits[0]: limits = [lo, max(hi, lo + 1)]
    info = volume_metadata(data, meta, shape, time_step, [lo, hi], limits, full=tuple(shape)==tuple(data.shape[1:]))
    if sample_counts is not None:
        info.update(custom_sampling=True, requested_samples_xyz=list(sample_counts),
                    approximation='按指定 XYZ 数量均匀抽取原始体素；8 位显示纹理，默认窗口按抽样估计。原始 NPY 和二维三切面分辨率不变。')
    descriptors = {'volume': {'dtype': '|u1', 'shape': list(shape), 'offset': 0, 'bytes': size}}
    try:
        with destination.open('wb') as stream:
            stream.write(packet_header(info, descriptors))
            for block in chunks():
                texture = np.clip((np.nan_to_num(block, nan=lo, posinf=lo, neginf=lo) - lo) / max(hi-lo, 1e-20) * 255, 0, 255).astype('u1')
                stream.write(texture.tobytes())
            stream.write(b'\0' * ((-size) % 4))
    except BaseException:
        destination.unlink(missing_ok=True)
        raise


class PreviewCache:
    def __init__(self, directory):
        self.directory = Path(directory)
        self.directory.mkdir(parents=True, exist_ok=True)
        self.lock = threading.Lock()

    def get(self, folder, meta, quality='balanced', time_step=0, label_id=0, retention=100, sample_counts=None):
        if quality not in QUALITY:
            raise ValueError('无效预览精度')
        if quality in ('full', 'custom') and meta['type'] != 'CxvChannel':
            raise ValueError('全分辨率与自定义体纹理仅支持体数据；网格默认保留全部三角面')
        if quality == 'custom':
            source = array(folder, 'volume.npy')
            sample_counts = validate_sample_counts(sample_counts, source.shape)
            del source
        if meta['type'] == 'CxvFaceVertexMesh': quality = 'balanced'  # Quality only controls volume/label sampling.
        if not math.isfinite(retention) or not 1 <= retention <= 100:
            raise ValueError('保留比例须在 1–100% 之间')
        stamp = [(p.name, p.stat().st_size, p.stat().st_mtime_ns) for p in folder.iterdir()
                 if p.is_file() and p.suffix in ('.npy', '.json')]
        cache_key = [PREVIEW_VERSION, str(folder), sorted(stamp), quality, time_step, label_id]
        if quality == 'custom': cache_key.append(sample_counts)
        key = hashlib.sha256(json.dumps(cache_key).encode()).hexdigest()
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
                    if quality in ('full', 'custom'):
                        temporary = target.with_suffix('.partial')
                        write_volume_preview(folder, meta, temporary, time_step, sample_counts if quality=='custom' else None)
                        temporary.replace(target)
                        return target
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
