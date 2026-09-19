# Kaun Hai Sanatani?

Expo SDK 57 Android quiz app.

## What was fixed

- Every normal game contains exactly 15 questions.
- Difficulty is progressive: 3 Easy, 3 Medium, 3 Hard, 3 Very Hard, 3 Expert.
- A question is permanently marked as used in AsyncStorage as soon as it is assigned to a round.
- Exact duplicates and high-overlap paraphrases are rejected.
- Gemini generates questions in batches of 30 (6 per difficulty), so the app does not call Gemini for every question.
- Generated questions are cached locally and consumed before another Gemini request.
- Reopening the app does not reset the used-question history.
- The question history survives normal app restarts and updates.
- If Gemini is unavailable, the app uses any remaining local questions; when the local pool is exhausted, Online Mode is required for unlimited new questions.
- The Daily Challenge also consumes an unused question instead of reusing the same deterministic question.

## Gemini configuration

Copy `.env.example` to `.env` and set:

```text
EXPO_PUBLIC_GEMINI_API_KEY=YOUR_KEY
EXPO_PUBLIC_GEMINI_MODEL=gemini-2.5-flash-lite
```

The current implementation calls Gemini directly from the Android app. This is convenient for a personal/testing build, but the API key is embedded in the application bundle and can be extracted. For a public Play Store release, move Gemini calls behind a server and keep the key server-side.

## Local build

```bash
npm install
npx expo install --fix
npx expo prebuild --platform android --clean
cd android
./gradlew assembleRelease
./gradlew bundleRelease
```

APK:
`android/app/build/outputs/apk/release/app-release.apk`

AAB:
`android/app/build/outputs/bundle/release/app-release.aab`

## GitHub Actions

Set a repository secret named `GEMINI_API_KEY`. The workflow passes it as `EXPO_PUBLIC_GEMINI_API_KEY` during the build.

Important: this still embeds the key in the APK/AAB. Use a backend for a public production app.
