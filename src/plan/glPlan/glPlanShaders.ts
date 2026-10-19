/**
 * WebGL2-Shader-Programme für den GPU-Grundriss-Renderer.
 * Kompilierung + Fehlerbehandlung (Warnung + null, keine Exceptions).
 */

import type { ShaderProgram } from './glPlanTypes';

/**
 * Füll-Vertex-Shader: bildet Bildschirm-Raum-Positionen über die viewProj-Matrix
 * in den Clip-Raum ab. Für gefüllte Polygone (Wand-Poché, Räume, Decken).
 */
export const FILL_VERT = `#version 300 es
precision highp float;

uniform mat4 viewProj;

in vec2 position;

void main() {
  gl_Position = viewProj * vec4(position, 0.0, 1.0);
}
`;

/** Füll-Fragment-Shader: einheitliche Farbe (MVP, noch keine Schraffur). */
export const FILL_FRAG = `#version 300 es
precision mediump float;

uniform vec4 color;

out vec4 outColor;

void main() {
  outColor = color;
}
`;

/**
 * Linien-Vertex-Shader mit BILDSCHIRMKONSTANTER Breite.
 *
 * Idee: sowohl der Endpunkt als auch (Endpunkt + Normale) werden durch viewProj
 * transformiert; ihre Differenz im Clip-Raum (in Pixel skaliert) ergibt die
 * Perpendikel-Richtung. Diese wird auf `strokePx/2` Pixel normiert und — je nach
 * `side` — auf die passende Seite versetzt, dann px→Clip zurückgerechnet. So ist
 * die Strichbreite unabhängig vom Zoom (keine Re-Tessellierung nötig).
 */
export const LINE_VERT = `#version 300 es
precision highp float;

uniform mat4 viewProj;
uniform float strokePx;    // Basis-Breite in Geräte-px (bei strokeScale=1)
uniform float strokeScale; // Zoom-Skalierung: >1 = reingezoomt → dicker (Papier)
uniform vec2 viewportPx;   // Zeichenpuffer-Größe [w,h] in Geräte-px

in vec2 position;   // Bildschirm-Raum-Stützpunkt
in vec2 normal;     // Bildschirm-Raum-Einheits-Miter-Bisektor (Richtung des Versatzes)
in float side;      // +1.0 oder -1.0
in float miter;     // Miter-Längenfaktor 1/cos(θ/2) (1.0 = gerade, keine Ecke)

void main() {
  vec4 clipP = viewProj * vec4(position, 0.0, 1.0);
  vec4 clipN = viewProj * vec4(position + normal, 0.0, 1.0);

  // Bisektor-Richtung im Pixel-Raum (Clip-Differenz → px).
  vec2 dirPx = (clipN.xy - clipP.xy) * viewportPx * 0.5;
  float len = length(dirPx);
  vec2 unitPx = len > 1e-6 ? dirPx / len : vec2(0.0);

  // Echte Papierbreite in Geräte-px = mm(strokePx) · (mm→px)(strokeScale); mind.
  // 0.6 px. Der Miter-Faktor verlängert den Versatz an Ecken, sodass benachbarte
  // Segmente bündig verschmelzen (gehrte Ecke statt Butt-Cap-Stufe).
  float widthPx = max(1.0, strokePx * strokeScale) * miter;
  vec2 offsetPx = unitPx * (widthPx * 0.5) * side;
  clipP.xy += offsetPx / (viewportPx * 0.5);

  gl_Position = clipP;
}
`;

/** Linien-Fragment-Shader: einheitliche Farbe. */
export const LINE_FRAG = `#version 300 es
precision mediump float;

uniform vec4 color;

out vec4 outColor;

void main() {
  outColor = color;
}
`;

/** Kompiliert einen einzelnen Shader; null + Warnung bei Fehler. */
function compileShader(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) {
    console.warn('WebGL: Shader-Objekt konnte nicht erstellt werden');
    return null;
  }
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    console.warn(`WebGL: Shader-Kompilierung fehlgeschlagen:\n${gl.getShaderInfoLog(shader)}`);
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Verlinkt Vertex + Fragment zu einem Programm; null + Warnung bei Fehler. */
function linkProgram(
  gl: WebGL2RenderingContext,
  vert: WebGLShader,
  frag: WebGLShader,
): WebGLProgram | null {
  const program = gl.createProgram();
  if (!program) {
    console.warn('WebGL: Programm konnte nicht erstellt werden');
    return null;
  }
  gl.attachShader(program, vert);
  gl.attachShader(program, frag);
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
    console.warn(`WebGL: Programm-Verlinkung fehlgeschlagen:\n${gl.getProgramInfoLog(program)}`);
    gl.deleteProgram(program);
    return null;
  }
  return program;
}

/**
 * Kompiliert + verlinkt ein vollständiges Shader-Programm und ermittelt alle
 * Attribut-/Uniform-Orte. Gibt null zurück (mit Warnung) statt zu werfen.
 */
export function compileShaderProgram(
  gl: WebGL2RenderingContext,
  vertSrc: string,
  fragSrc: string,
): ShaderProgram | null {
  const vert = compileShader(gl, gl.VERTEX_SHADER, vertSrc);
  if (!vert) return null;
  const frag = compileShader(gl, gl.FRAGMENT_SHADER, fragSrc);
  if (!frag) {
    gl.deleteShader(vert);
    return null;
  }
  const program = linkProgram(gl, vert, frag);
  gl.deleteShader(vert);
  gl.deleteShader(frag);
  if (!program) return null;

  const loc = (name: string): GLint => gl.getAttribLocation(program, name);
  const uni = (name: string) => gl.getUniformLocation(program, name);

  return {
    program,
    attribs: {
      position: loc('position'),
      normal: loc('normal'),
      side: loc('side'),
      miter: loc('miter'),
    },
    uniforms: {
      viewProj: uni('viewProj'),
      color: uni('color'),
      strokePx: uni('strokePx'),
      strokeScale: uni('strokeScale'),
      viewportPx: uni('viewportPx'),
    },
  };
}

/** Füll-Programm (gefüllte Polygone). */
export function createFillProgram(gl: WebGL2RenderingContext): ShaderProgram | null {
  return compileShaderProgram(gl, FILL_VERT, FILL_FRAG);
}

/** Linien-Programm (bildschirmkonstante Striche). */
export function createLineProgram(gl: WebGL2RenderingContext): ShaderProgram | null {
  return compileShaderProgram(gl, LINE_VERT, LINE_FRAG);
}
