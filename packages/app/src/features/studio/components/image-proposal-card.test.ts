import { controlGlobals, choose, choiceLabels } from "../../../test/themed-controls.test-helper";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import * as reactI18next from "react-i18next";
import { JSDOM } from "jsdom";
import { transform } from "sucrase";
import { create } from "zustand";
import type { StudioImageProposal, StudioChatMessage } from "../lib/types";

const require = createRequire(import.meta.url);
const studio = create<{ chatMessages: StudioChatMessage[] }>(() => ({ chatMessages: [] }));
type Props = Parameters<typeof import("./image-proposal-card").ImageProposalCard>[0];
const component = { exports: {} as { ImageProposalCard: (props: Props) => React.ReactNode } };
// Compile the Vite environment constant for Node. Keep React and the actual card;
// replace only the app stores, notifications and unused lightbox boundary.
function loadComponent() {
new Function("require", "module", "exports", transform(readFileSync(new URL("./image-proposal-card.tsx", import.meta.url), "utf8")
  .replace("import.meta.env.VITE_API_URL", '""'), { transforms: ["typescript", "jsx", "imports"], jsxRuntime: "automatic" }).code)(
  (id: string) => {
    if (id === "react-i18next") return reactI18next;
    if (id === "@/lib/utils") return { cn: (...values: unknown[]) => values.filter(Boolean).join(" ") };
    if (id === "@/lib/asset-url") return { resolveImageUrl: (value: string) => value };
    if (id === "@/components/image-lightbox") return { ImageLightbox: () => null };
    if (id === "@/stores/editor") return { useEditorStore: (select: (state: unknown) => unknown) => select({ serverWorldId: "test-world" }) };
    if (id === "@/stores/studio") return { useStudioStore: studio };
    if (id === "@/lib/feedback") return { feedback: { error() {} } };
    return require(id);
  }, component, component.exports);
}

for (const imageKind of ["sprite", "background"] as const) test(`${imageKind} card switches from Codex to local NSFW without downgrading the rating`, async () => {
  const dom = new JSDOM('<div id="root"></div>', { url: "https://fixture.test/" });
  const proposal: StudioImageProposal = { runId: "test-run", toolCallId: "test-call", source: "codex", imageWorkflow: "codex",
    contentRating: "sfw", imageKind, jobId: "00000000-0000-0000-0000-000000000001", jobStatus: "queued", status: "generating",
    prompt: "Safe artwork", model: "GPT-6.1 Sol · xhigh", aspectRatio: "1:1", batchSize: 1, unitMushies: 0, estimatedMushies: 0,
    workflowOptions: { anima: true, krea: true, codex: true }, generationOptionsEditable: true };
  const requests: Record<string, unknown>[] = [];
  let remoteJob = { ...proposal, status: "queued" };
  const globals = { ...controlGlobals(dom),
    fetch: async (url: string, init?: RequestInit) => {
      if (url.endsWith("/anima-models")) return Response.json({ recommendedModel: "anima-base.safetensors", modelOptions: [
        { name: "anima-base.safetensors", nsfwCapable: false }, { name: "anima-nsfw.safetensors", nsfwCapable: true },
      ] });
      if (url.endsWith("/generation-options")) {
        const body = JSON.parse(String(init?.body)); requests.push(body);
        remoteJob = { ...remoteJob, ...body, source: body.workflow === "codex" ? "codex" : "comfyui",
          model: body.workflow === "codex" ? "GPT-6.1 Sol · xhigh" : body.workflow === "krea" ? "Krea2-Anime v2.0 INT4 · local" : body.animaModel,
          imageWorkflow: body.workflow, jobId: proposal.jobId, status: "queued", generationOptionsEditable: true };
        return Response.json({ data: remoteJob });
      }
      return Response.json({ data: remoteJob });
    },
  };
  const previous = new Map(Object.keys(globals).map(key => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  for (const [key, value] of Object.entries(globals)) Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  loadComponent();
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { editor: {} } }, interpolation: { escapeValue: false } });
  const root = createRoot(document.getElementById("root")!);
  studio.setState({ chatMessages: [{ id: "message", role: "assistant", content: "", imageProposal: proposal }] });
  function Card() {
    const current = studio(state => state.chatMessages[0]!.imageProposal!);
    return createElement(component.exports.ImageProposalCard, { proposal: current, interactive: true, onConfirm() {}, onDecline() {} });
  }
  const select = (label: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
  const change = async (label: string, value: string) => {
    const element = select(label); assert.ok(element, `${label} must be available`);
    const labels: Record<string, string> = { nsfw: "NSFW", sfw: "SFW", anima: "Anima", krea: "Krea", codex: "Codex" };
    await choose(element, labels[value] ?? value);
  };
  const save = async () => { await act(async () => [...document.querySelectorAll("button")].find(button => button.textContent?.includes("Apply before"))!.click()); };
  try {
    await act(async () => root.render(createElement(I18nextProvider, { i18n }, createElement(Card))));
    assert.equal((await choiceLabels(select("Image generation workflow"))).length, 3);
    await change("Image content rating", "nsfw");
    assert.deepEqual(await choiceLabels(select("Image generation workflow")), ["Anima", "Krea"]);
    assert.equal(select("Image generation workflow").textContent?.trim(), "Krea");
    assert.equal(select("Image content rating").textContent?.trim(), "NSFW");
    await save(); assert.equal(requests.at(-1)?.contentRating, "nsfw"); assert.equal(requests.at(-1)?.workflow, "krea");
    assert.doesNotMatch(document.body.textContent!, /Uses the shared Codex account/, "saved local choices must update the displayed provider");
    await change("Image generation workflow", "anima");
    assert.equal(select("Image content rating").textContent?.trim(), "NSFW");
    assert.deepEqual(await choiceLabels(select("Local Anima checkpoint")), ["anima-nsfw.safetensors · NSFW-capable"]);
    assert.equal(select("Local Anima checkpoint").textContent?.trim(), "anima-nsfw.safetensors · NSFW-capable");
    await save(); assert.equal(requests.at(-1)?.contentRating, "nsfw"); assert.equal(requests.at(-1)?.animaModel, "anima-nsfw.safetensors");
    await change("Image content rating", "sfw");
    assert.equal((await choiceLabels(select("Image generation workflow"))).length, 3);
    assert.equal(select("Image generation workflow").textContent?.trim(), "Codex");
    await save(); assert.equal(requests.at(-1)?.workflow, "codex"); assert.equal(requests.at(-1)?.contentRating, "sfw");
  } finally {
    await act(async () => root.unmount()); dom.window.close();
    for (const [key, descriptor] of previous) { if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key); }
  }
});
