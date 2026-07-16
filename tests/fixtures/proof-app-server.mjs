import { createServer } from 'node:http';

const port = Number(process.argv[2] || 0);
const server = createServer((request, response) => {
  const url = new URL(request.url, 'http://127.0.0.1');
  if (!['/', '/pricing', '/broken', '/crash', '/late-crash'].includes(url.pathname)) {
    response.writeHead(404, { 'content-type': 'text/plain' });
    response.end('not found');
    return;
  }
  const broken = url.pathname === '/broken';
  const crash = url.pathname === '/crash';
  const lateCrash = url.pathname === '/late-crash';
  response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  response.end(`<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>Proof fixture</title><style>
  :root { --proof-fg: #111; --proof-bg: #fff; }
  body { color: var(--proof-fg); background: var(--proof-bg); }
</style></head>
<body>
  <header><nav aria-label="Primary"><a href="/">Home</a> <a href="/pricing">Pricing</a> <a id="escape-origin" href="about:blank">Escape</a> <a href="https://example.com/offsite">Offsite</a></nav></header>
  <main>
    <h1>${url.pathname === '/pricing' ? 'Pricing' : 'App proof'}</h1>
    <button id="open-menu" type="button" aria-expanded="false">Open details</button>
    <section id="details" aria-label="Details" hidden><p>State is open.</p></section>
    ${broken ? '<img src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">' : ''}
  </main>
  <script>
    ${crash ? "throw new Error('intentional-crash');" : ''}
    ${lateCrash ? `const originalQuerySelectorAll = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function(selector) {
      const result = originalQuerySelectorAll.call(this, selector);
      if (selector === '[style]') setTimeout(() => { throw new Error('late-token-crash'); }, 0);
      return result;
    };` : ''}
    document.querySelector('#open-menu').addEventListener('click', () => {
      document.querySelector('#details').hidden = false;
      document.querySelector('#open-menu').setAttribute('aria-expanded', 'true');
    });
  </script>
</body>
</html>`);
});

server.listen(port, '127.0.0.1', () => {
  const address = server.address();
  process.stdout.write(JSON.stringify({ port: address.port }) + '\n');
});

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
