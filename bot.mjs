#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { formatTelegramMessageChunks } from './lib/telegram-format.mjs';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_IDS = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const INCIDENTS_DIR = process.env.INCIDENTS_DIR || '/srv/codex-ops/incidents';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/codexops/state';
const CHAT_STATE_FILE = process.env.CHAT_STATE_FILE || path.join(STATE_DIR, 'chat-state.json');
const OFFSET_STATE_FILE = process.env.OFFSET_STATE_FILE || path.join(STATE_DIR, 'telegram-offset.txt');
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(STATE_DIR, 'uploads');
const PROJECTS_DIR = process.env.PROJECTS_DIR || '/srv/codex-ops/projects';
const DEFAULT_PROJECT = process.env.DEFAULT_PROJECT || 'openclaw';
const OPENCLAW_CONTAINER = process.env.OPENCLAW_CONTAINER || 'openclaw-yvrh-openclaw-1';
const CODEX_HOME = process.env.CODEX_HOME || '/var/lib/codexops/.codex';
const CODEX_CWD = process.env.CODEX_CWD || INCIDENTS_DIR;
const OPS_CONTEXT_FILE = process.env.OPS_CONTEXT_FILE || '/srv/codex-ops/OPS_CONTEXT.md';
const RUNBOOK_FILE = process.env.RUNBOOK_FILE || '/srv/codex-ops/RUNBOOK_OPENCLAW.md';
const HOST_LABEL = process.env.HOST_LABEL || os.hostname();
const ASSISTANT_LANGUAGE = (process.env.ASSISTANT_LANGUAGE || 'Russian').trim() || 'Russian';
const HISTORY_ITEMS = Math.max(0, Number(process.env.HISTORY_ITEMS || '8') || 8);
const HISTORY_ITEM_CHARS = Math.max(300, Number(process.env.HISTORY_ITEM_CHARS || '1400') || 1400);
const MAX_MESSAGE = Math.min(3500, Math.max(500, Number(process.env.MAX_MESSAGE || '3500') || 3500));
const MAX_MESSAGE_CHUNKS = Math.min(20, Math.max(1, Number(process.env.MAX_MESSAGE_CHUNKS || '4') || 4));
const TELEGRAM_FORMAT = ['html', 'plain'].includes(String(process.env.TELEGRAM_FORMAT || 'html').trim().toLowerCase())
  ? String(process.env.TELEGRAM_FORMAT || 'html').trim().toLowerCase()
  : 'html';
const OUTBOUND_DELAY_MS = Math.max(0, Number(process.env.OUTBOUND_DELAY_MS || '250') || 250);
const TG_RETRY_ATTEMPTS = Math.max(1, Number(process.env.TG_RETRY_ATTEMPTS || '3') || 3);
const TG_RETRY_FALLBACK_DELAY_MS = Math.max(500, Number(process.env.TG_RETRY_FALLBACK_DELAY_MS || '2000') || 2000);
const TG_RETRY_MAX_WAIT_MS = Math.max(1000, Number(process.env.TG_RETRY_MAX_WAIT_MS || '120000') || 120000);
const HISTORICAL_INCIDENT_LIMIT = Math.max(1000, Number(process.env.HISTORICAL_INCIDENT_LIMIT || '4000') || 4000);
const CODEX_DEVICE_AUTH_TIMEOUT_MS = Math.max(120000, Number(process.env.CODEX_DEVICE_AUTH_TIMEOUT_MS || '900000') || 900000);
const CODEX_EXEC_TIMEOUT_MS = Math.max(0, Number(process.env.CODEX_EXEC_TIMEOUT_MS || '0') || 0);
const CODEX_MODEL_CATALOG_TIMEOUT_MS = readOptionalNonNegativeMs('CODEX_MODEL_CATALOG_TIMEOUT_MS', 30000, { minPositive: 5000 });
const CODEX_PROGRESS_INTERVAL_MS = readOptionalNonNegativeMs('CODEX_PROGRESS_INTERVAL_MS', 300000, { minPositive: 60000 });
const CODEX_PROGRESS_MAX_CHARS = Math.max(500, Number(process.env.CODEX_PROGRESS_MAX_CHARS || '1800') || 1800);
const CODEX_STOP_KILL_GRACE_MS = readOptionalNonNegativeMs('CODEX_STOP_KILL_GRACE_MS', 10000, { minPositive: 1000 });
const TELEGRAM_IMAGE_MAX_BYTES = Math.max(1000000, Number(process.env.TELEGRAM_IMAGE_MAX_BYTES || '10000000') || 10000000);
const PENDING_IMAGE_TTL_MS = readOptionalNonNegativeMs('PENDING_IMAGE_TTL_MS', 1800000, { minPositive: 60000 });
const PENDING_IMAGE_MAX_ITEMS = Math.min(10, Math.max(1, Number(process.env.PENDING_IMAGE_MAX_ITEMS || '4') || 4));
let offset = 0;
let activeTask = null;
let activeTaskSeq = 0;
let authFlow = null;

function readOptionalNonNegativeMs(name, defaultValue, opts = {}) {
  const raw = process.env[name];
  if (raw == null || String(raw).trim() === '') return defaultValue;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return defaultValue;
  if (value === 0) return 0;
  const minPositive = Number(opts.minPositive) || 0;
  return Math.max(minPositive, value);
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function clip(text, limit = 1200) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDurationMs(ms) {
  const value = Math.max(0, Number(ms) || 0);
  if (value < 1000) return `${value}ms`;
  const seconds = Math.floor(value / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function normalizeTelegramText(text) {
  return String(text || '').trim().replace(/^\/([A-Za-z0-9_]+)@[A-Za-z0-9_]+(?=\s|$)/, '/$1');
}

function isSameChat(left, right) {
  return String(left) === String(right);
}

function activeTaskForChat(chatId) {
  return activeTask && isSameChat(activeTask.chatId, chatId) ? activeTask : null;
}

function activeTaskAge(task) {
  return task && task.startedAt ? formatDurationMs(Date.now() - task.startedAt) : 'unknown';
}

function activeTaskLabel(task) {
  if (!task) return 'none';
  const kind = task.kind === 'diag' ? 'diagnostic' : task.kind === 'steer' ? 'steer resume' : 'Codex request';
  return `#${task.id} ${kind}`;
}

function renderActiveTask(task = activeTask) {
  if (!task) return 'No active Codex task.';
  const lines = [
    `Active task: ${activeTaskLabel(task)}`,
    `Project: ${task.project || '(unknown)'}`,
    `Phase: ${task.phase || 'unknown'}`,
    `Elapsed: ${activeTaskAge(task)}`,
  ];
  if (task.stopRequested) lines.push(`Stop requested: ${task.steerText ? 'yes, steer will resume' : 'yes'}`);
  const requestText = task.steerSource || task.question;
  if (requestText) lines.push(`Request: ${clip(requestText, 700)}`);
  return lines.join('\n');
}

function createActiveTask({ chatId, kind = 'request', project = DEFAULT_PROJECT, question = '', images = [], resumeLast = false, previousTaskId = null }) {
  const task = {
    id: ++activeTaskSeq,
    chatId,
    kind,
    project,
    question: String(question || ''),
    images: Array.isArray(images) ? images.map(normalizePendingImage).filter(Boolean) : [],
    resumeLast: Boolean(resumeLast),
    previousTaskId,
    startedAt: Date.now(),
    phase: 'starting',
    codexSessionStarted: false,
    child: null,
    stopRequested: false,
    stopReason: '',
    steerText: '',
    promise: null,
  };
  activeTask = task;
  return task;
}

function setActiveTaskChild(task, child) {
  if (!task || !child) return;
  if (!activeTask || activeTask.id !== task.id) return;
  task.child = child;
}

function clearActiveTaskChild(task, child) {
  if (!task) return;
  if (child && task.child !== child) return;
  task.child = null;
}

function attachCodexChild(task, child) {
  if (!task || !child) return;
  task.codexSessionStarted = true;
  setActiveTaskChild(task, child);
  if (task.stopRequested) terminateTaskProcess(task);
}

function signalChildProcess(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null || child.signalCode !== null) return false;
  try {
    if (child.__codexOpsKillProcessGroup && child.pid && process.platform !== 'win32') {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
    return true;
  } catch {
    try {
      child.kill(signal);
      return true;
    } catch {
      return false;
    }
  }
}

function terminateTaskProcess(task, signal = 'SIGTERM') {
  const child = task && task.child;
  if (!signalChildProcess(child, signal)) return false;
  if (CODEX_STOP_KILL_GRACE_MS > 0 && signal !== 'SIGKILL') {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        signalChildProcess(child, 'SIGKILL');
      }
    }, CODEX_STOP_KILL_GRACE_MS);
    if (typeof timer.unref === 'function') timer.unref();
  }
  return true;
}

function compactIncidentForPrompt(text, limit = HISTORICAL_INCIDENT_LIMIT) {
  const value = String(text || '');
  const rawMarker = '\n## Raw context';
  const cutIndex = value.indexOf(rawMarker);
  const withoutRaw = cutIndex >= 0 ? value.slice(0, cutIndex) : value;
  return clip(withoutRaw, limit);
}

function normalizeProjectName(name) {
  return String(name || '').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
}

function normalizeCodexSettingValue(value) {
  const text = String(value || '').trim();
  if (!text || text.length > 80) return '';
  return /^[A-Za-z0-9._:-]+$/.test(text) ? text : '';
}

function quoteTomlString(value) {
  return JSON.stringify(String(value || ''));
}

function looksLikeCodexSubscription403(text) {
  const value = String(text || '');
  if (!value) return false;
  return (
    value.includes('403 Forbidden')
    && (
      value.includes('chatgpt.com/backend-api/codex/responses')
      || value.includes('chatgpt.com/backend-api/codex/models')
    )
  );
}

class TelegramApiError extends Error {
  constructor(method, data, status) {
    super(`Telegram API ${method} failed: ${JSON.stringify(data)}`);
    this.name = 'TelegramApiError';
    this.method = method;
    this.status = status;
    this.errorCode = Number(data && data.error_code) || 0;
    this.description = String(data && data.description || '');
    const retry = data && data.parameters && data.parameters.retry_after;
    this.retryAfterSec = Number.isFinite(Number(retry)) ? Number(retry) : null;
  }
}

async function tg(method, payload = {}) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  let data = null;
  try {
    data = await res.json();
  } catch {
    throw new Error(`Telegram API ${method} returned non-JSON response (status ${res.status}).`);
  }
  if (!data.ok) throw new TelegramApiError(method, data, res.status);
  return data.result;
}

async function tgSendMessageWithRetry(payload, meta = {}) {
  for (let attempt = 1; attempt <= TG_RETRY_ATTEMPTS; attempt += 1) {
    try {
      return await tg('sendMessage', payload);
    } catch (error) {
      const is429 = error instanceof TelegramApiError && error.errorCode === 429;
      const canRetry = attempt < TG_RETRY_ATTEMPTS;
      if (!is429 || !canRetry) throw error;
      const waitMs = Math.min(
        error.retryAfterSec != null ? Math.max(1000, error.retryAfterSec * 1000) : TG_RETRY_FALLBACK_DELAY_MS,
        TG_RETRY_MAX_WAIT_MS,
      );
      console.warn(`[bot-send-retry] chat=${meta.chatId || '?'} attempt=${attempt}/${TG_RETRY_ATTEMPTS} waitMs=${waitMs}`);
      await sleep(waitMs);
    }
  }
}

