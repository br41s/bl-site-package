/* Client-side cart for the reserve-without-payment catalog. Cart state lives in
   localStorage (no server session) — checkout POSTs it to /api/reservations,
   which recomputes prices server-side from the current catalog.

   Also shows trade prices to a signed-in B2B account (see the B2B section
   below). Cart items keep the RETAIL price and their category; the price a
   B2B customer sees is derived from those at render time, so logging in or
   out after filling the cart re-prices it instead of leaving stale figures. */

var CART_KEY = "bl_cart_v1";

/* ── B2B pricing ────────────────────────────────────────────────────────────
   The session is an httpOnly cookie this script cannot read, so a localStorage
   flag remembers that there probably is one. Without it every visitor on every
   page would call /api/b2b/me just to be told no. */

var B2B_FLAG_KEY = "bl_b2b_v1";
var b2b = null; // { account, default_pct, discounts } once /api/b2b/me answers

function setB2bFlag(on) {
  try {
    if (on) localStorage.setItem(B2B_FLAG_KEY, "1");
    else localStorage.removeItem(B2B_FLAG_KEY);
  } catch (e) {}
}

function hasB2bFlag() {
  try {
    return localStorage.getItem(B2B_FLAG_KEY) === "1";
  } catch (e) {
    return false;
  }
}

function loadB2b() {
  return fetch("/api/b2b/me", { credentials: "same-origin" })
    .then(function (r) {
      if (!r.ok) throw new Error("no b2b session");
      return r.json();
    })
    .then(function (data) {
      b2b = data;
      setB2bFlag(true);
      return b2b;
    })
    .catch(function () {
      b2b = null;
      setB2bFlag(false);
      return null;
    });
}

function b2bDiscountFor(category) {
  if (!b2b) return 0;
  var key = category || "";
  return Object.prototype.hasOwnProperty.call(b2b.discounts, key)
    ? b2b.discounts[key]
    : b2b.default_pct;
}

// Trade prices are WITHOUT VAT: the public (VAT-included) price, less the
// discount, less the VAT, rounded once. Same arithmetic as b2bPriceCents and
// vatCents in src/api/b2b.js, which is what the reservation is actually
// charged at — keep them identical. The rate comes from /api/b2b/me.
function b2bPriceCents(priceCents, discountPct, vatRate) {
  var pct =
    typeof discountPct === "number" && Number.isFinite(discountPct) && discountPct >= 0 && discountPct < 100
      ? discountPct
      : 0;
  return Math.round((priceCents * (100 - pct)) / 100 / (1 + vatRate));
}

function vatCents(netCents, vatRate) {
  return Math.round(netCents * vatRate);
}

function effectivePriceCents(priceCents, category) {
  return b2b ? b2bPriceCents(priceCents, b2bDiscountFor(category), b2b.vat_rate) : priceCents;
}

function formatPct(pct) {
  return pct.toLocaleString("es-ES", { maximumFractionDigits: 2 }) + " %";
}

// Rewrites every product price under `root` to the trade price. Prices carry
// the retail figure and the category in data-* attributes (product-card.njk,
// producto.njk, buildProductCardEl); data-b2b-applied keeps a second pass
// from discounting an already discounted price.
function applyB2bPrices(root) {
  if (!b2b) return;
  var prices = root.querySelectorAll(".product-price[data-price-cents]");
  Array.prototype.forEach.call(prices, function (el) {
    if (el.dataset.b2bApplied) return;
    var retail = parseInt(el.dataset.priceCents, 10);
    var amount = el.querySelector(".product-price-amount");
    if (!Number.isFinite(retail) || !amount) return;
    el.dataset.b2bApplied = "1";

    // Both figures without VAT: striking through the VAT-included public
    // price next to a net one would overstate the discount by the VAT.
    var pct = b2bDiscountFor(el.dataset.category);
    if (pct > 0) {
      var was = document.createElement("s");
      was.className = "product-price-was";
      was.textContent = formatEur(b2bPriceCents(retail, 0, b2b.vat_rate));
      el.insertBefore(was, amount);
    }
    amount.textContent = formatEur(b2bPriceCents(retail, pct, b2b.vat_rate));
    var note = el.querySelector(".price-vat-note");
    if (note) {
      note.textContent =
        (pct > 0 ? "Precio profesional (−" + formatPct(pct) + ")" : "Precio profesional") +
        " · IVA no incluido";
    }
  });
}

// The catalogue's "¿Eres una empresa?" banner turns into a signed-in notice.
function updateB2bBanner() {
  var banner = document.getElementById("b2b-banner");
  if (!banner || !b2b) return;
  banner.textContent = "";
  var p = document.createElement("p");
  p.appendChild(document.createTextNode("Has iniciado sesión como "));
  var strong = document.createElement("strong");
  strong.textContent = b2b.account.company_name;
  p.appendChild(strong);
  p.appendChild(document.createTextNode(": estás viendo tus precios profesionales. "));
  var link = document.createElement("a");
  link.href = "/profesionales";
  link.textContent = "Tu cuenta";
  p.appendChild(link);
  banner.appendChild(p);
}

