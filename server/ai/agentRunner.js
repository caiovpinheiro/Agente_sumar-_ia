/**
 * Versão server-side do loop do Playground: recebe a mensagem já “juntada” do
 * lead + telefone, monta o system (APAGAR.txt + override), injeta as últimas N
 * mensagens do n8n_chat_histories como turnos anteriores e roda até 5 rodadas
 * de tool_calls.
 */

import { loadPrompts, buildSystemMessage } from './promptsLoader.js'
import { classifyMessageScope } from './scopeClassifier.js'
import { getToolDefinitions, isActionTool } from './toolDefinitions.js'
import { buildToolExecutors } from './toolExecutorsServer.js'
import { runBuscarHistorico } from '../memoryTool.js'
import { readChatMessages } from '../historyStore.js'
import { mergeHistoriesDedupe, trimHistoryTail, mergeCrmAndSupabaseHistories } from '../../libShared/historyMerge.js'
import {
  detectCourseSwitchAgainstCrmState,
  normalizeCourseKey,
} from '../../libShared/courseStateDrift.js'
import { isEduitBackend, loadCrmRecentMessages, normalizeCrmLeadId, resolveCrmLeadId } from '../crmAdapter.js'
import { fetchLeadFormSnapshot } from '../inscricaoKommoFields.js'
import { generateExecutionId } from './executionTelemetry.js'
import { resolveModel } from './modelRegistry.js'
import { createExecutionContext } from './executionContext.js'
import {
  messageLooksCareerIncomeOpportunity,
  buildCommercialRedirectSearchQuery,
  isGreetingOnly,
  buildGreetingReply,
  shouldHandoffToHuman,
  shouldBypassScopeBlock,
} from '../../libShared/scopeHeuristics.js'
import { buildContextualGreetingReply, shouldUseContextualGreetingReply } from '../../libShared/conversationContextHeuristics.js'
import {
  detectCursoConfirmadoPeloLead,
  extractCursoAreaFromText,
  messageIsBareCourseSelection,
} from '../../libShared/cursoConfirmation.js'
import { setSumCursoOnLead, setSumPoloOnLead } from '../sumareLeadFields.js'
import { persistCadastroFieldsFromInbound } from '../cadastroCardSync.js'
import { tryHandleUnsupportedCourseLevelInquiry } from '../courseLevelInquiry.js'
import {
  tryHandleInscricaoFormComplete,
  tryHandleInscricaoFormStart,
  tryEnsureInscricaoFormSent,
  tryHandleMatriculaAceitePagamentoFlow,
  leadExplicitlyRequestsInscricaoForm,
  llmReplyImpliesPendingFormSend,
} from '../inscricaoFormFlow.js'
import { filterHistoryMessagesForAgent } from '../../libShared/historySanitize.js'
import { detectFormSumarRecebidoNoKommo } from '../inscricaoPostFormPipeline.js'
import { parseMetaFlowResponseJson, messageIsMetaFlowFormReply } from '../../libShared/metaFlowFormParser.js'
import { applyMetaFlowFormToKommo } from '../metaFlowFormSync.js'
import { tryHandleCaptacaoInscricaoExistenteFlow } from '../captacaoInscricaoExistenteFlow.js'
import { tryHandlePoloPreFormFlow, tryHandlePoloEscolhaFlow } from '../inscricaoPoloFlow.js'
import { tryHandleInscricaoFromKommoCard } from '../inscricaoKommoPreFilledFlow.js'
import { tryHandleApiSumareAdvancedEntry } from '../apiSumareAdvancedEntryFlow.js'
import { tryHandleMatriculaResumoConfirmacao } from '../inscricaoMatriculaConfirmFlow.js'
import {
  tryHandleTransferenciaDadosPendentes,
  tryHandleTransferenciaConfirmacao,
  tryHandleTransferenciaCursoRestate,
  extractTransferenciaContext,
  conversationMentionsTransferencia,
} from '../inscricaoTransferenciaFlow.js'
import { tryHandleAcademicAffairsInquiry } from '../academicAffairsFlow.js'
import { tryHandlePriceUntilCourseEndInquiry } from '../priceDurationFlow.js'
import { tryHandlePaymentDiscountInquiry } from '../paymentDiscountFlow.js'
import { maybeAuditActionToolFailure, recordInscricaoFailureAuditNote } from '../inscricaoFailureAudit.js'
import {
  tryHandleInscricaoDesistenciaFlow,
  tryHandleDesistenciaJaRegistrada,
  tryHandleDesistenciaConfirmEarly,
} from '../inscricaoDesistenciaFlow.js'
import { tryHandleFimAtendimentoFlow } from '../fimAtendimentoFlow.js'
import { tryHandlePoloLocationInfoFlow } from '../poloLocationInfoFlow.js'
import { tryHandleDeferredPaymentEnrollmentFlow } from '../deferredPaymentEnrollmentFlow.js'
import {
  startChannelExitConfirm,
  tryHandleChannelExitConfirmStep,
  tryHandleSaidaCanalJaEncerrada,
} from '../humanHandoffFlow.js'
import {
  messageExpressesCourseInterestOnly,
  messageLooksLikeFormSumarResponse,
  messageIsFlowResponsesReceived,
  messageIsFormularioSumarPreenchidoMarker,
  messageLooksLikeFormFollowUp,
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  matriculaPosFormAlreadyProcessed,
  inscricaoFormAlreadyFilled,
  messageConfirmsProceedToInscricaoForm,
  isShortEnrollmentConfirmation,
  assistantInEnrollmentStep,
  messageSignalsFormSubmissionAck,
  historyIndicatesFormSumarCompleted,
  conversationAlreadyAuthorizedMatricula,
} from '../../libShared/inscricaoFormHeuristics.js'
import { decideHoldOnIaPause, fetchDadosClienteByTelefone } from '../dadosClienteStore.js'
import { tryHandleGradePdfRequest } from '../gradeCurricularActionTools.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from '../dadosClienteInscricaoFields.js'
import { leadHasPostFormRegistradoNoteSinceLastFormSend } from '../postFormSendGuard.js'
import {
  conversationHasActiveTopic,
  extractDiscussedCourseFromHistory,
  assistantAskedEnrollmentInLastReply,
  userLikelyContinuingEnrollmentFlow,
  messageExpressesFrustrationAlreadySaid,
  lastAssistantText,
} from '../../libShared/conversationContextHeuristics.js'
import { messageIsInboundMediaPlaceholder } from '../../libShared/scopeHeuristics.js'
import {
  messageAsksCoursePrice,
  messageAsksPaymentInfo,
  messageAsksPoloAttendimentoList,
  messageAsksSemipresencialCentral,
  messageAsksTaxaMatriculaInstitucional,
  messageAsksPosGratisPromocao,
  messageAsksModalidadeMecOrDistancia,
  messageAsksCourseInquiry,
  messageAsksGradeCurricular,
  messageAsksGradePdf,
  messageAsksCampusOrPhoneContact,
  messageAsksLocationInfo,
  messageAsksRegionalFacultyLocation,
  messageAsksOuvidoria,
  sanitizeLeadInboundMessage,
} from '../../libShared/inboundMessageSanitize.js'
import {
  messageAsksAcademicAffairsSupport,
} from '../../libShared/academicAffairsHeuristics.js'
import { messageAsksPriceUntilCourseEnd } from '../../libShared/priceDurationHeuristics.js'
import { formatPoloListaNumerada, matchPoloFromUserMessage, userMessageLooksLikePoloChoice } from '../../libShared/sumarePoloCatalog.js'
import { userAsksCourseMoreDetails } from '../../libShared/courseMoreInfo.js'
import { validateReplyBeforeSend } from '../replyGuard.js'
import { buildLgpdSystemHint } from '../../libShared/lgpdCompliance.js'
import { autoSyncInscricaoStateFromReply } from '../inscricaoStateAutoSync.js'

const MAX_TOOL_ROUNDS = 5
const CHAT_URL = 'https://api.openai.com/v1/chat/completions'

function resolveHistoryLimit(env) {
  const n = Number(env.AGENT_HISTORY_CONTEXT || 8)
  return Number.isFinite(n) && n > 0 ? Math.min(50, Math.floor(n)) : 8
}

function envFlagBool(env, key, defaultValue = false) {
  const raw = env?.[key]
  if (raw == null || String(raw).trim() === '') return defaultValue
  const s = String(raw).trim().toLowerCase()
  if (['1', 'true', 'yes', 'on'].includes(s)) return true
  if (['0', 'false', 'no', 'off'].includes(s)) return false
  return defaultValue
}

function phoneDigits(value) {
  return String(value || '').replace(/\D/g, '')
}

/** Canary vazio = global; preenchido = só telefones listados (match por dígitos/sufixo). */
export function isPhoneInEduitHistoryCanary(env, telefone) {
  const raw = String(env?.AGENT_EDUIT_HISTORY_CANARY_PHONES || '').trim()
  if (!raw) return true
  const digits = phoneDigits(telefone)
  if (!digits) return false
  const allowed = raw
    .split(',')
    .map((p) => phoneDigits(p))
    .filter(Boolean)
  if (!allowed.length) return true
  return allowed.some((c) => digits === c || digits.endsWith(c) || c.endsWith(digits))
}

/**
 * Flags de histórico EduIT (somente backend eduit).
 * Shadow: busca/loga CRM mas não injeta. Enabled+!shadow: injeta via merge.
 */
export function resolveEduitHistoryMode(env, telefone) {
  if (!isEduitBackend(env)) {
    return { loadCrm: false, injectCrm: false, shadow: false, eligible: false }
  }
  const enabled = envFlagBool(env, 'AGENT_EDUIT_HISTORY_ENABLED', false)
  const shadow = envFlagBool(env, 'AGENT_EDUIT_HISTORY_SHADOW', false)
  if (!enabled && !shadow) {
    return { loadCrm: false, injectCrm: false, shadow: false, eligible: false }
  }
  if (!isPhoneInEduitHistoryCanary(env, telefone)) {
    return { loadCrm: false, injectCrm: false, shadow: false, eligible: false }
  }
  return {
    eligible: true,
    loadCrm: true,
    injectCrm: Boolean(enabled) && !shadow,
    shadow: Boolean(shadow),
  }
}

/** Pause hold nunca carrega CRM EduIT neste turno. */
export function shouldFetchEduitCrmHistory({ pauseHold, mode } = {}) {
  if (pauseHold) return false
  return Boolean(mode?.loadCrm)
}

export function isEduitCourseDriftEnabled(env) {
  if (!isEduitBackend(env)) return false
  return envFlagBool(env, 'AGENT_EDUIT_COURSE_DRIFT_ENABLED', true)
}

export function shouldBlockStaleEnrollmentActions(courseSwitch) {
  return Boolean(courseSwitch?.switched || courseSwitch?.staleUnknown)
}

/** Impede SUM_CURSO_UPDATE regressivo para o curso `previous` após troca. */
export function shouldSkipRegressiveSumCurso(courseSwitch, cursoConfirmado) {
  if (!courseSwitch?.switched || !courseSwitch?.previous) return false
  const confirmedKey = normalizeCourseKey(cursoConfirmado)
  const previousKey = normalizeCourseKey(courseSwitch.previous)
  if (!confirmedKey || !previousKey) return false
  return confirmedKey === previousKey
}

export function buildCourseDriftSystemHints(courseSwitch) {
  if (!courseSwitch) return { driftHint: null, suppressStaleFormHints: false }
  if (courseSwitch.switched) {
    const prev = courseSwitch.previous || 'anterior'
    const curr = courseSwitch.current || 'atual em discussão'
    return {
      suppressStaleFormHints: true,
      driftHint: {
        role: 'system',
        content:
          `TROCA DE CURSO DETECTADA: inscrição/polo/formulário/link do curso anterior (${prev}) estão OBSOLETOS. ` +
          `Responda sobre o curso atual (${curr}). OBRIGATÓRIO: buscar_conhecimento e/ou buscar_precos do curso atual. ` +
          'Peça confirmação explícita do lead antes de qualquer novo formulário/polo/link. ' +
          'PROIBIDO afirmar que formulário, matrícula ou link já foram enviados/processados com base no estado antigo. ' +
          'Se a mensagem for só "sim"/confirmação curta, esclareça o que está sendo confirmado (curso atual) antes de avançar inscrição.',
      },
    }
  }
  if (courseSwitch.staleUnknown) {
    return {
      suppressStaleFormHints: true,
      driftHint: {
        role: 'system',
        content:
          'ESTADO DE CURSO INCERTO: o card/CRM tem um curso, mas o histórico recente não confirma o mesmo tema. ' +
          'PROIBIDO afirmar automaticamente que formulário/link já foram enviados. ' +
          'Peça clarificação contextual (qual curso ou o que o "sim" confirma) antes de polo/formulário/link.',
      },
    }
  }
  return { driftHint: null, suppressStaleFormHints: false }
}

export function summarizeCourseSwitchForSnapshot(courseSwitch) {
  if (!courseSwitch) return null
  return {
    switched: Boolean(courseSwitch.switched),
    staleUnknown: Boolean(courseSwitch.staleUnknown),
    confidence: courseSwitch.confidence || null,
    previous: courseSwitch.previous || null,
    current: courseSwitch.current || null,
    previousKey: normalizeCourseKey(courseSwitch.previous) || null,
    currentKey: normalizeCourseKey(courseSwitch.current) || null,
    stageAtSwitch: courseSwitch.stageAtSwitch || null,
  }
}

