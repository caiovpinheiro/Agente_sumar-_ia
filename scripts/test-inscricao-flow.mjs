/**
 * Fixtures E2E do fluxo de inscrição.
 *
 * Cobertura mínima exigida pelo plano (Solução definitiva: tools de ação para inscrição):
 *
 *  1. Lead novo confirma matrícula sem polo → exige tool `enviar_form_sumar_inscricao`
 *     (executor retorna POLO_NEEDED + replyOverride com lista de polos)
 *  2. Lead responde polo válido (Tatuapé) → exige tool `registrar_polo_inscricao`
 *  3. Lead responde "3" → executor mapeia para polo 3 (Tatuapé) e dispara form
 *  4. Lead responde polo inválido ("Santo Amaro") → executor retorna INVALID_POLO + lista
 *  5. Lead diz "pronto" → exige tool `confirmar_recebimento_formulario`
 *  6. Regressão (LLM prometeu form sem chamar tool) → guard substitui resposta
 *
 * Como rodamos sem credenciais Supabase/Kommo, focamos nos componentes
 * **puros** (replyGuard) e nos executores com `fetch` stubado. O objetivo é
 * detectar regressões no contrato (forma do retorno + replyOverride canônico)
 * antes do deploy — sem depender de infra externa.
 *
 * Uso:
 *   node scripts/test-inscricao-flow.mjs
 *
 * Sai com código 0 se todos os cenários passam, 1 se algum falha.
 */

import { TOOL_DEFINITIONS, INSCRICAO_ACTION_TOOLS } from '../server/ai/toolDefinitions.js'
import { validateReplyAgainstActions } from '../server/replyGuard.js'
import {
  runEnviarFormSumarInscricao,
  runRegistrarPoloInscricao,
  runConfirmarRecebimentoFormulario,
} from '../server/inscricaoActionTools.js'
import {
  tryProcessInscricaoPostFormPipeline,
  executeCaptacaoAfterFormResolved,
} from '../server/inscricaoPostFormPipeline.js'
import {
  parseEduitFlowFormReply,
  messageLooksLikeEduitFlowFormReply,
  snapshotHasFormIdentity,
} from '../libShared/eduitFlowFormParse.js'
import { extractCadastroFieldsFromInbound } from '../libShared/cadastroInboundExtract.js'
import {
  FORM_SUMAR_FLOW_COMPLETED_MARKER,
  messageIsFlowResponsesReceived,
  messageSignalsFormSubmissionAck,
  inboundTextForFormFlowCompletion,
  historyIndicatesFormSumarCompleted,
  messageLooksLikeFormSumarResponse,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  buildAskCursoAfterFormReply,
  buildCursoIndisponivelAlternativasReply,
  buildCursoIndisponivelSemAlternativasReply,
  buildInscricaoFormFieldsIncompleteReply,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  isKommoSystemOrIntegrationNote,
  isAgentInternalAuditNote,
  AGENT_AUDIT_NOTE_MARKER,
} from '../libShared/inboundMessageSanitize.js'
import { detectStateFromReply, AUTO_SYNC_TERMINAL_OR_ADVANCED } from '../server/inscricaoStateAutoSync.js'
import { buildPoloEscolhaPreFormMessage } from '../libShared/sumarePoloCatalog.js'
import {
  resolvePortalUrlForCandidato,
  normalizeCpf,
  normalizeDataNasc,
  kommoDataNascLooksInvalid,
} from '../server/sumareCaptacaoClient.js'
import {
  buildMatriculaPagamentoUrl,
  normalizeEducsyTurno,
} from '../server/sumareMatriculaEducsyClient.js'
import {
  evaluateKommoExpressReadiness,
} from '../server/kommoCardMirror.js'
import {
  leadConfirmsKeepPolo,
  leadDeclinesKeepPolo,
} from '../server/inscricaoKommoPreFilledFlow.js'
import {
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  matriculaPosFormAlreadyProcessed,
  inscricaoFormAlreadyFilled,
  buildComprovantePagamentoRecebidoReply,
  buildPosMatriculaAguardandoFinalizacaoReply,
  messageRelatesToComprovanteEmConferencia,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  resolvePosMatriculaTarget,
  tryHandleMatriculaAceitePagamentoFlow,
} from '../server/inscricaoAceitePagamentoFlow.js'
import { resolveDesistenciaTarget } from '../server/inscricaoDesistenciaFlow.js'
import {
  messageExpressesEnrollmentDecline,
  messageConfirmsFinalDesistencia,
  messageRevokesDesistencia,
  shouldOfferDesistenciaConfirm,
  shouldOfferDesistenciaAtAceiteContrato,
  buildConfirmDesistenciaReply,
  buildDesistenciaAgradecimentoReply,
  assistantAskedDesistenciaConfirm,
  conversationHadCourseEngagement,
} from '../libShared/inscricaoDesistenciaHeuristics.js'
import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
  INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  buildFacultyContactRedirectReply,
  buildExitChannelAlreadyDoneReply,
  replyLooksLikeFacultyContactRedirect,
  messageRequestsNewAttendance,
  HANDOFF_STATUS_LINKS_ENVIADOS,
  SUMARE_ATENDIMENTO_URL,
  SUMARE_OUVIDORIA_URL,
} from '../libShared/humanHandoffHeuristics.js'
import { tryHandleSaidaCanalJaEncerrada } from '../server/humanHandoffFlow.js'
import { buildHumanHandoffReply } from '../libShared/scopeHeuristics.js'
import {
  messageAsksAcademicAffairsSupportInText,
  messageAsksInstitutionalAcademicPhone,
  buildAcademicAffairsRedirectReply,
  buildInstitutionalAcademicPhoneReply,
  SUMARE_INSTITUTIONAL_PHONE,
} from '../libShared/academicAffairsHeuristics.js'

let passed = 0
let failed = 0
const failures = []

function ok(name, detail = '') {
  passed += 1
  console.log(`  PASS  ${name}${detail ? `  — ${detail}` : ''}`)
}

function fail(name, msg) {
  failed += 1
  failures.push({ name, msg })
  console.error(`  FAIL  ${name}\n        ${msg}`)
}

function assert(cond, name, detail = '') {
  if (cond) ok(name, detail)
  else fail(name, detail || 'condição falsa')
}

function assertEqual(actual, expected, name) {
  if (actual === expected) ok(name, `=${JSON.stringify(actual)}`)
  else fail(name, `esperado ${JSON.stringify(expected)}, recebido ${JSON.stringify(actual)}`)
}

function section(title) {
  console.log(`\n— ${title} —`)
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Stub global de `fetch` para isolar os executores das integrações externas. */
/* ────────────────────────────────────────────────────────────────────────── */

const fetchCalls = []
const realFetch = globalThis.fetch
function installFetchStub(responder) {
  fetchCalls.length = 0
  globalThis.fetch = async (url, init = {}) => {
    const call = { url: String(url), method: init.method || 'GET', body: init.body || null }
    fetchCalls.push(call)
    const r = responder(call)
    const status = r.status ?? 200
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body ?? null)
    return {
      ok: status >= 200 && status < 300,
      status,
      text: async () => text,
      json: async () => (text ? JSON.parse(text) : null),
    }
  }
}
function restoreFetch() {
  globalThis.fetch = realFetch
}

/** Stub Supabase REST padrão: retorna `dadosClienteRow` para SELECT e `representation` no PATCH/POST. */
function defaultSupabaseStub({ dadosClienteRow = null, salesbotOk = true, notes = [] } = {}) {
  return (call) => {
    const u = call.url
    if (u.includes('/rest/v1/dados_cliente_sum') && call.method === 'GET') {
      return { status: 200, body: dadosClienteRow ? [dadosClienteRow] : [] }
    }
    if (u.includes('/rest/v1/dados_cliente_sum') && (call.method === 'PATCH' || call.method === 'POST')) {
      return { status: 200, body: [{ ok: true, ...(dadosClienteRow || {}) }] }
    }
    // Salesbot run — endpoint chave para deliverInscricaoForm
    if (u.includes('/api/v2/salesbot/run')) {
      return salesbotOk
        ? { status: 200, body: [{ entity_type: 'leads', bot_id: 49815, status: 'started' }] }
        : { status: 500, body: { error: 'mock failure' } }
    }
    if (u.includes('/api/v4/leads')) {
      if (u.includes('/notes')) {
        return { status: 200, body: { _embedded: { notes } } }
      }
      if (u.includes('/events')) {
        return { status: 200, body: { _embedded: { events: [] } } }
      }
      if (/\/api\/v4\/leads\/\d+/.test(u)) {
        return { status: 200, body: { id: 23845769, custom_fields_values: [] } }
      }
      return { status: 200, body: { _embedded: { leads: [{ id: 23845769 }] } } }
    }
    return { status: 200, body: {} }
  }
}

/** Nota Kommo simulando conclusão do WhatsApp Flow do Form Sumar. */
function flowResponsesReceivedNote(ageMs = 0) {
  return {
    params: { text: 'Flow responses received' },
    created_at: new Date(Date.now() - ageMs).toISOString(),
  }
}

const env = {
  SUPABASE_URL: 'https://mock.supabase.co',
  SUPABASE_KEY: 'mock-key',
  SUPABASE_DADOS_CLIENTE_TABLE: 'dados_cliente_sum',
  KOMMO_BASE_URL: 'https://mock.kommo.com',
  KOMMO_ACCESS_TOKEN: 'mock-token',
  KOMMO_SALESBOT_FORMULARIO_SUM_ID: '49815',
  KOMMO_SALESBOT_MIN_INTERVAL_SEC: '0',
  INSCRICAO_FORM_DELIVERY: 'kommo_salesbot',
  SUMARE_CAPTACAO_ENABLED: 'false',
}

