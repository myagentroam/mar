#include <ApplicationServices/ApplicationServices.h>
#include <stdio.h>

/* Reports actual active displays; macVNC currently captures the primary one. */
int main(void) {
  CGDirectDisplayID displays[32];
  uint32_t count = 0;
  if (CGGetActiveDisplayList(32, displays, &count) != kCGErrorSuccess || count == 0)
    return 1;
  printf("{\"displays\":[");
  for (uint32_t i = 0; i < count; i++) {
    CGRect bounds = CGDisplayBounds(displays[i]);
    printf("%s{\"id\":%u,\"primary\":%s,\"x\":%.0f,\"y\":%.0f,"
           "\"width\":%.0f,\"height\":%.0f,\"pixelWidth\":%zu,\"pixelHeight\":%zu}",
           i ? "," : "", displays[i], CGDisplayIsMain(displays[i]) ? "true" : "false",
           bounds.origin.x, bounds.origin.y, bounds.size.width, bounds.size.height,
           CGDisplayPixelsWide(displays[i]), CGDisplayPixelsHigh(displays[i]));
  }
  puts("]}");
  return 0;
}
