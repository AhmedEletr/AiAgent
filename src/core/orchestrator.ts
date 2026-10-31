import { groq, GROQ_MODELS } from "../services/groq.js";
import { AstroMemoryManager } from "./memory.js";
import { runAstroCast } from "../subagents/astroCast.js";
import { runAstroPaint } from "../subagents/astroPaint.js";
import { runAstroWebSearch, runAstroImageSearch } from "../subagents/astroSearch.js";
import { runAstroQuiz } from "../subagents/astroQuiz.js";
import { runAstroNotes } from "../subagents/astroNotes.js";
import { runAstroDocs, editAstroDocs, getActiveDocId } from "../subagents/astroDocs.js";
import { runAstroSlides, editAstroSlides, getActiveDeckId } from "../subagents/astroSlides.js";
import { runAstroVeo } from "../subagents/astroVeo.js";
import { streamGeminiContent } from "../services/gemini.js";

export type ProgressCallback = (percent: number, message: string) => void;

interface RouterDecision {
  targetAgent:
    | "AstroVeo"
    | "AstroCast"
    | "AstroDocs"
    | "AstroDocsEdit"
    | "AstroSlides"
    | "AstroSlidesEdit"
    | "AstroQuiz"
    | "AstroNotes"
    | "AstroPaint"
    | "AstroSearch"
    | "AstroChat";
  language: "en" | "ar" | "de" | "fr";
  extractedTask: string;
  requestedMinutes: number;
}

// Automatically records streamed assistant responses to memory
async function* autoRecordStream(
  stream: AsyncGenerator<string, void, unknown>,
  onComplete: (accumulatedText: string) => void
) {
  let fullResponse = "";
  for await (const chunk of stream) {
    fullResponse += chunk;
    yield chunk;
  }
  if (fullResponse.trim()) {
    onComplete(fullResponse);
  }
}

