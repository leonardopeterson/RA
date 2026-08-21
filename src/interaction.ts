import {
  AbstractMesh,
  Axis,
  Color3,
  HighlightLayer,
  Matrix,
  Mesh,
  Plane,
  PointerDragBehavior,
  PointerEventTypes,
  Quaternion,
  Scene,
  TransformNode,
  Vector3,
} from '@babylonjs/core';
import { Activity, OBJECT_INITIAL_POSES, type BandageId, type ObjectId } from './activity';
import type { UI } from './ui';
import { rotationFromUpToNormal } from './anatomySurface';
import {
  TREATMENT_MANIPULATION_SURFACE,
  WORKSPACE,
  type GameMode,
  type Workspace,
} from './workspace';

const HEIGHT_SMOOTHING_SPEED = 10;
const BANDAGE_HEIGHT_SMOOTHING_SPEED = 5;
const ELEVATION_START_DISTANCE = 0.08;
const ELEVATION_END_DISTANCE = 0.015;
const BANDAGE_ELEVATION_START_DISTANCE = 0.145;
const BANDAGE_ELEVATION_END_DISTANCE = 0.020;
const MANIPULABLE_ANATOMY_CLEARANCE = 0.002;
const BANDAGE_SURFACE_MEMORY_MS = 450;
const BANDAGE_TARGET_BLEND = 0.42;
const MIN_MOVEMENT_DISTANCE = 0.0015;
const MAX_MOVEMENT_SAMPLE_SECONDS = 0.1;
const TREATMENT_CONTACT_RADIUS = 0.050;
const INVENTORY_LATERAL_REACH = 0.15;
const INVENTORY_LONGITUDINAL_REACH = 0.17;

const SURFACE_CONTACT_OFFSETS: Partial<Record<ObjectId, number>> = {
  'debrisoft-pad': 0.006,
  'solution-bottle': 0.018,
  'gauze': 0.0028,
};

type BandagePassState =
  | 'WAIT_START'
  | 'FRONT_WAIT_CENTER'
  | 'FRONT_WAIT_OPPOSITE'
  | 'BACK_WAIT_CENTER'
  | 'BACK_WAIT_START';
type BandageStartSide = 'left' | 'right';

interface BandageSurfaceMemory {
  y: number;
  at: number;
}

export class InteractionController {
  private selected?: ObjectId;
  private highlight: HighlightLayer;
  private drags = new Map<ObjectId, PointerDragBehavior>();
  private currentY = new Map<ObjectId, number>();
  private targetY = new Map<ObjectId, number>();
  private dragOffset = new Map<ObjectId, Vector3>();
  private lastDebridementPosition?: Vector3;
  private lastMovementAt?: number;
  private solutionAnimationRunning = false;
  private solutionAnimationGeneration = 0;
  private poseAnimations = new Set<ObjectId>();
  private inventoryDragging?: ObjectId;

  private tapeStrokeStart?: Vector3;
  private tapeCompletedPasses = 0;

  private bandagePassState: BandagePassState = 'WAIT_START';
  private bandageStartSide?: BandageStartSide;
  private activeBandage?: BandageId;
  private lastBandageLateral?: number;
  private bandageSurfaceMemory = new Map<BandageId, BandageSurfaceMemory>();
  private bandageTargetMemory = new Map<BandageId, number>();

  constructor(
    private scene: Scene,
    private workspace: Workspace,
    private activity: Activity,
    private ui: UI,
  ) {
    this.highlight = new HighlightLayer('selection-highlight', scene);
    this.highlight.innerGlow = false;

    this.setupDrag('debrisoft-pad');
    this.setupDrag('solution-bottle');
    this.setupDrag('gauze');
    this.setupDrag('tape-strip');
    this.setupDrag('bandage-1');
    this.setupDrag('bandage-2');

    this.scene.onBeforeRenderObservable.add(() => this.updateAutomaticHeights());
    this.scene.onPointerObservable.add((pointer) => {
      if (pointer.type !== PointerEventTypes.POINTERPICK || !pointer.pickInfo?.pickedMesh) return;
      const id = this.objectId(pointer.pickInfo.pickedMesh);
      if (id) this.select(id);
    });
  }

  select(id: ObjectId): void {
    this.clearHighlight();
    this.selected = id;
    if (!this.activity.select(id)) this.ui.notify(this.invalidMessage(id), 'error');
    this.meshes(id).forEach((mesh) => {
      this.highlight.addMesh(mesh as Mesh, new Color3(0.2, 1, 0.66));
    });
    this.refreshSelection(id);
  }

  pickSelected(): void {
    if (!this.selected) return;
    if (!this.activity.pick(this.selected)) {
      this.ui.notify(this.invalidMessage(this.selected), 'error');
      return;
    }

    this.drags.get(this.selected)!.enabled = true;
    this.refreshSelection(this.selected);
    this.ui.update(this.activity.snapshot);

    if (this.selected === 'tape-strip') {
      this.ui.notify('Atravesse a gaze duas vezes, começando por qualquer lado.', 'info');
    } else if (this.isBandage(this.selected)) {
      this.ui.notify('Inicie por qualquer lateral e contorne o membro.', 'info');
    } else {
      this.ui.notify('Objeto em mãos. Arraste-o com o dedo.', 'info');
    }
  }

