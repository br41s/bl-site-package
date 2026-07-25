import { Router } from "express";
import { requireAuth } from "../middleware/auth.js";
import { rateLimit } from "../middleware/rateLimit.js";
import db, { getConfig, setConfig } from "../db/database.js";
import { scheduleRebuild } from "../build/rebuild.js";

const router = Router();

// Authenticated, but cap request rate so a leaked/shared panel password can't
// drain the client's BYOK OpenRouter credit.
const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: "Demasiadas peticiones al asistente, espera un momento.",
});
const DEFAULT_AGENT_MODEL = "gpt-oss-20b:free";
const FREE_MODELS_FALLBACK = [
  "gpt-oss-20b:free",
  "meta-llama/llama-3.1-8b-instruct:free",
  "mistralai/mistral-7b-instruct:free",
  "google/gemma-3-4b-it:free",
  "meta-llama/llama-3.2-3b-instruct:free",
];
const ALLOWED_TEXT_KEYS = new Set([
  "page_index_title",
  "page_index_subtitle",
  "page_index_desc",
  "page_index_body",
  "page_quienes_title",
  "page_quienes_subtitle",
  "page_quienes_desc",
  "page_servicios_title",
  "page_servicios_subtitle",
  "page_servicios_desc",
  "page_contacto_title",
  "page_contacto_subtitle",
  "page_contacto_desc",
  "page_blog_title",
  "page_blog_subtitle",
]);

function generateSlug(title) {
  return title
    .toLowerCase()
    .normalize("NFD")
    .replaceAll(/[\u0300-\u036f]/g, "")
    .replaceAll(/[^a-z0-9\s-]/g, "")
    .trim()
    .replaceAll(/\s+/g, "-")
    .replaceAll(/-+/g, "-");
}

function createUniqueArticleSlug(title) {
  let slug = generateSlug(title);
  let suffix = 0;

  while (
    db
      .prepare("SELECT id FROM articles WHERE slug = ?")
      .get(slug + (suffix ? `-${suffix}` : ""))
  ) {
    suffix++;
  }

  if (suffix) slug = `${slug}-${suffix}`;
  return slug;
}

function applyUpdateTextsAction(data) {
  if (!data || typeof data !== "object") {
    return {
      actionResult: { type: "texts_updated", keys: [], rejected: [] },
      feedback:
        "\n\n⚠️ No reconocí las secciones que intenté modificar. Dime exactamente qué página quieres cambiar (Inicio, Quiénes somos, Servicios, Contacto o Blog).",
    };
  }

  const updatedKeys = [];
  const rejectedKeys = [];
  for (const [key, value] of Object.entries(data)) {
    if (!ALLOWED_TEXT_KEYS.has(key) || value === undefined || value === null) {
      rejectedKeys.push(key);
      continue;
    }
    setConfig(key, String(value));
    updatedKeys.push(key);
  }

  let feedback = "";
  if (!updatedKeys.length) {
    feedback =
      "\n\n⚠️ No reconocí las secciones que intenté modificar. Dime exactamente qué página quieres cambiar (Inicio, Quiénes somos, Servicios, Contacto o Blog).";
  } else if (rejectedKeys.length) {
    feedback =
      "\n\n✓ Actualicé: " +
      updatedKeys.join(", ") +
      ". No reconocí: " +
      rejectedKeys.join(", ") +
      ".";
  }

  return {
    actionResult: {
      type: "texts_updated",
      keys: updatedKeys,
      rejected: rejectedKeys,
    },
    feedback,
  };
}

function applyCreateArticleAction(data) {
  if (!data || typeof data !== "object")
    return { actionResult: null, feedback: "" };

  const title = typeof data.title === "string" ? data.title.trim() : "";
  const content = typeof data.content === "string" ? data.content.trim() : "";
  const excerpt = typeof data.excerpt === "string" ? data.excerpt.trim() : "";
  const status = data.status === "published" ? "published" : "draft";

  if (!title || !content) return { actionResult: null, feedback: "" };

  const slug = createUniqueArticleSlug(title);
  db.prepare(
    "INSERT INTO articles (title, slug, content, excerpt, status) VALUES (?, ?, ?, ?, ?)",
  ).run(title, slug, content, excerpt, status);
  scheduleRebuild();

  return { actionResult: { type: "article_created" }, feedback: "" };
}

function resolveActionResult(action) {
  if (!action || typeof action !== "object")
    return { actionResult: null, feedback: "" };
  if (action.type === "update_texts")
    return applyUpdateTextsAction(action.data);
  if (action.type === "create_article")
    return applyCreateArticleAction(action.data);
  return { actionResult: null, feedback: "" };
}

function applyAgentAction(reply) {
  const actionMatch = reply.match(/<ACTION>([\s\S]*?)<\/ACTION>/);
  let cleanReply = reply.replace(/<ACTION>[\s\S]*?<\/ACTION>/, "").trim();
  let actionResult = null;
  let feedback = "";

  if (!actionMatch) {
    return { reply: cleanReply || reply.trim(), actionResult };
  }

  try {
    const action = JSON.parse(actionMatch[1]);
    const resolved = resolveActionResult(action);
    actionResult = resolved.actionResult;
    feedback = resolved.feedback || "";
  } catch {
    feedback =
      "\n\n⚠️ Intenté aplicar cambios al sitio pero la respuesta no tenía el formato correcto. Puedes pedirme que lo intente de nuevo.";
  }

  if (feedback) {
    cleanReply = (cleanReply || reply.trim()) + feedback;
  }

  return { reply: cleanReply || reply.trim(), actionResult };
}

