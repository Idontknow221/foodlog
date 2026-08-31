'use strict';

/* =========================================================================
   0. SMALL UTILITIES
   ========================================================================= */
function genId() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  return 'id-' + Date.now() + '-' + Math.random().toString(36).slice(2, 10);
}
function now() { return Date.now(); }
function todayStr(d) {
  d = d || new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}
function dateLabel(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const dt = new Date(y, m - 1, d);
  const weekday = ['週日', '週一', '週二', '週三', '週四', '週五', '週六'][dt.getDay()];
  return `${m}月${d}日 ${weekday}`;
}
function formatBytes(bytes) {
  if (!bytes) return '0 KB';
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
function clamp(n, min, max) { return Math.min(max, Math.max(min, n)); }

let toastTimer = null;
function toast(message, type) {
  const region = document.getElementById('toastRegion');
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' is-error' : type === 'success' ? ' is-success' : '');
  el.textContent = message;
  region.appendChild(el);
  setTimeout(() => { el.remove(); }, 3200);
}

/* =========================================================================
   1. PRESENTATION LAYER — the ONLY place "≈" / "約" / "已超過約" may appear.
   Calculation Engine and Storage Layer below only ever produce plain Numbers.
   ========================================================================= */
function formatEstimated(value, unit) {
  const n = (typeof value === 'number' && isFinite(value)) ? value : 0;
  const rounded = Math.round(n);
  return `≈ ${rounded}${unit ? ' ' + unit : ''}`;
}
function formatOverTarget(diff, unit) {
  const rounded = Math.round(Math.abs(diff));
  return `已超過約 ${rounded}${unit ? ' ' + unit : ''}`;
}
function formatRemaining(diff, unit) {
  const rounded = Math.round(Math.abs(diff));
  return `剩餘約 ${rounded}${unit ? ' ' + unit : ''}`;
}
function progressPercent(consumed, goal) {
  if (!goal || goal <= 0) return null;
  return (consumed / goal) * 100;
}

/* =========================================================================
   2. INDEXEDDB STORAGE LAYER (stores: meals, photos, meta) — pure Numbers only
   ========================================================================= */
const DB_NAME = 'foodlog-db';
const DB_VERSION = 1;
let dbInstance = null;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('meals')) {
        const meals = db.createObjectStore('meals', { keyPath: 'id' });
        meals.createIndex('date', 'date');
        meals.createIndex('status', 'status');
        meals.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('photos')) {
        const photos = db.createObjectStore('photos', { keyPath: 'id' });
        photos.createIndex('mealId', 'mealId');
        photos.createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function getDB() { if (!dbInstance) dbInstance = await openDB(); return dbInstance; }
function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
async function dbPut(store, value) {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  await reqToPromise(tx.objectStore(store).put(value));
  return value;
}
async function dbGet(store, key) {
  const db = await getDB();
  const tx = db.transaction(store, 'readonly');
  return reqToPromise(tx.objectStore(store).get(key));
}
async function dbGetAll(store) {
  const db = await getDB();
  const tx = db.transaction(store, 'readonly');
  return reqToPromise(tx.objectStore(store).getAll());
}
async function dbDelete(store, key) {
  const db = await getDB();
  const tx = db.transaction(store, 'readwrite');
  return reqToPromise(tx.objectStore(store).delete(key));
}
async function dbCount(store) {
  const db = await getDB();
  const tx = db.transaction(store, 'readonly');
  return reqToPromise(tx.objectStore(store).count());
}
async function getRecentPhotos(limit) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('photos', 'readonly');
    const idx = tx.objectStore('photos').index('createdAt');
    const results = [];
    const req = idx.openCursor(null, 'prev');
    req.onsuccess = (e) => {
      const cursor = e.target.result;
      if (cursor && results.length < limit) { results.push(cursor.value); cursor.continue(); }
      else resolve(results);
    };
    req.onerror = () => reject(req.error);
  });
}
async function getMeta(key, fallback) {
  try { const rec = await dbGet('meta', key); return rec ? rec.value : fallback; }
  catch (e) { return fallback; }
}
async function setMeta(key, value) { return dbPut('meta', { key, value }); }

/* =========================================================================
   3. NUTRITION DATABASE (canonical source) + CALCULATION ENGINE (pure Number)
   ========================================================================= */
let NUTRITION_DB = [];
let foodIndex = {};

async function loadNutritionDB() {
  try {
    const res = await fetch('./data/nutrition.json');
    if (!res.ok) throw new Error('http ' + res.status);
    const json = await res.json();
    NUTRITION_DB = Array.isArray(json.foods) ? json.foods : [];
    foodIndex = {};
    NUTRITION_DB.forEach((f) => { foodIndex[f.foodId] = f; });
    return true;
  } catch (e) {
    console.warn('nutrition.json load failed', e);
    return false;
  }
}

// Calculation Engine: User Confirmed Grams + Nutrition Database -> pure Number nutrition.
function calcNutrition(foodId, grams) {
  const food = foodIndex[foodId];
  if (!food) return { calories: 0, protein: 0, carbs: 0, fat: 0 };
  const factor = (typeof grams === 'number' && grams > 0) ? grams / 100 : 0;
  const p = food.per100g;
  return {
    calories: p.calories * factor,
    protein: p.protein * factor,
    carbs: p.carbs * factor,
    fat: p.fat * factor
  };
}

/* Quick Foods: fixed defaultGrams per constraint 16. Only foodId + defaultGrams are
   defined here — name/category/nutrition always comes from nutrition.json. */
