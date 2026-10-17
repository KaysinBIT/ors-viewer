"""ORS Viewer desktop launcher and command-line entry point."""
import argparse
import logging
import os
from pathlib import Path
import sys
import webbrowser
from viewer.settings import settings_path, load_directory, validate_directory, validate_port

VERSION = '1.2.0RC7'


def configure_logs(directory):
    directory.mkdir(parents=True, exist_ok=True)
    from logging.handlers import RotatingFileHandler
    handler = RotatingFileHandler(directory / 'application.log', maxBytes=2*1024*1024, backupCount=2, encoding='utf-8')
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True, format='%(asctime)s %(levelname)s %(message)s')
    # Windowed frozen applications have no stdout/stderr handles.
    if sys.stdout is None: sys.stdout = (directory / 'console.log').open('a', encoding='utf-8', buffering=1)
    if sys.stderr is None: sys.stderr = sys.stdout


def open_directory(path):
    import subprocess
    if sys.platform == 'win32': os.startfile(path)
    elif sys.platform == 'darwin': subprocess.Popen(['open', str(path)])
    else: subprocess.Popen(['xdg-open', str(path)])


def main(argv=None):
    argv = list(sys.argv[1:] if argv is None else argv)
    if len(argv) == 2 and argv[0] == '--check-desktop':
        from viewer.desktop_check import check_desktop
        return check_desktop(Path(argv[1]), VERSION)
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
    from viewer.reslice_pool import validate_worker_count
    parser.add_argument('--slice-workers', type=validate_worker_count, default=0,
                        help='CT interpolation processes (0: automatic, up to 8; 1: serial)')
    directory_options = parser.add_mutually_exclusive_group()
    directory_options.add_argument('--state-dir', type=Path, help='Use a data directory for this run without changing saved preferences')
    directory_options.add_argument('--choose-data-dir', action='store_true', help='Choose the data directory again before starting')
    parser.add_argument('--settings-file', type=Path, default=settings_path(), help='Local preferences file')
    parser.add_argument('--data', action='append', default=[], help='Existing decoded directory to load')
    args = parser.parse_args(argv)
    if not args.headless:
        from viewer.launcher import desktop
        desktop(args, VERSION, on_ready=lambda folder: configure_logs(folder / 'logs'))
        return 0
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
                              recover_directory=args.state_dir is None, slice_workers=args.slice_workers)
    if sys.stdout is not None: print('ORS Viewer: ' + url, flush=True)
    if server.workspace.port_warning and sys.stderr is not None: print(server.workspace.port_warning, file=sys.stderr, flush=True)
    if args.open: webbrowser.open(url)
    try: server.serve_forever()
    except KeyboardInterrupt: pass
    finally: server.workspace.close();server.server_close()
    return 0


if __name__ == '__main__':
    import multiprocessing
    multiprocessing.freeze_support()
    try: raise SystemExit(main())
    except Exception as exc:
        logging.exception('Application failed')
        if getattr(sys, 'frozen', False):
            try:
                import tkinter.messagebox
                tkinter.messagebox.showerror('ORS Viewer', '无法启动：' + str(exc))
            except Exception: pass
        raise