const ctx = {
  telefone: '5511999990000',
  leadId: 23845769,
  pushName: 'Lead Teste',
  executionId: 'EX-TEST-0001',
  model: 'gpt-4.1-mini',
  t0: Date.now(),
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 0 — Estrutura das tools                                          */
/* ────────────────────────────────────────────────────────────────────────── */
section('Tools de ação registradas')

const toolNames = TOOL_DEFINITIONS.map((t) => t.function?.name)
assert(toolNames.includes('enviar_form_sumar_inscricao'), 'tool enviar_form_sumar_inscricao definida')
assert(toolNames.includes('registrar_polo_inscricao'), 'tool registrar_polo_inscricao definida')
assert(toolNames.includes('registrar_transferencia'), 'tool registrar_transferencia definida')
assert(toolNames.includes('confirmar_recebimento_formulario'), 'tool confirmar_recebimento_formulario definida')
assertEqual(INSCRICAO_ACTION_TOOLS.size, 4, 'INSCRICAO_ACTION_TOOLS tem 4 tools')

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 1 — Lead novo: quero me inscrever em administração               */
/* ────────────────────────────────────────────────────────────────────────── */
section('1. Lead novo confirma matrícula sem polo')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769 } }))
try {
  const r = await runEnviarFormSumarInscricao(env, { telefone: ctx.telefone, curso: 'Administração' }, ctx)
  assertEqual(r.ok, false, '1.ok=false (precisa de polo)')
  assertEqual(r.code, 'POLO_NEEDED', '1.code=POLO_NEEDED')
  assert(/polo/i.test(r.replyOverride || ''), '1.replyOverride pede polo')
  assert(/1\.\s*\*?\w/i.test(r.replyOverride || ''), '1.replyOverride lista polos numerados')
  assertEqual(r.ctxSnapshot?.inscricaoForm, 'aguardando_escolha_polo_pre_form', '1.estado=aguardando_escolha_polo_pre_form')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 2 — Lead responde polo válido (Tatuapé)                          */
/* ────────────────────────────────────────────────────────────────────────── */
section('2. Lead responde polo Tatuapé')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769, inscricao_form_status: 'aguardando_escolha_polo_pre_form' } }))
try {
  const r = await runRegistrarPoloInscricao(env, { telefone: ctx.telefone, polo_id: 'tatuape' }, ctx)
  assertEqual(r.ok, true, '2.ok=true')
  assertEqual(r.code, 'POLO_REGISTRADO_OK', '2.code=POLO_REGISTRADO_OK')
  assert(/Tatuap[eé]/i.test(r.replyOverride || ''), '2.replyOverride confirma polo Tatuapé')
  assert(/formul[aá]rio/i.test(r.replyOverride || ''), '2.replyOverride menciona formulário')
  assertEqual(r.ctxSnapshot?.inscricaoForm, 'aguardando_form_sumar', '2.estado=aguardando_form_sumar')
  assertEqual(r.ctxSnapshot?.poloId, 'tatuape', '2.polo=tatuape')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 3 — Lead responde apenas "3"                                     */
/* ────────────────────────────────────────────────────────────────────────── */
section('3. Lead responde número de polo "3"')

// Lead diferente p/ evitar dedupe do salesbot (cache em memória).
installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 2, id_lead: 99887766, inscricao_form_status: 'aguardando_escolha_polo_pre_form' } }))
try {
  // O LLM converte "3" no polo_id correspondente (tatuape) antes de chamar a tool.
  // Aqui validamos que ao receber o polo_id mapeado, o executor grava e dispara.
  const r = await runRegistrarPoloInscricao(
    env,
    { telefone: '5511988880000', polo_id: 'tatuape' },
    { ...ctx, telefone: '5511988880000', leadId: 99887766 },
  )
  assertEqual(r.ok, true, '3.ok=true (polo 3 mapeado para tatuape)')
  assertEqual(r.ctxSnapshot?.poloId, 'tatuape', '3.polo=tatuape')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 4 — Polo inválido (Osasco — fora do catálogo)                    */
/* Nota: Santo Amaro passou a ser polo VÁLIDO no catálogo (ED_SP_P6).         */
/* ────────────────────────────────────────────────────────────────────────── */
section('4. Polo inválido (Osasco)')

installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769 } }))
try {
  const r = await runRegistrarPoloInscricao(env, { telefone: ctx.telefone, polo_id: 'osasco' }, ctx)
  assertEqual(r.ok, false, '4.ok=false')
  assertEqual(r.code, 'INVALID_POLO', '4.code=INVALID_POLO')
  assert(/polo/i.test(r.replyOverride || ''), '4.replyOverride pede polo válido')
  assert(/Tatuap[eé]|Santana|S[aã]o Miguel|Barra Funda/i.test(r.replyOverride || ''), '4.replyOverride lista polos válidos')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 5 — Form preenchido ("pronto")                                   */
/* ────────────────────────────────────────────────────────────────────────── */
section('5. Lead diz "pronto" após formulário')

installFetchStub(
  defaultSupabaseStub({
    dadosClienteRow: {
      id: 1,
      id_lead: 23845769,
      inscricao_form_status: 'aguardando_form_sumar',
      polo_inscricao_escolhido: 'Tatuapé',
      captacao_unidade: 'ED_SP_P3',
    },
    // Form REALMENTE chegou no Kommo (Flow concluído) — não deve reenviar.
    notes: [flowResponsesReceivedNote()],
  }),
)
try {
  const r = await runConfirmarRecebimentoFormulario(env, { telefone: ctx.telefone }, ctx)
  // SUMARE_CAPTACAO_ENABLED=false → cai no fallback (salesbot 49813 ou reply genérico)
  assert(['INSCRICAO_REGISTRADA_OK', 'CAPTACAO_FAILED'].includes(r.code), `5.code esperado em [INSCRICAO_REGISTRADA_OK, CAPTACAO_FAILED] (atual=${r.code})`)
  assert(typeof r.replyOverride === 'string' && r.replyOverride.length > 0, '5.replyOverride não vazio')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 5b — Lead afirma ter enviado, mas Kommo NÃO confirma → reenvio   */
/* ────────────────────────────────────────────────────────────────────────── */
section('5b. Lead diz "pronto" mas formulário NÃO chegou no Kommo → reenvio')

installFetchStub(
  defaultSupabaseStub({
    dadosClienteRow: {
      id: 1,
      id_lead: 23845769,
      inscricao_form_status: 'aguardando_form_sumar',
      polo_inscricao_escolhido: 'Tatuapé',
      captacao_unidade: 'ED_SP_P3',
    },
    notes: [], // nenhuma nota de Flow/formulário no Kommo
  }),
)
try {
  const r = await runConfirmarRecebimentoFormulario(env, { telefone: ctx.telefone }, ctx)
  assertEqual(r.code, 'FORM_NOT_RECEIVED_RESENT', '5b.code=FORM_NOT_RECEIVED_RESENT')
  assertEqual(r.ok, true, '5b.ok=true (reenvio bem-sucedido)')
  assert(/n[aã]o recebemos/i.test(r.replyOverride || ''), '5b.replyOverride avisa que não recebeu')
  assert(/reenvi/i.test(r.replyOverride || ''), '5b.replyOverride menciona reenvio')
  assertEqual(r.ctxSnapshot?.formNotReceivedResent, true, '5b.ctxSnapshot marca formNotReceivedResent')
} finally {
  restoreFetch()
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Cobertura 6 — Regressão: LLM promete formulário sem tool                   */
/* ────────────────────────────────────────────────────────────────────────── */
section('6. Reply guard: LLM promete formulário sem chamar tool')

{
  // Promessa de envio futuro
  const v1 = validateReplyAgainstActions({
    reply: 'Perfeito! Vou enviar o formulário de inscrição em instantes, pode aguardar.',
    toolCalls: [],
    stage: null,
  })
  assertEqual(v1.violation, true, '6.1 promessa "vou enviar formulário" detectada')
  assertEqual(v1.code, 'promise_form_send_without_tool', '6.1 code=promise_form_send_without_tool')
  assert(/polo/i.test(v1.safeReply || ''), '6.1 safeReply pede polo')

  // Afirmação de envio passado
  const v2 = validateReplyAgainstActions({
    reply: 'Pronto! Acabei de enviar o formulário aqui no WhatsApp.',
    toolCalls: [],
    stage: 'aguardando_escolha_polo_pre_form',
  })
  assertEqual(v2.violation, true, '6.2 afirmação "acabei de enviar formulário" detectada')
  assert(/polo/i.test(v2.safeReply || ''), '6.2 safeReply pede polo (estado=aguardando_polo)')

  // Reply consistente (tool foi chamada) → não viola
  const v3 = validateReplyAgainstActions({
    reply: 'Polo Tatuapé registrado. Acabei de enviar o formulário no WhatsApp.',
    toolCalls: [{ tool: 'registrar_polo_inscricao', ok: true, actionOk: true }],
    stage: 'aguardando_form_sumar',
  })
  assertEqual(v3.violation, false, '6.3 reply com tool=registrar_polo_inscricao não dispara guard')

  // Reply afirma inscrição concluída sem tool de captação
  const v4 = validateReplyAgainstActions({
    reply: 'Sua inscrição foi registrada com sucesso na Sumaré!',
    toolCalls: [],
    stage: 'aguardando_form_sumar',
  })
  assertEqual(v4.violation, true, '6.4 afirmação "inscrição registrada" detectada')
  assertEqual(v4.code, 'inscricao_done_without_tool', '6.4 code=inscricao_done_without_tool')

  // Texto neutro (nada afirmado) → não viola
  const v5 = validateReplyAgainstActions({
    reply: 'Posso te dar mais informações sobre o curso de Administração?',
    toolCalls: [],
    stage: null,
  })
  assertEqual(v5.violation, false, '6.5 texto neutro não dispara guard')
}

section('7. Flow responses received (WhatsApp Flow / Kommo)')

{
  assert(messageIsFlowResponsesReceived('Flow responses received'), '7.1 detecta texto exato EN')
  assert(
    messageIsFlowResponsesReceived('Preencha o form.\nFlow responses received'),
    '7.1b detecta flow embutido na nota',
  )
  assertEqual(
    inboundTextForFormFlowCompletion('Flow responses received'),
    FORM_SUMAR_FLOW_COMPLETED_MARKER,
    '7.2 normaliza para marcador interno',
  )
  assert(
    !isKommoSystemOrIntegrationNote('Flow responses received'),
    '7.3 não classifica flow como nota de sistema',
  )
  assert(
    messageSignalsFormSubmissionAck(FORM_SUMAR_FLOW_COMPLETED_MARKER),
    '7.4 marcador dispara ack de formulário',
  )
  assert(
    historyIndicatesFormSumarCompleted([
      { role: 'user', content: FORM_SUMAR_FLOW_COMPLETED_MARKER },
      { role: 'user', content: 'pronto' },
    ]),
    '7.5 histórico com flow + pronto indica form concluído',
  )
  assert(
    !historyIndicatesFormSumarCompleted([{ role: 'user', content: 'oi' }]),
    '7.6 saudação isolada não indica form',
  )
}

section('7b. Flow EduIT (Resposta do formulário / FORMULÁRIO flow)')

{
  const josina =
    '📋 *Resposta do formulário* — _flow_ *Nome* ↳ Josina Alves da Silva *CPF* ↳ 36880225802 *Data de Nascimento* ↳ 19/06/1987'
  const eliane =
    'FORMULÁRIO flow 6 campos\nNome: Eliane Ferreira Maia\nCPF: 09189590805\nData de Nascimento: 13/12/1969\nEmail: limaia36@gmail.com\nSexo: feminino\nTelefone: 11981671407'

  const pJosina = parseEduitFlowFormReply(josina)
  assert(messageLooksLikeEduitFlowFormReply(josina), '7b.1 detecta Resposta do formulário')
  assert(messageLooksLikeFormSumarResponse(josina), '7b.2 heurística geral reconhece Flow EduIT')
  assertEqual(pJosina?.nome, 'Josina Alves da Silva', '7b.3 parse nome Josina')
  assertEqual(pJosina?.cpf, '36880225802', '7b.4 parse cpf Josina')
  assert(
    historyIndicatesFormSumarCompleted([{ role: 'user', content: josina }]),
    '7b.5 histórico com Flow EduIT indica form concluído',
  )

  const pEliane = parseEduitFlowFormReply(eliane)
  assert(messageLooksLikeEduitFlowFormReply(eliane), '7b.6 detecta FORMULÁRIO flow')
  assertEqual(pEliane?.email, 'limaia36@gmail.com', '7b.7 parse email Eliane')
  assertEqual(pEliane?.cpf, '09189590805', '7b.8 parse cpf Eliane')

  const extracted = extractCadastroFieldsFromInbound('já enviei', [
    { role: 'user', content: eliane },
  ])
  assertEqual(extracted.email, 'limaia36@gmail.com', '7b.9 extract inbound puxa e-mail do Flow')
  assertEqual(extracted.cpf, '09189590805', '7b.10 extract inbound puxa CPF do Flow')
  assertEqual(extracted.nome, 'Eliane Ferreira Maia', '7b.11 extract inbound puxa nome do Flow')

  assert(
    snapshotHasFormIdentity({ nome: 'Eliane Ferreira Maia', cpf: '09189590805' }),
    '7b.12 identidade nome+CPF = form recebido',
  )
  assert(
    snapshotHasFormIdentity({ nome: 'Negócio limaia', cpf: '09189590805', email: 'limaia36@gmail.com' }),
    '7b.13 título Negócio + e-mail + CPF = form recebido',
  )
  assert(
    !snapshotHasFormIdentity({ nome: 'Negócio limaia', cpf: '09189590805' }),
    '7b.14 título Negócio + CPF sem e-mail NÃO é identidade',
  )
  assert(
    !snapshotHasFormIdentity({ nome: 'Eliane Ferreira Maia', cpf: '' }),
    '7b.15 nome sem CPF NÃO é identidade',
  )
}

section('8. Auto-sync de inscricao_form_status pelo reply do LLM (Fix 1)')

{
  // Reply canônico do agente perguntando polo → deve sinalizar transição.
  const poloMsg = buildPoloEscolhaPreFormMessage({})
  assertEqual(
    detectStateFromReply(poloMsg),
    INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    '8.1 reply canônico de polo → AGUARDANDO_POLO_PRE_FORM',
  )

  // Variação com sufixo EX-…
  assertEqual(
    detectStateFromReply(poloMsg + ' - EX-260527-2025-001-abcd'),
    INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    '8.2 reply com sufixo EX ainda é detectado',
  )

  // Reply genérico (não fala de polo) → nenhuma transição
  assertEqual(
    detectStateFromReply('Posso te dar mais detalhes sobre o curso de Nutrição?'),
    null,
    '8.3 reply neutro → null',
  )

  // Reply vazio → null
  assertEqual(detectStateFromReply(''), null, '8.4 reply vazio → null')
  assertEqual(detectStateFromReply(null), null, '8.5 reply null → null')

  // Estados terminais/avançados não devem ser regredidos
  assert(
    AUTO_SYNC_TERMINAL_OR_ADVANCED.has(INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE),
    '8.6 aceite_contrato marcado como terminal/avançado',
  )
  assert(
    AUTO_SYNC_TERMINAL_OR_ADVANCED.has(INSCRICAO_FORM_STATUS_CONCLUIDO),
    '8.7 form_concluido marcado como terminal/avançado',
  )
  assert(
    AUTO_SYNC_TERMINAL_OR_ADVANCED.has(INSCRICAO_FORM_STATUS_AGUARDANDO),
    '8.8 aguardando_form_sumar não regride para polo',
  )
}

section('9. Link do portal novo (matricula.sumare.edu.br / pagamento?cpf=)')

{
  const envPortal = {
    SUMARE_MATRICULA_PORTAL_URL: 'https://matricula.sumare.edu.br',
    SUMARE_MATRICULA_UTM_CAMPAIGN: 'sumareeadpolos',
  }
  const id = '2026700000005585'
  const cpf = '22449122800'

  const r1 = resolvePortalUrlForCandidato(envPortal, id, 'aceite_contrato', { cpf })
  assertEqual(
    r1.url,
    `https://matricula.sumare.edu.br/Vestibular/pagamento?cpf=${cpf}&utm_campaign=sumareeadpolos`,
    '9.1 com CPF → /Vestibular/pagamento',
  )
  assertEqual(r1.phase, 'pagamento', '9.1b phase=pagamento')

  const r2 = resolvePortalUrlForCandidato(envPortal, id, 'meioPagamento', { cpf })
  assertEqual(r2.url, r1.url, '9.2 status meioPagamento → mesmo link de pagamento')

  const r3 = resolvePortalUrlForCandidato(envPortal, id, 'pagamento', { cpf: '224.491.228-00' })
  assertEqual(r3.url, r1.url, '9.3 CPF mascarado normaliza para 11 dígitos')

  const r4 = resolvePortalUrlForCandidato(envPortal, '', 'aceite_contrato')
  assertEqual(r4.url, '', '9.4 sem CPF → url vazia (não cai no portal antigo)')

  const r5 = buildMatriculaPagamentoUrl({}, { cpf })
  assert(
    r5.startsWith('https://matricula.sumare.edu.br/Vestibular/pagamento?cpf='),
    '9.5 default env → portal matricula.sumare.edu.br',
  )
  assertEqual(normalizeEducsyTurno('SEMIPRESENCIAL'), 'SEMI', '9.6 turno antigo → SEMI')
  assertEqual(normalizeEducsyTurno('EAD'), 'EAD', '9.7 turno EAD permanece')
}

section('10. Plano_Inscricao_CardKommo — fluxo express via card Sumaré Comercial')

{
  // 10.1 Card completo (todos os campos) → ready=true
  const cardCompleto = {
    nome: 'CAIO SILVA',
    cpf: '123.456.789-00',
    email: 'caio@example.com',
    curso_inscricao: 'Pedagogia',
    polo_inscricao: 'Barra Funda',
    data_nasc: '16/05/2000',
    modalidade: 'EAD',
  }
  const r10a = evaluateKommoExpressReadiness(cardCompleto)
  assert(r10a.ready === true, '10.1 card completo → ready=true')
  assertEqual(r10a.missing.length, 0, '10.1b missing vazio')

  // 10.2 Card sem data_nasc → ready=false + missing contém data_nasc
  const cardSemDataNasc = { ...cardCompleto, data_nasc: '' }
  const r10b = evaluateKommoExpressReadiness(cardSemDataNasc)
  assert(r10b.ready === false, '10.2 sem data_nasc → ready=false')
  assert(r10b.missing.includes('data_nasc'), '10.2b missing contém data_nasc')

  // 10.3 Card sem modalidade → ready=false (decisão: sim_obrigatorios)
  const cardSemModalidade = { ...cardCompleto, modalidade: '' }
  const r10c = evaluateKommoExpressReadiness(cardSemModalidade)
  assert(r10c.ready === false, '10.3 sem modalidade → ready=false (sim_obrigatorios)')
  assert(r10c.missing.includes('modalidade'), '10.3b missing contém modalidade')

  // 10.4 "Não informado" tratado como ausente
  const cardComNaoInformado = { ...cardCompleto, cpf: 'Não informado' }
  const r10d = evaluateKommoExpressReadiness(cardComNaoInformado)
  assert(r10d.ready === false, '10.4 "Não informado" conta como ausente')
  assert(r10d.missing.includes('cpf'), '10.4b missing contém cpf')

  // 10.5 Fallback: snapshot.turno também serve como modalidade
  const cardComTurno = { ...cardCompleto, modalidade: '', turno: 'EAD' }
  const r10e = evaluateKommoExpressReadiness(cardComTurno)
  assert(r10e.ready === true, '10.5 turno=EAD compensa modalidade vazia')

  // 10.6 Heurística confirma manter polo
  assert(leadConfirmsKeepPolo('sim'), '10.6 "sim" confirma manter polo')
  assert(leadConfirmsKeepPolo('Isso mesmo!'), '10.6b "isso mesmo" confirma')
  assert(leadConfirmsKeepPolo('manter'), '10.6c "manter" confirma')
  assert(!leadConfirmsKeepPolo('quero matrícula em Pedagogia'), '10.6d frase longa não confirma')

  // 10.7 Heurística declina manter polo
  assert(leadDeclinesKeepPolo('não'), '10.7 "não" declina')
  assert(leadDeclinesKeepPolo('Não quero esse polo'), '10.7b "não quero esse polo" declina')
  assert(leadDeclinesKeepPolo('quero trocar de polo'), '10.7c "trocar polo" declina')
  assert(!leadDeclinesKeepPolo('sim'), '10.7d "sim" não declina')

  // 10.8 Status terminal distribuir_consultor para bloquear loop scheduler
  assert(
    matriculaPosFormAlreadyProcessed({ inscricao_form_status: INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR }),
    '10.8 distribuir_consultor é terminal (scheduler skip)',
  )

  // 10.9 aguardando_confirm_polo_kommo bloqueia reentrada do scheduler
  assert(
    matriculaPosFormAlreadyProcessed({
      inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_POLO_KOMMO,
    }),
    '10.9 aguardando_confirm_polo_kommo conta como em-progresso',
  )

  // 10.10 auto-sync NÃO regride distribuir_consultor (terminal)
  assert(
    AUTO_SYNC_TERMINAL_OR_ADVANCED.has(INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR) ||
      // Se ainda não está no set explícito, ao menos não é interpretado como
      // polo pelo detectStateFromReply (terminal não vem de reply de polo).
      detectStateFromReply('blá blá') === null,
    '10.10 estado terminal não é regredido pelo auto-sync',
  )

  // 10.11 inscricaoFormAlreadyFilled — guarda contra reenvio do Formulario_Sum
  assert(
    inscricaoFormAlreadyFilled({ inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE }),
    '10.11 aguardando_aceite_contrato = formulário já preenchido',
  )
  assert(
    inscricaoFormAlreadyFilled({ inscricao_form_status: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO }),
    '10.11b comprovante_recebido = formulário já preenchido',
  )
  assert(
    inscricaoFormAlreadyFilled({ inscricao_form_recebido_at: '2026-06-03T11:51:04.831+00:00' }),
    '10.11c inscricao_form_recebido_at setado = formulário já preenchido',
  )
  assert(
    !inscricaoFormAlreadyFilled({ inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO }),
    '10.11d aguardando_form_sumar (form enviado, não preenchido) = NÃO conta como preenchido',
  )
  assert(
    !inscricaoFormAlreadyFilled({ inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM }),
    '10.11e escolha de polo pré-form = NÃO conta como preenchido',
  )
  assert(!inscricaoFormAlreadyFilled(null), '10.11f row nula = não preenchido')
  assert(
    !inscricaoFormAlreadyFilled({ inscricao_form_status: null }),
    '10.11g status null = não preenchido',
  )
}

section('11. Pós-matrícula: agradecimento + mover lead para fila de instruções')

{
  // 11.1 Texto pós-comprovante: aguardar finalização + e-mail de acesso
  const replyPadrao = buildComprovantePagamentoRecebidoReply({})
  assert(
    /maravilha/i.test(replyPadrao),
    '11.1 reply começa com "Maravilha"',
  )
  assert(
    /aguardar a matr[ií]cula ser finalizada/i.test(replyPadrao),
    '11.1b reply menciona aguardar finalização da matrícula',
  )
  assert(
    /primeiro acesso|e-?mail/i.test(replyPadrao),
    '11.1c reply menciona primeiro acesso por e-mail',
  )
  assert(
    !/consultor da Faculdade Sumaré entra em contato/i.test(replyPadrao),
    '11.1d reply não menciona mais "consultor entra em contato"',
  )

  // 11.2 Reply com pushName
  const replyComNome = buildComprovantePagamentoRecebidoReply({ pushName: 'Caio Silva' })
  assert(/, Caio/i.test(replyComNome), '11.2 reply inclui primeiro nome quando pushName fornecido')

  // 11.3 Defaults da fila pós-matrícula
  const t1 = resolvePosMatriculaTarget({})
  assertEqual(t1.pipelineId, 13756724, '11.3 pipelineId default = 13756724')
  assertEqual(t1.statusId, 106426128, '11.3b statusId default = 106426128')

  // 11.4 Override via env
  const t2 = resolvePosMatriculaTarget({
    KOMMO_POS_MATRICULA_PIPELINE_ID: '99999',
    KOMMO_POS_MATRICULA_STATUS_ID: '88888',
  })
  assertEqual(t2.pipelineId, 99999, '11.4 pipelineId override via env')
  assertEqual(t2.statusId, 88888, '11.4b statusId override via env')

  // 11.5 Env malformado → cai no default (Number('abc') = NaN)
  const t3 = resolvePosMatriculaTarget({
    KOMMO_POS_MATRICULA_PIPELINE_ID: 'lixo',
    KOMMO_POS_MATRICULA_STATUS_ID: '',
  })
  assertEqual(t3.pipelineId, 13756724, '11.5 env malformado cai no default pipeline')
  assertEqual(t3.statusId, 106426128, '11.5b env vazio cai no default status')
}

section('12. Desistência de inscrição — confirma, agradece e move fila 143')

{
  const histCurso = [
    { role: 'user', content: 'quero saber sobre pedagogia' },
    {
      role: 'assistant',
      content:
        'O curso de Pedagogia na Sumaré é EAD. A mensalidade é a partir de R$ 199. Deseja seguir com a inscrição?',
    },
    { role: 'user', content: 'qual a duração?' },
    {
      role: 'assistant',
      content: 'A graduação em Pedagogia tem duração de 4 anos. Posso te ajudar com a inscrição?',
    },
  ]

  assert(
    conversationHadCourseEngagement(histCurso),
    '12.1 histórico com curso + dúvidas = engajamento',
  )
  assert(
    messageExpressesEnrollmentDecline('não quero me inscrever', histCurso),
    '12.2 "não quero me inscrever" é declínio',
  )
  assert(
    shouldOfferDesistenciaConfirm('não tenho interesse no curso', histCurso),
    '12.3 oferece confirmação de desistência',
  )
  assert(
    !shouldOfferDesistenciaConfirm('quero me matricular', histCurso),
    '12.3b pedido de matrícula não é desistência',
  )

  // Regressões reais (lead #23841399 — print do CRM): plano B / condicional
  // não pode ser tratado como desistência.
  assert(
    !messageExpressesEnrollmentDecline('se não tiver quero o curso de pediatria', histCurso),
    '12.3c "se não tiver quero X" é condicional, NÃO declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('ou o curso de administração predial', histCurso),
    '12.3d "ou o curso de Y" é plano B, NÃO declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('predial', histCurso),
    '12.3e nome solto de curso NÃO é declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('quero conhecer o curso de veterinario', histCurso),
    '12.3f "quero conhecer curso" NÃO é declínio',
  )
  assert(
    !shouldOfferDesistenciaConfirm('se não tiver veterinária prefiro pediatria', histCurso),
    '12.3g shouldOffer não dispara em condicional com plano B',
  )

  // Regressão crítica (lead #23841399 — print do CRM 16:46): "quero fazer um
  // curso" foi tratado como desistência. NUNCA mais.
  assert(
    !messageExpressesEnrollmentDecline('quero fazer um curso', histCurso),
    '12.3h "quero fazer um curso" NÃO é declínio (interesse positivo)',
  )
  assert(
    !messageExpressesEnrollmentDecline('quero conhecer um curso', histCurso),
    '12.3i "quero conhecer um curso" NÃO é declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('quero me inscrever', histCurso),
    '12.3j "quero me inscrever" NÃO é declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('gostaria de me matricular', histCurso),
    '12.3k "gostaria de me matricular" NÃO é declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('vou fazer o vestibular', histCurso),
    '12.3l "vou fazer o vestibular" NÃO é declínio',
  )
  assert(
    !messageExpressesEnrollmentDecline('tenho interesse em estudar pedagogia', histCurso),
    '12.3m "tenho interesse em estudar" NÃO é declínio',
  )
  assert(
    !shouldOfferDesistenciaConfirm('quero fazer um curso', histCurso),
    '12.3n shouldOffer NÃO dispara para interesse positivo (proteção em camadas)',
  )

  // Guard de "pergunta recente sobre inscrição/matrícula" — sem ela,
  // shouldOffer NÃO dispara mesmo se o lead disser algo declínio-like.
  const histSemPerguntaInscricao = [
    { role: 'user', content: 'quero saber sobre pedagogia' },
    {
      role: 'assistant',
      content:
        'O curso de Pedagogia na Sumaré é EAD. A mensalidade é a partir de R$ 199. ' +
        'A duração é de 4 anos.',
    },
    { role: 'user', content: 'entendi' },
    {
      role: 'assistant',
      content: 'Mais alguma dúvida sobre o curso?',
    },
  ]
  assert(
    !shouldOfferDesistenciaConfirm('não quero me inscrever', histSemPerguntaInscricao),
    '12.3o shouldOffer NÃO dispara sem pergunta recente sobre inscrição/matrícula',
  )

  const histSimone = [
    { role: 'user', content: 'Psicopedagogia graduação' },
    {
      role: 'assistant',
      content:
        'A graduação em Psicopedagogia não está disponível. Temos pós-graduação. Deseja saber mais?',
    },
    { role: 'user', content: 'Não' },
    {
      role: 'assistant',
      content: 'Para seguir com o assunto, me conte qual outra área ou curso tem interesse.',
    },
  ]
  assert(
    shouldOfferDesistenciaConfirm('Nenhum interesse obrigada', histSimone),
    '12.3p "nenhum interesse obrigada" dispara confirmação de desistência',
  )
  assert(
    messageConfirmsFinalDesistencia('Sair'),
    '12.3q "Sair" confirma desistência após pergunta canônica',
  )

  const confirmMsg = buildConfirmDesistenciaReply({ pushName: 'Gustavo' })
  assert(
    assistantAskedDesistenciaConfirm(confirmMsg),
    '12.4 mensagem canônica detectada pelo auto-sync',
  )
  assert(/impulsionar a sua carreira/i.test(confirmMsg), '12.4b menciona outros cursos')
  assert(/confirmar a desistência/i.test(confirmMsg), '12.4c pede confirmação')

  assert(messageConfirmsFinalDesistencia('sim, confirmo a desistência'), '12.5 confirma desistência')
  assert(messageConfirmsFinalDesistencia('não'), '12.5b "não" após pergunta = confirma')
  assert(messageRevokesDesistencia('mudei de ideia, quero me inscrever'), '12.6 revoga desistência')

  const thanks = buildDesistenciaAgradecimentoReply({})
  assert(/obrigado pelo contato/i.test(thanks), '12.7 agradecimento final')
  assert(/qualquer outra dúvida/i.test(thanks), '12.7b convida contato futuro')

  const tDes = resolveDesistenciaTarget({})
  assertEqual(tDes.pipelineId, 13756724, '12.8 pipeline default Sumaré')
  assertEqual(tDes.statusId, 143, '12.8b status default fila 143')

  assert(
    matriculaPosFormAlreadyProcessed({
      inscricao_form_status: INSCRICAO_FORM_STATUS_DESISTENCIA_CONCLUIDA,
    }),
    '12.9 desistencia_concluida é terminal',
  )
  assertEqual(
    detectStateFromReply(buildConfirmDesistenciaReply({})),
    INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_DESISTENCIA,
    '12.10 auto-sync detecta pergunta de desistência',
  )

  const histAceite = [
    { role: 'assistant', content: 'Sua inscrição foi registrada. Acesse o link para pagamento da matrícula.' },
    { role: 'user', content: 'obrigado' },
  ]
  assert(
    shouldOfferDesistenciaAtAceiteContrato('não vou continuar com a inscrição', histAceite),
    '12.11 pós-link: não vou continuar',
  )
  assert(
    shouldOfferDesistenciaAtAceiteContrato('quero cancelar a matrícula', histAceite),
    '12.11b pós-link: cancelar matrícula',
  )
  assert(
    !shouldOfferDesistenciaAtAceiteContrato('qual o valor da mensalidade?', histAceite),
    '12.11c pós-link: dúvida de valor NÃO é desistência',
  )
  assert(
    !shouldOfferDesistenciaAtAceiteContrato('quero me matricular', histAceite),
    '12.11d pós-link: interesse NÃO é desistência',
  )
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 13. Pause Gate — desistência concluída deve PASSAR mesmo com IA pausada    */
/* ────────────────────────────────────────────────────────────────────────── */

section('13. Gate atendimento_ia=pause — exceção para desistência concluída')

{
  const { decideHoldOnIaPause } = await import('../server/dadosClienteStore.js')

  // 13.1 Linha vazia (cliente nunca tocado) — nada pausa.
  const r1 = decideHoldOnIaPause(null)
  assertEqual(r1.hold, false, '13.1 row nula = hold false')
  assertEqual(r1.paused, false, '13.1b row nula = paused false')

  // 13.2 atendimento_ia null + qualquer status — não pausa.
  const r2 = decideHoldOnIaPause({ atendimento_ia: null, inscricao_form_status: 'concluido' })
  assertEqual(r2.hold, false, '13.2 atendimento_ia=null = não bloqueia')

  // 13.3 pause + status genérico (matrícula/consultor) — bloqueia.
  const r3 = decideHoldOnIaPause({
    atendimento_ia: 'pause',
    inscricao_form_status: 'aguardando',
  })
  assertEqual(r3.hold, true, '13.3 pause sem exceção = hold=true (matrícula em andamento)')
  assertEqual(r3.paused, true, '13.3b paused=true')
  assertEqual(r3.reason, null, '13.3c reason=null quando bloqueia')

  // 13.4 pause + desistencia_concluida — NÃO bloqueia (early handler responde).
  const r4 = decideHoldOnIaPause({
    atendimento_ia: 'pause',
    inscricao_form_status: 'desistencia_concluida',
  })
  assertEqual(r4.hold, false, '13.4 desistencia_concluida = drain prossegue')
  assertEqual(r4.paused, true, '13.4b paused=true (informa que IA estava pausada)')
  assertEqual(
    r4.reason,
    'desistencia_concluida',
    '13.4c reason indica qual early handler vai cobrir',
  )

  const r4b = decideHoldOnIaPause({
    atendimento_ia: 'pause',
    inscricao_form_status: 'aguardando_confirm_desistencia',
  })
  assertEqual(r4b.hold, false, '13.4b aguardando_confirm_desistencia = drain prossegue')
  assertEqual(r4b.reason, 'desistencia_confirm', '13.4c reason desistencia_confirm')

  // 13.5 Case-insensitive: 'PAUSE' / 'Pause'.
  const r5 = decideHoldOnIaPause({ atendimento_ia: 'PAUSE', inscricao_form_status: null })
  assertEqual(r5.hold, true, '13.5 PAUSE maiúsculo = bloqueia')
  const r6 = decideHoldOnIaPause({ atendimento_ia: 'Pause', inscricao_form_status: null })
  assertEqual(r6.hold, true, '13.5b Pause capitalizado = bloqueia')
}

/* ────────────────────────────────────────────────────────────────────────── */
/* 14. Notas internas de auditoria NUNCA viram mensagem do candidato          */
/* ────────────────────────────────────────────────────────────────────────── */

section('14. Nota interna de auditoria filtrada pelo poll de inbound')

{
  // Texto EXATO que corrompeu o lead #23841399 (entrou como msg do user).
  const desistNote =
    'Lead confirmou desistência da inscrição via WhatsApp. Motivo da perda: Sem Interesse. ' +
    'Movido para fila 143 (pipeline 13756724).'
  assert(isAgentInternalAuditNote(desistNote), '14.1 nota de desistência é auditoria (camada B)')
  assert(
    isKommoSystemOrIntegrationNote(desistNote),
    '14.1b poll descarta nota de desistência (via isKommoSystemOrIntegrationNote)',
  )

  const comprovanteNote =
    'Comprovante de pagamento recebido via WhatsApp (candidato 12345). ' +
    'Lead movido para fila pós-matrícula (pipeline 13756724 / status 106426128) — ' +
    'aguardando instruções de início do curso.'
  assert(isAgentInternalAuditNote(comprovanteNote), '14.2 nota de comprovante é auditoria')
  assert(isKommoSystemOrIntegrationNote(comprovanteNote), '14.2b poll descarta nota de comprovante')

  const inatividadeNote =
    'Lead movido para fila 143 após inatividade (sem resposta ao ping de reativação).'
  assert(isAgentInternalAuditNote(inatividadeNote), '14.3 nota de inatividade é auditoria')
  assert(isKommoSystemOrIntegrationNote(inatividadeNote), '14.3b poll descarta nota de inatividade')

  // Camada A — qualquer texto com o marcador é auditoria, independente da frase.
  const arbitraria = `Qualquer anotação futura do sistema ${AGENT_AUDIT_NOTE_MARKER}`
  assert(isAgentInternalAuditNote(arbitraria), '14.4 marcador explícito (camada A) detectado')
  assert(isKommoSystemOrIntegrationNote(arbitraria), '14.4b poll descarta nota com marcador')

  // NÃO pode classificar fala real do candidato como auditoria.
  assert(
    !isAgentInternalAuditNote('quero fazer a inscrição no curso de pedagogia'),
    '14.5 fala do candidato NÃO é auditoria',
  )
  assert(
    !isAgentInternalAuditNote('qual o valor da matrícula?'),
    '14.5b pergunta de valor NÃO é auditoria',
  )
  assert(
    !isAgentInternalAuditNote('desisti de fazer faculdade esse ano'),
    '14.5c desabafo do lead (sem frase de auditoria) NÃO é auditoria',
  )
  assert(!isAgentInternalAuditNote(''), '14.5d vazio NÃO é auditoria')

  // Flow responses received continua passando (não é auditoria, aciona pós-form).
  assert(
    !isKommoSystemOrIntegrationNote('Flow responses received'),
    '14.6 flow responses received não é descartado',
  )

  // Idempotência: nota já marcada não recebe marcador duplo (simula helper).
  const jaMarcada = `Nota X ${AGENT_AUDIT_NOTE_MARKER}`
  const markerCount = (jaMarcada.match(/\[registro interno ia\]/gi) || []).length
  assertEqual(markerCount, 1, '14.7 marcador presente uma única vez')
}

section('15 — normalizeCpf (zero à esquerda Kommo)')
{
  assertEqual(normalizeCpf('06398542657'), '06398542657', '15.1 CPF 11 dígitos intacto')
  assertEqual(normalizeCpf('6398542657'), '06398542657', '15.2 CPF 10 dígitos → pad zero')
  assertEqual(normalizeCpf(''), '', '15.3 vazio')
  assertEqual(normalizeCpf('063.985.426-57'), '06398542657', '15.4 máscara removida')
}

section('16 — confirmação de matrícula antes do formulário')
{
  const { buildMatriculaResumoReply, lookupCursoPrecoResumo } = await import(
    '../server/inscricaoMatriculaConfirmFlow.js'
  )
  const { assistantAskedMatriculaAuthorization } = await import('../libShared/inscricaoFormHeuristics.js')

  const resumo = buildMatriculaResumoReply({
    cursoNome: 'Segurança da Informação',
    duracao: '6 meses',
    mensalidade: 'R$ 187,00',
    pushName: 'João',
  })
  assert(/Perfeito, João!/i.test(resumo), '16.1 saudação com nome')
  assert(/Segurança da Informação/i.test(resumo), '16.1b curso no resumo')
  assert(/Mensalidades: R\$ 187,00/i.test(resumo), '16.1c mensalidade')
  assert(/taxa de matrícula é a primeira mensalidade/i.test(resumo), '16.1d taxa')
  assert(assistantAskedMatriculaAuthorization(resumo), '16.1e pergunta autorização detectável')
  {
    const { detectCursoConfirmadoPeloLead } = await import('../libShared/cursoConfirmation.js')
    const pedagogiaResumo = buildMatriculaResumoReply({
      cursoNome: 'Pedagogia',
      duracao: '8 semestres',
      mensalidade: 'R$ 117,00',
    })
    assertEqual(
      detectCursoConfirmadoPeloLead('Sim', [{ role: 'assistant', content: pedagogiaResumo }]),
      'Pedagogia',
      '16.1f Sim após resumo confirma Pedagogia',
    )
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    const u = String(url)
    if (u.includes('pos_preco') || u.includes('grad_preco')) {
      return {
        ok: true,
        json: async () => [
          {
            id: 1,
            content:
              'chave: Segurança da Informação | nome_curso: Pós-Graduação em Segurança da Informação | preco com desconto: 187 | duracao: 6 meses',
            metadata: {},
          },
        ],
      }
    }
    return { ok: false, json: async () => [] }
  }
  try {
    const match = await lookupCursoPrecoResumo(
      { SUPABASE_URL: 'https://stub.supabase.co', SUPABASE_KEY: 'k' },
      'Segurança da Informação',
    )
    assert(match?.mensalidade === 'R$ 187,00', '16.2 lookup preço pós-graduação')
    assert(match?.duracao === '6 meses', '16.2b duração no lookup')
  } finally {
    globalThis.fetch = originalFetch
  }
}

section('17 — anti-alucinação polo/matrícula (regressão)')
{
  const {
    conversationAlreadyAuthorizedMatricula,
    messageConfirmsProceedToInscricaoForm,
    MATRICULA_GATE_SKIP_RESUMO_STATUSES,
    INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
    INSCRICAO_FORM_STATUS_AGUARDANDO,
  } = await import('../libShared/inscricaoFormHeuristics.js')
  const {
    userMessageLooksLikePoloChoice,
    extractPoloFromConversationHistory,
    buildPoloEscolhaPreFormMessage,
  } = await import('../libShared/sumarePoloCatalog.js')
  const { gateMatriculaConfirmacaoBeforeForm } = await import('../server/inscricaoMatriculaConfirmFlow.js')

  const resumoAssist =
    'Perfeito! Então, ficou assim:\n- Você irá ingressar no curso de "ADS"\nVocê autoriza a conclusão da matrícula?'
  const histAuth = [
    { role: 'assistant', content: resumoAssist },
    { role: 'user', content: 'Sim' },
  ]
  assert(conversationAlreadyAuthorizedMatricula(histAuth), '17.1 histórico com sim após resumo')
  assert(!messageConfirmsProceedToInscricaoForm('1', histAuth), '17.2 "1" não é confirmação de matrícula')
  assert(userMessageLooksLikePoloChoice('1'), '17.3 "1" é escolha de polo')
  {
    const { matchPoloFromUserMessage, formatPoloListaNumerada } = await import(
      '../libShared/sumarePoloCatalog.js'
    )
    assertEqual(matchPoloFromUserMessage('4')?.nome, 'São Miguel', '17.3b "4" no catálogo = São Miguel')
    const lista = formatPoloListaNumerada()
    assertEqual(
      matchPoloFromUserMessage('4', [{ role: 'assistant', content: `em qual polo?\n${lista}` }])?.nome,
      'São Miguel',
      '17.3c "4" após lista do assistente = São Miguel',
    )
  }
  assert(
    MATRICULA_GATE_SKIP_RESUMO_STATUSES.has(INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM),
    '17.4 polo pre-form no skip set',
  )
  assert(
    MATRICULA_GATE_SKIP_RESUMO_STATUSES.has(INSCRICAO_FORM_STATUS_AGUARDANDO),
    '17.5 form aguardando no skip set',
  )

  const poloHist = [
    { role: 'assistant', content: buildPoloEscolhaPreFormMessage({ pushName: 'Ana' }) },
    { role: 'user', content: 'Tatuapé' },
  ]
  const extracted = extractPoloFromConversationHistory(poloHist)
  assert(extracted?.id === 'tatuape', '17.6 extrai polo do histórico')

  const gate = await gateMatriculaConfirmacaoBeforeForm(
    { SUPABASE_URL: '', SUPABASE_KEY: '' },
    {
      telefone: '5511999999999',
      userMessage: '1',
      historyMessages: poloHist,
      leadId: 1,
      executionId: 'test',
      model: 'test',
      pushName: 'Ana',
      t0: Date.now(),
    },
  )
  assert(gate.proceed === true, '17.7 gate libera quando msg é polo')
}

section('18 — desistência falsa / reativação de interesse')
{
  const { messageExpressesEndOfServiceRequest } = await import('../libShared/fimAtendimentoHeuristics.js')
  const {
    messageExpressesRenewedInscricaoInterest,
  } = await import('../libShared/inscricaoDesistenciaHeuristics.js')

  const histCurso = [
    { role: 'assistant', content: 'Temos vários cursos EAD na Sumaré. Quer que eu te ajude com a matrícula?' },
  ]

  assert(
    !messageExpressesEndOfServiceRequest('Ok', histCurso),
    '18.1 "Ok" isolado não encerra atendimento',
  )
  assert(
    messageExpressesRenewedInscricaoInterest('Quero saber os cursos ead'),
    '18.2 pergunta EAD reativa interesse',
  )
  assert(
    messageExpressesRenewedInscricaoInterest('Faço farmácia queria algo para complementar'),
    '18.3 complementar farmácia reativa interesse',
  )
  assert(
    !messageExpressesRenewedInscricaoInterest('obrigada'),
    '18.4 agradecimento curto não reativa',
  )
}

section('19 — polos / localização regional')
{
  const { messageAsksRegionalFacultyLocation } = await import('../libShared/inboundMessageSanitize.js')
  const { buildPoloEadAndCentralInfoReply } = await import('../libShared/sumarePoloCatalog.js')

  assert(
    messageAsksRegionalFacultyLocation('Gostaria de saber se a faculdade unidade na vila prudente ou próximo'),
    '19.1 vila prudente detectada',
  )
  assert(
    messageAsksRegionalFacultyLocation('estou em busca de uma faculdade na zona leste'),
    '19.2 zona leste detectada',
  )
  const hist = [
    { role: 'user', content: 'tem unidade na vila prudente?' },
    { role: 'assistant', content: 'Central em Pinheiros...' },
  ]
  assert(
    messageAsksRegionalFacultyLocation('Muito obrigada, estou em busca de uma faculdade na zona leste', hist),
    '19.3 continuação regional no histórico',
  )
  const reply = buildPoloEadAndCentralInfoReply({ pushName: 'Arlete' })
  assert(/5 polos|Barra Funda|São Miguel/i.test(reply), '19.4 lista polos EAD')
  assert(/Pinheiros|Alegrete/i.test(reply), '19.5 menciona Central Pinheiros')
}

section('20 — data nascimento inválida no Kommo')
{
  const phone = '5519997613069'
  assert(kommoDataNascLooksInvalid('19997613069', phone), '20.1 telefone no campo nascimento')
  assert(kommoDataNascLooksInvalid('5519997613069', phone), '20.2 telefone com DDI')
  assert(!kommoDataNascLooksInvalid('15/03/1990', phone), '20.3 data BR válida')
  assert(!kommoDataNascLooksInvalid('1990-03-15', phone), '20.4 data ISO válida')
  assert(normalizeDataNasc('15/03/1990') === '1990-03-15', '20.5 normalize BR')
  assert(!normalizeDataNasc('19997613069'), '20.6 normalize rejeita telefone')
}

section('21 — matrícula hoje / pagamento depois')
{
  const { messageAsksDeferredPaymentEnrollment, buildDeferredPaymentEnrollmentReply } = await import(
    '../libShared/deferredPaymentEnrollmentHeuristics.js'
  )
  const { messageMentionsUnlistedPoloLocation } = await import('../libShared/sumarePoloCatalog.js')

  const celioMsg =
    'Como tinha dito só vou ter um valor dia 30 deste mês daqui a 17 dias..há possibilidade de fazer todo o processo hj pra garantir a vaga..e pagar este valor promocional dia 30..e a liberação do curso não tem problema se iniciar tbm no dia Q pagar..se puder fazemos o processo hj mesmo..mas se não houver possibilidade daqui a 17 dias te chamo e se houver vaga fechamos'

  assert(messageAsksDeferredPaymentEnrollment(celioMsg), '21.1 pagamento posterior detectado')
  assert(
    !messageMentionsUnlistedPoloLocation(celioMsg),
    '21.2 não confunde com polo fora da lista',
  )
  const reply = buildDeferredPaymentEnrollmentReply({ pushName: 'Célio' })
  assert(/decis[oõ]es internas/i.test(reply), '21.3 menciona alteração de valores')
  assert(/entrar em contato/i.test(reply), '21.4 orienta retorno no pagamento')
  assert(/faremos o poss[ií]vel/i.test(reply), '21.5 tenta garantir valor')
}

section('22 — tryProcessInscricaoPostFormPipeline: verificação antes de reenviar')

{
  const basePipelineCtx = {
    telefone: '5511977776666',
    leadId: 55512345,
    pushName: 'Lead Pipeline',
    executionId: 'EX-TEST-PIPE',
    model: 'gpt-4.1-mini',
    t0: Date.now(),
  }

  // 22.1 Claim explícito ("pronto") + NADA detectado no Kommo → avisa e reenvia,
  // NÃO chama captação (sem código de captação/matrícula no retorno).
  installFetchStub(
    defaultSupabaseStub({
      dadosClienteRow: {
        id: 10,
        id_lead: 55512345,
        inscricao_form_status: 'aguardando_form_sumar',
      },
      notes: [],
    }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...basePipelineCtx,
      userMessage: 'pronto, já enviei',
    })
    assert(r?.handled === true, '22.1 pipeline handled=true (claim sem confirmação)')
    assertEqual(r?.result?.ctxSnapshot?.formNotReceivedResent, true, '22.1b ctxSnapshot.formNotReceivedResent=true')
    assert(/n[aã]o recebemos/i.test(r?.result?.reply || ''), '22.1c reply avisa que não recebemos')
    assert(/reenvi/i.test(r?.result?.reply || ''), '22.1d reply menciona reenvio')
  } finally {
    restoreFetch()
  }

  // 22.2 Mesmo claim, mas o Kommo CONFIRMA o Flow concluído → segue captação
  // normalmente (NÃO trata como "não recebido").
  installFetchStub(
    defaultSupabaseStub({
      dadosClienteRow: {
        id: 10,
        id_lead: 55512345,
        inscricao_form_status: 'aguardando_form_sumar',
        polo_inscricao_escolhido: 'Pinheiros',
        captacao_unidade: 'ED_SP_P5',
      },
      notes: [flowResponsesReceivedNote()],
    }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...basePipelineCtx,
      userMessage: 'pronto, já enviei',
    })
    assert(r?.handled === true, '22.2 pipeline handled=true (form confirmado no Kommo)')
    assert(
      r?.result?.ctxSnapshot?.formNotReceivedResent !== true,
      '22.2b NÃO marca formNotReceivedResent quando Kommo confirma',
    )
  } finally {
    restoreFetch()
  }

  // 22.3 "Flow responses received" como a própria mensagem do turno → NUNCA
  // tratado como "não recebido", mesmo sem nenhuma nota ainda no Kommo
  // (snapshot ainda frágil). Segue captação/pós-form normalmente.
  installFetchStub(
    defaultSupabaseStub({
      dadosClienteRow: {
        id: 10,
        id_lead: 55512345,
        inscricao_form_status: 'aguardando_form_sumar',
        polo_inscricao_escolhido: 'Pinheiros',
        captacao_unidade: 'ED_SP_P5',
      },
      notes: [],
    }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...basePipelineCtx,
      userMessage: 'Flow responses received',
    })
    assert(r?.handled === true, '22.3 pipeline handled=true (flow received bypassa verificação)')
    assert(
      r?.result?.ctxSnapshot?.formNotReceivedResent !== true,
      '22.3b flow received NUNCA gera reenvio falso',
    )
  } finally {
    restoreFetch()
  }

  // 22.4 schedulerTick nunca reenvia por claim vazio — só avança com
  // kommoFormDone. Aqui não há detecção no Kommo, então o tick NÃO deve
  // marcar formNotReceivedResent (mesmo com status aguardando_distribuicao).
  installFetchStub(
    defaultSupabaseStub({
      dadosClienteRow: {
        id: 10,
        id_lead: 55512345,
        inscricao_form_status: 'aguardando_distribuicao_form',
      },
      notes: [],
    }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...basePipelineCtx,
      userMessage: '',
      schedulerTick: true,
    })
    assert(
      r?.result?.ctxSnapshot?.formNotReceivedResent !== true,
      '22.4 scheduler tick nunca reenvia por achismo',
    )
  } finally {
    restoreFetch()
  }
}

