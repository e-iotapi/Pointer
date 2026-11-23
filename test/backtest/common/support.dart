// Shared by the new-app tests and by the old-app harness (this folder is
// copied into the extracted base tree by tools/backtest/app/run.mjs), so it
// may only use APIs that exist in both builds: Grant, StaffEntry, MyRoles,
// RoleStore.loadMine/roster/terms, GateStore, Head, DirectoryEntry, Hive.
import 'dart:convert';
import 'dart:io';

import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart' as ft;

/// Where results go (`$BACKTEST_OUT`); null in the normal suite, which then
/// only asserts and writes nothing.
String? get outDir => Platform.environment['BACKTEST_OUT'];

/// Writes [data] as `$BACKTEST_OUT/[name]` when an out dir is set.
void emit(String name, Object data) {
  final d = outDir;
  if (d == null) return;
  Directory(d).createSync(recursive: true);
  File(
    '$d/$name',
  ).writeAsStringSync(const JsonEncoder.withIndent(' ').convert(data));
}

/// A fixture file under tools/backtest/app/fixtures.
///
/// `$BACKTEST_FIXTURES` (run.mjs: committed fixtures with this base's
/// regenerated ones laid over them) wins over the committed folder.
Map<String, dynamic> fixture(String name) =>
    jsonDecode(
          File(
            '${Platform.environment['BACKTEST_FIXTURES'] ?? 'tools/backtest/app/fixtures'}/$name',
          ).readAsStringSync(),
        )
        as Map<String, dynamic>;

/// Fixture JSON has no Timestamp: `{"$ts": millis}` stands for one.
Object? hydrate(Object? v) => switch (v) {
  {r'$ts': final int ms} => Timestamp.fromMillisecondsSinceEpoch(ms),
  Map m => {for (final e in m.entries) '${e.key}': hydrate(e.value)},
  List l => [for (final x in l) hydrate(x)],
  _ => v,
};

/// The inverse of [hydrate], for dumping a fake Firestore.
Object? dehydrate(Object? v) => switch (v) {
  Timestamp t => {r'$ts': t.millisecondsSinceEpoch},
  Map m => {for (final e in m.entries) '${e.key}': dehydrate(e.value)},
  List l => [for (final x in l) dehydrate(x)],
  _ => v,
};

/// A fake Firestore holding [docs], a map of `collection/id` to data.
Future<FakeFirebaseFirestore> seeded(Map<String, dynamic> docs) async {
  final db = FakeFirebaseFirestore();
  for (final e in docs.entries) {
    await db
        .doc(e.key)
        .set(Map<String, dynamic>.from(hydrate(e.value)! as Map));
  }
  return db;
}

/// Every document of [collections] as `collection/id` -> data.
Future<Map<String, dynamic>> dump(
  FirebaseFirestore db,
  Iterable<String> collections,
) async => {
  for (final c in collections)
    for (final d in (await db.collection(c).get()).docs)
      '$c/${d.id}': dehydrate(d.data()),
};

/// The collections the app touches that [dump] should capture.
const touched = [
  'people',
  'owners',
  'grants',
  'staff',
  'audit',
  'config',
  'heads',
  'reviewGate',
  'directory',
  'roles',
  'searchHints',
];

/// One person for the tests, with the grants built by `grant`.
typedef Persona = ({String name, String email, bool owner, List<Grant> grants});

/// A live grant with the shape the stable app reads.
Grant grant(
  GrantRole role,
  String email,
  String campus,
  String scope, {
  String? programme,
  bool secretary = false,
}) => Grant(
  role: role,
  email: email,
  name: 'N',
  campus: campus,
  scope: scope,
  programme: programme,
  active: true,
  expiresAt: DateTime(2100),
  secretary: secretary,
);

/// Everyone the matrix and the corruption probes ask about.
List<Persona> personas() {
  const s = 'f20249994@goa.bits-pilani.ac.in';
  const h = 'f20249997@hyderabad.bits-pilani.ac.in';
  const p = 'f20209991@pilani.bits-pilani.ac.in';
  return [
    (name: 'student', email: s, owner: false, grants: const []),
    (name: 'owner', email: 'owner@pointer.test', owner: true, grants: const []),
    (name: 'owner_goa', email: s, owner: true, grants: const []),
    (
      name: 'admin_pilani',
      email: p,
      owner: false,
      grants: [grant(GrantRole.admin, p, 'all', 'all')],
    ),
    (
      name: 'admin_goa',
      email: s,
      owner: false,
      grants: [grant(GrantRole.admin, s, 'all', 'all')],
    ),
    (
      name: 'president_goa_ELEC',
      email: s,
      owner: false,
      grants: [grant(GrantRole.dept, s, 'goa', 'ELEC', programme: 'A3')],
    ),
    (
      name: 'president_hyd_CS',
      email: h,
      owner: false,
      grants: [grant(GrantRole.dept, h, 'hyderabad', 'CS')],
    ),
    (
      name: 'secretary_goa_GEN',
      email: s,
      owner: false,
      grants: [grant(GrantRole.dept, s, 'goa', 'GEN', secretary: true)],
    ),
    (
      name: 'cr_goa_EEE',
      email: s,
      owner: false,
      grants: [grant(GrantRole.course, s, 'goa', 'EEE F211')],
    ),
    (
      name: 'president_and_cr',
      email: s,
      owner: false,
      grants: [
        grant(GrantRole.dept, s, 'goa', 'ELEC'),
        grant(GrantRole.course, s, 'hyderabad', 'CS F111'),
      ],
    ),
  ];
}

/// Runs [f]; "ok" or "throws:Type" (the answer must not hide a crash).
Future<String> outcome(Future<Object?> Function() f) async {
  try {
    final v = await f();
    return v == null ? 'ok' : 'ok:$v';
  } on Object catch (e) {
    return 'throws:${e.runtimeType}';
  }
}

/// A test that proves a known break. Skipped in the normal suite (it fails
/// until the break is fixed); tools/backtest/app/run.mjs sets BACKTEST_RUN so
/// it runs there and is reported as a break.
void breakTest(String id, Future<void> Function() body) => ft.test(
  'BREAK $id',
  body,
  skip:
      Platform.environment['BACKTEST_RUN'] == null
          ? 'known break: run tools/backtest/app/run.mjs'
          : false,
);
