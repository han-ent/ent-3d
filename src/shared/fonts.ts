import { publicUrl } from './paths';

const STYLE_ID = 'ent3d-fonts';

/** Self-hosted Pretendard subset (SIL OFL). Weights 400 and 600 only. */
export function installFonts(): void {
  if (document.getElementById(STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = STYLE_ID;
  const regular = publicUrl('fonts/Pretendard-Regular.woff2');
  const semibold = publicUrl('fonts/Pretendard-SemiBold.woff2');
  style.textContent = `
@font-face {
  font-family: "Pretendard";
  font-style: normal;
  font-weight: 400;
  font-display: swap;
  src: url("${regular}") format("woff2");
}
@font-face {
  font-family: "Pretendard";
  font-style: normal;
  font-weight: 600;
  font-display: swap;
  src: url("${semibold}") format("woff2");
}
`;
  document.head.append(style);
}
