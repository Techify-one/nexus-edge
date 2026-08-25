export type AttemptProgressRow = {
    position?: unknown;
    totalScore?: unknown;
};
export declare const isPerfectPhase: (attemptCount: number, correctCount: number) => boolean;
export declare function summarizeSessionProgress(rows: AttemptProgressRow[]): {
    answeredCount: number;
    nextPosition: number;
    scores: number[];
    runningScore: number;
};
