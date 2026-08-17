import { EventLog } from './events';

export type ObjectState = 'available' | 'positioned' | 'wet' | 'applying' | 'returned' | 'used' | 'applied';
export type ObjectId = 'debrisoft-pad' | 'solution-bottle' | 'gauze' | 'tape-strip';

export interface InitialPose {
  position: readonly [number, number, number];
  rotation: readonly [number, number, number];
}

export const OBJECT_INITIAL_POSES: Record<ObjectId, InitialPose> = {
  'debrisoft-pad': { position: [0.17, 0.047, -0.105], rotation: [0, 0, 0] },
  'solution-bottle': { position: [0.17, 0.082, 0], rotation: [0, 0, 0] },
  gauze: { position: [0.17, 0.044, 0.105], rotation: [0, 0, 0] },
  'tape-strip': { position: [0.17, 0.043, 0.155], rotation: [0, 0, 0] },
};

export interface ActivityObjectState extends InitialPose {
  id: ObjectId;
  name: string;
  state: ObjectState;
  tableOffset: number;
  treatmentOffset: number;
}

export interface ActivitySnapshot {
  step: number;
  instruction: string;
  debridementSeconds: number;
  debridementTargetSeconds: number;
  phaseCompleted: boolean;
}

const DEBRIDEMENT_TARGET_SECONDS = 10;
const instructions = [
  'Posicione o Debrisoft sobre a lesão.',
  'Aproxime o frasco e aplique a solução no Debrisoft.',
  'Faça movimentos circulares sobre a região.',
  'Posicione a gaze sobre a região tratada.',
  'Fixe a gaze com o esparadrapo.',
  'Fixação concluída. As bandagens serão adicionadas na próxima fase.',
];

export class Activity {
  readonly objects = new Map<ObjectId, ActivityObjectState>([
    ['debrisoft-pad', { id: 'debrisoft-pad', name: 'Debrisoft', state: 'available', tableOffset: 0.021, treatmentOffset: 0.012, ...OBJECT_INITIAL_POSES['debrisoft-pad'] }],
    ['solution-bottle', { id: 'solution-bottle', name: 'Solução', state: 'available', tableOffset: 0.056, treatmentOffset: 0.065, ...OBJECT_INITIAL_POSES['solution-bottle'] }],
    ['gauze', { id: 'gauze', name: 'Gaze', state: 'available', tableOffset: 0.018, treatmentOffset: 0.014, ...OBJECT_INITIAL_POSES.gauze }],
    ['tape-strip', { id: 'tape-strip', name: 'Esparadrapo', state: 'available', tableOffset: 0.017, treatmentOffset: 0.022, ...OBJECT_INITIAL_POSES['tape-strip'] }],
  ]);
  step = 0;
  debridementSeconds = 0;
  phaseCompleted = false;
  private heldId?: ObjectId;
  private debridementStarted = false;

  constructor(readonly events: EventLog) {}

  get snapshot(): ActivitySnapshot {
    return {
      step: this.step,
      instruction: this.step === 4 && this.objects.get('tape-strip')!.state === 'applying'
        ? 'Arraste a tira através da gaze.'
        : instructions[this.step],
      debridementSeconds: this.debridementSeconds,
      debridementTargetSeconds: DEBRIDEMENT_TARGET_SECONDS,
      phaseCompleted: this.phaseCompleted,
    };
  }

  select(id: ObjectId): boolean {
    this.events.emit('object_selected', { object: id, step: this.step + 1 });
    if (!this.canPick(id)) return this.invalid(id, this.invalidPickMessage(id));
    return true;
  }

  isHeld(id: ObjectId): boolean {
    return this.heldId === id;
  }

  canPick(id: ObjectId): boolean {
    return Boolean(
      (id === 'debrisoft-pad' && ((this.step === 0 && this.objects.get(id)!.state === 'available')
        || (this.step === 2 && this.objects.get(id)!.state === 'wet')))
      || (id === 'solution-bottle' && this.step === 1 && this.objects.get(id)!.state === 'available')
      || (id === 'gauze' && this.step === 3 && this.objects.get(id)!.state === 'available')
      || (id === 'tape-strip' && this.step === 4 && this.objects.get('gauze')!.state === 'applied'
        && this.objects.get(id)!.state === 'available'),
    );
  }

  pick(id: ObjectId): boolean {
    if (!this.canPick(id)) return this.invalid(id, this.invalidPickMessage(id));
    this.heldId = id;
    this.events.emit('object_picked', { object: id, step: this.step + 1 });
    return true;
  }

  release(id: ObjectId): void {
    if (this.heldId === id) this.heldId = undefined;
  }

