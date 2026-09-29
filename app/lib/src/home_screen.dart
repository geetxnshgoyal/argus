import 'dart:async';

import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'device_controller.dart';
import 'screens/history_screen.dart';
import 'screens/notices_screen.dart';
import 'screens/profile_screen.dart';
import 'screens/requests_screen.dart';
import 'screens/timetable_screen.dart';
import 'screens/scan_screen.dart';
import 'screens/support_sheet.dart';
import 'theme.dart';
import 'widgets.dart';

/// Signed-in shell with five tabs: Home (scan + today), Timetable, Attendance,
/// Requests (OD & issues) and Profile. Home owns the phone registration and the
/// polling for running attendance, so they keep working whichever tab is open.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.security, this.today});

  final AuthController auth;
  final SecurityBridge security;

  /// Injectable for tests; defaults to the phone's date.
  final DateTime? today;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> with WidgetsBindingObserver {
  late Future<List<ClassSession>> _classes;
  late final DeviceController _phone = DeviceController(widget.auth.api, widget.security);
  late final AttemptSender _sender = AttemptSender(widget.auth.api, widget.security);
  late final SupportSender _support = SupportSender(widget.auth.api, widget.security);
  List<ActiveAttendance> _active = const [];
  Map<String, dynamic>? _supportStatus;
  List<AppNotice> _notices = const [];
  Timer? _poll;
  int _ticks = 0;

  PhoneState? _lastPhoneState;
  int _tab = 0;
  // Tabs are built the first time they are opened, then kept.
  final Set<int> _visited = {0};

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addObserver(this);
    // As soon as the phone becomes registered, check for running attendance (no 8 s wait).
    _phone.addListener(() {
      if (_phone.state == PhoneState.active && _lastPhoneState != PhoneState.active) unawaited(_loadActive());
      _lastPhoneState = _phone.state;
    });
    _refresh();
    _startPolling();
    unawaited(_registerPush());
  }

  /// Android: allow notifications and tell Argus where to send them (ADR-0025). Quietly does
  /// nothing on iPhones and in builds without Firebase settings.
  Future<void> _registerPush() async {
    try {
      await widget.security.requestNotificationPermission();
      final token = await widget.security.pushToken();
      if (token != null) await widget.auth.api.registerPushToken(token, 'android');
    } catch (_) {
      // No notifications this time; notices are still in the app.
    }
  }

  @override
  void dispose() {
    WidgetsBinding.instance.removeObserver(this);
    _poll?.cancel();
    _phone.dispose();
    super.dispose();
  }

  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    // Poll only while the app is on screen.
    if (state == AppLifecycleState.resumed) {
      _startPolling();
      unawaited(_loadActive());
      unawaited(_loadNotices());
    } else if (state == AppLifecycleState.paused) {
      _poll?.cancel();
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) {
      unawaited(_loadActive());
      // Notices change rarely: about once a minute is plenty.
      if (++_ticks % 8 == 0) unawaited(_loadNotices());
    });
  }

  Future<void> _loadNotices() async {
    try {
      final n = await widget.auth.api.notices();
      if (mounted) setState(() => _notices = n);
    } catch (_) {
      // Offline: keep the last list.
    }
  }

  Future<void> _openNotices() async {
    await Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => NoticesScreen(api: widget.auth.api)));
    unawaited(_loadNotices());
  }

  Future<void> _loadActive() async {
    if (_phone.state != PhoneState.active) return;
    try {
      final a = await widget.auth.api.activeAttendance();
      Map<String, dynamic>? support;
      if (a.isNotEmpty) {
        final mine = await widget.auth.api.mySupportRequests();
        support = mine.where((r) => r['attendance_session_id'] == a.first.sessionId).firstOrNull;
      }
      if (mounted) {
        setState(() {
          _active = a;
          _supportStatus = support;
        });
      }
    } catch (_) {
      // Offline: keep showing the last state.
    }
  }

  void _refresh() {
    setState(() {
      _classes = widget.auth.api.timetable();
    });
    unawaited(_phone.load().then((_) => _loadActive()));
    unawaited(_loadNotices());
  }

  Future<void> _scan(ActiveAttendance a) async {
    await Navigator.of(context).push(MaterialPageRoute<bool>(
      builder: (_) => ScanScreen(attendance: a, deviceId: _phone.deviceId!, sender: _sender, security: widget.security, onAskHelp: (ctx) => _askHelp(ctx, a)),
    ));
    unawaited(_loadActive());
  }

  Future<void> _askHelp(BuildContext ctx, ActiveAttendance a) async {
    await showSupportSheet(ctx, sender: _support, attendanceSessionId: a.sessionId, deviceId: _phone.deviceId!);
    unawaited(_loadActive());
  }

  @override
  Widget build(BuildContext context) {
    final unread = _notices.where((n) => !n.read).length;
    final tabs = <Widget Function()>[
      _homeTab,
      () => TimetableScreen(api: widget.auth.api, today: widget.today),
      () => HistoryScreen(api: widget.auth.api),
      () => RequestsScreen(api: widget.auth.api),
      () => ProfileScreen(auth: widget.auth, security: widget.security, phone: _phone, unreadNotices: unread, onOpenNotices: _openNotices),
    ];
    return Scaffold(
      body: IndexedStack(
        index: _tab,
        children: [for (var i = 0; i < tabs.length; i++) _visited.contains(i) ? tabs[i]() : const SizedBox.shrink()],
      ),
      bottomNavigationBar: NavigationBar(
        selectedIndex: _tab,
        onDestinationSelected: (i) => setState(() {
          _tab = i;
          _visited.add(i);
        }),
        destinations: [
          const NavigationDestination(icon: Icon(Icons.qr_code_scanner), label: 'Home'),
          const NavigationDestination(icon: Icon(Icons.calendar_month_outlined), selectedIcon: Icon(Icons.calendar_month), label: 'Timetable'),
          const NavigationDestination(icon: Icon(Icons.insights_outlined), selectedIcon: Icon(Icons.insights), label: 'Attendance'),
          const NavigationDestination(icon: Icon(Icons.badge_outlined), selectedIcon: Icon(Icons.badge), label: 'Requests'),
          NavigationDestination(
            icon: Badge(isLabelVisible: unread > 0, label: Text('$unread'), backgroundColor: ArgusColors.accent, child: const Icon(Icons.person_outline)),
            selectedIcon: const Icon(Icons.person),
            label: 'Profile',
          ),
        ],
      ),
    );
  }

  DateTime _now() => widget.today ?? DateTime.now();

  /// Home tab: greeting, new notices, the class on now, the scan card, and today's classes.
  Widget _homeTab() {
    final me = widget.auth.me!;
    final text = Theme.of(context).textTheme;
    final unread = _notices.where((n) => !n.read).toList();
    return Scaffold(
      appBar: AppBar(
        title: const ArgusWordmark(size: 20),
        actions: [
          IconButton(
            tooltip: 'Notices',
            onPressed: _openNotices,
            icon: Badge(isLabelVisible: unread.isNotEmpty, label: Text('${unread.length}'), backgroundColor: ArgusColors.accent, child: const Icon(Icons.notifications_outlined)),
          ),
        ],
      ),
      body: RefreshIndicator(
        onRefresh: () async => _refresh(),
        child: ListView(
          padding: const EdgeInsets.fromLTRB(20, 8, 20, 32),
          children: [
            Text('Hi, ${me.name.split(' ').first}', style: text.headlineSmall),
            const SizedBox(height: 4),
            Text('${me.usn ?? ''}${me.section != null ? ' · ${me.section}' : ''}${me.batch != null ? ' · ${me.batch}' : ''}', style: text.bodyMedium),
            const SizedBox(height: 20),
            // Unread notices first: a cancelled or moved class matters before anything else.
            if (unread.isNotEmpty) ...[
              NoticeCard(notice: unread.first, onTap: _openNotices),
              if (unread.length > 1)
                Align(alignment: Alignment.centerRight, child: TextButton(onPressed: _openNotices, child: Text('${unread.length - 1} more new notice${unread.length > 2 ? 's' : ''}'))),
              const SizedBox(height: 16),
            ],
            FutureBuilder<List<ClassSession>>(
              future: _classes,
              builder: (context, snap) => snap.hasData ? _NowNext(classes: snap.data!, now: _now()) : const SizedBox.shrink(),
            ),
            ListenableBuilder(
              listenable: _phone,
              builder: (context, _) => _AttendanceCard(phone: _phone, active: _active, support: _supportStatus, onScan: _scan, onAskHelp: (a) => _askHelp(context, a)),
            ),
            const SizedBox(height: 16),
            FutureBuilder<List<ClassSession>>(
              future: _classes,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Card(child: Padding(padding: EdgeInsets.all(20), child: InfoRow(icon: Icons.calendar_today, title: 'Today', value: 'Loading…')));
                }
                if (snap.hasError) {
                  return const Card(child: Padding(padding: EdgeInsets.all(20), child: InfoRow(icon: Icons.calendar_today, tone: TileTone.bad, title: 'Today', value: 'Could not load your timetable.')));
                }
                return _Today(
                  classes: snap.data!,
                  today: widget.today ?? DateTime.now(),
                  onOpenTimetable: () => setState(() {
                    _tab = 1;
                    _visited.add(1);
                  }),
                );
              },
            ),
          ],
        ),
      ),
    );
  }
}

