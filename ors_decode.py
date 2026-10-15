#!/usr/bin/env python3
"""Independent typed decoding of extracted ORS records (NumPy, no Dragonfly).

Input is an ors_binary.py extraction directory. Unknown records stay preserved.
Supported layouts are evidence-bounded; see FORMAT_NOTES.md and validation report.
"""
import argparse
import csv
import hashlib
import json
import math
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

import numpy as np
from ors_binary import FormatError, SENTINEL, write_json

CHANNEL_TYPES = {0: 'u1', 2: '<u2', 4: '<u4', 6: '<f4', 7: '<f8'}
SCALAR_TYPES = {0: '<f4', 1: '<i2', 2: '<u2', 3: '<i4', 4: '<u4', 5: '<f8', 8: 'u1'}
ARRAY_TYPES = {'Float': '<f4', 'Double': '<f8', 'UnsignedLong': '<u4',
               'Long': '<i4', 'Short': '<i2', 'UnsignedShort': '<u2',
               'UnsignedChar': 'u1', 'Char': 'i1'}
SUPPORTED = {'CxvChannel', 'CxvVolume_ROI', 'CxvLabeledMultiROI', 'CxvFaceVertexMesh'}
SUPPORTED.update('CxvArray' + suffix for suffix in ARRAY_TYPES)


def digest_file(path):
    h = hashlib.sha256()
    with Path(path).open('rb') as f:
        for b in iter(lambda: f.read(4 * 1024 * 1024), b''):
            h.update(b)
    return h.hexdigest()


def json_tree(node):
    return {'tag': node.tag, 'attributes': dict(node.attrib), 'text': node.text,
            'children': [json_tree(child) for child in node]}


def read_strings(data, count=None):
    if len(data) % 2:
        raise FormatError('UTF-16BE record has an odd byte count')
    text = data.decode('utf-16-be', errors='strict')
    if text and not text.endswith('\0'):
        raise FormatError('String record lacks final separator')
    values = text.split('\0')[:-1] if text else []
    if count is not None and len(values) != count:
        raise FormatError('String count does not match XML')
    return values


def grid_info(obj):
    box = obj.find('orientationBox')
    if box is None:
        raise FormatError('Missing orientationBox')
    dims, spacing = [], []
    for i in range(3):
        step = float(box.get('direction%dSpacing' % i))
        extent = float(box.get('direction%dSize' % i))
        if not math.isfinite(step) or step <= 0 or not math.isfinite(extent):
            raise FormatError('Invalid grid geometry')
        ratio = extent / step
        size = round(ratio)
        if size < 1 or not math.isclose(ratio, size, rel_tol=1e-8, abs_tol=1e-6):
            raise FormatError('Grid extent/spacing is not an integer dimension')
        dims.append(size)
        spacing.append(step)
    nt = int(obj.findtext('TSize', '1'))
    if nt < 1:
        raise FormatError('Invalid TSize')
    matrix_node = obj.find('VoxelIndexToRCSMatrix')
    matrix = ([[float(matrix_node.get('r%dc%d' % (r, c))) for c in range(4)]
               for r in range(4)] if matrix_node is not None else None)
    return {'shape_tzyx': [nt, dims[2], dims[1], dims[0]], 'size_xyz': dims,
            'spacing_xyz': spacing, 'voxel_xyz_to_world': matrix,
            'axis_order': 'TZYX; X is fastest in flat voxel indices',
            'coordinate_note': 'Preserved native coordinates; no resampling or unit conversion'}