  async beginInventoryDrag(id: ObjectId, clientX: number, clientY: number): Promise<boolean> {
    if (this.workspace.gameMode !== 'inventory' || !this.activity.canPick(id)) return false;
    this.workspace.setInventoryPropActive(id, true);
    void this.workspace.ensurePropReady(id);
    const mesh = this.workspace.pickables.get(id)!;
    const pointerPosition = this.inventoryPosition(clientX, clientY);
    mesh.position.x = pointerPosition.x;
    mesh.position.z = pointerPosition.z;
    mesh.rotationQuaternion = null;
    mesh.rotation.set(...OBJECT_INITIAL_POSES[id].rotation);
    this.currentY.set(id, this.calculateTargetY(id, mesh.position));
    this.targetY.set(id, this.currentY.get(id)!);
    mesh.position.y = this.currentY.get(id)!;

    this.select(id);
    if (!this.activity.pick(id)) {
      this.workspace.setInventoryPropActive(id, false);
      return false;
    }
    this.inventoryDragging = id;
    this.drags.get(id)!.enabled = false;
    this.ui.update(this.activity.snapshot);
    this.refreshSelection(id);
    return true;
  }

  updateInventoryDrag(clientX: number, clientY: number): void {
    const id = this.inventoryDragging;
    if (!id || !this.activity.isHeld(id)) return;
    const mesh = this.workspace.pickables.get(id)!;
    const pointerPosition = this.inventoryPosition(clientX, clientY);
    mesh.position.x = pointerPosition.x;
    mesh.position.z = pointerPosition.z;
    this.validateMove(id);
    this.updateObjectHeight(id);
  }

  endInventoryDrag(): void {
    if (!this.inventoryDragging) return;
    this.inventoryDragging = undefined;
    this.releaseSelected();
  }

  cancelActiveManipulable(): void {
    const id = this.inventoryDragging ?? this.selected;
    this.inventoryDragging = undefined;
    if (!id || !this.activity.isHeld(id)) {
      this.clearSelectionState();
      return;
    }

    if (id === 'solution-bottle' && this.solutionAnimationRunning) {
      this.solutionAnimationGeneration += 1;
      this.solutionAnimationRunning = false;
      this.activity.cancelSolutionApplication();
      this.workspace.solutionPourPivot.rotationQuaternion = null;
      this.workspace.solutionPourPivot.rotation.set(0, 0, 0);
    } else if (id === 'tape-strip') {
      this.activity.cancelTapeApplication();
      this.workspace.resetTapeStrips();
      this.resetTapeTraversal();
    } else if (this.isBandage(id)) {
      this.activity.cancelBandagePass(id);
      this.resetBandagePass();
      this.workspace.pickables.get(id)!.visibility = 1;
    } else {
      this.activity.release(id);
    }
    this.drags.get(id)!.enabled = false;
    this.currentY.delete(id);
    this.targetY.delete(id);
    this.workspace.setInventoryPropActive(id, false);
    this.clearSelectionState();
    this.ui.update(this.activity.snapshot);
  }

  async setGameMode(mode: GameMode): Promise<void> {
    this.cancelActiveManipulable();
    await this.workspace.setGameMode(mode, this.activity.objects);
    this.workspace.syncObjectVisibility(this.activity.objects);
  }

  releaseSelected(): void {
    if (!this.selected || !this.activity.isHeld(this.selected)) return;
    const id = this.selected;
    if (id === 'solution-bottle' && this.solutionAnimationRunning) return;
    const mesh = this.workspace.pickables.get(id)!;

    if (id === 'debrisoft-pad' && this.activity.step === 0 && this.isOnTreatment(mesh.position)) {
      if (this.activity.positionDebrisoft()) {
        this.placeAtTreatmentSnap(id);
        this.ui.notify('Debrisoft posicionado. Aplique a solução.', 'success');
      }
    } else if (id === 'gauze' && this.isOnTreatment(mesh.position)) {
      if (this.activity.applyGauze()) {
        this.workspace.setGauzeApplied(true);
        this.workspace.setInventoryPropActive(id, false);
        this.drags.get(id)!.enabled = false;
        this.currentY.delete(id);
        this.targetY.delete(id);
        this.ui.notify('Gaze aplicada. Atravesse e retorne com o esparadrapo.', 'success');
      }
    } else if (id === 'tape-strip') {
      const incomplete = this.activity.objects.get(id)!.state === 'applying'
        || this.tapeCompletedPasses > 0;
      this.activity.cancelTapeApplication();
      this.workspace.resetTapeStrips();
      this.resetTapeTraversal();
      if (incomplete) {
        this.ui.notify('Fixação incompleta. Faça duas passadas completas sobre a gaze.', 'error');
      }
      void this.returnToInitialPose(id);
    } else if (this.isBandage(id)) {
      const incomplete = this.bandagePassState !== 'WAIT_START';
      const startSide = this.bandageStartSide;
      this.activity.cancelBandagePass(id);
      this.resetBandagePass();
      mesh.visibility = 1;
      if (incomplete) this.ui.notify('Volta incompleta. Reinicie por uma das laterais.', 'error');
      void this.returnBandageToSide(id, startSide);
    } else {
      this.activity.release(id);
      this.targetY.set(id, this.calculateTargetY(id, mesh.position));
      if (id === 'solution-bottle') void this.returnToInitialPose(id);
      else if (this.workspace.gameMode === 'inventory') {
        this.currentY.delete(id);
        this.targetY.delete(id);
        this.workspace.setInventoryPropActive(id, false);
      }
    }

    this.drags.get(id)!.enabled = false;
    this.refreshSelection(id);
    this.ui.update(this.activity.snapshot);
  }

