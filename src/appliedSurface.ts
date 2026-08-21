import { Mesh, TransformNode, Vector3, VertexData } from '@babylonjs/core';
import type { AnatomySurface, SurfaceSample } from './anatomySurface';

export type AppliedPatchShape = 'rectangle' | 'ellipse';
export type AppliedConformMode = 'surface' | 'smoothed';

export interface AppliedPatchOptions {
  center: Vector3;
  axisU: Vector3;
  axisV: Vector3;
  width: number;
  height: number;
  layerOffset: number;
  thickness?: number;
  shape?: AppliedPatchShape;
  subdivisionsU?: number;
  subdivisionsV?: number;
  conformMode?: AppliedConformMode;
  smoothingIterations?: number;
  smoothingStrength?: number;
  surfaceInfluence?: number;
  /** Limita quanto um único relevo pode afastar o patch inteiro da superfície. */
  maxGlobalLift?: number;
  /** Espalha correções locais de penetração pelos vértices vizinhos. */
  penetrationSpread?: number;
  /** Número de anéis da malha usados para formar uma transição suave. */
  penetrationSpreadIterations?: number;
}

/** Constrói patches estáticos aderidos à anatomia, sem simulação de tecido. */
export class AppliedSurfaceSystem {
  constructor(
    private anatomySurface: AnatomySurface,
    private workspaceRoot: TransformNode,
  ) {}

  conform(mesh: Mesh, options: AppliedPatchOptions): boolean {
    const centerSample = this.anatomySurface.sampleTopSurfaceClamped(
      options.center.x,
      options.center.z,
    );
    if (!centerSample) return false;

    const axisU = this.horizontal(options.axisU);
    const axisV = this.horizontal(options.axisV);
    const anchor = this.layeredPoint(centerSample, options.layerOffset);
    const geometry = options.shape === 'ellipse'
      ? this.ellipseGeometry(options, axisU, axisV, anchor)
      : this.rectangleGeometry(options, axisU, axisV, anchor);
    if (!geometry) return false;

    if (options.conformMode === 'smoothed') {
      this.smoothGeometry(geometry, centerSample.normal, options);
    }
    this.orientTrianglesOutward(geometry.positions, geometry.indices, centerSample.normal);
    if (options.thickness && options.thickness > 0) {
      this.extrude(geometry, options.thickness);
    }
    VertexData.ComputeNormals(geometry.positions, geometry.indices, geometry.normals);

    const vertexData = new VertexData();
    vertexData.positions = geometry.positions;
    vertexData.indices = geometry.indices;
    vertexData.normals = geometry.normals;
    vertexData.uvs = geometry.uvs;
    vertexData.applyToMesh(mesh, true);

    mesh.parent = this.workspaceRoot;
    mesh.position.copyFrom(anchor);
    mesh.rotation.set(0, 0, 0);
    mesh.rotationQuaternion = null;
    mesh.isPickable = false;
    return true;
  }

