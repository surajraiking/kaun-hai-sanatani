import { GoogleGenAI } from "@google/genai";
import type { Question } from "../data/questions";

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;
const MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || "gemini-3.8-flash";

if (!API_KEY) {
  console.warn(
    "[Gemini] EXPO_PUBLIC_GEMINI_API_KEY is missing. Online question generation is disabled."
  );
}

const ai = API_KEY ? new GoogleGenAI({ apiKey: API_KEY }) : null;

export type GeneratedQuestion = Question & {
  source?: string;
  sourceUrl?: string;
};

type GenerateQuestionsOptions = {
  language?: "hi" | "en";
  count?: number;
  excludeIds?: string[];
  excludeFingerprints?: string[];
  previousQuestions?: Array<{
    question: string;
    answer?: string;
  }>;
};

function cleanJson(text: string): string {
  return text
    .replace(/^```json\s*/i, "")
    .replace(/^```\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}

function fingerprint(question: {
  question: string;
  answer?: string;
}): string {
  return `${question.question}|${question.answer ?? ""}`
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

function normalizeQuestion(
  raw: any,
  language: "hi" | "en"
): GeneratedQuestion | null {
  if (!raw || typeof raw !== "object") return null;

  const question = String(
    raw.question ?? raw.questionText ?? raw.q ?? ""
  ).trim();

  const answer = String(
    raw.answer ?? raw.correctAnswer ?? raw.correct ?? ""
  ).trim();

  const options = Array.isArray(raw.options)
    ? raw.options.map((x: unknown) => String(x).trim()).filter(Boolean)
    : [];

  if (!question || !answer || options.length < 4) {
    return null;
  }

  const cleanedOptions = [...new Set(options)];

  if (cleanedOptions.length !== 4) {
    return null;
  }

  const correctIndex = cleanedOptions.findIndex(
    (option) =>
      option.toLowerCase() === answer.toLowerCase()
  );

  if (correctIndex < 0) {
    return null;
  }

  return {
    id:
      typeof raw.id === "string" && raw.id.trim()
        ? raw.id.trim()
        : `ai-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    question,
    options: cleanedOptions,
    answer: cleanedOptions[correctIndex],
    explanation: String(raw.explanation ?? "").trim(),
    category: String(raw.category ?? "Sanatan Dharma").trim(),
    difficulty: raw.difficulty ?? "medium",
    language,
  } as GeneratedQuestion;
}

async function generateBatch(
  options: GenerateQuestionsOptions
): Promise<GeneratedQuestion[]> {
  if (!ai) {
    throw new Error(
      "Gemini API key missing. Add EXPO_PUBLIC_GEMINI_API_KEY to .env."
    );
  }

  const language = options.language ?? "hi";
  const count = Math.min(Math.max(options.count ?? 5, 1), 10);

  const excludedIds = new Set(options.excludeIds ?? []);
  const excludedFingerprints = new Set(options.excludeFingerprints ?? []);

  const previousText =
    options.previousQuestions
      ?.slice(-100)
      .map(
        (q, index) =>
          `${index + 1}. ${q.question}${q.answer ? ` — ${q.answer}` : ""}`
      )
      .join("\n") || "NONE";

  const languageInstruction =
    language === "hi"
      ? "पूरे प्रश्न, विकल्प, उत्तर और explanation शुद्ध, सरल और स्वाभाविक हिंदी में लिखो।"
      : "Write the question, options, answer and explanation in clear English.";

  const prompt = `
You are generating factual Sanatan Dharma quiz questions.

TASK:
Generate exactly ${count} completely different multiple-choice questions.

${languageInstruction}

IMPORTANT:
1. Questions must be factually defensible.
2. Prefer primary/authoritative sources and established Hindu scriptures/traditional sources.
3. Use Google Search grounding before deciding factual claims.
4. Do NOT invent scripture references.
5. Do NOT repeat any previous question.
6. Do NOT create a superficial paraphrase of a previous question.
7. The central fact tested must be different.
8. Exactly 4 options.
9. Exactly one correct answer.
10. The "answer" field MUST exactly match one of the four options.
11. Give a concise explanation.
12. Avoid controversial claims unless they can be clearly sourced.
13. Do not use current politics.
14. Do not output markdown.
15. Return ONLY valid JSON.

PREVIOUS QUESTIONS:
${previousText}

PREVIOUS QUESTION IDs TO AVOID:
${[...excludedIds].join(", ") || "NONE"}

PREVIOUS FINGERPRINTS TO AVOID:
${[...excludedFingerprints].slice(-300).join("\n") || "NONE"}

JSON FORMAT:
{
  "questions": [
    {
      "question": "...",
      "options": ["...", "...", "...", "..."],
      "answer": "...",
      "explanation": "...",
      "category": "...",
      "difficulty": "easy"
    }
  ]
}

Difficulty should be one of:
easy
medium
hard
`;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: prompt,
    config: {
      thinkingConfig: {
        thinkingLevel: "low",
      },
      tools: [
        {
          googleSearch: {},
        },
      ],
    },
  });

  const text = response.text?.trim();

  if (!text) {
    throw new Error("Gemini returned an empty response.");
  }

  let parsed: any;

  try {
    parsed = JSON.parse(cleanJson(text));
  } catch {
    throw new Error(
      "Gemini returned invalid JSON. Please try generating again."
    );
  }

  const rawQuestions = Array.isArray(parsed)
    ? parsed
    : Array.isArray(parsed.questions)
      ? parsed.questions
      : [];

  const result: GeneratedQuestion[] = [];
  const localFingerprints = new Set<string>();

  for (const raw of rawQuestions) {
    const question = normalizeQuestion(raw, language);

    if (!question) continue;

    const fp = fingerprint(question);

    if (excludedIds.has(question.id)) continue;
    if (excludedFingerprints.has(fp)) continue;
    if (localFingerprints.has(fp)) continue;

    localFingerprints.add(fp);
    result.push(question);
  }

  return result;
}

export async function generateUniqueQuestions(
  options: GenerateQuestionsOptions = {}
): Promise<GeneratedQuestion[]> {
  const target = Math.min(Math.max(options.count ?? 15, 1), 15);

  const collected: GeneratedQuestion[] = [];

  const usedIds = new Set(options.excludeIds ?? []);
  const usedFingerprints = new Set(options.excludeFingerprints ?? []);

  // Up to 5 smaller requests.
  // This is intentionally not one large request because smaller batches
  // make duplicate filtering and retrying much more reliable.
  for (let attempt = 0; attempt < 5 && collected.length < target; attempt++) {
    const remaining = target - collected.length;

    const batch = await generateBatch({
      ...options,
      count: Math.min(remaining + 2, 7),
      excludeIds: [...usedIds],
      excludeFingerprints: [...usedFingerprints],
      previousQuestions: [
        ...(options.previousQuestions ?? []),
        ...collected.map((q) => ({
          question: q.question,
          answer: q.answer,
        })),
      ],
    });

    if (batch.length === 0) {
      continue;
    }

    for (const question of batch) {
      const fp = fingerprint(question);

      if (usedIds.has(question.id)) continue;
      if (usedFingerprints.has(fp)) continue;

      usedIds.add(question.id);
      usedFingerprints.add(fp);
      collected.push(question);

      if (collected.length >= target) break;
    }
  }

  if (collected.length < target) {
    throw new Error(
      `Only ${collected.length} unique questions could be generated. Please try again.`
    );
  }

  return collected;
}

// Backward-compatible function name.
// If existing app code calls generateQuestions(), it will continue working.
export async function generateQuestions(
  count = 15,
  language: "hi" | "en" = "hi",
  excludeIds: string[] = [],
  excludeFingerprints: string[] = [],
  previousQuestions: Array<{ question: string; answer?: string }> = []
) {
  return generateUniqueQuestions({
    count,
    language,
    excludeIds,
    excludeFingerprints,
    previousQuestions,
  });
}