class Records:
    def __init__(self, directory, verify=True):
        self.directory = Path(directory).resolve(strict=True)
        self.manifest = json.loads((self.directory / 'manifest.json').read_text('utf-8'))
        xml = (self.directory / 'metadata.xml').read_bytes()
        if (verify and self.manifest.get('xml_sha256') is not None
                and hashlib.sha256(xml).hexdigest() != self.manifest['xml_sha256']):
            raise FormatError('Metadata XML SHA-256 mismatch')
        if b'<!DOCTYPE' in xml.upper() or b'<!ENTITY' in xml.upper():
            raise FormatError('DTD/entity declarations unsupported')
        self.root = ET.fromstring(xml)
        self.records = self.manifest['records']
        self.offsets = {r['record_offset']: r for r in self.records}
        if len(self.offsets) != len(self.records):
            raise FormatError('Duplicate record offsets')
        self.verify = verify
        self.checked = set()
        self.used = set()
        self.modern = {}
        if self.manifest['variant'] == 'CAIFZ':
            ordered = []
            def visit(node):
                for child in node:
                    visit(child)
                n = int(node.get('_dataRecordCount', '0'))
                if n > 1:
                    # Multiple-record node grouping needs a specific decoder.
                    ordered.extend([(node, j) for j in range(n)])
                elif n == 1:
                    ordered.append((node, 0))
            for obj in self.root:
                visit(obj)
            for i, pair in enumerate(ordered[:len(self.records)]):
                self.modern[(id(pair[0]), pair[1])] = self.records[i]

    def record(self, node, field='RecordOffset'):
        if node is None:
            raise FormatError('Missing record-bearing XML node')
        offset = node.get(field, node.findtext(field))
        if offset is not None and int(offset) != SENTINEL:
            record = self.offsets.get(int(offset))
        else:
            if int(node.get('_dataRecordCount', '0')) > 1:
                raise FormatError('Multi-record node layout is not implemented')
            record = self.modern.get((id(node), 0))
        if record is None:
            raise FormatError('Referenced record is absent: ' + node.tag + '/' + field)
        path = (self.directory / record['file']).resolve()
        if self.directory not in path.parents:
            raise FormatError('Record path escapes extraction directory')
        if path.stat().st_size != record['decoded_bytes']:
            raise FormatError('Record size mismatch: ' + record['file'])
        if self.verify and record['file'] not in self.checked:
            if digest_file(path) != record['sha256']:
                raise FormatError('Record SHA-256 mismatch: ' + record['file'])
            self.checked.add(record['file'])
        return path, record

    def array(self, node, dtype, field='RecordOffset', count=None):
        dt = np.dtype(dtype)
        declared = node.findtext('size') if node is not None else None
        if count is None and declared is not None:
            count = int(declared)
        # Empty arrays in ORS XML commonly omit their record entirely.
        if count == 0 and node.get(field, node.findtext(field)) is None and not node.get('_dataRecordCount'):
            return np.empty(0, dtype=dt)
        path, record = self.record(node, field)
        if path.stat().st_size % dt.itemsize:
            raise FormatError('Record byte count is not divisible by dtype size')
        n = path.stat().st_size // dt.itemsize
        if count is not None and n != count:
            raise FormatError('Array count does not match XML: ' + node.tag)
        result = np.memmap(path, dtype=dt, mode='r', shape=(n,)) if n else np.empty(0, dtype=dt)
        self.used.add(record['file'])
        return result

    def strings(self, node, count=None):
        if count == 0 and node.get('RecordOffset', node.findtext('RecordOffset')) is None:
            return []
        path, record = self.record(node)
        if path.stat().st_size > 64 * 1024 * 1024:
            raise FormatError('String record exceeds 64 MiB decoding limit')
        values = read_strings(path.read_bytes(), count)
        self.used.add(record['file'])
        return values


def save_array(path, array):
    """NPY preserves numeric dtype/byte order; verify its raw payload afterward."""
    arr = np.asarray(array)
    if arr.dtype.hasobject:
        raise FormatError('Object/pickle arrays are forbidden')
    temp = path.with_name(path.name + '.partial')
    with temp.open('xb') as f:
        np.save(f, arr, allow_pickle=False)
    temp.replace(path)
    saved = np.load(path, mmap_mode='r', allow_pickle=False)
    if saved.shape != arr.shape or saved.dtype != arr.dtype:
        raise FormatError('NPY header round-trip failed')
    source_h, saved_h = hashlib.sha256(), hashlib.sha256()
    flat, recovered = arr.reshape(-1), saved.reshape(-1)
    for start in range(0, flat.size, 1024 * 1024):
        source_h.update(flat[start:start + 1024 * 1024].tobytes())
        saved_h.update(recovered[start:start + 1024 * 1024].tobytes())
    if source_h.digest() != saved_h.digest():
        raise FormatError('NPY payload round-trip failed')
    return {'file': path.name, 'shape': list(arr.shape), 'dtype': arr.dtype.str,
            'sha256': digest_file(path), 'payload_sha256': source_h.hexdigest(),
            'payload_roundtrip_verified': True}


