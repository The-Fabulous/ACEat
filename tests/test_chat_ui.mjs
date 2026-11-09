export async function runChatUiChecks(chatSource, storeSource) {
  const assert = (value, label) => { if (!value) throw new Error(label); };
  const sandbox = {}; new Function('globalThis', storeSource)(sandbox);
  const model = sandbox.ACEatChatModel, nodes = new Map(), disk = new Map(), listeners = new Map(), requests = [], timers = new Map();
  let owner = 'alice', serial = 0, nextFetch = null;
  const id = () => '00000000-0000-4000-8000-' + (++serial).toString(16).padStart(12, '0');
  function element(tag = 'div') {
    return { tag, children: [], dataset: {}, value: '', textContent: '', events: {}, hidden: false, disabled: false, scrollTop: 0, scrollHeight: 10,
      classList: { add() {} }, setAttribute() {}, append(...children) { this.children.push(...children); }, replaceChildren(...children) { this.children = children; },
      addEventListener(event, fn) { this.events[event] = fn; }, querySelectorAll(tag) { return this.children.filter(child => child.tag === tag); } };
  }
  const get = name => { if (!nodes.has(name)) nodes.set(name, element()); return nodes.get(name); };
  const send = element('button'), prompt = element('button'); prompt.dataset.prompt = 'example';
  const document = { baseURI: 'https://aceat.vercel.app/', getElementById: get, createElement: element, createTextNode: text => ({ textContent: text, children: [] }), querySelectorAll: selector => selector === '[data-prompt]' ? [prompt] : [send, prompt] };
  const window = { ACEatAccount: { ready: Promise.resolve(), identity: () => owner }, MathJax: { typesetPromise: async () => {} }, addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); } };
  const emit = type => { for (const fn of listeners.get(type) || []) fn(); };
  const store = window.ACEatChatStore = model.createStore({ identity: () => owner, now: () => Date.now(), randomId: id, read: key => disk.get(key), write: (key, value) => { disk.set(key, value); return true; }, push: async () => {}, fetch: async () => [], changed: () => emit('aceat:chat-updated') });
  const answer = { intent: 'solve', summary: 'Решим', steps: [{ explanation: 'Делим на два', formula: 'x=3' }], answer: '3' };
  const fetch = async (url, options) => { requests.push(JSON.parse(options.body)); if (nextFetch) return nextFetch; return { ok: true, json: async () => ({ ok: true, answer }) }; };
  const Url = globalThis.URL || class { constructor() { this.pathname = '/'; this.hostname = 'aceat.vercel.app'; this.protocol = 'https:'; } };
  const Controller = globalThis.AbortController || class { constructor() { this.signal = {}; } abort() { this.signal.aborted = true; } };
  const run = new Function('globalThis', 'window', 'document', 'crypto', 'location', 'addText', 'loadMath', 'fetch', 'setTimeout', 'clearTimeout', 'AbortController', 'URL', chatSource);
  const addText = (parent, tag, text) => { const child = element(tag); child.textContent = text; parent.append(child); return child; };
  run({ ACEatChatModel: model }, window, document, { randomUUID: id }, { hash: '#chat', hostname: 'aceat.vercel.app' }, addText, async () => {}, fetch, fn => { const key = id(); timers.set(key, fn); return key; }, key => timers.delete(key), Controller, Url);
  const tick = async () => { for (let i = 0; i < 60; i++) await Promise.resolve(); };
  const submit = text => { get('chat-input').value = text; get('chat-form').events.submit({ preventDefault() {} }); };
  const text = node => [node.textContent, ...node.children.map(text)].join(' ');
  await tick();
  submit('Реши 2x=6'); await tick();
  const firstConversation = store.snapshot('algebra').active;
  assert(store.snapshot('algebra').messages.length === 2 && text(get('chat-messages')).includes('Делим на два'), 'Question and structured answer render and save');
  submit('Почему?'); await tick();
  assert(requests[1].history.length === 2 && requests[1].history[0].content === 'Реши 2x=6', 'Restored transcript supplies the AI context');
  const topicButtons = get('topic-list').children;
  topicButtons.find(button => button.dataset.topic === 'reading').events.click(); await tick();
  assert(!text(get('chat-messages')).includes('Реши 2x=6'), 'Switching topics hides the other transcript');
  topicButtons.find(button => button.dataset.topic === 'algebra').events.click(); await tick();
  assert(text(get('chat-messages')).includes('Реши 2x=6'), 'Returning to a topic restores its chat');
  get('clear-chat').events.click(); await tick();
  assert(!text(get('chat-messages')).includes('Реши 2x=6') && get('chat-conversation').children.length === 2, 'New conversation keeps the old one in the selector');
  get('chat-conversation').events.change({ target: { value: firstConversation } }); await tick();
  assert(text(get('chat-messages')).includes('Реши 2x=6'), 'Archived conversation can be reopened');
  let release;
  nextFetch = new Promise(resolve => { release = resolve; });
  submit('Запрос в процессе'); await tick();
  get('clear-chat').events.click(); await tick();
  release({ ok: true, json: async () => ({ ok: true, answer }) }); await tick();
  assert(store.snapshot('algebra').messages.length === 5 && !text(get('chat-messages')).includes('Запрос в процессе'), 'Late AI response cannot leak into a new conversation');
  owner = 'bob'; emit('aceat:identity-changing'); await tick();
  assert(store.snapshot('algebra').messages.length === 0 && !text(get('chat-messages')).includes('Реши 2x=6'), 'Account change immediately clears the previous transcript');
  return 'Chat UI: send/render, AI context, topic restore, archive selection, late responses and account switch passed';
}
