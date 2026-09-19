# mctl-alice

Model Context Protocol (MCP) server for controlling **Yandex Station (Алиса)** smart speakers and smart home devices via the Yandex Cloud IoT API.

Enables AI assistants (Claude, Antigravity, OpenClaw, Cursor, etc.) to speak through your Alice speakers, send voice commands, control volume and playback, and run smart home scenarios.

---

## Features

- 🗣️ **Voice command simulation (`alice_send_command`)**: Send any voice command as text (e.g. «Включи джаз», «Какая погода завтра», «Поставь таймер на 15 минут», «Выключи свет везде»). Alice executes it exactly as if you spoke it aloud.
- 📢 **Text-to-Speech (`alice_say_phrase`)**: Make Alice speak arbitrary text through any speaker (TTS announcements, notifications, reminders).
- 🔊 **Volume control (`alice_set_volume`)**: Set speaker volume level (1 to 10).
- ⏯️ **Media playback (`alice_media_control`)**: Pause, play, stop, next track, previous track.
- 🏠 **Smart home discovery (`alice_list_devices`)**: List all speakers, rooms, and devices.
- ⚡ **Scenarios (`alice_trigger_scenario`)**: Trigger predefined smart home automation scenarios (e.g. «Доброе утро», «Ушел из дома»).

---

## Quick Setup

### 1. Obtain a Yandex OAuth Token

To allow the server to talk to Yandex Smart Home on your behalf, you need a Yandex OAuth token with `iot:view` and `iot:control` permissions:

1. Go to [Yandex OAuth Client Registration](https://oauth.yandex.ru/client/new).
2. Set **App Name**: `mctl-alice` (or any name you prefer).
3. Under **Platforms**, select **Web services** and set **Redirect URI** to:
   ```
   https://oauth.yandex.ru/verification_code
   ```
4. Under **Data access (Permissions)**, find and add:
   - `iot:view` (Умный дом: чтение информации об устройствах)
   - `iot:control` (Умный дом: управление устройствами)
5. Save the app and copy your **Client ID**.
6. Open this link in your browser (replace `<CLIENT_ID>` with your Client ID):
   ```
   https://oauth.yandex.ru/authorize?response_type=token&client_id=<CLIENT_ID>
   ```
7. Click **Allow** and copy the resulting `access_token`.

*(Alternatively, if you already use third-party smart home integrations like Home Assistant or Yandex Dialogs, you can reuse an existing Yandex OAuth token).*

---

### 2. Configuration

Set the environment variable `YANDEX_OAUTH_TOKEN`:

```bash
cp .env.example .env
# Edit .env and paste your token:
# YANDEX_OAUTH_TOKEN=y0_AgAAAA...
```

---

### 3. Connect to Claude Desktop / Cursor / Antigravity

#### Option A: Stdio (Local Node)

Add to your `claude_desktop_config.json` or `mcp.json`:

```json
{
  "mcpServers": {
    "alice": {
      "command": "node",
      "args": ["/path/to/mctlhq/mctl-alice/dist/index.js"],
      "env": {
        "YANDEX_OAUTH_TOKEN": "y0_AgAAAA..."
      }
    }
  }
}
```

#### Option B: Via `npx tsx` (Development mode)

```json
{
  "mcpServers": {
    "alice": {
      "command": "npx",
      "args": ["-y", "tsx", "/path/to/mctlhq/mctl-alice/src/index.ts"],
      "env": {
        "YANDEX_OAUTH_TOKEN": "y0_AgAAAA..."
      }
    }
  }
}
```

---

## Available MCP Tools

| Tool | Description | Parameters |
| --- | --- | --- |
| `alice_list_devices` | List all Alice smart speakers, rooms, and smart devices | `only_speakers?: boolean` |
| `alice_send_command` | Execute any voice command via text simulation | `command: string`, `device?: string` |
| `alice_say_phrase` | Make Alice speak arbitrary text out loud (TTS) | `phrase: string`, `device?: string` |
| `alice_set_volume` | Set speaker volume level (1 to 10) | `level: number`, `device?: string` |
| `alice_media_control` | Control playback (`play`, `pause`, `stop`, `next`, `prev`) | `action: string`, `device?: string` |
| `alice_trigger_scenario` | Trigger an automation scenario by name or ID | `scenario: string` |

> **Note on targeting speakers**: The `device` parameter can be a device ID, speaker name (e.g. `"Станция Макс"`), or room name (e.g. `"Кухня"`). If omitted, the server automatically routes to your default or primary speaker.

---

## Example AI Assistant Prompts

Once connected, you can ask your AI assistant:

- *«Какие колонки Алиса у меня подключены?»*
- *«Включи джаз на колонке в гостиной»*
- *«Сделай громкость 4 на кухне»*
- *«Скажи через колонку детям, что ужин готов»*
- *«Поставь музыку на паузу»*
- *«Запусти сценарий Спокойной ночи»*

---

## Development

```bash
# Install dependencies
npm install

# Run tests
npm test

# Build TypeScript
npm run build

# Start server manually
npm start
```

## License

Apache-2.0
