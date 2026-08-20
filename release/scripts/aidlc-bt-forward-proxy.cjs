const fs = require('fs');
const net = require('net');
const tls = require('tls');
const path = require('path');
const { URL } = require('url');

const LISTEN_HOST = '127.0.0.1';
const LISTEN_PORT = Number(process.env.AIDLC_BT_PROXY_PORT || 3129);
const TARGET_HOSTNAMES = new Set(['aidlc-bt.demotoday.net', 'bt84-arr.demotoday.net']);
const ROOT_DIR = path.resolve(__dirname, '..');
const PORT_FILE = path.join(ROOT_DIR, '.tmp', 'betime-local-port.txt');
const PFX_FILE = process.env.AIDLC_BT_PROXY_PFX || path.join(ROOT_DIR, '.tmp', 'aidlc-bt-local-https.pfx');
const PFX_PASSPHRASE = process.env.AIDLC_BT_PROXY_PFX_PASSPHRASE || 'betime-local-proxy';

function loadSecureContext() {
  try {
    if (!fs.existsSync(PFX_FILE)) return null;
    return tls.createSecureContext({
      pfx: fs.readFileSync(PFX_FILE),
      passphrase: PFX_PASSPHRASE,
    });
  } catch (err) {
    console.error(`AIDLC BT proxy TLS disabled: ${err.message}`);
    return null;
  }
}

function getLocalPort() {
  try {
    const raw = fs.readFileSync(PORT_FILE, 'utf8').trim();
    const port = Number(raw);
    if (Number.isInteger(port) && port > 0 && port < 65536) return port;
  } catch {}
  return 9302;
}

function parseHeaderBlock(headerText) {
  const lines = headerText.split('\r\n');
  const [method = 'GET', rawTarget = '/', version = 'HTTP/1.1'] = lines[0].split(' ');
  const headers = {};
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line) continue;
    const idx = line.indexOf(':');
    if (idx <= 0) continue;
    const name = line.slice(0, idx).trim().toLowerCase();
    const value = line.slice(idx + 1).trim();
    headers[name] = value;
  }
  return { method, rawTarget, version, headers };
}

function resolveTarget(method, rawTarget, headers) {
  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
  } catch {
    const host = String(headers.host || '').trim();
    targetUrl = new URL(`http://${host}${rawTarget}`);
  }

  if (!TARGET_HOSTNAMES.has(targetUrl.hostname)) {
    return {
      targetHost: targetUrl.hostname,
      targetPort: Number(targetUrl.port || 80),
      requestTarget: targetUrl.pathname + targetUrl.search,
      hostHeader: targetUrl.host || targetUrl.hostname,
    };
  }

  const localPort = getLocalPort();
  const pathname = targetUrl.pathname || '/';
  return {
    targetHost: '127.0.0.1',
    targetPort: localPort,
    requestTarget: pathname + targetUrl.search,
    hostHeader: `127.0.0.1:${localPort}`,
  };
}

const server = net.createServer((clientSocket) => {
  clientSocket.setNoDelay(true);
  clientSocket.on('error', () => {});

  let buffered = Buffer.alloc(0);
  let upstreamSocket = null;
  let forwarded = false;

  function fail(socket, statusLine) {
    try {
      socket.end(`HTTP/1.1 ${statusLine}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    } catch {}
  }

  function connectUpstream(downstreamSocket, targetHost, targetPort, payload) {
    upstreamSocket = net.connect(targetPort, targetHost, () => {
      upstreamSocket.setNoDelay(true);
      upstreamSocket.on('error', () => {
        try { downstreamSocket.destroy(); } catch {}
      });
      downstreamSocket.on('error', () => {
        try { upstreamSocket.destroy(); } catch {}
      });
      upstreamSocket.on('data', (chunk) => {
        try { downstreamSocket.write(chunk); } catch {}
      });
      downstreamSocket.on('data', (chunk) => {
        try { upstreamSocket.write(chunk); } catch {}
      });
      downstreamSocket.on('close', () => {
        try { upstreamSocket.end(); } catch {}
      });
      upstreamSocket.on('close', () => {
        try { downstreamSocket.end(); } catch {}
      });
      if (payload && payload.length) upstreamSocket.write(payload);
    });
    upstreamSocket.on('error', () => fail(downstreamSocket, '502 Bad Gateway'));
  }

  function handleHttpSocket(socket, chunk) {
    if (forwarded) return;
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf('\r\n\r\n');
    if (headerEnd === -1) return;

    forwarded = true;
    const headerText = buffered.slice(0, headerEnd).toString('utf8');
    const body = buffered.slice(headerEnd + 4);
    const { method, rawTarget, version, headers } = parseHeaderBlock(headerText);

    if (method.toUpperCase() === 'CONNECT') {
      const [connectHost, connectPortRaw] = String(rawTarget || '').split(':');
      const connectPort = Number(connectPortRaw || 443);
      const tunnelHost = TARGET_HOSTNAMES.has(connectHost) ? '127.0.0.1' : connectHost;
      const tunnelPort = TARGET_HOSTNAMES.has(connectHost) ? getLocalPort() : connectPort;
      const secureContext = TARGET_HOSTNAMES.has(connectHost) ? loadSecureContext() : null;
      if (secureContext) {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        buffered = Buffer.alloc(0);
        forwarded = false;
        const tlsSocket = new tls.TLSSocket(clientSocket, {
          isServer: true,
          secureContext,
        });
        tlsSocket.setNoDelay(true);
        tlsSocket.on('data', (tlsChunk) => handleHttpSocket(tlsSocket, tlsChunk));
        tlsSocket.on('error', () => {
          try { clientSocket.destroy(); } catch {}
        });
        return;
      }
      const tunnel = net.connect(tunnelPort, tunnelHost, () => {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (body.length) tunnel.write(body);
        clientSocket.pipe(tunnel);
        tunnel.pipe(clientSocket);
      });
      tunnel.on('error', () => fail(clientSocket, '502 Bad Gateway'));
      return;
    }

    const target = resolveTarget(method, rawTarget, headers);
    const requestLine = `${method} ${target.requestTarget || '/'} ${version}`;
    const headerLines = [];
    const rewritten = { ...headers, host: target.hostHeader };
    delete rewritten['proxy-connection'];
    delete rewritten.connection;
    delete rewritten['content-length'];

    if (body.length) {
      rewritten['content-length'] = String(body.length);
    }

    for (const [name, value] of Object.entries(rewritten)) {
      headerLines.push(`${name.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-')}: ${value}`);
    }

    const payload = Buffer.concat([
      Buffer.from(`${requestLine}\r\n${headerLines.join('\r\n')}\r\n\r\n`, 'utf8'),
      body,
    ]);

    connectUpstream(socket, target.targetHost, target.targetPort, payload);
  }

  clientSocket.on('data', (chunk) => handleHttpSocket(clientSocket, chunk));
});

server.on('error', (err) => {
  console.error(`AIDLC BT proxy error: ${err.message}`);
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`AIDLC BT proxy listening on http://${LISTEN_HOST}:${LISTEN_PORT}`);
});
