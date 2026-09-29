import 'package:flutter/material.dart';

import '../api_client.dart';
import '../theme.dart';
import '../widgets.dart';

/// Timetable tab: one week at a time, with a day picker (today selected by default).
class TimetableScreen extends StatefulWidget {
  const TimetableScreen({super.key, required this.api, this.today});
  final ApiClient api;

  /// Injectable for tests; defaults to the phone's date.
  final DateTime? today;

  @override
  State<TimetableScreen> createState() => _TimetableScreenState();
}

class _TimetableScreenState extends State<TimetableScreen> {
  late final DateTime _today = _dateOnly(widget.today ?? DateTime.now());
  late DateTime _monday = _mondayOf(_today);
  late String _selected = isoDate(_today);
  late Future<List<ClassSession>> _week = _load();

  static DateTime _dateOnly(DateTime d) => DateTime(d.year, d.month, d.day);
  static DateTime _mondayOf(DateTime d) => _dateOnly(d).subtract(Duration(days: d.weekday - 1));

  Future<List<ClassSession>> _load() => widget.api.timetable(from: isoDate(_monday), to: isoDate(_monday.add(const Duration(days: 6))));

  void _goWeek(int delta) {
    setState(() {
      _monday = _monday.add(Duration(days: 7 * delta));
      final thisWeek = _mondayOf(_today) == _monday;
      _selected = isoDate(thisWeek ? _today : _monday);
      _week = _load();
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final sunday = _monday.add(const Duration(days: 6));
    final thisWeek = _mondayOf(_today) == _monday;
    return Scaffold(
      appBar: AppBar(title: const Text('Timetable')),
      body: RefreshIndicator(
        onRefresh: () async => setState(() {
          _week = _load();
        }),
        child: FutureBuilder<List<ClassSession>>(
          future: _week,
          builder: (context, snap) {
            final classes = snap.data ?? const <ClassSession>[];
            final byDate = <String, List<ClassSession>>{};
            for (final c in classes) {
              byDate.putIfAbsent(c.date, () => []).add(c);
            }
            final days = List.generate(7, (i) => _monday.add(Duration(days: i)));
            final dayClasses = byDate[_selected] ?? const <ClassSession>[];
            return ListView(
              padding: const EdgeInsets.fromLTRB(16, 8, 16, 32),
              children: [
                Row(children: [
                  IconButton(tooltip: 'Previous week', onPressed: () => _goWeek(-1), icon: const Icon(Icons.chevron_left)),
                  Expanded(
                    child: Text(
                      '${_monday.day} ${kMonths[_monday.month - 1]} – ${sunday.day} ${kMonths[sunday.month - 1]}',
                      textAlign: TextAlign.center,
                      style: t.titleMedium,
                    ),
                  ),
                  IconButton(tooltip: 'Next week', onPressed: () => _goWeek(1), icon: const Icon(Icons.chevron_right)),
                ]),
                if (!thisWeek) Center(child: TextButton(onPressed: () => _goWeek(0 - (_monday.difference(_mondayOf(_today)).inDays ~/ 7)), child: const Text('Back to this week'))),
                const SizedBox(height: 8),
                SizedBox(
                  height: 64,
                  child: ListView.separated(
                    scrollDirection: Axis.horizontal,
                    itemCount: days.length,
                    separatorBuilder: (_, _) => const SizedBox(width: 8),
                    itemBuilder: (context, i) {
                      final d = days[i];
                      final iso = isoDate(d);
                      final selected = iso == _selected;
                      final count = (byDate[iso] ?? const []).where((c) => !c.cancelled).length;
                      return Semantics(
                        button: true,
                        selected: selected,
                        label: '${kWeekdays[d.weekday - 1]} ${d.day}, $count classes',
                        child: InkWell(
                          borderRadius: BorderRadius.circular(14),
                          onTap: () => setState(() => _selected = iso),
                          child: Container(
                            width: 52,
                            decoration: BoxDecoration(
                              color: selected ? ArgusColors.accentTile : ArgusColors.surface,
                              borderRadius: BorderRadius.circular(14),
                              border: Border.all(color: selected ? ArgusColors.accent : iso == isoDate(_today) ? ArgusColors.lineStrong : ArgusColors.line),
                            ),
                            child: ExcludeSemantics(
                              child: Column(mainAxisAlignment: MainAxisAlignment.center, children: [
                                Text(kWeekdays[d.weekday - 1].substring(0, 3), style: t.bodySmall?.copyWith(color: selected ? ArgusColors.accent : ArgusColors.fg2)),
                                Text('${d.day}', style: t.titleMedium?.copyWith(color: selected ? ArgusColors.accent : ArgusColors.fg)),
                                if (count > 0) Container(width: 5, height: 5, margin: const EdgeInsets.only(top: 2), decoration: const BoxDecoration(color: ArgusColors.accent, shape: BoxShape.circle)),
                              ]),
                            ),
                          ),
                        ),
                      );
                    },
                  ),
                ),
                const SizedBox(height: 16),
                Text(dayLabel(_selected, _today), style: t.titleSmall?.copyWith(color: ArgusColors.accent, fontWeight: FontWeight.w700)),
                const SizedBox(height: 8),
                if (snap.connectionState != ConnectionState.done)
                  const Padding(padding: EdgeInsets.all(24), child: Center(child: CircularProgressIndicator()))
                else if (snap.hasError)
                  Card(child: Padding(padding: const EdgeInsets.all(20), child: Text('Could not load your timetable. Pull down to try again.', style: t.bodyMedium)))
                else if (dayClasses.isEmpty)
                  Card(child: Padding(padding: const EdgeInsets.all(20), child: Text('No classes on this day.', style: t.bodyMedium)))
                else
                  Card(child: Padding(padding: const EdgeInsets.symmetric(horizontal: 20, vertical: 12), child: Column(children: [for (final c in dayClasses) ClassTile(c)]))),
              ],
            );
          },
        ),
      ),
    );
  }
}
