import type { Question, QuestionCategory } from '@/data/questions';
import type { Language } from '@/data/translations';
import {
  cacheGeneratedQuestions,
  readProgress,
} from '@/lib/storage';

/**
 * ============================================================
 * GEMINI CONFIGURATION
 * ============================================================
 */

const MODEL =
  process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-3.8-flash';

const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

/**
 * Gemini request timeout.
 */
const REQUEST_TIMEOUT_MS = 45_000;

/**
 * Maximum number of retries after a temporary API failure.
 *
 * Total attempts:
 * 1 initial + 3 retries = 4 attempts.
 */
const MAX_RETRIES = 3;

/**
 * Base retry delay.
 *
 * Actual delays use exponential backoff:
 * 2s → 4s → 8s
 */
const BASE_RETRY_DELAY_MS = 2_000;

/**
 * Maximum number of questions permanently remembered
 * in the prompt.
 *
 * This prevents the prompt from becoming excessively large.
 */
const MAX_PREVIOUS_QUESTIONS = 500;

/**
 * Number of questions generated in a normal batch.
 */
const DEFAULT_BATCH_SIZE = 30;

/**
 * Prevent multiple Gemini requests from being fired
 * simultaneously from rapid button presses.
 */
let activeGeminiRequest: Promise<string> | null = null;


/**
 * ============================================================
 * BASIC HELPERS
 * ============================================================
 */

function sleep(ms: number) {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}


/**
 * Fingerprint of a question.
 *
 * Used for permanent duplicate detection.
 */
export function questionFingerprint(
  question: Pick<Question, 'prompt'>,
) {
  return normalize(question.prompt);
}


/**
 * ============================================================
 * LANGUAGE DETECTION
 * ============================================================
 *
 * Question type does not currently contain a language field,
 * therefore we use the script of the prompt when deciding
 * whether cached questions can be reused.
 */

function detectQuestionLanguage(
  question: Question,
): Language | 'unknown' {
  const text = question.prompt;

  const devanagariMatches = text.match(/[\u0900-\u097F]/g);
  const latinMatches = text.match(/[A-Za-z]/g);

  const devanagariCount = devanagariMatches?.length || 0;
  const latinCount = latinMatches?.length || 0;

  if (devanagariCount > latinCount && devanagariCount >= 3) {
    return 'hi';
  }

  if (latinCount > 0) {
    return 'en';
  }

  return 'unknown';
}

function matchesLanguage(
  question: Question,
  language: Language,
) {
  const detected = detectQuestionLanguage(question);

  if (detected === 'unknown') {
    return true;
  }

  return detected === language;
}


/**
 * ============================================================
 * TOKEN / SIMILARITY DUPLICATE DETECTION
 * ============================================================
 */

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

  if (!aa.size || !bb.size) {
    return 0;
  }

  let intersection = 0;

  aa.forEach((word) => {
    if (bb.has(word)) {
      intersection += 1;
    }
  });

  const overlap =
    intersection / Math.max(aa.size, bb.size);

  const containment =
    intersection / Math.min(aa.size, bb.size);

  return Math.max(
    overlap,
    containment * 0.82,
  );
}


/**
 * Returns true if question is already represented
 * by another question.
 */
export function questionIsDuplicate(
  question: Question,
  previous: Question[],
) {
  const fingerprint = questionFingerprint(question);

  return previous.some((old) => {
    const oldFingerprint =
      questionFingerprint(old);

    /**
     * Exact normalized duplicate.
     */
    if (oldFingerprint === fingerprint) {
      return true;
    }

    /**
     * Paraphrase duplicate.
     *
     * Example:
     * "Who was the mother of Karna?"
     *
     * and
     *
     * "Karna's mother was who?"
     */
    return (
      similarity(
        question.prompt,
        old.prompt,
      ) >= 0.58
    );
  });
}


/**
 * ============================================================
 * STABLE QUESTION ID
 * ============================================================
 */

