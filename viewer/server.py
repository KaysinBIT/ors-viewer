#!/usr/bin/env python3
"""Loopback-only local viewer for independent ORS decoding results."""
import argparse
import errno
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import math
import logging
import mimetypes
import os
from pathlib import Path
import secrets
import socket
import threading
import uuid
from urllib.parse import parse_qs, unquote, urlsplit
import webbrowser

import numpy as np
from .preview import PreviewCache, safe_file, unit_of
from .slices import slice_packet, voxel_value
from .alignment import dataset_alignment, save_alignment
from .reslice import geometry as reslice_geometry, reslice_packet, reslice_probe
from .imports import ImportJobs, EXTENSIONS
from .file_browser import list_directory, create_directory
from .settings import validate_directory, save_directory, load_port, save_port, validate_port, load_theme, save_theme

JSON_BODY_LIMIT = 8192
MAX_UPLOAD_BYTES = 64 * 1024**3
STREAM_CHUNK_BYTES = 1024 * 1024
UPLOAD_TIMEOUT_SECONDS = 120
DEFAULT_TABLE_PAGE_SIZE = 50
MAX_TABLE_PAGE_SIZE = 100
SETTINGS_ROUTES = frozenset({
    '/api/filesystem/list', '/api/filesystem/mkdir', '/api/settings/data-directory',
    '/api/settings/port', '/api/settings/theme',
})

HERE = Path(__file__).resolve().parent
WEB = HERE / 'web'
KINDS = {'CxvFaceVertexMesh': 'mesh', 'CxvChannel': 'volume',
         'CxvVolume_ROI': 'labels', 'CxvLabeledMultiROI': 'labels'}


class LocalHTTPServer(ThreadingHTTPServer):
    # Windows SO_REUSEADDR permits another listener on an occupied port.
    allow_reuse_address = os.name != 'nt'

    def server_bind(self):
        if os.name == 'nt': self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()


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
        with self.lock: return [{k: v for k, v in d.items() if not k.startswith('_')} for d in self.datasets.values()]


def table_data(folder, meta, group, start=0, limit=DEFAULT_TABLE_PAGE_SIZE):
    table = next((t for t in meta.get('tables', []) if t['group'] == group), None)
    if table is None: raise ValueError('测量表不存在')
    total = int(table['row_count'])
    start = max(0, min(start, max(0, total - 1)))
    stop = min(total, start + max(1, min(limit, MAX_TABLE_PAGE_SIZE)))
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


