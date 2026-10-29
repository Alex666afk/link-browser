// Link VPN speed-up, run in its own utility process so page traffic never waits on Link's main
// process. Chromium speaks SOCKS5 to this relay, which passes each connection on to Tor.
//
// Tor Browser's trick ("optimistic data"): a normal SOCKS client waits for Tor to say the site is
// connected before sending anything, which costs a full trip through the Tor network (~0.4 s) on
// every new connection. The relay says "connected" as soon as Tor has the request and sends the
// page's first bytes right behind it; Tor carries them to the exit together with the connect.
// Tor's own reply is then removed from the stream. If the site can't be reached, the connection
// simply closes.
//
// It also holds connections while Tor is still starting, so pages wait instead of failing.
const net = require('net');

let torPort = 0;
const WAIT_FOR_TOR = 25000; // Chromium gives up on a SOCKS handshake after 30 s

const OK_REPLY = Buffer.from([5, 0, 0, 1, 0, 0, 0, 0, 0, 0]);

// Reads exactly what the SOCKS handshake needs from a socket, keeping any extra bytes.
function reader(sock) {
  let buf = Buffer.alloc(0);
  let want = null;
  const onData = (d) => { buf = Buffer.concat([buf, d]); check(); };
  const check = () => {
    if (!want) return;
    const n = want.size(buf);
    if (n === null || buf.length < n) return;
    const { resolve } = want;
    want = null;
    const out = buf.subarray(0, n);
    buf = buf.subarray(n);
    resolve(out);
  };
  sock.on('data', onData);
  return {
    // size(buf) returns how many bytes the next message needs, or null if it can't tell yet.
    read: (size) => new Promise((resolve) => { want = { size, resolve }; check(); }),
    done: () => { sock.off('data', onData); const rest = buf; buf = Buffer.alloc(0); return rest; },
  };
}

// Size of a SOCKS5 request (client) or reply (Tor): 4 header bytes, an address, 2 port bytes.
const addrSize = (b) => {
  if (b.length < 5) return null;
  if (b[3] === 1) return 4 + 4 + 2;
  if (b[3] === 4) return 4 + 16 + 2;
  if (b[3] === 3) return 4 + 1 + b[4] + 2;
  return 4; // unknown type: let the caller reject it
};

function connectToTor(deadline) {
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const up = net.connect(torPort, '127.0.0.1');
      up.once('connect', () => { up.removeAllListeners('error'); up.on('error', () => up.destroy()); resolve(up); });
      up.once('error', (err) => {
        up.destroy();
        if (Date.now() < deadline) setTimeout(attempt, 400);
        else reject(err);
      });
    };
    attempt();
  });
}

async function handle(client) {
  client.setNoDelay(true);
  let up = null;
  const close = () => { client.destroy(); up?.destroy(); };
  client.on('error', close);
  client.on('close', close);
  try {
    const fromClient = reader(client);
    const hello = await fromClient.read((b) => (b.length < 2 ? null : 2 + b[1]));
    if (hello[0] !== 5) return close();
    client.write(Buffer.from([5, 0])); // no password
    const request = await fromClient.read(addrSize);
    if (request[1] !== 1 || ![1, 3, 4].includes(request[3])) { client.end(Buffer.from([5, 7, 0, 1, 0, 0, 0, 0, 0, 0])); return; }

    up = await connectToTor(Date.now() + WAIT_FOR_TOR);
    if (client.destroyed) return close();
    up.setNoDelay(true);
    up.on('error', close);
    up.on('close', close);
    const fromTor = reader(up);
    up.write(Buffer.from([5, 1, 0]));
    const method = await fromTor.read(() => 2);
    if (method[1] !== 0) return close();

    // The optimistic part: the connect request, then the page's bytes straight away.
    up.write(request);
    client.write(OK_REPLY);
    const early = fromClient.done();
    if (early.length) up.write(early);
    client.pipe(up);

    const reply = await fromTor.read(addrSize);
    if (reply[1] !== 0) return close(); // Tor couldn't reach the site
    const rest = fromTor.done();
    if (rest.length) client.write(rest);
    up.pipe(client);
  } catch {
    close();
  }
}

const server = net.createServer(handle);
server.on('error', (err) => process.parentPort.postMessage({ error: err.message }));

process.parentPort.on('message', ({ data }) => {
  if (data.torPort) torPort = data.torPort;
  if (data.listen !== undefined && !server.listening) {
    server.listen(data.listen, '127.0.0.1', () => process.parentPort.postMessage({ port: server.address().port }));
  }
});
