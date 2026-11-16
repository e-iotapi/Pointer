import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('defaults() has admin, president, cr with the B1 caps and terms', () {
    final d = RoleDefs.defaults();
    final caps = defaultBuiltinCaps();
    for (final id in builtinRoleKeys) {
      expect(d[id]!.caps, caps[id]);
      expect(d[id]!.termDays, defaultTermDays[id]);
      expect(d[id]!.builtin, isTrue);
    }
    expect(d['admin']!.fixedReach, ReachKind.everywhere);
    expect(d['president']!.fixedReach, ReachKind.dept);
    expect(d['cr']!.fixedReach, ReachKind.course);
    expect(d['owner']!.caps, Capability.values.toSet());
  });

  test('fromDocs with a missing builtin falls back to defaults', () {
    final d = RoleDefs.fromDocs(null, {});
    expect(d['cr']!.caps, defaultBuiltinCaps()['cr']);
  });

  test('an unknown key in stored caps is dropped', () {
    final d = RoleDefs.fromDocs(
      {
        'admin': {
          'caps': ['averages', 'noSuchRow'],
          'termDays': 100,
        },
      },
      {
        'x1': {
          'name': 'Marks team',
          'caps': ['publish', 'nope'],
          'termDays': 30,
          'campus': 'goa',
          'dept': 'ELEC',
        },
      },
    );
    expect(d['admin']!.caps, {Capability.averages});
    expect(d['admin']!.termDays, 100);
    expect(d['president']!.caps, defaultBuiltinCaps()['president']);
    final c = d['x1']!;
    expect(c.caps, {Capability.publish});
    expect(
      (c.name, c.tag, c.builtin, c.fixedReach),
      ('Marks team', 'ROLE', false, null),
    );
    expect((c.campus, c.dept), ('goa', 'ELEC'));
  });
}
