/// Grants, the staff index and the addresses rules check (ARCHITECTURE.md
/// §4). The same functions as firestore.rules, so the screens and the rules
/// agree on who is a student and which department a course is in.
library;

import 'package:cgpa_calculator/core/models/programmes.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/claim_store.dart' show CourseClaim;
import 'package:cgpa_calculator/core/roles/role_defs.dart';

final _student = RegExp(
  r'^[fhp][0-9]{4}[0-9]+@(goa|hyderabad|pilani|dubai)\.bits-pilani\.ac\.in$',
);
final _bits = RegExp(
  r'^[^@]+@(goa|pilani|dubai|hyderabad)\.bits-pilani\.ac\.in$',
);

/// [typed] with the campus domain filled in: `f20230800@goa` becomes
/// `f20230800@goa.bits-pilani.ac.in`. Anything else comes back trimmed and
/// lower-cased.
String fullBitsAddress(String typed) {
  final t = typed.trim().toLowerCase();
  return RegExp(r'^[^@\s]+@(goa|pilani|dubai|hyderabad)$').hasMatch(t)
      ? '$t.bits-pilani.ac.in'
      : t;
}

/// A BITS student address; faculty and alumni addresses are not.
bool isStudentAddress(String email) => _student.hasMatch(email.toLowerCase());

/// Whether [email] is any BITS campus address, student or not.
bool isBitsAddress(String email) => _bits.hasMatch(email.toLowerCase());

/// "goa" from a campus address; null otherwise.
String? campusOfAddress(String email) =>
    _bits.firstMatch(email.toLowerCase())?.group(1);

/// The batch year from a student address: 2023 from f20230802@…
int? batchOfAddress(String email) =>
    isStudentAddress(email)
        ? int.parse(email.toLowerCase().substring(1, 5))
        : null;

/// A president's scope is a department key, derived from the course code:
/// electronics is one department, FIN sits under ECON. A prefix no department
/// owns belongs to [genDept], the electives department (B2); mirrors the
/// rules' `deptOf`.
String deptOf(String courseId) {
  final p = courseId.trim().split(' ').first.toUpperCase();
  if (const {'EEE', 'ECE', 'INSTR', 'ECOM'}.contains(p)) return 'ELEC';
  if (p == 'FIN') return 'ECON';
  return departments.containsKey(p) ? p : genDept;
}

/// The management-only electives department (shown as "Electives"). Never a
/// programme, a branch or a choice in setup.
const genDept = 'GEN';

/// Who manages [courseId]: its department, or the department that claimed a
/// GEN course (B2). [claims] maps course id to its claim; a
/// claim on a non-GEN course is ignored.
String managingDept(String courseId, Map<String, CourseClaim> claims) {
  final d = deptOf(courseId);
  return d == genDept ? claims[courseId]?.dept ?? d : d;
}

/// Display names by campus key, plus `all` for grants that span campuses.
const campusNames = {
  'goa': 'Goa',
  'hyderabad': 'Hyderabad',
  'pilani': 'Pilani',
  'dubai': 'Dubai',
  'all': 'Every campus',
};

/// The display name for campus [key], or [key] itself when unknown.
String campusName(String key) => campusNames[key] ?? key;

/// The kind of grant a maintainer holds.
enum GrantRole {
  admin('admin', 'Admin', 'ADMIN'),
  dept('dept', 'Department president', 'PRESIDENT'),
  course('course', 'Course manager', 'CR'),

  /// B7: campus-wide, no expiry (the sentinel 2100-01-01), until revoked.
  contributor('contributor', 'Contributor', 'CONTRIBUTOR'),

  /// An owner-made role: `grants/custom|{email}`, scope `role`, with a
  /// [Grant.roleId].
  custom('custom', 'Custom role', 'ROLE');

  const GrantRole(this.key, this.label, this.tag);

  /// The stored key, the display label and the short badge tag.
  final String key, label, tag;

  /// Looks up the role stored under [key]; throws if there is none.
  static GrantRole of(String key) => values.firstWhere((r) => r.key == key);

  /// The capability-table [Role] this grant role maps to.
  Role get role => switch (this) {
    admin => Role.admin,
    dept => Role.president,
    course => Role.cr,
    contributor || custom => Role.student,
  };
}

