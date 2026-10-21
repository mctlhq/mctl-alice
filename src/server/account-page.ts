import { UserRecord, UserCredentials } from "../storage/storage-interface.js";

export function renderAccountPage({
  user,
  creds,
  grants = [],
  escapeHtml,
  baseUrl,
}: {
  user: UserRecord | null;
  creds: UserCredentials | null;
  grants?: Array<{ clientId: string; clientName?: string; scope: string; createdAt: number }>;
  escapeHtml: (s: string) => string;
  baseUrl: string;
}): string {
  if (!user) {
    return `
      <div class="account-unauth">
        <h2 data-i18n="account_login_title">Личный кабинет mctl-alice</h2>
        <p data-i18n="account_login_desc">Войдите через Яндекс ID, чтобы управлять подключениями AI-ассистентов, интеграцией с колонками и сохранёнными данными.</p>
        <div class="s-784e59">
          <a href="${baseUrl}/auth/login" class="btn btn-primary" data-i18n="btn_login_yandex">Войти через Яндекс ID</a>
        </div>
      </div>
    `;
  }

  const hasQuasar = Boolean(creds?.quasarCookie);
  const formattedDate = new Date(user.createdAt).toLocaleDateString("ru-RU");

  let grantsTable = "";
  if (grants.length === 0) {
    grantsTable = `<p class="muted s-6f220e" data-i18n="account_mcp_no_clients">Нет активных подключений ассистентов (Claude, ChatGPT, Codex).</p>`;
  } else {
    grantsTable = `
      <table class="table s-c72ddd">
        <thead>
          <tr class="s-2f8e9d">
            <th class="s-c079ee" data-i18n="account_th_client">Клиент</th>
            <th class="s-c079ee" data-i18n="account_th_scope">Разрешения</th>
            <th class="s-c079ee" data-i18n="account_th_connected">Подключен</th>
            <th class="s-776427" data-i18n="account_th_action">Действие</th>
          </tr>
        </thead>
        <tbody>
          ${grants
            .map(
              (g) => `
            <tr class="s-b6be4b">
              <td class="s-8160b0"><strong>${escapeHtml(g.clientName || g.clientId)}</strong></td>
              <td class="s-8160b0"><code>${escapeHtml(g.scope)}</code></td>
              <td class="s-8160b0">${new Date(g.createdAt).toLocaleDateString()}</td>
              <td class="s-4f7a36">
                <form class="s-2f8710" method="POST" action="/account/revoke-grant">
                  <input type="hidden" name="client_id" value="${escapeHtml(g.clientId)}">
                  <button type="submit" class="btn btn-sm btn-outline-danger s-0da61a" data-i18n="account_btn_revoke">Отозвать</button>
                </form>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  }

  return `
    <div class="account-dashboard">
      <div class="s-6c8f3b">
        <div>
          <h2 class="s-2a0ca8" data-i18n="account_title">Личный кабинет</h2>
          <div class="s-8f25ff">
            <span data-i18n="account_user_label">Пользователь</span>: <strong>${escapeHtml(user.displayName || user.login || user.yandexUid)}</strong> 
            (ID: <code>${escapeHtml(user.yandexUid)}</code>)
          </div>
        </div>
        <form method="POST" action="/account/logout">
          <button type="submit" class="btn btn-secondary btn-sm" data-i18n="account_logout_btn">Выйти</button>
        </form>
      </div>

      <div class="s-5b419e">
        <h3 class="s-b6884e" data-i18n="account_quasar_title">Голосовое управление колонками (Quasar)</h3>
        <p class="s-563961">
          <span data-i18n="account_status_label">Статус</span>: <strong>${
            hasQuasar
              ? '<span data-i18n="account_quasar_status_connected">🟢 Подключено (доступны произвольные фразы и команды)</span>'
              : '<span data-i18n="account_quasar_status_not_configured">⚪ Не настроено</span>'
          }</strong>
        </p>
        <div class="s-04e22a">
          ${
            hasQuasar
              ? `
            <form method="POST" action="/account/disconnect-quasar" data-confirm="Отключить Quasar и удалить прокси-сценарии с серверов Яндекса?">
              <button type="submit" class="btn btn-secondary btn-sm" data-i18n="account_quasar_disconnect_btn">Отключить Quasar</button>
            </form>
          `
              : `
            <a href="/auth/cookie" class="btn btn-primary btn-sm" data-i18n="account_quasar_setup_btn">Настроить Quasar Cookie (QR)</a>
          `
          }
        </div>
      </div>

      <div class="s-5b419e">
        <h3 class="s-b6884e" data-i18n="account_mcp_title">Подключённые AI-клиенты (MCP)</h3>
        ${grantsTable}
      </div>

      <div class="s-b504ec">
        <h3 class="s-788ad3" data-i18n="account_danger_title">Опасная зона: удаление аккаунта</h3>
        <p class="s-bdde6e" data-i18n="account_danger_desc">
          Вы можете полностью удалить все данные своей учётной записи из mctl-alice. Будут немедленно отозваны все MCP-токены, 
          удалены сохранённые зашифрованные токены Яндекса, сессии и прокси-сценарии.
        </p>
        <form class="s-4bb900" method="POST" action="/account/delete" data-confirm="Вы уверены? Это действие необратимо удалит все ваши токены и данные из сервиса.">
          <button type="submit" class="btn btn-danger btn-sm s-877506" data-i18n="account_delete_all_btn">Удалить все мои данные</button>
        </form>
      </div>

      <div class="s-784e59">
        <a href="/" class="btn btn-secondary btn-sm" data-i18n="account_btn_home">&larr; На главную</a>
      </div>
    </div>
  `;
}
