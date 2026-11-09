'use strict';

const routes = ['home', 'textbooks', 'chat', 'past-exams', 'challenge', 'account'];
const routeTitles = { home: 'Пространство подготовки к SAT', textbooks: 'Учебники', chat: 'ИИ по темам', 'past-exams': 'Прошлые экзамены', challenge: 'Challenge-экзамены', exam: 'Практика SAT', account: 'Личный кабинет' };
let routeInitialized = false;
let resolveCatalog;
const catalogReady = new Promise(resolve => { resolveCatalog = resolve; });
const loadedBooks = new Map();
function showRoute() {
  const requested = location.hash.slice(1);
  // The skip link targets main without changing the currently selected module.
  if (requested === 'main') { document.getElementById('main').focus(); return; }
  const bookRoute = /^book\/([a-z][a-z0-9-]{0,63})(?:\/(math|english|pdf|\d+))?(?:\/(\d+))?(?:\/(\d+))?$/.exec(requested);
  const examRoute = /^exam\/([a-z][a-z0-9-]{0,63})$/.exec(requested);
  const authCallback = new URL(location.href).searchParams.has('code') || /^(access_token|error|error_code)=/.test(requested);
  const route = authCallback ? 'account' : bookRoute ? 'book' : examRoute ? 'exam' : routes.includes(requested) ? requested : 'home';
  if (requested && route !== requested && !bookRoute && !examRoute && !authCallback) history.replaceState(null, '', '#home');
  document.querySelectorAll('[data-page]').forEach(page => { page.hidden = page.dataset.page !== route; });
  document.querySelectorAll('[data-route]').forEach(link => {
    const active = link.dataset.route === (route === 'book' ? 'textbooks' : route === 'exam' ? 'past-exams' : route);
    link.classList.toggle('active', active);
    if (active) link.setAttribute('aria-current', 'page'); else link.removeAttribute('aria-current');
  });
  document.title = `ACEat — ${routeTitles[route] || 'Учебник'}`;
  const keepBookTabFocus = bookRoute && document.activeElement?.closest('#reader-tabs');
  if (routeInitialized && !keepBookTabFocus) { document.getElementById('main').focus({ preventScroll: true }); window.scrollTo({ top: 0, behavior: 'instant' }); }
  routeInitialized = true;
  if (bookRoute) window.ACEatLibrary?.open(requested); else window.ACEatLibrary?.leave();
  if (examRoute) window.ACEatExams?.open(examRoute[1]); else window.ACEatExams?.leave();
  if (route === 'account') window.ACEatAccount?.open();
}
window.addEventListener('hashchange', showRoute);
showRoute();

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
  const interactive = kind === 'pastExams' && /^[a-z][a-z0-9-]{0,63}$/.test(item.id) && /^\.\/data\/exams\/[a-z0-9-]+\.json$/.test(item.exam_path || '');
  const url = interactive ? new URL(`#exam/${item.id}`, location.href) : item.format === 'classifi' && /^[a-z][a-z0-9-]{0,63}$/.test(item.id) ? new URL(`#book/${item.id}`, location.href) : safeResourceUrl(item.url);
  if (url) {
    const link = document.createElement('a'); link.href = url.href; link.textContent = interactive ? 'Пройти на сайте →' : kind === 'textbooks' ? 'Открыть учебник ↗' : 'Открыть вариант ↗';
    if (interactive) link.className = 'button secondary exam-start';
    if (url.origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    card.append(link);
  } else { const status = document.createElement('span'); status.className = 'outline-badge'; status.textContent = 'Материал готовится'; card.append(status); }
  if (kind === 'pastExams') {
    for (const [field, label] of [['answers_url', 'Ответы и объяснения · PDF ↗'], ['scoring_url', 'Подсчёт баллов · PDF ↗']]) {
      const resourceUrl = safeResourceUrl(item[field]);
      if (!resourceUrl) continue;
      const link = document.createElement('a'); link.href = resourceUrl.href; link.textContent = label;
      if (resourceUrl.origin !== location.origin) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
      card.append(link);
    }
  }
  return card;
}
function renderBooks() {
  const query = document.getElementById('book-search').value.trim().toLocaleLowerCase('ru');
  const books = catalog.textbooks.filter(item => (bookFilter === 'all' || item.subject === bookFilter) && `${item.title} ${item.description || ''} ${item.author || ''}`.toLocaleLowerCase('ru').includes(query));
  document.getElementById('book-list').replaceChildren(...books.map((item, index) => window.ACEatLibrary?.card(item, index) || resourceCard(item, 'textbooks')));
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
    const response = await fetch('./data/catalog.json', { cache: 'no-store' }); if (!response.ok) throw new Error(`Catalog HTTP ${response.status}`);
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
