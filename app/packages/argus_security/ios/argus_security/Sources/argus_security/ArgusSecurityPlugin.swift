import CoreLocation
import CryptoKit
import DeviceCheck
import Flutter
import LocalAuthentication
import Security
import UIKit

/// Argus native security module (iOS). No third-party Flutter plugins for keys or attestation (spec §2).
///
///  Session key (ADR-0008): Secure Enclave P-256, no user presence. Proves refreshes come from this phone.
///  Attempt key (ADR-0008): Secure Enclave P-256 that needs Face ID / Touch ID / passcode for every
///    signature. Signs attendance attempts.
///  App Attest: attests an app key at registration and signs an assertion per attempt, bound to
///    SHA-256 of the payload (ADR-0011). DeviceCheck marks the physical phone (ADR-0009).
///  Location: one fresh precise fix per scan, flags software-simulated locations; never in the background.
public class ArgusSecurityPlugin: NSObject, FlutterPlugin, CLLocationManagerDelegate {
  static let channelName = "argus/security"
  static let sessionAccount = "argus_session_v1"
  static let attemptAccount = "argus_attempt_v1"
  static let appAttestAccount = "argus_appattest_v1"

  private var locationManager: CLLocationManager?
  private var locationResult: FlutterResult?
  private var locationTimer: Timer?
  private var goodEnoughTimer: Timer?
  private var locationRequestedAt = Date()
  private var bestFix: CLLocation?

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(ArgusSecurityPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let args = call.arguments as? [String: Any] ?? [:]
    do {
      switch call.method {
      case "platformInfo":
        result([
          "platform": "ios",
          "osVersion": UIDevice.current.systemVersion,
          "model": UIDevice.current.model,
          // False on the simulator; true on every supported iPhone.
          "hardwareKeyStore": SecureEnclave.isAvailable,
          "screenLock": LAContext().canEvaluatePolicy(.deviceOwnerAuthentication, error: nil),
          "appAttest": DCAppAttestService.shared.isSupported,
        ])
      case "sessionPublicKey":
        result(b64url(try sessionKey().publicKey.derRepresentation))
      case "signWithSessionKey":
        guard let data = args["data"] as? FlutterStandardTypedData else { return result(badArgs("data")) }
        result(b64url(try sessionKey().sign(data.data).derRepresentation))
      case "resetSessionKey":
        deleteKeychain(Self.sessionAccount)
        result(nil)
      case "createAttemptKey":
        result(["publicKey": b64url(try createAttemptKey().publicKey.derRepresentation), "chain": [String]()])
      case "attemptPublicKey":
        result(try attemptKey().map { b64url($0.publicKey.derRepresentation) })
      case "signWithAttemptKey":
        guard let data = args["data"] as? FlutterStandardTypedData else { return result(badArgs("data")) }
        let reason = args["reason"] as? String ?? "Confirm it's you"
        signWithAttempt(data.data, reason: reason, result: result)
      case "unlockAttemptKey":
        // iOS asks at every signature; nothing to unlock ahead of time.
        result(true)
      case "resetAttemptKey":
        deleteKeychain(Self.attemptAccount)
        deleteKeychain(Self.appAttestAccount)
        result(nil)
      case "appAttestKey":
        appAttestKey(clientDataHash: (args["clientDataHash"] as? FlutterStandardTypedData)?.data, result: result)
      case "appAttestAssertion":
        guard let hash = args["clientDataHash"] as? FlutterStandardTypedData else { return result(badArgs("clientDataHash")) }
        appAttestAssertion(clientDataHash: hash.data, result: result)
      case "deviceCheckToken":
        guard DCDevice.current.isSupported else { return result(nil) }
        DCDevice.current.generateToken { token, _ in
          DispatchQueue.main.async { result(token?.base64EncodedString()) }
        }
      case "locationFix":
        locationFix(timeoutMs: args["timeoutMs"] as? Int ?? 10000, result: result)
      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      result(FlutterError(code: "keystore_error", message: error.localizedDescription, details: nil))
    }
  }

  private func badArgs(_ what: String) -> FlutterError {
    FlutterError(code: "bad_args", message: "\(what) missing", details: nil)
  }

  // ── Keys ──────────────────────────────────────────────────────────────────

  /// A signer abstracting the Secure Enclave (devices) and a software key (simulator only).
  struct Signer {
    let publicKey: P256.Signing.PublicKey
    let signFn: (Data) throws -> P256.Signing.ECDSASignature
    func sign(_ data: Data) throws -> P256.Signing.ECDSASignature { try signFn(data) }
  }

  private func sessionKey() throws -> Signer {
    if SecureEnclave.isAvailable {
      let key: SecureEnclave.P256.Signing.PrivateKey
      if let stored = readKeychain(Self.sessionAccount) {
        key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored)
      } else {
        key = try SecureEnclave.P256.Signing.PrivateKey()
        try writeKeychain(Self.sessionAccount, key.dataRepresentation)
      }
      return Signer(publicKey: key.publicKey, signFn: { try key.signature(for: $0) })
    }
    return try simulatorKey(Self.sessionAccount)
  }