const QUICK_FOODS_DEF = [
  { foodId: 'rice_cooked', defaultGrams: 150 },
  { foodId: 'chicken_breast', defaultGrams: 120 },
  { foodId: 'egg', defaultGrams: 50 },
  { foodId: 'broccoli', defaultGrams: 100 },
  { foodId: 'leafy_greens', defaultGrams: 100 },
  { foodId: 'beef', defaultGrams: 120 },
  { foodId: 'pork', defaultGrams: 120 },
  { foodId: 'salmon', defaultGrams: 120 },
  { foodId: 'sweet_potato', defaultGrams: 150 },
  { foodId: 'banana', defaultGrams: 120 },
  { foodId: 'oats', defaultGrams: 50 },
  { foodId: 'milk', defaultGrams: 240 }
];
let QUICK_FOODS = []; // cross-validated subset, populated at startup

function crossValidateQuickFoods() {
  QUICK_FOODS = QUICK_FOODS_DEF.filter((q) => {
    const ok = !!foodIndex[q.foodId];
    if (!ok) console.warn(`[QuickFoods] foodId "${q.foodId}" not found in nutrition.json — button skipped`);
    return ok;
  });
}

/* =========================================================================
   4. PHOTO COMPRESSION — fixed 4-step ladder, stops after the last step
   ========================================================================= */
const COMPRESSION_STEPS = [
  { max: 800, q: 0.6 },
  { max: 640, q: 0.5 },
  { max: 480, q: 0.4 },
  { max: 360, q: 0.35 }
];
const COMPRESSION_TARGET_BYTES = 80 * 1024;

function loadImageFromBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, width: img.naturalWidth, height: img.naturalHeight, url });
    img.onerror = (e) => { URL.revokeObjectURL(url); reject(e); };
    img.src = url;
  });
}
function drawAndEncode(loaded, maxDim, quality) {
  return new Promise((resolve, reject) => {
    let w = loaded.width, h = loaded.height;
    if (w >= h && w > maxDim) { h = Math.round(h * maxDim / w); w = maxDim; }
    else if (h > w && h > maxDim) { w = Math.round(w * maxDim / h); h = maxDim; }
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(loaded.img, 0, 0, w, h);
    canvas.toBlob((blob) => {
      if (!blob) { reject(new Error('toBlob failed')); return; }
      resolve({ blob, width: w, height: h });
    }, 'image/jpeg', quality);
  });
}
async function compressPhoto(fileOrBlob) {
  const loaded = await loadImageFromBlob(fileOrBlob);
  try {
    let result = null;
    for (let i = 0; i < COMPRESSION_STEPS.length; i++) {
      const step = COMPRESSION_STEPS[i];
      result = await drawAndEncode(loaded, step.max, step.q);
      if (result.blob.size < COMPRESSION_TARGET_BYTES) break;
      // last step reached: stop immediately, no further looping
    }
    return result;
  } finally {
    URL.revokeObjectURL(loaded.url);
  }
}

/* =========================================================================
   5. MEAL / PHOTO SAVE FLOW — status machine with rollback (constraint 12/13)
   ========================================================================= */

// Create a draft meal (used for the "photo first" flow, before food is confirmed).
async function createDraftMealWithPhoto(photoBlob) {
  const id = genId();
  let meal = {
    id, date: todayStr(), createdAt: now(), updatedAt: now(),
    foodId: null, foodName: null, grams: null, nutrition: null,
    photoId: null, photoAttemptFailed: false, status: 'draft'
  };
  await dbPut('meals', meal); // step 1
  try {
    const compressed = await compressPhoto(photoBlob);
    const photoId = genId();
    await dbPut('photos', {
      id: photoId, mealId: id, blob: compressed.blob,
      width: compressed.width, height: compressed.height,
      sizeBytes: compressed.blob.size, createdAt: now()
    }); // step 2/3 success
    meal.photoId = photoId;
  } catch (e) {
    meal.photoAttemptFailed = true; // step 3 failure -> photoId stays null
  }
  meal.updatedAt = now();
  try {
    await dbPut('meals', meal); // step 4
  } catch (e) {
    if (meal.photoId) { try { await dbDelete('photos', meal.photoId); } catch (_) {} }
    // best-effort only — cannot guarantee this write succeeds either.
  }
  return meal;
}

