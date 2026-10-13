import 'package:cgpa_calculator/core/resources/link_search.dart';
import 'package:cgpa_calculator/core/resources/resource.dart';
import 'package:flutter_test/flutter_test.dart';

Resource _r(
  String id,
  String title, {
  String dept = 'CS',
  List<String> c = const [],
}) => Resource(
  id: id,
  title: title,
  url: 'https://drive.google.com/$id',
  campus: 'goa',
  department: dept,
  scope: c.isEmpty ? 'department' : 'course',
  courseIds: c,
);

void main() {
  final links = [
    _r('a', 'Previous year questions 2024', c: ['CS F372']),
    _r('b', 'Lecture slides', c: ['CS F372']),
    _r('c', 'Thermo notes', dept: 'ME', c: ['ME F214']),
  ];
  List<String> find(
    String q, [
    Map<String, Map<String, int>> learned = const {},
  ]) => [
    for (final r in searchLinks(
      links,
      q,
      also: alsoSearch(q, learned),
      courseTitle:
          (c) => c == 'CS F372' ? 'Operating Systems' : 'Thermodynamics',
      departmentName: (d) => d == 'CS' ? 'Computer Science' : 'Mechanical',
    ))
      r.id,
  ];

  test('names, courses, departments and one typo', () {
    expect(find('slides'), ['b', 'c']); // notes mean slides too
    expect(find('operating'), ['a', 'b']);
    expect(find('cs f372'), ['a', 'b']);
    expect(find('mechanical'), ['c']);
    expect(find('previuos'), ['a']);
    expect(find('zebra'), isEmpty);
  });

  test('built-in synonyms widen the search', () {
    expect(find('pyq'), ['a']);
    expect(find('notes'), ['c', 'b']);
  });

  // Relevance (owner, 2026-10-13): a taught pair shows from 5, built-in
  // synonyms start at 100 and hide below 0, most relevant first.
  test('a taught pair shows at relevance five, both ways', () {
    expect(find('opsys'), isEmpty);
    expect(
      find('opsys', {
        'opsys': {'operating': 4},
      }),
      isEmpty,
    );
    expect(
      find('opsys', {
        'opsys': {'operating': 5},
      }),
      ['a', 'b'],
    );
    expect(
      alsoSearch('operating', {
        'opsys': {'operating': 5},
      }),
      ['opsys'],
    );
    // Both directions' counts add up.
    expect(
      alsoSearch('opsys', {
        'opsys': {'operating': 3},
        'operating': {'opsys': 2},
      }),
      ['operating'],
    );
  });

  test('the most relevant pairs come first', () {
    expect(
      alsoSearch('opsys', {
        'opsys': {'thermo': 6, 'operating': 40},
      }),
      ['operating', 'thermo'],
    );
    // A built-in synonym students skip sinks below the rest.
    expect(
      alsoSearch('pyq', {
        'pyq': {'pyqs': -50},
      }),
      ['previous year', 'question paper', 'past paper', 'pyqs'],
    );
  });

  test('a built-in synonym hides below zero, a taught pair below five', () {
    expect(
      alsoSearch('pyq', {
        'pyq': {'past paper': -100},
      }),
      contains('past paper'),
    );
    expect(
      alsoSearch('pyq', {
        'pyq': {'past paper': -101},
      }),
      isNot(contains('past paper')),
    );
    expect(
      alsoSearch('opsys', {
        'opsys': {'operating': 12},
        'operating': {'opsys': -8},
      }),
      isEmpty,
    );
  });

  test('queries are cleaned the same way', () {
    expect(normQuery('  PYQs!!  2024 '), 'pyqs 2024');
    expect(normQuery('x' * 50).length, 40);
  });

  test('every search box: hel finds HSS and GS courses, typos still hit', () {
    expect(alsoSearch('hel', const {}), containsAll(['hss', 'gs']));
    expect(textMatches('hss', 'HSS F222 Linguistics'), isTrue);
    expect(textMatches('gs', 'GS F211 Modern Political Concepts'), isTrue);
    expect(textMatches('S F37', 'CS F372 Operating Systems'), isTrue);
    expect(textMatches('opertaing', 'CS F372 Operating Systems'), isTrue);
    expect(textMatches('zebra', 'CS F372 Operating Systems'), isFalse);
  });
}
