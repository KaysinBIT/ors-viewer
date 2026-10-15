"""Local, asynchronous imports. Sources are read-only; every run has its own directory."""
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import subprocess
import sys
import threading
import uuid

import numpy as np

EXTENSIONS = {'.orssession', '.orsobject', '.npy', '.stl'}


def validate_source(path):
    path = Path(path).expanduser().resolve(strict=True)
    if not path.is_file() or path.suffix.lower() not in EXTENSIONS:
        raise ValueError('支持 .ORSSession、.ORSObject、.STL 和三维/四维 .NPY 文件')
    if path.suffix.lower() in {'.orssession', '.orsobject'}:
        with path.open('rb') as stream: magic = stream.read(4)
        if magic not in (b'ORSD', b'ORSZ', b'CAIF'):
            raise ValueError('文件头不是已支持的 ORSD / ORSZ / CAIF 容器')
    return path


def import_standard(source, output, title=None):
    """Convert NPY volume / binary or ASCII STL to the existing display contract."""
    folder = output / 'data' / 'object_00000';folder.mkdir(parents=True)
    meta = {'object_index': 0, 'directory': 'object_00000', 'status': 'decoded',
            'title': title or source.stem, 'attributes': {}, 'tables': [], 'files': []}
    if source.suffix.lower() == '.npy':
        data = np.load(source, mmap_mode='r', allow_pickle=False)
        if data.ndim not in (3, 4) or data.dtype.kind not in 'biuf' or any(n < 1 for n in data.shape):
            raise ValueError('NPY 必须是非空数值数组，轴顺序为 ZYX 或 TZYX')
        if data.ndim == 3: data = data[None]
        np.save(folder / 'volume.npy', data, allow_pickle=False)
        meta.update(type='CxvChannel', grid={'shape_tzyx': list(data.shape),
                    'size_xyz': list(data.shape[:0:-1]), 'spacing_xyz': [1, 1, 1],
                    'voxel_xyz_to_world': np.eye(4).tolist()}, files=[{'file': 'volume.npy'}],
                    coordinate_unit='voxel', import_note='NPY 未提供物理标定，间距为 1 个体素。')
    else:
        size = source.stat().st_size
        with source.open('rb') as stream: head = stream.read(84)
        count = int.from_bytes(head[80:84], 'little') if len(head) == 84 else 0
        if size == 84 + count * 50 and count:
            dtype = np.dtype([('normal', '<f4', 3), ('vertices', '<f4', (3, 3)), ('attr', '<u2')])
            rows = np.memmap(source, dtype=dtype, mode='r', offset=84, shape=(count,))
            vertices = np.asarray(rows['vertices']).reshape(-1, 3).copy()
        else:
            coords = []
            with source.open('r', encoding='ascii') as stream:
                for line in stream:
                    parts = line.split()
                    if parts and parts[0].lower() == 'vertex':
                        if len(parts) != 4: raise ValueError('STL 顶点行无效')
                        coords.append([float(v) for v in parts[1:]])
            vertices = np.asarray(coords, dtype='<f4')
        if vertices.ndim != 2 or vertices.shape[1] != 3 or not len(vertices) or len(vertices) % 3 or not np.isfinite(vertices).all():
            raise ValueError('STL 没有有效三角面')
        points, inverse = np.unique(vertices, axis=0, return_inverse=True)
        faces = inverse.reshape(-1, 3).astype('<u4')
        np.save(folder / 'vertices.npy', points);np.save(folder / 'triangles.npy', faces)
        meta.update(type='CxvFaceVertexMesh', vertex_count=len(points), triangle_count=len(faces),
                    files=[{'file': 'vertices.npy'}, {'file': 'triangles.npy'}],
                    coordinate_unit='source', import_note='STL 不含单位；保留原坐标。')
    (folder / 'metadata.json').write_text(json.dumps(meta, ensure_ascii=False), 'utf-8')
    (output / 'data' / 'decode_report.json').write_text(json.dumps({
        'raw_container_complete': True, 'objects': [meta]}, ensure_ascii=False), 'utf-8')


