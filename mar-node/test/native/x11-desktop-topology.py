"""Test product topology fencing against a private Xvfb and the native XRandR helper."""
import os
import pathlib
import secrets
import select
import subprocess
import sys
import tempfile
import json


def event(process):
    if not select.select([process.stdout], [], [], 8)[0]:
        raise RuntimeError('timed out waiting for topology event')
    data = process.stdout.readline()
    if not data:
        raise RuntimeError('topology peer exited: ' + process.stderr.read().decode())
    return json.loads(data)


def main(binary):
    with tempfile.TemporaryDirectory(prefix='mar-topology-fence-') as directory:
        auth = pathlib.Path(directory) / 'Xauthority'
        auth.touch(mode=0o600)
        env = os.environ.copy()
        env['XAUTHORITY'] = str(auth)
        server = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '800x600x24',
                                   '-nolisten', 'tcp', '-auth', str(auth)],
                                  stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
        peer = None
        try:
            if not select.select([server.stdout], [], [], 8)[0]:
                raise RuntimeError('Xvfb did not provide a display')
            display = ':' + server.stdout.readline().decode().strip()
            subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)],
                           check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
            env['DISPLAY'] = display
            peer_path = pathlib.Path(__file__).with_name('x11-desktop-topology-peer.mts')
            root = pathlib.Path(__file__).resolve().parents[3]
            peer = subprocess.Popen(['node', '--import', 'tsx', str(peer_path), binary, display, str(auth)],
                                    cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                    stderr=subprocess.PIPE, env=env, bufsize=0)
            first = event(peer)
            assert first['type'] == 'ready'
            subprocess.run(['xrandr', '--output', 'screen', '--primary'], env=env, check=True,
                           stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
            assert event(peer)['type'] == 'fenced'
            peer.stdin.write(b'describe\n')
            peer.stdin.flush()
            while True:
                current = event(peer)
                if current['type'] == 'layout':
                    break
                assert current['type'] == 'fenced'
            assert current['layout']['topologyRevision'] > first['layout']['topologyRevision']
            assert current['oldGrantMatches'] is False
            peer.stdin.close()
            assert peer.wait(timeout=8) == 0
            print('PASS: native XRandR invalidation fences and retires the prior topology grant')
        finally:
            for process in (peer, server):
                if process and process.poll() is None:
                    process.kill()
                    process.wait()


if __name__ == '__main__':
    main(os.path.abspath(sys.argv[1]))