/// `grants/{role}|{campus}|{scope}|{email}`.
class Grant {
  const Grant({
    required this.role,
    required this.email,
    required this.name,
    required this.campus,
    required this.scope,
    required this.active,
    required this.expiresAt,
    this.programme,
    this.grantedByEmail = '',
    this.grantedByName = '',
    this.grantedAt,
    this.handedTo,
    this.expiresBefore,
    this.secretary = false,
    this.dept,
    this.roleId,
  });

  /// Custom grants only: the id of the `roles/{id}` document.
  final String? roleId;

  /// Contributor grants only: the department whose president approved it.
  final String? dept;

  /// The kind of grant.
  final GrantRole role;

  /// Dept grants only: a secretary holds every president right but handing
  /// over and appointing secretaries.
  final bool secretary;

  /// The holder's address and name, the campus key, and the scope (a
  /// department key or a course id).
  final String email, name, campus, scope;

  /// Dept grants only: the programme appointed for ("A3").
  final String? programme;

  /// Whether the grant has not been revoked.
  final bool active;

  /// When the grant lapses.
  final DateTime expiresAt;

  /// Who issued the grant.
  final String grantedByEmail, grantedByName;

  /// When the grant was issued, if recorded.
  final DateTime? grantedAt;

  /// A president's handover in progress (§13.4): the successor's address,
  /// and the expiry this grant had before, which a cancel restores.
  final String? handedTo;

  /// The expiry to restore if the handover is cancelled.
  final DateTime? expiresBefore;

  /// The document id, see [grantId].
  String get id => grantId(role, campus, scope, email);

  /// Copies this grant with a new [active] flag or [expiresAt].
  Grant copyWith({bool? active, DateTime? expiresAt}) => Grant(
    role: role,
    email: email,
    name: name,
    campus: campus,
    scope: scope,
    programme: programme,
    active: active ?? this.active,
    expiresAt: expiresAt ?? this.expiresAt,
    secretary: secretary,
    dept: dept,
    roleId: roleId,
  );

  /// Whether the grant is active and unexpired at [now].
  bool liveAt(DateTime now) => active && now.isBefore(expiresAt);

  /// "A3", "CS F301", "Every campus": a president goes by their branch
  /// code, a CR by their course code.
  String get scopeLabel => switch (role) {
    GrantRole.admin => 'Every campus',
    GrantRole.dept => branchCode(scope, programme),
    GrantRole.course => scope,
    GrantRole.contributor => 'Every department',
    GrantRole.custom => 'Custom role',
  };

  /// [scopeLabel], with a custom grant's scope read from its role in [defs]:
  /// "ELEC · Goa", "Every department · Goa", "Every campus".
  String scopeLabelIn(RoleDefs defs) {
    final d = role == GrantRole.custom ? defs[roleId ?? ''] : null;
    return d == null ? scopeLabel : customScopeLabel(d);
  }

  /// Reads a grant document's data.
  static Grant fromMap(Map<String, dynamic> m) => Grant(
    role: GrantRole.of(m['role'] as String),
    email: m['email'] as String,
    name: m['name'] as String? ?? '',
    campus: m['campus'] as String,
    scope: m['scope'] as String,
    programme: m['programme'] as String?,
    active: m['active'] as bool? ?? false,
    expiresAt: asDate(m['expiresAt']) ?? DateTime(1970),
    grantedByEmail: (m['grantedBy'] as Map?)?['email'] as String? ?? '',
    grantedByName: (m['grantedBy'] as Map?)?['name'] as String? ?? '',
    grantedAt: asDate(m['grantedAt']),
    handedTo: m['handedTo'] as String?,
    expiresBefore: asDate(m['expiresBefore']),
    secretary: m['secretary'] as bool? ?? false,
    dept: m['dept'] as String?,
    roleId: m['roleId'] as String?,
  );

  /// JSON-safe, for `cacheFirst`: [fromMap] reads it back (dates as millis).
  Map<String, dynamic> toMap() => {
    'role': role.key,
    'email': email,
    'name': name,
    'campus': campus,
    'scope': scope,
    'programme': programme,
    'active': active,
    'expiresAt': expiresAt.millisecondsSinceEpoch,
    'grantedBy': {'email': grantedByEmail, 'name': grantedByName},
    'grantedAt': grantedAt?.millisecondsSinceEpoch,
    'handedTo': handedTo,
    'expiresBefore': expiresBefore?.millisecondsSinceEpoch,
    'secretary': secretary,
    'dept': dept,
    'roleId': roleId,
  };
}

