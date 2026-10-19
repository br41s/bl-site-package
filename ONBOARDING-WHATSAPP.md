# Onboarding WhatsApp — Asistente de IA

> Interno. Recorrido completo con el número de BigLobster el 19/10/2026; falta el primer cliente real.

Este documento es para el equipo de BigLobster. No compartir con el cliente (salvo en sesión de formación).

---

## Resumen

El servicio WhatsApp de IA permite que los clientes reciban consultas directas en WhatsApp, respondidas automáticamente por un modelo de lenguaje (OpenRouter) que lee el contenido publicado en su sitio web (`GET /api/knowledge`: empresa, páginas, FAQ, artículos, una muestra del catálogo con nuestras fichas propias primero, todas las categorías y los hechos operativos — precios con IVA, forma de pago, envíos, horario). Un operador humano toma el control para cualquier consulta que el IA no pueda resolver de forma segura o para reservas y compras.

**Requiere:**
- Cuenta de Meta Business verificada
- Un número que el cliente controle para siempre y que no esté en la app de WhatsApp (ver paso 0)
- Método de pago en Meta para las tarifas de WhatsApp (se le factura directamente al cliente, no a BigLobster)
- Chatwoot para gestionar la cola de conversaciones (puede estar en la misma instancia que el cliente o en una instancia compartida)

---

## Checklist de instalación

> Probado de extremo a extremo con el número de BigLobster el 19/10/2026. Las rutas de menú de Meta y Twilio cambian a menudo: si algo no coincide, guíate por lo que pone la pantalla, no por esta lista.

### 0. Elegir el número

El número tiene que poder recibir **una vez** un código por SMS o por llamada, no estar registrado en la app de WhatsApp y **seguir siendo del cliente para siempre**: si lo pierde, pierde su WhatsApp de empresa. Por orden de preferencia:

1. **Su teléfono fijo de siempre.** Meta acepta fijos verificados con llamada de voz. Gratis, ya está en su ficha de Google y sus clientes lo conocen.
2. **Una segunda línea o eSIM** a nombre de la empresa.
3. **Un número virtual de su propiedad.** Twilio: un local +1 cuesta 1,15 $/mes sin papeleo; un +34 exige documentación con dirección en España. Ver el paso 3 para verificarlo.

Evitar: SIM de prepago que caduca si no se recarga (la operadora recicla el número) y números que dependen de un tercero (por ejemplo, el de un agente registrador dentro de su app).

Si el cliente quiere **seguir usando la app WhatsApp Business en su móvil** con el mismo número, eso es *Coexistence*: exige que BigLobster sea Tech Provider de Meta y el Embedded Signup de Chatwoot. Hoy no lo ofrecemos; el número que pase a Cloud API deja de funcionar en la app.

### 1. Portfolio de empresa en Meta

