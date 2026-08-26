# Atualizações do Nexus Edge

O atualizador integrado usa exclusivamente prereleases assinadas do repositório
`Techify-one/nexus-edge`. Nesta fase, o canal é **beta** e atende instalações
Cloudflare com D1. PostgreSQL continua com o fluxo operacional de
`DEPLOYMENT.md`.

## O que o botão faz

1. Consulta a lista pública de releases do GitHub e seleciona a maior versão
   semântica com tag `nexus-v<VERSÃO>` marcada como prerelease.
2. Baixa `nexus-edge-release.json` e `nexus-edge-release.sig`, valida a
   assinatura Ed25519 incorporada no Core e fixa ID, versão e hash da release.
3. Baixa `nexus-edge-update.zip` e valida tamanho e SHA-256 de cada módulo,
   asset e migração antes de usá-lo.
4. Registra o instante anterior às migrações para restauração pelo D1 Time
   Travel, aplica somente as migrações assinadas ainda ausentes e bloqueia um
   arquivo que reutilize o ID de uma migração com hash diferente.
5. Publica o Worker e a interface com `bindings_inherit=strict`, substituindo
   somente os módulos, assets e `APP_VERSION`. Bindings de banco, Queue,
   plugins e secrets são herdados.
6. Verifica a versão ativa e os bindings essenciais antes de liberar o lock.

O usuário precisa ter `core.settings.update`, confirmar a senha e já ter
cadastrado em **Plugins** o token limitado a `Account → Workers Scripts → Edit`.
O token não é enviado ao GitHub nem gravado no banco.

## Publicar uma beta

Uma release beta nunca deve ser montada manualmente no painel do GitHub.

1. Defina em `package.json`, `workers/core/package.json` e nos valores
   `APP_VERSION` dos arquivos Wrangler a mesma versão semântica, por exemplo
   `1.1.0-beta.2`.
2. Atualize as notas e inclua migrações D1/PostgreSQL pareadas, sempre
   aditivas. Valide localmente conforme `DEPLOYMENT.md`.
3. Faça commit, envie para `main` e espere o workflow `CI` concluir a validação
   e o deploy de produção.
4. No GitHub Actions, execute **Publish Core update beta** informando exatamente
   a versão presente em `package.json`.
5. Espere o workflow repetir todas as validações, criar o pacote
   determinístico, assinar o manifesto no environment `core-update-release` e
   publicar a prerelease `nexus-v<VERSÃO>` com os três assets fixos.
6. Em uma instalação de teste numa versão anterior, abra **Configurações
   gerais**, confira as notas e clique **Atualizar agora**. Confirme `/health`,
   login, plugins, Queue e auditoria depois da conclusão.

O environment `core-update-release` contém a chave privada como secret
`CORE_UPDATE_PRIVATE_KEY_PKCS8_BASE64` e a chave pública como variable
`CORE_UPDATE_PUBLIC_KEY_SPKI_BASE64`. A chave privada não deve ser exportada,
impressa, copiada para Wrangler nem adicionada ao repositório.
O environment aceita deployments somente a partir da branch `main`.

## Falha e recuperação

Uma falha interrompe o fluxo, libera o lock global e mantém o identificador na
auditoria. Código anterior pode ser restaurado pelos deployments do Worker.
Quando uma migração já tiver sido aplicada, restaure o D1 pelo Time Travel para
o instante exibido na operação antes de reativar o Worker anterior. A retenção
do Time Travel depende do plano Cloudflare; consulte `docs/BACKUP-RESTORE.md` e
nunca execute rollback destrutivo sem validar o alvo e a janela disponível.

Não há downgrade automático, release silenciosa, origem configurável, arquivo
sem assinatura ou mudança automática de D1 para PostgreSQL.
