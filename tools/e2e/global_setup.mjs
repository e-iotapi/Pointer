// Seeds one emulator project per Playwright worker (see E2E_WORKERS in
// specs/helpers.mjs), plus demo-pointer, whose Auth accounts every worker signs in with.
import { execFileSync } from 'node:child_process';
import { E2E_WORKERS, workerProject } from './specs/helpers.mjs';

// E2E_DATA=<docs.jsonl dir> (tools/qa/t4.sh) is loaded into each worker's project first, the seed on top.
export default function globalSetup() {
  if (E2E_WORKERS < 2) return;
  const node = (...args) => execFileSync('node', args, { cwd: new URL('../..', import.meta.url), stdio: 'ignore' });
  node('tools/test_env/seed.mjs', '--project', 'demo-pointer');
  for (let n = 0; n < E2E_WORKERS; n++) {
    const project = workerProject(n);
    if (process.env.E2E_DATA) node('tools/prod_mirror/load.mjs', '--in', process.env.E2E_DATA, '--no-auth', '--project', project);
    node('tools/test_env/seed.mjs', '--project', project, ...(process.env.E2E_DATA ? ['--keep'] : []));
  }
}
