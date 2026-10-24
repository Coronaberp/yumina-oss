import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { clientDom, loadClientModule } from "../../lib/feed-beacon.test-helpers";
import { useLibrarySearchStore } from "../../stores/library-search";
import { tallyReviewStates } from "../../lib/review-state";
import type { AdminLibraryItem, WorldItem } from "../../stores/worlds";

const adminItem: AdminLibraryItem = {
  id: "01b05b03-98ac-45cc-8a64-ca7a53c97f10", name: "Seiryu Academy",
  thumbnailUrl: "/cdn/seiryu.webp", coverCrop: null, creatorName: "filgachtic",
  createdAt: "2026-04-01T00:00:00Z", updatedAt: "2026-06-01T00:00:00Z",
};
function world(id: string, name: string, extra: Partial<WorldItem> = {}): WorldItem {
  return {
    id, name, creatorId: "admin", description: null, schema: {}, thumbnailUrl: null,
    isPublished: false, isNsfw: false, allowEdit: true, downloadCount: 0, tags: [],
    announcement: null, totalTokens: null, approxTime: null, galleryImages: [],
    sourceWorldId: null, sourceWorldTakenDown: null, moderationNote: null,
    moderationAction: null, creatorName: "Admin", createdAt: "2026-01-01T00:00:00Z",
    updatedAt: "2026-01-01T00:00:00Z", ...extra,
  };
}
const messages = JSON.parse(readFileSync(new URL("../../locales/en/library.json", import.meta.url), "utf8"));
const translation = { useTranslation: () => ({ t: (key: string, options: Record<string, unknown> = {}) => {
  const value = key.split(".").reduce((entry, part) => entry?.[part], messages) ?? options.defaultValue ?? key;
  return String(value).replace(/\{\{(\w+)\}\}/g, (_, name: string) => String(options[name] ?? ""));
} }) };

function harness(ownWorlds = Array.from({ length: 7 }, (_, i) => world(`draft-${i}`, `Draft ${i}`))) {
  const env = clientDom();
  const navigations: unknown[] = [], details: unknown[] = [], plays: unknown[] = [], duplicates: string[] = [], locks: unknown[] = [];
  let userId = "admin";
  const state = {
    worlds: ownWorlds, loading: false, adminLibraryItems: [adminItem], adminLibraryViewerId: "admin" as string | null,
    fetchWorlds() {}, deleteWorld: async () => true,
    setEditingLocked: async (...args: unknown[]) => { locks.push(args); return true; },
  };
  const store = (select: (value: typeof state) => unknown) => select(state);
  const empty = () => null;
  const mocks = {
    "react-i18next": translation,
    "@tanstack/react-router": { useNavigate: () => (value: unknown) => navigations.push(value) },
    "@/stores/worlds": { useWorldsStore: store },
    "@/stores/library-search": { useLibrarySearchStore },
    "@/hooks/use-play-with-language": { usePlayWithLanguage: () => ({ handlePlay: (value: unknown) => plays.push(value) }) },
    "@/hooks/use-duplicate-card": { useDuplicateCard: () => ({ duplicateCard: (id: string) => duplicates.push(id), duplicatingId: null }) },
    "@/lib/feedback": { feedback: { error() {} } },
    "@/lib/markdown": { escapeHtml: (value: string) => value },
    "@/lib/fork-attribution": { isOwnTranslationSource: () => false },
    "@/lib/review-state": { tallyReviewStates },
    "@/lib/creator-hub-url": { getCreatorHubUrl: () => "/creator" },
    "@/components/ui/dialog": { Dialog: empty, DialogContent: empty, DialogHeader: empty, DialogFooter: empty, DialogTitle: empty, DialogDescription: empty },
    "@/components/ui/confirm-dialog": { ConfirmDialog: empty },
    "./library-tombstone-card": { LibraryTombstoneCard: empty },
    "./library-empty-state": { LibraryEmptyState: () => createElement("p", null, "No projects") },
  };
  const card = loadClientModule<typeof import("./library-game-card")>(new URL("./library-game-card.tsx", import.meta.url), {
    "react-i18next": translation,
    "@/lib/cover-crop": { CroppedImage: ({ src, alt }: { src: string; alt: string }) => createElement("img", { src, alt }) },
  });
  const { LibraryMyProjects } = loadClientModule<typeof import("./library-my-projects")>(new URL("./library-my-projects.tsx", import.meta.url), {
    ...mocks, "./library-game-card": card,
    "./sort-dropdown": loadClientModule(new URL("./sort-dropdown.tsx", import.meta.url), { "react-i18next": translation }),
    "./bulk-actions-bar": loadClientModule(new URL("./bulk-actions-bar.tsx", import.meta.url), { "react-i18next": translation }),
  });
  const { LibraryPage } = loadClientModule<typeof import("./library-page")>(new URL("./library-page.tsx", import.meta.url), {
    ...mocks,
    "@tanstack/react-router": { ...mocks["@tanstack/react-router"], useSearch: () => ({ view: "projects" }), useRouter: () => ({ history: {} }) },
    "@/stores/library": { useLibraryStore: (select: (s: unknown) => unknown) => select({ loading: false, fetchLibrary() {} }) },
    "@/lib/auth-client": { useSession: () => ({ data: userId ? { user: { id: userId } } : null }) },
    "@/hooks/use-auth-guard": { useAuthGuard: () => ({ isAuthenticated: true }) },
    "@/stores/user-profile": { useUserProfileStore: (select: (s: unknown) => unknown) => select({ profile: null, fetchProfile() {} }) },
    "@/edition/edition": { useEdition: () => ({ features: { library: true, bundles: false } }) },
    "@/edition/slots": { LibraryBundlesTab: empty },
    "@/lib/story-return": {}, "@/lib/safe-back": {},
    "./library-game-grid": { LibraryGameGrid: empty }, "./library-shared-examples": { LibrarySharedExamples: empty },
    "./library-session-media": { LibraryResourcesTab: empty }, "./library-favorites-view": { LibraryFavoritesView: empty },
    "./library-detail-panel": { LibraryDetailPanel: empty }, "./library-my-projects": { LibraryMyProjects },
  });
  useLibrarySearchStore.setState({ activeTab: "projects", query: "", projectSort: "title" });
  const root = createRoot(env.dom.window.document.getElementById("root")!);
  const doc = env.dom.window.document;
  return {
    doc, state, navigations, details, plays, duplicates, locks,
    async render(query = "") {
      await act(async () => root.render(createElement(LibraryMyProjects, {
        worlds: ownWorlds, userId, searchQuery: query, adminLibraryItems: state.adminLibraryItems,
        onSelectItem: (item: WorldItem) => details.push(item),
      })));
    },
    async page(viewer = "admin") { userId = viewer; await act(async () => root.render(createElement(LibraryPage))); },
    async click(element: Element | null) { assert.ok(element); await act(async () => (element as HTMLElement).click()); },
    async sort(value: "title" | "recent" | "releaseDate") { await act(async () => useLibrarySearchStore.getState().setProjectSort(value)); },
    async close() { await act(async () => root.unmount()); env.restore(); },
  };
}

