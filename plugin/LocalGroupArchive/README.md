# LocalGroupArchive v0.9.4

LocalGroupArchive is a Vencord userplugin that stores Discord Direct Messages and Group DMs locally on your computer. It can capture message history, attachments, voice messages, embeds, stickers, reactions, and conversation metadata, then display the saved data in a local Discord-style HTML viewer.

The plugin only archives data that your Discord account can currently access. It does not bypass Discord permissions and it cannot recover messages that Discord no longer provides to your account. Vencord is a third-party project and is not affiliated with Discord.

## Supported conversations

Manual archive commands work in both:

- Direct Messages
- Group DMs

Automatic archiving remains limited to newly created or newly joined Group DMs. Direct Messages are never enabled automatically.

## Storage

Archives are stored under:

`Documents\DiscordLocalArchive`

Messages are written to durable local capture files and compacted into viewer data. Re-running a full capture does not create duplicate message records because messages are keyed by Discord message ID and completed history ranges can be reused.

## History capture

A full history capture uses several Discord client routes when available:

- `GET /channels/:id/messages` for normal history pages
- channel-scoped message search
- global DM search restricted to the current conversation

The first few seconds use higher request concurrency to save text history quickly. Request handling still goes through Vencord's `RestAPI`, so Discord rate limits remain in effect. After the text-history phase, queued media downloads continue separately.

If a capture is interrupted, completed ranges are recorded in `capture/coverage.json`. Running full history capture again resumes the missing ranges instead of downloading proven ranges again.

## Automatic Group DM archiving

Automatic archiving is designed only for new Group DMs. A saved cutoff prevents an old Group DM from being mistaken for a new one when Discord loads it into `ChannelStore` later.

When automatic archiving is enabled, a newly created Group DM or a Group DM you are newly added to can begin archiving automatically. Existing Group DMs remain unchanged unless you start archiving them manually.

Direct Messages are never automatically enabled.

## Slash command

Use `/localarchive` inside a Direct Message or Group DM.

| Action | Description |
| --- | --- |
| `start` | Enable persistent archiving for the current conversation and capture missing history |
| `full` | Capture the full available history once without enabling persistent archiving if it was previously off |
| `snapshot` | Save messages currently loaded in Discord's message store |
| `wait` | Wait for queued media downloads to finish |
| `auto-on` | Enable automatic archiving for new Group DMs |
| `auto-off` | Disable automatic archiving for new Group DMs |
| `viewer` | Open the local archive viewer |
| `folder` | Open the archive folder |
| `health` | Check archive integrity and storage usage |
| `repair` | Rebuild viewer indexes and remove stale temporary files |
| `guide` | Open the setup guide |
| `baseline-reset` | Treat currently existing Group DMs as the automatic-archive baseline |
| `stop` | Disable persistent archiving for the current conversation |
| `status` | Show archive status and download queue information |

Actions that manage the archive folder, viewer, health, repair, setup guide, or automatic Group DM setting can be selected from any channel where Vencord exposes the command. Conversation-specific capture actions require a Direct Message or Group DM.

## One-time full capture

`full` is the simplest option when you only want a local copy of a conversation.

If persistent archiving is off before the command starts, the plugin temporarily enables writes for the conversation, captures the available history and media, waits for queued media to finish, then returns the conversation to the previous disabled state. Running `full` again later reuses existing data and does not intentionally duplicate saved messages.

## Persistent archiving

`start` keeps the current Direct Message or Group DM enabled after the initial capture. New messages, edits, deletions, and reaction changes are written to the local archive while Vencord is running. Completed archives are periodically checked for small missed deltas.

Use `stop` to disable persistent archiving without deleting existing local files.

## Viewer

The local viewer runs on `127.0.0.1` and reads the saved archive from disk. Archived Group DMs that are no longer available in Discord can appear as local read-only entries in the DM list when they were persistently protected before access was lost.

## Installation on Windows

1. Download the latest `LocalGroupArchive-Setup-vX.Y.Z.exe` and its `.sha256` file from GitHub Releases.
2. Run the installer. Administrator access is not required.
3. The release workflow builds a Developer Vencord runtime from the pinned Vencord commit used by this project.
4. The installer verifies the packaged runtime and installs the userplugin.
5. Restart Discord if the installer does not restart it automatically, then enable LocalGroupArchive in Vencord settings.

The installer is not signed with a commercial Windows code-signing certificate, so Windows SmartScreen may appear on first launch. Verify the published SHA-256 hash before running the installer.

Uninstalling the plugin restores the original Discord `app.asar` and leaves `Documents\DiscordLocalArchive` untouched.

## Safety and limitations

- The plugin uses the permissions of the signed-in Discord account.
- It does not use a raw user token to bypass REST rate limits.
- Discord can change private APIs at any time, which may require plugin updates.
- Search results for older history may not include every field that normal message-history responses include. The plugin verifies history ranges and falls back to direct history requests when needed.
- Deleted or inaccessible content cannot be recovered if Discord no longer provides it.

## Development

The repository contains the Vencord userplugin, native archive helpers, viewer code, installer, smoke tests, and GitHub Actions workflows used to build releases.

Run the repository smoke tests with:

```bash
npm test
```

Release builds additionally compile the plugin against the pinned Vencord version and run TypeScript and ESLint checks before publishing the installer.

## License

GPL-3.0-or-later