// Finalize a draft (food + grams now confirmed) OR create a brand-new meal directly
// (quick add without a photo). Either way ends in saved / photo-failed / save-failed.
async function commitMeal({ foodId, grams, photoBlob, draftMealId }) {
  const food = foodIndex[foodId];
  if (!food) { toast('找不到這個食物資料', 'error'); return null; }
  const nutrition = calcNutrition(foodId, grams);
  const today = todayStr();

  if (draftMealId) {
    let meal = await dbGet('meals', draftMealId);
    if (!meal) { toast('找不到暫存的紀錄', 'error'); return null; }
    meal.status = 'saving';
    meal.foodId = foodId; meal.foodName = food.name; meal.grams = grams;
    meal.nutrition = nutrition; meal.date = today; meal.updatedAt = now();
    try {
      await dbPut('meals', meal);
      meal.status = meal.photoAttemptFailed ? 'photo-failed' : 'saved';
      await dbPut('meals', meal);
      return meal;
    } catch (e) {
      if (meal.photoId) { try { await dbDelete('photos', meal.photoId); } catch (_) {} }
      meal.status = 'save-failed';
      try { await dbPut('meals', meal); } catch (_) {}
      toast('儲存失敗，稍後可在「設定」中重試', 'error');
      return meal;
    }
  }

  // No pre-existing draft: build the record fresh.
  const id = genId();
  let meal = {
    id, date: today, createdAt: now(), updatedAt: now(),
    foodId, foodName: food.name, grams, nutrition,
    photoId: null, photoAttemptFailed: false, status: 'saving'
  };
  try { await dbPut('meals', meal); } catch (e) { toast('儲存失敗，請再試一次', 'error'); return null; } // step 1

  let photoId = null;
  if (photoBlob) {
    try {
      const compressed = await compressPhoto(photoBlob);
      photoId = genId();
      await dbPut('photos', {
        id: photoId, mealId: id, blob: compressed.blob,
        width: compressed.width, height: compressed.height,
        sizeBytes: compressed.blob.size, createdAt: now()
      });
    } catch (e) {
      photoId = null;
      meal.photoAttemptFailed = true;
    }
  }
  meal.photoId = photoId;
  meal.status = meal.photoAttemptFailed ? 'photo-failed' : 'saved';
  try {
    await dbPut('meals', meal); // step 4
  } catch (e) {
    if (photoId) { try { await dbDelete('photos', photoId); } catch (_) {} } // step 5 rollback
    meal.status = 'save-failed';
    try { await dbPut('meals', meal); } catch (_) {}
    toast('儲存失敗，稍後可在「設定」中重試', 'error');
  }
  return meal;
}

async function markMealCancelled(mealId) {
  try {
    const meal = await dbGet('meals', mealId);
    if (!meal) return;
    if (meal.photoId) { try { await dbDelete('photos', meal.photoId); } catch (_) {} }
    meal.status = 'cancelled';
    meal.updatedAt = now();
    try { await dbPut('meals', meal); } catch (_) {}
  } catch (e) { /* best effort */ }
}

async function retrySaveMeal(mealId) {
  const meal = await dbGet('meals', mealId);
  if (!meal) return;
  meal.status = meal.photoAttemptFailed ? 'photo-failed' : 'saved';
  meal.updatedAt = now();
  try {
    await dbPut('meals', meal);
    toast('已重新儲存', 'success');
  } catch (e) {
    toast('仍然無法儲存，請稍後再試', 'error');
  }
  render();
}

async function updateMealGrams(mealId, newGrams) {
  const meal = await dbGet('meals', mealId);
  if (!meal) return false;
  meal.grams = newGrams;
  meal.nutrition = calcNutrition(meal.foodId, newGrams);
  meal.updatedAt = now();
  try { await dbPut('meals', meal); return true; }
  catch (e) { toast('更新失敗，請稍後再試', 'error'); return false; }
}

/* Startup: clean up drafts/saving/cancelled meals older than 10 minutes. */
async function cleanupStaleDrafts() {
  const meals = await dbGetAll('meals');
  const cutoff = now() - 10 * 60 * 1000;
  const stale = meals.filter((m) => ['draft', 'saving', 'cancelled'].includes(m.status) && m.createdAt < cutoff);
  for (const m of stale) {
    if (m.photoId) { try { await dbDelete('photos', m.photoId); } catch (_) {} }
    try { await dbDelete('meals', m.id); } catch (_) {}
  }
  return stale.length;
}

/* Lightweight startup orphan check: only the most recent 20 photos. */
async function lightweightOrphanCheck() {
  try {
    const recentPhotos = await getRecentPhotos(20);
    let orphanCount = 0;
    for (const photo of recentPhotos) {
      const meal = photo.mealId ? await dbGet('meals', photo.mealId) : null;
      if (!meal || meal.photoId !== photo.id) orphanCount++;
    }
    return { checked: recentPhotos.length, orphanCount };
  } catch (e) { return { checked: 0, orphanCount: 0 }; }
}

/* Full orphan cleanup: user-triggered from Settings, batched + cancellable + progress. */
async function runOrphanCleanup(progressCb, shouldCancel) {
  const photos = await dbGetAll('photos');
  const meals = await dbGetAll('meals');
  const referenced = new Set(meals.filter((m) => m.photoId).map((m) => m.photoId));
  const total = photos.length;
  let processed = 0, deletedCount = 0;
  const batchSize = 20;
  for (let i = 0; i < photos.length; i += batchSize) {
    if (shouldCancel()) break;
    const batch = photos.slice(i, i + batchSize);
    for (const photo of batch) {
      if (!referenced.has(photo.id)) {
        try { await dbDelete('photos', photo.id); deletedCount++; } catch (_) {}
      }
      processed++;
    }
    progressCb(processed, total);
    await new Promise((r) => setTimeout(r, 0));
  }
  return { processed, deletedCount, cancelled: shouldCancel() && processed < total };
}

/* =========================================================================
   6. RECENT / FAVORITES (meta store)
   ========================================================================= */
async function touchRecent(foodId, grams) {
  let recents = await getMeta('recents', []);
  recents = recents.filter((r) => r.foodId !== foodId);
  recents.unshift({ foodId, lastUsedAt: now(), lastGrams: grams });
  recents = recents.slice(0, 12);
  await setMeta('recents', recents);
}
async function toggleFavorite(foodId) {
  let favs = await getMeta('favorites', []);
  favs = favs.includes(foodId) ? favs.filter((f) => f !== foodId) : [foodId, ...favs];
  await setMeta('favorites', favs);
  return favs;
}

/* =========================================================================
   7. RECOMMENDATION ENGINE — estimation tone only, fixed disclaimer in HTML
   ========================================================================= */