/// A custom role's scope in short: "ELEC · Goa", "Every department · Goa",
/// "Every campus".
String customScopeLabel(RoleDef d) {
  final campus = d.campus ?? 'all';
  final dept = d.dept == null || d.dept == 'all' ? null : d.dept;
  if (dept == null && campus == 'all') return 'Every campus';
  return '${dept ?? 'Every department'} · ${campusName(campus)}';
}

/// The grant document id: `role|campus|scope|email`.
String grantId(GrantRole role, String campus, String scope, String email) =>
    role == GrantRole.custom
        ? 'custom|$email'
        : '${role.key}|$campus|$scope|$email';

/// A Firestore Timestamp, a DateTime or epoch milliseconds.
DateTime? asDate(Object? v) => switch (v) {
  DateTime d => d,
  int ms => DateTime.fromMillisecondsSinceEpoch(ms),
  null => null,
  _ => (v as dynamic).toDate() as DateTime,
};

/// `staff/{email}`: one index document per maintainer, kept in step with
/// every grant change.
class StaffEntry {
  const StaffEntry({
    required this.email,
    this.name = '',
    this.campus = '',
    this.owner = false,
    this.admin = false,
    this.presidentOf = const [],
    this.courses = const [],
    this.reach = const [],
    this.expiresAt,
  });

  /// The maintainer's address, name and home campus key.
  final String email, name, campus;

  /// Whether the person is the owner, or holds a live admin grant.
  final bool owner, admin;

  /// Department keys presided over, and course ids managed.
  final List<String> presidentOf, courses;

  /// Every place the person holds a role (admin, president, CR, custom);
  /// empty on documents an older build wrote.
  final List<Reach> reach;

  /// The latest expiry across live grants.
  final DateTime? expiresAt;

  /// Reads a staff document's data.
  static StaffEntry fromMap(Map<String, dynamic> m) => StaffEntry(
    email: m['email'] as String,
    name: m['name'] as String? ?? '',
    campus: m['campus'] as String? ?? '',
    owner: m['owner'] as bool? ?? false,
    admin: m['admin'] as bool? ?? false,
    presidentOf: [for (final d in m['presidentOf'] as List? ?? const []) '$d'],
    courses: [for (final c in m['courses'] as List? ?? const []) '$c'],
    reach: [
      for (final r in m['reach'] as List? ?? const []) Reach.fromMap(r as Map),
    ],
    expiresAt: asDate(m['expiresAt']),
  );

  /// This entry once [g] is written: its field moved by exactly its scope,
  /// and its reach entry added or removed. A custom grant's entry takes the
  /// role's scope: [roleCampus] (its campus, `all` for an every-campus role)
  /// and the grant's `dept`.
  Map<String, dynamic> after(Grant g, {String? roleCampus}) {
    final mine = switch (g.role) {
      GrantRole.admin => Reach(role: 'admin', campus: 'all'),
      GrantRole.dept => Reach(
        role: 'president',
        campus: g.campus,
        dept: g.scope,
      ),
      GrantRole.course => Reach(role: 'cr', campus: g.campus, course: g.scope),
      GrantRole.custom => Reach(
        role: 'custom',
        campus: roleCampus ?? g.campus,
        dept: g.dept ?? 'all',
      ),
      GrantRole.contributor => null,
    };
    // A custom holder has one grant, so its entry is replaced whole.
    bool same(Reach r) =>
        mine != null &&
        (g.role == GrantRole.custom
            ? r.role == 'custom'
            : r.role == mine.role &&
                r.campus == mine.campus &&
                r.dept == mine.dept &&
                r.course == mine.course);
    final nextReach = [
      for (final r in reach)
        if (!same(r)) r,
      if (mine != null && g.active) mine,
    ];
    List<String> move(List<String> l) =>
        g.active
            ? {...l, g.scope}.toList()
            : [
              for (final x in l)
                if (x != g.scope) x,
            ];
    final latest = [
      if (expiresAt != null) expiresAt!,
      if (g.active) g.expiresAt,
    ]..sort();
    return {
      'email': email,
      'name': name.isEmpty ? g.name : name,
      'campus': campus.isEmpty ? g.campus : campus,
      'owner': owner,
      'admin': g.role == GrantRole.admin ? g.active : admin,
      'presidentOf': g.role == GrantRole.dept ? move(presidentOf) : presidentOf,
      'courses': g.role == GrantRole.course ? move(courses) : courses,
      'reach': [for (final r in nextReach) r.toMap()],
      'expiresAt': latest.isEmpty ? g.expiresAt : latest.last,
      'lastGrant': g.id,
    };
  }
}

