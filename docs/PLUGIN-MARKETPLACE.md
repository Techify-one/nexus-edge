# Marketplace de plugins no GitHub

Um marketplace Nexus é um repositório GitHub público contendo um catálogo
assinado e releases imutáveis. A instalação padrão inclui a fonte Techify, mas
o administrador pode desabilitá-la, removê-la e adicionar quantas fontes
quiser. A remoção da fonte não remove plugins nem dados já instalados.

## Estrutura

```text
nexus-marketplace.json
README.md
```

Os ZIPs ficam em GitHub Releases, não no branch e não no repositório do Core:

```text
https://github.com/<owner>/<repo>/releases/download/<tag>/<id>.plugin.zip
```

O Core fixa o ID numérico do repositório no primeiro sync, aceita downloads
somente do mesmo `owner/repo`, valida cada redirect HTTPS permitido, limita o
tamanho, compara SHA-256, verifica Ed25519 e valida novamente o manifesto e o
`integrity.json` do pacote.

## Catálogo

O schema `catalogVersion: 1` contém:

- nome/revisão do marketplace;
- identidade, key ID e chave pública do publisher;
- plugins, categorias e releases `stable` ou `beta`;
- URL, tamanho, SHA-256 e assinatura do ZIP completo;
- assinatura Ed25519 da representação canônica do catálogo sem o campo
  `signature`.

Cada combinação plugin/canal/versão é imutável. Reutilizar a mesma versão com
outro SHA bloqueia o sync. Publique uma nova versão SemVer.

Na versão 1, cada snapshot aceita até 30 releases somando todos os plugins. O
limite mantém sincronização e registro atômicos dentro da camada D1 Free. Separe
catálogos maiores em mais de uma fonte; uma versão futura do protocolo poderá
adicionar paginação assinada sem alterar plugins já instalados.

No repositório de publicação, instale o SDK público e execute depois de gerar os
pacotes:

```bash
PLUGIN_SIGNING_PRIVATE_KEY="<PKCS8-base64url>" \
PLUGIN_SIGNING_KEY_ID="publisher-v1" \
MARKETPLACE_GITHUB_REPOSITORY="owner/repository" \
MARKETPLACE_PUBLISHER_ID="publisher_id" \
MARKETPLACE_PUBLISHER_NAME="Publisher" \
MARKETPLACE_OUTPUT="nexus-marketplace.json" \
pnpm nexus-marketplace-generate
```

A mesma chave assina `integrity.json`, o ZIP completo e o catálogo. Guarde-a
somente no secret manager do CI. A chave pública e seu fingerprint não são
segredos.

## Sincronização e cache

Adicionar uma fonte dispara o primeiro sync. O painel também separa claramente
**Atualizar catálogo** de **Atualizar plugin**. O servidor usa ETag, cache com
prazo, limites de resposta, timeout e backoff de rate limit. Catálogo expirado
continua registrado para diagnóstico, mas não autoriza uma instalação nova.
Plugins instalados funcionam offline a partir dos assets/Worker locais.

O primeiro sync valida a assinatura e fixa automaticamente a primeira chave
pública válida (TOFU), liberando o catálogo no mesmo fluxo e sem confirmação
manual de fingerprint. Mudança posterior de chave nunca é aceita
silenciosamente.

## Rotação e revogação

Uma reassociação administrativa exige reautenticação recente e confirmação do
fingerprint exato:

```text
POST /api/v1/plugin-marketplaces/:id/trust-key
{
  "publicKey": "<raw-ed25519-base64url>",
  "keyId": "publisher-v2",
  "publisherId": "publisher_id",
  "expectedFingerprint": "<sha256>"
}
```

Depois, sincronize um catálogo assinado pela nova chave. A chave anterior fica
`retired`. Para incidente/revogação:

```text
POST /api/v1/plugin-marketplaces/:id/keys/:keyId/revoke
```

A revogação da chave ativa desabilita a fonte e impede novos downloads, mas não
executa código, apaga recursos ou desinstala automaticamente versões existentes.

## Operação do painel

1. Cadastre `owner/repository` em **Plugins → Market Places**. O primeiro sync
   valida e fixa a chave automaticamente.
2. Confira estado da assinatura, fingerprint e último sync.
3. Em **Novos Plugins**, clique na linha para revisar descrição completa,
   publisher, origem, versão, compatibilidade,
   permissões e recursos.
4. Clique **Instalar** ou **Atualizar**. O navegador transporta o ZIP verificado
   entre as duas APIs internas; o usuário não precisa baixar ou fazer upload
   manual.
5. Forneça apenas os tokens Cloudflare temporários solicitados pelo plano de
   recursos. Eles não são persistidos.

As abas têm URLs permanentes: `/app/plugins/installed`,
`/app/plugins/catalog` e `/app/plugins/marketplaces`. Um marketplace pode ser
desativado sem ser removido. Um plugin pode ser desativado e reativado sem
apagar Worker, bindings, recursos, tabelas ou histórico; desinstalar continua
sendo uma ação separada e preserva as tabelas conforme a política do Core.

Repositórios privados ficam reservados para integração futura por credencial de
leitura/GitHub App; a primeira versão aceita fontes públicas e não recebe PAT do
GitHub no navegador.
