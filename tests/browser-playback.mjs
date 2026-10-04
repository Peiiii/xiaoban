// Invoke in a real browser via its developer interface. This tests the actual
// Web Audio renderer, not physical speaker audibility or a live microphone.
export async function verifyContinuousRendering() {
  const { AudioEngine } = await import("/audio.js");
  const renderer = new OfflineAudioContext(1, 48000 * 6, 48000);
  let clock = 0, drained = 0;
  const context = {
    state: "running",
    get currentTime() { return clock; },
    createBuffer: (...args) => renderer.createBuffer(...args),
    createBufferSource: () => renderer.createBufferSource(),
  };
  const engine = new AudioEngine(() => {}, () => drained++, () => {}, () => {});
  engine.playbackContext = context;
  engine.output = renderer.createGain();
  engine.output.connect(renderer.destination);
  engine.beginResponse();
  const raw = new Uint8Array(9600);
  const pcm = new DataView(raw.buffer);
  for (let i = 0; i < 4800; i++) pcm.setInt16(i * 2, 8192, true);
  const encoded = btoa(String.fromCharCode(...raw));
  for (const at of [0, 0.08, 0.8, 0.82, 2.2, 2.22, 3.1]) {
    clock = at;
    engine.play(encoded);
  }
  if (engine.sources.size) throw new Error("Playback started before completion");
  engine.completeResponse();
  const expectedStart = Math.round((3.1 + 0.035) * 48000);
  const expectedLength = Math.round(1.4 * 48000);
  const output = (await renderer.startRendering()).getChannelData(0);
  let silentFrames = 0, longestSilentRun = 0, run = 0, peak = 0;
  for (let i = expectedStart; i < expectedStart + expectedLength; i++) {
    peak = Math.max(peak, Math.abs(output[i]));
    if (Math.abs(output[i]) < 0.01) {
      silentFrames++; run++; longestSilentRun = Math.max(longestSilentRun, run);
    } else run = 0;
  }
  if (longestSilentRun > 2 || silentFrames > 14)
    throw new Error(`Audible scheduling gaps: ${silentFrames} silent frames`);
  if (drained !== 1 || engine.busy) throw new Error("Reply did not drain once");
  return {
    testedAt: new Date().toISOString(),
    source: "Actual browser OfflineAudioContext, real AudioEngine; synthetic constant PCM with delayed arrival clock",
    inputSampleRate: 24000, outputSampleRate: 48000,
    audioSeconds: 1.4, silentFrames, longestSilentRun, peak, drained,
    physicalAudibilityVerified: false,
  };
}
