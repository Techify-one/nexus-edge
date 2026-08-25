export type ChildSummary = {
  id: string;
  name: string;
  token: string;
  version: number;
  createdAt: string | number;
  updatedAt: string | number;
  sessionsCount: number;
  completedPhases: number;
  bestScore: number | null;
  lastActivity: string | number | null;
};

export type Overview = {
  children: ChildSummary[];
  totals: {
    childrenCount: number;
    sessionsCount: number;
    attemptsCount: number;
    averageScore: number;
  };
};

export type SessionRecord = {
  id: string;
  phase: number;
  status: "active" | "completed" | "abandoned";
  startedAt: string | number;
  completedAt: string | number | null;
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
  isCorrect: boolean;
  accuracyScore: number;
  speedScore: number;
  totalScore: number;
  elapsedMs: number;
  createdAt: string | number;
};

export type ChildDetail = {
  child: {
    id: string;
    name: string;
    token: string;
    version: number;
    createdAt: string | number;
    updatedAt: string | number;
  };
  sessions: SessionRecord[];
  attempts: AttemptRecord[];
  totals: {
    attemptsCount: number;
    correctCount: number;
    averageAttemptScore: number;
    totalTimeMs: number;
  };
};

export type PhaseInfo = {
  id: number;
  title: string;
  wordCount: number;
  completed: boolean;
  unlocked: boolean;
  bestScore: number | null;
  timesCompleted: number;
};

export type PracticeProfile = {
  child: { id: string; name: string; createdAt: string | number };
  phases: PhaseInfo[];
  unlockedPhase: number;
  recentSessions: Array<{
    id: string;
    phase: number;
    score: number;
    correctCount: number;
    completedAt: string | number;
  }>;
  totals: {
    attemptsCount: number;
    correctCount: number;
    averageScore: number;
  };
  activeSession: {
    id: string;
    phase: number;
    startedAt: string | number;
    answeredCount: number;
    nextPosition: number;
    words: string[];
    scores: number[];
    runningScore: number;
  } | null;
};

export type EvaluatedAttempt = {
  status: "evaluated";
  attempt: {
    correct: boolean;
    heard: string;
    accuracyScore: number;
    speedScore: number;
    totalScore: number;
    elapsedMs: number;
  };
};

export type RetryAttempt = {
  status: "retry";
  reason: string;
  heard?: string;
};

export type AttemptFeedback = EvaluatedAttempt | RetryAttempt;

export type PracticeSummary = {
  phase: number;
  score: number;
  correctCount: number;
  totalTimeMs: number;
  nextPhase: number;
};
