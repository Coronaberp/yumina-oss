import { describe, expect, it } from "vitest";
import { StateReceiptFilter, stripStateReceipts } from "../parser/state-receipt.js";

const marker = '<yumina-state version="1" status="none" />';
const wrapped = '<yield>yumina-state version="1" status="updated" count="4"</yield>';
function streamed(chunks: string[]) {
  const filter = new StateReceiptFilter();
  return chunks.map((chunk) => filter.push(chunk)).join("") + filter.flush();
}

describe("StateReceiptFilter", () => {
  it.each([wrapped, wrapped.replaceAll('yield', 'Yield'), '<yield>\nyumina-state version="1"\nstatus="updated" count="4"\n</yield>'])("hides malformed wrapped receipts at every streaming boundary: %s", receipt => {
    const raw = `Story.\n${receipt}\nNext line.`;
    for (let split = 0; split <= raw.length; split++) {
      expect(streamed([raw.slice(0, split), raw.slice(split)]), `split ${split}`).toBe('Story.\n\nNext line.');
    }
    expect(streamed([...raw])).toBe('Story.\n\nNext line.');
  });
  it.each(['<yield>Ordinary story</yield>', `<yield>yumina-stateful garden</yield>`, `He says ${wrapped}`, `\`\`\`text\n${wrapped}\n\`\`\``])('keeps non-receipt yields and literal examples: %s', raw => {
    expect(streamed([...raw])).toBe(raw);
  });
  it("holds the wrapped metadata before any attribute quotes can become speech", () => {
    const filter = new StateReceiptFilter();
    expect(filter.push('Story.\n')).toBe('Story.\n');
    for (const char of wrapped) expect(filter.push(char)).toBe('');
    expect(filter.flush()).toBe('');
  });
  it.each(['First\n\nSecond', 'First\n  \nSecond', 'First\n\n<yield>Ordinary story</yield>'])('preserves blank lines: %s', raw => {
    expect(streamed([...raw])).toBe(raw);
  });
  for (const raw of [`Story.\n${marker}`, `Story.\n  \t${marker}\n`, `${marker}\nAnother line.`, `First\r\n${marker}\r\nLast`, `First\n${marker}\n${marker}\nLast`]) {
    it(`hides the receipt at every two-chunk boundary: ${JSON.stringify(raw)}`, () => {
      const expected = streamed([raw]);
      expect(expected).not.toContain("yumina-state");
      for (let split = 0; split <= raw.length; split++) {
        expect(streamed([raw.slice(0, split), raw.slice(split)]), `split ${split}`).toBe(expected);
      }
      expect(streamed([...raw])).toBe(expected);
    });
  }
  it("does not leak protocol prefixes while a receipt is arriving", () => {
    const filter = new StateReceiptFilter();
    expect(filter.push("Story.\n")).toBe("Story.\n");
    for (const char of marker) expect(filter.push(char)).toBe("");
    expect(filter.flush()).toBe("");
  });
  it.each(["Plain story.", "First\nSecond", "  Indented story", "<maintext>Story</maintext>", `He says ${marker} in prose.`, `> ${marker}`, `\\${marker}`, `"${marker}"`])
    ("preserves nonprotocol narrative %s", (raw) => expect(streamed([...raw])).toBe(raw));
  it("flushes ordinary pending whitespace", () => expect(streamed(["Story.\n  "])).toBe("Story.\n  "));
  it("hides a receipt truncated at its protocol prefix", () => expect(streamed(["Story.\n<yumina-st"])).toBe("Story.\n"));
  it("does not erase another tag that only shares the prefix", () => {
    const raw = '<yumina-stateful>Story component</yumina-stateful>';
    expect(streamed([...raw])).toBe(raw);
  });
  it("keeps a receipt in a fenced narrative example visible", () => {
    const raw = `Example:\n\`\`\`text\n${marker}\n\`\`\``;
    expect(streamed([...raw])).toBe(raw);
  });
});

describe("stripStateReceipts", () => {
  it.each([wrapped, wrapped.replaceAll('yield', 'Yield'), '<yield>\nyumina-state version="1"\nstatus="updated" count="4"\n</yield>'])("removes malformed wrapped receipts from saved prose: %s", receipt => {
    expect(stripStateReceipts(`Story.\n${receipt}\nNext line.`)).toBe('Story.\nNext line.');
  });
  it.each([`He says ${wrapped}`, `"${wrapped}"`, `\`\`\`text\n${wrapped}\n\`\`\``, '<yield>Ordinary story</yield>'])('preserves literal and ordinary yields: %s', raw => {
    expect(stripStateReceipts(raw)).toBe(raw);
  });
  it("removes standalone protocol while retaining surrounding story", () => {
    expect(stripStateReceipts(`First\n  ${marker}\nLast\n${marker}`)).toBe("First\nLast");
  });
  it("is idempotent for repeated history/copy cleanup", () => {
    const raw = `Story.\n${marker}`;
    expect(stripStateReceipts(stripStateReceipts(raw))).toBe(stripStateReceipts(raw));
  });
  it.each([`He says ${marker} in prose.`, `> ${marker}`, `\\${marker}`, `"${marker}"`])
    ("preserves quoted/escaped markers %s", (raw) => expect(stripStateReceipts(raw)).toBe(raw));
  it("preserves fenced narrative examples rather than removing their contents", () => {
    const raw = `Example:\n\`\`\`text\n${marker}\n\`\`\``;
    expect(stripStateReceipts(raw)).toBe(raw);
  });
});


describe("choice handoff metadata", () => {
  const markers = ['<Yield></yield>', '<yield> \n \n</yield>', '<Yield>Choices follow</yield>', '<yield>Choices follow.</yield>', '<yield>\nChoices follow\n</yield>'];
  it.each(markers)("hides %s in saved replies and at every stream split", marker => {
    const raw = `Story.\n${marker}\n[CHOICES: Wait | Leave]`;
    expect(stripStateReceipts(raw)).toBe('Story.\n[CHOICES: Wait | Leave]');
    for (let split = 0; split <= raw.length; split++) {
      expect(streamed([raw.slice(0, split), raw.slice(split)])).toBe('Story.\n\n[CHOICES: Wait | Leave]');
    }
    expect(streamed([...raw])).toBe('Story.\n\n[CHOICES: Wait | Leave]');
  });
  it.each(['<yield>Choices follow the river.</yield>', '`<Yield>Choices follow</yield>`', '```text\n<Yield>Choices follow</yield>\n```', 'He says <Yield>Choices follow</yield>'])("retains narrative and literal examples: %s", raw => {
    expect(stripStateReceipts(raw)).toBe(raw);
    expect(streamed([...raw])).toBe(raw);
  });
});
