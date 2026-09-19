// table-scroll.mjs — envuelve cada <table> en un contenedor con scroll propio.
//
// POR QUÉ EXISTE
// Una tabla no se puede comprimir por debajo de su min-content: el ancho de la
// celda más larga es un suelo duro, y `width:100%` es un deseo, no un límite.
// Una comparativa de 5 columnas pide ~565px, así que en un móvil de 375px la
// tabla no encoge: empuja el documento entero y arrastra la cabecera, el texto
// y el pie fuera de la pantalla. En escritorio nunca se alcanza ese suelo, así
// que el fallo es invisible mientras redimensionas la ventana.
//
// Aquí importa más que en un sitio normal: el cuerpo de los artículos y de las
// páginas es HTML arbitrario que sale de la base de datos
// (`{{ post.contentHtml | safe }}`), escrito por el panel o el agente del
// cliente. No hay ningún fichero fuente que corregir a mano, así que el build
// es el único punto por el que ese HTML pasa antes de servirse.
//
// LA REGLA
// El contenido escribe <table> a secas. El wrapper lo pone el build. El
// desbordamiento se queda DENTRO de la tabla en lugar de arrastrar la página,
// sin que nadie — ni el cliente — tenga que acordarse de nada.
//
// Es idempotente: una tabla ya envuelta a mano se deja intacta.
//
// Envuelve TODAS las tablas, pero el CSS solo estiliza las que están dentro de
// .site-page-body / .site-post-body, que es donde vive el HTML de cliente. El
// wrapper que rodea a .cart-table y .product-specs (markup del propio paquete,
// estrecho por diseño) queda inerte: un <div> sin estilos, sin margen y sin
// altura, que no afecta al `hidden` del carrito.
//
// Portado de br41s/biglobster (lib/table-scroll.mjs). El código es IDÉNTICO a
// propósito: la diferencia de política vive en el CSS, no aquí. Si arreglas
// algo en uno de los dos, cópialo tal cual en el otro.

const TOKEN_RE = /<table\b[^>]*>|<\/table\s*>/gi;

// Un <div class="...table-scroll..."> inmediatamente antes de la tabla,
// ignorando espacios en blanco.
const ALREADY_WRAPPED_RE = /<div[^>]*\bclass="[^"]*\btable-scroll\b[^"]*"[^>]*>\s*$/i;

const LABEL = { es: "Tabla, desplazable horizontalmente", en: "Table, scrolls horizontally" };

// Localiza los pares <table>…</table> de nivel superior. Cuenta anidación para
// no cerrar en la </table> de una tabla interior.
function findTables(html) {
  const spans = [];
  let depth = 0;
  let start = 0;
  let m;
  TOKEN_RE.lastIndex = 0;
  while ((m = TOKEN_RE.exec(html)) !== null) {
    if (m[0][1] === "/") {
      if (depth === 0) continue; // </table> suelta: markup roto, no tocar
      depth -= 1;
      if (depth === 0) spans.push([start, m.index + m[0].length]);
    } else {
      if (depth === 0) start = m.index;
      depth += 1;
    }
  }
  return depth === 0 ? spans : []; // <table> sin cerrar: no tocar nada
}

export default function tableScroll(eleventyConfig) {
  eleventyConfig.addTransform("table-scroll", function (content) {
    if (!(this.page.outputPath || "").endsWith(".html")) return content;

    const spans = findTables(content);
    if (!spans.length) return content;

    const lang = /<html[^>]*\blang="([a-z]{2})/i.exec(content)?.[1] || "es";
    const label = LABEL[lang] || LABEL.es;

    // De atrás hacia delante para que los índices no se desplacen.
    let out = content;
    for (let i = spans.length - 1; i >= 0; i -= 1) {
      const [from, to] = spans[i];
      if (ALREADY_WRAPPED_RE.test(out.slice(0, from))) continue;
      const table = out.slice(from, to);
      out =
        out.slice(0, from) +
        `<div class="table-scroll" role="region" aria-label="${label}" tabindex="0">` +
        table +
        `</div>` +
        out.slice(to);
    }
    return out;
  });
}
