// Part 1: the OLD suites (extracted from git) run against the NEW firestore.rules,
// unseeded (no roles/builtin: state at deploy) and seeded (after Controls > Roles).
import { join } from 'node:path';
import { readFileSync, writeFileSync, rmSync } from 'node:fs';
import { baseTestsCommit, workdir, emulatorExec, readJsonl, show, HERE } from './lib.mjs';

const SEED = `
import { setDoc as __sd, doc as __d } from 'firebase/firestore';
const __caps = ${JSON.stringify({
  admin: ['appointPresidents','appointCrs','publicContact','grantTermsCrPresident','mergeProfessors','courseStructures','bulkUpload','degreeRequirements','departmentResources','courseResources','averages','professors','moderateReviews','readAuditAndRoster','contribute','manageRoles','approveContributors','claimElectives','reviewGateSwitch','publishTimetable','publishDirectly'],
  president: ['appointCrs','mergeProfessors','courseStructures','bulkUpload','degreeRequirements','departmentResources','courseResources','averages','professors','moderateReviews','readAuditAndRoster','contribute','approveContributors','claimElectives','publishDirectly'],
  cr: ['courseStructures','courseResources','averages','contribute'] })};
export async function __btSeed() {
  if (!process.env.BT_SEED_BUILTIN) return;
  await env.withSecurityRulesDisabled((c) => __sd(__d(c.firestore(), 'roles', 'builtin'), {
    admin: { caps: __caps.admin, termDays: 730 }, president: { caps: __caps.president, termDays: 365 }, cr: { caps: __caps.cr, termDays: 183 } }));
}
`;
const patch = (src) => src
  .replace("await env.clearFirestore();", "await env.clearFirestore();\n  await __btSeed();")
  + SEED;

/// Modes: unseeded / seeded run every old file; the ADMIN-on-own-campus variants re-run only
/// the files that failed, with the suites' ADMIN moved to a Goa address (the campus the
/// failing tests act on). A failure that passes there is campus separation, not a break.
const MODES = {
  unseeded: { seed: '', admin: false },
  seeded: { seed: '1', admin: false },
  'unseeded+adminOnGoa': { seed: '', admin: true },
  'seeded+adminOnGoa': { seed: '1', admin: true },
};
const adminGoa = (src) => src.replace("export const ADMIN = 'f20200001@pilani.bits-pilani.ac.in'", "export const ADMIN = 'f20200001@goa.bits-pilani.ac.in'");

export function runSuites({ base, head = 'HEAD', testsRef }) {
  const tc = testsRef ?? baseTestsCommit(base);
  const out = [];
  const failedFiles = new Set();
  for (const [mode, m] of Object.entries(MODES)) {
    let files = 'test/rules/*.test.mjs';
    if (m.admin) {
      if (!failedFiles.size) continue;
      files = [...failedFiles].map((f) => `test/rules/${f}`).join(' ');
    }
    const d = workdir({ rulesFrom: () => show(head, 'firestore.rules'), testsFrom: tc,
      patchHelpers: (s) => (m.admin ? adminGoa(patch(s)) : patch(s)) });
    const res = join(d, 'out.jsonl');
    const r = emulatorExec(d, `node --test --test-concurrency=1 --test-reporter=${join(HERE, 'reporter.mjs')} ${files}`,
      { BT_OUT: res, BT_SEED_BUILTIN: m.seed });
    const rows = readJsonl(res).map((x) => ({ ...x, mode }));
    if (!rows.length) throw new Error(`no results (${mode}):\n${r.stdout}\n${r.stderr}`);
    if (!m.admin) rows.filter((x) => !x.ok).forEach((x) => failedFiles.add(x.file));
    out.push(...rows);
    rmSync(d, { recursive: true, force: true });
  }
  return { testsCommit: tc, rows: out };
}
if (process.argv[1].endsWith('suites.mjs')) {
  const r = runSuites({ base: process.argv[2] ?? 'origin/master' });
  writeFileSync(process.argv[3] ?? '/dev/stdout', JSON.stringify(r, null, 1));
}
