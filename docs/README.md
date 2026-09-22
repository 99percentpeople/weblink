# Documentation

Long-lived documentation is organized by responsibility. Temporary validation
notes, refactor checklists and one-off test logs should not be committed under
`docs/`.

## Architecture and development

- [ARCHITECTURE.md](ARCHITECTURE.md) — module boundaries, dependency direction
  and ownership rules.
- [DEPLOYMENT.md](DEPLOYMENT.md) — local setup, build configuration, hosting,
  signaling backends, Docker, ICE and LAN deployment.
- [TESTING.md](TESTING.md) — unit, integration, browser E2E smoke and benchmark
  boundaries plus commands.

## P2P and signaling contracts

- [P2P_PROTOCOL.md](P2P_PROTOCOL.md) — portable control protocol and
  cross-client request/reply semantics.
- [SIGNALING.md](SIGNALING.md) — signaling backends, portable signaling contract,
  reconnect ownership and deployment notes.
- [FILE_TRANSFERS.md](FILE_TRANSFERS.md) — file workflow ownership and portable
  file-channel wire format.
- [PEER_SPEED_TEST.md](PEER_SPEED_TEST.md) — versioned diagnostic channel,
  measurement semantics and interoperability rules.

## Storage

- [CACHE_ASSEMBLY.md](CACHE_ASSEMBLY.md) — IndexedDB chunk storage/finalization
  design and retained historical benchmark findings.

## Documentation policy

Keep durable facts here:

- protocol/wire contracts
- architecture boundaries
- lifecycle/ownership rules
- deployment constraints
- benchmark methodology/results that are still useful for design decisions

Do not keep temporary artifacts here:

- refactor task lists
- ad-hoc test plans
- validation command transcripts
- screenshots or generated reports
- local benchmark output that has not become a documented design finding

Testing commands and boundaries belong in [TESTING.md](TESTING.md); feature
documents should link there rather than duplicating test instructions.