/// The class on right now (or the next one): subject, topic, time, room, teacher.
class _NowNext extends StatelessWidget {
  const _NowNext({required this.classes, required this.now});
  final List<ClassSession> classes;
  final DateTime now;

  String _when(ClassSession c) {
    final mins = c.startsAt.difference(now).inMinutes;
    if (isoDate(c.startsAt) == isoDate(now)) return mins < 60 ? 'Next · in $mins min' : 'Next · at ${c.start}';
    return 'Next · ${dayLabel(c.date, now)}';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final live = classes.where((c) => !c.cancelled && !c.startsAt.isAfter(now) && now.isBefore(c.endsAt)).firstOrNull;
    final c = live ?? classes.where((c) => !c.cancelled && c.startsAt.isAfter(now)).firstOrNull;
    if (c == null) return const SizedBox.shrink();
    Widget line(IconData icon, String text) => Padding(
          padding: const EdgeInsets.only(top: 6),
          child: Row(children: [
            Icon(icon, size: 18, color: ArgusColors.fg2),
            const SizedBox(width: 10),
            Expanded(child: Text(text, style: t.bodyMedium?.copyWith(color: ArgusColors.fg))),
          ]),
        );
    return Padding(
      padding: const EdgeInsets.only(bottom: 16),
      child: Card(
        child: Padding(
          padding: const EdgeInsets.all(20),
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            StatusBadge(live != null ? 'Now · until ${c.end}' : _when(c), live != null ? ArgusColors.accent : ArgusColors.fg2),
            const SizedBox(height: 10),
            Text(c.subjectName, style: t.titleLarge),
            if (c.subjectName != c.subjectCode) Text(c.subjectCode, style: t.bodySmall),
            if (c.topic != null) ...[
              const SizedBox(height: 8),
              Container(
                width: double.infinity,
                padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
                decoration: BoxDecoration(color: ArgusColors.surface2, borderRadius: BorderRadius.circular(10)),
                child: Text('Topic: ${c.topic}', style: t.bodyMedium?.copyWith(color: ArgusColors.fg)),
              ),
            ],
            const SizedBox(height: 4),
            line(Icons.schedule, '${c.start}–${c.end}'),
            line(Icons.meeting_room_outlined, c.room ?? 'Room not set'),
            line(Icons.person_outline, c.teacher ?? 'Teacher not set'),
            if (c.batch != null) line(Icons.groups_outlined, c.batch!),
          ]),
        ),
      ),
    );
  }
}

