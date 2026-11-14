import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runProgressChartChecks } from './test_progress_chart.mjs';
test('Progress chart coordinates and targets', () => runProgressChartChecks(readFileSync(new URL('../progress-chart.js', import.meta.url), 'utf8')));
