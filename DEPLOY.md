# Conectar dominio propio en Zeabur

## Requisitos
- Acceso al panel DNS de tu dominio (GoDaddy, Namecheap, Cloudflare, etc.)
- El sitio ya desplegado y funcionando en Zeabur

## Pasos

### 1. Añadir el dominio en Zeabur
1. Entra en tu proyecto de Zeabur
2. Haz click en el servicio → pestaña **Networking** o **Domains**
3. Click en **Add Domain**
4. Escribe tu dominio, por ejemplo `tuempresa.com`
5. Zeabur te mostrará un registro DNS que debes añadir

### 2. Configurar el DNS
En el panel de tu proveedor de dominio, añade un registro:
- **Tipo:** CNAME
- **Nombre/Host:** `@` o `www` (según lo que indique Zeabur)
- **Valor:** la URL que te da Zeabur (algo como `tu-servicio.zeabur.app`)
- **TTL:** 300 (o el mínimo disponible)

Si tu proveedor no permite CNAME en el apex (`@`), usa un registro A con la IP que te indique Zeabur.

### 3. HTTPS
Zeabur activa HTTPS automáticamente vía Let's Encrypt una vez que detecta el DNS configurado. No requiere ninguna acción adicional. El proceso tarda entre 5 y 15 minutos.

### 4. Verificar
Una vez propagado el DNS (puede tardar hasta 24h, normalmente menos de 1h):
- `https://tudominio.com/setup` → debe cargar el wizard
- `https://tudominio.com/panel` → debe cargar el panel
- El certificado HTTPS debe aparecer válido en el navegador

## Variables de entorno recomendadas con dominio propio
No es necesario cambiar ninguna variable de entorno para el dominio. El servidor usa rutas relativas en todo momento.

---

# Protección anti-spam del panel y el contacto (Cloudflare Turnstile)

**Obligatorio en toda alta nueva.** Hasta ahora Turnstile se activaba caso por caso, cuando
un cliente ya sufría spam o intentos de acceso al panel (así llegó a activarse en Shoroban).
A partir de ahora se configura en el setup técnico de cualquier cliente nuevo, antes de la
entrega, en vez de esperar a que aparezca el problema. Los clientes ya desplegados sin
Turnstile no se tocan retroactivamente por este cambio.

Protege dos superficies con el mismo par de claves: el formulario de contacto público
(`site/contacto.njk`) y el login del panel (`web/panel.html`). El código ya soporta esto
desde siempre — `src/turnstile.js` activa la comprobación en cuanto detecta una site key y
una secret key configuradas (`isTurnstileConfigured()`); sin claves, ambas superficies
funcionan exactamente igual que antes. Lo único que cambia es que ahora esa configuración
es un paso obligatorio del alta, no una opción que el cliente descubre más tarde en
`INSTRUCCIONES-CLIENTE.md`.

## Requisitos
- El dominio del cliente ya funcionando (ver arriba) — Turnstile se da de alta contra un
  dominio real, no tiene sentido crearlo antes
- Acceso a una cuenta de Cloudflare (gratuita; la del propio BigLobster sirve para todos
  los clientes, no hace falta una por cliente)

## Pasos

### 1. Crear el widget en Cloudflare
1. Entra en [dash.cloudflare.com → Turnstile](https://dash.cloudflare.com/?to=/:account/turnstile)
2. **Add widget** → añade el dominio del cliente (y el subdominio `*.zeabur.app` si todavía
   vas a probar ahí antes de que el DNS propague)
3. Modo **Managed** (el que ya usa Shoroban)
4. Copia la **Site key** y la **Secret key**

### 2. Configurar las claves en el sitio del cliente
Panel del cliente → **Mi sitio web** → pestaña **Integraciones** → bloque
**Protección anti-spam (Turnstile)** → pega ambas claves → **Guardar configuración de
Turnstile**.

Alternativa sin tocar el panel: variables de entorno `TURNSTILE_SITE_KEY` /
`TURNSTILE_SECRET_KEY` en Zeabur (tienen prioridad sobre lo guardado en el panel, igual que
el resto de credenciales — ver tabla de variables de entorno en `README.md`).

### 3. Dar de alta la clave de automatización
En cuanto el login tiene Turnstile activo, cualquier acceso automatizado necesita saltárselo
— en concreto los agentes de hermes que publican en el sitio del cliente
(`bl_site_publish_tool.py` en `hermes-sandbox`) y `scripts/fleet-check.mjs`.

- [ ] Genera un valor aleatorio (`openssl rand -hex 32`) y config­úralo como
  `RENTAL_AUTOMATION_KEY` en las variables de entorno del servidor del cliente
- [ ] Pásaselo a quien gestione Hermes junto con el resto de credenciales del cliente, para
  que sus agentes lo manden en la cabecera `X-Automation-Key`
- [ ] Añade `automation_key_env` a la entrada de este despliegue en `fleet/manifest.json`
  (ver `fleet/README.md`) apuntando a la variable de entorno donde guardes ese valor —
  sin esto, `fleet-check.mjs` no puede leer la contraseña del panel y reporta el
  despliegue como «estado ilegible» en vez de comprobar su versión

### 4. Verificar
- `https://tudominio.com/panel` → debe aparecer el widget de Turnstile antes de poder
  pulsar el botón de acceso
- Entra con la contraseña del panel y resuelve el captcha → debe entrar con normalidad
- `https://tudominio.com/contacto` → debe aparecer el mismo widget antes de poder enviar el
  formulario