async function sendMessage(chatId, text, extra = {}) {
  const value = String(text || '').trim() || '(empty response)';
  const chunks = formatTelegramMessageChunks(value, { maxLength: MAX_MESSAGE, format: TELEGRAM_FORMAT });
  let outbound = chunks;
  if (chunks.length > MAX_MESSAGE_CHUNKS) {
    const kept = chunks.slice(0, MAX_MESSAGE_CHUNKS - 1);
    const omitted = chunks.length - kept.length;
    kept.push(...formatTelegramMessageChunks(
      `Reply truncated to avoid Telegram flood.\nSent chunks: ${kept.length}/${chunks.length}.\nFull body was not delivered to chat.`,
      { maxLength: MAX_MESSAGE, format: TELEGRAM_FORMAT },
    ).slice(0, 1));
    outbound = kept;
    console.warn(`[bot-send-truncated] chat=${chatId} chunks=${chunks.length} omitted=${omitted}`);
  }
  for (let i = 0; i < outbound.length; i += 1) {
    const chunk = outbound[i];
    const payload = { chat_id: chatId, text: chunk.text, disable_web_page_preview: true, ...extra };
    if (chunk.parseMode && !Object.prototype.hasOwnProperty.call(extra, 'parse_mode')) payload.parse_mode = chunk.parseMode;
    try {
      await tgSendMessageWithRetry(payload, { chatId });
    } catch (error) {
      const canFallbackToPlain = payload.parse_mode === 'HTML' && error instanceof TelegramApiError && error.errorCode === 400;
      if (!canFallbackToPlain) throw error;
      console.warn(`[bot-send-format-fallback] chat=${chatId} error=${error.description || error.message}`);
      const fallbackPayload = { ...payload, text: chunk.plainText || '(empty response)' };
      delete fallbackPayload.parse_mode;
      await tgSendMessageWithRetry(fallbackPayload, { chatId });
    }
    if (OUTBOUND_DELAY_MS > 0 && i + 1 < outbound.length) await sleep(OUTBOUND_DELAY_MS);
  }
}

async function loadOffsetState() {
  try {
    const raw = (await fs.readFile(OFFSET_STATE_FILE, 'utf8')).trim();
    const value = Number(raw);
    return Number.isInteger(value) && value >= 0 ? value : 0;
  } catch {
    return 0;
  }
}

async function saveOffsetState(value) {
  await fs.mkdir(path.dirname(OFFSET_STATE_FILE), { recursive: true });
  await fs.writeFile(OFFSET_STATE_FILE, `${Math.max(0, Number(value) || 0)}\n`, 'utf8');
}

async function editMessage(chatId, messageId, text, extra = {}) {
  return tg('editMessageText', { chat_id: chatId, message_id: messageId, text, disable_web_page_preview: true, ...extra });
}

async function answerCallbackQuery(callbackQueryId, text = '') {
  return tg('answerCallbackQuery', text ? { callback_query_id: callbackQueryId, text } : { callback_query_id: callbackQueryId });
}

function imageExtensionFromMime(mimeType) {
  const value = String(mimeType || '').toLowerCase();
  if (value === 'image/jpeg' || value === 'image/jpg') return '.jpg';
  if (value === 'image/png') return '.png';
  if (value === 'image/webp') return '.webp';
  if (value === 'image/gif') return '.gif';
  return '';
}

