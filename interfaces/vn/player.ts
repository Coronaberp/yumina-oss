/** Display the selected persona locally. Saved replies and model history keep the token. */
export function playerText(text: string, personaName = "Player"): string {
  const verbs: Record<string, string> = { is: "are", was: "were", has: "have", does: "do", goes: "go", stops: "stop", raises: "raise", looks: "look", steps: "step", turns: "turn", walks: "walk", speaks: "speak", says: "say", asks: "ask", takes: "take", makes: "make", feels: "feel", sees: "see", hears: "hear", knows: "know", wants: "want", needs: "need", thinks: "think", tries: "try", carries: "carry", watches: "watch", reaches: "reach", touches: "touch", pushes: "push", pulls: "pull", opens: "open", closes: "close", smiles: "smile", nods: "nod", leans: "lean", glances: "glance", moves: "move", holds: "hold", follows: "follow", begins: "begin", continues: "continue", enters: "enter", leaves: "leave", offers: "offer", demonstrates: "demonstrate", casts: "cast", draws: "draw", lifts: "lift", sits: "sit", stands: "stand", waits: "wait", whispers: "whisper", replies: "reply", notices: "notice", remembers: "remember", swallows: "swallow", tilts: "tilt", trembles: "tremble", rushes: "rush", catches: "catch", studies: "study" };
  const namedVerbs = Object.fromEntries(Object.entries(verbs).map(([named, second]) => [second, named]));
  // Repair the earlier second-person token grammar in saved replies only.
  text = text.replace(/(\{\{user\}\})\s+([a-z]+)\b/gi, (match, subject, verb) => namedVerbs[verb.toLowerCase()] ? `${subject} ${namedVerbs[verb.toLowerCase()]}` : match);
  const name = personaName?.trim() || "Player";
  return text.replace(/\{\{user\}\}(['’]s)?/gi, (_match, possessive) => name + (possessive || ""));
}