  private setupDrag(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    const drag = new PointerDragBehavior({ dragPlaneNormal: Vector3.Up() });
    drag.moveAttached = false;
    drag.useObjectOrientationForDragging = false;
    drag.enabled = false;
    mesh.addBehavior(drag);

    drag.onDragStartObservable.add((event) => {
      this.currentY.set(id, mesh.position.y);
      this.targetY.set(id, this.calculateTargetY(id, mesh.position));
      const pointerPosition = this.toWorkspaceLocal(event.dragPlanePoint);
      this.dragOffset.set(
        id,
        new Vector3(
          mesh.position.x - pointerPosition.x,
          0,
          mesh.position.z - pointerPosition.z,
        ),
      );

      if (id === 'debrisoft-pad') {
        this.lastDebridementPosition = mesh.position.clone();
        this.lastMovementAt = undefined;
      }
      if (id === 'tape-strip') this.tapeStrokeStart = undefined;
    });

    drag.onDragObservable.add((event) => {
      const pointerPosition = this.toWorkspaceLocal(event.dragPlanePoint);
      const offset = this.dragOffset.get(id) ?? Vector3.Zero();
      mesh.position.x = pointerPosition.x + offset.x;
      mesh.position.z = pointerPosition.z + offset.z;
      this.validateMove(id);
      this.updateObjectHeight(id);
    });

    this.drags.set(id, drag);
  }

  private validateMove(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    const minX = this.workspace.gameMode === 'inventory'
      ? this.workspace.treatmentSnap.x - INVENTORY_LATERAL_REACH
      : -WORKSPACE.halfWidth + 0.025;
    const maxX = this.workspace.gameMode === 'inventory'
      ? this.workspace.treatmentSnap.x + INVENTORY_LATERAL_REACH
      : WORKSPACE.halfWidth - 0.025;
    const minZ = this.workspace.gameMode === 'inventory'
      ? this.workspace.treatmentSnap.z - INVENTORY_LONGITUDINAL_REACH
      : -WORKSPACE.halfDepth + 0.025;
    const maxZ = this.workspace.gameMode === 'inventory'
      ? this.workspace.treatmentSnap.z + INVENTORY_LONGITUDINAL_REACH
      : WORKSPACE.halfDepth - 0.025;
    mesh.position.x = Math.max(minX, Math.min(maxX, mesh.position.x));
    mesh.position.z = Math.max(minZ, Math.min(maxZ, mesh.position.z));

    this.targetY.set(id, this.calculateTargetY(id, mesh.position));
    mesh.position.y = this.currentY.get(id) ?? mesh.position.y;

    if (id === 'solution-bottle' && this.activity.step === 1 && this.isNearSolutionZone(mesh.position)) {
      void this.animateSolutionApplication();
    } else if (id === 'debrisoft-pad' && this.activity.step === 2) {
      this.updateDebridement(mesh.position);
    } else if (id === 'tape-strip' && this.activity.step === 4) {
      this.updateTapeApplication(mesh.position);
    } else if (
      this.isBandage(id)
      && ((id === 'bandage-1' && this.activity.step === 5)
        || (id === 'bandage-2' && this.activity.step === 6))
    ) {
      this.updateBandageWrapping(id, mesh.position);
    }
  }

