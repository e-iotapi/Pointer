import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late FakeFirebaseFirestore db;
  late RoleStore owner;

  setUp(() {
    db = FakeFirebaseFirestore();
    owner = RoleStore(
      db,
      me: 'owner@goa.bits-pilani.ac.in',
      myName: 'Owner',
      actingAs: () => (role: 'owner', viewingAs: null),
    );
  });

  Future<int> rolesMarker() async =>
      ((await db.collection('heads').doc('goa').get()).data()?['v']
              as Map?)?['roles']
          as int? ??
      0;

  test('saveCustomRole then roleDefs() returns it', () async {
    final id = await owner.saveCustomRole(
      name: 'Marks team',
      caps: {Capability.publish},
      termDays: 90,
      campus: 'goa',
      dept: 'ELEC',
    );
    final d = (await owner.roleDefs())[id]!;
    expect(
      (d.name, d.termDays, d.campus, d.dept),
      ('Marks team', 90, 'goa', 'ELEC'),
    );
    expect(d.caps, {Capability.publish});
    final raw = (await db.collection('roles').doc(id).get()).data()!;
    expect(raw['caps'], ['publish']);
    expect(raw['createdBy'], {
      'email': 'owner@goa.bits-pilani.ac.in',
      'name': 'Owner',
    });
    expect(raw['auditId'], isNotNull);
    expect(await rolesMarker(), 1);
  });

  test('saveBuiltin writes an audit entry and bumps roles', () async {
    await owner.saveBuiltin('cr', {Capability.publish}, 100);
    final raw = (await db.collection('roles').doc('builtin').get()).data()!;
    expect(raw.keys.toSet(), {'admin', 'president', 'cr', 'auditId'});
    expect(raw['cr'], {
      'caps': ['publish'],
      'termDays': 100,
    });
    expect((raw['admin'] as Map)['termDays'], 730);
    final audits = (await db.collection('audit').get()).docs.map(
      (d) => d.data()['path'],
    );
    expect(audits.toSet(), {'roles/builtin', 'config/grantTerms'});
    // The stable app's config/grantTerms gets the new CR term too.
    final terms =
        (await db.collection('config').doc('grantTerms').get()).data()!;
    expect(
      (terms['crDays'], terms['presidentDays'], terms['adminDays']),
      (100, 365, 730),
    );
    expect(raw['auditId'], isNotNull);
    expect(await rolesMarker(), 1);
    final d = await owner.roleDefs();
    expect(d['cr']!.caps, {Capability.publish});
    expect(d['president']!.caps, defaultBuiltinCaps()['president']);
  });

  test('deleteCustomRole removes it from roleDefs()', () async {
    final id = await owner.saveCustomRole(
      name: 'Temp',
      caps: {Capability.averages},
      termDays: 30,
      campus: 'all',
      dept: 'all',
    );
    await owner.deleteCustomRole(id);
    expect((await owner.roleDefs())[id], isNull);
    expect((await db.collection('audit').get()).docs.length, 2);
  });

  test('a custom grant has id custom|email and carries its roleId', () {
    expect(grantId(GrantRole.custom, 'goa', 'role', 'a@b.c'), 'custom|a@b.c');
    final g = Grant.fromMap({
      'role': 'custom',
      'email': 'a@b.c',
      'campus': 'goa',
      'scope': 'role',
      'roleId': 'r1',
      'active': true,
    });
    expect(g.roleId, 'r1');
    expect(Grant.fromMap(g.toMap()).roleId, 'r1');
  });

  group('custom grants write their staff entry', () {
    const holder = 'h@goa.bits-pilani.ac.in';
    Future<Grant> appointCustom(String id) async {
      await db.collection('people').doc(holder).set({'name': 'Holder'});
      await owner.appoint(
        role: GrantRole.custom,
        email: holder,
        campus: 'goa',
        scope: 'role',
        roleId: id,
        expiresAt: DateTime.now().add(const Duration(days: 30)),
      );
      return Grant.fromMap(
        (await db.collection('grants').doc('custom|$holder').get()).data()!,
      );
    }

    Future<List> reach() async =>
        (await db.collection('staff').doc(holder).get()).data()!['reach']
            as List;

    test('appoint adds the role campus and dept; revoke removes it', () async {
      final id = await owner.saveCustomRole(
        name: 'Marks team',
        caps: {Capability.publish},
        termDays: 90,
        campus: 'goa',
        dept: 'ELEC',
      );
      final g = await appointCustom(id);
      expect(await reach(), [
        {'role': 'custom', 'campus': 'goa', 'dept': 'ELEC'},
      ]);
      final s = (await db.collection('staff').doc(holder).get()).data()!;
      expect(s['admin'], false);
      expect(s['presidentOf'], isEmpty);
      expect(s['courses'], isEmpty);
      await owner.revoke(g);
      expect(await reach(), isEmpty);
    });

    test('revoking a grant whose role was deleted drops its reach', () async {
      final id = await owner.saveCustomRole(
        name: 'Marks team',
        caps: {Capability.publish},
        termDays: 90,
        campus: 'goa',
        dept: 'ELEC',
      );
      final g = await appointCustom(id);
      await owner.deleteCustomRole(id);
      await owner.revoke(g);
      expect(await reach(), isEmpty);
      final raw = (await db.collection('grants').doc(g.id).get()).data()!;
      expect(raw['active'], false);
    });

    test('re-appointing over a deleted role uses the new role', () async {
      final old = await owner.saveCustomRole(
        name: 'Old',
        caps: {Capability.publish},
        termDays: 90,
        campus: 'goa',
        dept: 'ELEC',
      );
      await appointCustom(old);
      await owner.deleteCustomRole(old);
      final fresh = await owner.saveCustomRole(
        name: 'New',
        caps: {Capability.publish},
        termDays: 90,
        campus: 'goa',
        dept: 'CS',
      );
      final g = await appointCustom(fresh);
      expect(g.roleId, fresh);
      expect(await reach(), [
        {'role': 'custom', 'campus': 'goa', 'dept': 'CS'},
      ]);
    });
  });
}
