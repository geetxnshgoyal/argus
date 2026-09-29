import 'package:flutter/material.dart';

import 'api_client.dart';
import 'theme.dart';

/// Small building blocks shared by the student app's tabs.

const kWeekdays = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const kMonths = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String isoDate(DateTime d) => '${d.year}-${d.month.toString().padLeft(2, '0')}-${d.day.toString().padLeft(2, '0')}';

/// "Today", "Tomorrow" or "Wednesday, 30 Sep".
String dayLabel(String date, DateTime today) {
  if (date == isoDate(today)) return 'Today';
  if (date == isoDate(today.add(const Duration(days: 1)))) return 'Tomorrow';
  final d = DateTime.parse(date);
  return '${kWeekdays[d.weekday - 1]}, ${d.day} ${kMonths[d.month - 1]}';
}

/// Icon tile + title + one line of detail.
class InfoRow extends StatelessWidget {
  const InfoRow({super.key, required this.icon, required this.title, required this.value, this.tone = TileTone.good});

  final IconData icon;
  final String title;
  final String value;
  final TileTone tone;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Row(
      children: [
        IconTile(icon, tone: tone, size: 40),
        const SizedBox(width: 14),
        Expanded(
          child: Column(crossAxisAlignment: CrossAxisAlignment.start, children: [
            Text(title, style: t.titleMedium),
            const SizedBox(height: 2),
            Text(value, style: t.bodyMedium),
          ]),
        ),
      ],
    );
  }
}

class SectionGap extends StatelessWidget {
  const SectionGap({super.key});
  @override
  Widget build(BuildContext context) => const Padding(padding: EdgeInsets.symmetric(vertical: 14), child: Divider());
}

class StatusBadge extends StatelessWidget {
  const StatusBadge(this.text, this.color, {super.key});
  final String text;
  final Color color;

  @override
  Widget build(BuildContext context) => Padding(
        padding: const EdgeInsets.only(top: 4),
        child: Container(
          padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 2),
          decoration: BoxDecoration(borderRadius: BorderRadius.circular(99), border: Border.all(color: color.withValues(alpha: 0.5))),
          child: Text(text, style: TextStyle(color: color, fontSize: 12)),
        ),
      );
}

/// One class: time, subject, room · batch · teacher, and Cancelled/Changed.
class ClassTile extends StatelessWidget {
  const ClassTile(this.c, {super.key});
  final ClassSession c;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final muted = c.cancelled ? const TextStyle(decoration: TextDecoration.lineThrough, color: ArgusColors.fg3) : null;
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 6),
      child: Row(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          SizedBox(width: 92, child: Text('${c.start}–${c.end}', style: t.bodyMedium?.merge(muted))),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(c.subjectName == c.subjectCode ? c.subjectCode : '${c.subjectCode} · ${c.subjectName}', style: t.titleSmall?.merge(muted)),
                Text([c.room ?? 'Room TBA', if (c.batch != null) c.batch!, if (c.teacher != null) c.teacher!].join(' · '), style: t.bodySmall?.copyWith(color: ArgusColors.fg2)),
                if (c.cancelled) const StatusBadge('Cancelled', ArgusColors.bad) else if (c.changed) const StatusBadge('Changed', ArgusColors.warn),
              ],
            ),
          ),
        ],
      ),
    );
  }
}

/// A card with a tap target and a chevron (used for "go to" rows).
class LinkCard extends StatelessWidget {
  const LinkCard({super.key, required this.icon, required this.title, required this.value, required this.onTap, this.trailing});
  final IconData icon;
  final String title;
  final String value;
  final VoidCallback onTap;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Card(
        child: InkWell(
          borderRadius: BorderRadius.circular(20),
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.all(20),
            child: Row(children: [
              Expanded(child: InfoRow(icon: icon, title: title, value: value)),
              trailing ?? const Icon(Icons.chevron_right, color: ArgusColors.fg3),
            ]),
          ),
        ),
      );
}
