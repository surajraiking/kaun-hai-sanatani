import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Animated,
  Image,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { LinearGradient } from 'expo-linear-gradient';
import { Feather } from '@expo/vector-icons';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { QUESTION_BANK, type Question } from '@/data/questions';
import { askMuniSalah, generateOnlineQuestions, questionFingerprint, questionIsDuplicate } from '@/lib/gemini';
import { playTone } from '@/lib/sounds';
import { DEFAULT_PROGRESS, readProgress, saveProgress, type SavedProgress } from '@/lib/storage';
import { UI } from '@/data/copy';
import { localizeQuestion, type Language } from '@/data/translations';

type Screen = 'home' | 'game' | 'results';
type Lifeline = 'divya' | 'muni' | 'janmat' | 'parivartan';
type ResultState = 'idle' | 'correct' | 'wrong' | 'timeout';

const TOTAL_PADAS = 15;
const REWARDS = [100, 200, 300, 500, 750, 1000, 1500, 2200, 3200, 5000, 7500, 11000, 16000, 23000, 50000];
const SAFETY_NETS = new Set([5, 10, 15]);
const LETTERS = ['A', 'B', 'C', 'D'];
const TODAY = () => new Date().toISOString().slice(0, 10);

function shuffle<T>(items: T[]) {
  return [...items].sort(() => Math.random() - 0.5);
}

function timerForPada(pada: number) {
  if (pada <= 5) return 30;
  if (pada <= 10) return 45;
  return null;
}

function difficultyForPada(pada: number) {
  return Math.min(5, Math.floor((pada - 1) / 3) + 1);
}

function pickRoundQuestions(saved: SavedProgress) {
  const usedIds = new Set(saved.usedQuestionIds);
  const usedFingerprints = new Set(saved.usedQuestionFingerprints);
  const pool = [...saved.generatedQuestions, ...QUESTION_BANK].filter((q): q is Question => Boolean(q && typeof q.id === 'string' && typeof q.prompt === 'string' && Array.isArray(q.options) && q.options.length === 4));
  const usedKnownQuestions = pool.filter((q, index, all) =>
    all.findIndex((x) => x.id === q.id) === index &&
    (usedIds.has(q.id) || usedFingerprints.has(questionFingerprint(q)))
  );
  const unique = new Map<string, Question>();
  for (const q of pool) {
    const fp = questionFingerprint(q);
    if (usedIds.has(q.id) || usedFingerprints.has(fp) || questionIsDuplicate(q, usedKnownQuestions)) continue;
    if ([...unique.values()].some((existing) => questionIsDuplicate(q, [existing]))) continue;
    unique.set(q.id, q);
  }

  const selected: Question[] = [];
  for (let level = 1; level <= 5; level += 1) {
    const candidates = [...unique.values()]
      .filter((q) => q.level === level)
      .sort(() => Math.random() - 0.5)
      .slice(0, 3);
    selected.push(...candidates);
    for (const q of candidates) unique.delete(q.id);
  }
  return selected;
}

function getNextQuestion(usedIds: string[], pada: number): Question {
  const maxLevel = Math.min(5, Math.ceil(pada / 3));
  const candidates = QUESTION_BANK.filter((question) => question.level <= maxLevel && !usedIds.includes(question.id));
  return shuffle(candidates.length ? candidates : QUESTION_BANK.filter((question) => !usedIds.includes(question.id)))[0];
}

function getDailyQuestion() {
  const date = TODAY();
  const seed = [...date].reduce((total, character) => total + character.charCodeAt(0), 0);
  return QUESTION_BANK[seed % QUESTION_BANK.length];
}

function isYesterday(date?: string) {
  if (!date) return false;
  const previous = new Date(`${date}T00:00:00.000Z`);
  const yesterday = new Date(`${TODAY()}T00:00:00.000Z`);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);
  return previous.toISOString().slice(0, 10) === yesterday.toISOString().slice(0, 10);
}

function categoryLabel(category: Question['category'], language: Language) {
  if (language === 'en') return category.toUpperCase();
  return {
    Vedas: 'वेद',
    Itihasa: 'इतिहास',
    Puranas: 'पुराण',
    Tattva: 'तत्त्व',
    Darshana: 'दर्शन',
    Tirtha: 'तीर्थ',
  }[category];
}

function SectionEyebrow({ children }: { children: React.ReactNode }) {
  const colors = useColors();
  return (
    <Text style={[styles.eyebrow, { color: colors.gold }]}>{children}</Text>
  );
}

function PrimaryButton({
  label,
  onPress,
  icon,
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  icon: keyof typeof Feather.glyphMap;
  disabled?: boolean;
}) {
  const colors = useColors();
  return (
    <Pressable
      testID={`button-${label}`}
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.primaryButton,
        { backgroundColor: colors.gold, opacity: disabled ? 0.45 : pressed ? 0.82 : 1 },
      ]}
    >
      <Text style={[styles.primaryButtonText, { color: colors.primaryForeground }]}>{label}</Text>
      <Feather name={icon} size={18} color={colors.primaryForeground} />
    </Pressable>
  );
}