/// The Firestore-free mirror of `CUSTOM_EXCLUDED` in
/// test/rules/capability_probes.mjs: rows no custom role may hold. Empty until
/// the orchestrator copies the probes' list at merge.
const customExcluded = <Capability>{};

/// One place a person may do a row: a role's reach, as stored in the staff
/// index (`{role, campus, dept, course}`).
class Reach {
  const Reach({
    required this.role,
    required this.campus,
    this.dept,
    this.course,
  });

  /// `admin`, `president`, `cr` or `custom`.
  final String role;

  /// A campus key, or `all`.
  final String campus;

  /// A department key (a president's, a custom role's); null or `all` for the
  /// whole campus.
  final String? dept;

  /// A course id (a CR's), else null.
  final String? course;

  /// The index entry; null dept and course are left out.
  Map<String, Object?> toMap() => {
    'role': role,
    'campus': campus,
    if (dept != null) 'dept': dept,
    if (course != null) 'course': course,
  };

  /// Reads an index entry.
  static Reach fromMap(Map m) => Reach(
    role: m['role'] as String? ?? '',
    campus: m['campus'] as String? ?? '',
    dept: m['dept'] as String?,
    course: m['course'] as String?,
  );

  /// Whether the target lies inside this reach. A null (or `all`) part of
  /// the target is the whole of that dimension, covered only by a reach
  /// that is not narrowed on it.
  bool covers(String? campus, String? dept, String? course) {
    if (this.campus != 'all' && campus != this.campus) return false;
    final d = this.dept;
    if (d != null && d != 'all' && dept != d) return false;
    final k = this.course;
    return k == null || course == k;
  }
}

/// What the signed-in person holds: owner status and every live grant.
class MyRoles {
  const MyRoles({
    required this.email,
    this.owner = false,
    this.grants = const [],
    this.contributor = false,
    this.defs,
    this.custom,
  });

  /// Nobody signed in, or a plain student.
  static const none = MyRoles(email: '');

  /// The signed-in address.
  final String email;

  /// Whether the person is the owner.
  final bool owner;

  /// Live grants only (contributor and custom grants are not among them, see
  /// [contributor] and [custom]).
  final List<Grant> grants;

  /// Whether a live contributor grant is held (B7).
  final bool contributor;

  /// The role definitions the answers read; null reads the §4 defaults.
  final RoleDefs? defs;

  /// The `custom|{email}` grant, if held.
  final Grant? custom;

  RoleDefs get _defs => defs ?? RoleDefs.defaults();

  /// Whether a live admin grant is held.
  bool get admin => grants.any((g) => g.role == GrantRole.admin);

  /// Whether the person is the owner or holds any live grant.
  bool get privileged => owner || grants.isNotEmpty;

  /// Owner, admin or president: publishes links at once and is never offered
  /// to contribute. A CR alone is not staff.
  bool get staff => owner || grants.any((g) => g.role != GrantRole.course);

  /// Whether the person may open the admin screens.
  bool get reachesAdmin => owner || admin || custom != null;

  /// The live department grants.
  Iterable<Grant> get presidencies =>
      grants.where((g) => g.role == GrantRole.dept);

  /// The live course grants.
  Iterable<Grant> get courses =>
      grants.where((g) => g.role == GrantRole.course);

  /// The strongest role, for the capability table.
  Role get top =>
      owner
          ? Role.owner
          : admin
          ? Role.admin
          : presidencies.isNotEmpty
          ? Role.president
          : courses.isNotEmpty
          ? Role.cr
          : Role.student;

  bool _ticked(String role, Capability c) =>
      _defs[role]?.caps.contains(c) ?? false;

  /// The custom grant's role, when the grant is live and the row is open to
  /// custom roles; null otherwise (a deleted role gives nothing).
  RoleDef? _customRole(Capability c) {
    final g = custom;
    if (g == null || !g.liveAt(DateTime.now()) || !isStudentAddress(email)) {
      return null;
    }
    final r = _defs[g.roleId ?? ''];
    return r != null && r.caps.contains(c) && !customExcluded.contains(c)
        ? r
        : null;
  }

