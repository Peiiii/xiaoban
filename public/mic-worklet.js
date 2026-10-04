class MicProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.chunk = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const data = inputs[0]?.[0];
    if (data)
      for (let i = 0; i < data.length; i++) {
        this.chunk[this.offset++] = data[i];
        if (this.offset === this.chunk.length) {
          const frame = this.chunk;
          this.port.postMessage(frame, [frame.buffer]);
          this.chunk = new Float32Array(2048);
          this.offset = 0;
        }
      }
    return true;
  }
}
registerProcessor("mic-capture", MicProcessor);
