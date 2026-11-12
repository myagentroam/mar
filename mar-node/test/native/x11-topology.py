"""Exercise the XRandR source against a private Xvfb, never the user's display."""

import json
import os
import pathlib
import secrets
import select
import subprocess
import sys
import tempfile
import time


def line(process, deadline):
    data = bytearray()
    while not data.endswith(b'\n'):
        remaining = deadline - time.monotonic()
        if remaining <= 0 or not select.select([process.stdout], [], [], remaining)[0]:
            raise RuntimeError('timed out waiting for native topology event')
        byte = os.read(process.stdout.fileno(), 1)
        if not byte or len(data) >= 262144:
            raise RuntimeError('native topology source closed or exceeded the test limit')
        data.extend(byte)
    return json.loads(data)


def main(binary):
    with tempfile.TemporaryDirectory(prefix='mar-xrandr-test-') as directory:
        auth = pathlib.Path(directory) / 'Xauthority'
        auth.touch(mode=0o600)
        env = os.environ.copy()
        env['XAUTHORITY'] = str(auth)
        server = subprocess.Popen(
            ['Xvfb', '-displayfd', '1', '-screen', '0', '800x600x24', '-nolisten', 'tcp', '-auth', str(auth)],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env,
        )
        helper = peer = None
        try:
            if not select.select([server.stdout], [], [], 8)[0]:
                raise RuntimeError('Xvfb did not provide a display')
            display = ':' + server.stdout.readline().decode().strip()
            subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            env['DISPLAY'] = display
            helper = subprocess.Popen([binary], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                      stderr=subprocess.PIPE, env=env, bufsize=0)
            first = line(helper, time.monotonic() + 8)
            assert first['type'] == 'snapshot'
            assert (first['width'], first['height']) == (800, 600)
            assert len(first['monitors']) == 1
            monitor = first['monitors'][0]
            assert (monitor['x'], monitor['y'], monitor['width'], monitor['height']) == (0, 0, 800, 600)
            assert monitor['name'] == 'screen' and monitor['outputs'][0]['name'] == 'screen'
            assert monitor['outputs'][0]['transform'] == [65536, 0, 0, 0, 65536, 0, 0, 0, 65536]

            peer_path = pathlib.Path(__file__).with_name('x11-topology-peer.mts')
            product_root = pathlib.Path(__file__).resolve().parents[3]
            peer = subprocess.Popen(['node', '--import', 'tsx', str(peer_path), binary, display, str(auth)],
                                    cwd=product_root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env, bufsize=0)
            peer_first = line(peer, time.monotonic() + 8)
            layout = peer_first.pop('layout')
            assert peer_first == first
            assert layout['framebuffer'] == {'width': 800, 'height': 600}
            assert len(layout['displays']) == 1 and layout['displays'][0]['primary']
            subprocess.run(['xrandr', '--output', 'screen', '--primary'], env=env, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            for process in (helper, peer):
                deadline = time.monotonic() + 8
                while True:
                    event = line(process, deadline)
                    assert event['type'] == 'invalidated'
                    updated = line(process, deadline)
                    if process is peer:
                        updated_layout = updated.pop('layout')
                        old_id = layout['displays'][0]['displayId']
                        new_id = updated_layout['displays'][0]['displayId']
                        reset = event.get('resetAll') or event.get('resetOutput') == monitor['outputs'][0]['id']
                        assert (new_id != old_id) if reset else (new_id == old_id)
                        layout = updated_layout
                    assert updated['type'] == 'snapshot'
                    if updated['monitors'][0]['primary']:
                        break
            helper.stdin.close()
            peer.stdin.close()
            assert helper.wait(timeout=5) == 0
            assert peer.wait(timeout=5) == 0
            print('PASS: native and Node XRandR topology, invalidation, updated primary and owner EOF')
        finally:
            for process in (helper, peer):
                if process and process.poll() is None:
                    process.kill()
                    process.wait()
            if server.poll() is None:
                server.terminate()
                server.wait(timeout=5)


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
