import AppKit
import ApplicationServices
import Network

// CI-only consent preflight. Never changes TCC databases or system-wide policy.
// Only the isolated hosted runner and its test browser may receive network consent.
func attribute(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
    var value: CFTypeRef?
    return AXUIElementCopyAttributeValue(element, name as CFString, &value) == .success ? value : nil
}

var observedConsentAlerts = Set<String>()
let runnerNames = ["hosted-compute", "chromium", "chrome for testing", "runner.worker", "runner.listener", "node"]

func descendants(_ element: AXUIElement) -> [AXUIElement] {
    var pending = [element]
    var result: [AXUIElement] = []
    while let next = pending.popLast(), result.count < 512 {
        result.append(next)
        pending.append(contentsOf: attribute(next, kAXChildrenAttribute) as? [AXUIElement] ?? [])
    }
    return result
}

func labels(_ elements: [AXUIElement]) -> String {
    elements.flatMap { item in
        [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].compactMap {
            attribute(item, $0) as? String
        }
    }.joined(separator: " ").lowercased()
}

// A previously denied runner has no new alert. Use only its visible per-app switch.
func approveRunnerNetworkSettings() {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true", AXIsProcessTrusted(),
          let app = NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first
    else { return }
    let root = AXUIElementCreateApplication(app.processIdentifier)
    for window in attribute(root, kAXWindowsAttribute) as? [AXUIElement] ?? [] {
        let all = descendants(window)
        guard labels(all).contains("local network") else { continue }
        if labels(all).contains("control which apps can access your data") {
            let links = all.filter { item in
                [kAXTitleAttribute, kAXDescriptionAttribute].contains {
                    let name = (attribute(item, $0) as? String)?.lowercased() ?? ""
                    return name == "local network" || name.hasPrefix("local network,")
                }
            }
            if let link = links.first,
               AXUIElementPerformAction(link, kAXPressAction as CFString) == .success {
                print("CI_LOCAL_NETWORK_SETTINGS_OPENED")
            }
            return
        }
        for row in all.reversed() {
            let elements = descendants(row)
            let text = labels(elements)
            guard runnerNames.contains(where: { name in
                elements.contains { item in
                    [kAXValueAttribute, kAXTitleAttribute, kAXDescriptionAttribute].contains {
                        (attribute(item, $0) as? String)?.lowercased() == name ||
                        (attribute(item, $0) as? String)?.lowercased().hasPrefix("hosted-compute-") == true
                    }
                }
            }) else { continue }
            let switches = elements.filter {
                ["AXCheckBox", "AXSwitch"].contains(attribute($0, kAXRoleAttribute) as? String ?? "")
            }
            guard switches.count == 1,
                  (attribute(switches[0], kAXValueAttribute) as? NSNumber)?.intValue == 0,
                  AXUIElementPerformAction(switches[0], kAXPressAction as CFString) == .success
            else { continue }
            print("CI_LOCAL_NETWORK_SETTINGS_GRANTED: \(text.prefix(160))")
        }
        if observedConsentAlerts.insert("settings").inserted {
            print("CI_LOCAL_NETWORK_SETTINGS_VISIBLE: \(labels(all).prefix(2000))")
        }
    }
}

func approveRunnerNetworkAlert() -> Bool {
    guard ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true",
          AXIsProcessTrusted() else { return false }
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
            guard text.contains("local network"), text.contains("find devices") else { continue }
            if observedConsentAlerts.insert(text).inserted {
                print("CI_LOCAL_NETWORK_CONSENT_ALERT: \(text.prefix(240))")
            }
            guard ["hosted-compute", "chromium", "chrome for testing", "runner.worker", "runner.listener", "\"node\"", "“node”"]
                .contains(where: text.contains) else { continue }
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
var openedSettings = false
while Date() < deadline, failure == nil {
    let approved = approveRunnerNetworkAlert()
    if !ready, connection.currentPath?.unsatisfiedReason == .localNetworkDenied,
       ProcessInfo.processInfo.environment["GITHUB_ACTIONS"] == "true" {
        if !openedSettings {
            openedSettings = NSWorkspace.shared.open(URL(string: "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork")!)
        }
        approveRunnerNetworkSettings()
    }
    if ready && !approved {
        if openedSettings {
            NSRunningApplication.runningApplications(withBundleIdentifier: "com.apple.systempreferences").first?.terminate()
        }
        print("CI_LOCAL_NETWORK_ACCESS_READY")
        connection.cancel()
        exit(0)
    }
    RunLoop.main.run(until: Date().addingTimeInterval(0.1))
}
let reason = failure ?? "state=\(connection.state), path=\(String(describing: connection.currentPath?.unsatisfiedReason)), accessibility=\(AXIsProcessTrusted())"
connection.cancel()
FileHandle.standardError.write(Data("CI_LOCAL_NETWORK_NOT_AUTHORIZED: \(reason)\n".utf8))
exit(1)
