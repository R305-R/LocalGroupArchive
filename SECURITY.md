# Security and privacy

## Reporting

Please open a private GitHub security advisory for vulnerabilities that could expose Discord data, write outside the archive directory, bypass the loopback deletion authorization, or execute untrusted archive content. Do not attach real private-message archives to a public issue.

## Design boundaries

- Native writes validate channel/message/attachment IDs and cached-asset filenames before constructing paths.
- Attachment downloads accept only HTTPS Discord CDN attachment URLs; cached visual assets accept only Discord CDN/proxy hosts.
- Download size is bounded, redirects are revalidated, incomplete files use unique names, and stopped/deleted channels abort active streams.
- The viewer builds message content with DOM text nodes rather than assigning archived content to `innerHTML`.
- Only a small allowlist of raster image/audio/video formats is previewed; HTML, SVG, and other active attachment types are offered as downloads instead of being opened inline.
- The viewer/API helper binds only to `127.0.0.1`, requires a random per-session token for the viewer/API, accepts only `null` or its own loopback origin, and stops with the plugin. Archive file serving is path-contained to the detected archive root.
- The user-facing installer does not execute Node.js, pnpm, or third-party dependency installers. GitHub Actions builds Vencord from the pinned tested commit, runs TypeScript/ESLint checks, packages the Windows runtime, and publishes SHA-256 files for both the bundle and installer. The EXE verifies its embedded runtime bundle before installing it, and updater downloads are checked against the release checksum asset.

## User responsibility

Archives are intentionally local but are not encrypted at rest. Protect the Windows account and disk, do not publish generated archive folders, and review exported JSON before sharing it.
