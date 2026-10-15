"""Semantic regression tests; fixtures do not replace public-data acceptance."""
import contextlib
import io
import json
from pathlib import Path
import shutil
import struct
import unittest
import uuid
import xml.etree.ElementTree as ET
import numpy as np

import ors_binary as binary
import ors_decode as decode


class SemanticTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parent
        self.base = root / ('test_sem_' + uuid.uuid4().hex)
        self.base.mkdir()
        assert self.base.resolve().parent == root
        self.addCleanup(shutil.rmtree, self.base)

    def test_inactive_multiroi_slots_are_ignored(self):
        # Slot 2 contains stale, invalid data; only the linked active list counts.
        nxt = np.array([0, 3, 0, 0], dtype='<u4')
        prev = np.array([0, 0, 0, 1], dtype='<u4')
        low = np.array([0, 1, 99999, 6, 123], dtype='<u4')
        high = np.array([0, 3, 0, 6, 124], dtype='<u4')
        labels = np.array([0, 70000, 5, 9, 10], dtype='<u4')
        lo, hi, labs = decode.active_intervals(nxt, prev, low, high, labels, 1, 3, 2, 10)
        self.assertEqual(decode.label_counts(lo, hi, labs), {70000: 3, 9: 1})

    def test_cycle_and_broken_backlink_rejected(self):
        for nxt, prev in [([0, 1], [0, 0]), ([0, 0], [0, 1])]:
            with self.assertRaises(binary.FormatError):
                decode.active_intervals(np.array(nxt), np.array(prev), np.array([0, 1]),
                                        np.array([0, 2]), np.array([0, 1]), 1, 1, 1, 10)

    def test_out_of_bounds_and_overlapping_intervals_rejected(self):
        for lo, hi in [([1, 3], [3, 4]), ([2], [10]), ([5], [3])]:
            with self.assertRaises(binary.FormatError):
                decode.check_runs(np.array(lo), np.array(hi), 10)

    def test_empty_tree_with_allocated_capacity(self):
        lo, hi, labs = decode.active_intervals(np.array([0]), np.array([0]),
            np.zeros(1000, dtype='<u4'), np.zeros(1000, dtype='<u4'), np.zeros(1000, dtype='<u4'),
            0, 0, 0, 100)
        self.assertEqual(len(lo), 0)

    def test_dense_label_ids_are_not_truncated_and_counts_match(self):
        result = decode.dense_labels(self.base / 'labels.npy', [1, 2, 2, 3],
            np.array([1, 6]), np.array([3, 8]), np.array([70000, 9]), 1000)
        array = np.load(self.base / 'labels.npy', allow_pickle=False)
        self.assertEqual(array.dtype, np.dtype('<u4'))
        self.assertEqual(array.shape, (1, 2, 2, 3))
        self.assertEqual(result['full_volume_label_counts'], {0: 6, 9: 3, 70000: 3})

    def test_dense_size_limit_preserves_sparse_contract(self):
        result = decode.dense_labels(self.base / 'labels.npy', [1, 100, 100, 100],
            np.array([1]), np.array([3]), np.array([1]), 100)
        self.assertEqual(result['status'], 'skipped_size_limit')
        self.assertFalse((self.base / 'labels.npy').exists())

    def test_utf16_empty_strings_and_duplicate_keys(self):
        self.assertEqual(decode.read_strings('key\0\0key\0value\0'.encode('utf-16-be')),
                         ['key', '', 'key', 'value'])
        with self.assertRaises(binary.FormatError):
            decode.read_strings(b'odd')

    def test_channel_all_time_steps_and_dtype_roundtrip(self):
        array = np.arange(48, dtype='<u2').reshape(2, 2, 3, 4)
        obj = ET.Element('CxvChannel', GUID='fixture')
        ET.SubElement(obj, 'title').text = 'volume'
        ET.SubElement(obj, 'orientationBox', direction0Spacing='0.5', direction1Spacing='0.25',
            direction2Spacing='2', direction0Size='2', direction1Size='0.75', direction2Size='4')
        ET.SubElement(obj, 'TSize').text = '2'
        ET.SubElement(obj, 'DataType').text = '2'
        ET.SubElement(obj, 'DataOffset').text = '12'
        root = ET.Element('XVision_Objects'); root.append(obj)
        xml = b'<?xml version="1.0"?>' + ET.tostring(root)
        raw = array.tobytes(); file = self.base / 'fixture.ORSSession'
        file.write_bytes(b'ORSD' + struct.pack('<Q', 20 + len(raw)) + struct.pack('<Q', len(raw)) + raw + xml)
        with contextlib.redirect_stdout(io.StringIO()):
            binary.extract(file, self.base / 'raw')
            report = decode.decode(self.base / 'raw', self.base / 'typed')
        self.assertFalse(report['errors'])
        out = np.load(self.base / 'typed' / 'object_00000' / 'volume.npy')
        np.testing.assert_array_equal(out, array)
        self.assertTrue(report['objects'][0]['files'][0]['payload_roundtrip_verified'])

    def test_tampered_record_is_rejected(self):
        from test_ors_binary import legacy
        file = self.base / 'fixture.ORSSession';file.write_bytes(legacy([b'1234']))
        binary.extract(file, self.base / 'raw')
        (self.base / 'raw' / 'record_000000.bin').write_bytes(b'5678')
        store = decode.Records(self.base / 'raw')
        node = ET.Element('Array');ET.SubElement(node, 'RecordOffset').text = '12'
        with self.assertRaisesRegex(binary.FormatError, 'SHA-256'):
            store.array(node, 'u1')

    def test_tampered_metadata_is_rejected(self):
        from test_ors_binary import legacy
        file = self.base / 'fixture.ORSSession';file.write_bytes(legacy([b'1234']))
        binary.extract(file, self.base / 'raw')
        xml = self.base / 'raw' / 'metadata.xml'
        xml.write_bytes(xml.read_bytes().replace(b'test', b'edit'))
        with self.assertRaisesRegex(binary.FormatError, 'Metadata XML SHA-256'):
            decode.Records(self.base / 'raw')

    def test_binary_ply_retains_face_order_and_coordinates(self):
        vertices = np.array([[0, 0, 0], [1.25, 0, 0], [0, 2.5, 0]], dtype='<f4')
        faces = np.array([[2, 1, 0]], dtype='<u4')
        path = self.base / 'mesh.ply'
        decode.write_ply(path, vertices, faces)
        raw = path.read_bytes();off = raw.index(b'end_header\n') + len(b'end_header\n')
        np.testing.assert_array_equal(np.frombuffer(raw, dtype='<f4', count=9, offset=off).reshape(3, 3), vertices)
        self.assertEqual(raw[off + 36], 3)
        np.testing.assert_array_equal(np.frombuffer(raw, dtype='<u4', count=3, offset=off + 37), faces[0])

    def test_scalar_scaling_preserves_raw_values_and_units(self):
        class Store:
            def array(self, node, dtype, count=None):
                values = {'DataTypesScalarValues': [5], 'SlopeScalarValues': [2],
                          'OffsetScalarValues': [10], 'ScalarValues_0': [1.5, 3.0]}
                return np.array(values[node.tag], dtype=dtype)
        obj = ET.fromstring('''<S ScalarValuesSlotCount="1"><DataTypesScalarValues/>
            <SlopeScalarValues/><OffsetScalarValues/><ScalarValues_0><size>2</size></ScalarValues_0>
            <DescriptionScalarValues><Entry Value="measurement"/></DescriptionScalarValues>
            <ScalarValuesDimensionUnit_0><unitAbbreviation>m</unitAbbreviation></ScalarValuesDimensionUnit_0></S>''')
        table, arrays = decode.export_scalars(Store(), obj, self.base, 'ScalarValues', 'table', 'index')
        np.testing.assert_array_equal(np.load(self.base / 'table_000.npy'), [1.5, 3.0])
        import csv
        with (self.base / 'table.csv').open(encoding='utf-8-sig') as stream:
            rows = list(csv.reader(stream))
        self.assertEqual(rows[1:], [['0', '13.0'], ['1', '16.0']])


if __name__ == '__main__':
    unittest.main()
