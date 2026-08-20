import '@babylonjs/loaders/glTF';
import './styles.css';
import { Activity } from './activity';
import { ARController } from './ar';
import { EventLog } from './events';
import { InteractionController } from './interaction';
import { createScene } from './scene';
import { UI } from './ui';
import { createWorkspace } from './workspace';

const canvas = document.getElementById('render-canvas') as HTMLCanvasElement;
const context = createScene(canvas);
const events = new EventLog();
const activity = new Activity(events);
const workspace = createWorkspace(context.scene);
const ui = new UI();
const interaction = new InteractionController(context.scene, workspace, activity, ui);

let placed = false;
let demoMode = false;
let activityStarted = false;

const placedWorkspace = () => {
  placed = true;
  events.emit('workspace_placed');
  if (!activityStarted) {
    workspace.resetObjects();
    events.emit('activity_started', { step: 1 });
    activityStarted = true;
  }
  ui.update(activity.snapshot);
  ui.notify(
    activity.step === 0
      ? 'Estação posicionada. Selecione o Debrisoft.'
      : 'Estação reposicionada. Continue a atividade.',
    'success',
  );
};

const ar = new ARController(context.scene, workspace, ui, placedWorkspace);

ui.bind({
  enterAR: async () => {
    try {
      ui.showExperience(true);
      ui.showPlacement();
      await ar.enter();
    } catch (error) {
      console.error(error);
      ui.notify('Não foi possível iniciar a sessão AR.', 'error');
      window.setTimeout(() => location.reload(), 1800);
    }
  },

  demo: () => {
    demoMode = true;
    context.scene.clearColor.set(0, 0, 0, 1);
    ui.showExperience(false);
    ar.placeDemo();
  },

  exitAR: () => void ar.exit(),

  reposition: () => {
    if (demoMode) {
      ui.notify('No modo demonstração, arraste a cena para observá-la.', 'info');
      return;
    }

    placed = false;
    ui.clearSelection();
    ar.armPlacement();
  },

  pick: () => interaction.pickSelected(),
  release: () => interaction.releaseSelected(),

  finish: () => {
    if (!activity.finish()) {
      ui.notify('Ainda há etapas pendentes.', 'error');
      return;
    }

    ui.showSummary(events.count('invalid_action'), Date.now() - events.startedAt);
  },

  restart: () => location.reload(),
});

void ar.isSupported().then((supported) => ui.setSupport(supported));

context.scene.onBeforeRenderObservable.add(() => {
  if (!placed) return;
  const treatment = workspace.treatmentSurface;
  const pulse = 1 + Math.sin(performance.now() * 0.004) * 0.05;
  treatment.scaling.setAll(pulse);
});

context.engine.runRenderLoop(() => context.scene.render());
