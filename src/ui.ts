import type { ActivitySnapshot, ObjectId, ObjectState } from './activity';
import type { GameMode } from './workspace';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Elemento #${id} não encontrado.`);
  return found as T;
}

export interface UiCallbacks {
  enterAR(): void;
  demo(): void;
  exitAR(): void;
  reposition(): void;
  pick(): void;
  release(): void;
  finish(): void;
  restart(): void;
  changeGameMode(mode: GameMode): Promise<void>;
  prepareInventoryObject(id: ObjectId): void;
  inventoryDragStart(id: ObjectId, clientX: number, clientY: number): Promise<boolean>;
  inventoryDragMove(clientX: number, clientY: number): void;
  inventoryDragEnd(): void;
  canUseObject(id: ObjectId): boolean;
  isObjectHeld(id: ObjectId): boolean;
  objectState(id: ObjectId): ObjectState;
}

interface InventoryGesture {
  pointerId: number;
  id: ObjectId;
  button: HTMLButtonElement;
  startX: number;
  startY: number;
  latestX: number;
  latestY: number;
  intent: 'pending' | 'scroll' | 'drag';
  active: boolean;
}

export class UI {
  readonly overlay = element<HTMLElement>('dom-overlay');
  private welcome = element<HTMLElement>('welcome');
  private topbar = element<HTMLElement>('topbar');
  private hud = element<HTMLElement>('hud');
  private summary = element<HTMLElement>('summary');
  private enter = element<HTMLButtonElement>('enter-ar');
  private demo = element<HTMLButtonElement>('demo-mode');
  private inventory = element<HTMLElement>('inventory');
  private feedbackTimer?: number;
  private assetsReady = false;
  private webxrSupported = false;
  private gameMode: GameMode = 'inventory';
  private activityInteractive = false;
  private inventoryGesture?: InventoryGesture;

  bind(callbacks: UiCallbacks): void {
    this.enter.onclick = callbacks.enterAR;
    this.demo.onclick = callbacks.demo;
    element('exit-ar').onclick = callbacks.exitAR;
    element('reposition').onclick = callbacks.reposition;
    element('finish').onclick = callbacks.finish;
    element('restart').onclick = callbacks.restart;
    document.querySelectorAll<HTMLImageElement>('.inventory-thumbnail').forEach((image) => {
      const hideMissing = () => { if (!image.naturalWidth) image.hidden = true; };
      image.addEventListener('error', hideMissing);
      if (image.complete) hideMissing();
    });
    document.querySelectorAll<HTMLButtonElement>('[data-game-mode]').forEach((button) => {
      button.onclick = () => void this.requestGameMode(button.dataset.gameMode as GameMode);
    });
    this.bindInventoryGestures();
    this.callbacks = callbacks;
  }

  private callbacks?: UiCallbacks;

  setSupport(supported: boolean, _message?: string): void {
    this.webxrSupported = supported;
    this.updateWelcomeAvailability();
  }

  setAssetsReady(ready: boolean): void {
    this.assetsReady = ready;
    this.updateWelcomeAvailability();
  }

  showExperience(isXR: boolean): void {
    this.welcome.classList.add('hidden');
    this.summary.classList.add('hidden');
    this.topbar.classList.remove('hidden');
    this.hud.classList.remove('hidden');
    element('exit-ar').classList.toggle('hidden', !isXR);
    this.applyGameModePresentation();
  }

  showPlacement(): void {
    this.activityInteractive = false;
    element('step-number').textContent = 'POSICIONAMENTO';
    element('instruction').textContent = 'Aponte para uma superfície e toque para posicionar.';
    element('progress-label').textContent = '0 / 7';
    element<HTMLElement>('progress-bar').style.width = '0%';
    element('selection-card').classList.add('hidden');
    element('reposition').classList.add('hidden');
    this.refreshInventory();
  }

