import test from 'node:test';
import { readFileSync } from 'node:fs';
import { runExamHistoryChecks } from './test_exam_history.mjs';
test('Exam archive and dashboard', async () => {
  const read = file => readFileSync(new URL('../' + file, import.meta.url), 'utf8');
  await runExamHistoryChecks(read('exam-history.js'), read('exam.js'), JSON.parse(read('data/exams/sat-practice-9.json')));
});
