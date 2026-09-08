/**
 * Transferência externa / aproveitamento de matérias — handlers determinísticos
 * para não perder origem, destino e semestre já informados no histórico.
 */

import { normalizeMessageForScope } from '../libShared/scopeHeuristics.js'
import {
  extractCursoAreaFromText,
  isPastOrCurrentFormationWithoutDestination,
} from '../libShared/cursoConfirmation.js'
import { lastAssistantText } from '../libShared/inscricaoFormHeuristics.js'
import { runRegistrarTransferencia } from './inscricaoActionTools.js'
import { maybeAuditActionToolFailure } from './inscricaoFailureAudit.js'

const TRANSFERENCIA_PEDIDO_RX =
  /transfer[eê]ncia|aproveitamento\s+de\s+(mat[eé]rias|disciplinas)/i

const TRANSFERENCIA_USER_SIGNAL_RX =
  /outra\s+faculdade|transfer[eê]ncia|aproveitamento|parou\s+no|tranquei|parei\s+no|terminei\s+no|cursava|cursando\s+.+\s+em\s+outr|comecei\s+.+\s+em\s+outra/i

const INVALID_CURSO_LABEL_RX =
  /como\s+fa[çc]o|boa\s+noite|matricular|gostaria\s+me|mensalidade|taxa\s+de\s+matr[ií]cula|dura[cç][aã]o\s+de/i

const SEMESTRE_PEDIDO_RX =
  /(?:me confirme|último semestre|semestre conclu[ií]do|semestre cursado)/i

const ORDINAL_TO_NUM = {
  primeiro: '1',
  primeira: '1',
  segundo: '2',
  segunda: '2',
  terceiro: '3',
  terceira: '3',
  quarto: '4',
  quarta: '4',
  quinto: '5',
  quinta: '5',
  sexto: '6',
  sexta: '6',
  setimo: '7',
  sétimo: '7',
  setima: '7',
  sétima: '7',
  oitavo: '8',
  oitava: '8',
  nono: '9',
  nona: '9',
  decimo: '10',
  décimo: '10',
}

function buildAgentReturn({ executionId, model, t0, reply, steps, toolCalls, ctxSnapshot, ok = true }) {
  return {
    ok,
    reply,
    toolCalls: toolCalls || [],
    orchestratorSteps: steps || [],
    ctxSnapshot: ctxSnapshot || {},
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    durationMs: Date.now() - t0,
    executionId,
    model,
    inscricaoFormHandled: true,
  }
}

function cleanCursoLabel(raw) {
  return String(raw || '')
    .replace(/\s+da\s+Faculdade\s+Sumar[eé].*/i, '')
    .replace(/\s+na\s+Sumar[eé].*/i, '')
    .replace(/\s+da\s+Sumar[eé].*/i, '')
    .replace(/[.,;:!?]+$/, '')
    .trim()
}

function normalizeCursoKey(s) {
  return String(s || '')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export function isValidTransferenciaCursoLabel(label) {
  const s = cleanCursoLabel(label)
  if (!s || s.length < 3 || s.length > 80) return false
  if (INVALID_CURSO_LABEL_RX.test(s)) return false
  if (/^\d+$/.test(s)) return false
  return true
}

/** Lead confirma que o curso de origem é o mesmo do destino ("só pedagogia mesmo"). */
export function messageRestatesSameCourseAsDestino(userMessage, destinoHint) {
  const t = normalizeMessageForScope(userMessage).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 80) return false
  if (/o\s+mesmo\s+curso|mesmo\s+curso/i.test(t)) return true
  if (/^(s[oó]|somente|apenas)\s/i.test(t) && /\bmesmo\b/i.test(t)) return true
  const area = extractCursoAreaFromText(userMessage)
  if (area && isValidTransferenciaCursoLabel(area)) {
    if (/^(s[oó]|somente|apenas)\s/i.test(t)) return true
    if (destinoHint && normalizeCursoKey(area).includes(normalizeCursoKey(destinoHint).slice(0, 5))) {
      return true
    }
  }
  return false
}

export function assistantAskedTransferenciaCursoOrigem(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  return (
    /nome\s+(?:exato\s+)?do\s+curso/i.test(t) &&
    /(?:cursava|cursou|faculdade|anterior|transfer|aproveit|continuidade)/i.test(t)
  )
}

function normalizeRole(role) {
  return role === 'assistente' ? 'assistant' : role
}

