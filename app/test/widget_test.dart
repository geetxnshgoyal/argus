import 'dart:convert';

import 'package:argus/main.dart';
import 'package:argus/src/api_client.dart';
import 'package:argus/src/auth_controller.dart';
import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Fake backend covering the M1 endpoints the app uses.
class FakeServer {
  bool policyAccepted = false;
  int refreshCalls = 0;
  String? lastSignedMessage;
  bool expireAccess = false;
  final requests = <String>[];

  http.Client client() => MockClient((req) async {
        requests.add('${req.method} ${req.url.path}');
        final body = req.body.isEmpty ? <String, dynamic>{} : jsonDecode(req.body) as Map<String, dynamic>;
        switch ('${req.method} ${req.url.path}') {
          case 'POST /v1/auth/dev/mobile-login':
            if (body['signature'] != 'sig') return _json(401, {'code': 'bad_device_proof', 'message': 'nope'});
            return _json(200, {'access_token': 'a1', 'refresh_token': 'r1', 'expires_in': 900, 'token_type': 'Bearer'});
          case 'POST /v1/auth/refresh':
            refreshCalls++;
            return _json(200, {'access_token': 'a2', 'refresh_token': 'r2', 'expires_in': 900, 'token_type': 'Bearer'});
          case 'GET /v1/me':
            if (expireAccess && req.headers['authorization'] == 'Bearer a1') return _json(401, {'code': 'unauthenticated', 'message': 'x'});
            return _json(200, {
              'user': {'id': 'u1', 'role': 'student', 'name': 'Asha Rao', 'email': 'asha@college.test'},
              'home': '/student',
              'csrf_token': null,
              'policy': {'version': 'v1', 'accepted': policyAccepted},
              'student': {'usn': '2102500001', 'program': 'B.Tech CSE', 'section': '2nd Year 3rd Sem', 'batch': 'Batch 1'},
            });
          case 'GET /v1/policy':
            return _json(200, {'version': 'v1', 'text': '# Argus attendance policy\n\n## Rules\n- No proxies.'});
          case 'POST /v1/me/policy-acceptance':
            policyAccepted = true;
            return _json(200, {'ok': true, 'version': 'v1'});
          case 'GET /v1/me/timetable':
            final now = DateTime.now();
            final today = '${now.year}-${now.month.toString().padLeft(2, '0')}-${now.day.toString().padLeft(2, '0')}';
            return _json(200, {
              'from': today,
              'to': today,
              'items': [
                {
                  'id': 's1', 'date': today, 'start': '09:30', 'end': '11:00', 'starts_at': '', 'ends_at': '', 'status': 'scheduled', 'changed': false,
                  'entry_id': 'e1', 'subject': {'code': 'ADA', 'name': 'Analysis and Design of Algorithms', 'kind': 'lecture'},
                  'section': {'id': 'x', 'name': '2nd Year 3rd Sem'}, 'batch': null, 'room': 'Classroom 6', 'teacher': 'Teacher A',
                },
                {
                  'id': 's2', 'date': today, 'start': '15:30', 'end': '17:00', 'starts_at': '', 'ends_at': '', 'status': 'cancelled', 'changed': true,
                  'entry_id': 'e2', 'subject': {'code': 'ADA LAB', 'name': 'ADA LAB', 'kind': 'lab'},
                  'section': {'id': 'x', 'name': '2nd Year 3rd Sem'}, 'batch': 'Batch 1', 'room': 'Concept Room', 'teacher': null,
                },
              ],
            });
          case 'GET /v1/health':
            return _json(200, {'status': 'ok', 'version': '0.1.0', 'db': 'ok'});
          case 'POST /v1/auth/logout':
            return _json(200, {'ok': true});
        }
        return _json(404, {'code': 'not_found', 'message': 'Not found'});
      });

  static http.Response _json(int status, Object body) => http.Response(jsonEncode(body), status);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(SecurityBridge.channelName);
  late List<String> signed;