/**
 * Carrega histórico recente da conversa.
 *
 * Tenta `n8n_chat_histories` primeiro (formato LangChain, fonte canônica).
 * Se vier vazio, faz fallback pra `chat_messages` — que é populada pelo
 * nosso webhook E pelo n8n legado, e cobre o cenário "turno anterior
 * existe mas não está em n8n_chat_histories" (n8n antigo, falha
 * silenciosa do appendChatMemory etc).
 *
 * No backend EduIT (flags/canary), opcionalmente busca CRM e faz merge
 * priorizado (`mergeCrmAndSupabaseHistories`). Shadow só observa.
 *
 * Retorna { messages, source, sourceDetail } pra logs/ctxSnapshot.
 */
function sanitizeHistoryMessages(messages) {
  return filterHistoryMessagesForAgent(messages)
}

function supabaseHistorySource(n8nMsgs, chatMsgs, mergedLen) {
  if (!mergedLen) return 'empty'
  if (n8nMsgs.length && chatMsgs.length) return 'merged_n8n_chat'
  if (n8nMsgs.length) return 'n8n_chat_histories'
  return 'chat_messages_fallback'
}

async function loadRecentHistoryMessages(env, telefone, { pauseHold = false } = {}) {
  const emptyDetail = {
    supabaseSource: 'none',
    crmLoaded: false,
    crmInjected: false,
    exclusiveEduit: false,
    shadow: false,
    counts: { n8n: 0, chat: 0, crm: 0, merged: 0 },
  }
  if (!telefone) return { messages: [], source: 'none', sourceDetail: emptyDetail }
  const limit = resolveHistoryLimit(env)
  const maxTail = Math.max(limit * 2, 16)

  let n8nMsgs = []
  let chatMsgs = []
  try {
    const out = await runBuscarHistorico(env, { telefone, limit })
    if (out.ok && Array.isArray(out.mensagens) && out.mensagens.length > 0) {
      n8nMsgs = sanitizeHistoryMessages(
        out.mensagens
          .map((m) => {
            if (m.role === 'lead') return { role: 'user', content: m.content }
            if (m.role === 'assistente') return { role: 'assistant', content: m.content }
            return null
          })
          .filter(Boolean),
      )
    }
  } catch (err) {
    console.warn('[agentRunner] histórico (n8n_chat_histories) indisponível:', err.message)
  }

  try {
    chatMsgs = sanitizeHistoryMessages(await readChatMessages(env, telefone, limit))
  } catch (err) {
    console.warn('[agentRunner] histórico (chat_messages fallback) indisponível:', err.message)
  }

  const supabaseMerged = trimHistoryTail(mergeHistoriesDedupe(n8nMsgs, chatMsgs), maxTail)
  const supabaseSource = supabaseHistorySource(n8nMsgs, chatMsgs, supabaseMerged.length)
  const mode = resolveEduitHistoryMode(env, telefone)
  const sourceDetail = {
    supabaseSource,
    crmLoaded: false,
    crmInjected: false,
    exclusiveEduit: false,
    shadow: Boolean(mode.shadow),
    counts: {
      n8n: n8nMsgs.length,
      chat: chatMsgs.length,
      crm: 0,
      merged: supabaseMerged.length,
    },
  }

  const baseReturn = () => ({
    messages: supabaseMerged,
    source: supabaseSource,
    sourceDetail,
  })

  if (!shouldFetchEduitCrmHistory({ pauseHold, mode })) {
    return baseReturn()
  }

  const eduitLimitRaw = Number(env?.AGENT_EDUIT_HISTORY_LIMIT)
  const eduitLimit =
    Number.isFinite(eduitLimitRaw) && eduitLimitRaw > 0
      ? Math.min(100, Math.floor(eduitLimitRaw))
      : 20
  const minExclusiveRaw = Number(env?.AGENT_EDUIT_HISTORY_MIN_EXCLUSIVE_TURNS)
  const minExclusive =
    Number.isFinite(minExclusiveRaw) && minExclusiveRaw > 0
      ? Math.floor(minExclusiveRaw)
      : 4

  let crmMsgs = []
  let crmMeta = { ok: false, source: null, code: null }
  try {
    const crm = await loadCrmRecentMessages(env, { telefone, limit: eduitLimit })
    sourceDetail.crmLoaded = true
    crmMeta = { ok: Boolean(crm?.ok), source: crm?.source || null, code: crm?.code || null }
    sourceDetail.crmOk = crmMeta.ok
    sourceDetail.crmSource = crmMeta.source
    sourceDetail.crmCode = crmMeta.code
    if (crm?.ok && Array.isArray(crm.messages)) {
      crmMsgs = sanitizeHistoryMessages(crm.messages)
    }
  } catch (err) {
    sourceDetail.crmLoaded = true
    sourceDetail.crmOk = false
    sourceDetail.crmError = String(err?.message || err).slice(0, 120)
    console.warn('[agentRunner] histórico EduIT (CRM) indisponível — degradando:', err.message)
  }

  sourceDetail.counts.crm = crmMsgs.length
  console.log(
    `[agentRunner] EDUIT_HISTORY load ok=${crmMeta.ok} inject=${mode.injectCrm} shadow=${mode.shadow} ` +
      `counts n8n=${n8nMsgs.length} chat=${chatMsgs.length} crm=${crmMsgs.length} exclusiveMin=${minExclusive}`,
  )

  // Shadow ou falha/vazio: não injeta CRM; mantém histórico anterior.
  if (!mode.injectCrm || !crmMsgs.length || crmMeta.ok === false) {
    return baseReturn()
  }

  try {
    const mergedCrm = mergeCrmAndSupabaseHistories(
      { crmMsgs, chatMsgs, n8nMsgs },
      { minExclusiveTurns: minExclusive, maxTail },
    )
    sourceDetail.crmInjected = true
    sourceDetail.exclusiveEduit = Boolean(mergedCrm.exclusiveEduit)
    sourceDetail.counts = {
      n8n: n8nMsgs.length,
      chat: chatMsgs.length,
      crm: crmMsgs.length,
      merged: mergedCrm.messages.length,
      ...(mergedCrm.counts || {}),
    }
    const source = mergedCrm.exclusiveEduit ? 'eduit_exclusive' : 'eduit_merged'
    console.log(
      `[agentRunner] EDUIT_HISTORY injected source=${source} exclusive=${sourceDetail.exclusiveEduit} ` +
        `merged=${mergedCrm.messages.length}`,
    )
    return { messages: mergedCrm.messages, source, sourceDetail }
  } catch (err) {
    console.warn('[agentRunner] merge CRM+Supabase falhou — degradando:', err.message)
    sourceDetail.crmInjected = false
    return baseReturn()
  }
}

/** "sim" após inscrição: recupera curso do Kommo se o histórico veio incompleto. */
async function enrichHistoryForShortEnrollmentConfirm(env, leadId, userMessage, historyMessages) {
  if (!isShortEnrollmentConfirmation(userMessage)) return historyMessages
  if (assistantAskedEnrollmentInLastReply(historyMessages)) return historyMessages
  if (!leadId) return historyMessages
  try {
    const snap = await fetchLeadFormSnapshot(env, leadId)
    if (!snap.ok || !snap.snapshot) return historyMessages
    const curso = String(snap.snapshot.sum_curso || snap.snapshot.curso || '').trim()
    if (!curso) return historyMessages
    return [
      ...historyMessages,
      {
        role: 'assistant',
        content: `Quer que eu te ajude com a inscrição no curso de ${curso}?`,
      },
    ]
  } catch {
    return historyMessages
  }
}

// Confirmações curtas/ambíguas — quando o lead manda só isso e a memória
// está vazia, a IA tendia a ALUCINAR um curso (caso "Administração" da
// EX-260506-1702-057). Lista mantida estreita pra não bloquear respostas
// legítimas.
const AMBIGUOUS_SHORT_REPLIES = new Set([
  'sim', 's', 'isso', 'claro', 'ok', 'okay', 'beleza', 'pode ser',
  'tá', 'ta', 'ta bom', 'ta bem', 'tá bom', 'tá bem',
  'não', 'nao', 'n', 'não entendi', 'nao entendi',
  '?', '??', '???',
])

function isAmbiguousShortReply(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '')
  if (!t) return false
  if (t.length > 18) return false
  return AMBIGUOUS_SHORT_REPLIES.has(t)
}

const OPENAI_RETRY_STATUSES = new Set([429, 500, 502, 503])

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms))
}

async function callOpenAI(env, apiMessages, model, tools) {
  const apiKey = env.OPENAI_API_KEY || env.VITE_OPENAI_API_KEY
  if (!apiKey) throw new Error('OPENAI_API_KEY não configurada')
  const maxAttempts = Math.min(4, Math.max(1, Number(env.OPENAI_CHAT_RETRY_ATTEMPTS) || 3))
  let lastErr = null
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const res = await fetch(CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages: apiMessages,
        tools,
        temperature: 0.7,
        max_tokens: 2048,
      }),
    })
    if (res.ok) return res.json()
    const body = await res.text().catch(() => '')
    lastErr = new Error(`OpenAI ${res.status}: ${body.slice(0, 200)}`)
    if (!OPENAI_RETRY_STATUSES.has(res.status) || attempt >= maxAttempts) throw lastErr
    const backoff = attempt * 1200
    console.warn(
      `[callOpenAI] tentativa ${attempt}/${maxAttempts} falhou HTTP ${res.status} — retry em ${backoff}ms`,
    )
    await sleepMs(backoff)
  }
  throw lastErr || new Error('OpenAI falhou após retries')
}

function buildOpenAiTransientFallbackReply() {
  return (
    'Desculpe, tive uma instabilidade momentânea ao processar sua mensagem. ' +
    'Em alguns segundos pode enviar de novo que continuo o atendimento, tudo bem?'
  )
}

function isOpenAiTransientError(err) {
  return /OpenAI (429|500|502|503)\b/.test(String(err?.message || err || ''))
}

async function executeToolCalls(executors, toolCalls, trace, ctx, auditCtx = {}) {
  const results = []
  /**
   * Tools de ação de inscrição retornam `{ ok, code, text, replyOverride, ctxSnapshot, steps }`.
   * Coletamos aqui para o orquestrador encerrar o loop e usar `replyOverride` como reply final.
   */
  const actionResults = []
  for (const tc of toolCalls) {
    const fn = tc.function
    const step = { tool: fn.name, args: {}, result: null, error: null, durationMs: 0 }
    const executor = executors[fn.name]
    if (!executor) {
      step.error = `Ferramenta "${fn.name}" não disponível`
      trace.push(step)
      results.push({ tool_call_id: tc.id, role: 'tool', content: step.error })
      continue
    }
    const t0 = Date.now()
    try {
      const args = JSON.parse(fn.arguments || '{}')
      step.args = args
      const result = await executor(args)
      step.durationMs = Date.now() - t0
      const isActionToolCall = isActionTool(fn.name)
      const isStructured = result && typeof result === 'object' && !Array.isArray(result)
      if (isActionToolCall && isStructured) {
        step.result = result.text || result.code || 'ok'
        step.actionOk = Boolean(result.ok)
        step.actionCode = result.code || null
        step.replyOverride = result.replyOverride || null
        step.ctxSnapshot = result.ctxSnapshot || null
        actionResults.push({ tool: fn.name, result })
        if (result.ok === false && auditCtx.env) {
          await maybeAuditActionToolFailure(auditCtx.env, {
            telefone: auditCtx.telefone,
            leadId: auditCtx.leadId,
            executionId: auditCtx.executionId,
          }, result)
        }
        results.push({
          tool_call_id: tc.id,
          role: 'tool',
          content: String(result.text || result.code || 'ok'),
        })
      } else {
        step.result = result || 'Nenhum resultado encontrado na base.'
        results.push({ tool_call_id: tc.id, role: 'tool', content: String(step.result) })
      }
    } catch (e) {
      step.error = e.message
      step.durationMs = Date.now() - t0
      results.push({ tool_call_id: tc.id, role: 'tool', content: `Erro: ${e.message}` })
    }
    // Anexa o trace de "auditoria" do query rewrite (se for tool de
    // busca vetorial). Vem do executionContext, populado em
    // toolExecutorsServer.vectorSearch.
    if (ctx?.consumeToolTrace) {
      const qrTrace = ctx.consumeToolTrace(fn.name)
      if (qrTrace) step.queryRewrite = qrTrace
    }
    trace.push(step)
  }
  return { results, actionResults }
}

/**
 * @param {object} env    process.env
 * @param {object} input  { telefone, userMessage, pushName, executionId?, leadId? }
 * @returns { ok, reply, toolCalls[], usage, durationMs, executionId, model, aiMeta }
 *   `aiMeta` agrega usage de sub-chamadas (query rewrite, tools com LLM
 *   próprio, embeddings) — usado pelo dashboard pra calcular custo real.
 */
