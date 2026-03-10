import { randomUUID } from 'crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { homedir, tmpdir } from 'os';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

import { executeCommandDetailed } from './commandExecutor.js';
import { withFileLockSync } from './fileLock.js';

export interface TmuxCodexExecOptions {
  threadId?: string;
  model?: string;
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access';
  cwd?: string;
  profile?: string;
  config?: Record<string, unknown>;
}

export interface TmuxCodexExecutionResult {
  content: string;
  threadId?: string;
}

interface ThreadBinding {
  paneId: string;
  updatedAt: string;
}

type ThreadMap = Record<string, ThreadBinding>;

interface WorkerRequest {
  requestId: string;
  prompt: string;
  threadId?: string;
  model?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  cwd?: string;
  profile?: string;
  config?: Record<string, unknown>;
}

interface WorkerResponse {
  ok: boolean;
  content?: string;
  threadId?: string;
  error?: string;
}

const TMUX_SESSION = process.env.CODEX_MCP_TMUX_SESSION || 'codex-mcp-threads';
function resolveStateRoot(): string {
  const configuredRoot = process.env.CODEX_MCP_STATE_DIR;
  const preferredRoot = configuredRoot || join(homedir(), '.codex-mcp-server');
  const fallbackRoot = join(tmpdir(), 'codex-mcp-server');
  const probeName = '.codex-mcp-write-probe';

  const canWriteRoot = (root: string): boolean => {
    try {
      mkdirSync(root, { recursive: true });
      const probePath = join(root, probeName);
      writeFileSync(probePath, 'ok', 'utf8');
      unlinkSync(probePath);
      return true;
    } catch {
      return false;
    }
  };

  if (canWriteRoot(preferredRoot)) {
    return preferredRoot;
  }

  mkdirSync(fallbackRoot, { recursive: true });
  return fallbackRoot;
}

const STATE_ROOT = resolveStateRoot();
const STATE_DIR = join(STATE_ROOT, 'tmux-bridge');
const PANES_DIR = join(STATE_DIR, 'panes');
const THREAD_MAP_FILE = join(STATE_DIR, 'thread-map.json');
const THREAD_MAP_LOCK_DIR = join(STATE_DIR, 'thread-map.lock');
const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(MODULE_DIR, '..', '..');
const WORKER_DIR = join(PROJECT_ROOT, '.codex-mcp-tmp');
const WORKER_SCRIPT_PATH = join(WORKER_DIR, 'codex-pane-worker.mjs');

let tmuxAvailable: boolean | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function paneKey(paneId: string): string {
  return paneId.replace('%', 'pane_');
}

function paneDir(paneId: string): string {
  return join(PANES_DIR, paneKey(paneId));
}

function ensureDirs(): void {
  mkdirSync(STATE_DIR, { recursive: true });
  mkdirSync(PANES_DIR, { recursive: true });
  mkdirSync(WORKER_DIR, { recursive: true });
}

