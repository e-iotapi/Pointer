// A user upgrading from the stable app: Hive boxes and caches written by the
// base build's own code (old_storage.json) read by the new code, plus the
// new-only storage damage (cached definitions, a lapsed custom grant).
import 'dart:convert';
import 'dart:io';

import 'package:cgpa_calculator/core/cache/cache_first.dart';
import 'package:cgpa_calculator/core/reviews/gate_store.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/contacts.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/core/search/hints.dart';
import 'package:cgpa_calculator/core/storage/cache_boxes.dart';
import 'package:cgpa_calculator/features/setup/campus_pick_page.dart'
    show viewCampus;
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';

import 'common/support.dart';

const pres = 'f20239992@goa.bits-pilani.ac.in';

void main() {
  late Directory dir;
  late Box dev;
  final st = fixture('old_storage.json');

  setUp(() async {
    dir = await Directory.systemTemp.createTemp('bt_upgrade');
    Hive.init(dir.path);
    await openDeviceBox();
    await openSharedCache();
    dev = Hive.box(deviceBoxName);
    for (final e in (st['deviceBox'] as Map).entries) {
      await dev.put(e.key, e.value);
    }
    for (final e in (st['sharedCache'] as Map).entries) {
      await sharedCacheBox!.put(e.key, e.value);
    }
    myRoles.value = MyRoles.none;
    workingAs.value = null;
    viewAs.value = null;
    roleStore = RoleStore(FakeFirebaseFirestore(), me: pres, myName: 'P');
  });
  tearDown(() async {
    roleStore = null;
    await Hive.close();
    await dir.delete(recursive: true);
  });

  test('old cached roles restore: grants, workingAs, no defs, no custom', () {
    restoreMyRoles(email: pres);
    final r = myRoles.value;
    expect(r.email, pres);
    expect(r.grants.single.scope, 'ELEC');
    expect(r.defs, isNull);
    expect(r.custom, isNull);
    expect(
      r.may(Capability.courseStructures, campus: 'goa', scope: 'ELEC'),
      isTrue,
    );
    expect(workingAs.value?.id, 'dept|goa|ELEC|$pres');
    expect(dev.get('pref.starred'), ['EEE F211', 'CS F111']);
  });

  test('the old cached roles JSON round-trips through new refresh code', () {
    restoreMyRoles(email: pres);
    final again = jsonDecode(dev.get('roles') as String) as Map;
    expect(again.keys, containsAll(['email', 'owner', 'grants']));
  });

  test('previewCampus saved by the old owner preview', () {
    // Old: the address's own campus won; new: a pick wins only for owner/admin.
    expect(viewCampus(), 'goa', reason: 'president ignores the pick');
    myRoles.value = const MyRoles(email: pres, owner: true);
    expect(
      viewCampus(),
      'pilani',
      reason: 'owner/admin: intended (Settings › Campus)',
    );
  });

  test('old shared-cache entries decode through the new peek*', () {
    final s = RoleStore(
      FakeFirebaseFirestore(),
      me: 'owner@pointer.test',
      myName: 'O',
    );
    expect(s.peekRoster(campus: 'goa'), isNotEmpty);
    expect(s.peekRoster(), isNotEmpty);
    expect(s.peekAudit(campus: 'goa'), isNotEmpty);
    expect(s.peekTerms(), (crDays: 183, presidentDays: 365, adminDays: 730));
    expect(s.peekRoleDefs(), isNull, reason: 'no cache under the new key yet');
    expect(GateStore(s).peekOf('goa'), isTrue);
    expect(SearchHints(FakeFirebaseFirestore()).peek('goa'), isNotNull);
    expect(ContactStore(s).peekDirectory('goa'), isNotNull);
  });

  test(
    'an old cache entry under a new key shape is dropped, not thrown',
    () async {
      await sharedCacheBox!.put('roles', '{"v":{"admin":5},"at":1}');
      final s = RoleStore(FakeFirebaseFirestore(), me: pres, myName: 'P');
      expect(s.peekRoleDefs(), isNull);
      expect(await s.roleDefs(), isNotNull);
    },
  );

  test('cached-defs-damaged-drops-grants', () async {
    final m = jsonDecode(dev.get('roles') as String) as Map<String, dynamic>;
    for (final bad in <Object?>[
      'x',
      5,
      {'admin': 1},
      {},
      [],
    ]) {
      dev.put('roles', jsonEncode({...m, 'defs': bad}));
      myRoles.value = MyRoles.none;
      expect(() => restoreMyRoles(email: pres), returnsNormally);
      // A damaged defs entry must not cost the person their grants.
      expect(myRoles.value.grants, isNotEmpty, reason: 'defs=$bad');
    }
  });

  test('lapsed-custom-cache-opens-admin', () async {
    final m = jsonDecode(dev.get('roles') as String) as Map<String, dynamic>;
    final lapsed =
        grant(GrantRole.custom, pres, 'goa', 'role').toMap()
          ..['expiresAt'] = 1000
          ..['roleId'] = 'r1';
    dev.put('roles', jsonEncode({...m, 'grants': [], 'custom': lapsed}));
    restoreMyRoles(email: pres);
    expect(myRoles.value.may(Capability.publishTimetable), isFalse);
    expect(
      myRoles.value.reachesAdmin,
      isFalse,
      reason: 'a lapsed custom grant must not open the admin screens',
    );
  });
}
