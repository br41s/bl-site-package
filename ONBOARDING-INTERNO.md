# Checklist de onboarding — Uso interno BigLobster

Este documento es para el equipo de BigLobster. No compartir con el cliente.

---

## Antes de la reunión de venta

- [ ] Enviar formulario de recogida de datos al cliente (ver FORMULARIO-CLIENTE.md)
- [ ] Confirmar plan de web, nivel de inteligencia y agentes adicionales elegidos (del formulario, o de su selección en biglobster.top/agentes-en-alquiler.html si vino por ahí)
- [ ] Confirmar si tienen dominio propio o necesitan uno
- [ ] Confirmar email donde quieren recibir los mensajes de contacto
- [ ] Confirmar que tienen logo en PNG o SVG (fondo transparente)

---

## Setup técnico (20 minutos)

### 1. Crear proyecto en Zeabur

- [ ] Entrar en zeabur.com → New Project
- [ ] Nombre del proyecto: `bl-[nombre-empresa]` (ej: `bl-fontaneria-garcia`)
- [ ] Add Service → Git → seleccionar `braisntext/bl-site-package`
- [ ] Esperar a que el build termine

### 2. Configurar variables de entorno

En Zeabur → tu servicio → Variables:

- [ ] `PANEL_PASSWORD` → contraseña acordada con el cliente
- [ ] `JWT_SECRET` → string aleatorio de 32+ caracteres (usa: `openssl rand -hex 32`)
- [ ] `PORT` → `8080`
- [ ] **NO** configures `OPENROUTER_API_KEY` aquí — el código la prioriza sobre la que el cliente introduce en `/setup`, así que si se pone aquí la del cliente queda ignorada en silencio. La API Key es BYOK: la introduce el cliente (o tú, temporalmente, ver paso 4).

### 3. Configurar volumen persistente

- [ ] Zeabur → tu servicio → Volumes → Add Volume
- [ ] Nombre: `bl-data`
- [ ] Mount path: `/app/data`
- [ ] Guardar y esperar redeploy

### 4. Primer acceso y configuración

- [ ] Abrir `https://[url-zeabur]/setup`
- [ ] Paso 1: nombre de empresa y sector
- [ ] Paso 2: introducir OPENROUTER_API_KEY — si el cliente ya te la compartió, úsala directamente. Si no, usa temporalmente una key de BigLobster desde el panel (**Mi sitio web → Modelo IA**) solo para poder redactar el contenido inicial, y sustitúyela por la del cliente antes de la entrega (ver checklist de entrega)
- [ ] Paso 3: confirmar contraseña del panel
- [ ] Acceder a `https://[url-zeabur]/panel`

### 5. Personalización inicial

- [ ] Mi sitio web → Logo → subir logo del cliente
- [ ] Mi sitio web → Páginas → rellenar textos de las 5 páginas (o usar el agente)
- [ ] Mi sitio web → Modelo IA → **Modelo de imágenes** → elegir el modelo FAL para las portadas del blog y las imágenes de página (por defecto FLUX 2 Klein, rápido y barato). Las imágenes se facturan a la cuenta FAL del cliente (BYOK), como el modelo de texto
- [ ] Mi sitio web → Notificaciones → configurar email del cliente
- [ ] Mi sitio web → Datos legales → rellenar razón social, NIF/CIF, domicilio y email legal (del formulario, sección 1a). Estos datos los tecleas tú o el cliente — el agente de chat no puede escribirlos, a propósito
- [ ] Blog → crear 2-3 artículos iniciales con el agente
- [ ] Verificar que la web pública muestra el contenido correctamente, incluidas `/privacidad` y `/condiciones` (con datos legales, o con el texto genérico si el cliente aún no los tiene)

**Si el cliente contrató agentes adicionales** (Content Gap Hunter, SEO/GEO On-Site, Infographic Engineer, Off-Site GEO Scout): estos **no tienen aprovisionamiento automático todavía** — no hay nada que activar aquí. Hoy el alta es manual vía un perfil de Hermes dedicado (ver `AGENT_RENTAL_SETUP.md` en el repo `hermes-sandbox`); contacta con quien gestione Hermes para darlo de alta caso por caso. Los agentes que generan imágenes (Content Gap Hunter y el Agente de Contenido Inicial) necesitan además la **clave FAL del cliente** (BYOK, para facturarle las imágenes) — pásasela a quien gestione Hermes junto con el resto de datos. Sin clave FAL publican solo texto, sin imágenes.

### 6. Dominio (si procede)

- [ ] Zeabur → Networking → Add Domain → introducir dominio del cliente
- [ ] Pasar al cliente el registro DNS a configurar
- [ ] Verificar que el dominio resuelve correctamente (esperar hasta 1h)
- [ ] Verificar que HTTPS está activo

---

## Entrega al cliente (30 minutos)

- [ ] Confirmar que la API Key de OpenRouter configurada en **Modelo IA** es la del cliente, no una temporal de BigLobster
- [ ] Si el cliente usa imágenes con IA: confirmar que la clave FAL en su perfil de Hermes es la suya (BYOK), y que el modelo de imágenes elegido en **Modelo IA → Modelo de imágenes** es el que quiere
- [ ] Compartir URL del panel + contraseña
- [ ] Mostrar cómo publicar un artículo
- [ ] Mostrar cómo usar el agente de chat
- [ ] Mostrar dónde ver los mensajes de contacto
- [ ] Entregar `INSTRUCCIONES-CLIENTE.md` (exportado a PDF)
- [ ] Acordar canal de soporte (WhatsApp, email, etc.)

---

## Post-entrega (primera semana)

- [ ] Verificar a las 24h que el cliente accedió al panel
- [ ] Verificar que los mensajes de contacto llegan al email configurado
- [ ] Resolver dudas iniciales del cliente
- [ ] Anotar feedback para mejoras del producto

---

## Actualizar el paquete en clientes ya activos

Cuando hay un cambio en `bl-site-package` que hay que llevar a clientes que ya
están en producción, **no se despliega directamente**. Se sigue el proceso
staging-first descrito en [`RELEASE.md`](RELEASE.md): merge a `main` → auto-deploy
en Zeabur (staging) → `scripts/smoke-test.sh` en verde → recién entonces, rollout
a cada servidor de cliente (Plesk) con su propio smoke test.

**Clientes en Plesk/Passenger**: el rollout tiene su propio runbook con los
puntos críticos (document root = `<app>/public`, `DB_PATH` **fuera** del document
root, versión de Node y reconstrucción del binario nativo `better-sqlite3`, y las
variables de entorno). Ver la sección *Runbook de despliegue en cliente
Plesk/Passenger* en [`RELEASE.md`](RELEASE.md). El estándar de `DB_PATH` en
cualquier hosting donde el servidor web sirve el document root directamente es
una ruta **fuera** de ese document root; en Zeabur el `/app/data` por defecto es
seguro porque Express nunca sirve la raíz de la app.

---

## Datos del cliente (rellenar por cada instancia)

| Campo                | Valor                         |
| -------------------- | ----------------------------- |
| Empresa              |                               |
| Sector               |                               |
| URL Zeabur           |                               |
| Dominio propio       |                               |
| Web actual (opcional, para Agente de Contenido Inicial) |                               |
| Email notificaciones |                               |
| Fecha de alta        |                               |
| Estado               | En setup / Entregado / Activo |
