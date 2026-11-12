/*
 * Read-only XRandR topology source for an existing X11 session. It emits an
 * initial snapshot and invalidation notifications, and exits on owner EOF.
 * It neither starts a desktop/backend nor asserts that the session is unlocked.
 */
#include <X11/Xlib.h>
#include <X11/extensions/Xrandr.h>
#include <errno.h>
#include <poll.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>

#define MAX_MONITORS 64
#define MAX_OUTPUTS 64
#define MAX_NAME 256

static int valid_utf8(const char *value, size_t length) {
  for (size_t i = 0; i < length;) {
    unsigned char c = (unsigned char)value[i++];
    if (c < 0x80) continue;
    int remaining = c >= 0xc2 && c <= 0xdf ? 1 : c >= 0xe0 && c <= 0xef ? 2 :
                    c >= 0xf0 && c <= 0xf4 ? 3 : -1;
    if (remaining < 0 || i + (size_t)remaining > length) return 0;
    unsigned char next = (unsigned char)value[i];
    if ((c == 0xe0 && next < 0xa0) || (c == 0xed && next >= 0xa0) ||
        (c == 0xf0 && next < 0x90) || (c == 0xf4 && next >= 0x90)) return 0;
    for (int j = 0; j < remaining; j++)
      if (((unsigned char)value[i++] & 0xc0) != 0x80) return 0;
  }
  return 1;
}

static int json_string(const char *value, size_t length) {
  if (length > MAX_NAME || !valid_utf8(value, length)) return 0;
  putchar('"');
  for (size_t i = 0; i < length; i++) {
    unsigned char c = (unsigned char)value[i];
    if (c == '"' || c == '\\') { putchar('\\'); putchar(c); }
    else if (c < 0x20) printf("\\u%04x", c);
    else putchar(c);
  }
  putchar('"');
  return 1;
}

static int snapshot(Display *display, Window root) {
  XWindowAttributes root_attributes;
  if (!XGetWindowAttributes(display, root, &root_attributes)) return 0;
  XRRScreenResources *resources = XRRGetScreenResourcesCurrent(display, root);
  if (!resources) return 0;
  int count = 0;
  XRRMonitorInfo *monitors = XRRGetMonitors(display, root, True, &count);
  if (!monitors || count < 1 || count > MAX_MONITORS) {
    if (monitors) XRRFreeMonitors(monitors);
    XRRFreeScreenResources(resources);
    return 0;
  }
  printf("{\"type\":\"snapshot\",\"width\":%d,\"height\":%d,\"monitors\":[",
         root_attributes.width, root_attributes.height);
  int valid = 1;
  for (int i = 0; i < count && valid; i++) {
    XRRMonitorInfo *m = &monitors[i];
    char *name = XGetAtomName(display, m->name);
    if (!name || m->noutput < 1 || m->noutput > MAX_OUTPUTS || m->width < 1 || m->height < 1) {
      if (name) XFree(name);
      valid = 0;
      break;
    }
    if (i) putchar(',');
    printf("{\"id\":%lu,\"name\":", m->name);
    size_t length = 0;
    while (length <= MAX_NAME && name[length]) length++;
    valid = json_string(name, length);
    XFree(name);
    if (!valid) break;
    printf(",\"primary\":%s,\"x\":%d,\"y\":%d,\"width\":%d,\"height\":%d,\"mmWidth\":%d,\"mmHeight\":%d,\"outputs\":[",
           m->primary ? "true" : "false", m->x, m->y, m->width, m->height, m->mwidth, m->mheight);
    for (int j = 0; j < m->noutput && valid; j++) {
      XRROutputInfo *output = XRRGetOutputInfo(display, resources, m->outputs[j]);
      if (!output || output->connection != RR_Connected || !output->crtc || output->nameLen < 0) {
        if (output) XRRFreeOutputInfo(output);
        valid = 0;
        break;
      }
      XRRCrtcInfo *crtc = XRRGetCrtcInfo(display, resources, output->crtc);
      XRRCrtcTransformAttributes *transform = NULL;
      if (!crtc || !XRRGetCrtcTransform(display, output->crtc, &transform) || !transform) {
        if (crtc) XRRFreeCrtcInfo(crtc);
        XRRFreeOutputInfo(output);
        valid = 0;
        break;
      }
      if (j) putchar(',');
      printf("{\"id\":%lu,\"name\":", m->outputs[j]);
      valid = json_string(output->name, (size_t)output->nameLen);
      if (valid) {
        printf(",\"x\":%d,\"y\":%d,\"width\":%u,\"height\":%u,\"rotation\":%u,\"transform\":[",
               crtc->x, crtc->y, crtc->width, crtc->height, crtc->rotation);
        for (int row = 0; row < 3; row++) for (int col = 0; col < 3; col++) {
          if (row || col) putchar(',');
          printf("%d", transform->currentTransform.matrix[row][col]);
        }
        printf("]}");
      }
      XFree(transform);
      XRRFreeCrtcInfo(crtc);
      XRRFreeOutputInfo(output);
    }
    printf("]}");
  }
  XRRFreeMonitors(monitors);
  XRRFreeScreenResources(resources);
  if (!valid) return 0;
  printf("]}\n");
  return fflush(stdout) == 0;
}