  // CAMPUS DATA (Decision 11): every non-owner acts on the campus of their own
  // address only. Admin's other rows (appointments, public contact, roles,
  // the audit log) keep every campus. Mirrors the rules' campusData().
  static const _ownCampus = {
    Capability.mergeProfessors,
    Capability.courseStructures,
    Capability.bulkUpload,
    Capability.degreeRequirements,
    Capability.departmentResources,
    Capability.courseResources,
    Capability.averages,
    Capability.professors,
    Capability.moderateReviews,
    Capability.approveContributors,
    Capability.claimElectives,
    Capability.reviewGateSwitch,
    Capability.publishTimetable,
    Capability.publishDirectly,
    Capability.contribute,
  };

  /// Whether this person may do [action] on [campus]/[scope] ([scope] is a
  /// department key or a course id), through any role they hold. The same
  /// answer as the rules' `may()`: a null [campus] or [scope] asks "anywhere".
  /// Presidents and CRs hold department rows in their scope and campus rows
  /// on their grant's campus; everywhere rows are admin's, owner's and custom
  /// roles'.
  bool may(Capability action, {String? campus, String? scope}) {
    if (owner) return true;
    final deptRow = action.reach == CapReach.dept;
    final campusRow = action.reach == CapReach.campus;
    if (admin &&
        _ticked('admin', action) &&
        (!_ownCampus.contains(action) ||
            campus == null ||
            campus == campusOfAddress(email))) {
      return true;
    }
    if ((deptRow || campusRow) && _ticked('president', action)) {
      for (final g in presidencies) {
        if ((campus == null || campus == g.campus) &&
            (campusRow ||
                scope == null ||
                scope == g.scope ||
                deptOf(scope) == g.scope)) {
          return true;
        }
      }
    }
    if ((deptRow || campusRow) && _ticked('cr', action)) {
      for (final g in courses) {
        if ((campus == null || campus == g.campus) &&
            (campusRow || scope == null || scope == g.scope)) {
          return true;
        }
      }
    }
    final r = _customRole(action);
    if (r == null) return false;
    if (action.reach == CapReach.everywhere && !_ownCampus.contains(action)) {
      return true;
    }
    // Never across campuses. "Every campus" is the holder's own campus,
    // every department.
    final own = campusOfAddress(email);
    if (campus != null && campus != own) return false;
    if (r.campus == 'all') return true;
    final d =
        action.reach == CapReach.campus || scope == null
            ? 'all'
            : (scope.contains(' ') ? deptOf(scope) : scope);
    return r.campus == (campus ?? own) &&
        (r.dept == 'all' || r.dept == d || d == 'all');
  }

  static String? _deptOfCourse(String? c) => c == null ? null : deptOf(c);

  /// The role definitions the answers read.
  RoleDefs get roleDefs => _defs;

  /// Whether this person may appoint or revoke [target] (M1, one rule for
  /// every role). Owners may. Otherwise one role of theirs must hold the
  /// target's appoint row (`appointAdmins`, `appointPresidents`,
  /// `appointCrs`; `manageRoles` for a custom role), tick every row the
  /// target ticks, and cover the target's scope. [at] is a built-in target's
  /// place (campus, department or course; null asks "anywhere"); a custom
  /// role uses its own scope. A custom role is never one's own: pass the
  /// appointee's [email].
  bool mayAppoint(RoleDef target, {Reach? at, String? email}) {
    if (owner) return true;
    if (target.id == 'owner') return false;
    if (!target.builtin &&
        email != null &&
        email.trim().toLowerCase() == this.email.toLowerCase()) {
      return false;
    }
    final row = switch (target.id) {
      'admin' => Capability.appointAdmins,
      'president' => Capability.appointPresidents,
      'cr' => Capability.appointCrs,
      _ => Capability.manageRoles,
    };
    final place =
        target.builtin
            ? at == null
                ? null
                : (at.campus, at.dept ?? _deptOfCourse(at.course), at.course)
            : (target.campus ?? 'all', target.dept ?? 'all', null);
    bool through(RoleDef? mine, Reach reach, {bool ownOnly = false}) =>
        mine != null &&
        mine.caps.contains(row) &&
        target.caps.every(mine.caps.contains) &&
        (place == null ||
            (ownOnly
                ? place.$1 == campusOfAddress(this.email) ||
                    (!target.builtin && place.$1 == 'all')
                : reach.covers(place.$1, place.$2, place.$3)));
    if (admin &&
        through(_defs['admin'], const Reach(role: 'admin', campus: 'all'))) {
      return true;
    }
    for (final g in presidencies) {
      if (through(
        _defs['president'],
        Reach(role: 'president', campus: g.campus, dept: g.scope),
      )) {
        return true;
      }
    }
    for (final g in courses) {
      if (through(
        _defs['cr'],
        Reach(role: 'cr', campus: g.campus, course: g.scope),
      )) {
        return true;
      }
    }
    final g = custom;
    final mine =
        g == null || !g.liveAt(DateTime.now()) || !isStudentAddress(this.email)
            ? null
            : _defs[g.roleId ?? ''];
    return through(
      mine,
      Reach(role: 'custom', campus: mine?.campus ?? 'all', dept: mine?.dept),
      // "Every campus" is the holder's own campus (Decision 11).
      ownOnly: mine?.campus == 'all',
    );
  }

