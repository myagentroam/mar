#!/usr/bin/env python3
"""Verify a native macVNC framebuffer and pointer against two real OS displays."""
import json
import math
import os
from pathlib import Path
import socket
import struct
import subprocess
import sys
import time

port, helper = int(sys.argv[1]), sys.argv[2]
displays = json.loads(subprocess.check_output([helper]))['displays']
assert len(displays) >= 2, 'The isolated second macOS display was not created'
other = next(display for display in displays if not display['primary'])
left = min(display['x'] for display in displays)
top = min(display['y'] for display in displays)
right = max(display['x'] + display['width'] for display in displays)
bottom = max(display['y'] + display['height'] for display in displays)
scale = math.ceil(max(1, *(max(d['pixelWidth'] / d['width'], d['pixelHeight'] / d['height']) for d in displays)))

deadline = time.monotonic() + 20
while True:
    try:
        connection = socket.create_connection(('127.0.0.1', port), timeout=5)
        break
    except OSError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(.1)

def read(size):
    result = bytearray()
    while len(result) < size:
        part = connection.recv(size - len(result))
        if not part:
            raise RuntimeError('RFB connection closed')
        result.extend(part)
    return bytes(result)

with connection:
    connection.settimeout(20)
    assert read(12) == b'RFB 003.008\n'
    connection.sendall(b'RFB 003.008\n')
    methods = read(read(1)[0])
    assert 1 in methods
    connection.sendall(b'\x01')
    assert read(4) == bytes(4)
    connection.sendall(b'\x01')
    header = read(24)
    width, height = struct.unpack('>HH', header[:4])
    read(struct.unpack('>I', header[20:24])[0])
    assert (width, height) == (round((right - left) * scale), round((bottom - top) * scale))
    pixel_format = struct.pack('>BBBBHHHBBBxxx', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
    connection.sendall(b'\x00\x00\x00\x00' + pixel_format)
    connection.sendall(struct.pack('>BBHi', 2, 0, 1, 0))
    red = green = 0
    for _ in range(20):
        connection.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, width, height))
        assert read(2) == b'\x00\x00'
        rectangles = struct.unpack('>H', read(2))[0]
        red = green = 0
        for _ in range(rectangles):
            _, _, rw, rh, encoding = struct.unpack('>HHHHi', read(12))
            assert encoding == 0
            pixels = read(rw * rh * 4)
            red += sum(1 for i in range(0, len(pixels), 4)
                       if pixels[i + 2] > 200 and pixels[i + 1] < 60 and pixels[i] < 60)
            green += sum(1 for i in range(0, len(pixels), 4)
                         if pixels[i + 1] > 200 and pixels[i + 2] < 60 and pixels[i] < 60)
        if red > 100 and green > 100:
            break
        time.sleep(.2)
    assert red > 100 and green > 100, f'Missing display pixels: red={red} green={green}'
    x = round((other['x'] + other['width'] / 2 - left) * scale)
    y = round((other['y'] + other['height'] / 2 - top) * scale)
    print(f'MULTIDISPLAY topology={json.dumps(displays)} scale={scale} framebuffer={width}x{height} '
          f'red={red} green={green} pointer={x},{y}', flush=True)
    connection.sendall(struct.pack('>BBHH', 5, 1, x, y))
    connection.sendall(struct.pack('>BBHH', 5, 0, x, y))
    receipt = Path(os.environ['MAR_MULTISCREEN_CLICK'])
    deadline = time.monotonic() + 5
    while not receipt.exists() and time.monotonic() < deadline:
        time.sleep(.05)
    assert receipt.exists() and receipt.read_text().strip() == 'clicked', 'Pointer did not reach secondary display'
    print(f'MULTIDISPLAY framebuffer={width}x{height} red={red} green={green} secondary-pointer=PASS')
