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

function tokens(text: string) {
  return new Set(
    normalize(text)
      .split(' ')
      .filter((word) => word.length > 2),
  );
}

function similarity(a: string, b: string) {
  const aa = tokens(a);
  const bb = tokens(b);
  if (!aa.size || !bb.size) return 0;
  let intersection = 0;
  aa.forEach((word) => {
    if (bb.has(word)) intersection += 1;
  });
  const overlap = intersection / Math.max(aa.size, bb.size);
  const containment = intersection / Math.min(aa.size, bb.size);
  return Math.max(overlap, containment * 0.82);
}

export function questionIsDuplicate(question: Question, previous: Question[]) {
  const fingerprint = questionFingerprint(question);
  return previous.some((old) => {
    if (questionFingerprint(old) === fingerprint) return true;
    // 0.58 catches paraphrases such as "Who was the mother of Karna?"
    // and "Karna's mother was who?" without requiring exact wording.
    return similarity(question.prompt, old.prompt) >= 0.58;
  });
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
  const uniqueOptions = Array.isArray(q.options)
    ? new Set(q.options.map((option) => normalize(String(option)))).size === 4
    : false;
  return (
    typeof q.category === 'string' &&
    ['Vedas', 'Itihasa', 'Puranas', 'Tattva', 'Darshana', 'Tirtha'].includes(q.category) &&
    typeof q.level === 'number' &&
    q.level >= 1 &&
    q.level <= 5 &&
    typeof q.prompt === 'string' &&
    q.prompt.trim().length >= 20 &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    uniqueOptions &&
    q.options.every((x) => typeof x === 'string' && x.trim()) &&
    typeof q.answer === 'number' &&
    q.answer >= 0 &&
    q.answer <= 3 &&
    Number.isInteger(q.answer) &&
    typeof q.explanation === 'string' &&
    q.explanation.trim().length >= 10
  );
}

async function geminiText(prompt: string, json = false, useGoogleSearch = false) {
  if (!API_KEY) throw new Error('EXPO_PUBLIC_GEMINI_API_KEY is not configured.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 45000);
  try {
    const body: Record<string, unknown> = {
      contents: [{ parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0.75,
        ...(json ? { responseMimeType: 'application/json' } : {}),
      },
    };

    // Gemini's Google Search grounding performs live web retrieval and gives
    // the model source-backed context before it writes the question set.
    if (useGoogleSearch) {
      body.tools = [{ google_search: {} }];
    }

    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const responseBody = await response.text().catch(() => '');
      throw new Error(`Gemini HTTP ${response.status}: ${responseBody.slice(0, 300)}`);
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
  const previous = previousQuestions
    .slice(-500)
    .map((q) => `- ${q.prompt}`)
    .join('\n');

  const prompt = `
You are the verified question engine for a Sanatana Dharma knowledge quiz.
Generate exactly ${count} COMPLETELY NEW multiple-choice questions.
Language: ${language === 'hi' ? 'Hindi' : 'English'}.
Difficulty distribution: exactly 6 questions at each level 1,2,3,4,5 when count is 30.
For other counts, distribute levels as evenly as possible.

IMPORTANT — SOURCE AND ACCURACY:
- Use Google Search grounding before writing the questions.
- Prefer primary/classical or reputable reference material: Vedic/Upanishadic text repositories, established Indological references, official temple or government cultural sources, and reputable academic/reference sources.
- Do not rely on a single low-quality blog, social-media post, SEO page, or unsourced claim when a stronger source is available.
- If sources disagree on a traditional detail, do not manufacture certainty; choose a well-attested fact instead.
- Do not create fake quotations, fake chapter/verse numbers, or invented scripture references.

IMPORTANT — NEVER REPEAT:
- Do not repeat, paraphrase, reverse, or trivially reword ANY previous question.
- Treat questions asking the same underlying fact in a different sentence as duplicates.
- Do not reuse a question merely by changing the options, language, or order.
- Do not ask the same entity/fact from another wording if the knowledge tested is essentially identical.

FORMAT:
- Each question must have exactly 4 unique options and exactly one correct answer.
- answer is the zero-based option index.
- Keep explanations concise and factual.
- category must be one of: Vedas, Itihasa, Puranas, Tattva, Darshana, Tirtha.
- Return ONLY a JSON array. No markdown, no commentary.

Previous questions that are permanently unavailable:
${previous || '- (none)'}
`;

  const text = await geminiText(prompt, true, true);
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
    if (
      !result.some((x) => x.id === normalized.id) &&
      !questionIsDuplicate(normalized, previousQuestions) &&
      !questionIsDuplicate(normalized, result)
    ) {
      result.push(normalized);
    }
  }

  const byLevel = new Map<number, Question[]>();
  for (let level = 1; level <= 5; level += 1) {
    byLevel.set(level, result.filter((q) => q.level === level));
  }
  if ([1, 2, 3, 4, 5].some((level) => (byLevel.get(level)?.length || 0) < 3)) {
    throw new Error('Google-grounded Gemini did not produce enough unique questions at every difficulty level.');
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
