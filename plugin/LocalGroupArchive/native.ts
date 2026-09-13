/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { randomBytes } from "crypto";
import { app, IpcMainInvokeEvent, shell } from "electron";
import { once } from "events";
import { createWriteStream } from "fs";
import {
    appendFile,
    mkdir,
    readdir,
    readFile,
    rename,
    rm,
    stat,
    writeFile
} from "fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "http";
import { join } from "path";
import { finished } from "stream/promises";

import { buildViewerHtml as buildModernViewerHtml } from "./viewer";

const SNOWFLAKE = /^\d{15,22}$/;
const MAX_JSON_BYTES = 2 * 1024 * 1024;
const MAX_BATCH_BYTES = 24 * 1024 * 1024;
const MAX_BATCH_MESSAGES = 250;
const MAX_ATTACHMENT_BYTES = 512 * 1024 * 1024;
const ALLOWED_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const ASSET_KINDS = new Set(["avatars", "group-icons", "embeds", "stickers", "emojis"]);
const ASSET_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const DOWNLOAD_TIMEOUT_MS = 45_000;

const viewerChains = new Map<string, Promise<void>>();
let viewerShellChain: Promise<void> = Promise.resolve();

const deletedChannels = new Set<string>();
const activeDownloadControllers = new Map<string, { channelId: string; controller: AbortController; }>();
const nativeDownloadJobs = new Map<string, Promise<any>>();
let viewerApiServer: Server | null = null;
let viewerApiPort = 0;
let viewerApiStart: Promise<{ port: number; token: string }> | null = null;
const viewerApiToken = randomBytes(24).toString("hex");

function archiveRoot() {
    return join(app.getPath("documents"), "DiscordLocalArchive");
}

function viewerPath() {
    return join(archiveRoot(), "index.html");
}

function shortcutViewerPath() {
    return join(app.getPath("documents"), "Discord Local Archive.html");
}

function assetDir(kind: string) {
    if (!ASSET_KINDS.has(kind)) throw new Error("Invalid cached asset kind");
    return join(archiveRoot(), "_assets", kind);
}

function deletedMarkerDir() {
    return join(archiveRoot(), ".deleted");
}

function deletedMarkerPath(channelId: string) {
    assertSnowflake(channelId, "channel id");
    return join(deletedMarkerDir(), `${channelId}.deleted`);
}

async function isChannelArchiveDeletedInternal(channelId: string) {
    assertSnowflake(channelId, "channel id");
    if (deletedChannels.has(channelId)) return true;

    try {
        await stat(deletedMarkerPath(channelId));
        deletedChannels.add(channelId);
        return true;
    } catch {
        return false;
    }
}

async function markChannelArchiveDeleted(channelId: string) {
    assertSnowflake(channelId, "channel id");
    deletedChannels.add(channelId);
    await mkdir(deletedMarkerDir(), { recursive: true });
    await writeFileAtomic(deletedMarkerPath(channelId), new Date().toISOString());
}

async function restoreChannelArchiveInternal(channelId: string) {
    assertSnowflake(channelId, "channel id");
    deletedChannels.delete(channelId);
    await rm(deletedMarkerPath(channelId), { force: true });
}

function assertSnowflake(value: string, label: string) {
    if (typeof value !== "string" || !SNOWFLAKE.test(value)) {
        throw new Error(`Invalid ${label}`);
    }
}

function assertSmallJson(json: string) {
    if (typeof json !== "string" || Buffer.byteLength(json, "utf8") > MAX_JSON_BYTES) {
        throw new Error("Invalid JSON payload");
    }
}

function safeFilename(name: string) {
    const cleaned = String(name)
        .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
        .replace(/[. ]+$/g, "")
        .slice(0, 160);
    return cleaned || "attachment.bin";
}

function assertAssetFilename(value: string) {
    if (typeof value !== "string" || !ASSET_FILE.test(value) || value === "." || value === "..") {
        throw new Error("Invalid cached asset filename");
    }
}

function snowflakeCompare(a: string, b: string) {
    try {
        const left = BigInt(a);
        const right = BigInt(b);
        return left < right ? -1 : left > right ? 1 : 0;
    } catch {
        return a.localeCompare(b);
    }
}

