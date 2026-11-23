import 'dart:async';
import 'dart:io';

import 'package:cgpa_calculator/core/catalog/catalog.dart';

/// The base tree has no tests of its own: give them the shipped catalogue.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  useCatalog(Catalog.fromJson(File(catalogAsset).readAsStringSync()));
  await testMain();
}
