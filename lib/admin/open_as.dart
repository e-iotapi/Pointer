import 'package:cgpa_calculator/admin/widgets.dart';
import 'package:cgpa_calculator/core/search/hints.dart';
import 'package:cgpa_calculator/admin/dept_list.dart';
import 'package:cgpa_calculator/app/routes.dart';
import 'package:cgpa_calculator/app/theme/palette.dart';
import 'package:cgpa_calculator/app/theme/tokens.dart';
import 'package:cgpa_calculator/core/catalog/catalog.dart';
import 'package:cgpa_calculator/core/models/offering.dart';
import 'package:cgpa_calculator/core/professors/professor_store.dart';
import 'package:cgpa_calculator/core/roles/maintain_store.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/core/storage/cache_boxes.dart';
import 'package:cgpa_calculator/features/marks/official.dart';
import 'package:cgpa_calculator/shared/widgets/app_card.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/notice.dart';
import 'package:cgpa_calculator/shared/widgets/page_header.dart';
import 'package:cgpa_calculator/shared/widgets/search_box.dart';
import 'package:flutter/material.dart';
import 'package:go_router/go_router.dart';
import 'package:hive_ce/hive.dart';

const _recentKey = 'openAsRecent';
const _campuses = ['goa', 'hyderabad', 'pilani', 'dubai'];

/// [keys] with the ones in [recent] first, most recent first; the rest keep
/// their order (§10.22: the last opened on top).
List<String> recentFirst(List<String> keys, List<String> recent) => [
  for (final r in recent)
    if (keys.contains(r)) r,
  for (final k in keys)
    if (!recent.contains(k)) k,
];

/// What Open as opened last on this device, most recent first.
List<String> openedRecently() {
  if (!Hive.isBoxOpen(deviceBoxName)) return const [];
  final raw = Hive.box(deviceBoxName).get(_recentKey);
  return raw is List ? [for (final r in raw) '$r'] : const [];
}

Future<void> _remember(String key) async {
  if (!Hive.isBoxOpen(deviceBoxName)) return;
  final next = [key, ...openedRecently().where((k) => k != key)].take(8);
  await Hive.box(deviceBoxName).put(_recentKey, next.toList());
}

/// Board `RolePick`: an owner opens Pointer as any role (§16.3 fix 1). It
/// changes what they see, not what they can do: the database still sees the
/// owner, and every save is theirs.
class OpenAsPage extends StatelessWidget {
  const OpenAsPage({super.key});

  @override
  Widget build(BuildContext context) {
    final p = AppPalette.of(context);
    final name = roleStore?.myName ?? '';
    final defs = roleStore?.peekRoleDefs() ?? RoleDefs.defaults();
    void open(ViewAs? v, String to) {
      viewAs.value = v;
      context.go(to);
    }

    Widget row(
      String tag,
      bool strong,
      String title,
      String line,
      VoidCallback go, {
      bool plain = false,
    }) => CardRow(
      minHeight: 56,
      // 58 wide on the board, so the titles line up; never narrower than
      // the tag itself.
      leading: ConstrainedBox(
        constraints: const BoxConstraints(minWidth: 58),
        child: Align(
          widthFactor: 1,
          alignment: Alignment.centerLeft,
          child: TierTag(tag, strong: strong, plain: plain),
        ),
      ),
      title: title,
      // Two lines at large text beside the 58 wide tag (T9.1).
      titleLines: 2,
      subtitle: line,
      onTap: go,
    );

    return PageFrame(
      header: const PageHeader(
        eyebrow: 'OWNER · TESTING AND DEVELOPMENT',
        title: 'Open Pointer as',
      ),
      children: [
        Container(
          padding: const EdgeInsets.all(14),
          decoration: BoxDecoration(
            color: p.navBackground,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            children: [
              Container(
                width: 36,
                height: 36,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  color: p.hero,
                  shape: BoxShape.circle,
                ),
                child: Text(
                  name.isEmpty ? '?' : name[0].toUpperCase(),
                  style: TypeScale.body.copyWith(
                    fontWeight: FontWeight.w800,
                    color: p.onHero,
                  ),
                ),
              ),
              const SizedBox(width: 12),
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      name.isEmpty ? 'You' : name,
                      style: TypeScale.body.copyWith(
                        fontSize: 13,
                        fontWeight: FontWeight.w700,
                        color: p.isDark ? p.text : p.onInverse,
                      ),
                    ),
                    Text(
                      'Signed in as an owner',
                      style: TypeScale.caption.copyWith(
                        fontSize: 10.5,
                        color: p.navIcon,
                      ),
                    ),
                  ],
                ),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        AppCard(
          padding: EdgeInsets.zero,
          child: Column(
            children: [
              row(
                'OWNER',
                false,
                'Owner',
                'Everything, every campus',
                () => open(null, Routes.admin),
              ),
              const CardDivider(),
              row(
                'ADMIN',
                true,
                'Admin',
                'Controls without Owner only',
                () => open(ViewAs(defs['admin']!), Routes.admin),
              ),
              const CardDivider(),
              row(
                'PRES',
                false,
                'Department president',
                'Pick a department and campus',
                () => context.push(Routes.openAsDept),
              ),
              const CardDivider(),
              row(
                'CR',
                true,
                'Course manager',
                'Pick a course and campus',
                () => context.push(Routes.openAsCourse),
              ),
              const CardDivider(),
              row(
                'ROLE',
                false,
                'Custom role',
                "Pick a role; it opens at the role's own scope",
                () => context.push(Routes.openAsRole),
                plain: true,
              ),
              const CardDivider(),
              row(
                'STUDENT',
                false,
                'Student',
                'Your own grades, as any student sees them',
                () => open(ViewAs.student, Routes.home),
              ),
            ],
          ),
        ),
        const SizedBox(height: 12),
        Notice(
          warning: true,
          text: TextSpan(
            children: [
              TextSpan(
                text: 'This changes what you see, not what you can do. ',
                style: TextStyle(fontWeight: FontWeight.w800),
              ),
              TextSpan(
                text:
                    'The database still sees your owner account: anything you '
                    'save is saved as you and logged with your name. A strip '
                    'at the top says which role you are viewing as, with a '
                    'button back here.',
              ),
            ],
          ),
        ),
        const Note(
          'Only owners ever see this screen. Testing what a role may actually '
          'do uses the emulator and test accounts, never this screen.',
        ),
      ],
    );
  }
}

