import 'dart:convert';

import 'package:argus/main.dart';
import 'package:argus/src/api_client.dart';
import 'package:argus_security/argus_security.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(SecurityBridge.channelName);

  setUp(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, (call) async {
      if (call.method == 'platformInfo') {
        return {'platform': 'android', 'osVersion': '15', 'model': 'Pixel Test', 'hardwareKeyStore': true};
      }
      return null;
    });
  });

  tearDown(() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(channel, null);
  });

  ApiClient apiReturning(int status, Map<String, dynamic> body) => ApiClient(
        baseUrl: 'http://test',
        client: MockClient((req) async {
          expect(req.url.path, '/v1/health');
          return http.Response(jsonEncode(body), status);
        }),
      );

  testWidgets('shows server OK and device security info', (tester) async {
    await tester.pumpWidget(ArgusApp(
      api: apiReturning(200, {'status': 'ok', 'version': '0.1.0', 'db': 'ok'}),
      security: SecurityBridge(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Server OK (v0.1.0)'), findsOneWidget);
    expect(find.textContaining('StrongBox available'), findsOneWidget);
  });

  testWidgets('shows database unavailable on 503', (tester) async {
    await tester.pumpWidget(ArgusApp(
      api: apiReturning(503, {'status': 'degraded', 'version': '0.1.0', 'db': 'unavailable'}),
      security: SecurityBridge(),
    ));
    await tester.pumpAndSettle();
    expect(find.text('Server database unavailable'), findsOneWidget);
  });

  test('ApiClient surfaces the standard error body', () async {
    final api = ApiClient(
      baseUrl: 'http://test',
      client: MockClient((_) async => http.Response(jsonEncode({'code': 'forbidden', 'message': 'No'}), 403)),
    );
    await expectLater(
      api.health(),
      throwsA(isA<ApiException>().having((e) => e.code, 'code', 'forbidden').having((e) => e.statusCode, 'status', 403)),
    );
  });
}
