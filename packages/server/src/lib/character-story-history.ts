import { canonicalCharacterName, characterIdentifiers, displayCharacterName, ResponseParser, stripGameStateDump, ThinkingTagFilter } from '@yumina/engine';

type Character = { id: string; name: string; role?: string; enabled?: boolean };
const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Bounded, chronological evidence from the selected saved story. Keeps the
 * first encounter as well as recent events, instead of losing a character's
 * early scenes to a tail of unrelated replies. Never reads profile prose. */
export class CharacterStoryHistory {
  readonly names: string[];
  readonly canonical: string;
  readonly aliases: string[];
  readonly match: RegExp;
  readonly parser = new ResponseParser();
  readonly blocks: string[] = [];
  partial = false;
  matchedMessages = 0;
  private length = 0;

  constructor(entries: Character[], characterId: string, readonly label: string, readonly budget = 28_000) {
    const characters = entries.filter(entry => entry.role === 'character' && entry.enabled !== false);
    const character = characters.find(entry => entry.id === characterId);
    if (!character) throw new Error('Character not found');
    this.names = characters.map(entry => displayCharacterName(entry.name));
    this.canonical = displayCharacterName(character.name);
    this.aliases = characterIdentifiers(this.names).filter(identity => identity.name === this.canonical).map(identity => identity.identifier);
    if (!this.aliases.some(alias => alias.toLowerCase() === label.toLowerCase())) throw new Error('Character mention does not match this character');
    this.match = new RegExp(`(?:^|[^\\p{L}\\p{N}_])(?:${this.aliases.map(escape).join('|')})(?=$|[^\\p{L}\\p{N}_])`, 'iu');
  }

  private clean(source: string): string {
    const prose = stripGameStateDump(this.parser.parse(ThinkingTagFilter.strip(source)).cleanText)
      .replace(/```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$)/g, '')
      .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
    return prose.trim();
  }

  add(source: string, playerInput = ''): void {
    let prose = this.clean(source);
    if (!this.match.test(prose)) return;
    this.matchedMessages++;
    prose = prose.replace(/\[\s*(?:SPEAKER|NAME)\s*:\s*([^:\]\n]+)(?::[^\]\n]*)?\]/gi, (_marker, rawName: string) => {
      const name = displayCharacterName(rawName);
      if (/^(narrator|narration|system)$/i.test(name)) return '\nNarration:\n';
      const canonical = canonicalCharacterName(this.names, name);
      const visibleName = canonical === this.canonical ? this.label : name.replace(/\s*\([^()]*\)\s*$/, '').trim();
      return `\n${visibleName || 'Another character'} says:\n`;
    });
    if (prose.length > 7_000) { prose = `${prose.slice(0, 3_500)}\n[Middle of this passage omitted]\n${prose.slice(-3_500)}`; this.partial = true; }
    const intent = playerInput ? `Player input (intent; the reply below establishes what happened): ${this.clean(playerInput).slice(0, 1_000)}\n` : '';
    const block = `${intent}Story reply:\n${prose}`;
    this.blocks.push(block); this.length += block.length + 2;
    // Preserve the first encounter and a bounded tail of relevant events.
    while (this.length > this.budget && this.blocks.length > 1) {
      const index = this.blocks.length > 2 ? 1 : 0;
      this.length -= this.blocks.splice(index, 1)[0]!.length + 2; this.partial = true;
    }
  }

  text(): string { return this.blocks.join('\n\n'); }
}
