// Runs without a browser or network. Invoke runAccountChecks with account.js text.
export async function runAccountChecks(source) {
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const sandbox = {};
  new Function('globalThis', source)(sandbox);
  const model = sandbox.ACEatAccountModel, exam = { id: 'sat-practice-9', revision: 1 };
  assert(model.examKey('alice', exam) !== model.examKey('bob', exam), 'Account storage must be isolated');
  assert(model.examKey(null, exam) === 'aceat:exam:sat-practice-9:v1', 'Existing guest attempts must remain readable');
  assert(!model.meaningful({ answers: {} }) && model.meaningful({ submitted: true }), 'Empty and completed attempts');
  const cleaned = model.cleanState({ answers: { 'math-1:1': '1/4', invalid: 'A', 'math-1:2': 'x'.repeat(25) }, flags: ['math-1:1', 'invalid'], index: -1 });
  assert(JSON.stringify(cleaned.answers) === '{"math-1:1":"1/4"}' && cleaned.index === 0 && cleaned.flags.length === 1, 'Malformed answers must be discarded');
  assert(model.cleanBook({ book_id: '../bad', chapter_index: 0, subject: 'math' }) === null, 'Unsafe book IDs');
  assert(model.latest({ updatedAt: '2026-01-01' }, { updatedAt: '2026-01-02' }).updatedAt === '2026-01-02', 'Newer cloud attempt wins');

  const nodes = new Map(), storage = new Map(), timers = new Map(), listeners = new Map(), rows = [], writes = [];
  let timerId = 0, callback, nextSession = null, rejectWrites = false;
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, value: '', textContent: '', dataset: {}, children: [], events: {}, setAttribute() {}, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; }, addEventListener(type, fn) { this.events[type] = fn; } });
    return nodes.get(id);
  };
  const document = { getElementById: node, createElement: () => node(`generated-${nodes.size}`) };
  const client = {
    auth: { onAuthStateChange(fn) { callback = fn; }, async getSession() { return { data: { session: null } }; }, async signOut() { return {}; } },
    from(table) {
      return { select() { return this; }, eq(column, owner) { this.owner = owner; return this; }, async limit() { return { data: rows.filter(row => row.table === table && row.user_id === this.owner).map(({ table: _, ...row }) => row) }; }, async upsert(payload) { if (rejectWrites) throw new Error('offline'); writes.push({ table, ...payload }); return {}; } };
    }
  };
  const window = { ACEAT_AUTH: { url: 'https://example.test', publishableKey: 'public' }, dispatchEvent(event) { for (const fn of listeners.get(event.type) || []) fn(event); } };
  const localStorage = { getItem: key => storage.get(key) || null, setItem: (key, value) => storage.set(key, value) };
  const setTimer = fn => { timers.set(++timerId, fn); return timerId; }, clearTimer = id => timers.delete(id);
  const tick = async () => { const tasks = [...timers.values()]; timers.clear(); for (const task of tasks) task(); for (let i = 0; i < 20; i++) await Promise.resolve(); };
  const catalog = { textbooks: [{ id: 'sat-math-complete', title: 'Math', chapter_count: 20 }], pastExams: [exam] };
  const addText = (parent, tag, text) => { const element = document.createElement(tag); element.textContent = text; parent.append(element); return element; };
  const location = { href: 'https://aceat.vercel.app/#account' }, history = { replaceState() {} };
  const transformed = source.replace("import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm')", 'Promise.resolve({ createClient: () => mockClient })');
  const Url = globalThis.URL || class { constructor(value) { this.hash = value.slice(value.indexOf('#')); this.searchParams = { has: () => false }; } };
  const run = new Function('globalThis', 'document', 'window', 'localStorage', 'location', 'history', 'catalog', 'catalogReady', 'addText', 'setTimeout', 'clearTimeout', 'CustomEvent', 'showRoute', 'mockClient', 'URL', transformed);
  run({}, document, window, localStorage, location, history, catalog, Promise.resolve(), addText, setTimer, clearTimer, class { constructor(type) { this.type = type; } }, () => {}, client, Url);
  await window.ACEatAccount.ready;
  const login = async uid => { nextSession = { user: { id: uid, email: `${uid}@example.test`, user_metadata: {} } }; callback('SIGNED_IN', nextSession); await tick(); };
  const guest = { answers: { 'math-1:1': 'A' }, flags: [], submitted: false };
  storage.set(model.examKey(null, exam), JSON.stringify(guest));
  await login('alice');
  assert(window.ACEatAccount.identity() === 'alice', 'Login event must update account');
  assert(!storage.has(model.examKey('alice', exam)), 'Guest data must not import automatically');
  assert(!node('account-import-panel').hidden, 'Explicit guest import is offered');
  node('account-import').events.click(); await tick();
  assert(JSON.parse(storage.get(model.examKey('alice', exam))).answers['math-1:1'] === 'A', 'Explicit import keeps answers');
  assert(writes.some(row => row.table === 'aceat_exam_attempts' && row.user_id === 'alice'), 'Imported attempt saves to its owner');
  assert(storage.has(model.examKey(null, exam)), 'Import preserves guest copy');
  await window.ACEatAccount.trackBook('sat-math-complete', 2, 'math'); await tick();
  assert(writes.some(row => row.table === 'aceat_book_progress' && row.user_id === 'alice'), 'Book progress saves');
  await login('bob');
  assert(!storage.has(model.examKey('bob', exam)), 'Switching account must not copy previous answers');
  assert(node('account-books-value').textContent === '0', 'Previous user books must not appear');
  rejectWrites = true;
  window.ACEatAccount.saveExam(exam, { ...guest, updatedAt: new Date().toISOString() }); await tick();
  assert(node('account-sync-status').textContent.includes('браузере'), 'Network failure reports local fallback');
  rejectWrites = false; node('account-refresh').events.click(); await tick();
  assert(writes.some(row => row.table === 'aceat_exam_attempts' && row.user_id === 'bob'), 'Failed write retries');
  rows.push({ table: 'aceat_exam_attempts', user_id: 'carol', exam_id: exam.id, revision: 1, state: { answers: { 'math-1:2': 'D' }, updatedAt: '2026-02-01' }, updated_at: '2026-02-01' });
  await login('carol');
  assert(JSON.parse(storage.get(model.examKey('carol', exam))).answers['math-1:2'] === 'D', 'Cloud answers restore on another account/device');
  callback('PASSWORD_RECOVERY', nextSession); await tick();
  assert(!node('account-auth').hidden && node('account-email-wrap').hidden && node('account-submit').textContent === 'Сохранить пароль', 'Recovery link shows password reset');
  return 'Account model and mocked sign-in, guest import, isolation, cloud restore, offline retry and password recovery passed';
}
