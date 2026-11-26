/**
 * Agent Scheduler — substitui o gate por-mensagem.
 *
 * Em vez de checar Kommo a cada mensagem que chega no webhook (caro e
 * sensível ao delay do Kommo pra movimentar leads de fase), a gente roda
 * um loop a cada KOMMO_SCHEDULER_INTERVAL_SEC segundos:
 *
 *   1. Lista leads no pipeline + status configurados (1 chamada paginada).
 *   2. Bulk-fetch dos contatos pra extrair telefone (1 chamada).
 *   3. Pra cada lead nesse funil:
 *        - lê o buffer de mensagens dessa sessão.
 *        - se tem mensagem E última mensagem é mais antiga que o debounce
 *          (KOMMO_SCHEDULER_DEBOUNCE_SEC), processa via flushSession passando
 *          o leadId já conhecido (evita re-chamar findLeadByPhone).
 *
 * Vantagens:
 *   • 1 call no Kommo a cada 30s, não importa quantas mensagens cheguem.
 *   • Tolerante a delay: se o lead foi movido pro funil DEPOIS de mandar
 *     mensagem, próximo tick pega ele com a mensagem ainda no buffer.
 *   • Mensagens de leads que nunca entram no funil expiram via TTL do Redis
 *     (default 10 min, MESSAGE_BUFFER_TTL_SEC).
 *
 * Envs:
 *   KOMMO_AGENT_PIPELINE_ID            (obrig.) ex: 11685120
 *   KOMMO_AGENT_STATUS_ID              (obrig.) ex: 89820300
 *   KOMMO_SCHEDULER_INTERVAL_SEC=30    intervalo entre ticks
 *   KOMMO_SCHEDULER_DEBOUNCE_SEC=15    silêncio mínimo após última mensagem
 *   KOMMO_SCHEDULER_WEBHOOK_ORPHAN_FLUSH=true   quando NÃO há leads no
 *                                       pipeline/status, ainda assim tenta
 *                                       flush das sessões que têm fila no
 *                                       buffer (Evolution webhook). Útil se
 *                                       o WhatsApp conversa mas o lead ainda
 *                                       não foi parado na etapa do Kommo.
 *   KOMMO_SCHEDULER_ORPHAN_SESSION_CAP=25      máx. sessões por tick no modo órfão
 *   KOMMO_SCHEDULER_ENABLED=true       chave geral pra ligar/desligar
 *   KOMMO_INBOUND_POLL_ENABLED=true     opcional: preenche buffer a partir do Kommo
 *                                       (eventos v4 de chat antes das notas quando
 *                                       KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS está ligado).
 *   KOMMO_INBOUND_POLL_MODE=notes        notes | both | events | dispatcher | amojo
 *   KOMMO_INBOUND_POLL_NOTES_ALSO_EVENTS  com mode=notes, false = só GET …/notes (sem events)
 *   KOMMO_INBOUND_POLL_ALSO_POLL_EVENTS  com mode=both, true = também poll de eventos v4
 *   KOMMO_INBOUND_POLL_NOTES_TAIL_SEED_ON_WARMUP  default true — evita buffer vazio quando
 *                                       o maior id de nota é do agente acima da última msg do cliente.
 *   KOMMO_INBOUND_POLL_NOTE_TYPES=…     tipos de nota considerados inbound (default inclui common)
 *   KOMMO_CHANNEL_SECRET / SCOPE_ID    só p/ mode=amojo (histórico Chats)
 *   KOMMO_LEAD_CHAT_MAP={"19884275":"uuid-chat"}  opcional — chat_id por lead
 *   KOMMO_AGENT_TEST_LEAD_IDS          (opcional) whitelist CSV de lead ids em teste
 *   KOMMO_SCHEDULER_VERBOSE=true       loga 1 linha por lead com buffer vazio + diag/URLs do poll.
 *                                      Default off: só o resumo do tick (N sem msg).
 */

