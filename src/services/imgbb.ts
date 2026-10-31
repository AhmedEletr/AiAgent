import { ENV } from "../config/env.js";

interface ImgBBApiResponse {
  data: {
    id: string;
    title: string;
    url_viewer: string;
    url: string;
    display_url: string;
    delete_url: string;
  };
  success: boolean;
  status: number;
}

export async function uploadToImgBB(imageBuffer: Buffer, fileName: string): Promise<string> {
  const apiKey = ENV.IMGBB_API_KEY?.trim();

  // 1. Direct Binary Stream Upload to ImgBB (Permanent / No Expiration)
  if (apiKey) {
    try {
      const formData = new FormData();
      // Raw binary Blob is 33% lighter than Base64 string
      const blob = new Blob([imageBuffer as unknown as BlobPart], { type: "image/jpeg" });
      formData.append("image", blob, fileName);

      // Omitting 'expiration' guarantees permanent storage
      const response = await fetch(`https://api.imgbb.com/1/upload?key=${apiKey}`, {
        method: "POST",
        body: formData,
        signal: AbortSignal.timeout(20000) // 20-second allowance for domestic uplinks
      });

      if (response.ok) {
        const data = (await response.json()) as ImgBBApiResponse;
        if (data?.data?.url) return data.data.url;
      }
    } catch {
      // Step down to unblocked mirror fallback
    }
  }

  // 2. High-Speed Permanent CDN Fallback (FreeImageHost - Verified MENA routing)
  try {
    const formData = new FormData();
    const blob = new Blob([imageBuffer as unknown as BlobPart], { type: "image/jpeg" });
    formData.append("source", blob, fileName);
    formData.append("action", "upload");
    formData.append("key", "6d207e02198a847aa98d0a2a901485a5");
    formData.append("format", "json");

    const res = await fetch("https://freeimage.host/api/1/upload", {
      method: "POST",
      body: formData,
      signal: AbortSignal.timeout(15000)
    });

    if (res.ok) {
      const json: any = await res.json();
      if (json?.image?.url) return json.image.url;
    }
  } catch {
    // Final fallback to Base64 data URI
  }

  return `data:image/jpeg;base64,${imageBuffer.toString("base64")}`;
}