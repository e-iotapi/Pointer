# T4 harness shim for the base (stable) tree: the ?as= test sign-in startup fix
# from lib/main.dart (use the user testSignIn returns; waiting for
# authStateChanges after it hangs some emulator loads for good). It touches the
# isTestEnv path only, which production builds compile out. Delete this file
# once the base ref carries the fix (the script then says so and exits 0).
import sys
p = sys.argv[1]
s = open(p, encoding='utf-8').read()
if 'testUser ??' in s:
    print('base_shim: base already has the fix; delete tools/qa/base_shim.py'); sys.exit(0)
subs = [("  String? message;\n", "  String? message;\n  User? testUser;\n"),
        ("      await Perf.time('startup.testSignIn', testSignIn);", "      testUser = await Perf.time('startup.testSignIn', testSignIn);"),
        ("  final user = await Perf.time(\n    'startup.authState',", "  final user = testUser ?? await Perf.time(\n    'startup.authState',")]
for a, b in subs:
    if s.count(a) != 1:
        sys.exit(f'base_shim: pattern not found once in {p}: {a!r}')
    s = s.replace(a, b)
open(p, 'w', encoding='utf-8').write(s)
print('base_shim: applied')
