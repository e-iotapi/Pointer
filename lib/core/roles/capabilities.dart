/// Who may do what: a literal copy of the role table in ARCHITECTURE.md §4
/// (§16.3 fix 2). Screens ask [can] and never inline a role check; the rules
/// tests walk the same table, and test/core/capabilities_test.dart fails when
/// this copy and the document disagree.
library;

/// A rung of the role table, strongest first.
enum Role { owner, admin, president, cr, student }

/// How wide a role's reach must be for a row to mean anything.
enum CapReach { everywhere, campus, dept }

/// One row of the table. The cells are the document's text, verbatim.
enum Capability {
  addRemoveOwners(
    'Add / remove owners',
    '✓ (never themselves)',
    '—',
    '—',
    '—',
    CapReach.everywhere,
  ),
  appointAdmins(
    'Appoint / revoke admins',
    '✓',
    '—',
    '—',
    '—',
    CapReach.everywhere,
  ),
  appointPresidents(
    'Appoint / revoke presidents',
    '✓',
    '✓',
    '—',
    '—',
    CapReach.dept,
  ),
  appointCrs(
    'Appoint / revoke CRs',
    '✓',
    '✓',
    '✓ in scope',
    '—',
    CapReach.dept,
  ),
  publish('Publishing, analytics', '✓', '—', '—', '—', CapReach.everywhere),
  publicContact(
    'Public contact (`config/public`)',
    '✓',
    '✓',
    '—',
    '—',
    CapReach.everywhere,
  ),
  grantTermsCrPresident(
    'Grant terms — CR and president lengths',
    '✓',
    '✓',
    '—',
    '—',
    CapReach.everywhere,
  ),
  grantTermsAdmin(
    'Grant terms — admin length',
    '✓',
    '—',
    '—',
    '—',
    CapReach.everywhere,
  ),
  mergeProfessors(
    'Merge duplicate professors',
    '✓',
    '✓ own campus',
    '✓ in scope',
    '—',
    CapReach.dept,
  ),
  courseStructures(
    'Course structures, eval schemes',
    '✓',
    '✓ own campus',
    '✓',
    '✓ own courses',
    CapReach.dept,
  ),
  bulkUpload(
    'Bulk upload a JSON of eval schemes',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  ),
  degreeRequirements(
    'Degree requirements',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  ),
  departmentResources(
    'Department resources',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  ),
  courseResources(
    'Course resources',
    '✓',
    '✓ own campus',
    '✓',
    '✓ own courses',
    CapReach.dept,
  ),
  averages(
    'Averages — course, component, part',
    '✓',
    '✓ own campus',
    '✓',
    '✓ own courses',
    CapReach.dept,
  ),
  professors(
    'Professors — create, rename',
    '✓',
    '✓ own campus',
    '✓',
    'pick only',
    CapReach.dept,
  ),
  moderateReviews(
    'Moderate reviews',
    '✓',
    '✓ own campus',
    '✓ in scope',
    '—',
    CapReach.dept,
  ),
  readAuditAndRoster(
    'Read the audit log and the roster',
    '✓',
    '✓',
    '✓ own campus',
    '—',
    CapReach.campus,
  ),
  contribute(
    'Contribute links (approved within 15 days)',
    '✓',
    '✓ own campus',
    '✓',
    '✓',
    CapReach.campus,
  ),
  manageRoles('Manage roles', '✓', '✓', '—', '—', CapReach.everywhere),
  approveContributors(
    'Approve contributors',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  ),
  claimElectives(
    'Claim elective courses',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  ),
  reviewGateSwitch(
    'Compulsory reviews switch',
    '✓',
    '✓ own campus',
    '—',
    '—',
    CapReach.campus,
  ),
  publishTimetable(
    'Publish the timetable',
    '✓',
    '✓ own campus',
    '—',
    '—',
    CapReach.everywhere,
  ),
  openAs('Open Pointer as', '✓', '—', '—', '—', CapReach.everywhere),
  publishDirectly(
    'Links publish without approval',
    '✓',
    '✓ own campus',
    '✓',
    '—',
    CapReach.dept,
  );

  const Capability(
    this.label,
    this.owner,
    this.admin,
    this.president,
    this.cr,
    this.reach,
  );

  /// The row's name in the table.
  final String label;

