export interface StudioImageCapabilities {
  imageGeneration?: boolean;
  imageBatchGeneration?: boolean;
  localImageGeneration?: boolean;
}

/** Remove unavailable guidance from both the core prompt and loaded skills. */
export function renderStudioCapabilityContent(content: string, capabilities: StudioImageCapabilities = {}): string {
  const rendered = content
    .replace(/<image-generation>([\s\S]*?)<\/image-generation>/g, (_, guidance: string) => capabilities.imageGeneration ? guidance : '')
    .replace(/<image-batch-generation>([\s\S]*?)<\/image-batch-generation>/g, (_, guidance: string) => capabilities.imageBatchGeneration ? guidance : '');
  return capabilities.localImageGeneration === false
    ? `${rendered}\nAnima and Krea image generation is paused by the administrator. Do not start local image jobs or offer local NSFW generation. The creator can re-enable them in Administration → Image generation. Other configured image providers remain available for supported requests.`
    : rendered;
}
