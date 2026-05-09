#!/usr/bin/env node
// linksee-memory MCP server — stdio transport entry point.
// All logic lives in create-server.ts; this file just wires the transport.

import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { openDb, runMigrations } from '../db/migrate.js';
import { createLinkseeServer } from './create-server.js';

const db = openDb();
runMigrations(db);
const server = createLinkseeServer(db);
const transport = new StdioServerTransport();
await server.connect(transport);
process.stderr.write('[linksee-memory] MCP server ready on stdio\n');
