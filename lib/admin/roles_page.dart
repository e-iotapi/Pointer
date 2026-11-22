import 'package:cgpa_calculator/admin/admin_home.dart' show termSpan;
import 'package:cgpa_calculator/admin/widgets.dart';
import 'package:cgpa_calculator/app/routes.dart';
import 'package:cgpa_calculator/app/theme/palette.dart';
import 'package:cgpa_calculator/app/theme/tokens.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/shared/widgets/app_card.dart';
import 'package:cgpa_calculator/shared/widgets/app_text_field.dart';
import 'package:cgpa_calculator/shared/widgets/bottom_action.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/confirm_dialog.dart';
import 'package:cgpa_calculator/shared/widgets/notice.dart';
import 'package:cgpa_calculator/shared/widgets/page_header.dart';
import 'package:cgpa_calculator/shared/widgets/pill_button.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';

void _say(BuildContext context, String text) =>
    ScaffoldMessenger.of(context)
      ..clearSnackBars()
      ..showSnackBar(SnackBar(content: Text(text)));

/// Live holders of role [id] among [grants].
int _holders(List<Grant> grants, String id) {
  final now = DateTime.now();
  return grants.where((g) {
    if (!g.liveAt(now)) return false;
    return switch (id) {
      'admin' => g.role == GrantRole.admin,
      'president' => g.role == GrantRole.dept,
      'cr' => g.role == GrantRole.course,
      _ => g.role == GrantRole.custom && g.roleId == id,
    };
  }).length;
}

String _permissions(int n) => '$n permission${n == 1 ? '' : 's'}';

/// A custom role's scope in words: "Electronics, Goa".
String _scopeWords(RoleDef d) {
  final campus = d.campus ?? 'all';
  if (campus == 'all') return 'every campus';
  final dept = d.dept ?? 'all';
  return dept == 'all'
      ? 'every department, ${campusName(campus)}'
      : '${departmentName(dept)}, ${campusName(campus)}';
}

/// Board `Rl_Roles` (Controls › Roles): the owner's fixed role, the built-in
/// admin, president and CR, then the custom roles, each with its holders.
class RolesPage extends StatelessWidget {
  const RolesPage({super.key});

  @override
  Widget build(BuildContext context) => Loaded<_RolesData>(
    load: () async {
      final store = roleStore!;
      final defs = (await store.rolesForEdit()).defs;
      // A custom holder may not read the roster: no counts then.
      List<Grant>? grants;
      try {
        grants = await store.roster();
      } on Object {
        grants = null;
      }
      return (defs: defs, grants: grants);
    },
    builder: (context, data, reload) {
      final p = AppPalette.of(context);
      Widget row(
        Widget tag,
        String title,
        String subtitle,
        int? holders,
        VoidCallback? onTap,
      ) => CardRow(
        minHeight: 56,
        leading: tag,
        title: title,
        subtitle: subtitle,
        onTap: onTap,
        trailing:
            onTap == null
                ? null
                : Row(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (holders != null)
                      Padding(
                        padding: const EdgeInsets.only(right: 4),
                        child: Text(
                          '$holders',
                          style: TypeScale.caption.copyWith(color: p.textMuted),
                        ),
                      ),
                    Icon(Icons.chevron_right_rounded, color: p.textMuted),
                  ],
                ),
      );
      Future<void> edit(String id) async {
        await context.push(Routes.adminRole(id));
        reload();
      }

      int? holders(String id) =>
          data.grants == null ? null : _holders(data.grants!, id);
      final custom = [
        for (final d in data.defs.byId.values)
          if (!d.builtin) d,
      ]..sort((a, b) => a.name.compareTo(b.name));
      final reach = {
        'admin': 'every campus',
        'president': 'one department',
        'cr': 'one course',
      };
      return PageFrame(
        header: const PageHeader(eyebrow: 'CONTROLS · ROLES', title: 'Roles'),
        bottom: BottomAction(
          child: PrimaryButton(
            label: '+ New role',
            onPressed: () => edit('new'),
          ),
        ),
        children: [
          const Note(
            'A role is a set of permissions with a scope and a term. '
            'Changing a role changes it for everyone who holds it, at once.',
          ),
          const SectionLabel('Built-in'),
          RowGroup(
            children: [
              row(
                const TierTag('OWNER'),
                'Owner',
                'Everything, every campus · cannot be changed',
                null,
                null,
              ),
              for (final (id, tag, strong) in const [
                ('admin', 'ADMIN', true),
                ('president', 'PRES', false),
                ('cr', 'CR', true),
              ])
                row(
                  TierTag(tag, strong: strong),
                  data.defs[id]!.name,
                  '${_permissions(data.defs[id]!.caps.length)} · '
                  '${reach[id]} · ${termSpan(data.defs[id]!.termDays)}',
                  holders(id),
                  () => edit(id),
                ),
            ],
          ),
          if (custom.isNotEmpty) ...[
            const SectionLabel('Custom'),
            RowGroup(
              children: [
                for (final d in custom)
                  row(
                    const TierTag('ROLE'),
                    d.name,
                    '${_permissions(d.caps.length)} · ${_scopeWords(d)} · '
                    '${termSpan(d.termDays)}',
                    holders(d.id),
                    () => edit(d.id),
                  ),
              ],
            ),
          ],
          const Note(
            'Numbers on the right are current holders. Only owners change '
            'Admin, President and Course manager.',
          ),
        ],
      );
    },
  );
}

