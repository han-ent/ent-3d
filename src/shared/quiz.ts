import type { Lang, Localized } from './types';

export type QuizStructure = {
  id: string;
  name: Localized;
};

export type NameQuestion = {
  mode: 'name';
  structureId: string;
  choices: { id: string; label: string }[];
};

export type LocateQuestion = {
  mode: 'locate';
  structureId: string;
  label: string;
};

export type QuizQuestion = NameQuestion | LocateQuestion;

export function grade(question: QuizQuestion, pickedId: string): boolean {
  return pickedId === question.structureId;
}

function pickIndex(count: number, rng: () => number): number {
  if (count <= 1) return 0;
  return Math.min(count - 1, Math.floor(rng() * count));
}

function shuffle<T>(items: T[], rng: () => number): T[] {
  const copy = items.slice();
  for (let i = copy.length - 1; i > 0; i -= 1) {
    const j = Math.min(i, Math.floor(rng() * (i + 1)));
    const tmp = copy[i]!;
    copy[i] = copy[j]!;
    copy[j] = tmp;
  }
  return copy;
}

export function makeNameQuestion(
  items: QuizStructure[],
  lang: Lang,
  rng: () => number = Math.random,
  choiceCount = 4,
): NameQuestion {
  if (items.length === 0) throw new Error('quiz needs at least one structure');
  const answer = items[pickIndex(items.length, rng)]!;
  const others = shuffle(
    items.filter((item) => item.id !== answer.id),
    rng,
  );
  const choices = shuffle(
    [answer, ...others.slice(0, Math.max(0, choiceCount - 1))],
    rng,
  ).map((item) => ({ id: item.id, label: item.name[lang] }));
  return { mode: 'name', structureId: answer.id, choices };
}

export function makeLocateQuestion(
  items: QuizStructure[],
  lang: Lang,
  rng: () => number = Math.random,
): LocateQuestion {
  if (items.length === 0) throw new Error('quiz needs at least one structure');
  const answer = items[pickIndex(items.length, rng)]!;
  return { mode: 'locate', structureId: answer.id, label: answer.name[lang] };
}
