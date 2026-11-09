import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runChatHistoryChecks } from './test_chat_history.mjs';
import { runChatUiChecks } from './test_chat_ui.mjs';

test('Chat history survives device/account changes and network failures', async () => {
  await runChatHistoryChecks(readFileSync(new URL('../chat-store.js', import.meta.url), 'utf8'));
});

test('Chat UI restores history and isolates active conversations', async () => {
  await runChatUiChecks(readFileSync(new URL('../chat.js', import.meta.url), 'utf8'), readFileSync(new URL('../chat-store.js', import.meta.url), 'utf8'));
});
