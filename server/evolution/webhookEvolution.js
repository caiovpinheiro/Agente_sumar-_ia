/**
 * Webhook Evolution API — só BUFFERIZA mensagens.
 *
 * Quem decide se / quando responder é o agentScheduler, que roda em loop
 * (default 30s) listando os leads no funil/status configurados e
 * processando o buffer dos que estão dentro.
 *
 * Aqui a gente:
 *   1) Classifica messageType.
 *   2) Dedup por message.key.id (TTL em memória).
 *   3) Áudio  → transcrição (Whisper).
 *      Imagem → análise (gpt-4o-mini Vision). Botão → texto do botão.
 *   4) Lembra o wamid (Cloud API) pra o "digitando..." conseguir usar.
 *   5) Empurra no buffer (TTL automático no Redis).
 *
 * Opcional: EVOLUTION_INGEST_PHONE_ALLOWLIST — CSV de dígitos; se setado, só
 * esses remetentes entram no buffer (Evolution). Vazio = todos.
 *
 * NÃO chama Kommo, NÃO dispara IA, NÃO agenda flush. Tudo isso é
 * responsabilidade do agentScheduler.
 *
 * Mantemos `flushSession` exportado pq o playground (área de teste) usa
 * o fluxo direto sem passar pelo scheduler.
 */

import {
  pushMessage,
  drainMessages,
  clearMessages,
  getMessageBufferRedis,
  getMessages,
} from './messageBuffer.js'

/** Grade PDF já enviou intro + documento na tool — flush não deve duplicar texto. */
function whatsappAlreadyDeliveredByTool(agentOut) {
  const steps = agentOut?.orchestratorSteps || []
  const introSent = steps.some((s) => s?.step === 'intro_text' && s?.ok && Number(s?.sent) > 0)
  const docSent = steps.some((s) => s?.step === 'document' && s?.ok)
  if (introSent && docSent) return true
  if (agentOut?.ctxSnapshot?.actionCode === 'GRADE_PDF_SENT') {
    return introSent || docSent
  }
  return false
}

function whatsappDeliveryConfirmed(sendResult, agentOut) {
  if ((sendResult?.sent || 0) > 0) return true
  if (sendResult?.skipped && sendResult?.reason === 'already_sent_by_tool') return true
  return whatsappAlreadyDeliveredByTool(agentOut)
}

/** Reenfileira turnos drenados quando IA ou WhatsApp falhou — evita mensagem "sumida". */
async function repushDrainedMessages(env, sessionId, items) {
  if (!items?.length) return
  for (const text of items) {
    const clean = String(text || '').trim()
    if (!clean) continue
    await pushMessage(env, sessionId, clean, { skipDedupe: true })
  }
  console.log(`[Evolution][flush] reenfileiradas ${items.length} msg(s) session=${sessionId}`)
}

/** Destino da escalação por falha de envio: etapa "Aguardando resposta" (humano), fora do funil da IA. */
const SEND_FAIL_ESCALATION_PIPELINE_ID = 13756724
const SEND_FAIL_ESCALATION_STATUS_ID = 106377088

/**
 * Regra (11/06/2026): após a 2ª falha consecutiva ao responder o lead — erro da
 * Meta (token/número licenciado), da OpenAI (pagamento etc.) ou qualquer outro —
 * a IA registra nota com o erro resumido e move o lead para a etapa
 * "Aguardando resposta" (pipeline 13756724 / status 106377088), tirando-o da
 * fila automática para um humano assumir. As mensagens do lead permanecem no
 * buffer (reentrada no funil retoma de onde parou).
 *
 * A nota começa com "Encaminhamento automático" de propósito: o poll de notas
 * reconhece esse prefixo como nota de sistema e não a re-injeta como fala do lead.
 */
async function escalateSendFailureToHuman(env, { executionId, sessionId, leadId, errorText, failCount, items }) {
  const lid = normalizeCrmLeadId(leadId, env)
  if (lid == null) {
    console.warn(
      `[${executionId}] escalação de falha de envio SEM leadId (session=${sessionId}) — mantém só o backoff`,
    )
    return { ok: false, reason: 'no_lead_id' }
  }
  const brief = String(errorText || 'erro desconhecido').replace(/\s+/g, ' ').slice(0, 220)
  const noteText =
    `Encaminhamento automático: IA não conseguiu responder o lead após ${failCount} tentativas. ` +
    `Erro: ${brief} (agente IA)`
  const { createLeadNote: crmNote } = await import('../crmAdapter.js')
  const note = await crmNote(env, lid, noteText).catch((e) => ({ ok: false, error: e.message }))
  let move = { ok: true, skipped: true }
  if (!isEduitBackend(env)) {
    move = await updateLeadPipelineStatus(env, lid, {
      pipelineId: SEND_FAIL_ESCALATION_PIPELINE_ID,
      statusId: SEND_FAIL_ESCALATION_STATUS_ID,
    }).catch((e) => ({ ok: false, error: e.message }))
  }
  // EduIT: sem move de etapa — pausa persistente para o gate shouldHoldOnIaPause
  // reter flushes futuros. Buffer permanece (humano vê a mensagem pendente).
  let pause = { ok: true, skipped: true }
  if (isEduitBackend(env)) {
    const telefone = normalizeTelefone(sessionId)
    if (!telefone) {
      pause = { ok: false, error: 'no_telefone_from_session', sessionId }
    } else {
      pause = await updateDadosCliente(env, {
        telefone,
        fields: { atendimento_ia: 'pause' },
      }).catch((e) => ({ ok: false, error: e.message, telefone }))
      if (pause.ok && !pause.matched) {
        pause = {
          ok: false,
          error: 'dados_cliente_row_not_found',
          telefone,
          updated: pause.updated ?? 0,
        }
      }
    }
  }
  // Lead saiu do funil da IA — zera o backoff para não re-escalar se voltar.
  clearSendRetryBackoff(sessionId)
  // Marca a sessão como parada para humano (hash do buffer não respondido). A
  // reativação por inbound (leadReactivation.js) deve ignorar essa sessão
  // enquanto o conteúdo do buffer não mudar — evita o loop escalar↔reativar.
  markSessionParkedForHuman(sessionId, items)
  const escalateOk = Boolean(note.ok && move.ok && pause.ok)
  console.warn(
    `[${executionId}] ESCALADO p/ humano lead=${lid} (falhas=${failCount}) ` +
      `note_ok=${note.ok} move_ok=${move.ok}${move.skipped ? '(skipped)' : ''} ` +
      `pause_ok=${pause.ok}${pause.skipped ? '(skipped)' : ''} ` +
      `destino=${SEND_FAIL_ESCALATION_PIPELINE_ID}/${SEND_FAIL_ESCALATION_STATUS_ID}` +
      `${note.ok ? '' : ` note_err=${note.error}`}` +
      `${move.ok ? '' : ` move_err=${move.error}`}` +
      `${pause.ok ? '' : ` pause_err=${pause.error || 'n/a'} telefone=${pause.telefone || normalizeTelefone(sessionId) || 'n/a'}`}`,
  )
  return { ok: escalateOk, note, move, pause }
}
import { tryClaimAgentFlush, tryReserveFlushSync, releaseFlushSync, releaseAgentFlush } from '../flushClaim.js'
import { shouldSkipReplyCooldown, markReplyCooldown, getReplyCooldownRemainingMs } from '../replyCooldown.js'
import { transcribeAudioBase64, analyzeImageBase64 } from './openaiMedia.js'
import { fetchEvolutionMediaBase64, resolveInstanceName, describeMediaPayloadShape } from './evolutionMedia.js'
import { normalizeEvolutionInstance } from './instanceConfig.js'
import { runAgent } from '../ai/agentRunner.js'
import { persistCadastroFieldsFromInbound } from '../cadastroCardSync.js'
import { saveConversation } from '../historyStore.js'
import {
  getLeadIdByTelefone,
  shouldHoldOnIaPause,
  updateDadosCliente,
} from '../dadosClienteStore.js'
import { seenMessage, withSessionLock } from './concurrency.js'
import { updateLeadPipelineStatus } from '../kommoClient.js'
import {
  assertLeadInAgentFunnel,
  describeCrmLeadFunnel as describeLeadFunnel,
  findLeadByPhone,
  isEduitBackend,
  normalizeCrmLeadId,
  persistEduitIds,
  resolveAndPersistEduitIds,
} from '../crmAdapter.js'
import { sendMessageWithNote } from '../whatsappSender.js'
import { generateExecutionId, saveExecution } from '../ai/executionTelemetry.js'
import { rememberWamid, getWamids } from './sessionWamid.js'
import { startTypingHeartbeat } from '../whatsappTypingHeartbeat.js'
import { getStateSync as getAiControlStateSync } from '../aiControlState.js'
import { canonicalWhatsAppSessionId, phoneToWhatsAppSessionId } from '../phoneWhatsApp.js'
import { normalizeKommoInboundPollMode } from '../kommoInboundPoll.js'
import { enqueueCloudInboundPending, matchContactToPending, markCloudBridgeExpectsContact, shouldBufferOrphanContact, clearCloudBridgeContactWindow, bufferOrphanContact } from './cloudInboundPending.js'
import { recordSyncOutcome, recordBufferWrite, recordAsyncError } from './webhookDiagnostics.js'
import { sanitizeLeadInboundMessage } from '../../libShared/inboundMessageSanitize.js'
import { recordBufferFlushHash } from '../sessionFlushDedupe.js'
import { mirrorEvolutionInboundToKommo } from '../kommoInboundMirror.js'
import {
  recordSendFailureBackoff,
  shouldHoldForSendRetryBackoff,
  clearSendRetryBackoff,
  shouldEscalateSendFailure,
  markSessionParkedForHuman,
  clearSessionParkedForHuman,
} from '../flushRetryBackoff.js'

