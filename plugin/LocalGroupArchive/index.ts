/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import {
    ApplicationCommandInputType,
    ApplicationCommandOptionType,
    sendBotMessage
} from "@api/Commands";
import * as DataStore from "@api/DataStore";
import definePlugin, { PluginNative } from "@utils/types";
import {
    ChannelStore,
    Constants,
    FluxDispatcher,
    MessageStore,
    RestAPI,
    UserStore
} from "@webpack/common";

const Native = VencordNative.pluginHelpers.LocalGroupArchive as PluginNative<typeof import("./native")>;

const STORE_KEY = "LocalGroupArchive_enabledChannels";
const AUTO_KEY = "LocalGroupArchive_autoNewGroups";
const PLUGIN_VERSION = "0.5.0";
const GROUP_DM_TYPE = 3;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 5000;
const ATTACHMENT_CONCURRENCY = 6;
const AUTO_SCAN_INTERVAL_MS = 1000;
const DELETED_SYNC_INTERVAL_MS = 5000;
const DISK_FLUSH_EVERY_PAGES = 6;
const MAX_PENDING_ATTACHMENT_JOBS = 1200;
const ATTACHMENT_RETRIES = 3;
const MAX_RENDERER_BATCH_MESSAGES = 200;
const MAX_RENDERER_BATCH_BYTES = 20 * 1024 * 1024;

let enabledChannels = new Set<string>();
let knownGroupIds = new Set<string>();
let autoNewGroups = true;
let autoScanTimer: ReturnType<typeof setInterval> | null = null;
let pluginRunning = false;
let lastDeletedSync = 0;
let deletedSyncRunning = false;
let persistChain: Promise<void> = Promise.resolve();

const historyJobs = new Map<string, Promise<HistoryResult>>();
const catchupJobs = new Map<string, Promise<HistoryResult>>();
const historyGenerations = new Map<string, number>();
const ensuredChannels = new Set<string>();
const ensureJobs = new Map<string, Promise<boolean>>();
const autoCaptureStarted = new Set<string>();
const startupCatchupPending = new Set<string>();
const startupCatchupBoundaries = new Map<string, string | null>();

interface HistoryResult {
    messages: number;
    saved: number;
    pages: number;
    attachmentsQueued: number;
    writeFailures: number;
    reachedLimit?: boolean;
    cancelled?: boolean;
    partialError?: string;
}

interface AttachmentJob {
    key: string;
    channelId: string;
    run: () => Promise<unknown>;
    resolve: (result: AttachmentOutcome) => void;
}

interface AttachmentOutcome {
    ok: boolean;
    skipped?: boolean;
    cancelled?: boolean;
    error?: string;
}

interface BatchOutcome {
    saved: number;
    attachmentsQueued: number;
    deleted?: boolean;
}

const attachmentQueue: AttachmentJob[] = [];
let activeAttachmentJobs = 0;
const attachmentIdleWaiters = new Set<() => void>();
const attachmentCapacityWaiters = new Set<() => void>();
const attachmentJobs = new Map<string, Promise<AttachmentOutcome>>();
let attachmentCompleted = 0;
let attachmentFailed = 0;
let catchupTimer: ReturnType<typeof setTimeout> | null = null;

function isGroupDm(channelId: string) {
    return ChannelStore.getChannel(channelId)?.type === GROUP_DM_TYPE;
}

function currentGroupIds() {
    const channels = ChannelStore.getMutablePrivateChannels?.() ?? {};
    return Object.values(channels)
        .filter((channel: any) => channel?.type === GROUP_DM_TYPE && channel?.id)
        .map((channel: any) => String(channel.id));
}