  private updateTapeApplication(position: Vector3): void {
    const area = this.workspace.tapeApplicationArea;
    const center = area.center;
    const lateral = this.axisValue(position, area.lateralAxis)
      - this.axisValue(center, area.lateralAxis);
    const longitudinal = this.axisValue(position, area.longitudinalAxis)
      - this.axisValue(center, area.longitudinalAxis);

    const insideArea = Math.abs(lateral) <= area.halfLateral
      && Math.abs(longitudinal) <= area.passHalfWidth;
    const safeTapeY = this.surfaceTargetY('tape-strip', position);

    if (!insideArea || this.surfaceBlend(position) < 0.82 || position.y < safeTapeY - 0.016) {
      if (!insideArea) this.tapeStrokeStart = undefined;
      return;
    }

    if (!this.tapeStrokeStart) {
      if (Math.abs(lateral) < area.minStartLateral) return;

      if (this.activity.objects.get('tape-strip')!.state === 'available'
        && !this.activity.beginTapeApplication()) return;

      this.tapeStrokeStart = position.clone();
      if (this.tapeCompletedPasses === 0) {
        this.ui.notify('Fixação iniciada. Atravesse a gaze.', 'success');
        this.ui.update(this.activity.snapshot);
        this.refreshSelection('tape-strip');
      }
      return;
    }

    const start = this.tapeStrokeStart;
    const startLateral = this.axisValue(start, area.lateralAxis)
      - this.axisValue(center, area.lateralAxis);
    const deltaLateral = lateral - startLateral;
    const crossedLateral = startLateral * lateral < 0
      && Math.abs(deltaLateral) >= area.minCrossLateral;
    if (!crossedLateral) return;

    const strip = this.tapeCompletedPasses === 0 ? 'lateral' : 'longitudinal';
    this.workspace.tapeAppliedStrips[strip].setEnabled(true);
    this.tapeCompletedPasses += 1;

    if (this.tapeCompletedPasses === 1) {
      this.tapeStrokeStart = undefined;
      this.ui.notify('Primeira fita aplicada. Atravesse novamente por qualquer lado.', 'success');
      return;
    }

    this.tapeStrokeStart = undefined;

    if (!this.activity.applyTape()) return;
    this.drags.get('tape-strip')!.enabled = false;
    this.currentY.delete('tape-strip');
    this.targetY.delete('tape-strip');
    this.ui.notify('Fixação em + concluída.', 'success');
    this.ui.update(this.activity.snapshot);
    this.refreshSelection('tape-strip');

    // O rolo retorna para a bandeja, enquanto as duas tiras procedurais permanecem.
    void this.returnToInitialPose('tape-strip').then(() => {
      this.tapeStrokeStart = undefined;
      this.tapeCompletedPasses = 0;
    });
  }

  private updateBandageWrapping(id: BandageId, position: Vector3): void {
    if (this.activeBandage !== id) {
      this.activeBandage = id;
      this.bandagePassState = 'WAIT_START';
      this.bandageStartSide = undefined;
      this.lastBandageLateral = undefined;
    }

    const zones = this.workspace.bandageZones;
    const lateral = this.axisValue(position, zones.lateralAxis);
    const longitudinal = this.axisValue(position, zones.longitudinalAxis);
    const previousLateral = this.lastBandageLateral;
    this.lastBandageLateral = lateral;

    if (Math.abs(longitudinal - zones.longitudinalCenter) > zones.longitudinalTolerance) return;

    const rightReached = lateral >= zones.rightTrigger;
    const leftReached = lateral <= zones.leftTrigger;
    const reachedCenterFromRight = lateral <= zones.centerLateral + zones.centerTolerance
      || (previousLateral !== undefined
        && previousLateral > zones.centerLateral
        && lateral <= zones.centerLateral);
    const reachedCenterFromLeft = lateral >= zones.centerLateral - zones.centerTolerance
      || (previousLateral !== undefined
        && previousLateral < zones.centerLateral
        && lateral >= zones.centerLateral);

    const bandage = this.workspace.pickables.get(id)!;
    const backPass = this.bandagePassState === 'BACK_WAIT_CENTER'
      || this.bandagePassState === 'BACK_WAIT_START';
    bandage.visibility = backPass
      && Math.abs(lateral - zones.centerLateral) < zones.backHideHalfSpan
      ? 0
      : 1;

    switch (this.bandagePassState) {
      case 'WAIT_START':
        if (!rightReached && !leftReached) return;
        if (!this.activity.beginBandageWrapping(id)) return;
        this.bandageStartSide = rightReached ? 'right' : 'left';
        this.bandagePassState = 'FRONT_WAIT_CENTER';
        this.ui.notify('Passe pela frente do membro.', 'info');
        this.refreshSelection(id);
        break;

      case 'FRONT_WAIT_CENTER':
        if (this.bandageStartSide === 'right' ? !reachedCenterFromRight : !reachedCenterFromLeft) return;
        this.bandagePassState = 'FRONT_WAIT_OPPOSITE';
        if (this.bandageStartSide === 'right' ? leftReached : rightReached) {
          this.enterBandageBackPass();
        }
        break;

      case 'FRONT_WAIT_OPPOSITE':
        if (this.bandageStartSide === 'right' ? !leftReached : !rightReached) return;
        this.enterBandageBackPass();
        break;

      case 'BACK_WAIT_CENTER':
        if (this.bandageStartSide === 'right' ? !reachedCenterFromLeft : !reachedCenterFromRight) return;
        this.bandagePassState = 'BACK_WAIT_START';
        if (this.bandageStartSide === 'right' ? rightReached : leftReached) {
          this.completeBandageRevolution(id);
        }
        break;

      case 'BACK_WAIT_START':
        if (this.bandageStartSide === 'right' ? !rightReached : !leftReached) return;
        this.completeBandageRevolution(id);
        break;
    }
  }

