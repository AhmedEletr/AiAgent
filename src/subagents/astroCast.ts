import { EdgeTTS } from "node-edge-tts";
import { MsEdgeTTS, OUTPUT_FORMAT } from "msedge-tts";
import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import process from "node:process";
import ffmpeg from "fluent-ffmpeg";
import ffmpegStatic from "ffmpeg-static";
import { gemini, GEMINI_MODELS } from "../services/gemini.js";

const resolvedFfmpeg = typeof ffmpegStatic === "string" ? ffmpegStatic : ((ffmpegStatic as any)?.path || (ffmpegStatic as any)?.default);
if (resolvedFfmpeg) ffmpeg.setFfmpegPath(resolvedFfmpeg);

const LANGUAGES = {
  ar: {
    code: "ar-EG",
    name: "Arabic (Egyptian Dialect - عامية مصرية)",
    femaleVoice: "ar-EG-SalmaNeural",
    maleVoice: "ar-EG-ShakirNeural",
    styleGuide: `Language: Egyptian Colloquial Arabic. Clean text, no Tashkeel. Natural banter: "يا نهار ابيض!", "بص بقى يا سيدي", "يا راجل كبر مخك", "ايوة بالظبط كده!".`
  },
  en: {
    code: "en-US",
    name: "English (US)",
    femaleVoice: "en-US-JennyNeural",
    maleVoice: "en-US-GuyNeural",
    styleGuide: "NotebookLM Audio Overview style. Fast-paced, witty, engaging podcast banter."
  },
  de: {
    code: "de-DE",
    name: "German (Deutsch)",
    femaleVoice: "de-DE-KatjaNeural",
    maleVoice: "de-DE-ConradNeural",
    styleGuide: "Modern German podcast dialogue: 'Echt jetzt?', 'Warte mal kurz...'."
  },
  fr: {
    code: "fr-FR",
    name: "French (Français)",
    femaleVoice: "fr-FR-DeniseNeural",
    maleVoice: "fr-FR-HenriNeural",
    styleGuide: "Natural Parisian dialogue: 'Attends une seconde...', 'C'est un truc de fou !'."
  }
};

export type ProgressCallback = (percent: number, message: string) => void;

// Robust synthesis with dual fallback and file-size verification
async function synthesizeSingleTurn(
  text: string,
  voice: string,
  langCode: string,
  outputPath: string
): Promise<boolean> {
  const cleanText = text.replace(/[<>&'"]/g, " ").trim();
  if (!cleanText) return false;

  // Attempt 1: node-edge-tts (direct promise)
  try {
    const tts = new EdgeTTS({
      voice,
      lang: langCode,
      outputFormat: "audio-24khz-48kbitrate-mono-mp3"
    });
    await Promise.race([
      tts.ttsPromise(cleanText, outputPath),
      new Promise((_, reject) => setTimeout(() => reject(new Error("TTS Timeout")), 9000))
    ]);

    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 500) return true;
    }
  } catch {
    // Fallback to msedge-tts
  }

  // Attempt 2: msedge-tts stream
  try {
    const tts = new MsEdgeTTS();
    await tts.setMetadata(voice, OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3);
    const streamRes = tts.toStream(cleanText);
    const audioStream = (streamRes as any)?.audioStream || streamRes;
    const writeStream = fs.createWriteStream(outputPath);

    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        writeStream.destroy();
        reject(new Error("TTS Timeout"));
      }, 9000);

      audioStream.pipe(writeStream);
      writeStream.on("finish", () => {
        clearTimeout(timeout);
        resolve();
      });
      writeStream.on("error", (err) => {
        clearTimeout(timeout);
        reject(err);
      });
      audioStream.on("error", (err: any) => {
        clearTimeout(timeout);
        reject(err);
      });
    });

    if (fs.existsSync(outputPath)) {
      const stat = fs.statSync(outputPath);
      if (stat.size > 500) return true;
    }
  } catch {
    return false;
  }

  return false;
}

// Resamples from 24kHz to standard 44.1kHz with a valid Xing header for macOS QuickTime
function concatenateAndEncodeMp3(
  audioFiles: string[],
  outputPath: string,
  tempDir: string
): Promise<void> {
  return new Promise((resolve, reject) => {
    const validFiles = audioFiles.filter((f) => fs.existsSync(f) && fs.statSync(f).size > 500);

    if (validFiles.length === 0) {
      return reject(new Error("No valid audio chunks were generated"));
    }

    const manifestPath = path.join(tempDir, "audio_manifest.txt");
    const manifestLines = validFiles.map((f) => `file '${path.resolve(f).replace(/\\/g, "/").replace(/'/g, "'\\''")}'`);
    fs.writeFileSync(manifestPath, manifestLines.join("\n"), "utf-8");

    ffmpeg()
      .input(manifestPath)
      .inputOptions(["-f", "concat", "-safe", "0"])
      .outputOptions([
        "-c:a", "libmp3lame",
        "-b:a", "192k",
        "-ar", "44100",        // Converts 24kHz to 44.1kHz (fixes macOS QuickTime error)
        "-id3v2_version", "3",  // ID3v2.3 standard tags
        "-write_xing", "1"      // Generates Xing duration header
      ])
      .save(outputPath)
      .on("end", () => resolve())
      .on("error", (err) => {
        // Fallback: merge buffers directly if FFmpeg is busy
        try {
          const buffers: Buffer[] = [];
          for (const vf of validFiles) {
            buffers.push(fs.readFileSync(vf));
          }
          fs.writeFileSync(outputPath, Buffer.concat(buffers));
          resolve();
        } catch {
          reject(err);
        }
      });
  });
}

