import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { stripTypeScriptTypes } from "node:module";

const root = new URL("../", import.meta.url);
const files = [
    "plugin/LocalGroupArchive/index.ts",
    "plugin/LocalGroupArchive/native.ts",
    "plugin/LocalGroupArchive/viewer.ts",
    "plugin/LocalGroupArchiveSetup/index.ts"
];

for (const relative of files) {
    const source = fs.readFileSync(new URL(relative, root), "utf8");
    const javascript = stripTypeScriptTypes(source, { mode: "transform" });
    new vm.SourceTextModule(javascript);
}

let viewerSource = fs.readFileSync(new URL("plugin/LocalGroupArchive/viewer.ts", root), "utf8");
viewerSource = viewerSource
    .replace("function safeJson(value: unknown)", "function safeJson(value)")
    .replace(
        "export function buildViewerHtml(channelIds: string[], withBaseTag: boolean, apiPort: number, apiToken: string)",
        "function buildViewerHtml(channelIds, withBaseTag, apiPort, apiToken)"
    );
const buildViewerHtml = vm.runInNewContext(`${viewerSource};buildViewerHtml`);
const html = buildViewerHtml(["123456789012345678"], false, 32123, "test-token");
let inlineScripts = 0;
for (const match of html.matchAll(/<script(?: [^>]*)?>([\s\S]*?)<\/script>/g)) {
    if (!match[1].trim()) continue;
    new vm.Script(match[1]);
    inlineScripts++;
}

assert.equal(inlineScripts, 2, "expected the boot and application scripts");
assert.match(html, /MAX_DOM=300/);
assert.match(html, /SHIFT=100/);
assert.match(html, /_assets\/avatars/);
assert.match(html, /_assets\/group-icons/);
assert.match(html, /نتائج البحث/);
assert.match(html, /تصدير JSON/);
assert.match(html, /function rebuildCaches/);
assert.match(html, /function runChunk/);

const native = fs.readFileSync(new URL("plugin/LocalGroupArchive/native.ts", root), "utf8");
assert.match(native, /BigInt\(a\)/);
assert.match(native, /writeFileAtomic/);
assert.match(native, /fetchWithValidatedRedirects/);
assert.match(native, /getChannelArchiveBounds/);

const mainPlugin = fs.readFileSync(new URL("plugin/LocalGroupArchive/index.ts", root), "utf8");
assert.match(mainPlugin, /startupCatchupPending/);
assert.match(mainPlugin, /captureStartupBoundaries/);
assert.match(mainPlugin, /archiveRecentHistory/);
assert.match(mainPlugin, /MAX_RENDERER_BATCH_BYTES/);
assert.match(native, /DOWNLOAD_TIMEOUT_MS/);
assert.doesNotMatch(native, /Access-Control-Allow-Origin", "\*"/);
assert.match(native, /revisionSignature/);

const renderer = fs.readFileSync(new URL("plugin/LocalGroupArchive/index.ts", root), "utf8");
assert.match(renderer, /MAX_PENDING_ATTACHMENT_JOBS/);
assert.match(renderer, /ATTACHMENT_RETRIES/);
assert.match(renderer, /cancelAllDownloads/);

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

const updater = fs.readFileSync(new URL("installer/Update-LocalGroupArchive.ps1", root), "utf8");
assert.match(updater, /OWNER\/NAME format|valid GitHub repository name/);

const releaseWorkflow = fs.readFileSync(new URL(".github/workflows/release.yml", root), "utf8");
assert.match(releaseWorkflow, /\[release\]/);
assert.match(releaseWorkflow, /gh release create/);

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
