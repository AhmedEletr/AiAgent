import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { gemini, GEMINI_MODELS } from "../services/gemini.js";
import { groq, GROQ_MODELS } from "../services/groq.js";
import { runAstroImageSearch } from "./astroSearch.js";
import PptxGenJS from "pptxgenjs";

export type ProgressCallback = (percent: number, message: string) => void;

let activeDeckId: string | null = null;

async function ensureDirectories() {
  const baseDir = path.join(process.cwd(), "storage", "slides");
  const htmlDir = path.join(baseDir, "SlidesHtml");
  const jsonDir = path.join(baseDir, "SlidesJson");
  const tempImgDir = path.join(baseDir, ".temp_imgs");

  await fsp.mkdir(baseDir, { recursive: true });
  await fsp.mkdir(htmlDir, { recursive: true });
  await fsp.mkdir(jsonDir, { recursive: true });
  await fsp.mkdir(tempImgDir, { recursive: true });

  return { baseDir, htmlDir, jsonDir, tempImgDir };
}

function cleanUnicodeAndSymbols(str: any): string {
  if (!str || typeof str !== "string") return "";
  return str
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

async function downloadImageTemp(url: string, destPath: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) return null;
    const arrayBuffer = await res.arrayBuffer();
    await fsp.writeFile(destPath, Buffer.from(arrayBuffer));
    return destPath;
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────
// 1. DYNAMIC ACADEMIC 20-SLIDE ARCHITECTURE GENERATOR
// ─────────────────────────────────────────────────────────
async function generateLectureData(topic: string, lang: string): Promise<any> {
  const isArabic = lang === "ar";
  const systemPrompt = `You are a distinguished University Professor and Academic Dean.
Author a rigorous, textbook-grade 20-SLIDE academic lecture presentation on: "${topic}".
Language strictly: ${isArabic ? "ARABIC (فصحى أكاديمية جامعية رصينة)" : lang.toUpperCase()}.

CRITICAL DESIGN & FORMULA SPECIFICATIONS:
- Formulate real, rigorous mathematical or scientific equations using LaTeX syntax ($...$ for inline, $$...$$ for display).
- Invent an authentic university course code matching the domain (e.g. "PHYS 401", "CS 502", "MED 410", "MATH 301", "BIO 320", "ECON 405").
- Produce structured content across all 20 slides:
  1. cover: courseCode, term, credits, mainTitle, subtitle, card1 { title, formula, desc }, card2 { title, formula, desc }, invariantStrip [3 items], masterFormula, department, prerequisites.
  2. syllabus: 4 modules with title, desc, coreObjective.
  3. crisis_dilemma: classicalParadigm { title, desc }, modernParadigm { title, desc, formula }, paradox { title, desc }, visualCaption.
  4. historical_roadmap: 4 milestones with date, title, formula, desc, badge.
  5. axiomatic_postulates: post1 { title, desc }, post2 { title, desc, formula }, visualCaption.
  6. data_and_kinematics: formula, formulaLabel, labNote, chartTitle, chartLabels [6 items], chartData [6 numbers].
  7. core_mechanism: formula, formulaLabel, misconception, visualCaption.
  8. master_equations: formula1, label1, formula2, label2, visualCaption.
  9. boundaries_and_limits: 3 limitation cards with icon, title, desc, callout.
  10. thought_experiment: title, paradigmDesc, formula, formulaLabel, conclusion, visualCaption.
  11. field_and_curvature: quote, quoteAuthor, formula, formulaLabel, visualCaption.
  12. tensor_master_equations: masterFormula, masterLabel, correspondenceNote, comp1 { title, desc }, comp2 { title, desc }, comp3 { title, desc }.
  13. observation_phenomena: phenomenon1 { title, formula, desc }, phenomenon2 { title, formula, desc }, visualCaption.
  14. decisive_experiment: formula, formulaLabel, compTitle, compDesc, verifiedQuote, visualCaption.
  15. compact_limits: formula, formulaLabel, boundary1 { title, desc }, boundary2 { title, desc }, visualCaption.
  16. precision_metrology: formula, formulaLabel, eventTitle, eventDesc, visualCaption.
  17. engineering_application: chartTitle, chartLabels [3 items], chartData [3 numbers], point1 { title, desc }, point2 { title, desc }, point3 { title, desc }.
  18. cosmic_budget: chartTitle, chartLabels [3 items], chartData [3 numbers], note1 { title, desc }, note2 { title, desc }.
  19. systematic_synthesis_table: dimensionHeaders [3 items], rows [5 rows of 3 items each].
  20. summary_takeaways: 4 summary pillars { title, desc }, assignedReading, officeHours, examNotice.

Return STRICT JSON matching this schema.`;

  const userRequest = `Generate the complete 20-slide university lecture presentation JSON for: "${topic}".`;

  // Tier 1: Gemini 2.0 Flash
  try {
    const res = await gemini.models.generateContent({
      model: GEMINI_MODELS.FLASH,
      contents: userRequest,
      config: {
        systemInstruction: systemPrompt,
        responseMimeType: "application/json"
      }
    });
    return JSON.parse(res.text || "{}");
  } catch {}

  // Tier 2: Groq GPT-OSS-120B
  try {
    const groqRes = await groq.chat.completions.create({
      model: GROQ_MODELS.ROUTER,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userRequest }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });
    return JSON.parse(groqRes.choices[0]?.message?.content || "{}");
  } catch {
    // Tier 3: Groq Llama 3.3 70B
    const fallbackRes = await groq.chat.completions.create({
      model: GROQ_MODELS.FALLBACK,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userRequest }
      ],
      response_format: { type: "json_object" },
      temperature: 0.2
    });
    return JSON.parse(fallbackRes.choices[0]?.message?.content || "{}");
  }
}

