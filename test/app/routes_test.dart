import 'dart:io';

import 'package:cgpa_calculator/admin/roster.dart';
import 'package:cgpa_calculator/app/router.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_defs.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/script.dart';
import 'package:cgpa_calculator/shared/widgets/not_found_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:go_router/go_router.dart';

void main() {
  final sources = [
    for (final line in File('landing/_redirects').readAsLinesSync())
      if (line.trim().isNotEmpty && !line.startsWith('#'))
        line.trim().split(RegExp(r'\s+')).first,
  ];

  // Top-level segments under Home: 'stats', 'course' (from 'course/:id')…
  final home = appRoutes.first as GoRoute;
  final segments = [
    for (final r in home.routes.whereType<GoRoute>()) r.path.split('/').first,
  ];

  test('every top-level route segment has a _redirects line', () {
    expect(segments, isNotEmpty);
    for (final s in segments) {
      final hasChildren = home.routes.whereType<GoRoute>().any(
        (r) => r.path.startsWith('$s/'),
      );
      final route = home.routes.whereType<GoRoute>().firstWhere(
        (r) => r.path.split('/').first == s,
      );
      final nested = route.routes.isNotEmpty;
      expect(
        sources,
        contains(hasChildren || nested ? '/calculator/$s/*' : '/calculator/$s'),
        reason:
            'deep links to /calculator/$s need a line in landing/_redirects',
      );
      // A page with pages beneath it needs its own line as well: `/x/*`
      // does not match `/x`.
      if (nested) expect(sources, contains('/calculator/$s'));
    }
  });

  test('every tab path has a _redirects line', () {
    for (final r in appRoutes.skip(1).whereType<GoRoute>()) {
      expect(sources, contains('/calculator${r.path}'));
    }
  });

  test('old and bare paths move: / to the last tab, More pages under /more',
      () {
    selectedprofile = 3;
    expect(movedPath(Uri.parse('/')), '/compare');
    expect(movedPath(Uri.parse('/reviews/CS%20F372?professor=p1')),
        '/more/reviews/CS%20F372?professor=p1');
    expect(movedPath(Uri.parse('/resources/degree/A7')), '/more/resources/A7');
    expect(movedPath(Uri.parse('/resources/course/CS%20F372')),
        '/more/resources/CS%20F372');
    expect(movedPath(Uri.parse('/contribute')), '/more/contribute');
    expect(movedPath(Uri.parse('/more/reviews')), isNull);
    expect(movedPath(Uri.parse('/stats')), isNull);
    selectedprofile = 1;
  });

  test('no catch-all rule rewrites the app\'s own files', () {
    expect(sources, isNot(contains('/calculator/*')));
    expect(sources.where((s) => s.startsWith('/calculator/:')), isEmpty);
  });

  group('T3.4: router error page and the volunteers route', () {
    setUp(() => myRoles.value = MyRoles.none);
    tearDown(() => myRoles.value = MyRoles.none);

    // The real 'admin' GoRoute, re-rooted straight under '/': every screen
    // is nested under Home in the live app (see router.dart's own comment),
    // so pumping appRoutes as-is always mounts MyHomePage too, which needs
    // FirebaseAuth.instance and has no fake in this harness. Re-rooting
    // reuses the same route/redirect/builder objects the router.dart wires,
    // just without Home in the stack.
    testWidgets(
      '/admin/roster/volunteers resolves to RosterPage with initialVolunteers',
      (t) async {
        myRoles.value = const MyRoles(email: 'owner@example.com', owner: true);
        final admin = home.routes.whereType<GoRoute>().firstWhere(
          (r) => r.path == 'admin',
        );
        final router = GoRouter(
          initialLocation: '/admin/roster/volunteers',
          routes: [
            GoRoute(
              path: '/admin',
              redirect: admin.redirect,
              builder: admin.builder,
              routes: admin.routes,
            ),
          ],
        );
        await t.pumpWidget(MaterialApp.router(routerConfig: router));
        await t.pumpAndSettle();
        final page = t.widget<RosterPage>(find.byType(RosterPage));
        expect(page.initialVolunteers, isTrue);
      },
    );

    testWidgets('/nope builds NotFoundPage', (t) async {
      final router = GoRouter(
        routes: appRoutes,
        initialLocation: '/nope',
        errorBuilder: (_, _) => const NotFoundPage(),
      );
      await t.pumpWidget(MaterialApp.router(routerConfig: router));
      await t.pumpAndSettle();
      expect(find.byType(NotFoundPage), findsOneWidget);
    });
  });

  group('B8: routes ask for their capability', () {
    setUp(() => myRoles.value = MyRoles.none);
    tearDown(() => myRoles.value = MyRoles.none);

    const goa = 'f20230001@goa.bits-pilani.ac.in';

    MyRoles holder(Set<Capability> caps, {String dept = 'ELEC'}) => MyRoles(
      email: goa,
      defs: RoleDefs({
        ...RoleDefs.defaults().byId,
        'r': RoleDef(
          id: 'r',
          name: 'R',
          tag: 'ROLE',
          caps: caps,
          termDays: 100,
          builtin: false,
          campus: 'goa',
          dept: dept,
        ),
      }),
      custom: Grant(
        role: GrantRole.custom,
        email: goa,
        name: 'X',
        campus: 'all',
        scope: 'role',
        active: true,
        expiresAt: DateTime(2100),
        roleId: 'r',
      ),
    );

    /// Where [path] lands: the admin and maintain routes with their real
    /// redirects, under '/', each page an empty box.
    Future<String> land(WidgetTester t, String path) async {
      GoRoute stub(GoRoute r, {String? as}) => GoRoute(
        path: as ?? r.path,
        redirect: r.redirect,
        builder: (_, _) => const SizedBox(),
        routes: [for (final c in r.routes.whereType<GoRoute>()) stub(c)],
      );
      final all = home.routes.whereType<GoRoute>();
      final router = GoRouter(
        initialLocation: path,
        errorBuilder: (_, _) => const SizedBox(),
        routes: [
          stub(all.firstWhere((r) => r.path == 'admin'), as: '/admin'),
          for (final r in all.where((r) => r.path.startsWith('maintain/')))
            stub(r, as: '/${r.path}'),
        ],
      );
      await t.pumpWidget(MaterialApp.router(routerConfig: router));
      await t.pumpAndSettle();
      return router.routerDelegate.currentConfiguration.uri.path;
    }

    testWidgets('a president keeps today\'s Controls access (M4)', (t) async {
      myRoles.value = MyRoles(
        email: goa,
        grants: [
          Grant(
            role: GrantRole.dept,
            email: goa,
            name: 'P',
            campus: 'goa',
            scope: 'ELEC',
            active: true,
            expiresAt: DateTime(2100),
          ),
        ],
      );
      for (final p in [
        '/admin/people',
        '/admin/approvals',
        '/admin/course-tools',
        '/admin/reviews',
      ]) {
        expect(await land(t, p), '/', reason: p);
      }
      for (final p in ['/admin/grant', '/admin/roster', '/admin/audit']) {
        expect(await land(t, p), p, reason: p);
      }
    });

    testWidgets(
      'a custom holder with averages at goa|ELEC opens Course tools and the '
      'ELEC course screen, not Reviews',
      (t) async {
        myRoles.value = holder({Capability.averages});
        expect(await land(t, '/admin/course-tools'), '/admin/course-tools');
        expect(
          await land(t, '/maintain/goa/course/EEE%20F111'),
          '/maintain/goa/course/EEE%20F111',
        );
        expect(await land(t, '/admin/reviews'), isNot('/admin/reviews'));
        expect(
          await land(t, '/maintain/goa/course/CS%20F111'),
          isNot('/maintain/goa/course/CS%20F111'),
        );
      },
    );

    testWidgets(
      'a custom holder without readAuditAndRoster is redirected from the '
      'roster',
      (t) async {
        myRoles.value = holder({Capability.averages});
        expect(await land(t, '/admin/roster'), isNot('/admin/roster'));
        expect(await land(t, '/admin/audit'), isNot('/admin/audit'));
        myRoles.value = holder({Capability.readAuditAndRoster});
        expect(await land(t, '/admin/roster'), '/admin/roster');
      },
    );

    testWidgets('owner-only screens stay closed to an admin', (t) async {
      final admin = Grant(
        role: GrantRole.admin,
        email: goa,
        name: 'A',
        campus: 'all',
        scope: 'all',
        active: true,
        expiresAt: DateTime(2100),
      );
      myRoles.value = MyRoles(email: goa, grants: [admin]);
      expect(await land(t, '/admin/people'), '/admin/people');
      expect(await land(t, '/admin/owners'), isNot('/admin/owners'));
      expect(await land(t, '/admin/publish'), isNot('/admin/publish'));
      expect(await land(t, '/admin/open-as'), isNot('/admin/open-as'));
    });
  });
}
