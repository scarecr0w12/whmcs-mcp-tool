#!/usr/bin/env node
/**
 * WHMCS MCP Server - Streamable HTTP transport
 *
 * Runs the WHMCS MCP server over HTTP so it can be hosted on a server and
 * accessed remotely by MCP clients. Uses the MCP Streamable HTTP transport
 * with per-session transports.
 *
 * Env vars:
 *   MCP_HTTP_PORT   - Port to listen on (default 3000)
 *   MCP_HTTP_HOST   - Host to bind (default 0.0.0.0)
 *   MCP_AUTH_TOKEN  - Optional. If set, clients must send
 *                     `Authorization: Bearer <token>`.
 *   MCP_ALLOWED_HOSTS - Optional comma-separated Host header allowlist
 *                       for DNS-rebinding protection (e.g. mcp.example.com).
 */

import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import express, { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { createServer, validateConfig } from './index.js';

const PORT = parseInt(process.env.MCP_HTTP_PORT || '3000', 10);
const HOST = process.env.MCP_HTTP_HOST || '0.0.0.0';
const AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
const ALLOWED_HOSTS = (process.env.MCP_ALLOWED_HOSTS || '')
    .split(',')
    .map((h) => h.trim())
    .filter(Boolean);

// Map of active sessions -> their transport.
const transports = new Map<string, StreamableHTTPServerTransport>();

function unauthorized(res: Response) {
    res.status(401).json({
        jsonrpc: '2.0',
        error: { code: -32001, message: 'Unauthorized' },
        id: null,
    });
}

function checkAuth(req: Request, res: Response): boolean {
    if (!AUTH_TOKEN) return true;
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (token !== AUTH_TOKEN) {
        unauthorized(res);
        return false;
    }
    return true;
}

const app = express();
app.use(express.json({ limit: '4mb' }));

// Simple health check for load balancers / uptime monitors.
app.get('/health', (_req, res) => {
    res.json({ status: 'ok', configured: validateConfig(), sessions: transports.size });
});

const handleSession = async (req: Request, res: Response) => {
    if (!checkAuth(req, res)) return;

    const sessionId = req.headers['mcp-session-id'] as string | undefined;

    // Existing session: route to its transport.
    if (sessionId && transports.has(sessionId)) {
        await transports.get(sessionId)!.handleRequest(req, res, req.body);
        return;
    }

    // New session: only valid on an initialize request.
    if (!sessionId && isInitializeRequest(req.body)) {
        const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => randomUUID(),
            enableDnsRebindingProtection: ALLOWED_HOSTS.length > 0,
            allowedHosts: ALLOWED_HOSTS.length > 0 ? ALLOWED_HOSTS : undefined,
            onsessioninitialized: (id) => {
                transports.set(id, transport);
            },
        });

        transport.onclose = () => {
            if (transport.sessionId) transports.delete(transport.sessionId);
        };

        const server = createServer();
        await server.connect(transport);
        await transport.handleRequest(req, res, req.body);
        return;
    }

    if (sessionId) {
        res.status(404).json({
            jsonrpc: '2.0',
            error: { code: -32001, message: 'Session not found' },
            id: null,
        });
        return;
    }

    res.status(400).json({
        jsonrpc: '2.0',
        error: { code: -32000, message: 'Bad Request: no valid session ID' },
        id: null,
    });
};

// Streamable HTTP endpoint: POST for requests, GET for the SSE stream, DELETE to close.
app.post('/mcp', handleSession);
app.get('/mcp', handleSession);
app.delete('/mcp', handleSession);

function main() {
    if (!validateConfig()) {
        console.error('Warning: WHMCS configuration incomplete. Tools will not function until configured.');
    }

    app.listen(PORT, HOST, () => {
        console.error(`WHMCS MCP Server started (HTTP) on http://${HOST}:${PORT}/mcp`);
        if (AUTH_TOKEN) console.error('Bearer token auth: ENABLED');
        else console.error('Bearer token auth: DISABLED (set MCP_AUTH_TOKEN to require a token)');
    });
}

main();
