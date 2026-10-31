import fs from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { groq, GROQ_MODELS } from "../services/groq.js";

export interface QuizQuestion {
  id: number;
  question: string;
  options: {
    A: string;
    B: string;
    C: string;
    D: string;
  };
  correct_answer: "A" | "B" | "C" | "D";
  explanation: string;
}

export interface QuizPayload {
  quiz_title: string;
  topic: string;
  difficulty: "easy" | "medium" | "hard";
  language: string;
  questions: QuizQuestion[];
  savedPath?: string;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: "English",
  ar: "Arabic (العربية)",
  ja: "Japanese (日本語)",
  jp: "Japanese (日本語)",
  de: "German (Deutsch)",
  fr: "French (Français)"
};

export async function runAstroQuiz(params: {
  topic: string;
  difficulty?: "easy" | "medium" | "hard";
  language?: string;
}): Promise<QuizPayload> {
  const topic = params.topic.trim();
  const difficulty = params.difficulty || "medium";
  const langKey = (params.language || "en").toLowerCase();
  const languageName = LANGUAGE_NAMES[langKey] || "English";

  const systemMessage = `You are a helpful assistant designed to output JSON. You are an expert exam author.

Strict Rules:
1. Always output a single valid JSON object.
2. Generate exactly 10 questions.
3. Every question must have exactly 4 choices: "A", "B", "C", and "D".
4. ANTI-CHEAT RULE (EQUAL LENGTH): All 4 choices for each question MUST be roughly the same character length. Never make the correct answer noticeably longer, more descriptive, or more detailed than the distractors.
5. All questions, options, and explanations must be written fluently in ${languageName}.`;

  const userMessage = `Create a 10-question MCQ quiz about "${topic}" with difficulty level "${difficulty}".

You must return valid JSON matching this schema:
{
  "quiz_title": "Quiz Title",
  "topic": "${topic}",
  "difficulty": "${difficulty}",
  "language": "${langKey}",
  "questions": [
    {
      "id": 1,
      "question": "Question text here?",
      "options": {
        "A": "Choice A text",
        "B": "Choice B text",
        "C": "Choice C text",
        "D": "Choice D text"
      },
      "correct_answer": "A",
      "explanation": "Brief 1-sentence reason."
    }
  ]
}`;

  const completion = await groq.chat.completions.create({
    messages: [
      { role: "system", content: systemMessage },
      { role: "user", content: userMessage }
    ],
    model: GROQ_MODELS.ROUTER, // Uses llama-3.3-70b-versatile
    temperature: 0.5,
    max_tokens: 4096,
    response_format: { type: "json_object" }
  });

  const rawContent = completion.choices[0]?.message?.content || "{}";
  const cleanedContent = rawContent.replace(/```json/g, "").replace(/```/g, "").trim();
  const quizData: QuizPayload = JSON.parse(cleanedContent);

  // Save to storage
  const outputDir = path.join(process.cwd(), "storage", "docs");
  await fs.mkdir(outputDir, { recursive: true });

  const fileName = `quiz_${Date.now()}.json`;
  const savedPath = path.join(outputDir, fileName);
  await fs.writeFile(savedPath, JSON.stringify(quizData, null, 2), "utf-8");

  quizData.savedPath = savedPath;
  return quizData;
}