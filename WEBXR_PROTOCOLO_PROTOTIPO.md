# Protótipo WebXR — Treinamento Prático em Realidade Aumentada

## 1. Objetivo

Criar um protótipo demonstrativo e funcional de treinamento prático em Realidade Aumentada executado diretamente no navegador de um celular compatível com WebXR.

O protótipo deve validar a experiência central: o usuário aponta a câmera para uma superfície real, posiciona uma pequena estação clínica virtual sobre essa superfície e executa uma atividade prática manipulando e utilizando objetos virtuais de forma clara, controlada e previsível.

O objetivo atual não é construir uma plataforma completa. O objetivo é provar que a experiência funciona.

A implementação deve ser simples, mas todos os comportamentos essenciais descritos neste documento precisam estar presentes.

---

## 2. Critério de sucesso do protótipo

O protótipo será considerado funcional quando permitir este fluxo completo:

1. abrir a aplicação no celular;
2. verificar suporte a WebXR e iniciar uma sessão `immersive-ar`;
3. apontar a câmera para uma superfície real adequada;
4. visualizar uma indicação de posicionamento;
5. confirmar onde a estação clínica será colocada;
6. manter a estação fixa naquele local e em escala coerente;
7. visualizar uma região corporal/lesão e os objetos necessários à atividade;
8. selecionar um objeto sem ambiguidade;
9. pegar e manipular o objeto utilizando touch e controles contextuais;
10. impedir que o objeto atravesse superfícies, fique suspenso sem lógica, desapareça ou seja perdido fora da estação;
11. permitir uma interação física relevante com a atividade, como tocar, deslizar, pressionar, posicionar, encaixar ou aplicar um objeto sobre uma região válida;
12. atualizar o estado do objeto e/ou da atividade após a ação;
13. fornecer feedback visual curto para ações válidas ou inválidas;
14. permitir completar uma sequência demonstrativa curta;
15. registrar os eventos semanticamente relevantes da atividade;
16. finalizar a atividade e apresentar um resumo simples.

O tipo exato de ferida, os materiais e o protocolo clínico ainda podem mudar. Portanto, a experiência deve depender de uma atividade simples configurável, e não de regras espalhadas pela implementação WebXR.

---

## 3. Princípio central da experiência

A aplicação não deve criar um “mundo virtual” ao redor do usuário.

A Realidade Aumentada deve funcionar como uma pequena estação de trabalho posicionada sobre uma superfície real à frente do usuário.

Fluxo conceitual:

```text
Ambiente real
    ↓
Superfície detectada/escolhida
    ↓
WorkspaceRoot
    ↓
Estação clínica virtual
    ├── região corporal / lesão
    ├── materiais
    ├── instrumentos
    ├── zonas de aplicação
    └── zona de descarte, se necessária
```

Tudo que pertence à atividade deve ser filho lógico do `WorkspaceRoot`.

Mover a câmera não deve mover a estação.

A estação só pode ser reposicionada por uma ação explícita do usuário.

---

## 4. Stack e ferramentas

### Desenvolvimento

- VS Code como editor;
- Codex como principal auxiliar de implementação;
- Node.js;
- Vite;
- TypeScript.

### Cena 3D e WebXR

- Babylon.js;
- WebXR Device API através dos recursos WebXR do Babylon.js;
- sessão `immersive-ar`;
- WebXR Hit Test para escolher a superfície e a pose inicial do workspace;
- DOM Overlay, quando suportado, para controles 2D durante a sessão de RA.

### Modelos

- glTF / GLB como formato principal;
- `@babylonjs/loaders` para carregamento dos assets;
- Blender apenas para criação, correção ou adaptação necessária dos modelos;
- modelos externos reconhecíveis podem ser utilizados para acelerar o protótipo.

### Teste

- celular Android compatível com WebXR/ARCore;
- Chrome compatível;
- teste em dispositivo real desde o início;
- preferir Chrome DevTools Port Forwarding via USB durante o desenvolvimento para abrir o servidor local do Vite no celular dentro de um contexto seguro, evitando transformar HTTPS local em uma tarefa paralela.

---

## 5. Estrutura mínima do projeto

