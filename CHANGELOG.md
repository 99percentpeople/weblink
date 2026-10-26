# Changelog

All notable changes to this project will be documented in this file.

## [1.3.2] - 2026-10-26

Weblink 1.3.2 adds movable video controls, improves audio capture settings, and completes shared interface and Windows installer translations.

### Video controls

- **Movable assistive dot:** drag the main video's control button and snap it to any of the four edges. The dot stays translucent when idle and opens with a click or hover.
- **Adaptive action menus:** use a full circle when space permits, or a compact fan near screen edges. Stagger inner and outer controls with more actions on the outside, merge their blurred background into one continuous surface, and keep remaining actions accessible through pagination.
- **Thumbnail and fullscreen behavior:** open thumbnail menus outside the video bounds to avoid clipping. Keep fullscreen menus within the fullscreen surface and hide the upper-left video label while fullscreen is active.
- **Control indicators:** preserve the outlined pointer and sparkle in AI control icons instead of filling them with the surrounding SVG color.

### Audio capture

- **Local playback suppression:** add an optional setting to mute this device while sharing system audio. Windows restores the original endpoint mute state when capture ends; browser support depends on the selected source and available capture constraints. Microphone and outgoing-audio mute controls remain independent.
- **Supported capture formats:** discover native system-audio sample-rate and channel combinations independently of microphone and preview tracks. Offer supported rates up to 192 kHz and select a compatible channel count when the rate changes.
- **Recording compatibility:** resample high-rate PCM audio to 48 kHz for Opus recording while preserving capture timestamps.

### Localization and maintenance

- Complete missing translations and keep common loading, search, selection and dialog labels consistent across the eight supported languages, including locale fallback behavior.
- Add a language selector to the Windows installer for English, Simplified Chinese, Traditional Chinese, Japanese, Korean, German, French and Spanish.
- Fix the meeting-stage test environment for the floating controls' resize observer and distinguish localized dialog close actions in integration tests, restoring CI coverage for source lifetimes and settings autosave.

## [1.3.1] - 2026-10-25

Weblink 1.3.1 adds native encoder presets and MCP video-preference tools, reduces duplicate screen-encoding work, and expands diagnostics for investigating dropped frames and freezes.

### Native screen encoding

- **Three encoding presets:** choose Balanced, Quality first or Latency first for supported Media Foundation and NVENC hardware encoders, and native software VP8, VP9, H.264 and AV1. Remember the choice separately for each encoder, including automatic selection. Preset changes apply to the next share; unsupported backend choices retain the balanced fallback. Browser encoders remain controlled by WebRTC.
- **Reuse frame conversions:** share compatible BGRA-to-NV12 conversions across hardware encoders, avoid copying encoded output without consumers, and bound the NVENC texture-registration cache when inputs come from multiple conversion pools.
- **Shared bitrate updates:** collect pending viewer bandwidth feedback before regrouping. A sole viewer or a whole group moving to the same bitrate bucket updates its encoder in place, preserving output continuity. Independent viewers split or rejoin on the next reconciliation without an extra upward-migration delay.
- **Capture-based timestamps:** preserve capture timing through encoder queueing and retries, with monotonic timestamps across group changes and static-frame refreshes.

### MCP settings and stream diagnostics

- **Saved video preferences:** add `screen.settings.get` and `screen.settings.update` to inspect supported encoders, codecs, presets and capture backends, and update selected video settings through the same preference store as Settings. Validate the complete patch before saving. Responses distinguish requested live updates from changes that apply to the next share; `screen.configure` remains available for temporary changes to one active track.
- **Diagnostics without OS automation:** make stream diagnostics available on desktop and browser peers independently of their automation and WebMCP switches. Remote access still requires device trust and the Reading and diagnostics permission. The local HTTP MCP listener still requires Enable MCP and a valid token.
- **More useful timing data:** report source-frame cadence, source age and copy time separately from encoder work. Add receiver processing time, jitter-buffer targets, decoder power-efficiency information when available, and page visibility to help distinguish capture, encoding, decoding and background presentation behavior. Unavailable measurements remain unavailable rather than being reported as zero.

### Permissions, localization and maintenance

- **Remember approval decisions:** add Always allow and Always deny to in-app automation approval notifications, saving the requesting device's policy for that permission group while resolving the current request. Session-only approval remains available.
- **Browser permission settings:** hide incoming remote-input controls when the local runtime cannot provide them, while retaining diagnostic permissions.
- **Localization:** add preset labels, concise preset descriptions and remembered-approval actions in all eight supported languages.
- **Windows installer icons:** use the application icon for both the NSIS installer and uninstaller.
- **Test tooling:** update the web and desktop Vitest dependencies to the patched 4.1.12 release.

## [1.3.0] - 2026-10-24

Weblink 1.3 adds verified device pairing and MCP/WebMCP automation for local and remote desktops, with clearer permissions, consistent control indicators, and more reliable screen streaming.

### Device pairing and permissions

- **Device identity:** authenticate browser and desktop profiles with signed connection proofs and renewable pairing keys. First-use pairing verifies and saves the device identity; subsequent connections must prove continuity with it. A display name, client ID or room password alone cannot replace a remembered identity.
- **Pairing repair:** request re-pairing from the device's permission settings and let the other device explicitly accept or reject through the existing notification flow. Identity changes and invalid proofs block application traffic until trust is restored. Partial key loss can recover automatically when surviving credentials verify the same device; ordinary connection failures preserve saved permissions.
- **Independent permissions:** manage receiving content, sharing screens, providing file lists, remote control and automation per device. Automation permissions are grouped into Reading and diagnostics, Sharing and control, and Terminal and commands. Requests use in-app or system notifications; approval lasts for the current connection, while Always allow and Deny follow saved settings.
- **Connection ownership:** signed signaling joins prevent an unverified duplicate client ID from replacing a verified room member. Update the pinned signaling submodules when self-hosting. Signaling retains legacy-client support without treating an invalid identity proof as a legacy connection.
- **LAN compatibility:** verify device identity and pairing on LAN HTTP using compatible P-256, SHA-256 and HMAC implementations when Web Crypto APIs or algorithms are unavailable. This does not remove browser secure-context requirements for media capture, clipboard access or other protected APIs.

### MCP and WebMCP automation

