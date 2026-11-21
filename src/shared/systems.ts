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
    ids: [
      'facial-nerve',
      'fn-meatal',
      'fn-labyrinthine',
      'fn-geniculate',
      'fn-tympanic',
      'fn-second-genu',
      'fn-mastoid',
      'chorda-tympani',
      'cochleovestibular-nerve',
    ],
  },
  {
    id: 'vessel',
    name: { ko: '동맥·정맥', en: 'Artery and vein' },
    ids: ['carotid-artery', 'sinus-dura'],
  },
  {
    id: 'inner',
    name: { ko: '내이', en: 'Inner ear' },
    ids: [
      'labyrinth',
      'scala-vestibuli',
      'scala-vestibuli-basal',
      'scala-vestibuli-middle',
      'scala-vestibuli-apical',
      'scala-tympani',
      'scala-tympani-basal',
      'scala-tympani-middle',
      'scala-tympani-apical',
      'vestibule',
      'scc-lateral',
      'scc-superior',
      'scc-posterior',
    ],
  },
  {
    id: 'canal',
    name: { ko: '외이·고막', en: 'Canal and membrane' },
    ids: ['external-auditory-canal', 'tympanic-membrane', 'tm-pars-tensa', 'tm-pars-flaccida'],
  },
];
