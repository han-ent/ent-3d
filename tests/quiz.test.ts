import { describe, expect, it } from 'vitest';
import { grade, makeLocateQuestion, makeNameQuestion, type QuizStructure } from '../src/shared/quiz';

const items: QuizStructure[] = [
  { id: 'malleus', name: { ko: '망치뼈', en: 'Malleus' } },
  { id: 'incus', name: { ko: '모루뼈', en: 'Incus' } },
  { id: 'stapes', name: { ko: '등자뼈', en: 'Stapes' } },
  { id: 'cochlea', name: { ko: '달팽이관', en: 'Cochlea' } },
  { id: 'facial_nerve', name: { ko: '얼굴신경', en: 'Facial nerve' } },
];

function sequence(values: number[]): () => number {
  let index = 0;
  return () => {
    const value = values[index] ?? 0;
    index += 1;
    return value;
  };
}

describe('quiz', () => {
  it('asks for a name and includes the answer among the choices', () => {
    const question = makeNameQuestion(items, 'ko', sequence([0, 0.2, 0.9, 0.1, 0.4]));
    expect(question.mode).toBe('name');
    expect(question.choices.map((choice) => choice.id)).toContain(question.structureId);
    expect(question.choices).toHaveLength(4);
    expect(question.choices.some((choice) => choice.label === '망치뼈' || choice.label === '모루뼈')).toBe(true);
    expect(grade(question, question.structureId)).toBe(true);
    expect(grade(question, 'missing')).toBe(false);
  });

  it('asks the learner to find a named structure', () => {
    const question = makeLocateQuestion(items, 'en', () => 0.99);
    expect(question.mode).toBe('locate');
    expect(question.structureId).toBe('facial_nerve');
    expect(question.label).toBe('Facial nerve');
  });
});
