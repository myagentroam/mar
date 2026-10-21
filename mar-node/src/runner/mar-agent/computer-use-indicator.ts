import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { terminateProcessTree } from '../../process-tree.js';

const START_TIMEOUT_MS = 5_000;
const STOP_TIMEOUT_MS = 2_000;

/** A non-activating, pointer-transparent primary-display control marker. */
export class ComputerUseControlIndicator {
  #closed = false;
  #lostError: Error | undefined;
  readonly lost: Promise<Error>;

  private constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly directory: string
  ) {
    this.lost = new Promise<Error>((resolveLost) => {
      child.once('exit', (code, signal) => {
        if (this.#closed) return;
        this.#lostError = new Error(
          `Computer Use control indicator exited (${code ?? signal ?? 'unknown'}).`
        );
        resolveLost(this.#lostError);
      });
    });
  }

  static async show(runtimeExecutable: string): Promise<ComputerUseControlIndicator> {
    const directory = await mkdtemp(resolve(tmpdir(), 'mar-computer-use-indicator-'));
    const script = resolve(directory, 'indicator.py');
    await writeFile(script, PYTHON_INDICATOR_SOURCE, { encoding: 'utf8', mode: 0o600 });
    const child = spawn(runtimeExecutable, ['-u', script], {
      cwd: directory,
      env: indicatorEnvironment(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      detached: process.platform !== 'win32'
    });
    const indicator = new ComputerUseControlIndicator(child, directory);
    try {
      await waitUntilVisible(child);
      return indicator;
    } catch (error) {
      await indicator.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    this.child.stdin.end();
    if (this.child.exitCode === null && this.child.signalCode === null) {
      await terminateProcessTree(this.child).catch(() => {
        try {
          this.child.kill('SIGTERM');
        } catch {
          // The process may have exited between the status check and termination.
        }
      });
      if (!(await waitForExit(this.child, STOP_TIMEOUT_MS))) {
        try {
          this.child.kill('SIGKILL');
        } catch {
          // The process may have exited before the fallback signal.
        }
        await waitForExit(this.child, STOP_TIMEOUT_MS);
      }
    }
    await rm(this.directory, { recursive: true, force: true }).catch(() => undefined);
  }

  assertActive(): void {
    if (this.#lostError !== undefined) throw this.#lostError;
    if (this.child.exitCode !== null || this.child.signalCode !== null)
      throw new Error('Computer Use control indicator is no longer active.');
  }
}

async function waitForExit(
  child: ChildProcessWithoutNullStreams,
  timeoutMs: number
): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return await new Promise<boolean>((resolveExit) => {
    const timer = setTimeout(() => finish(false), timeoutMs);
    const exit = () => finish(true);
    const finish = (exited: boolean) => {
      clearTimeout(timer);
      child.off('exit', exit);
      resolveExit(exited);
    };
    child.once('exit', exit);
    if (child.exitCode !== null || child.signalCode !== null) finish(true);
  });
}

async function waitUntilVisible(child: ChildProcessWithoutNullStreams): Promise<void> {
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  try {
    await new Promise<void>((resolveVisible, reject) => {
      let stderr = '';
      const timer = setTimeout(
        () => finish(() => reject(new Error('Computer Use control indicator start timed out.'))),
        START_TIMEOUT_MS
      );
      const finish = (callback: () => void) => {
        clearTimeout(timer);
        lines.off('line', line);
        child.off('exit', exit);
        child.off('error', failed);
        callback();
      };
      const line = (value: string) => {
        if (value !== 'ready') return;
        finish(resolveVisible);
      };
      const exit = () =>
        finish(() =>
          reject(
            new Error(
              `Computer Use control indicator exited during startup.${stderr ? ` ${stderr}` : ''}`
            )
          )
        );
      const failed = (error: Error) => finish(() => reject(error));
      child.stderr.on('data', (chunk: Buffer) => {
        stderr = `${stderr}${chunk.toString('utf8')}`.slice(-1_000).trim();
      });
      lines.on('line', line);
      child.once('exit', exit);
      child.once('error', failed);
    });
  } finally {
    lines.close();
  }
}

function indicatorEnvironment(): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const key of [
    'PATH',
    'SystemRoot',
    'WINDIR',
    'TEMP',
    'TMP',
    'TMPDIR',
    'HOME',
    'USERPROFILE',
    'DISPLAY',
    'XAUTHORITY',
    'LANG',
    'LC_ALL'
  ]) {
    const value = process.env[key];
    if (value !== undefined) environment[key] = value;
  }
  return environment;
}

