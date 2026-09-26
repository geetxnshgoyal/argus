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

/// Mirrors the `ClassSession` schema (student timetable).
class ClassSession {
  const ClassSession({
    required this.id,
    required this.date,
    required this.start,
    required this.end,
    required this.status,
    required this.changed,
    required this.subjectCode,
    required this.subjectName,
    this.batch,
    this.room,
    this.teacher,
  });

  final String id;
  final String date;
  final String start;
  final String end;
  final String status;
  final bool changed;
  final String subjectCode;
  final String subjectName;
  final String? batch;
  final String? room;
  final String? teacher;

  bool get cancelled => status == 'cancelled';

  factory ClassSession.fromJson(Map<String, dynamic> j) {
    final subject = j['subject'] as Map<String, dynamic>;
    return ClassSession(
      id: j['id'] as String,
      date: j['date'] as String,
      start: j['start'] as String,
      end: j['end'] as String,
      status: j['status'] as String,
      changed: j['changed'] as bool? ?? false,
      subjectCode: subject['code'] as String,
      subjectName: subject['name'] as String,
      batch: j['batch'] as String?,
      room: j['room'] as String?,
      teacher: j['teacher'] as String?,
    );
  }
}

/// Mirrors `MyDevices`: this phone's registration and any pending phone change.
class DeviceStatus {
  const DeviceStatus({required this.thisDeviceId, required this.devices, this.rebindEligibleAt, this.rebindNeedsApproval = false, this.rebindReason});

  final String? thisDeviceId;
  final List<Map<String, dynamic>> devices;
  final DateTime? rebindEligibleAt;
  final bool rebindNeedsApproval;
  final String? rebindReason;

  Map<String, dynamic>? get thisDevice => devices.where((d) => d['id'] == thisDeviceId).firstOrNull;
  Map<String, dynamic>? get activeDevice => devices.where((d) => d['state'] == 'active').firstOrNull;
  bool get thisIsActive => thisDevice?['state'] == 'active';
  bool get thisIsPending => thisDevice?['state'] == 'pending';

  factory DeviceStatus.fromJson(Map<String, dynamic> j) {
    final rebind = j['rebind'] as Map<String, dynamic>?;
    return DeviceStatus(
      thisDeviceId: j['this_device_id'] as String?,
      devices: (j['devices'] as List).cast<Map<String, dynamic>>(),
      rebindEligibleAt: rebind?['eligible_at'] == null ? null : DateTime.parse(rebind!['eligible_at'] as String).toLocal(),
      rebindNeedsApproval: rebind?['needs_approval'] as bool? ?? false,
      rebindReason: rebind?['approval_reason'] as String?,
    );
  }
}

/// Mirrors `ActiveAttendance`: attendance running now for one of my classes.
class ActiveAttendance {
  const ActiveAttendance({required this.sessionId, required this.cls, required this.round, required this.mode, required this.action, this.decision});

  final String sessionId;
  final ClassSession cls;
  final int round;
  final String mode;

  /// scan | done | nothing_to_do
  final String action;
  final String? decision;

  factory ActiveAttendance.fromJson(Map<String, dynamic> j) => ActiveAttendance(
        sessionId: j['attendance_session_id'] as String,
        cls: ClassSession.fromJson(j['class'] as Map<String, dynamic>),
        round: j['round'] as int,
        mode: j['mode'] as String,
        action: j['action'] as String,
        decision: j['decision'] as String?,
      );
}

class AttemptResult {
  const AttemptResult({required this.decision, required this.reasons, required this.record, required this.message});
  final String decision;
  final List<String> reasons;
  final String record;
  final String message;

  factory AttemptResult.fromJson(Map<String, dynamic> j) => AttemptResult(
        decision: j['decision'] as String,
        reasons: (j['reason_codes'] as List).cast<String>(),
        record: j['record'] as String,
        message: j['message'] as String,
      );
}

class SubjectAttendance {
  const SubjectAttendance({required this.code, required this.name, required this.total, required this.attended, required this.late, required this.absent, this.percent});
  final String code;
  final String name;
  final int total;
  final int attended;
  final int late;
  final int absent;
  final double? percent;

