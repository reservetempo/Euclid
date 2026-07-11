// Main-thread wrapper around the AudioWorklet engine. Owns the AudioContext and
// the worklet node, and exposes a small message API. The DSP itself lives in
// public/worklet/engine.js (served verbatim — see that file's header).

// Per-line transport state, posted once per 16th step: the active node index in
// the line's chain and the step within that node's pattern cycle (each line has
// its own phase — long-form polymeter). `lines` is null when stopped.
export interface Playhead {
  lines: { node: number; step: number }[] | null;
  fired: number[]; // sound ids triggered on this step (for flashes/LEDs)
  pos: number;     // global loop position in 16th steps (for the bar-grid playhead)
}

// One entry in the engine's sound table: a painted sound bound to a pool channel on
// demand. `id` is the stable sound id grid cells reference; `tail` is its ring length.
export interface EngineSound {
  id: number;
  snap: number[];
  lo: number; // Pitch range low (for the key/scale mapping)
  hi: number; // Pitch range high
  tail: number; // estimated audible length, seconds
}

export class EngineHost {
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;

  /** Called whenever the playing step changes (for grid highlighting). */
  onPlayhead: ((p: Playhead) => void) | null = null;

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 44100;
  }

  /** Must be called from a user gesture (iOS/Chrome autoplay policy). */
  async start(): Promise<void> {
    if (this.node) return;
    this.ctx = new AudioContext();
    // Loaded by URL so the worklet is served verbatim; BASE_URL respects the
    // app's deploy base (see vite.config.ts).
    const url = `${import.meta.env.BASE_URL}worklet/engine.js`;
    await this.ctx.audioWorklet.addModule(url);
    this.node = new AudioWorkletNode(this.ctx, "engine-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    this.node.port.onmessage = (e) => {
      const m = e.data;
      if (m.type === "playhead") this.onPlayhead?.({ lines: m.lines ?? null, fired: m.fired ?? [], pos: m.pos ?? 0 });
    };
    this.node.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  /** Resume after a suspend (e.g. iOS interruptions). */
  async resume(): Promise<void> {
    await this.ctx?.resume();
  }

  /** Make sure the context is actually RUNNING — call from a user gesture (the play
      button). iOS suspends the context when the app is backgrounded and sometimes
      only lets a gesture resume it; a longer stay in the background can kill the
      context outright ("closed", or a resume that never takes), in which case the
      whole engine is rebuilt. Returns true when it was rebuilt — the worklet lost
      its sounds/lines/tempo, so the caller must re-push everything. */
  async ensureRunning(): Promise<boolean> {
    if (!this.ctx || !this.node) {
      this.node = null;
      this.ctx = null;
      await this.start();
      return true;
    }
    // "interrupted" (a WebKit state) and "suspended" both resume; "closed" can't.
    if ((this.ctx.state as string) === "running") return false;
    if ((this.ctx.state as string) !== "closed") {
      try {
        await this.ctx.resume();
        if ((this.ctx.state as string) === "running") return false;
      } catch { /* fall through to the rebuild */ }
    }
    // Dead: tear down and start a fresh context + worklet from this gesture.
    try { this.node.disconnect(); } catch { /* already gone */ }
    try { await this.ctx.close(); } catch { /* already closed */ }
    this.node = null;
    this.ctx = null;
    await this.start();
    return true;
  }

  /** Tap a MediaStream (the mic) into the live context for analysis: returns an
      AnalyserNode fed by the stream plus a dispose that disconnects the tap. The
      caller owns the stream (and stops its tracks). Null before start(). */
  micTap(stream: MediaStream): { analyser: AnalyserNode; dispose: () => void } | null {
    if (!this.ctx) return null;
    const src = this.ctx.createMediaStreamSource(stream);
    const analyser = this.ctx.createAnalyser();
    analyser.fftSize = 2048;
    src.connect(analyser);
    return { analyser, dispose: () => { try { src.disconnect(); } catch { /* already gone */ } } };
  }

  /** Replace the sound table (every painted sound across all grids). The engine binds
      each id to a pool channel on demand and steals idle channels under pressure. */
  setSounds(sounds: EngineSound[]): void {
    this.node?.port.postMessage({ type: "setSounds", sounds });
  }

  /** Preview a sound once now (editor voice or a lane), on the reserved audition
      channel. `gate` is the hold length in samples; `tail` its estimated ring. */
  audition(snapshot: number[], gate: number, tail: number): void {
    this.node?.port.postMessage({ type: "audition", snapshot, gate, tail });
  }

  /** Replace the 6 voice lines (node chains with precomputed patterns). Resend on any
      edit; while playing the engine stages it and applies at the next bar boundary.
      Pass `restart` to apply immediately and jump the transport back to the top. */
  setLines(lines: unknown[], restart = false): void {
    this.node?.port.postMessage({ type: "lines", lines, restart });
  }

  setTempo(bpm: number): void {
    this.node?.port.postMessage({ type: "tempo", bpm });
  }

  play(): void {
    this.node?.port.postMessage({ type: "play" });
  }

  stop(): void {
    this.node?.port.postMessage({ type: "stop" });
  }

  /** Render the lines offline (faster than realtime) to an AudioBuffer: fire exactly
      `maxSteps` steps then let tails/FX ring for `tailSec`. Uses its own
      OfflineAudioContext + worklet instance, independent of live playback. */
  async renderToBuffer(opts: {
    lines: unknown[];
    sounds: EngineSound[];
    tempo: number;
    maxSteps: number;
    tailSec: number;
    sampleRate?: number;
  }): Promise<AudioBuffer> {
    const sr = opts.sampleRate ?? 44100;
    const samplesPerStep = (sr * 60) / Math.max(1, opts.tempo) / 4;
    const length = Math.max(1, Math.ceil(opts.maxSteps * samplesPerStep + Math.max(0, opts.tailSec) * sr));
    const ctx = new OfflineAudioContext(2, length, sr);
    const url = `${import.meta.env.BASE_URL}worklet/engine.js`;
    await ctx.audioWorklet.addModule(url);
    // The whole render config goes in processorOptions (applied in the processor
    // constructor), not port messages — offline rendering starts immediately and would
    // race messages posted just before startRendering.
    const node = new AudioWorkletNode(ctx, "engine-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [2],
      processorOptions: {
        render: true,
        sounds: opts.sounds,
        lines: opts.lines,
        tempo: opts.tempo,
        maxSteps: opts.maxSteps,
      },
    });
    node.connect(ctx.destination);
    const buffer = await ctx.startRendering();
    node.disconnect();
    return buffer;
  }
}
