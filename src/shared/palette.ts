/**
 * Anatomical colours. Tissue classes do not share a hex.
 * Ossicles share one bone colour on purpose.
 * Dura is reserved: the published mesh mixes sigmoid sinus and dura, so that mesh
 * uses the vein colour until the two surfaces are split. 미검증.
 */
export const ANATOMICAL_COLORS = {
  artery: '#C8322F',
  vein: '#2F5FA8',
  dura: '#B8B0A0',
  facialNerve: '#E3B629',
  chorda: '#F3E2A1',
  cochleovestibular: '#C48A2A',
  bone: '#E8DFC8',
  ossicle: '#D6C49A',
  softTissue: '#D9B8B0',
  canal: '#CDB0A6',
  scalaVestibuli: '#D9C6E8',
  scalaTympani: '#9A84B5',
} as const;

export type AnatomicalColor = (typeof ANATOMICAL_COLORS)[keyof typeof ANATOMICAL_COLORS];

/** Structure id to the colour it is painted with. */
export const STRUCTURE_COLOR: Record<string, AnatomicalColor> = {
  'carotid-artery': ANATOMICAL_COLORS.artery,
  'sinus-dura': ANATOMICAL_COLORS.vein,
  'facial-nerve': ANATOMICAL_COLORS.facialNerve,
  'chorda-tympani': ANATOMICAL_COLORS.chorda,
  'cochleovestibular-nerve': ANATOMICAL_COLORS.cochleovestibular,
  bone: ANATOMICAL_COLORS.bone,
  malleus: ANATOMICAL_COLORS.ossicle,
  incus: ANATOMICAL_COLORS.ossicle,
  stapes: ANATOMICAL_COLORS.ossicle,
  'tympanic-membrane': ANATOMICAL_COLORS.softTissue,
  'external-auditory-canal': ANATOMICAL_COLORS.canal,
  'scala-vestibuli': ANATOMICAL_COLORS.scalaVestibuli,
  'scala-tympani': ANATOMICAL_COLORS.scalaTympani,
};
