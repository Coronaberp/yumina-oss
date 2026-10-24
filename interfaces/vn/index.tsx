import { useAutoReading } from "./auto-reading";
import { ModelRoutingDetails } from "./model-routing-details";
import { TurnDetails } from "./turn-details";
import { VnTextSettings, VnTextStyle } from "./text-settings";
import { portraitRef } from "./portrait-ref";
import { usePersonaControl, PersonaControlSetting } from './persona-control';
import { draftPersonaChoice } from './persona-choice-assistance';
import { styles } from "./styles";
import { vnDialogTheme } from "./dialog-theme";
import { playerText } from "./player";
import { controls, choiceIcon, fallbacks } from "./controls";
import { passages, messagePassages, segmentPassages, messageChoices, playerChoicePassages } from "./passages";
import { sceneSprites, spriteKey } from "./sprites";
import { useSpritePresence, SpriteSlot } from "./sprite-stage";
import { backgroundFor } from "./scenes";
import { fontRef } from "./font";
import { menuRef } from "./menu-asset";
import { displayCharacterName } from "./speaker-tag";
import { CharacterCopy, CharacterViewer, useCharacterViewer, characterViewerStyles } from "./character-viewer";
import { SaveCheckpoint } from "./checkpoints";
import { SpeakerName } from "./speaker-name";
import { npcPortraits } from "./portraits";
import { StatusSheet } from "./status-sheet";
import { ChoiceText, plainChoiceText } from "./choice-text";
import { canSelectPersona } from "./persona-menu";
import { LoadingStatus } from "./loading-status";
import { ReplyMetrics } from "./reply-metrics-view";
import { TurnPicker } from "./turn-picker";
import { usePassageReading } from "./reading";
import { useMetCharacters, visibleCharacterStatus } from "./character-visibility";
import { npcSpeakerLabels } from "./npc-display-name";

function Control({ name, onClick, active }) {
  const icon = name === "Route" ? <span className="vn-control-icon" aria-hidden="true"><Icons.Map strokeWidth={1.2} /></span> : <span className="vn-control-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: controls[name.toLowerCase()] }} />;
  return <button className={`vn-control ${name.toLowerCase()}`} aria-label={name} aria-haspopup={name === "Route" ? "dialog" : undefined} aria-pressed={name === "Auto" ? active : undefined} title={name} onClick={onClick}>
    {name === "Log" ? <>{icon}<span>{name}</span></> : <><span>{name}</span>{icon}</>}
  </button>;
}

function Copy(props) {
  return <CharacterCopy {...props} />;
}

function Portrait({ api, assetRef, name, player, npcGender }) {
  const characters = (api.entries || []).filter(e => e.role === "character" && e.enabled !== false);
  const variant = player ? "sage" : characters.findIndex(e => displayCharacterName(e.name) === name) % 2 === 1 ? "mauve" : "gold";
  if (!assetRef && !player && name === "NPC" && !npcGender) return null;
  const portrait = assetRef || (!player && name === "NPC" ? npcPortraits[npcGender] || npcPortraits.male : null);
  return portrait ? <img className="vn-avatar" src={api.resolveAssetUrl(portraitRef(portrait))} alt="" decoding="async" /> : <span className="vn-avatar" aria-hidden="true" dangerouslySetInnerHTML={{ __html: fallbacks[variant] }} />;
}

function Thinking({ api, text }) {
  const [open, setOpen] = React.useState(false);
  if (!text) return null;
  return <div className="vn-thinking"><button aria-expanded={open} onClick={() => setOpen(!open)} aria-label="Thinking">{open ? "▾" : "▸"} Thinking</button>{open && <pre>{playerText(text, api.user?.name)}</pre>}</div>;
}

function MenuIcon({ api, name }) {
  const crops = { resume: [1461,269], save: [1461,383], load: [1461,474], settings: [1461,571], exit: [1461,943], close: [1828,42] };
  const crop = crops[name];
  return <span className={`vn-menu-icon ${name}`} aria-hidden="true" style={{ backgroundImage: `url("${api.resolveAssetUrl(menuRef)}")`, backgroundPosition: `-${crop[0]}px -${crop[1]}px` }} />;
}

