// Every Capability x every kind of holder: MyRoles.may must equal the answer
// worked out from the role definitions and the holder's reach, the same shape
// as test/rules/capability_matrix.test.mjs (no hand-written table).
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:flutter_test/flutter_test.dart';

final _later = DateTime(2100);
const _admin = 'adm@pilani.bits-pilani.ac.in';
const _goa = 'f20230001@goa.bits-pilani.ac.in';
const _hyd = 'f20230002@hyderabad.bits-pilani.ac.in';

Grant _grant(
  GrantRole r,
  String email,
  String campus,
  String scope, {
  String? roleId,
  bool active = true,
  DateTime? exp,
  bool sec = false,
}) => Grant(
  role: r,
  email: email,
  name: 'X',
  campus: campus,
  scope: scope,
  active: active,
  expiresAt: exp ?? _later,
  roleId: roleId,
  secretary: sec,
);

typedef _Target = ({String campus, String dept, String course});
const _in = (campus: 'goa', dept: 'ELEC', course: 'EEE F211');
const _out = (campus: 'hyderabad', dept: 'CS', course: 'CS F211');

/// A holder: what it is built from, and a fresh MyRoles for a row [cap].
class _Actor {
  _Actor(this.name, this.build);
  final String name;
  final MyRoles Function(Capability cap) build;
}

RoleDefs _defsWith(
  Map<String, Set<Capability>> custom, {
  Map<String, ({String campus, String dept})> scope = const {},
}) => RoleDefs({
  ...RoleDefs.defaults().byId,
  for (final e in custom.entries)
    e.key: RoleDef(
      id: e.key,
      name: e.key,
      tag: 'ROLE',
      caps: e.value,
      termDays: 183,
      builtin: false,
      campus: scope[e.key]?.campus ?? 'all',
      dept: scope[e.key]?.dept ?? 'all',
    ),
});

MyRoles _custom(
  Capability cap,
  String campus,
  String dept, {
  bool ticked = true,
  bool active = true,
  DateTime? exp,
  bool deleted = false,
  List<Grant> grants = const [],
  String email = _goa,
}) => MyRoles(
  email: email,
  grants: grants,
  defs: _defsWith(
    {
      if (!deleted)
        'r': ticked ? {cap} : (Capability.values.toSet()..remove(cap)),
    },
    scope: {'r': (campus: campus, dept: dept)},
  ),
  custom: _grant(
    GrantRole.custom,
    email,
    'all',
    'role',
    roleId: 'r',
    active: active,
    exp: exp,
  ),
);

final _actors = <_Actor>[
  _Actor('owner', (_) => const MyRoles(email: 'o@x.com', owner: true)),
  _Actor(
    'admin',
    (_) => MyRoles(
      email: _admin,
      grants: [_grant(GrantRole.admin, _admin, 'all', 'all')],
    ),
  ),
  _Actor(
    'president',
    (_) => MyRoles(
      email: _goa,
      grants: [_grant(GrantRole.dept, _goa, 'goa', 'ELEC')],
    ),
  ),
  _Actor(
    'secretary',
    (_) => MyRoles(
      email: _goa,
      grants: [_grant(GrantRole.dept, _goa, 'goa', 'ELEC', sec: true)],
    ),
  ),
  _Actor(
    'cr',
    (_) => MyRoles(
      email: _goa,
      grants: [_grant(GrantRole.course, _goa, 'goa', 'EEE F211')],
    ),
  ),
  _Actor('student', (_) => const MyRoles(email: _goa)),
  _Actor('custom@dept', (c) => _custom(c, 'goa', 'ELEC')),
  _Actor('custom@campus', (c) => _custom(c, 'goa', 'all')),
  _Actor('custom@all', (c) => _custom(c, 'all', 'all')),
  _Actor('custom@hyd', (c) => _custom(c, 'hyderabad', 'all')),
  _Actor('custom unticked', (c) => _custom(c, 'all', 'all', ticked: false)),
  _Actor(
    'custom expired',
    (c) => _custom(c, 'all', 'all', exp: DateTime(2000)),
  ),
  _Actor('custom revoked', (c) => _custom(c, 'all', 'all', active: false)),
  _Actor('custom deleted role', (c) => _custom(c, 'all', 'all', deleted: true)),
  _Actor(
    'worst case: custom@dept + CR',
    (c) => _custom(
      c,
      'goa',
      'ELEC',
      grants: [_grant(GrantRole.course, _goa, 'goa', 'EEE F211')],
    ),
  ),
];