/// The campus pills and a search box, shared by both pickers.
class _PickerFrame extends StatelessWidget {
  const _PickerFrame({
    required this.title,
    required this.campus,
    required this.onCampus,
    required this.search,
    required this.hint,
    required this.onSearch,
    required this.children,
    this.eyebrow = 'OPEN AS · DEPARTMENT PRESIDENT',
  });
  final String eyebrow, title, campus, hint;
  final ValueChanged<String> onCampus;
  final TextEditingController search;
  final VoidCallback onSearch;
  final List<Widget> children;

  @override
  Widget build(BuildContext context) => PageFrame(
    header: PageHeader(eyebrow: eyebrow, title: title),
    children: [
      // Only owners cross campuses; an admin sees their own, as a label.
      if (myRoles.value.owner)
        ChoicePills<String>(
          values: _campuses,
          selected: campus,
          // The board's short form, so four fit at 320.
          label: (c) => c == 'hyderabad' ? 'Hyd' : campusName(c),
          equal: true,
          onSelected: onCampus,
        )
      else
        SectionLabel(campusName(campus)),
      const SizedBox(height: Space.sm),
      SearchBox(controller: search, hint: hint, onChanged: (_) => onSearch()),
      ...children,
    ],
  );
}

/// A card of picker rows: the title over a line, and a chevron.
Widget _rows(List<(String, String, VoidCallback)> rows) => AppCard(
  padding: EdgeInsets.zero,
  child: Column(
    children: [
      for (final (i, (title, line, go)) in rows.indexed) ...[
        if (i > 0) const CardDivider(),
        CardRow(title: title, subtitle: line, onTap: go, titleLines: 2),
      ],
    ],
  ),
);

/// Board `Rl_OpenAs`, Custom role ›: the owner's custom roles by name and
/// scope. A pick opens Controls as that role's holder, at the role's own
/// scope.
class ViewAsRolePage extends StatelessWidget {
  const ViewAsRolePage({super.key});

  @override
  Widget build(BuildContext context) => Loaded<List<RoleDef>>(
    cacheKey: 'open-as-roles',
    load: () async => _custom(await roleStore!.roleDefs()),
    peek: () => switch (roleStore!.peekRoleDefs()) {
      final d? => _custom(d),
      null => null,
    },
    builder:
        (context, roles, _) => PageFrame(
          header: const PageHeader(
            eyebrow: 'OPEN AS · CUSTOM ROLE',
            title: 'Which role?',
          ),
          children: [
            if (roles.isEmpty)
              const Note('No custom roles yet. Make one in Roles, on Controls.')
            else
              AppCard(
                padding: EdgeInsets.zero,
                child: Column(
                  children: [
                    for (final (i, d) in roles.indexed) ...[
                      if (i > 0) const CardDivider(),
                      CardRow(
                        minHeight: 56,
                        leading: ConstrainedBox(
                          constraints: const BoxConstraints(minWidth: 58),
                          child: const Align(
                            widthFactor: 1,
                            alignment: Alignment.centerLeft,
                            child: TierTag('ROLE', plain: true),
                          ),
                        ),
                        title: d.name,
                        subtitle: customScopeLabel(d),
                        onTap: () {
                          viewAs.value = ViewAs(d);
                          context.go(Routes.admin);
                        },
                      ),
                    ],
                  ],
                ),
              ),
          ],
        ),
  );

