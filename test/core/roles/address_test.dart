import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('a short campus address gets its domain', () {
    expect(
      fullBitsAddress(' F20230800@Goa '),
      'f20230800@goa.bits-pilani.ac.in',
    );
    expect(
      fullBitsAddress('f20230800@hyderabad'),
      'f20230800@hyderabad.bits-pilani.ac.in',
    );
    expect(
      fullBitsAddress('f20230800@goa.bits-pilani.ac.in'),
      'f20230800@goa.bits-pilani.ac.in',
    );
    expect(fullBitsAddress('someone@gmail.com'), 'someone@gmail.com');
    expect(fullBitsAddress('f20230800'), 'f20230800');
    expect(campusOfAddress(fullBitsAddress('f20230800@goa')), 'goa');
  });

  test('MyRoles keeps only grants the rules honour (BRK-001/002/009)', () {
    Grant g(GrantRole r, String campus) => Grant(
      role: r,
      email: '',
      name: '',
      campus: campus,
      scope: 'x',
      active: true,
      expiresAt: DateTime(2100),
    );
    final all = [
      g(GrantRole.admin, 'all'),
      g(GrantRole.dept, 'goa'),
      g(GrantRole.course, 'hyderabad'),
    ];
    final student = MyRoles(
      email: 'f20230800@goa.bits-pilani.ac.in',
      grants: all,
    );
    expect(student.grants.map((x) => x.role), [
      GrantRole.admin,
      GrantRole.dept,
    ]);
    expect(student.admin, isTrue);
    for (final who in ['rmenon@goa.bits-pilani.ac.in', 'someone@gmail.com']) {
      final r = MyRoles(email: who, grants: all);
      expect(r.grants, isEmpty, reason: who);
      expect(r.admin || r.privileged, isFalse, reason: who);
    }
  });

  test('a damaged staff reach is read, not thrown (backtest probe)', () {
    for (final bad in <Object?>[
      'goa',
      5,
      ['x', 1],
    ]) {
      expect(
        StaffEntry.fromMap({'email': 'e', 'reach': bad}).reach,
        isEmpty,
        reason: '$bad',
      );
    }
    final ok = StaffEntry.fromMap({
      'email': 'e',
      'reach': [
        'x',
        {'role': 'custom', 'campus': 'goa'},
      ],
    });
    expect(ok.reach, hasLength(1));
  });
}