typedef _RolesData = ({RoleDefs defs, List<Grant>? grants});

typedef _EditData = ({RoleDefs defs, bool saved, List<Grant>? grants});

/// Board `Rl_RoleEditor` (a custom role: name, scope, term, permissions) and
/// `Rl_RoleBuiltin` (admin, president or CR: owners tick, admins set the
/// President and CR terms). [id] is `admin`, `president`, `cr`, a custom
/// role's id, or `new`.
class RoleEditor extends StatelessWidget {
  const RoleEditor({super.key, required this.id});
  final String id;

  @override
  Widget build(BuildContext context) => Loaded<_EditData>(
    load: () async {
      final store = roleStore!;
      final (:defs, :saved) = await store.rolesForEdit();
      List<Grant>? grants;
      try {
        grants = await store.roster();
      } on Object {
        grants = null;
      }
      return (defs: defs, saved: saved, grants: grants);
    },
    builder: (context, data, _) => _RoleForm(id: id, data: data),
  );
}

enum _Kind {
  dept('One department'),
  campus('Whole campus'),
  all('Every campus');

  const _Kind(this.label);
  final String label;
}

class _RoleForm extends StatefulWidget {
  const _RoleForm({required this.id, required this.data});
  final String id;
  final _EditData data;

  @override
  State<_RoleForm> createState() => _RoleFormState();
}

class _RoleFormState extends State<_RoleForm> {
  final _name = TextEditingController();
  late final RoleDef? _def = widget.data.defs[widget.id];
  late final Set<Capability> _caps = {...?_def?.caps};
  late int _days = _def?.termDays ?? 365;
  late _Kind _kind;
  late String _campus, _dept;
  bool _busy = false;

  final MyRoles _me = myRoles.value;

  bool get _builtin => _def?.builtin ?? false;

  /// The widest scope the author may give a custom role.
  (String, String) get _mine {
    if (_me.owner || _me.admin) return ('all', 'all');
    final d = _me.roleDefs[_me.custom?.roleId ?? ''];
    return (d?.campus ?? 'all', d?.dept ?? 'all');
  }