function getBody(req) {
  const body = req.body || {}
  return body.body ? body.body : body
}

function getMessageType(payload) {
  return (
    payload?.data?.messageType ||
    payload?.messageType ||
    null
  )
}

function getSessionId(payload) {
  const d = payload?.data || payload
  return (
    d?.key?.remoteJid ||
    d?.remoteJid ||
    d?.sessionId ||
    null
  )
}

/**
 * JID usado no buffer = sempre que possível o número em @s.whatsapp.net.
 * Ordem: remoteJidAlt (telefone real quando remoteJid veio como @lid), depois remoteJid.
 */
function resolveBufferSessionId(payload) {
  const d = payload?.data || payload
  const key = d?.key || {}
  const candidates = [
    key.remoteJidAlt,
    key.remote_jid_alt,
    d.remoteJidAlt,
    d.remote_jid_alt,
    key.participant,
    d.participant,
    key.remoteJid,
    d.remoteJid,
    d.sessionId,
  ].filter((x) => typeof x === 'string' && x.length > 0)

  for (const jid of candidates) {
    const c = canonicalWhatsAppSessionId(jid)
    if (c && c.endsWith('@s.whatsapp.net')) return c
  }
  for (const jid of candidates) {
    const c = canonicalWhatsAppSessionId(jid)
    if (c) return c
  }
  return null
}

/** Meta Cloud via Evolution: remoteJid do cliente não vem no messages.upsert — usa ponte contacts.* */
function isCloudBusinessInbound(env, payload, rawBody) {
  const d = payload?.data || payload
  // Só tratar como "saída" se fromMe for explicitamente true. Se vier undefined,
  // algumas versões da Evolution omitem o campo e a mensagem seria bufferizada no JID do negócio.
  if (d?.key?.fromMe === true) return false
  const keyJid = canonicalWhatsAppSessionId(d?.key?.remoteJid)
  if (!keyJid) return false
  const senderJid = canonicalWhatsAppSessionId(rawBody?.sender)
  if (senderJid && keyJid === senderJid) return true
  const cfg = String(env.WHATSAPP_BUSINESS_JID || env.EVOLUTION_CLOUD_BUSINESS_JID || '').trim()
  if (cfg) {
    const c = canonicalWhatsAppSessionId(cfg)
    if (c && keyJid === c) return true
  }
  return false
}

/** Já temos @s.whatsapp.net do lead (participant/remoteJidAlt) → não enfileirar ponte Cloud. */
function clientSessionAlreadyResolved(sessionId, payload) {
  const d = payload?.data || payload
  const remoteKeyJid = canonicalWhatsAppSessionId(d?.key?.remoteJid)
  return Boolean(
    sessionId &&
      remoteKeyJid &&
      sessionId !== remoteKeyJid &&
      sessionId.endsWith('@s.whatsapp.net'),
  )
}

function inferMessageType(payload) {
  const t = getMessageType(payload)
  if (t) return t
  const d = payload?.data || payload
  const m = d?.message || {}
  if (m.conversation) return 'conversation'
  if (m.extendedTextMessage) return 'extendedTextMessage'
  if (m.imageMessage) return 'imageMessage'
  if (m.videoMessage) return 'videoMessage'
  if (m.audioMessage) return 'audioMessage'
  if (m.documentMessage) return 'documentMessage'
  if (m.stickerMessage) return 'stickerMessage'
  if (m.buttonsResponseMessage || m.templateButtonReplyMessage || m.listResponseMessage) {
    return 'buttonsResponseMessage'
  }
  if (m.buttonMessage) return 'buttonMessage'
  if (m.interactiveMessage) return 'interactiveMessage'
  if (m.locationMessage) return 'locationMessage'
  if (m.contactMessage || m.contactsArrayMessage) return 'contactMessage'
  if (m.reactionMessage) return 'reactionMessage'
  return null
}

function normalizeContactPhoneToSessionId(phone) {
  if (phone == null) return null
  const s = String(phone).trim()
  if (!s) return null
  if (s.includes('@')) return canonicalWhatsAppSessionId(s)
  return phoneToWhatsAppSessionId(s)
}

/** Extrai JID do cliente em contacts.upsert/update (Evolution Cloud varia o shape). */
function extractContactSessionId(data) {
  if (data == null) return null
  if (Array.isArray(data)) {
    for (const item of data) {
      const sid = extractContactSessionId(item)
      if (sid) return sid
    }
    return null
  }
  if (typeof data !== 'object') return null
  const candidates = [
    data.remoteJid,
    data.remote_jid,
    data.phoneNumber,
    data.phone_number,
    data.wa_id,
    data.waId,
    data.profile?.phone,
    data.profile?.phoneNumber,
    data.profilePhone,
    data.contact?.phone,
    data.contact?.remoteJid,
    data.id,
  ]
  for (const raw of candidates) {
    const sid = normalizeContactPhoneToSessionId(raw)
    if (sid && sid.endsWith('@s.whatsapp.net')) return sid
  }
  for (const raw of candidates) {
    const sid = normalizeContactPhoneToSessionId(raw)
    if (sid) return sid
  }
  return null
}

function normalizeTelefone(sessionId) {
  if (!sessionId) return ''
  return String(sessionId).split('@')[0].replace(/[^0-9]/g, '')
}

