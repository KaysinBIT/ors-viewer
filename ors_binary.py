#!/usr/bin/env python3
"""Standalone ORSD/ORSZ/CAIFZ record extraction. No Dragonfly or ORSModel.

Extracts XML and binary records; ors_decode.py provides typed object decoding.
Only observed variants are supported.
CAIFZ decompression uses Python 3.14's standard-library compression.zstd.
"""
import argparse
from collections import Counter
import hashlib
import json
from pathlib import Path
import struct
import sys
import xml.etree.ElementTree as ET

CHUNK = 1024 * 1024
MAX_XML = 64 * CHUNK
MAX_COMPRESSED_CHUNK = 128 * CHUNK
MAX_RECORD = 64 * 1024 * CHUNK
CLOSE_XML = b"</XVision_Objects>"
SENTINEL = (1 << 64) - 1


class FormatError(ValueError):
    pass


def read_exact(stream, count, end):
    if count < 0 or stream.tell() + count > end:
        raise FormatError("Truncated or invalid length at offset %d" % stream.tell())
    data = stream.read(count)
    if len(data) != count:
        raise FormatError("Short read at offset %d" % (stream.tell() - len(data)))
    return data


def u64(stream, end):
    return struct.unpack("<Q", read_exact(stream, 8, end))[0]


def write_json(path, value):
    partial = path.with_name(path.name + ".partial")
    partial.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    partial.replace(path)


def parse_container(stream):
    """Recognize verified headers; do not guess offsets by scanning raw pixels."""
    stream.seek(0, 2)
    size = stream.tell()
    stream.seek(0)
    magic = read_exact(stream, 4, size)
    if magic in (b"ORSD", b"ORSZ"):
        xml_start = u64(stream, size)
        if not 12 <= xml_start < size:
            raise FormatError("Invalid ORSD XML offset")
        xml_capacity = size - xml_start
        body_start, body_end, header_size = 12, xml_start, 12
        variant = magic.decode("ascii")
        build = None
    elif magic == b"CAIF":
        flags = read_exact(stream, 4, size)
        if flags != b"Z\0\0\0":
            raise FormatError("Unverified CAIF compression/header variant: " + flags.hex())
        build_bytes = read_exact(stream, 4, size)
        build = build_bytes.decode("ascii", errors="replace")
        xml_capacity = u64(stream, size)
        xml_start, header_size = 20, 20
        body_start, body_end = xml_start + xml_capacity, size
        variant = "CAIFZ"
    else:
        raise FormatError("Unsupported magic: " + magic.hex())
    if not 0 < xml_capacity <= MAX_XML or xml_start + xml_capacity > size:
        raise FormatError("Invalid, truncated, or oversized XML region")
    stream.seek(xml_start)
    region = read_exact(stream, xml_capacity, size)
    if not region.startswith(b"<?xml"):
        raise FormatError("Expected XML declaration at the header-defined location")
    finish = region.find(CLOSE_XML)
    if finish < 0:
        raise FormatError("XML closing element not found")
    finish += len(CLOSE_XML)
    # Preserve XML bytes and padding separately, without interpreting code in text.
    if region[finish:].strip(b"\0\t\r\n "):
        raise FormatError("Unexpected data after XML closing element")
    xml = region[:finish]
    if b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise FormatError("DTD/entity declarations are unsupported")
    try:
        root = ET.fromstring(xml)
    except ET.ParseError as exc:
        raise FormatError("Invalid XML: " + str(exc)) from exc
    if root.tag != "XVision_Objects":
        raise FormatError("Unexpected XML root")
    stream.seek(0)
    header = read_exact(stream, header_size, size)
    info = {
        "variant": variant, "source_bytes": size, "header_bytes": header_size,
        "build_header": build, "xml_offset": xml_start,
        "xml_bytes": len(xml), "xml_capacity": xml_capacity,
        "binary_start": body_start, "binary_end": body_end,
        "root_attributes": dict(root.attrib), "object_count": len(root),
        "object_types": dict(Counter(obj.tag for obj in root)),
    }
    counts = [node.get("_dataRecordCount") for node in root.iter()
              if node.get("_dataRecordCount") is not None]
    try:
        if any(int(count) < 0 for count in counts):
            raise ValueError("negative count")
        info["xml_declared_data_record_count"] = sum(int(count) for count in counts) if counts else None
    except ValueError as exc:
        raise FormatError("Invalid XML data-record count") from exc
    return info, root, header, xml, region[finish:]


