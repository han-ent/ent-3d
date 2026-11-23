import type { Vec3 } from './types';

/**
 * Cephalometric points shared by later regions (sinus, rhinology, neck).
 * Coordinates that are filled are this right-ear specimen in the upright head,
 * or the matching point on the upright Z-Anatomy skull. Orbitale and nasion are defined
 * here so the next region can fill them; this skull extract was not used to
 * invent those two coordinates.
 */
export type HeadLandmark = {
  id: 'porion' | 'orbitale' | 'nasion' | 'mastoid-tip';
  en: string;
  ko: string;
  definition: string;
  /** Specimen point after it has been turned into the upright head, in millimetres. */
  zetaMm?: Vec3;
  /** Matching point on the upright Z-Anatomy skull, in millimetres. */
  skullMm?: Vec3;
};

export const HEAD_LANDMARKS: HeadLandmark[] = [
  {
    id: 'porion',
    en: 'Porion',
    ko: '이공점',
    definition: 'Highest point on the upper rim of the external acoustic meatus.',
    zetaMm: [33.01, 46.847, 39.386],
    skullMm: [25.255, 36.659, 34.286],
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
    zetaMm: [30.061, 82.471, 44.874],
  },
];
