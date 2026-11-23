import { defineConfig, devices } from '@playwright/test';
import { MODE, CFG } from './lib.mjs';

export default defineConfig({
  testDir: './specs',
  outputDir: './out/test-results',
  timeout: 120_000,
  workers: 1,
  fullyParallel: false,
  retries: 0,
  reporter: [['list'], ['json', { outputFile: './out/results.json' }]],
  use: { baseURL: CFG.app, trace: 'retain-on-failure' },
  projects: [{ name: MODE, use: { ...devices['Desktop Chrome'] } }],
});
