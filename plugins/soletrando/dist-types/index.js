import { Hono } from "hono";
import { createDatabase } from "@app/database";
import { z } from "zod";
import { SoletrandoRepository } from "./repository.js";
import { isPerfectPhase, summarizeSessionProgress, } from "./session-progress.js";
import { collapseRecognition, collapsedRecognitionMatches, normalizeRecognitionForExpected, parseSpelling, scoreAttempt, } from "./spelling.js";
import { transcribeSpelling, TranscriptionUnavailableError, } from "./transcription.js";
import { getPhase, getWord, TOTAL_PHASES } from "./words.js";
import { SOLETRANDO_ICON_SVG, SOLETRANDO_SERVICE_WORKER, soletrandoManifest, } from "./pwa.js";
const app = new Hono();
const childInput = z.object({ name: z.string().trim().min(2).max(50) });
const childUpdateInput = childInput.extend({
    version: z.number().int().positive(),
});
const phaseInput = z.object({ phase: z.number().int().min(1).max(4) });
const tokenPattern = /^[A-Za-z0-9_-]{32,128}$/u;
const transcriptionFailureCode = (cause) => {
    const detail = cause instanceof Error
        ? `${cause.name} ${cause.message}`.toLowerCase()
        : String(cause).toLowerCase();
    if (/\b3036\b|daily free allocation|account limited|quota/iu.test(detail))
        return "AI_DAILY_LIMIT";
    if (/\b3040\b|out of capacity/iu.test(detail))
        return "AI_CAPACITY";
    if (/\b3007\b|\b3008\b|abort|timeout/iu.test(detail))
        return "AI_TIMEOUT";
    if (cause instanceof TranscriptionUnavailableError)
        return "AI_EMPTY_TRANSCRIPT";
    return "AI_TRANSCRIPTION_ERROR";
};
const error = (c, status, code, message) => c.json({ error: { code, message } }, status);
const decodeContext = (encoded) => {
    const normalized = encoded.replaceAll("-", "+").replaceAll("_", "/");
    const binary = atob(normalized.padEnd(Math.ceil(normalized.length / 4) * 4, "="));
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return JSON.parse(new TextDecoder().decode(bytes));
};
const isPluginContext = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const context = value;
    return Boolean(context.userId &&
        context.requestId &&
        Array.isArray(context.permissions) &&
        context.permissions.every((permission) => typeof permission === "string"));
};
const isPublicContext = (value) => {
    if (!value || typeof value !== "object")
        return false;
    const context = value;
    return Boolean(context.requestId && context.pluginId === "soletrando");
};
app.get("/health", (c) => c.json({ ok: true, plugin: "soletrando", version: "1.1.5" }));
app.use("/*", async (c, next) => {
    if (c.req.path === "/health")
        return next();
    const internal = c.req.header("X-Plugin-Context");
    const publicInternal = c.req.header("X-Plugin-Public-Context");
    if (Boolean(internal) === Boolean(publicInternal))
        return error(c, 401, "MISSING_PLUGIN_CONTEXT", "An exclusive internal context is required.");
    try {
        if (internal) {
            const context = decodeContext(internal);
            if (!isPluginContext(context))
                throw new Error("invalid");
            c.set("pluginContext", context);
        }
        else {
            const context = decodeContext(publicInternal);
            if (!isPublicContext(context))
                throw new Error("invalid");
            c.set("publicContext", context);
        }
    }
    catch {
        return error(c, 401, "INVALID_PLUGIN_CONTEXT", "The internal context is invalid.");
    }
    const db = await createDatabase(c.env);
    c.set("db", db);
    try {
        await next();
    }
    finally {
        await db.close();
    }
});
const repository = (c) => new SoletrandoRepository(c.get("db"));
const requireAdminContext = (c) => {
    const context = c.get("pluginContext");
    if (!context)
        throw new Error("FORBIDDEN:admin-context");
    return context;
};
const requirePublicContext = (c) => {
    if (!c.get("publicContext"))
        throw new Error("FORBIDDEN:public-context");
};
const requirePermission = (c, permission) => {
    const context = requireAdminContext(c);
    if (!context.permissions.includes(permission))
        throw new Error(`FORBIDDEN:${permission}`);
    return context;
};
app.post("/__installer/smoke", async (c) => {
    const context = requireAdminContext(c);
    const db = c.get("db");
    const id = `child_smoke_${crypto.randomUUID().replaceAll("-", "")}`;
    const token = `smoke_${crypto.randomUUID().replaceAll("-", "")}`;
    const now = db.provider === "d1" ? Date.now() : new Date();
    await db.execute(`INSERT INTO soletrando_children(id,name,token,version,created_at,updated_at)
     VALUES (?,?,?,1,?,?)`, [id, "Installer smoke", token, now, now]);
    const created = await db.first("SELECT id FROM soletrando_children WHERE id=?", [id]);
    await db.execute("DELETE FROM soletrando_children WHERE id=?", [id]);
    const aiAvailable = typeof c.env.AI?.run === "function";
    return created?.id === id && aiAvailable && context.userId
        ? c.json({ ok: true, read: true, write: true, ai: true })
        : c.json({ ok: false }, 500);
});
export const soletrandoAdminRoutes = new Hono()
    .get("/overview", async (c) => {
    requirePermission(c, "soletrando.child.read");
    return c.json(await repository(c).overview(c.req.query("search")));
})
    .post("/children", async (c) => {
    const context = requirePermission(c, "soletrando.child.create");
    const input = childInput.parse(await c.req.json());
    const child = await repository(c).createChild(input.name, context.userId, context.requestId);
    return child
        ? c.json({ child, linkPath: `/soletrando/c/${child.token}` }, 201)
        : error(c, 409, "SOLETRANDO_CHILD_ALREADY_EXISTS", "A child with this name already exists.");
})
    .get("/children/:childId", async (c) => {
    requirePermission(c, "soletrando.child.read");
    const detail = await repository(c).childDetail(c.req.param("childId"));
    return detail
        ? c.json(detail)
        : error(c, 404, "SOLETRANDO_CHILD_NOT_FOUND", "Child not found.");
})
    .patch("/children/:childId", async (c) => {
    const context = requirePermission(c, "soletrando.child.update");
    const input = childUpdateInput.parse(await c.req.json());
    try {
        const child = await repository(c).updateChild(c.req.param("childId"), input.name, input.version, context.userId, context.requestId);
        return child
            ? c.json(child)
            : error(c, 409, "SOLETRANDO_VERSION_CONFLICT", "The child changed or no longer exists.");
    }
    catch (cause) {
        if (cause instanceof Error &&
            cause.message.toLowerCase().includes("unique"))
            return error(c, 409, "SOLETRANDO_CHILD_ALREADY_EXISTS", "A child with this name already exists.");
        throw cause;
    }
})
    .post("/children/:childId/rotate-link", async (c) => {
    const context = requirePermission(c, "soletrando.child.update");
    const token = await repository(c).rotateToken(c.req.param("childId"), context.userId, context.requestId);
    return token
        ? c.json({ token, linkPath: `/soletrando/c/${token}` })
        : error(c, 404, "SOLETRANDO_CHILD_NOT_FOUND", "Child not found.");
})
    .delete("/children/:childId", async (c) => {
    const context = requirePermission(c, "soletrando.child.delete");
    return (await repository(c).deleteChild(c.req.param("childId"), context.userId, context.requestId))
        ? c.body(null, 204)
        : error(c, 404, "SOLETRANDO_CHILD_NOT_FOUND", "Child not found.");
});
export const soletrandoPublicRoutes = new Hono()
    .get("/pwa/manifest.webmanifest", (c) => {
    requirePublicContext(c);
    c.header("Content-Type", "application/manifest+json; charset=utf-8");
    return c.body(JSON.stringify(soletrandoManifest(c.req.query("start") ?? null)));
})
    .get("/pwa/sw.js", (c) => {
    requirePublicContext(c);
    c.header("Content-Type", "application/javascript; charset=utf-8");
    c.header("Service-Worker-Allowed", "/soletrando/");
    return c.body(SOLETRANDO_SERVICE_WORKER);
})
    .get("/pwa/icon.svg", (c) => {
    requirePublicContext(c);
    c.header("Content-Type", "image/svg+xml; charset=utf-8");
    return c.body(SOLETRANDO_ICON_SVG);
})
    .get("/play/:token", async (c) => {
    requirePublicContext(c);
    const token = c.req.param("token");
    if (!tokenPattern.test(token))
        return error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
    const profile = await repository(c).publicProfile(token);
    c.header("Cache-Control", "private, no-store");
    return profile
        ? c.json(profile)
        : error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
})
    .post("/play/:token/sessions", async (c) => {
    requirePublicContext(c);
    const token = c.req.param("token");
    if (!tokenPattern.test(token))
        return error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
    const input = phaseInput.parse(await c.req.json());
    const phase = getPhase(input.phase);
    const child = await repository(c).childByToken(token);
    if (!child)
        return error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
    const completed = new Set((await repository(c).completedPhases(child.id)).map((row) => Number(row.phase)));
    let unlockedPhase = 1;
    while (completed.has(unlockedPhase) && unlockedPhase < TOTAL_PHASES)
        unlockedPhase += 1;
    if (completed.size === TOTAL_PHASES)
        unlockedPhase = TOTAL_PHASES;
    if (input.phase > unlockedPhase)
        return error(c, 403, "SOLETRANDO_PHASE_LOCKED", "Complete the previous phase first.");
    const active = await repository(c).activeSession(child.id);
    if (active && Number(active.phase) === input.phase) {
        const progress = summarizeSessionProgress(await repository(c).sessionProgress(active.id));
        return c.json({
            session: {
                id: active.id,
                phase: input.phase,
                startedAt: active.startedAt,
                resumed: true,
                ...progress,
            },
            phase: { id: phase.id, title: phase.title, words: phase.words },
        });
    }
    const session = await repository(c).createSession(child.id, input.phase);
    return c.json({
        session,
        phase: { id: phase.id, title: phase.title, words: phase.words },
    }, 201);
})
    .post("/play/:token/attempts", async (c) => {
    requirePublicContext(c);
    const token = c.req.param("token");
    if (!tokenPattern.test(token))
        return error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
    const contentLength = Number(c.req.header("Content-Length") ?? 0);
    if (contentLength > 4_500_000)
        return error(c, 413, "SOLETRANDO_AUDIO_TOO_LARGE", "The audio is too large.");
    const form = await c.req.formData();
    const sessionId = typeof form.get("sessionId") === "string"
        ? String(form.get("sessionId"))
        : "";
    const position = Number(form.get("position"));
    const elapsedMs = Number(form.get("elapsedMs"));
    const audio = form.get("audio");
    if (!sessionId ||
        !Number.isInteger(position) ||
        position < 0 ||
        position > 9)
        return error(c, 400, "SOLETRANDO_INVALID_ATTEMPT", "Invalid attempt.");
    if (!Number.isFinite(elapsedMs) || elapsedMs < 250 || elapsedMs > 120_000)
        return error(c, 400, "SOLETRANDO_INVALID_TIME", "Invalid attempt time.");
    if (!(audio instanceof File) || audio.size < 300 || audio.size > 4_000_000)
        return c.json({
            status: "retry",
            reason: "Não consegui receber a gravação. Tente novamente.",
        }, 422);
    const session = await repository(c).sessionForToken(sessionId, token);
    if (!session)
        return error(c, 404, "SOLETRANDO_SESSION_NOT_FOUND", "Session not found.");
    if (session.status !== "active")
        return error(c, 409, "SOLETRANDO_SESSION_CLOSED", "Session is closed.");
    const expected = getWord(Number(session.phase), position);
    if (!expected)
        return error(c, 400, "SOLETRANDO_WORD_NOT_FOUND", "Word not found.");
    if (await repository(c).attemptExists(sessionId, position))
        return error(c, 409, "SOLETRANDO_ATTEMPT_EXISTS", "This word was already answered.");
    let transcript;
    const transcriptionStartedAt = performance.now();
    try {
        transcript = await transcribeSpelling(audio, c.env);
    }
    catch (cause) {
        console.error(JSON.stringify({
            plugin: "soletrando",
            event: "transcription_failed",
            requestId: c.get("publicContext")?.requestId,
            code: transcriptionFailureCode(cause),
            durationMs: Math.round(performance.now() - transcriptionStartedAt),
            audioBytes: audio.size,
        }));
        const reason = cause instanceof TranscriptionUnavailableError
            ? cause.message
            : "O reconhecimento de voz falhou. Tente novamente.";
        return c.json({ status: "retry", reason }, 503);
    }
    console.log(JSON.stringify({
        plugin: "soletrando",
        event: "transcription_completed",
        requestId: c.get("publicContext")?.requestId,
        durationMs: Math.round(performance.now() - transcriptionStartedAt),
        audioBytes: audio.size,
        aiGatewayLogId: c.env.AI?.aiGatewayLogId ?? undefined,
    }));
    const parsed = parseSpelling(transcript);
    const collapsedMatch = collapsedRecognitionMatches(transcript, expected);
    const rawRecognizedLetters = parsed.letters ||
        (collapsedMatch ? expected : collapseRecognition(transcript));
    const recognizedLetters = normalizeRecognitionForExpected(rawRecognizedLetters, expected);
    if (!recognizedLetters)
        return c.json({
            status: "retry",
            reason: "Não consegui entender as letras com segurança. Fale uma letra de cada vez.",
            heard: transcript,
        }, 422);
    const score = scoreAttempt(expected, recognizedLetters, elapsedMs);
    const id = await repository(c).saveAttempt({
        sessionId,
        childId: session.childId,
        phase: Number(session.phase),
        position,
        word: expected,
        transcript,
        normalized: recognizedLetters,
        isCorrect: score.correct,
        accuracyScore: score.accuracyScore,
        speedScore: score.speedScore,
        totalScore: score.totalScore,
        elapsedMs: Math.round(elapsedMs),
    });
    return c.json({
        status: "evaluated",
        attempt: {
            id,
            position,
            correctWord: expected,
            heard: recognizedLetters,
            elapsedMs: Math.round(elapsedMs),
            ...score,
        },
    });
})
    .post("/play/:token/sessions/:sessionId/finish", async (c) => {
    requirePublicContext(c);
    const token = c.req.param("token");
    if (!tokenPattern.test(token))
        return error(c, 404, "SOLETRANDO_LINK_NOT_FOUND", "Training link not found.");
    const session = await repository(c).sessionForToken(c.req.param("sessionId"), token);
    if (!session)
        return error(c, 404, "SOLETRANDO_SESSION_NOT_FOUND", "Session not found.");
    if (session.status === "completed")
        return c.json({
            summary: {
                phase: Number(session.phase),
                score: Number(session.score ?? 0),
                correctCount: Number(session.correctCount ?? 0),
                totalTimeMs: Number(session.totalTimeMs ?? 0),
                passed: isPerfectPhase(10, Number(session.correctCount ?? 0)),
                nextPhase: isPerfectPhase(10, Number(session.correctCount ?? 0))
                    ? Math.min(TOTAL_PHASES, Number(session.phase) + 1)
                    : Number(session.phase),
            },
        });
    const aggregate = await repository(c).sessionAggregate(session.id);
    if (Number(aggregate?.attemptCount ?? 0) !== 10)
        return error(c, 409, "SOLETRANDO_SESSION_INCOMPLETE", "Answer all ten words first.");
    const score = Number(aggregate?.score ?? 0);
    const correctCount = Number(aggregate?.correctCount ?? 0);
    const totalTimeMs = Number(aggregate?.totalTimeMs ?? 0);
    const passed = isPerfectPhase(Number(aggregate?.attemptCount ?? 0), correctCount);
    const completedAt = await repository(c).finishSession(session.id, score, correctCount, totalTimeMs);
    return c.json({
        summary: {
            phase: Number(session.phase),
            score,
            correctCount,
            totalTimeMs,
            passed,
            completedAt,
            nextPhase: passed
                ? Math.min(TOTAL_PHASES, Number(session.phase) + 1)
                : Number(session.phase),
        },
    });
});
app.route("/", soletrandoAdminRoutes);
app.route("/public", soletrandoPublicRoutes);
app.onError((cause, c) => {
    if (cause.message.startsWith("FORBIDDEN:"))
        return error(c, 403, "FORBIDDEN", "Permission denied.");
    if (cause instanceof z.ZodError)
        return error(c, 400, "VALIDATION_ERROR", "Invalid request data.");
    console.error(JSON.stringify({
        plugin: "soletrando",
        requestId: c.get("pluginContext")?.requestId ?? c.get("publicContext")?.requestId,
        error: cause instanceof Error ? cause.message : "unknown",
    }));
    return error(c, 500, "INTERNAL_ERROR", "Unexpected plugin error.");
});
export default app;
