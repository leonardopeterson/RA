import {
  AbstractMesh, Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial,
  TransformNode, Vector3,
} from '@babylonjs/core';
import { OBJECT_INITIAL_POSES, type BandageId, type ObjectId } from './activity';

export const WORKSPACE = { halfWidth: 0.28, halfDepth: 0.20, surfaceY: 0.026 } as const;
export const BANDAGE_LAYER_1_DIAMETER = 0.147;
export const BANDAGE_LAYER_2_RADIAL_OFFSET = 0.014;

// Logical surface data remains independent from the provisional leg meshes.
export const TREATMENT_MANIPULATION_SURFACE = {
  centerX: -0.09,
  centerZ: 0.045,
  height: 0.159,
  radius: 0.073,
  halfStraightLength: 0.09,
} as const;

export type TapeZoneName = 'sideA' | 'center' | 'sideB';

export interface TapeZones {
  sideA: Vector3;
  center: Vector3;
  sideB: Vector3;
  halfWidth: number;
  halfDepth: number;
}

export type BandageZoneName = 'right' | 'center' | 'left';

export interface BandageZones {
  right: Vector3;
  center: Vector3;
  left: Vector3;
  halfWidth: number;
  halfDepth: number;
}

export interface Workspace {
  root: TransformNode;
  placementIndicator: Mesh;
  pickables: Map<ObjectId, AbstractMesh>;
  treatmentSurface: Mesh;
  treatmentSnap: Vector3;
  solutionZone: Vector3;
  tapeZones: TapeZones;
  tapeSnap: Vector3;
  bandageZones: BandageZones;
  bandageRestartPoses: Record<BandageId, Vector3>;
  bandageLayerSegments: Record<BandageId, Mesh[]>;
  resetObjects(): void;
}

function material(scene: Scene, name: string, color: string, roughness = 0.72): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = Color3.FromHexString(color);
  mat.roughness = roughness;
  mat.metallic = 0;
  return mat;
}

function tag(meshes: AbstractMesh[], id: ObjectId): void {
  meshes.forEach((mesh) => { mesh.metadata = { objectId: id }; mesh.isPickable = true; });
}