const PYTHON_INDICATOR_SOURCE = String.raw`
import sys

COLOR = (235, 151, 55)
LABEL = "AI CONTROL"
THICKNESS = 3

def ready():
    sys.stdout.write("ready\n")
    sys.stdout.flush()

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    user32 = ctypes.windll.user32
    gdi32 = ctypes.windll.gdi32
    WNDPROC = ctypes.WINFUNCTYPE(
        ctypes.c_ssize_t, wintypes.HWND, wintypes.UINT, wintypes.WPARAM, wintypes.LPARAM
    )
    WM_PAINT = 0x000F
    WM_DESTROY = 0x0002
    WM_NCHITTEST = 0x0084
    HTTRANSPARENT = -1
    WS_POPUP = 0x80000000
    WS_EX_LAYERED = 0x00080000
    WS_EX_TRANSPARENT = 0x00000020
    WS_EX_TOOLWINDOW = 0x00000080
    WS_EX_NOACTIVATE = 0x08000000
    HWND_TOPMOST = -1
    SWP_NOACTIVATE = 0x0010
    SW_SHOWNA = 8
    RGN_OR = 2
    TRANSPARENT = 1
    DT_CENTER = 0x00000001
    DT_VCENTER = 0x00000004
    DT_SINGLELINE = 0x00000020

    class WNDCLASS(ctypes.Structure):
        _fields_ = [
            ("style", wintypes.UINT), ("lpfnWndProc", WNDPROC),
            ("cbClsExtra", ctypes.c_int), ("cbWndExtra", ctypes.c_int),
            ("hInstance", wintypes.HINSTANCE), ("hIcon", wintypes.HICON),
            ("hCursor", wintypes.HANDLE), ("hbrBackground", wintypes.HBRUSH),
            ("lpszMenuName", wintypes.LPCWSTR), ("lpszClassName", wintypes.LPCWSTR)
        ]

    class PAINTSTRUCT(ctypes.Structure):
        _fields_ = [
            ("hdc", wintypes.HDC), ("fErase", wintypes.BOOL),
            ("rcPaint", wintypes.RECT), ("fRestore", wintypes.BOOL),
            ("fIncUpdate", wintypes.BOOL), ("rgbReserved", ctypes.c_byte * 32)
        ]

    rgb = COLOR[0] | (COLOR[1] << 8) | (COLOR[2] << 16)
    brush = gdi32.CreateSolidBrush(rgb)
    dark_brush = gdi32.CreateSolidBrush(0x00251C12)

    @WNDPROC
    def window_proc(hwnd, message, wparam, lparam):
        if message == WM_PAINT:
            paint = PAINTSTRUCT()
            dc = user32.BeginPaint(hwnd, ctypes.byref(paint))
            rect = wintypes.RECT()
            user32.GetClientRect(hwnd, ctypes.byref(rect))
            user32.FillRect(dc, ctypes.byref(rect), brush)
            label = wintypes.RECT(rect.right - 130, 8, rect.right - 12, 34)
            user32.FillRect(dc, ctypes.byref(label), dark_brush)
            gdi32.SetBkMode(dc, TRANSPARENT)
            gdi32.SetTextColor(dc, rgb)
            user32.DrawTextW(dc, LABEL, -1, ctypes.byref(label), DT_CENTER | DT_VCENTER | DT_SINGLELINE)
            user32.EndPaint(hwnd, ctypes.byref(paint))
            return 0
        if message == WM_NCHITTEST:
            return HTTRANSPARENT
        if message == WM_DESTROY:
            user32.PostQuitMessage(0)
            return 0
        return user32.DefWindowProcW(hwnd, message, wparam, lparam)

    try:
        user32.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    except Exception:
        try:
            user32.SetProcessDPIAware()
        except Exception:
            pass
    instance = ctypes.windll.kernel32.GetModuleHandleW(None)
    class_name = "MyAgentRoamComputerUseIndicator"
    window_class = WNDCLASS(0, window_proc, 0, 0, instance, None, None, None, None, class_name)
    user32.RegisterClassW(ctypes.byref(window_class))
    width = user32.GetSystemMetrics(0)
    height = user32.GetSystemMetrics(1)
    hwnd = user32.CreateWindowExW(
        WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE,
        class_name, "", WS_POPUP, 0, 0, width, height, None, None, instance, None
    )
    if not hwnd:
        raise RuntimeError("cannot create the control indicator")
    user32.SetLayeredWindowAttributes(hwnd, 0, 220, 0x00000002)
    region = gdi32.CreateRectRgn(0, 0, width, THICKNESS)
    for x, y, right, bottom in (
        (0, height - THICKNESS, width, height),
        (0, 0, THICKNESS, height),
        (width - THICKNESS, 0, width, height),
        (width - 142, 6, width - 8, 38),
    ):
        part = gdi32.CreateRectRgn(x, y, right, bottom)
        gdi32.CombineRgn(region, region, part, RGN_OR)
        gdi32.DeleteObject(part)
    user32.SetWindowRgn(hwnd, region, True)
    user32.SetWindowPos(hwnd, HWND_TOPMOST, 0, 0, width, height, SWP_NOACTIVATE)
    user32.ShowWindow(hwnd, SW_SHOWNA)
    user32.UpdateWindow(hwnd)
    ready()
    message = wintypes.MSG()
    while user32.GetMessageW(ctypes.byref(message), None, 0, 0) > 0:
        user32.TranslateMessage(ctypes.byref(message))
        user32.DispatchMessageW(ctypes.byref(message))

elif sys.platform == "darwin":
    from AppKit import (
        NSApplication, NSApplicationActivationPolicyAccessory, NSBezierPath, NSColor,
        NSFont, NSFontAttributeName, NSForegroundColorAttributeName, NSMakeRect, NSPanel,
        NSScreen, NSStatusWindowLevel, NSView, NSWindowCollectionBehaviorCanJoinAllSpaces,
        NSWindowCollectionBehaviorFullScreenAuxiliary, NSWindowStyleMaskBorderless,
        NSWindowStyleMaskNonactivatingPanel
    )
    from Foundation import NSDictionary, NSString

    class IndicatorView(NSView):
        def drawRect_(self, rect):
            NSColor.clearColor().set()
            NSBezierPath.fillRect_(rect)
            color = NSColor.colorWithCalibratedRed_green_blue_alpha_(
                COLOR[0] / 255, COLOR[1] / 255, COLOR[2] / 255, 0.88
            )
            color.setStroke()
            path = NSBezierPath.bezierPathWithRect_(NSMakeRect(1.5, 1.5, rect.size.width - 3, rect.size.height - 3))
            path.setLineWidth_(THICKNESS)
            path.stroke()
            attributes = NSDictionary.dictionaryWithObjects_forKeys_(
                [NSFont.boldSystemFontOfSize_(12), color],
                [NSFontAttributeName, NSForegroundColorAttributeName]
            )
            NSString.stringWithString_(LABEL).drawAtPoint_withAttributes_(
                (rect.size.width - 94, rect.size.height - 27), attributes
            )

    application = NSApplication.sharedApplication()
    application.setActivationPolicy_(NSApplicationActivationPolicyAccessory)
    screen = NSScreen.mainScreen()
    frame = screen.frame()
    panel = NSPanel.alloc().initWithContentRect_styleMask_backing_defer_(
        frame, NSWindowStyleMaskBorderless | NSWindowStyleMaskNonactivatingPanel, 2, False
    )
    panel.setOpaque_(False)
    panel.setBackgroundColor_(NSColor.clearColor())
    panel.setHasShadow_(False)
    panel.setIgnoresMouseEvents_(True)
    panel.setLevel_(NSStatusWindowLevel)
    panel.setCollectionBehavior_(
        NSWindowCollectionBehaviorCanJoinAllSpaces |
        NSWindowCollectionBehaviorFullScreenAuxiliary
    )
    content_frame = NSMakeRect(0, 0, frame.size.width, frame.size.height)
    panel.setContentView_(IndicatorView.alloc().initWithFrame_(content_frame))
    panel.orderFrontRegardless()
    panel.displayIfNeeded()
    ready()
    application.run()

else:
    import ctypes
    import ctypes.util
    from Xlib import display as xdisplay

    x11_path = ctypes.util.find_library("X11")
    xext_path = ctypes.util.find_library("Xext")
    if not x11_path or not xext_path:
        raise RuntimeError("the X11 indicator libraries are unavailable")
    x11 = ctypes.cdll.LoadLibrary(x11_path)
    xext = ctypes.cdll.LoadLibrary(xext_path)
    x11.XOpenDisplay.argtypes = [ctypes.c_char_p]
    x11.XOpenDisplay.restype = ctypes.c_void_p
    x11.XDefaultScreen.argtypes = [ctypes.c_void_p]
    x11.XDefaultScreen.restype = ctypes.c_int
    x11.XRootWindow.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XRootWindow.restype = ctypes.c_ulong
    x11.XDefaultColormap.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDefaultColormap.restype = ctypes.c_ulong
    x11.XDisplayWidth.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayWidth.restype = ctypes.c_int
    x11.XDisplayHeight.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XDisplayHeight.restype = ctypes.c_int
    x11.XCreateSimpleWindow.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int,
        ctypes.c_uint, ctypes.c_uint, ctypes.c_uint, ctypes.c_ulong, ctypes.c_ulong
    ]
    x11.XCreateSimpleWindow.restype = ctypes.c_ulong
    x11.XCreateGC.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p]
    x11.XCreateGC.restype = ctypes.c_void_p
    x11.XAllocColor.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p]
    x11.XChangeWindowAttributes.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_ulong, ctypes.c_void_p
    ]
    x11.XMapRaised.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    x11.XSelectInput.argtypes = [ctypes.c_void_p, ctypes.c_ulong, ctypes.c_long]
    x11.XSetForeground.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_ulong]
    x11.XDrawString.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_void_p,
        ctypes.c_int, ctypes.c_int, ctypes.c_char_p, ctypes.c_int
    ]
    x11.XFlush.argtypes = [ctypes.c_void_p]
    x11.XSync.argtypes = [ctypes.c_void_p, ctypes.c_int]
    x11.XNextEvent.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    xext.XShapeQueryExtension.argtypes = [
        ctypes.c_void_p, ctypes.POINTER(ctypes.c_int), ctypes.POINTER(ctypes.c_int)
    ]
    xext.XShapeCombineRectangles.argtypes = [
        ctypes.c_void_p, ctypes.c_ulong, ctypes.c_int, ctypes.c_int, ctypes.c_int,
        ctypes.c_void_p, ctypes.c_int, ctypes.c_int, ctypes.c_int
    ]

    class XColor(ctypes.Structure):
        _fields_ = [
            ("pixel", ctypes.c_ulong), ("red", ctypes.c_ushort),
            ("green", ctypes.c_ushort), ("blue", ctypes.c_ushort),
            ("flags", ctypes.c_byte), ("pad", ctypes.c_byte)
        ]

    class XEvent(ctypes.Structure):
        _fields_ = [("type", ctypes.c_int), ("pad", ctypes.c_long * 23)]

    class XSetWindowAttributes(ctypes.Structure):
        _fields_ = [
            ("background_pixmap", ctypes.c_ulong), ("background_pixel", ctypes.c_ulong),
            ("border_pixmap", ctypes.c_ulong), ("border_pixel", ctypes.c_ulong),
            ("bit_gravity", ctypes.c_int), ("win_gravity", ctypes.c_int),
            ("backing_store", ctypes.c_int), ("backing_planes", ctypes.c_ulong),
            ("backing_pixel", ctypes.c_ulong), ("save_under", ctypes.c_int),
            ("event_mask", ctypes.c_long), ("do_not_propagate_mask", ctypes.c_long),
            ("override_redirect", ctypes.c_int), ("colormap", ctypes.c_ulong),
            ("cursor", ctypes.c_ulong)
        ]

    connection = x11.XOpenDisplay(None)
    if not connection:
        raise RuntimeError("cannot open the X11 display")
    shape_event = ctypes.c_int()
    shape_error = ctypes.c_int()
    if not xext.XShapeQueryExtension(
        connection, ctypes.byref(shape_event), ctypes.byref(shape_error)
    ):
        raise RuntimeError("the X11 Shape extension is unavailable")
    screen = x11.XDefaultScreen(connection)
    root = x11.XRootWindow(connection, screen)
    colormap = x11.XDefaultColormap(connection, screen)

    def allocate(red, green, blue):
        color = XColor(0, red * 257, green * 257, blue * 257, 0x07, 0)
        if not x11.XAllocColor(connection, colormap, ctypes.byref(color)):
            raise RuntimeError("cannot allocate the control indicator color")
        return color.pixel

    orange = allocate(*COLOR)
    dark = allocate(18, 28, 37)
    windows = []

    def create(x, y, width, height, background):
        window = x11.XCreateSimpleWindow(
            connection, root, x, y, width, height, 0, background, background
        )
        if not window:
            raise RuntimeError("cannot create the X11 control indicator")
        attributes = XSetWindowAttributes()
        attributes.override_redirect = 1
        x11.XChangeWindowAttributes(connection, window, 1 << 9, ctypes.byref(attributes))
        xext.XShapeCombineRectangles(
            connection, window, 2, 0, 0, None, 0, 0, 0
        )
        x11.XMapRaised(connection, window)
        windows.append(window)
        return window

    origin_x = 0
    origin_y = 0
    width = x11.XDisplayWidth(connection, screen)
    height = x11.XDisplayHeight(connection, screen)
    geometry_connection = xdisplay.Display()
    try:
        try:
            geometry_root = geometry_connection.screen().root
            primary = geometry_root.xrandr_get_output_primary().output
            if primary:
                resources = geometry_root.xrandr_get_screen_resources_current()
                output = geometry_connection.xrandr_get_output_info(
                    primary, resources.config_timestamp
                )
                if output.crtc:
                    crtc = geometry_connection.xrandr_get_crtc_info(
                        output.crtc, resources.config_timestamp
                    )
                    origin_x, origin_y = crtc.x, crtc.y
                    width, height = crtc.width, crtc.height
        except Exception:
            pass
    finally:
        geometry_connection.close()
    create(origin_x, origin_y, width, THICKNESS, orange)
    create(origin_x, origin_y + height - THICKNESS, width, THICKNESS, orange)
    create(origin_x, origin_y, THICKNESS, height, orange)
    create(origin_x + width - THICKNESS, origin_y, THICKNESS, height, orange)
    label = create(origin_x + width - 128, origin_y + 10, 116, 26, dark)
    exposure_mask = 1 << 15
    x11.XSelectInput(connection, label, exposure_mask)
    gc = x11.XCreateGC(connection, label, 0, None)
    x11.XSetForeground(connection, gc, orange)
    label_bytes = LABEL.encode("ascii")

    def draw_label():
        x11.XDrawString(connection, label, gc, 18, 17, label_bytes, len(label_bytes))
        x11.XFlush(connection)

    draw_label()
    x11.XSync(connection, False)
    ready()
    event = XEvent()
    while True:
        x11.XNextEvent(connection, ctypes.byref(event))
        if event.type == 12:
            draw_label()
`;
