import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Question } from '@/data/questions';
import { questionFingerprint } from '@/lib/gemini';

const PROGRESS_KEY = '@kaun-hai-sanatani/progress';

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

export async function readProgress(): Promise<SavedProgress> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    if (!raw) return DEFAULT_PROGRESS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return DEFAULT_PROGRESS;
    const usedQuestionIds = Array.isArray(parsed.usedQuestionIds) ? parsed.usedQuestionIds.filter((x: unknown): x is string => typeof x === 'string') : [];
    const generatedQuestions = Array.isArray(parsed.generatedQuestions) ? parsed.generatedQuestions : [];
    const knownQuestions = [...generatedQuestions];
    // The seed bank is imported lazily here to avoid making storage depend on UI state.
    // Any generated question whose ID is already marked used contributes its fingerprint too.
    const knownUsedFingerprints = knownQuestions
      .filter((q: unknown) => q && typeof q === 'object' && usedQuestionIds.includes((q as Question).id))
      .map((q) => questionFingerprint(q as Question));
    const usedQuestionFingerprints = [
      ...(Array.isArray(parsed.usedQuestionFingerprints) ? parsed.usedQuestionFingerprints.filter((x: unknown): x is string => typeof x === 'string') : []),
      ...knownUsedFingerprints,
    ];
    return {
      ...DEFAULT_PROGRESS,
      ...parsed,
      usedQuestionIds: [...new Set(usedQuestionIds)],
      usedQuestionFingerprints: [...new Set(usedQuestionFingerprints)],
      generatedQuestions,
    };
  } catch {
    return DEFAULT_PROGRESS;
  }
}

export async function saveProgress(progress: SavedProgress) {
  try {
    const safe: SavedProgress = {
      ...DEFAULT_PROGRESS,
      ...progress,
      usedQuestionIds: [...new Set(Array.isArray(progress.usedQuestionIds) ? progress.usedQuestionIds.filter(Boolean) : [])],
      usedQuestionFingerprints: [...new Set(Array.isArray(progress.usedQuestionFingerprints) ? progress.usedQuestionFingerprints.filter(Boolean) : [])],
      generatedQuestions: Array.isArray(progress.generatedQuestions) ? progress.generatedQuestions : [],
    };
    await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(safe));
    return safe;
  } catch {
    // Storage failure must never crash the quiz UI. The in-memory state remains usable.
    return progress;
  }
}

export async function markQuestionUsed(question: Question) {
  const progress = await readProgress();
  const next: SavedProgress = {
    ...progress,
    usedQuestionIds: progress.usedQuestionIds.includes(question.id)
      ? progress.usedQuestionIds
      : [...progress.usedQuestionIds, question.id],
    usedQuestionFingerprints: progress.usedQuestionFingerprints.includes(questionFingerprint(question))
      ? progress.usedQuestionFingerprints
      : [...progress.usedQuestionFingerprints, questionFingerprint(question)],
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
