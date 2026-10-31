import fs from "fs/promises";
import path from "path";
import { runCloudflareFlux } from "../services/cloudflare.js";
import { uploadToImgBB } from "../services/imgbb.js";

export async function runAstroPaint(prompt: string): Promise<{ localPath: string; permanentUrl: string }> {
  const buffer = await runCloudflareFlux(prompt);
  
  const outputDir = path.join(process.cwd(), "storage", "images");
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `paint_${Date.now()}.jpg`;
  const localPath = path.join(outputDir, fileName);

  await fs.writeFile(localPath, buffer);

  let permanentUrl = "";
  try {
    permanentUrl = await uploadToImgBB(buffer, fileName);
  } catch (err: any) {
    console.error("Cloud upload error:", err.message);
    permanentUrl = `Local only: ${localPath}`;
  }

  return {
    localPath,
    permanentUrl
  };
}