// Fully localized UI receipts for sub-agent outputs
const LOCALIZED_MESSAGES: Record<string, Record<string, (...args: any[]) => string>> = {
  ar: {
    videoReady: (dur: string, path: string) =>
      `🎬 فيديو الماستر كلاس جاهز!\n🎞️ المدة: ${dur}\n📁 مسار الفيديو: ${path}`,
    podcastReady: (min: number, turns: number, path: string) =>
      `🎙️ الملخص الصوتي جاهز (${min} دقائق)!\n💬 عدد الحوارات: ${turns} جولة\n🎵 مسار الصوت: ${path}`,
    docReady: (pdf: string, html: string) =>
      `📄 الملف الأكاديمي الشامل جاهز!\n📁 ملف PDF: ${pdf}\n🌐 ملف HTML: ${html}`,
    docEditReady: (v: number, pdf: string) =>
      `✨ تم تحديث الملف للإصدار ${v}!\n📁 PDF الجديد: ${pdf}`,
    slidesReady: (html: string, pptx: string, total: number) =>
      `🖥️ العرض التقديمي التنفيذي جاهز (${total} شريحة كاملة)!\n📊 ملف الباوربوينت القابل للتعديل بالكامل (.pptx):\n📁 ${pptx}\n🌐 العرض التفاعلي بالمتصفح (.html):\n📁 ${html}\n💡 استخدم الأسهم (⬅️ ➡️) للتنقل التفاعلي!`,
    slidesEditReady: (v: number, html: string, pptx: string) =>
      `✨ تم تحديث العرض بنجاح إلى الإصدار رقم ${v}!\n📊 ملف الباوربوينت المحدث (.pptx): ${pptx}\n🌐 العرض التفاعلي المحدث (.html): ${html}`,
    paintReady: (url: string) =>
      `🎨 تم إنشاء الصورة بنجاح!\n🔗 الرابط الدائم: ${url}`,
    quizReady: (title: string, path: string) =>
      `🎯 تم إنشاء الاختبار (${title})!\n📁 المسار: ${path}`,
    notesReady: (path: string) =>
      `📝 الملاحظات الدراسية جاهزة!\n📄 الملف: ${path}`,
    searchReady: (w: number, img: number, q: string) =>
      `🔍 تم العثور على ${w} مصادر موثوقة و ${img} صور متعلقة بموضوع "${q}".`
  },
  en: {
    videoReady: (dur: string, path: string) =>
      `🎬 Masterclass Video Ready!\n🎞️ Duration: ${dur}\n📁 Video File: ${path}`,
    podcastReady: (min: number, turns: number, path: string) =>
      `🎙️ Audio Overview Ready (${min} mins)!\n💬 Total Exchanges: ${turns} turns\n🎵 Audio File: ${path}`,
    docReady: (pdf: string, html: string) =>
      `📄 Grounded 15-Page Dossier Ready!\n📁 PDF: ${pdf}\n🌐 HTML: ${html}`,
    docEditReady: (v: number, pdf: string) =>
      `✨ Document Updated to Version ${v}!\n📁 New PDF: ${pdf}`,
    slidesReady: (html: string, pptx: string, total: number) =>
      `🖥️ 20-Slide White Executive Presentation Deck Ready!\n📊 100% Editable PowerPoint (.pptx):\n📁 ${pptx}\n🌐 Interactive HTML Deck (.html):\n📁 ${html}\n💡 Tip: Use Left/Right Arrow keys to navigate!`,
    slidesEditReady: (v: number, html: string, pptx: string) =>
      `✨ Presentation Updated to Version ${v}!\n📊 Updated PowerPoint (.pptx): ${pptx}\n🌐 Updated HTML Deck (.html): ${html}`,
    paintReady: (url: string) =>
      `🎨 Illustration Generated!\n🔗 Permanent Link: ${url}`,
    quizReady: (title: string, path: string) =>
      `🎯 10-Question Exam Ready for "${title}"!\n📁 Saved: ${path}`,
    notesReady: (path: string) =>
      `📝 Study Notes Ready!\n📄 Markdown File: ${path}`,
    searchReady: (w: number, img: number, q: string) =>
      `🔍 Found ${w} verified web sources and ${img} images for "${q}".`
  },
  fr: {
    videoReady: (dur: string, path: string) =>
      `🎬 Vidéo Masterclass Prête !\n🎞️ Durée : ${dur}\n📁 Fichier : ${path}`,
    podcastReady: (min: number, turns: number, path: string) =>
      `🎙️ Aperçu Audio Prêt (${min} mins) !\n💬 Tours : ${turns}\n🎵 Fichier : ${path}`,
    docReady: (pdf: string, html: string) =>
      `📄 Dossier Académique Prêt !\n📁 PDF : ${pdf}\n🌐 HTML : ${html}`,
    docEditReady: (v: number, pdf: string) =>
      `✨ Document Mis à Jour (v${v}) !\n📁 PDF : ${pdf}`,
    slidesReady: (html: string, pptx: string, total: number) =>
      `🖥️ Diaporama Exécutif de 20 Diapositives Prêt !\n📊 PowerPoint Modifiable (.pptx) : ${pptx}\n🌐 Présentation HTML (.html) : ${html}\n💡 Utilisez les flèches pour naviguer !`,
    slidesEditReady: (v: number, html: string, pptx: string) =>
      `✨ Présentation Mise à Jour (v${v}) !\n📊 Nouveau PowerPoint (.pptx) : ${pptx}\n🌐 Nouveau HTML (.html) : ${html}`,
    paintReady: (url: string) =>
      `🎨 Illustration Générée !\n🔗 Lien : ${url}`,
    quizReady: (title: string, path: string) =>
      `🎯 Examen Prêt pour "${title}" !\n📁 Sauvegardé : ${path}`,
    notesReady: (path: string) =>
      `📝 Notes de Révision Prêtes !\n📄 Fichier : ${path}`,
    searchReady: (w: number, img: number, q: string) =>
      `🔍 Trouvé ${w} sources et ${img} images pour "${q}".`
  },
  de: {
    videoReady: (dur: string, path: string) =>
      `🎬 Masterclass-Video Fertig!\n🎞️ Dauer: ${dur}\n📁 Datei: ${path}`,
    podcastReady: (min: number, turns: number, path: string) =>
      `🎙️ Audio-Überblick Fertig (${min} Min.)!\n💬 Dialogrunden: ${turns}\n🎵 Datei: ${path}`,
    docReady: (pdf: string, html: string) =>
      `📄 15-seitiges Dossier Fertig!\n📁 PDF: ${pdf}\n🌐 HTML: ${html}`,
    docEditReady: (v: number, pdf: string) =>
      `✨ Dokument Aktualisiert auf v${v}!\n📁 PDF: ${pdf}`,
    slidesReady: (html: string, pptx: string, total: number) =>
      `🖥️ 20-Folien Executive Präsentation Bereit!\n📊 Bearbeitbares PowerPoint (.pptx) : ${pptx}\n🌐 Interaktives HTML (.html) : ${html}\n💡 Pfeiltasten zum Navigieren verwenden!`,
    slidesEditReady: (v: number, html: string, pptx: string) =>
      `✨ Präsentation Aktualisiert auf v${v}!\n📊 Neues PowerPoint (.pptx) : ${pptx}\n🌐 Neues HTML (.html) : ${html}`,
    paintReady: (url: string) =>
      `🎨 Illustration Generiert!\n🔗 Link : ${url}`,
    quizReady: (title: string, path: string) =>
      `🎯 Prüfung Bereit für "${title}"!\n📁 Gespeichert: ${path}`,
    notesReady: (path: string) =>
      `📝 Lernnotizen Bereit!\n📄 Datei: ${path}`,
    searchReady: (w: number, img: number, q: string) =>
      `🔍 ${w} Quellen und ${img} Bilder für "${q}" gefunden.`
  }
};

