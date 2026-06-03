const DB_URL = './catalogo-siga.db.gz';
const PAGE_SIZE = 100;
const MAX_RESULTS = 5000;

let db = null;
let currentFilter = 'all';
let currentQuery = '';
let currentPage = 1;
let totalMatches = 0;
let currentResults = [];
let searchTimer = null;
let normalizedQueryCache = '';
const SEARCH_HISTORY_KEY = 'siga_search_history';
const MAX_HISTORY = 8;

const $ = id => document.getElementById(id);

let isDbReady = false;
const isDebug = new URLSearchParams(location.search).has('debug');

function ensureDbReady() {
  if (!db || !isDbReady) {
    throw new Error('La base de datos aún no está lista. Por favor espera unos segundos.');
  }
}

function handleError(err, context = '') {
  console.error(`[Buscador SIGA] Error${context ? ' en ' + context : ''}:`, err);

  // Mostrar mensaje amigable al usuario
  const msg = err.message || 'Ocurrió un error inesperado';
  showToast(msg.length > 60 ? msg.substring(0, 57) + '...' : msg);
}

async function initializeDatabase(SQL) {
  const remoteVersion = new Date().toISOString().split('T')[0];
  let cached = null;

  try {
    cached = await window.loadDatabaseFromIndexedDB();
  } catch (e) {
    console.warn('[Buscador SIGA] Error leyendo caché IndexedDB:', e);
  }

  // Caso 1: Caché válida del día actual
  if (cached && cached.data && cached.version === remoteVersion) {
    $('progressText').textContent = 'Cargando desde caché local...';
    const database = new SQL.Database(new Uint8Array(cached.data));

      const badge = $('lastUpdateBadge');
      if (badge && cached.version) {
        const d = new Date(cached.version);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        let text = '';
        if (d.toDateString() === today.toDateString()) {
          text = 'Actualizado hoy';
          badge.innerHTML = `<span class="live-dot"></span>${text}`;
          badge.classList.add('live');
        } else if (d.toDateString() === yesterday.toDateString()) {
          text = 'Actualizado ayer';
          badge.innerHTML = text;
          badge.classList.remove('live');
        } else {
          const day = d.getDate();
          const month = d.toLocaleDateString('es-PE', { month: 'short' });
          text = `Actualizado el ${day} ${month}`;
          badge.innerHTML = text;
          badge.classList.remove('live');
        }
      }

    console.log('[Buscador SIGA] DB cargada desde IndexedDB (versión actual)');
    return { database, version: cached.version };
  }

  // Caso 2: Caché antigua → limpiar y descargar
  if (cached && cached.data) {
    console.log('[Buscador SIGA] Versión antigua detectada, actualizando...');
    $('progressText').textContent = 'Actualizando base de datos...';
    try {
      if (typeof window.clearDatabaseCache === 'function') {
        await window.clearDatabaseCache();
      }
    } catch (e) {
      console.warn('[Buscador SIGA] Error limpiando caché:', e);
    }
  }

  // Caso 3: Descargar desde red (nuevo o después de limpiar)
  $('progressText').textContent = 'Descargando base de datos...';

  // Fetch with retry (exponential backoff)
  let response;
  let lastError;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      response = await fetch(DB_URL);
      if (response.ok) break;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (e) {
      lastError = e;
    }
    if (attempt < 3) {
      const wait = 1000 * Math.pow(2, attempt - 1); // 1s, 2s, 4s
      $('progressText').textContent = `Reintentando en ${wait / 1000}s... (intento ${attempt + 1}/3)`;
      await new Promise(r => setTimeout(r, wait));
    }
  }

  if (!response || !response.ok) {
    throw lastError || new Error('No se pudo descargar la base de datos después de varios intentos');
  }

  const total = parseInt(response.headers.get('content-length') || '0');
  const reader = response.body.getReader();
  const chunks = [];
  let received = 0;

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    if (total) {
      const pct = (received / total) * 100;
      $('progressFill').style.width = pct + '%';
      $('progressText').textContent =
        `${(received / 1024 / 1024).toFixed(1)} / ${(total / 1024 / 1024).toFixed(1)} MB`;
    }
  }

  const compressed = new Uint8Array(received);
  let pos = 0;
  for (const c of chunks) {
    compressed.set(c, pos);
    pos += c.length;
  }

  $('progressText').textContent = 'Descomprimiendo...';
  const decompressed = await new Response(
    new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))
  ).arrayBuffer();

  await window.saveDatabaseToIndexedDB(decompressed, remoteVersion);

  $('progressText').textContent = 'Abriendo base de datos...';
  const database = new SQL.Database(new Uint8Array(decompressed));

      const badge = $('lastUpdateBadge');
      if (badge) {
        const d = new Date(remoteVersion);
        const today = new Date();
        const yesterday = new Date(today);
        yesterday.setDate(yesterday.getDate() - 1);

        let text = '';
        if (d.toDateString() === today.toDateString()) {
          text = 'Actualizado hoy';
          badge.innerHTML = `<span class="live-dot"></span>${text}`;
          badge.classList.add('live');
        } else if (d.toDateString() === yesterday.toDateString()) {
          text = 'Actualizado ayer';
          badge.innerHTML = text;
          badge.classList.remove('live');
        } else {
          const day = d.getDate();
          const month = d.toLocaleDateString('es-PE', { month: 'short' });
          text = `Actualizado el ${day} ${month}`;
          badge.innerHTML = text;
          badge.classList.remove('live');
        }
      }

  return { database, version: remoteVersion };
}

