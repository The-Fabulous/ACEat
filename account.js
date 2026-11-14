'use strict';

(() => {
  const idPattern = /^[a-z][a-z0-9-]{0,63}$/;
  const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : 0;
  const namespace = uid => uid ? `aceat:user:${uid}` : 'aceat:guest';
  const examKey = (uid, exam) => uid ? `${namespace(uid)}:exam:${exam.id}:v${exam.revision}` : `aceat:exam:${exam.id}:v${exam.revision}`;
  function meaningful(state) {
    return Boolean(state && (state.submitted === true || (Array.isArray(state.flags) && state.flags.length) || Object.values(state.answers || {}).some(value => typeof value === 'string' && value.trim())));
  }
  function cleanState(value) {
    const answers = {};
    for (const [key, text] of Object.entries(value?.answers || {})) {
      if (/^[a-z0-9-]+:\d+$/.test(key) && typeof text === 'string' && text.length <= 24 && Object.keys(answers).length < 300) answers[key] = text;
    }
    return {
      answers, flags: Array.isArray(value?.flags) ? value.flags.filter(key => /^[a-z0-9-]+:\d+$/.test(key)).slice(0, 300) : [],
      index: Number.isInteger(value?.index) && value.index >= 0 && value.index < 1000 ? value.index : 0,
      submitted: value?.submitted === true, updatedAt: stamp(value?.updatedAt) ? value.updatedAt : '',
      attemptId: /^[0-9a-f-]{36}$/i.test(value?.attemptId || '') ? value.attemptId : null,
      submittedAt: stamp(value?.submittedAt) ? value.submittedAt : null
    };
  }
  function latest(local, remote) {
    if (!local) return remote;
    if (!remote) return local;
    return stamp(local.updatedAt) > stamp(remote.updatedAt) ? local : remote;
  }
  function cleanBook(value) {
    if (!value || !idPattern.test(value.book_id) || !Number.isInteger(value.chapter_index) || value.chapter_index < 0 || value.chapter_index > 10000 || !['math', 'english'].includes(value.subject)) return null;
    return { book_id: value.book_id, chapter_index: value.chapter_index, subject: value.subject, updated_at: stamp(value.updated_at) ? value.updated_at : new Date(0).toISOString() };
  }
  globalThis.ACEatAccountModel = { namespace, examKey, meaningful, cleanState, latest, cleanBook };
  if (typeof document === 'undefined') return;

  const get = id => document.getElementById(id);
  const RETURN_URL = 'https://aceat.vercel.app/';
  const callbackUrl = new URL(location.href);
  const fromEmail = callbackUrl.searchParams.has('code') || /^(access_token|error|error_code)=/.test(callbackUrl.hash.slice(1));
  let client, user = null, mode = 'login', profile = null, profileDirty = false, epoch = 0, working = false;
  let syncAvailable = false, pendingTimer, flushing = false, recovery = false;
  const pending = new Map();
  let resolveReady;
  const ready = new Promise(resolve => { resolveReady = resolve; });
  const read = key => { try { return JSON.parse(localStorage.getItem(key)); } catch { return null; } };
  const write = (key, value) => { try { localStorage.setItem(key, JSON.stringify(value)); return true; } catch { return false; } };
  const bookKey = () => `${namespace(user?.id)}:books`;
  const message = (text, error = false) => { const node = get('account-message'); node.hidden = !text; node.textContent = text; node.dataset.error = String(error); };
  function syncMessage(text) { get('account-sync-status').textContent = text; }
  function errorText(error) {
    const code = error?.code;
    if (code === 'invalid_credentials') return 'Не удалось войти. Проверь почту и пароль.';
    if (code === 'email_not_confirmed') return 'Подтверди почту по ссылке из письма, затем войди.';
    if (code === 'weak_password') return 'Выбери более надёжный пароль: от 8 символов.';
    if (code === 'user_already_exists') return 'Попробуй войти или восстановить пароль для этой почты.';
    if (code === 'over_email_send_rate_limit' || error?.status === 429) return 'Слишком много запросов. Подожди несколько минут и повтори.';
    return 'Не удалось выполнить запрос. Проверь соединение и попробуй ещё раз.';
  }
  function setMode(next) {
    mode = next; recovery = next === 'reset'; message(''); get('account-password').value = ''; render();
  }
  function render() {
    const dashboard = Boolean(user) && !recovery;
    get('account-dashboard').hidden = !dashboard; get('account-auth').hidden = dashboard;
    get('account-link').textContent = user ? 'Мой кабинет' : 'Войти';
    if (dashboard) { renderDashboard(); return; }
    const labels = { login: ['С возвращением.', 'Войти'], signup: ['Начнём подготовку.', 'Создать аккаунт'], forgot: ['Восстановим доступ.', 'Отправить ссылку'], reset: ['Новый пароль.', 'Сохранить пароль'] };
    get('account-auth-title').textContent = labels[mode][0]; get('account-submit').textContent = labels[mode][1];
    get('account-name-wrap').hidden = mode !== 'signup'; get('account-name').required = mode === 'signup'; get('account-name').disabled = mode !== 'signup';
    get('account-email-wrap').hidden = mode === 'reset'; get('account-email').required = mode !== 'reset'; get('account-email').disabled = mode === 'reset';
    get('account-password-wrap').hidden = mode === 'forgot'; get('account-password').required = mode !== 'forgot'; get('account-password').disabled = mode === 'forgot';
    get('account-password').minLength = mode === 'login' ? 1 : 8; get('account-password').autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    get('account-auth-tabs').hidden = !['login', 'signup'].includes(mode);
    get('account-login-tab').setAttribute('aria-pressed', String(mode === 'login')); get('account-signup-tab').setAttribute('aria-pressed', String(mode === 'signup'));
    get('account-forgot').hidden = mode !== 'login'; get('account-back-login').hidden = ['login', 'signup'].includes(mode);
    get('account-submit').disabled = !client || working;
  }
  function localBooks() { const values = read(bookKey()); return Array.isArray(values) ? values.map(cleanBook).filter(Boolean) : []; }
  function guestProgressExists() {
    if (!user || read(`${namespace(user.id)}:guest-imported`)) return false;
    return catalog.pastExams.some(entry => meaningful(read(examKey(null, { id: entry.id, revision: 1 })))) || (Array.isArray(read('aceat:guest:books')) && read('aceat:guest:books').length > 0);
  }
  function renderDashboard() {
    if (!user) return;
    const name = profile?.display_name || user.user_metadata?.display_name || user.email?.split('@')[0] || 'Ученик';
    get('account-greeting').textContent = `Привет, ${name}!`; get('account-avatar').textContent = name.trim().slice(0, 1).toUpperCase(); get('account-user-email').textContent = user.email || '';
    const target = profile?.target_score || 1400; get('account-goal-value').textContent = String(target);
    if (!profileDirty) { get('account-profile-name').value = profile?.display_name || user.user_metadata?.display_name || ''; get('account-target').value = String(target); }
    const books = localBooks().sort((a, b) => stamp(b.updated_at) - stamp(a.updated_at));
    get('account-books-value').textContent = String(books.length); get('account-books-list').replaceChildren();
    for (const progress of books) {
      const entry = catalog.textbooks.find(book => book.id === progress.book_id); if (!entry) continue;
      const card = document.createElement('article'); card.className = 'account-resource';
      addText(card, 'span', progress.subject === 'math' ? 'МАТЕМАТИКА' : 'АНГЛИЙСКИЙ', 'tiny-label'); addText(card, 'h3', entry.title);
      const valid = progress.chapter_index < (entry.chapter_count || 0);
      const link = addText(card, 'a', valid ? `Продолжить с подтемы ${progress.chapter_index + 1} →` : 'Открыть темы →'); link.href = valid ? `#book/${entry.id}/${progress.subject}/${progress.chapter_index}` : `#book/${entry.id}`; get('account-books-list').append(card);
    }
    if (!get('account-books-list').children.length) addText(get('account-books-list'), 'p', 'Открой подтему в учебнике — здесь появится кнопка «Продолжить».', 'account-empty');
    get('account-exams-list').replaceChildren(); let completed = 0;
    for (const entry of catalog.pastExams) {
      if (!entry.exam_path) continue;
      const state = read(examKey(user.id, { id: entry.id, revision: 1 }));
      if (state?.submitted) completed += 1;
      const card = document.createElement('article'); card.className = 'account-resource'; addText(card, 'span', state?.submitted ? 'ПОПЫТКА ЗАВЕРШЕНА' : meaningful(state) ? 'В ПРОЦЕССЕ' : 'ГОТОВ К СТАРТУ', 'tiny-label');
      addText(card, 'h3', entry.title);
      if (meaningful(state)) addText(card, 'p', `Записано ответов: ${Object.values(state.answers || {}).filter(value => typeof value === 'string' && value.trim()).length}`);
      const link = addText(card, 'a', state?.submitted ? 'Посмотреть результат →' : meaningful(state) ? 'Продолжить попытку →' : 'Начать вариант →'); link.href = `#exam/${entry.id}`; get('account-exams-list').append(card);
    }
    get('account-exams-value').textContent = String(completed); get('account-import-panel').hidden = !guestProgressExists();
    window.ACEatResults?.render(target);
  }
  function queue(table, key, payload) {
    if (!user || !client) return;
    pending.set(`${table}:${key}`, { table, key, owner: user.id, payload: { ...payload, user_id: user.id } });
    syncMessage('Сохраняем прогресс…'); clearTimeout(pendingTimer); pendingTimer = setTimeout(flush, 800);
  }
  async function flush() {
    if (flushing || !user || !client || !pending.size) return;
    flushing = true; let failed = false;
    try {
      for (const [key, job] of [...pending]) {
        if (job.owner !== user?.id) { pending.delete(key); continue; }
        let result;
        try { result = await client.from(job.table).upsert(job.payload); } catch { result = { error: true }; }
        if (job.owner !== user?.id) break;
        if (result.error) { failed = true; syncAvailable = false; break; }
        if (pending.get(key) === job) pending.delete(key);
      }
      if (user) syncMessage(failed ? 'Прогресс сохранён в этом браузере. Облачная синхронизация временно недоступна.' : pending.size ? 'Сохраняем прогресс…' : 'Прогресс сохранён в аккаунте');
      if (!failed) syncAvailable = true;
    } finally { flushing = false; if (pending.size && !failed && user) pendingTimer = setTimeout(flush, 800); }
  }
  function saveExam(exam, value) {
    if (!user || !idPattern.test(exam.id)) return;
    const state = cleanState(value);
    queue('aceat_exam_attempts', exam.id, { exam_id: exam.id, revision: exam.revision, state, updated_at: state.updatedAt || new Date().toISOString() });
  }
  async function trackBook(bookId, chapter, subject) {
    const recorded = new Date().toISOString(); await ready;
    const value = cleanBook({ book_id: bookId, chapter_index: chapter, subject, updated_at: recorded }); if (!value) return;
    const values = localBooks().filter(book => book.book_id !== bookId); values.push(value); write(bookKey(), values);
    if (user) queue('aceat_book_progress', bookId, value);
  }
  async function loadCloud(token) {
    const owner = user?.id; if (!owner) return;
    const results = await Promise.all(['aceat_profiles', 'aceat_exam_attempts', 'aceat_book_progress'].map(table => client.from(table).select('*').eq('user_id', owner).limit(100)));
    if (token !== epoch || owner !== user?.id) return;
    if (results.some(result => result.error)) { syncAvailable = false; syncMessage('Облачное сохранение пока недоступно. Прогресс остаётся в этом браузере.'); return; }
    const remoteProfile = results[0].data[0] || null, localProfile = read(`${namespace(owner)}:profile`);
    profile = stamp(localProfile?.updated_at) > stamp(remoteProfile?.updated_at) ? localProfile : remoteProfile;
    if (profile) { write(`${namespace(owner)}:profile`, profile); if (profile === localProfile) queue('aceat_profiles', owner, profile); }
    const remoteIds = new Set();
    for (const row of results[1].data) {
      if (!idPattern.test(row.exam_id) || !Number.isInteger(row.revision) || row.revision < 1) continue;
      const exam = { id: row.exam_id, revision: row.revision }; const key = examKey(owner, exam);
      remoteIds.add(key);
      const remote = cleanState({ ...row.state, updatedAt: row.state?.updatedAt || row.updated_at });
      const local = read(key), selected = latest(local, remote); write(key, selected);
      if (selected === local) saveExam(exam, local);
    }
    await catalogReady;
    if (token !== epoch || owner !== user?.id) return;
    for (const entry of catalog.pastExams) {
      const exam = { id: entry.id, revision: 1 }, key = examKey(owner, exam), local = read(key);
      if (!remoteIds.has(key) && meaningful(local)) saveExam(exam, local);
    }
    const books = new Map(localBooks().map(book => [book.book_id, book]));
    for (const raw of results[2].data) { const book = cleanBook(raw); if (book && stamp(book.updated_at) >= stamp(books.get(book.book_id)?.updated_at)) books.set(book.book_id, book); }
    write(bookKey(), [...books.values()]);
    for (const book of books.values()) {
      const remote = results[2].data.find(row => row.book_id === book.book_id);
      if (!remote || stamp(book.updated_at) > stamp(remote.updated_at)) queue('aceat_book_progress', book.book_id, book);
    }
    syncAvailable = true; syncMessage(pending.size ? 'Сохраняем прогресс…' : 'Прогресс синхронизирован'); renderDashboard();
  }
  async function sessionChanged(session, event) {
    const same = user?.id === session?.user?.id;
    if (event === 'PASSWORD_RECOVERY') { mode = 'reset'; recovery = true; }
    if (same && event !== 'PASSWORD_RECOVERY' && event !== 'INITIAL_SESSION') return;
    const token = ++epoch; user = session?.user || null; profile = user ? read(`${namespace(user.id)}:profile`) : null; profileDirty = false; syncAvailable = false;
    clearTimeout(pendingTimer); pending.clear(); render();
    window.dispatchEvent(new CustomEvent('aceat:identity-changing'));
    if (user) { try { await loadCloud(token); } catch { if (token === epoch) syncMessage('Прогресс сохранён в этом браузере. Облачная синхронизация временно недоступна.'); } }
    if (token !== epoch) return;
    render(); window.dispatchEvent(new CustomEvent('aceat:identity-changed'));
  }
  get('account-login-tab').addEventListener('click', () => setMode('login'));
  get('account-signup-tab').addEventListener('click', () => setMode('signup'));
  get('account-forgot').addEventListener('click', () => setMode('forgot'));
  get('account-back-login').addEventListener('click', () => setMode('login'));
  get('account-auth-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!client || working) return; working = true; message(''); render();
    const email = get('account-email').value.trim(), password = get('account-password').value;
    try {
      let result;
      if (mode === 'signup') result = await client.auth.signUp({ email, password, options: { emailRedirectTo: RETURN_URL, data: { display_name: get('account-name').value.trim() } } });
      else if (mode === 'forgot') result = await client.auth.resetPasswordForEmail(email, { redirectTo: RETURN_URL });
      else if (mode === 'reset') result = await client.auth.updateUser({ password });
      else result = await client.auth.signInWithPassword({ email, password });
      if (result.error) throw result.error;
      get('account-password').value = '';
      if (mode === 'forgot') message('Если аккаунт с этой почтой существует, на неё придёт ссылка для восстановления пароля.');
      else if (mode === 'signup' && !result.data.session) message('Проверь почту и подтверди регистрацию по ссылке из письма. Затем можно войти в кабинет.');
      else if (mode === 'reset') { recovery = false; mode = 'login'; message('Пароль обновлён.'); }
    } catch (error) { message(errorText(error), true); }
    finally { working = false; render(); }
  });
  get('account-signout').addEventListener('click', async () => {
    try {
      await flush();
      const result = await client.auth.signOut({ scope: 'local' }); if (result.error) throw result.error;
      await sessionChanged(null, 'SIGNED_OUT'); message('Ты вышел из аккаунта.');
    } catch (error) { message(errorText(error), true); }
  });
  get('account-profile-form').addEventListener('input', () => { profileDirty = true; });
  get('account-profile-form').addEventListener('submit', async event => {
    event.preventDefault(); if (!user) return;
    const name = get('account-profile-name').value.trim(), target = Number(get('account-target').value);
    if (name.length > 80 || !Number.isInteger(target) || target < 400 || target > 1600) { message('Проверь имя и цель: от 400 до 1600 баллов.', true); return; }
    profile = { display_name: name, target_score: target, updated_at: new Date().toISOString() }; profileDirty = false;
    write(`${namespace(user.id)}:profile`, profile);
    queue('aceat_profiles', user.id, profile); renderDashboard(); await flush();
  });
  get('account-refresh').addEventListener('click', async () => {
    if (!user) return;
    try { await flush(); await loadCloud(epoch); renderDashboard(); window.dispatchEvent(new CustomEvent('aceat:cloud-refreshed')); }
    catch { syncMessage('Не удалось синхронизировать прогресс. Попробуй ещё раз.'); }
  });
  get('account-import').addEventListener('click', () => {
    if (!user) return;
    for (const entry of catalog.pastExams) {
      const exam = { id: entry.id, revision: 1 }, key = examKey(user.id, exam), guest = read(examKey(null, exam));
      if (meaningful(guest) && !meaningful(read(key))) { const state = cleanState({ ...guest, updatedAt: new Date().toISOString() }); write(key, state); saveExam(exam, state); }
    }
    const own = localBooks(), guestBooks = read('aceat:guest:books');
    for (const raw of Array.isArray(guestBooks) ? guestBooks : []) {
      const book = cleanBook(raw); if (book && !own.some(item => item.book_id === book.book_id)) { own.push(book); queue('aceat_book_progress', book.book_id, book); }
    }
    write(bookKey(), own); write(`${namespace(user.id)}:guest-imported`, true); renderDashboard(); message('Прогресс из этого браузера перенесён в кабинет.');
  });
  async function fetchChatPage(owner, topic, cursor) {
    if (!client || !owner || owner !== user?.id) throw new Error('Account changed');
    let query = client.from('aceat_chat_messages').select('id,conversation_id,topic,role,content,answer,created_at')
      .eq('user_id', owner).eq('topic', topic).order('created_at', { ascending: false }).order('id', { ascending: false }).limit(100);
    if (cursor) {
      if (!/^[0-9a-f-]{36}$/i.test(cursor.id) || !stamp(cursor.created_at)) throw new Error('Invalid chat cursor');
      const time = new Date(cursor.created_at).toISOString();
      query = query.or(`created_at.lt.${time},and(created_at.eq.${time},id.lt.${cursor.id})`);
    }
    const result = await query;
    if (result.error) throw result.error;
    return result.data;
  }
  async function fetchResults(owner, offset = 0) {
    if (!client || !owner || owner !== user?.id) throw new Error('Account changed');
    const result = await client.from('aceat_exam_results').select('*').eq('user_id', owner).order('completed_at', { ascending: false }).order('id', { ascending: false }).range(offset, offset + 99);
    if (result.error) throw result.error;
    return result.data;
  }
  async function pushResult(owner, row) {
    if (!client || !owner || owner !== user?.id) throw new Error('Account changed');
    const result = await client.from('aceat_exam_results').upsert({ ...row, user_id: owner, is_demo: false }, { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (result.error) throw result.error;
  }
  async function fetchScorePage(owner, offset = 0) {
    if (!client || !owner || owner !== user?.id) throw new Error('Account changed');
    const result = await client.from('aceat_exam_results').select('id,score,completed_at,is_demo').eq('user_id', owner).order('completed_at', { ascending: true }).order('id', { ascending: true }).range(offset, offset + 999);
    if (result.error) throw result.error;
    return result.data;
  }
  async function pushChatMessages(owner, rows) {
    if (!client || !owner || owner !== user?.id) throw new Error('Account changed');
    const result = await client.from('aceat_chat_messages').upsert(rows.map(row => ({ ...row, user_id: owner })), { onConflict: 'user_id,id', ignoreDuplicates: true });
    if (result.error) throw result.error;
  }
  window.ACEatAccount = { ready, fetchScorePage, fetchResults, pushResult, open: render, identity: () => user?.id || null, examStorageKey: exam => examKey(user?.id, exam), saveExam, trackBook, fetchChatPage, pushChatMessages, isSignedIn: () => Boolean(user), isSynced: () => syncAvailable };
  render(); catalogReady.then(() => { if (user) renderDashboard(); });
  (async () => {
    try {
      const module = await import('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.119.0/+esm');
      client = module.createClient(window.ACEAT_AUTH.url, window.ACEAT_AUTH.publishableKey, { auth: { flowType: 'pkce', persistSession: true, autoRefreshToken: true, detectSessionInUrl: true }, global: { fetch: (url, options = {}) => fetch(url, { ...options, signal: options.signal || AbortSignal.timeout(15000) }) } });
      let initializing = true;
      client.auth.onAuthStateChange((event, session) => { if (initializing && event === 'INITIAL_SESSION') return; setTimeout(() => sessionChanged(session, event).catch(() => syncMessage('Облачная синхронизация временно недоступна.')), 0); });
      const result = await client.auth.getSession(); initializing = false;
      if (result.error) message('Не удалось войти по ссылке. Попробуй вход с почтой и паролем.', true);
      await sessionChanged(result.data.session, 'INITIAL_SESSION');
      const url = new URL(location.href);
      if (fromEmail) {
        ['code', 'error', 'error_code', 'error_description'].forEach(key => url.searchParams.delete(key)); url.hash = 'account'; history.replaceState(null, '', url); showRoute();
      }
    } catch { message('Не удалось подключиться к сервису входа. Проверь соединение и обнови страницу.', true); }
    finally { resolveReady(); render(); }
  })();
})();
