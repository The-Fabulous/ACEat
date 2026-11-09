'use strict';

(() => {
  const topics = [
    { id: 'algebra', group: 'MATH', title: 'Algebra' },
    { id: 'advanced', group: 'MATH', title: 'Advanced Math' },
    { id: 'data', group: 'MATH', title: 'Data Analysis' },
    { id: 'geometry', group: 'MATH', title: 'Geometry & Trig' },
    { id: 'reading', group: 'R&W', title: 'Reading & Writing' }
  ];
  const get = id => document.getElementById(id), account = window.ACEatAccount, store = window.ACEatChatStore;
  const model = globalThis.ACEatChatModel;
  const messages = get('chat-messages'), input = get('chat-input'), status = get('chat-status');
  const controls = document.querySelectorAll('#chat-form button, [data-prompt]');
  let topic = topics[0], conversationId, viewerOwner, activeRequest = null, failure = null;
  let loading = true, initialized = false, viewVersion = 0, transcriptVersion = 0, visibleCount = 40, signature = '';
  const newId = () => crypto.randomUUID();
  const scrollMessages = () => { messages.scrollTop = messages.scrollHeight; };
  const threadMessages = () => store.snapshot(topic.id).messages.filter(row => row.conversation_id === conversationId);

  function endpoint() {
    const configured = String(window.ACEAT_CHAT_API || '').trim();
    if (!configured && location.hostname.endsWith('github.io')) throw new Error('Помощник пока недоступен: подключение к серверу ещё настраивается.');
    const base = new URL(configured || './', document.baseURI);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new Error('Для подключения ИИ нужен HTTPS-адрес сервера.');
    return new URL(base.pathname.replace(/\/$/, '') + '/api/chat', base);
  }
  function addMessage(text, user = false) {
    const element = document.createElement('div'); element.className = user ? 'message user-message' : 'message';
    addText(element, 'span', user ? 'ТЫ' : 'ACEat TUTOR', 'message-label');
    if (text) addText(element, 'div', text);
    messages.append(element); return element;
  }
  function renderAnswer(answer) {
    const element = addMessage('');
    if (answer.summary) addText(element, 'p', answer.summary);
    const steps = document.createElement('ol'); steps.className = 'chat-steps';
    for (const step of answer.steps) {
      const item = document.createElement('li'); addText(item, 'div', step.explanation);
      if (step.formula) {
        const formula = step.formula.trim().replace(/^(\$\$?|\\\[|\\\()/, '').replace(/(\$\$?|\\\]|\\\))$/, '');
        addText(item, 'div', '\\[' + formula + '\\]', 'chat-formula');
      }
      steps.append(item);
    }
    if (steps.children.length) element.append(steps);
    if (answer.answer) addText(element, 'p', answer.answer, 'chat-answer');
  }
  function renderTranscript(state) {
    const all = state.messages.filter(row => row.conversation_id === conversationId), rows = all.slice(-visibleCount);
    const next = [viewerOwner, topic.id, conversationId, rows.map(row => row.id).join(','), Boolean(activeRequest), loading, failure?.description || ''].join('|');
    if (next === signature) return;
    signature = next; const token = ++transcriptVersion; messages.replaceChildren();
    if (!rows.length) addMessage(loading ? 'Загружаем историю…' : 'Привет! Разберём ' + topic.title + '. Пришли вопрос или условие задачи, попроси объяснить правило или показать пример.');
    let math = false;
    for (const row of rows) {
      if (row.role === 'user') addMessage(row.content, true);
      else { renderAnswer(row.answer); math ||= row.answer.steps.some(step => step.formula) || /\\[([]/.test(row.content); }
    }
    if (activeRequest) addMessage('Разбираю вопрос…');
    else if (!loading && rows.at(-1)?.role === 'user') {
      const last = rows.at(-1), box = addMessage(failure?.description || 'Ответ на этот вопрос не завершён. Можно повторить запрос.');
      box.classList.add('chat-error');
      const retry = addText(box, 'button', 'Повторить вопрос', 'chat-retry'); retry.type = 'button';
      retry.addEventListener('click', () => sendChat(last.content, last.id));
    }
    scrollMessages();
    if (math) loadMath().then(() => { if (token === transcriptVersion) return window.MathJax.typesetPromise([messages]); }).catch(() => {});
  }
  function render() {
    if (!initialized || viewerOwner !== account.identity()) return;
    const state = store.snapshot(topic.id), threads = new Map();
    for (const row of state.messages) {
      let item = threads.get(row.conversation_id);
      if (!item) { item = { id: row.conversation_id, first: row, last: row }; threads.set(item.id, item); }
      item.last = row;
      if (item.first.role !== 'user' && row.role === 'user') item.first = row;
    }
    const select = get('chat-conversation'); select.replaceChildren();
    const ordered = [...threads.values()].sort((a, b) => model.compare(b.last, a.last));
    if (!threads.has(conversationId)) { const option = addText(select, 'option', 'Новый диалог'); option.value = conversationId; }
    for (const item of ordered) {
      const date = new Date(item.first.created_at).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
      const title = item.first.role === 'user' ? item.first.content : 'Диалог по теме';
      const option = addText(select, 'option', date + ' · ' + title.replace(/\s+/g, ' ').slice(0, 65)); option.value = item.id;
    }
    select.value = conversationId;
    controls.forEach(button => { button.disabled = loading || Boolean(activeRequest); });
    select.disabled = loading;
    get('chat-sync').disabled = loading || Boolean(activeRequest);
    messages.setAttribute('aria-busy', String(loading || Boolean(activeRequest)));
    status.textContent = activeRequest ? 'Готовим разбор…' : loading ? 'Загружаем историю…' : 'ИИ по темам';
    get('chat-topic-name').textContent = topic.title;
    const historyStatus = get('chat-history-status');
    historyStatus.textContent = !state.persisted ? (viewerOwner && !state.unsent && !state.error ? 'История сохранена в аккаунте. Браузер блокирует локальную копию.' : 'Не удалось сохранить локальную копию. Не закрывай страницу до синхронизации.')
      : !viewerOwner ? 'История в этом браузере. Войди, чтобы сохранять новые диалоги в аккаунте.'
      : state.error ? 'История сохранена в этом браузере. Не удалось синхронизировать — нажми «Обновить».'
      : state.unsent ? 'Сохраняем историю в аккаунте…'
      : state.loaded ? 'История синхронизирована с аккаунтом' : 'История в этом браузере. Проверяем сохранение в аккаунте…';
    const hidden = state.messages.filter(row => row.conversation_id === conversationId).length > visibleCount;
    get('chat-load-older').hidden = !(hidden || state.more);
    get('chat-load-older').disabled = loading || Boolean(activeRequest);
    renderTranscript(state);
  }
  function stopRequest() { activeRequest?.abort(); activeRequest = null; failure = null; }
  async function openTopic() {
    const token = ++viewVersion; stopRequest(); loading = true; signature = ''; visibleCount = 40; input.value = '';
    viewerOwner = account.identity(); initialized = true;
    const local = store.snapshot(topic.id), preferred = local.active;
    conversationId = preferred || local.messages.at(-1)?.conversation_id || newId();
    render();
    await store.load(topic.id);
    if (token !== viewVersion || viewerOwner !== account.identity()) return;
    const state = store.snapshot(topic.id);
    if (!preferred && !local.messages.length) conversationId = state.messages.at(-1)?.conversation_id || conversationId;
    loading = false; store.select(topic.id, conversationId); render();
  }
  function resetChat() {
    if (!initialized) return;
    ++viewVersion; stopRequest(); loading = false; visibleCount = 40; signature = ''; input.value = '';
    conversationId = newId(); store.select(topic.id, conversationId); render();
  }
  async function refresh(older = false) {
    if (!initialized || loading || activeRequest) return;
    const token = viewVersion; loading = true; render();
    await store.load(topic.id, older);
    if (token !== viewVersion) return;
    loading = false; if (older) visibleCount += 40; render();
  }
  async function sendChat(text, retryId = null) {
    text = text.trim();
    if (!initialized || loading || !text || activeRequest || viewerOwner !== account.identity()) return;
    if (text.length > 3000) { status.textContent = 'Вопрос должен быть не длиннее 3000 символов'; return; }
    const rows = threadMessages(), retryIndex = rows.findIndex(row => row.id === retryId && row.role === 'user');
    if (retryId && (retryIndex < 0 || retryIndex !== rows.length - 1)) return;
    const history = (retryId ? rows.slice(0, retryIndex) : rows).slice(-8).map(row => ({ role: row.role, content: row.content.slice(0, 1200) }));
    const controller = new AbortController(), owner = viewerOwner, selectedTopic = topic.id, selectedConversation = conversationId;
    activeRequest = controller; failure = null; input.value = '';
    const timeout = setTimeout(() => controller.abort(), 135000);
    try {
      if (!retryId) store.append(selectedTopic, selectedConversation, 'user', text);
      render();
      const response = await fetch(endpoint(), { method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ topic: selectedTopic, message: text, history }), signal: controller.signal });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) throw new Error(data?.error || 'Помощник временно недоступен. Повтори вопрос позже.');
      const answer = model.cleanAnswer(data.answer);
      if (!answer) throw new Error('ИИ вернул неполный ответ. Повтори вопрос.');
      if (activeRequest !== controller || account.identity() !== owner) return;
      store.append(selectedTopic, selectedConversation, 'assistant', answer);
    } catch (error) {
      if (activeRequest !== controller || account.identity() !== owner) return;
      const description = error.name === 'AbortError' ? 'Ответ занял слишком много времени. Попробуй ещё раз.' : error instanceof TypeError ? 'Не удалось связаться с ИИ. Проверь соединение или попробуй позже.' : error.message;
      failure = { description };
      if (!input.value) input.value = text;
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) { activeRequest = null; render(); }
    }
  }
  for (const item of topics) {
    const button = document.createElement('button'); button.type = 'button'; button.className = 'topic-button';
    addText(button, 'span', item.group); button.append(document.createTextNode(item.title)); addText(button, 'small', '↗');
    button.dataset.topic = item.id; button.setAttribute('aria-pressed', String(item === topic));
    button.addEventListener('click', () => {
      topic = item;
      get('topic-list').querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      void openTopic();
    });
    get('topic-list').append(button);
  }
  const prompts = {
    explain: 'Объясни одно из ключевых правил этой темы для SAT и условия его применения.',
    example: 'Составь типичное задание SAT по этой теме и разбери решение по шагам.',
    mistakes: 'Разбери частые ошибки в этой теме на SAT и покажи, как их избежать.'
  };
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => sendChat(prompts[button.dataset.prompt])));
  get('clear-chat').addEventListener('click', resetChat);
  get('chat-form').addEventListener('submit', event => { event.preventDefault(); void sendChat(input.value); });
  get('chat-conversation').addEventListener('change', event => {
    ++viewVersion; stopRequest(); loading = false; visibleCount = 40; signature = ''; input.value = '';
    conversationId = event.target.value; store.select(topic.id, conversationId); render();
  });
  get('chat-sync').addEventListener('click', () => refresh());
  get('chat-load-older').addEventListener('click', () => {
    const state = store.snapshot(topic.id);
    if (threadMessages().length > visibleCount) { visibleCount += 40; render(); } else void refresh(true);
  });
  window.addEventListener('aceat:chat-updated', render);
  window.addEventListener('aceat:identity-changing', () => { if (initialized) void openTopic(); });
  window.addEventListener('online', () => { if (initialized) { void store.flush(); void refresh(); } });
  window.addEventListener('focus', () => { if (location.hash === '#chat') void refresh(); });
  window.addEventListener('hashchange', () => { if (location.hash === '#chat') void refresh(); });
  controls.forEach(button => { button.disabled = true; });
  account.ready.then(openTopic);
})();
