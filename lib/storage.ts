import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Question } from '@/data/questions';
import { questionFingerprint } from '@/lib/gemini';

const PROGRESS_KEY = '@kaun-hai-sanatani/progress';
const WEB_BACKUP_KEY = 'kaun-hai-sanatani:progress:v2';

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

function normalizeProgress(parsed: any): SavedProgress {
  if (!parsed || typeof parsed !== 'object') return DEFAULT_PROGRESS;

  const usedQuestionIds = Array.isArray(parsed.usedQuestionIds)
    ? parsed.usedQuestionIds.filter((x: unknown): x is string => typeof x === 'string')
    : [];
  const generatedQuestions = Array.isArray(parsed.generatedQuestions)
    ? parsed.generatedQuestions
    : [];

  const knownUsedFingerprints = generatedQuestions
    .filter((q: unknown) => q && typeof q === 'object' && usedQuestionIds.includes((q as Question).id))
    .map((q) => questionFingerprint(q as Question));

  const usedQuestionFingerprints = [
    ...(Array.isArray(parsed.usedQuestionFingerprints)
      ? parsed.usedQuestionFingerprints.filter((x: unknown): x is string => typeof x === 'string')
      : []),
    ...knownUsedFingerprints,
  ];

  return {
    ...DEFAULT_PROGRESS,
    ...parsed,
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
  const fingerprint = questionFingerprint(question);
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
