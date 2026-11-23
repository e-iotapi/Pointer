/// Who the signed-in person is acting as, this session and on this device
/// (ARCHITECTURE.md §16.3 fixes 1 and 15). Nothing here grants anything: the
/// rules check every write against the person's own grants.
library;

import 'dart:async';
import 'dart:convert';

import 'package:cgpa_calculator/core/analytics/analytics_store.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/storage/cache_boxes.dart';
import 'package:cgpa_calculator/core/timings.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:flutter/foundation.dart';
import 'package:hive_ce/hive.dart';

/// Set at startup once signed in; null in tests and signed out.
RoleStore? roleStore;

/// Opens the store for any signed-in email, BITS or not (§10.0): an owner
/// grant can name a non-BITS address. `recordSignIn` (people/{me}, so the
/// person can be appointed) still only fires for a BITS campus address.
@visibleForTesting
RoleStore startRoles(
  FirebaseFirestore db, {
  required String email,
  required String name,
}) {
  final store =
      roleStore = RoleStore(db, me: email, myName: name, actingAs: actingNow);
  if (campusOfAddress(email) case final campus?) {
    // Budget: ≤ 1 write a week per device; the first time also 1 read.
    final at = _device?.get('signInAt');
    final seen = _device?.get('signInAs') == email;
    final now = DateTime.now().millisecondsSinceEpoch;
    if (!seen || at is! int || now - at > signInRecordEvery.inMilliseconds) {
      unawaited(
        store
            .recordSignIn(name: name, campus: campus, known: seen)
            .then((_) => _device?.putAll({'signInAt': now, 'signInAs': email}))
            .catchError((_) {}),
      );
    }
    // Site analytics: 1 in 20 people a day, ≤ 1 write an hour (§D).
    unawaited(
      AnalyticsStore(db)
          .recordOpen(uid: email, campus: campus, device: _device)
          .catchError((_) {}),
    );
  }
  return store;
}

/// What the signed-in person holds. Restored from the device at start and
/// refreshed in the background.
final myRoles = ValueNotifier<MyRoles>(MyRoles.none);

/// An owner's lens (Open as): which role the app renders as. In memory for
/// the session only.
@immutable
class ViewAs {
  /// Opens as [role]. [at] is the place of a built-in president (campus,
  /// department) or CR (campus, course); a custom role opens at its own
  /// scope and ignores it.
  const ViewAs(this.role, {this.at});

  /// The Student lens: a signed-in person who holds nothing.
  static const student = ViewAs(
    RoleDef(
      id: 'student',
      name: 'Student',
      tag: 'STUDENT',
      caps: <Capability>{},
      termDays: 0,
      builtin: true,
    ),
  );

  /// The role to render as.
  final RoleDef role;

  /// Where a built-in president or CR is opened.
  final Reach? at;

  /// The lens as shown in the banner.
  String get label {
    final place = campusName(at?.campus ?? '');
    return switch (role.id) {
      'owner' => 'Owner',
      'admin' => 'Admin',
      'student' => 'Student',
      'president' => 'President · ${at?.dept} $place',
      'cr' => 'CR · ${at?.course} $place',
      _ => '${role.name} · ${customScopeLabel(role)}',
    };
  }

  /// What the holder of this lens holds, so `may` and `reach` answer as they
  /// would. A stand-in student address on the lens's campus; nothing is
  /// stored or sent.
  MyRoles get roles {
    final own = role.campus == null || role.campus == 'all' ? 'goa' : role.campus!;
    final campus = at?.campus ?? own;
    final email = 'f20000000@$campus.bits-pilani.ac.in';
    Grant grant(GrantRole r, String campus, String scope) => Grant(
      role: r,
      email: email,
      name: '',
      campus: campus,
      scope: scope,
      active: true,
      expiresAt: DateTime(2100),
      roleId: r == GrantRole.custom ? role.id : null,
    );
    final a = at;
    return MyRoles(
      email: email,
      owner: role.id == 'owner',
      defs: RoleDefs({...RoleDefs.defaults().byId, role.id: role}),
      grants: switch (role.id) {
        'admin' => [grant(GrantRole.admin, 'all', 'all')],
        'president' when a != null => [
          grant(GrantRole.dept, a.campus, a.dept ?? ''),
        ],
        'cr' when a != null => [
          grant(GrantRole.course, a.campus, a.course ?? ''),
        ],
        _ => const [],
      },
      custom: role.builtin ? null : grant(GrantRole.custom, campus, 'role'),
    );
  }
}

/// The active [ViewAs] lens, or `null` when the app renders as the person.
final viewAs = ValueNotifier<ViewAs?>(null);

/// The signed-in uid: the salt of every pseudonymous id (reviews, votes,
/// reports), never stored beside them. Set at startup.
String? myUid;

