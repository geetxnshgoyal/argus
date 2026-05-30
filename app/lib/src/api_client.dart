import 'dart:convert';

import 'package:http/http.dart' as http;

/// Mirrors the `Health` schema in backend/api/openapi.yaml.
class Health {
  const Health({required this.status, required this.version, required this.db});

  final String status;
  final String version;
  final String db;

  bool get ok => status == 'ok';

  factory Health.fromJson(Map<String, dynamic> json) => Health(
        status: json['status'] as String,
        version: json['version'] as String,
        db: json['db'] as String,
      );
}

/// Error body shape used by every Argus API error: {code, message, details}.
class ApiException implements Exception {
  ApiException(this.statusCode, this.code, this.message);

  final int statusCode;
  final String code;
  final String message;

  @override
  String toString() => 'ApiException($statusCode, $code): $message';
}

class ApiClient {
  ApiClient({required this.baseUrl, http.Client? client}) : _client = client ?? http.Client();

  final String baseUrl;
  final http.Client _client;

  Future<Health> health() async {
    final res = await _client
        .get(Uri.parse('$baseUrl/v1/health'), headers: {'accept': 'application/json'})
        .timeout(const Duration(seconds: 5));
    // The health endpoint returns 503 with a body when the database is down.
    if (res.statusCode == 200 || res.statusCode == 503) {
      return Health.fromJson(jsonDecode(res.body) as Map<String, dynamic>);
    }
    throw _error(res);
  }

  ApiException _error(http.Response res) {
    try {
      final body = jsonDecode(res.body) as Map<String, dynamic>;
      return ApiException(res.statusCode, body['code'] as String? ?? 'http_error',
          body['message'] as String? ?? 'Request failed');
    } catch (_) {
      return ApiException(res.statusCode, 'http_error', 'Request failed (${res.statusCode})');
    }
  }
}