function imageExtensionFromName(name) {
  const ext = path.extname(String(name || '')).toLowerCase();
  return ['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext) ? (ext === '.jpeg' ? '.jpg' : ext) : '';
}

function sanitizeUploadName(name) {
  return String(name || 'image')
    .replace(/[^\w.-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'image';
}

function selectTelegramImageAttachment(msg) {
  const photos = Array.isArray(msg && msg.photo) ? msg.photo : [];
  if (photos.length) {
    const photo = photos.reduce((best, item) => ((Number(item.file_size) || 0) > (Number(best.file_size) || 0) ? item : best), photos[photos.length - 1]);
    return {
      source: 'photo',
      fileId: photo.file_id,
      fileUniqueId: photo.file_unique_id || '',
      fileSize: Number(photo.file_size) || 0,
      mimeType: 'image/jpeg',
      originalName: `telegram-photo-${msg.message_id || nowStamp()}.jpg`,
    };
  }
  const document = msg && msg.document;
  if (document) {
    const mimeType = String(document.mime_type || '');
    const originalName = document.file_name || `telegram-image-${msg.message_id || nowStamp()}`;
    const supportedImageExt = imageExtensionFromMime(mimeType) || imageExtensionFromName(originalName);
    if (mimeType.toLowerCase().startsWith('image/') || supportedImageExt) {
      if (!supportedImageExt) {
        return {
          unsupported: true,
          source: 'document',
          mimeType,
          originalName,
          fileSize: Number(document.file_size) || 0,
        };
      }
      return {
        source: 'document',
        fileId: document.file_id,
        fileUniqueId: document.file_unique_id || '',
        fileSize: Number(document.file_size) || 0,
        mimeType: mimeType || 'image/*',
        originalName,
      };
    }
    return {
      unsupported: true,
      source: 'document',
      mimeType,
      originalName,
      fileSize: Number(document.file_size) || 0,
    };
  }
  return null;
}

function normalizePendingImage(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const filePath = String(entry.path || '').trim();
  if (!filePath) return null;
  const root = path.resolve(UPLOADS_DIR);
  const resolved = path.resolve(filePath);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) return null;
  const ts = entry.ts || new Date().toISOString();
  const ageMs = Date.now() - (Date.parse(ts) || Date.now());
  if (PENDING_IMAGE_TTL_MS > 0 && ageMs > PENDING_IMAGE_TTL_MS) return null;
  return {
    path: resolved,
    originalName: sanitizeUploadName(entry.originalName || path.basename(resolved)),
    mimeType: String(entry.mimeType || 'image/*').slice(0, 80),
    size: Math.max(0, Number(entry.size) || 0),
    source: String(entry.source || 'telegram').slice(0, 40),
    ts,
  };
}

function formatImageList(images) {
  const items = Array.isArray(images) ? images.map(normalizePendingImage).filter(Boolean) : [];
  if (!items.length) return '(none)';
  return items.map((image, index) => {
    const details = [image.mimeType, image.size ? formatBytes(image.size) : 'size unknown'].filter(Boolean).join(', ');
    return `${index + 1}. ${image.originalName} (${details}) path: ${image.path}`;
  }).join('\n');
}

function imageHistorySuffix(images) {
  const items = Array.isArray(images) ? images.map(normalizePendingImage).filter(Boolean) : [];
  if (!items.length) return '';
  const names = items.map((image) => image.originalName).join(', ');
  return `[Telegram image attachments: ${names}]`;
}

async function downloadTelegramImage(attachment, msg) {
  if (!attachment || !attachment.fileId) throw new Error('Telegram image has no file_id.');
  if (attachment.fileSize > TELEGRAM_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large: ${formatBytes(attachment.fileSize)}. Limit: ${formatBytes(TELEGRAM_IMAGE_MAX_BYTES)}.`);
  }
  const info = await tg('getFile', { file_id: attachment.fileId });
  const filePath = String(info && info.file_path || '');
  if (!filePath) throw new Error('Telegram did not return file_path for this image.');
  const declaredSize = Math.max(Number(info.file_size) || 0, Number(attachment.fileSize) || 0);
  if (declaredSize > TELEGRAM_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large: ${formatBytes(declaredSize)}. Limit: ${formatBytes(TELEGRAM_IMAGE_MAX_BYTES)}.`);
  }

  const res = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  if (!res.ok) throw new Error(`Telegram file download failed with status ${res.status}.`);
  const contentLength = Number(res.headers.get('content-length')) || 0;
  if (contentLength > TELEGRAM_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large: ${formatBytes(contentLength)}. Limit: ${formatBytes(TELEGRAM_IMAGE_MAX_BYTES)}.`);
  }
  const buffer = Buffer.from(await res.arrayBuffer());
  if (buffer.length > TELEGRAM_IMAGE_MAX_BYTES) {
    throw new Error(`Image is too large: ${formatBytes(buffer.length)}. Limit: ${formatBytes(TELEGRAM_IMAGE_MAX_BYTES)}.`);
  }

  const ext = imageExtensionFromMime(attachment.mimeType) || imageExtensionFromName(attachment.originalName) || imageExtensionFromName(filePath) || '.jpg';
  const baseName = sanitizeUploadName(path.basename(attachment.originalName || path.basename(filePath), path.extname(attachment.originalName || filePath)));
  const dayDir = new Date().toISOString().slice(0, 10);
  const targetDir = path.join(UPLOADS_DIR, dayDir);
  await fs.mkdir(targetDir, { recursive: true });
  const target = path.join(targetDir, `${nowStamp()}-${msg.chat.id}-${msg.message_id || 'msg'}-${randomUUID()}-${baseName}${ext}`);
  await fs.writeFile(target, buffer);
  return {
    path: target,
    originalName: sanitizeUploadName(attachment.originalName || path.basename(filePath)),
    mimeType: attachment.mimeType || 'image/*',
    size: buffer.length,
    source: attachment.source || 'telegram',
    ts: new Date().toISOString(),
  };
}

function stripAnsi(text) {
  return String(text || '').replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1B\][^\x07]*(\x07|\x1B\\)/g, '');
}

function parseDeviceAuthDetails(text) {
  const clean = stripAnsi(text);
  const urlMatch = clean.match(/https:\/\/auth\.openai\.com\/codex\/device/);
  const codeMatch = clean.match(/\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/);
  return {
    url: urlMatch ? urlMatch[0] : '',
    code: codeMatch ? codeMatch[0] : '',
    clean,
  };
}

function lineStartsToolTranscript(line) {
  const value = String(line || '').trim();
  if (!value) return false;
  return (
    /^(apply patch|apply_patch|patch:\s|diff --git\b|\*\*\* Begin Patch|\*\*\* End Patch)/i.test(value)
    || /^(shell|shell command|shell_command|functions\.shell_command|python|node|bash|powershell)\b/i.test(value)
    || /^(index [0-9a-f]{7,}\.\.[0-9a-f]{7,}|--- a\/|\+\+\+ b\/|--- \/|\+\+\+ \/|@@)/i.test(value)
  );
}

function stripCodexToolTranscript(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const kept = [];
  for (const line of lines) {
    if (lineStartsToolTranscript(line)) break;
    kept.push(line);
  }
  return kept.join('\n').trim();
}

function extractCodexAssistantFallback(stderrText, limit = 2800) {
  const clean = stripAnsi(stderrText || '');
  const re = /(?:^|\n)codex\n([\s\S]*?)(?=\n(?:exec|tokens used|user)\n|$)/g;
  let match;
  let last = '';
  while ((match = re.exec(clean)) !== null) {
    const candidate = stripCodexToolTranscript(match[1]);
    if (candidate) last = candidate;
  }
  if (!last) return '';
  return clip(last, limit);
}

function createCodexProgressReporter({ chatId, intervalMs = CODEX_PROGRESS_INTERVAL_MS, maxChars = CODEX_PROGRESS_MAX_CHARS } = {}) {
  if (!chatId || !Number.isFinite(intervalMs) || intervalMs <= 0) {
    return { pushStderr() {}, stop() {} };
  }

  const startedAt = Date.now();
  let stderrText = '';
  let lastSentText = '';
  let sending = false;
  let stopped = false;

  const buildProgressMessage = () => {
    const elapsed = formatDurationMs(Date.now() - startedAt);
    const assistantText = extractCodexAssistantFallback(stderrText, maxChars);
    if (assistantText && assistantText !== lastSentText) {
      lastSentText = assistantText;
      return [
        'Codex progress update',
        `Elapsed: ${elapsed}. This is not the final answer.`,
        '',
        assistantText,
      ].join('\n');
    }

    return [
      'Codex progress update',
      `Elapsed: ${elapsed}. This is not the final answer.`,
      '',
      'Codex is still working. It did not emit a new text progress summary during the last interval; the final report will arrive as a separate message.',
    ].join('\n');
  };

  const sendProgress = async () => {
    if (stopped || sending) return;
    sending = true;
    try {
      await sendMessage(chatId, buildProgressMessage());
    } catch (error) {
      console.warn(`[bot-progress-send-failed] chat=${chatId} error=${error && (error.stack || error.message)}`);
    } finally {
      sending = false;
    }
  };

  const timer = setInterval(() => {
    void sendProgress();
  }, intervalMs);
  if (typeof timer.unref === 'function') timer.unref();

  return {
    pushStderr(chunk) {
      stderrText += String(chunk || '');
      if (stderrText.length > 120000) stderrText = stderrText.slice(-120000);
    },
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}

async function codexLoginStatus() {
  const args = ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'login', 'status'];
  return run('env', args, { timeoutMs: 30000 });
}

async function startDeviceAuthFlow(chatId) {
  if (authFlow) {
    await sendMessage(chatId, `Login flow is already in progress for chat ${authFlow.chatId}. Use /codex login cancel first if needed.`);
    return;
  }

  authFlow = { chatId, canceled: false, startedAt: Date.now(), child: null };
  await sendMessage(chatId, 'Starting Codex device login. I will send the URL and one-time code.');

  const args = ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'login', '--device-auth'];
  const child = spawn('env', args, { stdio: ['ignore', 'pipe', 'pipe'] });
  authFlow.child = child;

  let combined = '';
  let sentDeviceCode = false;
  let timeoutHit = false;

  const maybeSendDeviceCode = () => {
    if (sentDeviceCode || !authFlow || authFlow.canceled) return;
    const details = parseDeviceAuthDetails(combined);
    if (!details.url || !details.code) return;
    sentDeviceCode = true;
    void sendMessage(chatId, [
      'Codex login in progress.',
      `1) Open: ${details.url}`,
      `2) Enter code: ${details.code}`,
      'After browser confirmation, I will report final status here.',
    ].join('\n')).catch(() => {});
  };

  child.stdout.on('data', (chunk) => {
    combined += chunk.toString();
    maybeSendDeviceCode();
  });
  child.stderr.on('data', (chunk) => {
    combined += chunk.toString();
    maybeSendDeviceCode();
  });

  const timer = setTimeout(() => {
    timeoutHit = true;
    try {
      child.kill('SIGTERM');
    } catch {}
  }, CODEX_DEVICE_AUTH_TIMEOUT_MS);
  void (async () => {
    const result = await new Promise((resolve) => {
      child.on('close', (code, signal) => resolve({ code, signal, error: null }));
      child.on('error', (error) => resolve({ code: 1, signal: null, error }));
    });
    clearTimeout(timer);

    const current = authFlow;
    authFlow = null;
    if (!current || current.canceled) return;

    const details = parseDeviceAuthDetails(combined);
    const debugFile = path.join(STATE_DIR, `codex-login-debug-${nowStamp()}.log`);
    await fs.mkdir(STATE_DIR, { recursive: true });
    await fs.writeFile(debugFile, combined || '(empty output)\n', 'utf8');

    if (!sentDeviceCode && details.url && details.code) {
      await sendMessage(chatId, [
        'Device auth details were captured late.',
        `Open: ${details.url}`,
        `Code: ${details.code}`,
      ].join('\n'));
    }

    if (result.code === 0 && /Successfully logged in/i.test(stripAnsi(combined))) {
      const status = await codexLoginStatus();
      await sendMessage(chatId, `Codex login completed.\n${(status.stdout || status.stderr || '').trim() || 'Status check returned no output.'}`);
      return;
    }

    if (timeoutHit) {
      await sendMessage(chatId, [
        'Device login timed out before completion.',
        `Debug log: ${debugFile}`,
        'Run /codex login again to generate a fresh code.',
      ].join('\n'));
      return;
    }

    const errTail = stripAnsi(combined).split('\n').filter(Boolean).slice(-8).join('\n');
    const extra = result.error ? `\n${result.error.message || String(result.error)}` : '';
    await sendMessage(chatId, [
      'Device login failed.',
      errTail || '(no detailed output)',
      extra.trim(),
      `Debug log: ${debugFile}`,
    ].filter(Boolean).join('\n'));
  })().catch(async (error) => {
    console.error(`[bot-auth-flow-error] chat=${chatId} error=${error && (error.stack || error.message)}`);
    authFlow = null;
    try {
      await sendMessage(chatId, `Device login flow crashed: ${error.message || String(error)}`);
    } catch {}
  });
}

async function cancelDeviceAuthFlow(chatId) {
  if (!authFlow || !authFlow.child) {
    await sendMessage(chatId, 'No active login flow.');
    return;
  }
  authFlow.canceled = true;
  try {
    authFlow.child.kill('SIGTERM');
  } catch {}
  await sendMessage(chatId, 'Canceled active login flow.');
}

function resolveRunTimeoutMs(opts, defaultMs = 120000) {
  if (!Object.prototype.hasOwnProperty.call(opts, 'timeoutMs')) return defaultMs;
  if (opts.timeoutMs == null) return 0;
  const value = Number(opts.timeoutMs);
  return Number.isFinite(value) ? Math.max(0, value) : defaultMs;
}

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const {
      input,
      onStdout,
      onStderr,
      onChild,
      killProcessGroup,
      timeoutMs: _timeoutMs,
      ...spawnOpts
    } = opts;
    const spawnOptions = { stdio: ['pipe', 'pipe', 'pipe'], ...spawnOpts };
    if (killProcessGroup && process.platform !== 'win32') spawnOptions.detached = true;
    const child = spawn(command, args, spawnOptions);
    child.__codexOpsKillProcessGroup = Boolean(killProcessGroup && process.platform !== 'win32');
    if (typeof onChild === 'function') {
      try {
        onChild(child);
      } catch (error) {
        console.warn(`[run-on-child-error] ${error && (error.stack || error.message)}`);
      }
    }
    let stdout = '';
    let stderr = '';
    const timeoutMs = resolveRunTimeoutMs(opts);
    let timedOut = false;
    let timer = null;
    if (Number.isFinite(timeoutMs) && timeoutMs > 0) {
      timer = setTimeout(() => {
        timedOut = true;
        signalChildProcess(child, 'SIGTERM');
      }, timeoutMs);
    }
    if (input) child.stdin.end(input); else child.stdin.end();
    child.stdout.on('data', (d) => {
      const text = d.toString();
      stdout += text;
      if (typeof onStdout === 'function') onStdout(text);
    });
    child.stderr.on('data', (d) => {
      const text = d.toString();
      stderr += text;
      if (typeof onStderr === 'function') onStderr(text);
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, stdout, stderr, timedOut });
    });
    child.on('error', (error) => {
      if (timer) clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}\n${error.stack || error.message}`.trim(), timedOut });
    });
  });
}

async function sh(script, timeoutMs = 120000, opts = {}) {
  return run('bash', ['-lc', script], { timeoutMs, ...opts });
}

async function loadCodexModelCatalog() {
  const result = await run('env', ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'debug', 'models'], {
    timeoutMs: CODEX_MODEL_CATALOG_TIMEOUT_MS,
  });
  if (result.code !== 0 || !String(result.stdout || '').trim()) {
    throw new Error((result.stderr || result.stdout || 'codex debug models returned no output').trim());
  }
  let parsed = null;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`Could not parse codex model catalog JSON: ${error.message}`);
  }
  const rawModels = Array.isArray(parsed && parsed.models) ? parsed.models : [];
  return rawModels
    .map((model) => {
      const slug = normalizeCodexSettingValue(model && model.slug);
      if (!slug) return null;
      const supported = Array.isArray(model.supported_reasoning_levels) ? model.supported_reasoning_levels : [];
      return {
        slug,
        displayName: String(model.display_name || slug).slice(0, 80),
        description: String(model.description || '').slice(0, 240),
        defaultReasoning: normalizeCodexSettingValue(model.default_reasoning_level),
        reasoningLevels: supported.map((item) => ({
          effort: normalizeCodexSettingValue(item && item.effort),
          description: String(item && item.description || '').slice(0, 160),
        })).filter((item) => item.effort),
        visibility: String(model.visibility || ''),
        priority: Number(model.priority) || 0,
      };
    })
    .filter(Boolean)
    .filter((model) => model.visibility !== 'hidden')
    .sort((a, b) => (b.priority - a.priority) || a.slug.localeCompare(b.slug));
}

async function readCodexConfigDefaults() {
  const file = path.join(CODEX_HOME, 'config.toml');
  try {
    const text = await fs.readFile(file, 'utf8');
    const model = text.match(/^\s*model\s*=\s*["']([^"']+)["']/m);
    const reasoning = text.match(/^\s*reasoning_effort\s*=\s*["']([^"']+)["']/m);
    return {
      model: normalizeCodexSettingValue(model && model[1]),
      reasoningEffort: normalizeCodexSettingValue(reasoning && reasoning[1]),
    };
  } catch {
    return { model: '', reasoningEffort: '' };
  }
}

function modelBySlug(models, slug) {
  const selected = normalizeCodexSettingValue(slug);
  return Array.isArray(models) ? models.find((model) => model.slug === selected) || null : null;
}

function reasoningLevelsForModel(models, slug) {
  const model = modelBySlug(models, slug);
  if (model && model.reasoningLevels.length) return model.reasoningLevels;
  const seen = new Set();
  const levels = [];
  for (const item of Array.isArray(models) ? models : []) {
    for (const level of item.reasoningLevels || []) {
      if (seen.has(level.effort)) continue;
      seen.add(level.effort);
      levels.push(level);
    }
  }
  return levels;
}