/// RepProfile must come first (§16.3 fix 8): the router sends every
/// location to `welcome` while this is true.
final profileDue = ValueNotifier<bool>(false);

/// "Email, WhatsApp" — what the person's contact details show students; for
/// Settings › Contact details.
final myContactSummary = ValueNotifier<String?>(null);

Box? get _device =>
    Hive.isBoxOpen(deviceBoxName) ? Hive.box(deviceBoxName) : null;

/// Opens the device-local Hive box that [setWorkingAs] writes to.
Future<void> openDeviceBox() => Hive.openBox(deviceBoxName);

/// The grant id Pointer opens as (Switch role), or null for Student. A grant
/// that has lapsed reads as Student.
final workingAs = ValueNotifier<Grant?>(null);

/// Sets [workingAs] to [g] and remembers it on this device.
Future<void> setWorkingAs(Grant? g) async {
  workingAs.value = g;
  await _device?.put('workingAs', g?.id);
}

/// The audit entry's role for a write made now.
({String role, String? viewingAs}) actingNow() {
  final r = myRoles.value;
  final w = workingAs.value;
  final role =
      r.owner
          ? 'owner'
          : w != null
          ? (w.role == GrantRole.dept ? 'president' : w.role.key)
          : r.top.name;
  return (role: role, viewingAs: viewAs.value?.label);
}

void _use(MyRoles r) {
  myRoles.value = r;
  final id = _device?.get('workingAs');
  workingAs.value = r.grants.where((g) => g.id == id).firstOrNull;
  if (!r.owner) viewAs.value = null;
}

/// The last known roles, for an instant start (and offline). Roles cached
/// for another address are ignored (a shared device, a switched account).
void restoreMyRoles({String? email}) {
  final raw = _device?.get('roles');
  if (raw is! String) return;
  try {
    final m = jsonDecode(raw) as Map<String, dynamic>;
    if (email != null && m['email'] != email.toLowerCase()) return;
    _use(
      MyRoles(
        email: m['email'] as String,
        owner: m['owner'] as bool,
        grants: [
          for (final g in m['grants'] as List)
            if (Grant.tryFromMap(Map<String, dynamic>.from(g as Map))
                case final x? when x.liveAt(DateTime.now()))
              x,
        ],
        defs:
            m['defs'] == null ? null : RoleStore.decodeDefs(m['defs']),
        custom:
            m['custom'] == null
                ? null
                : Grant.fromMap(
                  Map<String, dynamic>.from(m['custom'] as Map),
                ),
      ),
    );
  } on Object catch (e) {
    debugPrint('[Pointer roles] cached roles unreadable: $e');
  }
}

/// [refreshMyRoles] at most once a week per device and person: a new
/// appointment shows then, or at once after signing out and in (which
/// clears the device cache). The rules check every write anyway.
/// Budget: 2 reads a week per device.
Future<void> refreshMyRolesIfDue() async {
  final at = _device?.get('rolesAt');
  final raw = _device?.get('roles');
  final email = roleStore?.me;
  final mine =
      raw is String && email != null && raw.contains('"email":"$email"');
  if (mine &&
      at is int &&
      DateTime.now().millisecondsSinceEpoch - at <
          rolesRefreshEvery.inMilliseconds) {
    return;
  }
  await refreshMyRoles();
}

/// The roles counter the live server last announced for this person, kept
/// on this device (LiveHeads compares it at every hello).
int? liveRolesSeen() {
  final v = _device?.get('rolesSeen|${roleStore?.me}');
  return v is int ? v : null;
}

void setLiveRolesSeen(int n) =>
    unawaited(_device?.put('rolesSeen|${roleStore?.me}', n));

/// Reads the person's roles again. Offline, keeps what it had.
Future<void> refreshMyRoles() async {
  final store = roleStore;
  if (store == null) return;
  try {
    final r = await store.loadMine();
    _use(r);
    await _device?.put('rolesAt', DateTime.now().millisecondsSinceEpoch);
    await _device?.put(
      'roles',
      jsonEncode({
        'email': r.email,
        'owner': r.owner,
        if (r.defs != null) 'defs': RoleStore.encodeDefs(r.defs!),
        if (r.custom != null) 'custom': r.custom!.toMap(),
        'grants': [
          for (final g in r.grants)
            {
              'role': g.role.key,
              'email': g.email,
              'name': g.name,
              'campus': g.campus,
              'scope': g.scope,
              'programme': g.programme,
              'active': g.active,
              'expiresAt': g.expiresAt.millisecondsSinceEpoch,
              if (g.secretary) 'secretary': true,
            },
        ],
      }),
    );
  } on Object catch (e) {
    debugPrint('[Pointer roles] refresh failed: $e');
  }
}