async function writeFileAtomic(path: string, data: string | Buffer) {
    const temporary = `${path}.${randomBytes(6).toString("hex")}.tmp`;
    try {
        await writeFile(temporary, data);
        try {
            await rename(temporary, path);
        } catch (error: any) {
            if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
            await rm(path, { force: true });
            await rename(temporary, path);
        }
    } catch (error) {
        await rm(temporary, { force: true });
        throw error;
    }
}

function channelDir(channelId: string) {
    assertSnowflake(channelId, "channel id");
    return join(archiveRoot(), channelId);
}

function messageDir(channelId: string) {
    return join(channelDir(channelId), "messages");
}

function attachmentDir(channelId: string, messageId: string) {
    assertSnowflake(messageId, "message id");
    return join(channelDir(channelId), "attachments", messageId);
}

function revisionDir(channelId: string, messageId: string) {
    assertSnowflake(messageId, "message id");
    return join(channelDir(channelId), "revisions", messageId);
}

function deletionPath(channelId: string, messageId: string) {
    assertSnowflake(messageId, "message id");
    return join(channelDir(channelId), "deletions", `${messageId}.json`);
}

function revisionSignature(record: any) {
    return JSON.stringify({
        content: record?.content ?? "",
        editedTimestamp: record?.editedTimestamp ?? null,
        attachments: record?.attachments ?? [],
        embeds: record?.embeds ?? [],
        stickerItems: record?.stickerItems ?? [],
        components: record?.components ?? [],
        poll: record?.poll ?? null
    });
}

function validateAttachmentUrl(raw: string) {
    const url = new URL(raw);
    if (url.protocol !== "https:" || !ALLOWED_HOSTS.has(url.hostname)) {
        throw new Error("Attachment URL is not an allowed Discord CDN URL");
    }

    if (!url.pathname.includes("/attachments/")) {
        throw new Error("URL is not a Discord attachment URL");
    }

    return url;
}

function validateAssetUrl(raw: string) {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    const allowed = ALLOWED_HOSTS.has(host)
        || host === "cdn.discordapp.com"
        || /^images-ext-\d+\.discordapp\.net$/.test(host);
    if (url.protocol !== "https:" || !allowed) {
        throw new Error("Asset URL is not an allowed Discord CDN/proxy URL");
    }
    return url;
}

async function fetchWithValidatedRedirects(
    rawUrl: string,
    validateUrl: (raw: string) => URL,
    signal: AbortSignal
) {
    let url = validateUrl(rawUrl);
    for (let redirect = 0; redirect <= 5; redirect++) {
        const response = await fetch(url, { redirect: "manual", signal });
        if (response.status < 300 || response.status >= 400) return response;

        const location = response.headers.get("location");
        if (!location) throw new Error("Discord CDN redirect did not include a location");
        if (redirect === 5) throw new Error("Discord CDN redirect limit exceeded");
        url = validateUrl(new URL(location, url).toString());
    }
    throw new Error("Discord CDN redirect limit exceeded");
}

function jsSafeJson(value: unknown) {
    return (JSON.stringify(value) ?? "null")
        .replace(/\u2028/g, "\\u2028")
        .replace(/\u2029/g, "\\u2029");
}

function queueViewerOp(channelId: string, op: () => Promise<void>) {
    const previous = viewerChains.get(channelId) ?? Promise.resolve();
    const next: Promise<void> = previous
        .catch(() => { })
        .then(op)
        .finally(() => {
            if (viewerChains.get(channelId) === next) viewerChains.delete(channelId);
        });
    viewerChains.set(channelId, next);
    return next;
}

async function ensureFile(path: string, content = "") {
    try {
        await stat(path);
    } catch {
        await writeFileAtomic(path, content);
    }
}

function sendApiJson(res: ServerResponse, status: number, body: unknown) {
    const payload = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader("Content-Type", "application/json; charset=utf-8");
    res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Private-Network", "true");
    res.setHeader("Cache-Control", "no-store");
    res.end(payload);
}

async function readApiBody(req: IncomingMessage) {
    const chunks: Buffer[] = [];
    let total = 0;
    for await (const chunk of req) {
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += buffer.length;
        if (total > 16 * 1024) throw new Error("Request body is too large");
        chunks.push(buffer);
    }
    return Buffer.concat(chunks).toString("utf8");
}

function isLoopback(address: string | undefined) {
    return address === "127.0.0.1" || address === "::1" || address === "::ffff:127.0.0.1";
}