import {
  bulkGetContactsByIds,
  extractContactPhone,
  extractLeadPhone,
} from './kommoClient.js'
import {
  assertLeadInAgentFunnel,
  describeCrmLeadFunnel as describeLeadFunnel,
  isEduitBackend,
  listLeadsInAgentQueue,
  normalizeCrmLeadId,
  resolveAgentFunnelFromEnv,
  getCrmBackend,
} from './crmAdapter.js'
import { phoneToWhatsAppSessionId, whatsAppSessionVariants } from './phoneWhatsApp.js'
import { getMessages, getLastTouchedAt, listSessionsWithPendingMessages } from './evolution/messageBuffer.js'
import { clearBufferIfStaleRepush } from './sessionFlushDedupe.js'
import { flushSession } from './evolution/webhookEvolution.js'
import { tryAdvanceInscricaoPostFormScheduler } from './inscricaoPostFormPipeline.js'
import {
  messageLooksLikeFormFollowUp,
  messageLooksLikeFormSumarResponse,
} from '../libShared/inscricaoFormHeuristics.js'
import { matchPoloFromUserMessage } from '../libShared/sumarePoloCatalog.js'
import { tryInactivityReengagement } from './inactivityReengagement.js'
import { tryProactiveGreet } from './proactiveGreet.js'
import { reactivateOrphanLeads, isReactivationEnabled, getSweepIntervalMs } from './leadReactivation.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { saveConversation } from './historyStore.js'
import { generateExecutionId } from './ai/executionTelemetry.js'
import { fetchDadosClienteByLeadId, normalizeTelefone } from './dadosClienteStore.js'
import {
  syncKommoInboundToBuffer,
  isKommoInboundPollEnabled,
  normalizeKommoInboundPollMode,
  isKommoInboundPollDebugLead,
} from './kommoInboundPoll.js'
import {
  formatPollDiagLine,
  formatEventsDiagLine,
  formatDispatcherDiagLine,
} from './kommoInboundDiagnostics.js'
import { notifyFunnelSnapshot } from './feedbackIA/funnelExitWatcher.js'
import {
  beginAgentQueueSession,
  endAgentQueueSessionsForLeads,
  isAgentQueueSessionEnabled,
} from './agentQueueSession.js'

// Defaults agressivos pra reduzir latência ponta-a-ponta.
// - Interval: a cada 10s o scheduler verifica se há leads c/ msgs prontas.
// - Debounce: 5s de silêncio é suficiente pra agrupar mensagens
//   "soltas" do mesmo lead e evitar processar a meio. Se a operação
//   precisar de janelas maiores (ex.: leads que digitam devagar),
//   ajustar via env KOMMO_SCHEDULER_DEBOUNCE_SEC.
const DEFAULT_INTERVAL_SEC = 10
const DEFAULT_DEBOUNCE_SEC = 5

let intervalHandle = null
let running = false

/** Evita flood: aviso de funil vazio no máx. 1x / 90s. */
let lastEmptyFunnelWarnMs = 0

/** Throttle da varredura de reativação por inbound (ver leadReactivation.js). */
let lastReactivationSweepMs = 0

/**
 * Reativa leads fora do funil que mandaram mensagem (move p/ Atendimento).
 * Throttled — não roda a cada tick. Idempotente: lead já no funil é ignorado.
 */
async function maybeReactivationSweep(env, stats) {
  // Reativação Kommo (pipelines/status numéricos). EduIT: Entrada→Atendimento
  // já ocorre no gate (ensureEduitDealReadyForAgent) no flush por telefone.
  if (isEduitBackend(env)) return
  if (!isReactivationEnabled(env)) return
  const now = Date.now()
  if (now - lastReactivationSweepMs < getSweepIntervalMs(env)) return
  lastReactivationSweepMs = now
  try {
    const r = await reactivateOrphanLeads(env)
    if (r.reactivated > 0) stats.reactivated = (stats.reactivated || 0) + r.reactivated
  } catch (err) {
    console.warn('[scheduler] reactivation sweep:', err.message)
  }
}

/**
 * Lê config do scheduler: AGENT_SCHEDULER_<KEY> (nome atual, CRM-agnóstico)
 * com fallback para o legado KOMMO_SCHEDULER_<KEY>.
 */
export function schedulerEnv(env, key) {
  const v = env?.[`AGENT_SCHEDULER_${key}`]
  if (v !== undefined && String(v).trim() !== '') return v
  return env?.[`KOMMO_SCHEDULER_${key}`]
}

function isSchedulerVerbose(env) {
  return ['true', '1', 'yes'].includes(String(schedulerEnv(env, 'VERBOSE') || '').trim().toLowerCase())
}

