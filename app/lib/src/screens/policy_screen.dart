import 'package:flutter/material.dart';

import '../api_client.dart';
import '../auth_controller.dart';
import '../theme.dart';

/// First sign-in: the proxy-attendance policy and privacy notice (spec §11).
class PolicyScreen extends StatefulWidget {
  const PolicyScreen({super.key, required this.auth});

  final AuthController auth;

  @override
  State<PolicyScreen> createState() => _PolicyScreenState();
}

class _PolicyScreenState extends State<PolicyScreen> {
  late Future<Policy> _policy;
  bool _read = false;

  @override
  void initState() {
    super.initState();
    _policy = widget.auth.api.policy();
  }

  @override
  Widget build(BuildContext context) {
    final auth = widget.auth;
    return Scaffold(
      appBar: AppBar(title: const Text('Before you start')),
      body: SafeArea(
        child: FutureBuilder<Policy>(
          future: _policy,
          builder: (context, snap) {
            if (snap.hasError) {
              return Center(child: Text('Could not load the policy. Check your connection.', style: Theme.of(context).textTheme.bodyMedium));
            }
            if (!snap.hasData) return const Center(child: CircularProgressIndicator());
            return Column(
              children: [
                Expanded(
                  child: ListView(
                    padding: const EdgeInsets.fromLTRB(20, 8, 20, 20),
                    children: [
                      Card(child: Padding(padding: const EdgeInsets.all(20), child: _Markdownish(snap.data!.text))),
                    ],
                  ),
                ),
                const Divider(),
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 12, 20, 20),
                  child: ListenableBuilder(
                    listenable: auth,
                    builder: (context, _) => Column(
                      children: [
                        CheckboxListTile(
                          value: _read,
                          onChanged: (v) => setState(() => _read = v ?? false),
                          contentPadding: EdgeInsets.zero,
                          controlAffinity: ListTileControlAffinity.leading,
                          activeColor: ArgusColors.accent,
                          title: const Text('I have read and accept the attendance policy and privacy notice'),
                        ),
                        if (auth.error != null) Text(auth.error!, style: const TextStyle(color: ArgusColors.bad)),
                        const SizedBox(height: 8),
                        FilledButton(onPressed: _read && !auth.busy ? auth.acceptPolicy : null, child: const Text('Accept and continue')),
                        TextButton(onPressed: auth.signOut, child: const Text('Sign out')),
                      ],
                    ),
                  ),
                ),
              ],
            );
          },
        ),
      ),
    );
  }
}

/// Renders the policy's simple Markdown (headings and bullet lists).
class _Markdownish extends StatelessWidget {
  const _Markdownish(this.text);
  final String text;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final children = <Widget>[];
    for (final raw in text.split('\n')) {
      final line = raw.trimRight();
      if (line.isEmpty) continue;
      if (line.startsWith('# ')) {
        children.add(Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(line.substring(2), style: t.titleLarge)));
      } else if (line.startsWith('## ')) {
        children.add(Padding(padding: const EdgeInsets.only(top: 14, bottom: 6), child: Text(line.substring(3), style: t.titleMedium?.copyWith(color: ArgusColors.accent))));
      } else if (line.startsWith('- ')) {
        children.add(Padding(
          padding: const EdgeInsets.only(bottom: 6),
          child: Row(crossAxisAlignment: CrossAxisAlignment.start, children: [
            const Padding(padding: EdgeInsets.only(top: 8, right: 10), child: Icon(Icons.circle, size: 5, color: ArgusColors.fg3)),
            Expanded(child: Text(line.substring(2), style: t.bodyMedium)),
          ]),
        ));
      } else {
        children.add(Text(line, style: t.bodyMedium));
      }
    }
    return Column(crossAxisAlignment: CrossAxisAlignment.start, children: children);
  }
}
