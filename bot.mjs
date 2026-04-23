#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const ALLOWED_CHAT_IDS = new Set((process.env.ALLOWED_CHAT_IDS || '').split(',').map((s) => s.trim()).filter(Boolean));
const INCIDENTS_DIR = process.env.INCIDENTS_DIR || '/srv/codex-ops/incidents';
const STATE_DIR = process.env.STATE_DIR || '/var/lib/codexops/state';
const CHAT_STATE_FILE = process.env.CHAT_STATE_FILE || path.join(STATE_DIR, 'chat-state.json');
const OFFSET_STATE_FILE = process.env.OFFSET_STATE_FILE || path.join(STATE_DIR, 'telegram-offset.txt');
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
const OUTBOUND_DELAY_MS = Math.max(0, Number(process.env.OUTBOUND_DELAY_MS || '250') || 250);
const TG_RETRY_ATTEMPTS = Math.max(1, Number(process.env.TG_RETRY_ATTEMPTS || '3') || 3);
const TG_RETRY_FALLBACK_DELAY_MS = Math.max(500, Number(process.env.TG_RETRY_FALLBACK_DELAY_MS || '2000') || 2000);
const TG_RETRY_MAX_WAIT_MS = Math.max(1000, Number(process.env.TG_RETRY_MAX_WAIT_MS || '120000') || 120000);
const HISTORICAL_INCIDENT_LIMIT = Math.max(1000, Number(process.env.HISTORICAL_INCIDENT_LIMIT || '4000') || 4000);
const CODEX_DEVICE_AUTH_TIMEOUT_MS = Math.max(120000, Number(process.env.CODEX_DEVICE_AUTH_TIMEOUT_MS || '900000') || 900000);
let offset = 0;
let busy = false;
let authFlow = null;

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function clip(text, limit = 1200) {
  const value = String(text || '').trim();
  if (value.length <= limit) return value;
  return `${value.slice(0, limit - 3)}...`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeMarkdownForTelegram(text) {
  let value = String(text || '').replace(/\r\n/g, '\n');
  // Fenced code blocks: keep code, drop fences/lang marker.
  value = value.replace(/```[a-zA-Z0-9_.+-]*\n([\s\S]*?)```/g, (_, code) => `\n${String(code || '').replace(/\n$/, '')}\n`);
  // Inline code.
  value = value.replace(/`([^`\n]+)`/g, '$1');
  // Markdown links -> "label (url)".
  value = value.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, '$1 ($2)');
  // Common style markers.
  value = value.replace(/(\*\*|__)(.*?)\1/g, '$2');
  value = value.replace(/~~(.*?)~~/g, '$1');
  value = value.replace(/(^|[^\*])\*([^\*\n]+)\*(?=[^\*]|$)/g, '$1$2');
  value = value.replace(/(^|[^_])_([^_\n]+)_(?=[^_]|$)/g, '$1$2');
  // Headings and blockquotes.
  value = value.replace(/^#{1,6}\s+/gm, '');
  value = value.replace(/^>\s?/gm, '');
  return value;
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
  const value = normalizeMarkdownForTelegram(String(text || '').trim() || '(empty response)');
  const chunks = [];
  for (let i = 0; i < value.length; i += MAX_MESSAGE) chunks.push(value.slice(i, i + MAX_MESSAGE));
  if (chunks.length === 0) chunks.push(value);
  let outbound = chunks;
  if (chunks.length > MAX_MESSAGE_CHUNKS) {
    const kept = chunks.slice(0, MAX_MESSAGE_CHUNKS - 1);
    const omitted = chunks.length - kept.length;
    kept.push(`Reply truncated to avoid Telegram flood.\nSent chunks: ${kept.length}/${chunks.length}.\nFull body was not delivered to chat.`);
    outbound = kept;
    console.warn(`[bot-send-truncated] chat=${chatId} chunks=${chunks.length} omitted=${omitted}`);
  }
  for (let i = 0; i < outbound.length; i += 1) {
    const chunk = outbound[i];
    await tgSendMessageWithRetry({ chat_id: chatId, text: chunk, disable_web_page_preview: true, ...extra }, { chatId });
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

function extractCodexAssistantFallback(stderrText, limit = 2800) {
  const clean = stripAnsi(stderrText || '');
  const re = /(?:^|\n)codex\n([\s\S]*?)(?=\n(?:exec|tokens used|user)\n|$)/g;
  let match;
  let last = '';
  while ((match = re.exec(clean)) !== null) {
    const candidate = String(match[1] || '').trim();
    if (candidate) last = candidate;
  }
  if (!last) return '';
  return clip(last, limit);
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

function run(command, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], ...opts });
    let stdout = '';
    let stderr = '';
    const timeoutMs = opts.timeoutMs || 120000;
    const timer = setTimeout(() => child.kill('SIGTERM'), timeoutMs);
    if (opts.input) child.stdin.end(opts.input); else child.stdin.end();
    child.stdout.on('data', (d) => { stdout += d.toString(); });
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
    child.on('error', (error) => {
      clearTimeout(timer);
      resolve({ code: 1, signal: null, stdout, stderr: `${stderr}\n${error.stack || error.message}`.trim() });
    });
  });
}

async function sh(script, timeoutMs = 120000) {
  return run('bash', ['-lc', script], { timeoutMs });
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
  return { project, history };
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

function projectPaths(project) {
  const safe = normalizeProjectName(project) || DEFAULT_PROJECT;
  const dir = path.join(PROJECTS_DIR, safe);
  return { dir, context: path.join(dir, 'CONTEXT.md'), runbook: path.join(dir, 'RUNBOOK.md'), notes: path.join(dir, 'NOTES.md') };
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

Known upgrade and maintenance considerations:
- persist fixes into the image/build path, not only the live container filesystem
- re-check /hostinger/server.mjs after every OpenClaw image rebuild or version upgrade
- validate child gateway respawn still works after upgrades
- validate devices approve flow still has single-flight protection, timeout, and cleanup
- watch for Chromium/browser profile lock symptoms and handshake timeouts during restarts
- after upgrades, verify ports 18789 and 18791, recent docker logs, gateway file logs, and process tree stability

Pending context merge:
- user mentioned older upgrade pain points collected elsewhere for /projects-based work
- current live check on 2026-04-19 did not find /projects inside the active container, so those notes were not auto-imported yet
- when the source path is identified later, filter the useful parts into this file
`;
  }
  if (project === 'server') {
    return `# Server Notes

Use this file for cross-service operational notes that are broader than OpenClaw.
`;
  }
  return `# ${project} Notes

Add filtered lessons, risks, and upgrade notes for this project here.
`;
}

