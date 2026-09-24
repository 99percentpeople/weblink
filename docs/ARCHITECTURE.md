# Weblink — Architecture & Directory Guide

Weblink is a SolidJS + TypeScript (strict) WebRTC chat /
file-transfer app. The UI is intentionally kept thin:
components should talk to app state/services via stable
interfaces, while WebRTC/session/transfer details live in
the low-level `domain` layer.

## Top-level layout

- `src/`: Frontend application code (SolidJS).
- `public/`: Static assets served as-is.
- `docker/`: Nginx template + entrypoint scripts used by
  the Docker image.
- `test/`: Vitest unit tests.
- `scripts/`: Repo scripts (clean/build helpers).

## Related signaling repositories

- [`weblink-ws-worker`](https://github.com/99percentpeople/weblink-ws-worker):
  Cloudflare Workers + Durable Objects implementation. This is the
  recommended serverless WebSocket deployment.
- [`weblink-ws-server`](https://github.com/99percentpeople/weblink-ws-server):
  Bun implementation for self-hosting and rollback.
- See [`docs/SIGNALING.md`](SIGNALING.md) for endpoint configuration,
  protocol ownership, deployment validation, and rollback.

## `src/` layout

### UI

- `src/app.tsx`: Application shell (providers, global UI,
  dialogs).
- `src/constants.ts`: Project-wide constants shared across
  UI/application/domain (storage keys, timeouts, prefixes).
- `src/routes/`: Route-level pages (Solid Router).
  - `src/routes/home/`: the main route `/`, containing the meeting stage,
    bottom media controls and a floating panel with permanent chat, members
    and room information tabs. The conversation list lives inside the chat tab. There is no separate chat page. The chat panel can
    expand into a conversation-list/chat split view on wider screens; compact
    screens start on the conversation list; selecting a row enters chat, whose
    header has a back button to the list.
    A single desktop control toggles compact and expanded panels. Expanded
    panels automatically fill the workspace when the window is too narrow to
    retain the meeting canvas, and dock beside it again when widened. This hides
    the canvas without unmounting media or changing the chosen expansion state;
    Escape closes the panel. Mobile panels replace the canvas and provide a return-to-meeting
    action instead of a modal overlay. Expanding preserves the mounted chat, and
    the chosen panel width is retained when switching tabs. The fixed tab group stays anchored to the right while
    its indicator slides and newly selected content fades in. Width changes use
    CSS transitions and the stage's existing ResizeObserver; no text is scaled
    and no additional observer is introduced for the sidebar.
    Mobile detection and expanded-panel docking share one viewport resize snapshot
    so panel width and meeting-canvas visibility stay in sync while resizing.
    Selecting a conversation updates the `conversation` query parameter without
    changing rooms. The existing media-preview hash contract is preserved.
    The application media controller
    independently acquires the microphone, camera and multiple shared screens.
    Display capture requests optional audio from the browser picker. Each returned
    audio track belongs to its display: microphone mute/device changes preserve
    it, while stopping that display (including the browser's stop action) removes
    its audio. Audio ending alone leaves the picture live. Capture without audio
    remains valid; available audio sources depend on the browser and platform.
    The header switch mutes/resumes all current display audio in place, preserving
    the microphone and video. Newly added displays inherit that mute until all
    displays stop. Without a captured display audio track, the switch is disabled.
    The application service owns capture tracks and preserves retained tracks when their stream
    container changes. The stage renders each video track as a separate view;
    pinning chooses a view rather than a participant. Remote views use numbered
    labels because the transport does not claim camera/screen source metadata.
    All stage views use 16:9 frames and contain the source video. One stage-owned
    ResizeObserver measures the grid's allotted content box and coalesces updates
    per animation frame. Grid columns, centering offsets and tile dimensions use
    that same measurement and fit both width and
    height, with hysteresis near column boundaries. Size containment keeps tile
    content from resizing the observed box; source-count changes reuse the same
    measurement and observer. Focused and
    single views fit both available dimensions; the thumbnail rail scrolls
    independently and can be collapsed without unmounting its video elements.
    Each source has one keyed Portal owner that moves its existing video view
    between the grid, focused frame and rail when the layout changes.
    Grid resizing, source-list updates, explicit layout and thumbnail visibility
    changes use Motion JS through
    `hooks/layout-transition.ts`, matching stable view identities across layouts.
    Resize and source-list changes share the grid's frame queue; initial and hidden
    measurements update directly without an entrance animation.
    Moving boxes temporarily leave document flow and rail clipping; the controls
    row keeps its space and rail scroll is restored afterward. Interrupted
    transitions capture the current frame before clearing animation styles.
    Avatar dimensions interpolate separately with parent-scale compensation.
    Name overlays counter the frame's scale to retain typography and padding;
    their insets and available width follow the transition, with long names
    truncated within the frame.
    Opening/closing the side panel refreshes the same grid measurement before
    taking the destination snapshot, so the panel and stage transition together.
    Transitions preserve the grid's single observer, respect reduced motion and
    clear animation styles on disposal.
    `components/ui/motion.tsx` provides Solid `Motion.*` elements and
    `AnimatePresence` for declarative entrance/exit animations. See
    [UI motion](UI_MOTION.md) for the supported API and layout scopes.
    Sharing status lives in the right side of the header and
    media errors use temporary toast feedback.
    Expandable controls select microphone, camera and supported speaker outputs.
    Selecting a disabled input only records a preference. Switching a live input
    acquires its replacement before releasing the old track, preserves mute
    state and leaves the other captures intact. Device enumeration never requests
    capture permission by itself; the audio provider owns output routing.
    `hooks/media-device-access.ts` combines permission queries with exposed device
    identities. Missing access exposes a header action that opens device settings;
    blocked access and absent/unsupported devices have separate states. Explicit
    authorization uses short-lived input capture, enumerates devices and releases
    every probe track without publishing it. Speaker access uses the native output
    picker when available, otherwise an explained temporary microphone grant.
    Permission changes and window focus refresh the state; disposal releases
    listeners and any capture that resolves late.
    `hooks/meeting-media-context.tsx` owns the shared controller and device
    discovery beneath the audio provider and above the modal provider. Both the
    toolbar and room device dialog use that same state; closing either view
    preserves device choices and published media. Room changes cancel pending
    capture requests. The capture implementation lives in
    `application/meeting-media-service.ts` behind injected media/stream ports.
    Device selections in room settings only save preferences and never open or
    replace their streams. Unapplied preferences survive stream updates and are
    used on the next toolbar activation, including unmuting a retained microphone.
    Explicit device changes in the toolbar can still replace an active source.
    `components/meeting-session-context.tsx` lives above route pages and owns
    source selection, pin state and independent thumbnail-rail and toolbar
    visibility, shared between Home and picture-in-picture. The toolbar has its
    own collapse/reveal control in every layout, including grid and single-source
    views; collapsing thumbnails never changes toolbar visibility. While the toolbar
    is collapsed, thumbnail toggles are hidden and only the toolbar reveal action
    remains. Revealing the toolbar restores the toggles without changing rail state. The provider also owns the
    Document Picture-in-Picture window. The window reuses the focus stage with a
    main source, a collapsible thumbnail rail and compact controls using the same
    media controller. PiP stays in focus mode; its toolbar has no grid toggle.
    Selecting a thumbnail switches
    the source featured in the main view.
    The main source is the pinned source, otherwise the first live video or first
    participant; selecting a thumbnail updates the shared pin without recreating
    video views. While PiP is open, Home replaces only its stage with an SVG
    notice and a return action; its side panel and active chat remain mounted.
    No capture is stopped. The stage schedules resize/source updates using its
    own document's animation frames and ResizeObserver so PiP keeps updating
    while the opener is hidden. `hooks/document-picture-in-picture.ts`
    handles pending requests, native close and disposal without owning tracks.
    The child document receives app styles, theme updates and its own Solid
    delegated event handlers, all cleaned up when the window closes.
    Video playback recovery follows metadata/readiness, repeated track unmute,
    document foreground and viewport visibility events. The stage also exposes
    canvas/thumbnail visibility explicitly because CSS visibility changes need
    not change intersection. Recovery retries paused live video without replacing
    its stream or stopping borrowed tracks. Autoplay denial keeps a translated
    toast action available for a user-initiated play request; browser policies
    and codec support are not overridden or inferred from the user agent.
    In the mobile layout, each playable video tile independently exposes native
    video PiP when its standard or WebKit presentation API supports it. Its
    original video element stays mounted under a notice and restore action;
    closing PiP never stops borrowed media tracks. Video PiP has no automatic
    entry setting and is owned by the tile, so removing its source closes it.
    Confirmed mobile video PiP entry selects that source as the main view through
    the existing layout transition; repeated entry is idempotent and exit retains
    the selection. Failed or cancelled requests do not change the layout.
    Fullscreen video uses decoded dimensions to request landscape or portrait
    orientation when the Screen Orientation API allows it, follows video resize,
    and releases only its own lock on exit. Missing or rejected orientation
    support never prevents fullscreen.
    Automatic Document PiP is an opt-in app preference, available only while at least one
    local or remote video track is live, enabled and unmuted. Audio-only and
    placeholder sources do not qualify; manual entry remains available. The video
    condition is rechecked after a pending request. Internal route exits request
    it within the navigation gesture, while browser tab changes and window
    occlusion use the Media Session `enterpictureinpicture` action. Background
    requests require a hidden document or the browser's explicit
    `contentoccluded` reason, and no pending screen picker. Browser-reported
    occlusion may precede visibility events or leave the document visible.
    Focus loss alone never opens PiP.
    Hidden visibility events also request it while transient user activation
    remains valid. Browser
    eligibility and site permission determine whether background entry is granted
    (Chrome requires HTTPS even on localhost; conference capture normally requires
    an active microphone or camera). Screen-only capture does not meet Chrome's
    conferencing condition. Recent user activation may allow an initial departure
    to open PiP without guaranteeing later departures; eligible audible playback
    has its own browser conditions.
    Returning to a visible, focused meeting page closes only a
    background-triggered window, including pending requests. Both visibility
    and focus events handle return and reset native-dismissal suppression;
    visibility alone does not establish that the user returned from the child.
    These events do not bypass the browser's activation rules. The small window
    cannot survive closing the opener or navigating that tab to another website.
  - `src/routes/client/[id]/sync.tsx`: peer file synchronization, reached from
    the conversation menu, with a return-to-Home header.
  - `legacy-home.tsx` redirects `/home`, `/video`, `/chat`, and old conversation
    or private-chat links into Home, retaining invitations and media hashes.
    `/file` and `/setting` are compatibility entries that open the respective
    dialog on Home; the one-shot `dialog` parameter is then removed.
  - `src/components/settings/`: appearance, connection, transfer,
    advanced and about sections in a shared settings dialog. Desktop uses a
    category rail and mobile uses horizontal tabs. Options keep their existing
    persistence keys and apply immediately. ICE probes and credential resolution belong to the injected
    application diagnostics service, not the view.
    About shows shared application metadata inline and copies only the version
    and build time. Confirmed preference resets replace optional values and
    per-room/member maps; page-cache cleanup affects Cache Storage and service
    workers. Both preserve conversation history and IndexedDB file caches.
- `src/components/`: Reusable UI building blocks.
  - `components/app/`: app-scoped actions, dialogs, account dropdown and wake
    lock. The previous global navigation rail has been removed. The account
    dropdown opens local file management, tasks and settings and retains room
    sharing and QR-code actions. Dialog controllers live above route pages;
    opening them does not leave Home or trigger automatic picture-in-picture.
    Settings and file-manager menu items warm their lazy chunks on pointer
    entry, keyboard focus or touch/press. `libs/utils/preload.ts` shares the
    import with rendering and primes Solid's public lazy API after success;
    failed background warmups can be retried when opening. Preloading does not
    mount dialog contents or start application operations. Route links retain
    Solid Router's existing component preloading.
    `room-actions.tsx` centralizes joining and editing. A configured profile can
    join directly, first-time users configure their profile first, and concurrent
    joins are blocked. The shared room editor saves changes immediately, including
    when closed without connecting. Its Connect action validates the profile and
    joins the room from either entry point. Closing a file/settings dialog does not
    dispose meeting media or the active chat.
  - `components/files/file-manager.tsx`: local file management inside a dialog,
    preserving imports, filtering, previews, downloads, forwarding and deletion.
    The compact list scrolls inside the dialog and is mounted only while open.
    `file-browser.tsx`, `file-filters.tsx`, `file-list.tsx` and
    `file-picker-dialog.tsx` share searching, filtering and selection between the
    manager and composer. Sending existing content uses `FileSource`
    (`File` or `{ kind: "library", localFileId }`), preserving drafts and the
    conversation captured when the picker opened.
  - `global.css` owns the shared light/dark blue-gray palette and radius scale:
    menu items 8px, controls 12px, panels 16px and dialogs/toolbars 20px. Meeting
    CSS uses those tokens; the picture-in-picture document mirrors theme changes.
    Home's component-specific presentation is colocated in JSX using Tailwind;
    `routes/home/index.css` retains shared controls and coordinated grid,
    sidebar and picture-in-picture layout rules. Selector hooks used by runtime
    code or existing checks remain independent of presentation classes.
  - `components/conversations/`: shared conversation sidebar, label editor and
    private/room view composition. Home supplies an in-place selection callback;
    conversation history and delivery state remain in the shared stores.
    Shared conversation actions separate clearing local history (keeping the
    list entry, labels and membership metadata) from deleting history and its
    list entry. Active rooms and online private peers allow clearing but block
    deletion until leaving the room; confirmation rechecks presence. Private
    actions target the selected conversation's original local identity.
    `chat-composer.tsx` supplies the same text and attachment controls to both
    conversation types; their callbacks retain separate delivery policies.
    Room file cards show metadata without loading remote bytes on mount.
    Locally cached images, video and audio render inline, so senders can see
    their own media immediately and recipients see it after a manual or opted-in
    small-file download. The room dialog's settings tab stores per-room,
    browser-local auto-download preferences: off by default, with an inclusive
    5 MiB default limit. It uses the namespaced room conversation identity.
    `file-attachment-bubble.tsx` shares media, metadata and download presentation
    across private and room messages. `local-file-media.tsx` joins images/videos
    to each conversation's PhotoSwipe gallery and uses native audio controls.
    `media-thumbnail.tsx` keeps a fixed 16:9 frame while the inner image bounds
    match the actual image aspect ratio. Videos use a local first-frame poster.
    `media-hash-route.ts` identifies previews by stable conversation/message IDs
    in `#/media/<encoded-conversation-id>/<encoded-message-id>`. Opening creates
    one history entry; changing slides replaces it; Back/Forward closes/reopens
    the preview. A directly loaded deep link closes within its current page.
    Galleries reveal older message windows and wait for local media metadata,
    without requesting missing room files. Meeting hash links select the matching
    conversation and open its chat panel. Inline media object URLs are released
    when the file changes or the view unmounts. `file-transfer-indicator.tsx` places pause/resume controls inside
    a compact progress ring. Speed replaces the status label while transferring,
    and the metadata stays on one line through pause/resume transitions. The two
    message adapters retain their own service calls and room cache authorization.
    Room senders open recipient download progress in a details dialog beside the download button; the list never expands
    the message bubble. Only recipients can initiate or resume a room download.
  - `components/dialogs/`: unified dialog directory.
    - Modal primitives: `base.tsx`, `dialog.tsx`,
      `drawer.tsx`.
    - Business dialogs: room/join, QR code share, preview,
      forward, delete confirms, about, media selection,
      compatibility details, media-constraints dialogs,
      etc.
    - `room-info-dialog.tsx`: room information, meeting devices, settings and member tabs, opened
      from room headers or conversation menus. Capability and delivery details
      live here rather than above the message composer. Historical-room dialogs
      do not join rooms or change the active room's devices; opening information
      never starts capture. The device tab contains selectors without capture
      switches; output selection routes existing playback without starting it.
      The member tab combines live participants in the active room with previous
      members whose private conversations remain stored. `RoomService` records
      silent joins with the captured room identity and generation checks;
      direct-conversation metadata retains namespaced room conversation IDs.
      Older history can establish membership through room-message senders and
      original recipients, but unrelated contacts are never assumed to belong.
      Deleting a private conversation removes that peer from previous members;
      live presence remains visible independently. The optional metadata field
      uses the existing conversation store and requires no database version bump.
    - `ModalProvider` is mounted once in `src/app.tsx` and
      dialog factories auto-register themselves globally.
      Consumers call `open()` directly and do not render
      dialog components in page JSX.
    - Route pages should import dialog creators from this
      directory instead of defining separate dialog files
      under route folders.
  - `components/ui/`: shared UI primitives (buttons, inputs,
    popovers, etc).

### Application logic

Most non-trivial logic lives in `src/libs/` and follows an explicit
dependency direction: state/UI → application → domain, while application
may select concrete infrastructure implementations.

- `src/libs/state/`: reactive application state and UI-facing context.
  - `app-state.ts`: shared store shape, including room/client view state.
  - `app-state-context.tsx`: thin composition/API surface consumed by UI.
  - `app-options.ts` and `profile-store.ts`: persisted user configuration.
- `src/libs/application/`: application lifetime and workflow orchestration.
  - `room-service.ts`: owns room join/leave, signaling-client lifetime and
    stale asynchronous join/session rejection. It reserves room/password/client
    identity before client creation, shares concurrent same-identity joins through
    the handshake, and retires old work on identity changes, leave or disposal.
  - `session-service.ts`: owns live `PeerSession` instances and client views.
  - `ice-server-diagnostics.ts`: coordinates STUN/TURN availability probes behind
    injectable credential/probe functions, without UI or shared-state ownership.
  - `messaging/`: reactive message history, persistence port and tracked
    message workflows. IndexedDB does not live in this layer.
    - `message-store.ts`: private-message history and hydration, stable reactive
      arrays, browser-local message sequencing, and the shared facade composed
      from injected conversation and room-message stores.
    - `conversation-history-service.ts`: application API for caching local text
      conversations. It waits for hydration, creates records and stable message
      IDs, coalesces concurrent batches, and resumes incomplete writes without
      duplicates. Callers supply content rather than storage records. The welcome
      guide uses this shared API and marks completion only after persistence.
    - `conversation-store.ts`: local conversation metadata, labels and reading
      cursors. Private and room history is queried and removed by conversation
      identity; contact deletion never removes room messages authored by that
      contact.
    - `room-message-store.ts`: durable room-message insertion, duplicate identity
      checks and serialized per-recipient delivery updates, without networking.
      Clearing or deleting a conversation invalidates pending room insertions;
      late private and room writes cannot restore removed history.
    - `conversation-query.ts`: pure summary, search, label filtering and grouping
      projections used by both sidebars. Text search and label selection combine
      with AND; selected labels combine with OR. A conversation may appear under
      several label groups, while unread totals count each conversation once.
      Message order, recent activity and the reading cursor use persisted local
      sequence numbers. Sender timestamps are display metadata, so remote clock
      skew cannot reorder already-read history after reopening the browser.
    - `room-messaging-service.ts`: capability negotiation, one logical room
      message with a snapshot of online recipients, per-recipient outcomes and
      retry of the original failed recipients. Session/room lifecycle checks
      prevent delayed operations from entering a replacement room. There is no
      offline outbox or late-join history synchronization.
    - `room-file-sharing-service.ts`: prepares local attachments, publishes
      file offers through room messaging, and authorizes explicit recipient
      pulls against the original offer and current room binding. Each pull has
      a fresh protocol request ID while progress belongs to the durable offer.
      Opted-in small-file downloads reuse the same pull path. Room persistence
      reports whether an offer is newly inserted, so only fresh, validated
      incoming offers trigger the size check; history, duplicate receipts and
      paused/failed/completed transfers do not start another download. The check
      uses original stored metadata and does not delay the metadata ACK.
  - `room-identity.ts`: derives the signaling namespace used by room conversation
    identity so equal room names on different signaling services stay separate.
  - `rtc/`: Weblink's PeerSession transport adapter and protocol composition.
    The reusable P2P protocol itself lives in `domain/protocol/`.
  - `transfer/`: file-transfer workflows, registry and message binding.
    `file-offer-transfers.ts` reuses run/channel ownership for room attachments
    without creating private messages. Upload progress is per recipient;
    delivery receipts describe offer delivery, not binary completion. Room
    attachments remain cached after a recipient finishes. Their attachment IDs
    remain excluded from legacy private request/resume paths. Shared content uses
    a separate directory reference, including content sent in room chats.
    Explicit local forwarding creates a private attachment with a fresh ID backed by shared immutable content;
    it does not make the original room cache available through private requests.
  - `file-library-service.ts`: content-addressed storage ownership, independent
    attachment references, explicit library retention, and lazy indexing of old
    completed caches. The metadata database `weblink-file-library-v1` indexes
    BLAKE3-256 identities; binary data stays in existing chunk databases.
    Pending imports are published only after bytes commit. Per-content Web Locks
    coordinate tabs; unique claims and recovery records prevent duplicate writes.
    `files/reference-chunk-cache.ts` reads shared bytes using each attachment's
    own name, permissions and chunk size. Removing a message releases its reference;
    explicit deletion in the file manager cancels affected runs and removes all
    local references, preserving chat metadata. Pinned imports survive message cleanup.
  - `file-fingerprint-service.ts`: one incremental BLAKE3 Worker with 2 MiB reads,
    shared jobs for identical Blob objects, cancellation and task-center progress.
    A file's metadata alone never authorizes deduplication. The first use of an old
    complete cache computes its fingerprint without blocking application startup.
  - `transfer/file-content-capabilities.ts` negotiates `file-content-v1` through
    session-scoped profile features. New offers use typed `have`/`need`/`deferred`
    replies; room file offers with fingerprints use version 2. Unconfirmed peers
    continue using legacy envelopes. A `have` reply follows durable history and
    a readable local reference and creates no binary run. Deferred local jobs
    share one authorized source; `file-content-ready` reliably completes each
    waiting offer under its original identity and room binding. Binary receivers
    verify decompressed, assembled content before emitting completion. Corrupt
    bytes never enter the content index. Local completions carry
    `completionSource: "local"`, without fabricated throughput.
  - `file-catalog-index.ts`: complete, explicitly shared content references and
    in-memory search/sort/page queries, without File contents or storage reads during paging.
  - `transfer/shared-file-transfers.ts`: authorized directory pulls, independent
    task lifecycle and local library references, with no chat messages. It shares
    the binary registry and fingerprint receive coordinator with chat attachments.
    Closing the file panel cancels its directory view, not its transfers.
  - `file-catalog-service.ts`: version-3 directory provider, privacy policy and
    payloadless P2P invalidation routing.
  - `remote-file-catalog.ts`: active-page refresh coalescing, cancellation and
    stale-response isolation. The Solid hook in `hooks/file-catalog.ts` binds it
    to the currently selected member in the sidebar file tab. The view owns query
    state and defaults to 50 files per page; hidden views release their subscriptions.
  - `cache-service.ts`, `speed-test-service.ts`, `task-service.ts`, etc:
    application-scoped coordinators.
- `src/libs/domain/`: low-level models and P2P behavior. Domain must not
  import `application`, `state` or `infrastructure`.
  - `client.ts`, `ids.ts`, `file.ts`, `message.ts`, `conversation.ts`: shared domain models
    and contracts without application-state ownership.
    Conversation identity is independent from live peer sessions: a direct
    conversation identifies the original pair of client IDs, while a room
    conversation identifies a signaling namespace and room ID. Labels and
    reading cursors are local organization metadata, not room membership or
    remotely shared settings.
  - `session.ts`, `peer-negotiation.ts`, `signaling.ts`: WebRTC session and
    signaling service contracts.
  - `signaling-protocol.ts`: transport-neutral WebSocket signaling envelope,
    presence, routed-peer messages, join acknowledgment, deployed version and
    limits for cross-client implementations.
  - `protocol/`: transport-agnostic P2P control wire contract, runtime
    validation, request/reply state machine and minimal transport/session ports.
    It has no PeerSession, WebRTC, Solid, IndexedDB or AppState dependency.
  - `transfer/protocol.ts` and `transfer/packet.ts`: portable file-channel
    JSON frames and exact binary block header; sender/receiver algorithms remain
    WebRTC/browser domain code around that contract.
    Application wiring passes the connection's negotiated SCTP message limit to
    the file sender. Payload blocks respect that limit minus the seven-byte
    header; a missing limit uses a conservative 64 KiB packet budget. The wire
    header and chunk identities remain unchanged.
  - `speed-test-protocol.ts`: the versioned `weblink-speedtest-v1` control
    DTO/parser/limits; `speed-test.ts` owns the WebRTC diagnostic state machine.
  - `transfer/`: chunked file sender/receiver and transfer-owned workers.
- `src/libs/infrastructure/`: concrete browser/backend adapters.
  - `signaling/`: WebSocket and Firebase client/transport implementations.
  - `storage/`: IndexedDB chunk cache, transactional assembly, merge worker
    and the IndexedDB message-history repository adapter.
    `indexeddb-message-repository.ts` owns the explicit version-2 message schema,
    legacy private-message backfill, conversation index, conversation/label
    metadata stores and atomic removal of a conversation's history or a label's
    assignments. A room ACK follows durable local insertion; duplicate logical
    messages remain idempotent after reload. Interrupted room deliveries become
    retryable failures on hydration rather than silently restarting network work.
- `src/libs/hooks/`: Solid hooks used by UI.
  `conversation-read.ts` advances a shared local reading cursor only while the
  document is visible and the mounted conversation follows its newest message;
  `create-bottom-scroll.ts` owns each conversation's scroll viewport separately
  from route/document scrolling.
- `src/libs/utils/`: generic utilities; worker modules live beside their owner
  instead of in a global worker bucket.

## Data flow (high level)

1. UI components call functions from `AppStateContext`
   (`src/libs/state/app-state-context.tsx`).
2. The context delegates workflows to `src/libs/application/*`.
3. Application services create/manage `src/libs/domain/*` primitives and select
   `src/libs/infrastructure/*` adapters where browser/backend implementation is
   required.
4. Application services translate low-level events back into `appState`
   (`src/libs/state/app-state.ts`).

Application orchestration still uses the shared Solid stores; it is not yet a
framework-independent layer. The strict portability boundary currently applies
specifically to `domain/protocol`, not the entire application or WebRTC domain.
The local media stream is now application-composed and injected through
`AppStateProvider`; route/controller separation remains incremental follow-up
work.

## Signaling and profile privacy

New client IDs use `uid_` followed by 16 cryptographically random
URL-safe characters (96 bits of randomness). Stored profiles keep their
existing IDs, including legacy UUIDs, so local conversation identities
remain stable across upgrades and reloads.

The signaling backend is a rendezvous layer, not an application
message transport:

- Clients publish only `clientId`, `createdAt`, the supported RTC
  profile version, and reconnect metadata. Signaling presence has no
  `name` or `avatar` field.
- The display name and avatar are sent in the versioned
  `client-profile` message after the WebRTC message DataChannel is
  ready. They are sent again when that channel reconnects.
- WebSocket and Firebase clients ignore profile fields from legacy
  presence records and create an anonymous placeholder locally until
  the WebRTC profile arrives.
- SDP offers/answers and ICE candidates must still use signaling
  until a peer connection exists. Room membership and client IDs
  also remain visible to the signaling backend.

## Design conventions

- Keep WebRTC details in `src/libs/domain`. Prefer exposing
  app-level methods from `AppStateContext` over constructing
  protocol/message objects or importing application singletons inside UI.
- Keep feature-local constants close to the code. Promote
  constants into `src/constants.ts` only when they are used
  across multiple modules/layers or need consistent tuning.
- Prefer `AbortController` for listener lifetimes; avoid
  leaked intervals/listeners.
- Prefer explicit types at module boundaries (protocols,
  context APIs, service interfaces).