  /// The owner column's text.
  final String owner;

  /// The admin column's text.
  final String admin;

  /// The president column's text.
  final String president;

  /// The CR column's text.
  final String cr;

  /// The narrowest reach this row is meaningful at.
  final CapReach reach;

  /// Stable storage key for this row.
  String get key => name;

  /// One line on what the row lets a holder do (the role editor's (i)).
  String get help => switch (this) {
    addRemoveOwners => 'Add or remove owners, who can do everything.',
    appointAdmins => 'Appoint, renew or revoke admins.',
    appointPresidents =>
      'Appoint, renew or revoke department presidents and secretaries.',
    appointCrs => 'Appoint, renew or revoke course managers (CRs).',
    publish => 'Publish app releases and see site analytics.',
    publicContact => 'Edit the public contact shown to students.',
    grantTermsCrPresident => 'Set how long CR and president terms last.',
    grantTermsAdmin => 'Set how long admin terms last.',
    mergeProfessors =>
      'Merge two entries for one professor, joining their reviews.',
    courseStructures =>
      "Edit a course's offering: components, weights and professors.",
    bulkUpload => 'Upload eval schemes for many courses from a JSON file.',
    degreeRequirements => "Edit a department's degree requirements.",
    departmentResources => "Add and edit a department's resource links.",
    courseResources => "Add and edit a course's resource links.",
    averages => 'Publish class averages for a course.',
    professors => 'Add, rename or remove professors in a department.',
    moderateReviews => 'Hide or restore reviews, with a logged reason.',
    readAuditAndRoster => 'Read the audit log and who holds which role.',
    contribute => 'Suggest resource links for approval.',
    manageRoles => 'Create, edit and delete custom roles, and appoint to them.',
    approveContributors => 'Approve or decline contributors and their links.',
    claimElectives => 'Claim elective courses for a department to manage.',
    reviewGateSwitch => 'Turn compulsory reviews on or off for a campus.',
    publishTimetable => "Publish a campus's timetable.",
    openAs => 'Preview Pointer as any role.',
    publishDirectly => 'Publish resource links without waiting for approval.',
  };

  /// The table text for [role] on this row.
  String cell(Role role) => switch (role) {
    Role.owner => owner,
    Role.admin => admin,
    Role.president => president,
    Role.cr => cr,
    Role.student => '—',
  };
}

/// Whether [role] may do [action].
///
/// [inScope]: the target lies inside the actor's grant — their department on
/// their campus for a president, their course for a CR. Presidents and CRs
/// only ever act in scope (§4, "Scope"), so every one of their ticks needs
/// it. [targetIsSelf]: the action is aimed at the actor's own account.
/// "pick only" (a CR choosing a professor) is not create or rename.
bool can(
  Role role,
  Capability action, {
  bool inScope = true,
  bool targetIsSelf = false,
}) {
  final cell = action.cell(role);
  if (!cell.startsWith('✓')) return false;
  if (cell.contains('never themselves') && targetIsSelf) return false;
  if (role == Role.president || role == Role.cr) return inScope;
  return true;
}

/// The built-in role keys, weakest last.
const builtinRoleKeys = ['admin', 'president', 'cr'];

/// Default grant lengths in days for each built-in role.
const defaultTermDays = {'admin': 730, 'president': 365, 'cr': 183};

/// The ticked cells of each built-in column (`✓…` counts as ticked).
Map<String, Set<Capability>> defaultBuiltinCaps() => {
  for (final r in [Role.admin, Role.president, Role.cr])
    r.name: {
      for (final c in Capability.values)
        if (c.cell(r).startsWith('✓')) c,
    },
};

/// The appoint rows: any of them opens Maintainers and the grant form.
const appointCaps = [
  Capability.appointAdmins,
  Capability.appointPresidents,
  Capability.appointCrs,
];

/// The rows behind Controls › Course tools.
const courseToolsCaps = [
  Capability.courseStructures,
  Capability.bulkUpload,
  Capability.degreeRequirements,
  Capability.averages,
  Capability.professors,
  Capability.mergeProfessors,
  Capability.departmentResources,
  Capability.courseResources,
  Capability.approveContributors,
];

/// The rows behind Controls › Reviews.
const reviewsCaps = [Capability.moderateReviews, Capability.reviewGateSwitch];
