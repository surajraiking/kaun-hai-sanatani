import type { Question } from '@/data/questions';
import type { Language } from '@/data/translations';

const apiUrl = () => {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (!domain) throw new Error('Online mode is not configured.');
  return `https://${domain}`;
};

async function requestWithTimeout(url: string, init: RequestInit) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

export async function askMuniSalah(question: Question, selectedOptions: string[], language: Language = 'en') {
  const response = await requestWithTimeout(`${apiUrl()}/api/gemini/guru-guidance`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      question: question.prompt,
      options: question.options,
      selectedOptions,
      category: question.category,
      language,
    }),
  });
  if (!response.ok) {
    throw new Error('Guru guidance is unavailable right now.');
  }
  const data = (await response.json()) as { guidance?: string };
  if (!data.guidance) throw new Error('No guidance received.');
  return data.guidance;
}

export async function generateOnlineQuestion(round: number, usedIds: string[], language: Language = 'en'): Promise<Question> {
  const response = await requestWithTimeout(`${apiUrl()}/api/gemini/generate-question`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ round, usedIds, language }),
  });
  if (!response.ok) throw new Error('Online question generation is unavailable.');
  const data = (await response.json()) as Question;
  if (
    !data.id ||
    !data.category ||
    !data.prompt ||
    !Array.isArray(data.options) ||
    data.options.length !== 4 ||
    typeof data.answer !== 'number' ||
    data.answer < 0 ||
    data.answer > 3 ||
    !data.explanation
  ) {
    throw new Error('Gemini returned an invalid question.');
  }
  return data;
}
