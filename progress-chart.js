'use strict';
(() => {
  function points(rows, target) {
    const ordered = rows.filter(row => Number.isFinite(Date.parse(row.completed_at)) && Number.isInteger(row.score) && row.score >= 400 && row.score <= 1600).slice().sort((a, b) => Date.parse(a.completed_at) - Date.parse(b.completed_at) || a.id.localeCompare(b.id));
    const width = Math.max(640, ordered.length * 24 + 100), y = score => 290 - (score - 400) / 1200 * 250;
    return { width, targetY: y(target), points: ordered.map((row, i) => ({ ...row, index: i + 1, x: ordered.length === 1 ? (width + 20) / 2 : 60 + i * (width - 90) / Math.max(1, ordered.length - 1), y: y(row.score) })) };
  }
  globalThis.ACEatProgressModel = { points };
  if (typeof document === 'undefined') return;
  let signature = '';
  function render(rows, target, complete, owner) {
    const root = document.getElementById('account-progress-chart');
    const next = JSON.stringify([owner, target, complete, rows.map(row => [row.id, row.score, row.completed_at, row.is_demo])]);
    if (next === signature) return; signature = next;
    root.replaceChildren();
    const layout = points(rows, target), data = layout.points;
    const note = document.getElementById('account-progress-note');
    note.textContent = complete ? `Все попытки: ${data.length}. Нажми на точку, чтобы увидеть результат.` : 'Показаны доступные результаты. Загружаем полную историю; при ошибке нажми «Обновить историю».';
    document.getElementById('account-progress-target').textContent = `Цель: ${target}`;
    const detail = document.getElementById('account-progress-detail'); detail.textContent = '';
    if (!data.length) { addText(root, 'p', 'После первого завершённого пробника здесь появится график.', 'account-empty'); return; }
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${layout.width} 335`); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', 'Баллы по попыткам от старых к новым. Целевой балл ' + target); svg.style.minWidth = layout.width + 'px';
    const element = (tag, attrs, text) => { const node = document.createElementNS('http://www.w3.org/2000/svg', tag); for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, String(value)); if (text !== undefined) node.textContent = text; svg.append(node); return node; };
    for (let score = 400; score <= 1600; score += 200) {
      const y = 290 - (score - 400) / 1200 * 250;
      element('line', { x1: 55, x2: layout.width - 20, y1: y, y2: y, stroke: '#e2e7da', 'stroke-width': 1 });
      element('text', { x: 45, y: y + 4, 'text-anchor': 'end', fill: '#738066', stroke: 'none', 'font-size': 11 }, score);
    }
    element('line', { x1: 55, x2: layout.width - 20, y1: layout.targetY, y2: layout.targetY, stroke: '#8b6fba', 'stroke-width': 2, 'stroke-dasharray': '7 5' });
    if (data.length > 1) element('polyline', { points: data.map(p => `${p.x},${p.y}`).join(' '), fill: 'none', stroke: '#6d852f', 'stroke-width': 3, 'stroke-linejoin': 'round' });
    let selected;
    for (const point of data) {
      const label = `Попытка ${point.index}: ${point.score} баллов, ${new Date(point.completed_at).toLocaleString('ru-RU')}${point.is_demo ? ', демонстрационная' : ''}`;
      const circle = element('circle', { cx: point.x, cy: point.y, r: 6, fill: point.is_demo ? '#fff' : '#b6d848', stroke: point.is_demo ? '#8b6fba' : '#536c27', 'stroke-width': 2, tabindex: 0, role: 'button', 'aria-label': label });
      const title = document.createElementNS('http://www.w3.org/2000/svg', 'title'); title.textContent = label; circle.append(title);
      const show = () => { selected?.setAttribute('r', '6'); circle.setAttribute('r', '9'); selected = circle; detail.textContent = label; };
      circle.addEventListener('click', show); circle.addEventListener('focus', show);
      circle.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); show(); } });
      if (data.length <= 12 || point.index === 1 || point.index === data.length || point.index % Math.ceil(data.length / 12) === 0) element('text', { x: point.x, y: 315, 'text-anchor': 'middle', fill: '#738066', stroke: 'none', 'font-size': 11 }, point.index);
      if (point.index === data.length) show();
    }
    root.append(svg);
  }
  window.ACEatProgressChart = { render };
})();
