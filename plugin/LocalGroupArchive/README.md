# LocalGroupArchive v0.5.0

The complete Arabic/English installation, privacy, command, architecture, and release documentation is in the repository root [README](../../README.md).

This folder is copied to `Vencord/src/userplugins/LocalGroupArchive`. The required first-run spotlight helper lives beside it at `../LocalGroupArchiveSetup`.

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
- Fast full-history capture in 100-message REST pages.
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
