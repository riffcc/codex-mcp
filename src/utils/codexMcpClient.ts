import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

import { CLI } from '../constants.js';
import { Logger } from './logger.js';

export interface CodexMcpCallOptions {
  prompt: string;
  threadId?: string;
  model?: string;
  cwd?: string;
  sandbox?: 'read-only' | 'workspace-write' | 'danger-full-access';
  approvalPolicy?: 'never' | 'on-request' | 'on-failure' | 'untrusted';
  profile?: string;
  config?: Record<string, unknown>;
}

interface CodexMcpState {
  client: Client;
  transport: StdioClientTransport;
  codexToolName: string;
  replyToolName?: string;
}

export interface CodexMcpResponse {
  content: string;
  threadId?: string;
}

let statePromise: Promise<CodexMcpState> | null = null;
const INTERNAL_TOOL_TIMEOUT_MS = (() => {
  const raw = Number(process.env.CODEX_MCP_INTERNAL_TOOL_TIMEOUT_MS || 24 * 60 * 60 * 1000);
  return Number.isFinite(raw) && raw > 0 ? raw : 24 * 60 * 60 * 1000;
})();

function buildTransportEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (typeof value === 'string') {
      env[key] = value;
    }
  }
  return env;
}

function extractTextContent(content: any[] | undefined): string {
  if (!content || content.length === 0) return '';
  const textParts: string[] = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      textParts.push(part.text);
    }
  }
  return textParts.join('\n').trim();
}

async function initState(): Promise<CodexMcpState> {
  const transport = new StdioClientTransport({
    command: CLI.COMMANDS.CODEX,
    args: ['mcp-server'],
    env: buildTransportEnv(),
  });
  const client = new Client(
    {
      name: 'codex-mcp-remote-bridge',
      version: '1.3.11',
    },
    { capabilities: {} }
  );

  await client.connect(transport);
  const tools = await client.listTools(undefined, { timeout: INTERNAL_TOOL_TIMEOUT_MS });
  const codexToolName =
    tools.tools.find(t => t.name === 'codex')?.name ||
    tools.tools.find(t => t.name.includes('codex'))?.name ||
    tools.tools[0]?.name;
  const replyToolName = tools.tools.find(t => t.name === 'codex-reply')?.name;

  if (!codexToolName) {
    throw new Error('codex mcp-server returned no tools');
  }

  Logger.debug(`Connected to codex mcp-server, using tool: ${codexToolName}`);
  return { client, transport, codexToolName, replyToolName };
}

async function getState(): Promise<CodexMcpState> {
  if (!statePromise) {
    statePromise = initState().catch(err => {
      statePromise = null;
      throw err;
    });
  }
  return statePromise;
}

export async function callCodexMcpSession(
  options: CodexMcpCallOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexMcpResponse> {
  const state = await getState();
  const useReplyTool = !!options.threadId && !!state.replyToolName;
  const args: Record<string, unknown> = { prompt: options.prompt };

  if (useReplyTool) {
    args.threadId = options.threadId;
  } else {
    args.sandbox = options.sandbox ?? 'workspace-write';
    args['approval-policy'] = options.approvalPolicy ?? 'on-request';
    if (options.model) args.model = options.model;
    if (options.cwd) args.cwd = options.cwd;
    if (options.profile) args.profile = options.profile;
    if (options.config && Object.keys(options.config).length > 0) {
      args.config = options.config;
    }
  }

  onProgress?.(
    useReplyTool
      ? `Continuing codex thread via ${state.replyToolName}...`
      : 'Submitting request via codex mcp-server...'
  );
  const result = await state.client.callTool(
    {
      name: useReplyTool ? (state.replyToolName as string) : state.codexToolName,
      arguments: args,
    },
    undefined,
    {
      timeout: INTERNAL_TOOL_TIMEOUT_MS,
      resetTimeoutOnProgress: true,
      onprogress: progress => {
        const current = typeof progress?.progress === 'number' ? progress.progress : '?';
        const total = typeof progress?.total === 'number' ? progress.total : '?';
        const message =
          typeof progress?.message === 'string' && progress.message.trim()
            ? ` - ${progress.message.trim()}`
            : '';
        onProgress?.(`mcp progress ${current}/${total}${message}`);
      },
    }
  );

  if (result.isError) {
    const txt = extractTextContent(result.content as any[]);
    throw new Error(txt || 'codex mcp-server call failed');
  }

  const structured = result.structuredContent as { content?: string; threadId?: string } | undefined;
  const content =
    structured?.content && typeof structured.content === 'string'
      ? structured.content
      : extractTextContent(result.content as any[]) || JSON.stringify(result, null, 2);
  const threadId =
    structured?.threadId && typeof structured.threadId === 'string'
      ? structured.threadId
      : options.threadId;

  return { content, threadId };
}

export async function callCodexMcp(
  options: CodexMcpCallOptions,
  onProgress?: (newOutput: string) => void
): Promise<string> {
  const response = await callCodexMcpSession(options, onProgress);
  return response.content;
}
