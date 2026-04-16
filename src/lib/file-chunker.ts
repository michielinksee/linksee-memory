// File chunking for read_smart diff cache.
// Splits files into semantic chunks so re-reads can return only modified regions.
//   .ts/.js/.jsx/.tsx/.mjs/.cjs → AST via @babel/parser (top-level decls)
//   .py                         → indent-based (top-level def/class)
//   .md                         → h2/h3 headings
//   else                        → fixed 100-line windows

import { parse as babelParse } from '@babel/parser';
import { createHash } from 'node:crypto';
import { extname } from 'node:path';

export type ChunkKind =
  | 'function'
  | 'class'
  | 'variable'
  | 'import'
  | 'heading'
  | 'python_def'
  | 'python_class'
  | 'python_preamble'
  | 'fixed';

export interface Chunk {
  id: string;            // stable identity across reads (func name, heading, line range)
  kind: ChunkKind;
  start_line: number;    // 1-indexed inclusive
  end_line: number;      // 1-indexed inclusive
  hash: string;          // short sha256 of chunk content
  content: string;       // raw text
}

export function shortHash(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

export function hashFile(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

function extractLines(content: string, start: number, end: number): string {
  return content.split('\n').slice(start - 1, end).join('\n');
}

export function chunkFile(path: string, content: string): Chunk[] {
  const ext = extname(path).toLowerCase();
  try {
    if (['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'].includes(ext)) {
      return chunkTsJs(content);
    }
    if (ext === '.py') return chunkPython(content);
    if (ext === '.md' || ext === '.markdown') return chunkMarkdown(content);
  } catch {
    // parse failures fall back to fixed
  }
  return chunkFixed(content, 100);
}

// ============================================================
// TypeScript / JavaScript — AST-based
// ============================================================
function chunkTsJs(content: string): Chunk[] {
  const ast = babelParse(content, {
    sourceType: 'unambiguous',
    plugins: ['typescript', 'jsx', 'decorators-legacy'],
    errorRecovery: true,
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
  });

  const chunks: Chunk[] = [];
  const importNodes: { start: number; end: number }[] = [];

  for (const node of (ast as any).program.body) {
    if (!node.loc) continue;
    const start = node.loc.start.line;
    const end = node.loc.end.line;

    if (node.type === 'ImportDeclaration') {
      importNodes.push({ start, end });
      continue;
    }

    const name = extractDeclName(node);
    const kind = mapNodeKind(node);
    const text = extractLines(content, start, end);
    chunks.push({
      id: `${kind}:${name}`,
      kind,
      start_line: start,
      end_line: end,
      hash: shortHash(text),
      content: text,
    });
  }

  if (importNodes.length > 0) {
    const first = importNodes[0].start;
    const last = importNodes[importNodes.length - 1].end;
    const text = extractLines(content, first, last);
    chunks.unshift({
      id: 'import:_block',
      kind: 'import',
      start_line: first,
      end_line: last,
      hash: shortHash(text),
      content: text,
    });
  }

  if (chunks.length === 0) return chunkFixed(content, 100);
  return chunks;
}

function extractDeclName(node: any): string {
  if (node.type === 'FunctionDeclaration') return node.id?.name ?? 'anonymous';
  if (node.type === 'ClassDeclaration') return node.id?.name ?? 'anonymous';
  if (node.type === 'VariableDeclaration') {
    const d = node.declarations?.[0];
    return d?.id?.name ?? 'anonymous';
  }
  if (node.type === 'ExportNamedDeclaration') {
    if (node.declaration) return extractDeclName(node.declaration);
    const first = node.specifiers?.[0];
    return first?.exported?.name ?? 'named_export';
  }
  if (node.type === 'ExportDefaultDeclaration') {
    if (node.declaration?.id?.name) return node.declaration.id.name;
    return 'default';
  }
  if (node.type === 'TSInterfaceDeclaration') return node.id?.name ?? 'interface';
  if (node.type === 'TSTypeAliasDeclaration') return node.id?.name ?? 'type';
  if (node.type === 'TSEnumDeclaration') return node.id?.name ?? 'enum';
  if (node.type === 'TSModuleDeclaration') return node.id?.name ?? 'module';
  return node.type;
}

function mapNodeKind(node: any): ChunkKind {
  const t = node.type;
  if (t === 'FunctionDeclaration') return 'function';
  if (t === 'ClassDeclaration') return 'class';
  if (['VariableDeclaration', 'TSInterfaceDeclaration', 'TSTypeAliasDeclaration', 'TSEnumDeclaration', 'TSModuleDeclaration'].includes(t)) return 'variable';
  if (t === 'ExportNamedDeclaration' || t === 'ExportDefaultDeclaration') {
    if (node.declaration) return mapNodeKind(node.declaration);
    return 'variable';
  }
  return 'variable';
}

// ============================================================
// Python — indent-based
// ============================================================
function chunkPython(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let current: { start: number; name: string; kind: 'python_def' | 'python_class' } | null = null;

  const pushCurrent = (end: number) => {
    if (!current) return;
    const text = extractLines(content, current.start, end);
    chunks.push({
      id: `${current.kind}:${current.name}`,
      kind: current.kind,
      start_line: current.start,
      end_line: end,
      hash: shortHash(text),
      content: text,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith(' ') || line.startsWith('\t')) continue;
    const m = line.match(/^(async\s+def|def|class)\s+(\w+)/);
    if (m) {
      pushCurrent(i); // previous ends at the line before current
      const kind: 'python_def' | 'python_class' = m[1] === 'class' ? 'python_class' : 'python_def';
      current = { start: i + 1, name: m[2], kind };
    }
  }
  pushCurrent(lines.length);

  if (chunks.length === 0) return chunkFixed(content, 100);

  if (chunks[0].start_line > 1) {
    const preambleText = extractLines(content, 1, chunks[0].start_line - 1);
    if (preambleText.trim()) {
      chunks.unshift({
        id: 'python_preamble',
        kind: 'python_preamble',
        start_line: 1,
        end_line: chunks[0].start_line - 1,
        hash: shortHash(preambleText),
        content: preambleText,
      });
    }
  }

  return chunks;
}

// ============================================================
// Markdown — h2/h3 boundaries
// ============================================================
function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  let current: { start: number; heading: string } | null = null;

  const pushCurrent = (end: number) => {
    if (!current) return;
    const text = extractLines(content, current.start, end);
    chunks.push({
      id: `heading:${current.heading}`,
      kind: 'heading',
      start_line: current.start,
      end_line: end,
      hash: shortHash(text),
      content: text,
    });
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/^(#{2,3})\s+(.+?)\s*$/);
    if (m) {
      pushCurrent(i);
      current = { start: i + 1, heading: m[2] };
    }
  }
  pushCurrent(lines.length);

  if (chunks.length === 0) return chunkFixed(content, 100);

  if (chunks[0].start_line > 1) {
    const preamble = extractLines(content, 1, chunks[0].start_line - 1);
    if (preamble.trim()) {
      chunks.unshift({
        id: 'heading:_preamble',
        kind: 'heading',
        start_line: 1,
        end_line: chunks[0].start_line - 1,
        hash: shortHash(preamble),
        content: preamble,
      });
    }
  }

  return chunks;
}

// ============================================================
// Fixed — 100-line windows (fallback)
// ============================================================
function chunkFixed(content: string, size: number): Chunk[] {
  const lines = content.split('\n');
  const chunks: Chunk[] = [];
  if (lines.length === 0) return chunks;
  for (let i = 0; i < lines.length; i += size) {
    const slice = lines.slice(i, i + size);
    const text = slice.join('\n');
    const end = Math.min(i + size, lines.length);
    chunks.push({
      id: `lines:${i + 1}_${end}`,
      kind: 'fixed',
      start_line: i + 1,
      end_line: end,
      hash: shortHash(text),
      content: text,
    });
  }
  return chunks;
}
