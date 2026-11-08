'use strict';

const routes = ['home', 'textbooks', 'chat', 'past-exams', 'challenge'];
const routeTitles = { home: 'Пространство подготовки к SAT', textbooks: 'Учебники', chat: 'ИИ по темам', 'past-exams': 'Прошлые экзамены', challenge: 'Challenge-экзамены' };
let routeInitialized = false;
let resolveCatalog;
const catalogReady = new Promise(resolve => { resolveCatalog = resolve; });
const loadedBooks = new Map();
function showRoute() {
  const requested = location.hash.slice(1);
  // The skip link targets main without changing the currently selected module.
  if (requested === 'main') { document.getElementById('main').focus(); return; }
  const bookRoute = /^book\/([a-z][a-z0-9-]{0,63})(?:\/(\d+))?$/.exec(requested);
  const route = bookRoute ? 'book' : routes.includes(requested) ? requested : 'home';
  if (requested && route !== requested && !bookRoute) history.replaceState(null, '', '#home');
  document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== route; });
  document.querySelectorAll('[data-route]').forEach(link => {
    const active = link.dataset.route === (route === 'book' ? 'textbooks' : route);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.title = `ACEat — ${routeTitles[route] || 'Учебник'}`;
  if (routeInitialized) { document.getElementById('main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  routeInitialized = true;
  if (bookRoute) openBook(bookRoute[1], Number(bookRoute[2] || 0), requested);
}
window.addEventListener('hashchange', showRoute);
showRoute();

const topics = [
  { id: 'algebra', group: 'MATH', title: 'Algebra', explain: 'Линейное уравнение описывает равенство, в котором переменная находится в первой степени. Чтобы найти неизвестное, выполняй одинаковые действия с обеими частями уравнения.', example: 'Решим 3x + 7 = 22.\n1. Вычтем 7 из обеих частей: 3x = 15.\n2. Разделим обе части на 3: x = 5.\n3. Проверим: 3 × 5 + 7 = 22.', mistakes: 'Частая ошибка — изменить только одну часть уравнения. Если вычитаешь 7 слева, вычти 7 и справа. В конце подставь найденное значение в исходное равенство.' },
  { id: 'advanced', group: 'MATH', title: 'Advanced Math', explain: 'Квадратное уравнение имеет вид ax² + bx + c = 0, где a ≠ 0. Один из способов решения — разложить выражение на множители и использовать правило нулевого произведения.', example: 'Решим x² − 5x + 6 = 0.\n1. Ищем числа с произведением 6 и суммой −5: −2 и −3.\n2. Получаем (x − 2)(x − 3) = 0.\n3. Значит, x = 2 или x = 3.', mistakes: 'При извлечении квадратного корня легко потерять отрицательное решение: из x² = 9 следует x = 3 или x = −3. Всегда проверяй оба значения и ограничения исходной задачи.' },
  { id: 'data', group: 'MATH', title: 'Data Analysis', explain: 'Процент — одна сотая часть величины. Чтобы найти p% от числа A, вычисли A × p / 100. При изменении цены важно определить, от какой исходной величины считаются проценты.', example: 'Цена выросла с 80 до 100.\n1. Изменение: 100 − 80 = 20.\n2. Делим на исходную цену: 20 / 80 = 0,25.\n3. Умножаем на 100%: рост составил 25%.', mistakes: 'Рост на 20% и последующее снижение на 20% не возвращают исходное число: базы расчёта различаются. Например, 100 → 120 → 96.' },
  { id: 'geometry', group: 'MATH', title: 'Geometry & Trig', explain: 'В прямоугольном треугольнике сумма квадратов катетов равна квадрату гипотенузы: a² + b² = c². Гипотенуза расположена напротив прямого угла.', example: 'Катеты прямоугольного треугольника равны 6 и 8.\n1. c² = 6² + 8² = 36 + 64 = 100.\n2. Длина положительна, поэтому c = 10.', mistakes: 'Теорема Пифагора применяется к прямоугольному треугольнику. Сначала проверь наличие прямого угла, затем определи гипотенузу. Рисунок сам по себе не доказывает равенство сторон или углов.' },
  { id: 'reading', group: 'R&W', title: 'Reading & Writing', explain: 'Для вопроса о главной мысли ищи утверждение, которое охватывает весь отрывок. Отдельный яркий факт может быть примером, а не основной мыслью.', example: 'Пример: “City trees provide shade. They also help reduce heat in densely built neighborhoods.”\nГлавная мысль: деревья помогают охлаждать городскую среду. Оба предложения поддерживают эту идею.', mistakes: 'Правдоподобное утверждение не обязательно подтверждено отрывком. Выбирай ответ по тексту, проверяя, не добавляет ли он слишком широкое обобщение или новую информацию.' }
];
let currentTopic = topics[0];
const messages = document.getElementById('chat-messages');
const topicList = document.getElementById('topic-list');
function addMessage(text, user = false) {
  const message = document.createElement('div');
  message.className = user ? 'message user-message' : 'message';
  const label = document.createElement('span');
  label.className = 'message-label';
  label.textContent = user ? 'ТЫ' : 'ACEat · ДЕМО';
  message.append(label, document.createTextNode(text));
  messages.append(message);
  while (messages.children.length > 40) messages.firstElementChild.remove();
  messages.scrollTop = messages.scrollHeight;
}
function resetChat() {
  messages.replaceChildren();
  document.getElementById('chat-topic-name').textContent = currentTopic.title;
  document.getElementById('chat-input').value = '';
  addMessage(`Привет! Сейчас выбрана тема ${currentTopic.title}.\n\nНажми «Объясни тему», «Покажи пример» или «Частые ошибки», чтобы посмотреть заранее подготовленный разбор. Свободный ИИ-диалог ещё не подключён.`);
}
topics.forEach(topic => {
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'topic-button';
  const group = document.createElement('span'); group.textContent = topic.group;
  const arrow = document.createElement('small'); arrow.textContent = '↗';
  button.append(group, document.createTextNode(topic.title), arrow);
  button.dataset.topic = topic.id;
  button.setAttribute('aria-pressed', String(topic === currentTopic));
  button.addEventListener('click', () => {
    currentTopic = topic;
    topicList.querySelectorAll('button').forEach(item => { item.setAttribute('aria-pressed', String(item === button)); });
    resetChat();
  });
  topicList.append(button);
});
const promptLabels = { explain: 'Объясни тему', example: 'Покажи пример', mistakes: 'Частые ошибки' };
document.querySelectorAll('[data-prompt]').forEach(button => {
  button.addEventListener('click', () => { const prompt = button.dataset.prompt; addMessage(promptLabels[prompt], true); addMessage(currentTopic[prompt]); });
});
document.getElementById('clear-chat').addEventListener('click', resetChat);
document.getElementById('chat-form').addEventListener('submit', event => {
  event.preventDefault();
  const input = document.getElementById('chat-input'); const text = input.value.trim();
  if (!text) return;
  addMessage(text, true); input.value = '';
  addMessage('Сообщение добавлено в демонстрацию. ИИ пока не подключён, поэтому я не могу разобрать свободный вопрос. Готовые примеры для выбранной темы доступны в кнопках под чатом.');
  input.focus();
});
resetChat();

let catalog = { textbooks: [], pastExams: [], challengeExams: [] };
let bookFilter = 'all'; let catalogFailed = false;
function safeResourceUrl(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  try { const url = new URL(value, document.baseURI); return ['https:', 'http:'].includes(url.protocol) ? url : null; } catch { return null; }
}
function resourceCard(item, kind) {
  const card = document.createElement('article'); card.className = 'resource-card';
  const meta = document.createElement('span'); meta.className = 'tiny-label';
  meta.textContent = [item.subject === 'math' ? 'Math' : item.subject === 'reading' ? 'Reading & Writing' : 'SAT', item.year, item.author].filter(Boolean).join(' / ');
  const title = document.createElement('h3'); title.textContent = item.title;
  const description = document.createElement('p'); description.textContent = item.description || '';
  card.append(meta, title, description);
  if (item.format === 'classifi' && Number.isInteger(item.chapter_count)) {
    const count = document.createElement('span'); count.className = 'outline-badge'; count.textContent = `Глав: ${item.chapter_count}`; card.append(count);
  }
  if (item.source) { const source = document.createElement('p'); source.textContent = `Источник: ${item.source}`; card.append(source); }
  const url = item.format === 'classifi' && /^[a-z][a-z0-9-]{0,63}$/.test(item.id) ? new URL(`#book/${item.id}`, location.href) : safeResourceUrl(item.url);
  if (url) {
    const link = document.createElement('a'); link.href = url.href; link.textContent = kind === 'textbooks' ? 'Открыть учебник ↗' : 'Открыть вариант ↗';
    if (url.origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    card.append(link);
  } else { const status = document.createElement('span'); status.className = 'outline-badge'; status.textContent = 'Материал готовится'; card.append(status); }
  return card;
}
function renderBooks() {
  const query = document.getElementById('book-search').value.trim().toLocaleLowerCase('ru');
  const books = catalog.textbooks.filter(item => (bookFilter === 'all' || item.subject === bookFilter) && `${item.title} ${item.description || ''} ${item.author || ''}`.toLocaleLowerCase('ru').includes(query));
  document.getElementById('book-list').replaceChildren(...books.map(item => resourceCard(item, 'textbooks')));
  document.getElementById('book-count').textContent = catalogFailed ? 'Не удалось загрузить каталог. Обнови страницу, чтобы повторить.' : `Найдено учебников: ${books.length}`;
  const empty = document.getElementById('books-empty'); empty.hidden = books.length > 0;
  empty.querySelector('h2').textContent = catalogFailed ? 'Каталог временно недоступен.' : catalog.textbooks.length ? 'По этому запросу ничего не нашлось.' : 'Место для твоих будущих открытий.';
  empty.querySelector('p').textContent = catalogFailed ? 'Проверь соединение и попробуй обновить страницу.' : catalog.textbooks.length ? 'Попробуй другое название или выбери все направления.' : 'Первые учебники ещё готовятся. Здесь появятся обложки, главы и материалы для самостоятельного изучения.';
}
document.getElementById('book-search').addEventListener('input', renderBooks);
document.querySelectorAll('[data-book-filter]').forEach(button => {
  button.addEventListener('click', () => { bookFilter = button.dataset.bookFilter; document.querySelectorAll('[data-book-filter]').forEach(item => { item.setAttribute('aria-pressed', String(item === button)); }); renderBooks(); });
});
async function loadCatalog() {
  try {
    const response = await fetch('./data/catalog.json'); if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
    const data = await response.json();
    for (const key of Object.keys(catalog)) { if (!Array.isArray(data[key]) || data[key].some(item => !item || typeof item.title !== 'string' || !item.title.trim())) throw new Error('Invalid catalog'); }
    catalog = data;
  } catch { catalogFailed = true; }
  renderBooks();
  document.querySelector('[data-count="textbooks"]').textContent = catalogFailed ? 'Каталог недоступен' : `Учебников: ${catalog.textbooks.length}`;
  document.querySelector('[data-count="pastExams"]').textContent = catalogFailed ? 'Каталог недоступен' : `Экзаменов: ${catalog.pastExams.length}`;
  document.getElementById('past-count').textContent = catalogFailed ? 'Не удалось загрузить архив' : `Вариантов: ${catalog.pastExams.length}`;
  document.getElementById('past-list').replaceChildren(...catalog.pastExams.map(item => resourceCard(item, 'pastExams')));
  document.getElementById('past-empty').hidden = catalog.pastExams.length > 0;
  document.getElementById('challenge-list').replaceChildren(...catalog.challengeExams.map(item => resourceCard(item, 'challengeExams')));
  document.getElementById('challenge-empty').hidden = catalog.challengeExams.length > 0;
  if (catalogFailed) { document.querySelector('#past-empty h2').textContent = 'Архив временно недоступен.'; document.querySelector('#past-empty p').textContent = 'Не удалось загрузить каталог. Проверь соединение и обнови страницу.'; }
  resolveCatalog();
}
loadCatalog();

function validateBook(book, id) {
  if (!book || book.format !== 'aceat.classifi-book.v1' || book.id !== id || typeof book.title !== 'string' || !Array.isArray(book.chapters) || !book.chapters.length) throw new Error('Учебник имеет некорректный формат.');
  for (const chapter of book.chapters) {
    if (!chapter || typeof chapter.title !== 'string' || !Array.isArray(chapter.sections) || !chapter.sections.length) throw new Error('В учебнике повреждена глава.');
    for (const section of chapter.sections) {
      if (!section || typeof section.heading !== 'string' || ['paragraphs', 'formulas', 'steps', 'key_points'].some(key => !Array.isArray(section[key]) || section[key].some(text => typeof text !== 'string'))) throw new Error('В учебнике повреждён раздел.');
    }
  }
}
let mathReady;
function loadMath() {
  if (!mathReady) mathReady = new Promise((resolve, reject) => {
    window.MathJax = { loader: { load: ['ui/safe'] }, tex: { inlineMath: [['\\(', '\\)']], displayMath: [['\\[', '\\]']] }, options: { skipHtmlTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code'], safeOptions: { allow: { URLs: 'none', classes: 'none', cssIDs: 'none', styles: 'none' } } } };
    const script = document.createElement('script'); script.src = 'https://cdn.jsdelivr.net/npm/mathjax@3.2.2/es5/tex-svg.js'; script.async = true;
    script.onload = () => window.MathJax.startup.promise.then(resolve, reject); script.onerror = reject; document.head.append(script);
  });
  return mathReady;
}
function addText(parent, tag, text, className) {
  const element = document.createElement(tag); element.textContent = text; if (className) element.className = className; parent.append(element); return element;
}
async function openBook(id, chapterIndex, route) {
  const state = document.getElementById('reader-status');
  document.getElementById('reader-title').textContent = 'Открываем учебник…';
  document.getElementById('reader-overview').textContent = '';
  document.getElementById('reader-source').textContent = '';
  document.getElementById('reader-layout').hidden = true;
  state.hidden = false; state.textContent = 'Загружаем главы…';
  await catalogReady;
  try {
    if (catalogFailed) throw new Error('Каталог недоступен. Обнови страницу, чтобы повторить загрузку.');
    const entry = catalog.textbooks.find(item => item.id === id && item.format === 'classifi');
    if (!entry) throw new Error('Учебник не найден в сборнике.');
    if (!/^\.\/data\/books\/[a-z][a-z0-9-]{0,63}-[a-f0-9]{12}\.json$/.test(entry.book_path || '')) throw new Error('Некорректный адрес учебника.');
    let book = loadedBooks.get(id);
    if (!book) {
      const response = await fetch(entry.book_path); if (!response.ok) throw new Error('Не удалось загрузить учебник. Попробуй обновить страницу.');
      book = await response.json(); validateBook(book, id); loadedBooks.set(id, book);
    }
    if (location.hash.slice(1) !== route) return;
    if (chapterIndex >= book.chapters.length) throw new Error('Такой главы нет. Вернись к учебнику из сборника.');
    document.getElementById('reader-title').textContent = book.title;
    document.getElementById('reader-overview').textContent = book.overview || '';
    document.getElementById('reader-meta').textContent = [book.subject === 'reading' ? 'READING & WRITING' : book.subject === 'math' ? 'MATH' : 'SAT', book.author, `Глав: ${book.chapters.length}`].filter(Boolean).join(' / ');
    document.title = `ACEat — ${book.title}`;
    const toc = document.getElementById('reader-toc'); toc.replaceChildren();
    addText(toc, 'p', 'СОДЕРЖАНИЕ', 'tiny-label');
    book.chapters.forEach((chapter, index) => { const link = addText(toc, 'a', `${String(index + 1).padStart(2, '0')}  ${chapter.title}`); link.href = `#book/${id}/${index}`; if (index === chapterIndex) link.setAttribute('aria-current', 'page'); });
    const body = document.getElementById('reader-content'); body.replaceChildren();
    const chapter = book.chapters[chapterIndex];
    addText(body, 'span', `ГЛАВА ${chapterIndex + 1} / ${book.chapters.length}`, 'tiny-label');
    addText(body, 'h2', chapter.title);
    if (chapter.overview) addText(body, 'p', chapter.overview, 'chapter-overview');
    chapter.sections.forEach(section => {
      const block = document.createElement('section'); addText(block, 'h3', section.heading);
      section.paragraphs.forEach(text => addText(block, 'p', text));
      section.formulas.forEach(text => { const value = text.trim().replace(/^(\$\$?|\\\[|\\\()/, '').replace(/(\$\$?|\\\]|\\\))$/, ''); addText(block, 'div', `\\[${value}\\]`, 'reader-formula'); });
      if (section.steps.length) { addText(block, 'h4', 'По шагам'); const list = document.createElement('ol'); section.steps.forEach(text => addText(list, 'li', text)); block.append(list); }
      if (section.key_points.length) { const box = document.createElement('div'); box.className = 'reader-takeaway'; addText(box, 'h4', 'Главное'); const list = document.createElement('ul'); section.key_points.forEach(text => addText(list, 'li', text)); box.append(list); block.append(box); }
      body.append(block);
    });
    const pagination = document.createElement('nav'); pagination.className = 'reader-pagination'; pagination.setAttribute('aria-label', 'Переход между главами');
    if (chapterIndex > 0) { const link = addText(pagination, 'a', '← Предыдущая глава', 'button secondary'); link.href = `#book/${id}/${chapterIndex - 1}`; }
    if (chapterIndex + 1 < book.chapters.length) { const link = addText(pagination, 'a', 'Следующая глава →', 'button secondary'); link.href = `#book/${id}/${chapterIndex + 1}`; }
    body.append(pagination);
    document.getElementById('reader-source').textContent = `${book.source || ''}. ${book.generation_mode === 'contents' ? 'Учебные объяснения созданы по темам оглавления, а не извлечены из полного текста книги.' : 'Учебные объяснения созданы по выбранным страницам книги.'} Учебный материал подготовлен с помощью ИИ; проверяй важные выводы по источнику.`;
    state.hidden = true; document.getElementById('reader-layout').hidden = false;
    if (body.querySelector('.reader-formula') || body.textContent.includes('\\(')) loadMath().then(() => { if (location.hash.slice(1) === route) return window.MathJax.typesetPromise([body]); }).catch(() => { if (location.hash.slice(1) === route) addText(body, 'p', 'Сервис отображения формул недоступен: формулы показаны текстом.', 'editor-help'); });
  } catch (error) {
    if (location.hash.slice(1) !== route) return;
    document.getElementById('reader-title').textContent = 'Учебник недоступен'; state.hidden = false; state.textContent = error.message || 'Не удалось открыть учебник.';
  }
}