/**
 * Lista opcional de telefones (só dígitos) que podem entrar no buffer via
 * webhook Evolution. Vazio = qualquer número (comportamento atual).
 * Ex.: EVOLUTION_INGEST_PHONE_ALLOWLIST=5511945722117
 * Comparação aceita sufixo (ex.: 11945722117 vs 5511945722117).
 */
function parseEvolutionIngestPhoneAllowlist(env) {
  const raw = String(env.EVOLUTION_INGEST_PHONE_ALLOWLIST || '').trim()
  if (!raw) return null
  const set = new Set()
  for (const part of raw.split(/[,\s;]+/)) {
    const d = String(part).replace(/[^0-9]/g, '')
    if (d) set.add(d)
  }
  return set.size > 0 ? set : null
}

function isEvolutionIngestPhoneAllowed(env, sessionId) {
  const allow = parseEvolutionIngestPhoneAllowlist(env)
  if (!allow) return true
  const digits = normalizeTelefone(sessionId)
  if (!digits) return false
  for (const a of allow) {
    if (digits === a || digits.endsWith(a) || a.endsWith(digits)) return true
  }
  return false
}

function getPushName(payload) {
  const d = payload?.data || payload
  return d?.pushName || d?.pushname || ''
}

function getMessageId(payload) {
  const d = payload?.data || payload
  return d?.key?.id || d?.messageId || d?.id || null
}

function getBase64(payload) {
  const d = payload?.data || payload
  const m = d?.message || {}
  // Versões diferentes da Evolution colocam o base64 em lugares
  // diferentes. Verifica todos os caminhos conhecidos antes de
  // partir pro fallback que baixa via API (mais lento).
  return (
    m.base64 ||
    m.mediaBase64 ||
    m?.audioMessage?.base64 ||
    m?.imageMessage?.base64 ||
    m?.documentMessage?.base64 ||
    null
  )
}

/**
 * Quando o scheduler está em modo `dispatcher` (ou `all`) ele puxa
 * áudio/imagem direto do `banco-kommo-dispatcher`. Nesse caso, se o
 * webhook Evolution falhar em processar a mídia, NÃO devemos empurrar
 * um marcador de falha no buffer — senão a IA recebe DUAS entradas
 * (transcrição real vinda do dispatcher + "houve falha técnica" do
 * webhook) e responde uma mistura confusa pro lead (caso real visto
 * em conversa: "Desculpe, houve uma falha técnica… Sobre o curso de
 * Administração, R$ 128…").
 *
 * Sem dispatcher ativo, mantemos o marcador pra IA pelo menos
 * reconhecer que veio áudio (Rule 15 do prompt).
 */
function isDispatcherPathAvailable(env) {
  const enabled = String(env.KOMMO_INBOUND_POLL_ENABLED || '').toLowerCase()
  if (enabled !== 'true' && enabled !== '1' && enabled !== 'yes') return false
  const mode = normalizeKommoInboundPollMode(env.KOMMO_INBOUND_POLL_MODE)
  return mode === 'dispatcher' || mode === 'all'
}

/**
 * Devolve o base64 da mídia. Fluxo:
 *   1) Procura inline no payload (Baileys ou Evolution com `download` ligado).
 *   2) Se não achou, baixa via Evolution `/chat/getBase64FromMediaMessage`.
 *
 * Loga o resultado pra facilitar diagnóstico — sem isso, áudio que
 * "não executa" vira caixa preta.
 *
 * @returns {Promise<{base64: string|null, source: 'inline'|'evolution-download'|'none', detail?: object}>}
 */
async function resolveMediaBase64(env, payload, kind) {
  const inline = getBase64(payload)
  if (inline) {
    return { base64: inline, source: 'inline' }
  }

  const instance = resolveInstanceName(env, payload)
  if (!instance) {
    console.warn(
      `[Evolution][${kind}] sem base64 inline e EVOLUTION_INSTANCE não resolvida — não dá pra baixar via API. Shape:`,
      JSON.stringify(describeMediaPayloadShape(payload)),
    )
    return { base64: null, source: 'none', detail: { reason: 'no_instance' } }
  }

  console.log(
    `[Evolution][${kind}] base64 ausente inline → tentando download via Evolution (instance=${instance})`,
  )
  const dl = await fetchEvolutionMediaBase64(env, { instance, payload })
  if (dl.ok && dl.base64) {
    console.log(
      `[Evolution][${kind}] download Evolution OK em ${dl.elapsedMs}ms (${dl.base64.length} chars, mimetype=${dl.mimetype || 'n/a'})`,
    )
    return { base64: dl.base64, source: 'evolution-download', detail: { mimetype: dl.mimetype, fileName: dl.fileName } }
  }
  console.error(
    `[Evolution][${kind}] download Evolution falhou (${dl.code}${dl.status ? ` ${dl.status}` : ''}) em ${dl.elapsedMs || '?'}ms: ${dl.error || ''}. Shape:`,
    JSON.stringify(describeMediaPayloadShape(payload)),
  )
  return { base64: null, source: 'none', detail: { code: dl.code, status: dl.status, error: dl.error } }
}

function getImageCaption(payload) {
  const d = payload?.data || payload
  return d?.message?.imageMessage?.caption || ''
}

function getTextContent(payload) {
  const d = payload?.data || payload
  const m = d?.message || {}
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.buttonsResponseMessage?.selectedDisplayText ||
    m.buttonsResponseMessage?.selectedButtonId ||
    m.templateButtonReplyMessage?.selectedDisplayText ||
    m.listResponseMessage?.title ||
    m.buttonText ||
    ''
  )
}

/** WhatsApp Flow (Form Sumar) — resposta estruturada após preenchimento. */
function extractFormSumarPayloadText(payload) {
  const d = payload?.data || payload
  const m = d?.message || {}
  const nfm =
    m.interactiveMessage?.nativeFlowReplyMessage ||
    m.nativeFlowReplyMessage ||
    m.nfmReplyMessage ||
    null
  const rawJson =
    nfm?.response_json ||
    nfm?.body ||
    m.interactive?.nfm_reply?.response_json ||
    m.interactive?.nfm_reply?.body ||
    null
  if (rawJson) {
    const s = typeof rawJson === 'string' ? rawJson : JSON.stringify(rawJson)
    return `[FORMULARIO SUMAR]: ${s}`
  }
  const interactiveBody = m.interactiveMessage?.body?.text || m.interactive?.body?.text
  if (interactiveBody && /\bformul[aá]rio\b/i.test(String(interactiveBody))) {
    return `[FORMULARIO SUMAR]: ${interactiveBody}`
  }
  return ''
}

function authOk(env, req) {
  const expected = env.EVOLUTION_WEBHOOK_TOKEN
  if (!expected) return true
  const provided =
    req.headers['x-webhook-token'] ||
    req.headers['authorization']?.replace(/^Bearer\s+/i, '') ||
    req.query?.token
  return provided === expected
}

async function pushInboundToBuffer(env, sessionId, clean, logCtx = '', mirrorOpts = {}) {
  const pushRes = await pushMessage(env, sessionId, clean)
  if (pushRes?.pushed === false) {
    console.log(
      `[Evolution] buffer skip session=${sessionId} reason=${pushRes.skipped || 'unknown'}${logCtx ? ` ctx=${logCtx}` : ''}`,
    )
    return false
  }
  recordBufferWrite(sessionId)
  if (isEduitBackend(env)) return true
  mirrorEvolutionInboundToKommo(env, {
    sessionId,
    text: clean,
    pushName: mirrorOpts.pushName,
    messageId: mirrorOpts.messageId,
  }).catch((e) => console.warn('[kommo-mirror] async:', e.message))
  return true
}

