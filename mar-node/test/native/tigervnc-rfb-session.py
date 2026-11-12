#!/usr/bin/env python3
"""Verify the Node RFB session and native receipt against a private Xvfb."""
import ctypes
import ctypes.util
import os
from pathlib import Path
import secrets
import select
import subprocess
import sys
import tempfile
import time

if len(sys.argv) not in (2, 3):
    raise SystemExit('usage: python3 tigervnc-rfb-session.py /absolute/path/to/x0vncserver [peer.mts]')
binary = str(Path(sys.argv[1]).resolve(strict=True))
peer_script = (Path(sys.argv[2]) if len(sys.argv) == 3 else Path(__file__).with_name('tigervnc-rfb-session-peer.mts')).resolve(strict=True)
repository = Path(__file__).resolve().parents[3]
with tempfile.TemporaryDirectory(prefix='mar-rfb-session-') as temporary:
    root = Path(temporary)
    auth = root / 'Xauthority'
    auth.touch(mode=0o600)
    env = os.environ.copy()
    env['XAUTHORITY'] = str(auth)
    xvfb = subprocess.Popen(['Xvfb', '-displayfd', '1', '-screen', '0', '800x600x24',
                             '-nolisten', 'tcp', '-auth', str(auth)],
                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, env=env)
    peer = None
    try:
        assert select.select([xvfb.stdout], [], [], 8)[0], 'Xvfb startup timeout'
        display = ':' + xvfb.stdout.readline().decode().strip()
        subprocess.run(['xauth', '-f', str(auth), 'add', display, '.', secrets.token_hex(16)],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        env['DISPLAY'] = display
        peer = subprocess.Popen(['node', '--import', 'tsx', str(peer_script), binary, display, str(auth)],
                                cwd=repository, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, env=env)

        def line():
            if not select.select([peer.stdout], [], [], 25)[0]:
                peer.terminate()
                _, stderr = peer.communicate(timeout=5)
                raise RuntimeError('Node peer timeout: ' + stderr)
            value = peer.stdout.readline().strip()
            if not value:
                raise RuntimeError('Node peer exited: ' + peer.stderr.read())
            return value

        if os.environ.get('MAR_TEST_PAGE_VIEW_HIDDEN') == '1' or os.environ.get('MAR_TEST_PAGE_LATE_FRAME') == '1':
            assert line() == 'HIDDEN_VIEW_CLOSED'
            assert peer.wait(timeout=5) == 0
            print('PASS: hidden VIEW settled without automatic reactivation')
        else:
            assert line() == 'READY'
            os.environ['XAUTHORITY'] = str(auth)
            x = ctypes.CDLL(ctypes.util.find_library('X11'))
            x.XOpenDisplay.argtypes = [ctypes.c_char_p]
            x.XOpenDisplay.restype = ctypes.c_void_p
            x.XKeysymToKeycode.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x.XKeysymToKeycode.restype = ctypes.c_ubyte
            x.XQueryKeymap.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
            x.XDefaultRootWindow.argtypes = [ctypes.c_void_p]
            x.XDefaultRootWindow.restype = ctypes.c_ulong
            x.XInternAtom.argtypes = [ctypes.c_void_p, ctypes.c_char_p, ctypes.c_int]
            x.XInternAtom.restype = ctypes.c_ulong
            x.XGetSelectionOwner.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
            x.XGetSelectionOwner.restype = ctypes.c_ulong
            x.XQueryPointer.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                                        ctypes.POINTER(ctypes.c_ulong), ctypes.POINTER(ctypes.c_ulong),
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                        ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int),
                                        ctypes.POINTER(ctypes.c_uint)]
            x.XCloseDisplay.argtypes = [ctypes.c_void_p]
            connection = x.XOpenDisplay(display.encode())
            assert connection
            try:
                code = x.XKeysymToKeycode(connection, 97)
                keymap = ctypes.create_string_buffer(32)

                def pressed():
                    x.XQueryKeymap(connection, keymap)
                    return bool(keymap.raw[code // 8] & (1 << (code % 8)))

                assert not pressed()
                clipboard = x.XInternAtom(connection, b'CLIPBOARD', 0)
                if os.environ.get('MAR_TEST_DESKTOP_PAGE') == '1':
                    assert x.XGetSelectionOwner(connection, clipboard) == 0
                peer.stdin.write('key\n')
                peer.stdin.flush()
                assert line() == 'KEY'
                deadline = time.monotonic() + 4
                while not pressed() and time.monotonic() < deadline:
                    time.sleep(.01)
                assert pressed(), 'input was not observed at the X server'
                if os.environ.get('MAR_TEST_PAGE_CLIPBOARD') == '1':
                    deadline = time.monotonic() + 4
                    while not x.XGetSelectionOwner(connection, clipboard) and time.monotonic() < deadline:
                        time.sleep(.01)
                    assert x.XGetSelectionOwner(connection, clipboard), 'clipboard selection was not published'
                    result = subprocess.run(['xclip', '-selection', 'clipboard', '-target', 'UTF8_STRING', '-out'],
                                            env=env, capture_output=True, timeout=4, check=True)
                    assert result.stdout.decode('utf-8') == '真实桌面中文'
                if os.environ.get('MAR_TEST_DESKTOP_PAGE') == '1':
                    root = ctypes.c_ulong()
                    child = ctypes.c_ulong()
                    root_x, root_y, win_x, win_y = (ctypes.c_int() for _ in range(4))
                    mask = ctypes.c_uint()
                    assert x.XQueryPointer(connection, x.XDefaultRootWindow(connection),
                                           ctypes.byref(root), ctypes.byref(child),
                                           ctypes.byref(root_x), ctypes.byref(root_y),
                                           ctypes.byref(win_x), ctypes.byref(win_y), ctypes.byref(mask))
                    assert abs(root_x.value - 600) <= 3 and abs(root_y.value - 300) <= 3, (
                        f'cropped primary input mapped to ({root_x.value},{root_y.value})')
                if os.environ.get('MAR_TEST_PAGE_SOFTKEY') == '1':
                    class XKeyEvent(ctypes.Structure):
                        _fields_ = [('type', ctypes.c_int), ('serial', ctypes.c_ulong),
                                    ('send_event', ctypes.c_int), ('display', ctypes.c_void_p),
                                    ('window', ctypes.c_ulong), ('root', ctypes.c_ulong),
                                    ('subwindow', ctypes.c_ulong), ('time', ctypes.c_ulong),
                                    ('x', ctypes.c_int), ('y', ctypes.c_int),
                                    ('x_root', ctypes.c_int), ('y_root', ctypes.c_int),
                                    ('state', ctypes.c_uint), ('keycode', ctypes.c_uint),
                                    ('same_screen', ctypes.c_int)]
                    class XEvent(ctypes.Union):
                        _fields_ = [('type', ctypes.c_int), ('key', XKeyEvent),
                                    ('pad', ctypes.c_long * 24)]
                    x.XCreateSimpleWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong,
                        ctypes.c_int, ctypes.c_int, ctypes.c_uint, ctypes.c_uint, ctypes.c_uint,
                        ctypes.c_ulong, ctypes.c_ulong]
                    x.XCreateSimpleWindow.restype = ctypes.c_ulong
                    x.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
                    x.XMapWindow.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
                    x.XSetInputFocus.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
                    x.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
                    x.XPending.argtypes = [ctypes.c_void_p]
                    x.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.POINTER(XEvent)]
                    x.XLookupKeysym.argtypes = [ctypes.POINTER(XKeyEvent), ctypes.c_int]
                    x.XLookupKeysym.restype = ctypes.c_ulong
                    window = x.XCreateSimpleWindow(connection, x.XDefaultRootWindow(connection),
                                                    0, 0, 800, 600, 0, 0, 0)
                    x.XSelectInput(connection, window, 3)
                    x.XMapWindow(connection, window)
                    x.XSetInputFocus(connection, window, 1, 0)
                    x.XSync(connection, 0)
                    peer.stdin.write('soft\n')
                    peer.stdin.flush()
                    assert line() == 'SOFT_TEXT'
                    received = []
                    expected = ([ord('b')] * 256 if os.environ.get('MAR_TEST_PAGE_STRESS') == '1'
                                else [ord('b'), ord('c')]) + [0xff0d, 0xff08]
                    deadline = time.monotonic() + 4
                    while time.monotonic() < deadline and received != expected:
                        while x.XPending(connection):
                            event = XEvent()
                            x.XNextEvent(connection, ctypes.byref(event))
                            if event.type == 2:
                                symbol = x.XLookupKeysym(ctypes.byref(event.key), 0)
                                if symbol in expected:
                                    received.append(symbol)
                        time.sleep(.01)
                    assert received == expected, f'soft keyboard did not inject expected X key events: {received}'
                if os.environ.get('MAR_TEST_MODE_SWITCH') == '1':
                    peer.stdin.write('switch\n')
                    peer.stdin.flush()
                    assert line() == 'SWITCHED_AFTER_NATIVE_RECEIPT'
                    assert not pressed(), 'key remained down after mode switch'
                peer.stdin.write('close\n')
                peer.stdin.flush()
                assert line() == 'CLOSED_WITH_NATIVE_RECEIPT'
                assert not pressed(), 'key remained down after the receipt'
                if os.environ.get('MAR_TEST_DESKTOP_PAGE') == '1':
                    assert x.XGetSelectionOwner(connection, clipboard) == 0, 'late clipboard read reached X11'
                assert peer.wait(timeout=5) == 0
            finally:
                x.XCloseDisplay(connection)
            print('PASS: managed backend, frontend RFB handshake, gate, native key and cleanup receipt')
    finally:
        for process in (peer, xvfb):
            if process is not None and process.poll() is None:
                process.terminate()
                try:
                    process.wait(timeout=5)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()