function cancelDownloadsForChannel(channelId?: string) {
    for (const [key, entry] of activeDownloadControllers) {
        if (channelId && entry.channelId !== channelId) continue;
        entry.controller.abort();
        activeDownloadControllers.delete(key);
    }
}

async function removeChannelScopedAssets(channelId: string) {
    for (const kind of ["group-icons", "embeds"]) {
        const dir = assetDir(kind);
        try {
            const entries = await readdir(dir, { withFileTypes: true });
            for (const entry of entries) {
                if (entry.isFile() && entry.name.startsWith(`${channelId}-`)) {
                    await rm(join(dir, entry.name), { force: true });
                }
            }
        } catch { }
    }
}

async function downloadUrlToFile(options: {
    key: string;
    channelId: string;
    rawUrl: string;
    finalPath: string;
    maxBytes: number;
    expectedBytes?: number;
    validateUrl: (raw: string) => URL;
}) {
    const current = nativeDownloadJobs.get(options.key);
    if (current) return current;

    const job: Promise<any> = (async () => {
        try {
            const existing = await stat(options.finalPath);
            const expected = Number(options.expectedBytes ?? 0);
            if (existing.isFile() && existing.size > 0 && (!expected || existing.size === expected)) {
                return { ok: true, bytes: existing.size, skipped: true };
            }
        } catch { }

        const url = options.validateUrl(options.rawUrl);
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), DOWNLOAD_TIMEOUT_MS);
        activeDownloadControllers.set(options.key, { channelId: options.channelId, controller });
        const temporary = `${options.finalPath}.${randomBytes(6).toString("hex")}.part`;

        try {
            const response = await fetchWithValidatedRedirects(url.toString(), options.validateUrl, controller.signal);
            if (!response.ok || !response.body) {
                throw new Error(`Download failed (${response.status})`);
            }

            const announcedSize = Number(response.headers.get("content-length") ?? 0);
            if (announcedSize > options.maxBytes) throw new Error("Download exceeds the configured size limit");

            const out = createWriteStream(temporary, { flags: "wx" });
            const outputDone = finished(out);
            void outputDone.catch(() => { });
            const reader = response.body.getReader();
            let total = 0;
            try {
                while (true) {
                    if (controller.signal.aborted || deletedChannels.has(options.channelId)) {
                        await reader.cancel();
                        throw new Error("Download cancelled");
                    }

                    const { done, value } = await reader.read();
                    if (done) break;
                    total += value.byteLength;
                    if (total > options.maxBytes) {
                        await reader.cancel();
                        throw new Error("Download exceeded the configured size limit");
                    }
                    if (out.destroyed) throw new Error("Attachment output stream closed unexpectedly");
                    if (!out.write(Buffer.from(value))) await Promise.race([once(out, "drain"), outputDone]);
                }
                out.end();
                await outputDone;
            } catch (error) {
                out.destroy();
                await outputDone.catch(() => { });
                throw error;
            }

            const expected = Number(options.expectedBytes ?? 0);
            if (expected && total !== expected) {
                throw new Error(`Downloaded size mismatch (${total}/${expected} bytes)`);
            }
            if (deletedChannels.has(options.channelId)) throw new Error("Archive was deleted");

            try {
                await rename(temporary, options.finalPath);
            } catch (error: any) {
                if (error?.code !== "EEXIST" && error?.code !== "EPERM") throw error;
                await rm(options.finalPath, { force: true });
                await rename(temporary, options.finalPath);
            }
            return { ok: true, bytes: total, skipped: false };
        } catch (error) {
            await rm(temporary, { force: true });
            throw error;
        } finally {
            clearTimeout(timeout);
            activeDownloadControllers.delete(options.key);
        }
    })().finally(() => nativeDownloadJobs.delete(options.key));

    nativeDownloadJobs.set(options.key, job);
    return job;
}

