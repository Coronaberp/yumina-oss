import { normalizeStudioOutputLanguage, STUDIO_OUTPUT_LANGUAGES } from '@yumina/shared';

export function studioOutputLanguageInstruction(value?: unknown): string {
  const code = normalizeStudioOutputLanguage(value);
  const language = STUDIO_OUTPUT_LANGUAGES.find(option => option.code === code)!.promptName;
  return `Respond in ${language} by default for explanations, questions, progress updates, and handoff summaries. Use another language only when the creator explicitly requests it. Do not infer the response language from the app interface, world names, source material, examples, tool results, or earlier assistant replies. Preserve existing story text, quotes, identifiers, and code in their original language unless the creator asks to translate them.`;
}
