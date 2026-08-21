import {
  AbstractMesh,
  type AssetContainer,
  Color3,
  DynamicTexture,
  Matrix,
  Mesh,
  MeshBuilder,
  Node,
  PBRMaterial,
  Scene,
  SceneLoader,
  StandardMaterial,
  Texture,
  TransformNode,
  Vector3,
  VertexData,
} from '@babylonjs/core';
import {
  OBJECT_INITIAL_POSES,
  type ActivityObjectState,
  type BandageId,
  type ObjectId,
} from './activity';
import {
  AnatomySurface,
  type HorizontalAxis,
  type SurfaceSample,
} from './anatomySurface';
import { AppliedSurfaceSystem } from './appliedSurface';
import { SupportSurfaceSystem } from './supportSurface';

export const WORKSPACE = {
  halfWidth: 0.28,
  halfDepth: 0.20,
  surfaceY: 0.026,
} as const;

export type GameMode = 'inventory' | 'tabletop';

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
const WOUND_RADIUS = 0.016;
const WOUND_HALO_DIAMETER = 0.046;
const APPLIED_LAYER_CLEARANCE = 0.00030;
const layerAbove = (
  previous: { base: number; thickness: number },
  thickness: number,
) => ({
  base: previous.base + previous.thickness + APPLIED_LAYER_CLEARANCE,
  thickness,
});
const WOUND_LAYER = { base: 0.0006, thickness: 0 } as const;
const GAUZE_LAYER = layerAbove(WOUND_LAYER, 0.0012);
const TAPE_A_LAYER = layerAbove(GAUZE_LAYER, 0.00065);
const TAPE_B_LAYER = layerAbove(TAPE_A_LAYER, 0.00065);
const APPLIED_LAYERS = {
  wound: WOUND_LAYER,
  gauze: GAUZE_LAYER,
  tapeA: TAPE_A_LAYER,
  tapeB: TAPE_B_LAYER,
} as const;

const GAUZE_TARGET_SIZE = 0.055;
const TAPE_ROLL_TARGET_SIZE = 0.048 * 1.5;
const BANDAGE_ROLL_TARGET_SIZE = 0.054 * 2;
const MEDICINE_JAR_TARGET_HEIGHT = 0.105;
const METAL_TRAY_TARGET_FOOTPRINT = 0.255 * 1.5;

const TAPE_ROLL_RAW_DIAMETER = 0.15019;
const TAPE_ROLL_RAW_WIDTH = 0.04542;
const TAPE_STRIP_LENGTH = 0.070;
const TAPE_STRIP_WIDTH = TAPE_ROLL_TARGET_SIZE
  * (TAPE_ROLL_RAW_WIDTH / TAPE_ROLL_RAW_DIAMETER);

// A região lógica continua independente da malha visual. Ela existe para preservar
// a semântica do gameplay e os pré-requisitos já implementados na Activity.
export const TREATMENT_MANIPULATION_SURFACE = {
  centerX: -0.09,
  centerZ: 0.045,
  height: 0.159,
  radius: 0.073,
  halfStraightLength: 0.09,
} as const;

export type TapeStripId = 'lateral' | 'longitudinal';