async function extractMessageText(env, payload, messageType) {
  switch (messageType) {
    case 'conversation':
    case 'extendedTextMessage':
      return getTextContent(payload)

    case 'buttonMessage':
    case 'buttonsResponseMessage':
    case 'templateButtonReplyMessage':
    case 'listResponseMessage':
      return getTextContent(payload)

    case 'interactiveMessage':
    case 'nativeFlowReplyMessage':
    case 'nfmReplyMessage': {
      const formText = extractFormSumarPayloadText(payload)
      if (formText) return formText
      return getTextContent(payload)
    }

    case 'audioMessage': {
      const { base64: b64 } = await resolveMediaBase64(env, payload, 'audio')
      const dispatcherActive = isDispatcherPathAvailable(env)
      if (!b64) {
        if (dispatcherActive) {
          // Silêncio: o pollDispatcher vai pegar o áudio via media_url
          // no próximo tick do scheduler e transcrever certinho. Sem
          // isso a IA recebia "áudio falhou" + transcrição real e
          // pedia desculpa por erro técnico que não existiu.
          console.log(
            `[Evolution][audio] sem base64 e dispatcher ativo — pulando push (dispatcher cuidará)`,
          )
          return ''
        }
        return '[ÁUDIO RECEBIDO mas não foi possível baixar o conteúdo. Peça desculpas, resuma o que já foi conversado sobre o curso (se houver no histórico) e peça pro lead reenviar em texto ou gravar de novo. NÃO encaminhe para consultor humano neste turno.]'
      }
      try {
        // mimeType padrão do WhatsApp é audio/ogg; codecs=opus, mas
        // Whisper aceita ogg sem o `codecs=`.
        const txt = await transcribeAudioBase64(env, b64, { filename: 'file.ogg', mimeType: 'audio/ogg' })
        if (!txt || !txt.trim()) {
          if (dispatcherActive) {
            console.log(`[Evolution][audio] transcrição vazia e dispatcher ativo — pulando push`)
            return ''
          }
          return '[ÁUDIO RECEBIDO mas a transcrição ficou vazia — confirme com o lead se ele pode reenviar ou digitar a mensagem.]'
        }
        // Marca explicitamente que veio de áudio pra a IA poder
        // se referir a "o que você disse" sem alucinar. Se o dispatcher
        // empurrar a mesma transcrição no próximo tick, o
        // ingestDedupe (hash do texto) descarta o duplicado.
        return `[ÁUDIO TRANSCRITO]: ${txt.trim()}`
      } catch (e) {
        console.error('[Evolution][audio] falha na transcrição:', e.message)
        if (dispatcherActive) {
          console.log(`[Evolution][audio] erro na transcrição e dispatcher ativo — pulando push`)
          return ''
        }
        return '[ÁUDIO RECEBIDO mas houve falha técnica na transcrição. Peça para reenviar ou digitar; continue o atendimento sobre o curso em discussão. NÃO encaminhe para consultor humano neste turno.]'
      }
    }

    case 'imageMessage': {
      const { base64: b64 } = await resolveMediaBase64(env, payload, 'image')
      const caption = getImageCaption(payload).trim()
      const dispatcherActive = isDispatcherPathAvailable(env)
      if (!b64) {
        if (dispatcherActive) {
          console.log(
            `[Evolution][image] sem base64 e dispatcher ativo — pulando push (dispatcher cuidará)`,
          )
          return ''
        }
        // Sem base64 a Vision não roda — mas a IA precisa SABER que
        // recebeu uma imagem pra responder algo (sem isso ela ficava
        // muda, caso real visto na conversa de notas ENEM).
        return caption
          ? `[IMAGEM RECEBIDA mas o conteúdo não foi processado tecnicamente. Legenda enviada pelo lead: "${caption}". Peça desculpas e diga que vai pedir pra um consultor analisar a imagem.]`
          : '[IMAGEM RECEBIDA mas o conteúdo não foi processado tecnicamente. Peça desculpas e diga que vai pedir pra um consultor analisar a imagem.]'
      }
      try {
        const analysis = await analyzeImageBase64(env, b64, { mimeType: 'image/jpeg' })
        // NÃO removemos quebras de linha agora — a leitura de notas ENEM
        // fica muito melhor com formatação mantida. O orquestrador lida
        // bem com texto multi-linha.
        const clean = String(analysis || '').trim()
        if (!clean) {
          if (dispatcherActive) {
            console.log(`[Evolution][image] análise vazia e dispatcher ativo — pulando push`)
            return ''
          }
          return caption
            ? `[IMAGEM RECEBIDA mas a análise visual ficou vazia. Legenda do lead: "${caption}".]`
            : '[IMAGEM RECEBIDA mas a análise visual ficou vazia. Peça ao lead pra reenviar ou descrever em texto.]'
        }
        return caption ? `${clean}\n\n[Legenda do lead na imagem]: ${caption}` : clean
      } catch (e) {
        console.error('[Evolution][image] falha na análise:', e.message)
        if (dispatcherActive) {
          console.log(`[Evolution][image] erro na análise e dispatcher ativo — pulando push`)
          return ''
        }
        return caption
          ? `[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Legenda do lead: "${caption}". Diga que vai pedir pra um consultor olhar.]`
          : '[IMAGEM RECEBIDA mas houve falha técnica ao analisá-la. Diga que vai pedir pra um consultor olhar.]'
      }
    }

    default:
      return getTextContent(payload)
  }
}