const MASTER_ROUTER_SYSTEM_PROMPT = `
You are the Master AI Orchestrator for "AstroMind A1".
Analyze the student's CURRENT prompt, determine their exact intent and active language, and output strict JSON.

CRITICAL LANGUAGE DETECTION RULES:
1. CURRENT PROMPT LANGUAGE: Check the language of the student's CURRENT message:
   - If they wrote in English (e.g. "do a video about james webb", "create presentation slides"), set "language": "en".
   - If they wrote in Arabic (Standard or Egyptian dialect, e.g. "اشرحلي", "اعمل برزنتيشن", "اعمل فيديو"), set "language": "ar".
   - If French, "fr". If German, "de".
2. EXPLICIT LANGUAGE OVERRIDE: If the student explicitly specifies a language (e.g. "in Arabic", "بالعربي", "in English", "en français"), honor that requested language regardless of the prompt.
3. DO NOT stay stuck in past conversation language if the student switched to another language right now!

SUB-AGENT CAPABILITIES:
- "AstroSlides": SLIDES, presentation deck, PowerPoint presentation (.pptx), or interactive HTML slides (.html).
- "AstroSlidesEdit": Modifying an active presentation deck (e.g. change colors, edit slide text, add chart).
- "AstroVeo": Educational VIDEO, masterclass video (.mp4).
- "AstroCast": AUDIO overview, podcast, or spoken discussion (.mp3). (Extract requestedMinutes, default: 5).
- "AstroDocs": Formal 15-page PDF dossier / printable report (.pdf).
- "AstroDocsEdit": Editing an active PDF dossier.
- "AstroQuiz": MCQ exam or quiz questions.
- "AstroNotes": Cornell revision notes or exam traps.
- "AstroPaint": Generating or painting an illustration / image.
- "AstroSearch": Looking up live web links or photos online.
- "AstroChat": Conversational explanations, questions, translations, math, or study dialogue.

Output valid JSON ONLY:
{
  "targetAgent": "AstroSlides" | "AstroSlidesEdit" | "AstroVeo" | "AstroCast" | "AstroDocs" | "AstroDocsEdit" | "AstroQuiz" | "AstroNotes" | "AstroPaint" | "AstroSearch" | "AstroChat",
  "language": "ar" | "en" | "de" | "fr",
  "extractedTask": "Pure topic query without meta commands (resolve 'it' using context)",
  "requestedMinutes": number (default 5, max 40)
}
`;

