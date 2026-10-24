const stockButton = '<button className="vn-choice vn-custom-choice" aria-label="Write your own choice" disabled={api.readOnly || generatingChoices || !personaControl.ready || personaControl.saving} onClick={() => setPanel("composer")}><span className="vn-choice-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: choiceIcon }} /><span>...</span></button>';
const stockButtons = [stockButton, stockButton.replace(" || !personaControl.ready || personaControl.saving", "")]
  .flatMap(button => ["...", "Write your own"].map(label => [
    button.replace("...", label), button.replace('<span>...</span>', '<ChoiceText text="Write your own" />'),
  ] as const));

/** Refresh only known shipped buttons, retaining their handlers and disabled gates. */
export function upgradeVnCustomChoiceLabelFiles(files: Record<string, string>): Record<string, string> {
  let updated = files;
  for (const [name, source] of Object.entries(files)) {
    if (!name.endsWith(".tsx") || !source.includes('className="vn"') || !source.includes('className="vn-stage"')
      || !source.includes('import { ChoiceText, plainChoiceText } from "./choice-text";')) continue;
    const matches = stockButtons.filter(([before]) => source.split(before).length === 2);
    if (matches.length !== 1) continue;
    if (updated === files) updated = { ...files };
    updated[name] = source.replace(matches[0][0], matches[0][1]);
  }
  return updated;
}