function buildRecommendations(totals, goals, mealCount) {
  const list = [];
  if (mealCount === 0) {
    list.push('目前似乎還沒有任何紀錄，可以考慮先記一餐試試看，讓估算更準確。');
    return list;
  }
  if (goals.calories > 0) {
    const diff = totals.calories - goals.calories;
    if (diff > 0) {
      list.push(`根據目前紀錄估算，熱量已超過約 ${Math.round(diff)} kcal，接下來的份量可以考慮酌量減少。`);
    } else if (Math.abs(diff) > 300) {
      list.push(`根據目前紀錄估算，熱量攝取似乎還有約 ${Math.round(Math.abs(diff))} kcal 的空間，可以考慮視情況補充。`);
    }
  }
  if (goals.protein > 0 && totals.protein < goals.protein * 0.6) {
    list.push('根據目前紀錄估算，蛋白質攝取似乎偏低，可以考慮增加雞胸肉、雞蛋或豆腐等來源。');
  }
  if (list.length === 0) {
    list.push('根據目前紀錄估算，目前的飲食組成大致均衡，可以考慮保持目前的記錄習慣。');
  }
  return list;
}

/* =========================================================================
   8. APP STATE + VIEW WIRING
   ========================================================================= */
const state = {
  currentView: 'dashboard',
  currentAddTab: 'quick',
  pendingDraftMealId: null,
  pendingDraftPhotoUrl: null,
  activeObjectUrls: [],
  sheet: { mode: null, foodId: null, mealId: null, draftMealId: null, photoBlob: null, photoUrl: null },
  recents: [],
  favorites: [],
  goals: { calories: 0, protein: 0, carbs: 0, fat: 0 }
};

function revokeActiveUrls() {
  state.activeObjectUrls.forEach((u) => { try { URL.revokeObjectURL(u); } catch (_) {} });
  state.activeObjectUrls = [];
}
async function photoUrlFor(photoId) {
  if (!photoId) return null;
  try {
    const rec = await dbGet('photos', photoId);
    if (!rec || !rec.blob) return null;
    const url = URL.createObjectURL(rec.blob);
    state.activeObjectUrls.push(url);
    return url;
  } catch (e) { return null; }
}

/* ---------- Status bar ---------- */
let appInitialized = false;
function updateStatusBar() {
  const dot = document.getElementById('onlineDot');
  const text = document.getElementById('statusText');
  const online = navigator.onLine;
  dot.className = 'status-dot ' + (online ? 'is-online' : 'is-offline');
  if (!appInitialized) {
    text.textContent = online ? '首次載入中…' : '需要連網才能完成首次載入';
  } else {
    text.textContent = online ? '線上' : '離線・使用本機資料';
  }
}

/* ---------- Navigation ---------- */
function switchView(name) {
  if (state.currentView === 'add' && name !== 'add' && state.pendingDraftMealId) {
    markMealCancelled(state.pendingDraftMealId);
    clearDraftPhotoUI();
  }
  state.currentView = name;
  document.querySelectorAll('.view').forEach((v) => { v.hidden = v.dataset.view !== name; });
  document.querySelectorAll('.nav-btn').forEach((b) => b.classList.toggle('is-active', b.dataset.view === name));
  render();
}

/* ---------- Draft photo (photo-first flow) ---------- */
function clearDraftPhotoUI() {
  state.pendingDraftMealId = null;
  if (state.pendingDraftPhotoUrl) { URL.revokeObjectURL(state.pendingDraftPhotoUrl); state.pendingDraftPhotoUrl = null; }
  const box = document.getElementById('draftPhotoPreview');
  box.hidden = true;
  box.innerHTML = '';
}
async function handlePhotoInputChange(e) {
  const file = e.target.files && e.target.files[0];
  e.target.value = '';
  if (!file) return;
  toast('照片處理中…');
  const meal = await createDraftMealWithPhoto(file);
  state.pendingDraftMealId = meal.id;
  const url = await photoUrlFor(meal.photoId);
  state.pendingDraftPhotoUrl = url;
  const box = document.getElementById('draftPhotoPreview');
  box.hidden = false;
  box.innerHTML = '';
  if (url) {
    const img = document.createElement('img');
    img.src = url;
    box.appendChild(img);
  }
  const label = document.createElement('span');
  label.textContent = meal.photoAttemptFailed ? '照片儲存失敗，仍可直接選擇食物繼續' : '已附上照片，請選擇食物完成紀錄';
  box.appendChild(label);
  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'btn btn-ghost btn-small';
  cancelBtn.type = 'button';
  cancelBtn.textContent = '取消';
  cancelBtn.addEventListener('click', () => {
    markMealCancelled(meal.id);
    clearDraftPhotoUI();
  });
  box.appendChild(cancelBtn);
}

/* ---------- Add tabs ---------- */
function switchAddTab(tab) {
  state.currentAddTab = tab;
  document.querySelectorAll('.add-tab').forEach((b) => b.classList.toggle('is-active', b.dataset.tab === tab));
  document.querySelectorAll('.add-tab-panel').forEach((p) => p.classList.toggle('is-active', p.id === 'tab-' + tab));
  renderAddView();
}

