#!/usr/bin/env node

import { spawn } from "node:child_process";
import { Command } from "commander";
import { PACKAGE_VERSION } from "./version";
import {
  authPath,
  beginOAuth,
  readStoredAuth,
  resolveXaiCredentials,
} from "./xai";

function openBrowser(url: string) {
  let command: string;
  if (process.platform === "darwin") {
    command = "open";
  } else if (process.platform === "win32") {
    command = "cmd";
  } else {
    command = "xdg-open";
  }
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { stdio: "ignore", detached: true });
  child.on("error", () => {
    // Best-effort browser launch only.
  });
  child.unref();
}

const program = new Command()
  .name("opencode-xai-oauth")
  .description("xAI OAuth and tool support for OpenCode")
  .version(PACKAGE_VERSION);

program
  .command("login")
  .description(
    "Start the xAI OAuth login flow and save credentials for OpenCode tools"
  )
  .option(
    "--no-browser",
    "print the URL instead of opening the default browser"
  )
  .action(async (options: { browser: boolean }) => {
    try {
      const flow = await beginOAuth();
      console.log(`Open this xAI OAuth URL:\n${flow.url}\n`);
      if (options.browser) {
        openBrowser(flow.url);
      }
      console.log("Waiting for browser callback on localhost...");
      const auth = await flow.complete();
      console.log(`Saved xAI OAuth token to ${authPath()}`);
      console.log(
        `Access token expires at ${new Date(auth.expires).toISOString()}`
      );
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  });

program
  .command("status")
  .description("Check xAI OAuth/API-key credential availability")
  .action(async () => {
    const stored = readStoredAuth();
    try {
      const creds = await resolveXaiCredentials();
      console.log(
        JSON.stringify(
          {
            success: true,
            credential_source: creds.provider,
            base_url: creds.baseUrl,
            auth_file: authPath(),
            oauth_file_present: Boolean(stored),
          },
          null,
          2
        )
      );
    } catch (error) {
      console.log(
        JSON.stringify(
          {
            success: false,
            error: error instanceof Error ? error.message : String(error),
            auth_file: authPath(),
            oauth_file_present: Boolean(stored),
          },
          null,
          2
        )
      );
      process.exitCode = 1;
    }
  });

program.parseAsync();
