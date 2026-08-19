import {
  AbstractMesh, Color3, Matrix, Mesh, MeshBuilder, PBRMaterial, Scene, SceneLoader, StandardMaterial,
  TransformNode, Vector3, VertexData,
} from '@babylonjs/core';
import { OBJECT_INITIAL_POSES, type BandageId, type ObjectId } from './activity';
import { AnatomySurface, rotationFromUpToNormal } from './anatomySurface';

export const WORKSPACE = { halfWidth: 0.28, halfDepth: 0.20, surfaceY: 0.026 } as const;

const BANDAGE_SAMPLE_COUNT = 50;
const BANDAGE_WIDTH = 0.045;
const BANDAGE_THICKNESS = 0.002;
const BANDAGE_STEP = 0.020;
const BANDAGE_LAYER_1_CLEARANCE = 0.008;
const BANDAGE_LAYER_2_CLEARANCE = 0.012;
const BANDAGE_1_START_Z = 0.09;
const BANDAGE_2_START_Z = 0.087;
const WOUND_SURFACE_OFFSET = 0.001;
const TREATMENT_VISUAL_X = -0.09;
const TREATMENT_VISUAL_Z = 0.055;

// Logical gameplay region remains independent from the visual anatomy.
// It decides when an action is valid; AnatomySurface decides where the real skin is.
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
  anatomySurface: AnatomySurface;
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
  meshes.forEach((mesh) => {
    mesh.metadata = { objectId: id };
    mesh.isPickable = true;
  });
}