  private enterBandageBackPass(): void {
    this.bandagePassState = 'BACK_WAIT_CENTER';
    this.ui.notify('Agora passe por trás do membro.', 'info');
  }

  private completeBandageRevolution(id: BandageId): void {
    const completed = this.activity.completeBandageWrap(id);
    const wrap = this.activity.wrapCounts[id];
    this.workspace.bandageLayerSegments[id][wrap - 1]?.setEnabled(true);

    const bandage = this.workspace.pickables.get(id)!;
    bandage.visibility = 1;
    this.lastBandageLateral = this.bandageStartSide === 'left'
      ? this.workspace.bandageZones.leftTrigger
      : this.workspace.bandageZones.rightTrigger;

    if (completed) {
      this.drags.get(id)!.enabled = false;
      this.currentY.delete(id);
      this.targetY.delete(id);
      this.bandageSurfaceMemory.delete(id);
      this.bandageTargetMemory.delete(id);
      bandage.setEnabled(false);
      this.workspace.setInventoryPropActive(id, false);
      this.resetBandagePass();
      this.ui.notify(
        id === 'bandage-1' ? 'Primeira camada concluída.' : 'CURATIVO CONCLUÍDO',
        'success',
      );
      this.refreshSelection(id);
    } else {
      // A volta terminou no lado inicial. A próxima pode começar dali sem exigir
      // que o usuário acerte novamente uma pequena zona de início.
      this.bandagePassState = 'FRONT_WAIT_CENTER';
      this.ui.notify(
        `${id === 'bandage-1' ? 'Faixa 1' : 'Faixa 2'} — ${wrap} / 10. Passe pela frente.`,
        'success',
      );
    }

    this.ui.update(this.activity.snapshot);
  }

  private updateDebridement(position: Vector3): void {
    if (!this.isOnTreatment(position)) {
      this.lastDebridementPosition = position.clone();
      this.lastMovementAt = undefined;
      return;
    }

    const previous = this.lastDebridementPosition;
    if (!previous) return;
    const distance = Math.hypot(position.x - previous.x, position.z - previous.z);
    if (distance <= MIN_MOVEMENT_DISTANCE) return;

    this.lastDebridementPosition = position.clone();
    if (distance >= 0.06) {
      this.lastMovementAt = undefined;
      return;
    }

    const now = performance.now();
    const seconds = this.lastMovementAt
      ? Math.min((now - this.lastMovementAt) / 1000, MAX_MOVEMENT_SAMPLE_SECONDS)
      : 0;
    this.lastMovementAt = now;
    if (seconds <= 0) return;

    if (this.activity.addDebridementTime(seconds)) {
      this.drags.get('debrisoft-pad')!.enabled = false;
      this.ui.notify('Debridamento concluído. Posicione a gaze.', 'success');
      void this.returnToInitialPose('debrisoft-pad').then(() => {
        this.refreshSelection('debrisoft-pad');
      });
    }
    this.ui.update(this.activity.snapshot);
  }

  private async animateSolutionApplication(): Promise<void> {
    if (this.solutionAnimationRunning || !this.activity.beginSolutionApplication()) return;
    this.solutionAnimationRunning = true;
    const generation = ++this.solutionAnimationGeneration;
    const id: ObjectId = 'solution-bottle';
    this.drags.get(id)!.enabled = false;
    this.refreshSelection(id);
    this.currentY.delete(id);
    this.targetY.delete(id);

    const pourPivot = this.workspace.solutionPourPivot;
    const initialRotation = Quaternion.Identity();
    const pouringRotation = Quaternion.RotationAxis(Axis.Z, 110 * Math.PI / 180);
    await this.animatePose(pourPivot, pourPivot.position.clone(), pouringRotation, 420);
    if (generation !== this.solutionAnimationGeneration) return;
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    if (generation !== this.solutionAnimationGeneration) return;
    this.activity.completeSolutionApplication();
    this.ui.update(this.activity.snapshot);
    this.ui.notify('Solução aplicada. Inicie o debridamento.', 'success');
    await this.animatePose(pourPivot, pourPivot.position.clone(), initialRotation, 280);
    if (generation !== this.solutionAnimationGeneration) return;
    await this.returnToInitialPose(id);
    if (generation !== this.solutionAnimationGeneration) return;
    this.activity.markSolutionReturned();
    this.ui.update(this.activity.snapshot);
    this.solutionAnimationRunning = false;
    this.refreshSelection(id);
  }

