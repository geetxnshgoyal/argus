import 'dart:io' show Platform;
import 'dart:math';

import 'package:argus_security/argus_security.dart';
import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

import 'api_client.dart';
import 'config.dart';
import 'jcs.dart';

enum PhoneState { loading, unregistered, otherPhoneActive, pending, active, error }

/// This phone's registration for attendance (protocol §4, ADR-0007/0008).
class DeviceController extends ChangeNotifier {
  DeviceController(this.api, this.security);

  final ApiClient api;
  final SecurityBridge security;

  PhoneState state = PhoneState.loading;
  DeviceStatus? status;
  String? error;
  String? message;
  bool busy = false;

  String? get deviceId => status?.thisDeviceId;

  Future<void> load() async {
    try {
      final s = await api.devices();
      status = s;
      state = s.thisIsActive
          ? PhoneState.active
          : s.thisIsPending
              ? PhoneState.pending
              : s.activeDevice != null
                  ? PhoneState.otherPhoneActive
                  : PhoneState.unregistered;
      error = null;
    } on ApiException catch (e) {
      state = PhoneState.error;
      error = e.message;
    }
    notifyListeners();
  }

  /// Registers this phone: fresh challenge → attempt key generated in hardware with that
  /// challenge → payload signed by both keys → platform attestation → server decides.
  Future<void> register() async {
    busy = true;
    error = null;
    message = null;
    notifyListeners();
    try {
      Map<String, dynamic> result;
      try {
        result = await _bind(devBypass: false);
      } on ApiException catch (e) {
        // Development builds only: fall back to the dev attestation bypass (refused by servers outside dev).
        if (!devBuild || (e.code != 'attestation_failed' && e.code != 'attestation_unavailable')) rethrow;
        result = await _bind(devBypass: true);
      } on PlatformException catch (e) {
        if (!devBuild || (e.code != 'attest_unsupported' && e.code != 'attest_failed')) rethrow;
        result = await _bind(devBypass: true);
      }
      message = result['message'] as String?;
      await load();
    } on ApiException catch (e) {
      error = e.message;
    } on PlatformException catch (e) {
      error = switch (e.code) {
        'no_screen_lock' => 'Set a screen lock (PIN, pattern or password) on this phone first, then try again.',
        'auth_cancelled' => 'Registration needs you to confirm with your fingerprint, face or PIN.',
        _ => e.message ?? 'This phone could not be registered.',
      };
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  Future<Map<String, dynamic>> _bind({required bool devBypass}) async {
    final challenge = await api.bindChallenge();
    final key = await security.createAttemptKey(Uint8List.fromList(b64urlDecode(challenge)));
    final info = await security.platformInfo();
    final payload = Uint8List.fromList(canonicalBytes({
      'v': 1,
      'challenge': challenge,
      'session_pub': await security.sessionPublicKey(),
      'attempt_pub': key.publicKey,
      'platform': Platform.isAndroid ? 'android' : 'ios',
      'model': info.model,
      'os_version': info.osVersion,
      'app_version': appVersion,
      if (Platform.isAndroid) 'android_id': await security.androidId(),
    }));
    final sessionSig = await security.signWithSessionKey(payload);
    final attemptSig = await security.signWithAttemptKey(payload, reason: 'Confirm it\'s you to register this phone for attendance');
    final hash = sha256.convert(payload).bytes;

    Map<String, dynamic> evidence;
    if (devBypass) {
      evidence = {'kind': 'dev_bypass'};
    } else if (Platform.isAndroid) {
      String? token;
      if (playCloudProjectNumber > 0) {
        token = await security.integrityToken(playCloudProjectNumber, b64url(hash));
      }
      evidence = {'kind': 'android', 'attempt_key_chain': key.chain, 'play_integrity_token': ?token};
    } else {
      final att = await security.appAttestKey(Uint8List.fromList(hash));
      evidence = {'kind': 'ios', 'app_attest_key_id': att.keyId, 'attestation_object': att.attestation, 'devicecheck_token': ?await security.deviceCheckToken()};
    }
    return api.bindDevice({'payload': b64url(payload), 'session_signature': sessionSig, 'attempt_signature': attemptSig, 'evidence': evidence});
  }
}

/// Builds, signs and sends one attendance attempt (protocol §5.4).
class AttemptSender {
  AttemptSender(this.api, this.security);

  final ApiClient api;
  final SecurityBridge security;
  final _random = Random.secure();

  Future<AttemptResult> send({
    required ScannedQr qr,
    required String deviceId,
    required LocationFix? location,
    DateTime? deviceTime,
    bool offlineQueued = false,
  }) async {
    final nonce = List<int>.generate(16, (_) => _random.nextInt(256));
    final payload = Uint8List.fromList(canonicalBytes({
      'v': 1,
      'session_id': qr.sessionId,
      'round': qr.round,
      'epoch': qr.epoch,
      'tag': qr.tag,
      'device_id': deviceId,
      'nonce': b64url(nonce),
      'device_time': (deviceTime ?? DateTime.now()).toUtc().toIso8601String(),
      'location': location == null
          ? null
          : {
              // ~10 cm precision is plenty; the server stores only the derived result.
              'lat': double.parse(location.lat.toStringAsFixed(6)),
              'lon': double.parse(location.lon.toStringAsFixed(6)),
              'accuracy_m': double.parse(location.accuracyM.toStringAsFixed(1)),
              'fix_age_ms': location.fixAgeMs,
              'is_mock': location.isMock,
            },
      'signals': <String, dynamic>{},
      'app_version': appVersion,
      'offline_queued': offlineQueued,
    }));
    final signature = await security.signWithAttemptKey(payload);
    final hash = sha256.convert(payload).bytes;
    Map<String, dynamic> attestation;
    try {
      if (Platform.isAndroid) {
        attestation = playCloudProjectNumber > 0 ? {'kind': 'play_integrity', 'token': await security.integrityToken(playCloudProjectNumber, b64url(hash))} : {'kind': 'none'};
      } else {
        attestation = {'kind': 'app_attest', 'assertion': await security.appAttestAssertion(Uint8List.fromList(hash))};
      }
    } on PlatformException catch (e) {
      // Provider trouble on the phone: the server flags it, never rejects (spec §14).
      attestation = {'kind': 'missing', 'error': e.code};
    }
    return api.submitAttempt({'payload': b64url(payload), 'signature': signature, 'attestation': attestation});
  }
}

/// A decoded classroom QR: argus://a/{session_id}/{round}/{epoch}/{tag} (protocol §5.3).
class ScannedQr {
  const ScannedQr(this.sessionId, this.round, this.epoch, this.tag, this.seenAt);

  final String sessionId;
  final int round;
  final int epoch;
  final String tag;
  final DateTime seenAt;

  static final _re = RegExp(r'^argus://a/([0-9a-f-]{36})/(\d{1,4})/(\d{1,13})/([A-Za-z0-9_-]{16})$');

  static ScannedQr? parse(String? raw, DateTime now) {
    final m = _re.firstMatch(raw?.trim() ?? '');
    if (m == null) return null;
    return ScannedQr(m[1]!, int.parse(m[2]!), int.parse(m[3]!), m[4]!, now);
  }
}