  factory SubjectAttendance.fromJson(Map<String, dynamic> j) => SubjectAttendance(
        code: j['code'] as String,
        name: j['name'] as String,
        total: j['total'] as int,
        attended: j['attended'] as int,
        late: j['late'] as int,
        absent: j['absent'] as int,
        percent: (j['percent'] as num?)?.toDouble(),
      );
}

/// A notice from Academic Operations (ADR-0023): an announcement or a class change.
class AppNotice {
  const AppNotice({required this.id, required this.kind, required this.title, required this.body, required this.createdAt, required this.read, this.classDate});
  final String id;
  final String kind;
  final String title;
  final String body;
  final DateTime createdAt;
  final bool read;
  final String? classDate;

  bool get isClassChange => kind == 'class_change';

  factory AppNotice.fromJson(Map<String, dynamic> j) => AppNotice(
        id: j['id'] as String,
        kind: j['kind'] as String,
        title: j['title'] as String,
        body: j['body'] as String,
        createdAt: DateTime.parse(j['created_at'] as String).toLocal(),
        read: j['read'] as bool,
        classDate: j['class_date'] as String?,
      );
}

class Policy {
  const Policy(this.version, this.text);
  final String version;
  final String text;
}

/// Error body shape used by every Argus API error: {code, message, details}.
class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message, [this.details]);

  final int statusCode;
  final String code;
  final String message;
  final Map<String, dynamic>? details;

  /// True when the request never got an answer (offline, timeout).
  bool get isNetwork => statusCode == 0;

  @override
  String toString() => message;
}

