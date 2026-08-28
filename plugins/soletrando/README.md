# Soletrando plugin

Plugin do Nexus Edge para administrar treinos de soletração de crianças. O
painel autenticado cadastra e gerencia crianças; cada criança recebe um link
público individual em `/soletrando/c/<token>`.

O Worker do plugin continua privado e só é chamado pelo Core por Service
Binding. O gateway público do Core remove credenciais recebidas, aplica limite
de requisições e envia apenas um contexto interno. O administrador escolhe no
painel entre Whisper Large V3 Turbo e Deepgram Nova-3; Workers AI transcreve o
áudio em memória e o código determinístico avalia a sequência de letras. O
áudio nunca é persistido. Para o Nova-3, o Worker solicita `pt-BR` e opt-out do
programa de melhoria do modelo.

## Contratos preservados

- quatro fases fixas de dez palavras;
- a palavra não aparece na tela infantil;
- a criança pode ouvir a palavra quantas vezes quiser antes de soletrar;
- o botão **Soletrar** só é liberado depois da primeira audição e é o único
  que abre o microfone e inicia o cronômetro;
- transcrição e avaliação ocorrem somente depois de **Enviar resposta**;
- uma sequência reconhecida diferente recebe zero em assertividade, velocidade
  e pontos, com feedback claro de erro;
- somente áudio vazio ou indecifrável pede nova gravação sem criar tentativa;
- transcrições com tokens desconhecidos são tratadas como ambíguas e pedem uma
  nova gravação, sem descartar partes silenciosamente;
- sessões ativas retomam na primeira posição ainda não respondida;
- a próxima fase só é liberada após dez acertos consecutivos na mesma rodada;
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
