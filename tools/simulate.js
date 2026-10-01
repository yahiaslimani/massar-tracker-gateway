#!/usr/bin/env node
// Pretends to be a Teltonika tracker, to test a deployed gateway the way a real one would use it.
//
//   node tools/simulate.js <host> <port> [--every=60] [--minutes=30] [--text]
//
// Sends the IMEI, then one position every --every seconds for --minutes, and reports each reply.
// If the platform closes the connection (idle timeout, restart), it says when, and reconnects.
// Use --every=720 to check that a 15-minute idle limit is not hit, or --every=1000 to see it hit.
const net = require('net');
const { encodeImei, encodePacket } = require('../src/teltonika');

const args = process.argv.slice(2);
const flag = (name, def) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=')[1] : def;
};
const [host, port] = args.filter((a) => !a.startsWith('--'));
if (!host || !port) {
  console.error('usage: node tools/simulate.js <host> <port> [--every=60] [--minutes=30] [--text]');
  process.exit(1);
}
const every = Number(flag('every', 60));
const minutes = Number(flag('minutes', 30));
const text = args.includes('--text');
const IMEI = '356307042441013'; // a made-up IMEI
const stamp = () => new Date().toTimeString().slice(0, 8);
const say = (msg) => console.log(`${stamp()} ${msg}`);

let socket = null;
let connectedAt = 0;
let sentCount = 0;
let ackCount = 0;
let drops = 0;
let sentAt = 0;
let waitingAck = false;

function connect() {
  say(`connecting to ${host}:${port}…`);
  const t0 = Date.now();
  socket = net.connect({ host, port: Number(port) });
  socket.setNoDelay(true);
  socket.on('connect', () => {
    connectedAt = Date.now();
    say(`connected in ${connectedAt - t0} ms`);
    if (!text) socket.write(encodeImei(IMEI));
  });
  socket.on('data', (d) => {
    if (text) return say(`reply: ${d.toString().trim()}`);
    if (d.length === 1 && d[0] === 1) return say('tracker accepted (0x01)');
    if (d.length === 4 && waitingAck) {
      waitingAck = false;
      ackCount++;
      say(`position acknowledged (${d.readUInt32BE(0)} record), ${Date.now() - sentAt} ms round trip`);
    }
  });
  socket.on('error', (e) => say(`error: ${e.code || e.message}`));
  socket.on('close', () => {
    if (!connectedAt) return setTimeout(connect, 5000);
    drops++;
    say(`CONNECTION CLOSED after ${Math.round((Date.now() - connectedAt) / 1000)} s (drop #${drops}); reconnecting in 5 s`);
    connectedAt = 0;
    socket = null;
    setTimeout(connect, 5000);
  });
}

function sendPosition() {
  if (!socket || !connectedAt) return say('not connected, position kept for later');
  sentAt = Date.now();
  sentCount++;
  if (text) return socket.write(`ping ${sentCount}\n`);
  waitingAck = true;
  // Walks slowly around a point in Cheria; coordinates here are made up.
  const k = sentCount / 100;
  socket.write(encodePacket([{ ts: Date.now(), lat: 35.27 + k / 100, lon: 7.75 + k / 100, speed: 20, satellites: 9 }]));
}

connect();
const timer = setInterval(sendPosition, every * 1000);
setTimeout(() => {
  clearInterval(timer);
  say(`done: ${sentCount} sent, ${ackCount} acknowledged, ${drops} drop(s)`);
  socket?.destroy();
  process.exit(drops ? 2 : 0);
}, minutes * 60_000);
