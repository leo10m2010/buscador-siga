"""
Construye catalogo-siga.db a partir de catalogo.csv (descargado del MEF).

Genera la BD con:
- Tabla principal con todos los ítems
- Columna 'busqueda' normalizada (sin tildes, minúsculas) para LIKE rápido
- Índices en código, tipo y búsqueda
"""

import csv
import sqlite3
import unicodedata
import os
import sys


def normalizar(s: str) -> str:
    """Quita tildes y pasa a minúsculas."""
    if not s:
        return ""
    s = unicodedata.normalize("NFD", s)
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return s.lower()


def construir():
    csv_path = "catalogo.csv"
    db_path = "catalogo-siga.db"

    if not os.path.exists(csv_path):
        print(f"❌ No se encuentra {csv_path}", file=sys.stderr)
        sys.exit(1)

    # Borrar DB previa si existe
    if os.path.exists(db_path):
        os.remove(db_path)

    print(f"📂 Leyendo {csv_path}...")
    with open(csv_path, "r", encoding="utf-8-sig") as f:
        rows = list(csv.DictReader(f))
    print(f"   {len(rows):,} filas leídas")

    print("🔨 Construyendo base de datos SQLite...")
    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE items (
            id INTEGER PRIMARY KEY,
            tipo TEXT,
            codigo TEXT,
            nombre_item TEXT,
            nombre_familia TEXT,
            nombre_clase TEXT,
            nombre_grupo TEXT,
            unidad TEXT,
            fecha TEXT,
            busqueda TEXT
        )
    """)

    data = []
    for r in rows:
        codigo = f"{r['GRUPO_BIEN']}.{r['CLASE_BIEN']}.{r['FAMILIA_BIEN']}.{r['ITEM_BIEN']}"
        busqueda = " ".join([
            normalizar(r["NOMBRE_ITEM"]),
            normalizar(r["NOMBRE_FAMILIA"]),
            normalizar(r["NOMBRE_CLASE"]),
        ])
        data.append((
            r["TIPO_BIEN"], codigo,
            r["NOMBRE_ITEM"], r["NOMBRE_FAMILIA"], r["NOMBRE_CLASE"], r["NOMBRE_GRUPO"],
            r["NOMBRE_UNIDAD_MEDIDA"], r["FECHA_ALTA"][:10],
            busqueda
        ))

    conn.executemany(
        "INSERT INTO items (tipo,codigo,nombre_item,nombre_familia,nombre_clase,nombre_grupo,unidad,fecha,busqueda) "
        "VALUES (?,?,?,?,?,?,?,?,?)",
        data,
    )

    print("📇 Creando índices...")
    conn.execute("CREATE INDEX idx_codigo ON items(codigo)")
    conn.execute("CREATE INDEX idx_tipo ON items(tipo)")
    conn.execute("CREATE INDEX idx_busqueda ON items(busqueda COLLATE NOCASE)")

    conn.commit()
    print("🗜️  Optimizando base de datos (VACUUM)...")
    conn.execute("VACUUM")
    conn.close()

    size_mb = os.path.getsize(db_path) / 1024 / 1024
    print(f"✅ {db_path} generado ({size_mb:.1f} MB)")


if __name__ == "__main__":
    construir()
