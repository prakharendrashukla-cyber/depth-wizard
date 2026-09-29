@echo off
title Depth Wizard - Clean Zip Creator
color 0A

echo ================================================================
echo             DEPTH WIZARD - CLEAN ZIP CREATOR
echo ================================================================
echo.
echo Packaging project files (excluding node_modules, pycache, git)...
echo.

py -c "
import os, zipfile

root_dir = r'%~dp0'
out_zip = os.path.abspath(os.path.join(root_dir, '..', 'depth-wizard-clean.zip'))

exclude_dirs = {'node_modules', '__pycache__', '.git', 'dist', '.vite'}
exclude_exts = {'.pyc', '.log'}

count = 0
with zipfile.ZipFile(out_zip, 'w', zipfile.ZIP_DEFLATED) as z:
    for root, dirs, files in os.walk(root_dir):
        dirs[:] = [d for d in dirs if d not in exclude_dirs]
        for f in files:
            ext = os.path.splitext(f)[1].lower()
            if ext in exclude_exts or f.endswith('.zip'):
                continue
            full_path = os.path.join(root, f)
            rel_path = os.path.relpath(full_path, root_dir)
            z.write(full_path, os.path.join('depth-wizard', rel_path))
            count += 1

size_mb = os.path.getsize(out_zip) / (1024 * 1024)
print(f'[SUCCESS] Created: {out_zip}')
print(f'[STATS]   Total files: {count} | File size: {size_mb:.2f} MB')
"

echo.
echo ================================================================
echo Done! Your clean zip file is ready at: D:\depth-wizard-clean.zip
echo ================================================================
echo.
pause
