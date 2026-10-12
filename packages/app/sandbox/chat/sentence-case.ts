/** Capitalize visible sentence starts without changing markup, code, or URLs. */
export function capitalizeSentenceStarts(root: Element): void {
  let sentenceStart = true;
  let sentenceEnd = false;
  let lineBreaks = 0;

  function visit(node: Node): void {
    if (node.nodeType === 3) {
      const text = node.textContent ?? "";
      // Addresses are case sensitive; leave the entire token as supplied.
      const tokens = text.split(/((?:https?:\/\/|www\.|[\p{L}\p{N}._%+-]+@)[^\s<>]+)/gu);
      node.textContent = tokens.map((token, index) => {
        if (index % 2 === 1) {
          sentenceStart = false;
          sentenceEnd = /[.!?。！？]["'”’»」』)\]]*$/u.test(token);
          lineBreaks = 0;
          return token;
        }
        return Array.from(token, char => {
          if (!/\s/u.test(char)) lineBreaks = 0;
          if (sentenceStart && /[\p{L}\p{N}]/u.test(char)) {
            sentenceStart = false;
            sentenceEnd = false;
            return char.toUpperCase();
          } else if (/[.!?。！？]/u.test(char)) {
            sentenceEnd = true;
          } else if (sentenceEnd && /\s/u.test(char)) {
            sentenceStart = true;
            sentenceEnd = false;
          } else if (!/["'”’»」』)\]]/u.test(char)) {
            sentenceEnd = false;
          }
          return char;
        }).join("");
      }).join("");
      return;
    }
    if (node.nodeType === 1) {
      const tag = (node as Element).tagName;
      if (["PRE", "CODE", "IFRAME"].includes(tag)) {
        sentenceStart = tag !== "CODE";
        sentenceEnd = false;
        lineBreaks = 0;
        return;
      }
      if (tag === "BR") {
        lineBreaks++;
        if (sentenceEnd || lineBreaks > 1) {
          sentenceStart = true;
          sentenceEnd = false;
        }
        return;
      }
      if (["HR", "P", "DIV"].includes(tag)) {
        sentenceStart = true;
        sentenceEnd = false;
        lineBreaks = 0;
      }
    }
    for (const child of node.childNodes) visit(child);
  }

  visit(root);
}
