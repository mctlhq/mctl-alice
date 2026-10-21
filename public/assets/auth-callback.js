// /auth/callback (implicit flow): sends the token from the URL fragment to the
// server and lists the speakers found. Speaker names come from the user's
// Yandex home, so they are rendered as text, never as HTML.
(function () {
  var params = new URLSearchParams(window.location.hash.substring(1));
  var token = params.get("access_token");
  var state = params.get("state");
  var statusEl = document.getElementById("status");
  var speakersEl = document.getElementById("speakers");
  var actionsEl = document.getElementById("actions");
  if (!statusEl || !speakersEl || !actionsEl) return;

  // Swaps only the alert-* modifier: the element keeps its other classes,
  // including the layout class that replaced its inline style.
  function setAlert(el, kind) {
    el.classList.remove("alert-info", "alert-success", "alert-error", "alert-warning");
    el.classList.add("alert", "alert-" + kind);
  }

  function lang() {
    return document.documentElement.getAttribute("lang") || "ru";
  }

  function getI18nText(key, fallback) {
    var dict = window.mctlAliceTranslations && window.mctlAliceTranslations[lang()];
    return (dict && dict[key]) || fallback;
  }

  function renderSpeakers(names) {
    var prefix = document.createElement("strong");
    prefix.textContent = getI18nText("callback_speakers_found", "Найденные колонки:");
    speakersEl.replaceChildren(prefix);
    names.forEach(function (name) {
      speakersEl.appendChild(document.createElement("br"));
      speakersEl.appendChild(document.createTextNode("• " + String(name)));
    });
  }

  if (!token) {
    setAlert(statusEl, "error");
    statusEl.textContent = getI18nText("callback_status_token_missing", "❌ Токен не найден в URL редиректа.");
    return;
  }

  statusEl.textContent = getI18nText("callback_status_connecting", "Токен получен. Подключение к колонкам...");
  fetch("/auth/save-token", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ token: token, state: state }),
  })
    .then(function (res) { return res.json(); })
    .then(function (data) {
      if (data.status === "ok") {
        setAlert(statusEl, "success");
        statusEl.textContent = getI18nText("callback_status_connected", "✅ Успешно! Умный дом подключен к mctl-alice.");
        actionsEl.style.display = "flex";
        if (Array.isArray(data.speakers) && data.speakers.length > 0) {
          speakersEl.style.display = "block";
          renderSpeakers(data.speakers);
        }
      } else {
        setAlert(statusEl, "error");
        var errPrefix = lang() === "en" ? "❌ Verification error: " : "❌ Ошибка проверки: ";
        var unknownErr = lang() === "en" ? "unknown error" : "неизвестная ошибка";
        statusEl.textContent = errPrefix + (data.message || unknownErr);
      }
    })
    .catch(function (err) {
      setAlert(statusEl, "error");
      statusEl.textContent = (lang() === "en" ? "❌ Error: " : "❌ Ошибка: ") + err.message;
    });
})();
