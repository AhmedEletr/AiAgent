import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { AstroMemoryManager } from "./core/memory.js";
import { processAstroMindQuery } from "./core/orchestrator.js";
import { runAstroFile } from "./subagents/astroFile.js";
import { streamGeminiContent } from "./services/gemini.js";
import { ENV } from "./config/env.js";

const app = new Hono();
const sessionMemory = new AstroMemoryManager();

app.get("/", (c) => c.json({ status: "online", system: "AstroMind A1 Core" }));

// Standard Query Endpoint
app.post("/api/v1/agent", async (c) => {
  try {
    const body = await c.req.json();
    const query = body.prompt;
    if (!query) return c.json({ error: "Missing 'prompt' in request body" }, 400);

    const result = await processAstroMindQuery(query, sessionMemory);
    return c.json(result);
  } catch (error: any) {
    return c.json({ error: error.message }, 500);
  }
});

// Real-Time Streaming Endpoint (cURL & Browser SSE)
app.post("/api/v1/stream", async (c) => {
  const body = await c.req.json();
  const query = body.prompt;
  if (!query) return c.json({ error: "Missing 'prompt' in request body" }, 400);

  return streamSSE(c, async (stream) => {
    for await (const chunk of streamGeminiContent(query, "You are AstroMind A1, an elite study partner.")) {
      await stream.writeSSE({ data: chunk });
    }
  });
});

// File Analysis Endpoint (Strict: Images, PDF, TXT)
app.post("/api/v1/analyze-file", async (c) => {
  try {
    const body = await c.req.parseBody();
    const file = body["file"] as File;
    const task = (body["task"] as string) || "Analyze this document";

    if (!file) return c.json({ error: "No file provided" }, 400);

    const arrayBuffer = await file.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    const analysis = await runAstroFile(buffer, file.type, task);

    return c.json({ status: "success", analysis });
  } catch (error: any) {
    return c.json({ error: error.message }, 400);
  }
});

serve({ fetch: app.fetch, port: ENV.PORT }, (info) => {
  console.log(`🚀 AstroMind A1 running at http://localhost:${info.port}`);
});

export default app;