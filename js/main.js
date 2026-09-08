import { discoverProjects, discoverAllProjects, fetchJSON, MANIFEST2_URL, applyAutoTitles, buildFromManifest } from './discover.js';
import { Viewer } from './viewer.js';
import { generatePreview, releaseSharedViewer } from './preview.js';
import { getModelStats, formatNumber } from './stats.js';
import { getDominantColor } from './swatches.js';

// ─── Typewriter для HTML со тегами <b> ───────────────────────────
// Парсит html вида "<b>12345</b> трис · <b>678</b> поли" на сегменты,
// затем печатает посимвольно с задержкой ms. Если вызвать повторно
// до завершения — предыдущий набор прерывается через токен.
let _twToken = 0;
function typewriterHTML(el, html, ms = 20, delay = 0) {
  const token = ++_twToken;

  // Разбиваем на сегменты: { text, bold }
  const segments = [];
  const re = /<b>(.*?)<\/b>|([^<]+)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    if (m[1] !== undefined) segments.push({ text: m[1], bold: true });
    else if (m[2])          segments.push({ text: m[2], bold: false });
  }

  // Собираем плоский массив символов с флагом bold
  const chars = [];
  for (const seg of segments) {
    for (const ch of seg.text) chars.push({ ch, bold: seg.bold });
  }

  el.innerHTML = '';
  let i = 0;

  const tick = () => {
    if (token !== _twToken) return; // прерван новым вызовом
    if (i >= chars.length) return;

    const { ch, bold } = chars[i++];
    if (bold) {
      // Дополняем последний <b> или создаём новый
      let last = el.lastChild;
      if (!last || last.nodeName !== 'B') {
        last = document.createElement('b');
        el.appendChild(last);
      }
      last.textContent += ch;
    } else {
      // Текстовый узел в конце
      let last = el.lastChild;
      if (!last || last.nodeType !== Node.TEXT_NODE) {
        last = document.createTextNode('');
        el.appendChild(last);
      }
      last.textContent += ch;
    }

    setTimeout(tick, ms);
  };

  setTimeout(tick, delay);
}

// ─── Splash ───────────────────────────────────────────────────────
const splashEl     = document.getElementById('splash');
const splashFill   = document.getElementById('splash-fill');
const splashStatus = document.getElementById('splash-status');

function setSplashProgress(loaded, total) {
  const pct = total > 0 ? Math.round((loaded / total) * 100) : 0;
  splashFill.style.width = pct + '%';
  splashStatus.textContent = total > 0
    ? `Загрузка превью ${loaded} / ${total}`
    : 'Загрузка...';
}

function hideSplash() {
  splashStatus.textContent = 'Готово';
  splashFill.style.width = '100%';
  setTimeout(() => splashEl.classList.add('hidden'), 400);
}

// ─── Инициализация после обнаружения моделей ─────────────────────
const worksRow   = document.getElementById('works-row');
const heroCta    = document.getElementById('hero-cta');
const galleryEl  = document.getElementById('gallery');
const toTopBtn   = document.getElementById('to-top');

let projects = [];
const cardImages = [];

// Скролл вниз только по кнопке
document.documentElement.classList.add('scroll-locked');

function unlockScroll() {
  document.documentElement.classList.remove('scroll-locked');
}

function preventScrollWhileLocked(e) {
  if (!document.documentElement.classList.contains('scroll-locked')) return;
  // Разрешаем скролл внутри открытых оверлеев
  if (e.target.closest?.('.modal-overlay.open, .tex-lightbox.open, .onboard-overlay:not(.hidden)')) return;
  e.preventDefault();
}

window.addEventListener('wheel', preventScrollWhileLocked, { passive: false });
window.addEventListener('touchmove', preventScrollWhileLocked, { passive: false });
window.addEventListener('keydown', (e) => {
  if (!document.documentElement.classList.contains('scroll-locked')) return;
  const keys = ['ArrowDown', 'ArrowUp', 'PageDown', 'PageUp', 'Home', 'End', ' ', 'Spacebar'];
  if (!keys.includes(e.key)) return;
  const tag = document.activeElement?.tagName;
  if (tag === 'BUTTON' || tag === 'A' || tag === 'INPUT' || tag === 'TEXTAREA') return;
  e.preventDefault();
});

