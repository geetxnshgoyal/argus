import 'dart:convert';
import 'dart:math';

import 'package:crypto/crypto.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter_web_auth_2/flutter_web_auth_2.dart';

import 'api_client.dart';

enum AuthStatus { loading, signedOut, needsPolicy, signedIn, offline }

/// Opens the college sign-in page in the system browser and returns the
/// app callback URL. Injectable so tests don't need a browser.
typedef BrowserAuth = Future<String> Function(String url, String callbackScheme);

Future<String> _systemBrowserAuth(String url, String callbackScheme) =>
    FlutterWebAuth2.authenticate(url: url, callbackUrlScheme: callbackScheme);

/// App-level sign-in state.
class AuthController extends ChangeNotifier {
  AuthController(this.api, {BrowserAuth? browserAuth}) : _browserAuth = browserAuth ?? _systemBrowserAuth {
    api.onSignedOut = () {
      me = null;
      if (status != AuthStatus.loading) _set(AuthStatus.signedOut);
    };
  }

  final ApiClient api;
  final BrowserAuth _browserAuth;
  static const callbackScheme = 'app.argus.argus';

  AuthStatus status = AuthStatus.loading;
  Me? me;
  String? error;
  bool busy = false;

  /// Restores the saved sign-in. Being offline (or the server being down) keeps the
  /// student signed in and shows a retry screen; only a revoked or missing sign-in
  /// goes back to the sign-in screen.
  Future<void> start() async {
    try {
      switch (await api.restore()) {
        case RestoreResult.signedOut:
          _set(AuthStatus.signedOut);
        case RestoreResult.offline:
          _set(AuthStatus.offline);
        case RestoreResult.signedIn:
          await _loadMe();
      }
    } on ApiException catch (e) {
      _set(e.statusCode == 401 ? AuthStatus.signedOut : AuthStatus.offline);
    } catch (_) {
      _set(AuthStatus.offline);
    }
  }

  Future<void> signInWithCollege() => _run(() async {
        final verifier = _randomVerifier();
        final challenge = base64Url.encode(sha256.convert(ascii.encode(verifier)).bytes).replaceAll('=', '');
        final url = '${api.baseUrl}/v1/auth/oidc/login?client=mobile&app_challenge=$challenge';
        final result = await _browserAuth(url, callbackScheme);
        final back = Uri.parse(result);
        final code = back.queryParameters['code'];
        if (code == null) {
          throw ApiException(400, back.queryParameters['error'] ?? 'login_failed', _friendly(back.queryParameters['error']));
        }
        await api.exchangeCode(code, verifier);
        await _loadMe();
      });

  Future<void> devSignIn(String email) => _run(() async {
        await api.devLogin(email.trim());
        await _loadMe();
      });

  Future<void> acceptPolicy() => _run(() async {
        await api.acceptPolicy(me!.policyVersion);
        await _loadMe();
      });

  Future<void> signOut() async {
    await api.logout();
    me = null;
    _set(AuthStatus.signedOut);
  }

  Future<void> _loadMe() async {
    me = await api.me();
    _set(me!.policyAccepted ? AuthStatus.signedIn : AuthStatus.needsPolicy);
  }

  Future<void> _run(Future<void> Function() fn) async {
    busy = true;
    error = null;
    notifyListeners();
    try {
      await fn();
    } on ApiException catch (e) {
      error = e.message;
    } on Exception catch (e) {
      final msg = e.toString();
      error = msg.contains('CANCELED') || msg.contains('cancel') ? 'Sign-in was cancelled.' : 'Could not reach Argus. Check your internet connection.';
    } finally {
      busy = false;
      notifyListeners();
    }
  }

  void _set(AuthStatus s) {
    status = s;
    notifyListeners();
  }

  static String _randomVerifier() {
    final r = Random.secure();
    return base64Url.encode(List<int>.generate(32, (_) => r.nextInt(256))).replaceAll('=', '');
  }

  static String _friendly(String? code) => switch (code) {
        'wrong_domain' => 'Please use your college Google account.',
        'not_provisioned' => 'Your account is not set up in Argus yet. Contact Academic Operations.',
        'account_disabled' => 'Your Argus account is disabled. Contact Academic Operations.',
        'sso_not_configured' => 'College Google sign-in is not set up on this server yet.',
        _ => 'Sign-in failed. Please try again.',
      };
}
