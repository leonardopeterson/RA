import {
  AbstractMesh, Axis, Color3, HighlightLayer, Matrix, Mesh, PointerDragBehavior,
  PointerEventTypes, Quaternion, Scene, Vector3,
} from '@babylonjs/core';
import { Activity, OBJECT_INITIAL_POSES, type ObjectId } from './activity';
import type { UI } from './ui';
import { TREATMENT_MANIPULATION_SURFACE, WORKSPACE, type Workspace } from './workspace';

const HEIGHT_SMOOTHING_SPEED = 10;
const ELEVATION_START_DISTANCE = 0.08;
const ELEVATION_END_DISTANCE = 0.015;
const MIN_MOVEMENT_DISTANCE = 0.0015;
const MAX_MOVEMENT_SAMPLE_SECONDS = 0.1;
const TREATMENT_CONTACT_RADIUS = 0.052;

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
  private poseAnimations = new Set<ObjectId>();

  constructor(private scene: Scene, private workspace: Workspace, private activity: Activity, private ui: UI) {
    this.highlight = new HighlightLayer('selection-highlight', scene);
    this.highlight.innerGlow = false;
    this.setupDrag('debrisoft-pad');
    this.setupDrag('solution-bottle');
    this.setupDrag('gauze');
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
    this.meshes(id).forEach((mesh) => this.highlight.addMesh(mesh as Mesh, new Color3(0.2, 1, 0.66)));
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
    this.ui.notify('Objeto em mãos. Arraste-o com o dedo.', 'info');
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
        this.placeAtTreatmentSnap(id);
        this.ui.notify('Primeira etapa concluída.', 'success');
      }
    } else {
      this.activity.release(id);
      this.targetY.set(id, this.calculateTargetY(id, mesh.position));
      if (id === 'solution-bottle') void this.returnToInitialPose(id);
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
      this.dragOffset.set(id, new Vector3(mesh.position.x - pointerPosition.x, 0, mesh.position.z - pointerPosition.z));
      if (id === 'debrisoft-pad') {
        this.lastDebridementPosition = mesh.position.clone();
        this.lastMovementAt = undefined;
      }
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
    mesh.position.x = Math.max(-WORKSPACE.halfWidth + 0.025, Math.min(WORKSPACE.halfWidth - 0.025, mesh.position.x));
    mesh.position.z = Math.max(-WORKSPACE.halfDepth + 0.025, Math.min(WORKSPACE.halfDepth - 0.025, mesh.position.z));
    this.targetY.set(id, this.calculateTargetY(id, mesh.position));
    mesh.position.y = this.currentY.get(id) ?? mesh.position.y;

    if (id === 'solution-bottle' && this.activity.step === 1 && this.isNearSolutionZone(mesh.position)) {
      void this.animateSolutionApplication();
    } else if (id === 'debrisoft-pad' && this.activity.step === 2) {
      this.updateDebridement(mesh.position);
    }
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
      void this.returnToInitialPose('debrisoft-pad').then(() => this.refreshSelection('debrisoft-pad'));
    }
    this.ui.update(this.activity.snapshot);
  }

  private async animateSolutionApplication(): Promise<void> {
    if (this.solutionAnimationRunning || !this.activity.beginSolutionApplication()) return;
    this.solutionAnimationRunning = true;
    const id: ObjectId = 'solution-bottle';
    const bottle = this.workspace.pickables.get(id)!;
    this.drags.get(id)!.enabled = false;
    this.refreshSelection(id);
    this.currentY.delete(id);
    this.targetY.delete(id);

    const initialRotation = Quaternion.FromEulerAngles(...OBJECT_INITIAL_POSES[id].rotation);
    // The provisional bottle is authored upright on local Y, so rotation around
    // its local Z axis produces the visible pouring motion toward the pad.
    const pouringRotation = initialRotation.multiply(Quaternion.RotationAxis(Axis.Z, 160 * Math.PI / 180));
    await this.animatePose(bottle, bottle.position.clone(), pouringRotation, 420);
    await new Promise((resolve) => window.setTimeout(resolve, 650));
    this.activity.completeSolutionApplication();
    this.ui.update(this.activity.snapshot);
    this.ui.notify('Solução aplicada. Inicie o debridamento.', 'success');
    await this.returnToInitialPose(id);
    this.activity.markSolutionReturned();
    this.solutionAnimationRunning = false;
    this.refreshSelection(id);
  }

  private async returnToInitialPose(id: ObjectId): Promise<void> {
    const mesh = this.workspace.pickables.get(id)!;
    const pose = OBJECT_INITIAL_POSES[id];
    this.poseAnimations.add(id);
    this.refreshSelection(id);
    this.currentY.delete(id);
    this.targetY.delete(id);
    await this.animatePose(
      mesh,
      new Vector3(...pose.position),
      Quaternion.FromEulerAngles(...pose.rotation),
      520,
    );
    this.currentY.set(id, pose.position[1]);
    this.targetY.set(id, pose.position[1]);
    this.poseAnimations.delete(id);
    this.refreshSelection(id);
  }

  private animatePose(mesh: AbstractMesh, targetPosition: Vector3, targetRotation: Quaternion, durationMs: number): Promise<void> {
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
    const position = this.workspace.treatmentSnap.clone();
    position.y = TREATMENT_MANIPULATION_SURFACE.height + this.activity.objects.get(id)!.treatmentOffset;
    mesh.position.copyFrom(position);
    this.currentY.set(id, position.y);
    this.targetY.set(id, position.y);
    this.drags.get(id)!.enabled = false;
  }

  private calculateTargetY(id: ObjectId, localPosition: Vector3): number {
    const object = this.activity.objects.get(id)!;
    const tableY = WORKSPACE.surfaceY + object.tableOffset;
    const treatmentY = TREATMENT_MANIPULATION_SURFACE.height + object.treatmentOffset;
    return tableY + (treatmentY - tableY) * this.surfaceBlend(localPosition);
  }

  private surfaceBlend(localPosition: Vector3): number {
    const surface = TREATMENT_MANIPULATION_SURFACE;
    const distanceX = localPosition.x - surface.centerX;
    const distanceZ = Math.max(Math.abs(localPosition.z - surface.centerZ) - surface.halfStraightLength, 0);
    const distanceFromBody = Math.hypot(distanceX, distanceZ) - surface.radius;
    const proximity = Math.max(0, Math.min(1,
      (ELEVATION_START_DISTANCE - distanceFromBody) / (ELEVATION_START_DISTANCE - ELEVATION_END_DISTANCE),
    ));
    return proximity * proximity * (3 - 2 * proximity);
  }

  private isOnTreatment(position: Vector3): boolean {
    return this.surfaceBlend(position) >= 0.98
      && Math.hypot(position.x - this.workspace.treatmentSnap.x, position.z - this.workspace.treatmentSnap.z) <= TREATMENT_CONTACT_RADIUS;
  }

  private isNearSolutionZone(position: Vector3): boolean {
    const safeBottleY = TREATMENT_MANIPULATION_SURFACE.height + this.activity.objects.get('solution-bottle')!.treatmentOffset;
    return this.surfaceBlend(position) >= 0.98
      && position.y >= safeBottleY - 0.008
      && Math.hypot(position.x - this.workspace.solutionZone.x, position.z - this.workspace.solutionZone.z) <= 0.055;
  }

  private updateAutomaticHeights(): void {
    for (const id of this.targetY.keys()) this.updateObjectHeight(id);
    const bottle = this.workspace.pickables.get('solution-bottle')!;
    if (this.activity.isHeld('solution-bottle') && this.activity.step === 1 && this.isNearSolutionZone(bottle.position)) {
      void this.animateSolutionApplication();
    }
  }

  private updateObjectHeight(id: ObjectId): void {
    const deltaSeconds = Math.min(this.scene.getEngine().getDeltaTime() / 1000, 0.05);
    const smoothing = 1 - Math.exp(-HEIGHT_SMOOTHING_SPEED * deltaSeconds);
    const mesh = this.workspace.pickables.get(id)!;
    const targetY = this.targetY.get(id) ?? this.calculateTargetY(id, mesh.position);
    const currentY = this.currentY.get(id) ?? mesh.position.y;
    const nextY = currentY + (targetY - currentY) * smoothing;
    this.currentY.set(id, nextY);
    mesh.position.y = nextY;
  }

  private toWorkspaceLocal(worldPosition: Vector3): Vector3 {
    this.workspace.root.computeWorldMatrix(true);
    return Vector3.TransformCoordinates(worldPosition, Matrix.Invert(this.workspace.root.getWorldMatrix()));
  }

  private objectId(mesh: AbstractMesh): ObjectId | undefined {
    let node: AbstractMesh | null = mesh;
    while (node) {
      const id = node.metadata?.objectId as ObjectId | undefined;
      if (id) return id;
      node = node.parent as AbstractMesh | null;
    }
    return undefined;
  }

  private meshes(id: ObjectId): AbstractMesh[] {
    const root = this.workspace.pickables.get(id)!;
    return root.getChildMeshes(false).length ? root.getChildMeshes(false) : [root];
  }

  private refreshSelection(id: ObjectId): void {
    const object = this.activity.objects.get(id)!;
    this.ui.showSelection(
      id,
      object.name,
      object.state,
      this.activity.isHeld(id),
      this.activity.canPick(id) && !this.poseAnimations.has(id),
    );
  }

  private invalidMessage(id: ObjectId): string {
    if (id === 'solution-bottle' && this.activity.step === 0) return 'Posicione o Debrisoft antes de aplicar a solução.';
    if (id === 'gauze' && this.activity.step < 3) return 'Conclua o debridamento antes de aplicar a gaze.';
    if (id === 'debrisoft-pad' && this.activity.step === 1) return 'Aplique a solução antes de iniciar o debridamento.';
    return 'Esse objeto não é necessário nesta etapa.';
  }

  private clearHighlight(): void {
    if (!this.selected) return;
    this.meshes(this.selected).forEach((mesh) => this.highlight.removeMesh(mesh as Mesh));
  }
}
