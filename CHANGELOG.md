# Changelog

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
