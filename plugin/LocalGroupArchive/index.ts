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
    Clickable,
    Constants,
    FluxDispatcher,
    MessageStore,
    React,
    RestAPI,
    UserStore
} from "@webpack/common";

import {
    buildHistorySegments,
    buildHybridHistorySegments,
    type HistorySegment,
    type HybridHistoryPlane as HybridPlane,
    newestPageId,
    oldestPageId,
    segmentBoundaryReached,
    selectPageForSegment } from "./historyPlanner";

const Native = VencordNative.pluginHelpers.LocalGroupArchive as PluginNative<typeof import("./native")>;

const STORE_KEY = "LocalGroupArchive_enabledChannels";
const AUTO_KEY = "LocalGroupArchive_autoNewGroups";
const BASELINE_KEY = "LocalGroupArchive_v070BaselineGroupIds";
const BASELINE_CUTOFF_KEY = "LocalGroupArchive_v072NewGroupCutoffMs";
const PLUGIN_VERSION = "0.9.2";
const GROUP_DM_TYPE = 3;
const HISTORY_PAGE_SIZE = 100;
const MAX_HISTORY_PAGES = 5000;
const ATTACHMENT_CONCURRENCY = 64;
const NORMAL_ATTACHMENT_CONCURRENCY = 24;
const AUTO_SCAN_INTERVAL_MS = 1000;
const DELETED_SYNC_INTERVAL_MS = 5000;
const ATTACHMENT_RETRIES = 3;
const MAX_RENDERER_BATCH_MESSAGES = 250;
const MAX_RENDERER_BATCH_BYTES = 20 * 1024 * 1024;
const DISCORD_EPOCH_MS = 1420070400000n;
const SNOWFLAKE_LOW_BITS = (1n << 22n) - 1n;
const HISTORY_ANCHOR_TAB_NAMES = ["messages", "links", "media", "files", "pins"] as const;
const HISTORY_ANCHOR_PROBE_OFFSETS = [
    [750, 1500, 2250, 3000, 3750],
    [4500, 5250, 6000, 6750, 7500],
    [8250, 8750, 9250, 9750, 9975]
] as const;
const HISTORY_TAIL_ANCHOR_OFFSETS = [500, 1000, 1500, 2000, 2500] as const;
const HISTORY_ANCHORED_CONCURRENCY = 12;
const HISTORY_RECOVERY_CONCURRENCY = 2;
const SEARCH_SWEEP_CONCURRENCY = 8;
const SEARCH_SWEEP_TAB_LIMIT = 25;
const SEARCH_SWEEP_WINDOW = 10_000;
const SEARCH_SWEEP_PROGRESS_MS = 2_000;
const SEARCH_SWEEP_SHORT_RETRIES = 2;
const PANIC_BURST_MS = 5_000;
const PANIC_SEARCH_WORKERS_PER_ROUTE = 2;
const HYBRID_NORMAL_INITIAL_CONCURRENCY = 6;
const HYBRID_NORMAL_MIN_CONCURRENCY = 2;
const HYBRID_NORMAL_MAX_CONCURRENCY = 6;
const HYBRID_FAST_REQUEST_MS = 1_100;
const HYBRID_SLOW_REQUEST_MS = 1_800;
const HYBRID_BACKOFF_COOLDOWN_MS = 2_000;
const HYBRID_PROGRESS_MS = 5_000;
const WARM_MIRROR_RECONCILE_MS = 45_000;
const BASELINE_POLL_MS = 400;
const BASELINE_STABLE_ROUNDS = 3;
const BASELINE_MAX_ROUNDS = 25;

let enabledChannels = new Set<string>();
let baselineGroupIds = new Set<string>();
let knownGroupIds = new Set<string>();
const pendingNewDuringBaseline = new Set<string>();
let baselineReady = false;
let baselineCutoffMs = 0;
let autoNewGroups = true;
let autoScanTimer: ReturnType<typeof setInterval> | null = null;
let pluginRunning = false;
let lastDeletedSync = 0;
let deletedSyncRunning = false;
let persistChain: Promise<void> = Promise.resolve();
let ghostListInstance: any = null;
let archivedMetadata = new Map<string, any>();
let pluginStartedAt = 0;
let lastCurrentGroupSignature = "";
let connectionOpenSeen = false;

const historyJobs = new Map<string, Promise<HistoryResult>>();
const catchupJobs = new Map<string, Promise<HistoryResult>>();
const olderBackfillJobs = new Map<string, Promise<HistoryResult>>();
const historyGenerations = new Map<string, number>();
const olderBackfillGenerations = new Map<string, number>();
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
    elapsedMs?: number;
    strategy?: "hybrid" | "search-sweep" | "anchored" | "cursor";
    anchorQueries?: number;
    anchors?: number;
    peakLanes?: number;
    averageRequestMs?: number;
    searchRequests?: number;
    searchTabs?: number;
    expectedMessages?: number;
    fastComplete?: boolean;
    globalSearchRequests?: number;
    repairedSegments?: number;
    resumedSegments?: number;
    panicMessages?: number;
    stolenSegments?: number;
}

function mergeHistoryResults(...results: HistoryResult[]): HistoryResult {
    return results.reduce<HistoryResult>((merged, result) => ({
        messages: merged.messages + result.messages,
        saved: merged.saved + result.saved,
        pages: merged.pages + result.pages,
        attachmentsQueued: merged.attachmentsQueued + result.attachmentsQueued,
        writeFailures: merged.writeFailures + result.writeFailures,
        reachedLimit: Boolean(merged.reachedLimit || result.reachedLimit),
        cancelled: Boolean(merged.cancelled || result.cancelled),
        partialError: merged.partialError ?? result.partialError,
        elapsedMs: Math.max(merged.elapsedMs ?? 0, result.elapsedMs ?? 0),
        strategy: merged.strategy === "hybrid" || result.strategy === "hybrid"
            ? "hybrid"
            : merged.strategy === "search-sweep" || result.strategy === "search-sweep"
                ? "search-sweep"
                : merged.strategy === "anchored" || result.strategy === "anchored"
                    ? "anchored"
                    : (merged.strategy ?? result.strategy),
        anchorQueries: (merged.anchorQueries ?? 0) + (result.anchorQueries ?? 0),
        anchors: Math.max(merged.anchors ?? 0, result.anchors ?? 0),
        peakLanes: Math.max(merged.peakLanes ?? 0, result.peakLanes ?? 0),
        averageRequestMs: Math.max(merged.averageRequestMs ?? 0, result.averageRequestMs ?? 0),
        searchRequests: (merged.searchRequests ?? 0) + (result.searchRequests ?? 0),
        searchTabs: (merged.searchTabs ?? 0) + (result.searchTabs ?? 0),
        expectedMessages: Math.max(merged.expectedMessages ?? 0, result.expectedMessages ?? 0),
        fastComplete: Boolean(merged.fastComplete || result.fastComplete),
        globalSearchRequests: (merged.globalSearchRequests ?? 0) + (result.globalSearchRequests ?? 0),
        repairedSegments: (merged.repairedSegments ?? 0) + (result.repairedSegments ?? 0),
        resumedSegments: (merged.resumedSegments ?? 0) + (result.resumedSegments ?? 0),
        panicMessages: Math.max(merged.panicMessages ?? 0, result.panicMessages ?? 0),
        stolenSegments: (merged.stolenSegments ?? 0) + (result.stolenSegments ?? 0)
    }), { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0 });
}

interface AttachmentJob {
    key: string;
    channelId: string;
    priority: "voice" | "normal";
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
let attachmentPumpHolds = 0;
const attachmentIdleWaiters = new Set<() => void>();
const attachmentJobs = new Map<string, Promise<AttachmentOutcome>>();
let attachmentCompleted = 0;
let attachmentFailed = 0;
let catchupTimer: ReturnType<typeof setTimeout> | null = null;
let warmMirrorTimer: ReturnType<typeof setInterval> | null = null;
let warmMirrorCursor = 0;
let warmMirrorReconcileRunning = false;
let criticalAttachmentPumpHolds = 0;

function isGroupDm(channelId: string) {
    return ChannelStore.getChannel(channelId)?.type === GROUP_DM_TYPE;
}

function currentGroupIds() {
    const channels = ChannelStore.getMutablePrivateChannels?.() ?? {};
    return Object.values(channels)
        .filter((channel: any) => channel?.type === GROUP_DM_TYPE && channel?.id)
        .map((channel: any) => String(channel.id));
}

function currentPrivateChannelSnapshot() {
    const channels = ChannelStore.getMutablePrivateChannels?.() ?? {};
    const values = Object.values(channels).filter((channel: any) => channel?.id);
    const groupIds = values
        .filter((channel: any) => channel?.type === GROUP_DM_TYPE)
        .map((channel: any) => String(channel.id))
        .sort(snowflakeCompare);
    return { groupIds, totalPrivateChannels: values.length };
}

function snowflakeFromTimestamp(timestampMs: number, ceiling = false) {
    const safe = Math.max(Number(DISCORD_EPOCH_MS), Math.floor(timestampMs));
    let snowflake = (BigInt(safe) - DISCORD_EPOCH_MS) << 22n;
    if (ceiling) snowflake |= SNOWFLAKE_LOW_BITS;
    return snowflake.toString();
}

function snowflakeTimestamp(value: string) {
    try {
        return Number((BigInt(value) >> 22n) + DISCORD_EPOCH_MS);
    } catch {
        return Date.now();
    }
}

function wasCreatedBeforeNewGroupCutoff(channelId: string) {
    return baselineCutoffMs > 0 && snowflakeTimestamp(channelId) < baselineCutoffMs;
}

function isAutoProtectEligibleNewGroup(channelId: string) {
    return baselineCutoffMs > 0 && snowflakeTimestamp(channelId) >= baselineCutoffMs;
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

function persistBaseline() {
    const snapshot = [...baselineGroupIds];
    return queuePersistence(() => DataStore.set(BASELINE_KEY, snapshot));
}

function persistBaselineCutoff() {
    const snapshot = baselineCutoffMs;
    return queuePersistence(() => DataStore.set(BASELINE_CUTOFF_KEY, snapshot));
}

function notifyAttachmentIdleIfNeeded() {
    if (activeAttachmentJobs !== 0 || attachmentQueue.length !== 0) return;
    for (const resolve of attachmentIdleWaiters) resolve();
    attachmentIdleWaiters.clear();
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
            lastError = formatArchiveError(error);
            if (attempt < ATTACHMENT_RETRIES) await wait(350 * 2 ** (attempt - 1));
        }
    }

    return { ok: false, error: lastError };
}

function holdAttachmentPump() {
    attachmentPumpHolds++;
}

function releaseAttachmentPump() {
    attachmentPumpHolds = Math.max(0, attachmentPumpHolds - 1);
    if (attachmentPumpHolds === 0 && criticalAttachmentPumpHolds === 0) pumpAttachmentQueue();
}

function holdCriticalAttachmentPump() {
    criticalAttachmentPumpHolds++;
}

function releaseCriticalAttachmentPump() {
    criticalAttachmentPumpHolds = Math.max(0, criticalAttachmentPumpHolds - 1);
    if (criticalAttachmentPumpHolds === 0) pumpAttachmentQueue();
}