heroCta.addEventListener('click', () => {
  unlockScroll();
  requestAnimationFrame(() => {
    galleryEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
});

function updateToTop() {
  if (!toTopBtn || !galleryEl) return;
  const galleryTop = galleryEl.getBoundingClientRect().top;
  // Показываем, когда галерея уже почти/полностью в зоне просмотра
  const show = galleryTop < window.innerHeight * 0.55;
  toTopBtn.classList.toggle('visible', show);
  toTopBtn.setAttribute('aria-hidden', show ? 'false' : 'true');
}

window.addEventListener('scroll', updateToTop, { passive: true });
window.addEventListener('resize', updateToTop);

toTopBtn?.addEventListener('click', () => {
  window.scrollTo({ top: 0, behavior: 'smooth' });
});

// ─── Копирование контактов ───────────────────────────────────────
const copyToast = document.getElementById('copy-toast');
let copyToastTimer = 0;

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (_) {
    // fallback
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.cssText = 'position:fixed;left:-9999px;top:0';
    document.body.appendChild(ta);
    ta.select();
    let ok = false;
    try { ok = document.execCommand('copy'); } catch (_) {}
    ta.remove();
    return ok;
  }
}

function showCopyToast(message) {
  if (!copyToast) return;
  copyToast.textContent = message;
  copyToast.classList.add('show');
  clearTimeout(copyToastTimer);
  copyToastTimer = setTimeout(() => copyToast.classList.remove('show'), 2200);
}

document.querySelectorAll('.contact-link[data-copy]').forEach((btn) => {
  btn.addEventListener('click', async () => {
    const value = btn.dataset.copy || '';
    const msg = btn.dataset.copyMsg || 'Скопировано';
    const ok = await copyText(value);
    showCopyToast(ok ? msg : 'Не удалось скопировать');
  });
});

// Failsafe: если что-то пошло не так на хостинге — сплэш не должен висеть вечно.
const SPLASH_FAILSAFE_MS = 20000;
const splashFailsafe = setTimeout(() => {
  if (!splashEl.classList.contains('hidden')) {
    splashStatus.textContent = 'Долго грузится… открываю сайт без превью';
    hideSplash();
  }
}, SPLASH_FAILSAFE_MS);

discoverProjects()
  .then((discovered) => {
    projects = discovered;
    setSplashProgress(0, projects.length);
    projects.forEach((project, idx) => buildCard(project, idx));
    return loadPreviews();
  })
  .catch((err) => {
    console.error('[main] init error:', err);
    splashStatus.textContent = 'Ошибка загрузки';
    hideSplash();
  })
  .finally(() => {
    clearTimeout(splashFailsafe);
  });

function buildCard(project, idx, { animate = true } = {}) {
  const card = document.createElement('div');
  card.className = 'work-card';
  card.dataset.id = project.id;
  if (project.hidden) card.classList.add('q-was-hidden');
  card.addEventListener('animationend', () => card.classList.remove('entering'));

  const thumb = document.createElement('div');
  thumb.className = 'work-thumb';

  const spinner = document.createElement('div');
  spinner.className = 'thumb-spinner';
  thumb.appendChild(spinner);

  const img = document.createElement('img');
  img.alt = project.title;
  img.style.display = 'none';
  img.onload = () => {
    spinner.style.display = 'none';
    img.style.display = 'block';
  };
  thumb.appendChild(img);

  cardImages.push({ img, spinner, card });

  const info = document.createElement('div');
  info.className = 'work-info';
  info.innerHTML = `
    <span class="work-title">${project.title}</span>
    <span class="work-year">${project.year}</span>
  `;

  card.appendChild(thumb);
  card.appendChild(info);
  card.addEventListener('click', () => {
    if (qSelectMode) {
      toggleQSelect(idx);
      return;
    }
    if (project.hidden) return;
    if (project.model) openModal(idx);
  });
  worksRow.appendChild(card);

  card.style.setProperty('--enter-delay', `${80 + idx * 40}ms`);
  if (animate && !project.hidden) card.classList.add('entering');
}

// ─── Пак превью (pic/pack.json) ───────────────────────────────────
// 1) Открой сайт — все превью прогрузятся (из пака или сгенерируются).
// 2) F12 → консоль → введи: pic
// 3) Скачается pack.json — положи его в папку pic/ проекта.
// 4) Добавил новые модели? Обнови страницу, снова введи pic, замени файл.
const PIC_PACK_URL = 'pic/pack.json';

async function loadPicPack() {
  try {
    const res = await fetch(PIC_PACK_URL, { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || typeof data.previews !== 'object') return null;
    return data.previews;
  } catch {
    return null;
  }
}

async function srcToDataURL(src) {
  if (!src) return null;
  if (src.startsWith('data:')) return src;
  try {
    const res = await fetch(src);
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const fr = new FileReader();
      fr.onload = () => resolve(fr.result);
      fr.onerror = reject;
      fr.readAsDataURL(blob);
    });
  } catch {
    return null;
  }
}

