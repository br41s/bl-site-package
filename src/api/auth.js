import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { getConfig } from '../db/database.js';
import { rateLimit } from '../middleware/rateLimit.js';
import {
  getTurnstileSettings,
  isTurnstileConfigured,
  verifyTurnstileToken,
} from '../turnstile.js';

const router = Router();

// Brute-force cap: the panel has a single shared password, so throttle guesses.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Demasiados intentos de acceso. Espera unos minutos.',
});

// First-party rental automation (BigLobster's own agents, see hermes-sandbox
// tools/bl_site_publish_tool.py) authenticates with the panel password like
// anyone else, but can never solve a Turnstile challenge. This shared secret
// lets it skip that check specifically — it does NOT bypass the password
// check below, so a leaked key alone still can't log in on its own.
function isAutomationRequest(req) {
  const expected = process.env.RENTAL_AUTOMATION_KEY || '';
  if (!expected) return false;
  const provided = req.get('X-Automation-Key') || '';
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// Unauthenticated by necessity: the login screen needs the Turnstile site key
// before there's a token to authenticate with. Only the public site key is
// exposed here, same PUBLIC_CONFIG_KEYS split as src/api/site.js.
router.get('/config', (req, res) => {
  res.json({ turnstile_site_key: getTurnstileSettings().siteKey });
});

router.post('/login', loginLimiter, async (req, res) => {
  const { password } = req.body;
  if (!password) return res.status(400).json({ error: 'Contraseña requerida' });

  // Turnstile is opt-in (src/turnstile.js): an instance with no keys
  // configured skips this block, so login keeps working exactly as before.
  if (isTurnstileConfigured() && !isAutomationRequest(req)) {
    const turnstileToken =
      typeof req.body.turnstile_token === 'string' ? req.body.turnstile_token : '';
    const verified = await verifyTurnstileToken(turnstileToken);
    if (!verified) {
      return res
        .status(400)
        .json({ error: 'No se pudo verificar que no eres un robot. Inténtalo de nuevo.' });
    }
  }

  const panelPassword = process.env.PANEL_PASSWORD || getConfig('panel_password');
  if (!panelPassword) {
    return res.status(503).json({ error: 'Panel no configurado. Ve a /setup' });
  }

  if (password !== panelPassword) {
    return res.status(401).json({ error: 'Contraseña incorrecta' });
  }

  const secret = process.env.JWT_SECRET || getConfig('jwt_secret');
  const token = jwt.sign({ role: 'admin' }, secret, { expiresIn: '24h' });

  const companyName = process.env.CLIENT_COMPANY_NAME || getConfig('company_name') || '';

  res.json({ token, companyName });
});

export default router;
