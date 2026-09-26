import 'dart:async';

import 'package:flutter/material.dart';

import '../api_client.dart';
import '../theme.dart';

/// Notices from Academic Operations (ADR-0023): announcements and class changes.
/// Opening this screen marks everything shown as read.
class NoticesScreen extends StatefulWidget {
  const NoticesScreen({super.key, required this.api});
  final ApiClient api;

  @override
  State<NoticesScreen> createState() => _NoticesScreenState();
}

class _NoticesScreenState extends State<NoticesScreen> {
  late Future<List<AppNotice>> _data = _load();

  Future<List<AppNotice>> _load() async {
    final items = await widget.api.notices();
    final unread = [for (final n in items) if (!n.read) n.id];
    if (unread.isNotEmpty) unawaited(widget.api.markNoticesRead(unread).catchError((_) {}));
    return items;
  }

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    return Scaffold(
      appBar: AppBar(title: const Text('Notices')),
      body: RefreshIndicator(
        onRefresh: () async => setState(() => _data = _load()),
        child: FutureBuilder<List<AppNotice>>(
          future: _data,
          builder: (context, snap) {
            if (snap.connectionState != ConnectionState.done) return const Center(child: CircularProgressIndicator());
            if (snap.hasError) return ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text('Could not load notices.', style: t.bodyLarge))]);
            final items = snap.data!;
            if (items.isEmpty) {
              return ListView(children: [Padding(padding: const EdgeInsets.all(24), child: Text('No notices right now. Class changes and announcements from Academic Operations show up here.', style: t.bodyLarge))]);
            }
            return ListView.separated(
              padding: const EdgeInsets.all(20),
              itemCount: items.length,
              separatorBuilder: (_, _) => const SizedBox(height: 12),
              itemBuilder: (context, i) => NoticeCard(notice: items[i]),
            );
          },
        ),
      ),
    );
  }
}

class NoticeCard extends StatelessWidget {
  const NoticeCard({super.key, required this.notice, this.onTap});
  final AppNotice notice;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final t = Theme.of(context).textTheme;
    final n = notice;
    return Card(
      child: InkWell(
        borderRadius: BorderRadius.circular(20),
        onTap: onTap,
        child: Padding(
          padding: const EdgeInsets.all(18),
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              IconTile(n.isClassChange ? Icons.event_repeat : Icons.campaign_outlined, tone: n.isClassChange ? TileTone.warn : TileTone.good, size: 40),
              const SizedBox(width: 14),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Row(children: [
                      Expanded(child: Text(n.title, style: t.titleMedium)),
                      if (!n.read) Container(width: 9, height: 9, decoration: const BoxDecoration(color: ArgusColors.accent, shape: BoxShape.circle)),
                    ]),
                    if (n.body.isNotEmpty) ...[const SizedBox(height: 6), Text(n.body, style: t.bodyMedium)],
                    const SizedBox(height: 8),
                    Text('Academic Operations · ${_when(n.createdAt)}', style: t.bodySmall?.copyWith(color: ArgusColors.fg3)),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

const _months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

String _when(DateTime d) {
  final now = DateTime.now();
  final hm = '${d.hour.toString().padLeft(2, '0')}:${d.minute.toString().padLeft(2, '0')}';
  if (d.year == now.year && d.month == now.month && d.day == now.day) return 'today $hm';
  return '${d.day} ${_months[d.month - 1]} $hm';
}
