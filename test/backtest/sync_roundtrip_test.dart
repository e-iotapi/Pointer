// old -> new -> old: the document the base build wrote (old_sync.json, from
// the harness) is applied by the new code and pushed back unchanged.
import 'dart:convert';
import 'dart:io';

import 'package:cgpa_calculator/sync.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

import 'common/support.dart';
import 'common/sync_probe.dart';

void main() {
  test('apply an old snapshot, push, read the same snapshot back', () async {
    final oldData = fixture('old_sync.json')['data'] as String;
    final db = FakeFirebaseFirestore();
    final done = await openSyncEnv(db);
    await Sync.init('u1');
    await Sync.apply(oldData);
    final snap = Sync.snapshot();
    expect(jsonDecode(snap), jsonDecode(oldData));
    await Sync.push();
    final d = (await db.doc('users/u1').get()).data()!;
    expect(jsonDecode(d['data'] as String), jsonDecode(oldData));
    expect(Sync.validate(d['data'] as String).keys, contains('coursesBox'));
    await done();
    expect(Directory.systemTemp.existsSync(), isTrue);
  });
}