def walk_nodes(root):
    for i, owner in enumerate(root):
        for node in owner.iter():
            yield i, owner, node


def legacy_record_references(root):
    refs = {}
    for i, owner, node in walk_nodes(root):
        candidates = [(key, value) for key, value in node.attrib.items()
                      if key.startswith("RecordOffset") or key == "DataOffset"]
        if (node.tag.startswith("RecordOffset") or node.tag == "DataOffset") and node.text:
            candidates.append((node.tag, node.text.strip()))
        for key, text in candidates:
            try:
                offset = int(text)
            except ValueError:
                continue
            if offset == SENTINEL:
                continue
            refs.setdefault(offset, []).append({
                "object_index": i, "object_guid": owner.get("GUID"),
                "element": node.tag, "field": key,
                "mapping_basis": "explicit_XML_offset",
            })
    return refs


def record_to_file(stream, destination, end, variant, max_record=MAX_RECORD):
    """Stream one raw record. CAIFZ stores a frame as length-prefixed chunks."""
    start = stream.tell()
    raw_size = u64(stream, end)
    if raw_size > max_record:
        raise FormatError("Record exceeds configured uncompressed size limit")
    temporary = destination.with_name(destination.name + ".partial")
    digest = hashlib.sha256()
    written, chunks = 0, 0
    try:
        with temporary.open("xb") as target:
            if variant == "ORSD":
                remaining = raw_size
                while remaining:
                    data = read_exact(stream, min(remaining, CHUNK), end)
                    target.write(data)
                    digest.update(data)
                    written += len(data)
                    remaining -= len(data)
            else:
                try:
                    from compression import zstd
                except ImportError as exc:
                    raise RuntimeError("CAIFZ extraction needs Python 3.14+ (compression.zstd)") from exc
                decoder = zstd.ZstdDecompressor()
                # ORSZ can serialize a record as several independent frames.
                # CAIFZ may split a single frame across length-prefixed chunks.
                while not (variant == "ORSZ" and raw_size == 0):
                    size = u64(stream, end)
                    if not 0 < size <= MAX_COMPRESSED_CHUNK:
                        raise FormatError("Invalid compressed chunk length at %d" % (stream.tell() - 8))
                    data = read_exact(stream, size, end)
                    chunks += 1
                    while True:
                        output = decoder.decompress(data, max_length=min(CHUNK, raw_size - written + 1))
                        data = b""
                        written += len(output)
                        if written > raw_size:
                            raise FormatError("Decompressed size exceeds the record header")
                        target.write(output)
                        digest.update(output)
                        if decoder.eof or decoder.needs_input:
                            break
                        if not output:
                            raise FormatError("Zstandard decoder made no progress")
                    if decoder.eof:
                        if decoder.unused_data:
                            raise FormatError("Unexpected bytes after Zstandard frame")
                        if written == raw_size:
                            break
                        decoder = zstd.ZstdDecompressor()
        if written != raw_size:
            raise FormatError("Decoded length mismatch: expected %d, got %d" % (raw_size, written))
        temporary.replace(destination)
    except BaseException:
        if temporary.exists():
            temporary.unlink()
        raise
    return {"file": destination.name, "record_offset": start,
            "stored_record_bytes": stream.tell() - start,
            "decoded_bytes": written, "compression_chunks": chunks,
            "sha256": digest.hexdigest()}