function findTransferenciaWindowStart(historyMessages = []) {
  for (let i = 0; i < historyMessages.length; i++) {
    const m = historyMessages[i]
    if (normalizeRole(m?.role) !== 'user') continue
    if (TRANSFERENCIA_USER_SIGNAL_RX.test(String(m.content || ''))) return i
  }
  for (let i = 0; i < historyMessages.length; i++) {
    const m = historyMessages[i]
    if (normalizeRole(m?.role) === 'assistant' && TRANSFERENCIA_PEDIDO_RX.test(String(m.content || ''))) {
      return Math.max(0, i - 1)
    }
  }
  return historyMessages.length
}

function extractDestinoFromMatriculaAssistant(text) {
  const patterns = [
    /ingressar\s+no\s+curso\s+de\s+["'""]?([^"'"".]+?)["'""]?(?:\s+com|\s*$)/i,
    /curso\s+de\s+["'"]([^"']+)["'"]\s+com\s+dura/i,
    /(?:você irá ingressar|vai cursar)\s+no\s+curso\s+de\s+["'""]?([^"'"".]+?)["'""]?/i,
  ]
  for (const rx of patterns) {
    const m = String(text || '').match(rx)
    if (m?.[1] && isValidTransferenciaCursoLabel(m[1])) return cleanCursoLabel(m[1])
  }
  return null
}

/** Lista ambígua de várias formações (ex.: "Cursei A, B e estou cursando C"). */
export function isAmbiguousMultiFormationList(text) {
  const raw = String(text || '').trim()
  if (!raw) return false
  const verbHits = (raw.match(/\b(cursei|cursava|estudei|fiz|(?:estou|estava)\s+cursando|cursando)\b/gi) || [])
    .length
  if (verbHits >= 2) return true
  // Um verbo + enumeração com vírgula e "e"
  if (verbHits >= 1 && /,\s*.+\be\b/i.test(raw)) return true
  return false
}

function extractOrigemFromTransferUserText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  if (/matricular|como\s+fa[çc]o|gostaria\s+me/i.test(raw) && !TRANSFERENCIA_USER_SIGNAL_RX.test(raw)) {
    return null
  }
  // Várias formações citadas → não inventar uma origem única
  if (isAmbiguousMultiFormationList(raw)) return null

  let m = raw.match(
    /(?:comecei|cursei|cursava|cursando|estava\s+cursando|estudei)\s+(?:a\s+)?(?:o\s+)?(?:curso\s+de\s+)?(.+?)\s+em\s+outra/i,
  )
  if (m?.[1] && isValidTransferenciaCursoLabel(m[1])) return cleanCursoLabel(m[1])

  m = raw.match(/(?:licenciatura|bacharelado|tecn[oó]logo)\s+em\s+(.+?)(?:\s*\.|,|$)/i)
  if (m?.[1] && isValidTransferenciaCursoLabel(m[1])) return cleanCursoLabel(m[1])

  const sameCourse = raw.match(/^(?:s[oó]|somente|apenas)\s+(?:a|o)?\s*(.+?)(?:\s+mesmo)?$/i)
  if (sameCourse?.[1] && isValidTransferenciaCursoLabel(sameCourse[1])) {
    return cleanCursoLabel(sameCourse[1])
  }

  const area = extractCursoAreaFromText(raw)
  if (area && isValidTransferenciaCursoLabel(area) && TRANSFERENCIA_USER_SIGNAL_RX.test(raw)) {
    // "Quero fazer X ... outra faculdade" → X é destino, não origem
    const hasDestinoIntent = /\b(quero|gostaria|pretendo|desejo)\b/i.test(raw)
    const hasOrigemVerb =
      /\b(cursei|cursava|estudei|comecei|tranquei|parei|terminei|cursando)\b/i.test(raw)
    if (hasDestinoIntent && !hasOrigemVerb) return null
    return cleanCursoLabel(area)
  }
  return null
}

export function conversationMentionsTransferencia(historyMessages = []) {
  const blob = (historyMessages || [])
    .map((m) => String(m.content || ''))
    .join('\n')
    .toLowerCase()
  return (
    TRANSFERENCIA_PEDIDO_RX.test(blob) ||
    /ingressar\s+no\s+.+\s+aproveit/i.test(blob) ||
    TRANSFERENCIA_USER_SIGNAL_RX.test(blob)
  )
}

export function assistantAskedTransferenciaDadosPendentes(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  if (TRANSFERENCIA_PEDIDO_RX.test(t) && SEMESTRE_PEDIDO_RX.test(t)) return true
  if (
    /qual\s+(?:é|era)\s+o\s+curso\b/i.test(t) &&
    /(?:cursava|cursou|faculdade|institui[cç][aã]o|anterior)/i.test(t) &&
    SEMESTRE_PEDIDO_RX.test(t)
  ) {
    return true
  }
  if (/curso\s+que\s+voc[eê]\s+(?:cursava|cursou)/i.test(t) && SEMESTRE_PEDIDO_RX.test(t)) {
    return true
  }
  return false
}

export function assistantAskedTransferenciaConfirmacao(assistantText) {
  const t = String(assistantText || '')
  if (!t) return false
  if (!/aproveitar\s+(?:as\s+)?disciplinas/i.test(t) && !/só\s+para\s+confirmar/i.test(t)) {
    return false
  }
  return (
    /\bcerto\??/i.test(t) ||
    /para\s+ingressar\s+no/i.test(t) ||
    (/deseja\b/i.test(t) && /ingressar/i.test(t))
  )
}

export function messageConfirmsTransferencia(userMessage) {
  const t = normalizeMessageForScope(userMessage).toLowerCase().trim().replace(/[.!?]+$/, '')
  if (!t || t.length > 40) return false
  return /^(sim|s|isso|correto|confirmo|pode ser|ok|certo|exato)\b/i.test(t)
}

export function parseSemestreFromUserMessage(message) {
  const raw = String(message || '').trim()
  if (!raw) return null
  const norm = raw
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()

  const hasSemestreCue =
    /(?:ultimo\s+semestre|semestre\s+conclu|semestre\s+cursado|parei\s+no|parou\s+no|tranquei|terminei\s+no)\b/i.test(
      norm,
    )

  // Data de nascimento / CPF no formulário nunca é semestre (Rute #24045).
  if (/\b\d{1,2}[\/.-]\d{1,2}[\/.-]\d{2,4}\b/.test(norm) && !hasSemestreCue) return null
  const onlyDigits = norm.replace(/\D/g, '')
  if (onlyDigits.length >= 8 && !hasSemestreCue) return null

  const yearMatch =
    norm.match(/(?:ultimo\s+semestre|semestre\s+conclu[ií]do|semestre\s+cursado)\s*(?:de\s+)?(\d{4})\b/i) ||
    norm.match(/\bsemestre\s+de\s+(\d{4})\b/i)
  if (yearMatch?.[1]) return yearMatch[1]

  for (const [word, num] of Object.entries(ORDINAL_TO_NUM)) {
    if (norm.includes(word)) return num
  }

  const semMatch = norm.match(
    /(?:ultimo\s+semestre|semestre\s+conclu[ií]do|semestre\s+cursado)\s*(?:de\s+)?(\d{1,2})\b/i,
  )
  if (semMatch?.[1]) return semMatch[1]

  // Dígito isolado só vale como semestre se a mensagem INTEIRA for o número
  // (resposta a "qual semestre?"). Não extrair "1"/"12" de listas, CPF ou data.
  if (/^\s*\d{1,2}\s*$/.test(norm)) {
    const n = Number(norm.trim())
    if (n >= 1 && n <= 12) return String(n)
  }

  return null
}

export function parseTransferenciaIntentFromText(text) {
  const t = String(text || '').trim()
  if (!t) return null

  const patterns = [
    /(?:cursando|cursava|cursar|estudo|estudando|estava\s+cursando)\s+(.+?)\s+e\s+quero\s+(?:fazer|cursar|estudar|continuar(?:\s+com)?|mudar\s+para)\s+(?:curso\s+(?:de|em)\s+)?(.+)$/i,
    /(?:quero|gostaria\s+de)\s+(?:fazer|cursar|estudar|continuar(?:\s+com)?)\s+(?:curso\s+(?:de|em)\s+)?(.+?)\s+(?:aproveitando|transferindo|vindo)\s+(?:de|do|da)\s+(.+)$/i,
    /(?:transferir|mudar|trocar)\s+(?:de\s+)?(.+?)\s+para\s+(.+)$/i,
    /(?:sai\s+de|saindo\s+de|vim\s+de)\s+(.+?)\s+(?:e\s+)?(?:quero|vou)\s+(?:fazer|cursar)\s+(.+)$/i,
  ]

  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1] && m?.[2]) {
      return { origem: cleanCursoLabel(m[1]), destino: cleanCursoLabel(m[2]) }
    }
  }
  return null
}

