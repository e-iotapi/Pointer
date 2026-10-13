import 'dart:async';

import 'package:cgpa_calculator/core/cache/cache_first.dart';
import 'package:cgpa_calculator/core/roles/session.dart';
import 'package:cgpa_calculator/core/roles/roles.dart';
import 'package:cgpa_calculator/core/storage/cache_boxes.dart';
import 'package:cloud_firestore/cloud_firestore.dart';
import 'package:hive_ce/hive.dart';

/// Search that learns (owner, 2026-10-06), for every search box: a query is
/// widened by a few built-in synonyms and by what students taught it. Each
/// pair keeps a relevance count (owner, 2026-10-13): +1 when a student picks
/// what it found, -1 when they passed its results over and found what they
/// wanted with another search. The most relevant pairs come first and the
/// rest drop out.

/// Lower case, letters and digits only, single spaces, at most 40.
String normQuery(String s) {
  final t = cleanText(s);
  return t.length <= 40 ? t : t.substring(0, 40).trim();
}

String cleanText(String s) =>
    s.toLowerCase().replaceAll(RegExp(r'[^a-z0-9]+'), ' ').trim();

/// Phrases that mean the same, built in so search helps from day one.
const _seeds = [
  ['pyq', 'pyqs', 'previous year', 'question paper', 'past paper'],
  ['notes', 'slides', 'lecture', 'ppt'],
  ['tut', 'tutorial'],
  ['lab', 'practical'],
  ['book', 'textbook', 'reference'],
  ['handout', 'course handout'],
  ['os', 'operating systems'],
  ['dsa', 'data structures'],
  ['ml', 'machine learning'],
  ['hel', 'humanities', 'hss', 'gs'],
  ['del', 'discipline elective'],
  ['oel', 'open elective'],
];

/// A built-in pair's starting relevance: it shows until students skip it
/// a hundred times more than they use it.
const seedRelevance = 100;

/// Relevance a taught pair needs to show. One bar both ways (owner,
/// 2026-10-13): a pair that sinks below it hides until it climbs back.
const learnedShowAt = 5;

/// What else [query] should find, most relevant first: the built-in
/// synonyms (shown from 0 up) and the taught pairs either way (shown from
/// [learnedShowAt] up). A pair's relevance is both directions' counts.
List<String> alsoSearch(String query, Map<String, Map<String, int>> learned) {
  final q = normQuery(query);
  if (q.isEmpty) return const [];
  int stored(String p) => (learned[q]?[p] ?? 0) + (learned[p]?[q] ?? 0);
  final seeded = {
    for (final group in _seeds)
      if (group.contains(q)) ...group,
  }..remove(q);
  final taught = {
    ...?learned[q]?.keys,
    for (final e in learned.entries)
      if (e.value.containsKey(q)) e.key,
  }..removeAll({q, ...seeded});
  final score = {
    for (final p in seeded) p: seedRelevance + stored(p),
    for (final p in taught) p: stored(p),
  };
  final shown = [
    for (final e in score.entries)
      if (e.value >= (seeded.contains(e.key) ? 0 : learnedShowAt)) e.key,
  ];
  // Ties keep the built-in order (List.sort is not stable).
  final order = {for (final (i, p) in shown.indexed) p: i};
  return shown..sort(
    (a, b) =>
        score[a] == score[b]
            ? order[a]!.compareTo(order[b]!)
            : score[b]!.compareTo(score[a]!),
  );
}

/// Within one edit (add, drop, change or swap two letters) of each other.
bool _near(String a, String b) {
  if ((a.length - b.length).abs() > 1) return false;
  var i = 0, j = 0, edits = 0;
  while (i < a.length && j < b.length) {
    if (a[i] == b[j]) {
      i++;
      j++;
      continue;
    }
    if (++edits > 1) return false;
    if (a.length > b.length) {
      i++;
    } else if (b.length > a.length) {
      j++;
    } else if (i + 1 < a.length && a[i] == b[j + 1] && a[i + 1] == b[j]) {
      i += 2;
      j += 2;
    } else {
      i++;
      j++;
    }
  }
  return edits + (a.length - i) + (b.length - j) <= 1;
}

