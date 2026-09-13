# Changelog

## 0.9.1

- Added a **five-second Panic Burst** to every cold Smart Hybrid capture, including automatic protection of a newly-accessible Group DM. Normal history starts at six concurrent lanes immediately and each independent search route may keep two batches in flight during the burst.
- Fixed stacked slow completions collapsing normal concurrency from 6 to 1. Panic Burst does not locally back off; afterward the gate decreases by one at most once per two-second congestion epoch and keeps a floor of two. Discord/Vencord still enforces the real route buckets and 429 waits.
- Added **cross-route work stealing**. When authoritative workers finish their assigned ranges, they claim unfinished search ranges that are not currently in flight and walk those ranges through `/messages` while Search continues elsewhere.
- Deferred authoritative range proof/checkpoint waits during the first five seconds. Message batches still append to NDJSON capture packs immediately; deferred ranges are marked complete together only after those appends are durable.
- Search now uses two coordinated per-route workers only for the emergency window, prevents two workers from selecting the same lane, and returns to one stream per route afterward to avoid manufacturing a long local queue.
- Fixed progress output reporting all original search ranges as active during targeted normal repair. It now shows actual outstanding work, prints `idle` for an exhausted normal plane, and records how many unique message objects arrived inside Panic Burst.
- Kept exact per-range verification, targeted repair, resumable coverage, media isolation, Warm Mirror, and the one-shot/persistent distinction unchanged.

## 0.9.0

- Added **Warm Mirror reconciliation**. Gateway capture remains immediate, one already-complete protected Group DM is checked every 45 seconds in round-robin order, and a Discord reconnect reconciles all complete mirrors two at a time so offline gaps become tiny deltas instead of future full scans.
- Replaced Search Sweep as the active cold-capture engine with **Smart Hybrid**. One newest edge is frozen, then real message anchors split history into non-overlapping ranges distributed across normal history, channel search, and channel-filtered global-DM search.
- Added additive-increase/multiplicative-decrease control for the authoritative history plane: it starts at two active requests, grows to six while waits stay fast, and backs off on slow/error responses. Discord/Vencord still owns rate-limit enforcement.
- Added exact completion proof per search range. Global-DM search ranges are rechecked through channel-scoped search to detect filtered authors or unstable result counts.
- Added **targeted authoritative repair**. A short or unproven search range alone falls back to `/messages`; a 16-message search discrepancy no longer automatically restarts the entire 12k-message history.
- Added a durable `capture/coverage.json` checkpoint ledger. Range completion is written only after the corresponding NDJSON capture appends are durable; interrupted runs reuse completed ranges and request only pending ranges plus any new top gap.
- Extended anchor discovery beyond the 9,975 search-offset ceiling through bounded real-ID tail hops, keeping very large histories partitioned without speculative Snowflake-time boundaries.
- Frozen all CDN work—including Voice Messages—during critical text capture. Voice remains first priority when the media phase begins, but it can no longer consume the few seconds needed by history routes.
- Added fatal-setup fallback to the proven real-ID Anchored Burst walker. Ordinary search misses stay inside targeted Hybrid repair; the full fallback exists only for unexpected client/search incompatibility.
- Updated progress and completion summaries with normal/channel-search/global-search request counts, proven/resumed/repaired range counts, adaptive concurrency, and route wait time.

## 0.8.0

- **Replaced `/messages` as the cold-history primary data plane.** Real testing showed v0.7.3 could fetch 12,872 messages correctly but still needed 45.10 seconds because many requests to the same channel route accumulated rate-limit wait.
- Added **Search Sweep**: after one authoritative newest-page request, `POST /channels/:id/messages/search/tabs` becomes the primary history source. Five Discord search tabs are populated with offsets 0/25/50/75/100, so one search HTTP request can carry up to 125 message objects.
- Added an 8-worker Search Sweep queue. It still uses Vencord `RestAPI`, so Discord rate-limit handling remains intact; there is no raw-token or 429 bypass.
- Added exact-count completion validation with `track_exact_total_hits`. A fast run is marked complete only when the unique persisted message count equals Discord's exact count plus the frozen newest edge.
- Added 10,000-result window rollover using a real oldest returned Snowflake, allowing search to cover histories larger than the offset ceiling.
- Historical search slices that return fewer than their expected 25 results are retried selectively. If exact completeness still cannot be proved, the existing authoritative `/messages` planner runs as an automatic repair path.
- Normal images/video/embed downloads stay held until the fast phase is proven complete; Voice Messages retain immediate rescue priority. This prevents a failed Search Sweep from unleashing media traffic right before repair.
- Progress now reports Search HTTP requests, server-side tabs, exact message target, client wait, and Discord `time_spent_ms` approximately every two seconds.
- Kept v0.7.2's creation-time cutoff and one-shot semantics for old/manual groups, plus `CHANNEL_RECIPIENT_ADD` / `CHANNEL_RECIPIENT_REMOVE` handling for groups that become new to the user after installation.
- Search results intentionally prioritize message/content/attachment survival. Discord search responses omit the `reactions` key for older results; the newest 100 messages still come from `/messages` with full reaction data.


