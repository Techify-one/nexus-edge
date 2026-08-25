# Soletrando plugin

Plugin do Nexus Edge para administrar treinos de soletração de crianças. O
painel autenticado cadastra e gerencia crianças; cada criança recebe um link
público individual em `/soletrando/c/<token>`.

O Worker do plugin continua privado e só é chamado pelo Core por Service
Binding. O gateway público do Core remove credenciais recebidas, aplica limite
de requisições e envia apenas um contexto interno. Workers AI transcreve o
áudio em memória; o código determinístico avalia a sequência de letras. O
áudio nunca é persistido.

## Contratos preservados

- quatro fases fixas de dez palavras;
- a palavra não aparece na tela infantil;
- a gravação começa somente depois que a síntese de voz termina;
- transcrição e avaliação ocorrem somente depois de **Enviar resposta**;
- respostas ambíguas pedem nova gravação sem criar tentativa ou descontar
  pontos;
- sessões ativas retomam na primeira posição ainda não respondida;
- a área infantil mantém manifesto e Service Worker instaláveis, restritos ao
  escopo `/soletrando/`;
- D1 e PostgreSQL possuem migrações equivalentes;
- o Worker não possui URL pública nem Preview URL.

## Build e pacote

```bash
pnpm --filter @app/plugin-soletrando build
node --import tsx scripts/package-plugin.ts soletrando
```

Depois de alterar `wrangler.jsonc`, regenere os tipos dos bindings:

```bash
pnpm --filter @app/plugin-soletrando exec wrangler types worker-configuration.d.ts --config wrangler.jsonc --include-runtime false
```
