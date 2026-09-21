import { UserRecord } from "../storage/storage-interface.js";

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
    <p style="color: var(--surface-fg-muted); margin-bottom: 20px;" data-i18n="about_subtitle">
      Модель контекстного протокола (MCP) и мост для подключения ИИ-ассистентов к Умному дому и колонкам Яндекса.
    </p>

    <div style="display: flex; flex-direction: column; gap: 16px;">
      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="about_arch_title">🏗 Архитектура и изоляция</h3>
        <p style="margin: 0; font-size: 14px; line-height: 1.6;" data-i18n="about_arch_desc">
          Сервис работает в многопользовательском (multi-tenant) режиме. Учетные данные и токены пользователей хранятся в зашифрованном виде (AES-256-GCM) с привязкой к идентификатору пользователя в качестве AAD (Additional Authenticated Data). Доступ между тенантами изолирован на криптографическом уровне.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="about_operator_title">👤 Информация об операторе</h3>
        <p style="margin: 0; font-size: 14px; line-height: 1.6;" data-i18n-html="about_operator_desc">
          <strong>Оператор платформы:</strong> Дмитрий Машков<br>
          <strong>Юрисдикция:</strong> Подгорица, Черногория<br>
          <strong>Контакты поддержки:</strong> <a href="mailto:support@mctl.ai">support@mctl.ai</a><br>
          <strong>Безопасность:</strong> <a href="mailto:security@mctl.ai">security@mctl.ai</a>
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="about_license_title">⚖️ Открытый исходный код</h3>
        <p style="margin: 0; font-size: 14px; line-height: 1.6;" data-i18n-html="about_license_desc">
          mctl-alice разрабатывается как открытое ПО под лицензией Apache 2.0. Вы можете развернуть собственный экземпляр сервиса на своем сервере или в локальной сети. Исходный код доступен в <a href="https://github.com/mctlhq/mctl-alice" target="_blank" rel="noopener">репозитории GitHub</a>.
        </p>
      </div>
    </div>

    <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/privacy" class="btn btn-secondary" data-i18n="nav_privacy">Конфиденциальность</a>
    </div>
  `;
}

export function renderPrivacyPage(baseUrl: string): string {
  return `
    <h2 data-i18n="privacy_title">Политика конфиденциальности</h2>
    <p style="color: var(--surface-fg-muted); margin-bottom: 20px;" data-i18n="privacy_version">Версия 2.0.0 (Сентябрь 2026)</p>

    <div style="display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.6;">
      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="privacy_sec1_title">1. Собираемые данные</h3>
        <div data-i18n-html="privacy_sec1_desc">
          <p style="margin: 0;">
            При подключении сервиса мы сохраняем минимально необходимый набор данных для обеспечения работы ИИ-интеграции:
          </p>
          <ul style="margin: 8px 0 0 20px; padding: 0;">
            <li><strong>Идентификатор пользователя:</strong> Яндекс UID, имя пользователя и аватар (для отображения в интерфейсе).</li>
            <li><strong>Токены авторизации:</strong> Upstream OAuth access/refresh токены для доступа к API Умного дома Яндекса.</li>
            <li><strong>Quasar сессия (опционально):</strong> Cookie сессии для прямого управления умными колонками через TTS.</li>
          </ul>
        </div>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="privacy_sec2_title">2. Модель угроз и защита данных (Threat Model)</h3>
        <p style="margin: 0;" data-i18n-html="privacy_sec2_desc">
          <strong>Шифрование at-rest:</strong> Все upstream токены и cookies хранятся в зашифрованном виде с алгоритмом AES-256-GCM. В качестве дополнительных аутентифицированных данных (AAD) используется User ID, что исключает перекрестную подмену токенов между аккаунтами.<br><br>
          <strong>Честное раскрытие архитектурных границ:</strong> В силу архитектуры протокола MCP наш сервер выступает доверенным прокси-исполнителем между ИИ-клиентом и API Яндекса. В момент вызова инструмента токен расшифровывается в оперативной памяти процесса для выполнения запроса к Yandex API. Мы не заявляем о так называемом «Zero-Knowledge», так как любой серверный прокси неизбежно обрабатывает запрос в памяти.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="privacy_sec3_title">3. Особенности работы с колонками (Yandex Quasar)</h3>
        <p style="margin: 0;" data-i18n="privacy_sec3_desc">
          Управление воспроизведением и голосовыми командами колонок осуществляется через создание временных сценариев автоматизации в облаке Яндекса. Текстовые фразы передаются в Yandex Cloud и сохраняются на серверах Яндекса в соответствии с политикой конфиденциальности ООО «Яндекс».
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="privacy_sec4_title">4. Полное удаление данных (Right to Erasure)</h3>
        <p style="margin: 0;" data-i18n-html="privacy_sec4_desc">
          Вы можете в любой момент отозвать доступ и полностью удалить свои данные из нашей системы через <a href="/account">Личный кабинет</a>. При удалении все токены, сессии и связанные сценарии стираются из базы данных немедленно (криптографическое уничтожение).
        </p>
      </div>
    </div>

    <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/terms" class="btn btn-secondary" data-i18n="nav_terms">Условия использования</a>
    </div>
  `;
}

export function renderTermsPage(baseUrl: string): string {
  return `
    <h2 data-i18n="terms_title">Условия использования</h2>
    <p style="color: var(--surface-fg-muted); margin-bottom: 20px;" data-i18n="terms_version">Версия 2.0.0 (Сентябрь 2026)</p>

    <div style="display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.6;">
      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="terms_sec1_title">1. Статус сервиса (Бета)</h3>
        <p style="margin: 0;" data-i18n="terms_sec1_desc">
          Сервис mctl-alice предоставляется на условиях «как есть» (as is). Мы прилагаем все усилия для обеспечения высокой доступности и стабильности, однако не гарантируем бесперебойную работу сторонних API Яндекса или AI-провайдеров.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="terms_sec2_title">2. Ответственность за физические устройства</h3>
        <p style="margin: 0;" data-i18n="terms_sec2_desc">
          Вы несете полную ответственность за любые действия, которые ИИ-ассистент производит в вашем умном доме (включение/выключение обогревателей, электроприборов, розеток, замков). Мы категорически не рекомендуем подключать к управлению ИИ критически опасные приборы без физических термопредохранителей и автоматических выключателей.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="terms_sec3_title">3. Ограничения и лимиты (Fair Use)</h3>
        <p style="margin: 0;" data-i18n="terms_sec3_desc">
          Запрещается использование сервиса для спама, DDoS-атак, сканирования уязвимостей или попыток несанкционированного доступа к чужим тенантам. Действуют автоматические ограничения по количеству запросов в минуту (rate limiting).
        </p>
      </div>
    </div>

    <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/security" class="btn btn-secondary" data-i18n="nav_security">Безопасность</a>
    </div>
  `;
}

export function renderSecurityPage(baseUrl: string): string {
  return `
    <h2 data-i18n="security_title">Политика безопасности и раскрытия уязвимостей</h2>
    <p style="color: var(--surface-fg-muted); margin-bottom: 20px;" data-i18n="security_lead">Vulnerability Disclosure Policy &amp; Safe Harbor</p>

    <div style="display: flex; flex-direction: column; gap: 16px; font-size: 14px; line-height: 1.6;">
      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="security_sec1_title">🛡 Safe Harbor для исследователей</h3>
        <p style="margin: 0;" data-i18n="security_sec1_desc">
          Мы приветствуем и поддерживаем независимых исследователей безопасности. Если вы обнаружили потенциальную уязвимость (обход авторизации, SSRF, утечку токенов или инъекцию), пожалуйста, сообщите нам до публичного раскрытия. Мы обязуемся не предпринимать юридических действий против исследователей, действующих добросовестно.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="security_sec2_title">📬 Канал связи</h3>
        <p style="margin: 0;" data-i18n-html="security_sec2_desc">
          Для сообщений об уязвимостях используйте выделенный адрес: <a href="mailto:security@mctl.ai"><strong>security@mctl.ai</strong></a>.<br>
          Мы стараемся отвечать на первичные обращения в течение 24 часов.
        </p>
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;" data-i18n="security_sec3_title">🔒 Применяемые меры защиты</h3>
        <ul style="margin: 8px 0 0 20px; padding: 0;" data-i18n-html="security_sec3_desc">
          <li>Строгое шифрование токенов (AES-256-GCM) с аутентификацией каждого шифротекста.</li>
          <li>Защита от SSRF при динамической регистрации клиентов (RFC 7591) с фильтрацией внутренних IP сетей.</li>
          <li>Заголовки безопасности: Content-Security-Policy, X-Frame-Options: DENY, HSTS.</li>
          <li>Регулярное автоматизированное сканирование зависимостей и тесты изоляции тенантов.</li>
        </ul>
      </div>
    </div>

    <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/about" class="btn btn-secondary" data-i18n="nav_about">О сервисе</a>
    </div>
  `;
}

export function renderAccountPage(
  baseUrl: string,
  user: UserRecord,
  hasQuasar: boolean,
  scenarios: Array<{ deviceId: string; scenarioId: string; scenarioName?: string }>
): string {
  const scenarioItems = scenarios.length > 0
    ? scenarios.map(s => `<li><code>${escapeHtml(s.deviceId)}</code>: ${escapeHtml(s.scenarioName || s.scenarioId)}</li>`).join("")
    : "<li>Нет активных сценариев</li>";

  return `
    <h2>Управление аккаунтом</h2>
    <p style="color: var(--surface-fg-muted); margin-bottom: 20px;">
      Подключенный Яндекс аккаунт: <strong>${escapeHtml(user.displayName || user.login || user.yandexUid)}</strong> (UID: <code>${escapeHtml(user.yandexUid)}</code>)
    </p>

    <div style="display: flex; flex-direction: column; gap: 16px; font-size: 14px;">
      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;">🔊 Статус Yandex Quasar (Колонки)</h3>
        <p style="margin: 0 0 12px 0;">
          Состояние: ${hasQuasar ? '<span style="color: var(--mctl-success, #22c55e); font-weight: 600;">● Подключено</span>' : '<span style="color: var(--surface-fg-muted);">○ Не настроено</span>'}
        </p>
        <div>
          <strong>Связанные сценарии проксирования:</strong>
          <ul style="margin: 6px 0 12px 20px; padding: 0;">
            ${scenarioItems}
          </ul>
        </div>
        ${hasQuasar ? `
          <form method="POST" action="/account/disconnect-quasar" style="margin: 0;">
            <button type="submit" class="btn btn-secondary" style="font-size: 13px;">Отключить Quasar и очистить сценарии</button>
          </form>
        ` : `
          <a href="/auth/cookie" class="btn btn-secondary" style="font-size: 13px;">Настроить Quasar Cookie</a>
        `}
      </div>

      <div style="background: var(--surface-elevated); padding: 18px; border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px;">🔗 Настройки подключения ИИ-ассистентов</h3>
        <p style="margin: 0 0 12px 0;">
          Для подключения в Claude Desktop, Codex или ChatGPT используйте MCP URL:
        </p>
        <div style="display: flex; gap: 8px; align-items: center;">
          <input type="text" readonly value="${baseUrl}/mcp" class="form-input" style="flex: 1; font-family: monospace; font-size: 13px;" onclick="this.select()">
          <button type="button" class="btn btn-secondary" onclick="navigator.clipboard.writeText('${baseUrl}/mcp'); alert('MCP URL скопирован!');">Копировать</button>
        </div>
      </div>

      <div style="background: rgba(239, 68, 68, 0.05); padding: 18px; border: 1px solid rgba(239, 68, 68, 0.3); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; margin-bottom: 8px; color: #ef4444;">⚠️ Удаление аккаунта и данных</h3>
        <p style="margin: 0 0 16px 0; color: var(--surface-fg-muted);">
          При нажатии все ваши OAuth токены, сохраненные ключи, сессии и связанные сценарии будут безвозвратно удалены из базы данных сервиса.
        </p>
        <form method="POST" action="/account/delete" onsubmit="return confirm('Вы уверены, что хотите полностью удалить все данные вашего аккаунта? Это действие необратимо.');" style="margin: 0;">
          <button type="submit" class="btn" style="background: #ef4444; color: white; border: none; font-size: 13px;">Удалить все мои данные</button>
        </form>
      </div>
    </div>

    <div style="margin-top: 24px; display: flex; gap: 12px; flex-wrap: wrap;">
      <a href="/" class="btn btn-primary" data-i18n="nav_home">На главную</a>
      <a href="/auth/cookie" class="btn btn-secondary">Quasar Cookie</a>
    </div>
  `;
}
