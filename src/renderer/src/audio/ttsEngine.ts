// Main-thread face of the synth worker.
//
// Owns the worker, the LRU cache and request coalescing, and hides all of it
// behind TtsProvider so a cloud or system-voice provider can be swapped in later
// without any caller changing.

import { TtsCache, InFlight, cacheKey } from './ttsCache';
import type { WorkerRequest, WorkerResponse } from './ttsWorker';

export interface SynthResult {
  pcm: Float32Array;
  sampleRate: number;
}

export interface TtsProvider {
  /** Synthesize one line. Cached results resolve immediately. */
  synth(text: string, voiceId: string, speed?: number): Promise<SynthResult>;
  /** Voice ids the loaded model actually offers. */
  voices(): Promise<string[]>;
  /** Pay the model-load cost up front so the first real quip is not late. */
  warm(): Promise<void>;
  dispose(): void;
}

export class KokoroProvider implements TtsProvider {
  private worker: Worker | null = null;
  private seq = 0;
  private readonly waiting = new Map<number, { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void }>();
  private readonly cache = new TtsCache<SynthResult>(200, {
    maxBytes: 64 * 1024 * 1024,
    byteSize: (v) => v.pcm.byteLength
  });
  private readonly flight = new InFlight<SynthResult>();
  private recoveryUsed = false;

  private ensure(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./ttsWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (event: MessageEvent<WorkerResponse>) => {
      const pending = this.waiting.get(event.data.id);
      if (!pending) return;
      this.waiting.delete(event.data.id);
      if (event.data.type === 'error') pending.reject(new Error(event.data.message));
      else pending.resolve(event.data);
    };
    worker.onerror = (event) => {
      // A worker-level failure orphans every outstanding request; fail them all
      // rather than leaving the queue waiting forever on a dead worker.
      const err = new Error(event.message || 'tts worker failed');
      for (const [, p] of this.waiting) p.reject(err);
      this.waiting.clear();
      try { worker.terminate(); } catch { /* already gone */ }
      if (this.worker === worker) this.worker = null;
    };
    this.worker = worker;
    return worker;
  }

  private send(msg: Omit<WorkerRequest, 'id'>): Promise<WorkerResponse> {
    const worker = this.ensure();
    const id = ++this.seq;
    return new Promise<WorkerResponse>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.waiting.delete(id);
        reject(new Error('tts synthesis timed out'));
      }, 15000);
      const done = (fn: (v: any) => void) => (v: any) => { clearTimeout(timeout); fn(v); };
      this.waiting.set(id, { resolve: done(resolve), reject: done(reject) });
      worker.postMessage({ ...msg, id } as WorkerRequest);
    });
  }

  async warm(): Promise<void> {
    await this.send({ type: 'warm' } as Omit<WorkerRequest, 'id'>);
  }

  async voices(): Promise<string[]> {
    const res = await this.send({ type: 'voices' } as Omit<WorkerRequest, 'id'>);
    return res.type === 'voices' ? res.voices : [];
  }

  async synth(text: string, voiceId: string, speed = 1): Promise<SynthResult> {
    const key = cacheKey(voiceId, text, speed);
    const hit = this.cache.get(key);
    if (hit) return hit;
    return this.flight.run(key, async () => {
      let res: WorkerResponse;
      try {
        res = await this.send({ type: 'synth', text, voiceId, speed } as Omit<WorkerRequest, 'id'>);
      } catch (err) {
        if (this.recoveryUsed) throw err;
        this.recoveryUsed = true;
        this.worker?.terminate();
        this.worker = null;
        res = await this.send({ type: 'synth', text, voiceId, speed } as Omit<WorkerRequest, 'id'>);
      }
      if (res.type !== 'audio') throw new Error('unexpected synth response');
      const out: SynthResult = { pcm: res.pcm, sampleRate: res.sampleRate };
      this.cache.set(key, out);
      return out;
    });
  }

  dispose(): void {
    this.worker?.terminate();
    this.worker = null;
    this.waiting.clear();
    this.recoveryUsed = false;
  }
}
