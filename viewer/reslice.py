"""On-demand world-axis planes: linear CT samples, nearest-neighbour label IDs."""
import numpy as np

from .alignment import pose_matrix, transformed_bounds
from .preview import array, grid_matrix, packet
from .affine import matrix_product, inverse_affine, transform_points

MAX_PLANE_PIXELS = 16_777_216
CHUNK_PIXELS = 131072
IN_PLANE = ((1, 2), (0, 2), (0, 1))
LABEL_TYPES = ('CxvVolume_ROI', 'CxvLabeledMultiROI')


def geometry(meta, pose):
    if meta.get('type') not in ('CxvChannel', *LABEL_TYPES):
        raise ValueError('重采样切面仅支持 CT 或分割对象')
    shape = np.asarray(meta['grid']['shape_tzyx'], dtype=np.int64)
    if shape.shape != (4,) or np.any(shape <= 0):
        raise ValueError('无效的体素维度')
    matrix = matrix_product(pose_matrix(pose), grid_matrix(meta))
    if not np.allclose(matrix[3], [0, 0, 0, 1]):
        raise ValueError('体素空间矩阵必须为仿射变换')
    inverse = inverse_affine(matrix)
    bounds = transformed_bounds(np.full(3, -.5), shape[:0:-1] - .5, matrix)
    # One source-voxel distance along each fixed world axis; no automatic reduction.
    spacing = 1 / np.sqrt(np.sum(inverse[:3, :3]**2, axis=0))
    counts = np.maximum(1, np.ceil((bounds[1] - bounds[0]) / spacing - 1e-10))
    if (not np.isfinite(inverse).all() or not np.isfinite(bounds).all() or
            not np.isfinite(spacing).all() or np.any(spacing <= 0) or
            not np.isfinite(counts).all() or np.any(counts > MAX_PLANE_PIXELS)):
        raise ValueError('对齐切面范围或体素矩阵超出显示限制；没有自动降低分辨率')
    counts = counts.astype(np.int64)
    origin = (bounds[0] + bounds[1] - (counts - 1) * spacing) / 2
    display_matrix = np.diag([*spacing, 1.0]); display_matrix[:3, 3] = origin
    info = {'shape_xyz': counts.tolist(), 'origin': origin.tolist(), 'spacing': spacing.tolist(),
            'bounds': bounds.tolist(), 'voxel_xyz_to_world': display_matrix.tolist(),
            'labels': meta['type'] in LABEL_TYPES, 'source_shape_tzyx': shape.tolist()}
    return info, inverse


class Sampler:
    def __init__(self, folder, meta, pose, time=0):
        self.info, self.inverse = geometry(meta, pose)
        self.shape = self.info['source_shape_tzyx']
        if type(time) is not int or not 0 <= time < self.shape[0]:
            raise ValueError('时间步无效')
        self.time, self.labels = time, self.info['labels']
        if not self.labels:
            self.data, self.runs = array(folder, 'volume.npy'), None
        elif (folder / 'labels.npy').is_file():
            self.data, self.runs = array(folder, 'labels.npy'), None
        else:
            self.data, self.runs = None, array(folder, 'label_intervals.npy')
            if self.runs.ndim != 2 or self.runs.shape[1] != 3:
                raise ValueError('分割区间格式不正确')
        if self.data is not None and list(self.data.shape) != self.shape:
            raise ValueError('数组维度与元数据不一致')

    def nearest(self, xyz):
        ix = np.floor(xyz + .5).astype(np.int64)
        ix = np.clip(ix, 0, np.array(self.shape[:0:-1]) - 1)
        x, y, z = ix.T
        if self.data is not None:
            return self.data[self.time, z, y, x]
        flat = ((self.time*self.shape[1]+z)*self.shape[2]+y)*self.shape[3]+x
        result = np.zeros(len(flat), dtype='<u4')
        if not len(self.runs): return result
        row = np.searchsorted(self.runs[:, 0], flat, side='right') - 1
        valid = (row >= 0) & (flat <= self.runs[np.maximum(row, 0), 1])
        result[valid] = self.runs[row[valid], 2]
        return result

    def sample(self, world):
        xyz = transform_points(world, self.inverse)
        valid = ((xyz >= -.5 - 1e-9) & (xyz <= np.array(self.shape[:0:-1]) - .5 + 1e-9)).all(axis=1)
        if self.labels:
            values = np.asarray(self.nearest(xyz), dtype='<u4')
            values[~valid] = 0
            return values, valid, xyz
        xyz = np.clip(xyz, 0, np.array(self.shape[:0:-1]) - 1)
        lo = np.floor(xyz).astype(np.int64); hi = np.minimum(lo+1, np.array(self.shape[:0:-1])-1)
        fraction = xyz-lo
        values = np.zeros(len(xyz), dtype=float)
        for corner in range(8):
            bits = np.array([(corner >> a) & 1 for a in range(3)])
            weight = np.prod(np.where(bits, fraction, 1-fraction), axis=1)
            selected = weight > 0  # A zero-weight NaN must not corrupt an exact voxel sample.
            x, y, z = np.where(bits, hi, lo)[selected].T
            values[selected] += weight[selected] * self.data[self.time, z, y, x]
        values[~valid] = np.nan
        return values.astype('<f4'), valid, xyz


