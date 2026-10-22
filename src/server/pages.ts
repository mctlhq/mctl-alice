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
    <h2 data-i18n="about_title">О сервисе mctl-alice</h2>
    <p class="s-d8f4e6" data-i18n="about_subtitle">
      Модель контекстного протокола (MCP) и мост для подключения ИИ-ассистентов к Умному дому и колонкам Яндекса.
    </p>

    <div class="s-89dbb6">
      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="about_arch_title">🏗 Архитектура и изоляция</h3>
        <p class="s-3b8e6c" data-i18n="about_arch_desc">
          Сервис работает в многопользовательском (multi-tenant) режиме. Учетные данные и токены пользователей хранятся в зашифрованном виде (AES-256-GCM) с привязкой к идентификатору пользователя в качестве AAD (Additional Authenticated Data). Доступ между тенантами изолирован на криптографическом уровне.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="about_operator_title">👤 Информация об операторе</h3>
        <p class="s-3b8e6c" data-i18n-html="about_operator_desc">
          <strong>Оператор платформы:</strong> Дмитрий Машков<br>
          <strong>Юрисдикция:</strong> Подгорица, Черногория<br>
          <strong>Контакты поддержки:</strong> <a href="mailto:support@mctl.ai">support@mctl.ai</a><br>
          <strong>Безопасность:</strong> <a href="mailto:security@mctl.ai">security@mctl.ai</a>
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="about_license_title">⚖️ Открытый исходный код</h3>
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
    <h2 data-i18n="privacy_title">Политика конфиденциальности</h2>
    <p class="s-d8f4e6" data-i18n="privacy_version">Обновлено 22 октября 2026</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="privacy_sec1_title">1. Собираемые данные</h3>
        <div data-i18n-html="privacy_sec1_desc">
          <p class="s-2a0ca8">Что мы храним, зачем и как долго:</p><ul class="s-a0190f"><li><strong>Аккаунт:</strong> Яндекс UID, логин и отображаемое имя. Хранятся, пока вы не удалите аккаунт.</li><li><strong>Доступ к Яндексу:</strong> OAuth access и refresh токены Яндекса и, если вы подключили Quasar, cookie веб-сессии Яндекса. Зашифрованы AES-256-GCM, хранятся до удаления аккаунта (cookie — до отключения Quasar).</li><li><strong>Доступ ИИ-клиентов:</strong> регистрации клиентов (название и адреса возврата), коды авторизации (5 минут) и токены MCP (30 дней). Коды и токены хранятся только в виде SHA-256 хешей.</li><li><strong>Вход и сессии:</strong> сессия личного кабинета (30 дней, хранится как хеш) и временные записи входа, согласия и QR (5–10 минут).</li><li><strong>Сценарии колонок:</strong> идентификаторы сценариев <code>mctl-*</code>, которые сервис создал в вашем Умном доме, чтобы удалить их при отключении.</li><li><strong>Телеметрия устройств:</strong> в облачном режиме не собирается.</li></ul><p class="s-2a0ca8">Данные хранятся в PostgreSQL на серверах Hetzner в Германии. Ежедневные резервные копии хранятся 14 дней в Cloudflare R2. Трафик к сайту проходит через Cloudflare. Мы не продаём данные и не передаём их никому, кроме этих провайдеров инфраструктуры и самого Яндекса, к API которого идут ваши запросы.</p>
        </div>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="privacy_sec2_title">2. Модель угроз и защита данных (Threat Model)</h3>
        <p class="s-2a0ca8" data-i18n-html="privacy_sec2_desc">
          <strong>Шифрование at-rest:</strong> Все upstream токены и cookies хранятся в зашифрованном виде с алгоритмом AES-256-GCM. В качестве дополнительных аутентифицированных данных (AAD) используется User ID, что исключает перекрестную подмену токенов между аккаунтами.<br><br>
          <strong>Честное раскрытие архитектурных границ:</strong> В силу архитектуры протокола MCP наш сервер выступает доверенным прокси-исполнителем между ИИ-клиентом и API Яндекса. В момент вызова инструмента токен расшифровывается в оперативной памяти процесса для выполнения запроса к Yandex API. Мы не заявляем о так называемом «Zero-Knowledge», так как любой серверный прокси неизбежно обрабатывает запрос в памяти.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="privacy_sec3_title">3. Особенности работы с колонками (Yandex Quasar)</h3>
        <p class="s-2a0ca8" data-i18n-html="privacy_sec3_desc">
          Чтобы колонка произнесла фразу или выполнила команду, сервис создаёт в вашем Умном доме сценарий <code>mctl-*</code> для этой колонки и переиспользует его. Сценарии удаляются, когда вы отключаете Quasar или удаляете аккаунт. Текст фраз и команд передаётся Яндексу и обрабатывается по политике конфиденциальности ООО «Яндекс».
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="privacy_sec4_title">4. Полное удаление данных (Right to Erasure)</h3>
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
    <h2 data-i18n="terms_title">Условия использования</h2>
    <p class="s-d8f4e6" data-i18n="terms_version">Обновлено 22 октября 2026</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="terms_sec1_title">1. Статус сервиса (Бета)</h3>
        <p class="s-2a0ca8" data-i18n="terms_sec1_desc">
          Сервис mctl-alice предоставляется на условиях «как есть» (as is). Мы прилагаем все усилия для обеспечения высокой доступности и стабильности, однако не гарантируем бесперебойную работу сторонних API Яндекса или AI-провайдеров.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="terms_sec2_title">2. Ответственность за физические устройства</h3>
        <p class="s-2a0ca8" data-i18n="terms_sec2_desc">
          Вы несете полную ответственность за любые действия, которые ИИ-ассистент производит в вашем умном доме (включение/выключение обогревателей, электроприборов, розеток, замков). Мы категорически не рекомендуем подключать к управлению ИИ критически опасные приборы без физических термопредохранителей и автоматических выключателей.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="terms_sec3_title">3. Ограничения и лимиты (Fair Use)</h3>
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
    <h2 data-i18n="security_title">Политика безопасности и раскрытия уязвимостей</h2>
    <p class="s-d8f4e6" data-i18n="security_lead">Vulnerability Disclosure Policy &amp; Safe Harbor</p>

    <div class="s-71e873">
      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="security_sec1_title">🛡 Safe Harbor для исследователей</h3>
        <p class="s-2a0ca8" data-i18n="security_sec1_desc">
          Мы приветствуем и поддерживаем независимых исследователей безопасности. Если вы обнаружили потенциальную уязвимость (обход авторизации, SSRF, утечку токенов или инъекцию), пожалуйста, сообщите нам до публичного раскрытия. Мы обязуемся не предпринимать юридических действий против исследователей, действующих добросовестно.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="security_sec2_title">📬 Канал связи</h3>
        <p class="s-2a0ca8" data-i18n-html="security_sec2_desc">
          Для сообщений об уязвимостях используйте выделенный адрес: <a href="mailto:security@mctl.ai"><strong>security@mctl.ai</strong></a>.<br>
          Мы стараемся отвечать на первичные обращения в течение 24 часов.
        </p>
      </div>

      <div class="s-8f4f37">
        <h3 class="s-96cfba" data-i18n="security_sec3_title">🔒 Применяемые меры защиты</h3>
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