/// The answer from the definitions and the holder's reach, written from the
/// rules' wording, not from MyRoles.
bool _expected(Capability cap, MyRoles a, _Target t) {
  if (a.owner) return true;
  final defs = a.defs ?? RoleDefs.defaults();
  bool ticked(String id) => defs[id]?.caps.contains(cap) ?? false;
  final deptRow = cap.reach == CapReach.dept;
  final ownCampusOnly =
      cap == Capability.departmentResources ||
      cap == Capability.courseResources;
  final admin = a.grants.any((g) => g.role == GrantRole.admin);
  if (admin &&
      ticked('admin') &&
      (!ownCampusOnly || t.campus == campusOfAddress(a.email))) {
    return true;
  }
  final campusRow = cap.reach == CapReach.campus;
  if ((deptRow || campusRow) && ticked('president')) {
    for (final g in a.grants.where((g) => g.role == GrantRole.dept)) {
      if (g.campus == t.campus && (campusRow || g.scope == t.dept)) return true;
    }
  }
  if ((deptRow || campusRow) && ticked('cr')) {
    for (final g in a.grants.where((g) => g.role == GrantRole.course)) {
      if (g.campus == t.campus && (campusRow || g.scope == t.course)) {
        return true;
      }
    }
  }
  final g = a.custom;
  if (g == null || g.expiresAt.isBefore(DateTime.now()) || !g.active) {
    return false;
  }
  final r = defs[g.roleId!];
  if (r == null || !r.caps.contains(cap) || customExcluded.contains(cap)) {
    return false;
  }
  if (cap.reach == CapReach.everywhere || r.campus == 'all') return true;
  return r.campus == t.campus &&
      campusOfAddress(a.email) == t.campus &&
      (r.dept == 'all' || cap.reach == CapReach.campus || r.dept == t.dept);
}