function initB2bPage(ready) {
  var page = document.getElementById("b2b-page");
  if (!page) return;
  var form = document.getElementById("b2b-login-form");
  var accountBox = document.getElementById("b2b-account");
  var errorEl = document.getElementById("b2b-login-error");

  function render() {
    if (b2b) {
      document.getElementById("b2b-account-company").textContent = b2b.account.company_name;
      form.hidden = true;
      accountBox.hidden = false;
    } else {
      accountBox.hidden = true;
      form.hidden = false;
    }
  }

  ready.then(render);

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    errorEl.hidden = true;
    fetch("/api/b2b/login", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: form.email.value.trim(), password: form.password.value }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok) throw new Error(result.data.error || "No se pudo iniciar sesión.");
        form.password.value = "";
        return loadB2b();
      })
      .then(function () {
        render();
        updateCartBadge();
      })
      .catch(function (err) {
        errorEl.textContent = err.message || "No se pudo iniciar sesión.";
        errorEl.hidden = false;
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });

  document.getElementById("b2b-logout-btn").addEventListener("click", function () {
    fetch("/api/b2b/logout", { method: "POST", credentials: "same-origin" })
      .catch(function () {})
      .then(function () {
        b2b = null;
        setB2bFlag(false);
        render();
      });
  });
}

