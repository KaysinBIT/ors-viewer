"""First-run selection, persistent settings and authenticated file browsing."""
import json
from pathlib import Path
import shutil
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import uuid

from viewer.file_browser import list_directory, create_directory
from viewer.server import make_server
from viewer.settings import load_directory, save_directory, validate_directory


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.root=Path(__file__).resolve().parent/('test_setup_'+uuid.uuid4().hex)
        self.root.mkdir();self.addCleanup(shutil.rmtree,self.root)

    def server(self,preferences):
        server,url=make_server(0,[],settings_file=preferences)
        thread=threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.workspace.close);self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        return server,url.rstrip('/')

    def request(self,url,route,body,authorized=True):
        headers={'Content-Type':'application/json'}
        if authorized:
            import re
            with urllib.request.urlopen(url) as response:page=response.read().decode()
            token=re.search('name="viewer-token" content="([^"]+)"',page).group(1)
            headers.update({'Origin':url,'X-Viewer-Token':token})
        request=urllib.request.Request(url+route,data=json.dumps(body).encode(),headers=headers)
        with urllib.request.urlopen(request) as response:return json.load(response)

    def test_first_run_does_not_create_data_or_preferences(self):
        preferences=self.root/'config'/'settings.json'
        self.assertEqual(load_directory(preferences),(None,''))
        server,url=self.server(preferences)
        with urllib.request.urlopen(url+'/api/settings') as response:status=json.load(response)
        self.assertFalse(status['ready']);self.assertIsNone(server.workspace.cache)
        self.assertEqual(list(self.root.iterdir()),[])
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(url,'/api/imports',{'path':'sample.ORSSession'})
        self.assertEqual(error.exception.code,400);error.exception.close()
        self.assertFalse(preferences.exists())

    def test_selection_persists_unicode_path_and_reloads_catalog(self):
        directory=self.root/'数据 folder';directory.mkdir();preferences=self.root/'prefs.json'
        server,url=self.server(preferences)
        status=self.request(url,'/api/settings/data-directory',{'path':str(directory)})
        self.assertTrue(status['ready']);self.assertEqual(status['data_directory'],str(directory))
        self.assertEqual(load_directory(preferences),(directory,''))
        self.assertTrue((directory/'runtime/server.json').is_file())
        self.assertTrue((directory/'cache').is_dir());self.assertTrue((directory/'imported').is_dir())
        restored,_=make_server(0,[],load_directory(preferences)[0],settings_file=preferences)
        self.addCleanup(restored.server_close);self.addCleanup(restored.workspace.close)
        self.assertTrue(restored.workspace.ready)
        self.assertEqual(len(restored.workspace.catalog.public()),1)

    def test_invalid_selection_is_not_saved_and_ready_directory_cannot_be_replaced(self):
        preferences=self.root/'prefs.json';directory=self.root/'data';directory.mkdir()
        server,url=self.server(preferences)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(url,'/api/settings/data-directory',{'path':str(self.root/'missing')})
        error.exception.close();self.assertFalse(preferences.exists());self.assertFalse(server.workspace.ready)
        self.request(url,'/api/settings/data-directory',{'path':str(directory)})
        saved=preferences.read_bytes()
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(url,'/api/settings/data-directory',{'path':str(self.root)})
        error.exception.close();self.assertEqual(preferences.read_bytes(),saved)

    def test_unwritable_directory_and_broken_saved_path_require_selection(self):
        with patch('viewer.settings.Path.open',side_effect=PermissionError('denied')):
            with self.assertRaisesRegex(ValueError,'不可写'):validate_directory(self.root)
        preferences=self.root/'prefs.json';save_directory(preferences,self.root/'missing')
        directory,message=load_directory(preferences);self.assertIsNone(directory);self.assertIn('重新选择',message)
        preferences.write_text('{broken',encoding='utf-8')
        self.assertIsNone(load_directory(preferences)[0])

    def test_failed_initialization_does_not_replace_saved_preference(self):
        preferences=self.root/'prefs.json';old=self.root/'old';old.mkdir();save_directory(preferences,old)
        selected=self.root/'selected';selected.mkdir();(selected/'cache').write_text('not a directory')
        server,url=self.server(preferences)
        with self.assertRaises(urllib.error.HTTPError) as error:
            self.request(url,'/api/settings/data-directory',{'path':str(selected)})
        error.exception.close();self.assertFalse(server.workspace.ready)
        self.assertEqual(load_directory(preferences)[0],old)
        recovered,_=make_server(0,[],selected,settings_file=preferences,recover_directory=True)
        self.addCleanup(recovered.server_close);self.addCleanup(recovered.workspace.close)
        self.assertFalse(recovered.workspace.ready);self.assertIn('重新选择',recovered.workspace.message)

    def test_file_browser_filters_files_supports_directory_selection_and_pagination(self):
        (self.root/'子目录').mkdir();(self.root/'mesh.STL').write_text('test');(self.root/'secret.txt').write_text('unlisted')
        files=list_directory(str(self.root));self.assertEqual([e['name'] for e in files['entries']],['子目录','mesh.STL'])
        folders=list_directory(str(self.root),'directory');self.assertEqual(len(folders['entries']),1)
        for i in range(203):(self.root/('data%03d.npy'%i)).write_bytes(b'')
        first=list_directory(str(self.root));second=list_directory(str(self.root),offset=200)
        self.assertEqual(len(first['entries']),200);self.assertEqual(len(second['entries']),5)
        self.assertEqual(list_directory(str(self.root),query='MESH')['entries'][0]['name'],'mesh.STL')

    def test_new_folder_rejects_path_components_and_does_not_overwrite(self):
        path=create_directory(str(self.root),'新数据');self.assertTrue(Path(path).is_dir())
        for name in ['..','../outside','a/b','a\\b','C:other','']:
            with self.assertRaises(ValueError):create_directory(str(self.root),name)
        with self.assertRaises(FileExistsError):create_directory(str(self.root),'新数据')

    def test_file_listing_folder_creation_and_setup_require_local_origin_and_token(self):
        server,url=self.server(self.root/'prefs.json')
        for route in ['/api/filesystem/list','/api/filesystem/mkdir','/api/settings/data-directory']:
            with self.assertRaises(urllib.error.HTTPError) as error:
                self.request(url,route,{'path':str(self.root),'name':'unexpected'},authorized=False)
            self.assertEqual(error.exception.code,403);error.exception.close()
        self.assertFalse((self.root/'unexpected').exists());self.assertFalse(server.workspace.ready)
        result=self.request(url,'/api/filesystem/list',{'path':str(self.root),'kind':'directory'})
        self.assertEqual(result['path'],str(self.root))


if __name__=='__main__':unittest.main()