def check_runs(starts, ends, total_voxels):
    if starts.shape != ends.shape:
        raise FormatError('Mismatched interval arrays')
    if len(starts) and (np.any(starts > ends) or int(ends.max()) >= total_voxels):
        raise FormatError('Invalid or out-of-bounds voxel intervals')
    if len(starts) > 1 and np.any(starts[1:] <= ends[:-1]):
        raise FormatError('Voxel intervals overlap or are not sorted')


def active_intervals(nxt, previous, starts, ends, labels, head, tail, count, nvox):
    n = len(nxt)
    if (len(previous) != n or len(starts) != len(ends) or len(starts) != len(labels)
            or len(starts) < n or count < 0 or count > n):
        raise FormatError('Tree array/interval count mismatch')
    visited = np.zeros(n, dtype=bool)
    ids = np.empty(count, dtype=np.int64)
    cur, prev = head, 0
    for i in range(count):
        if cur <= 0 or cur >= n or visited[cur]:
            raise FormatError('Broken/cyclic active-interval linked list')
        if int(previous[cur]) != prev:
            raise FormatError('Previous/next interval links disagree')
        visited[cur] = True
        ids[i] = cur
        prev, cur = cur, int(nxt[cur])
    if cur != 0 or (count and prev != tail) or (not count and (head or tail)):
        raise FormatError('Tree tail or terminal sentinel mismatch')
    lo, hi, labs = starts[ids], ends[ids], labels[ids]
    check_runs(lo, hi, nvox)
    if np.any(labs == 0):
        raise FormatError('Active background-labelled interval requires further investigation')
    return lo, hi, labs


def dense_labels(path, shape, starts, ends, labels, limit_bytes):
    dt = np.dtype('<u4') if len(labels) and int(labels.max()) > 255 else np.dtype('u1')
    size = math.prod(shape) * dt.itemsize
    if size > limit_bytes:
        return {'status': 'skipped_size_limit', 'required_bytes': size,
                'limit_bytes': limit_bytes, 'sparse_intervals_are_complete': True}
    temp = path.with_name(path.name + '.partial')
    arr = np.lib.format.open_memmap(temp, mode='w+', dtype=dt, shape=tuple(shape))
    flat = arr.reshape(-1)
    flat[:] = 0
    for begin, end, label in zip(starts, ends, labels):
        flat[int(begin):int(end) + 1] = label
    arr.flush()
    # Count every voxel, without allocating another complete dense volume.
    counts = {}
    for begin in range(0, flat.size, 4 * 1024 * 1024):
        values, n = np.unique(flat[begin:begin + 4 * 1024 * 1024], return_counts=True)
        for v, c in zip(values, n):
            counts[int(v)] = counts.get(int(v), 0) + int(c)
    del flat, arr
    temp.replace(path)
    return {'status': 'exported', 'file': path.name, 'shape': shape, 'dtype': dt.str,
            'sha256': digest_file(path), 'full_volume_label_counts': counts}


def label_counts(starts, ends, labels):
    counts = {}
    for lo, hi, lab in zip(starts, ends, labels):
        key = int(lab)
        counts[key] = counts.get(key, 0) + int(hi) - int(lo) + 1
    return counts