async function init() {
  try {
    $('progressText').textContent = 'Inicializando motor SQLite...';
    const SQL = await initSqlJs({
      locateFile: f => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.10.3/${f}`
    });

    const { database } = await initializeDatabase(SQL);
    db = database;
    isDbReady = true;
    window.isDbReady = true;

    const count = db.exec("SELECT COUNT(*) FROM items")[0].values[0][0];
    $('liveBadge').textContent = count.toLocaleString('es-PE') + ' ítems';

    console.log(`[Buscador SIGA] DB cargada: ${count.toLocaleString()} ítems`);

    if (isDebug) {
      console.log('%c[DEBUG] Modo debug activado', 'color:#ffd43b');
      console.log('  - Versión:', remoteVersion || 'desconocida');
      console.log('  - Ítems:', count);
      console.log('  - DB lista:', isDbReady);
    }

    if (count === 0) throw new Error('Base de datos vacía');

    $('loader').classList.add('hidden');
    $('searchInput').disabled = false;
    $('searchInput').focus();
  } catch (err) {
    $('progressText').innerHTML = `
      Error: ${err.message}<br>
      <button id="retryBtn" style="margin-top:16px;padding:8px 16px;border:1px solid #fff;border-radius:6px;background:transparent;color:#fff;cursor:pointer;">
        Reintentar
      </button>
    `;
    console.error('[Buscador SIGA] Error crítico en init:', err);

    setTimeout(() => {
      const retry = $('retryBtn');
      if (retry) retry.onclick = () => location.reload();
    }, 100);
  }
}

function rowHtml(r) {
  const tipoLabel = r.tipo === 'B' ? 'BIEN' : r.tipo === 'S' ? 'SERV' : 'OBRA';
  return `
    <li class="result-row" data-codigo="${r.codigo}" role="listitem" tabindex="-1">
      <div>
        <button class="code-btn" data-action="copy" data-code="${r.codigo}">${r.codigo}</button>
      </div>
      <div class="name">
        ${highlight(r.nombre_item, currentQuery)}
        <span class="family">${escapeHtml(r.nombre_familia)}</span>
      </div>
      <div><span class="type-tag type-${r.tipo}">${tipoLabel}</span></div>
      <div class="unit">${escapeHtml(r.unidad)}</div>
      <div class="date">${escapeHtml(r.fecha)}</div>
    </li>`;
}

function render() {
  try {
    ensureDbReady();
  } catch (e) {
    handleError(e, 'render');
    return;
  }

  const list = $('resultsList');
  $('loadMoreContainer').innerHTML = '';

  if (!currentQuery.trim()) {
    list.innerHTML = `<li class="welcome"><svg class="icon icon-lg empty-icon-svg"><use href="#i-search"/></svg><div>Escribe algo arriba para empezar a buscar</div></li>`;
    $('perfDisplay').innerHTML = '';
    $('btnExportCsv').disabled = true;
    $('btnExportXlsx').disabled = true;
    selectedIndex = -1;
    return;
  }

  let result = searchWithCount(db, currentQuery, currentFilter, 1);
  let totalMs = result.ms;
  totalMatches = result.total;

  // Fallback to fuzzy search if results are too few
  if ((totalMatches < 8 || totalMatches === 0) && currentQuery.length > 2) {
    const fuzzyResult = fuzzySearch(db, currentQuery, currentFilter, 80);
    if (fuzzyResult.rows.length > 0) {
      result = { rows: fuzzyResult.rows, total: fuzzyResult.rows.length, ms: fuzzyResult.ms };
      totalMatches = result.total;
      totalMs = result.ms;
    }
  }

  if (result.error) {
    list.innerHTML = `<div class="empty"><svg class="icon icon-lg empty-icon-svg" style="color:var(--red);opacity:0.7"><use href="#i-alert"/></svg><div>Error: <code style="color:var(--red)">${result.error}</code></div></div>`;
    $('perfDisplay').innerHTML = '';
    return;
  }

  currentResults = result.rows;
  currentPage = 1;
  selectedIndex = -1; // reset keyboard selection

  $('perfDisplay').innerHTML = `<strong>${totalMatches.toLocaleString('es-PE')}</strong> resultados · ${totalMs.toFixed(0)}ms`;
  $('btnExportCsv').disabled = totalMatches === 0;
  $('btnExportXlsx').disabled = totalMatches === 0;

  // Announce to screen readers
  const status = $('resultsStatus');
  if (status) {
    status.textContent = totalMatches > 0
      ? `${totalMatches.toLocaleString('es-PE')} resultados para "${currentQuery}"`
      : `Sin resultados para "${currentQuery}"`;
  }

  if (currentResults.length === 0) {
    list.innerHTML = `<li class="empty"><svg class="icon icon-lg empty-icon-svg"><use href="#i-empty"/></svg><div>Sin resultados para "<strong>${escapeHtml(currentQuery)}</strong>"</div></li>`;
    return;
  }

  list.innerHTML = currentResults.map(rowHtml).join('');
  renderLoadMore();
}

function renderLoadMore() {
  const loadMore = $('loadMoreContainer');
  const loaded = currentResults.length;
  if (loaded >= totalMatches || loaded >= MAX_RESULTS) {
    if (loaded < totalMatches) {
      loadMore.innerHTML = `<div class="load-more"><div class="info">Mostrando ${loaded.toLocaleString('es-PE')} de ${totalMatches.toLocaleString('es-PE')} · Refina la búsqueda o exporta a Excel para verlos todos</div></div>`;
    }
    return;
  }
  loadMore.innerHTML = `
    <div class="load-more">
      <button id="btnLoadMore">Cargar más resultados</button>
      <div class="info">Mostrando ${loaded.toLocaleString('es-PE')} de ${totalMatches.toLocaleString('es-PE')}</div>
    </div>`;
  $('btnLoadMore').addEventListener('click', loadMore);
}

function loadMore() {
  if (!db || !currentQuery) return;

  currentPage++;
  const result = searchWithCount(db, currentQuery, currentFilter, currentPage);
  if (result.rows.length > 0) {
    currentResults = currentResults.concat(result.rows);
    $('resultsList').insertAdjacentHTML('beforeend', result.rows.map(rowHtml).join(''));
    renderLoadMore();
  }
}

function showDetail(codigo) {
  try {
    ensureDbReady();
  } catch (e) {
    handleError(e, 'showDetail');
    return;
  }

  const stmt = db.prepare("SELECT * FROM items WHERE codigo = ?");
  stmt.bind([codigo]);
  stmt.step();
  const r = stmt.getAsObject();
  stmt.free();

  const tipoLabel = r.tipo === 'B' ? 'BIEN' : r.tipo === 'S' ? 'SERVICIO' : 'OBRA';
  const parts = r.codigo.split('.');
  const [grupo, clase, familia, item] = parts;

  $('detailCode').textContent = r.codigo;
  $('detailCode').onclick = () => copyCode(r.codigo);
  $('detailTitle').textContent = r.nombre_item;
  $('detailTags').innerHTML = `
    <span class="type-tag type-${r.tipo}">${tipoLabel}</span>
    <span class="type-tag" style="background:var(--surface-2);color:var(--text-dim)">${escapeHtml(r.unidad)}</span>
  `;

  $('detailBody').innerHTML = `
    <div class="detail-field">
      <div class="detail-label">Jerarquía del catálogo</div>
      <div class="detail-hierarchy">
        <div class="hierarchy-item">
          <span><span class="code-part">${grupo}</span> Grupo</span>
          <span class="name-part">${escapeHtml(r.nombre_grupo)}</span>
        </div>
        <div class="hierarchy-item">
          <span><span class="code-part">${clase}</span> Clase</span>
          <span class="name-part">${escapeHtml(r.nombre_clase)}</span>
        </div>
        <div class="hierarchy-item">
          <span><span class="code-part">${familia}</span> Familia</span>
          <span class="name-part">${escapeHtml(r.nombre_familia)}</span>
        </div>
        <div class="hierarchy-item">
          <span><span class="code-part">${item}</span> Ítem</span>
          <span class="name-part">${escapeHtml(r.nombre_item)}</span>
        </div>
      </div>
    </div>

    <div class="detail-field">
      <div class="detail-label">Unidad de medida</div>
      <div class="detail-value">${escapeHtml(r.unidad)}</div>
    </div>

    <div class="detail-field">
      <div class="detail-label">Fecha de alta</div>
      <div class="detail-value">${escapeHtml(r.fecha)}</div>
    </div>

    <div class="detail-field">
      <div class="detail-label">Código sin puntos</div>
      <div class="detail-value mono">${r.codigo.replace(/\./g, '')}</div>
    </div>

    <div class="detail-field">
      <div class="detail-label">Acciones</div>
      <div style="display:flex;gap:8px;flex-wrap:wrap">
        <button class="btn-export" id="detailCopyCode">
          <svg class="icon"><use href="#i-copy"/></svg>
          Copiar código
        </button>
        <button class="btn-export" id="detailCopyName">
          <svg class="icon"><use href="#i-copy"/></svg>
          Copiar nombre
        </button>
      </div>
    </div>
  `;

  $('detailCopyCode').addEventListener('click', () => copyCode(r.codigo));
  $('detailCopyName').addEventListener('click', () => copyText(r.nombre_item));

  $('detailPanel').classList.add('show');
  $('detailOverlay').classList.add('show');
}

function closeDetail() {
  $('detailPanel').classList.remove('show');
  $('detailOverlay').classList.remove('show');
}

function fetchAllForExport() {
  const built = buildSearchSql(currentQuery, currentFilter);
  if (!built) return [];
  const sql = `SELECT codigo, nombre_item, tipo, unidad, nombre_familia, nombre_clase, nombre_grupo, fecha
               FROM items WHERE ${built.where} LIMIT ?`;
  const stmt = db.prepare(sql);
  stmt.bind([...built.params, MAX_RESULTS]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows;
}

function exportCsv() {
  try {
    ensureDbReady();
  } catch (e) {
    handleError(e, 'exportCsv');
    return;
  }

  const btn = $('btnExportCsv');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Generando...';

  const rows = fetchAllForExport();
  if (rows.length === 0) {
    btn.innerHTML = original;
    btn.disabled = false;
    return;
  }

  const headers = ['Codigo', 'Nombre', 'Tipo', 'Unidad', 'Familia', 'Clase', 'Grupo', 'Fecha'];
  const csvRows = [headers.join(',')];

  for (const r of rows) {
    const tipoLabel = r.tipo === 'B' ? 'Bien' : r.tipo === 'S' ? 'Servicio' : 'Obra';
    const csvRow = [
      r.codigo, r.nombre_item, tipoLabel, r.unidad,
      r.nombre_familia, r.nombre_clase, r.nombre_grupo, r.fecha
    ].map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(',');
    csvRows.push(csvRow);
  }

  const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8' });
  downloadBlob(blob, `catalogo-siga-${nowStamp()}.csv`);
  showToast(`Descargados ${rows.length} resultados en CSV`);

  btn.innerHTML = original;
  btn.disabled = false;
}

function exportXlsx() {
  try {
    ensureDbReady();
  } catch (e) {
    handleError(e, 'exportXlsx');
    return;
  }

  const btn = $('btnExportXlsx');
  const original = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = 'Generando...';

  const rows = fetchAllForExport();
  if (rows.length === 0) {
    btn.innerHTML = original;
    btn.disabled = false;
    return;
  }

  const data = rows.map(r => ({
    'Código': r.codigo,
    'Nombre': r.nombre_item,
    'Tipo': r.tipo === 'B' ? 'Bien' : r.tipo === 'S' ? 'Servicio' : 'Obra',
    'Unidad': r.unidad,
    'Familia': r.nombre_familia,
    'Clase': r.nombre_clase,
    'Grupo': r.nombre_grupo,
    'Fecha': r.fecha
  }));

  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [
    {wch: 18}, {wch: 60}, {wch: 10}, {wch: 12},
    {wch: 30}, {wch: 30}, {wch: 30}, {wch: 12}
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Catálogo SIGA');
  XLSX.writeFile(wb, `catalogo-siga-${nowStamp()}.xlsx`);
  showToast(`Descargados ${rows.length} resultados en Excel`);

  btn.innerHTML = original;
  btn.disabled = false;
}

function nowStamp() {
  const d = new Date();
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth()+1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function copyCode(code) {
  navigator.clipboard.writeText(code);
  showToast(`Copiado: ${code}`);
}

function copyText(text) {
  navigator.clipboard.writeText(text);
  showToast('Copiado al portapapeles');
}

function showToast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.remove('show'), 1800);
}

// Search History
function saveToHistory(query) {
  if (!query || query.length < 2) return;

  let history = [];
  try {
    history = JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  } catch {}

  // Remove duplicates
  history = history.filter(h => h !== query);
  history.unshift(query);

  if (history.length > MAX_HISTORY) history.pop();

  localStorage.setItem(SEARCH_HISTORY_KEY, JSON.stringify(history));
}

function getSearchHistory() {
  try {
    return JSON.parse(localStorage.getItem(SEARCH_HISTORY_KEY) || '[]');
  } catch {
    return [];
  }
}

// Command Palette
let commandPaletteOpen = false;
let selectedCommandIndex = 0;

const commands = [
  { label: 'Copiar código actual', action: () => {
    const code = $('detailCode')?.textContent;
    if (code && code !== '—') copyCode(code);
  }},
  { label: 'Exportar a CSV', action: () => $('btnExportCsv')?.click() },
  { label: 'Exportar a Excel', action: () => $('btnExportXlsx')?.click() },
  { label: 'Limpiar filtros', action: () => {
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    document.querySelector('[data-filter="all"]').classList.add('active');
    currentFilter = 'all';
    render();
  }},
  { label: 'Enfocar búsqueda', action: () => {
    $('searchInput').focus();
    $('searchInput').select();
  }},
  { label: 'Cerrar panel de detalle', action: () => closeDetail() },
];

function openCommandPalette() {
  commandPaletteOpen = true;
  selectedCommandIndex = 0;
  $('commandPalette').style.display = 'block';
  $('commandInput').value = '';
  $('commandInput').placeholder = 'Escribe un comando... (Esc para cerrar)';
  renderCommandResults();
  $('commandInput').focus();
}

function closeCommandPalette() {
  commandPaletteOpen = false;
  $('commandPalette').style.display = 'none';
}

function renderCommandResults(filter = '') {
  const container = $('commandResults');
  container.innerHTML = '';

  const filtered = commands.filter(cmd =>
    cmd.label.toLowerCase().includes(filter.toLowerCase())
  );

  if (filtered.length === 0) {
    container.innerHTML = `<div style="padding:12px;color:var(--text-dim)">No hay comandos</div>`;
    return;
  }

  filtered.forEach((cmd, index) => {
    const div = document.createElement('div');
    div.className = `command-item ${index === selectedCommandIndex ? 'selected' : ''}`;
    div.innerHTML = `<span>${cmd.label}</span>`;
    div.onclick = () => {
      closeCommandPalette();
      cmd.action();
    };
    container.appendChild(div);
  });
}

$('commandInput')?.addEventListener('input', (e) => {
  selectedCommandIndex = 0;
  renderCommandResults(e.target.value);
});

$('commandInput')?.addEventListener('keydown', (e) => {
  const items = $('commandResults').querySelectorAll('.command-item');
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    selectedCommandIndex = Math.min(selectedCommandIndex + 1, items.length - 1);
    renderCommandResults($('commandInput').value);
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault();
    selectedCommandIndex = Math.max(selectedCommandIndex - 1, 0);
    renderCommandResults($('commandInput').value);
  }
  if (e.key === 'Enter') {
    e.preventDefault();
    const filtered = commands.filter(cmd =>
      cmd.label.toLowerCase().includes($('commandInput').value.toLowerCase())
    );
    if (filtered[selectedCommandIndex]) {
      closeCommandPalette();
      filtered[selectedCommandIndex].action();
    }
  }
  if (e.key === 'Escape') {
    closeCommandPalette();
  }
});

// Close command palette when clicking outside
document.addEventListener('click', (e) => {
  if (commandPaletteOpen && !e.target.closest('#commandPalette')) {
    closeCommandPalette();
  }
});

// Global shortcut for command palette (Shift + Cmd/Ctrl + K)
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'k' && !commandPaletteOpen) {
    e.preventDefault();
    openCommandPalette();
  }
});

// Eventos
$('searchInput').addEventListener('input', e => {
  currentQuery = e.target.value;
  normalizedQueryCache = '';
  clearTimeout(searchTimer);
  searchTimer = setTimeout(render, 100);
});

// Save to history when user stops typing
$('searchInput').addEventListener('blur', () => {
  if (currentQuery && currentQuery.length > 2) {
    saveToHistory(currentQuery);
  }
});

document.querySelectorAll('.filter-chip').forEach(chip => {
  chip.addEventListener('click', () => {
    document.querySelectorAll('.filter-chip').forEach(c => {
      c.classList.remove('active');
      c.setAttribute('aria-pressed', 'false');
    });
    chip.classList.add('active');
    chip.setAttribute('aria-pressed', 'true');
    currentFilter = chip.dataset.filter;
    render();
  });
});

$('btnExportCsv').addEventListener('click', exportCsv);
$('btnExportXlsx').addEventListener('click', exportXlsx);
$('detailClose').addEventListener('click', closeDetail);
$('detailOverlay').addEventListener('click', closeDetail);

// Click en filas: mostrar detalle. Click en botón "código": copiar (no abre detalle).
$('resultsList').addEventListener('click', e => {
  const copyBtn = e.target.closest('[data-action="copy"]');
  if (copyBtn) {
    e.stopPropagation();
    copyCode(copyBtn.dataset.code);
    return;
  }
  const row = e.target.closest('.result-row');
  if (row && row.dataset.codigo) {
    // Update roving tabindex on click
    document.querySelectorAll('.result-row').forEach(r => {
      r.setAttribute('tabindex', '-1');
      r.classList.remove('selected');
    });
    row.setAttribute('tabindex', '0');
    row.classList.add('selected');
    selectedIndex = Array.from(document.querySelectorAll('.result-row')).indexOf(row);
    showDetail(row.dataset.codigo);
  }
});

// Keyboard navigation with roving tabindex
let selectedIndex = -1;

function updateSelection(newIndex) {
  const rows = document.querySelectorAll('.result-row');
  if (!rows.length) return;

  rows.forEach(r => {
    r.classList.remove('selected');
    r.setAttribute('tabindex', '-1');
  });

  selectedIndex = Math.max(0, Math.min(newIndex, rows.length - 1));
  const selectedRow = rows[selectedIndex];
  selectedRow.classList.add('selected');
  selectedRow.setAttribute('tabindex', '0');
  selectedRow.focus();
  selectedRow.scrollIntoView({ block: 'nearest' });
}

document.addEventListener('keydown', e => {
  const detailOpen = $('detailPanel').classList.contains('show');

  if ((e.ctrlKey || e.metaKey) && e.key === 'k') {
    e.preventDefault();
    $('searchInput').focus();
    $('searchInput').select();
    return;
  }

  if (e.key === 'Escape') {
    if (detailOpen) {
      closeDetail();
    } else if (document.activeElement === $('searchInput')) {
      $('searchInput').value = '';
      currentQuery = '';
      render();
    }
    return;
  }

  if (!detailOpen && currentResults.length > 0) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      updateSelection(selectedIndex + 1);
    }
    if (e.key === 'ArrowUp') {
      e.preventDefault();
      updateSelection(selectedIndex - 1);
    }
    if (e.key === 'Enter' && selectedIndex >= 0) {
      const rows = document.querySelectorAll('.result-row');
      if (rows[selectedIndex] && rows[selectedIndex].dataset.codigo) {
        showDetail(rows[selectedIndex].dataset.codigo);
      }
    }
  }

  // Allow clicking selected row with Space
  if (e.key === ' ' && !detailOpen && selectedIndex >= 0) {
    const rows = document.querySelectorAll('.result-row');
    if (rows[selectedIndex]) {
      e.preventDefault();
      showDetail(rows[selectedIndex].dataset.codigo);
    }
  }
});

// Focus trap for detail panel
function trapFocus(e) {
  if (!e.target.closest('#detailPanel')) return;
  const focusable = $('detailPanel').querySelectorAll('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])');
  const first = focusable[0];
  const last = focusable[focusable.length - 1];

  if (e.key === 'Tab') {
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}

document.addEventListener('keydown', trapFocus);

init();
