// Writes the documents the NEW app writes (custom roles, staff with reach,
// roles/builtin, the config/grantTerms mirror, grants with roleId, gate
// without dept, negative search votes) with the new app's own store code.
// run.mjs hands the result to the base build's harness (mixed fleet).
import 'package:cgpa_calculator/core/reviews/gate_store.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/search/hints.dart';
import 'package:flutter_test/flutter_test.dart';

import 'common/support.dart';

void main() {
  test('generate new-app documents', () async {
    final base = fixture('old_app_docs.json')..remove('_comment');
    final db = await seeded(base);
    final owner = RoleStore(
      db,
      me: 'owner@pointer.test',
      myName: 'Test Owner',
      actingAs: () => (role: 'owner', viewingAs: null),
    );
    const holder = 'f20249994@goa.bits-pilani.ac.in'; // custom only
    const both = 'f20239993@goa.bits-pilani.ac.in'; // CR + custom
    final rid = await owner.saveCustomRole(
      name: 'Marks team',
      caps: {Capability.publishTimetable, Capability.contribute},
      termDays: 90,
      campus: 'goa',
      dept: 'all',
    );
    final far = DateTime(2100);
    for (final e in [holder, both]) {
      await owner.appoint(
        role: GrantRole.custom,
        email: e,
        campus: 'goa',
        scope: 'role',
        expiresAt: far,
        roleId: rid,
      );
    }
    // A president also appointed through the new code: staff gains reach.
    await owner.appoint(
      role: GrantRole.dept,
      email: 'f20239992@goa.bits-pilani.ac.in',
      campus: 'goa',
      scope: 'ELEC',
      programme: 'A3',
      expiresAt: far,
    );
    await owner.saveBuiltin('cr', {
      Capability.contribute,
      Capability.courseStructures,
    }, 120);
    await GateStore(owner).set('goa', false);
    await GateStore(owner).set('goa', true);
    await SearchHints(db).learn('goa', 'oel', 'open elective', -1);
    final docs = await dump(db, touched);
    expect(docs.keys.any((k) => k.startsWith('roles/')), isTrue);
    emit('new_app_docs.json', docs);
  });
}
