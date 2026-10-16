import { mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { z } from 'zod';
import { env, IS_LOCAL_EDITION } from '../env.js';

export const imageGenerationControlsInput = z.object({ enabled: z.boolean() }).strict();

/** Installation control is separate from saved user workflows and credentials. */
export function createImageGenerationControls(file = resolve(env.YUMINA_DATA_DIR, 'image-generation.json')) {
  return {
    read() {
      let content: string;
      try { content = readFileSync(file, 'utf8'); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { enabled: true };
        throw error;
      }
      return imageGenerationControlsInput.parse(JSON.parse(content));
    },
    save(input: unknown) {
      const controls = imageGenerationControlsInput.parse(input);
      mkdirSync(dirname(file), { recursive: true });
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        writeFileSync(temporary, JSON.stringify(controls) + '\n', { mode: 0o600 });
        renameSync(temporary, file);
      } finally { rmSync(temporary, { force: true }); }
      return controls;
    },
  };
}

export const imageGenerationControls = createImageGenerationControls();
export const localImageGenerationEnabled = () => !IS_LOCAL_EDITION || imageGenerationControls.read().enabled;
