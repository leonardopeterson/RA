import {
  AbstractMesh, Color3, HighlightLayer, Matrix, Mesh, PointerDragBehavior,
  PointerEventTypes, Scene, Vector3,
} from '@babylonjs/core';
import { Activity, ObjectId } from './activity';
import type { UI } from './ui';
import { TREATMENT_MANIPULATION_SURFACE, WORKSPACE, Workspace } from './workspace';

const TABLE_SURFACE_OFFSET: Record<ObjectId, number> = {
  applicator: 0.029,
  cover: 0.019,
};

const TREATMENT_SURFACE_OFFSET: Record<ObjectId, number> = {
  applicator: 0.026,
  cover: 0.010,
};

const HEIGHT_SMOOTHING_SPEED = 10;
const ELEVATION_START_DISTANCE = 0.08;
const ELEVATION_END_DISTANCE = 0.015;

export class InteractionController {
  private selected?: ObjectId;
  private highlight: HighlightLayer;
  private drags = new Map<ObjectId, PointerDragBehavior>();
  private currentY = new Map<ObjectId, number>();
  private targetY = new Map<ObjectId, number>();
  private dragOffset = new Map<ObjectId, Vector3>();
  private lastContact?: Vector3;

  constructor(private scene: Scene, private workspace: Workspace, private activity: Activity, private ui: UI) {
    this.highlight = new HighlightLayer('selection-highlight', scene);
    this.highlight.innerGlow = false;
    this.setupDrag('applicator');
    this.setupDrag('cover');
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
    this.activity.select(id);
    this.meshes(id).forEach((mesh) => this.highlight.addMesh(mesh as Mesh, new Color3(0.2, 1, 0.66)));
    const object = this.activity.objects.get(id)!;
    this.ui.showSelection(id, object.name, object.state);
  }

  pickSelected(): void {
    if (!this.selected) return;
    if (!this.activity.pick(this.selected)) {
      this.ui.notify('Esse objeto ainda não é necessário.', 'error');
      return;
    }
    this.drags.get(this.selected)!.enabled = true;
    this.ui.showSelection(this.selected, this.activity.objects.get(this.selected)!.name, 'held');
    this.ui.update(this.activity.snapshot);
    this.ui.notify('Objeto em mãos. Arraste-o com o dedo.', 'info');
  }

  releaseSelected(): void {
    if (!this.selected) return;
    const id = this.selected;
    if (id === 'cover' && this.nearTarget(this.workspace.pickables.get(id)!.position, 0.075)) {
      if (this.activity.applyCover()) {
        this.workspace.pickables.get(id)!.position.copyFrom(this.workspace.coverSnap);
        this.currentY.set(id, this.workspace.coverSnap.y);
        this.targetY.set(id, this.workspace.coverSnap.y);
        this.drags.get(id)!.enabled = false;
        this.ui.notify('Cobertura posicionada corretamente.', 'success');
      }
    } else {
      this.activity.release(id);
      this.snapToSafeSurface(id);
      this.drags.get(id)!.enabled = false;
    }
    const state = this.activity.objects.get(id)!.state;
    this.ui.showSelection(id, this.activity.objects.get(id)!.name, state);
    this.ui.update(this.activity.snapshot);
  }

  private setupDrag(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    const drag = new PointerDragBehavior({ dragPlaneNormal: Vector3.Up() });
    // X/Z and the automatic Y are both applied here. Babylon must not write a
    // competing position while the pointer remains down.
    drag.moveAttached = false;
    drag.useObjectOrientationForDragging = false;
    drag.enabled = false;
    mesh.addBehavior(drag);
    drag.onDragStartObservable.add((event) => {
      this.lastContact = undefined;
      this.currentY.set(id, mesh.position.y);
      this.targetY.set(id, this.calculateTargetY(id, mesh.position));
      const pointerPosition = this.toWorkspaceLocal(event.dragPlanePoint);
      this.dragOffset.set(id, new Vector3(mesh.position.x - pointerPosition.x, 0, mesh.position.z - pointerPosition.z));
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

    if (id === 'applicator' && this.surfaceBlend(mesh.position) >= 0.98 && this.nearTarget(mesh.position, 0.09)) {
      const current = mesh.position.clone();
      if (this.lastContact) {
        const distance = Math.hypot(current.x - this.lastContact.x, current.z - this.lastContact.z);
        if (distance < 0.06 && this.activity.addTreatmentMotion(distance)) {
          this.drags.get(id)!.enabled = false;
          this.ui.notify('Área preparada. Agora aplique a cobertura.', 'success');
          this.ui.showSelection(id, this.activity.objects.get(id)!.name, 'used');
        }
      }
      this.lastContact = current;
      this.ui.update(this.activity.snapshot);
    } else if (id === 'applicator') this.lastContact = undefined;
  }

  private nearTarget(localPosition: Vector3, radius: number): boolean {
    const target = this.workspace.coverSnap;
    return Math.hypot(localPosition.x - target.x, localPosition.z - target.z) <= radius;
  }

  private snapToSafeSurface(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    this.targetY.set(id, this.calculateTargetY(id, mesh.position));
  }

  private calculateTargetY(id: ObjectId, localPosition: Vector3): number {
    const tableY = WORKSPACE.surfaceY + TABLE_SURFACE_OFFSET[id];
    const treatmentY = TREATMENT_MANIPULATION_SURFACE.height + TREATMENT_SURFACE_OFFSET[id];
    return tableY + (treatmentY - tableY) * this.surfaceBlend(localPosition);
  }

  private surfaceBlend(localPosition: Vector3): number {
    const surface = TREATMENT_MANIPULATION_SURFACE;
    const distanceX = localPosition.x - surface.centerX;
    const distanceZ = Math.max(Math.abs(localPosition.z - surface.centerZ) - surface.halfStraightLength, 0);
    const distanceFromBody = Math.hypot(distanceX, distanceZ) - surface.radius;
    const proximity = Math.max(0, Math.min(1,
      (ELEVATION_START_DISTANCE - distanceFromBody)
      / (ELEVATION_START_DISTANCE - ELEVATION_END_DISTANCE),
    ));
    return proximity * proximity * (3 - 2 * proximity);
  }

  private updateAutomaticHeights(): void {
    for (const id of this.targetY.keys()) this.updateObjectHeight(id);
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

  private clearHighlight(): void {
    if (!this.selected) return;
    this.meshes(this.selected).forEach((mesh) => this.highlight.removeMesh(mesh as Mesh));
  }
}