export function extractOrigemSemestreFromUserText(text) {
  const raw = String(text || '').trim()
  if (!raw) return null

  if (/matricular|como\s+fa[çc]o|gostaria\s+me/i.test(raw) && !TRANSFERENCIA_USER_SIGNAL_RX.test(raw)) {
    const semestreOnly = parseSemestreFromUserMessage(raw)
    return semestreOnly ? { origem: null, semestre: semestreOnly } : null
  }

  let origem = extractOrigemFromTransferUserText(raw)
  if (!origem && !isAmbiguousMultiFormationList(raw)) {
    const origemPatterns = [
      /(?:^|[.;]\s*)(?:licenciatura|bacharelado|tecn[oó]logo)\s+em\s+(.+?)(?:\s*\.|\s*,|\s*último|$)/i,
      /(?:cursava|cursando|estudei|fiz)\s+(?:licenciatura|bacharelado|tecn[oó]logo)?\s*(?:em\s+)?(.+?)(?:\s*\.|\s*,|\s*último|$)/i,
    ]
    for (const rx of origemPatterns) {
      const m = raw.match(rx)
      if (m?.[1] && isValidTransferenciaCursoLabel(m[1])) {
        origem = cleanCursoLabel(m[1])
        break
      }
    }
  }

  const semestre = parseSemestreFromUserMessage(raw)
  if (!origem && !semestre) return null
  return { origem, semestre }
}

