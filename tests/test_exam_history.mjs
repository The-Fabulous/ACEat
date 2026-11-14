export async function runExamHistoryChecks(source, examSource, exam) {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const sandbox = {}; new Function('globalThis', source)(sandbox);
  const model = sandbox.ACEatResultsModel;
  const engineBox = {}; new Function('globalThis', examSource)(engineBox);
  const engine = engineBox.ACEatExamEngine;
  const first = '13200000-0000-4000-8000-000000000001', second = '13700000-0000-4000-8000-000000000002';
  const demos = [1320, 1370].map((score, index) => ({ id: index ? second : first, exam_id: exam.id, score, is_demo: true, completed_at: `2026-01-0${index + 1}T00:00:00Z`, result: { title: exam.title, range: [score, score] } }));
  assert(model.summary(demos, 1400).score === 1370 && model.summary(demos, 1400).remaining === 30, 'Latest 1370 is thirty below 1400');
  assert(model.summary(demos, 1300).remaining === 0, 'Progress past the target never becomes negative');
  assert(model.summary([], 1400).score === null && model.summary([], 1400).remaining === null, 'Empty history has no fabricated score');
  assert(model.scoreFor([1330, 1360]) === 1350, 'Range midpoint rounds to tens');
  const legacy = { answers: { 'math-1:1': 'A', 'reading-1:1': 'B' } };
  assert(model.legacyId(exam, legacy) === model.legacyId(exam, { answers: { 'reading-1:1': 'B', 'math-1:1': 'A' } }), 'Legacy IDs do not depend on answer object order');
  const saved = { answers: {}, flags: [], index: 0, submitted: true, attemptId: first, submittedAt: '2026-01-01T00:00:00Z' };
  const restored = engine.restore(exam, saved);
  assert(restored.attemptId === first && restored.submittedAt === saved.submittedAt, 'Attempt identity survives reload');
  assert(!engine.restore(exam, null).attemptId, 'Restart clears attempt identity');

  let owner = 'alice', fail = false, remote = demos.map(row => ({ ...row, user_id: 'alice' })), deferred = null;
  const disk = new Map(), nodes = new Map(), events = new Map();
  const node = id => { if (!nodes.has(id)) nodes.set(id, { dataset: {}, children: [], textContent: '', hidden: false, events: {}, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, addEventListener(type, fn) { this.events[type] = fn; } }); return nodes.get(id); };
  const document = { getElementById: node, createElement: tag => node(tag + nodes.size) };
  const account = { ready: Promise.resolve(), identity: () => owner,
    async fetchResults(uid, offset) { if (deferred) await deferred; if (fail) throw Error('offline'); return remote.filter(row => row.user_id === uid).sort((a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at)).slice(offset, offset + 100); },
    async pushResult(uid, row) { if (fail) throw Error('offline'); if (!remote.some(item => item.user_id === uid && item.id === row.id)) remote.push({ ...row, user_id: uid }); } };
  const window = { ACEatAccount: account, ACEatExamEngine: engine, addEventListener(type, fn) { events.set(type, fn); } };
  const storage = { getItem: key => disk.get(key), setItem: (key, value) => disk.set(key, value) };
  const addText = (parent, tag, text) => { const child = document.createElement(tag); child.textContent = text; parent.append(child); return child; };
  new Function('globalThis', 'window', 'document', 'localStorage', 'catalogReady', 'catalog', 'addText', source)({}, window, document, storage, Promise.resolve(), { pastExams: [] }, addText);
  const tick = async () => { for (let i = 0; i < 50; i++) await Promise.resolve(); };
  await tick(); window.ACEatResults.render(1400);
  assert(node('account-current-score').textContent === '1370' && node('account-score-gap').textContent === '30', 'Dashboard restores remote scores and target gap');
  assert(node('account-history-list').children.length === 2 && node('account-score-note').textContent.includes('Демонстрационный'), 'Seed records appear with demo label');
  const attempt = { ...saved, attemptId: 'aaaaaaaa-0000-4000-8000-000000000001', submittedAt: '2026-02-01T00:00:00Z' };
  window.ACEatResults.capture(exam, attempt, owner); await tick();
  window.ACEatResults.capture(exam, { ...attempt, index: 10 }, owner); await tick();
  assert(remote.length === 3, 'Review navigation and repeated capture do not duplicate results');
  const attempt2 = { ...attempt, attemptId: 'bbbbbbbb-0000-4000-8000-000000000002', submittedAt: '2026-03-01T00:00:00Z' };
  fail = true; window.ACEatResults.capture(exam, attempt2, owner); await tick();
  assert(node('account-history-list').children.length === 4 && remote.length === 3, 'Offline completion keeps the previous attempts and its local snapshot');
  fail = false; await window.ACEatResults.refresh();
  assert(remote.length === 4 && remote.at(-1).result.review.length === 120, 'Retry uploads the complete saved review');
  await window.ACEatResults.refresh(); assert(remote.length === 4, 'Refresh is idempotent');
  owner = 'bob'; events.get('aceat:identity-changing')();
  assert(node('account-current-score').textContent === '—', 'Switching account clears previous metrics');
  window.ACEatResults.capture(exam, attempt, 'alice'); await tick(); assert(remote.length === 4, 'Stale exam cannot attach to another account');
  return 'Exam history: immutable IDs, restart/reload, all snapshots, 1320→1370, gap, offline retry and account isolation passed';
}
