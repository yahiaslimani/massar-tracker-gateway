// Teltonika AVL data over TCP: Codec 8 and Codec 8 Extended (FMB/FMC trackers).
// Spec: https://wiki.teltonika-gps.com/view/Teltonika_Data_Sending_Protocols
//
// A session is: the tracker sends its IMEI (2-byte length 0x000F + 15 ASCII digits), the server answers 0x01;
// then the tracker sends data packets:
//   4 bytes 0 | 4 bytes data length | data | 4 bytes CRC-16/IBM of the data
//   data = codec id | record count | records | record count
// and the server answers each packet with the number of records it accepted (4 bytes, big endian).
// The tracker keeps resending records until they are acknowledged, so a record is acknowledged only
// once it is safe on our side.

const CODEC_8 = 0x08;
const CODEC_8E = 0x8e;

function crc16(buf) {
  let crc = 0;
  for (const byte of buf) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
  }
  return crc & 0xffff;
}

/** The IMEI packet at the start of a connection, or null when `buf` doesn't begin with one. */
function parseImei(buf) {
  if (buf.length < 2) return { needMore: true };
  const length = buf.readUInt16BE(0);
  if (length !== 15) return null;
  if (buf.length < 2 + length) return { needMore: true };
  const imei = buf.subarray(2, 2 + length).toString('ascii');
  return /^\d{15}$/.test(imei) ? { imei, used: 2 + length } : null;
}

class Reader {
  constructor(buf, offset = 0) {
    this.buf = buf;
    this.o = offset;
  }
  u8() { return this.buf[this.o++]; }
  u16() { const v = this.buf.readUInt16BE(this.o); this.o += 2; return v; }
  i16() { const v = this.buf.readInt16BE(this.o); this.o += 2; return v; }
  u32() { const v = this.buf.readUInt32BE(this.o); this.o += 4; return v; }
  i32() { const v = this.buf.readInt32BE(this.o); this.o += 4; return v; }
  u64() { const v = this.buf.readBigUInt64BE(this.o); this.o += 8; return v; }
  bytes(n) { const v = this.buf.subarray(this.o, this.o + n); this.o += n; return v; }
}

function readValue(r, size) {
  if (size === 1) return r.u8();
  if (size === 2) return r.u16();
  if (size === 4) return r.u32();
  return r.bytes(size).toString('hex'); // 8 bytes and variable-length values
}

function parseRecord(r, extended) {
  const ts = Number(r.u64());
  const priority = r.u8();
  const lon = r.i32() / 1e7;
  const lat = r.i32() / 1e7;
  const altitude = r.i16();
  const angle = r.u16();
  const satellites = r.u8();
  const speed = r.u16(); // km/h
  const idSize = extended ? 2 : 1;
  const read = extended ? () => r.u16() : () => r.u8();
  const eventId = read();
  read(); // total IO count
  const io = {};
  for (const size of [1, 2, 4, 8]) {
    const n = read();
    for (let i = 0; i < n; i++) {
      const id = idSize === 2 ? r.u16() : r.u8();
      io[id] = readValue(r, size);
    }
  }
  if (extended) {
    const n = r.u16();
    for (let i = 0; i < n; i++) {
      const id = r.u16();
      io[id] = readValue(r, r.u16());
    }
  }
  // Without a GNSS fix trackers report 0,0 and no satellites.
  const valid = satellites > 0 && !(lat === 0 && lon === 0);
  return { ts, priority, lat, lon, altitude, angle, satellites, speed, valid, eventId, io };
}

/**
 * Reads one data packet from the start of `buf`.
 * Returns {needMore: true} while it is incomplete, {error} when it is broken (the connection should
 * be dropped), or {records, used, codec} with the number of bytes consumed.
 */
function parsePacket(buf) {
  if (buf.length < 8) return { needMore: true };
  if (buf.readUInt32BE(0) !== 0) return { error: 'bad preamble' };
  const length = buf.readUInt32BE(4);
  if (length < 3 || length > 1 << 20) return { error: 'bad length' };
  const total = 8 + length + 4;
  if (buf.length < total) return { needMore: true };
  const data = buf.subarray(8, 8 + length);
  const crc = buf.readUInt32BE(8 + length);
  if (crc !== crc16(data)) return { error: 'bad crc', used: total };
  const codec = data[0];
  if (codec !== CODEC_8 && codec !== CODEC_8E) return { error: `unsupported codec 0x${codec.toString(16)}`, used: total };
  const count = data[1];
  if (data[length - 1] !== count) return { error: 'record counts differ', used: total };
  try {
    const r = new Reader(data, 2);
    const records = [];
    for (let i = 0; i < count; i++) records.push(parseRecord(r, codec === CODEC_8E));
    if (r.o !== length - 1) return { error: 'trailing bytes', used: total };
    return { records, used: total, codec };
  } catch (e) {
    return { error: 'truncated record', used: total };
  }
}

// --- Encoding: used by the simulator and the tests ---

function encodeImei(imei) {
  const b = Buffer.alloc(2 + imei.length);
  b.writeUInt16BE(imei.length, 0);
  b.write(imei, 2, 'ascii');
  return b;
}

/** A Codec 8 packet with records {ts, lat, lon, altitude, angle, satellites, speed} and no IO elements. */
function encodePacket(records) {
  const parts = [Buffer.from([CODEC_8, records.length])];
  for (const rec of records) {
    const b = Buffer.alloc(8 + 1 + 4 + 4 + 2 + 2 + 1 + 2 + 1 + 1 + 4);
    let o = 0;
    b.writeBigUInt64BE(BigInt(rec.ts), o); o += 8;
    b[o++] = rec.priority ?? 0;
    b.writeInt32BE(Math.round(rec.lon * 1e7), o); o += 4;
    b.writeInt32BE(Math.round(rec.lat * 1e7), o); o += 4;
    b.writeInt16BE(rec.altitude ?? 0, o); o += 2;
    b.writeUInt16BE(rec.angle ?? 0, o); o += 2;
    b[o++] = rec.satellites ?? 8;
    b.writeUInt16BE(rec.speed ?? 0, o); o += 2;
    b[o++] = 0; // event IO id
    b[o++] = 0; // total IO count
    b[o++] = 0; b[o++] = 0; b[o++] = 0; b[o++] = 0; // N1, N2, N4, N8
    parts.push(b);
  }
  parts.push(Buffer.from([records.length]));
  const data = Buffer.concat(parts);
  const head = Buffer.alloc(8);
  head.writeUInt32BE(data.length, 4);
  const tail = Buffer.alloc(4);
  tail.writeUInt32BE(crc16(data), 0);
  return Buffer.concat([head, data, tail]);
}

function ack(count) {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(count, 0);
  return b;
}

module.exports = { crc16, parseImei, parsePacket, encodeImei, encodePacket, ack };
