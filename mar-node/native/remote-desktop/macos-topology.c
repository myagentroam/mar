#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>
#include <string.h>

/* Invalidate before and after reconfiguration; snapshots are queried separately. */
static void display_changed(CGDirectDisplayID display,
                            CGDisplayChangeSummaryFlags flags, void *context) {
  (void)display;
  (void)flags;
  (void)context;
  puts("invalidated");
  fflush(stdout);
}

/* Reports the active displays captured by the managed macVNC backend. */
int main(int argc, char **argv) {
  if (argc == 2 && strcmp(argv[1], "--watch") == 0) {
    if (CGDisplayRegisterReconfigurationCallback(display_changed, NULL) !=
        kCGErrorSuccess)
      return 1;
    puts("ready");
    fflush(stdout);
    CFRunLoopRun();
    CGDisplayRemoveReconfigurationCallback(display_changed, NULL);
    return 0;
  }
  if (argc != 1) return 2;
  CGDirectDisplayID displays[32];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess || count == 0)
    return 1;
  printf("{\"displays\":[");
  for (uint32_t i = 0; i < count; i++) {
    CGRect bounds = CGDisplayBounds(displays[i]);
    printf("%s{\"id\":%u,\"primary\":%s,\"x\":%.6f,\"y\":%.6f,"
           "\"width\":%.6f,\"height\":%.6f,\"pixelWidth\":%zu,\"pixelHeight\":%zu}",
           i ? "," : "", displays[i], CGDisplayIsMain(displays[i]) ? "true" : "false",
           bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height,
           CGDisplayPixelsWide(displays[i]), CGDisplayPixelsHigh(displays[i]));
  }
  puts("]}");
  return 0;
}
