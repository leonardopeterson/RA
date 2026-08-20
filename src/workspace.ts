import {
  AbstractMesh,
  type AssetContainer,
  Color3,
  Matrix,
  Mesh,
  MeshBuilder,
  Node,
  PBRMaterial,
  Scene,
  SceneLoader,
  StandardMaterial,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import { OBJECT_INITIAL_POSES, type BandageId, type ObjectId } from './activity';
import {
  AnatomySurface,
  rotationFromUpToNormal,
  type HorizontalAxis,
  type SurfaceSample,
} from './anatomySurface';

export const WORKSPACE = {
  halfWidth: 0.28,
  halfDepth: 0.20,
  surfaceY: 0.026,
} as const;

const MODEL_ROOT = `${import.meta.env.BASE_URL}models/`;
const MODELS = {
  anatomy: 'lower-leg-left.glb',
  gauze: 'gauze_10x10cm.glb',
  tapeRoll: 'tape_roll_medical.glb',
  medicineJar: 'old_medicine_jar.glb',
  metalTray: 'metal_tray.glb',
  bandageRoll: 'a_roll_of_gauze.glb',
} as const;

const BANDAGE_SAMPLE_COUNT = 50;
const BANDAGE_WIDTH = 0.045;
const BANDAGE_THICKNESS = 0.0018;
const BANDAGE_OVERLAP_RATIO = 0.55;
const BANDAGE_LAYER_1_CLEARANCE = 0.0055;
const BANDAGE_LAYER_2_CLEARANCE = 0.0080;
const BANDAGE_DISTAL_START_FRACTION = 0.14;

const TREATMENT_FROM_DISTAL_FRACTION = 0.30;
const WOUND_SURFACE_OFFSET = 0.0006;
const WOUND_RADIUS = 0.016;
const WOUND_HALO_DIAMETER = 0.046;

const GAUZE_TARGET_SIZE = 0.055;
const TAPE_ROLL_TARGET_SIZE = 0.048;
const BANDAGE_ROLL_TARGET_SIZE = 0.054;
const MEDICINE_JAR_TARGET_HEIGHT = 0.105;
const METAL_TRAY_TARGET_FOOTPRINT = 0.255;

const TAPE_STRIP_HALF_LATERAL = 0.038;
const TAPE_STRIP_HALF_LONGITUDINAL = 0.032;
const TAPE_STRIP_WIDTH = 0.009;
const TAPE_STRIP_CLEARANCE_A = 0.0042;
const TAPE_STRIP_CLEARANCE_B = 0.0049;
const TAPE_STRIP_SAMPLES = 15;

// A região lógica continua independente da malha visual. Ela existe para preservar
// a semântica do gameplay e os pré-requisitos já implementados na Activity.
export const TREATMENT_MANIPULATION_SURFACE = {
  centerX: -0.09,
  centerZ: 0.045,
  height: 0.159,
  radius: 0.073,
  halfStraightLength: 0.09,
} as const;

export type TapeDiagonal = 'diagA' | 'diagB';

export interface TapeApplicationArea {
  center: Vector3;
  lateralAxis: HorizontalAxis;
  longitudinalAxis: HorizontalAxis;
  halfLateral: number;
  halfLongitudinal: number;
  minCrossLateral: number;
  minCrossLongitudinal: number;
  minStartLateral: number;
  minStartLongitudinal: number;
}

export interface BandageZones {
  right: Vector3;
  center: Vector3;
  left: Vector3;
  lateralAxis: HorizontalAxis;
  longitudinalAxis: HorizontalAxis;
  centerLateral: number;
  leftTrigger: number;
  rightTrigger: number;
  centerTolerance: number;
  longitudinalCenter: number;
  longitudinalTolerance: number;
  backHideHalfSpan: number;
}

export interface Workspace {
  root: TransformNode;
  anatomySurface: AnatomySurface;
  anatomyReady: Promise<void>;
  placementIndicator: Mesh;
  pickables: Map<ObjectId, AbstractMesh>;
  treatmentSurface: Mesh;
  treatmentSnap: Vector3;
  solutionZone: Vector3;
  tapeApplicationArea: TapeApplicationArea;
  tapeAppliedStrips: Record<TapeDiagonal, Mesh>;
  bandageZones: BandageZones;
  bandageRestartPoses: Record<BandageId, Vector3>;
  bandageLayerSegments: Record<BandageId, Mesh[]>;
  resetTapeStrips(): void;
  resetObjects(): void;
}

type AssetOrientation = 'flat' | 'upright' | 'roll-side' | 'none';
type AssetAlignment = 'center' | 'base';
type AssetMetric = 'max' | 'height' | 'footprint';

interface AssetVisualOptions {
  orientation: AssetOrientation;
  alignment: AssetAlignment;
  metric: AssetMetric;
  targetSize: number;
  pickable: boolean;
}

interface Bounds {
  min: Vector3;
  max: Vector3;
  size: Vector3;
  center: Vector3;
}

function material(
  scene: Scene,
  name: string,
  color: string,
  roughness = 0.72,
): PBRMaterial {
  const mat = new PBRMaterial(name, scene);
  mat.albedoColor = Color3.FromHexString(color);
  mat.roughness = roughness;
  mat.metallic = 0;
  return mat;
}

function setObjectId(root: AbstractMesh, id: ObjectId): void {
  root.metadata = { objectId: id };
  root.isPickable = false;
}

function axisOfSmallest(size: Vector3): 'x' | 'y' | 'z' {
  if (size.x <= size.y && size.x <= size.z) return 'x';
  if (size.y <= size.x && size.y <= size.z) return 'y';
  return 'z';
}

function axisOfLargest(size: Vector3): 'x' | 'y' | 'z' {
  if (size.x >= size.y && size.x >= size.z) return 'x';
  if (size.y >= size.x && size.y >= size.z) return 'y';
  return 'z';
}

function boundsRelativeTo(meshes: AbstractMesh[], relativeTo: TransformNode): Bounds {
  relativeTo.computeWorldMatrix(true);
  const inverse = Matrix.Invert(relativeTo.getWorldMatrix());
  const min = new Vector3(
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
    Number.POSITIVE_INFINITY,
  );
  const max = new Vector3(
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
  );

  for (const mesh of meshes) {
    if (mesh.getTotalVertices() <= 0) continue;
    mesh.computeWorldMatrix(true);
    for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
      const point = Vector3.TransformCoordinates(corner, inverse);
      min.x = Math.min(min.x, point.x);
      min.y = Math.min(min.y, point.y);
      min.z = Math.min(min.z, point.z);
      max.x = Math.max(max.x, point.x);
      max.y = Math.max(max.y, point.y);
      max.z = Math.max(max.z, point.z);
    }
  }

  const size = max.subtract(min);
  return { min, max, size, center: min.add(max).scale(0.5) };
}

