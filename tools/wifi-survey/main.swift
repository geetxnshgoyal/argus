import AppKit
import CoreLocation
import CoreWLAN

// Argus Wi-Fi survey (ADR-0030): lists the Wi-Fi routers around this Mac with their
// IDs. macOS only reveals router IDs to apps with Location permission, hence an app.
// Scans three times a few seconds apart and writes wifi-scan.tsv next to the app.
final class Scanner: NSObject, CLLocationManagerDelegate {
  let lm = CLLocationManager()
  let out: URL
  var done = false
  init(out: URL) { self.out = out; super.init(); lm.delegate = self }
  func start() {
    if lm.authorizationStatus == .notDetermined { lm.requestWhenInUseAuthorization() } else { scan() }
  }
  func locationManagerDidChangeAuthorization(_ m: CLLocationManager) {
    if m.authorizationStatus != .notDetermined { scan() }
  }
  func scan() {
    guard !done else { return }
    done = true
    var lines = ["# auth=\(lm.authorizationStatus.rawValue)"]
    guard let iface = CWWiFiClient.shared().interface() else { finish(["no wifi interface"]); return }
    lines.append("# connected\t\(iface.ssid() ?? "<hidden>")\t\(iface.bssid() ?? "<hidden>")\t\(iface.rssiValue()) dBm")
    var seen: [String: (ssid: String, rssi: Int, ch: Int)] = [:]
    for i in 0..<3 {
      if let nets = try? iface.scanForNetworks(withSSID: nil) {
        for n in nets {
          let key = n.bssid ?? "<hidden>-\(n.hashValue)"
          seen[key] = (n.ssid ?? "<hidden>", max(seen[key]?.rssi ?? -200, n.rssiValue), n.wlanChannel?.channelNumber ?? 0)
        }
      }
      if i < 2 { Thread.sleep(forTimeInterval: 4) }
    }
    for (b, v) in seen.sorted(by: { $0.value.rssi > $1.value.rssi }) { lines.append("\(v.ssid)\t\(b)\t\(v.rssi) dBm\tch \(v.ch)") }
    finish(lines)
  }
  func finish(_ lines: [String]) {
    try? lines.joined(separator: "\n").write(to: out, atomically: true, encoding: .utf8)
    NSApp.terminate(nil)
  }
}

let app = NSApplication.shared
app.setActivationPolicy(.accessory)
let s = Scanner(out: Bundle.main.bundleURL.deletingLastPathComponent().appendingPathComponent("wifi-scan.tsv"))
DispatchQueue.main.async { s.start() }
DispatchQueue.main.asyncAfter(deadline: .now() + 90) { s.scan() }
app.run()
