"""Small spatial transforms without calling a threaded BLAS/LAPACK runtime.

HTTP slice requests run concurrently. These transforms have only three spatial
components, so vectorized elementwise arithmetic is sufficient and avoids the
native OpenBLAS access violation observed in the Windows frozen application.
"""
import numpy as np


def matrix_product(left, right):
    left, right = np.asarray(left, dtype=float), np.asarray(right, dtype=float)
    if (left.ndim != 2 or right.ndim != 2 or left.shape[1] != right.shape[0]
            or max(*left.shape, *right.shape) > 4):
        raise ValueError('仅支持小型空间变换矩阵')
    return np.array([[sum(float(left[i, k]) * float(right[k, j]) for k in range(left.shape[1]))
                      for j in range(right.shape[1])] for i in range(left.shape[0])])


def transform_points(points, matrix):
    points, matrix = np.asarray(points, dtype=float), np.asarray(matrix, dtype=float)
    if points.shape[-1:] != (3,) or matrix.shape != (4, 4):
        raise ValueError('空间坐标或变换矩阵维度无效')
    result = np.empty_like(points, dtype=float)
    for axis in range(3):
        row = matrix[axis]
        result[..., axis] = points[..., 0]*row[0] + points[..., 1]*row[1] + points[..., 2]*row[2] + row[3]
    return result


def determinant3(matrix):
    (a, b, c), (d, e, f), (g, h, i) = [[float(v) for v in row] for row in matrix]
    return a*(e*i-f*h) - b*(d*i-f*g) + c*(d*h-e*g)


def inverse_affine(matrix):
    matrix = np.asarray(matrix, dtype=float)
    if matrix.shape != (4, 4) or not np.isfinite(matrix).all() or not np.allclose(matrix[3], [0, 0, 0, 1]):
        raise ValueError('空间矩阵必须为有限仿射变换')
    # Normalize columns first: physical voxel units may be much smaller than 1.
    scale = np.max(np.abs(matrix[:3, :3]), axis=0)
    if np.any(scale == 0): raise ValueError('体素空间矩阵不可逆')
    normalized = matrix[:3, :3] / scale
    (a, b, c), (d, e, f), (g, h, i) = normalized.tolist()
    det = determinant3(normalized)
    if not np.isfinite(det) or det == 0: raise ValueError('体素空间矩阵不可逆')
    inverse = np.eye(4)
    inverse[:3, :3] = np.array([[e*i-f*h, c*h-b*i, b*f-c*e],
                               [f*g-d*i, a*i-c*g, c*d-a*f],
                               [d*h-e*g, b*g-a*h, a*e-b*d]]) / det / scale[:, None]
    inverse[:3, 3] = -transform_points(matrix[:3, 3], inverse)
    if not np.isfinite(inverse).all(): raise ValueError('体素空间矩阵超出可计算范围')
    return inverse
