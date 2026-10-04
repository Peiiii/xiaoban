import test from "node:test";
import assert from "node:assert/strict";
import { encodePCM16, decodePCM16, AudioEngine } from "../public/audio.js";

test("PCM uses signed 16-bit little-endian samples and clips out-of-range input", () => {
  const encoded = encodePCM16(new Float32Array([-2, -1, -0.5, 0, 0.5, 1, 2]));
  assert.deepEqual(
    Array.from(encoded),
    [0, 128, 0, 128, 0, 192, 0, 0, 0, 64, 255, 127, 255, 127],
  );
  const decoded = decodePCM16(encoded);
  assert.equal(decoded[0], -1);
  assert.equal(decoded[3], 0);
  assert.ok(Math.abs(decoded[4] - 0.5) < 0.0001);
  assert.ok(decoded[5] < 1);
});
test("PCM decoder respects a sliced buffer and rejects malformed byte length", () => {
  assert.deepEqual(
    Array.from(
      decodePCM16(new Uint8Array([9, 9, 0, 128, 0, 0, 9, 9]).subarray(2, 6)),
    ),
    [-1, 0],
  );
  assert.throws(() => decodePCM16(new Uint8Array(3)), /even byte length/);
});

test("ending a call during pending audio resume cannot reactivate its output", async () => {
  const states = [];
  let finishResume;
  const engine = new AudioEngine(
    () => {},
    () => {},
    () => {},
    () => {},
    (state) => states.push(state),
  );
  engine.playbackContext = {
    state: "suspended",
    resume: () =>
      new Promise((resolve) => {
        finishResume = resolve;
      }),
    close() {
      this.state = "closed";
      return Promise.resolve();
    },
  };
  const pending = engine.resumeOutput();
  engine.stop();
  finishResume();
  assert.equal(await pending, false);
  assert.deepEqual(states, []);
  assert.equal(engine.playbackContext, null);
});

// The audio timeline is the observable boundary: gaps, ordering, cancellation
// and tail completion matter, rather than the internal queue implementation.
function playback(mode = "smooth", rate = 1) {
  const scheduled = [], states = [];
  let drained = 0;
  const context = {
    state: "running",
    currentTime: 0,
    createBuffer(_channels, length, sampleRate) {
      return { duration: length / sampleRate, copyToChannel() {} };
    },
    createBufferSource() {
      const source = {
        playbackRate: {}, connect() {}, disconnect() {},
        start(time) { this.time = time; scheduled.push(this); },
        stop() { this.stopped = true; },
      };
      return source;
    },
  };
  const engine = new AudioEngine(
    () => {}, () => drained++, () => {}, () => {},
    (state) => states.push(state),
  );
  engine.playbackContext = context;
  engine.output = { gain: { value: 1 } };
  engine.mode = mode;
  engine.rate = rate;
  engine.beginResponse();
  function frame(at, seconds = 0.2) {
    context.currentTime = at;
    engine.play(Buffer.alloc(Math.round(seconds * 24000) * 2).toString("base64"));
  }
  function advance(at) {
    context.currentTime = at;
    for (const source of scheduled) {
      const end = source.time + source.buffer.duration / source.playbackRate.value;
      if (!source.ended && !source.stopped && end <= at) {
        source.ended = true;
        source.onended?.();
      }
    }
  }
  function assertContinuous(sources = scheduled) {
    for (let i = 1; i < sources.length; i++) {
      const previous = sources[i - 1];
      assert.ok(Math.abs(sources[i].time - previous.time -
        previous.buffer.duration / previous.playbackRate.value) < 0.000001);
    }
  }
  return { engine, context, scheduled, states, frame, advance, assertContinuous,
    drained: () => drained };
}

test("smooth mode absorbs delayed and bursty arrival into one continuous reply", () => {
  const p = playback();
  for (const at of [0, 0.08, 0.8, 0.82, 2.2, 2.22, 3.1]) p.frame(at);
  assert.equal(p.scheduled.length, 0, "no scraps played before audio completion");
  p.engine.completeResponse();
  assert.equal(p.scheduled.length, 7, "no received samples lost");
  assert.ok(Math.abs(p.scheduled[0].time - 3.135) < 0.000001);
  p.assertContinuous();
  assert.equal(p.engine.busy, true);
  p.advance(5);
  assert.equal(p.engine.busy, false);
  assert.equal(p.drained(), 1);
  p.engine.completeResponse();
  assert.equal(p.drained(), 1, "audio.done plus response.done is idempotent");
});

test("realtime mode prefills by actual playback duration, then schedules gaplessly", () => {
  const p = playback("realtime", 1.3);
  for (const at of [0, 0.05, 0.1]) p.frame(at);
  assert.equal(p.scheduled.length, 0, "600ms of PCM is shorter at faster speed");
  p.frame(0.15);
  assert.equal(p.scheduled.length, 4);
  p.frame(0.3);
  p.assertContinuous();
  p.engine.completeResponse();
  p.advance(2);
  assert.equal(p.drained(), 1);
});

test("realtime underrun refills instead of playing scraps; completion flushes short tail", () => {
  const p = playback("realtime");
  for (const at of [0, 0.1, 0.2]) p.frame(at);
  p.advance(1);
  assert.equal(p.drained(), 0, "an underrun is not the end of the reply");
  assert.equal(p.states.at(-1), "buffering");
  for (const at of [1.1, 1.2, 1.3, 1.4]) p.frame(at);
  assert.equal(p.scheduled.length, 3, "refill threshold grows to one second");
  p.frame(1.5);
  assert.equal(p.scheduled.length, 8);
  p.assertContinuous(p.scheduled.slice(3));
  p.advance(3);
  p.frame(3.1, 0.08);
  assert.equal(p.scheduled.length, 8);
  p.engine.completeResponse();
  assert.equal(p.scheduled.length, 9, "short tail cannot get stuck waiting for threshold");
  p.advance(4);
  assert.equal(p.drained(), 1);
});

test("interrupt clears buffered and scheduled audio and the next response still works", () => {
  const p = playback();
  p.frame(0);
  p.engine.interrupt();
  p.engine.completeResponse();
  assert.equal(p.engine.busy, false);
  assert.equal(p.scheduled.length, 0);
  p.engine.beginResponse();
  p.frame(1, 0.1);
  p.engine.completeResponse();
  const source = p.scheduled[0];
  p.engine.setSpeaker(false);
  assert.equal(source.stopped, true);
  assert.equal(source.onended, null);
  assert.equal(p.engine.busy, false);
  p.engine.setSpeaker(true);
  p.engine.beginResponse();
  p.frame(2, 0.08);
  p.engine.completeResponse();
  p.advance(3);
  assert.equal(p.drained(), 1);
});

test("empty response and empty PCM finish without creating a broken audio source", () => {
  const p = playback();
  p.engine.play("");
  p.engine.completeResponse();
  assert.equal(p.engine.busy, false);
  assert.equal(p.scheduled.length, 0);
  assert.equal(p.drained(), 1);
});
