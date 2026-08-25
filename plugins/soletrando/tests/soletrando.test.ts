import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { pluginManifestSchema } from "../../../workers/core/src/installer/manifest.js";
import { SOLETRANDO_SERVICE_WORKER, soletrandoManifest } from "../src/pwa.js";
import { summarizeSessionProgress } from "../src/session-progress.js";
import {
  collapsedRecognitionMatches,
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
    expect(parseSpelling("bola")).toMatchObject({
      letters: "",
      ambiguous: true,
    });
    expect(collapsedRecognitionMatches("b o l a", "BOLA")).toBe(true);
  });

  it("scores accuracy and speed without using AI for the decision", () => {
    expect(scoreAttempt("BOLA", "BOLA", 4_000)).toEqual({
      correct: true,
      accuracyScore: 80,
      speedScore: 20,
      totalScore: 100,
    });
    expect(scoreAttempt("BOLA", "BOA", 4_000)).toMatchObject({
      correct: false,
      accuracyScore: 60,
      speedScore: 0,
    });
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
    expect(onEnd).toBeGreaterThan(-1);
    expect(practice.indexOf("track.enabled = true", onEnd)).toBeGreaterThan(
      onEnd,
    );
    expect(practice.indexOf("startRecorder(stream);", onEnd)).toBeGreaterThan(
      onEnd,
    );
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
});
