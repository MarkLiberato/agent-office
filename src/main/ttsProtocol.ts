// Serve the Kokoro weights to the renderer's synth worker.
//
// transformers.js fetches model files by URL, but the weights deliberately live
// OUTSIDE the asar (they are shipped through electron-builder's extraResources,
// like resources/skills and kg.cjs). A tiny custom protocol bridges the two, so
// the worker can keep allowRemoteModels = false and still load from disk.
//
// The path resolver is pure and separately tested: anything that escapes the
// model directory, or that is not one of the file types the model is made of,
// is refused rather than served.

import { app, protocol, net } from 'electron';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const TTS_SCHEME = 'office-tts';

/** Extensions the model legitimately consists of: the weights and tokenizer, the
 *  voice packs, and the staged onnxruntime-web runtime under ort/ (.wasm/.mjs).
 *  Anything else is not ours and is refused. */
const ALLOWED = new Set(['.onnx', '.onnx_data', '.json', '.bin', '.txt', '.wasm', '.mjs']);

/** Repo path in dev, unpacked resources path once packaged — the same split
 *  skillsResourceDir() makes for the bundled skills. */
export function ttsResourceDir(): string {
  return app.isPackaged
    ? path.join(process.resourcesPath, 'tts')
    : path.join(app.getAppPath(), 'resources', 'tts');
}

export function resolveTtsPath(baseDir: string, requestUrl: string): string | null {
  let rel: string;
  try {
    // office-tts://model/onnx/model_quantized.onnx -> onnx/model_quantized.onnx
    rel = decodeURIComponent(new URL(requestUrl).pathname).replace(/^\/+/, '');
  } catch {
    return null;
  }
  if (!rel) return null;
  if (!ALLOWED.has(path.extname(rel).toLowerCase())) return null;

  const resolved = path.resolve(baseDir, rel);
  const root = path.resolve(baseDir);
  // path.relative escaping upward is the containment check; a bare prefix
  // comparison would let /models/tts-evil through.
  const within = path.relative(root, resolved);
  if (!within || within.startsWith('..') || path.isAbsolute(within)) return null;
  return resolved;
}

export function registerTtsProtocol(): void {
  protocol.handle(TTS_SCHEME, async (request) => {
    const file = resolveTtsPath(ttsResourceDir(), request.url);
    if (!file) return new Response('not found', { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
}
