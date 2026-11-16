import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:flutter_test/flutter_test.dart';

Grant _g(GrantRole role, String scope, {bool active = true, String? dept}) =>
    Grant(
      role: role,
      email: 'a@goa.bits-pilani.ac.in',
      name: 'A',
      campus: 'goa',
      scope: scope,
      active: active,
      expiresAt: DateTime(2030),
      dept: dept,
    );

const _e = StaffEntry(email: 'a@goa.bits-pilani.ac.in');

List<Map> _reach(Map<String, dynamic> m) => [
  for (final r in m['reach'] as List) r as Map,
];

void main() {
  test(
    'a custom grant at goa|CS adds {role: custom, campus: goa, dept: CS}',
    () {
      final m = _e.after(_g(GrantRole.custom, 'role', dept: 'CS'));
      expect(_reach(m), [
        {'role': 'custom', 'campus': 'goa', 'dept': 'CS'},
      ]);
    },
  );

  test(
    'a campus-wide or every-campus role reaches dept all and its campus',
    () {
      final m = _e.after(_g(GrantRole.custom, 'role'), roleCampus: 'all');
      expect(_reach(m), [
        {'role': 'custom', 'campus': 'all', 'dept': 'all'},
      ]);
    },
  );

  test('revoking removes it; a changed role replaces it', () {
    final on = StaffEntry.fromMap(
      _e.after(_g(GrantRole.custom, 'role', dept: 'CS')),
    );
    expect(
      _reach(on.after(_g(GrantRole.custom, 'role', active: false))),
      isEmpty,
    );
    final swapped = _reach(on.after(_g(GrantRole.custom, 'role', dept: 'EEE')));
    expect(swapped, [
      {'role': 'custom', 'campus': 'goa', 'dept': 'EEE'},
    ]);
  });

  test(
    'presidents, CRs and admins keep their entries beside the old fields',
    () {
      var s = _e;
      s = StaffEntry.fromMap(s.after(_g(GrantRole.dept, 'ELEC')));
      s = StaffEntry.fromMap(s.after(_g(GrantRole.course, 'EEE F211')));
      final m = s.after(_g(GrantRole.admin, 'all'));
      expect(m['presidentOf'], ['ELEC']);
      expect(m['courses'], ['EEE F211']);
      expect(_reach(m), [
        {'role': 'president', 'campus': 'goa', 'dept': 'ELEC'},
        {'role': 'cr', 'campus': 'goa', 'course': 'EEE F211'},
        {'role': 'admin', 'campus': 'all'},
      ]);
      final gone = StaffEntry.fromMap(
        m,
      ).after(_g(GrantRole.dept, 'ELEC', active: false));
      expect(_reach(gone).any((r) => r['role'] == 'president'), isFalse);
    },
  );

  test('an old staff document without reach reads as no reach', () {
    final s = StaffEntry.fromMap({'email': 'a@goa.bits-pilani.ac.in'});
    expect(s.reach, isEmpty);
  });
}
