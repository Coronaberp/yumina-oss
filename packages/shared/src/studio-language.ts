/** Studio replies have their own preference, independent of UI/story language. */
export const STUDIO_OUTPUT_LANGUAGES = [
  { code: 'en', label: 'English', promptName: 'English' },
  { code: 'zh', label: '简体中文', promptName: 'Simplified Chinese' },
  { code: 'zh-Hant', label: '繁體中文', promptName: 'Traditional Chinese' },
  { code: 'ja', label: '日本語', promptName: 'Japanese' },
  { code: 'ko', label: '한국어', promptName: 'Korean' },
  { code: 'es', label: 'Español', promptName: 'Spanish' },
  { code: 'fr', label: 'Français', promptName: 'French' },
  { code: 'de', label: 'Deutsch', promptName: 'German' },
  { code: 'pt', label: 'Português', promptName: 'Portuguese' },
  { code: 'ru', label: 'Русский', promptName: 'Russian' },
  { code: 'ar', label: 'العربية', promptName: 'Arabic' },
] as const;

export type StudioOutputLanguage = typeof STUDIO_OUTPUT_LANGUAGES[number]['code'];

export function isStudioOutputLanguage(value: unknown): value is StudioOutputLanguage {
  return STUDIO_OUTPUT_LANGUAGES.some(option => option.code === value);
}

export function normalizeStudioOutputLanguage(value: unknown): StudioOutputLanguage {
  return isStudioOutputLanguage(value) ? value : 'en';
}