/** Quando o funil Kommo está vazio, ainda processar buffer preenchido só pelo webhook Evolution. */
function isWebhookOrphanFlushEnabled(env) {
  return ['true', '1', 'yes'].includes(String(schedulerEnv(env, 'WEBHOOK_ORPHAN_FLUSH') || '').trim().toLowerCase())
}

function getOrphanSessionCap(env) {
  const v = Number(schedulerEnv(env, 'ORPHAN_SESSION_CAP'))
  return Number.isFinite(v) && v > 0 ? Math.min(80, Math.floor(v)) : 25
}

/**
 * @param {Record<string,string>} env
 * @param {{ debounceMs: number, stats: object }} ctx
 */
async function tryFlushWebhookOrphanSessions(env, { debounceMs, stats }) {
  if (!isWebhookOrphanFlushEnabled(env)) return
  const cap = getOrphanSessionCap(env)
  let sessionIds = []
  try {
    sessionIds = await listSessionsWithPendingMessages(env, cap)
  } catch (err) {
    console.error('[scheduler] orphan listSessionsWithPendingMessages:', err.message)
    return
  }
  if (!sessionIds.length) return

  console.log(
    `[scheduler] funil vazio — WEBHOOK_ORPHAN_FLUSH: ${sessionIds.length} sessão(ões) com buffer (cap=${cap})`,
  )

  for (const sessionId of sessionIds) {
    try {
      const [messages, last] = await Promise.all([
        getMessages(env, sessionId),
        getLastTouchedAt(env, sessionId),
      ])
      if (!messages || messages.length === 0) continue
      const ageMs = last ? Date.now() - last.getTime() : Infinity
      if (ageMs < debounceMs) {
        stats.skippedDebounce += 1
        continue
      }
      const telefone = String(sessionId).split('@')[0].replace(/[^0-9]/g, '')
      const funnel = await assertLeadInAgentFunnel(env, { telefone })
      if (!funnel.ok) {
        stats.skippedFunnelGate = (stats.skippedFunnelGate || 0) + 1
        console.log(
          `[scheduler] flush órfão ${sessionId} BLOQUEADO funnel_gate reason=${funnel.reason} ` +
            `(${getCrmBackend(env)} ${describeLeadFunnel(funnel.lead || { pipeline_id: funnel.pipeline_id, status_id: funnel.status_id })})`,
        )
        continue
      }
      const leadId = normalizeCrmLeadId(funnel.lead?.id, env)
      console.log(
        `[scheduler] flush órfão ${sessionId} lead=${leadId} (${messages.length} msgs, idade=${Math.round(ageMs / 1000)}s)`,
      )
      await flushSession(env, sessionId, { leadIdHint: leadId })
      stats.processed += 1
    } catch (err) {
      stats.errors += 1
      console.error('[scheduler] erro flush órfão', sessionId, err.message)
    }
  }
}

function getIntervalMs(env) {
  const v = Number(schedulerEnv(env, 'INTERVAL_SEC'))
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_INTERVAL_SEC
  return sec * 1000
}

function getDebounceMs(env) {
  const v = Number(schedulerEnv(env, 'DEBOUNCE_SEC'))
  const sec = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_DEBOUNCE_SEC
  return sec * 1000
}

/**
 * Quantos leads processar em paralelo por tick. Cada lead pode disparar várias
 * chamadas ao Kommo; mesmo com o rate limiter global (kommoRateLimiter.js)
 * garantindo ≤ 7 req/s, manter um teto de concorrência evita acumular fila e
 * segura o uso de memória/CPU. Default conservador.
 */
const DEFAULT_LEAD_CONCURRENCY = 3
function getLeadConcurrency(env) {
  const v = Number(schedulerEnv(env, 'LEAD_CONCURRENCY'))
  const n = Number.isFinite(v) && v > 0 ? Math.floor(v) : DEFAULT_LEAD_CONCURRENCY
  return Math.min(10, Math.max(1, n))
}

/**
 * Roda `worker(item)` sobre `items` com no máximo `limit` execuções simultâneas.
 * @template T
 * @param {T[]} items
 * @param {(item: T) => Promise<void>} worker
 * @param {number} limit
 */
