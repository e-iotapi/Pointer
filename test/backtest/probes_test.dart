// Runs unchanged in the new tree and in the extracted base tree. Emits the
// may() matrix and every corruption outcome; run.mjs diffs the two sides.
import 'dart:io';

import 'package:cgpa_calculator/core/roles/capabilities.dart';
import 'package:flutter_test/flutter_test.dart';

import 'common/probes.dart';
import 'common/support.dart';

void main() {
  final side = Platform.environment['BACKTEST_SIDE'] ?? 'new';

  test('may() matrix', () {
    final m = mayMatrix([for (final c in Capability.values) c.name]);
    expect(m, isNotEmpty);
    emit('${side}_may.json', m);
  });

  test('corrupt documents', () async {
    final out = <String, String>{};
    for (final e in docProbes().entries) {
      out[e.key] = await e.value();
    }
    expect(out, isNotEmpty);
    emit('${side}_docs.json', out);
  });

  test('corrupt device storage', () async {
    final out = await deviceProbes();
    expect(out, isNotEmpty);
    emit('${side}_device.json', out);
  });
}
