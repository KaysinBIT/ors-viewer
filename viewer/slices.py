"""Read original, axis-aligned planes without resampling the volume."""
import numpy as np

from .preview import array, grid_matrix, packet


def source_volume(folder, meta, time_step):
    if meta.get('type') != 'CxvChannel':
        raise ValueError('三切面仅适用于体数据对象')
    data = array(folder, 'volume.npy')
    if data.ndim != 4 or not 0 <= time_step < data.shape[0]:
        raise ValueError('体数据或时间步无效')
    return data


def slice_packet(folder, meta, axis, index, time_step=0):
    data = source_volume(folder, meta, time_step)
    if axis not in (0, 1, 2) or not 0 <= index < data.shape[3-axis]:
        raise ValueError('切片轴或索引超出原始数据范围')
    selection = [time_step, slice(None), slice(None), slice(None)]
    selection[3-axis] = index
    plane = data[tuple(selection)]
    # Refuse excessive allocations explicitly; never silently reduce resolution.
    if plane.size > 16_777_216:
        raise ValueError('原始切面超过 1677 万像素，当前二维查看器无法载入；原始数据未改变')
    with np.errstate(over='ignore', invalid='ignore'):
        pixels = np.asarray(plane, dtype='<f4')
    valid = pixels[np.isfinite(pixels)]
    return packet({'kind': 'slice', 'axis': axis, 'index': index, 'time_step': time_step,
                   'shape_yx': list(plane.shape), 'original_dtype': data.dtype.str,
                   'range': [float(valid.min()), float(valid.max())] if len(valid) else None,
                   'voxel_xyz_to_world': grid_matrix(meta).tolist(),
                   'display_dtype': 'float32', 'resampled': False}, {'pixels': pixels})


def voxel_value(folder, meta, xyz, time_step=0):
    data = source_volume(folder, meta, time_step)
    if len(xyz) != 3 or any(not 0 <= v < data.shape[3-i] for i, v in enumerate(xyz)):
        raise ValueError('定位坐标超出原始数据范围')
    x, y, z = xyz
    # Text preserves uint64/int64 precision and explicitly identifies NaN/Inf.
    value = data[time_step, z, y, x].item()
    world = grid_matrix(meta) @ np.array([x, y, z, 1.0])
    return {'xyz': xyz, 'time_step': time_step, 'value': str(value),
            'dtype': data.dtype.str, 'world_xyz': world[:3].tolist()}
