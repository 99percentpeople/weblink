# Local file storage

Weblink mounts storage through the `VfsVolume` contract in `packages/platform`.
The web application supplies IndexedDB and browser-directory providers. Desktop
supplies the native provider through `PlatformRuntime.filesystem`; Tauri imports
and host paths remain in `apps/desktop`.

## Business-facing storage contract

`libs/domain/file-storage.ts` defines the storage service contract. Its concrete
implementation lives in `libs/infrastructure/vfs/file-storage.ts`; the former
application import is a compatibility entry point. File and transfer consumers
use `ChunkCache` for creation, committed chunks, resume ranges, verification,
completion and cleanup. They do not decode storage IDs or resolve physical paths.

The service's `list()` and `synchronize()` combine every provider into one catalog.
Synchronization returns the current IDs and confirmed removals. Both committed
IndexedDB bytes and metadata publication/deletion invalidate this catalog across
connections. Directory providers retain their last membership when a scan fails;
their entries and partial checkpoints are still reconstructed from files, without
a separate persistent directory index.

Releasing a reference and explicitly deleting a source remain distinct lifecycle
operations. The storage implementation preserves user-owned complete files on
release, while explicit deletion validates the selected source version. Confirmed
absence releases local library pins; chat/shared references keep their content
identity. Permission loss and failed legacy migration never authorize cleanup.

File metadata exposes `capabilities` (save mode, inline-save presentation, reveal)
and the actual mount ID. References obtain these from their backing cache,
independently of the current default. UI actions use these capabilities and invoke
`cache.reveal()` without receiving filesystem handles or paths. Open/preview
continues through the shared platform-aware file opener. Storage settings alone
select and configure concrete providers. Mounts advertise `canOpen`; opening a
root uses `storage.openDirectory(id)` through the same service.

## Defaults and existing files

- Web defaults to browser storage. In Settings → Transfer → File storage, a
  browser with `showDirectoryPicker` can mount a directory and select it for new
  files. The picker requires a secure context and a user gesture.
- Desktop defaults to `app_local_data_dir()/files`. It can also mount directories
  selected through the native picker.
- Settings select the storage method separately from its directory. IndexedDB
  hides directory controls. Local-directory mode shows the current location as
  read-only text and changes it through the directory picker. Opening it on desktop
  uses the system file manager with a registered mount ID; on the web it opens the
  file cache. Only browser directories that are unavailable show a reconnect action.
- Directory files are saved directly under the mounted root using their original
  filename. Existing names are preserved; collisions use `name (1).ext`, `name (2).ext`,
  and so on. Unfinished receives use `name.ext.part` until completion; listings
  and transfer metadata retain the original filename. App writers serialize name
  allocation and finalization per mount, reserving both the temporary and final
  names and checking for new collisions again when completing the file.
- Only browser-mounted directories encode a filename rejected with `Name is not
allowed`: `name.ext.weblink`. Ordinary accepted names stay unchanged. Listings,
  downloads and transfer metadata expose the original name. `.weblink` is reserved
  as a storage suffix in these directories: scans remove exactly one suffix,
  including for externally added files. Imported names already ending in this
  suffix are escaped with another `.weblink`, preserving the original name on
  reload without a file index. Native directories and IndexedDB do not encode or
  decode these names.
- Changing the default selects the destination for new objects and the storage
  shown in the file cache. The open cache list follows the selected mount and
  clears selections from the previous mount. Active transfers, library aliases,
  and existing files retain their storage mount.
- Previous production per-file IndexedDB databases automatically migrate to the
  unified IndexedDB VFS on startup, preserving IDs and committed resume chunks.
  An app-level toast shows migration and verification progress. Each old database
  is deleted only after the new copy passes readback verification and its metadata
  commits. Failed files retain their old databases for retry on the next startup.
  See [CACHE_ASSEMBLY.md](CACHE_ASSEMBLY.md) for recovery and concurrency rules.
  Intermediate development VFS directory indexes and formats are not migrated.