async function flushSessionInner(env, sessionId, opts = {}) {
  const testMode = opts.test === true

  if (!tryReserveFlushSync(sessionId, env)) {
    console.log(`[Evolution][flush] ${sessionId} BLOQUEADO — flush_sync_busy (mesmo processo).`)
    return { skipped: 'flush_sync_busy' }
  }

  const telefone = normalizeTelefone(sessionId)
  let redisClient = null
  let redisKeyPrefix = null

  try {
    const redis = await getMessageBufferRedis(env).catch(() => ({ client: null, keyPrefix: null }))
    redisClient = redis.client
    redisKeyPrefix = redis.keyPrefix

    const flushClaim = await tryClaimAgentFlush(env, {
      sessionId,
      telefone,
      redisClient,
      redisKeyPrefix,
      testMode,
    })
    if (!flushClaim.claimed) {
      console.log(
        `[Evolution][flush] ${sessionId} BLOQUEADO — claim distribuído (${flushClaim.reason || 'claim_busy'}).`,
      )
      return { skipped: 'flush_claim_busy', reason: flushClaim.reason }
    }

    // ── GATES PRIMEIRO — mensagens permanecem no buffer e são reprocessadas
    // no próximo tick quando o gate liberar (cooldown expira, IA religada,
    // pausa retirada). Política antiga (drenar antes) descartava
    // mensagens válidas como efeito colateral dos gates.
    const peekPending = async () => {
      try {
        const pending = await getMessages(env, sessionId)
        return Array.isArray(pending) ? pending.length : 0
      } catch {
        return 0
      }
    }

    // Ambiente de teste (/api/test/inbound): ignora gates operacionais
    // (IA desligada, cooldown, pausa de matrícula/consultor) para sempre
    // exercitar o agente completo num número de teste, sem depender da
    // Evolution. NÃO use em produção real — só pra leads de teste.

    const aiState = getAiControlStateSync()
    if (!testMode && aiState.enabled === false) {
      const pending = await peekPending()
      console.log(
        `[Evolution][flush] ${sessionId} held — ai_disabled${aiState.reason ? ` (${aiState.reason})` : ''} | pending: ${pending}`,
      )
      return { skipped: 'ai_disabled', reason: aiState.reason || null, pending }
    }

    if (!testMode && telefone && shouldSkipReplyCooldown(env, telefone)) {
      const pending = await peekPending()
      const remainingMs = getReplyCooldownRemainingMs(env, telefone)
      const remainingSec = Math.ceil(remainingMs / 1000)
      console.log(
        `[Evolution][flush] ${sessionId} held — reply_cooldown (${telefone}, ${remainingSec}s restantes) | pending: ${pending}`,
      )
      return { skipped: 'reply_cooldown', telefone, pending, remainingMs }
    }

    if (!testMode && telefone) {
      const pauseDecision = await shouldHoldOnIaPause(env, telefone)
      if (pauseDecision.hold) {
        const pending = await peekPending()
        // Rede de segurança: dado de cadastro objetivo não pode se perder só
        // porque a IA está pausada (caso Bianca #24067).
        try {
          const msgs = await getMessages(env, sessionId)
          const userMessage = Array.isArray(msgs)
            ? msgs.map((m) => String(m || '').trim()).filter(Boolean).join(', ')
            : ''
          if (userMessage) {
            const leadHint = normalizeCrmLeadId(opts.leadIdHint, env) || undefined
            const cadastro = await persistCadastroFieldsFromInbound(env, {
              telefone,
              leadId: leadHint,
              userMessage,
              historyMessages: [],
            })
            if (cadastro.written?.length) {
              console.log(
                `[Evolution][flush] ${sessionId} CADASTRO_CARD_SYNC_ON_HOLD written=${cadastro.written.join(',')} ok=${cadastro.ok} code=${cadastro.code || 'n/a'}`,
              )
            }
          }
        } catch (err) {
          console.warn(
            `[Evolution][flush] ${sessionId} CADASTRO_CARD_SYNC_ON_HOLD erro: ${err?.message || err}`,
          )
        }
        console.log(
          `[Evolution][flush] ${sessionId} held — ia_paused (matrícula/consultor ativo) | pending: ${pending}`,
        )
        return { skipped: 'ia_paused', pending }
      }
      if (pauseDecision.paused && pauseDecision.reason) {
        // IA pausada, mas com handler early que vai responder mensagem canônica
        // (ex: desistência já concluída). Drain prossegue.
        console.log(
          `[Evolution][flush] ${sessionId} ia_paused mas early_handler=${pauseDecision.reason} — drain prossegue`,
        )
      }
    }

    const rawLeadHint = normalizeCrmLeadId(opts.leadIdHint, env)
    const leadIdHint =
      isEduitBackend(env) && rawLeadHint && !/^c[a-z0-9]{8,}$/i.test(String(rawLeadHint))
        ? null
        : rawLeadHint
    if (!opts.skipFunnelGate) {
      const funnel = await assertLeadInAgentFunnel(env, {
        leadId: leadIdHint || undefined,
        telefone,
      })
      if (!funnel.ok) {
        const pending = await peekPending()
        console.log(
          `[Evolution][flush] ${sessionId} held — funnel_gate (${funnel.reason}) ` +
            `${describeLeadFunnel(funnel.lead || { pipeline_id: funnel.pipeline_id, status_id: funnel.status_id })} | pending: ${pending}`,
        )
        return { skipped: 'funnel_gate', reason: funnel.reason, pending }
      }
      // Persiste CUIDs EduIT quando o gate resolveu/moveu o deal
      if (isEduitBackend(env) && funnel.lead?.id && telefone) {
        await persistEduitIds(env, telefone, {
          dealId: funnel.lead.eduit_deal_id || funnel.lead.id,
          contactId: funnel.lead.eduit_contact_id,
          conversationId: funnel.lead.eduit_conversation_id,
        }).catch(() => {})
      }
    }

    // Backoff de retry de ENVIO: se este MESMO conteúdo de buffer já gerou
    // resposta mas o WhatsApp falhou (ex.: token Meta expirado), espera a
    // janela de backoff antes de queimar outra execução LLM. Inbound novo
    // muda o hash e passa direto.
    if (!testMode) {
      const pendingPeek = await getMessages(env, sessionId)
      const backoff = shouldHoldForSendRetryBackoff(env, sessionId, pendingPeek)
      if (backoff.hold) {
        console.log(
          `[Evolution][flush] ${sessionId} held — send_retry_backoff (falhas=${backoff.failCount}, retry em ${Math.ceil((backoff.remainingMs || 0) / 1000)}s) | pending: ${pendingPeek.length}`,
        )
        return {
          skipped: 'send_retry_backoff',
          pending: pendingPeek.length,
          remainingMs: backoff.remainingMs,
          failCount: backoff.failCount,
        }
      }
    }

    const itens = await drainMessages(env, sessionId)
    if (!itens.length) {
      console.log(`[Evolution][flush] ${sessionId} sem mensagens pendentes (drain vazio)`)
      return null
    }

    const mensagemCompleta = sanitizeLeadInboundMessage(itens.join(', '))

    const executionId = opts.executionId || generateExecutionId()
    const startedAt = new Date().toISOString()
    const leadIdForAgent = leadIdHint || null
    console.log(`[${executionId}] flush ${sessionId} → "${mensagemCompleta}"`)
    console.log(
      `[${executionId}] RECEBEU_MENSAGEM session=${sessionId} telefone=${telefone} leadIdHint=${leadIdForAgent ?? 'n/a'} itens=${itens.length} chars=${mensagemCompleta.length}`,
    )

  // "Digitando..." começa AQUI, depois do debounce. Caminho único:
  // Cloud API Meta (read receipt + typing_indicator) com heartbeat —
  // precisa do `wamid` (id Meta da mensagem original do cliente). Só
  // disponível quando o agente recebeu via webhook Evolution.
  //
  // No modo `dispatcher` o `wamid` não vem no payload do
  // banco-kommo-dispatcher, então o typing simplesmente não é exibido
  // (NO-OP silencioso) — o foco é responder rápido. Se um dia o
  // dispatcher passar a expor o wamid, basta empurrá-lo no
  // sessionWamid.rememberWamid e o heartbeat já passa a funcionar.
  const wamids = getWamids(sessionId)
  let typingHb = null
  if (wamids.length > 0) {
    typingHb = startTypingHeartbeat(env, wamids, {
      intervalMs: 4000,
      maxDurationMs: 90000,
      log: (line) => console.log(`[${executionId}] ${line}`),
    })
  } else {
    console.log(`[${executionId}] typing pulado (sem wamid; modo dispatcher)`)
  }

  let out = null
  let idLead = null
  let sendResult = null
  let histResult = null
  try {
    // Quando o scheduler já achou o lead no Kommo (caminho normal no
    // modo dispatcher), passamos o id_lead p/ o agente — assim o LLM
    // pode chamar tools como inscricao/distribuir_humano sem precisar
    // adivinhar o ID. Sem isso o LLM mandava `id_lead: 0` e a tool
    // caía em MISSING_CRM_FIELDS.
    console.log(`[${executionId}] CHAMOU_IA telefone=${telefone} leadId=${leadIdForAgent ?? 'n/a'}`)
    out = await runAgent(env, {
      telefone,
      userMessage: mensagemCompleta,
      executionId,
      leadId: leadIdForAgent ?? undefined,
      // Gate ia_paused já checado acima (antes do drain) — economiza round-trip.
      skipPauseCheck: true,
    })
    if (out.ok) {
      console.log(
        `[${executionId}] RESPOSTA_GERADA ok=${out.ok} dur=${out.durationMs}ms tokens=${out.usage?.total_tokens || 0} tools=${out.toolCalls?.length || 0} replyChars=${out.reply?.length || 0}`,
      )
      console.log(
        `[${executionId}] agent ok (${out.durationMs}ms, ${out.usage?.total_tokens} tok, tools=${out.toolCalls?.length || 0}): ${out.reply?.slice(0, 200)}`,
      )
    } else {
      console.error(`[${executionId}] RESPOSTA_GERADA ok=false erro="${out.error}"`)
      console.error(`[${executionId}] agent erro:`, out.error)
    }

    if (out?.ok && out.reply) {
      // 1ª prioridade: leadId vindo do scheduler (já achou no CRM p/
      // listar quem tá no funil). Evita chamar findLeadByPhone de novo.
      let eduitConversationId = null
      if (leadIdForAgent != null) {
        idLead = leadIdForAgent
        console.log(`[${executionId}] crm lead ${idLead} (hint do scheduler) p/ ${telefone}`)
      } else {
        try {
          const lookup = await findLeadByPhone(env, telefone)
          if (lookup.ok && lookup.lead) {
            idLead = normalizeCrmLeadId(lookup.lead.id, env)
            eduitConversationId = lookup.conversationId || lookup.lead.eduit_conversation_id || null
            console.log(`[${executionId}] crm lead ${idLead} encontrado p/ ${telefone}`)
            if (isEduitBackend(env)) {
              await persistEduitIds(env, telefone, {
                dealId: lookup.lead.eduit_deal_id || idLead,
                contactId: lookup.contactId || lookup.lead.eduit_contact_id,
                conversationId: eduitConversationId,
              }).catch(() => {})
            }
          } else if (!lookup.ok) {
            console.warn(`[${executionId}] crm falha: ${lookup.error || lookup.status}`)
          } else {
            console.log(`[${executionId}] crm nenhum lead p/ ${telefone}`)
          }
        } catch (err) {
          console.error(`[${executionId}] crm exception:`, err.message)
        }
      }
      if (idLead == null) {
        try {
          const fromDb = await getLeadIdByTelefone(env, telefone)
          if (fromDb != null && (!isEduitBackend(env) || /^c[a-z0-9]{8,}$/i.test(String(fromDb)))) {
            idLead = fromDb
          }
        } catch {}
      }
      if (isEduitBackend(env) && !eduitConversationId && telefone) {
        try {
          const ids = await resolveAndPersistEduitIds(env, telefone)
          if (ids.ok) {
            eduitConversationId = ids.conversationId
            if (idLead == null && ids.dealId) idLead = ids.dealId
          }
        } catch {}
      }

      // Para o "digitando..." imediatamente antes do envio: o próprio envio
      // dispensaria, mas parar antes evita pings desnecessários e race
      // entre typing e a entrega da primeira parte.
      if (typingHb) {
        try { await typingHb.stop() } catch {}
        typingHb = null
      }

      // Envio primeiro; histórico só quando WhatsApp confirmou entrega
      // (evita "fantasma" no Supabase/Kommo quando dedupe bloqueia sent:0).
      try {
        if (opts.suppressWhatsapp === true) {
          console.log(`[${executionId}] envio WhatsApp SUPRIMIDO (test suppressWhatsapp)`)
          sendResult = { ok: true, sent: 0, total: 0, suppressed: true }
        } else if (whatsappAlreadyDeliveredByTool(out)) {
          console.log(
            `[${executionId}] WhatsApp já enviado pela tool (ex.: grade PDF) — skip duplicate flush send`,
          )
          sendResult = { ok: true, sent: 0, skipped: true, reason: 'already_sent_by_tool' }
        } else {
          sendResult = await sendMessageWithNote(env, {
            telefone,
            text: out.reply,
            leadId: idLead,
            executionId,
            freshUserTurn: true,
            conversationId: eduitConversationId || undefined,
          })
          if (sendResult?.ok && (sendResult.sent || 0) > 0) {
            console.log(
              `[${executionId}] ENVIOU_WHATSAPP partes=${sendResult.sent}/${sendResult.total} leadId=${idLead ?? 'n/a'}` +
                `${isEduitBackend(env) ? ' via=eduit' : ''}`,
            )
          } else if (sendResult?.deduped) {
            console.warn(
              `[${executionId}] WhatsApp dedupe skip reason=${sendResult.reason || 'n/a'} sent=${sendResult.sent || 0}`,
            )
          } else if (sendResult && !sendResult.ok) {
            console.error(
              `[${executionId}] ERRO_ENVIO_WHATSAPP partes=${sendResult.sent}/${sendResult.total} erro="${sendResult.error || sendResult.code || 'desconhecido'}"`,
            )
          }
        }
      } catch (err) {
        console.error(`[${executionId}] ERRO_ENVIO_WHATSAPP exception="${err.message}"`)
        sendResult = null
      }

      if (whatsappDeliveryConfirmed(sendResult, out)) {
        try {
          histResult = await saveConversation(env, {
            telefone,
            userMessage: mensagemCompleta,
            botMessage: out.reply,
            messageType: 'conversation',
            idLead,
          })
          if (!histResult?.ok) {
            const failed = (histResult?.steps || []).filter((s) => s.ok === false)
            console.warn(`[${executionId}] history falhas:`, JSON.stringify(failed))
          }
        } catch (err) {
          console.error(`[${executionId}] history exception:`, err.message)
          histResult = null
        }
      } else {
        console.warn(
          `[${executionId}] history omitido — WhatsApp não confirmou entrega (sent=${sendResult?.sent || 0}, dedupe=${sendResult?.reason || 'n/a'})`,
        )
        histResult = { ok: false, skipped: true, reason: 'whatsapp_not_delivered' }
      }
    }
  } catch (err) {
    console.error(`[${executionId}] agent exception:`, err.message)
  } finally {
    if (typingHb) {
      try { await typingHb.stop() } catch {}
      typingHb = null
    }
  }

  // O erro a registrar precisa cobrir 4 cenários distintos pra o
  // operador conseguir diagnosticar pelo painel:
  //  1. agente nem rodou / falhou → out?.error
  //  2. envio bloqueado por race (outbound_inflight_sync) → marcamos
  //     como erro pra não passar por "sucesso silencioso"; a próxima
  //     passada do scheduler reprocessa naturalmente.
  //  3. agente rodou mas envio do WhatsApp falhou → ainda mostra
  //     "Sucesso" no badge se a gente não setar error aqui (foi o
  //     bug que motivou esta mudança).
  //  4. tudo ok (sent>0 ou deduped legítimo) → null.
  let executionError = null
  if (!out?.ok) {
    executionError = out?.error || 'runAgent retornou null'
  } else if (out.reply && sendResult?.race) {
    executionError = `WhatsApp race: ${sendResult.reason || 'outbound_inflight_sync'} — mensagem permanecerá no buffer para o próximo tick`
    console.warn(`[${executionId}] envio WhatsApp bloqueado por race — registrando como erro: ${executionError}`)
  } else if (out.reply && sendResult && !sendResult.ok) {
    executionError = `WhatsApp falhou: ${sendResult.error || sendResult.code || 'erro desconhecido'} (enviou ${sendResult.sent || 0}/${sendResult.total || 0} partes)`
    console.error(`[${executionId}] envio WhatsApp falhou — registrando como erro: ${executionError}`)
  } else if (out.reply && !sendResult) {
    // Esse caso só acontece se o envio deu exception não capturada;
    // o code path normal sempre devolve um objeto.
    executionError = 'WhatsApp não retornou — provável exception silenciosa'
  }

  saveExecution(env, {
    id: executionId,
    timestamp: startedAt,
    userMessage: mensagemCompleta,
    model: out?.model || null,
    steps: buildSteps({ sendResult, histResult, idLead, agentOut: out }),
    toolCalls: out?.toolCalls || [],
    response: out?.ok ? out.reply : null,
    error: executionError,
    totalDurationMs: out?.durationMs || 0,
    usage: out?.usage || {},
    aiMeta: out?.aiMeta || null,
    telefone,
    leadId: idLead,
    origem: 'evolution',
  }).then((r) => {
    if (!r.ok) console.warn(`[${executionId}] saveExecution falhou: ${r.error}`)
  }).catch((err) => console.error(`[${executionId}] saveExecution exception:`, err.message))

    // Distinção semântica para evitar "engolir" mensagens silenciosamente:
    //  - `sent > 0`     → mensagem realmente saiu pela Cloud/Evolution API.
    //  - `deduped` true sem race → resposta idêntica enviada antes (dedupe
    //    legítimo de `chat_messages`); contamos como "tratado" e damos
    //    cooldown, mas NÃO gravamos o hash do inbound (pra não esconder
    //    futuras mensagens iguais do cliente).
    //  - `race` true    → lock in-memory ocupou; NÃO é envio, vira erro e
    //    a próxima passada do scheduler reprocessa.
    const sendRace = Boolean(sendResult?.race)
    const sentReal = (sendResult?.sent || 0) > 0
    const sentByTool = Boolean(sendResult?.skipped && sendResult?.reason === 'already_sent_by_tool')
    const dedupedLegit = Boolean(
      sendResult?.ok &&
        sendResult?.deduped &&
        !sendRace &&
        (sendResult?.reason === 'identical_recent_bot_message' ||
          sendResult?.reason === 'post_form_boilerplate_recent'),
    )
    const sentOk = Boolean(
      (sendResult?.ok && (sentReal || dedupedLegit || sentByTool)) ||
        whatsappAlreadyDeliveredByTool(out),
    )
    if (telefone && sentOk) {
      markReplyCooldown(env, telefone)
      clearSendRetryBackoff(sessionId)
      clearSessionParkedForHuman(sessionId)
      if (sentReal) {
        // Hash do inbound só faz sentido após envio confirmado — gravar
        // antes (em dedupe ou race) descarta o próximo turno do cliente.
        await recordBufferFlushHash(env, sessionId, itens)
      }
    }
    if (sendRace) {
      console.warn(
        `[${executionId}] WhatsApp race (${sendResult?.reason || 'outbound_inflight_sync'}) — reenfileirando ${itens.length} turno(s)`,
      )
      await repushDrainedMessages(env, sessionId, itens)
    } else if (
      itens.length > 0 &&
      !out?.iaPaused &&
      !out?.inscricaoFormHandled &&
      !out?.distribuirHumanoHandled
    ) {
      if (!out?.ok) {
        const bo = recordSendFailureBackoff(env, sessionId, itens)
        console.warn(
          `[${executionId}] agente falhou — reenfileirando ${itens.length} turno(s) (backoff falhas=${bo.failCount}, retry em ${Math.ceil(bo.nextRetryInMs / 1000)}s): ${executionError || out?.error || 'n/a'}`,
        )
        await repushDrainedMessages(env, sessionId, itens)
        if (shouldEscalateSendFailure(env, bo.failCount)) {
          await escalateSendFailureToHuman(env, {
            executionId,
            sessionId,
            leadId: idLead ?? leadIdForAgent,
            errorText: executionError || out?.error,
            failCount: bo.failCount,
            items: itens,
          })
        }
      } else if (out?.reply && !sentOk && !sendResult?.suppressed) {
        const bo = recordSendFailureBackoff(env, sessionId, itens)
        console.warn(
          `[${executionId}] envio não confirmado após drain — reenfileirando ${itens.length} turno(s) (backoff falhas=${bo.failCount}, retry em ${Math.ceil(bo.nextRetryInMs / 1000)}s)`,
        )
        await repushDrainedMessages(env, sessionId, itens)
        if (shouldEscalateSendFailure(env, bo.failCount)) {
          await escalateSendFailureToHuman(env, {
            executionId,
            sessionId,
            leadId: idLead ?? leadIdForAgent,
            errorText: executionError,
            failCount: bo.failCount,
            items: itens,
          })
        }
      }
    }

    return out
  } finally {
    releaseFlushSync(sessionId)
    try {
      await releaseAgentFlush(env, { sessionId, telefone, redisClient, redisKeyPrefix })
    } catch (err) {
      console.warn(`[Evolution][flush] release claim falhou ${sessionId}:`, err.message)
    }
  }
}

