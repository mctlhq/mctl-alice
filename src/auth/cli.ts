#!/usr/bin/env node
import dotenv from "dotenv";
dotenv.config();

import readline from "node:readline";
import { exec } from "node:child_process";
import {
  startAuthServer,
  buildOAuthUrl,
  saveClientIdToEnvFile,
  saveClientSecretToEnvFile,
  saveTokenToEnvFile,
  saveTokenToKeychain,
  getTokenFromKeychain,
  validateTokenAndGetSpeakers,
} from "./oauth-helper.js";

const PORT = 8085;

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

function openBrowser(url: string) {
  const openCommand =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
      ? `start "" "${url}"`
      : `xdg-open "${url}"`;

  exec(openCommand, () => {
    // Ignore error if open fails
  });
}

async function main() {
  console.log("\n🔑 [mctl-alice] Авторизация в Яндекс ID");
  console.log("==================================================");

  let clientId =
    process.env.YANDEX_CLIENT_ID ||
    getTokenFromKeychain("mctl-alice-client-id");
  let clientSecret =
    process.env.YANDEX_CLIENT_SECRET ||
    getTokenFromKeychain("mctl-alice-client-secret");

  if (!clientId) {
    console.log("Для авторизации через веб-интерфейс Яндекса требуется Client ID приложения.");
    console.log("\n📋 Как создать Client ID за 1 минуту:");
    console.log("  1. Откройте в браузере: https://oauth.yandex.ru/client/new");
    console.log("  2. Название: mctl-alice");
    console.log("  3. Платформы: отметьте чекбокс 'Веб-сервисы'");
    console.log("  4. Callback URL (добавьте обе строки):");
    console.log("     http://localhost:8085/callback");
    console.log("     https://oauth.yandex.ru/verification_code");
    console.log("  5. Права (поиск по 'умный дом'):");
    console.log("     - iot:view (чтение информации об устройствах)");
    console.log("     - iot:control (управление устройствами)");
    console.log("  6. Нажмите 'Создать приложение' и скопируйте Client ID.\n");

    const input = await prompt("👉 Введите ваш Client ID (или готовый OAuth-токен, если он уже есть): ");

    if (!input) {
      console.error("❌ Ничего не введено. Прерывание.");
      process.exit(1);
    }

    // Check if user directly provided a token (e.g. starts with y0_ or is long)
    if (input.startsWith("y0_") || input.startsWith("AQAAAA") || input.length > 40) {
      console.log("\n🔍 Проверка введенного токена...");
      try {
        const speakers = await validateTokenAndGetSpeakers(input);
        saveTokenToEnvFile(input);
        saveTokenToKeychain(input, "mctl-alice");
        console.log("🎉 Токен валиден и успешно сохранен в Keychain и .env!");
        console.log(`Найденные колонки (${speakers.length}):`);
        for (const sp of speakers) {
          console.log(`  - ${sp}`);
        }
        process.exit(0);
      } catch (err: any) {
        console.error("❌ Ошибка проверки токена:", err.message);
        process.exit(1);
      }
    }

    clientId = input;
    saveClientIdToEnvFile(clientId);
    saveTokenToKeychain(clientId, "mctl-alice-client-id");
    console.log(`✅ Client ID сохранен: ${clientId}\n`);
  }

  const redirectUri = `http://localhost:${PORT}/callback`;
  const responseType = clientSecret ? "code" : "token";
  const authUrl = buildOAuthUrl(clientId, redirectUri, responseType);
  const directVerifyUrl = `https://oauth.yandex.ru/authorize?response_type=token&client_id=${clientId}`;

  console.log("1. Открываем окно браузера для авторизации...");
  console.log(`   Ссылка: ${authUrl}`);
  if (responseType === "code") {
    console.log("   (Используется Authorization Code Flow для получения постоянного Refresh Token)");
  } else {
    console.log("\n(Альтернатива: если редирект на localhost не сработает, откройте:\n " + directVerifyUrl + "\n и скопируйте токен из адресной строки)");
  }
  console.log("\n2. Нажмите 'Разрешить' в браузере. Ожидание ответа...\n");

  openBrowser(authUrl);

  try {
    await startAuthServer({
      port: PORT,
      clientId,
      clientSecret: clientSecret || undefined,
      onSuccess: ({ speakers, refreshToken }) => {
        console.log("==================================================");
        console.log("🎉 Авторизация успешно завершена!");
        if (refreshToken) {
          console.log("✨ Получен и сохранен Refresh-токен для автоматического продления!");
        }
        console.log(`Найденные колонки (${speakers.length}):`);
        if (speakers.length === 0) {
          console.log("  (колонки не обнаружены, но токен действителен)");
        } else {
          for (const sp of speakers) {
            console.log(`  - ${sp}`);
          }
        }
        console.log("\nТокены записаны в Keychain и .env. Сервер mctl-alice готов к работе!");
        console.log("==================================================\n");
        process.exit(0);
      },
    });
  } catch (err: any) {
    console.error("❌ Ошибка сервера авторизации:", err.message);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("❌ Ошибка:", err.message);
  process.exit(1);
});
