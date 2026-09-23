import AsyncStorage from "@react-native-async-storage/async-storage";
import type { Question } from "../data/questions";

const USED_IDS_KEY = "@kaun_hai_sanatani/used_question_ids";
const USED_FINGERPRINTS_KEY =
  "@kaun_hai_sanatani/used_question_fingerprints";
const GENERATED_QUESTIONS_KEY =
  "@kaun_hai_sanatani/generated_questions";

export type StoredGeneratedQuestion = Question & {
  source?: string;
  sourceUrl?: string;
};

function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .replace(/[^\p{L}\p{N} ]/gu, "")
    .trim();
}

export function questionFingerprint(
  question: Pick<Question, "question" | "answer">
): string {
  return normalizeText(
    `${question.question}|${question.answer}`
  );
}

async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const value = await AsyncStorage.getItem(key);

    if (!value) {
      return fallback;
    }

    return JSON.parse(value) as T;
  } catch (error) {
    console.warn(`[Storage] Failed to read ${key}`, error);
    return fallback;
  }
}

async function writeJson<T>(key: string, value: T): Promise<void> {
  await AsyncStorage.setItem(key, JSON.stringify(value));
}

export async function getUsedQuestionIds(): Promise<string[]> {
  return readJson<string[]>(USED_IDS_KEY, []);
}

export async function getUsedQuestionFingerprints(): Promise<string[]> {
  return readJson<string[]>(USED_FINGERPRINTS_KEY, []);
}

export async function getGeneratedQuestions(): Promise<
  StoredGeneratedQuestion[]
> {
  return readJson<StoredGeneratedQuestion[]>(
    GENERATED_QUESTIONS_KEY,
    []
  );
}

export async function saveUsedQuestions(
  questions: Question[]
): Promise<void> {
  const existingIds = await getUsedQuestionIds();
  const existingFingerprints =
    await getUsedQuestionFingerprints();

  const idSet = new Set(existingIds);
  const fingerprintSet = new Set(existingFingerprints);

  for (const question of questions) {
    if (question.id) {
      idSet.add(question.id);
    }

    fingerprintSet.add(questionFingerprint(question));
  }

  await Promise.all([
    writeJson(USED_IDS_KEY, [...idSet]),
    writeJson(USED_FINGERPRINTS_KEY, [...fingerprintSet]),
  ]);
}

export async function saveGeneratedQuestions(
  questions: StoredGeneratedQuestion[]
): Promise<void> {
  const existing = await getGeneratedQuestions();

  const byFingerprint = new Map<string, StoredGeneratedQuestion>();

  for (const question of existing) {
    byFingerprint.set(questionFingerprint(question), question);
  }

  for (const question of questions) {
    const fp = questionFingerprint(question);

    if (!byFingerprint.has(fp)) {
      byFingerprint.set(fp, question);
    }
  }

  const merged = [...byFingerprint.values()];

  await writeJson(GENERATED_QUESTIONS_KEY, merged);

  await saveUsedQuestions(merged);
}

export async function getQuestionExclusionData(): Promise<{
  ids: string[];
  fingerprints: string[];
  questions: StoredGeneratedQuestion[];
}> {
  const [ids, fingerprints, questions] = await Promise.all([
    getUsedQuestionIds(),
    getUsedQuestionFingerprints(),
    getGeneratedQuestions(),
  ]);

  return {
    ids,
    fingerprints,
    questions,
  };
}

export async function isQuestionUsed(
  question: Pick<Question, "question" | "answer">
): Promise<boolean> {
  const fingerprints = await getUsedQuestionFingerprints();

  return fingerprints.includes(questionFingerprint(question));
}

export async function markQuestionUsed(
  question: Question
): Promise<void> {
  await saveUsedQuestions([question]);
}

export async function markQuestionsUsed(
  questions: Question[]
): Promise<void> {
  await saveUsedQuestions(questions);
}

export async function clearQuestionHistory(): Promise<void> {
  await AsyncStorage.multiRemove([
    USED_IDS_KEY,
    USED_FINGERPRINTS_KEY,
    GENERATED_QUESTIONS_KEY,
  ]);
}

// Useful for debugging.
export async function getQuestionStorageStats(): Promise<{
  usedIds: number;
  usedFingerprints: number;
  generatedQuestions: number;
}> {
  const data = await getQuestionExclusionData();

  return {
    usedIds: data.ids.length,
    usedFingerprints: data.fingerprints.length,
    generatedQuestions: data.questions.length,
  };
}