  @override
  void initState() {
    super.initState();
    final d = _def;
    _name.text = d?.name ?? '';
    final (mc, md) = _mine;
    _campus = d?.campus ?? (mc == 'all' ? 'goa' : mc);
    _dept = d?.dept ?? md;
    _kind =
        d == null
            ? (md == 'all' && mc == 'all' ? _Kind.campus : _Kind.dept)
            : (d.campus == 'all'
                ? _Kind.all
                : d.dept == 'all'
                ? _Kind.campus
                : _Kind.dept);
    if (_dept == 'all' && _kind == _Kind.dept) {
      _dept = _depts.firstOrNull ?? 'all';
    }
  }

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  List<String> get _depts {
    final (_, md) = _mine;
    if (md != 'all') return [md];
    final here = departmentsAt(_campus);
    return here.isEmpty ? departments.keys.toList() : here;
  }

  List<_Kind> get _kinds {
    final (mc, md) = _mine;
    return [
      _Kind.dept,
      if (md == 'all') _Kind.campus,
      if (mc == 'all') _Kind.all,
    ];
  }

  bool _held(Capability c) => _me.reach(c).isNotEmpty;

  /// Whether this author may tick [c] now.
  bool _mayTick(Capability c) {
    if (_builtin ? !_me.owner : !_held(c)) return false;
    if (c == Capability.courseStructures &&
        _caps.contains(Capability.averages)) {
      return false;
    }
    return c != Capability.averages || _held(Capability.courseStructures);
  }

  void _toggle(Capability c) => setState(() {
    if (_caps.remove(c)) {
      if (c == Capability.courseStructures) _caps.remove(Capability.averages);
    } else {
      _caps.add(c);
      if (c == Capability.averages) _caps.add(Capability.courseStructures);
    }
  });

  bool _mayTerm() => switch (widget.id) {
    'admin' => _me.may(Capability.grantTermsAdmin) && widget.data.saved,
    'president' ||
    'cr' => _me.may(Capability.grantTermsCrPresident) && widget.data.saved,
    _ => true,
  };

