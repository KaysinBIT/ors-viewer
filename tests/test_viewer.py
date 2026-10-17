"""Real HTTP and numerical preview checks. No browser/Dragonfly dependency."""
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import struct
import threading
import unittest
import urllib.error
import urllib.request
import uuid
import io
import time
from unittest.mock import patch

import numpy as np
from viewer.preview import packet, sample_labels, label_preview, mesh_preview, volume_preview, full_volume_preview, write_volume_preview, parse_sample_counts, validate_sample_counts, sample_indices, PreviewCache, safe_file, controlled_mesh
from viewer.server import Catalog, handler, table_data
from viewer.imports import ImportJobs, import_standard, validate_source
from viewer.simplify import simplify_packet


def unpack(data):
    size = struct.unpack_from('<I', data)[0]
    meta = json.loads(data[4:4 + size]);base = 4 + ((size + 3) // 4) * 4
    arrays = {k: np.frombuffer(data, dtype=v['dtype'], count=v['bytes'] // np.dtype(v['dtype']).itemsize,
                              offset=base + v['offset']).reshape(v['shape']) for k, v in meta['arrays'].items()}
    return meta, arrays


class ViewerTests(unittest.TestCase):
    def setUp(self):
        self.root = Path(__file__).resolve().parent
        self.work = self.root / ('test_viewer_' + uuid.uuid4().hex);self.work.mkdir()
        assert self.work.resolve().parent == self.root
        self.addCleanup(shutil.rmtree, self.work)

    def segmentation(self, dense=True):
        data = np.zeros((1, 7, 8, 9), dtype='<u4');data[0, 1:3, 2:4, 3:5] = 70000;data[0, 5, 6, 7] = 9
        flat = data.ravel();runs = []
        for i in np.flatnonzero(flat): runs.append([i, i, int(flat[i])])
        np.save(self.work / 'label_intervals.npy', np.array(runs, dtype='<u4'))
        if dense: np.save(self.work / 'labels.npy', data)
        matrix = [[0, -2, 0, 10], [3, 0, 0, 20], [0, 0, 4, 30], [0, 0, 0, 1]]
        return {'type': 'CxvLabeledMultiROI', 'grid': {'shape_tzyx': list(data.shape), 'voxel_xyz_to_world': matrix},
                'label_voxel_counts': {'70000': 8, '9': 1}, 'foreground_voxels': 9}, data

    def test_packet_alignment_and_roundtrip(self):
        meta, arrays = unpack(packet({'kind': '测试'}, {'bytes': np.array([1, 2, 3], dtype='u1'),
                                                     'floats': np.array([1.25, 2.5], dtype='<f4')}))
        np.testing.assert_array_equal(arrays['floats'], [1.25, 2.5])
        self.assertEqual(meta['arrays']['floats']['offset'] % 4, 0)

    def test_sparse_and_dense_sampling_match_without_truncating_ids(self):
        meta, _ = self.segmentation();dense, _ = sample_labels(self.work, meta, 4)
        (self.work / 'labels.npy').unlink();sparse, _ = sample_labels(self.work, meta, 4)
        np.testing.assert_array_equal(dense, sparse)

    def test_tiny_label_can_be_focused_even_if_overview_misses_it(self):
        meta, _ = self.segmentation(dense=False)
        overview, _ = sample_labels(self.work, meta, 2)
        self.assertNotIn(9, overview)
        detail, axes = sample_labels(self.work, meta, 2, label_id=9)
        self.assertEqual(detail.shape, (1, 1, 1));self.assertEqual(int(detail[0, 0, 0]), 9)
        header, arrays = unpack(label_preview(self.work, meta, 2, label_id=9))
        self.assertEqual(header['focus_label'], 9);self.assertEqual(header['preview_triangles'], 12)
        # Index [x=7, y=6, z=5] with half-voxel bounds transformed by the real affine.
        np.testing.assert_allclose(arrays['positions'].min(0), [-3, 39.5, 48])
        np.testing.assert_allclose(arrays['positions'].max(0), [-1, 42.5, 52])

    def test_surface_triangle_indices_valid(self):
        meta, _ = self.segmentation();header, arrays = unpack(label_preview(self.work, meta, 20))
        self.assertLess(int(arrays['indices'].max()), len(arrays['positions']))
        self.assertEqual(set(g['id'] for g in header['groups']), {9, 70000})

    def test_volume_time_axis_affine_and_original_unchanged(self):
        volume = np.arange(2 * 3 * 4 * 5, dtype='<u2').reshape(2, 3, 4, 5)
        np.save(self.work / 'volume.npy', volume)
        source = self.work / 'volume.npy';before = hashlib.sha256(source.read_bytes()).hexdigest()
        meta = {'grid': {'voxel_xyz_to_world': np.diag([2, 3, 4, 1]).tolist()}}
        header, arrays = unpack(volume_preview(self.work, meta, 64, 1))
        self.assertEqual(header['range'], [60, 119]);self.assertEqual(arrays['volume'].shape, (3, 4, 5))
        np.testing.assert_allclose(np.array(header['matrix'])[:3, 3], [4, 4.5, 4])
        self.assertEqual(before, hashlib.sha256(source.read_bytes()).hexdigest())

    def test_full_volume_streams_every_voxel_in_both_storage_orders(self):
        for order in ('C','F'):
            data=np.array(np.arange(2*3*5*7).reshape(2,3,5,7),dtype='<f4',order=order)
            data[1,0,0,0]=np.nan;data[1,0,0,1]=np.inf
            np.save(self.work/'volume.npy',data)
            before=(self.work/'volume.npy').read_bytes()
            meta={'type':'CxvChannel','grid':{'voxel_xyz_to_world':np.diag([2,3,4,1]).tolist()}}
            output=self.work/'full.bin'
            with patch('viewer.preview.VOLUME_CHUNK_VOXELS',17):full_volume_preview(self.work,meta,output,1)
            header,arrays=unpack(output.read_bytes());reference,expected=unpack(volume_preview(self.work,meta,7,1))
            self.assertEqual(header['full_resolution'],True);self.assertEqual(header['sample_shape_zyx'],[3,5,7])
            for key in ('matrix','range','time_step','window','original_dtype'):self.assertEqual(header[key],reference[key])
            np.testing.assert_array_equal(arrays['volume'],expected['volume'])
            self.assertEqual(before,(self.work/'volume.npy').read_bytes())

    def test_full_volume_cache_is_separate_and_refuses_limits_without_fallback(self):
        data=np.arange(1*4*5*201,dtype='<u2').reshape(1,4,5,201);np.save(self.work/'volume.npy',data)
        meta={'type':'CxvChannel','grid':{'shape_tzyx':list(data.shape)}};cache=PreviewCache(self.work/'cache')
        full=cache.get(self.work,meta,'full');fine=cache.get(self.work,meta,'fine')
        self.assertNotEqual(full,fine);self.assertEqual(full,cache.get(self.work,meta,'full'))
        self.assertEqual(unpack(full.read_bytes())[1]['volume'].shape,data.shape[1:])
        self.assertLess(unpack(fine.read_bytes())[1]['volume'].shape[-1],data.shape[-1])
        with self.assertRaises(ValueError):cache.get(self.work,{'type':'CxvLabeledMultiROI'},'full')
        output=self.work/'rejected.bin'
        with patch('viewer.preview.MAX_FULL_VOLUME_BYTES',10):
            with self.assertRaisesRegex(ValueError,'没有自动降采样'):full_volume_preview(self.work,meta,output)
        self.assertFalse(output.exists())
        with self.assertRaises(ValueError):full_volume_preview(self.work,meta,output,2)
        np.save(self.work/'volume.npy',np.full((1,2,3,4),np.nan,dtype='<f4'))
        with self.assertRaisesRegex(ValueError,'没有有限数值'):full_volume_preview(self.work,meta,output)
        self.assertFalse(output.exists())

    def test_custom_samples_have_exact_counts_endpoints_and_unchanged_coordinates(self):
        for order in ('C','F'):
            data=np.array(np.arange(2*5*6*8).reshape(2,5,6,8),dtype='<f4',order=order)
            np.save(self.work/'volume.npy',data);before=(self.work/'volume.npy').read_bytes()
            meta={'type':'CxvChannel','grid':{'voxel_xyz_to_world':[[2,.2,0,80],[0,3,0,-40],[0,0,4,10],[0,0,0,1]]}}
            for counts,axes in [([3,4,2],([0,4],[0,2,3,5],[0,4,7])),([1,1,1],([2],[2],[3])),([8,6,5],(range(5),range(6),range(8)))]:
                output=self.work/'custom.bin'
                with patch('viewer.preview.VOLUME_CHUNK_VOXELS',7):write_volume_preview(self.work,meta,output,1,counts)
                header,arrays=unpack(output.read_bytes());sample=data[1][np.ix_(*axes)]
                lo,hi=float(sample.min()),float(sample.max())
                expected=np.clip((sample-lo)/max(hi-lo,1e-20)*255,0,255).astype('u1')
                np.testing.assert_array_equal(arrays['volume'],expected)
                self.assertEqual(header['sample_shape_zyx'],counts[::-1]);self.assertEqual(header['requested_samples_xyz'],counts)
                self.assertTrue(header['custom_sampling']);self.assertEqual(header['time_step'],1)
                reference=unpack(volume_preview(self.work,meta,8,1))[0]
                self.assertEqual(header['matrix'],reference['matrix']);self.assertEqual(header['original_shape_tzyx'],list(data.shape))
            self.assertEqual(before,(self.work/'volume.npy').read_bytes())

    def test_custom_sampling_validation_and_cache_keys_include_counts_and_time(self):
        shape=(2,5,6,8);np.save(self.work/'volume.npy',np.arange(np.prod(shape),dtype='<u2').reshape(shape))
        meta={'type':'CxvChannel','grid':{}};cache=PreviewCache(self.work/'cache')
        first=cache.get(self.work,meta,'custom',sample_counts=[3,4,2])
        self.assertEqual(first,cache.get(self.work,meta,'custom',sample_counts=[3,4,2]))
        self.assertNotEqual(first,cache.get(self.work,meta,'custom',sample_counts=[4,3,2]))
        self.assertNotEqual(first,cache.get(self.work,meta,'custom',1,sample_counts=[3,4,2]))
        self.assertEqual(parse_sample_counts('3,4,2'),(3,4,2))
        for bad in (None,'','1,2','1,2,3,4','1.5,2,3','-1,2,3','NaN,2,3','１２,2,3'):
            with self.assertRaises(ValueError):parse_sample_counts(bad)
        for bad in (None,[],[0,2,3],[9,2,3],[1,7,3],[1,2,6],[True,2,3],[1.5,2,3]):
            with self.assertRaises(ValueError):validate_sample_counts(bad,shape)
        with patch('viewer.preview.MAX_FULL_VOLUME_BYTES',10):
            with self.assertRaisesRegex(ValueError,'2 GiB'):validate_sample_counts([3,3,3],shape)
        with self.assertRaises(ValueError):cache.get(self.work,{'type':'CxvLabeledMultiROI'},'custom',sample_counts=[1,1,1])

    def test_custom_sampling_http_returns_requested_shape_and_rejects_bad_input(self):
        np.save(self.work/'volume.npy',np.arange(2*5*6*8,dtype='<u2').reshape(2,5,6,8))
        (self.work/'metadata.json').write_text(json.dumps({'type':'CxvChannel','grid':{}}))
        catalog=Catalog();catalog.objects={'v':self.work}
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(catalog,PreviewCache(self.work/'cache'),'token'))
        threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        url=f'http://127.0.0.1:{server.server_port}/api/objects/v/preview?quality=custom'
        with urllib.request.urlopen(url+'&samples=3,4,2&time=1') as response:header,arrays=unpack(response.read())
        self.assertEqual(arrays['volume'].shape,(2,4,3));self.assertEqual(header['requested_samples_xyz'],[3,4,2])
        for query in ('','&samples=0,2,3','&samples=9,2,3','&samples=1.5,2,3'):
            with self.assertRaises(urllib.error.HTTPError) as error:urllib.request.urlopen(url+query)
            self.assertEqual(error.exception.code,400);error.exception.close()

    def test_mesh_preview_removes_degeneracy_and_preserves_bounds(self):
        v = np.array([[0,0,0],[1,0,0],[0,1,0],[0,0,1]], dtype='<f4');f = np.array([[0,1,2],[0,1,3],[0,2,3],[1,2,3]],dtype='<u4')
        np.save(self.work / 'vertices.npy', v);np.save(self.work / 'triangles.npy', f)
        header, arrays = unpack(mesh_preview(self.work, {}, 64))
        self.assertEqual(header['preview_triangles'], 4)
        self.assertTrue(np.all(arrays['indices'][:,0] != arrays['indices'][:,1]))

    def test_table_page_and_scaling_are_from_full_arrays(self):
        np.save(self.work / 'values.npy', np.arange(150, dtype='<f8'))
        meta = {'tables': [{'group':'m','row_count':150,'row_kind':'label_index',
                  'columns':[{'index':0,'name':'Value','file':'values.npy','slope':2,'offset':1}]}]}
        result = table_data(self.work, meta, 'm', 50, 50)
        self.assertEqual(result['rows'][0], [50,101]);self.assertEqual(result['rows'][-1],[99,199])
        self.assertEqual(result['total'],150)

    def test_default_mesh_has_exact_original_vertices_and_faces_including_duplicates(self):
        v=np.array([[0,0,0],[1,0,0],[0,1,0],[0,1,0]],dtype='<f4')
        f=np.array([[0,1,2],[0,1,2],[0,0,3]],dtype='<u4')
        np.save(self.work/'vertices.npy',v);np.save(self.work/'triangles.npy',f)
        path=PreviewCache(self.work/'cache').get(self.work,{'type':'CxvFaceVertexMesh'})
        meta,arrays=unpack(path.read_bytes())
        self.assertFalse(meta['simplified']);self.assertEqual(meta['actual_retention'],100)
        np.testing.assert_array_equal(arrays['positions'],v);np.testing.assert_array_equal(arrays['indices'],f)

    def test_user_requested_retention_reduces_faces_and_can_restore_exact_mesh(self):
        n=50;y,x=np.mgrid[:n,:n];v=np.column_stack([x.ravel(),y.ravel(),np.sin(x.ravel()/7)]).astype('<f4')
        a=(y[:-1,:-1]*n+x[:-1,:-1]).ravel();f=np.concatenate([np.column_stack([a,a+1,a+n]),np.column_stack([a+1,a+n+1,a+n])]).astype('<u4')
        np.save(self.work/'vertices.npy',v);np.save(self.work/'triangles.npy',f)
        before=hashlib.sha256((self.work/'triangles.npy').read_bytes()).hexdigest()
        header,arrays=unpack(controlled_mesh(self.work,{},20))
        self.assertLess(header['preview_triangles'],len(f)*.35);self.assertGreater(header['preview_triangles'],len(f)*.1)
        self.assertLess(arrays['indices'].max(),len(arrays['positions']))
        self.assertEqual(header['requested_retention'],20)
        _,restored=unpack(controlled_mesh(self.work,{},100));np.testing.assert_array_equal(restored['indices'],f)
        self.assertEqual(before,hashlib.sha256((self.work/'triangles.npy').read_bytes()).hexdigest())

    def test_reduction_preserves_label_groups_and_valid_indices(self):
        meta,_=self.segmentation();raw=label_preview(self.work,meta,20)
        header,arrays=unpack(simplify_packet(raw,20))
        self.assertEqual({g['id'] for g in header['groups']},{70000,9})
        self.assertEqual(sum(g['count'] for g in header['groups']),arrays['indices'].size)
        self.assertLess(arrays['indices'].max(),len(arrays['positions']))

    def test_import_npy_and_invalid_ors_header(self):
        source=self.work/'volume.npy';data=np.arange(60,dtype='<u2').reshape(3,4,5);np.save(source,data)
        import_standard(source,self.work/'result');catalog=Catalog();dataset=catalog.add(self.work/'result')
        folder,meta=catalog.get(dataset['objects'][0]['id'])
        self.assertEqual(meta['grid']['shape_tzyx'],[1,3,4,5]);np.testing.assert_array_equal(np.load(folder/'volume.npy')[0],data)
        bad=self.work/'bad.ORSSession';bad.write_bytes(b'NOPE')
        with self.assertRaises(ValueError):validate_source(bad)

    def test_stl_binary_and_ascii_keep_every_triangle(self):
        triangle=np.array([[0,0,0],[1,0,0],[0,1,0]],dtype='<f4')
        ascii_file=self.work/'ascii.stl'
        ascii_file.write_text('solid test\nfacet normal 0 0 1\nouter loop\n'+''.join('vertex %g %g %g\n'%tuple(v) for v in triangle)+'endloop\nendfacet\nendsolid\n')
        binary_file=self.work/'binary.stl'
        binary_file.write_bytes(b'test'.ljust(80,b'\0')+struct.pack('<I',1)+struct.pack('<12fH',0,0,1,*triangle.ravel(),0))
        for i,source in enumerate([ascii_file,binary_file]):
            output=self.work/('stl%d'%i);import_standard(source,output)
            folder=output/'data'/'object_00000';v=np.load(folder/'vertices.npy');f=np.load(folder/'triangles.npy')
            np.testing.assert_array_equal(v[f][0],triangle);self.assertEqual(len(f),1)

    def test_http_file_upload_job_and_persistent_catalog(self):
        catalog=Catalog();jobs=ImportJobs(self.work/'imported',catalog);self.addCleanup(jobs.pool.shutdown)
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(catalog,PreviewCache(self.work/'cache'),'test-token',jobs))
        threading.Thread(target=server.serve_forever,daemon=True).start();self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        url='http://127.0.0.1:%d'%server.server_port;stream=io.BytesIO();np.save(stream,np.ones((2,3,4),dtype='u2'))
        request=urllib.request.Request(url+'/api/import-upload?name=sample.npy',data=stream.getvalue(),
             headers={'Content-Type':'application/octet-stream','Origin':url,'X-Viewer-Token':'test-token'})
        with urllib.request.urlopen(request) as response:self.assertEqual(response.status,202);job=json.load(response)
        deadline=time.monotonic()+10
        while job['status'] not in ('failed','completed') and time.monotonic()<deadline:
            time.sleep(.02);job=jobs.get(job['id'])
        self.assertEqual(job['status'],'completed',job)
        folder,meta=catalog.get(catalog.public()[0]['objects'][0]['id']);self.assertEqual(meta['title'],'sample')
        fresh=Catalog();restored=ImportJobs(self.work/'imported',fresh);self.addCleanup(restored.pool.shutdown)
        self.assertEqual(len(fresh.public()),1);self.assertEqual(restored.get(job['id'])['status'],'completed')

    def test_path_escape_is_rejected(self):
        with self.assertRaises(ValueError): safe_file(self.work, '../server.py')

    def test_http_page_catalog_and_write_origin_guard(self):
        catalog = Catalog();cache = PreviewCache(self.work / 'cache')
        server = ThreadingHTTPServer(('127.0.0.1',0),handler(catalog,cache,'test-token'))
        thread = threading.Thread(target=server.serve_forever,daemon=True);thread.start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        url = 'http://127.0.0.1:%d/' % server.server_port
        with urllib.request.urlopen(url) as response:
            self.assertEqual(response.status,200);self.assertIn(b'test-token',response.read())
        with urllib.request.urlopen(url+'api/catalog') as response:
            self.assertEqual(json.load(response),{'datasets':[]})
        request=urllib.request.Request(url+'api/datasets',data=b'{}',headers={'Content-Type':'application/json'})
        with self.assertRaises(urllib.error.HTTPError) as caught: urllib.request.urlopen(request)
        self.assertEqual(caught.exception.code,403)
        caught.exception.close()


if __name__ == '__main__': unittest.main()
