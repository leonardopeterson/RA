import {
  AbstractMesh,
  Matrix,
  Quaternion,
  Ray,
  TransformNode,
  Vector3,
} from '@babylonjs/core';

export type HorizontalAxis = 'x' | 'z';

export interface SurfaceSample {
  point: Vector3;
  normal: Vector3;
}

export interface AnatomySurfaceDiagnostics {
  dragQueries: number;
  robustQueries: number;
  raycasts: number;
  hits: number;
  misses: number;
  retries: number;
  totalMilliseconds: number;
}

interface CastContext {
  workspaceWorld: Matrix;
  inverseWorkspace: Matrix;
}

const ROBUST_SAMPLE_OFFSETS = [0, 0.004, -0.004, 0.008, -0.008, 0.014, -0.014, 0.022, -0.022];
const PERFORMANCE_DEBUG = false;

export interface AnatomyFrame {
  longitudinalAxis: HorizontalAxis;
  lateralAxis: HorizontalAxis;
  minLongitudinal: number;
  maxLongitudinal: number;
  centerLongitudinal: number;
  minLateral: number;
  maxLateral: number;
  centerLateral: number;
  minY: number;
  maxY: number;
  length: number;
  width: number;
  height: number;
  distalAtMin: boolean;
}

export interface CrossSectionStats {
  center: Vector3;
  minLateral: number;
  maxLateral: number;
  minY: number;
  maxY: number;
  meanRadius: number;
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
  private currentFrame?: AnatomyFrame;
  private crossSectionCache = new Map<string, SurfaceSample[]>();
  private performanceDebug = PERFORMANCE_DEBUG;
  private diagnostics: AnatomySurfaceDiagnostics = this.emptyDiagnostics();

  constructor(private workspaceRoot: TransformNode) {}

  setMeshes(meshes: AbstractMesh[]): void {
    this.meshes = meshes.filter((mesh) => mesh.getTotalVertices() > 0);
    this.crossSectionCache.clear();
    this.refreshBounds();
    this.refreshFrame();
  }

  get ready(): boolean {
    return this.meshes.length > 0;
  }

  get frame(): AnatomyFrame | undefined {
    return this.currentFrame;
  }

  setPerformanceDebug(enabled: boolean): void {
    this.performanceDebug = enabled;
    this.resetPerformanceDiagnostics();
  }

  getPerformanceDiagnostics(): Readonly<AnatomySurfaceDiagnostics> {
    return { ...this.diagnostics };
  }

  resetPerformanceDiagnostics(): void {
    this.diagnostics = this.emptyDiagnostics();
  }

  longitudinalCoordinate(point: Vector3): number {
    const frame = this.requireFrame();
    return frame.longitudinalAxis === 'x' ? point.x : point.z;
  }

  lateralCoordinate(point: Vector3): number {
    const frame = this.requireFrame();
    return frame.lateralAxis === 'x' ? point.x : point.z;
  }

  longitudinalBasis(): Vector3 {
    const frame = this.requireFrame();
    return frame.longitudinalAxis === 'x'
      ? new Vector3(1, 0, 0)
      : new Vector3(0, 0, 1);
  }

  lateralBasis(): Vector3 {
    const frame = this.requireFrame();
    return frame.lateralAxis === 'x'
      ? new Vector3(1, 0, 0)
      : new Vector3(0, 0, 1);
  }

  pointFromCoordinates(longitudinal: number, lateral: number, y: number): Vector3 {
    const frame = this.requireFrame();
    return frame.longitudinalAxis === 'x'
      ? new Vector3(longitudinal, y, lateral)
      : new Vector3(lateral, y, longitudinal);
  }

  coordinateFromDistalFraction(fraction: number): number {
    const frame = this.requireFrame();
    const t = Math.max(0, Math.min(1, fraction));
    return frame.distalAtMin
      ? frame.minLongitudinal + frame.length * t
      : frame.maxLongitudinal - frame.length * t;
  }

