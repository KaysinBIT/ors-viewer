"""Package smoke check: real Tk launcher, start/stop buttons and local HTTP.

Run only through the internal --check-desktop entry point with a new report
directory. It uses isolated preferences/data and never opens the browser.
"""
import argparse
import json
from pathlib import Path
import sys
import time
import urllib.request
import webbrowser


def check_desktop(output, version):
    output = Path(output).resolve()
    output.parent.mkdir(parents=True, exist_ok=True)
    data = output.parent / 'data'
    data.mkdir(exist_ok=True)
    report = {'ok': False, 'browser_opened': False}
    original_open = webbrowser.open

    def unexpected_browser(*args, **kwargs):
        report['browser_opened'] = True
        raise AssertionError('Desktop startup must not open a browser')

    webbrowser.open = unexpected_browser
    try:
        import tkinter as tk
        from tkinter import ttk, filedialog, messagebox
        from .launcher import desktop
        from ors_viewer import configure_logs

        args = argparse.Namespace(settings_file=output.parent/'settings.json',
                                  state_dir=data, choose_data_dir=False, port=0, data=[])

        def exercise(window, session):
            deadline = time.monotonic() + 25
            buttons = {}

            def walk(widget):
                if isinstance(widget, ttk.Button): buttons[widget.cget('text')] = widget
                for child in widget.winfo_children(): walk(child)

            def fail(error):
                report['error'] = type(error).__name__ + ': ' + str(error)
                window.destroy()

            def poll(phase):
                try:
                    if time.monotonic() > deadline: raise TimeoutError('Desktop start/stop check timed out')
                    if phase == 'running' and session.server is not None and buttons['停止服务并修改'].instate(['!disabled']):
                        assert buttons['打开三维界面'].instate(['!disabled'])
                        with urllib.request.urlopen(session.url+'api/health', timeout=5) as response:
                            report['health'] = json.load(response)
                        assert report['health']['version'] == version
                        assert report['health']['ok']
                        assert session.directory == data
                        report['manual_start'] = True
                        buttons['停止服务并修改'].invoke()
                        phase = 'stopped'
                    elif phase == 'stopped' and session.server is None and buttons['保存并启动服务'].instate(['!disabled']):
                        assert buttons['打开三维界面'].instate(['disabled'])
                        assert not report['browser_opened']
                        report.update(ok=True, manual_stop=True)
                        buttons['退出软件'].invoke()
                        return
                    window.after(50, lambda: poll(phase))
                except Exception as error: fail(error)

            try:
                walk(window)
                for label in ('选择文件夹…','保存并启动服务','打开三维界面','停止服务并修改','退出软件'):
                    assert label in buttons, label
                assert session.server is None
                assert buttons['打开三维界面'].instate(['disabled'])
                assert buttons['保存并启动服务'].instate(['!disabled'])
                assert callable(filedialog.askdirectory) and callable(messagebox.showerror)
                bundle = getattr(sys, '_MEIPASS', None)
                if bundle:
                    libraries = [window.tk.call('info', 'library'), window.tk.globalgetvar('tk_library')]
                    assert all(Path(str(p)).resolve().is_relative_to(Path(bundle).resolve()) for p in libraries), 'Tcl/Tk must load from the bundled runtime'
                report.update(tcl=window.tk.call('info', 'patchlevel'), tk=str(tk.TkVersion),
                              bundled_tcl_tk=bool(bundle), initial_service_stopped=True, real_launcher_widgets=True)
                buttons['保存并启动服务'].invoke()
                window.after(50, lambda: poll('running'))
            except Exception as error: fail(error)

        desktop(args, version, lambda folder: configure_logs(folder/'logs'), _on_window_ready=exercise)
    except Exception as error:
        report['error'] = type(error).__name__ + ': ' + str(error)
    finally:
        webbrowser.open = original_open
        output.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
    return 0 if report['ok'] else 1
