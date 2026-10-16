"""Explicit desktop configuration and local server lifecycle."""
from pathlib import Path
import queue
import sys
import threading
import webbrowser

from .settings import load_directory, load_port, update_settings, validate_directory, validate_port


def application_directory():
    if getattr(sys, 'frozen', False):
        return Path(sys.executable).resolve().parent
    return Path(__file__).resolve().parent.parent


class LaunchSession:
    def __init__(self, args, on_ready=None):
        self.args = args
        self.settings_file = args.settings_file.expanduser().resolve()
        saved, message = (None, '') if args.choose_data_dir else load_directory(self.settings_file)
        self.directory = (args.state_dir.expanduser().resolve() if args.state_dir is not None
                          else saved or application_directory())
        saved_port, warning = load_port(self.settings_file)
        self.port = args.port if args.port is not None else saved_port
        self.message = ' '.join(x for x in [message, warning] if x)
        self.on_ready = on_ready
        self.server = None
        self.thread = None
        self.url = ''

    def start(self, directory, port):
        if self.server is not None:
            raise ValueError('服务已启动。请先停止服务，再修改设置。')
        port = validate_port(str(port).strip())
        directory = validate_directory(directory)
        from .server import make_server
        server, url = make_server(port, self.args.data, directory, self.settings_file,
                                  on_ready=self.on_ready)
        try:
            changes = {}
            if self.args.state_dir is None or directory != self.args.state_dir.expanduser().resolve():
                changes['data_directory'] = str(directory)
            if self.args.port is None or port != self.args.port:
                changes['port'] = port
            if changes:
                update_settings(self.settings_file, changes)
            server.workspace.port_source = 'desktop'
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
        except Exception:
            server.workspace.close()
            server.server_close()
            raise
        self.server, self.thread, self.url = server, thread, url
        self.directory, self.port = directory, port
        return url

    def stop(self):
        server, thread = self.server, self.thread
        if server is None:
            return
        server.workspace.close()
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)
        self.server = self.thread = None
        self.url = ''


