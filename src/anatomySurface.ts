import {
  AbstractMesh,
  Matrix,
  Quaternion,
  Ray,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

export interface SurfaceSample {
  point: Vector3;
  normal: Vector3;
}

export function rotationFromUpToNormal(normal: Vector3): Quaternion {
  const from = Vector3.Up();
  const to = normal.normalize();
  const dot = Math.max(-1, Math.min(1, Vector3.Dot(from, to)));

  if (dot > 0.99999) return Quaternion.Identity();
  if (dot < -0.99999) return Quaternion.RotationAxis(Vector3.Right(), Math.PI);

  const axis = Vector3.Cross(from, to).normalize();
  return Quaternion.RotationAxis(axis, Math.acos(dot));
}

export class AnatomySurface {
  private meshes: AbstractMesh[] = [];
  private boundsMin = new Vector3(-0.1, 0, -0.2);
  private boundsMax = new Vector3(0.1, 0.25, 0.2);

  constructor(private workspaceRoot: TransformNode) {}

  setMeshes(meshes: AbstractMesh[]): void {
    this.meshes = meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    this.refreshBounds();
  }

  get ready(): boolean {
    return this.meshes.length > 0;
  }

  sampleTopSurface(x: number, z: number): SurfaceSample | null {
    if (!this.ready) return null;

    const margin = 0.08;
    const origin = new Vector3(x, this.boundsMax.y + margin, z);
    const length = this.boundsMax.y - this.boundsMin.y + margin * 2;

    return this.castLocal(origin, Vector3.Down(), length);
  }

  sampleCrossSection(z: number, samples = 50): SurfaceSample[] {
    if (!this.ready) return [];

    const centerX = (this.boundsMin.x + this.boundsMax.x) / 2;
    const defaultCenterY = (this.boundsMin.y + this.boundsMax.y) / 2;
    const verticalMargin = 0.06;
    const verticalLength = this.boundsMax.y - this.boundsMin.y + verticalMargin * 2;

    const top = this.castLocal(
      new Vector3(centerX, this.boundsMax.y + verticalMargin, z),
      Vector3.Down(),
      verticalLength,
    );

    const bottom = this.castLocal(
      new Vector3(centerX, this.boundsMin.y - verticalMargin, z),
      Vector3.Up(),
      verticalLength,
    );

    const centerY = top && bottom
      ? (top.point.y + bottom.point.y) / 2
      : defaultCenterY;

    const center = new Vector3(centerX, centerY, z);
    const radialRange = Math.max(
      this.boundsMax.x - this.boundsMin.x,
      this.boundsMax.y - this.boundsMin.y,
    );
    const rayRadius = radialRange * 0.75 + 0.06;
    const result: SurfaceSample[] = [];

    for (let i = 0; i < samples; i++) {
      const angle = (i / samples) * Math.PI * 2;
      const radialDirection = new Vector3(Math.cos(angle), Math.sin(angle), 0);
      const origin = center.add(radialDirection.scale(rayRadius));
      const hit = this.castLocal(origin, radialDirection.scale(-1), rayRadius * 2);

      if (!hit) return [];

      const outward = hit.point.subtract(center).normalize();
      if (Vector3.Dot(hit.normal, outward) < 0) hit.normal.scaleInPlace(-1);

      result.push(hit);
    }

    return result;
  }

  private castLocal(
    originLocal: Vector3,
    directionLocal: Vector3,
    length: number,
  ): SurfaceSample | null {
    this.workspaceRoot.computeWorldMatrix(true);
    const workspaceWorld = this.workspaceRoot.getWorldMatrix();
    const inverseWorkspace = Matrix.Invert(workspaceWorld);

    const originWorld = Vector3.TransformCoordinates(originLocal, workspaceWorld);
    const directionWorld = Vector3.TransformNormal(directionLocal, workspaceWorld).normalize();
    const ray = new Ray(originWorld, directionWorld, length);

    let closestDistance = Number.POSITIVE_INFINITY;
    let closestPoint: Vector3 | undefined;
    let closestNormal: Vector3 | undefined;

    for (const mesh of this.meshes) {
      mesh.computeWorldMatrix(true);
      const pick = ray.intersectsMesh(mesh, false);

      if (!pick.hit || !pick.pickedPoint || pick.distance >= closestDistance) continue;

      closestDistance = pick.distance;
      closestPoint = pick.pickedPoint.clone();
      closestNormal = pick.getNormal(true)?.normalize() ?? Vector3.Up();
    }

    if (!closestPoint || !closestNormal) return null;

    return {
      point: Vector3.TransformCoordinates(closestPoint, inverseWorkspace),
      normal: Vector3.TransformNormal(closestNormal, inverseWorkspace).normalize(),
    };
  }

  private refreshBounds(): void {
    if (!this.meshes.length) return;

    this.workspaceRoot.computeWorldMatrix(true);
    const inverseWorkspace = Matrix.Invert(this.workspaceRoot.getWorldMatrix());

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

    for (const mesh of this.meshes) {
      mesh.computeWorldMatrix(true);
      const corners = mesh.getBoundingInfo().boundingBox.vectorsWorld;

      for (const corner of corners) {
        const local = Vector3.TransformCoordinates(corner, inverseWorkspace);
        min.x = Math.min(min.x, local.x);
        min.y = Math.min(min.y, local.y);
        min.z = Math.min(min.z, local.z);
        max.x = Math.max(max.x, local.x);
        max.y = Math.max(max.y, local.y);
        max.z = Math.max(max.z, local.z);
      }
    }

    this.boundsMin.copyFrom(min);
    this.boundsMax.copyFrom(max);
  }
}
