#!/usr/bin/env python3
"""Loopback-only local viewer for independent ORS decoding results."""
import argparse
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import logging
import mimetypes
import os
from pathlib import Path
import secrets
import threading
import uuid
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser

import numpy as np
from .preview import PreviewCache, safe_file, unit_of
from .imports import ImportJobs, EXTENSIONS

HERE = Path(__file__).resolve().parent
WEB = HERE / 'web'
KINDS = {'CxvFaceVertexMesh': 'mesh', 'CxvChannel': 'volume',
         'CxvVolume_ROI': 'labels', 'CxvLabeledMultiROI': 'labels'}


def clean_json(value):
    if isinstance(value, dict): return {str(k): clean_json(v) for k, v in value.items()}
    if isinstance(value, (list, tuple)): return [clean_json(x) for x in value]
    if isinstance(value, np.generic): return clean_json(value.item())
    if isinstance(value, float) and not math.isfinite(value): return None
    return value


class Catalog:
    def __init__(self):
        self.datasets = {}
        self.objects = {}
        self.lock = threading.RLock()

    def add(self, directory, name=None):
        path = Path(directory).expanduser().resolve(strict=True)
        if (path / 'data' / 'decode_report.json').is_file(): path = path / 'data'
        report_file = path / 'decode_report.json'
        if not report_file.is_file():
            raise ValueError('请选择包含 decode_report.json 的 data 目录，或解析输出根目录')
        report = json.loads(report_file.read_text('utf-8'))
        key = hashlib.sha256(str(path).encode()).hexdigest()[:16]
        objects = []
        for row in report.get('objects', []):
            if row.get('type') not in KINDS or row.get('status') != 'decoded': continue
            folder = (path / row['directory']).resolve()
            if path not in folder.parents: raise ValueError('对象路径越出数据目录')
            metadata = safe_file(folder, 'metadata.json')
            meta = json.loads(metadata.read_text('utf-8'))
            oid = key + '-' + str(row['object_index'])
            objects.append({'id': oid, 'dataset': key, 'index': row['object_index'],
                            'title': meta.get('title') or '未命名对象', 'kind': KINDS[row['type']],
                            'type': row['type'], 'hidden': str(meta.get('attributes', {}).get('privateTitle', '')).startswith('undo'),
                            'vertex_count': meta.get('vertex_count'), 'triangle_count': meta.get('triangle_count'),
                            'shape': meta.get('grid', {}).get('shape_tzyx'),
                            'label_count': len(meta.get('label_voxel_counts', {})),
                            'foreground_voxels': meta.get('foreground_voxels')})
            self.objects[oid] = folder
        if not objects: raise ValueError('该目录没有可显示的网格、体数据或分割对象')
        dataset_name = name or self.datasets.get(key, {}).get('name') or (path.parent.name if path.name == 'data' else path.name)
        dataset = {'id': key, 'name': dataset_name,
                   'path': str(path), 'objects': objects, 'raw_complete': report.get('raw_container_complete', False)}
        with self.lock: self.datasets[key] = dataset
        return dataset

    def get(self, oid):
        with self.lock: folder = self.objects.get(oid)
        if folder is None: raise KeyError('对象不存在')
        return folder, json.loads(safe_file(folder, 'metadata.json').read_text('utf-8'))

    def public(self):
        with self.lock: return list(self.datasets.values())


def table_data(folder, meta, group, start=0, limit=50):
    table = next((t for t in meta.get('tables', []) if t['group'] == group), None)
    if table is None: raise ValueError('测量表不存在')
    total = int(table['row_count'])
    start = max(0, min(start, max(0, total - 1)))
    stop = min(total, start + max(1, min(limit, 100)))
    columns, values = [], []
    for column in table['columns']:
        path = safe_file(folder, column['file'])
        if path.suffix == '.npy':
            data = np.load(path, mmap_mode='r', allow_pickle=False)
            data = np.asarray(data[start:stop]) * column.get('slope', 1) + column.get('offset', 0)
            values.append(data.tolist())
        else:
            values.append(json.loads(path.read_text('utf-8'))[start:stop])
        columns.append({'name': column.get('name') or '字段 %d' % column['index'],
                        'unit': unit_of(column), 'index': column['index']})
    rows = [[i, *[v[i - start] for v in values]] for i in range(start, stop)]
    return {'columns': columns, 'rows': rows, 'start': start, 'total': total,
            'row_kind': table.get('row_kind'), 'csv_file': table.get('csv', {}).get('file')}


def download_files(meta):
    files = {'metadata.json', 'original_object.xml'}
    for record in meta.get('files', []): files.add(record['file'])
    for key in ('dense_labels', 'ply'):
        if meta.get(key, {}).get('file'): files.add(meta[key]['file'])
    for table in meta.get('tables', []):
        for column in table.get('columns', []): files.add(column['file'])
        if table.get('csv', {}).get('file'): files.add(table['csv']['file'])
    return files


