export function encodePCM16(samples) {
  const bytes = new Uint8Array(samples.length * 2);
  const view = new DataView(bytes.buffer);
  for (let i = 0; i < samples.length; i++) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(i * 2, Math.round(s < 0 ? s * 32768 : s * 32767), true);
  }
  return bytes;
}
export function decodePCM16(bytes) {
  if (bytes.length % 2)
    throw new Error("PCM payload must have even byte length");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(bytes.length / 2);
  for (let i = 0; i < out.length; i++)
    out[i] = view.getInt16(i * 2, true) / 32768;
  return out;
}
export function base64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
export class AudioEngine {
  constructor(
    onFrame,
    onDrained,
    onLevel,
    onDeviceEnded,
    onOutputState = () => {},
  ) {
    this.onFrame = onFrame;
    this.onDrained = onDrained;
    this.onLevel = onLevel;
    this.onDeviceEnded = onDeviceEnded;
    this.onOutputState = onOutputState;
    this.sources = new Set();
    this.generation = 0;
    this.muted = false;
    this.speaker = true;
    this.rate = 1;
    this.outputBlocked = false;
    this.mode = "smooth";
    this.pending = [];
    this.pendingDuration = 0;
    this.responseComplete = true;
    this.buffering = false;
    this.bufferTarget = 0.6;
  }
  async startOutput() {
    if (!this.playbackContext || this.playbackContext.state === "closed") {
      // Keep speaker playback at the device rate; microphone capture remains 16kHz.
      this.playbackContext = new AudioContext({ latencyHint: "interactive" });
      this.output = this.playbackContext.createGain();
      this.output.gain.value = this.speaker ? 1 : 0;
      this.output.connect(this.playbackContext.destination);
      this.playbackContext.onstatechange = () => {
        if (this.playbackContext?.state === "suspended" && this.sources.size) {
          this.outputBlocked = true;
          this.onOutputState("blocked");
          void this.resumeOutput();
        }
      };
    }
    return this.resumeOutput();
  }
  async resumeOutput() {
    const context = this.playbackContext,
      generation = this.generation;
    if (!context || context.state === "closed") return false;
    if (this.resuming) return this.resuming;
    let timeout;
    const resume = (async () => {
      try {
        if (context.state !== "running") {
          await Promise.race([
            context.resume(),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("Audio resume blocked")),
                2000,
              );
            }),
          ]);
        }
        if (generation !== this.generation || context !== this.playbackContext)
          return false;
        this.outputBlocked = context.state !== "running";
        this.onOutputState(this.outputBlocked ? "blocked" : "ready");
        return !this.outputBlocked;
      } catch {
        if (
          generation === this.generation &&
          context === this.playbackContext
        ) {
          this.outputBlocked = true;
          this.onOutputState("blocked");
        }
        return false;
      } finally {
        clearTimeout(timeout);
      }
    })();
    this.resuming = resume;
    try {
      return await resume;
    } finally {
      if (this.resuming === resume) this.resuming = null;
    }
  }
  async start() {
    const generation = ++this.generation;
    const outputReady = this.startOutput();
    this.context = new AudioContext({ sampleRate: 16000 });
    await this.context.resume();
    if (!(await outputReady)) {
      const error = new Error("Browser audio output is blocked");
      error.name = "AudioOutputError";
      throw error;
    }
    if (generation !== this.generation) return false;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      },
    });
    if (generation !== this.generation) {
      stream.getTracks().forEach((t) => t.stop());
      return false;
    }
    this.stream = stream;
    stream.getAudioTracks()[0].onended = () => this.onDeviceEnded();
    await this.context.audioWorklet.addModule("/mic-worklet.js");
    if (generation !== this.generation) return false;
    this.input = this.context.createMediaStreamSource(stream);
    this.worklet = new AudioWorkletNode(this.context, "mic-capture");
    this.worklet.port.onmessage = ({ data }) => {
      if (generation !== this.generation || !this.context) return;
      if (this.muted) {
        this.onLevel(0);
        return;
      }
      const rms = Math.sqrt(
        data.reduce((sum, v) => sum + v * v, 0) / data.length,
      );
      this.onLevel(Math.min(1, rms * 7));
      // The context's requested rate is enforced rather than silently sending audio at another rate.
      if (this.context.sampleRate !== 16000) {
        this.onDeviceEnded("浏览器没有提供 16kHz 采样，请使用 Chrome 重试。");
        return;
      }
      this.onFrame(base64(encodePCM16(data)));
    };
    this.input.connect(this.worklet);
    this.worklet.connect(this.context.destination);
    this.nextTime = 0;
    return true;
  }
  play(encoded) {
    const context = this.playbackContext;
    if (!context || context.state === "closed" || !this.speaker) return;
    if (context.state !== "running") {
      this.outputBlocked = true;
      this.onOutputState("blocked");
      void this.resumeOutput();
    }
    const raw = Uint8Array.from(atob(encoded), (c) => c.charCodeAt(0));
    const samples = decodePCM16(raw);
    if (!samples.length) return;
    const buffer = context.createBuffer(1, samples.length, 24000);
    buffer.copyToChannel(samples, 0);
    this.pending.push(buffer);
    this.pendingDuration += buffer.duration;
    if (
      this.responseMode === "realtime" &&
      !this.buffering &&
      this.nextTime &&
      this.nextTime < context.currentTime + 0.015
    )
      this.waitForAudio(true);
    this.flush();
  }
  get busy() {
    return this.pending.length > 0 || this.sources.size > 0;
  }
  beginResponse() {
    this.interrupt();
    this.responseComplete = false;
    this.responseMode = this.mode;
    this.waitForAudio();
  }
  completeResponse() {
    if (this.responseComplete) return;
    this.responseComplete = true;
    this.flush();
    if (!this.busy) {
      this.buffering = false;
      this.onDrained();
    }
  }
  waitForAudio(underrun = false) {
    if (underrun && !this.buffering)
      this.bufferTarget = Math.min(1.8, this.bufferTarget + 0.4);
    this.buffering = true;
    this.nextTime = 0;
    this.onOutputState(this.outputBlocked ? "blocked" : "buffering");
  }
  flush() {
    if (!this.pending.length) return;
    if (!this.responseComplete) {
      if (this.responseMode === "smooth") return;
      if (
        this.buffering &&
        this.pendingDuration / this.rate + 0.000001 < this.bufferTarget
      )
        return;
    }
    const context = this.playbackContext;
    this.buffering = false;
    const buffers = this.pending;
    this.pending = [];
    this.pendingDuration = 0;
    for (const buffer of buffers) this.schedule(buffer, context);
    this.onOutputState(this.outputBlocked ? "blocked" : "playing");
  }
  schedule(buffer, context) {
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = this.rate;
    source.connect(this.output);
    this.sources.add(source);
    const start = Math.max(context.currentTime + 0.035, this.nextTime || 0);
    this.nextTime = start + buffer.duration / this.rate;
    source.onended = () => {
      source.disconnect();
      this.sources.delete(source);
      if (!this.sources.size) {
        if (this.responseComplete && !this.pending.length) this.onDrained();
        else this.waitForAudio(true);
      }
    };
    source.start(start);
  }
  interrupt() {
    for (const source of this.sources) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        /* Already completed. */
      }
      source.disconnect();
    }
    this.sources.clear();
    this.pending = [];
    this.pendingDuration = 0;
    this.responseComplete = true;
    this.buffering = false;
    this.nextTime = 0;
  }
  setMuted(value) {
    this.muted = value;
    if (this.stream)
      for (const track of this.stream.getTracks()) track.enabled = !value;
  }
  setSpeaker(value) {
    this.speaker = value;
    if (this.output) this.output.gain.value = value ? 1 : 0;
    if (!value) this.interrupt();
    else if (this.playbackContext) void this.resumeOutput();
  }
  stop() {
    ++this.generation;
    this.interrupt();
    if (this.stream)
      for (const track of this.stream.getTracks()) {
        track.onended = null;
        track.stop();
      }
    this.input?.disconnect();
    if (this.worklet) {
      this.worklet.port.onmessage = null;
      this.worklet.port.close();
    }
    this.worklet?.disconnect();
    this.output?.disconnect();
    if (this.playbackContext) {
      this.playbackContext.onstatechange = null;
      this.playbackContext.close().catch(() => {});
    }
    this.context?.close().catch(() => {});
    this.stream = null;
    this.context = null;
    this.input = null;
    this.worklet = null;
    this.output = null;
    this.playbackContext = null;
    this.resuming = null;
    this.outputBlocked = false;
    this.bufferTarget = 0.6;
  }
}
