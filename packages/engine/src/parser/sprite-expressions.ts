/** Built-in expressions remain the compatibility fallback for older cards. */
export const spriteExpressions = ["normal", "happy", "sad", "angry", "shy", "smug"] as const;
export type SpriteExpression = typeof spriteExpressions[number];

const aliases: Record<SpriteExpression, string[]> = {
  normal: ["neutral", "idle", "default", "calm", "composed", "serious", "focused", "attentive", "thoughtful", "thinking", "curious", "confused", "puzzled", "unsure", "uncertain", "surprised", "surprise", "shocked", "shock", "startled", "stunned", "bewildered", "alert", "determined", "bored", "sleepy", "tired", "relaxed", "indifferent", "stoic"],
  happy: ["joy", "joyful", "cheerful", "excited", "delighted", "pleased", "glad", "smile", "smiling", "amused", "laugh", "laughing", "giggling", "playful", "relieved", "grateful", "friendly", "warm", "affectionate", "content", "optimistic", "satisfied", "upbeat"],
  sad: ["unhappy", "sorrow", "sorrowful", "melancholy", "depressed", "dejected", "disappointed", "hurt", "heartbroken", "crying", "tearful", "worried", "concerned", "anxious", "nervous", "afraid", "scared", "fearful", "distressed", "upset", "lonely", "remorseful", "apologetic", "guilty", "pained", "despairing"],
  angry: ["irritated", "irritation", "annoyed", "annoyance", "furious", "fury", "enraged", "mad", "frustrated", "indignant", "offended", "hostile", "outraged", "stern", "scolding", "resentful", "bitter", "displeased", "exasperated"],
  shy: ["embarrassed", "embarrassment", "bashful", "blush", "blushing", "flustered", "timid", "coy", "awkward", "sheepish", "modest"],
  smug: ["haughty", "arrogant", "proud", "condescending", "superior", "conceited", "cocky", "confident", "smirk", "smirking", "sarcastic", "mocking", "teasing", "mischievous", "sly", "disdainful", "contemptuous", "sneering", "self satisfied", "self assured", "triumphant"],
};
const expressionMap = Object.fromEntries(spriteExpressions.flatMap(expression =>
  [expression, ...aliases[expression]].map(alias => [alias, expression])));

/** Stable marker/catalog ID; defer aliases until the card catalog is available. */
export function normalizeSpriteSelectionId(value: unknown): string | undefined {
  if (typeof value !== "string" || ["__proto__", "constructor", "prototype"].includes(value.trim().toLowerCase())) return;
  const key = typeof value === "string" ? value.trim().normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "") : "";
  return key && !/[:|\]\r\n]/.test(key) && !["constructor", "prototype"].includes(key) ? key : undefined;
}

export function normalizeSpriteId(value: unknown): string {
  return normalizeSpriteSelectionId(value) || "normal";
}

/** Resolve exact configured IDs before legacy aliases; never match substrings. */
export function normalizeSpriteExpression(value: unknown, configured?: Record<string, unknown>): string {
  const id = normalizeSpriteId(value);
  if (configured && typeof configured === "object" && !Array.isArray(configured)) {
    if (Object.prototype.hasOwnProperty.call(configured, id)) return id;
    const exact = Object.keys(configured).find(key => normalizeSpriteId(key) === id);
    if (exact) return exact;
  }
  const key = typeof value === "string" ? value.trim().toLowerCase().replace(/[\s_-]+/g, " ") : "";
  return Object.prototype.hasOwnProperty.call(expressionMap, key) ? expressionMap[key]! : "normal";
}