## 0.7.2

- Fixed an old/closed Group DM being mistaken for a brand-new group when Discord hydrated it into `ChannelStore` only after the saved visible-ID baseline.
- New-group auto-protection now uses a **persisted creation-time cutoff** and the channel Snowflake timestamp. A group created before the cutoff stays old/ignored even if Discord first reveals it days later.
- `Reset NEW-group baseline` now resets the timestamp cutoff too, so even currently hidden old groups remain ignored later.
- `FAST FULL history capture` is now explicitly **one-shot** for an old group: it temporarily enables capture in memory for the scan/media drain but does not silently persist background archiving.
- Added regression checks for cutoff classification and one-shot Full behavior.

## 0.7.1

- **Critical v0.7.0 regression fix:** removed speculative Snowflake-time sharding that could turn a ~129-page history into hundreds of overlapping `/messages` requests.
- Added **Anchored Burst**: one or two lightweight `messages/search/tabs` probes discover real message IDs, then authoritative `/messages` workers scan non-overlapping ID intervals. Search never determines completeness and failure/indexing falls back to a single cursor.
- Capped active authoritative history lanes at 6 so the client can use Discord's available bucket burst without recreating the 24-worker pile-up.
- Voice attachments still receive immediate download priority as soon as an authoritative history page arrives; Full Capture no longer waits on a separate 200-page voice-search crawl.
- Added in-chat progress roughly every 10 seconds with unique messages, completed history pages, anchor probes, active lanes, elapsed time, and average REST wait.
- Kept v0.7 New-Group-only baseline protection, Ghost Groups, crash recovery, viewer fixes, and prioritized text/voice capture.

## 0.5.8

- Fixes the real blank-sidebar crash in the generated viewer: raw `0x00` and `0x1F` control bytes were emitted inside the embedded filename-sanitizer regular expression. Browser HTML parsing changed the NUL byte before JavaScript compilation, making the regular expression invalid and aborting the entire viewer script before group rendering.
- Escapes the control-code range in generated JavaScript, so the HTML now contains zero raw C0 control bytes.
- Server-renders archived group names into the sidebar before JavaScript starts. Detected groups therefore remain visible even if a future client-side viewer error occurs.
- Adds regression tests for raw control bytes, JavaScript compilation, and server-rendered group markup.

## 0.5.7

- Viewer now opens from a live `127.0.0.1` HTTP page instead of relying on `file://`, eliminating stale HTML and browser local-file loading differences.
- The local viewer server securely serves archived attachments/assets with byte-range support for audio/video.
- Archive root auto-detects Windows Documents and common OneDrive Documents locations, preferring the location that already contains archived channel folders.
- Viewer header now shows v0.5.7 so the active build can be verified visually.

## 0.5.6

- Fixes an empty viewer when archived Group DM folders exist but browser `file://` script loading fails or becomes stale.
- Embeds channel metadata directly into the viewer shell, so saved groups appear without depending on `meta.js`.
- Adds a loopback-only `/bootstrap` hydration path that rebuilds/reads a compact `viewer-data.json` cache and refreshes messages from the native archive.
- Keeps the existing file-based scripts as an offline fallback.
- Viewer compaction now writes `data.js` and `viewer-data.json` together.

## 0.5.5

- Fix an empty viewer sidebar when archives already existed but message compaction had not finished.
- Viewer preparation now writes channel metadata and the HTML shell first, then rebuilds heavy `data.js` indexes in the background.
- Add a persistent `.viewer-dirty` marker for fast-history batches so interrupted captures self-heal on the next viewer open/startup.
- Opening the archive viewer now performs the fast self-heal automatically before launching the browser.

## 0.5.4

- Voice messages/audio attachments are now rescue-critical and share top priority with text history capture.
- Full History starts voice downloads immediately from each fetched REST page while message writes and pagination continue.
- The normal-media hold now blocks only images, videos, avatars, embeds, stickers and other non-voice assets; voice jobs bypass it.
- Voice jobs always jump ahead of normal media in the shared 64-worker downloader, including when the normal-media hold is released.
- The final post-history staging pass skips voice attachments already captured during the priority phase, preventing redundant re-queueing.
- If Group DM access disappears mid-scan, already-started voice downloads continue from their captured CDN URLs while remaining staged media is released for rescue download.

