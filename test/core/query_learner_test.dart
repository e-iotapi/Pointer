import 'package:cgpa_calculator/core/roles/role_store.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/core/search/hints.dart';
import 'package:fake_cloud_firestore/fake_cloud_firestore.dart';
import 'package:flutter_test/flutter_test.dart';

import '../helpers/fake_seed.dart';

// Relevance votes (owner, 2026-10-13): a pick moves the pair it came from
// up; a pair whose results were passed over for another search moves down.
void main() {
  const links = {
    'lab1': 'OS lab sheets',
    'p1': 'Practical guide',
    'pp': 'Past paper 2023',
    'pp2': 'Past paper 2022',
    'end': 'Endsem 2024',
  };
  late FakeFirebaseFirestore db;
  late QueryLearner learner;

  setUp(() {
    db = FakeFirebaseFirestore();
    roleStore = RoleStore(db, me: As.student.email, myName: 'Priya');
    learner = QueryLearner();
  });
  tearDown(() => learner.dispose());

  void search(String q) => learner.widen(
    q,
    (ph) => [
      for (final e in links.entries)
        if (textMatches(ph, e.value)) e.key,
    ],
    (id) => id,
  );
  Future<void> settle() => Future.delayed(const Duration(milliseconds: 900));
  Future<Map?> votes() async {
    await Future<void>.delayed(Duration.zero);
    return (await db.collection('searchHints').doc('goa').get()).data()?['q']
        as Map?;
  }

  test(
    'a pick through a synonym moves it up; a typed match votes nothing',
    () async {
      search('practical');
      learner.picked('p1');
      expect(await votes(), isNull);
      search('practical');
      learner.picked('lab1');
      expect(await votes(), {
        'practical': {'lab': 1},
      });
    },
  );

  test('a synonym passed over for another search moves down', () async {
    search('pyq');
    await settle();
    search('endsem');
    learner.picked('end');
    expect(await votes(), {
      'pyq': {'past paper': -1},
    });
  });

  test('searching the synonym next counts for it, not against it', () async {
    search('pyq');
    await settle();
    search('past paper 2022');
    learner.picked('pp2');
    expect(await votes(), {
      'pyq': {'past paper': 1},
    });
  });

  test('a search not left alone is not a previous one', () async {
    search('pyq');
    search('endsem');
    learner.picked('end');
    expect(await votes(), isNull);
  });

  test('a search that found nothing teaches the next pick', () async {
    search('zzqq');
    await settle();
    search('endsem');
    learner.picked('end');
    expect(await votes(), {
      'zzqq': {'endsem': 1},
    });
  });
}
