import {
  AbstractMesh, Color3, HighlightLayer, Matrix, Mesh, PointerDragBehavior,
  PointerEventTypes, Scene, Vector3,
} from '@babylonjs/core';
import { Activity, ObjectId } from './activity';
import type { UI } from './ui';
import { WORKSPACE, Workspace } from './workspace';

export class InteractionController {
  private selected?: ObjectId;
  private highlight: HighlightLayer;
  private drags = new Map<ObjectId, PointerDragBehavior>();
  private lastContact?: Vector3;

  constructor(private scene: Scene, private workspace: Workspace, private activity: Activity, private ui: UI) {
    this.highlight = new HighlightLayer('selection-highlight', scene);
    this.highlight.innerGlow = false;
    this.setupDrag('applicator');
    this.setupDrag('cover');
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
    drag.moveAttached = true;
    drag.useObjectOrientationForDragging = false;
    drag.enabled = false;
    mesh.addBehavior(drag);
    drag.onDragStartObservable.add(() => { this.lastContact = undefined; });
    drag.onDragObservable.add(() => this.validateMove(id));
    drag.onDragEndObservable.add(() => this.validateMove(id));
    this.drags.set(id, drag);
  }

  private validateMove(id: ObjectId): void {
    const mesh = this.workspace.pickables.get(id)!;
    mesh.position.x = Math.max(-WORKSPACE.halfWidth + 0.025, Math.min(WORKSPACE.halfWidth - 0.025, mesh.position.x));
    mesh.position.z = Math.max(-WORKSPACE.halfDepth + 0.025, Math.min(WORKSPACE.halfDepth - 0.025, mesh.position.z));
    mesh.position.y = id === 'applicator' ? 0.175 : 0.07;

    if (id === 'applicator' && this.nearTarget(mesh.position, 0.09)) {
      mesh.position.y = 0.185;
      const current = mesh.position.clone();
      if (this.lastContact) {
        const distance = Vector3.Distance(current, this.lastContact);
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
    mesh.position.y = id === 'applicator' ? 0.055 : 0.045;
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