  private async returnToInitialPose(id: ObjectId): Promise<void> {
    const mesh = this.workspace.pickables.get(id)!;
    if (this.workspace.gameMode === 'inventory') {
      this.currentY.delete(id);
      this.targetY.delete(id);
      this.workspace.setInventoryPropActive(id, false);
      this.refreshSelection(id);
      return;
    }
    const pose = OBJECT_INITIAL_POSES[id];
    const targetPosition = new Vector3(...pose.position);
    targetPosition.y = this.workspace.supportSurface.getTargetY(mesh, targetPosition, {
      preferredSupport: 'metal-tray',
    });
    this.poseAnimations.add(id);
    this.refreshSelection(id);
    this.currentY.delete(id);
    this.targetY.delete(id);

    await this.animatePose(
      mesh,
      targetPosition,
      Quaternion.FromEulerAngles(...pose.rotation),
      520,
    );

    this.currentY.set(id, targetPosition.y);
    this.targetY.set(id, targetPosition.y);
    this.poseAnimations.delete(id);
    this.refreshSelection(id);
  }

  private async returnBandageToSide(
    id: BandageId,
    side: BandageStartSide = 'right',
  ): Promise<void> {
    const mesh = this.workspace.pickables.get(id)!;
    if (this.workspace.gameMode === 'inventory') {
      this.currentY.delete(id);
      this.targetY.delete(id);
      this.bandageSurfaceMemory.delete(id);
      this.bandageTargetMemory.delete(id);
      this.workspace.setInventoryPropActive(id, false);
      this.refreshSelection(id);
      return;
    }
    this.poseAnimations.add(id);
    this.refreshSelection(id);
    this.currentY.delete(id);
    this.targetY.delete(id);
    this.bandageSurfaceMemory.delete(id);
    this.bandageTargetMemory.delete(id);

    const target = side === 'left'
      ? this.workspace.bandageZones.left.clone()
      : this.workspace.bandageRestartPoses[id].clone();
    if (side === 'left') target.y = this.workspace.bandageRestartPoses[id].y;
    await this.animatePose(
      mesh,
      target,
      Quaternion.FromEulerAngles(...OBJECT_INITIAL_POSES[id].rotation),
      520,
    );

    this.currentY.set(id, target.y);
    this.targetY.set(id, target.y);
    this.poseAnimations.delete(id);
    this.refreshSelection(id);
  }

  private animatePose(
    mesh: TransformNode,
    targetPosition: Vector3,
    targetRotation: Quaternion,
    durationMs: number,
  ): Promise<void> {
    const startPosition = mesh.position.clone();
    const startRotation = mesh.rotationQuaternion?.clone()
      ?? Quaternion.FromEulerAngles(mesh.rotation.x, mesh.rotation.y, mesh.rotation.z);
    mesh.rotationQuaternion = startRotation;
    const startedAt = performance.now();

    return new Promise((resolve) => {
      const observer = this.scene.onBeforeRenderObservable.add(() => {
        const linear = Math.min((performance.now() - startedAt) / durationMs, 1);
        const smooth = linear * linear * (3 - 2 * linear);
        Vector3.LerpToRef(startPosition, targetPosition, smooth, mesh.position);
        Quaternion.SlerpToRef(startRotation, targetRotation, smooth, mesh.rotationQuaternion!);
        if (linear < 1) return;
        this.scene.onBeforeRenderObservable.remove(observer);
        resolve();
      });
    });
  }

  private placeAtTreatmentSnap(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    const snap = this.workspace.treatmentSnap;
    const sample = this.workspace.anatomySurface.sampleTopSurfaceClamped(snap.x, snap.z);

    if (sample) {
      const position = sample.point.add(sample.normal.scale(this.surfaceOffsetFor(id)));
      mesh.position.copyFrom(position);
      mesh.rotationQuaternion = rotationFromUpToNormal(sample.normal);
      this.currentY.set(id, position.y);
      this.targetY.set(id, position.y);
    } else {
      const position = snap.clone();
      position.y = TREATMENT_MANIPULATION_SURFACE.height
        + this.activity.objects.get(id)!.treatmentOffset;
      mesh.position.copyFrom(position);
      this.currentY.set(id, position.y);
      this.targetY.set(id, position.y);
    }

    this.drags.get(id)!.enabled = false;
  }

  private resetTapeTraversal(): void {
    this.tapeStrokeStart = undefined;
    this.tapeCompletedPasses = 0;
  }

  private resetBandagePass(): void {
    this.bandagePassState = 'WAIT_START';
    this.bandageStartSide = undefined;
    this.activeBandage = undefined;
    this.lastBandageLateral = undefined;
  }

  private surfaceOffsetFor(id: ObjectId): number {
    return SURFACE_CONTACT_OFFSETS[id]
      ?? this.activity.objects.get(id)!.treatmentOffset;
  }

  private surfaceTargetY(id: ObjectId, position: Vector3): number {
    if (this.isBandage(id)) return this.bandageSurfaceTargetY(id, position);

    const sample = this.workspace.anatomySurface.sampleTopSurfaceClamped(
      position.x,
      position.z,
    );
    if (sample) {
      if (id === 'tape-strip') return this.rootYOnAnatomy(id, sample.point.y);
      return sample.point.y + this.surfaceOffsetFor(id);
    }

    return TREATMENT_MANIPULATION_SURFACE.height
      + this.activity.objects.get(id)!.treatmentOffset;
  }

