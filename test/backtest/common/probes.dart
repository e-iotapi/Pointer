// Probes that run unchanged against the base build and the new build, then
// are diffed by tools/backtest/app/run.mjs. Common APIs only (see support).
import 'dart:convert';
import 'dart:io';

import 'package:cgpa_calculator/core/heads/heads.dart';
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
import 'package:hive_ce/hive.dart';

import 'support.dart';

/// `persona|capability|campus|scope` -> may(), for every capability named in
/// [caps] (the base build's names, so both builds answer the same rows).
Map<String, bool> mayMatrix(Iterable<String> caps) {
  final out = <String, bool>{};
  final rows = [
    for (final c in Capability.values)
      if (caps.contains(c.name)) c,
  ];
  for (final p in personas()) {
    final me = MyRoles(email: p.email, owner: p.owner, grants: p.grants);
    for (final c in rows) {
      for (final campus in [null, 'goa', 'hyderabad', 'pilani']) {
        for (final scope in [
          null,
          'ELEC',
          'CS',
          'GEN',
          'EEE F211',
          'CS F111',
        ]) {
          out['${p.name}|${c.name}|${campus ?? '*'}|${scope ?? '*'}'] = me.may(
            c,
            campus: campus,
            scope: scope,
          );
        }
      }
    }
  }
  return out;
}

Map<String, dynamic> _goodGrant() => {
  'role': 'dept',
  'email': 'f20249994@goa.bits-pilani.ac.in',
  'name': 'Good',
  'campus': 'goa',
  'scope': 'ELEC',
  'programme': 'A3',
  'active': true,
  'expiresAt': {r'$ts': DateTime(2100).millisecondsSinceEpoch},
  'grantedBy': {'email': 'owner@pointer.test', 'name': 'Owner'},
  'grantedAt': {r'$ts': 1700000000000},
  'auditId': 'a1',
};

/// Damaged grant documents: field -> value (null value deletes the field).
Map<String, Map<String, Object?>> corruptGrants() => {
  'baseline': {},
  'email_missing': {'email': null},
  'role_missing': {'role': null},
  'role_unknown': {'role': 'wizard'},
  'campus_missing': {'campus': null},
  'scope_missing': {'scope': null},
  'scope_number': {'scope': 7},
  'name_null': {'name': null},
  'name_huge': {'name': 'x' * 400000},
  'active_string': {'active': 'yes'},
  'active_missing': {'active': null},
  'expires_millis': {'expiresAt': 4102444800000},
  'expires_ts': {
    'expiresAt': {r'$ts': 4102444800000},
  },
  'expires_null': {'expiresAt': null},
  'expires_string': {'expiresAt': '2100-01-01'},
  'expires_double': {'expiresAt': 4102444800000.5},
  'expires_negative': {
    'expiresAt': {r'$ts': -1},
  },
  'grantedBy_string': {'grantedBy': 'owner'},
  'grantedBy_null': {'grantedBy': null},
  'grantedAt_string': {'grantedAt': 'yesterday'},
  'programme_number': {'programme': 3},
  'secretary_string': {'secretary': 'true'},
  'unknown_keys': {'zzNew': 1, 'roleId': 'r1', 'dept': 'ELEC', 'extra': []},
  'custom_role': {'role': 'custom', 'roleId': 'r1', 'scope': 'role'},
  'contributor_role': {'role': 'contributor', 'dept': 'ELEC'},
};

Map<String, Object?> _grantWith(Map<String, Object?> o) {
  final m = _goodGrant();
  for (final e in o.entries) {
    if (e.value == null) {
      m.remove(e.key);
    } else {
      m[e.key] = e.value;
    }
  }
  return m;
}

