import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import 'api_client.dart';
import 'auth_controller.dart';
import 'theme.dart';

/// Signed-in home. Today's classes (M2) and scanning (M4) replace the
/// placeholders below as those milestones land.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.auth, required this.security});

  final AuthController auth;
  final SecurityBridge security;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<Health> _health;
  late Future<PlatformSecurityInfo> _device;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  void _refresh() {
    setState(() {
      _health = widget.auth.api.health();
      _device = widget.security.platformInfo();
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
            Text(me.email, style: text.bodyMedium),
            const SizedBox(height: 20),
            Card(
              child: Padding(
                padding: const EdgeInsets.all(20),
                child: Column(children: [
                  _Row(icon: Icons.badge_outlined, title: 'USN', value: me.usn ?? '—'),
                  const _Gap(),
                  _Row(icon: Icons.groups_outlined, title: 'Section', value: me.section ?? 'Not assigned'),
                  const _Gap(),
                  _Row(icon: Icons.science_outlined, title: 'Lab batch', value: me.batch ?? 'Not assigned'),
                ]),
              ),
            ),
            const SizedBox(height: 16),
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
  Widget build(BuildContext context) =>
      const Padding(padding: EdgeInsets.symmetric(vertical: 14), child: Divider());
}
