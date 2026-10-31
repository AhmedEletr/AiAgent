import Groq from "groq-sdk";
import { ENV } from "../config/env.js";

export const groq = new Groq({
  apiKey: ENV.GROQ_API_KEY
});

export const GROQ_MODELS = {
  ROUTER: "openai/gpt-oss-120b",
  FAST_CHAT: "openai/gpt-oss-120b",
  FALLBACK: "qwen/qwen3.8-27b"
};