/// Damaged grant, staff, head, directory, gate, hint and terms documents.
Map<String, Future<String> Function()> docProbes() {
  final out = <String, Future<String> Function()>{};
  for (final e in corruptGrants().entries) {
    final doc = _grantWith(e.value);
    out['grant.fromMap|${e.key}'] =
        () => outcome(() async {
          final g = Grant.fromMap(
            Map<String, dynamic>.from(hydrate(doc)! as Map),
          );
          return '${g.role.key}/${g.liveAt(DateTime(2026))}';
        });
    // The user's own query: a good grant plus this one.
    out['loadMine|${e.key}'] =
        () => outcome(() async {
          final db = await seeded({
            'grants/good': {
              ..._goodGrant(),
              'role': 'course',
              'scope': 'EEE F211',
            },
            'grants/bad': doc,
          });
          final r = await RoleStore(
            db,
            me: 'f20249994@goa.bits-pilani.ac.in',
            myName: 'Good',
          ).loadMine(now: DateTime(2026));
          return 'grants=${r.grants.length}';
        });
    out['roster|${e.key}'] =
        () => outcome(() async {
          final db = await seeded({
            'grants/good': _goodGrant(),
            'grants/bad': doc,
          });
          final r = await RoleStore(
            db,
            me: 'owner@pointer.test',
            myName: 'O',
          ).roster(campus: 'goa');
          return 'n=${r.length}';
        });
  }
  Map<String, Object?> staff(Map<String, Object?> o) => {
    'email': 'f20249994@goa.bits-pilani.ac.in',
    'name': 'S',
    'campus': 'goa',
    'owner': false,
    'admin': false,
    'presidentOf': ['ELEC'],
    'courses': <String>[],
    'expiresAt': {r'$ts': 4102444800000},
    'lastGrant': 'dept|goa|ELEC|x',
    ...o,
  };
  final staffCases = <String, Map<String, Object?>>{
    'baseline': {},
    'reach_list': {
      'reach': [
        {'role': 'president', 'campus': 'goa', 'dept': 'ELEC'},
      ],
    },
    'reach_not_list': {'reach': 'goa'},
    'reach_entry_string': {
      'reach': ['goa'],
    },
    'reach_entry_empty': {
      'reach': [<String, Object?>{}],
    },
    'presidentOf_numbers': {
      'presidentOf': [1, 2],
    },
    'presidentOf_not_list': {'presidentOf': 'ELEC'},
    'courses_null': {'courses': null},
    'expires_string': {'expiresAt': 'soon'},
    'email_missing': {'email': null},
    'admin_string': {'admin': 'true'},
    'unknown_keys': {'zz': 1},
  };
  for (final e in staffCases.entries) {
    out['staff.fromMap|${e.key}'] =
        () => outcome(() async {
          final m = Map<String, dynamic>.from(hydrate(staff(e.value))! as Map)
            ..removeWhere((_, v) => v == null);
          return StaffEntry.fromMap(m).presidentOf.length;
        });
  }
  final heads = <String, Map<String, Object?>>{
    'empty': {},
    'v_strings': {
      'v': {'terms': 'x', 'grants': 3},
    },
    'v_not_map': {'v': 5},
    'offerings_null': {'offerings': null},
    'contact_list': {'contact': []},
    'catalog_string': {'catalog': 'x'},
    'new_marker_roles': {
      'v': {'roles': 4, 'grants': 2},
    },
    'unknown_keys': {'zz': 1},
  };
  for (final e in heads.entries) {
    out['head.fromMap|${e.key}'] =
        () => outcome(() async {
          return Head.fromMap(
                Map<String, dynamic>.from(hydrate(e.value)! as Map),
              ).version('grants') ??
              'none';
        });
  }
  final dirs = <String, Map<String, Object?>>{
    'baseline': {
      'name': 'D',
      'campus': 'goa',
      'roles': [
        {'role': 'dept', 'scope': 'ELEC', 'until': 4102444800000},
      ],
    },
    'roles_not_list': {'name': 'D', 'roles': 'dept'},
    'role_unknown': {
      'roles': [
        {'role': 'wizard', 'scope': 'x', 'until': 1},
      ],
    },
    'role_custom': {
      'roles': [
        {'role': 'custom', 'scope': 'role', 'until': 4102444800000},
      ],
    },
    'until_string': {
      'roles': [
        {'role': 'dept', 'scope': 'ELEC', 'until': 'x'},
      ],
    },
    'scope_missing': {
      'roles': [
        {'role': 'dept', 'until': 1},
      ],
    },
    'email_number': {'email': 5},
  };
  for (final e in dirs.entries) {
    out['directory.fromMap|${e.key}'] =
        () => outcome(() async {
          return DirectoryEntry.fromMap(
            'x@goa.bits-pilani.ac.in',
            Map<String, dynamic>.from(hydrate(e.value)! as Map),
          ).roles.length;
        });
  }
  final gates = <String, Object?>{
    'on_true': true,
    'on_string': 'true',
    'on_number': 1,
    'on_missing': null,
  };
  for (final e in gates.entries) {
    out['gate.of|${e.key}'] =
        () => outcome(() async {
          final db = await seeded({
            'reviewGate/goa': {
              if (e.value != null) 'on': e.value,
              'dept': 'ELEC',
            },
          });
          final rs = RoleStore(
            db,
            me: 'f20249994@goa.bits-pilani.ac.in',
            myName: 'S',
          );
          return GateStore(rs).of('goa');
        });
  }
  final hints = <String, Object?>{
    'ok': {
      'oel': {'open elective': 7},
    },
    'negative': {
      'oel': {'open elective': -3},
    },
    'double': {
      'oel': {'open elective': 2.0},
    },
    'string_count': {
      'oel': {'open elective': 'x'},
    },
    'inner_not_map': {'oel': 5},
    'q_not_map': 3,
    'q_missing': null,
  };
  for (final e in hints.entries) {
    out['hints.load|${e.key}'] =
        () => outcome(() async {
          final db = await seeded({
            'searchHints/goa': {if (e.value != null) 'q': e.value},
          });
          final m = await SearchHints(db).load('goa');
          return alsoSearch('oel', m).join(',');
        });
  }
  final terms = <String, Map<String, Object?>>{
    'ok': {'crDays': 183, 'presidentDays': 365, 'adminDays': 730},
    'double': {'crDays': 183.0, 'presidentDays': 365, 'adminDays': 730},
    'missing_admin': {'crDays': 183, 'presidentDays': 365},
    'string': {'crDays': '183', 'presidentDays': 365, 'adminDays': 730},
  };
  for (final e in terms.entries) {
    out['terms|${e.key}'] =
        () => outcome(() async {
          final db = await seeded({'config/grantTerms': e.value});
          final t =
              await RoleStore(
                db,
                me: 'owner@pointer.test',
                myName: 'O',
              ).terms();
          return '${t.crDays}/${t.presidentDays}/${t.adminDays}';
        });
  }
  return out;
}

