import type { DatabasePort } from "@app/database";
import { createId } from "@app/core-contract";
import { PHASES, TOTAL_PHASES } from "./words.js";
import { summarizeSessionProgress } from "./session-progress.js";

const dbTime = (db: DatabasePort, value = Date.now()): number | Date =>
  db.provider === "d1" ? value : new Date(value);

const randomToken = (): string => {
  const bytes = crypto.getRandomValues(new Uint8Array(32));
  return btoa(String.fromCharCode(...bytes))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/gu, "");
};

const auditStatement = (
  db: DatabasePort,
  requestId: string,
  userId: string,
  action: string,
  resourceId: string,
) => ({
  sql: `INSERT INTO audit_log(id,request_id,user_id,auth_method,action,resource_type,resource_id,metadata_json,created_at)
        VALUES (?,?,?,'internal',?,'soletrando.child',?,'{}',?)`,
  params: [createId("aud"), requestId, userId, action, resourceId, dbTime(db)],
});

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

export class SoletrandoRepository {
  constructor(private readonly db: DatabasePort) {}

  async overview(search?: string) {
    const term = search?.trim() ? `%${search.trim()}%` : null;
    const [children, totals] = await Promise.all([
      this.db.query<ChildSummary>(
        `SELECT c.id, c.name, c.token, c.version,
                c.created_at AS "createdAt", c.updated_at AS "updatedAt",
                (SELECT COUNT(*) FROM soletrando_sessions s WHERE s.child_id = c.id) AS "sessionsCount",
                (SELECT COUNT(DISTINCT s.phase) FROM soletrando_sessions s WHERE s.child_id = c.id AND s.status = 'completed') AS "completedPhases",
                (SELECT MAX(s.score) FROM soletrando_sessions s WHERE s.child_id = c.id AND s.status = 'completed') AS "bestScore",
                (SELECT MAX(COALESCE(s.completed_at, s.started_at)) FROM soletrando_sessions s WHERE s.child_id = c.id) AS "lastActivity"
           FROM soletrando_children c
          WHERE (? IS NULL OR lower(c.name) LIKE lower(?))
          ORDER BY c.created_at DESC`,
        [term, term],
      ),
      this.db.first<{
        childrenCount: number;
        sessionsCount: number;
        attemptsCount: number;
        averageScore: number | null;
      }>(`SELECT
          (SELECT COUNT(*) FROM soletrando_children) AS "childrenCount",
          (SELECT COUNT(*) FROM soletrando_sessions WHERE status = 'completed') AS "sessionsCount",
          (SELECT COUNT(*) FROM soletrando_attempts) AS "attemptsCount",
          (SELECT ROUND(AVG(score)) FROM soletrando_sessions WHERE status = 'completed') AS "averageScore"`),
    ]);
    return {
      children: children.map((child) => ({
        ...child,
        version: Number(child.version),
        sessionsCount: Number(child.sessionsCount),
        completedPhases: Number(child.completedPhases),
        bestScore: child.bestScore == null ? null : Number(child.bestScore),
      })),
      totals: {
        childrenCount: Number(totals?.childrenCount ?? 0),
        sessionsCount: Number(totals?.sessionsCount ?? 0),
        attemptsCount: Number(totals?.attemptsCount ?? 0),
        averageScore: Number(totals?.averageScore ?? 0),
      },
    };
  }

  async createChild(name: string, userId: string, requestId: string) {
    const existing = await this.db.first<{ id: string }>(
      "SELECT id FROM soletrando_children WHERE lower(name) = lower(?) LIMIT 1",
      [name],
    );
    if (existing) return null;
    const id = createId("child");
    const token = randomToken();
    const now = dbTime(this.db);
    await this.db.atomic([
      {
        sql: `INSERT INTO soletrando_children(id,name,token,version,created_at,updated_at)
              VALUES (?,?,?,1,?,?)`,
        params: [id, name, token, now, now],
      },
      auditStatement(
        this.db,
        requestId,
        userId,
        "soletrando.child.created",
        id,
      ),
    ]);
    return { id, name, token, version: 1, createdAt: now, updatedAt: now };
  }

