import type { Vec3 } from './types';

/**
 * Cephalometric points shared by later regions (sinus, rhinology, neck).
 * Coordinates that are filled are this right-ear specimen or the Z-Anatomy
 * skull before the temporal-bone rigid map. Orbitale and nasion are defined
 * here so the next region can fill them; this skull extract was not used to
 * invent those two coordinates.
 */
export type HeadLandmark = {
  id: 'porion' | 'orbitale' | 'nasion' | 'mastoid-tip';
  en: string;
  ko: string;
  definition: string;
  /** Specimen millimetres, +X anterior, +Y inferior, +Z medial. */
  zetaMm?: Vec3;
  /** Original Z-Anatomy skull millimetres, before the rigid map. */
  skullMm?: Vec3;
};

export const HEAD_LANDMARKS: HeadLandmark[] = [
  {
    id: 'porion',
    en: 'Porion',
    ko: '이공점',
    definition: 'Highest point on the upper rim of the external acoustic meatus.',
    zetaMm: [28.51, 23.64, 14.46],
    skullMm: [48.5, 4.2, 27.6],
  },
  {
    id: 'orbitale',
    en: 'Orbitale',
    ko: '안와점',
    definition: 'Lowest point on the infraorbital rim. Used with porion for the Frankfort plane.',
  },
  {
    id: 'nasion',
    en: 'Nasion',
    ko: '비근점',
    definition: 'Midline point at the frontonasal suture.',
  },
  {
    id: 'mastoid-tip',
    en: 'Mastoid tip',
    ko: '유양돌기 첨부',
    definition: 'Most inferior point of the mastoid process.',
    zetaMm: [15.16, 57.25, 14.11],
  },
];