function DialogueLog({ api, onClose, currentTurnId, onCharacter, blocked }) {
  // Keep the metadata cheap. Passage parsing and rich text belong to the window.
  const PAGE_TURNS = 5, MAX_MOUNTED_TURNS = 10;
  const messages = React.useMemo(() => api.messages?.length ? api.messages : api.greetingContent ? [{ id: "greeting", role: "assistant", content: api.greetingContent }] : [], [api.messages, api.greetingContent]);
  const metadata = React.useMemo(() => {
    const turnIds = new Map(), groups = [], byId = new Map();
    let nextTurnId = "pending";
    for (let index = messages.length - 1; index >= 0; index--) {
      if (messages[index].role === "assistant") nextTurnId = messages[index].id;
      turnIds.set(messages[index].id, nextTurnId);
    }
    for (const message of messages) {
      if (message.role === "system") continue;
      const id = turnIds.get(message.id);
      let group = byId.get(id);
      if (!group) { group = { id, messages: [] }; byId.set(id, group); groups.push(group); }
      group.messages.push(message);
    }
    return { groups, indices: new Map(groups.map((group, index) => [group.id, index])), replies: messages.filter(message => message.role === "assistant"), pending: byId.has("pending") };
  }, [messages]);
  const initialWindow = () => {
    const current = metadata.indices.get(currentTurnId) ?? Math.max(0, metadata.groups.length - 1);
    const start = Math.max(0, Math.min(current - 2, metadata.groups.length - PAGE_TURNS));
    return { first: metadata.groups[start]?.id, last: metadata.groups[Math.min(metadata.groups.length - 1, start + PAGE_TURNS - 1)]?.id };
  };
  const [windowIds, setWindowIds] = React.useState(initialWindow);
  const [characters, setCharacters] = React.useState([]);
  const [turn, setTurn] = React.useState("");
  const [loadingEarlier, setLoadingEarlier] = React.useState(false);
  const [historyError, setHistoryError] = React.useState("");
  const scroll = React.useRef(null), tail = React.useRef(null);
  const cache = React.useRef(new Map()), seenSpeakers = React.useRef(new Map());
  const pendingAnchor = React.useRef(null), remoteRequest = React.useRef(null);
  const positionRequest = React.useRef("current"), pagingArmed = React.useRef(false), lastScrollTop = React.useRef(0);
  const live = React.useRef(null);
  const first = metadata.indices.get(windowIds.first) ?? 0;
  const last = metadata.indices.get(windowIds.last) ?? Math.min(metadata.groups.length - 1, first + PAGE_TURNS - 1);
  const selectedGroups = React.useMemo(() => turn ? metadata.groups.filter(group => group.id === turn) : metadata.groups.slice(first, last + 1), [metadata, turn, first, last]);
  const speakerKey = line => line.player ? "player" : line.kind === "dialogue" ? `character:${line.name || "NPC"}` : "narrator";
  const rows = React.useMemo(() => selectedGroups.flatMap(group => group.messages.map(message => {
    const swipe = message.swipes?.[message.activeSwipeIndex || 0];
    const previous = cache.current.get(message.id);
    if (previous && previous.content === message.content && previous.raw === swipe?.rawContent && previous.swipe === (message.activeSwipeIndex || 0) && previous.entries === api.entries && previous.userName === api.user?.name && previous.userAvatar === api.user?.avatar && previous.message === message) return previous.row;
    const reusable = previous && previous.content === message.content && previous.raw === swipe?.rawContent && previous.swipe === (message.activeSwipeIndex || 0) && previous.entries === api.entries && previous.userName === api.user?.name && previous.userAvatar === api.user?.avatar;
    const lines = reusable ? previous.row.lines : message.role === "user" ? [] : messagePassages(api, message);
    const row = { message, turnId: group.id, lines };
    cache.current.set(message.id, { row, message, content: message.content, raw: swipe?.rawContent, swipe: message.activeSwipeIndex || 0, entries: api.entries, userName: api.user?.name, userAvatar: api.user?.avatar });
    return row;
  })), [selectedGroups, api.entries, api.user?.name, api.user?.avatar]);
  // Discover incidental speakers as turns are visited, without parsing older turns.
  for (const row of rows) {
    if (row.message.role === "user") seenSpeakers.current.set("player", { name: api.user?.name ? `${api.user.name} (You)` : "You", portrait: api.user?.avatar, player: true });
    for (const line of row.lines) {
      const key = speakerKey(line);
      if (key === "narrator") seenSpeakers.current.set(key, { name: "Narration" });
      else seenSpeakers.current.set(key, { name: line.name || "NPC", portrait: line.portrait, npcGender: line.npcGender, player: line.player });
    }
  }
  const filtered = !!turn || characters.length > 0;
  const visible = React.useMemo(() => rows.map(row => ({ ...row, sourceLines: row.lines, lines: row.lines.filter(line => !characters.length || characters.includes(speakerKey(line))) })).filter(row => row.message.role === "user" ? !characters.length || characters.includes("player") : row.lines.length > 0 || !characters.length && !!row.message.swipes?.[row.message.activeSwipeIndex || 0]?.reasoningContent), [rows, characters]);
  const captureAnchor = () => {
    const node = scroll.current;
    if (!node) return null;
    const top = node.getBoundingClientRect().top;
    const row = [...node.querySelectorAll("[data-message-id]")].find(element => element.getBoundingClientRect().bottom > top);
    return row ? { id: row.dataset.messageId, offset: row.getBoundingClientRect().top - top } : null;
  };
  const setRange = (start, end) => setWindowIds({ first: metadata.groups[start]?.id, last: metadata.groups[end]?.id });
  const revealEarlier = async () => {
    if (remoteRequest.current || loadingEarlier || api.isLoadingEarlier) return;
    setHistoryError("");
    if (!turn && first > 0) {
      pendingAnchor.current = captureAnchor();
      const start = Math.max(0, first - PAGE_TURNS);
      setRange(start, Math.min(last, start + MAX_MOUNTED_TURNS - 1));
      return;
    }
    if (!api.hasEarlierMessages) return;
    pendingAnchor.current = captureAnchor();
    const request = { oldestId: messages[0]?.id, windowFirst: windowIds.first, filteredTurn: turn };
    remoteRequest.current = request;
    setLoadingEarlier(true);
    try {
      const loaded = await api.loadEarlierMessages();
      if (!loaded && remoteRequest.current === request) { remoteRequest.current = null; pendingAnchor.current = null; setLoadingEarlier(false); setHistoryError("Could not load earlier dialogue. Try again."); }
    } catch {
      if (remoteRequest.current === request) { remoteRequest.current = null; pendingAnchor.current = null; setLoadingEarlier(false); setHistoryError("Could not load earlier dialogue. Try again."); }
    }
  };
  const revealLater = () => {
    if (turn || last >= metadata.groups.length - 1 || remoteRequest.current) return;
    pendingAnchor.current = captureAnchor();
    const end = Math.min(metadata.groups.length - 1, last + PAGE_TURNS);
    setRange(Math.max(first, end - MAX_MOUNTED_TURNS + 1), end);
  };
  live.current = { api, onCharacter, revealEarlier, revealLater };
  React.useEffect(() => () => { remoteRequest.current = null; }, []);
  const openCharacter = React.useCallback((...args) => live.current.onCharacter?.(...args), []);
  React.useLayoutEffect(() => {
    const request = remoteRequest.current;
    if (!request) return;
    if (messages[0]?.id !== request.oldestId) {
      remoteRequest.current = null; setLoadingEarlier(false);
      if (!request.filteredTurn) {
        const previousFirst = metadata.indices.get(request.windowFirst) ?? first;
        const start = Math.max(0, previousFirst - PAGE_TURNS);
        setRange(start, Math.min(last, start + MAX_MOUNTED_TURNS - 1));
      }
    } else if (!api.hasEarlierMessages && !api.isLoadingEarlier) {
      remoteRequest.current = null; pendingAnchor.current = null; setLoadingEarlier(false);
    }
  }, [metadata, api.hasEarlierMessages, api.isLoadingEarlier]);
  React.useEffect(() => {
    if (turn && !metadata.indices.has(turn)) { positionRequest.current = "current"; setTurn(""); setWindowIds(initialWindow()); }
    if (!metadata.indices.has(windowIds.first) || !metadata.indices.has(windowIds.last)) { positionRequest.current = "current"; setWindowIds(initialWindow()); }
    const ids = new Set(messages.map(message => message.id));
    for (const id of cache.current.keys()) if (!ids.has(id)) cache.current.delete(id);
  }, [metadata, turn, windowIds.first, windowIds.last]);
  React.useLayoutEffect(() => {
    const node = scroll.current;
    if (!node || !tail.current) return;
    tail.current.style.height = "0px";
    const target = !filtered && [...node.querySelectorAll("[data-turn-id]")].find(element => element.dataset.turnId === currentTurnId);
    if (target) {
      const remaining = tail.current.getBoundingClientRect().top - target.getBoundingClientRect().top + (parseFloat(window.getComputedStyle(node).paddingBottom) || 0);
      tail.current.style.height = `${Math.max(0, node.clientHeight - remaining)}px`;
    }
    if (positionRequest.current) {
      node.scrollTop = positionRequest.current === "current" && target ? node.scrollTop + target.getBoundingClientRect().top - node.getBoundingClientRect().top : 0;
      positionRequest.current = null; pendingAnchor.current = null;
    } else if (pendingAnchor.current && !remoteRequest.current) {
      const anchor = pendingAnchor.current;
      const row = [...node.querySelectorAll("[data-message-id]")].find(element => element.dataset.messageId === anchor.id);
      if (row) node.scrollTop += row.getBoundingClientRect().top - node.getBoundingClientRect().top - anchor.offset;
      pendingAnchor.current = null;
    }
    lastScrollTop.current = node.scrollTop;
    pagingArmed.current = false;
  }, [rows, characters, currentTurnId, turn]);
  const changeTurn = value => {
    pendingAnchor.current = null; positionRequest.current = value ? "top" : "current";
    setTurn(value); if (!value) setWindowIds(initialWindow());
  };
  const changeCharacters = update => { pendingAnchor.current = null; positionRequest.current = "top"; setCharacters(update); };
  const resetFilters = () => { positionRequest.current = "current"; pendingAnchor.current = null; setTurn(""); setCharacters([]); setWindowIds(initialWindow()); };
  const handleScroll = event => {
    const node = event.currentTarget, previous = lastScrollTop.current;
    lastScrollTop.current = node.scrollTop;
    if (!pagingArmed.current || turn || historyError) return;
    if (node.scrollTop < previous && node.scrollTop <= 80) { pagingArmed.current = false; void live.current.revealEarlier(); }
    else if (node.scrollTop > previous && node.scrollHeight - node.scrollTop - node.clientHeight <= 80) { pagingArmed.current = false; live.current.revealLater(); }
  };
  const renderedRows = React.useMemo(() => visible.map(({ message, lines, sourceLines }) => {
    const npcLabels = npcSpeakerLabels(api, message, sourceLines);
    const contextFor = line => ({ messageId: message.id, lines: sourceLines.slice(0, sourceLines.indexOf(line) + 1) });
    const swipe = message.swipes?.[message.activeSwipeIndex || 0];
    if (message.role === "user") return <div key={message.id} data-message-id={message.id} className="vn-log-row choice">
      <div className="vn-log-speaker"><Portrait api={api} assetRef={api.user?.avatar} player /><div className="vn-player-speaker"><SpeakerName name={api.user?.name || "You"} suffix={api.user?.name ? " (You)" : ""} className="vn-speaker-name" /><div className="vn-choice-caption">CHOICE</div></div></div>
      <Copy api={api} text={message.content} className="vn-log-copy" />
    </div>;
    return <div key={message.id} data-message-id={message.id}>
      <div data-turn-id={message.id} aria-hidden="true" />
      {!characters.length && <Thinking api={api} key={`${message.id}:${message.activeSwipeIndex || 0}`} text={swipe?.reasoningContent} />}
      {!characters.length && <TurnDetails key={`details:${message.id}:${message.activeSwipeIndex || 0}`} message={message} lines={sourceLines} />}
      {lines.map((line, index) => line.kind === "dialogue" ? <div key={index} className="vn-log-row">
        <div className="vn-log-speaker"><Portrait api={api} assetRef={line.portrait} name={line.name} player={line.player} npcGender={line.npcGender} /><SpeakerName name={npcLabels[sourceLines.indexOf(line)] || line.name || "NPC"} className="vn-speaker-name" /></div>
        <Copy api={api} text={line.text} className="vn-log-copy" context={contextFor(line)} onCharacter={openCharacter} />
      </div> : <Copy key={index} api={api} text={line.text} className="vn-narration" context={contextFor(line)} onCharacter={openCharacter} />)}
    </div>;
  }), [api, visible, characters, api.entries, api.user?.name, api.user?.avatar, api.renderMarkdown, api.resolveAssetUrl, openCharacter]);
  const hasOlderLocal = !turn && first > 0, hasNewerLocal = !turn && last < metadata.groups.length - 1;
  return <section className="vn-overlay vn-log" role="dialog" aria-modal={!blocked} aria-label="Dialogue log" inert={blocked || undefined}>
    <header className="vn-log-toolbar">
      <div className="vn-log-header">Dialogue log</div>
      <button className="vn-close" aria-label="Close log" onClick={onClose}><Icons.X /></button>
      <div className="vn-log-filters">
        <div className="vn-log-filter-heading">
          <div className="vn-log-turn-filter"><span>Turn</span><TurnPicker value={turn} onChange={changeTurn} replies={metadata.replies} currentTurnId={currentTurnId} pending={metadata.pending} /></div>
          {filtered && <button className="vn-log-reset" onClick={resetFilters}>Reset filters</button>}
        </div>
        <div className="vn-log-character-filters" role="group" aria-label="Filter by character">
          <button className="vn-log-chip" aria-label="All characters" aria-pressed={!characters.length} onClick={() => changeCharacters([])}>All</button>
          {[...seenSpeakers.current].map(([key, speaker]) => <button key={key} className="vn-log-chip" aria-pressed={characters.includes(key)} onClick={() => changeCharacters(selected => selected.includes(key) ? selected.filter(value => value !== key) : [...selected, key])}>
            {key !== "narrator" && <Portrait api={api} assetRef={speaker.portrait} name={speaker.player ? undefined : speaker.name} player={speaker.player} npcGender={speaker.npcGender} />}
            <span>{speaker.name}</span>
          </button>)}
        </div>
      </div>
    </header>
    <div className="vn-log-body"><div className="vn-log-scroll" ref={scroll} onScroll={handleScroll} onTouchMove={() => { pagingArmed.current = true; }} onKeyDown={() => { pagingArmed.current = true; }} onWheel={event => {
      pagingArmed.current = true;
      const node = event.currentTarget;
      if (!turn && !historyError && event.deltaY < 0 && node.scrollTop <= 80) { pagingArmed.current = false; void live.current.revealEarlier(); }
      else if (!turn && event.deltaY > 0 && node.scrollHeight - node.scrollTop - node.clientHeight <= 80) { pagingArmed.current = false; live.current.revealLater(); }
    }}>
      {(hasOlderLocal || api.hasEarlierMessages) && <button className="vn-load-earlier" disabled={loadingEarlier || api.isLoadingEarlier} onClick={() => void revealEarlier()}>{loadingEarlier || api.isLoadingEarlier ? "Loading…" : "Load earlier dialogue"}</button>}
      {historyError && <div className="vn-log-empty" role="alert">{historyError}</div>}
      {!visible.length && <div className="vn-log-empty" role="status">{hasOlderLocal || hasNewerLocal || api.hasEarlierMessages ? "No dialogue matches in these turns. Load more dialogue to continue filtering." : "No dialogue matches these filters."}</div>}
      {renderedRows}
      {hasNewerLocal && <button className="vn-load-earlier vn-load-newer" onClick={revealLater}>Load newer dialogue</button>}
      <div ref={tail} aria-hidden="true" />
    </div></div>
  </section>;
}