  private bandageSurfaceTargetY(id: BandageId, position: Vector3): number {
    const sample = this.workspace.anatomySurface.sampleTopSurfaceClamped(
      position.x,
      position.z,
    );
    const now = performance.now();

    if (sample) {
      const y = this.rootYOnAnatomy(id, sample.point.y, MANIPULABLE_ANATOMY_CLEARANCE);
      this.bandageSurfaceMemory.set(id, { y, at: now });
      return y;
    }

    const memory = this.bandageSurfaceMemory.get(id);
    if (memory && now - memory.at <= BANDAGE_SURFACE_MEMORY_MS) return memory.y;
    if (memory) return memory.y;

    return TREATMENT_MANIPULATION_SURFACE.height
      + this.activity.objects.get(id)!.treatmentOffset;
  }

  private rootYOnAnatomy(
    id: ObjectId,
    surfaceY: number,
    clearance = MANIPULABLE_ANATOMY_CLEARANCE,
  ): number {
    const mesh = this.workspace.pickables.get(id)!;
    return surfaceY - this.workspace.supportSurface.getBottomOffset(mesh) + clearance;
  }

  private calculateTargetY(id: ObjectId, localPosition: Vector3): number {
    const mesh = this.workspace.pickables.get(id)!;
    const supportY = this.workspace.gameMode === 'inventory'
      ? this.workspace.treatmentSnap.y + this.activity.objects.get(id)!.treatmentOffset
      : this.workspace.supportSurface.getTargetY(mesh, localPosition, {
          preferredSupport: 'metal-tray',
        });

    if (this.isBandage(id)) {
      let rawTarget: number;
      if (
        this.activeBandage === id
        && (this.bandagePassState === 'BACK_WAIT_CENTER'
          || this.bandagePassState === 'BACK_WAIT_START')
      ) {
        rawTarget = this.workspace.gameMode === 'inventory'
          ? this.workspace.treatmentSnap.y - 0.09
          : supportY;
      } else {
        const treatmentY = this.bandageSurfaceTargetY(id, localPosition);
        const blend = this.bandageSurfaceBlend(localPosition);
        rawTarget = supportY + (treatmentY - supportY) * blend;
      }
      return this.stabilizeBandageTarget(id, rawTarget);
    }

    const treatmentY = this.surfaceTargetY(id, localPosition);
    return supportY + (treatmentY - supportY) * this.surfaceBlend(localPosition);
  }

  private stabilizeBandageTarget(id: BandageId, rawTarget: number): number {
    const previous = this.bandageTargetMemory.get(id);
    if (previous === undefined) {
      this.bandageTargetMemory.set(id, rawTarget);
      return rawTarget;
    }

    if (Math.abs(rawTarget - previous) < 0.0015) return previous;
    const next = previous + (rawTarget - previous) * BANDAGE_TARGET_BLEND;
    this.bandageTargetMemory.set(id, next);
    return next;
  }

  private surfaceBlend(localPosition: Vector3): number {
    const center = this.workspace.treatmentSnap;
    const distanceFromTreatment = Math.hypot(
      localPosition.x - center.x,
      localPosition.z - center.z,
    ) - TREATMENT_CONTACT_RADIUS;
    const proximity = Math.max(0, Math.min(
      1,
      (ELEVATION_START_DISTANCE - distanceFromTreatment)
        / (ELEVATION_START_DISTANCE - ELEVATION_END_DISTANCE),
    ));
    return proximity * proximity * (3 - 2 * proximity);
  }

  private bandageSurfaceBlend(localPosition: Vector3): number {
    const distance = this.workspace.anatomySurface.horizontalDistanceToBounds(
      localPosition.x,
      localPosition.z,
    );
    const proximity = Math.max(0, Math.min(
      1,
      (BANDAGE_ELEVATION_START_DISTANCE - distance)
        / (BANDAGE_ELEVATION_START_DISTANCE - BANDAGE_ELEVATION_END_DISTANCE),
    ));
    return proximity * proximity * (3 - 2 * proximity);
  }

  private axisValue(position: Vector3, axis: 'x' | 'z'): number {
    return axis === 'x' ? position.x : position.z;
  }

  private isOnTreatment(position: Vector3): boolean {
    return this.surfaceBlend(position) >= 0.96
      && Math.hypot(
        position.x - this.workspace.treatmentSnap.x,
        position.z - this.workspace.treatmentSnap.z,
      ) <= TREATMENT_CONTACT_RADIUS;
  }

  private isNearSolutionZone(position: Vector3): boolean {
    const safeBottleY = this.surfaceTargetY('solution-bottle', position);
    return this.surfaceBlend(position) >= 0.94
      && position.y >= safeBottleY - 0.010
      && Math.hypot(
        position.x - this.workspace.solutionZone.x,
        position.z - this.workspace.solutionZone.z,
      ) <= 0.055;
  }

