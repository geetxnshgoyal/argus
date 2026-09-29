import 'package:flutter/material.dart';

import '../api_client.dart';
import '../theme.dart';

/// On-duty (OD) requests and attendance issues (ADR-0027).
///
/// OD: whole days or specific classes → community manager → Academic Operations;
/// approved classes count as attended ("On duty").
/// Issue: a past class's record looks wrong → the class's teacher → Academic Operations.
class RequestsScreen extends StatefulWidget {
  const RequestsScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<RequestsScreen> createState() => _RequestsScreenState();
}

const _odStatus = {
  'pending_cm': ('Waiting for community manager', ArgusColors.warn),
  'pending_ops': ('Waiting for Academic Operations', ArgusColors.warn),
  'approved': ('Approved: counted as on duty', ArgusColors.accent),
  'rejected': ('Not approved', ArgusColors.bad),
  'cancelled': ('Withdrawn', ArgusColors.fg3),
};

const _issueStatus = {
  'pending_teacher': ('Waiting for your teacher', ArgusColors.warn),
  'pending_ops': ('Teacher confirmed: waiting for Academic Operations', ArgusColors.warn),
  'resolved': ('Fixed', ArgusColors.accent),
  'declined': ('Not changed', ArgusColors.bad),
  'cancelled': ('Withdrawn', ArgusColors.fg3),
};

const issueReasons = {
  'marked_absent_but_present': 'I was there but was marked absent',
  'marked_late_but_on_time': 'I was on time but was marked late',
  'wrong_record': 'The record is wrong',
  'other': 'Something else',
};

class _RequestsScreenState extends State<RequestsScreen> {
  late Future<(List<Map<String, dynamic>>, List<Map<String, dynamic>>)> _data = _load();

  Future<(List<Map<String, dynamic>>, List<Map<String, dynamic>>)> _load() async => (await widget.api.odRequests(), await widget.api.attendanceIssues());

  void _reload() => setState(() {
        _data = _load();
      });

  Future<void> _open(Widget page) async {
    final changed = await Navigator.of(context).push<bool>(MaterialPageRoute(builder: (_) => page));
    if (changed == true) _reload();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('OD & attendance issues')),
      body: RefreshIndicator(
        onRefresh: () async => _reload(),
        child: FutureBuilder(
          future: _data,
          builder: (context, snap) {
            final children = <Widget>[
              Row(children: [
                Expanded(child: FilledButton.icon(onPressed: () => _open(OdFormScreen(api: widget.api)), icon: const Icon(Icons.badge_outlined), label: const Text('Request OD'))),
                const SizedBox(width: 12),
                Expanded(child: OutlinedButton.icon(onPressed: () => _open(IssueFormScreen(api: widget.api)), icon: const Icon(Icons.report_outlined), label: const Text('Raise an issue'))),
              ]),
              const SizedBox(height: 8),
              Text('OD (on duty): when you are away on college duty. It counts as attended once approved.', style: t.bodySmall),
            ];
            if (snap.connectionState != ConnectionState.done) {
              children.add(const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator())));
            } else if (snap.hasError) {
              children.add(Padding(padding: const EdgeInsets.all(16), child: Text('Could not load your requests.', style: t.bodyLarge)));
            } else {
              final (ods, issues) = snap.data!;
              children.add(const SizedBox(height: 20));
              children.add(Text('OD requests', style: t.titleMedium));
              if (ods.isEmpty) children.add(Padding(padding: const EdgeInsets.only(top: 8), child: Text('None yet.', style: t.bodyMedium)));
              for (final r in ods) {
                children.add(_RequestCard(
                  title: r['event'] as String,
                  subtitle: r['kind'] == 'days'
                      ? (r['dates'] as List).join(', ')
                      : (r['classes'] as List).map((c) => '${c['code']} ${c['date']} ${c['start']}').join(' · '),
                  status: _odStatus[r['status']] ?? ('${r['status']}', ArgusColors.fg3),
                  notes: [
                    if (r['community_manager']?['note'] != null) 'Community manager: ${r['community_manager']['note']}',
                    if (r['acadops']?['note'] != null) 'Academic Operations: ${r['acadops']['note']}',
                  ],
                  onCancel: (r['status'] == 'pending_cm' || r['status'] == 'pending_ops')
                      ? () async {
                          await widget.api.cancelOd(r['id'] as String);
                          _reload();
                        }
                      : null,
                ));
              }
              children.add(const SizedBox(height: 20));
              children.add(Text('Attendance issues', style: t.titleMedium));
              if (issues.isEmpty) children.add(Padding(padding: const EdgeInsets.only(top: 8), child: Text('None yet.', style: t.bodyMedium)));
              for (final i in issues) {
                final c = i['class'] as Map<String, dynamic>;
                children.add(_RequestCard(
                  title: '${c['code']} · ${c['date']} ${c['start']}',
                  subtitle: '${issueReasons[i['reason']] ?? i['reason']}: ${i['note']}',
                  status: _issueStatus[i['status']] ?? ('${i['status']}', ArgusColors.fg3),
                  notes: [if (i['teacher_note'] != null) 'Teacher: ${i['teacher_note']}'],
                  onCancel: i['status'] == 'pending_teacher'
                      ? () async {
                          await widget.api.cancelIssue(i['id'] as String);
                          _reload();
                        }
                      : null,
                ));
              }
            }
            return ListView(padding: const EdgeInsets.all(20), children: children);
          },
        ),
      ),
    );
  }
}

