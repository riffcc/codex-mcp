import { existsSync, readFileSync } from 'fs';
import { isAbsolute, resolve } from 'path';
import { Logger } from './logger.js';

// Codex Output Interface
export interface CodexOutput {
  metadata: {
    version?: string;
    workdir?: string;
    model?: string;
    provider?: string;
    approval?: string;
    sandbox?: string;
    reasoning_effort?: string;
    reasoning_summaries?: string;
    [key: string]: string | undefined;
  };
  userInstructions: string;
  thinking?: string;
  response: string;
  tokensUsed?: number;
  timestamps: string[];
  rawOutput: string;
}

interface SourceReference {
  path: string;
  line?: number;
}

const MAX_EXCERPT_FILES = 4;
const EXCERPT_RADIUS = 4;
const EXCERPT_MAX_CHARS = 1600;

export function parseCodexOutput(rawOutput: string): CodexOutput {
  const lines = rawOutput.split('\n');
  const timestamps: string[] = [];
  let metadata: any = {};
  let userInstructions = '';
  let thinking = '';
  let response = '';
  let tokensUsed: number | undefined;

  let currentSection = 'header';
  let metadataLines: string[] = [];
  let thinkingLines: string[] = [];
  let responseLines: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Extract timestamps
    const timestampMatch = line.match(/^\[([^\]]+)\]/);
    if (timestampMatch) {
      timestamps.push(timestampMatch[1]);
    }

    // Extract tokens used
    const tokensMatch = line.match(/tokens used:\s*(\d+)/);
    if (tokensMatch) {
      tokensUsed = parseInt(tokensMatch[1], 10);
      continue;
    }

    // Identify sections
    if (line.includes('OpenAI Codex') || line.includes('Codex CLI')) {
      currentSection = 'header';
      continue;
    } else if (line.startsWith('--------')) {
      if (currentSection === 'header') {
        currentSection = 'metadata';
      } else if (currentSection === 'metadata') {
        currentSection = 'content';
      }
      continue;
    } else if (line.includes('User instructions:')) {
      currentSection = 'userInstructions';
      continue;
    } else if (line.includes('thinking')) {
      currentSection = 'thinking';
      continue;
    } else if (line.includes('codex') || line.includes('assistant')) {
      currentSection = 'response';
      continue;
    }

    // Parse based on current section
    switch (currentSection) {
      case 'metadata':
        if (line.trim()) {
          metadataLines.push(line.trim());
        }
        break;
      case 'userInstructions':
        if (line.trim() && !line.includes('User instructions:')) {
          userInstructions += line + '\n';
        }
        break;
      case 'thinking':
        if (line.trim() && !line.includes('thinking')) {
          thinkingLines.push(line);
        }
        break;
      case 'response':
      case 'content':
        if (
          line.trim() &&
          !line.includes('codex') &&
          !line.includes('assistant') &&
          !line.includes('tokens used:')
        ) {
          responseLines.push(line);
        }
        break;
    }
  }

  // Parse metadata
  metadata = parseMetadata(metadataLines);
  thinking = thinkingLines.join('\n').trim();
  response = responseLines.join('\n').trim() || rawOutput; // Fallback to raw output if no response found
  userInstructions = userInstructions.trim();

  const output: CodexOutput = {
    metadata,
    userInstructions,
    thinking: thinking || undefined,
    response,
    tokensUsed,
    timestamps,
    rawOutput,
  };

  Logger.codexResponse(response, tokensUsed);
  return output;
}

function parseMetadata(metadataLines: string[]): any {
  const metadata: any = {};

  for (const line of metadataLines) {
    const colonIndex = line.indexOf(':');
    if (colonIndex > 0) {
      const key = line.substring(0, colonIndex).trim().toLowerCase().replace(/\s+/g, '_');
      const value = line.substring(colonIndex + 1).trim();
      metadata[key] = value;
    }
  }

  return metadata;
}

function normalizeRefPath(rawPath: string, workdir?: string): string | undefined {
  const trimmed = rawPath.trim();
  if (!trimmed) return undefined;
  if (isAbsolute(trimmed)) return trimmed;
  if (workdir) return resolve(workdir, trimmed);
  return undefined;
}