- [ ] El cliente entra en [business.facebook.com](https://business.facebook.com) y crea (o elige) el **portfolio de empresa** con los datos legales de la empresa.
- [ ] Activa la **verificación en dos pasos de su cuenta de Facebook/Meta** (no confundir con el PIN de WhatsApp del paso 5).

### 2. Crear la app de Meta (caso de uso WhatsApp)

- [ ] [developers.facebook.com/apps](https://developers.facebook.com/apps) → **Create app** → caso de uso **Connect with customers through WhatsApp** → vincularla al portfolio del paso 1.
- [ ] Dentro de la app, el caso de uso abre una guía: *Overview*, **Step 1. Try it out** (número de prueba de Meta: no hace falta), **Step 2. Production setup** (lo que usamos) y *Step 3. Business verification*.

### 3. Añadir y verificar el número (Step 2 → *Register your WhatsApp phone number*)

- [ ] **Add new number** → datos de la empresa (nombre legal, web, país) → perfil de WhatsApp (nombre visible, zona horaria, categoría, descripción) → número → método de verificación.
- [ ] El **nombre visible** debe coincidir con el nombre de la empresa o de su web; Meta lo revisa, pero se puede enviar y recibir mientras tanto.
- [ ] Fijo o número virtual: elegir **Phone call**.

**Si el número es de Twilio:** un número +1 sin registro A2P 10DLC aparece como *Messaging disabled*, así que no cuentes con el SMS. Verifica por **llamada**:

1. Twilio → **TwiML Bins → Create new** con:
   ```xml
   <Response><Record maxLength="60" playBeep="false"/></Response>
   ```
2. **Phone Numbers → Active numbers → el número → Configuration details → Voice and emergency address → Edit configuration details** → método principal **TwiML Bin** → ese bin → **Save**.
3. Prueba llamando tú: en **Call logs** debe aparecer la llamada con grabación.
4. En Meta, *Phone call*; el código se escucha en **Call logs → la llamada → Recording**.
5. **Al terminar**, cambia la voz del número: ese bin graba a cualquiera que llame. Si el número va a ser público, pon un buzón con aviso (`<Say>` antes del `<Record>`) y decláralo en la política de privacidad del cliente.

### 4. Usuario de sistema y token permanente

En [business.facebook.com/latest/settings/system_users](https://business.facebook.com/latest/settings/system_users) (portfolio del cliente):

- [ ] **Add** → la primera vez Meta pide aceptar su política de no discriminación en anuncios (la acepta el cliente) → nombre `chatwoot`, rol **Employee**.
- [ ] **Assign assets**:
  - *Apps* → la app del paso 2 → **Develop app**.
  - *WhatsApp accounts* → su WABA → **Manage phone numbers and message templates** + **Messages**.
- [ ] **Generate token** → la app → caducidad **Never** (Chatwoot no renueva tokens) → permisos `whatsapp_business_management` y `whatsapp_business_messaging`.
- [ ] Meta lo muestra **una sola vez**: va directo al gestor de contraseñas. Nunca por chat ni por email.
- [ ] Anota el **Phone Number ID** y el **WhatsApp Business Account ID** que aparecen en Step 2 bajo el número. No son secretos.

### 5. Registrar el número en Cloud API

El número tiene que quedar **Registered** (no *Pending*). El botón **Register** de Step 2 pide un PIN de 6 dígitos nuevo. Si falla con un error genérico y WhatsApp Manager muestra el número como *Pending* («Please register this phone number using the registration API»), regístralo por API desde un terminal; el comando pide token y PIN sin mostrarlos ni dejarlos en el historial:

```bash
read -s "TOKEN?Token: " && echo && read -s "PIN?PIN: " && echo && curl -s -X POST "https://graph.facebook.com/v25.0/<PHONE_NUMBER_ID>/register" -H "Authorization: Bearer $TOKEN" -d messaging_product=whatsapp -d pin="$PIN"; echo
```

`{"success":true}` = registrado. El PIN que pongas **pasa a ser la verificación en dos pasos del número**: guárdalo junto al token; hace falta para volver a registrarlo.

### 6. Crear el inbox de WhatsApp en Chatwoot

En la Account del cliente (Chatwoot 4.17):

- [ ] **Settings → Inboxes → Add Inbox → WhatsApp → WhatsApp Cloud**.
- [ ] Rellenar **Inbox Name**, **Phone number** (formato `+<prefijo><número>`), **Phone number ID**, **Business Account ID** y **API key** (el token del paso 4, lo pega quien lo tenga).
- [ ] **Create WhatsApp Channel** → añadir como agente a la persona que atenderá los traspasos.
- [ ] La pantalla final muestra la **Webhook URL** (`https://<chatwoot>/webhooks/whatsapp/+<número>`) y el **Webhook Verification Token**. Ambos siguen disponibles en el inbox → pestaña **Configuration**.
- [ ] Inbox → pestaña **Bot Configuration** → elegir el Agent Bot de la Account del cliente → **Update**.

### 7. Webhook, suscripciones y publicación en Meta

- [ ] Step 2 → **Configure Webhooks**: *Callback URL* = Webhook URL de Chatwoot, *Verify token* = el de Chatwoot → **Verify and save**.
- [ ] En la misma sección, tabla **Webhook fields**: activar **`messages`**. Viene **desactivado** aunque Meta diga que suscribe los campos comunes; sin él no entra ningún mensaje.
- [ ] Step 2 → *Register your WhatsApp phone number*: interruptor **Subscribe webhooks** de la WABA en azul.
- [ ] **Publicar la app.** Mientras esté *Unpublished*, Meta solo entrega webhooks de prueba: ni los mensajes de los administradores llegan. Antes, en **App settings → Basic**: dominio, URL de privacidad, URL de condiciones, URL de borrado de datos y categoría. Luego **Publish → Publish**.
- [ ] Método de pago: solo hace falta para mensajes que inicia la empresa (plantillas). Responder dentro de las 24 h desde que escribe el cliente no lo necesita.

### 8. Prueba de extremo a extremo

- [ ] Desde un móvil personal, escribir al número (`https://wa.me/<número sin +>`).
- [ ] En Chatwoot, la conversación entra en el inbox como **Pending** mientras la lleva el bot: no sale con el filtro por defecto (*Open*); cambia el filtro de estado.
- [ ] La respuesta del bot debe figurar como **delivered** (Meta confirmó la entrega) y llegar al móvil.
- [ ] `GET https://bl-whatsapp-bot.zeabur.app/health` → `lastOpenRouterCallAt` reciente y `lastOpenRouterCallOk: true`.

---

## Chat en la web del cliente (sin Meta)

El mismo bot atiende un inbox de tipo *website* de Chatwoot. Alta: en la Account del cliente crear un inbox **Website** (dominio de su web, sin recoger email, Agent Bot enganchado), copiar su *website token* y la URL base de Chatwoot, y pasárselos al cliente: los pega en panel → Mi sitio web → Integraciones → **Asistente de IA: chat en tu web** (bloque con icono **?** que contiene sus instrucciones), marca la casilla y guarda. El sitio añade el origen de Chatwoot a su CSP y carga el widget en la siguiente publicación. En el registro del bot, la entrada del cliente es la misma que para WhatsApp.

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
| **answersPricing** | true / false | `true` si el cliente publica sus precios (todo cliente con catálogo): el bot los cita en vez de pasar cada pregunta de precio a una persona |
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
| Mensajes no llegan a Chatwoot | Campo `messages` no suscrito, WABA sin suscribir o app sin publicar | Step 2 → Configure Webhooks → Webhook fields → `messages` activado; *Subscribe webhooks* de la WABA activado; app **Published** |
| El número sigue *Pending* en WhatsApp Manager | El botón Register del panel falló (error genérico) | Registrarlo por API con el comando del paso 5 |
| No llega el SMS de verificación a un número de Twilio | Número +1 sin registro A2P: *Messaging disabled* | Verificar por llamada con el TwiML Bin del paso 3 |
| La conversación no aparece en el inbox | Está en *Pending* (la lleva el bot) y el filtro por defecto es *Open* | Cambiar el filtro de estado a *Pending* o *All* |
| Chatwoot no se conecta a WABA | ID incorrecto o token expirado | Copia y pega sin espacios; renueva el token si falta hace meses |
| Respuestas tardan mucho | Congestión de Red o problema en el IA | Mira logs de Chatwoot y OpenRouter; espera o reinicia |
| El IA no responde, Chatwoot sí | Knowledge base token no válido | Revisa que el cliente haya generado el token con permisos de lectura |
