import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "../../../workers/core/src/installer/manifest.js";
import { SOLETRANDO_SERVICE_WORKER, soletrandoManifest } from "../src/pwa.js";
import {
  isPerfectPhase,
  summarizeSessionProgress,
} from "../src/session-progress.js";
import {
  collapseRecognition,
  collapsedRecognitionMatches,
  normalizeRecognitionForExpected,
  parseSpelling,
  scoreAttempt,
} from "../src/spelling.js";
import { PHASES } from "../src/words.js";

describe("Soletrando plugin", () => {
  it("ships an Installer-compatible AI manifest", () => {
    const manifest = pluginManifestSchema.parse(
      JSON.parse(readFileSync("plugins/soletrando/manifest.json", "utf8")),
    );
    expect(manifest.id).toBe("soletrando");
    expect(manifest.runtimeBindings).toEqual(["ai"]);
    expect(manifest.menu).toEqual([
      { title: "Soletrando", routeKey: "soletrando.children" },
    ]);
  });

  it("preserves the four exact ten-word phases", () => {
    expect(PHASES.map((phase) => phase.words)).toEqual([
      [
        "BOLA",
        "CASA",
        "DADO",
        "FOCA",
        "GATO",
        "HORA",
        "ILHA",
        "JACA",
        "KIWI",
        "LATA",
      ],
      [
        "MALA",
        "NAVE",
        "OVO",
        "PATO",
        "QUEIJO",
        "RATO",
        "SAPO",
        "TATU",
        "UVA",
        "VELA",
      ],
      [
        "BONECA",
        "CAVALO",
        "DEDO",
        "FADA",
        "GOLA",
        "MACA",
        "MESA",
        "PIPA",
        "ROLO",
        "SACO",
      ],
      [
        "TUCANO",
        "VACA",
        "ABACAXI",
        "BARCO",
        "PETECA",
        "TOMATE",
        "MACACO",
        "ABACATE",
        "GIRASSOL",
        "GIRAFA",
      ],
    ]);
  });

  it("normalizes Brazilian Portuguese letter names deterministically", () => {
    expect(parseSpelling("bê - ó - ele - a").letters).toBe("BOLA");
    expect(parseSpelling("C, A, S, A").letters).toBe("CASA");
    expect(parseSpelling("jota a cê a").letters).toBe("JACA");
    expect(parseSpelling("cá i dáblio i").letters).toBe("KIWI");
    expect(parseSpelling("gê i erre a esse esse ó ele").letters).toBe(
      "GIRASSOL",
    );
    expect(parseSpelling("agá ó er ia").letters).toBe("HORA");
    expect(parseSpelling("bola")).toMatchObject({
      letters: "",
      ambiguous: true,
    });
    expect(collapsedRecognitionMatches("b o l a", "BOLA")).toBe(true);
    expect(collapseRecognition("boa")).toBe("BOA");
    expect(collapsedRecognitionMatches("boa", "BOLA")).toBe(false);
  });

  it("corrects only known letter-name transcription artifacts", () => {
    expect(normalizeRecognitionForExpected("H O E R I A", "HORA")).toBe("HORA");
    expect(normalizeRecognitionForExpected("H O E R A", "HORA")).toBe("HORA");
    expect(normalizeRecognitionForExpected("H O E R I E", "HORA")).toBe(
      "HOERIE",
    );
    expect(normalizeRecognitionForExpected("H O R I A", "CASA")).toBe("HORIA");
  });

  it("scores accuracy and speed without using AI for the decision", () => {
    expect(scoreAttempt("BOLA", "BOLA", 4_000)).toEqual({
      correct: true,
      accuracyScore: 80,
      speedScore: 20,
      totalScore: 100,
    });
    expect(scoreAttempt("BOLA", "BOA", 4_000)).toEqual({
      correct: false,
      accuracyScore: 0,
      speedScore: 0,
      totalScore: 0,
    });
  });

  it("unlocks a phase only after ten consecutive correct answers", () => {
    expect(isPerfectPhase(10, 10)).toBe(true);
    expect(isPerfectPhase(10, 9)).toBe(false);
    expect(isPerfectPhase(9, 9)).toBe(false);
    const repository = readFileSync(
      "plugins/soletrando/src/repository.ts",
      "utf8",
    );
    expect(repository).toContain("status='completed' AND correct_count=10");
  });

  it("resumes at the first unanswered position", () => {
    expect(
      summarizeSessionProgress([
        { position: 0, totalScore: 100 },
        { position: 1, totalScore: 80 },
        { position: 3, totalScore: 40 },
      ]),
    ).toEqual({
      answeredCount: 3,
      nextPosition: 2,
      scores: [100, 80, 40],
      runningScore: 73,
    });
  });

  it("never persists audio and never renders the secret word in practice", () => {
    const migration = readFileSync(
      "plugins/soletrando/migrations/d1/0001_init.sql",
      "utf8",
    );
    const practice = readFileSync(
      "plugins/soletrando/frontend/PracticePage.tsx",
      "utf8",
    );
    expect(migration).not.toMatch(/audio|blob/iu);
    expect(practice).not.toContain(">{words[");
    expect(practice).not.toContain(">{word}");
    const onEnd = practice.indexOf("utterance.onend");
    const startSpelling = practice.indexOf("const startSpelling");
    expect(onEnd).toBeGreaterThan(-1);
    expect(practice.indexOf("setListened(true)", onEnd)).toBeGreaterThan(onEnd);
    expect(startSpelling).toBeGreaterThan(onEnd);
    expect(practice.slice(onEnd, startSpelling)).not.toContain(
      "startRecorder(stream)",
    );
    expect(practice.indexOf("getUserMedia", startSpelling)).toBeGreaterThan(
      startSpelling,
    );
    expect(
      practice.indexOf("track.enabled = true", startSpelling),
    ).toBeGreaterThan(startSpelling);
    expect(
      practice.indexOf("startRecorder(stream);", startSpelling),
    ).toBeGreaterThan(startSpelling);
    expect(practice).toContain("disabled={!listened || speaking}");
    expect(practice).toContain("{recording || sending ? (");
    expect(practice).toContain("controller.abort(), 30_000");
  });

  it("bounds and safely logs Workers AI transcription latency", () => {
    const route = readFileSync("plugins/soletrando/src/index.ts", "utf8");
    const transcription = readFileSync(
      "plugins/soletrando/src/transcription.ts",
      "utf8",
    );

    expect(transcription).toContain("TRANSCRIPTION_TIMEOUT_MS = 25_000");
    expect(transcription).toContain(
      '{ signal, tags: ["soletrando", "transcription"] }',
    );
    expect(transcription).toContain(
      "Nunca acrescente E antes de R nem I antes de A",
    );
    expect(route).toContain('event: "transcription_failed"');
    expect(route).toContain('event: "transcription_completed"');
    expect(route).toContain('return "AI_DAILY_LIMIT"');
  });

  it("keeps the installable child app scoped away from administration", () => {
    const token = "A".repeat(43);
    expect(soletrandoManifest(`/soletrando/c/${token}`)).toMatchObject({
      start_url: `/soletrando/c/${token}`,
      scope: "/soletrando/",
      display: "standalone",
    });
    expect(soletrandoManifest("/app/soletrando").start_url).toBe(
      "/soletrando/",
    );
    expect(SOLETRANDO_SERVICE_WORKER).not.toContain("/api/");
    expect(SOLETRANDO_SERVICE_WORKER).toContain("/soletrando/");
  });

  it("renders child-friendly success and error feedback", () => {
    const practice = readFileSync(
      "plugins/soletrando/frontend/PracticePage.tsx",
      "utf8",
    );
    const messages = readFileSync(
      "plugins/soletrando/frontend/i18n.ts",
      "utf8",
    );
    expect(practice).toContain("ThumbsUp");
    expect(practice).toContain("ThumbsDown");
    expect(practice).toContain("summary.passed");
    expect(practice).toContain("feedback.attempt.correctWord");
    expect(practice).toContain('"soletrando.practice.correctWord"');
    expect(practice).toContain('"soletrando.practice.yourSpelling"');
    expect(readFileSync("plugins/soletrando/src/index.ts", "utf8")).toContain(
      "correctWord: expected",
    );
    expect(messages).toContain("Parabéns! Muito bem!");
    expect(messages).toContain("Você errou esta palavra");
    expect(messages).toContain("A palavra certa");
    expect(messages).toContain("Você soletrou");
    expect(messages).toContain("acerte as dez palavras seguidas");
  });

  it("gives the listen action a high-contrast child-friendly color", () => {
    const practice = readFileSync(
      "plugins/soletrando/frontend/PracticePage.tsx",
      "utf8",
    );

    expect(practice).toContain(
      '<Volume2 className="h-5 w-5" />\n                {speaking',
    );
    expect(practice).toContain(
      'className="min-h-16 w-full bg-sky-700 text-base text-white shadow-sm hover:bg-sky-800"\n                disabled={speaking}',
    );
  });

  it("places the feedback action at the top of the result card", () => {
    const practice = readFileSync(
      "plugins/soletrando/frontend/PracticePage.tsx",
      "utf8",
    );
    const feedbackScreen = practice.slice(
      practice.indexOf('if (mode === "feedback"'),
      practice.indexOf('if (mode === "finished"'),
    );
    const action = feedbackScreen.indexOf(
      "onClick={() => void (retrying ? retry() : nextWord())}",
    );

    expect(action).toBeGreaterThan(-1);
    expect(action).toBeLessThan(feedbackScreen.indexOf("<ThumbsUp"));
    expect(
      feedbackScreen.indexOf(
        "onClick={() => void (retrying ? retry() : nextWord())}",
        action + 1,
      ),
    ).toBe(-1);
  });
});
