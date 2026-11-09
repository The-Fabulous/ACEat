'use strict';

(() => {
  const sourceUrl = value => {
    try { const url = new URL(value); return url.protocol === 'https:' && url.hostname === 'satsuite.collegeboard.org' && /^\/media\/pdf\/[a-z0-9-]+\.pdf$/.test(url.pathname) ? url.href : null; } catch { return null; }
  };
  function numberValue(value) {
    const text = String(value).trim().replace(/−/g, '-').replace(',', '.');
    if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)(?:\/\d+)?$/.test(text) || text.length > 24) return null;
    const [numerator, denominator = '1'] = text.split('/').map(Number);
    const result = numerator / Number(denominator);
    return Number.isFinite(result) ? result : null;
  }
  function questions(exam) {
    return exam.modules.flatMap((module, moduleIndex) => module.questions.map(question => ({ ...question, id: `${module.id}:${question.number}`, moduleIndex, section: module.section })));
  }
  function validAnswer(question, value) {
    return question.type === 'choice' ? /^[ABCD]$/.test(value || '') : numberValue(value || '') !== null;
  }
  function isCorrect(question, value) {
    if (!validAnswer(question, value)) return false;
    if (question.type === 'choice') return question.answers.includes(value);
    const actual = numberValue(value);
    return question.answers.some(expected => Math.abs(actual - numberValue(expected)) <= 1e-10 * Math.max(1, Math.abs(numberValue(expected))));
  }
  function validate(exam, id) {
    if (!exam || exam.format !== 'aceat.paper-exam.v1' || exam.id !== id || !Number.isInteger(exam.revision) || !sourceUrl(exam.paper_url) || !sourceUrl(exam.scoring_url) || !sourceUrl(exam.explanations_url) || typeof exam.title !== 'string' || !Number.isInteger(exam.page_count) || !Array.isArray(exam.modules) || exam.modules.length !== 4) throw new Error('Некорректные данные варианта.');
    const ids = new Set();
    for (const module of exam.modules) {
      if (!module || !/^[a-z0-9-]+$/.test(module.id) || ids.has(module.id) || !['reading', 'math'].includes(module.section) || typeof module.title !== 'string' || !Array.isArray(module.questions) || !module.questions.length || module.questions.length > 100) throw new Error('Повреждены данные модуля.');
      ids.add(module.id);
      module.questions.forEach((q, index) => {
        if (!q || q.number !== index + 1 || !Number.isInteger(q.page) || q.page < 1 || q.page > exam.page_count || !['choice', 'number'].includes(q.type) || !Array.isArray(q.answers) || !q.answers.length || q.answers.length > 8 || q.answers.some(answer => typeof answer !== 'string' || !validAnswer(q, answer)) || (q.type === 'choice' && q.answers.length !== 1)) throw new Error('Повреждены данные вопроса.');
      });
    }
    for (const section of ['reading', 'math']) {
      const total = questions(exam).filter(q => q.section === section).length;
      const table = exam.scoring?.[section];
      if (!total || !Array.isArray(table) || table.length !== total + 1 || table.some((row, index) => !Array.isArray(row) || row.length !== 2 || row.some(n => !Number.isInteger(n) || n < 200 || n > 800) || row[0] > row[1] || (index && (row[0] < table[index - 1][0] || row[1] < table[index - 1][1])))) throw new Error('Повреждена таблица баллов.');
    }
    return exam;
  }
  function restore(exam, saved) {
    const list = questions(exam);
    const state = { answers: {}, flags: [], index: 0, submitted: false };
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return state;
    for (const q of list) {
      const value = saved.answers?.[q.id];
      if (typeof value === 'string' && value.length <= 24) state.answers[q.id] = value;
      if (Array.isArray(saved.flags) && saved.flags.includes(q.id)) state.flags.push(q.id);
    }
    if (Number.isInteger(saved.index) && saved.index >= 0 && saved.index < list.length) state.index = saved.index;
    state.submitted = saved.submitted === true;
    return state;
  }
  function grade(exam, answers) {
    const rows = questions(exam).map(q => ({ ...q, value: answers[q.id] || '', answered: validAnswer(q, answers[q.id]), correct: isCorrect(q, answers[q.id]) }));
    const result = { total: rows.length, correct: rows.filter(q => q.correct).length, unanswered: rows.filter(q => !q.answered).length, questions: rows, sections: {} };
    for (const section of ['reading', 'math']) {
      const group = rows.filter(q => q.section === section);
      const correct = group.filter(q => q.correct).length;
      result.sections[section] = { total: group.length, correct, range: exam.scoring[section][correct] };
    }
    result.range = [0, 1].map(index => result.sections.reading.range[index] + result.sections.math.range[index]);
    return result;
  }
  globalThis.ACEatExamEngine = { sourceUrl, numberValue, questions, validAnswer, isCorrect, validate, restore, grade };
  if (typeof document === 'undefined') return;

  const get = id => document.getElementById(id);
  const manifests = new Map();
  let exam, state, list, page, generation = 0, confirmation;
  let pdfLibrary, pdfTask, renderTask, renderGeneration = 0, zoom = 1;
  const PDF_JS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/';
  function releasePaper() {
    renderGeneration += 1;
    renderTask?.cancel(); renderTask = null;
    if (pdfTask) pdfTask.destroy().catch(() => {});
    pdfTask = null;
    get('exam-paper').width = 0; get('exam-paper').height = 0;
  }
  async function renderPage(value) {
    const token = ++renderGeneration;
    renderTask?.cancel(); renderTask = null;
    get('exam-paper-status').textContent = 'Открываем страницу заданий…';
    try {
      if (!pdfLibrary) pdfLibrary = import(`${PDF_JS}build/pdf.min.mjs`).then(library => {
        library.GlobalWorkerOptions.workerSrc = `${PDF_JS}build/pdf.worker.min.mjs`;
        return library;
      }).catch(error => { pdfLibrary = null; throw error; });
      const library = await pdfLibrary;
      if (token !== renderGeneration || !exam) return;
      if (!pdfTask) {
        const base = new URL(window.ACEAT_CHAT_API || './', document.baseURI);
        const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
        if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new Error('Unsupported source address');
        const url = new URL(`${base.pathname.replace(/\/$/, '')}/api/papers/${exam.id}`, base);
        pdfTask = library.getDocument({ url: url.href, disableRange: true, disableStream: true, isEvalSupported: false, useWasm: false, standardFontDataUrl: `${PDF_JS}standard_fonts/` });
      }
      const documentPdf = await pdfTask.promise;
      const documentPage = await documentPdf.getPage(value);
      if (token !== renderGeneration || !exam) return;
      const canvas = get('exam-paper');
      const width = Math.max(280, get('exam-paper-view').clientWidth - 2) * zoom;
      const viewport = documentPage.getViewport({ scale: width / documentPage.getViewport({ scale: 1 }).width });
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio);
      canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.setAttribute('aria-label', `Страница ${value} оригинальных заданий ${exam.title}`);
      renderTask = documentPage.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (token !== renderGeneration) return;
      get('exam-paper-status').textContent = '';
      get('exam-paper-view').scrollTop = 0;
    } catch (error) {
      if (token === renderGeneration && error.name !== 'RenderingCancelledException') {
        console.warn('SAT page viewer:', error.message);
        get('exam-paper-status').textContent = 'Не удалось загрузить страницу заданий. Проверь соединение и доступность сервера или открой оригинал по ссылке выше.';
        if (pdfTask) pdfTask.destroy().catch(() => {});
        pdfTask = null;
      }
    }
  }
  function storageKey() { return `aceat:exam:${exam.id}:v${exam.revision}`; }
  function save() {
    try { localStorage.setItem(storageKey(), JSON.stringify(state)); get('exam-save-status').textContent = 'Прогресс сохранён в этом браузере'; }
    catch { get('exam-save-status').textContent = 'Браузер блокирует сохранение. Прогресс доступен до закрытия страницы.'; }
  }
  function setPage(next) {
    const value = Math.min(exam.page_count, Math.max(1, next));
    if (page !== value) {
      page = value;
      renderPage(page);
    }
    get('exam-page-number').textContent = `Страница ${page} / ${exam.page_count}`;
    get('exam-page-prev').disabled = page === 1;
    get('exam-page-next').disabled = page === exam.page_count;
  }
  function renderNavigation() {
    const question = list[state.index];
    const module = exam.modules[question.moduleIndex];
    get('exam-module').value = String(question.moduleIndex);
    const nav = get('exam-question-grid'); nav.replaceChildren();
    module.questions.forEach(q => {
      const index = list.findIndex(item => item.id === `${module.id}:${q.number}`);
      const row = list[index];
      const answered = validAnswer(row, state.answers[row.id]);
      const flag = state.flags.includes(row.id);
      const button = addText(nav, 'button', String(q.number), 'exam-number'); button.type = 'button';
      button.dataset.state = state.submitted ? (isCorrect(row, state.answers[row.id]) ? 'correct' : answered ? 'wrong' : 'blank') : answered ? 'answered' : 'blank';
      button.dataset.flagged = String(flag);
      button.setAttribute('aria-label', `Вопрос ${q.number}${answered ? ', ответ записан' : ', без ответа'}${flag ? ', отмечен' : ''}`);
      if (index === state.index) button.setAttribute('aria-current', 'step');
      button.addEventListener('click', () => selectQuestion(index));
    });
    const count = list.filter(q => validAnswer(q, state.answers[q.id])).length;
    get('exam-progress').textContent = `Ответов: ${count} / ${list.length}`;
    get('exam-progress-bar').value = count; get('exam-progress-bar').max = list.length;
  }
  function renderQuestion() {
    const question = list[state.index];
    const value = state.answers[question.id] || '';
    get('exam-question-title').textContent = `Вопрос ${question.number} из ${exam.modules[question.moduleIndex].questions.length}`;
    get('exam-module-title').textContent = exam.modules[question.moduleIndex].title;
    const choices = get('exam-choices'); choices.replaceChildren(); choices.hidden = question.type !== 'choice';
    addText(choices, 'legend', 'Выбери ответ');
    for (const letter of ['A', 'B', 'C', 'D']) {
      const label = document.createElement('label'); label.className = 'exam-option';
      const radio = document.createElement('input'); radio.type = 'radio'; radio.name = 'exam-answer'; radio.value = letter; radio.checked = value === letter; radio.disabled = state.submitted;
      radio.addEventListener('change', () => recordAnswer(letter));
      label.append(radio, document.createTextNode(letter)); choices.append(label);
    }
    get('exam-numeric-wrap').hidden = question.type !== 'number';
    get('exam-numeric').value = value; get('exam-numeric').disabled = state.submitted;
    get('exam-input-help').textContent = 'Можно вводить целое число, десятичную дробь или обычную дробь: −12, 0.25, 1/4.';
    get('exam-numeric').removeAttribute('aria-invalid');
    get('exam-flag').checked = state.flags.includes(question.id);
    get('exam-clear-answer').disabled = state.submitted || !value;
    get('exam-prev').disabled = state.index === 0;
    get('exam-next').disabled = state.index === list.length - 1;
    get('exam-finish').hidden = state.submitted;
    const feedback = get('exam-feedback'); feedback.hidden = !state.submitted;
    if (state.submitted) {
      const correct = isCorrect(question, value);
      feedback.dataset.correct = String(correct);
      feedback.textContent = `${correct ? 'Верно' : validAnswer(question, value) ? 'Неверно' : 'Без ответа'}. Твой ответ: ${value || '—'}. Правильный ответ: ${question.answers.join(' или ')}.`;
    }
    setPage(question.page);
    renderNavigation();
  }
  function recordAnswer(value) {
    if (!exam || state.submitted) return;
    const question = list[state.index];
    state.answers[question.id] = value;
    get('exam-clear-answer').disabled = !value;
    if (question.type === 'number') {
      const invalid = Boolean(value) && !validAnswer(question, value);
      get('exam-numeric').setAttribute('aria-invalid', String(invalid));
      get('exam-input-help').textContent = invalid ? 'Введи число или дробь. Например: −12, 0.25, 1/4. Знаменатель должен отличаться от нуля.' : 'Можно вводить целое число, десятичную дробь или обычную дробь: −12, 0.25, 1/4.';
    }
    save(); renderNavigation();
  }
  function selectQuestion(index) { state.index = index; save(); renderQuestion(); }
  const rangeText = range => range[0] === range[1] ? String(range[0]) : `${range[0]}–${range[1]}`;
  function renderResult() {
    const root = get('exam-result'); root.hidden = !state.submitted; root.replaceChildren();
    if (!state.submitted) return;
    const result = grade(exam, state.answers);
    addText(root, 'p', 'ПОПЫТКА ЗАВЕРШЕНА', 'tiny-label');
    addText(root, 'h2', `${result.correct} из ${result.total} верно`);
    addText(root, 'p', `Без ответа: ${result.unanswered}. Ориентировочный диапазон SAT: ${rangeText(result.range)}.`);
    const scores = document.createElement('div'); scores.className = 'exam-scores';
    for (const [key, title] of [['reading', 'Reading & Writing'], ['math', 'Math']]) {
      const section = result.sections[key]; const block = document.createElement('div');
      addText(block, 'strong', title); addText(block, 'span', `${section.correct} / ${section.total} · ${rangeText(section.range)} баллов`); scores.append(block);
    }
    root.append(scores);
    addText(root, 'p', 'Диапазон рассчитан по официальной таблице для этого неадаптивного бумажного варианта.', 'editor-help');
    const review = addText(root, 'button', 'Разобрать ошибки', 'button secondary'); review.type = 'button';
    const firstWrong = result.questions.findIndex(q => !q.correct); review.disabled = firstWrong < 0;
    review.addEventListener('click', () => { selectQuestion(firstWrong); get('exam-question-title').scrollIntoView({ behavior: 'smooth', block: 'center' }); });
    const link = addText(root, 'a', 'Официальные объяснения ответов ↗', 'exam-source'); link.href = sourceUrl(exam.explanations_url); link.target = '_blank'; link.rel = 'noopener noreferrer';
  }
  function confirmAction(title, text, label, action) {
    get('exam-confirm-title').textContent = title; get('exam-confirm-text').textContent = text;
    get('exam-confirm-ok').textContent = label; confirmation = action; get('exam-confirm').showModal();
  }
  get('exam-confirm-cancel').addEventListener('click', () => { confirmation = null; get('exam-confirm').close(); });
  get('exam-confirm-ok').addEventListener('click', () => { const action = confirmation; confirmation = null; get('exam-confirm').close(); action?.(); });
  get('exam-module').addEventListener('change', event => selectQuestion(list.findIndex(q => q.moduleIndex === Number(event.target.value))));
  get('exam-numeric').addEventListener('input', event => recordAnswer(event.target.value));
  get('exam-flag').addEventListener('change', event => {
    const id = list[state.index].id; state.flags = state.flags.filter(item => item !== id);
    if (event.target.checked) state.flags.push(id); save(); renderNavigation();
  });
  get('exam-clear-answer').addEventListener('click', () => { recordAnswer(''); renderQuestion(); });
  get('exam-prev').addEventListener('click', () => selectQuestion(state.index - 1));
  get('exam-next').addEventListener('click', () => selectQuestion(state.index + 1));
  get('exam-page-prev').addEventListener('click', () => setPage(page - 1));
  get('exam-page-next').addEventListener('click', () => setPage(page + 1));
  get('exam-zoom').addEventListener('click', () => {
    zoom = zoom === 1 ? 1.5 : 1;
    get('exam-zoom').textContent = zoom === 1 ? '150%' : '100%';
    get('exam-zoom').setAttribute('aria-label', zoom === 1 ? 'Увеличить страницу' : 'Вписать страницу по ширине');
    renderPage(page);
  });
  get('exam-finish').addEventListener('click', () => {
    const unanswered = grade(exam, state.answers).unanswered;
    confirmAction('Завершить попытку?', unanswered ? `Без ответа осталось ${unanswered} вопросов. Можно вернуться к ним или проверить текущие ответы.` : 'Все ответы записаны. Проверить результат?', 'Проверить ответы', () => { state.submitted = true; save(); renderQuestion(); renderResult(); get('exam-result').scrollIntoView({ behavior: 'smooth' }); });
  });
  get('exam-restart').addEventListener('click', () => confirmAction('Начать заново?', 'Текущие ответы и результат этого варианта будут заменены новой попыткой.', 'Начать заново', () => { state = restore(exam, null); save(); renderResult(); renderQuestion(); }));
  function leave() {
    generation += 1; exam = null; page = null; confirmation = null;
    releasePaper(); get('exam-confirm').close();
  }
  async function open(id) {
    const token = ++generation;
    exam = null; page = null; releasePaper();
    get('exam-title').textContent = 'Открываем вариант…'; get('exam-state').hidden = false; get('exam-state').textContent = 'Загружаем задания и ключи…'; get('exam-body').hidden = true;
    await catalogReady;
    try {
      const entry = catalog.pastExams.find(item => item.id === id);
      if (catalogFailed || !entry || !/^\.\/data\/exams\/[a-z0-9-]+\.json$/.test(entry.exam_path || '')) throw new Error('Вариант недоступен. Вернись к списку экзаменов и попробуй ещё раз.');
      let data = manifests.get(id);
      if (!data) {
        const response = await fetch(entry.exam_path, { cache: 'no-cache' });
        if (!response.ok) throw new Error('Не удалось загрузить вариант. Проверь соединение и обнови страницу.');
        data = validate(await response.json(), id); manifests.set(id, data);
      }
      if (token !== generation || location.hash !== `#exam/${id}`) return;
      exam = data; list = questions(exam);
      let saved; try { saved = JSON.parse(localStorage.getItem(storageKey())); } catch { saved = null; }
      state = restore(exam, saved);
      get('exam-title').textContent = exam.title; document.title = `ACEat — ${exam.title}`;
      get('exam-module').replaceChildren();
      exam.modules.forEach((module, index) => { const option = addText(get('exam-module'), 'option', module.title); option.value = String(index); });
      get('exam-original').href = sourceUrl(exam.paper_url);
      get('exam-state').hidden = true; get('exam-body').hidden = false;
      save(); renderResult(); renderQuestion();
    } catch (error) {
      if (token !== generation) return;
      get('exam-title').textContent = 'Вариант недоступен'; get('exam-state').textContent = error.message || 'Не удалось открыть вариант.';
    }
  }
  window.ACEatExams = { open, leave };
  const route = /^#exam\/([a-z][a-z0-9-]{0,63})$/.exec(location.hash);
  if (route) open(route[1]);
})();
