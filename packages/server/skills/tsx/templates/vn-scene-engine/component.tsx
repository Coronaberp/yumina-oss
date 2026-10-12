// ─── Visual Novel Scene Engine ───
// Full-screen custom component: scene backgrounds, character sprites, dialogue, map navigation.
// Pattern from production galgame. Customize SCENES, CHARACTERS, and LANDMARKS for your world.
//
// Required variables:
//   current-scene (string)    — scene ID from SCENES object
//   current-period (string)   — "morning" | "afternoon" | "evening" | "night"
//   segments (json)           — AI-generated dialogue segments (parsed from AI responses)
//   [char]-emotion (string)   — per-character emotion state: "normal"|"happy"|"sad"|"angry"|"shy"|"smug"|"surprised"
//   [char]-affinity (number)  — optional relationship tracking
//
// How it works:
//   1. AI prefixes EVERY spoken passage with [SPEAKER:Name:emotion], and actions with
//      [SPEAKER:Narrator:normal] plus *italics*. Actions use exact character names.
//      Undefined characters use [SPEAKER:NPC:emotion:male|female:stable-id].
//      In segments, supply speaker: "NPC", gender: "male" or "female", npcId: "stable-id".
//      The visible name remains NPC. Omit gender when unknown; never guess it from a name.
//      Player references in generated text use the literal double-brace user token.
//      A playable turn also includes [CHOICES: ["Action one", "Action two"]] with
//      2–4 real options; never generate the custom "..." button or act for the player.
//   2. The engine stores choices on the assistant swipe. This example consumes a
//      variables.segments array ({ speaker, emotion, text }); it does not convert
//      response markers into segments or render choice controls automatically.
//      Use the built-in VN interface for parsed messages and the custom-choice modal,
//      or wire the adapter and api.pendingChoices when adapting this scene example.
//   3. Renders background (with day/night variants), character sprite, and dialogue box
//   4. Map overlay shows available locations as clickable landmarks

