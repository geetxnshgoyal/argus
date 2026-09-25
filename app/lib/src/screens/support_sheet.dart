import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../api_client.dart';
import '../device_controller.dart';
import '../theme.dart';

/// "Can't mark attendance?" (spec §7). A verifier checks the evidence; if the phone never
/// scanned a valid code in class, the teacher is asked whether the student is in the room.
Future<void> showSupportSheet(BuildContext context, {required SupportSender sender, required String attendanceSessionId, required String deviceId}) {
  return showModalBottomSheet<void>(
    context: context,
    isScrollControlled: true,
    backgroundColor: ArgusColors.surface,
    shape: const RoundedRectangleBorder(borderRadius: BorderRadius.vertical(top: Radius.circular(20))),
    builder: (_) => _SupportSheet(sender: sender, attendanceSessionId: attendanceSessionId, deviceId: deviceId),
  );
}

class _SupportSheet extends StatefulWidget {
  const _SupportSheet({required this.sender, required this.attendanceSessionId, required this.deviceId});
  final SupportSender sender;
  final String attendanceSessionId;
  final String deviceId;

  @override
  State<_SupportSheet> createState() => _SupportSheetState();
}

class _SupportSheetState extends State<_SupportSheet> {
  static const _reasons = {
    'cant_scan': 'The code would not scan',
    'camera_broken': 'My camera is not working',
    'app_error': 'The app showed an error',
    'phone_problem': 'Phone problem (battery, screen)',
    'other': 'Something else',
  };
  String _reason = 'cant_scan';
  final _note = TextEditingController();
  bool _sending = false;
  String? _error;
  String? _done;

  Future<void> _send() async {
    setState(() {
      _sending = true;
      _error = null;
    });
    try {
      final msg = await widget.sender.send(attendanceSessionId: widget.attendanceSessionId, deviceId: widget.deviceId, reason: _reason, note: _note.text);
      setState(() => _done = msg);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } on PlatformException catch (e) {
      setState(() => _error = e.code == 'auth_cancelled' ? 'Please confirm with your fingerprint, face or PIN.' : (e.message ?? 'Could not send.'));
    } finally {
      if (mounted) setState(() => _sending = false);
    }
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Padding(
      padding: EdgeInsets.fromLTRB(20, 20, 20, 20 + MediaQuery.of(context).viewInsets.bottom),
      child: _done != null
          ? Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              const Icon(Icons.support_agent, size: 56, color: ArgusColors.accent),
              const SizedBox(height: 12),
              Text('Help requested', textAlign: TextAlign.center, style: t.titleLarge),
              const SizedBox(height: 8),
              Text(_done!, textAlign: TextAlign.center, style: t.bodyMedium),
              const SizedBox(height: 16),
              FilledButton(onPressed: () => Navigator.of(context).pop(), child: const Text('OK')),
            ])
          : Column(mainAxisSize: MainAxisSize.min, crossAxisAlignment: CrossAxisAlignment.stretch, children: [
              Text("Can't mark attendance?", style: t.titleLarge),
              const SizedBox(height: 6),
              Text('A verifier will check. Your teacher may be asked if you are in the room. Only ask if you are in class.', style: t.bodyMedium),
              const SizedBox(height: 12),
              RadioGroup<String>(
                groupValue: _reason,
                onChanged: (v) => setState(() => _reason = v ?? _reason),
                child: Column(children: [
                  for (final e in _reasons.entries) RadioListTile<String>(value: e.key, title: Text(e.value), dense: true, contentPadding: EdgeInsets.zero),
                ]),
              ),
              TextField(controller: _note, maxLength: 200, decoration: const InputDecoration(labelText: 'Anything else? (optional)')),
              if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: ArgusColors.bad))),
              FilledButton(onPressed: _sending ? null : _send, child: Text(_sending ? 'Sending…' : 'Ask for help')),
            ]),
    );
  }
}