  static List<RoleDef> _custom(RoleDefs d) => [
    for (final r in d.byId.values)
      if (!r.builtin) r,
  ]..sort((a, b) => a.name.compareTo(b.name));
}

/// Board `ViewAsDept`: which department to open as its president; the last
/// opened sits on top. ELEC has a row per programme, since each has its own
/// presidents, and every row opens the ELEC they manage together.
///
/// With [tools] (Controls › Course tools, or Reviews with [reviews]) it opens
/// the department's own screen without setting [viewAs], starting on
/// [campus].
class ViewAsDeptPage extends StatefulWidget {
  const ViewAsDeptPage({
    super.key,
    this.tools = false,
    this.reviews = false,
    this.campus = 'goa',
  });
  final bool tools, reviews;
  final String campus;

  @override
  State<ViewAsDeptPage> createState() => _ViewAsDeptPageState();
}

class _ViewAsDeptPageState extends State<ViewAsDeptPage> {
  late String _campus = widget.campus;
  final _search = TextEditingController();

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<void> _open(String dept) async {
    if (widget.tools) {
      await context.push(
        widget.reviews
            ? Routes.deptReviews(_campus, dept)
            : '${Routes.dept(_campus, dept)}?tools=1',
      );
      return;
    }
    await _remember('dept:$_campus:$dept');
    viewAs.value = ViewAs(
      roleStore?.peekRoleDefs()?['president'] ??
          RoleDefs.defaults()['president']!,
      at: Reach(role: 'president', campus: _campus, dept: dept),
    );
    if (mounted) context.go(Routes.dept(_campus, dept));
  }

  @override
  Widget build(BuildContext context) => Loaded<(List<Grant>, List<String>)>(
    cacheKey: 'open-as-depts|$_campus',
    key: ValueKey(_campus),
    load:
        () async => (
          await roleStore!.roster(campus: _campus),
          await departmentSource.at(_campus),
        ),
    peek: () {
      final grants = roleStore!.peekRoster(campus: _campus);
      if (grants == null || departmentSource is! CampusDepartments) return null;
      return (grants, departmentsAt(_campus));
    },
    builder: (context, data, _) {
      final (grants, depts) = data;
      final now = DateTime.now();
      final q = _search.text.trim().toLowerCase();
      final recent = [
        for (final r in openedRecently())
          if (r.startsWith('dept:$_campus:')) r.split(':').last,
      ];
      final keys = recentFirst(depts, recent);
      final shown = [
        for (final b in deptBranches(keys))
          if (queryPhrases(q).any((ph) => branchMatches(b, ph)) ||
              q.isEmpty)
            b,
      ];
      int presidents(String d, String? prog) =>
          grants
              .where(
                (g) =>
                    g.role == GrantRole.dept &&
                    g.scope == d &&
                    (prog == null || g.programme == prog) &&
                    g.campus == _campus &&
                    g.liveAt(now),
              )
              .length;
      return _PickerFrame(
        title: 'Which department?',
        eyebrow:
            widget.tools
                ? (widget.reviews
                    ? 'CONTROLS · REVIEWS'
                    : 'CONTROLS · COURSE TOOLS')
                : 'OPEN AS · DEPARTMENT PRESIDENT',
        campus: _campus,
        onCampus: (c) => setState(() => _campus = c),
        search: _search,
        hint: 'Dept or programme',
        onSearch: () => setState(() {}),
        children: [
          SectionLabel(
            '${campusName(_campus)} · '
            '${deptBranches(depts).length} '
            'branches',
          ),
          if (shown.isEmpty)
            const Note('No department matches.')
          else
            _rows([
              for (final b in shown)
                (
                  branchName(b),
                  '${branchCodes(b)} · '
                      '${presidents(b.dept, b.programme)} president'
                      '${presidents(b.dept, b.programme) == 1 ? '' : 's'}'
                      '${recent.contains(b.dept) ? ' · opened recently' : ''}',
                  () => _open(b.dept),
                ),
            ]),
        ],
      );
    },
  );
}

typedef _Offered = ({String id, List<String> professors, int crs});

/// Board `ViewAsCourse`: which of this term's offerings to open as its CR,
/// each with its professors and CR count; the last opened on top.
///
/// With [tools] it opens the CR's course screen without setting [viewAs],
/// starting on [campus].
class ViewAsCoursePage extends StatefulWidget {
  const ViewAsCoursePage({super.key, this.tools = false, this.campus = 'goa'});
  final bool tools;
  final String campus;