  setUp(() {
    signed = [];
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      switch (call.method) {
        case 'platformInfo':
          return {'platform': 'android', 'osVersion': '15', 'model': 'Pixel Test', 'hardwareKeyStore': true};
        case 'sessionPublicKey':
          return 'spki';
        case 'signWithSessionKey':
          signed.add(utf8.decode((call.arguments as Map)['data'] as List<int>));
          return 'sig';
        case 'resetSessionKey':
          return null;
      }
      return null;
    });
  });

  tearDown(() => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null));

  (ArgusApp, AuthController, MemoryTokenStore) build(FakeServer server) {
    final store = MemoryTokenStore();
    final api = ApiClient(baseUrl: 'http://test', security: SecurityBridge(), store: store, client: server.client());
    final auth = AuthController(api, browserAuth: (url, scheme) async => 'app.argus.argus:/auth/callback?error=not_provisioned');
    return (ArgusApp(auth: auth, security: SecurityBridge()), auth, store);
  }

  testWidgets('shows the sign-in screen when there is no saved session', (tester) async {
    final (app, auth, _) = build(FakeServer());
    await tester.pumpWidget(app);
    await auth.start();
    await tester.pumpAndSettle();
    expect(find.text('Sign in with college account'), findsOneWidget);
  });

  testWidgets('dev sign-in → policy → home, signing with the device session key', (tester) async {
    final server = FakeServer();
    final (app, auth, store) = build(server);
    await tester.pumpWidget(app);
    await auth.start();
    await tester.pumpAndSettle();

    await tester.tap(find.text('Sign in as this student'));
    await tester.pumpAndSettle();
    expect(signed.single, 'argus/v1/dev-login|student@svyasa-sas.edu.in');
    expect(store.value, 'r1');
    expect(find.text('Before you start'), findsOneWidget);

    await tester.tap(find.byType(Checkbox));
    await tester.pump();
    await tester.tap(find.text('Accept and continue'));
    await tester.pumpAndSettle();
    expect(find.text('Hi, Asha'), findsOneWidget);
    expect(find.textContaining('2102500001'), findsOneWidget);
    expect(find.textContaining('Batch 1'), findsWidgets);
    // Today's timetable, with the cancelled lab marked.
    expect(find.text('Today'), findsOneWidget);
    expect(find.text('ADA · Analysis and Design of Algorithms'), findsOneWidget);
    expect(find.text('Cancelled'), findsOneWidget);
  });

  testWidgets('explains SSO errors in plain language', (tester) async {
    final (app, auth, _) = build(FakeServer());
    await tester.pumpWidget(app);
    await auth.start();
    await tester.pumpAndSettle();
    await tester.tap(find.text('Sign in with college account'));
    await tester.pumpAndSettle();
    expect(find.textContaining('not set up in Argus'), findsOneWidget);
  });

  test('refreshes once on 401 with a request signed by the session key', () async {
    final server = FakeServer()..expireAccess = true;
    final store = MemoryTokenStore();
    final api = ApiClient(baseUrl: 'http://test', security: SecurityBridge(), store: store, client: server.client(), now: () => DateTime.fromMillisecondsSinceEpoch(1000));
    await api.devLogin('asha@college.test');
    final me = await api.me();
    expect(me.usn, '2102500001');
    expect(server.refreshCalls, 1);
    expect(signed.last, 'argus/v1/refresh|r1|1000');
    expect(store.value, 'r2');
  });

  test('restores a saved session at startup', () async {
    final server = FakeServer()..policyAccepted = true;
    final store = MemoryTokenStore()..value = 'r1';
    final api = ApiClient(baseUrl: 'http://test', security: SecurityBridge(), store: store, client: server.client());
    final auth = AuthController(api);
    await auth.start();
    expect(auth.status, AuthStatus.signedIn);
  });

  test('sign-out clears the refresh token and the device session key', () async {
    final server = FakeServer();
    final store = MemoryTokenStore();
    final api = ApiClient(baseUrl: 'http://test', security: SecurityBridge(), store: store, client: server.client());
    await api.devLogin('asha@college.test');
    await api.logout();
    expect(store.value, isNull);
    expect(server.requests, contains('POST /v1/auth/logout'));
  });

  test('ApiClient surfaces the standard error body', () async {
    final api = ApiClient(
      baseUrl: 'http://test',
      security: SecurityBridge(),
      store: MemoryTokenStore(),
      client: MockClient((_) async => http.Response(jsonEncode({'code': 'forbidden', 'message': 'No'}), 403)),
    );
    await expectLater(api.policy(), throwsA(isA<ApiException>().having((e) => e.code, 'code', 'forbidden')));
  });
}