/* ---------- Portion sheet ---------- */
function openPortionSheet(opts) {
  const food = foodIndex[opts.foodId];
  if (!food) { toast('找不到這個食物資料', 'error'); return; }
  state.sheet = {
    mode: opts.mode, foodId: opts.foodId, mealId: opts.mealId || null,
    draftMealId: opts.draftMealId || null, photoBlob: opts.photoBlob || null, photoUrl: opts.photoUrl || null
  };
  document.getElementById('portionFoodName').textContent = food.name;
  document.getElementById('portionPer100').textContent =
    `每 100g：約 ${Math.round(food.per100g.calories)} kcal・蛋白 ${Math.round(food.per100g.protein)}g・碳水 ${Math.round(food.per100g.carbs)}g・脂肪 ${Math.round(food.per100g.fat)}g`;

  const grams = clamp(opts.grams || 100, 1, 2000);
  const range = document.getElementById('gramsRange');
  const numberInput = document.getElementById('gramsNumber');
  range.value = clamp(grams, 10, 500);
  numberInput.value = grams;

  const photoRow = document.getElementById('portionPhotoRow');
  photoRow.innerHTML = '';
  if (opts.photoUrl) {
    photoRow.hidden = false;
    const img = document.createElement('img');
    img.src = opts.photoUrl;
    photoRow.appendChild(img);
    const span = document.createElement('span');
    span.textContent = '已附上照片';
    photoRow.appendChild(span);
  } else {
    photoRow.hidden = true;
  }

  updateFavToggleUI(opts.foodId);
  updatePortionPreview();
  document.getElementById('portionSheet').hidden = false;
}
function closePortionSheet() {
  document.getElementById('portionSheet').hidden = true;
  state.sheet = { mode: null, foodId: null, mealId: null, draftMealId: null, photoBlob: null, photoUrl: null };
}
function updateFavToggleUI(foodId) {
  const btn = document.getElementById('portionFavToggle');
  const isFav = state.favorites.includes(foodId);
  btn.textContent = isFav ? '★' : '☆';
}
function currentSheetGrams() {
  const n = Number(document.getElementById('gramsNumber').value);
  return isFinite(n) && n > 0 ? n : 0;
}
function updatePortionPreview() {
  const grams = currentSheetGrams();
  const nutrition = calcNutrition(state.sheet.foodId, grams);
  const wrap = document.getElementById('portionPreview');
  wrap.innerHTML = '';
  const items = [
    ['熱量', formatEstimated(nutrition.calories, 'kcal')],
    ['蛋白質', formatEstimated(nutrition.protein, 'g')],
    ['碳水', formatEstimated(nutrition.carbs, 'g')],
    ['脂肪', formatEstimated(nutrition.fat, 'g')]
  ];
  items.forEach(([label, value]) => {
    const box = document.createElement('div');
    const l = document.createElement('span'); l.className = 'pv-label'; l.textContent = label;
    const v = document.createElement('span'); v.className = 'pv-value'; v.textContent = value;
    box.appendChild(l); box.appendChild(v);
    wrap.appendChild(box);
  });
}

/* =========================================================================
   9. RENDERING
   ========================================================================= */
function foodRow(food, { showGramsHint } = {}) {
  const row = document.createElement('div');
  row.className = 'food-row';
  const left = document.createElement('div');
  const name = document.createElement('div'); name.className = 'food-name'; name.textContent = food.name;
  left.appendChild(name);
  if (showGramsHint) {
    const meta = document.createElement('div'); meta.className = 'food-meta'; meta.textContent = showGramsHint;
    left.appendChild(meta);
  }
  row.appendChild(left);
  const star = document.createElement('button');
  star.type = 'button'; star.className = 'fav-star';
  star.textContent = state.favorites.includes(food.foodId) ? '★' : '☆';
  star.addEventListener('click', async (e) => {
    e.stopPropagation();
    state.favorites = await toggleFavorite(food.foodId);
    renderAddView();
  });
  row.appendChild(star);
  row.addEventListener('click', () => {
    const recent = state.recents.find((r) => r.foodId === food.foodId);
    openPortionSheet({ mode: 'create', foodId: food.foodId, grams: recent ? recent.lastGrams : 100 });
  });
  return row;
}

function renderAddView() {
  // Quick foods
  const quickGrid = document.getElementById('quickFoodsGrid');
  quickGrid.innerHTML = '';
  QUICK_FOODS.forEach((q) => {
    const food = foodIndex[q.foodId];
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'quick-btn';
    const nameSpan = document.createElement('span'); nameSpan.className = 'quick-name'; nameSpan.textContent = food.name;
    const gramsSpan = document.createElement('span'); gramsSpan.className = 'quick-default'; gramsSpan.textContent = q.defaultGrams + 'g';
    btn.appendChild(nameSpan); btn.appendChild(gramsSpan);
    btn.addEventListener('click', () => {
      openPortionSheet({
        mode: 'create', foodId: q.foodId, grams: q.defaultGrams,
        draftMealId: state.pendingDraftMealId, photoUrl: state.pendingDraftPhotoUrl
      });
    });
    quickGrid.appendChild(btn);
  });

  // Recent
  const recentGrid = document.getElementById('recentFoodsGrid');
  recentGrid.innerHTML = '';
  document.getElementById('recentEmptyHint').hidden = state.recents.length > 0;
  state.recents.forEach((r) => {
    const food = foodIndex[r.foodId];
    if (!food) return;
    recentGrid.appendChild(foodRow(food, { showGramsHint: `上次 ${r.lastGrams}g` }));
  });

  // Favorites
  const favGrid = document.getElementById('favoriteFoodsGrid');
  favGrid.innerHTML = '';
  const favShown = state.favorites.slice(0, 12);
  document.getElementById('favoriteEmptyHint').hidden = favShown.length > 0;
  favShown.forEach((foodId) => {
    const food = foodIndex[foodId];
    if (!food) return;
    favGrid.appendChild(foodRow(food));
  });

  // Search
  renderSearchResults(document.getElementById('searchInput').value.trim());
}
function renderSearchResults(query) {
  const results = document.getElementById('searchResults');
  results.innerHTML = '';
  if (!query) return;
  const matches = NUTRITION_DB.filter((f) => f.name.includes(query) || f.category.includes(query)).slice(0, 30);
  matches.forEach((food) => results.appendChild(foodRow(food)));
  if (matches.length === 0) {
    const p = document.createElement('p'); p.className = 'empty-hint'; p.textContent = '找不到符合的食物';
    results.appendChild(p);
  }
}

