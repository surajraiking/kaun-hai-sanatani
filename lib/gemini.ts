import type { Question, QuestionCategory } from '@/data/questions';
import type { Language } from '@/data/translations';
import { cacheGeneratedQuestions, readProgress } from '@/lib/storage';

const MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

const REQUEST_TIMEOUT_MS = 45_000;
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY_MS = 2_000;
const MAX_PREVIOUS_QUESTIONS = 500;
const DEFAULT_BATCH_SIZE = 30;
const RESPONSE_CACHE_TTL_MS = 10 * 60 * 1000;

let activeGeminiRequest: Promise<string> | null = null;
const responseCache = new Map<string, { value: string; expiresAt: number }>();

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}

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
  return new Set(normalize(text).split(' ').filter((word) => word.length > 2));
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

function detectQuestionLanguage(question: Question): Language | 'unknown' {
  const text = question.prompt;
  const devanagariCount = (text.match(/[\u0900-\u097F]/g) || []).length;
  const latinCount = (text.match(/[A-Za-z]/g) || []).length;

  if (devanagariCount > latinCount && devanagariCount >= 3) return 'hi';
  if (latinCount > 0) return 'en';
  return 'unknown';
}

function matchesLanguage(question: Question, language: Language) {
  const detected = detectQuestionLanguage(question);
  return detected === 'unknown' || detected === language;
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
    Number.isInteger(q.level) &&
    q.level >= 1 &&
    q.level <= 5 &&
    typeof q.prompt === 'string' &&
    q.prompt.trim().length >= 20 &&
    Array.isArray(q.options) &&
    q.options.length === 4 &&
    uniqueOptions &&
    q.options.every((x) => typeof x === 'string' && x.trim().length > 0) &&
    typeof q.answer === 'number' &&
    Number.isInteger(q.answer) &&
    q.answer >= 0 &&
    q.answer <= 3 &&
    typeof q.explanation === 'string' &&
    q.explanation.trim().length >= 10
  );
}

function stableCacheKey(prompt: string, json: boolean, useGoogleSearch: boolean) {
  return `${MODEL}|${json ? 'json' : 'text'}|${useGoogleSearch ? 'search' : 'plain'}|${normalize(prompt)}`;
}

function getRetryDelay(attempt: number, retryAfterHeader?: string | null) {
  if (retryAfterHeader) {
    const seconds = Number(retryAfterHeader);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(seconds * 1000, 60_000);
    }

    const retryDate = Date.parse(retryAfterHeader);
    if (!Number.isNaN(retryDate)) {
      const delay = retryDate - Date.now();
      if (delay > 0) return Math.min(delay, 60_000);
    }
  }

  const exponential = BASE_RETRY_DELAY_MS * Math.pow(2, attempt);
  const jitter = Math.floor(Math.random() * 500);
  return Math.min(exponential + jitter, 30_000);
}

function isRetryableStatus(status: number, body: string) {
  if (status === 429) {
    const lower = body.toLowerCase();
    if (
      lower.includes('quota_exceeded') ||
      lower.includes('daily quota') ||
      lower.includes('per day')
    ) {
      return false;
    }
    return true;
  }

  return status === 500 || status === 502 || status === 503 || status === 504;
}

function isRetryableNetworkError(error: Error) {
  return (
    error.name === 'AbortError' ||
    /network|fetch|timeout|connection|temporarily unavailable/i.test(error.message)
  );
}

