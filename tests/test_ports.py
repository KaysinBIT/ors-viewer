"""Port persistence, loopback binding and restart behavior."""
import json
from pathlib import Path
import re
import shutil
import socket
import threading
import unittest
import urllib.error
import urllib.request
import uuid

from viewer.server import make_server
from viewer.settings import load_directory, load_port, save_directory, save_port, validate_port


class PortTests(unittest.TestCase):
    def setUp(self):
        parent=Path(__file__).resolve().parent
        self.root=parent/('test_ports_'+uuid.uuid4().hex);self.root.mkdir()
        assert self.root.resolve().parent==parent
        self.addCleanup(shutil.rmtree,self.root);self.prefs=self.root/'prefs.json'

    def server(self,port=None):
        server,url=make_server(port,[],settings_file=self.prefs)
        self.addCleanup(server.server_close);self.addCleanup(server.workspace.close)
        return server,url.rstrip('/')

    def unused_port(self):
        with socket.socket() as listener:
            listener.bind(('127.0.0.1',0));return listener.getsockname()[1]

    def test_default_and_validation(self):
        self.assertEqual(load_port(self.prefs),(0,''));self.assertFalse(self.prefs.exists())
        for value in (0,1,65535,'8769'):self.assertEqual(validate_port(value),int(value))
        for value in (-1,65536,True,False,None,1.5,1.0,'1.0','abc',[]):
            with self.assertRaises(ValueError):validate_port(value)

    def test_save_merges_data_directory_and_unknown_preferences(self):
        self.prefs.write_text(json.dumps({'custom_flag':'keep'}),encoding='utf-8')
        save_port(self.prefs,8769);save_directory(self.prefs,self.root)
        self.assertEqual(load_port(self.prefs),(8769,''));self.assertEqual(load_directory(self.prefs),(self.root,''))
        save_port(self.prefs,0)
        self.assertEqual(load_directory(self.prefs),(self.root,''));self.assertEqual(json.loads(self.prefs.read_text())['custom_flag'],'keep')

    def test_port_only_preference_still_requires_first_run_directory_selection(self):
        save_port(self.prefs,8769)
        self.assertEqual(load_directory(self.prefs),(None,''))
        server,_=self.server(0);self.assertFalse(server.workspace.ready);self.assertIsNone(server.workspace.cache)
        self.assertEqual(list(self.root.iterdir()),[self.prefs])

    def test_saved_port_is_used_on_next_launch_and_cli_overrides_without_saving(self):
        requested=self.unused_port();save_port(self.prefs,requested)
        server,_=self.server();self.assertEqual(server.server_address,('127.0.0.1',requested))
        self.assertEqual(server.workspace.public()['port_source'],'saved')
        override,_=self.server(0);self.assertNotEqual(override.server_port,requested)
        self.assertEqual(load_port(self.prefs)[0],requested)
        self.assertEqual(override.workspace.public()['port_source'],'command-line')

    def test_occupied_saved_port_falls_back_visibly_but_explicit_port_fails(self):
        owner,_=self.server(0);occupied=owner.server_port;save_port(self.prefs,occupied)
        recovered,_=self.server();status=recovered.workspace.public()
        self.assertNotEqual(recovered.server_port,occupied);self.assertIn(str(occupied),status['port_warning'])
        self.assertIn(str(recovered.server_port),status['port_warning']);self.assertTrue(status['restart_required'])
        self.assertEqual(load_port(self.prefs)[0],occupied)
        with self.assertRaisesRegex(ValueError,'无法监听端口'):make_server(occupied,[],settings_file=self.prefs)

    def test_invalid_saved_port_recovers_without_losing_directory(self):
        save_directory(self.prefs,self.root)
        data=json.loads(self.prefs.read_text());data['port']='bad';self.prefs.write_text(json.dumps(data))
        server,_=self.server();self.assertTrue(server.workspace.public()['port_warning'])
        save_port(self.prefs,0);self.assertEqual(load_directory(self.prefs),(self.root,''))

    def test_authenticated_http_save_leaves_current_listener_and_tasks_running(self):
        server,url=self.server(0);threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.shutdown)
        with urllib.request.urlopen(url) as response:html=response.read().decode()
        token=re.search('name="viewer-token" content="([^"]+)"',html)[1]
        route=url+'/api/settings/port';headers={'Content-Type':'application/json','Origin':url,'X-Viewer-Token':token}
        requested=self.unused_port()
        with urllib.request.urlopen(urllib.request.Request(route,data=json.dumps({'port':requested}).encode(),headers=headers)) as response:status=json.load(response)
        self.assertEqual(status['port'],server.server_port);self.assertEqual(status['saved_port'],requested);self.assertTrue(status['restart_required'])
        with urllib.request.urlopen(url+'/api/health') as response:self.assertTrue(json.load(response)['ok'])
        saved=self.prefs.read_bytes()
        for body,extra,code in [({'port':65536},headers,400),({'port':True},headers,400),({'port':1},{},403)]:
            with self.assertRaises(urllib.error.HTTPError) as error:
                urllib.request.urlopen(urllib.request.Request(route,data=json.dumps(body).encode(),headers=extra))
            self.assertEqual(error.exception.code,code);error.exception.close()
        self.assertEqual(self.prefs.read_bytes(),saved)


if __name__=='__main__':unittest.main()