  private updateAutomaticHeights(): void {
    for (const id of this.targetY.keys()) this.updateObjectHeight(id);
    const bottle = this.workspace.pickables.get('solution-bottle')!;
    if (
      this.activity.isHeld('solution-bottle')
      && this.activity.step === 1
      && this.isNearSolutionZone(bottle.position)
    ) {
      void this.animateSolutionApplication();
    }
  }

  private updateObjectHeight(id: ObjectId): void {
    const deltaSeconds = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
    const speed = this.isBandage(id)
      ? BANDAGE_HEIGHT_SMOOTHING_SPEED
      : HEIGHT_SMOOTHING_SPEED;
    const smoothing = 1 - Math.exp(-speed * deltaSeconds);
    const mesh = this.workspace.pickables.get(id)!;
    const targetY = this.targetY.get(id) ?? this.calculateTargetY(id, mesh.position);
    const currentY = this.currentY.get(id) ?? mesh.position.y;
    const nextY = currentY + (targetY - currentY) * smoothing;
    this.currentY.set(id, nextY);
    mesh.position.y = nextY;
  }

  private toWorkspaceLocal(worldPosition: Vector3): Vector3 {
    this.workspace.root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(
      worldPosition,
      Matrix.Invert(this.workspace.root.getWorldMatrix()),
    );
  }

  private inventoryPosition(clientX: number, clientY: number): Vector3 {
    const canvas = this.scene.getEngine().getRenderingCanvas();
    const camera = this.scene.activeCamera;
    const safeEntryPosition = this.workspace.treatmentSnap.add(
      new Vector3(0, 0, -INVENTORY_LONGITUDINAL_REACH),
    );
    if (!canvas || !camera) return safeEntryPosition;
    const bounds = canvas.getBoundingClientRect();
    const x = (clientX - bounds.left) * this.scene.getEngine().getRenderWidth() / bounds.width;
    const y = (clientY - bounds.top) * this.scene.getEngine().getRenderHeight() / bounds.height;
    const ray = this.scene.createPickingRay(x, y, Matrix.Identity(), camera);
    this.workspace.root.computeWorldMatrix(true);
    const world = this.workspace.root.getWorldMatrix();
    const planePoint = Vector3.TransformCoordinates(
      this.workspace.treatmentSnap,
      world,
    );
    const planeNormal = camera.globalPosition.subtract(planePoint).normalize();
    const distance = ray.intersectsPlane(Plane.FromPositionAndNormal(planePoint, planeNormal));
    if (distance === null) return safeEntryPosition;
    return this.toWorkspaceLocal(ray.origin.add(ray.direction.scale(distance)));
  }

  private objectId(mesh: AbstractMesh): ObjectId | undefined {
    let node: TransformNode | null = mesh;
    while (node) {
      const id = node.metadata?.objectId as ObjectId | undefined;
      if (id) return id;
      node = node.parent as TransformNode | null;
    }
    return undefined;
  }

  private meshes(id: ObjectId): AbstractMesh[] {
    const root = this.workspace.pickables.get(id)!;
    const children = root.getChildMeshes(false).filter((mesh) => mesh.getTotalVertices() > 0);
    return children.length ? children : [root];
  }

  private refreshSelection(id: ObjectId): void {
    const object = this.activity.objects.get(id)!;
    this.ui.showSelection(
      object.name,
      object.state,
      this.activity.isHeld(id),
      this.activity.canPick(id) && !this.poseAnimations.has(id),
    );
  }

  private invalidMessage(id: ObjectId): string {
    if (id === 'solution-bottle' && this.activity.step === 0) {
      return 'Posicione o Debrisoft antes de aplicar a solução.';
    }
    if (id === 'gauze' && this.activity.step < 3) {
      return 'Conclua o debridamento antes de aplicar a gaze.';
    }
    if (id === 'debrisoft-pad' && this.activity.step === 1) {
      return 'Aplique a solução antes de iniciar o debridamento.';
    }
    if (id === 'tape-strip' && this.activity.step < 4) {
      return 'Aplique a gaze antes de usar o esparadrapo.';
    }
    if (id === 'bandage-1' && this.activity.step < 5) {
      return 'Conclua a fixação antes de usar a primeira faixa.';
    }
    if (id === 'bandage-2' && this.activity.step < 6) {
      return 'Conclua a primeira faixa antes de usar a segunda.';
    }
    return 'Esse objeto não é necessário nesta etapa.';
  }

  private clearHighlight(): void {
    if (!this.selected) return;
    this.meshes(this.selected).forEach((mesh) => {
      this.highlight.removeMesh(mesh as Mesh);
    });
  }

  private clearSelectionState(): void {
    this.clearHighlight();
    this.selected = undefined;
    this.ui.clearSelection();
  }

  private isBandage(id: ObjectId): id is BandageId {
    return id === 'bandage-1' || id === 'bandage-2';
  }
}