/// Today's classes on Home, or the next day with classes; the full week is on the Timetable tab.
class _Today extends StatelessWidget {
  const _Today({required this.classes, required this.today, required this.onOpenTimetable});

  final List<ClassSession> classes;
  final DateTime today;
  final VoidCallback onOpenTimetable;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final todayIso = isoDate(today);
    final todays = classes.where((c) => c.date == todayIso).toList();
    final next = todays.isEmpty ? classes.where((c) => c.date.compareTo(todayIso) > 0 && !c.cancelled).toList() : <ClassSession>[];
    final nextDate = next.isEmpty ? null : next.first.date;
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(children: [
              const IconTile(Icons.calendar_today, size: 40),
              const SizedBox(width: 14),
              Expanded(child: Text('Today', style: t.titleMedium)),
              TextButton(onPressed: onOpenTimetable, child: const Text('Full timetable')),
            ]),
            const SizedBox(height: 8),
            if (todays.isNotEmpty)
              for (final c in todays) ClassTile(c)
            else ...[
              Text('No classes today.', style: t.bodyMedium),
              if (nextDate != null) ...[
                const SizedBox(height: 14),
                Text('Next: ${dayLabel(nextDate, today)}', style: t.titleSmall?.copyWith(color: ArgusColors.accent, fontWeight: FontWeight.w700)),
                const SizedBox(height: 4),
                for (final c in next.where((c) => c.date == nextDate)) ClassTile(c),
              ],
            ],
          ],
        ),
      ),
    );
  }
}

