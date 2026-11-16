import 'package:cgpa_calculator/app/router.dart';
import 'package:cgpa_calculator/core/analytics/analytics_store.dart';
import 'package:cgpa_calculator/core/prefetch/prefetch.dart';
import 'package:cgpa_calculator/core/professors/professor_store.dart';
import 'package:cgpa_calculator/core/roles/activity_store.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/maintain_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/core/storage/offerings.dart';
import 'package:cgpa_calculator/features/calendar/calendar_data.dart';
import 'package:cgpa_calculator/features/contribute/contribute_data.dart';
import 'package:cgpa_calculator/features/marks/official.dart';
import 'package:cgpa_calculator/features/resources/resources_page.dart';
import 'package:cgpa_calculator/features/reviews/gate_ui.dart';
import 'package:cgpa_calculator/features/reviews/review_widgets.dart';
import 'package:cgpa_calculator/features/roles/rep_profile.dart';
import 'package:cgpa_calculator/features/setup/campus_pick_page.dart';
import 'package:cgpa_calculator/script.dart';

Future<void> Function() _job(Future<Object?> Function() call) =>
    () => call().then((_) {});

/// Levels 2-4 for the signed-in user (level 1 is already local). Built when
/// the run starts, so it reads the roles and campus as they are then.
List<PrefetchLevel> prefetchLevels() {
  final campus = viewCampus(), roles = roleStore;
  if (campus == null || roles == null) return const [];
  final reviews = reviewStore!, contacts = contactStore!;
  final taking = takingNow().toList()..sort();
  final term = currentTerm(DateTime.now());
  final me = myRoles.value;
  final l2 = <PrefetchLevel>[[]], l3 = <PrefetchLevel>[[]];
  final two = l2.first, three = l3.first;

  // The lock decides what Reviews draws, so its first frame must know it.
  if (gateStore case final g?) {
    two.add(
      _job(() async {
        await g.of(campus);
        await recoverMyReviews(campus);
        return null;
      }),
    );
  }
  two.add(_job(() => reviews.mostReviewed(campus)));
  for (final c in taking) {
    two.add(_job(() => reviews.stats(c, campus)));
  }
  for (final c in myReviewedCourses()) {
    two.add(_job(() => reviews.mine(c)));
  }
  two.add(_job(() => contacts.directory(campus)));
  // Last updated on Representatives and the course page (B4).
  two.add(_job(() => ActivityStore(roles.db).of(campus)));
  // The broadcast timetable (marker `timetable`): the Calendar opens with it.
  final tt = timetableStore;
  if (tt != null) two.add(_job(() => tt.current(campus)));
  for (final c in taking) {
    two.add(
      _job(() async {
        // A course with a CR needs no volunteer offer.
        final people = await contacts.directory(campus);
        final now = DateTime.now();
        final hasCr = people.any(
          (p) => p
              .liveAt(now)
              .any((r) => r.role == GrantRole.course && r.scope == c),
        );
        return hasCr ? null : contacts.myOffer(campus, c);
      }),
    );
  }
  final store = resourceStore;
  if (store != null) {
    for (final code in programmesOf(selecteddiscipline)) {
      if (departmentOfProgramme(code) case final dept?) {
        two.add(_job(() => store.department(campus, dept)));
      }
    }
  }
  two.add(_job(() => roles.publicContact()));
  // More shows the board and my contributor state on open.
  if (leaderboardStore case final lb?) two.add(_job(() => lb.of(campus)));
  two.add(_job(loadMyContrib));

  for (final c in taking) {
    three.add(_job(() => reviews.page(c, campus)));
    three.add(_job(() => reviews.byProfessor(c, campus)));
    final off = cachedOffering(c, campus, term);
    for (final id in off?.professors ?? const <String>[]) {
      three.add(_job(() => ProfessorStore(roles.db).get(id)));
    }
  }

  final four = <Future<void> Function()>[_job(prefetchPresidentPages)];
  // Warm what each place I reach will open (a reach entry per place).
  for (final c in {
    for (final x in me.reach(Capability.reviewGateSwitch))
      if (x.campus != 'all') x.campus,
  }) {
    four.add(_job(() => gateInfo(c)));
  }
  if (me.reach(Capability.reviewGateSwitch).any((x) => x.campus == 'all')) {
    four.add(_job(() => gateInfo(campus)));
  }
  // The approvals queue of each department I approve for.
  if (contributorStore case final cs?) {
    for (final x in me.reach(Capability.approveContributors)) {
      final dept = x.dept;
      if (x.campus == 'all' || dept == null || dept == 'all') continue;
      if (store case final rs?) {
        four.add(_job(() => rs.pending(x.campus, dept)));
      }
      four.add(_job(() => cs.requests(x.campus, dept)));
    }
  }
  final maintain = MaintainStore(roles);
  for (final x in me.reach(Capability.averages)) {
    if (x.course case final course?) {
      four.add(_job(() => maintain.offering(course, campus, term)));
    }
  }
  if (me.reach(Capability.readAuditAndRoster).any((x) => x.campus == 'all')) {
    four.add(_job(() => roles.roster()));
  }
  if (me.reach(Capability.addRemoveOwners).isNotEmpty) {
    four.add(_job(() => roles.owners()));
  }
  if (me.reach(Capability.grantTermsCrPresident).isNotEmpty) {
    four.add(_job(() => roles.terms()));
  }
  if (me.reach(Capability.publish).isNotEmpty) {
    final analytics = AnalyticsStore(roles.db);
    four
      ..add(_job(() => analytics.counts()))
      ..add(_job(() => analytics.days(30)));
  }
  return [two, three, four];
}