/**
 * Converte o resultado de envio/histórico + os passos do orquestrador
 * em "steps" (mesmo conceito do executionStore/ExecutionViewer) para
 * debugar rapidamente o que aconteceu depois que o agente respondeu.
 *
 * Inclui também os steps por round do agentRunner (decisão LLM, tokens,
 * mensagens enviadas, resposta crua) — mesmo padrão usado pelo Salesbot.
 */
function buildSteps({ sendResult, histResult, idLead, agentOut }) {
  const steps = []
  if (agentOut?.ctxSnapshot) {
    steps.push({ type: 'ctx_snapshot', tool: 'agent.ctx_snapshot', result: agentOut.ctxSnapshot })
  }
  if (Array.isArray(agentOut?.orchestratorSteps)) {
    for (const s of agentOut.orchestratorSteps) steps.push(s)
  }
  if (idLead != null) steps.push({ tool: 'kommo.findLeadByPhone', result: { leadId: idLead } })
  if (sendResult) {
    steps.push({
      tool: 'whatsapp.sendMessageWithNote',
      result: {
        ok: sendResult.ok,
        sent: sendResult.sent,
        total: sendResult.total,
        error: sendResult.error || null,
      },
    })
  }
  if (histResult) {
    const failed = (histResult.steps || []).filter((s) => s.ok === false).map((s) => s.step || 'step')
    steps.push({
      tool: 'history.saveConversation',
      result: {
        ok: histResult.ok,
        failedSubsteps: failed,
      },
    })
  }
  return steps
}

