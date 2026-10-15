"""Local preferences and explicit data-directory validation."""
import json
import os
from pathlib import Path
import sys
import uuid


def settings_path():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(os.environ.get('XDG_CONFIG_HOME', Path.home() / '.config'))
    return base / 'ORSViewer' / 'settings.json'


def validate_directory(value, create=False):
    if not str(value).strip(): raise ValueError('请选择数据目录')
    path = Path(value).expanduser()
    if not path.is_absolute(): raise ValueError('请选择完整的本地目录')
    path = path.resolve()
    if create: path.mkdir(parents=True, exist_ok=True)
    if not path.is_dir(): raise ValueError('数据目录不存在或不是文件夹，请重新选择')
    probe = path / ('.ors-viewer-write-check-' + uuid.uuid4().hex)
    try:
        with probe.open('xb') as stream: stream.write(b'ORS Viewer')
        probe.unlink()
    except OSError as exc:
        raise ValueError('该目录不可写，请选择有写入权限的数据目录') from exc
    return path


def load_directory(path):
    """Return (saved directory, setup message), without creating any files."""
    path = Path(path)
    if not path.exists(): return None, ''
    try:
        data = json.loads(path.read_text('utf-8'))
        return validate_directory(data['data_directory']), ''
    except (OSError, ValueError, KeyError, TypeError):
        return None, '原数据目录不可用或设置文件无效，请重新选择。已有数据不会自动移动或删除。'


def save_directory(settings_file, directory):
    path = Path(settings_file);path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.partial')
    try:
        temporary.write_text(json.dumps({'version': 1, 'data_directory': str(directory)}, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)
