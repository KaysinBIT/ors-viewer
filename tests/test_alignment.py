import hashlib
import json
from pathlib import Path
import tempfile
import unittest
from http.server import ThreadingHTTPServer
from types import SimpleNamespace
import threading
import urllib.error
import urllib.request

import numpy as np

from viewer.alignment import pose_matrix, validate_pose, dataset_alignment, save_alignment
from viewer.reslice import geometry, Sampler, reslice_packet, reslice_probe
from viewer.simplify import unpack
from viewer.server import Catalog, handler


class AlignmentTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        t, z, y, x = np.indices((2, 3, 4, 5))
        self.data = (1000*t+100*z+10*y+x).astype('<f4')
        np.save(self.root/'volume.npy', self.data)
        self.meta = {'type': 'CxvChannel', 'grid': {'shape_tzyx': list(self.data.shape),
                     'voxel_xyz_to_world': [[2, .2, 0, 80], [0, 3, 0, -40], [0, 0, 4, 10], [0, 0, 0, 1]]}}
        self.pose = {'enabled': True, 'rotation': [[0, -1, 0], [1, 0, 0], [0, 0, 1]], 'pivot': [7, 8, 9], 'mirror': [False, False, False]}

    def test_shared_pivot_rigid_rotation_and_disable(self):
        matrix = pose_matrix(self.pose)
        np.testing.assert_allclose((matrix @ [7, 8, 9, 1])[:3], [7, 8, 9])
        a, b = np.array([2, 8, 5, 1]), np.array([7, 3, 1, 1])
        self.assertAlmostEqual(np.linalg.norm(a-b), np.linalg.norm(matrix@a-matrix@b))
        np.testing.assert_array_equal(pose_matrix({**self.pose, 'enabled': False}), np.eye(4))
        for bad in (np.diag([2, 1, 1]), np.diag([-1, 1, 1]), np.full((3,3), np.nan)):
            with self.assertRaises(ValueError): validate_pose({**self.pose, 'rotation': bad.tolist()})

    def test_linear_interpolation_with_rotated_sheared_grid_and_source_hash(self):
        before = hashlib.sha256((self.root/'volume.npy').read_bytes()).hexdigest()
        source = np.array([[1.25, 1.5, .75], [4, 3, 2]])
        matrix = pose_matrix(self.pose) @ self.meta['grid']['voxel_xyz_to_world']
        world = source @ matrix[:3,:3].T + matrix[:3,3]
        values, valid, _ = Sampler(self.root, self.meta, self.pose, 1).sample(world)
        np.testing.assert_allclose(values, [1091.25, 1234]); self.assertTrue(valid.all())
        probe = reslice_probe(self.root, self.meta, self.pose, world[0].tolist(), 1)
        self.assertEqual(probe['value'], '1121.0'); self.assertEqual(probe['sampled_value'], '1091.25')
        for axis in range(3):
            header, arrays = unpack(reslice_packet(self.root, self.meta, self.pose, axis, world[0,axis], 1))
            self.assertEqual(header['interpolation'], 'linear'); self.assertEqual(arrays['mask'].dtype, 'uint8')
        self.assertEqual(before, hashlib.sha256((self.root/'volume.npy').read_bytes()).hexdigest())

    def test_identity_exact_samples_and_zero_weight_nan(self):
        self.meta['grid']['voxel_xyz_to_world'] = np.eye(4).tolist()
        pose = {**self.pose, 'enabled': False}
        for axis in range(3):
            _, arrays = unpack(reslice_packet(self.root, self.meta, pose, axis, 1, 1))
            np.testing.assert_array_equal(arrays['pixels'], np.take(self.data[1], 1, axis=2-axis))
        self.data[0,0,0,1] = np.nan; np.save(self.root/'volume.npy', self.data)
        values, _, _ = Sampler(self.root,self.meta,pose).sample(np.array([[0,0,0],[100,0,0]]))
        self.assertEqual(values[0],0); self.assertTrue(np.isnan(values[1]))

    def test_sparse_dense_label_parity_inclusive_ends_and_large_ids(self):
        labels = np.zeros_like(self.data, dtype='<u4'); labels.ravel()[2:6] = 70000
        labels.ravel()[80:84] = 2**32-1
        np.save(self.root/'label_intervals.npy', np.array([[2,5,70000],[80,83,2**32-1]],dtype='<u8'))
        meta = {**self.meta, 'type':'CxvLabeledMultiROI'}
        matrix = pose_matrix(self.pose) @ meta['grid']['voxel_xyz_to_world']
        for time in (0,1):
            xyz = np.array([[2.1,0,0],[4.49,0,0],[0,1,0],[0,0,1]])
            world = xyz @ matrix[:3,:3].T + matrix[:3,3]
            sparse = Sampler(self.root,meta,self.pose,time).sample(world)[0]
            np.save(self.root/'labels.npy',labels)
            dense = Sampler(self.root,meta,self.pose,time).sample(world)[0]
            np.testing.assert_array_equal(sparse,dense)
            self.assertTrue(set(sparse.tolist()).issubset({0,70000,2**32-1}))
            (self.root/'labels.npy').unlink()

    def test_dataset_union_and_separate_settings(self):
        (self.root/'metadata.json').write_text(json.dumps(self.meta))
        # A mesh at a remote position must contribute to the dataset pivot.
        mesh=self.root/'mesh'; mesh.mkdir(); np.save(mesh/'vertices.npy',np.array([[-100,0,0],[-90,2,3]],dtype='<f4'))
        meshmeta={'type':'CxvFaceVertexMesh'}; (mesh/'metadata.json').write_text(json.dumps(meshmeta))
        catalog=Catalog(); catalog.objects={'v':self.root,'m':mesh}
        catalog.datasets={'d':{'objects':[{'id':'v'},{'id':'m'}]}}
        settings=self.root/'settings.json'; settings.write_text('{"port": 9000, "theme": "light"}')
        result=dataset_alignment(catalog,'d',settings)
        self.assertEqual(result['bounds'][0][0],-100)
        self.assertFalse(result['pose']['enabled'])
        save_alignment(settings,'d',self.pose)
        self.assertEqual(dataset_alignment(catalog,'d',settings)['pose'],self.pose)
        self.assertEqual(json.loads(settings.read_text())['port'],9000)

    def test_invalid_position_axis_time_and_plane_limit(self):
        for axis,coordinate,time in ((3,0,0),(0,float('nan'),0),(0,0,-1),(0,1e20,0)):
            with self.assertRaises(ValueError): reslice_packet(self.root,self.meta,self.pose,axis,coordinate,time)
        with self.assertRaises(ValueError): geometry({'type':'CxvFaceVertexMesh'},self.pose)

    def test_authenticated_alignment_and_reslice_http_roundtrip(self):
        self.pose['mirror'] = [True, False, True]
        (self.root/'metadata.json').write_text(json.dumps(self.meta))
        catalog=Catalog(); catalog.objects={'v':self.root}; catalog.datasets={'d':{'objects':[{'id':'v'}]}}
        settings=self.root/'settings.json'; settings.write_text('{"theme":"ocean","port":1234}')
        workspace=SimpleNamespace(ready=True,settings_file=settings,imports=None,cache=None)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(catalog,None,'test-pose',workspace=workspace))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        origin=f'http://127.0.0.1:{server.server_port}'
        def post(path,body,authorized=True):
            headers={'Content-Type':'application/json'}
            if authorized: headers.update({'Origin':origin,'X-Viewer-Token':'test-pose'})
            request=urllib.request.Request(origin+path,data=json.dumps(body).encode(),headers=headers)
            with urllib.request.urlopen(request) as response:return response.read()
        for path,body in [('/api/datasets/d/alignment',{'pose':self.pose}),('/api/objects/v/reslice-info',{'pose':self.pose})]:
            with self.assertRaises(urllib.error.HTTPError) as error:post(path,body,False)
            self.assertEqual(error.exception.code,403);error.exception.close()
        post('/api/datasets/d/alignment',{'pose':self.pose})
        with urllib.request.urlopen(origin+'/api/datasets/d/alignment') as response:
            self.assertEqual(json.load(response)['pose'],self.pose)
        self.assertNotIn('_alignment_bounds',catalog.public()[0])
        self.assertEqual(json.loads(settings.read_text())['theme'],'ocean')
        info=json.loads(post('/api/objects/v/reslice-info',{'pose':self.pose}))
        for axis in range(3):
            coordinate=sum(b[axis] for b in info['bounds'])/2
            header,arrays=unpack(post('/api/objects/v/reslice',{'pose':self.pose,'axis':axis,'coordinate':coordinate,'time':1}))
            self.assertEqual(header['time_step'],1);self.assertTrue(arrays['mask'].any())
        before=settings.read_bytes()
        with self.assertRaises(urllib.error.HTTPError) as error:post('/api/datasets/d/alignment',{'pose':{**self.pose,'pivot':[0,0]}})
        self.assertEqual(error.exception.code,400);error.exception.close();self.assertEqual(settings.read_bytes(),before)

    def test_all_mirror_combinations_reverse_ct_and_segmentation_without_modifying_sources(self):
        self.meta['grid']['voxel_xyz_to_world'] = np.eye(4).tolist()
        labels = (self.data.astype('<u4') + 1) * 70000
        np.save(self.root/'labels.npy', labels)
        np.save(self.root/'label_intervals.npy', np.array([[i, i, value] for i, value in enumerate(labels.ravel())], dtype='<u8'))
        before = {p.name: p.read_bytes() for p in self.root.glob('*.npy')}
        for bits in range(8):
            mirror = [bool(bits & (1 << i)) for i in range(3)]
            pose = {'enabled': True, 'rotation': np.eye(3).tolist(), 'pivot': [2, 1.5, 1], 'mirror': mirror}
            self.assertAlmostEqual(np.linalg.det(pose_matrix(pose)[:3,:3]), (-1)**sum(mirror))
            for time in (0, 1):
                for kind, data in [('CxvChannel',self.data),('CxvLabeledMultiROI',labels)]:
                    expected = data[time]
                    for axis in range(3):
                        if mirror[axis]: expected = np.flip(expected, axis=2-axis)
                    meta = {**self.meta, 'type': kind}
                    for axis in range(3):
                        _, arrays = unpack(reslice_packet(self.root, meta, pose, axis, 1, time))
                        np.testing.assert_array_equal(arrays['pixels'], np.take(expected, 1, axis=2-axis))
                        self.assertTrue(arrays['mask'].all())
            # Sparse interval labels must agree with the dense reference after a reflection.
            dense = self.root/'labels.npy'; sparse_backup = self.root/'dense-backup.npy'; dense.rename(sparse_backup)
            try:
                _, arrays = unpack(reslice_packet(self.root, {**self.meta,'type':'CxvLabeledMultiROI'}, pose, 2, 1, 1))
                np.testing.assert_array_equal(arrays['pixels'], expected[1])
            finally: sparse_backup.rename(dense)
        for name, content in before.items(): self.assertEqual((self.root/name).read_bytes(), content)

    def test_mirror_validation_and_legacy_saved_pose_migration(self):
        legacy = {k:v for k,v in self.pose.items() if k!='mirror'}
        migrated = validate_pose(legacy)
        self.assertEqual(migrated['mirror'], [False]*3)
        np.testing.assert_array_equal(pose_matrix(legacy), pose_matrix(migrated))
        for invalid in (None, [], [True], [True,False,False,True], [1,0,0], ['true',False,False], {'x':True}):
            with self.assertRaises(ValueError): validate_pose({**legacy,'mirror':invalid})
        disabled = {**self.pose,'enabled':False,'mirror':[True]*3}
        np.testing.assert_array_equal(pose_matrix(disabled), np.eye(4))
        (self.root/'metadata.json').write_text(json.dumps(self.meta))
        catalog=Catalog(); catalog.objects={'v':self.root}; catalog.datasets={'d':{'objects':[{'id':'v'}]}}
        settings=self.root/'legacy.json'; settings.write_text(json.dumps({'alignments':{'d':legacy},'theme':'light'}))
        before=settings.read_bytes(); restored=dataset_alignment(catalog,'d',settings)['pose']
        self.assertEqual(restored,migrated);self.assertEqual(settings.read_bytes(),before)


if __name__ == '__main__': unittest.main()
