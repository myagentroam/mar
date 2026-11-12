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
        let diagnostic = "keyDown code=\(event.keyCode) flags=\(event.modifierFlags.rawValue)\n"
        FileHandle.standardError.write(Data(diagnostic.utf8))
        if event.keyCode == 1, event.modifierFlags.contains([.control, .shift]),
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_CTRL_SHIFT_RECEIPT"] {
            try? "ctrl-shift-s\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        if event.keyCode == 1, event.modifierFlags.contains(.option),
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_OPTION_S_RECEIPT"] {
            try? "option-s\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        if event.keyCode == 1,
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_S_DOWN_RECEIPT"] {
            try? "s-down\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        guard event.charactersIgnoringModifiers == "a",
              let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_KEY_RECEIPT"] else { return }
        try? "key-a\n".write(toFile: path, atomically: true, encoding: .utf8)
    }

    override func flagsChanged(with event: NSEvent) {
        if event.keyCode == 58, event.modifierFlags.contains(.option),
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_OPTION_RECEIPT"] {
            try? "option-58\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
        if event.keyCode == 54, event.modifierFlags.contains(.command),
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_COMMAND_RECEIPT"] {
            try? "command-54\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
    }

    override func mouseDown(with event: NSEvent) {
        guard let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_MOUSE_RECEIPT"] else { return }
        try? "mouse-down\n".write(toFile: path, atomically: true, encoding: .utf8)
    }

    override func keyUp(with event: NSEvent) {
        if event.keyCode == 1,
           let path = ProcessInfo.processInfo.environment["MAR_DESKTOP_S_UP_RECEIPT"] {
            try? "s-up\n".write(toFile: path, atomically: true, encoding: .utf8)
        }
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