export function createWorkspace(scene: Scene): Workspace {
  const root = new TransformNode('WorkspaceRoot', scene);
  const anatomySurface = new AnatomySurface(root);

  const indicator = MeshBuilder.CreateTorus(
    'placement-indicator',
    { diameter: 0.18, thickness: 0.008, tessellation: 48 },
    scene,
  );
  indicator.rotation.x = Math.PI / 2;
  indicator.isVisible = false;
  const indicatorMat = new StandardMaterial('indicator-material', scene);
  indicatorMat.emissiveColor = new Color3(0.18, 1, 0.66);
  indicator.material = indicatorMat;

  const base = MeshBuilder.CreateBox(
    'station-base',
    { width: 0.58, depth: 0.42, height: 0.025 },
    scene,
  );
  base.parent = root;
  base.position.y = 0.0125;
  base.material = material(scene, 'base-material', '#dce9e4');
  base.isPickable = false;

  const tray = MeshBuilder.CreateBox(
    'instrument-tray',
    { width: 0.19, depth: 0.33, height: 0.012 },
    scene,
  );
  tray.parent = root;
  tray.position.set(0.17, 0.033, 0);
  tray.material = material(scene, 'tray-material', '#829b94', 0.35);
  tray.isPickable = false;

  // Fallback anatomy. It is also used as the initial sampling surface until the GLB loads.
  const lowerLeg = MeshBuilder.CreateCapsule(
    'lower-leg-fallback',
    { radius: 0.066, height: 0.29, tessellation: 32 },
    scene,
  );
  lowerLeg.parent = root;
  lowerLeg.rotation.x = Math.PI / 2;
  lowerLeg.position.set(-0.09, 0.094, -0.035);
  lowerLeg.scaling.x = 1.08;
  lowerLeg.material = material(scene, 'skin-material', '#d89f83', 0.82);
  lowerLeg.isPickable = false;

  const ankle = MeshBuilder.CreateSphere(
    'ankle-fallback',
    { diameter: 0.12, segments: 24 },
    scene,
  );
  ankle.parent = root;
  ankle.position.set(-0.09, 0.09, 0.112);
  ankle.scaling.z = 0.78;
  ankle.material = lowerLeg.material;
  ankle.isPickable = false;

  const foot = MeshBuilder.CreateBox(
    'foot-fallback',
    { width: 0.13, height: 0.14, depth: 0.055 },
    scene,
  );
  foot.parent = root;
  foot.position.set(-0.09, 0.105, 0.165);
  foot.material = lowerLeg.material;
  foot.isPickable = false;

  anatomySurface.setMeshes([lowerLeg, ankle, foot]);

  // The wound and halo share one surface anchor. The anchor is recalculated whenever
  // the anatomical mesh changes, so the visual dressing follows the actual skin.
  const treatmentVisualAnchor = new TransformNode('treatment-visual-anchor', scene);
  treatmentVisualAnchor.parent = root;

  const treatment = MeshBuilder.CreateDisc(
    'TreatmentInteractionSurface',
    { radius: 0.043, tessellation: 40 },
    scene,
  );
  treatment.parent = treatmentVisualAnchor;
  treatment.rotation.x = Math.PI / 2;
  treatment.position.set(0, 0, 0);
  treatment.material = material(scene, 'treatment-material', '#a94f55');
  treatment.isPickable = false;

  const halo = MeshBuilder.CreateTorus(
    'treatment-halo',
    { diameter: 0.095, thickness: 0.004, tessellation: 40 },
    scene,
  );
  halo.parent = treatmentVisualAnchor;
  halo.rotation.x = Math.PI / 2;
  halo.position.set(0, 0.001, 0);
  const haloMat = new StandardMaterial('halo-material', scene);
  haloMat.emissiveColor = new Color3(0.25, 1, 0.68);
  haloMat.alpha = 0.40;
  halo.material = haloMat;
  halo.isPickable = false;

  const syncTreatmentVisual = () => {
    const sample = anatomySurface.sampleTopSurface(TREATMENT_VISUAL_X, TREATMENT_VISUAL_Z);
    if (!sample) return;

    treatmentVisualAnchor.position.copyFrom(
      sample.point.add(sample.normal.scale(WOUND_SURFACE_OFFSET)),
    );
    treatmentVisualAnchor.rotationQuaternion = rotationFromUpToNormal(sample.normal);
  };

  const debrisoft = MeshBuilder.CreateCylinder(
    'debrisoft-pad',
    { diameter: 0.072, height: 0.014, tessellation: 32 },
    scene,
  );
  debrisoft.parent = root;
  debrisoft.material = material(scene, 'debrisoft-material', '#d9f2ef');
  tag([debrisoft], 'debrisoft-pad');

  const bottle = new Mesh('solution-bottle', scene);
  bottle.parent = root;
  const bottleBody = MeshBuilder.CreateCylinder(
    'solution-bottle-body',
    { height: 0.105, diameter: 0.042, tessellation: 24 },
    scene,
  );
  bottleBody.parent = bottle;
  bottleBody.position.y = 0.0525;
  bottleBody.material = material(scene, 'bottle-material', '#69a9bd', 0.3);
  const bottleCap = MeshBuilder.CreateCylinder(
    'solution-bottle-cap',
    { height: 0.024, diameter: 0.025, tessellation: 20 },
    scene,
  );
  bottleCap.parent = bottle;
  bottleCap.position.y = 0.116;
  bottleCap.material = material(scene, 'cap-material', '#e8f5f2', 0.4);
  tag([bottleBody, bottleCap], 'solution-bottle');

  // Thin dressing meshes: their final Y/rotation come from AnatomySurface during snap.
  const gauze = MeshBuilder.CreateBox(
    'gauze',
    { width: 0.092, depth: 0.076, height: 0.003 },
    scene,
  );
  gauze.parent = root;
  gauze.material = material(scene, 'gauze-material', '#fbfcf8');
  tag([gauze], 'gauze');

  const tape = MeshBuilder.CreateBox(
    'tape-strip',
    { width: 0.15, depth: 0.018, height: 0.0015 },
    scene,
  );
  tape.parent = root;
  tape.material = material(scene, 'tape-material', '#e8d6b5', 0.88);
  tag([tape], 'tape-strip');

  const bandage = MeshBuilder.CreateCylinder(
    'bandage-1',
    { height: 0.055, diameter: 0.05, tessellation: 28 },
    scene,
  );
  bandage.parent = root;
  bandage.material = material(scene, 'bandage-roll-material', '#f0e6cf', 0.9);
  tag([bandage], 'bandage-1');

  const bandage2 = MeshBuilder.CreateCylinder(
    'bandage-2',
    { height: 0.055, diameter: 0.052, tessellation: 28 },
    scene,
  );
  bandage2.parent = root;
  bandage2.material = material(scene, 'bandage-roll-2-material', '#d9e7e5', 0.9);
  tag([bandage2], 'bandage-2');

  function createFlatBandRing(
    sceneRef: Scene,
    name: string,
    radius: number,
    width: number,
    thickness: number,
    segments = 48,
  ): Mesh {
    const mesh = new Mesh(name, sceneRef);
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];
    const innerRadius = Math.max(0.001, radius - thickness / 2);
    const outerRadius = radius + thickness / 2;
    const halfWidth = width / 2;

    for (let i = 0; i <= segments; i++) {
      const t = i / segments;
      const angle = t * Math.PI * 2;
      const cos = Math.cos(angle);
      const sin = Math.sin(angle);

      positions.push(cos * outerRadius, sin * outerRadius, -halfWidth);
      positions.push(cos * outerRadius, sin * outerRadius, halfWidth);
      positions.push(cos * innerRadius, sin * innerRadius, -halfWidth);
      positions.push(cos * innerRadius, sin * innerRadius, halfWidth);
      uvs.push(t, 0, t, 1, t, 0, t, 1);
    }

    for (let i = 0; i < segments; i++) {
      const a = i * 4;
      const b = a + 4;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
      indices.push(a + 2, a + 3, b + 2, a + 3, b + 3, b + 2);
      indices.push(a, a + 2, b, a + 2, b + 2, b);
      indices.push(a + 1, b + 1, a + 3, a + 3, b + 1, b + 3);
    }

    VertexData.ComputeNormals(positions, indices, normals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    return mesh;
  }

  function createConformingBandSegment(
    sceneRef: Scene,
    anatomy: AnatomySurface,
    name: string,
    zCenter: number,
    width: number,
    thickness: number,
    clearance: number,
    samples = 50,
  ): Mesh {
    const sectionA = anatomy.sampleCrossSection(zCenter + width / 2, samples);
    const sectionB = anatomy.sampleCrossSection(zCenter - width / 2, samples);

    if (sectionA.length !== samples || sectionB.length !== samples) {
      const fallback = createFlatBandRing(
        sceneRef,
        name,
        0.049,
        width,
        thickness,
        samples,
      );
      fallback.position.set(TREATMENT_MANIPULATION_SURFACE.centerX, 0.082, zCenter);
      return fallback;
    }

    const mesh = new Mesh(name, sceneRef);
    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let i = 0; i < samples; i++) {
      const start = sectionA[i];
      const end = sectionB[i];
      const innerStart = start.point.add(start.normal.scale(clearance));
      const innerEnd = end.point.add(end.normal.scale(clearance));
      const outerStart = innerStart.add(start.normal.scale(thickness));
      const outerEnd = innerEnd.add(end.normal.scale(thickness));

      positions.push(
        innerStart.x, innerStart.y, innerStart.z,
        innerEnd.x, innerEnd.y, innerEnd.z,
        outerStart.x, outerStart.y, outerStart.z,
        outerEnd.x, outerEnd.y, outerEnd.z,
      );

      const t = i / samples;
      uvs.push(t, 0, t, 1, t, 0, t, 1);
    }

    for (let i = 0; i < samples; i++) {
      const next = (i + 1) % samples;
      const a = i * 4;
      const b = next * 4;

      indices.push(a + 2, b + 2, a + 3, a + 3, b + 2, b + 3);
      indices.push(a, a + 1, b, a + 1, b + 1, b);
      indices.push(a, b, a + 2, a + 2, b, b + 2);
      indices.push(a + 1, a + 3, b + 1, a + 3, b + 3, b + 1);
    }

    VertexData.ComputeNormals(positions, indices, normals);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    return mesh;
  }

  const createBandageLayer = (
    layer: 1 | 2,
    zStart: number,
    color: string,
  ): Mesh[] => {
    const layerMaterial = material(
      scene,
      `bandage-layer-${layer}-material`,
      color,
      0.94,
    );

    const clearance = layer === 1
      ? BANDAGE_LAYER_1_CLEARANCE
      : BANDAGE_LAYER_2_CLEARANCE;

    return Array.from({ length: 10 }, (_, index) => {
      const zCenter = zStart - index * BANDAGE_STEP;
      const segment = createConformingBandSegment(
        scene,
        anatomySurface,
        `bandage-layer-${layer}-segment-${index + 1}`,
        zCenter,
        BANDAGE_WIDTH,
        BANDAGE_THICKNESS,
        clearance,
        BANDAGE_SAMPLE_COUNT,
      );

      segment.parent = root;
      segment.material = layerMaterial;
      segment.isPickable = false;
      segment.setEnabled(false);
      return segment;
    });
  };

  const bandageLayerSegments: Record<BandageId, Mesh[]> = {
    'bandage-1': [],
    'bandage-2': [],
  };

  const rebuildBandageLayers = () => {
    for (const id of ['bandage-1', 'bandage-2'] as const) {
      bandageLayerSegments[id].forEach((mesh) => mesh.dispose());
      bandageLayerSegments[id] = [];
    }

    bandageLayerSegments['bandage-1'] = createBandageLayer(
      1,
      BANDAGE_1_START_Z,
      '#eee3cb',
    );

    bandageLayerSegments['bandage-2'] = createBandageLayer(
      2,
      BANDAGE_2_START_Z,
      '#d8e8e5',
    );
  };

  // Build once against the fallback anatomy. When the GLB arrives, both the wound
  // anchor and all 20 bandage segments are rebuilt against the real mesh.
  syncTreatmentVisual();
  rebuildBandageLayers();

  const modelUrl = `${import.meta.env.BASE_URL}models/`;
  void SceneLoader.ImportMeshAsync('', modelUrl, 'lower-leg-left.glb', scene)
    .then((result) => {
      const legVisualRoot = new TransformNode('lower-leg-visual-root', scene);
      legVisualRoot.parent = root;

      // Pose já validada visualmente: mantém o membro sobre a estação,
      // com escala adequada e o eixo longitudinal apontando para dentro da mesa.
      legVisualRoot.position.set(-0.09, 0.085, 0.180);
      legVisualRoot.rotation.set(Math.PI / 2, 0, Math.PI);
      legVisualRoot.scaling.setAll(0.38);

      const legRoot = result.meshes[0];
      legRoot.parent = legVisualRoot;

      result.meshes.forEach((mesh) => {
        mesh.isPickable = false;
      });

      const anatomyMeshes = result.meshes.filter(
        (mesh) => mesh.getTotalVertices() > 0,
      );

      if (!anatomyMeshes.length) {
        throw new Error('O GLB não contém malhas anatômicas utilizáveis.');
      }

      // O GLB possui um origin/pivô deslocado em relação ao centro geométrico.
      // Girar diretamente o root em Y fazia o membro orbitar esse origin e sair
      // da estação. Calculamos o centro agregado da anatomia no espaço local do
      // legVisualRoot e fazemos o flip de 180° ao redor DESSE centro.
      legVisualRoot.computeWorldMatrix(true);
      result.meshes.forEach((mesh) => mesh.computeWorldMatrix(true));

      const inverseVisualWorld = Matrix.Invert(legVisualRoot.getWorldMatrix());
      const boundsMin = new Vector3(
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
        Number.POSITIVE_INFINITY,
      );
      const boundsMax = new Vector3(
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
        Number.NEGATIVE_INFINITY,
      );

      for (const mesh of anatomyMeshes) {
        const corners = mesh.getBoundingInfo().boundingBox.vectorsWorld;
        for (const corner of corners) {
          const local = Vector3.TransformCoordinates(corner, inverseVisualWorld);
          boundsMin.x = Math.min(boundsMin.x, local.x);
          boundsMin.y = Math.min(boundsMin.y, local.y);
          boundsMin.z = Math.min(boundsMin.z, local.z);
          boundsMax.x = Math.max(boundsMax.x, local.x);
          boundsMax.y = Math.max(boundsMax.y, local.y);
          boundsMax.z = Math.max(boundsMax.z, local.z);
        }
      }

      const anatomyCenter = boundsMin.add(boundsMax).scale(0.5);
      const originalLegRootPosition = legRoot.position.clone();

      const legOrientationRoot = new TransformNode(
        'lower-leg-orientation-root',
        scene,
      );
      legOrientationRoot.parent = legVisualRoot;
      legOrientationRoot.position.copyFrom(anatomyCenter);

      // Insere o novo pivot sem deslocar a pose original antes do flip.
      legRoot.parent = legOrientationRoot;
      legRoot.position.copyFrom(originalLegRootPosition.subtract(anatomyCenter));

      // O eixo longitudinal original do asset é Y. Girar 180° em Y troca
      // anterior/posterior (corrige o membro "de ponta cabeça") sem inverter
      // joelho ↔ extremidade distal. Como o pivot está no centro agregado,
      // a correção não arrasta o modelo para fora da estação.
      legOrientationRoot.rotation.y = Math.PI;

      legOrientationRoot.computeWorldMatrix(true);
      result.meshes.forEach((mesh) => mesh.computeWorldMatrix(true));

      anatomySurface.setMeshes(anatomyMeshes);
      syncTreatmentVisual();
      rebuildBandageLayers();

      lowerLeg.setEnabled(false);
      ankle.setEnabled(false);
      foot.setEnabled(false);
    })
    .catch((error) => {
      console.warn('Falha ao carregar modelo 3D da perna. Mantendo anatomia provisória.', error);
      anatomySurface.setMeshes([lowerLeg, ankle, foot]);
      syncTreatmentVisual();
      rebuildBandageLayers();
      lowerLeg.setEnabled(true);
      ankle.setEnabled(true);
      foot.setEnabled(true);
    });

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

  // X/Z remain the semantic gameplay anchors. Their final visual Y is sampled
  // from AnatomySurface when an object snaps or is moved over the body.
  const treatmentSnap = new Vector3(
    TREATMENT_VISUAL_X,
    TREATMENT_MANIPULATION_SURFACE.height + 0.012,
    TREATMENT_VISUAL_Z,
  );
  const solutionZone = new Vector3(
    treatmentSnap.x,
    TREATMENT_MANIPULATION_SURFACE.height + 0.065,
    treatmentSnap.z,
  );
  const tapeZones: TapeZones = {
    sideA: new Vector3(-0.145, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    center: new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    sideB: new Vector3(-0.035, TREATMENT_MANIPULATION_SURFACE.height, treatmentSnap.z),
    halfWidth: 0.018,
    halfDepth: 0.042,
  };
  const tapeSnap = new Vector3(
    TREATMENT_VISUAL_X,
    TREATMENT_MANIPULATION_SURFACE.height + 0.022,
    TREATMENT_VISUAL_Z,
  );
  const bandageZones: BandageZones = {
    right: new Vector3(-0.005, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    center: new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    left: new Vector3(-0.175, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    halfWidth: 0.023,
    halfDepth: 0.06,
  };
  const bandageRestartPoses: Record<BandageId, Vector3> = {
    'bandage-1': new Vector3(
      bandageZones.right.x,
      TREATMENT_MANIPULATION_SURFACE.height + 0.035,
      bandageZones.right.z,
    ),
    'bandage-2': new Vector3(
      bandageZones.right.x,
      TREATMENT_MANIPULATION_SURFACE.height + 0.043,
      bandageZones.right.z,
    ),
  };

  return {
    root,
    anatomySurface,
    placementIndicator: indicator,
    pickables,
    treatmentSurface: treatment,
    treatmentSnap,
    solutionZone,
    tapeZones,
    tapeSnap,
    bandageZones,
    bandageRestartPoses,
    bandageLayerSegments,
    resetObjects,
  };
}
