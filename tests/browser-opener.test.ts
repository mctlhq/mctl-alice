import { describe, it, expect } from "vitest";
import { browserOpener } from "../src/auth/browser-opener.js";

describe("browserOpener", () => {
  const url = "https://oauth.yandex.ru/authorize?client_id=x&state=a&b";
  it.each([
    ["darwin", "open", [url]],
    ["win32", "rundll32", ["url.dll,FileProtocolHandler", url]],
    ["linux", "xdg-open", [url]],
    ["freebsd", "xdg-open", [url]],
  ] as const)("%s", (platform, command, args) => {
    expect(browserOpener(platform, url)).toEqual([command, args]);
  });
});
