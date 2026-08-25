export type AttemptProgressRow = {
    position?: unknown;
    totalScore?: unknown;
};
export declare function summarizeSessionProgress(rows: AttemptProgressRow[]): {
    answeredCount: number;
    nextPosition: number;
    scores: number[];
    runningScore: number;
};
