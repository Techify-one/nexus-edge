export type ParsedSpelling = {
    letters: string;
    ambiguous: boolean;
    unknownTokens: string[];
};
export declare function parseSpelling(transcript: string): ParsedSpelling;
export declare const collapseRecognition: (transcript: string) => string;
export declare const collapsedRecognitionMatches: (transcript: string, expected: string) => boolean;
export declare function levenshteinDistance(left: string, right: string): number;
export type AttemptScore = {
    correct: boolean;
    accuracyScore: number;
    speedScore: number;
    totalScore: number;
};
export declare function scoreAttempt(expected: string, actual: string, elapsedMs: number): AttemptScore;