export function flushSession(env, sessionId, opts = {}) {
  const canonical = canonicalWhatsAppSessionId(sessionId) || String(sessionId || '').trim()
  if (!canonical) return Promise.resolve(null)
  return withSessionLock(canonical, () => flushSessionInner(env, canonical, opts))
}

export function makeEvolutionWebhookHandler(env) {
  return async function handler(req, res) {
    const rawBody = req.body || {}
    if (rawBody.instance != null) {
      rawBody.instance =
        normalizeEvolutionInstance(env, String(rawBody.instance)) || String(rawBody.instance)
    }
    const evtName = rawBody.event || rawBody.body?.event || 'unknown'
    const fromMe = Boolean(rawBody?.data?.key?.fromMe ?? rawBody?.body?.data?.key?.fromMe)
    const instanceName = rawBody.instance != null ? String(rawBody.instance) : null
    const sync = (outcome, detail = null) =>
      recordSyncOutcome({ event: evtName, instance: instanceName, outcome, detail })
    console.log(`[Evolution][hit] event=${evtName} fromMe=${fromMe} instance=${instanceName || 'n/a'}`)

    if (!authOk(env, req)) {
      console.warn('[Evolution] auth FAIL — webhook chegou mas X-Webhook-Token/Authorization inválido')
      sync('auth_failed', 'X-Webhook-Token ou Bearer inválido versus EVOLUTION_WEBHOOK_TOKEN')
      res.status(401).json({ ok: false, error: 'invalid token' })
      return
    }

    // WhatsApp Business (Meta): telefone do lead vem em contacts.* depois do messages.upsert
    if (evtName === 'contacts.upsert' || evtName === 'contacts.update') {
      const data = rawBody.data || rawBody.body?.data || {}
      const instance = rawBody.instance
      const customerSession = extractContactSessionId(data)
      if (!customerSession) {
        console.log(`[Evolution][contact] skip sem remoteJid instance=${instance}`)
        sync('contact_skip_no_remote_jid', `instance=${instance || 'n/a'}`)
        res.status(200).json({ ok: true, skipped: 'contact_no_phone' })
        return
      }
      const matched = matchContactToPending(instance, customerSession)
      if (!matched) {
        if (shouldBufferOrphanContact(instance)) {
          bufferOrphanContact(instance, customerSession)
          console.log(`[Evolution][contact] contato órfão (Cloud) ${customerSession} instance=${instance}`)
          sync('contact_orphan_in_window', customerSession)
        } else {
          console.log(
            `[Evolution][contact] ${evtName} ignorado (sem fila Cloud) instance=${instance}`,
          )
          sync(
            'contact_no_pending_cloud_queue',
            `${customerSession} — ligue CONTACTS_UPSERT/UPDATE e envie msg de novo, ou veja se messages.upsert Cloud foi antes`,
          )
        }
        res.status(200).json({ ok: true, queued: 'contact_no_pending' })
        return
      }
      try {
        const { pending, sessionId } = matched
        const text = await extractMessageText(env, pending.payload, pending.messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution][contact] extract vazio session=${sessionId} type=${pending.messageType}`)
          sync('contact_extract_empty', `${sessionId} type=${pending.messageType}`)
        } else {
          if (!isEvolutionIngestPhoneAllowed(env, sessionId)) {
            console.log(`[Evolution][contact] skip ingest_phone_allowlist session=${sessionId}`)
            sync('contact_skipped_phone_allowlist', sessionId)
          } else {
            if (pending.messageId) rememberWamid(sessionId, pending.messageId)
            await pushInboundToBuffer(env, sessionId, clean, evtName, {
              messageId: pending.messageId,
              pushName: pending.pushName,
            })
            clearCloudBridgeContactWindow(instance)
            console.log('[Evolution][cloud] buffer', sessionId, String(clean).slice(0, 120), evtName)
            sync('contact_matched_buffer_ok', sessionId)
          }
        }
      } catch (err) {
        console.error('[Evolution][contact] erro ao bufferizar:', err.message)
        sync('contact_buffer_exception', err.message)
      }
      res.status(200).json({ ok: true, buffered: true })
      return
    }

    if (evtName !== 'messages.upsert') {
      sync('ignored_event', evtName)
      res.status(200).json({ ok: true, ignored: evtName })
      return
    }

    const payload = getBody(req)
    const messageType = inferMessageType(payload)
    const sessionRaw = getSessionId(payload)
    const sessionId = resolveBufferSessionId(payload)
    const pushName = getPushName(payload)

    if (!messageType || !sessionId) {
      console.log(`[Evolution] skip missing_type_or_session (event=${evtName}) rawJid=${sessionRaw || 'n/a'}`)
      sync('msg_missing_type_or_session', `type=${messageType || ''} sessionId=${sessionId || ''} rawJid=${sessionRaw || 'n/a'}`)
      res.status(200).json({ ok: true, skipped: 'missing_type_or_session' })
      return
    }
    if (sessionRaw && sessionRaw !== sessionId) {
      console.log(`[Evolution] jid buffer ${sessionRaw} → ${sessionId}`)
    }
    if (sessionId.endsWith('@lid')) {
      console.warn(
        `[Evolution] remoteJid caiu em @lid sem telefone resolvido — o scheduler (Kommo) não achará o buffer. Verifique Evolution/remoteJidAlt ou atualize a API.`,
      )
    }
    if (payload?.data?.key?.fromMe) {
      console.log(`[Evolution] skip fromMe ${sessionId}`)
      sync('msg_skipped_from_me', sessionId)
      res.status(200).json({ ok: true, skipped: 'fromMe' })
      return
    }

    const messageId = getMessageId(payload)
    if (seenMessage(messageId)) {
      console.log(`[Evolution] duplicado ignorado (${messageId}) ${sessionId}`)
      sync('msg_duplicate', String(messageId))
      res.status(200).json({ ok: true, skipped: 'duplicate', messageId })
      return
    }

    const instance = rawBody.instance

    if (isCloudBusinessInbound(env, payload, rawBody) && !clientSessionAlreadyResolved(sessionId, payload)) {
      console.log(
        `[Evolution][cloud] messages.upsert com JID do negócio — aguardando contacts.* p/ gravar no ${instance || '?'}`,
      )
      sync(
        'cloud_bridge_queued_await_contact',
        `Próximo passo: webhook deve receber contacts.upsert/update com remoteJid do lead. instance=${instance || 'n/a'}`,
      )
      res.status(200).json({ ok: true, accepted: true, cloudBridge: true, messageType, messageId })
      markCloudBridgeExpectsContact(instance)
      const hit = enqueueCloudInboundPending(instance, { messageId, messageType, payload })
      if (hit?.mode === 'immediate') {
        setImmediate(async () => {
          try {
            const text = await extractMessageText(env, payload, messageType)
            const clean = String(text || '').trim()
            if (!clean) {
              console.warn(`[Evolution][cloud] sem conteúdo (immediate) ${hit.sessionId}`)
              recordAsyncError('cloud_immediate_empty', hit.sessionId)
              return
            }
            if (!isEvolutionIngestPhoneAllowed(env, hit.sessionId)) {
              console.log(`[Evolution][cloud] skip ingest_phone_allowlist session=${hit.sessionId}`)
              return
            }
            if (messageId) rememberWamid(hit.sessionId, messageId)
            await pushInboundToBuffer(env, hit.sessionId, clean, 'cloud_orphan_immediate', { messageId })
            console.log('[Evolution][cloud] buffer orphan resolved', hit.sessionId, String(clean).slice(0, 120))
            clearCloudBridgeContactWindow(instance)
          } catch (err) {
            recordAsyncError('cloud_immediate', err.message)
            console.error('[Evolution][cloud] processing error:', err.message)
          }
        })
      }
      return
    }

    if (isCloudBusinessInbound(env, payload, rawBody) && clientSessionAlreadyResolved(sessionId, payload)) {
      console.log(
        `[Evolution][cloud] bridge ignorada — cliente resolvido no payload (${sessionRaw || 'n/a'} → ${sessionId})`,
      )
    }

    if (messageId) rememberWamid(sessionId, messageId)
    sync('msg_buffer_async_scheduled', `vai gravar em ${sessionId} após extrair texto`)
    res.status(200).json({ ok: true, accepted: true, messageType, sessionId, messageId })

    setImmediate(async () => {
      try {
        const text = await extractMessageText(env, payload, messageType)
        const clean = String(text || '').trim()
        if (!clean) {
          console.warn(`[Evolution] ${messageType} sem conteúdo utilizável (${sessionId})`)
          recordAsyncError('msg_async_empty', `${messageType} ${sessionId}`)
          return
        }
        if (!isEvolutionIngestPhoneAllowed(env, sessionId)) {
          console.log(`[Evolution] skip ingest_phone_allowlist session=${sessionId}`)
          return
        }
        console.log(`[Evolution] ${messageType} ← ${sessionId} (${pushName}): "${clean.slice(0, 140)}"`)
        await pushInboundToBuffer(env, sessionId, clean, messageType, { messageId, pushName })
      } catch (err) {
        recordAsyncError('msg_async_buffer', err.message)
        console.error('[Evolution] processing error:', err.message)
      }
    })
  }
}
