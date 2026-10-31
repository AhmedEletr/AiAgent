import { ENV } from "../config/env.js";

interface CloudflareFluxResponse {
  result?: {
    image?: string;
  };
  image?: string;
  success?: boolean;
  errors?: Array<{ code: number; message: string }>;
}

export async function runCloudflareFlux(prompt: string): Promise<Buffer> {
  const url = `https://api.cloudflare.com/client/v4/accounts/${ENV.CLOUDFLARE_ACCOUNT_ID}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ENV.CLOUDFLARE_API_TOKEN}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({ prompt, steps: 4 })
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Cloudflare AI Generation failed: ${errorText}`);
  }

  const contentType = response.headers.get("content-type") || "";

  // Cloudflare returns JSON with base64 for Flux
  if (contentType.includes("application/json")) {
    const json = (await response.json()) as CloudflareFluxResponse;
    const base64Data = json.result?.image || json.image;
    if (!base64Data) {
      throw new Error(`Invalid response structure from Cloudflare: ${JSON.stringify(json)}`);
    }
    return Buffer.from(base64Data, "base64");
  }

  // Fallback for models returning raw binary stream
  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}