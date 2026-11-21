import type { Localized } from './types';

export type StructureSystem = {
  id: string;
  name: Localized;
  ids: string[];
};

/** Chip groups. Order is the order shown in the sheet. */
export const STRUCTURE_SYSTEMS: StructureSystem[] = [
  { id: 'bone', name: { ko: '뼈', en: 'Bone' }, ids: ['bone'] },
  { id: 'ossicle', name: { ko: '이소골', en: 'Ossicles' }, ids: ['malleus', 'incus', 'stapes'] },
  {
    id: 'nerve',
    name: { ko: '신경', en: 'Nerve' },
    ids: ['facial-nerve', 'chorda-tympani', 'cochleovestibular-nerve'],
  },
  {
    id: 'vessel',
    name: { ko: '동맥·정맥', en: 'Artery and vein' },
    ids: ['carotid-artery', 'sinus-dura'],
  },
  { id: 'inner', name: { ko: '내이', en: 'Inner ear' }, ids: ['scala-vestibuli', 'scala-tympani'] },
  {
    id: 'canal',
    name: { ko: '외이·고막', en: 'Canal and membrane' },
    ids: ['external-auditory-canal', 'tympanic-membrane'],
  },
];
