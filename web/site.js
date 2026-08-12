/* Public site client behaviors — content is now server-rendered by Eleventy
   at build time (see site/ + eleventy.config.mjs); this only wires up the
   interactive bits that can't be done at build time. */

/* THEME (dark mode) */
var ICON_MOON =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M21.752 15.002A9.72 9.72 0 0 1 18 15.75c-5.385 0-9.75-4.365-9.75-9.75 0-1.33.266-2.597.748-3.752A9.753 9.753 0 0 0 3 11.25C3 16.635 7.365 21 12.75 21a9.753 9.753 0 0 0 9.002-5.998Z"/></svg>';
var ICON_SUN =
  '<svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" stroke-width="1.6" stroke="currentColor" width="18" height="18"><path stroke-linecap="round" stroke-linejoin="round" d="M12 3v2.25m6.364.386-1.591 1.591M21 12h-2.25m-.386 6.364-1.591-1.591M12 18.75V21m-4.773-4.227-1.591 1.591M5.25 12H3m4.227-4.773L5.636 5.636M15.75 12a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0Z"/></svg>';

function setTheme(t) {
  document.documentElement.dataset.theme = t;
  var b = document.getElementById("theme-toggle");
  if (!b) return;
  b.innerHTML = t === "dark" ? ICON_SUN : ICON_MOON;
  b.setAttribute(
    "aria-label",
    t === "dark" ? "Cambiar a modo claro" : "Cambiar a modo oscuro",
  );
}

function initTheme() {
  var s = localStorage.getItem("bl-theme");
  var d = window.matchMedia("(prefers-color-scheme: dark)").matches;
  setTheme(s || (d ? "dark" : "light"));
  var b = document.getElementById("theme-toggle");
  if (b && !b._ready) {
    b._ready = true;
    b.addEventListener("click", function () {
      var c = document.documentElement.dataset.theme;
      var n = c === "dark" ? "light" : "dark";
      localStorage.setItem("bl-theme", n);
      setTheme(n);
    });
  }
}

var _revealObserver = null;
function initReveals() {
  if (_revealObserver) _revealObserver.disconnect();
  _revealObserver = new IntersectionObserver(
    function (entries) {
      entries.forEach(function (e) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          _revealObserver.unobserve(e.target);
        }
      });
    },
    { threshold: 0.12 },
  );
  document.querySelectorAll(".reveal").forEach(function (el) {
    _revealObserver.observe(el);
  });
}

function initCookieConsent() {
  var banner = document.getElementById("cookie-banner");
  if (!banner) return;
  if (localStorage.getItem("bl-cookie-consent") === "accepted") return;
  banner.style.display = "flex";
  var btn = document.getElementById("cookie-accept");
  if (btn && !btn._ready) {
    btn._ready = true;
    btn.addEventListener("click", function () {
      localStorage.setItem("bl-cookie-consent", "accepted");
      banner.style.display = "none";
    });
  }
}

/* TABLE OF CONTENTS (blog posts) — auto-built from the article's own H2/H3s,
   skipped on short posts where a TOC would just be noise. */
function initTOC() {
  var body = document.querySelector(".site-post-body");
  if (!body) return;
  var headings = body.querySelectorAll("h2, h3");
  if (headings.length < 3) return;

  var counter = 0;
  headings.forEach(function (h) {
    if (!h.id) h.id = "section-" + ++counter;
  });

  var toc = document.createElement("nav");
  toc.className = "site-post-toc";
  toc.setAttribute("aria-label", "Tabla de contenidos");

  var title = document.createElement("p");
  title.className = "site-post-toc-title";
  title.textContent = "Contenido del art\u00edculo";
  toc.appendChild(title);

  var ol = document.createElement("ol");
  headings.forEach(function (h) {
    var li = document.createElement("li");
    if (h.tagName === "H3") li.classList.add("site-post-toc-sub");
    var a = document.createElement("a");
    a.href = "#" + h.id;
    a.textContent = h.textContent.trim();
    a.addEventListener("click", function (e) {
      e.preventDefault();
      h.scrollIntoView({ behavior: "smooth", block: "start" });
      history.replaceState(null, "", "#" + h.id);
    });
    li.appendChild(a);
    ol.appendChild(li);
  });
  toc.appendChild(ol);

  body.parentNode.insertBefore(toc, body);
}

function initContactForm() {
  var form = document.getElementById("contact-form");
  if (!form) return;

  var nameInput = document.getElementById("contact-name");
  var emailInput = document.getElementById("contact-email");
  var messageInput = document.getElementById("contact-message");
  var submitButton = document.getElementById("contact-submit");
  var msg = document.getElementById("contact-form-msg");

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    submitButton.disabled = true;
    msg.textContent = "";

    fetch("/api/contact", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        name: nameInput.value.trim(),
        email: emailInput.value.trim(),
        message: messageInput.value.trim(),
      }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.data.success) {
          msg.textContent =
            result.data.error || "No se pudo enviar el mensaje.";
          msg.style.color = "var(--accent)";
          return;
        }

        form.reset();
        msg.textContent = "Gracias. Hemos recibido tu mensaje.";
        msg.style.color = "var(--accent)";
      })
      .catch(function () {
        msg.textContent = "No se pudo enviar el mensaje.";
        msg.style.color = "var(--accent)";
      })
      .finally(function () {
        submitButton.disabled = false;
      });
  });
}

document.addEventListener("DOMContentLoaded", function () {
  initTheme();
  initCookieConsent();
  initReveals();
  initContactForm();
  initTOC();
});
