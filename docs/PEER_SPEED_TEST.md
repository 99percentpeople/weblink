# Peer connection speed test

The client-information dialog's Speed test tab diagnoses the **current WebRTC
connection**, not general Internet bandwidth. Both peers must support the
`weblink-speedtest-v1` DataChannel protocol, and the receiving peer must consent
before test payloads are sent. No test file or IndexedDB cache entry is created.

## Ownership and lifecycle

- `src/libs/domain/speed-test-protocol.ts` defines messages, validation and limits.
- `src/libs/domain/speed-test.ts` implements the bounded two-direction exchange.
- `src/libs/application/speed-test-service.ts` owns one active diagnostic at a time.
  It receives the peer connection, busy policy, consent callback and state sink
  through injection.
- `AppStateProvider` owns the service. Closing the dialog, changing its target or
  unmounting a view does not cancel the operation. Results remain available through
  the application task service's bounded history.
- Stop, room departure, application disposal and connection loss cancel the run.
  Cleanup closes only the temporary diagnostic channel, not chat/file channels or
  the peer connection. Incoming diagnostics are rejected while the service is busy.

## Protocol and limits

Both directions use one temporary reliable, ordered DataChannel, sequentially:
initiator upload first, then download. Wire directions are relative to the
initiator; UI results are normalized to local upload/download on each peer.

| Limit                         | Default / maximum                                       |
| ----------------------------- | ------------------------------------------------------- |
| Payload per direction         | 64 MiB                                                  |
| Sender duration per direction | 10 seconds                                              |
| Payload block                 | Up to 32 KiB, also bounded by SCTP maximum message size |
| Send buffer high / low water  | 256 KiB / 64 KiB                                        |
| Consent wait                  | 20 seconds                                              |
| Handshake                     | 5 seconds                                               |
| Phase timeout                 | 15 seconds                                              |
| Total run timeout             | 60 seconds                                              |

A direction stops when its payload cap or sending-duration limit is reached;
completion still waits for the receiver's matching receipt. The payload budget is
at most **128 MiB for both directions together**, excluding control messages and
network/protocol overhead. These defaults are defined in the protocol module, not
in the UI. Non-supporting peers time out without falling back to file transfers.

## Portable wire sequence

The DataChannel protocol string is versioned as `weblink-speedtest-v1`. The
channel must be reliable and ordered: `ordered === true`,
`maxRetransmits === null` and `maxPacketLifeTime === null`. A future
incompatible diagnostic format must use a different protocol string.

Control frames are JSON strings and are encoded/parsed by
`encodeSpeedTestMessage()` / `parseSpeedTestMessage()` in
`domain/speed-test-protocol.ts`. Binary DataChannel messages are raw test
payload bytes; they do not contain a packet header.

Initial consent handshake:

```text
initiator -> receiver  { type: "hello", durationMs, maxBytes }
receiver  -> initiator { type: "offer" }
receiver performs local user approval
receiver  -> initiator { type: "ready" }
```

The receiver may instead send:

```json
{ "type": "reject", "reason": "busy" }
{ "type": "reject", "reason": "declined" }
```

Each measured direction then uses this ordered sequence:

```text
sender   -> receiver { type: "start", direction }
receiver -> sender   { type: "go", direction }
sender   -> receiver { type: "begin", direction }
sender   -> receiver binary payload messages...
sender   -> receiver { type: "end", direction, bytes }
receiver -> sender   { type: "receipt", direction, bytes, durationMs }
```

Directions are always named relative to the original initiator:

- `upload`: initiator sends payload, receiver measures.
- `download`: receiver sends payload, initiator measures.

The receiver starts its monotonic timer only after the matching `begin`, counts
only binary messages received before `end`, and requires the accumulated byte
count to exactly match `end.bytes`. The sender accepts a result only when the
matching receipt carries the same byte count.

A compatible non-Web client should therefore:

1. Open one temporary reliable ordered channel with protocol
   `weblink-speedtest-v1`.
2. Enforce the limits advertised by `hello` within the protocol maximums.
3. Require local approval before sending `ready`.
4. Keep JSON control frames and binary payload messages distinct.
5. Preserve message ordering; the protocol relies on `end` arriving after all
   preceding payload messages.
6. Measure with a local monotonic clock; synchronized peer clocks are not needed.
7. Validate direction, byte counts and receipt timing before accepting a result.
8. Close only the temporary diagnostic channel on completion/cancellation.

Unlike file transfer, speed-test payload bytes are intentionally random and are
not compressed, persisted or resumable.

## What is measured

The receiver counts binary payload bytes and measures the interval between the
ordered `begin` and `end` markers using its monotonic clock. A receipt includes
that byte count and elapsed duration; the sender validates the matching direction
and count before accepting a result. No synchronized clocks are required.

Final throughput is `receivedBytes * 1000 / durationMs`. The UI displays Mbps
(decimal megabits per second) and MiB/s (binary mebibytes per second). Live dial
values are progress estimates and must not be treated as acknowledged final rates.

This is application-level throughput on the selected ICE path, which may use TURN.
It includes browser scheduling, DataChannel delivery and network contention, but
not file compression, disk writes or IndexedDB finalization. Small or short runs,
background tabs, device throttling and other traffic can distort results. A
loopback smoke-test result is not a public-network bandwidth benchmark.

## Testing

Speed-test unit/integration coverage, task UI integration and the real-Chromium
diagnostic smoke path are documented in [TESTING.md](TESTING.md).

The browser smoke uses loopback peer connections and an isolated Chromium
profile. Real-device, real-network and background/suspension checks remain
necessary before making claims about cross-browser behavior or user-network
throughput.
