const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const { crc16, parseImei, parsePacket, encodeImei, encodePacket } = require('../src/teltonika');
const { createServer } = require('../src/server');

// The Codec 8 example from Teltonika's documentation (one record with IO elements).
const EXAMPLE =
  '000000000000003608010000016B40D8EA30010000000000000000000000000000000105021503010101425E0F01F10000601A014E0000000000000000010000C7CF';

test('crc16 matches the documentation example', () => {
  const packet = Buffer.from(EXAMPLE, 'hex');
  assert.equal(crc16(packet.subarray(8, packet.length - 4)), 0xc7cf);
});

test('parses the documentation example', () => {
  const packet = Buffer.from(EXAMPLE, 'hex');
  const result = parsePacket(packet);
  assert.equal(result.error, undefined);
  assert.equal(result.used, packet.length);
  assert.equal(result.records.length, 1);
  const [rec] = result.records;
  assert.equal(rec.ts, 0x16b40d8ea30);
  assert.equal(rec.valid, false); // no GNSS fix in the example
  assert.deepEqual([rec.io[0x15], rec.io[0x01], rec.io[0x42], rec.io[0xf1]], [3, 1, 0x5e0f, 0x601a]);
  assert.equal(rec.io[0x4e], '0000000000000000');
});

test('waits for the rest of a packet and rejects damage', () => {
  const packet = Buffer.from(EXAMPLE, 'hex');
  assert.equal(parsePacket(packet.subarray(0, 20)).needMore, true);
  const damaged = Buffer.from(packet);
  damaged[20] ^= 0xff;
  assert.equal(parsePacket(damaged).error, 'bad crc');
});

test('encoded packets round-trip', () => {
  const rec = { ts: 1_700_000_000_000, lat: 35.27123, lon: 7.75456, altitude: 900, angle: 90, satellites: 9, speed: 31 };
  assert.equal(parsePacket(encodePacket([rec])).records.length, 1);
  const result = parsePacket(encodePacket([rec, { ...rec, speed: 0 }]));
  assert.equal(result.error, undefined);
  assert.equal(result.records.length, 2);
  assert.equal(result.records[0].lat, 35.27123);
  assert.equal(result.records[0].lon, 7.75456);
  assert.equal(result.records[0].speed, 31);
  assert.equal(result.records[0].valid, true);
  assert.equal(result.records[1].speed, 0);
});

test('reads an IMEI, and refuses other starts', () => {
  assert.equal(parseImei(encodeImei('356307042441013')).imei, '356307042441013');
  assert.equal(parseImei(Buffer.from('hello there!')), null);
  assert.equal(parseImei(Buffer.from([0, 15, 0x33])).needMore, true);
});

function talk(port, steps) {
  return new Promise((resolve, reject) => {
    const replies = [];
    const socket = net.connect(port, '127.0.0.1');
    let i = 0;
    const next = () => {
      if (i >= steps.length) return socket.end();
      socket.write(steps[i++]);
    };
    socket.on('connect', next);
    socket.on('data', (d) => { replies.push(d); next(); });
    socket.on('close', () => resolve(replies));
    socket.on('error', reject);
  });
}

async function withServer(options, fn) {
  const events = [];
  const server = createServer({ log: (e) => events.push(e), ...options });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(server.address().port, events); } finally { server.close(); }
}

test('a tracker is accepted and each batch is acknowledged', () =>
  withServer({}, async (port, events) => {
    const rec = { ts: Date.now() - 5000, lat: 35.27, lon: 7.75, speed: 20 };
    const replies = await talk(port, [encodeImei('356307042441013'), encodePacket([rec, rec, rec]), encodePacket([rec])]);
    assert.deepEqual(replies.map((b) => b.toString('hex')), ['01', '00000003', '00000001']);
    const batches = events.filter((e) => e.ev === 'records');
    assert.deepEqual(batches.map((e) => e.n), [3, 1]);
    assert.ok(batches[0].newestAgeS >= 4);
    assert.ok(events.some((e) => e.ev === 'close' && e.reason === 'peer-closed'));
  }));

test('a refused batch is acknowledged with 0 so the tracker resends it', () =>
  withServer({ onRecords: () => false }, async (port) => {
    const rec = { ts: Date.now(), lat: 35.27, lon: 7.75 };
    const replies = await talk(port, [encodeImei('356307042441013'), encodePacket([rec])]);
    assert.equal(replies[1].toString('hex'), '00000000');
  }));

test('a damaged packet is refused, then the tracker carries on', () =>
  withServer({}, async (port) => {
    const rec = { ts: Date.now(), lat: 35.27, lon: 7.75 };
    const bad = encodePacket([rec]);
    bad[12] ^= 0xff;
    const replies = await talk(port, [encodeImei('356307042441013'), bad, encodePacket([rec])]);
    assert.deepEqual(replies.map((b) => b.toString('hex')), ['01', '00000000', '00000001']);
  }));

test('a plain TCP client gets a text answer', () =>
  withServer({}, async (port, events) => {
    const replies = await talk(port, ['hello\n', 'again\n']);
    assert.match(replies[0].toString(), /^ok 5 bytes/);
    assert.match(replies[1].toString(), /^ok 5 bytes/);
    assert.ok(events.some((e) => e.ev === 'text-client'));
  }));
