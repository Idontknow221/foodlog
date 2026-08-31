# models/

This folder is intentionally empty in v1.

`ai/local-ai.js` ships with `LocalAIEngine.available = false` — no model file is
referenced, downloaded, or cached by the Service Worker. `service-worker.js`
explicitly ignores any request under `models/` so that adding files here later
can never accidentally get bundled into the offline app-shell cache.

## When you're ready to add a real local model

1. Drop your on-device model file(s) here (e.g. a small ONNX or TFJS-format
   food classifier). Keep it something that can run fully client-side —
   no server, no API key.
2. Update `ai/local-ai.js`:
   - Set `available: true` only after the loader below works end-to-end.
   - Implement the actual load + inference inside `suggestFoodFromPhoto()`,
     reading the model from `./models/...` (relative path, same rule as the
     rest of the app).
3. Do **not** touch `app.js`'s Calculation Engine or Storage Layer. The model
   may only return a `{ foodId, confidence }` suggestion that pre-fills the
   food picker — grams and all nutrition numbers still require explicit user
   confirmation before they reach the database.
4. If you want the model cached for offline use, add its file path(s) to a
   **separate, opt-in** cache (not `CORE_ASSETS` in `service-worker.js`), and
   trigger that download from a Settings toggle the user has to press —
   never automatically on first load. This keeps first-load size small and
   keeps constraint "第一版 AI 必須完全 Disabled" honestly enforced by default.
