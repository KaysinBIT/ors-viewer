from concurrent.futures import Future, ThreadPoolExecutor
from concurrent.futures.process import BrokenProcessPool
import hashlib
import math
import multiprocessing
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock, patch

import numpy as np

from viewer.reslice import geometry, reslice_packet
from viewer.reslice_pool import ResliceExecutor, validate_worker_count
from viewer.server import make_server


class ReslicePoolTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(); self.addCleanup(temp.cleanup)
        self.folder = Path(temp.name)
        self.data = np.arange(2*7*9*11, dtype='<f4').reshape(2,7,9,11)
        self.data[0,0,0,1] = np.nan; self.data[0,0,0,2] = np.inf
        np.save(self.folder/'volume.npy', self.data)
        self.meta = {'type':'CxvChannel','grid':{'shape_tzyx':list(self.data.shape),
                     'voxel_xyz_to_world':[[.002,.0002,0,.08],[0,.003,0,-.04],[0,0,.004,.01],[0,0,0,1]]}}
        angle = math.radians(23)
        self.pose = {'enabled':True,'rotation':[[math.cos(angle),-math.sin(angle),0],[math.sin(angle),math.cos(angle),0],[0,0,1]],
                     'pivot':[.09,-.03,.02],'mirror':[True,False,True]}

    def executor(self, **kwargs):
        with patch('viewer.reslice_pool.available_cpus', return_value=16):
            executor = ResliceExecutor(**kwargs)
        self.addCleanup(executor.close)
        return executor

    def test_worker_limits_and_automatic_core_reservation(self):
        with patch('viewer.reslice_pool.available_cpus', return_value=16):
            for value in (0,1,8,16,' 8 '): self.assertEqual(validate_worker_count(value),int(value))
            for value in (-1,17,True,1.5,'','-1','1.5','abc'):
                with self.assertRaises(ValueError): validate_worker_count(value)
            self.assertEqual(ResliceExecutor().workers,8)
        with patch('viewer.reslice_pool.available_cpus', return_value=4): self.assertEqual(ResliceExecutor().workers,3)
        with patch('viewer.reslice_pool.available_cpus', return_value=1): self.assertEqual(ResliceExecutor().workers,1)

    def test_small_planes_serial_mode_and_labels_do_not_spawn_workers(self):
        for executor in (self.executor(workers=2),self.executor(workers=1,min_pixels=0)):
            info,_=geometry(self.meta,self.pose);coordinate=sum(b[2] for b in info['bounds'])/2
            with patch('viewer.reslice_pool.ProcessPoolExecutor',side_effect=AssertionError('Must stay serial')):
                actual=reslice_packet(self.folder,self.meta,self.pose,2,coordinate,executor=executor)
                self.assertEqual(actual,reslice_packet(self.folder,self.meta,self.pose,2,coordinate))
        labels=np.full(self.data.shape,2**32-1,dtype='<u4');np.save(self.folder/'labels.npy',labels)
        meta={**self.meta,'type':'CxvLabeledMultiROI'};executor=self.executor(workers=2,min_pixels=0)
        with patch.object(executor,'sample',side_effect=AssertionError('Labels must keep nearest-neighbour sampling')):
            self.assertEqual(reslice_packet(self.folder,meta,self.pose,2,coordinate,executor=executor),reslice_packet(self.folder,meta,self.pose,2,coordinate))

    def test_spawned_workers_match_serial_bytes_for_pose_time_storage_and_concurrent_planes(self):
        children_before={p.pid for p in multiprocessing.active_children()}
        parent_blas_setting=os.environ.get('OPENBLAS_NUM_THREADS')
        executor=self.executor(workers=2,min_pixels=0)
        for order in ('C','F'):
            np.save(self.folder/'volume.npy',np.array(self.data,order=order))
            before=hashlib.sha256((self.folder/'volume.npy').read_bytes()).digest()
            for pose in (self.pose,{**self.pose,'enabled':False}):
                info,_=geometry(self.meta,pose);coordinates=[sum(b[a] for b in info['bounds'])/2 for a in range(3)]
                for time in (0,1):
                    expected=[reslice_packet(self.folder,self.meta,pose,a,coordinates[a],time) for a in range(3)]
                    with ThreadPoolExecutor(max_workers=3) as requests:
                        futures=[requests.submit(reslice_packet,self.folder,self.meta,pose,a,coordinates[a],time,executor) for a in range(3)]
                        self.assertEqual([f.result(timeout=30) for f in futures],expected)
            self.assertEqual(before,hashlib.sha256((self.folder/'volume.npy').read_bytes()).digest())
        self.assertIsNotNone(executor._pool)
        executor.close()
        self.assertFalse({p.pid for p in multiprocessing.active_children()}-children_before)
        self.assertEqual(os.environ.get('OPENBLAS_NUM_THREADS'),parent_blas_setting)

    def test_worker_failures_fall_back_without_restarting_a_broken_pool(self):
        info,_=geometry(self.meta,self.pose);coordinate=sum(b[2] for b in info['bounds'])/2
        expected=reslice_packet(self.folder,self.meta,self.pose,2,coordinate)
        for error in (OSError('spawn unavailable'),BrokenProcessPool('worker exited')):
            executor=self.executor(workers=2,min_pixels=0)
            pool=Mock()
            def fail(*args):
                future=Future();future.set_exception(error);return future
            pool.submit.side_effect=fail
            with patch('viewer.reslice_pool.ProcessPoolExecutor',return_value=pool) as factory:
                with self.assertLogs(level='WARNING'):
                    self.assertEqual(reslice_packet(self.folder,self.meta,self.pose,2,coordinate,executor=executor),expected)
                self.assertEqual(reslice_packet(self.folder,self.meta,self.pose,2,coordinate,executor=executor),expected)
                factory.assert_called_once()
            self.assertTrue(executor._failed);pool.shutdown.assert_called_once_with(wait=False,cancel_futures=True)

    def test_closed_pool_cannot_start_new_work(self):
        executor=self.executor(workers=2,min_pixels=0);executor.close()
        with self.assertRaisesRegex(RuntimeError,'停止切片'):
            executor.sample(self.folder,self.meta,self.pose,2,.02,0,100)

    def test_workspace_owns_worker_configuration_and_closes_it(self):
        server,_=make_server(0,[],self.folder/'workspace',self.folder/'settings.json',slice_workers=1)
        self.addCleanup(server.server_close);self.addCleanup(server.workspace.close)
        self.assertEqual(server.workspace.reslicer.workers,1)
        server.workspace.close();self.assertTrue(server.workspace.reslicer._closed)


if __name__=='__main__': unittest.main()
