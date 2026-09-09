# Decisões arquiteturais — Agente Sumaré IA

Histórico das decisões estruturais do agente. Formato por entrada:

```
### [DATA] - [TÍTULO]
- Decisão
- Contexto
- Alternativas descartadas
- Impacto
```

---

### 2026-09-09 - Falha de configuração/rede na captação não queima o lead
- **Modelo usado**: Cursor Grok 4.6 (não confirmado)
- **Decisão**: `CAPTACAO_NOT_CONFIGURED`, `SOFTSY_NOT_CONFIGURED` e `CAPTACAO_FETCH_FAILED` (`CAPTACAO_INFRA_FAIL_CODES`) deixam de ser falha terminal: não pausam a IA, não gravam status nenhum e só registram `captacao_infra_fail` + nota de auditoria. O lead só recebe mensagem ("estamos processando, em instantes o link") quando existe turno dele; em `schedulerTick` o reply fica vazio, para não prometer nada a quem não está esperando. `GERAR_FAILED`, `CANDIDATO_ID_MISSING` e `MULTIPLE_INSCRICOES_PORTAL` seguem terminais — são recusa do portal, não credencial ausente.
- **Contexto**: Ao retomar a inscrição da Bianca #24067 de uma máquina sem `SUMARE_SOFTSY_LOGIN`/`PASSWORD`, a captação falhou com `SOFTSY_NOT_CONFIGURED` e o lead foi pausado e marcado `distribuir_consultor` — punido por um problema de ambiente nosso, que um retry resolve.
- **Alternativas descartadas**: Tratar todo código de falha como infra (mascararia recusa real do portal e criaria loop de scheduler); manter terminal e corrigir por script a cada incidente; responder o redirect da faculdade ao lead (culpa o candidato por indisponibilidade nossa).
- **Impacto**: Enquanto a credencial/rede estiver quebrada, o scheduler continua tentando e logando `captação INFRA` em `console.error` — é o sinal operacional esperado, sem spam ao lead. `ctxForm` volta `null` nesse ramo, então a telemetria não reporta inscrição concluída.

### 2026-09-09 - Campo de cadastro faltando não pausa a IA (`aguardando_dados_cadastro`)
- **Modelo usado**: Cursor Grok 4.6 (não confirmado)
- **Decisão**: `MISSING_FIELDS` da captação deixa de ser falha terminal. Novo estado `aguardando_dados_cadastro` espelha `aguardando_distribuicao_form`: pede o dado, mantém a IA ativa e não grava `distribuir_consultor`. A reentrada só acontece com dado extraível (`looksLikeCadastroAnswerForAguardandoDados`) ou Flow refeito, e libera os skips de nota pós-form via `allowRetryAfterCadastroData`. Rede de segurança dupla: `decideHoldOnIaPause` devolve `hold=false` nesse estado, e `persistCadastroFieldsFromInbound` roda no ramo `hold=true` do webhook e do `runAgent` — gravar campo objetivo no card não é responder.
- **Contexto**: Bianca #24067 — o Flow chegou sem e-mail, o agente pediu ("faltam informações no cadastro: **email**") e no mesmo turno pausou a IA. Ela respondeu `bibirmazv@gmail.com`, o gate de pause descartou o turno antes do card sync, e o card ficou com Email em "+ Adicionar" sem nenhuma resposta no chat.
- **Alternativas descartadas**: Manter o estado terminal e fazer backfill por script (perde a conversa); remover o gate de pause para qualquer inbound (reabre loops de reenvio de link); confiar no LLM para reperguntar (ele já perguntou e o dado se perdia no gate).
- **Impacto**: A ordem importa — o card sync (`agentRunner`) roda antes do pipeline pós-form, então a captação já relê o snapshot com o e-mail. Leads que já estão em `distribuir_consultor` por esse motivo continuam presos e precisam de resgate pontual.

### 2026-09-09 - Não existe consultor; lacuna vai para links oficiais
- **Modelo usado**: Cursor Grok 4.6 (não confirmado)
- **Decisão**: Neste canal não há consultor nem equipe que assume o WhatsApp. Informação que as tools não cobrirem (ex.: dias/horários exatos das aulas presenciais) é respondida com os links já cadastrados (`https://sumare.edu.br/atendimento/` e `https://sumare.edu.br/ouvidoria.html`; Portal do Aluno só na Regra 32). Prompt regra 35; intercepto determinístico de calendário presencial e de pedido/aceite de "consultor"; reply guard troca oferta de consultor pelos mesmos links. `distribuir_humano` fica só para quem pede explicitamente para sair do canal.
- **Contexto**: Dafylyn Polidorio #23914 perguntou os dias presenciais de Pedagogia Semipresencial. O agente ofereceu verificar com consultor; ela aceitou ("Por gentileza" / "Consultor") e caiu na confirmação de saída de canal.
- **Alternativas descartadas**: Manter oferta de consultor + confirmação de saída; tratar calendário como Portal do Aluno (candidato ainda em captação); inventar dias da semana.
- **Impacto**: A pergunta de dias presenciais não oferece humano. Pedido de consultor recebe atendimento/ouvidoria. "Quando começam as aulas?" continua comercial.

### 2026-09-08 - Pagamento futuro da matrícula (pós-link) não reenvia portal
- **Modelo usado**: Auto (modelo ativo não confirmado)
- **Decisão**: Em `aguardando_aceite_contrato` / Aguardando pagamento, se o candidato informar que só poderá pagar em data futura (`Receberei só dia 18`, `só consigo pagar dia 19`, `mande o boleto para dia 19`, etc.), o `inscricaoAceitePagamentoFlow` responde de forma canônica acolhedora (retorno no dia mencionado → aí sim o link do portal) **sem** reenviar URL, sem prometer emissão antecipada, agendamento, PDF, linha digitável ou vencimento customizado. A detecção usa `libShared/deferredPaymentEnrollmentHeuristics.js` (`dia N`, `DD/MM`, e `daqui a N dias` quando comparável em America/Sao_Paulo); data ambígua/passada deixa o reenvio normal seguir. No retorno na data/depois, o pedido de boleto/link reutiliza o fluxo existente (refresh + portal `matricula.sumare.edu.br`, PIX/boleto/cartão no portal — o sistema não gera boleto). Boleto comercial de matrícula pré-pagamento nesse status vence o redirect acadêmico da Regra 32 pela ordem do pipeline; boleto acadêmico pós-matrícula/2ª via/mensalidade mantém a Regra 32. Sem migration/campo novo, sem mensagem proativa/scheduler; nota CRM opcional se já houver `createLeadNote` no handler.
- **Contexto**: Refina a decisão de 2026-09-02 (financeiro/boleto → Regra 32): o pedido de boleto na fila de pagamento da matrícula é comercial, não institucional. Candidatos que avisam data futura não devem receber o link imediatamente nem um redirect acadêmico.
- **Alternativas descartadas**: Scheduler/mensagem proativa na data; campo de banco / migration; emissão de boleto/PDF/vencimento customizado; alterar a heurística global de Regra 32 com dependência de status no banco; misturar com `deferredPaymentEnrollment` pré-inscrição (matrícula só na data do pagamento).
- **Impacto**: Deferimento roda no aceite pós-link **antes** de `messageAsksContratoLinkResend`. Comprovante, claims de pagamento, reenvio sem data futura e deferred pré-inscrição permanecem intactos.

### 2026-09-08 - Proteções contra matrícula/curso/polo/transferência fabricados (Rute #24045)
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: Cinco guardas determinísticas. (1) `sanitizeCursoName` deixa de cortar em 5 tokens (passa a 12) para não gravar pós longas truncadas. (2) Número 1–5 só casa polo na *última* lista do assistente se essa lista for de polos; lista de cursos ou histórico antigo não sobrescreve polo já escolhido. (3) `parseSemestreFromUserMessage` ignora data de nascimento/CPF; `extractTransferenciaContext` só existe com evidência de transferência no histórico. (4) `registrar_transferencia` recusa histórico sem evidência; o hint do LLM só manda chamar a tool com origem+destino+semestre completos. (5) Resolvedor de transferência exige ≥2 tokens compartilhados; pós presente na planilha de preços e ausente na API de captação não gera candidato de vestibular nem alternativas de graduação (`CURSO_OFICIAL_SEM_CODIGO_CAPTACAO`).
- **Contexto**: Rute #24045 pediu pós Educação Infantil e Desenvolvimento da Linguagem, escolheu polo Santana e preencheu o form. O card truncou o curso, o pós-form disse que a oferta não existia, o “1” da lista de alternativas virou Barra Funda, o modelo chamou transferência com semestre 12 (nascimento 12/02/1985) e o resolvedor mapeou a pós para `ADS_EAD`. O portal mostrou Ciências Contábeis.
- **Alternativas descartadas**: Corrigir só o lead; confiar no LLM; aceitar 1 token (`desenvolvimento` → ADS); varrer listas antigas de polo.
- **Impacto**: Matrícula automática deixa de fabricar transferência/curso/polo neste padrão. Pós sem código de captação confirma a oferta oficial e aponta atendimento, sem link de vestibular. O cadastro já gerado da Rute permanece para correção operacional.

### 2026-09-08 - Acesso ao AVA/plataforma do aluno entra na Regra 32
- **Modelo usado**: Grok 4.6 (não confirmado)
- **Decisão**: Falha de acesso ao AVA, plataforma do aluno, login/RA/senha de primeiro acesso, tela travada ou envio de documentação no ambiente do aluno é assunto institucional da Regra 32 e recebe `buildAcademicAffairsRedirectReply`. Não promete consultor. O formulário de inscrição do WhatsApp que não abre permanece no fluxo comercial de reenvio.
- **Contexto**: Valquíria Aidar #23690 recebeu login do Semipresencial, a tela do AVA travou em preferências/perfil e o agente prometeu consultor e pediu confirmação de saída de canal.
- **Alternativas descartadas**: Handoff humano genérico; tratar qualquer “não está funcionando” como acadêmico (capturaria o Flow do WhatsApp).
- **Impacto**: Pedidos posteriores de atendente no mesmo histórico acadêmico passam a ser interceptados pelo redirect institucional, que já roda antes do handoff.

### 2026-09-04 - Link de pagamento move o card para Aguardando pagamento
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: Assim que o agente encaminha o link de pagamento da matrícula (`matricula.sumare.edu.br/Vestibular/pagamento`), o deal EduIT sai de Inscrição (`cmt38aydx01q7rw01w0of9px5`) e vai para Aguardando pagamento (`cmt38aydx01q8rw010d91vy1t`). A fila de pagamento entra no funil da IA no EduIT para o agente ainda reenviar o link e receber o comprovante. Snapshot incompleto ou formulário sem link permanece em Inscrição.
- **Contexto**: Cards com boleto já enviado ficavam na coluna Inscrição. A regra antiga (Kommo) só movia após o comprovante.
- **Alternativas descartadas**: Mover e tirar a IA da fila (quebraria comprovante); mover só no comprovante (não atende o funil comercial pedido).
- **Impacto**: `moveLeadToAguardandoPagamentoIfNeeded` roda no envio do link (captação / inscrição existente). Aguardando pagamento não é mais estágio fora do agente no EduIT.

### 2026-09-04 - Flow EduIT conta como formulário recebido (não reenviar)
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: O retorno do WhatsApp Flow no EduIT (`📋 *Resposta do formulário*`, `FORMULÁRIO flow`, `*Label* ↳ valor`) passa a ser reconhecido como formulário preenchido. No card EduIT, nome+CPF (ou CPF+e-mail) basta para `detectFormSumarRecebidoNoKommo`. Snapshot incompleto (falta e-mail ou curso) pede o campo que falta; nunca diz "ainda não recebemos" nem reenvia o Flow. O parser também grava nome/CPF/e-mail/nascimento no card se ainda estiverem vazios.
- **Contexto**: limaia #23961 (Eliane) e Josialves #23947 (Josina) — o Flow já estava no chat e a tag Formulario aplicada, mas o detector só aceitava "Flow responses received" / `Nome:` e exigia snapshot completo (`nome,email,cpf,curso`). O bloco EduIT usava `↳` e o e-mail/curso às vezes não iam ao card; o ramo `claim_sem_confirmacao` reenviava o formulário no mesmo minuto da tag.
- **Alternativas descartadas**: Exigir snapshot completo para detectar (causa o falso "não recebemos"); tratar "já enviei"/"pronto" isolado como Flow (quebraria o reenvio legítimo 5b); inventar e-mail.
- **Impacto**: Próximos Flows EduIT avançam para captação ou pedido de campo faltante. "Pronto" sem Flow e sem identidade no card continua reenviando. Cards antigos precisam de um turno novo (ou o inbound do Flow no histórico).

### 2026-09-02 - Troca de polo de matrícula entra na Regra 32
- **Modelo usado**: Claude Opus 4.6 (não confirmado)
- **Decisão**: Pedido de alteração, troca, transferência ou migração de polo é assunto acadêmico institucional e recebe `buildAcademicAffairsRedirectReply` (Portal do Aluno, atendimento oficial e ouvidoria). A heurística exige `polo`/`polos` junto de verbo inequívoco de movimentação. Escolha inicial de polo permanece no fluxo comercial quando a mensagem menciona inscrição, formulário ou escolha de polo.
- **Contexto**: Silvia Lopes #23903, já tratando declaração de matrícula e erro no Portal do Aluno, perguntou `Como faço para mudar de polo`; a frase não era reconhecida nem como assunto acadêmico nem como localização.
- **Alternativas descartadas**: Tratar `polo` isolado como acadêmico (capturaria busca de unidade e escolha pré-form); depender do histórico ou do LLM; alterar a ordem dos fluxos no `agentRunner`.
- **Impacto**: O redirect acadêmico roda antes dos fluxos normais de polo/localização. Guardas explícitas preservam frases como `quero escolher o polo Tatuapé para minha inscrição` e `antes do formulário`. A detecção aceita plural (`polos`) e não interfere em transferência externa de curso.

### 2026-09-02 - Setor financeiro e boleto entram na Regra 32
- **Modelo usado**: Claude Opus 4.6 (não confirmado)
- **Decisão**: Pedido de contato com o setor financeiro ou cobrança e pedido de emissão, envio, segunda via ou regularização de boleto já gerado passam a ser assunto institucional da Regra 32, respondidos pelo `buildAcademicAffairsRedirectReply` (Portal do Aluno, `https://sumare.edu.br/atendimento/` e ouvidoria). O novo helper `messageAsksFinanceiroInstitucional` em `libShared/academicAffairsHeuristics.js` exige intenção de contato (`falar com`, `contato`, `setor`, `departamento`, `atendimento`, `secretaria`) junto de `financeiro` ou `cobrança`, e avalia os negativos de forma de pagamento antes dos positivos de boleto. Boleto como forma de pagamento, valor, desconto e mensalidade continuam comerciais. A detecção usa `\bfinanceiro\b` e `\bcobran[cç]a\b`, nunca o prefixo `financ`, para não capturar financiamento, FIES ou PRAVALER.
- **Contexto**: Pri Barreiros #23910 escreveu apenas "Quero falar com o financeiro" e recebeu a lista dos cinco polos EAD. A heurística acadêmica não cobria financeiro nem boleto, e `messageRequestsHuman` era verdadeiro, o que levaria a mensagem ao handoff humano genérico, sem os três canais oficiais.
- **Alternativas descartadas**: Tratar o pedido como handoff humano (não entrega os canais); usar `\bboleto\b` genérico (quebraria "aceita boleto?" e formas de pagamento); usar prefixo `financ` (capturaria financiamento e FIES); reordenar o pipeline para o handoff perder do redirect, desnecessário porque o fluxo acadêmico já roda antes.
- **Impacto**: O caminho de polos para essa mensagem já havia sido fechado pela decisão do telefone institucional; agora a mensagem recebe o direcionamento correto. A IA permanece ativa para dúvidas comerciais, conforme o item (d) da Regra 32. Ficou registrado que "manda o boleto do curso pra eu ver" pode ser classificado como institucional, borda aceita por ser conservadora.

### 2026-09-02 - Pós-form: curso informado indisponível não volta a ser curso ausente
- **Modelo usado**: Opus 4.7 (Strategist isolado)
- **Decisão**: O pipeline pós-formulário passa a distinguir `CURSO_AUSENTE` de `CURSO_NAO_RESOLVIDO`/`CURSO_INVALIDO_SNAPSHOT`. Somente curso realmente ausente usa `buildAskCursoAfterFormReply`. Para curso informado sem oferta exata, `lookupRelatedCursoOfertas` consulta `grad_preco` e `pos_preco` por tokens específicos compartilhados e retorna até três alternativas oficiais com nível, modalidade, duração e mensalidade; o pipeline responde com indisponibilidade e alternativas, ou com indisponibilidade sem alternativas, mantendo `aguardando_distribuicao_form` e sem executar captação/contrato. Partial match de captação com consulta de um único token não pode escolher silenciosamente uma oferta multi-token; consultas com dois ou mais tokens exigem ao menos dois compartilhados e resultado inequívoco.
- **Contexto**: Amanda #23840 informou `Psicologia` após preencher o formulário. O curso foi gravado no card, mas a graduação EAD não existe no catálogo de captação; o código tratou `CURSO_NAO_RESOLVIDO` como curso faltante e perguntou novamente qual curso ela queria, em vez de apresentar as três pós-graduações EAD relacionadas.
- **Alternativas descartadas**: Corrigir `resolveCursoNomeForResumo` (o nome já era resolvido); confiar no LLM; inventar graduação/preço; criar novo status ou tabela; aceitar partial match `Psicologia` → `Psicologia Organizacional`.
- **Impacto**: Curso presente nunca volta à pergunta genérica de nome. Ofertas relacionadas usam somente dados dos catálogos oficiais atuais. Curso disponível por match exato mantém o caminho existente; campos cadastrais realmente ausentes continuam no builder próprio. A divergência lateral do polo da Amanda (`1`/Barra Funda no histórico versus `Santana` no card) permanece fora deste escopo.

### 2026-09-02 - Telefone institucional somente sob pedido explícito
- **Modelo usado**: Claude Opus 4.6 (não confirmado)
- **Decisão**: O telefone geral da Faculdade Sumaré / Unidade Pinheiros, `(11) 3067-7999`, pertence ao fluxo acadêmico institucional da Regra 32, mas só pode ser informado quando o candidato pedir explicitamente telefone ou número de contato acadêmico/institucional. Um pedido direto identifica a instituição ou o setor acadêmico no mesmo turno; um follow-up curto (`Preciso de telefone`, `qual o número?`) exige histórico recente de direcionamento acadêmico oficial. Pedidos genéricos de boleto, diploma, histórico, cancelamento ou trancamento continuam recebendo apenas os canais oficiais existentes, sem telefone automático.
- **Contexto**: Andrea #23913 pediu contato para diploma e histórico, recebeu o direcionamento acadêmico correto e depois escreveu `Preciso de telefone`; como `telefone` estava na heurística genérica de localização, o agente respondeu com a lista de polos.
- **Alternativas descartadas**: Incluir o telefone em todo redirect acadêmico (viola a exigência de solicitação explícita); manter `telefone` isolado como intenção de polo/localização; deixar a distinção apenas para o LLM.
- **Impacto**: O fluxo acadêmico deve interceptar o pedido telefônico antes do fluxo de polos, com exclusões determinísticas para telefone cadastral do lead, WhatsApp, polo/endereço/região e pedido de consultor. A resposta canônica contém somente `(11) 3067-7999`; outros números não são autorizados por esta decisão.

### 2026-09-02 - Lista de polos ≠ lista de cursos; formulário exige curso resolvido
- **Modelo usado**: Grok 4.6 (não confirmado)
- **Decisão**: Quatro guardas determinísticas. (1) `isPoloNameLike` (novo export de `libShared/cursoConfirmation.js`, igualdade normalizada contra `SUMARE_POLOS_EAD` + `pinheiros`/`central`) bloqueia nome de polo no campo Curso; `matchCursoFromNumberedAssistantList` retorna vazio quando a lista numerada de origem é lista de polos, e `detectCursoConfirmadoPeloLead` tem guarda final. (2) `assistantAskedPoloPreFormChoice` não considera `buildPoloEadAndCentralInfoReply` (resposta institucional EAD + Central) como pedido de escolha de polo. (3) `tryHandlePoloLocationInfoFlow` devolve `null` quando a mensagem contém curso reconhecível (`extractCursoAreaFromText`), para o curso não ser descartado; e `tryHandlePoloPreFormFlow` devolve `null` em pergunta de semipresencial/Central em vez de "não consegui identificar o polo". (4) Nenhum dos dois caminhos de `inscricaoPoloFlow.js` dispara `deliverInscricaoForm` sem curso resolvido (`resolveCursoNomeForResumo`, agora exportado): a escolha de polo passa a gravar `aguardando_curso_pre_form` e pergunta o curso; o atalho de polo já persistido aborta com `null` sem gravar `matricula_autorizada`. Corrigida de passagem a regex de lista numerada, que consumia `\n` e pulava itens pares.
- **Contexto**: Jean #23912 — pediu "Biomedicina semipresencial"; o curso foi descartado em favor da resposta institucional de polos, a lista numerada dessa resposta ativou o passo de escolha de polo, "Opções semipresenciais em Pinheiros" virou polo inválido, e "2" gravou curso=`Santana` no card e disparou o formulário com polo Tatuapé sem curso nenhum.
- **Alternativas descartadas**: Resolver por prompt/LLM (a cadeia inteira é determinística); manter a lista 1–5 como resposta a pergunta de semipresencial; permitir formulário sem curso e corrigir depois no pós-form; usar `includes` em `isPoloNameLike` (bloquearia cursos legítimos).
- **Impacto**: Regressão 32 em `scripts/test-inscricao-flow.mjs` (313 asserts, 5 suítes verdes). Novo estado `aguardando_curso_pre_form` não tem handler dedicado — a retomada depende do fluxo normal. Seis outros call sites de `deliverInscricaoForm` (`inscricaoActionTools.js`, `inscricaoFormFlow.js`, `inscricaoPostFormPipeline.js`) seguem sem guarda de curso; o gate de matrícula ainda faz `proceed: true` quando não resolve curso.

### 2026-09-02 - Formação anterior/atual não vira curso desejado (transferência)
- **Modelo usado**: Claude Opus 4.6 (não confirmado)
- **Decisão**: Narrativas inequívocas de formação anterior/atual (`cursei`, `cursava`, `estudei`, `fiz`, `estou cursando`, etc.) sem verbo explícito de destino/interesse não confirmam curso desejado (`detectCursoConfirmadoPeloLead`). Em transferência, `tryHandleTransferenciaDadosPendentes` short-circuita (sem LLM/API) quando o lead só lista formações cursadas/em andamento sem semestre e/ou origem única; retém destino já explícito no histórico (ex.: `que no seu caso é Educação Física Bacharelado`) e pede só origem + semestre. Removidos fallbacks genéricos que fabricavam `origem=destino` sem evidência; preservado o restate explícito do cenário Lidi.
- **Contexto**: Leidy #23889 — agente sabia Educação Física Bacharelado, pediu dados de transferência; ela respondeu "Cursei pedagogia, letras e estou cursando educação física licenciatura" e o sistema gerou resumo de matrícula para Licenciatura; depois, ao corrigir "Eu quero o bacharel", pediu só autorização de novo.
- **Alternativas descartadas**: Corrigir só via prompt/LLM (não determinístico); tratar qualquer menção a curso como destino; inventar origem=destino quando faltam campos.
- **Impacto**: Próximos turnos de transferência com lista de formações pedem origem/semestre sem trocar o destino. Conversas já contaminadas precisam de um turno novo.

### 2026-09-02 - CPF, e-mail e nascimento do chat vão para o card EduIT
- **Modelo usado**: Grok 4.6
- **Decisão**: Em cada turno, `persistCadastroFieldsFromInbound` lê a mensagem atual e as últimas falas do lead, extrai só CPF válido, e-mail e data de nascimento, e grava no card EduIT (`cpf`, `email`, `dtnascimento`) se o campo ainda estiver vazio/inválido. Espelha `kommo_cpf` / `kommo_email` / `kommo_data_nasc` no Supabase. Não sobrescreve valor bom; não usa o LLM.
- **Contexto**: Leidy #23889 — o agente pediu cpf/email/dataNasc, ela mandou no WhatsApp, o card ficou em "+ Adicionar". Curso/polo já tinham writer; esses três não.
- **Alternativas descartadas**: Pedir de novo no prompt (o modelo já pediu e não gravou); depender só do Flow (neste caso veio incompleto).
- **Impacto**: Próximos turnos preenchem o card. Cards já vazios precisam de um turno novo (ou backfill pontual).

### 2026-09-01 - Curso confirmado na conversa grava no campo EduIT antes do formulário

- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: `setSumCursoOnLead` e `setSumPoloOnLead` rodam assim que o histórico está pronto — antes dos early-return de resumo/form. O mesmo write acontece no resumo, no envio do Formulario e quando o lead responde 1–5/nome de polo. No EduIT o PUT usa `{ values: [{ fieldId, name, value }] }` e espelha `kommo_curso` / `kommo_polo` no Supabase.
- **Contexto**: Juliana #23881 — Pedagogia no resumo e polo "4" (São Miguel) no chat, tag Formulario e CPF no Flow, mas Curso e Polo vazios no card. O write antigo só rodava depois desses handlers, ou falhava sem CUID.
- **Alternativas descartadas**: Esperar o Flow mandar o curso (o formulário não tem esse campo); gravar só no Kommo.
- **Impacto**: Próximos "Sim" após resumo preenchem Curso no card. Cards já vazios precisam de um turno novo ou backfill.

### 2026-09-01 - Lookup por telefone no backend EduIT não pode cair no Kommo

- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: Com `CRM_BACKEND=eduit`, o id do atendimento é o CUID do deal. `Number(id)` em CUID é proibido (vira `NaN` e o código ia no Kommo). Resolver sempre via `resolveCrmLeadId` (hint CUID → `eduit_deal_id` → lookup EduIT). Hint numérico Kommo é descartado. Snapshot/curso/polo e detecção pós-form leem o deal EduIT; inbound não espelha mais no Kommo.
- **Contexto**: Teste no #25 (William) devolveu `leadId=23841399` (Kommo antigo) e o prompt dizia "id_lead (Kommo)". `dados_cliente_sum.id_lead` ainda pode ter o número velho se `eduit_deal_id` estiver vazio.
- **Alternativas descartadas**: Manter o endpoint de teste no cliente Kommo (reproduz o bug a cada homologação); fallback silencioso para o número Kommo do Supabase.
- **Impacto**: Card/snapshot e captação pós-form passam a usar o deal EduIT. Produção precisa do commit no EasyPanel. Handoff humano (`distribuir_humano`) e dashboard Kommo ficam de fora deste corte.

### 2026-09-01 - Inscrição no portal novo (matricula.sumare.edu.br / Softsy + educsy)

- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: O vestibular deixa de usar `GET /api-ingresso/candidato/gerar` + link `sumare.edu.br/vem-pra-sumare/vestibular/contrato?id=`. O caminho oficial (HAR do site) é: login Softsy → oferta (`turnos/cursos/escolas/infoValor`) → `POST /candidato/v1/pessoa-candidato` → `POST /api-inscricao-educsy/inscricao` → `assinar-sem-token` → link `https://matricula.sumare.edu.br/Vestibular/pagamento?cpf={cpf}&utm_campaign=sumareeadpolos`. `GET /gerar` fica só para transferência ou `SUMARE_INSCRICAO_PATH=legacy`. Sem `SUMARE_SOFTSY_LOGIN/PASSWORD` a inscrição vestibular falha (`SOFTSY_NOT_CONFIGURED`) em vez de cair no portal antigo.
- **Contexto**: Cadastro da Alessandra #23868 nasceu no portal antigo (`meioPagamento?cobranca=&id=`). O negócio confirmou que a tela correta é a de `matricula.sumare.edu.br/Vestibular/pagamento`.
- **Alternativas descartadas**: Só trocar a URL mantendo `/gerar` (o candidato continua no funil antigo); fallback silencioso para `/gerar` quando Softsy não está no env (repetiria o erro).
- **Impacto**: Produção precisa de `SUMARE_SOFTSY_LOGIN` e `SUMARE_SOFTSY_PASSWORD` no EasyPanel. O WhatsApp passa a mandar o link com CPF, não com o código 2026.

### 2026-08-31 - API EduIT via `integrations.bwipo.com`
- **Modelo usado**: Grok 4.6
- **Decisão**: O agente passa a usar `EDUIT_BASE_URL=https://integrations.bwipo.com` (token Bearer `EDUIT_API_KEY`, sem hardcode no git). Homologado no negócio #25: health, deal, tags, conversa e mensagens 200. O CRM de UI (`sumare-ead.bwipo.com`) permanece para operadores; o agente fala com o host de integrações.
- **Contexto**: Mudança no modo de uso do token — a key nova só autentica em `integrations.bwipo.com`.
- **Alternativas descartadas**: Manter `sumare-ead.bwipo.com` com a key nova (não é o contrato atual); versionar o token no repositório (segredo).
- **Impacto**: Produção (EasyPanel) precisa das duas variáveis atualizadas no restart. Sem o token novo no painel o deploy da URL sozinha não autentica.

### 2026-08-31 - Formulário de inscrição via tag EduIT "Formulario"
- **Modelo usado**: Grok 4.6
- **Decisão**: No backend EduIT, `deliverInscricaoForm` aplica a tag `Formulario` (`POST /api/deals/{dealId}/tags` `{ tagId: cmth9k8ne129wqm01rd7d464s }`). A automação do CRM escuta essa tag e envia o WhatsApp Flow "Candidato". Override `EDUIT_TAG_FORMULARIO_ID`. Sucesso move o deal para Inscrição e registra nota. Kommo inalterado. `POST /api/automations/{id}/run` fica no cliente mas não é o caminho quente (API key 401 + `allowManualRun: false`).
- **Contexto**: Gatilho manual da automação foi trocado para tag. Teste no negócio #25 aplicou a tag e o Flow saiu no WhatsApp às 13:21 UTC.
- **Alternativas descartadas**: Continuar no `/run` da automação (401 na API key); salesbot Kommo.
- **Impacto**: A tag `BV_sumare` permanece; o POST só acrescenta. Reaplicar a tag reenvia o Flow.

### 2026-08-31 - Formulário de inscrição via automação EduIT
- **Modelo usado**: Grok 4.6
- **Decisão**: No backend EduIT, `deliverInscricaoForm` dispara `POST /api/automations/{id}/run` com `{ dealId }` em vez do salesbot Kommo Formulario_Sum. ID padrão `cmtbpgc9909ato701am40ffww`, override `EDUIT_AUTOMATION_FORMULARIO_SUM_ID`. Sucesso move o deal para a etapa Inscrição e registra nota. Kommo inalterado.
- **Contexto**: CRM EduIT não tem salesbot; a automação do CRM é o canal que envia o formulário no WhatsApp.
- **Alternativas descartadas**: Continuar no salesbot Kommo (IDs numéricos quebram no EduIT); enviar o form por texto do agente (não abre o fluxo nativo de captação).
- **Impacto**: A API key precisa de permissão em `/api/automations`. Sem isso o disparo retorna 401 e o agente não afirma que o formulário foi enviado.

### 2026-08-29 - Flow Meta + nota na conversa EduIT (sem reenviar WhatsApp)
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: Enviar o Formulario Candidato pela Cloud API (`flow_id` `2505237399980312`). Em seguida gravar na conversa EduIT com `POST /api/conversations/{id}/messages` `{ messageType: "note", content }` — único shape que **não** dispara WhatsApp de novo. `POST` texto/interactive no EduIT reenvia o canal. A nota é `isPrivate` (aparece no thread do CRM; o histórico da IA ignora `isPrivate`).
- **Contexto**: Envio Meta no #25 chegou no WhatsApp 09:10 e não no CRM, porque o Graph API não passa pelo EduIT. `POST …/flow` da API key ainda é 401.
- **Alternativas descartadas**: Dual-write texto no EduIT (reenvia); esperar webhook Meta→EduIT (não espelhou outbound).
- **Impacto**: `deliverInscricaoForm` no backend eduit usa Meta Flow + nota. Env `WHATSAPP_META_FLOW_FORMULARIO_ID`.

### 2026-08-29 - Disparo do formulário EduIT = POST conversation/flow (não automations/run)
- **Modelo usado**: Opus (principal)
- **Decisão**: O envio real do Form Sumar no EduIT (UI → Network `flow`) é:
  `POST /api/conversations/{conversationId}/flow` com body `{ "flowDefinitionId": "cmtbpc5zy08hqo701gwxfnjy2" }`.
  Resposta de sucesso devolve `conversationId` + `message.id` (wamid). A automação de catálogo **`cmtbpgc9909ato701am40ffww`** é o rótulo/processo “formulário”; o ID operacional do Flow Meta no CRM é **`cmtbpc5zy08hqo701gwxfnjy2`**. Envs: `EDUIT_AUTOMATION_FORMULARIO_ID` (automação) + `EDUIT_FLOW_DEFINITION_FORMULARIO_ID` (flow). Após recebimento do form, a IA segue o atendimento.
- **Contexto**: Homologação deal #25 (William, conv `cmt4gmymx08xplw01yrndq8pb`). `POST …/automations/{id}/run` e `POST …/conversations/{id}/flow` existem (OPTIONS POST) mas a API key Bearer atual retorna **401**. Na UI (sessão usuário) o flow envia e gera wamid.
- **Alternativas descartadas**: Tratar GET `/automations/{id}?_rsc=` como disparo (é só página Next); enviar flow via `POST …/messages` com type genérico (vira texto ou “Mensagem vazia”).
- **Impacto**: Agente deve chamar `…/flow` com `flowDefinitionId`. Bloqueio atual: escopo da API key. Deal #25 / conversationId já mapeados.

### 2026-08-28 - Formulário de inscrição no EduIT via automação fixa
- **Modelo usado**: Opus (principal)
- **Decisão**: Com `CRM_BACKEND=eduit`, quando o agente precisar encaminhar o formulário ao candidato (mesmo momento em que no Kommo dispara o salesbot `Formulario_Sum` / `49815`), **não** usar salesbot Kommo nem template Meta como caminho primário. Acionar a automação EduIT **`cmtbpgc9909ato701am40ffww`** (formulário). Env canônico: `EDUIT_AUTOMATION_FORMULARIO_ID` (default desse CUID). Após o **recebimento** do formulário, a IA **continua o atendimento** no funil (pós-form / polo / aceite / captação já existentes no Supabase + etapas Inscrição); o submit do form **não** pausa a IA nem encerra o canal por si só.
- **Contexto**: Cutover EduIT; Salesbot Kommo não existe no CRM novo. Automação de formulário já criada no EduIT com esse CUID.
- **Alternativas descartadas**: Manter `runKommoSalesbot` com backend eduit (não opera); só `INSCRICAO_FORM_DELIVERY=whatsapp_template` como primário (bypass da automação oficial do CRM); pausar IA no submit (quebraria aceite/contrato/comprovante).
- **Impacto**: Ver atualização 2026-08-31 — caminho quente é tag `Formulario` no deal.

### 2026-08-27 - Atalhos de estado terminal exigem recência, relevância e não-repetição
- **Modelo usado**: Opus (principal), implementação Cursor Grok 4.5 Executor
- **Decisão**: Atalhos "early" que respondem só pelo `inscricao_form_status` deixam de capturar o turno incondicionalmente. (1) `comprovante_pagamento_recebido` em `inscricaoAceitePagamentoFlow`: só dispara com `captacao_comprovante_at` dentro de `INSCRICAO_COMPROVANTE_SHORTCUT_MAX_AGE_DAYS` (default 7; ausente/inválido = dentro), mensagem aprovada por `messageRelatesToComprovanteEmConferencia` e resposta diferente da última do assistente; caso contrário retorna `null`. (2) `saida_canal_concluida` em `humanHandoffFlow`: retomada de contato (`messageExpressesRenewedInscricaoInterest` ou `messageRequestsNewAttendance`) limpa `inscricao_form_status`/`atendimento_ia` e devolve o turno ao fluxo normal, com a mesma guarda anti-repetição. `desistencia_concluida` fica inalterado (já tem revogação por interesse renovado e zero disparos em 72h).
- **Contexto**: Samuel Oliveira, comprovante de 08/07, recebeu "já recebemos seu comprovante" ao pedir trancamento e ao mandar um link, duas vezes em 4 min. Julio, em `saida_canal_concluida`, perguntou sobre curso e boleto e pediu "novo atendimento"; foi dispensado com o texto de canal encerrado e reagiu com ofensa. Mesma família do caso William: estado salvo dominando a conversa atual.
- **Alternativas descartadas**: Manter o atalho e apenas injetar hint no LLM (não impede o curto-circuito, que responde antes do prompt); limpar o status automaticamente ao expirar a janela (escrita arriscada no hot path e perda de evidência operacional); aplicar janela também na desistência (sem evidência de dano e semântica genuinamente terminal).
- **Impacto**: Cai fora do atalho quem não fala do assunto ou tem registro velho; `inscricaoFormAlreadyFilled` continua impedindo reenvio de formulário. Heurísticas são lexicais: frases ambíguas ("oi", "?") seguem no texto canônico.

### 2026-08-27 - Histórico EduIT + course drift no caminho quente (`agentRunner`)
- **Modelo usado**: Cursor Grok 4.5 Executor (sob decisão Opus Strategist)
- **Decisão**: No backend EduIT, `loadRecentHistoryMessages` passa a poder buscar `loadCrmRecentMessages` e fundir com Supabase via `mergeCrmAndSupabaseHistories` (tier exclusive quando CRM ≥ limiar). Rollout por flags: `AGENT_EDUIT_HISTORY_ENABLED` (default false), `AGENT_EDUIT_HISTORY_SHADOW` (busca/loga sem injetar), `AGENT_EDUIT_HISTORY_CANARY_PHONES` (CSV; vazio = global), `AGENT_EDUIT_HISTORY_LIMIT` (20), `AGENT_EDUIT_HISTORY_MIN_EXCLUSIVE_TURNS` (4). Após o histórico, `detectCourseSwitchAgainstCrmState` (kill switch `AGENT_EDUIT_COURSE_DRIFT_ENABLED`, default true no EduIT) bloqueia enriquecimento/form/polo/aceite/hints de estado antigo em `switched`/`staleUnknown`, impede `SUM_CURSO_UPDATE` regressivo para `previous`, e injeta instrução de prompt. Gate `atendimento_ia=pause` permanece antes do load (não carrega EduIT nem responde). Kommo inalterado. Falha EduIT degrada ao histórico anterior. Observabilidade: counts/source/exclusive + `COURSE_DRIFT` sem conteúdo integral; `ctxSnapshot.historySourceDetail` e `courseSwitch`.
- **Contexto**: Caso William — EduIT recente (saúde→Biomedicina→"Sim") vs Supabase antigo (Pedagogia/aguardando_aceite/Tatuapé) capturava confirmação curta com form/link/curso errados.
- **Alternativas descartadas**: Persistir histórico EduIT no Supabase como fonte única (acoplamento e atraso); só resetar estado de inscrição no drift (apaga evidência operacional e exige escrita arriscada no hot path).
- **Impacto**: Rollout shadow → canary → global. Sem env novas ligadas, comportamento = pré-fatia. Não limpa estado automaticamente no drift.

### 2026-08-27 - CRM EduIT na VPS Bwipo (`sumare-ead.bwipo.com`)
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: Apontar `EDUIT_BASE_URL` para `https://sumare-ead.bwipo.com` e usar a API key da nova instalação. Pipeline e etapas CUID permaneceram as mesmas (`Pipeline Principal`, Lead de Entrada / Atendimento / Inscrição).
- **Contexto**: Host antigo `frontend-front.v74knz.easypanel.host` passou a responder 503. Token antigo na URL nova dava 401.
- **Alternativas descartadas**: Manter o host EasyPanel; reaproveitar a key antiga.
- **Impacto**: Local já autentica (deals/conversas/filas). Produção (EasyPanel do agente) precisa das mesmas duas envs e restart. Não commitar a key.

### 2026-08-26 - Scheduler EduIT inclui Lead de Entrada e telefone do contato
- **Modelo usado**: Cursor Grok 4.6
- **Decisão**: A fila automática da IA no EduIT passa a listar Lead de Entrada além de Atendimento e Inscrição. O telefone do contato no card vale quando ainda não há linha em `dados_cliente_sum`. O gate continua movendo Entrada → Atendimento no flush. `eduitAgentStageIds` não inclui Entrada (evitar pular o move).
- **Contexto**: Meta só bufferiza; o scheduler é quem responde. Sem Entrada na listagem e sem telefone no Supabase, a caixa de entrada ficava parada.
- **Alternativas descartadas**: Tratar Entrada como etapa da IA sem mover; depender só de flush manual.
- **Impacto**: Inbox com mensagem pendente na janela 24h entra no tick. Produção precisa do deploy deste código.

### 2026-08-26 - Migração de cards Kommo → EduIT preserva valores existentes
- **Modelo usado**: Auto (Opus, versão não confirmada), com Strategist isolado.
- **Decisão**: Sincronizar negócios existentes por telefone exato, somente quando houver um único lead correspondente no pipeline Kommo. Preencher apenas campos vazios no EduIT, validar opções SELECT e datas, aplicar a partir de dry-run auditável e confirmar cada PUT por releitura do card.
- **Contexto**: Migração executada em 205 negócios EduIT; 156 matches seguros receberam 825 campos verificados. Conflitos, telefones sem correspondência, múltiplos candidatos e valores inválidos foram preservados no relatório sem escrita.
- **Alternativas descartadas**: Sobrescrever valores existentes no EduIT; aceitar match aproximado de telefone; confiar apenas no HTTP 200 do PUT; aplicar candidatos ambíguos.
- **Impacto**: Reexecução é idempotente (`fill-empty-only`). Relatórios em `data/sync-eduit-fields-from-kommo-*.json` documentam dry-run, piloto e aplicação completa.

### 2026-08-26 - Cutover env: CRM_BACKEND=eduit (inbound Meta, outbound EduIT)
- **Decisão**: Produção liga o CRM EduIT com `CRM_BACKEND=eduit`, `EDUIT_BASE_URL` e `EDUIT_API_KEY`. Variáveis Kommo permanecem no EasyPanel só para rollback (`CRM_BACKEND=kommo`). Inbound permanece no webhook Meta. Outbound, com backend eduit, ignora `WHATSAPP_OUTBOUND_MODE` e envia só `POST /api/conversations/{id}/messages`. Scheduler continua ligado (`KOMMO_SCHEDULER_ENABLED=true`); no backend eduit ele lista Atendimento+Inscrição no EduIT.
- **Contexto**: Fatia 1 (cliente/adapter/gate/backfill) já no código. Default do código continua kommo até o env de produção ser alterado e o serviço reiniciado.
- **Alternativas descartadas**: Dual-write Kommo+EduIT no mesmo tick (duplica mensagem); desligar Kommo tokens agora (impede rollback); webhook EduIT nesta fatia (ainda não homologado).
- **Impacto**: Deploy do código desta fatia **antes** de setar `CRM_BACKEND=eduit`. Sem o código novo as variáveis EduIT são ignoradas.

