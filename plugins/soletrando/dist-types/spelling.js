const LETTER_NAMES = {
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
    ia: "A",
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
    er: "R",
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
const fold = (value) => value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/gu, "")
    .toLowerCase();
export function parseSpelling(transcript) {
    const source = transcript.trim();
    if (!source)
        return { letters: "", ambiguous: true, unknownTokens: [] };
    const clearlySeparated = /[-,.;:/]|\b[A-Z]\s+[A-Z]\b/u.test(source);
    const cleaned = fold(source)
        .replace(/\b(as|a)\s+letras?\s+(sao|foram|e)\b/gu, " ")
        .replace(/\b(transcricao|resultado)\b/gu, " ")
        .replace(/[^a-z\s-]/gu, " ")
        .replace(/-/gu, " ")
        .replace(/\s+/gu, " ")
        .trim();
    if (!cleaned)
        return { letters: "", ambiguous: true, unknownTokens: [] };
    const tokens = cleaned.split(" ").filter(Boolean);
    if (tokens.length === 1 && tokens[0].length > 1 && !LETTER_NAMES[tokens[0]])
        return {
            letters: "",
            ambiguous: !clearlySeparated,
            unknownTokens: tokens,
        };
    const letters = [];
    const unknownTokens = [];
    for (const token of tokens) {
        if (IGNORED_WORDS.has(token))
            continue;
        const letter = LETTER_NAMES[token];
        if (letter)
            letters.push(letter);
        else
            unknownTokens.push(token);
    }
    return {
        letters: letters.join(""),
        ambiguous: letters.length === 0 || unknownTokens.length > 0,
        unknownTokens,
    };
}
export const collapseRecognition = (transcript) => fold(transcript)
    .replace(/[^a-z]/gu, "")
    .toUpperCase();
export const collapsedRecognitionMatches = (transcript, expected) => {
    const collapsed = collapseRecognition(transcript);
    return collapsed.length > 0 && collapsed === expected.toUpperCase();
};
const LETTER_RECOGNITION_ARTIFACTS = {
    A: ["IA"],
    R: ["ER"],
};
export function normalizeRecognitionForExpected(recognized, expected) {
    const actual = collapseRecognition(recognized);
    const target = collapseRecognition(expected);
    if (!actual || !target || actual === target)
        return actual;
    const memo = new Map();
    const matches = (targetIndex, actualIndex) => {
        if (targetIndex === target.length)
            return actualIndex === actual.length;
        const key = `${targetIndex}:${actualIndex}`;
        const cached = memo.get(key);
        if (cached !== undefined)
            return cached;
        const letter = target[targetIndex];
        const variants = [letter, ...(LETTER_RECOGNITION_ARTIFACTS[letter] ?? [])];
        const result = variants.some((variant) => actual.startsWith(variant, actualIndex) &&
            matches(targetIndex + 1, actualIndex + variant.length));
        memo.set(key, result);
        return result;
    };
    return matches(0, 0) ? target : actual;
}
export function recognizeSpelling(transcript, expected) {
    const parsed = parseSpelling(transcript);
    if (!parsed.ambiguous)
        return normalizeRecognitionForExpected(parsed.letters, expected);
    const collapsed = collapseRecognition(transcript);
    if (!collapsed)
        return "";
    const normalized = normalizeRecognitionForExpected(collapsed, expected);
    return normalized === collapseRecognition(expected) ? normalized : "";
}
export function levenshteinDistance(left, right) {
    const rows = left.length + 1;
    const columns = right.length + 1;
    const matrix = Array.from({ length: rows }, () => Array(columns).fill(0));
    for (let row = 0; row < rows; row += 1)
        matrix[row][0] = row;
    for (let column = 0; column < columns; column += 1)
        matrix[0][column] = column;
    for (let row = 1; row < rows; row += 1) {
        for (let column = 1; column < columns; column += 1) {
            const substitution = left[row - 1] === right[column - 1] ? 0 : 1;
            matrix[row][column] = Math.min(matrix[row - 1][column] + 1, matrix[row][column - 1] + 1, matrix[row - 1][column - 1] + substitution);
        }
    }
    return matrix[rows - 1][columns - 1];
}
export function scoreAttempt(expected, actual, elapsedMs) {
    const correct = expected === actual;
    if (!correct)
        return {
            correct: false,
            accuracyScore: 0,
            speedScore: 0,
            totalScore: 0,
        };
    const longest = Math.max(expected.length, actual.length, 1);
    const similarity = Math.max(0, 1 - levenshteinDistance(expected, actual) / longest);
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
