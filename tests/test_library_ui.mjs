import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const context = vm.createContext({});
vm.runInContext(readFileSync(new URL('../library.js', import.meta.url), 'utf8'), context);
const model = context.ACEatLibraryModel;
const catalog = JSON.parse(readFileSync(new URL('../data/catalog.json', import.meta.url), 'utf8'));
const structure = JSON.parse(readFileSync(new URL('../data/library-structure.json', import.meta.url), 'utf8'));
const books = catalog.textbooks.map(entry => JSON.parse(readFileSync(new URL(`../${entry.book_path}`, import.meta.url), 'utf8')));

for (const book of books) {
  test(`${book.id}: every existing chapter appears exactly once in the topic hierarchy`, () => {
    const grouped = model.groupsFor(book, structure).flatMap(group => group.chapters);
    assert.equal(grouped.length, book.chapters.length);
    assert.equal(new Set(grouped).size, book.chapters.length);
    assert.equal([...grouped].sort((a, b) => a - b).join(','), book.chapters.map((_, index) => index).join(','));
    const view = model.selection(book, `book/${book.id}`, structure);
    assert.equal(view.tab, book.subject === 'math' ? 'math' : 'english');
    assert.equal(view.chapter, null);
  });
}

test('Math subject → Algebra → actual linear-equations chapter; legacy links still open', () => {
  const book = books.find(item => item.subject === 'math');
  const view = model.selection(book, `book/${book.id}/math/1`, structure);
  assert.equal(view.groups.find(group => group.title === 'Алгебра').chapters.join(','), '1,2');
  assert.equal(view.chapter, 1);
  assert.match(book.chapters[view.chapter].title, /Linear Equations/);
  const legacy = model.selection(book, `book/${book.id}/1`, structure);
  assert.equal(legacy.tab, 'math'); assert.equal(legacy.chapter, 1);
});

test('Subject tabs keep unsupported content empty; PDF tab is separate', () => {
  const math = books.find(book => book.subject === 'math');
  assert.equal(model.selection(math, `book/${math.id}/english`, structure).groups.length, 0);
  const reading = books.find(book => book.id === 'sat-reading-meltzer');
  assert.equal(model.selection(reading, `book/${reading.id}/math`, structure).groups.length, 0);
  assert.equal(model.selection(reading, `book/${reading.id}/pdf`, structure).tab, 'pdf');
  assert.throws(() => model.selection(reading, `book/${reading.id}/math/0`, structure), /подтемы/);
});

test('New or ungrouped chapters remain accessible instead of disappearing', () => {
  const math = books.find(book => book.subject === 'math');
  const groups = model.groupsFor(math, { [math.id]: [{ title: 'Only one', subject: 'math', chapters: [1, 1, 900] }] });
  assert.equal(groups.flatMap(group => group.chapters).length, math.chapters.length);
  assert.equal(groups[0].chapters.join(','), '1');
  assert.equal(groups.at(-1).title, 'Другие темы');
});

test('Broken routes and invalid chapter/subsection indices are rejected', () => {
  for (const route of ['book/../../.env', 'book/sat-math-complete/pdf/0', 'book/sat-math-complete/1/2', 'book/sat-math-complete/math/999999999999999999999']) assert.throws(() => model.parseRoute(route));
  assert.throws(() => model.selection(books[0], `book/${books[0].id}/math/999`, structure), /подтемы/);
  assert.throws(() => model.selection(books[0], `book/${books[0].id}/math/1/999`, structure), /Подраздел/);
  assert.equal(model.cleanTitle('01. Linear Equations and Inequalities'), 'Linear Equations and Inequalities');
});
