import { readdir, readFile, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

function paneKey(paneId) {
  return paneId.replace('%', 'pane_');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function extractTextContent(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const part of content) {
    if (part && typeof part === 'object' && part.type === 'text' && typeof part.text === 'string') {
      parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

async function appendProgress(filePath, message) {
  const line = '[' + new Date().toISOString() + '] ' + message + '\n';
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
  const result = await client.callTool({ name: toolName, arguments: args });
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

  const transport = new StdioClientTransport({ command: 'codex', args: ['mcp-server'] });
  const client = new Client(
    { name: 'codex-mcp-tmux-pane-worker', version: '1.3.1' },
    { capabilities: {} }
  );

  await client.connect(transport);
  const tools = await client.listTools();
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
      const progressPath = join(progressDir, file.replace(/\.json$/, '.log'));

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
