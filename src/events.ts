export type ActivityEventName =
  | 'activity_started' | 'workspace_placed' | 'object_selected' | 'object_picked'
  | 'interaction_started' | 'interaction_completed' | 'object_applied'
  | 'object_discarded' | 'invalid_action' | 'step_completed' | 'activity_completed'
  | 'debrisoft_positioned' | 'solution_applied' | 'debridement_started'
  | 'debridement_completed' | 'gauze_applied';

export interface ActivityEvent {
  event: ActivityEventName;
  at: number;
  object?: string;
  target?: string;
  step?: number;
  detail?: string;
}

export class EventLog {
  readonly startedAt = Date.now();
  readonly entries: ActivityEvent[] = [];

  emit(event: ActivityEventName, data: Omit<ActivityEvent, 'event' | 'at'> = {}): void {
    const entry = { event, at: Date.now(), ...data };
    this.entries.push(entry);
    console.info('[activity]', entry);
  }

  count(event: ActivityEventName): number {
    return this.entries.filter((entry) => entry.event === event).length;
  }
}
