import { homedir } from 'os';
import { dirname } from 'path';

import { Logger } from './logger.js';
import { resolveWorkingDirectory } from './workingDirResolver.js';
import { callCodexMcpSession } from './codexMcpClient.js';
import { executeCodexViaNodeSession, isNodeBackendAvailable } from './nodeSessionExecutor.js';
import { executeCodexViaTmux, isTmuxAvailable } from './tmuxCodexExecutor.js';

// Type-safe enums
export enum ApprovalPolicy {
  Never = 'never',
  OnRequest = 'on-request',
  OnFailure = 'on-failure',
  Untrusted = 'untrusted',
}

export enum SandboxMode {
  ReadOnly = 'read-only',
  WorkspaceWrite = 'workspace-write',
  DangerFullAccess = 'danger-full-access',
}

export interface CodexExecOptions {
  readonly threadId?: string;
  readonly model?: string;
  readonly approvalPolicy?: ApprovalPolicy;
  readonly sandboxMode?: SandboxMode;
  readonly approval?: string;
  readonly cd?: string;
  readonly workingDir?: string;
  readonly maxOutputBytes?: number;
  readonly retry?: unknown;
  readonly useStdinForLongPrompts?: boolean;
  readonly image?: string | string[];
  readonly config?: string | Record<string, unknown>;
  readonly profile?: string;
  readonly useExec?: boolean;
  readonly search?: boolean;
  readonly oss?: boolean;
  readonly enableFeatures?: string[];
  readonly disableFeatures?: string[];
  readonly mcpServers?: Record<string, unknown>;
}

export interface CodexExecutionResult {
  content: string;
  threadId?: string;
}

function normalizeHostPath(input?: string): string | undefined {
  if (!input) return undefined;
  const m = input.match(/^\/sessions\/[^/]+\/mnt\/([^/]+)(\/.*)?$/);
  if (m) {
    const hostUser = m[1];
    const rest = m[2] || '';
    const home = homedir();
    const homeRoot = dirname(home);
    return `${homeRoot}/${hostUser}${rest}`;
  }
  return input;
}

