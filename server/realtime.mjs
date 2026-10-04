import WebSocket from "ws";
import { randomUUID } from "node:crypto";

import { profiles } from "../public/profiles.js";
export { profiles };
const voices = new Set(["Tina", "Serena", "Zane"]);

export function connectRealtime(client, config, options = {}) {
  const send = (event) => {
    if (client.readyState === WebSocket.OPEN)
      client.send(JSON.stringify(event));
  };
  if (!config.dashscopeKey) {
    send({
      type: "app.error",
      message:
        "还没有配置千问密钥。请在项目 .env 中填写 DASHSCOPE_API_KEY，再重启服务。",
    });
    client.close(1000);
    return;
  }
  let url;
  try {
    url = new URL(config.realtimeUrl);
    if (!["wss:", "ws:"].includes(url.protocol))
      throw new Error("invalid protocol");
  } catch {
    send({
      type: "app.error",
      message: "千问接口地址无效，请检查 .env 的 DASHSCOPE_REALTIME_URL。",
    });
    client.close(1000);
    return;
  }
  url.searchParams.set("model", config.model);
  const upstream = new WebSocket(url, {
    headers: { Authorization: `Bearer ${config.dashscopeKey}` },
    handshakeTimeout: 12000,
    maxPayload: 2 * 1024 * 1024,
  });
  let ready = false;
  let responding = false;
  const cancelledResponses = new Set();
  let currentResponse = null;
  let finished = false;
  const timeout = setTimeout(
    () => fail("千问连接超时，请检查网络或稍后重试。"),
    18000,
  );
  const session = {
    modalities: ["text", "audio"],
    voice: voices.has(options.voice) ? options.voice : "Tina",
    input_audio_format: "pcm16",
    output_audio_format: "pcm24",
    input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
    instructions: profiles[options.profile] || profiles.friend,
    turn_detection: {
      type: "server_vad",
      threshold: 0.5,
      silence_duration_ms: Math.max(
        400,
        Math.min(1500, Number(options.pause) || 800),
      ),
    },
  };
  const transmit = (event) => {
    if (upstream.readyState === WebSocket.OPEN)
      upstream.send(JSON.stringify({ event_id: randomUUID(), ...event }));
  };
  function close() {
    if (finished) return;
    finished = true;
    clearTimeout(timeout);
    if (upstream.readyState === WebSocket.CONNECTING) upstream.terminate();
    else if (upstream.readyState === WebSocket.OPEN) upstream.close();
  }
  function fail(message) {
    if (finished) return;
    send({ type: "app.error", message });
    close();
    client.close(1000);
  }
  upstream.on("message", (raw) => {
    if (finished) return;
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return fail("千问返回了无法读取的数据，请重新连接。");
    }
    if (event.type === "session.created")
      transmit({ type: "session.update", session });
    else if (event.type === "session.updated") {
      clearTimeout(timeout);
      ready = true;
      send({ type: "app.ready", model: config.model });
    } else if (event.type === "error") {
      // Error payloads from an upstream may contain request data; expose only an actionable explanation.
      if (/cancel|no.*response|not.*active/i.test(event.error?.message || ""))
        return;
      fail(
        "千问语音服务拒绝了请求。请检查密钥、模型权限及百炼账户余额，再重新连接。",
      );
    } else {
      if (event.type === "response.created") {
        responding = true;
        currentResponse = event.response?.id;
      }
      if (event.type === "input_audio_buffer.speech_started") {
        if (currentResponse) cancelledResponses.add(currentResponse);
        if (responding) transmit({ type: "response.cancel" });
        responding = false;
      }
      const responseId = event.response_id || event.response?.id;
      if (cancelledResponses.has(responseId) && /delta|done/.test(event.type))
        return;
      if (cancelledResponses.size > 32)
        cancelledResponses.delete(cancelledResponses.values().next().value);
      if (event.type === "response.done") {
        responding = false;
        if (event.response?.status === "failed")
          send({
            type: "app.warning",
            message: "这次语音回复没有完成，可以再说一次。",
          });
      }
      const allowed = [
        "input_audio_buffer.speech_started",
        "input_audio_buffer.speech_stopped",
        "conversation.item.input_audio_transcription.completed",
        "conversation.item.input_audio_transcription.failed",
        "response.created",
        "response.audio.delta",
        "response.audio_transcript.delta",
        "response.audio_transcript.done",
        "response.text.delta",
        "response.text.done",
        "response.audio.done",
        "response.done",
      ];
      if (allowed.includes(event.type)) send(event);
    }
  });
  upstream.on("error", (error) => {
    const status = /response: (\d+)/.exec(error.message)?.[1];
    fail(
      status === "401" || status === "403"
        ? "千问密钥鉴权失败（401/403）。请换用该地域有效的百炼 API Key，在项目 .env 配置后重启。"
        : "暂时连接不上千问。请检查网络、接口地域和模型权限后重试。",
    );
  });
  upstream.on("close", () => {
    if (!finished) fail("语音连接已断开，点击开始通话可以重新连接。");
  });
  client.on("message", (raw) => {
    if (!ready || finished) return;
    let event;
    try {
      event = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (
      event.type === "audio" &&
      typeof event.audio === "string" &&
      event.audio.length > 0 &&
      event.audio.length <= 64000 &&
      /^[A-Za-z0-9+/]*={0,2}$/.test(event.audio) &&
      Buffer.from(event.audio, "base64").length % 2 === 0
    ) {
      if (upstream.bufferedAmount > 512000)
        return fail("网络传输跟不上麦克风，已停止通话。请检查连接后重试。");
      transmit({ type: "input_audio_buffer.append", audio: event.audio });
    } else if (event.type === "interrupt") {
      if (currentResponse) cancelledResponses.add(currentResponse);
      if (responding) transmit({ type: "response.cancel" });
      responding = false;
      send({ type: "app.interrupted" });
    }
  });
  client.on("close", close);
  client.on("error", close);
}