function App() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const [language, setLanguage] = useState<Language>('en');
  const [screen, setScreen] = useState<Screen>('home');
  const [progress, setProgress] = useState<SavedProgress>(DEFAULT_PROGRESS);
  const [pada, setPada] = useState(1);
  const [score, setScore] = useState(0);
  const [question, setQuestion] = useState<Question | null>(null);
  const [roundQuestions, setRoundQuestions] = useState<Question[]>([]);
  const [usedIds, setUsedIds] = useState<string[]>([]);
  const [selected, setSelected] = useState<number | null>(null);
  const [resultState, setResultState] = useState<ResultState>('idle');
  const [disabledOptions, setDisabledOptions] = useState<number[]>([]);
  const [usedLifelines, setUsedLifelines] = useState<Lifeline[]>([]);
  const [audience, setAudience] = useState<number[] | null>(null);
  const [guruMessage, setGuruMessage] = useState<string | null>(null);
  const [guruLoading, setGuruLoading] = useState(false);
  const [seconds, setSeconds] = useState<number | null>(null);
  const [showMilestone, setShowMilestone] = useState(false);
  const [showExit, setShowExit] = useState(false);
  const [onlineMode, setOnlineMode] = useState(Boolean(process.env.EXPO_PUBLIC_GEMINI_API_KEY));
  const [roundLoading, setRoundLoading] = useState(false);
  const [dailyMode, setDailyMode] = useState(false);
  const pulse = useRef(new Animated.Value(0.92)).current;
  const startingGameRef = useRef(false);

  useEffect(() => {
    void readProgress().then((saved) => {
      setProgress(saved);
      setLanguage(saved.preferredLanguage);
    });
  }, []);

  const copy = UI[language];

  useEffect(() => {
    Animated.loop(
      Animated.sequence([
        Animated.timing(pulse, { toValue: 1.04, duration: 1700, useNativeDriver: Platform.OS !== 'web' }),
        Animated.timing(pulse, { toValue: 0.92, duration: 1700, useNativeDriver: Platform.OS !== 'web' }),
      ]),
    ).start();
  }, [pulse]);

  useEffect(() => {
    if (screen !== 'game' || resultState !== 'idle' || seconds === null) return;
    if (seconds <= 0) {
      playTone('wrong');
      setResultState('timeout');
      return;
    }
    const timer = setInterval(() => {
      setSeconds((value) => (value === null ? null : value - 1));
    }, 1000);
    return () => clearInterval(timer);
  }, [screen, resultState, seconds]);

  const levelLabel = useMemo(() => {
    if (pada <= 5) return 'Pratham Pada';
    if (pada <= 10) return 'Madhyam Pada';
    return 'Param Pada';
  }, [pada]);

  const changeLanguage = (nextLanguage: Language) => {
    setLanguage(nextLanguage);
    const nextProgress = { ...progress, preferredLanguage: nextLanguage };
    setProgress(nextProgress);
    void saveProgress(nextProgress);
  };

  const beginGame = async (isDaily = false) => {
    if (startingGameRef.current) return;
    startingGameRef.current = true;
    setRoundLoading(true);
    setDailyMode(isDaily);
    try {
      let saved = await readProgress();

      if (isDaily) {
        let daily = pickRoundQuestions(saved)[0];
        if (!daily && onlineMode) {
          try {
            const fresh = await generateOnlineQuestions([...saved.generatedQuestions, ...QUESTION_BANK], language, 10);
            daily = fresh[0];
            saved = { ...saved, generatedQuestions: [...saved.generatedQuestions, ...fresh] };
          } catch {
            // Keep the normal fallback below.
          }
        }
        if (!daily) throw new Error('No unused daily question is available. Turn on Online Mode.');
        saved = {
          ...saved,
          usedQuestionIds: [...new Set([...saved.usedQuestionIds, daily.id])],
          usedQuestionFingerprints: [...new Set([...saved.usedQuestionFingerprints, questionFingerprint(daily)])],
        };
        await saveProgress(saved);
        setProgress(saved);
        const localizedDaily = localizeQuestion(daily, language);
        setPada(1);
        setScore(0);
        setRoundQuestions([localizedDaily]);
        setUsedIds([daily.id]);
        setQuestion(localizedDaily);
      } else {
        let selectedQuestions = pickRoundQuestions(saved);

        if (selectedQuestions.length < TOTAL_PADAS && onlineMode) {
          const previous = [...saved.generatedQuestions, ...QUESTION_BANK];
          try {
            const fresh = await generateOnlineQuestions(previous, language, 30);
            const generatedMap = new Map(saved.generatedQuestions.map((q) => [q.id, q]));
            for (const q of fresh) generatedMap.set(q.id, q);
            saved = {
              ...saved,
              generatedQuestions: [...generatedMap.values()],
            };
            await saveProgress(saved);
            selectedQuestions = pickRoundQuestions(saved);
          } catch {
            // Offline/local bank is used as a safe fallback.
          }
        }

        if (selectedQuestions.length < TOTAL_PADAS) {
          const available = [...saved.generatedQuestions, ...QUESTION_BANK]
            .filter((q, i, arr) => arr.findIndex((x) => x.id === q.id) === i)
            .filter((q) => !saved.usedQuestionIds.includes(q.id))
            .filter((q) => !saved.usedQuestionFingerprints.includes(questionFingerprint(q)))
            .filter((q) => !questionIsDuplicate(q, [...saved.generatedQuestions, ...QUESTION_BANK].filter((old) =>
              saved.usedQuestionIds.includes(old.id) || saved.usedQuestionFingerprints.includes(questionFingerprint(old))
            )))
            .sort(() => Math.random() - 0.5);
          for (const q of available) {
            if (selectedQuestions.length >= TOTAL_PADAS) break;
            if (!selectedQuestions.some((x) => x.id === q.id)) selectedQuestions.push(q);
          }
        }

        if (selectedQuestions.length < TOTAL_PADAS) {
          throw new Error('Not enough unused questions. Turn on Online Mode so Gemini can create more.');
        }

        const usedIdsNext = [...saved.usedQuestionIds, ...selectedQuestions.map((q) => q.id)];
        const usedFingerprintsNext = [
          ...saved.usedQuestionFingerprints,
          ...selectedQuestions.map((q) => questionFingerprint(q)),
        ];
        saved = {
          ...saved,
          usedQuestionIds: [...new Set(usedIdsNext)],
          usedQuestionFingerprints: [...new Set(usedFingerprintsNext)],
        };
        await saveProgress(saved);
        setProgress(saved);

        setRoundQuestions(selectedQuestions.map((q) => localizeQuestion(q, language)));
        setUsedIds(selectedQuestions.map((q) => q.id));
        setPada(1);
        setScore(0);
        setQuestion(localizeQuestion(selectedQuestions[0], language));
      }

      setSelected(null);
      setResultState('idle');
      setDisabledOptions([]);
      setUsedLifelines([]);
      setAudience(null);
      setGuruMessage(null);
      setSeconds(timerForPada(1));
      setScreen('game');
    } catch (error) {
      setGuruMessage(error instanceof Error ? error.message : 'Question generation failed.');
    } finally {
      setRoundLoading(false);
      startingGameRef.current = false;
    }
  };

  const finishGame = async (finalScore: number, finalPada: number) => {
    const today = TODAY();
    const completedDaily = dailyMode;
    const nextDailyStreak = completedDaily
      ? progress.dailyCompletedDate === today
        ? progress.dailyStreak
        : isYesterday(progress.lastDailyDate)
          ? progress.dailyStreak + 1
          : 1
      : progress.dailyStreak;
    const nextProgress: SavedProgress = {
      bestScore: Math.max(progress.bestScore, finalScore),
      bestPada: Math.max(progress.bestPada, finalPada),
      totalRounds: progress.totalRounds + 1,
      lastPlayedAt: new Date().toISOString(),
      dailyStreak: nextDailyStreak,
      lastDailyDate: completedDaily ? today : progress.lastDailyDate,
      dailyCompletedDate: completedDaily ? today : progress.dailyCompletedDate,
      preferredLanguage: language,  usedQuestionIds: progress.usedQuestionIds,
  usedQuestionFingerprints: progress.usedQuestionFingerprints,
  generatedQuestions: progress.generatedQuestions,
    };
    setProgress(nextProgress);
    await saveProgress(nextProgress);
    setScreen('results');
  };

  const advanceAfterResult = async () => {
    if (dailyMode) {
      await finishGame(score, 1);
      return;
    }

    if (resultState === 'correct' && pada < TOTAL_PADAS) {
      const nextPada = pada + 1;
      if (SAFETY_NETS.has(pada)) {
        setShowMilestone(true);
        playTone('milestone');
        setTimeout(() => setShowMilestone(false), 1600);
      }

      const nextQuestion = roundQuestions[nextPada - 1];
      if (!nextQuestion) {
        await finishGame(score, pada);
        return;
      }

      setPada(nextPada);
      setQuestion(localizeQuestion(nextQuestion, language));
      setSelected(null);
      setResultState('idle');
      setDisabledOptions([]);
      setAudience(null);
      setGuruMessage(null);
      setSeconds(timerForPada(nextPada));
      return;
    }

    await finishGame(score, pada);
  };

  const chooseAnswer = (index: number) => {
    if (!question || selected !== null || disabledOptions.includes(index) || resultState !== 'idle') return;
    setSelected(index);
    setResultState(index === question.answer ? 'correct' : 'wrong');
    if (index === question.answer) {
      setScore((value) => value + REWARDS[pada - 1]);
      playTone('correct');
    } else {
      playTone('wrong');
    }
  };

  const useLifeline = async (lifeline: Lifeline) => {
    if (!question || usedLifelines.includes(lifeline) || resultState !== 'idle') return;
    setUsedLifelines((items) => [...items, lifeline]);
    playTone('lock');
    if (lifeline === 'divya') {
      const incorrect = shuffle(question.options.map((_, index) => index).filter((index) => index !== question.answer)).slice(0, 2);
      setDisabledOptions(incorrect);
    }
    if (lifeline === 'janmat') {
      const poll = question.options.map((_, index) => (index === question.answer ? 45 + Math.floor(Math.random() * 18) : 8 + Math.floor(Math.random() * 12)));
      const remainder = 100 - poll.reduce((total, value) => total + value, 0);
      poll[(question.answer + 1) % 4] += Math.max(0, remainder);
      setAudience(poll);
    }
    if (lifeline === 'parivartan') {
      try {
        const saved = await readProgress();
        let replacement: Question | undefined;

        const localCandidates = [...saved.generatedQuestions, ...QUESTION_BANK]
          .filter((q) => q.level === difficultyForPada(pada))
          .filter((q) => !saved.usedQuestionIds.includes(q.id))
          .filter((q) => !saved.usedQuestionFingerprints.includes(questionFingerprint(q)))
          .sort(() => Math.random() - 0.5);
        replacement = localCandidates[0];

        if (!replacement && onlineMode) {
          const fresh = await generateOnlineQuestions(
            [...saved.generatedQuestions, ...QUESTION_BANK],
            language,
            10,
          );
          replacement = fresh.find((q) => q.level === difficultyForPada(pada));
          if (replacement) {
            saved.generatedQuestions = [...saved.generatedQuestions, replacement];
          }
        }

        if (!replacement) throw new Error('No unused replacement question is available.');

        const nextSaved = {
          ...saved,
          usedQuestionIds: [...new Set([...saved.usedQuestionIds, replacement.id])],
          usedQuestionFingerprints: [...new Set([...saved.usedQuestionFingerprints, questionFingerprint(replacement)])],
        };
        await saveProgress(nextSaved);
        setProgress(nextSaved);

        setQuestion(localizeQuestion(replacement, language));
        setRoundQuestions((items) => items.map((item, index) => index === pada - 1 ? replacement! : item));
        setUsedIds((ids) => [...ids, replacement!.id]);
        setSelected(null);
        setResultState('idle');
        setDisabledOptions([]);
        setAudience(null);
        setGuruMessage(null);
        setSeconds(timerForPada(pada));
      } catch (error) {
        setGuruMessage(error instanceof Error ? error.message : 'No unused replacement question is available.');
      }
    }
    if (lifeline === 'muni') {
      setGuruLoading(true);
      try {
        const guidance = await askMuniSalah(question, question.options, language);
        setGuruMessage(guidance);
      } catch {
        setGuruMessage(`${copy.fallbackGuru} (${LETTERS[question.answer]})`);
      } finally {
        setGuruLoading(false);
      }
    }
  };

  if (screen === 'home') {
    return (
      <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={[styles.homeContent, { paddingBottom: insets.bottom + 28 }]} showsVerticalScrollIndicator={false}>
          <View style={styles.topBar}>
            <View>
              <Text style={[styles.kicker, { color: colors.saffronSoft }]}>{copy.kicker}</Text>
              <Text style={[styles.wordmark, { color: colors.ivory }]}>KAUN HAI</Text>
              <Text style={[styles.wordmarkAccent, { color: colors.gold }]}>SANATANI?</Text>
            </View>
            <View style={styles.topActions}>
              <View style={[styles.mudraPill, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Feather name="award" size={15} color={colors.gold} />
                <Text style={[styles.mudraText, { color: colors.ivory }]}>{progress.bestScore.toLocaleString()}</Text>
              </View>
              <View style={[styles.languageToggle, { backgroundColor: colors.card, borderColor: colors.border }]}>
                <Pressable onPress={() => changeLanguage('en')} style={[styles.languageButton, language === 'en' && { backgroundColor: colors.gold }]}>
                  <Text style={[styles.languageText, { color: language === 'en' ? colors.primaryForeground : colors.mutedForeground }]}>{copy.languageEnglish}</Text>
                </Pressable>
                <Pressable onPress={() => changeLanguage('hi')} style={[styles.languageButton, language === 'hi' && { backgroundColor: colors.gold }]}>
                  <Text style={[styles.languageText, { color: language === 'hi' ? colors.primaryForeground : colors.mutedForeground }]}>{copy.languageHindi}</Text>
                </Pressable>
              </View>
            </View>
          </View>

          <View style={styles.hero}>
            <Animated.View style={[styles.radiantCircle, { transform: [{ scale: pulse }], backgroundColor: colors.saffron }]} />
            <Image source={require('@/assets/images/icon.png')} style={styles.heroIcon} />
            <Text style={[styles.heroTitle, { color: colors.ivory }]}>{copy.questTitle}</Text>
            <Text style={[styles.heroBody, { color: colors.mutedForeground }]}>
              {copy.questBody}
            </Text>
          </View>

          <View style={[styles.progressCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.rowBetween}>
              <SectionEyebrow>{copy.yourYatra}</SectionEyebrow>
              <Text style={[styles.progressValue, { color: colors.gold }]}>{copy.pada} {progress.bestPada || 0} / 15</Text>
            </View>
            <View style={[styles.progressTrack, { backgroundColor: colors.muted }]}>
              <View style={[styles.progressFill, { width: `${Math.min(100, (progress.bestPada / TOTAL_PADAS) * 100)}%`, backgroundColor: colors.gold }]} />
            </View>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{progress.totalRounds} {copy.completedRounds}</Text>
              <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{copy.safetyNets}</Text>
            </View>
          </View>

          <PrimaryButton label={roundLoading ? copy.preparing : copy.beginYatra} onPress={() => void beginGame()} icon="arrow-right" disabled={roundLoading} />

          <View style={[styles.dailyCard, { backgroundColor: colors.navyRaised, borderColor: colors.saffron }]}>
            <View style={[styles.dailyIcon, { backgroundColor: colors.saffron }]}>
              <Feather name="sunrise" size={19} color={colors.ivory} />
            </View>
            <View style={styles.dailyCopy}>
              <View style={styles.rowBetween}>
                <Text style={[styles.dailyTitle, { color: colors.ivory }]}>{copy.dailyChallenge}</Text>
                <Text style={[styles.streakText, { color: colors.gold }]}>{progress.dailyStreak} {copy.streak}</Text>
              </View>
              <Text style={[styles.dailySubtitle, { color: colors.mutedForeground }]}>{progress.dailyCompletedDate === TODAY() ? copy.dailyDone : copy.dailySubtitle}</Text>
            </View>
            <Pressable
              testID="button-daily-challenge"
              disabled={progress.dailyCompletedDate === TODAY() || roundLoading}
              onPress={() => void beginGame(true)}
              style={({ pressed }) => [styles.dailyButton, { backgroundColor: progress.dailyCompletedDate === TODAY() ? colors.muted : colors.gold, opacity: pressed ? 0.8 : 1 }]}
            >
              <Feather name={progress.dailyCompletedDate === TODAY() ? 'check' : 'arrow-up-right'} size={17} color={progress.dailyCompletedDate === TODAY() ? colors.mutedForeground : colors.primaryForeground} />
            </Pressable>
          </View>

          <Pressable
            testID="toggle-online-mode"
            onPress={() => setOnlineMode((value) => !value)}
            style={[styles.onlineToggle, { backgroundColor: colors.card, borderColor: onlineMode ? colors.gold : colors.border }]}
          >
            <View style={[styles.toggleIcon, { backgroundColor: onlineMode ? colors.gold : colors.muted }]}>
              <Feather name={onlineMode ? 'globe' : 'download'} size={15} color={onlineMode ? colors.primaryForeground : colors.mutedForeground} />
            </View>
            <View style={styles.onlineCopy}>
              <Text style={[styles.onlineTitle, { color: colors.ivory }]}>{copy.onlineMode}</Text>
              <Text style={[styles.onlineSubtitle, { color: colors.mutedForeground }]}>{onlineMode ? copy.onlineOn : copy.offlineBank}</Text>
            </View>
            <View style={[styles.switchTrack, { backgroundColor: onlineMode ? colors.gold : colors.muted }]}>
              <View style={[styles.switchThumb, { backgroundColor: onlineMode ? colors.primaryForeground : colors.mutedForeground, alignSelf: onlineMode ? 'flex-end' : 'flex-start' }]} />
            </View>
          </Pressable>

          <View style={styles.homeFooter}>
            <Feather name="shield" size={15} color={colors.saffronSoft} />
            <Text style={[styles.legalNote, { color: colors.mutedForeground }]}>{copy.original}</Text>
          </View>
        </ScrollView>
      </View>
    );
  }

  if (screen === 'results') {
    return (
      <LinearGradient colors={[colors.background, colors.navyRaised, colors.background]} style={[styles.root, { paddingTop: insets.top }]}>
        <ScrollView contentContainerStyle={[styles.resultsContent, { paddingBottom: insets.bottom + 28 }]}>
          <View style={styles.resultsSymbol}>
            <Feather name={pada === TOTAL_PADAS ? 'sun' : 'compass'} size={48} color={colors.gold} />
          </View>
          <SectionEyebrow>{dailyMode ? copy.dailyChallenge : pada === TOTAL_PADAS ? copy.paramComplete : copy.yatraPaused}</SectionEyebrow>
          <Text style={[styles.resultsTitle, { color: colors.ivory }]}>
            {dailyMode ? copy.dailyCompleteTitle : pada === TOTAL_PADAS ? copy.completeTitle : copy.pausedTitle}
          </Text>
          <Text style={[styles.resultsSubtitle, { color: colors.mutedForeground }]}>
            {dailyMode ? copy.dailyCompleteSubtitle : pada === TOTAL_PADAS ? copy.completeSubtitle : copy.pausedSubtitle.replace('{pada}', String(pada))}
          </Text>
          <View style={[styles.scoreCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Text style={[styles.scoreLabel, { color: colors.mutedForeground }]}>{copy.punyaMudras}</Text>
            <Text style={[styles.scoreNumber, { color: colors.gold }]}>{score.toLocaleString()}</Text>
            <View style={styles.scoreDivider} />
            <View style={styles.rowBetween}>
              <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{copy.padaReached}</Text>
              <Text style={[styles.scoreStat, { color: colors.ivory }]}>{pada} / 15</Text>
            </View>
            <View style={styles.rowBetween}>
              <Text style={[styles.cardMeta, { color: colors.mutedForeground }]}>{copy.personalBest}</Text>
              <Text style={[styles.scoreStat, { color: colors.ivory }]}>{Math.max(progress.bestScore, score).toLocaleString()}</Text>
            </View>
          </View>
          <PrimaryButton label={copy.newYatra} onPress={() => void beginGame()} icon="refresh-cw" />
          <Pressable onPress={() => setScreen('home')} style={styles.secondaryButton}>
            <Text style={[styles.secondaryButtonText, { color: colors.mutedForeground }]}>{copy.sanctuary}</Text>
          </Pressable>
        </ScrollView>
      </LinearGradient>
    );
  }

  if (!question) return null;
  const timer = timerForPada(pada);
  const timerProgress = timer ? Math.max(0, (seconds ?? timer) / timer) : 1;

  return (
    <View style={[styles.root, { backgroundColor: colors.background, paddingTop: insets.top }]}>
      <ScrollView contentContainerStyle={[styles.gameContent, { paddingBottom: insets.bottom + 20 }]} showsVerticalScrollIndicator={false}>
        <View style={styles.gameTopBar}>
          <Pressable onPress={() => setShowExit(true)} hitSlop={12} testID="button-exit">
            <Feather name="x" size={22} color={colors.mutedForeground} />
          </Pressable>
          <View style={styles.gameTitle}>
            <Text style={[styles.kicker, { color: colors.saffronSoft }]}>KAUN HAI SANATANI?</Text>
            <Text style={[styles.levelText, { color: colors.ivory }]}>{language === 'hi' ? pada <= 5 ? 'प्रथम पद' : pada <= 10 ? 'मध्यम पद' : 'परम पद' : levelLabel}</Text>
          </View>
          <View style={[styles.scorePill, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="award" size={14} color={colors.gold} />
            <Text style={[styles.scorePillText, { color: colors.gold }]}>{score.toLocaleString()}</Text>
          </View>
        </View>

        <View style={styles.padaRow}>
          <View>
            <Text style={[styles.padaLabel, { color: colors.mutedForeground }]}>{copy.currentPada}</Text>
            <Text style={[styles.padaNumber, { color: colors.ivory }]}>{String(pada).padStart(2, '0')}<Text style={{ color: colors.saffron }}> / 15</Text></Text>
          </View>
          {timer ? (
            <View style={[styles.timerRing, { borderColor: seconds && seconds <= 8 ? colors.saffron : colors.gold }]}>
              <Text style={[styles.timerNumber, { color: seconds && seconds <= 8 ? colors.saffron : colors.gold }]}>{seconds}</Text>
              <Text style={[styles.timerUnit, { color: colors.mutedForeground }]}>{language === 'hi' ? 'सेकंड' : 'sec'}</Text>
            </View>
          ) : (
            <View style={[styles.deepMode, { borderColor: colors.border }]}>
              <Feather name="moon" size={15} color={colors.saffronSoft} />
              <Text style={[styles.deepModeText, { color: colors.mutedForeground }]}>{copy.contemplation}</Text>
            </View>
          )}
        </View>
        {timer ? (
          <View style={[styles.timerTrack, { backgroundColor: colors.muted }]}>
            <View style={[styles.timerFill, { width: `${timerProgress * 100}%`, backgroundColor: seconds && seconds <= 8 ? colors.saffron : colors.gold }]} />
          </View>
        ) : null}

        <View style={styles.questionBlock}>
          <View style={styles.categoryRow}>
            <View style={[styles.categoryDot, { backgroundColor: colors.saffron }]} />
            <Text style={[styles.categoryText, { color: colors.saffronSoft }]}>{categoryLabel(question.category, language)} • {REWARDS[pada - 1].toLocaleString()} {copy.mudras}</Text>
          </View>
          <Text style={[styles.questionText, { color: colors.ivory }]}>{question.prompt}</Text>
        </View>

        <View style={styles.options}>
          {question.options.map((option, index) => {
            const isSelected = selected === index;
            const isAnswer = question.answer === index;
            const showCorrect = resultState !== 'idle' && isAnswer;
            const showWrong = resultState === 'wrong' && isSelected;
            const optionColor = showCorrect ? colors.success : showWrong ? colors.saffron : colors.card;
            return (
              <Pressable
                key={`${question.id}-${index}`}
                testID={`option-${index}`}
                disabled={selected !== null || disabledOptions.includes(index)}
                onPress={() => chooseAnswer(index)}
                style={({ pressed }) => [
                  styles.option,
                  { backgroundColor: disabledOptions.includes(index) ? colors.navyRaised : optionColor, borderColor: showCorrect ? colors.success : showWrong ? colors.saffron : colors.border, opacity: disabledOptions.includes(index) ? 0.34 : pressed ? 0.78 : 1 },
                ]}
              >
                <View style={[styles.optionLetter, { borderColor: showCorrect || showWrong ? optionColor : colors.border }]}>
                  <Text style={[styles.optionLetterText, { color: showCorrect || showWrong ? colors.background : colors.mutedForeground }]}>{LETTERS[index]}</Text>
                </View>
                <Text style={[styles.optionText, { color: showCorrect || showWrong ? colors.background : colors.ivory }]}>{option}</Text>
                {showCorrect ? <Feather name="check-circle" size={19} color={colors.background} /> : showWrong ? <Feather name="x-circle" size={19} color={colors.background} /> : null}
              </Pressable>
            );
          })}
        </View>

        {audience ? (
          <View style={[styles.audienceCard, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <View style={styles.rowBetween}><Text style={[styles.eyebrow, { color: colors.gold }]}>{copy.janmat.toUpperCase()}</Text><Feather name="bar-chart-2" color={colors.gold} size={16} /></View>
            {audience.map((value, index) => (
              <View key={index} style={styles.pollRow}>
                <Text style={[styles.pollLetter, { color: colors.mutedForeground }]}>{LETTERS[index]}</Text>
                <View style={[styles.pollTrack, { backgroundColor: colors.muted }]}><View style={[styles.pollFill, { width: `${value}%`, backgroundColor: index === question.answer ? colors.gold : colors.saffron }]} /></View>
                <Text style={[styles.pollValue, { color: colors.ivory }]}>{value}%</Text>
              </View>
            ))}
          </View>
        ) : null}

        {guruLoading || guruMessage ? (
          <View style={[styles.guruCard, { backgroundColor: colors.navyRaised, borderColor: colors.purple }]}>
            <View style={styles.rowBetween}><Text style={[styles.eyebrow, { color: colors.purple }]}>{copy.muni.toUpperCase()}</Text>{guruLoading ? <ActivityIndicator color={colors.gold} size="small" /> : <Feather name="book-open" color={colors.gold} size={16} />}</View>
            <Text style={[styles.guruText, { color: colors.ivory }]}>{guruLoading ? copy.guruThinking : guruMessage}</Text>
          </View>
        ) : null}

        {resultState !== 'idle' ? (
          <View style={[styles.explanationCard, { backgroundColor: resultState === 'correct' ? 'rgba(104, 198, 140, 0.13)' : 'rgba(228, 92, 42, 0.13)', borderColor: resultState === 'correct' ? colors.success : colors.saffron }]}>
            <Text style={[styles.explanationTitle, { color: resultState === 'correct' ? colors.success : colors.saffronSoft }]}>{resultState === 'correct' ? copy.correct : resultState === 'timeout' ? copy.timePassed : copy.thoughtful}</Text>
            <Text style={[styles.explanationText, { color: colors.ivory }]}>{question.explanation}</Text>
            <PrimaryButton label={resultState === 'correct' && pada < TOTAL_PADAS && !dailyMode ? copy.continuePada : copy.seeResult} onPress={() => void advanceAfterResult()} icon="arrow-right" />
          </View>
        ) : null}

        <View style={styles.lifelineSection}>
          <Text style={[styles.lifelineHeading, { color: colors.mutedForeground }]}>{copy.sahayak}</Text>
          <View style={styles.lifelines}>
            {([
              ['divya', 'eye', copy.divya],
              ['muni', 'message-circle', copy.muni],
              ['janmat', 'users', copy.janmat],
              ['parivartan', 'repeat', copy.parivartan],
            ] as [Lifeline, keyof typeof Feather.glyphMap, string][]).map(([id, icon, label]) => {
              const used = usedLifelines.includes(id);
              return (
                <Pressable key={id} testID={`lifeline-${id}`} disabled={used || selected !== null} onPress={() => void useLifeline(id)} style={[styles.lifeline, { borderColor: used ? colors.muted : colors.border, backgroundColor: used ? colors.navyRaised : colors.card, opacity: used ? 0.42 : 1 }]}>
                  <Feather name={icon} size={17} color={used ? colors.mutedForeground : colors.gold} />
                  <Text style={[styles.lifelineText, { color: used ? colors.mutedForeground : colors.ivory }]}>{label}</Text>
                  {used ? <Feather name="check" size={12} color={colors.mutedForeground} /> : null}
                </Pressable>
              );
            })}
          </View>
        </View>
      </ScrollView>

      {showMilestone ? (
        <View pointerEvents="none" style={styles.milestoneOverlay}>
          <View style={[styles.milestoneCard, { backgroundColor: colors.card, borderColor: colors.gold }]}>
            <Feather name="star" size={30} color={colors.gold} />
            <Text style={[styles.milestoneTitle, { color: colors.ivory }]}>{copy.safetySecured}</Text>
            <Text style={[styles.milestoneText, { color: colors.mutedForeground }]}>{copy.pada} {pada} • {copy.punyaProtected}</Text>
          </View>
        </View>
      ) : null}

      {showExit ? (
        <View style={styles.modalOverlay}>
          <View style={[styles.exitModal, { backgroundColor: colors.card, borderColor: colors.border }]}>
            <Feather name="pause-circle" color={colors.gold} size={28} />
            <Text style={[styles.modalTitle, { color: colors.ivory }]}>{copy.leaveTitle}</Text>
            <Text style={[styles.modalBody, { color: colors.mutedForeground }]}>{copy.leaveBody}</Text>
            <View style={styles.modalActions}>
              <Pressable onPress={() => setShowExit(false)} style={[styles.modalButton, { backgroundColor: colors.muted }]}><Text style={[styles.modalButtonText, { color: colors.ivory }]}>{copy.stay}</Text></Pressable>
              <Pressable onPress={() => { setShowExit(false); setScreen('home'); }} style={[styles.modalButton, { backgroundColor: colors.saffron }]}><Text style={[styles.modalButtonText, { color: colors.ivory }]}>{copy.leave}</Text></Pressable>
            </View>
          </View>
        </View>
      ) : null}
    </View>
  );
}

export default App;

const styles = StyleSheet.create({
  root: { flex: 1 },
  homeContent: { paddingHorizontal: 22, paddingTop: 26, gap: 22 },
  topBar: { flexDirection: 'row', alignItems: 'flex-start', justifyContent: 'space-between' },
  topActions: { alignItems: 'flex-end', gap: 8 },
  kicker: { fontSize: 10, letterSpacing: 2.2, fontWeight: '700' as const },
  wordmark: { fontSize: 27, fontWeight: '800' as const, letterSpacing: 1.2, lineHeight: 29 },
  wordmarkAccent: { fontSize: 27, fontWeight: '800' as const, letterSpacing: 1.2, lineHeight: 29 },
  mudraPill: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 6 },
  mudraText: { fontSize: 12, fontWeight: '700' as const },
  languageToggle: { borderWidth: 1, borderRadius: 12, padding: 3, flexDirection: 'row', gap: 2 },
  languageButton: { borderRadius: 9, paddingHorizontal: 7, paddingVertical: 5 },
  languageText: { fontSize: 9, fontWeight: '800' as const },
  hero: { alignItems: 'center', paddingTop: 30, paddingBottom: 12 },
  radiantCircle: { position: 'absolute', width: 220, height: 220, borderRadius: 110, opacity: 0.12, top: 18 },
  heroIcon: { width: 130, height: 130, borderRadius: 34, marginBottom: 25 },
  heroTitle: { fontSize: 28, fontWeight: '700' as const, lineHeight: 34, textAlign: 'center', letterSpacing: -0.5 },
  heroBody: { fontSize: 14, lineHeight: 21, textAlign: 'center', marginTop: 13, maxWidth: 320 },
  progressCard: { borderRadius: 18, borderWidth: 1, padding: 16, gap: 13 },
  rowBetween: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  eyebrow: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 1.6 },
  progressValue: { fontSize: 12, fontWeight: '700' as const },
  progressTrack: { height: 7, borderRadius: 5, overflow: 'hidden' },
  progressFill: { height: '100%', borderRadius: 5 },
  cardMeta: { fontSize: 11 },
  primaryButton: { minHeight: 58, borderRadius: 16, alignItems: 'center', justifyContent: 'center', flexDirection: 'row', gap: 12, paddingHorizontal: 20 },
  primaryButtonText: { fontSize: 15, fontWeight: '800' as const, letterSpacing: 0.2 },
  homeFooter: { flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 7, paddingTop: 10 },
  legalNote: { fontSize: 10, letterSpacing: 0.2 },
  dailyCard: { borderWidth: 1, borderRadius: 18, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 11 },
  dailyIcon: { width: 38, height: 38, borderRadius: 13, alignItems: 'center', justifyContent: 'center' },
  dailyCopy: { flex: 1, gap: 5 },
  dailyTitle: { fontSize: 13, fontWeight: '800' as const },
  dailySubtitle: { fontSize: 10 },
  streakText: { fontSize: 10, fontWeight: '800' as const },
  dailyButton: { width: 34, height: 34, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  onlineToggle: { borderWidth: 1, borderRadius: 16, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 11 },
  toggleIcon: { width: 32, height: 32, borderRadius: 10, alignItems: 'center', justifyContent: 'center' },
  onlineCopy: { flex: 1, gap: 3 },
  onlineTitle: { fontSize: 12, fontWeight: '800' as const },
  onlineSubtitle: { fontSize: 10 },
  switchTrack: { width: 34, height: 20, borderRadius: 11, padding: 3 },
  switchThumb: { width: 14, height: 14, borderRadius: 7 },
  resultsContent: { paddingHorizontal: 22, paddingTop: 70, gap: 18, alignItems: 'center' },
  resultsSymbol: { width: 100, height: 100, borderRadius: 50, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(244, 185, 66, 0.12)', marginBottom: 6 },
  resultsTitle: { fontSize: 29, lineHeight: 35, fontWeight: '700' as const, textAlign: 'center', letterSpacing: -0.5 },
  resultsSubtitle: { fontSize: 14, lineHeight: 21, textAlign: 'center', maxWidth: 320 },
  scoreCard: { width: '100%', borderRadius: 18, borderWidth: 1, padding: 20, gap: 14, marginVertical: 8 },
  scoreLabel: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 1.6, textAlign: 'center' },
  scoreNumber: { fontSize: 48, fontWeight: '800' as const, textAlign: 'center', letterSpacing: -1 },
  scoreDivider: { height: 1, backgroundColor: 'rgba(255,255,255,0.12)', marginVertical: 3 },
  scoreStat: { fontSize: 13, fontWeight: '700' as const },
  secondaryButton: { padding: 14 },
  secondaryButtonText: { fontSize: 13, fontWeight: '700' as const },
  gameContent: { paddingHorizontal: 18, paddingTop: 18, gap: 18 },
  gameTopBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  gameTitle: { alignItems: 'center', gap: 2 },
  levelText: { fontSize: 13, fontWeight: '700' as const },
  scorePill: { borderRadius: 16, borderWidth: 1, paddingHorizontal: 9, paddingVertical: 7, flexDirection: 'row', alignItems: 'center', gap: 5 },
  scorePillText: { fontSize: 11, fontWeight: '800' as const },
  padaRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingTop: 10 },
  padaLabel: { fontSize: 10, fontWeight: '700' as const, letterSpacing: 1.4 },
  padaNumber: { fontSize: 35, fontWeight: '800' as const, letterSpacing: -1 },
  timerRing: { width: 66, height: 66, borderRadius: 33, borderWidth: 2, alignItems: 'center', justifyContent: 'center' },
  timerNumber: { fontSize: 20, fontWeight: '800' as const, lineHeight: 22 },
  timerUnit: { fontSize: 9, letterSpacing: 0.4 },
  deepMode: { borderWidth: 1, borderRadius: 20, paddingHorizontal: 12, paddingVertical: 9, flexDirection: 'row', alignItems: 'center', gap: 7 },
  deepModeText: { fontSize: 11, fontWeight: '700' as const },
  timerTrack: { height: 4, borderRadius: 3, overflow: 'hidden' },
  timerFill: { height: '100%', borderRadius: 3 },
  questionBlock: { paddingTop: 7, gap: 10 },
  categoryRow: { flexDirection: 'row', alignItems: 'center', gap: 7 },
  categoryDot: { width: 6, height: 6, borderRadius: 3 },
  categoryText: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 1.2 },
  questionText: { fontSize: 23, lineHeight: 31, fontWeight: '700' as const, letterSpacing: -0.3 },
  options: { gap: 10 },
  option: { minHeight: 64, borderRadius: 15, borderWidth: 1, padding: 12, flexDirection: 'row', alignItems: 'center', gap: 12 },
  optionLetter: { width: 31, height: 31, borderRadius: 16, borderWidth: 1, alignItems: 'center', justifyContent: 'center' },
  optionLetterText: { fontSize: 12, fontWeight: '800' as const },
  optionText: { flex: 1, fontSize: 14, lineHeight: 19, fontWeight: '600' as const },
  audienceCard: { borderRadius: 16, borderWidth: 1, padding: 14, gap: 10 },
  pollRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  pollLetter: { width: 14, fontSize: 11, fontWeight: '800' as const },
  pollTrack: { flex: 1, height: 8, borderRadius: 4, overflow: 'hidden' },
  pollFill: { height: '100%', borderRadius: 4 },
  pollValue: { width: 32, textAlign: 'right', fontSize: 11, fontWeight: '700' as const },
  guruCard: { borderRadius: 16, borderWidth: 1, padding: 15, gap: 10 },
  guruText: { fontSize: 13, lineHeight: 20 },
  explanationCard: { borderRadius: 16, borderWidth: 1, padding: 15, gap: 10 },
  explanationTitle: { fontSize: 13, fontWeight: '800' as const },
  explanationText: { fontSize: 13, lineHeight: 20 },
  lifelineSection: { gap: 11, paddingTop: 4 },
  lifelineHeading: { fontSize: 10, fontWeight: '800' as const, letterSpacing: 1.5 },
  lifelines: { flexDirection: 'row', flexWrap: 'wrap', gap: 8 },
  lifeline: { minHeight: 43, borderWidth: 1, borderRadius: 13, paddingHorizontal: 10, flexDirection: 'row', alignItems: 'center', gap: 7, flexGrow: 1, flexBasis: '45%' },
  lifelineText: { fontSize: 10, fontWeight: '700' as const, flex: 1 },
  milestoneOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(6, 10, 26, 0.68)' },
  milestoneCard: { borderRadius: 18, borderWidth: 1, padding: 26, alignItems: 'center', gap: 8, marginHorizontal: 30 },
  milestoneTitle: { fontSize: 19, fontWeight: '800' as const },
  milestoneText: { fontSize: 12 },
  modalOverlay: { position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, backgroundColor: 'rgba(6, 10, 26, 0.78)', alignItems: 'center', justifyContent: 'center', padding: 25 },
  exitModal: { borderRadius: 18, borderWidth: 1, padding: 24, alignItems: 'center', gap: 11, width: '100%' },
  modalTitle: { fontSize: 20, fontWeight: '800' as const },
  modalBody: { fontSize: 13, textAlign: 'center', lineHeight: 20 },
  modalActions: { flexDirection: 'row', gap: 10, width: '100%', marginTop: 7 },
  modalButton: { flex: 1, minHeight: 46, borderRadius: 12, alignItems: 'center', justifyContent: 'center' },
  modalButtonText: { fontSize: 13, fontWeight: '800' as const },
});