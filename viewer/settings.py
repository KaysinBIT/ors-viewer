"""Local preferences and explicit data-directory validation."""
import json
import os
from pathlib import Path
import sys
import threading
import uuid

DEFAULT_PORT = 0  # The OS assigns an available loopback port.
DEFAULT_THEME = 'ocean'
_write_lock = threading.RLock()


def validate_port(value):
    if isinstance(value, str) and value.isascii() and value.isdecimal(): value = int(value)
    if type(value) is not int or not 0 <= value <= 65535:
        raise ValueError('端口须为 0–65535 的整数；0 表示自动分配')
    return value


def read_settings(path):
    data = json.loads(Path(path).read_text('utf-8'))
    if not isinstance(data, dict): raise ValueError('设置文件格式无效')
    return data


def load_port(path):
    if path is None or not Path(path).exists(): return DEFAULT_PORT, ''
    try: return validate_port(read_settings(path).get('port', DEFAULT_PORT)), ''
    except (OSError, ValueError, TypeError):
        return DEFAULT_PORT, '保存的端口设置无效，当前使用自动分配。请打开端口设置重新保存。'


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
        data = read_settings(path)
        if not data.get('data_directory'): return None, ''
        return validate_directory(data['data_directory']), ''
    except (OSError, ValueError, KeyError, TypeError):
        return None, '原数据目录不可用或设置文件无效，请重新选择。已有数据不会自动移动或删除。'


def save_directory(settings_file, directory):
    update_settings(settings_file, {'data_directory': str(directory)})


def save_port(settings_file, port):
    update_settings(settings_file, {'port': validate_port(port)})


def load_theme(path):
    if path is None: return DEFAULT_THEME
    try: value = read_settings(path).get('theme', DEFAULT_THEME)
    except (OSError, ValueError, TypeError): return DEFAULT_THEME
    return value if value in ('mono', 'light', 'ocean') else DEFAULT_THEME


def save_theme(path, theme):
    if theme not in ('mono', 'light', 'ocean'): raise ValueError('不支持的配色方案')
    update_settings(path, {'theme': theme})


def update_settings(settings_file, changes):
    if settings_file is None: raise ValueError('当前运行没有设置文件，无法保存偏好')
    with _write_lock:
        path = Path(settings_file);path.parent.mkdir(parents=True, exist_ok=True)
        try: data = read_settings(path)
        except (OSError, ValueError, TypeError): data = {}
        data.update(changes);data['version'] = 1
        temporary = path.with_name(path.name + '.' + uuid.uuid4().hex + '.partial')
        try:
            temporary.write_text(json.dumps(data, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')
            temporary.replace(path)
        finally:
            temporary.unlink(missing_ok=True)
