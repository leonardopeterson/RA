# Estação Clínica WebXR

Protótipo funcional de uma atividade prática curta em realidade aumentada, feito com Vite, TypeScript e Babylon.js.

## Executar

```bash
npm install
npm run dev
```

No Android, conecte o aparelho por USB e configure o *Port Forwarding* do Chrome DevTools da porta `5173` para `localhost:5173`. Abra `http://localhost:5173` no celular; WebXR exige contexto seguro, e `localhost` é aceito durante o desenvolvimento.

Também há um modo demonstração não-XR para validar seleção, manipulação, regras e conclusão no navegador desktop.

## Fluxo demonstrado

1. detectar e iniciar `immersive-ar`;
2. encontrar uma superfície por hit test e posicionar o `WorkspaceRoot`;
3. selecionar e pegar o aplicador;
4. arrastá-lo sobre a superfície de tratamento até completar o contato;
5. pegar a cobertura, aproximá-la da área e soltá-la para aplicar snap;
6. finalizar e visualizar o resumo local.

Os eventos ficam apenas em memória e também aparecem no console com o prefixo `[activity]`.

## Assets

Os modelos GLB leves ficam em `public/models`. Para recriá-los após ajustes no script:

```bash
node scripts/generate-models.mjs
```