async function requestChatCompletion({
  apiKey,
  model,
  messages,
  companyName,
  sector,
}) {
  const response = await fetch(
    "https://openrouter.ai/api/v1/chat/completions",
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + apiKey,
        "Content-Type": "application/json",
        "HTTP-Referer": "https://github.com/braisntext/bl-site-package",
      },
      body: JSON.stringify({
        model,
        messages: [
          {
            role: "system",
            content: `Eres el agente de marketing de ${companyName}, empresa del sector ${sector}.
Tu especialidad es crear contenido de marketing: artículos de blog, textos para páginas web y copies persuasivos.

Tienes acceso directo al sitio web del cliente. Cuando el cliente te pida modificar textos de alguna página, DEBES responder con un JSON de acción además del texto.

Si el cliente pide cambiar textos de una página, responde SIEMPRE con este formato exacto al final de tu mensaje:
<ACTION>{"type":"update_texts","data":{"key":"valor","key2":"valor2"}}</ACTION>

Las keys disponibles para cada página son:
- Inicio: page_index_title, page_index_subtitle, page_index_desc (blurb corto del héroe), page_index_body (cuerpo largo en Markdown, debajo del héroe)
- Quiénes somos: page_quienes_title, page_quienes_subtitle, page_quienes_desc
- Servicios: page_servicios_title, page_servicios_subtitle, page_servicios_desc
- Contacto: page_contacto_title, page_contacto_subtitle, page_contacto_desc
- Blog: page_blog_title, page_blog_subtitle

Si el cliente pide crear un artículo de blog, responde con:
<ACTION>{"type":"create_article","data":{"title":"título","content":"contenido completo","excerpt":"resumen corto","status":"draft"}}</ACTION>

NO puedes modificar los datos legales del sitio (razón social, NIF/CIF, domicilio, email legal de las páginas de Privacidad y Aviso Legal). Si el cliente pide cambiarlos, indícale que los edite él mismo en el panel: Mi sitio → Datos legales.

Si no hay acción que aplicar, no incluyas el bloque ACTION.`,
          },
          ...messages,
        ],
      }),
    },
  );

  const rawBody = await response.text();
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      rawBody,
      reply: null,
    };
  }

  const data = rawBody ? JSON.parse(rawBody) : {};
  const replyContent =
    data.choices?.[0]?.message?.content || data.choices?.[0]?.text || null;

  return {
    ok: true,
    status: response.status,
    rawBody,
    reply: typeof replyContent === "string" ? replyContent.trim() : null,
  };
}

// POST /api/chat/send
router.post("/send", requireAuth, chatLimiter, async (req, res) => {
  const { message } = req.body;
  if (!message) return res.status(400).json({ error: "Mensaje requerido" });

  const apiKey =
    process.env.OPENROUTER_API_KEY?.trim() ||
    getConfig("openrouter_api_key")?.trim();
  if (!apiKey) {
    return res.json({
      reply:
        "Configura tu OpenRouter API Key en /setup para activar el agente de contenidos.",
    });
  }

  const companyName =
    process.env.CLIENT_COMPANY_NAME ||
    getConfig("company_name") ||
    "la empresa";
  const sector =
    process.env.CLIENT_SECTOR || getConfig("sector") || "industria";
  const configuredModel = getConfig("ai_model")?.trim();
  const model =
    configuredModel && configuredModel !== "null"
      ? configuredModel
      : DEFAULT_AGENT_MODEL;
  const modelsToTry = [
    model,
    ...FREE_MODELS_FALLBACK.filter((candidate) => candidate !== model),
  ];

  const history = db
    .prepare("SELECT role, content FROM chat_history ORDER BY id DESC LIMIT 10")
    .all()
    .reverse();

  const messages = [
    ...history.map((r) => ({ role: r.role, content: r.content })),
    { role: "user", content: message },
  ];

  try {
    for (const candidateModel of modelsToTry) {
      const result = await requestChatCompletion({
        apiKey,
        model: candidateModel,
        messages,
        companyName,
        sector,
      });

      if (result.ok && result.reply) {
        const applied = applyAgentAction(result.reply);
        db.prepare(
          "INSERT INTO chat_history (role, content) VALUES (?, ?)",
        ).run("user", message);
        db.prepare(
          "INSERT INTO chat_history (role, content) VALUES (?, ?)",
        ).run("assistant", applied.reply);

        return res.json({
          reply: applied.reply,
          action: applied.actionResult,
          model: candidateModel,
        });
      }

      if (!result.ok && result.status !== 429) {
        return res
          .status(502)
          .json({ error: "Error al contactar el agente de contenidos." });
      }
    }

    return res.json({
      reply:
        "El agente está saturado en este momento. Inténtalo en unos segundos.",
    });
  } catch (err) {
    console.error("Chat error:", err);
    res
      .status(500)
      .json({ error: "Error al contactar el agente de contenidos." });
  }
});

export default router;
