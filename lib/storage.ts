import AsyncStorage from '@react-native-async-storage/async-storage';

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
};

export const DEFAULT_PROGRESS: SavedProgress = {
  bestScore: 0,
  bestPada: 0,
  totalRounds: 0,
  dailyStreak: 0,
  preferredLanguage: 'en',
};

export async function readProgress(): Promise<SavedProgress> {
  try {
    const raw = await AsyncStorage.getItem(PROGRESS_KEY);
    return raw ? { ...DEFAULT_PROGRESS, ...JSON.parse(raw) } : DEFAULT_PROGRESS;
  } catch {
    return DEFAULT_PROGRESS;
  }
}

export async function saveProgress(progress: SavedProgress) {
  await AsyncStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}