### 2026-08-24 - Custom fields: PUT com values[] (array), não objeto
- **Decisão**: Gravar campos com `PUT /api/deals/{cuid}/custom-fields` body `{ values: [{ fieldId, name, value }] }`. Host da UI EasyPanel `frontend-front.v74knz.easypanel.host`. Não alterar código do CRM por isso. Ler pelo CUID; `GET /api/deals/25` panel continua vazio.
- **Contexto**: Objeto `{ values: { polo: "..." } }` dá 200 sem persistir — falso negativo. Array no shape do dealPanelFields grava (homologado no #25).
- **Alternativas descartadas**: Pedir rewrite do handler; usar número do deal no GET.
- **Impacto**: Agente/eduitClient usa o array; token Bearer atual basta.

### 2026-08-24 - Custom fields: PUT no-op + GET número vs CUID
- **Decisão**: Tratar como bug do EduIT. Agente deve ler/escrever pelo CUID quando o PUT for corrigido. Mover para Perdido já funciona com a key atual (`PUT stageId`); 401 restante é channels/users/detalhe de conversa — não bloquear Perdido.
- **Contexto**: #25 GET `/api/deals/25` panel vazio; GET pelo CUID mostra curso/origem da UI. PUT API não sobrescreve.
- **Alternativas descartadas**: Pedir nova permissão só para fila Perdido (já movemos #25 e restauramos).
- **Impacto**: Time CRM corrige persistência + join; agente não muda key por causa de Perdido.

### 2026-08-24 - Sender WhatsApp permanece na Meta na fase 1
- **Decisão**: Agente continua enviando pela Cloud API / Evolution. EduIT é CRM (etapa/nota/campos). Não duplicar POST de mensagem no EduIT. CRM deve bloquear texto livre fora da janela 24h (UI + 422 `window_closed`). Custom fields: IDs ok, PUT 200 sem persistir — correção no EduIT.
- **Contexto**: Mesma API key lê deals/mensagens; 401 em `/api/channels`, `/api/users`, detalhe da conversa. Etapa Perdido já existe (`cmt38aydx01qbrw01sd97lahm`).
- **Alternativas descartadas**: Mandar tudo pelo POST do EduIT agora (API ignora 24h e não tem HSM). Tratar 401 como “falta fila Perdido”.
- **Impacto**: Time CRM corrige persistência de campos + escopos da key + gate 24h; agente só troca sender na fase 2.

### 2026-08-24 - EduIT como CRM alvo; Kommo permanece até dual-write sair
- **Decisão**: Migrar operação do agente para o CRM EduIT (`crm.eduit.com.br`). Funil por slug (Atendimento + Inscrição = IA). WhatsApp sender oficial = API do EduIT (não misturar Cloud API). Salesbot vira `POST /api/deals/{id}/actions/*` + webhook `deal.form_submitted`. Estado de inscrição/captação/pause continua no Supabase no dia 1. Spec de gaps e sprints em `docs/eduit-crm-instrucoes-completas.md`.
- **Contexto**: Conta EduIT própria; API Bearer já lista deals, move etapa, lê mensagens e cria nota. Bloqueios: webhooks 404, custom fields não gravam, templates vazios, 401 em canais/users.
- **Alternativas descartadas**: Continuar só no Kommo (CRM já está sendo substituído); reescrever o agente inteiro antes do contrato de API (quebra homologação no lead #25).
- **Impacto**: Time EduIT fecha Sprint A (API/webhooks/templates/campos); agente só troca cliente depois do aceite no deal William #25.

### 2026-08-11 - Log per-lead "buffer vazio" do scheduler gated por KOMMO_SCHEDULER_VERBOSE
- **Decisão**: Em `server/agentScheduler.js`, o `console.log` `[scheduler] buffer vazio session=... lead=...` só roda quando `showDetail` for true (`KOMMO_AGENT_TEST_LEAD_IDS` na whitelist OU `KOMMO_SCHEDULER_VERBOSE=true`). Sem isso, produção só emite o resumo agregado do tick (`stats.skippedNoMessages`). Diag detalhado do poll (URLs/dispatcher/events) continua atrás do mesmo gate.
- **Contexto**: Flood de logs no EasyPanel dava aparência de "diversas solicitações" simultâneas, levando a desligar o serviço por engano — na verdade eram só ticks ociosos do scheduler (buffer vazio), não crash nem sobrecarga real.
- **Alternativas descartadas**: Amostrar 1 a cada N leads (mais complexo, esconde qual lead específico ficou sem inbound quando precisar debugar); silenciar também o resumo do tick (perderia observabilidade de que o scheduler está rodando).
- **Impacto**: Produção com `KOMMO_SCHEDULER_VERBOSE` ausente/false (default) para de logar 1 linha por lead ocioso a cada tick; debug de whitelist/teste mantém o detalhe de sempre.

### 2026-07-23 - Duração no PDF de grade curricular por tipo de curso (fix Saneamento Ambiental)
- **Decisão**: Em `pdfDefaultsForRow` (`libShared/gradeCurricularPdfService.js`), usar `row.duracao` do JSON quando presente; senão, tecnólogo (via `grauFromCourseName`, prefixo de código `TS` ou nome/código contendo "tecnolog") default `'4 semestres'`; bacharelado/licenciatura default `'8 semestres'`; pós continua `'6 meses'`. Marcado `"duracao": "4 semestres"` nos registros `TSAMB_EAD` e `TSAMB_SEMI` em `data/grade-curricular-sumare.json`.
- **Contexto**: Lead #24135605 recebeu PDF de grade de Saneamento Ambiental (tecnólogo) com "8 semestres" — incorreto, curso tem 4 semestres.
- **Alternativas descartadas**: Hardcode só para TSAMB no JS sem campo no JSON (pior para manutenção, esconde a exceção); mudar duração default de todos os cursos de Gestão/tecnólogo para 4 semestres sem confirmar caso a caso (risco de errar outros cursos não auditados).
- **Impacto**: PDF de Saneamento Ambiental (EAD/Semi) sai com duração correta; outros tecnólogos passam a ter default 4 semestres a menos que o JSON tenha `duracao` explícita.

### 2026-07-16 - Nota de auditoria quando atendimento não conclui + curso/polo pós-form
- **Decisão**: Se pós-form/captação não concluir (falha terminal, redirect faculdade, lead não encontrado, polo/curso ausente), gravar nota Kommo via `createLeadAuditNote` com code/motivo/detalhe/EX. Form sem curso → pedir curso (não redirect). Polo ausente pós-form → pedir polo (não redirect).
- **Contexto**: Leads Aline #24120625 e Thiago #24121875 receberam `buildFacultyContactRedirectReply` após Form Sumar sem `sum_Curso`.
- **Alternativas descartadas**: Reativar salesbot consultor 49777; silenciar falhas só em log.
- **Impacto**: Timeline Kommo explica bloqueios; lead permanece no fluxo comercial pedindo curso/polo.

### 2026-07-23 - FAQ transferência externa: pergunta composta (o que fazer / quando começa / quantas matérias dispensa)
- **Decisão**: Registrar no RAG (`grad_info` id=78648, `pos_info` id=88961, topic `transferencia_externa_como_funciona`) a resposta-base aprovada para quando o lead pergunta o que precisa fazer, quando começa a estudar e quantas matérias dispensa numa transferência externa. Reforçar regra 31 (`server/ai/promptsLoader.js`) com subitem "PERGUNTA COMPOSTA": usar buscar_perguntas/buscar_conhecimento, responder no espírito da FAQ, coletar/confirmar os 3 campos e chamar `registrar_transferencia` quando completos. PROIBIDO inventar/estimar quantidade de disciplinas dispensadas antes da análise acadêmica.
- **Contexto**: Lead perguntou de forma combinada (o quê / quando / quantas matérias, já informando "fiz até o 3º semestre") e não havia orientação explícita nem FAQ dedicada para essa combinação — risco de inventar número de disciplinas ou perder o dado de semestre já informado.
- **Alternativas descartadas**: Responder só com texto genérico da regra 31 sem FAQ dedicada (a menção à pergunta composta ficaria diluída); prometer número aproximado de matérias dispensadas (proibido — só sai após análise de histórico/ementas).
- **Impacto**: Agente passa a ter FAQ específica para essa combinação de perguntas em grad_info/pos_info e reforço na regra 31 para não inventar número de disciplinas, não confundir com reativação de ex-aluno/2ª graduação, e reconhecer dados já informados pelo lead.

### 2026-07-21 - Match parcial de curso: não aceitar substring dentro da palavra
- **Decisão**: Em `sumareCaptacaoCursoStore`, match parcial exige tokens (palavra inteira), não `includes` bruto — evita "Psicopedagogia" → Pedagogia (`PED_*`).
- **Contexto**: Daiana #24132039 (pós Psicopedagogia); gerar com nome curto matriculava graduação Pedagogia.
- **Alternativas descartadas**: Bloquear só o par psico/pedagogia; manter substring.
- **Impacto**: Pós e nomes compostos deixam de colidir com cursos-substring.

### 2026-07-20 - Transferência: não misturar sucesso com faculty redirect
- **Decisão**: Se a captação falha no texto (redirect faculdade) mas o salesbot 49813 salva o fluxo, substituir o reply de falha por mensagem de sucesso. Em `runTransferenciaRecaptacaoPosForm`, nunca concatenar prefixo de transferência com reply que parece faculty redirect.
- **Contexto**: Diego #24127679 — inscrição/transferência ok, mas a bolha juntava "Registramos sua transferência" + "não consegui concluir…".
- **Alternativas descartadas**: Confiar só no LLM para filtrar; manter redirect quando `cap.ok`.
- **Impacto**: Lead vê só confirmação + próximo passo (link/contrato).

### 2026-07-16 - Bloquear reprocessamento em `aguardando_distribuicao_form`
- **Decisão**: Com status `aguardando_distribuicao_form` (já pedimos o curso), não reabrir pós-form por `kommoFormDone` nem `schedulerTick` sem mensagem do lead que pareça nome de curso. Claim retorna `awaiting_curso_from_lead`.
- **Contexto**: Thiago #24121875 — após mensagem pedindo curso (12:37), o pipeline reprocessou às 12:38 e mandou de novo o redirect da faculdade.
- **Alternativas descartadas**: Meter o status em `MATRICULA_POS_FORM_IN_PROGRESS` cegamente (bloquearia avanço legítimo quando o lead informar o curso).
- **Impacto**: Para o loop redirect; lead responde o curso e o fluxo pode seguir. **Requer deploy** do código novo em produção.

---

### 2026-06-18 - Saúde do agente: grade PDF, memória e dedupe

- **Decisão**
  - Corrigir pipeline de grade (nível grad/pós, auto-send restrito, dedupe PDF).
  - Persistir histórico (`id_lead` + fallback PGRST204).
  - Dedupe outbound não bloqueia turno novo do lead (`freshUserTurn`).
  - Injetar `sum_Curso` do card Kommo no contexto do LLM.
  - Migrar ingestão para `KOMMO_INBOUND_POLL_MODE=dispatcher` em produção.
- **Contexto**
  - Grades erradas (MBA vs grad), múltiplos PDFs/dia, histórico vazio, inbound perdido no modo `notes`.
- **Alternativas descartadas**
  - Desativar totalmente `GRADE_PDF_AUTO` (mantido restrito com flag `GRADE_PDF_AUTO_ENABLED`).
- **Impacto**
  - Menos spam de PDF; correção "não é pós" respeitada; retentativas legítimas após msg do lead.
- **Deploy (ordem)**
  1. SQL [`scripts/sql/chat_messages_id_lead.sql`](scripts/sql/chat_messages_id_lead.sql) no Supabase
  2. Deploy código (Fase 1–3)
  3. EasyPanel: `KOMMO_INBOUND_POLL_MODE=dispatcher`
  4. Monitorar 48h: `node --env-file=.env scripts/agent-health-report.mjs`
- **Validação pré-deploy**
  - `node scripts/validate-grade-nivel.mjs`
  - `node scripts/validate-agent-health-cases.mjs`

---

- **Decisão**
  - Reescrever os 4 prompts (em `agent_prompts`) para que já OBEDEÇAM às regras de
    prioridade máxima ANTES de elas serem aplicadas, eliminando o "trabalho dobrado"
    do agente (ler instrução obsoleta no prompt e depois ter que sobrepô-la pela regra).
- **Contexto / causa raiz**
  - `agentRunner.js` (linha ~954) monta `buildSystemMessage(prompts)` concatenando os 4
    prompts num ÚNICO system message + regras no fim. É um agente só. Mas os prompts eram
    de um desenho multi-agente n8n, então traziam contradições que as regras corrigiam:
    saída em XML/JSON, enquadramento de sub-agente ("você fala só com o orquestrador",
    "você NÃO fornece valores/preços/contatos") e nomes de tool antigos (`agente_*`,
    `receptivo_*`, `inscricao`, `agente_localizacao`).
- **Implementação (cada prompt virou nova versão em agent_prompt_versions)**
  - orquestrador: identidade de atendente único (não "orquestra agentes"); tools reais
    `buscar_conhecimento/_informacoes/_pos/_precos/_perguntas`, `enviar_grade_pdf`,
    `distribuir_humano`; fluxo Form Sumar (sem ENEM/tipo_ingresso/localização).
  - agente preços: removidos os templates XML (`<graduacao>`/`<pos_graduacao>`/`<sem_resultado>`);
    `sem_resultado` virou DECISÃO INTERNA (não mensagem); resposta em linguagem natural;
    mantida a lógica forte de precisão de correspondência de curso.
  - receptivo informacoes: removido o bloqueio "não fornece valores/preços/contatos" — agora
    orienta usar `buscar_precos`/`buscar_conhecimento` p/ valores; mantida a separação
    graduação×pós (uma tool por resposta) que alinha com as regras 13/15.
  - agente preguntas: removido o formato JSON e o "fala só com o orquestrador"; resposta
    natural baseada em `buscar_perguntas`; fallback `distribuir_humano` (regra 4.c).
  - Marca: cláusula "EXCLUSIVAMENTE Faculdade Sumaré" em todos; saneador de runtime mantém
    fallback do APAGAR.txt sem marcas legadas.
- **Verificação automática (sobre loadPrompts efetivo)**: sem ENEM positivo, sem
  tipo_ingresso/vestibular, sem agente_localizacao, sem nomes de tool antigos, sem XML/JSON
  de saída, sem "fala só com orquestrador", sem "não fornece preços", sem EAD/EAD; presentes
  tools `buscar_*`, Semipresencial, Form Sumar e marca Sumaré. RESULTADO: todos alinhados.
- **Impacto**
  - Menos sinal conflitante para o LLM (as regras deixam de precisar "consertar" o prompt).
    Tudo versionado/reversível. Produção intocada (flag off). Comparação base×overlay confirmou
    que a produção atual ainda carrega essas contradições — o overlay local é estritamente
    mais consistente, sem regressão.

---

### 2026-06-16 - Prompts editáveis persistidos em DB (agent_prompts) com overlay gated por flag — IMPLEMENTADO (validado local, sem deploy)

- **Decisão**
  - Os prompts do agente (systemMessage de cada node do `APAGAR.txt`) passam a ser
    editáveis pelo painel e persistidos no Supabase principal em duas tabelas novas:
    `agent_prompts` (estado atual) e `agent_prompt_versions` (histórico imutável).
  - O `promptsLoader.loadPrompts()` aplica um **overlay**: base = `APAGAR.txt` saneado
    (marca Faculdade Sumaré) + sobreposição do corpo vindo do DB, por `prompt_id`.
  - Tudo atrás da flag `AGENT_DB_OVERRIDES_ENABLED`. Com a flag **off** (produção hoje),
    o agente se comporta exatamente como antes (lê só o `APAGAR.txt` saneado); a tabela
    pode existir e ser editada sem qualquer efeito em produção. Com a flag **on** (apenas
    `.env` local por enquanto), o agente usa o texto do DB.
- **Contexto**
  - O editor de "Prompts" do painel só gravava em `localStorage` (não afetava o agente
    nem persistia). A fonte real do system message era o `APAGAR.txt` + regras hardcoded /
    `agent_rules`. Objetivo: centralizar e tornar os prompts editáveis, persistentes e
    seguros, mantendo velocidade (cache em memória com TTL de 60s, mesmo padrão das regras).
- **Implementação**
  - `scripts/sql/agent_prompts.sql`: DDL das 2 tabelas. Criadas via Management API (PAT).
  - `server/feedbackIA/promptsStore.js`: list/get/seed/apply/versions/rollback (PostgREST,
    mesmo shape do `rulesStore.js`; upsert por `prompt_id` com merge-duplicates).
  - `server/ai/promptsLoader.js`: `isAgentDbOverridesEnabled`, cache de overrides com TTL,
    `loadBasePrompts()` (cru por mtime) + `loadPrompts()` (overlay gated), regra 33 no catálogo.
  - `server.js`: endpoints `GET /api/feedback-ia/prompts`, `GET .../:id/versions`,
    `POST .../:id/apply`, `POST .../:id/rollback`; refresh de cache no apply/rollback e boot.
  - `src/App.jsx` + `src/components/PromptViewer.jsx`: painel passa a ler/gravar no servidor
    (fallback localStorage se o endpoint não responder) + banner de status de persistência.
  - `scripts/ensureAgentPrompts.mjs`: cria tabela (Management API/pg) e semeia base saneada.
  - `scripts/validate-prompt-cycle.mjs`: validação E2E (editar→persistir→`loadPrompts`→rollback).
- **Alternativas descartadas**
  - Só cache/localStorage: perde dados e não persiste (rejeitado pelo requisito de segurança).
  - Escrever já em `agent_rules` (compartilhada com produção, regras 1-30): adiado para o
    rollout para não afetar produção durante a validação local. Editor livre de regras e
    `syncMissingRules` ficaram para a fase de rollout.
- **Impacto**
  - Validado local: editar prompt no painel → grava em `agent_prompts`/`_versions` → o agente
    (`loadPrompts`) já usa o texto novo; rollback restaura versão anterior. Produção intacta
    (flag off). Próximo passo (após avaliação): ligar a flag em produção para ativar o overlay.

---

### 2026-06-15 - Fix do resumo de matrícula na transferência (curso destino) — IMPLEMENTADO

- **Decisão**
  - No ingresso por transferência, o resumo de matrícula ("Você irá ingressar no
    curso de X…") passa a usar SEMPRE o curso **destino** persistido em
    `transferencia_curso_destino`, e não a heurística da conversa.
- **Contexto / causa raiz** (achado no teste do lead 23841399)
  - O lead cita DOIS cursos na conversa: o de origem (o que cursou) e o destino
    (o que quer na Sumaré). O resumo determinístico (`resolveCursoNomeForResumo`
    → `detectCursoConfirmadoPeloLead`/`extractDiscussedCourseFromHistory`)
    pegava o curso de ORIGEM (ex.: "Análise e Desenvolvimento de Sistemas",
    5 sem) em vez do destino ("Sistemas de Informação", 8 sem).
  - O polo chega em turno separado do `registrar_transferencia`, então o handler
    determinístico `tryHandlePoloPreFormFlow` (`inscricaoPoloFlow.js`) — que é o
    que realmente roda (sem tool) — não tinha o curso no contexto e não passava
    `cursoHint` ao gate. (`runRegistrarPoloInscricao` na tool path tinha o mesmo
    gap; corrigido junto.)
- **Implementação**
  - `inscricaoPoloFlow.js`: `resolveTransferenciaCursoHint()` resolve o nome
    humano do código destino (via `resolveTransferenciaCursoCodigo`/cursosv2) e
    passa como `cursoHint` ao `gateMatriculaConfirmacaoBeforeForm`.
  - `inscricaoActionTools.js` (`runRegistrarPoloInscricao`): mesmo cursoHint.
  - Sem transferência, `cursoHint` fica `undefined` → fluxo vestibular normal
    segue na heurística da conversa (1 curso só, sem ambiguidade).
- **Impacto**
  - Resumo mostra o curso/duração corretos do destino. `gerar` no pós-formulário
    já usava `transferencia_curso_destino` (curso=SISINF_EAD,
    tipoIngresso=Transferencia_Ext), então só o texto lead-facing estava errado.
  - Validado end-to-end no lead 23841399: intenção → 3 campos → polo → resumo
    correto → autorização → Formulario_Sum; e `gerar` Transferencia_Ext
    (ADS_EAD→SISINF_EAD, série 2) retorna candidato + link de pagamento.

---

### 2026-06-15 - Fix do loop escalar↔reativar na falha de envio (token Meta) — IMPLEMENTADO

- **Decisão** (aprovada pela operação)
  - Quando a escalação por falha de envio para o lead em "Aguardando resposta"
    (13756724/106377088), a reativação por inbound (`leadReactivation.js`) passa a
    **ignorar** essa sessão enquanto o buffer tiver o MESMO conteúdo não respondido.
    Mensagem NOVA do cliente (hash do buffer muda) libera a reativação normalmente.
- **Contexto / causa raiz**
  - Diagnóstico no lead 23952513 (RIVALDO): a cada ~7 min o lead ciclava
    `erro de envio → "Encaminhamento automático após 2 tentativas" → Aguardando
    resposta → volta p/ Atendimento → tenta de novo`. A regra das 2 tentativas
    (`flushRetryBackoff` + `escalateSendFailureToHuman`, 2026-06-11) estava sendo
    **desfeita**: a escalação move o lead p/ 106377088 mas a mensagem não enviada
    fica no buffer; `leadReactivation` lista 106377088 como fonte e, vendo buffer
    pendente, re-puxa o lead p/ Atendimento → loop, enquanto o envio segue
    falhando (token Meta `code 190 / OAuthException` expirado em produção).
  - Falha de envio raiz (infra, fora deste código): `WHATSAPP_ACCESS_TOKEN` da
    Meta expirado no easypanel — precisa renovar; senão NENHUM lead recebe.
- **Implementação**
  - `flushRetryBackoff.js`: marca `parkedForHuman` (Map sessão→hash do buffer) +
    `markSessionParkedForHuman` / `isSessionParkedForHuman` (auto-limpa quando o
    hash muda) / `clearSessionParkedForHuman`.
  - `webhookEvolution.js`: `escalateSendFailureToHuman` recebe `items` e marca a
    sessão; envio confirmado limpa a marca (junto do `clearSendRetryBackoff`).
  - `leadReactivation.js`: a varredura pula sessões paradas com o mesmo conteúdo.
  - Estado em memória por processo (scheduler + webhook no mesmo Express) — igual
    ao backoff; restart só custa 1 tentativa extra.
- **Alternativas descartadas**
  - Remover 106377088 das fontes de reativação: quebraria o caso legítimo
    "lead respondeu enquanto aguardava → reativa".
  - Limpar o buffer na escalação: perderia a fala do lead que ficou sem resposta.
- **Impacto**
  - A escalação "gruda": após 2 falhas o lead fica parado p/ humano e não volta
    sozinho ao funil até o cliente mandar algo novo. Acaba o loop quente / queima
    de LLM. Loop ativo do RIVALDO já interrompido (buffer limpo + lead em 106377088).

---

### 2026-06-15 - Ingresso por transferência / aproveitamento de matérias — EM IMPLEMENTAÇÃO

- **Decisão** (aprovada pela operação)
  - Nova forma de ingresso: lead que cursou (ou cursa) outra faculdade e quer
    **transferência externa / aproveitamento de matérias**. Escopo aprovado: SÓ
    `Transferencia_Ext` (externa). 2ª graduação/licenciatura e série de quem já tem
    diploma ficam para depois.
  - **Arquitetura:** reaproveitar 100% o pipeline do vestibular
    (`gerar → status → aceite → link de contrato/pagamento`). O agente conduz
    server-side e envia ao lead **só o link** — nunca o formulário do site (mantém captação).
  - **Coleta:** dados pessoais via `Formulario_Sum` (igual vestibular) + 3 campos extras
    coletados na conversa: **curso de origem**, **último semestre concluído**, **curso desejado**.
  - Grade curricular: da **nossa base** (não expõe a tela de disciplinas do site).
- **Descoberta validada na API Captação** (testes com CPF de teste autorizado)
  - A transferência usa o MESMO `GET /api-ingresso/candidato/gerar`. Espelha
    `dadosExternos.js` do site. Só mudam 3 parâmetros:
    - `tipoIngresso = "Transferencia_Ext"`  (⚠️ `"Transferência Externa"` com acento/espaço
      estoura a coluna no SQL Server → HTTP 500 "String or binary data would be truncated")
    - `cursoAntigo = <código do curso de origem>` (ex.: `BD_EAD`)
    - `dispositivo = <último semestre concluído>` (o frontend reusa o campo `dispositivo`
      para carregar a série; ex.: `4`)
    - `curso = <código do curso desejado>` (destino)
  - Resultado: `pagina "Contrato"`, candidato gerado, valor da mensalidade; depois
    `status contrato → aceite → meioPagamento`. Idêntico ao vestibular daí em diante.
  - Endpoints auxiliares de leitura (GET): `cursosv2` (lista de cursos EAD),
    `/api-triagem/triagem/candidato/obtemUnidades?curso=&turno=EAD` (polos),
    `/api-triagem/triagem/obterDadosPessoais?cpf=` (pré-preenche por CPF).
- **Implementação**
  - `sumareCaptacaoClient.js` (`buildGerarCandidatoQuery`): detecta transferência pelo
    snapshot e injeta `tipoIngresso/cursoAntigo/dispositivo`.
  - `matriculaCaptacaoPipeline.js`: carrega colunas de transferência do `dados_cliente_sum`
    para o snapshot.
  - Tool `registrar_transferencia` (`toolDefinitions.js` + `inscricaoActionTools.js` +
    dispatch em `toolExecutorsServer.js`): grava os 3 campos e segue para o fluxo de polo+form.
  - Colunas novas em `dados_cliente_sum`: `transferencia_curso_origem`,
    `transferencia_semestre`, `transferencia_curso_destino` (SQL + ensure script).
  - Regra no `promptsLoader.js`: gatilhos (aproveitar/dispensar matéria, já cursou e quer
    aproveitar, voltar a cursar) + textos explicativos do processo.
- **Alternativas descartadas**
  - Mandar o link do formulário de transferência do site ao lead — quebra a captação
    (regra de 2026-06-15 sobre links do site) e o padrão server-side já existente.
- **Impacto**
  - Agente passa a matricular por transferência externa sem sair do canal; lead recebe
    só o link de pagamento, como nos demais cenários.

---

### 2026-06-15 - Links do site oficial: só consulta interna, nunca ao lead — IMPLEMENTADO

- **Decisão** (solicitada pela operação)
  - URLs do site Sumaré (páginas de curso, catálogo, grade no site) servem apenas para
    conferência no RAG/CONTEXT. **Proibido** enviar ao lead — matrícula direta no site
    escapa da captação da empresa.
  - Matrícula e informações comerciais devem fluir por este canal (formulário, API Captação).
  - Exceções permitidas ao lead: atendimento (`/atendimento/`), ouvidoria, link de
    contrato/pagamento do fluxo de inscrição.
- **Implementação**
  - Regra 30 em `promptsLoader.js`; marcadores RAG em `knowledgeRowFormat.js` sem URL
    exposta como "link oficial"; hints em `agentRunner.js` e `toolDefinitions.js`.
  - `libShared/courseLinkOutboundGuard.js` + `replyGuard.js` (antes do envio LLM) +
    `whatsappSender.js` (rede de segurança em todo outbound).
- **Impacto**
  - Agente informa curso por texto/PDF/inscrição; não direciona para o site para matricular.

---

### 2026-06-15 - Reativação por inbound: responder leads fora do funil que mandam mensagem — IMPLEMENTADO

- **Decisão** (aprovada pela operação)
  - O scheduler só monitora `pipeline 13756724 (Agente-Sumaré) / status 106140284 (Atendimento)`.
    Quem manda mensagem estando em outra etapa/pipeline vira "órfão" no buffer e
    nunca é respondido. Diagnóstico em produção (`GET /api/scheduler/funnel`):
    scheduler saudável (`running/enabled/kommoOk=true`, 0 pendentes no funil),
    mas **79 sessões órfãs** — 45 em `SUMARÉ-COMERCIAL (13080160) / em atendimento
    (100859840)`, 23 em `13756724/143 (Venda perdida)`, e o restante em academico/ativações.
  - **Regra de reativação (mover p/ `13756724/106140284` ao chegar inbound):**
    1. `13756724 / 106377088` (Aguardando resposta do próprio funil do agente) —
       cliente respondeu enquanto esperava → reativa.
    2. `13080160 (SUMARÉ-COMERCIAL)` nos status ATIVOS
       (`100859828 incoming, 100859832 contato inicial, 100859836 sem resposta,
       106076568 agente IA, 100859840 em atendimento, 100860052 aguardando resposta,
       100871908 robô`) → reativa.
  - **Nunca reativa:** status terminais `142 (ganha)` / `143 (perdida)`; etapas de
    inscrição/pagamento em andamento na comercial (`100860056, 100860060, 100860064`);
    pipelines fora do escopo aprovado (acadêmico `13123892`, ativações `13080228`,
    cobrança, anhanguera). Lead já em `106140284` é ignorado (já está sendo atendido).
  - **Mecanismo:** varredura no `agentScheduler` (`tryReactivateOrphanLeads`),
    *throttled* (intervalo `LEAD_REACTIVATION_SWEEP_SEC`, default 45s) e com teto por
    varredura (`LEAD_REACTIVATION_CAP`, default 15). Lista sessões com buffer pendente
    (`listSessionsWithPendingMessages`), resolve o lead por telefone, aplica a regra e
    move p/ o funil; o tick seguinte responde. Idade máxima da mensagem p/ reativar:
    `LEAD_REACTIVATION_MAX_AGE_HOURS` (default 24h) — evita responder buffer obsoleto.
  - Ligado por env `LEAD_REACTIVATION_ENABLED` (default `true`).
- **Contexto**
  - O cliente que responde fora do funil (ex.: enquanto está "Aguardando resposta",
    ou que cai na pipeline comercial) ficava mudo. A operação decidiu que a IA deve
    atender também a pipeline SUMARÉ-COMERCIAL e reativar respostas em "Aguardando resposta".
- **Alternativas descartadas**
  - Reativar no webhook de inbound (Evolution/Meta): resposta imediata, mas adiciona
    um `findLeadByPhone` no caminho quente de cada mensagem e espalha a regra por 2
    handlers; a varredura centraliza no scheduler com custo controlado.
  - Ligar `KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH`: não resolve — o `funnel_gate` bloqueia
    leads fora do funil; seria preciso mover o lead de qualquer forma.
  - Ampliar `KOMMO_AGENT_STATUS_IDS` p/ incluir comercial: o scheduler rodaria
    proactiveGreet/inatividade pesado em centenas de leads/tick e mudaria a semântica
    das etapas; mover só quem manda mensagem é mais cirúrgico.
- **Impacto**
  - Novo módulo `server/leadReactivation.js` + hook no `server/agentScheduler.js`.
    Desligável por env. Move leads da pipeline comercial p/ a do agente conforme
    aprovado — pode alterar a visão da equipe comercial no Kommo (decisão da operação).

---

### 2026-06-15 - Saudação proativa: agente inicia a conversa quando o lead entra no Kommo — IMPLEMENTADO

- **Decisão** (aprovada pela operação)
  - Abordagem **híbrida**: o agente envia a 1ª mensagem (saudação) ao lead
    assim que ele é criado no Kommo, sem esperar o lead falar primeiro.
    1. **Caminho instantâneo (n8n):** endpoint `POST /api/leads/proactive-greet`
       — o workflow `criacao_leads_sumaread_kommo_v3` pode chamar logo após
       criar o lead, enviando `{ id_lead, telefone/celular, nome, nivel/tipo }`.
       Saudação sai em segundos.
    2. **Rede de segurança (scheduler):** no ramo "buffer vazio" do
       `agentScheduler`, antes do reengajamento por inatividade, roda
       `tryProactiveGreet` para qualquer lead da fila ainda sem atendimento —
       cobre leads que não passaram pelo endpoint (inclusive os antigos).
  - **Saudação personalizada:** primeiro nome do lead + nível de interesse
    (Graduação/Pós), derivados de `lead.name` e do campo `sum_Nivel` (1475427).
  - **Escopo:** todos os leads da fila sem atendimento prévio (inclusive
    backlog antigo), não só os recém-criados.
  - **Idempotência (nunca saudar 2x):** coluna persistente
    `proactive_greet_at` em `dados_cliente_sum` (claim-exclusivo via PATCH
    `?...&proactive_greet_at=is.null`, padrão do reengajamento) + dedupe em
    memória + `hasPriorAttendance` (buffer, memória n8n, chat_messages com
    resposta do bot, nota do agente no Kommo) + dedupe de outbound do
    `sendMessageWithNote`. Lead em `atendimento_ia='pause'` ou em fluxo de
    inscrição ativo é pulado.
  - Ligado por env `PROACTIVE_GREET_ENABLED` (default `false`).
- **Contexto**
  - Hoje o agente é reativo: o scheduler só responde quando há mensagem no
    buffer; lead novo fica em silêncio até falar primeiro. A operação quer que
    o agente puxe a conversa assim que o lead chega pelo formulário do site.
- **Alternativas descartadas**
  - Só scheduler (sem endpoint): simples, mas adiciona ~10s de latência e faz
    varredura pesada de histórico por tick; o endpoint dá saudação imediata.
  - Só endpoint n8n: instantâneo, mas não cobre leads que não passam pelo
    workflow nem o backlog; por isso o scheduler entra como rede de segurança.
  - Reaproveitar só o script manual `proactive-greet-queue.mjs`: exige rodar à
    mão, não atende "reconhecer automaticamente".
- **Impacto**
  - Novos módulos: `server/proactiveGreet.js` (core), endpoint em `server.js`,
    hook no `agentScheduler.js`, coluna `proactive_greet_at` no SQL de
    `dados_cliente_sum`. Comportamento desligável por env; sem efeito enquanto
    `PROACTIVE_GREET_ENABLED` não for `true`.

---

### 2026-06-11 - Regra de escalação por falha de envio (retry 2min → nota + humano) — IMPLEMENTADO

- **Decisão** (regra definida pela operação)
  - 1ª falha ao responder o lead (envio não confirmado OU agente falhou) →
    nova tentativa após **2 minutos** (`AGENT_SEND_RETRY_BASE_SEC=120` default).
  - **2ª falha consecutiva** do mesmo conteúdo — qualquer erro (Meta/token,
    número licenciado, OpenAI/pagamento etc.) → `escalateSendFailureToHuman`:
    1. nota no lead com o erro resumido (≤220 chars), prefixada com
       "Encaminhamento automático:" (o poll reconhece como nota de sistema e
       não re-injeta como fala do lead);
    2. lead movido para **pipeline 13756724 / etapa 106377088 (Aguardando
       resposta)** — fora do funil da IA, para um humano assumir;
    3. backoff da sessão zerado (evita re-escalação se o lead voltar à fila).
  - Limiar configurável: `AGENT_SEND_FAIL_ESCALATE_AFTER` (default 2). Sem
    leadId resolvível, mantém só o backoff exponencial (nunca loop quente).
  - Mensagens do lead permanecem no buffer — na reentrada ao funil o
    atendimento retoma de onde parou.
- **Contexto**
  - Sequela do incidente do token Meta (10-11/06): com falha persistente do
    canal, o backoff sozinho reduz custo mas deixa o lead sem atendimento
    indefinidamente. A operação definiu que após 2 tentativas o lead deve ir
    para humano com a causa registrada no timeline.
- **Alternativas descartadas**
  - Escalar na 1ª falha: erro transitório (race/timeout) viraria handover
    desnecessário; 1 retry em 2min filtra os transitórios.
  - Pausar a IA via `atendimento_ia='pause'` em vez de mover: invisível para a
    equipe no Kommo; mover de etapa coloca o caso na fila visível do humano.
- **Impacto**
  - Falha persistente de credencial/canal: cada lead gera no máx. 2 execuções
    LLM e aparece em "Aguardando resposta" com nota explicando o erro — em vez
    de loop infinito e silêncio.

---

### 2026-06-11 - Backoff de retry de envio + echo da nota de handover — IMPLEMENTADO

- **Decisão**
  - Novo `server/flushRetryBackoff.js`: quando a IA gera resposta mas o ENVIO do
    WhatsApp falha (ou o agente erra), o repush continua preservando as mensagens,
    porém o próximo flush do MESMO conteúdo espera backoff exponencial
    (`AGENT_SEND_RETRY_BASE_SEC=60` dobrando até `AGENT_SEND_RETRY_MAX_SEC=1800`).
    Inbound novo muda o hash do buffer e passa direto; envio confirmado zera.
    Gate em `flushSessionInner` (antes do drain, skip em testMode); registro nos
    dois pontos de repush; estado em memória por processo.
  - `isKommoSystemOrIntegrationNote` agora reconhece a nota de auditoria do
    handover ("Encaminhamento automático: lead pediu atendimento humano…") —
    o poll de notas a re-injetava como fala do lead e o handover repetia.
  - Teste `scripts/test-flush-retry-backoff.mjs` (`npm run test:flush-retry-backoff`).
- **Contexto**
  - Incidente 10-11/06: `WHATSAPP_ACCESS_TOKEN` (Meta Cloud API) expirou às 14:30
    de 10/06 → todo envio falhava com 190 OAuthException → o flush re-enfileirava
    e o próximo tick (~10s) regenerava a resposta no LLM. Resultado: 212 telefones
    em loop, 1000+ execuções LLM queimadas sem nenhuma mensagem entregue, clientes
    sem resposta ("vcs nunca respondem"). A correção primária é renovar o token
    (System User permanente); o backoff impede que uma queda futura do canal de
    envio vire queima contínua de OpenAI.
- **Alternativas descartadas**
  - Cap duro de N tentativas com descarte do buffer: arrisca perder mensagem real
    do cliente; backoff com teto preserva o turno e reduz o custo a ~2 exec/h por lead.
  - Persistir o estado de backoff no Redis: desnecessário — restart só custa 1
    tentativa extra; objetivo é parar a queima contínua, não exatidão.
- **Impacto**
  - Canal de envio caído deixa de consumir LLM a cada tick por lead; logs ganham
    `held — send_retry_backoff (falhas=N, retry em Xs)`. Handover não repete mais
    por eco da própria nota.

---

### 2026-06-11 - Fix do "9º dígito": scheduler lê a variante de sessão que tem mensagens — IMPLEMENTADO

- **Decisão**
  - Novo helper `whatsAppSessionVariants(phone)` em `server/phoneWhatsApp.js`: para
    número BR (`55`+DDD) devolve a sessão primária **e** a variante com/sem o `9`
    logo após o DDD (ex.: `551120464401@…` ↔ `5511920464401@…`), deduplicadas.
  - No `server/agentScheduler.js`, novo `resolveEffectiveSessionId(env, phone)` escolhe,
    entre as variantes, a sessão que **tem mensagens no buffer**; o tick passa a usar
    essa sessão efetiva em `getMessages`, `getLastTouchedAt`, `clearBufferIfStaleRepush`
    e no `flushSession`. Assim a IA lê de onde a mensagem realmente está e **responde no
    JID que o aluno usou** (em empate, fica na primária). A leitura extra é só no buffer
    (Redis/Supabase) — não consome cota do Kommo.
  - Teste `scripts/test-phone-whatsapp-variants.mjs` (`npm run test:phone-variants`)
    cobre ida/volta do 9º dígito. Corrigido `test-kommo-agent-funnel-gate.mjs` que ainda
    esperava 1 status (o gate atende Atendimento + inscrição = 2).
- **Contexto**
  - Auditoria de "agente não atende alguns leads" (11/06): scheduler/Kommo saudáveis e
    sem bloqueio (`totalPaused: 0`). A causa foi o lead 23856049, no funil correto
    (Atendimento), com telefone Kommo `+5511920464401` (com 9) mas mensagem do WhatsApp
    em `551120464401` (sem 9) — buffers em chaves diferentes, scheduler lia vazio e nunca
    respondia ("PRECISO TRANCAR MINHA MATRICULA" parado ~49min). A normalização
    `digitsToWhatsAppLocalPart` não reconciliava o 9º dígito.
- **Alternativas descartadas**
  - Canonizar a chave do buffer numa única forma no write (Evolution + Kommo mirror):
    mais simples, mas **não resolve o envio** — `flushSession` mandaria para o JID canônico
    (ex.: com 9) que pode não ser o aparelho real (sem 9), arriscando não entregar.
- **Impacto**
  - Leads cujo Kommo guarda o número numa forma e o WhatsApp entrega na outra passam a ser
    atendidos no próximo tick, com resposta no JID correto. +1 leitura de buffer por lead BR
    (sem custo Kommo). Sem mudança de comportamento quando não há variante com mensagens.

---

### 2026-06-08 - Rate limiter global da API Kommo (teto de 7 req/s) — IMPLEMENTADO

- **Decisão**
  - Novo módulo `server/kommoRateLimiter.js` é o ÚNICO ponto que garante que nunca
    passamos do limite de **7 req/s** do Kommo (que bloqueou a conta):
    - `runWithKommoRateLimit(fn)`: serializa TODA chamada ao Kommo numa fila única
      (process-wide) e espaça os inícios por `1000 / KOMMO_MAX_RPS` ms.
    - `KOMMO_MAX_RPS` default **5**, com **HARD CAP de 6** — mesmo configurando acima,
      jamais chega aos 7/s.
    - `kommoRawFetch(url, init)`: substituto de `fetch` para o host Kommo — passa pelo
      limiter, adiciona timeout (`KOMMO_API_TIMEOUT_MS`, default 20s) e dispara
      **backoff global em 429/403** respeitando `Retry-After` (pausa a fila inteira
      em vez de continuar martelando — evita reentrar no bloqueio).
  - TODOS os pontos que falavam com o Kommo foram roteados pelo limiter: `kommoFetch`
    central (`kommoClient.js`) + wrappers locais (`inscricaoTool.js`,
    `distribuirHumanoTool.js`, `salesbot/csvSearch.js`) + fetches diretos
    (`kommoSalesbot.js`, `sumareLeadFields.js` ×3, `inscricaoKommoFields.js`,
    `metaFlowFormSync.js`, `kommoAmojoHistory.js`).
  - Cap de concorrência no scheduler: `mapWithConcurrency` substitui o `Promise.all`
    sobre todos os leads. Default `KOMMO_SCHEDULER_LEAD_CONCURRENCY=3`.
  - Observabilidade: `getKommoRateLimiterSnapshot()` exposto em `/api/agent/diagnose`
    (`scheduler.kommoRateLimiter`).
  - Teste `scripts/test-kommo-rate-limiter.mjs` prova que rajada de 40 chamadas tem
    pico ≤ 6 req/s e que o backoff é respeitado. Adicionado ao gate de pré-deploy.
- **Contexto**
  - O suporte do Kommo informou (08/06) que a conta foi bloqueada em 06/03 por exceder
    7 req/s, e que desbloqueia após ajustarmos o fluxo. Auditoria mostrou que `kommoFetch`
    não tinha NENHUM controle de taxa (sem fila, sem limite de concorrência, sem backoff),
    e o scheduler disparava todos os leads em paralelo (`Promise.all`) a cada 10s, com o
    poll fazendo várias chamadas por lead — rajadas muito acima de 7/s.
- **Alternativas descartadas**
  - Limitar só no scheduler: não cobriria webhook/tools/salesbot que também chamam Kommo.
  - Biblioteca externa (p-limit/bottleneck): dependência nova desnecessária para um
    token-bucket simples; preferimos serialização própria sem dependências.
- **Impacto**
  - Throughput máximo ao Kommo agora é ~5 req/s (latência-bound, sempre < 7). Em picos,
    as chamadas enfileiram e drenam suavemente. Configurável por env, com teto rígido.
  - Após o deploy, avisar o suporte do Kommo que o fluxo foi ajustado para < 7 req/s
    para que desbloqueiem a conta.

---

### 2026-06-05 - Agente sem atendimento em produção: causa raiz = 403 do Kommo no IP do servidor — DIAGNÓSTICO

- **Decisão**
  - Tratar a correção pela via real: **liberar o IP de saída do servidor (`168.231.99.126`) no Kommo**
    (allowlist de IP nas configurações da conta OU ticket no suporte Kommo). Sem isso o agente
    não funciona — toda chamada Kommo (listar funil, `findLeadByPhone`, gravar nota, mover etapa)
    retorna 403.
  - NÃO aplicar workaround "fail-open" na `funnel_gate` nem ligar `KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH`
    (opção descartada pelo dono — ver abaixo).
- **Contexto**
  - Sintoma: 4 leads na fila do agente (pipeline 13756724 / status 106140284 — Cintia #23829157,
    juliana #23825835, CLÓVIS #23828353, AJ #23824633) com mensagens **de hoje** paradas no buffer
    há ~3h, sem nenhuma resposta e sem linha em `dados_cliente_sum`.
  - `GET /api/scheduler/funnel` (produção) retornou `kommoOk:false` com **HTTP 403 Forbidden
    (página HTML/nginx — WAF, não JSON da API)** na URL
    `…/api/v4/leads?filter[statuses][0][pipeline_id]=13756724&…`. É bloqueio de **IP/WAF**, não 401 de token.
  - Cadeia da falha: inbound chega pelo webhook Meta → buffer OK; scheduler roda (`running:true`,
    sem whitelist, funil correto); mas `listLeadsInAgentQueue` toma 403 → 0 leads no funil → sem flush.
    `orphanFlush` está `false` e, mesmo ligado, a `funnel_gate` também depende do Kommo (403).
  - Descartados na investigação: IA kill-switch (`app_settings.ai_enabled=true`), whitelist
    `KOMMO_AGENT_TEST_LEAD_IDS` (vazia), `ia_paused` (`decideHoldOnIaPause(null)` = sem hold),
    `clearBufferIfStaleRepush` (nunca flushou → sem hash), scheduler parado (uptime ~45h, `running:true`).
  - Diagnóstico só foi possível do IP local (que NÃO está bloqueado) + endpoints públicos do app
    (`/api/health`, `/api/agent/diagnose`, `/api/scheduler/funnel`).
- **Alternativas descartadas**
  - **Workaround fail-open** (funnel_gate tolerante a 403 + orphan flush + deploy): responderia os
    leads do buffer via WhatsApp sem verificar o funil, mas notas e movimentação de etapa no Kommo
    continuariam falhando, e a IA passaria a responder qualquer sessão com buffer sem checagem de
    funil. Risco alto; descartado pelo dono em favor da correção de infra.
  - **Proxy de saída com IP liberado**: viável, mas mais complexo que liberar o IP atual; fica como
    plano B se o Kommo não permitir allowlist do IP do VPS.
- **Impacto**
  - Enquanto o IP não for liberado, o agente permanece sem atender (mensagens acumulam no buffer e
    podem expirar por TTL). Assim que o IP for liberado, **não precisa redeploy**: o próximo tick do
    scheduler (10s) drena o backlog que ainda estiver no buffer. Validar com `/api/scheduler/funnel`
    (`kommoOk:true`) após a liberação.

---

### 2026-06-03 - Guarda contra reenvio do Formulario_Sum após formulário preenchido — IMPLEMENTADO

- **Decisão**
  - Novo helper `inscricaoFormAlreadyFilled(row)` em `libShared/inscricaoFormHeuristics.js`:
    retorna `true` quando o Form Sumar já foi preenchido — status pós-form
    (`form_sumar_concluido`, `aguardando_distribuicao_form`, `aguardando_escolha_polo`,
    `aguardando_aceite_contrato`, `comprovante_pagamento_recebido`, `distribuir_consultor`,
    `desistencia_concluida`) ou `inscricao_form_recebido_at` setado. Estados PRÉ-formulário
    (null, `aguardando_form_sumar`, `aguardando_escolha_polo_pre_form`,
    `aguardando_autorizacao_matricula`, `aguardando_confirm_*`) ficam de fora de propósito.
  - Guard aplicado em 3 pontos que disparam o salesbot `Formulario_Sum`:
    `tryHandleInscricaoFormStart` e `tryEnsureInscricaoFormSent` (`server/inscricaoFormFlow.js`)
    e `tryHandlePoloPreFormFlow` (`server/inscricaoPoloFlow.js`, que usava `forceResend:true`).
    Se o formulário já foi preenchido → `return null` (não reativa o template). Exceção:
    status `aguardando_confirm_nova_inscricao` (lead pedindo nova inscrição em outro curso).
- **Contexto**
  - Lead #23875607 já tinha o formulário preenchido (status `aguardando_aceite_contrato`,
    `inscricao_form_recebido_at` às 11:51, contrato já enviado), voltou a conversar, o agente
    tratou como conversa nova e re-disparou o `Salesbot Formulario_Sum`. A partir daí o salesbot
    do Kommo (bot 49815) repetia "Preencha as informações do formulário" no timer interno dele.
  - O guard anterior só bloqueava `form_sumar_concluido`/`aguardando_form_sumar`; status
    intermediários pós-form (ex.: `aguardando_aceite_contrato`) escapavam e re-disparavam.
- **Alternativas descartadas**
  - Guard dentro de `deliverInscricaoForm`: é o sender de baixo nível e deve honrar `force`
    (re-testes, tool/API explícita); colocar a regra lá quebraria reenvio legítimo.
  - Reusar `matriculaPosFormAlreadyProcessed`: inclui estados PRÉ-form no conjunto
    "em progresso" (ex.: `aguardando_escolha_polo_pre_form`), o que bloquearia a escolha de
    polo legítima antes do formulário.
- **Impacto**
  - Agente nunca reativa o formulário depois de preenchido — quebra o loop de "preencha o
    formulário". 7 testes novos em `scripts/test-inscricao-flow.mjs` (10.11x). Sem regressão
    (143 passaram; as 3 falhas restantes são pré-existentes e não relacionadas).
  - O loop interno do salesbot do Kommo (uma vez iniciado) é config do lado Kommo — revisar o
    salesbot 49815 para sair/parar ao detectar o formulário recebido.

### 2026-06-03 - Confirmação ANTES da matrícula (resumo + autorização) — IMPLEMENTADO

- **Decisão / desfecho**
  - Inserido um passo de CONFIRMAÇÃO antes do envio do formulário: quando o lead confirma que
    quer se matricular, o agente envia um resumo (curso, duração, mensalidade, taxa de
    matrícula = 1 mensalidade) e pergunta "Você autoriza a conclusão da matrícula?". Só após o
    "autorizo" o fluxo de envio do formulário existente roda. Recusa/dúvida → atendimento
    normal; consultor só se necessário.
  - **Gate determinístico** novo (`server/inscricaoMatriculaConfirmFlow.js`,
    `tryHandleMatriculaResumoConfirmacao`) chamado cedo no `agentRunner` (após carregar
    histórico, antes dos flows de polo/desistência/card e do envio determinístico do form).
    Usa um novo status `inscricao_form_status = 'aguardando_autorizacao_matricula'`:
    - status null + lead confirma matrícula + curso/preço resolvidos → grava status e envia o
      resumo (short-circuit; NÃO envia formulário).
    - status aguardando_autorizacao + lead autoriza → reseta status p/ null e devolve null
      (o fluxo de envio existente, INTACTO, dispara o formulário).
    - status aguardando_autorizacao + dúvida/recusa → devolve null (LLM faz atendimento normal).
    - sem curso/preço resolvido → devolve null (degrada para o fluxo atual, sem bloquear).
  - Valores do resumo vêm das tabelas `grad_preco`/`pos_preco` (mensalidade = "preco com
    desconto"; duração só existe em grad_preco). Match de curso por sobreposição de tokens
    (limiar 0.5), curso vindo de `detectCursoConfirmadoPeloLead`/histórico/`sum_Curso`.
  - **Helpers** em `libShared/inscricaoFormHeuristics.js`: novo status
    `INSCRICAO_FORM_STATUS_AGUARDANDO_AUTORIZACAO`, `assistantAskedMatriculaAuthorization`, e
    `assistantInEnrollmentStep` estendido p/ reconhecer a pergunta de autorização (assim o
    "sim" após o resumo reaproveita o envio de formulário já existente, sem alterá-lo).
  - **Reforço por prompt**: nova regra 25 (hardcoded + AGENT_RULES_CATALOG + DB agent_rules,
    via `scripts/add-rule-confirmacao-matricula.mjs`) instrui o LLM a fazer o resumo antes de
    chamar enviar_form_sumar_inscricao — cobre os caminhos guiados pelo modelo. DB agora 1–25.
- **Contexto**
  - O envio do formulário tem vários pontos (atalho determinístico p/ "sim" curto, tool
    enviar_form_sumar_inscricao do LLM, ensure pós-LLM, scheduler). Para minimizar blast radius,
    o gate é um único handler com short-circuit + status; o caminho de envio existente NÃO foi
    modificado (só estendido o reconhecimento da pergunta de autorização).
- **Alternativas descartadas**
  - Resumo gerado pelo LLM como mecanismo principal: risco de o disparo automático
    (nfm_reply/scheduler) não passar pelo LLM. Mantido o gate determinístico + regra de reforço.
  - Confirmação DEPOIS do formulário (antes da captação): rejeitado pelo usuário — preferiu
    antes do formulário (menos disrupção do fluxo pós-form).
- **Impacto**
  - Duração da pós: a planilha oficial define TODA pós com 6 meses. Gravado `duracao: 6 Meses`
    em `pos_preco` (content + metadata, re-embedado) via `scripts/add-duracao-pos.mjs`; o lookup
    passou a ler `duracao` para grad e pós. Resumo da pós agora mostra "com duração de 6 meses".
  - Reversão: remover a chamada do gate no agentRunner + `DELETE agent_rules?id=eq.25`
    (+ versions) + apagar `server/inscricaoMatriculaConfirmFlow.js`. O status
    `aguardando_autorizacao_matricula` é aditivo (nenhum fluxo legado o consome).

---

### 2026-06-03 - Regra 24: desconto por pagamento antecipado — informar 1× junto com o valor — IMPLEMENTADO

- **Decisão / desfecho**
  - Nova regra de atendimento (id 24) governando QUANDO enviar o "Plano de Benefício para
    Pagamento Antecipado Facultativo" (70%/50%/20% conforme o dia do mês) já cadastrado em
    `grad_info`/`pos_info`.
  - Comportamento: enviar o benefício **junto com o valor do curso**, mas **apenas uma vez por
    conversa** (na primeira vez que citar preço); ou sempre que o candidato **perguntar
    diretamente** sobre o desconto (aí pode repetir). Nas demais menções a preço, não repetir.
  - Aplicado em 3 lugares para consistência: hardcoded (`server/ai/promptsLoader.js`, fallback),
    `AGENT_RULES_CATALOG` (id 24) e tabela `agent_rules` do DB (id 24, v1 + espelho em
    `agent_rule_versions`, source `seed`). O prompt ATIVO vem do DB — por isso o seed é
    obrigatório. Script idempotente/reversível: `scripts/add-rule-pagamento-antecipado.mjs`.
- **Contexto**
  - `composeOverrideFromDB` monta o prompt ativo = cabeçalho hardcoded + corpos das regras do DB
    (ordenados por id). Regra só vale se existir no DB.
- **Alternativas descartadas**
  - Embutir na regra 15 (preços): rejeitado — regra dedicada é mais fácil de avaliar/versionar
    e de rastrear pelo avaliador por rule_id.
  - Enforcement determinístico em código (contar envios no histórico): rejeitado por ora — o
    pedido é uma "regra de atendimento" (prompt); o agente usa o histórico (regra 5) para não repetir.
- **Impacto**
  - Durante a implementação detectou-se que a regra 23 (LGPD) estava em hardcoded + catálogo
    mas **nunca havia sido semeada no DB** → estava inativa no prompt real. Com aprovação do
    usuário, a LGPD (23) foi semeada no DB (`scripts/add-rule-lgpd.mjs`, v1, source `seed`).
    DB agora contíguo: ids 1–24.
  - Reversão: `DELETE agent_rules?id=eq.24` (+ `agent_rule_versions?rule_id=eq.24`) e remover o
    bloco "24." do hardcoded/catálogo. (LGPD/23 idem via `id=eq.23`.)

---

### 2026-06-03 - RAG preços por modalidade (EAD + Semipresencial) — IMPLEMENTADO

- **Decisão / desfecho**
  - Fonte de verdade: planilha oficial "cursos Sumaré.xlsx" (41 graduações, 34 pós).
    Cada curso tem **uma única modalidade** (EAD ou Semipresencial) — não é multi-modalidade
    por curso. Pós é tudo EAD.
  - `grad_preco` (41 linhas) atualizado: `modalidade: EAD|Semipresencial` + grau + duração +
    preços novos. 18 graduações migraram EAD→Semipresencial (Arquitetura, Biomedicina,
    Engenharias, Farmácia, Fisioterapia, Nutrição, Ed. Física Bach/Lic, Geografia, História,
    Letras, Matemática, Pedagogia, Saneamento, Serviço Social). Corrigido id=168 (nome_curso
    corrompido → "Sistemas de Informação").
  - `pos_preco` (34 linhas) atualizado: preços (vários 187/623 → 191/637) + `modalidade: EAD`.
  - `grad_info`: 18 linhas semipresenciais tiveram `modalidade` trocada para Semipresencial.
  - **Removidos 7 cursos de pós** fora da planilha (Ensino Lúdico, MBA Gestão de Projeto,
    MBA Negócios e Vendas, Ciência de Dados, MBA Controladoria, MBA Gestão de Negócios e
    Estratégia, MBA Logística Lean) em `pos_preco` e `pos_info`. Backup em
    `scripts/backup-pos-removidos-*.json`.
  - Tudo re-embeddado (text-embedding-3-small / 1536 dims).
  - Código: `normalizeModalidadeForSumare`/`normalizeModalidadeInText`
    (`libShared/knowledgeRowFormat.js`) NÃO forçam mais Presencial/Semi → EAD (só padronizam
    grafia para "Semipresencial"). Prompts EAD-only ajustados no hardcoded
    (`server/ai/promptsLoader.js`) E no DB (`agent_rules` regras 2, 6, 15, 18 → v2).
  - Script de migração: `scripts/apply-cursos-sumare.mjs` (mapa explícito por id, `--dry-run`).
    O legado `update-precos-sumare-rag.mjs` foi marcado DEPRECADO (exige `--force`) para não
    reverter a modalidade.

- **Contexto / evidências**
  - Site multi-modalidade (`/graduacao/{ead|semi|presencial}/{curso}`) mas preços via JS
    (não raspáveis) → usamos a planilha oficial.
  - `sumare_captacao_curso`: Presencial=0 (sem código de matrícula) → presencial fica de fora.
  - Validado: Farmácia volta Semipresencial R$227 (cheio 757); Administração EAD 107/357.

- **Alternativas descartadas**
  - Presencial agora: sem código de matrícula. 1 linha por curso+modalidade: desnecessário
    (cada curso tem 1 modalidade na planilha). Raspar preço do site: inviável (JS).

- **Impacto / pendência**
  - Mudanças de DADOS (tabelas RAG) e de REGRAS (agent_rules via cache TTL) já valem em
    produção. As mudanças de CÓDIGO (`knowledgeRowFormat.js` e header de `promptsLoader.js`)
    exigem **deploy** para a normalização parar de exibir "EAD" nos semipresenciais.

---

### 2026-06-03 - RAG: plano de pagamento antecipado em grad_info / pos_info

- **Decisão**
  - Adicionada **1 linha nova em `grad_info` e 1 em `pos_info`** (id=125 e id=124)
    com o "Plano de Benefício para Pagamento Antecipado Facultativo" (descontos
    70%/50%/20% conforme o dia do mês; sem desconto após o dia 10), para o agente
    responder quando o candidato perguntar **quais dias pode pagar a mensalidade**.
  - Conteúdo geral (não por curso), com cabeçalho de palavras-chave para retrieval.
    Embedding gerado com o mesmo modelo do RAG (`text-embedding-3-small`, 1536 dims).
  - Script reutilizável: `scripts/add-plano-pagamento-info.mjs` (`--dry-run`,
    idempotente via `metadata.topic = 'pagamento_antecipado'`).

- **Contexto**
  - `grad_info`/`pos_info` são tabelas RAG (content + embedding) consultadas por
    `match_grad_info`/`match_pos_info`. O `queryClassifier` roteia perguntas de
    pagamento para `ambiguous` (busca as 4 tabelas) ou `mista` (inclui `*_info`),
    então a informação em `*_info` é alcançável. Validado: as linhas novas voltam
    em 1º lugar (similarity ~0.64–0.70 vs ~0.30–0.50 dos cursos).

- **Alternativas descartadas**
  - Anexar o texto a cada uma das 41 linhas de curso e re-embeddar tudo: polui os
    embeddings por curso e é redundante para uma informação geral.
  - Colocar em `*_preco`: o usuário pediu `*_info`; o roteamento já cobre `*_info`.

- **Impacto**
  - Aditivo e reversível (basta apagar as linhas com `metadata.topic=pagamento_antecipado`).
    Sem mudança de código do agente; só dado de RAG.

---

### 2026-06-03 - Agente assume a função do n8n após o formulário (parse + card + matrícula)

- **Decisão / desfecho**
  - O agente passa a cumprir, **sem n8n**, o que o workflow `log_inscricao_feita_sum`
    fazia ao receber o Meta Flow (`nfm_reply`): parsear o `response_json`, AJUSTAR os
    dados e preencher o card do Kommo, depois seguir para a matrícula.
  - Novos módulos:
    - `libShared/metaFlowFormParser.js` — porte fiel do node "Code in JavaScript3":
      `parseMetaFlowResponseJson` + helpers de normalização (`normalizeBrazilPhone`
      → DDI 55; `formatDateToDDMMYYYY`; `mapSexo` enum→texto; CPF só dígitos).
      Mapeia por **field_id embutido na chave** (`<Tipo>_<fieldId>_<idx>`) — resiliente
      a mudança de tipo/índice. IDs: 1475361 nome, 1475363 cpf, 1475397 telefone,
      1475395 email, 1475971 sexo, 1475467 nascimento.
    - `server/metaFlowFormSync.js` — `applyMetaFlowFormToKommo`: PATCH dos campos
      personalizados (nome/cpf/telefone/nascimento/sexo) + move o lead para
      pipeline 13756724 / status 106804680 (inscrição) + cria a nota de auditoria
      no MESMO formato do n8n (CPF/DATA/NOME/EMAIL/TELEFONE/SEXO). Dedupe em memória
      (10 min) evita PATCH/nota duplicados em retries.
  - Ligação no `agentRunner.js`: ao detectar o `nfm_reply` cru
    (`messageIsMetaFlowFormReply`), sincroniza o Kommo ANTES do pipeline pós-form.
    O pipeline existente (`fetchLeadFormSnapshot` → `detectFormSumarRecebidoNoKommo`
    → `stepMatriculaPosForm`) então lê o card já preenchido e segue para a matrícula.

- **Contexto (evidências)**
  - Com o n8n desativado (webhook Meta repontado p/ o agente), ninguém preenchia o
    card após o formulário; o snapshot vinha vazio e o pós-form não avançava.
  - O webhook Meta já entrega o reply no buffer como `[FORMULARIO SUMAR]: {response_json}`
    (`server/whatsapp/metaWebhook.js`), mas o `parseFormDataNoteFields` só lia o
    formato de NOTA (CPF:/NOME:), não o `response_json` (chaves `TextInput_<id>`).
  - O e-mail vai SÓ na nota (igual ao n8n, que não gravava e-mail no card); o snapshot
    já lê e-mail da nota via `enrichSnapshotFromFormNote`.
  - Curso/polo/tipo_ingresso continuam vindo da conversa (sum_Curso + passo de polo
    pré-form), não do formulário — idêntico ao n8n.
  - Parser validado com o sample do `pinData` do workflow.

- **Alternativas descartadas**
  - Reativar o n8n — contraria a decisão de ter o agente como único receptor (evita conflito).
  - Casar a string literal completa da chave do Flow — frágil a mudanças de tipo/índice;
    optou-se por mapear pelo field_id numérico embutido.

- **Impacto**
  - Funil/IDs configuráveis por env (`AGENT_FUNNEL_PIPELINE_ID`,
    `AGENT_FUNNEL_STATUS_INSCRICAO`, `KOMMO_FIELD_FORM_*_ID`); defaults = os do n8n.
  - Move o lead para "inscrição" automaticamente ao receber o formulário — coerente
    com a regra de o agente atender em Atendimento + inscrição.

---

### 2026-06-03 - Fix: curso errado no card (sum_Curso) por palavra-chave incidental na descrição

- **Decisão / desfecho**
  - Corrigido `extractDiscussedCourseFromHistory` (`libShared/conversationContextHeuristics.js`)
    para extrair o curso pelo **enunciado do tópico** ("curso de [graduação/tecnólogo] em X")
    e, no fallback, varrer **só a 1ª frase** do texto do assistente — não a descrição inteira.
    A captura é normalizada para o nome canônico de curso conhecido.
  - Reforçada a regra #17 do prompt (`promptsLoader.js`) com o padrão exato
    "Quer mais detalhes ou informações sobre outro curso?" → "sim" → perguntar qual,
    NUNCA redespejar a descrição do curso atual.

- **Contexto (evidências)**
  - Lead real #23877563 (Leandra, +5511910144847): card `sum_Curso` mudou Direito → **Administração**
    enquanto a conversa era sobre **Redes de Computadores**. O agente também **repetiu**
    a mesma resposta de Redes ao receber "sim".
  - Causa raiz do curso errado: ao responder "sim", `detectCursoConfirmadoPeloLead` chamava
    `extractDiscussedCourseFromHistory`, que caía no fallback `extractCursoAreaFromText` e
    varria a descrição inteira do curso de Redes, casando a palavra "administração" presente
    em "…foco em **administração** e segurança de redes corporativas…". "Administração" vem
    antes de "Redes de Computadores" na lista `CURSO_PATTERNS`. Reproduzido com os dados reais.
  - Causa da repetição: violação da regra #17b do prompt (LLM redespejou a info em vez de
    perguntar qual opção). Reforço de prompt aplicado; guard determinístico fica como opção.

- **Alternativas descartadas**
  - Reordenar `CURSO_PATTERNS` — não resolve (a palavra ainda aparece na descrição).
  - Guard determinístico anti-repetição no `agentRunner` — adiado (maior risco de falso
    positivo); prompt reforçado primeiro.

- **Impacto**
  - Heurística de "curso em discussão" usada em vários pontos (sum_Curso, continuação de
    assunto). Agora prioriza o enunciado do tópico e o nome canônico, evitando falsos positivos.

---

### 2026-06-02 - Diagnóstico: chats WABA da conta `academicosoead` não são legíveis (dispatcher é de OUTRA conta)

- **Decisão / desfecho**
  - **Mantido `KOMMO_INBOUND_POLL_MODE=notes`** em produção. Uma troca experimental
    para `dispatcher` foi feita e **revertida** no mesmo dia ao descobrir que o
    `banco-kommo-dispatcher` sincroniza **outra conta Kommo**, não a do agente.
  - Não há mudança de código. Decisão de configuração/arquitetura pendente de
    definição do canal correto (ver abaixo).

- **Contexto (evidências)**
  - Lead real #23583611 (conta `academicosoead.kommo.com`, account_id 31697347,
    pipeline 13756724 etapa Atendimento, com telefone +5511993537209) não recebia
    atendimento. Funil/allowlist/scheduler estão corretos.
  - O talk dele é `origin='waba'` ("Suporte ao Aluno - Sumaré EaD",
    chat_id `bb2f4644…`). As mensagens "oi" de hoje **não existem** como
    `incoming_chat_message` nem como nota v4 (só um `entity_direct_message` antigo de
    março). Texto, se existir, está só na camada Chats/Amojo — e Amojo não está
    configurado (`KOMMO_CHANNEL_SECRET/SCOPE_ID` ausentes).
  - `banco-kommo-dispatcher`: saudável (~1,8M msgs, ~83k chats), mas
    `by-lead`/`by-chat`/`sync-chat` retornam **0** para os 3 leads do funil do
    agente. Sessão logada como `felipe.nolasco@cruzeiroead.com.br`
    (LAST_PLACE_DEALS pipeline 5481944). Leads que o dispatcher possui (ex.:
    21317945, 20885141) retornam **HTTP 204 (inexistentes)** na conta do agente →
    **o dispatcher é de outra conta** (comercial cruzeiroead), não `academicosoead`.
  - Conclusão: para os leads do agente, **nenhum** caminho lê esse canal WABA hoje
    (Evolution só cobre a instância `SUMARE_IA`; poll `notes` não vê WABA do Kommo;
    Amojo não configurado; dispatcher é de outra conta).

- **Alternativas em aberto (a decidir com o produto)**
  - (a) Conectar o número "Suporte ao Aluno - Sumaré EaD" à instância Evolution
    (`SUMARE_IA`) → webhook passa a entregar inbound direto ao buffer.
  - (b) Configurar Amojo da conta `academicosoead` (`KOMMO_CHANNEL_SECRET` +
    `KOMMO_CHANNEL_SCOPE_ID`) e usar `KOMMO_INBOUND_POLL_MODE=amojo`.
  - (c) Apontar um dispatcher para a conta `academicosoead` (o atual é de outra).
  - (d) Usar o webhook nativo da Meta Cloud (já implementado) se esse número estiver
    no app Meta do projeto.
  - Hipótese a validar: o "oi" pode ter sido digitado no widget de chat do Kommo
    (Salesbot), e não enviado como WhatsApp real do telefone do contato — nesse caso
    nenhum webhook dispara. Testar com mensagem real do telefone do cliente.

- **Impacto**
  - Produção segue em `notes` (estado anterior, sem regressão). O atendimento por
    Evolution (`SUMARE_IA`) não depende disso e continua funcionando.

---

### 2026-06-02 - Funil da IA passa a atender também a etapa "inscrição" (não "aguardando pagamento")

- **Decisão**
  - `server/kommoAgentFunnelGate.js`: o funil fixo da IA deixa de ser um único
    status e passa a ser uma lista `AGENT_FUNNEL_STATUS_IDS = [106140284
    (Atendimento), 106804680 (inscrição)]`. `leadMatchesAgentFunnel` e
    `resolveAgentFunnelFromEnv` usam a lista; o scheduler/listador já iteravam
    `statusIds`, então nenhuma outra mudança foi necessária.
  - "aguardando pagamento" (106426128) **continua fora** do funil — quando o
    candidato envia o comprovante, `tryHandleMatriculaAceitePagamentoFlow` move o
    lead para essa etapa e pausa a IA (`atendimento_ia=pause`).

- **Contexto**
  - Após a matrícula o lead fica na etapa "inscrição" (aguardando aceite/contrato
    e o comprovante). Com o funil antigo (só "Atendimento"), o scheduler/poll não
    processava o lead nessa etapa → a IA ficava muda justamente quando precisava
    encaminhar dados e receber o comprovante. Pedido do produto: atender em
    "inscrição" até o comprovante; parar em "aguardando pagamento".

- **Alternativas descartadas**
  - Mover o lead de volta para "Atendimento" a cada inbound: exigiria automação
    externa (n8n) e mexer no estágio do CRM a cada mensagem — frágil e ruidoso.
  - Tornar o funil configurável por env: o arquivo é trava fixa de propósito
    (env divergente é ignorado com warn); manter os IDs no código preserva esse
    contrato e evita drift de configuração entre ambientes.

- **Impacto**
  - A IA conversa em "Atendimento" e "inscrição"; ao receber o comprovante o lead
    vai para "aguardando pagamento" e a IA não atende mais ali (handoff humano).
  - Vale para TODOS os leads do pipeline 13756724. Requer deploy em produção.

---

### 2026-06-02 - Código de curso só é "código pronto" se tiver formato token_token (ex.: GAST_EAD)

- **Decisão**
  - Em `resolveCursoCodigo` (`server/sumareCaptacaoClient.js`) e
    `resolveCursoCodigoFromDb` (`server/sumareCaptacaoCursoStore.js`), o atalho que
    considera o valor "já um código de API" passou de `/^[A-Z0-9_]{4,32}$/i` para
    `/^[A-Z0-9]+(?:_[A-Z0-9]+)+$/i` — exige o formato real de código (token_token,
    ex.: `GAST_EAD`, `ADM_EAD`). Nomes humanos de curso ("Gastronomia",
    "Administração") deixam de casar e passam a cair no mapa estático e no catálogo
    `sumare_captacao_curso` (Supabase), que resolve o código correto.

- **Contexto**
  - Matrícula do lead `#23841399` (curso "Gastronomia") falhava com HTTP 500 da API
    de Captação: `Cannot insert the value NULL into column 'CANDIDATO'
    (LYCEUM.dbo.TSCU_INSCRICAO_FINANCEIRO_CANDIDATO)`. O snapshot do Kommo estava
    completo e válido (nome, CPF, e-mail, data nasc., sexo). A causa era o curso:
    `resolveCursoCodigo` casava a palavra "Gastronomia" no regex permissivo e
    devolvia o literal `GASTRONOMIA` (inexistente no Lyceum), pulando inclusive a
    consulta ao Supabase. Diagnóstico confirmado: `GASTRONOMIA`→500;
    `GAST_EAD`→200 OK (candidato gerado, página Contrato).

- **Alternativas descartadas**
  - Adicionar "gastronomia" ao mapa estático `CURSO_NOME_TO_CODIGO`: resolveria só
    esse curso; o regex permissivo continuaria mascarando outros nomes presenciais.
  - Validar o código contra o catálogo antes de enviar: mais robusto, porém maior;
    o catálogo Supabase já é a fonte de verdade e passa a ser consultado com o fix.

- **Impacto**
  - "Gastronomia" e demais nomes humanos passam a resolver pelo catálogo
    (`GAST_EAD` etc.); a matrícula da Sumaré deixa de receber código inválido.
  - Valores que JÁ são código (`GAST_EAD`) continuam aceitos sem ida ao catálogo.
  - Requer deploy em produção para o agente resolver automaticamente; o lead
    `#23841399` foi matriculado manualmente (candidato `2026700000004826`, link de
    contrato enviado por WhatsApp) para validar o fluxo ponta a ponta.

---

### 2026-06-02 - Formulário vazio (n/a) não dispara matrícula nem pausa a IA

- **Decisão**
  - **A) Gate de detecção por dados reais** (`server/inscricaoPostFormPipeline.js`,
    `detectFormSumarRecebidoNoKommo`): uma nota com ESTRUTURA de formulário
    (`CPF:`/`NOME:`/`EMAIL:`…) só conta como "formulário recebido" se o
    `fetchLeadFormSnapshot` do Kommo tiver os campos obrigatórios preenchidos
    (`validateFormSnapshot`, que trata `n/a`/"não informado"/vazio como ausente).
    O marcador real do Flow ("Flow responses received") continua detectando.
  - **B) Rede de segurança anti-pause espúrio** (`server/dadosClienteStore.js`,
    `decideHoldOnIaPause`/`shouldHoldOnIaPause`): se o lead está `atendimento_ia=pause`
    mas o `inscricao_form_status='aguardando_form_sumar'`, o pause é considerado
    indevido (a IA deveria estar conversando nesse estágio) — limpa o pause
    (`await`, antes do gate secundário do `agentRunner`) e deixa o atendimento seguir.
  - **Higiene de buffer** (`server/kommoInboundPoll.js`, `classifyInboundNote`):
    nota de dados de formulário (estrutura, sem marcador de Flow) é DADO de CRM,
    não mensagem do candidato — passa a ser `skip` (`form_data_note`) e não entra
    no buffer (evitava a IA responder a "CPF: n/a …").

- **Contexto**
  - Lead `#23841399` ficou sem resposta: o bridge/poll gravou nota de formulário
    com todos os campos `n/a`; a heurística tratou como submissão real → pipeline
    pós-formulário chamou a API de Captação → falhou (sem CPF/nome) →
    `pauseAtendimentoIa` + `distribuir_consultor`. Toda mensagem seguinte caía no
    gate de pause = silêncio. A matrícula lê os dados dos campos do Kommo
    (`fetchLeadFormSnapshot`), não do texto da nota.

- **Alternativas descartadas**
  - Guard puramente textual ("tudo n/a") em `messageLooksLikeFormSumarResponse`:
    frágil (o telefone vem preenchido) e não reflete a fonte real da matrícula
    (campos do Kommo). Optou-se por validar o snapshot.
  - Auto-despausar em qualquer estágio: arriscado (reabriria handoffs legítimos
    em `aguardando_aceite`/`distribuir_consultor`). Restringiu-se a
    `aguardando_form_sumar`.

- **Impacto**
  - Formulário incompleto não pausa mais a IA nem estrangula o lead; a matrícula
    só é acionada quando os dados reais chegam aos campos do Kommo.
  - **Dependência de origem (C, fora deste repo):** a matrícula só efetiva quando
    o Meta Flow → n8n gravar CPF/nome/email/curso nos campos do lead no Kommo,
    com nomes compatíveis com `FIELD_ALIASES` (`server/inscricaoKommoFields.js`):
    nome (`sum_nome`/id 304628), e-mail (`e-mail`/`sum_email`), CPF (`cpf`/`documento`),
    curso (`curso inscrição`/`sum_curso`/`código curso`). Sem isso, não há dado
    para matricular. Obrigatórios configuráveis via `INSCRICAO_FORM_REQUIRED_FIELDS`
    (default `nome,email,cpf,curso_inscricao`).

---

### 2026-06-02 - Snapshot do formulário com fallback pela nota do n8n + e-mail estrito

- **Decisão**
  - `fetchLeadFormSnapshot` (`server/inscricaoKommoFields.js`) passou a preencher
    campos vazios (`nome/email/cpf/data_nasc/sexo`) a partir da última NOTA de
    dados do formulário (escrita pelo n8n no Kommo), via
    `parseFormDataNoteFields` (`libShared/inscricaoFormHeuristics.js`). Só
    preenche o que está ausente no campo personalizado; nunca sobrescreve.
  - Validação de e-mail estrita: e-mail sem formato válido (ex.: `@` corrompido
    na nota — `...0204@gmail.com` virou `...02042gmail.com`) é tratado como
    ausente (`validateFormSnapshot` + parser). Evita matricular com e-mail
    inválido e o consequente pause indevido.

- **Contexto**
  - O n8n passou a gravar os dados do Flow nos campos do Kommo (`sum_Nome`,
    `sum_CPF`, `sum_Data Nascimento`, `Sexo`, `sum_Curso`=Gastronomia) e numa
    nota. Porém o `sum_Email` ficou vazio (e-mail só na nota) e a nota corrompe
    o `@`. Sem o fallback, o snapshot reprovava por e-mail e a matrícula não
    disparava.

- **Alternativas descartadas**
  - Resolver só no n8n (gravar `sum_Email`): correto, mas deixa o agente frágil a
    qualquer campo não replicado. O fallback pela nota torna a leitura resiliente.
  - Aceitar o e-mail corrompido: matricularia com e-mail inválido → rejeição da
    API de Captação → pause/handoff (o problema que estamos eliminando).

- **Impacto**
  - O agente reconhece o formulário e dispara a matrícula automaticamente assim
    que um e-mail VÁLIDO chegar (campo `sum_Email` ou na nota com `@` íntegro).
  - **Pendência de origem:** corrigir no n8n o e-mail — gravar em `sum_Email` e/ou
    não corromper o `@` na nota. É o único dado que ainda falta para este lead.

---

### 2026-06-02 - Webhook nativo WhatsApp Cloud API (Meta) sem Evolution

- **Decisão**
  - Receber as mensagens do candidato **direto da Meta** via webhook nativo,
    eliminando a Evolution como intermediário do inbound (causa de quedas em
    produção). Novas rotas em `server.js`:
    `GET /api/whatsapp/webhook` (verificação `hub.challenge`) e
    `POST /api/whatsapp/webhook` (eventos).
  - Módulos novos e isolados:
    - `server/whatsapp/metaWebhook.js` — verify token, validação de
      assinatura `X-Hub-Signature-256` (HMAC com `WHATSAPP_APP_SECRET`),
      parser do payload Meta (`entry[].changes[].value.messages[]`) para
      texto/áudio/imagem/botão/interactive(Flow)/documento/vídeo/localização,
      e push no MESMO buffer (`pushMessage`). Só BUFFERIZA; o agentScheduler
      responde (idêntico ao webhook Evolution).
    - `server/whatsapp/metaMedia.js` — download de mídia em 2 etapas
      (`GET /<media_id>` → URL temporária → bytes), devolvendo base64 para
      reaproveitar Whisper/Vision (`transcribeAudioBase64`/`analyzeImageBase64`).
  - `express.json({ verify })` passou a guardar `req.rawBody` (bytes crus
    necessários para o HMAC da assinatura).
  - Marcadores de áudio/imagem no buffer são idênticos aos do caminho
    Evolution, para o prompt (regra de mídia) reagir igual.
  - **Rollout seguro**: a rota fica INERTE até `WHATSAPP_WEBHOOK_VERIFY_TOKEN`
    ser configurado (GET 403, POST ignora). Evolution continua como fallback.
    `WHATSAPP_INGEST_PHONE_ALLOWLIST` limita a fase de teste a números
    específicos. Outbound, "digitando..." e mídia já eram Cloud API direto.

- **Contexto**
  - A conexão Meta↔Evolution cai com frequência em produção, deixando o
    agente sem receber mensagens. O envio já era Cloud API direto (modo
    `cloud`), então o número já é Meta Cloud — a Evolution só fazia ponte.
  - A Cloud API não oferece "puxar" inbound por polling próprio; o caminho
    direto é o webhook nativo (ou, alternativamente, o poll do Kommo já
    existente).

- **Alternativas descartadas**
  - Poll do Kommo (`KOMMO_INBOUND_POLL_MODE`): funciona sem Evolution e sem
    webhook, mas adiciona latência, depende da integração nativa do Kommo e
    não traz mídia de forma confiável. Mantido como fallback secundário.
  - Estabilizar a Evolution: não resolve a causa (a ponte Meta↔Evolution).

- **Impacto**
  - Inbound em tempo real, sem intermediário; some a gambiarra da "ponte
    Cloud" (`contacts.upsert` sem telefone) que descartava mensagens.
  - Migração faseada: código deployável sem efeito até configurar as envs +
    Callback URL no painel Meta. Rollback = remover o verify token / reapontar
    URL para a Evolution.
  - Risco concentrado no download de mídia (mecanismo novo) — validar com
    número de teste (texto → áudio → imagem → resposta) antes do corte.

---

### 2026-06-02 - Ambiente de teste do agente sem Evolution (/api/test/inbound)

- **Decisão**
  - Novo endpoint `POST /api/test/inbound { phone, message, send?, leadId? }`
    (`server.js`) que injeta uma mensagem como se viesse do lead e roda o
    caminho REAL `flushSession` (mesmo do scheduler) — exercitando todas as
    funções do agente (inscrição, polo, distribuir, captação, telemetria)
    sem depender do inbound da Evolution.
  - `flushSessionInner` ganhou as flags de teste em `opts`:
    `test:true` (ignora gates ai_disabled / reply_cooldown / ia_paused) e
    `suppressWhatsapp:true` (não envia no WhatsApp, só devolve a reply;
    também não re-enfileira o turno). `skipFunnelGate` já existia.
  - Restrito à allowlist `TEST_INBOUND_PHONES` (CSV de dígitos; vazio =
    só `5511944690752`).
  - UI: Playground ganhou o modo "Teste real" (`src/components/Playground.jsx`)
    com toggle "Responder no WhatsApp real" (send) vs "só na tela" (suppress).
  - CLI: `scripts/test-inbound.mjs "<msg>" [telefone] [leadId] [--no-send]`.

- **Contexto**
  - A ponte Meta Cloud → Evolution descarta mensagens do candidato
    (`contact_skip_no_remote_jid`): o `contacts.upsert` chega sem o telefone
    do lead, então o inbound não entra no buffer e o agente fica mudo.
  - Enquanto a ponte não é corrigida/deployada, era preciso um canal de
    teste confiável para um número específico que exercite o agente inteiro.

- **Alternativas descartadas**
  - Reusar só o `/api/playground/flush`: roda `runAgent` mas não passa pelo
    `flushSession` real (sem funil, sem envio WhatsApp, sem telemetria
    `origem:evolution`), então não reproduz produção.
  - Modo padrão do Playground (browser → OpenAI direto): usa prompt/tools
    simplificados, sem inscrição/polo/CRM — não cobre "todas as funções".

- **Impacto**
  - Teste end-to-end de um número específico sem Evolution, com opção de
    responder de verdade no WhatsApp ou só simular na tela.
  - Risco contido: gates só são ignorados quando `test:true` (exclusivo do
    endpoint) e o endpoint é limitado pela allowlist.

---

### 2026-06-01 - Notas internas de auditoria não vazam como mensagem do candidato

- **Decisão**
  - Toda nota INTERNA de auditoria criada pelo agente (movimentação de
    funil, motivo de perda, comprovante recebido, reativação) passa a ser
    criada via novo helper `createLeadAuditNote` (`server/kommoClient.js`),
    que injeta o marcador estável `AGENT_AUDIT_NOTE_MARKER`
    (`· [registro interno IA]`).
  - O poll de inbound (`kommoInboundPoll`) descarta essas notas através de
    `isKommoSystemOrIntegrationNote`, que agora chama
    `isAgentInternalAuditNote` em duas camadas:
    - **Camada A (marcador):** qualquer nota com `[registro interno IA]`
      é auditoria — blindagem definitiva para notas futuras, independente
      do texto.
    - **Camada B (frases):** frases de auditoria já existentes no CRM
      ("Lead confirmou desistência", "Motivo da perda", "Comprovante de
      pagamento recebido", "movido para fila/pipeline", "após inatividade",
      "fila pós-matrícula") — defesa em profundidade para notas antigas
      sem o marcador.

- **Contexto**
  - O agente em produção lê mensagens via polling de notas do Kommo (não há
    webhook direto do WhatsApp para esses leads). O poll separa "fala do
    candidato" de "eco/sistema" por heurística de texto.
  - A nota de auditoria de desistência ("Lead confirmou desistência da
    inscrição via WhatsApp. Motivo da perda: Sem Interesse. Movido para
    fila 143…") não casava nenhum filtro e foi lida como **mensagem do
    candidato**, entrando no `n8n_chat_histories` como `user` (lead
    #23841399, id 54545). Isso corrompeu o contexto do LLM.
  - Havia 8 call sites de `createLeadNote`; vários gravavam notas internas
    com risco de vazar. O modelo era frágil: cada texto novo de nota
    interna podia vazar de novo.

- **Alternativas descartadas**
  - Só expandir o heurístico de texto (camada B isolada): "whack-a-mole" —
    cada nova frase de auditoria voltaria a vazar. Mantido apenas como
    defesa em profundidade.
  - Gravar auditoria com `note_type` distinto: Kommo trata `common` de
    forma especial e a integração WhatsApp também usa `common`; mudar o
    tipo arriscava quebrar a visualização no CRM e o que o poll já consome.

- **Impacto**
  - Notas de auditoria nunca mais entram no histórico do LLM como fala do
    candidato — atuais (camada B) e futuras (camada A).
  - Call sites roteados: `inscricaoDesistenciaFlow`, `inscricaoAceitePagamentoFlow`,
    `inactivityReengagement`, `matriculaCaptacaoPipeline`. `kommoSalesbot`
    e `whatsappSender`/`whatsappTemplateSender` mantêm `createLeadNote`
    (já filtrados por salesbot/sufixo EX-).
  - `createLeadAuditNote` é idempotente (não duplica o marcador).
  - Histórico corrompido do lead de teste #23841399 foi limpo (reset).
  - Testes seção 14 (14 asserts): texto exato da desistência, comprovante,
    inatividade, marcador arbitrário, e garantia de que fala real do
    candidato NÃO é classificada como auditoria. 139/139 passando.

- **Arquivos**
  - `libShared/inboundMessageSanitize.js`: `AGENT_AUDIT_NOTE_MARKER`,
    `isAgentInternalAuditNote`, plug em `isKommoSystemOrIntegrationNote`.
  - `server/kommoClient.js`: `createLeadAuditNote`.
  - `server/inscricaoDesistenciaFlow.js`, `server/inscricaoAceitePagamentoFlow.js`,
    `server/inactivityReengagement.js`, `server/matriculaCaptacaoPipeline.js`:
    roteados para o helper.
  - `scripts/test-inscricao-flow.mjs`: seção 14.

---

### 2026-05-28 - Pause gate com exceção para `desistencia_concluida` (early handler)

- **Decisão**
  - `flushSessionInner` (webhook Evolution) deixou de usar
    `isAtendimentoIaPaused` e passou a usar `shouldHoldOnIaPause`
    (`server/dadosClienteStore.js`). A decisão composta retorna
    `{ hold, paused, reason }`:
    - `atendimento_ia='pause'` + `inscricao_form_status='desistencia_concluida'`
      → `hold=false`, `reason='desistencia_concluida'` → drain prossegue.
    - Demais casos com `pause` → `hold=true` (bloqueia, igual antes).
  - `runAgent` ganhou um handler "early" `tryHandleDesistenciaJaRegistrada`
    rodando junto com `tryHandleCaptacaoInscricaoExistenteFlow` e
    `tryHandleMatriculaAceitePagamentoFlow`, ANTES do gate interno de
    pause. Esse handler só responde a mensagem canônica
    "Sua desistência já foi registrada…" quando o status do banco é
    `desistencia_concluida` — não depende de histórico.

- **Contexto**
  - Lead que confirmava desistência ficava com `atendimento_ia=pause`.
    Próxima mensagem (qualquer "boa tarde", "oi") era bloqueada por
    `flushSessionInner` e o lead nunca recebia resposta. O fallback
    "Sua desistência já foi registrada…" existia em
    `tryHandleInscricaoDesistenciaFlow` mas estava posicionado depois
    do gate de pause em `runAgent`, sendo inalcançável.
  - Bug reportado no lead #23841399 (William testest) — generalizado
    a qualquer lead que confirmasse desistência.

- **Alternativas descartadas**
  - Auto-reativar IA após pause: perigoso, pode roubar conversa de
    consultor humano em casos de `distribuir_humano`.
  - Remover `atendimento_ia=pause` do fluxo de desistência: quebraria
    a semântica de "encerrado" e poderia fazer o LLM oferecer
    reativação espontânea quando o lead só estava agradecendo.
  - Mover a checagem `isAtendimentoIaPaused` inteira para depois dos
    early handlers: cobriria o caso, mas perderia a otimização de
    `skipPauseCheck` no `runAgent` (round-trip extra a Supabase).

- **Impacto**
  - Lead que voltar a falar após desistência confirmada recebe
    sempre a mensagem canônica via early handler — sem precisar
    intervenção manual.
  - Demais casos de `atendimento_ia=pause` (matrícula em andamento,
    consultor humano) continuam bloqueando o drain, como antes.
  - Testes seção 13 cobrem `decideHoldOnIaPause` em 9 combinações
    (null row, paused null, pause genérico, pause + desistência,
    case-insensitive). 117/117 testes passando.
  - Função pura `decideHoldOnIaPause` torna o gate testável sem
    Supabase e abre espaço para outras exceções similares no futuro
    (cada uma com seu `reason` distinto).

- **Arquivos**
  - `server/dadosClienteStore.js`: `decideHoldOnIaPause` (pura) +
    `shouldHoldOnIaPause` (async).
  - `server/inscricaoDesistenciaFlow.js`: `tryHandleDesistenciaJaRegistrada`.
  - `server/ai/agentRunner.js`: plug do early handler antes do
    gate `isAtendimentoIaPaused`.
  - `server/evolution/webhookEvolution.js`: gate trocado para
    `shouldHoldOnIaPause` com log explícito quando há early handler.
  - `scripts/test-inscricao-flow.mjs`: seção 13 (11 asserts).

---

### 2026-05-28 - Separação TOTAL entre perfis (Atendimento com `mode: exclude`)

- **Decisão**
  - Estender `kommoScope` com campo `mode: 'include' | 'exclude'`
    (default `'include'`, preservando comportamento anterior).
  - **Agente Atendimento** passa a ter `kommoScope` ativo com
    `mode: 'exclude'` e `statusIds: [INSCRIÇÃO, AGUARDANDO_PAGAMENTO]`
    — Dashboard / Execuções / Feedback IA filtram **excluindo** leads
    que estão nessas duas colunas.
  - **Agente Inscrição** marcado explicitamente com `mode: 'include'`
    nos mesmos `statusIds`.
  - Helper compartilhado `leadMatchesScope(leadId, scopedState)` em
    `src/lib/funnelScope.js` centraliza a regra; cada componente apenas
    delega. Heurística para execuções sem `leadId` (playground, lookup
    falhou): `mode=include` descarta (não confirma pertencimento),
    `mode=exclude` mantém (não está nos status excluídos).
  - **Aba Matrículas removida do perfil Atendimento** (toda matrícula
    vem do agente de Inscrição; ficaria vazia após o filtro).
  - **Funil Kommo** recebe um escopo dedicado por perfil
    (`profile.kommoFunnelScope`), separado do `kommoScope` usado para
    filtragem client-side. Necessário porque o endpoint do Kommo só
    sabe filtrar por inclusão (sem operador "not in"):
    - Atendimento → `[ATENDIMENTO (106140284), AGUARDANDO_RESPOSTA (106377088)]`
    - Inscrição   → `[INSCRIÇÃO (106804680), AGUARDANDO_PAGAMENTO (106426128)]`
  - Constante `KOMMO_STATUS_AGUARDANDO_RESPOSTA = 106377088` levantada
    em 2026-05-28 via Network do Kommo (PATCH ao arrastar lead).

- **Contexto**
  - Após Fase 2, o perfil Atendimento ainda mostrava "tudo" em
    Dashboard/Execuções/Feedback IA, incluindo dados dos leads de
    INSCRIÇÃO/PAGAMENTO. Consultor pediu separação completa: Inscrição
    só os 2 status do agente de inscrição; Atendimento todo o resto.
  - Como o `status_id` de AGUARDANDO RESPOSTA ainda não foi
    levantado, a abordagem por **exclusão** (em vez de inclusão
    explícita dos status do Atendimento) evita o bloqueio: qualquer
    coluna nova no Kommo cai automaticamente em "Atendimento".

- **Alternativas descartadas**
  - *Listar explicitamente os `statusIds` do Atendimento*: precisaria
    do ID de AGUARDANDO RESPOSTA agora, e quebraria toda vez que uma
    coluna nova surgisse no funil.
  - *Filtrar `MatriculasViewer` com o mesmo `kommoScope`*: na prática
    daria lista vazia (matrícula → lead em INSCRIÇÃO/PAGAMENTO). Mais
    honesto remover a aba do perfil Atendimento.
  - *Estender o `Funil Kommo` do Atendimento por exclusão*: o endpoint
    do Kommo não tem operador "not in". Listar leads do pipeline
    inteiro e filtrar custaria muitos GETs extras — defere para quando
    tivermos o ID de AGUARDANDO RESPOSTA.

- **Impacto**
  - Atualizados: `src/lib/funnelScope.js`, `src/lib/agentProfiles.js`,
    `src/components/Dashboard.jsx`, `src/components/ExecutionViewer.jsx`,
    `src/components/FeedbackIA.jsx`, `src/App.jsx`.
  - Persistência: usuários que tinham `matriculas` como última página
    do perfil Atendimento caem automaticamente em `dashboard`
    (`loadPageForProfile` valida contra o `nav` atualizado).
  - Backend: zero mudança nesta entrega — usa o mesmo endpoint
    `/api/scheduler/funnel?statusIds=…` (chamado com os IDs do
    Inscrição em ambos os perfis; o que muda é a operação client-side).
  - Rollback: `git revert` da mudança restaura o comportamento parcial
    anterior (Atendimento sem filtro, Inscrição com filtro).

---

### 2026-05-28 - Perfis de agente no painel (Atendimento + Inscrição)

- **Decisão**
  - Painel React passa a ter **dois perfis de espaço de trabalho**, alternáveis
    via dropdown no topo da sidebar (padrão visual inspirado no troca-conta do
    Kommo):
    1. **Agente Atendimento** (perfil padrão) — mantém as 8 abas atuais:
       Dashboard, Funil Kommo, Prompts, Teste IA, Execuções, Feedback IA,
       Matrículas, Atualização IA.
    2. **Agente Inscrição** — 5 abas dedicadas: Dashboard, Execuções,
       Matrículas, Feedback IA, Funil Kommo (Inscrição).
  - Estado do perfil ativo persistido em `localStorage` (`agent_profile`).
  - **Página corrente é lembrada por perfil** (`agent_profile_page` é um
    objeto `{ atendimento: pageId, inscricao: pageId }`): trocar de perfil
    e voltar mantém a última aba aberta naquele perfil.
  - **Fase 1 (esta entrega)**: apenas a UI shell. As 4 abas do perfil
    Inscrição reusam os mesmos componentes do Atendimento, com um banner
    `InscricaoScopeBanner` no topo avisando que **o filtro por agente ainda
    não está aplicado** — exibem dados de todos os agentes até a Fase 2.
  - **Fase 2 (definição esclarecida em 2026-05-28)**: a separação é por
    **status (coluna) dentro do mesmo pipeline AGENTE-SUMARÉ** (`13756724`).
    Status IDs centralizados em `src/lib/agentProfiles.js`:
    - `KOMMO_STATUS_ATENDIMENTO = 106140284` (Agente Atendimento — já
      é o `KOMMO_AGENT_STATUS_ID` do `.env`)
    - `KOMMO_STATUS_INSCRICAO = 106804680` (Agente Inscrição)
    - `KOMMO_STATUS_AGUARDANDO_PAGAMENTO = 106426128` (Agente
      Inscrição — mesmo ID já em uso como `KOMMO_POS_MATRICULA_STATUS_ID`;
      lead vai pra cá após enviar comprovante)
  - Cada perfil tem `kommoScope: { pipelineId, statusIds }` na sua
    config. Componentes que precisam filtrar dados por agente recebem
    esse `kommoScope` via prop e filtram client-side (ou via query
    param quando o endpoint suporta).
  - **Implementação por aba** está sendo feita progressivamente após
    a definição dos IDs (ver entrada subsequente).

- **Contexto**
  - Negócio terá dois agentes operando em paralelo: um faz atendimento
    comercial (já existente), outro automatiza inscrições/matrículas.
  - Consultor pediu separação visual pra "não ficar tudo junto e confuso"
    — métricas, feedback e funil de cada agente isolados.
  - Espelha o padrão do Kommo onde cada conta tem perfis (CRUZEIRO,
    ANHANGUERA, UEaD, etc.) trocáveis pelo header do app.

- **Alternativas descartadas**
  - *Rotas distintas (`/atendimento/*` vs `/inscricao/*`)*: o app não usa
    react-router, adicionaria dependência só pra isso.
  - *Tabs/segmented control no header de cada tela*: ocuparia espaço útil
    da página e não dá a sensação de "espaço de trabalho separado" que o
    usuário pediu.
  - *Implementar tudo em uma fase (UI + filtros de dados)*: como o
    critério de separação dos dados ainda não está definido pelo
    negócio, isso travava o trabalho. Separar em fases libera a UI já
    e deixa o filtro pra quando a regra estiver clara.

- **Impacto**
  - Novos arquivos: `src/lib/agentProfiles.js` (definição central dos
    perfis + helpers de persistência), `src/components/AgentProfileSwitcher.jsx`
    (botão + dropdown), `src/components/InscricaoScopeBanner.jsx` (banner
    da Fase 1).
  - `src/components/Sidebar.jsx`: deixa de ter `NAV_ITEMS` fixa, recebe
    `activeProfile` e `onProfileChange` por props.
  - `src/App.jsx`: roteamento passa a depender do par `(profileId, pageId)`;
    as 4 abas do perfil Inscrição (`inscricao-matriculas`,
    `inscricao-dashboard`, `inscricao-feedback`, `inscricao-funil`)
    renderizam wrappers com banner + componente existente.
  - CSS em `src/App.css`: novas classes `.profile-switcher`,
    `.profile-switcher-trigger`, `.profile-switcher-dropdown`,
    `.profile-switcher-item`, `.inscricao-scope-banner`.
  - Para adicionar um terceiro perfil no futuro: basta acrescentar
    entrada em `PROFILES` no `agentProfiles.js` (sem mexer em Sidebar
    ou App.jsx).

---

### 2026-05-28 - Fase 2 perfis: filtro client-side por escopo Kommo

- **Decisão**
  - Cada componente que precisa filtrar por agente recebe a prop
    `kommoScope = { pipelineId, statusIds }` quando renderizado dentro
    do perfil Agente Inscrição. Quando a prop é null (perfil Atendimento
    ou contexto sem perfil), comportamento é IDÊNTICO ao anterior — sem
    filtro algum.
  - Helper compartilhado em `src/lib/funnelScope.js`:
    - `buildFunnelUrl(scope)` — monta `/api/scheduler/funnel?pipelineId=X&statusIds=Y,Z`
    - `fetchScopedFunnel(scope)` — chama o endpoint e devolve `Set<leadIds>`
    - `useScopedLeadIds(scope)` — hook React que recarrega quando o scope muda
  - Aplicação por tela do perfil Agente Inscrição:
    - **Funil Kommo (Inscrição)**: passa o scope no fetch — backend
      devolve leads dos 2 status (`106804680` + `106426128`)
    - **Feedback IA**: filtra avaliações cujo `lead_id` está no
      `Set<leadIds>` retornado pelo funil do scope
    - **Dashboard**: filtra execuções com `getExecutionLeadId(exec)`
      (extrai leadId dos `steps` que fazem lookup Kommo) e mantém só
      as que estão no `Set<leadIds>`
    - **Execuções**: mesmo `ExecutionViewer.jsx` do perfil Atendimento,
      mas recebendo `kommoScope` → aplica o mesmo filtro que o
      Dashboard antes dos demais filtros (status/feedback/tools/etc.)
    - **Matrículas**: sem filtro adicional — toda matrícula registrada
      já é resultado do agente de inscrição por natureza
  - Banner `InscricaoScopeBanner` removido das 4 abas (componente foi
    mantido no repo caso seja útil em outras situações futuras).

- **Backend (única mudança aditiva)**
  - `server.js` → `/api/scheduler/funnel` agora aceita query params
    OPCIONAIS `?pipelineId=X&statusIds=Y,Z`. Quando ausentes, usa
    `KOMMO_AGENT_PIPELINE_ID`/`KOMMO_AGENT_STATUS_ID` do `.env`
    (comportamento original). Quando presentes, busca leads de cada
    status via `listLeadsByStatus` (1 GET por status) e concatena.
  - Endpoint continua **read-only** no Kommo — sem PATCH, sem mover
    lead, sem mensagem. Sem efeitos colaterais em schedulers, Redis,
    Supabase ou WhatsApp.
  - Resposta inclui campos novos no `config`: `effectivePipelineId`,
    `effectiveStatusIds`, `scoped` (boolean).

- **Contexto**
  - Pipeline AGENTE-SUMARÉ é único; agentes diferentes operam em
    colunas (status) diferentes. Para separar visualmente os dados
    no painel, basta filtrar pelos status_ids correspondentes a cada
    agente.
  - Status IDs foram descobertos manualmente pelo consultor via
    DevTools do Kommo (resposta `/api/v4/leads/pipelines/13756724`).

- **Alternativas descartadas**
  - *Coluna nova na tabela `ai_rule_evaluations` armazenando
    `status_id_at_eval`*: mudança de schema, requer migration,
    afeta backfill. Filtragem client-side é mais simples e suficiente.
  - *Endpoint novo `/api/scheduler/funnel/inscricao`*: duplicaria
    código sem ganho — o original já recebe os dois IDs como
    parâmetros, mais limpo.

- **Impacto**
  - Mudança no backend é **aditiva e retroativa-compatível**: 100%
    do tráfego atual (sem query params) continua idêntico.
  - Aumento marginal de uso da API Kommo: ao abrir "Funil Kommo
    (Inscrição)", o painel faz 2 GETs em vez de 1 a cada 10s. Ainda
    bem dentro do rate limit (7 req/s do Kommo).
  - Nenhum env novo necessário; status IDs ficam em
    `src/lib/agentProfiles.js` (constantes exportadas).
  - Rollback trivial: `git revert` do único commit afeta apenas a
    feature nova; o resto continua funcionando.

---

### 2026-05-28 - Redesign da tela "Execuções" (filtros + reorganização visual)

- **Decisão**
  - Reorganizar `src/components/ExecutionViewer.jsx` mantendo a estrutura de
    painel duplo (lista à esquerda, detalhe à direita) e adicionar:
    1. Barra de filtros com `status` (todos/sucesso/erro), `feedback`
       (todos/👍/👎/sem), `tools` (todos/com/sem), `período`
       (todos/hoje/7d/30d) e `ordenação` (mais recente/antigo/demorado).
    2. Stat-cards no topo: total, erros, tempo médio, tokens totais.
    3. Cards da lista com hierarquia visual revisada (status + tempo
       relativo no topo, mensagem em destaque, ID + duração + tools no
       footer).
    4. Agrupamento da lista por data (Hoje / Ontem / Esta semana /
       Este mês / Mais antigos) com headers sticky.
    5. Toolbar do header: ações destrutivas (Limpar) separadas
       visualmente das demais; botões de Reindexar FAQ ficam em
       grupo secundário (visual mais discreto).

- **Contexto**
  - Tela tinha apenas busca textual por ID/mensagem, sem filtros por
    status, feedback, presença de tools ou período. Consultor relatou
    "conversas sem filtro e bem desorganizado".
  - Header misturava ações de Reindexar FAQ com Atualizar/Limpar no
    mesmo nível visual, dificultando localizar a ação desejada.

- **Alternativas descartadas**
  - *Apenas adicionar filtros sem mexer no layout*: resolveria 1/2 do
    problema relatado; ficaria visualmente igual.
  - *Refactor maior (tabela, drawer modal para detalhe, export CSV,
    bulk delete)*: sairia do padrão das outras telas
    (Conversas, FeedbackIA), mais risco de regressão.

- **Impacto**
  - Sem alterações em backend, contrato de `executionStore` ou
    `executionFeedbackStore`. Filtragem/ordenação 100% client-side
    sobre o array já carregado.
  - CSS novo em `src/App.css`: `.exec-stats`, `.exec-stat-card`,
    `.exec-filters`, `.exec-filter-group`, `.exec-segmented`,
    `.exec-group-header`. Reaproveita variáveis e tokens existentes.
  - Padrão de filtros (segmented control) fica como referência para
    aplicar nas demais telas que listam dados (FeedbackIA, Conversas,
    Matrículas) se necessário no futuro.

---

### 2026-05-28 - Desistência de inscrição (sem interesse) → fila 143

- **Decisão**
  - Quando o agente já apresentou o curso, tirou dúvidas e o lead declara
    que **não quer seguir com a inscrição**, o fluxo servidor
    (`tryHandleInscricaoDesistenciaFlow`) intercepta antes do LLM:
    1. Pergunta canônica de confirmação (outros cursos, consultor, ou
       confirmar desistência).
    2. Se o lead confirma → agradece, pausa IA, grava
       `sum_Motivo da perda = "Sem Interesse"` e move para
       `pipeline=13756724 / status=143`.
  - Se o lead volta atrás ("quero me inscrever", "mudei de ideia") → limpa
    status e deixa o fluxo normal continuar.
  - Não roda durante matrícula ativa (form, polo, aceite contrato, etc.).

- **Contexto**
  - Leads que desistem após tirar dúvidas ficavam no funil de atendimento IA
    sem registro formal de perda no Kommo.

- **Alternativas descartadas**
  - *Deixar só o LLM decidir*: inconsistente; sem PATCH no campo enum nem
    movimentação garantida.

- **Impacto**
  - Env: `INSCRICAO_DESISTENCIA_ENABLED`, `KOMMO_DESISTENCIA_STATUS_ID=143`,
    `KOMMO_DESISTENCIA_PIPELINE_ID=13756724`.
  - Estados: `aguardando_confirm_desistencia`, `desistencia_concluida`.

---

### 2026-05-28 - Pós-matrícula: agradecimento + mover lead para fila de instruções

- **Decisão**
  - Quando o lead envia o comprovante de pagamento (imagem ou texto
    canônico) APÓS o link de contrato, o agente:
    1. Agradece a matrícula e informa que as instruções para iniciar o
       curso serão encaminhadas em breve (texto canônico atualizado em
       `buildComprovantePagamentoRecebidoReply`).
    2. Cria nota Kommo com o comprovante e o destino.
    3. **Move o lead** via `updateLeadPipelineStatus` para a fila
       pós-matrícula `pipeline=13756724 / status=106426128`
       (envs `KOMMO_POS_MATRICULA_PIPELINE_ID` /
       `KOMMO_POS_MATRICULA_STATUS_ID`).
  - **Substitui** a chamada anterior de `runDistribuirHumano` (que
    distribuía para consultor de vendas) — lead matriculado não precisa
    mais de consultor de vendas, só de quem distribui instruções de
    início de curso.

- **Contexto**
  - Antes, o lead matriculado caía na rotina de distribuição comercial
    (resumo IA + escolha de consultor de vendas + tabela
    `distribuicao_por_consultor`), o que era desperdício: ele já tinha
    fechado matrícula, não precisava mais ser tratado como prospect.
  - Negócio quer uma fila dedicada para "alunos matriculados aguardando
    instruções para iniciar o curso", visível no CRM.

- **Alternativas descartadas**
  - *Manter `runDistribuirHumano` e adicionar a movimentação*:
    duplicava trabalho e o lead acabaria com dois donos (consultor
    comercial + fila pós-matrícula).
  - *Mover sem nota Kommo*: perderia rastreabilidade (auditoria do
    comprovante recebido + razão da movimentação).

- **Impacto**
  - Reply mais coerente com o estado real do lead.
  - Fila pós-matrícula passa a receber 100% dos leads que mandam
    comprovante via WhatsApp.
  - Se o `id_lead` não estiver disponível em `dados_cliente_sum`, o
    código loga warning e **não move** (degrada graceful, não quebra a
    resposta ao lead).
  - Configurável por env para mover destino sem redeploy.

---

### 2026-05-28 - Inscrição express via dados do card Kommo (Sumaré Comercial)

- **Decisão**
  - Quando o card Kommo já tem todos os campos `sum_*` preenchidos
    (`sum_Nome`, `sum_CPF`, `sum_Email`, `sum_Curso`, `sum_Polo`,
    `sum_Data_Nascimento`, `sum_Modalidade`), o agente **pula o Form
    Sumar** e cria a candidatura direto via API Sumaré. Implementado em
    [server/inscricaoKommoPreFilledFlow.js](server/inscricaoKommoPreFilledFlow.js)
    e plugado no `agentRunner.js` antes do `tryHandlePoloPreFormFlow`.
  - **UX `ux_confirma = express`**: sem etapa "confirma seus dados?" —
    aproveita o card como fonte de verdade.
  - **UX `ux_inscrito = criar_novo`**: mesmo com `sum_Status_Inscricao =
    "Inscrito"`, cria nova candidatura (decisão de negócio: API decide o
    que fazer com duplicação).
  - **UX `polo = confirma_polo`**: antes de criar a candidatura, agente
    pergunta ao lead "quer manter `<sum_Polo>` como polo?". Novo estado
    `aguardando_confirm_polo_kommo`. Lead pode confirmar ("sim", "isso",
    "manter"), declinar ("não", "trocar polo") ou citar outro polo direto.
  - **Campos obrigatórios `sim_obrigatorios`**: se faltar `sum_Data_Nascimento`
    OU `sum_Modalidade` no card, NÃO tenta express — cai no Form Sumar
    tradicional.
  - **Loop scheduler**: captação falhada (curso indisponível, dados
    inválidos) agora grava `inscricao_form_status = distribuir_consultor`
    (novo estado terminal). Antes, o pipeline pós-form deixava o lead em
    `aguardando_distribuicao_form` para sempre — o scheduler reprocessava
    a cada tick (caso CAIO SILVA #23608285).
  - **Espelhamento Kommo → Supabase**: módulo
    [server/kommoCardMirror.js](server/kommoCardMirror.js) grava o
    snapshot do card nas colunas `kommo_*` de `dados_cliente_sum` com
    TTL de 5 min (evita PATCH a cada turno).

- **Contexto**
  - Caso CAIO SILVA #23608285: card completo, mas agente perguntou polo,
    mandou Form Sumar e entrou em loop no scheduler quando a API Sumaré
    rejeitou "Pedagogia" (indisponível para inscrição automática). Lead
    sem resposta + scheduler queimando ciclos.
  - Vários canais comerciais da Sumaré já populam o card antes do lead
    chegar no WhatsApp — manter Form Sumar como única porta de entrada
    duplicava trabalho e introduzia pontos de falha.

- **Alternativas descartadas**
  - *Confirmar dados genérico ("Você é X, CPF Y? confirma?")*: aumenta
    fricção; trade-off de "dado errado no card" fica com o canal que
    populou o card (responsabilidade já existente).
  - *Polo `sim_pular` (não perguntar)*: rejeitado pelo negócio — o polo
    é informação que o lead pode ter mudado de ideia desde o cadastro
    inicial; vale uma confirmação rápida.
  - *Polo `sempre_pergunta` (ignora `sum_Polo`)*: ignorar a informação
    do card aumentaria atrito; melhor confirmar.
  - *Campos `nao_sei` (deixar API decidir)*: cria mais loops para
    `distribuir_consultor` em casos triviais que o card já indicava
    incompletos.
  - *Migration via REST direto*: PostgREST não aceita DDL puro; precisa
    da RPC `exec_sql`. Caminho híbrido: arquivo `.sql` versionado +
    aplicador via REST (com bootstrap manual UMA VEZ no painel
    Supabase). Arquivos em [scripts/sql/](scripts/sql/).

- **Impacto**
  - Lead com card completo: matrícula em 1-2 turnos (vs. 4-5 turnos via
    Form Sumar). Reduz drop-off durante o preenchimento.
  - Scheduler para de queimar ciclos em leads com curso indisponível.
  - Migration adiciona 10 colunas em `dados_cliente_sum` (`kommo_*`,
    `polo_inscricao_escolhido`, `captacao_unidade`, `id_lead`, `teste_ab`
    — essas 2 últimas já eram usadas pelo código mas inexistentes na
    tabela, silent fail).
  - Feature flag `INSCRICAO_KOMMO_CARD_EXPRESS_ENABLED=true` (default).
    Para desligar: `false` no env.
  - Pré-requisito manual: aplicar [scripts/sql/00_bootstrap_exec_sql.sql](scripts/sql/00_bootstrap_exec_sql.sql)
    no Supabase Studio (uma vez), depois `node scripts/apply-sql-rest.mjs
    scripts/sql/dados_cliente_sum_kommo_mirror.sql`. Sem isso o código
    continua funcionando (cai no Form Sumar), mas o fluxo express não
    ativa.

---

### 2026-05-27 - Link enviado ao candidato sempre na tela `/contrato` (ASSINAR CONTRATO)

- **Decisão**
  - `resolvePortalUrlForCandidato` em [server/sumareCaptacaoClient.js](server/sumareCaptacaoClient.js)
    passa a devolver **sempre** a URL `/vem-pra-sumare/vestibular/contrato?id=…`
    (tela "Termos de Contrato → Clique para abrir → Li e concordo → ASSINAR
    CONTRATO"), independentemente do `status` do candidato na API Sumaré.
  - O campo `phase` (`'contrato' | 'pagamento'`) é mantido apenas como
    telemetria — útil em logs/notas para entender em que fase a API estava,
    mas não muda a URL enviada.
  - O ponto de override do `extractUrlFromPayload` foi invertido: quando a
    API devolve uma URL `meioPagamento` no payload de aceite, ela é
    substituída pela URL `/contrato`.

- **Contexto**
  - Antes, quando o candidato voltava após já ter aceitado o contrato
    (`status="meioPagamento"`), o agente enviava direto o link
    `/meioPagamento?id=…`. Caso real lead #23841399 (notas 16:57 e 17:30).
  - Negócio prefere fluxo único: o candidato sempre cai na tela "ASSINAR
    CONTRATO", que **já redireciona** para pagamento quando o aceite está
    OK. UX mais previsível e instruções padronizadas ("acesse o link, leia
    e clique em ASSINAR CONTRATO").

- **Alternativas descartadas**
  - *Manter dois links*: aumentava bifurcação no prompt e nas mensagens —
    cada caso exigia copy diferente; já tínhamos relatos de candidatos
    "perdidos" ao receber `/meioPagamento` sem contexto.
  - *Adicionar flag de env (`SUMARE_PORTAL_ALWAYS_CONTRATO`)*: optei por
    fixar o comportamento direto, sem flag, porque é o caminho que o
    negócio quer em 100% dos casos.

- **Impacto**
  - Toda mensagem com link de contrato (captacaoInscricaoExistenteFlow,
    inscricaoAceitePagamentoFlow, matriculaCaptacaoPipeline) passa a usar
    `/contrato?id=…`.
  - Status persistido no Supabase (`captacao_contrato_link`) também passa
    a guardar a URL canônica.
  - Cobertura de testes: seção 9 em `scripts/test-inscricao-flow.mjs`.

### 2026-05-27 - Mirror obrigatório de `inscricao_form_status` a partir do reply do agente + fallback via notas Kommo

- **Decisão**
  - Adicionar **auto-sync de estado** em `server/inscricaoStateAutoSync.js`:
    sempre que o reply final do agente contiver texto canônico de transição
    (detectado por `assistantAskedPoloPreFormChoice`), gravar o
    `inscricao_form_status` correspondente no Supabase **antes** de enviar
    a mensagem ao lead. Idempotente; não rebaixa estados terminais/avançados
    (`aguardando_form_sumar`, `aguardando_distribuicao_form`,
    `aguardando_aceite_contrato`, `form_sumar_concluido`,
    `comprovante_pagamento_recebido`).
  - Adicionar **fallback via notas Kommo** em
    `tryHandlePoloPreFormFlow`: quando histórico está vazio e status é
    null, consultar as últimas 6 notas do lead no Kommo e, se alguma casar
    com `assistantAskedPoloPreFormChoice`, tratar como
    `aguardando_escolha_polo_pre_form`. Só ativa quando a mensagem do lead
    "parece polo" (`matchPoloFromUserMessage` retorna polo válido).
  - Adicionar **retry com backoff** em `appendChatMemory` (200ms, 600ms)
    para 408/425/429/5xx, reduzindo `n8n_chat_histories` vazio por falha
    transitória.
  - Adicionar **log estruturado** `INSCRICAO_CTX stage=… polo=… historyLen=…
    historySource=… lastAssistLen=… polo_signal_in_lastAssist=…` no
    `agentRunner` para tornar visível a causa quando o fluxo pára.

- **Contexto**
  - Caso real lead #23841399 ("William testest"): lead respondeu "5" após
    o agente perguntar polo, mas não houve resposta. Investigação mostrou
    `n8n_chat_histories` e `chat_messages_sum` ambos vazios para o
    telefone; `inscricao_form_status` = NULL no Supabase. Cronologia:
    `lead "matricula" → LLM responde com lista de polos (sem chamar tool)
    → status fica NULL → lead "5" → tryHandlePoloPreFormFlow encontra
    status=NULL e lastAssist="" → retorna null → mensagem cai no LLM sem
    contexto → silêncio.`
  - Diagnóstico confirmou que **TODAS** as notas do Kommo têm sufixo
    `- EX-…` (não há outro Salesbot externo conflitando). O problema é
    estrutural: depender do histórico para sustentar o estado quando o
    LLM responde diretamente, sem tool.

- **Alternativas descartadas**
  - *Importar OUTBOUND do Kommo no `n8n_chat_histories`*: cogitada na
    primeira hipótese (existe outro Salesbot externo). Descartada após
    confirmar que todas as notas têm sufixo `- EX-…` — são do próprio
    agente. Implementar isso seria duplicar o mecanismo de gravação.
  - *Forçar o LLM a sempre chamar a tool `enviar_form_sumar_inscricao`*:
    aumentaria a complexidade do prompt sem garantir 100% de obediência.
    O guard de saída já cobre a regressão "afirmou sem tool"; o auto-sync
    fecha o gap de "perguntou sem tool".
  - *Espelhar estado no card Kommo (`sum_Status_Inscricao`)*: já é feito
    em outros pontos, mas exige round-trip ao Kommo a cada turno; muito
    caro para ser a fonte primária.
  - *Gravar histórico ANTES do envio do WhatsApp*: introduziria histórico
    "fantasma" se o envio falhasse. Retry com backoff resolve o caso
    transitório sem esse risco.

- **Impacto**
  - **Resiliência:** o próximo turno do lead passa a ser processado
    corretamente mesmo se o histórico estiver vazio (race, falha de
    gravação, reset, TTL). O estado persistido no Supabase passa a ser a
    fonte primária de decisão; o histórico vira apoio.
  - **Telemetria:** logs `INSCRICAO_CTX` e `INSCRICAO_STATE_AUTO_SYNC`
    permitem diagnosticar regressões futuras em 1 grep no EasyPanel.
  - **Compatibilidade:** auto-sync é idempotente e não rebaixa estados
    avançados; fallback de notas só ativa quando mensagem "parece polo".
    Nenhum caminho existente foi alterado em seu comportamento default.
  - **Cobertura de testes:** seção 8 em `scripts/test-inscricao-flow.mjs`
    valida `detectStateFromReply` para reply canônico, com sufixo EX,
    neutro, vazio, e proteção de estados terminais.

### 2026-06-01 - Cap de idade em findLastFormularioSumSentMs (loop pós-formulário)

- **Decisão**
  `findLastFormularioSumSentMs` passou a aceitar `{ maxAgeMs, nowMs }`
  opcionais. Em `detectFormSumarRecebidoNoKommo`
  (`server/inscricaoPostFormPipeline.js`) a referência do "formulário
  enviado" é capada por `INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H` (default 48h):
  nota de formulário fora da janela NÃO ancora mais a detecção por eventos
  de campo nem por snapshot.

- **Contexto**
  Lead #23841399 ficava mudo após cada reset. Diagnóstico (via API Evolution
  + memória Supabase): o Evolution recebia as mensagens normalmente na
  instância ativa `SUMARE_IA` (webhook ON, `MESSAGES_UPSERT`), mas o agente
  estava pausado (`atendimento_ia='pause'`, `inscricao_form_status=
  'distribuir_consultor'`). Causa: uma nota antiga `Salesbot Formulario_Sum
  ativado` (29/mai, ~69h) continuava servindo de âncora; como `formSentMs`
  era calculado sem limite de idade, o ramo de `custom_field_*_value_changed`
  recontava mudanças de campo do card (inclusive pós-reset) e re-detectava
  "formulário recebido" → tentativa de matrícula falha (dado de teste) →
  pausa da IA. Loop a cada reset.

- **Alternativas descartadas**
  - *Apagar a nota antiga no Kommo a cada reset*: frágil (depende de permissão
    e de varrer notas), não resolve o caso real de produção com notas legadas.
  - *Reduzir o cap global de `maxAgeMs` da detecção*: afetaria a janela do
    loop de notas legítimo (resposta de flow que chega horas depois).
  - *Capar dentro de `findLastFormularioSumSentMs` por padrão*: mudaria o
    comportamento de `postFormSendGuard.js`, que quer a última referência
    independente da idade. Por isso o cap é opt-in via parâmetro.

- **Impacto**
  - Pós-formulário não re-dispara sobre formulário fora da janela; fim do
    loop de pausa após reset. Caminho legítimo (form enviado e respondido
    dentro de 48h) intacto — o loop de notas recentes continua detectando.
  - `postFormSendGuard.js` inalterado (cap opt-in).
  - **Testes:** `scripts/test-form-notes-age-cap.mjs`
    (`npm run test:form-notes-age-cap`, 6/6) cobre sem cap, nota velha
    ignorada, nota recente mantida, mistura, sem nota e cap desativado.
    Suíte `test:inscricao-flow` segue 139/139.

---

### 2026-06-02 - Agente como porta principal do inbound (override de webhook na Meta)

- **Decisão**
  - Tornar o **agente a porta principal** de recebimento das mensagens da Meta,
    repontando o **override de webhook no nível do NÚMERO** (`794200977108142`)
    para `https://banco-agente-sumare.6tqx2r.easypanel.host/api/whatsapp/webhook`.
    O override de número tem prioridade sobre WABA e sobre o callback do app, então
    o n8n deixa de receber este número (a ser desativado pelo cliente — só limpeza).
  - Produção: `WHATSAPP_OUTBOUND_MODE=cloud` (respostas direto pela Cloud API,
    sem depender da Evolution) e `WHATSAPP_APP_SECRET` setado com o secret real
    do app `978458407905051` (valida `X-Hub-Signature-256`).
  - Scripts: `scripts/meta-repoint-webhook.mjs agent|n8n|status` (repoint +
    rollback), `scripts/ep-set-env.mjs` (env genérico), `scripts/diag-app-webhook.mjs`
    e `scripts/diag-waba-subscribers.mjs` (diagnóstico de topologia de webhook).

- **Contexto**
  - Diagnóstico definitivo: TODO o inbound do WhatsApp entrava primeiro no **n8n**
    (callback da WABA e override do número apontavam para o n8n), que era o
    roteador único e só repassava alguns leads à Evolution → agente. Por isso
    leads reais do funil (ex.: #23875217, #23583611) não eram atendidos enquanto
    outros (ex.: #23841399) eram. n8n, Evolution e agente usam o MESMO app Meta.
  - Limites rígidos da Cloud API: não há API para "puxar" inbound (só webhook);
    **um callback por objeto/app**; o override do número *substitui*, não soma.
    Logo, "uma camada extra paralela" só com o mesmo app é impossível — exigiria
    um 2º app inscrito na WABA. O cliente optou por agente principal + desligar n8n.

- **Alternativas descartadas**
  - Ajustar a lógica de roteamento dentro do n8n: mais cirúrgico e preservaria
    todas as funções do n8n, mas exigia acesso ao n8n (não disponibilizado).
  - 2º app Meta inscrito na WABA (entrega paralela real): exigia id+secret de um
    app distinto, que não temos.
  - Relay (agente recebe e re-encaminha ao n8n): mantém n8n vivo, mas adiciona
    complexidade; o cliente preferiu desligar o n8n.

- **Impacto**
  - Inbound em tempo real direto Meta→agente; a regra de funil é preservada
    (o agentScheduler só responde leads nas pipelines/status configurados —
    `AGENT_FUNNEL_STATUS_IDS`). Outbound deixa de depender da Evolution.
  - **Ponto único de entrada:** se o agente cair, não há fallback (n8n não recebe
    mais). Mitigação: redeploy estável + rollback imediato via
    `node scripts/meta-repoint-webhook.mjs n8n`.
  - **Validar** com mensagem real do número de teste (texto → áudio → imagem →
    resposta) e confirmar `lastBufferWrite`/`lastSyncOutcome` em
    `GET /api/evolution/health` antes de o cliente desligar o n8n.
  - **Validado em 02/06**: mensagem real do lead #23841399 chegou direto da Meta
    (`event=meta_webhook`, `outcome=buffer_ok`, `5511944690752@s.whatsapp.net`)
    e o agente respondeu. Webhook nativo confirmado em produção.

---

### 2026-06-02 - Desligar o poll de inbound do Kommo (Meta vira fonte única)

- **Decisão**
  - `KOMMO_INBOUND_POLL_ENABLED=false` em produção. Com o webhook nativo da Meta
    repontado para o agente, o poll do Kommo (notes/events) virou redundante.

- **Contexto / causa raiz de um LOOP**
  - O lead #23841399 entrou em loop de handoff: a cada poucos minutos surgia a
    nota `Encaminhamento automático: lead pediu atendimento humano via WhatsApp
    (agente IA).` e o agente respondia "um consultor entrará em contato".
  - Origem: essa nota é escrita pelo PRÓPRIO agente em `distribuirHumanoTool.js`
    (handoff humano) como `note_type:common` SEM o sufixo `EX-<execId>`. O poll
    de **notas** do Kommo não a reconhecia como outbound (o filtro de outbound
    usa o sufixo `EX-`), então re-ingeria a nota como se fosse mensagem do lead
    → novo handoff → nova nota → loop. Confirmado na memória
    (`human: "ola Encaminhamento automático…"`). O loop começou 18:54Z,
    ANTES do repoint, descartando o webhook como causa.

- **Alternativas descartadas**
  - Filtrar no poll as notas autorais do agente (ex.: prefixo "Encaminhamento
    automático"/"Inscrição – salesbot"): trata o sintoma e ainda deixaria o poll
    duplicando mensagens que agora também chegam pela Meta.
  - Adicionar sufixo `EX-` às notas de handoff: arriscado (várias notas/sistemas)
    e não resolve a duplicação Meta×poll.

- **Impacto**
  - Inbound passa a ter **fonte única** (webhook Meta), sem loop e sem
    duplicação. Rollback: `KOMMO_INBOUND_POLL_ENABLED=true` (volta o poll).
  - O problema antigo de mensagens só visíveis no canal nativo do Kommo (amojo)
    deixa de exigir o poll: o webhook Meta recebe todas as mensagens do número.

---

### 2026-06-03 - RESOLVIDO: "NULL CANDIDATO" era código de unidade (polo) errado

- **Causa raiz real (NÃO era bug externo do Lyceum)**
  - O catálogo `libShared/sumarePoloCatalog.js` tinha códigos de `unidade` errados:
    Barra Funda=`ED_SP_P2`, São Miguel=`ED_SP_P1`, Tatuapé=`ED_SP_P3`,
    Santana=`ED_SP_P4`, e um polo inexistente (Pinheiros=`ED_SP_P5`).
  - Esses códigos não têm oferta no Lyceum → o `gerar` retornava HTTP 500
    "Cannot insert NULL into column CANDIDATO".
- **Mapeamento correto (confirmado pela Sumaré em 03/06)**
  - Barra Funda=`ED_SP_P5` · Santo Amaro=`ED_SP_P6` · Tatuapé=`ED_SP_P7` ·
    Santana=`ED_SP_P8` · São Miguel=`ED_SP_P9`. (Pinheiros removido; Santo Amaro
    deixou de ser "polo indisponível".)
- **Validação**
  - `gerarCandidatoIngresso` com `curso=JORN_EAD` e unidade `ED_SP_P5..P9`
    retorna **HTTP 200** para todos. Matrícula de graduação volta a funcionar.
- **Mudanças**
  - `libShared/sumarePoloCatalog.js`: catálogo corrigido + Santo Amaro adicionado.
  - `server/inscricaoPostFormPipeline.js` (`preparePoloStepAfterForm`): passa a
    preferir o código de unidade do catálogo ao valor salvo no Supabase
    (auto-cura leads antigos com código defasado).
  - Lead #23875607 (Tamires): `captacao_unidade` corrigido para `ED_SP_P5`.
- **Pendência**: endereço do polo Santo Amaro (ficou em branco no catálogo).

---

### 2026-06-02 - [SUPERADO] Suspeita de erro externo (Lyceum/Captação) na graduação

- **Sintoma**
  - Candidato preenche o formulário, o agente DETECTA corretamente (eventos de
    campo do Kommo + snapshot válido) e tenta a matrícula, mas o lead trava em
    `inscricao_form_status=distribuir_consultor` + `atendimento_ia=pause` e só
    recebe "Um consultor entrará em contato" em vez de concluir a inscrição.
    Casos: #23875607 (Jornalismo), #23608285 (CAIO).

- **Causa raiz (externa, lado Sumaré)**
  - `GET https://api-captacao.sumare.edu.br/api-ingresso/candidato/gerar`
    retorna **HTTP 500** com:
    `com.microsoft.sqlserver.jdbc.SQLServerException: Cannot insert the value
    NULL into column 'CANDIDATO', table 'LYCEUM.dbo.TSCU_INSCRICAO_FINANCEIRO_CANDIDATO'`.
  - Nossos params são válidos e completos (CPF, e-mail, nascimento, unidade,
    curso). O erro ocorre no INSERT do financeiro do Lyceum — o id do CANDIDATO
    volta NULL no lado deles.

- **Testes feitos (02/06, todos 500 NULL CANDIDATO)**
  - `curso` com/sem EAD: `JORN_EAD`, `JORN`, `Jornalismo`, `Jornalismo EAD`,
    `JORNALISMO`, `JORN_EAD_EAD`.
  - `tipoIngresso`: Vestibular, Vestibular Online/Agendado, Processo Seletivo,
    ENEM, Transferencia, Prova Agendada.
  - `planoPgto`: vazio, `1`, `30`.
  - Outros cursos de graduação: `ADM`, `ADM_EAD`, `ADS_EAD` → mesmo erro.
  - Conclusão: NENHUM parâmetro que controlamos resolve. É falha sistêmica do
    endpoint de graduação. A PÓS funciona porque usa outro fluxo (não passa por
    `gerarCandidatoIngresso`/Lyceum).

- **Decisão**
  - Acionar a Sumaré/Lyceum: confirmar se a oferta/processo seletivo/plano de
    pagamento de graduação EAD está habilitado para inscrição via API e por que
    o `CANDIDATO` retorna NULL no INSERT do financeiro. Sem correção do lado
    deles, o agente continua detectando o formulário e encaminhando ao consultor
    (comportamento de fallback atual, correto).
  - Após a Sumaré corrigir, reprocessar os leads travados com
    `scripts/proceed-inscricao.mjs`.

- **Alternativas descartadas**
  - Variar curso/tipoIngresso/planoPgto no nosso lado: testado, não resolve.
  - Mudar mapeamento de código de curso: o erro é idêntico para todos os códigos.

### 03/06 - Handoff indevido em negação + datas de pagamento respondidas pela base

- **Decisão**
  - Tratar negação no handoff: nova `messageRefusesHumanHandoff()` em
    `libShared/scopeHeuristics.js`, usada como guarda no início de
    `messageStrongHumanEscalation()` e `messageRequestsHuman()`. Frases como
    "não quero falar com consultor", "não precisa de consultor" deixam de
    disparar o `shouldHandoffToHuman` determinístico (linha 736 do agentRunner).
    A guarda preserva o caso "não quero robô, quero humano" (continua escalando).
  - Perguntas sobre forma/datas de pagamento: nova `messageAsksPaymentInfo()`
    em `libShared/inboundMessageSanitize.js` + `paymentInfoHint` no `agentRunner`
    que OBRIGA `buscar_conhecimento` do plano de pagamento e PROÍBE encaminhar a
    consultor só por causa de datas/forma de pagamento (a info está na base).

- **Contexto**
  - Lead 23841399: candidato escreveu "não quero falar com consultor, me fale
    aonde vai ser as aulas" e o agente encaminhou ao consultor mesmo assim
    (regex `falar...consultor` casava sem olhar a negação → handoff determinístico).
  - No mesmo lead, ao perguntar "qual as datas para pagamento?", o agente
    deflectia para consultor em vez de usar o PLANO DE BENEFÍCIO PARA PAGAMENTO
    já cadastrado em `grad_info`/`pos_info`.

- **Alternativas descartadas**
  - Resolver só via regra/prompt do LLM: o handoff era determinístico, então a
    correção precisa ser no heurístico (regra sozinha não impediria).
  - Ampliar `messageAsksCoursePrice` para cobrir datas: conflataria preço com
    forma de pagamento; criada heurística dedicada.

- **Impacto**
  - Negação explícita de consultor não dispara mais encaminhamento automático.
  - Pergunta sobre datas/forma de pagamento passa a ser respondida com o plano
    de pagamento da base, sem encaminhar a consultor.

### 03/06 - "R$ null/mês" no portal = modalidade/turno errados na geração do candidato

- **Decisão**
  - A geração do candidato passa a enviar o código de curso E o `turno`
    coerentes com a modalidade REALMENTE ofertada (planilha oficial
    grad_preco/pos_preco como fonte de verdade):
    - EAD → código `_EAD` + `turno=EAD`
    - Semipresencial → código `_SEMI` + `turno=SEMIPRESENCIAL`
  - Novo `libShared/cursoModalidade.js` (modalidade↔turno) +
    `resolveCursoOfertaFromDb()` em `server/sumareCaptacaoCursoStore.js`
    (lê grad_preco/pos_preco para descobrir a modalidade ofertada e casa com o
    código do catálogo `sumare_captacao_curso`).
  - `buildGerarCandidatoQueryAsync` só SOBRESCREVE quando a oferta oficial é
    Semipresencial (caso quebrado); cursos EAD mantêm o mapeamento já validado
    (evita trocar `ADM_EAD` por variante `ADM_4_EAD`).

- **Contexto**
  - Lead 23841399 (Farmácia): candidato gerado como `FARM_EAD` + `turno=EAD`.
    Farmácia só é ofertada Semipresencial → a Sumaré não acha a oferta
    financeira e o INSERT em `LYCEUM.dbo.TSCU_INSCRICAO_FINANCEIRO_CANDIDATO`
    grava `CANDIDATO` nulo (HTTP 500) / o portal mostra `Valor: R$ null/mês`,
    travando boleto/PIX.
  - Sondagem confirmou: `FARM_SEMI`+`turno=SEMIPRESENCIAL` → HTTP 200 com
    `valorBoleto1dia=227.00` (igual à planilha/site). `HIST_SEMI`→107,
    `PED_SEMI`→117. `FARM_EAD`/`turno=EAD` e `FARM`+`SEMIPRESENCIAL` → 500.
  - Polos confirmados: Barra Funda=ED_SP_P5 etc. (já no catálogo de polos).

- **Alternativas descartadas**
  - "Bug sistêmico de graduação da Sumaré" (hipótese anterior do AGENT.md): a
    sondagem mostrou que graduação Semipresencial FUNCIONA quando enviamos a
    modalidade/turno certos; o 500 era combinação inválida do nosso lado.
  - Desativar linhas EAD no catálogo: não resolve os cursos sem código `_SEMI`
    e é manual; a planilha oficial é fonte de verdade melhor.

- **Impacto**
  - Cursos Semipresenciais com código `_SEMI` no catálogo passam a gerar
    candidato com valor correto (Farmácia, História, Pedagogia, Biomedicina,
    Geografia, Ed. Física Bacharelado, Matemática). Cursos EAD inalterados.
  - O candidato já criado do lead 23841399 (`FARM_EAD`) continua quebrado;
    precisa regerar com `FARM_SEMI` (ação de recuperação à parte —
    `scripts/recover-farm-semi.mjs`, executado: candidato 202630000001041, R$227).

### 03/06 - "Gap" de cursos Semipresenciais era falta de cadastro (códigos _SEMI)

- **Decisão**
  - Os códigos `_SEMI` desses cursos EXISTEM e funcionam na API Captação
    (sondados, retornam valor): foram cadastrados em `sumare_captacao_curso`
    via `scripts/add-captacao-semi-codes.mjs`:
    ENGP_SEMI(237), FISIO_SEMI(227), NUTR_SEMI(237), ARUB_SEMI(257),
    ENGC_SEMI(237), ENGE_SEMI(237), ENGM_SEMI(237), TSAMB_SEMI(147),
    SERV_SEMI(167). (ED_F_SEMI e LETR_SEMI já existiam.)
  - `resolveCursoOfertaFromDb`: o lookup da modalidade oficial passou a tolerar
    diferença de nome entre catálogo e planilha (ex.: "Serviço Social" x
    "Superior em Serviço Social") via inclusão mútua de chaves.

- **Contexto**
  - Mesmo forçando turno=SEMIPRESENCIAL, esses cursos davam R$ null porque o
    catálogo só tinha o código `_EAD` (e `_EAD`+turno EAD não tem oferta
    financeira para curso Semipresencial). Controle: `FISIO_EAD`+EAD → R$ null;
    `FISIO_SEMI`+SEMIPRESENCIAL → R$ 227.

- **Impacto**
  - Não há mais gap: todos os cursos Semipresenciais resolvem para o código
    `_SEMI` + turno=SEMIPRESENCIAL e geram valor correto.

### 09/06 - Grade curricular de todos os cursos no RAG (fallback grad_info)

- **Decisão**
  - Ingestão de **62 cursos/modalidades** com disciplinas em `grad_info`
    (`metadata.kind = grade_curricular`, IDs 70001–78999) via
    `scripts/register-grade-curricular-rag.mjs`.
  - Enquanto `grad_grade_curricular` + RPC `match_grad_grade_curricular` não
    existirem no Supabase, o agente busca via `match_grad_info`; o
    `knowledgeSearch.js` ignora 404 da RPC dedicada sem quebrar a busca.
  - Regra **30** em `agent_rules`: instrui o agente a usar CONTEXT de grade,
    citar disciplinas reais e oferecer PDF quando pedirem lista completa.
  - Formatação RAG: `knowledgeRowFormat.js` expande `metadata.disciplinas[]`
    em lista numerada quando `kind === grade_curricular`.

- **Contexto**
  - Scrape oficial (`data/grade-curricular-sumare.json`) cobre 68 entradas;
    6 sem grade no site (presencial Admin/Biomedicina/Contábeis/Pedagogia;
    semi Gestão Ambiental/Hospitalar).
  - `ensureGradGradeCurricularTable.mjs` falhou por falta de
    `SUPABASE_DB_PASSWORD` / `SUPABASE_ACCESS_TOKEN`.

- **Alternativas descartadas**
  - IDs 10001+ em `grad_info`: colidiam com linhas existentes do catálogo.
  - Bloquear ingestão até tabela dedicada: atrasaria o agente sem benefício
    imediato — `grad_info` já tem RPC e embedding.

- **Impacto**
  - Agente responde grade/disciplinas de qualquer curso com dados no site.
  - Próximo passo opcional: rodar `scripts/sql/grad_grade_curricular.sql` no
    SQL Editor e re-ingerir na tabela dedicada (`npm run register:grade-curricular-rag`).

### 16/06 - Match de oferta oficial por tokens (corrige alucinação de curso inexistente)

- **Decisão**
  - Em `libShared/cursoOfertaFilter.js`, `lookupOfertaModalidades` deixou de casar
    cursos por substring bidirecional e passou a casar por **tokens (palavras
    inteiras)** — subconjunto em qualquer direção.

- **Contexto**
  - Simulação local revelou que, para "vocês têm Medicina?", o `buscar_conhecimento`
    injetava no CONTEXT a linha falsa
    `[OFERTA OFICIAL — medicina: ... Semipresencial]`. Causa: `"biomedicina".includes("medicina")`
    fazia a query "medicina" herdar a modalidade de "biomedicina", e
    `buildOfficialOfferContextBlock` emitia uma oferta oficial inexistente. O LLM
    obedecia à instrução determinística e afirmava que a Sumaré oferece Medicina
    (4/4 nas iterações de teste, tanto na base quanto na versão editada).
  - Nenhum ajuste de prompt resolvia, pois o erro era determinístico no CONTEXT.
    Guard "CURSO FORA DO CATÁLOGO" adicionado ao orquestrador como reforço.

- **Alternativas descartadas**
  - Só fortalecer o prompt: insuficiente (o CONTEXT continuava afirmando a oferta).
  - Exigir match exato (`map.has`) para a query: perderia casos legítimos como
    `pedagogia` ↔ `pedagogia licenciatura`.

- **Impacto**
  - Linha falsa some do CONTEXT; agente passou a 4/4 corretas em "Medicina"
    (nega + oferece Biomedicina/Farmácia/Fisioterapia/Nutrição, regra 20).
  - Casos compostos legítimos seguem casando (`gestao rh` ↔ `gestao de rh`).

### 16/06 - Transferência/aproveitamento no orquestrador + fix de heurística acadêmica

- **Decisão**
  - Orquestrador (prompt, v6 no DB): incluída a ferramenta `registrar_transferencia`
    na lista de tools e no fluxo de decisão, com instrução explícita de NÃO usar
    `distribuir_humano` para transferência/aproveitamento (é ingresso comercial) e
    de reconhecer a fala coloquial ("vim de outra faculdade", "aproveitar matérias").
  - `libShared/academicAffairsHeuristics.js`: removido o `\b` final dos radicais
    financeiros em duas regex (`looksLikeCommercialEnrollment` linha do filtro
    financeiro e `messageAsksAcademicAffairsSupportInText` linha de inadimplência).

- **Contexto**
  - Bateria local: transferência caía em `distribuir_humano` ~1/3 das vezes porque
    o orquestrador reescrito não listava `registrar_transferencia` (embora a tool
    exista em `toolDefinitions.js` com boa descrição).
  - Novo cenário "aluno atual com dúvida acadêmica" revelou bug pré-existente: o
    `\b` ao final de `atrasad`/`inadimpl`/`negativad` nunca casava palavras reais
    ("mensalidade atrasada", "inadimplente"), então o caso financeiro de aluno ia
    para `distribuir_humano` em vez do redirecionamento acadêmico canônico.

- **Alternativas descartadas**
  - Expor `registrar_transferencia` só via descrição da tool (já existia): não
    bastava, o prompt empurrava para `distribuir_humano`.

- **Impacto**
  - Transferência/aproveitamento: 3/3 chamam `registrar_transferencia`.
  - Aluno acadêmico (trancamento, declaração, mensalidade atrasada, inadimplente):
    4/4 caem no redirecionamento acadêmico determinístico (Portal do Aluno /
    atendimento / ouvidoria).
  - Medicina e pós seguem corretos (sem regressão).

### 2026-06-16 - Api Sumaré em estágios avançados (inscrição / aguardando pagamento)

- **Decisão**
  - Expandir o funil da IA para incluir fila **aguardando pagamento** (`106426128`) **somente** quando `sum_Origem = Api Sumaré` e `API_SUMARE_ADVANCED_FUNNEL_ENABLED=true`.
  - **Sem template nem saudação proativa da IA** nessas filas — abertura fica nos salesbots Kommo **49977** (inscrição) e **49979** (aguardando pagamento).
  - A IA só atende **depois** da mensagem do lead no buffer (`flushSession` → `tryHandleApiSumareAdvancedEntry`): CPF no card → `gerar` → captação (inscrição) ou comprovante (pagamento).

- **Contexto**
  - Leads distribuídos pela API Sumaré chegam em inscrição/pagamento sem atendimento prévio da IA; o Kommo já dispara o salesbot ao entrar na fila.

- **Alternativas descartadas**
  - Template WhatsApp pela IA (`apiSumareEntryGreet`): redundante com salesbots 49977/49979.
  - Incluir toda a fila aguardando pagamento no funil: reativaria IA em leads que devem permanecer pausados após comprovante.

- **Impacto**
  - Módulos: `libShared/apiSumareOrigemHeuristics.js`, `server/apiSumareAdvancedEntryFlow.js`, `kommoAgentFunnelGate.js`.
  - `proactiveGreet` ignora leads Api Sumaré em inscrição/pagamento.

### 2026-07-21 - FAQ documentos/histórico para transferência + fix heurística acadêmica

- **Decisão**
  - Modelo usado: Opus (principal, orquestração — implementação delegada ao Executor).
  - Novo tópico FAQ `documentos_transferencia_dispensa` em `scripts/add-info-faq-sumare.mjs`,
    inserido em `grad_info` e `pos_info`: histórico/documentos de dispensa/aproveitamento são
    solicitados posteriormente para anexar na plataforma do aluno; a equipe da Sumaré analisa e
    responde; enquanto isso o lead aguarda finalização da matrícula e e-mail de primeiro acesso.
  - `libShared/academicAffairsHeuristics.js` (`looksLikeCommercialEnrollment`): expandido
    `dispensa de matéria` para também casar `dispensa de disciplina(s)`; adicionado check que
    trata histórico/comprovante/documentos como comercial (não acadêmico) quando aparecem no
    mesmo texto que transferência/aproveitamento/dispensa.
  - `server/ai/promptsLoader.js` (regra 31 — INGRESSO POR TRANSFERÊNCIA): acrescentado bloco
    orientando a IA a responder com a política da FAQ quando o lead perguntar quando/como entregar
    histórico/documentos para dispensa, sem redirecionar para Portal/atendimento acadêmico.

- **Contexto**
  - Lead Ítrio (#24133683) perguntou "não querem o meu histórico, comprovante de matrícula para
    a dispensa de disciplinas?" durante negociação de transferência. A heurística acadêmica
    (`messageAsksAcademicAffairsSupportInText`) casava `histórico escolar` mesmo quando o contexto
    era claramente de ingresso por transferência, disparando o redirect acadêmico indevido
    (regra 32) em vez de seguir o fluxo comercial da regra 31.

- **Alternativas descartadas**
  - Remover por completo o gatilho de `histórico escolar` da heurística acadêmica: quebraria o
    caso legítimo de aluno já matriculado/ex-aluno pedindo histórico (regra 32).

- **Impacto**
  - `messageAsksAcademicAffairsSupportInText('Mas não querem o meu histórico, comprovante de
    matrícula para realizar a dispensa de disciplinas?')` passa a retornar `false` mesmo com
    "histórico escolar" explícito no texto, sem regressão nos casos de aluno matriculado/ex-aluno
    (`declaração de matrícula`, `ex-aluno ... histórico escolar` continuam `true`).

### 2026-07-22 - FAQ formas de pagamento da mensalidade + fix LGPD cartão/PIX + separação do pagamento de matrícula

- **Decisão**
  - Modelo usado: Opus (principal, orquestração — implementação delegada ao Executor).
  - Novo tópico FAQ `formas_pagamento_mensalidade` em `scripts/add-info-faq-sumare.mjs`, inserido
    em `grad_info` (id=78647) e `pos_info` (id=88960): pagamento das mensalidades por boleto
    bancário, PIX ou cartão de crédito, com opção de escolher/alterar no Portal do Aluno; corpo
    deixa explícito que é sobre mensalidade (pós-matrícula), não sobre a taxa/link de matrícula.
  - `libShared/inboundMessageSanitize.js` (`messageAsksPaymentInfo`): adicionado guard
    `MATRICULA_PAYMENT_INTENT_RX` (verbo de pagamento a até 15 chars de matrícula/link
    contrato/taxa/inscrição, sem "mensalidade" no texto → `false`, deixa o fluxo de
    captação/inscrição responder). Extraída `messageAsksPaymentMethodOptions` (formas de
    pagamento, boleto/PIX/cartão, Portal do Aluno) para permitir reuso e exclusão seletiva.
  - `libShared/paymentDiscountHeuristics.js` (`messageAsksPaymentDiscount`): excluído
    `messageAsksPaymentMethodOptions` do fluxo de desconto por pagamento antecipado — pergunta
    sobre "formas de pagamento" não deve mais disparar a resposta canônica de desconto
    (`server/paymentDiscountFlow.js`), e sim seguir para a FAQ institucional nova.
  - `server/ai/agentRunner.js` (`paymentInfoHint`): hint atualizado para cobrir também "quais
    formas de pagamento existem" (boleto/PIX/cartão + Portal do Aluno), com proibição explícita
    de confundir com pagamento da matrícula/taxa/link de contrato.
  - `server/ai/promptsLoader.js` (regra 24): acrescentadas 2 linhas com as formas de pagamento
    da mensalidade e a distinção em relação à taxa/link de matrícula.
  - `libShared/lgpdCompliance.js` (`BANK_LEAK_RX`): adicionado `INSTITUTIONAL_PAYMENT_MENTION_RX`
    para remover da checagem de vazamento menções institucionais a boleto/PIX/cartão de
    crédito/débito quando NÃO seguidas de referência a pessoa (do/da/dele/dela/pessoal) nem de
    dado real (":" ou dígito) — mesmo padrão já usado para o falso positivo "Banco de Dados".
  - `scripts/test-lgpd-guard.mjs`: asserts para os 2 critérios de aceite de
    `messageAsksPaymentInfo` (formas de pagamento / boleto no cartão / link da matrícula) e para
    `replyLeaksSensitiveCandidateData` com a resposta aprovada (leak=false) e vazamentos reais
    (PIX com e-mail, conta bancária com dados → leak=true).

- **Contexto**
  - Thiago (#24137069) perguntou as formas de pagamento da mensalidade; a resposta institucional
    aprovada ("boleto bancário, PIX e cartão de crédito... Portal do Aluno") era bloqueada pelo
    guard LGPD (`lgpd_financial_leak`) por causar falso positivo em "cartão de crédito" e menções
    genéricas a PIX/cartão como forma de pagamento, tratadas como se fossem dado bancário do
    candidato.

- **Alternativas descartadas**
  - Remover `BANK_LEAK_RX` para cartão/PIX por completo: perderia a proteção contra vazamento
    real de dado bancário do candidato (ex.: "PIX do aluno: email@gmail.com", "conta bancária do
    aluno").
  - Aplicar a exceção "não houver mensalidade" da `messageAsksPaymentInfo` a qualquer menção de
    matrícula no texto: quebrava o teste existente (`vivianMsg`, que mistura pergunta de
    pagamento no prazo com "Tem matrícula?" no mesmo texto). Restrito a proximidade
    (<=15 caracteres) entre o verbo de pagamento e o termo de matrícula/contrato/inscrição.

- **Impacto**
  - `messageAsksPaymentInfo('formas de pagamento de mensalidades')` e
    `messageAsksPaymentInfo('posso pagar o boleto no cartão')` → `true`;
    `messageAsksPaymentInfo('como pago o link da matrícula')` → `false`.
  - `replyLeaksSensitiveCandidateData` com a resposta aprovada → `leak: false`; vazamento real
    (PIX/e-mail, conta bancária com dados) continua `leak: true`.
  - `messageAsksPaymentDiscount` não é mais acionado por pergunta de "forma de pagamento" — evita
    responder desconto por pagamento antecipado quando o lead só quer saber boleto/PIX/cartão.
  - Suíte `scripts/test-inscricao-flow.mjs` (259 asserts) e `scripts/test-lgpd-compliance.mjs`
    seguem passando sem regressão.
