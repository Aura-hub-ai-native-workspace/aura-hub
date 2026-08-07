/**
 * Ambient declarations for the `three` dependency (v0.185).
 * ------------------------------------------------------------------
 * `@types/three` is intentionally not vendored in this repo, so the
 * untyped ESM entry points are declared here to keep the project's
 * strict typecheck clean. The Architecture diagram only exercises the
 * rendering API surface; every member is paired as a value (`const`,
 * `any`) and an empty type (`interface`) so it resolves in both
 * value and type positions (e.g. `new THREE.Mesh()` and `THREE.Mesh`).
 */
declare module 'three' {
  export const AmbientLight: any;
  export interface AmbientLight {}
  export const BoxGeometry: any;
  export interface BoxGeometry {}
  export const CanvasTexture: any;
  export interface CanvasTexture {}
  export const Color: any;
  export interface Color {}
  export const DirectionalLight: any;
  export interface DirectionalLight {}
  export const DoubleSide: any;
  export const EdgesGeometry: any;
  export interface EdgesGeometry {}
  export const Group: any;
  export interface Group {}
  export const LineBasicMaterial: any;
  export interface LineBasicMaterial {}
  export const LineSegments: any;
  export interface LineSegments {}
  export const Mesh: any;
  export interface Mesh {}
  export const MeshBasicMaterial: any;
  export interface MeshBasicMaterial {}
  export const Object: any;
  export interface Object {}
  export const Object3D: any;
  export interface Object3D {
    [key: string]: any;
  }
  export const PerspectiveCamera: any;
  export interface PerspectiveCamera {}
  export const Plane: any;
  export interface Plane {}
  export const PlaneGeometry: any;
  export interface PlaneGeometry {}
  export const Raycaster: any;
  export interface Raycaster {}
  export const Scene: any;
  export interface Scene {}
  export const Vector: any;
  export interface Vector {}
  export const Vector2: any;
  export interface Vector2 {}
  export const Vector3: any;
  export interface Vector3 {}
  export const WebGLRenderer: any;
  export interface WebGLRenderer {}
}
declare module 'three/examples/jsm/postprocessing/EffectComposer.js' {
  export const EffectComposer: any;
}
declare module 'three/examples/jsm/postprocessing/RenderPass.js' {
  export const RenderPass: any;
}
declare module 'three/examples/jsm/postprocessing/UnrealBloomPass.js' {
  export const UnrealBloomPass: any;
}