function mealStatusLabel(status) {
  return { 'photo-failed': '照片未儲存', 'save-failed': '儲存失敗，點一下重試', saving: '儲存中…' }[status] || '';
}
async function mealCard(meal, { clickable = true } = {}) {
  const card = document.createElement('div');
  card.className = 'meal-card status-' + meal.status;

  if (meal.photoId) {
    const url = await photoUrlFor(meal.photoId);
    const img = document.createElement('img');
    img.className = 'meal-thumb';
    img.src = url || '';
    img.alt = '';
    card.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'meal-thumb placeholder';
    ph.textContent = '🍽';
    card.appendChild(ph);
  }

  const info = document.createElement('div'); info.className = 'meal-info';
  const nameEl = document.createElement('div'); nameEl.className = 'meal-name'; nameEl.textContent = meal.foodName || '（未完成）';
  const subEl = document.createElement('div'); subEl.className = 'meal-sub'; subEl.textContent = `${meal.grams || 0}g`;
  info.appendChild(nameEl); info.appendChild(subEl);
  card.appendChild(info);

  const right = document.createElement('div');
  const calEl = document.createElement('div'); calEl.className = 'meal-cal';
  calEl.textContent = meal.nutrition ? formatEstimated(meal.nutrition.calories, 'kcal') : '';
  right.appendChild(calEl);
  const badgeText = mealStatusLabel(meal.status);
  if (badgeText) {
    const badge = document.createElement('div'); badge.className = 'meal-status-badge'; badge.textContent = badgeText;
    right.appendChild(badge);
  }
  card.appendChild(right);

  if (clickable) {
    card.addEventListener('click', () => {
      if (meal.status === 'save-failed') { retrySaveMeal(meal.id); return; }
      openPortionSheet({
        mode: 'edit', foodId: meal.foodId, mealId: meal.id, grams: meal.grams
      });
    });
  }
  return card;
}

async function renderDashboard() {
  document.getElementById('todayDateLabel').textContent = dateLabel(todayStr());
  const meals = await dbGetAll('meals');
  const todayMeals = meals.filter((m) => m.date === todayStr() && ['saved', 'photo-failed'].includes(m.status));
  todayMeals.sort((a, b) => b.createdAt - a.createdAt);

  const totals = todayMeals.reduce((acc, m) => {
    if (!m.nutrition) return acc;
    acc.calories += m.nutrition.calories; acc.protein += m.nutrition.protein;
    acc.carbs += m.nutrition.carbs; acc.fat += m.nutrition.fat;
    return acc;
  }, { calories: 0, protein: 0, carbs: 0, fat: 0 });

  const goal = state.goals;
  const pct = progressPercent(totals.calories, goal.calories);
  const fill = document.getElementById('calProgressFill');
  const pctLabel = document.getElementById('calProgressPct');
  const numbersLabel = document.getElementById('calProgressLabel');
  if (pct === null) {
    fill.style.width = '0%'; fill.classList.remove('is-over');
    pctLabel.textContent = '';
    numbersLabel.innerHTML = '';
    numbersLabel.classList.remove('is-over');
    const span = document.createElement('span'); span.className = 'approx'; span.textContent = formatEstimated(totals.calories, 'kcal');
    numbersLabel.appendChild(span);
    numbersLabel.appendChild(document.createTextNode('（尚未設定目標）'));
  } else {
    const over = totals.calories > goal.calories;
    fill.style.width = clamp(pct, 0, 100) + '%';
    fill.classList.toggle('is-over', over);
    pctLabel.textContent = Math.round(pct) + '%';
    numbersLabel.classList.toggle('is-over', over);
    numbersLabel.innerHTML = '';
    const main = document.createElement('span'); main.className = 'approx'; main.textContent = formatEstimated(totals.calories, 'kcal');
    numbersLabel.appendChild(main);
    numbersLabel.appendChild(document.createTextNode(over ? formatOverTarget(totals.calories - goal.calories, 'kcal') : ('・' + formatRemaining(goal.calories - totals.calories, 'kcal'))));
  }

  const macroGrid = document.getElementById('macroGrid');
  macroGrid.innerHTML = '';
  [['蛋白質', totals.protein, goal.protein, 'g'], ['碳水', totals.carbs, goal.carbs, 'g'], ['脂肪', totals.fat, goal.fat, 'g']].forEach(([label, val, g, unit]) => {
    const item = document.createElement('div'); item.className = 'macro-item';
    const l = document.createElement('div'); l.className = 'macro-label'; l.textContent = label + '・依目前紀錄估算';
    const v = document.createElement('div'); v.className = 'macro-value'; v.textContent = formatEstimated(val, unit);
    item.appendChild(l); item.appendChild(v);
    if (g > 0) {
      const sub = document.createElement('div'); sub.className = 'macro-label'; sub.textContent = '目標 ' + Math.round(g) + unit;
      item.appendChild(sub);
    }
    macroGrid.appendChild(item);
  });

  revokeActiveUrls();
  const list = document.getElementById('todayMealsList');
  list.innerHTML = '';
  document.getElementById('todayEmptyHint').hidden = todayMeals.length > 0;
  for (const m of todayMeals) list.appendChild(await mealCard(m));

  const recs = buildRecommendations(totals, goal, todayMeals.length);
  const recList = document.getElementById('recommendationsList');
  recList.innerHTML = '';
  recs.forEach((r) => {
    const item = document.createElement('div'); item.className = 'recommend-item'; item.textContent = r;
    recList.appendChild(item);
  });
}

