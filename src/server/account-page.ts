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
        <div style="margin-top: 24px;">
          <a href="${baseUrl}/auth/login" class="btn btn-primary" data-i18n="btn_login_yandex">Войти через Яндекс ID</a>
        </div>
      </div>
    `;
  }

  const hasQuasar = Boolean(creds?.quasarCookie);
  const formattedDate = new Date(user.createdAt).toLocaleDateString("ru-RU");

  let grantsTable = "";
  if (grants.length === 0) {
    grantsTable = `<p class="muted" style="color: var(--surface-fg-muted); margin-top: 8px;">Нет активных подключений ассистентов (Claude, ChatGPT, Codex).</p>`;
  } else {
    grantsTable = `
      <table class="table" style="width: 100%; margin-top: 12px; border-collapse: collapse;">
        <thead>
          <tr style="text-align: left; border-bottom: 1px solid var(--surface-line);">
            <th style="padding: 8px 0;">Клиент</th>
            <th style="padding: 8px 0;">Разрешения</th>
            <th style="padding: 8px 0;">Подключен</th>
            <th style="padding: 8px 0; text-align: right;">Действие</th>
          </tr>
        </thead>
        <tbody>
          ${grants
            .map(
              (g) => `
            <tr style="border-bottom: 1px solid var(--surface-line);">
              <td style="padding: 10px 0;"><strong>${escapeHtml(g.clientName || g.clientId)}</strong></td>
              <td style="padding: 10px 0;"><code>${escapeHtml(g.scope)}</code></td>
              <td style="padding: 10px 0;">${new Date(g.createdAt).toLocaleDateString()}</td>
              <td style="padding: 10px 0; text-align: right;">
                <form method="POST" action="/account/revoke-grant" style="display: inline;">
                  <input type="hidden" name="client_id" value="${escapeHtml(g.clientId)}">
                  <button type="submit" class="btn btn-sm btn-outline-danger" style="padding: 4px 10px; font-size: 13px;">Отозвать</button>
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
      <div style="display: flex; justify-content: space-between; align-items: center; border-bottom: 1px solid var(--surface-line); padding-bottom: 16px;">
        <div>
          <h2 style="margin: 0;">Личный кабинет</h2>
          <div style="color: var(--surface-fg-muted); font-size: 14px; margin-top: 4px;">
            Пользователь: <strong>${escapeHtml(user.displayName || user.login || user.yandexUid)}</strong> 
            (ID: <code>${escapeHtml(user.yandexUid)}</code>)
          </div>
        </div>
        <form method="POST" action="/account/logout">
          <button type="submit" class="btn btn-secondary btn-sm">Выйти</button>
        </form>
      </div>

      <div style="margin-top: 24px; padding: 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; font-size: 16px;">Голосовое управление колонками (Quasar)</h3>
        <p style="font-size: 14px; margin: 8px 0; color: var(--surface-fg-muted);">
          Статус: <strong>${hasQuasar ? "🟢 Подключено (доступны произвольные фразы и команды)" : "⚪ Не настроено"}</strong>
        </p>
        <div style="margin-top: 12px; display: flex; gap: 12px; align-items: center;">
          ${
            hasQuasar
              ? `
            <form method="POST" action="/account/disconnect-quasar">
              <button type="submit" class="btn btn-secondary btn-sm" onclick="return confirm('Отключить Quasar и удалить прокси-сценарии с серверов Яндекса?')">Отключить Quasar</button>
            </form>
          `
              : `
            <a href="/auth/cookie" class="btn btn-primary btn-sm">Настроить Quasar Cookie (QR)</a>
          `
          }
        </div>
      </div>

      <div style="margin-top: 24px; padding: 16px; background: var(--surface-elevated); border: 1px solid var(--surface-line); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; font-size: 16px;">Подключённые AI-клиенты (MCP)</h3>
        ${grantsTable}
      </div>

      <div style="margin-top: 32px; padding: 16px; border: 1px solid rgba(220, 38, 38, 0.3); background: rgba(220, 38, 38, 0.05); border-radius: var(--mctl-radius-md);">
        <h3 style="margin-top: 0; font-size: 16px; color: #dc2626;">Опасная зона: удаление аккаунта</h3>
        <p style="font-size: 14px; color: var(--surface-fg-muted); margin: 8px 0;">
          Вы можете полностью удалить все данные своей учётной записи из mctl-alice. Будут немедленно отозваны все MCP-токены, 
          удалены сохранённые зашифрованные токены Яндекса, сессии и прокси-сценарии.
        </p>
        <form method="POST" action="/account/delete-all" style="margin-top: 12px;" onsubmit="return confirm('Вы уверены? Это действие необратимо удалит все ваши токены и данные из сервиса.')">
          <button type="submit" class="btn btn-danger btn-sm" style="background: #dc2626; color: #fff; border: none; padding: 8px 16px; border-radius: 6px; cursor: pointer;">Удалить все мои данные</button>
        </form>
      </div>

      <div style="margin-top: 24px;">
        <a href="/" class="btn btn-secondary btn-sm">&larr; На главную</a>
      </div>
    </div>
  `;
}