/// The main attendance card: register this phone, then "Scan now" whenever a teacher starts attendance.
class _AttendanceCard extends StatelessWidget {
  const _AttendanceCard({required this.phone, required this.active, required this.onScan, required this.onAskHelp, this.support});

  final DeviceController phone;
  final List<ActiveAttendance> active;
  final Map<String, dynamic>? support;
  final Future<void> Function(ActiveAttendance) onScan;
  final Future<void> Function(ActiveAttendance) onAskHelp;

  static String _supportText(Map<String, dynamic> r) => switch (r['status']) {
        'pending' => 'Help requested: Academic Operations is checking.',
        'asked_teacher' => 'Help requested: your teacher is being asked to confirm you are here.',
        'approved' => 'Your help request was approved: you are marked present.',
        'rejected' => 'Help request not approved${r['decision_reason'] != null ? ': ${r['decision_reason']}' : '.'}',
        _ => 'Help request closed.',
      };

  String _when(DateTime? d) {
    if (d == null) return 'soon';
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '${d.day} ${kMonths[d.month - 1]}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    Widget body;
    switch (phone.state) {
      case PhoneState.loading:
        body = const InfoRow(icon: Icons.qr_code_scanner, title: 'Mark attendance', value: 'Checking this phone…');
      case PhoneState.error:
        body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          InfoRow(icon: Icons.qr_code_scanner, tone: TileTone.bad, title: 'Mark attendance', value: phone.error ?? 'Could not check this phone.'),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: phone.load, child: const Text('Try again')),
        ]);
      case PhoneState.unregistered:
      case PhoneState.otherPhoneActive:
        final other = phone.state == PhoneState.otherPhoneActive;
        body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          InfoRow(
            icon: Icons.phonelink_lock_outlined,
            tone: TileTone.warn,
            title: other ? 'Attendance is on another phone' : 'Register this phone',
            value: other
                ? 'Your attendance phone is ${phone.status?.activeDevice?['model'] ?? 'another phone'}. You can switch to this phone: it becomes active after a waiting period, and your old phone keeps working until then.'
                : 'Attendance works only on your own registered phone. You\'ll confirm with your fingerprint, face or PIN.',
          ),
          if (phone.error != null) ...[const SizedBox(height: 10), Text(phone.error!, style: const TextStyle(color: ArgusColors.bad))],
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: phone.busy ? null : phone.register,
            icon: phone.busy ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2)) : const Icon(Icons.verified_user_outlined),
            label: Text(other ? 'Use this phone instead' : 'Register this phone'),
          ),
        ]);
      case PhoneState.biometricsChanged:
        body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          const InfoRow(
            icon: Icons.fingerprint,
            tone: TileTone.warn,
            title: 'Register this phone again',
            value: 'A face or fingerprint was added or removed on this phone, so its attendance key stopped working. '
                'Register again; Academic Operations will check it is still you before it works.',
          ),
          if (phone.error != null) ...[const SizedBox(height: 10), Text(phone.error!, style: const TextStyle(color: ArgusColors.bad))],
          const SizedBox(height: 14),
          FilledButton.icon(
            onPressed: phone.busy ? null : () => phone.register(reason: 'biometrics_changed'),
            icon: const Icon(Icons.verified_user_outlined),
            label: const Text('Register again'),
          ),
        ]);
      case PhoneState.pending:
        final s = phone.status;
        body = InfoRow(
          icon: Icons.hourglass_top,
          tone: TileTone.warn,
          title: 'This phone is waiting',
          value: s?.rebindNeedsApproval == true
              ? '${s?.rebindReason ?? ''} Visit Academic Operations with your ID card to activate it.'
              : 'It becomes your attendance phone on ${_when(s?.rebindEligibleAt)}. Until then use your old phone, or visit Academic Operations to activate it sooner.',
        );
      case PhoneState.active:
        final a = active.isEmpty ? null : active.first;
        if (a == null) {
          body = const InfoRow(icon: Icons.qr_code_scanner, title: 'Mark attendance', value: 'Nothing to scan right now. When your teacher starts attendance, a Scan button appears here.');
        } else if (a.action == 'scan') {
          body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            InfoRow(icon: Icons.qr_code_scanner, title: a.round > 1 ? 'Recheck: scan again' : 'Attendance is open', value: '${a.cls.subjectName} · ${a.cls.room ?? 'Room TBA'}'),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(onPressed: () => onScan(a), icon: const Icon(Icons.qr_code_scanner), label: const Text('Scan now')),
            ),
            if (support != null) ...[
              const SizedBox(height: 10),
              Text(_supportText(support!), style: TextStyle(color: support!['status'] == 'rejected' ? ArgusColors.bad : ArgusColors.warn)),
            ] else
              TextButton(onPressed: () => onAskHelp(a), child: const Text("Can't scan? Ask for help")),
          ]);
        } else if (a.action == 'done') {
          final flagged = a.decision == 'flagged' || a.decision == 'flagged_high';
          body = InfoRow(
            icon: Icons.check_circle_outline,
            tone: flagged ? TileTone.warn : TileTone.good,
            title: flagged ? 'Marked, teacher may confirm' : 'You\'re marked present',
            value: '${a.cls.subjectName}${a.round > 1 ? ' · round ${a.round}' : ''}',
          );
        } else {
          body = InfoRow(icon: Icons.check_circle_outline, title: 'You\'re verified', value: 'Nothing to do in this recheck (${a.cls.subjectCode}).');
        }
    }
    if (phone.state == PhoneState.active && active.isNotEmpty && active.first.shadow) {
      body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
        body,
        const SizedBox(height: 12),
        const Text('Pilot: this attendance is recorded but not official yet. Your teacher also takes the usual roll call.', style: TextStyle(color: ArgusColors.warn)),
      ]);
    }
    return Card(child: Padding(padding: const EdgeInsets.all(20), child: DefaultTextStyle.merge(style: t.bodyMedium, child: body)));
  }
}