int main(void) {
  Display *display = XOpenDisplay(NULL);
  if (!display) return 1;
  int event_base, error_base, major = 0, minor = 0;
  if (!XRRQueryExtension(display, &event_base, &error_base) ||
      !XRRQueryVersion(display, &major, &minor) || major < 1 || (major == 1 && minor < 5)) {
    XCloseDisplay(display);
    return 1;
  }
  Window root = DefaultRootWindow(display);
  Atom edid = XInternAtom(display, "EDID", True);
  XRRSelectInput(display, root, RRScreenChangeNotifyMask | RRCrtcChangeNotifyMask |
                 RROutputChangeNotifyMask | RROutputPropertyNotifyMask | RRResourceChangeNotifyMask);
  XSync(display, False);
  if (!snapshot(display, root)) { XCloseDisplay(display); return 1; }
  struct pollfd fds[2] = {{ConnectionNumber(display), POLLIN, 0}, {STDIN_FILENO, POLLIN, 0}};
  for (;;) {
    while (XPending(display)) {
      XEvent event;
      XNextEvent(display, &event);
      if (event.type == event_base + RRScreenChangeNotify || event.type == event_base + RRNotify) {
        RROutput reset_output = None;
        int reset_all = 0;
        if (event.type == event_base + RRNotify) {
          XRRNotifyEvent *notice = (XRRNotifyEvent *)&event;
          if (notice->subtype == RRNotify_OutputChange) {
            XRROutputChangeNotifyEvent *change = (XRROutputChangeNotifyEvent *)&event;
            if (change->connection != RR_Connected) reset_output = change->output;
          } else if (notice->subtype == RRNotify_OutputProperty) {
            XRROutputPropertyNotifyEvent *change = (XRROutputPropertyNotifyEvent *)&event;
            if (edid == None) edid = XInternAtom(display, "EDID", True);
            if (edid != None && change->property == edid) reset_output = change->output;
          } else if (notice->subtype == RRNotify_ResourceChange) {
            reset_all = 1;
          }
        }
        int written = reset_all ? printf("{\"type\":\"invalidated\",\"resetAll\":true}\n")
          : reset_output == None ? printf("{\"type\":\"invalidated\"}\n")
          : printf("{\"type\":\"invalidated\",\"resetOutput\":%lu}\n", reset_output);
        if (written < 0 || fflush(stdout)) {
          XCloseDisplay(display);
          return 1;
        }
        XRRUpdateConfiguration(&event);
        if (!snapshot(display, root)) { XCloseDisplay(display); return 1; }
      }
    }
    int result = poll(fds, 2, -1);
    if (result < 0 && errno == EINTR) continue;
    if (result < 0 || (fds[0].revents & (POLLERR | POLLHUP | POLLNVAL)) || fds[1].revents) break;
  }
  XCloseDisplay(display);
  return 0;
}
