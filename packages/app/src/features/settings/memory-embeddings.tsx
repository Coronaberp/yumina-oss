import { Checkbox } from "@/components/ui/checkbox";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Brain, Loader2, Plus } from "lucide-react";
import type {
  StoryhavenEmbeddingProfile,
  StoryhavenProfileInput,
} from "@yumina/shared";

const base = import.meta.env.VITE_API_URL || "";
async function request(path: string, body?: unknown, method = "POST") {
  const response = await fetch(`${base}/api/memory/profiles${path}`, {
    credentials: "include",
    method: body === undefined && path === "" ? "GET" : method,
    headers: { "Content-Type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = await response.json();
  if (!response.ok)
    throw new Error(data.error ?? "Memory configuration failed");
  return data;
}

export function MemoryEmbeddingsSettings() {
  const { t } = useTranslation("settings");
  const [profiles, setProfiles] = useState<StoryhavenEmbeddingProfile[]>([]);
  const [draft, setDraft] = useState<StoryhavenProfileInput>({
    baseUrl: "",
    model: "Qwen3-Embedding-0.6B",
    dimensions: 1024,
    sendDimensions: false,
    apiKey: "",
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState("");
  const [showForm, setShowForm] = useState(false);
  const refresh = async () => setProfiles((await request("")).profiles);
  useEffect(() => {
    refresh().catch(() =>
      setMessage(
        t("memoryEmbeddings.loadFailed", {
          defaultValue: "Unable to load embedding profiles",
        }),
      ),
    );
  }, []);
  const run = async (id: string, work: () => Promise<void>) => {
    setBusy(id);
    setMessage("");
    try {
      await work();
      await refresh();
    } catch (e) {
      setMessage(
        e instanceof Error ? e.message : "Memory configuration failed",
      );
    } finally {
      setBusy(null);
    }
  };
  const label = (key: string, fallback: string) =>
    t(`memoryEmbeddings.${key}`, { defaultValue: fallback });
  const input =
    "w-full min-w-0 rounded-lg border border-white/10 bg-black/15 px-3 py-2 text-sm text-main outline-none focus:border-primary/50";
  return (
    <section
      id="settings-target-memory-embeddings"
      className="profile-overview-glass profile-overview-glass--soft space-y-4 rounded-2xl p-5"
    >
      <div className="flex items-start gap-3">
        <Brain className="mt-0.5 h-5 w-5 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-semibold text-main">
            {label("title", "Memory embeddings")}
          </h3>
          <p className="mt-1 text-xs text-sub">
            {label(
              "description",
              "Story memory uses the administrator's embedding connection by default. Activate a personal profile to use your own connection. Changing the vector space reindexes your memories.",
            )}
          </p>
        </div>
      </div>
      {profiles.map((p) => (
        <div key={p.id} className="rounded-xl border border-white/10 p-3">
          <div className="flex flex-wrap items-center gap-2 text-sm text-main">
            <strong className="break-all">{p.model}</strong>
            <span className="text-xs text-sub">
              {p.dimensions} {label("dimensions", "dimensions")} ·{" "}
              {label(p.status, p.status)} · {label("revision", "revision")}{" "}
              {p.revision}
            </span>
            {p.active && (
              <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">
                {label("active", "Active")}
              </span>
            )}
            {p.configurationSource === "admin" && <span className="rounded bg-primary/10 px-2 py-0.5 text-xs text-primary">{label("adminDefault", "Admin default")}</span>}
          </div>
          {p.baseUrl && <p className="mt-1 break-all text-xs text-sub">{p.baseUrl}</p>}
          {p.errorCode && (
            <p role="status" className="mt-2 text-xs text-amber-300">
              {label(
                p.errorCode,
                "The profile needs attention. Test the connection or retry migration.",
              )}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              disabled={!!busy}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-main disabled:opacity-40"
              onClick={() =>
                run(p.id, async () => {
                  await request(`/${p.id}/test`, {});
                  setMessage(
                    label("testPassed", "Embedding connection verified"),
                  );
                })
              }
            >
              {label("test", "Test connection")}
            </button>
            {!p.active && p.configurationSource !== "admin" && (
              <button
                disabled={!!busy}
                className="rounded-lg bg-primary/15 px-3 py-1.5 text-xs text-primary disabled:opacity-40"
                onClick={() =>
                  run(p.id, async () => {
                    await request(`/${p.id}/activate`, {});
                  })
                }
              >
                {label("activate", "Reindex and activate")}
              </button>
            )}
            {p.configurationSource === "admin" && p.adminDefaultUpdateAvailable && <button
              disabled={!!busy} className="rounded-lg bg-primary/15 px-3 py-1.5 text-xs text-primary disabled:opacity-40"
              onClick={() => run(p.id, async () => { await request(`/${p.id}/reindex`, {}); })}
            >{label("updateAdminDefault", "Reindex with updated admin default")}</button>}
            {p.configurationSource !== "admin" && <details className="text-xs text-sub">
              <summary className="cursor-pointer px-2 py-1.5">
                {label("key", "API key")}{" "}
                {p.hasKey ? "••••••••" : label("noKey", "None")}
              </summary>
              <form
                className="mt-2 flex flex-wrap gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  const form = e.currentTarget;
                  const key = String(new FormData(form).get("key") ?? "");
                  run(p.id, async () => {
                    await request(`/${p.id}/key`, { apiKey: key }, "PUT");
                    form.reset();
                  });
                }}
              >
                <input
                  name="key"
                  type="password"
                  autoComplete="new-password"
                  aria-label={label("replacementKey", "Replacement API key")}
                  className={input}
                />
                <button
                  disabled={!!busy}
                  className="rounded border border-white/10 px-3 py-2"
                >
                  {label("saveKey", "Replace key")}
                </button>
              </form>
            </details>}
            {busy === p.id && (
              <Loader2 className="h-4 w-4 animate-spin text-primary" />
            )}
          </div>
        </div>
      ))}
      <button
        onClick={() => setShowForm(!showForm)}
        className="flex items-center gap-2 text-xs font-medium text-primary"
      >
        <Plus className="h-4 w-4" />
        {label("new", "New embedding profile")}
      </button>
      {showForm && (
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            run("new", async () => {
              await request("", draft);
              setShowForm(false);
              setDraft({ ...draft, apiKey: "" });
            });
          }}
        >
          <label className="block space-y-1 text-xs text-sub">
            <span>{label("endpoint", "OpenAI-compatible endpoint")}</span>
            <input
              required
              type="url"
              placeholder="http://localhost:8000/v1"
              value={draft.baseUrl}
              onChange={(e) => setDraft({ ...draft, baseUrl: e.target.value })}
              className={input}
            />
          </label>
          <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
            <label className="block space-y-1 text-xs text-sub">
              <span>{label("model", "Embedding model")}</span>
              <input
                required
                value={draft.model}
                onChange={(e) => setDraft({ ...draft, model: e.target.value })}
                className={input}
              />
            </label>
            <label className="block space-y-1 text-xs text-sub">
              <span>{label("dimensions", "Dimensions")}</span>
              <input
                required
                type="number"
                min={1}
                max={16000}
                step={1}
                value={draft.dimensions}
                onChange={(e) =>
                  setDraft({ ...draft, dimensions: Number(e.target.value) })
                }
                className={input}
              />
            </label>
          </div>
          <label className="block space-y-1 text-xs text-sub">
            <span>{label("optionalKey", "API key (optional)")}</span>
            <input
              type="password"
              autoComplete="new-password"
              value={draft.apiKey ?? ""}
              onChange={(e) => setDraft({ ...draft, apiKey: e.target.value })}
              className={input}
            />
          </label>
          <label className="flex items-start gap-2 text-xs text-sub">
            <Checkbox

              checked={draft.sendDimensions}
              onCheckedChange={(checked) =>
                setDraft({ ...draft, sendDimensions: (checked === true) })}
            />
            {label(
              "sendDimensions",
              "Send the dimensions parameter to the endpoint",
            )}
          </label>
          <button
            disabled={!!busy}
            className="rounded-lg bg-primary/15 px-4 py-2 text-sm text-primary disabled:opacity-40"
          >
            {busy === "new"
              ? label("saving", "Saving…")
              : label("save", "Save profile")}
          </button>
        </form>
      )}
      {message && (
        <p role="status" className="break-words text-xs text-sub">
          {message}
        </p>
      )}
    </section>
  );
}
