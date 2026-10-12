import { characterIdentifiers, displayCharacterName } from "@yumina/engine";

/** Replace UI-only identity in model messages, including old history and macros. */
export function anonymizePlayerPrompt<T extends { content: unknown }>(messages: T[], aliases: readonly (string | null | undefined)[], characterNames: readonly string[] = []): T[] {
  // An authored NPC can share a player's chosen name. Player identity macros
  // already use a prompt-only {{user}} value; keep the independent NPC intact.
  const cast = new Set([...characterNames, ...characterIdentifiers(characterNames.map(displayCharacterName)).map(({ identifier }) => identifier)].map(name => name.trim().toLocaleLowerCase()));
  const names = [...new Set(aliases.map(name => name?.trim()).filter((name): name is string => !!name && name !== "{{user}}" && !cast.has(name.toLocaleLowerCase())))].sort((a, b) => b.length - a.length);
  const spellings = [...new Set(names.flatMap(name => {
    const values = [name];
    // Persona data, tool arguments and correction history can be quoted JSON.
    for (let depth = 0; depth < 3; depth++) values.push(JSON.stringify(values.at(-1)!).slice(1, -1));
    return values;
  }))].sort((a, b) => b.length - a.length);
  const patterns = spellings.map(name => new RegExp(`(?<![\\p{L}\\p{N}_{])${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![\\p{L}\\p{N}_}])`, "giu"));
  const replace = (text: string) => patterns.reduce((value, pattern) => value.replace(pattern, "{{user}}"), text);
  return messages.map(message => {
    const toolMessage = message as T & { tool_calls?: Array<{ function?: { arguments?: unknown } }> };
    return { ...message, content: typeof message.content === "string" ? replace(message.content) : Array.isArray(message.content) ? message.content.map(part => part?.type === "text" && typeof part.text === "string" ? { ...part, text: replace(part.text) } : part) : message.content,
      ...(toolMessage.tool_calls ? { tool_calls: toolMessage.tool_calls.map(call => typeof call.function?.arguments === "string" ? { ...call, function: { ...call.function, arguments: replace(call.function.arguments) } } : call) } : {}),
    };
  });
}
