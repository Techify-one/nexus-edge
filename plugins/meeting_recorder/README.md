# Meeting Recorder

Plugin privado do Nexus Edge para gravação recuperável no navegador, upload de
áudio e ingestão por bot do Telegram. O R2 é opcional: sem ele, áudios do
Telegram são transcritos em memória e descartados; com ele, gravação, upload,
retenção e reprodução de áudio ficam disponíveis em um bucket privado. O banco
ativo guarda metadados, estados e transcrições.

Requer Nexus Core `1.1.0-beta.8` ou superior. Essa versão inclui a interface de
gestão de convidados e as traduções de suas permissões; versões anteriores não
possuem essa superfície no frontend.

## Origens suportadas

- microfone e aba + microfone em Chrome/Edge desktop;
- upload manual de WebM/Opus, Ogg/Opus, MP3, MP4/M4A e WAV de até 20 MiB;
- mensagens `voice` e `audio` de um bot do Telegram. Cada usuário cria um link
  pessoal de 15 minutos na tela de configurações, abre o bot e toca em
  **Iniciar**; o ID é associado sem precisar ser descoberto ou digitado. Um
  usuário autorizado também pode criar convites individuais para outras
  pessoas; os áudios delas entram na biblioteca de quem convidou.

Convites valem uma única vez e expiram em sete dias. O link completo é exibido
somente na criação e apenas seu hash SHA-256 fica no banco. A tela lista
convites pendentes e pessoas ativas, registra a última atividade e permite
revogar o acesso sem apagar gravações anteriores. As permissões
`meeting_recorder.telegram_member.*` separam leitura, criação de convites,
remoção e administração global para que o Core controle quais usuários podem
convidar ou gerenciar terceiros.

Durante cada ingestão o bot confirma o recebimento, avisa quando a transcrição
começa e responde com o resultado e o link direto da gravação. Falhas também
são informadas no chat com um código seguro e uma orientação de recuperação.

O token do bot e o segredo do webhook são Worker secrets configurados pela
tela do plugin. Eles não entram no banco, no manifesto ou no pacote portátil.
A tela valida a identidade do bot, verifica e corrige a URL canônica do webhook,
mostra o link direto `https://t.me/<username>` e permite trocar ou desconectar o
bot. O bot confirma o vínculo e o recebimento dos áudios na própria conversa.
Somente ID, nome, username, vínculo do usuário e URL verificada — nunca o token
ou o código pessoal em claro — são mantidos como metadados no banco.

## Modos de armazenamento

- **Sem R2:** o plugin instala somente com D1/PostgreSQL e Workers AI. Aceita
  áudio do Telegram, transcreve imediatamente e não preserva bytes de áudio.
- **Com R2:** um administrador ativa o bucket nas configurações com um token
  temporário limitado a `Workers R2 Storage → Edit`. A ativação não reinstala o
  plugin e libera gravação no navegador, upload e player.

## Desenvolvimento

```bash
pnpm --filter @app/plugin-meeting-recorder build
node --import tsx scripts/package-plugin.ts meeting_recorder
```

O Worker não possui URL pública própria. APIs autenticadas passam por
`/api/v1/p/meeting_recorder/*`; o webhook do Telegram passa pelo gateway
limitado `/api/v1/public/p/meeting_recorder/telegram/webhook`.
