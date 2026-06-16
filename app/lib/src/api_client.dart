import 'dart:convert';

import 'package:argus_security/argus_security.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';
import 'package:http/http.dart' as http;

/// Mirrors the `Health` schema in backend/api/openapi.yaml.
class Health {
  const Health({required this.status, required this.version, required this.db});

  final String status;
  final String version;
  final String db;

  bool get ok => status == 'ok';

  factory Health.fromJson(Map<String, dynamic> json) =>
      Health(status: json['status'] as String, version: json['version'] as String, db: json['db'] as String);
}

/// Mirrors the `Me` schema.
class Me {
  const Me({
    required this.id,
    required this.role,
    required this.name,
    required this.email,
    required this.policyVersion,
    required this.policyAccepted,
    this.usn,
    this.program,
    this.section,
    this.batch,
  });

  final String id;
  final String role;
  final String name;
  final String email;
  final String policyVersion;
  final bool policyAccepted;
  final String? usn;
  final String? program;
  final String? section;
  final String? batch;

  factory Me.fromJson(Map<String, dynamic> j) {
    final user = j['user'] as Map<String, dynamic>;
    final policy = j['policy'] as Map<String, dynamic>;
    final student = j['student'] as Map<String, dynamic>?;
    return Me(
      id: user['id'] as String,
      role: user['role'] as String,
      name: user['name'] as String,
      email: user['email'] as String,
      policyVersion: policy['version'] as String,
      policyAccepted: policy['accepted'] as bool,
      usn: student?['usn'] as String?,
      program: student?['program'] as String?,
      section: student?['section'] as String?,
      batch: student?['batch'] as String?,
    );
  }
}

class Policy {
  const Policy(this.version, this.text);
  final String version;
  final String text;
}

/// Error body shape used by every Argus API error: {code, message, details}.
class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message);

  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => message;
}

/// Where the refresh token lives between app launches. Production uses the
/// platform keystore (Android Keystore / iOS Keychain); tests use memory.
abstract class TokenStore {
  Future<String?> read();
  Future<void> write(String? token);
}

class SecureTokenStore implements TokenStore {
  static const _key = 'argus_refresh_token';
  final _storage = const FlutterSecureStorage(iOptions: IOSOptions(accessibility: KeychainAccessibility.first_unlock_this_device));

  @override
  Future<String?> read() => _storage.read(key: _key);

  @override
  Future<void> write(String? token) => token == null ? _storage.delete(key: _key) : _storage.write(key: _key, value: token);
}

class MemoryTokenStore implements TokenStore {
  String? value;
  @override
  Future<String?> read() async => value;
  @override
  Future<void> write(String? token) async => value = token;
}

/// HTTP client for the Argus API. Adds the bearer token, and on 401 refreshes
/// once using a refresh request signed by the device session key (ADR-0008).
class ApiClient {
  ApiClient({required this.baseUrl, required this.security, required this.store, http.Client? client, DateTime Function()? now})
      : _client = client ?? http.Client(),
        _now = now ?? DateTime.now;

  final String baseUrl;
  final SecurityBridge security;
  final TokenStore store;
  final http.Client _client;
  final DateTime Function() _now;
  String? _access;

  bool get hasAccessToken => _access != null;

  Uri _uri(String path) => Uri.parse('$baseUrl$path');

  static const _timeout = Duration(seconds: 15);

  Future<Health> health() async {
    final res = await _client.get(_uri('/v1/health'), headers: {'accept': 'application/json'}).timeout(const Duration(seconds: 5));
    // The health endpoint returns 503 with a body when the database is down.
    if (res.statusCode == 200 || res.statusCode == 503) return Health.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
    throw _error(res);
  }

  Future<Policy> policy() async {
    final j = await _send('GET', '/v1/policy', auth: false);
    return Policy(j['version'] as String, j['text'] as String);
  }

  Future<Me> me() async => Me.fromJson(await _send('GET', '/v1/me'));

  Future<void> acceptPolicy(String version) async {
    await _send('POST', '/v1/me/policy-acceptance', body: {'version': version});
  }

  /// DEV ONLY (server must run with ARGUS_DEV_LOGIN): sign in by email.
  Future<void> devLogin(String email) async {
    final key = await security.sessionPublicKey();
    final sig = await security.signWithSessionKey(utf8.encode('argus/v1/dev-login|$email'));
    final j = await _send('POST', '/v1/auth/dev/mobile-login', auth: false, body: {'email': email, 'session_public_key': key, 'signature': sig});
    await _saveTokens(j);
  }

  /// Completes college SSO: the one-time code is redeemed with our PKCE verifier and bound to the session key.
  Future<void> exchangeCode(String code, String verifier) async {
    final key = await security.sessionPublicKey();
    final sig = await security.signWithSessionKey(utf8.encode('argus/v1/exchange|$code'));
    final j = await _send('POST', '/v1/auth/mobile/exchange', auth: false, body: {
      'code': code,
      'code_verifier': verifier,
      'session_public_key': key,
      'signature': sig,
    });
    await _saveTokens(j);
  }

  /// Restores a session from the stored refresh token. Returns false if the user must sign in.
  Future<bool> restore() async {
    if (await store.read() == null) return false;
    try {
      await _refresh();
      return true;
    } on ApiException {
      return false;
    }
  }

  Future<void> logout() async {
    try {
      if (_access != null) await _send('POST', '/v1/auth/logout');
    } catch (_) {
      // Signing out locally must work even when offline.
    }
    _access = null;
    await store.write(null);
    await security.resetSessionKey();
  }

  Future<void> _saveTokens(Map<String, dynamic> j) async {
    _access = j['access_token'] as String;
    await store.write(j['refresh_token'] as String);
  }

  Future<void> _refresh() async {
    final token = await store.read();
    if (token == null) throw ApiException(401, 'signed_out', 'Please sign in.');
    final ts = _now().millisecondsSinceEpoch;
    final sig = await security.signWithSessionKey(utf8.encode('argus/v1/refresh|$token|$ts'));
    try {
      final j = await _send('POST', '/v1/auth/refresh', auth: false, body: {'refresh_token': token, 'ts': ts, 'signature': sig});
      await _saveTokens(j);
    } on ApiException catch (e) {
      if (e.statusCode == 401) {
        _access = null;
        await store.write(null);
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body, bool auth = true, bool retried = false}) async {
    final headers = {'accept': 'application/json', if (body != null) 'content-type': 'application/json'};
    if (auth && _access != null) headers['authorization'] = 'Bearer $_access';
    final req = http.Request(method, _uri(path))..headers.addAll(headers);
    if (body != null) req.body = jsonEncode(body);
    final res = await http.Response.fromStream(await _client.send(req).timeout(_timeout));
    if (res.statusCode == 401 && auth && !retried && await store.read() != null) {
      await _refresh();
      return _send(method, path, body: body, auth: auth, retried: true);
    }
    if (res.statusCode >= 200 && res.statusCode < 300) {
      return res.body.isEmpty ? <String, dynamic>{} : jsonDecode(res.body) as Map<String, dynamic>;
    }
    throw _error(res);
  }

  ApiException _error(http.Response res) {
    try {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return ApiException(res.statusCode, body['code'] as String? ?? 'http_error', body['message'] as String? ?? 'Request failed');
    } catch (_) {
      return ApiException(res.statusCode, 'http_error', 'Request failed (${res.statusCode})');
    }
  }
}