function Menu({ api, currentMessage, onClose, setPanel, settings, onSetting, busy, run, onRestore }) {
  const personaAvailable = canSelectPersona(api);
  return <section className="vn-overlay vn-menu-overlay" role="dialog" aria-modal="true" aria-label="Story menu">
    <button className="vn-menu-shade" onClick={onClose} aria-label="Resume story from backdrop" />
    <button className="vn-close vn-menu-close" aria-label="Close menu" onClick={onClose}>Close<MenuIcon api={api} name="close" /></button>
    <aside className="vn-drawer">
      <div className="vn-brand">{api.worldName}</div>
      <h1 className="vn-menu-title">{settings.panel === "load" ? "Load" : settings.panel === "settings" ? "Settings" : "Menu"}</h1>
      <div className="vn-rule" />
      {settings.panel === "menu" ? <>
        <nav className="vn-menu-list" aria-label="Story controls">
          <button className="vn-menu-item resume" onClick={onClose}><MenuIcon api={api} name="resume" /><span>Resume story</span></button>
          <div className="vn-menu-action-row">
            <button className="vn-menu-item vn-menu-save" aria-haspopup="dialog" disabled={busy || api.readOnly || api.isStreaming} onClick={() => setPanel("save")}><MenuIcon api={api} name="save" /><span>Save</span></button>
            <button className="vn-menu-item" disabled={busy || api.isStreaming} onClick={() => run(async () => { await api.loadCheckpoints(); setPanel("load"); })}><MenuIcon api={api} name="load" /><span>Load</span></button>
          </div>
          <div className="vn-menu-action-row">
            <button className="vn-menu-item vn-menu-status" onClick={() => setPanel("status")}><Icons.BarChart3 /><span>Status</span></button>
            {api.sessionId && !api.readOnly && <button className="vn-menu-item" onClick={() => { onClose(); api.showContentFlags(); }}><Icons.ShieldCheck /><span>Content flags</span></button>}
          </div>
          <div className="vn-menu-action-row">
            {api.sessionId && <button className="vn-menu-item vn-menu-memory" onClick={() => setPanel("memory")}><Icons.Brain /><span>Memory</span></button>}
            <button className="vn-menu-item" onClick={() => setPanel("settings")}><MenuIcon api={api} name="settings" /><span>Settings</span></button>
          </div>
          <div className="vn-menu-action-row vn-menu-persona-row" style={{ gridTemplateColumns: "repeat(2,minmax(0,1fr))" }}>
            {personaAvailable && <button className="vn-menu-item vn-menu-persona" onClick={() => { onClose(); api.openPersonaManager(); }}><Icons.UserRound /><span>Persona</span></button>}
            <button type="button" className="vn-menu-item vn-menu-export" style={{ gridColumn: personaAvailable ? 2 : "1 / -1", justifySelf: personaAvailable ? undefined : "center", width: personaAvailable ? undefined : "fit-content" }} aria-haspopup="dialog" disabled={!api.sessionId || api.readOnly || api.isStreaming} onClick={() => { onClose(); api.openSessionExport(); }}><Icons.Download /><span>Export</span></button>
          </div>
        </nav>
        <div className="vn-display-controls" aria-label="Display controls">
          {api.canSystemFullscreen && <button onClick={() => run(() => api.toggleSystemFullscreen())} disabled={busy}>
            <Icons.Maximize size={20} /><span>{api.systemFullscreen ? "Exit browser fullscreen" : "Browser fullscreen"}</span>
          </button>}
          <button onClick={() => api.toggleImmersive()}>{api.isImmersive ? <Icons.Minimize size={20} /> : <Icons.Maximize size={20} />}<span>{api.isImmersive ? "Windowed view" : "Fullscreen view"}</span></button>
        </div>
        <div className="vn-menu-bottom"><div className="vn-rule" /><button className="vn-menu-item" onClick={() => api.navigate(`/app/library?worldId=${api.worldId}`)}><MenuIcon api={api} name="exit" /><span>Return to title</span></button></div>
      </> : <>
        <button className="vn-back" onClick={() => setPanel("menu")}><Icons.ArrowLeft size={20} />Back to menu</button>
        <div className="vn-subpanel">
          {settings.panel === "load" ? <>
            <p>Loading returns to the first page of the saved reply.</p>
            {api.checkpoints?.length ? api.checkpoints.map(checkpoint => <button key={checkpoint.id} disabled={busy || api.readOnly} aria-label={checkpoint.name} onClick={() => run(async () => { await api.restoreCheckpoint(checkpoint.id); onRestore(); onClose(); })}>
              {checkpoint.name}<small>{new Date(checkpoint.createdAt).toLocaleString()} · {checkpoint.messageCount} messages</small>
            </button>) : <p>No saved stories yet.</p>}
          </> : <>
            <VnTextSettings api={api} onResetLegacy={() => onSetting("textSize", 27)} />
            <label className="vn-setting">Auto pace<select value={settings.autoDelay} onChange={e => onSetting("autoDelay", Number(e.target.value))}><option value={2500}>Fast</option><option value={4500}>Default</option><option value={7000}>Slow</option></select></label>
            <label className="vn-setting vn-setting-toggle"><span>Show token statistics</span><input type="checkbox" checked={settings.showTokenStatistics} onChange={e => onSetting("showTokenStatistics", e.target.checked)} /></label>
            <PersonaControlSetting api={api} control={settings.personaControl} busy={busy} />
            <label className="vn-setting">Music<input type="range" min="0" max="1" step=".05" defaultValue={api.getAudioVolume("bgm")} onChange={e => api.setAudioVolume("bgm", Number(e.target.value))} /></label>
            <label className="vn-setting">Sound effects<input type="range" min="0" max="1" step=".05" defaultValue={api.getAudioVolume("sfx")} onChange={e => api.setAudioVolume("sfx", Number(e.target.value))} /></label>
            <div className="vn-setting"><button onClick={() => api.openModelPicker()}>Choose AI model</button></div>
            <ModelRoutingDetails selectedModel={api.selectedModel} message={currentMessage} />
          </>}
        </div>
      </>}
    </aside>
  </section>;
}

