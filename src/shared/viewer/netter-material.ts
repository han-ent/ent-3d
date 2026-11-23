import * as THREE from 'three';

/** Warm paper behind the atlas style. The current viewer keeps its grey stage. */
export const ATLAS_BACKGROUND = '#E6D3BC';
export const MODEL_BACKGROUND = '#C4C2BC';
export const ATLAS_INK = '#2A211C';

export type Ramp = { lit: string; shadow: string; highlight: string };

export type CutUniforms = {
  center: { value: THREE.Vector3 };
  radius: { value: number };
};

const FLUID_RAMPS: Record<string, Ramp> = {
  labyrinth: { lit: '#D7EAF6', shadow: '#8FB4CE', highlight: '#F5FBFE' },
  vestibule: { lit: '#C5DDF0', shadow: '#7BA6C4', highlight: '#F2F8FC' },
  'scala-vestibuli': { lit: '#E3F1FA', shadow: '#9FC0D6', highlight: '#F8FCFF' },
  'scala-vestibuli-basal': { lit: '#C9DFF2', shadow: '#7EABC6', highlight: '#F4FAFE' },
  'scala-vestibuli-middle': { lit: '#D6E9F6', shadow: '#8EB6D0', highlight: '#F7FBFE' },
  'scala-vestibuli-apical': { lit: '#EDF6FC', shadow: '#B7D0E2', highlight: '#FCFEFE' },
  'scala-tympani': { lit: '#B7D0E4', shadow: '#6E97B4', highlight: '#E7F2F8' },
  'scala-tympani-basal': { lit: '#9BBED6', shadow: '#5C86A6', highlight: '#DCEAF3' },
  'scala-tympani-middle': { lit: '#A9C8DE', shadow: '#6792B0', highlight: '#E3F0F7' },
  'scala-tympani-apical': { lit: '#C8DDED', shadow: '#7EA8C4', highlight: '#F0F7FB' },
  'scc-lateral': { lit: '#7FA8C8', shadow: '#3E6D90', highlight: '#D5E6F2' },
  'scc-superior': { lit: '#A9C7DE', shadow: '#5E8AAD', highlight: '#E7F3FA' },
  'scc-posterior': { lit: '#5E86A8', shadow: '#2C516E', highlight: '#C5D9E8' },
};

