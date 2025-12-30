#!/usr/bin/env bun
/**
 * Simple static file server with correct MIME types
 */

const port = parseInt(process.argv[2] || '3000');
const baseDir = process.argv[3] || '.';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
};

function getMimeType(path: string): string {
  const ext = path.substring(path.lastIndexOf('.'));
  return MIME_TYPES[ext] || 'application/octet-stream';
}

Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);
    let path = url.pathname === '/' ? '/index.html' : url.pathname;

    // Security: prevent directory traversal
    if (path.includes('..')) {
      return new Response('Forbidden', { status: 403 });
    }

    const filePath = `${baseDir}${path}`;
    const file = Bun.file(filePath);

    if (!(await file.exists())) {
      return new Response('Not Found', { status: 404 });
    }

    const mimeType = getMimeType(filePath);

    return new Response(file, {
      headers: {
        'Content-Type': mimeType,
      },
    });
  },
});

console.log(`Static server running on http://0.0.0.0:${port}`);
console.log(`Serving files from: ${baseDir}`);
