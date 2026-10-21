// Applies the saved theme and language before first paint. Loaded as an
// external script so the Content-Security-Policy can forbid inline scripts.
try {
  var t = localStorage.getItem("alice-theme");
  if (t === "light" || t === "dark") document.documentElement.setAttribute("data-theme", t);
  var l = localStorage.getItem("alice-lang");
  if (l === "ru" || l === "en") document.documentElement.setAttribute("lang", l);
} catch (e) {}