async function deleteChannelArchiveInner(channelId: string) {
    assertSnowflake(channelId, "channel id");
    await markChannelArchiveDeleted(channelId);
    cancelDownloadsForChannel(channelId);

    // Let any tiny metadata/data.js write already in flight settle, then remove twice. The
    // in-memory tombstone makes attachment streams abort before they can recreate the archive.
    const viewerWrite = viewerChains.get(channelId);
    if (viewerWrite) await viewerWrite.catch(() => { });

    let firstError: unknown = null;
    try {
        await rm(channelDir(channelId), { recursive: true, force: true, maxRetries: 4, retryDelay: 60 });
    } catch (error) {
        firstError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 120));
    try {
        await rm(channelDir(channelId), { recursive: true, force: true, maxRetries: 8, retryDelay: 100 });
    } catch (error) {
        throw firstError ?? error;
    }
    await removeChannelScopedAssets(channelId);
    viewerChains.delete(channelId);

    await rebuildViewerShell();
    return true;
}

async function ensureViewerApiServer() {
    if (viewerApiServer && viewerApiPort) return { port: viewerApiPort, token: viewerApiToken };
    if (viewerApiStart) return viewerApiStart;

    viewerApiStart = new Promise((resolve, reject) => {
        const server = createServer(async (req, res) => {
            const { origin } = req.headers;
            if (!origin || origin === "null") res.setHeader("Access-Control-Allow-Origin", origin ?? "null");
            res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
            res.setHeader("Access-Control-Allow-Headers", "Content-Type");
            res.setHeader("Access-Control-Allow-Private-Network", "true");

            if (req.method === "OPTIONS") {
                res.statusCode = 204;
                res.end();
                return;
            }

            if (!isLoopback(req.socket.remoteAddress)) {
                sendApiJson(res, 403, { ok: false, error: "Local requests only" });
                return;
            }

            if (origin && origin !== "null") {
                sendApiJson(res, 403, { ok: false, error: "Invalid origin" });
                return;
            }

            const route = req.url?.split("?", 1)[0];
            if (req.method !== "POST" || !new Set(["/delete", "/health", "/repair"]).has(route ?? "")) {
                sendApiJson(res, 404, { ok: false, error: "Not found" });
                return;
            }

            try {
                const raw = await readApiBody(req);
                const payload = JSON.parse(raw || "{}");
                if (payload?.token !== viewerApiToken) {
                    sendApiJson(res, 403, { ok: false, error: "Invalid token" });
                    return;
                }

                if (route === "/health") {
                    sendApiJson(res, 200, { ok: true, health: await getArchiveHealthInternal() });
                    return;
                }
                if (route === "/repair") {
                    sendApiJson(res, 200, await repairArchiveInternal());
                    return;
                }

                const channelId = String(payload?.channelId ?? "");
                assertSnowflake(channelId, "channel id");
                await deleteChannelArchiveInner(channelId);
                sendApiJson(res, 200, { ok: true, channelId });
            } catch (error: any) {
                sendApiJson(res, 400, { ok: false, error: String(error?.message ?? error) });
            }
        });

        const onStartupError = (error: Error) => {
            viewerApiStart = null;
            reject(error);
        };
        server.once("error", onStartupError);

        server.listen(0, "127.0.0.1", () => {
            const address = server.address();
            if (!address || typeof address === "string") {
                server.close();
                viewerApiStart = null;
                reject(new Error("Could not bind viewer API server"));
                return;
            }

            viewerApiServer = server;
            viewerApiPort = address.port;
            server.off("error", onStartupError);
            server.on("error", error => {
                console.warn("[LocalGroupArchive] Viewer API server error", error);
                if (viewerApiServer === server) {
                    viewerApiServer = null;
                    viewerApiPort = 0;
                    viewerApiStart = null;
                }
            });
            server.once("close", () => {
                if (viewerApiServer === server) {
                    viewerApiServer = null;
                    viewerApiPort = 0;
                    viewerApiStart = null;
                }
            });
            resolve({ port: viewerApiPort, token: viewerApiToken });
        });
    });

    return viewerApiStart;
}

async function listArchivedChannelIds() {
    const root = archiveRoot();
    await mkdir(root, { recursive: true });
    const entries = await readdir(root, { withFileTypes: true });
    return entries
        .filter(entry => entry.isDirectory() && SNOWFLAKE.test(entry.name))
        .map(entry => entry.name)
        .sort(snowflakeCompare);
}

