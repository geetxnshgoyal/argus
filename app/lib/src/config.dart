import 'dart:io' show Platform;

import 'package:flutter/foundation.dart' show kDebugMode;

/// API base URL. Override at build time with
/// `--dart-define=ARGUS_API=https://argus.example.edu`.
/// Dev defaults: the Android emulator reaches the host machine at 10.0.2.2;
/// the iOS simulator shares the host's localhost.
String defaultApiBase() {
  const fromEnv = String.fromEnvironment('ARGUS_API');
  if (fromEnv.isNotEmpty) return fromEnv;
  return Platform.isAndroid ? 'http://10.0.2.2:8080' : 'http://localhost:8080';
}

/// App version sent with registrations and attempts.
const appVersion = String.fromEnvironment('ARGUS_APP_VERSION', defaultValue: '1.1.0');

/// Google Cloud project number for Play Integrity (Android). 0 = not configured
/// (development builds; the server's dev attestation bypass is used instead).
const playCloudProjectNumber = int.fromEnvironment('ARGUS_PLAY_CLOUD_PROJECT', defaultValue: 0);

/// A development build: debug mode, or built with `--dart-define=ARGUS_DEV_LOGIN=true`
/// (e.g. a release build installed on a test iPhone). Shows the developer sign-in and
/// lets phone registration fall back to the dev attestation bypass, which servers
/// refuse unless they run with ARGUS_ENV=dev.
const devBuild = kDebugMode || bool.fromEnvironment('ARGUS_DEV_LOGIN');
