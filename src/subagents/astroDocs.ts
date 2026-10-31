import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { gemini, GEMINI_MODELS } from "../services/gemini.js";
import { runCloudflareFlux } from "../services/cloudflare.js";
import { runAstroWebSearch, runAstroImageSearch } from "./astroSearch.js";
import { AstroDocState, ContentPage, DocSource, generateAstroHtml } from "./astroDocsTemplate.js";

const execFileAsync = promisify(execFile);

const CORNERS: Array<"top-right" | "bottom-left" | "top-left" | "bottom-right"> = [
  "top-right",
  "bottom-left",
  "top-left",
  "bottom-right"
];

const BOXICONS_LIST = [
  "bx bx-atom",
  "bx bx-dna",
  "bx bx-brain",
  "bx bx-microchip",
  "bx bx-planet",
  "bx bx-shield-quarter",
  "bx bx-network-chart",
  "bx bx-pulse",
  "bx bx-math",
  "bx bx-globe",
  "bx bx-compass",
  "bx bx-book-reader",
  "bx bx-data",
  "bx bx-bulb"
];

let activeDocId: string | null = null;

function findNativeChromium(): string {
  if (process.env.CHROME_PATH && existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }

  const candidates = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/snap/bin/chromium",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe"
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new Error("Chromium/Google Chrome not detected. Please install Chrome or set CHROME_PATH.");
}

async function renderHtmlToPdfNative(htmlPath: string, outputPath: string): Promise<void> {
  const binary = findNativeChromium();
  const fileUrl = `file://${path.resolve(htmlPath)}`;

  const args = [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--no-pdf-header-footer",
    "--run-all-compositor-stages-before-draw",
    "--virtual-time-budget=5000",
    `--print-to-pdf=${path.resolve(outputPath)}`,
    fileUrl
  ];

  await execFileAsync(binary, args);
}

async function ensureDirectories() {
  const baseDocs = path.join(process.cwd(), "storage", "docs");
  const htmlDir = path.join(baseDocs, "PDFhtml");
  const jsonDir = path.join(baseDocs, "PDFjson");

  await fs.mkdir(baseDocs, { recursive: true });
  await fs.mkdir(htmlDir, { recursive: true });
  await fs.mkdir(jsonDir, { recursive: true });

  return { baseDocs, htmlDir, jsonDir };
}

