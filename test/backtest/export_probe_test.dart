// Real-data hook (run.mjs --export): every grant, staff and directory document
// of a production export parsed, and every holder's loadMine answered. Runs in
// both builds; export_check.mjs diffs the two. Without an export it is a no-op.
import 'dart:io';

import 'package:cgpa_calculator/core/roles/contacts.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:flutter_test/flutter_test.dart';

import 'common/support.dart';

void main() {
  test('production export', () async {
    final side = Platform.environment['BACKTEST_SIDE'] ?? 'new';
    final docs = Map<String, dynamic>.from(
      File(
            '${Platform.environment['BACKTEST_FIXTURES'] ?? 'tools/backtest/app/fixtures'}/export_docs.json',
          ).existsSync()
          ? fixture('export_docs.json')
          : const {},
    );
    if (docs.isEmpty) return;
    final db = await seeded(docs);
    final out = <String, Object?>{};
    final now = DateTime(2026, 11, 23);
    final emails = <String>{};
    for (final e in docs.entries) {
      final m = Map<String, dynamic>.from(hydrate(e.value)! as Map);
      final c = e.key.split('/').first;
      if (c == 'grants') {
        emails.add(m['email'] as String? ?? '');
        out[e.key] = await outcome(() async => Grant.fromMap(m).liveAt(now));
      } else if (c == 'staff') {
        out[e.key] = await outcome(
          () async => StaffEntry.fromMap(m).presidentOf.join(','),
        );
      } else if (c == 'directory') {
        out[e.key] = await outcome(
          () async =>
              DirectoryEntry.fromMap(e.key.split('/').last, m).roles.length,
        );
      }
    }
    for (final e in emails.where((e) => e.isNotEmpty)) {
      out['loadMine|$e'] = await outcome(() async {
        final r = await RoleStore(db, me: e, myName: 'x').loadMine(now: now);
        return r.grants.map((g) => g.id).join(',');
      });
    }
    emit('${side}_export.json', out);
  });
}
