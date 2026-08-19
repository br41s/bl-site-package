# Guía de uso — Tu sitio web con panel de administración

Bienvenido a tu nuevo sitio web. Esta guía explica cómo gestionar tu web, publicar contenido y usar el agente de marketing con inteligencia artificial.

## Acceso al panel de administración

Tu panel de administración está en:
**https://tudominio.com/panel**

Introduce la contraseña que configuraste durante el proceso de instalación.

---

## Primeros pasos — Configuración inicial

La primera vez que accedas a tu web verás el asistente de configuración en:
**https://tudominio.com/setup**

El asistente te pedirá:

1. **Nombre de tu empresa y sector** — aparecerá en toda la web
2. **API Key de OpenRouter** — necesaria para activar el agente de marketing (gratuita en openrouter.ai)
3. **Contraseña del panel** — con la que accederás cada vez

---

## Secciones del panel

### Mi sitio web

Configura los textos de cada página de tu web:

- **Logo** — sube la imagen de tu empresa (PNG, JPG o SVG, máximo 2MB)
- **Páginas** — edita el título, subtítulo y descripción de cada página: Inicio, Quiénes somos, Servicios, Contacto y Blog
- **Modelo IA** — selecciona el modelo de inteligencia artificial para el agente (por defecto: gratuito)
- **Notificaciones** — configura tu email para recibir avisos cuando alguien te contacte

### Blog

Gestiona los artículos de tu web:

- **Nuevo artículo** — escribe el título y contenido, elige si publicarlo o guardarlo como borrador
- **Editar** — modifica cualquier artículo existente
- **Publicar / Despublicar** — controla qué artículos ven tus visitantes
- **Eliminar** — borra artículos que ya no necesites

## Configuración de notificaciones por email

Para recibir un aviso cada vez que alguien te envíe un mensaje desde tu web:

1. Entra en el panel → **Mi sitio web** → pestaña **Notificaciones**
2. Rellena los campos:
   - **Email de notificación**: donde quieres recibir los avisos
   - **Servidor SMTP**: el servidor de tu proveedor de email (ej: `smtp.gmail.com`)
   - **Puerto**: `587` para la mayoría de proveedores
   - **Usuario**: tu dirección de email completa
   - **Contraseña**: la contraseña de tu email (en Gmail, usa una "contraseña de aplicación")
3. Haz click en **Guardar configuración de email**

> **Nota para Gmail:** Google requiere una contraseña de aplicación específica.
> Ve a myaccount.google.com → Seguridad → Verificación en 2 pasos → Contraseñas de aplicación.
> Genera una nueva y úsala en el campo Contraseña.

### Agente de marketing

El agente de inteligencia artificial puede ayudarte a:

- **Crear artículos de blog** — dile el tema y lo escribe por ti (quedará como borrador para que lo revises)
- **Mejorar textos de tu web** — pídele que cambie el título o descripción de cualquier página y lo aplicará directamente
- **Redactar copies** — textos para redes sociales, emails o cualquier comunicación

Ejemplos de lo que puedes pedirle:

> "Escribe un artículo sobre los beneficios de nuestro servicio de limpieza industrial"
> "Cambia el título de la página de inicio a Expertos en mantenimiento industrial desde 1995"
> "Redacta una descripción para la página de servicios"

### Mensajes

Aquí aparecen todos los mensajes que tus visitantes envían a través del formulario de contacto de tu web. Si configuraste las notificaciones, también los recibirás por email.

### Ajustes

- **Ver mi sitio web** — abre tu web en una pestaña nueva
- **Resetear sitio** — borra toda la configuración y el contenido para empezar de cero. **Esta acción no se puede deshacer.**

---

## Conectar tu dominio propio

Si tienes un dominio (por ejemplo, tuempresa.com) y quieres usarlo para tu web:

1. Dile a tu proveedor de servicio el dominio que quieres usar
2. Tu proveedor configurará la conexión en el servidor
3. En tu proveedor de dominio (donde lo compraste), añade el registro DNS que te indique tu proveedor
4. En 5-60 minutos tu web estará disponible en tu dominio con HTTPS activado automáticamente

Si no tienes dominio propio, tu web seguirá funcionando en la dirección que te proporcionó tu proveedor.

---

## Preguntas frecuentes

**¿Olvidé mi contraseña, qué hago?**
Contacta con tu proveedor de servicio para que restablezca la contraseña desde el servidor.

**¿Puedo cambiar la contraseña del panel?**
Actualmente la contraseña se cambia desde el servidor. Próximamente estará disponible desde el propio panel.

**¿El agente de IA tiene coste?**
El modelo por defecto (`openai/gpt-oss-20b:free`) es gratuito. Si seleccionas un modelo de pago en la sección Modelo IA, los costes corresponden a tu cuenta de OpenRouter.

**¿Qué pasa si el agente dice "El agente está saturado"?**
El modelo gratuito tiene límites de uso por minuto. Espera unos segundos y vuelve a intentarlo — el sistema prueba automáticamente con modelos alternativos gratuitos.

**¿Puedo tener más de una persona gestionando el panel?**
Actualmente el panel tiene un único acceso. El soporte multiusuario estará disponible en futuras versiones.

---

## Soporte

Para cualquier consulta técnica o problema con tu web, contacta con tu proveedor de servicio.
