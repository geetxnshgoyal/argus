import 'dart:convert';

/// RFC 8785 JSON Canonicalization Scheme (ADR-0011).
///
/// The app signs these exact bytes and sends them as-is; the server verifies
/// over the bytes it received and never re-serializes, so this only has to be
/// deterministic. It follows JCS anyway: object keys sorted by UTF-16 code
/// units, no whitespace, integral numbers without a fraction.
String canonicalize(Object? v) {
  if (v == null) return 'null';
  if (v is bool) return v ? 'true' : 'false';
  if (v is int) return v.toString();
  if (v is double) {
    if (!v.isFinite) throw ArgumentError('JCS: non-finite number');
    if (v == v.truncateToDouble() && v.abs() < 1e21) return v.toInt().toString();
    return v.toString();
  }
  if (v is String) return jsonEncode(v);
  if (v is List) return '[${v.map(canonicalize).join(',')}]';
  if (v is Map) {
    final keys = v.keys.map((k) => k as String).toList()..sort(); // String.compareTo = UTF-16 code units
    return '{${keys.where((k) => v[k] != null || v.containsKey(k)).map((k) => '${jsonEncode(k)}:${canonicalize(v[k])}').join(',')}}';
  }
  throw ArgumentError('JCS: unsupported type ${v.runtimeType}');
}

List<int> canonicalBytes(Object? v) => utf8.encode(canonicalize(v));

String b64url(List<int> bytes) => base64Url.encode(bytes).replaceAll('=', '');

List<int> b64urlDecode(String s) => base64Url.decode(s.padRight((s.length + 3) ~/ 4 * 4, '='));
