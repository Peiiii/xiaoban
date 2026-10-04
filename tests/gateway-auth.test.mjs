import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";

const sdkSource = await readFile(new URL("../public/vendor/gemigo-app-sdk.umd.js", import.meta.url), "utf8");
const gatewaySource = (await readFile(new URL("../public/gateway.js", import.meta.url), "utf8"))
  .replace('import config from "./gateway-config.js";', 'const config = { projectId: "project", appId: "xiaoban-voice", apiBase: "https://gemigo.io/api/v1", requireLogin: true };')
  .replace('import { profiles } from "./profiles.js";', 'const profiles = {};');
function storage() {
  const data = new Map();
  return { getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => data.set(k, v), removeItem: (k) => data.delete(k) };
}
function browser(local = storage(), session = storage()) {
  const location = { href: "https://xiaoban-voice.gemigo.app/", origin: "https://xiaoban-voice.gemigo.app", hostname: "xiaoban-voice.gemigo.app", assign(url) { this.href = url; } };
  const window = { location, localStorage: local, sessionStorage: session,
    navigator: { userAgent: "Desktop" }, addEventListener() {}, removeEventListener() {},
    setTimeout, clearTimeout, setInterval, clearInterval,
    history: { replaceState(_s, _t, url) { location.href = url; } } };
  window.parent = window;
  window.top = window;
  const context = vm.createContext({ window, self: window, module: { exports: {} }, exports: {},
    setTimeout, clearTimeout, setInterval, clearInterval, crypto, URL,
    TextEncoder, TextDecoder, Uint8Array, AbortController, btoa,
    fetch: async (url) => ({ ok: true, json: async () => url.endsWith("/sdk/auth-requests")
      ? { authorizationUrl: "https://gemigo.io/auth/authorize?request=test" }
      : { accessToken: "fixture-app-token", expiresIn: 3600, appId: "xiaoban-voice", appUserId: "test-user", scopes: ["identity:basic"] } }),
  });
  vm.runInContext(sdkSource, context);
  window.gemigo = context.module.exports;
  return { window, context, local, session };
}
async function gateway(window, fetch = async () => {}) {
  const module = await import("data:text/javascript;base64," + Buffer.from(gatewaySource + `\n//${crypto.randomUUID()}`).toString("base64"));
  globalThis.window = window;
  globalThis.fetch = fetch;
  return module;
}

test("normal SDK redirect persists locally; reopening recovers and logout clears it", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  try {
    const first = browser();
    const app = await gateway(first.window);
    void app.login();
    for (let i = 0; i < 100 && !first.window.location.href.includes("/auth/authorize"); i++)
      await new Promise((resolve) => setTimeout(resolve, 1));
    assert.ok(first.window.location.href.includes("/auth/authorize"));
    const pending = JSON.parse(first.session.getItem("gemigo:sdk-auth:redirect:v1"));
    assert.equal(pending.persist, "local", "actual application requests persistent SDK login");
    first.window.location.href = first.window.location.origin + "/?gemigo_code=fixture-code&gemigo_state=" + pending.state;
    await app.resumeLogin();
    assert.equal(app.loggedIn(), true);
    assert.equal(first.session.getItem("gemigo:sdk-auth:v1"), null);
    const reopened = browser(first.local); // new SDK instance and a new empty tab session
    const secondApp = await gateway(reopened.window);
    assert.equal(secondApp.loggedIn(), true);
    secondApp.logout();
    assert.equal(secondApp.loggedIn(), false);
    assert.equal(first.local.getItem("gemigo:sdk-auth:v1"), null);
    assert.equal(browser(first.local).window.gemigo.auth.getAccessToken(), null);
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});

test("SDK does not hydrate expired credentials; ticket 401 clears identity but outages and limits preserve it", async () => {
  const originalWindow = globalThis.window, originalFetch = globalThis.fetch;
  try {
    const local = storage();
    local.setItem("gemigo:sdk-auth:v1", JSON.stringify({accessToken: "expired-fixture", appId: "xiaoban-voice", appUserId: "test-user", scopes: [], expiresAt: Date.now() - 1000, apiBaseUrl: "https://gemigo.io/api/v1", persistedAt: Date.now()}));
    assert.equal(browser(local).window.gemigo.auth.getAccessToken(), null);
    let current = "fixture", cleared = 0;
    const window = { gemigo: { auth: { getAccessToken: () => current, logout() { current = null; cleared++; } } } };
    for (const status of [503, 403, 429]) {
      const app = await gateway(window, async () => ({ok:false, status, json: async () => ({error:"fixture failure"})}));
      await assert.rejects(app.connectVoice(), /fixture failure/);
      assert.equal(cleared, 0);
    }
    const app = await gateway(window, async () => ({ok:false, status:401, json: async () => ({error:"expired"})}));
    await assert.rejects(app.connectVoice(), /登录已失效/);
    assert.equal(cleared, 1);
    assert.equal(app.loggedIn(), false);
  } finally { globalThis.window = originalWindow; globalThis.fetch = originalFetch; }
});
