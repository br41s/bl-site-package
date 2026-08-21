# bl-site-package

Paquete web deployable para clientes SMB. Incluye sitio público, panel de gestión, blog, bandeja de mensajes y agente de marketing con IA.

## Deploy en 5 minutos

1. Conecta este repo en [Zeabur](https://zeabur.com).
2. Abre `tudominio.com/setup`.
3. Completa el wizard con empresa, sector, OpenRouter API Key y contraseña del panel.
4. Accede a `tudominio.com/panel`.
5. Publica y personaliza el sitio desde el panel.

## Modelo por defecto

El agente usa por defecto `openai/gpt-oss-20b:free`, un modelo gratuito de OpenRouter que cubre el flujo base.

## Páginas incluidas

- Inicio
- Quiénes somos
- Servicios
- Contacto
- Blog
- Catálogo y ficha de producto (solo con catálogo conectado)
- Carrito y reserva de recogida (solo con catálogo conectado)
- Legales: privacidad, condiciones y uso de IA

## Contenido de las páginas (Markdown)

Los cuerpos de página se escriben en **Markdown** y el sitio los renderiza con el
mismo pipeline saneado que el blog (`marked` + `sanitize-html`). Puedes usar
encabezados (`##`/`###`), listas, **negrita**, enlaces y tablas: se convierten en
HTML con estilos propios. El texto plano sigue funcionando igual que antes (los
saltos de línea se respetan), así que los sitios existentes no se ven afectados.

Modelo de campos por página:

| Campo | Rol | Formato |
| ----- | --- | ------- |
| `page_index_desc` | Blurb corto del héroe de la portada (y meta-descripción SEO) | Texto corto |
| `page_index_body` | Cuerpo rico de la portada, se muestra **debajo** del héroe y los botones | Markdown |
| `page_quienes_desc` / `page_servicios_desc` | Cuerpo completo de la página | Markdown |
| `page_contacto_desc` | Intro sobre el formulario de contacto | Markdown |
| `page_*_subtitle` | Subtítulo (en páginas interiores alimenta la meta-descripción SEO) | Texto corto |

> `page_index_body` es el campo del cuerpo de la portada: mantén `page_index_desc`
> corto (una o dos frases de gancho) y escribe el contenido extenso y estructurado
> de la home en `page_index_body`.

## Funcionalidades del panel

- Gestión de blog: crear, editar, publicar y eliminar artículos.
- Agente de marketing con IA mediante OpenRouter.
- Configuración de páginas, textos y logo.
- Bandeja de mensajes enviados desde el formulario de contacto.
- Catálogo: visibilidad por producto, reservas, fichas propias y estado de la sincronización.
- Reseteo completo desde Ajustes para volver al onboarding.

## Catálogo (opcional)

Para clientes que venden desde el feed de un distribuidor. El catálogo se sincroniza solo
—precios, stock, altas y bajas— y de ese feed salen también las características, el EAN, la
referencia del fabricante y las fichas técnicas en PDF de cada producto.

**Lo que escribimos nosotros vive aparte.** Cuando una ficha se reescribe, pasa a la tabla
`product_content`, que la sincronización no toca: la descripción es nuestra y sobrevive
incluso a un cambio de distribuidor, mientras el precio y el stock siguen viniendo del
feed. La URL de un producto se fija la primera vez y no cambia aunque cambie el título.

## Variables de entorno

| Variable              | Descripción                                                 | Default            |
| --------------------- | ----------------------------------------------------------- | ------------------ |
| `PORT`                | Puerto del servidor                                         | `3000`             |
| `PANEL_PASSWORD`      | Contraseña del panel, opcional si se guarda desde el wizard | vacío              |
| `JWT_SECRET`          | Secret JWT, opcional si se genera desde el wizard           | vacío              |
| `OPENROUTER_API_KEY`  | API key de OpenRouter                                       | vacío              |
| `CONTENT_AGENT_MODEL` | Modelo OpenRouter para el agente de contenidos              | `openai/gpt-oss-20b:free` |
| `CLIENT_COMPANY_NAME` | Nombre de la empresa                                        | vacío              |
| `CLIENT_SECTOR`       | Sector de la empresa                                        | vacío              |
| `DB_PATH`             | Ruta a la base de datos SQLite                              | `./data/app.db`    |
| `LIDERPAPEL_SFTP_HOST` / `_USER` / `_PASS` / `_PORT` | Conexión sFTP del distribuidor (o desde el panel) | vacío |
| `LIDERPAPEL_SUPPLIER_CODE` | Código de la cuenta dentro del feed (p. ej. `CSP`)     | vacío              |
| `LIDERPAPEL_SYNC_MODE` | `sftp` o `local` (leer el feed de un directorio)           | `sftp`             |
| `LIDERPAPEL_LOCAL_DIR` | Directorio del feed en modo `local`                        | vacío              |
| `BL_SITE_DISABLE_REBUILD` | `1` desactiva la reconstrucción automática. **Solo para tests** | vacío       |

Si estas variables están vacías, el asistente de inicio en `/setup` guarda la configuración en SQLite.

## Estructura

```
bl-site-package/
├── site/                   # Fuente de las páginas (Nunjucks) → build a _site/
│   ├── index.njk  quienes-somos.njk  servicios.njk  contacto.njk
│   ├── blog.njk  blog-post.njk
│   ├── productos.njk  producto.njk  carrito.njk
│   ├── privacidad.njk  condiciones.njk  uso-de-ia.njk
│   ├── sitemap.njk  robots.njk
│   └── _data/              # Datos de build leídos de SQLite (NO poner tests aquí)
├── src/
│   ├── server.js           # Entry point Express
│   ├── api/                # auth, blog, chat, contact, setup, site,
│   │                       # products, product-content, reservations, sync, knowledge
│   ├── build/              # Reconstrucción Eleventy en segundo plano
│   ├── content/            # Formato y saneado de contenido
│   ├── db/database.js      # SQLite: esquema + migraciones aditivas
│   ├── mail/mailer.js      # Única vía de envío SMTP
│   ├── media/              # Optimización de imágenes y limpieza de uploads
│   ├── middleware/         # JWT y rate limiting
│   └── sync/liderpapel/    # Adaptador del feed del distribuidor
├── web/                    # Servido tal cual: panel, wizard, CSS y JS del sitio
│   ├── panel.html  panel.js  style-panel.css
│   ├── setup.html  setup.js
│   ├── site.js  cart.js  style.css
└── scripts/
    ├── smoke-test.sh       # Comprobación post-deploy (ver RELEASE.md)
    ├── check-version-bump.mjs
    └── fleet-check.mjs
```
