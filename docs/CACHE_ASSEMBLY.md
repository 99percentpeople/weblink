# IndexedDB file caching and migration

File transfers use `VfsChunkCache` for both directories and IndexedDB. The
IndexedDB volume stores logical file nodes and sparse 256 KiB pages in
`weblink-vfs-v1`. File metadata and committed chunk hashes live in `files` and
`checkpoints`; file contents live in `nodes` and `pages`.

## Receiving and completing files

Reserving a file records its logical size without writing zero-filled pages.
Only committed chunk checkpoints count toward progress and missing-range
requests. Pending writes are bounded and snapshotted, including duplicate and
out-of-order chunks. Checkpoints advance after the page transaction completes.

Completion reconstructs a File from committed pages for consumers. It does not
write a second whole-file copy into IndexedDB or run the retired assembly worker.
The P2P protocol, transfer IDs and missing-range contract are unchanged. See
[FILE_STORAGE.md](FILE_STORAGE.md) for directory storage and content verification.

## Automatic migration

Before the file library opens, storage initialization discovers old `file-*`
databases and migrates them into the IndexedDB VFS, regardless of the default
mount selected for new files. The old runtime cache and assembly worker are
removed; only the migration reader understands their format.

Each file retains its storage ID, filename, metadata and committed chunk indices.
Chat attachments, shared references and library content records therefore keep
using the same IDs. Completed Blob/File payloads and partial caches containing
Blob or ArrayBuffer chunks are supported, including holes and short final chunks.

The migration proceeds per database:

1. Upgrade the old database and rename its stores within the version transaction.
   This waits for old connections to close and prevents old clients from writing
   through their retired store names after verification. Interrupted migrations
   recognize the renamed stores on the next startup; source bytes remain intact.
2. Copy into unpublished VFS pages with bounded 4 MiB buffers. An old ArrayBuffer
   chunk still requires reading its full IndexedDB record. A partial file reserves
   its logical size but copies only committed chunks.
3. Read back the destination and compare BLAKE3 digests. Completed files also
   check their existing fingerprint when present. Validate chunk lengths, resume
   checkpoints, file length and destination revision.
4. Publish metadata and checkpoints in one transaction, checking the verified
   node's revision again. The file becomes visible only after transaction commit.
5. Close the source and delete its database. Count success only when deletion
   completes, including when another connection initially blocks it.

Copy, checksum or publication failures preserve the old database and discard
unpublished staging data. A retry after publication verifies and reuses the new
copy, retaining any additional chunks received since publication. Unrelated
files with a colliding storage ID are never overwritten. Abandoned staging pages
are reclaimed without deleting published files.

An app-level toast shows the current filename, copy/verification progress and
file counts. Blocked connections prompt the user to close other Weblink pages.
Failures retain error details and retry automatically on the next startup.
Closing the file cache dialog does not affect migration. Migration temporarily
needs space for both the old data and its new copy; a quota failure preserves
original data. IndexedDB transaction completion is the storage success boundary,
not a guarantee against every possible operating-system or hardware failure.

## Checks and benchmark

`test:e2e:cache` exercises actual IndexedDB transactions, source sealing, blocked
connections, rollback, readback and retry in Chromium. Focused unit tests inject
quota errors, corruption, interruption and destination conflicts. The transfer
smoke harness uses VFS caches behind real WebRTC transfers.

`bench:browser:cache` measures chunk writes, file reconstruction and committed
readback separately, excluding WebRTC and checksum verification from timing.
It checks exported bytes against an independently computed SHA-256 and reports
remaining resume checkpoints, which VFS intentionally retains. It does not
measure migration or predict timings on other browsers and devices. Commands
and test boundaries are in [TESTING.md](TESTING.md).
