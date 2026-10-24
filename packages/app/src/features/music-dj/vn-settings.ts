const anchor = '            <label className="vn-setting">Music<input type="range" min="0" max="1" step=".05" defaultValue={api.getAudioVolume("bgm")} onChange={e => api.setAudioVolume("bgm", Number(e.target.value))} /></label>';
const controls = `            {typeof api.setMusicAudioMode === "function" && <>
              <label className="vn-setting">Audio source<select aria-label="Audio source" value={api.musicAudioMode || "creator"} onChange={e => api.setMusicAudioMode(e.target.value)}><option value="creator">Creator audio</option><option value="personal">My music agent</option><option value="off">Off</option></select></label>
              {api.musicAudioMode === "personal" && <div className="vn-setting"><button onClick={() => api.musicDjCommand(api.musicDjPaused ? "resume" : "pause")}>{api.musicDjPaused ? "Resume music" : "Pause music"}</button><button onClick={() => api.musicDjCommand("skip")}>Skip music</button><button aria-pressed={!!api.musicDjLocked} onClick={() => api.musicDjCommand("lock")}>{api.musicDjLocked ? "Unlock music" : "Lock music"}</button></div>}
              <p role="status" style={{fontSize:12,opacity:.75,overflowWrap:"anywhere"}}>{api.musicDjStatus}</p>
            </>}
`;
/** Listener UI only: adapt known stock settings at render, never saved files. */
export function upgradeVnMusicSettings(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('className="vn-stage"') || !source.includes('import { styles } from "./styles";') || source.includes("api.setMusicAudioMode") || source.split(anchor).length !== 2) continue;
    if (updated === files) updated = { ...files };
    updated[name] = source.replace(anchor, controls + anchor);
  }
  return updated;
}
