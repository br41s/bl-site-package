/* Client-side cart for the reserve-without-payment catalog. Cart state lives in
   localStorage (no server session) — checkout POSTs it to /api/reservations,
   which recomputes prices server-side from the current catalog. */

var CART_KEY = "bl_cart_v1";

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

function addToCart(sku, name, priceCents, qty) {
  var cart = getCart();
  var existing = cart.find(function (i) {
    return i.sku === sku;
  });
  if (existing) {
    existing.quantity += qty;
  } else {
    cart.push({ sku: sku, name: name, priceCents: priceCents, quantity: qty });
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
    return sum + i.priceCents * i.quantity;
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

    addToCart(sku, name, priceCents, qty);
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
  price.textContent = formatEur(p.price_cents);
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
  btn.disabled = !inStock;
  btn.textContent = "Añadir";
  body.appendChild(btn);

  article.appendChild(imgLink);
  article.appendChild(body);
  return article;
}

function initProductSearch() {
  var input = document.getElementById("product-search-input");
  var resultsGrid = document.getElementById("product-search-results");
  var emptyMsg = document.getElementById("product-search-empty");
  var browse = document.getElementById("product-browse");
  if (!input || !resultsGrid) return;

  var debounceTimer = null;
  var currentRequestId = 0;

  function showBrowse() {
    resultsGrid.hidden = true;
    resultsGrid.textContent = "";
    if (emptyMsg) emptyMsg.hidden = true;
    if (browse) browse.hidden = false;
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
        if (browse) browse.hidden = true;

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
    priceCell.textContent = formatEur(item.priceCents * item.quantity);

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
  totalCell.textContent = formatEur(cartTotalCents(cart));
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
        successBox.textContent =
          "Reserva confirmada (nº " + result.data.id + "). Te avisaremos para confirmar la entrega.";
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
});
