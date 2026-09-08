/// <reference lib="webworker" />
//
// Kokoro synthesis, off the main thread.
//
// Pixi drives a continuous render loop on the main thread; running ONNX
// inference there would drop frames on every quip. The worker owns the model and
// hands back raw PCM as a transferable, so nothing large is ever copied.
//
// Three things have to be redirected before this loads anything, or the app
// would quietly depend on the network at startup:
//
//   1. transformers.js resolves models against huggingface.co. Pointing
//      remoteHost at our own protocol makes it read resources/tts instead.
//   2. onnxruntime-web fetches its WASM runtime from a jsdelivr CDN by default.
//      wasmPaths aims it at the copy staged under resources/tts/ort.
//   3. kokoro-js loads voice packs from a hub URL baked into the library, with
//      no env knob to change it — so hub URLs are rewritten in fetch itself.
//
// The protocol is served by main (src/main/ttsProtocol.ts) from a directory that
// ships outside the asar.

import { env } from '@huggingface/transformers';
import { KokoroTTS } from 'kokoro-js';

const MODEL_ORIGIN = 'office-tts://model';
const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';

// (3) kokoro-js hardcodes https://huggingface.co/<repo>/resolve/main/voices/<v>.bin.
const nativeFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (url.includes('huggingface.co')) {
    const tail = url.split('/resolve/')[1];
    // Drop the revision segment: <rev>/voices/af_sarah.bin -> voices/af_sarah.bin
    const rel = tail ? tail.split('/').slice(1).join('/') : url.split('huggingface.co/')[1];
    return nativeFetch(`${MODEL_ORIGIN}/${rel}`, init);
  }
  return nativeFetch(input as RequestInfo, init);
}) as typeof fetch;

// (1) Model, config and tokenizer come from our protocol, not the hub. The
// template is emptied so the repo id and revision drop out of the path — the
// directory we serve IS the repo.
env.remoteHost = `${MODEL_ORIGIN}/`;
env.remotePathTemplate = '';
env.allowLocalModels = false;

// (2) The ONNX runtime's own wasm, staged beside the weights. The backend object
// is typed optional because transformers.js also runs under node, where there is
// no wasm backend at all; in a worker it is always there.
const wasmBackend = env.backends.onnx.wasm;
if (wasmBackend) {
  wasmBackend.wasmPaths = `${MODEL_ORIGIN}/ort/`;
  // One inference at a time on a small model; extra workers cost memory and add
  // nothing, and threaded wasm needs cross-origin isolation we do not have.
  wasmBackend.numThreads = 1;
} else {
  // Not fatal, but it means onnxruntime keeps its jsdelivr default — the one
  // path by which this feature could silently start needing the network. Say so
  // rather than letting an offline launch fail with a confusing fetch error.
  console.warn('[tts] no wasm backend to configure; onnxruntime may try to load its runtime from a CDN');
}

export type WorkerRequest =
  | { type: 'warm'; id: number }
  | { type: 'voices'; id: number }
  | { type: 'synth'; id: number; text: string; voiceId: string; speed: number };

export type WorkerResponse =
  | { type: 'ready'; id: number }
  | { type: 'voices'; id: number; voices: string[] }
  | { type: 'audio'; id: number; pcm: Float32Array; sampleRate: number }
  | { type: 'error'; id: number; message: string };

let ttsPromise: Promise<KokoroTTS> | null = null;

function load(): Promise<KokoroTTS> {
  if (!ttsPromise) {
    ttsPromise = KokoroTTS.from_pretrained(MODEL_ID, { dtype: 'q8', device: 'wasm' });
  }
  return ttsPromise;
}

const post = (msg: WorkerResponse, transfer: Transferable[] = []) =>
  (self as unknown as Worker).postMessage(msg, transfer);

self.onmessage = async (event: MessageEvent<WorkerRequest>) => {
  const msg = event.data;
  try {
    if (msg.type === 'warm') {
      await load();
      post({ type: 'ready', id: msg.id });
      return;
    }
    if (msg.type === 'voices') {
      const tts = await load();
      post({ type: 'voices', id: msg.id, voices: Object.keys(tts.voices ?? {}) });
      return;
    }
    const tts = await load();
    const audio = await tts.generate(msg.text, { voice: msg.voiceId as never, speed: msg.speed });
    const pcm = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
    post({ type: 'audio', id: msg.id, pcm, sampleRate: audio.sampling_rate }, [pcm.buffer]);
  } catch (err) {
    post({ type: 'error', id: msg.id, message: err instanceof Error ? err.message : String(err) });
  }
};