  update(snapshot: ActivitySnapshot): void {
    this.activityInteractive = true;
    const shownStep = Math.min(snapshot.step + 1, 7);
    element('step-number').textContent = snapshot.completed ? 'CURATIVO CONCLUÍDO' : `ETAPA ${shownStep}`;
    element('instruction').textContent = snapshot.instruction;
    element('progress-label').textContent = `${Math.min(snapshot.step, 7)} / 7`;
    element<HTMLElement>('progress-bar').style.width = `${Math.min(snapshot.step / 7, 1) * 100}%`;

    const counter = element('treatment-counter');
    counter.classList.toggle('hidden', snapshot.step !== 2 && snapshot.step !== 5 && snapshot.step !== 6);
    const counterLabel = counter.querySelector('span')!;

    if (snapshot.step === 5 || snapshot.step === 6) {
      counterLabel.textContent = snapshot.step === 5 ? 'Faixa 1' : 'Faixa 2';
      element('counter-value').textContent = `Voltas: ${snapshot.wrapCount} / ${snapshot.wrapTarget}`;
    } else {
      counterLabel.textContent = 'Debridamento';
      element('counter-value').textContent = `${snapshot.debridementSeconds.toFixed(1)} / ${snapshot.debridementTargetSeconds.toFixed(0)} s`;
    }

    element('reposition').classList.remove('hidden');
    element('finish').classList.toggle('hidden', !snapshot.completed);
    this.refreshInventory();
  }

  setGameMode(mode: GameMode): void {
    this.gameMode = mode;
    this.applyGameModePresentation();
  }

  showSelection(name: string, state: ObjectState, held: boolean, canPick: boolean): void {
    element('selection-card').classList.remove('hidden');
    element('selected-name').textContent = name;

    const actions = element('actions');
    actions.replaceChildren();

    if (held) {
      const button = document.createElement('button');
      button.className = 'secondary compact';
      button.textContent = 'Soltar';
      button.onclick = () => this.callbacks?.release();
      actions.append(button);
    } else if (canPick) {
      const button = document.createElement('button');
      button.className = 'primary compact';
      button.textContent = 'Pegar';
      button.onclick = () => this.callbacks?.pick();
      actions.append(button);
    } else {
      const labels: Partial<Record<ObjectState, string>> = {
        positioned: 'Posicionado ✓',
        wet: 'Preparado ✓',
        applying: 'Aplicando…',
        returned: 'Aplicado ✓',
        used: 'Utilizado ✓',
        applied: 'Aplicada ✓',
        wrapping: 'Em andamento',
        completed: 'Concluída ✓',
      };

      const status = document.createElement('span');
      status.className = 'done-label';
      status.textContent = labels[state] ?? 'Aguarde';
      actions.append(status);
    }
  }

  clearSelection(): void {
    element('selection-card').classList.add('hidden');
  }

  notify(message: string, kind: 'success' | 'error' | 'info' = 'info'): void {
    const feedback = element('feedback');
    feedback.textContent = message;
    feedback.className = `feedback ${kind}`;
    clearTimeout(this.feedbackTimer);
    this.feedbackTimer = window.setTimeout(() => feedback.classList.add('hidden'), 2200);
  }

