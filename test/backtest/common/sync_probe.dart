// users/{uid} sync, common to both builds (sync.dart, course.dart and the
// models are byte-identical; run.mjs checks that by diff, this proves it).
import 'dart:io';

import 'package:cgpa_calculator/core/models/marks.dart';
import 'package:cgpa_calculator/course.dart';
import 'package:cgpa_calculator/sync.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:hive_ce/hive.dart';

/// A student's data as the app keeps it, written into the synced boxes.
Future<void> fillBoxes() async {
  await Hive.box('settingsBox').putAll({
    'batch': 22,
    'discipline': 'B3A7',
    'campus': 'goa',
    'unknownFutureKey': {
      'a': [1, 2, 3],
    },
  });
  final cs = Hive.box<Course>('coursesBox');
  await cs.put(
    'CS F111',
    Course(
      title: 'Computer Programming',
      sem: '1 - 1',
      id: 'CS F111',
      grade1: 8,
      grade2: 9,
      discipline: 'B3A7',
      credits: 4,
      elective: 'CDC',
      more: {3: 7},
    ),
  );
  await cs.put(
    'ECON F211',
    Course(
      title: 'Principles of Economics',
      sem: '2 - 1',
      id: 'ECON F211',
      grade1: -2,
      grade2: -2,
      discipline: 'B3A7',
      credits: 3,
      elective: 'HUEL',
    ),
  );
}

/// Opens boxes on a temp dir with a fake Firestore; returns a cleanup.
Future<Future<void> Function()> openSyncEnv(FakeFirebaseFirestore db) async {
  final dir = await Directory.systemTemp.createTemp('bt_sync');
  Hive.init(dir.path);
  if (!Hive.isAdapterRegistered(0)) Hive.registerAdapter(CourseAdapter());
  registerMarksAdapters();
  await Sync.openBoxes();
  Sync.db = db;
  return () async {
    await Sync.stop();
    Sync.db = null;
    await Hive.close();
    await dir.delete(recursive: true);
  };
}
