/**
 * The command that opens a URL in the default browser. No shell: the URL is
 * passed as a single argument to the opener.
 */
export function browserOpener(platform: NodeJS.Platform, url: string): [string, string[]] {
  return platform === "darwin"
    ? ["open", [url]]
    : platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
}
