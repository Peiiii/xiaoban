// Isolated browser fixture: synthetic microphone and upstream events, never real model evidence.
import { WebSocketServer } from "ws";
import { makeServer } from "../server/index.mjs";
const upstream = new WebSocketServer({ port: 4320, host: "127.0.0.1" });
upstream.on("connection", (ws) => {
  let sent = false;
  const send = (event) => {
    if (ws.readyState === 1) ws.send(JSON.stringify(event));
  };
  send({ type: "session.created" });
  ws.on("message", (raw) => {
    const event = JSON.parse(raw);
    if (event.type === "session.update") send({ type: "session.updated" });
    if (event.type === "input_audio_buffer.append" && !sent) {
      sent = true;
      send({
        type: "input_audio_buffer.speech_started",
        item_id: "fixture-user",
      });
      setTimeout(() => {
        send({
          type: "input_audio_buffer.speech_stopped",
          item_id: "fixture-user",
        });
        send({
          type: "conversation.item.input_audio_transcription.completed",
          item_id: "fixture-user",
          transcript: "这是模拟麦克风的音频装配测试。",
        });
        send({
          type: "response.created",
          response: { id: "fixture-response" },
        });
        send({
          type: "response.audio_transcript.delta",
          response_id: "fixture-response",
          delta: "这是模拟上游的回复，用于验证界面与音频播放。",
        });
        const pcm = Buffer.alloc(24000 * 12 * 2);
        for (let i = 0; i < pcm.length / 2; i++)
          pcm.writeInt16LE(
            Math.sin((i / 24000) * Math.PI * 2 * 440) * 2000,
            i * 2,
          );
        // Bursts and stalls would fragment the old immediate playback.
        const arrivals = [0, 80, 800, 820, 2200, 2220, 3100];
        const chunkBytes = Math.ceil(pcm.length / arrivals.length / 2) * 2;
        arrivals.forEach((at, i) => setTimeout(() => {
          send({
            type: "response.audio.delta",
            response_id: "fixture-response",
            delta: pcm.subarray(i * chunkBytes, (i + 1) * chunkBytes).toString("base64"),
          });
          if (i === arrivals.length - 1) {
            send({ type: "response.audio.done", response_id: "fixture-response" });
            send({
              type: "response.done",
              response: { id: "fixture-response", status: "completed" },
            });
          }
        }, at));
      }, 300);
    }
  });
});
makeServer({
  dashscopeKey: "synthetic-test-key",
  deepseekKey: "",
  model: "fixture",
  realtimeUrl: "ws://127.0.0.1:4320/realtime",
}).listen(4319, "127.0.0.1", () =>
  console.log("Synthetic browser fixture: http://localhost:4319"),
);
