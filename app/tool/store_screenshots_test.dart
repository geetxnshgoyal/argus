// Google Play / App Store screenshots of the real screens with sample data.
//
//   cd app && flutter test tool/store_screenshots_test.dart
//
// Writes 1080×1920 PNGs to brand/store/. Uses the Roboto and Material icon fonts that ship
// with the Flutter SDK (tests otherwise draw text as boxes). Not part of `flutter test`.
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:argus/main.dart';
import 'package:argus/src/api_client.dart';
import 'package:argus/src/auth_controller.dart';
import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

String _d(DateTime t) => '${t.year}-${t.month.toString().padLeft(2, '0')}-${t.day.toString().padLeft(2, '0')}';
String _hm(DateTime t) => '${t.hour.toString().padLeft(2, '0')}:${t.minute.toString().padLeft(2, '0')}';

Map<String, dynamic> _class(String id, DateTime start, int minutes, String code, String name, String room, String teacher,
    {String? topic, String status = 'scheduled', bool changed = false, String? batch}) {
  final end = start.add(Duration(minutes: minutes));
  return {
    'id': id, 'date': _d(start), 'start': _hm(start), 'end': _hm(end), 'starts_at': start.toUtc().toIso8601String(), 'ends_at': end.toUtc().toIso8601String(),
    'status': status, 'changed': changed, 'entry_id': 'e$id', 'subject': {'code': code, 'name': name, 'kind': 'lecture'}, 'topic': topic,
    'section': {'id': 'sec', 'name': 'CSE 2nd Year · Section A'}, 'batch': batch, 'room': room, 'teacher': teacher,
  };
}

