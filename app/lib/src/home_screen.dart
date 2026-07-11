import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'theme.dart';

/// Signed-in home: who I am, my classes for the coming week, and device status.
/// Scanning (M4) plugs into the "Mark attendance" card.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.security, this.today});

  final AuthController auth;
  final SecurityBridge security;

  /// Injectable for tests; defaults to the phone's date.
  final DateTime? today;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<Health> _health;
  late Future<PlatformSecurityInfo> _device;
  late Future<List<ClassSession>> _classes;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  void _refresh() {
    setState(() {
      _health = widget.auth.api.health();
      _device = widget.security.platformInfo();
      _classes = widget.auth.api.timetable();
    });
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
            const Card(
              child: Padding(
                padding: EdgeInsets.all(20),
                child: _Row(
                  icon: Icons.qr_code_scanner,
                  title: 'Mark attendance',
                  value: 'Scanning opens when your teacher starts attendance (coming soon).',
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