// ─────────────────────────────────────────────────────────
// 1. GENERATE NEW GROUNDED 15-PAGE DOSSIER
// ─────────────────────────────────────────────────────────
export async function runAstroDocs(params: {
  prompt: string;
  language?: string;
}): Promise<{ pdfPath: string; htmlPath: string; jsonPath: string; docId: string; version: number }> {
  const topic = params.prompt.trim();
  const lang = params.language || "en";
  const { baseDocs, htmlDir, jsonDir } = await ensureDirectories();

  const docId = topic.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24) || `doc_${Date.now()}`;
  activeDocId = docId;

  // 1. Fetch real web data AND real search images
  console.log(`\x1b[33m[AstroSearch Gathering Real Data & Image Links for "${topic}"...]\x1b[0m`);
  const [liveSearchResults, liveImages] = await Promise.all([
    runAstroWebSearch(topic),
    runAstroImageSearch(topic)
  ]);

  const formattedSearchContext = liveSearchResults
    .map((r, i) => `[Source ${i + 1}] Title: ${r.title}\nURL: ${r.link}\nSnippet: ${r.snippet}`)
    .join("\n\n");

  // 2. Feed grounded research to Gemini Flash with DOUBLE text rules
  const prompt = `
You are the Chief Academic Officer of AstroMind A1.
You are authoring a rigorous, dense, 15-page dossier on: "${topic}".
Language: ${lang}.

LIVE GROUNDED RESEARCH SOURCES:
${formattedSearchContext}

STRICT PAGE VOLUME & TEXT RULES (ELIMINATE EMPTY BOTTOM SPACES):
1. Output valid JSON ONLY.
2. NO EMOJIS, NO SVGS. Use ONLY Boxicon class names (e.g. "bx bx-dna", "bx bx-atom").
3. Generate EXACTLY 13 rich content pages (Pages 2 through 14).
4. Each page MUST be completely full of text (approx 350-400 words total per page) so there is ZERO blank space at the bottom:
   - "leadParagraph": 90-110 words introducing the concept and historical/technical context.
   - "subheading1": Descriptive sub-title for the theoretical mechanism.
   - "bodyParagraph1": 110-130 words of detailed scientific analysis.
   - "subheading2": Descriptive sub-title for clinical/practical real-world implementation.
   - "bodyParagraph2": 100-120 words of real-world outcomes and experimental data.
   - "keyTakeaways": 4 detailed, comprehensive bullet points.
5. Page 15 is SOURCES & REFERENCES: extract 5 to 7 verified references.

JSON Schema:
{
  "theme": {
    "primaryColor": "#0F172A",
    "accentColor": "#2563EB",
    "frameColor": "#94A3B8",
    "fontFamily": "'Inter', sans-serif",
    "fontSize": "12px",
    "imageSize": "210px"
  },
  "cover": {
    "mainTitle": "2-4 Word Compelling Title",
    "subtitle": "Detailed, elegant single-sentence subtitle.",
    "badge": "ACADEMIC DOSSIER",
    "executiveSummary": "120-word factual briefing grounded in real data.",
    "insights": ["Insight 1", "Insight 2", "Insight 3", "Insight 4"],
    "coverImagePrompt": "Cinematic visual description (max 8 words, no text)"
  },
  "pages": [
    {
      "pageNumber": 2,
      "title": "Section Title",
      "categoryTag": "FOUNDATIONS",
      "leadParagraph": "Dense historical and mechanical overview...",
      "subheading1": "Molecular & Structural Mechanics",
      "bodyParagraph1": "Thorough technical analysis explaining the precise process...",
      "subheading2": "Clinical Translation & Efficacy",
      "bodyParagraph2": "In-depth therapeutic outcomes and patient trials...",
      "keyTakeaways": ["Point 1", "Point 2", "Point 3", "Point 4"],
      "footerNote": "AstroMind A1 Grounded Research"
    }
  ],
  "sources": [
    {
      "type": "website",
      "title": "Source Title",
      "urlOrCitation": "https://source.com",
      "description": "Factual relevance."
    }
  ]
}
`;

  const geminiRes = await gemini.models.generateContent({
    model: GEMINI_MODELS.FLASH,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  const parsed = JSON.parse(geminiRes.text || "{}");

  // Cover image from Cloudflare Flux or first searched image
  let coverImageUrl = liveImages[0]?.imageUrl || "https://images.unsplash.com/photo-1532094349884-543bc11b234d?w=800&q=80";
  try {
    const buf = await runCloudflareFlux(parsed.cover?.coverImagePrompt || topic);
    coverImageUrl = `data:image/jpeg;base64,${buf.toString("base64")}`;
  } catch {}

  // Map real search images directly to pages
  const pages: ContentPage[] = (parsed.pages || []).slice(0, 13).map((p: any, idx: number) => {
    // Pick real Bing image from AstroSearch
    const searchedImg = liveImages[idx % liveImages.length]?.imageUrl;
    const fallbackImg = `https://images.unsplash.com/photo-${1530000000000 + (idx * 147829)}?auto=format&fit=crop&w=500&h=500&q=80`;

    return {
      pageNumber: idx + 2,
      title: p.title || `Section ${idx + 1}`,
      categoryTag: p.categoryTag || "ANALYSIS",
      iconClass: BOXICONS_LIST[idx % BOXICONS_LIST.length],
      imageCorner: CORNERS[idx % CORNERS.length],
      imageUrl: searchedImg || fallbackImg,
      leadParagraph: p.leadParagraph || "",
      subheading1: p.subheading1 || "Theoretical Foundations",
      bodyParagraph1: p.bodyParagraph1 || "",
      subheading2: p.subheading2 || "Practical Applications & Protocols",
      bodyParagraph2: p.bodyParagraph2 || "",
      keyTakeaways: p.keyTakeaways || [],
      footerNote: p.footerNote || "AstroMind A1 Grounded Research"
    };
  });

  const docState: AstroDocState = {
    docId,
    version: 1,
    theme: parsed.theme || {
      primaryColor: "#0F172A",
      accentColor: "#2563EB",
      frameColor: "#94A3B8",
      fontFamily: "'Inter', sans-serif",
      fontSize: "12px",
      imageSize: "210px"
    },
    cover: {
      ...parsed.cover,
      coverImageUrl,
      date: new Date().toLocaleDateString()
    },
    pages,
    sources: parsed.sources || []
  };

  const jsonPath = path.join(jsonDir, `${docId}_v1.json`);
  const htmlPath = path.join(htmlDir, `${docId}_v1.html`);
  const pdfPath = path.join(baseDocs, `${docId}_v1.pdf`);

  await fs.writeFile(jsonPath, JSON.stringify(docState, null, 2), "utf-8");
  const html = generateAstroHtml(docState);
  await fs.writeFile(htmlPath, html, "utf-8");

  await renderHtmlToPdfNative(htmlPath, pdfPath);

  return { pdfPath, htmlPath, jsonPath, docId, version: 1 };
}

// ─────────────────────────────────────────────────────────
// 2. CONVERSATIONAL EDITING (PRESERVES IMAGES 100%)
// ─────────────────────────────────────────────────────────
export async function editAstroDocs(params: {
  instruction: string;
  targetDocId?: string;
}): Promise<{ pdfPath: string; htmlPath: string; jsonPath: string; docId: string; version: number }> {
  const { baseDocs, htmlDir, jsonDir } = await ensureDirectories();
  const docId = params.targetDocId || activeDocId;

  if (!docId) {
    throw new Error("No active document found in this session to edit. Please create a document first.");
  }

  const files = await fs.readdir(jsonDir);
  const matching = files
    .filter((f) => f.startsWith(`${docId}_v`) && f.endsWith(".json"))
    .map((f) => {
      const match = f.match(/_v(\d+)\.json$/);
      return match ? parseInt(match[1]) : 1;
    })
    .sort((a, b) => b - a);

  const currentVersion = matching[0] || 1;
  const nextVersion = currentVersion + 1;

  const currentJsonPath = path.join(jsonDir, `${docId}_v${currentVersion}.json`);
  const rawState = await fs.readFile(currentJsonPath, "utf-8");
  const currentState: AstroDocState = JSON.parse(rawState);

  const editPrompt = `
You are the Document Refactoring Engine for AstroMind A1.
User Modification Instruction: "${params.instruction}"

Current Document State JSON:
${JSON.stringify(currentState, null, 2)}

TASK:
Apply the user's modifications accurately:
- If changing color: update theme.accentColor and theme.primaryColor.
- If changing font size: adjust theme.fontSize (e.g., 12.5px, 13px).
- If changing image size: adjust theme.imageSize (e.g., 230px, 190px).
- If tweaking text or titles on any page: update them.
- Preserve all 13 content pages and Page 15 sources.
- CRITICAL: KEEP all "imageUrl" properties intact. Do NOT erase or alter image URLs.
- NO emojis, NO SVGs. Use Boxicons only.

Return the FULL, VALID updated JSON.
`;

  const geminiRes = await gemini.models.generateContent({
    model: GEMINI_MODELS.FLASH,
    contents: editPrompt,
    config: { responseMimeType: "application/json" }
  });

  const updatedState: AstroDocState = JSON.parse(geminiRes.text || "{}");
  updatedState.docId = docId;
  updatedState.version = nextVersion;

  // Programmatic Guarantee: Existing images are NEVER lost during edits
  updatedState.pages = updatedState.pages.map((p, idx) => ({
    ...p,
    imageUrl: p.imageUrl || currentState.pages[idx]?.imageUrl || ""
  }));

  if (!updatedState.cover.coverImageUrl && currentState.cover.coverImageUrl) {
    updatedState.cover.coverImageUrl = currentState.cover.coverImageUrl;
  }

  const nextJsonPath = path.join(jsonDir, `${docId}_v${nextVersion}.json`);
  const nextHtmlPath = path.join(htmlDir, `${docId}_v${nextVersion}.html`);
  const nextPdfPath = path.join(baseDocs, `${docId}_v${nextVersion}.pdf`);

  await fs.writeFile(nextJsonPath, JSON.stringify(updatedState, null, 2), "utf-8");
  const html = generateAstroHtml(updatedState);
  await fs.writeFile(nextHtmlPath, html, "utf-8");

  await renderHtmlToPdfNative(nextHtmlPath, nextPdfPath);

  return {
    pdfPath: nextPdfPath,
    htmlPath: nextHtmlPath,
    jsonPath: nextJsonPath,
    docId,
    version: nextVersion
  };
}

export function getActiveDocId(): string | null {
  return activeDocId;
}