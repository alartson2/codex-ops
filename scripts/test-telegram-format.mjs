#!/usr/bin/env node
import assert from 'node:assert/strict';
import { formatTelegramMessageChunks, markdownToPlainTextForTelegram } from '../lib/telegram-format.mjs';

const sample = [
  '# Status',
  '',
  'Increase CODEX_EXEC_TIMEOUT_MS and keep snake_case_value intact.',
  '- **bold** and _italic_',
  '- inline `CODEX_EXEC_TIMEOUT_MS`',
  '- [OpenAI](https://openai.com/?a=1&b=2)',
  '',
  '```bash',
  'echo "$CODEX_EXEC_TIMEOUT_MS" && cat file_name.txt',
  '```',
].join('\n');

const htmlChunks = formatTelegramMessageChunks(sample, { maxLength: 3500, format: 'html' });
assert.equal(htmlChunks.length, 1);
assert.equal(htmlChunks[0].parseMode, 'HTML');
assert.match(htmlChunks[0].text, /<b>Status<\/b>/);
assert.match(htmlChunks[0].text, /CODEX_EXEC_TIMEOUT_MS/);
assert.match(htmlChunks[0].text, /snake_case_value/);
assert.match(htmlChunks[0].text, /<b>bold<\/b>/);
assert.match(htmlChunks[0].text, /<i>italic<\/i>/);
assert.match(htmlChunks[0].text, /<code>CODEX_EXEC_TIMEOUT_MS<\/code>/);
assert.match(htmlChunks[0].text, /<pre>echo "\$CODEX_EXEC_TIMEOUT_MS" &amp;&amp; cat file_name\.txt<\/pre>/);
assert.doesNotMatch(htmlChunks[0].text, /\*\*bold\*\*/);

const plain = markdownToPlainTextForTelegram(sample);
assert.match(plain, /CODEX_EXEC_TIMEOUT_MS/);
assert.match(plain, /snake_case_value/);
assert.doesNotMatch(plain, /<b>/);

const smallChunks = formatTelegramMessageChunks('one\ntwo\nthree', { maxLength: 8, format: 'html' });
assert.ok(smallChunks.length > 1);
assert.ok(smallChunks.every((chunk) => chunk.text.length <= 8));

console.log('telegram-format smoke tests passed');