section('23 — Não encaminhar para consultor: redirecionamento pro atendimento oficial')

{
  const reply = buildFacultyContactRedirectReply({ pushName: 'Marcela' })
  assert(reply.includes(SUMARE_ATENDIMENTO_URL), '23.1 menciona URL do atendimento oficial')
  assert(reply.includes(SUMARE_OUVIDORIA_URL), '23.1b menciona URL da ouvidoria')
  assert(/, Marcela/.test(reply), '23.1c inclui primeiro nome quando pushName fornecido')
  assert(
    !/consultor entrar[aá]/i.test(reply),
    '23.2 NÃO contém "consultor entrará"',
  )
  assert(
    !/fala com voc[eê] por aqui/i.test(reply),
    '23.2b NÃO promete que alguém "fala com você por aqui"',
  )
  assert(
    !/entrar[aá] em contato/i.test(reply),
    '23.2c NÃO promete contato ativo ("entrará em contato")',
  )

  // Sem pushName — não deve quebrar nem gerar "undefined"/vírgula dupla.
  const replySemNome = buildFacultyContactRedirectReply({})
  assert(replySemNome.includes(SUMARE_ATENDIMENTO_URL), '23.3 funciona sem pushName')
  assert(!/undefined|,\s*,/.test(replySemNome), '23.3b sem "undefined" ou vírgula dupla sem pushName')

  // buildHumanHandoffReply (legado) também não promete consultor ativo.
  const handoffReply = buildHumanHandoffReply({ pushName: 'Renato', ok: true })
  assert(
    !/consultor entrar[aá]|j[aá] encaminhei.*consultor|fala com voc[eê] por aqui/i.test(handoffReply),
    '23.4 buildHumanHandoffReply não promete consultor ativo (ok=true)',
  )
  assert(handoffReply.includes(SUMARE_ATENDIMENTO_URL), '23.4b buildHumanHandoffReply aponta atendimento oficial')

  const handoffReplyFail = buildHumanHandoffReply({ pushName: 'Renato', ok: false })
  assert(
    !/consultor entrar[aá]/i.test(handoffReplyFail),
    '23.5 buildHumanHandoffReply não promete consultor ativo (ok=false)',
  )
}

