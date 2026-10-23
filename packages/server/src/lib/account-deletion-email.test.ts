import assert from "node:assert/strict";
import test from "node:test";
import {
  deleteAccountEmailHtml,
  deleteAccountEmailSubject,
  deleteAccountEmailText,
  normalizeDeleteAccountEmailLocale,
} from "./email.js";

const locales = [
  { locale: "en", impact: "What will be deleted", retention: "Records that may remain", cooldown: "Registering again", ignored: "Did not request this?", expires: "This link expires in 1 hour." },
  { locale: "zh", impact: "注销影响", retention: "记录保留说明", cooldown: "重新注册", ignored: "不是你发起的申请？", expires: "此链接将在 1 小时后失效。" },
  { locale: "zh-Hant", impact: "註銷影響", retention: "記錄保留說明", cooldown: "重新註冊", ignored: "不是你發起的申請？", expires: "此連結將於 1 小時後失效。" },
  { locale: "ja", impact: "削除される内容", retention: "保持される記録", cooldown: "再登録について", ignored: "心当たりがありませんか？", expires: "このリンクは1時間で期限切れになります。" },
  { locale: "es", impact: "Qué se eliminará", retention: "Registros que pueden conservarse", cooldown: "Volver a registrarte", ignored: "¿No solicitaste esto?", expires: "Este enlace caduca en 1 hora." },
];
const url = "https://selfhost.example/delete-account#token=fixture";

for (const copy of locales) {
  test(`${copy.locale}: deletion details remain sequential and readable without responsive CSS`, () => {
    const html = deleteAccountEmailHtml(url, "Reader", copy.locale);
    // A mail reader may ignore every style rule. Details must still be one
    // table cell with ordered sections, not sibling columns needing a query.
    const unstyled = html.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, "").replace(/\sstyle="[^"]*"/gi, "");
    assert.ok(unstyled.includes(`<html lang="${copy.locale}">`));
    const details = unstyled.match(/<td\b[^>]*>\s*<h2\b[^>]*>[\s\S]*?<\/td>/)?.[0];
    assert.ok(details, "policy sections occupy a standalone reading cell");
    assert.equal((details.match(/<td\b/g) ?? []).length, 1);
    let previous = -1;
    for (const section of [copy.impact, copy.cooldown, copy.retention, copy.ignored]) {
      const position = details.indexOf(section);
      assert.ok(position > previous, `missing or out-of-order policy section: ${section}`);
      previous = position;
    }
    assert.ok(unstyled.includes(copy.expires));
    assert.ok(unstyled.includes(deleteAccountEmailSubject(copy.locale)));
    assert.equal((unstyled.match(new RegExp(`href="${url}"`, "g")) ?? []).length, 2, "button and copyable fallback retain the same confirmation link");
    const text = deleteAccountEmailText(url, "Reader", copy.locale);
    assert.ok(text.includes(url));
    assert.ok(text.includes(copy.expires));
    for (const paragraph of details.matchAll(/<h2\b[^>]*>[^<]*<\/h2>\s*<p\b[^>]*>([^<]*)<\/p>/g)) {
      assert.ok(text.includes(paragraph[1]), "plain text retains deletion, cooldown and retention policies");
    }
  });

  test(`${copy.locale}: deletion HTML escapes names and link attributes`, () => {
    const name = '<img src=x onerror="alert(1)"> & \'Reader\'';
    const unsafeUrl = 'https://selfhost.example/delete-account?a=1&b=" onmouseover="alert(1)';
    const html = deleteAccountEmailHtml(unsafeUrl, name, copy.locale);
    assert.ok(!html.includes("<img src=x"));
    assert.ok(html.includes("&lt;img src=x onerror=&quot;alert(1)&quot;&gt; &amp; &#39;Reader&#39;"));
    assert.ok(!html.includes('href="https://selfhost.example/delete-account?a=1&b="'));
    assert.equal((html.match(/href="https:\/\/selfhost\.example\/delete-account\?a=1&amp;b=&quot; onmouseover=&quot;alert\(1\)"/g) ?? []).length, 2);
  });
}

test("deletion email locale variants and unknown locales preserve their fallback", () => {
  for (const [input, expected] of [[" zh-TW ", "zh-Hant"], ["zh-CN", "zh"], ["ja-JP", "ja"], ["es-MX", "es"], ["fr", "en"]]) {
    assert.equal(normalizeDeleteAccountEmailLocale(input), expected);
    assert.equal(deleteAccountEmailHtml(url, "Reader", input), deleteAccountEmailHtml(url, "Reader", expected));
  }
});