function effectiveCodexSettings(state, defaults = {}) {
  const codexModel = normalizeCodexSettingValue(state && state.codexModel);
  const codexReasoningEffort = normalizeCodexSettingValue(state && state.codexReasoningEffort);
  return {
    model: codexModel || normalizeCodexSettingValue(defaults.model),
    reasoningEffort: codexReasoningEffort || normalizeCodexSettingValue(defaults.reasoningEffort),
    modelOverride: Boolean(codexModel),
    reasoningOverride: Boolean(codexReasoningEffort),
  };
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

async function loadAllChatState() {
  try {
    const text = await fs.readFile(CHAT_STATE_FILE, 'utf8');
    const data = JSON.parse(text);
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

async function saveAllChatState(all) {
  await fs.mkdir(path.dirname(CHAT_STATE_FILE), { recursive: true });
  const tmp = `${CHAT_STATE_FILE}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(all, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, CHAT_STATE_FILE);
}

function normalizeHistoryEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const role = entry.role === 'assistant' ? 'assistant' : 'user';
  const text = clip(entry.text, HISTORY_ITEM_CHARS);
  if (!text) return null;
  return { role, text, ts: entry.ts || new Date().toISOString() };
}

function normalizeChatState(state) {
  const project = normalizeProjectName(state && state.project) || DEFAULT_PROJECT;
  const history = Array.isArray(state && state.history) ? state.history.map(normalizeHistoryEntry).filter(Boolean).slice(-HISTORY_ITEMS) : [];
  const pendingImages = Array.isArray(state && state.pendingImages)
    ? state.pendingImages.map(normalizePendingImage).filter(Boolean).slice(-PENDING_IMAGE_MAX_ITEMS)
    : [];
  const codexModel = normalizeCodexSettingValue(state && state.codexModel);
  const codexReasoningEffort = normalizeCodexSettingValue(state && state.codexReasoningEffort);
  return { project, history, pendingImages, codexModel, codexReasoningEffort };
}

function emptyChatState(project = DEFAULT_PROJECT) {
  return normalizeChatState({ project, history: [] });
}

async function getChatState(chatId) {
  const all = await loadAllChatState();
  return normalizeChatState(all[String(chatId)]);
}

async function setChatState(chatId, state) {
  const all = await loadAllChatState();
  all[String(chatId)] = normalizeChatState(state);
  await saveAllChatState(all);
  return all[String(chatId)];
}

async function updateChatState(chatId, mutate) {
  const current = await getChatState(chatId);
  const next = await mutate(current);
  return setChatState(chatId, next);
}

function appendHistory(state, role, text) {
  const item = normalizeHistoryEntry({ role, text, ts: new Date().toISOString() });
  if (!item || HISTORY_ITEMS === 0) return normalizeChatState(state);
  return normalizeChatState({ ...state, history: [...(state.history || []), item].slice(-HISTORY_ITEMS) });
}

function appendExchange(state, question, answer) {
  let next = appendHistory(state, 'user', question);
  next = appendHistory(next, 'assistant', answer);
  return next;
}

async function addPendingImages(chatId, images) {
  const state = await getChatState(chatId);
  const incoming = Array.isArray(images) ? images.map(normalizePendingImage).filter(Boolean) : [];
  const pendingImages = [...state.pendingImages, ...incoming].slice(-PENDING_IMAGE_MAX_ITEMS);
  await setChatState(chatId, { ...state, pendingImages });
  return pendingImages;
}

function projectPaths(project) {
  const safe = normalizeProjectName(project) || DEFAULT_PROJECT;
  const dir = path.join(PROJECTS_DIR, safe);
  return {
    dir,
    context: path.join(dir, 'CONTEXT.md'),
    runbook: path.join(dir, 'RUNBOOK.md'),
    changelog: path.join(dir, 'CHANGELOG.md'),
    notes: path.join(dir, 'NOTES.md'),
  };
}

async function listProjects() {
  try {
    const entries = await fs.readdir(PROJECTS_DIR, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}
function defaultProjectContext(project) {
  if (project === 'openclaw') {
    return `# OpenClaw Project Context

Use this project when the user is asking about OpenClaw administration, incidents, upgrades, container internals, or project work that depends on the OpenClaw runtime.

Key runtime facts:
- main container: ${OPENCLAW_CONTAINER}
- wrapper to inspect on failures: /hostinger/server.mjs
- internal ports to verify: 127.0.0.1:18789 and 127.0.0.1:18791
- incident archive on host: ${INCIDENTS_DIR}

Important working style:
- diagnose before proposing fixes
- prefer live server evidence over stale notes
- re-check approval-flow and gateway-respawn behavior after upgrades or image rebuilds
- if project workspaces are not on the host, inspect them through docker exec
`;
  }
  if (project === 'server') {
    return `# Server Project Context

Use this project for broader host administration outside the narrow OpenClaw incident path.

Key scope:
- host health and systemd services
- Docker runtime and container diagnostics
- safe environment inspection
- server setup and maintenance tasks

Important working style:
- stay concise
- prefer direct evidence from the host
- keep OpenClaw-specific assumptions separate unless the user explicitly links the task to OpenClaw
`;
  }
  return `# ${project} Project Context

This project profile was created from Telegram.

Use it as the persistent context bucket for future work related to this project. Add filtered facts, deployment details, pitfalls, and upgrade notes here over time.
`;
}

function defaultProjectRunbook(project) {
  if (project === 'openclaw') {
    return `# OpenClaw Project Runbook

Fast checks:
- docker ps and docker inspect for ${OPENCLAW_CONTAINER}
- verify ports 18789 and 18791 inside the container
- inspect docker logs and /tmp/openclaw/openclaw-YYYY-MM-DD.log
- inspect /hostinger/server.mjs if gateway or approval behavior looks suspicious
`;
  }
  if (project === 'server') {
    return `# Server Project Runbook

Fast checks:
- systemctl status for the relevant service
- docker ps and docker logs when containers are involved
- ss -ltnp for exposed ports
- journalctl -u <service> when systemd is involved
`;
  }
  return `# ${project} Runbook

Add the short operational checklist for this project here.
`;
}

function defaultProjectNotes(project) {
  if (project === 'openclaw') {
    return `# OpenClaw Notes

## Important facts

Known upgrade and maintenance considerations:
- persist fixes into the image/build path, not only the live container filesystem
- re-check /hostinger/server.mjs after every OpenClaw image rebuild or version upgrade
- validate child gateway respawn still works after upgrades
- validate devices approve flow still has single-flight protection, timeout, and cleanup
- watch for Chromium/browser profile lock symptoms and handshake timeouts during restarts
- after upgrades, verify ports 18789 and 18791, recent docker logs, gateway file logs, and process tree stability

## Pending

- user mentioned older upgrade pain points collected elsewhere for /projects-based work
- current live check on 2026-04-19 did not find /projects inside the active container, so those notes were not auto-imported yet
- when the source path is identified later, filter the useful parts into this file

## Done

- Add durable OpenClaw outcomes and decisions here.
`;
  }
  if (project === 'server') {
    return `# Server Notes

## Important facts

Use this file for cross-service operational notes that are broader than OpenClaw.

## Pending

- Add planned but unfinished server work here.

## Done

- Add durable server outcomes and decisions here.
`;
  }
  return `# ${project} Notes

## Important facts

- Add filtered lessons, risks, deployment details, and upgrade notes for this project here.

## Pending

- Add planned but unfinished work here.

## Done

- Add durable outcomes and decisions here.
`;
}

async function ensureFile(file, text) {
  if (!(await fileExists(file))) await fs.writeFile(file, `${text.trim()}\n`, 'utf8');
}

function defaultProjectChangelog(project) {
  return `# ${project} Changelog

Use this file as the chronological memory for completed changes and planned-but-not-done work in this project.

## Unreleased

### Done

- Initial project changelog created.

### Planned

- Add future planned work here when a task is agreed but not completed yet.
`;
}

async function ensureProjectFiles(project) {
  const safe = normalizeProjectName(project);
  if (!safe) throw new Error('Project name is invalid.');
  const paths = projectPaths(safe);
  await fs.mkdir(paths.dir, { recursive: true });
  await ensureFile(paths.context, defaultProjectContext(safe));
  await ensureFile(paths.runbook, defaultProjectRunbook(safe));
  await ensureFile(paths.changelog, defaultProjectChangelog(safe));
  await ensureFile(paths.notes, defaultProjectNotes(safe));
  return paths;
}

async function collectStatus() {
  const script = [
    'set -euo pipefail',
    'echo "HOST $(hostname)"',
    'echo "TIME $(date -Is)"',
    'echo ---',
    `docker ps --format '{{.Names}}\t{{.Status}}' | grep -E '^${OPENCLAW_CONTAINER}\\b' || true`,
    'echo ---',
    `docker inspect -f '{{.State.Status}} restartCount={{.RestartCount}} startedAt={{.State.StartedAt}}' ${OPENCLAW_CONTAINER}`,
    'echo ---',
    `docker exec ${OPENCLAW_CONTAINER} python3 - <<'PY'\nimport socket\nfor port in (18789,18791):\n s=socket.socket(); s.settimeout(1)\n try:\n  s.connect((\'127.0.0.1\', port)); print(f'{port} open')\n except Exception as e:\n  print(f'{port} closed {e}')\n finally:\n  s.close()\nPY`,
    'echo ---',
    `docker exec ${OPENCLAW_CONTAINER} ps -eo pid,ppid,stat,args --forest | sed -n '1,80p'`,
  ].join('\n');
  return sh(script, 120000);
}

async function collectOpenClawDiag(options = {}) {
  const script = [
    'set -euo pipefail',
    'echo "# Host"',
    'hostname',
    'date -Is',
    'echo',
    'echo "# Docker state"',
    `docker ps --format '{{.Names}}\t{{.Image}}\t{{.Status}}' | grep -E '^${OPENCLAW_CONTAINER}\\b' || true`,
    `docker inspect -f '{{json .Config.Cmd}}\n{{.State.Status}} restartCount={{.RestartCount}} startedAt={{.State.StartedAt}} finishedAt={{.State.FinishedAt}}' ${OPENCLAW_CONTAINER}`,
    'echo',
    'echo "# Ports and process tree inside container"',
    `docker exec ${OPENCLAW_CONTAINER} python3 - <<'PY'\nimport subprocess, socket\nprint('PROCESS_TREE')\nprint(subprocess.check_output(['ps','-eo','pid,ppid,stat,args','--forest'], text=True))\nprint('PORTS')\nfor port in (18789,18791):\n s=socket.socket(); s.settimeout(1)\n try:\n  s.connect((\'127.0.0.1\', port)); print(f'{port} open')\n except Exception as e:\n  print(f'{port} closed {e}')\n finally:\n  s.close()\nPY`,
    'echo',
    'echo "# Recent container logs"',
    `docker logs --since 25m ${OPENCLAW_CONTAINER} 2>&1 | tail -n 220`,
    'echo',
    'echo "# Recent gateway file log"',
    `docker exec ${OPENCLAW_CONTAINER} sh -lc 'tail -n 220 /tmp/openclaw/openclaw-$(date +%F).log 2>/dev/null || true'`,
    'echo',
    'echo "# Incident docs on host"',
    `ls -1t ${INCIDENTS_DIR} | head -n 10`,
    `for f in $(ls -1t ${INCIDENTS_DIR} | head -n 2); do echo "--- INCIDENT:$f ---"; sed -n '1,140p' ${INCIDENTS_DIR}/$f; done`,
  ].join('\n');
  return sh(script, 300000, { onChild: options.onChild, killProcessGroup: true });
}

async function runCodex(prompt, options = {}) {
  const outFile = path.join(STATE_DIR, `codex-${nowStamp()}.txt`);
  await fs.mkdir(STATE_DIR, { recursive: true });
  const images = Array.isArray(options.images) ? options.images.map(normalizePendingImage).filter(Boolean) : [];
  const imageArgs = images.flatMap((image) => ['--image', image.path]);
  const chatState = options.chatId == null ? null : await getChatState(options.chatId);
  const selectedModel = normalizeCodexSettingValue(options.model || chatState && chatState.codexModel);
  const selectedReasoning = normalizeCodexSettingValue(options.reasoningEffort || chatState && chatState.codexReasoningEffort);
  const modelArgs = selectedModel ? ['-m', selectedModel] : [];
  const reasoningArgs = selectedReasoning ? ['-c', `reasoning_effort=${quoteTomlString(selectedReasoning)}`] : [];
  const args = options.resumeLast
    ? ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'exec', 'resume', '--last', '--all', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '-o', outFile, ...modelArgs, ...reasoningArgs, ...imageArgs, '-']
    : ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-C', CODEX_CWD, '-o', outFile, ...modelArgs, ...reasoningArgs, ...imageArgs, '-'];
  const progress = createCodexProgressReporter({ chatId: options.chatId });
  const result = await run('env', args, {
    input: prompt,
    timeoutMs: CODEX_EXEC_TIMEOUT_MS > 0 ? CODEX_EXEC_TIMEOUT_MS : null,
    killProcessGroup: true,
    onChild: options.onChild,
    onStderr: (chunk) => progress.pushStderr(chunk),
  });
  progress.stop();
  let finalText = '';
  try {
    finalText = (await fs.readFile(outFile, 'utf8')).trim();
  } catch {}
  if (!finalText) {
    const debugFile = path.join(STATE_DIR, `codex-debug-${nowStamp()}.log`);
    const combined = [result.stderr, result.stdout].filter(Boolean).join('\n');
    const assistantFallback = extractCodexAssistantFallback(result.stderr);
    const debugBody = [
      `time=${new Date().toISOString()}`,
      `code=${result.code}`,
      `signal=${result.signal || ''}`,
      '',
      '--- stderr ---',
      result.stderr || '',
      '',
      '--- stdout ---',
      result.stdout || '',
      '',
    ].join('\n');
    await fs.writeFile(debugFile, debugBody, 'utf8');
    if (result.timedOut) {
      finalText = [
        `Codex run timed out after ${formatDurationMs(CODEX_EXEC_TIMEOUT_MS)}.`,
        'The task may be large. Increase CODEX_EXEC_TIMEOUT_MS or set it to 0 for no timeout.',
        `Full diagnostic dump saved to: ${debugFile}`,
      ].join('\n');
    } else if (looksLikeCodexSubscription403(combined)) {
      finalText = [
        'Codex could not answer: ChatGPT backend returned 403 for native subscription authentication.',
        '',
        'What to do over SSH:',
        '1) sudo /opt/codex-ops/scripts/codex-auth.sh logout',
        '2) sudo /opt/codex-ops/scripts/codex-auth.sh login',
        '3) sudo systemctl restart codex-telegram-bot.service',
        '',
        `Diagnostic dump: ${debugFile}`,
      ].join('\n');
    } else if (result.code === 0 && assistantFallback) {
      finalText = [
        'Codex did not return a formal final block. Sending the last meaningful assistant output from the session:',
        '',
        assistantFallback,
        '',
        `Diagnostic dump: ${debugFile}`,
      ].join('\n');
    } else {
      finalText = [
        'Codex did not return a final answer.',
        `Full diagnostic dump saved to: ${debugFile}`,
        'Raw stdout/stderr is not sent to Telegram to avoid flooding.',
      ].join('\n');
    }
  }
  return finalText;
}

async function initializeOffset() {
  const stored = await loadOffsetState();
  if (stored > 0) {
    offset = stored;
    return;
  }
  let nextOffset = 0;
  while (true) {
    const updates = await tg('getUpdates', { timeout: 0, offset: nextOffset || undefined, limit: 100, allowed_updates: ['message', 'callback_query'] });
    if (!Array.isArray(updates) || updates.length === 0) break;
    nextOffset = updates[updates.length - 1].update_id + 1;
    if (updates.length < 100) break;
  }
  offset = nextOffset;
  await saveOffsetState(offset);
  if (offset > 0) console.warn(`[bot-offset-init] skipped pending updates before startup, offset=${offset}`);
}

async function latestIncident(prefix = '') {
  try {
    const entries = await fs.readdir(INCIDENTS_DIR, { withFileTypes: true });
    const files = entries.filter((e) => e.isFile() && e.name.endsWith('.md')).map((e) => e.name).sort().reverse();
    const scoped = prefix ? files.filter((name) => name.includes(prefix)) : files;
    if (!scoped.length) return null;
    const match = scoped.find((name) => !name.startsWith('diag_')) || scoped[0];
    if (!match) return null;
    const full = path.join(INCIDENTS_DIR, match);
    return { name: match, full, text: await fs.readFile(full, 'utf8') };
  } catch {
    return null;
  }
}

async function readMaybe(file, limit = 20000) {
  try {
    return (await fs.readFile(file, 'utf8')).slice(0, limit);
  } catch {
    return '';
  }
}
function formatHistory(history) {
  const items = Array.isArray(history) ? history.slice(-HISTORY_ITEMS) : [];
  if (!items.length) return '(empty)';
  return items.map((item, index) => `${index + 1}. ${item.role === 'assistant' ? 'Assistant' : 'User'}: ${item.text}`).join('\n\n');
}

async function buildQuestionPrompt(question, options = {}) {
  const chatState = options.chatId == null ? emptyChatState(DEFAULT_PROJECT) : await getChatState(options.chatId);
  const activeProject = normalizeProjectName(options.project || chatState.project) || DEFAULT_PROJECT;
  const paths = projectPaths(activeProject);
  const attachmentsText = formatImageList(options.images || options.attachments || []);
  const opsContext = await readMaybe(OPS_CONTEXT_FILE, 25000);
  const globalRunbook = await readMaybe(RUNBOOK_FILE, 12000);
  const projectContext = await readMaybe(paths.context, 22000);
  const projectRunbook = await readMaybe(paths.runbook, 12000);
  const projectChangelog = await readMaybe(paths.changelog, 16000);
  const projectNotes = await readMaybe(paths.notes, 14000);
  const historyText = options.disableHistory ? '(disabled for this request)' : formatHistory(chatState.history);
  const historical = activeProject === 'openclaw' ? await latestIncident('openclaw') : await latestIncident(activeProject);
  const historicalText = historical ? `${historical.name}\n\n${compactIncidentForPrompt(historical.text)}` : '';
  return [
    'You are the host-level Codex ops assistant for this server.',
    'Primary mission: OpenClaw administration and incident response.',
    'Secondary mission: broader server setup and diagnostics.',
    `Active project for this chat: ${activeProject}.`,
    'Respect the active project first. Only widen scope when the user clearly asks for another system or the evidence requires it.',
    `Active project changelog file: ${paths.changelog}.`,
    'Use the active project CHANGELOG.md as chronological project memory for completed changes and planned-but-not-done work.',
    'Use the active project NOTES.md as durable project memory for facts, pitfalls, pending work, and decisions that should survive beyond recent chat history.',
    'If the user asks to create or update changelog, write to the active project CHANGELOG.md unless the user explicitly gives another path.',
    `Do not create changelog files inside ${INCIDENTS_DIR}.`,
    `Respond in ${ASSISTANT_LANGUAGE}.`,
    'Do the necessary investigation yourself before answering when the question requires checking the server.',
    'Use concise final-answer style only. Do not provide chain-of-thought, hidden reasoning, or long reflective narration.',
    'For long-running tasks, emit short visible progress updates when meaningful milestones happen. These updates are not final answers.',
    'When Telegram image attachments are present, inspect the images passed via codex exec --image and answer using their visual content.',
    'Prefer direct practical answers and mention real uncertainty briefly when needed.',
    'Some project workspaces may live inside the OpenClaw container rather than on the host.',
    '',
    '<ops_context>',
    opsContext,
    '</ops_context>',
    '',
    '<global_runbook>',
    globalRunbook,
    '</global_runbook>',
    '',
    '<project_context>',
    projectContext,
    '</project_context>',
    '',
    '<project_runbook>',
    projectRunbook,
    '</project_runbook>',
    '',
    '<project_changelog>',
    projectChangelog,
    '</project_changelog>',
    '',
    '<project_notes>',
    projectNotes,
    '</project_notes>',
    '',
    '<recent_chat_history>',
    historyText,
    '</recent_chat_history>',
    '',
    '<historical_incident>',
    historicalText,
    '</historical_incident>',
    '',
    '<telegram_image_attachments>',
    attachmentsText,
    '</telegram_image_attachments>',
    '',
    '<user_request>',
    question,
    '</user_request>',
  ].join('\n');
}

async function renderContext(chatId) {
  const chatState = await getChatState(chatId);
  const projects = await listProjects();
  const paths = projectPaths(chatState.project);
  const defaults = await readCodexConfigDefaults();
  const settings = effectiveCodexSettings(chatState, defaults);
  return [
    `Host: ${HOST_LABEL}`,
    `Active project: ${chatState.project}`,
    `Codex model: ${settings.model || '(Codex default)'}${settings.modelOverride ? ' (Telegram override)' : ' (config/default)'}`,
    `Codex reasoning: ${settings.reasoningEffort || '(Codex default)'}${settings.reasoningOverride ? ' (Telegram override)' : ' (config/default)'}`,
    `History items kept: ${chatState.history.length}/${HISTORY_ITEMS}`,
    `Pending images: ${chatState.pendingImages.length}/${PENDING_IMAGE_MAX_ITEMS}`,
    `Project context: ${await fileExists(paths.context) ? paths.context : '(missing)'}`,
    `Project runbook: ${await fileExists(paths.runbook) ? paths.runbook : '(missing)'}`,
    `Project changelog: ${await fileExists(paths.changelog) ? paths.changelog : '(missing)'}`,
    `Project notes: ${await fileExists(paths.notes) ? paths.notes : '(missing)'}`,
    `Known projects: ${projects.join(', ') || '(none)'}`,
  ].join('\n');
}


function buildProjectsKeyboard(projects, activeProject) {
  const rows = projects.map((project) => [{
    text: project === activeProject ? `[active] ${project}` : project,
    callback_data: `project:switch:${project}`,
  }]);
  rows.push([
    { text: 'Context', callback_data: 'project:context' },
    { text: 'Reset session', callback_data: 'project:reset' },
  ]);
  return { inline_keyboard: rows };
}

function callbackData(prefix, value) {
  const data = `${prefix}${value}`;
  return data.length <= 64 ? data : '';
}

function buildCodexSettingsKeyboard(models, state, defaults) {
  const settings = effectiveCodexSettings(state, defaults);
  const rows = [
    [{ text: `Model: ${settings.model || 'Codex default'}`, callback_data: 'codex:models' }],
    [{ text: `Reasoning: ${settings.reasoningEffort || 'Codex default'}`, callback_data: 'codex:reasoning' }],
  ];
  if (settings.modelOverride || settings.reasoningOverride) {
    rows.push([{ text: 'Clear Telegram overrides', callback_data: 'codex:clear' }]);
  }
  const selected = modelBySlug(models, settings.model);
  if (selected && selected.defaultReasoning && !settings.reasoningOverride) {
    rows.push([{ text: `Model default reasoning: ${selected.defaultReasoning}`, callback_data: 'codex:reasoning' }]);
  }
  return { inline_keyboard: rows };
}

function buildModelKeyboard(models, currentModel) {
  const rows = [];
  for (const model of models.slice(0, 30)) {
    const data = callbackData('codex:model:', model.slug);
    if (!data) continue;
    rows.push([{ text: model.slug === currentModel ? `[active] ${model.displayName}` : model.displayName, callback_data: data }]);
  }
  rows.push([{ text: 'Use Codex config/default', callback_data: 'codex:model:default' }]);
  rows.push([{ text: 'Back to settings', callback_data: 'codex:settings' }]);
  return { inline_keyboard: rows };
}

function buildReasoningKeyboard(levels, currentReasoning) {
  const rows = [];
  for (const level of levels) {
    const data = callbackData('codex:reasoning:', level.effort);
    if (!data) continue;
    rows.push([{ text: level.effort === currentReasoning ? `[active] ${level.effort}` : level.effort, callback_data: data }]);
  }
  rows.push([{ text: 'Use Codex/model default', callback_data: 'codex:reasoning:default' }]);
  rows.push([{ text: 'Back to settings', callback_data: 'codex:settings' }]);
  return { inline_keyboard: rows };
}

function formatModelMenu(models, state, defaults) {
  const settings = effectiveCodexSettings(state, defaults);
  const lines = [
    'Codex model menu',
    `Current model: ${settings.model || '(Codex default)'}${settings.modelOverride ? ' (Telegram override)' : ' (config/default)'}`,
    '',
    'Available models from current Codex catalog:',
  ];
  for (const model of models.slice(0, 30)) {
    const defaultReasoning = model.defaultReasoning ? `, default reasoning ${model.defaultReasoning}` : '';
    lines.push(`- ${model.slug}: ${model.description || model.displayName}${defaultReasoning}`);
  }
  if (!models.length) lines.push('(no models returned by codex debug models)');
  return lines.join('\n');
}

function formatReasoningMenu(levels, state, defaults, modelSlug) {
  const settings = effectiveCodexSettings(state, defaults);
  const lines = [
    'Codex reasoning menu',
    `Model for reasoning levels: ${modelSlug || '(unknown)'}`,
    `Current reasoning: ${settings.reasoningEffort || '(Codex default)'}${settings.reasoningOverride ? ' (Telegram override)' : ' (config/default)'}`,
    '',
    'Available reasoning levels from current Codex catalog:',
  ];
  for (const level of levels) lines.push(`- ${level.effort}: ${level.description || '(no description)'}`);
  if (!levels.length) lines.push('(no reasoning levels returned by codex debug models)');
  return lines.join('\n');
}

async function sendCodexSettingsMenu(chatId, promptText = '') {
  const state = await getChatState(chatId);
  const defaults = await readCodexConfigDefaults();
  let models = [];
  let catalogError = '';
  try {
    models = await loadCodexModelCatalog();
  } catch (error) {
    catalogError = error.message || String(error);
  }
  const settings = effectiveCodexSettings(state, defaults);
  const modelKnown = !settings.model || Boolean(modelBySlug(models, settings.model));
  const lines = [
    'Codex settings',
    `Model: ${settings.model || '(Codex default)'}${settings.modelOverride ? ' (Telegram override)' : ' (config/default)'}`,
    `Reasoning: ${settings.reasoningEffort || '(Codex default)'}${settings.reasoningOverride ? ' (Telegram override)' : ' (config/default)'}`,
    `Catalog models: ${models.length || '(unavailable)'}`,
  ];
  if (!modelKnown) lines.push(`Warning: selected model is not in the current Codex catalog: ${settings.model}`);
  if (catalogError) lines.push(`Catalog error: ${clip(catalogError, 600)}`);
  if (promptText) lines.push('', promptText);
  await sendMessage(chatId, lines.join('\n'), { reply_markup: buildCodexSettingsKeyboard(models, state, defaults) });
}

async function sendCodexModelMenu(chatId) {
  const state = await getChatState(chatId);
  const defaults = await readCodexConfigDefaults();
  const models = await loadCodexModelCatalog();
  const settings = effectiveCodexSettings(state, defaults);
  await sendMessage(chatId, formatModelMenu(models, state, defaults), { reply_markup: buildModelKeyboard(models, settings.model) });
}

async function sendCodexReasoningMenu(chatId) {
  const state = await getChatState(chatId);
  const defaults = await readCodexConfigDefaults();
  const models = await loadCodexModelCatalog();
  const settings = effectiveCodexSettings(state, defaults);
  const modelSlug = settings.model || (models[0] && models[0].slug) || '';
  const levels = reasoningLevelsForModel(models, modelSlug);
  await sendMessage(chatId, formatReasoningMenu(levels, state, defaults, modelSlug), { reply_markup: buildReasoningKeyboard(levels, settings.reasoningEffort) });
}

async function setCodexModel(chatId, value) {
  const requested = normalizeCodexSettingValue(value);
  if (!requested || requested === 'default' || requested === 'auto' || requested === 'clear') {
    await updateChatState(chatId, async (current) => ({ ...current, codexModel: '' }));
    await sendCodexSettingsMenu(chatId, 'Model override cleared. Codex config/default will be used.');
    return;
  }
  const models = await loadCodexModelCatalog();
  const selected = modelBySlug(models, requested);
  if (!selected) {
    await sendMessage(chatId, `Model is not in the current Codex catalog: ${requested}\nUse /codex model to see available models.`);
    return;
  }
  let reasoningCleared = false;
  await updateChatState(chatId, async (current) => {
    const levels = reasoningLevelsForModel(models, requested).map((item) => item.effort);
    const currentReasoning = normalizeCodexSettingValue(current.codexReasoningEffort);
    const keepReasoning = !currentReasoning || !levels.length || levels.includes(currentReasoning);
    reasoningCleared = Boolean(currentReasoning && !keepReasoning);
    return { ...current, codexModel: requested, codexReasoningEffort: keepReasoning ? currentReasoning : '' };
  });
  await sendCodexSettingsMenu(chatId, reasoningCleared ? `Model set to ${requested}. Reasoning override was cleared because this model does not support it.` : `Model set to ${requested}.`);
}

async function setCodexReasoning(chatId, value) {
  const requested = normalizeCodexSettingValue(value);
  if (!requested || requested === 'default' || requested === 'auto' || requested === 'clear') {
    await updateChatState(chatId, async (current) => ({ ...current, codexReasoningEffort: '' }));
    await sendCodexSettingsMenu(chatId, 'Reasoning override cleared. Codex config/model default will be used.');
    return;
  }
  const state = await getChatState(chatId);
  const defaults = await readCodexConfigDefaults();
  const models = await loadCodexModelCatalog();
  const settings = effectiveCodexSettings(state, defaults);
  const levels = reasoningLevelsForModel(models, settings.model);
  if (levels.length && !levels.some((level) => level.effort === requested)) {
    await sendMessage(chatId, `Reasoning level is not supported by the current model: ${requested}\nUse /codex reasoning to see available levels.`);
    return;
  }
  await updateChatState(chatId, async (current) => ({ ...current, codexReasoningEffort: requested }));
  await sendCodexSettingsMenu(chatId, `Reasoning override set to ${requested}.`);
}

async function sendProjectsMenu(chatId, promptText = '') {
  const state = await getChatState(chatId);
  const projects = await listProjects();
  const lines = [
    'Projects menu',
    `Active project: ${state.project}`,
    '',
    'Choose a project below or use /project new <name>.',
  ];
  if (promptText) lines.push('', promptText);
  await sendMessage(chatId, lines.join('\n'), { reply_markup: buildProjectsKeyboard(projects, state.project) });
}

async function handleProjectSwitch(chatId, project) {
  const requested = normalizeProjectName(project);
  const projects = await listProjects();
  if (!projects.includes(requested)) throw new Error(`Project ${requested} does not exist.`);
  await ensureProjectFiles(requested);
  await setChatState(chatId, { project: requested, history: [] });
  return requested;
}

async function handleCallback(callbackQuery) {
  const data = String(callbackQuery && callbackQuery.data || '');
  const chatId = callbackQuery && callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;
  const messageId = callbackQuery && callbackQuery.message && callbackQuery.message.message_id;
  if (!chatId || !ALLOWED_CHAT_IDS.has(String(chatId))) {
    await answerCallbackQuery(callbackQuery.id, 'Access denied.');
    return;
  }
  if (data.startsWith('project:switch:')) {
    if (activeTaskForChat(chatId)) {
      await answerCallbackQuery(callbackQuery.id, 'Task is still running');
      await sendMessage(chatId, 'Wait for the active task to finish, or use /codex stop before switching projects.');
      return;
    }
    const active = await handleProjectSwitch(chatId, data.slice('project:switch:'.length));
    const projects = await listProjects();
    await editMessage(chatId, messageId, `Projects menu\nActive project: ${active}\n\nSession history was reset.`, { reply_markup: buildProjectsKeyboard(projects, active) });
    await answerCallbackQuery(callbackQuery.id, `Switched to ${active}`);
    return;
  }
  if (data === 'project:context') {
    const state = await getChatState(chatId);
    await answerCallbackQuery(callbackQuery.id, `Project: ${state.project}`);
    await sendMessage(chatId, await renderContext(chatId));
    return;
  }
  if (data === 'project:reset') {
    if (activeTaskForChat(chatId)) {
      await answerCallbackQuery(callbackQuery.id, 'Task is still running');
      await sendMessage(chatId, 'Wait for the active task to finish, or use /codex stop before resetting the session.');
      return;
    }
    const state = await getChatState(chatId);
    await setChatState(chatId, { project: state.project, history: [] });
    const projects = await listProjects();
    await editMessage(chatId, messageId, `Projects menu\nActive project: ${state.project}\n\nSession history was reset.`, { reply_markup: buildProjectsKeyboard(projects, state.project) });
    await answerCallbackQuery(callbackQuery.id, 'Session reset');
    return;
  }
  if (data === 'codex:settings') {
    await answerCallbackQuery(callbackQuery.id, 'Codex settings');
    await sendCodexSettingsMenu(chatId);
    return;
  }
  if (data === 'codex:models') {
    await answerCallbackQuery(callbackQuery.id, 'Models');
    await sendCodexModelMenu(chatId);
    return;
  }
  if (data === 'codex:reasoning') {
    await answerCallbackQuery(callbackQuery.id, 'Reasoning');
    await sendCodexReasoningMenu(chatId);
    return;
  }
  if (data === 'codex:clear') {
    await updateChatState(chatId, async (current) => ({ ...current, codexModel: '', codexReasoningEffort: '' }));
    await answerCallbackQuery(callbackQuery.id, 'Overrides cleared');
    await sendCodexSettingsMenu(chatId, 'Telegram model and reasoning overrides cleared.');
    return;
  }
  if (data.startsWith('codex:model:')) {
    await answerCallbackQuery(callbackQuery.id, 'Setting model');
    await setCodexModel(chatId, data.slice('codex:model:'.length));
    return;
  }
  if (data.startsWith('codex:reasoning:')) {
    await answerCallbackQuery(callbackQuery.id, 'Setting reasoning');
    await setCodexReasoning(chatId, data.slice('codex:reasoning:'.length));
    return;
  }
  await answerCallbackQuery(callbackQuery.id, 'Unknown action');
}

function buildSteerPrompt(steerText, previousTask) {
  return [
    'Operator steering update from Telegram.',
    `Previous task: ${previousTask ? activeTaskLabel(previousTask) : '(unknown)'}.`,
    'The previous run was interrupted so this instruction could be applied.',
    'Continue the most recent Codex session. Preserve useful completed work, avoid unnecessary redo, and send the final answer only when the task is complete.',
    '',
    '<operator_steer>',
    steerText,
    '</operator_steer>',
  ].join('\n');
}

async function sendBusyMessage(chatId) {
  await sendMessage(chatId, [
    'Another Codex task is already running.',
    '',
    renderActiveTask(),
    '',
    'Use /codex stop to cancel it, or /codex steer <instruction> to interrupt and resume with new guidance.',
  ].join('\n'));
}

async function finishActiveTask(task) {
  const steerText = task && task.steerText ? task.steerText : '';
  if (activeTask && task && activeTask.id === task.id) activeTask = null;
  if (steerText) startSteerCodexRequest(task.chatId, steerText, task);
}

async function handleTaskUnhandledError(task, error) {
  console.error(`[bot-task-error] task=${task && task.id} error=${error && (error.stack || error.message)}`);
  if (activeTask && task && activeTask.id === task.id) activeTask = null;
  if (task && !task.stopRequested) {
    try {
      await sendMessage(task.chatId, `Request failed: ${error.message || String(error)}`);
    } catch {}
  }
}

async function maybeSendStopped(task) {
  if (!task || !task.stopRequested || task.steerText) return;
  await sendMessage(task.chatId, `Stopped ${activeTaskLabel(task)}.`);
}

async function finalizeActiveTask(task) {
  try {
    await maybeSendStopped(task);
  } catch (error) {
    console.warn(`[bot-task-stop-notice-failed] task=${task && task.id} error=${error && (error.stack || error.message)}`);
  }
  await finishActiveTask(task);
}

async function executeUserCodexRequest(task) {
  try {
    const imageLine = task.images.length ? `\nImages: ${task.images.length}` : '';
    await sendMessage(task.chatId, `Working on it...\nProject: ${task.project}${imageLine}`);
    if (task.stopRequested) return;
    const prompt = await buildQuestionPrompt(task.question, { chatId: task.chatId, project: task.project, images: task.images });
    if (task.stopRequested) return;
    task.phase = 'running';
    const answer = await runCodex(prompt, {
      chatId: task.chatId,
      images: task.images,
      onChild: (child) => attachCodexChild(task, child),
    });
    clearActiveTaskChild(task);
    if (task.stopRequested) return;
    task.phase = 'finalizing';
    const historyQuestion = [task.question, imageHistorySuffix(task.images)].filter(Boolean).join('\n');
    await updateChatState(task.chatId, async (current) => appendExchange({ ...current, project: task.project, pendingImages: [] }, historyQuestion, answer));
    await sendMessage(task.chatId, answer);
  } catch (error) {
    if (!task.stopRequested) {
      console.error(`[bot-user-task-error] task=${task.id} error=${error && (error.stack || error.message)}`);
      await sendMessage(task.chatId, `Request failed: ${error.message || String(error)}`);
    }
  } finally {
    clearActiveTaskChild(task);
    await finalizeActiveTask(task);
  }
}

async function executeSteerCodexRequest(task) {
  try {
    await sendMessage(task.chatId, `Continuing the last Codex session with steer instruction...\nProject: ${task.project}`);
    if (task.stopRequested) return;
    task.phase = 'running';
    const answer = await runCodex(task.question, {
      chatId: task.chatId,
      resumeLast: true,
      onChild: (child) => attachCodexChild(task, child),
    });
    clearActiveTaskChild(task);
    if (task.stopRequested) return;
    task.phase = 'finalizing';
    const historyQuestion = `Steer after task #${task.previousTaskId || '?'}:\n${task.steerSource || task.question}`;
    await updateChatState(task.chatId, async (current) => appendExchange({ ...current, project: task.project }, historyQuestion, answer));
    await sendMessage(task.chatId, answer);
  } catch (error) {
    if (!task.stopRequested) {
      console.error(`[bot-steer-task-error] task=${task.id} error=${error && (error.stack || error.message)}`);
      await sendMessage(task.chatId, `Steer resume failed: ${error.message || String(error)}`);
    }
  } finally {
    clearActiveTaskChild(task);
    await finalizeActiveTask(task);
  }
}

function startSteerCodexRequest(chatId, steerText, previousTask) {
  if (activeTask) {
    void sendMessage(chatId, [
      'Could not start steer resume because another task became active.',
      '',
      renderActiveTask(),
    ].join('\n')).catch(() => {});
    return;
  }
  const task = createActiveTask({
    chatId,
    kind: 'steer',
    project: previousTask && previousTask.project || DEFAULT_PROJECT,
    question: buildSteerPrompt(steerText, previousTask),
    resumeLast: true,
    previousTaskId: previousTask && previousTask.id,
  });
  task.steerSource = steerText;
  task.promise = executeSteerCodexRequest(task).catch((error) => handleTaskUnhandledError(task, error));
}

async function runUserCodexRequest(chatId, question, extraImages = []) {
  if (activeTask) {
    await sendBusyMessage(chatId);
    return;
  }
  const state = await getChatState(chatId);
  const images = [...state.pendingImages, ...extraImages.map(normalizePendingImage).filter(Boolean)].slice(-PENDING_IMAGE_MAX_ITEMS);
  const task = createActiveTask({ chatId, kind: 'request', project: state.project, question, images });
  task.promise = executeUserCodexRequest(task).catch((error) => handleTaskUnhandledError(task, error));
}

async function executeOpenClawDiagTask(task) {
  try {
    await sendMessage(task.chatId, 'Collecting OpenClaw diagnostics and sending context to Codex...');
    if (task.stopRequested) return;
    task.phase = 'collecting';
    const collected = await collectOpenClawDiag({ onChild: (child) => setActiveTaskChild(task, child) });
    clearActiveTaskChild(task);
    if (task.stopRequested) return;
    const context = [collected.stdout, collected.stderr].filter(Boolean).join('\n\n').trim();
    const prompt = [
      await buildQuestionPrompt('Diagnose current OpenClaw state on this server. Give: 1) current state 2) likely root cause 3) strongest evidence 4) what to check next 5) whether service is currently up. Do not propose changes unless the evidence strongly supports them.', { chatId: task.chatId, project: 'openclaw', disableHistory: true }),
      '',
      '<runtime_context>',
      context,
      '</runtime_context>',
    ].join('\n');
    if (task.stopRequested) return;
    task.phase = 'running';
    const answer = await runCodex(prompt, {
      chatId: task.chatId,
      onChild: (child) => attachCodexChild(task, child),
    });
    clearActiveTaskChild(task);
    if (task.stopRequested) return;
    task.phase = 'finalizing';
    const file = path.join(INCIDENTS_DIR, `diag_openclaw_${nowStamp()}.md`);
    const doc = ['# OpenClaw diagnostic run', '', `Time: ${new Date().toISOString()}`, '', '## Codex analysis', '', answer, '', '## Raw context', '', '```text', context.slice(0, 120000), '```', ''].join('\n');
    await fs.writeFile(file, doc, 'utf8');
    await sendMessage(task.chatId, answer);
    await sendMessage(task.chatId, `Saved diagnostic note: ${path.basename(file)}`);
  } catch (error) {
    if (!task.stopRequested) {
      console.error(`[bot-diag-task-error] task=${task.id} error=${error && (error.stack || error.message)}`);
      await sendMessage(task.chatId, `Diagnostic run failed: ${error.message || String(error)}`);
    }
  } finally {
    clearActiveTaskChild(task);
    await finalizeActiveTask(task);
  }
}

async function runOpenClawDiagRequest(chatId) {
  if (activeTask) {
    await sendBusyMessage(chatId);
    return;
  }
  const task = createActiveTask({
    chatId,
    kind: 'diag',
    project: 'openclaw',
    question: 'Diagnose current OpenClaw state on this server.',
  });
  task.promise = executeOpenClawDiagTask(task).catch((error) => handleTaskUnhandledError(task, error));
}

async function stopActiveTask(chatId) {
  const task = activeTask;
  if (!task) {
    await sendMessage(chatId, 'No active Codex task.');
    return;
  }
  if (task.phase === 'finalizing') {
    await sendMessage(chatId, `Codex has already finished ${activeTaskLabel(task)}. The final Telegram message is being delivered.`);
    return;
  }
  if (task.stopRequested && !task.steerText) {
    await sendMessage(chatId, `Stop is already requested for ${activeTaskLabel(task)}.`);
    return;
  }
  task.stopRequested = true;
  task.stopReason = 'operator-stop';
  task.steerText = '';
  const signaled = terminateTaskProcess(task);
  await sendMessage(chatId, [
    `Emergency stop requested for ${activeTaskLabel(task)}.`,
    signaled ? 'Sent SIGTERM to the active Codex process.' : 'The Codex process is not running yet or already exited; the task will stop before sending a final answer.',
  ].join('\n'));
}

async function steerActiveTask(chatId, steerText) {
  const instruction = String(steerText || '').trim();
  if (!instruction) {
    await sendMessage(chatId, 'Usage: /codex steer <instruction>');
    return;
  }
  const task = activeTask;
  if (!task) {
    await sendMessage(chatId, 'No active Codex task to steer. Start a request first, then use /codex steer <instruction> while it is running.');
    return;
  }
  if (task.phase === 'finalizing') {
    await sendMessage(chatId, `Codex has already finished ${activeTaskLabel(task)}. Send a new message if you want a follow-up.`);
    return;
  }
  if (!task.codexSessionStarted) {
    await sendMessage(chatId, [
      `Cannot steer ${activeTaskLabel(task)} yet because Codex has not started its session.`,
      'Use /codex stop to cancel it, or send /codex steer again after the task reaches the running phase.',
    ].join('\n'));
    return;
  }
  task.stopRequested = true;
  task.stopReason = 'operator-steer';
  task.steerText = instruction;
  const signaled = terminateTaskProcess(task);
  await sendMessage(chatId, [
    `Steer instruction received for ${activeTaskLabel(task)}.`,
    signaled ? 'Stopping the current Codex process now.' : 'The current process is not running yet or already exited.',
    'Next step: I will resume the latest Codex session with your steering instruction.',
  ].join('\n'));
}

async function handleImageMessage(chatId, msg, text, attachment) {
  if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
    await sendMessage(chatId, 'Access denied.');
    return;
  }
  if (attachment && attachment.unsupported) {
    await sendMessage(chatId, [
      'This file type is not supported yet.',
      `Received: ${attachment.originalName} (${attachment.mimeType || 'unknown type'}, ${attachment.fileSize ? formatBytes(attachment.fileSize) : 'size unknown'})`,
      'Send a Telegram photo or an image document instead.',
    ].join('\n'));
    return;
  }
  if (activeTask) {
    await sendMessage(chatId, [
      'Another Codex task is already running. Please send the image again when it finishes.',
      '',
      renderActiveTask(),
    ].join('\n'));
    return;
  }

  let image = null;
  try {
    image = await downloadTelegramImage(attachment, msg);
  } catch (error) {
    await sendMessage(chatId, `Could not download image: ${error.message}`);
    return;
  }

  const rawQuestion = String(text || '').trim();
  const question = rawQuestion.startsWith('/ask ') ? rawQuestion.slice(5).trim() : rawQuestion;
  if (!question) {
    const pending = await addPendingImages(chatId, [image]);
    await sendMessage(chatId, [
      'Image received and saved for the next question.',
      `Stored images: ${pending.length}/${PENDING_IMAGE_MAX_ITEMS}.`,
      PENDING_IMAGE_TTL_MS > 0 ? `Expires after: ${formatDurationMs(PENDING_IMAGE_TTL_MS)}.` : 'Image expiration is disabled.',
      'Send a text question now, or send another image to attach more.',
    ].join('\n'));
    return;
  }

  await runUserCodexRequest(chatId, question, [image]);
}

async function handleMessage(msg) {
  const chatId = msg && msg.chat && msg.chat.id;
  if (!chatId) return;
  if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
    await sendMessage(chatId, 'Access denied.');
    return;
  }
  const attachment = selectTelegramImageAttachment(msg);
  if (attachment) {
    await handleImageMessage(chatId, msg, msg.caption || '', attachment);
    return;
  }
  if (msg.document) {
    await sendMessage(chatId, 'This file type is not supported yet. Send a Telegram photo or an image document.');
    return;
  }
  await handle(chatId, msg.text || '');
}

async function handle(chatId, text) {
  const trimmed = normalizeTelegramText(text);
  if (!trimmed) return;
  if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
    await sendMessage(chatId, 'Access denied.');
    return;
  }
  if (trimmed === '/start' || trimmed === '/help') {
    await sendMessage(chatId, [
      `codex-ops on ${HOST_LABEL}`,
      'Regular text messages are treated as direct questions to Codex.',
      'Telegram photos and image documents can be sent with a caption, or saved for the next text question.',
      'Commands:',
      '/ask <question>',
      '/status',
      '/diag openclaw',
      '/lastincident openclaw',
      '/runbook openclaw',
      '/projects',
      '/project <name>',
      '/project new <name>',
      '/context show',
      '/session reset',
      '/codex task',
      '/codex stop',
      '/codex steer <instruction>',
      '/codex settings',
      '/codex model',
      '/codex model <slug|default>',
      '/codex reasoning',
      '/codex reasoning <effort|default>',
      '/codex login',
      '/codex login status',
      '/codex login cancel',
    ].join('\n'));
    return;
  }
  if (trimmed === '/codex' || trimmed === '/codex settings') {
    await sendCodexSettingsMenu(chatId);
    return;
  }
  if (trimmed === '/codex task' || trimmed === '/task') {
    await sendMessage(chatId, renderActiveTask());
    return;
  }
  if (trimmed === '/codex stop' || trimmed === '/codex cancel' || trimmed === '/stop' || trimmed === '/cancel') {
    await stopActiveTask(chatId);
    return;
  }
  if (trimmed === '/codex steer' || trimmed === '/steer') {
    await sendMessage(chatId, 'Usage: /codex steer <instruction>');
    return;
  }
  if (trimmed.startsWith('/codex steer ')) {
    await steerActiveTask(chatId, trimmed.slice('/codex steer '.length));
    return;
  }
  if (trimmed.startsWith('/steer ')) {
    await steerActiveTask(chatId, trimmed.slice('/steer '.length));
    return;
  }
  if (trimmed === '/codex model' || trimmed === '/codex models') {
    await sendCodexModelMenu(chatId);
    return;
  }
  if (trimmed.startsWith('/codex model ')) {
    await setCodexModel(chatId, trimmed.slice('/codex model '.length));
    return;
  }
  if (trimmed === '/codex reasoning' || trimmed === '/codex effort') {
    await sendCodexReasoningMenu(chatId);
    return;
  }
  if (trimmed.startsWith('/codex reasoning ')) {
    await setCodexReasoning(chatId, trimmed.slice('/codex reasoning '.length));
    return;
  }
  if (trimmed.startsWith('/codex effort ')) {
    await setCodexReasoning(chatId, trimmed.slice('/codex effort '.length));
    return;
  }
  if (trimmed === '/codex login status') {
    const status = await codexLoginStatus();
    const body = (status.stdout || status.stderr || '').trim() || '(no output)';
    await sendMessage(chatId, `Codex login status:\n${body}`);
    return;
  }
  if (trimmed === '/codex login') {
    await startDeviceAuthFlow(chatId);
    return;
  }
  if (trimmed === '/codex login cancel') {
    await cancelDeviceAuthFlow(chatId);
    return;
  }
  if (trimmed === '/projects') {
    await sendProjectsMenu(chatId);
    return;
  }
  if (trimmed === '/context show') {
    await sendMessage(chatId, await renderContext(chatId));
    return;
  }
  if (trimmed === '/session reset') {
    if (activeTaskForChat(chatId)) {
      await sendMessage(chatId, 'Wait for the active task to finish, or use /codex stop before resetting the session.');
      return;
    }
    const state = await getChatState(chatId);
    await setChatState(chatId, { project: state.project, history: [] });
    await sendMessage(chatId, `Session history cleared. Active project remains ${state.project}.`);
    return;
  }
  if (trimmed.startsWith('/project')) {
    const arg = trimmed.replace(/^\/project\s*/, '');
    const current = await getChatState(chatId);
    if (!arg || arg === '/project') {
      await sendMessage(chatId, `Current project: ${current.project}\nUsage: /project <name> or /project new <name>`);
      return;
    }
    if (activeTaskForChat(chatId)) {
      await sendMessage(chatId, 'Wait for the active task to finish, or use /codex stop before switching projects.');
      return;
    }
    if (arg.startsWith('new ')) {
      const requested = normalizeProjectName(arg.slice(4));
      if (!requested) {
        await sendMessage(chatId, 'Project name is invalid. Use letters, numbers, dot, dash, or underscore.');
        return;
      }
      await ensureProjectFiles(requested);
      await setChatState(chatId, { project: requested, history: [] });
      await sendMessage(chatId, `Created and switched to project ${requested}. Session history was reset.`);
      await sendProjectsMenu(chatId, 'Projects menu updated.');
      return;
    }
    const requested = normalizeProjectName(arg);
    const projects = await listProjects();
    if (!projects.includes(requested)) {
      await sendMessage(chatId, `Project ${requested} does not exist. Use /project new ${requested} to create it.`);
      return;
    }
    const active = await handleProjectSwitch(chatId, requested);
    await sendMessage(chatId, `Switched to project ${active}. Session history was reset.`);
    await sendProjectsMenu(chatId, 'Projects menu updated.');
    return;
  }
  if (trimmed === '/status') {
    const state = await getChatState(chatId);
    const result = await collectStatus();
    const body = [`Active project: ${state.project}`, '', 'OpenClaw status:', result.stdout.trim() || '(no output)'];
    if (result.code !== 0 && result.stderr.trim()) body.push(`stderr:\n${result.stderr.trim()}`);
    await sendMessage(chatId, body.join('\n\n'));
    return;
  }
  if (trimmed.startsWith('/lastincident')) {
    const item = await latestIncident('openclaw');
    if (!item) {
      await sendMessage(chatId, 'No incident docs found.');
      return;
    }
    await sendMessage(chatId, `Latest incident: ${item.name}\n\n${item.text.slice(0, 3000)}`);
    return;
  }
  if (trimmed.startsWith('/runbook')) {
    const runbook = (await readMaybe(projectPaths('openclaw').runbook, 12000)) || (await readMaybe(RUNBOOK_FILE, 12000));
    if (!runbook) {
      await sendMessage(chatId, 'No runbook found.');
      return;
    }
    await sendMessage(chatId, runbook.slice(0, 3000));
    return;
  }
  if (trimmed === '/diag openclaw') {
    await runOpenClawDiagRequest(chatId);
    return;
  }
  if (trimmed.startsWith('/ask ')) {
    const question = trimmed.slice(5).trim();
    if (!question) {
      await sendMessage(chatId, 'Usage: /ask <question>');
      return;
    }
    await runUserCodexRequest(chatId, question);
    return;
  }
  if (trimmed.startsWith('/')) {
    await sendMessage(chatId, 'Unknown command. Use /help');
    return;
  }
  await runUserCodexRequest(chatId, trimmed);
}

