import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { gemini, GEMINI_MODELS } from "../services/gemini.js";
import { groq, GROQ_MODELS } from "../services/groq.js";
import { runAstroImageSearch } from "./astroSearch.js";
import { EdgeTTS } from "node-edge-tts";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import puppeteer from "puppeteer";
import { PuppeteerScreenRecorder } from "puppeteer-screen-recorder";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import ffprobeStatic from "ffprobe-static";

const resolvedFfmpeg = typeof ffmpegStatic === "string" ? ffmpegStatic : ((ffmpegStatic as any)?.path || (ffmpegStatic as any)?.default);
const resolvedFfprobe = typeof ffprobeStatic === "string" ? ffprobeStatic : ((ffprobeStatic as any)?.path || (ffprobeStatic as any)?.default);

if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);
if (resolvedFfprobe) ffmpeg.setFfprobePath(resolvedFfprobe);

const TARGET_MIN_SECONDS = 180;
const TARGET_MAX_SECONDS = 210;
const TARGET_TOTAL_SECONDS = 195;

const VIDEO_WIDTH = 1280;
const VIDEO_HEIGHT = 706; // Even height required by H.264 (yuv420p)
const FPS = 30;

const SUPPORTED_LANGUAGES: Record<string, any> = {
  en: { code: "en", name: "English", voice: "en-US-ChristopherNeural", dir: "ltr", font: "'Nunito', sans-serif" },
  ar: { code: "ar", name: "Arabic", voice: "ar-EG-ShakirNeural", dir: "rtl", font: "'Cairo', 'Tajawal', sans-serif" },
  fr: { code: "fr", name: "French", voice: "fr-FR-HenriNeural", dir: "ltr", font: "'Nunito', sans-serif" },
  de: { code: "de", name: "German", voice: "de-DE-ConradNeural", dir: "ltr", font: "'Nunito', sans-serif" }
};

export type ProgressCallback = (percent: number, message: string) => void;

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

function getAudioDuration(filePath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    ffmpeg.ffprobe(filePath, (err, metadata) => {
      if (err) return reject(err);
      const duration = metadata?.format?.duration;
      resolve(typeof duration === "number" ? duration : parseFloat(duration || "13.0"));
    });
  });
}

