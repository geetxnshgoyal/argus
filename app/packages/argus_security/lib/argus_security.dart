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
}