function section(doc: Document, title: string) {
  return [...doc.querySelectorAll("h3")].find(node => node.textContent?.trim().startsWith(title))?.parentElement;
}
function card(doc: Document, name: string) {
  const heading = [...doc.querySelectorAll("h3")].find(node => node.textContent === name);
  assert.ok(heading, `card ${name} should be rendered`);
  return heading.parentElement!;
}
function button(doc: Document, name: string) { return [...doc.querySelectorAll("button")].find(node => node.textContent?.trim() === name) ?? null; }
function titles(element: Element | null | undefined) { return [...(element?.querySelectorAll(".library-card-grid h3") ?? [])].map(node => node.textContent); }

test("admin entry is in the existing Published grid with counts, stored author, and preview-only actions", async () => {
  const h = harness();
  try {
    await h.render();
    assert.equal(h.doc.querySelector("h2")?.textContent?.trim(), "My Projects (8)");
    assert.match(section(h.doc, "In Development")!.querySelector("h3")!.textContent!, /\(7\)/);
    const published = section(h.doc, "Published");
    assert.ok(published, "admin entry must create the existing Published section");
    assert.match(published.querySelector("h3")!.textContent!, /\(1\)/);
    assert.deepEqual(titles(published), ["Seiryu Academy"]);
    const seiryu = card(h.doc, "Seiryu Academy");
    assert.ok(seiryu.closest(".library-card-grid"));
    assert.match(seiryu.parentElement!.textContent!, /Admin-only/);
    assert.match(seiryu.parentElement!.textContent!, /by filgachtic/i);
    assert.deepEqual([...seiryu.querySelectorAll("button")].map(b => b.title), ["Play"]);
    await h.click(seiryu);
    await h.click(seiryu.querySelector('button[title="Play"]'));
    assert.deepEqual(h.navigations, [0, 1].map(() => ({ to: "/app/preview/$worldId", params: { worldId: adminItem.id }, search: { adminPreview: true } })));
    assert.deepEqual(h.details, []); assert.deepEqual(h.plays, []);
    assert.equal(h.doc.querySelector('a[href="/creator#review-progress"]'), null);
  } finally { await h.close(); }
});