export interface TapeApplicationArea {
  center: Vector3;
  lateralAxis: HorizontalAxis;
  longitudinalAxis: HorizontalAxis;
  halfLateral: number;
  minCrossLateral: number;
  passHalfWidth: number;
  minStartLateral: number;
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
  supportSurface: SupportSurfaceSystem;
  supportReady: Promise<void>;
  readonly gameMode: GameMode;
  placementIndicator: Mesh;
  pickables: Map<ObjectId, AbstractMesh>;
  treatmentSurface: Mesh;
  treatmentSnap: Vector3;
  solutionZone: Vector3;
  solutionPourPivot: TransformNode;
  tapeApplicationArea: TapeApplicationArea;
  tapeAppliedStrips: Record<TapeStripId, Mesh>;
  bandageZones: BandageZones;
  bandageRestartPoses: Record<BandageId, Vector3>;
  bandageLayerSegments: Record<BandageId, Mesh[]>;
  resetTapeStrips(): void;
  setGauzeApplied(applied: boolean): void;
  ensurePropReady(id: ObjectId): Promise<void>;
  setGameMode(mode: GameMode, objects: ReadonlyMap<ObjectId, ActivityObjectState>): Promise<void>;
  setInventoryPropActive(id: ObjectId, active: boolean): void;
  syncObjectVisibility(objects: ReadonlyMap<ObjectId, ActivityObjectState>): void;
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

function gauzeWeaveTexture(scene: Scene): DynamicTexture {
  const size = 256;
  const texture = new DynamicTexture(
    'gauze-applied-weave',
    { width: size, height: size },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const context = texture.getContext();
  context.fillStyle = '#fffdf7';
  context.fillRect(0, 0, size, size);
  for (let coordinate = 0; coordinate <= size; coordinate += 8) {
    const primaryThread = coordinate % 16 === 0;
    context.strokeStyle = primaryThread ? '#c9c2b2' : '#e2dccf';
    context.lineWidth = primaryThread ? 2 : 1;
    context.beginPath();
    context.moveTo(coordinate, 0);
    context.lineTo(coordinate, size);
    context.stroke();
    context.beginPath();
    context.moveTo(0, coordinate);
    context.lineTo(size, coordinate);
    context.stroke();
  }
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = 1.75;
  texture.vScale = 1.75;
  texture.gammaSpace = true;
  texture.anisotropicFilteringLevel = 4;
  texture.hasAlpha = false;
  texture.update(false);
  return texture;
}

function tapeFiberTexture(scene: Scene): DynamicTexture {
  const size = 128;
  const texture = new DynamicTexture(
    'tape-applied-fibers',
    { width: size, height: size },
    scene,
    true,
    Texture.TRILINEAR_SAMPLINGMODE,
  );
  const context = texture.getContext();
  context.fillStyle = '#eee7d6';
  context.fillRect(0, 0, size, size);
  for (let y = 4; y < size; y += 12) {
    context.strokeStyle = y % 24 === 4 ? '#d8cdb6' : '#f8f3e8';
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(0, y);
    context.lineTo(size, y);
    context.stroke();
  }
  texture.wrapU = Texture.WRAP_ADDRESSMODE;
  texture.wrapV = Texture.WRAP_ADDRESSMODE;
  texture.uScale = 2;
  texture.vScale = 1;
  texture.gammaSpace = true;
  texture.anisotropicFilteringLevel = 4;
  texture.hasAlpha = false;
  texture.update(false);
  return texture;
}

function appliedPatchMaterial(
  scene: Scene,
  name: string,
  texture: DynamicTexture,
  emissiveColor: Color3,
  specularColor: Color3,
): StandardMaterial {
  const result = new StandardMaterial(name, scene);
  result.diffuseColor = Color3.White();
  result.diffuseTexture = texture;
  result.specularColor = specularColor;
  result.specularPower = 4;
  result.ambientColor = Color3.White();
  result.emissiveColor = emissiveColor;
  result.alpha = 1;
  result.backFaceCulling = false;
  result.twoSidedLighting = true;
  return result;
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
  const appliedSurface = new AppliedSurfaceSystem(anatomySurface, root);
  const supportSurface = new SupportSurfaceSystem(root);
  const assetContainers = new Map<string, Promise<AssetContainer>>();
  const containerFor = (filename: string): Promise<AssetContainer> => {
    let pending = assetContainers.get(filename);
    if (!pending) {
      pending = SceneLoader.LoadAssetContainerAsync(MODEL_ROOT, filename, scene);
      assetContainers.set(filename, pending);
    }
    return pending;
  };

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
  base.material = material(scene, 'base-material', '#6c858d');
  base.isPickable = false;
  supportSurface.registerSupport('station-base', base, [base]);

  // A bandeja tem um fallback simples e é substituída pelo GLB assim que o asset carrega.
  const trayRoot = new TransformNode('instrument-tray-root', scene);
  trayRoot.parent = root;
  trayRoot.position.set(0.15, 0, 0.0);
  trayRoot.rotation.y = Math.PI / 2;
  const trayFallback = MeshBuilder.CreateBox(
    'instrument-tray-fallback',
    { width: 0.22, depth: 0.28, height: 0.010 },
    scene,
  );
  trayFallback.parent = trayRoot;
  trayFallback.position.y = 0.005;
  trayFallback.scaling.setAll(1.5);
  trayFallback.material = material(scene, 'tray-fallback-material', '#829b94', 0.35);
  trayFallback.isPickable = false;

  let trayReady: Promise<void> | undefined;
  const ensureTrayReady = (): Promise<void> => {
    trayReady ??= containerFor(MODELS.metalTray).then((container) => {
      const meshes = attachNormalizedContainerInstance(
        scene,
        trayRoot,
        container,
        MODELS.metalTray,
        {
          orientation: 'flat',
          alignment: 'base',
          metric: 'footprint',
          targetSize: METAL_TRAY_TARGET_FOOTPRINT,
          pickable: false,
        },
      );
      trayFallback.setEnabled(false);
      return meshes;
    }).catch((error) => {
      console.warn('Falha ao carregar metal_tray.glb; usando bandeja provisória.', error);
      return [trayFallback];
    }).then((meshes) => {
      supportSurface.invalidateObjectBounds(trayRoot);
      supportSurface.placeOnSupport(trayRoot, 'station-base');
      supportSurface.registerSupport('metal-tray', trayRoot, meshes);
    });
    return trayReady;
  };

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

  const treatment = new Mesh('TreatmentInteractionSurface', scene);
  treatment.parent = root;
  const treatmentMaterial = material(scene, 'treatment-material', '#7f2028', 0.88);
  treatmentMaterial.backFaceCulling = false;
  treatment.material = treatmentMaterial;
  treatment.isPickable = false;

  const halo = new Mesh('treatment-halo', scene);
  halo.parent = root;
  const haloMat = material(scene, 'halo-material', '#641a22', 0.90);
  haloMat.alpha = 0.20;
  haloMat.backFaceCulling = false;
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
  const solutionPourPivot = new TransformNode('solution-pour-pivot', scene);
  solutionPourPivot.parent = bottle;
  solutionPourPivot.position.y = MEDICINE_JAR_TARGET_HEIGHT / 2;
  const solutionVisualRoot = new TransformNode('solution-visual-root', scene);
  solutionVisualRoot.parent = solutionPourPivot;
  solutionVisualRoot.position.y = -MEDICINE_JAR_TARGET_HEIGHT / 2;
  const bottleFallbackBody = MeshBuilder.CreateCylinder(
    'solution-bottle-fallback-body',
    { height: 0.105, diameter: 0.042, tessellation: 24 },
    scene,
  );
  bottleFallbackBody.parent = solutionVisualRoot;
  bottleFallbackBody.position.y = 0.0525;
  bottleFallbackBody.material = material(scene, 'bottle-fallback-material', '#69a9bd', 0.3);
  bottleFallbackBody.isPickable = true;
  const bottleFallbackCap = MeshBuilder.CreateCylinder(
    'solution-bottle-fallback-cap',
    { height: 0.024, diameter: 0.025, tessellation: 20 },
    scene,
  );
  bottleFallbackCap.parent = solutionVisualRoot;
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
  tapeFallback.scaling.setAll(1.5);
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
  bandage1Fallback.scaling.setAll(2);
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
  bandage2Fallback.scaling.setAll(2);
  bandage2Fallback.material = material(scene, 'bandage-roll-2-fallback-material', '#b89a72', 0.9);
  bandage2Fallback.isPickable = true;

  const pickables = new Map<ObjectId, AbstractMesh>([
    ['debrisoft-pad', debrisoft],
    ['solution-bottle', bottle],
    ['gauze', gauze],
    ['tape-strip', tapeRoll],
    ['bandage-1', bandage1],
    ['bandage-2', bandage2],
  ]);

  const tapeMaterial = appliedPatchMaterial(
    scene,
    'applied-tape-material',
    tapeFiberTexture(scene),
    Color3.FromHexString('#181713'),
    Color3.FromHexString('#17150f'),
  );
  const gauzeAppliedMaterial = appliedPatchMaterial(
    scene,
    'gauze-applied-material',
    gauzeWeaveTexture(scene),
    Color3.FromHexString('#20201d'),
    Color3.FromHexString('#0d0d0b'),
  );

  const propReady = new Map<ObjectId, Promise<void>>([
    ['debrisoft-pad', Promise.resolve()],
  ]);
  const ensurePropReady = (id: ObjectId): Promise<void> => {
    const existing = propReady.get(id);
    if (existing) return existing;

    const rootForId = pickables.get(id)!;
    const visualRootForId = id === 'solution-bottle' ? solutionVisualRoot : rootForId;
    const definition = id === 'solution-bottle'
      ? {
          filename: MODELS.medicineJar,
          options: {
            orientation: 'upright', alignment: 'base', metric: 'height',
            targetSize: MEDICINE_JAR_TARGET_HEIGHT, pickable: true,
          } satisfies AssetVisualOptions,
        }
      : id === 'gauze'
        ? {
            filename: MODELS.gauze,
            options: {
              orientation: 'flat', alignment: 'center', metric: 'footprint',
              targetSize: GAUZE_TARGET_SIZE, pickable: true,
            } satisfies AssetVisualOptions,
          }
        : id === 'tape-strip'
          ? {
              filename: MODELS.tapeRoll,
              options: {
                orientation: 'roll-side', alignment: 'center', metric: 'max',
                targetSize: TAPE_ROLL_TARGET_SIZE, pickable: true,
              } satisfies AssetVisualOptions,
            }
          : {
              filename: MODELS.bandageRoll,
              options: {
                orientation: 'roll-side', alignment: 'center', metric: 'max',
                targetSize: BANDAGE_ROLL_TARGET_SIZE, pickable: true,
              } satisfies AssetVisualOptions,
            };

    const pending = containerFor(definition.filename).then((container) => {
      const meshes = attachNormalizedContainerInstance(
        scene,
        visualRootForId,
        container,
        `${definition.filename}-${id}`,
        definition.options,
      );
      if (id === 'solution-bottle') {
        bottleFallbackBody.setEnabled(false);
        bottleFallbackCap.setEnabled(false);
      } else if (id === 'gauze') {
        gauzeFallback.setEnabled(false);
      } else if (id === 'tape-strip') {
        tapeFallback.setEnabled(false);
      } else {
        (id === 'bandage-1' ? bandage1Fallback : bandage2Fallback).setEnabled(false);
      }
      if (id === 'bandage-2') {
        for (const mesh of meshes) {
          if (!(mesh.material instanceof PBRMaterial)) continue;
          const tintedMaterial = mesh.material.clone(`${mesh.material.name}-bandage-2`);
          tintedMaterial.albedoColor = Color3.FromHexString('#b89a72');
          mesh.material = tintedMaterial;
        }
      }
      supportSurface.invalidateObjectBounds(rootForId);
    }).catch((error) => {
      console.warn(`Falha ao carregar ${definition.filename}; usando prop provisório.`, error);
    });

    propReady.set(id, pending);
    return pending;
  };

  // Âncoras mutáveis: Interaction mantém as mesmas referências e recebe as posições
  // recalculadas quando o GLB anatômico real termina de carregar.
  const treatmentSnap = new Vector3(-0.09, TREATMENT_MANIPULATION_SURFACE.height, 0.055);
  const solutionZone = treatmentSnap.add(new Vector3(0, 0.065, 0));

  const tapeApplicationArea: TapeApplicationArea = {
    center: treatmentSnap.clone(),
    lateralAxis: 'x',
    longitudinalAxis: 'z',
    halfLateral: 0.060,
    minCrossLateral: 0.045,
    passHalfWidth: 0.026,
    minStartLateral: 0.018,
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

  const tapeAppliedStrips: Record<TapeStripId, Mesh> = {
    lateral: new Mesh('tape-applied-lateral', scene),
    longitudinal: new Mesh('tape-applied-longitudinal', scene),
  };
  for (const strip of Object.values(tapeAppliedStrips)) {
    strip.parent = root;
    strip.material = tapeMaterial;
    strip.setEnabled(false);
  }

  const gauzeApplied = new Mesh('gauze-applied-surface', scene);
  gauzeApplied.parent = root;
  gauzeApplied.material = gauzeAppliedMaterial;
  gauzeApplied.isPickable = false;
  gauzeApplied.setEnabled(false);

  const bandageLayerSegments: Record<BandageId, Mesh[]> = {
    'bandage-1': [],
    'bandage-2': [],
  };

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
    const lateralBasis = anatomySurface.lateralBasis();
    const longitudinalBasis = anatomySurface.longitudinalBasis();
    appliedSurface.conform(tapeAppliedStrips.lateral, {
      center: treatmentSnap,
      axisU: lateralBasis,
      axisV: longitudinalBasis,
      width: TAPE_STRIP_LENGTH,
      height: TAPE_STRIP_WIDTH,
      layerOffset: APPLIED_LAYERS.tapeA.base,
      thickness: APPLIED_LAYERS.tapeA.thickness,
      subdivisionsU: 14,
      subdivisionsV: 2,
      conformMode: 'smoothed',
      smoothingIterations: 6,
      smoothingStrength: 0.72,
      surfaceInfluence: 0.03,
      maxGlobalLift: 0.0008,
      penetrationSpread: 0.75,
      penetrationSpreadIterations: 4,
    });
    appliedSurface.conform(tapeAppliedStrips.longitudinal, {
      center: treatmentSnap,
      axisU: longitudinalBasis,
      axisV: lateralBasis,
      width: TAPE_STRIP_LENGTH,
      height: TAPE_STRIP_WIDTH,
      layerOffset: APPLIED_LAYERS.tapeB.base,
      thickness: APPLIED_LAYERS.tapeB.thickness,
      subdivisionsU: 14,
      subdivisionsV: 2,
      conformMode: 'smoothed',
      smoothingIterations: 6,
      smoothingStrength: 0.72,
      surfaceInfluence: 0.03,
      maxGlobalLift: 0.0008,
      penetrationSpread: 0.75,
      penetrationSpreadIterations: 4,
    });
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
    bandageLayerSegments['bandage-2'] = createBandageLayer(2, '#b89a72');

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

    const lateralBasis = anatomySurface.lateralBasis();
    const longitudinalBasis = anatomySurface.longitudinalBasis();
    appliedSurface.conform(halo, {
      center: treatmentSnap,
      axisU: lateralBasis,
      axisV: longitudinalBasis,
      width: WOUND_HALO_DIAMETER,
      height: WOUND_HALO_DIAMETER * 0.82,
      layerOffset: APPLIED_LAYERS.wound.base * 0.75,
      shape: 'ellipse',
      subdivisionsU: 32,
      subdivisionsV: 4,
    });
    appliedSurface.conform(treatment, {
      center: treatmentSnap,
      axisU: lateralBasis,
      axisV: longitudinalBasis,
      width: WOUND_RADIUS * 2,
      height: WOUND_RADIUS * 1.65,
      layerOffset: APPLIED_LAYERS.wound.base,
      shape: 'ellipse',
      subdivisionsU: 32,
      subdivisionsV: 5,
    });
    appliedSurface.conform(gauzeApplied, {
      center: treatmentSnap,
      axisU: lateralBasis,
      axisV: longitudinalBasis,
      width: GAUZE_TARGET_SIZE,
      height: GAUZE_TARGET_SIZE * 0.90,
      layerOffset: APPLIED_LAYERS.gauze.base,
      thickness: APPLIED_LAYERS.gauze.thickness,
      subdivisionsU: 8,
      subdivisionsV: 8,
      conformMode: 'smoothed',
      smoothingIterations: 4,
      smoothingStrength: 0.62,
      surfaceInfluence: 0.12,
      maxGlobalLift: 0.0012,
      penetrationSpread: 0.55,
      penetrationSpreadIterations: 2,
    });

    tapeApplicationArea.center.copyFrom(treatmentSample.point);
    tapeApplicationArea.lateralAxis = frame.lateralAxis;
    tapeApplicationArea.longitudinalAxis = frame.longitudinalAxis;
    tapeApplicationArea.halfLateral = Math.max(0.050, Math.min(0.070, frame.width * 0.68));
    tapeApplicationArea.minCrossLateral = tapeApplicationArea.halfLateral * 0.75;
    tapeApplicationArea.passHalfWidth = Math.max(0.024, Math.min(0.033, frame.length * 0.088));

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
    tapeAppliedStrips.lateral.setEnabled(false);
    tapeAppliedStrips.longitudinal.setEnabled(false);
  };

  const setGauzeApplied = (applied: boolean) => {
    gauzeApplied.setEnabled(applied);
    if (applied) gauze.setEnabled(false);
  };

  let gameMode: GameMode = 'inventory';
  const inventoryActive = new Set<ObjectId>();
  let supportsCalibrated = false;
  const placeStoredProps = (objects?: ReadonlyMap<ObjectId, ActivityObjectState>) => {
    for (const [id, mesh] of pickables) {
      const state = objects?.get(id)?.state;
      if (id === 'debrisoft-pad' && (state === 'positioned' || state === 'wet')) continue;
      if (!mesh.isEnabled(false)) continue;
      supportSurface.invalidateObjectBounds(mesh);
      supportSurface.placeOnSupport(mesh, 'metal-tray');
    }
  };

  const syncObjectVisibility = (
    objects: ReadonlyMap<ObjectId, ActivityObjectState>,
  ) => {
    base.setEnabled(gameMode === 'tabletop');
    trayRoot.setEnabled(gameMode === 'tabletop');
    for (const [id, mesh] of pickables) {
      const state = objects.get(id)?.state ?? 'available';
      const remainsClinicallyPlaced = id === 'debrisoft-pad'
        && (state === 'positioned' || state === 'wet');
      const availableOnTable = state !== 'completed' && !(id === 'gauze' && state === 'applied');
      mesh.visibility = 1;
      mesh.setEnabled(gameMode === 'tabletop'
        ? availableOnTable
        : inventoryActive.has(id) || remainsClinicallyPlaced);
    }
  };

  const setInventoryPropActive = (id: ObjectId, active: boolean) => {
    if (active) inventoryActive.add(id);
    else inventoryActive.delete(id);
    if (gameMode === 'inventory') pickables.get(id)!.setEnabled(active);
  };

  const resetObjects = () => {
    inventoryActive.clear();
    for (const [id, mesh] of pickables) {
      const pose = OBJECT_INITIAL_POSES[id];
      mesh.position.set(...pose.position);
      mesh.rotationQuaternion = null;
      mesh.rotation.set(...pose.rotation);
      mesh.visibility = 1;
      mesh.setEnabled(gameMode === 'tabletop');
    }
    if (supportsCalibrated) placeStoredProps();
    base.setEnabled(gameMode === 'tabletop');
    trayRoot.setEnabled(gameMode === 'tabletop');
    setGauzeApplied(false);
    resetTapeStrips();
  };

  let tabletopReady: Promise<void> | undefined;
  const prepareTabletop = (): Promise<void> => {
    tabletopReady ??= Promise.all([
      ensureTrayReady(),
      ...Array.from(pickables.keys(), (id) => ensurePropReady(id)),
    ]).then(() => {
      supportsCalibrated = true;
    });
    return tabletopReady;
  };

  const setGameMode = async (
    mode: GameMode,
    objects: ReadonlyMap<ObjectId, ActivityObjectState>,
  ): Promise<void> => {
    if (mode === 'tabletop') {
      base.setEnabled(true);
      trayRoot.setEnabled(true);
      await prepareTabletop();
    }
    gameMode = mode;
    inventoryActive.clear();
    syncObjectVisibility(objects);
    if (gameMode === 'tabletop' && supportsCalibrated) placeStoredProps(objects);
  };

  let legVisualRoot: TransformNode | undefined;
  const anatomyReady = SceneLoader.ImportMeshAsync('', MODEL_ROOT, MODELS.anatomy, scene)
    .then((result) => {
      legVisualRoot = new TransformNode('lower-leg-visual-root', scene);
      legVisualRoot.parent = root;

      // Transformação já validada visualmente durante a calibração anterior.
      legVisualRoot.position.set(0, 0.085, 0.180);
      legVisualRoot.rotation.set(Math.PI / 2, 0, Math.PI);
      legVisualRoot.scaling.setAll(0.540);

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
    supportSurface,
    get supportReady() {
      return prepareTabletop();
    },
    get gameMode() {
      return gameMode;
    },
    placementIndicator: indicator,
    pickables,
    treatmentSurface: treatment,
    treatmentSnap,
    solutionZone,
    solutionPourPivot,
    tapeApplicationArea,
    tapeAppliedStrips,
    bandageZones,
    bandageRestartPoses,
    bandageLayerSegments,
    resetTapeStrips,
    setGauzeApplied,
    ensurePropReady,
    setGameMode,
    setInventoryPropActive,
    syncObjectVisibility,
    resetObjects,
  };
}
