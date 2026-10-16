/** GLM-5.3 and Flash require thinking; omitted effort defaults to maximum. */
export function backgroundReasoningEffort(model: string): "low" | "none" {
  return /(?:^|\/)glm-5\.3(?:$|[-:])/i.test(model) ? "low" : "none";
}
