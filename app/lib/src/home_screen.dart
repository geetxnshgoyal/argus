import 'dart:async';

import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'device_controller.dart';
import 'screens/history_screen.dart';
import 'screens/scan_screen.dart';
import 'theme.dart';

/// Signed-in home: attendance (register this phone, scan when a class is running),
/// my classes for the coming week, and phone/server status.
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
  late Future<Health> _health;
  late Future<PlatformSecurityInfo> _device;
  late Future<List<ClassSession>> _classes;
  late final DeviceController _phone = DeviceController(widget.auth.api, widget.security);
  late final AttemptSender _sender = AttemptSender(widget.auth.api, widget.security);
  List<ActiveAttendance> _active = const [];
  Timer? _poll;

  PhoneState? _lastPhoneState;

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
    } else if (state == AppLifecycleState.paused) {
      _poll?.cancel();
    }
  }

  void _startPolling() {
    _poll?.cancel();
    _poll = Timer.periodic(const Duration(seconds: 8), (_) => unawaited(_loadActive()));
  }

  Future<void> _loadActive() async {
    if (_phone.state != PhoneState.active) return;
    try {
      final a = await widget.auth.api.activeAttendance();
      if (mounted) setState(() => _active = a);
    } catch (_) {
      // Offline: keep showing the last state.
    }
  }

  void _refresh() {
    setState(() {
      _health = widget.auth.api.health();
      _device = widget.security.platformInfo();
      _classes = widget.auth.api.timetable();
    });
    unawaited(_phone.load().then((_) => _loadActive()));
  }

  Future<void> _scan(ActiveAttendance a) async {
    await Navigator.of(context).push(MaterialPageRoute<bool>(
      builder: (_) => ScanScreen(attendance: a, deviceId: _phone.deviceId!, sender: _sender, security: widget.security),
    ));
    unawaited(_loadActive());
  }

  @override
  Widget build(BuildContext context) {
    final me = widget.auth.me!;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(
        title: const ArgusWordmark(size: 20),
        actions: [IconButton(tooltip: 'Sign out', onPressed: widget.auth.signOut, icon: const Icon(Icons.logout))],
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
            ListenableBuilder(listenable: _phone, builder: (context, _) => _AttendanceCard(phone: _phone, active: _active, onScan: _scan)),
            const SizedBox(height: 16),
            Card(
              child: InkWell(
                borderRadius: BorderRadius.circular(20),
                onTap: () => Navigator.of(context).push(MaterialPageRoute<void>(builder: (_) => HistoryScreen(api: widget.auth.api))),
                child: const Padding(
                  padding: EdgeInsets.all(20),
                  child: Row(children: [
                    Expanded(child: _Row(icon: Icons.insights_outlined, title: 'My attendance', value: 'Percentage per subject')),
                    Icon(Icons.chevron_right, color: ArgusColors.fg3),
                  ]),
                ),
              ),
            ),
            const SizedBox(height: 16),
            FutureBuilder<List<ClassSession>>(
              future: _classes,
              builder: (context, snap) {
                if (snap.connectionState != ConnectionState.done) {
                  return const Card(child: Padding(padding: EdgeInsets.all(20), child: _Row(icon: Icons.calendar_today, title: 'Your classes', value: 'Loading…')));
                }
                if (snap.hasError) {
                  return const Card(
                    child: Padding(padding: EdgeInsets.all(20), child: _Row(icon: Icons.calendar_today, tone: TileTone.bad, title: 'Your classes', value: 'Could not load your timetable.')),
                  );
                }
                return _Timetable(classes: snap.data!, today: widget.today ?? DateTime.now());
              },
            ),
            const SizedBox(height: 16),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(children: [
                  FutureBuilder<Health>(
                    future: _health,
                    builder: (context, s) => _Row(
                      icon: Icons.cloud_done_outlined,
                      tone: s.hasError || (s.hasData && !s.data!.ok) ? TileTone.bad : TileTone.good,
                      title: 'Server',
                      value: s.connectionState != ConnectionState.done
                          ? 'Checking…'
                          : s.hasError
                              ? 'Unreachable'
                              : s.data!.ok
                                  ? 'Connected (v${s.data!.version})'
                                  : 'Database unavailable',
                    ),
                  ),
                  const _Gap(),
                  FutureBuilder<PlatformSecurityInfo>(
                    future: _device,
                    builder: (context, s) {
                      final d = s.data;
                      final store = d?.platform == 'ios' ? 'Secure Enclave' : 'StrongBox';
                      return _Row(
                        icon: Icons.phonelink_lock_outlined,
                        tone: d != null && !d.hardwareKeyStore ? TileTone.warn : TileTone.good,
                        title: 'This phone',
                        value: d == null ? 'Checking…' : '${d.model} · $store ${d.hardwareKeyStore ? 'available' : 'not available'}',
                      );
                    },
                  ),
                ]),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

String _iso(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

const _weekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

class _Timetable extends StatelessWidget {
  const _Timetable({required this.classes, required this.today});

  final List<ClassSession> classes;
  final DateTime today;

  String _dayLabel(String date) {
    final todayIso = _iso(today);
    if (date == todayIso) return 'Today';
    if (date == _iso(today.add(const Duration(days: 1)))) return 'Tomorrow';
    final d = DateTime.parse(date);
    return '${_weekdays[d.weekday - 1]}, ${d.day} ${_months[d.month - 1]}';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    if (classes.isEmpty) {
      return const Card(child: Padding(padding: EdgeInsets.all(20), child: _Row(icon: Icons.calendar_today, title: 'Your classes', value: 'No classes in the next 7 days.')));
    }
    final byDate = <String, List<ClassSession>>{};
    for (final c in classes) {
      byDate.putIfAbsent(c.date, () => []).add(c);
    }
    return Card(
      child: Padding(
        padding: const EdgeInsets.all(20),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Row(children: [IconTile(Icons.calendar_today, size: 40), SizedBox(width: 14), Text('Your classes', style: TextStyle(fontSize: 16, fontWeight: FontWeight.w600))]),
            for (final entry in byDate.entries) ...[
              const SizedBox(height: 18),
              Text(_dayLabel(entry.key), style: t.titleSmall?.copyWith(color: ArgusColors.accent, fontWeight: FontWeight.w700)),
              const SizedBox(height: 8),
              for (final c in entry.value) _ClassTile(c),
            ],
          ],
        ),
      ),
    );
  }
}

class _ClassTile extends StatelessWidget {
  const _ClassTile(this.c);
  final ClassSession c;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final muted = c.cancelled ? const TextStyle(decoration: TextDecoration.lineThrough, color: ArgusColors.fg3) : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 92, child: Text('${c.start}–${c.end}', style: t.bodyMedium?.merge(muted))),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(c.subjectName == c.subjectCode ? c.subjectCode : '${c.subjectCode} · ${c.subjectName}', style: t.titleSmall?.merge(muted)),
                Text([c.room ?? 'Room TBA', if (c.batch != null) c.batch!, if (c.teacher != null) c.teacher!].join(' · '), style: t.bodySmall?.copyWith(color: ArgusColors.fg2)),
                if (c.cancelled) const _Badge('Cancelled', ArgusColors.bad) else if (c.changed) const _Badge('Changed today', ArgusColors.warn),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

class _Badge extends StatelessWidget {
  const _Badge(this.text, this.color);
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(99), border: Border.all(color: color.withValues(alpha: 0.5))),
          child: Text(text, style: TextStyle(color: color, fontSize: 12)),
        ),
      );
}

