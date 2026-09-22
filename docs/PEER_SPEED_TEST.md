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

## Verification

Run from the frontend repository with dependencies installed:

```sh
bun run test --run test/speed-test.test.ts test/speed-test-service.test.ts test/peer-speed-test.test.tsx
bun run test:speed
bun run test:tasks
TASK_TEST_WIDTH=390 bun run test:tasks
```

The browser runner requires Chromium on `PATH`, or `CHROMIUM_PATH` pointing to its
executable. It uses local loopback peer connections, an isolated temporary browser
profile and a local Vite server, then cleans them up. It does not contact the
application signaling backend or alter a real browser profile.

- `test:speed` checks both directions, partial blocks, matching receiver receipts,
  consent refusal, cancellation, unsupported peers and an unaffected chat channel.
- `test:tasks` checks service ownership across dialog close/unmount, result reopening,
  task-list Stop and the diagnostic UI. `TASK_TEST_WIDTH` sets the viewport width.
- `SPEED_TEST_REPORT=/absolute/path/report.json` optionally saves the JSON report.

Real-device, real-network and background/suspension checks remain necessary before
making claims about cross-browser behavior or user-network throughput.