// ─────────────────────────────────────────────────────────
// 2. TEXTBOOK-GRADE UNIVERSITY HTML SLIDE ENGINE (20 SLIDES)
// ─────────────────────────────────────────────────────────
function buildLectureHTML(data: any, lang: string, imgUrls: string[]): string {
  const isRTL = lang === "ar";
  const dir = isRTL ? "rtl" : "ltr";
  const topic = cleanUnicodeAndSymbols(data.topic || "Academic Masterclass");
  const courseCode = cleanUnicodeAndSymbols(data.courseCode || "ACAD 401");

  // Helper for safe image allocation
  const getImg = (idx: number, fallback: string) => imgUrls[idx % imgUrls.length] || fallback;

  // Build Charts URLs
  const c1Labels = encodeURIComponent(JSON.stringify(data.chart1?.chartLabels || ["10%", "25%", "50%", "75%", "90%", "99%"]));
  const c1Data = encodeURIComponent(JSON.stringify(data.chart1?.chartData || [1.0, 1.05, 1.25, 1.8, 3.2, 7.1]));
  const chart1Url = `https://quickchart.io/chart?devicePixelRatio=2&w=700&h=420&c=%7Btype%3A%27line%27%2Cdata%3A%7Blabels%3A${c1Labels}%2Cdatasets%3A%5B%7Blabel%3A%27Precision%20Index%27%2Cdata%3A${c1Data}%2CborderColor%3A%27%231d4ed8%27%2CbackgroundColor%3A%27rgba(29%2C78%2C216%2C0.12)%27%2Cfill%3Atrue%2CborderWidth%3A3.5%2CpointRadius%3A4%7D%5D%7D%2Coptions%3A%7Btitle%3A%7Bdisplay%3Atrue%2Ctext%3A%27${encodeURIComponent(data.chart1?.chartTitle || "Kinematic Progression Curve")}%27%2CfontSize%3A14%7D%7D%7D`;

  const c2Labels = encodeURIComponent(JSON.stringify(data.engineering_application?.chartLabels || ["System Alpha", "System Beta", "Net Benchmark"]));
  const c2Data = encodeURIComponent(JSON.stringify(data.engineering_application?.chartData || [-7.2, 45.8, 38.6]));
  const chart2Url = `https://quickchart.io/chart?devicePixelRatio=2&w=700&h=420&c=%7Btype%3A%27bar%27%2Cdata%3A%7Blabels%3A${c2Labels}%2Cdatasets%3A%5B%7Blabel%3A%27Variance%20Offset%27%2Cdata%3A${c2Data}%2CbackgroundColor%3A%5B%27%23be123c%27%2C%27%231d4ed8%27%2C%27%23047857%27%5D%2CborderRadius%3A6%7D%5D%7D%2Coptions%3A%7Btitle%3A%7Bdisplay%3Atrue%2Ctext%3A%27${encodeURIComponent(data.engineering_application?.chartTitle || "Empirical System Calibration")}%27%2CfontSize%3A14%7D%2Clegend%3A%7Bdisplay%3Afalse%7D%7D%7D`;

  const c3Labels = encodeURIComponent(JSON.stringify(data.cosmologyBudget?.chartLabels || ["Core Dynamic (68%)", "Latent Fabric (27%)", "Observed Matter (5%)"]));
  const c3Data = encodeURIComponent(JSON.stringify(data.cosmologyBudget?.chartData || [68, 27, 5]));
  const chart3Url = `https://quickchart.io/chart?devicePixelRatio=2&w=700&h=420&c=%7Btype%3A%27doughnut%27%2Cdata%3A%7Blabels%3A${c3Labels}%2Cdatasets%3A%5B%7Bdata%3A${c3Data}%2CbackgroundColor%3A%5B%27%231d4ed8%27%2C%27%2364748b%27%2C%27%23d97706%27%5D%7D%5D%7D%2Coptions%3A%7Btitle%3A%7Bdisplay%3Atrue%2Ctext%3A%27${encodeURIComponent(data.cosmologyBudget?.chartTitle || "Total System Allocation")}%27%2CfontSize%3A14%7D%7D%7D`;

  return `<!DOCTYPE html>
<html lang="${lang}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${topic} - University Lecture</title>
  
  <link href="https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css" rel="stylesheet">
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@300;400;500;600;700;800&family=Cairo:wght@400;600;700;800&family=Tajawal:wght@500;700;800&family=Space+Grotesk:wght@500;600;700&display=swap" rel="stylesheet">

  <!-- KaTeX for Textbook-Grade Formula Typesetting -->
  <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.css">
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/katex.min.js"></script>
  <script defer src="https://cdn.jsdelivr.net/npm/katex@0.16.8/dist/contrib/auto-render.min.js"
    onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '$', right: '$', display: false}]});"></script>

  <style>
    :root {
      --bg-stage: #eef2f7;
      --slide-bg: #ffffff;
      --oxford-navy: #0b1528;
      --navy-800: #162444;
      --academic-blue: #1d4ed8;
      --columbia-blue: #2563eb;
      --blue-subtle: #f0f6ff;
      --border-blue: #dbeafe;
      --slate-700: #334155;
      --slate-500: #64748b;
      --slate-400: #94a3b8;
      --slate-200: #e2e8f0;
      --slate-100: #f8fafc;
      --note-amber: #b45309;
      --note-amber-bg: #fffbeb;
      --note-amber-border: #fde68a;
      --note-green: #047857;
      --note-green-bg: #f0fdf4;
      --note-green-border: #bbf7d0;
      --accent-red: #be123c;
      --morph-timing: cubic-bezier(0.16, 1, 0.3, 1);
      --font-stack: ${isRTL ? "'Tajawal', 'Cairo', sans-serif" : "'Plus Jakarta Sans', -apple-system, sans-serif"};
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      background-color: var(--bg-stage);
      font-family: var(--font-stack);
      color: var(--oxford-navy);
      display: flex;
      justify-content: center;
      align-items: center;
      min-height: 100vh;
      overflow: hidden;
      user-select: none;
    }

    .lecture-frame {
      position: relative;
      width: min(95vw, calc(95vh * 16 / 9));
      height: min(95vh, calc(95vw * 9 / 16));
      aspect-ratio: 16 / 9;
      background: var(--slide-bg);
      border-radius: 12px;
      box-shadow: 0 20px 45px rgba(11, 21, 40, 0.09), 0 2px 8px rgba(11, 21, 40, 0.04);
      overflow: hidden;
      border: 1px solid #cbd5e1;
    }

    .lecture-progress-ribbon {
      position: absolute;
      top: 0;
      left: 0;
      height: 5px;
      background: linear-gradient(90deg, #1e3a8a 0%, #2563eb 50%, #60a5fa 100%);
      z-index: 50;
      transition: width 0.4s var(--morph-timing);
    }

    .slide {
      position: absolute;
      inset: 0;
      padding: 2.4rem 3.8rem 2rem 3.8rem;
      background: #ffffff;
      opacity: 0;
      visibility: hidden;
      transform: scale(0.985) translateY(12px);
      transition: opacity 0.4s var(--morph-timing), transform 0.4s var(--morph-timing), visibility 0.4s;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      pointer-events: none;
    }

    .slide.active {
      opacity: 1;
      visibility: visible;
      transform: scale(1) translateY(0);
      pointer-events: auto;
    }

    .slide.active .lecture-header { animation: morphIn 0.45s var(--morph-timing) both; }
    .slide.active .card, .slide.active .timeline-card, .slide.active .lecture-table { animation: morphIn 0.5s var(--morph-timing) 0.06s both; }
    .slide.active .math-box { animation: morphScale 0.52s var(--morph-timing) 0.1s both; }
    .slide.active .edu-callout { animation: morphIn 0.55s var(--morph-timing) 0.12s both; }
    .slide.active .tall-visual-box img { animation: morphZoom 0.6s var(--morph-timing) 0.04s both; }
    .slide.active .chart-img-tall { animation: morphScale 0.55s var(--morph-timing) 0.12s both; }

    @keyframes morphIn { from { opacity: 0; transform: translateY(12px); } to { opacity: 1; transform: translateY(0); } }
    @keyframes morphScale { from { opacity: 0; transform: scale(0.96); } to { opacity: 1; transform: scale(1); } }
    @keyframes morphZoom { from { opacity: 0; transform: scale(1.04); } to { opacity: 1; transform: scale(1); } }

    .lecture-header { margin-bottom: 0.9rem; }
    .meta-tag-row { display: flex; align-items: center; gap: 8px; margin-bottom: 4px; }
    .edu-badge {
      display: inline-flex; align-items: center; gap: 5px; background: var(--blue-subtle);
      color: var(--academic-blue); border: 1px solid var(--border-blue); padding: 2px 10px;
      border-radius: 4px; font-size: 0.7rem; font-weight: 700; text-transform: uppercase; letter-spacing: 0.6px;
    }
    .edu-tag-neutral {
      background: var(--slate-100); color: var(--slate-500); border: 1px solid var(--slate-200);
      padding: 2px 8px; border-radius: 4px; font-size: 0.68rem; font-weight: 600;
    }
    .slide-title { font-size: 1.85rem; font-weight: 800; color: var(--oxford-navy); line-height: 1.18; letter-spacing: -0.4px; }
    .slide-subtitle { font-size: 0.88rem; color: var(--slate-500); margin-top: 2px; font-weight: 400; }
    .slide-body { flex: 1; display: flex; align-items: center; gap: 1.8rem; position: relative; min-height: 0; }

    .lecture-footer {
      display: flex; justify-content: space-between; align-items: center; padding-top: 0.75rem;
      border-top: 1px solid var(--slate-200); font-size: 0.72rem; color: var(--slate-400); font-weight: 500;
    }
    .footer-left { display: flex; gap: 1.8rem; }
    .slide-index-pill {
      font-weight: 700; color: var(--academic-blue); background: var(--blue-subtle);
      padding: 2px 9px; border-radius: 4px; border: 1px solid var(--border-blue);
    }

    .grid-2 { display: grid; grid-template-columns: 1.05fr 0.95fr; gap: 1.8rem; width: 100%; height: 100%; align-items: stretch; }
    .grid-3 { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1.3rem; width: 100%; }
    .grid-4 { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; width: 100%; }

    .card {
      background: #ffffff; border: 1px solid var(--slate-200); border-radius: 8px; padding: 1.15rem;
      box-shadow: 0 2px 8px rgba(11, 21, 40, 0.03); display: flex; flex-direction: column; justify-content: center;
    }
    .card-tint { background: var(--slate-100); border-color: #cbd5e1; }
    .card-academic { background: #ffffff; border: 1px solid #bfdbfe; border-left: 5px solid var(--academic-blue); }

    .edu-callout {
      border-radius: 6px; padding: 8px 12px; font-size: 0.76rem; line-height: 1.45;
      display: flex; align-items: flex-start; gap: 8px; margin-top: 8px;
    }
    .edu-callout-insight { background: var(--blue-subtle); border: 1px solid var(--border-blue); color: #1e3a8a; }
    .edu-callout-warning { background: var(--note-amber-bg); border: 1px solid var(--note-amber-border); color: var(--note-amber); }
    .edu-callout-verified { background: var(--note-green-bg); border: 1px solid var(--note-green-border); color: var(--note-green); }

    .tall-visual-box {
      width: 100%; height: 100%; min-height: 330px; border-radius: 14px; overflow: hidden;
      border: 1px solid #cbd5e1; box-shadow: 0 6px 18px rgba(11, 21, 40, 0.06); position: relative;
    }
    .tall-visual-box img { width: 100%; height: 100%; object-fit: cover; display: block; }
    .visual-caption-bar {
      position: absolute; bottom: 0; left: 0; right: 0; background: rgba(11, 21, 40, 0.88);
      color: #ffffff; backdrop-filter: blur(6px); padding: 8px 14px; font-size: 0.7rem; line-height: 1.35;
      border-top: 1px solid rgba(255, 255, 255, 0.15);
    }

    .math-box {
      background: #ffffff; border: 1px solid var(--border-blue); border-left: 5px solid var(--academic-blue);
      border-radius: 6px; padding: 1rem 1.4rem; margin: 0.6rem 0; box-shadow: 0 3px 10px rgba(29, 78, 216, 0.04);
      display: flex; flex-direction: column; align-items: center; justify-content: center;
    }
    .formula-expression { font-size: 1.65rem; color: var(--oxford-navy); margin: 0.15rem 0; }
    .formula-label { font-size: 0.72rem; color: var(--slate-500); font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-top: 3px; }

    .chart-img-tall {
      width: 100%; height: 100%; max-height: 350px; min-height: 310px; object-fit: contain;
      border-radius: 14px; border: 1px solid var(--slate-200); background: #ffffff;
      box-shadow: 0 6px 20px rgba(11, 21, 40, 0.05); padding: 8px;
    }

    .edu-timeline { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; width: 100%; }
    .timeline-card {
      background: #ffffff; border: 1px solid var(--slate-200); border-top: 4px solid var(--academic-blue);
      border-radius: 8px; padding: 1.2rem 1rem; display: flex; flex-direction: column; gap: 8px;
      box-shadow: 0 4px 12px rgba(11, 21, 40, 0.03); position: relative;
    }
    .timeline-module-tag {
      font-size: 0.68rem; font-weight: 800; color: var(--academic-blue); background: var(--blue-subtle);
      padding: 2px 7px; border-radius: 3px; align-self: flex-start;
    }

    .lecture-table { width: 100%; border-collapse: collapse; font-size: 0.85rem; text-align: ${isRTL ? "right" : "left"}; }
    .lecture-table th { background: var(--oxford-navy); color: #ffffff; padding: 10px 14px; font-weight: 700; font-size: 0.78rem; letter-spacing: 0.4px; }
    .lecture-table td { padding: 10px 14px; border-bottom: 1px solid var(--slate-200); color: var(--oxford-navy); }
    .lecture-table tr:nth-child(even) td { background: var(--slate-100); }
  </style>
</head>
<body>

  <div class="lecture-frame" id="presentationContainer">
    <div class="lecture-progress-ribbon" id="progressRibbon" style="width: 5%;"></div>

    <!-- ==================== SLIDE 1: Cover Slide ==================== -->
    <div class="slide active" style="padding: 0;">
      <div style="display: flex; height: 100%;">
        <div style="flex: 1.15; padding: 3.2rem 3.8rem 2.4rem 4.2rem; display: flex; flex-direction: column; justify-content: space-between; background: #ffffff;">
          <div>
            <div class="meta-tag-row">
              <span class="edu-badge"><i class='bx bxs-graduation'></i> ${courseCode} &bull; ${cleanUnicodeAndSymbols(data.term || "ADVANCED ACADEMIC DISCIPLINE")}</span>
              <span class="edu-tag-neutral">${cleanUnicodeAndSymbols(data.credits || "4.0 CREDITS")}</span>
            </div>
            <h1 style="font-size: 2.7rem; font-weight: 800; color: var(--oxford-navy); line-height: 1.12; letter-spacing: -0.8px; margin: 0.7rem 0 0.5rem 0;">
              ${cleanUnicodeAndSymbols(data.mainTitle || topic)}
            </h1>
            <p style="font-size: 0.92rem; color: var(--slate-500); line-height: 1.5; max-width: 520px;">
              ${cleanUnicodeAndSymbols(data.subtitle || "A comprehensive axiomatic exposition spanning theoretical principles and observational validations.")}
            </p>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 12px; margin-top: 1.2rem; max-width: 530px;">
              <div style="border: 1px solid #bfdbfe; border-left: 4px solid var(--academic-blue); border-radius: 6px; padding: 9px 12px; background: #f8fbff;">
                <div style="font-size: 0.68rem; font-weight: 800; color: var(--academic-blue); text-transform: uppercase;">${cleanUnicodeAndSymbols(data.coverCard1?.title || "Core Invariant")}</div>
                <div style="font-size: 0.88rem; font-weight: 700; color: var(--oxford-navy); margin-top: 2px;">${data.coverCard1?.formula || "$$\\mathcal{F} = \\int \\mathcal{L}\\,dt$$"}</div>
                <div style="font-size: 0.7rem; color: var(--slate-500); margin-top: 2px;">${cleanUnicodeAndSymbols(data.coverCard1?.desc || "Invariant symmetry metric")}</div>
              </div>
              <div style="border: 1px solid #fed7aa; border-left: 4px solid #ea580c; border-radius: 6px; padding: 9px 12px; background: #fffaf5;">
                <div style="font-size: 0.68rem; font-weight: 800; color: #ea580c; text-transform: uppercase;">${cleanUnicodeAndSymbols(data.coverCard2?.title || "Dynamic Governing Form")}</div>
                <div style="font-size: 0.88rem; font-weight: 700; color: var(--oxford-navy); margin-top: 2px;">${data.coverCard2?.formula || "$$\\mathbf{G} = \\kappa \\mathbf{T}$$"}</div>
                <div style="font-size: 0.7rem; color: var(--slate-500); margin-top: 2px;">${cleanUnicodeAndSymbols(data.coverCard2?.desc || "Dynamical field coupling")}</div>
              </div>
            </div>

            <div style="display: flex; gap: 12px; margin-top: 1rem;">
              ${(data.invariantStrip || ["Invariant Metric", "Validated SLA", "Deterministic Bounds"]).map((item: string) => `
                <div style="font-size: 0.72rem; color: var(--slate-700); background: var(--slate-100); border: 1px solid var(--slate-200); padding: 4px 10px; border-radius: 4px;">
                  ${cleanUnicodeAndSymbols(item)}
                </div>
              `).join("")}
            </div>
          </div>

          <div style="border-top: 1px solid var(--slate-200); padding-top: 0.8rem; display: flex; justify-content: space-between; align-items: flex-end;">
            <div>
              <div style="font-size: 0.82rem; font-weight: 700; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(data.department || "Division of Mathematical & Theoretical Sciences")}</div>
              <div style="font-size: 0.72rem; color: var(--slate-400);">${cleanUnicodeAndSymbols(data.prerequisites || "Academic Lecture Series")}</div>
            </div>
            <div style="font-size: 0.74rem; color: var(--academic-blue); font-weight: 700;">Slide 01 / 20</div>
          </div>
        </div>

        <div style="flex: 0.85; position: relative; overflow: hidden; background: #060b18;">
          <img src="${getImg(0, "https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=1200&q=80")}" alt="Hero Lecture Visual" style="width: 100%; height: 100%; object-fit: cover;">
          <div style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(6,11,24,0.15) 0%, rgba(6,11,24,0.85) 100%);"></div>
          <div style="position: absolute; bottom: 24px; left: 24px; right: 24px; background: rgba(255, 255, 255, 0.94); backdrop-filter: blur(10px); padding: 14px 18px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.85); box-shadow: 0 10px 25px rgba(0,0,0,0.25);">
            <div style="font-size: 1.15rem; color: var(--oxford-navy); font-weight: 600; text-align: center;">
              ${data.coverFormula || "$$\\mathcal{R}_{\\mu\\nu} - \\frac{1}{2}R g_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}$$"}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ==================== SLIDE 2: Syllabus ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-book-bookmark'></i> SYLLABUS</span><span class="edu-tag-neutral">LEARNING ROADMAP</span></div>
        <h2 class="slide-title">Course Modules & Learning Objectives</h2>
        <p class="slide-subtitle">Four structured academic units breaking down core mechanisms.</p>
      </div>
      <div class="slide-body">
        <div class="grid-4">
          ${(data.syllabusUnits || [
            { title: "Foundations & Dilemma", desc: "Classical anomalies and the requirement for universal invariance.", core: "Unit 01 Core" },
            { title: "Theoretical Formulation", desc: "Axiomatic derivations and spacetime metric invariance.", core: "Unit 02 Core" },
            { title: "Mathematical Geometry", desc: "Non-linear manifold tensor equations and curvature.", core: "Unit 03 Core" },
            { title: "Empirical Proofs", desc: "Astrophysical, laboratory, and orbital engineering validations.", core: "Unit 04 Core" }
          ]).map((u: any, idx: number) => `
            <div class="card card-tint" style="border-top: 4px solid var(--academic-blue);">
              <span class="timeline-module-tag">UNIT 0${idx + 1}</span>
              <h4 style="font-size: 0.95rem; margin: 4px 0; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(u.title)}</h4>
              <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.45;">${cleanUnicodeAndSymbols(u.desc)}</p>
              <div class="edu-callout edu-callout-insight" style="margin-top: auto;">${cleanUnicodeAndSymbols(u.core || u.coreObjective || "Foundational Benchmark")}</div>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Course Syllabus</span></div><span class="slide-index-pill">Slide 02 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 3: Dilemma / Crisis ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-history'></i> HISTORICAL FOUNDATION</span><span class="edu-tag-neutral">UNIT 1.1</span></div>
        <h2 class="slide-title">The Classical Crisis: Paradigm Conflict</h2>
        <p class="slide-subtitle">The theoretical contradiction between established mechanics and invariant laws.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: space-between;">
          <div class="card card-academic">
            <h4 style="color: var(--academic-blue); font-size: 0.92rem; margin-bottom: 4px;"><i class='bx bx-wrench'></i> ${cleanUnicodeAndSymbols(data.crisis_dilemma?.classicalParadigm?.title || "Classical Mechanics Baseline")}</h4>
            <p style="font-size: 0.8rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.crisis_dilemma?.classicalParadigm?.desc || "Relies on absolute Euclidean space and Galilean velocity addition.")}</p>
          </div>
          <div class="card" style="border-left: 5px solid var(--accent-red);">
            <h4 style="color: var(--accent-red); font-size: 0.92rem; margin-bottom: 4px;"><i class='bx bx-radio'></i> ${cleanUnicodeAndSymbols(data.crisis_dilemma?.modernParadigm?.title || "Universal Invariant Dynamics")}</h4>
            <p style="font-size: 0.8rem; color: var(--slate-700); line-height: 1.5;">
              ${cleanUnicodeAndSymbols(data.crisis_dilemma?.modernParadigm?.desc || "Propagates with an invariant speed across all reference frames.")}
              ${data.crisis_dilemma?.modernParadigm?.formula || "$$\\quad c = \\frac{1}{\\sqrt{\\mu_0 \\varepsilon_0}} \\approx 2.998 \\times 10^8\\text{ m/s}$$"}
            </p>
          </div>
          <div class="edu-callout edu-callout-warning">
            <i class='bx bx-error-alt' style="font-size: 1.1rem;"></i>
            <div><strong>The Paradox:</strong> ${cleanUnicodeAndSymbols(data.crisis_dilemma?.paradox?.desc || "Classical coordinate transforms break down under relativistic velocities.")}</div>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(1, "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1000&q=80")}" alt="Visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.crisis_dilemma?.visualCaption || "Michelson-Morley Interferometer: Zero fringe shift observed.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 01: Foundations</span></div><span class="slide-index-pill">Slide 03 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 4: Historical Roadmap ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-git-branch'></i> HISTORICAL ROADMAP</span><span class="edu-tag-neutral">UNIT 1.2</span></div>
        <h2 class="slide-title">Chronological Milestones of Discovery</h2>
        <p class="slide-subtitle">Four monographs and experimental breakthroughs that reconstructed the discipline.</p>
      </div>
      <div class="slide-body">
        <div class="edu-timeline">
          ${(data.historical_roadmap || [
            { date: "EPOCH 1", title: "Photoelectric Quantization", formula: "$$E = h\\nu$$", desc: "Energy behaves as localized quanta.", badge: "Quantum Foundation" },
            { date: "EPOCH 2", title: "Statistical Mechanics", formula: "$$\\langle x^2 \\rangle = 2Dt$$", desc: "Definitive physical proof of atomic structures.", badge: "Atomic Validation" },
            { date: "EPOCH 3", title: "Special Invariance", formula: "$$\\Delta t' = \\gamma \\Delta t$$", desc: "Spacetime metric unification.", badge: "Minkowski Metric" },
            { date: "EPOCH 4", title: "Mass-Energy Equivalence", formula: "$$E = mc^2$$", desc: "Inertial mass measures localized thermodynamic energy.", badge: "Energy Baseline" }
          ]).map((st: any) => `
            <div class="timeline-card">
              <span class="timeline-module-tag">${cleanUnicodeAndSymbols(st.date)}</span>
              <h4 style="font-size: 0.92rem; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(st.title)}</h4>
              <div style="font-size: 0.88rem; margin: 2px 0;">${st.formula || ""}</div>
              <p style="font-size: 0.74rem; color: var(--slate-700); line-height: 1.4;">${cleanUnicodeAndSymbols(st.desc)}</p>
              <div class="edu-callout edu-callout-insight" style="margin-top: auto; padding: 4px 8px; font-size: 0.68rem;">${cleanUnicodeAndSymbols(st.badge || "Milestone")}</div>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 01: Foundations</span></div><span class="slide-index-pill">Slide 04 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 5: Axiomatic Postulates ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-list-check'></i> AXIOMATIC METHOD</span><span class="edu-tag-neutral">UNIT 2.1</span></div>
        <h2 class="slide-title">The Fundamental Governing Postulates</h2>
        <p class="slide-subtitle">Two concise axioms from which the complete kinematic framework is derived.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: space-around;">
          <div class="card card-academic">
            <span style="font-size: 0.68rem; font-weight: 800; color: var(--academic-blue);">POSTULATE 1 &bull; COVARIANCE</span>
            <h3 style="font-size: 1.05rem; color: var(--oxford-navy); margin: 3px 0 6px 0;">${cleanUnicodeAndSymbols(data.axiomatic_postulates?.post1?.title || "The Principle of Covariance")}</h3>
            <p style="font-size: 0.82rem; color: var(--slate-700); line-height: 1.55;">${cleanUnicodeAndSymbols(data.axiomatic_postulates?.post1?.desc || "Physical laws remain invariant across all inertial reference frames.")}</p>
          </div>
          <div class="card" style="border-left: 5px solid var(--note-amber); background: #fffdfa;">
            <span style="font-size: 0.68rem; font-weight: 800; color: var(--note-amber);">POSTULATE 2 &bull; INVARIANCE</span>
            <h3 style="font-size: 1.05rem; color: var(--oxford-navy); margin: 3px 0 6px 0;">${cleanUnicodeAndSymbols(data.axiomatic_postulates?.post2?.title || "Universal Constant Limit")}</h3>
            <p style="font-size: 0.82rem; color: var(--slate-700); line-height: 1.55;">
              ${cleanUnicodeAndSymbols(data.axiomatic_postulates?.post2?.desc || "Signal propagation speed is universal and independent of emitter motion.")}
              ${data.axiomatic_postulates?.post2?.formula || "$$\\quad c = 299,792,458\\text{ m/s}$$"}
            </p>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(2, "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1000&q=80")}" alt="Postulate visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.axiomatic_postulates?.visualCaption || "Invariant speed requires dynamic deformation of spatial intervals.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 02: Invariance</span></div><span class="slide-index-pill">Slide 05 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 6: Chart 1 Line Scaling ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-tachometer'></i> KINEMATICS & DATA</span><span class="edu-tag-neutral">UNIT 2.2</span></div>
        <h2 class="slide-title">${cleanUnicodeAndSymbols(data.data_and_kinematics?.title || "Scaling Factors & Lorentz Multipliers")}</h2>
        <p class="slide-subtitle">Analytical progression curves accelerating as critical thresholds are approached.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box">
            <div class="formula-expression">${data.data_and_kinematics?.formula || "$$\\Delta t' = \\gamma \\Delta t = \\frac{\\Delta t}{\\sqrt{1 - \\frac{v^2}{c^2}}}$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.data_and_kinematics?.formulaLabel || "Kinematic Scaling Equation")}</div>
          </div>
          <div class="edu-callout edu-callout-insight">
            <i class='bx bx-info-circle' style="font-size: 1.2rem;"></i>
            <div>${cleanUnicodeAndSymbols(data.data_and_kinematics?.labNote || "Laboratory flux analysis confirms dilated lifetimes at relativistic velocities.")}</div>
          </div>
        </div>
        <img class="chart-img-tall" src="${chart1Url}" alt="Analytical Scaling Line Chart">
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 02: Invariance</span></div><span class="slide-index-pill">Slide 06 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 7: Core Mechanism ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-ruler'></i> GEOMETRY</span><span class="edu-tag-neutral">UNIT 2.3</span></div>
        <h2 class="slide-title">Spatial Compression & Structural Mechanics</h2>
        <p class="slide-subtitle">Dimensions contract along the direction of motion; simultaneity is frame-relative.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box">
            <div class="formula-expression">${data.core_mechanism?.formula || "$$L = \\frac{L_0}{\\gamma} = L_0 \\sqrt{1 - \\frac{v^2}{c^2}}$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.core_mechanism?.formulaLabel || "Coordinate Contraction Metric")}</div>
          </div>
          <div class="edu-callout edu-callout-warning">
            <i class='bx bx-bulb' style="font-size: 1.2rem;"></i>
            <div>${cleanUnicodeAndSymbols(data.core_mechanism?.misconception || "Length contraction is an invariant geometric transformation of coordinates, not an optical artifact.")}</div>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(3, "https://images.unsplash.com/photo-1544620347-c4fd4a3d5957?auto=format&fit=crop&w=1000&q=80")}" alt="Visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.core_mechanism?.visualCaption || "Simultaneity is relative across distant spatial boundaries.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 02: Kinematics</span></div><span class="slide-index-pill">Slide 07 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 8: Master Equations ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-atom'></i> CONSERVATION LAWS</span><span class="edu-tag-neutral">UNIT 2.4</span></div>
        <h2 class="slide-title">Equivalence Principles & Momentum Dispersion</h2>
        <p class="slide-subtitle">Energy and inertia unified within relativistic hyperbolic invariants.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box">
            <div class="formula-expression" style="font-size: 2.1rem;">${data.master_equations?.formula1 || "$$E = mc^2$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.master_equations?.label1 || "Rest Mass Energy Coupling")}</div>
          </div>
          <div class="math-box" style="border-left-color: var(--oxford-navy); margin-top: 6px;">
            <div class="formula-expression" style="font-size: 1.35rem;">${data.master_equations?.formula2 || "$$E^2 = (pc)^2 + (m_0 c^2)^2$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.master_equations?.label2 || "General Momentum Dispersion Metric")}</div>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(4, "https://images.unsplash.com/photo-1532693322450-2cb5c511067d?auto=format&fit=crop&w=1000&q=80")}" alt="Mass Energy">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.master_equations?.visualCaption || "Stellar nucleosynthesis converts pure mass defect into electromagnetic luminosity.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 02: Dynamics</span></div><span class="slide-index-pill">Slide 08 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 9: Boundaries ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-shield-x'></i> THEORETICAL BOUNDARY</span><span class="edu-tag-neutral">UNIT 3.0</span></div>
        <h2 class="slide-title">Theoretical Boundaries & Accelerating Regimes</h2>
        <p class="slide-subtitle">Why flat spacetime models fail when non-inertial fields and gravity are introduced.</p>
      </div>
      <div class="slide-body">
        <div class="grid-3">
          <div class="card card-tint" style="border-top: 4px solid var(--accent-red);">
            <div style="font-size: 1.8rem; color: var(--accent-red); margin-bottom: 6px;"><i class='bx bx-block'></i></div>
            <h4 style="font-size: 0.95rem; margin-bottom: 4px; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point1Title || "Non-Inertial Breakdown")}</h4>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point1Desc || "Flat Minkowski geometry requires constant velocity and breaks in rotational acceleration.")}</p>
            <div class="edu-callout edu-callout-warning" style="margin-top: auto;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point1Callout || "Fails in accelerating frames")}</div>
          </div>
          <div class="card card-tint" style="border-top: 4px solid var(--note-amber);">
            <div style="font-size: 1.8rem; color: var(--note-amber); margin-bottom: 6px;"><i class='bx bx-timer'></i></div>
            <h4 style="font-size: 0.95rem; margin-bottom: 4px; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point2Title || "Causality Constraints")}</h4>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point2Desc || "Instantaneous force action violates the universal cosmic speed limit c.")}</p>
            <div class="edu-callout edu-callout-warning" style="margin-top: auto;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point2Callout || "Violates relativistic causality")}</div>
          </div>
          <div class="card card-tint" style="border-top: 4px solid var(--academic-blue);">
            <div style="font-size: 1.8rem; color: var(--academic-blue); margin-bottom: 6px;"><i class='bx bx-git-merge'></i></div>
            <h4 style="font-size: 0.95rem; margin-bottom: 4px; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point3Title || "Manifold Geometrization")}</h4>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point3Desc || "Differential Riemannian geometry is required to treat gravitation as intrinsic curvature.")}</p>
            <div class="edu-callout edu-callout-insight" style="margin-top: auto;">${cleanUnicodeAndSymbols(data.boundaries_and_limits?.point3Callout || "Leads to curved field equations")}</div>
          </div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 03: Curved Space</span></div><span class="slide-index-pill">Slide 09 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 10: Thought Experiment ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-bulb'></i> THOUGHT EXPERIMENT</span><span class="edu-tag-neutral">UNIT 3.1</span></div>
        <h2 class="slide-title">The Principle of Local Equivalence</h2>
        <p class="slide-subtitle">Inertial and gravitational mass are identically indistinguishable within local boundaries.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="card card-academic" style="margin-bottom: 8px;">
            <h3 style="font-size: 1rem; color: var(--oxford-navy); margin-bottom: 4px;">${cleanUnicodeAndSymbols(data.thought_experiment?.expTitle || "The Free-Fall Paradigm")}</h3>
            <p style="font-size: 0.8rem; color: var(--slate-700); line-height: 1.55;">${cleanUnicodeAndSymbols(data.thought_experiment?.expDesc || "No local experiment can distinguish uniform acceleration from an ambient gravitational field.")}</p>
          </div>
          <div class="math-box">
            <div class="formula-expression">${data.thought_experiment?.formula || "$$m_{\\text{gravitational}} \\equiv m_{\\text{inertial}}$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.thought_experiment?.formulaLabel || "Universal Identity of Mass Terms")}</div>
          </div>
          <div class="edu-callout edu-callout-insight">
            <strong>Key Conclusion:</strong> ${cleanUnicodeAndSymbols(data.thought_experiment?.conclusion || "Gravity is equivalent to uniform acceleration, forcing light trajectories to bend.")}
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(5, "https://images.unsplash.com/photo-1517976487502-861f74810793?auto=format&fit=crop&w=1000&q=80")}" alt="Visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.thought_experiment?.visualCaption || "Accelerated systems demonstrate geometric curvature directly.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 03: Curved Space</span></div><span class="slide-index-pill">Slide 10 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 11: Curvature & Geodesics ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-cube-alt'></i> TOPOLOGY</span><span class="edu-tag-neutral">UNIT 3.2</span></div>
        <h2 class="slide-title">Spacetime Curvature & Geodesic Equations</h2>
        <p class="slide-subtitle">Bodies follow unaccelerated straightest paths along Riemannian 4-manifolds.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="card card-tint" style="border-left: 5px solid var(--academic-blue); padding: 1.3rem;">
            <blockquote style="font-size: 1.15rem; font-weight: 700; color: var(--oxford-navy); line-height: 1.45;">
              "${cleanUnicodeAndSymbols(data.curvature?.quote || "Matter tells spacetime how to curve, and curved spacetime tells matter how to move.")}"
            </blockquote>
            <p style="font-size: 0.8rem; color: var(--academic-blue); font-weight: 700; margin-top: 0.6rem;">
              — ${cleanUnicodeAndSymbols(data.curvature?.quoteAuthor || "John Archibald Wheeler")}
            </p>
          </div>
          <div class="math-box" style="margin-top: 8px;">
            <div class="formula-expression" style="font-size: 1.25rem;">
              ${data.curvature?.formula || "$$\\frac{d^2 x^\\mu}{d\\tau^2} + \\Gamma^\\mu_{\\alpha\\beta} \\frac{dx^\\alpha}{d\\tau}\\frac{dx^\\beta}{d\\tau} = 0$$"}
            </div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.curvature?.formulaLabel || "The Geodesic Motion Equation (\\Gamma: Christoffel Symbols)")}</div>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(6, "https://images.unsplash.com/photo-1462331940025-496dfbfc7564?auto=format&fit=crop&w=1000&q=80")}" alt="Visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.curvature?.visualCaption || "Photons follow null geodesics across warped geometric space.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 03: Curved Space</span></div><span class="slide-index-pill">Slide 11 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 12: Field Equations ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-math'></i> MASTER EQUATION</span><span class="edu-tag-neutral">UNIT 3.3</span></div>
        <h2 class="slide-title">The Field Equations: Coupling Geometry to Energy</h2>
        <p class="slide-subtitle">Ten non-linear coupled partial differential equations governing metric dynamics.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box" style="padding: 1.4rem;">
            <div class="formula-expression" style="font-size: 1.7rem;">
              ${data.fieldEquations?.masterFormula || "$$G_{\\mu\\nu} + \\Lambda g_{\\mu\\nu} = \\frac{8\\pi G}{c^4} T_{\\mu\\nu}$$"}
            </div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.fieldEquations?.masterLabel || "Universal Field Equations")}</div>
          </div>
          <div class="edu-callout edu-callout-insight">
            <div><strong>Newtonian Correspondence Limit:</strong> ${cleanUnicodeAndSymbols(data.fieldEquations?.correspondenceNote || "Weak fields reduce exactly to Poisson's gravitational equation.")}</div>
          </div>
        </div>
        <div class="card" style="font-size: 0.78rem; display: flex; flex-direction: column; justify-content: space-around;">
          <div style="border-bottom: 1px solid var(--slate-200); padding-bottom: 8px;">
            <strong style="color: var(--academic-blue); font-size: 0.85rem;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp1?.title || "Einstein Tensor G_μν")}</strong>
            <p style="color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp1?.desc || "Quantifies geometric curvature of the 4-manifold.")}</p>
          </div>
          <div style="border-bottom: 1px solid var(--slate-200); padding-bottom: 8px;">
            <strong style="color: var(--oxford-navy); font-size: 0.85rem;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp2?.title || "Cosmological Constant Λ")}</strong>
            <p style="color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp2?.desc || "Vacuum energy density parameter driving expansion.")}</p>
          </div>
          <div>
            <strong style="color: var(--accent-red); font-size: 0.85rem;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp3?.title || "Stress-Energy Tensor T_μν")}</strong>
            <p style="color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.fieldEquations?.comp3?.desc || "Complete density and flux of matter, momentum, and pressure.")}</p>
          </div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 03: Field Equations</span></div><span class="slide-index-pill">Slide 12 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 13: Observation & Lensing ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-show'></i> OBSERVATION</span><span class="edu-tag-neutral">UNIT 4.1</span></div>
        <h2 class="slide-title">Astrophysical Observation & Gravitational Lensing</h2>
        <p class="slide-subtitle">Photons curve along geodesics; clocks slow down within gravitational potentials.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: space-between;">
          <div class="card card-academic">
            <h4 style="color: var(--academic-blue); font-size: 0.92rem; margin-bottom: 3px;"><i class='bx bx-time'></i> ${cleanUnicodeAndSymbols(data.observation_phenomena?.phenomenon1?.title || "Gravitational Time Dilation")}</h4>
            <div style="margin: 4px 0;">${data.observation_phenomena?.phenomenon1?.formula || "$$t_f = t_0 \\sqrt{1 - \\frac{2GM}{r c^2}}$$"}</div>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.45;">${cleanUnicodeAndSymbols(data.observation_phenomena?.phenomenon1?.desc || "Clocks deep in gravitational wells tick measurably slower.")}</p>
          </div>
          <div class="card card-tint">
            <h4 style="color: var(--oxford-navy); font-size: 0.92rem; margin-bottom: 3px;"><i class='bx bx-circle-three-quarter'></i> ${cleanUnicodeAndSymbols(data.observation_phenomena?.phenomenon2?.title || "Einstein Rings & Deflection")}</h4>
            <div style="margin: 4px 0;">${data.observation_phenomena?.phenomenon2?.formula || "$$\\theta_E = \\sqrt{\\frac{4GM}{c^2}\\frac{D_{ds}}{D_d D_s}}$$"}</div>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.45;">${cleanUnicodeAndSymbols(data.observation_phenomena?.phenomenon2?.desc || "Massive clusters focus background light into concentric optical arcs.")}</p>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(7, "https://images.unsplash.com/photo-1446776811953-b23d57bd21aa?auto=format&fit=crop&w=1000&q=80")}" alt="Visual">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.observation_phenomena?.visualCaption || "Cosmological gravitational lenses warping background galaxy light.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 04: Empirical Evidence</span></div><span class="slide-index-pill">Slide 13 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 14: Decisive Experiment ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-check-double'></i> EMPIRICAL VALIDATION</span><span class="edu-tag-neutral">UNIT 4.2</span></div>
        <h2 class="slide-title">The Decisive Experiment: Empirical Confirmation</h2>
        <p class="slide-subtitle">Historical verification confirming geometric field predictions over classical approximations.</p>
      </div>
      <div class="slide-body grid-2">
        <div class="tall-visual-box">
          <img src="${getImg(8, "https://images.unsplash.com/photo-1506703719100-a0f3a48c0f86?auto=format&fit=crop&w=1000&q=80")}" alt="Solar Eclipse">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.decisive_experiment?.visualCaption || "Solar eclipse expedition measuring star deflection during totality.")}</div>
        </div>
        <div style="display: flex; flex-direction: column; justify-content: center; gap: 10px;">
          <div class="math-box">
            <div class="formula-expression">${data.decisive_experiment?.formula || "$$\\theta = \\frac{4GM_{\\odot}}{c^2 R_{\\odot}} \\approx 1.75''$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.decisive_experiment?.formulaLabel || "Field Theory Angular Deflection Prediction")}</div>
          </div>
          <div class="card card-tint">
            <h4 style="font-size: 0.88rem; color: var(--oxford-navy); margin-bottom: 4px;">${cleanUnicodeAndSymbols(data.decisive_experiment?.compTitle || "Experimental Verification")}</h4>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.decisive_experiment?.compDesc || "Confirmed relativistic geometric predictions against classical corpuscular limits.")}</p>
          </div>
          <div class="edu-callout edu-callout-verified">
            <i class='bx bx-badge-check' style="font-size: 1.1rem;"></i>
            <div>${cleanUnicodeAndSymbols(data.decisive_experiment?.verifiedQuote || "Definitive empirical validation establishing modern theory.")}</div>
          </div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 04: Empirical Evidence</span></div><span class="slide-index-pill">Slide 14 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 15: Compact Objects ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-radio-circle-marked'></i> COMPACT LIMITS</span><span class="edu-tag-neutral">UNIT 4.3</span></div>
        <h2 class="slide-title">Extreme Boundaries: Exact Metric Solutions</h2>
        <p class="slide-subtitle">Vacuum solutions describing singular points and topological event horizons.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box">
            <div class="formula-expression" style="font-size: 1.9rem;">${data.compact_limits?.formula || "$$r_s = \\frac{2GM}{c^2}$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.compact_limits?.formulaLabel || "The Event Horizon Radius Boundary")}</div>
          </div>
          <div class="grid-2" style="height: auto; gap: 8px; margin-top: 8px;">
            <div class="card card-tint" style="padding: 0.75rem;">
              <strong style="color: var(--academic-blue); font-size: 0.82rem;">${cleanUnicodeAndSymbols(data.compact_limits?.boundary1?.title || "Event Horizon Boundary")}</strong>
              <p style="font-size: 0.74rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.compact_limits?.boundary1?.desc || "Causal threshold where null escape velocity equals c.")}</p>
            </div>
            <div class="card card-tint" style="padding: 0.75rem;">
              <strong style="color: var(--accent-red); font-size: 0.82rem;">${cleanUnicodeAndSymbols(data.compact_limits?.boundary2?.title || "Central Singularity")}</strong>
              <p style="font-size: 0.74rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.compact_limits?.boundary2?.desc || "Point where curvature invariants diverge to infinity.")}</p>
            </div>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(9, "https://images.unsplash.com/photo-1518709268805-4e9042af9f23?auto=format&fit=crop&w=1000&q=80")}" alt="Accretion Disc">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.compact_limits?.visualCaption || "Event Horizon Telescope confirms shadow diameter matching field metric.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 04: Empirical Evidence</span></div><span class="slide-index-pill">Slide 15 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 16: Precision Metrology ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-wifi'></i> METROLOGY</span><span class="edu-tag-neutral">UNIT 4.4</span></div>
        <h2 class="slide-title">Spacetime Strain & Precision Interferometry</h2>
        <p class="slide-subtitle">Quadrupole energy ripples propagating across cosmic distances detected at sub-proton scale.</p>
      </div>
      <div class="slide-body grid-2">
        <div style="display: flex; flex-direction: column; justify-content: center;">
          <div class="math-box">
            <div class="formula-expression">${data.precision_metrology?.formula || "$$h = \\frac{\\Delta L}{L} \\approx 10^{-21}$$"}</div>
            <div class="formula-label">${cleanUnicodeAndSymbols(data.precision_metrology?.formulaLabel || "Interferometer Strain Sensitivity Multiplier")}</div>
          </div>
          <div class="card card-academic" style="margin-top: 8px;">
            <h4 style="font-size: 0.88rem; color: var(--oxford-navy); margin-bottom: 3px;">${cleanUnicodeAndSymbols(data.precision_metrology?.eventTitle || "Coincident Signal Detection")}</h4>
            <p style="font-size: 0.78rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.precision_metrology?.eventDesc || "Binary coalescence releases pure gravitational radiation causing sub-atomic displacements.")}</p>
          </div>
        </div>
        <div class="tall-visual-box">
          <img src="${getImg(10, "https://images.unsplash.com/photo-1507499739999-097706ad8914?auto=format&fit=crop&w=1000&q=80")}" alt="Laser lab">
          <div class="visual-caption-bar">${cleanUnicodeAndSymbols(data.precision_metrology?.visualCaption || "Laser interferometry measures sub-proton mirror displacements.")}</div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 04: Empirical Evidence</span></div><span class="slide-index-pill">Slide 16 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 17: Chart 2 Engineering Application ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-navigation'></i> APPLIED ENGINEERING</span><span class="edu-tag-neutral">UNIT 5.1</span></div>
        <h2 class="slide-title">${cleanUnicodeAndSymbols(data.engineering_application?.title || "Practical Engineering Telemetry & Calibration")}</h2>
        <p class="slide-subtitle">Precision satellite systems require daily relativistic calibration to prevent cumulative drift.</p>
      </div>
      <div class="slide-body grid-2">
        <img class="chart-img-tall" src="${chart2Url}" alt="Engineering Offset Bar Chart">
        <div style="display: flex; flex-direction: column; justify-content: space-around;">
          <div class="card card-tint" style="border-left: 4px solid var(--accent-red); padding: 0.85rem;">
            <strong style="color: var(--accent-red); font-size: 0.82rem;">${cleanUnicodeAndSymbols(data.engineering_application?.point1?.title || "Kinematic Velocity Drag: -7.2 μs/day")}</strong>
            <p style="font-size: 0.75rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.engineering_application?.point1?.desc || "High orbital velocities slow satellite clocks relative to base stations.")}</p>
          </div>
          <div class="card card-tint" style="border-left: 4px solid var(--academic-blue); padding: 0.85rem;">
            <strong style="color: var(--academic-blue); font-size: 0.82rem;">${cleanUnicodeAndSymbols(data.engineering_application?.point2?.title || "Gravitational Potential Lead: +45.8 μs/day")}</strong>
            <p style="font-size: 0.75rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.engineering_application?.point2?.desc || "Weaker gravity at high altitude causes atomic clocks to tick faster.")}</p>
          </div>
          <div class="card card-academic" style="border-left-color: var(--note-green); padding: 0.85rem;">
            <strong style="color: var(--note-green); font-size: 0.84rem;">${cleanUnicodeAndSymbols(data.engineering_application?.point3?.title || "Net Daily Adjustment: +38.6 μs/day")}</strong>
            <p style="font-size: 0.75rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(data.engineering_application?.point3?.desc || "Pre-programmed frequency shifts maintain real-world ground meter precision.")}</p>
          </div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 05: Practical Technology</span></div><span class="slide-index-pill">Slide 17 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 18: Chart 3 Cosmic Energy Budget ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-pie-chart-alt-2'></i> GLOBAL BUDGET</span><span class="edu-tag-neutral">UNIT 5.2</span></div>
        <h2 class="slide-title">${cleanUnicodeAndSymbols(data.cosmologyBudget?.title || "System Composition & Energy Budget")}</h2>
        <p class="slide-subtitle">Total density allocations derived from relativistic Friedmann equations.</p>
      </div>
      <div class="slide-body grid-2">
        <img class="chart-img-tall" src="${chart3Url}" alt="Total Allocation Doughnut Chart">
        <div style="display: flex; flex-direction: column; justify-content: center; gap: 8px;">
          <div class="card card-tint">
            <h4 style="color: var(--academic-blue); font-size: 0.88rem; margin-bottom: 3px;">${cleanUnicodeAndSymbols(data.cosmologyBudget?.note1?.title || "Dominant Cosmic Factor")}</h4>
            <p style="font-size: 0.77rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.cosmologyBudget?.note1?.desc || "Accounts for accelerated cosmic expansion with positive vacuum energy.")}</p>
          </div>
          <div class="card card-tint">
            <h4 style="color: var(--oxford-navy); font-size: 0.88rem; margin-bottom: 3px;">${cleanUnicodeAndSymbols(data.cosmologyBudget?.note2?.title || "Quantum Incompatibility Frontier")}</h4>
            <p style="font-size: 0.77rem; color: var(--slate-700); line-height: 1.5;">${cleanUnicodeAndSymbols(data.cosmologyBudget?.note2?.desc || "Smooth metric spacetime conflicts with quantum discreteness at the Planck scale.")}</p>
          </div>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 05: Modern Horizons</span></div><span class="slide-index-pill">Slide 18 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 19: Synthesis Table ==================== -->
    <div class="slide">
      <div class="lecture-header">
        <div class="meta-tag-row"><span class="edu-badge"><i class='bx bx-table'></i> REFERENCE MATRIX</span><span class="edu-tag-neutral">SYNTHESIS</span></div>
        <h2 class="slide-title">Systematic Synthesis: Dimensional Reference Matrix</h2>
        <p class="slide-subtitle">Side-by-side academic reference comparison across core theoretical dimensions.</p>
      </div>
      <div class="slide-body">
        <div class="card" style="width: 100%; padding: 0; overflow: hidden;">
          <table class="lecture-table">
            <thead>
              <tr>
                ${(data.synthesisTable?.dimensionHeaders || ["Physical Dimension", "Special Theory (1905)", "General Theory (1915)"]).map((h: string) => `
                  <th>${cleanUnicodeAndSymbols(h)}</th>
                `).join("")}
              </tr>
            </thead>
            <tbody>
              ${(data.synthesisTable?.rows || [
                ["Geometric Manifold", "Flat 4D Minkowski Spacetime", "Curved Pseudo-Riemannian Manifold"],
                ["Coordinate Scope", "Inertial frames related by Lorentz boosts", "General coordinate covariance"],
                ["Physical Gravity", "Neglected; flat vacuum background", "Direct consequence of metric curvature"],
                ["Primary Governing Laws", "Lorentz Invariance: x' = Λx", "Field Equations: G_μν = κ T_μν"],
                ["Empirical Proofs", "Muon lifetime dilation, E=mc²", "Starlight deflection, GPS drift, LIGO waves"]
              ]).map((r: string[]) => `
                <tr>
                  <td><strong>${cleanUnicodeAndSymbols(r[0] || "")}</strong></td>
                  <td>${cleanUnicodeAndSymbols(r[1] || "")}</td>
                  <td>${cleanUnicodeAndSymbols(r[2] || "")}</td>
                </tr>
              `).join("")}
            </tbody>
          </table>
        </div>
      </div>
      <div class="lecture-footer"><div class="footer-left"><span>${courseCode}</span><span>Unit 06: Synthesis</span></div><span class="slide-index-pill">Slide 19 / 20</span></div>
    </div>

    <!-- ==================== SLIDE 20: Outro & Takeaways ==================== -->
    <div class="slide" style="padding: 0;">
      <div style="display: flex; height: 100%;">
        <div style="flex: 1.18; padding: 3.4rem 3.6rem; display: flex; flex-direction: column; justify-content: space-between; background: #ffffff;">
          <div>
            <div class="meta-tag-row">
              <span class="edu-badge"><i class='bx bx-check-double'></i> LECTURE COMPLETE</span>
              <span class="edu-tag-neutral" style="color: var(--note-green); font-weight: 700;">SUMMARY & EXAM REVIEW</span>
            </div>
            <h2 style="font-size: 2.1rem; font-weight: 800; color: var(--oxford-navy); line-height: 1.15; margin: 0.4rem 0 0.8rem 0;">
              ${cleanUnicodeAndSymbols(data.summary_takeaways?.title || "Executive Lecture Takeaways")}
            </h2>

            <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 1.1rem;">
              ${[
                data.summary_takeaways?.pillar1 || { title: "CONSTANCY OF LIGHT", desc: "c is universal; time intervals and lengths transform via gamma." },
                data.summary_takeaways?.pillar2 || { title: "MASS-ENERGY EQUIVALENCE", desc: "E=mc² establishes that mass is condensed thermodynamic energy." },
                data.summary_takeaways?.pillar3 || { title: "GEOMETRIC CURVATURE", desc: "Gravity is non-Newtonian geometry: bodies follow straight geodesics." },
                data.summary_takeaways?.pillar4 || { title: "PRECISION EMPIRICISM", desc: "Validated by solar eclipse, GPS drift, and interferometer strain." }
              ].map((p: any, i: number) => `
                <div class="card card-tint" style="padding: 0.8rem; border-left: 3px solid ${i === 0 ? "var(--academic-blue)" : i === 1 ? "#0284c7" : i === 2 ? "#6366f1" : "var(--note-green)"};">
                  <div style="font-size: 0.68rem; font-weight: 800; color: var(--academic-blue);">${cleanUnicodeAndSymbols(p.title)}</div>
                  <p style="font-size: 0.74rem; color: var(--slate-700); margin-top: 2px;">${cleanUnicodeAndSymbols(p.desc)}</p>
                </div>
              `).join("")}
            </div>

            <div style="background: var(--blue-subtle); border: 1px solid var(--border-blue); border-radius: 6px; padding: 10px 14px;">
              <div style="font-size: 0.72rem; font-weight: 700; color: var(--academic-blue); text-transform: uppercase;">Assigned Reading & Exercises</div>
              <p style="font-size: 0.78rem; color: var(--oxford-navy); margin-top: 2px;">
                ${cleanUnicodeAndSymbols(data.summary_takeaways?.assignedReading || "Review assigned monographs and complete Problem Set 4.")}
              </p>
            </div>
          </div>

          <div style="border-top: 1px solid var(--slate-200); padding-top: 0.85rem; display: flex; justify-content: space-between; align-items: center;">
            <div>
              <div style="font-size: 0.78rem; font-weight: 700; color: var(--oxford-navy);">${cleanUnicodeAndSymbols(data.summary_takeaways?.officeHours || "Office Hours: Tu/Th 14:00–16:00")}</div>
              <div style="font-size: 0.7rem; color: var(--slate-400);">${courseCode} &bull; Final Lecture Summary</div>
            </div>
          </div>
        </div>

        <div style="flex: 0.82; position: relative; overflow: hidden; background: #060b18;">
          <img src="${getImg(11, "https://images.unsplash.com/photo-1451187580459-43490279c0fa?auto=format&fit=crop&w=1200&q=80")}" alt="Outro" style="width: 100%; height: 100%; object-fit: cover;">
          <div style="position: absolute; inset: 0; background: linear-gradient(180deg, rgba(6,11,24,0.2) 0%, rgba(6,11,24,0.8) 100%);"></div>
          <div style="position: absolute; bottom: 20px; left: 20px; right: 20px; color: #fff; background: rgba(11,21,40,0.85); backdrop-filter: blur(8px); padding: 12px 14px; border-radius: 6px; font-size: 0.72rem; border: 1px solid rgba(255,255,255,0.15);">
            <strong style="color: var(--columbia-blue); display: block; margin-bottom: 2px;">Examination Reminder:</strong>
            ${cleanUnicodeAndSymbols(data.summary_takeaways?.examNotice || "Midterm examinations begin next month covering tensor notation, Christoffel symbols, and Doppler shifts.")}
          </div>
        </div>
      </div>
    </div>

  </div>

  <script>
    const slides = document.querySelectorAll('.slide');
    const totalSlides = slides.length;
    let currentIndex = 0;
    const progressRibbon = document.getElementById('progressRibbon');

    function renderSlide() {
      slides.forEach((slide, idx) => {
        slide.classList.toggle('active', idx === currentIndex);
      });
      if (progressRibbon) {
        const progressPercent = ((currentIndex + 1) / totalSlides) * 100;
        progressRibbon.style.width = progressPercent + '%';
      }
    }

    function nextSlide() {
      if (currentIndex < totalSlides - 1) {
        currentIndex++;
        renderSlide();
      }
    }

    function prevSlide() {
      if (currentIndex > 0) {
        currentIndex--;
        renderSlide();
      }
    }

    function goToSlide(index) {
      if (index >= 0 && index < totalSlides) {
        currentIndex = index;
        renderSlide();
      }
    }

    window.addEventListener('keydown', (e) => {
      switch (e.key) {
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
          e.preventDefault();
          ${isRTL ? "prevSlide();" : "nextSlide();"}
          break;
        case 'ArrowLeft':
        case 'PageUp':
          e.preventDefault();
          ${isRTL ? "nextSlide();" : "prevSlide();"}
          break;
        case 'Home':
          e.preventDefault();
          goToSlide(0);
          break;
        case 'End':
          e.preventDefault();
          goToSlide(totalSlides - 1);
          break;
      }
    });

    renderSlide();
  </script>
</body>
</html>`;
}

// ─────────────────────────────────────────────────────────
// 3. EDITABLE POWERPOINT EXPORT (20 SLIDES VIA PPTXGENJS)
// ─────────────────────────────────────────────────────────
async function exportToPPTX(data: any, lang: string, outputPath: string) {
  const pptx = new (PptxGenJS as any)();
  pptx.layout = "LAYOUT_16x9";
  pptx.author = "AstroMind A1";
  pptx.title = data?.mainTitle || data?.topic || "Academic Presentation";

  const isRTL = lang === "ar";
  const courseCode = data?.courseCode || "ACAD 401";

  // Slide 1: Cover
  const s1 = pptx.addSlide();
  s1.background = { color: "FFFFFF" };
  s1.addText(`${courseCode} • ${cleanUnicodeAndSymbols(data?.mainTitle || "Academic Lecture")}`, {
    x: 0.8, y: 1.5, w: 11.5, h: 1.2, fontSize: 34, bold: true, color: "0B1528", align: isRTL ? "right" : "left"
  });
  s1.addText(cleanUnicodeAndSymbols(data?.subtitle || "University Lecture Series"), {
    x: 0.8, y: 2.9, w: 11.5, h: 0.8, fontSize: 18, color: "64748B", align: isRTL ? "right" : "left"
  });

  // Slide 2: Syllabus
  const s2 = pptx.addSlide();
  s2.background = { color: "F8FAFC" };
  s2.addText("Course Modules & Syllabus", { x: 0.8, y: 0.6, w: 11, h: 0.6, fontSize: 24, bold: true, color: "0B1528" });

  const units = data?.syllabusUnits || [];
  for (let i = 0; i < Math.min(4, units.length); i++) {
    const px = 0.8 + i * 2.9;
    s2.addShape(pptx.shapes.RECTANGLE, { x: px, y: 1.8, w: 2.7, h: 4.5, fill: { color: "FFFFFF" }, line: { color: "E2E8F0" } });
    s2.addText(cleanUnicodeAndSymbols(units[i]?.title), { x: px + 0.2, y: 2.2, w: 2.3, h: 0.8, fontSize: 16, bold: true, color: "1D4ED8" });
    s2.addText(cleanUnicodeAndSymbols(units[i]?.desc), { x: px + 0.2, y: 3.2, w: 2.3, h: 2.5, fontSize: 12, color: "334155" });
  }

  // Slide 19: Synthesis Table
  const s19 = pptx.addSlide();
  s19.background = { color: "FFFFFF" };
  s19.addText("Synthesis Reference Matrix", { x: 0.8, y: 0.6, w: 11, h: 0.6, fontSize: 24, bold: true, color: "0B1528" });
  const headers = data?.synthesisTable?.dimensionHeaders || ["Dimension", "Classical", "Modern"];
  const rows = data?.synthesisTable?.rows || [];
  const tableData = [
    headers.map((h: string) => ({ text: cleanUnicodeAndSymbols(h), options: { bold: true, color: "FFFFFF", fill: "0B1528" } })),
    ...rows.slice(0, 5).map((r: string[]) => r.map((c: string) => ({ text: cleanUnicodeAndSymbols(c), options: { color: "0B1528", fill: "FFFFFF" } })))
  ];
  s19.addTable(tableData, { x: 0.8, y: 1.6, w: 11.6, colW: [3.8, 3.9, 3.9], fontSize: 12, border: { type: "solid", pt: 1, color: "CBD5E1" } });

  // Slide 20: Summary
  const s20 = pptx.addSlide();
  s20.background = { color: "F8FAFC" };
  s20.addText("Executive Lecture Summary Takeaways", { x: 0.8, y: 0.6, w: 11, h: 0.6, fontSize: 24, bold: true, color: "0B1528" });
  s20.addText(cleanUnicodeAndSymbols(data?.summary_takeaways?.assignedReading || "Review assigned problem sets and reading."), {
    x: 0.8, y: 2.0, w: 11, h: 1.5, fontSize: 16, color: "334155"
  });

  await pptx.writeFile({ fileName: outputPath });
}

// ─────────────────────────────────────────────────────────
// 4. MAIN ASTROSLIDES PIPELINE
// ─────────────────────────────────────────────────────────
export async function runAstroSlides(params: {
  prompt: string;
  language?: string;
}): Promise<{ htmlPath: string; pptxPath: string; jsonPath: string; deckId: string; version: number; totalSlides: number }> {
  const topic = params.prompt.trim();
  const lang = params.language || "en";
  const { baseDir, htmlDir, jsonDir } = await ensureDirectories();

  const deckId = topic.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24) || `deck_${Date.now()}`;
  activeDeckId = deckId;

  // 1. Generate Academic Data via Gemini 2.0 Flash / Groq
  const lectureData = await generateLectureData(topic, lang);
  lectureData.topic = topic;

  // 2. Query AstroSearch for Grounded Real Images
  const searchImages = await runAstroImageSearch(topic);
  const imgUrls = searchImages.map((img) => img.imageUrl).filter(Boolean);

  const jsonPath = path.join(jsonDir, `${deckId}_v1.json`);
  const htmlPath = path.join(htmlDir, `${deckId}_v1.html`);
  const pptxPath = path.join(baseDir, `${deckId}_v1.pptx`);

  // 3. Compile HTML & PPTX
  await fsp.writeFile(jsonPath, JSON.stringify(lectureData, null, 2), "utf-8");
  const htmlContent = buildLectureHTML(lectureData, lang, imgUrls);
  await fsp.writeFile(htmlPath, htmlContent, "utf-8");

  await exportToPPTX(lectureData, lang, pptxPath);

  return {
    htmlPath,
    pptxPath,
    jsonPath,
    deckId,
    version: 1,
    totalSlides: 20
  };
}

