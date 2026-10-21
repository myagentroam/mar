/** Read-only platform evidence; never inject input or replace clipboard contents. */
export const PYTHON_PROBE_SOURCE = String.raw`
import ctypes
import json
import os
import shutil
import subprocess
import sys

result = dict(supportsScreenshot=False, supportsPrimaryDisplay=False,
              supportsInput=False, supportsUnicodePaste=False,
              reasonCode="COMPUTER_RUNTIME_UNAVAILABLE")

def signature(library, name, arguments, returns):
    function = getattr(library, name)
    function.argtypes = arguments
    function.restype = returns
    return function

def windows_desktop():
    user = ctypes.WinDLL("user32", use_last_error=True)
    kernel = ctypes.WinDLL("kernel32", use_last_error=True)
    handle, integer = ctypes.c_void_p, ctypes.c_uint32
    open_desktop = signature(user, "OpenInputDesktop", [integer, ctypes.c_int, integer], handle)
    close_desktop = signature(user, "CloseDesktop", [handle], ctypes.c_int)
    thread_id = signature(kernel, "GetCurrentThreadId", [], integer)
    thread_desktop = signature(user, "GetThreadDesktop", [integer], handle)
    station = signature(user, "GetProcessWindowStation", [], handle)
    information = signature(user, "GetUserObjectInformationW",
                            [handle, ctypes.c_int, handle, integer, handle], ctypes.c_int)
    def name(object_handle):
        buffer = ctypes.create_unicode_buffer(256)
        needed = integer()
        if not information(object_handle, 2, buffer, ctypes.sizeof(buffer), ctypes.byref(needed)):
            return None
        return buffer.value
    # DESKTOP_READOBJECTS | DESKTOP_WRITEOBJECTS. Do not switch or attach desktops.
    desktop = open_desktop(0, False, 0x0001 | 0x0080)
    if not desktop:
        return False
    try:
        desktop_name = name(desktop)
        return (name(station()) == "WinSta0" and desktop_name is not None
                and desktop_name == name(thread_desktop(thread_id())))
    finally:
        close_desktop(desktop)

def input_supported(gui):
    if sys.platform == "win32":
        return windows_desktop()
    if sys.platform == "darwin":
        services = ctypes.CDLL("/System/Library/Frameworks/ApplicationServices.framework/ApplicationServices")
        graphics = ctypes.CDLL("/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics")
        trusted = signature(services, "AXIsProcessTrusted", [], ctypes.c_bool)
        post_access = signature(graphics, "CGPreflightPostEventAccess", [], ctypes.c_bool)
        return bool(trusted() and post_access())
    if sys.platform == "linux":
        display = gui._pyautogui_x11._display
        if not display.has_extension("XTEST"):
            return False
        display.xtest_get_version(2, 2)
        return True
    return False

def clipboard_supported():
    import pyperclip
    copy, paste = pyperclip.determine_clipboard()
    if not callable(copy) or not callable(paste) or not copy or not paste:
        return False
    names = (getattr(copy, "__name__", ""), getattr(paste, "__name__", ""))
    if sys.platform == "win32" and names == ("copy_windows", "paste_windows"):
        user = ctypes.WinDLL("user32", use_last_error=True)
        open_clipboard = signature(user, "OpenClipboard", [ctypes.c_void_p], ctypes.c_int)
        close_clipboard = signature(user, "CloseClipboard", [], ctypes.c_int)
        if not open_clipboard(None):
            return False
        # Opening and closing does not empty, read, or take ownership of the clipboard.
        return bool(close_clipboard())
    if sys.platform == "darwin":
        import AppKit
        board = AppKit.NSPasteboard.generalPasteboard()
        if board is None:
            return False
        # Newer systems expose pasteboard policy. Do not provoke an access prompt.
        if hasattr(board, "accessBehavior"):
            allowed = getattr(AppKit, "NSPasteboardAccessBehaviorAlwaysAllow", None)
            if allowed is None or board.accessBehavior() != allowed:
                return False
        if names == ("copy_osx_pyobjc", "paste_osx_pyobjc"):
            return True
        return (names == ("copy_osx_pbcopy", "paste_osx_pbcopy")
                and shutil.which("pbcopy") is not None and shutil.which("pbpaste") is not None)
    if sys.platform == "linux":
        commands = {("copy_xclip", "paste_xclip"): ["xclip", "-version"],
                    ("copy_xsel", "paste_xsel"): ["xsel", "--version"]}
        command = commands.get(names)
        executable = shutil.which(command[0]) if command is not None else None
        if executable is None:
            return False
        # X11 access was established above. Verify the selected backend can run,
        # without consuming a one-shot selection or requesting clipboard contents.
        subprocess.run([executable, *command[1:]], stdin=subprocess.DEVNULL,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True, timeout=2)
        return True
    return False

try:
    if sys.platform not in ("win32", "darwin", "linux") or (sys.platform == "linux" and
            (not os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))):
        result["reasonCode"] = "COMPUTER_DESKTOP_UNSUPPORTED"
    else:
        import pyautogui
        image = pyautogui.screenshot()
        if image.width > 0 and image.height > 0:
            result["supportsScreenshot"] = result["supportsPrimaryDisplay"] = True
            result["reasonCode"] = "COMPUTER_INPUT_PERMISSION_DENIED"
            if input_supported(pyautogui):
                result["supportsInput"] = True
                result["reasonCode"] = "COMPUTER_RUNTIME_UNAVAILABLE"
                if clipboard_supported():
                    result["supportsUnicodePaste"] = True
                    result["reasonCode"] = None
except Exception:
    pass
print(json.dumps(result))
`;