function applyAutomaticOrientation(
  contentRoot: TransformNode,
  rawSize: Vector3,
  orientation: AssetOrientation,
): void {
  contentRoot.rotation.set(0, 0, 0);
  if (orientation === 'none') return;

  if (orientation === 'flat') {
    const smallest = axisOfSmallest(rawSize);
    if (smallest === 'x') contentRoot.rotation.z = Math.PI / 2;
    else if (smallest === 'z') contentRoot.rotation.x = -Math.PI / 2;
    return;
  }

  if (orientation === 'upright') {
    const largest = axisOfLargest(rawSize);
    if (largest === 'x') contentRoot.rotation.z = Math.PI / 2;
    else if (largest === 'z') contentRoot.rotation.x = -Math.PI / 2;
    return;
  }

  // Para rolos queremos o eixo de menor dimensão aproximadamente horizontal em X,
  // deixando a face circular visível e evitando um cilindro "em pé" sobre a bandeja.
  const smallest = axisOfSmallest(rawSize);
  if (smallest === 'y') contentRoot.rotation.z = -Math.PI / 2;
  else if (smallest === 'z') contentRoot.rotation.y = Math.PI / 2;
}

async function attachNormalizedGlb(
  scene: Scene,
  logicalRoot: TransformNode,
  filename: string,
  options: AssetVisualOptions,
): Promise<AbstractMesh[]> {
  const result = await SceneLoader.ImportMeshAsync('', MODEL_ROOT, filename, scene);
  const visualMeshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
  if (!visualMeshes.length) throw new Error(`${filename} não possui malhas renderizáveis.`);

  const importedNodes: Node[] = [...result.meshes, ...result.transformNodes];
  const importedSet = new Set(importedNodes);
  const topLevelNodes = importedNodes.filter((node) => !node.parent || !importedSet.has(node.parent));

  return attachNormalizedNodes(
    scene,
    logicalRoot,
    filename,
    options,
    topLevelNodes,
    visualMeshes,
  );
}

function attachNormalizedContainerInstance(
  scene: Scene,
  logicalRoot: TransformNode,
  container: AssetContainer,
  filename: string,
  options: AssetVisualOptions,
): AbstractMesh[] {
  const instance = container.instantiateModelsToScene(
    (name) => `${logicalRoot.name}-${name}`,
    false,
    { doNotInstantiate: true },
  );
  const visualMeshes = Array.from(new Set(instance.rootNodes.flatMap((node) => {
    const meshes = node instanceof AbstractMesh ? [node] : [];
    return [...meshes, ...node.getChildMeshes(false)];
  }))).filter((mesh) => mesh.getTotalVertices() > 0);

  if (!visualMeshes.length) throw new Error(`${filename} não possui malhas renderizáveis.`);
  return attachNormalizedNodes(
    scene,
    logicalRoot,
    filename,
    options,
    instance.rootNodes,
    visualMeshes,
  );
}

