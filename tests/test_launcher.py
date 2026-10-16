"""Desktop startup is explicit; preferences and listeners commit together."""
import argparse
import json
from pathlib import Path
import shutil
import socket
import unittest
from unittest.mock import patch
import urllib.request
import uuid

import ors_viewer
from viewer.launcher import LaunchSession, application_directory
from viewer.settings import load_port, read_settings, save_directory, save_port, save_theme


class LauncherTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parent
        self.root = parent / ('test_launcher_' + uuid.uuid4().hex)
        self.root.mkdir()
        self.addCleanup(shutil.rmtree, self.root)
        self.prefs = self.root / 'prefs.json'

    def session(self, **kwargs):
        args = argparse.Namespace(settings_file=self.prefs, state_dir=None, port=None,
                                  choose_data_dir=False, data=[])
        for name, value in kwargs.items():
            setattr(args, name, value)
        with patch('viewer.launcher.application_directory', return_value=self.root):
            result = LaunchSession(args)
        self.addCleanup(result.stop)
        return result

    def test_default_is_executable_folder_not_cwd_or_bundle_internal(self):
        with patch('viewer.launcher.sys.frozen', True, create=True), patch(
                'viewer.launcher.sys.executable', str(self.root / 'ORSViewer.exe')):
            self.assertEqual(application_directory(), self.root)

    def test_initial_configuration_does_not_bind_create_workspace_or_open_browser(self):
        with patch('viewer.server.make_server') as make, patch('webbrowser.open') as browser:
            session = self.session()
            self.assertEqual(session.directory, self.root)
            self.assertEqual(session.port, 0)
            self.assertIsNone(session.server)
            make.assert_not_called()
            browser.assert_not_called()
            self.assertEqual(list(self.root.iterdir()), [])
            with patch('viewer.launcher.desktop') as desktop:
                ors_viewer.main(['--settings-file', str(self.prefs)])
                desktop.assert_called_once()
                make.assert_not_called()
                browser.assert_not_called()

    def test_manual_start_serves_selected_workspace_and_preserves_theme(self):
        save_theme(self.prefs, 'ocean')
        session = self.session()
        with patch('webbrowser.open') as browser:
            url = session.start(self.root, ' 0 ')
            browser.assert_not_called()
        with urllib.request.urlopen(url + 'api/settings') as response:
            status = json.load(response)
        self.assertEqual(status['data_directory'], str(self.root))
        self.assertTrue(status['ready'])
        self.assertEqual(status['theme'], 'ocean')
        self.assertEqual(session.server.server_address[0], '127.0.0.1')
        prefs = read_settings(self.prefs)
        self.assertEqual(prefs['port'], 0)
        self.assertEqual(prefs['data_directory'], str(self.root))
        self.assertTrue((self.root / 'runtime/server.json').exists())

    def test_saved_selection_restores_and_choose_directory_resets_to_program_folder(self):
        saved = self.root / '数据';saved.mkdir()
        save_directory(self.prefs, saved);save_port(self.prefs, 8769)
        session = self.session()
        self.assertEqual((session.directory, session.port), (saved, 8769))
        self.assertEqual(self.session(choose_data_dir=True).directory, self.root)
        self.assertFalse((saved / 'cache').exists())

    def test_invalid_directory_and_port_leave_preferences_unchanged(self):
        save_port(self.prefs, 8769);before = self.prefs.read_bytes()
        session = self.session()
        for directory, port in [(self.root, '-1'), (self.root, '65536'), (self.root, ''),
                                (self.root / 'missing', '0')]:
            with self.assertRaises(ValueError):
                session.start(directory, port)
        self.assertEqual(self.prefs.read_bytes(), before)
        self.assertFalse((self.root / 'cache').exists())
        self.assertIsNone(session.server)

    def test_occupied_port_is_reported_without_fallback_or_saving(self):
        session = self.session()
        with socket.socket() as owner:
            owner.bind(('127.0.0.1', 0));owner.listen()
            with self.assertRaisesRegex(ValueError, '无法监听端口'):
                session.start(self.root, str(owner.getsockname()[1]))
        self.assertIsNone(session.server)
        self.assertFalse(self.prefs.exists())
        self.assertFalse((self.root / 'cache').exists())

    def test_unwritable_preferences_close_bound_listener(self):
        session = self.session()
        with socket.socket() as probe:
            probe.bind(('127.0.0.1', 0));port = probe.getsockname()[1]
        with patch('viewer.launcher.update_settings', side_effect=PermissionError('prefs denied')):
            with self.assertRaises(PermissionError):
                session.start(self.root, str(port))
        self.assertIsNone(session.server)
        with socket.socket() as replacement:
            replacement.bind(('127.0.0.1', port))

    def test_stop_then_reconfigure_changes_workspace_and_closes_old_listener(self):
        session = self.session();first = self.root / 'first';second = self.root / '第二目录'
        first.mkdir();second.mkdir()
        session.start(first, '0');old_port = session.server.server_port
        with self.assertRaisesRegex(ValueError, '先停止'):
            session.start(second, '0')
        session.stop()
        with socket.socket() as probe:
            probe.settimeout(.2)
            self.assertNotEqual(probe.connect_ex(('127.0.0.1', old_port)), 0)
        session.start(second, '0')
        self.assertEqual(read_settings(self.prefs)['data_directory'], str(second))
        self.assertTrue((first / 'example/data/decode_report.json').exists())

    def test_cli_overrides_are_temporary_until_edited_in_launcher(self):
        saved = self.root / 'saved';selected = self.root / 'selected'
        saved.mkdir();selected.mkdir()
        save_directory(self.prefs, saved);save_port(self.prefs, 8769)
        session = self.session(state_dir=selected, port=0)
        session.start(selected, '0')
        self.assertEqual(read_settings(self.prefs)['data_directory'], str(saved))
        self.assertEqual(load_port(self.prefs)[0], 8769)
        session.stop();session.start(self.root, '0')
        self.assertEqual(read_settings(self.prefs)['data_directory'], str(self.root))


if __name__ == '__main__':
    unittest.main()
