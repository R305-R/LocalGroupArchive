/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

export interface HistorySegment {
    /** Fetch messages strictly older than this ID. Undefined means start at newest. */
    upperExclusive?: string;
    /** Stop once the page reaches this ID or anything older. The anchor itself is saved separately. */
    lowerExclusive?: string;
}

export type HybridHistoryPlane = "normal" | "channel-search" | "global-search";

export interface HybridHistorySegment extends HistorySegment {
    plane: HybridHistoryPlane;
}

function compareIds(a: string, b: string) {
    const left = BigInt(a);
    const right = BigInt(b);
    return left < right ? -1 : left > right ? 1 : 0;
}

/**
 * Real message IDs partition history without speculative timestamp boundaries. Authoritative
 * walkers can use every range directly, while Smart Hybrid may assign bounded middle ranges to
 * exact-count search planes and retain normal history for the two edges and targeted repair.
 */
export function normalizeAnchorIds(ids: string[]) {
    return [...new Set(ids.filter(Boolean))].sort((a, b) => compareIds(b, a));
}

export function buildHistorySegments(anchorIds: string[]): HistorySegment[] {
    const anchors = normalizeAnchorIds(anchorIds);
    const segments: HistorySegment[] = [];
    let upperExclusive: string | undefined;

    for (const anchor of anchors) {
        segments.push({ upperExclusive, lowerExclusive: anchor });
        upperExclusive = anchor;
    }
    segments.push({ upperExclusive });
    return segments;
}

/**
 * Assign independent Discord data planes to real-ID ranges. The two edge ranges stay
 * authoritative: the newest range preserves complete message shape, and the oldest unbounded
 * range is the only route that can prove the true beginning without trusting search indexing.
 */
export function buildHybridHistorySegments(
    firstOldest: string,
    anchorIds: string[],
    channelSearchAvailable: boolean,
    globalSearchAvailable: boolean
): HybridHistorySegment[] {
    const segments = buildHistorySegments(anchorIds);
    segments[0].upperExclusive = firstOldest;
    const cycle: HybridHistoryPlane[] = channelSearchAvailable
        ? globalSearchAvailable
            ? ["channel-search", "global-search", "normal"]
            : ["channel-search", "normal"]
        : ["normal"];

    return segments.map((segment, index) => ({
        ...segment,
        plane: index === 0 || index === segments.length - 1
            ? "normal"
            : cycle[(index - 1) % cycle.length]
    }));
}

export function selectPageForSegment<T>(
    page: T[],
    segment: HistorySegment,
    getId: (item: T) => string
) {
    return page.filter(item => {
        const id = getId(item);
        if (!id) return false;
        if (segment.upperExclusive && compareIds(id, segment.upperExclusive) >= 0) return false;
        if (segment.lowerExclusive && compareIds(id, segment.lowerExclusive) <= 0) return false;
        return true;
    });
}

export function oldestPageId<T>(page: T[], getId: (item: T) => string) {
    let oldest: string | undefined;
    for (const item of page) {
        const id = getId(item);
        if (!id) continue;
        if (!oldest || compareIds(id, oldest) < 0) oldest = id;
    }
    return oldest;
}

export function newestPageId<T>(page: T[], getId: (item: T) => string) {
    let newest: string | undefined;
    for (const item of page) {
        const id = getId(item);
        if (!id) continue;
        if (!newest || compareIds(id, newest) > 0) newest = id;
    }
    return newest;
}

export function segmentBoundaryReached<T>(
    page: T[],
    segment: HistorySegment,
    getId: (item: T) => string
) {
    if (!segment.lowerExclusive) return false;
    const oldest = oldestPageId(page, getId);
    return Boolean(oldest && compareIds(oldest, segment.lowerExclusive) <= 0);
}