function deepMerge(base: Record<string, unknown>, incoming: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(incoming)) {
    const existing = result[key];
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      existing &&
      typeof existing === 'object' &&
      !Array.isArray(existing)
    ) {
      result[key] = deepMerge(existing as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function parsePrimitive(raw: string): unknown {
  const val = raw.trim();
  if (val === 'true') return true;
  if (val === 'false') return false;
  if (val === 'null') return null;
  if (/^-?\d+(\.\d+)?$/.test(val)) return Number(val);
  return val;
}

function parseConfigString(config: string): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const entries = config
    .split(',')
    .map(part => part.trim())
    .filter(Boolean);

  for (const entry of entries) {
    const sepIndex = entry.indexOf('=');
    if (sepIndex <= 0) {
      output[entry] = true;
      continue;
    }

    const key = entry.slice(0, sepIndex).trim();
    const rawValue = entry.slice(sepIndex + 1);
    if (!key) continue;

    const segments = key.split('.').map(s => s.trim()).filter(Boolean);
    if (segments.length === 0) continue;

    let cursor: Record<string, unknown> = output;
    for (let i = 0; i < segments.length - 1; i++) {
      const seg = segments[i];
      const existing = cursor[seg];
      if (!existing || typeof existing !== 'object' || Array.isArray(existing)) {
        cursor[seg] = {};
      }
      cursor = cursor[seg] as Record<string, unknown>;
    }

    cursor[segments[segments.length - 1]] = parsePrimitive(rawValue);
  }

  return output;
}

function mergeShellEnvironmentInherit(
  config: Record<string, unknown>,
  envKeys: string[]
): Record<string, unknown> {
  if (envKeys.length === 0) return config;

  const existingPolicy = config.shell_environment_policy;
  const policyObject =
    existingPolicy && typeof existingPolicy === 'object' && !Array.isArray(existingPolicy)
      ? (existingPolicy as Record<string, unknown>)
      : {};

  const existingInherit = policyObject.inherit;
  if (existingInherit === 'all') {
    return config;
  }

  return deepMerge(config, {
    shell_environment_policy: {
      ...policyObject,
      // Codex CLI expects this override to be a string variant, not an array.
      // "all" guarantees PLANE_* env vars are visible in shell commands.
      inherit: 'all',
    },
  });
}

function buildConfig(options?: CodexExecOptions): Record<string, unknown> | undefined {
  let config: Record<string, unknown> = {};

  if (options?.config) {
    const source =
      typeof options.config === 'string' ? parseConfigString(options.config) : options.config;
    config = deepMerge(config, source as Record<string, unknown>);
  }

  if (options?.search) {
    config = deepMerge(config, { features: { web_search_request: true } });
  }

  if (options?.oss) {
    config = deepMerge(config, { model_provider: 'oss' });
  }

  if (options?.enableFeatures?.length) {
    const flags = Object.fromEntries(options.enableFeatures.map(feature => [feature, true]));
    config = deepMerge(config, { features: flags });
  }

  if (options?.disableFeatures?.length) {
    const flags = Object.fromEntries(options.disableFeatures.map(feature => [feature, false]));
    config = deepMerge(config, { features: flags });
  }

  if (options?.mcpServers && Object.keys(options.mcpServers).length > 0) {
    config = deepMerge(config, { mcp_servers: options.mcpServers });
  }

  // Optional automatic llm-code-sdk MCP bridge wiring via env
  // Example:
  // CODEX_MCP_LLM_SDK_MCP_COMMAND="cargo"
  // CODEX_MCP_LLM_SDK_MCP_ARGS='["run","--manifest-path","/path/to/llm-code-sdk/Cargo.toml","--bin","llm-code-sdk-mcp"]'
  const llmSdkCommand = process.env.CODEX_MCP_LLM_SDK_MCP_COMMAND?.trim();
  if (llmSdkCommand) {
    let llmSdkArgs: string[] = [];
    const rawArgs = process.env.CODEX_MCP_LLM_SDK_MCP_ARGS?.trim();
    if (rawArgs) {
      try {
        const parsed = JSON.parse(rawArgs);
        if (Array.isArray(parsed)) {
          llmSdkArgs = parsed.map(v => String(v));
        }
      } catch {
        // Ignore malformed env JSON and continue with empty args
      }
    }
    const llmSdkServer = {
      command: llmSdkCommand,
      ...(llmSdkArgs.length > 0 ? { args: llmSdkArgs } : {}),
    };
    config = deepMerge(config, { mcp_servers: { llm_code_sdk: llmSdkServer } });
  }

  const passThroughEnvKeys = ['PLANE_API_KEY', 'PLANE_WORKSPACE_SLUG'].filter(
    key => !!process.env[key]?.trim()
  );
  config = mergeShellEnvironmentInherit(config, passThroughEnvKeys);
  config = deepMerge(config, {
    sandbox_workspace_write: {
      network_access: true,
    },
  });

  return Object.keys(config).length > 0 ? config : undefined;
}

function resolveCodexWorkingDir(prompt: string, options?: CodexExecOptions): string | undefined {
  const explicitCd = normalizeHostPath(options?.cd || options?.workingDir);
  const resolved =
    explicitCd ||
    resolveWorkingDirectory({
      workingDir: undefined,
      prompt,
    });

  if (resolved) {
    Logger.debug(`Resolved working directory: ${resolved}`);
  }
  return resolved;
}

function getApprovalPolicy(options?: CodexExecOptions): ApprovalPolicy {
  const candidate = (options?.approval || options?.approvalPolicy || ApprovalPolicy.OnRequest) as string;
  const allowed = new Set<string>(Object.values(ApprovalPolicy));
  if (allowed.has(candidate)) {
    return candidate as ApprovalPolicy;
  }
  return ApprovalPolicy.OnRequest;
}

function getSandboxMode(options?: CodexExecOptions): SandboxMode {
  const candidate = (options?.sandboxMode || SandboxMode.WorkspaceWrite) as string;
  const allowed = new Set<string>(Object.values(SandboxMode));
  if (allowed.has(candidate)) {
    return candidate as SandboxMode;
  }
  return SandboxMode.WorkspaceWrite;
}

async function executeViaMcp(
  prompt: string,
  options?: CodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexExecutionResult> {
  const cwd = resolveCodexWorkingDir(prompt, options);
  const config = buildConfig(options);

  if (options?.image) {
    onProgress?.('Note: image inputs are not supported by codex mcp-server yet; ignoring image parameter.');
  }

  return await callCodexMcpSession(
    {
      prompt,
      threadId: options?.threadId,
      model: options?.model,
      cwd,
      sandbox: getSandboxMode(options),
      approvalPolicy: getApprovalPolicy(options),
      profile: options?.profile,
      config,
    },
    onProgress
  );
}

async function executeViaTmux(
  prompt: string,
  options?: CodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexExecutionResult> {
  const cwd = resolveCodexWorkingDir(prompt, options);
  const config = buildConfig(options);

  if (options?.image) {
    onProgress?.('Note: image inputs are not supported by tmux codex backend; ignoring image parameter.');
  }

  return await executeCodexViaTmux(
    prompt,
    {
      threadId: options?.threadId,
      model: options?.model,
      cwd,
      sandboxMode: getSandboxMode(options),
      approvalPolicy: getApprovalPolicy(options),
      profile: options?.profile,
      config,
    },
    onProgress
  );
}

async function executeViaNodeSession(
  prompt: string,
  options?: CodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexExecutionResult> {
  const cwd = resolveCodexWorkingDir(prompt, options);
  const config = buildConfig(options);

  if (options?.image) {
    onProgress?.('Note: image inputs are not supported by node session codex backend; ignoring image parameter.');
  }

  return await executeCodexViaNodeSession(
    prompt,
    {
      threadId: options?.threadId,
      model: options?.model,
      cwd,
      sandboxMode: getSandboxMode(options),
      approvalPolicy: getApprovalPolicy(options),
      profile: options?.profile,
      config,
    },
    onProgress
  );
}

function requestedBackend(): 'tmux' | 'mcp' | 'node' {
  const raw = (process.env.CODEX_MCP_CODEX_BACKEND || 'node').trim().toLowerCase();
  if (raw === 'node') return 'node';
  if (raw === 'mcp') return 'mcp';
  if (raw === 'tmux') return 'tmux';
  return 'node';
}

async function executeViaConfiguredBackend(
  prompt: string,
  options?: CodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<CodexExecutionResult> {
  const backend = requestedBackend();

  if (backend === 'tmux') {
    const available = await isTmuxAvailable();
    if (available) {
      return await executeViaTmux(prompt, options, onProgress);
    }
    Logger.warn('tmux backend requested but tmux is unavailable; falling back to mcp backend');
  }

  if (backend === 'node') {
    const available = isNodeBackendAvailable();
    if (available) {
      return await executeViaNodeSession(prompt, options, onProgress);
    }
    Logger.warn('node backend requested but unavailable; falling back to mcp backend');
  }

  return await executeViaMcp(prompt, options, onProgress);
}

export async function executeCodexCLI(
  prompt: string,
  options?: CodexExecOptions,
  onProgress?: (newOutput: string) => void
): Promise<string> {
  const response = await executeViaConfiguredBackend(prompt, options, onProgress);
  return response.content;
}

export async function executeCodex(
  prompt: string,
  options?: CodexExecOptions & { [key: string]: unknown },
  onProgress?: (newOutput: string) => void
): Promise<string> {
  const response = await executeViaConfiguredBackend(prompt, options, onProgress);
  return response.content;
}

export async function executeCodexSession(
  prompt: string,
  options?: CodexExecOptions & { [key: string]: unknown },
  onProgress?: (newOutput: string) => void
): Promise<CodexExecutionResult> {
  return await executeViaConfiguredBackend(prompt, options, onProgress);
}