  async childDetail(id: string) {
    const child = await this.db.first<{
      id: string;
      name: string;
      token: string;
      version: number;
      createdAt: unknown;
      updatedAt: unknown;
    }>(
      `SELECT id,name,token,version,created_at AS "createdAt",updated_at AS "updatedAt"
         FROM soletrando_children WHERE id = ?`,
      [id],
    );
    if (!child) return null;
    const [sessions, attempts, totals] = await Promise.all([
      this.db.query<SessionRecord>(
        `SELECT id,phase,status,started_at AS "startedAt",completed_at AS "completedAt",
                score,correct_count AS "correctCount",total_time_ms AS "totalTimeMs"
           FROM soletrando_sessions WHERE child_id = ?
          ORDER BY started_at DESC LIMIT 100`,
        [id],
      ),
      this.db.query<AttemptRecord>(
        `SELECT id,session_id AS "sessionId",phase,position,word,transcript,normalized,
                is_correct AS "isCorrect",accuracy_score AS "accuracyScore",
                speed_score AS "speedScore",total_score AS "totalScore",
                elapsed_ms AS "elapsedMs",created_at AS "createdAt"
           FROM soletrando_attempts WHERE child_id = ?
          ORDER BY created_at DESC LIMIT 250`,
        [id],
      ),
      this.db.first<{
        attemptsCount: number;
        correctCount: number;
        averageAttemptScore: number;
        totalTimeMs: number;
      }>(
        `SELECT COUNT(*) AS "attemptsCount",
                SUM(CASE WHEN is_correct = ${this.db.provider === "d1" ? "1" : "TRUE"} THEN 1 ELSE 0 END) AS "correctCount",
                ROUND(AVG(total_score)) AS "averageAttemptScore",
                SUM(elapsed_ms) AS "totalTimeMs"
           FROM soletrando_attempts WHERE child_id = ?`,
        [id],
      ),
    ]);
    return {
      child: { ...child, version: Number(child.version) },
      sessions: sessions.map((session) => ({
        ...session,
        phase: Number(session.phase),
        score: session.score == null ? null : Number(session.score),
        correctCount: Number(session.correctCount),
        totalTimeMs: Number(session.totalTimeMs),
      })),
      attempts: attempts.map((attempt) => ({
        ...attempt,
        phase: Number(attempt.phase),
        position: Number(attempt.position),
        isCorrect: Boolean(attempt.isCorrect),
        accuracyScore: Number(attempt.accuracyScore),
        speedScore: Number(attempt.speedScore),
        totalScore: Number(attempt.totalScore),
        elapsedMs: Number(attempt.elapsedMs),
      })),
      totals: {
        attemptsCount: Number(totals?.attemptsCount ?? 0),
        correctCount: Number(totals?.correctCount ?? 0),
        averageAttemptScore: Number(totals?.averageAttemptScore ?? 0),
        totalTimeMs: Number(totals?.totalTimeMs ?? 0),
      },
    };
  }

  async updateChild(
    id: string,
    name: string,
    version: number,
    userId: string,
    requestId: string,
  ) {
    const now = dbTime(this.db);
    const result = await this.db.atomic([
      {
        sql: `UPDATE soletrando_children SET name=?,version=version+1,updated_at=?
              WHERE id=? AND version=?`,
        params: [name, now, id, version],
      },
      auditStatement(
        this.db,
        requestId,
        userId,
        "soletrando.child.updated",
        id,
      ),
    ]);
    if (!result[0]?.rowsAffected) return null;
    return this.db.first(
      `SELECT id,name,token,version,created_at AS "createdAt",updated_at AS "updatedAt"
         FROM soletrando_children WHERE id = ?`,
      [id],
    );
  }

  async rotateToken(
    id: string,
    userId: string,
    requestId: string,
  ): Promise<string | null> {
    const token = randomToken();
    const result = await this.db.atomic([
      {
        sql: "UPDATE soletrando_children SET token=?,version=version+1,updated_at=? WHERE id=?",
        params: [token, dbTime(this.db), id],
      },
      auditStatement(
        this.db,
        requestId,
        userId,
        "soletrando.child.link_rotated",
        id,
      ),
    ]);
    return result[0]?.rowsAffected ? token : null;
  }