  coordinateFromDistalDistance(distanceMeters: number): number {
    const frame = this.requireFrame();
    const distance = Math.max(0, Math.min(frame.length, distanceMeters));
    return frame.distalAtMin
      ? frame.minLongitudinal + distance
      : frame.maxLongitudinal - distance;
  }

  offsetTowardProximal(longitudinal: number, distanceMeters: number): number {
    const frame = this.requireFrame();
    const sign = frame.distalAtMin ? 1 : -1;
    return Math.max(
      frame.minLongitudinal,
      Math.min(frame.maxLongitudinal, longitudinal + sign * distanceMeters),
    );
  }

  sampleTopSurface(x: number, z: number): SurfaceSample | null {
    if (!this.ready) return null;
    const context = this.createCastContext();
    return this.sampleTopSurfaceWithContext(x, z, context);
  }

  sampleTopSurfaceForDrag(x: number, z: number): SurfaceSample | null {
    const startedAt = this.performanceDebug ? performance.now() : 0;
    if (this.performanceDebug) this.diagnostics.dragQueries += 1;
    if (!this.ready || !this.isWithinHorizontalBounds(x, z)) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }

    const context = this.createCastContext();
    const direct = this.sampleTopSurfaceWithContext(x, z, context);
    if (direct) {
      this.finishDiagnosticQuery(startedAt, true);
      return direct;
    }