async function getChannelArchiveBoundsInternal(channelId: string) {
    assertSnowflake(channelId, "channel id");
    try {
        const entries = await readdir(messageDir(channelId), { withFileTypes: true });
        let count = 0;
        let oldestId: string | null = null;
        let newestId: string | null = null;
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            const id = entry.name.slice(0, -5);
            if (!SNOWFLAKE.test(id)) continue;
            count++;
            if (!oldestId || snowflakeCompare(id, oldestId) < 0) oldestId = id;
            if (!newestId || snowflakeCompare(id, newestId) > 0) newestId = id;
        }
        return {
            count,
            oldestId,
            newestId
        };
    } catch {
        return { count: 0, oldestId: null, newestId: null };
    }
}

interface TreeStats {
    files: number;
    bytes: number;
    partialFiles: number;
}

async function collectTreeStats(root: string): Promise<TreeStats> {
    const result: TreeStats = { files: 0, bytes: 0, partialFiles: 0 };
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return result;
    }

    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            const child = await collectTreeStats(path);
            result.files += child.files;
            result.bytes += child.bytes;
            result.partialFiles += child.partialFiles;
            continue;
        }
        if (!entry.isFile()) continue;
        try {
            const info = await stat(path);
            result.files++;
            result.bytes += info.size;
            if (entry.name.endsWith(".part") || entry.name.endsWith(".tmp")) result.partialFiles++;
        } catch { }
    }
    return result;
}

async function countMessageHealth(channelId: string) {
    let messages = 0;
    let corruptMessages = 0;
    try {
        const entries = await readdir(messageDir(channelId), { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            messages++;
            try {
                const record = JSON.parse(await readFile(join(messageDir(channelId), entry.name), "utf8"));
                if (!record || String(record.id ?? "") !== entry.name.slice(0, -5)) corruptMessages++;
            } catch {
                corruptMessages++;
            }
        }
    } catch { }
    return { messages, corruptMessages };
}

async function getArchiveHealthInternal() {
    const ids = await listArchivedChannelIds();
    const channels: Array<{
        channelId: string;
        messages: number;
        corruptMessages: number;
        metadataPresent: boolean;
        files: number;
        bytes: number;
        partialFiles: number;
    }> = [];
    let totalMessages = 0;
    let corruptMessages = 0;
    let files = 0;
    let bytes = 0;
    let partialFiles = 0;

    for (const channelId of ids) {
        const tree = await collectTreeStats(channelDir(channelId));
        const messageHealth = await countMessageHealth(channelId);
        const metadataPresent = await stat(join(channelDir(channelId), "meta.json")).then(() => true, () => false);
        channels.push({ channelId, ...messageHealth, metadataPresent, files: tree.files, bytes: tree.bytes, partialFiles: tree.partialFiles });
        totalMessages += messageHealth.messages;
        corruptMessages += messageHealth.corruptMessages;
        files += tree.files;
        bytes += tree.bytes;
        partialFiles += tree.partialFiles;
    }

    const assets = await collectTreeStats(join(archiveRoot(), "_assets"));
    files += assets.files;
    bytes += assets.bytes;
    partialFiles += assets.partialFiles;
    return {
        checkedAt: new Date().toISOString(),
        channelCount: ids.length,
        totalMessages,
        corruptMessages,
        files,
        bytes,
        partialFiles,
        assetFiles: assets.files,
        assetBytes: assets.bytes,
        channels
    };
}

async function removeStaleTransientFiles(root: string, olderThanMs: number): Promise<number> {
    let removed = 0;
    let entries;
    try {
        entries = await readdir(root, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        const path = join(root, entry.name);
        if (entry.isSymbolicLink()) continue;
        if (entry.isDirectory()) {
            removed += await removeStaleTransientFiles(path, olderThanMs);
            continue;
        }
        if (!entry.isFile() || (!entry.name.endsWith(".part") && !entry.name.endsWith(".tmp"))) continue;
        try {
            const info = await stat(path);
            if (Date.now() - info.mtimeMs >= olderThanMs) {
                await rm(path, { force: true });
                removed++;
            }
        } catch { }
    }
    return removed;
}

async function repairArchiveInternal() {
    const removedTransientFiles = await removeStaleTransientFiles(archiveRoot(), 15 * 60 * 1000);
    const ids = await listArchivedChannelIds();
    let rebuiltChannels = 0;
    for (const channelId of ids) {
        try {
            const meta = JSON.parse(await readFile(join(channelDir(channelId), "meta.json"), "utf8"));
            await queueViewerOp(channelId, async () => {
                await writeMetaJs(channelId, meta);
                await compactViewerDataInner(channelId);
            });
            rebuiltChannels++;
        } catch { }
    }
    await rebuildViewerShell();
    return { ok: true, removedTransientFiles, rebuiltChannels, health: await getArchiveHealthInternal() };
}

async function rebuildViewerShell() {
    viewerShellChain = viewerShellChain
        .catch(() => { })
        .then(async () => {
            const ids = await listArchivedChannelIds();
            const api = await ensureViewerApiServer();
            await writeFileAtomic(viewerPath(), buildModernViewerHtml(ids, false, api.port, api.token));
            await writeFileAtomic(shortcutViewerPath(), buildModernViewerHtml(ids, true, api.port, api.token));
        });
    return viewerShellChain;
}

async function writeMetaJs(channelId: string, meta: unknown) {
    const dir = channelDir(channelId);
    await mkdir(dir, { recursive: true });
    const js = `window.__LGA=window.__LGA||{channels:{},messages:{}};window.__LGA.channels[${jsSafeJson(channelId)}]=${jsSafeJson(meta)};window.__LGA.messages[${jsSafeJson(channelId)}]=window.__LGA.messages[${jsSafeJson(channelId)}]||[];\n`;
    await writeFileAtomic(join(dir, "meta.js"), js);
    await ensureFile(join(dir, "data.js"));
}

async function readDeletionTimestamps(channelId: string) {
    const result = new Map<string, string>();
    const dir = join(channelDir(channelId), "deletions");
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
            if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
            try {
                const raw = await readFile(join(dir, entry.name), "utf8");
                const deletion = JSON.parse(raw);
                const messageId = String(deletion?.messageId ?? entry.name.slice(0, -5));
                if (SNOWFLAKE.test(messageId)) result.set(messageId, String(deletion?.deletedAt ?? ""));
            } catch { }
        }
    } catch { }
    return result;
}