function loadThreadMap(): ThreadMap {
  if (!existsSync(THREAD_MAP_FILE)) return {};
  try {
    const raw = readFileSync(THREAD_MAP_FILE, 'utf8');
    const parsed = JSON.parse(raw) as ThreadMap;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveThreadMap(map: ThreadMap): void {
  const tmpPath = `${THREAD_MAP_FILE}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(map, null, 2), 'utf8');
  renameSync(tmpPath, THREAD_MAP_FILE);
}

function setThreadBinding(threadId: string, paneId: string): void {
  withFileLockSync(THREAD_MAP_LOCK_DIR, () => {
    const map = loadThreadMap();
    map[threadId] = { paneId, updatedAt: nowIso() };
    saveThreadMap(map);
  });
}

function getThreadBinding(threadId: string): ThreadBinding | undefined {
  const map = loadThreadMap();
  return map[threadId];
}

function buildWorkerScript(): string {
  return `
import { readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { LoggingMessageNotificationSchema } from '@modelcontextprotocol/sdk/types.js';

function paneKey(paneId) {
  return paneId.replace('%', 'pane_');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TOOL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CODEX_MCP_INTERNAL_TOOL_TIMEOUT_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
})();

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\\n').trim();
}

function compactObservableText(input, maxLen = 500) {
  if (typeof input !== 'string' || !input.trim()) return '';
  let text = input.replace(/\\r\\n/g, '\\n').trim();
  const fence = String.fromCharCode(96).repeat(3);
  text = text.replace(new RegExp(fence + 'diff([\\\\s\\\\S]*?)' + fence, 'gi'), (_m, body) => {
    const lines = String(body || '').split('\\n').filter(Boolean).length;
    return '[diff block omitted: ' + lines + ' lines]';
  });
  text = text.replace(new RegExp('\\\\*\\\\*\\\\* Begin Patch([\\\\s\\\\S]*?)\\\\*\\\\*\\\\* End Patch', 'gi'), (_m, body) => {
    const lines = String(body || '').split('\\n').filter(Boolean).length;
    return '[patch omitted: ' + lines + ' lines]';
  });
  text = text.replace(/\\n{3,}/g, '\\n\\n');
  if (text.length > maxLen) {
    text = text.slice(0, maxLen) + '...';
  }
  return text;
}

let activeProgressFile = null;

async function appendProgress(filePath, message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\\n';
  await writeFile(filePath, line, { encoding: 'utf8', flag: 'a' });
}

async function handleRequest(client, codexToolName, replyToolName, req, progressFile) {
  const useReply = !!req.threadId;
  const args = { prompt: req.prompt };
  let toolName = codexToolName;

  if (useReply) {
    if (!replyToolName) {
      throw new Error('codex-reply tool unavailable in codex mcp-server');
    }
    args.threadId = req.threadId;
    toolName = replyToolName;
  } else {
    args.sandbox = req.sandbox || 'workspace-write';
    args['approval-policy'] = req.approvalPolicy || 'on-request';
    if (req.model) args.model = req.model;
    if (req.cwd) args.cwd = req.cwd;
    if (req.profile) args.profile = req.profile;
    if (req.config && typeof req.config === 'object' && Object.keys(req.config).length > 0) {
      args.config = req.config;
    }
  }

  await appendProgress(progressFile, 'Calling codex mcp tool: ' + toolName);
  activeProgressFile = progressFile;
  let result;
  try {
    result = await client.callTool(
      { name: toolName, arguments: args },
      undefined,
      {
        timeout: TOOL_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        onprogress: progress => {
          const current = typeof progress?.progress === 'number' ? progress.progress : '?';
          const total = typeof progress?.total === 'number' ? progress.total : '?';
          const message = compactObservableText(progress?.message || '', 240);
          const suffix = message ? ' - ' + message : '';
          return appendProgress(progressFile, 'progress ' + current + '/' + total + suffix);
        }
      }
    );
  } finally {
    activeProgressFile = null;
  }
  if (result.isError) {
    const msg = extractTextContent(result.content) || 'codex mcp-server call failed';
    throw new Error(msg);
  }

  const structured = result.structuredContent && typeof result.structuredContent === 'object'
    ? result.structuredContent
    : {};

  const content =
    typeof structured.content === 'string'
      ? structured.content
      : extractTextContent(result.content) || JSON.stringify(result, null, 2);

  const threadId =
    typeof structured.threadId === 'string'
      ? structured.threadId
      : req.threadId;

  const contentSummary = compactObservableText(content);
  if (contentSummary) {
    await appendProgress(progressFile, 'response ' + contentSummary);
  }

  return { content, threadId };
}

async function main() {
  const stateDir = process.argv[2];
  const paneId = process.env.TMUX_PANE;
  if (!stateDir) throw new Error('Missing stateDir argument');
  if (!paneId) throw new Error('TMUX_PANE environment variable missing');

  const paneDirPath = join(stateDir, 'panes', paneKey(paneId));
  const requestsDir = join(paneDirPath, 'requests');
  const responsesDir = join(paneDirPath, 'responses');
  const progressDir = join(paneDirPath, 'progress');
  await mkdir(requestsDir, { recursive: true });
  await mkdir(responsesDir, { recursive: true });
  await mkdir(progressDir, { recursive: true });

  const configuredCodexCommand =
    process.env.CODEX_MCP_CODEX_PATH || process.env.RIFF_CODEX_BIN || '/home/wings/.local/bin/rolodex';
  const baseCwd = process.env.CODEX_MCP_CWD || process.cwd();
  const codexCommand =
    configuredCodexCommand.includes('/') && !isAbsolute(configuredCodexCommand)
      ? resolve(baseCwd, configuredCodexCommand)
      : configuredCodexCommand;
  const transportEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') transportEnv[key] = value;
  }
  const transport = new StdioClientTransport({
    command: codexCommand,
    args: ['mcp-server'],
    env: transportEnv,
  });
  const client = new Client(
    { name: 'codex-mcp-tmux-pane-worker', version: '1.3.11' },
    { capabilities: {} }
  );

  await client.connect(transport);
  client.setNotificationHandler(LoggingMessageNotificationSchema, notification => {
    if (!activeProgressFile) return;
    const level = notification?.params?.level || 'info';
    const data =
      typeof notification?.params?.data === 'string'
        ? notification.params.data
        : JSON.stringify(notification?.params?.data ?? '');
    const summary = compactObservableText(data, 240);
    if (!summary) return;
    return appendProgress(activeProgressFile, 'log/' + level + ' ' + summary);
  });
  try {
    await client.setLoggingLevel('debug', { timeout: 5000 });
  } catch {}
  const tools = await client.listTools(undefined, { timeout: TOOL_TIMEOUT_MS });
  const codexToolName =
    tools.tools.find(t => t.name === 'codex')?.name ||
    tools.tools.find(t => t.name.includes('codex'))?.name ||
    tools.tools[0]?.name;
  const replyToolName = tools.tools.find(t => t.name === 'codex-reply')?.name;
  if (!codexToolName) throw new Error('codex mcp-server returned no tools');

  while (true) {
    const files = (await readdir(requestsDir)).filter(f => f.endsWith('.json')).sort();
    if (files.length === 0) {
      await sleep(200);
      continue;
    }

    for (const file of files) {
      const from = join(requestsDir, file);
      const processing = from + '.processing';
      const responsePath = join(responsesDir, file);
      const progressPath = join(progressDir, file.replace(/\\.json$/, '.log'));

      try {
        await rename(from, processing);
      } catch {
        continue;
      }

      try {
        const raw = await readFile(processing, 'utf8');
        const req = JSON.parse(raw);
        await appendProgress(progressPath, 'Request received');

        const out = await handleRequest(client, codexToolName, replyToolName, req, progressPath);
        await writeFile(responsePath, JSON.stringify({ ok: true, ...out }), 'utf8');
        await appendProgress(progressPath, 'Request completed');
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await appendProgress(progressPath, 'Request failed: ' + message);
        await writeFile(responsePath, JSON.stringify({ ok: false, error: message }), 'utf8');
      } finally {
        await rm(processing, { force: true });
      }
    }
  }
}

main().catch(async error => {
  const message = error instanceof Error ? error.message : String(error);
  try { console.error(message); } catch {}
  process.exitCode = 1;
});
`.trimStart();
}

function ensureWorkerScript(): void {
  ensureDirs();
  writeFileSync(WORKER_SCRIPT_PATH, buildWorkerScript(), 'utf8');
}

async function runTmux(args: string[]): Promise<string> {
  const result = await executeCommandDetailed('tmux', args);
  if (!result.ok) {
    throw new Error(result.stderr || `tmux ${args.join(' ')} failed`);
  }
  return result.stdout;
}

async function ensureSession(): Promise<void> {
  const has = await executeCommandDetailed('tmux', ['has-session', '-t', TMUX_SESSION]);
  if (has.ok) return;
  await runTmux(['new-session', '-d', '-s', TMUX_SESSION]);
}

async function listPaneIds(): Promise<Set<string>> {
  try {
    const stdout = await runTmux(['list-panes', '-a', '-t', TMUX_SESSION, '-F', '#{pane_id}']);
    const ids = stdout
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);
    return new Set(ids);
  } catch {
    return new Set();
  }
}

async function spawnWorkerPane(): Promise<string> {
  ensureWorkerScript();
  await ensureSession();

  const cmd = `bash -lc ${shellQuote(`node ${shellQuote(WORKER_SCRIPT_PATH)} ${shellQuote(STATE_DIR)}`)}`;
  const paneId = (await runTmux([
    'new-window',
    '-t', TMUX_SESSION,
    '-P',
    '-F',
    '#{pane_id}',
    cmd,
  ])).trim();

  if (!paneId) {
    throw new Error('Failed to create tmux pane for codex worker');
  }

  // Give worker a brief moment to create pane directories
  await sleep(200);
  return paneId;
}

function requestPathFor(paneId: string, requestId: string): string {
  return join(paneDir(paneId), 'requests', `${requestId}.json`);
}

function responsePathFor(paneId: string, requestId: string): string {
  return join(paneDir(paneId), 'responses', `${requestId}.json`);
}

function progressPathFor(paneId: string, requestId: string): string {
  return join(paneDir(paneId), 'progress', `${requestId}.log`);
}

async function submitRequestToPane(
  paneId: string,
  req: WorkerRequest,
  onProgress?: (newOutput: string) => void
): Promise<WorkerResponse> {
  const reqPath = requestPathFor(paneId, req.requestId);
  const resPath = responsePathFor(paneId, req.requestId);
  const progPath = progressPathFor(paneId, req.requestId);

  mkdirSync(join(paneDir(paneId), 'requests'), { recursive: true });
  mkdirSync(join(paneDir(paneId), 'responses'), { recursive: true });
  mkdirSync(join(paneDir(paneId), 'progress'), { recursive: true });

  writeFileSync(reqPath, JSON.stringify(req), 'utf8');

  let progressOffset = 0;
  let livenessChecks = 0;
  while (true) {
    if (existsSync(progPath) && onProgress) {
      const data = readFileSync(progPath, 'utf8');
      if (data.length > progressOffset) {
        onProgress(data.slice(progressOffset));
        progressOffset = data.length;
      }
    }

    if (existsSync(resPath)) {
      const raw = readFileSync(resPath, 'utf8');
      const parsed = JSON.parse(raw) as WorkerResponse;
      try {
        unlinkSync(resPath);
      } catch {}
      try {
        unlinkSync(reqPath);
      } catch {}
      return parsed;
    }

    // If the pane/session is gone, fail fast instead of waiting forever.
    livenessChecks += 1;
    if (livenessChecks % 5 === 0) {
      const paneIds = await listPaneIds();
      if (!paneIds.has(paneId)) {
        throw new Error(`tmux worker pane is not alive for paneId=${paneId}`);
      }
    }

    await sleep(300);
  }
}

export async function isTmuxAvailable(): Promise<boolean> {
  if (tmuxAvailable !== null) return tmuxAvailable;
  const result = await executeCommandDetailed('tmux', ['-V']);
  tmuxAvailable = result.ok;
  return tmuxAvailable;
}

export async function executeCodexViaTmux(
  prompt: string,
  options: TmuxCodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<TmuxCodexExecutionResult> {
  ensureDirs();
  ensureWorkerScript();
  await ensureSession();

  const paneIds = await listPaneIds();
  let targetPane: string | undefined;

  if (options.threadId) {
    const binding = getThreadBinding(options.threadId);
    if (binding && paneIds.has(binding.paneId)) {
      targetPane = binding.paneId;
    } else {
      throw new Error(
        `No active tmux pane found for threadId ${options.threadId}. Start a fresh session (no threadId) or use resume=none.`
      );
    }
  } else {
    targetPane = await spawnWorkerPane();
  }

  const requestId = randomUUID();
  const req: WorkerRequest = {
    requestId,
    prompt,
    threadId: options.threadId,
    model: options.model,
    sandbox: options.sandboxMode || 'workspace-write',
    approvalPolicy: options.approvalPolicy || 'on-request',
    cwd: options.cwd,
    profile: options.profile,
    config: options.config,
  };

  const response = await submitRequestToPane(targetPane, req, onProgress);
  if (!response.ok) {
    throw new Error(response.error || 'tmux codex worker failed');
  }

  if (response.threadId) {
    setThreadBinding(response.threadId, targetPane);
  }

  return {
    content: response.content || '',
    threadId: response.threadId,
  };
}

export async function despawnCodexThread(threadId: string): Promise<boolean> {
  const binding = getThreadBinding(threadId);
  if (!binding) return false;

  const paneIds = await listPaneIds();
  if (!paneIds.has(binding.paneId)) return false;

  const result = await executeCommandDetailed('tmux', ['kill-pane', '-t', binding.paneId]);
  return result.ok;
}

export async function listThreadBindings(): Promise<Array<{ threadId: string; paneId: string }>> {
  const map = loadThreadMap();
  const paneIds = await listPaneIds();
  return Object.entries(map)
    .filter(([, binding]) => paneIds.has(binding.paneId))
    .map(([threadId, binding]) => ({ threadId, paneId: binding.paneId }));
}
