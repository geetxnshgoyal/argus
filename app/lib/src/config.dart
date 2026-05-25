import 'dart:io' show Platform;

/// API base URL. Override at build time with
/// `--dart-define=ARGUS_API=https://argus.example.edu`.
/// Dev defaults: the Android emulator reaches the host machine at 10.0.2.2;
/// the iOS simulator shares the host's localhost.
String defaultApiBase() {
  const fromEnv = String.fromEnvironment('ARGUS_API');
  if (fromEnv.isNotEmpty) return fromEnv;
  return Platform.isAndroid ? 'http://10.0.2.2:8080' : 'http://localhost:8080';
}