export function createWorkspace(scene: Scene): Workspace {
  const root = new TransformNode('WorkspaceRoot', scene);

  const indicator = MeshBuilder.CreateTorus('placement-indicator', { diameter: 0.18, thickness: 0.008, tessellation: 48 }, scene);
  indicator.rotation.x = Math.PI / 2;
  indicator.isVisible = false;
  const indicatorMat = new StandardMaterial('indicator-material', scene);
  indicatorMat.emissiveColor = new Color3(0.18, 1, 0.66);
  indicator.material = indicatorMat;

  const base = MeshBuilder.CreateBox('station-base', { width: 0.58, depth: 0.42, height: 0.025 }, scene);
  base.parent = root;
  base.position.y = 0.0125;
  base.material = material(scene, 'base-material', '#dce9e4');
  base.isPickable = false;

  const tray = MeshBuilder.CreateBox('instrument-tray', { width: 0.19, depth: 0.33, height: 0.012 }, scene);
  tray.parent = root;
  tray.position.set(0.17, 0.033, 0);
  tray.material = material(scene, 'tray-material', '#829b94', 0.35);
  tray.isPickable = false;

  // Provisional lower leg, ankle and foot. The foot's broad sole faces +Z,
  // toward the user side of the workspace.
  const lowerLeg = MeshBuilder.CreateCapsule('lower-leg', { radius: 0.066, height: 0.29, tessellation: 32 }, scene);
  lowerLeg.parent = root;
  lowerLeg.rotation.x = Math.PI / 2;
  lowerLeg.position.set(-0.09, 0.094, -0.035);
  lowerLeg.scaling.x = 1.08;
  lowerLeg.material = material(scene, 'skin-material', '#d89f83', 0.82);
  lowerLeg.isPickable = false;

  const ankle = MeshBuilder.CreateSphere('ankle', { diameter: 0.12, segments: 24 }, scene);
  ankle.parent = root;
  ankle.position.set(-0.09, 0.09, 0.112);
  ankle.scaling.z = 0.78;
  ankle.material = lowerLeg.material;
  ankle.isPickable = false;

  const foot = MeshBuilder.CreateBox('foot', { width: 0.13, height: 0.14, depth: 0.055 }, scene);
  foot.parent = root;
  foot.position.set(-0.09, 0.105, 0.165);
  foot.material = lowerLeg.material;
  foot.isPickable = false;

  const treatment = MeshBuilder.CreateDisc('TreatmentInteractionSurface', { radius: 0.043, tessellation: 40 }, scene);
  treatment.parent = root;
  treatment.rotation.x = Math.PI / 2;
  treatment.position.set(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.055);
  treatment.material = material(scene, 'treatment-material', '#a94f55');
  treatment.isPickable = false;

  const halo = MeshBuilder.CreateTorus('treatment-halo', { diameter: 0.108, thickness: 0.004, tessellation: 40 }, scene);
  halo.parent = root;
  halo.rotation.x = Math.PI / 2;
  halo.position.set(-0.09, TREATMENT_MANIPULATION_SURFACE.height + 0.002, 0.055);
  const haloMat = new StandardMaterial('halo-material', scene);
  haloMat.emissiveColor = new Color3(0.25, 1, 0.68);
  haloMat.alpha = 0.55;
  halo.material = haloMat;
  halo.isPickable = false;

  const debrisoft = MeshBuilder.CreateCylinder('debrisoft-pad', { diameter: 0.072, height: 0.014, tessellation: 32 }, scene);
  debrisoft.parent = root;
  debrisoft.material = material(scene, 'debrisoft-material', '#d9f2ef');
  tag([debrisoft], 'debrisoft-pad');

  const bottle = new Mesh('solution-bottle', scene);
  bottle.parent = root;
  const bottleBody = MeshBuilder.CreateCylinder('solution-bottle-body', { height: 0.105, diameter: 0.042, tessellation: 24 }, scene);
  bottleBody.parent = bottle;
  bottleBody.position.y = 0.0525;
  bottleBody.material = material(scene, 'bottle-material', '#69a9bd', 0.3);
  const bottleCap = MeshBuilder.CreateCylinder('solution-bottle-cap', { height: 0.024, diameter: 0.025, tessellation: 20 }, scene);
  bottleCap.parent = bottle;
  bottleCap.position.y = 0.116;
  bottleCap.material = material(scene, 'cap-material', '#e8f5f2', 0.4);
  tag([bottleBody, bottleCap], 'solution-bottle');

  const gauze = MeshBuilder.CreateBox('gauze', { width: 0.092, depth: 0.076, height: 0.009 }, scene);
  gauze.parent = root;
  gauze.material = material(scene, 'gauze-material', '#fbfcf8');
  tag([gauze], 'gauze');

  const tape = MeshBuilder.CreateBox('tape-strip', { width: 0.15, depth: 0.018, height: 0.005 }, scene);
  tape.parent = root;
  tape.material = material(scene, 'tape-material', '#e8d6b5', 0.88);
  tag([tape], 'tape-strip');

  const bandage = MeshBuilder.CreateCylinder('bandage-1', { height: 0.055, diameter: 0.05, tessellation: 28 }, scene);
  bandage.parent = root;
  bandage.material = material(scene, 'bandage-roll-material', '#f0e6cf', 0.9);
  tag([bandage], 'bandage-1');

  const bandage2 = MeshBuilder.CreateCylinder('bandage-2', { height: 0.055, diameter: 0.052, tessellation: 28 }, scene);
  bandage2.parent = root;
  bandage2.material = material(scene, 'bandage-roll-2-material', '#d9e7e5', 0.9);
  tag([bandage2], 'bandage-2');

  const createBandageLayer = (layer: 1 | 2, diameter: number, zStart: number, color: string) => {
    const layerMaterial = material(scene, `bandage-layer-${layer}-material`, color, 0.94);
    return Array.from({ length: 10 }, (_, index) => {
      const segment = MeshBuilder.CreateTorus(`bandage-layer-${layer}-segment-${index + 1}`, {
      diameter,
      thickness: 0.012,
      tessellation: 32,
    }, scene);
    segment.parent = root;
    segment.rotation.x = Math.PI / 2;
    segment.position.set(-0.09, 0.094, zStart - index * 0.02);
    segment.material = layerMaterial;
    segment.isPickable = false;
    segment.setEnabled(false);
    return segment;
    });
  };
  const bandageLayerSegments: Record<BandageId, Mesh[]> = {
    'bandage-1': createBandageLayer(1, BANDAGE_LAYER_1_DIAMETER, 0.09, '#eee3cb'),
    'bandage-2': createBandageLayer(2, BANDAGE_LAYER_1_DIAMETER + BANDAGE_LAYER_2_RADIAL_OFFSET, 0.085, '#d8e8e5'),
  };

  const pickables = new Map<ObjectId, AbstractMesh>([
    ['debrisoft-pad', debrisoft],
    ['solution-bottle', bottle],
    ['gauze', gauze],
    ['tape-strip', tape],
    ['bandage-1', bandage],
    ['bandage-2', bandage2],
  ]);

  const resetObjects = () => {
    for (const [id, mesh] of pickables) {
      const pose = OBJECT_INITIAL_POSES[id];
      mesh.position.set(...pose.position);
      mesh.rotationQuaternion = null;
      mesh.rotation.set(...pose.rotation);
    }
  };
  resetObjects();
  root.setEnabled(false);

  const treatmentSnap = new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height + 0.012, 0.055);
  const solutionZone = new Vector3(treatmentSnap.x, TREATMENT_MANIPULATION_SURFACE.height + 0.065, treatmentSnap.z);
  const tapeZones: TapeZones = {
    sideA: new Vector3(-0.145, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    center: new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    sideB: new Vector3(-0.035, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    halfWidth: 0.018,
    halfDepth: 0.042,
  };
  const tapeSnap = new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height + 0.022, treatmentSnap.z);
  const bandageZones: BandageZones = {
    right: new Vector3(-0.005, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    center: new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    left: new Vector3(-0.175, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    halfWidth: 0.023,
    halfDepth: 0.06,
  };
  const bandageRestartPoses: Record<BandageId, Vector3> = {
    'bandage-1': new Vector3(bandageZones.right.x, TREATMENT_MANIPULATION_SURFACE.height + 0.035, bandageZones.right.z),
    'bandage-2': new Vector3(bandageZones.right.x, TREATMENT_MANIPULATION_SURFACE.height + 0.043, bandageZones.right.z),
  };
  return {
    root, placementIndicator: indicator, pickables, treatmentSurface: treatment,
    treatmentSnap, solutionZone, tapeZones, tapeSnap, bandageZones,
    bandageRestartPoses, bandageLayerSegments, resetObjects,
  };
}
