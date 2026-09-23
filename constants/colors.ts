/**
 * Semantic design tokens for the mobile app.
 *
 * These tokens mirror the naming conventions used in web artifacts (index.css)
 * so that multi-artifact projects share a cohesive visual identity.
 *
 * Replace the placeholder values below with values that match the project's
 * brand. If a sibling web artifact exists, read its index.css and convert the
 * HSL values to hex so both artifacts use the same palette.
 *
 * To add dark mode, add a `dark` key with the same token names.
 * The useColors() hook will automatically pick it up.
 */

const colors = {
  light: {
    text: '#F9E7BE',
    tint: '#F4B942',
    background: '#080D20',
    foreground: '#F9E7BE',
    card: '#121A34',
    cardForeground: '#FFF5DC',
    primary: '#F4B942',
    primaryForeground: '#171326',
    secondary: '#202A4B',
    secondaryForeground: '#F9E7BE',
    muted: '#1A2442',
    mutedForeground: '#A8B1C9',
    accent: '#E45C2A',
    accentForeground: '#FFF8E8',
    destructive: '#D84A4A',
    destructiveForeground: '#FFF9F1',
    border: '#3C4770',
    input: '#303B63',
    saffron: '#E45C2A',
    saffronSoft: '#F08B44',
    navy: '#080D20',
    navyRaised: '#101832',
    gold: '#F4B942',
    ivory: '#FFF5DC',
    success: '#68C68C',
    purple: '#6F5CD7',
    overlay: 'rgba(6, 10, 26, 0.86)',
  },
  radius: 18,
};

export default colors;
