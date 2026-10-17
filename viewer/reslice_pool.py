"""Bounded, shared CPU workers for full-resolution CT reslicing.

Workers open source arrays read-only through mmap; only plane fragments travel
between processes. The pool belongs to a server workspace and closes with it.
"""
from concurrent.futures import ProcessPoolExecutor, as_completed
from concurrent.futures.process import BrokenProcessPool
from multiprocessing.connection import wait
import logging
import math
import multiprocessing
import os
from pathlib import Path
import threading

AUTO_WORKERS = 8
MAX_WORKERS = 32
MIN_PARALLEL_PIXELS = 262_144
MIN_TASK_PIXELS = 65_536
MAX_ACTIVE_PLANES = 3


def available_cpus():
    return os.process_cpu_count() or 1


def validate_worker_count(value):
    if isinstance(value, str):
        value = value.strip()
        if not value.isascii() or not value.isdigit():
            raise ValueError('切片计算进程数须为整数；0 为自动，1 为串行')
        value = int(value)
    limit = min(MAX_WORKERS, available_cpus())
    if type(value) is not int or not 0 <= value <= limit:
        raise ValueError(f'切片计算进程数须为 0–{limit}；0 为自动，1 为串行')
    return value


def _sample_tile(folder, meta, pose, axis, coordinate, time, start, end):
    # Import lazily so importing the scheduler never creates another pool.
    from .reslice import Sampler, sample_range
    sampler = Sampler(Path(folder), meta, pose, time)
    values, mask = sample_range(sampler, axis, coordinate, start, end)
    return start, values, mask


def _guard_parent():
    """Read-only compute workers must not outlive an unexpectedly closed app."""
    # Set before the worker imports NumPy. Reslicing uses elementwise kernels;
    # extra BLAS threads only reserve buffers and compete with the process pool.
    os.environ['OPENBLAS_NUM_THREADS'] = '1'
    parent = multiprocessing.parent_process()
    if parent is None: return
    def stop_with_parent():
        wait([parent.sentinel])
        os._exit(0)
    threading.Thread(target=stop_with_parent, daemon=True, name='ors-parent-watch').start()


class ResliceExecutor:
    def __init__(self, workers=0, *, min_pixels=MIN_PARALLEL_PIXELS):
        requested = validate_worker_count(workers)
        self.workers = requested or min(AUTO_WORKERS, max(1, available_cpus()-1))
        self.min_pixels = min_pixels
        self._lock = threading.Lock()
        self._planes = threading.BoundedSemaphore(MAX_ACTIVE_PLANES)
        self._pool = None
        self._closed = False
        self._failed = False

    def _get_pool(self):
        with self._lock:
            if self._closed: raise RuntimeError('软件正在停止切片计算')
            if self._failed: return None
            if self._pool is None:
                self._pool = ProcessPoolExecutor(max_workers=self.workers,
                                                mp_context=multiprocessing.get_context('spawn'),
                                                initializer=_guard_parent)
                logging.info('CT reslice worker pool: %s processes', self.workers)
            return self._pool

    def sample(self, folder, meta, pose, axis, coordinate, time, count):
        if self.workers <= 1 or count < self.min_pixels: return None
        import numpy as np
        with self._planes:
            try:
                pool = self._get_pool()
                if pool is None: return None
                parts = min(self.workers, max(2, count//MIN_TASK_PIXELS))
                stride = math.ceil(count/parts)
                metadata = {'type': meta['type'], 'grid': meta['grid']}
                futures = [pool.submit(_sample_tile, str(Path(folder).resolve()), metadata, pose,
                                       axis, coordinate, time, start, min(start+stride, count))
                           for start in range(0, count, stride)]
                values = np.empty(count, dtype='<f4')
                mask = np.empty(count, dtype='u1')
                # Each fragment is independent; completion order cannot change sums.
                for future in as_completed(futures):
                    start, part, valid = future.result()
                    values[start:start+len(part)] = part
                    mask[start:start+len(part)] = valid
                return values, mask
            except (BrokenProcessPool, OSError) as error:
                # A worker/startup failure must not terminate the local service.
                with self._lock:
                    if self._closed: raise RuntimeError('软件正在停止切片计算') from error
                    failed_pool, self._pool = self._pool, None
                    if not self._failed: logging.warning('CT workers unavailable; using serial reslicing: %s', error)
                    self._failed = True
                if failed_pool is not None: failed_pool.shutdown(wait=False, cancel_futures=True)
                # Futures retain their exception object; release handled stack
                # frames so failed requests do not keep Windows mmap files open.
                error.__traceback__ = None
                return None

    def close(self):
        with self._lock:
            self._closed = True
            pool, self._pool = self._pool, None
        # At most three planes are submitted at once. Drain their fragments so
        # no worker or future remains attached to a stopped/restarted server.
        if pool is not None: pool.shutdown(wait=True)
