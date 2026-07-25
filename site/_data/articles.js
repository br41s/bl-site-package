import db from "../../src/db/database.js";
import { formatContent } from "../../src/content/format-content.js";

export default function () {
  const rows = db
    .prepare(
      "SELECT * FROM articles WHERE status = 'published' ORDER BY created_at DESC",
    )
    .all();
  return rows.map((a) => ({
    ...a,
    contentHtml: formatContent(a.content),
    dateEs: new Date(a.created_at).toLocaleDateString("es-ES"),
  }));
}
