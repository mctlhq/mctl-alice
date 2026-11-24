/**
 * The text of alice_play_music.
 *
 * The tool reaches a speaker through the same capability as an arbitrary
 * voice command (quasar.server_action / text_action), but it is admitted by
 * `iot:control`, not by `quasar`. What keeps it from being alice_send_command
 * under a weaker scope is this file: the caller supplies only a short query,
 * the spoken command is always PLAY_MUSIC_PREFIX followed by that query, and
 * a query that is not plain words is refused, never cleaned up. Refusing
 * rather than rewriting matters to a client that shows the query to a person
 * for approval: what was approved is what is sent.
 *
 * This narrows the command, it does not prove what Alice does with it: the
 * words after the prefix are still interpreted by Alice.
 */

/** Longest query, in characters (code points). */
export const MAX_MUSIC_QUERY_LENGTH = 100;

/** The fixed start of the spoken command. The query is appended as is. */
export const PLAY_MUSIC_PREFIX = "включи музыку ";

// Letters, combining marks and digits of any script, the plain space, and a
// short list of punctuation that occurs in artist and track names. No line
// break, tab, other whitespace, control or format character, quote mark,
// slash, colon or symbol passes.
const ALLOWED_QUERY = /^[\p{L}\p{M}\p{N} .,'&!?()-]+$/u;
const HAS_WORD = /[\p{L}\p{N}]/u;

/** Why a query is refused, or null when it may be sent. */
export function musicQueryProblem(query: unknown): string | null {
  if (typeof query !== "string") return "it must be a string";
  if (query.length === 0) return "it is empty";
  // Counted before anything else looks at the text, so a huge value is cheap to refuse.
  if (query.length > MAX_MUSIC_QUERY_LENGTH * 2 || Array.from(query).length > MAX_MUSIC_QUERY_LENGTH) {
    return `it is longer than ${MAX_MUSIC_QUERY_LENGTH} characters`;
  }
  if (!ALLOWED_QUERY.test(query)) {
    return "it may hold only letters, digits, single spaces and the punctuation . , ' & ! ? ( ) -";
  }
  if (query.startsWith(" ") || query.endsWith(" ") || query.includes("  ")) {
    return "it must not start or end with a space or hold two spaces in a row";
  }
  if (!HAS_WORD.test(query)) return "it holds no letter or digit";
  return null;
}

/** The spoken command for a query that musicQueryProblem accepted. */
export function playMusicCommand(query: string): string {
  const problem = musicQueryProblem(query);
  if (problem) throw new Error(`music query refused: ${problem}`);
  return PLAY_MUSIC_PREFIX + query;
}
