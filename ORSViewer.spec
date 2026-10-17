# -*- mode: python ; coding: utf-8 -*-
from pathlib import Path
from PyInstaller.utils.hooks.tcl_tk import tcltk_info

if not tcltk_info.available or tcltk_info.tcl_data_missing or tcltk_info.tk_data_missing:
    raise SystemExit('Desktop build requires working Tcl/Tk. Refusing to create a package without tkinter.')

root = Path(SPECPATH)
a = Analysis([str(root / 'ors_viewer.py')], pathex=[str(root)],
             binaries=[], datas=[(str(root / 'viewer/web'), 'viewer/web'),
                                  (str(root / 'viewer/fixtures'), 'viewer/fixtures')],
             hiddenimports=['compression.zstd', '_tkinter', 'tkinter', 'tkinter.ttk', 'tkinter.messagebox', 'tkinter.filedialog'],
             hookspath=[], runtime_hooks=[], excludes=['numpy.tests', 'unittest'], noarchive=False)
pyz = PYZ(a.pure)
exe = EXE(pyz, a.scripts, [], exclude_binaries=True, name='ORSViewer', debug=False,
          bootloader_ignore_signals=False, strip=False, upx=False, console=False,
          disable_windowed_traceback=False)
coll = COLLECT(exe, a.binaries, a.datas, strip=False, upx=False, name='ORSViewer')
