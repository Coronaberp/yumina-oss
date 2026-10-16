import { characterIdentifiers, displayCharacterName } from "./speaker-tag";
import { messagePassages } from "./passages";

const characters = entries => (entries || []).filter(entry => entry.role === "character" && entry.enabled !== false);
const normalized = value => String(value || "").trim().replace(/[-_\s]+/g, " ").toLowerCase();
const escaped = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function identities(entries) {
  const list = characters(entries);
  return characterIdentifiers(list.map(entry => displayCharacterName(entry.name)))
    .map(identity => ({ ...identity, id: list.find(entry => displayCharacterName(entry.name) === identity.name)?.id }));
}

export function charactersInPassages(entries, lines) {
  const aliases = identities(entries);
  return [...new Set((lines || []).filter(line => !line.player && (line.stageName || line.name) && line.name !== "NPC")
    .map(line => aliases.find(identity => normalized(identity.identifier) === normalized(line.stageName || line.name))?.id).filter(Boolean))];
}

/** Filter only the presentation config; values, formats, colors and custom
 * layout source remain unchanged. characterId explicitly associates a field. */
export function visibleCharacterStatus(config, entries, metIds, preview = false) {
  if (preview || !config || !Array.isArray(config.fields)) return config;
  const list = characters(entries), aliases = identities(entries), met = new Set(metIds || []);
  const owns = field => {
    if (typeof field.characterId === "string" && field.characterId) return [field.characterId];
    const text = normalized(`${field.variableId || ""} ${field.path || ""} ${field.label || ""}`);
    const owners = new Set();
    for (const entry of list) {
      const names = [entry.id, ...aliases.filter(alias => alias.id === entry.id).map(alias => alias.identifier)];
      if (names.some(name => name && new RegExp(`(^|[^\\p{L}\\p{N}])${escaped(normalized(name))}($|[^\\p{L}\\p{N}])`, "iu").test(text))) owners.add(entry.id);
    }
    return [...owners];
  };
  const fields = config.fields.filter(field => owns(field).every(id => met.has(id)));
  const groups = Array.isArray(config.groups) ? config.groups.filter(group => owns({ label: group.label, variableId: group.id }).every(id => met.has(id))) : config.groups;
  return fields.length === config.fields.length && (!groups || groups.length === config.groups.length) ? config : { ...config, fields, groups };
}

/** The latest reply is revealed page by page. Prior replies are already read.
 * A local, swipe-scoped journal retains encounters when scrolling backwards;
 * older paginated turns are checked read-only through the host, without AI. */
export function useMetCharacters(api, currentMessage, readLines, inspectHistory) {
  const latest = [...(api.messages || [])].reverse().find(message => message.role === "assistant" && message.status !== "failed");
  const key = `${api.sessionId || "preview"}:${latest?.id || "greeting"}:${latest?.activeSwipeIndex || 0}`;
  const storageKey = `vn:${api.sessionId}:met-characters`;
  const [journal, setJournal] = React.useState({ key: "", ids: [], ready: false });
  const [historical, setHistorical] = React.useState({ key: "", ids: [] });
  const visible = charactersInPassages(api.entries, readLines);
  const visibleKey = [...visible].sort().join("\n");
  const previous = React.useMemo(() => {
    const messages = api.messages || [], at = latest ? messages.findIndex(message => message.id === latest.id) : 0;
    return [...new Set(messages.slice(0, Math.max(0, at)).filter(message => message.role === "assistant" && message.status !== "failed")
      .flatMap(message => charactersInPassages(api.entries, messagePassages(api, message))))];
  }, [api.messages, api.entries, latest?.id]);
  React.useEffect(() => {
    let cancelled = false;
    const load = api.sessionId && api.storage?.get ? api.storage.get(storageKey) : Promise.resolve(null);
    Promise.resolve(load).then(raw => {
      let saved;
      try { saved = JSON.parse(raw || "null"); } catch {}
      if (!cancelled) setJournal(previous => ({ key, ready: true, ids: [...new Set([
        ...(saved?.key === key && Array.isArray(saved.ids) ? saved.ids.filter(id => typeof id === "string") : []),
        ...(previous.key === key ? previous.ids : []), ...visible,
      ])] }));
    }).catch(() => { if (!cancelled) setJournal({ key, ids: visible, ready: true }); });
    return () => { cancelled = true; };
  }, [key]);
  React.useEffect(() => {
    setJournal(previous => {
      if (previous.key !== key || !previous.ready || visible.every(id => previous.ids.includes(id))) return previous;
      return { ...previous, ids: [...new Set([...previous.ids, ...visible])] };
    });
  }, [key, visibleKey]);
  React.useEffect(() => {
    if (journal.key !== key || !journal.ready || !api.sessionId || api.readOnly || !api.storage?.set) return;
    api.storage.set(storageKey, JSON.stringify({ key, ids: journal.ids })).catch(() => {});
  }, [key, journal]);
  React.useEffect(() => {
    if (!inspectHistory || historical.key === key || !api.hasEarlierMessages || !latest?.id || typeof api.getCharacterEncounters !== "function") return;
    let cancelled = false;
    api.getCharacterEncounters(latest.id).then(ids => {
      if (!cancelled && Array.isArray(ids)) setHistorical({ key, ids: ids.filter(id => typeof id === "string") });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [key, inspectHistory, api.hasEarlierMessages]);
  return [...new Set([...previous, ...visible, ...(journal.key === key ? journal.ids : []), ...(historical.key === key ? historical.ids : [])])];
}
