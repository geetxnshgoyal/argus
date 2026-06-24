/// Argus native security module.
///
/// Kotlin (Android) and Swift (iOS) code lives in this package; the spec forbids
/// third-party Flutter plugins for keys and attestation. M0 exposes device
/// capabilities; M3 adds key generation, signing and attestation.
library;

import 'package:flutter/services.dart';

/// What the phone's hardware key store can offer. Reported by native code
/// (Kotlin/Swift) over the `argus/security` channel. Key generation, signing
/// and attestation are added to this same native module in M3; the spec
/// forbids third-party Flutter plugins for those.
class PlatformSecurityInfo {
  const PlatformSecurityInfo({
    required this.platform,
    required this.osVersion,
    required this.model,
    required this.hardwareKeyStore,
  });

  final String platform;
  final String osVersion;
  final String model;

  /// Android: StrongBox available. iOS: Secure Enclave available.
  final bool hardwareKeyStore;

  factory PlatformSecurityInfo.fromMap(Map<Object?, Object?> m) => PlatformSecurityInfo(
        platform: m['platform'] as String? ?? 'unknown',
        osVersion: m['osVersion'] as String? ?? 'unknown',
        model: m['model'] as String? ?? 'unknown',
        hardwareKeyStore: m['hardwareKeyStore'] as bool? ?? false,
      );
}

class SecurityBridge {
  SecurityBridge({MethodChannel? channel}) : _channel = channel ?? const MethodChannel(channelName);

  static const channelName = 'argus/security';
  final MethodChannel _channel;

  Future<PlatformSecurityInfo> platformInfo() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>('platformInfo');
    if (result == null) throw PlatformException(code: 'no_result', message: 'platformInfo returned nothing');
    return PlatformSecurityInfo.fromMap(result);
  }

  /// Public half of the device session key (P-256, SPKI DER, base64url).
  /// The key is created in hardware on first use and never leaves the phone.
  Future<String> sessionPublicKey() async {
    final key = await _channel.invokeMethod<String>('sessionPublicKey');
    if (key == null || key.isEmpty) throw PlatformException(code: 'no_result', message: 'no session key');
    return key;
  }

  /// ECDSA-P256-SHA256 signature (DER, base64url) over [data] with the session key.
  Future<String> signWithSessionKey(Uint8List data) async {
    final sig = await _channel.invokeMethod<String>('signWithSessionKey', {'data': data});
    if (sig == null || sig.isEmpty) throw PlatformException(code: 'no_result', message: 'signing failed');
    return sig;
  }

  /// Deletes the session key (sign-out). A new one is created at next sign-in.
  Future<void> resetSessionKey() => _channel.invokeMethod<void>('resetSessionKey');
}