async function compactViewerDataInner(channelId: string) {
    const dir = messageDir(channelId);
    await mkdir(dir, { recursive: true });
    const entries = await readdir(dir, { withFileTypes: true });
    const files = entries
        .filter(entry => entry.isFile() && entry.name.endsWith(".json"))
        .map(entry => entry.name)
        .sort((a, b) => snowflakeCompare(a.slice(0, -5), b.slice(0, -5)));

    const deletions = await readDeletionTimestamps(channelId);
    const lines: string[] = [
        `window.__LGA=window.__LGA||{channels:{},messages:{}};window.__LGA.messages[${jsSafeJson(channelId)}]=[];`
    ];
    for (const file of files) {
        try {
            const raw = await readFile(join(dir, file), "utf8");
            const record = JSON.parse(raw);
            const deletedAt = deletions.get(String(record?.id ?? ""));
            if (deletedAt) record.deletedAt = deletedAt;
            lines.push(`window.__LGA.messages[${jsSafeJson(channelId)}].push(${jsSafeJson(record)});`);
        } catch {
            // Ignore a malformed/partially-written legacy message instead of breaking the whole viewer.
        }
    }
    await writeFileAtomic(join(channelDir(channelId), "data.js"), lines.join("\n") + "\n");
}

export async function restoreChannelArchive(_: IpcMainInvokeEvent, channelId: string) {
    await restoreChannelArchiveInternal(channelId);
    return true;
}

export async function isChannelArchiveDeleted(_: IpcMainInvokeEvent, channelId: string) {
    return isChannelArchiveDeletedInternal(channelId);
}

export async function getDeletedChannelIds(_: IpcMainInvokeEvent) {
    const dir = deletedMarkerDir();
    try {
        const entries = await readdir(dir, { withFileTypes: true });
        return entries
            .filter(entry => entry.isFile() && entry.name.endsWith(".deleted"))
            .map(entry => entry.name.slice(0, -".deleted".length))
            .filter(id => SNOWFLAKE.test(id));
    } catch {
        return [];
    }
}

export async function ensureChannel(_: IpcMainInvokeEvent, channelId: string, metadataJson: string) {
    assertSmallJson(metadataJson);
    assertSnowflake(channelId, "channel id");
    const meta = JSON.parse(metadataJson);
    if (await isChannelArchiveDeletedInternal(channelId)) return false;
    const dir = channelDir(channelId);
    await mkdir(messageDir(channelId), { recursive: true });
    await mkdir(join(dir, "attachments"), { recursive: true });
    await mkdir(join(dir, "deletions"), { recursive: true });
    await mkdir(join(dir, "revisions"), { recursive: true });
    for (const kind of ASSET_KINDS) await mkdir(assetDir(kind), { recursive: true });
    await writeFileAtomic(join(dir, "meta.json"), metadataJson);

    await writeMetaJs(channelId, meta);
    if (deletedChannels.has(channelId)) {
        await rm(dir, { recursive: true, force: true });
        return false;
    }
    await rebuildViewerShell();
    return true;
}

