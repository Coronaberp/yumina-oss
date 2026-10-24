import { describe, expect, it } from "vitest";
import { worldDefinitionSchema } from "../world/schema.js";
import { mergeWorldDefinition } from "../world/merge.js";
import { detectMaterialChange } from "../diff/material-change.js";
import { createMockWorld } from "./test-utils.js";

const image = "@asset:11111111-1111-4111-8111-111111111111";
const replacement = "@asset:22222222-2222-4222-8222-222222222222";
const crop = { x: 0, y: 0, zoom: 1, fit: "contain" as const };

describe("page banner metadata", () => {
  it("keeps legacy worlds compatible and preserves independent banner metadata", () => {
    const legacy = createMockWorld({ avatar: "portrait.png", coverCrop: { x: 4, y: 5, zoom: 1.2 } });
    expect(worldDefinitionSchema.parse(legacy).bannerImageUrl).toBeUndefined();
    expect(worldDefinitionSchema.parse(legacy).bannerCrop).toBeUndefined();
    const parsed = worldDefinitionSchema.parse({ ...legacy, bannerImageUrl: image, bannerCrop: crop });
    expect(parsed.bannerImageUrl).toBe(image);
    expect(parsed.bannerCrop).toEqual(crop);
    expect(parsed.avatar).toBe("portrait.png");
    expect(parsed.coverCrop).toMatchObject({ x: 4, y: 5, zoom: 1.2 });
  });

  it("accepts explicit clearing and rejects malformed banner metadata", () => {
    expect(worldDefinitionSchema.parse({ ...createMockWorld(), bannerImageUrl: "" }).bannerImageUrl).toBe("");
    for (const bannerImageUrl of [null, 4, {}, "https://example.test/banner.png", "data:image/png;base64,abc", "@asset:wrong"]) {
      expect(worldDefinitionSchema.safeParse({ ...createMockWorld(), bannerImageUrl }).success).toBe(false);
    }
    for (const bannerCrop of [null, [], { x: 46 }, { zoom: 0 }, { fit: "stretch" }]) {
      expect(worldDefinitionSchema.safeParse({ ...createMockWorld(), bannerCrop }).success).toBe(false);
    }
  });

  it("keeps local image and crop edits with concurrent unrelated server edits", () => {
    const base = createMockWorld({ avatar: "portrait.png", bannerImageUrl: image, bannerCrop: crop });
    const local = { ...base, bannerImageUrl: replacement, bannerCrop: { ...crop, x: 5 } };
    const server = { ...base, description: "New server description" };
    const merged = mergeWorldDefinition(base, local, server).merged;
    expect(merged.bannerImageUrl).toBe(replacement);
    expect(merged.bannerCrop).toEqual({ ...crop, x: 5 });
    expect(merged.description).toBe("New server description");
    expect(merged.avatar).toBe("portrait.png");
  });

  it("accepts remote banner edits while preserving independent local portrait edits", () => {
    const base = createMockWorld({ avatar: "portrait.png", bannerImageUrl: image, bannerCrop: crop });
    const merged = mergeWorldDefinition(base, { ...base, avatar: "new-portrait.png" }, { ...base, bannerImageUrl: replacement }).merged;
    expect(merged.avatar).toBe("new-portrait.png");
    expect(merged.bannerImageUrl).toBe(replacement);
  });

  it("keeps explicit banner clearing during concurrent server updates", () => {
    const base = createMockWorld({ bannerImageUrl: image, bannerCrop: crop });
    const merged = mergeWorldDefinition(base, { ...base, bannerImageUrl: "", bannerCrop: undefined }, { ...base, description: "Server edit" }).merged;
    expect(merged.bannerImageUrl).toBe("");
    expect(merged.bannerCrop).toBeUndefined();
    expect(merged.description).toBe("Server edit");
  });

  it("classifies banner additions, replacements and removals as existing cover changes", () => {
    for (const [before, after] of [[undefined, image], [image, replacement], [image, ""]]) {
      const approved = { schema: createMockWorld({ bannerImageUrl: before }), thumbnailUrl: "portrait.png", ageRating: "all" };
      const proposed = { ...approved, schema: { ...approved.schema, bannerImageUrl: after } };
      expect(detectMaterialChange(approved, proposed)).toEqual({ changed: true, reasons: ["cover"] });
    }
  });

  it("keeps empty legacy banners and crop-only changes cosmetic", () => {
    const approved = { schema: createMockWorld(), thumbnailUrl: "portrait.png", ageRating: "all" };
    expect(detectMaterialChange(approved, { ...approved, schema: { ...approved.schema, bannerImageUrl: "", bannerCrop: crop } })).toEqual({ changed: false, reasons: [] });
    const withBanner = { ...approved, schema: { ...approved.schema, bannerImageUrl: image, bannerCrop: crop } };
    expect(detectMaterialChange(withBanner, { ...withBanner, schema: { ...withBanner.schema, bannerCrop: { ...crop, zoom: 1.2 } } })).toEqual({ changed: false, reasons: [] });
  });
});
