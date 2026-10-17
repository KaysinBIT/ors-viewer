from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import numpy as np

from viewer.affine import matrix_product, transform_points, inverse_affine, determinant3
from viewer.alignment import pose_matrix
from viewer.reslice import reslice_packet
from viewer.simplify import unpack


class AffineTests(unittest.TestCase):
    def test_affine_inverse_and_points_preserve_units_shear_mirror_and_offset(self):
        rng=np.random.default_rng(728)
        for units in (1e-9, 4e-5, 1, 1e6):
            for _ in range(12):
                matrix=np.eye(4);matrix[:3,:3]=(np.eye(3)+rng.normal(size=(3,3))*.15)*units
                matrix[0,:3]*=-1;matrix[:3,3]=[.01,-.04,.02]
                inverse=inverse_affine(matrix)
                np.testing.assert_allclose(inverse,np.linalg.inv(matrix),rtol=1e-12,atol=1e-12)
                points=rng.normal(size=(31,3))
                np.testing.assert_allclose(transform_points(points,matrix),points@matrix[:3,:3].T+matrix[:3,3],rtol=1e-12,atol=1e-12)
                np.testing.assert_allclose(matrix_product(matrix,inverse),np.eye(4),rtol=1e-12,atol=1e-12)
        with self.assertRaises(ValueError):inverse_affine(np.zeros((4,4)))

    def test_rotation_validation_and_reslicing_do_not_call_blas_or_lapack(self):
        pose={'enabled':True,'rotation':[[0,-1,0],[1,0,0],[0,0,1]],'pivot':[2,2,2],'mirror':[True,False,False]}
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);data=np.arange(1*4*5*6,dtype='<u2').reshape(1,4,5,6);np.save(folder/'volume.npy',data)
            meta={'type':'CxvChannel','grid':{'shape_tzyx':list(data.shape),'voxel_xyz_to_world':np.eye(4).tolist()}}
            with patch('numpy.matmul',side_effect=AssertionError('BLAS not allowed')),patch('numpy.linalg.inv',side_effect=AssertionError('LAPACK not allowed')),patch('numpy.linalg.det',side_effect=AssertionError('LAPACK not allowed')):
                transform=pose_matrix(pose);self.assertAlmostEqual(determinant3(transform[:3,:3]),-1)
                _,arrays=unpack(reslice_packet(folder,meta,pose,2,1))
                self.assertTrue(np.isfinite(arrays['pixels']).all())

    def test_parallel_planes_match_serial_results_and_keep_the_source_unchanged(self):
        with tempfile.TemporaryDirectory() as tmp:
            folder=Path(tmp);data=np.arange(1*16*20*24,dtype='<f4').reshape(1,16,20,24);np.save(folder/'volume.npy',data)
            meta={'type':'CxvChannel','grid':{'shape_tzyx':list(data.shape),'voxel_xyz_to_world':np.eye(4).tolist()}}
            pose={'enabled':True,'rotation':[[0,-1,0],[1,0,0],[0,0,1]],'pivot':[10,10,10],'mirror':[False,True,False]}
            before=(folder/'volume.npy').read_bytes()
            expected=[reslice_packet(folder,meta,pose,axis,10) for axis in range(3)]
            with ThreadPoolExecutor(max_workers=6) as pool:
                results=list(pool.map(lambda i:reslice_packet(folder,meta,pose,i%3,10),range(48)))
            for i,result in enumerate(results):self.assertEqual(result,expected[i%3])
            self.assertEqual((folder/'volume.npy').read_bytes(),before)


if __name__=='__main__':unittest.main()