Evitar uma estrutura extensa neste momento.

Estrutura recomendada:

```text
project/
├── public/
│   └── models/
│       └── *.glb
│
├── src/
│   ├── main.ts
│   ├── ar.ts
│   ├── scene.ts
│   ├── workspace.ts
│   ├── interaction.ts
│   ├── activity.ts
│   ├── events.ts
│   ├── ui.ts
│   └── styles.css
│
├── index.html
├── package.json
├── tsconfig.json
└── vite.config.ts
```

Responsabilidades:

- `main.ts`: inicialização da aplicação;
- `ar.ts`: sessão WebXR, hit test, placement e mudança entre modo de posicionamento e modo de atividade;
- `scene.ts`: engine, scene, câmera auxiliar de desenvolvimento e iluminação mínima;
- `workspace.ts`: criação do `WorkspaceRoot`, carregamento e organização dos objetos;
- `interaction.ts`: seleção, pegar/mover/soltar, contato, snap e boundaries;
- `activity.ts`: estados, sequência e regras da atividade demonstrativa;
- `events.ts`: eventos semanticamente relevantes;
- `ui.ts`: instruções, objeto selecionado, ações contextuais e feedback.

Não criar managers, factories, repositories, providers ou sistemas genéricos sem necessidade concreta.

---

## 6. Unidades e coordenadas

Usar metros como convenção de escala desde o primeiro momento.

Exemplos:

- `1.0` = aproximadamente 1 metro;
- `0.40` = aproximadamente 40 cm;
- `0.05` = aproximadamente 5 cm.

Todos os modelos importados devem ser ajustados para uma escala coerente antes de entrarem na atividade.

O `WorkspaceRoot` define o sistema de coordenadas da estação.

Depois que a pose do workspace for estabelecida, posições de braço, instrumentos, materiais, zonas e limites devem ser definidas preferencialmente em coordenadas locais do workspace.

Isso é obrigatório para evitar que os objetos se espalhem pelo espaço global da sessão XR.

---

## 7. Placement da estação em RA

### Estado inicial

Ao iniciar `immersive-ar`, mostrar uma instrução curta:

> Aponte para uma superfície onde deseja posicionar a atividade.

### Hit test

Usar WebXR Hit Test para obter uma pose sobre a superfície detectada.

Enquanto houver uma pose válida, mostrar um indicador simples de placement.

Não reconstruir geometricamente a mesa, cama ou chão.

Precisamos apenas de uma pose confiável sobre uma superfície adequada para definir a origem da estação.

### Confirmação

O usuário toca para posicionar.

Após a confirmação:

```text
pose do hit test
      ↓
WorkspaceRoot recebe a transformação
      ↓
atividade é exibida
      ↓
placement é bloqueado
```

O workspace não deve continuar seguindo o retículo de hit test.

Adicionar apenas uma ação explícita de `Reposicionar` caso seja necessário tentar novamente.

### Anchor

Não tornar WebXR Anchors uma dependência estrutural do protótipo.

Se a implementação e o dispositivo permitirem utilizá-lo facilmente para aumentar a estabilidade do workspace, ele pode ser usado como recurso opcional.

A aplicação deve continuar organizada em torno de um único `WorkspaceRoot` independentemente disso.

---

## 8. Workspace

O workspace representa a área jogável da atividade.

Exemplo conceitual:

```text
               região corporal
                     ↓
┌─────────────────────────────────┐
│                                 │
│       braço / área clínica      │
│                                 │
│                       objetos   │
│                       [ ][ ][ ]  │
│                                 │
│  zona auxiliar                  │
│                                 │
└─────────────────────────────────┘
                usuário
```

As dimensões devem ser pequenas e compatíveis com uma mesa, cama ou área de chão à frente do usuário.

Não criar objetos ao redor, atrás ou muito acima do usuário.

### Limite lógico

Definir uma caixa/retângulo local invisível para representar os limites permitidos da atividade.

Todo objeto manipulável deve possuir uma posição válida dentro desse espaço.

Objetos não podem continuar viajando indefinidamente pelo mundo WebXR.

---

## 9. Cena clínica