export async function runAstroCast(
  topic: string,
  languageKey: string = "ar",
  requestedMinutes: number = 5,
  onProgress?: ProgressCallback
): Promise<{ audioPath: string; scriptPath: string; durationMinutes: number; totalTurns: number }> {
  // Default is 5 minutes, capped strictly at 40
  const durationMinutes = Math.max(1, Math.min(40, requestedMinutes || 5));
  const targetWords = durationMinutes * 150;
  // Calculate appropriate exchange count based on requested duration
  const minTurns = Math.round(durationMinutes * 4);
  const maxTurns = Math.round(durationMinutes * 5.5);

  const normLang = (languageKey || "ar").toLowerCase();
  const selectedLang = LANGUAGES[normLang as keyof typeof LANGUAGES] || LANGUAGES.ar;

  onProgress?.(15, `Scripting ~${durationMinutes}-min podcast (~${targetWords} words) in ${selectedLang.name}...`);

  const prompt = `
You are the executive showrunner for an educational two-host podcast episode (Woman & Man).
Topic: "${topic}".
Language strictly: ${selectedLang.name}.
Target Duration: ~${durationMinutes} minutes (Target Volume: ~${targetWords} words total).
Guidelines: ${selectedLang.styleGuide}

Pacing & Volume Rules:
- You must generate between ${minTurns} and ${maxTurns} back-and-forth dialogue exchanges.
- 10 turns is NOT enough for a ${durationMinutes}-minute episode; you must provide thorough, engaging dialogue with authentic banter, analogies, and questions to fill the time.
- Each dialogue turn should be 25 to 45 words.

Return STRICT JSON matching this schema:
{
  "podcastTitle": "Episode Title",
  "dialogue": [
    { "speaker": "woman", "emotion": "curious", "text": "turn text" },
    { "speaker": "man", "emotion": "excited", "text": "turn text" }
  ]
}
`;

  const geminiResponse = await gemini.models.generateContent({
    model: GEMINI_MODELS.FLASH,
    contents: prompt,
    config: { responseMimeType: "application/json" }
  });

  const parsedScript = JSON.parse(geminiResponse.text || "{}");
  const dialogue = parsedScript.dialogue || [];

  const outputDir = path.join(process.cwd(), "storage", "audio");
  const tempDir = path.join(outputDir, `temp_cast_${Date.now()}`);
  await fsp.mkdir(outputDir, { recursive: true });
  await fsp.mkdir(tempDir, { recursive: true });

  onProgress?.(30, `Synthesizing ${dialogue.length} dialogue turns with Edge-TTS...`);

  const chunkPaths: string[] = [];
  const CONCURRENCY = 3;

  for (let i = 0; i < dialogue.length; i += CONCURRENCY) {
    const batch = dialogue.slice(i, i + CONCURRENCY);
    await Promise.all(
      batch.map(async (turn: any, bIdx: number) => {
        const turnIdx = i + bIdx;
        const isWoman = turn.speaker.toLowerCase() === "woman";
        const voice = isWoman ? selectedLang.femaleVoice : selectedLang.maleVoice;
        const tempChunk = path.join(tempDir, `turn_${String(turnIdx).padStart(4, "0")}.mp3`);

        await synthesizeSingleTurn(turn.text, voice, selectedLang.code, tempChunk);
        chunkPaths[turnIdx] = tempChunk;
      })
    );

    const pct = 30 + Math.round(((i + batch.length) / dialogue.length) * 55);
    onProgress?.(pct, `Synthesizing Audio Turns (${Math.min(i + CONCURRENCY, dialogue.length)}/${dialogue.length})...`);
  }

  // Resample and encode to standard 44.1kHz MP3 with Xing duration header
  onProgress?.(90, "Resampling to 44.1kHz & building Xing header for QuickTime...");
  const finalAudioPath = path.join(outputDir, `podcast_${durationMinutes}min_${Date.now()}.mp3`);
  const finalScriptPath = path.join(outputDir, `script_${durationMinutes}min_${Date.now()}.json`);

  await concatenateAndEncodeMp3(chunkPaths, finalAudioPath, tempDir);
  await fsp.writeFile(finalScriptPath, JSON.stringify(parsedScript, null, 2), "utf-8");

  await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  onProgress?.(100, "Audio Overview Ready!");

  return {
    audioPath: finalAudioPath,
    scriptPath: finalScriptPath,
    durationMinutes,
    totalTurns: dialogue.length
  };
}