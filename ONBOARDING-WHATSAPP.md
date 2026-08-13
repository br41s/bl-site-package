# Onboarding WhatsApp — Asistente de IA

> DRAFT interno — pendiente de probarse con un cliente real antes de considerarse definitivo.

Este documento es para el equipo de BigLobster. No compartir con el cliente (salvo en sesión de formación).

---

## Resumen

El servicio WhatsApp de IA permite que los clientes reciban consultas directas en WhatsApp, respondidas automáticamente por un modelo de lenguaje (OpenRouter) que lee el contenido publicado en su sitio web. Un operador humano toma el control para cualquier consulta que el IA no pueda resolver de forma segura o para reservas y compras.

**Requiere:**
- Cuenta de Meta Business verificada
- Número de teléfono sin registrar en la app móvil de WhatsApp
- Método de pago en Meta para las tarifas de WhatsApp (se le factura directamente al cliente, no a BigLobster)
- Chatwoot para gestionar la cola de conversaciones (puede estar en la misma instancia que el cliente o en una instancia compartida)

---

## Checklist de instalación

### 1. Crear una cuenta de Meta Business y activar 2FA

- [ ] El cliente accede a [business.facebook.com](https://business.facebook.com)
- [ ] Crea una cuenta de Meta Business (si no tiene una ya)
- [ ] Verifica su identidad y la información fiscal
- [ ] **Activa la verificación en dos pasos** (Settings → Security → Two-Factor Authentication)

**Por qué:** Meta requiere autenticación de dos factores para crear y administrar WABAs.

---

### 2. Crear una App de Meta y añadir el producto WhatsApp

- [ ] En business.facebook.com, ir a **Apps & Assets → Apps** → **Create App**
- [ ] Tipo de app: **Business**
- [ ] Nombre de la app: `[Nombre empresa] WhatsApp` (ej: `Fontanería García WhatsApp`)
- [ ] Una vez creada la app, en el panel de la app: **Add Products → WhatsApp**

**Por qué:** La app es el contenedor de credenciales. WhatsApp es un producto dentro de la app.

---

### 3. Crear una WABA (WhatsApp Business Account) y añadir un número

- [ ] En el producto WhatsApp → **Getting Started → Create Account** (o **Accounts** si ya hay WABAs)
- [ ] Rellena el nombre de la empresa, sector y página web del cliente
- [ ] Toca **Create Account**
- [ ] Elige un número de teléfono que **NO esté actualmente registrado en ningún dispositivo con la app móvil de WhatsApp**

**IMPORTANTE:** Migrar un número existente de WhatsApp personal es un proceso de Meta de 24–72 horas que lo elimina de la app normal durante ese tiempo. Avisar al cliente con claridad: si usa WhatsApp en su móvil, necesita un número diferente (una segunda línea, una eSIM, o esperar a migrar y quedar sin WhatsApp personal durante el proceso). La mayoría de clientes pequeños prefieren comprar un segundo número.

- [ ] Meta envía un código SMS a ese teléfono. Verifica el código en la web.
- [ ] Una vez verificado, el número aparece en la WABA.

---

### 4. Añadir un método de pago

- [ ] En la WABA → **Settings → Billing** (o en la app → **Billing**)
- [ ] Toca **Add Payment Method**
- [ ] Rellena los datos de tarjeta o cuenta bancaria del cliente
- [ ] Meta le enviará una factura mensual a ese método de pago

**Importante:** El cliente paga directamente a Meta por las tarifas de conversación (normalmente entre 5€ y 30€/mes según volumen). BigLobster cobra por infraestructura (49€/mes) aparte.

---

### 5. Generar un token de acceso permanente y anotar IDs

- [ ] En el producto WhatsApp → **Configuration → Access Tokens**
- [ ] Genera un token con alcance `whatsapp_business_messaging` y `whatsapp_business_management`
- [ ] Copia el token (lo necesitarás en el paso 6)
- [ ] En la WABA → **Settings**, anota:
  - `phone_number_id` (formato: número largo de dígitos)
  - `business_account_id` (WABA ID)
- [ ] En la App de Meta → **Settings → Basic**, anota:
  - `app_id`
  - `app_secret` (guárdalo bien)

**Por qué:** Chatwoot necesita estos datos para conectarse a la WABA.

---

### 6. Crear el inbox de WhatsApp en Chatwoot

Este paso va en la instancia de Chatwoot donde atienda el cliente (puede ser compartida o dedicada).

- [ ] Chatwoot → **Settings → Inboxes → Add Inbox**
- [ ] Tipo: **WhatsApp Cloud**
- [ ] Rellena:
  - **Access Token** → el token del paso 5
  - **Phone Number ID** → el del paso 5
  - **Business Account ID** → el del paso 5
- [ ] Toca **Create WhatsApp Channel**

Chatwoot valida los datos en tiempo real. Si hay un error, comprueba que:
- El token es válido y no está expirado
- El `phone_number_id` y `business_account_id` son los correctos
- La WABA tiene un número verificado

---

### 7. Configurar el webhook en la App de Meta

- [ ] En la App de Meta → **WhatsApp → Configuration → Webhook**
- [ ] Copia la **URL de webhook** que Chatwoot te da en el inbox de WhatsApp (normalmente algo como `https://chatwoot.example.com/webhooks/whatsapp_cloud/[inbox_id]`)
- [ ] Pégala en el campo **Webhook URL** de Meta
- [ ] Rellena el **Verify Token** (puede ser cualquier string, pero Chatwoot sugiere uno específico — revisa el inbox)
- [ ] Toca **Verify and Save**

Meta envía una petición GET a esa URL. Si Chatwoot responde correctamente, el webhook queda validado.

- [ ] Una vez validado, en **Subscribe to Webhook Fields**, marca explícitamente:
  - [ ] `messages`
  - [ ] (optativo: `message_status` para ver si se entregó/leyó)

**Importante:** A veces Meta no suscribe automáticamente a `messages`. Marca explícitamente o los mensajes entrantes no llegarán a Chatwoot.

---

### 8. Enviar un mensaje de prueba de extremo a extremo

- [ ] Desde un teléfono personal (no el número de negocio), envía un mensaje al número de la WABA
- [ ] Espera 2–3 segundos
- [ ] En Chatwoot → el inbox de WhatsApp debe mostrar una nueva conversación con el número del cliente
- [ ] Responde desde Chatwoot
- [ ] Espera 2–3 segundos
- [ ] En el teléfono personal, recibirás la respuesta de Chatwoot

Si algo falla:
- Revisa los logs de Chatwoot (`docker logs chatwoot_rails` si está en contenedor)
- Comprueba que el webhook está "Connected" en Meta App → WhatsApp Configuration
- Verifica que `phone_number_id` y `business_account_id` en Chatwoot son exactos (sin espacios)

---

## Datos a registrar por cliente

Rellena esto por cada cliente que contraste WhatsApp:

| Campo | Valor | Notas |
|-------|-------|-------|
| **Nombre cliente** | | |
| **Teléfono WABA** | | Número verificado en Meta |
| **WABA ID** | | Del Settings de la WABA |
| **Phone Number ID** | | Para Chatwoot |
| **Chatwoot Account ID** | | Instancia de Chatwoot donde está el inbox |
| **Chatwoot Inbox ID** | | ID del inbox de WhatsApp |
| **URL del sitio web** | | Para que el IA lea el contenido |
| **Knowledge Base Token** | | Token de acceso a la API del cliente para que el IA lea su sitio |
| **Fecha de alta** | | |
| **Estado** | Setup / Activo / Paused | |

---

## Verificación

Antes de entregar al cliente, valida:

- [ ] Un mensaje enviado desde un teléfono personal al número de negocio aparece en Chatwoot en menos de 5 segundos
- [ ] Una respuesta desde Chatwoot llega al teléfono en menos de 5 segundos
- [ ] El número se ve como una empresa en WhatsApp (ícono de negocio, nombre de empresa)
- [ ] Chatwoot muestra el nombre del contacto y su número correctamente
- [ ] El IA responde a una consulta de prueba con información del sitio web del cliente

---

## Troubleshooting rápido

| Problema | Causa probable | Solución |
|----------|------------------|----------|
| "Webhook validation failed" en Meta | Verify Token incorrecto o webhook URL no responde | Revisa que el token coincida en Meta y Chatwoot; reintenta |
| Mensajes no llegan a Chatwoot | Campo `messages` no suscrito en Meta | Vuelve a Settings → Webhook → marca `messages` explícitamente |
| Chatwoot no se conecta a WABA | ID incorrecto o token expirado | Copia y pega sin espacios; renueva el token si falta hace meses |
| Respuestas tardan mucho | Congestión de Red o problema en el IA | Mira logs de Chatwoot y OpenRouter; espera o reinicia |
| El IA no responde, Chatwoot sí | Knowledge base token no válido | Revisa que el cliente haya generado el token con permisos de lectura |