  @override
  State<ViewAsCoursePage> createState() => _ViewAsCoursePageState();
}

class _ViewAsCoursePageState extends State<ViewAsCoursePage> {
  late String _campus = widget.campus;
  final _search = TextEditingController();
  final _term = currentTerm(DateTime.now());

  @override
  void dispose() {
    _search.dispose();
    super.dispose();
  }

  Future<List<_Offered>> _load() async {
    final store = roleStore!;
    final got = await MaintainStore(store).campusOfferings(_campus, _term);
    final grants = await store.roster(campus: _campus);
    final profs = ProfessorStore(store.db);
    final names = <String, String>{};
    final now = DateTime.now();
    final out = <_Offered>[];
    for (final o in got) {
      final id = o.courseId;
      if (id.isEmpty) continue;
      final ps = <String>[];
      for (final pid in o.professors) {
        final n = names[pid] ??= (await profs.get(pid))?.name ?? '';
        if (n.isNotEmpty) ps.add(n);
      }
      out.add((
        id: id,
        professors: ps,
        crs:
            grants
                .where(
                  (g) =>
                      g.role == GrantRole.course &&
                      g.scope == id &&
                      g.liveAt(now),
                )
                .length,
      ));
    }
    return out..sort((a, b) => a.id.compareTo(b.id));
  }

  Future<void> _open(String id) async {
    if (widget.tools) {
      await context.push(Routes.crCourse(_campus, id));
      return;
    }
    await _remember('course:$_campus:$id');
    viewAs.value = ViewAs(
      roleStore?.peekRoleDefs()?['cr'] ?? RoleDefs.defaults()['cr']!,
      at: Reach(
        role: 'cr',
        campus: _campus,
        dept: deptOf(id),
        course: id,
      ),
    );
    if (mounted) context.go(Routes.crCourse(_campus, id));
  }

  @override
  Widget build(BuildContext context) => Loaded<List<_Offered>>(
    cacheKey: 'open-as-courses|$_campus',
    key: ValueKey(_campus),
    load: _load,
    peek: () {
      final store = roleStore!;
      final got = MaintainStore(store).peekCampusOfferings(_campus, _term);
      final grants = store.peekRoster(campus: _campus);
      if (got == null || grants == null) return null;
      final profs = ProfessorStore(store.db);
      final names = <String, String>{};
      final now = DateTime.now();
      final out = <_Offered>[];
      for (final o in got) {
        final id = o.courseId;
        if (id.isEmpty) continue;
        final ps = <String>[];
        for (final pid in o.professors) {
          final p = profs.peekGet(pid);
          if (p == null) return null;
          final n = names[pid] ??= p.name;
          if (n.isNotEmpty) ps.add(n);
        }
        out.add((
          id: id,
          professors: ps,
          crs:
              grants
                  .where(
                    (g) =>
                        g.role == GrantRole.course &&
                        g.scope == id &&
                        g.liveAt(now),
                  )
                  .length,
        ));
      }
      return out..sort((a, b) => a.id.compareTo(b.id));
    },
    builder: (context, offered, _) {
      final q = _search.text.trim().toLowerCase();
      final recent = [
        for (final r in openedRecently())
          if (r.startsWith('course:$_campus:')) r.split(':').last,
      ];
      final byId = {for (final o in offered) o.id: o};
      final order = recentFirst([for (final o in offered) o.id], recent);
      final shown = [
        for (final id in order)
          if (q.isEmpty ||
              queryPhrases(q).any(
                (ph) =>
                    textMatches(ph, id) ||
                    byId[id]!.professors.any((n) => textMatches(ph, n)),
              ))
            byId[id]!,
      ];
      return _PickerFrame(
        eyebrow:
            widget.tools ? 'CONTROLS · COURSE TOOLS' : 'OPEN AS · COURSE MANAGER',
        title: 'Which course?',
        campus: _campus,
        onCampus: (c) => setState(() => _campus = c),
        search: _search,
        hint: 'Code or professor',
        onSearch: () => setState(() {}),
        children: [
          SectionLabel('${campusName(_campus)} · offered ${termLabel(_term)}'),
          if (shown.isEmpty)
            Note(
              offered.isEmpty
                  ? 'Nothing is offered on this campus for ${termLabel(_term)} '
                      'yet.'
                  : 'No course matches.',
            )
          else
            _rows([
              for (final o in shown)
                (
                  '${o.id} · ${catalog.master.where((m) => m.id == o.id).firstOrNull?.title ?? ''}',
                  '${o.professors.isEmpty ? 'No professor yet' : o.professors.join(', ')}'
                      ' · ${o.crs} CR${o.crs == 1 ? '' : 's'}',
                  () => _open(o.id),
                ),
            ]),
        ],
      );
    },
  );
}
