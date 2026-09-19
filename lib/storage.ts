import AsyncStorage from '@react-native-async-storage/async-storage';
import type { Question } from '@/data/questions';

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
    return {
      ...DEFAULT_PROGRESS,
      ...parsed,
      usedQuestionIds: Array.isArray(parsed.usedQuestionIds) ? parsed.usedQuestionIds : [],
      usedQuestionFingerprints: Array.isArray(parsed.usedQuestionFingerprints) ? parsed.usedQuestionFingerprints : [],
      generatedQuestions: Array.isArray(parsed.generatedQuestions) ? parsed.generatedQuestions : [],
    };
  } catch {
    return DEFAULT_PROGRESS;
  }
}

export async function saveProgress(progress: SavedProgress) {
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

export async function markQuestionUsed(question: Question) {
  const progress = await readProgress();
  const next: SavedProgress = {
    ...progress,
    usedQuestionIds: progress.usedQuestionIds.includes(question.id)
      ? progress.usedQuestionIds
      : [...progress.usedQuestionIds, question.id],
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
