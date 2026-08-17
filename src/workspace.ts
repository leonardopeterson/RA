import {
  AbstractMesh, Color3, Mesh, MeshBuilder, PBRMaterial, Scene, StandardMaterial,
  SceneLoader, TransformNode, Vector3,
} from '@babylonjs/core';
import type { ObjectId } from './activity';

export const WORKSPACE = { halfWidth: 0.28, halfDepth: 0.20, surfaceY: 0.026 } as const;

// Logical manipulation surface. It is intentionally independent from the limb mesh,
// so replacing the visual model only requires tuning these measurements in meters.
export const TREATMENT_MANIPULATION_SURFACE = {
  centerX: -0.09,
  centerZ: 0,
  height: 0.159,
  radius: 0.072,
  halfStraightLength: 0.105,
} as const;

export interface Workspace {
  root: TransformNode;
  placementIndicator: Mesh;
  pickables: Map<ObjectId, AbstractMesh>;
  treatmentSurface: Mesh;
  coverSnap: Vector3;
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

  const tray = MeshBuilder.CreateBox('instrument-tray', { width: 0.19, depth: 0.30, height: 0.012 }, scene);
  tray.parent = root;
  tray.position.set(0.17, 0.033, 0);
  tray.material = material(scene, 'tray-material', '#829b94', 0.35);
  tray.isPickable = false;

  const limb = MeshBuilder.CreateCapsule('body-region', { radius: 0.065, height: 0.34, tessellation: 32 }, scene);
  limb.parent = root;
  limb.rotation.x = Math.PI / 2;
  limb.position.set(-0.09, 0.094, 0);
  limb.scaling.x = 1.08;
  limb.material = material(scene, 'skin-material', '#d89f83', 0.82);
  limb.isPickable = false;

  const treatment = MeshBuilder.CreateDisc('TreatmentInteractionSurface', { radius: 0.042, tessellation: 40 }, scene);
  treatment.parent = root;
  treatment.rotation.x = Math.PI / 2;
  treatment.position.set(-0.09, 0.159, 0);
  treatment.material = material(scene, 'treatment-material', '#a94f55');
  treatment.isPickable = false;

  const halo = MeshBuilder.CreateTorus('treatment-halo', { diameter: 0.105, thickness: 0.004, tessellation: 40 }, scene);
  halo.parent = root;
  halo.rotation.x = Math.PI / 2;
  halo.position.set(-0.09, 0.161, 0);
  const haloMat = new StandardMaterial('halo-material', scene);
  haloMat.emissiveColor = new Color3(0.25, 1, 0.68);
  haloMat.alpha = 0.55;
  halo.material = haloMat;
  halo.isPickable = false;

  const applicatorRoot = new Mesh('applicator', scene);
  applicatorRoot.parent = root;
  const handle = MeshBuilder.CreateCylinder('applicator-handle', { height: 0.14, diameter: 0.012, tessellation: 20 }, scene);
  handle.parent = applicatorRoot;
  handle.rotation.z = Math.PI / 2;
  handle.material = material(scene, 'applicator-handle-material', '#e8e2d2');
  const tip = MeshBuilder.CreateSphere('InteractionPoint', { diameter: 0.025, segments: 16 }, scene);
  tip.parent = applicatorRoot;
  tip.position.x = -0.075;
  tip.scaling.x = 1.35;
  tip.material = material(scene, 'applicator-tip-material', '#f8fbfa');
  tag([handle, tip], 'applicator');

  const cover = MeshBuilder.CreateBox('cover', { width: 0.105, depth: 0.085, height: 0.008 }, scene);
  cover.parent = root;
  cover.material = material(scene, 'cover-material', '#f8faf8');
  tag([cover], 'cover');

  const attachExternalModel = (file: string, holder: AbstractMesh, id: ObjectId, fallback: AbstractMesh[]) => {
    const modelsRoot = `${import.meta.env.BASE_URL}models/`;
    void SceneLoader.ImportMeshAsync('', modelsRoot, file, scene).then(({ meshes }) => {
      if (!meshes.length) return;
      meshes[0].parent = holder;
      meshes.forEach((mesh) => tag([mesh], id));
      fallback.forEach((mesh) => mesh === holder ? (mesh.material as PBRMaterial).alpha = 0 : mesh.dispose());
    }).catch((error) => console.warn(`Asset ${file} indisponível; usando fallback.`, error));
  };
  attachExternalModel('clinical-applicator.glb', applicatorRoot, 'applicator', [handle, tip]);
  attachExternalModel('clinical-cover.glb', cover, 'cover', [cover]);

  const pickables = new Map<ObjectId, AbstractMesh>([['applicator', applicatorRoot], ['cover', cover]]);
  const resetObjects = () => {
    applicatorRoot.position.set(0.18, 0.055, 0.04);
    applicatorRoot.rotation.set(0, 0, 0);
    cover.position.set(0.18, 0.045, -0.07);
    cover.rotation.set(0, 0, 0);
  };
  resetObjects();
  root.setEnabled(false);

  return { root, placementIndicator: indicator, pickables, treatmentSurface: treatment, coverSnap: new Vector3(-0.09, 0.169, 0), resetObjects };
}
