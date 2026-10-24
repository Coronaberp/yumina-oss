const previousCopy = `export function CharacterCopy({ api, text, className, context, onCharacter }) {
  const node = React.useRef(null);
  const current = React.useRef({ onCharacter, context }); current.current = { onCharacter, context };
  const html = api.renderMarkdown(playerText(text, api.user?.name));
  React.useLayoutEffect(() => {
    const root = node.current;
    root.innerHTML = html;
    if (!onCharacter) return;
    const candidates = identities(api).sort((a, b) => b.identifier.length - a.identifier.length);
    if (!candidates.length) return;
    const expression = new RegExp(candidates.map(item => escaped(item.identifier)).join("|"), "giu");
    const walker = document.createTreeWalker(root, 4), nodes = [];
    while (walker.nextNode()) if (!walker.currentNode.parentElement.closest('a,button,code,pre,script,style,textarea,[hidden],[aria-hidden="true"]')) nodes.push(walker.currentNode);
    for (const textNode of nodes) {
      const source = textNode.textContent, fragment = document.createDocumentFragment();
      let offset = 0;
      for (const match of source.matchAll(expression)) {
        if (word(Array.from(source.slice(0, match.index)).at(-1)) || word(Array.from(source.slice(match.index + match[0].length))[0])) continue;
        const identity = candidates.find(item => item.identifier.toLowerCase() === match[0].toLowerCase());
        fragment.append(document.createTextNode(source.slice(offset, match.index)));
        const button = document.createElement("button");
        button.type = "button"; button.className = "vn-character-link"; button.textContent = match[0];
        button.setAttribute("aria-haspopup", "dialog"); button.title = \`View \${match[0]}\`;
        button.addEventListener("click", event => {
          event.stopPropagation();
          current.current.onCharacter?.({ id: identity.entry.id, name: identity.name, label: match[0], portrait: identity.entry.portrait, source: button }, current.current.context);
        });
        fragment.append(button); offset = match.index + match[0].length;
      }
      if (offset) { fragment.append(document.createTextNode(source.slice(offset))); textNode.replaceWith(fragment); }
    }
  }, [html, api.entries, !!onCharacter]);
  return <div ref={node} className={className} />;
}`;

/** Replace only the byte-exact shipped mention handler on saved VN cards.
 * Keep creator styles, stats, speaker matching and unrelated modules intact. */
export function upgradeVnCharacterMentionFiles(files: Record<string, string>, viewerSource: string): Record<string, string> {
  const start = viewerSource.indexOf("export function CharacterCopy(");
  const end = viewerSource.indexOf("\n\nfunction visibleText(", start);
  if (start < 0 || end < start) return files;
  const currentCopy = viewerSource.slice(start, end);
  if (currentCopy === previousCopy) return files;
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (name !== "character-viewer.tsx" && !name.endsWith("/character-viewer.tsx")) continue;
    const position = source.indexOf(previousCopy);
    if (position < 0 || position !== source.lastIndexOf(previousCopy)) continue;
    if (updated === files) updated = { ...files };
    updated[name] = source.replace(previousCopy, currentCopy);
  }
  return updated;
}
