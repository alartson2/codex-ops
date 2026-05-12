const HTML_PARSE_MODE = 'HTML';

function normalizeNewlines(text) {
  return String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
}

function escapeHtml(text) {
  return String(text || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function escapeHtmlAttr(text) {
  return escapeHtml(text).replace(/"/g, '&quot;');
}

function isSafeHttpUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function stashHtml(placeholders, html) {
  const index = placeholders.push(html) - 1;
  return `\uE000${index}\uE001`;
}

function restoreHtml(placeholders, text) {
  return String(text || '').replace(/\uE000(\d+)\uE001/g, (_, rawIndex) => placeholders[Number(rawIndex)] || '');
}

function splitRawByEscapedLength(rawText, maxEscapedLength) {
  const limit = Math.max(1, Number(maxEscapedLength) || 1);
  const chunks = [];
  let current = '';
  let currentLength = 0;

  for (const char of Array.from(String(rawText || ''))) {
    const escaped = escapeHtml(char);
    if (current && currentLength + escaped.length > limit) {
      chunks.push(current);
      current = '';
      currentLength = 0;
    }
    current += char;
    currentLength += escaped.length;
  }

  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

function splitPlainText(text, maxLength) {
  const limit = Math.max(1, Number(maxLength) || 3500);
  const value = String(text || '');
  const chunks = [];
  let current = '';

  for (const line of value.split('\n')) {
    const next = current ? `${current}\n${line}` : line;
    if (current && next.length > limit) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }

    while (current.length > limit) {
      chunks.push(current.slice(0, limit));
      current = current.slice(limit);
    }
  }

  if (current || chunks.length === 0) chunks.push(current);
  return chunks;
}

export function markdownToPlainTextForTelegram(text) {
  let value = normalizeNewlines(text);
  value = value.replace(/```[a-zA-Z0-9_.+-]*\n?([\s\S]*?)```/g, (_, code) => `\n${String(code || '').replace(/\n$/, '')}\n`);
  value = value.replace(/`([^`\n]+)`/g, '$1');
  value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
  value = value.replace(/\*\*([^*\n]+)\*\*/g, '$1');
  value = value.replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, '$1$2');
  value = value.replace(/~~([^~\n]+)~~/g, '$1');
  value = value.replace(/(^|[^\*])\*([^*\n]+)\*(?=[^\*]|$)/g, '$1$2');
  value = value.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1$2');
  value = value.replace(/^#{1,6}\s+/gm, '');
  value = value.replace(/^>\s?/gm, '');
  return value;
}

function renderInlineMarkdownToHtml(text) {
  const placeholders = [];
  let value = String(text || '');

  value = value.replace(/`([^`\n]+)`/g, (_, code) => stashHtml(placeholders, `<code>${escapeHtml(code)}</code>`));
  value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) => {
    if (!isSafeHttpUrl(url)) return match;
    return stashHtml(placeholders, `<a href="${escapeHtmlAttr(url)}">${escapeHtml(label)}</a>`);
  });

  value = escapeHtml(value);
  value = value.replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');
  value = value.replace(/(^|[^\w])__([^_\n]+)__(?=[^\w]|$)/g, '$1<b>$2</b>');
  value = value.replace(/~~([^~\n]+)~~/g, '<s>$1</s>');
  value = value.replace(/(^|[^\*])\*([^*\n]+)\*(?=[^\*]|$)/g, '$1<i>$2</i>');
  value = value.replace(/(^|[^\w])_([^_\n]+)_(?=[^\w]|$)/g, '$1<i>$2</i>');

  return restoreHtml(placeholders, value);
}

function renderLineToHtml(line) {
  const heading = String(line || '').match(/^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/);
  if (heading) return `<b>${renderInlineMarkdownToHtml(heading[1])}</b>`;

  const quote = String(line || '').match(/^\s{0,3}>\s?(.*)$/);
  if (quote) return `<blockquote>${renderInlineMarkdownToHtml(quote[1]) || ' '}</blockquote>`;

  return renderInlineMarkdownToHtml(line);
}

function makeTextLineBlocks(line, maxLength) {
  const html = `${renderLineToHtml(line)}\n`;
  const plain = `${markdownToPlainTextForTelegram(line)}\n`;
  if (html.length <= maxLength) return [{ text: html, plainText: plain, parseMode: HTML_PARSE_MODE }];

  return splitRawByEscapedLength(markdownToPlainTextForTelegram(line), maxLength - 1)
    .map((part) => ({
      text: `${escapeHtml(part)}\n`,
      plainText: `${part}\n`,
      parseMode: HTML_PARSE_MODE,
    }));
}

function makeCodeBlockBlocks(code, maxLength) {
  const wrapperLength = '<pre></pre>\n'.length;
  const innerLimit = Math.max(1, maxLength - wrapperLength);
  const raw = String(code || '');
  return splitRawByEscapedLength(raw || ' ', innerLimit).map((part) => ({
    text: `<pre>${escapeHtml(part)}</pre>\n`,
    plainText: `${part}\n`,
    parseMode: HTML_PARSE_MODE,
  }));
}

function markdownToHtmlBlocks(markdown, maxLength) {
  const blocks = [];
  const lines = normalizeNewlines(markdown).split('\n');
  let inCodeBlock = false;
  let codeLines = [];

  const flushCodeBlock = () => {
    blocks.push(...makeCodeBlockBlocks(codeLines.join('\n'), maxLength));
    codeLines = [];
  };

  for (const line of lines) {
    if (/^\s*```[a-zA-Z0-9_.+-]*\s*$/.test(line)) {
      if (inCodeBlock) {
        flushCodeBlock();
        inCodeBlock = false;
      } else {
        inCodeBlock = true;
        codeLines = [];
      }
      continue;
    }

    if (inCodeBlock) {
      codeLines.push(line);
      continue;
    }

    blocks.push(...makeTextLineBlocks(line, maxLength));
  }

  if (inCodeBlock) flushCodeBlock();
  return blocks;
}

function finalizeChunk(chunk) {
  const text = String(chunk.text || '').trimEnd();
  const plainText = String(chunk.plainText || '').trimEnd();
  return {
    text: text || '(empty response)',
    plainText: plainText || markdownToPlainTextForTelegram(text) || '(empty response)',
    parseMode: chunk.parseMode,
  };
}

function packBlocks(blocks, maxLength) {
  const chunks = [];
  let current = { text: '', plainText: '', parseMode: HTML_PARSE_MODE };

  for (const block of blocks) {
    if (current.text && current.text.length + block.text.length > maxLength) {
      chunks.push(finalizeChunk(current));
      current = { text: '', plainText: '', parseMode: HTML_PARSE_MODE };
    }

    if (!current.text && block.text.length > maxLength) {
      chunks.push(finalizeChunk(block));
      continue;
    }

    current.text += block.text;
    current.plainText += block.plainText;
  }

  if (current.text || chunks.length === 0) chunks.push(finalizeChunk(current));
  return chunks;
}

function plainMessageChunks(text, maxLength) {
  const plain = markdownToPlainTextForTelegram(text).trim() || '(empty response)';
  return splitPlainText(plain, maxLength).map((chunk) => ({
    text: chunk || '(empty response)',
    plainText: chunk || '(empty response)',
    parseMode: null,
  }));
}

export function formatTelegramMessageChunks(text, options = {}) {
  const maxLength = Math.max(1, Number(options.maxLength) || 3500);
  const format = String(options.format || 'html').trim().toLowerCase();
  const source = String(text || '').trim() || '(empty response)';

  if (format === 'plain') return plainMessageChunks(source, maxLength);
  return packBlocks(markdownToHtmlBlocks(source, maxLength), maxLength);
}