  private func createAttemptKey() throws -> Signer {
    deleteKeychain(Self.attemptAccount)
    if SecureEnclave.isAvailable {
      var error: Unmanaged<CFError>?
      guard let access = SecAccessControlCreateWithFlags(nil, kSecAttrAccessibleWhenPasscodeSetThisDeviceOnly, [.privateKeyUsage, .userPresence], &error) else {
        throw NSError(domain: "argus", code: 2, userInfo: [NSLocalizedDescriptionKey: "Set a passcode on this iPhone to use Argus."])
      }
      let key = try SecureEnclave.P256.Signing.PrivateKey(accessControl: access)
      try writeKeychain(Self.attemptAccount, key.dataRepresentation)
      return Signer(publicKey: key.publicKey, signFn: { try key.signature(for: $0) })
    }
    return try simulatorKey(Self.attemptAccount)
  }

  private func attemptKey(context: LAContext? = nil) throws -> Signer? {
    guard let stored = readKeychain(Self.attemptAccount) else { return nil }
    if SecureEnclave.isAvailable {
      let key = try SecureEnclave.P256.Signing.PrivateKey(dataRepresentation: stored, authenticationContext: context)
      return Signer(publicKey: key.publicKey, signFn: { try key.signature(for: $0) })
    }
    return try simulatorKey(Self.attemptAccount)
  }

  /// Signing asks for Face ID / Touch ID / passcode (userPresence). Runs off the main thread.
  private func signWithAttempt(_ data: Data, reason: String, result: @escaping FlutterResult) {
    let context = LAContext()
    context.localizedReason = reason
    DispatchQueue.global(qos: .userInitiated).async {
      do {
        guard let key = try self.attemptKey(context: context) else {
          return DispatchQueue.main.async { result(FlutterError(code: "no_key", message: "Register this phone first.", details: nil)) }
        }
        let sig = try key.sign(data)
        DispatchQueue.main.async { result(self.b64url(sig.derRepresentation)) }
      } catch {
        DispatchQueue.main.async { result(FlutterError(code: "auth_cancelled", message: error.localizedDescription, details: nil)) }
      }
    }
  }

  #if targetEnvironment(simulator)
    private func simulatorKey(_ account: String) throws -> Signer {
      let key: P256.Signing.PrivateKey
      if let stored = readKeychain(account) {
        key = try P256.Signing.PrivateKey(rawRepresentation: stored)
      } else {
        key = P256.Signing.PrivateKey()
        try writeKeychain(account, key.rawRepresentation)
      }
      return Signer(publicKey: key.publicKey, signFn: { try key.signature(for: $0) })
    }
  #else
    private func simulatorKey(_ account: String) throws -> Signer {
      throw NSError(domain: "argus", code: 1, userInfo: [NSLocalizedDescriptionKey: "Secure Enclave not available"])
    }
  #endif

