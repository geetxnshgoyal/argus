import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';

import '../api_client.dart';
import '../auth_controller.dart';
import '../device_controller.dart';
import '../theme.dart';
import '../widgets.dart';

/// Profile tab: who I am, this phone's registration, the server, notices, sign out.
class ProfileScreen extends StatefulWidget {
  const ProfileScreen({super.key, required this.auth, required this.security, required this.phone, required this.unreadNotices, required this.onOpenNotices});

  final AuthController auth;
  final SecurityBridge security;
  final DeviceController phone;
  final int unreadNotices;
  final VoidCallback onOpenNotices;

  @override
  State<ProfileScreen> createState() => _ProfileScreenState();
}

class _ProfileScreenState extends State<ProfileScreen> {
  late Future<Health> _health = widget.auth.api.health();
  late final Future<PlatformSecurityInfo> _device = widget.security.platformInfo();

  String _phoneStatus(PhoneState s) => switch (s) {
        PhoneState.loading => 'Checking…',
        PhoneState.active => 'Registered for attendance',
        PhoneState.pending => 'Waiting to become your attendance phone',
        PhoneState.unregistered => 'Not registered yet (see Home)',
        PhoneState.otherPhoneActive => 'Another phone is your attendance phone',
        PhoneState.biometricsChanged => 'Face or fingerprint changed: register again (see Home)',
        PhoneState.error => 'Could not check',
      };

  Future<void> _confirmSignOut() async {
    final ok = await showDialog<bool>(
      context: context,
      builder: (ctx) => AlertDialog(
        title: const Text('Sign out?'),
        content: const Text('This phone stays registered for your attendance. Sign in again with your college account.'),
        actions: [
          TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Cancel')),
          FilledButton(onPressed: () => Navigator.pop(ctx, true), child: const Text('Sign out')),
        ],
      ),
    );
    if (ok == true) await widget.auth.signOut();
  }

  @override
  Widget build(BuildContext context) {
    final me = widget.auth.me!;
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Profile')),
      body: RefreshIndicator(
        onRefresh: () async => setState(() {
          _health = widget.auth.api.health();
        }),
        child: ListView(padding: const EdgeInsets.fromLTRB(20, 8, 20, 32), children: [
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
                Text(me.name, style: t.titleLarge),
                const SizedBox(height: 4),
                Text(me.email, style: t.bodyMedium),
                const SectionGap(),
                if (me.usn != null) _Field('USN', me.usn!),
                if (me.program != null) _Field('Program', me.program!),
                if (me.section != null) _Field('Section', me.section!),
                if (me.batch != null) _Field('Lab batch', me.batch!),
              ]),
            ),
          ),
          const SizedBox(height: 16),
          LinkCard(
            icon: Icons.notifications_outlined,
            title: 'Notices',
            value: widget.unreadNotices > 0 ? '${widget.unreadNotices} new' : 'Class changes and announcements',
            onTap: widget.onOpenNotices,
          ),
          const SizedBox(height: 16),
          Card(
            child: Padding(
              padding: const EdgeInsets.all(20),
              child: Column(children: [
                ListenableBuilder(
                  listenable: widget.phone,
                  builder: (context, _) => FutureBuilder<PlatformSecurityInfo>(
                    future: _device,
                    builder: (context, s) {
                      final d = s.data;
                      final ios = d?.platform == 'ios';
                      final store = ios ? (d!.hardwareKeyStore ? 'Secure Enclave' : 'no Secure Enclave') : (d?.hardwareKeyStore ?? false) ? 'StrongBox secure chip' : 'Secure hardware (TEE)';
                      final state = widget.phone.state;
                      return InfoRow(
                        icon: Icons.phonelink_lock_outlined,
                        tone: state == PhoneState.active ? TileTone.good : TileTone.warn,
                        title: 'This phone',
                        value: '${_phoneStatus(state)}${d == null ? '' : '\n${d.model} · $store'}',
                      );
                    },
                  ),
                ),
                const SectionGap(),
                FutureBuilder<Health>(
                  future: _health,
                  builder: (context, s) => InfoRow(
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
              ]),
            ),
          ),
          const SizedBox(height: 24),
          OutlinedButton.icon(onPressed: _confirmSignOut, icon: const Icon(Icons.logout), label: const Text('Sign out')),
          const SizedBox(height: 12),
          Text('Location is read only when you scan, never in the background.', textAlign: TextAlign.center, style: t.bodySmall),
        ]),
      ),
    );
  }
}

class _Field extends StatelessWidget {
  const _Field(this.label, this.value);
  final String label;
  final String value;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
        SizedBox(width: 96, child: Text(label, style: t.bodyMedium?.copyWith(color: ArgusColors.fg2))),
        Expanded(child: Text(value, style: t.bodyMedium?.copyWith(color: ArgusColors.fg))),
      ]),
    );
  }
}