async function callRouterModel(
  userInput: string,
  memory: AstroMemoryManager
): Promise<RouterDecision> {
  const routerMessages: any[] = [
    { role: "system", content: MASTER_ROUTER_SYSTEM_PROMPT },
    ...memory.getRecentHistoryForRouter(),
    { role: "user", content: userInput }
  ];

  let rawJson = "{}";

  try {
    const completion = await groq.chat.completions.create({
      model: GROQ_MODELS.ROUTER,
      messages: routerMessages,
      response_format: { type: "json_object" },
      temperature: 0.0
    });
    rawJson = completion.choices[0]?.message?.content || "{}";
  } catch {
    const fallback = await groq.chat.completions.create({
      model: GROQ_MODELS.FALLBACK,
      messages: routerMessages,
      response_format: { type: "json_object" },
      temperature: 0.0
    });
    rawJson = fallback.choices[0]?.message?.content || "{}";
  }

  const parsed = JSON.parse(rawJson);
  const detectedLang = ["ar", "en", "de", "fr"].includes(parsed.language) ? parsed.language : "en";

  return {
    targetAgent: parsed.targetAgent || "AstroChat",
    language: detectedLang,
    extractedTask: parsed.extractedTask || userInput,
    requestedMinutes: typeof parsed.requestedMinutes === "number" ? parsed.requestedMinutes : 5
  };
}

