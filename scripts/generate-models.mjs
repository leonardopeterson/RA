import { NullEngine, Scene, MeshBuilder, PBRMaterial, Color3 } from '@babylonjs/core';
import { GLTF2Export } from '@babylonjs/serializers/glTF/index.js';
import { mkdir, writeFile } from 'node:fs/promises';

const output = new URL('../public/models/', import.meta.url);
await mkdir(output, { recursive: true });

async function exportModel(name, build) {
  const engine = new NullEngine();
  const scene = new Scene(engine);
  build(scene);
  const glb = await GLTF2Export.GLBAsync(scene, name);
  const blob = glb.glTFFiles[`${name}.glb`];
  await writeFile(new URL(`${name}.glb`, output), Buffer.from(await blob.arrayBuffer()));
  scene.dispose();
  engine.dispose();
}

const mat = (scene, name, hex) => {
  const value = new PBRMaterial(name, scene);
  value.albedoColor = Color3.FromHexString(hex);
  value.roughness = 0.76;
  return value;
};

await exportModel('clinical-applicator', (scene) => {
  const handle = MeshBuilder.CreateCylinder('handle', { height: 0.14, diameter: 0.012, tessellation: 20 }, scene);
  handle.rotation.z = Math.PI / 2;
  handle.material = mat(scene, 'wood', '#e8e2d2');
  const tip = MeshBuilder.CreateSphere('contact-tip', { diameter: 0.025, segments: 16 }, scene);
  tip.position.x = -0.075;
  tip.scaling.x = 1.35;
  tip.material = mat(scene, 'soft-tip', '#f8fbfa');
});

await exportModel('clinical-cover', (scene) => {
  const pad = MeshBuilder.CreateBox('absorbent-pad', { width: 0.105, depth: 0.085, height: 0.008 }, scene);
  pad.material = mat(scene, 'fabric', '#f8faf8');
  const center = MeshBuilder.CreateBox('center-pad', { width: 0.07, depth: 0.052, height: 0.009 }, scene);
  center.position.y = 0.006;
  center.material = mat(scene, 'center-fabric', '#dcebe5');
});