// ─────────────────────────────────────────────────────────
// 5. CONVERSATIONAL EDITING
// ─────────────────────────────────────────────────────────
export async function editAstroSlides(params: {
  instruction: string;
  targetDeckId?: string;
}): Promise<{ htmlPath: string; pptxPath: string; jsonPath: string; deckId: string; version: number; totalSlides: number }> {
  const { baseDir, htmlDir, jsonDir } = await ensureDirectories();
  const deckId = params.targetDeckId || activeDeckId;

  if (!deckId) {
    throw new Error("No active lecture presentation found in this session to edit.");
  }

  const files = await fsp.readdir(jsonDir);
  const versions = files
    .filter((f) => f.startsWith(`${deckId}_v`) && f.endsWith(".json"))
    .map((f) => {
      const match = f.match(/_v(\d+)\.json$/);
      return match ? parseInt(match[1]) : 1;
    })
    .sort((a, b) => b - a);

  const currentVersion = versions[0] || 1;
  const nextVersion = currentVersion + 1;

  const currentJsonPath = path.join(jsonDir, `${deckId}_v${currentVersion}.json`);
  const rawState = await fsp.readFile(currentJsonPath, "utf-8");
  const currentState = JSON.parse(rawState);

  const prompt = `
You are the Academic Lecture Refactoring Engine for AstroMind A1.
Modification Instruction: "${params.instruction}"

Current State:
${JSON.stringify(currentState, null, 2)}

TASK: Apply changes accurately. Preserve LaTeX mathematical notation, formulas, and all 20 slides.
Return the updated valid JSON.
`;

  const geminiRes = await gemini.models.generateContent({
    model: GEMINI_MODELS.FLASH,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  const updatedData = JSON.parse(geminiRes.text || "{}");

  const searchImages = await runAstroImageSearch(currentState.topic || "Physics");
  const imgUrls = searchImages.map((img) => img.imageUrl).filter(Boolean);

  const nextJsonPath = path.join(jsonDir, `${deckId}_v${nextVersion}.json`);
  const nextHtmlPath = path.join(htmlDir, `${deckId}_v${nextVersion}.html`);
  const nextPptxPath = path.join(baseDir, `${deckId}_v${nextVersion}.pptx`);

  await fsp.writeFile(nextJsonPath, JSON.stringify(updatedData, null, 2), "utf-8");
  const html = buildLectureHTML(updatedData, updatedData.language || "en", imgUrls);
  await fsp.writeFile(nextHtmlPath, html, "utf-8");

  await exportToPPTX(updatedData, updatedData.language || "en", nextPptxPath);

  return {
    htmlPath: nextHtmlPath,
    pptxPath: nextPptxPath,
    jsonPath: nextJsonPath,
    deckId,
    version: nextVersion,
    totalSlides: 20
  };
}

export function getActiveDeckId(): string | null {
  return activeDeckId;
}