function attachNormalizedNodes(
  scene: Scene,
  logicalRoot: TransformNode,
  filename: string,
  options: AssetVisualOptions,
  topLevelNodes: Node[],
  visualMeshes: AbstractMesh[],
): AbstractMesh[] {

  const contentRoot = new TransformNode(`${filename}-visual-root`, scene);
  contentRoot.parent = logicalRoot;

  for (const node of topLevelNodes) node.parent = contentRoot;

  for (const mesh of visualMeshes) mesh.isPickable = options.pickable;

  const rawBounds = boundsRelativeTo(visualMeshes, contentRoot);
  applyAutomaticOrientation(contentRoot, rawBounds.size, options.orientation);
  contentRoot.computeWorldMatrix(true);
  visualMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));

  let orientedBounds = boundsRelativeTo(visualMeshes, logicalRoot);
  const denominator = options.metric === 'height'
    ? orientedBounds.size.y
    : options.metric === 'footprint'
      ? Math.max(orientedBounds.size.x, orientedBounds.size.z)
      : Math.max(orientedBounds.size.x, orientedBounds.size.y, orientedBounds.size.z);

  if (!Number.isFinite(denominator) || denominator <= 1e-6) {
    throw new Error(`Não foi possível normalizar a escala de ${filename}.`);
  }

  contentRoot.scaling.setAll(options.targetSize / denominator);
  contentRoot.computeWorldMatrix(true);
  visualMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));
  orientedBounds = boundsRelativeTo(visualMeshes, logicalRoot);

  if (options.alignment === 'base') {
    contentRoot.position.addInPlace(new Vector3(
      -orientedBounds.center.x,
      -orientedBounds.min.y,
      -orientedBounds.center.z,
    ));
  } else {
    contentRoot.position.subtractInPlace(orientedBounds.center);
  }

  contentRoot.computeWorldMatrix(true);
  visualMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));
  return visualMeshes;
}