- Real directories have no persistent file list or separate checkpoint records.
  Application settings, directory handles, chat references, content fingerprints
  and explicit sharing permissions remain application metadata. Clearing that
  metadata does not erase directory bytes or their in-file resume information;
  browser directories need to be mounted/authorized again.

Mounted real directories are scanned recursively on startup and after change
notifications. Existing and externally added files appear in the file cache
automatically, without copying their bytes into another directory. Edits and
renames replace the directory entry's version; deletions remove its local pin.
Unchanged entries retain their IDs across reloads without an on-disk index. The
cache listing is scoped to the current storage before grouping content references;
switching back restores the original directory's entries. Shared-file and send
pickers can still access retained files across mounts. The listing is an in-memory
projection of directory reads. The file's own trailer
identifies an incomplete transfer and its target length; preallocation cannot
establish progress. Completed files use a directory identity derived from their
mount, relative path and revision. Existing content references retain that identity
when a transfer completes; no directory file index is persisted.

On desktop, the file cache's separate Open directory button opens mounted native
directories in the system file manager, with a choice of roots when several are mounted. The web
does not show this action. The file cache dialog remains available on both
platforms, including its incomplete-transfer list. Explicitly importing a file
creates an immutable content snapshot in the selected storage location. Scanning or
mounting a directory never automatically shares its files with peers. Explicit
deletion from the file cache removes the indexed source file as well; releasing
an attachment, deduplication, and background cleanup do not delete source files.

## Receiving and recovering files

The receiver reserves the logical payload length before writing chunks at
`chunkIndex * chunkSize`. IndexedDB implements sparse files using fixed-size
pages. Native files use `set_len`; browser files use `truncate` and positional
writes. Logical length does not guarantee physical disk space reservation.

In real directories, the same file holds its payload and a trailer:

1. The payload occupies its normal offsets, including unwritten ranges.
2. A fixed-position table records each committed chunk and its BLAKE3 digest.
3. Two checksummed metadata slots hold transfer metadata and the intended final
   path; an interrupted update can fall back to the previous valid slot.
4. A checksummed footer identifies the format and payload/chunk sizes.

The temporary physical file is larger than the target payload: the overhead is
32 KiB plus a 64-byte footer and 36 bytes per chunk. No sidecar file or IndexedDB
file/checkpoint row is required. The web's default IndexedDB backend keeps its
transactional metadata and chunk rows within that backend.

Bounded pending batches are committed before their in-file checkpoints. On a
crash, uncheckpointed bytes are requested again. Reopening a partial file or
detecting an external revision change rechecks committed chunk digests against
payload bytes, including legitimate all-zero chunks. Damaged metadata makes the
file unavailable instead of advertising preallocated bytes as completed content.

After all chunks are present and the expected content fingerprint matches (when
provided), completion removes the `.part` suffix and trailer. For example,
`report.pdf.part` becomes `report.pdf`; a browser-rejected filename uses
`library.dll.weblink.part` and finishes as `library.dll.weblink`. A final name
created during the transfer is preserved, and another unused name is allocated.
Native directories move the file without replacing an existing destination,
then truncate its trailer. Browser directories stream the payload into the final
file, verify the committed bytes, and only then remove the temporary file.
This browser fallback needs space for both files during completion. The temporary
file retains all checkpoints if publication fails. Its checksummed metadata also
allows reopening after an interrupted move or copy; a verified completed copy is
reused without copying it again. Directory scans suppress that verified duplicate
while cleanup is pending and use the footer to identify partial transfers.
Files still pass whole-content verification before promotion into the library.

Whole-content verification is shared within the live storage service by mount,
relative path and file revision. Finalization, library publication, recovery scans
and subsequent references reuse the same locally computed result. A native move
and Weblink's own trailer updates preserve that result for the unchanged payload;
a newly copied destination must be verified separately. Checks before and after
hashing reject version changes, and failed or cancelled work publishes no result.
These results stay in memory: restarting or externally changing a file requires
verification again. Persisted or peer-provided fingerprints are comparison targets,
never proof that local bytes were already checked.

