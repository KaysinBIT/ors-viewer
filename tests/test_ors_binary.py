"""Synthetic binary-container tests, separate from public-file evidence."""
import contextlib
import hashlib
import io
from pathlib import Path
import shutil
import struct
import unittest
import uuid
from compression import zstd

import ors_binary as binary


XML = b'<?xml version="1.0"?><XVision_Objects Version="fixture"><CxvChannel GUID="fixture"><title>test</title></CxvChannel></XVision_Objects>'


def legacy(records):
    body = b"".join(struct.pack("<Q", len(value)) + value for value in records)
    return b"ORSD" + struct.pack("<Q", 12 + len(body)) + body + XML


def modern(records, chunk_size=50):
    parts = []
    for value in records:
        frame = zstd.compress(value)
        chunks = [frame[i:i + chunk_size] for i in range(0, len(frame), chunk_size)]
        parts.append(struct.pack("<Q", len(value)) + b"".join(struct.pack("<Q", len(c)) + c for c in chunks))
    return b"CAIFZ\0\0\0test" + struct.pack("<Q", len(XML) + 37) + XML + b"\0" * 37 + b"".join(parts)


class ContainerTests(unittest.TestCase):
    def setUp(self):
        root = Path(__file__).resolve().parent
        self.base = root / ("test_bin_" + uuid.uuid4().hex)
        self.base.mkdir()
        assert self.base.resolve().parent == root
        self.addCleanup(shutil.rmtree, self.base)

    def run_extract(self, data, **kwargs):
        source = self.base / "input.ORSSession"
        source.write_bytes(data)
        output = self.base / "out"
        with contextlib.redirect_stdout(io.StringIO()):
            result = binary.extract(source, output, **kwargs)
        self.assertEqual(source.read_bytes(), data)
        return result, output

    def test_legacy_complete_exact_bytes_including_empty_record(self):
        values = [b"abc\0def", bytes(range(256)), b""]
        result, output = self.run_extract(legacy(values))
        self.assertTrue(result["all_binary_records_decoded"])
        self.assertFalse(result["all_object_semantics_decoded"])
        for i, value in enumerate(values):
            self.assertEqual((output / ("record_%06d.bin" % i)).read_bytes(), value)
            self.assertEqual(result["records"][i]["sha256"], hashlib.sha256(value).hexdigest())

    def test_modern_multi_chunk_and_empty_frames(self):
        values = [bytes(range(256)) * 10000, b"", b"last record"]
        result, output = self.run_extract(modern(values))
        self.assertTrue(result["all_binary_records_decoded"])
        self.assertGreater(result["records"][0]["compression_chunks"], 1)
        for i, value in enumerate(values):
            self.assertEqual((output / ("record_%06d.bin" % i)).read_bytes(), value)

    def test_orsz_record_with_independent_frames_and_empty_record(self):
        value = b'first part' + b'second part'
        frames = [zstd.compress(b'first part'), zstd.compress(b'second part')]
        body = struct.pack('<Q', len(value)) + b''.join(struct.pack('<Q', len(f)) + f for f in frames)
        body += struct.pack('<Q', 0)
        data = b'ORSZ' + struct.pack('<Q', 12 + len(body)) + body + XML
        result, output = self.run_extract(data)
        self.assertTrue(result['all_binary_records_decoded'])
        self.assertEqual(result['decoded_record_count'], 2)
        self.assertEqual((output / 'record_000000.bin').read_bytes(), value)
        self.assertEqual((output / 'record_000001.bin').read_bytes(), b'')

    def test_limit_does_not_claim_all_records(self):
        result, output = self.run_extract(modern([b"one", b"two"]), record_limit=1)
        self.assertEqual(result["decoded_record_count"], 1)
        self.assertFalse(result["all_binary_records_decoded"])
        self.assertEqual(result["status"], "stopped_at_requested_limit")

    def test_metadata_only_does_not_need_full_binary_body(self):
        data = modern([b"not downloaded"])
        result, output = self.run_extract(data[:-10], metadata_only=True)
        self.assertEqual(result["object_count"], 1)
        self.assertEqual(result["decoded_record_count"], 0)
        self.assertFalse(result["all_binary_records_decoded"])

    def test_truncated_zstd_keeps_completed_records_and_removes_partial(self):
        result, output = self.run_extract(modern([b"first", b"truncated frame"])[:-3])
        self.assertEqual(result["status"], "partial_or_failed")
        self.assertEqual(result["decoded_record_count"], 1)
        self.assertFalse((output / "record_000001.bin").exists())
        self.assertFalse((output / "record_000001.bin.partial").exists())

    def test_size_mismatch_detected(self):
        data = bytearray(modern([b"hello"]))
        body_start = 20 + len(XML) + 37
        struct.pack_into("<Q", data, body_start, 1)
        result, output = self.run_extract(bytes(data))
        self.assertTrue(result["errors"])
        self.assertFalse((output / "record_000000.bin").exists())

    def test_boundary_truncation_detected_by_xml_record_count(self):
        xml = XML.replace(b'<CxvChannel ', b'<CxvChannel _dataRecordCount="2" ')
        frame = zstd.compress(b"first")
        data = (b"CAIFZ\0\0\0test" + struct.pack("<Q", len(xml)) + xml
                + struct.pack("<QQ", 5, len(frame)) + frame)
        result, output = self.run_extract(data)
        self.assertEqual(result["decoded_record_count"], 1)
        self.assertEqual(result["status"], "partial_or_failed")
        self.assertFalse(result["all_binary_records_decoded"])

    def test_wrong_magic_refused(self):
        with self.assertRaises(binary.FormatError):
            self.run_extract(b"FAKE" + b"\0" * 100)

    def test_invalid_xml_offset_refused(self):
        with self.assertRaises(binary.FormatError):
            self.run_extract(b"ORSD" + struct.pack("<Q", 100000) + XML)

    def test_existing_destination_preserved(self):
        output = self.base / "out"
        output.mkdir()
        (output / "keep").write_bytes(b"keep")
        with self.assertRaises(FileExistsError):
            self.run_extract(legacy([b"data"]))
        self.assertEqual((output / "keep").read_bytes(), b"keep")


if __name__ == "__main__":
    unittest.main()
