/* ============================================================
   Axion Studio — zero-runtime-dependency local HTTP application.

   Start directly:
     node src/studio/server.mjs --root . --port 4177

   Security boundary:
   - loopback-only by default
   - read-only APIs
   - workspace paths remain inside the selected root
   - preview serving is restricted to browser assets
   ============================================================ */
import { createServer } from 'node:http';
import { readFileSync, statSync } from 'node:fs';
import { dirname, extname, join, relative, resolve as resolvePath, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  collectStudioSnapshot,
  readSourceExcerpt,
  resolveInside,
  resolveStudioReferenceAsset,
} from './data.mjs';
import { indexRepository } from '../system/indexer.mjs';

const CLIENT_ROOT = fileURLToPath(new URL('./client/', import.meta.url));
const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 4177;
const PREVIEW_EXTENSIONS = new Set([
  '.html', '.htm', '.css', '.js', '.mjs', '.cjs', '.json', '.map',
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.ico',
  '.woff', '.woff2', '.ttf', '.otf', '.mp4', '.webm', '.wav', '.mp3',
]);
const MIME = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.cjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.map': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
  '.webp': 'image/webp', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.otf': 'font/otf',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.wav': 'audio/wav', '.mp3': 'audio/mpeg',
};

/**
 * Create, but do not yet listen on, an Axion Studio server.
 * @param {{root?:string,host?:string,port?:number,allowRemote?:boolean,cacheTtl?:number}} options
 */