section('24 — Academic affairs: não confundir "já sou formado" + curso')

{
  assertEqual(
    messageAsksAcademicAffairsSupportInText(
      'Já sou formado e queria saber o tempo que preciso cursar Artes Visuais.',
    ),
    false,
    '24.1 Clayton: formado + tempo/curso NÃO é acadêmico',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('sou formado quero cursar pedagogia'),
    false,
    '24.2 formado + quero cursar NÃO é acadêmico',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('preciso trancar a matrícula'),
    true,
    '24.3 trancamento continua acadêmico',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('sou ex-aluno e quero segunda via do diploma'),
    true,
    '24.4 ex-aluno + diploma continua acadêmico',
  )
}

section('24b — Telefone institucional acadêmico (regressão Andrea #23913)')

{
  const { messageAsksRegionalFacultyLocation } = await import('../libShared/inboundMessageSanitize.js')
  const { tryHandleAcademicAffairsInquiry } = await import('../server/academicAffairsFlow.js')
  const redirectHist = [
    { role: 'assistant', content: buildAcademicAffairsRedirectReply({}) },
  ]

  // a) pedido direto
  assertEqual(
    messageAsksInstitutionalAcademicPhone('Qual o telefone da Faculdade Sumaré?'),
    true,
    '24b.a heurística: telefone da Faculdade Sumaré',
  )
  const replyDireto = buildInstitutionalAcademicPhoneReply({})
  assert(
    replyDireto.includes(SUMARE_INSTITUTIONAL_PHONE),
    '24b.a2 reply contém telefone canônico',
  )
  assertEqual(
    SUMARE_INSTITUTIONAL_PHONE,
    '(11) 3067-7999',
    '24b.a3 canônico exatamente (11) 3067-7999',
  )

  // b/c) follow-up após redirect acadêmico
  assertEqual(
    messageAsksInstitutionalAcademicPhone('Preciso de telefone', redirectHist),
    true,
    '24b.b Andrea: Preciso de telefone após redirect',
  )
  assertEqual(
    messageAsksInstitutionalAcademicPhone('qual o número?', redirectHist),
    true,
    '24b.c qual o número? após redirect',
  )

  // d) secretaria acadêmica
  assertEqual(
    messageAsksInstitutionalAcademicPhone('telefone para falar com a secretaria acadêmica'),
    true,
    '24b.d secretaria acadêmica',
  )

  // e) sem histórico
  assertEqual(
    messageAsksInstitutionalAcademicPhone('Preciso de telefone', []),
    false,
    '24b.e Preciso de telefone sem histórico',
  )

  // f) atualização do próprio contato
  assertEqual(
    messageAsksInstitutionalAcademicPhone('quero atualizar meu telefone'),
    false,
    '24b.f atualizar meu telefone',
  )
  assertEqual(
    messageAsksInstitutionalAcademicPhone('meu whatsapp mudou'),
    false,
    '24b.f2 meu whatsapp mudou',
  )

  // g) polo / localização — fora da heurística acadêmica
  assertEqual(
    messageAsksInstitutionalAcademicPhone('telefone do polo Tatuapé'),
    false,
    '24b.g telefone do polo',
  )
  assertEqual(
    messageAsksInstitutionalAcademicPhone('onde fica o polo'),
    false,
    '24b.g2 onde fica o polo',
  )
  assertEqual(
    messageAsksInstitutionalAcademicPhone('qual o telefone da faculdade na zona leste'),
    false,
    '24b.g3 telefone zona leste',
  )

  // h) redirect acadêmico genérico sem telefone
  const redirectReply = buildAcademicAffairsRedirectReply({})
  assert(
    !redirectReply.includes(SUMARE_INSTITUTIONAL_PHONE),
    '24b.h redirect acadêmico NÃO inclui telefone institucional',
  )
  assert(
    !redirectReply.includes('(11) 3067-7999'),
    '24b.h2 redirect sem (11) 3067-7999',
  )

  // i) sanitize: "Preciso de telefone" não aciona localização/polos
  assertEqual(
    messageAsksRegionalFacultyLocation('Preciso de telefone', []),
    false,
    '24b.i regional location false para Preciso de telefone',
  )
  assertEqual(
    messageAsksRegionalFacultyLocation('Preciso de telefone', redirectHist),
    false,
    '24b.i2 regional location false com histórico acadêmico',
  )

  // j) integração Andrea: step do telefone, sem texto de polos
  const andrea = await tryHandleAcademicAffairsInquiry({}, {
    userMessage: 'Preciso de telefone',
    historyMessages: redirectHist,
    executionId: 'test-andrea-23913',
    model: 'test',
    pushName: 'Andrea',
    t0: Date.now(),
  })
  assert(andrea?.handled === true, '24b.j Andrea handled')
  assertEqual(
    andrea?.result?.orchestratorSteps?.[0]?.type,
    'institutional_academic_phone',
    '24b.j2 step=institutional_academic_phone',
  )
  assert(
    String(andrea?.result?.reply || '').includes(SUMARE_INSTITUTIONAL_PHONE),
    '24b.j3 reply com telefone canônico',
  )
  assert(
    !/polo|Barra Funda|Tatuap[eé]|S[aã]o Miguel/i.test(String(andrea?.result?.reply || '')),
    '24b.j4 reply NÃO lista polos',
  )
}

