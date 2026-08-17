import type { ActivitySnapshot, ObjectId, ObjectState } from './activity';

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
}

export class UI {
  readonly overlay = element<HTMLElement>('dom-overlay');
  private welcome = element<HTMLElement>('welcome');
  private hud = element<HTMLElement>('hud');
  private summary = element<HTMLElement>('summary');
  private support = element<HTMLElement>('support-status');
  private enter = element<HTMLButtonElement>('enter-ar');
  private feedbackTimer?: number;
  private selectedId?: ObjectId;

  bind(callbacks: UiCallbacks): void {
    this.enter.onclick = callbacks.enterAR;
    element('demo-mode').onclick = callbacks.demo;
    element('exit-ar').onclick = callbacks.exitAR;
    element('reposition').onclick = callbacks.reposition;
    element('finish').onclick = callbacks.finish;
    element('restart').onclick = callbacks.restart;
    this.callbacks = callbacks;
  }
  private callbacks?: UiCallbacks;

  setSupport(supported: boolean, message?: string): void {
    this.support.className = `support ${supported ? 'ready' : 'unsupported'}`;
    this.support.innerHTML = `<span></span>${message ?? (supported ? 'WebXR disponível neste dispositivo' : 'WebXR AR não disponível neste navegador')}`;
    this.enter.disabled = !supported;
  }

  showExperience(isXR: boolean): void {
    this.welcome.classList.add('hidden');
    this.summary.classList.add('hidden');
    this.hud.classList.remove('hidden');
    element('exit-ar').classList.toggle('hidden', !isXR);
  }

  showPlacement(): void {
    element('step-number').textContent = 'POSICIONAMENTO';
    element('instruction').textContent = 'Aponte para uma superfície e toque para posicionar.';
    element('progress-label').textContent = '0 / 3';
    element<HTMLElement>('progress-bar').style.width = '0%';
    element('selection-card').classList.add('hidden');
    element('reposition').classList.add('hidden');
  }

  update(snapshot: ActivitySnapshot): void {
    const shownStep = Math.min(snapshot.step + 1, 3);
    element('step-number').textContent = snapshot.step >= 3 ? 'PRONTO PARA FINALIZAR' : `ETAPA ${shownStep}`;
    element('instruction').textContent = snapshot.instruction;
    element('progress-label').textContent = `${Math.min(snapshot.step, 3)} / 3`;
    element<HTMLElement>('progress-bar').style.width = `${Math.min(snapshot.step / 3, 1) * 100}%`;
    element('reposition').classList.remove('hidden');
    element('finish').classList.toggle('hidden', snapshot.step < 3);
  }

  showSelection(id: ObjectId, name: string, state: ObjectState): void {
    this.selectedId = id;
    element('selection-card').classList.remove('hidden');
    element('selected-name').textContent = name;
    const actions = element('actions');
    actions.replaceChildren();
    if (state === 'held') {
      const button = document.createElement('button');
      button.className = 'secondary compact'; button.textContent = 'Soltar'; button.onclick = () => this.callbacks?.release();
      actions.append(button);
    } else if (state !== 'applied' && state !== 'used') {
      const button = document.createElement('button');
      button.className = 'primary compact'; button.textContent = 'Pegar'; button.onclick = () => this.callbacks?.pick();
      actions.append(button);
    } else {
      const status = document.createElement('span'); status.className = 'done-label'; status.textContent = 'Concluído ✓'; actions.append(status);
    }
  }

  clearSelection(): void {
    this.selectedId = undefined;
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
    this.summary.classList.remove('hidden');
    element('summary-errors').textContent = String(errors);
    const seconds = Math.floor(elapsedMs / 1000);
    element('summary-time').textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
  }
}
