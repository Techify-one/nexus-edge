export type Phase = {
  id: number;
  title: string;
  words: readonly string[];
};

export const PHASES: readonly Phase[] = [
  {
    id: 1,
    title: "Primeiros passos",
    words: [
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
  },
  {
    id: 2,
    title: "Subindo de nível",
    words: [
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
  },
  {
    id: 3,
    title: "Super soletrador",
    words: [
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
  },
  {
    id: 4,
    title: "Reta de campeão",
    words: [
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
  },
] as const;

export const TOTAL_PHASES = PHASES.length;

export const getPhase = (phaseNumber: number): Phase | null =>
  PHASES.find((phase) => phase.id === phaseNumber) ?? null;

export const getWord = (phaseNumber: number, position: number): string | null =>
  getPhase(phaseNumber)?.words[position] ?? null;
