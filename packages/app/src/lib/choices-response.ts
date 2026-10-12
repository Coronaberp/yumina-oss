export type GenerateChoicesResult = {
  choices: string[];
  creditCost?: number;
};

type UnknownRecord = Record<string, unknown>;

const WEB_PAGE_RESPONSE =
  "Choices API returned a web page instead of JSON. Update/restart the Yumina backend or check the API proxy.";

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse and validate the generate-choices API response without exposing an HTML fallback page. */
export async function parseGenerateChoicesResponse(
  response: Pick<Response, "ok" | "status" | "text">,
  expectedMessageId: string,
  expectedActiveSwipeIndex: number,
): Promise<GenerateChoicesResult> {
  const body = await response.text();
  let result: unknown;
  try {
    result = JSON.parse(body);
  } catch {
    // Never surface the response body: a proxy or SPA fallback can contain a
    // full HTML page, internal details, or other content irrelevant to players.
    throw new Error(WEB_PAGE_RESPONSE);
  }

  if (!response.ok) {
    if (isRecord(result) && typeof result.error === "string" && result.error.trim()) {
      // Preserve server/provider failures verbatim for the VN's existing alert.
      throw new Error(result.error);
    }
    throw new Error(`Could not generate choices (HTTP ${response.status}).`);
  }

  if (!isRecord(result) || !isRecord(result.data)) {
    throw new Error("Invalid choices response.");
  }
  const data = result.data;
  if (data.messageId !== expectedMessageId || data.activeSwipeIndex !== expectedActiveSwipeIndex) {
    throw new Error("Invalid choices response.");
  }
  if (
    !Array.isArray(data.choices) ||
    data.choices.length < 2 ||
    data.choices.length > 4 ||
    !data.choices.every(choice => typeof choice === "string" && choice.trim())
  ) {
    throw new Error("Invalid choices response.");
  }
  const normalized = data.choices.map(choice => (choice as string).trim());
  if (new Set(normalized.map(choice => choice.toLocaleLowerCase())).size !== normalized.length) {
    throw new Error("Invalid choices response.");
  }
  if (data.creditCost !== undefined && (typeof data.creditCost !== "number" || !Number.isFinite(data.creditCost) || data.creditCost < 0)) {
    throw new Error("Invalid choices response.");
  }

  return {
    choices: data.choices as string[],
    ...(data.creditCost !== undefined ? { creditCost: data.creditCost as number } : {}),
  };
}