function cloneSection(section: SurfaceSample[]): SurfaceSample[] {
  return section.map((sample) => ({
    point: sample.point.clone(),
    normal: sample.normal.clone(),
  }));
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

  // A bandeja tem um fallback simples e é substituída pelo GLB assim que o asset carrega.
  const trayRoot = new TransformNode('instrument-tray-root', scene);
  trayRoot.parent = root;
  trayRoot.position.set(0.16, WORKSPACE.surfaceY + 0.002, 0.0);
  const trayFallback = MeshBuilder.CreateBox(
    'instrument-tray-fallback',
    { width: 0.22, depth: 0.28, height: 0.010 },
    scene,
  );
  trayFallback.parent = trayRoot;
  trayFallback.position.y = 0.005;
  trayFallback.material = material(scene, 'tray-fallback-material', '#829b94', 0.35);
  trayFallback.isPickable = false;

  void attachNormalizedGlb(scene, trayRoot, MODELS.metalTray, {
    orientation: 'flat',
    alignment: 'base',
    metric: 'footprint',
    targetSize: METAL_TRAY_TARGET_FOOTPRINT,
    pickable: false,
  }).then(() => trayFallback.setEnabled(false)).catch((error) => {
    console.warn('Falha ao carregar metal_tray.glb; usando bandeja provisória.', error);
  });

  // Anatomia provisória: somente perna/tornozelo, sem o antigo pé em caixa.
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

  lowerLeg.setEnabled(false);
  ankle.setEnabled(false);

  const treatmentVisualAnchor = new TransformNode('treatment-visual-anchor', scene);
  treatmentVisualAnchor.parent = root;

  const treatment = MeshBuilder.CreateDisc(
    'TreatmentInteractionSurface',
    { radius: WOUND_RADIUS, tessellation: 48 },
    scene,
  );
  treatment.parent = treatmentVisualAnchor;
  treatment.rotation.x = Math.PI / 2;
  treatment.material = material(scene, 'treatment-material', '#9f414b', 0.86);
  treatment.isPickable = false;

  const halo = MeshBuilder.CreateTorus(
    'treatment-halo',
    { diameter: WOUND_HALO_DIAMETER, thickness: 0.0022, tessellation: 48 },
    scene,
  );
  halo.parent = treatmentVisualAnchor;
  halo.rotation.x = Math.PI / 2;
  halo.position.y = 0.0008;
  const haloMat = new StandardMaterial('halo-material', scene);
  haloMat.emissiveColor = new Color3(0.25, 1, 0.68);
  haloMat.alpha = 0.24;
  halo.material = haloMat;
  halo.isPickable = false;

  // Roots lógicos permanecem estáveis. Os GLBs são apenas visuais filhos deles,
  // portanto Activity/Interaction continuam trabalhando com os mesmos ObjectIds.
  const debrisoft = MeshBuilder.CreateCylinder(
    'debrisoft-pad',
    { diameter: 0.060, height: 0.010, tessellation: 32 },
    scene,
  );
  debrisoft.parent = root;
  debrisoft.material = material(scene, 'debrisoft-material', '#d9f2ef');
  setObjectId(debrisoft, 'debrisoft-pad');
  debrisoft.isPickable = true;

  const bottle = new Mesh('solution-bottle', scene);
  bottle.parent = root;
  setObjectId(bottle, 'solution-bottle');
  const bottleFallbackBody = MeshBuilder.CreateCylinder(
    'solution-bottle-fallback-body',
    { height: 0.105, diameter: 0.042, tessellation: 24 },
    scene,
  );
  bottleFallbackBody.parent = bottle;
  bottleFallbackBody.position.y = 0.0525;
  bottleFallbackBody.material = material(scene, 'bottle-fallback-material', '#69a9bd', 0.3);
  bottleFallbackBody.isPickable = true;
  const bottleFallbackCap = MeshBuilder.CreateCylinder(
    'solution-bottle-fallback-cap',
    { height: 0.024, diameter: 0.025, tessellation: 20 },
    scene,
  );
  bottleFallbackCap.parent = bottle;
  bottleFallbackCap.position.y = 0.116;
  bottleFallbackCap.material = material(scene, 'cap-fallback-material', '#e8f5f2', 0.4);
  bottleFallbackCap.isPickable = true;

  const gauze = new Mesh('gauze', scene);
  gauze.parent = root;
  setObjectId(gauze, 'gauze');
  const gauzeFallback = MeshBuilder.CreateBox(
    'gauze-fallback',
    { width: GAUZE_TARGET_SIZE, depth: GAUZE_TARGET_SIZE * 0.90, height: 0.0022 },
    scene,
  );
  gauzeFallback.parent = gauze;
  gauzeFallback.material = material(scene, 'gauze-fallback-material', '#fbfcf8');
  gauzeFallback.isPickable = true;

  // O ObjectId histórico continua "tape-strip" para não exigir alteração em Activity,
  // mas o objeto manipulável agora é o rolo de esparadrapo.
  const tapeRoll = new Mesh('tape-strip', scene);
  tapeRoll.parent = root;
  setObjectId(tapeRoll, 'tape-strip');
  const tapeFallback = MeshBuilder.CreateTorus(
    'tape-roll-fallback',
    { diameter: 0.046, thickness: 0.012, tessellation: 32 },
    scene,
  );
  tapeFallback.parent = tapeRoll;
  tapeFallback.rotation.z = Math.PI / 2;
  tapeFallback.material = material(scene, 'tape-roll-fallback-material', '#f4f3ee', 0.90);
  tapeFallback.isPickable = true;

  const bandage1 = new Mesh('bandage-1', scene);
  bandage1.parent = root;
  setObjectId(bandage1, 'bandage-1');
  const bandage1Fallback = MeshBuilder.CreateTorus(
    'bandage-1-fallback',
    { diameter: 0.050, thickness: 0.015, tessellation: 32 },
    scene,
  );
  bandage1Fallback.parent = bandage1;
  bandage1Fallback.rotation.z = Math.PI / 2;
  bandage1Fallback.material = material(scene, 'bandage-roll-fallback-material', '#f0e6cf', 0.9);
  bandage1Fallback.isPickable = true;

  const bandage2 = new Mesh('bandage-2', scene);
  bandage2.parent = root;
  setObjectId(bandage2, 'bandage-2');
  const bandage2Fallback = MeshBuilder.CreateTorus(
    'bandage-2-fallback',
    { diameter: 0.052, thickness: 0.015, tessellation: 32 },
    scene,
  );
  bandage2Fallback.parent = bandage2;
  bandage2Fallback.rotation.z = Math.PI / 2;
  bandage2Fallback.material = material(scene, 'bandage-roll-2-fallback-material', '#d9e7e5', 0.9);
  bandage2Fallback.isPickable = true;

  const pickables = new Map<ObjectId, AbstractMesh>([
    ['debrisoft-pad', debrisoft],
    ['solution-bottle', bottle],
    ['gauze', gauze],
    ['tape-strip', tapeRoll],
    ['bandage-1', bandage1],
    ['bandage-2', bandage2],
  ]);

  void attachNormalizedGlb(scene, bottle, MODELS.medicineJar, {
    orientation: 'upright',
    alignment: 'base',
    metric: 'height',
    targetSize: MEDICINE_JAR_TARGET_HEIGHT,
    pickable: true,
  }).then(() => {
    bottleFallbackBody.setEnabled(false);
    bottleFallbackCap.setEnabled(false);
  }).catch((error) => {
    console.warn('Falha ao carregar old_medicine_jar.glb; usando frasco provisório.', error);
  });

  void attachNormalizedGlb(scene, gauze, MODELS.gauze, {
    orientation: 'flat',
    alignment: 'center',
    metric: 'footprint',
    targetSize: GAUZE_TARGET_SIZE,
    pickable: true,
  }).then(() => gauzeFallback.setEnabled(false)).catch((error) => {
    console.warn('Falha ao carregar gauze_10x10cm.glb; usando gaze provisória.', error);
  });

  void attachNormalizedGlb(scene, tapeRoll, MODELS.tapeRoll, {
    orientation: 'roll-side',
    alignment: 'center',
    metric: 'max',
    targetSize: TAPE_ROLL_TARGET_SIZE,
    pickable: true,
  }).then(() => tapeFallback.setEnabled(false)).catch((error) => {
    console.warn('Falha ao carregar tape_roll_medical.glb; usando rolo provisório.', error);
  });

  void SceneLoader.LoadAssetContainerAsync(MODEL_ROOT, MODELS.bandageRoll, scene)
    .then((container) => {
      const options: AssetVisualOptions = {
        orientation: 'roll-side',
        alignment: 'center',
        metric: 'max',
        targetSize: BANDAGE_ROLL_TARGET_SIZE,
        pickable: true,
      };
      attachNormalizedContainerInstance(
        scene,
        bandage1,
        container,
        `${MODELS.bandageRoll}-bandage-1`,
        options,
      );
      attachNormalizedContainerInstance(
        scene,
        bandage2,
        container,
        `${MODELS.bandageRoll}-bandage-2`,
        options,
      );
      bandage1Fallback.setEnabled(false);
      bandage2Fallback.setEnabled(false);
    })
    .catch((error) => {
      console.warn('Falha ao carregar a_roll_of_gauze.glb; usando rolos provisórios.', error);
    });

  // Âncoras mutáveis: Interaction mantém as mesmas referências e recebe as posições
  // recalculadas quando o GLB anatômico real termina de carregar.
  const treatmentSnap = new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.055);
  const solutionZone = treatmentSnap.add(new Vector3(0, 0.065, 0));

  const tapeApplicationArea: TapeApplicationArea = {
    center: treatmentSnap.clone(),
    lateralAxis: 'x',
    longitudinalAxis: 'z',
    halfLateral: 0.060,
    halfLongitudinal: 0.052,
    minCrossLateral: 0.045,
    minCrossLongitudinal: 0.026,
    minStartLateral: 0.018,
    minStartLongitudinal: 0.012,
  };

  const bandageZones: BandageZones = {
    right: new Vector3(-0.005, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    center: new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    left: new Vector3(-0.175, TREATMENT_MANIPULATION_SURFACE.height, 0.02),
    lateralAxis: 'x',
    longitudinalAxis: 'z',
    centerLateral: -0.09,
    leftTrigger: -0.17,
    rightTrigger: -0.01,
    centerTolerance: 0.035,
    longitudinalCenter: 0.02,
    longitudinalTolerance: 0.135,
    backHideHalfSpan: 0.060,
  };

  const bandageRestartPoses: Record<BandageId, Vector3> = {
    'bandage-1': bandageZones.right.add(new Vector3(0, 0.035, 0)),
    'bandage-2': bandageZones.right.add(new Vector3(0, 0.043, 0)),
  };

  const tapeMaterial = material(scene, 'applied-tape-material', '#f7f7f2', 0.92);
  let tapeAppliedStrips: Record<TapeDiagonal, Mesh> = {
    diagA: new Mesh('tape-applied-diag-a-placeholder', scene),
    diagB: new Mesh('tape-applied-diag-b-placeholder', scene),
  };
  tapeAppliedStrips.diagA.parent = root;
  tapeAppliedStrips.diagB.parent = root;
  tapeAppliedStrips.diagA.setEnabled(false);
  tapeAppliedStrips.diagB.setEnabled(false);

  const bandageLayerSegments: Record<BandageId, Mesh[]> = {
    'bandage-1': [],
    'bandage-2': [],
  };

  function createConformingTapeStrip(
    name: string,
    diagonal: TapeDiagonal,
    clearance: number,
  ): Mesh {
    const frame = anatomySurface.frame;
    if (!frame) return new Mesh(name, scene);

    const center = treatmentSnap.clone();
    const lateralBasis = anatomySurface.lateralBasis();
    const longitudinalBasis = anatomySurface.longitudinalBasis();
    const sign = diagonal === 'diagA' ? 1 : -1;

    const halfLateral = Math.min(TAPE_STRIP_HALF_LATERAL, frame.width * 0.40);
    const halfLongitudinal = Math.min(TAPE_STRIP_HALF_LONGITUDINAL, frame.length * 0.10);
    const tangent = lateralBasis.scale(halfLateral)
      .add(longitudinalBasis.scale(sign * halfLongitudinal))
      .normalize();
    const horizontalPerpendicular = Vector3.Cross(Vector3.Up(), tangent).normalize();

    const positions: number[] = [];
    const indices: number[] = [];
    const normals: number[] = [];
    const uvs: number[] = [];

    for (let i = 0; i < TAPE_STRIP_SAMPLES; i++) {
      const t = i / (TAPE_STRIP_SAMPLES - 1);
      const signed = t * 2 - 1;
      const horizontalCenter = center
        .add(lateralBasis.scale(signed * halfLateral))
        .add(longitudinalBasis.scale(signed * sign * halfLongitudinal));

      const leftProbe = horizontalCenter.add(horizontalPerpendicular.scale(TAPE_STRIP_WIDTH / 2));
      const rightProbe = horizontalCenter.add(horizontalPerpendicular.scale(-TAPE_STRIP_WIDTH / 2));
      const centerSample = anatomySurface.sampleTopSurfaceClamped(horizontalCenter.x, horizontalCenter.z);
      const leftSample = anatomySurface.sampleTopSurfaceClamped(leftProbe.x, leftProbe.z) ?? centerSample;
      const rightSample = anatomySurface.sampleTopSurfaceClamped(rightProbe.x, rightProbe.z) ?? centerSample;
      if (!leftSample || !rightSample) continue;

      const left = leftSample.point.add(leftSample.normal.scale(clearance));
      const right = rightSample.point.add(rightSample.normal.scale(clearance));
      positions.push(left.x, left.y, left.z, right.x, right.y, right.z);
      uvs.push(0, t, 1, t);
    }

    const rowCount = positions.length / 6;
    if (rowCount < 2) return new Mesh(name, scene);

    for (let i = 0; i < rowCount - 1; i++) {
      const a = i * 2;
      const b = a + 2;
      indices.push(a, b, a + 1, a + 1, b, b + 1);
    }

    VertexData.ComputeNormals(positions, indices, normals);
    const mesh = new Mesh(name, scene);
    const vertexData = new VertexData();
    vertexData.positions = positions;
    vertexData.indices = indices;
    vertexData.normals = normals;
    vertexData.uvs = uvs;
    vertexData.applyToMesh(mesh);
    mesh.material = tapeMaterial;
    mesh.isPickable = false;
    return mesh;
  }

  function createConformingBandSegment(
    name: string,
    longitudinalCenter: number,
    width: number,
    thickness: number,
    clearance: number,
    samples = BANDAGE_SAMPLE_COUNT,
  ): Mesh {
    const edgeA = anatomySurface.offsetTowardProximal(longitudinalCenter, -width / 2);
    const edgeB = anatomySurface.offsetTowardProximal(longitudinalCenter, width / 2);
    let sectionA = anatomySurface.sampleCrossSectionAt(edgeA, samples);
    let sectionB = anatomySurface.sampleCrossSectionAt(edgeB, samples);

    if (!sectionA.length && sectionB.length) sectionA = cloneSection(sectionB);
    if (!sectionB.length && sectionA.length) sectionB = cloneSection(sectionA);

    // Não usamos mais um círculo genérico se o GLB estiver ativo: um segmento vazio
    // é preferível a uma faixa visualmente errada/flutuando ao redor da anatomia.
    if (sectionA.length !== samples || sectionB.length !== samples) {
      console.warn(`Não foi possível conformar ${name} à seção anatômica.`);
      return new Mesh(name, scene);
    }

    const mesh = new Mesh(name, scene);
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
    mesh.isPickable = false;
    return mesh;
  }

  const createBandageLayer = (layer: 1 | 2, color: string): Mesh[] => {
    const frame = anatomySurface.frame;
    if (!frame) return [];

    const layerMaterial = material(
      scene,
      `bandage-layer-${layer}-material`,
      color,
      0.94,
    );
    const clearance = layer === 1
      ? BANDAGE_LAYER_1_CLEARANCE
      : BANDAGE_LAYER_2_CLEARANCE;
    const step = BANDAGE_WIDTH * (1 - BANDAGE_OVERLAP_RATIO);
    const startDistance = Math.max(
      BANDAGE_WIDTH * 0.60,
      frame.length * BANDAGE_DISTAL_START_FRACTION,
    );
    const start = anatomySurface.coordinateFromDistalDistance(startDistance);

    return Array.from({ length: 10 }, (_, index) => {
      const center = anatomySurface.offsetTowardProximal(start, index * step);
      const segment = createConformingBandSegment(
        `bandage-layer-${layer}-segment-${index + 1}`,
        center,
        BANDAGE_WIDTH,
        BANDAGE_THICKNESS,
        clearance,
      );
      segment.parent = root;
      segment.material = layerMaterial;
      segment.setEnabled(false);
      return segment;
    });
  };

  const rebuildTapeStrips = () => {
    const previousA = tapeAppliedStrips.diagA.isEnabled();
    const previousB = tapeAppliedStrips.diagB.isEnabled();
    tapeAppliedStrips.diagA.dispose();
    tapeAppliedStrips.diagB.dispose();

    tapeAppliedStrips = {
      diagA: createConformingTapeStrip(
        'tape-applied-diag-a',
        'diagA',
        TAPE_STRIP_CLEARANCE_A,
      ),
      diagB: createConformingTapeStrip(
        'tape-applied-diag-b',
        'diagB',
        TAPE_STRIP_CLEARANCE_B,
      ),
    };
    tapeAppliedStrips.diagA.parent = root;
    tapeAppliedStrips.diagB.parent = root;
    tapeAppliedStrips.diagA.setEnabled(previousA);
    tapeAppliedStrips.diagB.setEnabled(previousB);
  };

  const rebuildBandageLayers = () => {
    const previousEnabled: Record<BandageId, boolean[]> = {
      'bandage-1': bandageLayerSegments['bandage-1'].map((mesh) => mesh.isEnabled()),
      'bandage-2': bandageLayerSegments['bandage-2'].map((mesh) => mesh.isEnabled()),
    };

    for (const id of ['bandage-1', 'bandage-2'] as const) {
      bandageLayerSegments[id].forEach((mesh) => mesh.dispose());
      bandageLayerSegments[id] = [];
    }

    bandageLayerSegments['bandage-1'] = createBandageLayer(1, '#eee3cb');
    bandageLayerSegments['bandage-2'] = createBandageLayer(2, '#d8e8e5');

    for (const id of ['bandage-1', 'bandage-2'] as const) {
      bandageLayerSegments[id].forEach((mesh, index) => {
        mesh.setEnabled(previousEnabled[id][index] ?? false);
      });
    }
  };

  const updateAnatomyDependentAnchors = () => {
    const frame = anatomySurface.frame;
    if (!frame) return;

    const treatmentSample = anatomySurface.sampleTopSurfaceAtDistalFraction(
      TREATMENT_FROM_DISTAL_FRACTION,
      0.50,
    );
    if (!treatmentSample) return;

    treatmentSnap.copyFrom(treatmentSample.point);
    solutionZone.copyFrom(treatmentSample.point.add(new Vector3(0, 0.065, 0)));
    treatmentVisualAnchor.position.copyFrom(
      treatmentSample.point.add(treatmentSample.normal.scale(WOUND_SURFACE_OFFSET)),
    );
    treatmentVisualAnchor.rotationQuaternion = rotationFromUpToNormal(treatmentSample.normal);

    tapeApplicationArea.center.copyFrom(treatmentSample.point);
    tapeApplicationArea.lateralAxis = frame.lateralAxis;
    tapeApplicationArea.longitudinalAxis = frame.longitudinalAxis;
    tapeApplicationArea.halfLateral = Math.max(0.050, Math.min(0.070, frame.width * 0.68));
    tapeApplicationArea.halfLongitudinal = Math.max(0.043, Math.min(0.060, frame.length * 0.16));
    tapeApplicationArea.minCrossLateral = tapeApplicationArea.halfLateral * 0.75;
    tapeApplicationArea.minCrossLongitudinal = tapeApplicationArea.halfLongitudinal * 0.55;

    const bandageStep = BANDAGE_WIDTH * (1 - BANDAGE_OVERLAP_RATIO);
    const bandageStartDistance = Math.max(
      BANDAGE_WIDTH * 0.60,
      frame.length * BANDAGE_DISTAL_START_FRACTION,
    );
    const bandageCenterLongitudinal = anatomySurface.coordinateFromDistalDistance(
      bandageStartDistance + bandageStep * 4.5,
    );
    const stats = anatomySurface.crossSectionStats(bandageCenterLongitudinal, 48);

    if (stats) {
      const sidePadding = Math.max(0.026, (stats.maxLateral - stats.minLateral) * 0.24);
      bandageZones.lateralAxis = frame.lateralAxis;
      bandageZones.longitudinalAxis = frame.longitudinalAxis;
      bandageZones.centerLateral = (stats.minLateral + stats.maxLateral) / 2;
      bandageZones.leftTrigger = stats.minLateral - sidePadding;
      bandageZones.rightTrigger = stats.maxLateral + sidePadding;
      bandageZones.centerTolerance = Math.max(
        0.028,
        (stats.maxLateral - stats.minLateral) * 0.28,
      );
      bandageZones.longitudinalCenter = bandageCenterLongitudinal;
      bandageZones.longitudinalTolerance = Math.max(
        0.115,
        BANDAGE_WIDTH + bandageStep * 5.5,
      );
      bandageZones.backHideHalfSpan = Math.max(
        0.050,
        (stats.maxLateral - stats.minLateral) * 0.58,
      );

      const centerPoint = anatomySurface.pointFromCoordinates(
        bandageZones.longitudinalCenter,
        bandageZones.centerLateral,
        stats.maxY,
      );
      const rightPoint = anatomySurface.pointFromCoordinates(
        bandageZones.longitudinalCenter,
        bandageZones.rightTrigger,
        stats.maxY,
      );
      const leftPoint = anatomySurface.pointFromCoordinates(
        bandageZones.longitudinalCenter,
        bandageZones.leftTrigger,
        stats.maxY,
      );
      bandageZones.center.copyFrom(centerPoint);
      bandageZones.right.copyFrom(rightPoint);
      bandageZones.left.copyFrom(leftPoint);

      bandageRestartPoses['bandage-1'].copyFrom(rightPoint.add(new Vector3(0, 0.040, 0)));
      bandageRestartPoses['bandage-2'].copyFrom(rightPoint.add(new Vector3(0, 0.044, 0)));
    }

    rebuildTapeStrips();
    rebuildBandageLayers();
  };

  const resetTapeStrips = () => {
    tapeAppliedStrips.diagA.setEnabled(false);
    tapeAppliedStrips.diagB.setEnabled(false);
  };

  const resetObjects = () => {
    for (const [id, mesh] of pickables) {
      const pose = OBJECT_INITIAL_POSES[id];
      mesh.position.set(...pose.position);
      mesh.rotationQuaternion = null;
      mesh.rotation.set(...pose.rotation);
      mesh.visibility = 1;
      mesh.setEnabled(true);
    }
    resetTapeStrips();
  };

  let legVisualRoot: TransformNode | undefined;
  const anatomyReady = SceneLoader.ImportMeshAsync('', MODEL_ROOT, MODELS.anatomy, scene)
    .then((result) => {
      legVisualRoot = new TransformNode('lower-leg-visual-root', scene);
      legVisualRoot.parent = root;

      // Transformação já validada visualmente durante a calibração anterior.
      legVisualRoot.position.set(-0.09, 0.085, 0.180);
      legVisualRoot.rotation.set(Math.PI / 2, 0, Math.PI);
      legVisualRoot.scaling.setAll(0.38);

      const legRoot = result.meshes[0];
      legRoot.parent = legVisualRoot;
      result.meshes.forEach((mesh) => { mesh.isPickable = false; });

      const anatomyMeshes = result.meshes.filter((mesh) => mesh.getTotalVertices() > 0);
      if (!anatomyMeshes.length) {
        throw new Error('O GLB não contém malhas anatômicas utilizáveis.');
      }

      // O asset tem o pivot deslocado. Inserimos um pivot no centro geométrico antes
      // do flip de 180°, evitando que a perna orbite para fora da estação.
      legVisualRoot.computeWorldMatrix(true);
      anatomyMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));
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
        for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
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
      const legOrientationRoot = new TransformNode('lower-leg-orientation-root', scene);
      legOrientationRoot.parent = legVisualRoot;
      legOrientationRoot.position.copyFrom(anatomyCenter);
      legRoot.parent = legOrientationRoot;
      legRoot.position.copyFrom(originalLegRootPosition.subtract(anatomyCenter));
      legOrientationRoot.rotation.y = Math.PI;

      legOrientationRoot.computeWorldMatrix(true);
      anatomyMeshes.forEach((mesh) => mesh.computeWorldMatrix(true));
      return anatomyMeshes;
    })
    .catch((error) => {
      console.warn('Falha ao carregar lower-leg-left.glb; usando anatomia provisória.', error);
      legVisualRoot?.dispose(false, true);
      legVisualRoot = undefined;
      lowerLeg.setEnabled(true);
      ankle.setEnabled(true);
      return [lowerLeg, ankle];
    })
    .then((anatomyMeshes) => {
      anatomySurface.setMeshes(anatomyMeshes);
      updateAnatomyDependentAnchors();
    });

  resetObjects();
  root.setEnabled(false);

  return {
    root,
    anatomySurface,
    anatomyReady,
    placementIndicator: indicator,
    pickables,
    treatmentSurface: treatment,
    treatmentSnap,
    solutionZone,
    tapeApplicationArea,
    get tapeAppliedStrips() {
      return tapeAppliedStrips;
    },
    bandageZones,
    bandageRestartPoses,
    bandageLayerSegments,
    resetTapeStrips,
    resetObjects,
  };
}
