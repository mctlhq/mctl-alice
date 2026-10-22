function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function renderAboutPage(baseUrl: string): string {
  return `
    <h1 class="page-title" data-i18n="about_title">О сервисе mctl-alice</h1>
    <p class="s-d8f4e6" data-i18n="about_subtitle">
      Модель контекстного протокола (MCP) и мост для подключения ИИ-ассистентов к Умному дому и колонкам Яндекса.
    </p>

    <div class="s-89dbb6">
      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="about_arch_title">🏗 Архитектура и изоляция</h2>
        <p class="s-3b8e6c" data-i18n="about_arch_desc">
          Сервис работает в многопользовательском (multi-tenant) режиме. Учетные данные и токены пользователей хранятся в зашифрованном виде (AES-256-GCM) с привязкой к идентификатору пользователя в качестве AAD (Additional Authenticated Data). Доступ между тенантами изолирован на криптографическом уровне.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="about_operator_title">👤 Информация об операторе</h2>
        <p class="s-3b8e6c" data-i18n-html="about_operator_desc">
          <strong>Оператор платформы:</strong> Дмитрий Машков<br>
          <strong>Юрисдикция:</strong> Подгорица, Черногория<br>
          <strong>Контакты поддержки:</strong> <a href="mailto:support@mctl.ai">support@mctl.ai</a><br>
          <strong>Безопасность:</strong> <a href="mailto:security@mctl.ai">security@mctl.ai</a>
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="about_license_title">⚖️ Открытый исходный код</h2>
        <p class="s-3b8e6c" data-i18n-html="about_license_desc">
          mctl-alice разрабатывается как открытое ПО под лицензией Apache 2.0. Вы можете развернуть собственный экземпляр сервиса на своем сервере или в локальной сети. Исходный код доступен в <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener">репозитории GitHub</a>.
        </p>
      </div>
    </div>

    <div class="s-4ef6bf">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/privacy" class="btn btn-secondary" data-i18n="nav_privacy">Конфиденциальность</a>
    </div>
  `;
}

export function renderPrivacyPage(baseUrl: string): string {
  return `
    <h1 class="page-title" data-i18n="privacy_title">Политика конфиденциальности</h1>
    <p class="s-d8f4e6" data-i18n="privacy_version">Обновлено 22 октября 2026</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="privacy_sec1_title">1. Собираемые данные</h2>
        <div data-i18n-html="privacy_sec1_desc">
          <p class="s-2a0ca8">Что мы храним, зачем и как долго:</p><ul class="s-a0190f"><li><strong>Аккаунт:</strong> Яндекс UID, логин и отображаемое имя. Хранятся, пока вы не удалите аккаунт.</li><li><strong>Доступ к Яндексу:</strong> OAuth access и refresh токены Яндекса и, если вы подключили Quasar, cookie веб-сессии Яндекса. Зашифрованы AES-256-GCM, хранятся до удаления аккаунта (cookie — до отключения Quasar).</li><li><strong>Доступ ИИ-клиентов:</strong> регистрации клиентов (название и адреса возврата), коды авторизации (5 минут) и токены MCP (30 дней). Коды и токены хранятся только в виде SHA-256 хешей.</li><li><strong>Вход и сессии:</strong> сессия личного кабинета (30 дней, хранится как хеш) и временные записи входа, согласия и QR (5–10 минут).</li><li><strong>Сценарии колонок:</strong> идентификаторы сценариев <code>mctl-*</code>, которые сервис создал в вашем Умном доме, чтобы удалить их при отключении.</li><li><strong>Телеметрия устройств:</strong> в облачном режиме не собирается.</li></ul><p class="s-2a0ca8">Данные хранятся в PostgreSQL на серверах Hetzner в Германии. Ежедневные резервные копии хранятся 14 дней в Cloudflare R2. Трафик к сайту проходит через Cloudflare. Мы не продаём данные и не передаём их никому, кроме этих провайдеров инфраструктуры и самого Яндекса, к API которого идут ваши запросы.</p>
        </div>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="privacy_sec2_title">2. Модель угроз и защита данных (Threat Model)</h2>
        <p class="s-2a0ca8" data-i18n-html="privacy_sec2_desc">
          <strong>Шифрование at-rest:</strong> Все upstream токены и cookies хранятся в зашифрованном виде с алгоритмом AES-256-GCM. В качестве дополнительных аутентифицированных данных (AAD) используется User ID, что исключает перекрестную подмену токенов между аккаунтами.<br><br>
          <strong>Честное раскрытие архитектурных границ:</strong> В силу архитектуры протокола MCP наш сервер выступает доверенным прокси-исполнителем между ИИ-клиентом и API Яндекса. В момент вызова инструмента токен расшифровывается в оперативной памяти процесса для выполнения запроса к Yandex API. Мы не заявляем о так называемом «Zero-Knowledge», так как любой серверный прокси неизбежно обрабатывает запрос в памяти.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="privacy_sec3_title">3. Особенности работы с колонками (Yandex Quasar)</h2>
        <p class="s-2a0ca8" data-i18n-html="privacy_sec3_desc">
          Чтобы колонка произнесла фразу или выполнила команду, сервис создаёт в вашем Умном доме сценарий <code>mctl-*</code> для этой колонки и переиспользует его. Сценарии удаляются, когда вы отключаете Quasar или удаляете аккаунт. Текст фраз и команд передаётся Яндексу и обрабатывается по политике конфиденциальности ООО «Яндекс».
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="privacy_sec4_title">4. Полное удаление данных (Right to Erasure)</h2>
        <p class="s-2a0ca8" data-i18n-html="privacy_sec4_desc">
          Вы можете в любой момент отозвать доступ ИИ-клиентов и удалить аккаунт в <a href="/account">Личном кабинете</a>. При удалении мы сразу стираем из рабочей базы аккаунт, токены, сессии и cookie и удаляем созданные сервисом сценарии в вашем Умном доме. В резервных копиях данные остаются до истечения срока их хранения, не дольше 14 дней. Отозвать доступ сервиса со стороны Яндекса можно в настройках Яндекс ID, в разделе доступов приложений.
        </p>
      </div>
    </div>

    <div class="s-4ef6bf">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/terms" class="btn btn-secondary" data-i18n="nav_terms">Условия использования</a>
    </div>
  `;
}

