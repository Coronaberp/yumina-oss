import { stripZeroWidthSpaces } from "@yumina/engine";
import type { ChatMessage, GenerateParams, LLMProvider } from "./types.js";

/** Clean the shared provider boundary so streamed and persisted text agree. */
export function cleanProviderText(provider: LLMProvider): LLMProvider {
  const generateStream: LLMProvider["generateStream"] = async function* (params: GenerateParams) {
    const messages = params.messages.map((message): ChatMessage => {
      if (message.role === "tool") return { ...message, content: stripZeroWidthSpaces(message.content) };
      return {
        ...message,
        content: typeof message.content === "string" ? stripZeroWidthSpaces(message.content) : message.content.map(part => part.type === "text" ? { ...part, text: stripZeroWidthSpaces(part.text) } : part),
        ...(message.role === "assistant" && typeof message.reasoning_content === "string" ? { reasoning_content: stripZeroWidthSpaces(message.reasoning_content) } : {}),
        ...(message.role === "assistant" && message.tool_calls ? { tool_calls: message.tool_calls.map(call => ({ ...call, function: { ...call.function, arguments: stripZeroWidthSpaces(call.function.arguments) } })) } : {}),
      };
    });
    for await (const chunk of provider.generateStream({ ...params, messages })) {
      yield {
        ...chunk,
        content: stripZeroWidthSpaces(chunk.content),
        ...(chunk.toolCall ? { toolCall: { ...chunk.toolCall, function: { ...chunk.toolCall.function, arguments: stripZeroWidthSpaces(chunk.toolCall.function.arguments) } } } : {}),
      };
    }
  };
  // Keep provider identity and bind its optional methods to the real instance.
  return new Proxy(provider, {
    get(target, key) {
      if (key === "generateStream") return generateStream;
      const value = Reflect.get(target, key, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
