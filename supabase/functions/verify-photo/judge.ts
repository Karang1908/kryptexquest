// Pure helpers for photo verification (no I/O, so they can be unit-tested with plain Node).

export type Verdict = { same: boolean; confidence: number; reason: string };
export type Decision = 'match' | 'review' | 'no_match';

/** confidence = how sure the model is that the player's photo shows the SAME object (0 = surely different, 1 = surely same). */
export const THRESHOLDS = { approve: 0.8, review: 0.5 };

export const VERDICT_SCHEMA = {
  type: 'object',
  properties: {
    same_object: { type: 'boolean' },
    confidence: { type: 'number' },
    reason: { type: 'string' },
  },
  required: ['same_object', 'confidence', 'reason'],
};

export function buildPrompt(description: string | null, referenceCount: number): string {
  return [
    `The first ${referenceCount} image(s) are reference photos of ONE specific real object or spot on a university campus, taken from different angles.`,
    'The LAST image is a photo submitted by a player.',
    description ? `The object is described to players as: "${description}".` : '',
    'Question: does the LAST image show the same object, in the same place, as the reference photos?',
    'Rules: the same kind of object elsewhere does not count (a different fire alarm, a different tree). Ignore lighting, angle, distance and people in the frame.',
    'If the last image is a photo of a screen, a printed picture, or does not clearly show the object, answer false.',
    'Reply with JSON only: {"same_object": boolean, "confidence": number between 0 and 1, "reason": short sentence}.',
    'confidence is how sure you are that it IS the same object: 0 means surely different, 1 means surely the same.',
  ].filter(Boolean).join('\n');
}

/** Ollama /api/chat body. Images are base64 without the data: prefix; the player's photo goes last. */
export function buildChatBody(model: string, prompt: string, referencesB64: string[], photoB64: string) {
  return {
    model,
    stream: false,
    format: VERDICT_SCHEMA,
    options: { temperature: 0 },
    messages: [{ role: 'user', content: prompt, images: [...referencesB64, photoB64] }],
  };
}

export function parseVerdict(text: string): Verdict | null {
  const candidates = [text, text.match(/\{[\s\S]*\}/)?.[0] ?? ''];
  for (const candidate of candidates) {
    try {
      const raw = JSON.parse(candidate);
      const same = typeof raw.same_object === 'boolean' ? raw.same_object : null;
      const confidence = Number(raw.confidence);
      if (same === null || !Number.isFinite(confidence)) continue;
      return { same, confidence: Math.min(1, Math.max(0, confidence)), reason: String(raw.reason ?? '').slice(0, 300) };
    } catch { /* try the next candidate */ }
  }
  return null;
}

export function decide(verdict: Verdict, th = THRESHOLDS): Decision {
  if (verdict.same && verdict.confidence >= th.approve) return 'match';
  // A confident "yes" with a contradicting flag, or an unsure "yes", goes to a human.
  if (verdict.confidence >= th.review) return 'review';
  return 'no_match';
}

/** Up to `max` references, always varied between calls so one bad angle cannot decide every attempt. */
export function pickReferences<T>(all: T[], max = 4, random = Math.random): T[] {
  const copy = [...all];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, max);
}
