import * as readline from "readline";
import fs from "fs/promises";
import path from "path";
import { AstroMemoryManager } from "./core/memory.js";
import { processAstroMindQuery } from "./core/orchestrator.js";
import { runAstroFileStream } from "./subagents/astroFile.js";

const memory = new AstroMemoryManager();
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function renderProgressBar(percent: number, message: string) {
  const barWidth = 20;
  const filled = Math.round((percent / 100) * barWidth);
  const bar = "█".repeat(filled) + "░".repeat(Math.max(0, barWidth - filled));
  process.stdout.write(`\r\x1b[94m[${bar}] ${String(percent).padStart(3, " ")}%\x1b[0m \x1b[33m${message}\x1b[0m\x1b[K`);
}

console.log("\x1b[36m====================================================\x1b[0m");
console.log("\x1b[36m   AstroMind A1 Educational Workspace [CLI Engine]   \x1b[0m");
console.log("\x1b[36m====================================================\x1b[0m");
console.log("Commands:\n - Type any query\n - Analyze file (Images, PDF, TXT): 'analyze /path/to/file question'\n - 'exit' to quit\n");

function ask() {
  rl.question("\x1b[32mStudent > \x1b[0m", async (input) => {
    const trimmed = input.trim();
    if (trimmed.toLowerCase() === "exit") {
      rl.close();
      return;
    }
    if (!trimmed) {
      ask();
      return;
    }

    try {
      if (trimmed.startsWith("analyze ")) {
        const parts = trimmed.replace("analyze ", "").trim().split(" ");
        const filePath = parts[0];
        const task = parts.slice(1).join(" ") || "Analyze this study material.";

        try {
          const fileBuffer = await fs.readFile(filePath);
          const ext = path.extname(filePath).toLowerCase();
          let mime = "application/octet-stream";
          if (ext === ".png") mime = "image/png";
          else if (ext === ".jpg" || ext === ".jpeg") mime = "image/jpeg";
          else if (ext === ".webp") mime = "image/webp";
          else if (ext === ".pdf") mime = "application/pdf";
          else if (ext === ".txt") mime = "text/plain";

          process.stdout.write("\n\x1b[35mAstroFile [Streaming Analysis]:\x1b[0m\n");
          for await (const chunk of runAstroFileStream(fileBuffer, mime, task)) {
            process.stdout.write(chunk);
          }
          console.log("\n");
        } catch (err: any) {
          const msg = err?.message || (typeof err === "object" ? JSON.stringify(err) : String(err));
          console.error("\n\x1b[31m[AstroFile Error]:\x1b[0m", msg);
        }
        ask();
        return;
      }

      const result = await processAstroMindQuery(trimmed, memory, (pct, msg) => {
        renderProgressBar(pct, msg);
      });

      process.stdout.write("\r\x1b[K");

      if (result.streamGenerator) {
        process.stdout.write("\x1b[35mAstroMind:\x1b[0m ");
        for await (const chunk of result.streamGenerator) {
          process.stdout.write(chunk);
        }
        console.log("\n");
      } else if (result.message) {
        console.log(`\n\x1b[34m[AstroMind Decision]:\x1b[0m ${result.agent} (${result.language})`);
        console.log(`\x1b[35mAstroMind:\x1b[0m\n${result.message}\n`);
      }
    } catch (err: any) {
      process.stdout.write("\r\x1b[K");
      const errDetail = err?.message || (typeof err === "object" ? JSON.stringify(err) : String(err));
      console.error("\x1b[31m[Execution Error]:\x1b[0m", errDetail);
    }

    ask();
  });
}

ask();