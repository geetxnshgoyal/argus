import CryptoKit
import Flutter
import UIKit

/// Argus native security module (iOS).
///
/// M0: reports device capabilities. M3 adds Secure Enclave key generation,
/// signing, App Attest and DeviceCheck.
public class ArgusSecurityPlugin: NSObject, FlutterPlugin {
  static let channelName = "argus/security"

  public static func register(with registrar: FlutterPluginRegistrar) {
    let channel = FlutterMethodChannel(name: channelName, binaryMessenger: registrar.messenger())
    registrar.addMethodCallDelegate(ArgusSecurityPlugin(), channel: channel)
  }

  public func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "platformInfo":
      result([
        "platform": "ios",
        "osVersion": UIDevice.current.systemVersion,
        "model": UIDevice.current.model,
        // False on the simulator; true on every supported iPhone.
        "hardwareKeyStore": SecureEnclave.isAvailable,
      ])
    default:
      result(FlutterMethodNotImplemented)
    }
  }
}
