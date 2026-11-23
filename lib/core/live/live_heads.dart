/// The live socket (LOADING_SERVER_PLAN.md D3): the server tells the app which
/// shared markers moved and when its own account changed elsewhere, so the
/// next load refetches only what changed. Only paths and counters travel;
/// no grades or user data. Off when [liveUrl] is empty; `headFor` keeps
/// working through the Worker or Firestore either way.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:math';

import 'package:cgpa_calculator/core/cache/cache_first.dart';
import 'package:cgpa_calculator/core/live/live_channel.dart';
import 'package:cgpa_calculator/core/live/live_socket.dart';
import 'package:flutter/foundation.dart';

/// The live server's base URL; empty turns the socket off.
const liveUrl = String.fromEnvironment('POINTER_LIVE_URL');

/// Ticks whenever a live frame moved a marker this device holds: open
/// screens (`Loaded`) listen and load again, which refetches only what moved.
final liveMoved = ValueNotifier<int>(0);

const _maxFailures = 3;
const _maxFrame = 900; // the server drops frames of 1 KB or more

abstract final class LiveHeads {
  static int _gen = 0; // bumped by stop(): a loop from an older run quits
  static bool _started = false, _gaveUp = false;
  static int _failures = 0;
  static int? _lastMe;
  static int _ownPokes = 0; // pokeMe frames sent whose echo hasn't come back
  static int? Function()? _loadMe;
  static void Function(int)? _saveMe;
  static LiveChannel? _ch;
  static Timer? _meTimer;
  static bool _pulling = false, _again = false;
  static int? _lastRoles, _wantRoles;
  static Timer? _rolesTimer;
  static bool _rolesBusy = false;
  static DateTime? _rolesAt;
  static Duration _rolesGap = const Duration(seconds: 10);
  static int? Function()? _loadRoles;
  static void Function(int)? _saveRoles;
  static Future<void> Function()? _onRoles;
  // Heads a batch moved (bumpPath), by marker path: the campuses poke() names.
  static final _bumped = <String, Set<String>>{};

  /// True once three connects failed: the socket stays off for the session.
  static bool get gaveUp => _gaveUp;

  /// Opens the socket for [campus] and keeps it open, reconnecting after a
  /// real drop. [idToken] is asked for at every connect. The rest is for
  /// tests: [baseUrl], [connect], [onMe] (the pull to run when the account
  /// moved elsewhere), [onRoles] with [loadRoles] and [saveRoles] (the same
  /// for this person's roles, which an appointer announces), [retry] (the wait before connect number n) and
  /// [pokeDelay].
  static void start(
    String campus,
    Future<String?> Function() idToken, {
    String baseUrl = liveUrl,
    Future<LiveChannel> Function(String url, List<String> protocols) connect =
        connectLive,
    Future<void> Function()? onMe,
    int? Function()? loadMe,
    void Function(int)? saveMe,
    Future<void> Function()? onRoles,
    int? Function()? loadRoles,
    void Function(int)? saveRoles,
    Duration Function(int attempt)? retry,
    Duration pokeDelay = const Duration(seconds: 2),
    Duration rolesGap = const Duration(seconds: 10),
  }) {
    if (baseUrl.isEmpty || _started) return;
    _started = true;
    _pokeDelay = pokeDelay;
    _rolesGap = rolesGap;
    _onMe = onMe;
    _loadMe = loadMe;
    _saveMe = saveMe;
    _onRoles = onRoles;
    _loadRoles = loadRoles;
    _saveRoles = saveRoles;
    final base =
        baseUrl.endsWith('/')
            ? baseUrl.substring(0, baseUrl.length - 1)
            : baseUrl;
    final url = '${base.replaceFirst(RegExp('^http'), 'ws')}/live/$campus';
    unawaited(_run(_gen, campus, url, idToken, connect, retry ?? _backoff));
  }

  /// Notes that a batch moves [path] on [campus]'s head (called by
  /// `bumpPath`); the next [poke] of [path] names those campuses, so the
  /// server tells their clients, not just this campus's.
  static void noteBump(String campus, String path) =>
      (_bumped[path] ??= {}).add(campus);

  /// Tells the server [path]'s marker moved (call after the write commits),
  /// on the campuses noted for it, else this socket's own. Dropped while the
  /// socket is down: the head heals on the next fetch.
  static void poke(String path) {
    final campuses = _bumped.remove(path);
    if (path.length > _maxFrame) return;
    _send({
      't': 'poke',
      'path': path,
      if (campuses != null && campuses.isNotEmpty)
        'campuses': campuses.toList()..sort(),
    });
  }

