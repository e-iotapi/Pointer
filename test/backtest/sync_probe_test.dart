// Runs in both trees: pushes a student's data and emits the users/{uid}
// document, so run.mjs can check old and new write identical bytes.
import 'package:cgpa_calculator/sync.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'dart:io';

import 'common/support.dart';
import 'common/sync_probe.dart';

void main() {
  test('push', () async {
    final db = FakeFirebaseFirestore();
    final done = await openSyncEnv(db);
    await Sync.init('u1');
    await fillBoxes();
    await Sync.push();
    final d = (await db.doc('users/u1').get()).data()!;
    emit('${Platform.environment['BACKTEST_SIDE'] ?? 'new'}_sync.json', {
      'data': d['data'],
      'keys': (d.keys.toList()..sort()),
    });
    expect(d['data'], contains('CS F111'));
    await done();
  });
}
