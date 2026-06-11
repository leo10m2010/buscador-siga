const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { performance } = require('perf_hooks');

const initSqlJs = require('sql.js');

const DB_PATH = path.join(process.cwd(), 'catalogo-siga.db.gz');
const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

let databasePromise;
let databaseInfo;

function normalizar(s) {
  return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

function isCode(q) {
  return /^[\d.]+$/.test(q.trim()) && q.replace(/\D/g, '').length >= 4;
}

function formatCode(q) {
  const digits = q.replace(/\D/g, '');
  if (digits.length === 12) {
    return `${digits.slice(0, 2)}.${digits.slice(2, 4)}.${digits.slice(4, 8)}.${digits.slice(8, 12)}`;
  }
  return q;
}

function buildSearchSql(query, type) {
  const q = String(query || '').trim();
  let where = '';
  let params = [];

  if (isCode(q)) {
    where = "codigo LIKE ? || '%'";
    params.push(formatCode(q));
  } else {
    const words = normalizar(q).split(/\s+/).filter((w) => w.length >= 2);
    if (words.length === 0) return null;
    where = words.map(() => 'busqueda LIKE ?').join(' AND ');
    params = words.map((w) => `%${w}%`);
  }

  if (type && type !== 'all') {
    where += ' AND tipo = ?';
    params.push(type);
  }

  return { where, params };
}

function parseType(raw) {
  const type = String(raw || 'all').toUpperCase();
  if (type === 'ALL') return 'all';
  if (['B', 'S', 'O'].includes(type)) return type;
  const error = new Error('Parametro type invalido. Usa all, B, S u O.');
  error.statusCode = 400;
  throw error;
}

function parsePositiveInt(value, fallback, max) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return Math.min(parsed, max);
}

async function getDatabase() {
  if (!databasePromise) {
    databasePromise = (async () => {
      const stat = fs.statSync(DB_PATH);
      // En Vercel el mtime de los archivos desplegados es un timestamp fijo
      // sin relacion con los datos; la fecha real viene de db-version.json,
      // que el workflow escribe cada vez que el catalogo cambia.
      let updatedAt = stat.mtime.toISOString();
      try {
        const versionFile = path.join(process.cwd(), 'db-version.json');
        const parsed = JSON.parse(fs.readFileSync(versionFile, 'utf8'));
        if (parsed.updatedAt) updatedAt = parsed.updatedAt;
      } catch {
        // Sin db-version.json: queda el mtime como aproximacion.
      }
      const SQL = await initSqlJs({
        locateFile: (file) => path.join(process.cwd(), 'node_modules', 'sql.js', 'dist', file),
      });
      let compressed = fs.readFileSync(DB_PATH);
      const decompressed = zlib.gunzipSync(compressed);
      compressed = null; // liberar ~69 MB antes de la copia al heap WASM
      const db = new SQL.Database(decompressed);
      const count = db.exec('SELECT COUNT(*) AS total FROM items')[0].values[0][0];

      databaseInfo = {
        totalItems: count,
        source: 'https://fs.datosabiertos.mef.gob.pe/datastorefiles/Catalogo-SIGA_MEF.csv',
        databaseFile: 'catalogo-siga.db.gz',
        databaseBytes: stat.size,
        updatedAt,
      };

      return db;
    })();
  }
  return databasePromise;
}

function setApiHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=3600');
}

function handleOptions(req, res) {
  if (req.method === 'OPTIONS') {
    setApiHeaders(res);
    res.status(204).end();
    return true;
  }
  return false;
}

function sendError(res, error) {
  const status = error.statusCode || 500;
  res.status(status).json({
    error: status === 500 ? 'Error interno consultando el catalogo SIGA.' : error.message,
  });
}

async function searchCatalog({ q, type, page, limit }) {
  const db = await getDatabase();
  const t0 = performance.now();
  const built = buildSearchSql(q, type);

  if (!built) {
    const error = new Error('Parametro q requerido. Escribe al menos una palabra de 2 letras o un codigo.');
    error.statusCode = 400;
    throw error;
  }

  const countStmt = db.prepare(`SELECT COUNT(*) AS total FROM items WHERE ${built.where}`);
  countStmt.bind(built.params);
  countStmt.step();
  const total = countStmt.getAsObject().total;
  countStmt.free();

  const offset = (page - 1) * limit;
  const sql = `
    SELECT codigo, nombre_item, nombre_familia, nombre_clase, nombre_grupo, tipo, unidad, fecha
    FROM items
    WHERE ${built.where}
    ORDER BY codigo
    LIMIT ? OFFSET ?
  `;
  const stmt = db.prepare(sql);
  stmt.bind([...built.params, limit, offset]);
  const rows = [];
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();

  return {
    query: q,
    type,
    page,
    limit,
    total,
    count: rows.length,
    ms: Math.round(performance.now() - t0),
    updatedAt: databaseInfo.updatedAt,
    rows,
  };
}

async function getItem(codigo) {
  const db = await getDatabase();
  const formatted = formatCode(String(codigo || '').trim());
  if (!formatted) {
    const error = new Error('Parametro codigo requerido.');
    error.statusCode = 400;
    throw error;
  }

  const stmt = db.prepare(`
    SELECT codigo, nombre_item, nombre_familia, nombre_clase, nombre_grupo, tipo, unidad, fecha
    FROM items
    WHERE codigo = ?
    LIMIT 1
  `);
  stmt.bind([formatted]);
  const item = stmt.step() ? stmt.getAsObject() : null;
  stmt.free();

  if (!item) {
    const error = new Error('Item no encontrado.');
    error.statusCode = 404;
    throw error;
  }

  return { updatedAt: databaseInfo.updatedAt, item };
}

async function getMeta() {
  const db = await getDatabase();
  const stmt = db.prepare(`
    SELECT tipo, COUNT(*) AS total
    FROM items
    GROUP BY tipo
    ORDER BY tipo
  `);
  const byType = {};
  while (stmt.step()) {
    const row = stmt.getAsObject();
    byType[row.tipo] = row.total;
  }
  stmt.free();

  return {
    ...databaseInfo,
    byType,
    endpoints: {
      search: '/api/search?q=computadora&type=B&page=1&limit=50',
      item: '/api/item?codigo=14.06.0053.0230',
      meta: '/api/meta',
    },
    docs: {
      openapi: '/openapi.json',
      llms: '/llms.txt',
    },
  };
}

module.exports = {
  DEFAULT_LIMIT,
  MAX_LIMIT,
  getItem,
  getMeta,
  handleOptions,
  parsePositiveInt,
  parseType,
  searchCatalog,
  sendError,
  setApiHeaders,
};
