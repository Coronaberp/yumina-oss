/** Platform receipt, never a gameplay command. Standalone lines only. */
import { maskPresentationLiterals } from "./presentation-literals.js";
export const STATE_RECEIPT_PREFIX = "<yumina-state";
const WRAPPED_RECEIPT_PREFIX = "<yield>yumina-state";
const CHOICE_HANDOFFS = ["<yield></yield>", "<yield>choices follow</yield>", "<yield>choices follow.</yield>"];
const receiptCandidate = (text: string) => text.trimStart().toLowerCase()
  .replace(/^<yield>\s*/, "<yield>")
  .replace(/^(<yield>choices)\s+/, "$1 ")
  .replace(/^(<yield>choices follow\.?)\s+/, "$1");

export function stripStateReceipts(text: string): string {
  const literals = maskPresentationLiterals(text);
  // Some models replace the receipt's angle brackets with a yield wrapper.
  // Hide that malformed metadata for display only; the guard still rejects it.
  const unwrapped = literals.text
    .replace(/^[\t ]*<yield>\s*(?:choices\s+follow\.?)?\s*<\/yield>[\t ]*(?:\r?\n|$)/gim, "")
    .replace(/^[\t ]*<yield>\s*yumina-state(?=[\s/>])[^<>]*<\/yield>[\t ]*(?:\r?\n|$)/gim, "");
  return literals.restore(unwrapped.split("\n").filter(line => !/^[\t ]*<yumina-state(?:\s|\/|>|$)/i.test(line)).join("\n").trimEnd());
}

/** Hold only a possible protocol prefix (not an entire line/response). */
export class StateReceiptFilter {
  private pending = "";
  private lineStart = true;
  private hiding: false | "line" | "yield" = false;
  private closeBuffer = "";
  private fence = false;

  push(chunk: string): string {
    let out = "";
    for (const char of chunk) {
      if (this.hiding) {
        if (this.hiding === "yield") {
          this.closeBuffer = (this.closeBuffer + char).slice(-8);
          if (this.closeBuffer.toLowerCase() === "</yield>") {
            this.hiding = false; this.closeBuffer = ""; this.lineStart = true;
          }
        } else if (char === "\n") { this.hiding = false; this.lineStart = true; }
        continue;
      }
      if (this.lineStart) {
        this.pending += char;
        const candidate = receiptCandidate(this.pending);
        if (candidate === "" && char !== "\n") continue;
        if (candidate === "```" || candidate === "~~~") {
          this.fence = !this.fence;
          out += this.pending; this.pending = ""; this.lineStart = false;
          continue;
        }
        if (!this.fence && CHOICE_HANDOFFS.includes(candidate)) {
          this.pending = ""; this.lineStart = true;
          continue;
        }
        if (!this.fence && candidate !== "" && CHOICE_HANDOFFS.some(marker => marker.startsWith(candidate))) continue;
        if (!this.fence && candidate.startsWith(STATE_RECEIPT_PREFIX) && candidate.length > STATE_RECEIPT_PREFIX.length && /[\s/>]/.test(candidate[STATE_RECEIPT_PREFIX.length]!)) {
          this.pending = "";
          this.hiding = char !== "\n" ? "line" : false;
          continue;
        }
        if (!this.fence && candidate.startsWith(WRAPPED_RECEIPT_PREFIX) && candidate.length > WRAPPED_RECEIPT_PREFIX.length && /[\s/>]/.test(candidate[WRAPPED_RECEIPT_PREFIX.length]!)) {
          this.pending = ""; this.hiding = "yield"; this.closeBuffer = "";
          continue;
        }
        if (!this.fence && candidate !== "" && WRAPPED_RECEIPT_PREFIX.startsWith(candidate)) continue;
        if (((!this.fence && STATE_RECEIPT_PREFIX.startsWith(candidate)) || "```".startsWith(candidate) || "~~~".startsWith(candidate)) && char !== "\n") continue;
        out += this.pending;
        this.pending = "";
        this.lineStart = char === "\n";
      } else {
        out += char;
        if (char === "\n") this.lineStart = true;
      }
    }
    return out;
  }

  flush(): string {
    const text = this.pending;
    this.pending = "";
    const candidate = receiptCandidate(text);
    return !this.fence && candidate !== "" && (STATE_RECEIPT_PREFIX.startsWith(candidate) || WRAPPED_RECEIPT_PREFIX.startsWith(candidate) || CHOICE_HANDOFFS.some(marker => marker.startsWith(candidate))) ? "" : text;
  }
}