export function extractTransferenciaConfirmacaoFromAssistant(text) {
  const t = String(text || '')
  const patterns = [
    /disciplinas\s+da\s+(.+?)\s+(?:que\s+)?(?:cursou|cursava|fez).*?(?:para\s+)?ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/is,
    /aproveitar\s+(?:as\s+)?disciplinas\s+(?:da|de)\s+(.+?)\s+.*ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/is,
  ]
  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1] && m?.[2]) {
      return { origem: cleanCursoLabel(m[1]), destino: cleanCursoLabel(m[2]) }
    }
  }
  return null
}

export function extractTransferenciaDestinoFromAssistant(text) {
  const t = String(text || '')
  const patterns = [
    /que\s+no\s+seu\s+caso\s+[ée]\s+([^.,;)\n]+)/i,
    /orientar\s+melhor\s+para\s+o\s+(.+?)(?:\s+na\s+Sumar[eé]|,|\.|\?|$)/i,
    /ingressar\s+no\s+(.+?)(?:\s+da\s+Faculdade|\s+na\s+Sumar[eé]|\s+da\s+Sumar[eé]|,|\.|\?|$)/i,
    /curso\s+de\s+(?:gradua[cç][aã]o\s+em\s+)?(.+?)\s+na\s+Sumar[eé]/i,
  ]
  for (const rx of patterns) {
    const m = t.match(rx)
    if (m?.[1] && isValidTransferenciaCursoLabel(m[1])) return cleanCursoLabel(m[1])
  }
  return null
}

export function extractTransferenciaFromHistory(historyMessages = []) {
  const users = [...historyMessages].reverse().filter((m) => normalizeRole(m?.role) === 'user')
  for (const m of users) {
    const parsed = parseTransferenciaIntentFromText(m.content)
    if (parsed?.origem && parsed?.destino) return parsed
  }
  return null
}

/**
 * Monta origem, destino e semestre a partir de mensagens separadas no histórico
 * (lead informa origem+semestre; assistente confirma destino; lead confirma com "sim").
 */
