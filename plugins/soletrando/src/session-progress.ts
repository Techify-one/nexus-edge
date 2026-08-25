export type AttemptProgressRow = {
  position?: unknown;
  totalScore?: unknown;
};

export const isPerfectPhase = (
  attemptCount: number,
  correctCount: number,
): boolean => attemptCount === 10 && correctCount === 10;

export function summarizeSessionProgress(rows: AttemptProgressRow[]) {
  const positions = new Set(
    rows
      .map((row) => Number(row.position))
      .filter(
        (position) =>
          Number.isInteger(position) && position >= 0 && position < 10,
      ),
  );
  let nextPosition = 0;
  while (nextPosition < 10 && positions.has(nextPosition)) nextPosition += 1;

  const scores = rows
    .map((row) => Number(row.totalScore))
    .filter((score) => Number.isFinite(score));

  return {
    answeredCount: positions.size,
    nextPosition,
    scores,
    runningScore: scores.length
      ? Math.round(
          scores.reduce((sum, score) => sum + score, 0) / scores.length,
        )
      : 0,
  };
}