  /// Every place this person may do [action].
  List<Reach> reach(Capability action) {
    final own = campusOfAddress(email);
    if (owner ||
        (admin && _ticked('admin', action) && !_ownCampus.contains(action))) {
      return const [Reach(role: 'admin', campus: 'all')];
    }
    return [
      if (admin && _ticked('admin', action) && own != null) // own-campus rows
        Reach(role: 'admin', campus: own),
      if (action.reach != CapReach.everywhere && _ticked('president', action))
        for (final g in presidencies)
          Reach(
            role: 'president',
            campus: g.campus,
            dept: action.reach == CapReach.dept ? g.scope : null,
          ),
      if (action.reach != CapReach.everywhere && _ticked('cr', action))
        for (final g in courses)
          Reach(
            role: 'cr',
            campus: g.campus,
            course: action.reach == CapReach.dept ? g.scope : null,
          ),
      if (_customRole(action) case final r?)
        if (action.reach == CapReach.everywhere && !_ownCampus.contains(action))
          const Reach(role: 'custom', campus: 'all')
        else if (own != null)
          Reach(
            role: 'custom',
            campus: own,
            dept: r.campus == 'all' ? null : r.dept,
          ),
    ];
  }
}

/// Department keys, their names and the programmes a president is appointed
/// for (§4). The key is the course prefix, save ELEC and ECON.
const departments = <String, ({String name, List<String> programmes})>{
  'BIO': (name: 'Biological Sciences', programmes: ['B1']),
  'BIOT': (name: 'Biotechnology', programmes: ['A9']),
  'CE': (name: 'Civil', programmes: ['A2']),
  'CHE': (name: 'Chemical', programmes: ['A1']),
  'CHEM': (name: 'Chemistry', programmes: ['B2']),
  'CS': (name: 'Computer Science', programmes: ['A7']),
  'ECON': (name: 'Economics', programmes: ['B3']),
  'ELEC': (name: 'Electronics', programmes: ['A3', 'A8', 'AA', 'AC']),
  'ENVS': (name: 'Environmental and Sustainability', programmes: ['AJ']),
  'MAC': (name: 'Mathematics and Computing', programmes: ['AD']),
  'MATH': (name: 'Mathematics', programmes: ['B4']),
  'ME': (name: 'Mechanical', programmes: ['A4']),
  'MF': (name: 'Manufacturing', programmes: ['AB']),
  'PHA': (name: 'Pharmacy', programmes: ['A5']),
  'PHY': (name: 'Physics', programmes: ['B5']),
  'SNS': (name: 'Semiconductor and Nanoscience', programmes: ['B7']),
};

/// The display name for department [key], or [key] itself when unknown.
String departmentName(String key) =>
    key == genDept ? 'Electives' : departments[key]?.name ?? key;

/// Department keys a campus runs, in [departments] order: those with a
/// programme offered there (`programmesAt`, DISCIPLINES_GOA_HYD.md).
List<String> departmentsAt(String campus) {
  final here = {for (final p in programmesAt(Campus.named(campus))) p.code};
  return [
    for (final e in departments.entries)
      if (e.value.programmes.any(here.contains)) e.key,
  ];
}

/// What a president of [dept] goes by: the branch they were appointed for
/// ("A3"), else the department's one branch ("A7" for CS), else [dept].
String branchCode(String dept, [String? programme]) =>
    programme ??
    (dept == genDept ? 'Electives' : null) ??
    switch (departments[dept]?.programmes) {
      [final only] => only,
      _ => dept,
    };

/// The department a programme belongs to: ELEC for A3.
String? departmentOfProgramme(String code) =>
    departments.entries
        .where((e) => e.value.programmes.contains(code))
        .firstOrNull
        ?.key;
