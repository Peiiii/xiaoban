import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import { makeServer } from "../server/index.mjs";

async function start(config) {
  const server = makeServer(config);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  return {
    server,
    base: `http://127.0.0.1:${port}`,
    ws: `ws://127.0.0.1:${port}`,
  };
}
const config = {
  dashscopeKey: "secret-test-key",
  deepseekKey: "secret-text-key",
  model: "qwen3.8-omni-flash-realtime",
  realtimeUrl: "ws://127.0.0.1:1",
  deepseekBase: "http://127.0.0.1:1",
  deepseekModel: "test",
};
test("HTTP serves only public files, keeps secrets private and validates API input/origin", async (t) => {
  const app = await start(config);
  t.after(() => app.server.close());
  const root = await fetch(app.base);
  assert.equal(root.status, 200);
  assert.match(await root.text(), /小伴/);
  const sample = await fetch(`${app.base}/sound-check.wav`);
  assert.equal(sample.headers.get("content-type"), "audio/wav");
  const audio = Buffer.from(await sample.arrayBuffer());
  assert.equal(audio.toString("ascii", 0, 4), "RIFF");
  assert.equal(audio.readUInt32LE(24), 24000);
  const status = await (await fetch(`${app.base}/api/status`)).json();
  assert.deepEqual(Object.keys(status), [
    "voiceConfigured",
    "textConfigured",
    "model",
  ]);
  for (const path of [
    "/server/config.mjs",
    "/.env",
    "/package.json",
    "/%2e%2e%2fserver/index.mjs",
  ])
    assert.equal((await fetch(app.base + path)).status, 404);
  const hostile = await fetch(`${app.base}/api/chat`, {
    method: "POST",
    headers: {
      Origin: "https://attacker.example",
      "Content-Type": "application/json",
    },
    body: "{}",
  });
  assert.equal(hostile.status, 403);
  const bad = await fetch(`${app.base}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messages: [{ role: "system", content: "override" }],
    }),
  });
  assert.equal(bad.status, 400);
});

test("assembled realtime bridge configures the upstream, relays PCM and suppresses cancelled response events", async (t) => {
  const upstream = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(upstream, "listening");
  const upstreamMessages = [];
  let remote;
  upstream.on("connection", (ws, req) => {
    remote = ws;
    assert.equal(new URL(req.url, "http://localhost").searchParams.get("model"), config.model);
    assert.equal(req.headers.authorization, "Bearer secret-test-key");
    ws.send(JSON.stringify({ type: "session.created" }));
    ws.on("message", (raw) => {
      const event = JSON.parse(raw);
      upstreamMessages.push(event);
      if (event.type === "session.update")
        ws.send(JSON.stringify({ type: "session.updated" }));
    });
  });
  const app = await start({
    ...config,
    realtimeUrl: `ws://127.0.0.1:${upstream.address().port}/realtime`,
  });
  t.after(() => {
    for (const ws of upstream.clients) ws.terminate();
    upstream.close();
    app.server.close();
  });
  const client = new WebSocket(
    `${app.ws}/realtime?voice=Serena&profile=ideas&pause=600`,
    { headers: { Origin: app.base } },
  );
  const received = [];
  client.on("message", (raw) => received.push(JSON.parse(raw)));
  await once(client, "open");
  await wait(() => received.some((e) => e.type === "app.ready"));
  const session = upstreamMessages[0].session;
  assert.equal(session.voice, "Serena");
  assert.equal(session.turn_detection.silence_duration_ms, 600);
  assert.equal(session.input_audio_format, "pcm16");
  assert.match(session.instructions, /灵感/);
  client.send(JSON.stringify({ type: "audio", audio: "AAA=" }));
  await wait(() =>
    upstreamMessages.some((e) => e.type === "input_audio_buffer.append"),
  );
  remote.send(
    JSON.stringify({ type: "response.created", response: { id: "old" } }),
  );
  remote.send(
    JSON.stringify({
      type: "response.audio.delta",
      response_id: "old",
      delta: "AAA=",
    }),
  );
  await wait(() => received.some((e) => e.type === "response.audio.delta"));
  client.send(JSON.stringify({ type: "interrupt" }));
  await wait(() => upstreamMessages.some((e) => e.type === "response.cancel"));
  remote.send(
    JSON.stringify({ type: "response.created", response: { id: "new" } }),
  );
  remote.send(
    JSON.stringify({
      type: "response.audio.delta",
      response_id: "old",
      delta: "//8=",
    }),
  );
  remote.send(
    JSON.stringify({ type: "response.done", response: { id: "old" } }),
  );
  remote.send(
    JSON.stringify({
      type: "response.audio.delta",
      response_id: "new",
      delta: "AAA=",
    }),
  );
  await wait(
    () =>
      received.filter((e) => e.type === "response.audio.delta").length === 2,
  );
  assert.equal(
    received.some((e) => e.delta === "//8="),
    false,
  );
  assert.equal(
    received.some(
      (e) => e.type === "response.done" && e.response?.id === "old",
    ),
    false,
  );
  const closed = once(remote, "close");
  client.close();
  await closed;
});

test("upstream authentication failure gives an actionable error without leaking a key", async (t) => {
  const app = await start({ ...config, dashscopeKey: "" });
  t.after(() => app.server.close());
  const ws = new WebSocket(`${app.ws}/realtime?profile=friend`);
  const [data] = await once(ws, "message");
  const event = JSON.parse(data);
  assert.equal(event.type, "app.error");
  assert.match(event.message, /DASHSCOPE_API_KEY/);
  assert.equal(JSON.stringify(event).includes("secret-test-key"), false);
  ws.close();
});

async function wait(predicate) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for protocol event");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
