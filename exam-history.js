'use strict';
(() => {
  const uuid = value => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '');
  const scoreFor = range => Math.round((range[0] + range[1]) / 20) * 10;
  const order = (a, b) => Date.parse(b.completed_at) - Date.parse(a.completed_at) || b.id.localeCompare(a.id);
  function legacyId(exam, state) {
    const text = JSON.stringify([exam.id, exam.revision, Object.entries(state.answers || {}).sort()]);
    const hex = [1, 2, 3, 4].map(seed => { let hash = 2166136261 ^ seed; for (let i = 0; i < text.length; i++) hash = Math.imul(hash ^ text.charCodeAt(i), 16777619); return (hash >>> 0).toString(16).padStart(8, '0'); }).join('');
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20)}`;
  }
  function clean(row) {
    if (!row || !uuid(row.id) || !/^[a-z][a-z0-9-]{0,63}$/.test(row.exam_id) || !Number.isFinite(Date.parse(row.completed_at)) || !Number.isInteger(row.score) || row.score < 400 || row.score > 1600 || !row.result || typeof row.result.title !== 'string' || !Array.isArray(row.result.range) || row.result.range.length !== 2 || row.result.range.some(n => !Number.isInteger(n) || n < 400 || n > 1600) || row.result.range[0] > row.result.range[1]) return null;
    return { id: row.id, exam_id: row.exam_id, completed_at: row.completed_at, score: row.score, is_demo: row.is_demo === true, result: row.result };
  }
  function build(exam, state, grade) {
    const result = grade(exam, state.answers);
    return { id: state.attemptId, exam_id: exam.id, completed_at: state.submittedAt, score: scoreFor(result.range), is_demo: false,
      result: { title: exam.title, revision: exam.revision, range: result.range, correct: result.correct, total: result.total, sections: result.sections, state: JSON.parse(JSON.stringify(state)), review: result.questions.map(q => ({ id: q.id, value: q.value, correct: q.correct, answers: q.answers })) } };
  }
  function summary(rows, target) { const latest = rows.slice().sort(order)[0]; return { latest, score: latest?.score ?? null, remaining: latest ? Math.max(0, target - latest.score) : null }; }
  globalThis.ACEatResultsModel = { uuid, scoreFor, legacyId, clean, build, summary };
  if (typeof document === 'undefined') return;
  const account = window.ACEatAccount, get = id => document.getElementById(id), caches = new Map();
  let target = 1400, visible = 20, generation = 0;
  const key = owner => `aceat:${owner ? `user:${owner}` : 'guest'}:exam-history`;
  function entry(owner = account.identity()) {
    const id = key(owner);
    if (!caches.has(id)) {
      let saved; try { saved = JSON.parse(localStorage.getItem(id)); } catch {}
      const rows = new Map((Array.isArray(saved?.rows) ? saved.rows : []).map(clean).filter(Boolean).map(row => [row.id, row]));
      caches.set(id, { rows, chartRows: Array.isArray(saved?.chartRows) ? saved.chartRows : [], chartComplete: false, pending: new Set((Array.isArray(saved?.pending) ? saved.pending : []).filter(id => rows.has(id))), more: false, offset: 0, error: false, persisted: true, flushing: null });
    }
    return caches.get(id);
  }
  function persist(owner, state) {
    try { localStorage.setItem(key(owner), JSON.stringify({ rows: [...state.rows.values()], chartRows: state.chartRows, pending: [...state.pending] })); state.persisted = true; } catch { state.persisted = false; }
    if (owner === account.identity()) render();
  }
  function render(nextTarget) {
    if (Number.isFinite(nextTarget)) target = nextTarget;
    const state = entry(), rows = [...state.rows.values()].sort(order), current = summary(rows, target);
    const chartRows = new Map(state.chartRows.map(row => [row.id, row]));
    for (const row of rows) chartRows.set(row.id, row);
    window.ACEatProgressChart?.render([...chartRows.values()], target, state.chartComplete || !account.identity(), account.identity());
    get('account-current-score').textContent = current.score === null ? '—' : String(current.score);
    get('account-score-gap').textContent = current.remaining === null ? '—' : String(current.remaining);
    get('account-score-note').textContent = current.latest ? `${current.latest.is_demo ? 'Демонстрационный результат' : 'Последняя завершённая попытка'} · диапазон ${current.latest.result.range.join('–')}` : 'Заверши пробник, чтобы увидеть свой результат';
    get('account-gap-note').textContent = current.remaining === 0 ? 'Цель достигнута' : 'баллов до твоей цели';
    get('account-history-status').textContent = state.error ? 'Не удалось синхронизировать историю. Нажми «Обновить историю».' : state.pending.size && account.identity() ? 'Сохраняем результаты…' : !state.persisted ? 'Браузер блокирует локальную копию истории.' : 'Каждая завершённая попытка сохраняется отдельно.';
    get('account-exams-value').textContent = String(rows.length) + (state.more ? '+' : '');
    const root = get('account-history-list'); root.replaceChildren();
    for (const row of rows.slice(0, visible)) {
      const card = document.createElement('article'); card.className = 'account-resource';
      addText(card, 'span', new Date(row.completed_at).toLocaleString('ru-RU') + (row.is_demo ? ' · ДЕМО' : ''), 'tiny-label');
      addText(card, 'h3', `${row.score} · ${row.result.title}`);
      addText(card, 'p', `Диапазон: ${row.result.range.join('–')}${Number.isInteger(row.result.correct) ? ` · Верно ${row.result.correct} из ${row.result.total}` : ''}`);
      if (row.is_demo) addText(card, 'p', 'Добавлено для демонстрации кабинета. Ответы на задания не моделировались.');
      else if (Array.isArray(row.result.review)) {
        const details = document.createElement('details'); addText(details, 'summary', 'Посмотреть ответы этой попытки');
        // Populate only when opened, so long histories stay light.
        details.addEventListener('toggle', () => {
          if (!details.open || details.dataset.loaded) return;
          details.dataset.loaded = 'true';
          for (const answer of row.result.review) addText(details, 'p', `${answer.id}: ${answer.value || 'без ответа'} · ${answer.correct ? 'верно' : `правильный ответ: ${Array.isArray(answer.answers) ? answer.answers.join(' / ') : '—'}`}`);
        }); card.append(details);
      }
      root.append(card);
    }
    if (!rows.length) addText(root, 'p', 'Здесь появятся результаты завершённых пробников.', 'account-empty');
    get('account-history-more').hidden = rows.length <= visible && !state.more;
  }
  function flush(owner = account.identity()) {
    if (!owner) return Promise.resolve();
    const state = entry(owner); if (state.flushing) return state.flushing;
    state.flushing = (async () => {
      for (const id of state.pending) {
        if (owner !== account.identity()) return;
        try { await account.pushResult(owner, state.rows.get(id)); }
        catch { state.error = true; persist(owner, state); return; }
        if (owner !== account.identity()) return;
        state.pending.delete(id); state.error = false; persist(owner, state);
      }
    })().finally(() => { state.flushing = null; }); return state.flushing;
  }
  function capture(exam, snapshot, expectedOwner = account.identity()) {
    if (expectedOwner !== account.identity()) return;
    if (!snapshot.submitted || !uuid(snapshot.attemptId) || !snapshot.submittedAt) return;
    const owner = account.identity(), state = entry(owner);
    if (state.rows.has(snapshot.attemptId)) return;
    const row = clean(build(exam, snapshot, window.ACEatExamEngine.grade)); if (!row) return;
    state.rows.set(row.id, row); if (owner) state.pending.add(row.id); persist(owner, state); void flush(owner);
  }
  async function backfill(owner, token) {
    await catalogReady;
    for (const item of catalog.pastExams) {
      if (owner !== account.identity() || token !== generation) return;
      const stub = { id: item.id, revision: 1 }, storage = account.examStorageKey(stub);
      let state; try { state = JSON.parse(localStorage.getItem(storage)); } catch {}
      if (!state?.submitted || !/^\.\/data\/exams\/[a-z0-9-]+\.json$/.test(item.exam_path || '')) continue;
      const response = await fetch(item.exam_path); if (!response.ok) continue;
      const exam = window.ACEatExamEngine.validate(await response.json(), item.id);
      if (owner !== account.identity() || token !== generation) return;
      if (!uuid(state.attemptId)) state.attemptId = legacyId(exam, state);
      if (!state.submittedAt) state.submittedAt = state.updatedAt || new Date().toISOString();
      try { localStorage.setItem(storage, JSON.stringify(state)); } catch {}
      account.saveExam(exam, state); capture(exam, state);
    }
  }
  async function refresh(older = false) {
    const owner = account.identity(), token = generation, state = entry(owner);
    if (!older) state.chartComplete = false;
    try {
      if (!older) await backfill(owner, token);
      if (owner !== account.identity() || token !== generation) return;
      if (!owner) { render(); return; }
      await flush(owner);
      const rows = await account.fetchResults(owner, older ? state.offset : 0);
      if (owner !== account.identity() || token !== generation) return;
      for (const raw of rows) { const row = clean(raw); if (row) { state.rows.set(row.id, row); state.pending.delete(row.id); } }
      state.offset = (older ? state.offset : 0) + rows.length; state.more = rows.length === 100; state.error = state.pending.size > 0; persist(owner, state);
      if (!older && account.fetchScorePage) {
        const scores = new Map(); let offset = 0;
        while (true) {
          const page = await account.fetchScorePage(owner, offset);
          if (owner !== account.identity() || token !== generation) return;
          for (const row of page) scores.set(row.id, row);
          offset += page.length;
          if (page.length < 1000) break;
        }
        state.chartRows = [...scores.values()]; state.chartComplete = true; persist(owner, state);
      }
    } catch { if (owner === account.identity() && token === generation) { state.error = true; render(); } }
  }
  window.ACEatResults = { capture, render, refresh };
  get('account-history-refresh').addEventListener('click', () => refresh());
  get('account-history-more').addEventListener('click', async () => { visible += 20; if (visible > entry().rows.size && entry().more) await refresh(true); render(); });
  get('account-import').addEventListener('click', () => {
    const owner = account.identity(); if (!owner) return;
    const state = entry(owner);
    for (const row of entry(null).rows.values()) if (!state.rows.has(row.id)) { state.rows.set(row.id, row); state.pending.add(row.id); }
    persist(owner, state); void refresh();
  });
  window.addEventListener('aceat:identity-changing', () => { generation++; visible = 20; render(); });
  window.addEventListener('aceat:identity-changed', () => refresh());
  window.addEventListener('aceat:cloud-refreshed', () => refresh());
  window.addEventListener('online', () => refresh());
  account.ready.then(() => refresh());
})();
