import { GoogleGenAI } from "@google/genai";
import { ENV } from "../config/env.js";

export const gemini = new GoogleGenAI({
  apiKey: ENV.GEMINI_API_KEY
});

export const GEMINI_MODELS = {
  FLASH_LITE: "gemini-flash-lite-latest",
  FLASH: "gemini-3.1-flash-lite"
};

// Stream full multi-turn conversation
export async function* streamGeminiContent(
  contents: any[] | string,
  systemPrompt?: string
) {
  const config: Record<string, any> = {
    temperature: 0.7
  };

  if (systemPrompt) {
    config.systemInstruction = systemPrompt;
  }

  // If a simple string was passed, wrap it in a single user turn; otherwise use the full history array
  const formattedContents = Array.isArray(contents)
    ? contents
    : [{ role: "user", parts: [{ text: contents }] }];

  const streamResponse = await gemini.models.generateContentStream({
    model: GEMINI_MODELS.FLASH_LITE,
    contents: formattedContents,
    config
  });

  for await (const chunk of streamResponse) {
    if (chunk.text) {
      yield chunk.text;
    }
  }
}