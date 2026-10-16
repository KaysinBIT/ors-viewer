"""Build a self-contained Windows x64 distribution and SHA-256 checksum."""
import hashlib
from importlib.metadata import distribution
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parents[1]
VERSION = '0.9.1RC'


def main():
    if sys.platform != 'win32': raise SystemExit('Build the Windows distribution on Windows.')
    subprocess.run([sys.executable, '-m', 'unittest', 'discover', '-s', 'tests', '-q'], cwd=ROOT, check=True)
    (ROOT / 'build').mkdir(exist_ok=True)
    (ROOT / 'dist').mkdir(exist_ok=True)
    staging = Path(tempfile.mkdtemp(prefix=f'windows-{VERSION}-', dir=ROOT / 'build'))
    subprocess.run([sys.executable, '-m', 'PyInstaller', '--noconfirm', '--distpath', str(staging), 'ORSViewer.spec'], cwd=ROOT, check=True)
    folder = staging / 'ORSViewer'
    for name in ['README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'INDEPENDENT_IMPLEMENTATION.txt']:
        shutil.copy2(ROOT / name, folder / name)
    shutil.copy2(ROOT / 'viewer/web/manual.pdf', folder / 'ORSViewer-User-Manual-zh-CN.pdf')
    licenses = folder / 'licenses';licenses.mkdir(exist_ok=True)
    for package in ['numpy', 'pyinstaller']:
        info = distribution(package)
        for entry in info.files or []:
            lower = str(entry).lower()
            if ('license' in lower or 'copying' in lower) and '.dist-info/' in lower:
                source = Path(info.locate_file(entry))
                if source.is_file():
                    target = licenses / package / Path(entry).name;target.parent.mkdir(parents=True, exist_ok=True)
                    shutil.copy2(source, target)
    python_license = Path(sys.base_prefix) / 'LICENSE.txt'
    if python_license.exists(): shutil.copy2(python_license, licenses / 'Python-LICENSE.txt')
    for i, source in enumerate((Path(sys.base_prefix) / 'tcl').rglob('license*')):
        if source.is_file(): shutil.copy2(source, licenses / ('tcl-tk-%d-%s' % (i, source.name)))
    name = f'ORSViewer-{VERSION}-Windows-x64.zip';archive = ROOT / 'dist' / name
    with zipfile.ZipFile(archive, 'w', zipfile.ZIP_DEFLATED, compresslevel=9) as output:
        for source in sorted(folder.rglob('*')):
            if source.is_file(): output.write(source, source.relative_to(folder.parent).as_posix())
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    (ROOT / 'dist' / 'SHA256SUMS.txt').write_text(digest + '  ' + name + '\n', encoding='ascii')
    print(name + ': ' + digest)


if __name__ == '__main__': main()