  // ── App Attest ───────────────────────────────────────────────────────────

  /// Generates an App Attest key and attests it with clientDataHash = SHA-256(bind payload).
  private func appAttestKey(clientDataHash: Data?, result: @escaping FlutterResult) {
    let service = DCAppAttestService.shared
    guard service.isSupported, let hash = clientDataHash else {
      return result(FlutterError(code: "attest_unsupported", message: "App Attest is not available on this device.", details: nil))
    }
    service.generateKey { keyId, error in
      guard let keyId = keyId else {
        return DispatchQueue.main.async { result(FlutterError(code: "attest_failed", message: error?.localizedDescription ?? "generateKey failed", details: nil)) }
      }
      service.attestKey(keyId, clientDataHash: hash) { attestation, error in
        DispatchQueue.main.async {
          guard let attestation = attestation else {
            return result(FlutterError(code: "attest_failed", message: error?.localizedDescription ?? "attestKey failed", details: nil))
          }
          try? self.writeKeychain(Self.appAttestAccount, Data(keyId.utf8))
          result(["keyId": keyId, "attestation": attestation.base64EncodedString()])
        }
      }
    }
  }

  private func appAttestAssertion(clientDataHash: Data, result: @escaping FlutterResult) {
    guard DCAppAttestService.shared.isSupported, let stored = readKeychain(Self.appAttestAccount), let keyId = String(data: stored, encoding: .utf8) else {
      return result(FlutterError(code: "attest_unsupported", message: "No App Attest key.", details: nil))
    }
    DCAppAttestService.shared.generateAssertion(keyId, clientDataHash: clientDataHash) { assertion, error in
      DispatchQueue.main.async {
        if let assertion = assertion { result(assertion.base64EncodedString()) } else {
          result(FlutterError(code: "attest_failed", message: error?.localizedDescription ?? "generateAssertion failed", details: nil))
        }
      }
    }
  }

  // ── Location ─────────────────────────────────────────────────────────────

  private func locationFix(timeoutMs: Int, result: @escaping FlutterResult) {
    if locationResult != nil { return result(FlutterError(code: "busy", message: "A location request is already running.", details: nil)) }
    guard CLLocationManager.locationServicesEnabled() else { return result(FlutterError(code: "location_off", message: "Turn on Location Services.", details: nil)) }
    let manager = locationManager ?? CLLocationManager()
    locationManager = manager
    manager.delegate = self
    manager.desiredAccuracy = kCLLocationAccuracyBest
    locationResult = result
    locationRequestedAt = Date()
    bestFix = nil
    // At the deadline, send the best fresh fix we have (if any).
    locationTimer = Timer.scheduledTimer(withTimeInterval: Double(timeoutMs) / 1000, repeats: false) { [weak self] _ in
      guard let self = self else { return }
      if let best = self.bestFix { self.finishLocation(self.fixMap(best)) } else {
        self.finishLocation(FlutterError(code: "timeout", message: "Could not get a location fix.", details: nil))
      }
    }
    // After a few seconds, a fix within 100 m is good enough (spec §6 hard check uses 100 m).
    goodEnoughTimer = Timer.scheduledTimer(withTimeInterval: 4, repeats: false) { [weak self] _ in
      guard let self = self, let best = self.bestFix, best.horizontalAccuracy <= 100 else { return }
      self.finishLocation(self.fixMap(best))
    }
    switch manager.authorizationStatus {
    case .notDetermined: manager.requestWhenInUseAuthorization()
    case .denied, .restricted: finishLocation(FlutterError(code: "permission_denied", message: "Allow location for Argus in Settings.", details: nil))
    default: requestPreciseFix(manager)
    }
  }