## 0.5.3

- Full-history rescue mode now freezes the media pump from the instant the scan starts, including channel icons, avatars, live-message media and snapshot media queued concurrently.
- Captured attachment jobs are now reconstructed from archived message records, so their saved CDN URLs do not require another Group DM message lookup after access disappears.
- If the Group DM vanishes, REST returns an error/403, or history capture is otherwise interrupted while archiving remains enabled, all already-persisted media URLs are staged before the pump is released.
- Media staging is strictly queue-first: no staged history-media download begins until the complete captured set has entered the queue.
- Raised media workers from 16 to 64 for the post-capture CDN burst.

## 0.5.2

- Full-history capture now defers **all media downloads** until every fetched message batch has finished writing. Media jobs are staged first, then the download pump is released in one shot.
- Raised media download workers from 6 to 16 after staging completes.
- Message-file writes now use a 64-slot native write pool instead of serial per-message writes.
- Full-history viewer rebuilding is deferred to background work so it no longer delays the capture-complete response.
- Full-history renderer batches no longer append to `data.js` page-by-page; the viewer is compacted once after capture.
- Added in-memory message/deletion indexes to avoid thousands of failed filesystem reads on fresh archives.
- Increased full-history disk flush window so REST history fetching is not repeatedly stalled by local writes.
- Fixed the Windows PowerShell 5.1 installer treating normal native `stderr` output from `pnpm build` as a fatal PowerShell exception.
- `Invoke-Logged` now records both output streams but decides command success from the native process exit code.
- Hardened the uninstall-time Vencord CLI call against the same PowerShell 5.1 stderr behavior.
- Added smoke-test regression guards for both native-command paths.

## 0.5.0

### Reliability

- Serialize per-channel viewer writes and write metadata/messages/data atomically.
- Use unique partial-download files, native deduplication, a 45-second abort timeout, three renderer retries, and expected attachment-size validation.
- Add bounded queue backpressure and cancel in-flight work when capture stops or an archive is deleted.
- Fix decimal Snowflake ordering with `BigInt` rather than lexicographic string sorting.
- Fix delete-then-restore in the same Discord session by invalidating renderer caches and synchronizing tombstones.
- Surface fetched versus safely-written counts and disk batch failures.
- Refresh channel metadata on `CHANNEL_UPDATE`; save reaction state changes and retain message revisions.
- Refetch rare partial `MESSAGE_UPDATE` payloads instead of overwriting complete archived records with missing fields.
- Catch up messages missed while Discord was closed by scanning backward only to each archive's newest known Snowflake, with two startup workers.

### Offline viewer

- Cache avatars, Group DM icons, embed media, stickers, and custom emoji locally.
- Add a 300-message sliding DOM window with bidirectional 100-message shifts and scroll-anchor preservation.
- Add archive-wide search and selected-channel JSON export.
- Render replies, reactions, stickers, polls, components, forwarded-message markers, calls, pinned state, edits, and deletions.
- Improve RTL/LTR behavior with per-message automatic text direction.
- Harden the loopback deletion API origin checks and shut it down when the plugin stops.
- Remove channel-scoped cached group icons and embed media when their Group DM archive is deleted.

### Setup and distribution

- Add a required, one-time in-Discord spotlight walkthrough for enabling the main plugin.
- Add a no-admin Windows installer that provisions a checksum-verified portable Node.js LTS runtime, pins the current official Vencord commit, installs Vencord's requested pnpm version, builds both plugins, verifies the official Vencord CLI checksum, and injects the developer build automatically with a checked exit code.
- Add repair, update with SHA-256 verification, removal, CI, Vencord build validation, and tagged GitHub Release automation.
- On uninstall, restore regular updateable Vencord, preserve unrelated managed userplugins in a backup, remove the large managed toolchain, and keep the user's archive untouched.

## 0.4.4

- Discord-like APP badge and ephemeral message styling.
- Common Discord markdown rendering and interaction/application metadata capture.

## 0.4.2–0.4.3

- Permanent archive deletion from the local viewer with tombstones and manual restoration.
- BiDi fixes for Arabic header counters.

## 0.4.1 and earlier

- Group DM capture, REST history paging, concurrent attachment downloads, system-event rendering, media previews, local viewer, and automatic new-group detection.
