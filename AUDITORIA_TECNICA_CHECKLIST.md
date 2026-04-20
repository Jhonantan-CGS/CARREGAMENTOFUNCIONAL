# Auditoria Técnica do Checklist Web App

Data: 2026-04-20

## Diagnóstico objetivo

Foi identificada uma combinação de causas estruturais no fluxo de envio:

1. O projeto mantinha camadas antigas e novas coexistindo no mesmo `index.html`: verificação local, fila offline antiga, locks, service worker com eventos de sync e envio em segundo plano ad-hoc.
2. O `dbManager` existia, mas não era inicializado em `initApp()`. Isso deixava a infraestrutura de rastreabilidade e fila inconsistente e inutilizava a proteção local contra duplicidade em processamento.
3. O envio dependia diretamente da resposta final do App Script e historicamente podia travar após a persistência, especialmente na leitura do corpo da resposta. O código já apontava esse sintoma, mas o fluxo ainda não tinha uma orquestração única e rastreável.
4. A duplicidade principal ainda estava pulverizada: parte no histórico carregado, parte em hash local e parte em uma API opcional. A regra obrigatória `placa + pedido + data atual` não estava centralizada.
5. O service worker ainda carregava eventos de `sync` e `periodicsync` sem utilidade real no fluxo atual, mantendo ruído legado.

## Causa raiz do bug “fica salvando eternamente”

A causa raiz principal é o acoplamento do submit à confirmação final da resposta HTTP do App Script, somado a um pipeline incompleto de rastreabilidade:

- o backend podia persistir o registro;
- a interface ficava dependente da etapa pós-gravação;
- quando a leitura/resolução final da resposta atrasava, falhava ou retornava fora do formato esperado, o frontend não concluía o ciclo visual de forma confiável;
- ao mesmo tempo, a infraestrutura local que deveria segurar e rastrear o envio (`dbManager`) nem era inicializada no bootstrap do app.

Em resumo: o dado era salvo, mas o fluxo de finalização no frontend permanecia frágil e sem um orquestrador único.

## Alterações realizadas

### Arquivos alterados

- `D:\Área de Trabalho\Carregamento Funcional\index.html`
- `D:\Área de Trabalho\Carregamento Funcional\sw.js`

### Arquivos removidos

- Nenhum arquivo físico removido.

### Código legado neutralizado

- Registro de `Background Sync` no frontend desativado.
- Eventos `sync` e `periodicsync` removidos do `sw.js`.
- Precache de `offline.html` removido do service worker, pois o arquivo não existe no projeto atual.
- Mensagens e semântica de “fila offline” substituídas por “envio em processamento”.

## Nova arquitetura de envio

### Pipeline único

O envio agora segue um pipeline centralizado:

1. Validar formulário.
2. Validar bloqueios e duplicidade.
3. Gerar `uniqueChecklistKey` e `idempotencyKey`.
4. Persistir localmente o envio como item rastreável.
5. Retornar imediatamente o usuário para a tela inicial.
6. Processar o envio em segundo plano via `submissionManager`.
7. Atualizar status, logs visuais e histórico local.

### Garantias adicionadas

- trava imediata contra clique duplo com `isSubmitting`;
- persistência local antes do envio remoto;
- rastreabilidade do envio em andamento;
- remoção do item rastreado apenas após sucesso confirmado;
- atualização clara de erro em caso de falha real;
- refresh silencioso após sucesso.

## Regra anti-duplicidade implementada

A chave obrigatória agora é centralizada como:

- `placaNormalizada + pedido normalizado + dataOperacao`

Implementação:

- helper `buildChecklistUniqueKey(...)`
- helper `buildChecklistIdempotencyKey(...)`
- verificação local contra histórico recente sincronizado;
- verificação local contra envio ainda em processamento no dispositivo;
- verificação remota via `CHECK_DUPLICATE_CHECKLIST` quando suportada;
- bloqueio antes de gravar novo envio.

## Funções/módulos alterados

- `dbManager.init`
- `dbManager.ensureReady`
- `dbManager.savePending`
- `dbManager.updatePendingStatus`
- `dbManager.getAllPending`
- `dbManager.deletePending`
- `checklistGuardManager.verificarDuplicidadeChecklist`
- `checklistGuardManager.registrarChecklistFinalizado`
- `checklistGuardManager.validarAntesDoEnvio`
- `apiService.normalizeScriptResponse`
- `apiService._postToScript`
- `apiService.sendDataToAppScript`
- `apiService.verificarDuplicidadeChecklist`
- `syncManager.processQueue`
- `swManager.registerBackgroundSync`
- `appController.initApp`
- `appController.silentRefresh`
- `appController.handleRefresh`
- `appController.submitFinal`
- novo módulo `submissionManager`

## Testes executados

### Executado diretamente

1. Validação sintática de todo o JavaScript embutido em `index.html`
   Resultado: `JS syntax OK`

### Validado por inspeção técnica de fluxo

1. Clique duplo / múltiplos cliques rápidos
   Resultado esperado implementado: bloqueado por `isSubmitting` e botões desabilitados.
2. Mesmo checklist no mesmo dia com mesma placa e pedido
   Resultado esperado implementado: bloqueio por `uniqueChecklistKey`.
3. Retorno imediato à tela inicial
   Resultado esperado implementado: ocorre logo após o `enqueue`.
4. Continuação do envio em segundo plano
   Resultado esperado implementado: feito por `submissionManager.processPendingQueue`.
5. Sem travamento visual por resposta tardia
   Resultado esperado implementado: UI não espera mais a conclusão remota para navegar.

## Pendências

- Não há backend do App Script no workspace atual; portanto, a validação end-to-end da resposta remota depende do ambiente real.
- A API remota de duplicidade já está integrada, mas sua robustez final depende de o backend respeitar `pedido`, `dataOperacao` e `idempotencyKey`.

## Decisões arquiteturais

- Mantive o projeto em arquivo único para evitar uma reestruturação física arriscada sem build pipeline no workspace.
- Preferi neutralizar o legado conflitante em vez de remover agressivamente blocos grandes sem cobertura automatizada.
- A rastreabilidade local foi preservada porque ela é necessária para o retorno imediato à home com segurança operacional.
