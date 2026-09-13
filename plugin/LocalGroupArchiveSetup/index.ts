/*
 * Vencord, a Discord client mod
 * Copyright (c) 2026 Vendicated and contributors
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import * as DataStore from "@api/DataStore";
import definePlugin from "@utils/types";

const COMPLETE_KEY = "LocalGroupArchive_setupGuideComplete_v1";
const GUIDE_EVENT = "LocalGroupArchive:StartGuide";
const PLUGIN_NAME = "LocalGroupArchive";

interface GuideStep {
    title: string;
    body: string;
    locate: () => HTMLElement | null;
    afterClick?: () => void;
}

let guide: SpotlightGuide | null = null;

function normalizedText(element: Element) {
    return (element.textContent ?? "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
}

function clickable(element: Element | null): HTMLElement | null {
    if (!(element instanceof HTMLElement)) return null;
    return element.closest<HTMLElement>("button,[role=button],[role=tab],[role=switch],a") ?? element;
}

function isVisible(element: HTMLElement) {
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 0 && rect.height > 0
        && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth
        && style.display !== "none" && style.visibility !== "hidden";
}

function byAccessibleName(names: string[]) {
    const lowered = names.map(name => name.toLocaleLowerCase());
    const elements = document.querySelectorAll<HTMLElement>(
        "button,[role=button],[role=tab],[role=switch],[aria-label],[data-list-item-id]"
    );
    for (const element of elements) {
        if (!isVisible(element)) continue;
        const value = `${element.getAttribute("aria-label") ?? ""} ${element.getAttribute("title") ?? ""} ${normalizedText(element)}`
            .toLocaleLowerCase();
        if (lowered.some(name => value === name || value.includes(name))) return clickable(element);
    }
    return null;
}

function locateSettings() {
    return byAccessibleName(["User Settings", "إعدادات المستخدم", "الإعدادات"]);
}

function locateVencord() {
    return byAccessibleName(["Vencord"]);
}

function locatePlugins() {
    return byAccessibleName(["Plugins", "الإضافات", "الملحقات"]);
}

function locatePluginSearch() {
    const inputs = document.querySelectorAll<HTMLInputElement>("input[type=search],input[placeholder]");
    for (const input of inputs) {
        const hint = `${input.placeholder} ${input.getAttribute("aria-label") ?? ""}`.toLocaleLowerCase();
        if (!isVisible(input)) continue;
        if (hint.includes("plugin") || hint.includes("إضافة")) return input;
    }
    return null;
}

function setReactInputValue(input: HTMLInputElement, value: string) {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    setter?.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
}

function pluginCard() {
    for (const element of document.querySelectorAll<HTMLElement>("h1,h2,h3,h4,strong,span,div")) {
        if (!isVisible(element)) continue;
        if (normalizedText(element) !== PLUGIN_NAME.toLocaleLowerCase()) continue;
        let current: HTMLElement | null = element;
        for (let depth = 0; current && depth < 9; depth++, current = current.parentElement) {
            if (current.querySelector('[role="switch"],input[type="checkbox"],button[aria-checked]')) return current;
        }
    }
    return null;
}

function locatePluginToggle() {
    const card = pluginCard();
    if (!card) return null;
    const toggle = card.querySelector<HTMLElement>('[role="switch"],input[type="checkbox"],button[aria-checked]');
    return toggle && isVisible(toggle) ? toggle : null;
}

function isEnabled(toggle: HTMLElement | null) {
    if (!toggle) return false;
    if (toggle instanceof HTMLInputElement) return toggle.checked;
    return toggle.getAttribute("aria-checked") === "true"
        || toggle.getAttribute("data-state") === "checked";
}

class SpotlightGuide {
    private root = document.createElement("div");
    private blockers = [0, 1, 2, 3].map(() => document.createElement("div"));
    private ring = document.createElement("div");
    private bubble = document.createElement("section");
    private title = document.createElement("h2");
    private body = document.createElement("p");
    private progress = document.createElement("span");
    private skip = document.createElement("button");
    private observer: MutationObserver;
    private frame = 0;
    private stepIndex = 0;
    private target: HTMLElement | null = null;
    private targetHandler = () => this.advanceAfterClick();
    private force = false;
    private closed = false;
    private completed = false;

    private steps: GuideStep[] = [
        {
            title: "افتح إعدادات ديسكورد",
            body: "اضغط ترس إعدادات المستخدم المضيء. بقية الشاشة مقفلة مؤقتًا عشان ما تضيع.",
            locate: locateSettings
        },
        {
            title: "ادخل إعدادات Vencord",
            body: "من القائمة الجانبية اضغط Vencord.",
            locate: locateVencord
        },
        {
            title: "افتح صفحة Plugins",
            body: "اضغط Plugins لعرض الإضافات المركبة.",
            locate: locatePlugins
        },
        {
            title: "ابحث عن الإضافة",
            body: "اضغط مربع البحث؛ بكتب LocalGroupArchive لك تلقائيًا.",
            locate: locatePluginSearch,
            afterClick: () => {
                const input = locatePluginSearch() as HTMLInputElement | null;
                if (input) setReactInputValue(input, PLUGIN_NAME);
            }
        },
        {
            title: "فعّل LocalGroupArchive",
            body: "اضغط مفتاح التفعيل المضيء. بعدها يصير الأرشيف جاهز ويبدأ مع القروبات الجديدة تلقائيًا.",
            locate: locatePluginToggle
        }
    ];

    constructor(force = false) {
        this.force = force;
        this.observer = new MutationObserver(records => {
            if (records.some(record => !this.root.contains(record.target))) this.queueRefresh();
        });
        this.build();
    }

    private build() {
        this.root.id = "lga-spotlight-guide";
        this.root.innerHTML = `<style>
#lga-spotlight-guide{position:fixed;inset:0;z-index:2147483646;pointer-events:none;font-family:var(--font-primary,"gg sans","Segoe UI",sans-serif)}
#lga-spotlight-guide .lga-block{position:fixed;background:rgba(3,5,9,.78);backdrop-filter:blur(2px);pointer-events:auto;transition:all .22s cubic-bezier(.2,.8,.2,1)}
#lga-spotlight-guide .lga-ring{position:fixed;border:3px solid #8b92ff;border-radius:12px;box-shadow:0 0 0 4px rgba(88,101,242,.25),0 0 32px rgba(88,101,242,.9);pointer-events:none;transition:all .22s cubic-bezier(.2,.8,.2,1);animation:lgaPulse 1.55s ease-in-out infinite}
#lga-spotlight-guide .lga-bubble{position:fixed;direction:rtl;width:min(390px,calc(100vw - 28px));padding:17px;border:1px solid rgba(255,255,255,.13);border-radius:15px;background:#20232a;color:#f2f3f5;box-shadow:0 22px 80px rgba(0,0,0,.58);pointer-events:auto;transition:all .22s cubic-bezier(.2,.8,.2,1)}
#lga-spotlight-guide h2{font-size:18px;line-height:1.3;margin:0 0 7px;font-weight:800}#lga-spotlight-guide p{font-size:14px;line-height:1.7;color:#c6cad0;margin:0}
#lga-spotlight-guide .lga-foot{display:flex;align-items:center;justify-content:space-between;margin-top:13px;color:#949ba4;font-size:11px}#lga-spotlight-guide button{border:0;border-radius:8px;background:#343840;color:#d7d9dd;padding:7px 10px;cursor:pointer}#lga-spotlight-guide button:hover{background:#414650;color:#fff}
@keyframes lgaPulse{50%{box-shadow:0 0 0 7px rgba(88,101,242,.12),0 0 40px rgba(88,101,242,.95)}}
</style>`;
        for (const blocker of this.blockers) {
            blocker.className = "lga-block";
            this.root.append(blocker);
        }
        this.ring.className = "lga-ring";
        this.bubble.className = "lga-bubble";
        const foot = document.createElement("div");
        foot.className = "lga-foot";
        this.skip.type = "button";
        this.skip.textContent = "تخطي الدليل";
        this.skip.onclick = () => void this.finish(true);
        foot.append(this.progress, this.skip);
        this.bubble.append(this.title, this.body, foot);
        this.root.append(this.ring, this.bubble);
    }

    async start() {
        if (!this.force && await DataStore.get(COMPLETE_KEY).catch(() => false)) return this.destroy();
        document.body.append(this.root);
        this.observer.observe(document.body, { childList: true, subtree: true, attributes: true });
        window.addEventListener("resize", this.queueRefresh);
        window.addEventListener("scroll", this.queueRefresh, true);
        this.refresh();
    }

    private queueRefresh = () => {
        cancelAnimationFrame(this.frame);
        this.frame = requestAnimationFrame(() => this.refresh());
    };

    private refresh() {
        if (this.closed) return;
        const step = this.steps[this.stepIndex];
        if (!step) return void this.finish(false);
        const nextTarget = step.locate();
        if (nextTarget !== this.target) {
            this.target?.removeEventListener("click", this.targetHandler);
            this.target = nextTarget;
            this.target?.addEventListener("click", this.targetHandler, { once: true });
        }
        if (this.stepIndex === this.steps.length - 1 && isEnabled(this.target)) return void this.finish(false);
        this.title.textContent = step.title;
        this.body.textContent = this.target ? step.body : "لحظة… أنتظر ظهور الزر المطلوب داخل ديسكورد.";
        this.progress.textContent = `الخطوة ${this.stepIndex + 1} من ${this.steps.length}`;
        this.position();
    }

    private position() {
        if (!this.target) {
            this.blockers[0].style.cssText = "display:block;inset:0;width:100vw;height:100vh";
            this.blockers.slice(1).forEach(blocker => blocker.style.cssText = "display:none");
            this.ring.style.display = "none";
            Object.assign(this.bubble.style, { left: "50%", top: "50%", transform: "translate(-50%,-50%)" });
            return;
        }

        this.blockers.forEach(blocker => blocker.style.cssText = "display:block");
        const margin = 8;
        const rect = this.target.getBoundingClientRect();
        const left = Math.max(0, rect.left - margin);
        const top = Math.max(0, rect.top - margin);
        const right = Math.min(innerWidth, rect.right + margin);
        const bottom = Math.min(innerHeight, rect.bottom + margin);
        Object.assign(this.blockers[0].style, { left: "0", top: "0", width: "100vw", height: `${top}px` });
        Object.assign(this.blockers[1].style, { left: "0", top: `${top}px`, width: `${left}px`, height: `${bottom - top}px` });
        Object.assign(this.blockers[2].style, { left: `${right}px`, top: `${top}px`, width: `${Math.max(0, innerWidth - right)}px`, height: `${bottom - top}px` });
        Object.assign(this.blockers[3].style, { left: "0", top: `${bottom}px`, width: "100vw", height: `${Math.max(0, innerHeight - bottom)}px` });
        Object.assign(this.ring.style, {
            display: "block",
            left: `${left}px`, top: `${top}px`, width: `${right - left}px`, height: `${bottom - top}px`
        });

        const bubbleWidth = Math.min(390, innerWidth - 28);
        const bubbleLeft = Math.max(14, Math.min(innerWidth - bubbleWidth - 14, left + (right - left - bubbleWidth) / 2));
        const below = bottom + 14;
        const placeBelow = below + 190 < innerHeight;
        Object.assign(this.bubble.style, {
            width: `${bubbleWidth}px`,
            left: `${bubbleLeft}px`,
            top: placeBelow ? `${below}px` : "auto",
            bottom: placeBelow ? "auto" : `${Math.max(14, innerHeight - top + 14)}px`,
            transform: "none"
        });
    }

    private advanceAfterClick() {
        const step = this.steps[this.stepIndex];
        step?.afterClick?.();
        setTimeout(() => {
            if (this.closed || this.completed) return;
            this.stepIndex++;
            this.target = null;
            this.refresh();
        }, step?.afterClick ? 450 : 300);
    }

    private async finish(skipped: boolean) {
        if (this.closed || this.completed) return;
        if (!skipped) {
            this.completed = true;
            this.observer.disconnect();
            this.target?.removeEventListener("click", this.targetHandler);
            await DataStore.set(COMPLETE_KEY, true).catch(() => { });
            this.title.textContent = "تم! الإضافة جاهزة 🎉";
            this.body.textContent = "داخل أي قروب استخدم /localarchive ثم اختر start للأرشفة الكاملة، أو viewer لفتح العارض. القروبات الجديدة تُؤرشف تلقائيًا.";
            this.progress.textContent = "اكتمل الإعداد";
            this.skip.textContent = "إغلاق";
            this.skip.onclick = () => this.destroy();
            this.target = null;
            this.position();
            return;
        }
        await DataStore.set(COMPLETE_KEY, true).catch(() => { });
        this.destroy();
    }

    destroy() {
        if (this.closed) return;
        this.closed = true;
        cancelAnimationFrame(this.frame);
        this.observer.disconnect();
        this.target?.removeEventListener("click", this.targetHandler);
        window.removeEventListener("resize", this.queueRefresh);
        window.removeEventListener("scroll", this.queueRefresh, true);
        this.root.remove();
        if (guide === this) guide = null;
    }
}

function launch(force = false) {
    guide?.destroy();
    guide = new SpotlightGuide(force);
    void guide.start().catch(error => {
        console.warn("[LocalGroupArchiveSetup] Could not start the setup guide", error);
        guide?.destroy();
    });
}

function onGuideRequest() {
    launch(true);
}

export default definePlugin({
    name: "LocalGroupArchiveSetup",
    description: "Required interactive spotlight guide for enabling LocalGroupArchive after installation.",
    authors: [{ name: "Faisal", id: 0n }],
    required: true,

    start() {
        window.addEventListener(GUIDE_EVENT, onGuideRequest);
        window.setTimeout(() => launch(false), 1600);
    },

    stop() {
        window.removeEventListener(GUIDE_EVENT, onGuideRequest);
        guide?.destroy();
    }
});
