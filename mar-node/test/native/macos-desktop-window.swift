import AppKit

final class ProbeWindow: NSWindow {
    override var canBecomeKey: Bool { true }
}

// An isolated runner window gives the RFB probe observable pixels and input.
final class ProbeView: NSView {
    override var acceptsFirstResponder: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        NSColor.red.setFill()
        bounds.fill()
    }

    override func keyDown(with event: NSEvent) {
        guard event.charactersIgnoringModifiers == "a",
              let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_KEY_RECEIPT"] else { return }
        try? "key-a\n".write(toFile: path, atomically: true, encoding: .utf8)
    }

    override func mouseDown(with event: NSEvent) {
        guard let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_MOUSE_RECEIPT"] else { return }
        try? "mouse-down\n".write(toFile: path, atomically: true, encoding: .utf8)
    }

    override func keyUp(with event: NSEvent) {
        guard event.charactersIgnoringModifiers?.lowercased() == "a",
              let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_KEY_UP_RECEIPT"] else { return }
        try? "key-up\n".write(toFile: path, atomically: true, encoding: .utf8)
    }

    override func mouseUp(with event: NSEvent) {
        guard let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_MOUSE_UP_RECEIPT"] else { return }
        try? "mouse-up\n".write(toFile: path, atomically: true, encoding: .utf8)
    }
}

let app = NSApplication.shared
app.setActivationPolicy(.regular)
guard let screen = NSScreen.main else { fatalError("No macOS display available") }
let window = ProbeWindow(contentRect: screen.visibleFrame, styleMask: [.borderless],
                         backing: .buffered, defer: false)
window.contentView = ProbeView(frame: window.contentView!.bounds)
window.makeKeyAndOrderFront(nil)
window.makeFirstResponder(window.contentView)
app.activate(ignoringOtherApps: true)
app.run()