async function mapWithConcurrency(items, worker, limit) {
  const max = Math.max(1, Math.min(limit, items.length))
  let cursor = 0
  const runners = Array.from({ length: max }, async () => {
    while (cursor < items.length) {
      const idx = cursor++
      await worker(items[idx])
    }
  })
  await Promise.all(runners)
}

function isEnabled(env) {
  const flag = String(schedulerEnv(env, 'ENABLED') || '').trim().toLowerCase()
  if (flag === 'false' || flag === '0' || flag === 'no') return false
  if (isEduitBackend(env)) {
    return Boolean(String(env.EDUIT_BASE_URL || '').trim() && String(env.EDUIT_API_KEY || '').trim())
  }
  if (!env.KOMMO_BASE_URL || !env.KOMMO_ACCESS_TOKEN) return false
  return true
}

function buildSessionId(phone) {
  return phoneToWhatsAppSessionId(phone)
}

/**
 * Resolve qual sessionId (entre as variantes do 9º dígito BR) tem mensagens no
 * buffer. O Kommo pode guardar o número com/sem o 9 e o WhatsApp entregar o JID
 * na outra forma — sem isso o scheduler lia o buffer da variante errada (vazio)
 * e nunca respondia. Escolhe a variante com fila; em empate fica na primária.
 * Leitura é só no buffer (Redis/Supabase), não bate no Kommo.
 *
 * @param {Record<string,string>} env
 * @param {string} phone
 * @returns {Promise<string|null>}
 */
async function resolveEffectiveSessionId(env, phone) {
  const variants = whatsAppSessionVariants(phone)
  if (variants.length <= 1) return variants[0] || buildSessionId(phone)
  let best = variants[0]
  let bestCount = -1
  for (const v of variants) {
    let count = 0
    try {
      const msgs = await getMessages(env, v)
      count = Array.isArray(msgs) ? msgs.length : 0
    } catch {
      count = 0
    }
    if (count > bestCount) {
      bestCount = count
      best = v
    }
  }
  return best
}

function getTestLeadWhitelist(env) {
  const raw = String(env.KOMMO_AGENT_TEST_LEAD_IDS || env.EDUIT_AGENT_TEST_DEAL_IDS || '').trim()
  if (!raw) return null
  if (isEduitBackend(env)) {
    const ids = raw
      .split(/[,\s;]+/)
      .map((s) => String(s).trim())
      .filter(Boolean)
    return ids.length > 0 ? new Set(ids) : null
  }
  const ids = raw
    .split(/[,\s;]+/)
    .map((s) => Number(String(s).trim()))
    .filter((n) => Number.isFinite(n) && n > 0)
  return ids.length > 0 ? new Set(ids) : null
}

/**
 * Executa um único tick do scheduler.
 *
 * @returns {Promise<{leadsInFunnel:number, processed:number, skippedDebounce:number, skippedNoMessages:number, errors:number}>}
 */
