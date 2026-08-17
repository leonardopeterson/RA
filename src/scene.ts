import { ArcRotateCamera, Color3, Color4, DirectionalLight, Engine, HemisphericLight, Scene, Vector3 } from '@babylonjs/core';

export interface SceneContext {
  engine: Engine;
  scene: Scene;
  camera: ArcRotateCamera;
}

export function createScene(canvas: HTMLCanvasElement): SceneContext {
  const engine = new Engine(canvas, true, { preserveDrawingBuffer: true, stencil: true });
  const scene = new Scene(engine);
  scene.clearColor = new Color4(0.025, 0.07, 0.06, 1);
  scene.useRightHandedSystem = true;

  const camera = new ArcRotateCamera('preview-camera', -Math.PI / 2, 1.08, 0.85, new Vector3(0, 0.02, 0), scene);
  camera.lowerRadiusLimit = 0.5;
  camera.upperRadiusLimit = 1.4;
  camera.attachControl(canvas, true);

  const ambient = new HemisphericLight('ambient', new Vector3(0, 1, 0), scene);
  ambient.intensity = 1.2;
  ambient.groundColor = new Color3(0.18, 0.25, 0.23);
  const key = new DirectionalLight('key', new Vector3(-0.4, -1, 0.3), scene);
  key.position.set(0.4, 0.8, -0.4);
  key.intensity = 1.1;

  window.addEventListener('resize', () => engine.resize());
  return { engine, scene, camera };
}
