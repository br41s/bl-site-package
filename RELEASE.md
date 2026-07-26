# Proceso de release — Uso interno

Documento interno para el equipo de BigLobster. Describe cómo sacar un cambio
del paquete `bl-site-package` a producción sin romper los sitios de los
clientes.

`bl-site-package` es un paquete compartido: el mismo código corre en nuestra
instancia de pruebas en Zeabur **y** en el entorno de cada cliente. Por eso
todo cambio pasa primero por pruebas antes de tocar a ningún cliente.

**Nuestro entorno de pruebas** es la instancia de Zeabur `bl-site-package`
(proyecto `biglobster`), servida en `https://blcliente.zeabur.app`. Es la que
auto-despliega desde `main`.

**Los entornos de cliente son distintos entre sí.** El primer cliente,
Shoroban, corre sobre **Plesk/Passenger (Debian)** en `prueba.shoroban.com`
(staging) → `shoroban.com` (producción). Otros clientes futuros pueden usar un
hosting, distribución o panel diferentes. No asumas que "cliente" == "Plesk":
cada uno se verifica por separado.

---

## Flujo (staging-first)

1. **Cambio en una rama** → abre PR contra `main`.
2. **Revisión** → corre `/review` sobre la rama (los cambios de nivel sistema
   son *advisory*: los revisa una persona antes de mergear).
3. **Merge a `main`.**
4. **Zeabur auto-despliega** desde `main` en nuestra instancia de pruebas
   (`https://blcliente.zeabur.app`).
5. **Smoke test** contra pruebas:
   ```bash
   scripts/smoke-test.sh https://blcliente.zeabur.app
   ```
   Debe salir en verde (exit 0). Si falla, **para**: no se toca a ningún
   cliente hasta arreglarlo.
6. **Solo con pruebas en verde**, despliega en el entorno de cada cliente uno
   a uno, y corre el smoke test contra cada uno:
   ```bash
   scripts/smoke-test.sh https://prueba.shoroban.com   # staging del cliente
   scripts/smoke-test.sh https://shoroban.com          # producción del cliente
   ```

Regla de oro: **nunca** se despliega directamente a un cliente sin que el
cambio haya estado verde en pruebas (Zeabur) primero.

---

## Qué cubre pruebas (Zeabur) y qué NO

Nuestra instancia de pruebas corre sobre **Alpine/Docker** (multi-stage
`Dockerfile`, base `node:20-alpine`). Los entornos de cliente corren sobre otra
cosa: el primero, Shoroban, sobre **Plesk/Passenger (Debian)**
(`passenger-startup.cjs`, Node 20); otros clientes pueden diferir. Son entornos
distintos del de pruebas y, potencialmente, distintos entre sí.

Pruebas **sí** detecta:
- Endpoints rotos (500, 404 donde no toca).
- Fallos de arranque (el server no levanta, el build de Eleventy peta).
- Regresiones en funcionalidad compartida (panel, blog, catálogo, reservas).
- Errores de datos/lógica que afectan a todos los clientes por igual.

Pruebas **no** detecta problemas específicos del entorno de cada cliente:
- Compilación de módulos nativos (`better-sqlite3`) en el SO del cliente
  (p. ej. Debian) vs Alpine.
- Rutas, permisos y versión de Node concretas de ese hosting/panel.
- Variables de entorno o almacenamiento mal configurados en un cliente concreto.
- Estado del dominio/DNS/HTTPS de cada cliente.

Por eso la verificación por cliente (paso 6) sigue siendo obligatoria aunque
pruebas esté en verde.

---

## Smoke test

`scripts/smoke-test.sh <base-url>` comprueba los endpoints clave tras un
deploy. Solo necesita `bash` + `curl`. Sale con código distinto de cero si
falla cualquier check, así que sirve para bloquear un release.

Comprueba:
- `GET /api/site/config` → 200 + JSON (arrancaron DB y capa de config).
- `GET /api/blog/posts` → 200 (funciona la ruta de artículos).
- `GET /` → 200 (se sirve el build de Eleventy).
- `GET /setup` → 200 (wizard accesible).
- `GET /panel` → 200 ó 302 (la ruta está cableada; 302 = aún sin configurar,
  redirige a `/setup`).
- `GET /data/app.db` → **NO 200** (404/403). Puerta de seguridad: un 200 aquí
  significa que el document root está sirviendo el directorio `data/` de la app
  y la base de datos es descargable (el incidente de Shoroban). Es un fallo duro.