export async function runSchedulerTick(env) {
  const stats = { leadsInFunnel: 0, processed: 0, skippedDebounce: 0, skippedNoMessages: 0, skippedNotInWhitelist: 0, errors: 0 }
  if (!isEnabled(env)) return stats

  const { pipelineId, statusIds } = resolveAgentFunnelFromEnv(env)
  const debounceMs = getDebounceMs(env)
  const whitelist = getTestLeadWhitelist(env)

  // 0) Reativação por inbound: traz p/ o funil quem mandou mensagem estando
  //    fora dele (ex.: "Aguardando resposta" do agente, pipeline comercial).
  //    Throttled internamente; o próprio tick (abaixo) responde no ciclo seguinte.
  await maybeReactivationSweep(env, stats)

  // 1) Listar leads no funil (um ou vários status — ver KOMMO_AGENT_STATUS_IDS)
  const listing = await listLeadsInAgentQueue(env)
  if (!listing.ok && !(listing.leads || []).length) {
    const backend = getCrmBackend(env)
    const base = isEduitBackend(env)
      ? String(env.EDUIT_BASE_URL || '').replace(/\/$/, '') || '(vazio)'
      : String(env.KOMMO_BASE_URL || '').replace(/\/$/, '') || '(vazio)'
    console.error(
      `[scheduler] ${backend} list falhou: http=${listing.httpStatus ?? 'n/a'} base=${base} ` +
        `status_ids=[${statusIds.join(',')}] pipeline=${pipelineId} err=${String(listing.error || 'unknown').slice(0, 280)}`,
    )
    // CRM indisponível: ainda tenta buffer só do webhook Evolution/Meta.
    await tryFlushWebhookOrphanSessions(env, { debounceMs, stats })
    return stats
  }
  const leadsAll = listing.leads || []
  stats.leadsInFunnel = leadsAll.length

  // Feedback IA + ciclo de sessão (saída/reentrada na fila do agente).
  // Snapshot atual usa Number(id) — incompatível com CUID EduIT; pular no backend eduit.
  let funnelEnteredIds = new Set()
  let funnelExitedIds = []
  if (!isEduitBackend(env)) {
    try {
      const snap = notifyFunnelSnapshot(env, leadsAll.map((l) => Number(l.id)))
      funnelEnteredIds = new Set((snap.enteredIds || snap.entered || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))
      funnelExitedIds = (snap.exitedIds || [])
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
      if (isAgentQueueSessionEnabled(env) && funnelExitedIds.length > 0) {
        endAgentQueueSessionsForLeads(env, funnelExitedIds, { reason: 'funnel_exit' }).catch((err) => {
          console.warn('[scheduler] agentQueueSession end:', err.message)
        })
      }
    } catch (err) {
      console.error('[scheduler] feedbackIA notify falhou:', err.message)
    }
  }

  // Whitelist de teste: descarta leads fora da lista ANTES do bulk de
  // contatos, evitando 1 chamada Kommo extra à toa.
  let leads = leadsAll
  if (whitelist) {
    leads = leadsAll.filter((l) => {
      if (isEduitBackend(env)) return whitelist.has(String(l.id))
      return whitelist.has(Number(l.id))
    })
    stats.skippedNotInWhitelist = leadsAll.length - leads.length
    if (stats.skippedNotInWhitelist > 0) {
      console.log(`[scheduler] whitelist ativa — ${leads.length}/${leadsAll.length} leads passaram (ids permitidos: ${[...whitelist].join(',')})`)
    }
  }
  if (!leads.length) {
    const now = Date.now()
    if (now - lastEmptyFunnelWarnMs > 90_000) {
      lastEmptyFunnelWarnMs = now
      console.warn(
        `[scheduler] nenhum lead em pipeline_id=${pipelineId} status_ids=[${statusIds.join(',')}]. ` +
          'O poll de notas/eventos NAO roda para leads fora dessas etapas. ' +
          'A fila da IA é fixa: pipeline 13756724 + status 106140284 (Atendimento) e 106804680 (inscrição). Realoque o lead numa dessas etapas.',
      )
    }
    await tryFlushWebhookOrphanSessions(env, { debounceMs, stats })
    return stats
  }

  // 2) Coletar contact IDs e bulk-fetch (Kommo only)
  const contactIds = []
  const contactById = new Map()
  if (!isEduitBackend(env)) {
    for (const lead of leads) {
      const cs = lead?._embedded?.contacts || []
      for (const c of cs) {
        if (Number.isFinite(Number(c.id))) contactIds.push(Number(c.id))
      }
    }
    if (contactIds.length > 0) {
      const bulk = await bulkGetContactsByIds(env, contactIds)
      if (bulk.ok) {
        for (const c of bulk.contacts) contactById.set(Number(c.id), c)
      } else {
        console.warn('[scheduler] bulkGetContactsByIds falhou:', bulk.error || bulk.status)
      }
    }
  }

  // 3) Pra cada lead, achar telefone, ver buffer, processar se tiver fila
  // pronta. Processamos em paralelo mas com lock por sessão (no flushSession).
  const processLead = async (lead) => {
    try {
      const crmLeadId = normalizeCrmLeadId(lead?.id, env)
      let phone = null
      /** Contato cujo telefone bate com a sessão — usado no poll de eventos entity=contact. */
      let contactIdForPoll = null

      if (isEduitBackend(env)) {
        const row = await fetchDadosClienteByLeadId(env, crmLeadId)
        phone = normalizeTelefone(row?.telefone || lead?.phone || lead?._raw?.contact?.phone || '')
        if (!phone) {
          console.warn(
            `[scheduler] deal=${crmLeadId} ignorado: sem telefone em dados_cliente_sum nem no contato EduIT.`,
          )
          stats.skippedNoPhone = (stats.skippedNoPhone || 0) + 1
          return
        }
      } else {
        const cs = lead?._embedded?.contacts || []
        for (const c of cs) {
          const detail = contactById.get(Number(c.id))
          if (!detail) continue
          const p = extractContactPhone(detail)
          if (p) {
            phone = p
            contactIdForPoll = Number(c.id)
            break
          }
        }
        if (!phone) {
          phone = extractLeadPhone(lead)
        }
        if (!phone) {
          console.warn(
            `[scheduler] lead=${lead.id} ignorado: nenhum telefone extraível do contato (field PHONE) nem do lead. ` +
              'Sem telefone não há sessionId WhatsApp → buffer vazio e a IA nunca responde. Preencha telefone no Kommo (contato ou lead).',
          )
          stats.skippedNoPhone = (stats.skippedNoPhone || 0) + 1
          return
        }
      }
      const sessionId = await resolveEffectiveSessionId(env, phone)
      if (!sessionId) return

      if (!isEduitBackend(env) && funnelEnteredIds.has(Number(lead.id))) {
        try {
          const reentry = await beginAgentQueueSession(env, {
            leadId: Number(lead.id),
            telefone: phone,
            sessionId,
            reason: 'funnel_reentry',
          })
          if (reentry.ok && !reentry.skipped) {
            console.log(
              `[scheduler] lead=${lead.id} nova sessão na fila buffer=${reentry.bufferRemoved} memory=${reentry.memoryRemoved}`,
            )
          }
        } catch (reentryErr) {
          console.warn(`[scheduler] reentrada funil lead=${lead.id}:`, reentryErr.message)
        }
      }

      if (!isEduitBackend(env)) {
        await syncKommoInboundToBuffer(env, {
          leadId: Number(lead.id),
          sessionId,
          phone,
          contactId:
            contactIdForPoll != null && Number.isFinite(contactIdForPoll) && contactIdForPoll > 0
              ? contactIdForPoll
              : null,
        })
      }

      // Pós-form / salesbot é Kommo-specific — fora da fatia EduIT.
      let skipFlushAfterPostForm = false
      if (!isEduitBackend(env)) {
        try {
          const postFormAdv = await tryAdvanceInscricaoPostFormScheduler(env, {
            telefone: phone,
            leadId: crmLeadId,
          })
          if (postFormAdv?.handled) {
            skipFlushAfterPostForm = true
            const ctxForm = postFormAdv.result?.ctxSnapshot?.inscricaoForm ?? 'n/a'
            const botId = postFormAdv.result?.ctxSnapshot?.salesbotId ?? 'n/a'
            const matriculaOk = postFormAdv.result?.toolCalls?.[0]?.ok
            console.log(
              `[scheduler] pós-form lead=${crmLeadId} handled=true inscricaoForm=${ctxForm} salesbot=${botId} matricula_ok=${matriculaOk}`,
            )
            const reply = postFormAdv.result?.reply
            const contratoWhatsappSent = Boolean(postFormAdv.result?.ctxSnapshot?.contratoWhatsappSent)
            const skipSchedulerWhatsapp = Boolean(postFormAdv.result?.ctxSnapshot?.skipSchedulerWhatsapp)
            const mustSendContrato =
              reply &&
              /sumare\.edu\.br/i.test(reply) &&
              /\bcontrato\b/i.test(reply) &&
              !contratoWhatsappSent
            if (reply && (mustSendContrato || (!contratoWhatsappSent && !skipSchedulerWhatsapp))) {
              const execId = generateExecutionId()
              const sendRes = await sendMessageWithNote(env, {
                telefone: phone,
                text: reply,
                leadId: crmLeadId,
                executionId: execId,
              })
              await saveConversation(env, {
                telefone: phone,
                userMessage: '[scheduler] avanço pós-formulário Kommo',
                botMessage: reply,
              }).catch(() => {})
              console.log(`[scheduler] pós-form lead=${crmLeadId} whatsapp_send_ok=${sendRes?.ok}`)
            } else if (contratoWhatsappSent) {
              console.log(`[scheduler] pós-form lead=${crmLeadId} link contrato já enviado pela captação`)
            } else if (skipSchedulerWhatsapp) {
              console.log(`[scheduler] pós-form lead=${crmLeadId} WhatsApp omitido (captação/salesbot já enviou)`)
            }
          }
        } catch (postErr) {
          console.warn(`[scheduler] pós-form lead=${crmLeadId}:`, postErr.message)
        }
      }
      if (!isEduitBackend(env) && isKommoInboundPollDebugLead(env, Number(lead.id))) {
        console.log(
          `[scheduler][debug] pós-sync lead=${lead.id} session=${sessionId}`,
        )
      }

      // Lê messages e o lastTouchedAt em paralelo — são entradas
      // separadas no buffer (Redis/Supabase) e independentes.
      const [messages, last] = await Promise.all([
        getMessages(env, sessionId),
        getLastTouchedAt(env, sessionId),
      ])
      if (messages?.length) {
        const pendingText = messages.map((m) => String(m || '').trim()).join(' ').trim()
        const looksLikePoloChoice =
          messages.length === 1 && Boolean(matchPoloFromUserMessage(pendingText))
        if (!looksLikePoloChoice) {
          const stale = await clearBufferIfStaleRepush(env, sessionId, messages)
          if (stale.skip) return
        }
      }
      if (!messages || messages.length === 0) {
        // Rede de segurança da saudação proativa: lead na fila ainda sem
        // atendimento → o agente puxa a conversa (idempotente).
        // Leads Api Sumaré em inscrição/pagamento são ignorados — abertura
        // fica a cargo dos salesbots Kommo 49977 / 49979.
        try {
          const greet = await tryProactiveGreet(env, {
            telefone: phone,
            leadId: crmLeadId,
            sessionId,
            lead,
            source: 'scheduler',
          })
          if (greet?.action === 'greet_sent') {
            console.log(`[scheduler] saudação proativa lead=${crmLeadId} enviada`)
            stats.processed += 1
            return
          }
        } catch (greetErr) {
          console.warn(`[scheduler] saudação proativa lead=${crmLeadId}:`, greetErr.message)
        }

        try {
          const inact = await tryInactivityReengagement(env, {
            telefone: phone,
            leadId: crmLeadId,
            sessionId,
            lead,
          })
          if (inact?.action && !['skip', 'disabled'].includes(inact.action)) {
            console.log(`[scheduler] inatividade lead=${crmLeadId} action=${inact.action}`)
          }
        } catch (inactErr) {
          console.warn(`[scheduler] inatividade lead=${crmLeadId}:`, inactErr.message)
        }

        stats.skippedNoMessages += 1
        const pollOn = !isEduitBackend(env) && isKommoInboundPollEnabled(env)
        const mode = normalizeKommoInboundPollMode(env.KOMMO_INBOUND_POLL_MODE)
        const showDetail = Boolean(whitelist) || isSchedulerVerbose(env)
        // Em produção o resumo do tick (stats.skippedNoMessages) já basta —
        // logar 1 linha por lead a cada tick vazio vira flood. Per-lead só
        // com whitelist (KOMMO_AGENT_TEST_LEAD_IDS) ou KOMMO_SCHEDULER_VERBOSE=true.
        if (showDetail) {
          console.log(
            `[scheduler] buffer vazio session=${sessionId} lead=${crmLeadId} mode=${pollOn ? mode : 'webhook'} — sem inbound novo neste tick.`,
          )
        }
        if (pollOn && showDetail) {
          if (mode === 'dispatcher') {
            console.log(formatDispatcherDiagLine(lead.id))
          } else if (mode === 'events') {
            console.log(formatEventsDiagLine(lead.id))
          } else if (mode === 'both') {
            console.log(formatPollDiagLine(lead.id))
            console.log(formatEventsDiagLine(lead.id))
          } else if (mode === 'all') {
            console.log(formatPollDiagLine(lead.id))
            console.log(formatEventsDiagLine(lead.id))
            console.log(formatDispatcherDiagLine(lead.id))
          } else if (mode === 'amojo') {
            console.log(`[poll-kommo][diag] lead=${lead.id} mode=amojo — verifique KOMMO_CHANNEL_SECRET / SCOPE_ID / chat_id`)
          } else {
            console.log(formatPollDiagLine(lead.id))
          }
        }
        return
      }
      if (skipFlushAfterPostForm && messages?.length) {
        const pendingText = messages.map((m) => String(m?.content || m?.text || '')).join('\n').trim()
        const looksLikeNormalChat =
          pendingText.length > 0 &&
          !messageLooksLikeFormSumarResponse(pendingText) &&
          !messageLooksLikeFormFollowUp(pendingText, { strictAwaitingForm: true })
        if (looksLikeNormalChat) {
          console.log(
            `[scheduler] lead=${lead.id} buffer com chat pendente ("${pendingText.slice(0, 60)}…") — flush mesmo com pós-form ativo`,
          )
          skipFlushAfterPostForm = false
        }
      }
      if (skipFlushAfterPostForm) {
        console.log(`[scheduler] lead=${lead.id} flush omitido neste tick (pós-form tratado)`)
        return
      }

      const ageMs = last ? Date.now() - last.getTime() : Infinity
      if (ageMs < debounceMs) {
        stats.skippedDebounce += 1
        return
      }

      const funnel = await assertLeadInAgentFunnel(env, { leadId: crmLeadId, lead, telefone: phone })
      if (!funnel.ok) {
        stats.skippedFunnelGate = (stats.skippedFunnelGate || 0) + 1
        console.warn(
          `[scheduler] lead=${crmLeadId} flush omitido funnel_gate reason=${funnel.reason} ` +
            describeLeadFunnel(funnel.lead || lead),
        )
        return
      }
      console.log(`[scheduler] flush ${sessionId} lead=${crmLeadId} (${messages.length} msgs, idade=${Math.round(ageMs / 1000)}s)`)
      await flushSession(env, sessionId, { leadIdHint: crmLeadId })
      stats.processed += 1
    } catch (err) {
      stats.errors += 1
      console.error('[scheduler] erro processando lead', lead?.id, err.message)
    }
  }

  await mapWithConcurrency(leads, processLead, getLeadConcurrency(env))

  // Lead no funil mas sem telefone no Kommo (ou bulk falhou): mensagens podem estar só no buffer Evolution.
  if (stats.processed === 0 && (stats.skippedNoPhone || 0) > 0) {
    await tryFlushWebhookOrphanSessions(env, { debounceMs, stats })
  }

  return stats
}