export async function processAstroMindQuery(
  userInput: string,
  memory: AstroMemoryManager,
  onProgress?: ProgressCallback
): Promise<{
  agent: string;
  language: string;
  message?: string;
  streamGenerator?: AsyncGenerator<string, void, unknown>;
  data?: any;
}> {
  onProgress?.(5, "Understanding intent and language...");
  const decision = await callRouterModel(userInput, memory);

  memory.updateState({
    detectedLanguage: decision.language,
    activeTopic: decision.extractedTask.slice(0, 35)
  });

  const lang = decision.language;
  const msgCatalog = LOCALIZED_MESSAGES[lang] || LOCALIZED_MESSAGES.en;

  let subAgentResult: any = null;
  let finalMessage: string = "";

  switch (decision.targetAgent) {
    case "AstroSlides":
      memory.addTurn("user", userInput);
      onProgress?.(20, "Synthesizing 20-Slide White Presentation (HTML + Native PPTX)...");
      subAgentResult = await runAstroSlides({
        prompt: decision.extractedTask,
        language: decision.language
      });
      finalMessage = msgCatalog.slidesReady(subAgentResult.htmlPath, subAgentResult.pptxPath, subAgentResult.totalSlides);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroSlidesEdit":
      memory.addTurn("user", userInput);
      onProgress?.(25, "Refactoring presentation deck (HTML + PPTX)...");
      subAgentResult = await editAstroSlides({
        instruction: decision.extractedTask,
        targetDeckId: getActiveDeckId() || undefined
      });
      finalMessage = msgCatalog.slidesEditReady(subAgentResult.version, subAgentResult.htmlPath, subAgentResult.pptxPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroVeo":
      memory.addTurn("user", userInput);
      subAgentResult = await runAstroVeo(
        { prompt: decision.extractedTask, language: decision.language },
        onProgress
      );
      finalMessage = msgCatalog.videoReady(subAgentResult.durationFormatted, subAgentResult.videoPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroCast":
      memory.addTurn("user", userInput);
      subAgentResult = await runAstroCast(
        decision.extractedTask,
        decision.language,
        decision.requestedMinutes,
        onProgress
      );
      finalMessage = msgCatalog.podcastReady(subAgentResult.durationMinutes, subAgentResult.totalTurns, subAgentResult.audioPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroDocs":
      memory.addTurn("user", userInput);
      onProgress?.(15, "Grounding research & compiling 15-Page Dossier...");
      subAgentResult = await runAstroDocs({
        prompt: decision.extractedTask,
        language: decision.language
      });
      memory.updateState({ activeDocId: subAgentResult.docId });
      finalMessage = msgCatalog.docReady(subAgentResult.pdfPath, subAgentResult.htmlPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroDocsEdit":
      memory.addTurn("user", userInput);
      onProgress?.(25, "Refactoring active dossier state...");
      subAgentResult = await editAstroDocs({
        instruction: decision.extractedTask,
        targetDocId: getActiveDocId() || undefined
      });
      finalMessage = msgCatalog.docEditReady(subAgentResult.version, subAgentResult.pdfPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroPaint":
      memory.addTurn("user", userInput);
      onProgress?.(20, "Synthesizing illustration via Cloudflare Flux...");
      subAgentResult = await runAstroPaint(decision.extractedTask);
      finalMessage = msgCatalog.paintReady(subAgentResult.permanentUrl);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroQuiz":
      memory.addTurn("user", userInput);
      onProgress?.(25, "Formulating balanced 10-Question Exam...");
      subAgentResult = await runAstroQuiz({
        topic: decision.extractedTask,
        language: decision.language
      });
      finalMessage = msgCatalog.quizReady(subAgentResult.quiz_title, subAgentResult.savedPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroNotes":
      memory.addTurn("user", userInput);
      onProgress?.(25, "Synthesizing Cornell Study Notes & Exam Traps...");
      subAgentResult = await runAstroNotes({
        topic: decision.extractedTask,
        language: decision.language
      });
      finalMessage = msgCatalog.notesReady(subAgentResult.savedMarkdownPath);
      memory.addTurn("model", finalMessage);
      break;

    case "AstroSearch": {
      memory.addTurn("user", userInput);
      onProgress?.(30, "Browsing live web index & images...");
      const [web, images] = await Promise.all([
        runAstroWebSearch(decision.extractedTask),
        runAstroImageSearch(decision.extractedTask)
      ]);
      subAgentResult = { web, images };
      finalMessage = msgCatalog.searchReady(web.length, images.length, decision.extractedTask);
      memory.addTurn("model", finalMessage);
      break;
    }

    case "AstroChat":
    default: {
      const conversationHistory = memory.getGeminiContents(userInput);
      memory.addTurn("user", userInput);

      const humanizedSystemPrompt = `
You are a brilliant, warm, and natural human study mentor and friend.

CONVERSATIONAL RULES:
1. NO ROBOTIC INTRODUCTIONS: NEVER start with boilerplate like "Hello! I am AstroMind A1...", "منور يا بطل", etc. Jump straight into the point naturally.
2. CONTINUOUS MEMORY: You have complete access to the full conversation history. Always recall past questions, topics, and explanations.
3. LANGUAGE CONSISTENCY: Respond strictly in the student's detected language (${decision.language}).
   - If Arabic: Speak in natural, smart Egyptian Arabic ("مصري سالك وذكي").
   - If English: Speak in warm, clear, conversational, and direct English.
`;

      const rawStream = streamGeminiContent(conversationHistory, humanizedSystemPrompt);
      const monitoredStream = autoRecordStream(rawStream, (fullResponse) => {
        memory.addTurn("model", fullResponse);
      });

      return {
        agent: "AstroChat",
        language: decision.language,
        streamGenerator: monitoredStream
      };
    }
  }

  return {
    agent: decision.targetAgent,
    language: decision.language,
    message: finalMessage,
    data: subAgentResult
  };
}