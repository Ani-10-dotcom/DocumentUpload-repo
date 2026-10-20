// Local development server — no dependencies. Requires Node.js 18+.
// Usage:  node dev-server.js        then open http://localhost:3000
// Put your LLM settings in a .env file (see .env.example).
import http from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { extname, join, normalize } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

// Minimal .env loader
if (existsSync(join(root, '.env'))) {
  for (const line of readFileSync(join(root, '.env'), 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/i);
    if (m && !line.trim().startsWith('#') && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
}

const { default: chat } = await import('./api/chat.js');
const PORT = process.env.PORT || 3000;
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon' };

http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);

    if (url.pathname === '/api/chat') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const request = new Request(url, {
        method: req.method,
        headers: req.headers,
        body: req.method === 'POST' ? Buffer.concat(chunks) : undefined,
      });
      const response = await chat(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) Readable.fromWeb(response.body).pipe(res); else res.end();
      return;
    }

    let path = normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
    if (path === '/' || path === '\\') path = '/index.html';
    if (path === '/chat') path = '/chat.html';
    const file = join(root, path);
    if (!file.startsWith(root) || /[/\\]\.env/.test(file) || !(await stat(file).catch(() => null))?.isFile()) {
      res.writeHead(404).end('Not found'); return;
    }
    res.writeHead(200, { 'Content-Type': TYPES[extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(await readFile(file));
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end('Server error');
  }
}).listen(PORT, () => {
  console.log(`\n  Upload page: http://localhost:${PORT}/`);
  console.log(`  Chatbot:     http://localhost:${PORT}/chat.html\n`);
  if (!process.env.GROQ_API_KEY && !process.env.LLM_API_KEY) console.log('  ⚠  No GROQ_API_KEY set — copy .env.example to .env and add your Groq key.\n');
});
