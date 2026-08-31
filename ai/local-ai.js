// ai/local-ai.js
// LocalAIEngine — the ONLY sanctioned integration point for a future on-device AI model.
//
// v1 CONTRACT (hard rule): available === false. No model is downloaded, no ONNX Runtime /
// TensorFlow.js is loaded, no network call is made from this file. This file exists purely
// as a stable interface so that a real local model can be plugged in later WITHOUT ever
// touching app.js's Calculation Engine or Storage Layer.
//
// IMPORTANT BOUNDARY: whatever this engine ever returns is a *suggestion* only — a foodId
// guess and a confidence score. It must never be allowed to set final grams / calories /
// protein / carbs / fat. Those numbers only ever come from:
//   User Confirmed Grams + Local Nutrition Database (data/nutrition.json) + Calculation Engine
//
// Future implementers: keep the method signatures below stable. app.js only ever calls
// LocalAIEngine.isAvailable() and LocalAIEngine.suggestFoodFromPhoto(blob), and always
// treats the result as a pre-fill for the food picker, still subject to full user
// confirmation of both food identity and grams.

const LocalAIEngine = {
  // Hard-disabled in v1. Do not flip this without also shipping an actual local model
  // loader that respects constraints 1-6 (zero token, zero API key, zero backend/cloud).
  available: false,

  isAvailable() {
    return LocalAIEngine.available;
  },

  // Returns Promise<{ foodId: string, confidence: number } | null>
  // v1: always resolves null immediately. No model, no inference, no network fetch.
  async suggestFoodFromPhoto(_photoBlob) {
    if (!LocalAIEngine.available) return null;
    // Reserved for future local model inference (e.g. a WASM/ONNX classifier bundled
    // under models/). Must remain fully on-device and must remain advisory-only.
    return null;
  }
};

// Expose globally for a plain <script> include (no bundler in v1).
if (typeof window !== 'undefined') {
  window.LocalAIEngine = LocalAIEngine;
}
