# LocalGroupArchive v0.9.3

The complete Arabic/English installation, privacy, command, architecture, and release documentation is in the repository root [README](../../README.md).

This folder is copied to `Vencord/src/userplugins/LocalGroupArchive`. The required first-run spotlight helper lives beside it at `../LocalGroupArchiveSetup`.


## v0.9.3 architecture

- **New-to-you groups only:** a persisted cutoff filters lazy hydration of old DMs, while post-baseline `CHANNEL_CREATE` and current-user `CHANNEL_RECIPIENT_ADD` events immediately protect groups that actually become accessible to you now.
- **Warm Mirror:** Gateway events persist live creates/updates/deletes/reactions, while a round-robin 45-second reconciliation fetches only the newest delta for proven protected groups.
- **Smart Hybrid cold capture:** exactly one normal `/messages` request freezes the newest edge. Real search-returned message IDs partition the older timeline into non-overlapping ranges striped across normal history, channel search, and channel-filtered global-DM search.
- **Five-second Panic Burst:** cold capture starts with six normal-history lanes and two workers per search route. Proof checkpoints are batched until the burst ends so captured text keeps moving to NDJSON packs.
- **Congestion epochs + work stealing:** normal concurrency cannot collapse on several completions from the same slow wave, never falls below two, and idle normal workers authoritatively take over unfinished search ranges.
- **Per-range completion proof:** every search range must match an exact count; global-DM ranges are verified through channel search. Only failed/unproven ranges are repaired through authoritative `/messages`.
- **Durable resume ledger:** `capture/coverage.json` records a range complete only after its capture-pack appends succeed. Interrupted runs skip proven ranges and add only a newest-gap range when needed.
- **Capture packs:** every returned batch is durably appended to NDJSON first; expensive per-message files and viewer indexes are compacted later and are recoverable after a crash.
- **Network isolation:** all CDN downloads stay frozen during critical text capture. Voice Messages lead the media queue after text traffic stops.
- **Ghost Group DMs:** a protected group removed from Discord remains in the DM list as a local read-only archived row. Existing queued downloads are preserved.
- **Rate-limit safe:** every route uses Vencord `RestAPI`; the plugin does not bypass Discord rate limits or raw-fetch with the account token.
- **Prebuilt Windows setup:** GitHub builds and validates the complete Vencord runtime. The installer verifies and injects that bundle without Node.js, pnpm, dependency linking, or an on-device build.

## v0.5 highlights

- True offline cache for avatars, group icons, embeds, stickers, and custom emoji.
- 300-message bidirectional sliding DOM window with scroll-position preservation.
- Atomic storage, edit revisions, deleted-message markers, bounded/retried downloads, and clean cancellation.
- Rich replies/reactions/polls/components/calls rendering, archive-wide search, and JSON export.

---

## Historical v0.4.4 notes

Adds permanent archive deletion directly from the HTML viewer while keeping all v0.4.1 viewer/media behavior.

## v0.4.4

- Bot/app messages now use a Discord-like verified **APP** badge instead of the plain BOT pill.
- Ephemeral app messages (Discord message flag 64) get the subtle blue left rail/background and an "Only you can see this" footer.
- Message content now renders common Discord markdown such as bold, italic, underline, strikethrough, inline code, spoilers, and links instead of showing raw markers.
- Future captures also retain app/webhook/interaction metadata when Discord exposes it.

## v0.4.3

- Fixed RTL/BiDi mixing in the group header counters so member and saved-message counts stay paired with the correct labels.

## v0.4.2

- Hover a Group DM in the left sidebar and press the red **×** button.
- A Discord-style confirmation dialog appears before anything is removed.
- Confirming deletes that Group DM's entire local archive folder, including saved messages, images, videos, voice messages, audio, and other attachments.
- The viewer removes the group immediately without needing a refresh.
- A tiny tombstone marker prevents automatic capture from recreating a group you intentionally deleted.
- If you later want that same Group DM again, manually run **Start**, **Full**, or **Snapshot** from `/localarchive`; manual capture clears the tombstone and creates a fresh archive.
- Deletion is handled only by a loopback-only localhost helper while Discord/LocalGroupArchive is running. The viewer shows an error instead of deleting anything if Discord is closed.

## Existing viewer features

- Discord-style Group DM system events (left/added/call/name/icon/pin).
- Inline GIF/embed previews.
- Proportional image/GIF sizing from Discord metadata.
- Inline video playback, audio, and voice messages.
- Arabic-friendly Gregorian dates and day separators.
- Group icons, recent-message previews, lightbox, transitions, search, and jump-to-newest.
- Long-chat scrolling fix.

## Existing capture features

- Automatic new Group DM detection is ON by default.
- Cold full-history capture uses Smart Hybrid and reserves authoritative 100-message REST paging for striped normal ranges plus targeted repair.
- Text capture has exclusive network priority. Voice downloads lead the queued media burst after history traffic stops.
- Full-history viewer compaction runs after the critical capture path instead of blocking it.
- Loaded-message snapshot starts immediately as a short-lived-group fallback.
- Attachment downloads use concurrent workers.
- Existing archives remain compatible with the viewer.

## Install/update

Replace:

`Vencord/src/userplugins/LocalGroupArchive`

Then from the Vencord source folder run:

`pnpm build`

`pnpm inject`

Restart Discord completely and enable **LocalGroupArchive**.

## Notes

- The plugin only archives content while Discord still exposes the Group DM to your logged-in client. It does not bypass removed access.
- Deleted messages that were already gone before capture cannot be recovered.
- Live voice calls are not recorded. Voice-message attachments and ordinary audio/video/image/file attachments are supported.
- Vencord is a Discord client modification and is not officially supported by Discord.
