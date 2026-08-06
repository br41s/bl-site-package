# bl-site-package

Paquete web deployable para clientes SMB. Incluye sitio público, panel de gestión, blog, bandeja de mensajes y agente de marketing con IA.

## Deploy en 5 minutos

1. Conecta este repo en [Zeabur](https://zeabur.com).
2. Abre `tudominio.com/setup`.
3. Completa el wizard con empresa, sector, OpenRouter API Key y contraseña del panel.
4. Accede a `tudominio.com/panel`.
5. Publica y personaliza el sitio desde el panel.

## Modelo por defecto

El agente usa por defecto `gpt-oss-20b:free`, un modelo gratuito de OpenRouter que cubre el flujo base.

## Páginas incluidas

- Inicio
- Quiénes somos
- Servicios
- Contacto
- Blog

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
- Reseteo completo desde Ajustes para volver al onboarding.

## Variables de entorno

| Variable              | Descripción                                                 | Default            |
| --------------------- | ----------------------------------------------------------- | ------------------ |
| `PORT`                | Puerto del servidor                                         | `3000`             |
| `PANEL_PASSWORD`      | Contraseña del panel, opcional si se guarda desde el wizard | vacío              |
| `JWT_SECRET`          | Secret JWT, opcional si se genera desde el wizard           | vacío              |
| `OPENROUTER_API_KEY`  | API key de OpenRouter                                       | vacío              |
| `CONTENT_AGENT_MODEL` | Modelo OpenRouter para el agente de contenidos              | `gpt-oss-20b:free` |
| `CLIENT_COMPANY_NAME` | Nombre de la empresa                                        | vacío              |
| `CLIENT_SECTOR`       | Sector de la empresa                                        | vacío              |
| `DB_PATH`             | Ruta a la base de datos SQLite                              | `./data/app.db`    |

Si estas variables están vacías, el asistente de inicio en `/setup` guarda la configuración en SQLite.

## Estructura

```
bl-site-package/
├── src/
│   ├── server.js          # Entry point Express
│   ├── middleware/
│   │   └── auth.js        # Middleware JWT
│   ├── db/
│   │   └── database.js    # SQLite init + schema
│   ├── mail/
│   │   └── mailer.js      # Única vía de envío SMTP (contacto + notificaciones)
│   └── api/
│       ├── auth.js        # POST /api/auth/login
│       ├── chat.js        # POST /api/chat/send
│       ├── blog.js        # CRUD /api/blog/posts
│       ├── contact.js     # GET/POST /api/contact
│       ├── setup.js       # GET/POST/DELETE /api/setup
│       └── site.js        # Config, logo, modelos OpenRouter, estado y notificaciones
└── web/
    ├── index.html         # Sitio público
    ├── quienes-somos.html # Página Quiénes somos
    ├── servicios.html     # Página Servicios
    ├── contacto.html      # Página Contacto
    ├── blog.html          # Página Blog
    ├── panel.html         # Panel de gestión
    ├── panel.js           # JS del panel
    ├── style-panel.css    # CSS del panel
    ├── setup.html         # Wizard de onboarding
    └── setup.js           # JS del wizard
```