def export_scalars(store, node, folder, prefix, group, row_kind, csv_limit=100000):
    count = int(node.get(prefix + 'SlotCount', '0'))
    if not count:
        return None, []
    type_node = node.find('DataTypes' + prefix)
    types = store.array(type_node, '<i2', count=count)
    slopes = store.array(node.find('Slope' + prefix), '<f8', count=count)
    offsets = store.array(node.find('Offset' + prefix), '<f8', count=count)
    descriptions = [entry.get('Value', '') for entry in node.findall('Description' + prefix + '/Entry')]
    if len(descriptions) != count:
        raise FormatError('Scalar descriptions/slot count mismatch')
    columns, arrays = [], []
    for i, code in enumerate(types):
        src = node.find(prefix + '_' + str(i))
        n = int(src.findtext('size'))
        if int(code) == 9:
            values = store.strings(src, n)
            outfile = folder / ('%s_%03d.json' % (group, i))
            write_json(outfile, values)
            receipt = {'file': outfile.name, 'sha256': digest_file(outfile), 'dtype': 'utf16be_strings'}
        elif int(code) in SCALAR_TYPES:
            values = store.array(src, SCALAR_TYPES[int(code)], count=n)
            receipt = save_array(folder / ('%s_%03d.npy' % (group, i)), values)
        else:
            raise FormatError('Unsupported scalar dtype code %s' % code)
        unit = node.find(prefix + 'DimensionUnit_' + str(i))
        columns.append(dict(receipt, index=i, name=descriptions[i], dtype_code=int(code),
                            slope=float(slopes[i]), offset=float(offsets[i]),
                            dimension_unit=json_tree(unit) if unit is not None else None,
                            csv_key='slot_%03d' % i))
        arrays.append(values)
    lengths = {len(a) for a in arrays}
    if len(lengths) != 1:
        raise FormatError('Scalar columns have different row counts')
    nrows = lengths.pop()
    table = {'group': group, 'row_kind': row_kind, 'row_count': nrows,
             'columns': columns, 'value_rule': 'physical_value = raw * slope + offset',
             'start_index_xml': int(node.get('StartIndex' + prefix, '0')),
             'row_index_rule': 'Original array index retained, including row 0/background'}
    if nrows <= csv_limit:
        path = folder / (group + '.csv')
        with path.open('w', encoding='utf-8-sig', newline='') as stream:
            writer = csv.writer(stream)
            writer.writerow([row_kind] + [c['csv_key'] for c in columns])
            for row in range(nrows):
                values = []
                for column, array in zip(columns, arrays):
                    v = array[row]
                    if column['dtype_code'] != 9:
                        v = v.item() if isinstance(v, np.generic) else v
                        if column['slope'] != 1 or column['offset'] != 0:
                            v = v * column['slope'] + column['offset']
                    values.append(v)
                writer.writerow([row] + values)
        table['csv'] = {'file': path.name, 'sha256': digest_file(path)}
    else:
        table['csv'] = {'status': 'columnar_npy_only', 'reason': 'row count exceeds CSV convenience limit'}
    # Preserve the entire table schema and display ranges as exact XML, too.
    write_json(folder / (group + '_schema.json'), dict(table, original_xml=json_tree(node)))
    return table, arrays


def write_ply(path, vertices, faces, normals=None):
    """Binary PLY without scalar truncation; scientific columns are separate NPY."""
    if vertices.dtype != np.dtype('<f4'):
        scalar = 'double'
        dtype = '<f8'
    else:
        scalar, dtype = 'float', '<f4'
    head = ['ply', 'format binary_little_endian 1.0',
            'comment original coordinate values; see object metadata for units',
            'element vertex %d' % len(vertices)]
    head += ['property %s %s' % (scalar, axis) for axis in ('x', 'y', 'z')]
    head += ['element face %d' % len(faces), 'property list uchar uint vertex_indices', 'end_header']
    with path.open('xb') as f:
        f.write(('\n'.join(head) + '\n').encode('ascii'))
        for i in range(0, len(vertices), 262144):
            f.write(np.asarray(vertices[i:i + 262144], dtype=dtype).tobytes())
        dt = np.dtype([('count', 'u1'), ('indices', '<u4', (3,))])
        for i in range(0, len(faces), 262144):
            part = faces[i:i + 262144]
            block = np.empty(len(part), dtype=dt)
            block['count'] = 3
            block['indices'] = part
            f.write(block.tobytes())
    return {'file': path.name, 'sha256': digest_file(path), 'vertices': len(vertices),
            'faces': len(faces), 'note': 'Normals and measurement columns are in separate NPY files'}