  Future<void> _save() async {
    final store = roleStore!;
    setState(() => _busy = true);
    try {
      if (_builtin) {
        await store.saveBuiltin(widget.id, _caps, _days);
      } else {
        await store.saveCustomRole(
          id: _def?.id,
          name: _name.text.trim(),
          caps: _caps,
          termDays: _days,
          campus: _kind == _Kind.all ? 'all' : _campus,
          dept: _kind == _Kind.dept ? _dept : 'all',
        );
      }
      if (!mounted) return;
      _say(context, 'Saved.');
      Navigator.of(context).maybePop();
    } on Object catch (e) {
      if (mounted) _say(context, problem(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _delete() async {
    final ok = await confirmDialog(
      context,
      title: 'Delete ${_def!.name}?',
      body: 'The role is removed. Nobody holds it, so nobody loses anything.',
      action: 'Delete',
      cancel: 'Keep',
      danger: true,
    );
    if (ok != true) return;
    setState(() => _busy = true);
    try {
      await roleStore!.deleteCustomRole(_def.id);
      if (!mounted) return;
      _say(context, 'Deleted.');
      Navigator.of(context).maybePop();
    } on Object catch (e) {
      if (mounted) _say(context, problem(e));
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  /// One tick row: a checkbox, the row's name, and a tag at the right.
  Widget _tick(Capability c, {bool campusTag = false}) {
    final p = AppPalette.of(context);
    final on = _mayTick(c);
    final tag =
        !_builtin && !_held(c)
            ? 'YOU LACK IT'
            : c.reach == CapReach.everywhere
            ? 'EVERYWHERE'
            : campusTag && c.reach == CapReach.campus
            ? 'CAMPUS'
            : null;
    final locked =
        c == Capability.courseStructures &&
        _caps.contains(Capability.averages) &&
        _mayTick(Capability.averages);
    // A row the author lacks shows a disabled box and its tag (no Opacity:
    // test/perf/no_opacity_test.dart).
    return CardRow(
      minHeight: 46,
      leading: Checkbox(
        value: _caps.contains(c),
        onChanged: on ? (_) => _toggle(c) : null,
      ),
      title: c.label,
      titleLines: 2,
      titleBadge: Tooltip(
        message: c.help,
        triggerMode: TooltipTriggerMode.tap,
        showDuration: const Duration(seconds: 4),
        child: Semantics(
          button: true,
          label: 'About ${c.label}',
          child: Icon(Icons.info_outline_rounded, size: 16, color: p.textMuted),
        ),
      ),
      subtitle:
          locked
              ? 'Averages live inside the eval scheme, so this also needs '
                  'Course structures'
              : null,
      onTap: on ? () => _toggle(c) : null,
      trailing:
          tag == null
              ? null
              : Text(tag, style: TypeScale.label.copyWith(color: p.textMuted)),
    );
  }

  Widget _term() {
    final p = AppPalette.of(context);
    final cr = widget.id == 'cr';
    final step = cr ? 182 : 365;
    final n = (_days / step).round();
    final unit = '${cr ? 'semester' : 'year'}${n == 1 ? '' : 's'}';
    final ends = DateTime.now().add(Duration(days: _days));
    final can = _mayTerm();
    return AppCard(
      padding: const EdgeInsets.fromLTRB(15, 12, 12, 12),
      child: Row(
        children: [
          Expanded(
            child: Text(
              'Given today → ends ${shortDay(ends, year: true)}',
              style: TypeScale.caption.copyWith(color: p.textMuted),
            ),
          ),
          if (can) ...[
            PillButton.icon(
              icon: Icons.remove_rounded,
              semanticLabel: 'Shorter',
              onPressed: n > 1 ? () => setState(() => _days -= step) : null,
            ),
            const SizedBox(width: 8),
            Text(
              '$n',
              style: TypeScale.body.copyWith(
                fontSize: 15,
                fontWeight: FontWeight.w800,
              ),
            ),
            const SizedBox(width: 5),
            Text(
              unit,
              style: TypeScale.caption.copyWith(
                fontWeight: FontWeight.w600,
                color: p.textMuted,
              ),
            ),
            const SizedBox(width: 8),
            PillButton.icon(
              icon: Icons.add_rounded,
              semanticLabel: 'Longer',
              onPressed: () => setState(() => _days += step),
            ),
          ] else ...[
            Icon(Icons.lock_outline_rounded, size: 14, color: p.textMuted),
            const SizedBox(width: 5),
            Text(
              '$n $unit',
              style: TypeScale.caption.copyWith(
                fontWeight: FontWeight.w700,
                color: p.textMuted,
              ),
            ),
          ],
        ],
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final grants = widget.data.grants;
    final holders =
        grants == null || _def == null ? 0 : _holders(grants, _def.id);
    return _builtin
        ? _builtinPage(holders)
        : _customPage(holders, _busy || _name.text.trim().isEmpty);
  }

  Widget _builtinPage(int holders) {
    final d = _def!;
    final id = d.id;
    final canSave = _me.owner || _mayTerm();
    final (scope, scopeNote) = switch (id) {
      'admin' => ('Every campus', 'Fixed for this role.'),
      'president' => (
        'One department, on the holder\'s campus',
        'Fixed for this role: the department is picked when appointing, as '
            'today. Secretaries get the same permissions; handover and '
            'appointing secretaries stay with presidents.',
      ),
      _ => (
        'One course, on the holder\'s campus',
        'Fixed for this role: the course is picked when appointing, as today.',
      ),
    };
    return PageFrame(
      header: PageHeader(
        eyebrow: 'ROLES · ${_me.owner ? 'OWNER ONLY' : 'BUILT-IN'}',
        title: d.name,
      ),
      bottom:
          canSave
              ? BottomAction(
                child: PrimaryButton(
                  label: _busy ? 'Saving…' : 'Save',
                  onPressed: _busy ? null : _save,
                ),
              )
              : null,
      children: [
        const SectionLabel('Scope'),
        AppCard(
          child: Text(
            scope,
            style: TypeScale.body.copyWith(
              fontSize: 13,
              fontWeight: FontWeight.w700,
            ),
          ),
        ),
        Note(scopeNote),
        const SectionLabel('Term'),
        _term(),
        const Note(
          'Replaces Grant terms. Admins may change the President and CR '
          'terms; the Admin term is owners\' alone.',
        ),
        if (!widget.data.saved && !_me.owner)
          const Note(
            'An owner must open Roles once first, so the terms are saved '
            'with the roles.',
          ),
        const SectionLabel('Permissions'),
        RowGroup(children: [for (final c in Capability.values) _tick(c)]),
        if (id != 'admin')
          Note(
            'Ticking a permission Admin lacks stops admins appointing '
            '${id == 'president' ? 'presidents' : 'course managers'} until '
            'Admin has it too.',
          ),
        if (_me.owner)
          Note(
            'Changes apply to all $holders '
            '${id == 'admin'
                ? 'admins'
                : id == 'president'
                ? 'presidents'
                : 'course managers'} at once and are logged with your name.',
          ),
      ],
    );
  }

  Widget _customPage(int holders, bool cannotSave) {
    final d = _def;
    final (mc, _) = _mine;
    final scoped = [
      for (final c in Capability.values)
        if (c.reach != CapReach.everywhere) c,
    ];
    final everywhere = [
      for (final c in Capability.values)
        if (c.reach == CapReach.everywhere) c,
    ];
    return PageFrame(
      header: PageHeader(
        eyebrow: 'ROLES · CUSTOM',
        title: d?.name ?? 'New role',
      ),
      bottom: BottomAction(
        child: PrimaryButton(
          label: _busy ? 'Saving…' : 'Save role',
          onPressed: cannotSave ? null : _save,
        ),
      ),
      children: [
        AppTextField(
          controller: _name,
          label: 'Name',
          hint: 'Resources lead',
          labelAbove: true,
          onChanged: (_) => setState(() {}),
        ),
        const SectionLabel('Scope · set here, not when appointing'),
        ChoicePills<_Kind>(
          values: _kinds,
          selected: _kind,
          label: (k) => k.label,
          equal: true,
          onSelected:
              (k) => setState(() {
                _kind = k;
                if (k == _Kind.dept && _dept == 'all') {
                  _dept = _depts.firstOrNull ?? 'all';
                }
              }),
        ),
        if (_kind != _Kind.all) ...[
          const SizedBox(height: Space.sm),
          if (mc == 'all')
            CampusPills(
              campus: _campus,
              onSelected:
                  (c) => setState(() {
                    _campus = c;
                    if (_kind == _Kind.dept && !_depts.contains(_dept)) {
                      _dept = _depts.firstOrNull ?? 'all';
                    }
                  }),
            ),
          if (_kind == _Kind.dept) ...[
            const SizedBox(height: Space.sm),
            ChoicePills<String>(
              values: _depts,
              selected: _dept,
              label: departmentName,
              onSelected: (v) => setState(() => _dept = v),
            ),
          ],
        ],
        Note(
          '${_kind == _Kind.all ? 'Holders must be students.' : 'Holders must be students on ${campusName(_campus)}.'} '
          'Permissions marked EVERYWHERE work on every campus whatever this '
          'scope is.',
        ),
        const SectionLabel('Term'),
        _term(),
        const SectionLabel('Permissions · in this scope'),
        RowGroup(children: [for (final c in scoped) _tick(c, campusTag: true)]),
        const SectionLabel('Permissions · everywhere'),
        RowGroup(children: [for (final c in everywhere) _tick(c)]),
        const SizedBox(height: Space.sm),
        const Notice(
          text: TextSpan(
            text:
                'Greyed rows are ones you do not hold; only owners can give '
                'every permission.',
          ),
        ),
        if (d != null) ...[
          Note(
            holders == 1
                ? '1 person holds this role.'
                : '$holders people hold this role.',
          ),
          const SizedBox(height: Space.sm),
          Align(
            alignment: Alignment.centerLeft,
            child: PillButton(
              label: 'Delete role',
              onPressed: holders > 0 || _busy ? null : _delete,
            ),
          ),
          if (holders > 0)
            Note('Revoke its $holders holder${holders == 1 ? '' : 's'} first'),
        ],
      ],
    );
  }
}
