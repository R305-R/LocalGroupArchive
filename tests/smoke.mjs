import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const files = [
    "plugin/LocalGroupArchive/index.ts",
    "plugin/LocalGroupArchive/native.ts",
    "plugin/LocalGroupArchive/historyPlanner.ts",
    "plugin/LocalGroupArchive/viewer.ts",
    "plugin/LocalGroupArchiveSetup/index.ts"
];

for (const relative of files) {
    const source = fs.readFileSync(new URL(relative, root), "utf8");
    const javascript = stripTypeScriptTypes(source, { mode: "transform" });
    new vm.SourceTextModule(javascript);
}

let viewerSource = fs.readFileSync(new URL("plugin/LocalGroupArchive/viewer.ts", root), "utf8");
viewerSource = stripTypeScriptTypes(viewerSource, { mode: "transform" })
    .replace("export function buildViewerHtml", "function buildViewerHtml");
const buildViewerHtml = vm.runInNewContext(`${viewerSource};buildViewerHtml`);
const html = buildViewerHtml(["123456789012345678"], null, 32123, "test-token", { "123456789012345678": { channelId: "123456789012345678", name: "Smoke Group" } }, "C:/Archive");
let inlineScripts = 0;
for (const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1]);
    inlineScripts++;
}

assert.equal(inlineScripts, 2, "expected the boot and application scripts");
assert.equal(html.includes("\u0000"), false, "viewer must not contain raw NUL bytes");
assert.equal(html.includes("\u001f"), false, "viewer must not contain raw unit-separator bytes");
assert.match(html, /MAX_DOM=300/);
assert.match(html, /SHIFT=100/);
assert.match(html, /_assets\/avatars/);
assert.match(html, /_assets\/group-icons/);
assert.match(html, /نتائج البحث/);
assert.match(html, /تصدير JSON/);
assert.match(html, /function rebuildCaches/);
assert.match(html, /Smoke Group/);
assert.match(html, /\/bootstrap/);
assert.match(html, /LOCAL • v0\.9\.2/);
assert.match(html, /C:\/Archive/);
assert.match(html, /hydrateFromNative/);
assert.match(html, /REQUESTED_CHANNEL/);
assert.match(html, /You are no longer a member of this group/);
assert.match(html, /function runChunk/);

