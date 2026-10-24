import loading from "../../../../../interfaces/vn/loading-status.tsx?raw";
import reading from "../../../../../interfaces/vn/reading.ts?raw";
import characterVisibility from "../../../../../interfaces/vn/character-visibility.ts?raw";
import textSettings from "../../../../../interfaces/vn/text-settings.tsx?raw";
import textDefaults from "../../../../../interfaces/vn/text-defaults.ts?raw";
import textStyle from "../../../../../interfaces/vn/text-style.ts?raw";
import menuLayout from "../../../../../interfaces/vn/menu-layout.ts?raw";
import portrait from "../../../../../interfaces/vn/portrait-ref.ts?raw";
import angle from "../../../../../interfaces/vn/angle-markup.ts?raw";
import characterViewer from "../../../../../interfaces/vn/character-viewer.tsx?raw";
import auto from "../../../../../interfaces/vn/auto-reading.ts?raw";
import npcDisplayName from "../../../../../interfaces/vn/npc-display-name.ts?raw";
import modelRouting from "../../../../../interfaces/vn/model-routing-details.tsx?raw";
import turnDetails from "../../../../../interfaces/vn/turn-details.tsx?raw";
import checkpoint from "../../../../../interfaces/vn/checkpoints.tsx?raw";
import type { VnCompatibilitySources } from "./vn-compatible-files";

/** Canonical VN source bytes, separate from the pure compatibility pipeline. */
export const vnCompatibilitySources: VnCompatibilitySources = {
  loading, reading, characterVisibility,
  text: {
    "text-settings.tsx": textSettings,
    "text-defaults.ts": textDefaults,
    "text-style.ts": textStyle,
    "menu-layout.ts": menuLayout,
  },
  portrait, angle, characterViewer, auto, npcDisplayName, modelRouting, turnDetails, checkpoint,
};