async function performGeminiRequest(prompt: string, json = false, useGoogleSearch = false) {
  if (!API_KEY) {
    throw new Error('EXPO_PUBLIC_GEMINI_API_KEY is not configured.');
  }

  const cacheKey = stableCacheKey(prompt, json, useGoogleSearch);
  const cached = responseCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) return cached.value;
  if (cached) responseCache.delete(cacheKey);

  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const body: Record<string, unknown> = {
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          thinkingConfig: {
            thinkingLevel: 'low',
          },
          ...(json ? { responseMimeType: 'application/json' } : {}),
        },
      };

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

      const responseBody = await response.text().catch(() => '');

      if (response.ok) {
        let data: unknown;
        try {
          data = JSON.parse(responseBody);
        } catch {
          throw new Error('Gemini returned invalid JSON response.');
        }

        const text =
          (data as any)?.candidates?.[0]?.content?.parts
            ?.map((part: { text?: string }) => part.text || '')
            .join('') || '';

        if (!text) throw new Error('Gemini returned no text.');

        responseCache.set(cacheKey, {
          value: text,
          expiresAt: Date.now() + RESPONSE_CACHE_TTL_MS,
        });

        return text;
      }

      if (isRetryableStatus(response.status, responseBody) && attempt < MAX_RETRIES) {
        const delay = getRetryDelay(attempt, response.headers.get('Retry-After'));
        console.warn(
          `[Gemini] HTTP ${response.status}. Retry ${attempt + 1}/${MAX_RETRIES} in ${Math.ceil(delay / 1000)}s.`,
        );
        await sleep(delay);
        continue;
      }

      const lowerBody = responseBody.toLowerCase();
      if (response.status === 429 && (lowerBody.includes('quota_exceeded') || lowerBody.includes('daily quota'))) {
        throw new Error(
          'Gemini daily quota has been reached. Cached questions will be used when available; otherwise wait for the quota reset or increase the API quota.',
        );
      }

      throw new Error(`Gemini HTTP ${response.status}: ${responseBody.slice(0, 500)}`);
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < MAX_RETRIES && isRetryableNetworkError(lastError)) {
        const delay = getRetryDelay(attempt);
        console.warn(`[Gemini] Temporary network error. Retry in ${Math.ceil(delay / 1000)}s.`);
        await sleep(delay);
        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError || new Error('Gemini request failed.');
}

async function geminiText(prompt: string, json = false, useGoogleSearch = false) {
  if (activeGeminiRequest) {
    console.warn('[Gemini] Request already running; waiting for the active request.');
    return activeGeminiRequest;
  }

  const request = performGeminiRequest(prompt, json, useGoogleSearch);
  activeGeminiRequest = request;

  try {
    return await request;
  } finally {
    if (activeGeminiRequest === request) activeGeminiRequest = null;
  }
}

function buildPreviousQuestionText(questions: Question[]) {
  return questions
    .slice(-MAX_PREVIOUS_QUESTIONS)
    .map((q) => `- ${q.prompt}`)
    .join('\n');
}

function parseQuestionArray(text: string): unknown[] {
  try {
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) throw new Error('Gemini response is not an array.');
    return parsed;
  } catch {
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('Gemini did not return valid JSON.');
    const parsed = JSON.parse(match[0]);
    if (!Array.isArray(parsed)) throw new Error('Gemini response is not an array.');
    return parsed;
  }
}

function normalizeGeneratedQuestions(parsed: unknown[], previousQuestions: Question[]) {
  const result: Question[] = [];

  for (const raw of parsed) {
    if (!validateQuestion(raw)) continue;

    const q = raw as Question;
    const normalized: Question = {
      ...q,
      category: q.category as QuestionCategory,
      id: stableId(q),
    };

    if (result.some((x) => x.id === normalized.id)) continue;
    if (questionIsDuplicate(normalized, previousQuestions)) continue;
    if (questionIsDuplicate(normalized, result)) continue;

    result.push(normalized);
  }

  return result;
}

async function getCachedQuestions(previousQuestions: Question[], language: Language) {
  const progress = await readProgress();
  const allKnown = [...previousQuestions, ...(progress.generatedQuestions || [])];
  const unique = new Map<string, Question>();

  for (const question of allKnown) {
    if (validateQuestion(question)) unique.set(question.id, question);
  }

  const usedIds = new Set(progress.usedQuestionIds);
  const usedFingerprints = new Set(progress.usedQuestionFingerprints);

  return [...unique.values()].filter(
    (question) =>
      !usedIds.has(question.id) &&
      !usedFingerprints.has(questionFingerprint(question)) &&
      matchesLanguage(question, language),
  );
}

