# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path

root = Path(SPECPATH)
a = Analysis([str(root / 'ors_viewer.py')], pathex=[str(root)],
             binaries=[], datas=[(str(root / 'viewer/web'), 'viewer/web'),
                                  (str(root / 'viewer/fixtures'), 'viewer/fixtures')],
             hiddenimports=['compression.zstd', 'tkinter', 'tkinter.ttk', 'tkinter.messagebox'],
             hookspath=[], runtime_hooks=[], excludes=['numpy.tests', 'unittest'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ORSViewer', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=False,
          disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='ORSViewer')