export function createStudioServer(options = {}) {
  const root = resolvePath(options.root ?? process.cwd());
  const host = options.host ?? DEFAULT_HOST;
  const port = Number.isInteger(options.port) ? options.port : DEFAULT_PORT;
  const allowRemote = options.allowRemote === true;
  const cacheTtl = Number.isFinite(options.cacheTtl) ? Math.max(0, options.cacheTtl) : 1200;
  if (!allowRemote && !isLoopbackHost(host)) {
    throw new Error(`Refusing non-loopback Studio host ${host}; pass allowRemote: true explicitly.`);
  }

  let graphCache = null;
  let graphCachedAt = 0;
  let snapshotCache = null;
  let snapshotCachedAt = 0;

  const graph = (force = false) => {
    const now = Date.now();
    if (!force && graphCache && now - graphCachedAt < cacheTtl) return graphCache;
    graphCache = indexRepository(root);
    graphCachedAt = now;
    snapshotCache = null;
    return graphCache;
  };
  const snapshot = async (force = false) => {
    const now = Date.now();
    if (!force && snapshotCache && now - snapshotCachedAt < cacheTtl) return snapshotCache;
    snapshotCache = await collectStudioSnapshot(root, { graph: graph(force) });
    snapshotCachedAt = now;
    return snapshotCache;
  };
  const invalidate = () => {
    graphCache = null;
    snapshotCache = null;
    graphCachedAt = 0;
    snapshotCachedAt = 0;
  };

  const server = createServer(async (request, response) => {
    setBaseHeaders(response);
    if (!allowRemote && !isLoopbackAddress(request.socket.remoteAddress)) {
      return sendJson(response, 403, { error: 'Axion Studio only accepts loopback clients.' });
    }
    const method = request.method ?? 'GET';
    let url;
    try { url = new URL(request.url ?? '/', `http://${request.headers.host ?? 'localhost'}`); }
    catch { return sendJson(response, 400, { error: 'Malformed request URL.' }); }

    try {
      if (method === 'GET' && url.pathname === '/api/health') {
        return sendJson(response, 200, {
          ok: true, schema: 'dk-studio-health/v1', root,
          graphCached: !!graphCache, snapshotCached: !!snapshotCache,
        });
      }
      if (method === 'GET' && url.pathname === '/api/snapshot') {
        return sendJson(response, 200, await snapshot(url.searchParams.get('refresh') === '1'));
      }
      if (method === 'GET' && url.pathname === '/api/graph') {
        return sendJson(response, 200, graph(url.searchParams.get('refresh') === '1'));
      }
      if (method === 'GET' && url.pathname === '/api/proof') {
        return sendJson(response, 200, graph(url.searchParams.get('refresh') === '1').proof);
      }
      if (method === 'GET' && url.pathname.startsWith('/api/reference-asset/')) {
        const token = url.pathname.slice('/api/reference-asset/'.length);
        if (!token || token.includes('/')) return sendJson(response, 400, { error: 'Denied malformed Reference asset token.' });
        const asset = await resolveStudioReferenceAsset(root, token);
        response.statusCode = 200;
        response.setHeader('Content-Type', asset.mediaType);
        response.setHeader('Content-Length', String(asset.byteLength));
        response.setHeader('Cache-Control', 'no-store');
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        response.setHeader('Cross-Origin-Resource-Policy', 'same-origin');
        response.setHeader('ETag', `"sha256-${asset.sha256}"`);
        response.end(asset.bytes);
        return true;
      }
      if (method === 'GET' && url.pathname === '/api/source') {
        const file = url.searchParams.get('file');
        if (!file) return sendJson(response, 400, { error: 'Missing file query parameter.' });
        return sendJson(response, 200, readSourceExcerpt(root, file, url.searchParams.get('line'), url.searchParams.get('context')));
      }
      if (method === 'POST' && url.pathname === '/api/refresh') {
        invalidate();
        return sendJson(response, 200, { ok: true });
      }

      if (method === 'GET' && url.pathname === '/') return serveClient(response, 'index.html');
      if (method === 'GET' && url.pathname === '/favicon.ico') {
        response.statusCode = 204;
        return response.end();
      }
      if (method === 'GET' && url.pathname.startsWith('/_studio/')) {
        const name = url.pathname.slice('/_studio/'.length);
        if (!['app.css', 'app.js', 'inspector.js'].includes(name)) return sendText(response, 404, 'Not found');
        return serveClient(response, name);
      }

      if (method === 'GET' && url.pathname.startsWith('/preview/')) {
        return serveWorkspace(
          response,
          root,
          decodePath(url.pathname.slice('/preview/'.length)),
          true,
          false,
          normalizeBridgeNonce(url.searchParams.get('__dk_studio_nonce')),
        );
      }

      // Absolute asset URLs inside a local preview (for example /styles/app.css)
      // fall back to the selected workspace. Studio/API namespaces never do.
      if (method === 'GET' && !url.pathname.startsWith('/api/') && !url.pathname.startsWith('/_studio/')) {
        const served = serveWorkspace(response, root, decodePath(url.pathname.slice(1)), false, true);
        if (served) return served;
      }
      return sendText(response, 404, 'Not found');
    } catch (error) {
      const status = /escapes|Unsupported|not found|Denied|dotfile|Reference asset|digest|integrity/i.test(error.message) ? 400 : 500;
      return sendJson(response, status, { error: error.message });
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  });

  const controller = {
    root, host, port, server, graph, snapshot, invalidate,
    get address() { return server.address(); },
    get url() {
      const address = server.address();
      const actualPort = typeof address === 'object' && address ? address.port : port;
      return `http://${displayHost(host)}:${actualPort}`;
    },
    listen() {
      return new Promise((resolve, reject) => {
        const onError = (error) => { server.off('listening', onListening); reject(error); };
        const onListening = () => { server.off('error', onError); resolve(controller); };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    },
  };
  return controller;
}

/** Create and listen in one call. */
export async function startStudio(options = {}) {
  const studio = createStudioServer(options);
  await studio.listen();
  return studio;
}

function serveClient(response, name) {
  const path = resolvePath(CLIENT_ROOT, name);
  if (relative(CLIENT_ROOT, path).startsWith('..')) return sendText(response, 404, 'Not found');
  const body = readFileSync(path);
  response.statusCode = 200;
  response.setHeader('Content-Type', MIME[extname(name)] ?? 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-cache');
  if (name === 'index.html') {
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: http: https:; font-src 'self' data:; frame-src 'self' http: https:; connect-src 'self'; object-src 'none'; base-uri 'self'");
  }
  response.end(body);
  return true;
}

function serveWorkspace(response, root, file, injectInspector, optional = false, bridgeNonce = '') {
  if (!file || hasDotSegment(file)) {
    if (optional) return false;
    throw new Error('Denied empty or dotfile preview path.');
  }
  const path = resolveInside(root, file);
  const ext = extname(path).toLowerCase();
  if (!PREVIEW_EXTENSIONS.has(ext)) {
    if (optional) return false;
    throw new Error(`Unsupported preview asset: ${ext || '(none)'}`);
  }
  let stat;
  try { stat = statSync(path); } catch {
    if (optional) return false;
    throw new Error(`Preview file not found: ${file}`);
  }
  if (!stat.isFile()) {
    if (optional) return false;
    throw new Error(`Preview path is not a file: ${file}`);
  }
  if (stat.size > 20 * 1024 * 1024) throw new Error('Preview asset exceeds the 20 MiB limit.');
  let body = readFileSync(path);
  if (injectInspector && (ext === '.html' || ext === '.htm')) {
    let source = body.toString('utf8');
    const inspectorStyles = collectInspectorStyles(root, path, source);
    if (inspectorStyles) {
      const style = `<style media="not all" data-dk-studio-rules>${inspectorStyles}</style>`;
      source = /<\/head\s*>/i.test(source) ? source.replace(/<\/head\s*>/i, `${style}</head>`) : `${style}${source}`;
    }
    const script = `<script src="/_studio/inspector.js" data-dk-studio-inspector data-dk-studio-nonce="${escapeHtmlAttribute(bridgeNonce)}"></script>`;
    body = Buffer.from(/<\/body\s*>/i.test(source) ? source.replace(/<\/body\s*>/i, `${script}</body>`) : `${source}\n${script}\n`);
  }
  response.statusCode = 200;
  response.setHeader('Content-Type', MIME[ext] ?? 'application/octet-stream');
  response.setHeader('Cache-Control', 'no-cache');
  response.end(body);
  return true;
}

function sendJson(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'application/json; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  response.end(`${JSON.stringify(value)}\n`);
}

function sendText(response, status, value) {
  response.statusCode = status;
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.end(String(value));
}

function setBaseHeaders(response) {
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('X-Frame-Options', 'SAMEORIGIN');
}

function decodePath(value) {
  try { return decodeURIComponent(value); }
  catch { throw new Error('Malformed preview path encoding.'); }
}

function hasDotSegment(value) {
  return String(value).split(/[\\/]+/).some((segment) => segment.startsWith('.') || segment === '..');
}
function collectInspectorStyles(root, htmlPath, html) {
  const chunks = [];
  let bytes = 0;
  const canonicalRoot = resolveInside(root, '');
  const link = /<link\b[^>]*>/gi;
  let match;
  while ((match = link.exec(html))) {
    const tag = match[0];
    const rel = attributeValue(tag, 'rel');
    const href = attributeValue(tag, 'href');
    if (!href || !/(?:^|\s)stylesheet(?:\s|$)/i.test(rel ?? '')) continue;
    if (/^(?:[a-z]+:|\/\/|#|data:)/i.test(href)) continue;
    let clean;
    try { clean = decodeURIComponent(href.split(/[?#]/)[0]); } catch { continue; }
    const candidate = clean.startsWith('/')
      ? clean.slice(1)
      : relative(canonicalRoot, resolvePath(dirname(htmlPath), clean));
    let path;
    try { path = resolveInside(root, candidate); } catch { continue; }
    if (extname(path).toLowerCase() !== '.css') continue;
    let stat;
    try { stat = statSync(path); } catch { continue; }
    if (!stat.isFile() || stat.size > 1024 * 1024 || bytes + stat.size > 2 * 1024 * 1024) continue;
    const css = readFileSync(path, 'utf8').replace(/<\/style/gi, '<\\/style');
    bytes += stat.size;
    chunks.push(`/* inspector source: ${candidate.replace(/[^a-zA-Z0-9_./-]/g, '')} */\n${css}`);
  }
  return chunks.join('\n');
}
function attributeValue(tag, name) {
  const match = tag.match(new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i'));
  return match ? match[1] ?? match[2] ?? match[3] ?? '' : null;
}
function normalizeBridgeNonce(value) { return /^[a-zA-Z0-9_-]{16,128}$/.test(value ?? '') ? value : ''; }
function escapeHtmlAttribute(value) { return String(value).replace(/[&<>"']/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[character]); }
function isLoopbackHost(host) { return ['127.0.0.1', 'localhost', '::1'].includes(host); }
function isLoopbackAddress(address) { return !address || address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1'; }
function displayHost(host) { return host === '::1' ? '[::1]' : host === 'localhost' ? 'localhost' : host; }

function parseCliArgs(argv) {
  const options = { root: process.cwd(), host: DEFAULT_HOST, port: DEFAULT_PORT };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--root') options.root = argv[++index];
    else if (arg === '--host') options.host = argv[++index];
    else if (arg === '--port') options.port = Number(argv[++index]);
    else if (arg === '--allow-remote') options.allowRemote = true;
    else if (arg === '--help' || arg === '-h') options.help = true;
    else throw new Error(`Unknown Studio option: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) throw new Error('Studio --port must be an integer from 0 to 65535.');
  return options;
}

const invokedPath = process.argv[1] ? resolvePath(process.argv[1]) : null;
if (invokedPath === fileURLToPath(import.meta.url)) {
  try {
    const options = parseCliArgs(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        'Usage: node src/studio/server.mjs [--root DIR] [--host 127.0.0.1] [--port 4177] [--allow-remote]\n' +
        'Studio is unauthenticated and exposes repository evidence APIs. Use --allow-remote only on a trusted network.\n',
      );
    } else {
      const studio = await startStudio(options);
      process.stdout.write(`Axion Studio\n${studio.url}\nroot: ${studio.root}\n`);
      const close = async () => { await studio.close(); process.exit(0); };
      process.once('SIGINT', close);
      process.once('SIGTERM', close);
    }
  } catch (error) {
    process.stderr.write(`Axion Studio: ${error.message}\n`);
    process.exitCode = 2;
  }
}
