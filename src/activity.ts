import { EventLog } from './events';

export type ObjectState = 'available' | 'selected' | 'held' | 'used' | 'applied';
export type ObjectId = 'applicator' | 'cover';

export interface ActivityObjectState {
  id: ObjectId;
  name: string;
  state: ObjectState;
  initialPosition: readonly [number, number, number];
}

export interface ActivitySnapshot {
  step: number;
  instruction: string;
  treatmentProgress: number;
  completed: boolean;
}

const instructions = [
  'Selecione o aplicador e toque em Pegar.',
  'Deslize o aplicador sobre a área destacada.',
  'Pegue a cobertura e posicione-a sobre a área de tratamento.',
  'Sequência pronta. Finalize a atividade.',
];

export class Activity {
  readonly objects = new Map<ObjectId, ActivityObjectState>([
    ['applicator', { id: 'applicator', name: 'Aplicador', state: 'available', initialPosition: [0.18, 0.035, 0.04] }],
    ['cover', { id: 'cover', name: 'Cobertura', state: 'available', initialPosition: [0.18, 0.025, -0.07] }],
  ]);
  step = 0;
  treatmentProgress = 0;
  completed = false;
  private interactionStarted = false;

  constructor(readonly events: EventLog) {}

  get snapshot(): ActivitySnapshot {
    return { step: this.step, instruction: instructions[this.step], treatmentProgress: this.treatmentProgress, completed: this.completed };
  }

  select(id: ObjectId): void {
    const object = this.objects.get(id)!;
    if (object.state !== 'held' && object.state !== 'applied') object.state = 'selected';
    this.events.emit('object_selected', { object: id, step: this.step + 1 });
  }

  canPick(id: ObjectId): boolean {
    if (id === 'applicator') return this.step <= 1;
    return this.step >= 2;
  }

  pick(id: ObjectId): boolean {
    if (!this.canPick(id)) return this.invalid(id, 'Objeto fora da ordem atual.');
    this.objects.get(id)!.state = 'held';
    this.events.emit('object_picked', { object: id, step: this.step + 1 });
    if (id === 'applicator' && this.step === 0) this.advance();
    return true;
  }

  release(id: ObjectId): void {
    const object = this.objects.get(id)!;
    if (object.state === 'held') object.state = 'selected';
  }

  addTreatmentMotion(distance: number): boolean {
    if (this.step !== 1 || this.objects.get('applicator')!.state !== 'held') return false;
    if (!this.interactionStarted) {
      this.interactionStarted = true;
      this.events.emit('interaction_started', { object: 'applicator', target: 'treatment-surface', step: 2 });
    }
    this.treatmentProgress = Math.min(1, this.treatmentProgress + distance / 0.22);
    if (this.treatmentProgress >= 1) {
      this.objects.get('applicator')!.state = 'used';
      this.events.emit('interaction_completed', { object: 'applicator', target: 'treatment-surface', step: 2 });
      this.advance();
      return true;
    }
    return false;
  }

  applyCover(): boolean {
    if (this.step !== 2 || this.objects.get('cover')!.state !== 'held') return this.invalid('cover', 'Prepare a área antes de aplicar a cobertura.');
    this.objects.get('cover')!.state = 'applied';
    this.events.emit('object_applied', { object: 'cover', target: 'treatment-surface', step: 3 });
    this.advance();
    return true;
  }

  finish(): boolean {
    if (this.step < 3) return this.invalid(undefined, 'Conclua as etapas antes de finalizar.');
    this.completed = true;
    this.events.emit('activity_completed', { step: 3 });
    return true;
  }

  private advance(): void {
    this.events.emit('step_completed', { step: this.step + 1 });
    this.step++;
  }

  private invalid(object: ObjectId | undefined, detail: string): false {
    this.events.emit('invalid_action', { object, step: this.step + 1, detail });
    return false;
  }
}