function Routes({ api, routes, activeIndex, onSelect, onClose }) {
  return <section className="vn-overlay vn-routes" role="dialog" aria-modal="true" aria-label="Choose a route">
    <button className="vn-menu-shade" onClick={onClose} aria-label="Dismiss routes" />
    <aside className="vn-drawer">
      <button className="vn-close vn-menu-close" aria-label="Close routes" onClick={onClose}><Icons.X /></button>
      <div className="vn-brand">{api.worldName}</div>
      <h1 className="vn-menu-title">Route</h1>
      <div className="vn-rule" />
      <div className="vn-subpanel vn-route-list">{routes.map(route => <button className="vn-route-option" key={route.index} aria-pressed={route.index === activeIndex} onClick={() => onSelect(route.index)}>{route.name}</button>)}</div>
    </aside>
  </section>;
}

export default function VN() {
  const api = useYumina();
  const personaControl = usePersonaControl(api);
  const [panel, setPanel] = React.useState("");
  const [hidden, setHidden] = React.useState(false);
  const [auto, setAuto] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [waiting, setWaiting] = React.useState(false);
  const [pendingPlayerSprite, setPendingPlayerSprite] = React.useState(null);
  const playerSpriteRequest = React.useRef(null);
  const playerSpriteRequestSequence = React.useRef(0);
  const [operationError, setOperationError] = React.useState("");
  const [generatingChoices, setGeneratingChoices] = React.useState(false);
  const [choiceError, setChoiceError] = React.useState("");
  const choiceRequest = React.useRef(false);
  const responseRequest = React.useRef(false);
  const [draft, setDraft] = React.useState("");
  const [draftingChoice, setDraftingChoice] = React.useState(false);
  const [draftError, setDraftError] = React.useState("");
  const draftRequest = React.useRef(0);
  const draftContext = React.useRef(null);
  const [textSize, setTextSize] = React.useState(27);
  const [autoDelay, setAutoDelay] = React.useState(4500);
  const [showTokenStatistics, setShowTokenStatistics] = React.useState(true);
  const [cursor, setCursor] = React.useState({ turn: "", index: 0 });
  const cursorRevision = React.useRef(0);
  const [hydrated, setHydrated] = React.useState(false);
  const [spriteLimit, setSpriteLimit] = React.useState(() => window.matchMedia?.("(max-width:600px) and (orientation:portrait)").matches ? 1 : 4);
  const view = React.useRef(null);
  const previousPanel = React.useRef("");
  const wheel = React.useRef({ lastStep: 0, lastEvent: 0, amount: 0, direction: 0 });
  const completed = React.useRef({ variables: api.variables, entries: api.entries, messages: api.messages });
  if (!api.isStreaming) completed.current = { variables: api.variables, entries: api.entries, messages: api.messages };
  const sceneApi = { ...api, ...completed.current };
  const characterViewer = useCharacterViewer(sceneApi, () => setAuto(false));
  const viewerOpen = !!characterViewer.viewer;
  const replies = (sceneApi.messages || []).filter(m => m.role === "assistant");
  const latest = replies.at(-1);
  const messageTurn = message => `${message?.id || "greeting"}:${message?.activeSwipeIndex || 0}`;
  const latestTurn = messageTurn(latest);
  const choiceTarget = React.useRef(latestTurn);
  choiceTarget.current = latestTurn;
  const previousLatest = React.useRef(latestTurn);
  const savedTurnIndex = replies.findIndex(message => messageTurn(message) === cursor.turn);
  const turnIndex = savedTurnIndex >= 0 ? savedTurnIndex : Math.max(0, replies.length - 1);
  const currentMessage = replies[turnIndex];
  const viewingLatest = !replies.length || turnIndex === replies.length - 1;
  const lastMessage = (api.messages || []).at(-1);
  const openingMessages = (api.messages || []).filter(message => message.role !== "system");
  const opening = openingMessages[0];
  const canPickRoute = !!api.sessionId && api.personaSelectable !== false && !opening?.model && !api.readOnly && !api.hasEarlierMessages && !api.isStreaming && !waiting && openingMessages.length === 1 && opening?.role === "assistant" && !!opening.swipes?.length;
  const greetings = (api.entries || []).filter(entry => entry.role === "greeting" && entry.enabled !== false).sort((a, b) => (a.position ?? Infinity) - (b.position ?? Infinity));
  const routes = canPickRoute ? opening.swipes.map((swipe, index) => ({ index, name: greetings[index]?.name?.trim() || `Route ${index + 1}` })) : [];
  const canRetry = (lastMessage?.role === "user" || lastMessage?.status === "failed") && (api.messages || []).some(message => message.role === "user");
  const error = api.error || (!api.isStreaming && lastMessage?.status === "failed" ? lastMessage.errorMessage || "Generation failed." : "") || operationError;
  const loading = !error && (waiting || api.isStreaming);
  const turn = messageTurn(currentMessage);
  const segments = viewingLatest ? segmentPassages(sceneApi) : [];
  const pendingPlayerLines = pendingPlayerSprite ? playerChoicePassages(pendingPlayerSprite.text, sceneApi.user, pendingPlayerSprite.expression) : [];
  const pendingPlayerLine = !!pendingPlayerLines.length;
  const replyLines = segments.length ? segments : currentMessage ? messagePassages(sceneApi, currentMessage) : passages(sceneApi.entries, api.greetingContent || "");
  const lines = pendingPlayerLine ? pendingPlayerLines : replyLines;
  const npcLabels = npcSpeakerLabels(sceneApi, currentMessage, lines);
  const index = Math.max(0, Math.min(pendingPlayerLine ? pendingPlayerSprite.index || 0 : cursor.turn === turn ? cursor.index : 0, lines.length - 1));
  const line = lines[index];
  const end = index >= lines.length - 1;
  const replyReady = pendingPlayerLine && end && !loading && !api.isStreaming && !error && lastMessage?.role === "assistant" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId;
  const availableChoices = (lastMessage?.role === "assistant" ? (api.pendingChoices?.length ? api.pendingChoices : messageChoices(lastMessage)) : []).filter(choice => !/^(?:\.{3}|…)\s*$/.test(choice.trim()));
  const storyActive = !api.storyProgress || api.storyProgress.status === "playing";
  const choiceReady = storyActive && viewingLatest && end && !pendingPlayerLine && !loading && !error && !!line && lastMessage?.role !== "user";
  const canChangeChoice = lastMessage?.role === "user" && !api.isStreaming && !api.readOnly;
  const recoveryReady = viewingLatest && end && !loading && !error && !!line && canChangeChoice;
  const choices = storyActive && viewingLatest && end && !pendingPlayerLine && !loading && !error ? availableChoices : [];
  const cursorKey = `vn:${api.sessionId}:cursor`;
  const background = pendingPlayerSprite ? pendingPlayerSprite.background : backgroundFor(sceneApi, line, currentMessage);
  const readLines = lines.slice(0, index + 1);
  const spriteLines = pendingPlayerSprite ? [...readLines, {
    name: sceneApi.user?.name || "You", kind: "dialogue", player: true, emotion: pendingPlayerSprite.expression,
  }] : readLines;
  const [cast, finishSpriteExit] = useSpritePresence(sceneSprites(sceneApi, spriteLines, spriteLimit, currentMessage), turn);
  draftContext.current = `${api.sessionId}:${panel}:${personaControl.mode}`;
  React.useEffect(() => { ++draftRequest.current; setDraftingChoice(false); setDraftError(""); }, [api.sessionId, panel, personaControl.mode]);

  React.useEffect(() => {
    const query = window.matchMedia?.("(max-width:600px) and (orientation:portrait)");
    if (!query) return;
    const resize = () => setSpriteLimit(query.matches ? 1 : 4);
    resize(); query.addEventListener("change", resize);
    return () => query.removeEventListener("change", resize);
  }, []);

  React.useLayoutEffect(() => {
    const node = view.current;
    if (!node) return;
    let cancelled = false;
    function layout() {
      if (cancelled) return;
      const bounds = node.getBoundingClientRect();
      const controls = node.querySelector(".vn-controls");
      const top = controls ? controls.getBoundingClientRect().bottom - bounds.top + 12 : 12;
      const dialogue = node.querySelector(".vn-dialogue"), text = node.querySelector(".vn-text"), progress = node.querySelector(".vn-progress");
      const errorBanner = node.querySelector(".vn-error");
      if (errorBanner && dialogue && text) {
        const passageBottom = Math.max(dialogue.getBoundingClientRect().bottom, progress?.getBoundingClientRect().bottom || 0);
        const chrome = passageBottom - dialogue.getBoundingClientRect().top - text.getBoundingClientRect().height;
        const lineHeight = parseFloat(window.getComputedStyle(text).lineHeight) || 44;
        node.style.setProperty("--error-max-height", `${Math.max(44, bounds.height - top - chrome - lineHeight - 36)}px`);
        const offset = parseFloat(node.style.getPropertyValue("--error-space")) || 0;
        node.style.setProperty("--error-space", `${Math.max(0, offset + passageBottom - errorBanner.getBoundingClientRect().top + 16)}px`);
      } else {
        node.style.setProperty("--error-space", "0px");
        node.style.removeProperty("--error-max-height");
      }
      const reading = [...node.querySelectorAll(".vn-dialogue,.vn-choices")].filter(element => element.getClientRects().length);
      const edge = reading.length ? Math.min(...reading.map(element => element.getBoundingClientRect().top)) : bounds.bottom - bounds.height * .19;
      node.style.setProperty("--cast-top", `${top}px`);
      if (dialogue) {
        const bottom = bounds.bottom - dialogue.getBoundingClientRect().top + 16;
        node.style.setProperty("--choices-bottom", `${bottom}px`);
        node.style.setProperty("--choices-max-height", `${Math.max(44, bounds.height - bottom - top)}px`);
      }
      node.style.setProperty("--reading-shade-height", `${Math.min(bounds.height, Math.max(0, bounds.bottom - edge + 80))}px`);
    }
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(layout);
    [node, ...node.querySelectorAll(".vn-dialogue,.vn-progress,.vn-choices,.vn-controls,.vn-error")].forEach(element => observer?.observe(element));
    window.addEventListener("resize", layout);
    document.fonts?.ready.then(layout);
    layout();
    return () => { cancelled = true; observer?.disconnect(); window.removeEventListener("resize", layout); };
  }, [turn, index, textSize, choices.length, hidden, spriteLimit, error, JSON.stringify(api.vnTextPreferences)]);

  React.useEffect(() => {
    let cancelled = false;
    const revision = cursorRevision.current;
    setHydrated(false);
    Promise.all([api.storage.get(cursorKey).then(value => value || api.storage.get(`stay-gold-vn:${api.sessionId}:cursor`)), api.storage.get("vn:settings").then(value => value || api.storage.get("stay-gold-vn:settings"))]).then(([saved, prefs]) => {
      if (cancelled) return;
      try { const value = JSON.parse(saved || "null"); if (revision === cursorRevision.current && value && typeof value.turn === "string" && Number.isInteger(value.index) && value.index >= 0) setCursor(value); } catch {}
      try { const value = JSON.parse(prefs || "null"); if ([23,27,32].includes(value?.textSize)) setTextSize(value.textSize); if ([2500,4500,7000].includes(value?.autoDelay)) setAutoDelay(value.autoDelay); setShowTokenStatistics(value?.showTokenStatistics !== false); } catch {}
      setHydrated(true);
    }).catch(() => { if (!cancelled) setHydrated(true); });
    return () => { cancelled = true; };
  }, [cursorKey]);

  React.useEffect(() => {
    if (hydrated && !api.isStreaming && !pendingPlayerSprite) api.storage.set(cursorKey, JSON.stringify({ turn, index })).catch(() => {});
  }, [hydrated, cursorKey, turn, index, api.isStreaming, pendingPlayerSprite]);

  React.useEffect(() => { setWaiting(false); }, [turn, latest?.content, api.sendFailureNonce, api.error, api.isStreaming, JSON.stringify(api.pendingChoices || [])]);

  React.useEffect(() => {
    const request = playerSpriteRequest.current;
    if (!request) return;
    if (request.sessionId !== api.sessionId) {
      playerSpriteRequest.current = null;
      setPendingPlayerSprite(current => current?.id === request.id ? null : current);
      return;
    }
    const failed = api.sendFailureNonce !== request.failureNonce || !!api.error || lastMessage?.status === "failed";
    if (failed) {
      playerSpriteRequest.current = null;
      setPendingPlayerSprite(current => current?.id === request.id ? null : current);
    }
  }, [api.sessionId, api.isStreaming, api.sendFailureNonce, api.error, lastMessage?.id, lastMessage?.role, lastMessage?.status]);

  React.useEffect(() => {
    if (previousLatest.current !== latestTurn) {
      previousLatest.current = latestTurn;
      setCursor({ turn: latestTurn, index: 0 });
    }
  }, [latestTurn]);

  React.useEffect(() => {
    if (panel && view.current) { view.current.scrollTop = 0; view.current.scrollLeft = 0; }
    if (panel === "composer") view.current?.querySelector("textarea")?.focus();
    else if (panel === "routes") view.current?.querySelector(".vn-routes .vn-close")?.focus();
    else if (previousPanel.current === "routes") view.current?.querySelector(".vn-control.route")?.focus();
    else if (panel === "menu" && previousPanel.current === "memory") view.current?.querySelector(".vn-menu-memory")?.focus();
    else if (panel === "menu" && previousPanel.current === "save") view.current?.querySelector(".vn-menu-save")?.focus();
    else if (panel === "status") view.current?.querySelector(".vn-back")?.focus({ preventScroll: true });
    else if (panel === "menu" && previousPanel.current === "status") view.current?.querySelector(".vn-menu-status")?.focus({ preventScroll: true });
    else if (previousPanel.current === "composer") view.current?.querySelector(".vn-custom-choice")?.focus();
    previousPanel.current = panel;
  }, [panel]);

  React.useEffect(() => { if (panel === "routes" && !canPickRoute) setPanel(""); }, [panel, canPickRoute]);

  const scrollPassage = usePassageReading(view, turn, index, line?.text, pendingPlayerLine);
  const metCharacterIds = useMetCharacters(sceneApi, currentMessage, readLines, panel === "status");

  function advance() {
    if (hidden) { setHidden(false); return; }
    if (panel || viewerOpen || error || !line) return;
    setAuto(false);
    if (scrollPassage()) return;
    movePage(1);
  }

  function movePage(direction, manual = true) {
    if (panel || viewerOpen || error || !line) return;
    if (manual) setAuto(false);
    if (pendingPlayerLine) {
      if (direction > 0 && !end || direction < 0 && index > 0) {
        setPendingPlayerSprite(current => current ? { ...current, index: index + direction } : current);
      } else if (direction > 0 && !loading && !api.isStreaming && lastMessage?.role === "assistant" && lastMessage.id !== playerSpriteRequest.current?.baseMessageId) {
        playerSpriteRequest.current = null; setPendingPlayerSprite(null); setCursor({ turn: latestTurn, index: 0 });
      }
      return;
    }
    if (loading || api.isStreaming) return;
    if (direction > 0) {
      if (!end) setCursor({ turn, index: index + 1 });
      else if (!viewingLatest) setCursor({ turn: messageTurn(replies[turnIndex + 1]), index: 0 });
    } else if (index > 0) setCursor({ turn, index: index - 1 });
    else if (turnIndex > 0) {
      const previous = replies[turnIndex - 1];
      setCursor({ turn: messageTurn(previous), index: Math.max(0, messagePassages(sceneApi, previous).length - 1) });
    }
  }

  React.useEffect(() => {
    const node = view.current;
    function scroll(event) {
      if (panel || viewerOpen || hidden || event.target.closest(".vn-overlay,.vn-choices,.vn-control,.vn-error") || !event.deltaY || Math.abs(event.deltaX) > Math.abs(event.deltaY)) return;
      setAuto(false);
      const text = event.target.closest(".vn-text");
      if (text && text.scrollHeight > text.clientHeight + 1 && (event.deltaY > 0 ? text.scrollTop + text.clientHeight < text.scrollHeight - 1 : text.scrollTop > 0)) return;
      event.preventDefault();
      const now = Date.now(), direction = Math.sign(event.deltaY), state = wheel.current;
      if (now - state.lastEvent > 250 || direction !== state.direction) state.amount = 0;
      state.lastEvent = now; state.direction = direction;
      if (now - state.lastStep < 250) return;
      state.amount += Math.abs(event.deltaY) * (event.deltaMode === 1 ? 24 : event.deltaMode === 2 ? node.clientHeight : 1);
      if (state.amount < 40) return;
      state.amount = 0; state.lastStep = now;
      movePage(direction);
    }
    node.addEventListener("wheel", scroll, { passive: false });
    return () => node.removeEventListener("wheel", scroll);
  });

  React.useEffect(() => { setChoiceError(""); }, [latestTurn, lastMessage?.id]);

  async function retryResponse() {
    if (responseRequest.current || api.isStreaming || api.readOnly || !canRetry) return;
    responseRequest.current = true;
    setWaiting(true); setAuto(false); setOperationError("");
    try {
      if (lastMessage?.role === "user" && typeof api.retryPendingReply === "function") await api.retryPendingReply(lastMessage.id);
      else await api.continueLastMessage();
    } catch (error) { setWaiting(false); setOperationError(error?.message || "Could not retry the reply."); }
    finally { responseRequest.current = false; }
  }

  async function changePendingChoice() {
    if (responseRequest.current || !canChangeChoice || busy) return;
    responseRequest.current = true; setBusy(true); setAuto(false); setOperationError("");
    try {
      if (!await api.deleteMessage(lastMessage.id)) throw new Error("Could not restore the choices. Please try again.");
    } catch (error) { setOperationError(error?.message || "Could not restore the choices."); }
    finally { responseRequest.current = false; setBusy(false); }
  }

  async function generateChoices() {
    if (choiceRequest.current || api.readOnly || !choiceReady || availableChoices.length || !lastMessage?.id) return;
    choiceRequest.current = true;
    const target = latestTurn;
    setGeneratingChoices(true); setChoiceError(""); setAuto(false);
    try {
      if (typeof api.generateChoices !== "function") throw new Error("Reload the app after updating the server to generate choices.");
      await api.generateChoices(lastMessage.id);
    } catch (error) {
      if (choiceTarget.current === target) setChoiceError(error?.message || "Could not generate choices. Please try again.");
    } finally { choiceRequest.current = false; setGeneratingChoices(false); }
  }

  function choose(choice, approved = false) {
    if (waiting || api.isStreaming || api.readOnly || choiceRequest.current || !personaControl.ready || personaControl.saving) return;
    if (personaControl.mode === "assisted" && !approved) { setDraft(choice); setDraftError(""); setAuto(false); setPanel("composer"); return; }
    const request = {
      id: ++playerSpriteRequestSequence.current,
      sessionId: api.sessionId,
      baseMessageId: lastMessage?.id,
      failureNonce: api.sendFailureNonce,
      streaming: false,
    };
    playerSpriteRequest.current = request;
    setPendingPlayerSprite({ id: request.id, expression: "normal", index: 0, background, text: playerText(choice, api.user?.name) });
    try {
      api.classifyPlayerExpression(choice).then(expression => {
        if (playerSpriteRequest.current?.id !== request.id) return;
        setPendingPlayerSprite(current => current?.id === request.id ? { ...current, expression } : current);
      }).catch(() => {});
    } catch {}
    setWaiting(true); setAuto(false); api.sendMessage(choice);
  }

  function submitChoice() {
    if (!draft.trim() || loading || api.readOnly || draftingChoice || !personaControl.ready || personaControl.saving) return;
    const text = draft.trim(); setPanel(""); setDraft(""); choose(text, true);
  }

  async function assistChoice() {
    if (!draft.trim() || draftingChoice || loading || api.readOnly || personaControl.mode !== "assisted") return;
    const request = ++draftRequest.current, context = draftContext.current, original = draft;
    setDraftingChoice(true); setDraftError("");
    try {
      const proposed = await draftPersonaChoice(api, original);
      if (request === draftRequest.current && context === draftContext.current) setDraft(proposed);
    } catch (err) {
      if (request === draftRequest.current && context === draftContext.current) setDraftError(err?.message || "Could not draft a response. Your instruction is kept.");
    } finally {
      if (request === draftRequest.current && context === draftContext.current) setDraftingChoice(false);
    }
  }

  useAutoReading({
    active: auto, paused: !!panel || viewerOpen || hidden || !hydrated,
    halted: end || waiting || api.isStreaming || !!error || !line,
    pageKey: `${api.sessionId}:${turn}:${index}:${pendingPlayerSprite?.id || ""}`,
    text: line?.text || "", pace: autoDelay, view, scrollPassage,
    onAdvance: () => movePage(1, false), onStop: () => setAuto(false),
  });

  React.useEffect(() => {
    function keydown(event) {
      if (viewerOpen || panel === "memory") return;
      if (panel) {
        if (event.key === "Escape") { event.preventDefault(); setPanel(["save", "status"].includes(panel) ? "menu" : ""); }
        if (event.key === "Tab") {
          const nodes = Array.from(view.current.querySelectorAll('.vn-overlay button:not(:disabled), .vn-overlay input, .vn-overlay select, .vn-overlay textarea, .vn-overlay a[href]')).filter(node => node.getClientRects().length && node.tabIndex >= 0);
          const first = nodes[0], last = nodes[nodes.length - 1];
          if (event.shiftKey && (document.activeElement === first || !nodes.includes(document.activeElement))) { event.preventDefault(); last?.focus(); }
          else if (!event.shiftKey && (document.activeElement === last || !nodes.includes(document.activeElement))) { event.preventDefault(); first?.focus(); }
        }
        return;
      }
      if (!event.target.classList.contains("vn-stage") && event.target.closest('button,input,select,textarea,a,[contenteditable=true]')) return;
      if (event.key === "Escape") { event.preventDefault(); hidden ? setHidden(false) : setPanel("menu"); }
      else if (event.key === " " || event.key === "Enter") { event.preventDefault(); advance(); }
      else if (/^[1-9]$/.test(event.key) && choices[Number(event.key) - 1]) { event.preventDefault(); choose(choices[Number(event.key) - 1]); }
      else if (/^[1-9]$/.test(event.key) && choiceReady && Number(event.key) === choices.length + 1 && !api.readOnly) { event.preventDefault(); setPanel("composer"); }
      else if (event.key.toLowerCase() === "l") setPanel("log");
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  });

  async function run(action) {
    if (busy) return;
    setBusy(true);
    setOperationError("");
    try { await action(); } catch (err) { setOperationError(err?.message || "That didn’t complete. Please try again."); }
    finally { setBusy(false); }
  }

  function onSetting(name, value) {
    if (name === "textSize") setTextSize(value); else if (name === "autoDelay") setAutoDelay(value); else if (name === "showTokenStatistics") setShowTokenStatistics(value);
    api.storage.set("vn:settings", JSON.stringify({ textSize: name === "textSize" ? value : textSize, autoDelay: name === "autoDelay" ? value : autoDelay, showTokenStatistics: name === "showTokenStatistics" ? value : showTokenStatistics })).catch(() => {});
  }

  return <main className="vn" data-yumina-dialog-theme="vn" ref={view} data-scene-media={!!(background || cast.length)} style={{ "--text-size": `${textSize}px` }}>
    <style>{styles.replace("__FONT_URL__", fontRef ? api.resolveAssetUrl(fontRef) : "") + characterViewerStyles + vnDialogTheme}</style>
    <VnTextStyle api={api} />
    {typeof background === "string" && background && <img className="vn-bg" src={api.resolveAssetUrl(background)} alt="" />}
    {!!cast.length && <div className="vn-cast" aria-label="Scene characters">{cast.map(character => <SpriteSlot key={character.key || character.name.toLowerCase()} character={character} speaker={pendingPlayerSprite ? "player" : spriteKey(line)} onExit={finishSpriteExit} />)}</div>}
    <div className="vn-shade" />
    <button className="vn-stage" aria-label={hidden ? "Show interface" : "Advance story"} onClick={advance} tabIndex={panel || viewerOpen ? -1 : 0} />
    {!hidden && <div inert={panel || viewerOpen ? true : undefined}>
      <nav className="vn-controls" aria-label="Visual novel controls">
        <Control name="Log" onClick={() => setPanel("log")} />
        {canPickRoute && !!routes.length && <Control name="Route" onClick={() => { setAuto(false); if (api.openStoryRoutes) api.openStoryRoutes(); else setPanel("routes"); }} />}
        <Control name="Hide" onClick={() => setHidden(true)} />
        <Control name="Skip" onClick={() => {
          setAuto(false);
          if (panel || viewerOpen || error) return;
          if (pendingPlayerSprite && (loading || api.isStreaming || lastMessage?.role !== "assistant" || lastMessage.id === playerSpriteRequest.current?.baseMessageId)) {
            setPendingPlayerSprite(current => current ? { ...current, index: Math.max(0, lines.length - 1) } : current);
            return;
          }
          const latestSegments = segmentPassages(sceneApi);
          const latestLines = latestSegments.length ? latestSegments : latest ? messagePassages(sceneApi, latest) : passages(sceneApi.entries, api.greetingContent || "");
          playerSpriteRequest.current = null; setPendingPlayerSprite(null);
          setCursor({ turn: latestTurn, index: Math.max(0, latestLines.length - 1) });
        }} />
        <Control name="Auto" active={auto} onClick={() => setAuto(current => !current)} /><Control name="Menu" onClick={() => setPanel("menu")} />
      </nav>
      <div className="vn-reading">
      {line && <section className="vn-dialogue" onClick={advance} aria-label="Current passage">
        <SpeakerName name={npcLabels[index] || line.name || (line.kind === "dialogue" ? "NPC" : "")} className="vn-name" truncate={false} /><Copy api={api} text={line.text} className={`vn-text${line.kind === "narration" ? " vn-action" : ""}`} context={{ messageId: currentMessage?.id || "greeting", lines: readLines }} onCharacter={characterViewer.open} />
        <span className="vn-reply-announcement" role="status" aria-live="polite" aria-atomic="true">{replyReady ? "Reply ready" : ""}</span>
        {replyReady && <div className="vn-reply-ready"><span aria-hidden="true">Reply ready</span><button onClick={event => { event.stopPropagation(); advance(); }}>Continue</button></div>}
        <div className="vn-progress" aria-label="Reading position"><div className="vn-progress-summary"><span>Turn {turnIndex + 1} | Page {index + 1} of {lines.length}</span>{showTokenStatistics && <ReplyMetrics message={currentMessage} />}</div>{(!end || !viewingLatest || pendingPlayerLine) && !loading && !error && <span className="vn-continue" aria-hidden="true"><svg viewBox="0 0 20 12" fill="none"><path d="m2 2 8 8 8-8" stroke="currentColor" strokeWidth="1.5" /></svg></span>}</div>
      </section>}
      {choiceReady && <div className="vn-choices" aria-label="Story choices">{choices.map((choice, i) => <div className="vn-choice-row" key={`${i}:${choice}`}><span className="vn-number" aria-hidden="true">{i + 1}</span><button className="vn-choice" aria-label={plainChoiceText(playerText(choice, api.user?.name))} disabled={api.readOnly || !personaControl.ready || personaControl.saving} onClick={() => choose(choice)}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><ChoiceText text={playerText(choice, api.user?.name)} /></button></div>)}
        {!choices.length && lastMessage?.role === "assistant" && !api.readOnly && <div className="vn-choice-row"><span className="vn-choice-spacer" aria-hidden="true" /><button className="vn-choice vn-generate-choices" disabled={generatingChoices} aria-busy={generatingChoices} onClick={generateChoices}>{generatingChoices ? <span className="vn-choice-spinner" aria-hidden="true" /> : <span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} />}<span aria-live="polite">{generatingChoices ? "Generating choices…" : "Generate choices"}</span></button></div>}
        {choiceError && <div className="vn-choice-error" role="alert">{choiceError}</div>}
        <div className="vn-choice-row"><span className="vn-number" aria-hidden="true">{choices.length + 1}</span><button className="vn-choice vn-custom-choice" aria-label="Write your own choice" disabled={api.readOnly || generatingChoices || !personaControl.ready || personaControl.saving} onClick={() => setPanel("composer")}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><ChoiceText text="Write your own" /></button></div>
      </div>}
      {recoveryReady && <div className="vn-choices vn-pending-response" aria-label="Unanswered choice">
        <p className="vn-pending-notice">Your last choice has no reply yet.</p>
        <div className="vn-choice-row"><span className="vn-choice-spacer" aria-hidden="true" /><button className="vn-choice vn-retry-response" disabled={busy} onClick={retryResponse}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><span>Retry response</span></button></div>
        <div className="vn-choice-row"><span className="vn-choice-spacer" aria-hidden="true" /><button className="vn-choice vn-change-choice" disabled={busy} onClick={changePendingChoice}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><span>Choose something else</span></button></div>
      </div>}
      </div>
      {!line && !api.isStreaming && <div className="vn-empty">Your story is ready.<br /><button onClick={() => api.switchGreeting(0)}>Begin story</button></div>}
    </div>}
    {panel === "log" && <DialogueLog api={sceneApi} blocked={viewerOpen} onCharacter={characterViewer.open} currentTurnId={currentMessage?.id || "greeting"} onClose={() => setPanel("")} />}
    {viewerOpen && <CharacterViewer controller={characterViewer} />}
    {panel === "routes" && canPickRoute && <Routes api={api} routes={routes} activeIndex={opening.activeSwipeIndex || 0} onClose={() => setPanel("")} onSelect={index => { if (canPickRoute) api.switchGreeting(index); setPanel(""); }} />}
    {["menu","load","settings"].includes(panel) && <Menu api={api} currentMessage={currentMessage} onClose={() => setPanel("")} setPanel={setPanel} settings={{ panel, textSize, autoDelay, showTokenStatistics, personaControl }} onSetting={onSetting} busy={busy} run={run} onRestore={() => { cursorRevision.current++; setCursor({ turn: "", index: 0 }); setPendingPlayerSprite(null); playerSpriteRequest.current = null; setAuto(false); }} />}
    {panel === "status" && <StatusSheet api={sceneApi} filterCharacters={config => visibleCharacterStatus(config, sceneApi.entries, metCharacterIds)} onClose={() => setPanel("")} onBack={() => setPanel("menu")} />}
    {panel === "memory" && <SessionMemoryModal key={api.sessionId} open onClose={() => setPanel("menu")} initialTab="storyhaven" />}
    {panel === "save" && <SaveCheckpoint key={api.sessionId} api={api} onClose={() => setPanel("menu")} />}
    {panel === "composer" && <section className="vn-overlay vn-composer" role="dialog" aria-modal="true" aria-label="Write your own choice">
      <button className="vn-menu-shade" aria-label="Dismiss custom choice" onClick={() => setPanel("")} />
      <div className="vn-composer-card">
        <button className="vn-close" type="button" aria-label="Close composer" onClick={() => setPanel("")}><Icons.X /></button>
        <h1>Your choice</h1>
        <label htmlFor="vn-custom-response">What do you do?</label>
        <textarea disabled={draftingChoice} id="vn-custom-response" aria-label="Your choice" value={draft} onInput={event => setDraft(event.currentTarget.value)} onChange={event => setDraft(event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === "Enter") { event.preventDefault(); submitChoice(); } }} placeholder="Describe your action or response…" rows={5} />
        {personaControl.mode === "assisted" && <><p className="vn-assistance-note">Describe your intent or edit your response. Review the draft before sending.</p><button type="button" className="vn-draft-choice" onClick={assistChoice} disabled={!draft.trim() || draftingChoice || loading || api.readOnly}>{draftingChoice ? "Drafting…" : "Draft with AI"}</button></>}
        {draftError && <p className="vn-choice-error" role="alert">{draftError}</p>}
        <div className="vn-composer-actions"><button type="button" onClick={() => setPanel("")}>Cancel</button><button className="vn-send-choice" type="button" onClick={submitChoice} disabled={!draft.trim() || loading || api.readOnly || draftingChoice || !personaControl.ready || personaControl.saving}>Send choice</button></div>
      </div>
    </section>}
    {loading && <LoadingStatus api={api} />}
    {error && <div className="vn-error" role="alert"><span>{error}</span>
      {canRetry && !api.readOnly && <button disabled={api.isStreaming} onClick={retryResponse}>Retry</button>}
      {canChangeChoice && <button disabled={busy} onClick={changePendingChoice}>Choose something else</button>}
      {/^(?:State update check failed \((?:correction_model_unavailable|correction_timeout|correction_context_limit|correction_output_limit|incomplete_correction|invalid_correction|provider_auth|provider_rate_limit|provider_context_limit|provider_unsupported_format|provider_model_unavailable|provider_unavailable|provider_error)\)\.|Not enough mushies for the state update correction(?:[.:]|$))/.test(error)
        ? typeof api.openStateGuardSettings === "function"
          ? <button disabled={api.readOnly || api.isStreaming} onClick={() => api.openStateGuardSettings()}>State Update Guard settings</button>
          : <span>Open State Update Guard from the app menu to check its correction model settings.</span>
        : <button onClick={() => api.openModelPicker()}>Choose model</button>}
      {operationError && <button onClick={() => setOperationError("")}>Dismiss</button>}
    </div>}
  </main>;
}