async function renderHistory() {
  const meals = await dbGetAll('meals');
  const shown = meals.filter((m) => ['saved', 'photo-failed', 'save-failed'].includes(m.status));
  shown.sort((a, b) => b.createdAt - a.createdAt);
  const byDate = new Map();
  shown.forEach((m) => {
    if (!byDate.has(m.date)) byDate.set(m.date, []);
    byDate.get(m.date).push(m);
  });
  const dates = Array.from(byDate.keys()).sort().reverse();

  revokeActiveUrls();
  const list = document.getElementById('historyList');
  list.innerHTML = '';
  document.getElementById('historyEmptyHint').hidden = dates.length > 0;
  for (const d of dates) {
    const dayBlock = document.createElement('div'); dayBlock.className = 'history-day';
    const label = document.createElement('div'); label.className = 'history-day-label'; label.textContent = dateLabel(d);
    dayBlock.appendChild(label);
    const inner = document.createElement('div'); inner.className = 'meal-list';
    for (const m of byDate.get(d)) inner.appendChild(await mealCard(m));
    dayBlock.appendChild(inner);
    list.appendChild(dayBlock);
  }
}

async function renderSettings() {
  document.getElementById('goalCalories').value = state.goals.calories || '';
  document.getElementById('goalProtein').value = state.goals.protein || '';
  document.getElementById('goalCarbs').value = state.goals.carbs || '';
  document.getElementById('goalFat').value = state.goals.fat || '';

  const meals = await dbGetAll('meals');
  const failed = meals.filter((m) => m.status === 'save-failed');
  document.getElementById('retrySection').hidden = failed.length === 0;
  const retryList = document.getElementById('retryList');
  retryList.innerHTML = '';
  for (const m of failed) retryList.appendChild(await mealCard(m));

  const photos = await dbGetAll('photos');
  const totalBytes = photos.reduce((s, p) => s + (p.sizeBytes || 0), 0);
  document.getElementById('photoStorageStats').textContent = `${photos.length} 張照片，估算占用 ${formatBytes(totalBytes)}`;

  const check = await lightweightOrphanCheck();
  document.getElementById('orphanHint').textContent =
    `啟動時輕量檢查了最近 ${check.checked} 張照片，發現約 ${check.orphanCount} 張可能是孤兒照片（完整清理請按下方按鈕）`;

  document.getElementById('aiStatus').textContent = window.LocalAIEngine && window.LocalAIEngine.isAvailable()
    ? '本機 AI 已啟用'
    : '本機 AI 尚未啟用（第一版預設關閉，未下載任何模型）';
}

function render() {
  if (state.currentView === 'dashboard') renderDashboard();
  else if (state.currentView === 'add') renderAddView();
  else if (state.currentView === 'history') renderHistory();
  else if (state.currentView === 'settings') renderSettings();
}

/* =========================================================================
   10. EVENT WIRING
   ========================================================================= */
