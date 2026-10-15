"""Directory listings for the local, authenticated file picker."""
import os
from pathlib import Path
from .imports import EXTENSIONS


def roots():
    entries = [{'name': '用户目录', 'path': str(Path.home()), 'kind': 'directory'}]
    if os.name == 'nt':
        for drive in sorted(os.listdrives()):
            entries.append({'name': drive.rstrip('\\/'), 'path': drive, 'kind': 'directory'})
    else: entries.append({'name': '文件系统', 'path': '/', 'kind': 'directory'})
    return {'path': '', 'parent': None, 'entries': entries, 'total': len(entries), 'offset': 0, 'limit': 200}


def list_directory(value='', kind='file', offset=0, query=''):
    if kind not in ('file', 'directory'): raise ValueError('无效选择类型')
    if not value: return roots()
    path = Path(value).expanduser()
    if not path.is_absolute(): raise ValueError('请选择完整的本地目录')
    path = path.resolve(strict=True)
    if not path.is_dir(): raise ValueError('所选位置不是文件夹')
    query = str(query).casefold();entries = []
    try:
        with os.scandir(path) as scan:
            for item in scan:
                try:
                    is_dir = item.is_dir()
                    if not is_dir and (kind == 'directory' or Path(item.name).suffix.lower() not in EXTENSIONS): continue
                    if query and query not in item.name.casefold(): continue
                    entries.append({'name': item.name, 'path': str(path / item.name),
                                    'kind': 'directory' if is_dir else 'file',
                                    'size': None if is_dir else item.stat().st_size})
                except OSError: continue
    except PermissionError as exc: raise ValueError('没有读取该文件夹的权限，请选择其他位置') from exc
    entries.sort(key=lambda e: (e['kind'] != 'directory', e['name'].casefold()))
    offset = max(0, int(offset));limit = 200
    return {'path': str(path), 'parent': str(path.parent) if path.parent != path else '',
            'entries': entries[offset:offset + limit], 'total': len(entries), 'offset': offset, 'limit': limit}


def create_directory(parent, name):
    parent = Path(parent).expanduser()
    if not parent.is_absolute() or not parent.is_dir(): raise ValueError('请先打开一个本地文件夹')
    name = str(name).strip()
    if not name or name in ('.', '..') or any(c in name for c in '/\\:\0'):
        raise ValueError('文件夹名称不能包含路径分隔符')
    target = parent.resolve() / name
    target.mkdir(exist_ok=False)
    return str(target)
