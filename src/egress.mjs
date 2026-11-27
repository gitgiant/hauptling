import { createServer, request as httpRequest } from 'node:http';
import { connect, createServer as createTcpServer } from 'node:net';
import { appendFileSync, readFileSync, watchFile } from 'node:fs';

/*
 * Egress proxy, run in the `hauptling-egress` container: the only way out of the internal network.
 *   :3128   HTTP proxy. CONNECT host:port (HTTPS) and absolute-URI HTTP, allowed only for hosts
 *           on the allowlist ("example.com" exact, "*.example.com" subdomains). Blocked → 403, logged.
 *   :47800  plain TCP relay to the host broker (workers' HAUPTLING_BROKER points here).
 * A socket error ends only its own tunnel (logged as ERROR host code).
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

  const fail = (host, e) => {
    const line = `${host} ${e?.code || e?.message || 'error'}`;
    note('ERROR', line);
    console.error(`egress: ${line}`);
  };
  /**
   * One tunnel's or request's parts: an error on any of them destroys all of them and logs one line.
   * Every socket, request and response must pass through here: an unheard 'error' kills the process.
   */
  const guard = (host) => {
    const parts = [];
    let failed = false;
    return (part) => {
      parts.push(part);
      part.on('error', (e) => {
        if (!failed) { failed = true; fail(host, e); }
        for (const p of parts) p.destroy();
      });
      return part;
    };
  };

  const server = createServer((req, res) => {
    // Absolute-URI HTTP (apt mirrors etc.).
    let url;
    try { url = new URL(req.url); } catch {}
    const add = guard(url?.hostname || '-');
    add(req); add(res);
    if (!url) { res.writeHead(400); return res.end('absolute URL required'); }
    if (!allowed(rules, url.hostname)) { note('BLOCK', url.hostname); res.writeHead(403); return res.end(`hauptling egress: ${url.hostname} is not on the allowlist\n`); }
    const bad = (e) => {
      fail(url.hostname, e);
      if (res.headersSent) return res.destroy(); // mid-body: cut it, so the client can't take it as complete
      res.writeHead(502);
      res.end();
    };
    let up;
    try {
      up = httpRequest({ host: url.hostname, port: url.port || 80, path: url.pathname + url.search, method: req.method, headers: req.headers }, (r) => {
        r.on('error', (e) => { fail(url.hostname, e); res.destroy(); });
        res.writeHead(r.statusCode, r.headers);
        r.pipe(res);
      });
    } catch (e) { return bad(e); }
    let gone = false; // the client left first: the upstream error that follows is ours
    res.on('close', () => { if (!res.writableFinished) { gone = true; up.destroy(); } });
    up.on('error', (e) => { if (!gone) bad(e); });
    req.pipe(up);
  });
  server.on('connect', (req, sock, head) => {
    const [host, p] = req.url.split(':');
    const add = guard(host);
    add(sock); // first: a refused client can reset too
    if (!allowed(rules, host)) {
      note('BLOCK', host);
      sock.end('HTTP/1.1 403 Forbidden\r\ncontent-type: text/plain\r\n\r\nhauptling egress: host not on the allowlist\n');
      return;
    }
    let up;
    try { up = connect(Number(p) || 443, host); } catch (e) { fail(host, e); return sock.destroy(); } // port out of range
    add(up).once('connect', () => {
      sock.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head?.length) up.write(head);
      up.pipe(sock); sock.pipe(up);
    });
  });
  server.on('clientError', (e, sock) => {
    fail('client', e);
    if (sock.writable && e.code !== 'ECONNRESET') sock.end('HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n');
    else sock.destroy();
  });
  server.listen(port, '0.0.0.0');

  let relayServer = null;
  if (relay) {
    const [rh, rp] = relay.split(':');
    relayServer = createTcpServer((sock) => {
      const add = guard('relay');
      add(sock);
      const up = add(connect(Number(rp), rh));
      sock.pipe(up); up.pipe(sock);
    }).listen(relayPort, '0.0.0.0');
  }
  return { server, relayServer };
}

/** Last resort for the proxy process: log and keep serving. A failed listen still exits, so Docker restarts it. */
export function keepServing(proc = process) {
  proc.on('uncaughtException', (e) => {
    console.error(`egress: uncaught ${e?.stack || e}`);
    if (e?.syscall === 'listen') proc.exit(1);
  });
}
