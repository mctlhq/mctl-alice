// /auth/cookie: Quasar sign-in by QR code, with a manual cookie form as the
// fallback. The QR session starts only when the user asks for it: it hands the
// service a Yandex web session, which is broader than the OAuth grant. Server responses are rendered as text; the QR SVG is shown through
// an <img>, where an SVG cannot run script.
(function () {
  var qrFrame = document.getElementById("qr-frame");
  var qrStatus = document.getElementById("qr-status");
  var qrMobileBtn = document.getElementById("qr-mobile-btn");
  var qrRefreshBtn = document.getElementById("qr-refresh-btn");
  var qrHomeBtn = document.getElementById("qr-home-btn");
  var qrStartBtn = document.getElementById("qr-start-btn");
  if (!qrFrame || !qrStatus || !qrMobileBtn || !qrRefreshBtn || !qrHomeBtn || !qrStartBtn) return;

  var pollTimer = null;

  // Swaps only the alert-* modifier: the element keeps its other classes,
  // including the layout class that replaced its inline style.
  function setAlert(el, kind) {
    el.classList.remove("alert-info", "alert-success", "alert-error", "alert-warning");
    el.classList.add("alert", "alert-" + kind);
  }

  function lang() {
    return document.documentElement.getAttribute("lang") || "ru";
  }

  function getI18nMsg(key, fallback) {
    var dict = window.mctlAliceTranslations && window.mctlAliceTranslations[lang()];
    return (dict && dict[key]) || fallback;
  }

  function showSpinner() {
    var spinner = document.createElement("div");
    spinner.className = "qr-spinner";
    qrFrame.replaceChildren(spinner);
  }

  function showFailure() {
    var failed = document.createElement("div");
    failed.className = "qr-failed";
    failed.textContent = "❌";
    qrFrame.replaceChildren(failed);
  }

  function showQr(svg) {
    var img = document.createElement("img");
    img.alt = "QR";
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    qrFrame.replaceChildren(img);
  }

  function isHttpsLink(link) {
    try {
      return new URL(link).protocol === "https:";
    } catch (e) {
      return false;
    }
  }

  async function loadQrCode() {
    if (pollTimer) clearInterval(pollTimer);
    qrStartBtn.hidden = true;
    qrFrame.hidden = false;
    qrStatus.hidden = false;
    showSpinner();
    setAlert(qrStatus, "info");
    qrStatus.textContent = getI18nMsg("cookie_qr_waiting", "Ожидание сканирования QR-кода...");
    qrMobileBtn.style.display = "none";
    qrRefreshBtn.style.display = "none";
    qrHomeBtn.style.display = "none";

    try {
      var res = await fetch("/auth/qr-code");
      var data = await res.json();
      if (data.status === "ok" && typeof data.qrSvg === "string") {
        showQr(data.qrSvg);
        if (data.link && isHttpsLink(data.link)) {
          qrMobileBtn.href = data.link;
          qrMobileBtn.style.display = "inline-flex";
        }
        qrRefreshBtn.style.display = "inline-flex";
        startPolling(data.sessionId);
      } else {
        showFailure();
        setAlert(qrStatus, "error");
        qrStatus.textContent = data.message || "Ошибка загрузки QR-кода";
        qrRefreshBtn.style.display = "inline-flex";
      }
    } catch (err) {
      showFailure();
      setAlert(qrStatus, "error");
      qrStatus.textContent = "Ошибка сети: " + err.message;
      qrRefreshBtn.style.display = "inline-flex";
    }
  }

  function startPolling(sessionId) {
    pollTimer = setInterval(async function () {
      try {
        var res = await fetch("/auth/qr-status?sessionId=" + encodeURIComponent(sessionId));
        var data = await res.json();
        if (data.status === "ok") {
          clearInterval(pollTimer);
          setAlert(qrStatus, "success");
          qrStatus.textContent = getI18nMsg("cookie_qr_success", "✅ Авторизация успешна! Quasar Cookie настроены автоматически.");
          qrMobileBtn.style.display = "none";
          qrRefreshBtn.style.display = "none";
          qrHomeBtn.style.display = "inline-flex";
        } else if (data.status === "expired") {
          clearInterval(pollTimer);
          setAlert(qrStatus, "error");
          qrStatus.textContent = getI18nMsg("cookie_qr_expired", "Срок действия QR-кода истёк. Нажмите «Обновить QR-код».");
          qrRefreshBtn.style.display = "inline-flex";
        } else if (data.status === "error") {
          clearInterval(pollTimer);
          setAlert(qrStatus, "error");
          qrStatus.textContent = "❌ " + (data.message || "Ошибка авторизации");
          qrRefreshBtn.style.display = "inline-flex";
        }
      } catch (e) {
        // network hiccup, retry next tick
      }
    }, 2000);
  }

  qrRefreshBtn.addEventListener("click", loadQrCode);
  qrStartBtn.addEventListener("click", loadQrCode);

  // Manual form flow
  var form = document.getElementById("cookieForm");
  var input = document.getElementById("cookieInput");
  var statusEl = document.getElementById("status");
  var btn = document.getElementById("saveBtn");
  if (!form || !input || !statusEl || !btn) return;

  form.addEventListener("submit", async function (e) {
    e.preventDefault();
    var cookie = input.value.trim();
    if (!cookie) return;

    btn.disabled = true;
    statusEl.style.display = "block";
    setAlert(statusEl, "info");
    statusEl.textContent = lang() === "en" ? "Verifying session with Yandex Quasar..." : "Проверка сессии в Yandex Quasar...";

    try {
      var res = await fetch("/auth/save-cookie", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cookie: cookie }),
      });
      var data = await res.json();
      if (res.ok && data.status === "ok") {
        setAlert(statusEl, "success");
        statusEl.textContent = lang() === "en"
          ? "✅ Cookie verified and saved successfully! Dynamic TTS and voice text commands are now available."
          : "✅ Куки успешно проверены и сохранены! Теперь доступны динамический TTS (произвольный текст) и текстовые голосовые команды.";
      } else {
        setAlert(statusEl, "error");
        var errMsg = data.message || (lang() === "en" ? "failed to obtain CSRF token" : "не удалось получить CSRF токен");
        statusEl.textContent = (lang() === "en" ? "❌ Cookie verification error: " : "❌ Ошибка проверки куки: ") + errMsg;
      }
    } catch (err) {
      setAlert(statusEl, "error");
      statusEl.textContent = (lang() === "en" ? "❌ Network error: " : "❌ Ошибка сети: ") + err.message;
    } finally {
      btn.disabled = false;
    }
  });
})();
