# mctl-alice

Model Context Protocol (MCP) server for controlling **Yandex Station (Алиса)** smart speakers and smart home devices via the Yandex Cloud IoT API.

Enables AI assistants (Claude, ChatGPT, Codex, Antigravity, OpenClaw, Cursor, etc.) to speak through your Alice speakers, send voice commands, control volume and playback, and manage your smart home.

---

## Deployment Modes

### 1. Hosted Multi-Tenant SaaS (Recommended)
You can connect your AI assistant directly to our hosted cloud gateway at **`https://alice.mctl.ai`**:

1. Open **`https://alice.mctl.ai`** in your browser.
2. Click **Войти через Яндекс ID** to authenticate your Yandex Smart Home.
3. Configure **Quasar Cookie** (via QR code) if you wish to control smart speakers with TTS phrases.
4. Add the MCP endpoint to your client:
   - **Claude Desktop / Codex / ChatGPT MCP**: `https://alice.mctl.ai/mcp`
   - Complete the standard OAuth 2.1 consent screen in your client.

### 2. Self-Hosted (Docker)
You can deploy your own instance of `mctl-alice` using Docker:

```bash
docker run -d \
  --name mctl-alice \
  -p 8080:8080 \
  -v $(pwd)/data:/app/data \
  -e AUTH_REQUIRED=true \
  -e PUBLIC_BASE_URL=https://your-domain.com \
  -e ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef \
  -e YANDEX_CLIENT_ID=your_yandex_client_id \
  -e YANDEX_CLIENT_SECRET=your_yandex_client_secret \
  ghcr.io/mctlhq/mctl-alice:2.0.0
```

---

## Available MCP Tools

| Tool Name | Scope | Description |
| :--- | :--- | :--- |
| `alice_list_devices` | `iot:view` | Discovers all smart speakers, rooms, household appliances, and scenarios. |
| `alice_get_device_state` | `iot:view` | Fetches real-time status, capabilities, and sensor values for a device. |
| `alice_get_home_summary` | `iot:view` | Returns a human-readable overview of rooms and devices. |
| `alice_get_device_history` | `iot:view` | Returns historical telemetry readings (sensor samples over time). |
| `alice_control_device` | `iot:control` | Turns devices on/off, sets temperature, mode, or brightness. |
| `alice_control_devices_batch`| `iot:control` | Dispatches batch control actions across multiple devices simultaneously. |
| `alice_control_room` | `iot:control` | Controls all devices in a specified room (e.g. turn off all lights). |
| `alice_execute_scenario` | `iot:control` | Triggers a predefined smart home automation scenario. |
| `alice_set_volume` | `iot:control` | Adjusts speaker volume (1 to 10). |
| `alice_playback_control` | `iot:control` | Media playback commands (play, pause, stop, next, prev). |
| `alice_say_phrase` | `quasar` | Makes a Yandex Station speak arbitrary text (TTS). |
| `alice_send_command` | `quasar` | Simulates a voice command as text (e.g. "Включи джаз"). |

---

## Security Architecture & Threat Model

- **Multi-Tenant Cryptographic Isolation**: All upstream access tokens, refresh tokens, and Quasar session cookies are encrypted at rest using **AES-256-GCM**. The `userId` is passed as Additional Authenticated Data (AAD), cryptographically binding ciphertext to the user's record.
- **Granular Scopes**: AI client grants are scoped to `iot:view`, `iot:control`, and `quasar`.
- **Operator Trust Boundary**: Because `mctl-alice` acts as an MCP proxy to Yandex Cloud, upstream tokens must be held in process memory at the moment of request dispatch. We transparently disclose that the infrastructure operator has access to the runtime environment, and envelope encryption protects data-at-rest.
- **Data Erasure**: Users can revoke AI client access and permanently delete all stored data with a single click at `/account`.

---

## License

Apache-2.0. See [LICENSE](LICENSE) for details.
