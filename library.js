'use strict';

(() => {
  const cleanTitle = value => String(value).replace(/^\s*(?:\d+|[IVXLCDM]+)[.:)]\s*/i, '').trim();
  const defaultSubject = book => book.subject === 'math' ? 'math' : 'english';
  function parseRoute(route) {
    const match = /^book\/([a-z][a-z0-9-]{0,63})(?:\/(math|english|pdf|\d+))?(?:\/(\d+))?(?:\/(\d+))?$/.exec(route);
    if (!match) throw new Error('Некорректный адрес учебника.');
    const legacy = /^\d+$/.test(match[2] || '');
    if ((legacy && match[3]) || (match[2] === 'pdf' && match[3])) throw new Error('Некорректный адрес раздела.');
    const chapter = legacy ? Number(match[2]) : match[3] === undefined ? null : Number(match[3]);
    const section = match[4] === undefined ? null : Number(match[4]);
    if ([chapter, section].some(n => n !== null && !Number.isSafeInteger(n))) throw new Error('Некорректный номер подтемы.');
    return { id: match[1], tab: legacy ? null : match[2] || null, chapter, section };
  }
  function groupsFor(book, structure) {
    const groups = [], used = new Set();
    for (const group of Array.isArray(structure?.[book.id]) ? structure[book.id] : []) {
      if (!group || typeof group.title !== 'string' || !['math', 'english'].includes(group.subject) || !Array.isArray(group.chapters)) continue;
      const chapters = group.chapters.filter(index => {
        if (!Number.isInteger(index) || index < 0 || index >= book.chapters.length || used.has(index)) return false;
        used.add(index); return true;
      });
      if (chapters.length) groups.push({ title: group.title, subject: group.subject, chapters });
    }
    for (const subject of ['math', 'english']) {
      const chapters = book.chapters.flatMap((chapter, index) => {
        const chapterSubject = chapter.subject === 'math' ? 'math' : ['reading', 'english'].includes(chapter.subject) ? 'english' : defaultSubject(book);
        return !used.has(index) && chapterSubject === subject ? [index] : [];
      });
      if (chapters.length) groups.push({ title: groups.length ? 'Другие темы' : subject === 'math' ? 'Математика' : 'Английский', subject, chapters });
    }
    return groups;
  }
  function selection(book, route, structure) {
    const parsed = parseRoute(route);
    if (parsed.id !== book.id) throw new Error('Учебник не найден.');
    const groups = groupsFor(book, structure);
    const containing = parsed.chapter === null ? null : groups.find(group => group.chapters.includes(parsed.chapter));
    const tab = parsed.tab || containing?.subject || defaultSubject(book);
    if (parsed.chapter !== null && (!containing || containing.subject !== tab)) throw new Error('В этом разделе нет такой подтемы. Открой её из оглавления.');
    if (parsed.section !== null && (!book.chapters[parsed.chapter]?.sections[parsed.section])) throw new Error('Подраздел не найден.');
    return { ...parsed, tab, groups: groups.filter(group => group.subject === tab) };
  }
  globalThis.ACEatLibraryModel = { cleanTitle, parseRoute, defaultSubject, groupsFor, selection };
  if (typeof document === 'undefined') return;

  const get = id => document.getElementById(id);
  const labels = { english: 'Английский', math: 'Математика', pdf: 'PDF книги' };
  let structure = {}, sources = [], currentBook, currentRoute, currentSource, opening = 0;
  let pdfLibrary, pdfTask, renderTask, rendering = 0, pdfPage = 1, pdfZoom = 1;
  const PDF_JS = 'https://cdn.jsdelivr.net/npm/pdfjs-dist@6.5.438/';
  const configuration = Promise.all([
    fetch('./data/library-structure.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {}),
    fetch('./data/textbook-sources.json', { cache: 'no-cache' }).then(r => r.ok ? r.json() : {})
  ]).then(([topics, registry]) => { structure = topics || {}; sources = Array.isArray(registry.sources) ? registry.sources : []; }).catch(() => {});
  configuration.then(() => catalogReady).then(() => renderBooks());

  function coverInfo(item) {
    if (item.subject === 'math') return { theme: 'math', title: 'SAT Math', subtitle: 'Математика', symbol: '∑', description: 'Уравнения, функции, данные и геометрия.' };
    if (/grammar/i.test(item.title)) return { theme: 'grammar', title: 'SAT Grammar', subtitle: 'Грамматика', symbol: 'Aa', description: 'Предложения, пунктуация и точность языка.' };
    return { theme: 'reading', title: 'SAT Reading', subtitle: 'Чтение', symbol: 'Aa', description: 'Смысл текста, аргументация и стратегии чтения.' };
  }
  function cover(item) {
    const info = coverInfo(item), node = document.createElement('div');
    node.className = 'shelf-cover'; node.dataset.theme = info.theme; node.setAttribute('aria-hidden', 'true');
    addText(node, 'span', 'ACEat / STUDY LIBRARY', 'cover-series');
    addText(node, 'strong', info.title, 'cover-title');
    addText(node, 'span', info.symbol, 'cover-symbol');
    addText(node, 'span', 'UNDERSTAND. PRACTICE. GROW.', 'cover-footer');
    return node;
  }
  function card(item) {
    if (item.format !== 'classifi' || !/^[a-z][a-z0-9-]{0,63}$/.test(item.id)) return resourceCard(item, 'textbooks');
    const info = coverInfo(item), article = document.createElement('article'); article.className = 'shelf-book-card';
    const link = document.createElement('a'); link.className = 'shelf-book-link'; link.href = `#book/${item.id}`;
    link.setAttribute('aria-label', `Открыть учебник ${item.title}`); link.append(cover(item));
    const body = document.createElement('div'); body.className = 'shelf-book-body';
    addText(body, 'p', `${info.subtitle} / ${item.chapter_count || 0} подтем`, 'tiny-label');
    addText(body, 'h3', item.title.replace(/^SAT (?:Math|Reading|Grammar):\s*/i, ''));
    addText(body, 'p', info.description, 'shelf-book-description');
    addText(body, 'p', item.author || 'Материалы ACEat', 'shelf-book-author');
    const footer = document.createElement('div'); footer.className = 'shelf-book-footer';
    const source = sources.find(record => record.id === item.id);
    addText(footer, 'span', source ? `${source.pdf_pages} стр. в PDF` : 'Материалы ACEat');
    addText(footer, 'span', 'Изучать книгу ↗'); body.append(footer); link.append(body); article.append(link); return article;
  }
  function bookLink(tab, chapter = null, section = null) {
    return `#book/${currentBook.id}/${tab}${chapter === null ? '' : `/${chapter}${section === null ? '' : `/${section}`}`}`;
  }
  function renderTabs(selected) {
    const allGroups = groupsFor(currentBook, structure);
    const tabs = get('reader-tabs'); tabs.replaceChildren();
    for (const tab of ['english', 'math', 'pdf']) {
      const count = allGroups.filter(group => group.subject === tab).reduce((sum, group) => sum + group.chapters.length, 0);
      const anchor = addText(tabs, 'a', labels[tab]); anchor.href = bookLink(tab); anchor.id = `book-tab-${tab}`;
      if (tab !== 'pdf') addText(anchor, 'span', String(count), 'book-tab-count');
      anchor.setAttribute('role', 'tab'); anchor.setAttribute('aria-selected', String(selected === tab));
      anchor.setAttribute('aria-controls', 'reader-panel'); anchor.tabIndex = selected === tab ? 0 : -1;
    }
    get('reader-panel').setAttribute('aria-labelledby', `book-tab-${selected}`);
  }
  get('reader-tabs').addEventListener('keydown', event => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End']; if (!keys.includes(event.key)) return;
    const tabs = [...get('reader-tabs').querySelectorAll('[role=tab]')];
    const index = tabs.indexOf(document.activeElement); if (index < 0) return;
    event.preventDefault();
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
    tabs[next].focus(); tabs[next].click();
  });
  function renderTopics(view) {
    const root = get('reader-topics'); root.replaceChildren(); root.hidden = false;
    const intro = document.createElement('div'); intro.className = 'book-subject-intro';
    addText(intro, 'p', 'ТВОЙ МАРШРУТ ПО КНИГЕ', 'tiny-label'); addText(intro, 'h2', labels[view.tab]);
    const total = view.groups.reduce((sum, group) => sum + group.chapters.length, 0);
    addText(intro, 'p', total ? `${view.groups.length} тем · ${total} подтем. Выбери, с чего продолжить.` : 'Проверь другие разделы книги или выбери другой учебник.'); root.append(intro);
    if (!total) {
      const empty = document.createElement('div'); empty.className = 'book-subject-empty';
      addText(empty, 'span', view.tab === 'math' ? '∑' : 'Aa', 'book-empty-symbol');
      addText(empty, 'h3', `В этой книге пока нет разделов по ${view.tab === 'math' ? 'математике' : 'английскому'}.`);
      addText(empty, 'p', `Основное направление этой книги — ${labels[defaultSubject(currentBook)].toLowerCase()}. Другие направления доступны в сборнике.`);
      const link = addText(empty, 'a', 'Выбрать другой учебник →', 'button secondary'); link.href = '#textbooks'; root.append(empty); return;
    }
    view.groups.forEach((group, index) => {
      const card = document.createElement('section'); card.className = 'book-topic-card';
      const heading = document.createElement('div'); heading.className = 'book-topic-heading';
      addText(heading, 'span', String(index + 1).padStart(2, '0'), 'book-topic-number'); addText(heading, 'h3', group.title); card.append(heading);
      const list = document.createElement('ul');
      group.chapters.forEach(chapter => {
        const item = document.createElement('li'); const link = addText(item, 'a', cleanTitle(currentBook.chapters[chapter].title)); link.href = bookLink(view.tab, chapter);
        addText(link, 'span', '↗', 'subtopic-arrow'); list.append(item);
      }); card.append(list); root.append(card);
    });
  }
  function renderChapter(view) {
    get('reader-layout').hidden = false;
    const toc = get('reader-toc'); toc.replaceChildren();
    const back = addText(toc, 'a', '← Все темы', 'book-toc-back'); back.href = bookLink(view.tab);
    view.groups.forEach(group => {
      const details = document.createElement('details'); details.open = group.chapters.includes(view.chapter);
      const summary = addText(details, 'summary', group.title); addText(summary, 'span', String(group.chapters.length));
      group.chapters.forEach(index => {
        const link = addText(details, 'a', cleanTitle(currentBook.chapters[index].title)); link.href = bookLink(view.tab, index);
        if (index === view.chapter) link.setAttribute('aria-current', 'page');
      }); toc.append(details);
    });
    const body = get('reader-content'); window.MathJax?.typesetClear?.([body]); body.replaceChildren();
    const chapter = currentBook.chapters[view.chapter];
    const group = view.groups.find(item => item.chapters.includes(view.chapter));
    addText(body, 'p', `${labels[view.tab]} / ${group.title}`, 'tiny-label'); addText(body, 'h2', cleanTitle(chapter.title));
    if (chapter.overview) addText(body, 'p', chapter.overview, 'chapter-overview');
    chapter.sections.forEach((section, index) => {
      const block = document.createElement('section'); block.id = `book-section-${index}`;
      if (cleanTitle(section.heading) !== cleanTitle(chapter.title)) addText(block, 'h3', cleanTitle(section.heading));
      section.paragraphs.forEach(text => addText(block, 'p', text));
      section.formulas.forEach(text => {
        const latex = text.trim().replace(/^(\$\$?|\\\[|\\\()/, '').replace(/(\$\$?|\\\]|\\\))$/, '');
        addText(block, 'div', `\\[${latex}\\]`, 'reader-formula');
      });
      if (section.steps.length) { addText(block, 'h4', 'По шагам'); const list = document.createElement('ol'); section.steps.forEach(text => addText(list, 'li', text)); block.append(list); }
      if (section.key_points.length) { const box = document.createElement('div'); box.className = 'reader-takeaway'; addText(box, 'h4', 'Главное'); const list = document.createElement('ul'); section.key_points.forEach(text => addText(list, 'li', text)); box.append(list); block.append(box); }
      body.append(block);
    });
    const ordered = view.groups.flatMap(item => item.chapters), position = ordered.indexOf(view.chapter);
    const pagination = document.createElement('nav'); pagination.className = 'reader-pagination'; pagination.setAttribute('aria-label', 'Переход между подтемами');
    if (position > 0) { const link = addText(pagination, 'a', '← Предыдущая подтема', 'button secondary'); link.href = bookLink(view.tab, ordered[position - 1]); }
    if (position + 1 < ordered.length) { const link = addText(pagination, 'a', 'Следующая подтема →', 'button secondary'); link.href = bookLink(view.tab, ordered[position + 1]); }
    body.append(pagination);
    const route = currentRoute;
    const scrollToSection = () => { if (view.section !== null && location.hash === `#${route}`) get(`book-section-${view.section}`)?.scrollIntoView({ block: 'start' }); };
    if (body.querySelector('.reader-formula') || body.textContent.includes('\\(')) {
      loadMath().then(() => { if (location.hash === `#${route}`) return window.MathJax.typesetPromise([body]); }).then(scrollToSection).catch(() => {});
    } else scrollToSection();
  }
  function endpoint(download = false) {
    const base = new URL(window.ACEAT_CHAT_API || './', document.baseURI);
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
    if (base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) throw new Error('Недоступен адрес сервера PDF.');
    return new URL(`${base.pathname.replace(/\/$/, '')}/api/books/${currentBook.id}/pdf${download ? '?download=1' : ''}`, base).href;
  }
  function releasePdf() {
    rendering += 1; renderTask?.cancel(); renderTask = null;
    if (pdfTask) pdfTask.destroy().catch(() => {});
    pdfTask = null; get('book-pdf-canvas').width = 0; get('book-pdf-canvas').height = 0;
  }
  async function renderPdf(next) {
    const token = ++rendering; renderTask?.cancel(); renderTask = null;
    get('book-pdf-status').textContent = 'Загружаем страницу оригинала…';
    try {
      if (!pdfLibrary) pdfLibrary = import(`${PDF_JS}build/pdf.min.mjs`).then(module => { module.GlobalWorkerOptions.workerSrc = `${PDF_JS}build/pdf.worker.min.mjs`; return module; }).catch(error => { pdfLibrary = null; throw error; });
      const library = await pdfLibrary;
      if (token !== rendering || !currentBook) return;
      if (!pdfTask) pdfTask = library.getDocument({ url: endpoint(), disableAutoFetch: true, disableStream: true, rangeChunkSize: 256 * 1024, isEvalSupported: false, useWasm: false, standardFontDataUrl: `${PDF_JS}standard_fonts/` });
      const pdf = await pdfTask.promise;
      if (token !== rendering) return;
      if (!Number.isInteger(next) || next < 1 || next > pdf.numPages) throw new Error('Выбери существующую страницу.');
      pdfPage = next; get('book-pdf-page').value = String(next); get('book-pdf-page').max = String(pdf.numPages); get('book-pdf-total').textContent = `/ ${pdf.numPages}`;
      get('book-pdf-prev').disabled = next === 1; get('book-pdf-next').disabled = next === pdf.numPages;
      const page = await pdf.getPage(next); if (token !== rendering) return;
      const width = Math.max(280, get('book-pdf-viewport').clientWidth - 2) * pdfZoom;
      const viewport = page.getViewport({ scale: width / page.getViewport({ scale: 1 }).width });
      const ratio = Math.min(window.devicePixelRatio || 1, 2), canvas = get('book-pdf-canvas');
      canvas.width = Math.floor(viewport.width * ratio); canvas.height = Math.floor(viewport.height * ratio); canvas.style.width = `${Math.floor(viewport.width)}px`; canvas.style.height = `${Math.floor(viewport.height)}px`;
      canvas.setAttribute('aria-label', `Страница ${next}: ${currentBook.title}`);
      renderTask = page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport, transform: ratio === 1 ? null : [ratio, 0, 0, ratio, 0, 0] });
      await renderTask.promise;
      if (token === rendering) { get('book-pdf-status').textContent = ''; get('book-pdf-viewport').scrollTop = 0; }
    } catch (error) {
      if (token === rendering && error.name !== 'RenderingCancelledException') {
        get('book-pdf-status').textContent = 'Не удалось показать страницу. Проверь номер страницы и соединение с сервером. Оригинал также доступен по ссылке выше.';
        get('book-pdf-open').hidden = false;
        get('book-pdf-page').value = String(pdfPage);
        if (pdfTask) pdfTask.destroy().catch(() => {});
        pdfTask = null;
      }
    }
  }
  function renderPdfTab() {
    get('reader-pdf').hidden = false; get('book-pdf-viewer').hidden = true; get('book-pdf-open').hidden = false;
    const source = safeResourceUrl(currentSource?.url || currentBook.source_url);
    get('book-pdf-description').textContent = currentSource ? `${currentSource.pdf_pages} страниц · ${currentSource.author} · ${currentSource.edition}. Можно читать оригинал здесь или сохранить файл.` : 'Оригинальный PDF доступен по ссылке на источник.';
    get('book-pdf-open').disabled = !currentSource;
    const download = get('book-pdf-download'); download.hidden = !source;
    const original = get('book-pdf-source'); original.hidden = !source;
    if (source) { original.href = source.href; download.href = currentSource ? endpoint(true) : source.href; download.textContent = currentSource ? 'Скачать PDF ↓' : 'Открыть PDF ↗'; }
    get('book-pdf-status').textContent = ''; pdfPage = 1; pdfZoom = 1; get('book-pdf-zoom').textContent = '150%';
  }
  get('book-pdf-open').addEventListener('click', () => { get('book-pdf-viewer').hidden = false; get('book-pdf-open').hidden = true; renderPdf(pdfPage); });
  get('book-pdf-prev').addEventListener('click', () => renderPdf(pdfPage - 1));
  get('book-pdf-next').addEventListener('click', () => renderPdf(pdfPage + 1));
  get('book-pdf-page').addEventListener('change', event => renderPdf(Number(event.target.value)));
  get('book-pdf-page').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); renderPdf(Number(event.target.value)); } });
  get('book-pdf-zoom').addEventListener('click', () => { pdfZoom = pdfZoom === 1 ? 1.5 : 1; get('book-pdf-zoom').textContent = pdfZoom === 1 ? '150%' : '100%'; renderPdf(pdfPage); });
  function leave() { opening += 1; currentBook = null; releasePdf(); }
  async function open(route) {
    const keepTabFocus = get('reader-tabs').contains(document.activeElement);
    const token = ++opening; releasePdf(); currentRoute = route;
    get('reader-title').textContent = 'Открываем учебник…'; get('reader-overview').textContent = '';
    get('reader-workspace').hidden = true; get('reader-status').hidden = false; get('reader-status').textContent = 'Загружаем темы…'; get('reader-source').textContent = '';
    await Promise.all([catalogReady, configuration]);
    try {
      const parsed = parseRoute(route);
      const entry = catalog.textbooks.find(item => item.id === parsed.id && item.format === 'classifi');
      if (catalogFailed || !entry || !/^\.\/data\/books\/[a-z][a-z0-9-]{0,63}-[a-f0-9]{12}\.json$/.test(entry.book_path || '')) throw new Error('Учебник не найден. Открой его из сборника.');
      let book = loadedBooks.get(parsed.id);
      if (!book) { const response = await fetch(entry.book_path); if (!response.ok) throw new Error('Не удалось загрузить учебник. Попробуй обновить страницу.'); book = await response.json(); validateBook(book, parsed.id); loadedBooks.set(parsed.id, book); }
      if (token !== opening || location.hash !== `#${route}`) return;
      const view = selection(book, route, structure);
      currentBook = book; currentSource = sources.find(item => item.id === book.id);
      get('reader-title').textContent = book.title; document.title = `ACEat — ${book.title}`;
      get('reader-cover').replaceChildren(cover(entry));
      get('reader-meta').textContent = `МАТЕРИАЛЫ ACEat / ${book.chapters.length} ПОДТЕМ${currentSource ? ` / ${currentSource.pdf_pages} СТР. В ОРИГИНАЛЕ` : ''}`;
      get('reader-overview').textContent = coverInfo(entry).description;
      renderTabs(view.tab);
      get('reader-topics').hidden = true; get('reader-layout').hidden = true; get('reader-pdf').hidden = true;
      get('reader-status').hidden = true; get('reader-workspace').hidden = false;
      if (keepTabFocus) get(`book-tab-${view.tab}`).focus({ preventScroll: true });
      if (view.tab === 'pdf') renderPdfTab(); else if (view.chapter === null) renderTopics(view); else renderChapter(view);
      get('reader-source').textContent = `${book.source || ''}. Материалы ACEat подготовлены с помощью ИИ по темам книги. Оригинальное издание доступно во вкладке «PDF книги».`;
    } catch (error) {
      if (token !== opening) return;
      get('reader-title').textContent = 'Раздел недоступен'; get('reader-status').hidden = false; get('reader-status').textContent = error.message || 'Не удалось открыть учебник.';
    }
  }
  window.ACEatLibrary = { open, leave, card };
  if (location.hash.startsWith('#book/')) open(location.hash.slice(1));
})();
