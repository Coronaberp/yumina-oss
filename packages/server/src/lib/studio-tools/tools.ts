import { getSmartImageCapabilities, SMART_IMAGE_MODEL, SMART_IMAGE_MODELS,
  SMART_IMAGE_ASPECTS, SMART_IMAGE_RESOLUTIONS, MAX_IMAGE_BATCH_ITEMS } from "@yumina/shared";
import type { ToolDefinition } from "../llm/types.js";
import { NAME_READ_TOOLS, NAME_PROFILES_TOOL_SCHEMA } from "./name-tools.js";
import { REQUEST_TOOLS_TOOL } from "./tool-catalog.js";

/** The assistant picks its own model, so the schema advertises the union across
 *  all of them and normalizeImageProposal narrows the pair down to what the
 *  chosen model really accepts. Advertising one model's list would hide shapes
 *  and sizes the others can do; advertising the union without narrowing would
 *  let a combination reach a provider that rejects it.
 *
 *  Read from the shared table rather than retyped, so a ratio or tier added
 *  there reaches the assistant in the same commit as the creator's own picker. */
/** One line of verifiable fact per model — price, sizes, shapes, seed support.
 *  Deliberately no claim about which draws better: nobody has measured that
 *  here, and inventing it would be spending the creator's money on a guess.
 *  The assistant weighs these and says out loud what it picked and why. */
const IMAGE_TOOL_MODELS = SMART_IMAGE_MODELS.map(model => {
  const caps = getSmartImageCapabilities(model.id);
  const facts = [
    `~${Math.round(model.estimatedCostUsd * 1000)} mushies/image`,
    caps.resolutions.length ? `sizes ${caps.resolutions.join("/")}` : "one fixed size",
    `${caps.aspectRatios.length} shapes`,
    model.supportsSeed ? "seed supported" : "no seed",
  ];
  return { id: model.id, name: model.name, line: `${model.id} — ${model.name}: ${facts.join(", ")}` };
});
const IMAGE_TOOL_CAPABILITIES = {
  aspectRatios: SMART_IMAGE_ASPECTS.filter(ratio =>
    SMART_IMAGE_MODELS.some(model => (model.aspectRatios as readonly string[]).includes(ratio))),
  resolutions: SMART_IMAGE_RESOLUTIONS,
};

// A condition's value remains required even when valueRef supplies the RHS.
// Publish the actual engine shape instead of leaving the model to invent it.
const STORY_CONDITION_TOOL_SCHEMA = {
  type: "object",
  properties: {
    variableId: { type: "string", description: "Declared gameplay variable ID or dot path, e.g. trust, stats.trust or party.0.hp. Use dot syntax for arrays, not brackets." },
    operator: { type: "string", enum: ["eq", "neq", "gt", "gte", "lt", "lte", "contains"] },
    value: { description: "Literal comparison value. Required even with valueRef; use a placeholder such as 0 in that case.", anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }, { type: "object" }, { type: "array", items: {} }] },
    valueRef: { type: "string", description: "Optional declared variable ID or dot path to compare against instead of value." },
  },
  required: ["variableId", "operator", "value"],
};

const EVENT_EFFECTS_TOOL_SCHEMA = { type: "array", maxItems: 64, items: {
  type: "object", properties: {
    variableId: { type: "string", description: "Existing declared variable ID or dot path." },
    operation: { type: "string", enum: ["set", "add", "subtract", "multiply", "toggle", "append", "merge", "push", "delete"] },
    value: { anyOf: [{ type: "number" }, { type: "string" }, { type: "boolean" }, { type: "object" }, { type: "array", items: {} }] },
    valueRef: { type: "string", description: "Optional existing variable whose value replaces the literal value." },
  }, required: ["variableId", "operation", "value"],
} };
const EVENT_ENTRIES_TOOL_SCHEMA = { type: "array", maxItems: 64, items: { type: "object", properties: { entryId: { type: "string" }, enabled: { type: "boolean" } }, required: ["entryId", "enabled"] } };
const CHAPTER_EVENTS_TOOL_SCHEMA = { type: "array", maxItems: 32,
  description: "Replaces the COMPLETE event list for this chapter; read and preserve unrelated events first. Events are sequences INSIDE this chapter, not new chapters. Stable event/scene/moment IDs preserve saved progress. New events default disabled. Enable only complete definitions; do not edit engine-owned storyEvents or invent completion markers.",
  items: { type: "object", properties: {
    id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" },
    description: { type: "string", description: "Author-only overview; not sent to the story model. Put playable instructions in scenes." },
    conditions: { type: "array", items: STORY_CONDITION_TOOL_SCHEMA, description: "Start prerequisites. Empty means immediately eligible in this chapter. Checked on start only." },
    conditionLogic: { type: "string", enum: ["all", "any"] },
    scenes: { type: "array", maxItems: 40, description: "Ordered scenes. Only the current scene is prompted; one scene can complete per reply. Each needs requiredMoments or completionConditions.", items: { type: "object", properties: {
      id: { type: "string" }, name: { type: "string" }, instructions: { type: "string", description: "Playable directions for this scene only. Preserve player agency; no future-scene spoilers." },
      requiredMoments: { type: "array", maxItems: 16, items: { type: "object", properties: { id: { type: "string" }, description: { type: "string", description: "A clear observable occurrence. All moments require quoted evidence from actual narrative, not plans, mentions or model self-certification. Can accumulate over turns." } }, required: ["id", "description"] } },
      completionConditions: { type: "array", items: STORY_CONDITION_TOOL_SCHEMA, description: "Additional state gates, all required alongside confirmed moments." },
      effects: EVENT_EFFECTS_TOOL_SCHEMA, entryChanges: EVENT_ENTRIES_TOOL_SCHEMA,
    }, required: ["id", "name"] } },
    effects: { ...EVENT_EFFECTS_TOOL_SCHEMA, description: "Applied once when the final scene completes, after its scene effects." },
    entryChanges: { ...EVENT_ENTRIES_TOOL_SCHEMA, description: "Enable/disable existing lore/character entries on final completion. Existing lorebook/chapter/keyword gates still apply." },
  }, required: ["id", "name"] },
};

// ── Studio AI: 8-tool agent (Claude Code pattern) ──
//
// The model makes multiple write_* calls in one response (parallel tool use).
// Server collects all calls, converts to SchemaChange[], validates atomically,
// and routes through the executeApplyChanges() pipeline.

// ── Read Tools (auto-execute, no approval) ──

