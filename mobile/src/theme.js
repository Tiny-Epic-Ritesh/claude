/**
 * Enough of the CRM's palette to not look like a different product.
 *
 * Taken from the tokens in `client/src/styles.css` rather than picked afresh.
 * A throwaway shell still gets shown to two RMs, and "is this the same system?"
 * is not a question worth spending their attention on.
 */
export const t = {
  bg: '#0e1524',
  surface: '#16203a',
  surfaceHi: '#1d2947',
  border: '#26324f',
  text: '#e8edf7',
  muted: '#93a0bd',
  accent: '#7ac943',
  accentText: '#0e1524',
  danger: '#e5534b',
  warn: '#d9a441',
  radius: 12,
  gap: 12,
};

export const s = {
  screen: { flex: 1, backgroundColor: t.bg },
  pad: { padding: 16 },
  h1: { color: t.text, fontSize: 24, fontWeight: '700' },
  h2: { color: t.text, fontSize: 17, fontWeight: '600' },
  muted: { color: t.muted, fontSize: 13 },
  label: { color: t.muted, fontSize: 12, marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.6 },
  input: {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: t.radius,
    color: t.text,
    paddingHorizontal: 14,
    paddingVertical: 12,
    fontSize: 16,
  },
  button: {
    backgroundColor: t.accent,
    borderRadius: t.radius,
    paddingVertical: 14,
    alignItems: 'center',
  },
  buttonText: { color: t.accentText, fontWeight: '700', fontSize: 16 },
  ghost: {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: t.radius,
    paddingVertical: 12,
    alignItems: 'center',
  },
  ghostText: { color: t.text, fontWeight: '600' },
  card: {
    backgroundColor: t.surface,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: t.radius,
    padding: 14,
    marginBottom: 10,
  },
  error: {
    backgroundColor: '#3a1d1d',
    borderColor: t.danger,
    borderWidth: 1,
    borderRadius: t.radius,
    padding: 12,
    marginBottom: 12,
  },
  errorText: { color: '#ffd9d6' },
  notice: {
    backgroundColor: t.surfaceHi,
    borderColor: t.border,
    borderWidth: 1,
    borderRadius: t.radius,
    padding: 12,
    marginBottom: 12,
  },
};