export default function VNSceneEngine({ variables, metadata, worldName }) {
  var api = useYumina();

  // ─── SCENE DEFINITIONS ───
  // Each scene has background images for different times of day (use @asset:ID references)
  // Fallback 'bg' is a CSS gradient used when no image asset is available
  var SCENES = {
    classroom: {
      assets: { day: null, evening: null, night: null }, // Replace null with @asset:ID
      bg: "linear-gradient(170deg, #fffde7 0%, #fff9c4 40%, #ffe082 100%)",
      label: "Classroom"
    },
    courtyard: {
      assets: { day: null, evening: null, night: null },
      bg: "linear-gradient(170deg, #e8f5e9 0%, #a5d6a7 40%, #66bb6a 100%)",
      label: "Courtyard"
    },
    rooftop: {
      assets: { day: null, evening: null, night: null },
      bg: "linear-gradient(170deg, #e3f2fd 0%, #90caf9 40%, #42a5f5 100%)",
      label: "Rooftop"
    },
    home: {
      assets: { day: null, evening: null, night: null },
      bg: "linear-gradient(170deg, #37474f 0%, #263238 40%, #1a1a2e 100%)",
      label: "Home"
    }
  };

  // ─── CHARACTER DEFINITIONS ───
  // Sprites: each character has image assets per emotion (use @asset:ID or URLs)
  // Color: used for dialogue box accent
  var CHARACTERS = {
    sakura: {
      name: "Sakura",
      color: "#f472b6",
      sprites: {
        normal: null, happy: null, sad: null, angry: null, shy: null, smug: null, surprised: null
      }
    },
    kaito: {
      name: "Kaito",
      color: "#818cf8",
      sprites: {
        normal: null, happy: null, sad: null, angry: null, shy: null, smug: null, surprised: null
      }
    }
  };

  // Uploaded transparent NPC cutouts, keyed by image ID within each gender pool.
  // A vn-npc-sprites JSON variable can override these authored pools.
  var NPC_SPRITES = { male: {}, female: {} };

  // ─── MAP LANDMARKS ───
  // Positions are percentages (top, left) on the map overlay
  var LANDMARKS = [
    { id: "classroom", name: "School", top: 20, left: 50 },
    { id: "courtyard", name: "Courtyard", top: 45, left: 30 },
    { id: "rooftop", name: "Rooftop", top: 10, left: 70 },
    { id: "home", name: "Home", top: 80, left: 60 }
  ];

  // ─── PERIOD → TIME OF DAY MAPPING ───
  var PERIOD_TO_TIME = {
    morning: "day", afternoon: "day", evening: "evening", night: "night"
  };

  // ─── STATE ───
  var currentScene = (variables["current-scene"] || "classroom");
  var currentPeriod = (variables["current-period"] || "morning");
  var timeOfDay = PERIOD_TO_TIME[currentPeriod] || "day";
  var scene = SCENES[currentScene] || SCENES.classroom;

  var mapState = React.useState(false);
  var showMap = mapState[0];
  var setShowMap = mapState[1];

  var segmentIdx = React.useState(0);
  var currentIdx = segmentIdx[0];
  var setCurrentIdx = segmentIdx[1];

  // Parse segments from variable (AI fills this as JSON array)
  var segments = [];
  try {
    var raw = variables["segments"];
    if (typeof raw === "string") segments = JSON.parse(raw);
    else if (Array.isArray(raw)) segments = raw;
  } catch (e) { segments = []; }

  var segment = segments[currentIdx] || null;
  var speakerName = segment && typeof segment.speaker === "string" ? segment.speaker.trim() : "";
  var speakerId = speakerName.toLowerCase();
  function displayName(name) { return name.trim().replace(/^[^:：]{1,12}[:：]\s*(.+)$/s, "$1"); }
  function namedCharacter(characters, name) {
    var key = displayName(name).toLowerCase();
    var exact = characters.find(function(character) { return displayName(character.name).toLowerCase() === key; });
    if (exact) return exact;
    var matches = characters.filter(function(character) {
      var full = displayName(character.name);
      var qualifier = /\s*\(([^()]+)\)\s*$/.exec(full);
      var base = full.replace(/\s*\([^()]+\)\s*$/, "").trim();
      var aliases = [base].concat(base.split(/\s+/), qualifier ? [qualifier[1].trim()].concat(qualifier[1].trim().split(/\s+/)) : []);
      return aliases.some(function(alias) { return alias.toLowerCase() === key; });
    });
    return matches.length === 1 ? matches[0] : null;
  }
  var speakerChar = Object.prototype.hasOwnProperty.call(CHARACTERS, speakerId) ? CHARACTERS[speakerId] : namedCharacter(Object.values(CHARACTERS), speakerName);
  var definedSpeaker = namedCharacter((api.entries || []).filter(function(entry) { return entry.role === "character" && entry.enabled !== false; }), speakerName);
  var isNarration = speakerId === "narrator" || segment?.kind === "narration";
  var speakerLabel = isNarration ? "" : definedSpeaker ? displayName(definedSpeaker.name) : speakerChar ? speakerChar.name : "NPC";
  var emotion = segment ? (segment.emotion || "normal") : "normal";
  var npcGender = typeof segment?.gender === "string" ? segment.gender.trim().toLowerCase() : "";
  var npcId = typeof segment?.npcId === "string" ? segment.npcId.trim().toLowerCase() : "unknown";
  var npcSprite = null;
  if (!isNarration && !definedSpeaker && !speakerChar && (npcGender === "male" || npcGender === "female")) {
    var pools = variables["vn-npc-sprites"] ?? NPC_SPRITES;
    try { if (typeof pools === "string") pools = JSON.parse(pools); } catch (e) { pools = null; }
    var pool = pools?.[npcGender];
    if (pool && typeof pool === "object" && !Array.isArray(pool)) {
      var seed = (api.sessionId || api.worldId || "vn") + ":npc:" + npcGender + ":" + (npcId || "unknown");
      var selected = null, highest = -1;
      Object.entries(pool).forEach(function(pair) {
        var id = pair[0], ref = pair[1];
        if (typeof ref !== "string" || !ref.trim()) return;
        var score = 2166136261;
        for (var char of seed + ":" + id) score = Math.imul(score ^ char.codePointAt(0), 16777619) >>> 0;
        if (score > highest || (score === highest && id < selected.id)) { highest = score; selected = { id: id, ref: ref }; }
      });
      if (selected) npcSprite = api.resolveAssetUrl(selected.ref);
    }
  }
  var sprite = speakerChar ? speakerChar.sprites[emotion] || speakerChar.sprites.normal : npcSprite;

  // ─── BACKGROUND ───
  var bgUrl = scene.assets ? scene.assets[timeOfDay] : null;
  var bgStyle = bgUrl
    ? { backgroundImage: "url(" + bgUrl + ")", backgroundSize: "cover", backgroundPosition: "center" }
    : { background: scene.bg };

  // ─── HANDLERS ───
  function handleAdvance() {
    if (currentIdx < segments.length - 1) {
      setCurrentIdx(currentIdx + 1);
    }
  }

  function handleMapNavigate(sceneId) {
    api.setVariable("current-scene", sceneId);
    api.sendMessage("I go to " + (SCENES[sceneId]?.label || sceneId));
    setShowMap(false);
  }

  // ─── RENDER ───
  return (
    <div
      style={Object.assign({ position: "relative", width: "100%", height: "100vh", overflow: "hidden", cursor: "pointer" }, bgStyle)}
      onClick={handleAdvance}
    >
      {/* Dark overlay for readability */}
      <div style={{ position: "absolute", inset: 0, background: "linear-gradient(transparent 50%, rgba(0,0,0,0.6) 100%)" }} />

      {/* Character sprite */}
      {sprite && (
        <img
          src={sprite}
          style={{ position: "absolute", bottom: "10%", left: "50%", transform: "translateX(-50%)", maxHeight: "70%", objectFit: "contain", pointerEvents: "none" }}
          alt={speakerLabel}
        />
      )}

      {/* Dialogue box */}
      {segment && (
        <div style={{
          position: "absolute", bottom: 0, left: 0, right: 0,
          background: "rgba(0,0,0,0.75)", backdropFilter: "blur(8px)",
          padding: "20px 24px", borderTop: "2px solid " + (speakerChar?.color || "#888")
        }}>
          {speakerLabel && (
            <div aria-label="Speaker" style={{ fontSize: 14, fontWeight: 700, color: speakerChar?.color || "#c5a464", marginBottom: 6 }}>
              {speakerLabel}
            </div>
          )}
          <div style={{ fontSize: 16, color: "#e0e0e0", lineHeight: 1.7 }}>
            {segment.text || ""}
          </div>
          <div style={{ fontSize: 11, color: "#666", marginTop: 8, textAlign: "right" }}>
            {currentIdx + 1} / {segments.length}
          </div>
        </div>
      )}

      {/* Top bar: scene label + period + map button */}
      <div style={{
        position: "absolute", top: 0, left: 0, right: 0,
        display: "flex", justifyContent: "space-between", alignItems: "center",
        padding: "12px 16px", background: "linear-gradient(rgba(0,0,0,0.5), transparent)"
      }}>
        <div style={{ fontSize: 13, color: "#ccc" }}>
          {scene.label} — {currentPeriod}
        </div>
        <button
          onClick={function(e) { e.stopPropagation(); setShowMap(!showMap); }}
          style={{ background: "rgba(255,255,255,0.15)", border: "none", borderRadius: 6, padding: "6px 12px", color: "#fff", fontSize: 12, cursor: "pointer" }}
        >
          <Icons.Map size={14} style={{ marginRight: 4 }} /> Map
        </button>
      </div>

      {/* Map overlay */}
      {showMap && (
        <div
          onClick={function(e) { e.stopPropagation(); }}
          style={{
            position: "absolute", inset: "10%",
            background: "rgba(20,20,30,0.92)", backdropFilter: "blur(12px)",
            borderRadius: 12, border: "1px solid rgba(255,255,255,0.1)",
            padding: 24, overflow: "hidden"
          }}
        >
          <div style={{ fontSize: 16, fontWeight: 700, color: "#fff", marginBottom: 16 }}>
            {worldName || "World"} Map
          </div>
          <div style={{ position: "relative", width: "100%", height: "80%" }}>
            {LANDMARKS.map(function(lm) {
              var isHere = lm.id === currentScene;
              return (
                <button
                  key={lm.id}
                  onClick={function() { if (!isHere) handleMapNavigate(lm.id); }}
                  style={{
                    position: "absolute", top: lm.top + "%", left: lm.left + "%",
                    transform: "translate(-50%, -50%)",
                    background: isHere ? "rgba(255,255,255,0.2)" : "rgba(255,255,255,0.08)",
                    border: isHere ? "2px solid #fff" : "1px solid rgba(255,255,255,0.2)",
                    borderRadius: 8, padding: "8px 14px", color: "#fff",
                    fontSize: 12, cursor: isHere ? "default" : "pointer",
                    transition: "all 0.2s"
                  }}
                >
                  {lm.name}
                  {isHere && <span style={{ display: "block", fontSize: 10, color: "#aaa" }}>You are here</span>}
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