  showSummary(errors: number, elapsedMs: number): void {
    this.hud.classList.add('hidden');
    this.inventory.classList.add('hidden');
    this.summary.classList.remove('hidden');
    element('summary-errors').textContent = String(errors);

    const seconds = Math.floor(elapsedMs / 1000);
    element('summary-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }

  private updateWelcomeAvailability(): void {
    this.enter.disabled = !this.assetsReady || !this.webxrSupported;
    this.demo.disabled = !this.assetsReady;
    this.enter.setAttribute('aria-disabled', String(this.enter.disabled));
    this.demo.setAttribute('aria-disabled', String(this.demo.disabled));
  }

  private async requestGameMode(mode: GameMode): Promise<void> {
    if (!this.callbacks || mode === this.gameMode) {
      element<HTMLDetailsElement>('game-mode-menu').open = false;
      return;
    }
    const menu = element<HTMLDetailsElement>('game-mode-menu');
    menu.open = false;
    menu.classList.add('is-loading');
    try {
      await this.callbacks.changeGameMode(mode);
      this.setGameMode(mode);
    } finally {
      menu.classList.remove('is-loading');
    }
  }

  private applyGameModePresentation(): void {
    const inventoryMode = this.gameMode === 'inventory';
    document.body.classList.toggle('inventory-mode', inventoryMode);
    this.inventory.classList.toggle('hidden', !inventoryMode || this.topbar.classList.contains('hidden'));
    document.querySelectorAll<HTMLButtonElement>('[data-game-mode]').forEach((button) => {
      const selected = button.dataset.gameMode === this.gameMode;
      button.setAttribute('aria-checked', String(selected));
      const marker = button.querySelector('span');
      if (marker) marker.textContent = selected ? '●' : '○';
    });
    this.refreshInventory();
  }

  private refreshInventory(): void {
    if (!this.callbacks) return;
    document.querySelectorAll<HTMLButtonElement>('[data-object-id]').forEach((button) => {
      const id = button.dataset.objectId as ObjectId;
      const state = this.callbacks!.objectState(id);
      button.disabled = !this.activityInteractive || !this.callbacks!.canUseObject(id);
      button.classList.toggle('is-active', this.callbacks!.isObjectHeld(id));
      button.classList.toggle('is-done', ['returned', 'used', 'applied', 'completed'].includes(state));
      button.setAttribute('aria-label', `${button.textContent?.trim() ?? id}: ${button.disabled ? 'indisponível' : 'disponível'}`);
    });
  }

  private bindInventoryGestures(): void {
    document.querySelectorAll<HTMLButtonElement>('[data-object-id]').forEach((button) => {
      button.addEventListener('pointerdown', (event) => {
        if (button.disabled || this.gameMode !== 'inventory') return;
        this.callbacks?.prepareInventoryObject(button.dataset.objectId as ObjectId);
        this.inventoryGesture = {
          pointerId: event.pointerId,
          id: button.dataset.objectId as ObjectId,
          button,
          startX: event.clientX,
          startY: event.clientY,
          latestX: event.clientX,
          latestY: event.clientY,
          intent: 'pending',
          active: false,
        };
      });
    });

    window.addEventListener('pointermove', (event) => {
      const gesture = this.inventoryGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      gesture.latestX = event.clientX;
      gesture.latestY = event.clientY;
      const deltaX = event.clientX - gesture.startX;
      const deltaY = event.clientY - gesture.startY;

      if (gesture.intent === 'pending') {
        if (Math.hypot(deltaX, deltaY) < 12) return;
        if (Math.abs(deltaX) >= Math.abs(deltaY) || deltaY >= 0) {
          gesture.intent = 'scroll';
          return;
        }
        gesture.intent = 'drag';
        gesture.button.classList.add('is-dragging');
        void this.startInventoryGesture(gesture);
      }

      if (gesture.intent === 'drag') {
        event.preventDefault();
        if (gesture.active) this.callbacks?.inventoryDragMove(event.clientX, event.clientY);
      }
    }, { passive: false });

    const finishGesture = (event: PointerEvent) => {
      const gesture = this.inventoryGesture;
      if (!gesture || event.pointerId !== gesture.pointerId) return;
      this.inventoryGesture = undefined;
      gesture.button.classList.remove('is-dragging');
      if (gesture.active) this.callbacks?.inventoryDragEnd();
    };
    window.addEventListener('pointerup', finishGesture);
    window.addEventListener('pointercancel', finishGesture);
  }

  private async startInventoryGesture(gesture: InventoryGesture): Promise<void> {
    const started = await this.callbacks?.inventoryDragStart(
      gesture.id,
      gesture.latestX,
      gesture.latestY,
    );
    if (!started) return;
    if (this.inventoryGesture !== gesture) {
      this.callbacks?.inventoryDragEnd();
      return;
    }
    gesture.active = true;
    this.callbacks?.inventoryDragMove(gesture.latestX, gesture.latestY);
  }
}
