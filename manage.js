'use strict';
const form = document.getElementById('import-form');
const fields = document.getElementById('import-fields');
const connection = document.getElementById('editor-connection');
const statusText = document.getElementById('import-status');
const progress = document.getElementById('import-progress');
const publishButton = document.getElementById('publish-button');
const publishedStatus = document.getElementById('publish-status');
let token = '';
let ready = false;
let busy = false;

function toggleBusy(value) { busy = value; fields.disabled = !ready || value; publishButton.disabled = !token || value; }
async function readResponse(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Операция не завершена.');
  return data;
}
function updateJob(job) {
  statusText.textContent = job.message;
  progress.hidden = false;
  if (job.total > 0) { progress.max = job.total; progress.value = job.completed; } else progress.removeAttribute('value');
  if (job.status === 'completed') {
    progress.max = 1; progress.value = 1;
    const link = document.getElementById('open-imported');
    link.href = `./#book/${encodeURIComponent(job.entry.id)}`;
    link.hidden = false;
  }
  if (job.status === 'failed') progress.hidden = true;
}
async function watchJob(id) {
  toggleBusy(true);
  try {
    const job = await fetch(`./api/imports/${id}`, { cache: 'no-store' }).then(readResponse);
    updateJob(job);
    if (['queued', 'running'].includes(job.status)) { setTimeout(() => watchJob(id), 1500); return; }
  } catch {
    statusText.textContent = 'Связь с панелью потеряна. Обнови страницу, чтобы проверить состояние задачи перед повторным запуском.';
  }
  toggleBusy(false);
}
document.getElementById('import-mode').addEventListener('change', event => {
  const pages = event.target.value === 'pages';
  document.getElementById('mode-description').textContent = pages ? 'Выбери страницы с математическим материалом. Classifi создаст объяснения и новые примеры по навыкам из выбранного фрагмента.' : 'Выбери страницы оглавления: Classifi извлечёт темы и создаст учебные объяснения. Это новые материалы по темам книги, а не полный текст оригинала.';
  if (pages) form.elements.subject.value = 'math';
});
form.addEventListener('submit', async event => {
  event.preventDefault();
  if (busy || !ready) return;
  const file = document.getElementById('pdf-file').files[0];
  if (!file || file.size > 25 * 1024 * 1024) { statusText.textContent = 'Выбери PDF размером до 25 МБ.'; return; }
  const data = new FormData(form);
  const metadata = Object.fromEntries(['id', 'title', 'author', 'description', 'subject', 'mode'].map(key => [key, data.get(key)]));
  metadata.start_page = Number(data.get('start_page'));
  metadata.end_page = Number(data.get('end_page'));
  metadata.replace = data.get('replace') === 'on';
  metadata.filename = file.name;
  if (metadata.end_page < metadata.start_page) { statusText.textContent = 'Последняя страница должна быть не меньше первой.'; return; }
  if (metadata.mode === 'pages' && metadata.subject !== 'math') { statusText.textContent = 'Для этого направления выбери обработку оглавления.'; return; }
  toggleBusy(true);
  document.getElementById('open-imported').hidden = true;
  statusText.textContent = 'Передаём PDF локальному движку…';
  try {
    const job = await fetch('./api/imports', { method: 'POST', headers: { 'Content-Type': 'application/pdf', 'X-ACEat-Token': token, 'X-ACEat-Metadata': encodeURIComponent(JSON.stringify(metadata)) }, body: file }).then(readResponse);
    await watchJob(job.id);
  } catch (error) { statusText.textContent = error.message; toggleBusy(false); }
});
publishButton.addEventListener('click', async () => {
  if (busy || !token) return;
  toggleBusy(true);
  publishedStatus.textContent = 'Создаём коммит библиотеки и отправляем его в GitHub…';
  try {
    const result = await fetch('./api/publish', { method: 'POST', headers: { 'X-ACEat-Token': token } }).then(readResponse);
    publishedStatus.textContent = `Отправлено в GitHub (${result.commit.slice(0, 7)}). Дождись завершения сборки Pages.`;
    document.getElementById('open-published').hidden = false;
  } catch (error) { publishedStatus.textContent = error.message; }
  toggleBusy(false);
});
async function connect() {
  try {
    if (!['127.0.0.1', 'localhost'].includes(location.hostname)) throw new Error('local-only');
    const state = await fetch('./api/status', { cache: 'no-store' }).then(readResponse);
    token = state.token;
    ready = state.engine_ready && state.key_ready;
    connection.textContent = ready ? `Classifi подключён · движок ${state.engine.revision.slice(0, 7) || 'local'} · ключ AI настроен` : state.error || 'Classifi найден. Настрой ключ AI в Classifi/.env или ACEat/.env и обнови страницу.';
    toggleBusy(false);
    if (state.job) { updateJob(state.job); if (['queued', 'running'].includes(state.job.status)) await watchJob(state.job.id); }
  } catch { connection.textContent = 'Обработка доступна в локальной панели ACEat.'; document.getElementById('editor-offline').hidden = false; }
}
connect();