def decode_object(store, obj, folder, dense=False, dense_limit=2 * 1024**3, ply=True):
    info = {'type': obj.tag, 'title': obj.findtext('title'), 'guid': obj.get('GUID'),
            'attributes': dict(obj.attrib), 'files': [], 'tables': [], 'checks': {}, 'status': 'decoded'}
    if obj.tag in ('CxvChannel', 'CxvVolume_ROI', 'CxvLabeledMultiROI'):
        grid = grid_info(obj)
        info['grid'] = grid
        shape = grid['shape_tzyx']
        nvox = math.prod(shape)
    if obj.tag == 'CxvChannel':
        code = int(obj.findtext('DataType'))
        if code not in CHANNEL_TYPES:
            raise FormatError('Unsupported Channel dtype code %s' % code)
        data = store.array(obj, CHANNEL_TYPES[code], field='DataOffset', count=nvox)
        info['files'].append(save_array(folder / 'volume.npy', data.reshape(shape)))
        info['checks']['voxel_bytes_and_dimensions_match'] = True
        info['scaling'] = {'slope': float(obj.findtext('ValueSlope', '1')),
                           'offset': float(obj.findtext('ValueOffset', '0')),
                           'stored_values_exported_without_scaling': True}
    elif obj.tag in ('CxvVolume_ROI', 'CxvLabeledMultiROI'):
        if shape[0] != 1:
            raise FormatError('ROI time-step storage beyond T=1 has not been verified')
        if obj.tag == 'CxvVolume_ROI':
            pairs = store.array(obj, '<u4')
            if len(pairs) % 2:
                raise FormatError('ROI interval record must contain begin/end pairs')
            pairs = pairs.reshape(-1, 2)
            starts, ends = pairs[:, 0], pairs[:, 1]
            check_runs(starts, ends, nvox)
            labels = np.ones(len(starts), dtype='<u4')
            info['source_Label_field'] = obj.findtext('Label')
            info['mask_rule'] = 'Binary membership mask uses 1; XML Label is retained separately'
        else:
            tree = obj.find('LabelData/TreeData')
            if tree is None:
                raise FormatError('Unsupported MultiROI layout')
            allocated = int(tree.get('ElementCount'))
            # Link buffers store indices through Next, while label/begin/end
            # buffers use ElementCount capacity. Empty trees still have index 0.
            link_count = int(tree.get('Next')) + 1
            if link_count > allocated:
                raise FormatError('Tree high-water index exceeds allocated capacity')
            nxt = store.array(tree, '<u4', field='RecordOffsetN', count=link_count)
            prev = store.array(tree, '<u4', field='RecordOffsetPR', count=link_count)
            low = store.array(obj.find('LabelData/BeginInt'), '<u4', count=allocated)
            high = store.array(obj.find('LabelData/EndInt'), '<u4', count=allocated)
            labs = store.array(obj.find('LabelData/Labels'), '<u4', count=allocated)
            starts, ends, labels = active_intervals(
                nxt, prev, low, high, labs, int(tree.get('Head')), int(tree.get('Tail')),
                int(tree.get('IntervalCount')), nvox)
            info['checks']['active_tree_links_and_interval_count_match'] = True
        runs = np.column_stack((starts, ends, labels)).astype('<u4', copy=False)
        info['files'].append(save_array(folder / 'label_intervals.npy', runs))
        counts = label_counts(starts, ends, labels)
        info['label_voxel_counts'] = counts
        info['interval_count'] = len(starts)
        info['foreground_voxels'] = sum(counts.values())
        info['interval_columns'] = ['begin_inclusive_flat_x_fastest', 'end_inclusive', 'label_id']
        info['checks']['sorted_nonoverlapping_in_bounds'] = True
        if obj.tag == 'CxvLabeledMultiROI':
            if info['foreground_voxels'] != int(obj.get('TotalLabelSize')):
                raise FormatError('Reconstructed label voxels differ from TotalLabelSize')
            info['checks']['TotalLabelSize_matches'] = True
            if len(counts) != int(obj.find('LabelData').get('LabelCount')):
                raise FormatError('Nonempty label count differs from LabelCount')
            info['checks']['LabelCount_matches'] = True
            for prefix, group in [('LabelScalarValues', 'label_measurements'),
                                  ('InternalScalarValues', 'label_internal_fields')]:
                table, arrays = export_scalars(store, obj, folder, prefix, group, 'label_index')
                if table is not None:
                    info['tables'].append(table)
                    if prefix == 'LabelScalarValues':
                        for column, values in zip(table['columns'], arrays):
                            if column['name'] in ('Voxel count', 'Voxel count (2)'):
                                expected = np.array([counts.get(i, 0) for i in range(len(values))], dtype=np.uint64)
                                scaled = np.asarray(values) * column['slope'] + column['offset']
                                # Historical derived columns may legitimately refer to an older segmentation.
                                info['checks'][column['name'] + '_matches_segmentation'] = bool(np.array_equal(scaled, expected))
        if dense:
            info['dense_labels'] = dense_labels(folder / 'labels.npy', shape, starts, ends, labels, dense_limit)
            if info['dense_labels']['status'] == 'exported':
                observed = {int(k): v for k, v in info['dense_labels']['full_volume_label_counts'].items() if int(k)}
                if observed != counts:
                    raise FormatError('Dense label histogram differs from sparse intervals')
                info['checks']['dense_histogram_matches_all_sparse_counts'] = True
    elif obj.tag == 'CxvFaceVertexMesh':
        if int(obj.get('TSize', '1')) != 1 or int(obj.get('EdgeCountPerFace', '3')) != 3:
            raise FormatError('Only verified single-time triangular mesh layout is supported')
        code = int(obj.get('VertexDataType'))
        if code not in (0, 5):
            raise FormatError('Unverified mesh vertex dtype')
        v = store.array(obj.find('Vertices'), SCALAR_TYPES[code])
        e = store.array(obj.find('Edges'), '<u4')
        if len(v) % 3 or len(e) % 3:
            raise FormatError('Mesh vertex/triangle buffers are not triples')
        vertices, faces = v.reshape(-1, 3), e.reshape(-1, 3)
        if not np.isfinite(vertices).all() or (len(faces) and int(faces.max()) >= len(vertices)):
            raise FormatError('Nonfinite coordinates or out-of-range triangle indices')
        info['vertex_count'], info['triangle_count'] = len(vertices), len(faces)
        info['coordinate_space'] = 'Stored model coordinates; parent transforms retained in original XML'
        info['files'].append(save_array(folder / 'vertices.npy', vertices))
        info['files'].append(save_array(folder / 'triangles.npy', faces))
        for tag, filename in [('Normals', 'normals.npy'), ('UVs', 'uvs.npy')]:
            node = obj.find(tag)
            if node is not None:
                data = store.array(node, '<f4')
                if tag == 'Normals' and len(data) not in (0, len(v)):
                    raise FormatError('Normal count differs from vertex count')
                info['files'].append(save_array(folder / filename, data.reshape(-1, 3) if tag == 'Normals' else data))
        info['checks']['all_triangle_indices_in_range'] = True
        info['checks']['all_vertices_finite'] = True
        for tag, group, row_kind in [('VertexScalars', 'vertex_measurements', 'vertex_index'),
                                     ('FaceScalars', 'face_measurements', 'face_index')]:
            node = obj.find(tag)
            if node is not None:
                table, arrays = export_scalars(store, node, folder, 'ScalarValues', group, row_kind)
                if table is not None:
                    expected = len(vertices) if tag == 'VertexScalars' else len(faces)
                    if table['row_count'] != expected:
                        raise FormatError('Mesh scalar count differs from geometry count')
                    info['tables'].append(table)
        if ply:
            info['ply'] = write_ply(folder / 'mesh.ply', vertices, faces)
    elif obj.tag.startswith('CxvArray') and obj.tag[len('CxvArray'):] in ARRAY_TYPES:
        data = store.array(obj, ARRAY_TYPES[obj.tag[len('CxvArray'):]])
        info['files'].append(save_array(folder / 'array.npy', data))
        info['checks']['xml_array_count_matches'] = True
    else:
        raise FormatError('Unsupported object type')
    return info


