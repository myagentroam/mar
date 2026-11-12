#!/usr/bin/env python3
"""Exercise actual Connector GUI discovery with private package resources and Xvfb."""
import json
import os
from pathlib import Path
import secrets
import select
import shutil
import subprocess
import sys
import tarfile
import tempfile

if len(sys.argv) != 3:
    raise SystemExit('usage: python3 connector-desktop.py /path/to/x0vncserver /path/to/x11-topology')
repo = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='mar-connector-desktop-') as temporary:
    root = Path(temporary)
    node = root / 'mar-node'
    shutil.copytree(repo / 'mar-node/src', node / 'src')
    shutil.copy2(repo / 'mar-node/package.json', node / 'package.json')
    database_url = os.environ.get('MAR_TEST_DATABASE_URL')
    peer_name = 'product-desktop-discovery-peer.mts' if database_url else 'connector-desktop-peer.mts'
    peer = node / 'test/native' / peer_name
    peer.parent.mkdir(parents=True)
    shutil.copy2(Path(__file__).with_name(peer_name), peer)
    (root / 'node_modules').symlink_to(repo / 'node_modules', target_is_directory=True)
    scope = node / 'node_modules/@myagentroam'
    scope.mkdir(parents=True)
    for original in (repo / 'mar-node/node_modules').iterdir():
        if original.name != '@myagentroam':
            (node / 'node_modules' / original.name).symlink_to(
                original.resolve(), target_is_directory=original.is_dir())
    for original in (repo / 'mar-node/node_modules/@myagentroam').iterdir():
        if original.name != 'binaries':
            (scope / original.name).symlink_to(original.resolve(), target_is_directory=True)
    if os.environ.get('MAR_TEST_PACKAGED_BINARIES') == '1':
        packed = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json',
                                 '--pack-destination', str(root)],
                                cwd=repo / 'packages/binaries', check=True,
                                capture_output=True, text=True)
        archive = root / json.loads(packed.stdout)[0]['filename']
        with tarfile.open(archive, 'r:gz') as source:
            source.extractall(root, filter='data')
        package = root / 'package'
        platform_packed = subprocess.run(['npm', 'pack', '--ignore-scripts', '--json',
                                          '--pack-destination', str(root)],
                                         cwd=repo / 'packages/binaries-linux-x64', check=True,
                                         capture_output=True, text=True)
        platform_archive = root / json.loads(platform_packed.stdout)[0]['filename']
        platform_root = root / 'platform-extract'
        platform_root.mkdir()
        with tarfile.open(platform_archive, 'r:gz') as source:
            source.extractall(platform_root, filter='data')
        platform_package = platform_root / 'package'
    else:
        package = root / 'binaries'
        shutil.copy2(repo / 'packages/binaries/package.json', (root / 'binaries-package.json'))
        package.mkdir()
        shutil.move(root / 'binaries-package.json', package / 'package.json')
        vendor = package / 'vendor/tigervnc'
        target = vendor / 'linux-x64'
        target.mkdir(parents=True)
        shutil.copy2(sys.argv[1], target / 'x0vncserver')
        shutil.copy2(sys.argv[2], target / 'x11-topology')
        (vendor / 'manifest.json').write_text(json.dumps({'targets': {'linux-x64': {
            'server': 'linux-x64/x0vncserver', 'topology': 'linux-x64/x11-topology'
        }}}))
        platform_package = root / 'platform'
        shutil.copytree(package, platform_package)
        shutil.copy2(repo / 'packages/binaries-linux-x64/package.json',
                     platform_package / 'package.json')
    platform_scope = package / 'node_modules/@myagentroam'
    platform_scope.mkdir(parents=True)
    (platform_scope / 'binaries-linux-x64').symlink_to(platform_package, target_is_directory=True)
    (scope / 'binaries').symlink_to(package, target_is_directory=True)
    auth = root / 'Xauthority'
    auth.touch(mode=0o600)
    env = os.environ.copy()
    env['XAUTHORITY'] = str(auth)
    external_display = env.get('MAR_TEST_PRIVATE_X11_DISPLAY')
    xvfb = None if external_display else subprocess.Popen(
        ['Xvfb', '-displayfd', '1', '-screen', '0', '800x600x24',
         '-nolisten', 'tcp', '-auth', str(auth)],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    try:
        if xvfb:
            assert select.select([xvfb.stdout], [], [], 8)[0], 'Xvfb startup timeout'
            display = ':' + xvfb.stdout.readline().decode().strip()
            subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        else:
            display = external_display
        env['DISPLAY'] = display
        arguments = ['node', '--import', 'tsx', str(peer), str(root / 'data')]
        if database_url:
            arguments.extend([str(repo), database_url])
        output_path = root / 'peer.stdout'
        error_path = root / 'peer.stderr'
        timed_out = False
        with output_path.open('w') as output, error_path.open('w') as error_output:
            try:
                result = subprocess.run(arguments, cwd=repo, env=env, stdout=output,
                                        stdin=None if env.get('MAR_TEST_INHERIT_STDIN') == '1' else subprocess.DEVNULL,
                                        stderr=error_output, text=True,
                                        timeout=int(env.get('MAR_TEST_PROBE_TIMEOUT', '90')))
            except subprocess.TimeoutExpired:
                timed_out = True
        stdout = output_path.read_text(errors='replace')
        stderr = error_path.read_text(errors='replace')
        if timed_out:
            details = stdout + stderr
            if database_url:
                details = details.replace(database_url, '<database-url>')
            raise RuntimeError('Connector probe timed out:\n' + details)
        marker = 'PRODUCT_DESKTOP_DISCOVERY_READY' if database_url else 'NATIVE_CONNECTOR_DESKTOP_READY'
        if result.returncode or marker not in stdout:
            details = stdout + stderr
            if database_url:
                details = details.replace(database_url, '<database-url>')
            raise RuntimeError('Connector probe failed:\n' + details)
        if database_url and env.get('MAR_TEST_WEB_ROOT') and 'PRODUCT_DESKTOP_BROWSER_READY' not in stdout:
            raise RuntimeError('Product browser did not become ready:\n' + stdout + stderr)
        if env.get('MAR_TEST_TRACE') == '1':
            for message in stderr.splitlines():
                if message.startswith('PRODUCT_DESKTOP_STEP '):
                    print(message)
        for line in stdout.splitlines():
            if line.startswith('PRODUCT_DESKTOP_TRANSPORT_'):
                print(line)
        print('PASS: real Connector discovers private X11 using packaged managed candidates'
              + (' through product Server authorization' if database_url else ''))
    finally:
        if xvfb:
            xvfb.terminate()
            xvfb.wait(timeout=5)