function pumpAttachmentQueue() {
    // A cold bootstrap has only a few seconds to preserve Discord message objects and signed CDN
    // URLs. Starting even voice downloads here competes with the REST routes, so v0.9.1 queues every
    // asset but keeps all CDN traffic frozen until the text plane has stopped.
    if (criticalAttachmentPumpHolds > 0) return;
    while (activeAttachmentJobs < ATTACHMENT_CONCURRENCY && attachmentQueue.length > 0) {
        // Voice messages are rescue-critical. They always jump ahead of every other media job
        // and are allowed to run even while Full History is holding the normal media pump.
        const voiceIndex = attachmentQueue.findIndex(job => job.priority === "voice");
        // Keep a large slice of the worker pool permanently available for rescue voice jobs and
        // leave network headroom for Discord history REST. Normal images/video never occupy all
        // 64 slots by themselves.
        const jobIndex = voiceIndex >= 0
            ? voiceIndex
            : attachmentPumpHolds > 0 || activeAttachmentJobs >= NORMAL_ATTACHMENT_CONCURRENCY ? -1 : 0;
        if (jobIndex < 0) return;

        const [job] = attachmentQueue.splice(jobIndex, 1);
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

function enqueueAttachment(
    key: string,
    channelId: string,
    run: () => Promise<unknown>,
    priority: "voice" | "normal" = "normal"
) {
    const existing = attachmentJobs.get(key);
    if (existing) return { promise: existing, queued: false };

    const promise = new Promise<AttachmentOutcome>(resolve => {
        attachmentQueue.push({ key, channelId, priority, run, resolve });
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

function isPriorityVoiceAttachment(attachment: any) {
    const contentType = String(attachment?.contentType ?? attachment?.content_type ?? "").toLowerCase();
    const duration = Number(attachment?.durationSecs ?? attachment?.duration_secs ?? 0);
    return contentType.startsWith("audio/")
        || Boolean(attachment?.waveform)
        || (Number.isFinite(duration) && duration > 0);
}

function queueAttachmentRecord(channelId: string, messageId: string, attachment: any, priority: "voice" | "normal") {
    const url = attachment?.url ?? attachment?.proxyUrl ?? attachment?.proxy_url ?? attachment?.proxyURL;
    if (!url || !attachment?.id || !attachment?.filename) return false;

    const attachmentId = String(attachment.id);
    const filename = String(attachment.filename);
    return enqueueAttachment(
        `attachment:${channelId}:${messageId}:${attachmentId}`,
        channelId,
        () => Native.downloadAttachment(
            channelId,
            messageId,
            attachmentId,
            String(url),
            filename,
            Number(attachment.size ?? 0)
        ),
        priority
    ).queued;
}

function queuePriorityVoiceFromMessages(messages: any[]) {
    let queued = 0;
    for (const message of messages) {
        const channelId = String(message?.channel_id ?? message?.channelId ?? "");
        const messageId = String(message?.id ?? "");
        if (!channelId || !messageId) continue;

        for (const attachment of message.attachments ?? []) {
            if (!isPriorityVoiceAttachment(attachment)) continue;
            if (queueAttachmentRecord(channelId, messageId, attachment, "voice")) queued++;
        }
    }
    return queued;
}

function queueAttachmentsFromRecords(records: any[], skipPriorityVoice = false) {
    let queued = 0;

    // Queue exclusively from the archived records. Their signed CDN URLs are captured at
    // message-read time, so losing the Group DM afterwards does not require another Discord
    // message lookup before the download can start.
    for (const record of records) {
        const channelId = String(record?.channelId ?? "");
        const messageId = String(record?.id ?? "");
        if (!channelId || !messageId) continue;

        queued += queueMessageAssets(record);

        for (const attachment of record.attachments ?? []) {
            const isVoice = isPriorityVoiceAttachment(attachment);
            if (skipPriorityVoice && isVoice) continue;
            if (queueAttachmentRecord(channelId, messageId, attachment, isVoice ? "voice" : "normal")) queued++;
        }
    }

    return queued;
}

function ensureChannel(channelId: string, force = false, deferNormalAssets = false): Promise<boolean> {
    const existing = ensureJobs.get(channelId);
    if (existing) {
        if (!force) return existing;
        return existing.catch(() => false).then(() => {
            ensuredChannels.delete(channelId);
            return ensureChannel(channelId, false, deferNormalAssets);
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
            archivedMetadata.set(channelId, meta);
            if (!deferNormalAssets) queueChannelAssets(channelId, meta);
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
    captureSource: "live" | "history" | "snapshot" = "live",
    deferMedia: ((messages: any[], records: any[]) => void) | null = null,
    deferViewer = false
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
            result = await Native.saveMessagesBatch(channelId, JSON.stringify(chunk.map(entry => entry.record)), !deferViewer);
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
        const persistedMessages = persisted.map(entry => entry.message);
        const persistedRecords = persisted.map(entry => entry.record);
        if (deferMedia) deferMedia(persistedMessages, persistedRecords);
        else attachmentsQueued += queueAttachmentsFromRecords(persistedRecords);
    }
    return { saved, attachmentsQueued };
}

async function saveSingleMessage(message: any): Promise<BatchOutcome> {
    const channelId = String(message?.channel_id ?? message?.channelId ?? "");
    if (!baselineReady || !channelId || !enabledChannels.has(channelId) || !isGroupDm(channelId)) {
        return { saved: 0, attachmentsQueued: 0 };
    }

    await ensureChannel(channelId);
    return saveMessageBatch(channelId, [message], "live");
}

async function snapshotLoaded(channelId: string, rescueMode = false) {
    const messages: any = MessageStore.getMessages(channelId);
    if (!messages) return { count: 0, saved: 0, attachmentsQueued: 0 };

    const pending: any[] = [];
    messages.forEach((message: any) => pending.push(message));

    if (pending.length === 0) return { count: 0, saved: 0, attachmentsQueued: 0 };
    if (!rescueMode) {
        const result = await saveMessageBatch(channelId, pending, "snapshot");
        return { count: pending.length, saved: result.saved, attachmentsQueued: result.attachmentsQueued };
    }

    // Emergency snapshot: commit every loaded message object first. All media URLs are retained in
    // the records, but downloads are queued only after this tiny durable write finishes so a cold
    // bootstrap can own the network during its critical window.
    const stagedRecords: any[] = [];
    let attachmentsQueued = 0;
    holdAttachmentPump();
    try {
        const result = await saveMessageBatch(
            channelId,
            pending,
            "snapshot",
            (_persistedMessages, records) => stagedRecords.push(...records),
            true
        );
        attachmentsQueued += queueAttachmentsFromRecords(stagedRecords);
        return { count: pending.length, saved: result.saved, attachmentsQueued };
    } finally {
        releaseAttachmentPump();
    }
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
    olderBackfillGenerations.set(channelId, (olderBackfillGenerations.get(channelId) ?? 0) + 1);
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


interface DeferredCaptureWrite {
    promise: Promise<{ saved: number; error?: string; }>;
}

type HybridSearchRoute = "channel" | "global-dm";

function scheduleCaptureWrite(channelId: string, messages: any[], stagedRecords: any[]): DeferredCaptureWrite | null {
    const records = messages
        .filter(message => message?.id && String(message?.channel_id ?? message?.channelId) === channelId)
        .map(message => buildMessageRecord(message, "history"));
    if (!records.length) return null;

    // Keep network waves moving. The native side serializes appendFile operations per channel, so
    // these IPC writes can safely queue behind one another while the next REST wave is already in flight.
    stagedRecords.push(...records);
    const recordsJson = JSON.stringify(records);
    const promise = Native.appendCaptureBatch(channelId, recordsJson)
        .then(result => {
            if (result?.deleted) {
                handleArchiveDeleted(channelId);
                return { saved: 0, error: "Archive was deleted while capture was running" };
            }
            return { saved: Number(result?.saved ?? records.length) };
        })
        .catch((error: any) => ({ saved: 0, error: formatArchiveError(error) }));
    return { promise };
}

function formatArchiveError(error: any) {
    if (typeof error === "string") return error;
    const message = error?.message ?? error?.body?.message ?? error?.statusText;
    if (typeof message === "string" && message) return message;
    try {
        const serialized = JSON.stringify(error?.body ?? error);
        if (serialized && serialized !== "{}") return serialized;
    } catch { }
    return String(error);
}

async function runAnchorProbe(
    channelId: string,
    generation: number,
    maxId: string | undefined,
    offsets: readonly number[],
    route: HybridSearchRoute = "channel"
) {
    if (!pluginRunning || !enabledChannels.has(channelId)
        || historyGenerations.get(channelId) !== generation || !isGroupDm(channelId)) {
        return { messages: [] as any[], attempted: false, available: false, route };
    }

    const tabs: Record<string, any> = {};
    for (let index = 0; index < HISTORY_ANCHOR_TAB_NAMES.length; index++) {
        const offset = offsets[index];
        if (offset == null) break;
        tabs[HISTORY_ANCHOR_TAB_NAMES[index]] = {
            limit: 1,
            offset,
            sort_by: "timestamp",
            sort_order: "desc",
            ...(maxId ? { max_id: maxId } : {})
        };
    }

    try {
        const response: any = await RestAPI.post({
            url: route === "global-dm"
                ? "/users/@me/messages/search/tabs"
                : `/channels/${channelId}/messages/search/tabs`,
            body: {
                tabs,
                track_exact_total_hits: false,
                ...(route === "global-dm" ? { channel_ids: [channelId] } : {})
            },
            retries: 1
        });
        const body = response?.body ?? {};
        if (response?.status === 202 || Number(body?.code) === 110000 || !body?.tabs) {
            return { messages: [] as any[], attempted: true, available: false, route };
        }

        const found: any[] = [];
        for (const name of HISTORY_ANCHOR_TAB_NAMES) {
            const groups = body.tabs?.[name]?.messages;
            if (!Array.isArray(groups)) continue;
            for (const group of groups) {
                if (Array.isArray(group)) {
                    const hit = group.find((message: any) => message?.id && message?.hit !== false);
                    if (hit) { found.push(hit); break; }
                } else if (group?.id) {
                    found.push(group);
                    break;
                }
            }
        }
        return { messages: found, attempted: true, available: true, route };
    } catch (error) {
        console.debug("[LocalGroupArchive] Search anchor probe unavailable", formatArchiveError(error));
        return { messages: [] as any[], attempted: true, available: false, route };
    }
}

async function discoverHistoryAnchors(channelId: string, generation: number, startBefore?: string) {
    const anchorMessages = new Map<string, any>();
    let queries = 0;

    const probeRoutes: HybridSearchRoute[] = ["channel", "global-dm", "channel"];
    const probes = await Promise.all(HISTORY_ANCHOR_PROBE_OFFSETS.map((offsets, index) =>
        runAnchorProbe(channelId, generation, startBefore, offsets, probeRoutes[index] ?? "channel")
    ));
    let channelSearchAvailable = false;
    let globalSearchAvailable = false;
    for (const probe of probes) {
        if (probe.attempted) queries++;
        if (probe.available && probe.route === "channel") channelSearchAvailable = true;
        if (probe.available && probe.route === "global-dm") globalSearchAvailable = true;
        for (const message of probe.messages) {
            const id = String(message?.id ?? "");
            if (id && String(message?.channel_id ?? message?.channelId) === channelId) {
                anchorMessages.set(id, message);
            }
        }
    }

    // Search offsets stop at 9,975. Extend the real-ID ladder in small dependent hops so very
    // large DMs still get balanced ranges rather than one enormous authoritative tail. Ninety-five
    // anchors plus the final range fit comfortably inside the ledger's 128-segment safety cap.
    let tailBefore = [...anchorMessages.keys()].sort(snowflakeCompare)[0];
    for (let round = 0; tailBefore && round < 16 && anchorMessages.size < 95
        && shouldContinueForFullCapture(channelId, generation); round++) {
        const preferred: HybridSearchRoute = channelSearchAvailable && (!globalSearchAvailable || round % 2 === 1)
            ? "channel"
            : "global-dm";
        let tail = await runAnchorProbe(channelId, generation, tailBefore, HISTORY_TAIL_ANCHOR_OFFSETS, preferred);
        if (tail.attempted) queries++;
        if (!tail.available && preferred === "global-dm" && channelSearchAvailable) {
            tail = await runAnchorProbe(channelId, generation, tailBefore, HISTORY_TAIL_ANCHOR_OFFSETS, "channel");
            if (tail.attempted) queries++;
        }
        if (tail.available && tail.route === "channel") channelSearchAvailable = true;
        if (tail.available && tail.route === "global-dm") globalSearchAvailable = true;

        let added = 0;
        for (const message of tail.messages) {
            const id = String(message?.id ?? "");
            if (id && String(message?.channel_id ?? message?.channelId) === channelId && !anchorMessages.has(id)) {
                anchorMessages.set(id, message);
                added++;
            }
        }
        if (!tail.available || added === 0) break;
        const nextOldest = [...tail.messages]
            .map(message => String(message?.id ?? ""))
            .filter(Boolean)
            .sort(snowflakeCompare)[0];
        if (!nextOldest || nextOldest === tailBefore) break;
        tailBefore = nextOldest;
        if (tail.messages.length < HISTORY_TAIL_ANCHOR_OFFSETS.length) break;
    }

    return { messages: [...anchorMessages.values()], queries, channelSearchAvailable, globalSearchAvailable };
}

function shouldContinueForFullCapture(channelId: string, generation: number) {
    return pluginRunning && enabledChannels.has(channelId)
        && historyGenerations.get(channelId) === generation && isGroupDm(channelId);
}

interface SearchSweepTabResult {
    offset: number;
    messages: any[];
    totalResults?: number;
}

interface SearchSweepBatchResult {
    tabs: SearchSweepTabResult[];
    elapsedMs: number;
    backendMs: number;
}

function flattenSearchMessages(groups: any) {
    const out: any[] = [];
    if (!Array.isArray(groups)) return out;
    for (const group of groups) {
        if (Array.isArray(group)) {
            for (const message of group) if (message?.id) out.push(message);
        } else if (group?.id) {
            out.push(group);
        }
    }
    return out;
}

async function fetchSearchSweepBatch(
    channelId: string,
    maxId: string,
    offsets: readonly number[],
    trackExactTotalHits = false
): Promise<SearchSweepBatchResult> {
    const tabs: Record<string, any> = {};
    for (let index = 0; index < Math.min(offsets.length, HISTORY_ANCHOR_TAB_NAMES.length); index++) {
        tabs[HISTORY_ANCHOR_TAB_NAMES[index]] = {
            limit: SEARCH_SWEEP_TAB_LIMIT,
            offset: offsets[index],
            sort_by: "timestamp",
            sort_order: "desc",
            max_id: maxId
        };
    }

    const startedAt = performance.now();
    const response: any = await RestAPI.post({
        url: `/channels/${channelId}/messages/search/tabs`,
        body: { tabs, track_exact_total_hits: trackExactTotalHits },
        retries: 2
    });
    const elapsedMs = performance.now() - startedAt;
    const body = response?.body ?? {};
    if (response?.status === 202 || Number(body?.code) === 110000) {
        throw new Error(`Discord search index is not ready${body?.retry_after != null ? ` (retry after ${body.retry_after}s)` : ""}`);
    }
    if (!body?.tabs) throw new Error("Discord search/tabs returned no tab results");

    let backendMs = 0;
    const results: SearchSweepTabResult[] = [];
    for (let index = 0; index < Math.min(offsets.length, HISTORY_ANCHOR_TAB_NAMES.length); index++) {
        const name = HISTORY_ANCHOR_TAB_NAMES[index];
        const tab = body.tabs?.[name] ?? {};
        const messages = flattenSearchMessages(tab.messages)
            .filter((message: any) => String(message?.channel_id ?? message?.channelId ?? "") === channelId);
        const total = Number(tab.total_results);
        const spent = Number(tab.time_spent_ms);
        if (Number.isFinite(spent)) backendMs = Math.max(backendMs, spent);
        results.push({
            offset: offsets[index],
            messages,
            totalResults: Number.isFinite(total) ? total : undefined
        });
    }
    return { tabs: results, elapsedMs, backendMs };
}

function chunkOffsets(offsets: number[]) {
    const chunks: number[][] = [];
    for (let index = 0; index < offsets.length; index += HISTORY_ANCHOR_TAB_NAMES.length) {
        chunks.push(offsets.slice(index, index + HISTORY_ANCHOR_TAB_NAMES.length));
    }
    return chunks;
}

async function archiveFullHistorySearchSweepInner(channelId: string, generation: number): Promise<HistoryResult> {
    const startedAt = performance.now();
    let attachmentsQueued = 0;
    let saved = 0;
    let writeFailures = 0;
    let partialError: string | undefined;
    let cancelled = false;
    let searchRequests = 0;
    let searchTabs = 0;
    let totalSearchWaitMs = 0;
    let totalBackendMs = 0;
    let restPages = 0;
    let restRequestMs = 0;
    let lastProgressAt = startedAt;
    let expectedMessages = 0;

    holdAttachmentPump();
    try {
        const ready = await ensureChannel(channelId);
        if (!ready) {
            handleArchiveDeleted(channelId);
            return {
                messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0,
                cancelled: true, elapsedMs: performance.now() - startedAt, strategy: "search-sweep", fastComplete: false
            };
        }

        const stagedRecords: any[] = [];
        const captureWrites: DeferredCaptureWrite[] = [];
        const seen = new Set<string>();
        const shouldContinue = () => shouldContinueForFullCapture(channelId, generation);

        const persistUnique = (incoming: any[]) => {
            const unique = incoming.filter(message => {
                const id = String(message?.id ?? "");
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            if (!unique.length) return 0;
            attachmentsQueued += queuePriorityVoiceFromMessages(unique);
            const write = scheduleCaptureWrite(channelId, unique, stagedRecords);
            if (write) captureWrites.push(write);
            return unique.length;
        };

        const countSearchBatch = (batch: SearchSweepBatchResult) => {
            searchRequests++;
            searchTabs += batch.tabs.length;
            totalSearchWaitMs += batch.elapsedMs;
            totalBackendMs += batch.backendMs;
        };

        const maybeProgress = () => {
            const now = performance.now();
            if (now - lastProgressAt < SEARCH_SWEEP_PROGRESS_MS) return;
            lastProgressAt = now;
            const average = searchRequests ? totalSearchWaitMs / searchRequests : 0;
            const backend = searchRequests ? totalBackendMs / searchRequests : 0;
            sendBotMessage(channelId, {
                content: `🚀 **Search Sweep:** ${seen.size.toLocaleString()}${expectedMessages ? ` / ${expectedMessages.toLocaleString()}` : ""} message(s) durable/queued, ${restPages} normal edge page(s) + ${searchRequests} search HTTP request(s) / ${searchTabs} server tab(s), ${((now - startedAt) / 1000).toFixed(1)}s elapsed${average ? `, avg search ${(average / 1000).toFixed(2)}s` : ""}${backend ? `, Discord search ${(backend / 1000).toFixed(2)}s` : ""}.`
            });
        };

        // Keep exactly one authoritative /messages request on the critical path. It freezes the
        // newest edge, retains reactions for the hot 100 messages, and gives Search Sweep a stable
        // exclusive max_id. v0.7.x proved that multiplying /messages lanes only amplified the
        // channel-scoped rate-limit queue, so the cold-history data plane below this point is search.
        const firstStarted = performance.now();
        const firstPage: any[] = await fetchHistoryPage(channelId);
        restRequestMs += performance.now() - firstStarted;
        restPages++;
        persistUnique(firstPage);
        const firstOldest = oldestPageId(firstPage, message => String(message?.id ?? ""));

        if (firstPage.length < HISTORY_PAGE_SIZE || !firstOldest) {
            expectedMessages = seen.size;
            const writeResults = await Promise.all(captureWrites.map(write => write.promise));
            for (const result of writeResults) {
                saved += result.saved;
                if (result.error) { writeFailures++; partialError ??= result.error; }
            }
            if (!partialError && shouldContinue()) await Native.markHistoryComplete(channelId).catch(() => { });
            if (shouldContinue()) {
                attachmentsQueued += queueAttachmentsFromRecords(stagedRecords, true);
                queueChannelAssets(channelId, buildChannelMeta(channelId));
                runBackground("Could not compact capture packs", Native.compactCapturePacks(channelId));
                runBackground("Could not refresh archived metadata", refreshArchivedMetadata());
            }
            return {
                messages: seen.size, saved, pages: restPages, attachmentsQueued, writeFailures,
                partialError, cancelled, elapsedMs: performance.now() - startedAt,
                strategy: "search-sweep", averageRequestMs: restRequestMs / Math.max(1, restPages),
                searchRequests: 0, searchTabs: 0, expectedMessages, fastComplete: !partialError
            };
        }

        // Search Channel Messages by Tab lets the Discord client ask five parallel search tabs in
        // one HTTP request. Each tab returns up to 25 messages. We deliberately use all five tab
        // names with the same unfiltered timestamp query at offsets 0/25/50/75/100, turning one
        // client request into as many as 125 historical message objects. This is the only primary
        // history plane after the newest /messages edge page. RestAPI remains in charge of Discord's
        // rate-limit headers; there is no raw-token fetch or 429 bypass here.
        let tailMaxId = firstOldest;
        let firstWindow = true;
        let previousWindowBoundary: string | undefined;

        while (shouldContinue()) {
            const firstOffsets = [0, 25, 50, 75, 100];
            let exactBatch: SearchSweepBatchResult;
            try {
                exactBatch = await fetchSearchSweepBatch(channelId, tailMaxId, firstOffsets, true);
            } catch (error: any) {
                partialError ??= `Search Sweep unavailable: ${formatArchiveError(error)}`;
                break;
            }
            countSearchBatch(exactBatch);

            const totals = exactBatch.tabs
                .map(tab => tab.totalResults)
                .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
            if (!totals.length) {
                partialError ??= "Search Sweep returned no exact result count.";
                break;
            }

            const windowTotal = Math.max(...totals);
            if (firstWindow) {
                // max_id is exclusive, so the exact result count is exactly the history older than
                // the oldest message in firstPage. That makes this a strong completion invariant.
                expectedMessages = firstPage.length + windowTotal;
                firstWindow = false;
            }
            if (windowTotal <= 0) break;

            const windowTarget = Math.min(windowTotal, SEARCH_SWEEP_WINDOW);
            const windowIds = new Set<string>();
            const shortOffsets = new Set<number>();

            const consumeTab = (tab: SearchSweepTabResult) => {
                const expectedAtOffset = Math.max(0, Math.min(SEARCH_SWEEP_TAB_LIMIT, windowTarget - tab.offset));
                const ids = new Set<string>();
                for (const message of tab.messages) {
                    const id = String(message?.id ?? "");
                    if (!id) continue;
                    ids.add(id);
                    windowIds.add(id);
                }
                persistUnique(tab.messages);
                if (expectedAtOffset > 0 && ids.size < expectedAtOffset) shortOffsets.add(tab.offset);
                else shortOffsets.delete(tab.offset);
            };

            for (const tab of exactBatch.tabs) consumeTab(tab);

            const remainingOffsets: number[] = [];
            for (let offset = 125; offset < windowTarget; offset += SEARCH_SWEEP_TAB_LIMIT) remainingOffsets.push(offset);
            const tasks = chunkOffsets(remainingOffsets);
            let nextTask = 0;
            const worker = async () => {
                while (shouldContinue()) {
                    const offsets = tasks[nextTask++];
                    if (!offsets) return;
                    try {
                        const batch = await fetchSearchSweepBatch(channelId, tailMaxId, offsets, false);
                        countSearchBatch(batch);
                        for (const tab of batch.tabs) consumeTab(tab);
                    } catch (error: any) {
                        for (const offset of offsets) shortOffsets.add(offset);
                        console.debug("[LocalGroupArchive] Search Sweep batch failed", formatArchiveError(error));
                    }
                    maybeProgress();
                }
            };
            await Promise.all(Array.from({ length: Math.min(SEARCH_SWEEP_CONCURRENCY, Math.max(1, tasks.length)) }, () => worker()));

            // Discord documents that historical search slices can occasionally be short. Retry only
            // those exact 25-result offsets. If they remain short, exact-count validation below will
            // force an authoritative repair instead of silently accepting a hole.
            for (let retry = 0; retry < SEARCH_SWEEP_SHORT_RETRIES && shortOffsets.size && shouldContinue(); retry++) {
                const retryChunks = chunkOffsets([...shortOffsets].sort((a, b) => a - b));
                let nextRetry = 0;
                const retryWorker = async () => {
                    while (shouldContinue()) {
                        const offsets = retryChunks[nextRetry++];
                        if (!offsets) return;
                        try {
                            const batch = await fetchSearchSweepBatch(channelId, tailMaxId, offsets, false);
                            countSearchBatch(batch);
                            for (const tab of batch.tabs) consumeTab(tab);
                        } catch { }
                        maybeProgress();
                    }
                };
                await Promise.all(Array.from({ length: Math.min(4, Math.max(1, retryChunks.length)) }, () => retryWorker()));
            }

            if (windowTotal <= SEARCH_SWEEP_WINDOW) break;

            let boundary: string | undefined;
            for (const id of windowIds) if (!boundary || BigInt(id) < BigInt(boundary)) boundary = id;
            if (!boundary || boundary === previousWindowBoundary) {
                partialError ??= "Search Sweep could not advance its 10,000-result window boundary.";
                break;
            }
            previousWindowBoundary = boundary;
            tailMaxId = boundary;
            maybeProgress();
        }

        if (!shouldContinue()) cancelled = true;

        const writeResults = await Promise.all(captureWrites.map(write => write.promise));
        for (const result of writeResults) {
            saved += result.saved;
            if (result.error) {
                writeFailures++;
                partialError ??= result.error;
            }
        }

        const exactComplete = Boolean(expectedMessages) && seen.size === expectedMessages;
        if (!exactComplete && !partialError && expectedMessages) {
            partialError = `Search Sweep returned ${seen.size.toLocaleString()} / ${expectedMessages.toLocaleString()} exact-count message(s); authoritative repair is required.`;
        }

        if (shouldContinue()) {
            // Never unleash normal image/video/embed traffic before a fast phase is proven complete.
            // If Search Sweep needs authoritative repair, the repair phase will stage the complete
            // media set after its history requests finish. Voice downloads were already allowed.
            if (exactComplete && !partialError && !cancelled) {
                attachmentsQueued += queueAttachmentsFromRecords(stagedRecords, true);
                queueChannelAssets(channelId, buildChannelMeta(channelId));
                await Native.markHistoryComplete(channelId).catch(error => {
                    partialError ??= `History-complete marker: ${formatArchiveError(error)}`;
                });
            }
            runBackground("Could not compact capture packs", Native.compactCapturePacks(channelId));
            runBackground("Could not refresh archived metadata", refreshArchivedMetadata());
        }

        const averageSearchMs = searchRequests ? totalSearchWaitMs / searchRequests : 0;
        console.info(`[LocalGroupArchive] Search Sweep captured ${seen.size}/${expectedMessages || "?"}: ${restPages} /messages edge + ${searchRequests} search/tabs HTTP (${searchTabs} tabs).`);
        return {
            messages: seen.size,
            saved,
            pages: restPages,
            attachmentsQueued,
            writeFailures,
            cancelled,
            partialError,
            elapsedMs: performance.now() - startedAt,
            strategy: "search-sweep",
            peakLanes: SEARCH_SWEEP_CONCURRENCY,
            averageRequestMs: averageSearchMs,
            searchRequests,
            searchTabs,
            expectedMessages,
            fastComplete: exactComplete && !partialError && !cancelled
        };
    } finally {
        releaseAttachmentPump();
    }
}

async function archiveFullHistoryAnchoredInner(channelId: string, generation: number): Promise<HistoryResult> {
    const startedAt = performance.now();
    let attachmentsQueued = 0;
    let partialError: string | undefined;
    let cancelled = false;
    let reachedLimit = false;
    let reachedBeginning = false;
    let pages = 0;
    let issuedRequests = 0;
    let messages = 0;
    let saved = 0;
    let writeFailures = 0;
    let lastProgressAt = startedAt;
    let totalRequestMs = 0;
    let requestSamples = 0;
    let peakLanes = 1;

    // Voice downloads may run during capture, but normal image/video/embed work stays frozen until
    // every history request has stopped. Returned text pages are appended to crash-safe NDJSON
    // packs immediately and compacted later.
    holdAttachmentPump();
    try {
        const ready = await ensureChannel(channelId);
        if (!ready) {
            handleArchiveDeleted(channelId);
            return { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0, cancelled: true, elapsedMs: performance.now() - startedAt, strategy: "cursor" };
        }

        const stagedRecords: any[] = [];
        const captureWrites: DeferredCaptureWrite[] = [];
        const seen = new Set<string>();
        const failedCursors: Array<{ segment: HistorySegment; before?: string; error: string; }> = [];

        // Always take the newest authoritative page first. Tiny groups finish here without paying
        // for search at all, and large groups immediately get their newest 100 messages onto disk.
        let firstPage: any[] = [];
        let firstOldest: string | undefined;
        if (issuedRequests < MAX_HISTORY_PAGES) {
            issuedRequests++;
            const firstRequestStarted = performance.now();
            try {
                firstPage = await fetchHistoryPage(channelId);
            } catch (error: any) {
                partialError ??= formatArchiveError(error);
            } finally {
                totalRequestMs += performance.now() - firstRequestStarted;
                requestSamples++;
            }
            pages++;
        }

        if (firstPage.length) {
            const uniqueFirst = firstPage.filter(message => {
                const id = String(message?.id ?? "");
                if (!id || seen.has(id)) return false;
                seen.add(id);
                return true;
            });
            messages += uniqueFirst.length;
            attachmentsQueued += queuePriorityVoiceFromMessages(uniqueFirst);
            const write = scheduleCaptureWrite(channelId, uniqueFirst, stagedRecords);
            if (write) captureWrites.push(write);
            firstOldest = oldestPageId(firstPage, message => String(message?.id ?? ""));
        }

        let anchorProbe = { messages: [] as any[], queries: 0 };
        let anchorIds: string[] = [];
        let segments: HistorySegment[] = [];
        let strategy: "anchored" | "cursor" = "cursor";
        let workerCount = 1;
        let nextSegment = 0;
        let lastUnboundedSegmentCompleted = firstPage.length < HISTORY_PAGE_SIZE;

        if (firstPage.length >= HISTORY_PAGE_SIZE && firstOldest && !partialError && shouldContinueForFullCapture(channelId, generation)) {
            // One or two optional search/tabs probes give us real message-ID anchors BELOW the
            // newest page. This is fundamentally different from v0.7.0's speculative timestamp
            // sharding: authoritative lanes cannot overlap, so request count stays near the floor.
            // Search never decides completeness. If it is indexing/unavailable, anchorIds stays
            // empty and this becomes a normal single-cursor walk starting at firstOldest.
            anchorProbe = await discoverHistoryAnchors(channelId, generation, firstOldest);
            const anchorMessages = anchorProbe.messages
                .filter(message => message?.id && String(message?.channel_id ?? message?.channelId) === channelId);
            anchorIds = anchorMessages.map(message => String(message.id));

            if (anchorMessages.length) {
                const uniqueAnchors = anchorMessages.filter(message => {
                    const id = String(message.id);
                    if (seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });
                messages += uniqueAnchors.length;
                attachmentsQueued += queuePriorityVoiceFromMessages(uniqueAnchors);
                const write = scheduleCaptureWrite(channelId, uniqueAnchors, stagedRecords);
                if (write) captureWrites.push(write);
            }

            segments = buildHistorySegments(anchorIds);
            segments[0].upperExclusive = firstOldest;
            strategy = anchorIds.length ? "anchored" : "cursor";
            workerCount = strategy === "anchored"
                ? Math.min(HISTORY_ANCHORED_CONCURRENCY, segments.length)
                : 1;
            peakLanes = workerCount;
        }

        const shouldContinue = () => shouldContinueForFullCapture(channelId, generation);

        const maybeProgress = () => {
            const now = performance.now();
            if (now - lastProgressAt < 10_000) return;
            lastProgressAt = now;
            const avg = requestSamples ? totalRequestMs / requestSamples : 0;
            sendBotMessage(channelId, {
                content: `⏱️ **Full capture progress:** ${messages.toLocaleString()} unique message(s), ${pages} completed history page(s), ${anchorProbe.queries} anchor probe(s), ${workerCount} lane(s), ${((now - startedAt) / 1000).toFixed(1)}s elapsed${avg ? `, avg REST wait ${(avg / 1000).toFixed(2)}s` : ""}.`
            });
        };

        const scanSegment = async (
            segment: HistorySegment,
            startBefore = segment.upperExclusive,
            allowRecovery = true
        ) => {
            let before = startBefore;
            let previousOldest: string | undefined;

            while (true) {
                if (!shouldContinue()) { cancelled = true; return; }
                if (issuedRequests >= MAX_HISTORY_PAGES) { reachedLimit = true; return; }
                issuedRequests++;

                let page: any[];
                const requestStarted = performance.now();
                try {
                    page = await fetchHistoryPage(channelId, before);
                } catch (error: any) {
                    const text = formatArchiveError(error);
                    if (allowRecovery) failedCursors.push({ segment, before, error: text });
                    else partialError ??= `History request failed after recovery retry: ${text}`;
                    return;
                } finally {
                    const elapsed = performance.now() - requestStarted;
                    totalRequestMs += elapsed;
                    requestSamples++;
                }
                pages++;

                if (!page.length) {
                    if (!segment.lowerExclusive) lastUnboundedSegmentCompleted = true;
                    return;
                }

                const inSegment = selectPageForSegment(page, segment, message => String(message?.id ?? ""));
                const unique = inSegment.filter(message => {
                    const id = String(message?.id ?? "");
                    if (!id || seen.has(id)) return false;
                    seen.add(id);
                    return true;
                });

                if (unique.length) {
                    messages += unique.length;
                    attachmentsQueued += queuePriorityVoiceFromMessages(unique);
                    const write = scheduleCaptureWrite(channelId, unique, stagedRecords);
                    if (write) captureWrites.push(write);
                }

                const oldestId = oldestPageId(page, message => String(message?.id ?? ""));
                if (!oldestId || oldestId === previousOldest) {
                    partialError ??= "History pagination stopped because Discord repeated the same cursor.";
                    return;
                }

                if (segmentBoundaryReached(page, segment, message => String(message?.id ?? ""))) return;

                if (page.length < HISTORY_PAGE_SIZE) {
                    if (segment.lowerExclusive) {
                        // A real search anchor exists below this point, so a short page before the
                        // boundary is inconsistent. Do not claim a complete archive silently.
                        partialError ??= "Discord returned a short history page before a verified anchor boundary; capture was kept but completeness was not marked.";
                    } else {
                        lastUnboundedSegmentCompleted = true;
                    }
                    return;
                }

                previousOldest = oldestId;
                before = oldestId;
                maybeProgress();
            }
        };

        const worker = async () => {
            while (true) {
                if (!shouldContinue()) { cancelled = true; return; }
                const index = nextSegment++;
                if (index >= segments.length) return;
                await scanSegment(segments[index]);
                if (reachedLimit) return;
            }
        };

        await Promise.all(Array.from({ length: workerCount }, () => worker()));

        if (failedCursors.length && shouldContinue() && !reachedLimit) {
            const recovery = failedCursors.splice(0);
            let recoveryIndex = 0;
            const recoveryWorker = async () => {
                while (shouldContinue() && !reachedLimit) {
                    const item = recovery[recoveryIndex++];
                    if (!item) return;
                    await scanSegment(item.segment, item.before, false);
                }
            };
            await Promise.all(Array.from(
                { length: Math.min(HISTORY_RECOVERY_CONCURRENCY, recovery.length) },
                () => recoveryWorker()
            ));
        }

        reachedBeginning = lastUnboundedSegmentCompleted;

        // Do not report success until every page already received is durable on disk. The native
        // side serializes append operations per channel, so concurrent lanes cannot interleave a
        // single NDJSON record.
        const writeResults = await Promise.all(captureWrites.map(write => write.promise));
        for (const result of writeResults) {
            saved += result.saved;
            if (result.error) {
                writeFailures++;
                partialError ??= result.error;
            }
        }

        if (pluginRunning && enabledChannels.has(channelId)) {
            attachmentsQueued += queueAttachmentsFromRecords(stagedRecords, true);
            queueChannelAssets(channelId, buildChannelMeta(channelId));
        }

        if (pluginRunning && enabledChannels.has(channelId)) {
            if (reachedBeginning && !partialError && !cancelled && !reachedLimit) {
                await Native.markHistoryComplete(channelId).catch(error => {
                    partialError ??= `History-complete marker: ${formatArchiveError(error)}`;
                });
            }
            runBackground("Could not compact capture packs", Native.compactCapturePacks(channelId));
            runBackground("Could not refresh archived metadata", refreshArchivedMetadata());
        }

        if (partialError && messages === 0) throw new Error(partialError);
        const averageRequestMs = requestSamples ? totalRequestMs / requestSamples : 0;
        console.info(`[LocalGroupArchive] ${strategy} full capture used ${pages} /messages request(s) + ${anchorProbe.queries} anchor probe(s) for ${messages} unique message(s).`);
        return {
            messages,
            saved,
            pages,
            attachmentsQueued,
            writeFailures,
            reachedLimit,
            cancelled,
            partialError,
            elapsedMs: performance.now() - startedAt,
            strategy,
            anchorQueries: anchorProbe.queries,
            anchors: anchorIds.length,
            peakLanes,
            averageRequestMs
        };
    } finally {
        releaseAttachmentPump();
    }
}

interface HybridCoverageSegment {
    id: string;
    upperExclusive?: string;
    lowerExclusive?: string;
    plane: HybridPlane;
    status: "pending" | "complete";
}

interface HybridCoverageLedger {
    version: 1;
    channelId: string;
    frozenNewest: string;
    frozenBefore: string;
    createdAt: string;
    updatedAt: string;
    segments: HybridCoverageSegment[];
}

interface HybridSearchLane {
    coverage: HybridCoverageSegment;
    segment: HistorySegment;
    cursor?: Record<string, unknown>;
    cursorSignature?: string;
    offset: number;
    expected?: number;
    ids: Set<string>;
    requests: number;
    stalled: number;
    done: boolean;
    unstable: boolean;
    inFlight: boolean;
    normalClaimed: boolean;
}

interface HybridSearchTabResult {
    lane: HybridSearchLane;
    messages: any[];
    totalResults?: number;
    cursor?: Record<string, unknown>;
}

interface HybridSearchBatchResult {
    tabs: HybridSearchTabResult[];
    elapsedMs: number;
}

class AdaptiveRequestGate {
    private active = 0;
    private limit: number;
    private fastStreak = 0;
    private lastDecreaseAt = Number.NEGATIVE_INFINITY;
    private readonly waiters: Array<() => void> = [];
    private totalMs = 0;
    private samples = 0;
    peak = 0;

    constructor(
        initial: number,
        private readonly maximum: number,
        private readonly minimum = 1,
        private readonly panicUntil = 0
    ) {
        this.limit = Math.max(minimum, Math.min(initial, maximum));
    }

    private async acquire() {
        while (this.active >= this.limit) {
            await new Promise<void>(resolve => this.waiters.push(resolve));
        }
        this.active++;
        this.peak = Math.max(this.peak, this.active);
    }

    private release() {
        this.active = Math.max(0, this.active - 1);
        let available = Math.max(0, this.limit - this.active);
        while (available-- > 0) this.waiters.shift()?.();
    }

    private tune(elapsedMs: number, ok: boolean) {
        this.totalMs += elapsedMs;
        this.samples++;
        const now = performance.now();

        // Panic Burst deliberately spends Discord's initial allowance on rescue. RestAPI still
        // owns the real bucket/429 wait, but several requests released from the same client queue
        // must not independently punish one congestion event and collapse 6 -> 3 -> 1.
        if (now < this.panicUntil) return;

        if (!ok || elapsedMs >= HYBRID_SLOW_REQUEST_MS) {
            this.fastStreak = 0;
            if (now - this.lastDecreaseAt >= HYBRID_BACKOFF_COOLDOWN_MS) {
                this.limit = Math.max(this.minimum, this.limit - 1);
                this.lastDecreaseAt = now;
            }
            return;
        }
        if (elapsedMs <= HYBRID_FAST_REQUEST_MS) {
            this.fastStreak++;
            if (this.fastStreak >= 4 && this.limit < this.maximum) {
                this.limit++;
                this.fastStreak = 0;
            }
        } else {
            this.fastStreak = 0;
        }
    }

    async run<T>(op: () => Promise<T>) {
        await this.acquire();
        const startedAt = performance.now();
        let ok = false;
        try {
            const result = await op();
            ok = true;
            return result;
        } finally {
            this.tune(performance.now() - startedAt, ok);
            this.release();
        }
    }

    get averageMs() {
        return this.samples ? this.totalMs / this.samples : 0;
    }

    get concurrency() {
        return this.limit;
    }
}

function isHybridCoverageLedger(value: any, channelId: string): value is HybridCoverageLedger {
    if (!value || value.version !== 1 || String(value.channelId ?? "") !== channelId
        || typeof value.frozenNewest !== "string" || !/^\d{15,22}$/.test(value.frozenNewest)
        || typeof value.frozenBefore !== "string" || !/^\d{15,22}$/.test(value.frozenBefore)
        || snowflakeCompare(value.frozenNewest, value.frozenBefore) <= 0
        || !Array.isArray(value.segments) || value.segments.length === 0 || value.segments.length > 128) {
        return false;
    }
    return value.segments.every((segment: any) => segment
        && typeof segment.id === "string"
        && new Set(["normal", "channel-search", "global-search"]).has(segment.plane)
        && new Set(["pending", "complete"]).has(segment.status)
        && (segment.upperExclusive == null || /^\d{15,22}$/.test(segment.upperExclusive))
        && (segment.lowerExclusive == null || /^\d{15,22}$/.test(segment.lowerExclusive)));
}

function searchCursor(value: any): Record<string, unknown> | undefined {
    return value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length
        ? value as Record<string, unknown>
        : undefined;
}

async function fetchHybridSearchBatch(
    channelId: string,
    route: HybridSearchRoute,
    lanes: HybridSearchLane[],
    limit = SEARCH_SWEEP_TAB_LIMIT
): Promise<HybridSearchBatchResult> {
    const tabs: Record<string, any> = {};
    for (let index = 0; index < Math.min(lanes.length, HISTORY_ANCHOR_TAB_NAMES.length); index++) {
        const lane = lanes[index];
        const query: Record<string, any> = {
            limit,
            sort_by: "timestamp",
            sort_order: "desc"
        };
        if (lane.segment.upperExclusive) query.max_id = lane.segment.upperExclusive;
        if (lane.segment.lowerExclusive) query.min_id = lane.segment.lowerExclusive;
        if (lane.cursor) query.cursor = lane.cursor;
        else query.offset = lane.offset;
        tabs[HISTORY_ANCHOR_TAB_NAMES[index]] = query;
    }

    const startedAt = performance.now();
    const response: any = await RestAPI.post({
        url: route === "global-dm"
            ? "/users/@me/messages/search/tabs"
            : `/channels/${channelId}/messages/search/tabs`,
        body: {
            tabs,
            track_exact_total_hits: true,
            ...(route === "global-dm" ? { channel_ids: [channelId] } : {})
        },
        retries: 1
    });
    const elapsedMs = performance.now() - startedAt;
    const body = response?.body ?? {};
    if (response?.status === 202 || Number(body?.code) === 110000) {
        throw new Error(`Discord search index is not ready${body?.retry_after != null ? ` (retry after ${body.retry_after}s)` : ""}`);
    }
    if (!body?.tabs) throw new Error("Discord search/tabs returned no tab results");

    const results: HybridSearchTabResult[] = [];
    for (let index = 0; index < Math.min(lanes.length, HISTORY_ANCHOR_TAB_NAMES.length); index++) {
        const tab = body.tabs?.[HISTORY_ANCHOR_TAB_NAMES[index]] ?? {};
        const total = Number(tab.total_results);
        results.push({
            lane: lanes[index],
            messages: flattenSearchMessages(tab.messages)
                .filter((message: any) => message?.hit !== false)
                .filter((message: any) => String(message?.channel_id ?? message?.channelId ?? "") === channelId),
            totalResults: Number.isFinite(total) ? total : undefined,
            cursor: searchCursor(tab.cursor)
        });
    }
    return { tabs: results, elapsedMs };
}

function buildHybridCoverage(
    channelId: string,
    firstNewest: string,
    firstOldest: string,
    anchorIds: string[],
    channelSearchAvailable: boolean,
    globalSearchAvailable: boolean
): HybridCoverageLedger {
    const historySegments = buildHybridHistorySegments(
        firstOldest,
        anchorIds,
        channelSearchAvailable,
        globalSearchAvailable
    );

    const now = new Date().toISOString();
    return {
        version: 1,
        channelId,
        frozenNewest: firstNewest,
        frozenBefore: firstOldest,
        createdAt: now,
        updatedAt: now,
        segments: historySegments.map((segment, index) => ({
            id: `segment-${index}`,
            upperExclusive: segment.upperExclusive,
            lowerExclusive: segment.lowerExclusive,
            // The newest range retains full message shape and the unbounded oldest range must prove
            // the beginning authoritatively. Middle ranges are striped across independent routes.
            plane: segment.plane,
            status: "pending"
        }))
    };
}

async function archiveFullHistoryHybridInner(channelId: string, generation: number): Promise<HistoryResult> {
    const startedAt = performance.now();
    const panicUntil = startedAt + PANIC_BURST_MS;
    const normalGate = new AdaptiveRequestGate(
        HYBRID_NORMAL_INITIAL_CONCURRENCY,
        HYBRID_NORMAL_MAX_CONCURRENCY,
        HYBRID_NORMAL_MIN_CONCURRENCY,
        panicUntil
    );
    let pages = 0;
    let issuedRequests = 0;
    let searchRequests = 0;
    let globalSearchRequests = 0;
    let searchTabs = 0;
    let totalSearchMs = 0;
    let anchorQueries = 0;
    let anchors = 0;
    let repairedSegments = 0;
    let resumedSegments = 0;
    let panicMessages = 0;
    let stolenSegments = 0;
    let activeSearchRequests = 0;
    let peakSearchRequests = 0;
    let saved = 0;
    let attachmentsQueued = 0;
    let writeFailures = 0;
    let reachedLimit = false;
    let cancelled = false;
    let partialError: string | undefined;
    let lastProgressAt = startedAt;

    holdCriticalAttachmentPump();
    try {
        const ready = await ensureChannel(channelId);
        if (!ready) {
            handleArchiveDeleted(channelId);
            return {
                messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0,
                cancelled: true, elapsedMs: performance.now() - startedAt, strategy: "hybrid"
            };
        }

        const stagedRecords: any[] = [];
        const captureWrites: DeferredCaptureWrite[] = [];
        const seen = new Set<string>();
        const shouldContinue = () => shouldContinueForFullCapture(channelId, generation);

        const persistUnique = (incoming: any[]) => {
            const unique = incoming.filter(message => {
                const id = String(message?.id ?? "");
                if (!id || seen.has(id) || String(message?.channel_id ?? message?.channelId ?? "") !== channelId) return false;
                seen.add(id);
                return true;
            });
            if (!unique.length) return 0;
            const write = scheduleCaptureWrite(channelId, unique, stagedRecords);
            if (write) captureWrites.push(write);
            if (performance.now() <= panicUntil) panicMessages = Math.max(panicMessages, seen.size);
            return unique.length;
        };

        const maybeProgress = (coverage: HybridCoverageLedger, normalPending: number, searchPending: number) => {
            const now = performance.now();
            if (now - lastProgressAt < HYBRID_PROGRESS_MS) return;
            lastProgressAt = now;
            const completeSegments = coverage.segments.filter(segment => segment.status === "complete").length;
            const panicRemaining = Math.max(0, panicUntil - now);
            sendBotMessage(channelId, {
                content: `⚡ **Smart Hybrid${panicRemaining ? " PANIC" : ""}:** ${seen.size.toLocaleString()} new unique message(s) durable/queued${panicRemaining ? `, ${(panicRemaining / 1000).toFixed(1)}s burst left` : `, ${panicMessages.toLocaleString()} rescued inside the first ${(PANIC_BURST_MS / 1000).toFixed(0)}s`}, ${completeSegments}/${coverage.segments.length} range(s) proven, ${pages} normal + ${searchRequests} channel-search + ${globalSearchRequests} global-search request(s), ${normalPending} normal / ${searchPending} search range(s) active, adaptive normal concurrency ${normalPending ? normalGate.concurrency : "idle"}, ${((now - startedAt) / 1000).toFixed(1)}s elapsed.`
            });
        };

        issuedRequests++;
        pages++;
        let firstPage: any[];
        try {
            firstPage = await normalGate.run(() => fetchHistoryPage(channelId));
        } catch (error: any) {
            throw new Error(`Newest history edge failed: ${formatArchiveError(error)}`);
        }
        persistUnique(firstPage);
        const firstNewest = newestPageId(firstPage, message => String(message?.id ?? ""));
        const firstOldest = oldestPageId(firstPage, message => String(message?.id ?? ""));

        if (firstPage.length < HISTORY_PAGE_SIZE || !firstNewest || !firstOldest) {
            const writeResults = await Promise.all(captureWrites.map(write => write.promise));
            for (const result of writeResults) {
                saved += result.saved;
                if (result.error) { writeFailures++; partialError ??= result.error; }
            }
            if (pluginRunning && enabledChannels.has(channelId)) {
                attachmentsQueued += queueAttachmentsFromRecords(stagedRecords);
                queueChannelAssets(channelId, buildChannelMeta(channelId));
                if (!partialError && shouldContinue()) {
                    await Native.markHistoryComplete(channelId);
                    await Native.clearCaptureCoverage(channelId).catch(() => { });
                }
                runBackground("Could not compact capture packs", Native.compactCapturePacks(channelId));
                runBackground("Could not refresh archived metadata", refreshArchivedMetadata());
            }
            return {
                messages: seen.size, saved, pages, attachmentsQueued, writeFailures, partialError,
                elapsedMs: performance.now() - startedAt, strategy: "hybrid", peakLanes: normalGate.peak,
                averageRequestMs: normalGate.averageMs, fastComplete: !partialError, panicMessages
            };
        }

        const storedCoverage = await Native.getCaptureCoverage(channelId).catch(() => null);
        let coverage: HybridCoverageLedger;
        if (isHybridCoverageLedger(storedCoverage, channelId)) {
            coverage = storedCoverage;
            resumedSegments = coverage.segments.filter(segment => segment.status === "complete").length;
            // If more than one full edge page arrived since the last checkpoint, bridge precisely
            // from the new page's oldest ID to the previous page's newest durable ID. With <=100 new
            // messages the pages overlap, so the newest request alone already closes the delta.
            if (snowflakeCompare(firstOldest, coverage.frozenNewest) > 0) {
                const gapId = `resume-gap-${firstOldest}`;
                const existingGap = coverage.segments.find(segment => segment.id === gapId);
                if (existingGap) {
                    existingGap.upperExclusive = firstOldest;
                    existingGap.lowerExclusive = coverage.frozenNewest;
                    existingGap.plane = "normal";
                    existingGap.status = "pending";
                } else {
                    // Completed resume gaps are already durable and can be collapsed out of the
                    // plan before adding a newer gap. This keeps repeated crash/reconnect cycles
                    // safely below the native 128-segment cap.
                    coverage.segments = coverage.segments.filter(segment =>
                        segment.status !== "complete" || !segment.id.startsWith("resume-gap-"));
                    if (coverage.segments.length >= 128) throw new Error("Resumable coverage reached its safe segment cap");
                    coverage.segments.unshift({
                        id: gapId,
                        upperExclusive: firstOldest,
                        lowerExclusive: coverage.frozenNewest,
                        plane: "normal",
                        status: "pending"
                    });
                }
            }
            coverage.frozenNewest = firstNewest;
            coverage.frozenBefore = firstOldest;
        } else {
            if (storedCoverage) await Native.clearCaptureCoverage(channelId).catch(() => { });
            const anchorProbe = await discoverHistoryAnchors(channelId, generation, firstOldest);
            anchorQueries = anchorProbe.queries;
            const anchorMessages = anchorProbe.messages
                .filter(message => message?.id && String(message?.channel_id ?? message?.channelId ?? "") === channelId);
            persistUnique(anchorMessages);
            const anchorIds = anchorMessages.map(message => String(message.id));
            anchors = anchorIds.length;
            coverage = buildHybridCoverage(
                channelId,
                firstNewest,
                firstOldest,
                anchorIds,
                anchorProbe.channelSearchAvailable,
                anchorProbe.globalSearchAvailable
            );
        }

        const captureWritesAreDurable = async () => {
            const results = await Promise.all(captureWrites.map(write => write.promise));
            const failed = results.find(result => result.error);
            if (!failed?.error) return true;
            partialError ??= `Capture-pack write: ${failed.error}`;
            return false;
        };
        const checkpointCoverage = async () => {
            coverage.updatedAt = new Date().toISOString();
            try {
                await Native.saveCaptureCoverage(channelId, JSON.stringify(coverage));
                return true;
            } catch (error) {
                console.warn("[LocalGroupArchive] Coverage checkpoint failed", error);
                partialError ??= `Coverage checkpoint: ${formatArchiveError(error)}`;
                return false;
            }
        };
        const markSegmentComplete = async (segment: HybridCoverageSegment) => {
            // A range is only resumably complete once every capture-pack append issued before this
            // point has succeeded. Never let a disk failure leave a convincing-but-hollow ledger.
            if (!await captureWritesAreDurable()) return false;
            segment.status = "complete";
            if (await checkpointCoverage()) return true;
            segment.status = "pending";
            return false;
        };
        const deferredAuthoritativeCompletions = new Map<string, HybridCoverageSegment>();
        const finishAuthoritativeSegment = async (segment: HybridCoverageSegment) => {
            // During the five-second rescue window, keep network workers moving. Capture packs are
            // already being appended; only the proof/checkpoint wait is deferred and batched.
            if (performance.now() < panicUntil) {
                deferredAuthoritativeCompletions.set(segment.id, segment);
                return true;
            }
            return markSegmentComplete(segment);
        };
        const flushDeferredAuthoritativeCompletions = async () => {
            const segments = [...deferredAuthoritativeCompletions.values()]
                .filter(segment => segment.status !== "complete");
            deferredAuthoritativeCompletions.clear();
            if (!segments.length) return true;
            if (!await captureWritesAreDurable()) return false;
            for (const segment of segments) segment.status = "complete";
            if (await checkpointCoverage()) return true;
            for (const segment of segments) segment.status = "pending";
            return false;
        };
        // The first edge and every anchor sit outside at least one planned exclusive range. Make
        // those boundary records durable before publishing the resumable plan.
        if (!await captureWritesAreDurable()) throw new Error(partialError ?? "Could not persist capture boundaries");
        await Native.saveCaptureCoverage(channelId, JSON.stringify(coverage));

        const pendingSegments = coverage.segments.filter(segment => segment.status !== "complete");
        const normalQueue = pendingSegments.filter(segment => segment.plane === "normal");
        const channelSearchSegments = pendingSegments.filter(segment => segment.plane === "channel-search");
        const globalSearchSegments = pendingSegments.filter(segment => segment.plane === "global-search");
        const repairMap = new Map<string, HybridCoverageSegment>();
        let normalIndex = 0;
        let activeNormalSegments = 0;
        let activeRepairSegments = 0;

        const scanNormalSegment = async (coverageSegment: HybridCoverageSegment, recovery = false) => {
            const segment: HistorySegment = {
                upperExclusive: coverageSegment.upperExclusive,
                lowerExclusive: coverageSegment.lowerExclusive
            };
            let before = segment.upperExclusive;
            let previousOldest: string | undefined;
            while (shouldContinue()) {
                if (issuedRequests >= MAX_HISTORY_PAGES) {
                    reachedLimit = true;
                    return false;
                }
                issuedRequests++;
                pages++;
                let page: any[];
                try {
                    page = await normalGate.run(() => fetchHistoryPage(channelId, before));
                } catch (error: any) {
                    if (recovery) partialError ??= `History range ${coverageSegment.id} failed: ${formatArchiveError(error)}`;
                    return false;
                }

                if (!page.length) {
                    return finishAuthoritativeSegment(coverageSegment);
                }
                const inSegment = selectPageForSegment(page, segment, message => String(message?.id ?? ""));
                persistUnique(inSegment);
                const oldestId = oldestPageId(page, message => String(message?.id ?? ""));
                if (!oldestId || oldestId === previousOldest) {
                    if (recovery) partialError ??= `History range ${coverageSegment.id} repeated its cursor.`;
                    return false;
                }
                if (segmentBoundaryReached(page, segment, message => String(message?.id ?? ""))) {
                    return finishAuthoritativeSegment(coverageSegment);
                }
                if (page.length < HISTORY_PAGE_SIZE) {
                    if (segment.lowerExclusive) {
                        if (recovery) partialError ??= `Discord returned a short page before range ${coverageSegment.id}'s real boundary.`;
                        return false;
                    }
                    return finishAuthoritativeSegment(coverageSegment);
                }
                previousOldest = oldestId;
                before = oldestId;
                maybeProgress(coverage, countNormalWork(), countActiveSearchWork());
            }
            cancelled = true;
            return false;
        };

        const makeSearchLanes = (segments: HybridCoverageSegment[]): HybridSearchLane[] => segments.map(coverageSegment => ({
            coverage: coverageSegment,
            segment: {
                upperExclusive: coverageSegment.upperExclusive,
                lowerExclusive: coverageSegment.lowerExclusive
            },
            offset: 0,
            ids: new Set<string>(),
            requests: 0,
            stalled: 0,
            done: false,
            unstable: false,
            inFlight: false,
            normalClaimed: false
        } satisfies HybridSearchLane));

        const channelLanes = makeSearchLanes(channelSearchSegments);
        const globalLanes = makeSearchLanes(globalSearchSegments);
        const allSearchLanes = [...channelLanes, ...globalLanes];
        const workStateWaiters = new Set<() => void>();
        const signalWorkStateChange = () => {
            for (const resolve of workStateWaiters) resolve();
            workStateWaiters.clear();
        };
        const waitForWorkStateChange = () => new Promise<void>(resolve => workStateWaiters.add(resolve));
        const countNormalWork = () => Math.max(0, normalQueue.length - normalIndex)
            + activeNormalSegments + activeRepairSegments;
        const countActiveSearchWork = () => allSearchLanes.filter(lane =>
            lane.coverage.status !== "complete" && !lane.done && !lane.normalClaimed).length;
        const hasOutstandingSearchWork = () => allSearchLanes.some(lane =>
            lane.coverage.status !== "complete" && !lane.done);
        const claimSearchLaneForNormal = () => {
            const candidate = allSearchLanes
                .filter(lane => lane.coverage.status !== "complete" && !lane.done
                    && !lane.inFlight && !lane.normalClaimed)
                .sort((left, right) => left.requests - right.requests)[0];
            if (candidate) {
                candidate.normalClaimed = true;
                stolenSegments++;
            }
            return candidate;
        };

        const normalWorker = async () => {
            while (shouldContinue() && !reachedLimit) {
                let segment = normalIndex < normalQueue.length
                    ? normalQueue[normalIndex++]
                    : undefined;
                let claimedLane: HybridSearchLane | undefined;
                if (!segment) {
                    claimedLane = claimSearchLaneForNormal();
                    segment = claimedLane?.coverage;
                    if (!segment) {
                        // A search request may temporarily own every remaining lane. Keep the
                        // normal workers warm so they can steal a slow lane as soon as it returns.
                        if (hasOutstandingSearchWork()) {
                            await waitForWorkStateChange();
                            continue;
                        }
                        return;
                    }
                }

                activeNormalSegments++;
                let completed = false;
                try {
                    completed = await scanNormalSegment(segment);
                } finally {
                    activeNormalSegments = Math.max(0, activeNormalSegments - 1);
                }
                if (claimedLane) claimedLane.done = true;
                if (!completed) repairMap.set(segment.id, segment);
                signalWorkStateChange();
            }
        };

        const scanSearchRoute = async (route: HybridSearchRoute, lanes: HybridSearchLane[]) => {
            let routeUnavailable = false;
            const searchWorker = async (workerIndex: number) => {
                while (shouldContinue() && !routeUnavailable) {
                    // The second worker exists only to consume the initial burst allowance. After
                    // five seconds, one request stream per route avoids manufacturing a local queue.
                    if (workerIndex > 0 && performance.now() >= panicUntil) break;
                    const available = lanes
                        .filter(lane => lane.coverage.status !== "complete" && !lane.done
                            && !lane.normalClaimed && !lane.inFlight)
                        .sort((left, right) => left.requests - right.requests);
                    if (!available.length) {
                        const waiting = lanes.some(lane => lane.coverage.status !== "complete"
                            && !lane.done && !lane.normalClaimed);
                        if (waiting) {
                            await waitForWorkStateChange();
                            continue;
                        }
                        break;
                    }

                    const selected = available.slice(0, HISTORY_ANCHOR_TAB_NAMES.length);
                    for (const lane of selected) lane.inFlight = true;
                    activeSearchRequests++;
                    peakSearchRequests = Math.max(peakSearchRequests, activeSearchRequests);
                    let batch: HybridSearchBatchResult;
                    try {
                        batch = await fetchHybridSearchBatch(channelId, route, selected);
                        if (route === "global-dm") globalSearchRequests++;
                        else searchRequests++;
                        searchTabs += selected.length;
                        totalSearchMs += batch.elapsedMs;
                    } catch (error) {
                        console.debug(`[LocalGroupArchive] ${route} search plane unavailable`, formatArchiveError(error));
                        routeUnavailable = true;
                        for (const lane of lanes) {
                            if (lane.coverage.status === "complete" || lane.normalClaimed) continue;
                            lane.done = true;
                            repairMap.set(lane.coverage.id, lane.coverage);
                        }
                        signalWorkStateChange();
                        return;
                    } finally {
                        activeSearchRequests = Math.max(0, activeSearchRequests - 1);
                        for (const lane of selected) lane.inFlight = false;
                    }

                    const combined: any[] = [];
                    for (const tab of batch.tabs) {
                        const { lane } = tab;
                        lane.requests++;
                        if (tab.totalResults != null) {
                            if (lane.expected == null) lane.expected = tab.totalResults;
                            else if (lane.expected !== tab.totalResults) lane.unstable = true;
                        }
                        const inSegment = selectPageForSegment(tab.messages, lane.segment, message => String(message?.id ?? ""));
                        let newIds = 0;
                        for (const message of inSegment) {
                            const id = String(message?.id ?? "");
                            if (id && !lane.ids.has(id)) {
                                lane.ids.add(id);
                                newIds++;
                            }
                        }
                        combined.push(...inSegment);
                        lane.stalled = newIds ? 0 : lane.stalled + 1;

                        if (lane.expected != null && lane.ids.size === lane.expected && !lane.unstable) {
                            lane.done = true;
                            continue;
                        }
                        const nextCursor = tab.cursor;
                        const signature = nextCursor ? JSON.stringify(nextCursor) : undefined;
                        if (nextCursor && signature !== lane.cursorSignature && lane.stalled < 2) {
                            lane.cursor = nextCursor;
                            lane.cursorSignature = signature;
                            continue;
                        }
                        if (!lane.cursor && tab.messages.length > 0 && lane.offset < 9975 && lane.stalled < 2) {
                            lane.offset += SEARCH_SWEEP_TAB_LIMIT;
                            continue;
                        }
                        lane.done = true;
                    }
                    persistUnique(combined);
                    maybeProgress(coverage, countNormalWork(), countActiveSearchWork());
                    signalWorkStateChange();
                    // Let waiting authoritative workers claim a released slow range before this
                    // search worker starts the next request for the same lane.
                    await Promise.resolve();
                }
                signalWorkStateChange();
                if (!shouldContinue()) cancelled = true;
            };

            const workerCount = Math.min(
                PANIC_SEARCH_WORKERS_PER_ROUTE,
                Math.max(1, Math.ceil(lanes.length / HISTORY_ANCHOR_TAB_NAMES.length))
            );
            await Promise.all(Array.from({ length: workerCount }, (_, index) => searchWorker(index)));
        };

        // Start both independent search routes first so their first batches are in flight before
        // idle normal workers begin hedging unfinished search ranges.
        const searchJobs = [
            scanSearchRoute("channel", channelLanes),
            scanSearchRoute("global-dm", globalLanes)
        ];
        const normalWorkerCount = Math.min(
            HYBRID_NORMAL_MAX_CONCURRENCY,
            Math.max(1, normalQueue.length + allSearchLanes.length)
        );
        await Promise.all([
            ...searchJobs,
            ...Array.from({ length: normalWorkerCount }, () => normalWorker())
        ]);
        await flushDeferredAuthoritativeCompletions();

        // Re-read exact counts through the channel-scoped search route. This catches unstable
        // offsets and also prevents global-DM search (which can hide blocked authors) from claiming
        // a range complete merely because its own filtered total matched.
        const searchLanes = allSearchLanes.filter(lane =>
            lane.coverage.status !== "complete" && !lane.normalClaimed);
        if (shouldContinue()) {
            for (let start = 0; start < searchLanes.length; start += HISTORY_ANCHOR_TAB_NAMES.length) {
                const candidates = searchLanes.slice(start, start + HISTORY_ANCHOR_TAB_NAMES.length);
                const probes = candidates.map(lane => ({
                    ...lane,
                    cursor: undefined,
                    cursorSignature: undefined,
                    offset: 0
                }));
                try {
                    const verification = await fetchHybridSearchBatch(channelId, "channel", probes, 1);
                    searchRequests++;
                    searchTabs += probes.length;
                    totalSearchMs += verification.elapsedMs;
                    for (const tab of verification.tabs) {
                        const original = candidates.find(lane => lane.coverage.id === tab.lane.coverage.id);
                        if (!original || original.unstable || tab.totalResults == null || tab.totalResults !== original.ids.size) {
                            if (original) repairMap.set(original.coverage.id, original.coverage);
                            continue;
                        }
                        if (!await markSegmentComplete(original.coverage)) {
                            repairMap.set(original.coverage.id, original.coverage);
                        }
                    }
                } catch (error) {
                    console.debug("[LocalGroupArchive] Search range verification failed", formatArchiveError(error));
                    for (const lane of candidates) repairMap.set(lane.coverage.id, lane.coverage);
                    break;
                }
            }
        }

        const repairSegments = [...repairMap.values()].filter(segment => segment.status !== "complete");
        repairedSegments = repairSegments.length;
        let repairIndex = 0;
        const repairWorker = async () => {
            while (shouldContinue() && !reachedLimit) {
                const segment = repairSegments[repairIndex++];
                if (!segment) return;
                segment.plane = "normal";
                activeRepairSegments++;
                try {
                    if (!await scanNormalSegment(segment, true) && !partialError) {
                        partialError = `Could not prove repaired range ${segment.id} complete.`;
                    }
                } finally {
                    activeRepairSegments = Math.max(0, activeRepairSegments - 1);
                }
            }
        };
        await Promise.all(Array.from(
            { length: Math.min(HISTORY_RECOVERY_CONCURRENCY, repairSegments.length) },
            () => repairWorker()
        ));
        await flushDeferredAuthoritativeCompletions();

        if (!shouldContinue()) cancelled = true;
        const writeResults = await Promise.all(captureWrites.map(write => write.promise));
        for (const result of writeResults) {
            saved += result.saved;
            if (result.error) {
                writeFailures++;
                partialError ??= result.error;
            }
        }

        const complete = coverage.segments.every(segment => segment.status === "complete");
        if (!complete && !cancelled && !partialError) partialError = "One or more history ranges remain unproven; the resumable coverage ledger was preserved.";

        if (pluginRunning && enabledChannels.has(channelId)) {
            attachmentsQueued += queueAttachmentsFromRecords(stagedRecords);
            queueChannelAssets(channelId, buildChannelMeta(channelId));
            if (complete && !partialError && !cancelled && !reachedLimit) {
                await Native.markHistoryComplete(channelId).catch(error => {
                    partialError ??= `History-complete marker: ${formatArchiveError(error)}`;
                });
                if (!partialError) await Native.clearCaptureCoverage(channelId).catch(error => {
                    partialError ??= `Coverage cleanup: ${formatArchiveError(error)}`;
                });
            } else {
                await checkpointCoverage();
            }
            runBackground("Could not compact capture packs", Native.compactCapturePacks(channelId));
            runBackground("Could not refresh archived metadata", refreshArchivedMetadata());
        }

        const allSearchRequests = searchRequests + globalSearchRequests;
        return {
            messages: seen.size,
            saved,
            pages,
            attachmentsQueued,
            writeFailures,
            reachedLimit,
            cancelled,
            partialError,
            elapsedMs: performance.now() - startedAt,
            strategy: "hybrid",
            anchorQueries,
            anchors,
            peakLanes: normalGate.peak + peakSearchRequests,
            averageRequestMs: allSearchRequests ? totalSearchMs / allSearchRequests : normalGate.averageMs,
            searchRequests,
            globalSearchRequests,
            searchTabs,
            repairedSegments,
            resumedSegments,
            panicMessages,
            stolenSegments,
            fastComplete: complete && !partialError && !cancelled && !reachedLimit
        };
    } finally {
        releaseCriticalAttachmentPump();
    }
}

function archiveFullHistory(channelId: string) {
    const existing = historyJobs.get(channelId);
    if (existing) return existing;

    const generation = (historyGenerations.get(channelId) ?? 0) + 1;
    historyGenerations.set(channelId, generation);
    const job = archiveFullHistoryHybridInner(channelId, generation)
        .catch(async error => {
            if (!shouldContinueForFullCapture(channelId, generation)) throw error;
            // An unexpected client/search incompatibility must never make rescue all-or-nothing.
            // The slower real-ID anchored walker remains a correctness fallback for fatal hybrid
            // setup failures; normal search misses inside Hybrid are already repaired per range.
            console.warn("[LocalGroupArchive] Smart Hybrid failed before it could finish; using anchored safety fallback", error);
            const fallback = await archiveFullHistoryAnchoredInner(channelId, generation);
            if (!fallback.cancelled && !fallback.partialError && !fallback.reachedLimit) {
                await Native.clearCaptureCoverage(channelId).catch(() => { });
            }
            return fallback;
        })
        .finally(() => historyJobs.delete(channelId));

    historyJobs.set(channelId, job);
    return job;
}

async function archiveOlderHistoryInner(channelId: string, generation: number): Promise<HistoryResult> {
    const ready = await ensureChannel(channelId);
    if (!ready) return { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0, cancelled: true };

    if (await Native.isHistoryComplete(channelId).catch(() => false)) {
        return { messages: 0, saved: 0, pages: 0, attachmentsQueued: 0, writeFailures: 0 };
    }

    const bounds = await Native.getChannelArchiveBounds(channelId);
    const oldestKnown = typeof bounds?.oldestId === "string" ? bounds.oldestId : null;
    if (!oldestKnown) return archiveFullHistory(channelId);

    let before = oldestKnown;
    let previousOldest: string | undefined;
    let messages = 0;
    let saved = 0;
    let pages = 0;
    let attachmentsQueued = 0;
    let writeFailures = 0;
    let cancelled = false;
    let partialError: string | undefined;
    let reachedBeginning = false;
    const stagedMedia: Array<{ records: any[]; }> = [];

    // This is the migration/backfill path for an archive that already has a contiguous local
    // prefix but predates the .history-complete marker. One empty request proves an old v0.5.x
    // archive already reaches the beginning; otherwise only the missing older tail is fetched.
    holdAttachmentPump();
    try {
        try {
            while (pages < MAX_HISTORY_PAGES) {
                if (!pluginRunning || !enabledChannels.has(channelId) || !isGroupDm(channelId)
                    || olderBackfillGenerations.get(channelId) !== generation) {
                    cancelled = true;
                    break;
                }

                const page = await fetchHistoryPage(channelId, before);
                if (page.length === 0) {
                    reachedBeginning = true;
                    break;
                }
                pages++;
                messages += page.length;
                attachmentsQueued += queuePriorityVoiceFromMessages(page);

                try {
                    const result = await saveMessageBatch(
                        channelId,
                        page,
                        "history",
                        (_persistedMessages, persistedRecords) => stagedMedia.push({ records: persistedRecords }),
                        true
                    );
                    saved += result.saved;
                    if (result.deleted) {
                        cancelled = true;
                        break;
                    }
                } catch (error: any) {
                    writeFailures++;
                    partialError ??= formatArchiveError(error);
                }

                const oldestId = page[page.length - 1]?.id as string | undefined;
                if (!oldestId || oldestId === previousOldest) break;
                previousOldest = oldestId;
                before = oldestId;

                if (page.length < HISTORY_PAGE_SIZE) {
                    reachedBeginning = true;
                    break;
                }
            }
        } catch (error: any) {
            partialError = formatArchiveError(error);
            cancelled = true;
        }

        if (pluginRunning && enabledChannels.has(channelId)) {
            for (const stage of stagedMedia) attachmentsQueued += queueAttachmentsFromRecords(stage.records, true);
            if (reachedBeginning && !cancelled && !partialError) {
                await Native.markHistoryComplete(channelId).catch(error => {
                    partialError ??= `History-complete marker: ${formatArchiveError(error)}`;
                });
            }
            if (saved) runBackground("Could not compact viewer data after older-tail backfill", Native.compactViewerData(channelId));
        }

        return { messages, saved, pages, attachmentsQueued, writeFailures, cancelled, partialError, reachedLimit: pages >= MAX_HISTORY_PAGES };
    } finally {
        releaseAttachmentPump();
    }
}

function archiveOlderHistory(channelId: string) {
    const existing = olderBackfillJobs.get(channelId);
    if (existing) return existing;
    const full = historyJobs.get(channelId);
    if (full) return full;
    const generation = (olderBackfillGenerations.get(channelId) ?? 0) + 1;
    olderBackfillGenerations.set(channelId, generation);
    const job = Native.getCaptureCoverage(channelId)
        .catch(() => null)
        .then(coverage => isHybridCoverageLedger(coverage, channelId)
            ? archiveFullHistory(channelId)
            : archiveOlderHistoryInner(channelId, generation))
        .finally(() => olderBackfillJobs.delete(channelId));
    olderBackfillJobs.set(channelId, job);
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
    const stagedMedia: Array<{ records: any[]; }> = [];

    holdAttachmentPump();
    try {
        while (pages < MAX_HISTORY_PAGES) {
            if (!pluginRunning || !enabledChannels.has(channelId) || !isGroupDm(channelId)
                || historyGenerations.get(channelId) !== generation) {
                cancelled = true;
                break;
            }

            const page = await fetchHistoryPage(channelId, before);
            if (page.length === 0) break;
            pages++;

            const pageIds = page.map(message => String(message?.id ?? "")).filter(Boolean);
            const oldestId = pageIds.sort(snowflakeCompare)[0];
            const recent = page.filter(message => snowflakeCompare(String(message?.id ?? "0"), newestKnown) > 0);
            messages += recent.length;
            if (recent.length) {
                attachmentsQueued += queuePriorityVoiceFromMessages(recent);
                try {
                    const result = await saveMessageBatch(
                        channelId,
                        recent,
                        "history",
                        (_persistedMessages, records) => stagedMedia.push({ records }),
                        true
                    );
                    saved += result.saved;
                    attachmentsQueued += result.attachmentsQueued;
                    if (result.deleted) {
                        cancelled = true;
                        break;
                    }
                } catch (error: any) {
                    writeFailures++;
                    partialError ??= formatArchiveError(error);
                }
            }

            if (!oldestId || oldestId === previousOldest || snowflakeCompare(oldestId, newestKnown) <= 0) break;
            previousOldest = oldestId;
            before = oldestId;
            if (page.length < HISTORY_PAGE_SIZE) break;
        }
    } catch (error: any) {
        partialError = formatArchiveError(error);
    }

    try {
        if (pluginRunning && enabledChannels.has(channelId)) {
            for (const stage of stagedMedia) attachmentsQueued += queueAttachmentsFromRecords(stage.records, true);
        }

        if (!cancelled && messages) {
            // Never make emergency completion wait for a 10k+ message viewer rebuild. The dirty
            // marker written by deferred batches makes the viewer self-heal in the background.
            runBackground("Could not compact viewer data after instant rescue", Native.compactViewerData(channelId));
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
    } finally {
        releaseAttachmentPump();
    }
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

async function refreshArchivedMetadata() {
    try {
        const metadata = await Native.getArchivedChannelMetadata();
        archivedMetadata = new Map(Object.entries(metadata ?? {}));
        ghostListInstance?.forceUpdate?.();
    } catch (error) {
        console.warn("[LocalGroupArchive] Could not refresh archived metadata", error);
    }
}

function ghostChannelIds() {
    const current = new Set(currentGroupIds());
    return [...enabledChannels]
        .filter(channelId => !current.has(channelId) && archivedMetadata.has(channelId))
        .sort((a, b) => snowflakeCompare(b, a));
}

async function initializeNewGroupBaseline(storedBaseline: unknown) {
    if (Array.isArray(storedBaseline)) {
        baselineGroupIds = new Set(storedBaseline.map(String));
        baselineReady = true;
        knownGroupIds = new Set([...baselineGroupIds, ...enabledChannels]);
        return;
    }

    let previousSignature = "";
    let stableRounds = 0;
    let latest = currentPrivateChannelSnapshot();
    for (let round = 0; round < BASELINE_MAX_ROUNDS && pluginRunning; round++) {
        latest = currentPrivateChannelSnapshot();
        const signature = `${latest.totalPrivateChannels}:${latest.groupIds.join(",")}`;
        // CONNECTION_OPEN is the strongest signal that Discord finished hydrating private
        // channels. A non-empty stable store is also sufficient when the plugin starts after an
        // already-open connection. This avoids baselining an empty/half-loaded store and later
        // mistaking old Group DMs for newly-created ones.
        const storeLooksReady = connectionOpenSeen || latest.totalPrivateChannels > 0;
        if (signature === previousSignature && storeLooksReady) stableRounds++;
        else stableRounds = 0;
        previousSignature = signature;
        if (stableRounds >= BASELINE_STABLE_ROUNDS) break;
        await wait(BASELINE_POLL_MS);
    }

    // Migration rule for v0.7: everything that already existed when the plugin came up is an
    // ignored baseline, even if v0.6 Hot Mirror had enabled it. Local files are kept untouched.
    // A channel snowflake created after this plugin start is excluded so a genuinely new group
    // cannot accidentally become "old" during the short store-stabilisation window.
    const newDuringStartup: string[] = [];
    baselineGroupIds = new Set(latest.groupIds.filter(channelId => {
        if (isAutoProtectEligibleNewGroup(channelId)) {
            newDuringStartup.push(channelId);
            return false;
        }
        return true;
    }));

    let enabledChanged = false;
    for (const channelId of baselineGroupIds) {
        if (enabledChannels.delete(channelId)) enabledChanged = true;
        autoCaptureStarted.delete(channelId);
        startupCatchupPending.delete(channelId);
        startupCatchupBoundaries.delete(channelId);
        cancelHistory(channelId);
    }
    if (enabledChanged) await persistEnabledChannels();
    await persistBaseline();
    baselineReady = true;
    knownGroupIds = new Set([...baselineGroupIds, ...enabledChannels]);

    for (const channelId of newDuringStartup) {
        knownGroupIds.add(channelId);
        startAutomaticCapture(channelId);
    }
}

async function processPendingNewGroupsAfterBaseline() {
    if (!baselineReady || pendingNewDuringBaseline.size === 0) return;
    let baselineChanged = false;
    for (const channelId of pendingNewDuringBaseline) {
        // Discord can hydrate an old/closed DM only when it becomes visible. Presence in
        // ChannelStore is therefore not proof that a group is new. The persisted snowflake-time
        // cutoff is the source of truth: only channels actually CREATED after the cutoff qualify.
        if (!isGroupDm(channelId)) continue;
        knownGroupIds.add(channelId);
        if (!isAutoProtectEligibleNewGroup(channelId)) {
            if (!baselineGroupIds.has(channelId)) {
                baselineGroupIds.add(channelId);
                baselineChanged = true;
            }
            continue;
        }
        if (baselineGroupIds.delete(channelId)) baselineChanged = true;
        startAutomaticCapture(channelId);
    }
    pendingNewDuringBaseline.clear();
    if (baselineChanged) await persistBaseline();
}

async function resetBaselineToCurrentGroups() {
    // Reset means "everything created before this instant is old", including DMs that Discord
    // has not hydrated into ChannelStore yet. This avoids a hidden old group being mistaken for
    // a new one later when the user opens it.
    baselineCutoffMs = Date.now();
    baselineGroupIds = new Set(currentGroupIds());
    for (const channelId of baselineGroupIds) {
        enabledChannels.delete(channelId);
        autoCaptureStarted.delete(channelId);
        cancelHistory(channelId);
    }
    knownGroupIds = new Set([...baselineGroupIds, ...enabledChannels]);
    await Promise.all([persistBaseline(), persistBaselineCutoff(), persistEnabledChannels()]);
    ghostListInstance?.forceUpdate?.();
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
                const recent = await archiveRecentHistory(channelId);
                const older = await archiveOlderHistory(channelId);
                const result = mergeHistoryResults(recent, older);
                if (result.saved || result.writeFailures || result.partialError || older.pages) {
                    console.info(`[LocalGroupArchive] Startup protected-group catch-up for ${channelId}: ${result.saved}/${result.messages} saved across ${result.pages} page(s).`);
                }
            } catch (error) {
                console.warn(`[LocalGroupArchive] Startup catch-up failed for ${channelId}`, error);
            }
        }
    };
    await Promise.all([worker(), worker()]);
}

async function reconcileWarmMirrorOnce(maxChannels = 1) {
    if (!pluginRunning || warmMirrorReconcileRunning) return;
    warmMirrorReconcileRunning = true;
    try {
        const channelIds = [...enabledChannels].filter(isGroupDm).sort(snowflakeCompare);
        const targets: string[] = [];
        for (let inspected = 0; inspected < channelIds.length && targets.length < Math.max(1, maxChannels); inspected++) {
            const index = warmMirrorCursor++ % channelIds.length;
            const channelId = channelIds[index];
            if (historyJobs.has(channelId) || catchupJobs.has(channelId) || olderBackfillJobs.has(channelId)) continue;
            // Partial cold captures are resumed by startup/manual rescue. The warm reconciler is
            // intentionally a one-page delta safety net for already-proven mirrors, so it cannot
            // turn into a permanent background history crawler or compete with a cold bootstrap.
            if (!await Native.isHistoryComplete(channelId).catch(() => false)) continue;
            targets.push(channelId);
        }

        let next = 0;
        const worker = async () => {
            while (pluginRunning) {
                const channelId = targets[next++];
                if (!channelId) return;
                const result = await archiveRecentHistory(channelId);
                if (result.saved || result.writeFailures || result.partialError) {
                    console.info(`[LocalGroupArchive] Warm Mirror reconciled ${channelId}: ${result.saved}/${result.messages} saved across ${result.pages} request(s).`);
                }
            }
        };
        await Promise.all(Array.from({ length: Math.min(2, targets.length) }, () => worker()));
    } catch (error) {
        console.debug("[LocalGroupArchive] Warm Mirror reconciliation skipped", error);
    } finally {
        warmMirrorReconcileRunning = false;
    }
}

async function captureStartupBoundaries() {
    const channelIds = [...enabledChannels];
    let next = 0;
    const worker = async () => {
        while (pluginRunning) {
            const channelId = channelIds[next++];
            if (!channelId) return;
            // Recover/compact any append-only capture packs left by a previous crash before deciding
            // the newest durable boundary. This prevents a recovered 12k-message pack from being
            // mistaken for an empty archive and fetched from Discord again.
            await Native.compactCapturePacks(channelId).catch(error => {
                console.warn(`[LocalGroupArchive] Capture-pack recovery failed for ${channelId}`, error);
            });
            const bounds = await Native.getChannelArchiveBounds(channelId).catch(() => null);
            startupCatchupBoundaries.set(channelId, typeof bounds?.newestId === "string" ? bounds.newestId : null);
        }
    };
    await Promise.all([worker(), worker()]);
}

function startAutomaticCapture(channelId: string, authoritativeNewAccess = false) {
    if (!pluginRunning || !baselineReady || !autoNewGroups || baselineGroupIds.has(channelId)
        || (!authoritativeNewAccess && !isAutoProtectEligibleNewGroup(channelId))
        || autoCaptureStarted.has(channelId) || !isGroupDm(channelId)) return;
    autoCaptureStarted.add(channelId);
    startupCatchupPending.delete(channelId);
    startupCatchupBoundaries.delete(channelId);
    enabledChannels.add(channelId);

    runBackground("Could not persist automatic capture state", persistEnabledChannels());
    void (async () => {
        try {
            if (!await ensureChannel(channelId, false, true)) return;
            const snapshot = snapshotLoaded(channelId, true)
                .catch(error => {
                    console.warn("[LocalGroupArchive] Auto snapshot failed", error);
                    return { count: 0, saved: 0, attachmentsQueued: 0 };
                });
            const history = archiveFullHistory(channelId);
            await snapshot;
            const result = await history;
            console.info(
                `[LocalGroupArchive] Auto-protected new Group DM: ${result.saved}/${result.messages} message(s) from ${channelId} across ${result.pages} page(s).`
            );
        } catch (error) {
            console.warn("[LocalGroupArchive] Auto history capture failed", error);
        }
    })();
}

function scanForNewGroups() {
    if (!pluginRunning || !baselineReady) return;
    const currentIds = currentGroupIds();
    const current = new Set(currentIds);
    const signature = currentIds.slice().sort(snowflakeCompare).join(",");

    for (const channelId of current) {
        if (enabledChannels.has(channelId) && startupCatchupPending.delete(channelId)) {
            runBackground("Late startup catch-up failed", archiveRecentHistory(channelId));
        }
        if (!knownGroupIds.has(channelId)) {
            knownGroupIds.add(channelId);
            if (wasCreatedBeforeNewGroupCutoff(channelId)) {
                baselineGroupIds.add(channelId);
                runBackground("Could not persist late-hydrated old Group DM", persistBaseline());
            } else if (autoNewGroups) startAutomaticCapture(channelId);
            else {
                baselineGroupIds.add(channelId);
                runBackground("Could not persist ignored new Group DM", persistBaseline());
            }
        }
    }

    // Never forget IDs just because Discord removed the channel from ChannelStore. Keeping the
    // ID is what prevents a kicked group from being mistaken for a brand-new group if it appears
    // again later, and it lets the DM-list ghost row remain stable.
    if (signature !== lastCurrentGroupSignature) {
        lastCurrentGroupSignature = signature;
        ghostListInstance?.forceUpdate?.();
    }
    void syncDeletedChannels();
}

function onConnectionOpen() {
    connectionOpenSeen = true;
    // A reconnect can hide a short Gateway gap in more than one protected DM. Each channel has its
    // own major-parameter bucket, so reconcile two complete mirrors at a time after READY settles.
    if (baselineReady) setTimeout(() => void reconcileWarmMirrorOnce(enabledChannels.size), 1_000);
}

function startAuthoritativeNewAccessCapture(channelId: string, attempt = 0) {
    if (!pluginRunning || !baselineReady) return;

    baselineGroupIds.delete(channelId);
    if (!autoNewGroups) {
        baselineGroupIds.add(channelId);
        runBackground("Could not persist ignored newly-accessible Group DM", persistBaseline());
        return;
    }

    if (isGroupDm(channelId)) {
        startAutomaticCapture(channelId, true);
        return;
    }

    // CHANNEL_RECIPIENT_ADD can arrive a moment before ChannelStore exposes the private channel.
    // Keep this event-authoritative decision alive briefly instead of falling back to the
    // creation-time cutoff and misclassifying an old group that the current user just joined.
    if (attempt < 30) {
        setTimeout(() => startAuthoritativeNewAccessCapture(channelId, attempt + 1), 100);
    }
}

function onChannelCreate(event: any) {
    const channel = event?.channel ?? event;
    const channelId = String(channel?.id ?? "");
    if (!channelId || channel?.type !== GROUP_DM_TYPE) return;

    if (enabledChannels.has(channelId) && startupCatchupPending.delete(channelId)) {
        knownGroupIds.add(channelId);
        runBackground("Late channel-create catch-up failed", archiveRecentHistory(channelId));
        return;
    }
    if (!baselineReady) {
        pendingNewDuringBaseline.add(channelId);
        return;
    }
    if (!knownGroupIds.has(channelId)) {
        // A real post-baseline CHANNEL_CREATE is stronger evidence than lazy ChannelStore hydration:
        // it means this private channel became relevant to the current client now. Protect it even
        // if its snowflake predates installation (for example, being added to an older Group DM).
        knownGroupIds.add(channelId);
        startAuthoritativeNewAccessCapture(channelId);
    }
}

function onChannelRecipientAdd(event: any) {
    const channelId = String(event?.channel_id ?? event?.channelId ?? "");
    const userId = String(event?.user?.id ?? event?.user_id ?? "");
    const currentUserId = String(UserStore.getCurrentUser()?.id ?? "");
    if (!channelId || !userId || userId !== currentUserId) return;

    knownGroupIds.add(channelId);
    baselineGroupIds.delete(channelId);
    if (!baselineReady) {
        pendingNewDuringBaseline.add(channelId);
        return;
    }
    startAuthoritativeNewAccessCapture(channelId);
}

function onChannelRecipientRemove(event: any) {
    const channelId = String(event?.channel_id ?? event?.channelId ?? "");
    const userId = String(event?.user?.id ?? event?.user_id ?? "");
    const currentUserId = String(UserStore.getCurrentUser()?.id ?? "");
    if (!channelId || !userId || userId !== currentUserId || !enabledChannels.has(channelId)) return;

    // User-client Gateway emits this as soon as the current user is removed from a Group DM.
    // Stop new history requests immediately while preserving everything already on disk/queued.
    cancelHistory(channelId);
    autoCaptureStarted.delete(channelId);
    runBackground("Could not refresh ghost metadata", refreshArchivedMetadata());
    queueMicrotask(() => ghostListInstance?.forceUpdate?.());
}

function onChannelDelete(event: any) {
    const channel = event?.channel ?? event;
    const channelId = String(channel?.id ?? event?.channelId ?? event?.channel_id ?? "");
    if (!channelId || !enabledChannels.has(channelId)) return;

    // A kick/leave is a state transition, not archive deletion. Stop Discord history requests,
    // preserve every queued CDN download, and turn the saved group into a read-only ghost row.
    cancelHistory(channelId);
    autoCaptureStarted.delete(channelId);
    runBackground("Could not refresh ghost metadata", refreshArchivedMetadata());
    queueMicrotask(() => ghostListInstance?.forceUpdate?.());
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
        if (!baselineReady) pendingNewDuringBaseline.add(String(channelId));
        else {
            knownGroupIds.add(channelId);
            if (wasCreatedBeforeNewGroupCutoff(String(channelId))) {
                baselineGroupIds.add(String(channelId));
                runBackground("Could not persist late-hydrated old Group DM", persistBaseline());
            } else if (autoNewGroups) startAutomaticCapture(channelId);
            else {
                baselineGroupIds.add(String(channelId));
                runBackground("Could not persist ignored new Group DM", persistBaseline());
            }
        }
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
    const olderJob = olderBackfillJobs.get(channelId);
    if (olderJob) await olderJob.catch(() => { });
    startupCatchupPending.delete(channelId);
    startupCatchupBoundaries.delete(channelId);

    await Native.restoreChannelArchive(channelId);
    ensuredChannels.delete(channelId);
    enabledChannels.add(channelId);
    autoCaptureStarted.add(channelId);
    await persistEnabledChannels();
    return ensureChannel(channelId, true, true);
}

function historySummary(result: HistoryResult) {
    const fetchShape = result.strategy === "hybrid"
        ? `Fetched **${result.messages}** new unique message object(s) and safely wrote **${result.saved}** message object(s) using ${result.pages} normal-history + ${result.searchRequests ?? 0} channel-search + ${result.globalSearchRequests ?? 0} global-DM-search request(s) (${result.searchTabs ?? 0} server tab(s)).`
        : result.strategy === "search-sweep"
            ? `Fetched **${result.messages}**${result.expectedMessages ? ` / ${result.expectedMessages}` : ""} and safely wrote **${result.saved}** message(s) using ${result.pages} normal history request(s) + ${result.searchRequests ?? 0} Search Sweep HTTP request(s) (${result.searchTabs ?? 0} server tab(s)).`
            : `Fetched **${result.messages}** and safely wrote **${result.saved}** message(s) across ${result.pages} page(s).`;
    const parts = [
        fetchShape,
        `${result.attachmentsQueued} new media download(s) queued.`
    ];
    if (result.writeFailures) parts.push(`⚠️ ${result.writeFailures} disk batch(es) failed.`);
    if (result.reachedLimit) parts.push("⚠️ The global 5,000-request safety ceiling was reached; older messages may remain.");
    if (result.partialError) parts.push(`Partial error: ${result.partialError}`);
    if (result.cancelled) parts.push("Capture was interrupted; already-written capture packs were preserved.");
    if (result.strategy === "hybrid" && typeof result.panicMessages === "number") {
        parts.push(`Panic Burst rescued **${result.panicMessages}** unique message object(s) inside its first ${(PANIC_BURST_MS / 1000).toFixed(0)}s window.`);
    }
    if (result.stolenSegments) parts.push(`Authoritative workers took over **${result.stolenSegments}** slow search range(s).`);
    if (result.resumedSegments) parts.push(`Resumed with **${result.resumedSegments}** already-proven range(s), without refetching them.`);
    if (result.repairedSegments) parts.push(`Authoritatively repaired only **${result.repairedSegments}** unproven range(s).`);
    if (typeof result.elapsedMs === "number") {
        const strategy = result.strategy === "hybrid"
            ? `Smart Hybrid, ${result.anchors ?? 0} real anchor(s), peak ${result.peakLanes ?? 1} route lane(s)`
            : result.strategy === "search-sweep"
                ? `Search Sweep, 5×25 messages per search HTTP, peak ${result.peakLanes ?? SEARCH_SWEEP_CONCURRENCY} request worker(s)`
                : result.strategy === "anchored"
                    ? `Anchored Burst repair, ${result.anchors ?? 0} anchor(s), peak ${result.peakLanes ?? 1} lane(s)`
                    : "single-cursor fallback";
        const anchorInfo = result.anchorQueries ? `, ${result.anchorQueries} search-anchor request(s)` : "";
        const avg = result.averageRequestMs ? `, avg request wait ${(result.averageRequestMs / 1000).toFixed(2)}s` : "";
        parts.push(`Network + durable capture: **${(result.elapsedMs / 1000).toFixed(2)}s** (${strategy}${anchorInfo}${avg}).`);
    }
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

function archivedGroupName(meta: any, channelId: string) {
    if (meta?.name) return String(meta.name);
    const names = Array.isArray(meta?.recipients)
        ? meta.recipients.map((user: any) => user?.globalName ?? user?.global_name ?? user?.username).filter(Boolean)
        : [];
    return names.join(", ") || `Archived Group ${channelId}`;
}

export default definePlugin({
    name: "LocalGroupArchive",
    description: "Fast local Group DM archiver with automatic new-group capture, attachments, and a Discord-style HTML viewer.",
    authors: [{ name: "Faisal", id: 0n }],
    tags: ["Chat", "Utility"],

    // Userplugins are loaded after stock plugins by Vencord's globPlugins build step. The two
    // property-value patches below deliberately accept PinDMs' already-transformed expressions,
    // so enabling PinDMs does not make either plugin steal the DM list seam from the other.
    patches: [
        {
            find: '"dm-quick-launcher"===',
            replacement: [
                {
                    // Original: privateChannelIds:x
                    // PinDMs:  privateChannelIds:x.filter(...)
                    // Wrap either expression instead of assuming a bare identifier.
                    match: /privateChannelIds:([^,]+)(?=,listRef:)/,
                    replace: "privateChannelIds:$self.injectGhostIds($1)"
                },
                {
                    // PinDMs leaves the original sections:[...] inside its makeProps wrapper, so
                    // extending that value composes with both enabled and disabled PinDMs states.
                    match: /sections:(\[.+?1\)\])/,
                    replace: "sections:$self.extendDmSections($1)"
                },
                {
                    match: /renderRow(?:",|=)(\i)=>{/,
                    replace: "$&$self.registerDmInstance(this);const __lgaGhost=$self.renderGhostRow(this,$1);if(__lgaGhost)return __lgaGhost;"
                }
            ]
        }
    ],

    registerDmInstance(instance: any) {
        ghostListInstance = instance;
    },

    injectGhostIds(ids: string[]) {
        const original = Array.isArray(ids) ? ids : [];
        const ghosts = ghostChannelIds().filter(id => !original.includes(id));
        return ghosts.length ? [...ghosts, ...original] : original;
    },

    extendDmSections(sections: number[]) {
        const original = Array.isArray(sections) ? sections : [];
        const ghosts = ghostChannelIds().length;
        if (!ghosts || original.length === 0) return original;
        const next = original.slice();
        const last = next.length - 1;
        next[last] = Number(next[last] ?? 0) + ghosts;
        return next;
    },

    renderGhostRow(instance: any, row: any) {
        if (!row || Number(row.section) === 0) return null;
        const sections = instance?.props?.sections;
        // PinDMs inserts its own sections before the ordinary DM section. Ghosts belong only to
        // the final ordinary-DM section; never intercept a PinDMs category row.
        if (Array.isArray(sections) && Number(row.section) !== sections.length - 1) return null;
        const ids = this.injectGhostIds(instance?.props?.privateChannelIds ?? []);
        const channelId = ids[Number(row.row)];
        if (!channelId || !ghostChannelIds().includes(channelId)) return null;
        const meta = archivedMetadata.get(channelId) ?? {};
        const name = archivedGroupName(meta, channelId);
        const initial = String.fromCodePoint(String(name).codePointAt(0) ?? 35);

        return React.createElement(Clickable as any, {
            role: "button",
            title: `${name} • local read-only archive`,
            onClick: () => runBackground("Could not open removed Group DM archive", Native.openArchiveViewerForChannel(channelId, true)),
            style: {
                height: 44,
                margin: "1px 8px",
                padding: "0 8px",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 10,
                color: "var(--text-muted, #b5bac1)",
                cursor: "pointer"
            }
        },
        React.createElement("div", {
            style: {
                width: 32, height: 32, borderRadius: "50%", display: "grid", placeItems: "center",
                flex: "0 0 auto", background: "#5865f2", color: "white", fontWeight: 800
            }
        }, initial),
        React.createElement("div", { style: { minWidth: 0, flex: 1 } },
            React.createElement("div", {
                style: { overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 600 }
            }, name),
            React.createElement("div", {
                style: { fontSize: 10, color: "#f08c8f", marginTop: 1 }
            }, "ARCHIVED • no longer a member")
        ));
    },

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
                        commandChoice("INSTANT rescue + keep archiving (recommended)", "start"),
                        commandChoice("ULTRA FULL history capture (Smart Hybrid one-shot)", "full"),
                        commandChoice("Snapshot currently loaded messages", "snapshot"),
                        commandChoice("Wait for attachment downloads", "wait"),
                        commandChoice("Auto-protect NEW Group DMs: ON", "auto-on"),
                        commandChoice("Auto-protect NEW Group DMs: OFF", "auto-off"),
                        commandChoice("Open Discord-style HTML viewer", "viewer"),
                        commandChoice("Open archive folder", "folder"),
                        commandChoice("Check archive health + storage", "health"),
                        commandChoice("Repair viewer + stale temp files", "repair"),
                        commandChoice("Run interactive setup guide", "guide"),
                        commandChoice("Reset NEW-group baseline to current groups", "baseline-reset"),
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
                    const prepared = await Native.prepareViewer();
                    await Native.openArchiveViewer();
                    sendBotMessage(channelId, {
                        content: `Opened LocalGroupArchive **v${PLUGIN_VERSION}** viewer. Detected **${prepared.channels}** archived group(s) in \`${prepared.archiveRoot}\`.`
                    });
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
                    sendBotMessage(channelId, { content: "**NEW-group shield is ON.** Only Group DMs whose channel IDs were actually created after the saved cutoff are auto-protected. Old/closed groups stay untouched even if Discord only reveals them later." });
                    return;
                }

                if (action === "auto-off") {
                    autoNewGroups = false;
                    await persistAutoSetting();
                    sendBotMessage(channelId, { content: "**NEW-group shield is OFF.** Already-protected groups keep archiving; no untouched group will be enabled automatically." });
                    return;
                }

                if (action === "baseline-reset") {
                    await resetBaselineToCurrentGroups();
                    sendBotMessage(channelId, { content: `Baseline reset at **${new Date(baselineCutoffMs).toLocaleString()}**. Any Group DM created before this cutoff is now old/ignored, including old groups Discord reveals later. Existing local files were not deleted.` });
                    return;
                }

                if (!isGroupDm(channelId)) {
                    sendBotMessage(channelId, { content: "This action only works in **Group DMs**." });
                    return;
                }

                if (action === "start") {
                    await restoreAndEnable(channelId);

                    const [bounds, complete, storedCoverage] = await Promise.all([
                        Native.getChannelArchiveBounds(channelId).catch(() => ({ count: 0, oldestId: null, newestId: null })),
                        Native.isHistoryComplete(channelId).catch(() => false),
                        Native.getCaptureCoverage(channelId).catch(() => null)
                    ]);
                    const hasLocalArchive = Number(bounds?.count ?? 0) > 0 && typeof bounds?.newestId === "string";
                    const historyReady = Boolean(complete) && hasLocalArchive;
                    const resumableHybrid = !historyReady && isHybridCoverageLedger(storedCoverage, channelId);
                    sendBotMessage(channelId, {
                        content: historyReady
                            ? "⚡ **Instant rescue started.** The local history baseline is complete, so only the newest delta is requested while Discord's currently-loaded cache is snapshotted immediately."
                            : resumableHybrid
                                ? "⚡ **Smart Hybrid resume started.** Completed history ranges stay completed; only the interrupted ranges and the newest delta are requested again."
                            : hasLocalArchive
                                ? "⚡ **Partial-archive rescue started.** New messages are rescued immediately while the missing oldest tail is verified/backfilled independently."
                                : "🚨 **Cold Smart Hybrid Panic Burst started.** For the first 5 seconds LocalGroupArchive snapshots Discord cache, opens six normal lanes plus two workers on each search route, and defers proof checkpoints so rescue never waits on bookkeeping. After the burst, idle normal workers take over slow search ranges and exact verification repairs only what remains unproven. All media traffic waits until critical text capture stops."
                    });

                    try {
                        // Snapshot the renderer cache immediately. This protects messages already in
                        // Discord's local store even if REST access disappears a moment later. In a
                        // warm archive, recent-history catch-up usually stops after one REST page.
                        const snapshotPromise = snapshotLoaded(channelId, true).catch(error => {
                            console.warn("[LocalGroupArchive] Emergency snapshot failed", error);
                            return { count: 0, saved: 0, attachmentsQueued: 0 };
                        });
                        const historyPromise = historyReady
                            ? archiveRecentHistory(channelId)
                            : resumableHybrid
                                ? archiveFullHistory(channelId)
                            : hasLocalArchive
                                ? Promise.all([archiveRecentHistory(channelId), archiveOlderHistory(channelId)]).then(parts => mergeHistoryResults(...parts))
                                : archiveFullHistory(channelId);
                        const [snapshot, result] = await Promise.all([snapshotPromise, historyPromise]);
                        const nowReady = await Native.isHistoryComplete(channelId).catch(() => false);
                        sendBotMessage(channelId, {
                            content: `${historyReady ? "⚡ Delta rescue" : resumableHybrid ? "⚡ Smart Hybrid resume" : hasLocalArchive ? "⚡ Partial-archive rescue" : "🚀 Cold Smart Hybrid rescue"}: snapshotted **${snapshot.saved}** loaded message(s). ${historySummary(result)} History baseline: **${nowReady ? "READY ⚡" : "still capturing"}**. New messages keep archiving automatically.`
                        });
                    } catch (error: any) {
                        console.error("[LocalGroupArchive] Rescue failed", error);
                        sendBotMessage(channelId, {
                            content: `Archive is still **ON**, but rescue hit an error: ${formatArchiveError(error)}`
                        });
                    }
                    return;
                }

                if (action === "full") {
                    // FULL is a benchmark/one-shot operation. Do not silently opt an old group into
                    // persistent background archiving just because the user wanted to measure a scan.
                    const wasEnabled = enabledChannels.has(channelId);
                    if (!wasEnabled) enabledChannels.add(channelId);
                    cancelHistory(channelId);
                    await Promise.all([
                        historyJobs.get(channelId),
                        catchupJobs.get(channelId),
                        olderBackfillJobs.get(channelId)
                    ].filter((job): job is Promise<HistoryResult> => Boolean(job)).map(job => job.catch(() => { })));
                    await Native.restoreChannelArchive(channelId);
                    ensuredChannels.delete(channelId);
                    if (!await ensureChannel(channelId, true, true)) return;

                    sendBotMessage(channelId, { content: `🚨 **ULTRA FULL one-shot capture started (v${PLUGIN_VERSION} Panic Burst).** This run does not permanently enable background archiving for an old group. The first 5 seconds front-load six normal lanes and two workers per independent search route; repeated slow completions cannot collapse concurrency, and proof checkpoints wait until after the rescue burst. Idle normal workers then take over slow search ranges. Exact channel-scoped totals and targeted authoritative repair still prove completeness, interrupted runs still resume from the durable coverage ledger, and media remains frozen until critical text capture stops. Progress appears about every 5 seconds.` });
                    try {
                        const result = await archiveFullHistory(channelId);
                        sendBotMessage(channelId, {
                            content: `${historySummary(result)} Persistent archive state: **${wasEnabled ? "ON" : "OFF"}**.`
                        });
                    } catch (error: any) {
                        sendBotMessage(channelId, { content: `Full-history scan failed: ${formatArchiveError(error)}` });
                    } finally {
                        if (!wasEnabled) {
                            // Keep the ephemeral in-memory permission until media already captured
                            // by this one-shot run has drained. It was never persisted, so a restart
                            // still leaves the group OFF. Do not cancel the user's queued media.
                            runBackground("Could not finish one-shot cleanup", (async () => {
                                await waitForAttachmentQueue();
                                enabledChannels.delete(channelId);
                                autoCaptureStarted.delete(channelId);
                                startupCatchupPending.delete(channelId);
                                startupCatchupBoundaries.delete(channelId);
                                await persistEnabledChannels();
                            })());
                        }
                    }
                    return;
                }

                if (action === "snapshot") {
                    await restoreAndEnable(channelId);
                    const result = await snapshotLoaded(channelId);
                    queueChannelAssets(channelId, buildChannelMeta(channelId));
                    sendBotMessage(channelId, { content: `Snapshot read **${result.count}** and wrote **${result.saved}** currently loaded message(s); ${result.attachmentsQueued} message-media download(s) queued. Group/avatar assets were queued too.` });
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
                    : catchupJobs.has(channelId) ? " A startup catch-up scan is currently running."
                        : olderBackfillJobs.has(channelId) ? " An older-tail verification/backfill is currently running." : "";
                const historyReady = await Native.isHistoryComplete(channelId).catch(() => false);
                sendBotMessage(channelId, {
                    content: `LocalGroupArchive **v${PLUGIN_VERSION}**\n${enabledChannels.has(channelId) ? "Archive status: **ON**." : "Archive status: **OFF**."}${running}\nNEW-group shield: **${autoNewGroups ? "ON" : "OFF"}**. Warm Mirror: **live Gateway + ${WARM_MIRROR_RECONCILE_MS / 1000}s round-robin delta**. Cutoff: **${baselineCutoffMs ? new Date(baselineCutoffMs).toLocaleString() : "not set"}**. Known old/ignored: **${baselineGroupIds.size}**. This group's history: **${historyReady ? "READY ⚡" : "PARTIAL/COLD"}**.\nMedia workers: ${activeAttachmentJobs} active, ${attachmentQueue.length} queued, ${attachmentCompleted} completed, ${attachmentFailed} failed this session.`
                });
            }
        }
    ],

    async start() {
        pluginRunning = true;
        pluginStartedAt = Date.now();
        connectionOpenSeen = false;
        // Subscribe before the first await so a fast Discord READY/CONNECTION_OPEN cannot slip
        // past the new-group baseline readiness gate while DataStore/native state is loading.
        FluxDispatcher.subscribe("CONNECTION_OPEN", onConnectionOpen);
        baselineReady = false;
        pendingNewDuringBaseline.clear();
        autoCaptureStarted.clear();

        const [stored, storedAuto, storedBaseline, storedCutoff, deletedIds] = await Promise.all([
            DataStore.get<string[]>(STORE_KEY).catch(() => []),
            DataStore.get<boolean>(AUTO_KEY).catch(() => true),
            DataStore.get<string[]>(BASELINE_KEY).catch(() => undefined),
            DataStore.get<number>(BASELINE_CUTOFF_KEY).catch(() => undefined),
            Native.getDeletedChannelIds().catch(() => [])
        ]);
        const storedChannels = Array.isArray(stored) ? stored : [];
        const deletedChannelIds = new Set(Array.isArray(deletedIds) ? deletedIds : []);
        enabledChannels = new Set(storedChannels.filter(id => !deletedChannelIds.has(id)));
        autoNewGroups = typeof storedAuto === "boolean" ? storedAuto : true;
        // v0.7.2 used "first time seen in ChannelStore" as a proxy for new, which is wrong for
        // old/closed DMs that Discord hydrates lazily. v0.7.2 persists a creation-time cutoff and
        // compares it against the channel snowflake, so an old group cannot auto-start later.
        baselineCutoffMs = typeof storedCutoff === "number" && Number.isFinite(storedCutoff) && storedCutoff > 0
            ? storedCutoff
            : pluginStartedAt;
        if (!(typeof storedCutoff === "number" && Number.isFinite(storedCutoff) && storedCutoff > 0)) {
            await persistBaselineCutoff();
        }

        startupCatchupPending.clear();
        startupCatchupBoundaries.clear();
        for (const channelId of enabledChannels) startupCatchupPending.add(channelId);
        if (enabledChannels.size !== storedChannels.length) {
            await persistEnabledChannels();
        }

        // Subscribe before baseline settling so a truly new Group DM cannot slip through the
        // startup window. Replayed old-channel events are filtered later by the channel snowflake.
        FluxDispatcher.subscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.subscribe("CHANNEL_RECIPIENT_ADD", onChannelRecipientAdd);
        FluxDispatcher.subscribe("CHANNEL_RECIPIENT_REMOVE", onChannelRecipientRemove);
        FluxDispatcher.subscribe("CHANNEL_DELETE", onChannelDelete);
        FluxDispatcher.subscribe("CHANNEL_UPDATE", onChannelUpdate);
        FluxDispatcher.subscribe("MESSAGE_CREATE", onMessageCreate);
        FluxDispatcher.subscribe("MESSAGE_UPDATE", onMessageUpdate);
        FluxDispatcher.subscribe("MESSAGE_DELETE", onMessageDelete);
        FluxDispatcher.subscribe("MESSAGE_DELETE_BULK", onMessageDeleteBulk);
        FluxDispatcher.subscribe("MESSAGE_REACTION_ADD", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE_ALL", onMessageStateChange);
        FluxDispatcher.subscribe("MESSAGE_REACTION_REMOVE_EMOJI", onMessageStateChange);

        await initializeNewGroupBaseline(storedBaseline);
        await processPendingNewGroupsAfterBaseline();

        // Only v0.7-protected/manual archives remain enabled at this point. Existing groups from
        // the first v0.7 baseline were deliberately removed from v0.6's all-groups mirror state.
        await captureStartupBoundaries();
        knownGroupIds = new Set([...knownGroupIds, ...baselineGroupIds, ...enabledChannels]);
        lastCurrentGroupSignature = currentGroupIds().slice().sort(snowflakeCompare).join(",");

        runBackground("Viewer preparation failed", Native.prepareViewer());
        runBackground("Could not load archived metadata", refreshArchivedMetadata());

        scanForNewGroups();
        autoScanTimer = setInterval(scanForNewGroups, AUTO_SCAN_INTERVAL_MS);
        warmMirrorTimer = setInterval(() => void reconcileWarmMirrorOnce(), WARM_MIRROR_RECONCILE_MS);
        catchupTimer = setTimeout(() => {
            catchupTimer = null;
            void resumeEnabledArchives().finally(() => void reconcileWarmMirrorOnce());
            scanForNewGroups();
        }, 800);
    },

    stop() {
        pluginRunning = false;
        FluxDispatcher.unsubscribe("CONNECTION_OPEN", onConnectionOpen);
        FluxDispatcher.unsubscribe("CHANNEL_CREATE", onChannelCreate);
        FluxDispatcher.unsubscribe("CHANNEL_RECIPIENT_ADD", onChannelRecipientAdd);
        FluxDispatcher.unsubscribe("CHANNEL_RECIPIENT_REMOVE", onChannelRecipientRemove);
        FluxDispatcher.unsubscribe("CHANNEL_DELETE", onChannelDelete);
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
        if (warmMirrorTimer) clearInterval(warmMirrorTimer);
        warmMirrorTimer = null;
        warmMirrorReconcileRunning = false;
        for (const channelId of enabledChannels) cancelHistory(channelId);
        startupCatchupPending.clear();
        startupCatchupBoundaries.clear();
        cancelQueuedAttachments();
        runBackground("Could not cancel downloads during shutdown", Native.cancelAllDownloads());
        runBackground("Could not close the local viewer API", Native.shutdownViewerApi());
        baselineReady = false;
        connectionOpenSeen = false;
        pendingNewDuringBaseline.clear();
        ghostListInstance = null;
    }
});