Browser-directory writes commit by closing `FileSystemWritableFileStream`.
Reopening with existing data may copy the file; this backend has different large
file performance characteristics from native random writes. A closed tab cannot
continue receiving or watching files. Handles survive reloads, but permission
may require a new user gesture. Upload actions request the selected directory's
permission before opening the picker or awaiting dropped-file reads and hashing.
After permission is restored, directory state is rescanned before content reuse.
Denied access stops the import. No fallback silently changes an existing file's
storage location when its directory becomes unavailable.

Explicitly importing identical content can restore an unavailable retained copy.
The new bytes are written and verified in the selected storage before updating
the content's backing location. Existing attachment IDs and sharing permissions
are retained; old directory files are never deleted as part of this repair. A
failed or cancelled write leaves the old content record and references intact
and cleans up only the newly staged copy. Matching a filename alone cannot repair
an old reference: the full content fingerprint must match.

Receive deduplication treats an unavailable retained copy as a cache miss while
preserving its references and sharing permissions. New transfers use the selected
storage; verified received bytes can restore those references without another
payload copy. Errors preparing or writing the actual receive destination still
fail the transfer. An unavailable old copy alone does not prevent receiving.

Importing a complete local file into a browser directory uses one writable stream:
reserve its length, write bounded slices, and close once. It does not commit a
zero-filled executable or an in-file transfer trailer before writing the payload.
Unfinished network receives keep the checkpoint format above. Browser security
checks still apply to directory access and final commits; failures retain the
file name, operation stage and browser error in the upload notification. Only
filename rejection triggers the storage suffix; permission errors and failed
write/commit security checks do not trigger retries or backend changes. The app
does not infer support from an extension or silently select a different backend.

File-cache imports own their cancellation controller and progress toast. Closing
or reopening the cache dialog does not stop file reading, folder packaging,
permission completion or storage writes. The toast remains available to cancel
the current and remaining work; each separately started batch is independent.
The compact progress bar follows bytes read, written and verified, weighted by
file size with one pass reserved for each phase. Reused files and stores without
a verification pass finish their unused work when the import succeeds. Pending
folder packaging shows indeterminate progress, and the batch stays below 100%
until every file is committed and published. Failed writes retain their original
error details. Import failures show the affected filename and size, current phase,
completed file count and original local error/cause, including native error
strings and browser read errors. Details can be copied directly from the toast;
an unsolicited runtime `AbortError` is a failure, not user cancellation.
Shared-file imports keep their view-scoped cancellation behavior
so switching members cannot publish a late result into the wrong shared list.

Directory scan entries already owned by a library reference are hidden from the
file-cache projection. Unchanged file snapshots and keyed list rows are reused
so synchronization does not recreate thumbnail URLs.

## Change notifications and file access

IndexedDB uses local notifications and BroadcastChannel. Native directories use
OS notifications with periodic refresh. Browser directories use an observer
where available and scan metadata as a fallback, including on focus. Events are
invalidation hints, not an authoritative operation log. Watchers are disposed
with their owning storage service/page.

Directory reconciliation commits membership only after a successful scan. A
failed scan, disconnected root, or lost permission preserves the last in-memory listing
and marks inaccessible files unavailable. Reconnecting restores access.
Files confirmed absent by a successful scan disappear from the cache list,
including entries backed by retained chat references. Missing files stay hidden
after reload. Lost permission is kept distinct from confirmed deletion; incomplete
files that still exist remain visible for resuming.

Confirmed deletion or replacement releases local library pins by both reference ID
and backing storage ID, including imported files whose two IDs differ. Startup
also reconciles missing directory versions and removes content records with no
remaining references, covering deletions while the app was closed. Chat and shared
references retain their content identity. Failed scans and unavailable mounts do
not authorize this cleanup, and removing an old index never deletes a replacement
file at the same path.