class ImportJobs:
    def __init__(self, directory, catalog):
        self.directory = Path(directory);self.directory.mkdir(parents=True, exist_ok=True)
        self.catalog = catalog
        self.lock = threading.RLock();self.jobs = {}
        self.processes = {};self.closing = False
        self.pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix='ors-import')
        for marker in self.directory.glob('*/import.json'):
            try:
                job = json.loads(marker.read_text('utf-8'))
                if job['status'] == 'completed':
                    dataset = catalog.add(marker.parent / 'result', job['name'])
                    job['dataset_id'] = dataset['id']
                elif job['status'] in ('queued', 'running'):
                    job.update(status='failed', message='服务已重启，请重新导入；已有输出保留。')
                self.jobs[job['id']] = job
            except (ValueError, OSError, KeyError): continue

    def create(self, source, name=None):
        source = validate_source(source)
        with self.lock:
            if self.closing: raise ValueError('软件正在退出')
            if sum(j['status'] in ('queued', 'running') for j in self.jobs.values()) >= 4:
                raise ValueError('已有 4 个导入任务，请等待完成后再导入')
            key = uuid.uuid4().hex
            folder = self.directory / key;folder.mkdir()
            job = {'id': key, 'name': name or source.stem, 'source': str(source),
                   'output': str(folder / 'result'), 'status': 'queued', 'message': '等待解析'}
            self.jobs[key] = job;self._save(job)
            self.pool.submit(self._run, key)
            return dict(job)

    def _save(self, job):
        (self.directory / job['id'] / 'import.json').write_text(json.dumps(job, ensure_ascii=False), 'utf-8')

    def _update(self, key, **fields):
        with self.lock:
            self.jobs[key].update(fields);self._save(self.jobs[key])

    def get(self, key):
        with self.lock:
            if key not in self.jobs: raise KeyError('导入任务不存在')
            job = dict(self.jobs[key])
        if job['status'] == 'running':
            output = Path(job['output'])
            if (output / 'data').exists(): job['message'] = '正在解码体数据、标签、网格和测量表'
            elif (output / 'raw').exists(): job['message'] = '正在提取和校验二进制记录'
        return job

    def _run(self, key):
        job = self.get(key);source = Path(job['source']);output = Path(job['output'])
        self._update(key, status='running', message='正在校验文件并准备解析')
        try:
            warning = ''
            if source.suffix.lower() in {'.orssession', '.orsobject'}:
                log = output.parent / 'parser.log'
                with log.open('wb') as stream:
                    command = [sys.executable] if getattr(sys, 'frozen', False) else [sys.executable, '-m', 'ors_viewer']
                    command += ['--worker-extract', str(source), '--output', str(output)]
                    with self.lock:
                        if self.closing: raise ValueError('软件已退出，解析未完成')
                        process = subprocess.Popen(command, stdout=stream, stderr=subprocess.STDOUT,
                                                   creationflags=getattr(subprocess, 'CREATE_NO_WINDOW', 0))
                        self.processes[key] = process
                    returncode = process.wait()
                    with self.lock: self.processes.pop(key, None)
                report_path = output / 'job.json'
                report = json.loads(report_path.read_text('utf-8')) if report_path.exists() else {}
                if returncode or not report.get('source_unchanged') or not report.get('raw_complete'):
                    raise ValueError(report.get('error') or f"解析未完整完成：{report.get('status', 'failed')}，详见 {log}")
                warning = '已提取支持的对象；未解释的内部记录仍保存在 raw 目录中。'
            else:
                import_standard(source, output, job['name'])
            dataset = self.catalog.add(output, job['name'])
            self._update(key, status='completed', message='解析完成，正在载入三维模型',
                         dataset_id=dataset['id'], object_count=len(dataset['objects']), warning=warning)
        except Exception as exc:
            self._update(key, status='failed', message=str(exc))

    def close(self):
        with self.lock:
            self.closing = True
            for process in list(self.processes.values()):
                if process.poll() is None: process.terminate()
            for job in list(self.jobs.values()):
                if job['status'] == 'queued': self._update(job['id'], status='failed', message='软件已退出，请重新导入')
        self.pool.shutdown(wait=False, cancel_futures=True)
