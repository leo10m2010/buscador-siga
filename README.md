# Buscador SIGA MEF

Buscador rápido y no oficial del **Catálogo de Bienes, Servicios y Obras del SIGA MEF** (Sistema Integrado de Gestión Administrativa del Ministerio de Economía y Finanzas del Perú).

Los datos provienen del [Portal de Datos Abiertos del MEF](https://datosabiertos.mef.gob.pe/) y se actualizan automáticamente todos los días. El sitio puede publicarse en Vercel y exponer una API JSON para agentes de IA, automatizaciones o integraciones externas.

## ¿Qué hace?

Permite buscar entre los **645,150 ítems** del catálogo oficial del SIGA en milisegundos, directamente desde el navegador.

- Búsqueda por nombre: `computadora`, `papel bond`, `paracetamol`
- Búsqueda por código: `14.06.0053.0230` (con o sin puntos)
- Filtros por tipo: Bienes / Servicios / Obras
- Panel de detalle con la jerarquía completa Grupo → Clase → Familia → Ítem
- Exportar resultados a CSV o Excel
- Funciona en celular, tablet y escritorio
- Insensible a tildes (`agua` encuentra `águila`, `video` encuentra `vídeo`)

## ¿Cómo funciona?

La aplicación web sigue funcionando como frontend estático: toda la búsqueda visual corre en el navegador del usuario. En Vercel, además, la carpeta `api/` expone Functions serverless que consultan la misma base SQLite comprimida y devuelven JSON.

### Arquitectura

```
┌─────────────────────────────────────────────┐
│  Vercel (hosting estático + API serverless) │
│                                              │
│  ┌──────────────┐    ┌────────────────────┐ │
│  │  index.html  │    │ catalogo-siga.db.gz│ │
│  │  (29 KB)     │    │ (66 MB comprimido) │ │
│  └──────┬───────┘    └─────────┬──────────┘ │
└─────────┼──────────────────────┼────────────┘
          │                      │
          ▼                      ▼
    ┌────────────────────────────────┐
    │   Navegador del usuario        │
    │                                │
    │   1. Descarga DB (1 vez)       │
    │   2. Descomprime con gzip      │
    │   3. Abre con sql.js (WASM)    │
    │   4. Búsquedas locales <50ms   │
    └────────────────────────────────┘
```

### Por qué SQLite en el navegador

El catálogo tiene 645,150 filas (152 MB en CSV crudo). Hacer scroll lineal sobre eso sería lento. Las alternativas evaluadas:

| Formato | Tamaño | Búsqueda |
|---|---|---|
| CSV en memoria | 152 MB | ~140 ms (lineal) |
| JSON minificado | 252 MB | ~140 ms (lineal) |
| SQLite + índices | 326 MB / 66 MB comprimido | ~0.5 ms (índice) |

SQLite con índice en columna normalizada gana por 280× en velocidad. La descarga inicial son 66 MB (gzip), después el navegador cachea todo y la app funciona casi como nativa.

## API en Vercel

La API usa la misma `catalogo-siga.db.gz` versionada en el repo, por lo que queda actualizada cada vez que GitHub Actions regenera la DB y Vercel redespliega el commit.

### `GET /api/search`

Busca por texto o por código.

Parámetros:

- `q` requerido: texto o código SIGA, con o sin puntos.
- `type` opcional: `all`, `B`, `S` u `O`.
- `page` opcional: página positiva, por defecto `1`.
- `limit` opcional: resultados por página, por defecto `50`, máximo `500`.

Ejemplo:

```bash
curl "https://TU-DOMINIO.vercel.app/api/search?q=computadora&type=B&limit=10"
```

Respuesta resumida:

```json
{
  "query": "computadora",
  "type": "B",
  "page": 1,
  "limit": 10,
  "total": 1531,
  "count": 10,
  "updatedAt": "2026-06-08T00:00:00.000Z",
  "rows": []
}
```

### `GET /api/item`

Devuelve un ítem exacto por código.

```bash
curl "https://TU-DOMINIO.vercel.app/api/item?codigo=13.30.0037.0003"
```

### `GET /api/meta`

Devuelve metadatos de la base: total de ítems, fecha del archivo, fuente oficial y ejemplos de endpoints.

```bash
curl "https://TU-DOMINIO.vercel.app/api/meta"
```

### Descubrimiento para IAs y agentes

Para que asistentes de IA y agentes encuentren y usen la API automáticamente:

- **`/llms.txt`** — descripción del sitio y de la API en el formato estándar que leen los agentes de IA.
- **`/openapi.json`** — especificación OpenAPI 3.0 de los tres endpoints, consumible por herramientas y agentes.
- **`/robots.txt`** — permite el rastreo a todos los bots.
- **`/api/meta`** — incluye los punteros a `openapi.json` y `llms.txt` en el campo `docs`.
- Todas las respuestas de la API incluyen `updatedAt`, así el agente sabe qué tan fresco es el dato.

## Estructura del proyecto

```
buscador-siga/
├── index.html              Frontend completo (UI + lógica de búsqueda)
├── api/                    Functions serverless para Vercel
├── catalogo-siga.db.gz     Base de datos SQLite comprimida (auto-actualizada)
├── construir_db.py         Script que genera el .db desde el CSV del MEF
├── vercel.json             Configuración de Vercel para API + DB
├── .github/
│   └── workflows/
│       └── update-catalogo.yml   Workflow que corre diario y actualiza la DB
└── README.md
```

## Actualización automática

Un GitHub Action corre todos los días a las **11:00 AM hora Lima** y:

1. Descarga el CSV oficial desde `datosabiertos.mef.gob.pe`
2. Regenera `catalogo-siga.db.gz` con el script `construir_db.py`
3. Hace commit del archivo nuevo (solo si hubo cambios)
4. Vercel redespliega el sitio y la API desde el nuevo commit

No requiere mantenimiento. El sitio queda siempre al día.

## Tecnologías

- **[sql.js](https://sql.js.org/)** — SQLite compilado a WebAssembly, corre en el navegador
- **[SheetJS](https://sheetjs.com/)** — Generación de archivos Excel (.xlsx)
- **[Lucide](https://lucide.dev/)** — Iconos SVG
- **HTML/CSS/JS vanilla** — Sin frameworks
- **Vercel** — Hosting estático + Functions serverless para la API
- **GitHub Actions** — Pipeline de actualización

## Datos

Los datos provienen 100% de fuente oficial: `https://fs.datosabiertos.mef.gob.pe/datastorefiles/Catalogo-SIGA_MEF.csv`

Estructura de cada ítem en el CSV oficial:

| Campo | Descripción | Ejemplo |
|---|---|---|
| TIPO_BIEN | B (Bien) / S (Servicio) / O (Obra) | `B` |
| GRUPO_BIEN | Código del grupo (2 dígitos) | `14` |
| NOMBRE_GRUPO | Nombre del grupo | `BIENES INFORMÁTICOS` |
| CLASE_BIEN | Código de clase (2 dígitos) | `06` |
| NOMBRE_CLASE | Nombre de la clase | `EQUIPOS DE PROCESAMIENTO` |
| FAMILIA_BIEN | Código de familia (4 dígitos) | `0053` |
| NOMBRE_FAMILIA | Nombre de la familia | `COMPUTADORAS PERSONALES` |
| ITEM_BIEN | Código del ítem (4 dígitos) | `0230` |
| NOMBRE_ITEM | Nombre del ítem específico | `CPU 2.60 GHZ 16 GB 1 TB` |
| NOMBRE_UNIDAD_MEDIDA | Unidad de medida | `UNIDAD` |
| FECHA_ALTA | Fecha de creación del ítem | `2019-03-15` |

El código se arma uniendo Grupo.Clase.Familia.Ítem → `14.06.0053.0230`.

## Desarrollo local

Para probar cambios antes de subirlos:

```bash
# Clonar el repo
git clone https://github.com/TU-USUARIO/buscador-siga.git
cd buscador-siga

# Servir localmente (necesario por restricciones de fetch en file://)
python -m http.server 8000

# Abrir en navegador
# http://localhost:8000
```

Si quieres regenerar la base de datos manualmente:

```bash
# Descargar el CSV oficial del MEF
curl -L -o catalogo.csv "https://fs.datosabiertos.mef.gob.pe/datastorefiles/Catalogo-SIGA_MEF.csv"

# Construir el .db
python construir_db.py

# Comprimir
gzip -9 catalogo-siga.db
```

## Licencia y atribución

Los datos son de propiedad del Ministerio de Economía y Finanzas del Perú (MEF) y se distribuyen bajo los términos del Portal de Datos Abiertos del Estado Peruano.

Este buscador es una herramienta no oficial, sin afiliación con el MEF, desarrollada como proyecto personal para facilitar el acceso al catálogo SIGA.

Para uso oficial, formal o trámites administrativos, contrastar siempre con la fuente oficial en [mef.gob.pe](https://www.gob.pe/mef).

## Limitaciones conocidas

- **Primera carga:** ~66 MB. Después queda en caché del navegador.
- **No incluye clasificadores presupuestales ni cuentas contables:** esos datos no están en el dataset abierto del MEF; habría que conseguirlos por otra vía.
- **Tope de exportación:** 5,000 resultados por exportación. Para más, refinar la búsqueda.
- **Resultados máximos en pantalla:** 5,000 para no colgar el navegador con búsquedas muy genéricas.

## Accesibilidad

El buscador está diseñado para ser usable con teclado y lectores de pantalla:

- Navegación completa con teclado (`↑` `↓` `Enter` `Espacio`)
- Foco visible en la fila seleccionada
- Anuncios automáticos del número de resultados mediante `aria-live`
- Filtros con estado `aria-pressed` correcto
- Estructura semántica (`<ul>` + `<li>`) para lectores de pantalla
- Focus trap en el panel de detalle

### Pruebas realizadas

- Navegación 100% con teclado
- Probado con NVDA + Firefox
- Probado con VoiceOver + Safari
- Contraste de color verificado (WCAG AA)
