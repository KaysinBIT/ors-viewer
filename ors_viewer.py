"""ORS Viewer desktop launcher and command-line entry point."""
import argparse
import logging
import os
from pathlib import Path
import sys
import threading
import webbrowser
from viewer.settings import settings_path, load_directory, validate_directory, validate_port

VERSION = '0.9.0'


def configure_logs(directory):
    directory.mkdir(parents=True, exist_ok=True)
    from logging.handlers import RotatingFileHandler
    handler = RotatingFileHandler(directory / 'application.log', maxBytes=2*1024*1024, backupCount=2, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True, format='%(asctime)s %(levelname)s %(message)s')
    # Windowed frozen applications have no stdout/stderr handles.
    if sys.stdout is None: sys.stdout = (directory / 'console.log').open('a', encoding='utf-8', buffering=1)
    if sys.stderr is None: sys.stderr = sys.stdout


def desktop(server, url):
    import tkinter as tk
    from tkinter import ttk
    window = tk.Tk();window.title('ORS Viewer');window.geometry('640x440');window.minsize(560, 400)
    frame = ttk.Frame(window, padding=24);frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='ORS Viewer', font=('Segoe UI', 22, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='独立文件解析与三维查看', font=('Microsoft YaHei UI', 11)).pack(anchor='w', pady=(2, 20))
    status = tk.StringVar()
    ttk.Label(frame, textvariable=status).pack(anchor='w')
    address = ttk.Entry(frame);address.insert(0, url);address.configure(state='readonly');address.pack(fill='x', pady=12)
    ttk.Label(frame, text='体数据 · 分割标签 · 完整网格 · 可调剖面 · 测量表', wraplength=480).pack(anchor='w')
    data_label = tk.StringVar()
    ttk.Label(frame, textvariable=data_label, wraplength=540).pack(anchor='w', pady=(12, 0))
    buttons = ttk.Frame(frame);buttons.pack(fill='x', pady=(24, 10))
    ttk.Button(buttons, text='打开三维界面', command=lambda: webbrowser.open(url)).pack(side='left')
    data_button = ttk.Button(buttons, text='打开数据目录', command=lambda: open_directory(server.workspace.directory))
    data_button.pack(side='left', padx=10)
    ttk.Button(buttons, text='端口设置', command=lambda: webbrowser.open(url+'#settings')).pack(side='left')
    def close():
        status.set('正在停止服务…');window.update_idletasks()
        server.workspace.close();server.shutdown();server.server_close();window.destroy()
    ttk.Button(buttons, text='退出软件', command=close).pack(side='right')
    ttk.Label(frame, text='关闭此启动窗口会停止服务，尚未完成的解析输出会保留。', wraplength=480).pack(anchor='w')
    window.protocol('WM_DELETE_WINDOW', close)
    def refresh_status():
        current = server.workspace.public()
        status.set((('本地服务运行中 · v' + VERSION) if current['ready'] else '首次使用：请在浏览器中选择数据目录')
                   + f" · 端口 {current['port']}")
        data_label.set('数据目录：' + (current['data_directory'] or '尚未设置'))
        data_button.configure(state='normal' if current['ready'] else 'disabled')
        window.after(300, refresh_status)
    refresh_status()
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
    parser.add_argument('--port', type=validate_port, default=None, help='Port for this run (0: automatic); overrides saved port')
    directory_options = parser.add_mutually_exclusive_group()
    directory_options.add_argument('--state-dir', type=Path, help='Use a data directory for this run without changing saved preferences')
    directory_options.add_argument('--choose-data-dir', action='store_true', help='Show the data-directory setup page again')
    parser.add_argument('--settings-file', type=Path, default=settings_path(), help='Local preferences file')
    parser.add_argument('--data', action='append', default=[], help='Existing decoded directory to load')
    args = parser.parse_args(argv)
    settings_file = args.settings_file.expanduser().resolve()
    if args.state_dir is not None:
        directory = validate_directory(args.state_dir.expanduser().resolve(), create=True);message = ''
    elif args.choose_data_dir:
        directory = None;message = '请选择要使用的数据目录。已有数据不会自动移动或删除。'
    else:
        directory, message = load_directory(settings_file)
    logging.basicConfig(handlers=[logging.NullHandler()], force=True)
    from viewer.server import make_server
    server, url = make_server(args.port, args.data, directory, settings_file, message,
                              on_ready=lambda folder: configure_logs(folder / 'logs'),
                              recover_directory=args.state_dir is None)
    if args.headless:
        if sys.stdout is not None: print('ORS Viewer: ' + url, flush=True)
        if server.workspace.port_warning and sys.stderr is not None: print(server.workspace.port_warning, file=sys.stderr, flush=True)
        if args.open: webbrowser.open(url)
        try: server.serve_forever()
        except KeyboardInterrupt: pass
        finally: server.workspace.close();server.server_close()
    else:
        thread = threading.Thread(target=server.serve_forever, daemon=True);thread.start()
        try: desktop(server, url)
        except Exception:
            server.workspace.close();server.shutdown();server.server_close();raise
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