/// Sample data for one student, Aditi Verma, on a normal teaching day.
http.Client _server() {
  final now = DateTime.now();
  final today = DateTime(now.year, now.month, now.day);
  final live = DateTime(now.year, now.month, now.day, now.hour, now.minute).subtract(const Duration(minutes: 12));
  DateTime at(int day, int h, int m) => today.add(Duration(days: day, hours: h, minutes: m));
  final ds = _class('c1', live, 60, 'CS201', 'Data Structures', 'Room 101', 'Dr. Ananya Rao', topic: 'Binary search trees: insertion and deletion');
  final week = [
    ds,
    _class('c2', live.add(const Duration(minutes: 75)), 60, 'CS202', 'Database Systems', 'Room 101', 'Prof. Vikram Mehta', topic: 'Normalisation (1NF to BCNF)'),
    _class('c3', live.add(const Duration(minutes: 150)), 120, 'CS201L', 'Data Structures Lab', 'Lab 1', 'Dr. Ananya Rao', batch: 'Batch A1'),
    _class('c4', at(1, 9, 0), 60, 'CS203', 'Operating Systems', 'Room 101', 'Dr. Sana Khan', topic: 'CPU scheduling'),
    _class('c5', at(1, 10, 0), 60, 'MA201', 'Discrete Mathematics', 'Room 101', 'Dr. Sana Khan', status: 'cancelled', changed: true),
    _class('c6', at(1, 11, 15), 60, 'CS201', 'Data Structures', 'Seminar Hall', 'Dr. Ananya Rao', changed: true),
    _class('c7', at(2, 9, 0), 60, 'CS204', 'Computer Networks', 'Room 101', 'Prof. Rahul Iyer', topic: 'The TCP handshake'),
    _class('c8', at(2, 10, 0), 60, 'CS201', 'Data Structures', 'Room 101', 'Dr. Ananya Rao'),
  ];
  Map<String, dynamic> subject(String code, String name, int total, int attended, int late) =>
      {'code': code, 'name': name, 'total': total, 'attended': attended, 'late': late, 'absent': total - attended, 'percent': attended * 100 / total};
  return MockClient((req) async {
    http.Response json(Object body) => http.Response(jsonEncode(body), 200, headers: {'content-type': 'application/json'});
    switch ('${req.method} ${req.url.path}') {
      case 'POST /v1/auth/refresh':
        return json({'access_token': 'a', 'refresh_token': 'r', 'expires_in': 900, 'token_type': 'Bearer'});
      case 'GET /v1/me':
        return json({
          'user': {'id': 'u1', 'role': 'student', 'name': 'Aditi Verma', 'email': 'aditi.verma@example.edu'},
          'home': '/student', 'csrf_token': null, 'policy': {'version': 'v1', 'accepted': true},
          'student': {'usn': '1DM25CS002', 'program': 'B.Tech Computer Science', 'section': 'CSE 2nd Year · Section A', 'batch': 'Batch A1'},
        });
      case 'GET /v1/me/timetable':
        return json({'from': _d(today), 'to': _d(today.add(const Duration(days: 6))), 'items': week});
      case 'GET /v1/devices/me':
        return json({
          'this_device_id': 'd1',
          'devices': [
            {'id': 'd1', 'state': 'active', 'platform': 'android', 'model': 'Pixel 8', 'os_version': '15', 'app_version': '0.0.10', 'attestation_level': 'strongbox', 'bound_at': '2026-10-01T04:00:00Z', 'activated_at': '2026-10-01T04:00:00Z'},
          ],
          'rebind': null,
        });
      case 'GET /v1/me/sessions/active':
        return json({'items': [
          {'attendance_session_id': 'a1', 'class': ds, 'round': 1, 'mode': 'full', 'action': 'scan', 'decision': null, 'shadow': false},
        ]});
      case 'GET /v1/me/support-requests':
        return json({'items': []});
      case 'GET /v1/me/notices':
        return json({'items': [
          {'id': 'n1', 'kind': 'class_change', 'title': 'Tomorrow: Discrete Mathematics cancelled', 'body': 'Dr. Sana Khan is away. Data Structures moves to the Seminar Hall at 11:15.', 'created_at': now.toUtc().toIso8601String(), 'read': true, 'class_date': _d(at(1, 0, 0))},
        ]});
      case 'GET /v1/me/attendance':
        return json({'subjects': [
          subject('CS201', 'Data Structures', 24, 23, 1),
          subject('CS202', 'Database Systems', 18, 17, 0),
          subject('CS203', 'Operating Systems', 18, 15, 2),
          subject('CS204', 'Computer Networks', 16, 16, 0),
          subject('MA201', 'Discrete Mathematics', 14, 12, 1),
          subject('CS201L', 'Data Structures Lab', 8, 8, 0),
        ], 'recent': [], 'shadow_mode': false});
      case 'GET /v1/me/od-requests':
        return json({'items': [
          {'id': 'od1', 'kind': 'days', 'dates': [_d(at(5, 0, 0)), _d(at(6, 0, 0))], 'classes': [], 'event': 'Inter-college hackathon (regional round)',
            'reason': 'Representing the college with the coding club.', 'status': 'pending_ops', 'rejected_by_role': null, 'created_at': now.toUtc().toIso8601String(),
            'student': {'name': 'Aditi Verma', 'usn': '1DM25CS002', 'section': null}, 'community_manager': {'name': 'Kavya Menon', 'note': 'On the event list.'}, 'acadops': null, 'attachments': [{'id': 'f1', 'filename': 'invitation.pdf', 'size': 182000}]},
          {'id': 'od2', 'kind': 'days', 'dates': [_d(at(-9, 0, 0))], 'classes': [], 'event': 'State basketball tournament', 'reason': 'College team.',
            'status': 'approved', 'rejected_by_role': null, 'created_at': at(-12, 9, 0).toUtc().toIso8601String(), 'student': {'name': 'Aditi Verma', 'usn': '1DM25CS002', 'section': null},
            'community_manager': {'name': 'Kavya Menon', 'note': null}, 'acadops': {'name': 'Meera Nair', 'note': 'Approved.'}, 'attachments': []},
        ]});
      case 'GET /v1/me/attendance-issues':
        return json({'items': [
          {'id': 'i1', 'reason': 'marked_absent_but_present', 'note': 'My phone battery died before I could scan.', 'status': 'resolved', 'teacher_note': 'She was in the second row.',
            'correction_id': 'c1', 'created_at': at(-3, 12, 0).toUtc().toIso8601String(), 'resolved_at': at(-2, 10, 0).toUtc().toIso8601String(), 'record_status': 'present',
            'student': {'name': 'Aditi Verma', 'usn': '1DM25CS002'}, 'teacher': 'Prof. Vikram Mehta',
            'class': {'id': 'p1', 'date': _d(at(-3, 0, 0)), 'start': '10:00', 'code': 'CS202', 'name': 'Database Systems'}},
        ]});
      case 'GET /v1/health':
        return json({'status': 'ok', 'version': '0.0.10', 'db': 'ok'});
    }
    return http.Response(jsonEncode({'code': 'not_found', 'message': 'Not found'}), 404);
  });
}

