import assert from "node:assert/strict";
import test from "node:test";
import { buildSandboxCsp } from "./sandbox-csp.js";

function sources(policy: string, directive: string): string[] {
  return policy.split("; ").find(value => value.startsWith(`${directive} `))!.split(" ").slice(1);
}

test("local sandbox permits its HTTP assets on localhost, LAN and IPv6", () => {
  for (const origin of ["http://localhost:3000", "http://192.168.88.9:3000", "http://[::1]:3000"]) {
    const policy = buildSandboxCsp(`${origin}/assets/sandbox-doc-test.html?parentOrigin=ignored`, true);
    for (const directive of ["default-src", "img-src", "font-src"]) {
      assert.ok(sources(policy, directive).includes(origin), `${directive} must permit ${origin}`);
      assert.ok(!sources(policy, directive).includes("http:"), "do not allow arbitrary HTTP origins");
    }
    assert.deepEqual(sources(policy, "connect-src"), ["'none'"]);
    assert.deepEqual(sources(policy, "frame-ancestors"), ["'self'"]);
  }
});

test("local sandbox also permits assets served from the configured public origin", () => {
  const policy = buildSandboxCsp("http://localhost:3000/sandbox/index.html", true, "http://192.168.88.9:3000");
  assert.ok(sources(policy, "img-src").includes("http://192.168.88.9:3000"));
});

test("hosted sandbox retains its HTTPS-only policy", () => {
  const policy = buildSandboxCsp("http://localhost:3000/sandbox/index.html", false, "http://192.168.88.9:3000");
  assert.deepEqual(sources(policy, "default-src"), ["https:", "'unsafe-inline'", "'unsafe-eval'"]);
  assert.deepEqual(sources(policy, "img-src"), ["https:", "data:", "blob:"]);
});

test("invalid origins cannot inject CSP directives", () => {
  const policy = buildSandboxCsp("http://host;script-src*/sandbox/index.html", true, "not a URL");
  assert.deepEqual(sources(policy, "default-src"), ["https:", "'unsafe-inline'", "'unsafe-eval'"]);
  assert.deepEqual(sources(policy, "connect-src"), ["'none'"]);
});