- **One tool catalog:** discover connected devices and streams, inspect or configure screen sharing, capture screenshots, control input, inspect Windows accessibility trees, run Shell tasks and collect diagnostics. Desktop provides a Streamable HTTP MCP endpoint, defaulting to `http://127.0.0.1:32100/mcp`; supporting browsers can register WebMCP tools and control connected desktop targets.
- **Separate switches:** Enable automation allows authorized tools to operate this computer. Enable MCP exposes the API and can remain enabled for discovery and forwarding while local automation is off. Browsers expose only the MCP switch and do not execute local OS input or Shell commands. Both switches default to off.
- **Local MCP tokens:** create named `sk-` credentials with configurable expiry or no expiry, copy the connection configuration at creation, and edit or revoke them later. Tokens authorize the local MCP entrypoint; remote targets still enforce their own paired-device permissions. Token expiration remains independent of session-based peer approvals.
- **Settings and approvals:** manage automation in Settings and per-device permissions, with approval requests in the existing notification system. Show reachable listener addresses and keep token management available while the MCP API is disabled.

### Automated input and screenshots

- **Direct desktop input:** after acquiring a monitor control lease, keyboard input goes to the foreground window and pointer input uses absolute physical desktop coordinates. Window binding is optional. An AI controller on the same verified device can borrow an existing manual-control grant instead of replacing it.
- **Session lifetime and emergency stop:** switching Weblink to the background keeps automation active. A bound target window losing focus or closing releases held input and ends that input lease without revoking saved permissions or MCP tokens. The existing host emergency-stop shortcut also stops automation, cancels pending approvals and command process trees.
- **Keyboard input:** send text, scan-code keys, chords and bounded sequences, with held keys and buttons released when their lease ends. Bound-window input reports focus loss when the window closes or can no longer receive input, including after Alt+F4.
- **Readable, bounded screenshots:** return PNG image content directly to MCP clients. Full-screen screenshots fit within 1024 × 1024 by default, with optional dimensions up to 2048 per axis. Capture a window or an absolute desktop rectangle for small-text detail. Lossless compression and a 4 MiB image budget limit payload size; image-to-desktop metadata keeps pointer coordinates consistent after cropping or resizing.
- **Consistent indicators:** show active AI control on both controller and host headers with a sparkle pointer and device name. Matching screen labels use the same icon, and borrowed manual control keeps a single status. Sharing, recording and control statuses consistently show an icon and name without avatars; local MCP status does not display token names.

### Shell commands

- **Background jobs:** run a command and wait briefly for its result, or start it in the background. Support up to ten concurrent jobs per device, bounded output retention, and cursor-based reads of stdout and stderr.
- **Input and signals:** `commands.send` writes stdin, closes it with EOF, or sends a supported signal. `commands.capabilities` queries the addressed device for its actual backend, stdin/EOF support and signal list. Jobs remain pipe-based, with no PTY; Windows supports process-tree termination with `SIGTERM` and `SIGKILL`, not Ctrl+C console interruption.
- **Windows encoding:** prefer `pwsh.exe`, falling back to `powershell.exe` only when the preferred executable is missing. Default console, pipeline and cmdlet encoding to UTF-8. Script failures are not retried in another shell. Shell execution uses the app account's privileges and is not a sandbox.

### Streaming, connections and storage

- **Shared native encoding:** reuse compatible native encoders across viewers and accelerate late-viewer startup with retained-frame/keyframe delivery. Clean up failed shared encoders atomically so stale instances cannot block recovery.
- **Codec recovery:** retry compatible native codecs after receiver decode failures and renegotiate Media Foundation output-format changes. Improve video playback and offline-peer reconnection, retain valid RTC configuration, and refresh ICE configuration before replacement connections.
- **Stable file storage:** retain storage ownership while the library refreshes so active file operations keep using their selected storage.
- **Local configuration:** keep MCP token hashes and listener settings in the current WebView's localStorage, with native validation and execution. Local `tauri dev` uses an isolated WebView profile; built development and stable applications retain the existing profile location.

### Upgrading

