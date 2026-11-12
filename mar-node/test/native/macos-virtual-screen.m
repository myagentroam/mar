// Test-only virtual display on disposable GitHub runners. Not included in the product.
// The CoreGraphics test interfaces are also used by Chromium's display tests.
#import <AppKit/AppKit.h>
#import <CoreGraphics/CoreGraphics.h>

@interface CGVirtualDisplayDescriptor : NSObject
@property(nonatomic, copy) NSString *name;
@property(nonatomic) unsigned int maxPixelsWide, maxPixelsHigh, vendorID, productID, serialNum;
@property(nonatomic) CGSize sizeInMillimeters;
@property(nonatomic) CGPoint redPrimary, greenPrimary, bluePrimary, whitePoint;
@property(nonatomic, strong) dispatch_queue_t queue;
@end
@interface CGVirtualDisplayMode : NSObject
- (instancetype)initWithWidth:(unsigned int)width height:(unsigned int)height refreshRate:(double)rate;
@end
@interface CGVirtualDisplaySettings : NSObject
@property(nonatomic) unsigned int hiDPI;
@property(nonatomic, copy) NSArray *modes;
@end
@interface CGVirtualDisplay : NSObject
- (instancetype)initWithDescriptor:(CGVirtualDisplayDescriptor *)descriptor;
- (BOOL)applySettings:(CGVirtualDisplaySettings *)settings;
@property(nonatomic, readonly) CGDirectDisplayID displayID;
@end

@interface TestWindow : NSWindow
@end
@implementation TestWindow
- (BOOL)canBecomeKeyWindow { return YES; }
@end
@interface TestView : NSView
@end
@implementation TestView
- (void)drawRect:(NSRect)rect { [[NSColor greenColor] setFill]; NSRectFill(self.bounds); }
- (void)mouseDown:(NSEvent *)event {
    NSString *path = NSProcessInfo.processInfo.environment[@"MAR_MULTISCREEN_CLICK"];
    [@"clicked\n" writeToFile:path atomically:YES encoding:NSUTF8StringEncoding error:nil];
}
@end

int main(void) {
    @autoreleasepool {
        NSApplication *app = NSApplication.sharedApplication;
        [app setActivationPolicy:NSApplicationActivationPolicyRegular];
        Class descriptorClass = NSClassFromString(@"CGVirtualDisplayDescriptor");
        Class displayClass = NSClassFromString(@"CGVirtualDisplay");
        Class settingsClass = NSClassFromString(@"CGVirtualDisplaySettings");
        Class modeClass = NSClassFromString(@"CGVirtualDisplayMode");
        if (!descriptorClass || !displayClass || !settingsClass || !modeClass) return 2;
        CGVirtualDisplayDescriptor *descriptor = [[descriptorClass alloc] init];
        descriptor.name = @"MAR isolated test display";
        descriptor.maxPixelsWide = 640;
        descriptor.maxPixelsHigh = 480;
        descriptor.sizeInMillimeters = CGSizeMake(169, 127);
        descriptor.vendorID = 0x4d41;
        descriptor.productID = 0x5201;
        descriptor.serialNum = 1;
        descriptor.queue = dispatch_get_global_queue(DISPATCH_QUEUE_PRIORITY_HIGH, 0);
        descriptor.whitePoint = CGPointMake(0.3125, 0.3291);
        descriptor.redPrimary = CGPointMake(0.6797, 0.3203);
        descriptor.greenPrimary = CGPointMake(0.2559, 0.6983);
        descriptor.bluePrimary = CGPointMake(0.1494, 0.0557);
        CGVirtualDisplay *display = [[displayClass alloc] initWithDescriptor:descriptor];
        CGVirtualDisplayMode *mode = [[modeClass alloc] initWithWidth:640 height:480 refreshRate:60];
        CGVirtualDisplaySettings *settings = [[settingsClass alloc] init];
        settings.hiDPI = 0;
        settings.modes = @[mode];
        if (!display || ![display applySettings:settings]) return 3;
        CGDisplayConfigRef config;
        CGRect primary = CGDisplayBounds(CGMainDisplayID());
        if (CGBeginDisplayConfiguration(&config) != kCGErrorSuccess) return 4;
        if (CGConfigureDisplayOrigin(config, display.displayID, (int)primary.origin.x - 640,
                                     (int)primary.origin.y) != kCGErrorSuccess) return 5;
        if (CGCompleteDisplayConfiguration(config, kCGConfigureForSession) != kCGErrorSuccess) return 6;
        NSScreen *target = nil;
        for (int attempt = 0; attempt < 100 && !target; attempt++) {
            for (NSScreen *screen in NSScreen.screens)
                if ([screen.deviceDescription[@"NSScreenNumber"] unsignedIntValue] == display.displayID)
                    target = screen;
            if (!target) [[NSRunLoop currentRunLoop] runUntilDate:[NSDate dateWithTimeIntervalSinceNow:0.1]];
        }
        if (!target) return 7;
        TestWindow *window = [[TestWindow alloc] initWithContentRect:target.frame
            styleMask:NSWindowStyleMaskBorderless backing:NSBackingStoreBuffered defer:NO];
        window.contentView = [[TestView alloc] initWithFrame:window.contentView.bounds];
        [window makeKeyAndOrderFront:nil];
        [app activateIgnoringOtherApps:YES];
        printf("READY %u\n", display.displayID);
        fflush(stdout);
        [app run];
        return 0;
    }
}