def reslice_packet(folder, meta, pose, axis, coordinate, time=0):
    if type(axis) is not int or axis not in (0, 1, 2) or not np.isfinite(coordinate):
        raise ValueError('切面轴或位置无效')
    sampler = Sampler(folder, meta, pose, time); info = sampler.info
    if not info['bounds'][0][axis] <= coordinate <= info['bounds'][1][axis]:
        raise ValueError('切面位置超出数据范围')
    u, v = IN_PLANE[axis]; cols, rows = info['shape_xyz'][u], info['shape_xyz'][v]
    if rows * cols > MAX_PLANE_PIXELS:
        raise ValueError('对齐切面超过 1677 万像素，无法载入；没有自动降低分辨率')
    values = np.empty(rows*cols, dtype='<u4' if sampler.labels else '<f4')
    mask = np.empty(rows*cols, dtype='u1')
    for start in range(0, rows*cols, CHUNK_PIXELS):
        end = min(rows*cols, start+CHUNK_PIXELS); offsets = np.arange(start, end)
        world = np.empty((end-start, 3)); world[:, axis] = coordinate
        world[:, u] = info['origin'][u] + (offsets % cols)*info['spacing'][u]
        world[:, v] = info['origin'][v] + (offsets // cols)*info['spacing'][v]
        values[start:end], mask[start:end], _ = sampler.sample(world)
    finite = values[(mask != 0) & np.isfinite(values)]
    return packet({**info, 'kind': 'reslice', 'axis': axis, 'index': coordinate, 'time_step': time,
                   'shape_yx': [rows, cols], 'resampled': True,
                   'interpolation': 'nearest' if sampler.labels else 'linear',
                   'range': None if sampler.labels or not len(finite) else [float(finite.min()), float(finite.max())]},
                  {'pixels': values.reshape(rows, cols), 'mask': mask.reshape(rows, cols)})


def reslice_probe(folder, meta, pose, world, time=0):
    world = np.asarray(world, dtype=float)
    if world.shape != (3,) or not np.isfinite(world).all(): raise ValueError('定位坐标无效')
    sampler = Sampler(folder, meta, pose, time)
    values, valid, _ = sampler.sample(world[None])
    xyz = transform_points(world, sampler.inverse)
    return {'xyz': xyz.tolist(), 'world_xyz': world.tolist(), 'time_step': time,
            'value': str(sampler.nearest(xyz[None])[0].item()) if valid[0] else '范围外',
            'sampled_value': str(values[0].item()) if valid[0] else '范围外',
            'dtype': str(sampler.data.dtype) if sampler.data is not None else 'uint32',
            'interpolation': 'nearest' if sampler.labels else 'linear'}