- Use 1.3.0 on both endpoints for the new device-pairing and automation flows. Peers must complete identity verification before protected application traffic is allowed; old clients without automation capability cannot use MCP tools over WebRTC. See [device pairing](docs/DEVICE_TRUST.md).
- Update self-hosted signaling from the revisions pinned by this release, then follow the existing [deployment instructions](docs/DEPLOYMENT.md). Legacy signaling support does not bypass endpoint permissions.
- Local `tauri dev` now uses a separate profile from built applications. Existing built-app storage locations and file-library contents are unchanged.
- Read the [automation setup guide](docs/AUTOMATION.md#quick-start) before enabling MCP or granting remote automation permissions.

## [1.2.0] - 2026-10-18

Weblink 1.2 introduces local and remote video recording, a unified file library backed by browser storage or real directories, and more efficient Windows screen encoding.

### File storage and transfers

- **Choose where files live:** Web defaults to IndexedDB and can mount a user-selected directory in supported browsers. Windows desktop defaults to a real local directory. Imports and received files go directly into the selected directory, without an extra `Weblink Files` subfolder. Changing the default affects new files; existing files and active transfers retain their original storage.
- **One file interface:** file listing, lifecycle, preview, saving and location actions use the same VFS contracts for IndexedDB, browser directories and native directories. Directory contents are synchronized into the library, including files added or removed outside Weblink. Changing directories refreshes the cache view, and confirmed deletions remove stale entries and content indexes.
- **Automatic IndexedDB migration:** migrate legacy file databases into the new paged storage with visible copy and verification progress. Preserve completed files and resumable chunks, and delete each old file database only after the migrated data has been verified. Failed migrations retain the old data for retry; migration does not move files into the newly selected directory.
- **Resumable directory files:** unfinished transfers use a protective `.part` suffix and keep their resume metadata in the file itself. Incomplete files remain visible as unfinished and cannot be previewed or shared. Hide dot-prefixed entries and browser `.crswap` transaction files from directory lists.
- **Browser filename compatibility:** when a browser rejects a filename while creating a directory file, retry with a `.weblink` suffix. The file list and transfers retain the original filename; native directory storage does not add this suffix. Permission, write and final-save errors still report their actual failure rather than being treated as filename restrictions.
- **Faster completion and clearer failures:** reuse successful full-file verification for the same unchanged file version, reduce duplicate reads after large transfers, discard stale cache references, and include file, processing stage and underlying storage error details in import failures. Restore directory authorization through an explicit user action when the browser requires it after reload.
- **LAN HTTP compatibility:** use the existing UUID fallback for saving and legacy migration when secure-context `crypto` APIs are unavailable. Browser permissions and secure-context requirements for directory access and media capture still apply.

### File actions and previews

- **Storage-aware actions:** IndexedDB files offer Save to device; directory files offer Save As. Windows files can be opened with their system application or revealed and selected in Explorer from file and message menus. Keep image/video preview controls where available, and keep the cache dialog for inspecting unfinished files.
- **Batch saving:** select one destination directory for a batch, see the current filename and progress, and cancel remaining work. Name collisions offer overwrite, skip or keep both, with an apply-to-all option. A separate confirmation toast pauses progress and uses the existing background notification flow.
- **Background imports and saves:** closing the file-cache dialog does not cancel ongoing imports or saves. Progress and collision confirmations remain available until completion or explicit cancellation; import progress now includes a progress bar.
- **Cleaner file lists and messages:** add a list-header selection checkbox, make Import directly accessible, remove redundant availability labels, and keep message bubbles to at most two primary actions. Additional actions, including group-file details and Open location, live in the context menu.
- **Reliable previews:** preview paged VFS files through cancellable URLs, add cached video thumbnails, and avoid duplicate file rows and unnecessary repeated thumbnail refreshes.

### Recording

- **Record one source:** record a selected local or remote camera or shared screen with only its associated audio, on both Web and Windows desktop. Pause and resume into the same file, then stop and save. Source removal, replacement or leaving the meeting ends the recording without stopping the original meeting tracks.
- **Compact controls:** start recording from the video menu and manage pause, resume and save in the header status. Show the participant avatar and source name, mark the recorded tile, and keep recording independent of open menus or the file-cache dialog.
- **Save completion notifications:** announce a recording only after saving and file-library verification succeed. The shared notification flow chooses an in-app toast or background system notice without repeating it on return. Open the recording in Web preview or the desktop system application; notification settings include a recording category and respect filename-preview and sound preferences.
- **Continuous VFS writing:** append recording data to the storage chosen when recording starts. Changing the default directory does not redirect an active recording. Show one unfinished library entry while writing a `.recording.part` file, then finalize its metadata and register the completed file without importing it again.
- **Reuse existing encoded media:** share video/audio frame subscription, muxing and file writing across Web and Tauri. Reuse supported sender and receiver video in H.264, H.265, VP8, VP9 and AV1, and audio in Opus, G.722, PCMU and PCMA. Windows native screen recording can subscribe directly to its connected H.264/H.265 hardware sender and encoded audio; unavailable audio reuse retains the PCM encoding fallback.
- **Automatic fallback:** when encoded frames, codec configuration or required APIs are unavailable during preparation, retain the MediaRecorder path and the native local-receiver fallback. Prefer hardware-capable local capture where supported, adapt fallback bitrate to the source, and avoid forcing received media through another video encoder when reuse is available.
- **Container preference:** choose Automatic, MKV or MP4. Automatic uses MP4 for H.264/H.265 and MKV for other supported video codecs; G.722, PCMU or PCMA audio also selects MKV to retain the encoded audio. Explicit MP4 can use the audio-encoding fallback for these audio formats while retaining video reuse. MediaRecorder output is remuxed to the selected container without silently dropping tracks.
- **Duration, seeking and bounded buffering:** write duration and seek metadata, preserve the last data block when stopping, resume on a keyframe, and remove paused time from both tracks. Limit queues between capture, muxing and storage; slow or failed recording writes stop recording instead of blocking normal stream delivery or growing memory without bound.

### Windows capture and encoding

- **GPU texture input:** H.264 and H.265 share the D3D11 texture path from DXGI or Windows Graphics Capture through GPU color conversion and scaling into NVENC or Media Foundation. Supported paths avoid the GPU-to-CPU-to-GPU frame round trip. Preview, diagnostics and software encoders read back only when needed; incompatible devices or drivers retain the memory-input fallback.
- **Native NVIDIA encoding:** probe H.264/H.265 NVENC sessions on the capture adapter and prefer them when supported. Missing or incompatible drivers and initialization or runtime failures retain the Media Foundation fallback. Intel and AMD continue using their available Media Foundation encoders. Stream statistics report the active implementation, including changes after fallback.
- **Match the capture adapter:** automatic hardware selection prefers an encoder on the GPU that produced the captured texture, for the negotiated codec. Include encoders on secondary adapters during discovery, retain explicit encoder choices, and report the actual adapter selection and fallback reason. Matching occurs during initialization or reconfiguration, not for every frame.
- **Shared variable frame rate:** software and hardware screen encoders use the same change-driven scheduling and bounded refresh behavior for static content. Keep frame-rate limits, live settings, keyframe requests and recording subscriptions working across the GPU and memory paths.
- **Smoother local preview:** reuse readback and cursor-composition buffers while waiting for the page to consume a frame, avoid redundant full-frame initialization, and submit notified frames without an additional animation-frame wait. Hidden previews still release their buffers and resume from the latest content; GPU streaming continues independently.
- **Reusable native media core:** separate recording lifetime, pause/resume, codec validation and encoded-audio observation from the Windows capture adapters. This prepares the interfaces for future platforms; native Linux and macOS capture backends are not included in this release.

### Interface and updates

- Unify toast layout, icons, progress and action styling across notifications and file operations.
- Compact mobile meeting and recording statuses, use icon actions, and allow the status area to scroll horizontally without wrapping neighboring header controls.
- Stable Windows builds check for updates at startup and hourly when automatic checks are enabled. Retain pending update reminders across hidden-window periods and failed checks, without repeating notices already delivered. Downloading and installing still require user confirmation.

### Compatibility and storage notes

- Windows desktop remains Windows 10 22H2 / Windows 11 x64 with WebView2 120 or newer. GPU input and adapter selection depend on the available driver, capture device and NVENC or Media Foundation encoder; they do not guarantee hardware support on every Intel, AMD, NVIDIA or multi-GPU configuration.
- Directory mounting in Web requires browser support and explicit permission. Files remain local to the selected storage; browser and desktop profiles do not synchronize automatically. Batch directory saving also depends on the available picker APIs.
- Recording supports one source at a time. Container choice does not make unsupported codecs playable in every external player. Browser-directory finalization can still require a streaming copy; an unfinished recording is not guaranteed to be playable or recoverable after a crash or forced shutdown.

## [1.1.1] - 2026-10-15

Weblink 1.1.1 adds configurable file transfer queuing, improves long-message reading, and makes room invitations and notifications more consistent.

### File transfers

- **Configurable concurrency:** Settings → Transfer now lets you choose how many files transfer at once, from 1 to 10, with a default of 3. Additional transfers wait in a first-in, first-out queue. Changes apply immediately; lowering the limit lets running transfers finish.
- **Visible, cancellable queues:** chat attachments, shared files and the task list show queued transfers with cancel controls. File rows remain stable as transfer indicators change.
- **Reliable queue handling:** waiting for a transfer slot does not consume the transfer startup timeout. Slots remain occupied through saving and merging, and are released when a transfer finishes, fails or is cancelled. Coordinate admission at both ends so simultaneous transfers in opposite directions can make progress.
- **Compatibility:** queuing requires support from both peers. Compatible clients without queue support continue using the existing transfer behavior, so their transfers are not held to the configured concurrency limit.

### Chat and meeting views

- **Expandable long messages:** long text messages initially show a compact preview with a Show more action. Expanding preserves the conversation's scroll position, and previews keep emoji and combined characters intact.
- **Grouped room messages:** keep sender avatars visible alongside their message groups while scrolling, and preserve existing message elements when older history is loaded or messages are deleted.
- **Accurate screen labels:** show the monitor icon and screen-source label only on shared-screen tiles, avoiding misleading screen labels on camera tiles.

### Joining rooms

- Open the profile and room setup flow when joining for the first time or when required details are missing.
- Open shared room invitations in the room editor with their connection details filled in, even when automatic joining is disabled. Skip the first-launch About dialog when following an invitation.
- Clear a previously saved password when an invitation points to a room without a password, and remove the duplicate join button from the local preview notice.

### Notifications

- **One reminder per event:** coordinate in-app toasts and system notifications so switching between visible and hidden windows does not repeat an already delivered reminder. This covers remote-control requests, speed-test requests, remote file transfers and desktop update notices.
- **Quieter chat:** show system message notifications only while the application is hidden. Remove the separate background-only toggle; message preview, sound and category preferences remain available.
- **Working notification actions:** opening a notification can bring the application forward without invalidating its action. Browsers without notification action buttons can open remote-control and speed-test approval dialogs, while expired or cancelled requests are ignored.
- Recheck visibility and notification preferences during asynchronous delivery, withdraw stale notifications, and update transfer progress without creating duplicate reminders.

## [1.1.0] - 2026-10-13

Weblink 1.1.0 brings native Windows screen sharing and remote control. View and operate a Windows desktop from another computer or phone while chatting, meeting and exchanging files in the same session. This release also improves desktop window behavior, notifications, update checks and localization.

#### Screen sharing and remote control

- **Native Windows sharing:** choose and preview a display or window, use DXGI / Windows Graphics Capture and system audio on supported systems, and select available software or H.264 / HEVC hardware encoders.
- **Cross-device input:** browser and desktop clients can request Windows display viewing or control, with mouse, keyboard, cursor appearance synchronization and pointer capture. Mobile clients support trackpad and direct-touch modes, gestures, software keyboards and IME input, with optional keyboard visibility following remote text focus.
- **Consent and occupancy:** approve requests individually, remember allow/deny rules and configure control discovery. Multiple users may request access, but only one controller is granted access at a time; other peers see the occupied state. Input-release and emergency-revocation shortcuts are customizable.
- **Optional gamepad forwarding:** standard-mapped controllers, stick dead zones, basic dual-motor vibration and strength controls are supported when the Windows host has an available ViGEmBus driver. Keyboard and mouse remain available if gamepad forwarding fails.
- **Media controls:** change resolution, frame rate and bitrate while sharing; configure high-refresh options, audio formats, SDR color and stream statistics. Automatic encoding selects a common format across connected receivers and renegotiates when membership changes.

#### Clipboard and file exchange

- **Opt-in clipboard synchronization:** transfer text, rich text, images and files according to the browser's actual read/write capabilities. Copy received files to the clipboard or local library, convert folders to ZIP and track or cancel transfers.
- **Remote file drops:** drag local files into compatible applications on the controlled Windows screen and wait for remote acceptance. File drops and clipboard file transfers share a per-operation limit of 64 MiB by default, configurable up to 512 MiB.
- **Native desktop saving:** attachments, library files, media previews and QR codes use Save As, initially opening the system Downloads directory with the original filename. Automatic downloads save received files there and number filename collisions.
- **Image filenames:** dragging a chat image out to save it carries its real filename and extension instead of the temporary blob URL's ID.

#### Desktop, rooms and interface

- **Windows and notifications:** tray controls, close actions, launch-at-login settings, optional hiding after control approval and resizable, always-on-top native picture-in-picture. Unified message, request and transfer notifications include preview/sound settings and Windows inline replies or request actions.
- **Stable-release update checks:** Settings → About offers manual checks and an enabled-by-default startup-check switch. Available updates produce a toast and follow system notification preferences; checking never downloads or installs automatically. Installed builds verify the update signature before a user-confirmed installation and restart. Portable builds link to the matching release ZIP for manual replacement.
- **Room management:** saved recent rooms, unified client/room permissions and activity-based ordering. Automatic-download size limits move into shared transfer settings while retaining per-room switches.
- **Eight languages:** English, Simplified Chinese, Traditional Chinese, Japanese, Korean, Spanish, French and German, with system language/theme preferences. Improved responsive settings, keyboard focus and fullscreen/touch meeting controls.
- **Marketing website:** a separate site with English app screenshots in desktop and phone frames demonstrating remote desktops, meetings, chat and shared files; eight languages, light/dark themes, an automatic carousel and a latest-release desktop download entry.

#### Stability and fixes

- Release retired encoders before replacing streams so additional receivers and automatic codec changes do not leave new screens unable to load.
- Fix remote file hover, permission failures and unexpected drag interruptions. Keep only the latest pending position during movement, acknowledge startup and final drop, and prevent stale positions from changing the destination.
- Fix receiving copied remote image files in browsers. Limited clipboard file mode supports PNG/JPG and remains separate from file-cache mode.
- Fix desktop resume deadlocks, stale autostart paths and native sharing recovery; improve input recovery after congestion, disconnection, fullscreen and focus changes, releasing stale held keys and contacts.
- Fix desktop attachment/library downloads that did nothing, stalled file retries, premature remote-drop completion and hidden clipboard actions on browsers with limited capabilities.
- Derive avatar initials from original names, unify video labels and control/permission states, and repair picture-in-picture restoration, fullscreen overlays and request actions while dialogs are open.
- Correct stream color metadata and duplicate encoders. Generate previews on demand, pause hidden previews/diagnostics, wake native workers on events and reduce desktop package size.
- Restore password-protected rooms over LAN HTTP and improve cleanup and retries after connection or file-decoding failures so late results cannot affect paused or replaced work.

#### Installation, upgrades and compatibility

- Windows desktop targets **Windows 10 22H2 / Windows 11, x64**. Stable releases provide an installer and portable ZIP. The installer provisions WebView2 when needed; portable builds require WebView2 120+ and must retain the `weblink-portable` marker beside the executable.
- Native hosting currently requires Windows. Display shares support remote control; window shares remain view-only. Input requires host consent or a saved allow rule. Gamepads also depend on controller mapping, browser support and host drivers; Weblink does not install drivers automatically.
- HEVC requires a compatible hardware encoder and a WebRTC H.265-capable receiver. Native streaming remains **8-bit SDR YUV 4:2:0**, without HDR or RGB/4:4:4 modes. Resolution and frame-rate settings are limits, not throughput guarantees.
- **Upgrade clients participating in a session together.** Versioned feature negotiation replaces the unversioned protocol without a legacy fallback. Older clients may appear online while chat, file or control features remain unavailable. Self-hosted signaling servers must also support version 2 join acknowledgments.
- In-app updates apply to stable Windows builds; development builds do not check for or install stable updates. Installation ends active sessions and restarts the application; portable builds remain manually replaceable. Web and desktop share the application version, and release notes include version-specific installer and ZIP links.

## [1.0.7] - 2026-09-29

### Improvements

- Add the first Tauri desktop shell and shared platform abstraction, including Windows build automation, desktop-specific runtime handling, and packaged application assets 新增首个 Tauri 桌面端外壳与共享平台抽象，包括 Windows 构建流程、桌面运行时处理及应用打包资源
- Add native capture diagnostics and development tooling for the desktop app, with Windows capture backend probes, synchronized workspace tooling, configuration UI, and automated tests 新增桌面端原生采集诊断与开发工具，包括 Windows 采集后端探测、workspace 同步工具、配置界面及自动化测试
- Centralize conversation message persistence behind a shared repository contract so browser storage, chat history, delivery state, and transfer-related message updates follow one persistence path 将会话消息持久化统一到共享 repository 契约，使浏览器存储、聊天历史、送达状态及传输相关消息更新走同一持久化路径
- Add real-browser persistence and private-messaging regression checks to CI to cover IndexedDB and WebRTC messaging behavior that unit tests cannot fully reproduce 在 CI 中加入真实浏览器的持久化与私聊回归检查，覆盖单元测试难以完整复现的 IndexedDB 与 WebRTC 消息行为

### Fixes

- Persist private messages correctly after joining a room and keep conversation history available when room membership changes 修复加入房间后私聊消息未正确持久化的问题，并在房间成员状态变化时保持会话历史可用
- Guard browser messaging and persistence against stale, deleted, or mismatched records so retired asynchronous writes cannot recreate removed messages or corrupt active conversations 加强浏览器消息与持久化边界，避免过期、已删除或不匹配的记录通过异步写入重新生成消息或影响当前会话

## [1.0.6] - 2026-09-27

### Improvements

- Load managed TURN credentials from the signaling service instead of embedding managed TURN secrets in the web build, while preserving user-configured STUN and additional TURN servers 改为从信令服务获取托管 TURN 临时凭据，不再将托管 TURN 密钥嵌入前端构建，同时保留用户自定义 STUN 与额外 TURN 服务器
- Separate meeting audio sources from video presentation and simplify the media protocol so microphone, screen audio, and other remote audio sources are tracked and rendered independently 将会议音频源与视频展示分离，并简化媒体协议，使麦克风、屏幕音频及其他远端音频源可独立跟踪和播放
- Unify private and room conversation messaging around shared submission, delivery, retry, draft, and projection services for more consistent chat behavior 统一私聊与群聊的消息提交、送达、重试、草稿和投影服务，使不同会话的聊天行为保持一致
- Unify file drag-and-drop imports across chat, shared files, and the local library, including shared import handling and consistent drop feedback 统一聊天、共享文件及本地文件库的拖放导入流程，共用导入处理并保持一致的拖放反馈
- Refine toast presentation with dedicated icons and styling for clearer application feedback 优化 Toast 的图标与样式，使应用反馈更清晰

### Infrastructure

- Reorganize Weblink as a workspace with the web app under `apps/web` and signaling implementations tracked as server submodules 将 Weblink 重组为 workspace，Web 前端迁移至 `apps/web`，并以 server submodule 管理信令实现
- Unify workspace dependency installation, local development commands, CI paths, Docker builds, and deployment documentation around the new repository layout 统一新仓库结构下的依赖安装、本地开发命令、CI 路径、Docker 构建及部署文档

## [1.0.5] - 2026-09-25

### Improvements

- Rework meeting panel navigation around routed sidebar state, shared-file views, and stable wide-panel behavior so chat, files, people, and room information transition consistently 重构会议侧栏路由状态、共享文件视图及宽面板状态，使聊天、文件、成员和房间信息之间的切换保持一致
- Refine meeting source presentation, picture-in-picture behavior, responsive media layouts, and layout transitions while preserving scroll position during size and route changes 优化会议画面呈现、画中画、响应式媒体布局及布局过渡，并在尺寸和路由变化时保持滚动位置
- Unify private and room conversation history rendering, stabilize chat composer auto-resize, and present file-transfer progress consistently across messages and the task list 统一私聊和群聊的历史消息窗口，稳定聊天输入框自动尺寸调整，并统一消息与任务列表中的文件传输进度显示
- Simplify peer negotiation and connection ownership, move recovery to signaling-driven peer-online events, and retain peer profile information while connections are being restored 简化 P2P 协商与连接所有权，以信令驱动的 peer-online 事件恢复连接，并在重连过程中保留对端资料

### Fixes

- Restore Safari file-transfer compatibility, including safer abort handling and cache merging during transfer completion 恢复 Safari 文件传输兼容性，包括更可靠的取消处理和传输完成时的缓存合并
- Stabilize file drag-and-drop state across nested controls and prevent stale forbidden-drop state from remaining after leaving the target area 稳定嵌套控件中的文件拖放状态，避免离开不可拖放区域后错误状态残留
- Prevent message galleries and media previews from reopening after close animations, and cancel interrupted native layout animations safely 修复消息图片预览和媒体预览在关闭动画后再次打开的问题，并安全处理被中断的原生布局动画
- Improve reconnect behavior, connection logging, and session replacement so stale asynchronous work cannot disrupt the active peer connection 改进重连、连接日志及会话替换流程，避免过期异步任务影响当前有效的 P2P 连接

### Compatibility Notes

- Remove Firebase signaling support and keep WebSocket signaling as the single supported signaling path 移除 Firebase 信令支持，仅保留 WebSocket 作为统一信令通道
- Remove the unreliable chat capture action from the composer 移除稳定性不足的聊天拍照入口

### Infrastructure

- Add continuously deployed development builds at `dev.webl.ink`, gate development and production deployments on the shared CI checks, and simplify Cloudflare Pages production deployment 新增持续部署到 `dev.webl.ink` 的开发构建，让开发及正式部署统一依赖 CI 检查，并简化 Cloudflare Pages 正式部署流程
- Pass `VITE_TURN_SERVERS` through Docker builds and keep development/production Pages builds supplied through their environment-specific build configuration Docker 构建支持传入 `VITE_TURN_SERVERS`，开发及正式 Pages 构建继续通过各自环境配置注入前端构建变量

## [1.0.4] - 2026-09-24

### Improvements

- Expand file drag-and-drop to the full private and room chat surface, add room file uploads, and keep the drop overlay minimal with a stable fade transition 将文件拖放范围扩展到整个私聊和群聊界面，新增群聊文件上传，并以稳定的淡入淡出保持拖放提示简洁
- Pre-bundle `hash-wasm` and `fflate` during Vite development startup and isolate browser smoke-test dependency caches to avoid invalidating the active development server 在 Vite 开发启动时预构建 `hash-wasm` 与 `fflate`，并隔离浏览器冒烟测试的依赖缓存，避免使正在运行的开发服务器缓存失效

### Fixes

- Snapshot nested reactive file metadata before IndexedDB writes so Solid store proxies cannot trigger `DataCloneError` when caching fingerprints, aliases, content records, or references 在写入 IndexedDB 前快照嵌套的响应式文件元数据，避免 Solid store 代理在缓存指纹、别名、内容记录或引用时触发 `DataCloneError`
- Make fingerprint worker failures actionable, preserve native worker errors and source locations, handle deserialization failures, and allow retries with a fresh worker 改进文件指纹 Worker 错误处理，保留原始异常与脚本位置，处理反序列化失败，并允许使用新的 Worker 重试
- Stabilize drag enter/leave handling across nested chat elements so the upload background and native drag cursor no longer flicker when moving through the interface 稳定嵌套聊天元素间的拖入拖出状态，避免拖动文件经过界面时上传背景和原生拖拽光标反复闪动

## [1.0.3] - 2026-09-24

### Improvements

- Keep local camera, microphone, and screen capture running when leaving a room, and reuse live tracks when rejoining without reopening sources that were explicitly stopped 离开房间时保留本地摄像头、麦克风及屏幕采集，重新加入时复用仍在运行的轨道，不重新打开已明确停止的来源
- Keep the Join room and Edit room actions together in the local preview notice 优化本地预览提示中的按钮排列，让“加入房间”和“编辑房间”保持成组显示

### Fixes

- Restore room and peer connections after temporary signaling interruptions, publish socket readiness before replaying membership events, and discard stale sessions after server resume expiry 修复短暂信令断开后的房间与成员连接恢复，在回放成员事件前更新连接状态，并在服务端会话恢复失效后清理旧会话
- Resolve simultaneous reconnect negotiation collisions and restore camera, screen, audio, and messaging channels while preventing retired asynchronous work from disconnecting a replacement connection 修复双方同时重连时的协商冲突，恢复摄像头、屏幕、声音和消息通道，避免旧异步任务破坏新连接
- Defer initial video attachment until the meeting view is visible, and refresh inline playback after visibility, native picture-in-picture, fullscreen, or decoded-size changes without replacing the received stream 将视频首次绑定延后到会议画面可见时，并在可见性、原生画中画、全屏或解码尺寸变化后恢复页面内播放，保留原接收流

### Compatibility Notes

- iPhone Safari device verification remains pending; the inline-playback changes target the reported case where screen sharing plays in native picture-in-picture but appears black in the page iPhone Safari 真机验证仍待完成；本次页面内播放修复针对屏幕共享在原生画中画中正常、但在页面中黑屏的反馈

## [1.0.2] - 2026-09-24

### Improvements

- Automatically restore a waiting tab's room connection when the active tab closes or leaves; allow only one waiting tab to reconnect while preserving explicit takeover and keeping stopped capture devices off 当前使用的标签页关闭或退出房间后，自动恢复等待页面的房间连接；多个页面等待时只恢复一个，保留手动接管操作，已停止的采集设备保持关闭
- Automatically feature a mobile video after native picture-in-picture entry succeeds, using the existing layout transition and retaining its selection on exit 移动端视频成功进入独立画中画后，自动切换为主画面并沿用现有过渡，退出画中画后保留主画面选择
- Hide layout switching and pin controls when there is only one rendered source; use a single-row icon-and-label layout for mobile sidebar tabs and refine unread badge spacing 仅有一个画面时隐藏布局切换及固定按钮，移动端侧栏 tab 的图标与文字改为单行显示，并调整未读标记间距

### Fixes

- Recover paused live-video playback when the first frame becomes ready, a received track resumes, or the video becomes visible again, without replacing the received stream or stopping its tracks 在首帧就绪、接收轨道恢复或画面重新可见时恢复已暂停的视频播放，保留原接收流及轨道
- Distinguish autoplay denial from generic video errors and retain a translated Play video action for manual recovery, with Simplified Chinese, Traditional Chinese, and English messages 区分自动播放被拦截与普通视频错误，保留可手动恢复的“播放画面”操作，并补齐简体中文、繁体中文和英文提示

### Compatibility Notes

- iPhone Safari device verification remains pending; the reported black screen on initial screen-share reception is not yet confirmed resolved iPhone Safari 真机验证仍待完成，尚未确认已解决反馈中的首次接收屏幕共享黑屏问题

## [1.0.1] - 2026-09-24

### Improvements

- Add independent native video picture-in-picture controls to supported videos in the mobile layout, with an in-place notice and restore action; retain document picture-in-picture as a separate meeting feature 在移动端布局中为支持的视频添加独立画中画按钮，进入后显示原位提示及恢复操作，文档画中画继续作为独立会议功能
- Request landscape or portrait orientation from the actual video aspect ratio in fullscreen, follow video rotation, and release the orientation lock on exit when the browser supports it 全屏时根据实际画面比例请求横屏或竖屏，跟随视频方向变化，并在退出时释放浏览器支持的方向锁定
- Detect screen-sharing and picture-in-picture capabilities from available APIs and localize browser error feedback 根据实际 API 检测屏幕共享与画中画能力，并本地化浏览器错误提示

### Fixes

- Fix mobile page height overflow when browser address bars or the keyboard change the visible viewport 修复移动端浏览器地址栏或键盘改变可视区域时的页面高度溢出
- Prevent repeated WebSocket reconnects caused by competing tabs for the same room identity; show a full-page notice with an explicit switch-to-this-page action that releases the previous page's meeting and capture resources 修复相同房间身份在多个标签页之间争抢连接导致的反复重连，新增整页提示及“切换到此页面”操作，并释放原页面的会议与采集资源
- Correct signaling socket replacement order and recheck connection state after asynchronous encryption to avoid sending through a closed socket 修正信令连接替换顺序，并在异步加密后重新检查连接状态，避免向已关闭的 WebSocket 发送数据

## [1.0.0] - 2026-09-24

Weblink 1.0 is a major update with a complete interface redesign, online group
chat, and a shared file library. Weblink 1.0 是一次重大更新，带来完整界面重构、在线群组聊天和共享文件库。

### Major Changes

- Completely redesign the interface around a unified meeting workspace, with chat, members, shared files, and live room information in a responsive sidebar; open the file library, settings, and transfer tasks in dialogs without leaving the meeting 完整重构界面，以统一会议工作区为中心，通过响应式侧栏查看聊天、成员、共享文件及在线房间信息，并在弹窗中管理文件库、设置和传输任务
- Add online room group chat alongside private conversations, including text, file attachments, forwarding, per-member delivery status, and locally stored history 新增在线房间群组聊天，与私聊并行使用，支持文字、文件附件、转发、成员送达状态及本机历史记录
- Introduce a content-deduplicated local file library and one shared file list across rooms; browse a member's shared files with search, sorting, pagination, previews, and batch downloads 新增按内容去重的本机文件库及跨房间共用的共享清单，支持浏览成员共享文件、搜索、排序、分页、预览及批量获取
- Add explicit sharing controls, file and folder imports, and automatic sharing for newly sent files; shared content remains available independently of chat history 新增共享开关、文件及文件夹导入，新发送的文件自动开启共享，共享内容独立于聊天记录保留
- Fetch shared files directly into the local library and task list without creating chat messages; support progress, pause, resume, cancellation, and reuse of already available content 获取共享文件直接进入本机文件库和任务列表，不产生聊天消息，支持进度、暂停、继续、取消及复用已有内容

### Improvements

- Refine meeting layouts, screen sharing, picture-in-picture, sidebar transitions, and mobile resizing behavior 优化会议布局、屏幕共享、画中画、侧栏过渡及移动端尺寸切换
- Add member shortcuts for private chat and temporary audio muting, plus room-wide control of locally received audio 新增成员私聊与临时静音快捷操作，并支持统一控制本机接收的房间声音
- Separate microphone, speaker, and camera permission controls; improve device discovery, default-output behavior, and permission feedback across browsers 分离麦克风、扬声器与摄像头权限控制，改善跨浏览器设备发现、默认输出及授权反馈
- Unify empty chat states and user-facing error messages, complete translations, and improve file selection and preview behavior 统一聊天空状态与用户可见错误提示，补全翻译，并优化文件选择及预览体验

### Upgrade Notes

- Room messages are delivered to currently connected members; history remains in each browser, with no server-side message or file storage 房间消息仅发送给当前在线成员，历史记录保存在各自浏览器，服务器不保存聊天消息或文件
- Existing cached files stay private after upgrading; importing or receiving a file does not automatically share it 升级前已有缓存默认不共享，仅导入或接收文件不会自动开启共享
- Shared directories expose only complete, explicitly shared content; access is checked again when fetching, and peers must support the shared-file protocol 共享目录仅展示完整且已开启共享的内容，获取时会再次校验权限，双方需支持共享文件协议

### Privacy

- Remove names and avatars from signaling presence entirely; exchange profile metadata only through WebRTC 信令在线信息完全移除名称和头像，个人资料仅通过 WebRTC 交换

### Infrastructure

- Add a GitHub Actions workflow for Cloudflare Pages deployments from stable version tags, with version checks, tests, and production builds before upload 新增基于正式版本 tag 的 Cloudflare Pages 部署工作流，上传前执行版本校验、测试及生产构建
- Document the Cloudflare Durable Object signaling service, fixed deployment endpoint, validation, and rollback workflow 补充 Cloudflare Durable Object 信令服务、固定部署地址、验证及回滚流程文档

## [0.13.0] - 2026-08-31

### Privacy

- Exchange display names and avatars through the WebRTC DataChannel while signaling publishes only anonymous presence metadata 通过 WebRTC DataChannel 交换显示名称和头像，信令仅发布匿名在线元数据

## [0.12.0] - 2026-02-05

### Refactors

- Refactor file transfer into FileSender/FileReceiver and manage via transfer-service 拆分文件传输为 FileSender/FileReceiver 并由 transfer-service 统一管理

- Replace WebRTCContext with AppStateContext and unify session/message/cache state 用 AppStateContext 替换 WebRTCContext 并统一管理会话/消息/缓存等状态

- Introduce RTC protocol layer (rtc-service + rtc-protocol) with ACK/dedup/timeout and add tests 引入 RTC 协议层（rtc-service + rtc-protocol）实现 ACK/去重/超时，并补充测试

### Improvements

- Outbound messaging now uses protocol request with unified error handling 发送消息统一走协议层 request 并统一错误处理

### Fixes

- Fix resumed transfer initial speed spike on sender side 修复发送端断点续传初始速度异常偏大的问题

### Chores

- Switch package manager to Bun (add bun.lock, remove pnpm-lock) 切换包管理器到 Bun（新增 bun.lock，移除 pnpm-lock）

## [0.11.4] - 2025-12-30

### New Features

- Add manual settings for preferred encoder 添加手动设置首选编码器

## [0.11.3] - 2025-08-29

### New Features

- Add camera capture button in chat bar 添加聊天栏的摄像头捕获按钮

### Fixes

- Fix some UI issues 修复部分 UI 问题

## [0.11.2] - 2025-03-17

### Improvements

- Improve the video loading experience 改善视频加载体验

## [0.11.1] - 2025-02-05

### New Features

- Add grid layout, support drag and resize 添加网格布局，支持拖动和调整大小

- Add pause file transfer feature 添加暂停文件传输功能

## [0.10.6] - 2025-01-26

### New Features

- Add video constraints modification 添加视频约束修改功能

### Bug Fixes

- Fix the video max bitrate not working 修复了视频最大比特率不工作的问题

## [0.10.5] - 2025-01-14

### Bug Fixes

- Fix the bug that the remote stream cannot be removed correctly 修复了远程流无法正确更新的问题

## [0.10.4] - 2025-01-05

### Improvements

- Improve the encryption performance when using crypto-js 优化使用 crypto-js 时的加密性能

## [0.10.3] - 2024-12-14

### New Features

- Screen Sharing: Add volume indicator 屏幕共享添加音量指示器

- Screen Sharing: Add Mute button 屏幕共享添加静音按钮

- Screen Sharing: Add media selection dialog 屏幕共享添加媒体选择对话框

- Screen Sharing: Add media constraints control 屏幕共享添加媒体约束控制

- Screen Sharing: Add global audio player 屏幕共享添加全局音频播放器

- Screen Sharing: Add fullscreen and pip mode 屏幕共享添加全屏和画中画模式

## [0.9.2] - 2024-12-09

### New Features

- Add starter message 添加开始指引

### Improvements

- Improve the UI of the client page 优化客户端页面 UI

- Improve the video message UI 优化视频消息 UI

## [0.8.0] - 2024-11-29

### New Features

- Add share file feature 添加分享文件功能

### Improvements

- Improve the connection stability 改善连接稳定性

- Automatically try to reconnect when the connection is lost 自动尝试重新连接

## [0.7.5] - 2024-11-26

### New Features

- Add progress display in file list 在文件列表中添加进度显示

- Add double click to preview file in file table, and request file when status is not_started or stopped in sync page 在文件表中添加双击预览文件功能，当状态为 not_started 或 stopped 时在同步页面请求文件

### Improvements

- Improve the input label style 优化输入标签样式

- Improve the file table status display 优化文件表的状态显示

- Improve the file processing function, now can abort the file processing 优化文件处理功能，现在可以中止文件处理

- Improve the chat interface for loading more message on scroll 优化消息滚动加载的聊天界面

### Bug Fixes

- Fix the bug that check ice server availability works incorrectly 修复了检查 ICE 服务器可用性不正确的问题

- Fix the bug that the file transfer status is displayed incorrectly when starting 修复了文件传输状态在开始时显示不正确的问题

## [0.6.5] - 2024-11-14

### New Features

- Add file sync feature, now you can get the files cached by the peer 添加文件同步功能，现在可以获取对方缓存的文件

- Add strong password generation function 添加强密码生成功能

### Improvements

- Improve the file search function 优化文件搜索功能

- Using crypto-js for encryption in non-secure contexts 在非安全上下文中使用 crypto-js 进行加密

- Add sender resume file feature 添加发送端恢复传输功能

- Improve the UI of sending message 优化消息的 UI

### Bug Fixes

- Fix the bug that the file chunk cannot be received when resuming 修复了续传时文件区块接收的问题

- Fix the bug that messageChannel is undefined 修复了 messageChannel 未定义的问题

## [0.5.0] - 2024-11-04

### New Features

- Add Share Target API support, you can share files to Weblink from other apps 添加 Share Target API 支持，可以从其他应用分享文件到 Weblink

- Add forward menu option in file table 在文件表中添加转发菜单选项

### Bug Fixes

- Fix some i18n issues 修复一些 i18n 问题

## [0.4.1] - 2024-11-03

### New Features

- Add redirect option after connection in client menu 在客户端菜单中添加连接后重定向选项

- QR code dialog now displays your name 二维码对话框现在会显示自己的用户名

### Improvements

- Move the file chunk merge process to Web Worker to improve performance 将文件区块合并流程转移到 Web Worker 中提高性能

## [0.4.0] - 2024-11-01

### New Features

- Add folder transfer feature 添加文件夹传输功能

### Improvements

- Use Web Worker to compress and uncompress files 使用 Web Worker 压缩和解压缩文件

## [0.3.3] - 2024-10-31

### Bug Fixes

- Fix the bug that the message cannot be scrolled to the bottom when the client is online 修复了当客户端在线时消息无法滚动到底部的问题

### Improvements

- Improve the animation of the message 优化消息的动画

- Improve the date format 优化日期格式

## [0.3.2] - 2024-10-30

### New Features

- Add clipboard history dialog 添加剪贴板历史对话框

## [0.3.1] - 2024-10-29

### Bug Fixes

- Fix the bug that the application cannot be used in a non-secure context 解决了应用在非安全上下文无法使用的问题

## [0.3.0] - 2024-10-28

### New Features

- Add clipboard paste feature 添加剪贴板粘贴功能