  private rectangleGeometry(
    options: AppliedPatchOptions,
    axisU: Vector3,
    axisV: Vector3,
    anchor: Vector3,
  ): PatchGeometry | null {
    const columns = Math.max(2, options.subdivisionsU ?? 8);
    const rows = Math.max(2, options.subdivisionsV ?? 8);
    const geometry = emptyGeometry();

    for (let row = 0; row <= rows; row++) {
      const v = row / rows;
      for (let column = 0; column <= columns; column++) {
        const u = column / columns;
        const point = options.center
          .add(axisU.scale((u - 0.5) * options.width))
          .add(axisV.scale((v - 0.5) * options.height));
        const sample = this.sample(point);
        if (!sample) return null;
        pushVertex(
          geometry,
          this.layeredPoint(sample, options.layerOffset).subtract(anchor),
          sample.normal,
          u,
          v,
        );
      }
    }

    const stride = columns + 1;
    for (let row = 0; row < rows; row++) {
      for (let column = 0; column < columns; column++) {
        const a = row * stride + column;
        const b = a + stride;
        geometry.indices.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    for (let column = 0; column <= columns; column++) geometry.boundary.push(column);
    for (let row = 1; row <= rows; row++) geometry.boundary.push(row * stride + columns);
    for (let column = columns - 1; column >= 0; column--) {
      geometry.boundary.push(rows * stride + column);
    }
    for (let row = rows - 1; row > 0; row--) geometry.boundary.push(row * stride);
    return geometry;
  }

  private ellipseGeometry(
    options: AppliedPatchOptions,
    axisU: Vector3,
    axisV: Vector3,
    anchor: Vector3,
  ): PatchGeometry | null {
    const rings = Math.max(2, options.subdivisionsV ?? 5);
    const segments = Math.max(12, options.subdivisionsU ?? 32);
    const geometry = emptyGeometry();
    const centerSample = this.sample(options.center);
    if (!centerSample) return null;
    pushVertex(geometry, Vector3.Zero(), centerSample.normal, 0.5, 0.5);

    for (let ring = 1; ring <= rings; ring++) {
      const radius = ring / rings;
      for (let segment = 0; segment < segments; segment++) {
        const angle = segment / segments * Math.PI * 2;
        const u = Math.cos(angle) * radius;
        const v = Math.sin(angle) * radius;
        const point = options.center
          .add(axisU.scale(u * options.width / 2))
          .add(axisV.scale(v * options.height / 2));
        const sample = this.sample(point);
        if (!sample) return null;
        pushVertex(
          geometry,
          this.layeredPoint(sample, options.layerOffset).subtract(anchor),
          sample.normal,
          u * 0.5 + 0.5,
          v * 0.5 + 0.5,
        );
      }
    }

    for (let segment = 0; segment < segments; segment++) {
      geometry.indices.push(0, 1 + segment, 1 + (segment + 1) % segments);
    }
    for (let ring = 1; ring < rings; ring++) {
      const inner = 1 + (ring - 1) * segments;
      const outer = inner + segments;
      for (let segment = 0; segment < segments; segment++) {
        const next = (segment + 1) % segments;
        geometry.indices.push(
          inner + segment, outer + segment, inner + next,
          inner + next, outer + segment, outer + next,
        );
      }
    }
    const outer = 1 + (rings - 1) * segments;
    for (let segment = 0; segment < segments; segment++) {
      geometry.boundary.push(outer + segment);
    }
    return geometry;
  }

  private extrude(geometry: PatchGeometry, thickness: number): void {
    const baseVertexCount = geometry.positions.length / 3;
    const surfaceIndices = [...geometry.indices];
    const topPositions = [...geometry.positions];

    for (let index = 0; index < baseVertexCount; index++) {
      const offset = index * 3;
      topPositions[offset] += geometry.directions[offset] * thickness;
      topPositions[offset + 1] += geometry.directions[offset + 1] * thickness;
      topPositions[offset + 2] += geometry.directions[offset + 2] * thickness;
    }

    geometry.positions.push(...topPositions);
    geometry.uvs.push(...geometry.uvs);
    geometry.indices.length = 0;
    for (let index = 0; index < surfaceIndices.length; index += 3) {
      const a = surfaceIndices[index];
      const b = surfaceIndices[index + 1];
      const c = surfaceIndices[index + 2];
      geometry.indices.push(a, c, b);
      geometry.indices.push(a + baseVertexCount, b + baseVertexCount, c + baseVertexCount);
    }

    for (let index = 0; index < geometry.boundary.length; index++) {
      const next = (index + 1) % geometry.boundary.length;
      const a = geometry.boundary[index];
      const b = geometry.boundary[next];
      geometry.indices.push(a, b, a + baseVertexCount);
      geometry.indices.push(a + baseVertexCount, b, b + baseVertexCount);
    }
  }

  private smoothGeometry(
    geometry: PatchGeometry,
    outward: Vector3,
    options: AppliedPatchOptions,
  ): void {
    const vertexCount = geometry.positions.length / 3;
    const originalPositions = [...geometry.positions];
    const originalDirections = [...geometry.directions];
    const neighbors = Array.from({ length: vertexCount }, () => new Set<number>());

    for (let index = 0; index < geometry.indices.length; index += 3) {
      const triangle = geometry.indices.slice(index, index + 3);
      for (let corner = 0; corner < 3; corner++) {
        const current = triangle[corner];
        neighbors[current].add(triangle[(corner + 1) % 3]);
        neighbors[current].add(triangle[(corner + 2) % 3]);
      }
    }

    const iterations = Math.max(1, options.smoothingIterations ?? 2);
    const strength = Math.max(0, Math.min(1, options.smoothingStrength ?? 0.55));
    let smoothedPositions = [...geometry.positions];
    let smoothedDirections = [...geometry.directions];

    for (let iteration = 0; iteration < iterations; iteration++) {
      const nextPositions = [...smoothedPositions];
      const nextDirections = [...smoothedDirections];
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        if (!neighbors[vertex].size) continue;
        const averagePosition = Vector3.Zero();
        const averageDirection = Vector3.Zero();
        for (const neighbor of neighbors[vertex]) {
          averagePosition.addInPlace(Vector3.FromArray(smoothedPositions, neighbor * 3));
          averageDirection.addInPlace(Vector3.FromArray(smoothedDirections, neighbor * 3));
        }
        averagePosition.scaleInPlace(1 / neighbors[vertex].size);
        averageDirection.scaleInPlace(1 / neighbors[vertex].size).normalize();
        const currentPosition = Vector3.FromArray(smoothedPositions, vertex * 3);
        const currentDirection = Vector3.FromArray(smoothedDirections, vertex * 3);
        Vector3.LerpToRef(currentPosition, averagePosition, strength, currentPosition);
        Vector3.LerpToRef(currentDirection, averageDirection, strength, currentDirection);
        currentDirection.normalize();
        currentPosition.toArray(nextPositions, vertex * 3);
        currentDirection.toArray(nextDirections, vertex * 3);
      }
      smoothedPositions = nextPositions;
      smoothedDirections = nextDirections;
    }

    const surfaceInfluence = Math.max(0, Math.min(1, options.surfaceInfluence ?? 0.2));
    let requiredLift = 0;
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const original = Vector3.FromArray(originalPositions, vertex * 3);
      const smoothed = Vector3.FromArray(smoothedPositions, vertex * 3);
      const blended = Vector3.Lerp(smoothed, original, surfaceInfluence);
      const finalPosition = original.add(
        outward.scale(Vector3.Dot(blended.subtract(original), outward)),
      );
      const originalNormal = Vector3.FromArray(originalDirections, vertex * 3).normalize();
      const penetration = Vector3.Dot(original.subtract(finalPosition), originalNormal);
      requiredLift = Math.max(
        requiredLift,
        penetration / Math.max(0.25, Vector3.Dot(outward, originalNormal)),
      );
      finalPosition.toArray(geometry.positions, vertex * 3);

      const smoothedNormal = Vector3.FromArray(smoothedDirections, vertex * 3);
      Vector3.Lerp(smoothedNormal, originalNormal, surfaceInfluence)
        .normalize()
        .toArray(geometry.directions, vertex * 3);
    }

    // Um outlier anatômico não deve afastar o patch inteiro. Aplicamos apenas uma
    // parcela global limitada e distribuímos a correção residual na vizinhança.
    const maxGlobalLift = Math.max(0, options.maxGlobalLift ?? requiredLift);
    const globalLift = Math.min(requiredLift, maxGlobalLift);
    const outwardDirection = outward.clone().normalize();
    if (globalLift > 0) {
      const lift = outwardDirection.scale(globalLift);
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        Vector3.FromArray(geometry.positions, vertex * 3)
          .addInPlace(lift)
          .toArray(geometry.positions, vertex * 3);
      }
    }

