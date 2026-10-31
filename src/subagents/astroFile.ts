import { gemini, GEMINI_MODELS } from "../services/gemini.js";

const ALLOWED_MIME_TYPES = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "application/pdf",
  "text/plain"
];

export async function* runAstroFileStream(
  fileBuffer: Buffer, 
  mimeType: string, 
  taskPrompt: string
): AsyncGenerator<string, void, unknown> {
  const normalizedMime = mimeType.toLowerCase().trim();
  const isAllowed = ALLOWED_MIME_TYPES.some((allowed) => normalizedMime.includes(allowed) || normalizedMime === allowed);

  if (!isAllowed) {
    throw new Error(
      `🚫 Unsupported file format (${mimeType}). AstroFile strictly analyzes Images (PNG, JPG, WEBP), PDFs, and TXT files only.`
    );
  }

  // Handle plain text streaming
  if (normalizedMime.includes("text/plain")) {
    const textContent = fileBuffer.toString("utf-8");
    const stream = await gemini.models.generateContentStream({
      model: GEMINI_MODELS.FLASH_LITE,
      contents: [
        { text: `Analyze the following text file according to this instruction: "${taskPrompt}"\n\n--- FILE CONTENT ---\n${textContent}` }
      ]
    });

    for await (const chunk of stream) {
      if (chunk.text) yield chunk.text;
    }
    return;
  }

  // Handle Image & PDF multimodal streaming
  const stream = await gemini.models.generateContentStream({
    model: GEMINI_MODELS.FLASH,
    contents: [
      {
        inlineData: {
          mimeType: normalizedMime,
          data: fileBuffer.toString("base64")
        }
      },
      { text: taskPrompt || "Thoroughly analyze this document and summarize key academic concepts." }
    ]
  });

  for await (const chunk of stream) {
    if (chunk.text) yield chunk.text;
  }
}