import * as THREE from 'three';

import type { System } from '../core/Engine';

/**
 * §5's water: one plane, sine vertex displacement, a two-colour gradient and a fresnel
 * term. No reflection, no refraction, no textures, no second pass. §5 sanctions a
 * custom `ShaderMaterial` here and nowhere else, so the GLSL stays small enough to read
 * in one screen.
 *
 * Three things are load-bearing:
 *
 * - Displacement lives in the vertex shader, driven by `uTime` (§13: rewriting position
 *   attributes on the CPU would be a per-frame allocation *and* a per-frame upload).
 * - The wave phase is computed from the *world* position, not the local one, so the
 *   plane can chase the player via `setCenter` and the swell still stays put in the
 *   world instead of sliding along with the camera.
 * - The shader includes three's fog chunks in three's own order (colour space first,
 *   then fog), so water at the horizon is mixed toward exactly the same `fogColor`
 *   uniform, in exactly the same space, as the terrain beside it. Get that order wrong
 *   and the horizon shows a visible band against the sky dome.
 */

export interface WaterOptions {
  /** Y of the surface. Use HeightField's SEA_LEVEL. */
  level: number;
  /** Plane edge length. Default 700 — must cover the world plus the fog margin. */
  size?: number;
  segments?: number;
  shallowColor?: number;
  deepColor?: number;
  /** Peak swell height in units. Default 0.45; more reads as a storm, not a sea. */
  amplitude?: number;
  /**
   * Primary wave wavelength in world units. Defaults to 6x the vertex spacing, which
   * is the shortest wave the plane can actually resolve — a hand-picked value shorter
   * than 2x the spacing will alias into a crawling moire instead of a swell.
   */
  waveLength?: number;
}

const DEFAULT_SIZE = 700;
const DEFAULT_SEGMENTS = 24;
const DEFAULT_AMPLITUDE = 0.45;
const DEFAULT_SHALLOW = 0x4fb3c9;
const DEFAULT_DEEP = 0x123a52;

/** Vertices per wavelength for the derived default. Below ~4 the swell visibly steps. */
const VERTICES_PER_WAVE = 6;
const MIN_WAVE_LENGTH = 20;

/** Crest travel speed of the primary component, in units per second. */
const WAVE_SPEED = 2.2;

const TWO_PI = Math.PI * 2;

/**
 * Wavenumbers for the three components, as multiples of the primary. Deliberately
 * non-harmonic so the sum never repeats visibly across the plane.
 */
const WAVE_SCALE_2 = 1 / 0.72;
const WAVE_SCALE_3 = 1 / 1.6;

/**
 * `uTime` is a phase in radians and each component advances by an *integer* multiple of
 * it, so wrapping the uniform at 2pi is exact — no drift, no float blow-up over a long
 * session, and no visible pop at the wrap.
 */
const VERTEX_SHADER = /* glsl */ `
uniform float uTime;
uniform vec3 uWaveK;
uniform float uAmplitude;

varying vec3 vWorldPos;
varying vec3 vSurfaceNormal;
varying float vWave;

#include <fog_pars_vertex>

void main() {
  vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;

  float p1 = world.x * uWaveK.x + uTime * 3.0;
  float p2 = world.z * uWaveK.y - uTime * 2.0;
  float p3 = (world.x + world.z) * uWaveK.z + uTime;
  float h = 0.55 * sin(p1) + 0.35 * sin(p2) + 0.30 * sin(p3);
  world.y += h * uAmplitude;

  // The wave sum is closed form, so its exact gradient is the normal: no extra
  // samples, no normal attribute, no CPU work.
  float dhdx = uAmplitude * (0.55 * uWaveK.x * cos(p1) + 0.30 * uWaveK.z * cos(p3));
  float dhdz = uAmplitude * (0.35 * uWaveK.y * cos(p2) + 0.30 * uWaveK.z * cos(p3));

  vSurfaceNormal = normalize(vec3(-dhdx, 1.0, -dhdz));
  vWorldPos = world;
  vWave = h;

  vec4 mvPosition = viewMatrix * vec4(world, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  #include <fog_vertex>
}
`;

/**
 * The six lines §5 asks for: view direction, fresnel, gradient mix, crest glint.
 * `colorspace_fragment` before `fog_fragment` is three's own ordering — `fogColor`
 * arrives already in the output colour space, so fog must be mixed after the encode.
 */
