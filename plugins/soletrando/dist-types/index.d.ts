import { Hono } from "hono";
import type { SoletrandoEnv } from "./env.js";
declare const app: Hono<SoletrandoEnv, import("hono/types").BlankSchema, "/">;
export declare const soletrandoAdminRoutes: import("hono/hono-base").HonoBase<SoletrandoEnv, {
    "/overview": {
        $get: {
            output: {
                children: {
                    id: string;
                    name: string;
                    token: string;
                    createdAt: import("hono/utils/types").JSONValue;
                    updatedAt: import("hono/utils/types").JSONValue;
                    lastActivity: import("hono/utils/types").JSONValue;
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
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {};
        };
    };
} & {
    "/children": {
        $post: {
            output: {
                child: {
                    id: string;
                    name: string;
                    token: string;
                    version: number;
                    createdAt: string | number;
                    updatedAt: string | number;
                };
                linkPath: string;
            };
            outputFormat: "json";
            status: 201;
            input: {};
        } | {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {};
        };
    };
} & {
    "/children/:childId": {
        $get: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    childId: string;
                };
            };
        } | {
            output: {
                child: {
                    id: string;
                    name: string;
                    token: string;
                    createdAt: import("hono/utils/types").JSONValue;
                    updatedAt: import("hono/utils/types").JSONValue;
                    version: number;
                };
                sessions: {
                    id: string;
                    status: "active" | "completed" | "abandoned";
                    startedAt: import("hono/utils/types").JSONValue;
                    completedAt: import("hono/utils/types").JSONValue;
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
                    createdAt: import("hono/utils/types").JSONValue;
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
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    childId: string;
                };
            };
        };
    };
} & {
    "/children/:childId": {
        $patch: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    childId: string;
                };
            };
        } | {
            output: {
                [x: string]: import("hono/utils/types").JSONValue;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    childId: string;
                };
            };
        };
    };
} & {
    "/children/:childId/rotate-link": {
        $post: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    childId: string;
                };
            };
        } | {
            output: {
                token: string;
                linkPath: string;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    childId: string;
                };
            };
        };
    };
} & {
    "/children/:childId": {
        $delete: {
            output: null;
            outputFormat: "body";
            status: 204;
            input: {
                param: {
                    childId: string;
                };
            };
        } | {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    childId: string;
                };
            };
        };
    };
}, "/", "/children/:childId">;
export declare const soletrandoPublicRoutes: import("hono/hono-base").HonoBase<SoletrandoEnv, {
    "/play/:token": {
        $get: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                child: {
                    id: string;
                    name: string;
                    createdAt: import("hono/utils/types").JSONValue;
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
                    completedAt: import("hono/utils/types").JSONValue;
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
                activeSession: {
                    [x: string]: import("hono/utils/types").JSONValue;
                } | null;
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    token: string;
                };
            };
        };
    };
} & {
    "/play/:token/sessions": {
        $post: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                session: {
                    answeredCount: number;
                    nextPosition: number;
                    scores: number[];
                    runningScore: number;
                    id: string;
                    phase: number;
                    startedAt: import("hono/utils/types").JSONValue;
                    resumed: true;
                };
                phase: {
                    id: number;
                    title: string;
                    words: readonly string[];
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                session: {
                    id: string;
                    phase: number;
                    startedAt: string | number;
                };
                phase: {
                    id: number;
                    title: string;
                    words: readonly string[];
                };
            };
            outputFormat: "json";
            status: 201;
            input: {
                param: {
                    token: string;
                };
            };
        };
    };
} & {
    "/play/:token/attempts": {
        $post: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                status: "retry";
                reason: string;
            };
            outputFormat: "json";
            status: 422;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                status: "retry";
                reason: string;
            };
            outputFormat: "json";
            status: 503;
            input: {
                param: {
                    token: string;
                };
            };
        } | {
            output: {
                status: "evaluated";
                attempt: {
                    correct: boolean;
                    accuracyScore: number;
                    speedScore: number;
                    totalScore: number;
                    id: string;
                    position: number;
                    heard: string;
                    elapsedMs: number;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    token: string;
                };
            };
        };
    };
} & {
    "/play/:token/sessions/:sessionId/finish": {
        $post: {
            output: {
                error: {
                    code: string;
                    message: string;
                };
            };
            outputFormat: "json";
            status: 400 | 401 | 403 | 404 | 409 | 413 | 422 | 500 | 503;
            input: {
                param: {
                    token: string;
                } & {
                    sessionId: string;
                };
            };
        } | {
            output: {
                summary: {
                    phase: number;
                    score: number;
                    correctCount: number;
                    totalTimeMs: number;
                    nextPhase: number;
                };
            };
            outputFormat: "json";
            status: import("hono/utils/http-status").ContentfulStatusCode;
            input: {
                param: {
                    token: string;
                } & {
                    sessionId: string;
                };
            };
        };
    };
}, "/", "/play/:token/sessions/:sessionId/finish">;
export type SoletrandoAdminAppType = typeof soletrandoAdminRoutes;
export default app;
