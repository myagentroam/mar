import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export interface DesktopFixtureOptions {
  readonly platform?: 'linux' | 'win32' | 'darwin' | 'unsupported';
  readonly input?: boolean;
  readonly clipboard?: boolean;
  readonly clipboardDenied?: boolean;
  readonly clipboardPopulated?: boolean;
  readonly clipboardOneShot?: boolean;
  readonly clipboardBackend?: 'xclip' | 'xsel';
  readonly unknownBackend?: boolean;
  readonly currentDesktop?: boolean;
  readonly screenshot?: boolean;
}

/** All desktop and native APIs are fakes, including on non-host platforms. */
export async function createFakeComputerRuntime(root: string, options: DesktopFixtureOptions = {}) {
  await writeFile(join(root, 'options.json'), JSON.stringify(options));
  await writeFile(join(root, 'effects'), '');
  await writeFile(join(root, 'clipboard'), 'original clipboard: 中文 📋');
  await writeFile(
    join(root, 'sitecustomize.py'),
    String.raw`
import ctypes, json, pathlib, shutil, subprocess, sys
root = pathlib.Path(__file__).parent
options = json.loads((root / "options.json").read_text())
sys.platform = options.get("platform", "linux")
def effect(name):
    with (root / "effects").open("a") as target: target.write(name + "\n")
class Function:
    def __init__(self, name): self.name = name
    def __call__(self, *args):
        name = self.name
        if name == "OpenInputDesktop": return 123 if options.get("input", True) else 0
        if name == "CloseDesktop": return 1
        if name == "GetCurrentThreadId": return 42
        if name == "GetThreadDesktop": return 123 if options.get("currentDesktop", True) else 456
        if name == "GetProcessWindowStation": return 789
        if name == "GetUserObjectInformationW":
            args[2].value = "WinSta0" if args[0] == 789 else ("Default" if args[0] == 123 else "Other")
            return 1
        if name in ("AXIsProcessTrusted", "CGPreflightPostEventAccess"):
            return options.get("input", True)
        if name == "OpenClipboard": return not options.get("clipboardDenied", False)
        if name == "CloseClipboard": return 1
        effect(name)
        raise AssertionError("Unexpected native operation: " + name)
class Library:
    def __getattr__(self, name): return Function(name)
ctypes.WinDLL = lambda *args, **kwargs: Library()
ctypes.CDLL = lambda *args, **kwargs: Library()
`
  );
  await writeFile(
    join(root, 'pyautogui.py'),
    String.raw`
from sitecustomize import options, effect
class Image:
    width = 1280 if options.get("screenshot", True) else 0
    height = 720
    def save(self, target, format=None):
        import base64
        target.write(base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="))
def screenshot(): return Image()
class Display:
    def has_extension(self, name): return options.get("input", True)
    def xtest_get_version(self, major, minor): return (major, minor)
    def intern_atom(self, name, only_if_exists=False): return 1
    def get_selection_owner(self, atom): return options.get("clipboardDenied", False) or options.get("clipboardPopulated", False)
class Backend:
    _display = Display()
_pyautogui_x11 = Backend()
def hotkey(*keys): effect("hotkey")
def keyUp(key): effect("keyUp")
def mouseUp(button=None): effect("mouseUp")
def __getattr__(name):
    def unexpected(*args, **kwargs):
        effect(name)
        raise AssertionError("Unexpected GUI operation: " + name)
    return unexpected
`
  );
  await writeFile(
    join(root, 'pyperclip.py'),
    String.raw`
import sys
from sitecustomize import root, options, effect
def copy(value):
    effect("copy")
    (root / "clipboard").write_text(value)
def paste(): return (root / "clipboard").read_text()
def determine_clipboard():
    if not options.get("clipboard", True): return None, None
    return copy, paste
backend = {"linux": "xclip", "win32": "windows", "darwin": "osx_pyobjc"}.get(sys.platform, "unknown")
if sys.platform == "linux": backend = options.get("clipboardBackend", backend)
if options.get("unknownBackend", False): backend = "unknown"
copy.__name__ = "copy_" + backend
paste.__name__ = "paste_" + backend
`
  );
  await writeFile(
    join(root, 'AppKit.py'),
    String.raw`
from sitecustomize import options
NSPasteboardAccessBehaviorAlwaysAllow = 2
class NSPasteboard:
    @staticmethod
    def generalPasteboard(): return NSPasteboard()
    def accessBehavior(self): return 0 if options.get("clipboardDenied", False) else 2
`
  );
  const executable = join(root, 'python');
  await writeFile(
    executable,
    [
      '#!/bin/sh',
      'if [ "${2##*/}" = "indicator.py" ]; then',
      '  echo ready',
      '  trap "exit 0" TERM INT',
      '  while :; do sleep 1; done',
      'fi',
      'PATH="$(dirname "$0"):$PATH" PYTHONPATH="$(dirname "$0")" exec python3 "$@"',
      ''
    ].join('\n')
  );
  await chmod(executable, 0o700);
  for (const name of ['xclip', 'xsel']) {
    await writeFile(
      join(root, name),
      String.raw`#!/usr/bin/env python3
import sys
from sitecustomize import root, options, effect
if any(argument in ("-o", "--output") for argument in sys.argv[1:]):
    effect("clipboard-read")
    if options.get("clipboardOneShot", False): (root / "clipboard").write_text("")
sys.exit(1 if options.get("clipboardDenied", False) else 0)
`,
      { mode: 0o700 }
    );
  }
  return executable;
}
