export interface StudioImageCapabilities {
  imageGeneration?: boolean;
  imageBatchGeneration?: boolean;
}

/** Remove unavailable guidance from both the core prompt and loaded skills. */
export function renderStudioCapabilityContent(content: string, capabilities: StudioImageCapabilities = {}): string {
  return content
    .replace(/<image-generation>([\s\S]*?)<\/image-generation>/g, (_, guidance: string) => capabilities.imageGeneration ? guidance : '')
    .replace(/<image-batch-generation>([\s\S]*?)<\/image-batch-generation>/g, (_, guidance: string) => capabilities.imageBatchGeneration ? guidance : '');
}
