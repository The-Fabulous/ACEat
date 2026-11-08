'use strict';

(() => {
  const topics = [
    { id: 'algebra', group: 'MATH', title: 'Algebra' },
    { id: 'advanced', group: 'MATH', title: 'Advanced Math' },
    { id: 'data', group: 'MATH', title: 'Data Analysis' },
    { id: 'geometry', group: 'MATH', title: 'Geometry & Trig' },
    { id: 'reading', group: 'R&W', title: 'Reading & Writing' }
  ];
  const messages = document.getElementById('chat-messages');
  const topicList = document.getElementById('topic-list');
  const input = document.getElementById('chat-input');
  const status = document.getElementById('chat-status');
  const controls = document.querySelectorAll('#chat-form button, [data-prompt]');
  let topic = topics[0];
  let chatHistory = [];
  let activeRequest = null;
  let errorMessage = null;

  function endpoint() {
    const configured = String(window.ACEAT_CHAT_API || '').trim();
    if (!configured && location.hostname.endsWith('github.io')) {
      throw new Error('Помощник пока недоступен: подключение к серверу ещё настраивается.');
    }
    const base = new URL(configured || './', document.baseURI);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) {
      throw new Error('Для подключения ИИ нужен HTTPS-адрес сервера.');
    }
    return new URL(`${base.pathname.replace(/\/$/, '')}/api/chat`, base);
  }

  function scrollMessages() { messages.scrollTop = messages.scrollHeight; }

  function addMessage(text, user = false) {
    const element = document.createElement('div');
    element.className = user ? 'message user-message' : 'message';
    addText(element, 'span', user ? 'ТЫ' : 'ACEat TUTOR', 'message-label');
    if (text) addText(element, 'div', text);
    messages.append(element);
    while (messages.children.length > 40) messages.firstElementChild.remove();
    scrollMessages();
    return element;
  }

  function busy(value) {
    controls.forEach(button => { button.disabled = value; });
    messages.setAttribute('aria-busy', String(value));
    status.textContent = value ? 'Готовим разбор…' : 'ИИ по темам';
  }

  function resetChat() {
    activeRequest?.abort();
    activeRequest = null;
    chatHistory = [];
    errorMessage = null;
    busy(false);
    messages.replaceChildren();
    input.value = '';
    document.getElementById('chat-topic-name').textContent = topic.title;
    addMessage(`Привет! Разберём ${topic.title}. Пришли вопрос или условие задачи, попроси объяснить правило или показать пример.`);
    try { endpoint(); } catch (error) { status.textContent = 'Ожидает подключения'; }
  }

  function validAnswer(answer) {
    return answer && ['formula', 'solve'].includes(answer.intent) && typeof answer.summary === 'string' && typeof answer.answer === 'string' && Array.isArray(answer.steps) && answer.steps.length <= 16 && answer.steps.every(step => step && typeof step.explanation === 'string' && typeof step.formula === 'string');
  }

  async function sendChat(text, retry = false) {
    text = text.trim();
    if (!text || activeRequest) return;
    if (text.length > 3000) { status.textContent = 'Вопрос должен быть не длиннее 3000 символов'; return; }
    errorMessage?.remove();
    errorMessage = null;
    if (!retry) addMessage(text, true);
    input.value = '';
    const controller = new AbortController();
    activeRequest = controller;
    const timeout = setTimeout(() => controller.abort(), 135000);
    const pending = addMessage('Разбираю вопрос…');
    busy(true);
    try {
      const response = await fetch(endpoint(), {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, credentials: 'omit',
        body: JSON.stringify({ topic: topic.id, message: text, history: chatHistory }), signal: controller.signal
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data?.ok) {
        throw new Error(data?.error || 'Помощник временно недоступен. Повтори вопрос позже.');
      }
      if (!validAnswer(data.answer)) throw new Error('ИИ вернул неполный ответ. Повтори вопрос.');
      if (activeRequest !== controller) return;
      pending.remove();
      const answer = data.answer;
      const element = addMessage('');
      if (answer.summary) addText(element, 'p', answer.summary);
      const steps = document.createElement('ol');
      steps.className = 'chat-steps';
      for (const step of answer.steps) {
        const item = document.createElement('li');
        addText(item, 'div', step.explanation);
        if (step.formula) {
          const formula = step.formula.trim().replace(/^(\$\$?|\\\[|\\\()/, '').replace(/(\$\$?|\\\]|\\\))$/, '');
          addText(item, 'div', `\\[${formula}\\]`, 'chat-formula');
        }
        steps.append(item);
      }
      if (steps.children.length) element.append(steps);
      if (answer.answer) addText(element, 'p', answer.answer, 'chat-answer');
      const historyText = [answer.summary, ...answer.steps.map(step => `${step.explanation} ${step.formula}`), answer.answer].filter(Boolean).join('\n');
      chatHistory = [...chatHistory, { role: 'user', content: text.slice(0, 1200) }, { role: 'assistant', content: historyText.slice(0, 1200) }].slice(-8);
      if (answer.steps.some(step => step.formula) || /\\[([]/.test(historyText)) {
        loadMath().then(() => window.MathJax.typesetPromise([element])).then(scrollMessages).catch(() => {});
      }
      scrollMessages();
    } catch (error) {
      if (activeRequest !== controller) return;
      pending.remove();
      const description = error.name === 'AbortError' ? 'Ответ занял слишком много времени. Попробуй ещё раз.' : error instanceof TypeError ? 'Не удалось связаться с ИИ. Проверь соединение или попробуй позже.' : error.message;
      errorMessage = addMessage(description);
      errorMessage.classList.add('chat-error');
      const retryButton = addText(errorMessage, 'button', 'Повторить вопрос', 'chat-retry');
      retryButton.type = 'button';
      retryButton.addEventListener('click', () => sendChat(text, true));
      if (!input.value) input.value = text;
    } finally {
      clearTimeout(timeout);
      if (activeRequest === controller) { activeRequest = null; busy(false); }
    }
  }

  for (const item of topics) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'topic-button';
    addText(button, 'span', item.group);
    button.append(document.createTextNode(item.title));
    addText(button, 'small', '↗');
    button.dataset.topic = item.id;
    button.setAttribute('aria-pressed', String(item === topic));
    button.addEventListener('click', () => {
      topic = item;
      topicList.querySelectorAll('button').forEach(other => other.setAttribute('aria-pressed', String(other === button)));
      resetChat();
    });
    topicList.append(button);
  }
  const prompts = {
    explain: 'Объясни одно из ключевых правил этой темы для SAT и условия его применения.',
    example: 'Составь типичное задание SAT по этой теме и разбери решение по шагам.',
    mistakes: 'Разбери частые ошибки в этой теме на SAT и покажи, как их избежать.'
  };
  document.querySelectorAll('[data-prompt]').forEach(button => button.addEventListener('click', () => sendChat(prompts[button.dataset.prompt])));
  document.getElementById('clear-chat').addEventListener('click', resetChat);
  document.getElementById('chat-form').addEventListener('submit', event => { event.preventDefault(); sendChat(input.value); });
  resetChat();
})();
