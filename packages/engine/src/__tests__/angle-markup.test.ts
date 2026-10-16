import { describe, expect, it } from 'vitest';
import { stripAngleMarkup } from '../parser/angle-markup.js';

describe('model markup stays out of story display', () => {
  it.each(['<Yunmina-state version="1" status="updated" count="3" />', '[Yumina-state version="1" Status="Updated" Count="2"]', '[Another-state count="2" version="1"]', '[Yumina-state version=\n[SPEAKER:Maeve:normal]"1"\nStatus=\n[SPEAKER:Maeve:normal]"Updated"\nCount=\n[SPEAKER:Maeve:normal]"2"\n]', '<unknown-tag/>', '<>'])('removes %s before quoted values can be parsed as speech', tag => {
    expect(stripAngleMarkup('Before\n' + tag + '\nAfter')).toBe('Before\n\nAfter');
  });
  it('keeps narration inside wrappers and literal code, quotes, links and comparisons intact', () => {
    expect(stripAngleMarkup('<unknown>Readable prose</unknown>')).toBe('Readable prose');
    for (const text of ['2 < 3; 5 > 4', '<https://example.com>', '`<example/>`', '```xml\n<example/>\n```', '"<example/>"', '`[Yumina-state version="1"]`']) expect(stripAngleMarkup(text)).toBe(text);
  });
});
