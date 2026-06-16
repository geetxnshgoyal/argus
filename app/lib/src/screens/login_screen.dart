import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';

import '../auth_controller.dart';
import '../theme.dart';

class LoginScreen extends StatefulWidget {
  const LoginScreen({super.key, required this.auth, this.showDevLogin = kDebugMode});

  final AuthController auth;

  /// Developer sign-in by email: debug builds only, and the server refuses it outside dev.
  final bool showDevLogin;

  @override
  State<LoginScreen> createState() => _LoginScreenState();
}

class _LoginScreenState extends State<LoginScreen> {
  final _email = TextEditingController(text: 'student@svyasa-sas.edu.in');

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    final text = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: ListenableBuilder(
          listenable: auth,
          builder: (context, _) => ListView(
            padding: const EdgeInsets.fromLTRB(20, 48, 20, 32),
            children: [
              const Center(child: ArgusWordmark()),
              const SizedBox(height: 40),
              Card(
                child: Padding(
                  padding: const EdgeInsets.all(22),
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          const IconTile(Icons.school_outlined),
                          const SizedBox(width: 14),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Text('Sign in', style: text.titleLarge),
                                const SizedBox(height: 4),
                                Text('Use your college Google account to mark attendance.', style: text.bodyMedium),
                              ],
                            ),
                          ),
                        ],
                      ),
                      const SizedBox(height: 22),
                      FilledButton.icon(
                        onPressed: auth.busy ? null : auth.signInWithCollege,
                        icon: auth.busy
                            ? const SizedBox(width: 18, height: 18, child: CircularProgressIndicator(strokeWidth: 2, color: ArgusColors.accentInk))
                            : const Icon(Icons.login),
                        label: const Text('Sign in with college account'),
                      ),
                      if (auth.error != null) ...[
                        const SizedBox(height: 14),
                        Row(
                          children: [
                            const Icon(Icons.error_outline, color: ArgusColors.bad, size: 20),
                            const SizedBox(width: 8),
                            Expanded(child: Text(auth.error!, style: const TextStyle(color: ArgusColors.bad))),
                          ],
                        ),
                      ],
                    ],
                  ),
                ),
              ),
              if (widget.showDevLogin) ...[
                const SizedBox(height: 16),
                Card(
                  child: Padding(
                    padding: const EdgeInsets.all(22),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          const IconTile(Icons.developer_mode, tone: TileTone.warn, size: 36),
                          const SizedBox(width: 12),
                          Text('Developer sign-in', style: text.titleMedium),
                        ]),
                        const SizedBox(height: 6),
                        Text('Debug builds only. Works when the server runs with dev login enabled.', style: text.bodySmall?.copyWith(color: ArgusColors.fg3)),
                        const SizedBox(height: 14),
                        TextField(
                          controller: _email,
                          keyboardType: TextInputType.emailAddress,
                          autocorrect: false,
                          decoration: const InputDecoration(labelText: 'Student email'),
                        ),
                        const SizedBox(height: 12),
                        OutlinedButton(
                          onPressed: auth.busy ? null : () => auth.devSignIn(_email.text),
                          child: const Text('Sign in as this student'),
                        ),
                      ],
                    ),
                  ),
                ),
              ],
              const SizedBox(height: 28),
              Text(
                'Your account works on one registered phone. Attendance is marked by scanning the QR code in your classroom.',
                textAlign: TextAlign.center,
                style: text.bodySmall?.copyWith(color: ArgusColors.fg3),
              ),
            ],
          ),
        ),
      ),
    );
  }
}