A cena precisa ser suficientemente clara para reconhecer imediatamente uma atividade clínica.

Ela deve conter, de forma genérica:

- uma região corporal;
- uma lesão/área de tratamento;
- os materiais necessários à atividade escolhida;
- os instrumentos necessários;
- áreas especiais de interação quando necessárias.

Não definir ainda a implementação em torno de um tipo específico de ferida ou conjunto definitivo de materiais.

### Assets

Objetos clinicamente importantes devem utilizar modelos reconhecíveis em GLB/glTF.

Não representar um objeto importante apenas como caixa, cilindro ou esfera, exceto temporariamente para debug interno.

Os assets devem possuir:

- escala coerente;
- pivô/origin adequado para manipulação;
- nomes/IDs estáveis;
- número de polígonos e texturas compatíveis com celular.

Se um modelo externo não estiver imediatamente adequado, corrigir apenas o necessário no Blender.

---

## 10. Seleção

O usuário toca em um objeto 3D para selecioná-lo.

A seleção deve:

- destacar visualmente o objeto;
- armazenar qual objeto está ativo;
- mostrar seu nome;
- mostrar somente as ações possíveis naquele momento.

Exemplo:

```text
Objeto selecionado
Instrumento X

[ Pegar ]
```

Depois:

```text
Instrumento X

[ Soltar ]
[ Usar ]
```

O usuário nunca deve precisar adivinhar qual objeto está selecionado.

---

## 11. Manipulação por touch

A primeira versão deve utilizar touch + controles contextuais.

Não implementar hand tracking.

Fluxo básico:

```text
selecionar
   ↓
pegar
   ↓
mover
   ↓
interagir
   ↓
soltar / aplicar / descartar
```

### Movimento

Quando estiver no estado “held”, o objeto deve acompanhar uma posição controlada calculada a partir da interação na tela.

O movimento não deve ser física livre.

Antes de aplicar a nova transformação:

1. calcular posição desejada;
2. limitar à área do workspace;
3. impedir posições impossíveis;
4. detectar superfícies ou zonas relevantes;
5. aplicar snap quando adequado;
6. aplicar a posição válida final.

A sensação deve ser de controle direto, mesmo que o sistema corrija discretamente posições inválidas.

---

## 12. Interação física significativa

O protótipo não pode se limitar a selecionar um objeto e apertar um botão `Aplicar`.

Quando a natureza da ação exigir manipulação física, o usuário deve executá-la.

A implementação precisa suportar pelo menos o padrão genérico:

```text
objeto ativo
    ↓
contato com região válida
    ↓
movimento/ação do usuário
    ↓
progresso da interação
    ↓
condição mínima atingida
    ↓
ação concluída
```

Exemplos possíveis, dependendo da atividade clínica escolhida:

- deslizar um material sobre uma região;
- pressionar uma cobertura;
- posicionar um elemento sobre uma área;
- aproximar duas peças para encaixe;
- mover um aplicador ao longo de uma superfície;
- manter contato durante determinado movimento;
- levar um objeto até uma zona de descarte.

A arquitetura não deve assumir que o procedimento necessariamente utiliza gaze, soro, algodão ou pomada.

---

## 13. Interaction Surfaces e pontos de contato

Usar uma solução simples para tornar as interações previsíveis.

Objetos que recebem uma ação podem possuir uma zona invisível de interação.

Exemplo:

```text
região corporal visível
└── TreatmentInteractionSurface
```

Objetos manipuláveis podem possuir um ponto ou pequena região responsável pela interação.

Exemplo:

```text
Instrumento
└── InteractionPoint
```

Durante a manipulação, verificar distância/interseção entre o ponto do objeto e a superfície de interação.

Isso permite validar contato sem depender de uma simulação física complexa.

Criar somente as superfícies e pontos realmente usados pela atividade demonstrativa.

---

## 14. Snap

Snap deve ser utilizado sempre que aumentar a previsibilidade da experiência.

Exemplo:

```text
objeto aproxima da região válida
        ↓
feedback visual
        ↓
usuário solta/confirma
        ↓
objeto assume posição válida
```

O snap pode ser usado para:

- regiões de aplicação;
- posições de repouso;
- bandeja;
- descarte;
- encaixes.

