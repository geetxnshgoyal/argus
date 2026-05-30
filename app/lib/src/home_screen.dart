import 'package:flutter/material.dart';

import 'api_client.dart';
import 'package:argus_security/argus_security.dart';

/// M0 shell: proves the app reaches the API and the native security module.
/// Sign-in (M1), device binding (M3) and scanning (M4) replace this screen.
class HomeScreen extends StatefulWidget {
  const HomeScreen({super.key, required this.api, required this.security});

  final ApiClient api;
  final SecurityBridge security;

  @override
  State<HomeScreen> createState() => _HomeScreenState();
}

class _HomeScreenState extends State<HomeScreen> {
  late Future<Health> _health;
  late Future<PlatformSecurityInfo> _security;

  @override
  void initState() {
    super.initState();
    _refresh();
  }

  void _refresh() {
    setState(() {
      _health = widget.api.health();
      _security = widget.security.platformInfo();
    });
  }

  @override
  Widget build(BuildContext context) {
    final text = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Argus')),
      body: ListView(
        padding: const EdgeInsets.all(20),
        children: [
          Text('Student app', style: text.headlineSmall),
          const SizedBox(height: 4),
          Text('Sign-in and attendance arrive in later milestones.', style: text.bodyMedium),
          const SizedBox(height: 24),
          FutureBuilder<Health>(
            future: _health,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const _StatusTile(icon: Icons.sync, label: 'Checking server…');
              }
              if (snap.hasError) {
                return const _StatusTile(icon: Icons.cloud_off, label: 'Server unreachable', bad: true);
              }
              final h = snap.data!;
              return _StatusTile(
                icon: h.ok ? Icons.check_circle : Icons.error,
                label: h.ok ? 'Server OK (v${h.version})' : 'Server database unavailable',
                bad: !h.ok,
              );
            },
          ),
          FutureBuilder<PlatformSecurityInfo>(
            future: _security,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) {
                return const _StatusTile(icon: Icons.sync, label: 'Checking device security…');
              }
              if (snap.hasError) {
                return const _StatusTile(icon: Icons.error, label: 'Device security check failed', bad: true);
              }
              final s = snap.data!;
              final store = s.platform == 'ios' ? 'Secure Enclave' : 'StrongBox';
              return _StatusTile(
                icon: Icons.phonelink_lock,
                label: '${s.model} · ${s.platform} ${s.osVersion} · $store ${s.hardwareKeyStore ? 'available' : 'not available'}',
              );
            },
          ),
          const SizedBox(height: 16),
          OutlinedButton.icon(onPressed: _refresh, icon: const Icon(Icons.refresh), label: const Text('Check again')),
        ],
      ),
    );
  }
}

class _StatusTile extends StatelessWidget {
  const _StatusTile({required this.icon, required this.label, this.bad = false});

  final IconData icon;
  final String label;
  final bool bad;

  @override
  Widget build(BuildContext context) {
    final color = bad ? Theme.of(context).colorScheme.error : null;
    return ListTile(
      contentPadding: EdgeInsets.zero,
      leading: Icon(icon, color: color),
      title: Text(label, style: TextStyle(color: color)),
    );
  }
}