/**
 * Inicia o loop. Idempotente — chama várias vezes não cria múltiplos timers.
 */
export function startAgentScheduler(env) {
  if (intervalHandle) return { started: false, reason: 'already_running' }
  if (!isEnabled(env)) {
    return { started: false, reason: 'disabled (AGENT_SCHEDULER_ENABLED=false ou falta credencial do CRM)' }
  }
  const intervalMs = getIntervalMs(env)
  const tick = () => {
    if (running) return // skip se o tick anterior ainda tá rodando
    running = true
    runSchedulerTick(env)
      .then((stats) => {
        // Sempre 1 linha de resumo quando houve funil (ou erro). Evita flood
        // per-lead e ainda mostra que o scheduler está vivo em idle.
        if (stats.leadsInFunnel > 0 || stats.processed > 0 || stats.errors > 0) {
          const wl = stats.skippedNotInWhitelist ? `, ${stats.skippedNotInWhitelist} fora da whitelist` : ''
          console.log(
            `[scheduler] tick: ${stats.leadsInFunnel} no funil, ${stats.processed} processados, ${stats.skippedDebounce} aguardando debounce, ${stats.skippedNoMessages} sem msg${wl}, ${stats.errors} erros`,
          )
        }
      })
      .catch((err) => console.error('[scheduler] tick exception:', err.message))
      .finally(() => { running = false })
  }
  intervalHandle = setInterval(tick, intervalMs)
  // Roda um tick depois de 5s pra não competir com o boot.
  setTimeout(tick, 5000)
  console.log(`[scheduler] iniciado (intervalo=${Math.round(intervalMs / 1000)}s, debounce=${Math.round(getDebounceMs(env) / 1000)}s)`)
  return { started: true, intervalMs }
}

export function stopAgentScheduler() {
  if (intervalHandle) {
    clearInterval(intervalHandle)
    intervalHandle = null
  }
  running = false
}

export function isSchedulerRunning() {
  return Boolean(intervalHandle)
}