/// Whether every word of [phrase] is in [words] (`all` joined): a word starts with it, or
/// (four letters and up) contains it or is one typo from it.
bool matchesWords(String phrase, List<String> words, String all) => phrase
    .split(' ')
    .every(
      (t) =>
          words.any((w) => w.startsWith(t)) ||
          (t.length >= 4 && (all.contains(t) || words.any((w) => _near(t, w)))),
    );

/// Whether [text] has [phrase]: as typed, or word by word (prefixes, one
/// typo).
bool textMatches(String phrase, String text) {
  final t = text.toLowerCase(), q = phrase.trim().toLowerCase();
  if (q.isEmpty) return false;
  if (t.contains(q)) return true;
  final n = normQuery(q), all = cleanText(t);
  return n.isNotEmpty && matchesWords(n, all.split(' '), all);
}

/// The learned pairs of a campus: `searchHints/{campus}` holds
/// `q: {query: {otherQuery: votes}}`, and `k`/`t` name the pair a write
/// moved (firestore.rules checks one +1 at a time).
class SearchHints {
  SearchHints(this._db, {Box? device}) : _device = device;
  final FirebaseFirestore _db;
  final Box? _device;

  DocumentReference<Map<String, dynamic>> _doc(String campus) =>
      _db.collection('searchHints').doc(campus);

  static Map<String, Map<String, int>> _decode(Object? o) => {
    for (final e in ((o as Map?) ?? const {}).entries)
      '${e.key}': {
        for (final a in (e.value as Map).entries)
          '${a.key}': (a.value as num).toInt(),
      },
  };

  /// Read at most every 3 hours: new pairs need no rush.
  Future<Map<String, Map<String, int>>> load(String campus) =>
      cacheFirst<Map<String, Map<String, int>>>(
        key: 'hints|$campus',
        maxAge: const Duration(hours: 3),
        fetch: () async => _decode((await _doc(campus).get()).data()?['q']),
        encode: (m) => m,
        decode: _decode,
      );

  Map<String, Map<String, int>>? peek(String campus) =>
      peekCache('hints|$campus', _decode);

  Box? get _box =>
      _device ??
      (Hive.isBoxOpen(deviceBoxName) ? Hive.box(deviceBoxName) : null);

  /// Moves "[from] means [to]" by [by] (+1 or -1), each way once per
  /// device per pair. Failures are dropped: a lost vote costs nothing.
  Future<void> learn(
    String campus,
    String from,
    String to, [
    int by = 1,
  ]) async {
    final a = normQuery(from), b = normQuery(to);
    if (a.isEmpty || b.isEmpty || a == b) return;
    final mark = 'hint|$campus|$a|$b${by > 0 ? '' : '|down'}';
    if (_box?.get(mark) == true) return;
    await _box?.put(mark, true);
    try {
      await _doc(campus).set({
        'q': {
          a: {b: FieldValue.increment(by > 0 ? 1 : -1)},
        },
        'k': a,
        't': b,
      }, SetOptions(merge: true));
    } on Object {
      // ponytail: the campus list is capped at 500 queries; past it new
      // ones are refused, prune old ones if it fills.
    }
  }
}

/// The signed-in campus's learned pairs, loaded once a session.
Map<String, Map<String, int>> _learned = const {};
String? _loadedFor;

/// Off in widget tests: the load's cache write would stall under fake time
/// and hold the next test's storage.
bool loadSearchHints = true;

void _warm() {
  if (!loadSearchHints) return;
  final store = roleStore;
  final campus = store == null ? null : campusOfAddress(store.me);
  if (store == null || campus == null || campus == _loadedFor) return;
  _loadedFor = campus;
  final hints = SearchHints(store.db);
  _learned = hints.peek(campus) ?? const {};
  hints.load(campus).then((h) => _learned = h, onError: (Object _) {});
}

