// Shared by mctl-alice web pages. Theme handling and MCP URL utilities.
(function () {
  var root = document.documentElement;

  var stored = null;
  try { stored = localStorage.getItem("alice-theme"); } catch (e) {}
  if (stored === "light" || stored === "dark") root.setAttribute("data-theme", stored);

  var toggle = document.getElementById("theme-toggle");
  if (toggle) {
    toggle.hidden = false;
    toggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      if (!current) {
        current = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("alice-theme", next); } catch (e) {}
    });
  }

  // Dynamic MCP endpoint URL based on current host
  var origin = window.location.origin;
  var mcpUrl = origin + "/mcp";
  var sseUrl = origin + "/sse";

  var targetMcp = document.getElementById("mcp-url");
  if (targetMcp) targetMcp.textContent = mcpUrl;

  Array.prototype.forEach.call(document.querySelectorAll(".mcp-url-slot"), function (slot) {
    slot.textContent = mcpUrl;
  });

  Array.prototype.forEach.call(document.querySelectorAll(".sse-url-slot"), function (slot) {
    slot.textContent = sseUrl;
  });

  // Copy URL button
  var copy = document.getElementById("copy-url");
  if (copy && navigator.clipboard) {
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(mcpUrl).then(function () {
        var originalText = copy.textContent;
        copy.textContent = copy.dataset.done || "Скопировано!";
        setTimeout(function () { copy.textContent = copy.dataset.idle || originalText; }, 1600);
      });
    });
  } else if (copy) {
    copy.hidden = true;
  }
})();
