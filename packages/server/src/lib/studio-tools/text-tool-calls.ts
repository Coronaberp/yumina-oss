import type { ToolCall, ToolDefinition } from '../llm/types.js';

const MAX_TEXT_CALLS = 64;
const OPEN_TAG = '<tool_call>';
const CLOSE_TAG = '</tool_call>';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function onlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  return Object.keys(record).every(key => keys.includes(key));
}

/** Delay a possible text tool envelope until it can be distinguished from prose. */
export function couldStartTextToolCall(text: string): boolean {
  const trimmed = text.trimStart();
  if (!trimmed || trimmed.startsWith('{') || /^\[\s*(?:\{|$)/.test(trimmed)) return true;
  if (OPEN_TAG.startsWith(trimmed) || trimmed.startsWith(OPEN_TAG)) return true;
  if ('```'.startsWith(trimmed)) return true;
  if (trimmed.startsWith('```')) {
    const language = trimmed.slice(3).split(/\r?\n/, 1)[0]!.trim().toLowerCase();
    return language === '' || 'json'.startsWith(language);
  }
  return false;
}

/** Recognize a failed request for retry/error reporting, never for execution. */
export function looksLikeTextToolRequest(text: string, tools: readonly ToolDefinition[]): boolean {
  // Models sometimes put a numbered execution plan before their printed requests.
  // Leave prose explanations and documentation containers outside this detector.
  const input = text.trim()
    .replace(/^```(?:json)?[ \t]*\r?\n/i, '')
    .replace(/^(?:\d+[.)][ \t]+[^\r\n]*\r?\n\s*)+/, '')
    .replace(/^<tool_call>\s*/, '');
  const envelope = /^(?:\[\s*)?\{\s*(?:"(?:id|type)"\s*:\s*"(?:\\.|[^"\\])*"\s*,\s*)*"(?:tool|name|function|tool_calls)"\s*:/;
  if (!envelope.test(input) || !/"arguments"\s*:/.test(input)) return false;
  const available = new Set(tools.map(tool => tool.function.name));
  return [...input.matchAll(/"(?:tool|name)"\s*:\s*"([^"\r\n]+)"/g)]
    .some(match => available.has(match[1]!));
}

/** Find JSON boundaries without interpreting braces or brackets inside strings. */
function jsonBlock(text: string): string | null {
  const stack: string[] = [];
  let inString = false, escaped = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index]!;
    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
    } else if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      if (stack.pop() !== (char === '}' ? '{' : '[')) return null;
      if (!stack.length) return text.slice(0, index + 1);
    }
  }
  return null;
}

/** Accept request sequences and explicit wrappers, while leaving examples in prose alone. */
function requestBlocks(text: string): string[] | null {
  const blocks: string[] = [];
  let rest = text;
  while (rest) {
    if (blocks.length >= MAX_TEXT_CALLS) return null;
    if (rest.startsWith('```')) {
      const fence = /^```(?:json)?[ \t]*\r?\n/i.exec(rest);
      if (!fence) return null;
      const content = rest.slice(fence[0].length);
      const end = /\r?\n```[ \t]*(?=\r?\n|$)/.exec(content);
      if (!end) return null;
      const inner = requestBlocks(content.slice(0, end.index).trim());
      if (!inner) return null;
      blocks.push(...inner);
      if (blocks.length > MAX_TEXT_CALLS) return null;
      rest = content.slice(end.index + end[0].length).trim();
      continue;
    }
    const tagged = rest.startsWith(OPEN_TAG);
    if (tagged) rest = rest.slice(OPEN_TAG.length).trimStart();
    if (!rest.startsWith('{') && !rest.startsWith('[')) return null;
    const block = jsonBlock(rest);
    if (!block) return null;
    blocks.push(block);
    rest = rest.slice(block.length).trim();
    if (tagged) {
      if (!rest.startsWith(CLOSE_TAG)) return null;
      rest = rest.slice(CLOSE_TAG.length).trim();
    }
  }
  return blocks;
}

/**
 * Compatibility for models that print tool requests instead of native calls.
 * Accept strict JSON requests, sequences and explicit fenced/tagged batches,
 * optionally preceded by a numbered execution plan. Skip invalid requests
 * individually; never repair their JSON or execute examples embedded in prose.
 * The caller still owns completion checks and normal tool validation/execution.
 */
export function recoverTextToolCalls(text: string, tools: readonly ToolDefinition[], idPrefix: string, onRejected?: (reason: string) => void): ToolCall[] {
  const input = text.trim().replace(/^(?:\d+[.)][ \t]+[^\r\n]*\r?\n\s*)+/, '');
  if (!input || !tools.length) return [];
  const blocks = requestBlocks(input);
  if (!blocks) return [];
  const values: unknown[] = [];
  for (const block of blocks) {
    try {
      const parsed: unknown = JSON.parse(block);
      if (isRecord(parsed) && 'tool_calls' in parsed) {
        if (!onlyKeys(parsed, ['tool_calls']) || !Array.isArray(parsed.tool_calls)) {
          onRejected?.('invalid tool_calls envelope');
          continue;
        }
        values.push(...parsed.tool_calls);
      } else values.push(...(Array.isArray(parsed) ? parsed : [parsed]));
    } catch {
      if (looksLikeTextToolRequest(block, tools)) onRejected?.('invalid JSON in a printed tool request');
    }
  }
  if (!values.length || values.length > MAX_TEXT_CALLS) return [];

  const available = new Set(tools.map(tool => tool.function.name));
  const seen = new Set<string>();
  const calls: ToolCall[] = [];
  for (const value of values) {
    if (!isRecord(value) || (value.type !== undefined && value.type !== 'function')) {
      onRejected?.('invalid request envelope');
      continue;
    }
    let name: unknown, args: unknown;
    if ('function' in value) {
      if (!onlyKeys(value, ['id', 'type', 'function']) || !isRecord(value.function) || !onlyKeys(value.function, ['name', 'arguments'])) {
        onRejected?.('invalid function envelope');
        continue;
      }
      name = value.function.name; args = value.function.arguments;
    } else {
      const key = 'tool' in value ? 'tool' : 'name';
      if (!onlyKeys(value, ['id', 'type', key, 'arguments'])) {
        onRejected?.('invalid request envelope');
        continue;
      }
      name = value[key]; args = value.arguments;
    }
    if (typeof name !== 'string' || !available.has(name)) {
      onRejected?.('unknown or unavailable tool');
      continue;
    }
    if (typeof args === 'string') {
      try { args = JSON.parse(args); } catch { onRejected?.(`${name}: invalid argument JSON`); continue; }
    }
    if (!isRecord(args)) {
      onRejected?.(`${name}: arguments must be an object`);
      continue;
    }
    const serialized = JSON.stringify(args);
    const identity = `${name}:${JSON.stringify(args, (_key, value) => isRecord(value)
      ? Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)) : value)}`;
    if (seen.has(identity)) continue;
    seen.add(identity);
    // Ignore model-supplied IDs: stable run/iteration IDs make checkpoint replays idempotent.
    calls.push({ id: `${idPrefix}_${calls.length}`, type: 'function', function: { name, arguments: serialized } });
  }
  return calls;
}
