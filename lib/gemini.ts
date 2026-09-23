import type { Question, QuestionCategory } from '@/data/questions';
import type { Language } from '@/data/translations';

const MODEL = process.env.EXPO_PUBLIC_GEMINI_MODEL || 'gemini-3.8-flash';
const API_KEY = process.env.EXPO_PUBLIC_GEMINI_API_KEY;

function normalize(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Stable fingerprint of the knowledge tested by a question.
 * Exact wording differences are handled separately by similarity().
 */
export function questionFingerprint(
  question: Pick<Question, 'prompt'>,
) {
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
    if (bb.has(word)) {
      intersection += 1;
    }
  });

  const overlap = intersection / Math.max(aa.size, bb.size);
  const containment = intersection / Math.min(aa.size, bb.size);

  return Math.max(overlap, containment * 0.82);
}

export function questionIsDuplicate(
  question: Question,
  previous: Question[],
) {
  const fingerprint = questionFingerprint(question);

  return previous.some((old) => {
    if (questionFingerprint(old) === fingerprint) {
      return true;
    }

    return similarity(question.prompt, old.prompt) >= 0.58;
  });
}

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

function validateQuestion(value: unknown): value is Question {
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

async function geminiText(
  prompt: string,
  json = false,
  useGoogleSearch = false,
) {
  if (!API_KEY) {
    throw new Error(
      'EXPO_PUBLIC_GEMINI_API_KEY is not configured.',
    );
  }

  const controller = new AbortController();

  const timeout = setTimeout(
    () => controller.abort(),
    45000,
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
        temperature: 0.75,

        ...(json
          ? {
              responseMimeType: 'application/json',
            }
          : {}),
      },
    };

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
          'Content-Type': 'application/json',
          'x-goog-api-key': API_KEY,
        },

        body: JSON.stringify(body),

        signal: controller.signal,
      },
    );

    if (!response.ok) {
      const responseBody =
        await response.text().catch(() => '');

      throw new Error(
        `Gemini HTTP ${response.status}: ${responseBody.slice(
          0,
          500,
        )}`,
      );
    }

    const data = await response.json();

    const text =
      data?.candidates?.[0]?.content?.parts
        ?.map(
          (p: { text?: string }) =>
            p.text || '',
        )
        .join('') || '';

    if (!text) {
      throw new Error(
        'Gemini returned no text.',
      );
    }

    return text;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Generate a batch of NEW questions.
 *
 * IMPORTANT:
 * previousQuestions must contain ALL questions that have
 * already been used or permanently reserved by the app.
 */
