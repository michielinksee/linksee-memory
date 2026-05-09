#!/usr/bin/env node
// linksee-memory MCP server — HTTP (StreamableHTTP) transport entry point.
// Each POST /mcp without a session ID spawns a new Server + transport pair.
// Multiple MCP clients can connect simultaneously; all share one SQLite db.

import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { openDb, runMigrations } from '../db/migrate.js';
import { createLinkseeServer } from './create-server.js';
import { authEnabled, resolveUser } from '../lib/users.js';

const PORT = Number(process.env.LINKSEE_HTTP_PORT ?? 8000);

const db = openDb();
runMigrations(db);

interface Session {
  transport: StreamableHTTPServerTransport;
  userId: string;
}

const sessions = new Map<string, Session>();

function readBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: http.ServerResponse, status: number, body: unknown, contentType = 'application/json'): void {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': contentType, 'Content-Length': Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://localhost:${PORT}`);

  // Health check
  if (url.pathname === '/health') {
    send(res, 200, { ok: true, sessions: sessions.size });
    return;
  }

  if (url.pathname !== '/mcp') {
    send(res, 404, { error: 'not found' });
    return;
  }

  try {
    // Resolve user_id from Bearer token (when auth is enabled)
    let userId = 'default';
    if (authEnabled) {
      const authHeader = req.headers['authorization'] ?? '';
      const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
      const resolved = resolveUser(token);
      if (!resolved) {
        send(res, 401, { error: 'Unauthorized: valid Authorization: Bearer <key> header required' });
        return;
      }
      userId = resolved;
    }

    if (req.method === 'POST') {
      const rawBody = await readBody(req);
      const contentType = req.headers['content-type'] ?? '';
      let parsedBody: unknown;
      if (contentType.includes('application/json') && rawBody.length > 0) {
        try { parsedBody = JSON.parse(rawBody.toString('utf8')); } catch { /* let transport handle */ }
      }

      const sessionId = req.headers['mcp-session-id'] as string | undefined;

      if (sessionId) {
        // Existing session — route to its transport
        const session = sessions.get(sessionId);
        if (!session) {
          send(res, 404, { error: `session ${sessionId} not found` });
          return;
        }
        await session.transport.handleRequest(req, res, parsedBody);
        return;
      }

      // New session — create Server + transport
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (sid) => {
          sessions.set(sid, { transport, userId });
        },
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) sessions.delete(sid);
      };

      const mcpServer = createLinkseeServer(db, userId);
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res, parsedBody);
      return;
    }

    if (req.method === 'GET') {
      // SSE reconnect for an existing session
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) { send(res, 400, { error: 'mcp-session-id header required for GET /mcp' }); return; }
      const session = sessions.get(sessionId);
      if (!session) { send(res, 404, { error: `session ${sessionId} not found` }); return; }
      await session.transport.handleRequest(req, res);
      return;
    }

    if (req.method === 'DELETE') {
      const sessionId = req.headers['mcp-session-id'] as string | undefined;
      if (!sessionId) { send(res, 400, { error: 'mcp-session-id header required for DELETE /mcp' }); return; }
      const session = sessions.get(sessionId);
      if (session) {
        await session.transport.close();
        sessions.delete(sessionId);
      }
      send(res, 200, { ok: true });
      return;
    }

    send(res, 405, { error: 'method not allowed' });
  } catch (err: any) {
    if (!res.headersSent) send(res, 500, { error: err?.message ?? String(err) });
  }
});

server.listen(PORT, () => {
  process.stderr.write(`[linksee-memory] HTTP MCP server ready on port ${PORT}\n`);
});