- `GET /.env` → **NO 200** (404/403). Misma clase de fuga: ficheros internos
  expuestos por un docroot mal configurado.

Como los checks de `/` y `/api/site/config` exigen exactamente 200, un arranque
roto (p. ej. el crash de ABI de `better-sqlite3`, que devuelve 500 en todo el
sitio) también los hace fallar: el smoke test bloquea tanto una fuga de datos
como un arranque caído.

---

## Cuándo hace falta rebuild/restart (plantillas y código vs. contenido)

`_site/` (el build de Eleventy) **no está en el volumen persistente**: se regenera
desde cero en cada arranque (`buildOnStartup`, `src/server.js`). Además, los cambios
de CONTENIDO (textos de página, blog) escritos desde el panel o el agente disparan un
rebuild en caliente (`scheduleRebuild`). Consecuencia práctica al desplegar:

- **Cambios de contenido** (un texto, un artículo): se ven solos, sin reiniciar.
- **Cambios de plantilla, CSS o código** (una release del paquete — p. ej. el render
  Markdown de las páginas o un campo de config nuevo como `page_index_body`):
  **necesitan reiniciar la app.** El reinicio (a) carga el código nuevo y (b) regenera
  `_site/` con las plantillas nuevas. No hace falta un `npm run build` aparte.
  - En **Zeabur** el auto-deploy desde `main` reconstruye la imagen y reinicia el
    contenedor: basta con confirmar que redesplegó tras el merge.
  - En **Plesk** es el `touch tmp/restart.txt` (o *Restart App*) del runbook de abajo,
    tras el `git pull`. Solo hace falta `npm ci` si cambiaron dependencias.

  Sin reinicio, el servidor sigue con el código viejo (un campo de config nuevo se
  rechaza en la allowlist de `/api/site/texts` y no se expone en `site.js`) y sirve el
  `_site/` antiguo (las páginas no reflejan el cambio de plantilla). Ojo con el orden:
  si un agente de contenidos (onboarding/gap-hunter) ya está apuntando a un campo nuevo,
  reinicia el sitio del cliente **antes** de su próxima ejecución.

---

## Limpieza de imágenes subidas (`data/uploads`)

Las imágenes de portada de blog (`articles.image_url`) y las de página
(`page_*_image`) se guardan como WebP con nombre por hash de contenido en
`data/uploads`, sobre el volumen persistente. Al reemplazar una portada o borrar
un artículo, el fichero antiguo queda huérfano. Con el gap-hunter de Hermes
regenerando portadas a diario, sin limpieza el directorio crecería sin límite.

`src/media/cleanup-uploads.js` hace un barrido periódico (al arrancar y luego a
diario, `30 4 * * *`) que borra los `*.webp` de `data/uploads` **no referenciados
por ninguna** `articles.image_url` ni config `page_*_image`. Detalles del diseño:

- **Solo toca ficheros con nombre-hash** (`^[a-f0-9]{32}\.webp$`, lo que produce
  `optimizeToWebp`). Los `logo.*` y cualquier otro fichero quedan intactos por
  construcción, no por un caso especial.
- **Hash compartido a salvo**: si varias filas apuntan al mismo fichero, basta
  con que una lo referencie para conservarlo.
- **Ventana de gracia de 1 h**: una subida se escribe en disco antes de que la
  petición posterior guarde la fila que la referencia; saltarse los ficheros
  recién modificados evita borrar una subida a medio flujo.

No requiere configuración ni intervención en el despliegue. No borra nada que
esté referenciado.

---

## Estructura de directorios y document root (seguridad)

**Regla de oro: el document root del servidor web solo puede servir estáticos
públicos. Nunca puede ser la raíz de la aplicación.** La raíz contiene
`data/app.db` (base de datos SQLite con la contraseña del panel en texto plano,
el `JWT_SECRET`, la API key de OpenRouter del cliente y los mensajes de
contacto), además de `src/`, `node_modules/`, `.env` y `.git/`.

En Zeabur (contenedor Node, Express sirve todo) el problema no se da: Express es
el único servidor y **nunca** sirve la raíz de la app — solo `_site/` (build de
Eleventy), `web/` (assets del panel/setup) y `/uploads`. Una petición a
`/data/app.db` cae en el 404. No hay nginx sirviendo ficheros directamente.