def decode(directory, output_dir, dense=False, dense_limit=2 * 1024**3, ply=True):
    output = Path(output_dir).resolve()
    if output.exists():
        raise FileExistsError('Choose a new output directory')
    store = Records(directory)
    output.mkdir(parents=True, exist_ok=False)
    report = {'source_extraction': str(store.directory), 'objects': [], 'errors': [],
              'raw_container_complete': store.manifest['all_binary_records_decoded'],
              'complete_session_semantics': False,
              'limitations': ['Rendering/plugin/undo application behavior is not recreated.',
                              'Only documented and sample-validated layouts are decoded.',
                              'Unconsumed raw records and complete XML remain in source extraction.']}
    for index, obj in enumerate(store.root):
        if obj.tag not in SUPPORTED:
            continue
        folder = output / ('object_%05d' % index)
        folder.mkdir()
        (folder / 'original_object.xml').write_bytes(ET.tostring(obj, encoding='utf-8', xml_declaration=True))
        try:
            result = decode_object(store, obj, folder, dense, dense_limit, ply)
        except Exception as exc:
            result = {'type': obj.tag, 'title': obj.findtext('title'), 'guid': obj.get('GUID'),
                      'status': 'failed_or_unsupported', 'error': str(exc)}
            report['errors'].append({'object_index': index, 'error': str(exc)})
        result.update(object_index=index, directory=folder.name)
        write_json(folder / 'metadata.json', result)
        report['objects'].append(result)
        print(index, obj.tag, result['status'], flush=True)
        write_json(output / 'decode_report.json', report)
    # Text UserInfo holds UTF-16BE key/value strings. Preserve duplicates and
    # script-like values as inert data; never evaluate macros or pickle payloads.
    user_info = []
    report['auxiliary_warnings'] = []
    for index, owner in enumerate(store.root):
        for node in owner.iter('UserInfo'):
            if (node.get('RecordOffset', node.findtext('RecordOffset')) is None
                    and int(node.get('_dataRecordCount', '0')) == 0):
                continue
            try:
                values = store.strings(node)
                if len(values) % 2:
                    raise FormatError('UserInfo key/value count is odd')
                user_info.append({'owner_index': index, 'owner_guid': owner.get('GUID'),
                                  'pairs': list(zip(values[::2], values[1::2]))})
            except Exception as exc:
                report['auxiliary_warnings'].append({'owner_index': index, 'field': 'UserInfo', 'error': str(exc)})
    write_json(output / 'user_info.json', user_info)
    report['user_info_records_decoded'] = len(user_info)
    report['supported_object_count'] = len(report['objects'])
    report['supported_objects_completed'] = all(o['status'] == 'decoded' for o in report['objects']) and bool(report['objects'])
    report['used_record_files'] = sorted(store.used)
    report['remaining_record_files'] = [r['file'] for r in store.records if r['file'] not in store.used]
    report['remaining_record_bytes'] = sum(r['decoded_bytes'] for r in store.records if r['file'] not in store.used)
    report['other_object_types'] = sorted({o.tag for o in store.root if o.tag not in SUPPORTED})
    write_json(output / 'decode_report.json', report)
    return report


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('directory', help='Directory created by ors_binary.py')
    p.add_argument('--output', required=True)
    p.add_argument('--dense-labels', action='store_true')
    p.add_argument('--dense-limit-gib', type=float, default=2.0)
    p.add_argument('--no-ply', action='store_true')
    args = p.parse_args(argv)
    if not math.isfinite(args.dense_limit_gib) or args.dense_limit_gib <= 0:
        p.error('--dense-limit-gib must be finite and positive')
    try:
        report = decode(args.directory, args.output, args.dense_labels,
                        int(args.dense_limit_gib * 1024**3), not args.no_ply)
        print(json.dumps({'supported_objects': report['supported_object_count'],
                          'completed': report['supported_objects_completed'],
                          'remaining_record_bytes': report['remaining_record_bytes'],
                          'errors': report['errors']}, ensure_ascii=False, indent=2))
        return 2 if report['errors'] else 0
    except Exception as exc:
        print('ERROR: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