function parse(hex: string): [number, number, number] {
  const n = Number.parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function hex(channels: [number, number, number]): string {
  return `#${channels
    .map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, '0'))
    .join('')}`;
}

function scale(color: string, factor: number): string {
  const [r, g, b] = parse(color);
  return hex([r * factor, g * factor, b * factor]);
}

function mix(a: string, b: string, t: number): string {
  const left = parse(a);
  const right = parse(b);
  return hex([
    left[0] + (right[0] - left[0]) * t,
    left[1] + (right[1] - left[1]) * t,
    left[2] + (right[2] - left[2]) * t,
  ]);
}

/** Atlas colour for one structure. Facial-nerve segments keep their own yellows. */
export function illustrationRamp(id: string, baseHex: string): Ramp {
  if (id === 'bone' || id === 'skull-layer') {
    return { lit: '#F4E4C8', shadow: '#C4A06A', highlight: '#FFF6E8' };
  }
  if (id === 'malleus' || id === 'incus' || id === 'stapes') {
    return { lit: '#E2A24C', shadow: '#8C5A22', highlight: '#F8D7A4' };
  }
  if (id === 'carotid-artery') return { lit: '#D6453D', shadow: '#8E2424', highlight: '#F4B2A8' };
  if (id === 'sinus-dura') return { lit: '#3A6CB5', shadow: '#1C3E78', highlight: '#A9C6EA' };
  if (id === 'upper-body' || id === 'auricle') {
    return { lit: '#C5D0D4', shadow: '#7E949E', highlight: '#EEF3F5' };
  }
  if (id === 'skin') return { lit: '#E8B89A', shadow: '#C48468', highlight: '#F8DCC8' };
  if (id === 'muscle') return { lit: '#8E4034', shadow: '#5C241C', highlight: '#C47868' };
  if (id === 'tympanic-membrane' || id === 'tm-pars-tensa' || id === 'tm-pars-flaccida') {
    return { lit: '#E7B2A8', shadow: '#C47E78', highlight: '#F8E0DA' };
  }
  if (id === 'external-auditory-canal') return { lit: '#E4C8BC', shadow: '#C49A8C', highlight: '#F6E6DE' };
  if (FLUID_RAMPS[id]) return FLUID_RAMPS[id];
  return { lit: baseHex, shadow: scale(baseHex, 0.62), highlight: mix(baseHex, '#fff6d8', 0.42) };
}

export function outlinesAllowed(): boolean {
  if (typeof matchMedia !== 'function') return true;
  if (matchMedia('(pointer: coarse)').matches) return false;
  if (typeof window !== 'undefined' && Math.min(window.innerWidth, window.innerHeight) < 720) return false;
  return true;
}

const ATLAS_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
varying vec3 vWorld;
varying vec3 vNormal;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
  vec4 world = modelMatrix * vec4(transformed, 1.0);
  vWorld = world.xyz;
  vNormal = normalize(mat3(modelMatrix) * normal);
}
`;

const ATLAS_FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
varying vec3 vWorld;
varying vec3 vNormal;
uniform vec3 uLit;
uniform vec3 uShadow;
uniform vec3 uHighlight;
uniform vec3 uInk;
uniform float uOpacity;
uniform float uDetail;
uniform vec3 uCutCenter;
uniform float uCutRadius;
uniform float uCutScale;
uniform vec3 uKey;
uniform vec3 uFill;

float paper(vec3 p) {
  float a = sin(p.x * 1.7 + sin(p.y * 1.15 + p.z * 0.8));
  float b = sin(p.y * 2.05 + sin(p.z * 1.2 + p.x * 0.65));
  float c = sin(p.z * 2.4 + p.x * 1.3) * sin(p.y * 1.8 + p.x * 0.4);
  return a * 0.45 + b * 0.35 + c * 0.2;
}

void main() {
  #include <clipping_planes_fragment>
  vec3 n = normalize(vNormal);
  if (uDetail > 0.0) {
    vec3 p = vWorld * 0.85;
    float e = 0.65;
    float dx = paper(p + vec3(e, 0.0, 0.0)) - paper(p - vec3(e, 0.0, 0.0));
    float dy = paper(p + vec3(0.0, e, 0.0)) - paper(p - vec3(0.0, e, 0.0));
    float dz = paper(p + vec3(0.0, 0.0, e)) - paper(p - vec3(0.0, 0.0, e));
    n = normalize(n + uDetail * vec3(dx, dy, dz));
  }
  vec3 key = normalize(uKey);
  float wrap = clamp(dot(n, key) * 0.55 + 0.5, 0.0, 1.0);
  float shade = smoothstep(0.02, 0.78, wrap);
  vec3 col = mix(uShadow, uLit, 0.42 + 0.58 * shade);
  col = mix(col, uHighlight, smoothstep(0.58, 1.0, wrap) * 0.62);
  float fill = clamp(dot(n, normalize(uFill)) * 0.5 + 0.5, 0.0, 1.0);
  col = mix(col, mix(uShadow, uLit, 0.5), fill * 0.16);
  float blot = paper(vWorld * 0.04);
  col *= mix(0.97, 1.035, blot * 0.5 + 0.5);
  float crease = length(fwidth(normalize(vNormal)));
  col *= clamp(1.0 - crease * 0.35, 0.84, 1.0);
  vec3 viewDir = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - clamp(abs(dot(normalize(vNormal), viewDir)), 0.0, 1.0), 2.6);
  col = mix(col, uInk, rim * 0.38);
  float alpha = uOpacity;
  if (uCutScale > 0.0 && uCutRadius > 0.0) {
    float dist = distance(vWorld, uCutCenter);
    float limit = uCutRadius * uCutScale;
    if (dist < limit) discard;
    alpha *= smoothstep(limit, limit + 8.0, dist);
  }
  gl_FragColor = vec4(col, alpha);
}
`;

