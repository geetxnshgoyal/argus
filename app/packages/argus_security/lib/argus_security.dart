/// Argus native security module.
///
/// Kotlin (Android) and Swift (iOS) code lives in this package; the spec forbids
/// third-party Flutter plugins for keys and attestation. Method channel: `argus/security`.
library;

import 'dart:io' show Platform;

import 'package:flutter/services.dart';

/// What the phone's hardware key store can offer.
class PlatformSecurityInfo {
  const PlatformSecurityInfo({
    required this.platform,
    required this.osVersion,
    required this.model,
    required this.hardwareKeyStore,
    required this.screenLock,
  });

  final String platform;
  final String osVersion;
  final String model;

  /// Android: StrongBox available. iOS: Secure Enclave available.
  final bool hardwareKeyStore;

  /// A PIN/pattern/passcode is set (required for the attempt key).
  final bool screenLock;

  factory PlatformSecurityInfo.fromMap(Map<Object?, Object?> m) => PlatformSecurityInfo(
        platform: m['platform'] as String? ?? 'unknown',
        osVersion: m['osVersion'] as String? ?? 'unknown',
        model: m['model'] as String? ?? 'unknown',
        hardwareKeyStore: m['hardwareKeyStore'] as bool? ?? false,
        screenLock: m['screenLock'] as bool? ?? true,
      );
}

/// A fresh location fix taken for one scan. Raw coordinates go only into the
/// signed payload; the server keeps just the derived result (spec §6).
class LocationFix {
  const LocationFix({required this.lat, required this.lon, required this.accuracyM, required this.fixAgeMs, required this.isMock});

  final double lat;
  final double lon;
  final double accuracyM;
  final int fixAgeMs;
  final bool isMock;

  factory LocationFix.fromMap(Map<Object?, Object?> m) => LocationFix(
        lat: (m['lat'] as num).toDouble(),
        lon: (m['lon'] as num).toDouble(),
        accuracyM: (m['accuracyM'] as num).toDouble(),
        fixAgeMs: (m['fixAgeMs'] as num).toInt(),
        isMock: m['isMock'] as bool? ?? false,
      );
}

/// A newly generated attempt key: public key (SPKI DER, base64url) and, on
/// Android, its key-attestation certificate chain (standard base64 DER, leaf first).
class AttemptKey {
  const AttemptKey(this.publicKey, this.chain);
  final String publicKey;
  final List<String> chain;
}

class SecurityBridge {
  SecurityBridge({MethodChannel? channel}) : _channel = channel ?? const MethodChannel(channelName);

  static const channelName = 'argus/security';
  final MethodChannel _channel;

  bool get isAndroid => Platform.isAndroid;

  Future<PlatformSecurityInfo> platformInfo() async {
    final result = await _channel.invokeMethod<Map<Object?, Object?>>('platformInfo');
    if (result == null) throw PlatformException(code: 'no_result', message: 'platformInfo returned nothing');
    return PlatformSecurityInfo.fromMap(result);
  }

  /// Public half of the device session key (P-256, SPKI DER, base64url).
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

  /// Generates a new attempt key (replacing any old one) with the server's [challenge]
  /// as the Android key-attestation challenge. The key needs the user to unlock.
  Future<AttemptKey> createAttemptKey(Uint8List challenge) async {
    final m = await _channel.invokeMethod<Map<Object?, Object?>>('createAttemptKey', {'challenge': challenge});
    if (m == null) throw PlatformException(code: 'no_result', message: 'no attempt key');
    return AttemptKey(m['publicKey'] as String, ((m['chain'] as List?) ?? const []).cast<String>());
  }

  Future<String?> attemptPublicKey() => _channel.invokeMethod<String>('attemptPublicKey');

  /// Signs with the attempt key; prompts for fingerprint/face/PIN if needed.
  Future<String> signWithAttemptKey(Uint8List data, {String reason = 'Confirm it\'s you to mark attendance'}) async {
    final sig = await _channel.invokeMethod<String>('signWithAttemptKey', {'data': data, 'reason': reason});
    if (sig == null || sig.isEmpty) throw PlatformException(code: 'no_result', message: 'signing failed');
    return sig;
  }

  /// Android: unlock the attempt key ahead of scanning so the scan itself is instant.
  Future<void> unlockAttemptKey({String reason = 'Confirm it\'s you to mark attendance'}) => _channel.invokeMethod<bool>('unlockAttemptKey', {'reason': reason});

  Future<void> resetAttemptKey() => _channel.invokeMethod<void>('resetAttemptKey');

  /// Android only: ANDROID_ID for same-phone detection (the server stores only a keyed hash).
  Future<String?> androidId() async => Platform.isAndroid ? _channel.invokeMethod<String>('androidId') : null;

  /// One fresh precise fix (never cached). Throws PlatformException with codes
  /// permission_denied, precise_required, location_off, timeout.
  Future<LocationFix> locationFix({int timeoutMs = 10000}) async {
    final m = await _channel.invokeMethod<Map<Object?, Object?>>('locationFix', {'timeoutMs': timeoutMs});
    if (m == null) throw PlatformException(code: 'no_result', message: 'no location');
    return LocationFix.fromMap(m);
  }

  /// Android: Play Integrity standard token bound to [requestHash] (base64url SHA-256 of the payload).
  Future<String> integrityToken(int cloudProjectNumber, String requestHash) async {
    final t = await _channel.invokeMethod<String>('integrityToken', {'cloudProjectNumber': cloudProjectNumber, 'requestHash': requestHash});
    if (t == null) throw PlatformException(code: 'integrity_unavailable', message: 'no token');
    return t;
  }

  /// iOS: new App Attest key attested with [clientDataHash] (SHA-256 of the bind payload).
  Future<({String keyId, String attestation})> appAttestKey(Uint8List clientDataHash) async {
    final m = await _channel.invokeMethod<Map<Object?, Object?>>('appAttestKey', {'clientDataHash': clientDataHash});
    if (m == null) throw PlatformException(code: 'attest_failed', message: 'no attestation');
    return (keyId: m['keyId'] as String, attestation: m['attestation'] as String);
  }

  /// iOS: App Attest assertion over [clientDataHash] (SHA-256 of the attempt payload).
  Future<String> appAttestAssertion(Uint8List clientDataHash) async {
    final a = await _channel.invokeMethod<String>('appAttestAssertion', {'clientDataHash': clientDataHash});
    if (a == null) throw PlatformException(code: 'attest_failed', message: 'no assertion');
    return a;
  }

  /// iOS: DeviceCheck token (null if unsupported).
  Future<String?> deviceCheckToken() async => Platform.isIOS ? _channel.invokeMethod<String>('deviceCheckToken') : null;
}
