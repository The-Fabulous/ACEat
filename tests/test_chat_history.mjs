// Pure storage/sync checks: no browser, Python server, AI requests or live users.
export async function runChatHistoryChecks(source) {
  const assert = (condition, label) => { if (!condition) throw new Error(label); };
  const sandbox = {}; new Function('globalThis', source)(sandbox);
  const model = sandbox.ACEatChatModel;
  let serial = 0;
  const id = () => '00000000-0000-4000-8000-' + (++serial).toString(16).padStart(12, '0');
  const remote = new Map(), time = Date.parse('2026-11-09T09:00:00Z');
  let fail = false, lostAcknowledgment = false, pushes = 0, deferred = null;
  function device(initial = 'alice', disk = new Map()) {
    let owner = initial;
    const adapter = {
      identity: () => owner, now: () => time, randomId: id,
      read: key => disk.has(key) ? JSON.parse(disk.get(key)) : null,
      write: (key, value) => { disk.set(key, JSON.stringify(value)); return true; },
      async push(uid, rows) {
        pushes += 1; if (fail) throw new Error('offline');
        for (const row of rows) if (!remote.has(uid + ':' + row.id)) remote.set(uid + ':' + row.id, { ...row, user_id: uid });
        if (lostAcknowledgment) { lostAcknowledgment = false; throw new Error('connection lost after commit'); }
      },
      async fetch(uid, topic, cursor) {
        if (deferred) await deferred;
        if (fail) throw new Error('offline');
        return [...remote.values()].filter(row => row.user_id === uid && row.topic === topic && (!cursor || model.compare(row, cursor) < 0)).sort((a, b) => model.compare(b, a)).slice(0, 100);
      }
    };
    return { store: model.createStore(adapter), disk, adapter, switchTo: uid => { owner = uid; } };
  }
  const answer = { intent: 'solve', summary: 'Разбор '.repeat(250), steps: [{ explanation: 'Разделим обе части на два', formula: 'x=3' }], answer: 'Ответ: 3' };
  const a = device(), conversation = id();
  a.store.append('algebra', conversation, 'user', 'Реши 2x=6');
  a.store.append('algebra', conversation, 'assistant', answer); await a.store.flush();
  assert(a.store.snapshot('algebra').unsent === 0 && remote.size === 2, 'Question and complete answer save independently');
  const b = device(); await b.store.load('algebra');
  assert(b.store.snapshot('algebra').messages.length === 2, 'Another device restores messages');
  assert(b.store.snapshot('algebra').messages[1].answer.summary === answer.summary && b.store.snapshot('algebra').messages[1].answer.steps[0].formula === 'x=3', 'Full formatted answer survives beyond the short AI context');
  assert(b.store.snapshot('reading').messages.length === 0, 'Topic histories are isolated');
  a.store.append('algebra', conversation, 'user', 'Первое устройство');
  b.store.append('algebra', conversation, 'user', 'Второе устройство');
  await Promise.all([a.store.flush(), b.store.flush()]); await a.store.load('algebra');
  assert(a.store.snapshot('algebra').messages.length === 4, 'Concurrent devices append without overwriting each other');
  const newConversation = id(); a.store.select('algebra', newConversation);
  a.store.append('algebra', newConversation, 'user', 'Новый диалог'); await a.store.flush();
  assert(a.store.snapshot('algebra').messages.some(row => row.conversation_id === conversation), 'Starting a new chat preserves previous conversations');
  const reloaded = device('alice', a.disk);
  assert(reloaded.store.snapshot('algebra').active === newConversation, 'Selected conversation survives a reload');

  fail = true;
  reloaded.store.append('reading', id(), 'user', 'Объясни transitions');
  await reloaded.store.flush();
  assert(reloaded.store.snapshot('reading').unsent === 1 && reloaded.store.snapshot('reading').error, 'Offline messages remain queued in local storage');
  const afterRestart = device('alice', a.disk); fail = false;
  await afterRestart.store.load('reading');
  assert(afterRestart.store.snapshot('reading').unsent === 0 && [...remote.values()].some(row => row.topic === 'reading'), 'A reload retries offline messages');
  lostAcknowledgment = true;
  afterRestart.store.append('data', id(), 'user', 'Сохрани один раз'); await afterRestart.store.flush();
  assert(afterRestart.store.snapshot('data').unsent === 1, 'Failed acknowledgment keeps pending message');
  const count = remote.size; await afterRestart.store.flush();
  assert(remote.size === count && afterRestart.store.snapshot('data').unsent === 0, 'Retry is idempotent');
  afterRestart.switchTo('bob');
  assert(afterRestart.store.snapshot('algebra').messages.length === 0 && afterRestart.store.snapshot('reading').messages.length === 0, 'Switching account hides all previous account messages');
  afterRestart.store.append('algebra', id(), 'user', 'Привет от Боба'); await afterRestart.store.flush();
  assert([...remote.values()].some(row => row.user_id === 'bob') && a.store.snapshot('algebra').messages.every(row => row.content !== 'Привет от Боба'), 'New messages keep the current owner');

  const pageConversation = id();
  for (let index = 0; index < 105; index++) {
    const row = { user_id: 'pages', id: id(), conversation_id: pageConversation, topic: 'geometry', role: 'user', content: 'Вопрос ' + index, answer: null, created_at: new Date(time).toISOString() };
    remote.set('pages:' + row.id, row);
  }
  const pages = device('pages'); await pages.store.load('geometry');
  assert(pages.store.snapshot('geometry').messages.length === 100 && pages.store.snapshot('geometry').more, 'Long history loads one bounded page');
  await pages.store.load('geometry', true);
  assert(pages.store.snapshot('geometry').messages.length === 105 && !pages.store.snapshot('geometry').more, 'Cursor loads older messages with identical timestamps without dropping rows');

  let release;
  deferred = new Promise(resolve => { release = resolve; });
  const race = device('alice'), loading = race.store.load('algebra'); race.switchTo('bob');
  deferred = null; release(); await loading;
  assert(race.store.snapshot('algebra').messages.length === 0, 'A late response cannot populate a different account');
  fail = true; const offline = device('offline');
  const before = pushes;
  offline.store.append('algebra', id(), 'user', 'Первый'); offline.store.append('reading', id(), 'user', 'Второй');
  await offline.store.flush(); for (let i = 0; i < 20; i++) await Promise.resolve();
  assert(pushes - before === 1, 'Failed writes do not spin in an automatic retry loop');
  assert(model.cleanMessage({ id: '../bad' }) === null && model.cleanAnswer({ ...answer, steps: [{}] }) === null, 'Malformed remote content is discarded');
  return 'Chat history: account/topic isolation, full answers, two devices, archive, pagination, offline recovery, idempotent retry and account-change race passed';
}
