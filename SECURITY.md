# Security and privacy

## Reporting

Please open a private GitHub security advisory for vulnerabilities that could expose Discord data, write outside the archive directory, bypass the loopback deletion authorization, or execute untrusted archive content. Do not attach real private-message archives to a public issue.

## Design boundaries

- Native writes validate channel/message/attachment IDs and cached-asset filenames before constructing paths.
- Attachment downloads accept only HTTPS Discord CDN attachment URLs; cached visual assets accept only Discord CDN/proxy hosts.
- Download size is bounded, redirects are revalidated, incomplete files use unique names, and stopped/deleted channels abort active streams.
- The viewer builds message content with DOM text nodes rather than assigning archived content to `innerHTML`.
- Only a small allowlist of raster image/audio/video formats is previewed; HTML, SVG, and other active attachment types are offered as downloads instead of being opened inline.
- The deletion helper binds only to `127.0.0.1`, requires a random per-session token, rejects non-null web origins, and stops with the plugin.
- Installer Node.js archives are checked against Node's official SHA-256 list. The Vencord source URL is pinned to the commit SHA returned by GitHub, and the official Vencord CLI is checked against its published checksum list. Updates are checked against the checksum asset produced by the release workflow.

## User responsibility

Archives are intentionally local but are not encrypted at rest. Protect the Windows account and disk, do not publish generated archive folders, and review exported JSON before sharing it.
