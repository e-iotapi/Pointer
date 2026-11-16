import 'dart:io';

import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

/// The role table rows of ARCHITECTURE.md §4, as [label, owner, admin,
/// president, cr], skipping the descriptive Who / Account / Scope rows.
List<List<String>> documentTable() {
  final lines = File('agent_instructions/ARCHITECTURE.md').readAsLinesSync();
  final start = lines.indexWhere(
    (l) => l.startsWith('| | Owner | Admin | Department president'),
  );
  expect(start, isNot(-1), reason: 'the §4 role table header moved');
  final rows = <List<String>>[];
  for (final l in lines.skip(start + 2)) {
    if (!l.startsWith('|')) break;
    final cells = l.split('|').map((c) => c.trim()).toList();
    final row = cells.sublist(1, cells.length - 1);
    row[0] = row[0].replaceAll('**', '');
    if (!{'Who', 'Account', 'Scope'}.contains(row[0])) rows.add(row);
  }
  return rows;
}

void main() {
  test('the Dart table is a literal copy of ARCHITECTURE.md §4', () {
    expect([
      for (final c in Capability.values)
        [c.label, c.owner, c.admin, c.president, c.cr],
    ], documentTable());
  });

  test('students can do none of it', () {
    for (final c in Capability.values) {
      expect(can(Role.student, c), isFalse, reason: c.label);
    }
  });

  test('admins run course tools and moderation', () {
    for (final c in [
      Capability.courseStructures,
      Capability.bulkUpload,
      Capability.degreeRequirements,
      Capability.averages,
      Capability.professors,
      Capability.moderateReviews,
    ]) {
      expect(can(Role.admin, c), isTrue, reason: c.label);
    }
    expect(can(Role.admin, Capability.publish), isFalse);
    expect(can(Role.admin, Capability.appointAdmins), isFalse);
  });

  test('admin is narrow: appointments, public contact, CR/president terms', () {
    expect(can(Role.admin, Capability.appointPresidents), isTrue);
    expect(can(Role.admin, Capability.appointAdmins), isFalse);
    expect(can(Role.admin, Capability.publish), isFalse);
    expect(can(Role.admin, Capability.grantTermsAdmin), isFalse);
    expect(can(Role.admin, Capability.grantTermsCrPresident), isTrue);
  });

  test('presidents and CRs act only in scope', () {
    expect(can(Role.president, Capability.appointCrs), isTrue);
    expect(can(Role.president, Capability.appointCrs, inScope: false), isFalse);
    expect(can(Role.president, Capability.averages, inScope: false), isFalse);
    expect(can(Role.cr, Capability.averages), isTrue);
    expect(can(Role.cr, Capability.averages, inScope: false), isFalse);
    expect(can(Role.cr, Capability.appointCrs), isFalse);
  });

  test('a CR picks professors but never creates one', () {
    expect(can(Role.cr, Capability.professors), isFalse);
    expect(can(Role.president, Capability.professors), isTrue);
  });

  test('an owner never removes themselves', () {
    expect(can(Role.owner, Capability.addRemoveOwners), isTrue);
    expect(
      can(Role.owner, Capability.addRemoveOwners, targetIsSelf: true),
      isFalse,
    );
  });

  test('defaults follow the table', () {
    final d = defaultBuiltinCaps();
    expect(d['admin'], contains(Capability.courseStructures));
    expect(d['admin'], isNot(contains(Capability.publish)));
    expect(d['cr'], {
      Capability.courseStructures,
      Capability.courseResources,
      Capability.averages,
      Capability.contribute,
    });
  });

  test(
    'default CR ⊆ president ⊆ admin, so today\'s appointments still pass M1',
    () {
      final d = defaultBuiltinCaps();
      expect(d['president']!.difference(d['admin']!), isEmpty);
      expect(d['cr']!.difference(d['president']!), isEmpty);
    },
  );

  test('every row has a reach and a stable key', () {
    expect(
      Capability.values.map((c) => c.key).toSet().length,
      Capability.values.length,
    );
    expect(Capability.openAs.reach, CapReach.everywhere);
  });
}