export async function runAgent(env, input) {
  const t0 = Date.now()
  const telefone = input?.telefone || ''
  const rawUserMessage = (input?.userMessage || '').trim()
  const userMessage = sanitizeLeadInboundMessage(rawUserMessage)
  if (rawUserMessage && userMessage !== rawUserMessage) {
    console.log(
      `[${input?.executionId || 'agent'}] INBOUND_SANITIZE rawLen=${rawUserMessage.length} cleanLen=${userMessage.length} preview="${userMessage.slice(0, 120)}"`,
    )
  }
  const executionId = input?.executionId || generateExecutionId()
  const resolvedLeadId = await resolveCrmLeadId(env, telefone, input?.leadId)
  const leadId = resolvedLeadId || (isEduitBackend(env) ? null : normalizeCrmLeadId(input?.leadId, env))
  const model = resolveModel(env, 'orchestrator')
  const ctx = createExecutionContext()
  if (!userMessage) return { ok: false, error: 'Mensagem vazia', executionId, model, aiMeta: ctx.toAiMeta() }

  const formFlowCtx = { telefone, userMessage, historyMessages: [], executionId, model, leadId, pushName: input?.pushName, t0 }
  const eduitHistoryMode = resolveEduitHistoryMode(env, telefone)
  // Com injeção EduIT habilitada, adia aceite/captação até após histórico+drift
  // (estado Supabase antigo não pode capturar "Sim" do curso novo).
  const deferStateEarlyHandlers = Boolean(eduitHistoryMode.injectCrm)

  if (telefone) {
    if (!deferStateEarlyHandlers) {
      const inscricaoExistenteFlow = await tryHandleCaptacaoInscricaoExistenteFlow(env, formFlowCtx)
      if (inscricaoExistenteFlow?.handled) {
        console.log(
          `[${executionId}] CAPTACAO_INSCRICAO_EXISTENTE status=${inscricaoExistenteFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
        )
        return {
          ...inscricaoExistenteFlow.result,
          historyLoaded: 0,
          aiMeta: ctx.toAiMeta(),
        }
      }

      const aceiteFlow = await tryHandleMatriculaAceitePagamentoFlow(env, formFlowCtx)
      if (aceiteFlow?.handled) {
        console.log(
          `[${executionId}] MATRICULA_ACEITE_PAGAMENTO step=${aceiteFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
        )
        return {
          ...aceiteFlow.result,
          historyLoaded: 0,
          aiMeta: ctx.toAiMeta(),
        }
      }
    }

    // Desistência já concluída: precisa rodar ANTES do gate `atendimento_ia=pause`,
    // senão o lead que voltar a falar fica sem nenhuma resposta. O handler
    // completo (oferecer/confirmar desistência) continua rodando mais abaixo,
    // após o load de histórico.
    const desistenciaJaFlow = await tryHandleDesistenciaJaRegistrada(env, formFlowCtx)
    if (desistenciaJaFlow?.handled) {
      console.log(
        `[${executionId}] DESISTENCIA_JA_REGISTRADA telefone=${telefone}`,
      )
      return {
        ...desistenciaJaFlow.result,
        historyLoaded: 0,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const desistenciaConfirmEarly = await tryHandleDesistenciaConfirmEarly(env, formFlowCtx)
    if (desistenciaConfirmEarly?.handled) {
      console.log(
        `[${executionId}] DESISTENCIA_CONFIRM_EARLY telefone=${telefone}`,
      )
      return {
        ...desistenciaConfirmEarly.result,
        historyLoaded: 0,
        aiMeta: ctx.toAiMeta(),
      }
    }

    // Saída do canal já concluída (links enviados): responde com os canais
    // oficiais em vez de silêncio — roda ANTES do gate atendimento_ia=pause.
    const saidaJaFlow = await tryHandleSaidaCanalJaEncerrada(env, formFlowCtx)
    if (saidaJaFlow?.handled) {
      console.log(`[${executionId}] SAIDA_CANAL_JA_ENCERRADA telefone=${telefone}`)
      return {
        ...saidaJaFlow.result,
        historyLoaded: 0,
        aiMeta: ctx.toAiMeta(),
      }
    }

  }

  // Gate `ia_paused` é responsabilidade do caller (webhookEvolution faz o
  // check antes do drain — ver flushSessionInner). Aqui mantemos a checagem
  // apenas como rede de segurança para callers alternativos (playground/
  // server.js POST /api/agent/run) que invocam runAgent direto. Quando o
  // caller já checou (skipPauseCheck:true), evitamos round-trip a Supabase.
  if (telefone && !input?.skipPauseCheck) {
    const pauseRow = await fetchDadosClienteByTelefone(
      env,
      telefone,
      'atendimento_ia,inscricao_form_status,inscricao_form_recebido_at,captacao_candidato_id,captacao_contrato_link,captacao_contrato_link_at',
    )
    const pauseDecision = decideHoldOnIaPause(pauseRow)
    if (pauseDecision.hold) {
      console.log(`[${executionId}] IA pausada (atendimento_ia=pause) telefone=${telefone}`)
      return {
        ok: true,
        reply: null,
        iaPaused: true,
        skipped: true,
        toolCalls: [],
        orchestratorSteps: [{ type: 'ia_paused', durationMs: Date.now() - t0 }],
        ctxSnapshot: { iaPaused: true },
        usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
        durationMs: Date.now() - t0,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
      }
    }
    if (pauseDecision.paused && pauseDecision.reason) {
      console.log(
        `[${executionId}] ia_paused early_handler=${pauseDecision.reason} telefone=${telefone} — orquestrador liberado`,
      )
    }
  }

  const [prompts, historyResult] = await Promise.all([
    loadPrompts(env),
    loadRecentHistoryMessages(env, telefone),
  ])
  let historyMessages = historyResult.messages
  const historySource = historyResult.source
  const historySourceDetail = historyResult.sourceDetail || null

  let courseSwitch = null
  let blockStaleEnrollment = false
  let suppressStaleFormHints = false
  let courseDriftHint = null

  if (telefone && isEduitCourseDriftEnabled(env)) {
    try {
      let snapshotCurso = null
      let inscricaoStageForDrift = null
      try {
        const driftRow = await fetchDadosClienteByTelefone(
          env,
          telefone,
          'inscricao_form_status,kommo_curso,polo_inscricao_escolhido',
        )
        inscricaoStageForDrift = driftRow?.inscricao_form_status ?? null
        snapshotCurso = String(driftRow?.kommo_curso || '').trim() || null
      } catch {
        /* stage/curso opcional */
      }
      const snapLeadId = normalizeCrmLeadId(input?.leadId, env) || leadId
      if (snapLeadId) {
        try {
          const snapRes = await fetchLeadFormSnapshot(env, snapLeadId)
          const snap = snapRes?.snapshot
          const fromCard = String(
            snap?.curso_inscricao || snap?.sum_curso || snap?.curso || '',
          ).trim()
          if (fromCard) snapshotCurso = fromCard
        } catch {
          /* card opcional */
        }
      }
      courseSwitch = detectCourseSwitchAgainstCrmState({
        historyMessages,
        snapshotCurso,
        inscricaoStage: inscricaoStageForDrift,
        userMessage,
      })
      blockStaleEnrollment = shouldBlockStaleEnrollmentActions(courseSwitch)
      const driftHints = buildCourseDriftSystemHints(courseSwitch)
      suppressStaleFormHints = driftHints.suppressStaleFormHints
      courseDriftHint = driftHints.driftHint
      console.log(
        `[${executionId}] COURSE_DRIFT switched=${Boolean(courseSwitch?.switched)} ` +
          `staleUnknown=${Boolean(courseSwitch?.staleUnknown)} confidence=${courseSwitch?.confidence || 'n/a'} ` +
          `previousKey=${normalizeCourseKey(courseSwitch?.previous) || 'n/a'} ` +
          `currentKey=${normalizeCourseKey(courseSwitch?.current) || 'n/a'} ` +
          `stage=${courseSwitch?.stageAtSwitch || 'n/a'} ` +
          `exclusiveEduit=${Boolean(historySourceDetail?.exclusiveEduit)}`,
      )
    } catch (err) {
      console.warn(`[${executionId}] COURSE_DRIFT erro:`, err?.message || err)
    }
  }

  if (telefone && leadId && !blockStaleEnrollment) {
    const enriched = await enrichHistoryForShortEnrollmentConfirm(
      env,
      leadId,
      userMessage,
      historyMessages,
    )
    if (enriched.length !== historyMessages.length) {
      console.log(
        `[${executionId}] HISTORICO_ENRIQUECIDO kommo_curso turnos=${enriched.length} (era ${historyMessages.length})`,
      )
      historyMessages = enriched
    }
  }

  // Loga o histórico carregado pra cada execução. Antes não tínhamos
  // visibilidade se a memória vinha vazia / curta — o agente parecia
  // "esquecer" de turnos anteriores e era difícil diagnosticar.
  const historyPreview = historyMessages.slice(-6).map((m) => ({
    role: m.role === 'user' ? 'user' : m.role === 'assistant' ? 'assistant' : m.role,
    content: String(m.content || '').slice(0, 200),
  }))
  console.log(
    `[${executionId}] CARREGOU_HISTORICO msgs=${historyMessages.length} source=${historySource} ` +
      `crmInjected=${Boolean(historySourceDetail?.crmInjected)} exclusive=${Boolean(historySourceDetail?.exclusiveEduit)} ` +
      `telefone=${telefone || 'n/a'}`,
  )
  console.log(
    `[${executionId}] history loaded: ${historyMessages.length} msgs from ${historySource} (telefone=${telefone || 'n/a'})`,
  )
  if (historyMessages.length > 0) {
    for (const m of historyPreview) {
      console.log(`  [${m.role}] ${m.content.replace(/\s+/g, ' ').slice(0, 120)}`)
    }
  }
  ctx.recordHistorySnapshot?.({
    count: historyMessages.length,
    source: historySource,
    sourceDetail: historySourceDetail,
    preview: historyPreview,
  })

  formFlowCtx.historyMessages = historyMessages
  formFlowCtx.courseSwitch = courseSwitch
  formFlowCtx.blockStaleEnrollment = blockStaleEnrollment

  // Antes dos early-return (resumo/form): "Sim" após o resumo não chegava
  // no bloco antigo e o campo Curso do EduIT ficava vazio (Juliana #23881).
  if (telefone) {
    try {
      const cursoConfirmado = detectCursoConfirmadoPeloLead(userMessage, historyMessages)
      if (cursoConfirmado && !shouldSkipRegressiveSumCurso(courseSwitch, cursoConfirmado)) {
        const r = await setSumCursoOnLead(env, { leadId, telefone, cursoNome: cursoConfirmado })
        console.log(
          `[${executionId}] SUM_CURSO_UPDATE curso="${cursoConfirmado}" ok=${r.ok} skipped=${Boolean(r.skipped)} code=${r.code || 'n/a'} previous="${r.previous || ''}"`,
        )
      } else if (cursoConfirmado && shouldSkipRegressiveSumCurso(courseSwitch, cursoConfirmado)) {
        console.log(
          `[${executionId}] SUM_CURSO_UPDATE skipped_regressive curso="${cursoConfirmado}" previous="${courseSwitch?.previous || ''}"`,
        )
      }
    } catch (err) {
      console.warn(`[${executionId}] SUM_CURSO_UPDATE erro: ${err.message}`)
    }
    try {
      const poloConfirmado = matchPoloFromUserMessage(userMessage, historyMessages)
      if (poloConfirmado) {
        const r = await setSumPoloOnLead(env, { leadId, telefone, poloNome: poloConfirmado.nome })
        console.log(
          `[${executionId}] SUM_POLO_UPDATE polo="${poloConfirmado.nome}" ok=${r.ok} skipped=${Boolean(r.skipped)} code=${r.code || 'n/a'}`,
        )
      }
    } catch (err) {
      console.warn(`[${executionId}] SUM_POLO_UPDATE erro: ${err.message}`)
    }
    try {
      const cadastro = await persistCadastroFieldsFromInbound(env, {
        leadId,
        telefone,
        userMessage,
        historyMessages,
      })
      if (!cadastro.skipped || cadastro.written?.length) {
        console.log(
          `[${executionId}] CADASTRO_CARD_SYNC written=${(cadastro.written || []).join(',') || 'none'} ok=${cadastro.ok} code=${cadastro.code || 'n/a'}`,
        )
      }
    } catch (err) {
      console.warn(`[${executionId}] CADASTRO_CARD_SYNC erro: ${err.message}`)
    }
  }

  // Handlers adiados: só rodam se drift NÃO indicar estado antigo capturando o turno.
  if (telefone && deferStateEarlyHandlers && !blockStaleEnrollment) {
    const inscricaoExistenteFlow = await tryHandleCaptacaoInscricaoExistenteFlow(env, formFlowCtx)
    if (inscricaoExistenteFlow?.handled) {
      console.log(
        `[${executionId}] CAPTACAO_INSCRICAO_EXISTENTE status=${inscricaoExistenteFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
      )
      return {
        ...inscricaoExistenteFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const aceiteFlow = await tryHandleMatriculaAceitePagamentoFlow(env, formFlowCtx)
    if (aceiteFlow?.handled) {
      console.log(
        `[${executionId}] MATRICULA_ACEITE_PAGAMENTO step=${aceiteFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
      )
      return {
        ...aceiteFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  } else if (telefone && deferStateEarlyHandlers && blockStaleEnrollment) {
    console.log(
      `[${executionId}] STALE_STATE_GUARD skip_aceite_captacao switched=${Boolean(courseSwitch?.switched)} staleUnknown=${Boolean(courseSwitch?.staleUnknown)}`,
    )
  }

  if (telefone) {
    const gradePdfFlow = await tryHandleGradePdfRequest(env, formFlowCtx)
    if (gradePdfFlow?.handled) {
      console.log(
        `[${executionId}] GRADE_PDF_AUTO code=${gradePdfFlow.result?.toolCalls?.[0]?.code ?? 'n/a'} ok=${gradePdfFlow.result?.ok}`,
      )
      return {
        ...gradePdfFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  // Fix 4 — Log de contexto inicial: estado, histórico e sinais críticos. Sem
  // isso, era cego entender por que tryHandlePoloPreFormFlow retornava null.
  if (telefone) {
    try {
      const ctxRow = await fetchDadosClienteByTelefone(env, telefone, 'inscricao_form_status,polo_inscricao_escolhido')
      const ctxStage = ctxRow?.inscricao_form_status ?? null
      const ctxPolo = ctxRow?.polo_inscricao_escolhido ?? null
      const lastA = lastAssistantText(historyMessages)
      const lastALen = lastA.length
      const poloSig = lastALen > 0 ? Boolean((lastA.match(/em qual|qual.*polo|somente.*estes polos/i))) : false
      console.log(
        `[${executionId}] INSCRICAO_CTX stage=${ctxStage || 'null'} polo=${ctxPolo || 'null'} ` +
          `historyLen=${historyMessages.length} historySource=${historySource} ` +
          `lastAssistLen=${lastALen} polo_signal_in_lastAssist=${poloSig} userMsgLen=${(userMessage || '').length}`,
      )
    } catch (err) {
      console.warn(`[${executionId}] INSCRICAO_CTX log_err:`, err?.message || err)
    }
  }

  // Passo de CONFIRMAÇÃO antes do formulário: quando o lead confirma a matrícula,
  // envia o resumo (curso/valor/taxa) e pede autorização ANTES de disparar o
  // formulário. Só depois do "autorizo" o fluxo de envio existente roda.
  if (telefone) {
    const transferenciaFlow = await tryHandleTransferenciaDadosPendentes(env, formFlowCtx)
    if (transferenciaFlow?.handled) {
      console.log(
        `[${executionId}] TRANSFERENCIA_DADOS_PENDENTES code=${transferenciaFlow.result?.ctxSnapshot?.actionCode ?? transferenciaFlow.result?.toolCalls?.[0]?.code ?? 'n/a'}`,
      )
      return {
        ...transferenciaFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const transferenciaConfirm = await tryHandleTransferenciaConfirmacao(env, formFlowCtx)
    if (transferenciaConfirm?.handled) {
      console.log(
        `[${executionId}] TRANSFERENCIA_CONFIRMADA code=${transferenciaConfirm.result?.toolCalls?.[0]?.code ?? 'n/a'}`,
      )
      return {
        ...transferenciaConfirm.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const transferenciaRestate = await tryHandleTransferenciaCursoRestate(env, formFlowCtx)
    if (transferenciaRestate?.handled) {
      console.log(
        `[${executionId}] TRANSFERENCIA_CURSO_RESTATE code=${transferenciaRestate.result?.toolCalls?.[0]?.code ?? 'n/a'}`,
      )
      return {
        ...transferenciaRestate.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (telefone) {
    const deferredPaymentFlow = await tryHandleDeferredPaymentEnrollmentFlow(env, formFlowCtx)
    if (deferredPaymentFlow?.handled) {
      console.log(`[${executionId}] DEFERRED_PAYMENT_ENROLLMENT`)
      return {
        ...deferredPaymentFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (telefone && !blockStaleEnrollment) {
    let earlyInscricaoStage = null
    try {
      const earlyRow = await fetchDadosClienteByTelefone(env, telefone, 'inscricao_form_status')
      earlyInscricaoStage = earlyRow?.inscricao_form_status ?? null
    } catch {
      /* ignore */
    }
    const poloTurnPriority =
      userMessageLooksLikePoloChoice(userMessage) ||
      earlyInscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM
    if (poloTurnPriority) {
      const poloEarly = await tryHandlePoloPreFormFlow(env, formFlowCtx)
      if (poloEarly?.handled) {
        console.log(
          `[${executionId}] POLO_PRE_FORM_EARLY polo=${poloEarly.result?.ctxSnapshot?.poloId ?? 'n/a'} stage=${earlyInscricaoStage ?? 'n/a'}`,
        )
        return {
          ...poloEarly.result,
          historyLoaded: historyMessages.length,
          aiMeta: ctx.toAiMeta(),
        }
      }
    }
  }

  if (
    telefone &&
    !blockStaleEnrollment &&
    !userMessageLooksLikePoloChoice(userMessage) &&
    !conversationAlreadyAuthorizedMatricula(historyMessages)
  ) {
    const resumoFlow = await tryHandleMatriculaResumoConfirmacao(env, formFlowCtx)
    if (resumoFlow?.handled) {
      console.log(
        `[${executionId}] MATRICULA_RESUMO_CONFIRMACAO curso="${resumoFlow.result?.orchestratorSteps?.[0]?.curso ?? 'n/a'}"`,
      )
      return {
        ...resumoFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  // Saída do canal — passo 2: lead respondendo à pergunta "prefere mesmo não
  // seguir por aqui?". Confirma → links oficiais + fila 143; recusa → null
  // (estado limpo, atendimento segue normal). Roda ANTES da desistência para
  // a resposta não ser confundida com declínio de inscrição.
  if (telefone) {
    const exitConfirm = await tryHandleChannelExitConfirmStep(env, formFlowCtx)
    if (exitConfirm?.handled) {
      console.log(`[${executionId}] SAIDA_CANAL_CONFIRMADA telefone=${telefone}`)
      return { ...exitConfirm.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }
  }

  if (telefone) {
    const paymentDiscountFlow = await tryHandlePaymentDiscountInquiry(env, formFlowCtx)
    if (paymentDiscountFlow?.handled) {
      console.log(`[${executionId}] PAYMENT_DISCOUNT`)
      return {
        ...paymentDiscountFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (telefone) {
    const priceDurationFlow = await tryHandlePriceUntilCourseEndInquiry(env, formFlowCtx)
    if (priceDurationFlow?.handled) {
      console.log(`[${executionId}] PRICE_UNTIL_COURSE_END`)
      return {
        ...priceDurationFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (telefone) {
    const academicFlow = await tryHandleAcademicAffairsInquiry(env, formFlowCtx)
    if (academicFlow?.handled) {
      console.log(`[${executionId}] ACADEMIC_AFFAIRS_REDIRECT`)
      return {
        ...academicFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (telefone) {
    const fimAtendimentoFlow = await tryHandleFimAtendimentoFlow(env, formFlowCtx)
    if (fimAtendimentoFlow?.handled) {
      console.log(`[${executionId}] FIM_ATENDIMENTO telefone=${telefone}`)
      return {
        ...fimAtendimentoFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }

    const desistenciaFlow = await tryHandleInscricaoDesistenciaFlow(env, formFlowCtx)
    if (desistenciaFlow?.handled) {
      console.log(
        `[${executionId}] INSCRICAO_DESISTENCIA stage=${desistenciaFlow.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'}`,
      )
      return {
        ...desistenciaFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }

    // Plano_Inscricao_CardKommo — antes do polo padrão: tenta express
    // usando dados pré-preenchidos no card Sumaré Comercial. Cobre:
    //   1) lead pediu matrícula + card completo → pergunta confirma polo
    //   2) lead respondeu a confirmação → executa captação direto
    if (!blockStaleEnrollment) {
      const kommoCardFlow = await tryHandleInscricaoFromKommoCard(env, formFlowCtx)
      if (kommoCardFlow?.handled) {
        const snap = kommoCardFlow.result?.ctxSnapshot || {}
        console.log(
          `[${executionId}] KOMMO_CARD_EXPRESS stage=${snap.inscricaoForm ?? 'n/a'} ` +
            `polo=${snap.poloId ?? snap.poloNome ?? 'n/a'} fail=${Boolean(snap.kommoCardExpressFail)}`,
        )
        return {
          ...kommoCardFlow.result,
          historyLoaded: historyMessages.length,
          aiMeta: ctx.toAiMeta(),
        }
      }

      const poloPreFlow = await tryHandlePoloPreFormFlow(env, formFlowCtx)
      if (poloPreFlow?.handled) {
        console.log(
          `[${executionId}] POLO_PRE_FORM polo=${poloPreFlow.result?.ctxSnapshot?.poloId ?? 'n/a'} form_ok=${poloPreFlow.result?.toolCalls?.[0]?.ok ?? 'n/a'}`,
        )
        return {
          ...poloPreFlow.result,
          historyLoaded: historyMessages.length,
          aiMeta: ctx.toAiMeta(),
        }
      }

      const poloFlow = await tryHandlePoloEscolhaFlow(env, formFlowCtx)
      if (poloFlow?.handled) {
        console.log(
          `[${executionId}] POLO_ESCOLHA polo=${poloFlow.result?.ctxSnapshot?.poloId ?? 'n/a'} unidade=${poloFlow.result?.ctxSnapshot?.unidade ?? 'n/a'}`,
        )
        return {
          ...poloFlow.result,
          historyLoaded: historyMessages.length,
          aiMeta: ctx.toAiMeta(),
        }
      }
    } else {
      console.log(
        `[${executionId}] STALE_STATE_GUARD skip_form_polo_card switched=${Boolean(courseSwitch?.switched)}`,
      )
    }
  }

  // "sim" / "ok" após pergunta de inscrição → Form Sumar (antes de cair no orquestrador sem contexto).
  if (telefone && !blockStaleEnrollment && isShortEnrollmentConfirmation(userMessage)) {
    if (messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)) {
      const formEarly = await tryHandleInscricaoFormStart(env, formFlowCtx)
      if (formEarly?.handled) {
        console.log(
          `[${executionId}] INSCRICAO_FORM_START early_confirm enrollment_step=${assistantInEnrollmentStep(lastAssistantText(historyMessages))}`,
        )
        return { ...formEarly.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
      }
    }
  }

  // ── Shortcut barato: saudação pura (com ou sem contexto). Adiantado
  // pra rodar ANTES das chamadas Kommo (sum_curso), pós-form, course
  // level e handoff — saudação não precisa de nenhuma dessas etapas e
  // economiza I/O. Histórico já está carregado então o contexto continua
  // funcionando (saudação contextual mantida).
  //
  // Api Sumaré (estágio avançado) roda ANTES da saudação genérica: lead
  // com CPF no card precisa bootstrap de inscrição/comprovante.
  if (telefone) {
    const apiSumareEntry = await tryHandleApiSumareAdvancedEntry(env, formFlowCtx)
    if (apiSumareEntry?.handled) {
      console.log(
        `[${executionId}] API_SUMARE_ENTRY stage=${apiSumareEntry.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'} ` +
          `candidato=${apiSumareEntry.result?.ctxSnapshot?.candidatoId ?? 'n/a'}`,
      )
      return {
        ...apiSumareEntry.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  if (isGreetingOnly(userMessage)) {
    const useContextual = shouldUseContextualGreetingReply(userMessage, historyMessages)
    const greetingReply = useContextual
      ? buildContextualGreetingReply({ userMessage, pushName: input?.pushName, historyMessages })
      : buildGreetingReply({ userMessage, pushName: input?.pushName })
    ctx.recordScopeClassification?.({
      blocked: false,
      source: 'heuristic',
      reason: useContextual ? 'greeting_continuacao' : 'greeting',
      classification: {
        dentro_escopo: true,
        categoria: useContextual ? 'saudacao_continuacao' : 'saudacao',
        nivel: 'indefinido',
        motivo: useContextual ? 'saudação com conversa em andamento' : 'saudação simples',
      },
    })
    console.log(`[${executionId}] GREETING handled contextual=${useContextual} (sem orquestrador)`)
    return {
      ok: true,
      reply: greetingReply,
      scopeBlocked: false,
      greetingHandled: true,
      toolCalls: [],
      orchestratorSteps: [{ type: 'greeting', durationMs: Date.now() - t0 }],
      ctxSnapshot: { greeting: true, contextual: useContextual },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      durationMs: Date.now() - t0,
      historyLoaded: historyMessages.length,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }

  if (telefone) {
    // n8n takeover: se a mensagem é o retorno cru do Meta Flow (nfm_reply),
    // parseia + AJUSTA os dados (telefone/data/sexo/cpf) e grava no card do
    // Kommo (+ nota de auditoria + move p/ inscrição) ANTES do pipeline pós-form,
    // que então lê o card já preenchido (fetchLeadFormSnapshot) e segue p/ matrícula.
    if (leadId && messageIsMetaFlowFormReply(userMessage)) {
      try {
        const parsed = parseMetaFlowResponseJson(userMessage)
        if (parsed.ok) {
          const sync = await applyMetaFlowFormToKommo(env, {
            leadId,
            parsed,
            executionId,
          })
          console.log(
            `[${executionId}] META_FLOW_KOMMO_SYNC lead=${leadId} card_ok=${sync.cardOk} note_ok=${sync.noteOk} moved=${sync.statusMoved} fields=${sync.fieldsWritten ?? 0} skipped=${sync.skipped || 'no'} cpf=${parsed.cpf_digits || 'n/a'}`,
          )
        } else {
          console.warn(`[${executionId}] META_FLOW_PARSE_FAIL ${parsed.error || ''}`)
        }
      } catch (err) {
        console.warn(`[${executionId}] META_FLOW_KOMMO_SYNC erro: ${err.message}`)
      }
    }

    // Pós-form só quando a mensagem indica formulário respondido — evita pular
    // direto para "cadastro validado" em "sim"/"oi" com notas antigas no Kommo.
    const wantsNewForm = leadExplicitlyRequestsInscricaoForm(userMessage, historyMessages)
    const historyFormCompleted = historyIndicatesFormSumarCompleted(historyMessages)
    const formSubmissionAck =
      messageSignalsFormSubmissionAck(userMessage) ||
      messageIsFormularioSumarPreenchidoMarker(userMessage) ||
      historyFormCompleted
    let matriculaJaProcessada = false
    let inscRow = null
    try {
      if (
        !wantsNewForm &&
        !formSubmissionAck &&
        leadId != null &&
        (await leadHasPostFormRegistradoNoteSinceLastFormSend(env, leadId))
      ) {
        matriculaJaProcessada = true
      }
      if (!matriculaJaProcessada) {
        inscRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
        matriculaJaProcessada = matriculaPosFormAlreadyProcessed(inscRow)
      }
      if (wantsNewForm && matriculaJaProcessada) {
        console.log(
          `[${executionId}] INSCRICAO_NOVO_FORM pedido explícito — ignorando guarda pós-form antiga no Kommo`,
        )
        matriculaJaProcessada = false
      }
    } catch {
      /* segue sem bloquear */
    }

    const formStatus = inscRow?.inscricao_form_status ?? null
    const waitingForForm = [
      INSCRICAO_FORM_STATUS_AGUARDANDO,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    ].includes(formStatus)
    const flowTextInbound =
      messageLooksLikeFormSumarResponse(userMessage) ||
      messageIsFlowResponsesReceived(userMessage) ||
      messageIsFormularioSumarPreenchidoMarker(userMessage) ||
      historyFormCompleted

    let kommoFlowDetected = false
    if (
      !matriculaJaProcessada &&
      !wantsNewForm &&
      leadId &&
      (waitingForForm || flowTextInbound || formSubmissionAck)
    ) {
      try {
        const det = await detectFormSumarRecebidoNoKommo(env, leadId)
        kommoFlowDetected = Boolean(det.detected)
        if (kommoFlowDetected) {
          console.log(
            `[${executionId}] FLOW_FORM_KOMMO lead=${leadId} source=${det.source || 'n/a'} sample="${String(det.sample || '').slice(0, 80)}"`,
          )
        }
      } catch (detErr) {
        console.warn(`[${executionId}] FLOW_FORM_KOMMO erro: ${detErr.message}`)
      }
    }

    const looksPostFormInbound =
      !matriculaJaProcessada &&
      (flowTextInbound || kommoFlowDetected || formSubmissionAck)

    if (flowTextInbound) {
      console.log(
        `[${executionId}] FLOW_FORM_INBOUND flow_received=${messageIsFlowResponsesReceived(userMessage)} status=${formStatus || 'n/a'}`,
      )
    }

    const formDone = looksPostFormInbound
      ? await tryHandleInscricaoFormComplete(env, formFlowCtx)
      : null
    if (formDone?.handled) {
      const step = formDone.result?.ctxSnapshot?.inscricaoForm ?? 'post_form'
      console.log(
        `[${executionId}] INSCRICAO_POST_FORM step=${step} captacao=${formDone.result?.ctxSnapshot?.sumareCaptacao ?? 'n/a'} salesbot=${formDone.result?.ctxSnapshot?.salesbotId ?? formDone.result?.ctxSnapshot?.distribSalesbotId ?? 'n/a'}`,
      )
      return { ...formDone.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }
    if (!blockStaleEnrollment) {
      const formStart = await tryHandleInscricaoFormStart(env, formFlowCtx)
      if (formStart?.handled) {
        console.log(
          `[${executionId}] INSCRICAO_FORM_START salesbot=${formStart.result?.ctxSnapshot?.salesbotId ?? formStart.result?.toolCalls?.[0]?.ok ?? 'n/a'}`,
        )
        return { ...formStart.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
      }
    } else {
      console.log(
        `[${executionId}] STALE_STATE_GUARD skip_form_start switched=${Boolean(courseSwitch?.switched)} staleUnknown=${Boolean(courseSwitch?.staleUnknown)}`,
      )
    }

    const courseLevel = await tryHandleUnsupportedCourseLevelInquiry(env, {
      ...formFlowCtx,
      historyMessages,
    })
    if (courseLevel?.handled) {
      console.log(`[${executionId}] CURSO_TECNICO_ALTERNATIVA (graduação sugerida)`)
      return { ...courseLevel.result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
    }
  }

  // Saída do canal — passo 1: lead pediu atendimento humano. Em vez de ativar
  // salesbot, pergunta UMA vez se ele realmente não quer seguir pelo canal.
  if (telefone && shouldHandoffToHuman(userMessage, historyMessages)) {
    console.log(`[${executionId}] SAIDA_CANAL_CONFIRM_OFERECIDA telefone=${telefone}`)
    const result = await startChannelExitConfirm(env, {
      telefone,
      leadId,
      executionId,
      model,
      pushName: input?.pushName,
      t0,
    })
    return { ...result, historyLoaded: historyMessages.length, aiMeta: ctx.toAiMeta() }
  }

  if (telefone) {
    const poloLocationFlow = await tryHandlePoloLocationInfoFlow(env, formFlowCtx)
    if (poloLocationFlow?.handled) {
      console.log(`[${executionId}] POLO_LOCATION_INFO telefone=${telefone}`)
      return {
        ...poloLocationFlow.result,
        historyLoaded: historyMessages.length,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  let skipScopeCheck =
    (historyMessages.length === 0 && isAmbiguousShortReply(userMessage)) ||
    Boolean(extractCursoAreaFromText(userMessage)) ||
    messageIsBareCourseSelection(userMessage, historyMessages) ||
    messageAsksRegionalFacultyLocation(userMessage, historyMessages)
  let scopeClassification = null
  if (!skipScopeCheck) {
    const scope = await classifyMessageScope(env, { userMessage, historyMessages })
    scopeClassification = scope.classification
    ctx.recordScopeClassification?.({
      blocked: scope.blocked,
      source: scope.source,
      reason: scope.reason,
      classification: scope.classification,
      model: scope.model,
      usage: scope.usage,
    })
    console.log(
      `[${executionId}] SCOPE_CLASSIFIER blocked=${scope.blocked} source=${scope.source} reason=${scope.reason}` +
        (scope.classification?.categoria ? ` categoria=${scope.classification.categoria}` : ''),
    )
    if (
      scope.blocked &&
      scope.reply &&
      shouldBypassScopeBlock(userMessage, historyMessages)
    ) {
      console.log(
        `[${executionId}] SCOPE_CLASSIFIER override — continuacao de atendimento (nao bloquear)`,
      )
      scope.blocked = false
      scope.reply = null
    }

    // Reforço opcional (PR 2.3): SCOPE_BLOCK_REQUIRE_NO_CONTEXT=true exige
    // ausência total de contexto ativo (curso em discussão recente) pra
    // efetivar o bloqueio. Em produção começamos com o flag desligado e
    // monitoramos via log; se houver falso-bloqueios escapando do bypass
    // acima, ligamos o flag pra suprimir o envio da recusa sem perder a
    // mensagem (que já não vai virar resposta — só log).
    const requireNoContextForBlock =
      String(env.SCOPE_BLOCK_REQUIRE_NO_CONTEXT || 'false').toLowerCase() === 'true'
    if (
      scope.blocked &&
      scope.reply &&
      requireNoContextForBlock &&
      (conversationHasActiveTopic(historyMessages) ||
        Boolean(extractDiscussedCourseFromHistory(historyMessages)))
    ) {
      console.log(
        `[${executionId}] SCOPE_CLASSIFIER bloqueio suprimido — SCOPE_BLOCK_REQUIRE_NO_CONTEXT=true e contexto ativo na conversa (reply NÃO será enviado)`,
      )
      scope.blocked = false
      scope.reply = null
    }

    if (scope.blocked && scope.reply) {
      const scopeUsage = scope.usage
        ? {
            prompt_tokens: scope.usage.prompt_tokens || 0,
            completion_tokens: scope.usage.completion_tokens || 0,
            total_tokens: scope.usage.total_tokens || 0,
          }
        : { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
      return {
        ok: true,
        reply: scope.reply,
        scopeBlocked: true,
        toolCalls: [],
        orchestratorSteps: [
          {
            type: 'scope_classifier',
            blocked: true,
            source: scope.source,
            reason: scope.reason,
            classification: scope.classification,
            model: scope.model,
            durationMs: scope.elapsedMs,
            usage: scope.usage,
          },
        ],
        ctxSnapshot: {
          scopeClassifier: true,
          classification: scope.classification,
        },
        usage: scopeUsage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
      }
    }
  }

  const toolDefinitions = getToolDefinitions(env)
  const systemMessage = buildSystemMessage(prompts, env)
  // Contexto do atendimento — telefone + id_lead vão p/ o LLM sempre
  // que disponíveis. Sem id_lead aqui, o LLM tendia a chamar tools
  // (inscricao / distribuir_humano) com `id_lead: 0` (default da
  // OpenAI), causando MISSING_CRM_FIELDS e o fluxo nunca completava.
  const contextLines = []
  if (telefone) contextLines.push(`- Telefone do lead: ${telefone}`)
  if (leadId) {
    const crmNome = isEduitBackend(env) || /^c[a-z0-9]{8,}$/i.test(String(leadId)) ? 'EduIT' : 'Kommo'
    contextLines.push(`- id_lead (${crmNome}): ${leadId}`)
  }
  if (input?.pushName) contextLines.push(`- Nome (pushName): ${input.pushName}`)

  if (leadId) {
    try {
      const snapRes = await fetchLeadFormSnapshot(env, leadId)
      const snap = snapRes?.snapshot
      if (snap?.curso_inscricao) {
        contextLines.push(`- Curso no card: ${snap.curso_inscricao}`)
      }
      if (snap?.modalidade) {
        contextLines.push(`- Modalidade no card: ${snap.modalidade}`)
      }
      if (snap?.polo_inscricao) {
        contextLines.push(`- Polo no card: ${snap.polo_inscricao}`)
      }
    } catch {
      /* card Kommo opcional */
    }
  }

  // Estado da máquina de inscrição
  // para o LLM saber EXATAMENTE qual tool de ação chamar (se alguma).
  // Mantemos também em `formFlowCtx.stageBefore` para telemetria de transição.
  let inscricaoStageInfo = null
  if (telefone) {
    try {
      const stageRow = inscRow ||
        (await fetchDadosClienteByTelefone(
          env,
          telefone,
          DADOS_CLIENTE_INSCRICAO_SELECT,
        ))
      const stage = String(stageRow?.inscricao_form_status || '').trim() || null
      const poloNome = String(stageRow?.polo_inscricao_escolhido || '').trim() || null
      const captacaoCandidatoId = stageRow?.captacao_candidato_id ?? null
      inscricaoStageInfo = { stage, poloNome, captacaoCandidatoId }
      formFlowCtx.stageBefore = stage
      if (stage) {
        let descr = stage
        if (courseSwitch?.switched) {
          descr +=
            ` (OBSOLETO após troca de curso — não use form/polo/link deste estágio; curso atual: ${courseSwitch.current || 'em discussão'})`
        } else if (suppressStaleFormHints) {
          descr += ' (estado possivelmente desatualizado — NÃO afirmar form/link já enviados; peça clarificação)'
        } else if (stage === 'aguardando_escolha_polo_pre_form') {
          descr += ' (lead confirmou matrícula — chame registrar_polo_inscricao com o polo que ele responder)'
        } else if (stage === 'aguardando_form_sumar') {
          descr += ' (Form Sumar já enviado — quando o lead disser "pronto" / "preenchi", chame confirmar_recebimento_formulario)'
        } else if (stage === 'aguardando_distribuicao_form') {
          descr +=
            ' (Form recebido sem curso resolvido — PERGUNTE o nome do curso e, ao receber, continue a matrícula/captação. NÃO redirecione para atendimento/ouvidoria.)'
        } else if (stage === 'aguardando_aceite_contrato') {
          descr += ' (lead já tem link do contrato — NÃO reenvie formulário)'
        } else if (stage === 'form_sumar_concluido') {
          descr += ' (inscrição finalizada — NÃO disparar formulário/polo novamente)'
        }
        contextLines.push(`- Estado da inscrição: ${descr}`)
      } else {
        contextLines.push('- Estado da inscrição: nenhum (lead ainda não confirmou matrícula)')
      }
      if (poloNome) contextLines.push(`- Polo escolhido: ${poloNome}`)
      if (captacaoCandidatoId) contextLines.push(`- Captação Sumaré: candidato ${captacaoCandidatoId}`)
    } catch {
      /* sem stage não bloqueia o turno */
    }
  }

  const contextPreamble = contextLines.length > 0 ? `Contexto do atendimento:\n${contextLines.join('\n')}` : ''

  // BACKSTOP CRÍTICO — sem histórico + msg ambígua ("Sim", "Ok", "?")
  // a IA tende a alucinar curso (caso "Administração" do EX-260506-1702-057).
  // Injetamos system extra deixando MUITO claro que o LLM não pode inventar
  // nem mencionar nomes de cursos que o lead não falou.
  const commercialOpportunity =
    messageLooksCareerIncomeOpportunity(userMessage) ||
    scopeClassification?.categoria === 'oportunidade_comercial'
  const commercialHint = commercialOpportunity
    ? {
        role: 'system',
        content:
          'OPORTUNIDADE COMERCIAL: o lead falou de carreira, renda ou mundo digital. ' +
          `Chame buscar_conhecimento neste turno (query sugerida: "${buildCommercialRedirectSearchQuery(userMessage)}"). ` +
          'Acolha o objetivo, mencione com naturalidade que diploma/formação superior abre portas no médio prazo, cite 1–3 cursos só do CONTEXT e convide a saber valores ou matrícula. Não recuse como fora do escopo.',
      }
    : null

  const courseFromMsg = extractDiscussedCourseFromHistory([
    ...historyMessages,
    { role: 'user', content: userMessage },
  ])
  const courseInterestHint = messageExpressesCourseInterestOnly(userMessage, historyMessages)
    ? {
        role: 'system',
        content:
          'INTERESSE EM CURSO (ainda sem confirmação de matrícula): o lead citou um curso ou pediu para fazer um curso. ' +
          `OBRIGATÓRIO neste turno: chame buscar_conhecimento (query com o curso, ex.: "${courseFromMsg || 'nome do curso mencionado'}") ` +
          'e/ou buscar_precos conforme o nível. Apresente informações objetivas do CONTEXT (modalidade, duração, investimento quando existir). ' +
          'Depois pergunte explicitamente se deseja seguir com a matrícula/inscrição. ' +
          'PROIBIDO neste turno: distribuir_humano, dizer que já enviou o formulário — o sistema só dispara o Formulario_Sum após confirmação explícita.',
      }
    : null

  const activeCourse = extractDiscussedCourseFromHistory(historyMessages)
  const activeFlowHint =
    conversationHasActiveTopic(historyMessages) || messageIsInboundMediaPlaceholder(userMessage)
      ? {
          role: 'system',
          content:
            'ATENDIMENTO COMERCIAL EM ANDAMENTO' +
            (activeCourse ? ` (curso: ${activeCourse})` : '') +
            '. O lead NÃO pediu consultor humano de forma explícita. ' +
            'OBRIGATÓRIO: buscar_conhecimento e/ou buscar_precos sobre o curso em pauta antes de qualquer encaminhamento. ' +
            'PROIBIDO chamar distribuir_humano neste turno, exceto se o lead escrever claramente que quer falar com humano/atendente/consultor. ' +
            (messageIsInboundMediaPlaceholder(userMessage)
              ? 'Se veio áudio: interprete a transcrição no contexto da conversa; se não entendeu, peça para digitar — não encaminhe para consultor.'
              : ''),
        }
      : null

  const enrollmentContinuation =
    userLikelyContinuingEnrollmentFlow(userMessage, historyMessages) ||
    (isShortEnrollmentConfirmation(userMessage) &&
      messageConfirmsProceedToInscricaoForm(userMessage, historyMessages))

  const ambiguousNoContext =
    historyMessages.length === 0 &&
    isAmbiguousShortReply(userMessage) &&
    !enrollmentContinuation

  const frustrationAlreadySaid =
    messageExpressesFrustrationAlreadySaid(userMessage) &&
    (conversationHasActiveTopic(historyMessages) ||
      Boolean(extractDiscussedCourseFromHistory(historyMessages)))

  const inscricaoStage = inscricaoStageInfo?.stage || formFlowCtx.stageBefore || null
  const formPastOrAwaiting =
    inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO ||
    inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE ||
    (inscricaoStage && inscricaoFormAlreadyFilled({ inscricao_form_status: inscricaoStage }))

  const transferenciaCtx = extractTransferenciaContext(historyMessages)
  const transferenciaMentioned = conversationMentionsTransferencia(historyMessages)
  const transferenciaFlowHint =
    transferenciaMentioned && !messageAsksCoursePrice(userMessage)
      ? {
          role: 'system',
          content: transferenciaCtx?.origem && transferenciaCtx?.destino && transferenciaCtx?.semestre
            ? (
              'TRANSFERÊNCIA/APROVEITAMENTO DE MATÉRIAS EM ANDAMENTO' +
              ` — curso de origem: ${transferenciaCtx.origem}` +
              ` — curso desejado na Sumaré: ${transferenciaCtx.destino}` +
              ` — último semestre informado: ${transferenciaCtx.semestre}` +
              '. O lead já informou ou confirmou os dados da transferência. ' +
              'OBRIGATÓRIO: chame registrar_transferencia(telefone, curso_origem, semestre_concluido, curso_desejado) com os dados do histórico — NÃO pergunte novamente qual curso ele deseja. ' +
              'Se faltar apenas o polo EAD, siga o fluxo normal de escolha de polo após registrar_transferencia. ' +
              'PROIBIDO: enviar_form_sumar_inscricao direto sem registrar_transferencia; perguntar "qual curso você tem interesse" quando origem e destino já constam.'
            )
            : (
              'O lead falou de transferência/aproveitamento, mas ainda faltam dados. ' +
              'PROIBIDO chamar registrar_transferencia neste turno. ' +
              'PROIBIDO inventar curso de origem, semestre (não use data de nascimento) ou polo. ' +
              'Peça só o que falta: curso de origem na outra faculdade, último semestre concluído e curso desejado na Sumaré.'
            ),
        }
      : null

  const enrollmentConfirmHint =
    !suppressStaleFormHints &&
    enrollmentContinuation &&
    !messageAsksCoursePrice(userMessage) &&
    !transferenciaCtx &&
    !conversationMentionsTransferencia(historyMessages) &&
    !conversationAlreadyAuthorizedMatricula(historyMessages) &&
    inscricaoStage !== INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM &&
    !userMessageLooksLikePoloChoice(userMessage)
      ? inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO
        ? {
            role: 'system',
            content:
              'FORMULÁRIO JÁ ENVIADO: o lead confirmou matrícula, mas o Form Sumar já foi ativado nesta conversa. ' +
              'PROIBIDO chamar enviar_form_sumar_inscricao ou registrar_polo_inscricao de novo (gera loop). ' +
              'Peça gentilmente que preencha o formulário que já está no WhatsApp e ofereça ajuda com campos.',
          }
        : inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
          ? {
              role: 'system',
              content:
                'INSCRIÇÃO EM ANDAMENTO: o lead já preencheu o formulário e recebeu o link de pagamento/contrato. ' +
                'PROIBIDO reenviar formulário. Se pedir link de pagamento, informe que pode reenviar o link — não ative Formulario_Sum.',
            }
          : formPastOrAwaiting
            ? null
            : {
                role: 'system',
                content:
                  'CONFIRMAÇÃO DE MATRÍCULA: o lead respondeu de forma afirmativa após você perguntar sobre inscrição/matrícula no curso em pauta. ' +
                  `Curso em discussão: ${extractDiscussedCourseFromHistory(historyMessages) || 'ver sum_Curso/histórico'}. ` +
                  'OBRIGATÓRIO neste turno: chame a tool enviar_form_sumar_inscricao com o curso confirmado. ' +
                  'Se o polo ainda não foi escolhido, o servidor automaticamente pedirá polo ao lead — você não precisa narrar isso, apenas chame a tool. ' +
                  'Quando o lead responder polo (1-5 ou nome), chame registrar_polo_inscricao com o polo_id correspondente. ' +
                  'Polos válidos: São Miguel (sao_miguel), Barra Funda (barra_funda), Tatuapé (tatuape), Santana (santana), Pinheiros (pinheiros). ' +
                  'Se pedir outro polo fora da lista, NÃO chame tool — apenas informe que por este WhatsApp só há esses 5 polos.',
              }
      : null

  // Hint sempre injetado: ensina o LLM a usar as 3 tools de ação ao invés
  // de "narrar" o envio do formulário/polo/inscrição. O reply guard
  // bloqueia qualquer texto que afirme essas ações sem a tool correspondente.
  const inscricaoToolsHint = telefone
    ? {
        role: 'system',
        content:
          'TOOLS DE INSCRIÇÃO — você NUNCA pode dizer que "enviou", "vai enviar", "registrou polo" ou "fez a inscrição" sem ter chamado a tool correspondente neste turno. Tools disponíveis:\n' +
          '- enviar_form_sumar_inscricao(telefone, curso[, polo_id]): chame quando o lead confirma matrícula em um curso específico. Se o polo ainda não foi escolhido, o servidor pede polo automaticamente.\n' +
          '- registrar_polo_inscricao(telefone, polo_id): chame quando o lead responde polo (1-5 ou nome). polo_id ∈ {sao_miguel, barra_funda, tatuape, santana, pinheiros}.\n' +
          '- registrar_transferencia(telefone, curso_origem, semestre_concluido, curso_desejado[, polo_id]): SOMENTE se o lead pediu transferência/aproveitamento de matérias com evidência no histórico. Nunca use data de nascimento como semestre. Nunca chame após o lead responder um número de lista de cursos. Ingresso normal (vestibular/pós) usa enviar_form_sumar_inscricao.\n' +
          '- confirmar_recebimento_formulario(telefone): chame quando o lead diz "pronto", "preenchi", "feito", "ok" após o estado aguardando_form_sumar.\n' +
          (suppressStaleFormHints
            ? 'ESTADO DE CURSO EM REVISÃO: NÃO use estágios antigos (form/link/polo) como verdade; peça confirmação do curso atual antes de tools de inscrição.\n'
            : inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO
            ? 'ESTADO ATUAL: aguardando_form_sumar — PROIBIDO chamar enviar_form_sumar_inscricao de novo; só oriente o lead a preencher o formulário já enviado.\n'
            : inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
              ? 'ESTADO ATUAL: aguardando_aceite_contrato — PROIBIDO reenviar formulário; só link de pagamento se o lead pedir.\n'
              : '') +
          'Se nenhuma tool se aplica, apenas conduza a conversa (explique cursos, peça polo, peça confirmação) — SEM narrar ações que não aconteceram.',
      }
      : null

  const poloStageGuardHint =
    suppressStaleFormHints
      ? null
      : inscricaoStage === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM
      ? {
          role: 'system',
          content:
            'ESTADO aguardando_escolha_polo_pre_form: o lead JÁ autorizou a matrícula. ' +
            'OBRIGATÓRIO: chame registrar_polo_inscricao quando responder 1–5 ou nome do polo. ' +
            'PROIBIDO: reenviar resumo de matrícula, pedir autorização de novo, ou perguntar "você autoriza a conclusão da matrícula?".',
        }
      : inscricaoStageInfo?.poloNome
        ? {
            role: 'system',
            content:
              `POLO JÁ DEFINIDO (${inscricaoStageInfo.poloNome}): PROIBIDO perguntar polo novamente. ` +
              'Siga o estágio atual da inscrição sem repetir etapas já concluídas.',
          }
        : null

  const matriculaAuthGuardHint =
    !suppressStaleFormHints &&
    conversationAlreadyAuthorizedMatricula(historyMessages) &&
    inscricaoStage !== INSCRICAO_FORM_STATUS_AGUARDANDO &&
    inscricaoStage !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE &&
    !inscricaoFormAlreadyFilled({ inscricao_form_status: inscricaoStage })
      ? {
          role: 'system',
          content:
            'MATRÍCULA JÁ AUTORIZADA no histórico (lead respondeu "sim" após o resumo). ' +
            'PROIBIDO reenviar resumo de valores ou pedir autorização de matrícula novamente. ' +
            'Siga para polo (se faltar) ou formulário conforme o estado atual.',
        }
      : null

  const priceQueryHint = messageAsksCoursePrice(userMessage)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE VALORES/PREÇO: o lead quer saber quanto custa o curso em pauta. ' +
          `OBRIGATÓRIO neste turno: chame buscar_precos (e buscar_conhecimento se precisar de contexto) para o curso "${extractDiscussedCourseFromHistory(historyMessages) || extractCursoAreaFromText(userMessage) || 'mencionado no histórico'}". ` +
          'Responda com mensalidade promocional e preço cheio SOMENTE com dados do CONTEXT. ' +
          'PROIBIDO neste turno: tool inscricao, enviar formulário, enviar_grade_pdf, perguntar só "quer inscrição?" sem informar valores.',
      }
    : null

  const paymentInfoHint = messageAsksPaymentInfo(userMessage)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE FORMA/DATAS DE PAGAMENTO DA MENSALIDADE: o lead quer entender quando/como pagar a mensalidade (dias, vencimento, desconto por pagamento antecipado, pagamento no prazo) OU quais são as formas de pagamento aceitas (boleto, PIX, cartão de crédito). ' +
          'OBRIGATÓRIO neste turno: chame buscar_conhecimento com query sobre pagamento da mensalidade (ex.: "formas de pagamento da mensalidade boleto PIX cartão Portal do Aluno" ou "pagamento da mensalidade quais dias pagar dia de vencimento desconto por pagamento antecipado", conforme a dúvida) e responda com os dados da base. ' +
          'Se a dúvida for sobre QUAIS formas de pagamento existem: responda que o pagamento das mensalidades pode ser feito por boleto bancário, PIX ou cartão de crédito, e que é possível escolher/alterar a forma de pagamento no Portal do Aluno sempre que a mensalidade estiver disponível. ' +
          'Se o lead perguntar se o desconto vale só na 1ª mensalidade ou em todas: explique que pagando no 1º dia de cada mês o desconto máximo (70%) é aplicado na mensalidade daquele mês — ou seja, mantendo o pagamento no dia 1, o benefício se repete todo mês. ' +
          'PROIBIDO neste turno: encaminhar para consultor/humano apenas porque o lead perguntou sobre datas/forma de pagamento, ou recusa LGPD — essa informação É institucional e está na base. ' +
          'PROIBIDO confundir com pagamento da MATRÍCULA/taxa de inscrição ou link do contrato — se a dúvida for sobre isso, NÃO use este texto; siga o fluxo de inscrição/captação (link de contrato com suas próprias opções de pagamento).',
      }
    : null

  const taxaMatriculaHint = messageAsksTaxaMatriculaInstitucional(userMessage)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE TAXA DE MATRÍCULA (institucional): o lead quer saber se há matrícula e quanto custa. ' +
          'OBRIGATÓRIO neste turno: informe que a taxa de matrícula É a primeira mensalidade (mesmo valor promocional já informado no curso em pauta — ex.: R$ 97 ou conforme CONTEXT). ' +
          'Chame buscar_precos ou buscar_conhecimento se precisar confirmar o valor. ' +
          'PROIBIDO neste turno: recusa LGPD ou encaminhar consultor — pergunta sobre taxa institucional, não dado cadastral de terceiros.',
      }
    : null

  const poloListHint =
    messageAsksPoloAttendimentoList(userMessage) || messageAsksRegionalFacultyLocation(userMessage, historyMessages)
      ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE POLOS DE ATENDIMENTO EAD: o lead quer saber quais polos/unidades atendemos ou qual é o mais próximo. ' +
          'OBRIGATÓRIO neste turno: responda "Por este número de contato atendemos os seguintes polos:" e liste os 5 polos EAD com endereços:\n' +
          `${formatPoloListaNumerada()}\n` +
          'Todos os cursos são EAD; o polo é o ponto de apoio presencial. ' +
          'Se o lead perguntar por curso presencial ou semipresencial, informe que as aulas presenciais são na Central em Pinheiros (Rua Alegrete, 89). ' +
          'Não encaminhe consultor só por esta pergunta. ' +
          'PROIBIDO responder com recusa LGPD — endereços dos polos institucionais são informação pública permitida.',
      }
      : null

  const locationInfoHint =
    messageAsksSemipresencialCentral(userMessage) || messageAsksCampusOrPhoneContact(userMessage)
      ? {
          role: 'system',
          content:
            'PERGUNTA SOBRE LOCALIZAÇÃO/CONTATO DO CAMPUS OU CENTRAL: o lead quer telefone, contato ou endereço para falar com o campus/Central Sumaré ou saber onde são as aulas presenciais. ' +
            'OBRIGATÓRIO neste turno: responda PRIMEIRO essa pergunta — informe Central em Pinheiros (Rua Alegrete, 89, Sumaré, São Paulo/SP) e telefone/WhatsApp de contato institucional quando constar no CONTEXT. ' +
            'Chame buscar_conhecimento com query "central Pinheiros telefone contato campus endereço Rua Alegrete". ' +
            'Se o lead também pediu grade na mesma mensagem, responda o contato E depois chame enviar_grade_pdf (PDF pelo WhatsApp; PROIBIDO link do site). ' +
            'PROIBIDO neste turno: enviar só PDF da grade ignorando a pergunta de contato/campus; PROIBIDO encaminhar consultor só por endereço/telefone.',
        }
      : null

  const ouvidoriaHint = messageAsksOuvidoria(userMessage)
    ? {
        role: 'system',
        content:
          'PEDIDO DE OUVIDORIA: o lead quer o canal institucional de ouvidoria (reclamação formal, sugestão ou elogio à instituição). ' +
          'OBRIGATÓRIO neste turno: envie o link https://sumare.edu.br/ouvidoria.html e explique que lá estão as orientações de contato (inclui e-mail ouvidoria@sumare.edu.br). ' +
          'Pode chamar buscar_conhecimento com query "ouvidoria Sumaré contato reclamação". ' +
          'PROIBIDO neste turno: encaminhar consultor (distribuir_humano) em vez de informar o link da ouvidoria.',
      }
    : null

  const academicAffairsHint = messageAsksAcademicAffairsSupport(userMessage, historyMessages)
    ? {
        role: 'system',
        content:
          'ASSUNTO ACADÊMICO INSTITUCIONAL (trancamento, cancelamento de matrícula, ex-aluno, documentos escolares, inadimplência como aluno matriculado, etc.). ' +
          'OBRIGATÓRIO neste turno: responda com o direcionamento aos canais oficiais — Portal do Aluno (matrícula ativa), https://sumare.edu.br/atendimento/ (ex-aluno, cancelamento, trancamento, dúvidas gerais) e https://sumare.edu.br/ouvidoria.html (manifestação formal). ' +
          'Use o texto institucional completo (alunos ativos → Portal do Aluno; ex-alunos/cancelamento/trancamento → atendimento; ouvidoria → link da ouvidoria). ' +
          'PROIBIDO neste turno: prometer consultor, registrar pedido para equipe ligar, ou distribuir_humano — o canal oficial é a resposta correta.',
      }
    : null

  const priceUntilCourseEndHint = messageAsksPriceUntilCourseEnd(userMessage, historyMessages)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE VALOR ATÉ O FIM DO CURSO / REAJUSTE ANUAL: o lead quer saber se o desconto/mensalidade se mantém até o final da graduação ou o valor total do curso. ' +
          'OBRIGATÓRIO neste turno: informe a mensalidade promocional do curso em pauta (buscar_precos se necessário) e explique que o desconto especial se mantém até o final do curso, com reajuste anual pequeno de 8% a 12% com base na inflação; não informe valor exato do curso inteiro; mencione que as mensalidades costumam variar entre R$ 20 e R$ 40 ao ano. ' +
          'PROIBIDO neste turno: prometer mensalidade fixa sem reajuste, calcular valor total do curso, ou encaminhar consultor só por esta dúvida.',
      }
    : null

  const posGratisPromocaoHint = messageAsksPosGratisPromocao(userMessage)
    ? {
        role: 'system',
        content:
          'PERGUNTA SOBRE PROMOÇÃO PÓS-GRADUAÇÃO 100% GRATUITA: o lead quer saber se existe pós grátis ao final da graduação. ' +
          'OBRIGATÓRIO neste turno: confirme que a promoção existe (campanha vigente) e explique que, após concluir a graduação, o aluno tem 30 dias para entrar em contato com a Central da Faculdade Sumaré e solicitar a Pós-Graduação gratuita. ' +
          'Chame buscar_conhecimento com query "pós-graduação 100% gratuita promoção 30 dias central". ' +
          'PROIBIDO neste turno: dizer que "não consta na base" ou encaminhar consultor só por essa pergunta.',
      }
    : null

  const courseInquiryHint =
    messageAsksCourseInquiry(userMessage) || messageAsksModalidadeMecOrDistancia(userMessage)
      ? {
          role: 'system',
          content:
            'PERGUNTA SOBRE CURSO / MODALIDADE / MEC / DISTÂNCIA: o lead quer informações do curso (Pedagogia ou outro citado), valores, como se matricular, ou tem dúvida sobre 100% online / MEC / distância. ' +
            'OBRIGATÓRIO neste turno: chame buscar_conhecimento e buscar_precos para o curso em pauta; informe modalidade EXATA do CONTEXT (EAD ou Semipresencial), duração, mensalidade promocional e preço cheio. ' +
            'Se existir bloco OFERTA OFICIAL no CONTEXT, cite SOMENTE a(s) modalidade(s) listada(s) — nunca invente EAD + Semipresencial se só uma constar. ' +
            'Se o lead preferir distância e o curso for Semipresencial: explique que combina estudo a distância com encontros presenciais agendados na Central em Pinheiros (Rua Alegrete, 89) — não é 100% EAD quando o CONTEXT disser Semipresencial. ' +
            'Se perguntar como fazer a matrícula: explique que, quando quiser seguir, enviamos o formulário de inscrição aqui no WhatsApp. ' +
            'PROIBIDO neste turno: distribuir_humano ou encaminhar consultor — você TEM as informações na base e deve respondê-las.',
        }
      : null

  const discussedCourse =
    extractDiscussedCourseFromHistory(historyMessages) ||
    extractCursoAreaFromText(userMessage) ||
    'curso em pauta'
  const asksGradeInfo =
    (messageAsksGradeCurricular(userMessage) || messageAsksGradePdf(userMessage)) &&
    !messageAsksCampusOrPhoneContact(userMessage) &&
    !messageAsksLocationInfo(userMessage)

  const gradeCurricularHint = asksGradeInfo
      ? {
          role: 'system',
          content:
            'PEDIDO DE GRADE CURRICULAR / DISCIPLINAS: o lead quer saber matérias, disciplinas ou a grade do curso. ' +
            `OBRIGATÓRIO neste turno: chame enviar_grade_pdf com telefone, curso "${discussedCourse}" e modalidade se souber — envie o PDF automaticamente, sem perguntar "quer que eu envie?". ` +
            'Se enviar_grade_pdf funcionar: confirme brevemente no texto (2–3 exemplos de disciplinas + total) que o PDF foi enviado. ' +
            'Se enviar_grade_pdf falhar ou STATUS DA GRADE for NAO DISPONIVEL: resuma o que houver no CONTEXT e ofereça inscrição por este canal — PROIBIDO enviar link/URL do site ao lead. ' +
            'PROIBIDO: mandar link do site como alternativa ao PDF; PROIBIDO inventar disciplinas fora do CONTEXT.',
        }
      : null

  const discussedForMore =
    extractDiscussedCourseFromHistory(historyMessages) ||
    extractCursoAreaFromText(userMessage) ||
    ''
  const courseMoreDetailsHint =
    userAsksCourseMoreDetails(userMessage) && !messageAsksCoursePrice(userMessage)
      ? {
          role: 'system',
          content:
            'PEDIDO DE MAIS INFORMAÇÕES SOBRE O CURSO: o lead quer detalhes além de repetir duração/preço. ' +
            `OBRIGATÓRIO neste turno: chame buscar_conhecimento com query explícita incluindo o curso (ex.: "${discussedForMore || 'nome do curso em pauta'} graduação EAD perfil mercado funções") ` +
            'e buscar_precos se ainda não informou valores nesta conversa. ' +
            'Na resposta ao lead, entregue resumo com: área de interesse, áreas de trabalho, funções/atuações, modalidade, duração e mensalidade — usando SOMENTE o CONTEXT (bloco PERFIL DO CURSO quando existir). ' +
            'Não repita a mesma frase da mensagem anterior; aprofunde com os campos do PERFIL. ' +
            'PROIBIDO encerrar só perguntando sobre matrícula sem o resumo.',
        }
      : null

  const frustrationHint =
    frustrationAlreadySaid && !messageAsksCoursePrice(userMessage)
      ? {
          role: 'system',
          content:
            'O lead indicou que JÁ informou o curso/interesse. Peça desculpas breves, cite o curso que consta no histórico ' +
            `(${extractDiscussedCourseFromHistory(historyMessages) || 'Gestão Financeira ou o último curso citado'}) ` +
            'e ofereça seguir com inscrição (tool inscricao) ou tirar dúvida sobre ESSE curso — nunca pergunte "qual curso" de novo.',
        }
      : null

  const noContextWarning = ambiguousNoContext
    ? {
        role: 'system',
        content:
          '⚠️ AVISO CRÍTICO — VOCÊ NÃO TEM HISTÓRICO DESTA CONVERSA E O LEAD ENVIOU APENAS UMA CONFIRMAÇÃO CURTA OU AMBÍGUA. ' +
          'Você NÃO sabe sobre o que ele está confirmando. ' +
          'É TERMINANTEMENTE PROIBIDO: (a) mencionar qualquer nome de curso (Administração, Direito, Pedagogia, RH, etc.) que o lead não escreveu nesta mensagem; ' +
          '(b) propor inscrição em qualquer curso específico; (c) dar continuidade a um suposto fluxo anterior. ' +
          'AÇÃO OBRIGATÓRIA: pergunte gentilmente em qual curso ou assunto ele tem interesse, ou peça pra ele reformular a mensagem. ' +
          'Exemplo de resposta correta: "Oi! Para te ajudar melhor, em qual curso você tem interesse?"',
      }
      : null

  const lgpdHint = { role: 'system', content: buildLgpdSystemHint(userMessage) }

  const apiMessages = [
    { role: 'system', content: systemMessage },
    ...(contextPreamble ? [{ role: 'system', content: contextPreamble }] : []),
    lgpdHint,
    ...(courseDriftHint ? [courseDriftHint] : []),
    ...(inscricaoToolsHint ? [inscricaoToolsHint] : []),
    ...(poloStageGuardHint ? [poloStageGuardHint] : []),
    ...(matriculaAuthGuardHint ? [matriculaAuthGuardHint] : []),
    ...(commercialHint ? [commercialHint] : []),
    ...(courseInterestHint ? [courseInterestHint] : []),
    ...(activeFlowHint ? [activeFlowHint] : []),
    ...(priceQueryHint ? [priceQueryHint] : []),
    ...(paymentInfoHint ? [paymentInfoHint] : []),
    ...(taxaMatriculaHint ? [taxaMatriculaHint] : []),
    ...(poloListHint ? [poloListHint] : []),
    ...(locationInfoHint ? [locationInfoHint] : []),
    ...(ouvidoriaHint ? [ouvidoriaHint] : []),
    ...(academicAffairsHint ? [academicAffairsHint] : []),
    ...(priceUntilCourseEndHint ? [priceUntilCourseEndHint] : []),
    ...(posGratisPromocaoHint ? [posGratisPromocaoHint] : []),
    ...(courseInquiryHint ? [courseInquiryHint] : []),
    ...(gradeCurricularHint ? [gradeCurricularHint] : []),
    ...(courseMoreDetailsHint ? [courseMoreDetailsHint] : []),
    ...(transferenciaFlowHint ? [transferenciaFlowHint] : []),
    ...(enrollmentConfirmHint ? [enrollmentConfirmHint] : []),
    ...(frustrationHint ? [frustrationHint] : []),
    ...(noContextWarning ? [noContextWarning] : []),
    ...historyMessages,
    { role: 'user', content: userMessage },
  ]
  console.log(
    `[${executionId}] MONTOU_PROMPT promptsLoaded=${prompts.length} systemChars=${systemMessage.length} historyMsgs=${historyMessages.length} ambiguousNoContext=${ambiguousNoContext} enrollmentContinuation=${enrollmentContinuation} model=${model}`,
  )

  const executors = buildToolExecutors(env, ctx, {
    telefone,
    leadId,
    pushName: input?.pushName,
    executionId,
    model,
    t0,
    userMessage,
    wantsCourseMoreDetails: userAsksCourseMoreDetails(userMessage),
  })
  const toolTrace = []
  const usage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }

  // Snapshot inicial do "contexto" enviado pro LLM no round 1. Útil
  // pra debug — sem isso era cego se o prompt mudou ou se o Contexto
  // (telefone/leadId) estava chegando.
  const ctxSnapshot = {
    systemPromptChars: systemMessage.length,
    contextPreamble: contextPreamble || null,
    historyCount: historyMessages.length,
    historySource,
    historySourceDetail,
    courseSwitch: summarizeCourseSwitchForSnapshot(courseSwitch),
    noContextWarning: ambiguousNoContext,
    toolsAvailable: toolDefinitions.map((t) => t.function?.name).filter(Boolean),
    userMessage,
  }

  // Steps granulares por round do orquestrador — espelha o que o
  // SalesbotExecutions já mostra.  Cada round vira um step com:
  //   - decisão do LLM (respondeu vs chamou tools)
  //   - tokens consumidos
  //   - mensagens enviadas (resumido pra não estourar o JSONB)
  //   - resposta crua do LLM (content + tool_calls + finish_reason)
  const orchestratorSteps = []

  function summarizeMessage(m) {
    if (!m || typeof m !== 'object') return null
    const out = { role: m.role }
    if (typeof m.content === 'string') {
      out.content = m.content.length > 400 ? `${m.content.slice(0, 400)}…` : m.content
    } else if (m.content == null) {
      out.content = null
    } else {
      out.content = '[non-string]'
    }
    if (Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      out.tool_calls = m.tool_calls.map((tc) => ({
        id: tc.id,
        name: tc.function?.name,
        arguments: tc.function?.arguments,
      }))
    }
    if (m.tool_call_id) out.tool_call_id = m.tool_call_id
    if (m.name) out.name = m.name
    return out
  }

  try {
    let round = 0
    while (round < MAX_TOOL_ROUNDS) {
      const roundT0 = Date.now()
      const data = await callOpenAI(env, apiMessages, model, toolDefinitions)
      const roundDurationMs = Date.now() - roundT0
      const choice = data.choices?.[0]
      const msg = choice?.message
      if (!msg) throw new Error('Sem resposta da API')

      const roundUsage = data.usage
        ? {
            prompt_tokens: data.usage.prompt_tokens || 0,
            completion_tokens: data.usage.completion_tokens || 0,
            total_tokens: data.usage.total_tokens || 0,
          }
        : null
      if (roundUsage) {
        usage.prompt_tokens += roundUsage.prompt_tokens
        usage.completion_tokens += roundUsage.completion_tokens
        usage.total_tokens += roundUsage.total_tokens
      }

      const wantsTools = choice.finish_reason === 'tool_calls' || (msg.tool_calls && msg.tool_calls.length > 0)
      // Cada round salva: o que o LLM "viu" + o que decidiu fazer.
      // messagesSent fica resumido (primeiras 3 e últimas 6) pra não
      // explodir o JSONB no Supabase em conversas longas.
      const sent = apiMessages.map(summarizeMessage)
      const messagesSent = sent.length > 9
        ? [...sent.slice(0, 3), { role: 'system', content: `[…cortadas ${sent.length - 9} mensagens do meio…]` }, ...sent.slice(-6)]
        : sent
      orchestratorSteps.push({
        type: 'llm_call',
        round: round + 1,
        model,
        durationMs: roundDurationMs,
        usage: roundUsage,
        decision: wantsTools ? 'tool_calls' : 'reply',
        finishReason: choice.finish_reason || null,
        messagesSentCount: apiMessages.length,
        messagesSent,
        llmResponse: summarizeMessage(msg),
      })

      if (wantsTools) {
        apiMessages.push(msg)
        const { results: toolResults, actionResults } = await executeToolCalls(
          executors,
          msg.tool_calls,
          toolTrace,
          ctx,
          { env, telefone, leadId, executionId },
        )
        apiMessages.push(...toolResults)

        // Tool de ação de inscrição retornou texto fixo? → encerra o loop e
        // usa o `replyOverride` como reply final. O LLM NÃO é chamado de
        // novo, e qualquer `msg.content` é descartado: o que vai pro lead
        // é o texto do servidor — a única fonte da verdade do estado.
        const actionOverride = actionResults.find(
          (a) => a.result && typeof a.result.replyOverride === 'string' && a.result.replyOverride.trim().length > 0,
        )
        if (actionOverride) {
          const ar = actionOverride.result
          const stageBefore = formFlowCtx.stageBefore || null
          const stageAfter = ar.ctxSnapshot?.inscricaoForm || null
          console.log(
            `[${executionId}] TOOL_ACTION_REPLY_OVERRIDE tool=${actionOverride.tool} code=${ar.code} ok=${ar.ok} stage=${stageBefore || '?'}→${stageAfter || '?'}`,
          )
          orchestratorSteps.push({
            type: 'tool_action_reply_override',
            tool: actionOverride.tool,
            code: ar.code,
            ok: Boolean(ar.ok),
            stage_before: stageBefore,
            stage_after: stageAfter,
            durationMs: Date.now() - roundT0,
          })
          for (const s of ar.steps || []) orchestratorSteps.push(s)
          return {
            // replyOverride = turno tratado com texto pro lead; ar.ok só indica
            // sucesso operacional da tool (ex. POLO_NEEDED ok=false ainda envia resposta).
            ok: true,
            reply: ar.replyOverride,
            toolCalls: toolTrace,
            orchestratorSteps,
            ctxSnapshot: {
              ...ctxSnapshot,
              ...(ar.ctxSnapshot || {}),
              replySource: 'tool_action_override',
              actionTool: actionOverride.tool,
              actionCode: ar.code,
              acao_inscricao_tomada: actionOverride.tool,
              stage_before: stageBefore,
              stage_after: stageAfter,
            },
            usage,
            durationMs: Date.now() - t0,
            historyLoaded: historyMessages.length,
            executionId,
            model,
            aiMeta: ctx.toAiMeta(),
            inscricaoActionHandled: true,
          }
        }

        round++
        continue
      }

      let reply = msg.content || 'Sem resposta.'
      if (!blockStaleEnrollment) {
        const formAfter = await tryEnsureInscricaoFormSent(env, {
          ...formFlowCtx,
          llmReply: reply,
        })
        if (formAfter?.handled) {
          console.log(
            `[${executionId}] INSCRICAO_FORM_AFTER_LLM template_ok=${formAfter.result?.toolCalls?.[0]?.ok ?? false}`,
          )
          return {
            ...formAfter.result,
            toolCalls: [...(formAfter.result.toolCalls || []), ...toolTrace],
            orchestratorSteps,
            historyLoaded: historyMessages.length,
            aiMeta: ctx.toAiMeta(),
          }
        }
        if (llmReplyImpliesPendingFormSend(reply)) {
          console.warn(
            `[${executionId}] LLM prometeu formulário sem entrega — substituindo resposta por fluxo servidor`,
          )
          const retryPolo = await tryHandlePoloPreFormFlow(env, formFlowCtx)
          if (retryPolo?.handled) {
            return {
              ...retryPolo.result,
              toolCalls: [...(retryPolo.result.toolCalls || []), ...toolTrace],
              orchestratorSteps,
              historyLoaded: historyMessages.length,
              aiMeta: ctx.toAiMeta(),
            }
          }
          const retryForm = await tryHandleInscricaoFormStart(env, formFlowCtx)
          if (retryForm?.handled) {
            return {
              ...retryForm.result,
              toolCalls: [...(retryForm.result.toolCalls || []), ...toolTrace],
              orchestratorSteps,
              historyLoaded: historyMessages.length,
              aiMeta: ctx.toAiMeta(),
            }
          }
        }
      }

      // Guard de saída — bloqueia reply que mente sobre ação não executada.
      // Roda em TODOS os turnos que produziram texto (até quando uma tool de
      // busca foi chamada): só compara fato (tool de ação chamada?) vs narrativa.
      let guardViolation = null
      const guardVerdict = validateReplyBeforeSend({
        reply,
        toolCalls: toolTrace,
        stage: formFlowCtx.stageBefore || null,
        userMessage,
        env,
      })
      if (guardVerdict.violation) {
        console.warn(
          `[${executionId}] REPLY_GUARD violacao=${guardVerdict.code} stage=${formFlowCtx.stageBefore || 'n/a'} originalLen=${(reply || '').length}`,
        )
        guardViolation = {
          code: guardVerdict.code,
          stage: formFlowCtx.stageBefore || null,
          originalReply: guardVerdict.original,
        }
        orchestratorSteps.push({
          type: 'reply_guard',
          violation: true,
          code: guardVerdict.code,
          stage_before: formFlowCtx.stageBefore || null,
          originalReplyPreview: String(guardVerdict.original || '').slice(0, 200),
          replacementApplied: true,
        })
        reply = guardVerdict.safeReply
        await recordInscricaoFailureAuditNote(env, {
          leadId,
          telefone,
          code: guardVerdict.code,
          motivo: `Resposta bloqueada pelo guard: ${String(guardVerdict.original || '').slice(0, 300)}`,
          tipo: 'resposta bloqueada',
          executionId,
        }).catch(() => {})
      }

      // Fix 1 — Auto-sync de inscricao_form_status quando o REPLY final
      // contém texto canônico de transição (ex.: pergunta de polo) mas o
      // estado no Supabase ficou para trás. Sem isso, o próximo turno do
      // lead (ex.: "5") fica órfão se o histórico vier vazio.
      let autoSyncResult = null
      if (telefone) {
        autoSyncResult = await autoSyncInscricaoStateFromReply(env, {
          telefone,
          leadId,
          reply,
          currentStage: formFlowCtx.stageBefore || null,
          executionId,
        }).catch((err) => {
          console.warn(`[${executionId}] auto_sync_state catch:`, err?.message || err)
          return null
        })
        if (autoSyncResult?.synced) {
          orchestratorSteps.push({
            type: 'inscricao_state_auto_sync',
            signal: autoSyncResult.signal,
            stage_before: autoSyncResult.previous || null,
            stage_after: autoSyncResult.target,
          })
        }
      }

      return {
        ok: true,
        reply,
        toolCalls: toolTrace,
        orchestratorSteps,
        ctxSnapshot: {
          ...ctxSnapshot,
          stage_before: formFlowCtx.stageBefore || null,
          stage_after_auto_sync: autoSyncResult?.synced ? autoSyncResult.target : null,
          acao_inscricao_tomada: null,
          guard_violation: guardViolation?.code || null,
          replySource: guardViolation ? 'reply_guard_override' : 'llm',
        },
        usage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
        guardViolation,
      }
    }
    return {
      ok: false,
      error: 'Limite de rodadas de tools atingido.',
      toolCalls: toolTrace,
      orchestratorSteps,
      ctxSnapshot,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  } catch (err) {
    if (isOpenAiTransientError(err)) {
      console.warn(`[${executionId}] OpenAI instável — resposta fallback ao lead: ${err.message}`)
      orchestratorSteps.push({ type: 'openai_transient_fallback', error: String(err.message).slice(0, 300) })
      return {
        ok: true,
        reply: buildOpenAiTransientFallbackReply(),
        toolCalls: toolTrace,
        orchestratorSteps,
        ctxSnapshot: { ...ctxSnapshot, openaiTransientFallback: true },
        usage,
        durationMs: Date.now() - t0,
        historyLoaded: historyMessages.length,
        executionId,
        model,
        aiMeta: ctx.toAiMeta(),
        openaiError: err.message,
      }
    }
    return {
      ok: false,
      error: err.message,
      toolCalls: toolTrace,
      orchestratorSteps,
      ctxSnapshot,
      usage,
      durationMs: Date.now() - t0,
      executionId,
      model,
      aiMeta: ctx.toAiMeta(),
    }
  }
}
