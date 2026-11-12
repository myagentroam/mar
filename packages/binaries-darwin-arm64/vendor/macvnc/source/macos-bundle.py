#!/usr/bin/env python3
"""Bundle non-system Mach-O dependencies beside the native macVNC candidate."""
import os
from pathlib import Path
import shutil
import subprocess
import sys

source, output = map(Path, sys.argv[1:])
output.mkdir(parents=True, exist_ok=True)
libraries = output / 'lib'
libraries.mkdir()
executable = output / 'macVNC'
shutil.copy2(source, executable)
os.chmod(executable, 0o755)

pending = [executable]
copied = {}
while pending:
    binary = pending.pop()
    lines = subprocess.check_output(['otool', '-L', str(binary)], text=True).splitlines()[1:]
    if binary.parent == libraries:
        lines = lines[1:]  # A dylib's first entry is its own install name.
    for line in lines:
        dependency = line.strip().split(' (compatibility version ', 1)[0]
        if dependency.startswith(('/usr/lib/', '/System/Library/')):
            continue
        if dependency.startswith('@'):
            raise RuntimeError(f'Unsupported unresolved dependency in {binary}: {dependency}')
        original = Path(dependency).resolve(strict=True)
        name = Path(dependency).name
        if name in copied and copied[name] != original:
            raise RuntimeError(f'Conflicting native libraries named {name}')
        target = libraries / name
        if name not in copied:
            copied[name] = original
            shutil.copy2(original, target)
            os.chmod(target, 0o755)
            subprocess.run(['install_name_tool', '-id', '@loader_path/' + name, str(target)], check=True)
            pending.append(target)
        prefix = '@executable_path/lib/' if binary == executable else '@loader_path/'
        subprocess.run(['install_name_tool', '-change', dependency, prefix + name, str(binary)], check=True)

for binary in [*libraries.iterdir(), executable]:
    subprocess.run(['codesign', '--force', '--sign', '-', str(binary)], check=True)
    subprocess.run(['codesign', '--verify', str(binary)], check=True)
    lines = subprocess.check_output(['otool', '-L', str(binary)], text=True)
    if '/opt/homebrew/' in lines or '/usr/local/opt/' in lines:
        raise RuntimeError(f'Host package-manager dependency remains in {binary}')
    print(lines, end='')