void main() {
  test('every Capability appears in the matrix', () {
    final seen = <Capability>{};
    for (final c in Capability.values) {
      for (final a in _actors) {
        a.build(c);
      }
      seen.add(c);
    }
    expect(seen, Capability.values.toSet());
    expect(Capability.values.length, greaterThan(20));
  });

  for (final cap in Capability.values) {
    for (final actor in _actors) {
      test('${cap.key} x ${actor.name}', () {
        final me = actor.build(cap);
        for (final t in [_in, _out]) {
          expect(
            me.may(
              cap,
              campus: t.campus,
              scope: cap.reach == CapReach.dept ? t.course : null,
            ),
            _expected(cap, me, t),
            reason: '${t.campus}/${t.dept}',
          );
        }
      });
    }
  }

  test('a missing custom role gives no rights', () {
    for (final c in Capability.values) {
      expect(_custom(c, 'all', 'all', deleted: true).may(c), isFalse);
      expect(_custom(c, 'all', 'all', deleted: true).reach(c), isEmpty);
    }
  });

  test('reach(averages) for a goa|ELEC president is [goa/ELEC]', () {
    final r = _actors[2].build(Capability.averages).reach(Capability.averages);
    expect(r.map((e) => e.toMap()), [
      {'role': 'president', 'campus': 'goa', 'dept': 'ELEC'},
    ]);
    expect(r.single.covers('goa', 'ELEC', 'EEE F211'), isTrue);
    expect(r.single.covers('goa', 'CS', null), isFalse);
  });

  test('reach: owner and admin everywhere, CR by course, custom by scope', () {
    const all = {'role': 'admin', 'campus': 'all'};
    final c = Capability.averages;
    expect(_actors[0].build(c).reach(c).single.toMap(), all);
    expect(_actors[1].build(c).reach(c).single.toMap(), all);
    expect(_actors[4].build(c).reach(c).single.toMap(), {
      'role': 'cr',
      'campus': 'goa',
      'course': 'EEE F211',
    });
    expect(_custom(c, 'goa', 'CS').reach(c).single.toMap(), {
      'role': 'custom',
      'campus': 'goa',
      'dept': 'CS',
    });
    expect(
      _custom(
        Capability.publish,
        'goa',
        'CS',
      ).reach(Capability.publish).single.toMap(),
      {'role': 'custom', 'campus': 'all'},
    );
    expect(_actors[5].build(c).reach(c), isEmpty);
  });

  test('unticking averages for president in defs makes may false', () {
    final caps = defaultBuiltinCaps();
    final defs = RoleDefs(
      RoleDefs.defaults().byId.map(
        (k, v) =>
            k == 'president'
                ? MapEntry(
                  k,
                  RoleDef(
                    id: k,
                    name: v.name,
                    tag: v.tag,
                    caps: {...caps['president']!}..remove(Capability.averages),
                    termDays: v.termDays,
                    builtin: true,
                    fixedReach: v.fixedReach,
                  ),
                )
                : MapEntry(k, v),
      ),
    );
    final me = MyRoles(
      email: _goa,
      defs: defs,
      grants: [_grant(GrantRole.dept, _goa, 'goa', 'ELEC')],
    );
    expect(
      me.may(Capability.averages, campus: 'goa', scope: 'EEE F211'),
      isFalse,
    );
    expect(
      me.may(Capability.courseStructures, campus: 'goa', scope: 'EEE F211'),
      isTrue,
    );
  });

  test('reachesAdmin: owner, admin or a custom grant', () {
    expect(_actors[0].build(Capability.averages).reachesAdmin, isTrue);
    expect(_actors[1].build(Capability.averages).reachesAdmin, isTrue);
    expect(_actors[2].build(Capability.averages).reachesAdmin, isFalse);
    expect(_custom(Capability.averages, 'all', 'all').reachesAdmin, isTrue);
  });

  test('Reach round-trips and covers', () {
    const r = Reach(role: 'cr', campus: 'goa', course: 'CS F211');
    expect(Reach.fromMap(r.toMap()).toMap(), r.toMap());
    expect(r.covers('goa', 'CS', 'CS F211'), isTrue);
    expect(r.covers('goa', 'CS', 'CS F301'), isFalse);
    expect(r.covers('goa', 'CS', null), isFalse);
    const a = Reach(role: 'admin', campus: 'all');
    expect(a.covers('pilani', 'ME', 'ME F111'), isTrue);
    expect(a.covers(null, null, null), isTrue);
    const c = Reach(role: 'custom', campus: 'goa', dept: 'all');
    expect(c.covers('goa', 'CS', null), isTrue);
    expect(c.covers('pilani', 'CS', null), isFalse);
  });

  test('presidents and CRs keep their own-campus campus rows', () {
    final p = _actors[2].build(Capability.averages);
    for (final c in [
      Capability.readAuditAndRoster,
      Capability.reviewGateSwitch,
    ]) {
      expect(p.may(c, campus: 'goa'), isTrue);
      expect(p.may(c, campus: 'hyderabad'), isFalse);
    }
    final cr = _actors[4].build(Capability.averages);
    expect(cr.may(Capability.contribute, campus: 'goa'), isTrue);
    expect(cr.may(Capability.contribute, campus: 'hyderabad'), isFalse);
    expect(p.may(Capability.publish, campus: 'goa'), isFalse);
  });
}
