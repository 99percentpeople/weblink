# File transfer and resume

File transfer combines two protocols: P2P control messages agree on the file and operation, then a dedicated WebRTC data channel carries binary blocks. The receiver requests missing chunks, while storage decides when those chunks are committed and when the complete file is safe to publish.

## Metadata before bytes {#transfer-flow}

<figure class="docs-diagram">
<div class="docs-diagram-scroll" role="region" aria-label="File transfer and resume data flow" tabindex="0">

![The receiver requests missing chunks after a file offer. The sender compresses and splits each chunk, the receiver reconstructs and inflates it, and storage commits bytes before checkpoints. Reopening verifies checkpoints and requests missing chunks before final content verification.](/diagrams/file-transfer-en.svg)

</div>
<figcaption>Blue arrows carry file bytes; dashed arrows show resume after reopening. Checkpoint and file-publication details belong to storage, rather than being extra transfer-channel messages.</figcaption>
</figure>

The normal flow is:

1. Offer file metadata and, for content-based transfers, a content fingerprint.
2. Let the receiver accept the offer or reuse an already verified local copy.
3. Bind a transfer to the actual peer session and open its data channel.
4. Request missing chunks, receive their blocks, and commit reconstructed data.
5. Verify the complete content and publish it through the storage service.

The transfer channel uses the protocol identifier `transfer`. Its label identifies the file and channel index, for example `<fileId>-0`. Metadata is supplied by the control exchange; the channel label alone is not authority to write into an arbitrary file.

The transfer registry binds channels to the expected file, direction, and owning peer session. It rejects unknown or duplicate channels. A reconnect with the same visible device ID does not let an old session deliver data into the new session's transfer.

## Requesting missing chunks {#ranges}

The receiver sends JSON control frames on the transfer channel. A single number requests one logical chunk; a pair requests an inclusive range:

```json
{
  "type": "request-content",
  "ranges": [0, [2, 5], 9]
}
```

This requests chunks 0, 2, 3, 4, 5, and 9. Chunk indexes describe positions in the original file, not positions in a compressed stream or byte offsets. Their size comes from the agreed file metadata.

Two other control frames coordinate stopping and completion:

```json
{
  "type": "pause"
}
```

```json
{
  "type": "complete"
}
```

A wire-level `complete` participates in transfer coordination. It must not be interpreted by the UI as proof that pending storage writes, final content verification, and publication have all finished. Those steps belong to the receiving transfer and storage lifecycle.

## Binary block format {#packet-format}

Each logical chunk is encoded as a raw DEFLATE stream, then split into blocks suitable for the data channel. Every binary block begins with a seven-byte header:

| Byte offset | Field                                    | Encoding                            |
| ----------- | ---------------------------------------- | ----------------------------------- |
| 0–3         | Logical chunk index                      | Unsigned 32-bit integer, big-endian |
| 4–5         | Block index within that compressed chunk | Unsigned 16-bit integer, big-endian |
| 6           | Last-block flag                          | Exactly `0` or `1`                  |
| 7 onward    | Block payload                            | Part of the compressed chunk        |

The receiver groups blocks by chunk index, reconstructs the compressed chunk, and inflates it before writing the original bytes. A compression level of zero still uses raw DEFLATE framing; it does not switch the protocol to unframed file bytes. Packets shorter than the header or with an invalid last-block flag are rejected.

Logical chunk size and transmitted block size serve different purposes: chunks define storage and resume units; blocks fit transport limits. Sender backpressure waits for available transport capacity rather than queuing the entire file in the data channel. Progress through the network and progress committed to storage can therefore differ.

## Content identity and verification {#fingerprints}

The current content fingerprint is version 1 with the `blake3-256` algorithm. It contains the file size and a 64-character lowercase hexadecimal digest. Its internal content key has this form:

```text
v1:blake3-256:<size>:<digest>
```

Content identity is independent of the filename, message ID, transfer run, and chunk boundaries. Renaming identical bytes does not make a different content fingerprint; the same filename with changed bytes does. This lets separate messages and file-library entries reference the same verified content.

A fingerprint supplied by another device is an expected value to compare against. It is not evidence that the receiver has already checked its local bytes. Received files pass local content verification before they are promoted to complete content. Existing local copies can be reused only through the storage service's verification rules.

## Pause, resume, and ownership {#resume}

Resume requests are calculated from committed chunks. Bytes that were merely received, buffered, or preallocated do not count as durable progress. After reopening a partial directory file, checkpoint digests are checked against its bytes before the chunks can be reused.

Pausing stops the active transfer while retaining committed data. A later run can request only the missing chunks when the source and compatible file metadata are available. Cancellation, releasing a message reference, and deleting stored content have separate effects; they are not interchangeable cleanup commands.

A file can be offered to several peers, but each transfer has its own session and run ownership. Completion or failure from an older run must not overwrite the state of its replacement. Room attachments are durable offers in local history, not copies stored by the signaling server: receiving their metadata does not mean their bytes were downloaded, and fetching them still needs an available source.

## Implementation entry points {#implementation}

Paths are relative to `apps/web/src/libs/`:

| Path                                                                 | Responsibility                                             |
| -------------------------------------------------------------------- | ---------------------------------------------------------- |
| `domain/transfer/protocol.ts`, `domain/transfer/packet.ts`           | Transfer control frames and binary packet layout           |
| `domain/transfer/file-sender.ts`, `domain/transfer/file-receiver.ts` | Chunk transmission, reconstruction, and transfer lifecycle |
| `domain/protocol/file-fingerprint.ts`                                | Content fingerprint contract                               |
| `application/transfer/transfer-registry.ts`                          | File, session, and channel ownership                       |
| `application/transfer/file-transfer-service.ts`                      | Transfer orchestration                                     |
| `infrastructure/vfs/chunk-cache.ts`                                  | Committed data, verification, and completion               |

## Choose your next step {#next-steps}

- **Understand how interrupted downloads survive reopening:** continue with [storage and file lifecycle](storage.md#partial-files).
- **Send, pause, or share files in the interface:** use the [file transfer guide](../guide/files.md).
- **Investigate an unavailable attachment or failed save:** use the [file and storage FAQ](../guide/faq.md#files).