const HULL_VERTEX = /* glsl */ `
#include <common>
#include <clipping_planes_pars_vertex>
uniform float uPixels;
uniform vec2 uResolution;
void main() {
  #include <begin_vertex>
  #include <project_vertex>
  #include <clipping_planes_vertex>
  vec4 world = modelMatrix * vec4(transformed, 1.0);
  vec3 n = normalize(mat3(modelMatrix) * normal);
  vec4 clip = projectionMatrix * viewMatrix * world;
  vec4 clipN = projectionMatrix * viewMatrix * vec4(world.xyz + n, 1.0);
  vec2 dir = (clipN.xy / clipN.w) - (clip.xy / clip.w);
  float len = length(dir);
  if (len > 1e-5) dir /= len;
  vec2 ndc = dir * (uPixels * 2.0 / max(uResolution, vec2(1.0)));
  gl_Position = clip + vec4(ndc * clip.w, 0.0, 0.0);
  #include <clipping_planes_vertex>
}
`;

const HULL_FRAGMENT = /* glsl */ `
#include <common>
#include <clipping_planes_pars_fragment>
uniform vec3 uInk;
void main() {
  #include <clipping_planes_fragment>
  gl_FragColor = vec4(uInk, 1.0);
}
`;

export function createAtlasMaterial(options: {
  ramp: Ramp;
  opacity: number;
  cut: CutUniforms;
  cutScale: number;
  clippingPlanes: THREE.Plane[];
  side?: THREE.Side;
  detail?: number;
}): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: ATLAS_VERTEX,
    fragmentShader: ATLAS_FRAGMENT,
    uniforms: {
      uLit: { value: new THREE.Color(options.ramp.lit) },
      uShadow: { value: new THREE.Color(options.ramp.shadow) },
      uHighlight: { value: new THREE.Color(options.ramp.highlight) },
      uInk: { value: new THREE.Color(ATLAS_INK) },
      uOpacity: { value: options.opacity },
      uDetail: { value: options.detail ?? 0.35 },
      uCutCenter: options.cut.center,
      uCutRadius: options.cut.radius,
      uCutScale: { value: options.cutScale },
      uKey: { value: new THREE.Vector3(0.45, -0.78, -0.42) },
      uFill: { value: new THREE.Vector3(-0.55, 0.25, 0.55) },
    },
    side: options.side ?? THREE.FrontSide,
    clipping: true,
    clippingPlanes: options.clippingPlanes,
    transparent: options.opacity < 0.98,
    depthWrite: options.opacity >= 0.9,
    toneMapped: false,
  });
  material.opacity = options.opacity;
  return material;
}

export function createHullMaterial(clippingPlanes: THREE.Plane[]): THREE.ShaderMaterial {
  const material = new THREE.ShaderMaterial({
    vertexShader: HULL_VERTEX,
    fragmentShader: HULL_FRAGMENT,
    uniforms: {
      uPixels: { value: 1.7 },
      uResolution: { value: new THREE.Vector2(1, 1) },
      uInk: { value: new THREE.Color(ATLAS_INK) },
    },
    side: THREE.BackSide,
    clipping: true,
    clippingPlanes,
    depthTest: true,
    depthWrite: false,
    toneMapped: false,
  });
  return material;
}

export function paintAtlas(material: THREE.ShaderMaterial, ramp: Ramp, opacity: number, onTop: boolean): void {
  material.uniforms.uLit.value.set(ramp.lit);
  material.uniforms.uShadow.value.set(ramp.shadow);
  material.uniforms.uHighlight.value.set(ramp.highlight);
  material.uniforms.uOpacity.value = opacity;
  material.opacity = opacity;
  material.transparent = opacity < 0.98;
  material.depthWrite = !onTop && opacity >= 0.9;
  material.depthTest = !onTop;
  material.polygonOffset = opacity < 0.98;
  material.polygonOffsetFactor = 1;
  material.polygonOffsetUnits = 1;
}

export function atlasDetail(id: string): number {
  if (id === 'bone' || id === 'skull-layer') return 0.16;
  if (id === 'skin') return 0.08;
  if (id === 'malleus' || id === 'incus' || id === 'stapes') return 0.12;
  return 0.05;
}