def handler(catalog, cache, token, imports=None, workspace=None):
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
                for block in iter(lambda: stream.read(STREAM_CHUNK_BYTES), b''): self.wfile.write(block)

        def do_GET(self):
            try:
                url = urlsplit(self.path);route = unquote(url.path);q = parse_qs(url.query)
                if route == '/api/catalog': return self.json({'datasets': catalog.public()})
                if route == '/api/health': return self.json({'ok': True, 'version': '1.2.0RC4'})
                if route == '/api/settings':
                    return self.json(workspace.public() if workspace else {'ready': True, 'data_directory': None, 'message': ''})
                parts = route.strip('/').split('/')
                if len(parts) == 4 and parts[:2] == ['api', 'datasets'] and parts[3] == 'alignment':
                    return self.json(dataset_alignment(catalog, parts[2], workspace.settings_file if workspace else None))
                active_imports = workspace.imports if workspace else imports
                active_cache = workspace.cache if workspace else cache
                if len(parts) == 3 and parts[:2] == ['api', 'imports'] and active_imports:
                    return self.json(active_imports.get(parts[2]))
                if len(parts) >= 3 and parts[:2] == ['api', 'objects']:
                    return self.object_response(parts, q, active_cache)
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

        def object_response(self, parts, q, active_cache):
            folder, meta = catalog.get(parts[2])
            # Preserve legacy path fallback and query defaults, including extra segments.
            action = parts[3] if len(parts) == 4 else 'metadata'
            if action == 'metadata': return self.json(meta)
            if action == 'slice':
                payload = slice_packet(folder, meta, int(q.get('axis', ['2'])[0]),
                                       int(q.get('index', ['0'])[0]), int(q.get('time', ['0'])[0]))
                self.send_headers(mime='application/octet-stream', length=len(payload))
                self.end_headers();self.wfile.write(payload)
                return
            if action == 'voxel':
                return self.json(voxel_value(folder, meta, [int(q.get(k, ['0'])[0]) for k in ('x', 'y', 'z')],
                                             int(q.get('time', ['0'])[0])))
            if action == 'preview':
                if active_cache is None: raise ValueError('请先设置数据目录')
                path = active_cache.get(folder, meta, q.get('quality', ['balanced'])[0],
                                 int(q.get('time', ['0'])[0]), int(q.get('label', ['0'])[0]), float(q.get('retention', ['100'])[0]))
                return self.file(path)
            if action == 'table':
                return self.json(table_data(folder, meta, q.get('group', [''])[0],
                                            int(q.get('start', ['0'])[0]), int(q.get('limit', [str(DEFAULT_TABLE_PAGE_SIZE)])[0])))
            if action == 'download':
                name = q.get('file', [''])[0]
                if name not in download_files(meta): raise ValueError('文件不在该对象的导出清单内')
                return self.file(safe_file(folder, name), True)
            raise KeyError('接口不存在')

        def do_POST(self):
            try:
                expected = 'http://127.0.0.1:%d' % self.server.server_port
                if self.headers.get('Origin') != expected or self.headers.get('X-Viewer-Token') != token:
                    return self.json({'error': '请从本地查看器页面操作'}, 403)
                url = urlsplit(self.path)
                size = int(self.headers.get('Content-Length', 0))
                active_imports = workspace.imports if workspace else imports
                if url.path in SETTINGS_ROUTES:
                    return self.settings_response(url.path, size)
                if workspace and not workspace.ready: raise ValueError('请先完成首次数据目录设置')
                parts = url.path.strip('/').split('/')
                if len(parts) == 4 and parts[:2] == ['api', 'datasets'] and parts[3] == 'alignment':
                    if parts[2] not in catalog.datasets: raise ValueError('数据集不存在')
                    body = self.read_json_body(size)
                    return self.json({'pose': save_alignment(workspace.settings_file if workspace else None, parts[2], body['pose'])})
                if len(parts) == 4 and parts[:2] == ['api', 'objects'] and parts[3] in ('reslice-info', 'reslice', 'reslice-probe'):
                    body = self.read_json_body(size); folder, meta = catalog.get(parts[2])
                    if parts[3] == 'reslice-info': return self.json(reslice_geometry(meta, body['pose'])[0])
                    if parts[3] == 'reslice-probe':
                        return self.json(reslice_probe(folder, meta, body['pose'], body['xyz'], body.get('time', 0)))
                    payload = reslice_packet(folder, meta, body['pose'], body['axis'], body['coordinate'], body.get('time', 0))
                    self.send_headers(mime='application/octet-stream', length=len(payload))
                    self.end_headers(); self.wfile.write(payload)
                    return
                if url.path == '/api/import-upload' and active_imports:
                    return self.upload_response(url.query, size, active_imports)
                if url.path not in ('/api/datasets', '/api/imports'): return self.json({'error': '接口不存在'}, 404)
                body = self.read_json_body(size)
                if url.path == '/api/imports':
                    if not active_imports: raise ValueError('文件导入未启用')
                    return self.json(active_imports.create(body['path']), 202)
                return self.json(catalog.add(body['path']))
            except Exception as exc: self.json({'error': str(exc)}, 400)

        def read_json_body(self, size):
            if not 0 < size <= JSON_BODY_LIMIT:
                raise ValueError('请求大小无效')
            return json.loads(self.rfile.read(size))

        def settings_response(self, route, size):
            body = self.read_json_body(size)
            if route == '/api/filesystem/list':
                return self.json(list_directory(body.get('path', ''), body.get('kind', 'file'), body.get('offset', 0), body.get('query', '')))
            if route == '/api/filesystem/mkdir':
                return self.json({'path': create_directory(body['path'], body['name'])})
            if workspace is None: raise ValueError('数据目录设置不可用')
            if route == '/api/settings/theme':
                save_theme(workspace.settings_file, body['theme'])
                return self.json(workspace.public())
            if route == '/api/settings/port':
                workspace.choose_port(body['port'])
                return self.json(workspace.public())
            workspace.choose(body['path'])
            return self.json(workspace.public())

        def upload_response(self, query, size, active_imports):
            filename = Path(parse_qs(query).get('name', [''])[0]).name
            if Path(filename).suffix.lower() not in EXTENSIONS: raise ValueError('不支持该文件类型')
            if not 0 < size <= MAX_UPLOAD_BYTES: raise ValueError('文件大小须在 1 字节至 64 GiB 之间；更大文件请通过路径导入')
            uploads = active_imports.directory / 'uploads';uploads.mkdir(exist_ok=True)
            target = uploads / (uuid.uuid4().hex + Path(filename).suffix.lower())
            try:
                self.connection.settimeout(UPLOAD_TIMEOUT_SECONDS)
                with target.open('xb') as stream:
                    remaining = size
                    while remaining:
                        block = self.rfile.read(min(STREAM_CHUNK_BYTES, remaining))
                        if not block: raise ValueError('上传中断，请重试')
                        stream.write(block);remaining -= len(block)
                return self.json(active_imports.create(target, Path(filename).stem), 202)
            except Exception:
                target.unlink(missing_ok=True);raise

        def log_message(self, fmt, *args):
            if '/api/objects/' in self.path and '/preview' not in self.path: return
            logging.info(fmt, *args)
    return Handler


