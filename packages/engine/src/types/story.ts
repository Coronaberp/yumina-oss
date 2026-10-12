import type { Condition } from "./index.js";

export interface StoryRoute {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  guidance: string;
  conditions: Condition[];
  conditionLogic: "all" | "any";
  lockOnEntry: boolean;
}

export interface StoryEnding {
  id: string;
  name: string;
  enabled: boolean;
  priority: number;
  routeIds: string[];
  conditions: Condition[];
  conditionLogic: "all" | "any";
  allowUnconditional: boolean;
  outcome: string;
  mode: "authored" | "ai";
  prose: string;
  guidance: string;
}

export interface CapturedStoryRoute {
  id: string;
  name: string;
  guidance: string;
  enteredTurn: number;
  locked: boolean;
}

export interface CapturedStoryEnding {
  id: string;
  name: string;
  outcome: string;
  mode: "authored" | "ai";
  prose: string;
  guidance: string;
  selectedTurn: number;
  operationId: string;
}

export interface StoryProgress {
  status: "playing" | "ending-ready" | "completed";
  route?: CapturedStoryRoute;
  ending?: CapturedStoryEnding;
  presentation?: string;
}