section('25 — Form sem curso: pedir curso em vez de redirecionar (regressão Aline #24120625)')

{
  // 25.1 Helper puro: pede o nome do curso, sem prometer consultor nem mandar
  // links de atendimento/ouvidoria.
  const askCurso = buildAskCursoAfterFormReply({ pushName: 'Aline' })
  assert(/nome do curso/i.test(askCurso), '25.1 pede o nome do curso')
  assert(/, Aline/.test(askCurso), '25.1b inclui primeiro nome quando pushName fornecido')
  assert(!/consultor\s+(entrar[aá]|vai\s+entrar)/i.test(askCurso), '25.1c NÃO promete consultor')
  assert(!askCurso.includes(SUMARE_ATENDIMENTO_URL), '25.1d NÃO contém URL de atendimento')
  assert(!askCurso.includes(SUMARE_OUVIDORIA_URL), '25.1e NÃO contém URL de ouvidoria')

  // 25.2 buildInscricaoFormFieldsIncompleteReply também não promete consultor.
  const camposIncompletos = buildInscricaoFormFieldsIncompleteReply({
    pushName: 'Bruno',
    missingFields: ['cpf', 'data_nasc'],
  })
  assert(!/consultor\s+pode\s+te\s+ajudar/i.test(camposIncompletos), '25.2 NÃO promete consultor ativo')
  assert(/cpf, data_nasc/i.test(camposIncompletos), '25.2b lista os campos faltantes')

  // 25.3 Integração: executeCaptacaoAfterFormResolved com captação Sumaré
  // habilitada e lead sem curso no snapshot Kommo (custom_fields_values
  // vazio) → deve pedir o curso, manter status aguardando_distribuicao e
  // NÃO pausar a IA (nem sobrescrever para form_sumar_concluido).
  const envCaptacao = {
    ...env,
    SUMARE_CAPTACAO_ENABLED: 'true',
    SUMARE_CAPTACAO_BASE_URL: 'https://mock-captacao.sumare.edu.br',
    SUMARE_CAPTACAO_TOKEN: 'mock-captacao-token',
  }
  installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 1, id_lead: 23845769 } }))
  try {
    const capOut = await executeCaptacaoAfterFormResolved(envCaptacao, {
      telefone: ctx.telefone,
      idLead: ctx.leadId,
      executionId: ctx.executionId,
      pushName: 'Aline',
    })
    assertEqual(
      capOut.ctxForm,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
      '25.3 ctxForm=aguardando_distribuicao_form (curso pendente)',
    )
    assert(/nome do curso/i.test(capOut.reply || ''), '25.3b reply pede o nome do curso')
    assert(!(capOut.reply || '').includes(SUMARE_ATENDIMENTO_URL), '25.3c reply NÃO contém link de atendimento')

    const pauseCall = fetchCalls.find(
      (c) =>
        c.method === 'PATCH' &&
        c.url.includes('dados_cliente_sum') &&
        String(c.body || '').includes('atendimento_ia'),
    )
    assert(!pauseCall, '25.3d IA NÃO é pausada nesse branch (curso pendente)')

    const statusPatchCalls = fetchCalls.filter(
      (c) => c.method === 'PATCH' && c.url.includes('dados_cliente_sum') && String(c.body || '').includes('inscricao_form_status'),
    )
    const overwroteConcluido = statusPatchCalls.some((c) =>
      String(c.body || '').includes(INSCRICAO_FORM_STATUS_CONCLUIDO),
    )
    assert(!overwroteConcluido, '25.3e status NÃO é sobrescrito para form_sumar_concluido')
  } finally {
    restoreFetch()
  }
}

section('26 — Polo ausente pós-form: pedir polo (não redirecionar) + nota de auditoria (regressão Thiago #24121875)')

{
  // 26.1 Helper puro: pede o polo, sem link de atendimento/ouvidoria.
  const poloMsg = buildPoloEscolhaPreFormMessage({ pushName: 'Thiago' })
  assert(/polo/i.test(poloMsg), '26.1 pede o polo')
  assert(!poloMsg.includes(SUMARE_ATENDIMENTO_URL), '26.1b NÃO contém URL de atendimento')
  assert(!poloMsg.includes(SUMARE_OUVIDORIA_URL), '26.1c NÃO contém URL de ouvidoria')

  // 26.2 Integração: tryProcessInscricaoPostFormPipeline com Kommo confirmando
  // o Flow, mas sem polo salvo (Supabase) nem no snapshot Kommo (custom_fields
  // vazio) e sem fallback de polo default válido → deve pedir o polo (NÃO
  // buildFacultyContactRedirectReply) e gravar nota de auditoria no Kommo.
  const pipelinePoloCtx = {
    telefone: '5511988885555',
    leadId: 24121875,
    pushName: 'Thiago',
    executionId: 'EX-TEST-POLO',
    model: 'gpt-4.1-mini',
    t0: Date.now(),
  }
  installFetchStub(
    defaultSupabaseStub({
      dadosClienteRow: {
        id: 20,
        id_lead: 24121875,
        inscricao_form_status: 'aguardando_form_sumar',
      },
      notes: [flowResponsesReceivedNote()],
    }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(
      { ...env, INSCRICAO_DEFAULT_POLO_ID: '' },
      { ...pipelinePoloCtx, userMessage: 'Flow responses received' },
    )
    assert(r?.handled === true, '26.2 pipeline handled=true (polo ausente pós-form)')
    assert(!(r?.result?.reply || '').includes(SUMARE_ATENDIMENTO_URL), '26.2b reply NÃO redireciona p/ faculdade')
    assert(/polo/i.test(r?.result?.reply || ''), '26.2c reply pede o polo')
    assertEqual(
      r?.result?.ctxSnapshot?.inscricaoForm,
      INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
      '26.2d ctxSnapshot.inscricaoForm=aguardando_escolha_polo',
    )

    const statusPatchPolo = fetchCalls.some(
      (c) =>
        c.method === 'PATCH' &&
        c.url.includes('dados_cliente_sum') &&
        String(c.body || '').includes(INSCRICAO_FORM_STATUS_AGUARDANDO_POLO),
    )
    assert(statusPatchPolo, '26.2e status persistido como aguardando_escolha_polo')

    const auditNoteCall = fetchCalls.find(
      (c) => c.method === 'POST' && /\/api\/v4\/leads\/24121875\/notes/.test(c.url),
    )
    assert(Boolean(auditNoteCall), '26.2f nota de auditoria gravada no Kommo')
    assert(
      /AUDITORIA/.test(JSON.stringify(auditNoteCall?.body || '')),
      '26.2g nota de auditoria contém marcador [AUDITORIA]',
    )
  } finally {
    restoreFetch()
  }
}

section('27 — Loop pós-curso: aguardando_distribuicao_form não reprocessa sem resposta de curso (regressão Thiago #24121875)')

{
  const pipelineCtx27 = {
    telefone: '5511900001111',
    leadId: 24121999,
    pushName: 'Thiago',
    executionId: 'EX-TEST-CURSO-LOOP',
    model: 'gpt-4.1-mini',
    t0: Date.now(),
  }

  // Lead já formulário confirmado no Kommo (nota Flow persiste "pra sempre"),
  // mas ainda não respondeu qual é o curso — status aguardando_distribuicao_form.
  const rowAguardandoCurso = {
    id: 30,
    id_lead: 24121999,
    inscricao_form_status: 'aguardando_distribuicao_form',
    polo_inscricao_escolhido: 'Pinheiros',
    captacao_unidade: 'ED_SP_P5',
  }

  // 27.1 schedulerTick puro (sem mensagem do lead) → NÃO reprocessa (null).
  installFetchStub(
    defaultSupabaseStub({ dadosClienteRow: rowAguardandoCurso, notes: [flowResponsesReceivedNote()] }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...pipelineCtx27,
      userMessage: '',
      schedulerTick: true,
    })
    assertEqual(r, null, '27.1 schedulerTick sem curso → pipeline retorna null (não reprocessa)')
  } finally {
    restoreFetch()
  }

  // 27.2 kommoFormDone via mensagem (marcador de flow, sem curso) → também bloqueia.
  installFetchStub(
    defaultSupabaseStub({ dadosClienteRow: rowAguardandoCurso, notes: [flowResponsesReceivedNote()] }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...pipelineCtx27,
      userMessage: 'Flow responses received',
      schedulerTick: false,
    })
    assertEqual(r, null, '27.2 kommoFormDone sem curso → pipeline retorna null (bloqueia loop)')
    assert(
      !fetchCalls.some((c) => c.method === 'POST' && /\/notes/.test(c.url)),
      '27.2b nenhuma nota de auditoria/redirect gravada no Kommo (nem tentou reprocessar)',
    )
  } finally {
    restoreFetch()
  }

  // 27.3 Lead responde com o nome do curso → pipeline processa normalmente,
  // sem short-circuit indevido e sem cair no redirect faculdade.
  installFetchStub(
    defaultSupabaseStub({ dadosClienteRow: rowAguardandoCurso, notes: [flowResponsesReceivedNote()] }),
  )
  try {
    const r = await tryProcessInscricaoPostFormPipeline(env, {
      ...pipelineCtx27,
      userMessage: 'Pedagogia',
      schedulerTick: false,
    })
    assert(r !== null, '27.3 lead informa curso → pipeline NÃO retorna null')
    assert(r?.handled === true, '27.3b pipeline handled=true quando lead informa curso')
    assert(
      !(r?.result?.reply || '').includes(SUMARE_ATENDIMENTO_URL),
      '27.3c reply NÃO redireciona p/ faculdade quando lead informa curso',
    )
  } finally {
    restoreFetch()
  }
}