class _Row extends StatelessWidget {
  const _Row({required this.icon, required this.title, required this.value, this.tone = TileTone.good});

  final IconData icon;
  final String title;
  final String value;
  final TileTone tone;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Row(
      children: [
        IconTile(icon, tone: tone, size: 40),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t.titleMedium),
            const SizedBox(height: 2),
            Text(value, style: t.bodyMedium),
          ]),
        ),
      ],
    );
  }
}

class _Gap extends StatelessWidget {
  const _Gap();
  @override
  Widget build(BuildContext context) => const Padding(padding: EdgeInsets.symmetric(vertical: 14), child: Divider());
}

/// The main attendance card: register this phone, then "Scan now" whenever a teacher starts attendance.
class _AttendanceCard extends StatelessWidget {
  const _AttendanceCard({required this.phone, required this.active, required this.onScan});

  final DeviceController phone;
  final List<ActiveAttendance> active;
  final Future<void> Function(ActiveAttendance) onScan;

  String _when(DateTime? d) {
    if (d == null) return 'soon';
    final h = d.hour % 12 == 0 ? 12 : d.hour % 12;
    return '${d.day} ${_months[d.month - 1]}, $h:${d.minute.toString().padLeft(2, '0')} ${d.hour < 12 ? 'AM' : 'PM'}';
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    Widget body;
    switch (phone.state) {
      case PhoneState.loading:
        body = const _Row(icon: Icons.qr_code_scanner, title: 'Mark attendance', value: 'Checking this phone…');
      case PhoneState.error:
        body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _Row(icon: Icons.qr_code_scanner, tone: TileTone.bad, title: 'Mark attendance', value: phone.error ?? 'Could not check this phone.'),
          const SizedBox(height: 12),
          OutlinedButton(onPressed: phone.load, child: const Text('Try again')),
        ]);
      case PhoneState.unregistered:
      case PhoneState.otherPhoneActive:
        final other = phone.state == PhoneState.otherPhoneActive;
        body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          _Row(
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
      case PhoneState.pending:
        final s = phone.status;
        body = _Row(
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
          body = const _Row(icon: Icons.qr_code_scanner, title: 'Mark attendance', value: 'Nothing to scan right now. When your teacher starts attendance, a Scan button appears here.');
        } else if (a.action == 'scan') {
          body = Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            _Row(icon: Icons.qr_code_scanner, title: a.round > 1 ? 'Recheck: scan again' : 'Attendance is open', value: '${a.cls.subjectName} · ${a.cls.room ?? 'Room TBA'}'),
            const SizedBox(height: 14),
            SizedBox(
              width: double.infinity,
              child: FilledButton.icon(onPressed: () => onScan(a), icon: const Icon(Icons.qr_code_scanner), label: const Text('Scan now')),
            ),
          ]);
        } else if (a.action == 'done') {
          final flagged = a.decision == 'flagged' || a.decision == 'flagged_high';
          body = _Row(
            icon: Icons.check_circle_outline,
            tone: flagged ? TileTone.warn : TileTone.good,
            title: flagged ? 'Marked, teacher may confirm' : 'You\'re marked present',
            value: '${a.cls.subjectName}${a.round > 1 ? ' · round ${a.round}' : ''}',
          );
        } else {
          body = _Row(icon: Icons.check_circle_outline, title: 'You\'re verified', value: 'Nothing to do in this recheck (${a.cls.subjectCode}).');
        }
    }
    return Card(child: Padding(padding: const EdgeInsets.all(20), child: DefaultTextStyle.merge(style: t.bodyMedium, child: body)));
  }
}
