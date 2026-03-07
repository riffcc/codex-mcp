#!/usr/bin/env node

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { URL } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';

import { Logger } from './utils/logger.js';
import { createMcpServer } from './serverFactory.js';

const SERVER_VERSION = '1.3.11';
const host = process.env.CODEX_MCP_HTTP_HOST || '127.0.0.1';
const port = Number(process.env.CODEX_MCP_HTTP_PORT || 3765);
const mcpPath = process.env.CODEX_MCP_HTTP_MCP_PATH || '/mcp';

type SessionRecord = {
  transport: StreamableHTTPServerTransport;
};

const sessions = new Map<string, SessionRecord>();

function setCors(res: import('node:http').ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'content-type,mcp-session-id');
}

function badRequest(res: import('node:http').ServerResponse, message: string): void {
  res.statusCode = 400;
  res.setHeader('content-type', 'application/json');
  res.end(
    JSON.stringify({
      jsonrpc: '2.0',
      error: { code: -32000, message: `Bad Request: ${message}` },
      id: null,
    })
  );
}

async function main() {
  process.on('uncaughtException', err => {
    Logger.error('uncaughtException', err);
  });
  process.on('unhandledRejection', reason => {
    Logger.error('unhandledRejection', reason);
  });

  const configuredCwd = process.env.CODEX_MCP_CWD;
  if (configuredCwd && configuredCwd.trim().length > 0) {
    try {
      process.chdir(configuredCwd);
    } catch (error) {
      Logger.error(`Failed to chdir to CODEX_MCP_CWD=${configuredCwd}:`, error);
    }
  }

  Logger.warn(
    `http-startup version=${SERVER_VERSION} node=${process.version} cwd=${process.cwd()} host=${host} port=${port} path=${mcpPath}`
  );

  const httpServer = createServer(async (req, res) => {
    try {
      setCors(res);

      if (req.method === 'OPTIONS') {
        res.statusCode = 204;
        res.end();
        return;
      }

      const parsedUrl = new URL(req.url || '/', `http://${host}:${port}`);

      if (req.method === 'GET' && parsedUrl.pathname === '/health') {
        res.setHeader('content-type', 'application/json');
        res.end(
          JSON.stringify({
            ok: true,
            version: SERVER_VERSION,
            transport: 'streamable-http',
            path: mcpPath,
            sessions: sessions.size,
          })
        );
        return;
      }

      if (parsedUrl.pathname !== mcpPath) {
        res.statusCode = 404;
        res.end('Not found');
        return;
      }

      const sessionIdHeader = req.headers['mcp-session-id'];
      const sessionId = typeof sessionIdHeader === 'string' ? sessionIdHeader : undefined;

      let transport: StreamableHTTPServerTransport | undefined;

      if (sessionId && sessions.has(sessionId)) {
        transport = sessions.get(sessionId)?.transport;
      } else if (!sessionId && req.method === 'POST') {
        transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: id => {
            sessions.set(id, { transport: transport! });
            Logger.warn(`Streamable HTTP session initialized: ${id}`);
          },
        });

        transport.onclose = () => {
          const id = transport?.sessionId;
          if (id) {
            sessions.delete(id);
            Logger.warn(`Streamable HTTP session closed: ${id}`);
          }
        };

        transport.onerror = err => {
          Logger.error('Streamable HTTP transport error:', err);
        };

        const server = createMcpServer(SERVER_VERSION);
        await server.connect(transport);
      } else {
        badRequest(res, 'No valid session ID provided');
        return;
      }

      if (!transport) {
        badRequest(res, 'No transport available');
        return;
      }

      await transport.handleRequest(req, res);
    } catch (error) {
      Logger.error('HTTP handler error:', error);
      if (!res.headersSent) {
        res.statusCode = 500;
        res.end('Internal server error');
      }
    }
  });

  httpServer.on('clientError', err => {
    Logger.error('HTTP client error:', err);
  });

  httpServer.listen(port, host, () => {
    Logger.warn(`Streamable HTTP MCP listening on http://${host}:${port}${mcpPath}`);
  });
}

main().catch(error => {
  Logger.error('Fatal error:', error);
  process.exit(1);
});
