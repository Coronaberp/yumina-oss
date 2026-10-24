export const COMMUNITY_LINKS = {
  discord: "https://discord.gg/gPhncrugz3",
  reddit: "https://www.reddit.com/r/yuminaAI/",
  github: "https://github.com/lovetimo0421/yumina-oss",
} as const;

/** Source destination for this installation's Settings row; upstream credit stays separate. */
export const SETTINGS_SOURCE_URL = "https://github.com/Coronaberp/yumina-oss";

export type CommunityChannel = keyof typeof COMMUNITY_LINKS;
