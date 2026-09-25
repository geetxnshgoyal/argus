import 'dart:async';

import 'package:argus_security/argus_security.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../api_client.dart';
import '../device_controller.dart';
import '../theme.dart';

enum _Phase { unlocking, scanning, sending, done, failed }

/// Scan the classroom QR (spec §11, protocol §5.4).
///
/// 1. Unlock the attempt key first (fingerprint/face/PIN), so the scan itself is instant.
/// 2. Camera and a fresh precise location fix run in parallel.
/// 3. When both are ready, the most recently decoded code is signed and sent at once,
///    keeping the code as fresh as possible for the 3-second window.
/// Codes are read only from this camera; argus:// links are never opened from elsewhere (ADR-0011).
class ScanScreen extends StatefulWidget {
  const ScanScreen({super.key, required this.attendance, required this.deviceId, required this.sender, required this.security, this.onAskHelp});

  final ActiveAttendance attendance;
  final String deviceId;
  final AttemptSender sender;
  final SecurityBridge security;

  /// Opens the support request sheet (spec §7) after a failed scan.
  final Future<void> Function(BuildContext context)? onAskHelp;

  @override
  State<ScanScreen> createState() => _ScanScreenState();
}

class _ScanScreenState extends State<ScanScreen> {
  final _camera = MobileScannerController(
    detectionSpeed: DetectionSpeed.noDuplicates,
    formats: const [BarcodeFormat.qrCode],
    cameraResolution: const Size(1280, 720),
    autoStart: false,
  );
  _Phase _phase = _Phase.unlocking;
  ScannedQr? _latest;
  LocationFix? _fix;
  bool _locationDone = false;
  String? _locationNote;
  String? _wrongCode;
  AttemptResult? _result;
  String? _error;
  String? _errorCode;
  int _retries = 0;

  @override
  void initState() {
    super.initState();
    unawaited(_start());
  }

  @override
  void dispose() {
    unawaited(_camera.dispose());
    super.dispose();
  }

  Future<void> _start() async {
    setState(() {
      _phase = _Phase.unlocking;
      _error = null;
      _errorCode = null;
      _latest = null;
      _wrongCode = null;
    });
    try {
      await widget.security.unlockAttemptKey(reason: 'Confirm it\'s you to mark attendance');
    } on PlatformException {
      if (!mounted) return;
      return _fail('auth_cancelled', 'Attendance needs your fingerprint, face or PIN. Tap Try again.');
    }
    if (!mounted) return;
    setState(() => _phase = _Phase.scanning);
    unawaited(_camera.start());
    if (!_locationDone) unawaited(_locate());
  }

  Future<void> _locate() async {
    try {
      final fix = await widget.security.locationFix(timeoutMs: 12000);
      _fix = fix;
      _locationNote = null;
    } on PlatformException catch (e) {
      // No fix → the scan is flagged, never rejected (spec §14). Tell the student how to fix it.
      _locationNote = switch (e.code) {
        'precise_required' => 'Turn on precise location for Argus so your scan isn\'t flagged.',
        'permission_denied' => 'Location is off for Argus: your scan may be flagged for your teacher to check.',
        'location_off' => 'Turn on location so your scan isn\'t flagged.',
        _ => 'Couldn\'t get your location: your scan may be flagged.',
      };
    }
    if (!mounted) return;
    setState(() => _locationDone = true);
    _maybeSend();
  }

  void _onDetect(BarcodeCapture capture) {
    for (final b in capture.barcodes) {
      final qr = ScannedQr.parse(b.rawValue, DateTime.now());
      if (qr == null) {
        if (b.rawValue != null && mounted) setState(() => _wrongCode = 'That isn\'t an Argus attendance code.');
        continue;
      }
      if (qr.sessionId != widget.attendance.sessionId) {
        if (mounted) setState(() => _wrongCode = 'This code is for a different class.');
        continue;
      }
      _latest = qr;
      if (_wrongCode != null && mounted) setState(() => _wrongCode = null);
    }
    _maybeSend();
  }

  Future<void> _maybeSend() async {
    final qr = _latest;
    // Only a code seen in the last 1.5 s: older ones are likely past the 3 s window.
    if (_phase != _Phase.scanning || !_locationDone || qr == null || DateTime.now().difference(qr.seenAt) > const Duration(milliseconds: 1500)) return;
    setState(() => _phase = _Phase.sending);
    try {
      final r = await widget.sender.send(qr: qr, deviceId: widget.deviceId, location: _fix);
      if (!mounted) return;
      unawaited(_camera.stop());
      HapticFeedback.mediumImpact();
      setState(() {
        _result = r;
        _phase = _Phase.done;
      });
    } on ApiException catch (e) {
      if (!mounted) return;
      // The code went stale in flight: silently try the next one (twice).
      if ((e.code == 'epoch_expired' || e.code == 'replayed_nonce') && _retries < 2) {
        _retries++;
        _latest = null;
        setState(() => _phase = _Phase.scanning);
        return;
      }
      unawaited(_camera.stop());
      _fail(e.code, e.message);
    } on PlatformException catch (e) {
      if (!mounted) return;
      unawaited(_camera.stop());
      _fail(e.code, e.code == 'auth_cancelled' ? 'Attendance needs your fingerprint, face or PIN. Tap Try again.' : (e.message ?? 'Something went wrong.'));
    }
  }