class _RequestCard extends StatelessWidget {
  const _RequestCard({required this.title, required this.subtitle, required this.status, required this.notes, this.onCancel});
  final String title;
  final String subtitle;
  final (String, Color) status;
  final List<String> notes;
  final Future<void> Function()? onCancel;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Card(
      margin: const EdgeInsets.only(top: 10),
      child: Padding(
        padding: const EdgeInsets.all(16),
        child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
          Text(title, style: t.titleSmall),
          const SizedBox(height: 4),
          Text(subtitle, style: t.bodyMedium),
          const SizedBox(height: 8),
          Text(status.$1, style: TextStyle(color: status.$2, fontWeight: FontWeight.w600)),
          for (final n in notes) Padding(padding: const EdgeInsets.only(top: 4), child: Text(n, style: t.bodySmall)),
          if (onCancel != null) Align(alignment: Alignment.centerRight, child: TextButton(onPressed: onCancel, child: const Text('Withdraw'))),
        ]),
      ),
    );
  }
}

String _iso(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// Request OD for whole days or for specific classes.
class OdFormScreen extends StatefulWidget {
  const OdFormScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<OdFormScreen> createState() => _OdFormScreenState();
}

class _OdFormScreenState extends State<OdFormScreen> {
  String _kind = 'days';
  final _dates = <String>{};
  final _classIds = <String>{};
  final _event = TextEditingController();
  final _reason = TextEditingController();
  late final Future<List<ClassSession>> _classes = () {
    final now = DateTime.now();
    return widget.api.timetable(from: _iso(now.subtract(const Duration(days: 14))), to: _iso(now.add(const Duration(days: 14))));
  }();
  bool _busy = false;
  String? _error;

  Future<void> _pickDate() async {
    final now = DateTime.now();
    final d = await showDatePicker(context: context, firstDate: now.subtract(const Duration(days: 30)), lastDate: now.add(const Duration(days: 60)), initialDate: now);
    if (d != null) setState(() => _dates.add(_iso(d)));
  }

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.requestOd(
        kind: _kind,
        dates: _kind == 'days' ? (_dates.toList()..sort()) : null,
        classIds: _kind == 'classes' ? _classIds.toList() : null,
        event: _event.text.trim(),
        reason: _reason.text.trim(),
      );
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not send. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _event.dispose();
    _reason.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final ready = _event.text.trim().length >= 3 && _reason.text.trim().length >= 3 && (_kind == 'days' ? _dates.isNotEmpty : _classIds.isNotEmpty);
    return Scaffold(
      appBar: AppBar(title: const Text('Request OD')),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        SegmentedButton<String>(
          segments: const [ButtonSegment(value: 'days', label: Text('Whole days')), ButtonSegment(value: 'classes', label: Text('Specific classes'))],
          selected: {_kind},
          onSelectionChanged: (v) => setState(() => _kind = v.first),
        ),
        const SizedBox(height: 16),
        if (_kind == 'days') ...[
          Wrap(spacing: 8, runSpacing: 8, children: [
            for (final d in _dates.toList()..sort()) InputChip(label: Text(d), onDeleted: () => setState(() => _dates.remove(d))),
            ActionChip(avatar: const Icon(Icons.add, size: 18), label: const Text('Add a day'), onPressed: _pickDate),
          ]),
        ] else
          FutureBuilder<List<ClassSession>>(
            future: _classes,
            builder: (context, snap) {
              if (snap.connectionState != ConnectionState.done) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
              final list = (snap.data ?? const <ClassSession>[]).where((c) => !c.cancelled).toList();
              if (list.isEmpty) return Text('No classes in the last or next two weeks.', style: t.bodyMedium);
              return Column(children: [
                for (final c in list)
                  CheckboxListTile(
                    contentPadding: EdgeInsets.zero,
                    value: _classIds.contains(c.id),
                    onChanged: (v) => setState(() => v == true ? _classIds.add(c.id) : _classIds.remove(c.id)),
                    title: Text('${c.subjectCode} · ${c.date} ${c.start}'),
                    subtitle: Text(c.subjectName),
                  ),
              ]);
            },
          ),
        const SizedBox(height: 16),
        TextField(controller: _event, maxLength: 120, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Event or duty', hintText: 'e.g. Inter-college hackathon')),
        TextField(controller: _reason, maxLength: 500, maxLines: 3, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Details', hintText: 'Who asked you to go, where, when')),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: ArgusColors.bad))),
        FilledButton(onPressed: ready && !_busy ? _submit : null, child: Text(_busy ? 'Sending…' : 'Send for approval')),
        const SizedBox(height: 8),
        Text('A community manager checks it first, then Academic Operations approves it.', style: t.bodySmall),
      ]),
    );
  }
}

