import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Question } from '@/data/questions';

const PROGRESS_KEY = '@kaun-hai-sanatani/progress';
const WEB_BACKUP_KEY = 'kaun-hai-sanatani:progress:v2';

function normalizeFingerprintText(text: string) {
  return text
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function storedQuestionFingerprint(question: Pick<Question, 'prompt'>) {
  return normalizeFingerprintText(question.prompt);
}

export type SavedProgress = {
  bestScore: number;
  bestPada: number;
  totalRounds: number;
  lastPlayedAt?: string;
  dailyStreak: number;
  lastDailyDate?: string;
  dailyCompletedDate?: string;
  preferredLanguage: 'en' | 'hi';
  usedQuestionIds: string[];
  usedQuestionFingerprints: string[];
  generatedQuestions: Question[];
};

export const DEFAULT_PROGRESS: SavedProgress = {
  bestScore: 0,
  bestPada: 0,
  totalRounds: 0,
  dailyStreak: 0,
  preferredLanguage: 'en',
  usedQuestionIds: [],
  usedQuestionFingerprints: [],
  generatedQuestions: [],
};

function isWeb() {
  return typeof window !== 'undefined' && typeof window.localStorage !== 'undefined';
}

function readWebBackup() {
  if (!isWeb()) return null;
  try {
    return window.localStorage.getItem(WEB_BACKUP_KEY);
  } catch {
    return null;
  }
}

function writeWebBackup(value: string) {
  if (!isWeb()) return;
  try {
    window.localStorage.setItem(WEB_BACKUP_KEY, value);
  } catch {
    // AsyncStorage remains the primary persistence layer.
  }
}

function normalizeProgress(parsed: unknown): SavedProgress {
  if (!parsed || typeof parsed !== 'object') return DEFAULT_PROGRESS;

  const record = parsed as Partial<SavedProgress> & { generatedQuestions?: unknown };
  const usedQuestionIds = Array.isArray(record.usedQuestionIds)
    ? record.usedQuestionIds.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const generatedQuestions: Question[] = Array.isArray(record.generatedQuestions)
    ? record.generatedQuestions.filter((q: unknown): q is Question => Boolean(q && typeof q === 'object'))
    : [];

  const knownUsedFingerprints = generatedQuestions
    .filter((q: Question) => usedQuestionIds.includes(q.id))
    .map((q: Question) => storedQuestionFingerprint(q));

  const usedQuestionFingerprints = [
    ...(Array.isArray(record.usedQuestionFingerprints)
      ? record.usedQuestionFingerprints.filter((x: unknown): x is string => typeof x === 'string')
      : []),
    ...knownUsedFingerprints,
  ];

  return {
    ...DEFAULT_PROGRESS,
    ...record,
    usedQuestionIds: [...new Set(usedQuestionIds)],
    usedQuestionFingerprints: [...new Set(usedQuestionFingerprints)],
    generatedQuestions,
  };
}

export async function readProgress(): Promise<SavedProgress> {
  try {
    const asyncRaw = await AsyncStorage.getItem(PROGRESS_KEY);
    const raw = asyncRaw || readWebBackup();
    if (!raw) return DEFAULT_PROGRESS;
    return normalizeProgress(JSON.parse(raw));
  } catch {
    try {
      const backup = readWebBackup();
      return backup ? normalizeProgress(JSON.parse(backup)) : DEFAULT_PROGRESS;
    } catch {
      return DEFAULT_PROGRESS;
    }
  }
}

export async function saveProgress(progress: SavedProgress) {
  const safe: SavedProgress = {
    ...DEFAULT_PROGRESS,
    ...progress,
    usedQuestionIds: [...new Set(Array.isArray(progress.usedQuestionIds) ? progress.usedQuestionIds.filter(Boolean) : [])],
    usedQuestionFingerprints: [...new Set(Array.isArray(progress.usedQuestionFingerprints) ? progress.usedQuestionFingerprints.filter(Boolean) : [])],
    generatedQuestions: Array.isArray(progress.generatedQuestions) ? progress.generatedQuestions : [],
  };

  const serialized = JSON.stringify(safe);
  writeWebBackup(serialized);

  try {
    await AsyncStorage.setItem(PROGRESS_KEY, serialized);
    return safe;
  } catch {
    // Web backup has already been written; storage failure must never crash the quiz UI.
    return safe;
  }
}

export async function markQuestionUsed(question: Question) {
  const progress = await readProgress();
  const fingerprint = storedQuestionFingerprint(question);
  const next: SavedProgress = {
    ...progress,
    usedQuestionIds: progress.usedQuestionIds.includes(question.id)
      ? progress.usedQuestionIds
      : [...progress.usedQuestionIds, question.id],
    usedQuestionFingerprints: progress.usedQuestionFingerprints.includes(fingerprint)
      ? progress.usedQuestionFingerprints
      : [...progress.usedQuestionFingerprints, fingerprint],
  };
  await saveProgress(next);
  return next;
}

export async function cacheGeneratedQuestions(questions: Question[]) {
  const progress = await readProgress();
  const existing = new Map(progress.generatedQuestions.map((q) => [q.id, q]));
  for (const question of questions) existing.set(question.id, question);
  const next = { ...progress, generatedQuestions: [...existing.values()] };
  await saveProgress(next);
  return next;
}
