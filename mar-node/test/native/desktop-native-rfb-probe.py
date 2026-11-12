#!/usr/bin/env python3
"""Check real VNC pixels and, when requested, native keyboard delivery."""
import os
from pathlib import Path
import socket
import struct
import sys
import time

port = int(sys.argv[1])
receipt = Path(os.environ['MAR_DESKTOP_KEY_RECEIPT'])
mouse_receipt = Path(os.environ['MAR_DESKTOP_MOUSE_RECEIPT'])
want_input = len(sys.argv) > 2 and sys.argv[2] == 'control'
deadline = time.monotonic() + 20
while True:
    try:
        connection = socket.create_connection(('127.0.0.1', port), timeout=5)
        break
    except OSError:
        if time.monotonic() >= deadline:
            raise
        time.sleep(.2)


def read(size):
    chunks = bytearray()
    while len(chunks) < size:
        data = connection.recv(size - len(chunks))
        if not data:
            raise RuntimeError('RFB connection closed early')
        chunks.extend(data)
    return bytes(chunks)


with connection:
    connection.settimeout(20)
    assert read(12) == b'RFB 003.008\n'
    connection.sendall(b'RFB 003.008\n')
    count = read(1)[0]
    assert 1 in read(count), 'Server did not offer RFB None security'
    connection.sendall(b'\x01')
    assert read(4) == bytes(4), 'RFB security failed'
    connection.sendall(b'\x01')
    header = read(24)
    width, height = struct.unpack('>HH', header[:4])
    assert width > 0 and height > 0
    read(struct.unpack('>I', header[20:24])[0])
    # Request a known 32-bit little-endian RGB format and raw encoding.
    pixel_format = struct.pack('>BBBBHHHBBBxxx', 32, 24, 0, 1, 255, 255, 255, 16, 8, 0)
    connection.sendall(b'\x00\x00\x00\x00' + pixel_format)
    connection.sendall(struct.pack('>BBHi', 2, 0, 1, 0))
    connection.sendall(struct.pack('>BBHHHH', 3, 0, 0, 0, width, height))
    assert read(2) == b'\x00\x00', 'Expected framebuffer update'
    rectangles = struct.unpack('>H', read(2))[0]
    red = 0
    for _ in range(rectangles):
        _, _, rect_width, rect_height, encoding = struct.unpack('>HHHHi', read(12))
        assert encoding == 0, f'Unexpected RFB encoding: {encoding}'
        pixels = read(rect_width * rect_height * 4)
        red += sum(1 for offset in range(0, len(pixels), 4)
                   if pixels[offset + 2] > 200 and pixels[offset + 1] < 60 and pixels[offset] < 60)
    assert red > 100, f'Expected red fixture in captured framebuffer; found {red} pixels'
    print(f'Native RFB framebuffer {width}x{height}, red fixture pixels: {red}')
    if want_input:
        connection.sendall(struct.pack('>BBHH', 5, 1, width // 2, height // 2))
        connection.sendall(struct.pack('>BBHH', 5, 0, width // 2, height // 2))
        connection.sendall(struct.pack('>BBHI', 4, 1, 0, ord('a')))
        connection.sendall(struct.pack('>BBHI', 4, 0, 0, ord('a')))
        deadline = time.monotonic() + 5
        while (not receipt.exists() or not mouse_receipt.exists()) and time.monotonic() < deadline:
            time.sleep(.05)
        assert receipt.read_text().strip() == 'key-a', 'Native application did not receive key'
        assert mouse_receipt.read_text().strip() == 'mouse-down', 'Native application did not receive pointer click'
        print('Native application received RFB pointer click and key-a')