  async deleteChild(
    id: string,
    userId: string,
    requestId: string,
  ): Promise<boolean> {
    const result = await this.db.atomic([
      { sql: "DELETE FROM soletrando_children WHERE id = ?", params: [id] },
      auditStatement(
        this.db,
        requestId,
        userId,
        "soletrando.child.deleted",
        id,
      ),
    ]);
    return Boolean(result[0]?.rowsAffected);
  }

  async publicProfile(token: string) {
    const child = await this.db.first<{
      id: string;
      name: string;
      createdAt: unknown;
    }>(
      `SELECT id,name,created_at AS "createdAt" FROM soletrando_children WHERE token = ?`,
      [token],
    );
    if (!child) return null;
    const [phaseResults, recentSessions, totals, activeSessions] =
      await Promise.all([
        this.db.query<{
          phase: number;
          bestScore: number;
          completedAt: unknown;
          timesCompleted: number;
        }>(
          `SELECT phase,MAX(score) AS "bestScore",MAX(completed_at) AS "completedAt",COUNT(*) AS "timesCompleted"
             FROM soletrando_sessions WHERE child_id=? AND status='completed'
            GROUP BY phase ORDER BY phase`,
          [child.id],
        ),
        this.db.query<{
          id: string;
          phase: number;
          score: number;
          correctCount: number;
          totalTimeMs: number;
          completedAt: unknown;
        }>(
          `SELECT id,phase,score,correct_count AS "correctCount",total_time_ms AS "totalTimeMs",completed_at AS "completedAt"
             FROM soletrando_sessions WHERE child_id=? AND status='completed'
            ORDER BY completed_at DESC LIMIT 8`,
          [child.id],
        ),
        this.db.first<{
          attemptsCount: number;
          correctCount: number;
          averageScore: number;
        }>(
          `SELECT COUNT(*) AS "attemptsCount",
                  SUM(CASE WHEN is_correct = ${this.db.provider === "d1" ? "1" : "TRUE"} THEN 1 ELSE 0 END) AS "correctCount",
                  ROUND(AVG(total_score)) AS "averageScore"
             FROM soletrando_attempts WHERE child_id=?`,
          [child.id],
        ),
        this.db.query<{ id: string; phase: number; startedAt: unknown }>(
          `SELECT id,phase,started_at AS "startedAt" FROM soletrando_sessions
            WHERE child_id=? AND status='active' ORDER BY started_at DESC LIMIT 1`,
          [child.id],
        ),
      ]);

    const activeRow = activeSessions[0];
    let activeSession: Record<string, unknown> | null = null;
    if (activeRow) {
      const attempts = await this.db.query<{
        position: number;
        totalScore: number;
      }>(
        `SELECT position,total_score AS "totalScore" FROM soletrando_attempts
          WHERE session_id=? ORDER BY position`,
        [activeRow.id],
      );
      const progress = summarizeSessionProgress(attempts);
      const phase = PHASES.find((item) => item.id === Number(activeRow.phase));
      if (phase)
        activeSession = {
          id: activeRow.id,
          phase: phase.id,
          startedAt: activeRow.startedAt,
          ...progress,
          words: phase.words,
        };
    }

    const completed = new Set(phaseResults.map((row) => Number(row.phase)));
    let unlockedPhase = 1;
    while (completed.has(unlockedPhase) && unlockedPhase < TOTAL_PHASES)
      unlockedPhase += 1;
    if (completed.size === TOTAL_PHASES) unlockedPhase = TOTAL_PHASES;

    return {
      child,
      phases: PHASES.map((phase) => {
        const result = phaseResults.find(
          (row) => Number(row.phase) === phase.id,
        );
        return {
          id: phase.id,
          title: phase.title,
          wordCount: phase.words.length,
          completed: completed.has(phase.id),
          unlocked: phase.id <= unlockedPhase,
          bestScore: result ? Number(result.bestScore ?? 0) : null,
          timesCompleted: result ? Number(result.timesCompleted ?? 0) : 0,
        };
      }),
      unlockedPhase,
      recentSessions: recentSessions.map((session) => ({
        ...session,
        phase: Number(session.phase),
        score: Number(session.score),
        correctCount: Number(session.correctCount),
        totalTimeMs: Number(session.totalTimeMs),
      })),
      totals: {
        attemptsCount: Number(totals?.attemptsCount ?? 0),
        correctCount: Number(totals?.correctCount ?? 0),
        averageScore: Number(totals?.averageScore ?? 0),
      },
      activeSession,
    };
  }

