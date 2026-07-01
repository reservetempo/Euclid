// Main-thread wrapper around the AudioWorklet engine. Owns the AudioContext and
// the worklet node, and exposes a small message API. The DSP itself lives in
// public/worklet/engine.js (served verbatim — see that file's header).

export interface Playhead {
  grid: number; // -1 when stopped / nothing playing
  col: number;
  slot: number; // index in the order list (-1 when stopped)
  fired: number[]; // sound ids triggered on this step (for the mixer flash)
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

  get started(): boolean {
    return this.node !== null;
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
      if (m.type === "playhead") this.onPlayhead?.({ grid: m.grid, col: m.col, slot: m.slot, fired: m.fired ?? [] });
    };
    this.node.connect(this.ctx.destination);
    await this.ctx.resume();
  }

  /** Resume after a suspend (e.g. iOS interruptions). */
  async resume(): Promise<void> {
    await this.ctx?.resume();
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

  /** Replace the pattern (6 grids + 20-slot order). Resend on any edit; while playing the
      engine stages it and applies at the next loop restart. Pass `restart` to apply it now
      and jump the transport to step 0 — used when switching play source (solo a grid /
      back to the loop) so the change is heard immediately. */
  setPattern(
    blocks: { cells: number[]; root: number; scale: number; keyEnabled: boolean }[],
    order: number[],
    restart = false
  ): void {
    this.node?.port.postMessage({ type: "pattern", blocks, order, restart });
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

  /** Render the pattern offline (faster than realtime) to an AudioBuffer: fire exactly
      `maxSteps` steps then let tails/FX ring for `tailSec`. Uses its own
      OfflineAudioContext + worklet instance, independent of live playback. */
  async renderToBuffer(opts: {
    blocks: unknown[];
    order: number[];
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
        blocks: opts.blocks,
        order: opts.order,
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