def handler(catalog, cache, token, imports=None):
    class Handler(BaseHTTPRequestHandler):
        def send_headers(self, status=200, mime='application/json; charset=utf-8', length=None):
            self.send_response(status)
            self.send_header('Content-Type', mime)
            self.send_header('X-Content-Type-Options', 'nosniff')
            self.send_header('X-Frame-Options', 'DENY')
            self.send_header('Cache-Control', 'no-store')
            if length is not None: self.send_header('Content-Length', str(length))

        def json(self, data, status=200):
            payload = json.dumps(clean_json(data), ensure_ascii=False, allow_nan=False).encode('utf-8')
            self.send_headers(status, length=len(payload));self.end_headers();self.wfile.write(payload)

        def file(self, path, download=False):
            mime = mimetypes.guess_type(path.name)[0] or 'application/octet-stream'
            if path.suffix == '.js': mime = 'text/javascript; charset=utf-8'
            self.send_headers(mime=mime, length=path.stat().st_size)
            if download: self.send_header('Content-Disposition', 'attachment; filename="%s"' % path.name)
            self.end_headers()
            with path.open('rb') as stream:
                for block in iter(lambda: stream.read(1024 * 1024), b''): self.wfile.write(block)

        def do_GET(self):
            try:
                url = urlsplit(self.path);route = unquote(url.path);q = parse_qs(url.query)
                if route == '/api/catalog': return self.json({'datasets': catalog.public()})
                if route == '/api/health': return self.json({'ok': True, 'version': '0.6.0'})
                parts = route.strip('/').split('/')
                if len(parts) == 3 and parts[:2] == ['api', 'imports'] and imports:
                    return self.json(imports.get(parts[2]))
                if len(parts) >= 3 and parts[:2] == ['api', 'objects']:
                    folder, meta = catalog.get(parts[2])
                    action = parts[3] if len(parts) == 4 else 'metadata'
                    if action == 'metadata': return self.json(meta)
                    if action == 'preview':
                        path = cache.get(folder, meta, q.get('quality', ['balanced'])[0],
                                         int(q.get('time', ['0'])[0]), int(q.get('label', ['0'])[0]), float(q.get('retention', ['100'])[0]))
                        return self.file(path)
                    if action == 'table':
                        return self.json(table_data(folder, meta, q.get('group', [''])[0],
                                                    int(q.get('start', ['0'])[0]), int(q.get('limit', ['50'])[0])))
                    if action == 'download':
                        name = q.get('file', [''])[0]
                        if name not in download_files(meta): raise ValueError('文件不在该对象的导出清单内')
                        return self.file(safe_file(folder, name), True)
                    raise KeyError('接口不存在')
                if route in ('/', '/index.html'):
                    data = (WEB / 'index.html').read_text('utf-8').replace('__VIEWER_TOKEN__', token).encode('utf-8')
                    self.send_headers(mime='text/html; charset=utf-8', length=len(data));self.end_headers();self.wfile.write(data)
                    return
                return self.file(safe_file(WEB, route.lstrip('/')))
            except (BrokenPipeError, ConnectionResetError): pass
            except KeyError as exc: self.json({'error': str(exc)}, 404)
            except Exception as exc:
                self.log_error('%s', exc)
                self.json({'error': str(exc)}, 400)

        def do_POST(self):
            try:
                expected = 'http://127.0.0.1:%d' % self.server.server_port
                if self.headers.get('Origin') != expected or self.headers.get('X-Viewer-Token') != token:
                    return self.json({'error': '请从本地查看器页面操作'}, 403)
                url = urlsplit(self.path)
                size = int(self.headers.get('Content-Length', 0))
                if url.path == '/api/import-upload' and imports:
                    filename = Path(parse_qs(url.query).get('name', [''])[0]).name
                    if Path(filename).suffix.lower() not in EXTENSIONS: raise ValueError('不支持该文件类型')
                    if not 0 < size <= 64 * 1024**3: raise ValueError('文件大小须在 1 字节至 64 GiB 之间；更大文件请通过路径导入')
                    uploads = imports.directory / 'uploads';uploads.mkdir(exist_ok=True)
                    target = uploads / (uuid.uuid4().hex + Path(filename).suffix.lower())
                    try:
                        self.connection.settimeout(120)
                        with target.open('xb') as stream:
                            remaining = size
                            while remaining:
                                block = self.rfile.read(min(1024 * 1024, remaining))
                                if not block: raise ValueError('上传中断，请重试')
                                stream.write(block);remaining -= len(block)
                        return self.json(imports.create(target, Path(filename).stem), 202)
                    except Exception:
                        target.unlink(missing_ok=True);raise
                if url.path not in ('/api/datasets', '/api/imports'): return self.json({'error': '接口不存在'}, 404)
                if not 0 < size <= 8192: raise ValueError('请求大小无效')
                body = json.loads(self.rfile.read(size))
                if url.path == '/api/imports':
                    if not imports: raise ValueError('文件导入未启用')
                    return self.json(imports.create(body['path']), 202)
                return self.json(catalog.add(body['path']))
            except Exception as exc: self.json({'error': str(exc)}, 400)

        def log_message(self, fmt, *args):
            if '/api/objects/' in self.path and '/preview' not in self.path: return
            logging.info(fmt, *args)
    return Handler


def make_server(port, directories, state_dir):
    state_dir = Path(state_dir).resolve();state_dir.mkdir(parents=True, exist_ok=True)
    catalog = Catalog()
    for path in directories: catalog.add(path)
    runtime = state_dir / 'runtime';runtime.mkdir(exist_ok=True)
    cache = PreviewCache(state_dir / 'cache')
    imports = ImportJobs(state_dir / 'imported', catalog)
    if not catalog.public():
        from .imports import import_standard
        demo = state_dir / 'example'
        if not (demo / 'data' / 'decode_report.json').exists():
            import_standard(HERE / 'fixtures' / 'tetrahedron.stl', demo, '示例 · 四面体')
        catalog.add(demo, '内置示例')
    server = ThreadingHTTPServer(('127.0.0.1', port), handler(catalog, cache, secrets.token_hex(24), imports))
    server.daemon_threads = True
    server.import_jobs = imports
    url = 'http://127.0.0.1:%d/' % server.server_port
    (runtime / 'server.json').write_text(json.dumps({'url': url, 'pid': os.getpid()}), encoding='utf-8')
    return server, url
