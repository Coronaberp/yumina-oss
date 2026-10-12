import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import { bundleAndCompile } from '../studio/lib/tsx-bundler';

const source = new URL('../../../../../interfaces/vn/', import.meta.url);
const files = Object.fromEntries(['choice-text.tsx', 'dialogue-spans.ts', 'speaker-tag.ts', 'presentation-literals.ts'].map(file => [file, readFileSync(new URL(file, source), 'utf8')]));
function renderChoice(text: string) {
  const probe = 'import { ChoiceText, plainChoiceText } from "./choice-text"; export default function Probe(){const api=useYumina();return <button aria-label={plainChoiceText(api.text)}><ChoiceText text={api.text}/></button>;}';
  const result = bundleAndCompile({files:{...files, 'probe.tsx':probe}, entryFile:'probe.tsx'}, () => ({text}));
  assert.equal(result.error, null);
  const dom = new JSDOM(renderToStaticMarkup(createElement(result.Component!)));
  return {dom, button:dom.window.document.querySelector('button')!};
}

test('choices with missing closing action markers show clean italic text and accessible labels', () => {
  for (const marker of ['*', '**', '***', '_', '__']) {
    const text = "Resume the duel with a rank-C spell, holding back your power as ordered";
    const {dom, button} = renderChoice(marker + text);
    try {
      assert.equal(button.textContent, text);
      assert.equal(button.getAttribute('aria-label'), text);
      assert.equal(button.querySelector('em')!.textContent, text);
      assert.equal(button.querySelector('em')!.style.fontStyle, 'italic');
    } finally { dom.window.close(); }
  }
});

test('balanced actions and dialogue retain their separate styles', () => {
  const {dom, button} = renderChoice('*Raise your hand* "I will try."');
  try {
    assert.equal(button.textContent, 'Raise your hand "I will try."');
    assert.equal(button.querySelector('em')!.textContent, 'Raise your hand');
    assert.equal(button.querySelector('.vn-choice-dialogue')!.textContent, '"I will try."');
    assert.equal(button.querySelector('.vn-choice-dialogue')!.getAttribute('style'), 'font-style:normal');
  } finally { dom.window.close(); }
});

test('quoted dialogue stays normal inside an incomplete action span', () => {
  const {dom, button} = renderChoice('*Raise your hand "I will try."');
  try {
    assert.equal(button.textContent, 'Raise your hand "I will try."');
    assert.equal(button.querySelector('em')!.textContent, 'Raise your hand ');
    assert.equal(button.querySelector('.vn-choice-dialogue')!.textContent, '"I will try."');
    assert.equal(button.querySelector<HTMLElement>('.vn-choice-dialogue')!.style.fontStyle, 'normal');
  } finally { dom.window.close(); }
});

test('single-quoted terms inside actions retain the action style', () => {
  const text = "Ask Maeve if Sera's 'purification' threats are enforced";
  const {dom, button} = renderChoice('*' + text);
  try {
    assert.equal(button.textContent, text);
    assert.equal([...button.querySelectorAll('em')].map(node => node.textContent).join(''), text);
    assert.equal(button.querySelector('.vn-choice-dialogue'), null);
  } finally { dom.window.close(); }
});

test('choice cleanup preserves literal stars and keeps supplied HTML inert', () => {
  for (const text of ['Calculate 2 * 3', 'Keep my_variable', '`*literal*`']) {
    const {dom, button} = renderChoice(text);
    try { assert.equal(button.textContent, text); } finally { dom.window.close(); }
  }
  const {dom, button} = renderChoice('*Inspect <img src=x onerror=alert(1)>');
  try {
    assert.equal(button.textContent, 'Inspect <img src=x onerror=alert(1)>');
    assert.equal(button.querySelector('img'), null);
  } finally { dom.window.close(); }
});
