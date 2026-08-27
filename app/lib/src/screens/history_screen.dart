import 'package:flutter/material.dart';

import '../api_client.dart';
import '../theme.dart';

/// Attendance per subject with percentages (spec §11).
class HistoryScreen extends StatefulWidget {
  const HistoryScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<HistoryScreen> createState() => _HistoryScreenState();
}

class _HistoryScreenState extends State<HistoryScreen> {
  late Future<List<SubjectAttendance>> _data = widget.api.history();

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('My attendance')),
      body: RefreshIndicator(
        onRefresh: () async => setState(() => _data = widget.api.history()),
        child: FutureBuilder<List<SubjectAttendance>>(
          future: _data,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) return ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text('Could not load your attendance.', style: t.bodyLarge))]);
            final items = snap.data!;
            if (items.isEmpty) return ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text('No attendance recorded yet.', style: t.bodyLarge))]);
            return ListView.separated(
              padding: const EdgeInsets.all(20),
              itemCount: items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (context, i) {
                final s = items[i];
                final pct = s.percent ?? 0;
                final color = pct >= 75 ? ArgusColors.accent : pct >= 65 ? ArgusColors.warn : ArgusColors.bad;
                return Card(
                  child: Padding(
                    padding: const EdgeInsets.all(18),
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Row(children: [
                          Expanded(child: Text(s.name == s.code ? s.code : '${s.code} · ${s.name}', style: t.titleMedium)),
                          Text(s.percent == null ? '—' : '${s.percent!.toStringAsFixed(s.percent! % 1 == 0 ? 0 : 1)}%', style: t.titleLarge?.copyWith(color: color, fontWeight: FontWeight.w700)),
                        ]),
                        const SizedBox(height: 10),
                        ClipRRect(borderRadius: BorderRadius.circular(99), child: LinearProgressIndicator(value: pct / 100, minHeight: 6, color: color, backgroundColor: ArgusColors.surface2)),
                        const SizedBox(height: 8),
                        Text('${s.attended} of ${s.total} classes${s.late > 0 ? ' · ${s.late} late' : ''}${s.absent > 0 ? ' · ${s.absent} absent' : ''}', style: t.bodyMedium),
                      ],
                    ),
                  ),
                );
              },
            );
          },
        ),
      ),
    );
  }
}
