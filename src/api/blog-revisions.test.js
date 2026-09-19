import { test, describe, before, beforeEach, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// database.js resolves DB_PATH at import time, so point it at a throwaway dir
// before anything that imports it loads. Same reasoning as redirects.test.js.
process.env.DB_PATH = join(mkdtempSync(join(tmpdir(), "bl-site-blog-rev-")), "app.db");
process.env.JWT_SECRET = "test-secret-for-blog-revisions";

const express = (await import("express")).default;
const jwt = (await import("jsonwebtoken")).default;
const db = (await import("../db/database.js")).default;
const router = (await import("./blog.js")).default;
const { hashContent } = await import("../utils/text.js");

const TOKEN = jwt.sign({ role: "admin" }, process.env.JWT_SECRET);

let server;
let baseUrl;

before(async () => {
  const app = express();
  app.use(express.json());
  app.use("/api/blog", router);
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

function api(path, options = {}) {
  return fetch(`${baseUrl}/api/blog${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.auth === false ? {} : { Authorization: `Bearer ${TOKEN}` }),
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

beforeEach(() => {
  db.exec("DELETE FROM article_edits; DELETE FROM article_revisions; DELETE FROM articles;");
});

async function createPost(overrides = {}) {
  const res = await api("/posts", {
    method: "POST",
    body: {
      title: "Mejores CRM para pymes 2026",
      content: "<p>El plazo termina en junio de 2026.</p>",
      excerpt: "Guía de CRM",
      status: "published",
      ...overrides,
    },
  });
  assert.equal(res.status, 201);
  return res.json();
}

describe("content_hash", () => {
  test("is set on create and is the hash of the body", async () => {
    const post = await createPost();
    assert.equal(post.content_hash, hashContent(post.content));
  });

  test("is recomputed from what landed, not from the request", async () => {
    // The caller sends only a title. COALESCE leaves the body alone, so the
    // hash must still describe the old body — hashing the request would
    // fingerprint a body that is not there.
    const post = await createPost();
    const before = post.content_hash;
    const res = await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { title: "Mejores CRM para pymes 2027" },
    });
    const updated = await res.json();
    assert.equal(updated.content_hash, before);
    assert.equal(updated.content_hash, hashContent(updated.content));
  });

  test("changes when the body changes", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>El plazo terminó en junio de 2026.</p>" },
    });
    const updated = await res.json();
    assert.notEqual(updated.content_hash, post.content_hash);
    assert.equal(updated.content_hash, hashContent(updated.content));
  });

  test("is backfilled for rows that predate the column", () => {
    // Simulates a client DB upgraded in place: the row exists with a NULL
    // hash. liveHash() must still answer, or the first proposal against the
    // pre-existing corpus would have to go through unguarded.
    db.prepare(
      "INSERT INTO articles (title, slug, content, status, content_hash) VALUES (?, ?, ?, ?, NULL)",
    ).run("Viejo", "viejo", "<p>cuerpo antiguo</p>", "published");
    const row = db.prepare("SELECT * FROM articles WHERE slug = 'viejo'").get();
    assert.equal(row.content_hash, null);
    // The propose route computes it rather than refusing.
    assert.equal(hashContent(row.content), hashContent("<p>cuerpo antiguo</p>"));
  });
});

describe("PUT stays compatible with existing callers", () => {
  test("a caller that sends no base_hash is not blocked", async () => {
    // The panel, the infographic engineer and the maintenance agent all write
    // this way today. Making base_hash mandatory would have broken every one
    // of them on upgrade day.
    const post = await createPost();
    const res = await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>sin base_hash</p>" },
    });
    assert.equal(res.status, 200);
  });

  test("a stale base_hash is refused with 409 and nothing is written", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>pisa</p>", base_hash: "deadbeefdeadbeef" },
    });
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.current_hash, post.content_hash);
    const after = db.prepare("SELECT content FROM articles WHERE id = ?").get(post.id);
    assert.equal(after.content, post.content);
  });

  test("a matching base_hash goes through", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>nuevo</p>", base_hash: post.content_hash },
    });
    assert.equal(res.status, 200);
  });
});

describe("revisions", () => {
  test("every update leaves the previous body recoverable", async () => {
    const post = await createPost();
    await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>reescrito</p>", author: "content-updater" },
    });

    const res = await api(`/posts/${post.id}/revisions`);
    const { revisions } = await res.json();
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].author, "content-updater");

    const full = await (await api(`/revisions/${revisions[0].id}`)).json();
    assert.equal(full.content, post.content);
  });

  test("a revision is not written when the update is refused", async () => {
    // The snapshot and the update share a transaction. A revision describing a
    // replacement that never happened would be worse than no history, because
    // someone would trust it.
    const post = await createPost();
    await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>x</p>", base_hash: "staaaaaaaaaaaale" },
    });
    const { revisions } = await (await api(`/posts/${post.id}/revisions`)).json();
    assert.equal(revisions.length, 0);
  });

  test("revert restores the old text", async () => {
    const post = await createPost();
    await api(`/posts/${post.id}`, { method: "PUT", body: { content: "<p>malo</p>" } });

    const res = await api(`/posts/${post.id}/revert`, { method: "POST", body: {} });
    assert.equal(res.status, 200);
    const reverted = await res.json();
    assert.equal(reverted.content, post.content);
    assert.equal(reverted.content_hash, hashContent(post.content));
  });

  test("revert is itself undoable", async () => {
    const post = await createPost();
    await api(`/posts/${post.id}`, { method: "PUT", body: { content: "<p>segunda</p>" } });
    await api(`/posts/${post.id}/revert`, { method: "POST", body: {} });

    const { revisions } = await (await api(`/posts/${post.id}/revisions`)).json();
    // one for the edit, one for the revert
    assert.equal(revisions.length, 2);
    const newest = await (await api(`/revisions/${revisions[0].id}`)).json();
    assert.equal(newest.content, "<p>segunda</p>");
  });

  test("a revision belonging to another article is refused", async () => {
    const a = await createPost();
    const b = await createPost({ title: "Otro artículo" });
    await api(`/posts/${a.id}`, { method: "PUT", body: { content: "<p>cambio</p>" } });
    const { revisions } = await (await api(`/posts/${a.id}/revisions`)).json();

    const res = await api(`/posts/${b.id}/revert`, {
      method: "POST",
      body: { revision_id: revisions[0].id },
    });
    assert.equal(res.status, 400);
  });
});

describe("proposed edits", () => {
  test("a proposal never touches the live article", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: {
        content: "<p>El plazo terminó en junio de 2026.</p>",
        reason: "El plazo ya pasó",
        base_hash: post.content_hash,
        evidence: [{ claim: "plazo", source_url: "https://example.gob.es/plazo" }],
      },
    });
    assert.equal(res.status, 201);
    assert.equal((await res.json()).status, "pending");

    const live = db.prepare("SELECT content FROM articles WHERE id = ?").get(post.id);
    assert.equal(live.content, post.content);
  });

  test("base_hash is mandatory", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: { content: "<p>x</p>" },
    });
    assert.equal(res.status, 400);
  });

  test("an empty proposal is refused", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: { base_hash: post.content_hash, reason: "nada" },
    });
    assert.equal(res.status, 400);
  });

  test("evidence must be valid JSON and bounded", async () => {
    const post = await createPost();
    const bad = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: { content: "<p>x</p>", base_hash: post.content_hash, evidence: "{not json" },
    });
    assert.equal(bad.status, 400);

    const huge = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: {
        content: "<p>x</p>",
        base_hash: post.content_hash,
        evidence: [{ note: "x".repeat(6000) }],
      },
    });
    assert.equal(huge.status, 400);
  });

  test("apply publishes it and snapshots what it replaced", async () => {
    const post = await createPost();
    const { id } = await (
      await api(`/posts/${post.id}/propose`, {
        method: "POST",
        body: { content: "<p>corregido</p>", base_hash: post.content_hash, author: "content-updater" },
      })
    ).json();

    const res = await api(`/edits/${id}/apply`, { method: "POST" });
    assert.equal(res.status, 200);
    const live = await res.json();
    assert.equal(live.content, "<p>corregido</p>");
    assert.equal(live.content_hash, hashContent("<p>corregido</p>"));

    const { revisions } = await (await api(`/posts/${post.id}/revisions`)).json();
    assert.equal(revisions.length, 1);
    assert.equal(revisions[0].author, "content-updater");
  });

  test("apply is refused when the article moved under the proposal", async () => {
    // This is the shoroban case: the infographic engineer writes at 02:31 and
    // the maintenance agent at 02:53, so a proposal written earlier in the
    // night routinely finds a different article by the time a human reads it.
    const post = await createPost();
    const { id } = await (
      await api(`/posts/${post.id}/propose`, {
        method: "POST",
        body: { content: "<p>corregido</p>", base_hash: post.content_hash },
      })
    ).json();

    await api(`/posts/${post.id}`, {
      method: "PUT",
      body: { content: "<p>otro agente escribió aquí</p>" },
    });

    const res = await api(`/edits/${id}/apply`, { method: "POST" });
    assert.equal(res.status, 409);

    const live = db.prepare("SELECT content FROM articles WHERE id = ?").get(post.id);
    assert.equal(live.content, "<p>otro agente escribió aquí</p>");

    // Refusing to apply is not deciding the proposal was wrong — it stays in
    // the queue for a human rather than being silently discarded.
    const row = db.prepare("SELECT status FROM article_edits WHERE id = ?").get(id);
    assert.equal(row.status, "pending");
  });

  test("proposing against a stale read is refused up front", async () => {
    const post = await createPost();
    await api(`/posts/${post.id}`, { method: "PUT", body: { content: "<p>movido</p>" } });
    const res = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: { content: "<p>tarde</p>", base_hash: post.content_hash },
    });
    assert.equal(res.status, 409);
  });

  test("a proposal cannot be applied twice", async () => {
    const post = await createPost();
    const { id } = await (
      await api(`/posts/${post.id}/propose`, {
        method: "POST",
        body: { content: "<p>corregido</p>", base_hash: post.content_hash },
      })
    ).json();
    assert.equal((await api(`/edits/${id}/apply`, { method: "POST" })).status, 200);
    assert.equal((await api(`/edits/${id}/apply`, { method: "POST" })).status, 409);
  });

  test("reject takes it out of the queue without touching the article", async () => {
    const post = await createPost();
    const { id } = await (
      await api(`/posts/${post.id}/propose`, {
        method: "POST",
        body: { content: "<p>no</p>", base_hash: post.content_hash },
      })
    ).json();

    const res = await api(`/edits/${id}/reject`, {
      method: "POST",
      body: { reason: "La fuente no es primaria" },
    });
    assert.equal(res.status, 200);

    const live = db.prepare("SELECT content FROM articles WHERE id = ?").get(post.id);
    assert.equal(live.content, post.content);
    assert.equal((await api(`/edits/${id}/apply`, { method: "POST" })).status, 409);
  });

  test("the queue lists pending proposals with their article title", async () => {
    const post = await createPost();
    await api(`/posts/${post.id}/propose`, {
      method: "POST",
      body: { content: "<p>x</p>", base_hash: post.content_hash },
    });
    const { edits } = await (await api("/edits?status=pending")).json();
    assert.equal(edits.length, 1);
    assert.equal(edits[0].article_title, post.title);
  });
});

describe("auth", () => {
  test("the review queue is not world-readable", async () => {
    const res = await api("/edits", { auth: false });
    assert.equal(res.status, 401);
  });

  test("an anonymous caller cannot propose", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/propose`, {
      method: "POST",
      auth: false,
      body: { content: "<p>x</p>", base_hash: post.content_hash },
    });
    assert.equal(res.status, 401);
  });

  test("an anonymous caller cannot revert", async () => {
    const post = await createPost();
    const res = await api(`/posts/${post.id}/revert`, { method: "POST", auth: false, body: {} });
    assert.equal(res.status, 401);
  });
});