export async function generateOnlineQuestions(
  previousQuestions: Question[],
  language: Language,
  count = 30,
): Promise<Question[]> {

  const previousUnique = Array.from(
    new Map(
      previousQuestions.map((q) => [
        questionFingerprint(q),
        q,
      ]),
    ).values(),
  );

  const previous = previousUnique
    .slice(-1000)
    .map(
      (q) =>
        `- ${q.prompt}`,
    )
    .join('\n');

  const prompt = `
You are the verified question engine for a Sanatana Dharma knowledge quiz.

Generate exactly ${count} COMPLETELY NEW multiple-choice questions.

Language:
${language === 'hi' ? 'Hindi' : 'English'}.

Difficulty:
${count === 30
  ? 'Exactly 6 questions at each level 1, 2, 3, 4 and 5.'
  : 'Distribute difficulty levels as evenly as possible.'}

==============================
ACCURACY REQUIREMENTS
==============================

Use Google Search grounding before writing the questions.

Prefer:
- Primary/classical Hindu scriptures and reliable translations.
- Upanishadic and Vedic source material.
- Established Indological references.
- Reputable academic/reference sources.
- Official cultural or temple sources where appropriate.

Never:
- Invent scripture quotations.
- Invent chapter or verse numbers.
- Invent historical facts.
- Use unsourced viral claims as facts.
- Present disputed traditions as certain facts.

If a fact is uncertain or has substantially conflicting traditions,
choose another well-attested fact.

==============================
ABSOLUTE NO-REPEAT RULE
==============================

The previous-question list below is a PERMANENT exclusion list.

A generated question MUST NOT:

1. Repeat an old question.
2. Paraphrase an old question.
3. Reverse the wording of an old question.
4. Change only the answer options.
5. Change the language while testing the same fact.
6. Change the order of the options.
7. Ask the same fact about the same person, deity,
   scripture, event or concept in different wording.
8. Ask the same underlying knowledge point from another angle.
9. Convert an old question into true/false or another format.
10. Reuse the same knowledge fact merely because the wording is different.

Example:

Old:
"Who was the mother of Karna?"

Forbidden:
"Karna's mother was who?"

Also forbidden:
"Who gave birth to Karna?"

Also forbidden:
"Which woman was Karna's biological mother?"

All three test essentially the same fact.

You must create questions testing DIFFERENT knowledge facts.

==============================
QUESTION FORMAT
==============================

Every question must have:

- exactly 4 unique options
- exactly 1 correct answer
- answer = zero-based option index
- concise factual explanation
- category from:

Vedas
Itihasa
Puranas
Tattva
Darshana
Tirtha

Level must be an integer from 1 to 5.

Return ONLY a JSON array.

No markdown.
No code fences.
No commentary.

==============================
PERMANENTLY UNAVAILABLE QUESTIONS
==============================

${previous || '- NONE'}

==============================
FINAL CHECK BEFORE RESPONSE
==============================

Before returning each question:

1. Compare it against EVERY previous question.
2. Compare the underlying knowledge fact.
3. Reject semantic duplicates.
4. Reject paraphrases.
5. Reject reversed questions.
6. Reject option-swapped duplicates.
7. Reject same-fact questions.
8. Make sure the remaining questions are mutually different.

Only return questions that pass ALL checks.
`;

  const text = await geminiText(
    prompt,
    true,
    true,
  );

  let parsed: unknown;

  try {
    parsed = JSON.parse(text);
  } catch {
    const match =
      text.match(/\[[\s\S]*\]/);

    if (!match) {
      throw new Error(
        'Gemini did not return valid JSON.',
      );
    }

    parsed = JSON.parse(match[0]);
  }

  if (!Array.isArray(parsed)) {
    throw new Error(
      'Gemini response is not an array.',
    );
  }

  const result: Question[] = [];

  /**
   * Build a local exclusion set from ALL historical questions.
   * This makes duplicate checking independent of Gemini.
   */
  const exclusion = [
    ...previousUnique,
  ];

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
     * Check:
     *
     * 1. Same stable ID
     * 2. Same fingerprint
     * 3. Semantic duplicate with history
     * 4. Duplicate with another newly generated question
     */
    const duplicate =
      result.some(
        (x) =>
          x.id === normalized.id,
      ) ||

      questionIsDuplicate(
        normalized,
        exclusion,
      ) ||

      questionIsDuplicate(
        normalized,
        result,
      );

    if (duplicate) {
      continue;
    }

    result.push(normalized);
  }

  /**
   * If Gemini returned too many duplicates and we ended up
   * with too few questions, fail instead of silently allowing
   * duplicate questions.
   */
  if (result.length < Math.min(count, 5)) {
    throw new Error(
      `Only ${result.length} unique questions were generated. ` +
      `Gemini returned too many duplicates. Please generate again.`,
    );
  }

  const byLevel =
    new Map<number, Question[]>();

  for (let level = 1; level <= 5; level += 1) {
    byLevel.set(
      level,
      result.filter(
        (q) => q.level === level,
      ),
    );
  }

  if (
    [1, 2, 3, 4, 5].some(
      (level) =>
        (byLevel.get(level)?.length || 0) < 3,
    )
  ) {
    throw new Error(
      'Google-grounded Gemini did not produce enough unique questions at every difficulty level.',
    );
  }

  return result;
}

/**
 * Generate the question required for the current round.
 *
 * The caller MUST pass the complete permanent question history.
 */
export async function generateOnlineQuestion(
  round: number,
  previousQuestions: Question[],
  language: Language = 'en',
): Promise<Question> {

  const targetLevel = Math.min(
    5,
    Math.floor((round - 1) / 3) + 1,
  );

  /**
   * Ask for a larger pool so that duplicates can be rejected
   * without forcing an old question back into the quiz.
   */
  const generated =
    await generateOnlineQuestions(
      previousQuestions,
      language,
      15,
    );

  const match =
    generated.find(
      (q) =>
        q.level === targetLevel &&
        !questionIsDuplicate(
          q,
          previousQuestions,
        ),
    );

  if (!match) {
    throw new Error(
      `No unique question available for difficulty level ${targetLevel}.`,
    );
  }

  return match;
}

export async function askMuniSalah(
  question: Question,
  selectedOptions: string[],
  language: Language = 'en',
) {
  const prompt = `
Give concise quiz guidance for this Sanatana Dharma question.

Language:
${language === 'hi' ? 'Hindi' : 'English'}.

Question:
${question.prompt}

Options:
${question.options.join(' | ')}

Selected:
${selectedOptions.join(' | ')}

Correct option:
${question.options[question.answer]}

Explain why the correct option is correct in 2-3 sentences.

Do not invent citations.
`;

  return geminiText(prompt);
}