  async childByToken(token: string) {
    return this.db.first<{ id: string; name: string }>(
      "SELECT id,name FROM soletrando_children WHERE token=?",
      [token],
    );
  }

  completedPhases(childId: string): Promise<Array<{ phase: number }>> {
    return this.db.query(
      `SELECT DISTINCT phase FROM soletrando_sessions
        WHERE child_id=? AND status='completed'`,
      [childId],
    );
  }

  activeSession(childId: string) {
    return this.db.first<{ id: string; phase: number; startedAt: unknown }>(
      `SELECT id,phase,started_at AS "startedAt" FROM soletrando_sessions
        WHERE child_id=? AND status='active' ORDER BY started_at DESC LIMIT 1`,
      [childId],
    );
  }

  sessionProgress(sessionId: string) {
    return this.db.query<{ position: number; totalScore: number }>(
      `SELECT position,total_score AS "totalScore" FROM soletrando_attempts
        WHERE session_id=? ORDER BY position`,
      [sessionId],
    );
  }

  async createSession(childId: string, phase: number) {
    const id = createId("session");
    const startedAt = dbTime(this.db);
    await this.db.atomic([
      {
        sql: "UPDATE soletrando_sessions SET status='abandoned' WHERE child_id=? AND status='active'",
        params: [childId],
      },
      {
        sql: `INSERT INTO soletrando_sessions(id,child_id,phase,status,started_at)
              VALUES (?,?,?,'active',?)`,
        params: [id, childId, phase, startedAt],
      },
    ]);
    return { id, phase, startedAt };
  }

  sessionForToken(sessionId: string, token: string) {
    return this.db.first<{
      id: string;
      childId: string;
      phase: number;
      status: string;
      score: number | null;
      correctCount: number;
      totalTimeMs: number;
    }>(
      `SELECT s.id,s.child_id AS "childId",s.phase,s.status,s.score,
              s.correct_count AS "correctCount",s.total_time_ms AS "totalTimeMs"
         FROM soletrando_sessions s JOIN soletrando_children c ON c.id=s.child_id
        WHERE s.id=? AND c.token=?`,
      [sessionId, token],
    );
  }

  attemptExists(sessionId: string, position: number) {
    return this.db.first<{ id: string }>(
      "SELECT id FROM soletrando_attempts WHERE session_id=? AND position=?",
      [sessionId, position],
    );
  }

  async saveAttempt(input: {
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
  }) {
    const id = createId("attempt");
    await this.db.execute(
      `INSERT INTO soletrando_attempts(
        id,session_id,child_id,phase,position,word,transcript,normalized,
        is_correct,accuracy_score,speed_score,total_score,elapsed_ms,created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        id,
        input.sessionId,
        input.childId,
        input.phase,
        input.position,
        input.word,
        input.transcript,
        input.normalized,
        this.db.provider === "d1" ? (input.isCorrect ? 1 : 0) : input.isCorrect,
        input.accuracyScore,
        input.speedScore,
        input.totalScore,
        input.elapsedMs,
        dbTime(this.db),
      ],
    );
    return id;
  }

  sessionAggregate(sessionId: string) {
    return this.db.first<{
      attemptCount: number;
      score: number;
      correctCount: number;
      totalTimeMs: number;
    }>(
      `SELECT COUNT(*) AS "attemptCount",ROUND(AVG(total_score)) AS score,
              SUM(CASE WHEN is_correct = ${this.db.provider === "d1" ? "1" : "TRUE"} THEN 1 ELSE 0 END) AS "correctCount",
              SUM(elapsed_ms) AS "totalTimeMs"
         FROM soletrando_attempts WHERE session_id=?`,
      [sessionId],
    );
  }

  async finishSession(
    sessionId: string,
    score: number,
    correctCount: number,
    totalTimeMs: number,
  ) {
    const completedAt = dbTime(this.db);
    await this.db.execute(
      `UPDATE soletrando_sessions SET status='completed',completed_at=?,score=?,correct_count=?,total_time_ms=?
        WHERE id=? AND status='active'`,
      [completedAt, score, correctCount, totalTimeMs, sessionId],
    );
    return completedAt;
  }
}