function stableId(question: Question) {
  const source =
    `${question.category}|${question.level}|${normalize(question.prompt)}`;

  let hash = 2166136261;

  for (let i = 0; i < source.length; i += 1) {
    hash ^= source.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return `gemini-${(hash >>> 0).toString(16)}`;
}


/**
 * ============================================================
 * QUESTION VALIDATION
 * ============================================================
 */

function validateQuestion(
  value: unknown,
): value is Question {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const q = value as Partial<Question>;

  const uniqueOptions =
    Array.isArray(q.options)
      ? new Set(
          q.options.map((option) =>
            normalize(String(option)),
          ),
        ).size === 4
      : false;

  return (
    typeof q.category === 'string' &&
    [
      'Vedas',
      'Itihasa',
      'Puranas',
      'Tattva',
      'Darshana',
      'Tirtha',
    ].includes(q.category) &&

    typeof q.level === 'number' &&
    q.level >= 1 &&
    q.level <= 5 &&

    typeof q.prompt === 'string' &&
    q.prompt.trim().length >= 20 &&

    Array.isArray(q.options) &&
    q.options.length === 4 &&
    uniqueOptions &&

    q.options.every(
      (x) =>
        typeof x === 'string' &&
        x.trim().length > 0,
    ) &&

    typeof q.answer === 'number' &&
    q.answer >= 0 &&
    q.answer <= 3 &&
    Number.isInteger(q.answer) &&

    typeof q.explanation === 'string' &&
    q.explanation.trim().length >= 10
  );
}


/**
 * ============================================================
 * RETRY HELPERS
 * ============================================================
 */

function getRetryDelay(
  attempt: number,
  retryAfterHeader?: string | null,
) {
  /**
   * Respect server-provided Retry-After when available.
   *
   * It can be either:
   * - seconds
   * - HTTP date
   */
  if (retryAfterHeader) {
    const seconds = Number(
      retryAfterHeader,
    );

    if (
      Number.isFinite(seconds) &&
      seconds >= 0
    ) {
      return Math.min(
        seconds * 1000,
        60_000,
      );
    }

    const retryDate =
      Date.parse(retryAfterHeader);

    if (!Number.isNaN(retryDate)) {
      const delay =
        retryDate - Date.now();

      if (delay > 0) {
        return Math.min(
          delay,
          60_000,
        );
      }
    }
  }

  /**
   * Exponential backoff:
   *
   * attempt 0 → 2 sec
   * attempt 1 → 4 sec
   * attempt 2 → 8 sec
   */
  const exponential =
    BASE_RETRY_DELAY_MS *
    Math.pow(2, attempt);

  /**
   * Small jitter prevents several clients
   * retrying at exactly the same moment.
   */
  const jitter =
    Math.floor(Math.random() * 500);

  return Math.min(
    exponential + jitter,
    30_000,
  );
}

function shouldRetryStatus(
  status: number,
) {
  return (
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}


/**
 * ============================================================
 * GEMINI HTTP REQUEST
 * ============================================================
 */

async function performGeminiRequest(
  prompt: string,
  json = false,
  useGoogleSearch = false,
) {
  if (!API_KEY) {
    throw new Error(
      'EXPO_PUBLIC_GEMINI_API_KEY is not configured.',
    );
  }

  let lastError: Error | null = null;

  for (
    let attempt = 0;
    attempt <= MAX_RETRIES;
    attempt += 1
  ) {
    const controller =
      new AbortController();

    const timeout = setTimeout(
      () => controller.abort(),
      REQUEST_TIMEOUT_MS,
    );

    try {
      const body: Record<string, unknown> = {
        contents: [
          {
            parts: [
              {
                text: prompt,
              },
            ],
          },
        ],

        generationConfig: {
          /**
           * Slightly lower temperature makes
           * factual quiz generation more consistent.
           */
          temperature: 0.55,

          ...(json
            ? {
                responseMimeType:
                  'application/json',
              }
            : {}),
        },
      };

      /**
       * Google Search grounding.
       */
      if (useGoogleSearch) {
        body.tools = [
          {
            google_search: {},
          },
        ];
      }

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`,
        {
          method: 'POST',

          headers: {
            'Content-Type':
              'application/json',

            'x-goog-api-key':
              API_KEY,
          },

          body: JSON.stringify(body),

          signal: controller.signal,
        },
      );

      const responseBody =
        await response.text().catch(
          () => '',
        );

      if (response.ok) {
        let data: any;

        try {
          data = JSON.parse(
            responseBody,
          );
        } catch {
          throw new Error(
            'Gemini returned invalid JSON response.',
          );
        }

        const text =
          data?.candidates?.[0]
            ?.content?.parts
            ?.map(
              (part: {
                text?: string;
              }) => part.text || '',
            )
            .join('') || '';

        if (!text) {
          throw new Error(
            'Gemini returned no text.',
          );
        }

        return text;
      }

      /**
       * Temporary error.
       */
      if (
        shouldRetryStatus(
          response.status,
        ) &&
        attempt < MAX_RETRIES
      ) {
        const delay =
          getRetryDelay(
            attempt,
            response.headers.get(
              'Retry-After',
            ),
          );

        console.warn(
          `[Gemini] HTTP ${response.status}. ` +
            `Retrying in ${Math.ceil(
              delay / 1000,
            )}s ` +
            `(attempt ${
              attempt + 1
            }/${MAX_RETRIES}).`,
        );

        await sleep(delay);

        continue;
      }

      /**
       * Final error.
       */
      const shortBody =
        responseBody.slice(0, 500);

      throw new Error(
        `Gemini HTTP ${
          response.status
        }: ${shortBody}`,
      );
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error(
              String(error),
            );

      /**
       * Abort / timeout.
       */
      const isAbort =
        lastError.name ===
        'AbortError';

      /**
       * Retry network/timeout failures.
       */
      if (
        attempt < MAX_RETRIES &&
        (
          isAbort ||
          /network|fetch|timeout/i.test(
            lastError.message,
          )
        )
      ) {
        const delay =
          getRetryDelay(
            attempt,
          );

        console.warn(
          `[Gemini] Temporary network error. ` +
            `Retrying in ${Math.ceil(
              delay / 1000,
            )}s.`,
        );

        await sleep(delay);

        continue;
      }

      throw lastError;
    } finally {
      clearTimeout(timeout);
    }
  }

  throw (
    lastError ||
    new Error(
      'Gemini request failed.',
    )
  );
}


/**
 * ============================================================
 * SINGLE REQUEST LOCK
 * ============================================================
 *
 * If user rapidly presses Start twice, both calls should NOT
 * create two simultaneous Gemini requests.
 */

async function geminiText(
  prompt: string,
  json = false,
  useGoogleSearch = false,
) {
  if (activeGeminiRequest) {
    console.warn(
      '[Gemini] Another request is already running. Waiting for it.',
    );

    return activeGeminiRequest;
  }

  const request =
    performGeminiRequest(
      prompt,
      json,
      useGoogleSearch,
    );

  activeGeminiRequest = request;

  try {
    return await request;
  } finally {
    if (
      activeGeminiRequest === request
    ) {
      activeGeminiRequest = null;
    }
  }
}


/**
 * ============================================================
 * BUILD PREVIOUS QUESTION LIST
 * ============================================================
 */

function buildPreviousQuestionText(
  questions: Question[],
) {
  return questions
    .slice(-MAX_PREVIOUS_QUESTIONS)
    .map(
      (q) =>
        `- ${q.prompt}`,
    )
    .join('\n');
}


/**
 * ============================================================
 * CLEAN / NORMALIZE GENERATED QUESTIONS
 * ============================================================
 */

function normalizeGeneratedQuestions(
  parsed: unknown,
  previousQuestions: Question[],
) {
  if (!Array.isArray(parsed)) {
    throw new Error(
      'Gemini response is not an array.',
    );
  }

  const result: Question[] = [];

  for (const raw of parsed) {
    if (!validateQuestion(raw)) {
      continue;
    }

    const q = raw as Question;

    const normalized: Question = {
      ...q,

      category:
        q.category as QuestionCategory,

      id: stableId(q),
    };

    /**
     * Duplicate ID inside current batch.
     */
    if (
      result.some(
        (x) =>
          x.id ===
          normalized.id,
      )
    ) {
      continue;
    }

    /**
     * Duplicate against permanently
     * used/generated questions.
     */
    if (
      questionIsDuplicate(
        normalized,
        previousQuestions,
      )
    ) {
      continue;
    }

    /**
     * Duplicate inside current response.
     */
    if (
      questionIsDuplicate(
        normalized,
        result,
      )
    ) {
      continue;
    }

    result.push(normalized);
  }

  return result;
}


/**
 * ============================================================
 * JSON PARSER
 * ============================================================
 */

function parseGeminiQuestionArray(
  text: string,
): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /**
     * Sometimes models can return surrounding
     * whitespace or accidental markdown despite
     * JSON mode.
     */
    const match =
      text.match(
        /\[[\s\S]*\]/,
      );

    if (!match) {
      throw new Error(
        'Gemini did not return valid JSON.',
      );
    }

    try {
      return JSON.parse(
        match[0],
      );
    } catch {
      throw new Error(
        'Gemini returned malformed JSON.',
      );
    }
  }
}


/**
 * ============================================================
 * GET CACHED QUESTIONS
 * ============================================================
 */

async function getCachedQuestions(
  previousQuestions: Question[],
  language: Language,
) {
  const progress =
    await readProgress();

  const cached =
    Array.isArray(
      progress.generatedQuestions,
    )
      ? progress.generatedQuestions
      : [];

  /**
   * Combine all known questions.
   */
  const allKnown = [
    ...previousQuestions,
    ...cached,
  ];

  /**
   * Remove duplicate IDs.
   */
  const uniqueById =
    new Map<
      string,
      Question
    >();

  for (const q of allKnown) {
    if (
      validateQuestion(q)
    ) {
      uniqueById.set(
        q.id,
        q,
      );
    }
  }

  const unique =
    Array.from(
      uniqueById.values(),
    );

  /**
   * Remove questions already marked as used.
   */
  const available =
    unique.filter(
      (q) =>
        !progress.usedQuestionIds.includes(
          q.id,
        ) &&
        !progress.usedQuestionFingerprints.includes(
          questionFingerprint(q),
        ) &&
        matchesLanguage(
          q,
          language,
        ),
    );

  return available;
}


/**
 * ============================================================
 * GENERATE ONLINE QUESTIONS
 * ============================================================
 */

export async function generateOnlineQuestions(
  previousQuestions: Question[],
  language: Language,
  count = DEFAULT_BATCH_SIZE,
): Promise<Question[]> {
  /**
   * ----------------------------------------------------------
   * STEP 1
   * Check local cache FIRST.
   * ----------------------------------------------------------
   */

  const cached =
    await getCachedQuestions(
      previousQuestions,
      language,
    );

  /**
   * If cache already contains enough questions,
   * DON'T call Gemini.
   */
  if (cached.length >= count) {
    console.info(
      `[Gemini] Using ${count} cached questions. No API request needed.`,
    );

    return cached.slice(
      0,
      count,
    );
  }

  /**
   * ----------------------------------------------------------
   * STEP 2
   * Build permanent duplicate list.
   * ----------------------------------------------------------
   */

  const progress =
    await readProgress();

  const permanentlyKnown = [
    ...previousQuestions,
    ...(progress.generatedQuestions || []),
  ];

  /**
   * ----------------------------------------------------------
   * STEP 3
   * Ask Gemini for a batch.
   * ----------------------------------------------------------
   */

  const needed =
    Math.max(
      10,
      count - cached.length,
    );

  /**
   * Generate a little extra because some
   * questions may be rejected as duplicates
   * during validation.
   */
  const generationCount =
    Math.min(
      30,
      Math.max(
        needed + 5,
        10,
      ),
    );

  const previous =
    buildPreviousQuestionText(
      permanentlyKnown,
    );

  const levelDistribution =
    generationCount === 30
      ? 'exactly 6 questions at each level 1,2,3,4,5'
      : 'distribute difficulty levels 1,2,3,4,5 as evenly as possible';

  const prompt = `
You are the verified question engine for a Sanatana Dharma knowledge quiz.

Generate exactly ${generationCount} COMPLETELY NEW multiple-choice questions.

Language:
${
  language === 'hi'
    ? 'Hindi'
    : 'English'
}

Difficulty:
${levelDistribution}.

IMPORTANT — FACTUAL ACCURACY

- Use Google Search grounding before writing questions.
- Prefer primary/classical or reputable reference material.
- Prefer Vedic, Upanishadic, Itihasa, Purana and established Indological/reference sources.
- Use reputable academic, cultural or institutional sources where appropriate.
- Do not rely on a single low-quality blog, social-media post, SEO page, or unsourced claim when stronger sources are available.
- If traditional sources differ on a detail, choose a well-attested fact rather than inventing certainty.
- Do not create fake quotations.
- Do not create fake chapter numbers.
- Do not create fake verse numbers.
- Do not invent scripture references.
- Do not claim that an uncertain traditional detail is universally established.

IMPORTANT — ABSOLUTELY NO DUPLICATES

A question is considered a duplicate if it:

- asks the same underlying fact;
- is a paraphrase of an earlier question;
- reverses the wording of an earlier question;
- changes only the options;
- changes only the language;
- changes the order of the options;
- asks about the same person/entity/fact in substantially the same way;
- tests essentially the same knowledge even if the sentence looks different.

Every generated question must test a genuinely different piece of knowledge.

IMPORTANT — QUESTION QUALITY

- Exactly 4 options.
- Exactly 1 correct answer.
- answer must be a zero-based option index: 0, 1, 2 or 3.
- Options must be unique.
- Question must be clear and grammatically correct.
- Explanation must be factual and concise.
- category must be exactly one of:
  Vedas, Itihasa, Puranas, Tattva, Darshana, Tirtha.
- level must be an integer from 1 to 5.
- Do not use trick questions.
- Do not use "all of the above".
- Do not use "none of the above".
- Do not create questions whose answer depends on modern speculation.
- Avoid obscure claims unless strongly supported by reliable sources.

OUTPUT FORMAT

Return ONLY a JSON array.

No markdown.
No code fences.
No commentary.

Each object must have exactly this conceptual structure:

{
  "category": "Itihasa",
  "level": 2,
  "prompt": "Question...",
  "options": [
    "Option A",
    "Option B",
    "Option C",
    "Option D"
  ],
  "answer": 0,
  "explanation": "Concise factual explanation."
}

PREVIOUS QUESTIONS THAT ARE PERMANENTLY UNAVAILABLE:

${previous || '- (none)'}
`;

  /**
   * ----------------------------------------------------------
   * STEP 4
   * Gemini + Google Search grounding.
   * ----------------------------------------------------------
   */

  const text =
    await geminiText(
      prompt,
      true,
      true,
    );

  /**
   * ----------------------------------------------------------
   * STEP 5
   * Parse response.
   * ----------------------------------------------------------
   */

  const parsed =
    parseGeminiQuestionArray(
      text,
    );

  /**
   * ----------------------------------------------------------
   * STEP 6
   * Validate + duplicate filter.
   * ----------------------------------------------------------
   */

  const fresh =
    normalizeGeneratedQuestions(
      parsed,
      permanentlyKnown,
    );

  /**
   * Combine cached + newly generated.
   */
  const combined: Question[] = [];

  for (const q of [
    ...cached,
    ...fresh,
  ]) {
    if (
      combined.some(
        (existing) =>
          existing.id ===
          q.id,
      )
    ) {
      continue;
    }

    if (
      questionIsDuplicate(
        q,
        combined,
      )
    ) {
      continue;
    }

    combined.push(q);
  }

  /**
   * ----------------------------------------------------------
   * STEP 7
   * Save newly generated questions.
   * ----------------------------------------------------------
   */

  if (fresh.length > 0) {
    await cacheGeneratedQuestions(
      fresh,
    );
  }

  /**
   * ----------------------------------------------------------
   * STEP 8
   * Verify difficulty availability.
   * ----------------------------------------------------------
   */

  const byLevel =
    new Map<
      number,
      Question[]
    >();

  for (
    let level = 1;
    level <= 5;
    level += 1
  ) {
    byLevel.set(
      level,
      combined.filter(
        (q) =>
          q.level ===
          level,
      ),
    );
  }

  /**
   * We need at least 3 questions
   * at every level for the quiz engine.
   */
  const insufficientLevel =
    [1, 2, 3, 4, 5].find(
      (level) =>
        (
          byLevel.get(level)
            ?.length || 0
        ) < 3,
    );

  if (
    insufficientLevel !==
    undefined
  ) {
    /**
     * If we have some valid questions,
     * return them instead of crashing.
     */
    if (combined.length > 0) {
      console.warn(
        `[Gemini] Level ${insufficientLevel} has fewer than 3 questions after duplicate filtering.`,
      );
    } else {
      throw new Error(
        'Gemini did not produce enough unique questions.',
      );
    }
  }

  return combined.slice(
    0,
    count,
  );
}


/**
 * ============================================================
 * GENERATE ONE QUESTION
 * ============================================================
 *
 * IMPORTANT:
 * First use cached questions.
 * Gemini is only called when no suitable
 * unused cached question exists.
 */

export async function generateOnlineQuestion(
  round: number,
  previousQuestions: Question[],
  language: Language = 'en',
): Promise<Question> {
  const targetLevel =
    Math.min(
      5,
      Math.floor(
        (round - 1) / 3,
      ) + 1,
    );

  /**
   * ----------------------------------------------------------
   * STEP 1
   * Look in local cache.
   * ----------------------------------------------------------
   */

  const cached =
    await getCachedQuestions(
      previousQuestions,
      language,
    );

  const cachedMatch =
    cached.find(
      (q) =>
        q.level ===
        targetLevel,
    );

  if (cachedMatch) {
    console.info(
      `[Gemini] Using cached level ${targetLevel} question.`,
    );

    return cachedMatch;
  }

  /**
   * ----------------------------------------------------------
   * STEP 2
   * Generate a batch only when cache is empty.
   * ----------------------------------------------------------
   */

  const generated =
    await generateOnlineQuestions(
      previousQuestions,
      language,
      10,
    );

  /**
   * Find requested difficulty.
   */
  const match =
    generated.find(
      (q) =>
        q.level ===
        targetLevel &&
        matchesLanguage(
          q,
          language,
        ),
    );

  if (match) {
    return match;
  }

  /**
   * Fallback:
   * any fresh question in requested language.
   */
  const fallback =
    generated.find(
      (q) =>
        matchesLanguage(
          q,
          language,
        ),
    );

  if (fallback) {
    return fallback;
  }

  throw new Error(
    'No unique question available at the requested difficulty.',
  );
}


/**
 * ============================================================
 * MUNI SALAH / QUESTION EXPLANATION
 * ============================================================
 */

export async function askMuniSalah(
  question: Question,
  selectedOptions: string[],
  language: Language = 'en',
) {
  const prompt = `
Give concise quiz guidance for this Sanatana Dharma question.

Language:
${
  language === 'hi'
    ? 'Hindi'
    : 'English'
}

Question:
${question.prompt}

Options:
${question.options.join(
  ' | ',
)}

Selected:
${selectedOptions.join(
  ' | ',
)}

Correct option:
${question.options[
  question.answer
]}

Explain why the correct option is correct in 2-3 sentences.

Do not invent citations.
Do not invent scripture references.
Do not make unsupported claims.
`;

  return geminiText(
    prompt,
    false,
    false,
  );
}
