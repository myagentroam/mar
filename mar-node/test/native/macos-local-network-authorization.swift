import AppKit
import ApplicationServices
import Network

// CI-only consent preflight. Never changes TCC databases or system-wide policy.
// Only the isolated hosted runner and its test browser may receive network consent.
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

func approveRunnerNetworkAlert() -> Bool {
    guard AXIsProcessTrusted() else { return false }
    for application in NSWorkspace.shared.runningApplications {
        guard application.bundleIdentifier?.hasPrefix("com.apple.") == true else { continue }
        let element = AXUIElementCreateApplication(application.processIdentifier)
        let windows = attribute(element, kAXWindowsAttribute) as? [AXUIElement] ?? []
        for window in windows {
            var pending = [window]
            var elements: [AXUIElement] = []
            while let next = pending.popLast(), elements.count < 512 {
                elements.append(next)
                pending.append(contentsOf: attribute(next, kAXChildrenAttribute) as? [AXUIElement] ?? [])
            }
            let text = elements.flatMap { item in
                [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].compactMap {
                    attribute(item, $0) as? String
                }
            }.joined(separator: " ").lowercased()
            guard text.contains("local network"), text.contains("find devices"),
                  ["hosted-compute", "chromium", "chrome for testing"].contains(where: text.contains)
            else { continue }
            let buttons = elements.filter {
                attribute($0, kAXRoleAttribute) as? String == kAXButtonRole &&
                attribute($0, kAXTitleAttribute) as? String == "Allow"
            }
            guard buttons.count == 1,
                  AXUIElementPerformAction(buttons[0], kAXPressAction as CFString) == .success
            else { continue }
            print("CI_LOCAL_NETWORK_CONSENT_GRANTED")
            return true
        }
    }
    return false
}

guard CommandLine.arguments.count == 2 else {
    fatalError("A local-subnet probe address is required")
}
// Connecting a UDP socket requests access without sending any datagram.
let connection = NWConnection(host: NWEndpoint.Host(CommandLine.arguments[1]), port: 9, using: .udp)
var ready = false
var failure: String?
connection.stateUpdateHandler = { state in
    switch state {
    case .ready: ready = true
    case .failed(let error): failure = String(describing: error)
    default: break
    }
}
connection.start(queue: .main)
let deadline = Date().addingTimeInterval(30)
while Date() < deadline, failure == nil {
    let approved = approveRunnerNetworkAlert()
    if ready && !approved {
        print("CI_LOCAL_NETWORK_ACCESS_READY")
        connection.cancel()
        exit(0)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
}
connection.cancel()
let reason = failure ?? (AXIsProcessTrusted() ? "consent was not granted" : "CI accessibility approval is unavailable")
FileHandle.standardError.write(Data("CI_LOCAL_NETWORK_NOT_AUTHORIZED: \(reason)\n".utf8))
exit(1)