function collectSourceReferences(text: string, workdir?: string): SourceReference[] {
  const refs: SourceReference[] = [];
  const seen = new Set<string>();

  const addRef = (pathValue?: string, lineValue?: string) => {
    if (!pathValue) return;
    const normalizedPath = normalizeRefPath(pathValue, workdir);
    if (!normalizedPath) return;
    const line = lineValue ? parseInt(lineValue, 10) : undefined;
    const key = `${normalizedPath}:${line || 0}`;
    if (seen.has(key)) return;
    seen.add(key);
    refs.push({ path: normalizedPath, ...(line && line > 0 ? { line } : {}) });
  };

  const markdownLinkRegex =
    /\[[^\]]+\]\(((?:\/|\.{1,2}\/)[^)\s:]+(?:\/[^)\s:]*)?)(?::(\d+)(?::\d+)?)?(?:#L(\d+)(?:C\d+)?)?\)/g;
  for (const match of text.matchAll(markdownLinkRegex)) {
    addRef(match[1], match[3] || match[2]);
  }

  const absolutePathRegex =
    /(?:^|[\s(])((?:\/[^:\s)]+)+\.[A-Za-z0-9._-]+)(?::(\d+)(?::\d+)?)?(?:#L(\d+)(?:C\d+)?)?/g;
  for (const match of text.matchAll(absolutePathRegex)) {
    addRef(match[1], match[3] || match[2]);
  }

  const relativePathRegex =
    /(?:^|[\s(])((?:\.\.\/|\.\/)[^:\s)]+(?:\/[^:\s)]+)*\.[A-Za-z0-9._-]+)(?::(\d+)(?::\d+)?)?(?:#L(\d+)(?:C\d+)?)?/g;
  for (const match of text.matchAll(relativePathRegex)) {
    addRef(match[1], match[3] || match[2]);
  }

  return refs.slice(0, MAX_EXCERPT_FILES);
}

function buildSourceExcerpt(ref: SourceReference): string | undefined {
  if (!existsSync(ref.path)) return undefined;

  let content: string;
  try {
    content = readFileSync(ref.path, 'utf8');
  } catch {
    return undefined;
  }

  const lines = content.split('\n');
  const centerLine = ref.line && ref.line > 0 ? ref.line : 1;
  const start = Math.max(1, centerLine - EXCERPT_RADIUS);
  const end = Math.min(lines.length, centerLine + EXCERPT_RADIUS);

  const excerptLines: string[] = [];
  for (let i = start; i <= end; i++) {
    excerptLines.push(`${i.toString().padStart(4, ' ')} | ${lines[i - 1]}`);
  }

  let excerpt = excerptLines.join('\n');
  if (excerpt.length > EXCERPT_MAX_CHARS) {
    excerpt = excerpt.slice(0, EXCERPT_MAX_CHARS) + '\n...';
  }

  const label = ref.line ? `${ref.path}:${ref.line}` : ref.path;
  return `### ${label}\n\`\`\`\n${excerpt}\n\`\`\``;
}

function appendAffectedSourceExcerpts(output: CodexOutput, formatted: string): string {
  const refs = collectSourceReferences(output.response, output.metadata.workdir);
  if (refs.length === 0) return formatted;

  const excerpts = refs.map(buildSourceExcerpt).filter((value): value is string => !!value);
  if (excerpts.length === 0) return formatted;

  return `${formatted}\n\n**Affected Source Excerpts:**\n\n${excerpts.join('\n\n')}`;
}

export function formatCodexResponse(
  output: CodexOutput,
  includeThinking: boolean = true,
  includeMetadata: boolean = true
): string {
  let formatted = '';

  // Add metadata summary if requested
  if (includeMetadata && (output.metadata.model || output.metadata.sandbox)) {
    formatted += `**Codex Configuration:**\n`;
    if (output.metadata.model) formatted += `- Model: ${output.metadata.model}\n`;
    if (output.metadata.sandbox) formatted += `- Sandbox: ${output.metadata.sandbox}\n`;
    if (output.metadata.approval) formatted += `- Approval: ${output.metadata.approval}\n`;
    formatted += '\n';
  }

  // Add thinking section if requested and available
  if (includeThinking && output.thinking) {
    formatted += `**Reasoning:**\n`;
    formatted += output.thinking + '\n\n';
  }

  // Add main response
  if (includeMetadata || includeThinking) {
    formatted += `**Response:**\n`;
  }
  formatted += output.response;

  // Add token usage if available
  if (output.tokensUsed) {
    formatted += `\n\n*Tokens used: ${output.tokensUsed}*`;
  }

  return appendAffectedSourceExcerpts(output, formatted);
}

export function formatCodexResponseForMCP(
  result: string,
  includeThinking: boolean = true,
  includeMetadata: boolean = true
): string {
  // Try to parse the output first
  try {
    const parsed = parseCodexOutput(result);
    return formatCodexResponse(parsed, includeThinking, includeMetadata);
  } catch {
    // If parsing fails, return the raw output
    return result;
  }
}

export function extractCodeBlocks(text: string): string[] {
  const codeBlockRegex = /```[\s\S]*?```/g;
  const matches = text.match(codeBlockRegex);
  return matches || [];
}

export function extractDiffBlocks(text: string): string[] {
  const diffRegex = /```diff[\s\S]*?```/g;
  const matches = text.match(diffRegex);
  return matches || [];
}

export function isErrorResponse(output: CodexOutput | string): boolean {
  const errorKeywords = [
    'error',
    'failed',
    'unable',
    'cannot',
    'authentication',
    'permission denied',
    'rate limit',
    'quota exceeded',
  ];

  const responseText =
    typeof output === 'string' ? output.toLowerCase() : output.response.toLowerCase();

  return errorKeywords.some(keyword => responseText.includes(keyword));
}