async function poll() {
  while (true) {
    try {
      const updates = await tg('getUpdates', { timeout: 50, offset, allowed_updates: ['message', 'callback_query'] });
      for (const update of updates) {
        offset = update.update_id + 1;
        await saveOffsetState(offset);
        if (update.callback_query) {
          try {
            await handleCallback(update.callback_query);
          } catch (error) {
            const callback = update.callback_query;
            const chatId = callback && callback.message && callback.message.chat && callback.message.chat.id;
            console.error(`[bot-callback-error] chat=${chatId} data=${JSON.stringify(callback && callback.data || '')} error=${error && (error.stack || error.message)}`);
            try {
              await answerCallbackQuery(callback.id, 'Request failed');
            } catch {}
            if (chatId) {
              try {
                await sendMessage(chatId, `Request failed: ${error.message}`);
              } catch {}
            }
          }
          continue;
        }
        const msg = update.message;
        if (!msg || !msg.chat) continue;
        try {
          await handleMessage(msg);
        } catch (error) {
          const incomingText = msg.text || msg.caption || '';
          console.error(`[bot-error] chat=${msg.chat.id} text=${JSON.stringify(incomingText.slice(0, 300))} error=${error && (error.stack || error.message)}`);
          try {
            await sendMessage(msg.chat.id, `Request failed: ${error.message}`);
          } catch {}
        }
      }
    } catch {
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function main() {
  if (!BOT_TOKEN) throw new Error('TELEGRAM_BOT_TOKEN is not set');
  await fs.mkdir(STATE_DIR, { recursive: true });
  await fs.mkdir(UPLOADS_DIR, { recursive: true });
  await fs.mkdir(PROJECTS_DIR, { recursive: true });
  await ensureProjectFiles('openclaw');
  await ensureProjectFiles('server');
  await initializeOffset();
  await poll();
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