const native = fs.readFileSync(new URL("plugin/LocalGroupArchive/native.ts", root), "utf8");
assert.match(native, /BigInt\(a\)/);
assert.match(native, /writeFileAtomic/);
assert.match(native, /fetchWithValidatedRedirects/);
assert.match(native, /getChannelArchiveBounds/);
assert.match(native, /historyCompletePath/);
assert.match(native, /markHistoryComplete/);
assert.match(native, /isHistoryComplete/);
assert.match(native, /viewerDirtyPath/);
assert.match(native, /viewerDataJsonPath/);
assert.match(native, /getViewerBootstrapInternal/);
assert.match(native, /readViewerMetadataMap/);
assert.match(native, /"\/bootstrap"/);
assert.match(native, /Never make the group list wait/);
assert.match(native, /await rebuildViewerShell\(\);[\s\S]*Phase 2 is background-only/);
assert.match(native, /await prepareViewer\(event\);/);
assert.match(native, /archiveRootCandidates/);
assert.match(native, /OneDriveConsumer/);
assert.match(native, /serveArchiveFile/);
assert.match(native, /route === "\/viewer"/);
assert.match(native, /shell\.openExternal\(viewerHttpUrl/);
assert.match(native, /createReadStream/);
assert.match(native, /Content-Range/);
assert.match(native, /appendCaptureBatch/);
assert.match(native, /history\.ndjson/);
assert.match(native, /captureCoveragePath/);
assert.match(native, /getCaptureCoverage/);
assert.match(native, /saveCaptureCoverage/);
assert.match(native, /clearCaptureCoverage/);
assert.match(native, /coverage\.frozenNewest/);
assert.match(native, /Invalid capture coverage ledger/);
assert.match(native, /compactCapturePacksInternal/);
assert.match(native, /createInterface/);
assert.match(native, /openArchiveViewerForChannel/);
assert.match(native, /getArchivedChannelMetadata/);
assert.match(native, /hasPendingCapturePacks/);
assert.match(native, /if \(pendingCapture\) await compactCapturePacksInternal\(channelId\)/);
assert.match(native, /Recover NDJSON rescue packs before indexing/);

const mainPlugin = fs.readFileSync(new URL("plugin/LocalGroupArchive/index.ts", root), "utf8");
assert.match(mainPlugin, /startupCatchupPending/);
assert.match(mainPlugin, /captureStartupBoundaries/);
assert.match(mainPlugin, /archiveRecentHistory/);
assert.match(mainPlugin, /MAX_RENDERER_BATCH_BYTES/);

assert.match(mainPlugin, /BASELINE_KEY/);
assert.match(mainPlugin, /initializeNewGroupBaseline/);
assert.match(mainPlugin, /processPendingNewGroupsAfterBaseline/);
assert.match(mainPlugin, /Auto-protect NEW Group DMs/);
assert.match(mainPlugin, /let autoNewGroups = true/);
assert.match(mainPlugin, /DataStore\.get<boolean>\(AUTO_KEY\)\.catch\(\(\) => true\)/);
assert.match(mainPlugin, /NEW-group shield: \*\*\$\{autoNewGroups \? "ON" : "OFF"\}\*\*/);
assert.match(mainPlugin, /baselineGroupIds\.has\(channelId\)/);
assert.match(mainPlugin, /BASELINE_CUTOFF_KEY/);
assert.match(mainPlugin, /wasCreatedBeforeNewGroupCutoff/);
assert.match(mainPlugin, /isAutoProtectEligibleNewGroup/);
assert.match(mainPlugin, /snowflakeTimestamp\(channelId\) >= baselineCutoffMs/);
assert.match(mainPlugin, /CONNECTION_OPEN/);
assert.match(mainPlugin, /ULTRA FULL one-shot capture started \(v\$\{PLUGIN_VERSION\} Panic Burst\)/);
assert.match(mainPlugin, /discoverHistoryAnchors/);
assert.match(mainPlugin, /messages\/search\/tabs/);
assert.match(mainPlugin, /HISTORY_RECOVERY_CONCURRENCY = 2/);
assert.match(mainPlugin, /SEARCH_SWEEP_TAB_LIMIT = 25/);
assert.match(mainPlugin, /PANIC_BURST_MS = 5_000/);
assert.match(mainPlugin, /PANIC_SEARCH_WORKERS_PER_ROUTE = 2/);
assert.match(mainPlugin, /HYBRID_NORMAL_INITIAL_CONCURRENCY = 6/);
assert.match(mainPlugin, /HYBRID_NORMAL_MIN_CONCURRENCY = 2/);
assert.match(mainPlugin, /HYBRID_NORMAL_MAX_CONCURRENCY = 6/);
assert.match(mainPlugin, /HYBRID_BACKOFF_COOLDOWN_MS = 2_000/);
assert.match(mainPlugin, /class AdaptiveRequestGate/);
assert.match(mainPlugin, /now - this\.lastDecreaseAt >= HYBRID_BACKOFF_COOLDOWN_MS/);
assert.match(mainPlugin, /claimSearchLaneForNormal/);
assert.match(mainPlugin, /normalClaimed/);
assert.match(mainPlugin, /flushDeferredAuthoritativeCompletions/);
assert.match(mainPlugin, /archiveFullHistoryHybridInner/);
assert.match(mainPlugin, /\/users\/@me\/messages\/search\/tabs/);
assert.match(mainPlugin, /track_exact_total_hits: true/);
assert.match(mainPlugin, /repairMap/);
assert.match(mainPlugin, /markSegmentComplete/);
assert.match(mainPlugin, /captureWritesAreDurable/);
assert.match(mainPlugin, /resumedSegments/);
assert.match(mainPlugin, /resume-gap-/);
assert.match(mainPlugin, /WARM_MIRROR_RECONCILE_MS = 45_000/);
assert.match(mainPlugin, /reconcileWarmMirrorOnce/);
assert.match(mainPlugin, /holdCriticalAttachmentPump/);
assert.match(mainPlugin, /Smart Hybrid failed before it could finish/);
assert.match(mainPlugin, /CHANNEL_RECIPIENT_ADD/);
assert.match(mainPlugin, /CHANNEL_RECIPIENT_REMOVE/);
assert.match(mainPlugin, /runAnchorProbe/);
assert.match(mainPlugin, /failedCursors/);
assert.match(mainPlugin, /Full capture progress/);
assert.doesNotMatch(mainPlugin, /runAdaptiveSnowflakeScan/);
assert.doesNotMatch(mainPlugin, /accelerateVoiceSearch/);
assert.match(mainPlugin, /storeLooksReady = connectionOpenSeen \|\| latest\.totalPrivateChannels > 0/);
assert.match(mainPlugin, /injectGhostIds/);
assert.match(mainPlugin, /extendDmSections/);
assert.match(mainPlugin, /renderGhostRow/);
assert.match(mainPlugin, /CHANNEL_DELETE/);
assert.match(mainPlugin, /INSTANT rescue/);
assert.match(mainPlugin, /snapshotLoaded\(channelId, true\)/);
assert.match(mainPlugin, /queueChannelAssets\(channelId, buildChannelMeta\(channelId\)\)/);
assert.match(mainPlugin, /archiveOlderHistory/);

// Exercise the Panic Burst/congestion-epoch controller itself. Several completions from one slow
// wave must cost at most one slot, the first five seconds must remain at six, and steady mode must
// retain two authoritative workers.
const gateStart = mainPlugin.indexOf("class AdaptiveRequestGate");
const gateEnd = mainPlugin.indexOf("\nfunction isHybridCoverageLedger", gateStart);
assert.ok(gateStart >= 0 && gateEnd > gateStart, "AdaptiveRequestGate source should be extractable");
const gateSource = stripTypeScriptTypes(mainPlugin.slice(gateStart, gateEnd), { mode: "transform" });
const gateClock = { now: 0 };
const Gate = vm.runInNewContext(`${gateSource};AdaptiveRequestGate`, {
    performance: { now: () => gateClock.now },
    HYBRID_SLOW_REQUEST_MS: 1800,
    HYBRID_FAST_REQUEST_MS: 1100,
    HYBRID_BACKOFF_COOLDOWN_MS: 2000
});
const gate = new Gate(6, 6, 2, 5000);
gateClock.now = 4999;
gate.tune(9000, false);
assert.equal(gate.concurrency, 6, "Panic Burst must not locally collapse concurrency");
gateClock.now = 5001;
gate.tune(2000, true);
assert.equal(gate.concurrency, 5);
gate.tune(2000, true);
gate.tune(2000, false);
assert.equal(gate.concurrency, 5, "one congestion wave may decrease only once");
for (const now of [7001, 9001, 11001, 13001, 15001]) {
    gateClock.now = now;
    gate.tune(2000, true);
}
assert.equal(gate.concurrency, 2, "steady mode must retain its two-worker floor");
gateClock.now = 16000;
for (let index = 0; index < 4; index++) gate.tune(500, true);
assert.equal(gate.concurrency, 3, "four fast samples should recover one slot");

assert.match(native, /DOWNLOAD_TIMEOUT_MS/);
assert.doesNotMatch(native, /Access-Control-Allow-Origin", "\*"/);
assert.match(native, /revisionSignature/);

const renderer = fs.readFileSync(new URL("plugin/LocalGroupArchive/index.ts", root), "utf8");
assert.match(renderer, /ATTACHMENT_RETRIES/);
assert.match(renderer, /cancelAllDownloads/);
assert.match(renderer, /ATTACHMENT_CONCURRENCY = 64/);
assert.match(renderer, /NORMAL_ATTACHMENT_CONCURRENCY = 24/);
assert.match(renderer, /holdAttachmentPump/);
assert.match(renderer, /releaseAttachmentPump/);
assert.match(renderer, /queueAttachmentsFromRecords/);
assert.match(renderer, /queuePriorityVoiceFromMessages/);
assert.match(renderer, /isPriorityVoiceAttachment/);
assert.match(renderer, /priority: "voice" \| "normal"/);
assert.match(renderer, /attachmentQueue\.findIndex\(job => job\.priority === "voice"\)/);
assert.match(renderer, /queueAttachmentsFromRecords\(stage\.records, true\)/);
assert.match(renderer, /holdAttachmentPump\(\);[\s\S]*try \{/);
assert.match(renderer, /finally \{[\s\S]*releaseAttachmentPump\(\);/);
assert.match(renderer, /deferMedia/);
assert.match(renderer, /deferViewer/);
assert.match(renderer, /Could not compact capture packs/);
assert.match(native, /MESSAGE_WRITE_CONCURRENCY = 64/);
assert.match(native, /withMessageWriteSlot/);
assert.match(native, /appendViewer = true/);
assert.match(native, /getKnownMessageIds/);
assert.match(native, /getDeletionTimestampCache/);


// Exercise the real-ID anchored planner. Unlike v0.7.0's speculative Snowflake-time shards, every
// boundary is an actual message ID. The resulting segments must be strictly non-overlapping and
// together cover the full history exactly once.
let plannerSource = fs.readFileSync(new URL("plugin/LocalGroupArchive/historyPlanner.ts", root), "utf8");
plannerSource = stripTypeScriptTypes(plannerSource, { mode: "transform" })
    .replace(/export\s+/g, "");
const plannerContext = { BigInt, Set };
vm.runInNewContext(`${plannerSource};globalThis.__planner={normalizeAnchorIds,buildHistorySegments,buildHybridHistorySegments,selectPageForSegment,newestPageId,oldestPageId,segmentBoundaryReached};`, plannerContext);
const { normalizeAnchorIds, buildHistorySegments, buildHybridHistorySegments, selectPageForSegment, newestPageId, oldestPageId, segmentBoundaryReached } = plannerContext.__planner;

const ids = Array.from({ length: 12872 }, (_, index) => (1000000000000000000n + BigInt(index + 1)).toString())
    .sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1);
const anchors = [ids[1999], ids[3999], ids[5999], ids[7999], ids[9974], ids[11974]];
assert.equal(newestPageId(ids.slice(0, 100).map(id => ({ id })), item => item.id), ids[0]);
assert.deepEqual(Array.from(normalizeAnchorIds([anchors[2], anchors[0], anchors[2], anchors[1]])), [anchors[0], anchors[1], anchors[2]]);
const segments = buildHistorySegments(anchors);
assert.equal(segments.length, anchors.length + 1);

const got = new Set(anchors);
let simulatedPages = 0;
for (const segment of segments) {
    let before = segment.upperExclusive;
    while (true) {
        const page = ids
            .filter(id => !before || BigInt(id) < BigInt(before))
            .slice(0, 100)
            .map(id => ({ id }));
        simulatedPages++;
        if (!page.length) break;
        const selected = selectPageForSegment(page, segment, item => item.id);
        selected.forEach(item => got.add(item.id));
        const oldest = oldestPageId(page, item => item.id);
        if (segmentBoundaryReached(page, segment, item => item.id)) break;
        if (page.length < 100 || !oldest) break;
        before = oldest;
    }
}
assert.equal(got.size, ids.length, "anchored plan must cover every message exactly once logically");
assert.equal(simulatedPages, 129, `anchored plan should hit the 129-page floor for the 12,872-message regression fixture, got ${simulatedPages}`);

// v0.9.1 Hybrid uses the same real-ID partition invariant, then stripes only the bounded middle
// ranges across three data planes. A durable resume must be able to skip all completed ranges and
// repair one bad search range without replaying the full 12,872-message timeline.
const hybridAnchors = Array.from({ length: 20 }, (_, index) => ids[(index + 1) * 600 - 1]);
const hybrid = buildHybridHistorySegments(ids[99], hybridAnchors, true, true);
assert.equal(hybrid.length, 21);
assert.equal(hybrid[0].plane, "normal");
assert.equal(hybrid.at(-1).plane, "normal");
assert.deepEqual(Array.from(hybrid.slice(1, 7), segment => segment.plane), [
    "channel-search", "global-search", "normal", "channel-search", "global-search", "normal"
]);

const hybridCovered = new Set(ids.slice(0, 100));
hybridAnchors.forEach(id => hybridCovered.add(id));
for (const segment of hybrid) {
    selectPageForSegment(ids.map(id => ({ id })), segment, item => item.id)
        .forEach(item => hybridCovered.add(item.id));
}
assert.equal(hybridCovered.size, ids.length, "Hybrid edge + anchors + ranges must cover the fixture exactly");

const ledger = hybrid.map((segment, index) => ({ ...segment, status: index === 7 ? "pending" : "complete" }));
const resumed = ledger.filter(segment => segment.status === "complete");
const pending = ledger.filter(segment => segment.status === "pending");
assert.equal(resumed.length, 20);
assert.equal(pending.length, 1, "targeted resume should retain exactly the failed range");
const pendingMessages = ids.filter(id => selectPageForSegment([{ id }], pending[0], item => item.id).length).length;
assert.ok(Math.ceil(pendingMessages / 100) < 10, "targeted repair must stay far below a full 129-page replay");

const oldNewest = BigInt(ids[0]);
const withNewMessages = count => [
    ...Array.from({ length: count }, (_, index) => (oldNewest + BigInt(index + 1)).toString()),
    ...ids
].sort((a, b) => BigInt(a) > BigInt(b) ? -1 : 1);
assert.ok(BigInt(withNewMessages(50)[99]) < oldNewest, "overlapping edge pages need no resume-gap request");
assert.ok(BigInt(withNewMessages(150)[99]) > oldNewest, "more than one new edge page must create a bounded resume gap");

// Sparse and uneven anchor placement must still partition correctly; balance affects speed, never
// correctness. Search can be stale, so the planner cannot rely on offsets being exact.
for (const chosen of [
    [ids[10], ids[8000]],
    [ids[500], ids[501], ids[12000]],
    [],
]) {
    const ranges = buildHistorySegments(chosen);
    const covered = new Set(chosen);
    for (const segment of ranges) {
        for (const id of ids) {
            const picked = selectPageForSegment([{ id }], segment, item => item.id);
            if (picked.length) covered.add(id);
        }
    }
    assert.equal(covered.size, ids.length);
}

// PinDMs is a stock plugin and userplugins are generated afterwards. LocalGroupArchive's DM-list
// patch must therefore wrap PinDMs' already-transformed expression instead of only accepting a
// bare minified identifier.
assert.ok(mainPlugin.includes("match: /privateChannelIds:([^,]+)(?=,listRef:)/"));
assert.ok(mainPlugin.includes("sections:$self.extendDmSections($1)"));
assert.ok(mainPlugin.includes("sections.length - 1"));

// Simulate the exact shape PinDMs leaves behind before LocalGroupArchive's later userplugin patch
// runs. Both wrappers must still match after PinDMs has inserted function calls into the values.
let dmModule = 'renderRow:this.renderRow,...PIN.makeProps(this,{sections:[0,foo(1)]}),channels:a,privateChannelIds:b.filter(c=>!PIN.isPinned(c)),listRef:r,renderRow=x=>{PINROW();}';
dmModule = dmModule
    .replace(/privateChannelIds:([^,]+)(?=,listRef:)/, 'privateChannelIds:LGA.injectGhostIds($1)')
    .replace(/sections:(\[.+?1\)\])/, 'sections:LGA.extendDmSections($1)')
    .replace(/renderRow(?:",|=)([A-Za-z_$][\w$]*)=>{/, '$&LGA_GHOST();');
assert.match(dmModule, /privateChannelIds:LGA\.injectGhostIds\(b\.filter\(c=>!PIN\.isPinned\(c\)\)\)/);
assert.match(dmModule, /sections:LGA\.extendDmSections\(\[0,foo\(1\)\]\)/);
assert.match(dmModule, /renderRow=x=>\{LGA_GHOST\(\);PINROW\(\);/);

const setup = fs.readFileSync(new URL("plugin/LocalGroupArchiveSetup/index.ts", root), "utf8");
assert.match(setup, /required: true/);
assert.match(setup, /lga-block/);
assert.match(setup, /LocalGroupArchive:StartGuide/);
assert.match(setup, /records\.some\(record => !this\.root\.contains/);

const installer = fs.readFileSync(new URL("installer/Install-LocalGroupArchive.ps1", root), "utf8");
assert.match(installer, /VencordInstallerCli\.exe/);
assert.match(installer, /checksums\.sha256/);
assert.match(installer, /VENCORD_DEV_INSTALL/);
assert.match(installer, /--branch/);
assert.match(installer, /--disable-updater/);
assert.match(installer, /Prune-OldRollbacks/);
assert.match(installer, /previousErrorActionPreference/);
assert.match(installer, /\$ErrorActionPreference = "Continue"/);
assert.match(installer, /decide success strictly from the native process exit code/);
assert.match(installer, /PinnedVencordCommit = "0850f37fbb1623aa6330764d8f4b1e0b2617dcdf"/);
assert.doesNotMatch(installer, /repos\/Vendicated\/Vencord\/commits\/main/);
assert.match(installer, /PnpmStoreRoot/);
assert.match(installer, /package-import-method=copy/);
assert.match(installer, /Install-VencordDependencies/);
assert.match(installer, /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/);
assert.match(installer, /Reset-VencordNodeModules/);
assert.match(installer, /Write-InstallerResult/);
assert.match(installer, /Last log lines:/);

const remover = fs.readFileSync(new URL("installer/Remove-LocalGroupArchive.ps1", root), "utf8");
assert.match(remover, /injectorExitCode/);
assert.match(remover, /\$ErrorActionPreference = "Continue"/);

const updater = fs.readFileSync(new URL("installer/Update-LocalGroupArchive.ps1", root), "utf8");
assert.match(updater, /OWNER\/NAME format|valid GitHub repository name/);

const ciWorkflow = fs.readFileSync(new URL(".github/workflows/ci.yml", root), "utf8");
assert.match(ciWorkflow, /ref: 0850f37fbb1623aa6330764d8f4b1e0b2617dcdf/);

const releaseWorkflow = fs.readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
assert.match(releaseWorkflow, /\[release\]/);
assert.match(releaseWorkflow, /gh release create/);
assert.match(releaseWorkflow, /End-to-end installer engine test/);
assert.match(releaseWorkflow, /-SkipInject/);

const version = JSON.parse(fs.readFileSync(new URL("package.json", root), "utf8")).version;
const versionPattern = new RegExp(version.replace(/\./g, "\\."));
for (const relative of [
    "plugin/LocalGroupArchive/index.ts",
    "installer/Install-LocalGroupArchive.ps1",
    "installer/Update-LocalGroupArchive.ps1",
    "installer/LocalGroupArchive.iss",
    "README.md"
]) {
    assert.match(fs.readFileSync(new URL(relative, root), "utf8"), versionPattern, `${relative} version drifted from package.json`);
}

console.log(`Smoke checks passed for ${files.length} TypeScript files and a ${Buffer.byteLength(html)}-byte generated viewer.`);
