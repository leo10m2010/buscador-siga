function isCode(q) {
  return /^[\d.]+$/.test(q.trim()) && q.replace(/\D/g, '').length >= 4;
}

function formatCode(q) {
  const digits = q.replace(/\D/g, '');
  if (digits.length === 12) {
    return `${digits.slice(0,2)}.${digits.slice(2,4)}.${digits.slice(4,8)}.${digits.slice(8,12)}`;
  }
  return q;
}

function normalizar(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function buildSearchSql(query, filter) {
  const q = query.trim();
  let where = '';
  let params = [];

  if (isCode(q)) {
    where = "codigo LIKE ? || '%'";
    params.push(formatCode(q));
  } else {
    const words = normalizar(q).split(/\s+/).filter(w => w.length >= 2);
    if (words.length === 0) return null;
    where = words.map(() => "busqueda LIKE ?").join(" AND ");
    params = words.map(w => `%${w}%`);
  }

  if (filter !== 'all') {
    where += " AND tipo = ?";
    params.push(filter);
  }

  return { where, params };
}

function searchWithCount(db, query, filter, page = 1, PAGE_SIZE = 100) {
  if (!db) return { rows: [], total: 0, ms: 0 };
  const t0 = performance.now();

  try {
    const built = buildSearchSql(query, filter);
    if (!built) return { rows: [], total: 0, ms: 0 };

    // Count
    const countStmt = db.prepare(`SELECT COUNT(*) as c FROM items WHERE ${built.where}`);
    countStmt.bind(built.params);
    countStmt.step();
    const total = countStmt.getAsObject().c;
    countStmt.free();

    // Page
    const offset = (page - 1) * PAGE_SIZE;
    const sql = `SELECT codigo, nombre_item, nombre_familia, nombre_clase, nombre_grupo, tipo, unidad, fecha
                 FROM items WHERE ${built.where} LIMIT ? OFFSET ?`;
    const stmt = db.prepare(sql);
    stmt.bind([...built.params, PAGE_SIZE, offset]);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();

    return { rows, total, ms: performance.now() - t0 };
  } catch (e) {
    console.error('Search error:', e);
    return { rows: [], total: 0, ms: 0, error: e.message };
  }
}

function escapeHtml(s) {
  return String(s || '').replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'
  }[c]));
}

const highlightCache = new Map();

function highlight(text, query) {
  if (!query || isCode(query)) return escapeHtml(text);

  const cacheKey = query + '|' + text;
  if (highlightCache.has(cacheKey)) return highlightCache.get(cacheKey);

  const words = query.trim().split(/\s+/).filter(w => w.length >= 2);
  let result = escapeHtml(text);

  for (const w of words) {
    const escaped = w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(${escaped})`, 'gi');
    result = result.replace(re, '<mark>$1</mark>');
  }

  if (highlightCache.size > 500) highlightCache.clear();
  highlightCache.set(cacheKey, result);
  return result;
}

// Lightweight fuzzy matching for better search tolerance
function fuzzyMatch(text, query) {
  if (!text || !query) return 0;
  const t = normalizar(text);
  const q = normalizar(query);

  if (t.includes(q)) return 1;

  // Simple fuzzy scoring
  let score = 0;
  let tIndex = 0;

  for (let i = 0; i < q.length; i++) {
    const char = q[i];
    const found = t.indexOf(char, tIndex);
    if (found === -1) return 0;
    score += 1 / (found - tIndex + 1);
    tIndex = found + 1;
  }

  return score / q.length;
}

function fuzzySearch(db, query, filter, limit = 50) {
  if (!db || !query) return { rows: [], ms: 0 };

  const t0 = performance.now();
  const q = query.trim();
  const words = normalizar(q).split(/\s+/).filter(w => w.length >= 2);

  if (words.length === 0) return { rows: [], ms: 0 };

  const results = [];
  let sql = `
    SELECT codigo, nombre_item, nombre_familia, nombre_clase, nombre_grupo, tipo, unidad, fecha, busqueda
    FROM items
  `;
  const params = [];

  if (filter !== 'all') {
    sql += ' WHERE tipo = ?';
    params.push(filter);
  }
  sql += ' LIMIT 3000'; // reduced from 5000 for better performance

  const stmt = db.prepare(sql);
  if (params.length > 0) stmt.bind(params);

  while (stmt.step()) {
    const row = stmt.getAsObject();
    const searchText = row.busqueda || '';
    let score = 0;

    for (const word of words) {
      score += fuzzyMatch(searchText, word);
    }

    if (score > 0.25) {
      results.push({ ...row, _score: score });
    }
  }
  stmt.free();

  results.sort((a, b) => b._score - a._score);
  const topResults = results.slice(0, limit).map(r => {
    const { _score, ...rest } = r;
    return rest;
  });

  return { rows: topResults, ms: performance.now() - t0 };
}
