import type { RootComponent } from "@yumina/engine";
import { currentStatusFiles } from "../editor/lib/status-template-upgrade";
import { upgradeVnLoadingFiles } from "./vn-loading-progress";
import { upgradeVnReadingFiles } from "./vn-reading-upgrade";
import { upgradeVnCharacterVisibilityFiles } from "./vn-character-visibility-upgrade";
import { upgradeVnTextFiles } from "./vn-text-upgrade";
import { upgradeVnPortraitFiles } from "./vn-portrait-upgrade";
import { upgradeVnMetadataFiles } from "./vn-metadata-upgrade";
import { upgradeVnCharacterMentionFiles } from "./vn-character-mention-upgrade";
import { upgradeVnErrorLayoutFiles } from "./vn-error-layout-upgrade";
import { upgradeVnStateGuardRecoveryFiles } from "./vn-state-guard-recovery-upgrade";
import { upgradeVnCustomChoiceLabelFiles } from "./vn-custom-choice-label-upgrade";
import { upgradeVnReplyReadyFiles } from "./vn-reply-ready-upgrade";
import { upgradeVnSkipFiles } from "./vn-skip-upgrade";
import { upgradeVnAutoFiles } from "./vn-auto-upgrade";
import { upgradeVnNpcLabelFiles } from "./vn-npc-label-upgrade";
import { upgradeVnModelRoutingFiles } from "./vn-model-routing-upgrade";
import { upgradeVnTurnDetailsFiles } from "./vn-turn-details-upgrade";
import { upgradeVnCheckpointFiles } from "./vn-checkpoint-upgrade";

export interface VnCompatibilitySources {
  loading: string;
  reading: string;
  characterVisibility: string;
  text: Record<string, string>;
  portrait: string;
  angle: string;
  characterViewer: string;
  auto: string;
  npcDisplayName: string;
  modelRouting: string;
  turnDetails: string;
  checkpoint: string;
}

/** Ordered stock compatibility only. Each existing transform retains its own
 * exact-match guards and preserves unknown/custom source. No cache or rewrite
 * policy belongs here; WorldRenderer still owns adaptation and memoization. */
export function upgradeCompatibleVnFiles(
  files: Record<string, string>,
  interfaceId: RootComponent["interfaceId"] | undefined,
  sources: VnCompatibilitySources,
): Record<string, string> {
  if (interfaceId === "classic") return files;
  // Prerequisites first, matching the previous WorldRenderer sequence exactly.
  let updated = currentStatusFiles(files, interfaceId);
  updated = upgradeVnLoadingFiles(updated, sources.loading);
  updated = upgradeVnReadingFiles(updated, sources.reading);
  updated = upgradeVnCharacterVisibilityFiles(updated, sources.characterVisibility);
  updated = upgradeVnTextFiles(updated, sources.text);
  updated = upgradeVnPortraitFiles(updated, sources.portrait);
  updated = upgradeVnMetadataFiles(updated, sources.angle);
  updated = upgradeVnCharacterMentionFiles(updated, sources.characterViewer);
  updated = upgradeVnErrorLayoutFiles(updated);
  updated = upgradeVnStateGuardRecoveryFiles(updated);
  updated = upgradeVnCustomChoiceLabelFiles(updated);
  updated = upgradeVnReplyReadyFiles(updated);
  updated = upgradeVnSkipFiles(updated);
  updated = upgradeVnAutoFiles(updated, sources.auto);
  updated = upgradeVnNpcLabelFiles(updated, sources.npcDisplayName);
  updated = upgradeVnModelRoutingFiles(updated, sources.modelRouting);
  updated = upgradeVnTurnDetailsFiles(updated, sources.turnDetails);
  return upgradeVnCheckpointFiles(updated, sources.checkpoint);
}
