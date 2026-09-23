# Kaun Hai Sanatani?

Expo/React Native Sanatana Dharma quiz app.

## Production safety
- Real `.env` files are intentionally excluded from this repository.
- Copy `.env.example` to `.env` for local development and add your own Gemini key.
- Never commit a Gemini API key to GitHub.
- `node_modules`, `.expo`, Android build output and Git metadata are excluded.

## Question uniqueness
The app persists used question IDs and normalized fingerprints with AsyncStorage. Generated questions are checked for exact and high-similarity duplicates before being accepted. Round selection rejects candidates similar to every persisted used/generated question, and game-start is guarded against double taps. Storage failures and malformed saved state are handled without crashing the quiz UI.

## Important persistence note
The local history survives normal app restarts and updates on the same installation. Clearing app data or uninstalling the app clears local history. Cross-device/permanent global uniqueness requires a server-side account/database.

## Commands
```bash
npm ci
npm run typecheck
npm run doctor
```

For EAS, keep the Gemini key in EAS environment/secrets rather than GitHub.
