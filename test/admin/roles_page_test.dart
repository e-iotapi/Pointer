// Task B10: Controls › Roles (RolesPage, RoleEditor).
import 'dart:io';

import 'package:cgpa_calculator/admin/admin_home.dart';
import 'package:cgpa_calculator/admin/roles_page.dart';
import 'package:cgpa_calculator/app/theme/palette.dart';
import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/course.dart';
import 'package:cgpa_calculator/core/storage/courses.dart';
import 'package:cgpa_calculator/shared/widgets/card_row.dart';
import 'package:cgpa_calculator/shared/widgets/app_text_field.dart';
import 'package:cgpa_calculator/shared/widgets/pill_button.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:hive_ce/hive.dart';

const _ownerMail = 'owner@example.com';
const _adminMail = 'f20200001@pilani.bits-pilani.ac.in';
final _far = DateTime.now().add(const Duration(days: 100));

void main() {
  late Directory dir;
  late FakeFirebaseFirestore db;

  setUpAll(() async {
    dir = await Directory.systemTemp.createTemp('hive_roles_page');
    Hive.init(dir.path);
    if (!Hive.isAdapterRegistered(0)) Hive.registerAdapter(CourseAdapter());
    await Hive.openBox<Course>(coursesBoxName);
  });

  tearDownAll(() async {
    await Hive.close();
    await dir.delete(recursive: true);
  });

  setUp(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.physicalSize = const Size(800, 3600);
    view.devicePixelRatio = 1;
    db = FakeFirebaseFirestore();
  });

  tearDown(() {
    final view =
        TestWidgetsFlutterBinding.instance.platformDispatcher.views.first;
    view.resetPhysicalSize();
    view.resetDevicePixelRatio();
    roleStore = null;
    myRoles.value = MyRoles.none;
  });

  void signIn(String email, {bool owner = false}) {
    roleStore = RoleStore(db, me: email, myName: 'Me');
    myRoles.value = MyRoles(
      email: email,
      owner: owner,
      grants:
          owner
              ? const []
              : [
                Grant(
                  role: GrantRole.admin,
                  email: email,
                  name: 'Ad Min',
                  campus: 'all',
                  scope: 'all',
                  active: true,
                  expiresAt: _far,
                ),
              ],
    );
  }

  Future<void> open(WidgetTester t, Widget page) async {
    await t.pumpWidget(const SizedBox());
    await t.pumpWidget(
      MaterialApp(theme: AppPalette.light.materialTheme, home: page),
    );
    await t.pumpAndSettle();
  }

  Checkbox tick(WidgetTester t, String label) => t.widget<Checkbox>(
    find.descendant(
      of: find.ancestor(of: find.text(label), matching: find.byType(CardRow)),
      matching: find.byType(Checkbox),
    ),
  );

  Future<String> seedRole({List<Capability>? caps}) =>
      roleStore!.saveCustomRole(
        name: 'Resources lead',
        caps: (caps ?? [Capability.departmentResources]).toSet(),
        termDays: 365,
        campus: 'goa',
        dept: 'ELEC',
      );

  testWidgets('an admin sees Admin/President/CR read-only and can create a '
      'custom role', (t) async {
    signIn(_adminMail);
    await open(t, const RolesPage());
    expect(find.text('Owner'), findsOneWidget);
    expect(find.text('Admin'), findsOneWidget);
    expect(find.text('Department president'), findsOneWidget);
    expect(find.text('Course manager'), findsOneWidget);
    expect(find.text('+ New role'), findsOneWidget);

    await open(t, const RoleEditor(id: 'president'));
    expect(tick(t, 'Moderate reviews').onChanged, isNull);

    await open(t, const RoleEditor(id: 'new'));
    await t.enterText(find.byType(EditableText).first, 'Reviews lead');
    await t.tap(find.text('Moderate reviews'));
    await t.pump();
    await t.tap(find.text('Save role'));
    await t.pumpAndSettle();
    final saved = (await db.collection('roles').get()).docs.single.data();
    expect(saved['name'], 'Reviews lead');
    expect(saved['caps'], ['moderateReviews']);
  });

  testWidgets('the owner edits President\'s ticks, and the first save keeps '
      'the terms in config/grantTerms', (t) async {
    signIn(_ownerMail, owner: true);
    await db.collection('config').doc('grantTerms').set({
      'crDays': 182,
      'presidentDays': 400,
      'adminDays': 1095,
    });
    await open(t, const RoleEditor(id: 'president'));
    expect(tick(t, 'Moderate reviews').value, isTrue);
    await t.tap(find.text('Moderate reviews'));
    await t.pump();
    expect(tick(t, 'Moderate reviews').value, isFalse);
    await t.tap(find.text('Save'));
    await t.pumpAndSettle();
    final b = (await db.collection('roles').doc('builtin').get()).data()!;
    expect((b['president'] as Map)['caps'], isNot(contains('moderateReviews')));
    expect((b['president'] as Map)['termDays'], 400);
    expect((b['cr'] as Map)['termDays'], 182);
    expect((b['admin'] as Map)['termDays'], 1095);
  });

  testWidgets('an admin cannot set a term before roles/builtin exists', (
    t,
  ) async {
    signIn(_adminMail);
    await open(t, const RoleEditor(id: 'cr'));
    expect(find.byIcon(Icons.lock_outline_rounded), findsOneWidget);
    expect(
      find.textContaining('An owner must open Roles once'),
      findsOneWidget,
    );
  });

  testWidgets('a row the author lacks is disabled', (t) async {
    signIn(_adminMail);
    await open(t, const RoleEditor(id: 'new'));
    expect(tick(t, 'Appoint / revoke admins').onChanged, isNull);
    expect(find.text('YOU LACK IT'), findsWidgets);
    expect(tick(t, 'Moderate reviews').onChanged, isNotNull);
  });

  testWidgets('each row has an (i) that explains it without ticking it', (
    t,
  ) async {
    signIn(_ownerMail, owner: true);
    await open(t, const RoleEditor(id: 'new'));
    expect(
      find.byIcon(Icons.info_outline_rounded),
      findsAtLeastNWidgets(Capability.values.length),
    );
    final info = find.byTooltip(Capability.moderateReviews.help);
    await t.ensureVisible(info);
    await t.tap(info);
    await t.pump(const Duration(milliseconds: 300));
    expect(find.text(Capability.moderateReviews.help), findsOneWidget);
    expect(tick(t, 'Moderate reviews').value, isFalse);
    await t.pump(const Duration(seconds: 5));
  });

  testWidgets('ticking Averages ticks and locks Course structures', (t) async {
    signIn(_ownerMail, owner: true);
    await open(t, const RoleEditor(id: 'new'));
    await t.tap(find.text('Averages — course, component, part'));
    await t.pump();
    expect(tick(t, 'Course structures, eval schemes').value, isTrue);
    expect(tick(t, 'Course structures, eval schemes').onChanged, isNull);
    expect(
      find.textContaining('Averages live inside the eval scheme'),
      findsOneWidget,
    );
  });

  testWidgets('delete is disabled while a holder is live', (t) async {
    signIn(_ownerMail, owner: true);
    final id = await seedRole();
    final g = Grant(
      role: GrantRole.custom,
      email: 'f20230001@goa.bits-pilani.ac.in',
      name: 'Holder',
      campus: 'goa',
      scope: 'role',
      active: true,
      expiresAt: _far,
      roleId: id,
    );
    await db.collection('grants').doc(g.id).set(g.toMap());
    await open(t, RoleEditor(id: id));
    expect(find.text('Revoke its 1 holder first'), findsOneWidget);
    expect(
      t
          .widget<PillButton>(find.widgetWithText(PillButton, 'Delete role'))
          .onPressed,
      isNull,
    );
  });

  testWidgets('a saved role appears with 0 holders', (t) async {
    signIn(_ownerMail, owner: true);
    await seedRole();
    await open(t, const RolesPage());
    expect(find.text('Resources lead'), findsOneWidget);
    expect(find.text('0'), findsWidgets);
    expect(find.byType(PrimaryButton), findsOneWidget);
  });

  testWidgets('Controls: Roles replaces Grant terms', (t) async {
    signIn(_ownerMail, owner: true);
    await open(t, const AdminHome());
    expect(find.text('Roles'), findsOneWidget);
    expect(
      find.text('What each role may do, its scope and term'),
      findsOneWidget,
    );
    expect(find.text('Grant terms'), findsNothing);
  });
}
