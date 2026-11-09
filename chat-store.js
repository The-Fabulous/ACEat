'use strict';

(() => {
  const topics = ['algebra', 'advanced', 'data', 'geometry', 'reading'];
  const uuid = value => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
  function cleanAnswer(value) {
    if (!value || !['formula', 'solve'].includes(value.intent) || typeof value.summary !== 'string' || value.summary.length > 4000 || typeof value.answer !== 'string' || value.answer.length > 4000 || !Array.isArray(value.steps) || value.steps.length > 16) return null;
    if (value.steps.some(step => !step || typeof step.explanation !== 'string' || step.explanation.length > 2000 || typeof step.formula !== 'string' || step.formula.length > 2000)) return null;
    return { intent: value.intent, summary: value.summary, answer: value.answer, steps: value.steps.map(step => ({ explanation: step.explanation, formula: step.formula })) };
  }
  const answerText = answer => [answer.summary, ...answer.steps.map(step => `${step.explanation} ${step.formula}`.trim()), answer.answer].filter(Boolean).join('\n');
  function cleanMessage(value) {
    if (!value || !uuid(value.id) || !uuid(value.conversation_id) || !topics.includes(value.topic) || !['user', 'assistant'].includes(value.role) || typeof value.content !== 'string' || value.content.length > 80000 || !Number.isFinite(Date.parse(value.created_at))) return null;
    const answer = value.role === 'assistant' ? cleanAnswer(value.answer) : null;
    if (value.role === 'assistant' && !answer || value.role === 'user' && (!value.content.trim() || value.content.length > 3000)) return null;
    return { id: value.id, conversation_id: value.conversation_id, topic: value.topic, role: value.role, content: value.content, answer, created_at: new Date(value.created_at).toISOString() };
  }
  const compare = (a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id);
  function createStore(adapter) {
    const cache = new Map(), running = new Map();
    const key = (owner, topic) => `aceat:${owner ? `user:${owner}` : 'guest'}:chat:${topic}`;
    function entry(owner, topic) {
      if (!topics.includes(topic)) throw new Error('Unknown chat topic');
      const id = key(owner, topic);
      if (!cache.has(id)) {
        const raw = adapter.read(id), rows = new Map();
        for (const item of Array.isArray(raw?.messages) ? raw.messages : []) { const row = cleanMessage(item); if (row && row.topic === topic) rows.set(row.id, row); }
        cache.set(id, { messages: [...rows.values()].sort(compare), unsent: new Set(owner && Array.isArray(raw?.unsent) ? raw.unsent.filter(id => rows.has(id)) : []), active: uuid(raw?.active) ? raw.active : null, error: false, persisted: true, more: false, cursor: null, loaded: false });
      }
      return cache.get(id);
    }
    function persist(owner, topic, state) {
      state.persisted = adapter.write(key(owner, topic), { messages: state.messages, unsent: [...state.unsent], active: state.active });
      if (owner === adapter.identity()) adapter.changed?.();
    }
    function snapshot(topic) {
      const owner = adapter.identity(), state = entry(owner, topic);
      return { ...state, messages: state.messages.slice(), unsent: state.unsent.size, owner };
    }
    function select(topic, conversation) { if (!uuid(conversation)) return; const owner = adapter.identity(), state = entry(owner, topic); state.active = conversation; persist(owner, topic, state); }
    function append(topic, conversation, role, value) {
      const owner = adapter.identity(), state = entry(owner, topic), answer = role === 'assistant' ? cleanAnswer(value) : null;
      const previous = state.messages.at(-1)?.created_at;
      const row = cleanMessage({ id: adapter.randomId(), conversation_id: conversation, topic, role, content: role === 'user' ? value : answer ? answerText(answer) : '', answer, created_at: new Date(Math.max(adapter.now(), previous ? Date.parse(previous) + 1 : 0)).toISOString() });
      if (!row) throw new Error('Invalid chat message');
      state.messages.push(row); state.active = conversation;
      if (owner) state.unsent.add(row.id);
      persist(owner, topic, state);
      if (owner) void flush(owner);
      return row;
    }
    function flush(owner = adapter.identity()) {
      if (!owner) return Promise.resolve();
      if (running.has(owner)) return running.get(owner);
      let failed = false;
      const task = (async () => {
        for (const topic of topics) {
          const state = entry(owner, topic);
          while (state.unsent.size && adapter.identity() === owner) {
            const batch = state.messages.filter(row => state.unsent.has(row.id)).slice(0, 4);
            try { await adapter.push(owner, batch); }
            catch { failed = true; state.error = true; persist(owner, topic, state); return; }
            if (adapter.identity() !== owner) return;
            batch.forEach(row => state.unsent.delete(row.id)); state.error = false; persist(owner, topic, state);
          }
        }
      })().finally(() => {
        running.delete(owner);
        // A new message may have arrived for a topic already processed above.
        if (!failed && adapter.identity() === owner && topics.some(topic => entry(owner, topic).unsent.size)) void flush(owner);
      });
      running.set(owner, task); return task;
    }
    async function load(topic, older = false) {
      const owner = adapter.identity(), state = entry(owner, topic);
      if (!owner) return snapshot(topic);
      try {
        const rows = await adapter.fetch(owner, topic, older ? state.cursor : null);
        if (adapter.identity() !== owner) return snapshot(topic);
        const merged = new Map(state.messages.map(row => [row.id, row]));
        for (const raw of rows) {
          const row = cleanMessage(raw); if (!row || row.topic !== topic) continue;
          merged.set(row.id, row); state.unsent.delete(row.id);
        }
        state.messages = [...merged.values()].sort(compare);
        const last = rows.at(-1);
        if (uuid(last?.id) && Number.isFinite(Date.parse(last?.created_at))) state.cursor = { id: last.id, created_at: new Date(last.created_at).toISOString() };
        state.more = rows.length === 100; state.loaded = true; state.error = false;
        persist(owner, topic, state); await flush(owner);
      } catch { if (adapter.identity() === owner) { state.error = true; persist(owner, topic, state); } }
      return snapshot(topic);
    }
    return { snapshot, select, append, flush, load };
  }
  globalThis.ACEatChatModel = { topics, uuid, cleanAnswer, cleanMessage, answerText, compare, createStore };
  if (typeof document === 'undefined') return;
  const account = window.ACEatAccount;
  window.ACEatChatStore = createStore({ identity: () => account.identity(), now: () => Date.now(), randomId: () => crypto.randomUUID(),
    read: key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } },
    write: (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } },
    fetch: (owner, topic, cursor) => account.fetchChatPage(owner, topic, cursor), push: (owner, rows) => account.pushChatMessages(owner, rows),
    changed: () => window.dispatchEvent(new CustomEvent('aceat:chat-updated')) });
})();