Sent/shared references retain their content identity when a directory file is
edited or deleted; they become unavailable instead of serving changed bytes under
an old fingerprint. The new directory version can be selected immediately and
is fingerprinted when sent/shared. If a renamed/recreated file has identical
verified bytes, it can restore existing references without copying. Managed
transfer files continue to use their checkpoints and immutable-content checks.
After rebuilding directory state from disk, a retained reference's content hash
must match before its bytes can be reused under an existing content identity.

`StoredFile` permits bounded range reads and streams without a materialized JS
Blob. Native media uses opaque, page-scoped capability URLs and HTTP range
responses. Native reads and writes use bounded binary IPC. Native operations
accept only paths relative to a registered root, reject traversal and symlink
escapes, and never accept a caller-supplied unrestricted host path.

Desktop file-open actions use the system default application. Conversation
image/video thumbnails use PhotoSwipe on both platforms; audio keeps its inline
player, and these media bubbles omit the redundant open button. Bubbles for files
in native directories also omit the save-as button; the context menu retains
save-as. Each message has at most two action buttons, including the adjacent room
retry. Bubbles prioritize open/preview and transfer controls over save actions.
Room-file details are opened from the context menu and retain per-recipient
progress and controls; the menu also retains the remaining file actions.
Native files open their original path after validating
the file capability and revision. Legacy IndexedDB files are streamed into a
temporary copy before opening, without a save dialog; edits to that copy do not
change the IndexedDB content. Web file actions keep the in-app preview. The
send-confirmation dialog remains a separate step before sending a newly picked file.

File-item menus use each file's actual backing storage, including shared-content
references, rather than the current default mount. IndexedDB files offer Save to
device; directory files offer Save as. Desktop uses its save dialog, and supported
browsers use a save picker and stream into the chosen destination. Cancelling the
picker leaves the source unchanged. Browser downloads remain the fallback when a
save picker is unavailable.

Batch Save as picks one destination directory for the whole selection, including
IndexedDB files in a mixed selection. It does not mount or change the default
storage directory. Files stream sequentially into that directory. A name conflict
asks whether to overwrite, skip, or keep both using a numbered copy. Apply to all
remembers that choice only for the current batch; cancelling the conflict prompt
stops the remaining files. Overwrite is unavailable for directories and other
non-regular entries. Overwrite failures preserve the existing file; replacement
is committed only after the new content has been written. Browser filename
restrictions use the same `.weblink` fallback as mounted storage. Single-file menu actions keep their save
file picker. Native export directory permissions are released after the batch or
page reload, and failed copies discard their temporary files.

Batch Save as uses a compact progress toast for the current filename, written bytes,
saved count, and skipped count. A separate confirmation toast pauses the batch on
name conflicts; progress stays visible and resumes after the choice. Background
conflicts use the existing system notification service and transfer notification
preferences; opening the reminder returns to the same in-app confirmation without
choosing a file operation. Written bytes may still be awaiting the final commit; only committed files
count as saved. Cancellation stops further files and aborts the current uncommitted
copy at a chunk boundary, preserving earlier completed files and any original being
replaced. A commit already in flight can complete and is counted as saved. Each
batch owns its file snapshot, cancellation controller, and notices. Closing or
reopening the file manager does not cancel saving or dismiss progress and conflict
toasts. Existing and subsequent conflicts remain actionable after the dialog closes;
the user cancels through either toast. A new batch has independent cancellation and
conflict choices, and does not replace an earlier batch's notices.

Native directory items and message context menus also offer Open file location,
including unfinished files.
The action resolves the current mount-relative physical path (which may have a
collision name or `.part` suffix), validates it inside the registered root, then
asks the system file manager to reveal and select it. It does not open or export
the file's contents. This action is absent for IndexedDB and browser directories.