Não precisa existir snap para todo movimento.

---

## 15. Física controlada e boundaries

A prioridade é comportamento previsível, não uma simulação física geral.

Regras obrigatórias:

- objetos não devem atravessar a base da estação;
- objetos não devem penetrar grosseiramente na região corporal;
- objetos não devem permanecer suspensos após serem soltos, salvo quando isso fizer parte da ação;
- objetos não devem ser arremessados;
- objetos não devem desaparecer em posições inacessíveis;
- objetos não devem sair indefinidamente do workspace.

Quando um objeto tentar sair da área válida, escolher a solução mais simples adequada:

- clamp na borda;
- impedir o movimento;
- snap para uma posição válida;
- retorno à última posição válida;
- reset para sua posição inicial.

Não implementar um sistema completo de rigid bodies, gravidade ou dinâmica de fluidos se não forem necessários para validar a atividade.

---

## 16. Estados dos objetos

Todo objeto com comportamento importante deve possuir um estado simples e explícito.

Exemplo genérico:

```text
available
   ↓
selected
   ↓
held
   ↓
used/applied
   ↓
discarded ou completed
```

Nem todos os objetos precisam utilizar todos os estados.

Cada objeto deve possuir pelo menos:

```ts
id
name
state
initialPosition
```

Adicionar propriedades específicas somente quando forem necessárias à atividade.

Exemplos possíveis:

- `wetness`;
- `used`;
- `attached`;
- `coverage`;
- `applicationProgress`.

---

## 17. Atividade demonstrativa

Criar uma única atividade curta.

Não construir sistema de cursos, aulas ou múltiplos protocolos.

A atividade deve ser definida como uma pequena sequência de etapas e regras.

Exemplo abstrato:

```text
Etapa 1
Selecionar/preparar objeto necessário

Etapa 2
Executar interação na região indicada

Etapa 3
Posicionar/aplicar segundo elemento

Etapa 4
Concluir ou descartar conforme a atividade

Etapa 5
Finalizar
```

A sequência clínica real será definida depois que o tipo de lesão/procedimento for escolhido.

O código de WebXR não deve depender dos nomes específicos dos materiais.

---

## 18. Regras e ações inválidas

A atividade deve conseguir responder a ações incorretas simples.

Exemplos:

- objeto errado para a etapa;
- tentar usar objeto que ainda não foi preparado;
- tentar aplicar fora da zona correta;
- tentar concluir antes da etapa necessária.

Resposta:

1. impedir a alteração de estado incorreta;
2. emitir `invalid_action`;
3. mostrar feedback curto;
4. permitir que o usuário tente novamente.

Não implementar sistema complexo de pontuação.

---

## 19. Registro de eventos

Registrar apenas eventos semanticamente úteis.

Exemplos:

```text
activity_started
workspace_placed
object_selected
object_picked
interaction_started
interaction_completed
object_applied
object_discarded
invalid_action
step_completed
activity_completed
```

Não salvar posição a cada frame.

Um evento pode conter somente os dados necessários:

```json
{
  "event": "interaction_completed",
  "object": "object-id",
  "target": "target-id",
  "step": 2
}
```

Manter os eventos em memória durante o protótipo.

Não criar banco de dados.

---

## 20. Interface

A interface deve ser mínima e adequada ao celular.

Durante a atividade, exibir apenas:

- instrução/etapa atual;
- objeto selecionado;
- ações contextuais;
- feedback curto;
- opção de reposicionar quando apropriado;
- botão de finalizar quando permitido.

Os controles devem ser grandes o suficiente para touch.

Preferir DOM Overlay para os controles 2D durante a sessão WebXR quando suportado pelo navegador alvo.

Não criar navegação institucional, dashboard, menus de curso ou tela de perfil.

---

## 21. Resumo final

Ao concluir a sequência, mostrar um resumo local e simples.

Exemplo de informações:

- atividade concluída;
- etapas realizadas;
- quantidade de ações inválidas;
- eventos principais;
- duração total, se for simples de registrar.

Não integrar IA neste momento.

---

## 22. Decisões que precisam nascer corretas hoje