/// Damaged device storage: what `restoreMyRoles`, `workingAs` and
/// `viewCampus` do with it.
Future<Map<String, String>> deviceProbes() async {
  final dir = await Directory.systemTemp.createTemp('bt_device');
  Hive.init(dir.path);
  await openDeviceBox();
  final box = Hive.box(deviceBoxName);
  const me = 'f20249994@goa.bits-pilani.ac.in';
  String grantJson({String role = 'dept', Object? exp = 4102444800000}) =>
      jsonEncode({
        'role': role,
        'email': me,
        'name': 'S',
        'campus': 'goa',
        'scope': 'ELEC',
        'programme': 'A3',
        'active': true,
        'expiresAt': exp,
      });
  String roles(String grants, {Object? owner = false, Object? email = me}) =>
      '{"email":${jsonEncode(email)},"owner":${jsonEncode(owner)},"grants":$grants}';
  final good = '[${grantJson()}]';
  final cases = <String, Map<String, Object?>>{
    'roles_ok': {'roles': roles(good)},
    'roles_missing': {},
    'roles_int': {'roles': 5},
    'roles_truncated': {'roles': roles(good).substring(0, 60)},
    'roles_empty_string': {'roles': ''},
    'roles_json_list': {'roles': '[1,2]'},
    'roles_grants_missing': {'roles': '{"email":"$me","owner":false}'},
    'roles_grants_not_list': {'roles': roles('"x"')},
    'roles_grant_not_map': {'roles': roles('[5]')},
    'roles_grant_missing_fields': {'roles': roles('[{"role":"dept"}]')},
    'roles_grant_unknown_role': {
      'roles': roles('[${grantJson(role: 'wizard')}]'),
    },
    'roles_grant_exp_string': {'roles': roles('[${grantJson(exp: '"x"')}]')},
    'roles_grant_expired': {'roles': roles('[${grantJson(exp: 1000)}]')},
    'roles_owner_string': {'roles': roles(good, owner: 'yes')},
    'roles_other_email': {
      'roles': roles(good, email: 'x@goa.bits-pilani.ac.in'),
    },
    'roles_extra_keys': {
      'roles': '{"email":"$me","owner":false,"grants":$good,"zz":{"a":1}}',
    },
    'workingAs_matches': {
      'roles': roles(good),
      'workingAs': 'dept|goa|ELEC|$me',
    },
    'workingAs_unknown': {'roles': roles(good), 'workingAs': 'dept|goa|CS|$me'},
    'workingAs_int': {'roles': roles(good), 'workingAs': 7},
    'workingAs_custom_id': {'roles': roles(good), 'workingAs': 'custom|$me'},
    'previewCampus_valid': {'previewCampus': 'pilani'},
    'previewCampus_invalid': {'previewCampus': 'mars'},
    'previewCampus_int': {'previewCampus': 5},
    'previewCampus_valid_with_president': {
      'roles': roles(good),
      'previewCampus': 'pilani',
    },
    'previewCampus_valid_with_owner': {
      'roles': roles('[]', owner: true),
      'previewCampus': 'pilani',
    },
  };
  final out = <String, String>{};
  for (final e in cases.entries) {
    await box.clear();
    for (final kv in e.value.entries) {
      await box.put(kv.key, kv.value);
    }
    myRoles.value = MyRoles.none;
    workingAs.value = null;
    viewAs.value = null;
    roleStore = RoleStore(FakeFirebaseFirestore(), me: me, myName: 'S');
    out['device|${e.key}'] = await outcome(() async {
      restoreMyRoles(email: me);
      final r = myRoles.value;
      return 'roles=${r.email.isEmpty ? '-' : 'me'}'
          '|owner=${r.owner}|grants=${r.grants.length}'
          '|working=${workingAs.value?.id}'
          '|campus=${viewCampus()}';
    });
  }
  roleStore = null;
  await Hive.close();
  await dir.delete(recursive: true);
  return out;
}
