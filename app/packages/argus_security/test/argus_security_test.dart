import 'package:argus_security/argus_security.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  const channel = MethodChannel(SecurityBridge.channelName);
  final messenger = TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;

  tearDown(() => messenger.setMockMethodCallHandler(channel, null));

  test('parses platformInfo from native code', () async {
    messenger.setMockMethodCallHandler(channel, (call) async {
      expect(call.method, 'platformInfo');
      return {'platform': 'ios', 'osVersion': '26.0', 'model': 'iPhone', 'hardwareKeyStore': true};
    });
    final info = await SecurityBridge().platformInfo();
    expect(info.platform, 'ios');
    expect(info.hardwareKeyStore, isTrue);
  });

  test('missing fields fall back to safe defaults (no hardware key store)', () async {
    messenger.setMockMethodCallHandler(channel, (call) async => <String, Object?>{});
    final info = await SecurityBridge().platformInfo();
    expect(info.platform, 'unknown');
    expect(info.hardwareKeyStore, isFalse);
  });

  test('null result is an error, not a silent default', () async {
    messenger.setMockMethodCallHandler(channel, (call) async => null);
    expect(SecurityBridge().platformInfo(), throwsA(isA<PlatformException>()));
  });
}