function getCart() {
  try {
    var raw = localStorage.getItem(CART_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (e) {
    return [];
  }
}

function saveCart(cart) {
  localStorage.setItem(CART_KEY, JSON.stringify(cart));
  updateCartBadge();
}

function addToCart(sku, name, priceCents, qty, category) {
  var cart = getCart();
  var existing = cart.find(function (i) {
    return i.sku === sku;
  });
  if (existing) {
    existing.quantity += qty;
    existing.category = category;
  } else {
    cart.push({ sku: sku, name: name, priceCents: priceCents, quantity: qty, category: category });
  }
  saveCart(cart);
}

function removeFromCart(sku) {
  saveCart(
    getCart().filter(function (i) {
      return i.sku !== sku;
    }),
  );
}

function updateQty(sku, qty) {
  var cart = getCart();
  var item = cart.find(function (i) {
    return i.sku === sku;
  });
  if (!item) return;
  item.quantity = Math.max(1, qty);
  saveCart(cart);
}

function cartCount(cart) {
  return cart.reduce(function (sum, i) {
    return sum + i.quantity;
  }, 0);
}

function cartTotalCents(cart) {
  return cart.reduce(function (sum, i) {
    return sum + effectivePriceCents(i.priceCents, i.category) * i.quantity;
  }, 0);
}

function formatEur(cents) {
  return (cents / 100).toLocaleString("es-ES", { style: "currency", currency: "EUR" });
}

function updateCartBadge() {
  var badge = document.getElementById("cart-count-badge");
  if (!badge) return;
  var count = cartCount(getCart());
  badge.textContent = String(count);
  badge.hidden = count === 0;
}

function initAddToCartButtons() {
  document.addEventListener("click", function (e) {
    var btn = e.target.closest("[data-add-to-cart]");
    if (!btn || btn.disabled) return;

    var sku = btn.dataset.sku;
    var name = btn.dataset.name;
    var priceCents = parseInt(btn.dataset.priceCents, 10) || 0;
    var qty = 1;
    var qtyInputId = btn.dataset.qtyInput;
    if (qtyInputId) {
      var qtyInput = document.getElementById(qtyInputId);
      if (qtyInput) qty = Math.max(1, parseInt(qtyInput.value, 10) || 1);
    }

    addToCart(sku, name, priceCents, qty, btn.dataset.category || "");
    var original = btn.textContent;
    btn.textContent = "Añadido ✓";
    setTimeout(function () {
      btn.textContent = original;
    }, 1200);
  });
}

function buildProductCardEl(p) {
  var article = document.createElement("article");
  article.className = "product-card";

  var imgLink = document.createElement("a");
  imgLink.href = "/productos/" + p.slug;
  imgLink.className = "product-card-image";
  var img = document.createElement("img");
  img.src = p.image_url || "/img/placeholder-product.svg";
  img.alt = p.name;
  img.loading = "lazy";
  img.onerror = function () {
    img.onerror = null;
    img.src = "/img/placeholder-product.svg";
  };
  imgLink.appendChild(img);

  var body = document.createElement("div");
  body.className = "product-card-body";

  var h2 = document.createElement("h2");
  var nameLink = document.createElement("a");
  nameLink.href = "/productos/" + p.slug;
  nameLink.textContent = p.name;
  h2.appendChild(nameLink);
  body.appendChild(h2);

  var price = document.createElement("span");
  price.className = "product-price";
  price.dataset.priceCents = String(p.price_cents);
  price.dataset.category = p.category || "";
  var amount = document.createElement("span");
  amount.className = "product-price-amount";
  amount.textContent = formatEur(p.price_cents);
  price.appendChild(amount);
  var vatNote = document.createElement("span");
  vatNote.className = "price-vat-note";
  vatNote.textContent = "IVA incluido";
  price.appendChild(vatNote);
  body.appendChild(price);

  var inStock = p.stock_qty > 0;
  if (!inStock) {
    var badge = document.createElement("span");
    badge.className = "product-stock-badge out";
    badge.textContent = "Agotado";
    body.appendChild(badge);
  }

  var btn = document.createElement("button");
  btn.type = "button";
  btn.className = "site-btn product-add-btn";
  btn.setAttribute("data-add-to-cart", "");
  btn.dataset.sku = p.sku;
  btn.dataset.name = p.name;
  btn.dataset.priceCents = String(p.price_cents);
  btn.dataset.category = p.category || "";
  btn.disabled = !inStock;
  btn.textContent = "Añadir";
  body.appendChild(btn);

  article.appendChild(imgLink);
  article.appendChild(body);
  applyB2bPrices(article);
  return article;
}

function initProductSearch() {
  var input = document.getElementById("product-search-input");
  var resultsGrid = document.getElementById("product-search-results");
  var emptyMsg = document.getElementById("product-search-empty");
  // Both belong to browsing, not to a result set: the merchandising blocks and
  // the paginated grid are what the search results stand in for, so they hide
  // and come back together. Leaving the blocks up would strand them between the
  // search box and its results.
  var browseSections = [
    document.getElementById("shop-blocks"),
    document.getElementById("product-browse"),
  ].filter(Boolean);
  if (!input || !resultsGrid) return;

  var debounceTimer = null;
  var currentRequestId = 0;

  function setBrowseHidden(hidden) {
    browseSections.forEach(function (el) {
      el.hidden = hidden;
    });
  }

  function showBrowse() {
    resultsGrid.hidden = true;
    resultsGrid.textContent = "";
    if (emptyMsg) emptyMsg.hidden = true;
    setBrowseHidden(false);
  }

  function runSearch(query) {
    var requestId = ++currentRequestId;
    fetch("/api/products?q=" + encodeURIComponent(query))
      .then(function (r) {
        return r.json();
      })
      .then(function (data) {
        if (requestId !== currentRequestId) return; // a newer keystroke already fired
        var products = data.products || [];
        resultsGrid.textContent = "";
        setBrowseHidden(true);

        if (products.length === 0) {
          resultsGrid.hidden = true;
          if (emptyMsg) emptyMsg.hidden = false;
          return;
        }

        if (emptyMsg) emptyMsg.hidden = true;
        resultsGrid.hidden = false;
        products.forEach(function (p) {
          resultsGrid.appendChild(buildProductCardEl(p));
        });
      })
      .catch(function () {
        if (requestId !== currentRequestId) return;
      });
  }

  input.addEventListener("input", function () {
    var query = input.value.trim();
    clearTimeout(debounceTimer);
    if (query.length < 2) {
      showBrowse();
      return;
    }
    debounceTimer = setTimeout(function () {
      runSearch(query);
    }, 300);
  });
}

function renderCartPage() {
  var table = document.getElementById("cart-table");
  var itemsBody = document.getElementById("cart-items");
  var totalCell = document.getElementById("cart-total");
  var emptyMsg = document.getElementById("cart-empty-msg");
  var form = document.getElementById("checkout-form");
  if (!table || !itemsBody) return;

  var cart = getCart();
  if (cart.length === 0) {
    table.hidden = true;
    if (form) form.hidden = true;
    if (emptyMsg) emptyMsg.hidden = false;
    return;
  }

  if (emptyMsg) emptyMsg.hidden = true;
  table.hidden = false;
  if (form) form.hidden = false;

  itemsBody.textContent = "";
  cart.forEach(function (item) {
    var tr = document.createElement("tr");

    var nameCell = document.createElement("td");
    nameCell.textContent = item.name;

    var qtyCell = document.createElement("td");
    var qtyInput = document.createElement("input");
    qtyInput.type = "number";
    qtyInput.min = "1";
    qtyInput.value = String(item.quantity);
    qtyInput.className = "cart-item-qty";
    qtyInput.dataset.sku = item.sku;
    qtyCell.appendChild(qtyInput);

    var priceCell = document.createElement("td");
    priceCell.textContent = formatEur(effectivePriceCents(item.priceCents, item.category) * item.quantity);

    var actionCell = document.createElement("td");
    var removeBtn = document.createElement("button");
    removeBtn.type = "button";
    removeBtn.className = "cart-item-remove";
    removeBtn.dataset.sku = item.sku;
    removeBtn.textContent = "Quitar";
    actionCell.appendChild(removeBtn);

    tr.appendChild(nameCell);
    tr.appendChild(qtyCell);
    tr.appendChild(priceCell);
    tr.appendChild(actionCell);
    itemsBody.appendChild(tr);
  });
  var total = cartTotalCents(cart);
  totalCell.textContent = formatEur(total);
  var vatNote = table.querySelector("tfoot .price-vat-note");
  if (vatNote) {
    if (b2b) {
      var vat = vatCents(total, b2b.vat_rate);
      vatNote.textContent =
        "Precios profesionales sin IVA · IVA (" + formatPct(b2b.vat_rate * 100) + "): " +
        formatEur(vat) + " · Total con IVA: " + formatEur(total + vat);
    } else {
      vatNote.textContent = "IVA incluido";
    }
  }
}

// A signed-in account has already told us who it is; don't make it type it
// again. Only fills empty fields, so nothing the customer typed is replaced.
function prefillCheckoutFromB2b() {
  var form = document.getElementById("checkout-form");
  if (!form || !b2b) return;
  var a = b2b.account;
  // Each field is optional: a template that drops one must not throw here,
  // or the rest of the B2B init after this call never runs.
  function fill(name, value) {
    var field = form.elements.namedItem(name);
    if (field && !field.value && value) field.value = value;
  }
  fill("customer_name", a.contact_name || a.company_name);
  fill("customer_email", a.email);
  fill("customer_phone", a.phone);
}

function initCartPage() {
  var table = document.getElementById("cart-table");
  if (!table) return;

  renderCartPage();

  table.addEventListener("change", function (e) {
    if (!e.target.classList.contains("cart-item-qty")) return;
    updateQty(e.target.dataset.sku, parseInt(e.target.value, 10) || 1);
    renderCartPage();
  });

  table.addEventListener("click", function (e) {
    var btn = e.target.closest(".cart-item-remove");
    if (!btn) return;
    removeFromCart(btn.dataset.sku);
    renderCartPage();
  });

  var form = document.getElementById("checkout-form");
  var successBox = document.getElementById("checkout-success");
  if (!form) return;

  form.addEventListener("submit", function (e) {
    e.preventDefault();
    var cart = getCart();
    if (cart.length === 0) return;

    var submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;

    fetch("/api/reservations", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        customer_name: form.customer_name.value.trim(),
        customer_email: form.customer_email.value.trim(),
        customer_phone: form.customer_phone.value.trim(),
        notes: form.notes.value.trim(),
        items: cart.map(function (i) {
          return { sku: i.sku, quantity: i.quantity };
        }),
      }),
    })
      .then(function (r) {
        return r.json().then(function (data) {
          return { ok: r.ok, data: data };
        });
      })
      .then(function (result) {
        if (!result.ok || !result.data.success) {
          successBox.hidden = false;
          successBox.textContent = result.data.error || "No se pudo confirmar la reserva.";
          successBox.style.color = "var(--accent)";
          return;
        }
        localStorage.removeItem(CART_KEY);
        updateCartBadge();
        table.hidden = true;
        form.hidden = true;
        successBox.hidden = false;
        // The server's total, not ours: it is what the reservation records.
        var d = result.data;
        successBox.textContent =
          "Reserva confirmada (nº " + d.id + ", total " +
          (d.vat_included
            ? formatEur(d.total_cents)
            : formatEur(d.total_cents) + " sin IVA, " + formatEur(d.total_cents + d.vat_cents) + " con IVA") +
          (d.b2b ? ", con precios profesionales" : "") +
          "). Te avisaremos para confirmar la entrega.";
        successBox.style.color = "var(--text-primary)";
      })
      .catch(function () {
        successBox.hidden = false;
        successBox.textContent = "No se pudo confirmar la reserva.";
        successBox.style.color = "var(--accent)";
      })
      .finally(function () {
        submitBtn.disabled = false;
      });
  });
}

document.addEventListener("DOMContentLoaded", function () {
  updateCartBadge();
  initAddToCartButtons();
  initProductSearch();
  initCartPage();

  // The sign-in page asks unconditionally, flag or not: it is the page someone
  // opens precisely when they are unsure whether they are signed in.
  var askB2b = hasB2bFlag() || Boolean(document.getElementById("b2b-page"));
  var b2bReady = askB2b ? loadB2b() : Promise.resolve(null);
  initB2bPage(b2bReady);
  b2bReady.then(function () {
    if (!b2b) return;
    applyB2bPrices(document);
    updateB2bBanner();
    renderCartPage();
    prefillCheckoutFromB2b();
  });
});
