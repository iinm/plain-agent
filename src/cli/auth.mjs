import {
  loginOpenAICodex,
  logoutOpenAICodex,
} from "../providers/platform/openaiCodex.mjs";

/**
 * Run an authentication subcommand.
 *
 * @param {{ action: "login" | "logout", provider: "openai-codex" }} subcommand
 * @returns {Promise<number>} Process exit code.
 */
export async function runAuthCommand(subcommand) {
  if (subcommand.action === "login") {
    await loginOpenAICodex({
      onDeviceCode({ verificationUrl, userCode, expiresInSeconds }) {
        console.log(`Open ${verificationUrl} in your browser.`);
        console.log(`Enter code: ${userCode}`);
        console.error(
          `Waiting for ChatGPT authorization (expires in ${Math.floor(expiresInSeconds / 60)} minutes)...`,
        );
      },
    });
    console.log("Logged in to ChatGPT (openai-codex).");
    return 0;
  }

  const deleted = await logoutOpenAICodex();
  console.log(
    deleted
      ? "Logged out of ChatGPT (openai-codex)."
      : "No ChatGPT credential was saved for openai-codex.",
  );
  return 0;
}