En **Plesk** (y cualquier hosting donde nginx/apache sirve estáticos del
document root directamente, antes de pasar a la app), si el document root ==
raíz de la app, `GET /data/app.db` lo sirve el servidor web sin pasar por
Express y **descarga la base de datos entera**. Esto le pasó a Shoroban.

**El paquete incluye `public/`** como frontera del document root. Es un
directorio (casi) vacío a propósito: su único fin es ser el document root en
Plesk, de modo que nginx solo pueda servir lo que haya dentro (nada sensible) y
todo lo demás se proxye a Passenger → Express, que decide qué se sirve. No metas
en `public/` nada de la app.

Defensa en profundidad, además de la estructura:
- **Guard de arranque** (`src/db/database.js`): si `DB_PATH` resuelve dentro de
  un directorio que la app sirve (`_site/`, `web/`, `public/`, `data/uploads/`),
  el proceso **se niega a arrancar** — antes incluso de abrir/crear el fichero.
- **Deny de `/data`** (`src/server.js`): ninguna ruta bajo `/data` se sirve por
  HTTP (404), aunque un futuro montaje estático o un symlink lo intentara.
- **Puertas del smoke test**: `/data/app.db` y `/.env` deben devolver NO-200.

---

## Runbook de despliegue en cliente Plesk/Passenger

Procedimiento razonado para el go-live y las actualizaciones en un servidor
Plesk/Passenger (Debian). Documentado a partir del rollout de Shoroban. **No se
aplica hasta que el cambio esté verde en pruebas (Zeabur)** — ver flujo
staging-first arriba. Pasos, en orden:

1. **Document root correcto (CRÍTICO, seguridad).** En Plesk → *Node.js*:

   | Campo (Plesk)                    | Valor              |
   | -------------------------------- | ------------------ |
   | **Raíz de la aplicación** (Application Root) | `/httpdocs`        |
   | **Raíz del documento** (Document Root)       | `/httpdocs/public` |
   | **Archivo de inicio** (Startup File)         | `passenger-startup.cjs` |

   Plesk mismo lo avisa: *"set the document root to a subdirectory of the
   application root (like public/) for security."* Con esto nginx solo sirve
   `public/`; `data/`, `src/`, `node_modules/`, `.env` y `package.json` quedan
   fuera de su alcance.

   **Gotchas (los pisamos en Shoroban):**
   - Los dos campos se confunden con facilidad. Solo cambia el **Document Root**
     a `public/`; el **Application Root** se queda en `/httpdocs`. Si inviertes
     los dos, Passenger busca `passenger-startup.cjs` dentro de `public/`, no lo
     encuentra, y todo el sitio da 500.
   - **`public/` tiene que existir ANTES** de poner el Document Root, o Plesk
     rechaza el valor (*"El nombre de archivo /httpdocs/public no es válido"*).
     Se crea con el `git pull` (el repo trae `public/.gitkeep`); si aún no has
     hecho pull, créalo a mano en *Administrador de archivos* → `httpdocs` →
     *Crear → Directorio* → `public`.
   - Con el Document Root ya en `public/`, comprueba desde fuera que el código
     dejó de ser servible: `GET /src/server.js` y `GET /package.json` deben dar
     **404** (el smoke test lo verifica).

2. **Backup de `data/` FUERA de `httpdocs`** (nunca re-clonar el repo encima; se
   perdería la DB). Copia `data/` a una ruta fuera del document root, p. ej.
   `~/bl-data/`, y usa esa ruta como `DB_PATH` (ver punto 6).

3. **Traer el código**: `git pull --ff-only` (no re-clonar).

4. **Versión de Node**: debe ser **20.x o 22.x LTS**, y debe coincidir con la
   versión contra la que se compiló el módulo nativo `better-sqlite3`. En Plesk
   se fija en la config Node del dominio.

5. **Instalar dependencias**: `npm ci --omit=dev`.
   - **Al cambiar la versión de Node hay que RECONSTRUIR el binario nativo**:
     `npm rebuild better-sqlite3` (o un `npm ci` limpio). Si no, al arrancar
     salta un `NODE_MODULE_VERSION` mismatch (ABI). Caso real de Shoroban:
     binario compilado para Node 24 (ABI 137) contra runtime Node 22 (ABI 127)
     → 500 en todo el sitio.