async function ensureFile(file, text) {
  if (!(await fileExists(file))) await fs.writeFile(file, `${text.trim()}\n`, 'utf8');
}

async function ensureProjectFiles(project) {
  const safe = normalizeProjectName(project);
  if (!safe) throw new Error('Project name is invalid.');
  const paths = projectPaths(safe);
  await fs.mkdir(paths.dir, { recursive: true });
  await ensureFile(paths.context, defaultProjectContext(safe));
  await ensureFile(paths.runbook, defaultProjectRunbook(safe));
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

async function collectOpenClawDiag() {
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
  return sh(script, 300000);
}

async function runCodex(prompt) {
  const outFile = path.join(STATE_DIR, `codex-${nowStamp()}.txt`);
  await fs.mkdir(STATE_DIR, { recursive: true });
  const args = ['HOME=/var/lib/codexops', `CODEX_HOME=${CODEX_HOME}`, 'codex', 'exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--color', 'never', '-C', CODEX_CWD, '-o', outFile, '-'];
  const result = await run('env', args, { input: prompt, timeoutMs: 600000 });
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
    if (looksLikeCodexSubscription403(combined)) {
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
  const opsContext = await readMaybe(OPS_CONTEXT_FILE, 25000);
  const globalRunbook = await readMaybe(RUNBOOK_FILE, 12000);
  const projectContext = await readMaybe(paths.context, 22000);
  const projectRunbook = await readMaybe(paths.runbook, 12000);
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
    `Respond in ${ASSISTANT_LANGUAGE}.`,
    'Do the necessary investigation yourself before answering when the question requires checking the server.',
    'Use concise final-answer style only. Do not provide chain-of-thought, hidden reasoning, or long reflective narration.',
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
    '<user_request>',
    question,
    '</user_request>',
  ].join('\n');
}

async function renderContext(chatId) {
  const chatState = await getChatState(chatId);
  const projects = await listProjects();
  const paths = projectPaths(chatState.project);
  return [
    `Host: ${HOST_LABEL}`,
    `Active project: ${chatState.project}`,
    `History items kept: ${chatState.history.length}/${HISTORY_ITEMS}`,
    `Project context: ${await fileExists(paths.context) ? paths.context : '(missing)'}`,
    `Project runbook: ${await fileExists(paths.runbook) ? paths.runbook : '(missing)'}`,
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
    const state = await getChatState(chatId);
    await setChatState(chatId, { project: state.project, history: [] });
    const projects = await listProjects();
    await editMessage(chatId, messageId, `Projects menu\nActive project: ${state.project}\n\nSession history was reset.`, { reply_markup: buildProjectsKeyboard(projects, state.project) });
    await answerCallbackQuery(callbackQuery.id, 'Session reset');
    return;
  }
  await answerCallbackQuery(callbackQuery.id, 'Unknown action');
}

async function handle(chatId, text) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  if (!ALLOWED_CHAT_IDS.has(String(chatId))) {
    await sendMessage(chatId, 'Access denied.');
    return;
  }
  if (trimmed === '/start' || trimmed === '/help') {
    await sendMessage(chatId, [
      `codex-ops on ${HOST_LABEL}`,
      'Regular text messages are treated as direct questions to Codex.',
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
      '/codex login',
      '/codex login status',
      '/codex login cancel',
    ].join('\n'));
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
    if (busy) {
      await sendMessage(chatId, 'Another diagnostic run is already in progress.');
      return;
    }
    busy = true;
    try {
      await sendMessage(chatId, 'Collecting OpenClaw diagnostics and sending context to Codex...');
      const collected = await collectOpenClawDiag();
      const context = [collected.stdout, collected.stderr].filter(Boolean).join('\n\n').trim();
      const prompt = [
        await buildQuestionPrompt('Diagnose current OpenClaw state on this server. Give: 1) current state 2) likely root cause 3) strongest evidence 4) what to check next 5) whether service is currently up. Do not propose changes unless the evidence strongly supports them.', { chatId, project: 'openclaw', disableHistory: true }),
        '',
        '<runtime_context>',
        context,
        '</runtime_context>',
      ].join('\n');
      const answer = await runCodex(prompt);
      const file = path.join(INCIDENTS_DIR, `diag_openclaw_${nowStamp()}.md`);
      const doc = ['# OpenClaw diagnostic run', '', `Time: ${new Date().toISOString()}`, '', '## Codex analysis', '', answer, '', '## Raw context', '', '```text', context.slice(0, 120000), '```', ''].join('\n');
      await fs.writeFile(file, doc, 'utf8');
      await sendMessage(chatId, answer);
      await sendMessage(chatId, `Saved diagnostic note: ${path.basename(file)}`);
    } finally {
      busy = false;
    }
    return;
  }
  if (trimmed.startsWith('/ask ')) {
    const question = trimmed.slice(5).trim();
    if (!question) {
      await sendMessage(chatId, 'Usage: /ask <question>');
      return;
    }
    if (busy) {
      await sendMessage(chatId, 'Another request is already in progress.');
      return;
    }
    busy = true;
    try {
      const state = await getChatState(chatId);
      await sendMessage(chatId, `Working on it...\nProject: ${state.project}`);
      const answer = await runCodex(await buildQuestionPrompt(question, { chatId }));
      await updateChatState(chatId, async (current) => appendExchange(current, question, answer));
      await sendMessage(chatId, answer);
    } finally {
      busy = false;
    }
    return;
  }
  if (trimmed.startsWith('/')) {
    await sendMessage(chatId, 'Unknown command. Use /help');
    return;
  }
  if (busy) {
    await sendMessage(chatId, 'Another request is already in progress.');
    return;
  }
  busy = true;
  try {
    const state = await getChatState(chatId);
    await sendMessage(chatId, `Working on it...\nProject: ${state.project}`);
    const answer = await runCodex(await buildQuestionPrompt(trimmed, { chatId }));
    await updateChatState(chatId, async (current) => appendExchange(current, trimmed, answer));
    await sendMessage(chatId, answer);
  } finally {
    busy = false;
  }
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
          await handle(msg.chat.id, msg.text || '');
        } catch (error) {
          console.error(`[bot-error] chat=${msg.chat.id} text=${JSON.stringify((msg.text || '').slice(0, 300))} error=${error && (error.stack || error.message)}`);
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