export async function generateOnlineQuestions(
  previousQuestions: Question[],
  language: Language,
  count = DEFAULT_BATCH_SIZE,
): Promise<Question[]> {
  const cached = await getCachedQuestions(previousQuestions, language);

  if (cached.length >= count) {
    console.info(`[Gemini] Cache hit: using ${count} unused cached questions.`);
    return cached.slice(0, count);
  }

  const progress = await readProgress();
  const permanentlyKnown = [...previousQuestions, ...(progress.generatedQuestions || [])];
  const knownFingerprints = new Set([
    ...permanentlyKnown.map(questionFingerprint),
    ...progress.usedQuestionFingerprints,
  ]);

  const needed = Math.max(10, count - cached.length);
  const generationCount = Math.min(30, Math.max(needed + 5, 10));

  const previous = buildPreviousQuestionText(permanentlyKnown);
  const levelDistribution =
    generationCount === 30
      ? 'exactly 6 questions at each level 1,2,3,4,5'
      : 'distribute levels 1,2,3,4,5 as evenly as possible';

  const prompt = `
You are the verified question engine for a Sanatana Dharma knowledge quiz.

Generate exactly ${generationCount} COMPLETELY NEW multiple-choice questions.
Language: ${language === 'hi' ? 'Hindi' : 'English'}.
Difficulty distribution: ${levelDistribution}.

ACCURACY:
- Use Google Search grounding before writing the questions.
- Prefer primary/classical or reputable academic, cultural, temple, government, or reference sources.
- If traditions or sources differ, choose a well-attested fact and do not manufacture certainty.
- Never invent quotations, chapter numbers, verse numbers, or scripture references.

DUPLICATE PREVENTION:
- Never repeat or paraphrase any previous question.
- Do not test the same underlying fact with different wording or options.
- Do not reuse the same entity/fact merely from another angle when the tested knowledge is essentially identical.
- Every question must test a genuinely different piece of knowledge.

QUALITY:
- Exactly 4 unique options and exactly 1 correct answer.
- answer is the zero-based option index 0-3.
- category is exactly one of Vedas, Itihasa, Puranas, Tattva, Darshana, Tirtha.
- level is an integer 1-5.
- Explanation is concise and factual.
- No trick questions, all-of-the-above, or none-of-the-above.

OUTPUT:
Return ONLY a JSON array. No markdown and no commentary.

Each object:
{
  "category": "Itihasa",
  "level": 2,
  "prompt": "Question...",
  "options": ["Option A", "Option B", "Option C", "Option D"],
  "answer": 0,
  "explanation": "Concise factual explanation."
}

PREVIOUS QUESTIONS THAT ARE PERMANENTLY UNAVAILABLE:
${previous || '- (none)'}
`;

  let text: string;
  try {
    text = await geminiText(prompt, true, true);
  } catch (error) {
    if (cached.length > 0) {
      console.warn('[Gemini] API failed; returning cached questions instead.', error);
      return cached.slice(0, count);
    }
    throw error;
  }

  const parsed = parseQuestionArray(text);
  const fresh = normalizeGeneratedQuestions(parsed, permanentlyKnown);

  const filteredFresh = fresh.filter((question) => {
    const fingerprint = questionFingerprint(question);
    if (knownFingerprints.has(fingerprint)) return false;
    knownFingerprints.add(fingerprint);
    return true;
  });

  if (filteredFresh.length > 0) {
    await cacheGeneratedQuestions(filteredFresh);
  }

  const combined: Question[] = [];
  for (const question of [...cached, ...filteredFresh]) {
    if (combined.some((x) => x.id === question.id)) continue;
    if (questionIsDuplicate(question, combined)) continue;
    combined.push(question);
  }

  if (combined.length === 0) {
    throw new Error('Gemini did not produce any new usable questions.');
  }

  return combined.slice(0, count);
}

export async function generateOnlineQuestion(
  round: number,
  previousQuestions: Question[],
  language: Language = 'en',
): Promise<Question> {
  const targetLevel = Math.min(5, Math.floor((round - 1) / 3) + 1);
  const cached = await getCachedQuestions(previousQuestions, language);
  const cachedMatch = cached.find((q) => q.level === targetLevel);
  if (cachedMatch) return cachedMatch;

  const generated = await generateOnlineQuestions(previousQuestions, language, 10);
  const match = generated.find((q) => q.level === targetLevel && matchesLanguage(q, language));
  if (match) return match;

  const fallback = generated.find((q) => matchesLanguage(q, language));
  if (fallback) return fallback;

  throw new Error('No unique question is available at the requested difficulty.');
}

export async function askMuniSalah(
  question: Question,
  selectedOptions: string[],
  language: Language = 'en',
) {
  const prompt = `
Give concise quiz guidance for this Sanatana Dharma question.
Language: ${language === 'hi' ? 'Hindi' : 'English'}.
Question: ${question.prompt}
Options: ${question.options.join(' | ')}
Selected: ${selectedOptions.join(' | ')}
Correct option: ${question.options[question.answer]}
Explain why the correct option is correct in 2-3 sentences.
Do not invent citations or scripture references.
`;

  return geminiText(prompt, false, false);
}
