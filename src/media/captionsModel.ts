/**
 * The Whisper model auto-captions run (desktop only). `base` is the multilingual
 * sweet spot for in-browser transcription: good accuracy across every UI
 * language. The `onnx-community` repo is the one packaged for transformers.js v4.
 * Swap for `onnx-community/whisper-small` (better, heavier) or a `.en` variant.
 *
 * The weights load from the HuggingFace hub and are cached by the browser after
 * the first run (see the CSP note in vite.config.ts). To make captions fully
 * offline, self-host the model files like the ffmpeg core and point
 * transformers.js at that path — no code here changes but the URL.
 */
export const CAPTION_MODEL = 'onnx-community/whisper-base';