    let corrections = new Array<number>(vertexCount).fill(0);
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const original = Vector3.FromArray(originalPositions, vertex * 3);
      const position = Vector3.FromArray(geometry.positions, vertex * 3);
      const originalNormal = Vector3.FromArray(originalDirections, vertex * 3).normalize();
      const penetration = Vector3.Dot(original.subtract(position), originalNormal);
      corrections[vertex] = Math.max(
        0,
        penetration / Math.max(0.25, Vector3.Dot(outwardDirection, originalNormal)),
      );
    }

    const spread = Math.max(0, Math.min(1, options.penetrationSpread ?? 0.5));
    const spreadIterations = Math.max(1, options.penetrationSpreadIterations ?? 2);
    for (let iteration = 0; iteration < spreadIterations; iteration++) {
      const next = [...corrections];
      for (let vertex = 0; vertex < vertexCount; vertex++) {
        for (const neighbor of neighbors[vertex]) {
          next[vertex] = Math.max(next[vertex], corrections[neighbor] * spread);
        }
      }
      corrections = next;
    }
    for (let vertex = 0; vertex < vertexCount; vertex++) {
      const correction = corrections[vertex];
      if (correction <= 0) continue;
      Vector3.FromArray(geometry.positions, vertex * 3)
        .addInPlace(outwardDirection.scale(correction))
        .toArray(geometry.positions, vertex * 3);
    }
  }

  private sample(point: Vector3): SurfaceSample | null {
    return this.anatomySurface.sampleTopSurfaceClamped(point.x, point.z);
  }

  private layeredPoint(sample: SurfaceSample, offset: number): Vector3 {
    return sample.point.add(sample.normal.scale(offset));
  }

  private horizontal(axis: Vector3): Vector3 {
    const horizontal = new Vector3(axis.x, 0, axis.z);
    return horizontal.lengthSquared() > 1e-8 ? horizontal.normalize() : Vector3.Right();
  }

  private orientTrianglesOutward(
    positions: number[],
    indices: number[],
    outward: Vector3,
  ): void {
    if (indices.length < 3) return;
    const a = Vector3.FromArray(positions, indices[0] * 3);
    const b = Vector3.FromArray(positions, indices[1] * 3);
    const c = Vector3.FromArray(positions, indices[2] * 3);
    if (Vector3.Dot(Vector3.Cross(b.subtract(a), c.subtract(a)), outward) >= 0) return;
    for (let i = 0; i < indices.length; i += 3) {
      [indices[i + 1], indices[i + 2]] = [indices[i + 2], indices[i + 1]];
    }
  }
}

interface PatchGeometry {
  positions: number[];
  indices: number[];
  normals: number[];
  uvs: number[];
  directions: number[];
  boundary: number[];
}

function emptyGeometry(): PatchGeometry {
  return { positions: [], indices: [], normals: [], uvs: [], directions: [], boundary: [] };
}

function pushVertex(
  geometry: PatchGeometry,
  position: Vector3,
  direction: Vector3,
  u: number,
  v: number,
): void {
  geometry.positions.push(position.x, position.y, position.z);
  geometry.directions.push(direction.x, direction.y, direction.z);
  geometry.uvs.push(u, v);
}
