import {
  Matrix, Quaternion, Scene, Vector3, WebXRDefaultExperience,
  WebXRFeatureName, WebXRHitTest,
} from '@babylonjs/core';
import type { UI } from './ui';
import type { Workspace } from './workspace';

export class ARController {
  private xr?: WebXRDefaultExperience;
  private hitTest?: WebXRHitTest;
  private latestPose?: Matrix;
  private placementArmed = false;
  private pointerHandler = () => this.placeFromIndicator();

  constructor(private scene: Scene, private workspace: Workspace, private ui: UI, private onPlaced: () => void) {}

  async isSupported(): Promise<boolean> {
    try { return Boolean(navigator.xr && await navigator.xr.isSessionSupported('immersive-ar')); }
    catch { return false; }
  }

  async enter(): Promise<void> {
    if (!this.xr) {
      this.xr = await this.scene.createDefaultXRExperienceAsync({
        disableDefaultUI: true,
        uiOptions: { sessionMode: 'immersive-ar', referenceSpaceType: 'local-floor' },
      });
      this.hitTest = this.xr.baseExperience.featuresManager.enableFeature(WebXRFeatureName.HIT_TEST, 'latest', {
        disablePermanentHitTest: false,
      }) as WebXRHitTest;
      this.hitTest.onHitTestResultObservable.add((results) => {
        if (!this.placementArmed || results.length === 0) return;
        this.latestPose = results[0].transformationMatrix.clone();
        const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
        this.latestPose.decompose(scale, rotation, position);
        this.workspace.placementIndicator.position.copyFrom(position);
        this.workspace.placementIndicator.rotationQuaternion = rotation;
        this.workspace.placementIndicator.isVisible = true;
      });
    }
    const init = { optionalFeatures: ['dom-overlay'], domOverlay: { root: this.ui.overlay } } as XRSessionInit;
    await this.xr.baseExperience.enterXRAsync('immersive-ar', 'local-floor', undefined, init);
    this.armPlacement();
  }

  armPlacement(): void {
    this.placementArmed = true;
    this.workspace.root.setEnabled(false);
    this.workspace.placementIndicator.isVisible = false;
    this.ui.showPlacement();
    window.setTimeout(() => this.scene.onPointerDown = this.pointerHandler, 250);
  }

  placeDemo(): void {
    this.workspace.root.position.set(0, 0, 0);
    this.workspace.root.setEnabled(true);
    this.workspace.placementIndicator.isVisible = false;
    this.placementArmed = false;
    this.onPlaced();
  }

  placeFromIndicator(): void {
    if (!this.placementArmed || !this.latestPose) return;
    const scale = new Vector3(), rotation = new Quaternion(), position = new Vector3();
    this.latestPose.decompose(scale, rotation, position);
    this.workspace.root.position.copyFrom(position);
    this.workspace.root.rotationQuaternion = rotation;
    this.workspace.root.setEnabled(true);
    this.workspace.placementIndicator.isVisible = false;
    this.placementArmed = false;
    this.scene.onPointerDown = undefined;
    this.onPlaced();
  }

  async exit(): Promise<void> {
    if (this.xr?.baseExperience.state === 2) await this.xr.baseExperience.exitXRAsync();
    location.reload();
  }
}
