import 'dart:convert';

import 'package:argus/src/api_client.dart';
import 'package:argus/src/device_controller.dart';
import 'package:argus/src/jcs.dart';
import 'package:argus_security/argus_security.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  group('JCS (RFC 8785, ADR-0011)', () {
    test('sorts keys, drops whitespace, prints integral doubles without a fraction', () {
      expect(canonicalize({'b': 1, 'a': [1.0, 'x', null, true], 'c': {'z': 0.5, 'y': -2}}), '{"a":[1,"x",null,true],"b":1,"c":{"y":-2,"z":0.5}}');
    });
    test('matches the server canonicalizer for an attempt-shaped payload', () {
      // Expected string produced by backend/src/platform/jcs.ts for the same object.
      expect(
        canonicalize({'v': 1, 'session_id': 's', 'round': 2, 'epoch': 1234, 'location': {'lat': 12.971599, 'lon': 77.594566, 'accuracy_m': 14.3, 'fix_age_ms': 812, 'is_mock': false}, 'signals': <String, dynamic>{}, 'offline_queued': false}),
        '{"epoch":1234,"location":{"accuracy_m":14.3,"fix_age_ms":812,"is_mock":false,"lat":12.971599,"lon":77.594566},"offline_queued":false,"round":2,"session_id":"s","signals":{},"v":1}',
      );
    });
    test('base64url without padding round-trips', () {
      final bytes = List<int>.generate(33, (i) => i * 7 % 256);
      expect(b64url(bytes).contains('='), isFalse);
      expect(b64urlDecode(b64url(bytes)), bytes);
    });
  });

  group('ScannedQr.parse (protocol §5.3)', () {
    final now = DateTime(2026, 9, 25, 13);
    test('reads a classroom code', () {
      final qr = ScannedQr.parse('argus://a/01a0d773-64fb-7882-8221-d8cffb71034e/1/16/jE0lyOCGJkrFXzpS', now)!;
      expect(qr.sessionId, '01a0d773-64fb-7882-8221-d8cffb71034e');
      expect(qr.round, 1);
      expect(qr.epoch, 16);
      expect(qr.tag, 'jE0lyOCGJkrFXzpS');
    });
    test('ignores anything else', () {
      for (final bad in ['https://example.com', 'argus://a/x/1/2/abc', 'argus://a/01a0d773-64fb-7882-8221-d8cffb71034e/1/16/short', '', null]) {
        expect(ScannedQr.parse(bad, now), isNull, reason: '$bad');
      }
    });
  });

  test('AttemptSender signs the exact bytes it sends, with a fresh nonce each time', () async {
    const channel = MethodChannel('argus/security');
    final signed = <List<int>>[];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'signWithAttemptKey') {
        signed.add((call.arguments as Map)['data'] as List<int>);
        return 'SIG';
      }
      return null;
    });
    final bodies = <Map<String, dynamic>>[];
    final api = ApiClient(
      baseUrl: 'http://test',
      security: SecurityBridge(),
      store: MemoryTokenStore(),
      client: MockClient((req) async {
        bodies.add(jsonDecode(req.body) as Map<String, dynamic>);
        return http.Response(jsonEncode({'attempt_id': 'a', 'decision': 'verified', 'reason_codes': <String>[], 'record': 'present', 'message': 'ok'}), 200, headers: {'content-type': 'application/json'});
      }),
    );
    final sender = AttemptSender(api, SecurityBridge());
    final qr = ScannedQr('01a0d773-64fb-7882-8221-d8cffb71034e', 1, 16, 'jE0lyOCGJkrFXzpS', DateTime.now());
    const fix = LocationFix(lat: 12.97159912, lon: 77.59456634, accuracyM: 14.33, fixAgeMs: 812, isMock: false);

    final r = await sender.send(qr: qr, deviceId: 'dev-1', location: fix);
    await sender.send(qr: qr, deviceId: 'dev-1', location: null);

    expect(r.decision, 'verified');
    expect(bodies, hasLength(2));
    final sent = b64urlDecode(bodies[0]['payload'] as String);
    expect(sent, signed[0], reason: 'the signature covers exactly the bytes sent');
    expect(bodies[0]['signature'], 'SIG');
    final p = jsonDecode(utf8.decode(sent)) as Map<String, dynamic>;
    expect(utf8.decode(sent), canonicalize(p), reason: 'payload is canonical JSON');
    expect(p.keys.toSet(), {'v', 'session_id', 'round', 'epoch', 'tag', 'device_id', 'nonce', 'device_time', 'location', 'signals', 'app_version', 'offline_queued'});
    expect(p['location'], {'lat': 12.971599, 'lon': 77.594566, 'accuracy_m': 14.3, 'fix_age_ms': 812, 'is_mock': false});
    expect((p['nonce'] as String).length, 22);
    expect(DateTime.parse(p['device_time'] as String).isUtc, isTrue);
    final p2 = jsonDecode(utf8.decode(b64urlDecode(bodies[1]['payload'] as String))) as Map<String, dynamic>;
    expect(p2['location'], isNull);
    expect(p2['nonce'], isNot(p['nonce']));
    expect(bodies[0]['attestation'], containsPair('kind', anyOf('none', 'missing', 'app_attest')));
  });
}
