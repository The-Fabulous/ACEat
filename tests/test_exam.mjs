import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({ URL });
vm.runInContext(readFileSync(new URL('../exam.js', import.meta.url), 'utf8'), context);
const engine = context.ACEatExamEngine;
const exams = [9, 10].map(number => JSON.parse(readFileSync(new URL(`../data/exams/sat-practice-${number}.json`, import.meta.url), 'utf8')));
const copy = value => JSON.parse(JSON.stringify(value));

for (const exam of exams) {
  test(`${exam.id}: 120 questions, complete page map and official score tables`, () => {
    engine.validate(exam, exam.id);
    assert.equal(engine.questions(exam).length, 120);
    assert.equal(exam.modules.map(m => m.questions.length).join(','), '33,33,27,27');
    assert.equal(exam.modules[0].questions[0].page, 4);
    assert.equal(exam.modules[1].questions[0].page, 18);
    assert.equal(exam.modules[2].questions[0].page, 34);
    assert.equal(exam.modules[3].questions[0].page, exam.id.endsWith('9') ? 42 : 46);
    assert.match(exam.source_sha256.paper, /^[a-f0-9]{64}$/);
  });
  test(`${exam.id}: empty and perfect attempts use the actual conversion table`, () => {
    const empty = engine.grade(exam, {});
    assert.equal(empty.correct, 0); assert.equal(empty.unanswered, 120);
    assert.equal(empty.range.join(','), '400,400');
    const answers = Object.fromEntries(engine.questions(exam).map(q => [q.id, q.answers[0]]));
    const full = engine.grade(exam, answers);
    assert.equal(full.correct, 120); assert.equal(full.unanswered, 0);
    assert.equal(full.range.join(','), '1600,1600');
    assert.equal(full.sections.reading.correct, 66); assert.equal(full.sections.math.correct, 54);
  });
}

test('Mixed answers produce separate reading/math ranges and include unanswered questions', () => {
  const score = engine.grade(exams[0], { 'reading-1:1': 'A', 'math-2:14': '-12', 'reading-1:2': 'A', 'math-1:6': '1/0' });
  assert.equal(score.correct, 2); assert.equal(score.unanswered, 117);
  assert.equal(score.sections.reading.range.join(','), '210,220');
  assert.equal(score.sections.math.range.join(','), '210,220');
  assert.equal(score.range.join(','), '420,440');
});

test('Numeric answers support alternatives, fractions, decimal commas and published rounding', () => {
  const multiple = exams[0].modules[3].questions[13];
  assert.equal(engine.isCorrect(multiple, '2'), true);
  assert.equal(engine.isCorrect(multiple, '−12'), true);
  assert.equal(engine.isCorrect(multiple, '12'), false);
  const quarter = exams[1].modules[3].questions[20];
  for (const value of ['1/4', '0.25', '0,25', '.25', '2/8']) assert.equal(engine.isCorrect(quarter, value), true);
  const thirds = exams[1].modules[2].questions[26];
  for (const value of ['29/3', '9.666', '9.667']) assert.equal(engine.isCorrect(thirds, value), true);
  for (const value of ['', '1/0', 'Infinity', 'NaN', '2+2', '9.6', 'hello']) assert.equal(engine.isCorrect(thirds, value), false);
});

test('Restore keeps answers, module position and flags, while discarding unrelated or invalid state', () => {
  const restored = engine.restore(exams[0], {
    index: 106, submitted: true, flags: ['math-2:14', 'unknown'],
    answers: { 'math-2:14': '-12', 'reading-1:1': {}, 'math-1:1': 'x'.repeat(25), unknown: 'A' }
  });
  assert.equal(restored.index, 106); assert.equal(restored.submitted, true);
  assert.deepEqual(copy(restored.flags), ['math-2:14']);
  assert.deepEqual(copy(restored.answers), { 'math-2:14': '-12' });
  assert.equal(engine.restore(exams[0], { index: -2 }).index, 0);
  assert.equal(engine.restore(exams[0], null).submitted, false);
});

test('Broken question metadata, unsafe source URLs and invalid score ranges are rejected', () => {
  const bad = copy(exams[0]); bad.modules[0].questions[0].page = 0;
  assert.throws(() => engine.validate(bad, bad.id), /вопроса/);
  const badKey = copy(exams[0]); badKey.modules[0].questions[0].answers = ['E'];
  assert.throws(() => engine.validate(badKey, badKey.id), /вопроса/);
  const badScore = copy(exams[0]); badScore.scoring.math[0] = [800, 200];
  assert.throws(() => engine.validate(badScore, badScore.id), /баллов/);
  const badSource = copy(exams[0]); badSource.paper_url = 'https://unrelated.example/source.pdf';
  assert.throws(() => engine.validate(badSource, badSource.id), /данные/);
  assert.equal(engine.sourceUrl('javascript:alert(1)'), null);
});