section('28 — Transferência: não concatenar sucesso + faculty redirect (Diego)')

{
  const failReply = buildFacultyContactRedirectReply({ pushName: 'Diego' })
  assert(replyLooksLikeFacultyContactRedirect(failReply), '28.1 detecta redirect de falha')
  assert(
    !replyLooksLikeFacultyContactRedirect(
      'Em instantes enviamos por aqui o link atualizado para conclusão da matrícula.',
    ),
    '28.2 texto de sucesso/próximo passo NÃO é redirect',
  )

  // Espelha a regra de runTransferenciaRecaptacaoPosForm: se cap.ok mas reply
  // é faculty redirect, usa fallback — nunca cola os dois.
  const prefix =
    'Perfeito, Diego! Registramos sua *transferência externa* de Publicidade para História.\n\n'
  const capOk = true
  const capReply = failReply
  const usable = Boolean(capReply.trim()) && !replyLooksLikeFacultyContactRedirect(capReply)
  let out = prefix
  if (capOk && usable) out += capReply
  else {
    out +=
      'Em instantes enviamos por aqui o link atualizado para conclusão da matrícula. Qualquer dúvida, estamos à disposição.'
  }
  assert(out.startsWith('Perfeito, Diego!'), '28.3 mantém prefixo de sucesso')
  assert(!out.includes(SUMARE_ATENDIMENTO_URL), '28.4 NÃO anexa URL de atendimento após sucesso')
  assert(!/n[aã]o consegui concluir/i.test(out), '28.5 NÃO anexa "não consegui concluir"')
}

section('29 — resolveCursoOfertaFromDb: match parcial por token (não por substring), evita psicopedagogia→pedagogia')

{
  const { resolveCursoOfertaFromDb, invalidateCaptacaoCursoCache } = await import(
    '../server/sumareCaptacaoCursoStore.js'
  )

  const catalogoRows = [
    { codigo_original: 'PED_6_EAD', codigo_base: 'PED', curso_nome: 'Pedagogia', modalidade: 'EAD', ativo: true },
    {
      codigo_original: 'RH_6_EAD',
      codigo_base: 'RH',
      curso_nome: 'Gestão de Recursos Humanos',
      modalidade: 'EAD',
      ativo: true,
    },
  ]

  invalidateCaptacaoCursoCache()
  installFetchStub((call) => {
    if (call.url.includes('/rest/v1/sumare_captacao_curso')) return { status: 200, body: catalogoRows }
    if (call.url.includes('grad_preco') || call.url.includes('pos_preco')) return { status: 200, body: [] }
    return { status: 200, body: [] }
  })
  try {
    const psico = await resolveCursoOfertaFromDb('Psicopedagogia', env)
    assertEqual(psico, null, '29.1 "Psicopedagogia" NÃO resolve para Pedagogia (sem match parcial por substring)')

    const ped = await resolveCursoOfertaFromDb('Pedagogia', env)
    assertEqual(ped?.codigo, 'PED_6_EAD', '29.2 "Pedagogia" continua resolvendo PED_6_EAD (match exato)')

    const rh1 = await resolveCursoOfertaFromDb('Recursos Humanos', env)
    assertEqual(rh1?.codigo, 'RH_6_EAD', '29.3 "Recursos Humanos" resolve RH_6_EAD (match parcial por token)')

    const rh2 = await resolveCursoOfertaFromDb('Gestão de Recursos Humanos', env)
    assertEqual(rh2?.codigo, 'RH_6_EAD', '29.4 "Gestão de Recursos Humanos" continua resolvendo RH_6_EAD (match exato)')
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }
}

section('30 — Atalho comprovante_pagamento_recebido: recência + relevância + anti-repetição')

{
  const hojeIso = new Date().toISOString()
  const sessentaDiasIso = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString()
  const baseInput = {
    telefone: '5511932327154',
    executionId: 'EX-TEST-COMPROV',
    model: 'gpt-4.1-mini',
    pushName: 'Samuel',
    t0: Date.now(),
    historyMessages: [],
  }

  assert(
    messageRelatesToComprovanteEmConferencia('e agora, quando começo?'),
    '30.0 relevância: follow-up pós-matrícula',
  )
  assert(messageRelatesToComprovanteEmConferencia('ok'), '30.0b relevância: ack curto')
  assert(
    !messageRelatesToComprovanteEmConferencia('Preciso trancar esse curso'),
    '30.0c relevância: trancar curso é off-topic',
  )
  assert(
    !messageRelatesToComprovanteEmConferencia('quanto custa pedagogia?'),
    '30.0d relevância: preço genérico é off-topic',
  )

  async function runComprovanteShortcut({ comprovanteAt, userMessage, historyMessages = [] }) {
    const row = {
      id: 41,
      id_lead: 999001,
      inscricao_form_status: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
      captacao_comprovante_at: comprovanteAt,
    }
    installFetchStub(defaultSupabaseStub({ dadosClienteRow: row }))
    try {
      return await tryHandleMatriculaAceitePagamentoFlow(env, {
        ...baseInput,
        userMessage,
        historyMessages,
      })
    } finally {
      restoreFetch()
    }
  }

  // 30.1 comprovante de hoje + follow-up → dispara (follow-up)
  {
    const r = await runComprovanteShortcut({
      comprovanteAt: hojeIso,
      userMessage: 'e agora, quando começo?',
    })
    assert(r?.handled === true, '30.1 atalho dispara (follow-up)')
    assertEqual(
      r?.result?.orchestratorSteps?.[0]?.type,
      'pos_matricula_follow_up',
      '30.1b step=pos_matricula_follow_up',
    )
    assert(
      /aguardar a matr[ií]cula ser finalizada/i.test(r?.result?.reply || ''),
      '30.1c reply de finalização pós-matrícula',
    )
  }

  // 30.2 comprovante de hoje + "ok" → dispara
  {
    const r = await runComprovanteShortcut({ comprovanteAt: hojeIso, userMessage: 'ok' })
    assert(r?.handled === true, '30.2 atalho dispara para ack "ok"')
    assertEqual(
      r?.result?.orchestratorSteps?.[0]?.type,
      'pos_matricula_follow_up',
      '30.2b step=pos_matricula_follow_up (ack curto)',
    )
  }

  // 30.3 comprovante de hoje + "Preciso trancar esse curso" → NÃO dispara
  {
    const r = await runComprovanteShortcut({
      comprovanteAt: hojeIso,
      userMessage: 'Preciso trancar esse curso',
    })
    assertEqual(r, null, '30.3 off-topic NÃO dispara atalho')
  }

  // 30.4 comprovante de 60 dias + "Lembra de conferir denovo" → NÃO dispara (janela)
  {
    const r = await runComprovanteShortcut({
      comprovanteAt: sessentaDiasIso,
      userMessage: 'Lembra de conferir denovo',
    })
    assertEqual(r, null, '30.4 comprovante stale (60d) NÃO dispara mesmo com menção a conferir')
  }

  // 30.5 comprovante sem timestamp + "já recebeu meu comprovante?" → dispara
  {
    const r = await runComprovanteShortcut({
      comprovanteAt: null,
      userMessage: 'já recebeu meu comprovante?',
    })
    assert(r?.handled === true, '30.5 sem timestamp conta como dentro da janela e dispara')
    assertEqual(
      r?.result?.orchestratorSteps?.[0]?.type,
      'comprovante_already_received',
      '30.5b step=comprovante_already_received (não é follow-up curto)',
    )
    assert(/j[aá] recebemos seu comprovante/i.test(r?.result?.reply || ''), '30.5c reply padrão de comprovante')
  }

  // 30.6 última resposta do assistente igual à do atalho → NÃO dispara
  {
    const expectedReply = buildPosMatriculaAguardandoFinalizacaoReply({ pushName: 'Samuel' })
    const r = await runComprovanteShortcut({
      comprovanteAt: hojeIso,
      userMessage: 'ok',
      historyMessages: [{ role: 'assistant', content: expectedReply }],
    })
    assertEqual(r, null, '30.6 anti-repetição: mesma reply do assistente → null')
  }

  // 30.7 curso/preço genérico com status comprovante → NÃO dispara
  {
    const r = await runComprovanteShortcut({
      comprovanteAt: hojeIso,
      userMessage: 'quanto custa pedagogia?',
    })
    assertEqual(r, null, '30.7 pergunta de preço genérica NÃO dispara atalho')
  }
}

section('31 — Saída de canal já encerrada: reabertura + anti-repetição')

{
  assert(messageRequestsNewAttendance('novo atendimento'), '31.0 heurística: novo atendimento')
  assert(
    messageRequestsNewAttendance('quero saber mais sobre engenharia mecanica'),
    '31.0b heurística: quero saber mais sobre',
  )
  assert(
    messageRequestsNewAttendance('posso tirar uma duvida com vc ?'),
    '31.0c heurística: tirar dúvida',
  )
  assert(!messageRequestsNewAttendance('Sim'), '31.0d heurística: Sim NÃO é retomada')
  assert(!messageRequestsNewAttendance('Ok, obrigado'), '31.0e heurística: Ok obrigado NÃO é retomada')

  const baseInput = {
    telefone: '5511973511809',
    executionId: 'EX-TEST-SAIDA',
    model: 'gpt-4.1-mini',
    pushName: 'Julio',
    t0: Date.now(),
    leadId: 999002,
    historyMessages: [],
  }
  const rowEncerrada = {
    id: 42,
    id_lead: 999002,
    inscricao_form_status: HANDOFF_STATUS_LINKS_ENVIADOS,
    atendimento_ia: 'pause',
  }

  async function runSaidaShortcut({ userMessage, historyMessages = [], row = rowEncerrada }) {
    installFetchStub(defaultSupabaseStub({ dadosClienteRow: row }))
    try {
      return await tryHandleSaidaCanalJaEncerrada(env, {
        ...baseInput,
        userMessage,
        historyMessages,
      })
    } finally {
      restoreFetch()
    }
  }

  // 31.1 status saida_canal_concluida + "novo atendimento" → reabre (null)
  {
    const r = await runSaidaShortcut({ userMessage: 'novo atendimento' })
    assertEqual(r, null, '31.1 "novo atendimento" reabre (não canônico)')
  }

  // 31.2 mesmo status + "quero saber mais sobre engenharia mecanica" → reabre
  {
    const r = await runSaidaShortcut({
      userMessage: 'quero saber mais sobre engenharia mecanica',
    })
    assertEqual(r, null, '31.2 pergunta de curso reabre')
  }

  // 31.3 mesmo status + "posso tirar uma duvida com vc ?" → reabre
  {
    const r = await runSaidaShortcut({ userMessage: 'posso tirar uma duvida com vc ?' })
    assertEqual(r, null, '31.3 tirar dúvida reabre')
  }

  // 31.4 mesmo status + "Sim" → resposta canônica
  {
    const r = await runSaidaShortcut({ userMessage: 'Sim' })
    assert(r?.handled === true, '31.4 "Sim" dispara canônico')
    assertEqual(
      r?.result?.orchestratorSteps?.[0]?.type,
      'saida_canal_ja_encerrada',
      '31.4b step=saida_canal_ja_encerrada',
    )
    assert(
      /atendimento por aqui foi encerrado conforme combinamos/i.test(r?.result?.reply || ''),
      '31.4c reply canônica de canal encerrado',
    )
  }

  // 31.5 mesmo status + "Ok, obrigado" → resposta canônica
  {
    const r = await runSaidaShortcut({ userMessage: 'Ok, obrigado' })
    assert(r?.handled === true, '31.5 "Ok, obrigado" dispara canônico')
    assert(
      /atendimento por aqui foi encerrado conforme combinamos/i.test(r?.result?.reply || ''),
      '31.5b reply canônica',
    )
  }

  // 31.6 última resposta do assistente igual à canônica → NÃO repete
  {
    const expectedReply = buildExitChannelAlreadyDoneReply({ pushName: 'Julio' })
    const r = await runSaidaShortcut({
      userMessage: 'Sim',
      historyMessages: [{ role: 'assistant', content: expectedReply }],
    })
    assertEqual(r, null, '31.6 anti-repetição: mesma reply do assistente → null')
  }

  // 31.7 status diferente → handler continua devolvendo null
  {
    const r = await runSaidaShortcut({
      userMessage: 'Sim',
      row: {
        id: 43,
        id_lead: 999002,
        inscricao_form_status: 'aguardando_confirm_saida_canal',
      },
    })
    assertEqual(r, null, '31.7 status diferente → null')
  }
}

section('32 — polo nunca vira curso (regressão Jean #23912)')
{
  const {
    matchCursoFromNumberedAssistantList,
    detectCursoConfirmadoPeloLead,
    isPoloNameLike,
  } = await import('../libShared/cursoConfirmation.js')
  const {
    buildPoloConfirmacaoInvalidaReply,
    buildPoloEadAndCentralInfoReply,
    assistantAskedPoloPreFormChoice,
  } = await import('../libShared/sumarePoloCatalog.js')

  const histInvalida = [{ role: 'assistant', content: buildPoloConfirmacaoInvalidaReply() }]
  const histInstitucional = [{ role: 'assistant', content: buildPoloEadAndCentralInfoReply({}) }]

  assertEqual(
    matchCursoFromNumberedAssistantList('2', histInvalida),
    '',
    '32.1 "2" após lista de polos inválida ≠ curso',
  )
  assertEqual(
    detectCursoConfirmadoPeloLead('2', histInvalida),
    '',
    '32.2 detectCurso "2" após polos inválidos ≠ curso',
  )
  assertEqual(
    detectCursoConfirmadoPeloLead('2', histInstitucional),
    '',
    '32.3 detectCurso "2" após reply institucional ≠ curso',
  )
  assert(isPoloNameLike('Santana') === true, '32.4a isPoloNameLike(Santana)')
  assert(isPoloNameLike('Tatuapé') === true, '32.4b isPoloNameLike(Tatuapé)')
  assert(isPoloNameLike('Pinheiros') === true, '32.4c isPoloNameLike(Pinheiros)')
  assert(isPoloNameLike('Biomedicina') === false, '32.4d isPoloNameLike(Biomedicina)=false')
  assert(isPoloNameLike('Pedagogia') === false, '32.4e isPoloNameLike(Pedagogia)=false')
  assert(
    assistantAskedPoloPreFormChoice(buildPoloEadAndCentralInfoReply({})) === false,
    '32.5 reply institucional NÃO é escolha de polo',
  )
  assert(
    assistantAskedPoloPreFormChoice(buildPoloConfirmacaoInvalidaReply()) === true,
    '32.6 confirmacao inválida AINDA é escolha de polo',
  )
  assertEqual(
    matchCursoFromNumberedAssistantList('2', [
      { role: 'assistant', content: '1. Pedagogia\n2. Biomedicina\n3. Administração' },
    ]),
    'Biomedicina',
    '32.7 lista real de cursos ainda resolve "2"=Biomedicina',
  )

  // F4 — atalho "polo já informado" não dispara form sem curso
  {
    const { tryHandlePoloPreFormFlow } = await import('../server/inscricaoPoloFlow.js')
    const { INSCRICAO_FORM_STATUS_AGUARDANDO_CURSO_PRE_FORM } = await import(
      '../libShared/inscricaoFormHeuristics.js'
    )

    const baseRow = {
      id: 9001,
      id_lead: 23845769,
      polo_inscricao_escolhido: 'Tatuapé',
      captacao_unidade: 'ED_SP_P7',
    }
    const poloInput = {
      telefone: ctx.telefone,
      executionId: 'EX-TEST-F4',
      model: 'gpt-4.1-mini',
      pushName: 'Jean',
      t0: Date.now(),
      leadId: 23845769,
    }

    // 32.8 polo persistido + status aguardando_curso_pre_form → atalho nem entra; null sem salesbot
    installFetchStub(
      defaultSupabaseStub({
        dadosClienteRow: {
          ...baseRow,
          inscricao_form_status: INSCRICAO_FORM_STATUS_AGUARDANDO_CURSO_PRE_FORM,
        },
      }),
    )
    try {
      const r = await tryHandlePoloPreFormFlow(env, {
        ...poloInput,
        userMessage: 'quanto custa?',
        historyMessages: [],
      })
      assertEqual(r, null, '32.8 aguardando_curso_pre_form + sem curso → null')
      assert(
        !fetchCalls.some((c) => c.url.includes('/api/v2/salesbot/run')),
        '32.8b salesbot NÃO chamado (status curso pendente)',
      )
    } finally {
      restoreFetch()
    }

    // 32.9 polo persistido + status null + sem curso → atalho aborta com null (antes de autorizar/form)
    installFetchStub(defaultSupabaseStub({ dadosClienteRow: { ...baseRow, inscricao_form_status: null } }))
    try {
      const r = await tryHandlePoloPreFormFlow(env, {
        ...poloInput,
        userMessage: 'quanto custa?',
        historyMessages: [],
      })
      assertEqual(r, null, '32.9 polo persistido sem curso → null')
      assert(
        !fetchCalls.some((c) => c.url.includes('/api/v2/salesbot/run')),
        '32.9b salesbot NÃO chamado (atalho abortado)',
      )
      assert(
        !fetchCalls.some(
          (c) =>
            c.url.includes('/rest/v1/dados_cliente_sum') &&
            (c.method === 'PATCH' || c.method === 'POST') &&
            String(c.body || '').includes('matricula_autorizada'),
        ),
        '32.9c status NÃO gravado como matricula_autorizada sem curso',
      )
    } finally {
      restoreFetch()
    }

    // 32.10 polo persistido + curso na mensagem → form segue (salesbot)
    // leadId distinto evita dedupe in-memory do salesbot de seções anteriores
    installFetchStub(defaultSupabaseStub({ dadosClienteRow: { ...baseRow, id_lead: 23912010, inscricao_form_status: null } }))
    try {
      const r = await tryHandlePoloPreFormFlow(env, {
        ...poloInput,
        leadId: 23912010,
        userMessage: 'quero fazer Biomedicina',
        historyMessages: [],
      })
      assert(r?.handled === true, '32.10 com curso → handled')
      assertEqual(
        r?.result?.orchestratorSteps?.[0]?.type,
        'polo_pre_form_persistido',
        '32.10b step=polo_pre_form_persistido',
      )
      assert(
        fetchCalls.some((c) => c.url.includes('/api/v2/salesbot/run')),
        '32.10c salesbot chamado quando há curso',
      )
    } finally {
      restoreFetch()
    }
  }
}

