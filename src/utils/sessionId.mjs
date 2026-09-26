import { randomInt } from "node:crypto";

/**
 * Generate a session id like `2026-09-26-1608-a3q` from the given time.
 *
 * The random suffix avoids collisions when multiple processes start within the
 * same minute. `randomInt` is uniform over `[0, 36 ** 3)`, so each suffix
 * character is unbiased.
 * @param {Date} [now]
 * @returns {string}
 */
export function generateSessionId(now = new Date()) {
  const date = [
    `${now.getFullYear()}-${`0${now.getMonth() + 1}`.slice(-2)}-${`0${now.getDate()}`.slice(-2)}`,
    `0${now.getHours()}`.slice(-2) + `0${now.getMinutes()}`.slice(-2),
  ].join("-");
  const suffix = randomInt(36 ** 3)
    .toString(36)
    .padStart(3, "0");
  return `${date}-${suffix}`;
}
