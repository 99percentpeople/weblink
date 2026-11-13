# Storage and file lifecycle

Weblink separates a file's content from the messages, library entries, and transfer tasks that refer to it. A common storage interface supports browser storage and real directories, while each provider keeps the behavior needed to commit data safely on its platform.

## One interface, different providers {#providers}

`VfsVolume` describes the platform's volume operations. The application-facing storage service exposes files through `ChunkCache`: consumers can read data, commit chunks, query resume ranges, verify content, finalize writes, and release references without interpreting physical paths.

| Provider          | Default or selection                                                                                | Important boundary                                                                                 |
| ----------------- | --------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| IndexedDB         | Default in the browser                                                                              | Bytes and transactional metadata belong to the current site's browser storage                      |
| Browser directory | A directory selected through the browser picker                                                     | Access depends on supported APIs, a secure context, user consent, and sometimes renewed permission |
| Native directory  | Desktop defaults to its local application data `files` directory; other directories can be selected | The desktop platform adapter performs filesystem operations                                        |

Changing the default selects where new content is written. Existing files and active transfers retain their original mount. If a browser directory becomes unavailable, the application does not silently redirect its existing files into another provider.

Identity keys, pairing, permissions, and chat records are separate application data. Selecting a file directory does not move these records into that directory.

## Scanned files and imported content {#catalog}

Mounted directories are scanned recursively. Existing files appear without being copied into a second library, and the catalog reflects their mount, relative path, and revision. Explicitly importing a file creates a content snapshot in the chosen storage location instead.

This distinction matters when an external program changes a file. A scanned source can change or disappear; a stored content reference must not treat an old hash as proof of the new bytes. A failed scan or lost directory permission retains the last known membership instead of treating every inaccessible entry as deleted.

File metadata describes supported actions such as opening or revealing a file. UI code asks the storage service to perform those actions, rather than using native paths directly. A shared-file list exposes permitted metadata through the peer protocol; mounting a directory does not automatically publish its paths or share its files.

## Recoverable partial files {#partial-files}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="Storage commit, recovery, and publication flow" tabindex="0">

![Storage commits payload bytes before chunk checkpoints. Reopening a partial file verifies committed chunk digests and requests missing chunks. All chunks undergo content verification before publication; verification or publication failure retains partial data.](/diagrams/storage-en.svg)

</div>
<figcaption>The left path shows normal completion, and the dashed path shows recovery. Only bytes backed by verified checkpoints count toward resume; preallocated file length does not establish progress.</figcaption>
</figure>

A directory receive starts as an unfinished file such as `report.pdf.part`. Its logical payload is reserved first, and a received chunk is written at `chunkIndex * chunkSize`. A large apparent file size therefore does not prove that its bytes have arrived, nor guarantee that physical disk space has been reserved.

The partial file stores both payload and recovery information:

| Part                           | Purpose                                                                                                                |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------- |
| Payload region                 | Original byte positions, including ranges not yet received                                                             |
| Chunk checkpoint table         | Records committed chunks and their BLAKE3 digests                                                                      |
| Two checksummed metadata slots | Retain transfer metadata and the intended final path, with a previous valid slot available after an interrupted update |
| Checksummed footer             | Identifies the partial-file format and payload/chunk sizes                                                             |

The directory backend does not need a sidecar file or a separate IndexedDB checkpoint row to reconstruct this progress. The IndexedDB provider keeps its own transactional metadata and data within that backend.

Payload writes commit before their checkpoints. After a crash, bytes without a committed checkpoint are requested again. Reopening a partial file checks committed chunk digests against the payload, including legitimate all-zero chunks. Invalid metadata makes the file unavailable instead of turning preallocated space into fictitious progress.

Clearing application metadata does not erase a real directory's bytes or in-file recovery information. The directory still needs to be mounted and authorized again, and resuming a transfer still requires an available source and matching file metadata.

## Finalization is more than renaming {#finalization}

When all chunks are present, the storage service verifies the expected content fingerprint when one was supplied. Only then can it publish complete content and remove the partial-file trailer and temporary name.

Native directories move the file without replacing an existing destination, then truncate the trailer. Browser directories use a streaming copy to the final file, verify the committed copy, and remove the temporary file afterward. During that browser operation, there must be space for both copies. Failed publication retains recoverable partial data.

Filename allocation also protects existing files. If the intended final name is already taken, another unused name is chosen. A different file appearing during a long transfer is not permission to overwrite it.

Whole-content verification results are shared in memory for the same mount, path, and file revision. A restart or an external edit requires verification again. A newly copied destination is checked separately; a persisted or peer-provided fingerprint remains a comparison target, not a cached proof of local integrity.

## References, leases, and deletion {#lifecycle}

The storage lifecycle distinguishes three kinds of operation:

| Operation                  | Meaning                                                                              |
| -------------------------- | ------------------------------------------------------------------------------------ |
| Release a reference        | Stop retaining content on behalf of one attachment, library entry, or operation      |
| Hold an active lease       | Protect content while a transfer or other operation is preparing or using it         |
| Explicitly delete a source | Remove the selected stored file after checking that its source version still matches |

Releasing an attachment, deduplicating content, or running background cleanup must not delete a complete user-owned source file. Paused and failed transfers can retain committed data for recovery. A permission error or failed migration is not authorization to delete data.

Recordings and other generated files use a streaming writer with bounded pending writes. Stopping a producer and publishing its final file are separate steps: the writer must drain data and finish its metadata before the file is complete. A closed settings panel does not define the lifetime of that writer.

Storage migration follows the same ownership principle: copy and verify the destination, commit its metadata, then remove the old source. If migration fails, the old copy remains available for a later retry.

## Implementation entry points {#implementation}

Paths are relative to the repository root:

| Path                                                    | Responsibility                                       |
| ------------------------------------------------------- | ---------------------------------------------------- |
| `packages/platform`                                     | `VfsVolume` and platform filesystem contracts        |
| `apps/web/src/libs/domain/file-storage.ts`              | Application-facing storage contract                  |
| `apps/web/src/libs/infrastructure/vfs/file-storage.ts`  | Providers, mounts, catalog, and file lifecycle       |
| `apps/web/src/libs/infrastructure/vfs/chunk-cache.ts`   | Committed chunks, recovery, and content verification |
| `apps/web/src/libs/application/file-library-service.ts` | Library references and content availability          |

## Choose your next step {#next-steps}

- **Choose a directory or manage stored files:** use the [storage guide](../guide/storage.md).
- **Understand how resume ranges travel between devices:** read [file transfer and resume](file-transfer.md).
- **Follow a recording from media packets to a saved file:** read [media transport and recording](media.md#recording).
