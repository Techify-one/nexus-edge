const LETTER_NAMES: Record<string, string> = {
  a: "A",
  be: "B",
  b: "B",
  ce: "C",
  c: "C",
  de: "D",
  d: "D",
  e: "E",
  efe: "F",
  f: "F",
  ge: "G",
  g: "G",
  aga: "H",
  h: "H",
  i: "I",
  jota: "J",
  j: "J",
  ca: "K",
  kapa: "K",
  k: "K",
  ele: "L",
  l: "L",
  eme: "M",
  m: "M",
  ene: "N",
  n: "N",
  o: "O",
  pe: "P",
  p: "P",
  que: "Q",
  q: "Q",
  erre: "R",
  r: "R",
  esse: "S",
  s: "S",
  te: "T",
  t: "T",
  u: "U",
  ve: "V",
  v: "V",
  dablio: "W",
  dabliu: "W",
  w: "W",
  xis: "X",
  x: "X",
  ipsilon: "Y",
  y: "Y",
  ze: "Z",
  z: "Z",
};

const IGNORED_WORDS = new Set([
  "letra",
  "letras",
  "soletrando",
  "soletracao",
  "dois",
  "pontos",
]);

const fold = (value: string): string =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();

export type ParsedSpelling = {
  letters: string;
  ambiguous: boolean;
  unknownTokens: string[];
};

export function parseSpelling(transcript: string): ParsedSpelling {
  const source = transcript.trim();
  if (!source) return { letters: "", ambiguous: true, unknownTokens: [] };

  const clearlySeparated = /[-,.;:/]|\b[A-Z]\s+[A-Z]\b/u.test(source);
  const cleaned = fold(source)
    .replace(/\b(as|a)\s+letras?\s+(sao|foram|e)\b/gu, " ")
    .replace(/\b(transcricao|resultado)\b/gu, " ")
    .replace(/[^a-z\s-]/gu, " ")
    .replace(/-/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();

  if (!cleaned) return { letters: "", ambiguous: true, unknownTokens: [] };

  const tokens = cleaned.split(" ").filter(Boolean);
  if (tokens.length === 1 && tokens[0]!.length > 1 && !LETTER_NAMES[tokens[0]!])
    return {
      letters: "",
      ambiguous: !clearlySeparated,
      unknownTokens: tokens,
    };

  const letters: string[] = [];
  const unknownTokens: string[] = [];
  for (const token of tokens) {
    if (IGNORED_WORDS.has(token)) continue;
    const letter = LETTER_NAMES[token];
    if (letter) letters.push(letter);
    else unknownTokens.push(token);
  }

  return {
    letters: letters.join(""),
    ambiguous: letters.length === 0 || unknownTokens.length > 0,
    unknownTokens,
  };
}

export const collapseRecognition = (transcript: string): string =>
  fold(transcript)
    .replace(/[^a-z]/gu, "")
    .toUpperCase();

export const collapsedRecognitionMatches = (
  transcript: string,
  expected: string,
): boolean => {
  const collapsed = collapseRecognition(transcript);
  return collapsed.length > 0 && collapsed === expected.toUpperCase();
};

export function levenshteinDistance(left: string, right: string): number {
  const rows = left.length + 1;
  const columns = right.length + 1;
  const matrix = Array.from({ length: rows }, () =>
    Array<number>(columns).fill(0),
  );

  for (let row = 0; row < rows; row += 1) matrix[row]![0] = row;
  for (let column = 0; column < columns; column += 1)
    matrix[0]![column] = column;

  for (let row = 1; row < rows; row += 1) {
    for (let column = 1; column < columns; column += 1) {
      const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
      matrix[row]![column] = Math.min(
        matrix[row - 1]![column]! + 1,
        matrix[row]![column - 1]! + 1,
        matrix[row - 1]![column - 1]! + substitution,
      );
    }
  }
  return matrix[rows - 1]![columns - 1]!;
}

export type AttemptScore = {
  correct: boolean;
  accuracyScore: number;
  speedScore: number;
  totalScore: number;
};

export function scoreAttempt(
  expected: string,
  actual: string,
  elapsedMs: number,
): AttemptScore {
  const correct = expected === actual;
  if (!correct)
    return {
      correct: false,
      accuracyScore: 0,
      speedScore: 0,
      totalScore: 0,
    };
  const longest = Math.max(expected.length, actual.length, 1);
  const similarity = Math.max(
    0,
    1 - levenshteinDistance(expected, actual) / longest,
  );
  const accuracyScore = Math.round(similarity * 80);
  const secondsPerLetter = elapsedMs / 1_000 / Math.max(expected.length, 1);
  const speedRatio = Math.max(0, Math.min(1, (4 - secondsPerLetter) / 2.5));
  const speedScore = Math.round(speedRatio * 20);
  return {
    correct,
    accuracyScore,
    speedScore,
    totalScore: Math.min(100, accuracyScore + speedScore),
  };
}