  /// Tells the server [email]'s roles changed (an appointment, a revoke):
  /// their open apps, on any campus, read their roles again. No data goes.
  static void pokeUser(String email) {
    if (email.isEmpty || email.length > 254) return;
    _send({'t': 'pokeUser', 'email': email});
  }

  /// Tells the server this account changed, one frame about two seconds
  /// after the last call, so a burst of writes sends one.
  static void pokeMe() {
    if (!_started) return;
    _meTimer?.cancel();
    _meTimer = Timer(_pokeDelay, () {
      if (_ch == null) return;
      _ownPokes++;
      _send({'t': 'pokeMe'});
    });
  }

  /// Closes the socket and ends the loop; [start] can be called again.
  static void stop() {
    _gen++;
    _started = _gaveUp = _pulling = _again = false;
    _failures = 0;
    _lastMe = null;
    _lastRoles = _wantRoles = null;
    _rolesTimer?.cancel();
    _rolesTimer = null;
    _rolesBusy = false;
    _rolesAt = null;
    _bumped.clear();
    _ownPokes = 0;
    _meTimer?.cancel();
    _meTimer = null;
    _ch?.close();
    _ch = null;
    versionsLive = false;
  }

  static Duration _pokeDelay = const Duration(seconds: 2);
  static Future<void> Function()? _onMe;

  static void _send(Map<String, Object?> m) {
    try {
      _ch?.send(jsonEncode(m));
    } on Object catch (e) {
      debugPrint('live send: $e');
    }
  }

  /// 1-10 s of jitter, doubling per attempt, capped at 5 min.
  static Duration _backoff(int attempt) {
    final base = 1 + Random().nextDouble() * 9;
    return Duration(
      milliseconds: min(300000, (base * 1000 * pow(2, attempt)).round()),
    );
  }

  static Future<void> _run(
    int gen,
    String campus,
    String url,
    Future<String?> Function() idToken,
    Future<LiveChannel> Function(String, List<String>) connect,
    Duration Function(int) retry,
  ) async {
    var attempt = 0;
    while (gen == _gen) {
      LiveChannel? ch;
      try {
        final tok = await idToken();
        if (tok == null || tok.isEmpty) throw StateError('no token');
        ch = await connect(url, ['pointer', tok]);
      } on Object {
        // counted below
      }
      var hello = false;
      if (ch != null) {
        if (gen != _gen) {
          ch.close();
          return;
        }
        _ch = ch;
        try {
          await for (final raw in ch.messages) {
            if (gen != _gen) break;
            hello = _onMessage(campus, raw) || hello;
          }
        } on Object {
          // a drop
        }
        if (gen == _gen) versionsLive = false;
        ch.close();
        if (_ch == ch) _ch = null;
      }
      if (gen != _gen) return;
      if (hello) {
        _failures = 0;
        attempt = 0;
      } else if (++_failures >= _maxFailures) {
        _gaveUp = true;
        return;
      }
      await Future<void>.delayed(retry(attempt++));
    }
  }

  /// Handles one frame; true when it was the hello (the connect worked).
  static bool _onMessage(String campus, String raw) {
    final Map m;
    try {
      m = jsonDecode(raw) as Map;
    } on Object {
      return false;
    }
    switch (m['t']) {
      case 'hello':
        _merge(campus, m['head']);
        _roles(m['roles']);
        // An empty head means the hub couldn't read Firestore: not verified.
        versionsLive = (m['head'] as Map?)?.isNotEmpty ?? false;
        _me(m['me'], hello: true);
        return true;
      case 'head':
        _merge(campus, m['v']);
      case 'me':
        _me(m['v'], hello: false);
      case 'roles':
        _roles(m['v']);
    }
    return false;
  }

  /// Writes the new numbers into the saved `head|<campus>` (leaving its age
  /// and other fields alone) so the next load sees the moved marker and
  /// refetches. With no saved head there is nothing to correct: the next
  /// `headFor` reads a fresh one. `o:<course|term>` numbers are scheme
  /// versions and go under `offerings`.
  static void _merge(String campus, Object? v) {
    if (_mergeHead(campus, v)) liveMoved.value++;
  }