  void _fail(String code, String message) {
    HapticFeedback.heavyImpact();
    setState(() {
      _phase = _Phase.failed;
      _errorCode = code;
      _error = message;
    });
  }

  @override
  Widget build(BuildContext context) {
    final a = widget.attendance;
    return Scaffold(
      appBar: AppBar(title: Text(a.round > 1 ? 'Recheck · ${a.cls.subjectCode}' : 'Scan · ${a.cls.subjectCode}')),
      body: switch (_phase) {
        _Phase.done => _ResultView(result: _result!, onClose: () => Navigator.of(context).pop(true)),
        _Phase.failed => _ErrorView(
            code: _errorCode,
            message: _error ?? 'Attendance could not be marked.',
            onRetry: () {
              _retries = 0;
              unawaited(_start());
            },
            onAskHelp: widget.onAskHelp == null ? null : () => widget.onAskHelp!(context),
          ),
        _ => _scanner(context),
      },
    );
  }

  Widget _scanner(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final status = switch (_phase) {
      _Phase.unlocking => 'Confirm it\'s you…',
      _Phase.sending => 'Marking your attendance…',
      _ => !_locationDone ? 'Point at the code on the screen · checking location…' : 'Point your camera at the code on the classroom screen',
    };
    return Column(
      children: [
        Expanded(
          child: Stack(
            fit: StackFit.expand,
            children: [
              if (_phase != _Phase.unlocking) MobileScanner(controller: _camera, onDetect: _onDetect),
              IgnorePointer(
                child: Center(
                  child: Container(
                    width: 260,
                    height: 260,
                    decoration: BoxDecoration(border: Border.all(color: ArgusColors.accent, width: 3), borderRadius: BorderRadius.circular(24)),
                  ),
                ),
              ),
              if (_phase == _Phase.sending) const ColoredBox(color: Color(0x99000000), child: Center(child: CircularProgressIndicator())),
            ],
          ),
        ),
        Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 28),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(status, style: t.titleMedium),
              const SizedBox(height: 6),
              Text('${widget.attendance.cls.subjectName} · ${widget.attendance.cls.room ?? 'Room TBA'}', style: t.bodyMedium),
              if (_wrongCode != null) ...[const SizedBox(height: 8), Text(_wrongCode!, style: const TextStyle(color: ArgusColors.warn))],
              if (_locationNote != null) ...[const SizedBox(height: 8), Text(_locationNote!, style: const TextStyle(color: ArgusColors.warn))],
            ],
          ),
        ),
      ],
    );
  }
}

class _ResultView extends StatelessWidget {
  const _ResultView({required this.result, required this.onClose});
  final AttemptResult result;
  final VoidCallback onClose;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final verified = result.decision == 'verified';
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(verified ? Icons.check_circle : Icons.flag_circle, size: 96, color: verified ? ArgusColors.accent : ArgusColors.warn),
          const SizedBox(height: 20),
          Text(verified ? 'Verified' : 'Marked, teacher may confirm', textAlign: TextAlign.center, style: t.headlineSmall),
          const SizedBox(height: 8),
          Text(result.message, textAlign: TextAlign.center, style: t.bodyLarge),
          if (result.record == 'late') ...[const SizedBox(height: 8), Text('Recorded as late.', textAlign: TextAlign.center, style: t.bodyMedium)],
          const SizedBox(height: 32),
          FilledButton(onPressed: onClose, child: const Text('Done')),
        ],
      ),
    );
  }
}

class _ErrorView extends StatelessWidget {
  const _ErrorView({required this.code, required this.message, required this.onRetry, this.onAskHelp});
  final String? code;
  final String message;
  final VoidCallback onRetry;
  final VoidCallback? onAskHelp;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final final_ = const {'already_marked', 'not_targeted', 'session_closed', 'not_enrolled', 'device_not_active'}.contains(code);
    return Padding(
      padding: const EdgeInsets.all(24),
      child: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Icon(code == 'already_marked' || code == 'not_targeted' ? Icons.check_circle_outline : Icons.error_outline, size: 88, color: code == 'already_marked' || code == 'not_targeted' ? ArgusColors.accent : ArgusColors.bad),
          const SizedBox(height: 20),
          Text(code == 'already_marked' ? 'Already marked' : code == 'not_targeted' ? 'Nothing to do' : 'Not marked', textAlign: TextAlign.center, style: t.headlineSmall),
          const SizedBox(height: 8),
          Text(message, textAlign: TextAlign.center, style: t.bodyLarge),
          const SizedBox(height: 32),
          if (!final_) FilledButton(onPressed: onRetry, child: const Text('Try again')),
          if (!final_ && onAskHelp != null) OutlinedButton(onPressed: onAskHelp, child: const Text('Still not working? Ask for help')),
          const SizedBox(height: 8),
          TextButton(onPressed: () => Navigator.of(context).pop(false), child: const Text('Back')),
        ],
      ),
    );
  }
}
