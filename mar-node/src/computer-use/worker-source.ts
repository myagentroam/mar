export const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
export const MAX_IMAGES = 4;

export const PYTHON_WORKER_SOURCE = String.raw`
import base64
import contextlib
import io
import json
import sys
import time
import traceback

import pyautogui

namespace = {"pyautogui": pyautogui, "time": time}
current_logs = []
current_images = []

def _emit(message):
    sys.__stdout__.write(json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n")
    sys.__stdout__.flush()

def log(value):
    current_logs.append(str(value))

def _image_bytes(image):
    if hasattr(image, "save"):
        buffer = io.BytesIO()
        image.save(buffer, format="PNG")
        value = buffer.getvalue()
        if len(value) > ${MAX_IMAGE_BYTES}:
            raise ValueError("display image exceeds the size limit")
        return value
    if isinstance(image, (bytes, bytearray)):
        value = bytes(image)
        if len(value) > ${MAX_IMAGE_BYTES}:
            raise ValueError("display image exceeds the size limit")
        return value
    raise TypeError("display expects a PIL image or PNG bytes")

def display(image):
    if len(current_images) >= ${MAX_IMAGES}:
        raise ValueError("too many displayed images")
    current_images.append({
        "mimeType": "image/png",
        "dataBase64": base64.b64encode(_image_bytes(image)).decode("ascii")
    })

def paste_text(text):
    value = str(text)
    try:
        import pyperclip
        previous = None
        try:
            previous = pyperclip.paste()
        except Exception:
            pass
        with open("clipboard.json", "w", encoding="utf-8") as clipboard_file:
            json.dump({"value": previous}, clipboard_file, ensure_ascii=False)
        pyperclip.copy(value)
        pyautogui.hotkey("command" if sys.platform == "darwin" else "ctrl", "v")
        time.sleep(0.05)
        if previous is not None:
            pyperclip.copy(previous)
        try:
            import os
            os.remove("clipboard.json")
        except OSError:
            pass
        return
    except Exception as error:
        raise RuntimeError("Unicode clipboard paste is unavailable") from error

namespace.update({"display": display, "log": log, "paste_text": paste_text})
_emit({"type": "ready"})

for raw in sys.stdin:
    request = None
    try:
        request = json.loads(raw)
        request_id = request["id"]
        code = request["code"]
        current_logs = []
        current_images = []
        captured_stdout = io.StringIO()
        captured_stderr = io.StringIO()
        with contextlib.redirect_stdout(captured_stdout), contextlib.redirect_stderr(captured_stderr):
            if code:
                exec(compile(code, "<computer-use>", "exec"), namespace, namespace)
            if not current_images:
                display(pyautogui.screenshot())
        stdout_value = captured_stdout.getvalue()
        stderr_value = captured_stderr.getvalue()
        if stdout_value:
            current_logs.append(stdout_value.rstrip())
        if stderr_value:
            current_logs.append(stderr_value.rstrip())
        _emit({
            "type": "result",
            "id": request_id,
            "logs": current_logs,
            "images": current_images
        })
    except BaseException:
        _emit({
            "type": "error",
            "id": request.get("id") if isinstance(request, dict) else "",
            "error": traceback.format_exc(limit=20)
        })
`;

export const PYTHON_CLEANUP_SOURCE = String.raw`
import json
import os

import pyautogui

for key in ("ctrl", "shift", "alt", "win", "command"):
    try:
        pyautogui.keyUp(key)
    except Exception:
        pass
for button in ("left", "middle", "right"):
    try:
        pyautogui.mouseUp(button=button)
    except Exception:
        pass
try:
    import pyperclip
    if os.path.exists("clipboard.json"):
        with open("clipboard.json", "r", encoding="utf-8") as clipboard_file:
            previous = json.load(clipboard_file).get("value")
        if previous is not None:
            pyperclip.copy(previous)
except Exception:
    pass
`;
