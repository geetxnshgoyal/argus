import 'dart:async';

import 'package:flutter/material.dart';

import '../auth_controller.dart';
import '../theme.dart';

/// Shown when the saved sign-in can't be checked because Argus is unreachable.
/// The student stays signed in; this retries by itself.
class OfflineScreen extends StatefulWidget {
  const OfflineScreen({super.key, required this.auth});
  final AuthController auth;

  @override
  State<OfflineScreen> createState() => _OfflineScreenState();
}

class _OfflineScreenState extends State<OfflineScreen> {
  Timer? _timer;
  bool _trying = false;

  @override
  void initState() {
    super.initState();
    _timer = Timer.periodic(const Duration(seconds: 6), (_) => _retry());
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  Future<void> _retry() async {
    if (_trying) return;
    setState(() => _trying = true);
    await widget.auth.start();
    if (mounted) setState(() => _trying = false);
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      body: SafeArea(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              const Center(child: ArgusWordmark(size: 26)),
              const SizedBox(height: 32),
              const Icon(Icons.cloud_off_outlined, size: 64, color: ArgusColors.warn),
              const SizedBox(height: 16),
              Text("Can't reach Argus", textAlign: TextAlign.center, style: t.headlineSmall),
              const SizedBox(height: 8),
              Text('Check your internet connection. You are still signed in; this screen will retry by itself.', textAlign: TextAlign.center, style: t.bodyLarge),
              const SizedBox(height: 28),
              FilledButton(onPressed: _trying ? null : _retry, child: Text(_trying ? 'Trying…' : 'Try again')),
              const SizedBox(height: 8),
              TextButton(onPressed: widget.auth.signOut, child: const Text('Sign out')),
            ],
          ),
        ),
      ),
    );
  }
}