async function exportPicPack() {
  const previews = {};
  let ok = 0;
  let fail = 0;

  for (let i = 0; i < projects.length; i++) {
    const p = projects[i];
    if (!p.model) continue;
    const src = cardImages[i]?.img?.src || '';
    const dataURL = await srcToDataURL(src);
    if (!dataURL) {
      console.warn(`[pic] нет превью для ${p.id}`);
      fail++;
      continue;
    }
    previews[p.id] = dataURL;
    ok++;
  }

  if (!ok) {
    console.error('[pic] нечего скачивать — дождись окончания загрузки превью');
    return;
  }

  const pack = {
    generatedAt: new Date().toISOString(),
    count: ok,
    previews,
  };

  const blob = new Blob([JSON.stringify(pack)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pack.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);

  console.log(
    `[pic] готово: ${ok} превью` +
      (fail ? `, пропущено ${fail}` : '') +
      '. Положи pack.json в папку pic/ проекта.'
  );
}

// В консоли достаточно вписать: pic
Object.defineProperty(window, 'pic', {
  configurable: true,
  get() {
    void exportPicPack();
    return 'Скачиваю pack.json… потом положи его в папку pic/';
  },
});
window.exportPicPack = exportPicPack;

// ─── Скрытие моделей (q1 / q2) ────────────────────────────────────
// manifest1.json — сайт по умолчанию (только видимые).
// manifest2.json — полный список; q1 переключает галерею на него.
// Скрытые в q1 видны все, с пунктирной обводкой.
// q2 — скачивает оба файла. Отмена: Esc / q0.
let qSelectMode = false;
const qSelected = new Set();
let qBackup = null; // { projects, previewById }
let qEnterLock = false;

function findNeighborIdx(from, dir) {
  let i = from + dir;
  while (i >= 0 && i < projects.length) {
    if (!projects[i].hidden) return i;
    i += dir;
  }
  return -1;
}

function capturePreviewById() {
  const map = {};
  projects.forEach((p, i) => {
    const src = cardImages[i]?.img?.src || '';
    if (src) map[p.id] = src;
  });
  return map;
}

function downloadJSONFile(filename, data) {
  const blob = new Blob([JSON.stringify(data, null, 2) + '\n'], {
    type: 'application/json',
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

/** Пересобрать галерею из списка проектов */
async function rebuildGallery(nextProjects, { editMode = false, previewById = {}, animate = false } = {}) {
  if (worksRow) worksRow.innerHTML = '';
  cardImages.length = 0;
  projects = nextProjects;

  projects.forEach((p, i) => {
    buildCard(p, i, { animate });
    const card = cardImages[i]?.card;
    if (editMode && p.hidden) card?.classList.add('q-was-hidden');
    else card?.classList.remove('q-was-hidden');

    const cached = previewById[p.id];
    if (cached) {
      cardImages[i].img.src = cached;
      cardImages[i].spinner.style.display = 'none';
      cardImages[i].img.style.display = 'block';
    }
  });

  // Догрузить превью тем, у кого ещё нет картинки
  const packMap = (await loadPicPack()) || {};
  const needGenerate = [];
  for (let i = 0; i < projects.length; i++) {
    if (cardImages[i]?.img?.src) continue;
    const packed = packMap[projects[i].id];
    if (packed) {
      cardImages[i].img.src = packed;
      continue;
    }
    if (projects[i].preview) {
      cardImages[i].img.src = projects[i].preview;
      continue;
    }
    if (projects[i].model) needGenerate.push(i);
    else cardImages[i].spinner.style.display = 'none';
  }

  if (needGenerate.length) {
    const CONCURRENCY = 2;
    let cursor = 0;
    const worker = async () => {
      while (cursor < needGenerate.length) {
        const i = needGenerate[cursor++];
        try {
          const dataURL = await generatePreview(projects[i]);
          cardImages[i].img.src = dataURL;
        } catch (err) {
          console.warn(`[q] preview failed for ${projects[i].id}:`, err);
          cardImages[i].spinner.style.display = 'none';
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    releaseSharedViewer();
  }
}

function projectsToManifest2() {
  return projects.map((p) => {
    const entry = {
      id: p.id,
      title: p.id,
      year: p.year,
      client: p.client,
      purpose: p.purpose,
      obj: p.model?.obj,
    };
    if (p.model?.mtl) entry.mtl = p.model.mtl;
    if (p.model?.textures) entry.textures = p.model.textures;
    if (p.preview) {
      const name = p.preview.split('/').pop();
      if (name) entry.preview = name;
    }
    if (p.hidden) entry.hidden = true;
    return entry;
  });
}

async function enterQSelectMode() {
  if (qSelectMode || qEnterLock) {
    return 'Уже в режиме выбора. q2 — подтвердить, Esc/q0 — отмена';
  }
  qEnterLock = true;

  try {
    const all = await discoverAllProjects();
    if (!all || !all.length) {
      console.error('[q1] не удалось загрузить models/manifest2.json');
      return 'Нет manifest2.json — запусти start.bat';
    }

    qBackup = {
      projects: projects.slice(),
      previewById: capturePreviewById(),
    };
    qSelectMode = true;
    qSelected.clear();
    document.body.classList.add('q-select-mode');

    const previewById = { ...qBackup.previewById };
    const hiddenCount = all.filter((p) => p.hidden).length;

    // Скрытые — в начало, чтобы сразу были видны
    const sorted = [
      ...all.filter((p) => p.hidden),
      ...all.filter((p) => !p.hidden),
    ];

    await rebuildGallery(sorted, { editMode: true, previewById, animate: false });

    unlockScroll();
    galleryEl?.scrollIntoView({ behavior: 'smooth', block: 'start' });

    console.log(
      `[q1] manifest2: все ${all.length} карточек (скрытых с пунктиром: ${hiddenCount}). ` +
        'Кликай → q2. Отмена: Esc / q0'
    );
    return `manifest2: ${all.length} карточек, скрытых ${hiddenCount}`;
  } finally {
    qEnterLock = false;
  }
}

async function exitQSelectMode() {
  const was = qSelectMode;
  qSelectMode = false;
  qSelected.clear();
  document.body.classList.remove('q-select-mode');

  if (!was) return;

  if (qBackup) {
    const visible = qBackup.projects.filter((p) => !p.hidden);
    // Перенумеровать на случай если бэкап уже с title
    let n = 0;
    const restored = visible.map((p) => {
      n += 1;
      return { ...p, hidden: false, title: `Model ${n}` };
    });
    await rebuildGallery(restored, {
      editMode: false,
      previewById: qBackup.previewById,
      animate: false,
    });
    qBackup = null;
  }
}

function toggleQSelect(idx) {
  const p = projects[idx];
  if (!p) return;
  const card = cardImages[idx]?.card;
  if (qSelected.has(p.id)) {
    qSelected.delete(p.id);
    card?.classList.remove('q-selected');
  } else {
    qSelected.add(p.id);
    card?.classList.add('q-selected');
  }
  const action = p.hidden ? 'показать' : 'скрыть';
  console.log(`[q1] ${p.id} → будет ${action} (выбрано: ${qSelected.size})`);
}

async function confirmQSelect() {
  if (!qSelectMode) {
    console.warn('[q2] сначала введи q1');
    return 'Сначала введи q1';
  }
  if (!qSelected.size) {
    console.warn('[q2] ничего не выбрано');
    await exitQSelectMode();
    return 'Ничего не выбрано — режим сброшен';
  }

  // Берём актуальный manifest2 с диска, чтобы не потерять поля
  let manifest2 = await fetchJSON(MANIFEST2_URL);
  if (!Array.isArray(manifest2)) {
    console.warn('[q2] manifest2 недоступен — собираю из карточек');
    manifest2 = projectsToManifest2();
  }

  let hideCount = 0;
  let showCount = 0;
  const selected = new Set(qSelected);

  for (const item of manifest2) {
    if (!selected.has(item.id)) continue;
    if (item.hidden === true) {
      delete item.hidden;
      showCount++;
    } else {
      item.hidden = true;
      hideCount++;
    }
  }

  // Синхронизируем in-memory projects
  for (const p of projects) {
    if (!selected.has(p.id)) continue;
    p.hidden = !p.hidden;
  }

  const manifest1 = manifest2
    .filter((item) => item.hidden !== true)
    .map((item) => {
      const clean = { ...item };
      delete clean.hidden;
      return clean;
    });

  downloadJSONFile('manifest2.json', manifest2);
  setTimeout(() => downloadJSONFile('manifest1.json', manifest1), 350);

  // Выходим в обычный вид по новому состоянию
  qBackup = null;
  qSelectMode = false;
  qSelected.clear();
  document.body.classList.remove('q-select-mode');

  const visibleProjects = applyAutoTitles(
    buildFromManifest(manifest1)
  );
  const previewById = capturePreviewById();
  await rebuildGallery(visibleProjects, { editMode: false, previewById, animate: false });

  console.log(
    `[q2] готово: скрыто ${hideCount}, показано ${showCount}. ` +
      'Положи manifest1.json и manifest2.json в папку models/'
  );
  return `Скачиваю manifest1 + manifest2… скрыто ${hideCount}, показано ${showCount}`;
}

Object.defineProperty(window, 'q1', {
  configurable: true,
  get() {
    void enterQSelectMode();
    return 'Загружаю manifest2…';
  },
});

Object.defineProperty(window, 'q2', {
  configurable: true,
  get() {
    void confirmQSelect();
    return 'Применяю выбор…';
  },
});

Object.defineProperty(window, 'q0', {
  configurable: true,
  get() {
    if (!qSelectMode) return 'Режим выбора не активен';
    void exitQSelectMode();
    console.log('[q0] режим выбора отменён');
    return 'Режим выбора отменён';
  },
});

async function loadPreviews() {
  // Внутренний фейлсейф: если генерация превью зависла — скрываем сплэш всё равно.
  const previewFailsafe = setTimeout(() => {
    if (!splashEl.classList.contains('hidden')) {
      splashStatus.textContent = 'Превью грузятся слишком долго…';
      hideSplash();
    }
  }, 25000);

  let loaded = 0;
  const total = projects.length;
  const packMap = (await loadPicPack()) || {};
  const packIds = Object.keys(packMap);
  if (packIds.length) {
    console.log(`[pic] загружен пак: ${packIds.length} превью`);
  }

  // Приоритет: pic/pack.json → preview.* в папке модели → генерация WebGL
  const needGenerate = [];
  let fromPack = 0;
  for (let i = 0; i < total; i++) {
    if (!projects[i].model) {
      cardImages[i].spinner.style.display = 'none';
      loaded++;
      setSplashProgress(loaded, total);
      continue;
    }

    const packed = packMap[projects[i].id];
    if (packed) {
      cardImages[i].img.src = packed;
      fromPack++;
      loaded++;
      setSplashProgress(loaded, total);
      continue;
    }

    if (projects[i].preview) {
      cardImages[i].img.src = projects[i].preview;
      loaded++;
      setSplashProgress(loaded, total);
      continue;
    }

    needGenerate.push(i);
  }

  // Остальное генерим в браузере. Параллельно по 2.
  const CONCURRENCY = 2;
  let cursor = 0;
  const worker = async () => {
    while (cursor < needGenerate.length) {
      const i = needGenerate[cursor++];
      try {
        const dataURL = await generatePreview(projects[i]);
        cardImages[i].img.src = dataURL;
      } catch (err) {
        console.warn(`[preview] failed for ${projects[i].id}:`, err);
        cardImages[i].spinner.style.display = 'none';
      }
      loaded++;
      setSplashProgress(loaded, total);
    }
  };
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  releaseSharedViewer();
  hideSplash();

  clearTimeout(previewFailsafe);

  const modelCount = projects.filter((p) => p.model).length;
  if (needGenerate.length > 0 || fromPack < modelCount) {
    const missing = modelCount - fromPack;
    if (missing > 0) {
      console.info(
        `[pic] ${missing} моделей нет в паке (или пак устарел). ` +
          'Введи pic в консоли → скачается pack.json → положи в папку pic/'
      );
    }
  } else if (fromPack > 0) {
    console.log(`[pic] все ${fromPack} превью из пака. Обновить пак: введи pic`);
  } else {
    console.info('[pic] пак ещё не создан. Введи pic в консоли после загрузки.');
  }
}

// ─── Вьюер ────────────────────────────────────────────────────────
let viewer = null;
let currentIdx = -1;

const modal      = document.getElementById('modal');
const loaderEl   = document.getElementById('loader');
const loaderText = document.getElementById('loader-text');
const canvas     = document.getElementById('viewer-canvas');

function ensureViewer() {
  // alpha:true → canvas прозрачный, фон берётся из CSS .canvas-wrap (зависит от темы)
  if (!viewer) viewer = new Viewer(canvas, { interactive: true, alpha: true });
}

// ─── Открыть модалку ──────────────────────────────────────────────
async function openModal(idx) {
  const project = projects[idx];
  if (!project || project.hidden) return;
  const isSwap = modal.classList.contains('open'); // уже открыта — значит это переключение
  const modalBox = modal.querySelector('.modal-box');
  currentIdx = idx;

  // Плавная подмена контента при переходе пред/след
  if (isSwap) modalBox.classList.add('swapping');

  document.getElementById('modal-title').textContent   = project.title;
  document.getElementById('modal-year').textContent    = project.year;
  document.getElementById('modal-client').textContent  = project.client;
  document.getElementById('modal-purpose').textContent = project.purpose;

  // Статы модели — фоном, с typewriter-эффектом при появлении
  const statsEl = document.getElementById('viewer-stats');
  statsEl.textContent = '';
  getModelStats(project.model).then((s) => {
    const html = `<b>${formatNumber(s.triangles)}</b> трис · <b>${formatNumber(s.polygons)}</b> поли · <b>${formatNumber(s.vertices)}</b> верш.`;
    typewriterHTML(statsEl, html, 18, isSwap ? 0 : 380);
  }).catch(() => { statsEl.textContent = '—'; });

  // Кнопки-свотчи расцветок
  buildVariantSwatches(project);

  const prevBtn = document.getElementById('modal-prev');
  const nextBtn = document.getElementById('modal-next');
  prevBtn.classList.toggle('hidden', findNeighborIdx(idx, -1) < 0);
  nextBtn.classList.toggle('hidden', findNeighborIdx(idx, 1) < 0);

  modal.classList.add('open');
  modal.removeAttribute('aria-hidden');

  loaderEl.classList.remove('hidden');
  loaderText.textContent = 'Загрузка...';

  ensureViewer();

  // Сброс режима
  document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
  document.querySelector('.mode-btn[data-mode="material"]').classList.add('active');
  viewer.mode = 'material';

  // Кнопки каналов — disable пока модель не загружена
  setChannelButtonsState(project.model, false);

  // Сброс освещения при открытии новой модели
  if (viewer) viewer.setLightIntensity(1);

  try {
    await viewer.load(project.model, (p) => {
      loaderText.textContent = `Загрузка... ${Math.round(p * 100)}%`;
    });
    loaderEl.classList.add('hidden');
    // Активируем кнопки каналов в зависимости от наличия текстур
    setChannelButtonsState(project.model, true);
  } catch (err) {
    loaderText.textContent = 'Ошибка загрузки';
    console.error('[main] load error:', err);
  } finally {
    // Снимаем класс с небольшой задержкой — чтобы fade-in совпал по фазе с появлением модели
    if (isSwap) {
      requestAnimationFrame(() => modalBox.classList.remove('swapping'));
    }
  }
}

// ─── Активация/блокировка кнопок каналов ──────────────────────────
function setChannelButtonsState(modelConfig, loaded) {
  const tex = modelConfig?.textures || {};
  const hasDiffuse = !!(tex.maps?.length || tex.map);
  const hasNormal  = !!tex.normalMap;
  const hasSpec    = !!(tex.specMap || tex.roughnessMap);
  // UV-checker генерируется всегда
  const hasUV      = true;

  const rules = { diffuse: hasDiffuse, normal: hasNormal, spec: hasSpec };

  document.querySelectorAll('.channel-btn').forEach((btn) => {
    const mode = btn.dataset.mode;
    const available = loaded && (rules[mode] ?? true);
    btn.disabled = !available;
    btn.title = available ? '' : (loaded ? 'Карта не доступна для этой модели' : 'Загрузка...');
  });
}

// ─── Лайтбокс текстуры ────────────────────────────────────────────
const texLightbox = document.getElementById('tex-lightbox');
const texLbCanvas = document.getElementById('tex-lb-canvas');
const texLbWrap   = document.getElementById('tex-lb-img-wrap');
const texLbInfo   = document.getElementById('tex-lb-info');
const texLbChan   = document.getElementById('tex-lb-channel');

const CHANNEL_LABELS = {
  diffuse: 'Diffuse',
  normal:  'Normal Map',
  spec:    'Spec / Roughness',
};

// Очистка canvas
function clearTexCanvas() {
  const ctx = texLbCanvas.getContext('2d');
  ctx.clearRect(0, 0, texLbCanvas.width, texLbCanvas.height);
  texLbCanvas.width = 0;
  texLbCanvas.height = 0;
}

function openTexLightbox(mode) {
  if (!viewer || !projects[currentIdx]) return;

  const model = projects[currentIdx].model;
  const tex   = model?.textures || {};
  const v     = model?.version ? `?v=${model.version}` : '';

  let src = null;

  if (mode === 'diffuse') {
    const maps = tex.maps || (tex.map ? [tex.map] : []);
    const file = maps[viewer.currentVariant] || maps[0];
    if (file) src = model.path + file + v;
  } else if (mode === 'normal' && tex.normalMap) {
    src = model.path + tex.normalMap + v;
  } else if (mode === 'spec') {
    const file = tex.specMap || tex.roughnessMap;
    if (file) src = model.path + file + v;
  }

  if (!src) return;

  texLbChan.textContent = CHANNEL_LABELS[mode] || mode;
  texLbInfo.textContent = '—';
  clearTexCanvas();

  // Грузим картинку в Image и тут же рисуем в canvas — никакого src в DOM,
  // правый клик «Сохранить» вернёт только canvas-снимок (без оригинального файла).
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    texLbInfo.textContent = `${img.naturalWidth} × ${img.naturalHeight} px`;
    texLbCanvas.width  = img.naturalWidth;
    texLbCanvas.height = img.naturalHeight;
    const ctx = texLbCanvas.getContext('2d');
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(img, 0, 0);
  };
  img.onerror = () => { texLbInfo.textContent = 'Ошибка загрузки'; };
  img.src = src;

  texLightbox.classList.add('open');
  texLightbox.removeAttribute('aria-hidden');
}

function closeTexLightbox() {
  texLightbox.classList.remove('open');
  texLightbox.setAttribute('aria-hidden', 'true');
  clearTexCanvas();
}

document.getElementById('tex-lb-close').addEventListener('click', closeTexLightbox);
texLightbox.addEventListener('click', (e) => { if (e.target === texLightbox) closeTexLightbox(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && texLightbox.classList.contains('open')) closeTexLightbox();
  // Блокируем Ctrl+S / Cmd+S пока открыт лайтбокс
  if (texLightbox.classList.contains('open') && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
    e.preventDefault();
  }
});

// Защита от скачивания: блокируем правый клик и drag внутри лайтбокса
['contextmenu', 'dragstart', 'selectstart'].forEach((evt) => {
  texLightbox.addEventListener(evt, (e) => e.preventDefault());
});

// ─── Свотчи расцветок ─────────────────────────────────────────────
async function buildVariantSwatches(project) {
  const row  = document.getElementById('modal-variants-row');
  const list = document.getElementById('modal-variants');
  list.innerHTML = '';

  const maps = project.model?.textures?.maps || [];
  if (maps.length < 2) {
    row.classList.add('hidden');
    return;
  }
  row.classList.remove('hidden');

  const v = project.model.version ? `?v=${project.model.version}` : '';

  // Сначала рисуем кружки-плейсхолдеры (серые), потом подкрашиваем
  const buttons = maps.map((file, i) => {
    const btn = document.createElement('button');
    btn.className = 'swatch';
    if (i === 0) btn.classList.add('active');
    btn.title = file;
    btn.style.background = '#444';
    btn.addEventListener('click', () => {
      if (!viewer) return;
      list.querySelectorAll('.swatch').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      // В режимах каналов без цвета (normal/spec/uv/wireframe) — переключаем на diffuse
      const channelOnlyModes = ['normal', 'spec', 'uv', 'wireframe'];
      if (channelOnlyModes.includes(viewer.mode)) {
        document.querySelectorAll('.mode-btn').forEach((b) => b.classList.remove('active'));
        document.querySelector('.mode-btn[data-mode="diffuse"]').classList.add('active');
        viewer.mode = 'diffuse';
      }
      viewer.setVariant(i);
    });
    list.appendChild(btn);
    return btn;
  });

  // Анимация появления: первый «надувается», остальные выкатываются из-под него
  // Шаг = 24px (ширина) + 8px (gap) = 32px на один кружок
  const STEP = 32; // px
  const BASE_DELAY = 100; // мс между кружками

  buttons.forEach((btn, i) => {
    if (i === 0) {
      btn.style.animationDelay = '0ms';
      btn.classList.add('anim-first');
    } else {
      // CSS-переменная: смещение назад к позиции первого кружка
      btn.style.setProperty('--sw-offset', `${-(i * STEP)}px`);
      btn.style.animationDelay = `${i * BASE_DELAY}ms`;
      btn.classList.add('anim-roll');
    }
  });

  // Подгружаем доминантные цвета для каждого варианта параллельно
  maps.forEach((file, i) => {
    getDominantColor(project.model.path + file + v).then((color) => {
      buttons[i].style.background = color;
    });
  });
}

// ─── Закрыть ──────────────────────────────────────────────────────
function closeModal() {
  modal.classList.remove('open');
  modal.setAttribute('aria-hidden', 'true');
}

document.getElementById('modal-close').addEventListener('click', closeModal);

modal.addEventListener('click', (e) => {
  if (e.target === modal) closeModal();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    if (qSelectMode) {
      void exitQSelectMode();
      console.log('[q1] режим выбора отменён (Esc)');
      return;
    }
    closeModal();
  }
  if (!modal.classList.contains('open')) return;
  if (e.key === 'ArrowLeft') {
    const prev = findNeighborIdx(currentIdx, -1);
    if (prev >= 0) openModal(prev);
  }
  if (e.key === 'ArrowRight') {
    const next = findNeighborIdx(currentIdx, 1);
    if (next >= 0) openModal(next);
  }
});

document.getElementById('modal-prev').addEventListener('click', () => {
  const prev = findNeighborIdx(currentIdx, -1);
  if (prev >= 0) openModal(prev);
});

document.getElementById('modal-next').addEventListener('click', () => {
  const next = findNeighborIdx(currentIdx, 1);
  if (next >= 0) openModal(next);
});

// ─── Режимы ───────────────────────────────────────────────────────
const CHANNEL_MODES = new Set(['diffuse', 'normal', 'spec']);

document.querySelectorAll('.mode-btn:not(.channel-btn):not(.light-btn)').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.mode-btn:not(.channel-btn):not(.light-btn)').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    if (viewer) viewer.setMode(btn.dataset.mode);
  });
});

// Кнопки каналов — только лайтбокс, модель не трогаем
document.querySelectorAll('.channel-btn').forEach((btn) => {
  btn.addEventListener('click', () => {
    if (CHANNEL_MODES.has(btn.dataset.mode)) openTexLightbox(btn.dataset.mode);
  });
});