export const READ_TOOLS: ToolDefinition[] = [
  REQUEST_TOOLS_TOOL,
  ...NAME_READ_TOOLS,
  { type: "function", function: { name: "update_task_plan",
    description: "Save every requested requirement and its concrete checks. Existing requirements are retained; reuse a stable ID to correct a check. Verification is performed by the server against saved state. Empty checks remain pending; use ask_user for an essential ambiguity.",
    parameters: { type: "object", properties: { requirements: { type: "array", minItems: 1, maxItems: 40, items: {
      type: "object", properties: { id: { type: "string" }, text: { type: "string" }, checks: { type: "array", maxItems: 16, items: {
        type: "object", properties: { kind: { type: "string", enum: ["entity", "world", "file", "validation"] },
          collection: { type: "string", enum: ["entries", "variables", "rules", "reactions", "chapters", "routes", "endings", "worldbooks", "audioTracks"] },
          id: { type: "string", description: "Entity ID or virtual file name" }, field: { type: "string", description: "Optional entity field; required for world checks. Dot paths supported." },
          operator: { type: "string", enum: ["exists", "absent", "eq", "contains", "not_contains", "length_gte", "gte"] }, value: {},
          mode: { type: "string", enum: ["structure", "full"], description: "Validation mode; full checks TSX too." },
        }, required: ["kind"],
      } } }, required: ["id", "text", "checks"],
    } } }, required: ["requirements"] } } },
  { type: "function", function: { name: "check_task_progress", description: "Recheck the saved working card and source against the task checklist. Returns actual pass/fail evidence and remaining work; model claims cannot mark a check passed.", parameters: { type: "object", properties: {} } } },
  {
    type: "function", function: {
      name: "get_image_sources",
      description: "Check whether image generation is available and whether the creator enabled Danbooru artwork search in Settings. Returns setup help and connection status, never credentials. Call before proposing image generation or using Danbooru.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function", function: {
      name: "search_danbooru_images",
      description: "Search existing Danbooru artwork using space-separated Danbooru tags. Requires the creator to enable Danbooru in Settings → AI Configuration. Returns bounded post metadata and attribution; this does not generate or save images. Choose a result, import it, then assign its owned @asset ref with edit_vn_assets.",
      parameters: { type: "object", properties: {
        tags: { type: "string", description: "Space-separated Danbooru search tags; underscores within tags." },
        limit: { type: "integer", minimum: 1, maximum: 20 },
        page: { type: "integer", minimum: 1, maximum: 100 },
      }, required: ["tags"] },
    },
  },
  {
    type: "function", function: {
      name: "list_vn_assets",
      description: "Read Visual Novel sprite/background assignments, character inventory including lore/description-only names, per-character/type wardrobe descriptions, this card’s spriteConfig type/emotion IDs and labels, caps and warnings, default images, NPC defaults, stable opening IDs, and sortable row IDs. Sprites are shared across openings. Omit openingId for Global backgrounds, or supply a greeting ID for an opening collection. Returns help, editability, pagination, nested outfit variant IDs and per-outfit availableExpressions containing only assigned images. Types have no fixed cap; emotions are capped at 30. Catalogs, descriptions and outfits have independent next offsets. Character inventory and wardrobe description records have independent totals/next offsets using the same offset/limit; name filters character fields and spriteType filters descriptions/assignments. Never executes custom source.",
      parameters: { type: "object", properties: {
        kind: { type: "string", enum: ["sprites", "backgrounds"] },
        openingId: { type: "string", description: "Stable greeting entry ID; backgrounds only. Omit for Global." },
        npcGender: { type: "string", enum: ["male", "female"], description: "Read an NPC sprite pool instead of character expressions." },
        spriteType: { type: "string", description: "Character wardrobe ID from spriteConfig; omit to list all types." },
        spriteVariant: { type: "string", description: "Nested outfit variant ID; empty selects Base, omit to list all outfits. Distinct from variant (emotion)." },
        name: { type: "string", description: "Exact character/scene name filter." },
        offset: { type: "integer", minimum: 0 }, limit: { type: "integer", minimum: 1, maximum: 100 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "list_templates",
      description: "Browse the platform's official starting templates, separate from personal assets and world components. Omit id to list the installed catalog. Pass a catalog ID (e.g. vn-scene-engine) to retrieve that template's metadata, required variables, and complete source. Read the source before adapting it with write_custom_ui; this tool does not install or modify anything.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Official template catalog ID. Omit to browse all official templates." },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_assets",
      description: "Browse/search the creator's asset library with folder bindings. Defaults to this card's bound folders (including descendants), or all owned assets if none are bound. Use scope=all to find other assets. Follow nextOffset until null before concluding a file is absent. Returns folder paths, stable @asset refs, exact filtered total, and pagination.",
      parameters: { type: "object", properties: {
        scope: { type: "string", enum: ["bound", "all"] },
        folderId: { type: "string", description: "Owned folder ID, including its descendants." },
        query: { type: "string", description: "Literal filename substring." },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "view_image",
      description: "Open an existing owned image from the asset library or a card as a visual input. Use its @asset reference from list_assets or list_vn_assets. Inspect hair, clothing, colors, composition and other visible details before assigning a sprite or claiming it matches. Returns dimensions and whether pixels are transparent; the actual picture is delivered to your vision input. Read-only; never generates or modifies an image. Text-only profiles cannot inspect images.",
      parameters: { type: "object", properties: {
        assetRef: { type: "string", description: "Owned image @asset reference. Arbitrary paths and external URLs are not accepted." },
      }, required: ["assetRef"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "get_image_job",
      description: "Read the status of an approved background image job. A succeeded job includes saved @asset refs. Continue independent work while queued/running. Check when an image-dependent task needs the result; if still drawing, tell the creator and end the turn instead of repeatedly polling or submitting another image.",
      parameters: { type: "object", properties: { jobId: { type: "string" } }, required: ["jobId"], additionalProperties: false },
    },
  },
  {
    type: "function",
    function: {
      name: "read_entities",
      description:
        "Read full details of one or more entities. The inventory in your context shows IDs, names, and metadata — use this tool to get complete content (entry text, TSX code, behavior effects, conditions, etc.) when you need it before making changes. Batch multiple reads in one call. For large TSX files, use offset_lines/limit_lines to read a specific range — the usual workflow is grep_world to find line numbers, then read_entities with offset_lines/limit_lines around the match.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description:
              'Array of entity IDs to read. Can mix entity types (entries, variables, behaviors, rules, routes, endings, customUI, audio). Special IDs: "settings" returns world settings; "card-showcase" returns published-card HTML/CSS; "world-media" returns the actual working portrait cover, optional page banner and independent framing.',
          },
          offset_lines: {
            type: "number",
            description:
              "1-based starting line for TSX content (customUI / rootComponent files). Ignored for non-TSX entities. Default: return from the beginning.",
          },
          limit_lines: {
            type: "number",
            description:
              "Max lines of TSX content to return. Default: 2000. Max: 5000. Only applies when the requested entity is a TSX file.",
          },
        },
        required: ["ids"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "grep_world",
      description:
        "Grep across the world's text content for a literal string. Searches TSX code, entry content, variable behaviorRules, and behavior descriptions — optionally scoped to one entity type or one specific ID. Returns each match with the source entity (type + id + field) and ±context_lines of surrounding text, so you can build an exact `old_code` for `edit_custom_ui` or locate a concept across many entries at once. Literal search; capitalization must match. Returns up to 20 matches with ±5 lines of context by default.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Literal string to find (not a regex). Capitalization must match." },
          scope: {
            type: "string",
            enum: ["customUI", "entries", "variables", "behaviors", "all"],
            description: "Restrict search to one entity type, or 'all' (default). customUI searches tsxCode; entries searches content; variables searches behaviorRules+description; behaviors searches description.",
          },
          id: { type: "string", description: "Restrict search to a specific entity ID (works within any scope). For customUI scope: a component ID or rootComponent filename (e.g. 'homepage.tsx'). Omit to search all entities in the scope." },
          context_lines: { type: "number", description: "Lines of context before/after each match. Default 5, max 20." },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "load_skill",
      description:
        "Load detailed domain instructions before working in that domain. Consult the on-demand-skills catalog in your context; load the relevant skill when its full instructions are not already present.",
      parameters: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: 'Name from the on-demand-skills catalog, such as "entries", "variables", "tsx", "front-ui", "world-design", "rules", "audio", or "lore". Do not reload a skill whose full instructions are already present.',
          },
        },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "validate_world",
      description:
        "Scan the current world for structural issues: undefined variable references in conditions/effects/macros, broken route bindings, incomplete enabled endings, missing explicit unconditional-ending opt-in, chat-history entries with no keywords that will never trigger, behaviors that can fire in infinite loops, duplicate IDs across entity types, and more. Returns a structured report with errors (definitely broken) and warnings (risky, may be intentional). Call this after a batch of writes touching routes, endings, variables, behaviors, or entries. Auto-executes, no approval needed, no parameters.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  {
    type: "function", function: {
      name: "audit_project_completeness",
      description: "Deterministically report missing day/evening/night VN scene variants, character portraits/sprites/lore, and enabled routes without an eligible enabled ending. Uses literal maps and authored links only; custom code is reported as an inspection limit. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function", function: {
      name: "get_visual_audit_inputs",
      description: "Return a bounded page of background or character portrait/sprite references with character descriptions. Call view_image only for items marked inspectable that have an assetRef beginning @asset:; external or malformed references are explicitly uninspectable and must be reported as unchecked. Read-only.",
      parameters: { type: "object", properties: {
        kind: { type: "string", enum: ["characters", "backgrounds"] },
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 20 },
      }, required: ["kind"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "get_dependency_graph",
      description: "Return a paginated, evidence-bearing dependency graph connecting scenes, assets, entries/lore, variables, characters, routes, and endings. Every edge is labeled direct or inferred; inferred name mentions are navigation hints, not authored links.",
      parameters: { type: "object", properties: {
        offset: { type: "integer", minimum: 0 },
        limit: { type: "integer", minimum: 1, maximum: 100 },
      }, additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "preflight_world",
      description: "Run structural preflight for broken references, VN map limitations, missing owned image assets, invalid variable IDs, and route-ending coverage. Errors are definite blockers; warnings may be continued past. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function", function: {
      name: "set_acceptance_criteria",
      description: "Persist a bounded acceptance goal for this agent run. Use when the creator says not to stop until named coverage is complete. Supported predicates are explicit scene periods, all-character portrait/sprite/lore coverage, required variable IDs, and clean preflight. Omitted fields are not required; an empty object clears the goal.",
      parameters: { type: "object", properties: {
        criteria: { type: "object", properties: {
          scenePeriods: { type: "object", properties: {
            periods: { type: "array", items: { type: "string", enum: ["day", "evening", "night"] }, minItems: 1, uniqueItems: true },
            scope: { type: "string", enum: ["global", "all-contexts"] },
          }, required: ["periods"], additionalProperties: false },
          characterCoverage: { type: "object", properties: {
            portrait: { type: "boolean" }, sprite: { type: "boolean" }, lore: { type: "boolean" },
          }, additionalProperties: false },
          requiredVariableIds: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 100, uniqueItems: true },
          cleanPreflight: { type: "boolean" },
        }, additionalProperties: false },
      }, required: ["criteria"], additionalProperties: false },
    },
  },
  {
    type: "function", function: {
      name: "check_acceptance_criteria",
      description: "Re-evaluate this run's saved acceptance criteria against the current working world and report exactly what remains unmet. Read-only.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "analyze_token_cost",
      description:
        "Analyze the world's per-turn token cost, INCLUDING the keyword-triggered lore pool that the editor's \"per-turn\" estimate hides (the footer counts only always-send entries + variable rules). Returns: keyword-lore entry count + pool tokens, worst-case lore injected in one turn (bounded by lorebookBudgetCap / lorebookBudgetPercent), the always-send + variable-rule footprint for contrast, recursion/cap settings, and — when the keyword pool is heavy with no effective ceiling — a flood-risk advisory + fix priority. Call this when the creator asks about token cost / bloat / slimming, AFTER any batch of lore-heavy writes (report the headline number to the creator in one sentence), and as step 1 of any slimming pass (see the slim skill). Findings are advisory — never delete or rewrite content based on them without the creator's approval. Auto-executes, no approval needed, no parameters.",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
];

// ── Write Tools (collected, validated atomically, approval classified) ──

export const WRITE_TOOLS: ToolDefinition[] = [
  {
    type: "function", function: {
      name: "write_world_media",
      description: "Set independent card portrait cover and optional wide page banner from existing owned image @asset:UUID refs, or change their framing. Read world-media with read_entities first. Only supplied fields change; null clears that image or framing, and clearing the banner restores portrait fallback. Image changes preserve framing unless a crop field is supplied. This does not generate images, edit character portraits, modify gallery images, or rewrite custom source. Portraits appear in card grids; page banners use 16:5 and default to contain.",
      parameters: { type: "object", minProperties: 1, additionalProperties: false, properties: {
        portraitAssetRef: { type: ["string", "null"], pattern: "^@asset:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Owned image from list_assets; null clears the portrait cover. Omit to preserve it." },
        bannerAssetRef: { type: ["string", "null"], pattern: "^@asset:[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$", description: "Owned image for the independent page banner; null clears it and restores portrait fallback. Omit to preserve it." },
        coverCrop: { type: ["object", "null"], additionalProperties: false, properties: { x: { type: "number", minimum: -45, maximum: 45 }, y: { type: "number", minimum: -45, maximum: 45 }, zoom: { type: "number", minimum: 0.25, maximum: 3 }, fit: { type: "string", enum: ["cover", "contain"] } }, description: "Replace portrait grid framing. Missing coordinates default to 0, zoom to 1, fit to cover; read and preserve the other coordinates when changing one. null resets framing; omission preserves it." },
        bannerCrop: { type: ["object", "null"], additionalProperties: false, properties: { x: { type: "number", minimum: -45, maximum: 45 }, y: { type: "number", minimum: -45, maximum: 45 }, zoom: { type: "number", minimum: 0.25, maximum: 3 }, fit: { type: "string", enum: ["cover", "contain"] } }, description: "Replace page banner framing. Supply fit=contain for full artwork in 16:5; missing coordinates default to 0, zoom to 1 and fit to cover. null restores the default contain framing; omission preserves it." },
      } },
    },
  },
  { type: "function", function: { name: "write_chapter", description: "Create or partially update a native starting chapter. Stable ID; omitted fields are preserved. Chapters group greeting openings under Routes and are selectable ONLY before leaving the greeting. Link existing greetings with greetingIds and lorebooks with write_worldbook.chapterIds. Starting values come from each greeting's initialVariables. There is no in-play chapter navigation. Use timeline/date labels for eras and alternate histories. Read chapters first, preserve character roles and authored text, then validate_world.", parameters: { type: "object", properties: {
    id: { type: "string" }, name: { type: "string" }, enabled: { type: "boolean" }, description: { type: "string" }, timeline: { type: "string" }, date: { type: "string" },
    greetingIds: { type: "array", items: { type: "string" }, description: "Existing greeting entry IDs. One enabled chapter per greeting." },
    events: CHAPTER_EVENTS_TOOL_SCHEMA,
  }, required: ["id"] } } },

  {
    type: "function",
    function: {
      name: "write_route",
      description: "Create or partially update a built-in story route for Classic, VN or custom interfaces. Read existing IDs with read_entities first. Reusing an ID preserves omitted fields; a new globally unique ID creates a route. The engine selects by conditions then descending priority and lexical ID for ties. Validate with validate_world after changes.",
      parameters: { type: "object", properties: {
        id: { type: "string", description: "Existing route ID for an edit, or a new globally unique kebab-case ID." }, name: { type: "string" },
        enabled: { type: "boolean", description: "New routes default to true. False retains the definition but excludes it from new selection." },
        priority: { type: "integer", description: "Higher wins among eligible routes; defaults to 0." },
        guidance: { type: "string", description: "Narrative direction captured on route entry and included in gameplay prompts." },
        conditions: { type: "array", items: STORY_CONDITION_TOOL_SCHEMA, description: "Replaces the complete condition list. Empty means immediately eligible." },
        conditionLogic: { type: "string", enum: ["all", "any"], description: "Defaults to all (every condition); any requires one matching condition." },
        lockOnEntry: { type: "boolean", description: "Defaults false. True locks the captured route against later route switches and definition edits." },
      }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_ending",
      description: "Create or partially update a built-in fixed-outcome ending for Classic, VN or custom interfaces. Read existing IDs with read_entities first; reusing an ID preserves omitted fields. New endings default disabled so unfinished drafts cannot end play. Enable only after supplying an outcome, valid conditions/route bindings, and authored prose or AI guidance. Validate with validate_world. Definition edits do not rewrite already captured session endings.",
      parameters: { type: "object", properties: {
        id: { type: "string", description: "Existing ending ID for an edit, or a new globally unique kebab-case ID." }, name: { type: "string" },
        enabled: { type: "boolean", description: "Defaults false on creation. True makes a complete ending eligible." },
        priority: { type: "integer", description: "Higher wins among eligible endings; lexical ID breaks ties. Defaults to 0." },
        routeIds: { type: "array", items: { type: "string" }, description: "Replaces route restrictions with existing route IDs. Empty permits any route, including no active route." },
        conditions: { type: "array", items: STORY_CONDITION_TOOL_SCHEMA, description: "Replaces the complete condition list; use a specific finale variable to avoid ending as soon as a route is entered." },
        conditionLogic: { type: "string", enum: ["all", "any"] },
        allowUnconditional: { type: "boolean", description: "Defaults false. Must explicitly be true for an ending with no conditions; route restrictions still apply." },
        outcome: { type: "string", description: "Nonempty fixed result that the ending presentation must preserve." },
        mode: { type: "string", enum: ["authored", "ai"], description: "Defaults authored: exact creator prose. ai: generated closing prose constrained by outcome and guidance." },
        prose: { type: "string", description: "Required nonempty text when an authored ending is enabled." },
        guidance: { type: "string", description: "Required nonempty closing instructions when an AI ending is enabled." },
      }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_status_visualization",
      description: "Create or replace the custom player status layout inside UI options → Visualizations. Use this for bespoke status designs instead of changing status-view.tsx or status-sheet.tsx. The layout is mounted inside the existing right Status sheet; Menu, Back, Close, and confirmed state remain wired. Read status-layout.tsx and status-config.ts first. Export a default React component accepting {config, variables, preview}. Variables are the latest confirmed game state. React and Icons are globals; local status-data and status-widgets helpers may be imported. Use edit_status_visualization for small edits.",
      parameters: { type: "object", properties: {
        layoutCode: { type: "string", description: "Complete React layout source with a default export. Render within the sheet content; bind actual variables, preserve data-driven field configuration, use scoped styles and responsive markup." },
      }, required: ["layoutCode"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_character_showcase_css",
      description: "Update CSS for Publish → Character showcase on the PUBLISHED story/world card's profile page. Read card-showcase with read_entities first. Preserve existing CSS rules during small edits. This changes only the public card presentation, never character entries or the playable story UI. CSS is isolated inside the card profile. Use .card-showcase or :scope for its root. Empty CSS restores default styling while retaining the public HTML.",
      parameters: { type: "object", properties: {
        css: { type: "string", maxLength: 30000, description: "Complete CSS for the published card profile. Preserve existing rules during small edits; empty string clears styles." },
      }, required: ["css"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_card_showcase",
      description: "Create or edit Publish → Character showcase: custom public HTML/CSS on the published story/world card's PROFILE page, like a styled introduction with images, sections and badges. Read card-showcase first. Supply only the fields being changed; omitted HTML/CSS is preserved. This does not edit game characters, their popup viewer, dialogue or the playable layout. Keep the HTML public-facing. Scripts and embedded apps are unavailable; use responsive HTML/CSS, .card-showcase as the root, and @asset:ID for owned images.",
      parameters: { type: "object", properties: {
        html: { type: "string", maxLength: 100000, description: "Public HTML fragment. Empty HTML uses the card name, cover and description. Never copy private lore or hidden character profiles into this public content." },
        css: { type: "string", maxLength: 30000, description: "CSS for this public profile; empty CSS clears its styles." },
      } },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_status_visualization",
      description: "Edit the current custom layout in UI options → Visualizations. Changes only status-layout.tsx, preserving the managed renderer, right sheet and Back action. Read status-layout.tsx with read_entities, then provide a unique current snippet and its replacement. The component must retain its default export and live variable bindings.",
      parameters: { type: "object", properties: {
        old_code: { type: "string", description: "Exact current layout snippet that appears once." },
        new_code: { type: "string", description: "Replacement layout snippet." },
      }, required: ["old_code", "new_code"] },
    },
  },
  {
    type: "function", function: {
      name: "edit_vn_assets",
      description: "Assign/remove an emotion within spriteType and optional spriteVariant, add/rename/remove nested outfit variants, set/clear chapter outfit presets via chapterOpeningId, set/clear per-character/type clothing descriptions, add/rename/remove card-wide type/emotion catalog options, assign background periods, set/clear a collection's default background, reorder existing cards, or configure NPC defaults. Send operations as one validated batch when handling multiple independent assignments. Read list_vn_assets first. Use owned image @asset refs from list_assets or generated image jobs. Preserves authored runtime code and unrelated assignments; rejects custom executable maps. Global backgrounds omit openingId; opening collections use stable greeting IDs. Order accepts returned row IDs and preserves hidden slots when reordering a subset.",
      parameters: { type: "object", properties: {
        operations: { type: "array", minItems: 1, maxItems: 50, description: "Validated batch of operations; use this instead of the single-operation fields when assigning multiple assets.", items: { type: "object", properties: {
          kind: { type: "string", enum: ["sprites", "backgrounds"] },
          action: { type: "string", enum: ["assign", "remove", "set_default", "clear_default", "reorder", "configure_npc_defaults", "add_option", "rename_option", "remove_option", "set_wardrobe_description", "add_variant", "rename_variant", "remove_variant", "set_chapter_outfit", "clear_chapter_outfit"] },
          openingId: { type: "string" }, npcGender: { type: "string", enum: ["male", "female"] }, name: { type: "string" },
          spriteType: { type: "string" }, spriteVariant: { type: "string" }, chapterOpeningId: { type: "string" }, optionKind: { type: "string", enum: ["types", "emotions"] }, optionId: { type: "string" }, label: { type: "string" },
          description: { type: "string", maxLength: 2000, description: "set_wardrobe_description requires kind sprites, name, spriteType and description; empty removes. Character outfits only, no NPC/opening scope." },
          variant: { type: "string" }, assetRef: { type: "string" }, order: { type: "array", items: { type: "string" } },
          disabled: { type: "boolean" }, mode: { type: "string", enum: ["a", "b"] },
        }, required: ["kind", "action"] } },
        kind: { type: "string", enum: ["sprites", "backgrounds"] },
        action: { type: "string", enum: ["assign", "remove", "set_default", "clear_default", "reorder", "configure_npc_defaults", "add_option", "rename_option", "remove_option", "set_wardrobe_description", "add_variant", "rename_variant", "remove_variant", "set_chapter_outfit", "clear_chapter_outfit"] },
        openingId: { type: "string", description: "Greeting entry ID for opening backgrounds; omit for Global." },
        chapterOpeningId: { type: "string", description: "Greeting ID for set_chapter_outfit/clear_chapter_outfit; separate from shared assignment scope." },
        spriteVariant: { type: "string", description: "Nested outfit ID under spriteType; omit or empty for Base. Used by assignment, removal, description and variant actions. Distinct from variant (emotion)." },
        npcGender: { type: "string", enum: ["male", "female"] },
        name: { type: "string", description: "Character name, scene ID, or NPC sprite name." },
        spriteType: { type: "string", description: "Character wardrobe ID from spriteConfig (default normal). Not used for NPCs/backgrounds." },
        optionKind: { type: "string", enum: ["types", "emotions"], description: "Card-wide catalog edited by add_option, rename_option or remove_option." },
        optionId: { type: "string", description: "Existing catalog ID for rename/remove. Rename changes its label and preserves stable assignments." },
        label: { type: "string", description: "Display label for add/rename; add derives the stable ID. Defaults are protected; unlimited types, 30 emotions, warning at 20. Removal also removes assignments, retaining library assets." },
        description: { type: "string", maxLength: 2000, description: "For set_wardrobe_description, supply kind sprites, character name, configured spriteType and clothing text; empty removes. No NPC/opening scope. Use {{sprite_wardrobe}} in character lore for this mutable outfit text." },
        variant: { type: "string", description: "Emotion ID from spriteConfig (default normal) or time of day (default day)." },
        assetRef: { type: "string", description: "Owned image's @asset reference." },
        order: { type: "array", items: { type: "string" }, description: "Unique row IDs from list_vn_assets in the desired order." },
        disabled: { type: "boolean", description: "Whether fallback NPC sprites are disabled." },
        mode: { type: "string", enum: ["a", "b"], description: "Fallback NPC sprite set." },
      }, required: ["kind", "action"] },
    },
  },
  {
    type: "function",
    function: {
      name: "write_entry",
      description:
        "Create or update a world entry (character, lore, plot, style, greeting, etc). If the ID already exists it updates only the provided fields; otherwise creates a new entry. Call multiple write_entry tools in parallel to create several entries at once. SIZE LIMIT: keep a single entry's content under ~4,000 CJK characters (~3,000 English words). For a large cast, write ONE ENTRY PER CHARACTER (shared keywords/conditions) instead of one giant group entry — per-character entries also let keyword gating load only who's on stage. When a task needs several large entries, write them across MULTIPLE turns (1-2 large writes per reply, then continue after seeing the tool results) — never batch all of them into one enormous reply.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Descriptive kebab-case ID (e.g. 'tavern-lore', 'alice-greeting')." },
          name: { type: "string" },
          content: { type: "string", description: "Entry text sent to the LLM. Supports {{char}}, {{user}}, {{variableId}} macros." },
          portrait: { type: "string", description: "Character portrait @asset reference. Empty string removes the portrait." },
          role: { type: "string", enum: ["system", "character", "personality", "scenario", "lore", "plot", "style", "example", "greeting", "custom"], description: "Set explicitly for new entries: use character for every character/NPC/person profile, including keyword-triggered character lore. This enables portrait uploads and the character viewer without requiring a portrait. Tags and section do not replace role. On partial updates, omit to preserve the existing role; correct a misclassification using the same ID." },
          section: { type: "string", enum: ["system-presets", "examples", "chat-history", "post-history"] },
          keywords: { type: "array", items: { type: "string" }, description: "Trigger words for chat-history entries." },
          enabled: { type: "boolean" },
          depth: { type: "number", description: "For chat-history: inject N messages from the end." },
          tags: { type: "array", items: { type: "string" } },
          apiRole: { type: "string", enum: ["system", "user", "assistant"] },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "State conditions: [{ variableId, operator, value }]" },
          conditionLogic: { type: "string", enum: ["all", "any"] },
          alwaysSend: { type: "boolean" },
          matchWholeWords: { type: "boolean" },
          secondaryKeywords: { type: "array", items: { type: "string" } },
          secondaryKeywordLogic: { type: "string", enum: ["AND_ANY", "AND_ALL", "NOT_ANY", "NOT_ALL"] },
          useFuzzyMatch: { type: "boolean", description: "Enable fuzzy keyword matching for misspellings." },
          preventRecursion: { type: "boolean", description: "Stop this entry's content from triggering more entries." },
          excludeRecursion: { type: "boolean", description: "Don't trigger this entry during recursive scans." },
          folderId: { type: "string", description: "Folder ID for editor organization (UI-only, no prompt effect). If the folder doesn't exist it's auto-created with this id as its name; user can rename it later." },
          position: { type: "number", description: "Position in section (auto-calculated if omitted)." },
          worldbookId: { type: "string", description: "Knowledge base (worldbook) this entry belongs to (see write_worldbook). Omit or \"\" = the always-on Core book. Entries in a non-Core book are gated by that book's activation BEFORE their own alwaysSend/keyword/condition trigger — so alwaysSend means 'always while this book is active', not globally." },
          audience: { type: "string", enum: ["ai", "player", "both"], description: "Who receives this entry's content: 'ai' (prompt only — hidden director notes), 'player' (UI-facing only; the model is NOT told it), 'both' (default)." },
          initialVariables: { type: "object", description: "GREETING entries only: declared variableId → starting value seeded when this opening is picked. Supports chapter/route/scenario, era and alternate-timeline presets, e.g. { \"chapter\": \"holder\", \"timeline\": \"main\", \"story-year\": 2280 }. Declare variables first; seed all opening-controlled selectors. Several greetings can start the same chapter. Bind lore with worldbook greetingIds or conditions. This does not transfer playthrough history or fork a save." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_variable",
      description:
        "Create or update a game variable (HP, gold, flags, inventory, etc). If the ID already exists it updates only the provided fields. behaviorRules is critical — it tells the AI when and how to modify this variable during gameplay.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Kebab-case ID used in {{id}} macros and [id: op value] directives." },
          name: { type: "string" },
          type: { type: "string", enum: ["number", "string", "boolean", "json", "list", "group", "choice"], description: "The kind of stored data. In VN mode, list stores all entries (JSON array), group stores named fields (JSON object), and choice stores ONE text value with enumValues for its valid options. Chat retains number/string/boolean/json; do not change its interface to add VN controls." },
          defaultValue: {
            description:
              "Starting value of the SAME data type: number -> 0, boolean -> false, list -> [], group -> {}, string/choice -> \"text\". Send actual arrays/objects, not quoted JSON. Omitted fields preserve existing values. New lists/groups start as []/{}; a new choice with no default starts as empty text. Converting a collection to choices requires an explicit scalar string defaultValue.",
          },
          enumValues: { type: "array", maxItems: 500, uniqueItems: true, items: { type: "string", maxLength: 1000 }, description: "VN only: valid text options for a string/choice variable, preserving exact spelling and order. This is dropdown metadata, not a stored List or runtime write restriction. Omit to preserve current options. [] keeps an empty editable options list; use clearOptions:true to return to plain Text. Options-only edits preserve the current starting value even if it is outside the new list." },
          clearOptions: { type: "boolean", description: "VN only: true explicitly removes text options while preserving the starting text. Do not combine with enumValues or type:choice. Omit or false to retain current options." },
          min: { type: "number" },
          max: { type: "number" },
          category: { type: "string", enum: ["stat", "inventory", "resource", "flag", "relationship", "custom"] },
          behaviorRules: { type: "string", description: "Detailed instructions for the AI: when to change it, by how much, edge cases." },
          description: { type: "string" },
          scope: { type: "string", enum: ["narrative", "setup"], description: "Lifecycle scope. Omit/'narrative' for ordinary game state (captured in per-message snapshots, restored on revert/branch/opening-switch). Use 'setup' for a once-at-start config choice written by a pre-game UI screen (e.g. the cast the player picked) that MUST survive an opening switch — without it the choice is wiped to default the moment the player picks an opening. See world-design Pattern 7." },
          internal: { type: "boolean", description: "Mark true for an engine-bookkeeping variable the player/AI should never see — e.g. the json history array a random list-pick uses for its cooldown. Internal vars persist normally but are hidden from the creator's Variables list AND never rendered into <game-state>. Use this for a random-pick's historyVar." },
          aiAccess: { type: "string", enum: ["write", "read", "none"], description: "What the AI may do with this variable. 'write' (default): in <game-state>, updatable via directives — for state only the AI can judge (affinity, mood). 'read': in <game-state> with a read-only marker; AI directives targeting it are DROPPED — for engine-owned state the AI should narrate but never change (phase, rating, settlement result); drive it from behaviors/UI. 'none': never sent to the AI at all — ledgers, counters, bookkeeping; still fully usable in conditions/behaviors/custom UI. Prefer 'read'/'none' over behaviorRules prose like \"don't touch this\" — the engine enforces it." },
          activation: { type: "object", description: "When the variable is 'in play' (same shape as a worldbook's activation). Omit = always. { mode:'manual' } — gated by `enabled` + runtime @vars.enabled.<id> toggles from behaviors. { mode:'conditions', conditions:[{variableId,operator,value}], conditionLogic:'all'|'any' } — active while conditions match (valueRef supported, incl. self-gating like 'show rage only while > 0'). { mode:'greeting', greetingIds:[...] } — active only in sessions on those openings. An INACTIVE variable leaves <game-state> and the player UI and rejects AI writes, but KEEPS its value — conditions/behaviors/custom UI still read it." },
          enabled: { type: "boolean", description: "Enable-gate default (default true). Mostly for activation mode 'manual': start disabled, then a behavior flips it on via a THEN effect on path '@vars.enabled.<id>'." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_behavior",
      description:
        "Create or update an event-driven behavior (reaction). Behaviors fire WHEN an event occurs, IF conditions are met, THEN apply effects. If the ID already exists it updates only the provided fields.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          when: {
            type: "object",
            description: "Event pattern: { eventType: 'turn:complete'|'message:user'|'message:ai'|'session:start'|'state:changed'|'state:crossed'|'action:fired'|'audio:track-ended'|'spatial:zone-enter'|'spatial:zone-leave'|'spatial:proximity-enter'|'spatial:interact'|'spatial:proximity-leave'|'spatial:scene-change'|'spatial:exit-overlap', match?: { field: { operator, value } } }",
          },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "State conditions: [{ variableId, operator, value }]" },
          conditionLogic: { type: "string", enum: ["all", "any"] },
          then: {
            type: "array",
            items: { type: "object", properties: { type: { type: "string" }, path: { type: "string" }, value: {}, operation: { type: "string" }, valueRef: { type: "string" }, valueRandom: { type: "object" } } },
            description: "Effects: [{ type:'set', path:'variableId', value:..., operation:'set'|'add'|'subtract'|'multiply'|'toggle'|'append' }]. The value can be a literal, valueRef (another variable's value), or valueRandom (a random draw resolved at fire time): { kind:'range', min, max, integer? } | { kind:'dice', count, sides, modifier? } | { kind:'list', candidates:[...], weights?:[...], cooldown?:N, historyVar?:'var', onExhausted?:'full'|'keep' }. For a list draw the operation must be 'set'. Also: { type:'emit', event:{ type:'ui:notification', message:'...' } }. System paths: '@vars.enabled.<variableId>' with a boolean value toggles that variable's enable gate (see write_variable activation).",
          },
          priority: { type: "number" },
          enabled: { type: "boolean" },
          cooldownTurns: { type: "number" },
          maxFireCount: { type: "number" },
          chance: { type: "number", description: "0-100: probability this behavior fires when it otherwise would. Omit/100 = always. Use for 'sometimes it happens' random events." },
          description: { type: "string" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_custom_ui",
      description:
        "Create or update a file in the world's rootComponent. Every world has exactly one rootComponent — a multi-file virtual filesystem that renders the entire visual experience. `id` is the filename (e.g. 'index.tsx', 'homepage.tsx', 'bubble.tsx'); the `index.tsx` entry file is what actually mounts. Supports three languages: 'tsx' (default, React with useYumina() SDK + Chat/MessageList/MessageInput building blocks), 'html' (raw HTML/CSS/JS with window.yumina), 'markdown' (static). For small edits to existing code, prefer edit_custom_ui — it's faster and avoids output truncation.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Filename inside rootComponent.files (e.g. 'index.tsx', 'homepage.tsx', 'status-config.ts'). New .ts/.tsx/.js/.jsx files are created separately from the entry. Status visualization settings use a literal JSON statusConfig export; see front-ui skill. Non-filename IDs write to the entry file." },
          name: { type: "string" },
          language: { type: "string", enum: ["tsx", "html", "markdown"], description: "Component language. 'tsx' (default): React with useYumina() hook. 'html': raw HTML/CSS/JS with window.yumina global. 'markdown': static content." },
          tsxCode: { type: "string", description: "Component source code. TSX for language='tsx', HTML for language='html', markdown for language='markdown'. Use useYumina() SDK only — never fetch/localStorage/window.location directly." },
          description: { type: "string" },
          visible: { type: "boolean" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "edit_custom_ui",
      description:
        "Edit existing code in a rootComponent file via search-replace. PREFER this over write_custom_ui for modifications — sends only the changed section, not the whole file. The old_code string must appear EXACTLY ONCE in the current file. If it appears 0 or 2+ times, include more surrounding lines for a unique match.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string", description: "Existing filename inside rootComponent.files (e.g. 'index.tsx', 'homepage.tsx', 'status-config.ts'). For status visualizations, edit status-config.ts while preserving the literal JSON export and unrelated fields. Non-filename IDs target the entry file." },
          old_code: { type: "string", description: "Exact code snippet to find. Must appear exactly once. Include surrounding lines if needed for uniqueness." },
          new_code: { type: "string", description: "Replacement code snippet." },
        },
        required: ["id", "old_code", "new_code"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_audio",
      description:
        "Create or update an audio track (BGM, SFX, or ambient). Use @asset:{id} for uploaded audio URLs.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          type: { type: "string", enum: ["bgm", "sfx", "ambient"] },
          url: { type: "string", description: "Audio URL or @asset:{id} reference." },
          loop: { type: "boolean" },
          volume: { type: "number" },
          fadeIn: { type: "number" },
          fadeOut: { type: "number" },
          maxDuration: { type: "number", description: "Auto-stop after N seconds (useful for SFX)." },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_settings",
      description:
        "Update world-level generation settings and player identity.",
      parameters: {
        type: "object",
        properties: {
          maxTokens: { type: "number" },
          temperature: { type: "number" },
          playerName: { type: "string" },
          nameGeneratorProfiles: NAME_PROFILES_TOOL_SCHEMA,
          storyStructureEnabled: { type: "boolean", description: "Whether structured route and ending progression is enabled. Defaults on; disable for an open-ended story." },
          topP: { type: "number" },
          frequencyPenalty: { type: "number" },
          presencePenalty: { type: "number" },
          topK: { type: "number" },
          minP: { type: "number" },
          lorebookScanDepth: { type: "number", description: "How many recent messages to scan for keyword triggers (default 2)." },
          lorebookRecursionDepth: {
            type: "number",
            description:
              "How many extra passes re-scan TRIGGERED entries' own text for more keywords (default 0). >0 makes lore entries trigger each other and can cascade into firing most of the lorebook every turn. Set 0 unless the card genuinely needs chained reveals.",
          },
          lorebookBudgetCap: {
            type: "number",
            description:
              "Hard ceiling (in tokens) on keyword-triggered lore injected per turn. 0 = no cap (default), meaning ALL matched entries inject — the #1 cause of runaway per-turn cost on lore-heavy cards. Set e.g. 20000-30000 as a safety ceiling.",
          },
          lorebookBudgetPercent: {
            type: "number",
            description:
              "Lore injection budget as a percent of maxContext (default 100). Lower it (e.g. 25) to bound lore as a fraction of the window. The effective ceiling is min(lorebookBudgetCap, lorebookBudgetPercent% of maxContext).",
          },
        },
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_worldbook",
      description:
        "Create or update a worldbook (the editor calls it a \"knowledge base\") — an independently-activatable group of entries. Organize a shared universe into chapters covering routes, eras or alternate timelines: bind each start's history and character versions to its greeting IDs; several greetings can share compatible chapter lore. Different chapters/dates can belong to the same timeline. Only ACTIVE books' entries reach the AI, even with alwaysSend:true. Assign entries with write_entry { worldbookId }; omit worldbookId for universally valid Core facts (do NOT create a Core book). Existing IDs update only supplied fields. See the lore skill for greeting/condition gating and the shared-universe chapter recipe.",
      parameters: {
        type: "object",
        properties: {
          chapterIds: { type: "array", items: { type: "string" }, description: "Native chapter IDs. Nonempty links replace this book's opening/condition activation with current-chapter membership. Master enabled=false still wins. Empty restores its ordinary activation." },
          id: { type: "string", description: "Kebab-case worldbook ID, referenced by entry.worldbookId." },
          name: { type: "string" },
          enabled: { type: "boolean", description: "Master on/off. false = never active regardless of activation mode. Default true." },
          order: { type: "number", description: "Sort order in the editor (default 0)." },
          color: { type: "string", description: "Optional editor color tag (hex or token)." },
          activation: {
            type: "object",
            description:
              "When this book is online. Only THREE modes exist: 'always' (always on, like Core); 'conditions' (online while variable conditions pass — e.g. route=='mayu'); 'greeting' (online only when the player started on one of the listed openings).",
            properties: {
              mode: { type: "string", enum: ["always", "conditions", "greeting"] },
              conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "For mode 'conditions'." },
              conditionLogic: { type: "string", enum: ["all", "any"] },
              greetingIds: { type: "array", items: { type: "string" }, description: "For mode 'greeting': the greeting (opening) entry IDs that activate this book." },
            },
          },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_lore_binding",
      description:
        "Bind a frontend lore control to an entry: while a <LoreSlot id=slotId> / <LoreButton slotId=...> in the rootComponent TSX is active (mounted/toggled by the PLAYER), the bound entry becomes eligible for AI injection. Use for player-controlled lore (a \"show advanced rules\" toggle, a codex chip). Write the <LoreButton>/<LoreSlot> in TSX via write_custom_ui (see front-ui skill); this tool wires the slotId → entryId binding. Upserts by slotId.",
      parameters: {
        type: "object",
        properties: {
          slotId: { type: "string", description: "Slot id used in the TSX (<LoreSlot id> / <LoreButton slotId>). This is the binding key." },
          entryId: { type: "string", description: "ID of the entry that activates when this slot is active." },
          conditions: { type: "array", items: { type: "object", properties: { variableId: { type: "string" }, operator: { type: "string" }, value: {} } }, description: "Optional extra state conditions that must ALSO pass for the binding to activate." },
          conditionLogic: { type: "string", enum: ["all", "any"] },
        },
        required: ["slotId", "entryId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_entities",
      description:
        "Delete one or more entities by ID. Each ID is looked up across all entity types (entries, variables, behaviors, rules, routes, endings, customUI, audio, worldbooks, lore bindings). Always requires user approval.",
      parameters: {
        type: "object",
        properties: {
          ids: {
            type: "array",
            items: { type: "string" },
            description: "Entity IDs to delete.",
          },
        },
        required: ["ids"],
      },
    },
  },
];

// ── Control Tools (yield to user) ──
// Control tools don't read or mutate the world — they change run flow.
// `ask_user` ends the run in "awaiting_user" status so the user can reply.

const CONTROL_TOOLS: ToolDefinition[] = [
  {
    type: "function", function: {
      name: "import_danbooru_image",
      description: "Import a selected Danbooru post into the creator's owned image library, preserving source attribution, and return its @asset ref. Requires Danbooru enabled in Settings. Use an integer postId returned by search_danbooru_images. Reuses a prior import of the same post. It imports existing artwork and does not generate variations, remove backgrounds, or assign it automatically. Use edit_vn_assets in the next turn with the returned ref.",
      parameters: { type: "object", properties: {
        postId: { type: "integer", minimum: 1 },
        filename: { type: "string", description: "Optional descriptive library filename." },
      }, required: ["postId"] },
    },
  },
  {
    type: "function",
    function: {
      name: "ask_user",
      description:
        "Ask the user a clarifying question and yield control back to them. Call this INSTEAD OF ending your turn with a question in plain text — otherwise the run has no way to pause and the user can't answer. Use when you need a human decision (direction, scope, taste, destructive-action confirmation). MUST NOT be combined with any other tool call in the same turn.",
      parameters: {
        type: "object",
        properties: {
          question: {
            type: "string",
            description: "The question to show the user. Keep it direct; put selectable answers in options instead of an inline list.",
          },
          rationale: {
            type: "string",
            description: "Optional one-line reason for asking instead of proceeding on your own.",
          },
          options: {
            type: "array",
            maxItems: 4,
            description: "Optional short answer choices. The creator can also write a custom answer.",
            items: {
              type: "object",
              properties: {
                label: { type: "string", description: "Short selectable answer." },
                description: { type: "string", description: "Optional one-line detail." },
              },
              required: ["label"],
            },
          },
        },
        required: ["question"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_image",
      description:
        "Queue one picture as a cancellable background job. Resolve owned character, scene, style and creator references automatically, label their roles, and keep the references attached to the job. Offer three generators for both character sprites and scene backgrounds: Anima and Krea are local NSFW-capable choices, and Codex is SFW-only. Default all SFW requests, including first designs and reference-guided variations, to Codex native image generation through GPT-6.1 Sol xhigh; Codex chooses its own image submodel. Automatically exclude Codex when contentRating=nsfw, keeping the NSFW rating. Anima requires an installed NSFW-capable checkpoint for NSFW requests. If the creator explicitly requests Krea or Krea2-Anime, set imageWorkflow=krea for that job even when it is SFW. For explicit NSFW requests, use local Krea2-Anime v2.0 INT4 for character sprites and scene backgrounds; never send NSFW prompts or references to Codex or Forge Neo. Krea2-Anime is NSFW-capable. NSFW sprite and background generation is text-to-image only: the configured NSFW vision model reads references and converts their visible features into a text description before generation. Reference pixels are never sent to the NSFW image generator; do not use reference-to-image. NSFW backgrounds use imageKind=background, contentRating=nsfw and remain opaque. Use 8 or more steps and do not add a 4-step Turbo LoRA to this fine-tune. Set contentRating=nsfw only when the creator requests NSFW content. Set transparent=true only when a transparent cutout is requested or needed for a VN overlay sprite; opaque art and scene backgrounds must keep their generated background. The queued card exposes a transparent-background checkbox for sprite jobs. The queued card also lets the creator switch among available workflows, select the Anima model, set CFG/steps, choose random or fixed seed, and choose SFW/NSFW; selecting NSFW excludes SFW-only generators and checkpoints without downgrading the rating. Never pass URLs, storage keys, file paths, or refs that did not come from the asset tools. Call get_image_sources first. Anima and Krea run segmentation only when transparent=true; opaque outputs preserve their background. Codex requests native alpha only when transparent=true and is SFW-only. Use imageKind background for opaque scenes; never run background removal for scene backgrounds. For multiple pictures, make one generate_image call per picture together in the same turn; local GPU jobs are bounded to one at a time. Continue other work while they run. Background job status supplies completed @asset refs for assignment. If still drawing, say so and do not poll repeatedly or claim success. Each image call starts one configured generation.",
      parameters: {
        type: "object",
        properties: {
          source: { type: "string", enum: ["codex", "comfyui", "forgeneo"], description: "Image connection. Usually choose via imageWorkflow; omit for the automatic SFW Codex or NSFW Krea default." },
          imageWorkflow: { type: "string", enum: ["anima", "krea", "codex"], description: "Optional workflow override. If the creator explicitly requests Krea or Krea2-Anime, select krea even for SFW requests. Anima and Krea2-Anime v2.0 INT4 generate local sprites and backgrounds; both use NSFW text-to-image with vision-described references, and Anima requires an NSFW-capable checkpoint; Codex uses its native SFW image tool through GPT-6.1 Sol xhigh and selects the image submodel internally. The creator can change this in the queued card." },
          contentRating: { type: "string", enum: ["sfw", "nsfw"], description: "Set nsfw only when requested by the creator. NSFW is accepted only for local Krea or an installed Anima checkpoint tagged NSFW-capable; Codex and Forge Neo are SFW-only." },
          animaModel: { type: "string", description: "Optional installed Anima checkpoint. The image card excludes SFW-only checkpoints when NSFW is selected." },
          cfg: { type: "number", minimum: 0.5, maximum: 8, description: "Local Anima/Krea guidance scale; defaults to 1." },
          steps: { type: "integer", minimum: 1, maximum: 20, description: "Local Anima/Krea sampling steps; defaults to 8." },
          seedMode: { type: "string", enum: ["random", "fixed"], description: "Local generation seed mode. Use random by default; fixed requires seed." },
          seed: { type: "integer", minimum: 0, maximum: Number.MAX_SAFE_INTEGER, description: "Optional reproducible local generation seed." },
          imageKind: { type: "string", enum: ["sprite", "background", "image"], description: "Use sprite for character artwork; background for an opaque environment; image for other artwork. Scene backgrounds are opaque and never use background removal." },
          transparent: { type: "boolean", description: "Set true only when a transparent PNG cutout is needed, such as a character sprite layered over a VN scene. Otherwise preserve the generated background. Scene backgrounds stay opaque." },
          referenceAssetRefs: { type: "array", maxItems: 5, items: { type: "string" }, description: "Optional exact @asset refs from list_assets or list_vn_assets. Only owned project-library images are accepted. They can guide local Anima/Krea or Codex generation; never send URLs or file paths." },
          target: {
            type: "object",
            description: "Optional exact asset destination. Usually omit this; the server infers an exact character, scene, and time period from the creator's request when possible. Ambiguous results stay in the library.",
            properties: {
              kind: { type: "string", enum: ["background", "sprite", "portrait", "cg", "library"] },
              sceneId: { type: "string" }, period: { type: "string" }, openingId: { type: "string" },
              characterId: { type: "string" }, expression: { type: "string", description: "Emotion ID from list_vn_assets spriteConfig." }, spriteType: { type: "string", description: "Wardrobe ID from the card catalog; defaults to normal." }, spriteVariant: { type: "string", description: "Exact nested outfit variant ID under spriteType; omit or empty for Base. No cross-outfit reference fallback." },
            },
          },
          prompt: {
            type: "string",
            description: "Concrete artwork prompt with identity, outfit, expression and pose details. Set transparent=true only for a requested cutout; Anima/Krea segmentation and legacy chroma removal are skipped otherwise. Krea can generate NSFW backgrounds; keep those opaque. No text or UI inside the image unless requested.",
          },
          model: {
            type: "string",
            enum: IMAGE_TOOL_MODELS.map(model => model.id),
            description:
              "Which generator to run. Judge it yourself from what the picture is for; these are the facts, not a ranking:\n"
              + IMAGE_TOOL_MODELS.map(model => `  ${model.line}`).join("\n")
              + `\nA size or shape a model does not list falls back to that model's default, so choose the size and shape the picture needs first, then a model that offers them. Default ${SMART_IMAGE_MODEL}. Give your reason in modelReason; the confirmation card shows it to the creator next to the price.`,
          },
          modelReason: {
            type: "string",
            description: "One short line, in the creator's language, saying why this generator for this picture (e.g. '要 512 的小图标，只有它能直接出' or '普通插画，选了最便宜的'). The confirmation card shows it beside the model name and price, so the creator can judge the spend before agreeing.",
          },
          purpose: {
            type: "string",
            description: "One short line, in the creator's language, saying what the image is for (e.g. 'Map of the northern kingdom for the travel panel'). Shown on the confirmation card.",
          },
          aspectRatio: {
            type: "string",
            // Derived, never hand-listed: this enum had drifted to seven ratios
            // while the generator had grown to thirteen, so the assistant could
            // not offer shapes the creator could pick themselves.
            enum: [...IMAGE_TOOL_CAPABILITIES.aspectRatios],
            description: "Picture shape. Portraits 2:3 or 3:4, maps and scenes 3:2 or 16:9, covers 3:4, icons 1:1, wide banners 21:9 or 2:1, tall side panels 9:21 or 1:2. Default 1:1.",
          },
          resolution: {
            type: "string",
            enum: [...IMAGE_TOOL_CAPABILITIES.resolutions],
            description: "Output size. 512 for icons and avatars, 1K for in-card art, 2K for covers and scene art; 4K only when the creator asks for print-scale detail, since it costs more and takes longer. Not every model offers every size — an unsupported pick falls back to that model's default. Default 2K.",
          },
          batchSize: {
            type: "integer",
            minimum: 1,
            maximum: 4,
            description: "How many variations to generate (each one is charged). Default 1; offer more only when the creator wants to choose.",
          },
        },
        required: ["prompt"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "generate_images",
      description:
        "Prepare one batch of independently described safe images for ONE creator confirmation. If the request or any reference is NSFW, DO NOT USE IMAGE GENERATION; tell the user it is disabled for NSFW requests. Uploaded or owned-file references require individual generate_image calls with source codex; do not omit them or use this batch tool. Use for multiple characters, scenes, or freeform requests such as '10 women with different hair colors'. Write one item and distinct English prompt per requested output; these are separate pictures, not a collage or variations of a single prompt. No images are generated or billed before confirmation; assistant preparation still has its normal cost. Default to the least expensive suitable model. Omit target to save in the asset library. For character portraits use an existing entry_portrait target, or first wire custom UI once to the managed characterImages module and use component_image targets. Existing pictures are skipped. The backend generates, saves and binds the entire confirmed batch without calling you per image. Call this tool ALONE and end the turn; do not launch generate_image repeatedly or ask the creator to return for every picture. Maximum 30 images per batch; for a larger request clarify the first batch size rather than silently dropping items.",
      parameters: {
        type: "object",
        properties: {
          purpose: { type: "string", description: "Brief batch label in the creator's language." },
          model: { type: "string", enum: IMAGE_TOOL_MODELS.map(model => model.id),
            description: IMAGE_TOOL_MODELS.map(model => model.line).join("\n") + `\nDefault ${SMART_IMAGE_MODEL}.` },
          modelReason: { type: "string", description: "Brief reason for the selected model in the creator's language." },
          referenceAssetRefs: { type: "array", maxItems: 5, items: { type: "string" }, description: "If references are needed, use separate generate_image calls with Codex and pass the exact owned @asset refs there. This batch tool does not accept visual references." },
          aspectRatio: { type: "string", enum: [...IMAGE_TOOL_CAPABILITIES.aspectRatios] },
          resolution: { type: "string", enum: [...IMAGE_TOOL_CAPABILITIES.resolutions] },
          items: {
            type: "array", minItems: 1, maxItems: MAX_IMAGE_BATCH_ITEMS,
            items: {
              type: "object", properties: {
                id: { type: "string", description: "Unique stable ID using letters, digits, hyphens or underscores; at most 80 characters." },
                label: { type: "string", description: "Short name shown on the confirmation card, e.g. 'Red hair' or 'Alice'." },
                prompt: { type: "string", maxLength: 2000, description: "Complete visual description for THIS picture, with the intended variation explicitly specified." },
                target: { type: "object", properties: {
                  kind: { type: "string", enum: ["entry_portrait", "component_image"] },
                  entryId: { type: "string", description: "Existing character entry ID, for entry_portrait." },
                  key: { type: "string", description: "Existing key in _generated/character-images.tsx, for component_image." },
                }, required: ["kind"] },
              }, required: ["id", "label", "prompt"],
            },
          },
        },
        required: ["items"],
      },
    },
  },
];

// ── Combined & Sets ──

export const STUDIO_TOOLS: ToolDefinition[] = [...READ_TOOLS, ...WRITE_TOOLS, ...CONTROL_TOOLS];

export const READ_TOOL_NAMES = new Set(READ_TOOLS.map((t) => t.function.name));
// Note: load_skill is in READ_TOOLS (auto-executes) but NOT in WRITE_TOOLS
export const WRITE_TOOL_NAMES = new Set(WRITE_TOOLS.map((t) => t.function.name));
export const CONTROL_TOOL_NAMES = new Set(CONTROL_TOOLS.map((t) => t.function.name));
