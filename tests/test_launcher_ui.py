"""Exercise desktop button callbacks with a real service and a headless Tk adapter."""
import argparse
import json
from pathlib import Path
import shutil
import sys
import time
import types
import unittest
from unittest.mock import Mock, patch
import urllib.request
import uuid

from viewer.launcher import desktop


class Variable:
    def __init__(self, value=''):
        self.value = value

    def get(self):
        return self.value

    def set(self, value):
        self.value = value


class Widget:
    def __init__(self, parent=None, **options):
        self.options = options

    def configure(self, **options):
        self.options.update(options)

    def pack(self, **options): pass
    def grid(self, **options): pass
    def columnconfigure(self, *args, **options): pass


class Root:
    def __init__(self, exercise):
        self.exercise = exercise
        self.pending = []
        self.destroyed = False

    def title(self, value): pass
    def geometry(self, value): pass
    def minsize(self, *args): pass
    def protocol(self, *args): pass
    def after(self, delay, callback): self.pending.append(callback)
    def destroy(self): self.destroyed = True
    def mainloop(self): self.exercise(self)

    def until(self, condition):
        deadline = time.monotonic() + 5
        while not condition():
            if time.monotonic() >= deadline:
                raise AssertionError('Desktop callback did not complete')
            if self.pending:
                self.pending.pop(0)()
            time.sleep(.005)


class DesktopButtonTests(unittest.TestCase):
    def test_select_cancel_validate_start_open_stop_reconfigure_and_exit(self):
        parent = Path(__file__).resolve().parent
        root_dir = parent / ('test_desktop_' + uuid.uuid4().hex)
        root_dir.mkdir();self.addCleanup(shutil.rmtree, root_dir)
        selected = root_dir / 'data';selected.mkdir()
        preferences = root_dir / 'settings.json'
        args = argparse.Namespace(settings_file=preferences, state_dir=None, port=None,
                                  choose_data_dir=False, data=[])
        widgets = []

        def widget(parent=None, **options):
            result = Widget(parent, **options);widgets.append(result);return result

        def button(label):
            return next(w for w in widgets if w.options.get('text') == label)

        def click(label):
            target = button(label)
            self.assertNotEqual(target.options.get('state'), 'disabled', label)
            target.options['command']()

        def exercise(window):
            entries = [w.options['textvariable'] for w in widgets if 'textvariable' in w.options]
            directory = next(v for v in entries if v.get() == str(root_dir))
            port = next(v for v in entries if v.get() == '0')
            status = next(v for v in entries if '等待设置' in v.get())
            address = next(v for v in entries if '本地网址' in v.get())
            self.assertFalse(preferences.exists())
            self.assertEqual(button('打开三维界面').options['state'], 'disabled')
            browser.assert_not_called()
            chooser.return_value = ''
            click('选择文件夹…');self.assertEqual(directory.get(), str(root_dir))
            chooser.return_value = str(selected)
            click('选择文件夹…');self.assertEqual(directory.get(), str(selected))
            port.set('65536');click('保存并启动服务')
            window.until(lambda: button('保存并启动服务').options['state'] == 'normal')
            self.assertIn('操作未完成', status.get());self.assertFalse(preferences.exists())
            port.set('0');click('保存并启动服务')
            window.until(lambda: button('打开三维界面').options['state'] == 'normal')
            browser.assert_not_called()
            self.assertIn('网页不会自动打开', status.get())
            with urllib.request.urlopen(address.get() + 'api/settings') as response:
                settings = json.load(response)
            self.assertTrue(settings['ready'])
            self.assertEqual(settings['data_directory'], str(selected))
            click('打开三维界面');browser.assert_called_once_with(address.get())
            click('打开数据目录');opener.assert_called_once_with(selected)
            click('停止服务并修改')
            window.until(lambda: button('保存并启动服务').options['state'] == 'normal')
            self.assertEqual(button('打开三维界面').options['state'], 'disabled')
            self.assertTrue((selected / 'example/data/decode_report.json').exists())
            click('保存并启动服务')
            window.until(lambda: button('打开三维界面').options['state'] == 'normal')
            click('退出软件');window.until(lambda: window.destroyed)

        tkinter = types.ModuleType('tkinter')
        tkinter.StringVar = Variable
        tkinter.Tk = lambda: Root(exercise)
        tkinter.ttk = types.SimpleNamespace(Frame=widget, Label=widget, Entry=widget, Button=widget)
        chooser = Mock(return_value='')
        tkinter.filedialog = types.SimpleNamespace(askdirectory=chooser)
        with patch('webbrowser.open', return_value=True) as browser, \
             patch('ors_viewer.open_directory') as opener, \
             patch('viewer.launcher.application_directory', return_value=root_dir):
            with patch.dict(sys.modules, {'tkinter': tkinter}):
                desktop(args, 'test')


if __name__ == '__main__':
    unittest.main()