function padAudioWithSilence(inputPath: string, outputPath: string, padSeconds: number): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(`apad=pad_dur=${Math.max(0.1, padSeconds).toFixed(3)}`)
      .outputOptions(["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

function applyTempo(inputPath: string, outputPath: string, tempo: number): Promise<void> {
  const filters: string[] = [];
  let t = tempo;
  while (t > 2.0) { filters.push("atempo=2.0"); t /= 2.0; }
  while (t < 0.5) { filters.push("atempo=0.5"); t /= 0.5; }
  filters.push(`atempo=${Math.max(0.5, Math.min(2.0, t)).toFixed(4)}`);

  return new Promise((resolve, reject) => {
    ffmpeg(inputPath)
      .audioFilters(filters.join(","))
      .outputOptions(["-c:a", "libmp3lame", "-b:a", "192k", "-ar", "44100"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

// Seamless Master Audio Assembler: Re-indexes timestamps to ensure drift-free sync
function concatenateAudioFiles(audioFilePaths: string[], outputPath: string, tempDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const validFiles = audioFilePaths.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 500);

    if (validFiles.length === 0) {
      return reject(new Error("No valid audio files generated to concatenate"));
    }

    const manifestPath = path.join(tempDir, "audio_concat_manifest.txt");
    const manifestLines = validFiles.map((f) => `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(manifestPath, manifestLines.join("\n"), "utf-8");

    ffmpeg()
      .input(manifestPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-ar", "44100",
        "-id3v2_version", "3",
        "-write_xing", "1"
      ])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => {
        // Fallback: Buffer join
        try {
          const buffers: Buffer[] = [];
          for (const vf of validFiles) {
            buffers.push(fs.readFileSync(vf));
          }
          fs.writeFileSync(outputPath, Buffer.concat(buffers));
          resolve();
        } catch (fallbackErr) {
          reject(err);
        }
      });
  });
}

// Strict Dual-Stream Multiplexing: Guarantees audio is mapped, synced, and universally playable
function multiplexVideoAndAudio(videoPath: string, audioPath: string, outputPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    ffmpeg()
      .input(videoPath)
      .input(audioPath)
      .outputOptions([
        "-map", "0:v:0",                  // 1. Explicitly select the video stream from screen recording
        "-map", "1:a:0",                  // 2. Explicitly bind the audio stream from master soundtrack
        "-c:v", "libx264",                // 3. Encode video to standard H.264
        "-preset", "fast",
        "-crf", "18",
        "-r", "30",
        "-pix_fmt", "yuv420p",
        "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2", // Even-dimension safeguard
        "-c:a", "aac",                    // 4. Encode audio to high-definition AAC
        "-b:a", "192k",
        "-ar", "44100",                   // Standard 44.1kHz broadcast sample rate
        "-ac", "2",                       // Clean stereo sound
        "-movflags", "+faststart"         // Moves moov index to the front for instant streaming/playback
      ])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => reject(err));
  });
}

async function synthesizeSpeech(
  text: string,
  outputPath: string,
  voice: string,
  langCode: string
): Promise<void> {
  const cleanText = text.replace(/[<>&'"]/g, " ").trim() || "Continuing to the next key principle.";

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const tts = new EdgeTTS({
        voice,
        lang: langCode,
        outputFormat: "audio-24khz-48kbitrate-mono-mp3"
      });
      await Promise.race([
        tts.ttsPromise(cleanText, outputPath),
        new Promise((_, reject) => setTimeout(() => reject(new Error("Timeout")), 10000))
      ]);
      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
        return;
      }
    } catch {}

    try {
      const tts2 = new MsEdgeTTS();
      await tts2.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
      const streamRes = tts2.toStream(cleanText);
      const audioStream = (streamRes as any)?.audioStream || streamRes;
      const writeStream = fs.createWriteStream(outputPath);

      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          writeStream.destroy();
          reject(new Error("Timeout"));
        }, 10000);

        audioStream.pipe(writeStream);
        writeStream.on("finish", () => {
          clearTimeout(timeout);
          resolve();
        });
        writeStream.on("error", (err: any) => {
          clearTimeout(timeout);
          reject(err);
        });
        audioStream.on("error", (err: any) => {
          clearTimeout(timeout);
          reject(err);
        });
      });

      if (fs.existsSync(outputPath) && fs.statSync(outputPath).size > 500) {
        return;
      }
    } catch {
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }

  // Fail-Safe Generator
  await new Promise<void>((resolve, reject) => {
    ffmpeg()
      .input("anullsrc=r=44100:cl=mono")
      .inputOptions(["-f", "lavfi"])
      .outputOptions(["-t", "10", "-c:a", "libmp3lame", "-b:a", "192k"])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", reject);
  });
}

async function generateSlideDeck(topic: string, lang: any, onProgress?: ProgressCallback): Promise<any> {
  onProgress?.(10, `Designing 15-Slide Presentation in ${lang.name}...`);

  const systemPrompt = `You are an elite educational keynote architect.
Generate a structured, mathematically accurate 15-SLIDE presentation about: "${topic}".
Language strictly: ${lang.name.toUpperCase()} (${lang.code}).
- Numbers rule: ALWAYS use Western Latin numerals (1, 2, 3, 4, 5, 6, 7, 8, 9, 0).
- Grounding: Ensure all numbers represent realistic statistics for "${topic}".
- Cover Hero Image: The first slide must use "https://i.ibb.co/cSpXgSry/hero.png" (500x500px).
- Slide 15: Must provide a REAL historical quote, the real author, and the exact event/year delivered.
- Exactly 15 slides. Each narration between 32 and 40 spoken words in ${lang.name}.

Return STRICT JSON schema matching this structure:
{
  "topic": "${topic}",
  "shortTitle": "4-word title",
  "slides": [
    { "slideNumber": 1, "type": "cover", "mainTitle": "...", "subtitle": "...", "pill1": "...", "pill2": "...", "pill3": "...", "narration": "..." },
    { "slideNumber": 2, "type": "pillars_grid", "tag": "MODULE 01", "heading": "...", "pillars": [{"num":"01","icon":"bx-cube","title":"...","desc":"...","keyMetric":"..."}], "narration": "..." },
    { "slideNumber": 3, "type": "comparison_table", "tag": "MODULE 02", "heading": "...", "tableHeaders":["..."],"tableRows":[["..."]], "narration": "..." },
    { "slideNumber": 4, "type": "image_cards", "tag": "MODULE 03", "heading": "...", "cards":[{"badge":"...","title":"...","description":"...","spec1":"...","spec2":"..."}], "narration": "..." },
    { "slideNumber": 5, "type": "bar_chart", "tag": "MODULE 04", "heading": "...", "chartTitle":"...","takeaways":["..."],"metaCallout":"...", "narration": "..." },
    { "slideNumber": 6, "type": "deep_dive", "tag": "MODULE 05", "heading": "...", "card1Title":"...","card1Desc":"...","card1Pills":["..."],"card2Title":"...","card2Desc":"...","card2Pills":["..."], "narration": "..." },
    { "slideNumber": 7, "type": "timeline", "tag": "MODULE 06", "heading": "...", "timelineSteps":[{"step":"PHASE 01","title":"...","desc":"...","metaSpec":"...","icon":"bx-data"}], "narration": "..." },
    { "slideNumber": 8, "type": "doughnut_chart", "tag": "MODULE 07", "heading": "...", "chartTitle":"...","insights":[{"title":"...","desc":"..."}],"metaCallout":"...", "narration": "..." },
    { "slideNumber": 9, "type": "big_stat", "tag": "MODULE 08", "heading": "...", "statNumber":"98.6%","statLabel":"...","description":"...","supportingPoints":[{"title":"...","desc":"...","icon":"bx-check-shield"}], "narration": "..." },
    { "slideNumber": 10, "type": "line_chart", "tag": "MODULE 09", "heading": "...", "chartTitle":"...","takeaways":["..."],"metaCallout":"...", "narration": "..." },
    { "slideNumber": 11, "type": "mindmap", "tag": "MODULE 10", "heading": "...", "centerNode":"...","centerSubtitle":"...","branches":[{"num":"VECTOR 01","icon":"bx-list-check","title":"...","detail":"...","submeta":"..."}], "narration": "..." },
    { "slideNumber": 12, "type": "case_study", "tag": "MODULE 11", "heading": "...", "metricTag":"...","casePill":"...","caseTitle":"...","caseSummary":"...","stat1Val":"...","stat1Lbl":"...","stat2Val":"...","stat2Lbl":"...","stat3Val":"...","stat3Lbl":"...", "narration": "..." },
    { "slideNumber": 13, "type": "tradeoffs_matrix", "tag": "MODULE 12", "heading": "...", "strengthsTitle":"...","strengths":["..."],"challengesTitle":"...","challenges":["..."], "narration": "..." },
    { "slideNumber": 14, "type": "checklist_framework", "tag": "MODULE 13", "heading": "...", "checklist":[{"phase":"GATE 01","task":"...","desc":"...","deliverable":"..."}], "narration": "..." },
    { "slideNumber": 15, "type": "quote_summary", "tag": "MODULE 14", "heading": "...", "quote":"...","quoteAuthor":"...","authorTitle":"Event & Year delivered","card1Title":"...","card1Desc":"...","card2Title":"...","card2Desc":"...","callout":"...", "narration": "..." }
  ]
}`;

  try {
    const geminiRes = await gemini.models.generateContent({
      model: GEMINI_MODELS.FLASH,
      contents: systemPrompt,
      config: { responseMimeType: "application/json" }
    });
    const parsed = JSON.parse(geminiRes.text || "{}");
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return parsed;
    }
  } catch {}

  try {
    const groqRes = await groq.chat.completions.create({
      model: GROQ_MODELS.ROUTER,
      messages: [{ role: "user", content: systemPrompt }],
      response_format: { type: "json_object" },
      temperature: 0.25
    });
    return JSON.parse(groqRes.choices[0]?.message?.content || "{}");
  } catch {
    const fallbackRes = await groq.chat.completions.create({
      model: GROQ_MODELS.FALLBACK,
      messages: [{ role: "user", content: systemPrompt }],
      response_format: { type: "json_object" },
      temperature: 0.25
    });
    return JSON.parse(fallbackRes.choices[0]?.message?.content || "{}");
  }
}

export async function runAstroVeo(
  params: { prompt: string; language?: string },
  onProgress?: ProgressCallback
): Promise<{ videoPath: string; htmlPath: string; durationFormatted: string; slidesCount: number }> {
  const topic = params.prompt.trim();
  const langKey = (params.language || "en").toLowerCase();
  const lang = SUPPORTED_LANGUAGES[langKey] || SUPPORTED_LANGUAGES.en;

  const baseVideosDir = path.join(process.cwd(), "storage", "videos");
  const tempDir = path.join(baseVideosDir, `.temp_veo_${Date.now()}`);
  await fsp.mkdir(baseVideosDir, { recursive: true });
  await fsp.mkdir(tempDir, { recursive: true });

  const safeTopic = topic.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 24) || "video";
  const finalVideoPath = path.join(baseVideosDir, `${safeTopic}_${Date.now()}.mp4`);
  const finalHtmlPath = path.join(tempDir, "presentation.html");

  // Step 1: Slide Deck Blueprint
  const presentationData = await generateSlideDeck(topic, lang, onProgress);

  // Step 2: Grounded Images via AstroSearch
  onProgress?.(30, "Gathering verified imagery via AstroSearch...");
  const searchImages = await runAstroImageSearch(topic);
  const imgUrls = searchImages.map((img) => img.imageUrl).filter(Boolean);

  const slides = presentationData.slides || [];
  slides.forEach((s: any, idx: number) => {
    const fallback = `https://images.unsplash.com/photo-${1518770660439 + idx * 1000}?w=800&q=80`;
    if (s.type === "image_cards" && Array.isArray(s.cards)) {
      s.cards.forEach((c: any, cIdx: number) => {
        c.imageLocalUrl = imgUrls[(idx + cIdx) % imgUrls.length] || fallback;
      });
    }
    if (s.type === "deep_dive") {
      s.image1LocalUrl = imgUrls[(idx + 1) % imgUrls.length] || fallback;
      s.image2LocalUrl = imgUrls[(idx + 2) % imgUrls.length] || fallback;
    }
    if (s.type === "case_study") s.caseImageLocalUrl = imgUrls[(idx + 3) % imgUrls.length] || fallback;
    if (s.type === "tradeoffs_matrix") {
      s.strengthsImageLocalUrl = imgUrls[(idx + 4) % imgUrls.length] || fallback;
      s.challengesImageLocalUrl = imgUrls[(idx + 5) % imgUrls.length] || fallback;
    }
  });

  // Step 3: Resilient Audio Synthesis & Calibration
  onProgress?.(45, `Synthesizing Audio via Edge Neural TTS (${lang.voice})...`);
  const N = slides.length;
  const rawPaths: string[] = [];
  const rawDurations: number[] = [];

  for (let i = 0; i < N; i++) {
    const rawFile = path.join(tempDir, `slide_${i}_raw.mp3`);
    await synthesizeSpeech(slides[i].narration || "Next key insight.", rawFile, lang.voice, lang.code);
    const dur = await getAudioDuration(rawFile);
    rawDurations.push(dur);
    rawPaths.push(rawFile);
    onProgress?.(45 + Math.round(((i + 1) / N) * 15), `Synthesized Audio Track ${i + 1}/${N}...`);
  }

  const rawTotal = rawDurations.reduce((a, b) => a + b, 0);
  let speechFactor = 1.0;
  if (rawTotal > TARGET_TOTAL_SECONDS - N * 0.6) {
    speechFactor = Math.min(1.3, Math.max(0.75, rawTotal / (TARGET_TOTAL_SECONDS - N * 0.8)));
  } else if (rawTotal < TARGET_MIN_SECONDS - N * 2.5) {
    speechFactor = Math.max(0.85, rawTotal / (TARGET_MIN_SECONDS - N * 1.5));
  }

  let effectiveSpokenTotal = 0;
  const tempoPaths: Array<{ path: string; duration: number }> = [];

  for (let i = 0; i < N; i++) {
    const tempoFile = path.join(tempDir, `slide_${i}_tempo.mp3`);
    if (Math.abs(speechFactor - 1.0) > 0.03) {
      await applyTempo(rawPaths[i], tempoFile, speechFactor);
    } else {
      await fsp.copyFile(rawPaths[i], tempoFile);
    }
    const dur = await getAudioDuration(tempoFile);
    effectiveSpokenTotal += dur;
    tempoPaths.push({ path: tempoFile, duration: dur });
  }

  const totalPauseBudget = Math.max(N * 0.6, TARGET_TOTAL_SECONDS - effectiveSpokenTotal);
  const pausePerSlide = totalPauseBudget / N;
  const finalAudioPaths: string[] = [];

  for (let i = 0; i < N; i++) {
    const paddedFile = path.join(tempDir, `slide_${i}_padded.mp3`);
    await padAudioWithSilence(tempoPaths[i].path, paddedFile, pausePerSlide);
    const finalSlideDur = await getAudioDuration(paddedFile);
    slides[i].durationMs = Math.round(finalSlideDur * 1000);
    finalAudioPaths.push(paddedFile);
  }

  // Concatenate master soundtrack with valid sample rate and timestamps
  const masterAudioPath = path.join(tempDir, "master_audio.mp3");
  await concatenateAudioFiles(finalAudioPaths, masterAudioPath, tempDir);

  // Step 4: HTML Render with the 1280x705 Presentation UI
  onProgress?.(68, "Compiling 1280x705 Keynote Deck HTML...");
  const htmlContent = buildPresentationHTML(presentationData, lang);
  await fsp.writeFile(finalHtmlPath, htmlContent, "utf-8");

  // Step 5: Screen Recording with Zero-Drift Absolute Master Clock
  onProgress?.(75, "Recording 30-FPS Masterclass Presentation...");
  const rawVideoPath = path.join(tempDir, "raw_video.mp4");

  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
      `--window-size=${VIDEO_WIDTH},${VIDEO_HEIGHT}`
    ],
    defaultViewport: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT, deviceScaleFactor: 1 }
  });

  const page = await browser.newPage();
  await page.setViewport({ width: VIDEO_WIDTH, height: VIDEO_HEIGHT });
  await page.goto(pathToFileURL(finalHtmlPath).href, { waitUntil: "networkidle2", timeout: 90000 });

  const recorder = new PuppeteerScreenRecorder(page, {
    fps: FPS,
    ffmpeg_Path: resolvedFfmpeg || undefined,
    videoFrame: { width: VIDEO_WIDTH, height: VIDEO_HEIGHT },
    aspectRatio: "16:9"
  });

  await recorder.start(rawVideoPath);

  // Absolute Clock Timeline: Prevents slide desync with audio
  const recordingStartTime = Date.now();
  let accumulatedTargetMs = 0;

  for (let i = 0; i < slides.length; i++) {
    accumulatedTargetMs += slides[i].durationMs;
    onProgress?.(76 + Math.round(((i + 1) / slides.length) * 18), `Recording Slide ${i + 1}/15 in 30 FPS...`);

    await page.evaluate((idx, dur) => {
      (window as any).showSlide(idx, dur);
    }, i, slides[i].durationMs);

    // Sleep until the exact target millisecond is reached
    while (Date.now() - recordingStartTime < accumulatedTargetMs) {
      const remaining = accumulatedTargetMs - (Date.now() - recordingStartTime);
      await new Promise((r) => setTimeout(r, Math.min(100, Math.max(10, remaining))));
    }
  }

  await recorder.stop();
  await browser.close();

  // Step 6: Multiplexing Video and Audio with Explicit Stream Mapping & AAC Stereo
  onProgress?.(96, "Multiplexing Video & Audio Streams with FFmpeg...");
  await multiplexVideoAndAudio(rawVideoPath, masterAudioPath, finalVideoPath);

  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  const totalSec = await getAudioDuration(finalVideoPath);
  const m = Math.floor(totalSec / 60);
  const s = String(Math.round(totalSec % 60)).padStart(2, "0");

  onProgress?.(100, "Masterclass Video Complete!");
  return {
    videoPath: finalVideoPath,
    htmlPath: finalHtmlPath,
    durationFormatted: `${m}:${s}`,
    slidesCount: slides.length
  };
}

function buildPresentationHTML(data: any, lang: any): string {
  const isRTL = lang.dir === "rtl";
  const dir = isRTL ? "rtl" : "ltr";

  const slidesHtml = (data.slides || []).map((slide: any, index: number) => {
    let innerContent = "";
    const safeTag = cleanUnicodeAndSymbols(slide.tag || `MODULE 0${index + 1}`);
    const safeHeading = cleanUnicodeAndSymbols(slide.heading || "");

    switch (slide.type) {
      case "cover":
        innerContent = `
          <div class="cover-hero-container">
            <div class="cover-text-column">
              <h1 class="cover-main-title anim-item" style="--d:0.06s">
                ${cleanUnicodeAndSymbols(slide.mainTitle || data.topic)}
              </h1>
              <p class="cover-sub-title anim-item" style="--d:0.12s">
                ${cleanUnicodeAndSymbols(slide.subtitle || (isRTL ? "مسار تعليمي تفاعلي متقدم" : "Strategic Depth vs Spatial Mastery"))}
              </p>
              <div class="cover-pills-row anim-item" style="--d:0.18s">
                <span class="cover-pill-tag"><i class="bx bx-book-open"></i> ${cleanUnicodeAndSymbols(slide.pill1 || "Foundations")}</span>
                <span class="cover-pill-tag"><i class="bx bx-time-five"></i> ${cleanUnicodeAndSymbols(slide.pill2 || "15 Modules")}</span>
                <span class="cover-pill-tag"><i class="bx bx-check-shield"></i> ${cleanUnicodeAndSymbols(slide.pill3 || "Verified Curriculum")}</span>
              </div>
            </div>
            <div class="cover-image-column anim-item" style="--d:0.10s">
              <img class="cover-hero-img" src="https://i.ibb.co/cSpXgSry/hero.png" alt="Keynote Visual" style="width: 500px; height: 500px; object-fit: contain;" />
            </div>
          </div>
        `;
        break;

      case "pillars_grid":
        const pillars = slide.pillars || [
          { num: "01", icon: "bx-cube", title: "Strategic Planning", desc: "Long-term foresight and move anticipation.", keyMetric: "40 moves average" },
          { num: "02", icon: "bx-chip", title: "Pattern Recognition", desc: "Identifying recurring motifs and tactics.", keyMetric: "Top 10% accuracy" },
          { num: "03", icon: "bx-layer", title: "Memory & Calculation", desc: "Calculating variations and recalling positions.", keyMetric: "10,000+ points" },
          { num: "04", icon: "bx-compass", title: "Adaptability & Creativity", desc: "Adjusting strategies to opponents dynamically.", keyMetric: "70% adapt rate" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-book-open"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="slide-center-container">
            <div class="four-grid-centered">
              ${pillars.map((p: any, idx: number) => `
                <div class="grid-card-enhanced anim-item" style="--d:${0.12 + idx * 0.06}s">
                  <div class="card-accent-strip"></div>
                  <div class="grid-card-top">
                    <span class="grid-num">0${idx + 1}</span>
                    <div class="grid-icon-square"><i class="bx ${p.icon || 'bx-cube'}"></i></div>
                  </div>
                  <h3 class="grid-card-title">${cleanUnicodeAndSymbols(p.title)}</h3>
                  <p class="grid-card-desc">${cleanUnicodeAndSymbols(p.desc)}</p>
                  <div class="grid-metric-badge">
                    <i class="bx bx-calendar"></i> ${cleanUnicodeAndSymbols(p.keyMetric || "Standard Benchmark")}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
        break;

      case "comparison_table":
        const headers = slide.tableHeaders || [
          isRTL ? "المحور" : "Dimension",
          isRTL ? "النموذج الكلاسيكي" : "Classical Approach",
          isRTL ? "النمط المتقدم" : "Modern Paradigm",
          isRTL ? "معيار القياس" : "Cross-Disciplinary Impact"
        ];
        const rows = slide.tableRows || [
          ["Strategic Depth", "High", "Low", "Problem solving, AI research"],
          ["Spatial Reasoning", "Moderate", "High", "3D modeling, robotics"],
          ["Time to Master", "Long (years)", "Short (months)", "Skill curves"],
          ["Cultural Reach", "Global (600M)", "Global (100M)", "Mass media, education"],
          ["Competitive Scene", "World Championships", "World Associations", "Professional circuits"],
          ["Learning Curve", "Steep", "Moderate", "Skill acquisition rates"]
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-table"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="table-container-full anim-item" style="--d:0.14s">
            <table class="notebook-table-full">
              <thead>
                <tr>
                  ${headers.map((h: string) => `<th>${cleanUnicodeAndSymbols(h)}</th>`).join("")}
                </tr>
              </thead>
              <tbody>
                ${rows.slice(0, 6).map((row: string[], rIdx: number) => `
                  <tr class="anim-item" style="--d:${0.16 + rIdx * 0.04}s">
                    <td>
                      <div class="table-category-cell">
                        <i class="bx bx-code-alt"></i>
                        <span>${cleanUnicodeAndSymbols(row[0] || "")}</span>
                      </div>
                    </td>
                    <td>${cleanUnicodeAndSymbols(row[1] || "")}</td>
                    <td><strong>${cleanUnicodeAndSymbols(row[2] || "")}</strong></td>
                    <td><span class="table-status-pill status-${rIdx % 4}">${cleanUnicodeAndSymbols(row[3] || "Verified")}</span></td>
                  </tr>
                `).join("")}
              </tbody>
            </table>
          </div>
        `;
        break;

      case "image_cards":
        const cards = slide.cards || [
          { badge: "EPOCH 01", title: "Early Origins", description: "First documented origins and formal frameworks.", spec1: "ERA: 6th Century", spec2: "ORIGIN: Classical", imageLocalUrl: "https://images.unsplash.com/photo-1529699211952-734e80c4d42b?w=600&q=80" },
          { badge: "EPOCH 02", title: "Global Expansion", description: "International standardization and tournament circuits.", spec1: "ERA: 19th Century", spec2: "ORIGIN: International", imageLocalUrl: "https://images.unsplash.com/photo-1586165368502-1bad197a6461?w=600&q=80" },
          { badge: "EPOCH 03", title: "Computational Era", description: "Deep neural evaluation and superhuman performance.", spec1: "ERA: 21st Century", spec2: "ORIGIN: Algorithmic", imageLocalUrl: "https://images.unsplash.com/photo-1518770660439-4636190af475?w=600&q=80" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-images"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="image-cards-row-tall">
            ${cards.map((c: any, cIdx: number) => `
              <div class="photo-card-tall anim-item" style="--d:${0.14 + cIdx * 0.08}s">
                <div class="photo-frame-tall">
                  <img src="${c.imageLocalUrl || 'https://images.unsplash.com/photo-1529699211952-734e80c4d42b?w=600&q=80'}" alt="${cleanUnicodeAndSymbols(c.title)}" />
                  <div class="photo-badge-large"><i class="bx bx-history"></i> ${cleanUnicodeAndSymbols(c.badge || `EPOCH 0${cIdx + 1}`)}</div>
                </div>
                <div class="photo-card-body-tall">
                  <h4 class="photo-card-title-tall">${cleanUnicodeAndSymbols(c.title)}</h4>
                  <p class="photo-card-desc-tall">${cleanUnicodeAndSymbols(c.description)}</p>
                  <div class="photo-tech-specs-tall">
                    <span>${cleanUnicodeAndSymbols(c.spec1 || 'ERA: Classical')}</span>
                    <span>${cleanUnicodeAndSymbols(c.spec2 || 'ORIGIN: Global')}</span>
                  </div>
                </div>
              </div>
            `).join("")}
          </div>
        `;
        break;

      case "bar_chart":
        const barChartUrl = `https://quickchart.io/chart?w=900&h=520&bkg=white&c={type:'line',data:{labels:['Phase+1','Phase+2','Phase+3','Phase+4','Phase+5'],datasets:[{label:'Theoretical+Complexity',data:[35,52,78,92,98.6],borderColor:'rgb(37,99,235)',backgroundColor:'rgba(37,99,235,0.12)',fill:true,tension:0.3,borderWidth:4},{label:'Empirical+Baseline',data:[25,32,45,55,62],borderColor:'rgb(148,163,184)',borderDash:[6,6],fill:false,borderWidth:3}]},options:{plugins:{legend:{position:'top',labels:{font:{size:16,weight:'bold'}}}},scales:{y:{min:20,max:100,ticks:{font:{size:14}},title:{display:true,text:'Complexity+Index+(%)',font:{size:15,weight:'bold'}}},x:{ticks:{font:{size:14}}}}}}`;
        const bTakeaways = slide.takeaways || [
          "Combinatorial state-space expansion follows non-linear growth curves.",
          "Heuristic evaluation reduces branch factor calculation overhead significantly.",
          "Pattern storage accelerates rapid decision-making across real-world setups."
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-line-chart"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${barChartUrl}" alt="Complexity Scaling Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-line-chart"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || "Pieces and Moves Over Time")}</h3>
              ${bTakeaways.map((t: string) => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-check-circle"></i> Empirical Benchmark</strong>
                  <span>${cleanUnicodeAndSymbols(t)}</span>
                </div>
              `).join("")}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-data"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || "Complexity drives mastery")}
              </div>
            </div>
          </div>
        `;
        break;

      case "deep_dive":
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-code-block"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="deep-dive-layout-maximized">
            <div class="deep-dive-card-max primary-card anim-item" style="--d:0.14s">
              <div>
                <div class="dive-header-tall">
                  <i class="bx bx-compass"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.card1Title || "Classical Deterministic Form")}</h3>
                </div>
                <div class="dive-image-wrap-max">
                  <img class="dive-fitted-img" src="${slide.image1LocalUrl || 'https://images.unsplash.com/photo-1529699211952-734e80c4d42b?w=600&q=80'}" alt="Deep Dive 1" />
                </div>
                <p class="dive-body-max">${cleanUnicodeAndSymbols(slide.card1Desc || "Interpreting moves and operations across standard coordinate space.")}</p>
              </div>
              <div class="dive-pills-row-max">
                ${(slide.card1Pills || ["Coordinate Space", "Instant Execution", "Central Logic"]).map((p: string) => `
                  <span><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(p)}</span>
                `).join("")}
              </div>
            </div>
            <div class="deep-dive-card-max secondary-card anim-item" style="--d:0.2s">
              <div>
                <div class="dive-header-tall">
                  <i class="bx bx-globe"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.card2Title || "Adaptive Modern Geodesics")}</h3>
                </div>
                <div class="dive-image-wrap-max">
                  <img class="dive-fitted-img" src="${slide.image2LocalUrl || 'https://images.unsplash.com/photo-1586165368502-1bad197a6461?w=600&q=80'}" alt="Deep Dive 2" />
                </div>
                <p class="dive-body-max">${cleanUnicodeAndSymbols(slide.card2Desc || "Formulating multi-layer state trees for optimal pathfinding and resolution.")}</p>
              </div>
              <div class="dive-pills-row-max">
                ${(slide.card2Pills || ["State Graph", "Tree Trajectory", "Optimal Paths"]).map((p: string) => `
                  <span><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(p)}</span>
                `).join("")}
              </div>
            </div>
          </div>
        `;
        break;

      case "timeline":
        const steps = slide.timelineSteps || [
          { step: "PHASE 01", title: "Classical Formulation", desc: "Foundational rules codified and universally disseminated.", metaSpec: "ERA: Initial", icon: "bx-book-open" },
          { step: "PHASE 02", title: "Pattern Refinement", desc: "Identification of standardized openings and strategic motifs.", metaSpec: "ERA: Intermediate", icon: "bx-target-lock" },
          { step: "PHASE 03", title: "Formal Tournaments", desc: "Structured international championships established.", metaSpec: "ERA: Modern", icon: "bx-git-merge" },
          { step: "PHASE 04", title: "Algorithmic Solvers", desc: "Digital verification confirming theoretical optimums.", metaSpec: "ERA: Digital", icon: "bx-award" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-git-branch"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="curved-timeline-container anim-item" style="--d:0.14s">
            <svg class="timeline-hybrid-svg" viewBox="0 0 1700 160" preserveAspectRatio="none">
              <defs>
                <linearGradient id="timelineGrad" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#2563EB" />
                  <stop offset="50%" stop-color="#06B6D4" />
                  <stop offset="100%" stop-color="#10B981" />
                </linearGradient>
              </defs>
              <path d="M 100 80 L 300 80 C 420 20, 500 140, 620 80 L 820 80 C 940 20, 1020 140, 1140 80 L 1340 80 C 1460 20, 1540 140, 1620 80" 
                    fill="none" stroke="url(#timelineGrad)" stroke-width="5" stroke-dasharray="10 8" />
              <circle cx="200" cy="80" r="9" fill="#2563EB" />
              <circle cx="720" cy="80" r="9" fill="#06B6D4" />
              <circle cx="1240" cy="80" r="9" fill="#0EA5E9" />
              <circle cx="1620" cy="80" r="9" fill="#10B981" />
            </svg>
            <div class="timeline-nodes-row">
              ${steps.map((st: any, sIdx: number) => `
                <div class="timeline-curved-node anim-item" style="--d:${0.18 + sIdx * 0.08}s">
                  <div class="timeline-badge-square"><i class="bx ${st.icon || 'bx-book-open'}"></i></div>
                  <div class="timeline-card-square">
                    <span class="timeline-phase-pill">${cleanUnicodeAndSymbols(st.step)}</span>
                    <h4 class="timeline-title">${cleanUnicodeAndSymbols(st.title)}</h4>
                    <p class="timeline-desc">${cleanUnicodeAndSymbols(st.desc)}</p>
                    <div class="timeline-meta-box">${cleanUnicodeAndSymbols(st.metaSpec || 'ERA: Standard')}</div>
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
        break;

      case "doughnut_chart":
        const doughnutUrl = `https://quickchart.io/chart?w=720&h=520&bkg=white&c={type:'doughnut',data:{labels:['Calculation+(45%)','Pattern+Recall+(25%)','Spatial+Memory+(20%)','Intuition+(10%)'],datasets:[{data:[45,25,20,10],backgroundColor:['rgb(37,99,235)','rgb(6,182,212)','rgb(16,185,129)','rgb(245,158,11)'],borderWidth:4}]},options:{plugins:{legend:{position:'bottom',labels:{font:{size:16,weight:'bold'}}}}}}`;
        const insights = slide.insights || [
          { title: "45% Computational Tree Depth", desc: "Calculating multi-step move variations under strict time control." },
          { title: "25% Pattern Recognition Memory", desc: "Recognizing high-value positional configurations and geometric symmetries." },
          { title: "20% Spatial Geometry Mapping", desc: "Tracking transformations and orientations in multi-dimensional space." }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-pie-chart-alt-2"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${doughnutUrl}" alt="Component Distribution Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-pie-chart-alt"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || "Skill Distribution Breakdown")}</h3>
              ${insights.map((ins: any) => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-check-double" style="color: #2563EB"></i> ${cleanUnicodeAndSymbols(ins.title)}</strong>
                  <span>${cleanUnicodeAndSymbols(ins.desc)}</span>
                </div>
              `).join("")}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-info-circle"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || "Cognitive skill benchmark")}
              </div>
            </div>
          </div>
        `;
        break;

      case "big_stat":
        const statPoints = slide.supportingPoints || [
          { title: "Spatial Ephemeris", desc: "Exact calculation of permutation spaces without heuristics.", icon: "bx-planet" },
          { title: "Algorithmic Precision", desc: "God's number proven at exactly 20 moves maximum.", icon: "bx-check-shield" },
          { title: "Cognitive Transfer", desc: "Direct reinforcement of mathematical and spatial reasoning.", icon: "bx-time-five" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-award"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="stat-hero-container">
            <div class="stat-number-wrap anim-item" style="--d:0.12s">
              <span class="giant-stat-number">${cleanUnicodeAndSymbols(slide.statNumber || '4.33×10¹⁹')}</span>
              <span class="giant-stat-label">${cleanUnicodeAndSymbols(slide.statLabel || "Total Permutational State Space")}</span>
            </div>
            <p class="stat-hero-desc anim-item" style="--d:0.18s">${cleanUnicodeAndSymbols(slide.description || "The mathematical combinatorial complexity demonstrates how a discrete 3x3 cube encapsulates trillions of configurations solved by group theory.")}</p>
            <div class="stat-points-row anim-item" style="--d:0.24s">
              ${statPoints.map((p: any) => `
                <div class="stat-pill-card">
                  <div class="stat-pill-card-title"><i class="bx ${p.icon || 'bx-planet'}"></i> ${cleanUnicodeAndSymbols(p.title)}</div>
                  <div class="stat-pill-card-desc">${cleanUnicodeAndSymbols(p.desc)}</div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
        break;

      case "line_chart":
        const lineChartUrl = `https://quickchart.io/chart?w=900&h=520&bkg=white&c={type:'bar',data:{labels:['Novice','Club','Master','Grandmaster','Optimal'],datasets:[{type:'line',label:'Cognitive+Depth',data:[15,40,70,95,140],borderColor:'rgb(239,68,68)',borderWidth:4,fill:false},{label:'Performance+Index',data:[30,55,85,115,160],backgroundColor:'rgb(37,99,235)',borderRadius:8}]},options:{plugins:{legend:{position:'top',labels:{font:{size:16,weight:'bold'}}}},scales:{y:{ticks:{font:{size:14}}},x:{ticks:{font:{size:14}}}}}}`;
        const lTakeaways = slide.takeaways || [
          "Deliberate practice accelerates pattern recognition across early mastery.",
          "High-level play mandates deep calculation of critical variations.",
          "Strategic synthesis bridges discrete logic with creative intuition."
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-trending-up"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="chart-layout-direct">
            <img class="direct-chart-img anim-item" style="--d:0.14s" src="${lineChartUrl}" alt="Progress Chart" />
            <div class="chart-sidebar-expanded anim-item" style="--d:0.2s">
              <h3 class="sidebar-title-expanded"><i class="bx bx-rocket"></i> ${cleanUnicodeAndSymbols(slide.chartTitle || "Skill Progression Curves")}</h3>
              ${lTakeaways.map((t: string) => `
                <div class="sidebar-bullet-expanded">
                  <strong><i class="bx bx-trending-up"></i> Paradigm Shift</strong>
                  <span>${cleanUnicodeAndSymbols(t)}</span>
                </div>
              `).join("")}
              <div class="chart-meta-callout-expanded">
                <i class="bx bx-time"></i> ${cleanUnicodeAndSymbols(slide.metaCallout || "Empirical progression standard")}
              </div>
            </div>
          </div>
        `;
        break;

      case "mindmap":
        const branches = (slide.branches && slide.branches.length >= 6) ? slide.branches : [
          { num: "VECTOR 01", icon: "bx-compass", title: "Move Tree", detail: "Decomposes options into directed graphs.", submeta: "Search Tree" },
          { num: "VECTOR 02", icon: "bx-planet", title: "Pattern Bank", detail: "Recalls standard tactical combinations.", submeta: "Memory Store" },
          { num: "VECTOR 03", icon: "bx-time-five", title: "Time Discipline", detail: "Balances clock pace with depth of thought.", submeta: "Pacing Protocol" },
          { num: "VECTOR 04", icon: "bx-analyse", title: "Tactical Sharpness", detail: "Finds deterministic forced paths.", submeta: "Evaluation Engine" },
          { num: "VECTOR 05", icon: "bx-shield", title: "Defensive Guard", detail: "Guards against counter-threats.", submeta: "Positional Lock" },
          { num: "VECTOR 06", icon: "bx-refresh", title: "Endgame Polish", detail: "Converts subtle advantages into victory.", submeta: "Final Technique" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-sitemap"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="mindmap-wrapper-relative anim-item" style="--d:0.14s">
            <svg class="mindmap-connectors-svg" viewBox="0 0 1700 560">
              <defs>
                <linearGradient id="lineGradLeft" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#2563EB" stop-opacity="0.3" />
                  <stop offset="100%" stop-color="#2563EB" stop-opacity="0.9" />
                </linearGradient>
                <linearGradient id="lineGradRight" x1="0%" y1="0%" x2="100%" y2="0%">
                  <stop offset="0%" stop-color="#10B981" stop-opacity="0.9" />
                  <stop offset="100%" stop-color="#10B981" stop-opacity="0.3" />
                </linearGradient>
              </defs>
              <path d="M 520 80 L 700 80 C 780 80, 770 280, 850 280" fill="none" stroke="url(#lineGradLeft)" stroke-width="3.5" stroke-dasharray="6 4" />
              <path d="M 520 280 L 850 280" fill="none" stroke="url(#lineGradLeft)" stroke-width="4" />
              <path d="M 520 480 L 700 480 C 780 480, 770 280, 850 280" fill="none" stroke="url(#lineGradLeft)" stroke-width="3.5" stroke-dasharray="6 4" />
              <path d="M 970 280 C 1050 280, 1040 80, 1120 80 L 1300 80" fill="none" stroke="url(#lineGradRight)" stroke-width="3.5" stroke-dasharray="6 4" />
              <path d="M 970 280 L 1300 280" fill="none" stroke="url(#lineGradRight)" stroke-width="4" />
              <path d="M 970 280 C 1050 280, 1040 480, 1120 480 L 1300 480" fill="none" stroke="url(#lineGradRight)" stroke-width="3.5" stroke-dasharray="6 4" />
            </svg>
            <div class="mindmap-col">
              ${branches.slice(0, 3).map((b: any, bIdx: number) => `
                <div class="mindmap-future-card left-branch anim-item" style="--d:${0.16 + bIdx * 0.06}s">
                  <div class="branch-card-header">
                    <span class="branch-num">${cleanUnicodeAndSymbols(b.num || `VECTOR 0${bIdx + 1}`)}</span>
                    <i class="bx ${b.icon || 'bx-check'}"></i>
                  </div>
                  <h4 class="branch-title">${cleanUnicodeAndSymbols(b.title)}</h4>
                  <p class="branch-detail">${cleanUnicodeAndSymbols(b.detail)}</p>
                  <span class="branch-submeta">${cleanUnicodeAndSymbols(b.submeta || 'Protocol Standard')}</span>
                </div>
              `).join("")}
            </div>
            <div class="mindmap-center-hub anim-item" style="--d:0.2s">
              <div class="hub-core-box">
                <i class="bx bx-planet"></i>
                <span class="hub-title">${cleanUnicodeAndSymbols(slide.centerNode || "Cognitive Core")}</span>
                <span class="hub-subtitle">${cleanUnicodeAndSymbols(slide.centerSubtitle || "Unified Framework")}</span>
              </div>
            </div>
            <div class="mindmap-col">
              ${branches.slice(3, 6).map((b: any, bIdx: number) => `
                <div class="mindmap-future-card right-branch anim-item" style="--d:${0.16 + bIdx * 0.06}s">
                  <div class="branch-card-header">
                    <span class="branch-num">${cleanUnicodeAndSymbols(b.num || `VECTOR 0${bIdx + 4}`)}</span>
                    <i class="bx ${b.icon || 'bx-check'}"></i>
                  </div>
                  <h4 class="branch-title">${cleanUnicodeAndSymbols(b.title)}</h4>
                  <p class="branch-detail">${cleanUnicodeAndSymbols(b.detail)}</p>
                  <span class="branch-submeta">${cleanUnicodeAndSymbols(b.submeta || 'Protocol Standard')}</span>
                </div>
              `).join("")}
            </div>
          </div>
        `;
        break;

      case "case_study":
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-briefcase"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="case-study-layout-tall">
            <div class="case-study-photo-box-tall anim-item" style="--d:0.14s">
              <img src="${slide.caseImageLocalUrl || 'https://images.unsplash.com/photo-1529699211952-734e80c4d42b?w=600&q=80'}" alt="Case Study Visual" />
              <div class="case-metric-tag-large"><i class="bx bx-check-circle"></i> ${cleanUnicodeAndSymbols(slide.metricTag || "+100% EMPIRICAL CONFIRMATION")}</div>
            </div>
            <div class="case-study-content-tall anim-item" style="--d:0.2s">
              <div class="case-pill-large"><i class="bx bx-check-double"></i> ${cleanUnicodeAndSymbols(slide.casePill || "HISTORICAL VALIDATION")}</div>
              <h3 class="case-title-large">${cleanUnicodeAndSymbols(slide.caseTitle || "Historic Matchup Analysis")}</h3>
              <p class="case-text-large">${cleanUnicodeAndSymbols(slide.caseSummary || "An authoritative analysis of competitive breakthroughs where decisive strategic choices established lasting theoretical principles.")}</p>
              <div class="case-stats-grid-large">
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat1Val || "99.98%")}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat1Lbl || "Accuracy Rate")}</span>
                </div>
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat2Val || "3.47s")}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat2Lbl || "Record Speed")}</span>
                </div>
                <div class="stat-mini-card-large">
                  <span class="mini-val-large">${cleanUnicodeAndSymbols(slide.stat3Val || "100%")}</span>
                  <span class="mini-lbl-large">${cleanUnicodeAndSymbols(slide.stat3Lbl || "Rule Agreement")}</span>
                </div>
              </div>
            </div>
          </div>
        `;
        break;

      case "tradeoffs_matrix":
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-git-compare"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="tradeoffs-layout-max">
            <div class="tradeoff-card-max strengths-card anim-item" style="--d:0.14s">
              <div>
                <div class="tradeoff-title-bar">
                  <i class="bx bx-check-shield"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.strengthsTitle || "Architectural Strengths")}</h3>
                </div>
                <div class="tradeoff-img-wrap-max">
                  <img class="tradeoff-fitted-img" src="${slide.strengthsImageLocalUrl || 'https://images.unsplash.com/photo-1529699211952-734e80c4d42b?w=600&q=80'}" alt="Strengths" />
                </div>
              </div>
              <ul class="tradeoff-list-max">
                ${(slide.strengths || [
                  "Unrivaled predictive precision across long-horizon planning.",
                  "Cohesive geometric clarity eliminating ambiguous trial-and-error.",
                  "Fundamental framework for strategic and spatial decision modeling."
                ]).map((s: string) => `<li><i class="bx bx-check"></i> ${cleanUnicodeAndSymbols(s)}</li>`).join("")}
              </ul>
            </div>
            <div class="tradeoff-card-max challenges-card anim-item" style="--d:0.2s">
              <div>
                <div class="tradeoff-title-bar">
                  <i class="bx bx-error"></i>
                  <h3>${cleanUnicodeAndSymbols(slide.challengesTitle || "Theoretical Constraints")}</h3>
                </div>
                <div class="tradeoff-img-wrap-max">
                  <img class="tradeoff-fitted-img" src="${slide.challengesImageLocalUrl || 'https://images.unsplash.com/photo-1586165368502-1bad197a6461?w=600&q=80'}" alt="Challenges" />
                </div>
              </div>
              <ul class="tradeoff-list-max">
                ${(slide.challenges || [
                  "Exponential branching factor requiring rigorous pruning algorithms.",
                  "High mental fatigue during protracted tournament sessions.",
                  "Steep initial learning curve before achieving competitive fluency."
                ]).map((c: string) => `<li><i class="${isRTL ? 'bx bx-left-arrow-alt' : 'bx bx-right-arrow-alt'}"></i> ${cleanUnicodeAndSymbols(c)}</li>`).join("")}
              </ul>
            </div>
          </div>
        `;
        break;

      case "checklist_framework":
        const checklist = slide.checklist || [
          { phase: "GATE 01 • HYPOTHESIS", task: "Define Problem Space", desc: "Isolate initial conditions and rule bounds prior to solving.", deliverable: "Readiness Matrix" },
          { phase: "GATE 02 • MEASUREMENT", task: "High-Precision Calculation", desc: "Compare calculated variations against established lines.", deliverable: "99.9% Conformance" },
          { phase: "GATE 03 • VALIDATION", task: "Heuristic Stress Test", desc: "Validate tactical defenses and counter-moves under clock pressure.", deliverable: "Validation Log" },
          { phase: "GATE 04 • SYNTHESIS", task: "Mastery Integration", desc: "Synthesize intuition with exact calculation for optimal execution.", deliverable: "SLA Certified" }
        ];
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-task"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="slide-center-container">
            <div class="four-grid-centered">
              ${checklist.map((item: any, cIdx: number) => `
                <div class="gate-card-enhanced anim-item" style="--d:${0.14 + cIdx * 0.06}s">
                  <div class="gate-top-bar">
                    <span class="phase-code-square-large">${cleanUnicodeAndSymbols(item.phase)}</span>
                    <div class="check-box-square-large"><i class="bx bx-check"></i></div>
                  </div>
                  <h4 class="gate-title">${cleanUnicodeAndSymbols(item.task)}</h4>
                  <p class="gate-desc">${cleanUnicodeAndSymbols(item.desc)}</p>
                  <div class="gate-deliverable-tag">
                    <i class="bx bx-file"></i> ${isRTL ? 'المخرجات:' : 'Deliverable:'} ${cleanUnicodeAndSymbols(item.deliverable || "Verified Protocol")}
                  </div>
                </div>
              `).join("")}
            </div>
          </div>
        `;
        break;

      case "quote_summary":
      default:
        innerContent = `
          <div class="slide-header">
            <span class="slide-tag anim-item" style="--d:0.04s"><i class="bx bx-flag"></i> ${safeTag}</span>
            <h2 class="slide-heading anim-item" style="--d:0.08s">${safeHeading}</h2>
          </div>
          <div class="quote-slide-container-tall">
            <div class="quote-banner-tall anim-item" style="--d:0.14s">
              <i class="bx bxs-quote-left quote-mark-tall"></i>
              <h2 class="quote-text-tall">"${cleanUnicodeAndSymbols(slide.quote || "Chess is the struggle against the error.")}"</h2>
              <div class="quote-author-line">
                <span class="quote-author-name-tall">— ${cleanUnicodeAndSymbols(slide.quoteAuthor || "Johannes Zukertort")}</span>
                <span class="quote-author-role-tall">(${cleanUnicodeAndSymbols(slide.authorTitle || "World Chess Championship Contender, 1886")})</span>
              </div>
              <div class="quote-context-line">Celebrated historical maxim summarizing the psychological essence of competitive mastery</div>
            </div>
            <div class="summary-points-grid-tall">
              <div class="summary-check-card-tall anim-item" style="--d:0.2s">
                <div class="summary-card-header-tall">
                  <i class="bx bx-check-shield"></i>
                  <span>${cleanUnicodeAndSymbols(slide.card1Title || "Strategic Continuity")}</span>
                </div>
                <p>${cleanUnicodeAndSymbols(slide.card1Desc || "Mastery does not eliminate errors, but systematically reduces variance through structured discipline.")}</p>
              </div>
              <div class="summary-check-card-tall anim-item" style="--d:0.26s">
                <div class="summary-card-header-tall">
                  <i class="bx bx-rocket"></i>
                  <span>${cleanUnicodeAndSymbols(slide.card2Title || "Modern Frontiers")}</span>
                </div>
                <p>${cleanUnicodeAndSymbols(slide.card2Desc || "Analytical depth bridges tactical execution with long-term strategic vision.")}</p>
              </div>
            </div>
            <div class="callout-pill-tall anim-item" style="--d:0.32s">
              <i class="bx bx-check-double"></i> LECTURE COMPLETE • FROM THEORY TO REALITY
            </div>
          </div>
        `;
        break;
    }

    return `
    <section class="notebook-slide ${index === 0 ? 'active' : ''}" id="slide-${index}" style="display: ${index === 0 ? 'flex' : 'none'}; opacity: ${index === 0 ? '1' : '0'}; z-index: ${index === 0 ? '15' : '1'};">
      ${innerContent}
    </section>`;
  }).join("\n");

  return `<!DOCTYPE html>
<html lang="${lang.code}" dir="${dir}">
<head>
  <meta charset="UTF-8">
  <title>${cleanUnicodeAndSymbols(data.topic)} - Masterclass</title>
  
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Cairo:wght@400;600;700;800;900&family=Tajawal:wght@500;700;800;900&family=Fredoka:wght@500;600;700&family=Nunito:wght@400;600;700;800;900&family=JetBrains+Mono:wght@500;700;800&display=swap" rel="stylesheet">
  <link href="https://unpkg.com/boxicons@2.1.4/css/boxicons.min.css" rel="stylesheet">

  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }

    :root {
      --navy: #0F172A;
      --navy-card: #1E293B;
      --navy-light: #475569;
      --coral: #EF4444;
      --yellow: #F59E0B;
      --mint: #10B981;
      --blue: #2563EB;
      --cyan: #06B6D4;
      --paper: #FFFFFF;
      --border-color: #E2E8F0;
      --notebook-line: rgba(226, 232, 240, 0.75);
      --strip-bg: #F1F5F9;
      --strip-dots: #94A3B8;

      --rad-sm: 5px;
      --rad-md: 9px;
      --rad-lg: 13px;
    }

    /* 1280x705 CANVAS - OPTIMIZED SIZE */
    html, body {
      width: 1280px;
      height: 705px;
      max-width: 1280px;
      max-height: 705px;
      margin: 0;
      padding: 0;
      overflow: hidden;
      background: #FFFFFF;
      font-family: ${lang.font};
      color: var(--navy);
      -webkit-font-smoothing: antialiased;
      user-select: none;
    }

    #presentation-frame {
      width: 1280px;
      height: 705px;
      background: var(--paper);
      display: flex;
      flex-direction: ${isRTL ? 'row-reverse' : 'row'};
      position: relative;
      margin: 0;
      padding: 0;
      box-shadow: none;
      border: none;
    }

    .binder-strip {
      width: 65px;
      background: var(--strip-bg);
      border-${isRTL ? 'left' : 'right'}: 2px solid #E2E8F0;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: space-around;
      padding: 26px 0;
      z-index: 30;
      position: relative;
      flex-shrink: 0;
    }
    .binder-hole {
      width: 18px;
      height: 18px;
      background: #FFFFFF;
      border-radius: 50%;
      border: 3px solid var(--strip-dots);
      box-shadow: inset 0 1px 3px rgba(0,0,0,0.12);
    }

    .ruled-canvas {
      flex: 1;
      height: 705px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      position: relative;
      background-color: #FFFFFF;
      background-image: repeating-linear-gradient(
        transparent,
        transparent 39px,
        var(--notebook-line) 39px,
        var(--notebook-line) 40px
      );
      padding: 24px 42px 18px 42px;
      text-align: ${isRTL ? 'right' : 'left'};
      box-sizing: border-box;
      overflow: hidden;
    }

    .top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      z-index: 25;
      height: 37px;
      margin-bottom: 10px;
      flex-shrink: 0;
    }
    .topic-pill {
      background: var(--navy);
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 800;
      padding: 7px 18px;
      border-radius: 999px;
      display: flex;
      align-items: center;
      gap: 9px;
      letter-spacing: 0.02em;
      box-shadow: 0 3px 10px rgba(15, 23, 42, 0.16);
    }
    .pulse-dot {
      width: 8px;
      height: 8px;
      background: #38BDF8;
      border-radius: 50%;
      box-shadow: 0 0 9px #38BDF8;
      animation: pulseAnim 2s infinite ease-in-out;
    }
    @keyframes pulseAnim {
      0%, 100% { opacity: 0.6; transform: scale(0.9); }
      50% { opacity: 1; transform: scale(1.3); }
    }

    .slide-counter-badge {
      font-size: 14px;
      color: var(--navy-light);
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      padding: 5px 16px;
      border-radius: var(--rad-md);
      font-weight: 800;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      box-shadow: 0 1px 7px rgba(0,0,0,0.04);
    }
    .slide-counter-badge span {
      color: var(--blue);
      font-size: 17px;
    }

    .slides-deck {
      position: relative;
      flex: 1;
      min-height: 0;
      height: 580px;
      overflow: hidden;
      z-index: 10;
    }
    
    .notebook-slide {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      display: none;
      flex-direction: column;
      justify-content: flex-start;
      overflow: hidden;
      box-sizing: border-box;
      opacity: 0;
      pointer-events: none;
      transform: scale(0.99) translateY(6px);
      filter: blur(2px);
      transition: opacity 0.35s ease, transform 0.35s ease;
    }
    .notebook-slide.active {
      display: flex !important;
      opacity: 1 !important;
      pointer-events: auto;
      transform: scale(1) translateY(0);
      filter: blur(0);
      z-index: 15 !important;
    }

    .anim-item {
      opacity: 0;
      transform: translateY(14px);
      transition: opacity 0.35s cubic-bezier(0.16, 1, 0.3, 1),
                  transform 0.35s cubic-bezier(0.16, 1, 0.3, 1);
    }
    .notebook-slide.active .anim-item {
      opacity: 1;
      transform: translateY(0);
      transition-delay: var(--d, 0s);
    }

    .slide-header {
      margin-bottom: 13px;
      flex-shrink: 0;
    }
    .slide-tag {
      display: inline-flex;
      align-items: center;
      gap: 7px;
      font-size: 10px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 4px 10px;
      border-radius: var(--rad-sm);
      margin-bottom: 5px;
      letter-spacing: 0.04em;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
    }
    .slide-heading {
      font-size: 27px;
      font-weight: 900;
      color: var(--navy);
      line-height: 1.2;
      letter-spacing: -0.01em;
    }

    /* Cover Hero Slide */
    .cover-hero-container {
      display: flex;
      height: 100%;
      align-items: center;
      justify-content: space-between;
      gap: 26px;
      padding: 13px 0;
    }
    .cover-text-column {
      flex: 1.15;
      display: flex;
      flex-direction: column;
      gap: 16px;
      z-index: 2;
    }
    .cover-main-title {
      font-family: ${isRTL ? "'Tajawal', 'Cairo'" : "'Fredoka', 'Nunito'"}, sans-serif;
      font-size: 47px;
      font-weight: 800;
      color: var(--navy);
      line-height: 1.12;
    }
    .cover-sub-title {
      font-size: 18px;
      color: #475569;
      font-weight: 600;
      line-height: 1.45;
    }
    .cover-pills-row {
      display: flex;
      gap: 10px;
      margin-top: 8px;
      flex-wrap: wrap;
    }
    .cover-pill-tag {
      background: #F8FAFC;
      border: 2px solid #CBD5E1;
      padding: 7px 16px;
      border-radius: 999px;
      font-size: 12px;
      font-weight: 800;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 3px 8px rgba(0,0,0,0.03);
    }
    .cover-pill-tag i { color: var(--blue); font-size: 14px; }

    .cover-image-column {
      flex: 1;
      height: 100%;
      display: flex;
      align-items: center;
      justify-content: center;
    }
    .cover-hero-img {
      width: 500px;
      height: 500px;
      max-width: 500px;
      max-height: 500px;
      object-fit: contain;
      display: block;
    }

    /* Centered 4-Grid */
    .slide-center-container {
      display: flex;
      flex-direction: column;
      justify-content: center;
      flex: 1;
      width: 100%;
      box-sizing: border-box;
    }
    .four-grid-centered {
      display: grid;
      grid-template-columns: repeat(2, 1fr);
      gap: 18px;
      width: 100%;
      margin: auto 0;
    }
    .grid-card-enhanced, .gate-card-enhanced {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-lg);
      padding: 21px 24px;
      display: flex;
      flex-direction: column;
      position: relative;
      box-shadow: 0 5px 16px rgba(15, 23, 42, 0.05);
      box-sizing: border-box;
      min-height: 175px;
    }
    .card-accent-strip {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      height: 4px;
      background: linear-gradient(90deg, var(--blue), var(--mint));
      border-radius: var(--rad-lg) var(--rad-lg) 0 0;
    }
    .grid-card-top, .gate-top-bar {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 9px;
    }
    .grid-num, .phase-code-square-large {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 12px;
      font-weight: 800;
      color: var(--blue);
    }
    .phase-code-square-large {
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 4px 9px;
      border-radius: var(--rad-sm);
    }
    .grid-icon-square, .check-box-square-large {
      width: 36px;
      height: 36px;
      border-radius: var(--rad-md);
      background: #EFF6FF;
      color: var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 20px;
      border: 1.5px solid #BFDBFE;
    }
    .check-box-square-large {
      width: 29px;
      height: 29px;
      background: #ECFDF5;
      color: var(--mint);
      border-color: #A7F3D0;
      font-size: 17px;
    }
    .grid-card-title, .gate-title {
      font-size: 17px;
      font-weight: 800;
      color: var(--navy);
      margin-bottom: 7px;
    }
    .grid-card-desc, .gate-desc {
      font-size: 12px;
      color: #475569;
      line-height: 1.5;
      margin-bottom: 10px;
    }
    .grid-metric-badge, .gate-deliverable-tag {
      margin-top: auto;
      align-self: flex-start;
      background: #F8FAFC;
      color: var(--navy);
      font-size: 10px;
      font-weight: 800;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      padding: 5px 12px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 5px;
      border: 1.5px solid #CBD5E1;
    }

    /* Comparison Table */
    .table-container-full {
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      overflow: hidden;
      box-shadow: 0 7px 20px rgba(15, 23, 42, 0.06);
      flex: 1;
      display: flex;
      flex-direction: column;
      box-sizing: border-box;
      max-height: 460px;
    }
    .notebook-table-full {
      width: 100%;
      height: 100%;
      border-collapse: collapse;
      text-align: ${isRTL ? 'right' : 'left'};
    }
    .notebook-table-full th {
      background: var(--navy);
      color: #FFFFFF;
      font-size: 13px;
      font-weight: 800;
      padding: 12px 17px;
    }
    .notebook-table-full td {
      padding: 12px 17px;
      font-size: 12px;
      color: #334155;
      border-bottom: 1.5px solid #E2E8F0;
    }
    .notebook-table-full tbody tr:nth-child(even) { background: #F8FAFC; }
    .table-category-cell {
      display: flex;
      align-items: center;
      gap: 8px;
      font-weight: 800;
      color: var(--navy);
      font-size: 12px;
    }
    .table-category-cell i { color: var(--blue); font-size: 16px; }
    .table-status-pill {
      display: inline-block;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 10px;
      font-weight: 800;
      padding: 4px 10px;
      border-radius: var(--rad-sm);
    }
    .status-0 { background: #ECFDF5; color: #059669; border: 1.5px solid #A7F3D0; }
    .status-1 { background: #EFF6FF; color: #0284C7; border: 1.5px solid #BAE6FD; }
    .status-2 { background: #FFFBEB; color: #B45309; border: 1.5px solid #FDE68A; }
    .status-3 { background: #FEF2F2; color: #DC2626; border: 1.5px solid #FECACA; }

    /* Image Cards Tall */
    .image-cards-row-tall {
      display: flex;
      gap: 18px;
      flex: 1;
      height: 100%;
      box-sizing: border-box;
      max-height: 460px;
    }
    .photo-card-tall {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #E2E8F0;
      overflow: hidden;
      display: flex;
      flex-direction: column;
      box-shadow: 0 5px 16px rgba(15, 23, 42, 0.06);
      box-sizing: border-box;
    }
    .photo-frame-tall {
      height: 247px;
      position: relative;
      background: #0F172A;
      overflow: hidden;
    }
    .photo-frame-tall img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .photo-badge-large {
      position: absolute;
      top: 10px;
      ${isRTL ? 'right' : 'left'}: 10px;
      background: rgba(15, 23, 42, 0.94);
      color: #fff;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 9px;
      font-weight: 800;
      padding: 4px 9px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 5px;
      border: 1px solid rgba(255, 255, 255, 0.25);
    }
    .photo-card-body-tall {
      padding: 16px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      flex: 1;
    }
    .photo-card-title-tall { font-size: 16px; font-weight: 800; color: var(--navy); }
    .photo-card-desc-tall { font-size: 12px; color: #475569; line-height: 1.55; }
    .photo-tech-specs-tall {
      margin-top: auto;
      background: #F8FAFC;
      border: 1.5px solid #CBD5E1;
      border-radius: var(--rad-sm);
      padding: 7px 10px;
      font-size: 10px;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-weight: 700;
      color: var(--navy);
      display: flex;
      justify-content: space-between;
    }

    /* Charts */
    .chart-layout-direct {
      display: flex;
      gap: 24px;
      align-items: center;
      flex: 1;
      width: 100%;
      box-sizing: border-box;
      max-height: 460px;
    }
    .direct-chart-img {
      flex: 1.35;
      width: 100%;
      height: 377px;
      max-height: 377px;
      object-fit: contain;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      background: #FFFFFF;
      box-shadow: 0 7px 16px rgba(15, 23, 42, 0.06);
      display: block;
    }
    .chart-sidebar-expanded {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .sidebar-title-expanded {
      font-size: 17px;
      font-weight: 900;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 7px;
    }
    .sidebar-bullet-expanded {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 10px 13px;
      display: flex;
      flex-direction: column;
      gap: 4px;
      font-size: 11px;
      color: #334155;
      line-height: 1.45;
      box-shadow: 0 3px 8px rgba(15, 23, 42, 0.03);
    }
    .sidebar-bullet-expanded strong {
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 5px;
      font-size: 12px;
    }
    .sidebar-bullet-expanded strong i { color: var(--mint); font-size: 14px; }
    .chart-meta-callout-expanded {
      background: #F8FAFC;
      border: 2px solid #CBD5E1;
      border-radius: var(--rad-sm);
      padding: 9px 13px;
      font-size: 10px;
      font-weight: 700;
      color: #475569;
      display: flex;
      align-items: center;
      gap: 7px;
    }

    /* Deep Dive */
    .deep-dive-layout-maximized {
      display: flex;
      gap: 18px;
      flex: 1;
      height: 100%;
      box-sizing: border-box;
      max-height: 460px;
    }
    .deep-dive-card-max {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      padding: 16px;
      display: flex;
      flex-direction: column;
      justify-content: space-between;
      box-shadow: 0 7px 16px rgba(15, 23, 42, 0.06);
      box-sizing: border-box;
    }
    .primary-card { border-top: 4px solid var(--blue); }
    .secondary-card { border-top: 4px solid var(--mint); }
    .dive-header-tall {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 8px;
    }
    .dive-header-tall i { font-size: 18px; color: var(--blue); }
    .dive-header-tall h3 { font-size: 16px; font-weight: 900; color: var(--navy); }
    .dive-image-wrap-max {
      width: 100%;
      height: 247px;
      border-radius: var(--rad-md);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      background: #0F172A;
      margin-bottom: 9px;
      flex-shrink: 0;
    }
    .dive-fitted-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .dive-body-max {
      font-size: 12px;
      color: #334155;
      line-height: 1.55;
      margin-bottom: 9px;
    }
    .dive-pills-row-max {
      display: flex;
      gap: 7px;
      margin-top: auto;
      flex-wrap: wrap;
    }
    .dive-pills-row-max span {
      background: #F1F5F9;
      padding: 4px 9px;
      border-radius: var(--rad-sm);
      font-weight: 800;
      font-size: 9px;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 4px;
      border: 1.5px solid #CBD5E1;
    }

    /* Curved Timeline */
    .curved-timeline-container {
      position: relative;
      display: flex;
      align-items: center;
      flex: 1;
      width: 100%;
      box-sizing: border-box;
      max-height: 705px;
    }
    .timeline-hybrid-svg {
      position: absolute;
      top: 50%;
      left: 0;
      width: 100%;
      height: 160px;
      transform: translateY(-50%);
      z-index: 1;
      pointer-events: none;
    }
    .timeline-nodes-row {
      position: relative;
      z-index: 2;
      display: flex;
      justify-content: space-between;
      width: 100%;
      gap: 24px;
    }
    .timeline-curved-node {
      display: flex;
      flex-direction: column;
      align-items: center;
      flex: 1;
    }
    .timeline-badge-square {
      width: 68px;
      height: 68px;
      background: var(--blue);
      color: #FFFFFF;
      font-size: 34px;
      border-radius: var(--rad-md);
      display: flex;
      align-items: center;
      justify-content: center;
      border: 4px solid #FFFFFF;
      box-shadow: 0 8px 20px rgba(37, 99, 235, 0.35);
      margin-bottom: 18px;
    }
    .timeline-card-square {
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      border-radius: var(--rad-md);
      padding: 22px;
      text-align: ${isRTL ? 'right' : 'left'};
      width: 100%;
      box-shadow: 0 8px 22px rgba(15, 23, 42, 0.05);
      box-sizing: border-box;
      min-height: 240px;
    }
    .timeline-phase-pill {
      display: inline-block;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 14px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 4px 10px;
      border-radius: var(--rad-sm);
      margin-bottom: 10px;
    }
    .timeline-title { font-size: 22px; font-weight: 800; color: var(--navy); margin-bottom: 8px; }
    .timeline-desc { font-size: 16.5px; color: #64748B; line-height: 1.5; margin-bottom: 12px; }
    .timeline-meta-box {
      background: #F8FAFC;
      border: 1.5px solid #E2E8F0;
      border-radius: var(--rad-sm);
      padding: 6px 10px;
      font-size: 14px;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-weight: 700;
      color: #334155;
    }

    /* Big Stat */
    .stat-hero-container {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      text-align: center;
      gap: 13px;
      box-sizing: border-box;
      max-height: 460px;
    }
    .stat-number-wrap {
      display: flex;
      flex-direction: column;
      align-items: center;
    }
    .giant-stat-number {
      font-size: 78px;
      font-weight: 900;
      color: var(--blue);
      line-height: 1;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      letter-spacing: -0.02em;
    }
    .giant-stat-label {
      font-size: 17px;
      font-weight: 800;
      color: var(--navy);
      margin-top: 5px;
    }
    .stat-hero-desc {
      font-size: 14px;
      color: #475569;
      max-width: 650px;
      line-height: 1.55;
    }
    .stat-points-row { display: flex; gap: 13px; margin-top: 9px; }
    .stat-pill-card {
      background: #FFFFFF;
      border: 2px solid #CBD5E1;
      border-top: 3px solid var(--blue);
      border-radius: var(--rad-md);
      padding: 12px 16px;
      display: flex;
      flex-direction: column;
      align-items: flex-start;
      gap: 5px;
      font-size: 11px;
      color: #334155;
      text-align: ${isRTL ? 'right' : 'left'};
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.05);
      min-width: 182px;
      box-sizing: border-box;
    }
    .stat-pill-card-title {
      font-weight: 800;
      color: var(--navy);
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 12px;
    }
    .stat-pill-card-title i { color: var(--blue); font-size: 14px; }
    .stat-pill-card-desc { font-size: 10px; color: #64748B; line-height: 1.45; }

    /* Mindmap */
    .mindmap-wrapper-relative {
      position: relative;
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 13px;
      flex: 1;
      width: 100%;
      box-sizing: border-box;
      max-height: 460px;
    }
    .mindmap-connectors-svg {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      z-index: 1;
      pointer-events: none;
    }
    .mindmap-col {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 12px;
      z-index: 2;
    }
    .mindmap-future-card {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 12px 14px;
      box-shadow: 0 3px 9px rgba(15, 23, 42, 0.05);
      position: relative;
      box-sizing: border-box;
    }
    .left-branch { border-${isRTL ? 'left' : 'right'}: 3px solid var(--blue); }
    .right-branch { border-${isRTL ? 'right' : 'left'}: 3px solid var(--mint); }
    .branch-card-header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      margin-bottom: 4px;
    }
    .branch-num {
      font-family: 'JetBrains Mono', monospace;
      font-size: 9px;
      font-weight: 800;
      color: var(--blue);
    }
    .branch-card-header i { font-size: 14px; color: var(--navy); }
    .branch-title { font-size: 13px; font-weight: 800; color: var(--navy); margin-bottom: 3px; }
    .branch-detail { font-size: 10px; color: #64748B; line-height: 1.4; margin-bottom: 5px; }
    .branch-submeta {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 8px;
      color: #2563EB;
      background: #EFF6FF;
      padding: 2px 5px;
      border-radius: 3px;
      display: inline-block;
      font-weight: 700;
    }
    .mindmap-center-hub {
      width: 156px;
      height: 156px;
      background: var(--navy);
      border-radius: var(--rad-lg);
      border: 3px solid var(--blue);
      display: flex;
      align-items: center;
      justify-content: center;
      position: relative;
      box-shadow: 0 10px 24px rgba(15, 23, 42, 0.3);
      z-index: 2;
      flex-shrink: 0;
    }
    .hub-core-box {
      text-align: center;
      color: #FFFFFF;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 5px;
      padding: 13px;
    }
    .hub-core-box i { font-size: 34px; color: var(--yellow); }
    .hub-title { font-size: 14px; font-weight: 800; }
    .hub-subtitle {
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      font-size: 9px;
      color: #38BDF8;
      letter-spacing: 0.05em;
    }

    /* Case Study */
    .case-study-layout-tall {
      display: flex;
      gap: 20px;
      align-items: center;
      flex: 1;
      box-sizing: border-box;
      max-height: 460px;
    }
    .case-study-photo-box-tall {
      flex: 1;
      height: 380px;
      position: relative;
      border-radius: var(--rad-lg);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      box-shadow: 0 8px 20px rgba(15, 23, 42, 0.08);
      background: #0F172A;
    }
    .case-study-photo-box-tall img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }
    .case-metric-tag-large {
      position: absolute;
      bottom: 12px;
      ${isRTL ? 'right' : 'left'}: 12px;
      background: rgba(15, 23, 42, 0.94);
      backdrop-filter: blur(8px);
      color: #FFFFFF;
      font-size: 11px;
      font-weight: 800;
      padding: 6px 12px;
      border-radius: var(--rad-sm);
      display: flex;
      align-items: center;
      gap: 6px;
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      border: 1.5px solid rgba(255, 255, 255, 0.25);
    }
    .case-metric-tag-large i { color: var(--mint); font-size: 13px; }
    .case-study-content-tall {
      flex: 1.25;
      display: flex;
      flex-direction: column;
      gap: 12px;
    }
    .case-pill-large {
      font-family: 'JetBrains Mono', 'Cairo', sans-serif;
      font-size: 10px;
      font-weight: 800;
      color: var(--blue);
      background: #EFF6FF;
      border: 1.5px solid #BFDBFE;
      padding: 5px 12px;
      border-radius: var(--rad-sm);
      display: inline-flex;
      align-items: center;
      gap: 6px;
      align-self: flex-start;
    }
    .case-title-large { font-size: 20px; font-weight: 900; color: var(--navy); line-height: 1.2; }
    .case-text-large { font-size: 13px; color: #475569; line-height: 1.5; }
    .case-stats-grid-large {
      display: grid;
      grid-template-columns: repeat(3, 1fr);
      gap: 10px;
      margin-top: 6px;
    }
    .stat-mini-card-large {
      background: #F8FAFC;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 12px 16px;
      text-align: center;
    }
    .mini-val-large {
      display: block;
      font-size: 20px;
      font-weight: 900;
      font-family: 'JetBrains Mono', 'Cairo', monospace;
      color: var(--blue);
    }
    .mini-lbl-large { font-size: 10px; color: #64748B; font-weight: 800; margin-top: 4px; }

    /* Tradeoffs Matrix */
    .tradeoffs-layout-max {
      display: flex;
      gap: 18px;
      flex: 1;
      height: 100%;
      box-sizing: border-box;
      max-height: 460px;
    }
    .tradeoff-card-max {
      flex: 1;
      background: #FFFFFF;
      border-radius: var(--rad-lg);
      border: 2px solid #CBD5E1;
      padding: 16px;
      display: flex;
      flex-direction: column;
      box-shadow: 0 6px 16px rgba(15, 23, 42, 0.05);
      box-sizing: border-box;
    }
    .tradeoff-title-bar {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
    }
    .tradeoff-title-bar h3 { font-size: 16px; font-weight: 800; color: var(--navy); }
    .strengths-card { border-top: 4px solid var(--mint); }
    .challenges-card { border-top: 4px solid var(--coral); }
    .strengths-card .tradeoff-title-bar i { font-size: 20px; color: var(--mint); }
    .challenges-card .tradeoff-title-bar i { font-size: 20px; color: var(--coral); }

    .tradeoff-img-wrap-max {
      width: 100%;
      height: 220px;
      border-radius: var(--rad-md);
      overflow: hidden;
      border: 2px solid #CBD5E1;
      background: #0F172A;
      margin-bottom: 12px;
      flex-shrink: 0;
    }
    .tradeoff-fitted-img {
      width: 100%;
      height: 100%;
      object-fit: cover;
      display: block;
    }

    .tradeoff-list-max {
      list-style: none;
      display: flex;
      flex-direction: column;
      gap: 8px;
      margin-top: auto;
    }
    .tradeoff-list-max li {
      font-size: 11px;
      color: #334155;
      display: flex;
      align-items: flex-start;
      gap: 7px;
      line-height: 1.4;
    }
    .tradeoff-list-max li i { font-size: 16px; flex-shrink: 0; margin-top: 1px; }
    .strengths-card .tradeoff-list-max li i { color: var(--mint); }
    .challenges-card .tradeoff-list-max li i { color: var(--coral); }

    /* Quote & Synthesis */
    .quote-slide-container-tall {
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      height: 100%;
      gap: 16px;
      box-sizing: border-box;
      max-height: 460px;
    }
    .quote-banner-tall {
      background: var(--navy);
      color: #FFFFFF;
      padding: 24px 40px;
      border-radius: var(--rad-lg);
      text-align: center;
      position: relative;
      max-width: 1000px;
      box-shadow: 0 12px 28px rgba(15, 23, 42, 0.25);
      border: 2px solid #334155;
    }
    .quote-mark-tall { font-size: 28px; color: var(--yellow); margin-bottom: 4px; }
    .quote-text-tall { font-size: 18px; line-height: 1.35; font-weight: 700; margin-bottom: 10px; }
    .quote-author-line {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 8px;
      flex-wrap: wrap;
    }
    .quote-author-name-tall { font-size: 14px; font-weight: 800; color: var(--yellow); }
    .quote-author-role-tall { font-size: 12px; color: #94A3B8; }
    .quote-context-line { margin-top: 6px; font-size: 10px; color: #CBD5E1; font-style: italic; }
    .summary-points-grid-tall { display: flex; gap: 16px; }
    .summary-check-card-tall {
      background: #FFFFFF;
      border: 2px solid #E2E8F0;
      border-radius: var(--rad-md);
      padding: 14px 18px;
      display: flex;
      flex-direction: column;
      gap: 6px;
      font-size: 11px;
      color: #475569;
      box-shadow: 0 4px 12px rgba(15, 23, 42, 0.04);
      max-width: 420px;
      line-height: 1.45;
      box-sizing: border-box;
    }
    .summary-card-header-tall {
      display: flex;
      align-items: center;
      gap: 7px;
      font-size: 13px;
      font-weight: 800;
      color: var(--navy);
    }
    .summary-card-header-tall i { color: var(--mint); font-size: 16px; }
    .callout-pill-tall {
      background: var(--blue);
      color: #FFFFFF;
      font-size: 12px;
      font-weight: 800;
      padding: 8px 24px;
      border-radius: var(--rad-md);
      display: flex;
      align-items: center;
      gap: 8px;
      box-shadow: 0 6px 18px rgba(37, 99, 235, 0.35);
    }

    /* Bottom Bar */
    .bottom-bar {
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 25;
      padding-top: 14px;
      border-top: 2px solid #E2E8F0;
      height: 58px;
      box-sizing: border-box;
      flex-shrink: 0;
    }
    .progress-track {
      flex: 0.75;
      height: 12px;
      background: #E2E8F0;
      border-radius: var(--rad-sm);
      overflow: hidden;
      position: relative;
    }
    #slide-progress-fill {
      width: 0%;
      height: 100%;
      background: linear-gradient(90deg, var(--blue), var(--cyan), var(--mint));
      border-radius: var(--rad-sm);
      transition: width 0.1s linear;
    }
    .astromind-bot-badge-prominent {
      display: flex;
      align-items: center;
      gap: 12px;
      background: #FFFFFF;
      color: #1E293B;
      padding: 8px 26px;
      border-radius: 999px;
      box-shadow: 0 4px 16px rgba(0, 0, 0, 0.08);
      border: 2px solid #CBD5E1;
      font-size: 17px;
      font-weight: 800;
    }
    .astromind-bot-badge-prominent i { font-size: 26px; color: var(--blue); }
    .astromind-bot-badge-prominent span { color: var(--blue); font-weight: 900; }
  </style>
</head>
<body>
  <div id="presentation-frame">
    <div class="binder-strip">
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
      <div class="binder-hole"></div>
    </div>

    <div class="ruled-canvas">
      <div class="top-bar">
        <div class="topic-pill">
          <div class="pulse-dot"></div>
          <span>${cleanUnicodeAndSymbols(data.topic)}</span>
        </div>
        
        <div class="top-right-group">
          <div class="slide-counter-badge">
            ${isRTL ? 'شريحة' : 'SLIDE'} <span id="slide-index-view">01</span> / 15
          </div>
        </div>
      </div>

      <div class="slides-deck">
        ${slidesHtml}
      </div>

      <div class="bottom-bar">
        <div class="progress-track">
          <div id="slide-progress-fill"></div>
        </div>
        
        <div class="astromind-bot-badge-prominent">
          <i class="bx bx-bot"></i>
          <div>${isRTL ? 'تم الإنشاء بواسطة' : 'Generated By'} <span>AstroMind-A1</span></div>
        </div>
      </div>
    </div>
  </div>

  <script>
    var currentSlideIndex = 0;
    var totalSlides = 15;
    var currentSlideStart = performance.now();
    var currentSlideDuration = 13000;

    function liveCompositorHeartbeat(timestamp) {
      var elapsed = timestamp - currentSlideStart;
      var fillEl = document.getElementById('slide-progress-fill');
      if (fillEl && currentSlideDuration > 0) {
        var pct = Math.min(100, Math.max(0, (elapsed / currentSlideDuration) * 100));
        fillEl.style.width = pct.toFixed(2) + '%';
      }
      requestAnimationFrame(liveCompositorHeartbeat);
    }
    requestAnimationFrame(liveCompositorHeartbeat);

    window.showSlide = function(index, durationMs) {
      if (index < 0) index = 0;
      if (index >= totalSlides) index = totalSlides - 1;
      
      window.scrollTo(0, 0);
      currentSlideIndex = index;
      currentSlideStart = performance.now();
      currentSlideDuration = durationMs || 13000;

      var allSlides = Array.prototype.slice.call(document.querySelectorAll('.notebook-slide'));
      allSlides.forEach(function(el, idx) {
        if (idx === index) {
          el.style.display = 'flex';
          el.style.visibility = 'visible';
          el.style.zIndex = '15';
          el.style.opacity = '1';
          el.classList.add('active');
        } else {
          el.style.display = 'none';
          el.style.visibility = 'hidden';
          el.style.zIndex = '1';
          el.style.opacity = '0';
          el.classList.remove('active');
        }
      });

      var numEl = document.getElementById('slide-index-view');
      if (numEl) {
        numEl.textContent = (index + 1 < 10 ? '0' : '') + (index + 1);
      }

      window.scrollTo(0, 0);
      document.body.offsetHeight;
    };

    window.nextSlide = function() {
      if (currentSlideIndex < totalSlides - 1) {
        showSlide(currentSlideIndex + 1);
      }
    };

    window.prevSlide = function() {
      if (currentSlideIndex > 0) {
        showSlide(currentSlideIndex - 1);
      }
    };

    window.addEventListener('keydown', function(e) {
      switch (e.key) {
        case 'ArrowRight':
          e.preventDefault();
          ${isRTL ? 'prevSlide();' : 'nextSlide();'}
          break;

        case 'ArrowLeft':
          e.preventDefault();
          ${isRTL ? 'nextSlide();' : 'prevSlide();'}
          break;

        case 'ArrowDown':
        case 'PageDown':
        case ' ':
        case 'n':
        case 'N':
          e.preventDefault();
          nextSlide();
          break;

        case 'ArrowUp':
        case 'PageUp':
        case 'p':
        case 'P':
          e.preventDefault();
          prevSlide();
          break;

        case 'Home':
          e.preventDefault();
          showSlide(0);
          break;

        case 'End':
          e.preventDefault();
          showSlide(totalSlides - 1);
          break;
      }
    });

    showSlide(0);
  </script>
</body>
</html>`;
}