document.addEventListener("DOMContentLoaded", function () {
  // ── AUTH ──────────────────────────────────────────────────────────
  var token = null;

  // Escape before interpolating any user-supplied value into innerHTML.
  // Contact messages are public input, so an unescaped name/email/message
  // would be stored XSS executing in the authenticated panel.
  function escapeHtml(str) {
    return String(str == null ? "" : str)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  var loginScreen = document.getElementById("login-screen");
  var panelApp = document.getElementById("panel-app");
  var loginForm = document.getElementById("login-form");
  var loginError = document.getElementById("login-error");

  loginForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var pwd = document.getElementById("panel-password").value;
    try {
      var res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ password: pwd }),
      });
      var data = await res.json();
      if (data.token) {
        token = data.token;
        loginScreen.hidden = true;
        panelApp.hidden = false;
        if (data.companyName) {
          document.getElementById("company-name").textContent =
            data.companyName;
          document.getElementById("sidebar-company").textContent =
            data.companyName;
        }
        initPanel();
      } else {
        loginError.textContent = data.error || "Contraseña incorrecta";
        loginError.hidden = false;
      }
    } catch {
      loginError.textContent = "Error de conexión";
      loginError.hidden = false;
    }
  });

  // x-panel-token used by requireAuth middleware (JWT sent as custom header)
  function authHeaders() {
    return {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
      "x-panel-token": token,
    };
  }

  // ── LOGOUT ───────────────────────────────────────────────────────
  function doLogout() {
    token = null;
    panelApp.hidden = true;
    loginScreen.hidden = false;
    document.getElementById("panel-password").value = "";
    loginError.hidden = true;
    miSiteInitialized = false;
    window.location.href = "/";
  }
  document.getElementById("panel-logout").addEventListener("click", doLogout);
  document.getElementById("sidebar-logout").addEventListener("click", doLogout);
  document
    .getElementById("reset-config-btn")
    .addEventListener("click", async function () {
      var firstConfirm = confirm(
        "¿Seguro que quieres borrar toda la configuración y el contenido?",
      );
      if (!firstConfirm) return;

      var secondConfirm = confirm(
        "Esta acción es irreversible. Se borrarán la configuración, los artículos, el chat y los mensajes. ¿Continuar?",
      );
      if (!secondConfirm) return;

      var status = document.getElementById("reset-config-msg");
      status.hidden = false;
      status.textContent = "Reseteando configuración...";

      try {
        var res = await fetch("/api/setup/reset", {
          method: "DELETE",
          headers: authHeaders(),
        });
        var data = await res.json();
        if (!res.ok || !data.success) {
          throw new Error(data.error || "No se pudo resetear la configuración");
        }

        token = null;
        window.location.href = "/setup";
      } catch (err) {
        status.textContent =
          err.message || "Error al resetear la configuración";
      }
    });

  // ── NAVIGATION ───────────────────────────────────────────────────
  var navItems = document.querySelectorAll(".sidebar-nav-item");
  var sections = document.querySelectorAll(".panel-section");

  function showSection(name) {
    navItems.forEach(function (b) {
      b.classList.toggle("active", b.dataset.section === name);
    });
    sections.forEach(function (s) {
      var active = s.dataset.panel === name;
      s.classList.toggle("active", active);
      s.hidden = !active;
    });
    if (name === "blog") loadArticles();
    if (name === "messages") loadMessages();
    if (name === "misite") initMiSite();
    if (name === "productos") initProductos();
  }

  navItems.forEach(function (btn) {
    btn.addEventListener("click", function () {
      showSection(btn.dataset.section);
    });
  });

  document.querySelectorAll(".action-button").forEach(function (btn) {
    btn.addEventListener("click", function () {
      var action = btn.dataset.action;
      if (action === "create-article") {
        showSection("blog");
        setTimeout(function () {
          document.getElementById("new-article-btn").click();
        }, 100);
      } else if (action === "edit-texts") showSection("chat");
      else if (action === "view-blog") showSection("blog");
    });
  });

  // ── INIT PANEL ───────────────────────────────────────────────────
  function initPanel() {
    var h = new Date().getHours();
    var greet =
      h < 12 ? "Buenos días" : h < 20 ? "Buenas tardes" : "Buenas noches";
    document.getElementById("greeting").textContent = greet;

    fetch("/api/setup/status")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var name = d.company_name || "";
        if (name) {
          document.getElementById("company-name").textContent = name;
          document.getElementById("sidebar-company").textContent = name;
        }
      })
      .catch(function () {});

    fetch("/api/blog/posts")
      .then(function (r) {
        return r.json();
      })
      .then(function (d) {
        var published = (d.posts || []).filter(function (p) {
          return p.status === "published";
        }).length;
        document.getElementById("stat-posts").textContent = published;
      })
      .catch(function () {});
  }

  // ── CHAT ─────────────────────────────────────────────────────────
  var chatMessages = document.getElementById("chat-messages");
  var chatInput = document.getElementById("chat-input");
  var chatSend = document.getElementById("chat-send");

  function appendMessage(role, text) {
    var div = document.createElement("div");
    var roleClass = "agent-message";
    if (role === "user") roleClass = "user-message";
    if (role === "system") roleClass = "system-message";
    div.className = "chat-message " + roleClass;
    var p = document.createElement("p");
    p.textContent = text;
    div.appendChild(p);
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
  }

  async function sendChat() {
    var msg = chatInput.value.trim();
    if (!msg) return;
    chatInput.value = "";
    chatSend.disabled = true;
    appendMessage("user", msg);
    try {
      var res = await fetch("/api/chat/send", {
        method: "POST",
        headers: authHeaders(),
        body: JSON.stringify({ message: msg }),
      });
      var data = await res.json();
      appendMessage("agent", data.reply || "Sin respuesta");

      if (data.action) {
        if (data.action.type === "texts_updated") {
          appendMessage(
            "system",
            "✓ Textos actualizados en el sitio web. Los cambios ya son visibles para tus visitantes.",
          );
          if (
            document
              .querySelector('[data-section="misite"]')
              ?.classList.contains("active")
          ) {
            initMiSite();
          }
        }
        if (data.action.type === "article_created") {
          appendMessage(
            "system",
            "✓ Artículo creado como borrador. Puedes revisarlo y publicarlo en la sección Blog.",
          );
          if (
            document
              .querySelector('[data-section="blog"]')
              ?.classList.contains("active")
          ) {
            loadArticles();
          }
        }
      }
    } catch {
      appendMessage("agent", "Error de conexión. Intenta de nuevo.");
    }
    chatSend.disabled = false;
    chatInput.focus();
  }

  chatSend.addEventListener("click", sendChat);
  chatInput.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendChat();
    }
  });

  document.querySelectorAll(".suggestion-chip").forEach(function (chip) {
    chip.addEventListener("click", function () {
      chatInput.value = chip.dataset.prompt;
      chatInput.focus();
    });
  });

  // ── BLOG ─────────────────────────────────────────────────────────
  var articleFormWrap = document.getElementById("article-form-wrap");
  var articleForm = document.getElementById("article-form");

  document
    .getElementById("new-article-btn")
    .addEventListener("click", function () {
      document.getElementById("article-edit-id").value = "";
      document.getElementById("article-title-input").value = "";
      document.getElementById("article-content-input").value = "";
      document.getElementById("article-cta-url-input").value = "";
      document.getElementById("article-cta-label-input").value = "";
      document.getElementById("article-status-select").value = "draft";
      document.getElementById("article-form-title").textContent =
        "Nuevo artículo";
      articleFormWrap.hidden = false;
    });
  document
    .getElementById("article-form-close")
    .addEventListener("click", function () {
      articleFormWrap.hidden = true;
    });
  document
    .getElementById("article-form-cancel")
    .addEventListener("click", function () {
      articleFormWrap.hidden = true;
    });

  articleForm.addEventListener("submit", async function (e) {
    e.preventDefault();
    var id = document.getElementById("article-edit-id").value;
    var body = {
      title: document.getElementById("article-title-input").value.trim(),
      content: document.getElementById("article-content-input").value.trim(),
      cta_url: document.getElementById("article-cta-url-input").value.trim(),
      cta_label: document
        .getElementById("article-cta-label-input")
        .value.trim(),
      status: document.getElementById("article-status-select").value,
    };
    var url = id ? "/api/blog/posts/" + id : "/api/blog/posts";
    var method = id ? "PUT" : "POST";
    var msgEl = document.getElementById("article-form-msg");
    try {
      var res = await fetch(url, {
        method: method,
        headers: authHeaders(),
        body: JSON.stringify(body),
      });
      var data = await res.json();
      if (data.success || data.id) {
        articleFormWrap.hidden = true;
        loadArticles();
        document.getElementById("stat-posts").textContent = "…";
        fetch("/api/blog/posts")
          .then(function (r) {
            return r.json();
          })
          .then(function (d) {
            var published = (d.posts || []).filter(function (p) {
              return p.status === "published";
            }).length;
            document.getElementById("stat-posts").textContent = published;
          })
          .catch(function () {});
      } else {
        msgEl.textContent = data.error || "Error al guardar";
        msgEl.hidden = false;
      }
    } catch {
      msgEl.textContent = "Error de conexión";
      msgEl.hidden = false;
    }
  });

  function loadArticles() {
    fetch("/api/blog/posts", {
      headers: { Authorization: "Bearer " + token, "x-panel-token": token },
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var list = document.getElementById("articles-list");
        var posts = data.posts || [];
        if (!posts.length) {
          list.innerHTML =
            '<p style="color:var(--text-muted);padding:2rem 0">Aún no tienes artículos.</p>';
          return;
        }
        list.innerHTML = posts
          .map(function (p) {
            var badge =
              p.status === "published"
                ? '<span style="background:#dcfce7;color:#166534;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600">Publicado</span>'
                : '<span style="background:#f3f4f6;color:#6b7280;padding:2px 8px;border-radius:20px;font-size:0.75rem;font-weight:600">Borrador</span>';
            return (
              '<div class="article-row"><div class="article-row-info"><span class="article-row-title">' +
              escapeHtml(p.title) +
              "</span>" +
              badge +
              '</div><div class="article-row-actions"><button class="btn-ghost-sm" data-edit="' +
              p.id +
              '">Editar</button><button class="btn-ghost-sm btn-danger" data-delete="' +
              p.id +
              '">Eliminar</button></div></div>'
            );
          })
          .join("");
        list.querySelectorAll("[data-edit]").forEach(function (btn) {
          btn.addEventListener("click", function () {
            var post = posts.find(function (p) {
              return p.id == btn.dataset.edit;
            });
            if (!post) return;
            document.getElementById("article-edit-id").value = post.id;
            document.getElementById("article-title-input").value = post.title;
            document.getElementById("article-content-input").value =
              post.content;
            document.getElementById("article-cta-url-input").value =
              post.cta_url || "";
            document.getElementById("article-cta-label-input").value =
              post.cta_label || "";
            document.getElementById("article-status-select").value =
              post.status;
            document.getElementById("article-form-title").textContent =
              "Editar artículo";
            articleFormWrap.hidden = false;
          });
        });
        list.querySelectorAll("[data-delete]").forEach(function (btn) {
          btn.addEventListener("click", async function () {
            if (!confirm("¿Eliminar este artículo?")) return;
            await fetch("/api/blog/posts/" + btn.dataset.delete, {
              method: "DELETE",
              headers: authHeaders(),
            });
            loadArticles();
          });
        });
      })
      .catch(function () {});
  }

  function loadMessages() {
    fetch("/api/contact", {
      headers: { Authorization: "Bearer " + token, "x-panel-token": token },
    })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var list = document.getElementById("messages-list");
        var messages = data.messages || [];
        if (!messages.length) {
          list.innerHTML =
            '<p style="color:var(--text-muted);padding:2rem 0">Todavía no hay mensajes.</p>';
          return;
        }
        list.innerHTML = messages
          .map(function (m) {
            return (
              '<article class="message-card"><div class="message-card-header"><span class="message-card-name">' +
              escapeHtml(m.name) +
              '</span><span class="message-card-email">' +
              escapeHtml(m.email) +
              '</span><span class="message-card-date">' +
              new Date(m.created_at).toLocaleString("es-ES") +
              '</span></div><div class="message-card-body">' +
              escapeHtml(m.message) +
              "</div></article>"
            );
          })
          .join("");
      })
      .catch(function () {
        var list = document.getElementById("messages-list");
        if (list) {
          list.innerHTML =
            '<p style="color:var(--text-muted);padding:2rem 0">No se pudieron cargar los mensajes.</p>';
        }
      });
  }

  // ── MI SITIO WEB ─────────────────────────────────────────────────
  var siteConfig = {};
  var activePage = "index";
  var miSiteInitialized = false;

  function initMiSite() {
    fetch("/api/site/config")
      .then(function (r) {
        return r.json();
      })
      .then(function (cfg) {
        siteConfig = cfg;
        renderPageForm(activePage);

        var notifyEmailInput = document.getElementById("notify-email-input");
        var smtpHostInput = document.getElementById("smtp-host-input");
        var smtpPortInput = document.getElementById("smtp-port-input");
        var smtpUserInput = document.getElementById("smtp-user-input");
        var whatsappNumberInput = document.getElementById(
          "whatsapp-number-input",
        );

        if (notifyEmailInput) {
          notifyEmailInput.value = cfg.notify_email || "";
        }
        if (smtpHostInput) {
          smtpHostInput.value = cfg.smtp_host || "";
        }
        if (smtpPortInput) {
          smtpPortInput.value = cfg.smtp_port || "";
        }
        if (smtpUserInput) {
          smtpUserInput.value = cfg.smtp_user || "";
        }
        if (whatsappNumberInput) {
          whatsappNumberInput.value = cfg.whatsapp_number || "";
        }
        var siteUrlInput = document.getElementById("site-url-input");
        if (siteUrlInput) {
          siteUrlInput.value = cfg.site_url || "";
        }

        [
          "legal_name",
          "legal_id",
          "legal_address",
          "legal_email",
          "biz_type",
          "biz_street",
          "biz_city",
          "biz_postal_code",
          "biz_region",
          "biz_country",
          "biz_phone",
          "biz_geo_lat",
          "biz_geo_lng",
          "biz_hours",
          "biz_price_range",
          "biz_facebook",
          "biz_instagram",
        ].forEach(function (key) {
          var input = document.getElementById(key.replace(/_/g, "-") + "-input");
          if (input) input.value = cfg[key] || "";
        });

        if (cfg.logo_ext) {
          var img = document.getElementById("logo-preview");
          img.src = "/uploads/logo." + cfg.logo_ext + "?t=" + Date.now();
          img.style.display = "block";
          document.getElementById("logo-placeholder").style.display = "none";
        }
        if (cfg.ai_model && cfg.ai_model !== "gpt-oss-20b:free") {
          var customLabel = document.getElementById("model-custom-label");
          var customInput = document.getElementById("model-custom");
          customInput.value = cfg.ai_model;
          document.getElementById("model-custom-name").textContent =
            cfg.ai_model.split("/").pop();
          document.getElementById("model-custom-desc").textContent =
            cfg.ai_model;
          setCustomModelBadge(cfg.ai_model.includes(":free"));
          customLabel.style.display = "flex";
          customInput.checked = true;
          document
            .getElementById("model-free-label")
            .classList.remove("selected");
          customLabel.classList.add("selected");
        }
        var imageModelSelect = document.getElementById("image-model-select");
        if (imageModelSelect && cfg.image_model) {
          imageModelSelect.value = cfg.image_model;
        }
      })
      .catch(function () {});

    if (miSiteInitialized) return;
    miSiteInitialized = true;

    // Internal tabs
    document.querySelectorAll(".misite-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".misite-tab").forEach(function (t) {
          t.classList.remove("active");
        });
        tab.classList.add("active");
        document.querySelectorAll(".misite-panel").forEach(function (p) {
          p.style.display = "none";
        });
        document.getElementById("misite-" + tab.dataset.tab).style.display =
          "block";
      });
    });

    // Page tabs
    document.querySelectorAll(".misite-page-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".misite-page-tab").forEach(function (t) {
          t.classList.remove("active");
        });
        tab.classList.add("active");
        activePage = tab.dataset.page;
        renderPageForm(activePage);
      });
    });

    // Save page texts
    document
      .getElementById("save-page-texts")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-page-msg");
        var payload = {};
        document
          .querySelectorAll(".misite-page-form [data-key]")
          .forEach(function (el) {
            payload[el.dataset.key] = el.value;
          });
        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) siteConfig = Object.assign(siteConfig, payload);
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.display = "inline";
        }
      });

    // Logo upload
    document
      .getElementById("logo-file-input")
      .addEventListener("change", async function () {
        var file = this.files[0];
        if (!file) return;
        var msgEl = document.getElementById("logo-upload-msg");
        var formData = new FormData();
        formData.append("logo", file);
        try {
          var res = await fetch("/api/site/logo", {
            method: "POST",
            headers: {
              Authorization: "Bearer " + token,
              "x-panel-token": token,
            },
            body: formData,
          });
          var data = await res.json();
          if (data.success) {
            var img = document.getElementById("logo-preview");
            img.src = data.path + "?t=" + Date.now();
            img.style.display = "block";
            document.getElementById("logo-placeholder").style.display = "none";
            msgEl.textContent = "✓ Logo actualizado";
            msgEl.style.color = "var(--accent)";
          } else {
            msgEl.textContent = data.error || "Error al subir";
            msgEl.style.color = "var(--error)";
          }
          msgEl.style.display = "block";
          setTimeout(function () {
            msgEl.style.display = "none";
          }, 2500);
        } catch {
          msgEl.textContent = "Error de conexión";
          msgEl.style.display = "block";
        }
      });

    // Model save
    document
      .getElementById("save-model-btn")
      .addEventListener("click", async function () {
        var selected = document.querySelector('input[name="ai-model"]:checked');
        if (!selected) return;
        var msg = document.getElementById("save-model-msg");
        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ ai_model: selected.value }),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error";
          msg.style.display = "inline";
        }
      });

    // Image model save
    document
      .getElementById("save-image-model-btn")
      .addEventListener("click", async function () {
        var select = document.getElementById("image-model-select");
        var msg = document.getElementById("save-image-model-msg");
        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({ image_model: select.value }),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error";
          msg.style.display = "inline";
        }
      });

    // Email notifications settings
    document
      .getElementById("save-email-settings")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-email-msg");
        var payload = {
          notify_email: document
            .getElementById("notify-email-input")
            .value.trim(),
          smtp_host: document.getElementById("smtp-host-input").value.trim(),
          smtp_port: document.getElementById("smtp-port-input").value.trim(),
          smtp_user: document.getElementById("smtp-user-input").value.trim(),
          smtp_pass: document.getElementById("smtp-pass-input").value,
        };

        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) {
            siteConfig = Object.assign(siteConfig, payload);
          }
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.color = "var(--error)";
          msg.style.display = "inline";
        }
      });

    // WhatsApp button settings
    document
      .getElementById("save-whatsapp-btn")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-whatsapp-msg");
        var payload = {
          whatsapp_number: document
            .getElementById("whatsapp-number-input")
            .value.trim(),
        };

        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) {
            siteConfig = Object.assign(siteConfig, payload);
          }
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.color = "var(--error)";
          msg.style.display = "inline";
        }
      });

    // Site URL setting (canonical / Open Graph / sitemap base)
    document
      .getElementById("save-siteurl-btn")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-siteurl-msg");
        var payload = {
          site_url: document
            .getElementById("site-url-input")
            .value.trim()
            .replace(/\/+$/, ""),
        };

        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) {
            siteConfig = Object.assign(siteConfig, payload);
          }
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.color = "var(--error)";
          msg.style.display = "inline";
        }
      });

    // Legal data settings (privacidad / aviso legal pages)
    document
      .getElementById("save-legal-btn")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-legal-msg");
        var payload = {
          legal_name: document.getElementById("legal-name-input").value.trim(),
          legal_id: document.getElementById("legal-id-input").value.trim(),
          legal_address: document
            .getElementById("legal-address-input")
            .value.trim(),
          legal_email: document
            .getElementById("legal-email-input")
            .value.trim(),
        };

        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) {
            siteConfig = Object.assign(siteConfig, payload);
          }
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.color = "var(--error)";
          msg.style.display = "inline";
        }
      });

    // Business profile settings (LocalBusiness JSON-LD + contact page)
    document
      .getElementById("save-biz-btn")
      .addEventListener("click", async function () {
        var msg = document.getElementById("save-biz-msg");
        var keys = [
          "biz_type",
          "biz_street",
          "biz_city",
          "biz_postal_code",
          "biz_region",
          "biz_country",
          "biz_phone",
          "biz_geo_lat",
          "biz_geo_lng",
          "biz_hours",
          "biz_price_range",
          "biz_facebook",
          "biz_instagram",
        ];
        var payload = {};
        keys.forEach(function (key) {
          var input = document.getElementById(key.replace(/_/g, "-") + "-input");
          payload[key] = input ? input.value.trim() : "";
        });

        try {
          var res = await fetch("/api/site/texts", {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload),
          });
          var data = await res.json();
          msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
          msg.style.color = data.success ? "var(--accent)" : "var(--error)";
          msg.style.display = "inline";
          if (data.success) {
            siteConfig = Object.assign(siteConfig, payload);
          }
          setTimeout(function () {
            msg.style.display = "none";
          }, 2500);
        } catch {
          msg.textContent = "Error de conexión";
          msg.style.color = "var(--error)";
          msg.style.display = "inline";
        }
      });

    // Model search — calls /api/site/models?q=
    var modelSearch = document.getElementById("model-search");
    var modelResults = document.getElementById("model-search-results");
    var searchTimeout;

    function isFreeModel(model) {
      return (
        model.id.includes(":free") ||
        model.pricing?.prompt === "0" ||
        model.pricing?.prompt === 0
      );
    }

    function getModelBadgeHTML(model) {
      return isFreeModel(model)
        ? '<span class="model-badge model-badge--free free">Gratis</span>'
        : '<span class="model-badge model-badge--paid paid">De pago</span>';
    }

    function setCustomModelBadge(isFree) {
      var badge = document.getElementById("model-custom-badge");
      badge.textContent = isFree ? "Gratis" : "De pago";
      badge.className =
        "model-badge " +
        (isFree ? "model-badge--free free" : "model-badge--paid paid");
    }

    modelSearch.addEventListener("input", function () {
      clearTimeout(searchTimeout);
      var q = modelSearch.value.trim();
      if (!q) {
        modelResults.style.display = "none";
        return;
      }
      searchTimeout = setTimeout(async function () {
        try {
          var res = await fetch("/api/site/models?q=" + encodeURIComponent(q), {
            headers: authHeaders(),
          });
          var data = await res.json();
          var models = data.models || [];
          if (!models.length) {
            modelResults.innerHTML =
              '<div class="model-result-item" style="color:var(--text-muted)">Sin resultados</div>';
            modelResults.style.display = "block";
            return;
          }
          modelResults.innerHTML = models
            .map(function (m) {
              var badge = getModelBadgeHTML(m);
              return (
                '<div class="model-result-item" data-id="' +
                m.id +
                '" data-name="' +
                (m.name || m.id).replace(/"/g, "") +
                '" data-free="' +
                (isFreeModel(m) ? "1" : "0") +
                '"><span>' +
                (m.name || m.id) +
                '</span><span style="display:flex;align-items:center;gap:0.5rem"><span class="mri-id">' +
                m.id +
                "</span>" +
                badge +
                "</span></div>"
              );
            })
            .join("");
          modelResults.style.display = "block";
          modelResults
            .querySelectorAll(".model-result-item[data-id]")
            .forEach(function (item) {
              item.addEventListener("click", function () {
                var id = item.dataset.id;
                var name = item.dataset.name;
                var isFree = item.dataset.free === "1";
                var customLabel = document.getElementById("model-custom-label");
                var customInput = document.getElementById("model-custom");
                customInput.value = id;
                document.getElementById("model-custom-name").textContent = name;
                document.getElementById("model-custom-desc").textContent = id;
                setCustomModelBadge(isFree);
                customLabel.style.display = "flex";
                customInput.checked = true;
                document
                  .getElementById("model-free-label")
                  .classList.remove("selected");
                customLabel.classList.add("selected");
                modelResults.style.display = "none";
                modelSearch.value = "";
              });
            });
        } catch {
          modelResults.style.display = "none";
        }
      }, 350);
    });

    document
      .getElementById("model-free-label")
      .addEventListener("click", function () {
        document.getElementById("model-free").checked = true;
        document.getElementById("model-free-label").classList.add("selected");
        document
          .getElementById("model-custom-label")
          .classList.remove("selected");
      });

    document.addEventListener("click", function (e) {
      if (!modelResults.contains(e.target) && e.target !== modelSearch) {
        modelResults.style.display = "none";
      }
    });
  }

  // ── RENDER PAGE FORM ─────────────────────────────────────────────
  var pageFields = {
    index: [
      { key: "page_index_title", label: "Título principal", type: "input" },
      { key: "page_index_subtitle", label: "Subtítulo", type: "input" },
      { key: "page_index_desc", label: "Descripción (héroe, texto corto)", type: "textarea" },
      { key: "page_index_body", label: "Contenido de la página (Markdown)", type: "textarea" },
    ],
    quienes: [
      { key: "page_quienes_title", label: "Título", type: "input" },
      { key: "page_quienes_subtitle", label: "Subtítulo", type: "input" },
      { key: "page_quienes_desc", label: "Descripción", type: "textarea" },
    ],
    servicios: [
      { key: "page_servicios_title", label: "Título", type: "input" },
      { key: "page_servicios_subtitle", label: "Subtítulo", type: "input" },
      { key: "page_servicios_desc", label: "Descripción", type: "textarea" },
    ],
    contacto: [
      { key: "page_contacto_title", label: "Título", type: "input" },
      { key: "page_contacto_subtitle", label: "Subtítulo", type: "input" },
      { key: "page_contacto_desc", label: "Descripción", type: "textarea" },
    ],
    blog: [
      { key: "page_blog_title", label: "Título del blog", type: "input" },
      { key: "page_blog_subtitle", label: "Subtítulo", type: "input" },
    ],
  };

  function renderPageForm(page) {
    var fields = pageFields[page] || [];
    var container = document.getElementById("misite-page-form");
    container.innerHTML = fields
      .map(function (f) {
        var val = (siteConfig[f.key] || "").replace(/"/g, "&quot;");
        if (f.type === "textarea") {
          return (
            "<div><label>" +
            f.label +
            '</label><textarea data-key="' +
            f.key +
            '" rows="4">' +
            (siteConfig[f.key] || "") +
            "</textarea></div>"
          );
        }
        return (
          "<div><label>" +
          f.label +
          '</label><input type="text" data-key="' +
          f.key +
          '" value="' +
          val +
          '"></div>'
        );
      })
      .join("");
  }

  // ── PRODUCTOS ────────────────────────────────────────────────────
  var productosInitialized = false;

  function formatEurCents(cents) {
    return (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
  }

  function loadProductsList() {
    fetch("/api/products", { headers: authHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var list = document.getElementById("productos-catalog-list");
        var products = data.products || [];
        list.textContent = "";
        if (!products.length) {
          var empty = document.createElement("p");
          empty.style.color = "var(--text-muted)";
          empty.style.padding = "2rem 0";
          empty.textContent = "Todavía no hay productos sincronizados.";
          list.appendChild(empty);
          return;
        }
        products.forEach(function (p) {
          var row = document.createElement("div");
          row.className = "product-row";

          var info = document.createElement("div");
          info.className = "product-row-info";
          var name = document.createElement("span");
          name.className = "product-row-name";
          name.textContent = p.name;
          var meta = document.createElement("span");
          meta.className = "product-row-meta";
          meta.textContent =
            p.sku + " · " + (p.category || "Sin categoría") + " · " +
            formatEurCents(p.price_cents) + " · stock " + p.stock_qty;
          info.appendChild(name);
          info.appendChild(meta);

          var label = document.createElement("label");
          label.style.display = "flex";
          label.style.alignItems = "center";
          label.style.gap = "0.5rem";
          var checkbox = document.createElement("input");
          checkbox.type = "checkbox";
          checkbox.checked = Boolean(p.active);
          checkbox.addEventListener("change", function () {
            fetch("/api/products/" + p.id, {
              method: "PUT",
              headers: authHeaders(),
              body: JSON.stringify({ active: checkbox.checked }),
            }).catch(function () {});
          });
          var labelText = document.createElement("span");
          labelText.textContent = "Visible en la tienda";
          label.appendChild(checkbox);
          label.appendChild(labelText);

          row.appendChild(info);
          row.appendChild(label);
          list.appendChild(row);
        });
      })
      .catch(function () {});
  }

  var RESERVATION_STATUSES = [
    ["pending", "Pendiente"],
    ["confirmed", "Confirmada"],
    ["ready_for_pickup", "Lista para recoger"],
    ["completed", "Completada"],
    ["cancelled", "Cancelada"],
  ];

  function loadReservationsList() {
    fetch("/api/reservations", { headers: authHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var list = document.getElementById("productos-reservations-list");
        var reservations = data.reservations || [];
        list.textContent = "";
        if (!reservations.length) {
          var empty = document.createElement("p");
          empty.style.color = "var(--text-muted)";
          empty.style.padding = "2rem 0";
          empty.textContent = "Todavía no hay reservas.";
          list.appendChild(empty);
          return;
        }
        reservations.forEach(function (res) {
          var card = document.createElement("article");
          card.className = "reservation-card";

          var info = document.createElement("div");
          info.className = "reservation-card-info";
          var name = document.createElement("span");
          name.className = "reservation-card-name";
          name.textContent = res.customer_name + " — " + formatEurCents(res.total_cents);
          var meta = document.createElement("span");
          meta.className = "reservation-card-meta";
          meta.textContent =
            res.customer_email + (res.customer_phone ? " · " + res.customer_phone : "") +
            " · " + new Date(res.created_at).toLocaleString("es-ES");
          info.appendChild(name);
          info.appendChild(meta);

          var select = document.createElement("select");
          select.className = "reservation-status-select";
          RESERVATION_STATUSES.forEach(function (pair) {
            var opt = document.createElement("option");
            opt.value = pair[0];
            opt.textContent = pair[1];
            if (pair[0] === res.status) opt.selected = true;
            select.appendChild(opt);
          });
          select.addEventListener("change", function () {
            fetch("/api/reservations/" + res.id, {
              method: "PUT",
              headers: authHeaders(),
              body: JSON.stringify({ status: select.value }),
            }).catch(function () {});
          });

          card.appendChild(info);
          card.appendChild(select);

          if (res.notes) {
            var notes = document.createElement("div");
            notes.className = "reservation-card-items";
            notes.textContent = "Notas: " + res.notes;
            card.appendChild(notes);
          }

          list.appendChild(card);
        });
      })
      .catch(function () {});
  }

  function loadSyncStatus() {
    fetch("/api/sync/liderpapel/status", { headers: authHeaders() })
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        var hostInput = document.getElementById("sync-host-input");
        var portInput = document.getElementById("sync-port-input");
        var userInput = document.getElementById("sync-user-input");
        if (!hostInput.dataset.touched) hostInput.value = data.host || "";
        if (!portInput.dataset.touched) portInput.value = data.port || "";
        if (!userInput.dataset.touched) userInput.value = data.user || "";
        document.getElementById("sync-pass-hint").textContent = data.hasPassword
          ? "Contraseña configurada. Déjala en blanco para no cambiarla."
          : "Todavía no se ha configurado ninguna contraseña.";

        var statusLine = document.getElementById("sync-status-line");
        if (!data.lastSyncAt) {
          statusLine.textContent = "Todavía no se ha ejecutado ninguna sincronización.";
        } else {
          var when = new Date(data.lastSyncAt).toLocaleString("es-ES");
          if (data.lastSyncStatus === "error") {
            statusLine.textContent = "Último intento (" + when + "): error — " + data.lastSyncMessage;
          } else {
            statusLine.textContent =
              "Última sincronización (" + when + "): " + (data.lastSyncCount || 0) + " productos.";
          }
        }
      })
      .catch(function () {});
  }

  function initProductos() {
    loadProductsList();
    loadReservationsList();
    loadSyncStatus();

    if (productosInitialized) return;
    productosInitialized = true;

    document.querySelectorAll(".productos-tab").forEach(function (tab) {
      tab.addEventListener("click", function () {
        document.querySelectorAll(".productos-tab").forEach(function (t) {
          t.classList.remove("active");
        });
        tab.classList.add("active");
        document.querySelectorAll(".productos-tab-panel").forEach(function (p) {
          p.classList.remove("active");
        });
        document
          .getElementById("productos-" + tab.dataset.productosTab)
          .classList.add("active");
      });
    });

    ["sync-host-input", "sync-port-input", "sync-user-input"].forEach(function (id) {
      document.getElementById(id).addEventListener("input", function (e) {
        e.target.dataset.touched = "1";
      });
    });

    document.getElementById("sync-config-form").addEventListener("submit", async function (e) {
      e.preventDefault();
      var msg = document.getElementById("sync-config-msg");
      var payload = {
        liderpapel_sftp_host: document.getElementById("sync-host-input").value.trim(),
        liderpapel_sftp_port: document.getElementById("sync-port-input").value.trim(),
        liderpapel_sftp_user: document.getElementById("sync-user-input").value.trim(),
      };
      var pass = document.getElementById("sync-pass-input").value;
      if (pass) payload.liderpapel_sftp_pass = pass;

      try {
        var res = await fetch("/api/sync/liderpapel/config", {
          method: "POST",
          headers: authHeaders(),
          body: JSON.stringify(payload),
        });
        var data = await res.json();
        msg.hidden = false;
        msg.textContent = data.success ? "✓ Guardado" : data.error || "Error";
        msg.style.color = data.success ? "var(--accent)" : "var(--error)";
        document.getElementById("sync-pass-input").value = "";
        loadSyncStatus();
      } catch {
        msg.hidden = false;
        msg.textContent = "Error de conexión";
        msg.style.color = "var(--error)";
      }
    });

    document.getElementById("sync-run-btn").addEventListener("click", async function () {
      var btn = document.getElementById("sync-run-btn");
      var msg = document.getElementById("sync-run-msg");
      btn.disabled = true;
      msg.hidden = false;
      msg.textContent = "Sincronizando…";
      msg.style.color = "var(--text-muted)";
      try {
        var res = await fetch("/api/sync/liderpapel/run", {
          method: "POST",
          headers: authHeaders(),
        });
        var data = await res.json();
        if (data.success) {
          msg.textContent = "✓ " + data.count + " productos sincronizados";
          msg.style.color = "var(--accent)";
          loadProductsList();
        } else {
          msg.textContent = data.error || "Error en la sincronización";
          msg.style.color = "var(--error)";
        }
        loadSyncStatus();
      } catch {
        msg.textContent = "Error de conexión";
        msg.style.color = "var(--error)";
      } finally {
        btn.disabled = false;
      }
    });
  }
});
