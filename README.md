# Massar tracker gateway

A TCP listener for GPS trackers fixed in buses (Teltonika FMB/FMC, Codec 8 and Codec 8 Extended).
Trackers keep a TCP connection open, which Render can't receive, so this runs on its own host.

Today it **answers trackers correctly and logs every connection**: enough to test a hosting platform.
Forwarding positions to the Massar backend comes next, once the hosting and the tracker model are chosen.

- `src/teltonika.js`: the protocol (IMEI handshake, AVL packets with CRC-16, acknowledgements). A batch is
  acknowledged only when it's accepted; the tracker resends anything not acknowledged, so positions recorded
  without network are delivered later, with their own timestamps.
- `src/server.js`: the listener (`PORT`, default 5027; `IDLE_CLOSE_MS`, default 30 min). Any client that isn't a
  tracker gets a line-by-line text reply, so a phone TCP app can test the deployment too.
- `tools/simulate.js`: pretends to be a tracker against any host.
- `npm test`: protocol tests, including Teltonika's documented example packet.

## Testing a host

```sh
node tools/simulate.js <host> <port> --every=60 --minutes=60     # a position a minute for an hour
node tools/simulate.js <host> <port> --every=840 --minutes=60    # quiet for 14 min between positions
node tools/simulate.js <host> <port> --every=1000 --minutes=40   # longer than a 15-min idle limit
```

It reports the round trip of each acknowledgement and every dropped connection. Exit code 2 means drops.

## Logs

One JSON line per event: `connect`, `tracker` (last 4 IMEI digits only), `records` (count, valid fixes,
age of the newest), `bad-packet`, `close` (reason, duration, bytes). No positions are logged.