export async function saveMessagesBatch(
    _: IpcMainInvokeEvent,
    channelId: string,
    recordsJson: string
) {
    assertSnowflake(channelId, "channel id");
    if (await isChannelArchiveDeletedInternal(channelId)) return { ok: false, saved: 0, deleted: true };
    if (typeof recordsJson !== "string" || Buffer.byteLength(recordsJson, "utf8") > MAX_BATCH_BYTES) {
        throw new Error("Invalid batch JSON payload");
    }

    const records = JSON.parse(recordsJson);
    if (!Array.isArray(records) || records.length > MAX_BATCH_MESSAGES) {
        throw new Error("Invalid message batch");
    }

    const validated = records.map(record => {
        const id = String(record?.id ?? "");
        assertSnowflake(id, "message id");
        if (String(record?.channelId ?? "") !== channelId) throw new Error("Message/channel mismatch");
        const compact = JSON.stringify(record);
        assertSmallJson(compact);
        return { id, record };
    });

    let saved = 0;
    let deleted = false;
    await queueViewerOp(channelId, async () => {
        await mkdir(messageDir(channelId), { recursive: true });
        await ensureFile(
            join(channelDir(channelId), "data.js"),
            `window.__LGA=window.__LGA||{channels:{},messages:{}};window.__LGA.messages[${jsSafeJson(channelId)}]=window.__LGA.messages[${jsSafeJson(channelId)}]||[];\n`
        );

        for (const { id, record } of validated) {
            if (deletedChannels.has(channelId)) {
                deleted = true;
                break;
            }

            const destination = join(messageDir(channelId), `${id}.json`);
            try {
                const deletion = JSON.parse(await readFile(deletionPath(channelId, id), "utf8"));
                record.deletedAt = String(deletion?.deletedAt ?? "");
            } catch { }
            try {
                const previous = JSON.parse(await readFile(destination, "utf8"));
                if (revisionSignature(previous) !== revisionSignature(record)) {
                    const revisions = revisionDir(channelId, id);
                    await mkdir(revisions, { recursive: true });
                    const revisionName = `${Date.now()}-${randomBytes(4).toString("hex")}.json`;
                    await writeFileAtomic(join(revisions, revisionName), JSON.stringify(previous, null, 2));
                }
            } catch { }

            await writeFileAtomic(destination, JSON.stringify(record, null, 2));
            saved++;
        }

        if (deletedChannels.has(channelId)) {
            deleted = true;
            await rm(channelDir(channelId), { recursive: true, force: true });
            return;
        }

        const appendText = validated.slice(0, saved)
            .map(({ record }) => `window.__LGA.messages[${jsSafeJson(channelId)}].push(${jsSafeJson(record)});`)
            .join("\n") + (saved ? "\n" : "");
        if (appendText) await appendFile(join(channelDir(channelId), "data.js"), appendText, "utf8");
    });

    return deleted
        ? { ok: false, saved: 0, deleted: true }
        : { ok: true, saved };
}

export async function deleteMessage(_: IpcMainInvokeEvent, channelId: string, messageId: string) {
    assertSnowflake(channelId, "channel id");
    assertSnowflake(messageId, "message id");
    if (await isChannelArchiveDeletedInternal(channelId)) return false;

    await queueViewerOp(channelId, async () => {
        const deletedAt = new Date().toISOString();
        const dir = join(channelDir(channelId), "deletions");
        await mkdir(dir, { recursive: true });
        await writeFileAtomic(deletionPath(channelId, messageId), JSON.stringify({ messageId, deletedAt }, null, 2));

        try {
            const path = join(messageDir(channelId), `${messageId}.json`);
            const record = JSON.parse(await readFile(path, "utf8"));
            record.deletedAt = deletedAt;
            await writeFileAtomic(path, JSON.stringify(record, null, 2));
            await appendFile(
                join(channelDir(channelId), "data.js"),
                `window.__LGA.messages[${jsSafeJson(channelId)}].push(${jsSafeJson(record)});\n`,
                "utf8"
            );
        } catch { }
    });
    return true;
}