export function extractTransferenciaContext(historyMessages = []) {
  if (!conversationMentionsTransferencia(historyMessages)) return null

  let origem = null
  let destino = null
  let semestre = null

  const startIdx = findTransferenciaWindowStart(historyMessages)
  const windowMsgs =
    startIdx < historyMessages.length ? historyMessages.slice(startIdx) : historyMessages

  for (const m of historyMessages) {
    if (normalizeRole(m?.role) !== 'assistant') continue
    const d =
      extractDestinoFromMatriculaAssistant(m.content) ||
      extractTransferenciaDestinoFromAssistant(m.content)
    if (d && isValidTransferenciaCursoLabel(d)) {
      destino = d
      break
    }
  }

  for (const m of [...windowMsgs].reverse()) {
    if (normalizeRole(m?.role) !== 'assistant') continue
    const conf = extractTransferenciaConfirmacaoFromAssistant(m.content)
    if (conf?.origem && conf?.destino && isValidTransferenciaCursoLabel(conf.origem)) {
      origem = conf.origem
      destino = conf.destino
      break
    }
  }

  if (!destino) {
    for (const m of [...windowMsgs].reverse()) {
      if (normalizeRole(m?.role) !== 'assistant') continue
      const d = extractTransferenciaDestinoFromAssistant(m.content)
      if (d && isValidTransferenciaCursoLabel(d)) {
        destino = d
        break
      }
    }
  }

  for (const m of [...windowMsgs].reverse()) {
    if (normalizeRole(m?.role) !== 'user') continue
    const parsed = parseTransferenciaIntentFromText(m.content)
    if (parsed?.origem && isValidTransferenciaCursoLabel(parsed.origem) && !origem) {
      origem = parsed.origem
    }
    if (parsed?.destino && isValidTransferenciaCursoLabel(parsed.destino) && !destino) {
      destino = parsed.destino
    }
    const oOrig = extractOrigemFromTransferUserText(m.content)
    if (oOrig && !origem) origem = oOrig
    const os = extractOrigemSemestreFromUserText(m.content)
    if (os?.origem && isValidTransferenciaCursoLabel(os.origem) && !origem) origem = os.origem
    if (os?.semestre && !semestre) semestre = os.semestre
    const sem = parseSemestreFromUserMessage(m.content)
    if (sem && !semestre) semestre = sem
    if (messageRestatesSameCourseAsDestino(m.content, destino) && destino && !origem) {
      origem = destino
    }
    // Não auto-atribuir origem=destino só porque a área citada coincide —
    // listas de formação anterior/atual não afirmam origem única (Lidi usa restate).
  }

  // Canonicaliza casing quando origem e destino já são o mesmo curso (evidência prévia).
  // Não fabricar origem ausente.
  if (
    origem &&
    destino &&
    normalizeCursoKey(origem) === normalizeCursoKey(destino)
  ) {
    origem = destino
  }

  if (!destino || !isValidTransferenciaCursoLabel(destino)) return null
  if (origem && !isValidTransferenciaCursoLabel(origem)) origem = null
  return { origem: origem || null, destino, semestre: semestre || null }
}

async function runTransferenciaComplete(env, ctx, payload, stepType) {
  const { telefone, leadId, pushName, executionId, model, historyMessages, t0 } = ctx
  const flowCtx = { telefone, leadId, pushName, executionId, model, historyMessages, t0 }
  const result = await runRegistrarTransferencia(env, payload, flowCtx)
  await maybeAuditActionToolFailure(env, flowCtx, result)

  const reply = result.replyOverride || result.text
  if (!reply) return null

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps: [{ type: stepType, ok: Boolean(result.ok), code: result.code }, ...(result.steps || [])],
      toolCalls: [{ tool: 'registrar_transferencia', ok: Boolean(result.ok), code: result.code }],
      ctxSnapshot: {
        ...(result.ctxSnapshot || {}),
        replySource: stepType,
        transferenciaAutoComplete: true,
      },
    }),
  }
}

function buildTransferenciaDadosIncompletosReply({ destino, missingOrigem, missingSemestre }) {
  const destinoLabel = destino || 'o curso desejado'
  const parts = [
    `Entendi — os cursos que você citou são formações anteriores ou atuais e não alteram o destino (${destinoLabel}).`,
  ]
  if (missingOrigem && missingSemestre) {
    parts.push(
      'Para o aproveitamento, me diga apenas: (1) qual formação devemos usar como curso de origem da transferência e (2) qual foi o último semestre concluído nela.',
    )
  } else if (missingOrigem) {
    parts.push(
      'Para o aproveitamento, me diga qual formação devemos usar como curso de origem da transferência.',
    )
  } else if (missingSemestre) {
    parts.push('Para o aproveitamento, me diga qual foi o último semestre concluído no curso de origem.')
  }
  return parts.join(' ')
}

/**
 * Lead respondeu dados de transferência após o agente pedir origem/semestre.
 */
