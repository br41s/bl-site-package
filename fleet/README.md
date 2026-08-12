# Inventario de la flota — uso interno

`manifest.json` es la **fuente de verdad de qué despliegues de bl-site-package
existen**. Dar de alta un cliente nuevo es añadir aquí sus entradas (staging y
producción) en una PR; nada más lo sabe por otro camino. `npm test` valida el
fichero, así que un manifest roto no llega a `main`.

## Campos de cada entrada

| Campo | Qué es |
|---|---|
| `id` | Identificador único del despliegue (`<cliente>-<entorno>`). |
| `name` | Nombre legible para informes. |
| `customer` | Cliente al que pertenece, o `null` para instancias propias. |
| `role` | `reference` (nuestra instancia de pruebas, auto-despliega `main`), `staging` o `production`. Debe existir exactamente una entrada `reference`. |
| `url` | URL base, sin barra final. |
| `host` | Dónde corre: `zeabur`, `plesk-passenger`, … Informativo. |
| `driver` | Cómo se despliega una actualización: `manual` (runbook), `zeabur` (API). Hoy solo se usa para saber qué instrucciones generar. |
| `hermes_profile` | Slug del perfil de hermes dedicado a este despliegue (el que crea `provision_bl_client.py`). |
| `password_env` | Variable de entorno de la que `scripts/fleet-check.mjs` lee la contraseña del panel. Nunca se guardan credenciales en este repo. |

## Comprobar la flota

```bash
FLEET_PASSWORD_SHOROBAN_PROD=... node scripts/fleet-check.mjs
```

Para cada despliegue del manifest comprueba que responde y, si hay credenciales
en el entorno, compara su versión (`GET /api/site/status`) con la última
versión publicada en `main`. Sale con código ≠ 0 si algo está caído o
desactualizado, así que puede encadenarse tras un deploy igual que
`scripts/smoke-test.sh`.

Sin la variable de entorno de un despliegue, ese despliegue solo se comprueba
por disponibilidad (la versión requiere autenticación).

El chequeo continuo lo hace el agente de mantenimiento (hermes) con las
credenciales de cada perfil; este script es la vista bajo demanda del operador.

## Historial de rollouts (`rollout-log.jsonl`)

Cada vez que `fleet-check.mjs` confirma por primera vez que un despliegue está
en una versión concreta (`state: ok`), añade una línea a
`fleet/rollout-log.jsonl`:

```json
{"deployment_id":"shoroban-staging","version":"1.0.2","confirmed_at":"2026-08-11T13:02:00.000Z","source":"fleet-check"}
```

Un mismo `(deployment_id, version)` solo se registra una vez, así que correr
el chequeo repetidas veces sobre un despliegue ya al día no genera ruido.
`confirmed_at` es cuándo este script lo *comprobó* por primera vez, no
necesariamente el instante exacto del deploy — el driver `manual` (Plesk) no
deja rastro propio de cuándo se pulsó "Restart App".

Es un fichero versionado (parte del historial del repo, no un log rotable):
sirve para responder "¿cuándo llegó la vX.Y.Z a Shoroban?" sin tener que
rebuscar en esta conversación o en Slack. `npm test` valida que cada línea
tenga forma correcta.
