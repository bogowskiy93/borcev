import { Viewer } from './viewer.js';

const CACHE_VERSION = 'v12';
const PREVIEW_W = 600;
const PREVIEW_H = 400;
const POOL_SIZE = 2; // больше — больше WebGL-контекстов и риск дропа

function cacheKey(project) {
  const ver = project.model?.version || 'x';
  return `preview_${CACHE_VERSION}_${project.id}_${ver}`;
}

/** Удаляет устаревшие записи кэша превью этого проекта (другие версии) */
function pruneOld(project) {
  const prefix = `preview_${CACHE_VERSION}_${project.id}_`;
  const keep = cacheKey(project);
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix) && k !== keep) localStorage.removeItem(k);
    }
  } catch (_) {}
}

// Пул вьюеров: каждый — отдельный canvas+WebGL-контекст. Когда вьюер свободен —
// возвращается в пул. Это даёт реальную параллельность загрузки моделей.
const pool = [];     // { viewer, busy }
const waiters = [];  // resolve-функции, ждущие свободного вьюера

function makeSlot() {
  const canvas = document.createElement('canvas');
  canvas.width = PREVIEW_W;
  canvas.height = PREVIEW_H;
  // alpha:true → прозрачный фон, цвет берётся из CSS .work-thumb
  // (так одно и то же превью корректно смотрится в любой теме)
  const viewer = new Viewer(canvas, { interactive: false, fastPreview: true, alpha: true });
  return { viewer, busy: false };
}

function acquireSlot() {
  return new Promise((resolve) => {
    const free = pool.find((s) => !s.busy);
    if (free) { free.busy = true; resolve(free); return; }
    if (pool.length < POOL_SIZE) {
      const slot = makeSlot();
      slot.busy = true;
      pool.push(slot);
      resolve(slot);
      return;
    }
    waiters.push(resolve);
  });
}

function releaseSlot(slot) {
  const next = waiters.shift();
  if (next) next(slot);
  else slot.busy = false;
}

/**
 * Генерирует превью для проекта.
 * Возвращает dataURL (jpeg). Кэшируется в localStorage по version.
 */
export async function generatePreview(project) {
  const key = cacheKey(project);

  try {
    const cached = localStorage.getItem(key);
    if (cached) return cached;
  } catch (_) {}

  pruneOld(project);

  const slot = await acquireSlot();
  try {
    await slot.viewer.load(project.model);
    // PNG с прозрачным фоном — фон карточки виден сквозь модель
    const dataURL = slot.viewer.renderToDataURL('image/png');
    try { localStorage.setItem(key, dataURL); } catch (_) {}
    return dataURL;
  } finally {
    releaseSlot(slot);
  }
}

/** Освобождает все вьюеры пула. Вызывай когда все превью готовы. */
export function releaseSharedViewer() {
  for (const slot of pool) slot.viewer.destroy();
  pool.length = 0;
  waiters.length = 0;
}
