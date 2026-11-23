// Static server with the SPA fallback for a Flutter web build in any folder:
//   node serve_dir.mjs <dir> <port>
// (tools/e2e/serve.mjs serves only ../../build/web; the backtest serves two builds.)
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

const [dir, port] = [path.resolve(process.argv[2]), Number(process.argv[3] ?? 5050)];
const mime = { '.html': 'text/html', '.js': 'application/javascript', '.mjs': 'application/javascript', '.json': 'application/json',
  '.css': 'text/css', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.ttf': 'font/ttf' };
createServer(async (req, res) => {
  let f = path.join(dir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  try { if ((await stat(f)).isDirectory()) f = path.join(f, 'index.html'); } catch { f = path.join(dir, 'index.html'); }
  try {
    res.writeHead(200, { 'content-type': mime[path.extname(f)] ?? 'application/octet-stream' });
    res.end(await readFile(f));
  } catch { res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1');