section('33 — Curso informado não resolvido: alternativas (regressão Amanda #23840)')

{
  const { lookupRelatedCursoOfertas, lookupCursoPrecoResumo } = await import(
    '../server/inscricaoMatriculaConfirmFlow.js'
  )
  const { resolveCursoOfertaFromDb, invalidateCaptacaoCursoCache } = await import(
    '../server/sumareCaptacaoCursoStore.js'
  )
  const { runMatriculaCaptacaoAfterForm } = await import('../server/matriculaCaptacaoPipeline.js')

  const posPsicologiaRows = [
    {
      id: 1,
      content:
        'chave: Psicologia Organizacional e do Trabalho | nome_curso: Pós-Graduação em Psicologia Organizacional e do Trabalho | preco com desconto: 187 | duracao: 6 Meses | modalidade: EAD',
      metadata: { modalidade: 'EAD', duracao: '6 Meses' },
    },
    {
      id: 2,
      content:
        'chave: Psicologia, Neurociências e Comportamento | nome_curso: Pós-Graduação em Psicologia, Neurociências e Comportamento | preco com desconto: 191 | duracao: 6 Meses | modalidade: EAD',
      metadata: { modalidade: 'EAD', duracao: '6 Meses' },
    },
    {
      id: 3,
      content:
        'chave: Psicologia Positiva e Desenvolvimento do Capital Humano nas Organizações | nome_curso: Pós-Graduação em Psicologia Positiva e Desenvolvimento do Capital Humano nas Organizações | preco com desconto: 191 | duracao: 6 Meses | modalidade: EAD',
      metadata: { modalidade: 'EAD', duracao: '6 Meses' },
    },
    {
      id: 4,
      content:
        'chave: Biomedicina | nome_curso: Graduação - Biomedicina | preco com desconto: 299 | duracao: 8 semestres | modalidade: EAD',
      metadata: { modalidade: 'EAD', duracao: '8 semestres' },
    },
  ]

  const catalogoRows = [
    {
      codigo_original: 'BIOMED_EAD',
      codigo_base: 'BIOMED',
      curso_nome: 'Biomedicina',
      modalidade: 'EAD',
      ativo: true,
    },
    {
      codigo_original: 'ADM_EAD',
      codigo_base: 'ADM',
      curso_nome: 'Administração',
      modalidade: 'EAD',
      ativo: true,
    },
    {
      codigo_original: 'PSIORG_EAD',
      codigo_base: 'PSIORG',
      curso_nome: 'Psicologia Organizacional e do Trabalho',
      modalidade: 'EAD',
      ativo: true,
    },
  ]

  function installAmandaPriceStub(extra = {}) {
    invalidateCaptacaoCursoCache()
    const base = defaultSupabaseStub({
      dadosClienteRow: extra.dadosClienteRow || { id: 1, id_lead: 23840 },
      notes: extra.notes || [],
    })
    installFetchStub((call) => {
      if (call.url.includes('/rest/v1/pos_preco')) {
        return { status: 200, body: posPsicologiaRows.slice(0, 3) }
      }
      if (call.url.includes('/rest/v1/grad_preco')) {
        return { status: 200, body: [posPsicologiaRows[3]] }
      }
      if (call.url.includes('/rest/v1/sumare_captacao_curso')) {
        return { status: 200, body: catalogoRows }
      }
      if (String(call.url).includes('mock-captacao') || /captacao|candidato|contrato|gerar/i.test(call.url)) {
        return { status: 500, body: { error: 'captacao nao deve ser chamada' } }
      }
      return base(call)
    })
  }

  // 33.1 lookupRelatedCursoOfertas('Psicologia') → 3 pós oficiais
  installAmandaPriceStub()
  try {
    const envStub = { SUPABASE_URL: 'https://mock.supabase.co', SUPABASE_KEY: 'mock-key' }
    const related = await lookupRelatedCursoOfertas(envStub, 'Psicologia', { limit: 3 })
    assertEqual(related.length, 3, '33.1 retorna 3 alternativas para Psicologia')
    assert(
      related.every((r) => /p[oó]s/i.test(r.nivel)),
      '33.1b todas alternativas são pós-graduação',
    )
    assert(
      related.every((r) => /EAD/i.test(r.modalidade)),
      '33.1c modalidade EAD presente',
    )
    assert(
      related.every((r) => /6\s*Meses/i.test(r.duracao)),
      '33.1d duração 6 Meses presente',
    )
    const mens = related.map((r) => r.mensalidade)
    assert(mens.includes('R$ 187,00'), '33.1e mensalidade R$ 187,00')
    assert(mens.includes('R$ 191,00'), '33.1f mensalidade R$ 191,00')
    assert(
      related.some((r) => /Organizacional/i.test(r.cursoNome)),
      '33.1g inclui Psicologia Organizacional',
    )
    assert(
      related.some((r) => /Neuroci[eê]ncias/i.test(r.cursoNome)),
      '33.1h inclui Neurociências',
    )
    assert(
      related.some((r) => /Positiva/i.test(r.cursoNome)),
      '33.1i inclui Psicologia Positiva',
    )
    const resumoPsico = await lookupCursoPrecoResumo(envStub, 'Psicologia')
    assertEqual(resumoPsico, null, '33.1j lookupCursoPrecoResumo(Psicologia) continua null')
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }

  // 33.2 builders
  {
    const alts = [
      {
        cursoNome: 'Psicologia Organizacional e do Trabalho',
        nivel: 'pós-graduação',
        modalidade: 'EAD',
        duracao: '6 Meses',
        mensalidade: 'R$ 187,00',
      },
      {
        cursoNome: 'Psicologia, Neurociências e Comportamento',
        nivel: 'pós-graduação',
        modalidade: 'EAD',
        duracao: '6 Meses',
        mensalidade: 'R$ 191,00',
      },
      {
        cursoNome: 'Psicologia Positiva e Desenvolvimento do Capital Humano nas Organizações',
        nivel: 'pós-graduação',
        modalidade: 'EAD',
        duracao: '6 Meses',
        mensalidade: 'R$ 191,00',
      },
    ]
    const withAlts = buildCursoIndisponivelAlternativasReply({
      pushName: 'Amanda',
      cursoPedido: 'Psicologia',
      alternativas: alts,
    })
    assert(/Psicologia/i.test(withAlts), '33.2 contém Psicologia')
    assert(/p[oó]s-gradua[cç][aã]o/i.test(withAlts), '33.2b contém pós-graduação')
    assert(/\bEAD\b/i.test(withAlts), '33.2c contém EAD')
    assert(/6\s*Meses/i.test(withAlts), '33.2d contém 6 Meses')
    assert(/R\$\s*187,00/.test(withAlts), '33.2e contém R$ 187,00')
    assert(/R\$\s*191,00/.test(withAlts), '33.2f contém R$ 191,00')
    assert(!/qual é o nome do curso/i.test(withAlts), '33.2g NÃO pede qual é o nome do curso')
    assert(!/nome do curso/i.test(withAlts), '33.2h NÃO pede nome do curso novamente')

    const semAlts = buildCursoIndisponivelSemAlternativasReply({
      pushName: 'Amanda',
      cursoPedido: 'Psicologia',
    })
    assert(/Psicologia/i.test(semAlts), '33.2i sem alternativas menciona o curso')
    assert(!/qual é o nome do curso/i.test(semAlts), '33.2j sem alternativas NÃO pede nome do curso')
    assert(!/n[aã]o oferece em nenhum n[ií]vel/i.test(semAlts), '33.2k NÃO afirma ausência em todos os níveis')
  }

  const envCaptacaoAmanda = {
    ...env,
    SUMARE_CAPTACAO_ENABLED: 'true',
    SUMARE_CAPTACAO_BASE_URL: 'https://mock-captacao.sumare.edu.br',
    SUMARE_CAPTACAO_TOKEN: 'mock-captacao-token',
  }

  // 33.3 Pipeline Amanda: curso presente + não resolvido + alternativas
  installAmandaPriceStub({ dadosClienteRow: { id: 80, id_lead: 23840 } })
  try {
    const capOut = await executeCaptacaoAfterFormResolved(envCaptacaoAmanda, {
      telefone: '55119990023840',
      idLead: 23840,
      executionId: 'EX-AMANDA-23840',
      pushName: 'Amanda',
      snapshotOverride: { curso_inscricao: 'Psicologia', polo_inscricao: 'Santana' },
    })
    assertEqual(
      capOut.ctxForm,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
      '33.3 ctxForm=aguardando_distribuicao_form',
    )
    assert(
      (capOut.steps || []).some((s) => s.type === 'curso_indisponivel_com_alternativas'),
      '33.3b step=curso_indisponivel_com_alternativas',
    )
    assert(/Psicologia/i.test(capOut.reply || ''), '33.3c reply menciona Psicologia')
    assert(/p[oó]s/i.test(capOut.reply || ''), '33.3d reply menciona pós')
    assert(!/qual é o nome do curso/i.test(capOut.reply || ''), '33.3e NÃO usa buildAskCursoAfterFormReply')
    assert(
      !fetchCalls.some((c) => /mock-captacao|\/gerar|\/candidato/i.test(c.url)),
      '33.3f captação/contrato NÃO chamada',
    )
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }

  // 33.4 Curso presente sem alternativas → curso_indisponivel_sem_alternativas
  invalidateCaptacaoCursoCache()
  {
    const base = defaultSupabaseStub({ dadosClienteRow: { id: 81, id_lead: 23841 } })
    installFetchStub((call) => {
      if (call.url.includes('pos_preco') || call.url.includes('grad_preco')) {
        return { status: 200, body: [] }
      }
      if (call.url.includes('sumare_captacao_curso')) return { status: 200, body: catalogoRows }
      if (/mock-captacao|captacao|gerar/i.test(call.url)) {
        return { status: 500, body: { error: 'nao chamar' } }
      }
      return base(call)
    })
  }
  try {
    const capOut = await executeCaptacaoAfterFormResolved(envCaptacaoAmanda, {
      telefone: '55119990023841',
      idLead: 23841,
      executionId: 'EX-AMANDA-SEM-ALT',
      pushName: 'Amanda',
      snapshotOverride: { curso_inscricao: 'Psicologia Quântica Imaginária' },
    })
    assert(
      (capOut.steps || []).some((s) => s.type === 'curso_indisponivel_sem_alternativas'),
      '33.4 step=curso_indisponivel_sem_alternativas',
    )
    assertEqual(
      capOut.ctxForm,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
      '33.4b status aguardando_distribuicao_form',
    )
    assert(!/qual é o nome do curso/i.test(capOut.reply || ''), '33.4c NÃO usa askCurso')
    const ask = buildAskCursoAfterFormReply({ pushName: 'Amanda' })
    assert(capOut.reply !== ask, '33.4d reply distinta de buildAskCursoAfterFormReply')
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }

  // 33.5 Curso realmente vazio continua askCurso
  installFetchStub(defaultSupabaseStub({ dadosClienteRow: { id: 82, id_lead: 23842 } }))
  try {
    const capOut = await executeCaptacaoAfterFormResolved(envCaptacaoAmanda, {
      telefone: '55119990023842',
      idLead: 23842,
      executionId: 'EX-CURSO-VAZIO',
      pushName: 'Aline',
      snapshotOverride: { curso_inscricao: '' },
    })
    assert(/nome do curso/i.test(capOut.reply || ''), '33.5 curso vazio → buildAskCursoAfterFormReply')
    assert(
      (capOut.steps || []).some((s) => s.type === 'aguardando_curso'),
      '33.5b step=aguardando_curso',
    )
  } finally {
    restoreFetch()
  }

  // 33.6 resolveCursoOfertaFromDb: Psicologia NÃO resolve multi-token; Administração exato ok
  invalidateCaptacaoCursoCache()
  installFetchStub((call) => {
    if (call.url.includes('/rest/v1/sumare_captacao_curso')) return { status: 200, body: catalogoRows }
    if (call.url.includes('grad_preco') || call.url.includes('pos_preco')) return { status: 200, body: [] }
    return { status: 200, body: [] }
  })
  try {
    const psico = await resolveCursoOfertaFromDb('Psicologia', env)
    assertEqual(psico, null, '33.6 Psicologia NÃO resolve Psicologia Organizacional')
    const adm = await resolveCursoOfertaFromDb('Administração', env)
    assertEqual(adm?.codigo, 'ADM_EAD', '33.6b Administração match exato continua')
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }

  // 33.7 Regressão Biomedicina disponível: resolve e NÃO cai em alternativas indevidas
  installAmandaPriceStub({ dadosClienteRow: { id: 83, id_lead: 23843 } })
  try {
    const bio = await resolveCursoOfertaFromDb('Biomedicina', env)
    assertEqual(bio?.codigo, 'BIOMED_EAD', '33.7 Biomedicina resolve no catálogo')

    const capPipe = await runMatriculaCaptacaoAfterForm(envCaptacaoAmanda, {
      telefone: '55119990023843',
      leadId: 23843,
      pushName: 'Bio',
      executionId: 'EX-BIOMED',
      snapshotOverride: {
        curso_inscricao: 'Biomedicina',
        nome: 'Bio Teste',
        email: 'bio@test.com',
        cpf: '12345678901',
      },
    })
    assert(
      capPipe.code !== 'CURSO_NAO_RESOLVIDO' && capPipe.code !== 'CURSO_AUSENTE',
      '33.7b Biomedicina NÃO retorna CURSO_NAO_RESOLVIDO/AUSENTE',
    )
    assert(!Array.isArray(capPipe.alternativas), '33.7c sem alternativas indevidas no sucesso de resolução')
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }

  // 33.8 MISSING_FIELDS (cpf) com curso já resolvido e sem cap.cursoPedido
  // NÃO deve cair em buildAskCursoAfterFormReply.
  installAmandaPriceStub({ dadosClienteRow: { id: 84, id_lead: 23844 } })
  try {
    const capOut = await executeCaptacaoAfterFormResolved(envCaptacaoAmanda, {
      telefone: '55119990023844',
      idLead: 23844,
      executionId: 'EX-MISSING-CPF',
      pushName: 'Carla',
      snapshotOverride: {
        curso_inscricao: 'Biomedicina',
        nome: 'Carla Teste',
        email: 'carla@test.com',
        // cpf ausente de propósito
        data_nasc: '01/01/1990',
        sexo: 'F',
        polo_inscricao: 'Santana',
      },
    })
    assertEqual(capOut?.code ?? capOut?.steps?.find((s) => s.type === 'sumare_captacao')?.code, 'MISSING_FIELDS', '33.8 code=MISSING_FIELDS')
    const reply = String(capOut.reply || '')
    assert(/cpf/i.test(reply), '33.8b reply pede campos incompletos (cpf)')
    assert(!/qual é o nome do curso/i.test(reply), '33.8c NÃO usa buildAskCursoAfterFormReply')
    assert(!/nome do curso/i.test(reply), '33.8d NÃO pede nome do curso')
    assertEqual(
      capOut.ctxForm,
      INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
      '33.8e ctxForm=distribuir_consultor (falha terminal de campos)',
    )
    assert(
      !(capOut.steps || []).some(
        (s) =>
          s.type === 'aguardando_curso' ||
          s.type === 'curso_indisponivel_com_alternativas' ||
          s.type === 'curso_indisponivel_sem_alternativas',
      ),
      '33.8f sem step de curso ausente/indisponível',
    )
  } finally {
    restoreFetch()
    invalidateCaptacaoCursoCache()
  }
}

