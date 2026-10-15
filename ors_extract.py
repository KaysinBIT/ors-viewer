#!/usr/bin/env python3
"""One-command standalone ORSSession extraction, no Dragonfly runtime."""
import argparse
import math
from pathlib import Path
import sys
from ors_binary import extract, write_json
from ors_decode import decode, digest_file


def run(source, output, dense=False, dense_limit_gib=2, ply=True):
    source = Path(source).resolve(strict=True)
    output = Path(output).resolve()
    if not math.isfinite(dense_limit_gib) or dense_limit_gib <= 0:
        raise ValueError('dense_limit_gib must be finite and positive')
    output.mkdir(parents=True, exist_ok=False)
    job = {'source': str(source), 'source_sha256': digest_file(source),
           'status': 'running', 'full_session_semantics_reconstructed': False}
    write_json(output / 'job.json', job)
    try:
        raw = extract(source, output / 'raw')
        job['raw_complete'] = raw['all_binary_records_decoded']
        if not job['raw_complete']:
            job['status'] = 'raw_extraction_incomplete'
            job['errors'] = raw['errors']
        else:
            typed = decode(output / 'raw', output / 'data', dense,
                           int(dense_limit_gib * 1024**3), ply)
            job['supported_objects_completed'] = typed['supported_objects_completed']
            job['supported_object_count'] = typed['supported_object_count']
            job['remaining_record_bytes'] = typed['remaining_record_bytes']
            job['status'] = 'completed_with_documented_scope' if typed['supported_objects_completed'] else 'partial'
    except BaseException as exc:
        job.update(status='failed', error=str(exc))
        raise
    finally:
        try:
            job['source_sha256_after'] = digest_file(source)
            job['source_unchanged'] = job['source_sha256_after'] == job['source_sha256']
            if not job['source_unchanged']:
                job['status'] = 'source_changed_during_run'
        except OSError as exc:
            job['source_unchanged'] = False
            job['source_check_error'] = str(exc)
        write_json(output / 'job.json', job)
    return job


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('source')
    p.add_argument('--output', required=True)
    p.add_argument('--dense-labels', action='store_true')
    p.add_argument('--dense-limit-gib', type=float, default=2)
    p.add_argument('--no-ply', action='store_true')
    a = p.parse_args(argv)
    try:
        result = run(a.source, a.output, a.dense_labels, a.dense_limit_gib, not a.no_ply)
        print(result['status'])
        return 0 if result['status'] == 'completed_with_documented_scope' else 2
    except Exception as exc:
        print('ERROR: ' + str(exc), file=sys.stderr)
        return 1


if __name__ == '__main__':
    sys.exit(main())