  /// Continuous updates rather than requestLocation(): requestLocation can deliver only a
  /// cached fix, which we must ignore (spec §6), and then give up.
  private func requestPreciseFix(_ manager: CLLocationManager) {
    if manager.accuracyAuthorization == .reducedAccuracy {
      manager.requestTemporaryFullAccuracyAuthorization(withPurposeKey: "Attendance") { [weak self] _ in
        if manager.accuracyAuthorization == .reducedAccuracy {
          self?.finishLocation(FlutterError(code: "precise_required", message: "Turn on Precise Location for Argus.", details: nil))
        } else {
          manager.startUpdatingLocation()
        }
      }
    } else {
      manager.startUpdatingLocation()
    }
  }

  public func locationManagerDidChangeAuthorization(_ manager: CLLocationManager) {
    guard locationResult != nil else { return }
    switch manager.authorizationStatus {
    case .authorizedWhenInUse, .authorizedAlways: requestPreciseFix(manager)
    case .denied, .restricted: finishLocation(FlutterError(code: "permission_denied", message: "Allow location for Argus in Settings.", details: nil))
    default: break
    }
  }

  public func locationManager(_ manager: CLLocationManager, didUpdateLocations locations: [CLLocation]) {
    guard locationResult != nil else { return }
    // Only fixes taken after this request count (spec §6: no cached fixes); keep the most accurate.
    for loc in locations where loc.horizontalAccuracy >= 0 && loc.timestamp >= locationRequestedAt.addingTimeInterval(-2) {
      if bestFix == nil || loc.horizontalAccuracy < bestFix!.horizontalAccuracy { bestFix = loc }
    }
    if let best = bestFix, best.horizontalAccuracy <= 30 { finishLocation(fixMap(best)) }
  }

  private func fixMap(_ loc: CLLocation) -> [String: Any] {
    var mock = false
    if #available(iOS 15.0, *) { mock = loc.sourceInformation?.isSimulatedBySoftware ?? false }
    return [
      "lat": loc.coordinate.latitude,
      "lon": loc.coordinate.longitude,
      "accuracyM": loc.horizontalAccuracy,
      "fixAgeMs": Int(Date().timeIntervalSince(loc.timestamp) * 1000),
      "isMock": mock,
    ]
  }

  public func locationManager(_ manager: CLLocationManager, didFailWithError error: Error) {
    // kCLErrorLocationUnknown is transient: keep waiting for a fix until the deadline.
    if (error as? CLError)?.code == .locationUnknown { return }
    finishLocation(FlutterError(code: "location_error", message: error.localizedDescription, details: nil))
  }

  private func finishLocation(_ value: Any) {
    locationManager?.stopUpdatingLocation()
    locationTimer?.invalidate()
    locationTimer = nil
    goodEnoughTimer?.invalidate()
    goodEnoughTimer = nil
    bestFix = nil
    let r = locationResult
    locationResult = nil
    r?(value)
  }

  // ── Keychain / encoding ──────────────────────────────────────────────────

  private func b64url(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-").replacingOccurrences(of: "/", with: "_")
      .replacingOccurrences(of: "=", with: "")
  }

  private func query(_ account: String) -> [String: Any] {
    [kSecClass as String: kSecClassGenericPassword, kSecAttrService as String: "app.argus.security", kSecAttrAccount as String: account]
  }

  private func readKeychain(_ account: String) -> Data? {
    var q = query(account)
    q[kSecReturnData as String] = true
    var out: AnyObject?
    return SecItemCopyMatching(q as CFDictionary, &out) == errSecSuccess ? out as? Data : nil
  }

  private func writeKeychain(_ account: String, _ data: Data) throws {
    deleteKeychain(account)
    var q = query(account)
    q[kSecValueData as String] = data
    q[kSecAttrAccessible as String] = kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly
    let status = SecItemAdd(q as CFDictionary, nil)
    if status != errSecSuccess { throw NSError(domain: NSOSStatusErrorDomain, code: Int(status)) }
  }

  private func deleteKeychain(_ account: String) {
    SecItemDelete(query(account) as CFDictionary)
  }
}