    const frame = this.currentFrame;
    if (!frame) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }

    const edgeMargin = Math.min(0.008, frame.width * 0.10, frame.length * 0.025);
    const nearEdge = x - this.boundsMin.x <= edgeMargin
      || this.boundsMax.x - x <= edgeMargin
      || z - this.boundsMin.z <= edgeMargin
      || this.boundsMax.z - z <= edgeMargin;
    if (!nearEdge) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }

    const inset = Math.min(0.004, frame.width * 0.06, frame.length * 0.015);
    const correctedX = Math.max(this.boundsMin.x + inset, Math.min(this.boundsMax.x - inset, x));
    const correctedZ = Math.max(this.boundsMin.z + inset, Math.min(this.boundsMax.z - inset, z));
    if (correctedX === x && correctedZ === z) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }

    if (this.performanceDebug) this.diagnostics.retries += 1;
    const corrected = this.sampleTopSurfaceWithContext(correctedX, correctedZ, context);
    this.finishDiagnosticQuery(startedAt, Boolean(corrected));
    return corrected;
  }

  private sampleTopSurfaceWithContext(x: number, z: number, context: CastContext): SurfaceSample | null {
    const margin = Math.max(0.08, (this.boundsMax.y - this.boundsMin.y) * 0.35);
    const origin = new Vector3(x, this.boundsMax.y + margin, z);
    const length = this.boundsMax.y - this.boundsMin.y + margin * 2;
    return this.castLocal(origin, Vector3.Down(), length, context);
  }

  sampleTopSurfaceClamped(x: number, z: number): SurfaceSample | null {
    const startedAt = this.performanceDebug ? performance.now() : 0;
    if (this.performanceDebug) this.diagnostics.robustQueries += 1;
    if (!this.ready) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }
    const context = this.createCastContext();
    const direct = this.sampleTopSurfaceWithContext(x, z, context);
    if (direct) {
      this.finishDiagnosticQuery(startedAt, true);
      return direct;
    }

    const frame = this.currentFrame;
    if (!frame) {
      this.finishDiagnosticQuery(startedAt, false);
      return null;
    }

    const inset = Math.min(0.004, frame.width * 0.06, frame.length * 0.015);
    const clampedX = Math.max(this.boundsMin.x + inset, Math.min(this.boundsMax.x - inset, x));
    const clampedZ = Math.max(this.boundsMin.z + inset, Math.min(this.boundsMax.z - inset, z));

    const clamped = this.sampleTopSurfaceWithContext(clampedX, clampedZ, context);
    if (clamped) {
      this.finishDiagnosticQuery(startedAt, true);
      return clamped;
    }

    for (const dx of ROBUST_SAMPLE_OFFSETS) {
      for (const dz of ROBUST_SAMPLE_OFFSETS) {
        const candidateX = Math.max(
          this.boundsMin.x + inset,
          Math.min(this.boundsMax.x - inset, clampedX + dx),
        );
        const candidateZ = Math.max(
          this.boundsMin.z + inset,
          Math.min(this.boundsMax.z - inset, clampedZ + dz),
        );
        const sample = this.sampleTopSurfaceWithContext(candidateX, candidateZ, context);
        if (sample) {
          this.finishDiagnosticQuery(startedAt, true);
          return sample;
        }
      }
    }
    this.finishDiagnosticQuery(startedAt, false);
    return null;
  }

  sampleTopSurfaceAtDistalFraction(
    longitudinalFraction: number,
    lateralFraction = 0.5,
  ): SurfaceSample | null {
    const frame = this.currentFrame;
    if (!frame) return null;

    const longitudinal = this.coordinateFromDistalFraction(longitudinalFraction);
    const lateral = frame.minLateral
      + frame.width * Math.max(0, Math.min(1, lateralFraction));
    const point = this.pointFromCoordinates(longitudinal, lateral, frame.maxY);
    return this.sampleTopSurfaceClamped(point.x, point.z);
  }

  sampleCrossSectionAt(longitudinal: number, samples = 50): SurfaceSample[] {
    const frame = this.currentFrame;
    if (!frame || !this.ready || samples < 8) return [];

    const coordinate = Math.max(frame.minLongitudinal, Math.min(frame.maxLongitudinal, longitudinal));
    const cacheKey = `${coordinate.toFixed(5)}:${samples}`;
    const cached = this.crossSectionCache.get(cacheKey);
    if (cached) {
      return cached.map((sample) => ({ point: sample.point.clone(), normal: sample.normal.clone() }));
    }

    const centerLateral = frame.centerLateral;
    const verticalMargin = Math.max(0.045, frame.height * 0.30);
    const verticalLength = frame.height + verticalMargin * 2;

    const topOrigin = this.pointFromCoordinates(
      coordinate,
      centerLateral,
      frame.maxY + verticalMargin,
    );
    const bottomOrigin = this.pointFromCoordinates(
      coordinate,
      centerLateral,
      frame.minY - verticalMargin,
    );

    const top = this.castLocal(topOrigin, Vector3.Down(), verticalLength);
    const bottom = this.castLocal(bottomOrigin, Vector3.Up(), verticalLength);
    const centerY = top && bottom
      ? (top.point.y + bottom.point.y) / 2
      : (frame.minY + frame.maxY) / 2;

    const center = this.pointFromCoordinates(coordinate, centerLateral, centerY);
    const radialRange = Math.max(frame.width, frame.height);
    const rayRadius = radialRange * 0.9 + 0.06;
    const lateralBasis = this.lateralBasis();

    const hits: Array<SurfaceSample | null> = [];
    const angularRetry = [0, 0.018, -0.018, 0.036, -0.036];

    for (let i = 0; i < samples; i++) {
      const baseAngle = (i / samples) * Math.PI * 2;
      let hit: SurfaceSample | null = null;

      for (const angleOffset of angularRetry) {
        const angle = baseAngle + angleOffset;
        const radialDirection = lateralBasis.scale(Math.cos(angle))
          .add(Vector3.Up().scale(Math.sin(angle)))
          .normalize();
        const origin = center.add(radialDirection.scale(rayRadius));
        hit = this.castLocal(origin, radialDirection.scale(-1), rayRadius * 2);
        if (hit) {
          const outward = hit.point.subtract(center).normalize();
          if (Vector3.Dot(hit.normal, outward) < 0) hit.normal.scaleInPlace(-1);
          break;
        }
      }

      hits.push(hit);
    }

    const validCount = hits.reduce((count, hit) => count + (hit ? 1 : 0), 0);
    if (validCount < Math.ceil(samples * 0.72)) return [];

    const filled = this.fillMissingCircularSamples(hits);
    if (!filled.length) return [];

    this.crossSectionCache.set(
      cacheKey,
      filled.map((sample) => ({ point: sample.point.clone(), normal: sample.normal.clone() })),
    );
    return filled;
  }

  sampleCrossSectionAtDistalFraction(fraction: number, samples = 50): SurfaceSample[] {
    return this.sampleCrossSectionAt(this.coordinateFromDistalFraction(fraction), samples);
  }

  crossSectionStats(longitudinal: number, samples = 50): CrossSectionStats | null {
    const frame = this.currentFrame;
    if (!frame) return null;
    const section = this.sampleCrossSectionAt(longitudinal, samples);
    if (!section.length) return null;

    const center = section
      .reduce((sum, sample) => sum.add(sample.point), Vector3.Zero())
      .scale(1 / section.length);

    let minLateral = Number.POSITIVE_INFINITY;
    let maxLateral = Number.NEGATIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    let radiusSum = 0;

    for (const sample of section) {
      const lateral = frame.lateralAxis === 'x' ? sample.point.x : sample.point.z;
      minLateral = Math.min(minLateral, lateral);
      maxLateral = Math.max(maxLateral, lateral);
      minY = Math.min(minY, sample.point.y);
      maxY = Math.max(maxY, sample.point.y);
      radiusSum += Vector3.Distance(center, sample.point);
    }

    return {
      center,
      minLateral,
      maxLateral,
      minY,
      maxY,
      meanRadius: radiusSum / section.length,
    };
  }

  horizontalDistanceToBounds(x: number, z: number): number {
    if (!this.currentFrame) return Number.POSITIVE_INFINITY;

    const dx = x < this.boundsMin.x
      ? this.boundsMin.x - x
      : x > this.boundsMax.x
        ? x - this.boundsMax.x
        : 0;
    const dz = z < this.boundsMin.z
      ? this.boundsMin.z - z
      : z > this.boundsMax.z
        ? z - this.boundsMax.z
        : 0;
    return Math.hypot(dx, dz);
  }

  private fillMissingCircularSamples(samples: Array<SurfaceSample | null>): SurfaceSample[] {
    if (!samples.some(Boolean)) return [];
    const result: SurfaceSample[] = new Array(samples.length);

    for (let i = 0; i < samples.length; i++) {
      const current = samples[i];
      if (current) {
        result[i] = { point: current.point.clone(), normal: current.normal.clone() };
        continue;
      }

      let previousIndex = i;
      let nextIndex = i;
      for (let step = 1; step < samples.length; step++) {
        const candidate = (i - step + samples.length) % samples.length;
        if (samples[candidate]) {
          previousIndex = candidate;
          break;
        }
      }
      for (let step = 1; step < samples.length; step++) {
        const candidate = (i + step) % samples.length;
        if (samples[candidate]) {
          nextIndex = candidate;
          break;
        }
      }

      const previous = samples[previousIndex];
      const next = samples[nextIndex];
      if (!previous || !next) return [];

      const forwardDistance = (nextIndex - previousIndex + samples.length) % samples.length;
      const currentDistance = (i - previousIndex + samples.length) % samples.length;
      const t = forwardDistance > 0 ? currentDistance / forwardDistance : 0;

      result[i] = {
        point: Vector3.Lerp(previous.point, next.point, t),
        normal: Vector3.Lerp(previous.normal, next.normal, t).normalize(),
      };
    }

    return result;
  }

  private requireFrame(): AnatomyFrame {
    if (!this.currentFrame) {
      throw new Error('AnatomySurface ainda não possui frame anatômico.');
    }
    return this.currentFrame;
  }

  private castLocal(
    originLocal: Vector3,
    directionLocal: Vector3,
    length: number,
    context = this.createCastContext(),
  ): SurfaceSample | null {
    const { workspaceWorld, inverseWorkspace } = context;

    const originWorld = Vector3.TransformCoordinates(originLocal, workspaceWorld);
    const directionWorld = Vector3.TransformNormal(directionLocal, workspaceWorld).normalize();
    const ray = new Ray(originWorld, directionWorld, length);
    if (this.performanceDebug) this.diagnostics.raycasts += 1;

    let closestDistance = Number.POSITIVE_INFINITY;
    let closestPoint: Vector3 | undefined;
    let closestNormal: Vector3 | undefined;

    for (const mesh of this.meshes) {
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

  private createCastContext(): CastContext {
    this.workspaceRoot.computeWorldMatrix(true);
    for (const mesh of this.meshes) mesh.computeWorldMatrix(true);
    const workspaceWorld = this.workspaceRoot.getWorldMatrix();
    return {
      workspaceWorld,
      inverseWorkspace: Matrix.Invert(workspaceWorld),
    };
  }

  private isWithinHorizontalBounds(x: number, z: number): boolean {
    return x >= this.boundsMin.x && x <= this.boundsMax.x
      && z >= this.boundsMin.z && z <= this.boundsMax.z;
  }

  private finishDiagnosticQuery(startedAt: number, hit: boolean): void {
    if (!this.performanceDebug) return;
    if (hit) this.diagnostics.hits += 1;
    else this.diagnostics.misses += 1;
    this.diagnostics.totalMilliseconds += performance.now() - startedAt;
  }

  private emptyDiagnostics(): AnatomySurfaceDiagnostics {
    return {
      dragQueries: 0,
      robustQueries: 0,
      raycasts: 0,
      hits: 0,
      misses: 0,
      retries: 0,
      totalMilliseconds: 0,
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

  private refreshFrame(): void {
    if (!this.meshes.length) {
      this.currentFrame = undefined;
      return;
    }

    const xLength = this.boundsMax.x - this.boundsMin.x;
    const zLength = this.boundsMax.z - this.boundsMin.z;
    const longitudinalAxis: HorizontalAxis = xLength >= zLength ? 'x' : 'z';
    const lateralAxis: HorizontalAxis = longitudinalAxis === 'x' ? 'z' : 'x';

    const minLongitudinal = longitudinalAxis === 'x' ? this.boundsMin.x : this.boundsMin.z;
    const maxLongitudinal = longitudinalAxis === 'x' ? this.boundsMax.x : this.boundsMax.z;
    const minLateral = lateralAxis === 'x' ? this.boundsMin.x : this.boundsMin.z;
    const maxLateral = lateralAxis === 'x' ? this.boundsMax.x : this.boundsMax.z;

    this.currentFrame = {
      longitudinalAxis,
      lateralAxis,
      minLongitudinal,
      maxLongitudinal,
      centerLongitudinal: (minLongitudinal + maxLongitudinal) / 2,
      minLateral,
      maxLateral,
      centerLateral: (minLateral + maxLateral) / 2,
      minY: this.boundsMin.y,
      maxY: this.boundsMax.y,
      length: maxLongitudinal - minLongitudinal,
      width: maxLateral - minLateral,
      height: this.boundsMax.y - this.boundsMin.y,
      distalAtMin: true,
    };

    const lowSection = this.crossSectionStats(
      minLongitudinal + this.currentFrame.length * 0.18,
      32,
    );
    const highSection = this.crossSectionStats(
      minLongitudinal + this.currentFrame.length * 0.82,
      32,
    );

    if (lowSection && highSection) {
      this.currentFrame.distalAtMin = lowSection.meanRadius <= highSection.meanRadius;
      this.crossSectionCache.clear();
    }
  }
}