function wireEvents() {
  document.querySelectorAll('.nav-btn').forEach((btn) => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });
  document.querySelectorAll('.add-tab').forEach((btn) => {
    btn.addEventListener('click', () => switchAddTab(btn.dataset.tab));
  });

  document.getElementById('draftPhotoBtn').addEventListener('click', () => {
    document.getElementById('photoInput').click();
  });
  document.getElementById('photoInput').addEventListener('change', handlePhotoInputChange);

  document.getElementById('searchInput').addEventListener('input', (e) => renderSearchResults(e.target.value.trim()));

  const range = document.getElementById('gramsRange');
  const numberInput = document.getElementById('gramsNumber');
  range.addEventListener('input', () => { numberInput.value = range.value; updatePortionPreview(); });
  numberInput.addEventListener('input', () => {
    const n = Number(numberInput.value);
    if (isFinite(n)) range.value = clamp(n, 10, 500);
    updatePortionPreview();
  });

  document.getElementById('portionFavToggle').addEventListener('click', async () => {
    state.favorites = await toggleFavorite(state.sheet.foodId);
    updateFavToggleUI(state.sheet.foodId);
  });

  document.getElementById('portionCancelBtn').addEventListener('click', () => {
    if (state.sheet.mode === 'create' && state.sheet.draftMealId) {
      markMealCancelled(state.sheet.draftMealId);
      clearDraftPhotoUI();
    }
    closePortionSheet();
  });
  document.getElementById('portionBackdrop').addEventListener('click', () => {
    document.getElementById('portionCancelBtn').click();
  });

  document.getElementById('portionConfirmBtn').addEventListener('click', async () => {
    const grams = currentSheetGrams();
    if (grams <= 0) { toast('請輸入有效的公克數', 'error'); return; }
    const sheet = state.sheet;
    if (sheet.mode === 'edit') {
      await updateMealGrams(sheet.mealId, grams);
      closePortionSheet();
      toast('已更新', 'success');
      render();
      return;
    }
    const meal = await commitMeal({ foodId: sheet.foodId, grams, photoBlob: sheet.photoBlob, draftMealId: sheet.draftMealId });
    if (meal) {
      await touchRecent(sheet.foodId, grams);
      state.recents = await getMeta('recents', []);
      if (sheet.draftMealId) clearDraftPhotoUI();
      closePortionSheet();
      toast(meal.status === 'saved' ? '已加入紀錄' : '已加入紀錄（照片未成功儲存）', 'success');
      switchView('dashboard');
    }
  });

  document.getElementById('saveGoalsBtn').addEventListener('click', async () => {
    const g = {
      calories: Number(document.getElementById('goalCalories').value) || 0,
      protein: Number(document.getElementById('goalProtein').value) || 0,
      carbs: Number(document.getElementById('goalCarbs').value) || 0,
      fat: Number(document.getElementById('goalFat').value) || 0
    };
    state.goals = g;
    await setMeta('settings', g);
    toast('已儲存目標', 'success');
    render();
  });

  document.getElementById('clearOldPhotosBtn').addEventListener('click', async () => {
    const cutoff = now() - 30 * 24 * 60 * 60 * 1000;
    const photos = await dbGetAll('photos');
    const old = photos.filter((p) => p.createdAt < cutoff);
    for (const p of old) {
      await dbDelete('photos', p.id);
      const meal = await dbGet('meals', p.mealId);
      if (meal && meal.photoId === p.id) { meal.photoId = null; await dbPut('meals', meal); }
    }
    toast(`已清除 ${old.length} 張照片`, 'success');
    renderSettings();
  });
  document.getElementById('clearAllPhotosBtn').addEventListener('click', async () => {
    if (!confirm('確定要清除全部照片嗎？此動作無法復原（不會刪除餐點紀錄）。')) return;
    const photos = await dbGetAll('photos');
    for (const p of photos) {
      await dbDelete('photos', p.id);
      const meal = await dbGet('meals', p.mealId);
      if (meal && meal.photoId === p.id) { meal.photoId = null; await dbPut('meals', meal); }
    }
    toast(`已清除 ${photos.length} 張照片`, 'success');
    renderSettings();
  });

  let orphanCancelFlag = false;
  document.getElementById('orphanCleanupBtn').addEventListener('click', async () => {
    orphanCancelFlag = false;
    document.getElementById('orphanCleanupBtn').hidden = true;
    document.getElementById('orphanProgressWrap').hidden = false;
    document.getElementById('orphanProgressActions').hidden = false;
    const fill = document.getElementById('orphanProgressFill');
    const label = document.getElementById('orphanProgressLabel');
    fill.style.width = '0%';
    const result = await runOrphanCleanup((processed, total) => {
      const pct = total > 0 ? (processed / total) * 100 : 100;
      fill.style.width = pct + '%';
      label.textContent = `${processed} / ${total}`;
    }, () => orphanCancelFlag);
    document.getElementById('orphanProgressWrap').hidden = true;
    document.getElementById('orphanProgressActions').hidden = true;
    document.getElementById('orphanCleanupBtn').hidden = false;
    toast(result.cancelled ? `已中斷，已清理 ${result.deletedCount} 張孤兒照片` : `完整清理完成，共清理 ${result.deletedCount} 張孤兒照片`, 'success');
    renderSettings();
  });
  document.getElementById('orphanCancelBtn').addEventListener('click', () => { orphanCancelFlag = true; });

  document.getElementById('clearRecentsBtn').addEventListener('click', async () => {
    await setMeta('recents', []);
    state.recents = [];
    toast('已清除最近使用', 'success');
    render();
  });
  document.getElementById('clearFavoritesBtn').addEventListener('click', async () => {
    await setMeta('favorites', []);
    state.favorites = [];
    toast('已清除全部收藏', 'success');
    render();
  });

  window.addEventListener('online', updateStatusBar);
  window.addEventListener('offline', updateStatusBar);
  window.addEventListener('pagehide', () => {
    // Best-effort only — cannot guarantee this async write completes before the page
    // is torn down. The 10-minute stale-draft cleanup on next launch is the real safety net.
    if (state.pendingDraftMealId) markMealCancelled(state.pendingDraftMealId);
  });
}

/* =========================================================================
   11. INIT
   ========================================================================= */
async function initApp() {
  updateStatusBar();
  wireEvents();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./service-worker.js').catch((e) => console.warn('SW register failed', e));
  }

  const dbReady = await getDB().then(() => true).catch((e) => { console.error('IndexedDB unavailable', e); return false; });
  if (!dbReady) { toast('此瀏覽器不支援本機儲存，App 無法正常運作', 'error'); return; }

  const nutritionReady = await loadNutritionDB();
  if (!nutritionReady) {
    toast('無法載入食物資料庫，請確認網路連線後重新整理', 'error');
    updateStatusBar();
    return;
  }
  crossValidateQuickFoods();

  const initMeta = await getMeta('appInit', null);
  if (!initMeta) await setMeta('appInit', { initializedAt: now() });
  appInitialized = true;
  updateStatusBar();

  await cleanupStaleDrafts();

  state.goals = await getMeta('settings', { calories: 0, protein: 0, carbs: 0, fat: 0 });
  state.recents = await getMeta('recents', []);
  state.favorites = await getMeta('favorites', []);

  render();
}

document.addEventListener('DOMContentLoaded', initApp);
