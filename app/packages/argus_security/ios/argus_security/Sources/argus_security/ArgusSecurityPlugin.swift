import CryptoKit
import Flutter
import Security
import UIKit

/// Argus native security module (iOS).
///
/// Session key (ADR-0008): a Secure Enclave P-256 key with no user-presence
/// requirement; its opaque handle is kept in the Keychain (this device only).
/// The attempt key (requires passcode/biometry), App Attest and DeviceCheck
/// are added in M3.
public class ArgusSecurityPlugin: NSObject, FlutterPlugin {
  static let channelName = "argus/security"
  static let sessionAccount = "argus_session_v1"

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(ArgusSecurityPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    do {
      switch call.method {
      case "platformInfo":
        result([
          "platform": "ios",
          "osVersion": UIDevice.current.systemVersion,
          "model": UIDevice.current.model,
          // False on the simulator; true on every supported iPhone.
          "hardwareKeyStore": SecureEnclave.isAvailable,
        ])
      case "sessionPublicKey":
        result(b64url(try sessionKey().publicKey.derRepresentation))
      case "signWithSessionKey":
        guard let args = call.arguments as? [String: Any], let data = args["data"] as? FlutterStandardTypedData else {
          return result(FlutterError(code: "bad_args", message: "data missing", details: nil))
        }
        result(b64url(try sessionKey().signature(for: data.data).derRepresentation))
      case "resetSessionKey":
        deleteKeychain(Self.sessionAccount)
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    } catch {
      result(FlutterError(code: "keystore_error", message: error.localizedDescription, details: nil))
    }
  }

  /// A signer abstracting the Secure Enclave (devices) and a software key (simulator only).
  struct Signer {
    let publicKey: P256.Signing.PublicKey
    let sign: (Data) throws -> P256.Signing.ECDSASignature
    func signature(for data: Data) throws -> P256.Signing.ECDSASignature { try sign(data) }
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
      return Signer(publicKey: key.publicKey, sign: { try key.signature(for: $0) })
    }
    #if targetEnvironment(simulator)
      let key: P256.Signing.PrivateKey
      if let stored = readKeychain(Self.sessionAccount) {
        key = try P256.Signing.PrivateKey(rawRepresentation: stored)
      } else {
        key = P256.Signing.PrivateKey()
        try writeKeychain(Self.sessionAccount, key.rawRepresentation)
      }
      return Signer(publicKey: key.publicKey, sign: { try key.signature(for: $0) })
    #else
      throw NSError(domain: "argus", code: 1, userInfo: [NSLocalizedDescriptionKey: "Secure Enclave not available"])
    #endif
  }

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
