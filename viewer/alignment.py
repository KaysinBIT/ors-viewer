"""Dataset display poses. Source arrays and source-coordinate exports stay intact."""
import itertools
from pathlib import Path

import numpy as np

from .preview import array, grid_matrix
from .settings import _write_lock, read_settings, update_settings


def validate_pose(value):
    if not isinstance(value, dict) or type(value.get('enabled')) is not bool:
        raise ValueError('对齐参数无效')
    rotation = np.asarray(value.get('rotation'), dtype=float)
    pivot = np.asarray(value.get('pivot'), dtype=float)
    if (rotation.shape != (3, 3) or pivot.shape != (3,) or
            not np.isfinite(rotation).all() or not np.isfinite(pivot).all() or
            not np.allclose(rotation.T @ rotation, np.eye(3), atol=1e-8, rtol=0) or
            not np.isclose(np.linalg.det(rotation), 1, atol=1e-8, rtol=0)):
        raise ValueError('旋转矩阵必须为有效刚性旋转；镜像请使用独立的 XYZ 镜像开关')
    mirror = value.get('mirror', [False, False, False])
    if not isinstance(mirror, list) or len(mirror) != 3 or any(type(flag) is not bool for flag in mirror):
        raise ValueError('镜像开关必须为三个布尔值，分别对应 X、Y、Z')
    return {'enabled': value['enabled'], 'rotation': rotation.tolist(), 'pivot': pivot.tolist(), 'mirror': mirror.copy()}


def pose_matrix(value):
    pose = validate_pose(value)
    matrix = np.eye(4)
    if pose['enabled']:
        rotation, pivot = np.asarray(pose['rotation']), np.asarray(pose['pivot'])
        # Mirror the rotated dataset about fixed world axes through its pivot.
        linear = np.where(pose['mirror'], -1.0, 1.0)[:, None] * rotation
        matrix[:3, :3] = linear
        matrix[:3, 3] = pivot - linear @ pivot
    if not np.isfinite(matrix).all():
        raise ValueError('旋转中心超出可计算坐标范围')
    return matrix


def transformed_bounds(low, high, matrix):
    corners = np.array([(*p, 1) for p in itertools.product(*zip(low, high))]) @ matrix.T
    return np.array([corners[:, :3].min(axis=0), corners[:, :3].max(axis=0)])


def source_bounds(folder, meta):
    if meta.get('grid'):
        shape = np.asarray(meta['grid']['shape_tzyx'][1:][::-1])
        return transformed_bounds(np.full(3, -.5), shape - .5, grid_matrix(meta))
    vertices = array(folder, 'vertices.npy')
    if not vertices.size:
        return None
    # Chunked reductions avoid a second full-size copy for very large meshes.
    bounds = np.array([[np.inf]*3, [-np.inf]*3])
    for start in range(0, len(vertices), 262144):
        chunk = vertices[start:start+262144]
        if not np.isfinite(chunk).all():
            raise ValueError('模型含非有限坐标，无法确定数据集旋转中心')
        bounds[0] = np.minimum(bounds[0], chunk.min(axis=0))
        bounds[1] = np.maximum(bounds[1], chunk.max(axis=0))
    return bounds


def dataset_alignment(catalog, dataset_id, settings_file):
    with catalog.lock:
        dataset = catalog.datasets[dataset_id]
        if '_alignment_bounds' not in dataset:
            bounds = [source_bounds(*catalog.get(o['id'])) for o in dataset['objects']]
            bounds = [b for b in bounds if b is not None]
            if not bounds:
                raise ValueError('数据集没有有效空间范围')
            dataset['_alignment_bounds'] = [np.min([b[0] for b in bounds], axis=0).tolist(),
                                            np.max([b[1] for b in bounds], axis=0).tolist()]
        bounds = dataset['_alignment_bounds']
    pivot = np.mean(bounds, axis=0).tolist()
    pose = {'enabled': False, 'rotation': np.eye(3).tolist(), 'pivot': pivot, 'mirror': [False, False, False]}
    warning = ''
    if settings_file and Path(settings_file).is_file():
        try:
            saved = read_settings(settings_file).get('alignments', {}).get(dataset_id)
            if saved is not None: pose = validate_pose(saved)
        except (OSError, ValueError, TypeError, AttributeError):
            warning = '保存的对齐无效，已使用原始姿态；设置文件未改写。'
    return {'pose': pose, 'bounds': bounds, 'default_pivot': pivot, 'warning': warning}


def save_alignment(settings_file, dataset_id, pose):
    pose = validate_pose(pose)
    with _write_lock:
        data = read_settings(settings_file) if settings_file and Path(settings_file).is_file() else {}
        saved = dict(data.get('alignments', {}))
        saved[dataset_id] = pose
        update_settings(settings_file, {'alignments': saved})
    return pose
