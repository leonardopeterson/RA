import {
  AbstractMesh,
  Matrix,
  Node,
  Ray,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

export interface SupportPlacementOptions {
  preferredSupport?: string;
  clearance?: number;
}

interface RegisteredSupport {
  id: string;
  root: Node;
  meshes: AbstractMesh[];
  minY: number;
  maxY: number;
}

interface RecentSupport {
  id: string;
  height: number;
  at: number;
}

const DEFAULT_CLEARANCE = 0.0007;
const SUPPORT_MEMORY_MS = 180;

export class SupportSurfaceSystem {
  private supports = new Map<string, RegisteredSupport>();
  private bottomOffsets = new Map<number, number>();
  private recentSupport = new Map<number, RecentSupport>();

  constructor(private workspaceRoot: TransformNode) {}

  registerSupport(id: string, root: Node, meshes: AbstractMesh[]): void {
    const renderMeshes = this.renderMeshes(meshes);
    if (!renderMeshes.length) throw new Error(`Suporte ${id} não possui geometria utilizável.`);
    const bounds = this.boundsInWorkspace(renderMeshes);
    this.supports.set(id, { id, root, meshes: renderMeshes, minY: bounds.minY, maxY: bounds.maxY });
  }

  unregisterSupport(id: string): void {
    this.supports.delete(id);
  }

  invalidateObjectBounds(root: TransformNode): void {
    this.bottomOffsets.delete(root.uniqueId);
    this.recentSupport.delete(root.uniqueId);
  }

  placeOnSupport(
    objectRoot: TransformNode,
    preferredSupport?: string,
    clearance = DEFAULT_CLEARANCE,
  ): number {
    const targetY = this.getTargetY(objectRoot, objectRoot.position, {
      preferredSupport,
      clearance,
    });
    objectRoot.position.y = targetY;
    return targetY;
  }

  getTargetY(
    objectRoot: TransformNode,
    localPosition: Vector3,
    options: SupportPlacementOptions = {},
  ): number {
    const supportHeight = this.findSupportHeight(
      objectRoot,
      localPosition.x,
      localPosition.z,
      options.preferredSupport,
    );
    if (supportHeight === undefined) return objectRoot.position.y;

    const bottomOffset = this.getBottomOffset(objectRoot);
    return supportHeight - bottomOffset + (options.clearance ?? DEFAULT_CLEARANCE);
  }

  getBottomOffset(root: TransformNode): number {
    const cached = this.bottomOffsets.get(root.uniqueId);
    if (cached !== undefined) return cached;

    const meshes = this.renderMeshes([
      ...(root instanceof AbstractMesh ? [root] : []),
      ...root.getChildMeshes(false),
    ]);
    if (!meshes.length) throw new Error(`${root.name} não possui geometria para calcular apoio.`);

    const bounds = this.boundsInWorkspace(meshes);
    const offset = bounds.minY - root.position.y;
    this.bottomOffsets.set(root.uniqueId, offset);
    return offset;
  }

  private findSupportHeight(
    objectRoot: TransformNode,
    x: number,
    z: number,
    preferredSupport?: string,
  ): number | undefined {
    const now = performance.now();
    if (preferredSupport) {
      const preferred = this.supports.get(preferredSupport);
      const preferredHeight = preferred && !this.isSelfSupport(preferred, objectRoot)
        ? this.castSupport(preferred, x, z)
        : undefined;
      if (preferredHeight !== undefined) {
        this.recentSupport.set(objectRoot.uniqueId, {
          id: preferredSupport,
          height: preferredHeight,
          at: now,
        });
        return preferredHeight;
      }

      const recent = this.recentSupport.get(objectRoot.uniqueId);
      if (recent?.id === preferredSupport && now - recent.at <= SUPPORT_MEMORY_MS) {
        return recent.height;
      }
    }

    let highest: number | undefined;
    let supportId: string | undefined;
    for (const support of this.supports.values()) {
      if (support.id === preferredSupport) continue;
      if (this.isSelfSupport(support, objectRoot)) continue;
      const height = this.castSupport(support, x, z);
      if (height === undefined || (highest !== undefined && height <= highest)) continue;
      highest = height;
      supportId = support.id;
    }

    if (highest !== undefined && supportId) {
      this.recentSupport.set(objectRoot.uniqueId, { id: supportId, height: highest, at: now });
    }
    return highest;
  }

  private castSupport(support: RegisteredSupport, x: number, z: number): number | undefined {
    const margin = 0.05;
    const originLocal = new Vector3(x, support.maxY + margin, z);
    const length = support.maxY - support.minY + margin * 2;

    this.workspaceRoot.computeWorldMatrix(true);
    const workspaceWorld = this.workspaceRoot.getWorldMatrix();
    const inverseWorkspace = Matrix.Invert(workspaceWorld);
    const originWorld = Vector3.TransformCoordinates(originLocal, workspaceWorld);
    const directionWorld = Vector3.TransformNormal(Vector3.Down(), workspaceWorld).normalize();
    const ray = new Ray(originWorld, directionWorld, length);

    let highest: number | undefined;
    for (const mesh of support.meshes) {
      mesh.computeWorldMatrix(true);
      const pick = ray.intersectsMesh(mesh, false);
      if (!pick.hit || !pick.pickedPoint) continue;
      const localY = Vector3.TransformCoordinates(pick.pickedPoint, inverseWorkspace).y;
      if (highest === undefined || localY > highest) highest = localY;
    }
    return highest;
  }

  private boundsInWorkspace(meshes: AbstractMesh[]): { minY: number; maxY: number } {
    this.workspaceRoot.computeWorldMatrix(true);
    const inverseWorkspace = Matrix.Invert(this.workspaceRoot.getWorldMatrix());
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;

    for (const mesh of meshes) {
      mesh.computeWorldMatrix(true);
      for (const corner of mesh.getBoundingInfo().boundingBox.vectorsWorld) {
        const localY = Vector3.TransformCoordinates(corner, inverseWorkspace).y;
        minY = Math.min(minY, localY);
        maxY = Math.max(maxY, localY);
      }
    }
    return { minY, maxY };
  }

  private renderMeshes(meshes: AbstractMesh[]): AbstractMesh[] {
    return Array.from(new Set(meshes)).filter(
      (mesh) => mesh.getTotalVertices() > 0 && mesh.isEnabled(false),
    );
  }

  private isSelfSupport(support: RegisteredSupport, objectRoot: TransformNode): boolean {
    if (support.root === objectRoot) return true;
    return support.meshes.some((mesh) => {
      let node: Node | null = mesh;
      while (node) {
        if (node === objectRoot) return true;
        node = node.parent;
      }
      return false;
    });
  }
}