def desktop(args, version, on_ready=None):
    import tkinter as tk
    from tkinter import filedialog, ttk
    from ors_viewer import open_directory

    session = LaunchSession(args, on_ready)
    window = tk.Tk()
    window.title('ORS Viewer · v' + version)
    window.geometry('780x640')
    window.minsize(760, 620)
    frame = ttk.Frame(window, padding=24)
    frame.pack(fill='both', expand=True)
    ttk.Label(frame, text='ORS Viewer', font=('Segoe UI', 22, 'bold')).pack(anchor='w')
    ttk.Label(frame, text='独立文件解析与三维查看 · v' + version).pack(anchor='w', pady=(2, 18))
    ttk.Label(frame, text='1  检查端口和数据目录    2  保存并启动服务    3  手动打开三维界面',
              font=('Microsoft YaHei UI', 10, 'bold')).pack(anchor='w', pady=(0, 16))

    form = ttk.Frame(frame)
    form.pack(fill='x')
    form.columnconfigure(1, weight=1)
    port = tk.StringVar(value=str(session.port))
    directory = tk.StringVar(value=str(session.directory))
    ttk.Label(form, text='监听端口').grid(row=0, column=0, sticky='w', padx=(0, 16))
    port_entry = ttk.Entry(form, textvariable=port, width=12)
    port_entry.grid(row=0, column=1, sticky='w')
    ttk.Label(form, text='0 = 自动分配；也可输入 1–65535。仅在本机访问。').grid(
        row=1, column=1, columnspan=2, sticky='w', pady=(5, 14))
    ttk.Label(form, text='数据目录').grid(row=2, column=0, sticky='w', padx=(0, 16))
    ttk.Entry(form, textvariable=directory, state='readonly').grid(row=2, column=1, sticky='ew')

    def choose_directory():
        initial = Path(directory.get())
        if not initial.is_dir():
            initial = application_directory()
        selected = filedialog.askdirectory(parent=window, title='选择数据目录', initialdir=str(initial), mustexist=True)
        if selected:
            directory.set(str(Path(selected).resolve()))

    choose_button = ttk.Button(form, text='选择文件夹…', command=choose_directory)
    choose_button.grid(row=2, column=2, padx=(8, 0))
    ttk.Label(form, text='首次默认程序所在文件夹，以后记住上次选择。可用“选择文件夹”更改。',
              wraplength=570).grid(row=3, column=1, columnspan=2, sticky='w', pady=(5, 0))
    ttk.Label(frame, text='解析结果、缓存、日志和示例保存在数据目录中。启动前请确认目录可写且空间足够；'
              '更换目录不会搬移或删除已有数据。', wraplength=690).pack(anchor='w', pady=(14, 12))

    status = tk.StringVar(value=session.message or '等待设置：服务尚未启动，不会自动打开网页。')
    status_label = ttk.Label(frame, textvariable=status, wraplength=690)
    status_label.pack(anchor='w', pady=(0, 10))
    address = tk.StringVar(value='启动服务后在此显示本地网址')
    ttk.Entry(frame, textvariable=address, state='readonly').pack(fill='x')
    buttons = ttk.Frame(frame)
    buttons.pack(fill='x', pady=(18, 10))
    results = queue.Queue()
    busy = False
    closing = False

    def controls():
        running = session.server is not None
        port_entry.configure(state='disabled' if busy or running else 'normal')
        choose_button.configure(state='disabled' if busy or running else 'normal')
        start_button.configure(state='disabled' if busy or running else 'normal')
        stop_button.configure(state='normal' if running and not busy else 'disabled')
        open_button.configure(state='normal' if running and not busy else 'disabled')
        folder_button.configure(state='normal' if running and not busy else 'disabled')
        exit_button.configure(state='disabled' if busy else 'normal')

    def run_job(action, operation):
        nonlocal busy
        busy = True
        controls()
        status_label.configure(foreground='#164c54')
        status.set('正在启动服务，请稍候…' if action == 'start' else '正在停止服务，请稍候…')
        def work():
            try:
                results.put((action, operation(), None))
            except Exception as error:
                results.put((action, None, error))
        threading.Thread(target=work, daemon=True).start()
        window.after(100, poll)

    def poll():
        nonlocal busy, closing
        try:
            action, value, error = results.get_nowait()
        except queue.Empty:
            window.after(100, poll)
            return
        busy = False
        if error:
            closing = False
            message = str(error)
            if '无法监听端口' in message:
                message = '端口被占用或无绑定权限。请修改上方端口，或填写 0 自动分配，再重新启动。'
            status_label.configure(foreground='#a52a2a')
            status.set('操作未完成：' + message)
        elif action == 'start':
            address.set(value)
            status.set(f'本地服务已启动 · 端口 {session.server.server_port}。请点击“打开三维界面”，网页不会自动打开。')
        elif closing:
            window.destroy()
            return
        else:
            if args.port is None:
                port.set(str(load_port(session.settings_file)[0]))
            address.set('服务已停止；重新启动后显示本地网址')
            status.set('服务已停止，可修改设置。已有数据保留；重新启动后请手动打开三维界面。')
        controls()

    def start():
        selected, requested = directory.get(), port.get()
        run_job('start', lambda: session.start(selected, requested))

    def open_view():
        if session.server is not None:
            if not webbrowser.open(session.url):
                status.set('未能调用默认浏览器，请复制上方网址，在浏览器中手动打开。')

    def close():
        nonlocal closing
        if busy:
            return
        if session.server is None:
            window.destroy()
        else:
            closing = True
            run_job('stop', session.stop)

    start_button = ttk.Button(buttons, text='保存并启动服务', command=start)
    start_button.pack(side='left')
    open_button = ttk.Button(buttons, text='打开三维界面', command=open_view)
    open_button.pack(side='left', padx=8)
    stop_button = ttk.Button(buttons, text='停止服务并修改', command=lambda: run_job('stop', session.stop))
    stop_button.pack(side='left')
    exit_button = ttk.Button(buttons, text='退出软件', command=close)
    exit_button.pack(side='right')
    folder_button = ttk.Button(frame, text='打开数据目录', command=lambda: open_directory(session.directory))
    folder_button.pack(anchor='w')
    ttk.Label(frame, text='提示：停止服务或关闭此窗口会中断未完成的解析任务，已有输出会保留。'
              '仅关闭网页不会停止服务，可再次点击“打开三维界面”。', wraplength=690).pack(anchor='w', pady=(12, 0))
    if args.port is not None or args.state_dir is not None:
        ttk.Label(frame, text='命令行指定的端口 / 目录在未修改时仅对本次有效。', wraplength=690).pack(anchor='w', pady=(6, 0))
    window.protocol('WM_DELETE_WINDOW', close)
    controls()
    try:
        window.mainloop()
    finally:
        session.stop()