test("ordinary project card still selects details, plays, edits, duplicates, and locks", async () => {
  const h = harness([world("owned", "Own Project")]);
  try {
    await h.render();
    const own = card(h.doc, "Own Project");
    await h.click(own);
    await h.click(own.querySelector('button[title="Play"]'));
    await h.click(own.querySelector('button[title="Edit Project"]'));
    await h.click(own.querySelector('button[title="Duplicate card"]'));
    await h.click(own.querySelector('button[title="Lock card"]'));
    assert.ok(own.querySelector('button[title="Delete"]'));
    assert.deepEqual(h.details, h.state.worlds); assert.deepEqual(h.plays, h.state.worlds);
    assert.deepEqual(h.duplicates, ["owned"]); assert.deepEqual(h.locks, [["owned", true]]);
    assert.deepEqual(h.navigations, [{ to: "/app/worlds/$worldId/edit", params: { worldId: "owned" } }]);
  } finally { await h.close(); }
});

test("Published combines own cards and admin metadata using the existing title and date sorting and search", async () => {
  const h = harness([
    world("a", "Alpha", { isPublished: true, createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z" }),
    world("z", "Zeta", { isPublished: true, createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z" }),
  ]);
  try {
    await h.render(); assert.deepEqual(titles(section(h.doc, "Published")), ["Alpha", "Seiryu Academy", "Zeta"]);
    await h.sort("recent"); assert.deepEqual(titles(section(h.doc, "Published")), ["Zeta", "Seiryu Academy", "Alpha"]);
    await h.sort("releaseDate"); assert.deepEqual(titles(section(h.doc, "Published")), ["Alpha", "Seiryu Academy", "Zeta"]);
    await h.render("sEiRyU"); assert.deepEqual(titles(section(h.doc, "Published")), ["Seiryu Academy"]);
    await h.render("no match"); assert.equal(section(h.doc, "Published"), undefined); assert.match(h.doc.body.textContent!, /No results/);
  } finally { await h.close(); }
});

test("admin entry never joins bulk selection or delete counts", async () => {
  const h = harness();
  try {
    await h.render(); await h.click(button(h.doc, "Select")); await h.click(button(h.doc, "Select all"));
    assert.match(h.doc.body.textContent!, /7 selected/);
    assert.ok(button(h.doc, "Clear"), "all seven owned cards are selected even though eight are displayed");
    const seiryu = card(h.doc, "Seiryu Academy");
    assert.equal(seiryu.querySelector('.ring-2'), null);
    await h.click(seiryu);
    assert.match(h.doc.body.textContent!, /7 selected/);
    assert.equal(h.navigations.length, 1, "the admin card remains a preview, never a bulk target");
    await h.render("Seiryu"); await h.click(button(h.doc, "Cancel") ?? h.doc.querySelector('button[title="Cancel"]'));
    assert.equal(button(h.doc, "Select")?.disabled, true, "only the visible admin entry leaves no bulk targets");
  } finally { await h.close(); }
});

test("LibraryPage scopes metadata to the current session user, including account changes and sign out", async () => {
  const h = harness();
  try {
    await h.page(); assert.ok(section(h.doc, "Published"));
    await h.page("someone-else"); assert.equal(section(h.doc, "Published"), undefined); assert.doesNotMatch(h.doc.body.textContent!, /Seiryu|filgachtic|Admin-only/);
    await h.page(""); assert.equal(section(h.doc, "Published"), undefined);
    await h.page("admin"); h.state.adminLibraryItems = []; h.state.adminLibraryViewerId = null;
    await h.page(); assert.equal(section(h.doc, "Published"), undefined); assert.doesNotMatch(h.doc.body.textContent!, /Seiryu|filgachtic|Admin-only/);
  } finally { await h.close(); }
});

test("an admin with no owned projects sees the Published entry without the empty-project state", async () => {
  const h = harness([]);
  try {
    await h.render();
    assert.deepEqual(titles(section(h.doc, "Published")), ["Seiryu Academy"]);
    assert.equal(h.doc.querySelector("h2")?.textContent?.trim(), "My Projects (1)");
    assert.doesNotMatch(h.doc.body.textContent!, /No projects/);
    assert.equal(button(h.doc, "Select")?.disabled, true);
  } finally { await h.close(); }
});