6. **Variables de entorno** (Plesk → Node → Environment variables):
   - `DB_PATH` = ruta a la DB **fuera del document root** (la del backup del
     punto 2, p. ej. `/var/www/vhosts/<dominio>/bl-data/app.db`). Es el estándar,
     no opcional.
   - `STAGING=true` en el subdominio de staging (`prueba.<dominio>`); en go-live,
     **quitarla** y poner `SITE_URL=https://<dominio>`.
   - **NO** definir `OPENROUTER_API_KEY`: el código la prioriza sobre la key BYOK
     que el cliente introduce en `/setup`, así que definirla aquí ignora en
     silencio la del cliente.

7. **Reiniciar Passenger**: `touch tmp/restart.txt` en la raíz de la app, o el
   botón *Restart App* en Plesk.

8. **Smoke test**: `scripts/smoke-test.sh https://<dominio>` (o el de staging).
   Debe salir en verde, incluidas las puertas de seguridad `/data/app.db`,
   `/.env`, `/src/server.js` y `/package.json` (todas NO-200). Córrelo desde tu
   máquina (o cualquier host con `curl`): es un chequeo HTTP externo, no hace
   falta ejecutarlo dentro del contenedor/servidor.

9. **Verifica que la DB es la correcta, no una vacía.** Si `DB_PATH` apunta a una
   ruta donde no está el `app.db` poblado, la app **crea uno vacío ahí sin
   avisar** y `/panel` redirige a `/setup` (config perdida en apariencia). Tras
   el deploy comprueba que la config del cliente está:
   ```bash
   curl -s https://<dominio>/api/site/config | head -c 120   # company_name != null
   scripts/smoke-test.sh https://<dominio>                    # /panel → 200 si ya está configurado
   ```
   Ojo con WAL: `better-sqlite3` usa `journal_mode=WAL`, así que la DB son TRES
   ficheros (`app.db`, `app.db-wal`, `app.db-shm`). Si mueves/copias la DB, muévelos
   los tres juntos, o los datos recientes (que viven en el `-wal`) se pierden.

**Ver errores de arranque en Passenger**: en modo producción Passenger oculta
los errores de arranque (muestra una página genérica). Para verlos: ejecuta
`npm start` desde el *Node command runner* de Plesk, o pon temporalmente la app
en modo *development*. Ahí verás el ABI mismatch, un `DB_PATH` mal puesto, etc.
Nota: si `npm start` da `EADDRINUSE: :::3000`, **no es un error de la app** —
significa que Passenger ya la está corriendo en ese puerto; de hecho confirma
que arranca bien. Passenger gestiona el proceso: no lo lances a mano en paralelo,
usa *Reiniciar app*.

---

## Vulnerabilidades npm (`npm audit`)

`npm audit` reporta 4 high-severity, todas la misma cadena transitiva:
`@11ty/eleventy` → `@11ty/recursive-copy` → `minimatch@3.1.5` →
`brace-expansion` (DoS/OOM, [GHSA-mh99-v99m-4gvg], CVSS 7.5, solo
disponibilidad).

**Estado: documentada y diferida a propósito.** No se aplica fix por ahora:
- Es una dependencia **de build** (Eleventy la usa al copiar estáticos con
  globs). Los patrones de glob están **hardcodeados** en `eleventy.config.mjs`;
  **ningún input de un visitante llega a `brace-expansion`**. No es explotable
  desde la web.
- Impacto solo de disponibilidad (A:H), no de confidencialidad ni integridad.
- La **única versión parcheada es `brace-expansion@5.0.8`, que es ESM puro**
  (`type: module`), incompatible con el `minimatch@3.1.5` (CommonJS, hace
  `require('brace-expansion')`) que Eleventy fija. Forzarla rompería el build en
  las versiones de Node soportadas por debajo de 20.19 / 22.12 (donde
  `require()` de un módulo ESM falla).
- `npm audit fix --force` **degradaría** `@11ty/eleventy` 3.1.6 → 3.1.2 (una
  regresión), no es un fix real. **Nunca** usar `--force` aquí.

**Acción de seguimiento**: revisar en cada release de Eleventy si actualiza
`recursive-copy`/`minimatch` a una cadena con `brace-expansion` parcheado, y
re-auditar. Mientras tanto el riesgo real en producción es nulo.

[GHSA-mh99-v99m-4gvg]: https://github.com/advisories/GHSA-mh99-v99m-4gvg