/// [query] and what else it should find; the query itself first, as typed.
List<String> queryPhrases(String query) {
  if (normQuery(query).isEmpty) return const [];
  _warm();
  return [query, ...alsoSearch(query, _learned)];
}

/// [find] run for every phrase of [query], each result once, in order.
List<T> widen<T>(
  String query,
  Iterable<T> Function(String phrase) find,
  Object? Function(T) key,
) => [for (final (x, _) in _widen(query, find, key)) x];

/// [widen] with the phrase each result came from.
List<(T, String)> _widen<T>(
  String query,
  Iterable<T> Function(String phrase) find,
  Object? Function(T) key,
) {
  final seen = <Object?>{};
  return [
    for (final phrase in queryPhrases(query))
      for (final x in find(phrase))
        if (seen.add(key(x))) (x, normQuery(phrase)),
  ];
}

/// Rows of a search that count as seen: what fits a screen.
const _seenRows = 6;

/// One search: its rows, as (result key, phrase it came from).
class _Search {
  _Search(this.q);
  final String q;
  List<(Object?, String)> rows = const [];

  /// When it was left alone long enough to count; null while typing.
  DateTime? settled;

  String? from(Object? key) => rows.where((r) => r.$1 == key).firstOrNull?.$2;

  /// Each pair's results in the first rows: the ones a student saw.
  Map<String, Set<Object?>> get shown {
    final out = <String, Set<Object?>>{};
    for (final (k, ph) in rows.take(_seenRows)) {
      if (ph != q) (out[ph] ??= {}).add(k);
    }
    return out;
  }
}

/// One search box's memory of its current and previous search, which turns
/// a pick into relevance votes.
class QueryLearner {
  _Search? _cur, _prev;
  Timer? _settle;

  /// [widen] that remembers where each result came from.
  List<T> widen<T>(
    String query,
    Iterable<T> Function(String phrase) find,
    Object? Function(T) key,
  ) {
    final rows = _widen(query, find, key);
    saw(query, [for (final (x, ph) in rows) (key(x), ph)]);
    return [for (final (x, _) in rows) x];
  }

  /// The rows [query] shows, as (result key, phrase it came from). A search
  /// left alone 800 ms becomes the previous one when the query changes.
  void saw(String query, List<(Object?, String)> rows) {
    final q = normQuery(query);
    if (q.isEmpty) return;
    if (_cur?.q != q) {
      if (_cur?.settled != null) _prev = _cur;
      final s = _cur = _Search(q);
      _settle?.cancel();
      _settle = Timer(
        const Duration(milliseconds: 800),
        () => s.settled = DateTime.now(),
      );
    }
    _cur!.rows = rows;
  }

  /// The result [key] was picked. +1 for the pair it came from. Within a
  /// minute of a previous search: +1 for "previous means this" if that one
  /// found nothing, and each pair it showed gets +1 if it held the pick (or
  /// is what the student searched next), -1 if it was passed over. A pick
  /// of the typed words' own match never votes down.
  void picked(Object? key) {
    final cur = _cur, prev = _prev;
    _cur = _prev = null;
    _settle?.cancel();
    if (cur == null) return;
    final from = cur.from(key);
    final votes = <(String, String, int)>[
      if (from != null && from != cur.q) (cur.q, from, 1),
    ];
    final at = prev?.settled;
    if (prev != null &&
        at != null &&
        prev.q != cur.q &&
        DateTime.now().difference(at) <= const Duration(minutes: 1)) {
      if (prev.rows.isEmpty) votes.add((prev.q, cur.q, 1));
      for (final MapEntry(key: ph, value: keys) in prev.shown.entries) {
        final held = keys.contains(key) || ph == cur.q || ph == from;
        votes.add((prev.q, ph, held ? 1 : -1));
      }
    }
    final store = roleStore;
    final campus = store == null ? null : campusOfAddress(store.me);
    if (store == null || campus == null) return;
    final hints = SearchHints(store.db);
    for (final (a, b, by) in votes) {
      unawaited(hints.learn(campus, a, b, by));
    }
  }

  void dispose() => _settle?.cancel();
}