  positionDebrisoft(): boolean {
    if (this.step !== 0 || !this.isHeld('debrisoft-pad')) return this.invalid('debrisoft-pad', 'Posicione o Debrisoft antes de continuar.');
    this.objects.get('debrisoft-pad')!.state = 'positioned';
    this.release('debrisoft-pad');
    this.events.emit('debrisoft_positioned', { object: 'debrisoft-pad', target: 'treatment-surface', step: 1 });
    this.advance();
    return true;
  }

  beginSolutionApplication(): boolean {
    if (this.step !== 1 || !this.isHeld('solution-bottle') || this.objects.get('debrisoft-pad')!.state !== 'positioned') {
      return this.invalid('solution-bottle', 'Posicione o Debrisoft antes de aplicar a solução.');
    }
    this.objects.get('solution-bottle')!.state = 'applying';
    return true;
  }

  completeSolutionApplication(): void {
    this.objects.get('debrisoft-pad')!.state = 'wet';
    this.release('solution-bottle');
    this.events.emit('solution_applied', { object: 'solution-bottle', target: 'debrisoft-pad', step: 2 });
    this.advance();
  }

  markSolutionReturned(): void {
    this.objects.get('solution-bottle')!.state = 'returned';
  }

  addDebridementTime(seconds: number): boolean {
    if (this.step !== 2 || !this.isHeld('debrisoft-pad') || this.objects.get('debrisoft-pad')!.state !== 'wet') {
      this.invalid('debrisoft-pad', 'Aplique a solução antes de iniciar o debridamento.');
      return false;
    }
    if (!this.debridementStarted) {
      this.debridementStarted = true;
      this.events.emit('debridement_started', { object: 'debrisoft-pad', target: 'treatment-surface', step: 3 });
    }
    this.debridementSeconds = Math.min(DEBRIDEMENT_TARGET_SECONDS, this.debridementSeconds + seconds);
    if (this.debridementSeconds < DEBRIDEMENT_TARGET_SECONDS) return false;
    this.objects.get('debrisoft-pad')!.state = 'used';
    this.release('debrisoft-pad');
    this.events.emit('debridement_completed', { object: 'debrisoft-pad', target: 'treatment-surface', step: 3 });
    this.advance();
    return true;
  }

  applyGauze(): boolean {
    if (this.step !== 3 || !this.isHeld('gauze') || this.objects.get('debrisoft-pad')!.state !== 'used') {
      return this.invalid('gauze', 'Conclua o debridamento antes de aplicar a gaze.');
    }
    this.objects.get('gauze')!.state = 'applied';
    this.release('gauze');
    this.events.emit('gauze_applied', { object: 'gauze', target: 'treatment-surface', step: 4 });
    this.advance();
    return true;
  }

  beginTapeApplication(): boolean {
    if (this.step !== 4 || !this.isHeld('tape-strip') || this.objects.get('gauze')!.state !== 'applied') {
      return this.invalid('tape-strip', 'Aplique a gaze antes de iniciar a fixação.');
    }
    this.objects.get('tape-strip')!.state = 'applying';
    this.events.emit('tape_application_started', { object: 'tape-strip', target: 'gauze', step: 5 });
    return true;
  }

  cancelTapeApplication(): void {
    const tape = this.objects.get('tape-strip')!;
    const hadStarted = tape.state === 'applying';
    tape.state = 'available';
    this.release('tape-strip');
    if (hadStarted) this.invalid('tape-strip', 'Atravesse o centro e alcance a lateral oposta.');
  }

  applyTape(): boolean {
    if (this.step !== 4 || !this.isHeld('tape-strip') || this.objects.get('tape-strip')!.state !== 'applying') {
      return this.invalid('tape-strip', 'Inicie a fixação por uma das laterais da gaze.');
    }
    this.objects.get('tape-strip')!.state = 'applied';
    this.release('tape-strip');
    this.events.emit('tape_applied', { object: 'tape-strip', target: 'gauze', step: 5 });
    this.advance();
    this.phaseCompleted = true;
    return true;
  }

  private advance(): void {
    this.events.emit('step_completed', { step: this.step + 1 });
    this.step++;
  }

  private invalidPickMessage(id: ObjectId): string {
    if (id === 'solution-bottle' && this.step === 0) return 'Posicione o Debrisoft antes de aplicar a solução.';
    if (id === 'gauze' && this.step < 3) return 'Conclua o debridamento antes de aplicar a gaze.';
    if (id === 'tape-strip' && this.step < 4) return 'Aplique a gaze antes de usar o esparadrapo.';
    if (id === 'debrisoft-pad' && this.step === 1) return 'Aplique a solução antes de iniciar o debridamento.';
    return 'Esse objeto não é necessário nesta etapa.';
  }

  private invalid(object: ObjectId, detail: string): false {
    this.events.emit('invalid_action', { object, step: this.step + 1, detail });
    return false;
  }
}
