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
      setup_step3_desc: "Официальный API Умного дома Яндекса управляет устройствами и запускает сценарии. Для синтеза речи (TTS) и произвольных текстовых команд подключите неофициальный Quasar API на странице <a href=\"/auth/cookie\">/auth/cookie</a>: он использует вашу веб-сессию Яндекса.",
      faq_title: "Частые вопросы",
      faq_q1: "Безопасно ли подключать умный дом через mctl-alice?",
      faq_a1: "Вход идёт через OAuth 2.1 с PKCE. Токены Яндекса хранятся зашифрованными (AES-256-GCM), а токены ИИ-клиентов — только в виде хешей. Устройствами умного дома сервис управляет через официальный API Умного дома Яндекса. Синтез речи и текстовые команды на колонках работают через Quasar — неофициальный API веб-интерфейса Яндекса. Он подключается только по вашему желанию и может перестать работать без предупреждения.",
      faq_q2: "Какие модели колонок Яндекс Станция поддерживаются?",
      faq_a2: "Поддерживаются все актуальные модели: Яндекс Станция Макс, Станция Миди, Станция 2, Станция Лайт, Станция Мини, Станция Дуо Макс, а также сторонние устройства с поддержкой голосового помощника Алиса.",
      faq_q3: "В чем разница между IoT API и Quasar API?",
      faq_a3: "API Умного дома Яндекса — официальный и документированный: он показывает устройства, их состояние и сценарии и управляет ими. Quasar — неофициальный внутренний API, которым пользуется веб-интерфейс Яндекса. Для него нужна ваша веб-сессия Яндекса, и через него работают синтез речи (TTS) и текстовые команды. Яндекс не поддерживает Quasar для сторонних сервисов, а сессия даёт доступ шире, чем OAuth, поэтому подключайте его только если вам нужны эти функции.",
      faq_q4: "Можно ли управлять устройствами умного дома других брендов?",
      faq_a4: "Да! Любое устройство (лампочки, розетки, реле, роботы-пылесосы, кондиционеры), привязанное к вашему умному дому в приложении «Дом с Алисой», доступно для симуляции команд и запуска через сценарии.",
      footer_part: "mctl-alice — часть платформы <a href=\"https://mctl.ai\" target=\"_blank\" rel=\"noopener\">mctl</a>. Независимый проект, не связан с ООО «Яндекс» и не одобрен им; «Яндекс», «Алиса» и «Яндекс Станция» — товарные знаки их владельцев.",
      nav_home: "Главная",
      cookie_page_title: "mctl-alice — Настройка Quasar Cookie",
      cookie_title: "mctl-alice — Настройка Quasar (Динамический голос и команды)",
      cookie_lead: "Официальный API Умного дома Яндекса не умеет произносить произвольный текст (TTS) и выполнять текстовые команды на колонках Алиса без заранее созданных сценариев.<br>Quasar — неофициальный API веб-интерфейса Яндекса. Он подключается через вашу веб-сессию Яндекса и открывает синтез речи и произвольные команды на всех ваших колонках. Сессия даёт доступ шире, чем OAuth, и Яндекс может изменить этот API без предупреждения.",
      cookie_instructions_title: "Инструкция по настройке:",
      cookie_step1: "Откройте <a href=\"https://yandex.ru/quasar\" target=\"_blank\" rel=\"noopener\">yandex.ru/quasar</a> или <a href=\"https://yandex.ru\" target=\"_blank\" rel=\"noopener\">yandex.ru</a> в браузере под вашим аккаунтом Яндекса.",
      cookie_step2: "Откройте консоль разработчика DevTools (нажмите <code>F12</code> или <code>Cmd + Option + I</code> на Mac).",
      cookie_step3: "Перейдите на вкладку <strong>Application</strong> (или <strong>Storage</strong>) → <strong>Cookies</strong> → <code>https://yandex.ru</code>.",
      cookie_step4: "Найдите строку с куки <code>Session_id</code> и скопируйте её значение (или скопируйте всю строку заголовка Cookie).",
      cookie_step5: "Вставьте в поле ввода ниже и нажмите <strong>Сохранить и проверить</strong>.",
      cookie_label: "Значение Cookie (Session_id):",
      cookie_placeholder: "Session_id=3:17... или значение Session_id",
      cookie_btn_save: "Сохранить и проверить",
      cookie_btn_home: "Вернуться на главную",
      cookie_qr_title: "Быстрая настройка через QR-код (Рекомендуется)",
      cookie_qr_desc: "Отсканируйте QR-код камерой телефона или приложением Яндекс. Сессия будет настроена автоматически без ручного поиска кук.",
      cookie_qr_waiting: "Ожидание сканирования QR-кода...",
      cookie_qr_mobile_btn: "Открыть в приложении Яндекс",
      cookie_qr_refresh: "Обновить QR-код",
      cookie_qr_success: "✅ Авторизация успешна! Quasar Cookie настроены автоматически.",
      cookie_qr_expired: "Срок действия QR-кода истёк. Нажмите «Обновить QR-код».",
      cookie_qr_start: "Показать QR-код для входа",
      cookie_qr_scope_title: "Вход по QR даёт больше прав, чем вход через OAuth",
      cookie_qr_scope_desc: "OAuth даёт сервису доступ только к API умного дома. При входе по QR сервис получает cookie веб-сессии вашего аккаунта Яндекса (Session_id) и использует её для неофициального Quasar API: синтез речи и команды на колонках. Cookie хранится зашифрованной, пока вы не отключите Quasar или не удалите аккаунт.",
      cookie_manual_toggle: "Или настроить вручную через DevTools...",
      callback_success_page_title: "mctl-alice — Авторизация успешна",
      callback_success_title: "mctl-alice — Успешный вход",
      callback_success_msg: "✅ Авторизация успешна! Получен постоянный Refresh-токен для автообновления.",
      callback_speakers_found: "Найденные колонки:",
      callback_no_speakers: "Колонки не найдены в умном доме, но токен успешно получен и сохранен.",
      callback_btn_home: "На главную",
      callback_btn_cookie: "Настроить Quasar Cookie",
      callback_btn_retry: "Попробовать снова",
      callback_error_page_title: "mctl-alice — Ошибка авторизации",
      callback_error_title: "mctl-alice — Ошибка авторизации",
      callback_status_obtaining: "Получение токена...",
      callback_status_connecting: "Токен получен. Подключение к колонкам...",
      callback_status_connected: "✅ Успешно! Умный дом подключен к mctl-alice.",
      callback_status_token_missing: "❌ Токен не обнаружен в URL перенаправления.",
      oauth_consent_title: "Авторизация приложения",
      oauth_consent_lead: "Приложение запрашивает доступ к вашему серверу Alice MCP",
      oauth_app_name: "Приложение:",
      oauth_redirect_uri: "Redirect URI:",
      oauth_scopes_title: "Запрашиваемые права доступа:",
      oauth_scope_view: "Просмотр списка комнат, устройств, датчиков и их состояния",
      oauth_scope_control: "Управление устройствами: включение и выключение, свет, громкость, медиа, запуск сценариев",
      oauth_scope_quasar: "Колонки: произнести фразу или выполнить голосовую команду (нужна подключённая cookie Quasar)",
      oauth_account_label: "Аккаунт Яндекса (умный дом, к которому выдаётся доступ):",
      oauth_account_switch: "Не тот аккаунт? Выйдите в <a href=\"/account\" target=\"_blank\" rel=\"noopener\">личном кабинете</a> и начните подключение в ИИ-клиенте заново.",
      oauth_whole_home: "Доступ выдаётся ко всему дому: ко всем устройствам, комнатам, сценариям и колонкам этого аккаунта Яндекса, включая добавленные позже. Выбрать отдельные устройства нельзя.",
      oauth_retention_title: "Что сохраняется",
      oauth_retention_tokens: "Приложение получит токен MCP на 30 дней; мы храним только его SHA-256 хеш.",
      oauth_retention_yandex: "Ваши токены Яндекса (и cookie Quasar, если вы её подключили) хранятся зашифрованными AES-256-GCM, пока вы не удалите аккаунт.",
      oauth_retention_revoke: "Отозвать доступ приложения или удалить аккаунт можно в любой момент в личном кабинете; резервные копии хранятся не дольше 14 дней.",
      oauth_status_connected: "Подключение к умному дому Яндекс Алисы активно.",
      oauth_btn_approve: "Разрешить доступ",
      oauth_btn_deny: "Отклонить",

      // Navigation & Footer
      nav_account: "Аккаунт",
      footer_account: "Личный кабинет",
      footer_about: "О сервисе",
      footer_privacy: "Конфиденциальность",
      footer_terms: "Условия",
      footer_security: "Безопасность",
      nav_privacy: "Конфиденциальность",
      nav_terms: "Условия использования",
      nav_security: "Безопасность",
      nav_about: "О сервисе",

      // Account Dashboard
      account_title: "Личный кабинет",
      account_user_label: "Пользователь",
      account_logout_btn: "Выйти",
      account_login_title: "Личный кабинет mctl-alice",
      account_login_desc: "Войдите через Яндекс ID, чтобы управлять подключениями AI-ассистентов, интеграцией с колонками и сохранёнными данными.",
      btn_login_yandex: "Войти через Яндекс ID",
      account_status_label: "Статус",
      account_quasar_title: "Голосовое управление колонками (Quasar)",
      account_quasar_status_connected: "🟢 Подключено (доступны произвольные фразы и команды)",
      account_quasar_status_not_configured: "⚪ Не настроено",
      account_quasar_disconnect_btn: "Отключить Quasar",
      account_quasar_setup_btn: "Настроить Quasar Cookie (QR)",
      account_mcp_title: "Подключённые AI-клиенты (MCP)",
      account_mcp_no_clients: "Нет активных подключений ассистентов (Claude, ChatGPT, Codex).",
      account_th_client: "Клиент",
      account_th_scope: "Разрешения",
      account_th_connected: "Подключен",
      account_th_action: "Действие",
      account_btn_revoke: "Отозвать",
      account_danger_title: "Опасная зона: удаление аккаунта",
      account_danger_desc: "Вы можете полностью удалить все данные своей учётной записи из mctl-alice. Будут немедленно отозваны все MCP-токены, удалены сохранённые зашифрованные токены Яндекса, сессии и прокси-сценарии.",
      account_delete_all_btn: "Удалить все мои данные",
      account_btn_home: "← На главную",

      // About Page
      about_title: "О сервисе mctl-alice",
      about_subtitle: "Модель контекстного протокола (MCP) и мост для подключения ИИ-ассистентов к Умному дому и колонкам Яндекса.",
      about_arch_title: "🏗 Архитектура и изоляция",
      about_arch_desc: "Сервис работает в многопользовательском (multi-tenant) режиме. Учетные данные и токены пользователей хранятся в зашифрованном виде (AES-256-GCM) с привязкой к идентификатору пользователя в качестве AAD (Additional Authenticated Data). Доступ между тенантами изолирован на криптографическом уровне.",
      about_operator_title: "👤 Информация об операторе",
      about_operator_desc: "<strong>Оператор платформы:</strong> Дмитрий Машков<br><strong>Юрисдикция:</strong> Подгорица, Черногория<br><strong>Контакты поддержки:</strong> <a href=\"mailto:support@mctl.ai\">support@mctl.ai</a><br><strong>Безопасность:</strong> <a href=\"mailto:security@mctl.ai\">security@mctl.ai</a>",
      about_license_title: "⚖️ Открытый исходный код",
      about_license_desc: "mctl-alice разрабатывается как открытое ПО под лицензией Apache 2.0. Вы можете развернуть собственный экземпляр сервиса на своем сервере или в локальной сети. Исходный код доступен в <a href=\"https://github.com/mctlhq/mctl-alice\" target=\"_blank\" rel=\"noopener\">репозитории GitHub</a>.",

      // Privacy Policy Page
      privacy_title: "Политика конфиденциальности",
      privacy_version: "Обновлено 22 октября 2026",
      privacy_sec1_title: "1. Собираемые данные",
      privacy_sec1_desc: "<p class=\"s-2a0ca8\">Что мы храним, зачем и как долго:</p><ul class=\"s-a0190f\"><li><strong>Аккаунт:</strong> Яндекс UID, логин и отображаемое имя. Хранятся, пока вы не удалите аккаунт.</li><li><strong>Доступ к Яндексу:</strong> OAuth access и refresh токены Яндекса и, если вы подключили Quasar, cookie веб-сессии Яндекса. Зашифрованы AES-256-GCM, хранятся до удаления аккаунта (cookie — до отключения Quasar).</li><li><strong>Доступ ИИ-клиентов:</strong> регистрации клиентов (название и адреса возврата), коды авторизации (5 минут) и токены MCP (30 дней). Коды и токены хранятся только в виде SHA-256 хешей.</li><li><strong>Вход и сессии:</strong> сессия личного кабинета (30 дней, хранится как хеш) и временные записи входа, согласия и QR (5–10 минут).</li><li><strong>Сценарии колонок:</strong> идентификаторы сценариев <code>mctl-*</code>, которые сервис создал в вашем Умном доме, чтобы удалить их при отключении.</li><li><strong>Телеметрия устройств:</strong> в облачном режиме не собирается.</li></ul><p class=\"s-2a0ca8\">Данные хранятся в PostgreSQL на серверах Hetzner в Германии. Ежедневные резервные копии хранятся 14 дней в Cloudflare R2. Трафик к сайту проходит через Cloudflare. Мы не продаём данные и не передаём их никому, кроме этих провайдеров инфраструктуры и самого Яндекса, к API которого идут ваши запросы.</p>",
      privacy_sec2_title: "2. Модель угроз и защита данных (Threat Model)",
      privacy_sec2_desc: "<strong>Шифрование at-rest:</strong> Все upstream токены и cookies хранятся в зашифрованном виде с алгоритмом AES-256-GCM. В качестве дополнительных аутентифицированных данных (AAD) используется User ID, что исключает перекрестную подмену токенов между аккаунтами.<br><br><strong>Честное раскрытие архитектурных границ:</strong> В силу архитектуры протокола MCP наш сервер выступает доверенным прокси-исполнителем между ИИ-клиентом и API Яндекса. В момент вызова инструмента токен расшифровывается в оперативной памяти процесса для выполнения запроса к Yandex API. Мы не заявляем о так называемом «Zero-Knowledge», так как любой серверный прокси неизбежно обрабатывает запрос в памяти.",
      privacy_sec3_title: "3. Особенности работы с колонками (Yandex Quasar)",
      privacy_sec3_desc: "Чтобы колонка произнесла фразу или выполнила команду, сервис создаёт в вашем Умном доме сценарий <code>mctl-*</code> для этой колонки и переиспользует его. Сценарии удаляются, когда вы отключаете Quasar или удаляете аккаунт. Текст фраз и команд передаётся Яндексу и обрабатывается по политике конфиденциальности ООО «Яндекс».",
      privacy_sec4_title: "4. Полное удаление данных (Right to Erasure)",
      privacy_sec4_desc: "Вы можете в любой момент отозвать доступ ИИ-клиентов и удалить аккаунт в <a href=\"/account\">Личном кабинете</a>. При удалении мы сразу стираем из рабочей базы аккаунт, токены, сессии и cookie и удаляем созданные сервисом сценарии в вашем Умном доме. В резервных копиях данные остаются до истечения срока их хранения, не дольше 14 дней. Отозвать доступ сервиса со стороны Яндекса можно в настройках Яндекс ID, в разделе доступов приложений.",

      // Terms of Service Page
      terms_title: "Условия использования",
      terms_version: "Обновлено 22 октября 2026",
      terms_sec1_title: "1. Статус сервиса (Бета)",
      terms_sec1_desc: "Сервис mctl-alice предоставляется на условиях «как есть» (as is). Мы прилагаем все усилия для обеспечения высокой доступности и стабильности, однако не гарантируем бесперебойную работу сторонних API Яндекса или AI-провайдеров.",
      terms_sec2_title: "2. Ответственность за физические устройства",
      terms_sec2_desc: "Вы несете полную ответственность за любые действия, которые ИИ-ассистент производит в вашем умном доме (включение/выключение обогревателей, электроприборов, розеток, замков). Мы категорически не рекомендуем подключать к управлению ИИ критически опасные приборы без физических термопредохранителей и автоматических выключателей.",
      terms_sec3_title: "3. Ограничения и лимиты (Fair Use)",
      terms_sec3_desc: "Запрещается использование сервиса для спама, DDoS-атак, сканирования уязвимостей или попыток несанкционированного доступа к чужим тенантам. Действуют автоматические ограничения по количеству запросов в минуту (rate limiting).",

      // Security Page
      security_title: "Политика безопасности и раскрытия уязвимостей",
      security_lead: "Vulnerability Disclosure Policy & Safe Harbor",
      security_sec1_title: "🛡 Safe Harbor для исследователей",
      security_sec1_desc: "Мы приветствуем и поддерживаем независимых исследователей безопасности. Если вы обнаружили потенциальную уязвимость (обход авторизации, SSRF, утечку токенов или инъекцию), пожалуйста, сообщите нам до публичного раскрытия. Мы обязуемся не предпринимать юридических действий против исследователей, действующих добросовестно.",
      security_sec2_title: "📬 Канал связи",
      security_sec2_desc: "Для сообщений об уязвимостях используйте выделенный адрес: <a href=\"mailto:security@mctl.ai\"><strong>security@mctl.ai</strong></a>.<br>Мы стараемся отвечать на первичные обращения в течение 24 часов.",
      security_sec3_title: "🔒 Применяемые меры защиты",
      security_sec3_desc: "<li>Строгое шифрование токенов (AES-256-GCM) с аутентификацией каждого шифротекста.</li><li>Защита от SSRF при динамической регистрации клиентов (RFC 7591) с фильтрацией внутренних IP сетей.</li><li>Заголовки безопасности: Content-Security-Policy, X-Frame-Options: DENY, HSTS.</li><li>Регулярное автоматизированное сканирование зависимостей и тесты изоляции тенантов.</li>",

      // Quasar Cookie Page Additions
      cookie_scenario_disclosure: "Воспроизведение произвольного текста (TTS) и выполнение голосовых команд через Quasar происходит путём создания сценариев в вашем умном доме Яндекс. Текст и параметры команды передаются на серверы Яндекса и сохраняются в истории сценариев вашего аккаунта. mctl-alice изолирует сценарии по пользователям и удаляет сценарий сразу после выполнения.",
      cookie_scenario_ack: "Я понимаю, что команды Quasar сохраняются в истории сценариев Яндекс"
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
      setup_step3_desc: "The official Yandex Smart Home API controls devices and runs scenarios. For text-to-speech (TTS) and arbitrary text commands, connect the unofficial Quasar API at <a href=\"/auth/cookie\">/auth/cookie</a>: it uses your Yandex web session.",
      faq_title: "Frequently Asked Questions",
      faq_q1: "Is it safe to connect smart home through mctl-alice?",
      faq_a1: "Sign-in uses OAuth 2.1 with PKCE. Yandex tokens are stored encrypted (AES-256-GCM), and AI client tokens only as hashes. Smart home devices are controlled through the official Yandex Smart Home API. Speech and text commands on speakers go through Quasar, an unofficial API used by the Yandex web interface. You connect it only if you choose to, and it can stop working without notice.",
      faq_q2: "Which Yandex Station models are supported?",
      faq_a2: "All current models are supported: Yandex Station Max, Station Midi, Station 2, Station Lite, Station Mini, Station Duo Max, as well as third-party hardware powered by Alice.",
      faq_q3: "What is the difference between IoT API and Quasar API?",
      faq_a3: "The Yandex Smart Home API is official and documented: it lists and controls devices, their state and scenarios. Quasar is an unofficial internal API used by the Yandex web interface. It needs your Yandex web session, and it is what powers text-to-speech (TTS) and text commands. Yandex does not support Quasar for third-party services, and the session grants broader access than OAuth, so connect it only if you need these features.",
      faq_q4: "Can I control smart home devices from other brands?",
      faq_a4: "Yes! Any device (lights, plugs, relays, robot vacuums, ACs) connected to your smart home in the 'Home with Alice' app can be controlled via command simulation and routines.",
      footer_part: "mctl-alice is part of the <a href=\"https://mctl.ai\" target=\"_blank\" rel=\"noopener\">mctl</a> platform. An independent project, not affiliated with or endorsed by Yandex; Yandex, Alice and Yandex Station are trademarks of their respective owners.",
      nav_home: "Home",
      cookie_page_title: "mctl-alice — Quasar Cookie Setup",
      cookie_title: "mctl-alice — Quasar Setup (Dynamic Voice & Commands)",
      cookie_lead: "The official Yandex Smart Home API cannot speak arbitrary text (TTS) or run text commands on Alice speakers without pre-created scenarios.<br>Quasar is an unofficial API used by the Yandex web interface. It connects through your Yandex web session and unlocks speech synthesis and arbitrary commands on all your speakers. The session grants broader access than OAuth, and Yandex can change this API without notice.",
      cookie_instructions_title: "Setup Instructions:",
      cookie_step1: "Open <a href=\"https://yandex.ru/quasar\" target=\"_blank\" rel=\"noopener\">yandex.ru/quasar</a> or <a href=\"https://yandex.ru\" target=\"_blank\" rel=\"noopener\">yandex.ru</a> in your browser under your Yandex account.",
      cookie_step2: "Open Developer Tools (press <code>F12</code> or <code>Cmd + Option + I</code> on Mac).",
      cookie_step3: "Switch to <strong>Application</strong> (or <strong>Storage</strong>) → <strong>Cookies</strong> → <code>https://yandex.ru</code>.",
      cookie_step4: "Locate the row with cookie <code>Session_id</code> and copy its value (or copy the entire Cookie header string).",
      cookie_step5: "Paste into the input field below and click <strong>Save and verify</strong>.",
      cookie_label: "Cookie Value (Session_id):",
      cookie_placeholder: "Session_id=3:17... or Session_id value",
      cookie_btn_save: "Save and verify",
      cookie_btn_home: "Back to Home",
      cookie_qr_title: "Quick Setup via QR Code (Recommended)",
      cookie_qr_desc: "Scan the QR code with your phone camera or Yandex app. Your session will be configured automatically without searching for cookies.",
      cookie_qr_waiting: "Waiting for QR code scan...",
      cookie_qr_mobile_btn: "Open in Yandex App",
      cookie_qr_refresh: "Refresh QR code",
      cookie_qr_success: "✅ Authorization successful! Quasar Cookie configured automatically.",
      cookie_qr_expired: "QR code expired. Click 'Refresh QR code'.",
      cookie_qr_start: "Show the sign-in QR code",
      cookie_qr_scope_title: "QR sign-in grants more than OAuth sign-in",
      cookie_qr_scope_desc: "OAuth gives the service access to the smart home API only. QR sign-in hands the service a web session cookie of your Yandex account (Session_id), which it uses for the unofficial Quasar API: speech synthesis and speaker commands. The cookie is stored encrypted until you disconnect Quasar or delete your account.",
      cookie_manual_toggle: "Or configure manually via DevTools...",
      callback_success_page_title: "mctl-alice — Authorization Successful",
      callback_success_title: "mctl-alice — Successful Sign In",
      callback_success_msg: "✅ Authorization successful! Permanent refresh token obtained for auto-renewal.",
      callback_speakers_found: "Discovered speakers:",
      callback_no_speakers: "No speakers found in smart home, but token was obtained and saved successfully.",
      callback_btn_home: "Go to Home",
      callback_btn_cookie: "Configure Quasar Cookie",
      callback_btn_retry: "Try again",
      callback_error_page_title: "mctl-alice — Authorization Error",
      callback_error_title: "mctl-alice — Authorization Error",
      callback_status_obtaining: "Obtaining token...",
      callback_status_connecting: "Token obtained. Connecting to speakers...",
      callback_status_connected: "✅ Success! Smart home connected to mctl-alice.",
      callback_status_token_missing: "❌ Token not found in redirect URL.",
      oauth_consent_title: "Authorize Application",
      oauth_consent_lead: "Application is requesting access to your Alice MCP server",
      oauth_app_name: "Application:",
      oauth_redirect_uri: "Redirect URI:",
      oauth_scopes_title: "Requested permissions:",
      oauth_scope_view: "View rooms, smart devices, sensors and their state",
      oauth_scope_control: "Control devices: turn on and off, lights, volume, media, run scenarios",
      oauth_scope_quasar: "Speakers: say a phrase or run a voice command (needs a connected Quasar cookie)",
      oauth_account_label: "Yandex account (the smart home you are granting access to):",
      oauth_account_switch: "Wrong account? Sign out on your <a href=\"/account\" target=\"_blank\" rel=\"noopener\">account page</a> and start connecting from your AI client again.",
      oauth_whole_home: "Access covers the whole home: every device, room, scenario and speaker of this Yandex account, including ones added later. You cannot pick individual devices.",
      oauth_retention_title: "What is stored",
      oauth_retention_tokens: "The app receives an MCP token valid for 30 days; we store only its SHA-256 hash.",
      oauth_retention_yandex: "Your Yandex tokens (and the Quasar cookie, if you connected it) are stored encrypted with AES-256-GCM until you delete your account.",
      oauth_retention_revoke: "You can revoke the app's access or delete your account at any time on your account page; backups are kept for at most 14 days.",
      oauth_status_connected: "Connection to Yandex Alice Smart Home is active.",
      oauth_btn_approve: "Authorize Access",
      oauth_btn_deny: "Cancel",

      // Navigation & Footer
      nav_account: "Account",
      footer_account: "Account",
      footer_about: "About",
      footer_privacy: "Privacy",
      footer_terms: "Terms",
      footer_security: "Security",
      nav_privacy: "Privacy",
      nav_terms: "Terms of Service",
      nav_security: "Security",
      nav_about: "About",

      // Account Dashboard
      account_title: "Account Dashboard",
      account_user_label: "User",
      account_logout_btn: "Log out",
      account_login_title: "mctl-alice Account Dashboard",
      account_login_desc: "Sign in with Yandex ID to manage AI assistant connections, speaker integration, and stored data.",
      btn_login_yandex: "Sign in with Yandex ID",
      account_status_label: "Status",
      account_quasar_title: "Voice Speaker Control (Quasar)",
      account_quasar_status_connected: "🟢 Connected (arbitrary phrases and commands enabled)",
      account_quasar_status_not_configured: "⚪ Not configured",
      account_quasar_disconnect_btn: "Disconnect Quasar",
      account_quasar_setup_btn: "Configure Quasar Cookie (QR)",
      account_mcp_title: "Connected AI Clients (MCP)",
      account_mcp_no_clients: "No active assistant connections (Claude, ChatGPT, Codex).",
      account_th_client: "Client",
      account_th_scope: "Permissions",
      account_th_connected: "Connected",
      account_th_action: "Action",
      account_btn_revoke: "Revoke",
      account_danger_title: "Danger Zone: Account Deletion",
      account_danger_desc: "You can completely delete all your account data from mctl-alice. All MCP tokens will be immediately revoked, and stored encrypted Yandex tokens, sessions, and proxy routines will be deleted.",
      account_delete_all_btn: "Delete all my data",
      account_btn_home: "← Back to Home",

      // About Page
      about_title: "About mctl-alice",
      about_subtitle: "Model Context Protocol (MCP) server and bridge connecting AI assistants to Yandex Smart Home and Alice speakers.",
      about_arch_title: "🏗 Architecture & Multi-Tenancy",
      about_arch_desc: "The service operates in multi-tenant mode. User credentials and upstream tokens are stored encrypted at-rest using AES-256-GCM with User ID bound as Additional Authenticated Data (AAD). Tenant isolation is enforced cryptographically.",
      about_operator_title: "👤 Operator Information",
      about_operator_desc: "<strong>Platform Operator:</strong> Dmitrii Mashkov<br><strong>Jurisdiction:</strong> Podgorica, Montenegro<br><strong>Support Contact:</strong> <a href=\"mailto:support@mctl.ai\">support@mctl.ai</a><br><strong>Security:</strong> <a href=\"mailto:security@mctl.ai\">security@mctl.ai</a>",
      about_license_title: "⚖️ Open Source",
      about_license_desc: "mctl-alice is open source software distributed under the Apache 2.0 license. You can deploy your own private instance on your own server or local network. Source code is available in the <a href=\"https://github.com/mctlhq/mctl-alice\" target=\"_blank\" rel=\"noopener\">GitHub repository</a>.",

      // Privacy Policy Page
      privacy_title: "Privacy Policy",
      privacy_version: "Updated 22 October 2026",
      privacy_sec1_title: "1. Data We Collect",
      privacy_sec1_desc: "<p class=\"s-2a0ca8\">What we store, why, and for how long:</p><ul class=\"s-a0190f\"><li><strong>Account:</strong> Yandex UID, login and display name. Kept until you delete the account.</li><li><strong>Yandex access:</strong> Yandex OAuth access and refresh tokens and, if you connected Quasar, your Yandex web session cookie. Encrypted with AES-256-GCM, kept until you delete the account (the cookie until you disconnect Quasar).</li><li><strong>AI client access:</strong> client registrations (name and redirect addresses), authorization codes (5 minutes) and MCP tokens (30 days). Codes and tokens are stored only as SHA-256 hashes.</li><li><strong>Sign-in and sessions:</strong> the account page session (30 days, stored as a hash) and short-lived sign-in, consent and QR records (5–10 minutes).</li><li><strong>Speaker scenarios:</strong> the ids of the <code>mctl-*</code> scenarios the service created in your Smart Home, so it can delete them when you disconnect.</li><li><strong>Device telemetry:</strong> not collected in the hosted service.</li></ul><p class=\"s-2a0ca8\">Data is stored in PostgreSQL on Hetzner servers in Germany. Daily backups are kept for 14 days in Cloudflare R2. Site traffic passes through Cloudflare. We do not sell data or share it with anyone other than these infrastructure providers and Yandex itself, whose API your requests go to.</p>",
      privacy_sec2_title: "2. Threat Model & Data Protection",
      privacy_sec2_desc: "<strong>Encryption At-Rest:</strong> All upstream credentials and cookies are encrypted with AES-256-GCM with the User ID used as Additional Authenticated Data (AAD), preventing cross-tenant substitution attacks.<br><br><strong>Architectural Disclosure:</strong> Under the MCP protocol architecture, our server acts as a trusted proxy between the AI client and the Yandex API. During a tool call, credentials are decrypted in volatile memory to make the outbound HTTPS request. We do not claim 'Zero-Knowledge', as any server-side proxy must process credentials in memory.",
      privacy_sec3_title: "3. Speaker Operations (Yandex Quasar)",
      privacy_sec3_desc: "To make a speaker say a phrase or run a command, the service creates one <code>mctl-*</code> scenario per speaker in your Smart Home and reuses it. The scenarios are deleted when you disconnect Quasar or delete your account. Phrase and command text is sent to Yandex and processed under the Yandex privacy policy.",
      privacy_sec4_title: "4. Right to Erasure",
      privacy_sec4_desc: "You can revoke AI client access and delete your account at any time on the <a href=\"/account\">Account</a> page. Deletion immediately removes the account, tokens, sessions and cookie from the live database and deletes the scenarios the service created in your Smart Home. Backups keep the data until they expire, at most 14 days. To revoke the service on the Yandex side, use the app access settings of your Yandex ID.",

      // Terms of Service Page
      terms_title: "Terms of Service",
      terms_version: "Updated 22 October 2026",
      terms_sec1_title: "1. Service Status (Beta)",
      terms_sec1_desc: "The mctl-alice service is provided 'as is'. While we strive for high availability and reliability, we do not guarantee uninterrupted availability of third-party Yandex or AI provider APIs.",
      terms_sec2_title: "2. Responsibility for Physical Devices",
      terms_sec2_desc: "You bear full responsibility for actions performed by AI assistants in your smart home (switching heaters, appliances, sockets, locks). We strongly advise against controlling hazardous equipment without physical thermal fuses and automatic circuit breakers.",
      terms_sec3_title: "3. Fair Use & Rate Limits",
      terms_sec3_desc: "Use of the service for spam, DDoS attacks, vulnerability scanning, or unauthorized access attempts against other tenants is strictly prohibited. Automated request limits (rate limiting) are enforced.",

      // Security Page
      security_title: "Security Policy & Vulnerability Disclosure",
      security_lead: "Vulnerability Disclosure Policy & Safe Harbor",
      security_sec1_title: "🛡 Security Researcher Safe Harbor",
      security_sec1_desc: "We welcome and support independent security researchers. If you identify a potential vulnerability (auth bypass, SSRF, token leakage, or injection), please report it to us prior to public disclosure. We pledge not to pursue legal action against researchers acting in good faith.",
      security_sec2_title: "📬 Contact Channel",
      security_sec2_desc: "For vulnerability disclosures, contact us at: <a href=\"mailto:security@mctl.ai\"><strong>security@mctl.ai</strong></a>.<br>We aim to respond to initial inquiries within 24 hours.",
      security_sec3_title: "🔒 Applied Security Controls",
      security_sec3_desc: "<li>Rigorous token encryption (AES-256-GCM) with ciphertext authentication.</li><li>SSRF protection during dynamic client registration (RFC 7591) with internal IP filtering.</li><li>Hardened HTTP headers: Content-Security-Policy, X-Frame-Options: DENY, HSTS.</li><li>Automated dependency vulnerability audits and continuous multi-tenant isolation testing.</li>",

      // Quasar Cookie Page Additions
      cookie_scenario_disclosure: "Arbitrary text-to-speech (TTS) playback and voice commands via Quasar work by dynamically generating routines in your Yandex Smart Home. The command text and parameters are sent to Yandex servers and recorded in your account routine history. mctl-alice isolates routines per user and purges them immediately after execution.",
      cookie_scenario_ack: "I understand that Quasar commands are recorded in my Yandex routine history"
    }
  };

  function applyLanguage(lang) {
    if (lang !== "ru" && lang !== "en") lang = "ru";
    var dict = translations[lang];
    if (!dict) return;

    root.setAttribute("lang", lang);
    try { localStorage.setItem("alice-lang", lang); } catch (e) {}

    // Update document title and meta description
    if (dict.meta_title && document.querySelector('meta[name="description"]')) {
      document.title = dict.meta_title;
    }
    var metaDesc = document.querySelector('meta[name="description"]');
    if (metaDesc && dict.meta_desc) metaDesc.setAttribute("content", dict.meta_desc);

    // Update page titles if data-i18n exists on title or body
    var pageTitleKey = document.documentElement.getAttribute("data-page-title-key");
    if (pageTitleKey && dict[pageTitleKey]) {
      document.title = dict[pageTitleKey];
    }

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

    // Update placeholders
    Array.prototype.forEach.call(document.querySelectorAll("[data-i18n-placeholder]"), function (el) {
      var key = el.getAttribute("data-i18n-placeholder");
      if (dict[key] !== undefined) {
        el.setAttribute("placeholder", dict[key]);
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
  window.mctlAliceTranslations = translations;
  window.mctlAliceCurrentLang = function () {
    return root.getAttribute("lang") || "ru";
  };

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

  // ── Confirm before destructive forms ────────────────────────────────────
  // Forms carry data-confirm instead of inline onsubmit handlers, which the
  // Content-Security-Policy does not allow.
  document.addEventListener("submit", function (event) {
    var form = event.target;
    var message = form && form.getAttribute ? form.getAttribute("data-confirm") : null;
    if (message && !window.confirm(message)) event.preventDefault();
  });
})();