export function renderTermsPage(baseUrl: string): string {
  return `
    <h1 class="page-title" data-i18n="terms_title">Условия использования</h1>
    <p class="s-d8f4e6" data-i18n="terms_version">Обновлено 22 октября 2026</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="terms_sec1_title">1. Статус сервиса (Бета)</h2>
        <p class="s-2a0ca8" data-i18n="terms_sec1_desc">
          Сервис mctl-alice предоставляется на условиях «как есть» (as is). Мы прилагаем все усилия для обеспечения высокой доступности и стабильности, однако не гарантируем бесперебойную работу сторонних API Яндекса или AI-провайдеров.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="terms_sec2_title">2. Ответственность за физические устройства</h2>
        <p class="s-2a0ca8" data-i18n="terms_sec2_desc">
          Вы несете полную ответственность за любые действия, которые ИИ-ассистент производит в вашем умном доме (включение/выключение обогревателей, электроприборов, розеток, замков). Мы категорически не рекомендуем подключать к управлению ИИ критически опасные приборы без физических термопредохранителей и автоматических выключателей.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="terms_sec3_title">3. Ограничения и лимиты (Fair Use)</h2>
        <p class="s-2a0ca8" data-i18n="terms_sec3_desc">
          Запрещается использование сервиса для спама, DDoS-атак, сканирования уязвимостей или попыток несанкционированного доступа к чужим тенантам. Действуют автоматические ограничения по количеству запросов в минуту (rate limiting).
        </p>
      </div>
    </div>

    <div class="s-4ef6bf">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/security" class="btn btn-secondary" data-i18n="nav_security">Безопасность</a>
    </div>
  `;
}

