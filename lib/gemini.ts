import type { Question, QuestionCategory } from '@/data/questions';
import type { Language } from '@/data/translations';

const MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-2.5-flash-lite';
const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function questionFingerprint(question: Pick<Question, 'prompt'>) {
  return normalize(question.prompt);
}

function stableId(question: Question) {
  const source = `${question.category}|${question.level}|${normalize(question.prompt)}`;
  let hash = 2166136261;
  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `gemini-${(hash >>> 0).toString(16)}`;
}

function validateQuestion(value: unknown): value is Question {
  if (!value || typeof value !== 'object') return false;
  const q = value as Partial<Question>;
  return (
    typeof q.category === 'string' &&
    typeof q.level === 'number' &&
    q.level >= 1 &&
    q.level <= 5 &&
    typeof q.prompt === 'string' &&
    q.prompt.trim().length >= 20 &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    q.options.every((x) => typeof x === 'string' && x.trim()) &&
    typeof q.answer === 'number' &&
    q.answer >= 0 &&
    q.answer <= 3 &&
    Number.isInteger(q.answer) &&
    typeof q.explanation === 'string' &&
    q.explanation.trim().length >= 10
  );
}

function similarity(a: string, b: string) {
  const aa = new Set(normalize(a).split(' ').filter((x) => x.length > 2));
  const bb = new Set(normalize(b).split(' ').filter((x) => x.length > 2));
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  aa.forEach((word) => { if (bb.has(word)) intersection += 1; });
  return intersection / Math.max(aa.size, bb.size);
}

function isDuplicate(question: Question, previous: Question[]) {
  const fp = questionFingerprint(question);
  return previous.some((old) => questionFingerprint(old) === fp || similarity(question.prompt, old.prompt) >= 0.72);
}

async function geminiText(prompt: string, json = false) {
  if (!API_KEY) throw new Error('EXPO_PUBLIC_GEMINI_API_KEY is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.95,
            ...(json ? { responseMimeType: 'application/json' } : {}),
          },
        }),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new Error(`Gemini HTTP ${response.status}: ${body.slice(0, 300)}`);
    }
    const data = await response.json();
    const text = data?.candidates?.[0]?.content?.parts?.map((p: { text?: string }) => p.text || '').join('') || '';
    if (!text) throw new Error('Gemini returned no text.');
    return text;
  } finally {
    clearTimeout(timeout);
  }
}

export async function generateOnlineQuestions(
  previousQuestions: Question[],
  language: Language,
  count = 30,
): Promise<Question[]> {
  const previous = previousQuestions.slice(-300).map((q) => q.prompt).join('\n- ');
  const prompt = `
You are the question engine for a Sanatana Dharma knowledge quiz.
Generate exactly ${count} COMPLETELY NEW multiple-choice questions.
Language: ${language === 'hi' ? 'Hindi' : 'English'}.
Difficulty distribution MUST be exactly 6 questions at each level 1,2,3,4,5.
Level 1 = easy factual recall.
Level 2 = basic understanding.
Level 3 = intermediate.
Level 4 = advanced.
Level 5 = expert, precise textual/traditional knowledge.

Topics: Vedas, Upanishads, Itihasa, Puranas, Darshana, Shakta, Shaiva, Vaishnava traditions, Tirtha and related classical Sanatana Dharma subjects.

Rules:
- Do not repeat or paraphrase any previous question.
- Do not create fake quotations or invented scripture references.
- Each question must have exactly 4 options and exactly one correct answer.
- The answer field is the zero-based option index.
- Keep explanations concise and factual.
- Return ONLY a JSON array. No markdown.
- category must be one of: Vedas, Itihasa, Puranas, Tattva, Darshana, Tirtha.
Previous questions to avoid:
- ${previous || '(none)'}
`;

  const text = await geminiText(prompt, true);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Gemini did not return valid JSON.');
    parsed = JSON.parse(match[0]);
  }
  if (!Array.isArray(parsed)) throw new Error('Gemini response is not an array.');

  const result: Question[] = [];
  for (const raw of parsed) {
    if (!validateQuestion(raw)) continue;
    const q = raw as Question;
    const normalized: Question = {
      ...q,
      category: q.category as QuestionCategory,
      id: stableId(q),
    };
    if (!result.some((x) => x.id === normalized.id) && !isDuplicate(normalized, previousQuestions) && !isDuplicate(normalized, result)) {
      result.push(normalized);
    }
  }

  const byLevel = new Map<number, Question[]>();
  for (let level = 1; level <= 5; level += 1) byLevel.set(level, result.filter((q) => q.level === level));
  if ([1, 2, 3, 4, 5].some((level) => (byLevel.get(level)?.length || 0) < 3)) {
    throw new Error('Gemini did not produce enough unique questions at every difficulty level.');
  }
  return result;
}

export async function generateOnlineQuestion(round: number, previousQuestions: Question[], language: Language = 'en'): Promise<Question> {
  const targetLevel = Math.min(5, Math.floor((round - 1) / 3) + 1);
  const generated = await generateOnlineQuestions(previousQuestions, language, 10);
  const match = generated.find((q) => q.level === targetLevel);
  if (!match) throw new Error('No question at requested difficulty.');
  return match;
}

export async function askMuniSalah(question: Question, selectedOptions: string[], language: Language = 'en') {
  const prompt = `
Give concise quiz guidance for this Sanatana Dharma question.
Language: ${language === 'hi' ? 'Hindi' : 'English'}.
Question: ${question.prompt}
Options: ${question.options.join(' | ')}
Selected: ${selectedOptions.join(' | ')}
Correct option: ${question.options[question.answer]}
Explain why the correct option is correct in 2-3 sentences. Do not invent citations.
`;
  return geminiText(prompt);
}