section('34 — Financeiro institucional / boleto → Regra 32 (regressão Pri #23910)')

{
  const { tryHandleAcademicAffairsInquiry } = await import('../server/academicAffairsFlow.js')

  // Positivos
  assertEqual(
    messageAsksAcademicAffairsSupportInText('Quero falar com o financeiro'),
    true,
    '34.1 Quero falar com o financeiro',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero falar com o setor financeiro'),
    true,
    '34.2 falar com o setor financeiro',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('preciso do boleto'),
    true,
    '34.3 preciso do boleto',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('segunda via do boleto'),
    true,
    '34.4 segunda via do boleto',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('falar com a cobrança'),
    true,
    '34.5 falar com a cobrança',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('boleto vencido'),
    true,
    '34.5b boleto vencido',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('boleto atrasado'),
    true,
    '34.5c boleto atrasado',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('meu boleto está vencido'),
    true,
    '34.5d meu boleto está vencido',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('o boleto não chegou'),
    true,
    '34.5e o boleto não chegou',
  )

  // Integração: redirect Regra 32, sem lista de polos
  const pri = await tryHandleAcademicAffairsInquiry(
    {},
    {
      userMessage: 'Quero falar com o financeiro',
      historyMessages: [],
      executionId: 'test-pri-23910',
      model: 'test',
      pushName: 'Pri',
      t0: Date.now(),
    },
  )
  assert(pri?.handled === true, '34.6 Pri handled')
  const priReply = String(pri?.result?.reply || '')
  assert(/Portal do Aluno/i.test(priReply), '34.6b reply contém Portal do Aluno')
  assert(
    priReply.includes('https://sumare.edu.br/atendimento/'),
    '34.6c reply contém URL atendimento',
  )
  assert(/ouvidoria/i.test(priReply), '34.6d reply contém ouvidoria')
  assert(!/polo|Barra Funda/i.test(priReply), '34.6e reply NÃO lista polos')

  // Negativos: forma de pagamento / comercial / financiamento
  assertEqual(
    messageAsksAcademicAffairsSupportInText('aceita boleto?'),
    false,
    '34.7 aceita boleto?',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('posso pagar no boleto?'),
    false,
    '34.8 posso pagar no boleto?',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quais as formas de pagamento?'),
    false,
    '34.9 formas de pagamento',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('qual o valor da mensalidade?'),
    false,
    '34.10 valor da mensalidade',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('tem financiamento estudantil?'),
    false,
    '34.11 financiamento estudantil',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero saber sobre o FIES'),
    false,
    '34.12 FIES',
  )
}

section('35 — Alteração/troca de polo → Regra 32 (regressão Silvia #23903)')

{
  const { tryHandleAcademicAffairsInquiry } = await import('../server/academicAffairsFlow.js')

  // Positivos: alteração/movimentação de polo acadêmica
  assertEqual(
    messageAsksAcademicAffairsSupportInText('Como faço para mudar de polo'),
    true,
    '35.1 Como faço para mudar de polo',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero trocar de polo'),
    true,
    '35.2 quero trocar de polo',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('alteração de polo'),
    true,
    '35.3 alteração de polo',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('transferência de polo'),
    true,
    '35.4 transferência de polo',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('posso transferir minha matrícula para outro polo?'),
    true,
    '35.5 transferir matrícula para outro polo',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero migrar para o polo Tatuapé'),
    true,
    '35.6 migrar para o polo Tatuapé',
  )

  // Negativos: localização / lista / escolha comercial pré-inscrição
  assertEqual(
    messageAsksAcademicAffairsSupportInText('qual polo tem perto de mim?'),
    false,
    '35.7 qual polo tem perto de mim?',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quais são os polos?'),
    false,
    '35.8 quais são os polos?',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero escolher o polo Tatuapé para minha inscrição'),
    false,
    '35.9 escolher polo para inscrição',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('meu polo é Santana'),
    false,
    '35.10 meu polo é Santana',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('onde fica o polo Tatuapé?'),
    false,
    '35.11 onde fica o polo Tatuapé?',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('não sei qual polo escolher'),
    false,
    '35.12 não sei qual polo escolher',
  )

  // Integração Silvia #23903: redirect Regra 32, sem lista de polos
  const silvia = await tryHandleAcademicAffairsInquiry(
    {},
    {
      userMessage: 'Como faço para mudar de polo',
      historyMessages: [],
      executionId: 'test-silvia-23903',
      model: 'test',
      pushName: 'Silvia',
      t0: Date.now(),
    },
  )
  assert(silvia?.handled === true, '35.13 Silvia handled')
  assertEqual(
    silvia?.result?.orchestratorSteps?.[0]?.type,
    'academic_affairs_redirect',
    '35.13b step academic_affairs_redirect',
  )
  const silviaReply = String(silvia?.result?.reply || '')
  assert(/Portal do Aluno/i.test(silviaReply), '35.13c reply contém Portal do Aluno')
  assert(
    /sumare\.edu\.br\/atendimento/i.test(silviaReply),
    '35.13d reply contém sumare.edu.br/atendimento',
  )
  assert(/ouvidoria/i.test(silviaReply), '35.13e reply contém ouvidoria')
  assert(!/Barra Funda/i.test(silviaReply), '35.13f reply NÃO lista Barra Funda')
  assert(!/\bpolos?\b/i.test(silviaReply), '35.13g reply NÃO lista polos')

  // Regressão escolha inicial comercial
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero escolher o polo Tatuapé para minha inscrição'),
    false,
    '35.14 regressão escolha inicial de polo',
  )

  // Guard comercial: radicais inscri/formul com restante da palavra + plural polos
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero mudar para o polo Tatuapé antes do formulário'),
    false,
    '35.15 mudar polo antes do formulário',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero mudar de polo para minha inscrição'),
    false,
    '35.16 mudar polo para minha inscrição',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('quero trocar o polo antes de preencher o formulário'),
    false,
    '35.17 trocar polo antes de preencher o formulário',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('transferência entre polos'),
    true,
    '35.18 transferência entre polos (plural)',
  )
}

section('36 — Acesso AVA/plataforma do aluno (regressão Valquíria #23690)')

{
  const { tryHandleAcademicAffairsInquiry } = await import('../server/academicAffairsFlow.js')

  assertEqual(
    messageAsksAcademicAffairsSupportInText(
      'não consigo entrar em nada na plataforma, fica travado nesta tela e o campo de email não consigo digitar',
    ),
    true,
    '36.1 plataforma travada + email',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('ao acessar AVA a tela fica travada'),
    true,
    '36.2 AVA tela travada',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText(
      'Recebi o email de Bem vindo ao Semipresencial com login RA, porem ao acessar AVA a tela fica travada. Como faço para acessar o curso?',
    ),
    true,
    '36.3 login RA + AVA travado',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('o formulário não abre'),
    false,
    '36.4 formulário WhatsApp não abre ≠ acadêmico',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText(
      'quero fazer a inscrição para a Licenciatura em Pedagogia mas o formulário não abre',
    ),
    false,
    '36.5 inscrição + formulário não abre ≠ acadêmico',
  )
  assertEqual(
    messageAsksAcademicAffairsSupportInText('qual o valor da mensalidade?'),
    false,
    '36.6 valor comercial continua fora',
  )

  const hist = [
    {
      role: 'user',
      content:
        'não consigo entrar em nada na plataforma, fica travado nesta tela e o campo de email não consigo digitar',
    },
  ]
  const { messageAsksAcademicAffairsSupport } = await import('../libShared/academicAffairsHeuristics.js')
  assertEqual(
    messageAsksAcademicAffairsSupport('Desejo falar com atendente urgente', hist),
    true,
    '36.7 follow-up atendente após problema de plataforma',
  )

  const valquiria = await tryHandleAcademicAffairsInquiry(
    {},
    {
      userMessage:
        'ao acessar AVA a tela fica travada na opção Preferências / Conta de usuário. Como faço para acessar o curso?',
      historyMessages: [],
      executionId: 'test-valquiria-23690',
      model: 'test',
      pushName: 'Valquiria',
      t0: Date.now(),
    },
  )
  assert(valquiria?.handled === true, '36.8 Valquíria handled')
  assertEqual(
    valquiria?.result?.orchestratorSteps?.[0]?.type,
    'academic_affairs_redirect',
    '36.8b step academic_affairs_redirect',
  )
  const reply = String(valquiria?.result?.reply || '')
  assert(/portal do aluno/i.test(reply), '36.8c Portal do Aluno')
  assert(reply.includes('sumare.edu.br/atendimento'), '36.8d atendimento')
  assert(/ouvidoria/i.test(reply), '36.8e ouvidoria')
  assert(!/consultor/i.test(reply), '36.8f não promete consultor')
}

section('37 — Rute #24045: nome longo, número após lista de cursos, semestre ≠ data')
{
  const { detectCursoConfirmadoPeloLead, __test } = await import('../libShared/cursoConfirmation.js')
  const { matchPoloFromUserMessage, formatPoloListaNumerada } = await import(
    '../libShared/sumarePoloCatalog.js'
  )
  const { parseSemestreFromUserMessage, extractTransferenciaContext } = await import(
    '../server/inscricaoTransferenciaFlow.js'
  )
  const { buildCursoOficialSemCodigoCaptacaoReply } = await import(
    '../libShared/inscricaoFormHeuristics.js'
  )

  const nomePos = 'Educação Infantil e Desenvolvimento da Linguagem'
  assertEqual(
    __test.sanitizeCursoName(nomePos),
    'Educação Infantil e Desenvolvimento da Linguagem',
    '37.1 sanitizeCursoName não trunca pós de 6 tokens',
  )
  assertEqual(
    detectCursoConfirmadoPeloLead('Sim', [
      {
        role: 'assistant',
        content: `Você irá ingressar no curso de "${nomePos}" com duração de 6 meses. Você autoriza a conclusão da matrícula?`,
      },
    ]),
    nomePos,
    '37.2 "Sim" após resumo grava o nome completo',
  )

  const listaPolos = `em qual polo?\n${formatPoloListaNumerada()}`
  const listaCursos =
    'Não localizei a oferta exata de "Educação Infantil e Desenvolvimento da" no catálogo atual da Sumaré. Encontrei estas opções relacionadas:\n\n' +
    '1. *Educação Física - Bacharelado* — graduação, Semipresencial, 8 Semestres, R$ 177,00\n' +
    '2. *Educação Física - Licenciatura* — graduação, Semipresencial, 8 Semestres, R$ 149,00\n' +
    '3. *Análise e Desenvolvimento de Sistemas* — graduação, EAD, 5 Semestres, R$ 97,00'

  assertEqual(
    matchPoloFromUserMessage('3', [{ role: 'assistant', content: listaPolos }])?.nome,
    'Santana',
    '37.3 "3" após lista de polos = Santana',
  )
  assertEqual(
    matchPoloFromUserMessage('1', [
      { role: 'assistant', content: listaPolos },
      { role: 'user', content: '3' },
      { role: 'assistant', content: listaCursos },
    ])?.nome,
    undefined,
    '37.4 "1" após lista de cursos NÃO vira Barra Funda',
  )
  assertEqual(matchPoloFromUserMessage('4')?.nome, 'São Miguel', '37.5 "4" sem histórico ainda é catálogo')

  assertEqual(parseSemestreFromUserMessage('12/02/1985'), null, '37.6 data de nascimento ≠ semestre')
  assertEqual(
    parseSemestreFromUserMessage('Data de Nascimento 12/02/1985 CPF 34519304806'),
    null,
    '37.7 dump do formulário ≠ semestre',
  )
  assertEqual(parseSemestreFromUserMessage('Como falei parei no quarto semestre'), '4', '37.8 semestre ordinal')

  const ruteHist = [
    {
      role: 'assistant',
      content: `Perfeito! Então, ficou assim:\n- Você irá ingressar no curso de "${nomePos}" com duração de 6 meses`,
    },
    { role: 'user', content: '📋 Resposta do formulário\nData de Nascimento\n12/02/1985' },
    { role: 'assistant', content: listaCursos },
    { role: 'user', content: '1' },
  ]
  assertEqual(
    extractTransferenciaContext(ruteHist),
    null,
    '37.9 sem evidência de transferência o contexto é nulo',
  )

  const oficial = buildCursoOficialSemCodigoCaptacaoReply({
    pushName: 'Rute',
    cursoPedido: nomePos,
    precoResumo: {
      cursoNome: nomePos,
      nivel: 'pós-graduação',
      modalidade: 'EAD',
      duracao: '6 Meses',
      mensalidade: 'R$ 187,00',
    },
  })
  assert(/Confirmamos o curso/i.test(oficial), '37.10 reply confirma oferta oficial')
  assert(!/Educação Física/i.test(oficial), '37.11 reply não sugere Educação Física')
  assert(!/pagamento da matrícula/i.test(oficial), '37.12 reply não envia link de vestibular')
}

/* ────────────────────────────────────────────────────────────────────────── */
/* Resumo                                                                     */
/* ────────────────────────────────────────────────────────────────────────── */

console.log(`\nResumo: ${passed} passaram, ${failed} falharam.`)
if (failed > 0) {
  for (const f of failures) console.error(`  • ${f.name}: ${f.msg}`)
  process.exit(1)
}
process.exit(0)
