import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runAccountChecks } from './test_account.mjs';

test('Account state stays isolated and recovers after failed cloud writes', async () => {
  await runAccountChecks(readFileSync(new URL('../account.js', import.meta.url), 'utf8'));
});