export async function tryHandleTransferenciaDadosPendentes(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId, model, t0 } = ctx
  if (!telefone || !userMessage) return null

  const lastAssist = lastAssistantText(historyMessages)
  if (
    !assistantAskedTransferenciaDadosPendentes(lastAssist) &&
    !assistantAskedTransferenciaCursoOrigem(lastAssist)
  ) {
    return null
  }

  const context = extractTransferenciaContext([
    ...historyMessages,
    { role: 'user', content: userMessage },
  ])

  const missingOrigem = !context?.origem
  const missingSemestre = !context?.semestre
  const hasDestino = Boolean(context?.destino)

  // Guarda determinística: só listou formações anteriores/atuais, sem completar campos.
  // Short-circuit antes do LLM e sem acesso externo.
  if (
    (missingOrigem || missingSemestre) &&
    (isPastOrCurrentFormationWithoutDestination(userMessage) ||
      isAmbiguousMultiFormationList(userMessage))
  ) {
    const reply = buildTransferenciaDadosIncompletosReply({
      destino: hasDestino ? context.destino : null,
      missingOrigem,
      missingSemestre,
    })
    console.log(
      `[${executionId}] TRANSFERENCIA_DADOS_INCOMPLETOS destino="${context?.destino || ''}" missingOrigem=${missingOrigem} missingSemestre=${missingSemestre}`,
    )
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0: t0 || Date.now(),
        reply,
        steps: [{ type: 'transferencia_dados_incompletos', ok: true }],
        toolCalls: [],
        ctxSnapshot: {
          replySource: 'transferencia_dados_incompletos',
          transferenciaDestinoRetido: context?.destino || null,
          missingOrigem,
          missingSemestre,
        },
      }),
    }
  }

  if (!context?.origem || !context?.destino || !context?.semestre) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_AUTO_COMPLETE origem="${context.origem}" destino="${context.destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: context.origem,
      semestre_concluido: context.semestre,
      curso_desejado: context.destino,
    },
    'transferencia_auto_complete',
  )
}

/**
 * Lead confirmou com "sim" após o agente resumir origem → destino da transferência.
 */
export async function tryHandleTransferenciaConfirmacao(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId } = ctx
  if (!telefone || !userMessage) return null

  const lastAssist = lastAssistantText(historyMessages)
  if (!assistantAskedTransferenciaConfirmacao(lastAssist)) return null
  if (!messageConfirmsTransferencia(userMessage)) return null

  const context = extractTransferenciaContext(historyMessages)
  if (!context?.origem || !context?.destino || !context?.semestre) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_CONFIRMADA origem="${context.origem}" destino="${context.destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: context.origem,
      semestre_concluido: context.semestre,
      curso_desejado: context.destino,
    },
    'transferencia_confirmada',
  )
}

/**
 * Lead repetiu o curso desejado após o agente perguntar curso indevidamente.
 */
export async function tryHandleTransferenciaCursoRestate(env, ctx = {}) {
  const { telefone, userMessage, historyMessages = [], executionId } = ctx
  if (!telefone || !userMessage) return null
  if (!conversationMentionsTransferencia(historyMessages)) return null

  const lastAssist = lastAssistantText(historyMessages)
  const inTransferStep =
    assistantAskedTransferenciaDadosPendentes(lastAssist) ||
    assistantAskedTransferenciaCursoOrigem(lastAssist)
  if (!inTransferStep && !messageRestatesSameCourseAsDestino(userMessage, null)) return null

  const context = extractTransferenciaContext(historyMessages)
  const destinoMsg =
    extractCursoAreaFromText(userMessage) ||
    cleanCursoLabel(
      String(userMessage || '')
        .replace(/^(bacharelado|licenciatura|tecn[oó]logo)\s+(em\s+)?/i, '')
        .replace(/^(s[oó]|somente|apenas)\s+(?:a|o)?\s*/i, '')
        .replace(/\s+mesmo$/i, '')
        .trim(),
    )

  if (!context?.semestre) return null
  if (!context?.origem && !destinoMsg && !messageRestatesSameCourseAsDestino(userMessage, context?.destino)) {
    return null
  }

  const destino = context?.destino || destinoMsg
  const origem = context?.origem || destino
  if (!destino || !origem || !isValidTransferenciaCursoLabel(destino)) return null

  console.log(
    `[${executionId}] TRANSFERENCIA_CURSO_RESTATE origem="${origem}" destino="${destino}" semestre=${context.semestre}`,
  )

  return runTransferenciaComplete(
    env,
    ctx,
    {
      telefone,
      curso_origem: origem,
      semestre_concluido: context.semestre,
      curso_desejado: destino,
    },
    'transferencia_curso_restate',
  )
}