export async function downloadAttachment(
    _: IpcMainInvokeEvent,
    channelId: string,
    messageId: string,
    attachmentId: string,
    rawUrl: string,
    originalFilename: string,
    expectedBytes = 0
) {
    assertSnowflake(channelId, "channel id");
    assertSnowflake(messageId, "message id");
    assertSnowflake(attachmentId, "attachment id");
    if (await isChannelArchiveDeletedInternal(channelId)) return { ok: false, bytes: 0, skipped: true, deleted: true };

    const dir = attachmentDir(channelId, messageId);
    await mkdir(dir, { recursive: true });
    const filename = `${attachmentId}-${safeFilename(originalFilename)}`;
    return downloadUrlToFile({
        key: `attachment:${channelId}:${messageId}:${attachmentId}`,
        channelId,
        rawUrl,
        finalPath: join(dir, filename),
        maxBytes: MAX_ATTACHMENT_BYTES,
        expectedBytes,
        validateUrl: validateAttachmentUrl
    });
}

export async function cacheAsset(
    _: IpcMainInvokeEvent,
    channelId: string,
    kind: string,
    fileName: string,
    rawUrl: string
) {
    assertSnowflake(channelId, "channel id");
    assertAssetFilename(fileName);
    if (!ASSET_KINDS.has(kind)) throw new Error("Invalid cached asset kind");
    if (await isChannelArchiveDeletedInternal(channelId)) return { ok: false, bytes: 0, skipped: true, deleted: true };

    const dir = assetDir(kind);
    await mkdir(dir, { recursive: true });
    return downloadUrlToFile({
        key: `asset:${kind}:${fileName}`,
        channelId,
        rawUrl,
        finalPath: join(dir, fileName),
        maxBytes: 64 * 1024 * 1024,
        validateUrl: validateAssetUrl
    });
}

export async function cancelChannelDownloads(_: IpcMainInvokeEvent, channelId: string) {
    assertSnowflake(channelId, "channel id");
    cancelDownloadsForChannel(channelId);
    return true;
}

export async function cancelAllDownloads(_: IpcMainInvokeEvent) {
    cancelDownloadsForChannel();
    return true;
}

export async function compactViewerData(_: IpcMainInvokeEvent, channelId: string) {
    assertSnowflake(channelId, "channel id");
    if (await isChannelArchiveDeletedInternal(channelId)) return false;
    await queueViewerOp(channelId, () => compactViewerDataInner(channelId));
    return true;
}

export async function getArchiveHealth(_: IpcMainInvokeEvent) {
    return getArchiveHealthInternal();
}

export async function getChannelArchiveBounds(_: IpcMainInvokeEvent, channelId: string) {
    return getChannelArchiveBoundsInternal(channelId);
}

export async function repairArchive(_: IpcMainInvokeEvent) {
    return repairArchiveInternal();
}

export async function prepareViewer(_: IpcMainInvokeEvent) {
    const ids = await listArchivedChannelIds();

    for (const channelId of ids) {
        try {
            const metaRaw = await readFile(join(channelDir(channelId), "meta.json"), "utf8");
            await writeMetaJs(channelId, JSON.parse(metaRaw));
            await queueViewerOp(channelId, () => compactViewerDataInner(channelId));
        } catch {
            // Ignore incomplete legacy folders.
        }
    }

    await rebuildViewerShell();
    return { channels: ids.length };
}

export async function openArchiveViewer(_: IpcMainInvokeEvent) {
    await rebuildViewerShell();
    const result = await shell.openPath(shortcutViewerPath());
    return result === "";
}

export async function openArchiveFolder(_: IpcMainInvokeEvent) {
    const root = archiveRoot();
    await mkdir(root, { recursive: true });
    const result = await shell.openPath(root);
    return result === "";
}

export async function shutdownViewerApi(_: IpcMainInvokeEvent) {
    cancelDownloadsForChannel();
    const server = viewerApiServer;
    viewerApiServer = null;
    viewerApiPort = 0;
    viewerApiStart = null;
    if (!server) return true;
    await new Promise<void>(resolve => server.close(() => resolve()));
    return true;
}
