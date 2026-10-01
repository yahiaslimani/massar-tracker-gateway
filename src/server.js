// TCP listener for GPS trackers (Teltonika Codec 8 / 8E).
//
// For now it only answers the trackers and logs what happens to each connection, which is what is
// needed to find out whether a hosting platform keeps long-lived TCP connections open.
// Anything that is not a Teltonika tracker (a TCP test app on a phone, for example) is answered
// line by line in "text mode", so the same deployment can be tried with any TCP client.
const net = require('net');
const { parseImei, parsePacket, ack } = require('./teltonika');

const IDLE_CLOSE_MS = Number(process.env.IDLE_CLOSE_MS || 30 * 60 * 1000);

function defaultLog(event) {
  console.log(JSON.stringify({ t: new Date().toISOString(), ...event }));
}

/**
 * @param {object} [options]
 * @param {(event: object) => void} [options.log] one call per notable event
 * @param {(imei: string, records: object[]) => (boolean|Promise<boolean>)} [options.onRecords]
 *   called with each batch of records; return false to refuse it (the tracker will send it again)
 */
function createServer({ log = defaultLog, onRecords = () => true } = {}) {
  let nextId = 1;
  return net.createServer((socket) => {
    const id = nextId++;
    const startedAt = Date.now();
    let received = 0;
    let sent = 0;
    let imei = null;
    let mode = 'new'; // new | teltonika | text
    let buf = Buffer.alloc(0);
    let queue = Promise.resolve();
    let reason = 'closed';

    socket.setNoDelay(true);
    socket.setKeepAlive(true, 60_000);
    socket.setTimeout(IDLE_CLOSE_MS);
    log({ ev: 'connect', id });

    const write = (data) => { sent += data.length; socket.write(data); };

    async function handle() {
      for (;;) {
        if (mode === 'new') {
          const hello = parseImei(buf);
          if (hello?.needMore) return;
          if (hello) {
            imei = hello.imei;
            mode = 'teltonika';
            buf = buf.subarray(hello.used);
            write(Buffer.from([1])); // accept
            log({ ev: 'tracker', id, imei: '…' + imei.slice(-4) });
            continue;
          }
          mode = 'text';
          log({ ev: 'text-client', id });
        }
        if (mode === 'text') {
          const text = buf.toString('utf8').replace(/\r?\n$/, '');
          buf = Buffer.alloc(0);
          if (text) {
            log({ ev: 'text', id, bytes: text.length });
            write(`ok ${text.length} bytes, connected ${Math.round((Date.now() - startedAt) / 1000)} s\n`);
          }
          return;
        }
        const packet = parsePacket(buf);
        if (packet.needMore) return;
        if (packet.error) {
          log({ ev: 'bad-packet', id, error: packet.error });
          if (!packet.used) { reason = packet.error; socket.destroy(); return; }
          buf = buf.subarray(packet.used);
          write(ack(0)); // refuse: the tracker sends it again
          continue;
        }
        buf = buf.subarray(packet.used);
        const accepted = (await onRecords(imei, packet.records)) !== false;
        const newest = Math.max(...packet.records.map((r) => r.ts));
        log({ ev: 'records', id, n: packet.records.length, valid: packet.records.filter((r) => r.valid).length, newestAgeS: Math.round((Date.now() - newest) / 1000), accepted });
        write(ack(accepted ? packet.records.length : 0));
      }
    }

    socket.on('data', (chunk) => {
      received += chunk.length;
      buf = Buffer.concat([buf, chunk]);
      queue = queue.then(handle).catch((e) => { log({ ev: 'error', id, message: e.message }); socket.destroy(); });
    });
    socket.on('timeout', () => { reason = 'idle-timeout'; socket.destroy(); });
    socket.on('error', (e) => { reason = e.code || 'error'; });
    socket.on('end', () => { reason = 'peer-closed'; });
    socket.on('close', () => {
      log({ ev: 'close', id, reason, secs: Math.round((Date.now() - startedAt) / 1000), received, sent });
    });
  });
}

module.exports = { createServer };

if (require.main === module) {
  const port = Number(process.env.PORT || 5027);
  createServer().listen(port, '0.0.0.0', () => defaultLog({ ev: 'listening', port }));
  process.on('SIGTERM', () => { defaultLog({ ev: 'sigterm' }); process.exit(0); });
}
