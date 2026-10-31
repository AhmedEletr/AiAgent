import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { groq, GROQ_MODELS } from "../services/groq.js";

export interface StudyNotesPayload {
  title: string;
  topic: string;
  language: string;
  executiveSummary: string;
  coreConcepts: Array<{
    heading: string;
    explanation: string;
    bulletPoints: string[];
  }>;
  terminology: Array<{
    term: string;
    definition: string;
  }>;
  examTraps: string[];
  memoryMnemonics: string[];
  savedMarkdownPath?: string;
  savedJsonPath?: string;
}

const LANGUAGE_MAP: Record<string, string> = {
  ar: "Arabic (العربية)",
  en: "English",
  de: "German (Deutsch)",
  fr: "French (Français)",
  ja: "Japanese (日本語)"
};

export async function runAstroNotes(params: {
  topic: string;
  language?: string;
}): Promise<StudyNotesPayload> {
  const topic = params.topic.trim();
  const langKey = (params.language || "ar").toLowerCase();
  const langName = LANGUAGE_MAP[langKey] || "Arabic (العربية)";

  const systemPrompt = `You are "AstroNotes", an elite academic revision synthesizer for university and high school students.
Strict Rules:
1. Output valid JSON ONLY matching the requested schema.
2. Anti-Fluff: Deliver high-density, easily memorable, and scientifically accurate study material.
3. Write completely in ${langName}.
4. Specifically highlight "examTraps" (common mistakes students make on exams regarding this topic).`;

  const userPrompt = `Generate comprehensive, high-yield study notes for: "${topic}".

Return JSON conforming strictly to this schema:
{
  "title": "Clear Topic Title",
  "topic": "${topic}",
  "language": "${langKey}",
  "executiveSummary": "2-3 concise sentences summarizing the whole concept.",
  "coreConcepts": [
    {
      "heading": "Concept Name",
      "explanation": "Clear explanation",
      "bulletPoints": ["Key detail 1", "Key detail 2"]
    }
  ],
  "terminology": [
    { "term": "Term 1", "definition": "Direct definition" }
  ],
  "examTraps": [
    "Common student mistake or trick question point"
  ],
  "memoryMnemonics": [
    "Memory anchor or easy way to memorize this rule"
  ]
}`;

  const completion = await groq.chat.completions.create({
    model: GROQ_MODELS.ROUTER,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ],
    temperature: 0.3,
    response_format: { type: "json_object" }
  });

  const notesData: StudyNotesPayload = JSON.parse(completion.choices[0]?.message?.content || "{}");

  // Generate clean Markdown format for student download
  let mdContent = `# 📚 ${notesData.title}\n\n`;
  mdContent += `> **Summary:** ${notesData.executiveSummary}\n\n`;
  mdContent += `## 💡 Core Concepts\n`;
  notesData.coreConcepts?.forEach((c) => {
    mdContent += `### ${c.heading}\n${c.explanation}\n`;
    c.bulletPoints?.forEach((bp) => (mdContent += `- ${bp}\n`));
    mdContent += `\n`;
  });

  mdContent += `## 📖 Key Terminology\n`;
  notesData.terminology?.forEach((t) => {
    mdContent += `- **${t.term}**: ${t.definition}\n`;
  });

  mdContent += `\n## ⚠️ Common Exam Traps\n`;
  notesData.examTraps?.forEach((trap) => (mdContent += `- ⚠️ ${trap}\n`));

  mdContent += `\n## 🧠 Memory Anchors & Mnemonics\n`;
  notesData.memoryMnemonics?.forEach((m) => (mdContent += `- 💡 ${m}\n`));

  // Save files
  const outputDir = path.join(process.cwd(), "storage", "docs");
  await fs.mkdir(outputDir, { recursive: true });

  const timestamp = Date.now();
  const mdPath = path.join(outputDir, `notes_${timestamp}.md`);
  const jsonPath = path.join(outputDir, `notes_${timestamp}.json`);

  await fs.writeFile(mdPath, mdContent, "utf-8");
  await fs.writeFile(jsonPath, JSON.stringify(notesData, null, 2), "utf-8");

  notesData.savedMarkdownPath = mdPath;
  notesData.savedJsonPath = jsonPath;

  return notesData;
}