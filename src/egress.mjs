import { createServer, request as httpRequest } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { appendFileSync, readFileSync, watchFile } from 'node:fs';

/*
 * Egress proxy, run in the `hauptling-egress` container: the only way out of the internal network.
 *   :3128   HTTP proxy. CONNECT host:port (HTTPS) and absolute-URI HTTP, allowed only for hosts
 *           on the allowlist ("example.com" exact, "*.example.com" subdomains). Blocked → 403, logged.
 *   :47800  plain TCP relay to the host broker (workers' HAUPTLING_BROKER points here).
 */

export function parseAllow(text) {
  return text.split('\n').map(l => l.replace(/#.*/, '').trim().toLowerCase()).filter(Boolean);
}

export function allowed(rules, host) {
  host = String(host).toLowerCase().replace(/\.$/, '');
  return rules.some(r => (r.startsWith('*.') ? host.endsWith(r.slice(1)) && host.length > r.length - 1 : host === r));
}

export function runEgress({ allow, log, relay, port = 3128, relayPort = 47800 }) {
  let rules = parseAllow(readFileSync(allow, 'utf8'));
  watchFile(allow, { interval: 2000 }, () => { try { rules = parseAllow(readFileSync(allow, 'utf8')); } catch {} });
  const note = (verdict, host) => { if (log) try { appendFileSync(log, `${new Date().toISOString()} ${verdict} ${host}\n`); } catch {} };

  const server = createServer((req, res) => {
    // Absolute-URI HTTP (apt mirrors etc.).
    let url;
    try { url = new URL(req.url); } catch { res.writeHead(400); return res.end('absolute URL required'); }
    if (!allowed(rules, url.hostname)) { note('BLOCK', url.hostname); res.writeHead(403); return res.end(`hauptling egress: ${url.hostname} is not on the allowlist\n`); }
    const up = httpRequest({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
      res.writeHead(r.statusCode, r.headers);
      r.pipe(res);
    });
    up.on('error', () => { res.writeHead(502); res.end(); });
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    const [host, p] = req.url.split(':');
    if (!allowed(rules, host)) {
      note('BLOCK', host);
      sock.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nhauptling egress: host not on the allowlist\n');
      return;
    }
    const up = connect(Number(p) || 443, host, () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
    up.on('error', () => sock.destroy());
    sock.on('error', () => up.destroy());
  });
  server.listen(port, '0.0.0.0');

  let relayServer = null;
  if (relay) {
    const [rh, rp] = relay.split(':');
    relayServer = createTcpServer((sock) => {
      const up = connect(Number(rp), rh);
      sock.pipe(up); up.pipe(sock);
      up.on('error', () => sock.destroy());
      sock.on('error', () => up.destroy());
    }).listen(relayPort, '0.0.0.0');
  }
  return { server, relayServer };
}