const FRAGMENT_SHADER = /* glsl */ `
uniform vec3 uShallow;
uniform vec3 uDeep;

varying vec3 vWorldPos;
varying vec3 vSurfaceNormal;
varying float vWave;

#include <fog_pars_fragment>

void main() {
  vec3 viewDir = normalize(cameraPosition - vWorldPos);
  float fresnel = pow(1.0 - max(dot(normalize(vSurfaceNormal), viewDir), 0.0), 3.0);
  vec3 color = mix(uDeep, uShallow, fresnel);
  color += 0.10 * smoothstep(0.55, 1.10, vWave);

  gl_FragColor = vec4(color, 1.0);

  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export class Water implements System {
  readonly name = 'water';

  readonly mesh: THREE.Mesh;

  private readonly uTime: THREE.IUniform<number>;
  private readonly angularSpeed: number;
  /** Vertex spacing. `setCenter` snaps to it — see the comment there. */
  private readonly spacing: number;

  constructor(options: WaterOptions) {
    const size = options.size ?? DEFAULT_SIZE;
    const segments = Math.max(1, Math.floor(options.segments ?? DEFAULT_SEGMENTS));
    const amplitude = options.amplitude ?? DEFAULT_AMPLITUDE;

    this.spacing = size / segments;
    const waveLength = Math.max(
      MIN_WAVE_LENGTH,
      options.waveLength ?? this.spacing * VERTICES_PER_WAVE,
    );

    if (import.meta.env.DEV && waveLength < this.spacing * 2) {
      console.warn(
        'Water: waveLength ' +
          String(waveLength) +
          'u is under Nyquist for a ' +
          String(this.spacing) +
          'u vertex spacing; the swell will alias. Raise segments or waveLength.',
      );
    }

    const k1 = TWO_PI / waveLength;
    // Primary component advances by 3 * uTime, so this makes its crests travel at
    // WAVE_SPEED units per second regardless of the wavelength in play.
    this.angularSpeed = (TWO_PI * WAVE_SPEED) / (waveLength * 3);

    const geometry = new THREE.PlaneGeometry(size, size, segments, segments);
    // Bake the lie-flat rotation into the geometry so local +Y is world +Y: the shader
    // displaces along Y and `setCenter` moves in X/Z, both without a rotation to undo.
    geometry.rotateX(-Math.PI / 2);
    // Nothing in the shader samples a texture or reads the flat normal.
    geometry.deleteAttribute('normal');
    geometry.deleteAttribute('uv');
    geometry.computeBoundingSphere();
    // The bounding sphere is computed from undisplaced vertices; widen it so frustum
    // culling cannot clip a crest at the screen edge.
    const bounds = geometry.boundingSphere;
    if (bounds !== null) bounds.radius += amplitude + 0.5;

    const uTime: THREE.IUniform<number> = { value: 0 };
    this.uTime = uTime;

    // UniformsLib.fog spelled out: WebGLRenderer writes fogColor plus either
    // fogDensity (FogExp2) or fogNear/fogFar (Fog) into these every frame, and it
    // throws if the slots are missing. Declaring all four covers both fog types.
    const uniforms: Record<string, THREE.IUniform> = {
      fogColor: { value: new THREE.Color(0xffffff) },
      fogDensity: { value: 0.00025 },
      fogNear: { value: 1 },
      fogFar: { value: 2000 },
      uTime,
      uWaveK: { value: new THREE.Vector3(k1, k1 * WAVE_SCALE_2, k1 * WAVE_SCALE_3) },
      uAmplitude: { value: amplitude },
      uShallow: { value: new THREE.Color(options.shallowColor ?? DEFAULT_SHALLOW) },
      uDeep: { value: new THREE.Color(options.deepColor ?? DEFAULT_DEEP) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      // ShaderMaterial defaults fog to false; without this the horizon would not match.
      fog: true,
      transparent: false,
      depthWrite: true,
      side: THREE.FrontSide,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.name = 'water';
    this.mesh.position.y = options.level;
    // Drawn after the terrain: inland the plane is entirely under the ground, so early
    // depth rejection throws away a full screen of fragments for free.
    this.mesh.renderOrder = 1;
  }

  /** Advances the shader's time uniform. Nothing else, and no allocation. */
  update(dt: number): void {
    let t = this.uTime.value + dt * this.angularSpeed;
    if (t >= TWO_PI) t -= TWO_PI;
    this.uTime.value = t;
  }

  reset(): void {
    this.uTime.value = 0;
  }

  /**
   * Follows the player so a full 700-unit plane is never needed at close range.
   *
   * Snapped to the vertex spacing on purpose: the wave is sampled *at the vertices*, so
   * sliding them continuously through a world-space sine makes the crests shimmer and
   * crawl. Snapping keeps every vertex at a fixed world position modulo one cell, which
   * is invisible on a uniform grid and kills the shimmer outright.
   */
  setCenter(x: number, z: number): void {
    const spacing = this.spacing;
    this.mesh.position.x = Math.round(x / spacing) * spacing;
    this.mesh.position.z = Math.round(z / spacing) * spacing;
  }

  dispose(): void {
    this.mesh.removeFromParent();
    this.mesh.geometry.dispose();
    (this.mesh.material as THREE.Material).dispose();
  }
}