export function renderSecurityPage(baseUrl: string): string {
  return `
    <h1 class="page-title" data-i18n="security_title">Политика безопасности и раскрытия уязвимостей</h1>
    <p class="s-d8f4e6" data-i18n="security_lead">Vulnerability Disclosure Policy &amp; Safe Harbor</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="security_sec1_title">🛡 Safe Harbor для исследователей</h2>
        <p class="s-2a0ca8" data-i18n="security_sec1_desc">
          Мы приветствуем и поддерживаем независимых исследователей безопасности. Если вы обнаружили потенциальную уязвимость (обход авторизации, SSRF, утечку токенов или инъекцию), пожалуйста, сообщите нам до публичного раскрытия. Мы обязуемся не предпринимать юридических действий против исследователей, действующих добросовестно.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="security_sec2_title">📬 Канал связи</h2>
        <p class="s-2a0ca8" data-i18n-html="security_sec2_desc">
          Для сообщений об уязвимостях используйте выделенный адрес: <a href="mailto:security@mctl.ai"><strong>security@mctl.ai</strong></a>.<br>
          Мы стараемся отвечать на первичные обращения в течение 24 часов.
        </p>
      </div>

      <div class="s-8f4f37">
        <h2 class="section-title s-96cfba" data-i18n="security_sec3_title">🔒 Применяемые меры защиты</h2>
        <ul class="s-a0190f" data-i18n-html="security_sec3_desc">
          <li>Строгое шифрование токенов (AES-256-GCM) с аутентификацией каждого шифротекста.</li>
          <li>Защита от SSRF при динамической регистрации клиентов (RFC 7591) с фильтрацией внутренних IP сетей.</li>
          <li>Заголовки безопасности: Content-Security-Policy, X-Frame-Options: DENY, HSTS.</li>
          <li>Регулярное автоматизированное сканирование зависимостей и тесты изоляции тенантов.</li>
        </ul>
      </div>
    </div>

    <div class="s-4ef6bf">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/about" class="btn btn-secondary" data-i18n="nav_about">О сервисе</a>
    </div>
  `;
}

/** Pages listed in the sitemap; everything else is either private or not a page. */
export const PUBLIC_PAGE_PATHS = ["/", "/setup", "/about", "/privacy", "/terms", "/security"];

export function renderRobotsTxt(siteUrl: string): string {
  return [
    "User-agent: *",
    "Disallow: /auth/",
    "Disallow: /oauth/",
    "Disallow: /account",
    "Allow: /",
    "",
    `Sitemap: ${siteUrl}/sitemap.xml`,
    "",
  ].join("\n");
}

export function renderSitemapXml(siteUrl: string): string {
  const urls = PUBLIC_PAGE_PATHS.map((p) => `  <url><loc>${escapeHtml(siteUrl + p)}</loc></url>`).join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls}