Estas decisões são pequenas, mas devem existir desde o primeiro protótipo porque alterá-las posteriormente exigiria reescrever partes importantes da experiência.

### 22.1 Escala em metros

Todos os assets e posições usam uma convenção de escala física coerente.

### 22.2 Um único WorkspaceRoot

Toda a estação pertence ao mesmo sistema local de coordenadas.

### 22.3 IDs estáveis para objetos e zonas

A lógica não deve depender apenas do nome do mesh importado.

### 22.4 Estado separado da aparência do mesh

Alterar um material visual não deve ser a única forma de representar se um objeto foi usado, aplicado ou descartado.

### 22.5 Regras da atividade separadas do placement WebXR

Trocar a atividade não pode exigir reescrever o sistema de RA.

### 22.6 Assets externos em GLB

Objetos importantes não devem ser construídos permanentemente como primitivas dentro do código.

### 22.7 Eventos semânticos

Registrar ações relevantes desde o início evita depender de dados brutos de movimento posteriormente.

### 22.8 Interaction surfaces simples

A detecção de contato deve ter um conceito claro desde o primeiro procedimento, mesmo que inicialmente exista apenas uma superfície de interação.

---

## 23. Ordem de implementação

Seguir esta ordem e manter o projeto executável ao final de cada etapa.

### Etapa A — base

1. criar Vite + TypeScript;
2. instalar Babylon.js e loaders;
3. criar engine/scene;
4. verificar `navigator.xr` e suporte a `immersive-ar`;
5. implementar entrada e saída da sessão AR.

### Etapa B — placement

1. habilitar hit test;
2. mostrar indicador de placement;
3. criar `WorkspaceRoot`;
4. posicionar o root na pose escolhida;
5. bloquear o placement após confirmação;
6. permitir reposicionamento explícito.

### Etapa C — estação clínica

1. carregar poucos GLBs necessários;
2. corrigir escala;
3. parentear tudo ao `WorkspaceRoot`;
4. organizar a composição da estação;
5. estabelecer boundaries.

### Etapa D — interação

1. seleção por touch/raycast;
2. highlight;
3. objeto ativo;
4. UI contextual;
5. pegar/mover/soltar;
6. clamp/boundaries;
7. snap onde necessário.

### Etapa E — ação física demonstrativa

1. adicionar uma interaction surface;
2. adicionar ponto/região de contato no objeto relevante;
3. detectar contato;
4. detectar movimento/ação necessária;
5. calcular progresso simples;
6. concluir a interação quando a condição mínima for satisfeita.

### Etapa F — atividade

1. adicionar estados;
2. criar sequência curta;
3. validar ações corretas/incorretas;
4. emitir eventos;
5. concluir atividade;
6. mostrar resumo simples.

---

## 24. Restrições explícitas

Não implementar agora:

- Firebase;
- Supabase;
- autenticação;
- contas de usuário;
- banco de dados;
- LMS;
- SSO;
- backend;
- deploy;
- dashboard;
- múltiplos cursos;
- sistema genérico de atividades;
- Realidade Virtual;
- modo 3D convencional como produto;
- multiplayer;
- MediaPipe;
- hand tracking;
- visão computacional clínica;
- modelo próprio de IA;
- avaliação por LLM;
- física de fluidos;
- deformação de tecidos;
- simulação física geral se uma regra controlada resolver o problema;
- arquitetura preparada para requisitos hipotéticos.

---

## 25. Regra para decisões durante a implementação

Antes de adicionar um sistema, perguntar:

> Isto é necessário para o usuário experimentar e validar o conceito atual?

Se a resposta for não, não implementar.

Se um requisito for essencial para a experiência ou se ignorá-lo agora obrigaria a reconstruir uma parte central posteriormente, implementar a versão mínima correta.

O objetivo é um protótipo pequeno que demonstre claramente:

```text
Realidade Aumentada
+
placement estável
+
estação espacialmente controlada
+
objetos reconhecíveis
+
interação touch clara
+
manipulação física controlada
+
contato/aplicação real dentro da atividade
+
estados e sequência
+
feedback
```

Esse conjunto é o produto a ser validado neste momento.