Future<void> _loadFonts() async {
  // The test runs on …/flutter/bin/cache/dart-sdk/bin/dart; the fonts are in …/bin/cache/artifacts.
  var cache = File(Platform.resolvedExecutable).parent;
  while (cache.path != cache.parent.path && !cache.path.endsWith('/cache')) {
    cache = cache.parent;
  }
  final fonts = Directory('${cache.path}/artifacts/material_fonts');
  // Styles that name no font get the test font ("FlutterTest" or "Ahem") in tests and Roboto on phones.
  for (final family in ['Roboto', 'FlutterTest', 'Ahem']) {
    final roboto = FontLoader(family);
    for (final w in ['Regular', 'Medium', 'Bold', 'Light']) {
      roboto.addFont(Future.value(ByteData.sublistView(File('${fonts.path}/Roboto-$w.ttf').readAsBytesSync())));
    }
    await roboto.load();
  }
  final icons = FontLoader('MaterialIcons')..addFont(Future.value(ByteData.sublistView(File('${fonts.path}/MaterialIcons-Regular.otf').readAsBytesSync())));
  await icons.load();
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  testWidgets('store screenshots', (tester) async {
    await tester.runAsync(_loadFonts);
    tester.view.physicalSize = const Size(1080, 1920);
    tester.view.devicePixelRatio = 2.625; // a 411-point-wide phone, like a Pixel
    addTearDown(tester.view.reset);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger.setMockMethodCallHandler(const MethodChannel(SecurityBridge.channelName), (call) async {
      switch (call.method) {
        case 'platformInfo':
          return {'platform': 'android', 'osVersion': '15', 'model': 'Pixel 8', 'hardwareKeyStore': true};
        case 'sessionPublicKey':
          return 'spki';
        case 'signWithSessionKey':
          return 'sig';
        case 'attemptKeyStatus':
          return 'ok';
      }
      return null;
    });

    final store = MemoryTokenStore()..value = 'r';
    final api = ApiClient(baseUrl: 'http://test', security: SecurityBridge(), store: store, client: _server());
    final auth = AuthController(api, browserAuth: (url, scheme) async => '');
    final key = GlobalKey();
    await tester.pumpWidget(RepaintBoundary(key: key, child: ArgusApp(auth: auth, security: SecurityBridge())));
    await auth.start();
    await tester.pumpAndSettle();

    final out = Directory('../brand/store')..createSync(recursive: true);
    Future<void> shot(String name) async {
      await tester.pumpAndSettle();
      // Tests don't decode images unless asked (the logo).
      await tester.runAsync(() async {
        for (final e in find.byType(Image).evaluate()) {
          await precacheImage((e.widget as Image).image, e);
        }
      });
      await tester.pumpAndSettle();
      final boundary = key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2.625);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        File('${out.path}/$name.png').writeAsBytesSync(png!.buffer.asUint8List());
      });
    }

    await shot('phone-1-home');
    for (final (tab, name) in [('Timetable', 'phone-2-timetable'), ('Attendance', 'phone-3-attendance'), ('Requests', 'phone-4-requests')]) {
      await tester.tap(find.descendant(of: find.byType(NavigationBar), matching: find.text(tab)));
      await shot(name);
    }
  });
}
