import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { createInstance } from "i18next";
import { I18nextProvider } from "react-i18next";
import { QuestionAnswerCard } from "./question-answer-card";

test("a sent answer replaces the question form with the actual reply", async () => {
  const i18n = createInstance();
  await i18n.init({ lng: "en", resources: { en: { editor: {} } }, interpolation: { escapeValue: false } });
  const props = {
    prompt: { question: "What next?", options: [{ label: "Just keep the image" }, { label: "Register heroine" }] },
    answer: "Keep it for now\nName it later", busy: true, onAnswer() {},
  };
  const html = renderToStaticMarkup(createElement(I18nextProvider, { i18n }, createElement(QuestionAnswerCard, props)));
  assert.match(html, /Sent: Keep it for now\nName it later/);
  assert.doesNotMatch(html, /<textarea|<form|<button/, "sent cards should not keep inactive answer controls");
});
