#!/usr/bin/env node
import { startAuthServer, buildOAuthUrl } from "./oauth-helper.js";
import { exec } from "node:child_process";

const DEFAULT_CLIENT_ID = "c0ebe342af7d48fbbbfcf2d2eedb8f9e";
const PORT = 8085;
const clientId = process.env.YANDEX_CLIENT_ID || DEFAULT_CLIENT_ID;
const redirectUri = `http://localhost:${PORT}/callback`;
const authUrl = buildOAuthUrl(clientId, redirectUri);

console.log("\n🔑 [mctl-alice] Авторизация в Яндекс ID");
console.log("==================================================");
console.log(`1. Сейчас откроется окно браузера для входа в Яндекс.`);
console.log(`2. Если окно не открылось автоматически, перейдите по ссылке:\n   ${authUrl}\n`);
console.log("3. Нажмите 'Разрешить', и токен будет автоматически сохранен в .env файл.");
console.log("Ожидание подтверждения в браузере...\n");

// Try to open browser
const openCommand =
  process.platform === "darwin"
    ? `open "${authUrl}"`
    : process.platform === "win32"
    ? `start "" "${authUrl}"`
    : `xdg-open "${authUrl}"`;

exec(openCommand, () => {
  // Ignore error if open fails
});

startAuthServer({
  port: PORT,
  clientId,
  onSuccess: ({ speakers }) => {
    console.log("==================================================");
    console.log("🎉 Авторизация успешно завершена!");
    console.log(`Найденные колонки (${speakers.length}):`);
    for (const sp of speakers) {
      console.log(`  - ${sp}`);
    }
    console.log("\nТокен записан в файл .env. Теперь вы можете использовать mctl-alice!");
    console.log("==================================================\n");
    process.exit(0);
  },
}).catch((err) => {
  console.error("❌ Ошибка авторизации:", err.message);
  process.exit(1);
});
