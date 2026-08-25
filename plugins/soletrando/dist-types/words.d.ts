export type Phase = {
    id: number;
    title: string;
    words: readonly string[];
};
export declare const PHASES: readonly Phase[];
export declare const TOTAL_PHASES: number;
export declare const getPhase: (phaseNumber: number) => Phase | null;
export declare const getWord: (phaseNumber: number, position: number) => string | null;
