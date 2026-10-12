const spriteIdentity = character => character.player ? "player" : character.key || character.name.toLowerCase();

// Departing sprites keep their old position without occupying a live cast slot.
export function useSpritePresence(cast, turn) {
  const [rendered, setRendered] = React.useState(() => cast);
  const previousTurn = React.useRef(turn);
  const signature = JSON.stringify(cast);
  React.useLayoutEffect(() => {
    const next = JSON.parse(signature);
    if (previousTurn.current !== turn) {
      previousTurn.current = turn;
      setRendered(next);
      return;
    }
    setRendered(previous => {
      if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return next;
      const keys = new Set(next.map(spriteIdentity));
      const active = previous.filter(character => !character.exiting);
      const width = Math.min(85, 100 / Math.max(1, active.length));
      const left = (100 - width * active.length) / 2;
      const departing = previous.filter(character => !keys.has(spriteIdentity(character))).map(character => character.exiting ? character : {
        ...character, exiting: true,
        slot: { position: "absolute", top: 0, left: `${left + active.indexOf(character) * width}%`, width: `${width}%` },
      });
      return next.concat(departing);
    });
  }, [signature, turn]);
  const finishExit = React.useCallback(key => {
    setRendered(previous => previous.filter(character => !character.exiting || spriteIdentity(character) !== key));
  }, []);
  return [rendered, finishExit];
}

export function SpriteSlot({ character, speaker, onExit }) {
  const [loaded, setLoaded] = React.useState(false);
  const key = spriteIdentity(character);
  const active = !character.exiting && key === speaker;
  React.useEffect(() => {
    if (!character.exiting) return;
    // Also retire sprites if animation events are unavailable or interrupted.
    const timer = setTimeout(() => onExit(key), 320);
    return () => clearTimeout(timer);
  }, [character.exiting, key, onExit]);
  return <div className="vn-sprite-slot" style={character.slot} data-ready={loaded} data-active={active} data-exiting={!!character.exiting} aria-hidden={character.exiting || undefined}
    onAnimationEnd={event => { if (character.exiting && event.target === event.currentTarget && event.animationName === "vn-sprite-out") onExit(key); }}>
    <img className="vn-sprite" src={character.src} alt={`${character.name} — ${character.emotion || "normal"}`} data-character={character.name} data-npc-id={character.key}
      data-npc-default={character.defaultMode}
      data-active={active} onLoad={event => {
        const image = event.currentTarget;
        if (image.naturalWidth) image.style.setProperty("--sprite-aspect", String(image.naturalHeight / image.naturalWidth));
        setLoaded(true);
      }} />
  </div>;
}
