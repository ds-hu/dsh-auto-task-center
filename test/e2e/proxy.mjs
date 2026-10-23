#!/usr/bin/env node
/**
 * A throwaway reverse proxy, for checking the panel behind one.
 *
 * The panel talks to the Host over same-origin `fetch`, and the Host used to
 * compare that `Origin` against the address it bound. Behind a proxy those
 * differ, every save was refused with `cross-origin`, and the browser showed
 * nothing but a failed request. This script reproduces the deployment shape
 * locally: it forwards the request as-is, including the `Host` the browser
 * used, so the upstream sees what Cloudflare or nginx would send.
 *
 * Usage:
 *   node test/e2e/proxy.mjs --listen 4173 --target http://127.0.0.1:3080
 *
 * It prints `proxy ready on http://127.0.0.1:4173` and stays up until killed.
 * Nothing about it is part of the published package: it is a test tool.
 */
import http from 'node:http';
import net from 'node:net';

/**
 * Read `--name value` pairs.
 * @param {string[]} argv - Process arguments.
 * @returns {Record<string, string>} the parsed flags.
 */
function flags(argv) {
  const out = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    out[token.slice(2)] = argv[index + 1];
    index += 1;
  }
  return out;
}

const options = flags(process.argv.slice(2));
const listen = Number(options.listen ?? 4173);
const target = new URL(options.target ?? 'http://127.0.0.1:3080');

const server = http.createServer((req, res) => {
  const upstream = http.request({
    host: target.hostname,
    port: target.port,
    path: req.url,
    method: req.method,
    // Forward every header untouched: `Host` stays the name the browser used,
    // which is exactly the case the fence has to accept.
    headers: req.headers,
  }, (answer) => {
    res.writeHead(answer.statusCode ?? 502, answer.headers);
    answer.pipe(res);
  });
  upstream.on('error', (error) => {
    res.writeHead(502, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: false, code: 'proxy-failed', error: error.message }));
  });
  req.pipe(upstream);
});

/**
 * Forward a WebSocket upgrade the same way, byte for byte.
 *
 * The panel speaks plain JSON over `fetch`, but the Host pushes session and
 * workspace state down a socket; a proxy that only forwards requests leaves the
 * GUI stuck on "Loading workspaces…", which is exactly what a real deployment
 * would look like if the proxy forgot to upgrade.
 */
server.on('upgrade', (req, socket, head) => {
  const upstream = net.connect(Number(target.port), target.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/1.1`];
    for (let index = 0; index < req.rawHeaders.length; index += 2) {
      lines.push(`${req.rawHeaders[index]}: ${req.rawHeaders[index + 1]}`);
    }
    upstream.write(`${lines.join('\r\n')}\r\n\r\n`);
    if (head.length > 0) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('error', () => upstream.destroy());
});

server.listen(listen, '127.0.0.1', () => {
  console.log(`proxy ready on http://127.0.0.1:${listen}`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
  });
}