  static bool _mergeHead(String campus, Object? v) {
    if (v is! Map) return false;
    final box = sharedCacheBox;
    final raw = box?.get('head|$campus');
    if (box == null || raw is! String) return false;
    try {
      final entry = jsonDecode(raw) as Map;
      final head = Map<String, Object?>.from(entry['v'] as Map);
      final marks = Map<String, Object?>.from((head['v'] as Map?) ?? const {});
      final schemes =
          Map<String, Object?>.from((head['offerings'] as Map?) ?? const {});
      var moved = false, write = false;
      for (final e in v.entries) {
        final n = e.value;
        if (n is! num) continue;
        final k = '${e.key}';
        // The public contact's hash (BRK-014): the first one is a baseline;
        // a later change drops the saved contact, so the next read is fresh.
        if (k == '#contact') {
          final was = marks[k];
          if (was == n.toInt()) continue;
          marks[k] = n.toInt();
          write = true;
          if (was != null) {
            head.remove('contact');
            unawaited(box.delete('contact|public'));
            moved = true;
          }
          continue;
        }
        final into = k.startsWith('o:') ? schemes : marks;
        final key = k.startsWith('o:') ? k.substring(2) : k;
        // Equality, not max: a lowered marker costs one re-read, never a freeze.
        if (into[key] != n.toInt()) {
          into[key] = n.toInt();
          moved = true;
        }
      }
      if (!moved && !write) return false;
      head['v'] = marks;
      head['offerings'] = schemes;
      entry['v'] = head;
      unawaited(
        box
            .put('head|$campus', jsonEncode(entry))
            .catchError((Object e) => debugPrint('live head: $e')),
      );
      return moved;
    } on Object catch (e) {
      debugPrint('live merge: $e');
      return false;
    }
  }

  /// [_lastMe] is saved (via [_saveMe]) once this device holds that
  /// version: at once for the first baseline or our own write's echo, after
  /// the pull otherwise, so a failed pull is retried at the next hello.
  static void _me(Object? v, {required bool hello}) {
    if (v is! num) return;
    final n = v.toInt(), last = _lastMe ?? _loadMe?.call();
    final own = !hello && _ownPokes > 0;
    if (own) _ownPokes--;
    if (last != null && n < last) {
      // The hub's counter went back (wiped, or another campus's hub): start
      // over from it.
      _lastMe = n;
      _saveMe?.call(n);
      unawaited(_pullMe());
      return;
    }
    if (last != null && n == last) {
      _lastMe = last;
      return;
    }
    _lastMe = n;
    // No saved number: sign-in has just pulled, so this is the baseline.
    // Exactly one past the last, right after our own pokeMe: our own write.
    // ponytail: another device's bump landing in that same step is missed
    // until the next me or hello; the hub's 2 s pokeMe gap makes it rare.
    if (last == null || (own && n == last + 1)) {
      _saveMe?.call(n);
      return;
    }
    unawaited(_pullMe());
  }

  /// The roles counter (hello, or a `roles` frame after an appointment):
  /// the first one seen is the baseline (sign-in has just read the roles);
  /// a different one means they changed, here or while this device was off,
  /// so read them again and keep the number once that worked.
  static void _roles(Object? v) {
    if (v is! num || _onRoles == null) return;
    final n = v.toInt(), last = _lastRoles ?? _loadRoles?.call();
    if (last == null) {
      _lastRoles = n;
      _saveRoles?.call(n);
      return;
    }
    if (n == last) return;
    _wantRoles = n;
    _readRoles();
  }

  /// One read at a time and at most one per [_rolesGap], the newest counter
  /// wanted last: a burst of frames (or a stranger's) is one read, and an
  /// appointment right after another still lands.
  static void _readRoles() {
    if (_rolesTimer != null || _rolesBusy) return;
    final at = _rolesAt;
    final wait =
        at == null
            ? Duration.zero
            : _rolesGap - DateTime.now().difference(at);
    _rolesTimer = Timer(wait.isNegative ? Duration.zero : wait, () async {
      _rolesTimer = null;
      final n = _wantRoles, gen = _gen;
      if (n == null || n == (_lastRoles ?? _loadRoles?.call())) return;
      _rolesBusy = true;
      var ok = false;
      try {
        await _onRoles!();
        if (gen != _gen) return;
        _lastRoles = n;
        _saveRoles?.call(n);
        ok = true;
      } on Object catch (e) {
        debugPrint('live roles: $e'); // retried at the next hello
      } finally {
        if (gen == _gen) {
          _rolesBusy = false;
          _rolesAt = DateTime.now();
          if (ok && _lastRoles != _wantRoles) _readRoles();
        }
      }
    });
  }

  static Future<void> _pullMe() async {
    final go = _onMe;
    if (go == null) return;
    if (_pulling) {
      _again = true;
      return;
    }
    _pulling = true;
    try {
      do {
        _again = false;
        final n = _lastMe;
        await go();
        if (n != null) _saveMe?.call(n);
      } while (_again);
    } on Object catch (e) {
      debugPrint('live pull: $e');
    } finally {
      _pulling = false;
    }
  }
}
