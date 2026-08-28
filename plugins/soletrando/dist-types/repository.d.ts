import type { DatabasePort } from "@app/database";
import { type TranscriptionModel } from "./transcription-models.js";
export type ChildSummary = {
    id: string;
    name: string;
    token: string;
    version: number;
    createdAt: unknown;
    updatedAt: unknown;
    sessionsCount: number;
    completedPhases: number;
    bestScore: number | null;
    lastActivity: unknown | null;
};
export type SessionRecord = {
    id: string;
    phase: number;
    status: "active" | "completed" | "abandoned";
    startedAt: unknown;
    completedAt: unknown | null;
    score: number | null;
    correctCount: number;
    totalTimeMs: number;
};
export type AttemptRecord = {
    id: string;
    sessionId: string;
    phase: number;
    position: number;
    word: string;
    transcript: string;
    normalized: string;
    isCorrect: boolean | number;
    accuracyScore: number;
    speedScore: number;
    totalScore: number;
    elapsedMs: number;
    createdAt: unknown;
};
export declare class SoletrandoRepository {
    private readonly db;
    constructor(db: DatabasePort);
    transcriptionSettings(): Promise<{
        transcriptionModel: "@cf/deepgram/nova-3" | "@cf/openai/whisper-large-v3-turbo";
        updatedAt: {} | null;
    }>;
    updateTranscriptionSettings(transcriptionModel: TranscriptionModel, userId: string, requestId: string): Promise<{
        transcriptionModel: "@cf/deepgram/nova-3" | "@cf/openai/whisper-large-v3-turbo";
        updatedAt: number | Date;
    }>;
    overview(search?: string): Promise<{
        children: {
            id: string;
            name: string;
            token: string;
            createdAt: unknown;
            updatedAt: unknown;
            lastActivity: unknown | null;
            version: number;
            sessionsCount: number;
            completedPhases: number;
            bestScore: number | null;
        }[];
        totals: {
            childrenCount: number;
            sessionsCount: number;
            attemptsCount: number;
            averageScore: number;
        };
    }>;
    createChild(name: string, userId: string, requestId: string): Promise<{
        id: string;
        name: string;
        token: string;
        version: number;
        createdAt: number | Date;
        updatedAt: number | Date;
    } | null>;
    childDetail(id: string): Promise<{
        child: {
            id: string;
            name: string;
            token: string;
            createdAt: unknown;
            updatedAt: unknown;
            version: number;
        };
        sessions: {
            id: string;
            status: "active" | "completed" | "abandoned";
            startedAt: unknown;
            completedAt: unknown | null;
            phase: number;
            score: number | null;
            correctCount: number;
            totalTimeMs: number;
        }[];
        attempts: {
            id: string;
            sessionId: string;
            word: string;
            transcript: string;
            normalized: string;
            createdAt: unknown;
            phase: number;
            position: number;
            isCorrect: boolean;
            accuracyScore: number;
            speedScore: number;
            totalScore: number;
            elapsedMs: number;
        }[];
        totals: {
            attemptsCount: number;
            correctCount: number;
            averageAttemptScore: number;
            totalTimeMs: number;
        };
    } | null>;
    updateChild(id: string, name: string, version: number, userId: string, requestId: string): Promise<Record<string, unknown> | null>;
    rotateToken(id: string, userId: string, requestId: string): Promise<string | null>;
    deleteChild(id: string, userId: string, requestId: string): Promise<boolean>;
    publicProfile(token: string): Promise<{
        child: {
            id: string;
            name: string;
            createdAt: unknown;
        };
        phases: {
            id: number;
            title: string;
            wordCount: number;
            completed: boolean;
            unlocked: boolean;
            bestScore: number | null;
            timesCompleted: number;
        }[];
        unlockedPhase: number;
        recentSessions: {
            id: string;
            completedAt: unknown;
            phase: number;
            score: number;
            correctCount: number;
            totalTimeMs: number;
        }[];
        totals: {
            attemptsCount: number;
            correctCount: number;
            averageScore: number;
        };
        activeSession: Record<string, unknown> | null;
    } | null>;
    childByToken(token: string): Promise<{
        id: string;
        name: string;
    } | null>;
    completedPhases(childId: string): Promise<Array<{
        phase: number;
    }>>;
    activeSession(childId: string): Promise<{
        id: string;
        phase: number;
        startedAt: unknown;
    } | null>;
    sessionProgress(sessionId: string): Promise<{
        position: number;
        totalScore: number;
    }[]>;
    createSession(childId: string, phase: number): Promise<{
        id: string;
        phase: number;
        startedAt: number | Date;
    }>;
    sessionForToken(sessionId: string, token: string): Promise<{
        id: string;
        childId: string;
        phase: number;
        status: string;
        score: number | null;
        correctCount: number;
        totalTimeMs: number;
    } | null>;
    attemptExists(sessionId: string, position: number): Promise<{
        id: string;
    } | null>;
    saveAttempt(input: {
        sessionId: string;
        childId: string;
        phase: number;
        position: number;
        word: string;
        transcript: string;
        normalized: string;
        isCorrect: boolean;
        accuracyScore: number;
        speedScore: number;
        totalScore: number;
        elapsedMs: number;
    }): Promise<string>;
    sessionAggregate(sessionId: string): Promise<{
        attemptCount: number;
        score: number;
        correctCount: number;
        totalTimeMs: number;
    } | null>;
    finishSession(sessionId: string, score: number, correctCount: number, totalTimeMs: number): Promise<number | Date>;
}
