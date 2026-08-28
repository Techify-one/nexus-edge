# Meeting Recorder

Plugin privado do Nexus Edge para gravação recuperável no navegador, upload de
áudio e ingestão por bot do Telegram. Os objetos ficam em um bucket R2 privado;
o banco ativo guarda somente metadados, estados e transcrições.

Requer Nexus Core `1.1.0-beta.3` ou superior. Versões anteriores não possuem o
contrato de manifesto, o provisionamento R2 nem as rotas de interface exigidas
por este plugin.

## Origens suportadas

- microfone e aba + microfone em Chrome/Edge desktop;
- upload manual de WebM/Opus, Ogg/Opus, MP3, MP4/M4A e WAV de até 20 MiB;
- mensagens `voice` e `audio` de um bot do Telegram, associadas pelo campo
  `telegram_id` do perfil do usuário no Nexus.

O token do bot e o segredo do webhook são Worker secrets configurados pela
tela do plugin. Eles não entram no banco, no manifesto ou no pacote portátil.

## Desenvolvimento

```bash
pnpm --filter @app/plugin-meeting-recorder build
node --import tsx scripts/package-plugin.ts meeting_recorder
```

O Worker não possui URL pública própria. APIs autenticadas passam por
`/api/v1/p/meeting_recorder/*`; o webhook do Telegram passa pelo gateway
limitado `/api/v1/public/p/meeting_recorder/telegram/webhook`.
