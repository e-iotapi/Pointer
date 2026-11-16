/// Roles as data: the built-in admin, president and CR rows and terms
/// (`roles/builtin`) and owner-made custom roles (`roles/{id}`). The rules'
/// `may()` and `MyRoles.may` both read these (CUSTOM_ROLES_DESIGN.md).
library;

import 'package:cgpa_calculator/core/roles/capabilities.dart';

/// How far a grant of a role reaches.
enum ReachKind { everywhere, campus, dept, course }

/// One role: a set of §4 rows, a grant term and, for custom roles, a scope.
class RoleDef {
  const RoleDef({
    required this.id,
    required this.name,
    required this.tag,
    required this.caps,
    required this.termDays,
    required this.builtin,
    this.campus,
    this.dept,
    this.fixedReach,
  });

  /// `admin`, `president`, `cr`, `owner`, or a custom role's document id.
  final String id, name, tag;

  /// The ticked rows.
  final Set<Capability> caps;

  /// Grant length in days.
  final int termDays;

  /// Whether this is admin, president, CR or owner.
  final bool builtin;

  /// A custom role's scope (`all` or a campus key; `all` or a department).
  final String? campus, dept;

  /// The reach every grant of a built-in role has; null for custom roles.
  final ReachKind? fixedReach;
}

/// Every role the app knows, by id.
class RoleDefs {
  const RoleDefs(this.byId);

  /// The roles by id.
  final Map<String, RoleDef> byId;

  /// The role stored under [id], or null (a deleted custom role).
  RoleDef? operator [](String id) => byId[id];

  static const _built = {
    'admin': ('Admin', 'ADMIN', ReachKind.everywhere),
    'president': ('Department president', 'PRESIDENT', ReachKind.dept),
    'cr': ('Course manager', 'CR', ReachKind.course),
  };

  /// The §4 table's defaults, used until `roles/builtin` exists.
  static RoleDefs defaults() => fromDocs(null, const {});

  /// Builds the defs from the stored documents; a missing built-in falls
  /// back to its default, and unknown capability keys are ignored.
  static RoleDefs fromDocs(
    Map<String, dynamic>? builtin,
    Map<String, Map<String, dynamic>> custom,
  ) {
    final base = defaultBuiltinCaps();
    final out = <String, RoleDef>{};
    for (final e in _built.entries) {
      final m = builtin?[e.key] as Map?;
      out[e.key] = RoleDef(
        id: e.key,
        name: e.value.$1,
        tag: e.value.$2,
        caps: m == null ? base[e.key]! : _caps(m['caps']),
        termDays: (m?['termDays'] as num?)?.toInt() ?? defaultTermDays[e.key]!,
        builtin: true,
        fixedReach: e.value.$3,
      );
    }
    out['owner'] = RoleDef(
      id: 'owner',
      name: 'Owner',
      tag: 'OWNER',
      caps: Capability.values.toSet(),
      termDays: 36500,
      builtin: true,
      fixedReach: ReachKind.everywhere,
    );
    for (final e in custom.entries) {
      out[e.key] = RoleDef(
        id: e.key,
        name: e.value['name'] as String? ?? '',
        tag: 'ROLE',
        caps: _caps(e.value['caps']),
        termDays: (e.value['termDays'] as num?)?.toInt() ?? 183,
        builtin: false,
        campus: e.value['campus'] as String? ?? 'all',
        dept: e.value['dept'] as String? ?? 'all',
      );
    }
    return RoleDefs(out);
  }

  /// The ticked rows for [keys]. Averages live inside the eval scheme, so a
  /// stored `averages` without `courseStructures` reads as not ticked.
  static Set<Capability> _caps(Object? keys) {
    final s = {
      for (final c in Capability.values)
        if (keys is List && keys.contains(c.key)) c,
    };
    if (!s.contains(Capability.courseStructures)) s.remove(Capability.averages);
    return s;
  }
}
