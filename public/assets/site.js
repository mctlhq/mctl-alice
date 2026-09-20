// Shared by mctl-alice web pages. Theme handling, i18n, and MCP URL utilities.
(function () {
  var root = document.documentElement;

  // ── Theme toggle ─────────────────────────────────────────────────────────
  var storedTheme = null;
  try { storedTheme = localStorage.getItem("alice-theme"); } catch (e) {}
  if (storedTheme === "light" || storedTheme === "dark") root.setAttribute("data-theme", storedTheme);

  var themeToggle = document.getElementById("theme-toggle");
  if (themeToggle) {
    themeToggle.hidden = false;
    themeToggle.addEventListener("click", function () {
      var current = root.getAttribute("data-theme");
      if (!current) {
        current = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
      }
      var next = current === "dark" ? "light" : "dark";
      root.setAttribute("data-theme", next);
      try { localStorage.setItem("alice-theme", next); } catch (e) {}
    });
  }

  // ── Dynamic MCP endpoint URL based on current host ──────────────────────
  var origin = window.location.origin;
  var mcpUrl = origin + "/mcp";
  var sseUrl = origin + "/sse";

  function updateUrls() {
    var targetMcp = document.getElementById("mcp-url");
    if (targetMcp) targetMcp.textContent = mcpUrl;

    Array.prototype.forEach.call(document.querySelectorAll(".mcp-url-slot"), function (slot) {
      slot.textContent = mcpUrl;
    });

    Array.prototype.forEach.call(document.querySelectorAll(".sse-url-slot"), function (slot) {
      slot.textContent = sseUrl;
    });
  }
  updateUrls();

  // ── Copy URL button ─────────────────────────────────────────────────────
  var copy = document.getElementById("copy-url");
  var copyTimer = null;
  if (copy && navigator.clipboard) {
    copy.addEventListener("click", function () {
      navigator.clipboard.writeText(mcpUrl).then(function () {
        if (copyTimer) clearTimeout(copyTimer);
        copy.textContent = copy.dataset.done || "Скопировано!";
        copyTimer = setTimeout(function () {
          copy.textContent = copy.dataset.idle || "Скопировать MCP URL";
          copyTimer = null;
        }, 1600);
      });
    });
  } else if (copy) {
    copy.hidden = true;
  }

  // ── Multi-language (i18n) ────────────────────────────────────────────────
  var translations = {
    ru: {
      meta_title: "mctl-alice — Управление Яндекс Станцией и умным домом через AI (MCP)",
      meta_desc: "Model Context Protocol (MCP) сервер для Яндекс Станций и умного дома. Управляйте колонками Алиса, отправляйте голосовые команды, воспроизводите произвольный текст TTS через Claude, ChatGPT, Cursor и Antigravity.",
      nav_login: "Вход (OAuth)",
      nav_cookie: "Quasar Cookie",
      nav_github: "GitHub",
      hero_eyebrow: "Model Context Protocol",
      hero_title: "Голосовое управление Яндекс Станцией<br>и умным домом для AI-ассистентов",
      hero_lead: "mctl-alice соединяет ваших AI-ассистентов (Claude, ChatGPT, Cursor, Antigravity) с умными колонками Яндекс Станция и устройствами умного дома. Произносите произвольные фразы (TTS), симулируйте голосовые команды текстом, управляйте громкостью, музыкой и сценариями.",
      hero_copy_idle: "Скопировать MCP URL",
      hero_copy_done: "Скопировано!",
      hero_login_btn: "Войти через Яндекс",
      features_title: "Возможности",
      features_subtitle: "Все ключевые сценарии взаимодействия с голосовым помощником Алиса в виде стандартных инструментов MCP.",
      card_cmd_title: "Симуляция голосовых команд",
      card_cmd_desc: "Выполнение любых команд текстом ровно так, как если бы вы произнесли их вслух в микрофон колонки: «Включи джаз», «Какая погода завтра», «Выключи свет везде».",
      card_tts_title: "Произвольная речь (TTS)",
      card_tts_desc: "Озвучивание любого произвольного текста через выбранную колонку. Идеально для голосовых уведомлений, напоминаний, утренних сводок и ответов ассистента.",
      card_vol_title: "Управление громкостью",
      card_vol_desc: "Точная регулировка громкости от 1 до 10 для конкретной колонки, комнаты или устройства по умолчанию.",
      card_media_title: "Управление медиа-плеером",
      card_media_desc: "Пауза, возобновление проигрывания, остановка трека, переключение на следующий или предыдущий трек в Яндекс Музыке.",
      card_discovery_title: "Обнаружение умного дома",
      card_discovery_desc: "Автоматическое получение списка всех колонок, комнат, групп и умных устройств пользователя с информацией об их возможностях.",
      card_scenarios_title: "Сценарии автоматизации",
      card_scenarios_desc: "Мгновенный триггер настроенных сценариев умного дома Яндекса по их названию или идентификатору («Доброе утро», «Ушел из дома», «Кино»).",
      tools_title: "Инструменты MCP",
      tools_subtitle: "Набор инструментов, регистрируемых сервером mctl-alice. AI-ассистент вызывает их автоматически в диалоге.",
      th_tool: "Инструмент",
      th_desc: "Назначение",
      th_params: "Параметры",
      th_action: "Действие",
      badge_read: "чтение",
      badge_control: "управление",
      badge_scenario: "сценарий",
      desc_devices: "Список всех колонок, комнат и умных устройств.",
      desc_cmd: "Выполнение голосовой команды текстом (прямая симуляция речи).",
      desc_say: "Синтез произвольной речи через колонку (TTS-сообщения).",
      desc_vol: "Установка громкости от 1 до 10.",
      desc_media: "Управление плеером: play, pause, stop, next, prev.",
      desc_scenario: "Запуск сценария умного дома по названию или ID.",
      prompts_title: "Примеры запросов к ассистенту",
      prompts_subtitle: "После подключения просто общайтесь с вашим AI-ассистентом на естественном языке.",
      prompt_1: "<strong>«Какие колонки Алиса у меня есть и в каких комнатах?»</strong> — ассистент вызывает <code>alice_list_devices</code> и показывает список с именами и расположением.",
      prompt_2: "<strong>«Включи джаз на колонке в гостиной»</strong> — ассистент симулирует голосовую команду для станции в гостиной через <code>alice_send_command</code>.",
      prompt_3: "<strong>«Сделай громкость 4 на кухне»</strong> — <code>alice_set_volume</code> меняет громкость целевого устройства.",
      prompt_4: "<strong>«Скажи через колонку в детской, что пора обедать»</strong> — <code>alice_say_phrase</code> синтезирует речь через нужную станцию.",
      prompt_5: "<strong>«Поставь музыку на паузу»</strong> — <code>alice_media_control</code> приостанавливает текущее воспроизведение.",
      prompt_6: "<strong>«Запусти сценарий Спокойной ночи»</strong> — <code>alice_trigger_scenario</code> активирует вечернюю автоматизацию.",
      setup_title: "Как подключить",
      setup_subtitle: "Три простых шага для подключения к вашим любимым AI-клиентам.",
      setup_step1_title: "Шаг 1. Добавьте коннектор в вашего AI-ассистента:",
      setup_step1_endpoint_label: "Используйте публичный эндпоинт:",
      setup_step1_claude: "• <strong>Claude.ai</strong>: перейдите в <em>Customize → Connectors → “+” → Add custom connector</em>, вставьте URL <code class=\"mcp-url-slot\">" + mcpUrl + "</code> (или SSE: <code class=\"sse-url-slot\">" + sseUrl + "</code>) и нажмите <em>Add</em>.",
      setup_step1_chatgpt: "• <strong>ChatGPT</strong>: откройте <em>Settings → Apps &amp; Connectors → Advanced settings → Developer mode</em>, затем в <em>Apps &amp; Connectors → Create</em> укажите URL <code class=\"mcp-url-slot\">" + mcpUrl + "</code>. Сервер поддерживает RFC 8414 &amp; OAuth 2.1 — ChatGPT автоматически проведет вас через авторизацию в Яндексе.",
      setup_step2_title: "Шаг 2. Авторизуйтесь в Яндексе (OAuth):",
      setup_step2_desc: "При подключении через ChatGPT или Claude.ai окно авторизации Яндекса откроется автоматически. Вы также можете выполнить вход заранее на странице <a href=\"/auth/login\">/auth/login</a>. Это свяжет ваш токен управления умным домом с сессией MCP.",
      setup_step3_title: "Шаг 3 (Опционально). Настройте Quasar Cookie для динамического TTS:",
      setup_step3_desc: "Официальный облачный IoT API Яндекса поддерживает переключение сценариев и базовые действия. Для произвольного воспроизведения любого текста (TTS) и выполнения динамических текстовых голосовых команд перейдите на страницу <a href=\"/auth/cookie\">/auth/cookie</a> и сохраните сессионную куку <code>Session_id</code> от yandex.ru.",
      faq_title: "Частые вопросы",
      faq_q1: "Безопасно ли подключать умный дом через mctl-alice?",
      faq_a1: "Да. mctl-alice использует стандартный протокол OAuth 2.1 с защитой PKCE. Токены шифруются, а запросы к устройствам выполняются исключительно по защищенным каналам через официальные API Яндекса.",
      faq_q2: "Какие модели колонок Яндекс Станция поддерживаются?",
      faq_a2: "Поддерживаются все актуальные модели: Яндекс Станция Макс, Станция Миди, Станция 2, Станция Лайт, Станция Мини, Станция Дуо Макс, а также сторонние устройства с поддержкой голосового помощника Алиса.",
      faq_q3: "В чем разница между IoT API и Quasar API?",
      faq_a3: "Официальный IoT API Яндекса позволяет опрашивать статус устройств и запускать заранее подготовленные сценарии. Quasar API предоставляет прямой доступ к воспроизведению произвольного текста через встроенный синтезатор речи (TTS) и эмуляции живых голосовых команд.",
      faq_q4: "Можно ли управлять устройствами умного дома других брендов?",
      faq_a4: "Да! Любое устройство (лампочки, розетки, реле, роботы-пылесосы, кондиционеры), привязанное к вашему умному дому в приложении «Дом с Алисой», доступно для симуляции команд и запуска через сценарии.",
      footer_part: "mctl-alice — часть платформы <a href=\"https://mctl.ai\" target=\"_blank\" rel=\"noopener\">mctl</a>."
    },
    en: {
      meta_title: "mctl-alice — Yandex Station & Smart Home Control via AI (MCP)",
      meta_desc: "Model Context Protocol (MCP) server for Yandex Station smart speakers and smart home devices. Control Alice speakers, issue voice commands, synthesize text-to-speech (TTS) via Claude, ChatGPT, Cursor, and Antigravity.",
      nav_login: "Sign In (OAuth)",
      nav_cookie: "Quasar Cookie",
      nav_github: "GitHub",
      hero_eyebrow: "Model Context Protocol",
      hero_title: "Voice Control for Yandex Station<br>& Smart Home for AI Assistants",
      hero_lead: "mctl-alice connects your AI assistants (Claude, ChatGPT, Cursor, Antigravity) to Yandex Station smart speakers and smart home devices. Speak arbitrary text (TTS), simulate voice commands via text, adjust volume, control music playback, and run routines.",
      hero_copy_idle: "Copy MCP URL",
      hero_copy_done: "Copied!",
      hero_login_btn: "Log in with Yandex",
      features_title: "Capabilities",
      features_subtitle: "All key interaction scenarios with the Alice voice assistant available as standard MCP tools.",
      card_cmd_title: "Voice Command Simulation",
      card_cmd_desc: "Execute any command via text exactly as if spoken into the speaker's microphone: “Play jazz”, “What is the weather tomorrow”, “Turn off all lights”.",
      card_tts_title: "Arbitrary Speech (TTS)",
      card_tts_desc: "Vocalize arbitrary text through any chosen speaker. Ideal for voice notifications, reminders, morning briefings, and assistant answers.",
      card_vol_title: "Volume Control",
      card_vol_desc: "Precise volume adjustments from 1 to 10 for specific speakers, rooms, or default devices.",
      card_media_title: "Media Player Control",
      card_media_desc: "Pause, resume, stop playback, and jump to next or previous track in Yandex Music.",
      card_discovery_title: "Smart Home Discovery",
      card_discovery_desc: "Automatically discover all speakers, rooms, groups, and smart home appliances along with capability details.",
      card_scenarios_title: "Automation Scenarios",
      card_scenarios_desc: "Instantly trigger pre-configured Yandex Smart Home routines by name or ID (“Good Morning”, “Leaving Home”, “Movie Time”).",
      tools_title: "MCP Tools",
      tools_subtitle: "Set of tools exposed by the mctl-alice server. Your AI assistant invokes them automatically during conversation.",
      th_tool: "Tool",
      th_desc: "Purpose",
      th_params: "Parameters",
      th_action: "Action",
      badge_read: "read",
      badge_control: "control",
      badge_scenario: "routine",
      desc_devices: "List all speakers, rooms, and smart devices.",
      desc_cmd: "Execute voice command as text (direct speech simulation).",
      desc_say: "Synthesize arbitrary speech through the speaker (TTS messages).",
      desc_vol: "Set speaker volume from 1 to 10.",
      desc_media: "Media player control: play, pause, stop, next, prev.",
      desc_scenario: "Run smart home routine by name or ID.",
      prompts_title: "Sample Assistant Prompts",
      prompts_subtitle: "Once connected, converse naturally with your AI assistant using everyday language.",
      prompt_1: "<strong>“What Alice speakers do I have and in which rooms?”</strong> — assistant invokes <code>alice_list_devices</code> and lists their names and locations.",
      prompt_2: "<strong>“Play jazz on the living room speaker”</strong> — assistant simulates the voice command for the living room station via <code>alice_send_command</code>.",
      prompt_3: "<strong>“Set kitchen volume to 4”</strong> — <code>alice_set_volume</code> changes the volume on the target device.",
      prompt_4: "<strong>“Announce on the nursery speaker that dinner is ready”</strong> — <code>alice_say_phrase</code> vocalizes speech through the selected station.",
      prompt_5: "<strong>“Pause the music”</strong> — <code>alice_media_control</code> pauses current playback.",
      prompt_6: "<strong>“Trigger the Good Night routine”</strong> — <code>alice_trigger_scenario</code> activates the evening routine.",
      setup_title: "Setup Guide",
      setup_subtitle: "Three simple steps to connect with your favorite AI clients.",
      setup_step1_title: "Step 1. Add connector to your AI assistant:",
      setup_step1_endpoint_label: "Use the public endpoint:",
      setup_step1_claude: "• <strong>Claude.ai</strong>: go to <em>Customize → Connectors → “+” → Add custom connector</em>, paste URL <code class=\"mcp-url-slot\">" + mcpUrl + "</code> (or SSE: <code class=\"sse-url-slot\">" + sseUrl + "</code>) and click <em>Add</em>.",
      setup_step1_chatgpt: "• <strong>ChatGPT</strong>: open <em>Settings → Apps &amp; Connectors → Advanced settings → Developer mode</em>, then under <em>Apps &amp; Connectors → Create</em> enter URL <code class=\"mcp-url-slot\">" + mcpUrl + "</code>. The server supports RFC 8414 &amp; OAuth 2.1 — ChatGPT will guide you through Yandex authorization.",
      setup_step2_title: "Step 2. Log in with Yandex (OAuth):",
      setup_step2_desc: "When connecting via ChatGPT or Claude.ai, the Yandex login window opens automatically. You can also sign in ahead of time at <a href=\"/auth/login\">/auth/login</a> to link your smart home access token to your MCP session.",
      setup_step3_title: "Step 3 (Optional). Configure Quasar Cookie for dynamic TTS:",
      setup_step3_desc: "The official Yandex IoT Cloud API supports scenario triggers and basic controls. For arbitrary speech synthesis (TTS) and dynamic text voice commands, visit <a href=\"/auth/cookie\">/auth/cookie</a> and save your <code>Session_id</code> cookie from yandex.ru.",
      faq_title: "Frequently Asked Questions",
      faq_q1: "Is it safe to connect smart home through mctl-alice?",
      faq_a1: "Yes. mctl-alice uses OAuth 2.1 with PKCE. Tokens are encrypted and device commands are transmitted securely via official Yandex APIs.",
      faq_q2: "Which Yandex Station models are supported?",
      faq_a2: "All current models are supported: Yandex Station Max, Station Midi, Station 2, Station Lite, Station Mini, Station Duo Max, as well as third-party hardware powered by Alice.",
      faq_q3: "What is the difference between IoT API and Quasar API?",
      faq_a3: "The official Yandex IoT API queries device status and runs pre-made routines. The Quasar API unlocks direct arbitrary text-to-speech (TTS) playback and live voice command emulation.",
      faq_q4: "Can I control smart home devices from other brands?",
      faq_a4: "Yes! Any device (lights, plugs, relays, robot vacuums, ACs) connected to your smart home in the 'Home with Alice' app can be controlled via command simulation and routines.",
      footer_part: "mctl-alice is part of the <a href=\"https://mctl.ai\" target=\"_blank\" rel=\"noopener\">mctl</a> platform."
    }
  };

  function applyLanguage(lang) {
    if (lang !== "ru" && lang !== "en") lang = "ru";
    var dict = translations[lang];
    if (!dict) return;

    root.setAttribute("lang", lang);
    try { localStorage.setItem("alice-lang", lang); } catch (e) {}

    // Update document title and meta description
    if (dict.meta_title) document.title = dict.meta_title;
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && dict.meta_desc) metaDesc.setAttribute("content", dict.meta_desc);

    // Update copy button dataset
    if (copy) {
      copy.dataset.idle = dict.hero_copy_idle;
      copy.dataset.done = dict.hero_copy_done;
      if (!copyTimer) {
        copy.textContent = dict.hero_copy_idle;
      }
    }

    // Update text elements
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n]"), function (el) {
      var key = el.getAttribute("data-i18n");
      if (dict[key] !== undefined) {
        el.textContent = dict[key];
      }
    });

    // Update HTML elements
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-html]"), function (el) {
      var key = el.getAttribute("data-i18n-html");
      if (dict[key] !== undefined) {
        el.innerHTML = dict[key];
      }
    });

    // Update segmented lang switcher buttons
    Array.prototype.forEach.call(document.querySelectorAll(".lang-btn[data-lang]"), function (btn) {
      var btnLang = btn.getAttribute("data-lang");
      if (btnLang === lang) {
        btn.classList.add("is-active");
      } else {
        btn.classList.remove("is-active");
      }
    });

    // Update single lang toggle button label (shows the next language to switch to)
    var langBtn = document.getElementById("lang-toggle");
    if (langBtn) {
      langBtn.textContent = lang === "ru" ? "EN" : "RU";
      langBtn.setAttribute("aria-label", lang === "ru" ? "Switch language to English" : "Переключить язык на русский");
    }

    updateUrls();
  }

  // Expose globally for programmatic access and verification
  window.mctlAliceSetLanguage = applyLanguage;

  // Determine initial language
  var initialLang = "ru";
  try {
    var storedLang = localStorage.getItem("alice-lang");
    if (storedLang === "ru" || storedLang === "en") {
      initialLang = storedLang;
    }
  } catch (e) {}

  // Wire segmented lang buttons
  Array.prototype.forEach.call(document.querySelectorAll(".lang-btn[data-lang]"), function (btn) {
    btn.addEventListener("click", function () {
      var targetLang = btn.getAttribute("data-lang");
      if (targetLang) {
        applyLanguage(targetLang);
      }
    });
  });

  // Wire single toggle button fallback
  var singleLangBtn = document.getElementById("lang-toggle");
  if (singleLangBtn) {
    singleLangBtn.addEventListener("click", function () {
      var currentLang = root.getAttribute("lang") || "ru";
      var nextLang = currentLang === "ru" ? "en" : "ru";
      applyLanguage(nextLang);
    });
  }

  applyLanguage(initialLang);
})();
