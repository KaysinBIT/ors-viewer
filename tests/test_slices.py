"""Original-resolution MPR axes, time, geometry and HTTP contract."""
import hashlib
from http.server import ThreadingHTTPServer
import json
from pathlib import Path
import shutil
import uuid
import threading
import unittest
import urllib.error
import urllib.request

import numpy as np

from viewer.slices import slice_packet, voxel_value
from viewer.simplify import unpack
from viewer.server import handler


class SliceTests(unittest.TestCase):
    def setUp(self):
        parent = Path(__file__).resolve().parent
        self.root = parent / ('test_slices_' + uuid.uuid4().hex);self.root.mkdir()
        assert self.root.resolve().parent == parent
        self.addCleanup(shutil.rmtree,self.root)
        t,z,y,x = np.indices((2,3,4,5))
        self.data = (t*1000+z*100+y*10+x).astype('<u2')
        np.save(self.root/'volume.npy', self.data)
        self.matrix = [[0,-3,0,10],[2,0,1,20],[0,0,4,30],[0,0,0,1]]
        self.meta = {'type':'CxvChannel','grid':{'voxel_xyz_to_world':self.matrix}}

    def test_all_axes_every_boundary_both_times_and_unchanged_source(self):
        path=self.root/'volume.npy';before=hashlib.sha256(path.read_bytes()).hexdigest()
        for time in (0,1):
            for axis in range(3):
                for index in (0,self.data.shape[3-axis]-1):
                    header,arrays=unpack(slice_packet(self.root,self.meta,axis,index,time))
                    expected=np.take(self.data[time],index,axis=2-axis)
                    np.testing.assert_array_equal(arrays['pixels'],expected)
                    self.assertEqual(header['shape_yx'],list(expected.shape))
                    self.assertFalse(header['resampled']);self.assertEqual(header['time_step'],time)
                    self.assertEqual(header['voxel_xyz_to_world'],self.matrix)
                    xyz=[0,0,0];xyz[axis]=index
                    probe=voxel_value(self.root,self.meta,xyz,time)
                    self.assertEqual(probe['value'],str(self.data[time,xyz[2],xyz[1],xyz[0]]))
        self.assertEqual(before,hashlib.sha256(path.read_bytes()).hexdigest())

    def test_intersection_value_and_world_position(self):
        xyz=[4,2,1]
        for axis in range(3):
            _,arrays=unpack(slice_packet(self.root,self.meta,axis,xyz[axis],1))
            u,v=[[1,2],[0,2],[0,1]][axis]
            self.assertEqual(arrays['pixels'][xyz[v],xyz[u]],1124)
        probe=voxel_value(self.root,self.meta,xyz,1)
        self.assertEqual(probe['value'],'1124');self.assertEqual(probe['world_xyz'],[4,29,34])

    def test_singleton_nonfinite_and_exact_uint64_probe(self):
        np.save(self.root/'volume.npy',np.array([[[[np.nan,np.inf,-2.5]]]],dtype='<f8'))
        for axis in range(3):
            _,arrays=unpack(slice_packet(self.root,self.meta,axis,0))
            self.assertEqual(arrays['pixels'].ndim,2)
        self.assertEqual(voxel_value(self.root,self.meta,[0,0,0])['value'],'nan')
        value=2**63+123
        np.save(self.root/'volume.npy',np.array([[[[value]]]],dtype='<u8'))
        self.assertEqual(voxel_value(self.root,self.meta,[0,0,0])['value'],str(value))

    def test_rejects_bad_axis_index_time_object_and_coordinates(self):
        for axis,index,time in [(-1,0,0),(3,0,0),(0,-1,0),(0,5,0),(1,0,2)]:
            with self.assertRaises(ValueError):slice_packet(self.root,self.meta,axis,index,time)
        with self.assertRaises(ValueError):slice_packet(self.root,{'type':'CxvROI'},0,0)
        with self.assertRaises(ValueError):voxel_value(self.root,self.meta,[5,0,0])

    def test_http_binary_slice_and_probe(self):
        root,meta=self.root,self.meta
        class Catalog:
            def get(self,oid):
                if oid!='synthetic':raise KeyError('missing')
                return root,meta
        server=ThreadingHTTPServer(('127.0.0.1',0),handler(Catalog(),None,'test'))
        threading.Thread(target=server.serve_forever,daemon=True).start()
        self.addCleanup(server.server_close);self.addCleanup(server.shutdown)
        url=f'http://127.0.0.1:{server.server_port}/api/objects/synthetic/'
        with urllib.request.urlopen(url+'slice?axis=1&index=2&time=1') as response:
            header,arrays=unpack(response.read());self.assertEqual(header['axis'],1)
            np.testing.assert_array_equal(arrays['pixels'],self.data[1,:,2,:])
        with urllib.request.urlopen(url+'voxel?x=4&y=2&z=1&time=1') as response:
            self.assertEqual(json.load(response)['value'],'1124')
        with self.assertRaises(urllib.error.HTTPError) as error:
            urllib.request.urlopen(url+'slice?axis=9')
        self.assertEqual(error.exception.code,400)
        error.exception.close()


if __name__=='__main__':unittest.main()
