import { z } from "zod";
import { conditionSchema } from "../world/condition-schema.js";

export const storyRouteSchema = z.object({
  id: z.string(), name: z.string().default(""), enabled: z.boolean().default(true), priority: z.number().int().default(0),
  guidance: z.string().default(""), conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"), lockOnEntry: z.boolean().default(false),
});

export const storyEndingSchema = z.object({
  id: z.string(), name: z.string().default(""), enabled: z.boolean().default(false), priority: z.number().int().default(0),
  routeIds: z.array(z.string()).default([]), conditions: z.array(conditionSchema).default([]),
  conditionLogic: z.enum(["all", "any"]).default("all"), allowUnconditional: z.boolean().default(false),
  outcome: z.string().default(""), mode: z.enum(["authored", "ai"]).default("authored"),
  prose: z.string().default(""), guidance: z.string().default(""),
});

export const capturedStoryRouteSchema = z.object({ id: z.string(), name: z.string(), guidance: z.string(), enteredTurn: z.number().int().nonnegative(), locked: z.boolean() });
export const capturedStoryEndingSchema = z.object({ id: z.string(), name: z.string(), outcome: z.string(), mode: z.enum(["authored", "ai"]), prose: z.string(), guidance: z.string(), selectedTurn: z.number().int().nonnegative(), operationId: z.string() });
export const storyProgressSchema = z.object({ status: z.enum(["playing", "ending-ready", "completed"]).default("playing"), route: capturedStoryRouteSchema.optional(), ending: capturedStoryEndingSchema.optional(), presentation: z.string().optional() });