def extract(filename, output_dir, metadata_only=False, record_limit=None):
    """Extract metadata and generic records. Does not assert object semantics."""
    source = Path(filename).resolve(strict=True)
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError("Output must be a NEW directory: " + str(output))
    if record_limit is not None and record_limit < 0:
        raise ValueError("record_limit must be nonnegative")
    with source.open("rb") as stream:
        info, root, header, xml, padding = parse_container(stream)
        output.mkdir(parents=True, exist_ok=False)
        (output / "container_header.bin").write_bytes(header)
        (output / "metadata.xml").write_bytes(xml)
        (output / "metadata_padding.bin").write_bytes(padding)
        # Exact XML retains all attributes, repeated elements and decimal strings.
        objects = [{"index": i, "type": obj.tag, "guid": obj.get("GUID"),
                    "title": obj.findtext("title"), "attributes": dict(obj.attrib)}
                   for i, obj in enumerate(root)]
        write_json(output / "objects.json", objects)
        manifest = dict(info, source=str(source), status="running", records=[], errors=[],
                        xml_sha256=hashlib.sha256(xml).hexdigest(),
                        container_header_sha256=hashlib.sha256(header).hexdigest(),
                        metadata_padding_sha256=hashlib.sha256(padding).hexdigest(),
                        all_binary_records_decoded=False, all_object_semantics_decoded=False,
                        limitations=[
                            "Experimental observed ORSD/CAIFZ layouts only; not a public format specification.",
                            "Binary records are byte arrays, not yet typed volume/ROI/mesh/table exports.",
                            "Modern record-to-object mapping is not asserted.",
                            "Completing raw record extraction does not prove full semantic recovery.",
                        ])
        manifest_path = output / "manifest.json"
        write_json(manifest_path, manifest)
        refs = legacy_record_references(root)
        stream.seek(info["binary_start"])
        try:
            if metadata_only:
                manifest["status"] = "metadata_only"
            else:
                index = 0
                while stream.tell() < info["binary_end"]:
                    if record_limit is not None and index >= record_limit:
                        manifest["status"] = "stopped_at_requested_limit"
                        break
                    record = record_to_file(stream, output / ("record_%06d.bin" % index),
                                            info["binary_end"], info["variant"])
                    record["xml_references"] = refs.get(record["record_offset"], [])
                    manifest["records"].append(record)
                    index += 1
                    if index % 32 == 0:
                        print("Decoded %d records; source offset %d" % (index, stream.tell()), flush=True)
                        write_json(manifest_path, manifest)
                else:
                    expected = info["xml_declared_data_record_count"]
                    if info["variant"] == "CAIFZ" and expected is not None and index != expected:
                        raise FormatError("Record count mismatch with XML: decoded %d, declared %d" % (index, expected))
                    manifest["all_binary_records_decoded"] = True
                    manifest["status"] = "raw_records_complete_semantics_incomplete"
        except Exception as exc:
            manifest["status"] = "partial_or_failed"
            manifest["errors"].append({"offset": stream.tell(), "error": str(exc)})
        manifest["next_source_offset"] = stream.tell()
        manifest["decoded_record_count"] = len(manifest["records"])
        manifest["decoded_record_bytes"] = sum(r["decoded_bytes"] for r in manifest["records"])
        write_json(manifest_path, manifest)
    return manifest


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("file")
    ap.add_argument("--output", required=True)
    ap.add_argument("--metadata-only", action="store_true")
    ap.add_argument("--record-limit", type=int)
    args = ap.parse_args(argv)
    try:
        result = extract(args.file, args.output, args.metadata_only, args.record_limit)
        print(json.dumps({k: result[k] for k in (
            "status", "variant", "object_count", "decoded_record_count",
            "all_binary_records_decoded", "all_object_semantics_decoded", "errors")},
            ensure_ascii=False, indent=2))
        return 2 if result["errors"] else 0
    except Exception as exc:
        print("ERROR: " + str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