function serializeDate(value: any): string | null {
    if (!value) return null;
    if (value instanceof Date) return value.toISOString();
    if (typeof value?.toISOString === "function") return value.toISOString();
    if (typeof value === "string") return value;
    return null;
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

function cdnAvatarUrl(user: any) {
    if (!user?.id || !user?.avatar) return null;
    return `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.webp?size=128`;
}

function cdnGroupIconUrl(channel: any) {
    const channelId = channel?.id ?? channel?.channelId;
    if (!channelId || !channel?.icon) return null;
    return `https://cdn.discordapp.com/channel-icons/${channelId}/${channel.icon}.webp?size=128`;
}

function mediaExtension(rawUrl: string | null | undefined, fallback = "bin") {
    try {
        const match = new URL(String(rawUrl)).pathname.match(/\.([a-z0-9]{2,5})$/i);
        const ext = match?.[1]?.toLowerCase();
        if (ext && ["png", "jpg", "jpeg", "webp", "gif", "avif", "mp4", "webm", "mov", "m4v"].includes(ext)) {
            return ext;
        }
    } catch { }
    return fallback;
}

function normalizeEmbeds(message: any, channelId: string, messageId: string) {
    const embeds: any[] = jsonSafe(message.embeds ?? []) ?? [];
    return embeds.map((embed, index) => {
        const remote = embed?.video?.proxy_url ?? embed?.video?.proxyURL ?? embed?.video?.url
            ?? embed?.image?.proxy_url ?? embed?.image?.proxyURL ?? embed?.image?.url
            ?? embed?.thumbnail?.proxy_url ?? embed?.thumbnail?.proxyURL ?? embed?.thumbnail?.url;
        if (!remote) return embed;
        const ext = mediaExtension(remote, embed?.video ? "mp4" : "webp");
        return {
            ...embed,
            localAsset: `_assets/embeds/${channelId}-${messageId}-${index}.${ext}`
        };
    });
}

function normalizeStickers(message: any) {
    const stickers: any[] = jsonSafe(message.sticker_items ?? message.stickerItems ?? []) ?? [];
    return stickers.map(sticker => {
        const format = Number(sticker?.format_type ?? sticker?.formatType ?? 1);
        const ext = format === 4 ? "gif" : "webp";
        return sticker?.id ? { ...sticker, localAsset: `_assets/stickers/${sticker.id}.${ext}` } : sticker;
    });
}

function buildChannelMeta(channelId: string) {
    const channel: any = ChannelStore.getChannel(channelId);
    const recipients: string[] = Array.isArray(channel?.recipients) ? channel.recipients : [];
    const currentUser: any = (UserStore as any).getCurrentUser?.();
    const allMemberIds = new Set(recipients);
    if (currentUser?.id) allMemberIds.add(String(currentUser.id));

    return {
        schemaVersion: 2,
        pluginVersion: PLUGIN_VERSION,
        channelId,
        name: channel?.name ?? null,
        icon: channel?.icon ?? null,
        ownerId: channel?.ownerId ?? channel?.owner_id ?? null,
        recipients: recipients.map(id => {
            const user: any = UserStore.getUser(id);
            return {
                id,
                username: user?.username ?? null,
                globalName: user?.globalName ?? user?.global_name ?? null,
                avatar: user?.avatar ?? null,
                discriminator: user?.discriminator ?? null
            };
        }),
        currentUser: currentUser ? {
            id: currentUser.id,
            username: currentUser.username ?? null,
            globalName: currentUser.globalName ?? currentUser.global_name ?? null,
            avatar: currentUser.avatar ?? null,
            discriminator: currentUser.discriminator ?? null
        } : null,
        memberCount: allMemberIds.size || recipients.length,
        updatedAt: new Date().toISOString()
    };
}

function jsonSafe(value: any) {
    if (value == null) return null;
    try {
        return JSON.parse(JSON.stringify(value));
    } catch {
        return null;
    }
}

function buildMessageRecord(message: any, captureSource: "live" | "history" | "snapshot" = "live") {
    const channelId = String(message.channel_id ?? message.channelId ?? "");
    const messageId = String(message.id ?? "");
    return {
        schemaVersion: 2,
        id: messageId,
        channelId,
        type: message.type ?? null,
        content: message.content ?? "",
        timestamp: serializeDate(message.timestamp),
        editedTimestamp: serializeDate(message.edited_timestamp ?? message.editedTimestamp),
        pinned: Boolean(message.pinned),
        tts: Boolean(message.tts),
        flags: message.flags ?? 0,
        mentionEveryone: Boolean(message.mention_everyone ?? message.mentionEveryone),
        applicationId: message.application_id ?? message.applicationId ?? null,
        webhookId: message.webhook_id ?? message.webhookId ?? null,
        application: jsonSafe(message.application),
        interactionMetadata: jsonSafe(message.interaction_metadata ?? message.interactionMetadata),
        interaction: jsonSafe(message.interaction),
        call: jsonSafe(message.call),
        messageSnapshots: jsonSafe(message.message_snapshots ?? message.messageSnapshots ?? []),
        author: message.author ? {
            id: message.author.id,
            username: message.author.username ?? null,
            globalName: message.author.globalName ?? message.author.global_name ?? null,
            discriminator: message.author.discriminator ?? null,
            avatar: message.author.avatar ?? null,
            avatarDecorationData: jsonSafe(message.author.avatar_decoration_data ?? message.author.avatarDecorationData),
            bot: Boolean(message.author.bot)
        } : null,
        mentions: (message.mentions ?? []).map((u: any) => ({
            id: u.id,
            username: u.username ?? null,
            globalName: u.global_name ?? u.globalName ?? null
        })),
        attachments: (message.attachments ?? []).map((a: any) => ({
            id: a.id,
            filename: a.filename,
            size: a.size ?? null,
            contentType: a.content_type ?? a.contentType ?? null,
            durationSecs: a.duration_secs ?? a.durationSecs ?? null,
            waveform: a.waveform ?? null,
            width: a.width ?? null,
            height: a.height ?? null,
            url: a.url ?? null,
            proxyUrl: a.proxy_url ?? a.proxyURL ?? null
        })),
        embeds: normalizeEmbeds(message, channelId, messageId),
        reactions: jsonSafe(message.reactions ?? []),
        stickerItems: normalizeStickers(message),
        components: jsonSafe(message.components ?? []),
        poll: jsonSafe(message.poll),
        messageReference: jsonSafe(message.message_reference ?? message.messageReference),
        referencedMessageId: message.message_reference?.message_id ?? message.messageReference?.messageId
            ?? message.referenced_message?.id ?? message.referencedMessage?.id ?? null,
        referencedMessage: jsonSafe(message.referenced_message ?? message.referencedMessage),
        captureSource,
        archivedAt: new Date().toISOString()
    };
}

function queuePersistence(op: () => Promise<void>) {
    persistChain = persistChain.catch(() => { }).then(op);
    return persistChain;
}

function persistEnabledChannels() {
    const snapshot = [...enabledChannels];
    return queuePersistence(() => DataStore.set(STORE_KEY, snapshot));
}

function persistAutoSetting() {
    const snapshot = autoNewGroups;
    return queuePersistence(() => DataStore.set(AUTO_KEY, snapshot));
}

function notifyAttachmentIdleIfNeeded() {
    if (attachmentQueue.length < MAX_PENDING_ATTACHMENT_JOBS) {
        for (const resolve of attachmentCapacityWaiters) resolve();
        attachmentCapacityWaiters.clear();
    }
    if (activeAttachmentJobs !== 0 || attachmentQueue.length !== 0) return;
    for (const resolve of attachmentIdleWaiters) resolve();
    attachmentIdleWaiters.clear();
}

function waitForAttachmentCapacity() {
    if (attachmentQueue.length < MAX_PENDING_ATTACHMENT_JOBS) return Promise.resolve();
    return new Promise<void>(resolve => attachmentCapacityWaiters.add(resolve));
}

function wait(ms: number) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function runBackground(label: string, promise: Promise<unknown>) {
    void promise.catch(error => console.warn(`[LocalGroupArchive] ${label}`, error));
}

async function runAttachmentJob(job: AttachmentJob): Promise<AttachmentOutcome> {
    let lastError = "Download failed";

    for (let attempt = 1; attempt <= ATTACHMENT_RETRIES; attempt++) {
        if (!pluginRunning || !enabledChannels.has(job.channelId)) {
            return { ok: false, cancelled: true };
        }

        try {
            const result: any = await job.run();
            if (result?.deleted || result?.cancelled) return { ok: false, cancelled: true };
            if (result?.ok === false) throw new Error(result?.error ?? "Download failed");
            return { ok: true, skipped: Boolean(result?.skipped) };
        } catch (error: any) {
            lastError = String(error?.message ?? error);
            if (attempt < ATTACHMENT_RETRIES) await wait(350 * 2 ** (attempt - 1));
        }
    }

    return { ok: false, error: lastError };
}

function pumpAttachmentQueue() {
    while (activeAttachmentJobs < ATTACHMENT_CONCURRENCY && attachmentQueue.length > 0) {
        const job = attachmentQueue.shift()!;
        activeAttachmentJobs++;

        void runAttachmentJob(job)
            .then(result => {
                if (result.ok) attachmentCompleted++;
                else if (!result.cancelled) {
                    attachmentFailed++;
                    console.warn(`[LocalGroupArchive] Download failed for ${job.key}: ${result.error}`);
                }
                job.resolve(result);
            })
            .finally(() => {
                activeAttachmentJobs--;
                attachmentJobs.delete(job.key);
                pumpAttachmentQueue();
                notifyAttachmentIdleIfNeeded();
            });
    }
}

function enqueueAttachment(key: string, channelId: string, run: () => Promise<unknown>) {
    const existing = attachmentJobs.get(key);
    if (existing) return { promise: existing, queued: false };

    const promise = new Promise<AttachmentOutcome>(resolve => {
        attachmentQueue.push({ key, channelId, run, resolve });
        pumpAttachmentQueue();
    });
    attachmentJobs.set(key, promise);
    return { promise, queued: true };
}

function waitForAttachmentQueue() {
    if (activeAttachmentJobs === 0 && attachmentQueue.length === 0) return Promise.resolve();
    return new Promise<void>(resolve => attachmentIdleWaiters.add(resolve));
}

function cancelQueuedAttachments(channelId?: string) {
    for (let index = attachmentQueue.length - 1; index >= 0; index--) {
        const job = attachmentQueue[index];
        if (channelId && job.channelId !== channelId) continue;
        attachmentQueue.splice(index, 1);
        attachmentJobs.delete(job.key);
        job.resolve({ ok: false, cancelled: true });
    }
    notifyAttachmentIdleIfNeeded();
}

function queueCachedAsset(channelId: string, kind: string, fileName: string, rawUrl: string | null | undefined) {
    if (!rawUrl) return false;
    return enqueueAttachment(
        `asset:${kind}:${fileName}`,
        channelId,
        () => Native.cacheAsset(channelId, kind, fileName, rawUrl)
    ).queued;
}

function queueUserAsset(channelId: string, user: any) {
    const url = cdnAvatarUrl(user);
    if (!url) return false;
    return queueCachedAsset(channelId, "avatars", `${user.id}-${user.avatar}.webp`, url);
}

function queueChannelAssets(channelId: string, meta: any) {
    if (meta?.icon) {
        queueCachedAsset(channelId, "group-icons", `${channelId}-${meta.icon}.webp`, cdnGroupIconUrl(meta));
    }
    for (const user of [...(meta?.recipients ?? []), meta?.currentUser].filter(Boolean)) {
        queueUserAsset(channelId, user);
    }
}

function queueMessageAssets(record: any) {
    const channelId = String(record.channelId);
    let queued = 0;
    if (queueUserAsset(channelId, record.author)) queued++;
    if (queueUserAsset(channelId, record.referencedMessage?.author)) queued++;

    for (let index = 0; index < (record.embeds?.length ?? 0); index++) {
        const embed = record.embeds[index];
        const remote = embed?.video?.proxy_url ?? embed?.video?.proxyURL ?? embed?.video?.url
            ?? embed?.image?.proxy_url ?? embed?.image?.proxyURL ?? embed?.image?.url
            ?? embed?.thumbnail?.proxy_url ?? embed?.thumbnail?.proxyURL ?? embed?.thumbnail?.url;
        const localName = String(embed?.localAsset ?? "").split("/").at(-1);
        if (remote && localName && queueCachedAsset(channelId, "embeds", localName, remote)) queued++;
    }

    for (const sticker of record.stickerItems ?? []) {
        if (!sticker?.id || !sticker?.localAsset) continue;
        const format = Number(sticker.format_type ?? sticker.formatType ?? 1);
        const ext = format === 4 ? "gif" : "webp";
        const localName = String(sticker.localAsset).split("/").at(-1) ?? `${sticker.id}.${ext}`;
        const host = format === 4 ? "cdn.discordapp.com" : "media.discordapp.net";
        if (queueCachedAsset(channelId, "stickers", localName, `https://${host}/stickers/${sticker.id}.${ext}?size=320`)) queued++;
    }

    for (const reaction of record.reactions ?? []) {
        const emoji = reaction?.emoji;
        if (!emoji?.id) continue;
        const ext = emoji.animated ? "gif" : "webp";
        if (queueCachedAsset(
            channelId,
            "emojis",
            `${emoji.id}.${ext}`,
            `https://cdn.discordapp.com/emojis/${emoji.id}.${ext}?size=64`
        )) queued++;
    }

    const emojiPattern = /<a?:[^:>]+:(\d{15,22})>/g;
    for (const match of String(record.content ?? "").matchAll(emojiPattern)) {
        const animated = match[0].startsWith("<a:");
        if (queueCachedAsset(
            channelId,
            "emojis",
            `${match[1]}.${animated ? "gif" : "webp"}`,
            `https://cdn.discordapp.com/emojis/${match[1]}.${animated ? "gif" : "webp"}?size=64&quality=lossless`
        )) queued++;
    }

    return queued;
}

function queueAttachmentsFromMessages(messages: any[], records: any[]) {
    let queued = 0;

    for (let index = 0; index < messages.length; index++) {
        const message = messages[index];
        const record = records[index];
        const channelId = message?.channel_id ?? message?.channelId;
        const messageId = message?.id;
        if (!channelId || !messageId) continue;

        queued += queueMessageAssets(record);

        for (const attachment of message.attachments ?? []) {
            const url = attachment.url ?? attachment.proxy_url ?? attachment.proxyURL;
            if (!url || !attachment.id || !attachment.filename) continue;

            const result = enqueueAttachment(
                `attachment:${channelId}:${messageId}:${attachment.id}`,
                String(channelId),
                () => Native.downloadAttachment(
                    channelId,
                    messageId,
                    attachment.id,
                    url,
                    attachment.filename,
                    Number(attachment.size ?? 0)
                )
            );
            if (result.queued) queued++;
        }
    }

    return queued;
}

function ensureChannel(channelId: string, force = false): Promise<boolean> {
    const existing = ensureJobs.get(channelId);
    if (existing) {
        if (!force) return existing;
        return existing.catch(() => false).then(() => {
            ensuredChannels.delete(channelId);
            return ensureChannel(channelId);
        });
    }
    if (force) ensuredChannels.delete(channelId);
    if (ensuredChannels.has(channelId)) return Promise.resolve(true);

    const meta = buildChannelMeta(channelId);
    const job: Promise<boolean> = Native.ensureChannel(channelId, JSON.stringify(meta, null, 2))
        .then(created => {
            if (!created) {
                handleArchiveDeleted(channelId);
                return false;
            }
            ensuredChannels.add(channelId);
            queueChannelAssets(channelId, meta);
            return true;
        })
        .catch(error => {
            ensuredChannels.delete(channelId);
            throw error;
        })
        .finally(() => {
            if (ensureJobs.get(channelId) === job) ensureJobs.delete(channelId);
        });
    ensureJobs.set(channelId, job);
    return job;
}

async function saveMessageBatch(
    channelId: string,
    messages: any[],
    captureSource: "live" | "history" | "snapshot" = "live"
): Promise<BatchOutcome> {
    if (!pluginRunning || !enabledChannels.has(channelId) || messages.length === 0) {
        return { saved: 0, attachmentsQueued: 0 };
    }

    const entries = messages
        .filter(message => message?.id && String(message?.channel_id ?? message?.channelId) === channelId)
        .map(message => ({ message, record: buildMessageRecord(message, captureSource) }));

    if (entries.length === 0) return { saved: 0, attachmentsQueued: 0 };

    const encoder = new TextEncoder();
    const chunks: typeof entries[] = [];
    let current: typeof entries = [];
    let currentBytes = 2;
    for (const entry of entries) {
        const entryBytes = encoder.encode(JSON.stringify(entry.record)).byteLength + 1;
        if (current.length && (current.length >= MAX_RENDERER_BATCH_MESSAGES || currentBytes + entryBytes > MAX_RENDERER_BATCH_BYTES)) {
            chunks.push(current);
            current = [];
            currentBytes = 2;
        }
        current.push(entry);
        currentBytes += entryBytes;
    }
    if (current.length) chunks.push(current);

    let saved = 0;
    let attachmentsQueued = 0;
    for (const chunk of chunks) {
        if (!pluginRunning || !enabledChannels.has(channelId)) break;
        let result: any;
        try {
            result = await Native.saveMessagesBatch(channelId, JSON.stringify(chunk.map(entry => entry.record)));
        } catch (error) {
            console.warn("[LocalGroupArchive] Batch save failed", error);
            throw error;
        }
        if (result?.deleted) {
            handleArchiveDeleted(channelId);
            return { saved, attachmentsQueued, deleted: true };
        }

        const written = Math.max(0, Math.min(chunk.length, Number(result?.saved ?? chunk.length)));
        const persisted = chunk.slice(0, written);
        saved += written;
        attachmentsQueued += queueAttachmentsFromMessages(
            persisted.map(entry => entry.message),
            persisted.map(entry => entry.record)
        );
    }
    return { saved, attachmentsQueued };
}

async function saveSingleMessage(message: any): Promise<BatchOutcome> {
    const channelId = String(message?.channel_id ?? message?.channelId ?? "");
    if (!channelId || !enabledChannels.has(channelId) || !isGroupDm(channelId)) {
        return { saved: 0, attachmentsQueued: 0 };
    }

    await ensureChannel(channelId);
    return saveMessageBatch(channelId, [message], "live");
}

async function snapshotLoaded(channelId: string) {
    const messages: any = MessageStore.getMessages(channelId);
    if (!messages) return { count: 0, saved: 0, attachmentsQueued: 0 };

    const pending: any[] = [];
    messages.forEach((message: any) => pending.push(message));

    if (pending.length === 0) return { count: 0, saved: 0, attachmentsQueued: 0 };
    const result = await saveMessageBatch(channelId, pending, "snapshot");
    return { count: pending.length, saved: result.saved, attachmentsQueued: result.attachmentsQueued };
}

async function fetchHistoryPage(channelId: string, before?: string) {
    const query: Record<string, string | number> = { limit: HISTORY_PAGE_SIZE };
    if (before) query.before = before;

    const response = await RestAPI.get({
        url: Constants.Endpoints.MESSAGES(channelId),
        query,
        retries: 3
    });

    return Array.isArray(response?.body) ? response.body : [];
}

function cancelHistory(channelId: string) {
    historyGenerations.set(channelId, (historyGenerations.get(channelId) ?? 0) + 1);
}

function handleArchiveDeleted(channelId: string) {
    const changed = enabledChannels.delete(channelId);
    ensuredChannels.delete(channelId);
    autoCaptureStarted.delete(channelId);
    startupCatchupPending.delete(channelId);
    startupCatchupBoundaries.delete(channelId);
    cancelHistory(channelId);
    cancelQueuedAttachments(channelId);
    if (changed) runBackground("Could not persist deleted archive state", persistEnabledChannels());
}

async function syncDeletedChannels() {
    if (deletedSyncRunning || Date.now() - lastDeletedSync < DELETED_SYNC_INTERVAL_MS) return;
    deletedSyncRunning = true;
    lastDeletedSync = Date.now();
    try {
        const deletedIds = await Native.getDeletedChannelIds();
        for (const channelId of deletedIds) handleArchiveDeleted(channelId);
    } catch (error) {
        console.warn("[LocalGroupArchive] Could not synchronize deleted archives", error);
    } finally {
        deletedSyncRunning = false;
    }
}

async function archiveFullHistoryInner(channelId: string, generation: number): Promise<HistoryResult> {
    let before: string | undefined;
    let pages = 0;
    let messages = 0;
    let saved = 0;
    let attachmentsQueued = 0;
    let writeFailures = 0;
    let previousOldest: string | undefined;
    let cancelled = false;
    let reachedLimit = false;
    let partialError: string | undefined;
    let pendingDiskWrites: Promise<BatchOutcome>[] = [];

    const ready = await ensureChannel(channelId);
    if (!ready) {
        handleArchiveDeleted(channelId);
        return { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0, cancelled: true };
    }

    const flushDiskWrites = async () => {
        if (pendingDiskWrites.length === 0) return;
        const current = pendingDiskWrites;
        pendingDiskWrites = [];
        const results = await Promise.allSettled(current);
        for (const result of results) {
            if (result.status === "fulfilled") {
                saved += result.value.saved;
                attachmentsQueued += result.value.attachmentsQueued;
                if (result.value.deleted) cancelled = true;
            } else {
                writeFailures++;
                partialError ??= String(result.reason?.message ?? result.reason);
            }
        }
    };

    try {
        while (pages < MAX_HISTORY_PAGES) {
            if (!pluginRunning || !enabledChannels.has(channelId) || !isGroupDm(channelId)
                || historyGenerations.get(channelId) !== generation) {
                cancelled = true;
                break;
            }

            await waitForAttachmentCapacity();
            const page = await fetchHistoryPage(channelId, before);
            if (page.length === 0) break;

            messages += page.length;
            pages++;

            // Important for short-lived Group DMs: start the disk write, then immediately
            // request the next history page instead of waiting on 100 individual file writes.
            pendingDiskWrites.push(saveMessageBatch(channelId, page, "history"));

            const oldestId = page[page.length - 1]?.id as string | undefined;
            if (!oldestId || oldestId === previousOldest) break;

            previousOldest = oldestId;
            before = oldestId;

            if (page.length < HISTORY_PAGE_SIZE) break;

            // Keep memory/IPC bounded for extremely large chats without slowing the first pages.
            if (pages % DISK_FLUSH_EVERY_PAGES === 0) await flushDiskWrites();
        }
        reachedLimit = pages >= MAX_HISTORY_PAGES;
    } catch (error: any) {
        partialError = String(error?.message ?? error);
    }

    await flushDiskWrites();
    if (!cancelled) {
        try {
            await Native.compactViewerData(channelId);
        } catch (error: any) {
            writeFailures++;
            partialError ??= `Viewer compaction: ${String(error?.message ?? error)}`;
        }
    }

    if (partialError && messages === 0) throw new Error(partialError);
    return { messages, saved, pages, attachmentsQueued, writeFailures, reachedLimit, cancelled, partialError };
}

function archiveFullHistory(channelId: string) {
    const existing = historyJobs.get(channelId);
    if (existing) return existing;

    const generation = (historyGenerations.get(channelId) ?? 0) + 1;
    historyGenerations.set(channelId, generation);
    const job = archiveFullHistoryInner(channelId, generation)
        .finally(() => historyJobs.delete(channelId));

    historyJobs.set(channelId, job);
    return job;
}

async function archiveRecentHistoryInner(channelId: string, generation: number): Promise<HistoryResult> {
    const ready = await ensureChannel(channelId);
    if (!ready) return { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0, cancelled: true };

    const hasStartupBoundary = startupCatchupBoundaries.has(channelId);
    const bounds = hasStartupBoundary ? null : await Native.getChannelArchiveBounds(channelId);
    const newestKnown = hasStartupBoundary
        ? startupCatchupBoundaries.get(channelId) ?? null
        : typeof bounds?.newestId === "string" ? bounds.newestId : null;
    startupCatchupBoundaries.delete(channelId);
    if (!newestKnown) return archiveFullHistory(channelId);

    let before: string | undefined;
    let previousOldest: string | undefined;
    let messages = 0;
    let saved = 0;
    let pages = 0;
    let attachmentsQueued = 0;
    let writeFailures = 0;
    let cancelled = false;
    let partialError: string | undefined;

    try {
        while (pages < MAX_HISTORY_PAGES) {
            if (!pluginRunning || !enabledChannels.has(channelId) || !isGroupDm(channelId)
                || historyGenerations.get(channelId) !== generation) {
                cancelled = true;
                break;
            }

            await waitForAttachmentCapacity();
            const page = await fetchHistoryPage(channelId, before);
            if (page.length === 0) break;
            pages++;

            const pageIds = page.map(message => String(message?.id ?? "")).filter(Boolean);
            const oldestId = pageIds.sort(snowflakeCompare)[0];
            const recent = page.filter(message => snowflakeCompare(String(message?.id ?? "0"), newestKnown) > 0);
            messages += recent.length;
            if (recent.length) {
                try {
                    const result = await saveMessageBatch(channelId, recent, "history");
                    saved += result.saved;
                    attachmentsQueued += result.attachmentsQueued;
                    if (result.deleted) {
                        cancelled = true;
                        break;
                    }
                } catch (error: any) {
                    writeFailures++;
                    partialError ??= String(error?.message ?? error);
                }
            }

            if (!oldestId || oldestId === previousOldest || snowflakeCompare(oldestId, newestKnown) <= 0) break;
            previousOldest = oldestId;
            before = oldestId;
            if (page.length < HISTORY_PAGE_SIZE) break;
        }
    } catch (error: any) {
        partialError = String(error?.message ?? error);
    }

    if (!cancelled && messages) {
        try {
            await Native.compactViewerData(channelId);
        } catch (error: any) {
            writeFailures++;
            partialError ??= `Viewer compaction: ${String(error?.message ?? error)}`;
        }
    }

    return {
        messages,
        saved,
        pages,
        attachmentsQueued,
        writeFailures,
        cancelled,
        partialError,
        reachedLimit: pages >= MAX_HISTORY_PAGES
    };
}

function archiveRecentHistory(channelId: string) {
    const existing = catchupJobs.get(channelId);
    if (existing) return existing;
    const full = historyJobs.get(channelId);
    if (full) return full;

    const generation = (historyGenerations.get(channelId) ?? 0) + 1;
    historyGenerations.set(channelId, generation);
    const job = archiveRecentHistoryInner(channelId, generation)
        .finally(() => catchupJobs.delete(channelId));
    catchupJobs.set(channelId, job);
    return job;
}

async function resumeEnabledArchives() {
    const channelIds = [...enabledChannels].filter(isGroupDm);
    let next = 0;
    const worker = async () => {
        while (pluginRunning) {
            const channelId = channelIds[next++];
            if (!channelId) return;
            startupCatchupPending.delete(channelId);
            try {
                const result = await archiveRecentHistory(channelId);
                if (result.saved || result.writeFailures || result.partialError) {
                    console.info(`[LocalGroupArchive] Startup catch-up for ${channelId}: ${result.saved}/${result.messages} saved.`);
                }
            } catch (error) {
                console.warn(`[LocalGroupArchive] Startup catch-up failed for ${channelId}`, error);
            }
        }
    };
    await Promise.all([worker(), worker()]);
}

async function captureStartupBoundaries() {
    const channelIds = [...enabledChannels];
    let next = 0;
    const worker = async () => {
        while (pluginRunning) {
            const channelId = channelIds[next++];
            if (!channelId) return;
            const bounds = await Native.getChannelArchiveBounds(channelId).catch(() => null);
            startupCatchupBoundaries.set(channelId, typeof bounds?.newestId === "string" ? bounds.newestId : null);
        }
    };
    await Promise.all([worker(), worker()]);
}

function startAutomaticCapture(channelId: string) {
    if (!pluginRunning || !autoNewGroups || autoCaptureStarted.has(channelId) || !isGroupDm(channelId)) return;
    autoCaptureStarted.add(channelId);
    startupCatchupPending.delete(channelId);
    startupCatchupBoundaries.delete(channelId);
    enabledChannels.add(channelId);

    runBackground("Could not persist automatic capture state", persistEnabledChannels());
    void (async () => {
        try {
            if (!await ensureChannel(channelId)) return;
            const snapshot = snapshotLoaded(channelId)
                .catch(error => {
                    console.warn("[LocalGroupArchive] Auto snapshot failed", error);
                    return { count: 0, saved: 0, attachmentsQueued: 0 };
                });
            const history = archiveFullHistory(channelId);
            await snapshot;
            const result = await history;
            console.info(
                `[LocalGroupArchive] Auto-captured ${result.saved}/${result.messages} message(s) from ${channelId} across ${result.pages} page(s).`
            );
        } catch (error) {
            console.warn("[LocalGroupArchive] Auto history capture failed", error);
        }
    })();
}

function scanForNewGroups() {
    if (!pluginRunning) return;
    const current = new Set(currentGroupIds());

    for (const channelId of current) {
        if (enabledChannels.has(channelId) && startupCatchupPending.delete(channelId)) {
            runBackground("Late startup catch-up failed", archiveRecentHistory(channelId));
        }
        if (!knownGroupIds.has(channelId)) {
            knownGroupIds.add(channelId);
            startAutomaticCapture(channelId);
        }
    }

    // If Discord removes a Group DM from the store after a kick/leave, forgetting it here lets
    // a future reappearance of the same channel be treated as new again.
    for (const channelId of [...knownGroupIds]) {
        if (!current.has(channelId)) {
            if (startupCatchupPending.has(channelId)) continue;
            knownGroupIds.delete(channelId);
            autoCaptureStarted.delete(channelId);
        }
    }

    void syncDeletedChannels();
}

function onChannelCreate(event: any) {
    const channel = event?.channel ?? event;
    const channelId = channel?.id;
    if (!channelId || channel?.type !== GROUP_DM_TYPE) return;

    if (enabledChannels.has(channelId) && startupCatchupPending.delete(channelId)) {
        knownGroupIds.add(channelId);
        runBackground("Late channel-create catch-up failed", archiveRecentHistory(channelId));
        return;
    }
    if (!knownGroupIds.has(channelId)) {
        knownGroupIds.add(channelId);
        startAutomaticCapture(channelId);
    }
}

function onChannelUpdate(event: any) {
    const channel = event?.channel ?? event;
    const channelId = String(channel?.id ?? "");
    if (!channelId || !isGroupDm(channelId) || !enabledChannels.has(channelId)) return;
    void ensureChannel(channelId, true).catch(error => {
        console.warn("[LocalGroupArchive] Could not refresh Group DM metadata", error);
    });
}

function onMessageCreate(event: any) {
    const message = event?.message;
    if (!message) return;

    const channelId = message.channel_id ?? message.channelId;
    if (channelId && isGroupDm(channelId) && !knownGroupIds.has(channelId)) {
        knownGroupIds.add(channelId);
        startAutomaticCapture(channelId);
    }

    runBackground("Could not save a new message", saveSingleMessage(message));
}

function onMessageUpdate(event: any) {
    const channelId = String(event?.message?.channel_id ?? event?.message?.channelId ?? event?.channelId ?? "");
    const messageId = String(event?.message?.id ?? event?.id ?? "");
    if (!channelId || !messageId || !enabledChannels.has(channelId)) return;

    queueMicrotask(async () => {
        const current = MessageStore.getMessage(channelId, messageId);
        if (current) {
            runBackground("Could not save an updated message", saveSingleMessage(current));
            return;
        }

        // MESSAGE_UPDATE payloads may contain only changed fields. Never replace a full
        // archived message with a partial event if Discord's store no longer has it.
        try {
            const response = await RestAPI.get({
                url: Constants.Endpoints.MESSAGE(channelId, messageId),
                retries: 2
            });
            if (response?.body?.id) runBackground("Could not save a refreshed message", saveSingleMessage(response.body));
        } catch (error) {
            console.warn(`[LocalGroupArchive] Could not refresh updated message ${messageId}`, error);
        }
    });
}

function onMessageStateChange(event: any) {
    const channelId = event?.channelId ?? event?.channel_id ?? event?.message?.channel_id;
    const messageId = event?.messageId ?? event?.message_id ?? event?.id ?? event?.message?.id;
    if (!channelId || !messageId || !enabledChannels.has(channelId)) return;
    queueMicrotask(() => {
        const current = MessageStore.getMessage(channelId, messageId);
        if (current) runBackground("Could not save updated reaction state", saveSingleMessage(current));
    });
}

function onMessageDelete(event: any) {
    const channelId = event?.channelId ?? event?.channel_id;
    const messageId = event?.id ?? event?.messageId ?? event?.message_id;
    if (!channelId || !messageId || !enabledChannels.has(channelId)) return;

    runBackground("Could not mark a deleted message", Native.deleteMessage(channelId, messageId));
}

function onMessageDeleteBulk(event: any) {
    const channelId = event?.channelId ?? event?.channel_id;
    const ids = Array.from(event?.ids ?? event?.messageIds ?? [], value => String(value));
    if (!channelId || !enabledChannels.has(channelId)) return;
    for (const id of ids) runBackground("Could not mark a bulk-deleted message", Native.deleteMessage(channelId, id));
}

async function restoreAndEnable(channelId: string) {
    cancelHistory(channelId);
    const currentJob = historyJobs.get(channelId);
    if (currentJob) await currentJob.catch(() => { });
    const catchupJob = catchupJobs.get(channelId);
    if (catchupJob) await catchupJob.catch(() => { });
    startupCatchupPending.delete(channelId);
    startupCatchupBoundaries.delete(channelId);

    await Native.restoreChannelArchive(channelId);
    ensuredChannels.delete(channelId);
    enabledChannels.add(channelId);
    autoCaptureStarted.add(channelId);
    await persistEnabledChannels();
    return ensureChannel(channelId, true);
}

function historySummary(result: HistoryResult) {
    const parts = [
        `Fetched **${result.messages}** and safely wrote **${result.saved}** message(s) across ${result.pages} page(s).`,
        `${result.attachmentsQueued} new media download(s) queued.`
    ];
    if (result.writeFailures) parts.push(`⚠️ ${result.writeFailures} disk batch(es) failed.`);
    if (result.reachedLimit) parts.push("⚠️ The 500,000-message safety limit was reached; older messages may remain.");
    if (result.partialError) parts.push(`Partial error: ${result.partialError}`);
    if (result.cancelled) parts.push("Capture was cancelled; already-written pages were preserved.");
    return parts.join(" ");
}

function formatBytes(value: number) {
    const units = ["B", "KiB", "MiB", "GiB", "TiB"];
    let amount = Number(value) || 0;
    let unit = 0;
    while (amount >= 1024 && unit < units.length - 1) {
        amount /= 1024;
        unit++;
    }
    return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function commandChoice(label: string, value: string) {
    return { label, name: label, value };
}

export default definePlugin({
    name: "LocalGroupArchive",
    description: "Fast local Group DM archiver with automatic new-group capture, attachments, and a Discord-style HTML viewer.",
    authors: [{ name: "Faisal", id: 0n }],
    tags: ["Chat", "Utility"],

    commands: [
        {
            name: "localarchive",
            description: "Control LocalGroupArchive",
            inputType: ApplicationCommandInputType.BUILT_IN,
            options: [
                {
                    name: "action",
                    description: "Choose what to do",
                    type: ApplicationCommandOptionType.STRING,
                    required: true,
                    choices: [
                        commandChoice("Start + archive FULL history", "start"),
                        commandChoice("Archive FULL history again", "full"),
                        commandChoice("Snapshot currently loaded messages", "snapshot"),
                        commandChoice("Wait for attachment downloads", "wait"),
                        commandChoice("Auto-capture NEW Group DMs: ON", "auto-on"),
                        commandChoice("Auto-capture NEW Group DMs: OFF", "auto-off"),
                        commandChoice("Open Discord-style HTML viewer", "viewer"),
                        commandChoice("Open archive folder", "folder"),
                        commandChoice("Check archive health + storage", "health"),
                        commandChoice("Repair viewer + stale temp files", "repair"),
                        commandChoice("Run interactive setup guide", "guide"),
                        commandChoice("Stop archiving this group", "stop"),
                        commandChoice("Show status", "status")
                    ]
                }
            ],
            execute: async (args, ctx) => {
                const action = args.find(a => a.name === "action")?.value as string | undefined;
                const channelId = ctx.channel.id;

                if (action === "folder") {
                    await Native.openArchiveFolder();
                    sendBotMessage(channelId, { content: "Opened **Documents/DiscordLocalArchive**." });
                    return;
                }

                if (action === "viewer") {
                    await Native.prepareViewer();
                    await Native.openArchiveViewer();
                    sendBotMessage(channelId, { content: "Opened the local **Discord-style HTML archive viewer**." });
                    return;
                }

                if (action === "health") {
                    const health = await Native.getArchiveHealth();
                    const issues = Number(health.corruptMessages ?? 0) + Number(health.partialFiles ?? 0);
                    sendBotMessage(channelId, {
                        content: `Archive health: **${health.channelCount}** group(s), **${health.totalMessages}** message file(s), **${health.assetFiles}** cached asset(s), **${formatBytes(health.bytes)}** total. ${issues ? `⚠️ Found ${health.corruptMessages} corrupt message file(s) and ${health.partialFiles} temporary file(s).` : "**No structural issues found.**"}`
                    });
                    return;
                }

                if (action === "repair") {
                    sendBotMessage(channelId, { content: "Repairing viewer indexes and cleaning stale temporary files older than 15 minutes…" });
                    const result = await Native.repairArchive();
                    sendBotMessage(channelId, {
                        content: `Repair complete: rebuilt **${result.rebuiltChannels}** group index(es), removed **${result.removedTransientFiles}** stale temporary file(s). Remaining corrupt message files: **${result.health.corruptMessages}**.`
                    });
                    return;
                }

                if (action === "guide") {
                    window.dispatchEvent(new CustomEvent("LocalGroupArchive:StartGuide"));
                    sendBotMessage(channelId, { content: "Started the interactive **LocalGroupArchive setup guide**." });
                    return;
                }

                if (action === "auto-on") {
                    autoNewGroups = true;
                    await persistAutoSetting();
                    knownGroupIds = new Set(currentGroupIds());
                    sendBotMessage(channelId, { content: "Automatic capture for **new Group DMs is ON**. Existing Group DMs are treated as the baseline and are not auto-backfilled." });
                    return;
                }

                if (action === "auto-off") {
                    autoNewGroups = false;
                    await persistAutoSetting();
                    sendBotMessage(channelId, { content: "Automatic capture for **new Group DMs is OFF**." });
                    return;
                }

                if (!isGroupDm(channelId)) {
                    sendBotMessage(channelId, { content: "This action only works in **Group DMs**." });
                    return;
                }

                if (action === "start") {
                    await restoreAndEnable(channelId);

                    sendBotMessage(channelId, {
                        content: "Archive **ON**. Fast-history mode is fetching up to 100 messages per REST page with no artificial page delay. Disk writes are batched and attachments download in parallel."
                    });

                    try {
                        const result = await archiveFullHistory(channelId);
                        sendBotMessage(channelId, {
                            content: `${historySummary(result)} New messages keep archiving automatically.`
                        });
                    } catch (error: any) {
                        console.error("[LocalGroupArchive] Full history failed", error);
                        sendBotMessage(channelId, {
                            content: `Archive is still **ON**, but the history fetch failed: ${String(error?.message ?? error)}`
                        });
                    }
                    return;
                }

                if (action === "full") {
                    await restoreAndEnable(channelId);

                    sendBotMessage(channelId, { content: "Fast re-scan started. Existing local message/attachment files are reused safely." });
                    try {
                        const result = await archiveFullHistory(channelId);
                        sendBotMessage(channelId, {
                            content: historySummary(result)
                        });
                    } catch (error: any) {
                        sendBotMessage(channelId, { content: `Full-history scan failed: ${String(error?.message ?? error)}` });
                    }
                    return;
                }

                if (action === "snapshot") {
                    await restoreAndEnable(channelId);
                    const result = await snapshotLoaded(channelId);
                    sendBotMessage(channelId, { content: `Snapshot read **${result.count}** and wrote **${result.saved}** currently loaded message(s); ${result.attachmentsQueued} new media download(s) queued.` });
                    return;
                }

                if (action === "wait") {
                    const failedBefore = attachmentFailed;
                    const completedBefore = attachmentCompleted;
                    sendBotMessage(channelId, { content: "Waiting for the local attachment download queue to finish…" });
                    await waitForAttachmentQueue();
                    const newFailures = attachmentFailed - failedBefore;
                    const newCompleted = attachmentCompleted - completedBefore;
                    sendBotMessage(channelId, {
                        content: `Media queue finished: **${newCompleted}** completed${newFailures ? `, **${newFailures} failed** and can be retried with a Full scan` : ", no failures"}.`
                    });
                    return;
                }

                if (action === "stop") {
                    enabledChannels.delete(channelId);
                    autoCaptureStarted.delete(channelId);
                    startupCatchupPending.delete(channelId);
                    startupCatchupBoundaries.delete(channelId);
                    cancelHistory(channelId);
                    cancelQueuedAttachments(channelId);
                    runBackground("Could not cancel channel downloads", Native.cancelChannelDownloads(channelId));
                    await persistEnabledChannels();
                    sendBotMessage(channelId, { content: "Archive **OFF** for this group. Existing local files were kept." });
                    return;
                }

                const running = historyJobs.has(channelId)
                    ? " A full-history scan is currently running."
                    : catchupJobs.has(channelId) ? " A startup catch-up scan is currently running." : "";
                sendBotMessage(channelId, {
                    content: `LocalGroupArchive **v${PLUGIN_VERSION}**\n${enabledChannels.has(channelId) ? "Archive status: **ON**." : "Archive status: **OFF**."}${running}\nAuto-capture new Group DMs: **${autoNewGroups ? "ON" : "OFF"}**.\nMedia workers: ${activeAttachmentJobs} active, ${attachmentQueue.length} queued, ${attachmentCompleted} completed, ${attachmentFailed} failed this session.`
                });
            }
        }
    ],

    async start() {
        pluginRunning = true;
        const stored = await DataStore.get<string[]>(STORE_KEY).catch(() => []);
        const storedChannels = Array.isArray(stored) ? stored : [];
        const deletedChannelIds = new Set(await Native.getDeletedChannelIds().catch(() => []));
        enabledChannels = new Set(storedChannels.filter(id => !deletedChannelIds.has(id)));
        startupCatchupPending.clear();
        startupCatchupBoundaries.clear();
        for (const channelId of enabledChannels) startupCatchupPending.add(channelId);
        if (enabledChannels.size !== storedChannels.length) {
            runBackground("Could not persist tombstone synchronization", persistEnabledChannels());
        }

        const storedAuto = await DataStore.get<boolean>(AUTO_KEY).catch(() => true);
        autoNewGroups = typeof storedAuto === "boolean" ? storedAuto : true;

        // Baseline current Group DMs so only channels that appear after startup count as "new".
        knownGroupIds = new Set([...currentGroupIds(), ...enabledChannels]);

        // Capture the disk boundary before subscribing to live events. Otherwise a message
        // arriving during startup could become the newest file and hide the offline gap.
        await captureStartupBoundaries();

        // Migrate old v0.1/v0.2 archives into the HTML viewer in the background.
        void Native.prepareViewer().catch(error => console.warn("[LocalGroupArchive] Viewer preparation failed", error));

        FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.subscribe("CHANNEL_UPDATE", onChannelUpdate);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
        FluxDispatcher.subscribe("MESSAGE_REACTION_ADD", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE_ALL", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE_EMOJI", onMessageStateChange);

        autoScanTimer = setInterval(scanForNewGroups, AUTO_SCAN_INTERVAL_MS);
        catchupTimer = setTimeout(() => {
            catchupTimer = null;
            void resumeEnabledArchives();
        }, 2200);
    },

    stop() {
        pluginRunning = false;
        FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.unsubscribe("CHANNEL_UPDATE", onChannelUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.unsubscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.unsubscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
        FluxDispatcher.unsubscribe("MESSAGE_REACTION_ADD", onMessageStateChange);
        FluxDispatcher.unsubscribe("MESSAGE_REACTION_REMOVE", onMessageStateChange);
        FluxDispatcher.unsubscribe("MESSAGE_REACTION_REMOVE_ALL", onMessageStateChange);
        FluxDispatcher.unsubscribe("MESSAGE_REACTION_REMOVE_EMOJI", onMessageStateChange);

        if (autoScanTimer) clearInterval(autoScanTimer);
        autoScanTimer = null;
        if (catchupTimer) clearTimeout(catchupTimer);
        catchupTimer = null;
        for (const channelId of enabledChannels) cancelHistory(channelId);
        startupCatchupPending.clear();
        startupCatchupBoundaries.clear();
        cancelQueuedAttachments();
        runBackground("Could not cancel downloads during shutdown", Native.cancelAllDownloads());
        runBackground("Could not close the local viewer API", Native.shutdownViewerApi());
    }
});