enum RestoreResult { signedIn, signedOut, offline }

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

  /// My classes between two dates (inclusive, YYYY-MM-DD); server defaults to the next 7 days.
  Future<List<ClassSession>> timetable({String? from, String? to}) async {
    final q = [if (from != null) 'from=$from', if (to != null) 'to=$to'].join('&');
    final j = await _send('GET', '/v1/me/timetable${q.isEmpty ? '' : '?$q'}');
    return (j['items'] as List).map((e) => ClassSession.fromJson(e as Map<String, dynamic>)).toList();
  }

  // ── Devices (M3) ─────────────────────────────────────────────────────────
  Future<DeviceStatus> devices() async => DeviceStatus.fromJson(await _send('GET', '/v1/devices/me'));

  Future<String> bindChallenge() async => (await _send('POST', '/v1/devices/bind/challenge'))['challenge'] as String;

  Future<Map<String, dynamic>> bindDevice(Map<String, dynamic> body) => _send('POST', '/v1/devices/bind', body: body);

  // ── Attendance (M4) ──────────────────────────────────────────────────────
  Future<List<ActiveAttendance>> activeAttendance() async {
    final j = await _send('GET', '/v1/me/sessions/active');
    return (j['items'] as List).map((e) => ActiveAttendance.fromJson(e as Map<String, dynamic>)).toList();
  }

  Future<AttemptResult> submitAttempt(Map<String, dynamic> body) async => AttemptResult.fromJson(await _send('POST', '/v1/attendance/attempts', body: body));

  /// Support request (spec §7): a signed request sent while the class is on.
  Future<Map<String, dynamic>> requestSupport(Map<String, dynamic> body) => _send('POST', '/v1/support-requests', body: body);

  /// My recent support requests (latest first).
  Future<List<Map<String, dynamic>>> mySupportRequests() async => ((await _send('GET', '/v1/me/support-requests'))['items'] as List).cast<Map<String, dynamic>>();

  // ── Notices (ADR-0023) ───────────────────────────────────────────────────
  Future<List<AppNotice>> notices() async {
    final j = await _send('GET', '/v1/me/notices');
    return (j['items'] as List).map((e) => AppNotice.fromJson(e as Map<String, dynamic>)).toList();
  }

  /// Marks the given notices read (all of them when [ids] is null).
  Future<void> markNoticesRead([List<String>? ids]) async {
    await _send('POST', '/v1/me/notices/read', body: {'ids': ?ids});
  }

  Future<List<SubjectAttendance>> history() async {
    final j = await _send('GET', '/v1/me/attendance');
    return (j['subjects'] as List).map((e) => SubjectAttendance.fromJson(e as Map<String, dynamic>)).toList();
  }

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

  /// Restores a session from the stored refresh token. A network problem is not a
  /// reason to sign the student out: it returns [RestoreResult.offline] and keeps the token.
  Future<RestoreResult> restore() async {
    if (await store.read() == null) return RestoreResult.signedOut;
    try {
      await _refresh();
      return RestoreResult.signedIn;
    } on ApiException catch (e) {
      return e.statusCode == 401 && await store.read() == null ? RestoreResult.signedOut : RestoreResult.offline;
    }
  }

  /// Signs out of this sign-in (the server revokes its tokens). The phone's hardware keys
  /// stay: they are this phone's attendance registration, so signing in again on the same
  /// phone doesn't look like a new phone (which would start a 48-hour phone change).
  Future<void> logout() async {
    try {
      if (_access != null) await _send('POST', '/v1/auth/logout');
    } catch (_) {
      // Signing out locally must work even when offline.
    }
    _access = null;
    await store.write(null);
  }

  Future<void> _saveTokens(Map<String, dynamic> j) async {
    _access = j['access_token'] as String;
    await store.write(j['refresh_token'] as String);
  }

  Future<void>? _refreshing;

  /// Called when the server has ended this sign-in (e.g. revoked), so the app can show sign-in.
  void Function()? onSignedOut;

  /// One refresh at a time. Refresh tokens rotate and a reused one revokes the whole
  /// sign-in (ADR-0016), so parallel requests that all see a 401 must share one refresh.
  Future<void> _refresh() => _refreshing ??= _doRefresh().whenComplete(() => _refreshing = null);

  /// Only these mean the sign-in is really over; anything else (clock skew, server error) keeps it.
  static const _fatalRefreshCodes = {'invalid_refresh_token', 'refresh_reuse', 'bad_device_proof', 'signed_out'};

  Future<void> _doRefresh() async {
    final token = await store.read();
    if (token == null) throw ApiException(401, 'signed_out', 'Please sign in.');
    final ts = _now().millisecondsSinceEpoch;
    final sig = await security.signWithSessionKey(utf8.encode('argus/v1/refresh|$token|$ts'));
    try {
      final j = await _send('POST', '/v1/auth/refresh', auth: false, body: {'refresh_token': token, 'ts': ts, 'signature': sig});
      await _saveTokens(j);
    } on ApiException catch (e) {
      if (e.statusCode == 401 && _fatalRefreshCodes.contains(e.code)) {
        _access = null;
        await store.write(null);
        onSignedOut?.call();
      }
      rethrow;
    }
  }

  Future<Map<String, dynamic>> _send(String method, String path, {Object? body, bool auth = true, bool retried = false}) async {
    final headers = {'accept': 'application/json', if (body != null) 'content-type': 'application/json'};
    final usedAccess = _access;
    if (auth && usedAccess != null) headers['authorization'] = 'Bearer $usedAccess';
    final req = http.Request(method, _uri(path))..headers.addAll(headers);
    if (body != null) req.body = jsonEncode(body);
    final http.Response res;
    try {
      res = await http.Response.fromStream(await _client.send(req).timeout(_timeout));
    } on Exception catch (e) {
      if (e is ApiException) rethrow;
      throw ApiException(0, 'network', 'Could not reach Argus. Check your internet connection.');
    }
    if (res.statusCode == 401 && auth && !retried && await store.read() != null) {
      // Another request may already have refreshed while this one was in flight.
      if (_access == null || _access == usedAccess) await _refresh();
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
      return ApiException(res.statusCode, body['code'] as String? ?? 'http_error', body['message'] as String? ?? 'Request failed', body['details'] as Map<String, dynamic>?);
    } catch (_) {
      return ApiException(res.statusCode, 'http_error', 'Request failed (${res.statusCode})');
    }
  }
}