class Workspace:
    def __init__(self, settings_file=None, directories=(), message='', on_ready=None):
        self.catalog = Catalog();self.cache = None;self.imports = None;self.directory = None
        self.settings_file = settings_file;self.directories = directories;self.message = message
        self.on_ready = on_ready;self.lock = threading.RLock();self.ready = False;self.server = None
        self.requested_port = 0;self.port_warning = '';self.port_source = 'default'

    def public(self):
        with self.lock:
            saved_port, settings_warning = load_port(self.settings_file)
            return {'ready': self.ready, 'data_directory': str(self.directory) if self.directory else None,
                    'message': self.message, 'port': self.server.server_port if self.server else None,
                    'saved_port': saved_port, 'port_source': self.port_source,
                    'theme': load_theme(self.settings_file),
                    'port_warning': self.port_warning or settings_warning,
                    'restart_required': saved_port != self.requested_port}

    def choose_port(self, port):
        with self.lock:
            save_port(self.settings_file, port)
            self.port_warning = ''

    def activate(self, directory, persist=False):
        with self.lock:
            if self.ready: raise ValueError('数据目录已设置。如需更换，请使用 --choose-data-dir 重新启动软件')
            directory = validate_directory(directory)
            catalog = Catalog()
            for path in self.directories: catalog.add(path)
            cache = PreviewCache(directory / 'cache')
            imports = ImportJobs(directory / 'imported', catalog)
            try:
                if not catalog.public():
                    from .imports import import_standard
                    demo = directory / 'example'
                    if not (demo / 'data' / 'decode_report.json').exists():
                        import_standard(HERE / 'fixtures' / 'tetrahedron.stl', demo, '示例 · 四面体')
                    catalog.add(demo, '内置示例')
                runtime = directory / 'runtime';runtime.mkdir(exist_ok=True)
                if self.on_ready: self.on_ready(directory)
                if self.server: self.write_runtime(directory)
                if persist and self.settings_file: save_directory(self.settings_file, directory)
                with self.catalog.lock:
                    self.catalog.datasets = catalog.datasets;self.catalog.objects = catalog.objects
                self.cache = cache;self.imports = imports;self.directory = directory;self.ready = True;self.message = ''
            except Exception:
                imports.close();raise

    def choose(self, directory): self.activate(directory, persist=True)

    def write_runtime(self, directory=None):
        directory = directory or self.directory
        if directory is not None and self.server:
            url = 'http://127.0.0.1:%d/' % self.server.server_port
            (directory / 'runtime' / 'server.json').write_text(json.dumps({'url': url, 'pid': os.getpid()}), encoding='utf-8')

    def close(self):
        if self.imports: self.imports.close()


def make_server(port, directories, state_dir=None, settings_file=None, setup_message='', on_ready=None, recover_directory=False):
    workspace = Workspace(settings_file, directories, setup_message, on_ready)
    saved_port, warning = load_port(settings_file)
    requested = saved_port if port is None else validate_port(port)
    workspace.requested_port = requested
    workspace.port_source = 'command-line' if port is not None else ('saved' if saved_port else 'default')
    workspace.port_warning = warning if port is None else ''
    request_handler = handler(workspace.catalog, None, secrets.token_hex(24), workspace=workspace)
    try:
        server = LocalHTTPServer(('127.0.0.1', requested), request_handler)
    except OSError as exc:
        if exc.errno not in (errno.EADDRINUSE, errno.EACCES, 10048, 10013): raise
        if port is not None or requested == 0:
            raise ValueError(f'无法监听端口 {requested}：端口被占用或无绑定权限。请使用 --port 指定其他端口，或用 --port 0 自动分配。') from exc
        server = LocalHTTPServer(('127.0.0.1', 0), request_handler)
        workspace.requested_port = 0
        workspace.port_warning = f'保存的端口 {requested} 被占用或无绑定权限，本次临时使用 {server.server_port}。已保存的端口未改变，可在端口设置中修改。'
    server.daemon_threads = True;server.workspace = workspace;workspace.server = server
    try:
        if state_dir is not None:
            try: workspace.activate(validate_directory(state_dir, create=not recover_directory))
            except (OSError, ValueError):
                if not recover_directory: raise
                workspace.message = '已保存的数据目录无法使用，请重新选择。已有文件保持不变。'
        workspace.write_runtime()
    except Exception:
        workspace.close();server.server_close();raise
    return server, 'http://127.0.0.1:%d/' % server.server_port
