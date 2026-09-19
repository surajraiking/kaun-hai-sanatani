import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

type Tone = 'lock' | 'correct' | 'milestone' | 'countdown' | 'wrong';

function webTone(tone: Tone) {
  if (Platform.OS !== 'web' || typeof window === 'undefined') return;
  const AudioContextClass =
    window.AudioContext ||
    (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioContextClass) return;
  const context = new AudioContextClass();
  const oscillator = context.createOscillator();
  const gain = context.createGain();
  const frequency =
    tone === 'correct' ? 660 : tone === 'milestone' ? 880 : tone === 'wrong' ? 190 : tone === 'countdown' ? 440 : 330;
  oscillator.frequency.value = frequency;
  oscillator.type = tone === 'milestone' ? 'sine' : 'triangle';
  gain.gain.setValueAtTime(0.0001, context.currentTime);
  gain.gain.exponentialRampToValueAtTime(tone === 'milestone' ? 0.12 : 0.06, context.currentTime + 0.02);
  gain.gain.exponentialRampToValueAtTime(0.0001, context.currentTime + (tone === 'milestone' ? 0.45 : 0.18));
  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start();
  oscillator.stop(context.currentTime + 0.5);
}

export function playTone(tone: Tone) {
  webTone(tone);
  if (tone === 'correct' || tone === 'milestone') {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  } else if (tone === 'wrong') {
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
  } else {
    void Haptics.selectionAsync();
  }
}
