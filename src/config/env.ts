import dotenv from "dotenv";
dotenv.config();

export const ENV = {
  PORT: process.env.PORT ? parseInt(process.env.PORT) : 3000,
  GROQ_API_KEY: process.env.GROQ_API_KEY || "",
  GEMINI_API_KEY: process.env.GEMINI_API_KEY || "",
  CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID || "",
  CLOUDFLARE_API_TOKEN: process.env.CLOUDFLARE_API_TOKEN || "",
  IMGBB_API_KEY: process.env.IMGBB_API_KEY || ""
};