</urlset>
`;
}

export function renderNotFoundPage(): string {
  return `
    <h1 class="page-title" data-i18n="notfound_title">Страница не найдена</h1>
    <p class="s-d8f4e6" data-i18n="notfound_desc">Такой страницы нет. Возможно, ссылка устарела или в адресе опечатка.</p>
    <div class="s-4ef6bf">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/setup" class="btn btn-secondary" data-i18n="nav_setup">Подключение</a>
    </div>
  `;
}

/**
 * The connection guide. Only clients the repository has evidence for are
 * listed as tested (OAuth redirect allowlist and client-metadata fast paths in
 * src/auth/oauth-controller.ts); every other client is described generically.
 */
export function renderSetupPage(siteUrl: string): string {
  const mcpUrl = escapeHtml(`${siteUrl}/mcp`);
  return `
    <h1 class="page-title" data-i18n="setup_page_h1">Подключите своего AI-ассистента</h1>
    <p class="s-d8f4e6" data-i18n="setup_page_lead">mctl-alice — удалённый MCP-сервер. Добавьте его адрес в ассистента, войдите через Яндекс ID и выберите, что ассистенту можно делать. Дальше просто просите его на обычном языке.</p>

    <div class="endpoint">
      <span class="label">MCP URL</span>
      <code id="mcp-url">${mcpUrl}</code>
    </div>
    <div class="cta-row">
      <button class="btn btn-primary" id="copy-url" type="button" data-idle="Скопировать MCP URL" data-done="Скопировано!">Скопировать MCP URL</button>
    </div>

    <div class="s-71e873 setup-sections">
      <section class="s-8f4f37" aria-labelledby="setup-tested">
        <h2 class="section-title s-96cfba" id="setup-tested" data-i18n="setup_tested_title">Проверенные клиенты</h2>
        <ul class="s-a0190f" data-i18n-html="setup_tested_list">
          <li><strong>Claude</strong> (claude.ai и Claude Desktop): <em>Customize → Connectors → «+» → Add custom connector</em>, вставьте MCP URL и нажмите <em>Add</em>, затем <em>Connect</em>.</li>
          <li><strong>ChatGPT</strong>: <em>Settings → Apps &amp; Connectors → Advanced settings</em> → включите <em>Developer mode</em>, затем <em>Apps &amp; Connectors → Create</em> и вставьте MCP URL.</li>
          <li><strong>Codex</strong>: добавьте MCP URL как удалённый (streamable HTTP) MCP-сервер; вход через Яндекс ID откроется в браузере.</li>
        </ul>
      </section>

      <section class="s-8f4f37" aria-labelledby="setup-other">
        <h2 class="section-title s-96cfba" id="setup-other" data-i18n="setup_other_title">Другие MCP-клиенты</h2>
        <p class="s-2a0ca8" data-i18n="setup_other_desc">Подойдёт любой клиент, который подключает удалённые MCP-серверы с авторизацией OAuth 2.1, например Claude Code или Cursor. Мы их сами не проверяли, поэтому напишите нам, если что-то не работает.</p>
        <pre><code>claude mcp add --transport http alice ${mcpUrl}</code></pre>
        <pre><code>{
  "mcpServers": {
    "alice": { "url": "${mcpUrl}" }
  }
}</code></pre>
      </section>

      <section class="s-8f4f37" aria-labelledby="setup-walkthrough">
        <h2 class="section-title s-96cfba" id="setup-walkthrough" data-i18n="setup_walk_title">Как это проходит</h2>
        <ol class="s-a0190f" data-i18n-html="setup_walk_list">
          <li>Вы добавляете MCP URL, и ассистент открывает окно входа.</li>
          <li>Вы входите через Яндекс ID и разрешаете mctl-alice доступ к Умному дому.</li>
          <li>На странице согласия вы видите, какой ассистент просит доступ, и можете снять лишние разрешения: <code>iot:view</code> (смотреть устройства), <code>iot:control</code> (управлять ими), <code>quasar</code> (речь и текстовые команды на колонках).</li>
          <li>Вы возвращаетесь в ассистента и пишете, например: «Какие у меня колонки?» или «Выключи весь свет на кухне».</li>
          <li>По желанию подключаете Quasar в <a href="/account">личном кабинете</a>, чтобы колонки могли произносить фразы и выполнять текстовые команды. Без него остальные функции работают.</li>
        </ol>
      </section>

      <section class="s-8f4f37" aria-labelledby="setup-data">
        <h2 class="section-title s-96cfba" id="setup-data" data-i18n="setup_data_title">Ваши данные и как отозвать доступ</h2>
        <ul class="s-a0190f" data-i18n-html="setup_data_list">
          <li><strong>История устройств.</strong> Облачный сервис не собирает и не хранит историю состояний устройств, включать её не нужно. Инструмент <code>alice_get_device_history</code> здесь новых данных не возвращает.</li>
          <li><strong>Ваши данные.</strong> Что хранится и сколько, перечислено в <a href="/privacy">политике конфиденциальности</a>. Кнопки выгрузки нет. Чтобы получить копию сведений о вашем аккаунте, напишите на <a href="mailto:support@mctl.ai">support@mctl.ai</a>.</li>
          <li><strong>Отключить ассистента.</strong> В <a href="/account">личном кабинете</a> нажмите «Отозвать» рядом с ассистентом: его токены перестанут работать сразу.</li>
          <li><strong>Отключить Quasar.</strong> Кнопка в личном кабинете удаляет сохранённую веб-сессию и сценарии <code>mctl-*</code>, созданные сервисом.</li>
          <li><strong>Удалить всё.</strong> «Удалить все мои данные» в личном кабинете стирает аккаунт, токены, сессии и сценарии <code>mctl-*</code>.</li>
          <li><strong>На стороне Яндекса.</strong> Удаление в mctl-alice стирает наши копии ключей, но не отзывает их у Яндекса. Доступ приложения отзывается в <a href="https://id.yandex.ru/security" target="_blank" rel="noopener">Яндекс ID</a>, в разделе доступов приложений. Веб-сессию, созданную входом по QR, завершает выход из аккаунта на всех устройствах там же.</li>
        </ul>
      </section>
    </div>

    <div class="s-4ef6bf">
      <a href="/account" class="btn btn-primary" data-i18n="setup_btn_account">Личный кабинет</a>
      <a href="/" class="btn btn-secondary" data-i18n="nav_home">На главную</a>
    </div>
  `;
}
