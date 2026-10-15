"""ORS Viewer desktop launcher and command-line entry point."""
import argparse
import logging
import os
from pathlib import Path
import sys
import threading
import webbrowser

VERSION = '0.6.0'


def default_data_dir():
    if sys.platform == 'win32':
        base = Path(os.environ.get('LOCALAPPDATA', Path.home() / 'AppData' / 'Local'))
    elif sys.platform == 'darwin':
        base = Path.home() / 'Library' / 'Application Support'
    else:
        base = Path(os.environ.get('XDG_DATA_HOME', Path.home() / '.local' / 'share'))
    return base / 'ORSViewer'


def configure_logs(directory):
    directory.mkdir(parents=True, exist_ok=True)
    from logging.handlers import RotatingFileHandler
    handler = RotatingFileHandler(directory / 'application.log', maxBytes=2*1024*1024, backupCount=2, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, handlers=[handler], format='%(asctime)s %(levelname)s %(message)s')
    # Windowed frozen applications have no stdout/stderr handles.
    if sys.stdout is None: sys.stdout = (directory / 'console.log').open('a', encoding='utf-8', buffering=1)
    if sys.stderr is None: sys.stderr = sys.stdout


def desktop(server, url, directory):
    import tkinter as tk
    from tkinter import ttk
    window = tk.Tk();window.title('ORS Viewer');window.geometry('560x320');window.minsize(480, 280)
    frame = ttk.Frame(window, padding=24);frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='ORS Viewer', font=('Segoe UI', 22, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='独立文件解析与三维查看', font=('Microsoft YaHei UI', 11)).pack(anchor='w', pady=(2, 20))
    status = tk.StringVar(value='本地服务运行中 · v' + VERSION)
    ttk.Label(frame, textvariable=status).pack(anchor='w')
    address = ttk.Entry(frame);address.insert(0, url);address.configure(state='readonly');address.pack(fill='x', pady=12)
    ttk.Label(frame, text='体数据 · 分割标签 · 完整网格 · 可调剖面 · 测量表', wraplength=480).pack(anchor='w')
    buttons = ttk.Frame(frame);buttons.pack(fill='x', pady=(24, 10))
    ttk.Button(buttons, text='打开三维界面', command=lambda: webbrowser.open(url)).pack(side='left')
    ttk.Button(buttons, text='打开数据目录', command=lambda: open_directory(directory)).pack(side='left', padx=10)
    def close():
        status.set('正在停止服务…');window.update_idletasks()
        server.import_jobs.close();server.shutdown();server.server_close();window.destroy()
    ttk.Button(buttons, text='退出软件', command=close).pack(side='right')
    ttk.Label(frame, text='关闭此启动窗口会停止服务，尚未完成的解析输出会保留。', wraplength=480).pack(anchor='w')
    window.protocol('WM_DELETE_WINDOW', close)
    window.after(250, lambda: webbrowser.open(url))
    window.mainloop()


def open_directory(path):
    import subprocess
    if sys.platform == 'win32': os.startfile(path)
    elif sys.platform == 'darwin': subprocess.Popen(['open', str(path)])
    else: subprocess.Popen(['xdg-open', str(path)])


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if argv[:1] == ['--worker-extract']:
        # The same bundled executable handles parsing without an external Python install.
        if sys.stdout is None: sys.stdout = open(os.devnull, 'w')
        if sys.stderr is None: sys.stderr = sys.stdout
        import ors_extract
        return ors_extract.main(argv[1:])
    parser = argparse.ArgumentParser(description='ORS Viewer: independent ORS extraction and 3D visualization')
    parser.add_argument('--version', action='version', version=VERSION)
    parser.add_argument('--headless', action='store_true', help='Run local server without the desktop launcher')
    parser.add_argument('--open', action='store_true', help='Open browser in headless mode')
    parser.add_argument('--port', type=int, default=0)
    parser.add_argument('--state-dir', type=Path, default=default_data_dir(), help='Directory for imports, cache and logs')
    parser.add_argument('--data', action='append', default=[], help='Existing decoded directory to load')
    args = parser.parse_args(argv)
    directory = args.state_dir.expanduser().resolve();configure_logs(directory / 'logs')
    from viewer.server import make_server
    server, url = make_server(args.port, args.data, directory)
    if args.headless:
        print('ORS Viewer: ' + url, flush=True)
        if args.open: webbrowser.open(url)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
        finally: server.import_jobs.close();server.server_close()
    else:
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try: desktop(server, url, directory)
        except Exception:
            server.import_jobs.close();server.shutdown();server.server_close();raise
    return 0


if __name__ == '__main__':
    try: raise SystemExit(main())
    except Exception as exc:
        logging.exception('Application failed')
        if getattr(sys, 'frozen', False):
            try:
                import tkinter.messagebox
                tkinter.messagebox.showerror('ORS Viewer', '无法启动：' + str(exc))
            except Exception: pass
        raise