/// Raise an issue about a past class's attendance.
class IssueFormScreen extends StatefulWidget {
  const IssueFormScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<IssueFormScreen> createState() => _IssueFormScreenState();
}

class _IssueFormScreenState extends State<IssueFormScreen> {
  String? _classId;
  String _reason = 'marked_absent_but_present';
  final _note = TextEditingController();
  late final Future<List<ClassSession>> _classes = () {
    final now = DateTime.now();
    return widget.api.timetable(from: _iso(now.subtract(const Duration(days: 30))), to: _iso(now));
  }();
  bool _busy = false;
  String? _error;

  Future<void> _submit() async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.api.raiseIssue(classId: _classId!, reason: _reason, note: _note.text.trim());
      if (mounted) Navigator.of(context).pop(true);
    } on ApiException catch (e) {
      setState(() => _error = e.message);
    } catch (_) {
      setState(() => _error = 'Could not send. Check your connection and try again.');
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  @override
  void dispose() {
    _note.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Raise an issue')),
      body: ListView(padding: const EdgeInsets.all(20), children: [
        Text('Which class?', style: t.titleSmall),
        FutureBuilder<List<ClassSession>>(
          future: _classes,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Padding(padding: EdgeInsets.all(16), child: Center(child: CircularProgressIndicator()));
            final now = DateTime.now();
            final past = (snap.data ?? const <ClassSession>[])
                .where((c) => !c.cancelled && DateTime.tryParse('${c.date}T${c.end}')?.isBefore(now) == true)
                .toList()
                .reversed
                .toList();
            if (past.isEmpty) return Text('No past classes in the last 30 days.', style: t.bodyMedium);
            return DropdownButtonFormField<String>(
              isExpanded: true,
              initialValue: _classId,
              hint: const Text('Choose a class'),
              items: [for (final c in past) DropdownMenuItem(value: c.id, child: Text('${c.subjectCode} · ${c.date} ${c.start}'))],
              onChanged: (v) => setState(() => _classId = v),
            );
          },
        ),
        const SizedBox(height: 16),
        Text('What happened?', style: t.titleSmall),
        RadioGroup<String>(
          groupValue: _reason,
          onChanged: (v) => setState(() => _reason = v ?? _reason),
          child: Column(children: [for (final e in issueReasons.entries) RadioListTile<String>(contentPadding: EdgeInsets.zero, value: e.key, title: Text(e.value))]),
        ),
        TextField(controller: _note, maxLength: 500, maxLines: 3, onChanged: (_) => setState(() {}), decoration: const InputDecoration(labelText: 'Explain', hintText: 'e.g. My camera would not open; I sat in the second row')),
        if (_error != null) Padding(padding: const EdgeInsets.only(bottom: 8), child: Text(_error!, style: const TextStyle(color: ArgusColors.bad))),
        FilledButton(onPressed: _classId != null && _note.text.trim().length >= 3 && !_busy ? _submit : null, child: Text(_busy ? 'Sending…' : 'Send to my teacher')),
        const SizedBox(height: 8),
        Text('Your teacher checks it first; if they confirm, Academic Operations fixes the record.', style: t.bodySmall),
      ]),
    );
  }
}
