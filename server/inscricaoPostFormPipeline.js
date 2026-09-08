/**
 * Pós Form Sumar (fluxo direto):
 *   formulário respondido → salesbot matrícula 49813 + pause IA
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO,
  INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR,
  messageLooksLikeFormSumarResponse,
  messageIsFlowResponsesReceived,
  messageIsFormularioSumarPreenchidoMarker,
  messageLooksLikeFormFollowUp,
  messageSignalsFormSubmissionAck,
  buildInscricaoFormCompleteReply,
  buildInscricaoFormFieldsIncompleteReply,
  buildAskCursoAfterFormReply,
  buildCursoIndisponivelAlternativasReply,
  buildCursoIndisponivelSemAlternativasReply,
  buildCursoOficialSemCodigoCaptacaoReply,
  buildFormNotReceivedResendReply,
  matriculaPosFormAlreadyProcessed,
  inscricaoFormAlreadyFilled,
  captacaoOrPosFormAdvanced,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
} from '../libShared/inscricaoFormHeuristics.js'
import { findLastFormularioSumSentMs, noteBlob, noteCreatedMs } from '../libShared/kommoFormNotes.js'
import { sendMessageWithNote } from './whatsappSender.js'
import { deliverInscricaoForm } from './inscricaoFormFlow.js'
import { fetchLeadFormSnapshot, validateFormSnapshot } from './inscricaoKommoFields.js'
import { messageLooksLikeEduitFlowFormReply, snapshotHasFormIdentity } from '../libShared/eduitFlowFormParse.js'
import {
  resolvePoloFromKommoSnapshot,
  matchPoloFromUserMessage,
  resolvePoloUnidadeCode,
  buildPoloEscolhaPreFormMessage,
  SUMARE_POLOS_EAD,
} from '../libShared/sumarePoloCatalog.js'
import { extractCursoAreaFromText, messageIsBareCourseSelection } from '../libShared/cursoConfirmation.js'
import { normalizeMessageForScope } from '../libShared/scopeHeuristics.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { listLeadNotes, listLeadEvents, createLeadAuditNote } from './kommoClient.js'
import { isEduitBackend, resolveCrmLeadId } from './crmAdapter.js'
import { isEduitCuid } from './eduitClient.js'
import { moveLeadToAguardandoPagamentoIfNeeded } from './kommoFunnelMoves.js'
import {
  updateDadosCliente,
  marcarClienteIA,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
} from './dadosClienteStore.js'
import { DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { isSumareCaptacaoEnabled } from './sumareCaptacaoClient.js'
import {
  leadHasPostFormRegistradoNote,
  leadHasPostFormRegistradoNoteSinceLastFormSend,
  leadHasCaptacaoContratoNote,
} from './postFormSendGuard.js'
import { getAgentQueueSessionCutoffIso } from './agentQueueSession.js'
import {
  buildFacultyContactRedirectReply,
  replyLooksLikeFacultyContactRedirect,
} from '../libShared/humanHandoffHeuristics.js'
import {
  runMatriculaCaptacaoAfterForm,
  shouldRunSalesbot49813,
} from './matriculaCaptacaoPipeline.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'
const MATRICULA_BOT_ID_DEFAULT = 49813

/** Claim em memória quando não há linha em dados_cliente_sum (form enviado só via Kommo). */
const matriculaClaimMem = new Map()

function matriculaClaimMemKey(telefone) {
  return normalizeTelefone(telefone)
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function getClienteRow(env, telefone) {
  return fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
}

async function setFormStatus(env, telefone, status) {
  return updateDadosCliente(env, { telefone, fields: { [FORM_STATUS_FIELD]: status } })
}

/**
 * Claim atômico: marca concluído antes do salesbot 49813 — evita 5 disparos em réplicas paralelas.
 */
async function ensureClienteRowForMatricula(env, telefone, leadId) {
  let row = await getClienteRow(env, telefone)
  if (row?.id != null) return row
  if (leadId != null) {
    await marcarClienteIA(env, { telefone, idLead: leadId }).catch(() => {})
    row = await getClienteRow(env, telefone)
    if (row?.id != null) return row
  }
  return null
}

async function claimMatriculaPosFormExclusive(env, telefone, { leadId, userMessage } = {}) {
  const { url, key, table } = getSupabaseCfg(env)
  const memKey = matriculaClaimMemKey(telefone)
  try {
    const existing = await getClienteRow(env, telefone)
    if (matriculaPosFormAlreadyProcessed(existing)) {
      return {
        claimed: false,
        reason: 'matricula_already_processed',
        status: existing?.[FORM_STATUS_FIELD],
      }
    }

    // Defesa em profundidade: mesmo que o pipeline chame o claim (ex.: caller
    // futuro sem o early-return), aguardando_distribuicao_form só libera com
    // indício de curso — nunca reabre a captação vazia de novo.
    const existingStatus = existing?.[FORM_STATUS_FIELD]
    if (
      existingStatus === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO &&
      !looksLikeCursoAnswerForAguardandoDistribuicao(userMessage)
    ) {
      return { claimed: false, reason: 'awaiting_curso_from_lead', status: existingStatus }
    }

    let rowId = existing?.id != null ? Number(existing.id) : NaN
    if (!Number.isFinite(rowId) || rowId <= 0) {
      await ensureClienteRowForMatricula(env, telefone, leadId)
      const again = await getClienteRow(env, telefone)
      rowId = again?.id != null ? Number(again.id) : NaN
    }

    if (!Number.isFinite(rowId) || rowId <= 0) {
      if (!url || !key) return { claimed: false, reason: 'no_supabase' }
      const prev = matriculaClaimMem.get(memKey)
      if (prev && Date.now() - prev.at < 120_000) {
        return { claimed: false, reason: 'memory_claim_busy' }
      }
      matriculaClaimMem.set(memKey, { at: Date.now(), leadId: leadId ?? null })
      console.log(`[inscricaoPostForm] claim memória telefone=${telefone} (sem dados_cliente_sum)`)
      return { claimed: true, reason: 'memory_claim_no_row' }
    }

    if (!url || !key) return { claimed: false, reason: 'no_supabase' }
    const waiting = [
      INSCRICAO_FORM_STATUS_AGUARDANDO,
      INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
    ].join(',')

    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?id=eq.${rowId}&${FORM_STATUS_FIELD}=in.(${waiting})&inscricao_form_recebido_at=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_CONCLUIDO }),
      },
    )
    if (!res.ok) {
      const errBody = await res.text().catch(() => '')
      return { claimed: false, reason: `patch_${res.status}`, detail: errBody.slice(0, 200) }
    }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length === 1) {
      return { claimed: true, reason: 'claimed_waiting_status' }
    }
    const row = await getClienteRow(env, telefone)
    if (matriculaPosFormAlreadyProcessed(row)) {
      return { claimed: false, reason: 'matricula_already_processed', status: row?.[FORM_STATUS_FIELD] }
    }
    const st = row?.[FORM_STATUS_FIELD] ?? null
    if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) {
      return { claimed: false, reason: 'already_completed', status: st }
    }
    if (!matriculaPosFormAlreadyProcessed(row)) {
      const prev = matriculaClaimMem.get(memKey)
      if (prev && Date.now() - prev.at < 120_000) {
        return { claimed: false, reason: 'memory_claim_busy' }
      }
      matriculaClaimMem.set(memKey, { at: Date.now(), leadId: leadId ?? null })
      console.log(
        `[inscricaoPostForm] claim memória telefone=${telefone} (status=${st || 'n/a'} sem patch aguardando)`,
      )
      return { claimed: true, reason: 'memory_claim_stale_status' }
    }
    return { claimed: false, reason: 'no_waiting_row', status: st }
  } catch (err) {
    return { claimed: false, reason: `claim_error_${err.message}` }
  }
}

async function resolveLeadId(env, telefone, leadIdHint) {
  return resolveCrmLeadId(env, telefone, leadIdHint)
}

async function pauseAtendimentoIa(env, telefone) {
  return updateDadosCliente(env, { telefone, fields: { atendimento_ia: 'pause' } })
}

/**
 * Registra nota de auditoria no Kommo sempre que o pós-form/captação NÃO
 * conseguir concluir o atendimento automaticamente (falha terminal, redirect
 * faculdade, lead não encontrado, polo/curso ausente sem resolução).
 * Best-effort: nunca lança, apenas loga se a criação da nota falhar.
 */
async function noteAtendimentoNaoConcluido(env, {
  leadId, executionId, code, reason, detail, replyKind,
}) {
  if (!leadId) return
  const parts = [
    '[AUDITORIA] Atendimento não concluído automaticamente',
    `code=${code || 'n/a'}`,
    `motivo=${reason || 'n/a'}`,
  ]
  if (detail) parts.push(`detalhe=${String(detail).slice(0, 400)}`)
  if (replyKind) parts.push(`reply=${replyKind}`)
  if (executionId) parts.push(`EX=${executionId}`)
  await createLeadAuditNote(env, leadId, parts.join(' | ')).catch((e) =>
    console.warn('[inscricaoPostForm] audit note failed', e?.message || e),
  )
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

function shouldTriggerMatriculaPosForm(userMessage, status) {
  if (messageSignalsFormSubmissionAck(userMessage)) return true
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO ||
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
  ) {
    return messageLooksLikeFormFollowUp(userMessage, { strictAwaitingForm: true })
  }
  return false
}

/**
 * Lead respondeu algo que pode ser o NOME DO CURSO enquanto o status é
 * aguardando_distribuicao_form (pedimos o curso após o form ter chegado sem
 * essa informação — buildAskCursoAfterFormReply). Usado para distinguir um
 * avanço legítimo (lead informou o curso) de um reprocessamento indevido
 * disparado só por kommoFormDone/schedulerTick (a nota do Kommo continua
 * "detectável" para sempre, então sem esse filtro o pipeline reentrava em
 * loop e podia acabar no faculty redirect — caso Thiago #24121875).
 */
function looksLikeCursoAnswerForAguardandoDistribuicao(userMessage) {
  const raw = String(userMessage || '').trim()
  if (!raw) return false
  if (messageIsFlowResponsesReceived(raw) || messageIsFormularioSumarPreenchidoMarker(raw)) return false
  if (messageLooksLikeFormSumarResponse(raw)) return false
  if (messageIsBareCourseSelection(raw, [])) return true
  if (extractCursoAreaFromText(raw)) return true
  const t = normalizeMessageForScope(raw).toLowerCase().trim()
  if (t.length < 3) return false
  if (/^\s*(obrigad[oa]s?|ok(ay)?|sim|n[aã]o|pronto|feito|done|blz|beleza)\s*[.!?]*\s*$/i.test(t)) return false
  return true
}

function eventCreatedMs(ev) {
  const c = ev?.created_at
  if (c == null) return 0
  if (typeof c === 'number') return c < 1e12 ? c * 1000 : c
  const t = Date.parse(c)
  return Number.isNaN(t) ? 0 : t
}

/**
 * O Flow do Form Sumar no WhatsApp costuma NÃO virar nota inbound com texto
 * ("Flow responses received" fica só no chat Amojo). Detectamos por:
 *   1) nota com texto de flow / respostas recebidas
 *   2) eventos custom_field_*_value_changed após Formulario_Sum
 *   3) snapshot do lead no Kommo com campos obrigatórios preenchidos
 */
export async function detectFormSumarRecebidoNoKommo(env, leadId, options = {}) {
  const rawId = String(leadId ?? '').trim()
  if (isEduitBackend(env) || isEduitCuid(rawId)) {
    if (!isEduitCuid(rawId)) return { detected: false, reason: 'invalid_lead' }
    const snapRes = await fetchLeadFormSnapshot(env, rawId)
    if (!snapRes.ok || !snapRes.snapshot) {
      return { detected: false, reason: 'eduit_snapshot_unavailable' }
    }
    const snap = validateFormSnapshot(env, snapRes.snapshot)
    if (snap.valid) {
      return {
        detected: true,
        source: 'eduit_snapshot',
        sample: String(snapRes.snapshot.cpf || snapRes.snapshot.nome || '').slice(0, 120),
      }
    }
    // Identity do Flow (nome+CPF ou CPF+e-mail) conta como formulário recebido.
    // Campos faltantes (e-mail, curso) pedem-se depois — nunca "não recebemos".
    if (snapshotHasFormIdentity(snapRes.snapshot)) {
      return {
        detected: true,
        source: 'eduit_form_identity',
        missing: snap.missingFields,
        sample: String(snapRes.snapshot.cpf || snapRes.snapshot.nome || '').slice(0, 120),
      }
    }
    return { detected: false, reason: 'eduit_snapshot_incomplete', missing: snap.missingFields }
  }

  const id = Number(leadId)
  if (!Number.isFinite(id) || id <= 0) return { detected: false, reason: 'invalid_lead' }

  const maxAgeH = Number(env.INSCRICAO_FORM_KOMMO_NOTE_MAX_AGE_H || 48)
  const maxAgeMs = (Number.isFinite(maxAgeH) && maxAgeH > 0 ? maxAgeH : 48) * 3600000
  const now = Date.now()
  const minNoteAfterMs = options.minNoteAfterIso ? Date.parse(options.minNoteAfterIso) : NaN

  const notesRes = await listLeadNotes(env, id, { limit: 60, order: 'desc' })
  const notes = notesRes.ok && Array.isArray(notesRes.notes) ? notesRes.notes : []
  // Cap por idade: nota de formulário fora da janela (ex.: dias atrás após um
  // reset) NÃO deve ancorar a detecção por eventos de campo/snapshot — senão o
  // pós-formulário re-dispara sobre dados velhos e pausa a IA (distribuir_consultor).
  const formSentMs = findLastFormularioSumSentMs(notes, { maxAgeMs, nowMs: now })
  const afterMs = Math.max(
    Number.isFinite(minNoteAfterMs) && !Number.isNaN(minNoteAfterMs) ? minNoteAfterMs : 0,
    formSentMs > 0 ? formSentMs - 60_000 : 0,
  )

  // Snapshot do lead no Kommo (CPF/nome/email/curso) validado uma única vez.
  // A matrícula lê os dados DAQUI (fetchLeadFormSnapshot), não do texto da nota —
  // então uma nota com estrutura de formulário mas campos ausentes/`n/a` NÃO é
  // uma submissão real. Tratá-la como tal disparava matrícula vazia e pausava a IA.
  let _snapCache
  async function getSnapValidation() {
    if (_snapCache) return _snapCache
    const snapRes = await fetchLeadFormSnapshot(env, id)
    if (snapRes.ok && snapRes.snapshot) {
      _snapCache = { ...validateFormSnapshot(env, snapRes.snapshot), snapshot: snapRes.snapshot, ok: true }
    } else {
      _snapCache = { valid: false, missingFields: [], snapshot: null, ok: false }
    }
    return _snapCache
  }

  let incompleteFormSample = null
  for (const n of notes) {
    const ts = noteCreatedMs(n)
    if (ts && now - ts > maxAgeMs) continue
    if (afterMs && ts && ts < afterMs) continue
    const blob = noteBlob(n)
    // Marcador real do Flow ("Flow responses received"): conclusão legítima do Flow.
    if (messageIsFlowResponsesReceived(blob)) {
      return { detected: true, source: 'kommo_note_flow', sample: blob.slice(0, 120) }
    }
    // Nota com ESTRUTURA de formulário (CPF:/NOME:/EMAIL:…): só conta como recebida
    // se os campos obrigatórios chegaram de fato no lead do Kommo. Sem isso, era a
    // causa do lead pausado com formulário vazio (`n/a`) — agora não pausa e a IA
    // continua atendendo até o formulário real chegar.
    if (messageLooksLikeFormSumarResponse(blob)) {
      const snap = await getSnapValidation()
      if (!snap.valid) {
        incompleteFormSample = blob.slice(0, 120)
        continue
      }
      return { detected: true, source: 'kommo_note', sample: blob.slice(0, 120) }
    }
  }

  if (formSentMs > 0) {
    const fromTs = Math.max(0, Math.floor((afterMs || formSentMs) / 1000))
    const evRes = await listLeadEvents(env, id, { types: [], limit: 80, fromTs })
    if (evRes.ok && Array.isArray(evRes.events)) {
      let fieldChanges = 0
      for (const ev of evRes.events) {
        const ts = eventCreatedMs(ev)
        if (ts && ts < afterMs) continue
        const t = String(ev?.type || '').toLowerCase()
        if (/^custom_field_\d+_value_changed$/.test(t)) fieldChanges += 1
      }
      const minChanges = Number(env.INSCRICAO_FORM_KOMMO_FIELD_CHANGES_MIN)
      const need = Number.isFinite(minChanges) && minChanges > 0 ? Math.floor(minChanges) : 2
      if (fieldChanges >= need) {
        return {
          detected: true,
          source: 'kommo_field_events',
          sample: `${fieldChanges} alterações de campo após Formulario_Sum`,
        }
      }
    }

    const snap = await getSnapValidation()
    if (snap.ok && snap.snapshot) {
      // No tick do scheduler: snapshot preenchido não significa "formulário
      // acabou de chegar" — senão bloqueia flush de mensagens novas (ex.: "olá").
      if (snap.valid && !options.schedulerTick) {
        return {
          detected: true,
          source: 'kommo_snapshot',
          sample: `nome=${String(snap.snapshot.nome || '').slice(0, 40)} email=${String(snap.snapshot.email || '').slice(0, 40)}`,
        }
      }
    }
  }

  if (incompleteFormSample) {
    return { detected: false, reason: 'form_fields_incomplete', incomplete: true, sample: incompleteFormSample }
  }
  return { detected: false, reason: formSentMs > 0 ? 'not_found_after_form_sent' : 'no_formulario_sum_note' }
}

/**
 * Polo deve ter sido escolhido ANTES do formulário. Usa Supabase, card Kommo ou default env.
 */
async function preparePoloStepAfterForm(env, { telefone, leadId, pushName }) {
  const snapRes = leadId ? await fetchLeadFormSnapshot(env, leadId) : { ok: false }
  const snapshot = snapRes.ok ? snapRes.snapshot : {}

  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${DADOS_CLIENTE_INSCRICAO_SELECT},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloDb = String(row?.polo_inscricao_escolhido || '').trim()
  const unidadeDb = String(row?.captacao_unidade || '').trim()
  if (poloDb && unidadeDb) {
    const matched = matchPoloFromUserMessage(poloDb)
    // Prefere o código de unidade do catálogo (fonte única, já corrigida) ao
    // valor salvo no Supabase, que pode estar defasado (códigos antigos
    // ED_SP_P1..P4 davam HTTP 500 "NULL CANDIDATO" na Captação). Fallback no
    // valor salvo quando o polo não casa com o catálogo.
    const unidade = matched ? resolvePoloUnidadeCode(matched.id, env) : unidadeDb
    return {
      askPolo: false,
      snapshotOverride: { ...snapshot, unidade, polo_inscricao: poloDb },
      poloResolved: {
        polo: matched || { nome: poloDb, id: 'supabase' },
        unidade,
        source: 'supabase_pre_form',
      },
    }
  }

  const resolved = resolvePoloFromKommoSnapshot(snapshot, env)
  if (resolved) {
    return {
      askPolo: false,
      snapshotOverride: {
        ...snapshot,
        unidade: resolved.unidade,
        polo_inscricao: resolved.polo.nome,
      },
      poloResolved: resolved,
    }
  }

  const poloId = String(env.INSCRICAO_DEFAULT_POLO_ID || 'pinheiros').trim()
  const matched = matchPoloFromUserMessage(poloId) || SUMARE_POLOS_EAD.find((p) => p.id === poloId)
  if (matched) {
    const unidade = resolvePoloUnidadeCode(matched.id, env)
    console.warn(
      `[inscricaoPostForm] lead=${leadId} polo ausente no pré-form — fallback ${matched.nome} (${unidade})`,
    )
    return {
      askPolo: false,
      snapshotOverride: { ...snapshot, unidade, polo_inscricao: matched.nome },
      poloResolved: { polo: matched, unidade, source: 'fallback_default_polo' },
    }
  }

  return {
    askPolo: true,
    missingPolo: true,
    reply: buildPoloEscolhaPreFormMessage({ pushName }),
  }
}

/**
 * Executa captação Sumaré + salesbot fallback + pause (após polo definido).
 * @returns {Promise<{ ok, reply, steps, toolCalls, ctxForm, skipSchedulerWhatsapp }>}
 */
export async function executeCaptacaoAfterFormResolved(env, ctx) {
  const { telefone, idLead, executionId, pushName, snapshotOverride } = ctx
  const steps = []
  const toolCalls = []
  let reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
  let matriculaOk = false
  let ctxForm = 'completed'
  let skipSchedulerWhatsapp = false
  let contratoWhatsappSent = false
  /** Captação Sumaré falhou de forma definitiva (curso indisponível / dados
   * inválidos). Vai gravar `distribuir_consultor` no fim para parar o loop
   * do scheduler (Plano_Inscricao_CardKommo / lead #23608285). */
  let captacaoFailedTerminal = false
  let captacaoFailReason = ''
  /** Evita gravar nota de auditoria duplicada quando a falha já foi notada
   * na branch de captação e depois cai no bloco distribuir_consultor. */
  let auditNoted = false
  /** Step específico quando curso presente não resolve (com/sem alternativas). */
  let aguardandoDistribuicaoStep = 'aguardando_curso'

  if (isSumareCaptacaoEnabled(env)) {
    const cap = await runMatriculaCaptacaoAfterForm(env, {
      telefone,
      leadId: idLead,
      pushName,
      executionId,
      snapshotOverride,
      confirmedNovaInscricao: Boolean(ctx.confirmedNovaInscricao),
      useCandidatoId: ctx.useCandidatoId,
    })
    steps.push({
      type: 'sumare_captacao',
      ok: cap.ok,
      skipped: cap.skipped,
      candidato_id: cap.candidatoId,
      contract_url: cap.contractUrl,
      code: cap.code,
      error: cap.error,
    })
    if (cap.code === 'NEEDS_CONFIRM_NOVA_INSCRICAO' && cap.ok) {
      ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO
      reply = cap.reply || reply
      if (cap.whatsappOk) {
        skipSchedulerWhatsapp = true
        contratoWhatsappSent = true
      }
      matriculaOk = true
    } else if (cap.ok && !cap.skipped && (cap.contractUrl || cap.reply)) {
      matriculaOk = true
      ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
      reply = cap.reply || reply
      if (cap.whatsappOk) {
        skipSchedulerWhatsapp = true
        contratoWhatsappSent = true
      }
      matriculaClaimMem.delete(matriculaClaimMemKey(telefone))
      toolCalls.push({
        tool: 'sumare_captacao_contrato',
        args: { telefone, id_lead: idLead, candidato: cap.candidatoId },
        result: `Link contrato enviado: ${cap.contractUrl}`,
        ok: Boolean(cap.whatsappOk),
      })
    } else if (cap.skipped) {
      ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
      contratoWhatsappSent = true
      skipSchedulerWhatsapp = true
    } else if (!cap.skipped && !cap.ok) {
      const missing = Array.isArray(cap.missing) ? cap.missing.join(', ') : ''
      console.error(
        `[inscricaoPostForm] captação falhou lead=${idLead} code=${cap.code} missing=${missing} err=${String(cap.error || '').slice(0, 800)}`,
      )
      const missingArr = Array.isArray(cap.missing) ? cap.missing : []
      const alternativas = Array.isArray(cap.alternativas) ? cap.alternativas : []
      const cursoPedido = String(cap.cursoPedido || '').trim()
      const cursoPresentUnresolved =
        cap.code === 'CURSO_NAO_RESOLVIDO' || cap.code === 'CURSO_INVALIDO_SNAPSHOT'
      // Somente CURSO_AUSENTE: NÃO use !cursoPedido — MISSING_FIELDS (cpf/email/etc.)
      // não propaga cursoPedido mesmo com curso já resolvido (regressão pós-Amanda).
      const cursoReallyAbsent = cap.code === 'CURSO_AUSENTE'
      if (cap.code === 'CURSO_OFICIAL_SEM_CODIGO_CAPTACAO') {
        reply = buildCursoOficialSemCodigoCaptacaoReply({
          pushName,
          cursoPedido,
          precoResumo: cap.precoResumo,
        })
        aguardandoDistribuicaoStep = 'curso_oficial_sem_codigo_captacao'
        captacaoFailReason = 'curso_oficial_sem_codigo_captacao'
        await noteAtendimentoNaoConcluido(env, {
          leadId: idLead,
          executionId,
          code: cap.code,
          reason: 'curso oficial sem código de captação — não gerar vestibular',
          replyKind: 'curso_oficial_sem_codigo_captacao',
        })
        await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO).catch(() => {})
        ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
        captacaoFailedTerminal = false
        auditNoted = true
      } else if (cursoPresentUnresolved) {
        if (alternativas.length > 0) {
          reply = buildCursoIndisponivelAlternativasReply({ pushName, cursoPedido, alternativas })
          aguardandoDistribuicaoStep = 'curso_indisponivel_com_alternativas'
          captacaoFailReason = 'curso_indisponivel_com_alternativas'
          await noteAtendimentoNaoConcluido(env, {
            leadId: idLead,
            executionId,
            code: cap.code,
            reason: 'curso informado indisponível — apresentando alternativas',
            replyKind: 'curso_indisponivel_com_alternativas',
          })
        } else {
          reply = buildCursoIndisponivelSemAlternativasReply({ pushName, cursoPedido })
          aguardandoDistribuicaoStep = 'curso_indisponivel_sem_alternativas'
          captacaoFailReason = 'curso_indisponivel_sem_alternativas'
          await noteAtendimentoNaoConcluido(env, {
            leadId: idLead,
            executionId,
            code: cap.code,
            reason: 'curso informado indisponível — sem alternativas',
            replyKind: 'curso_indisponivel_sem_alternativas',
          })
        }
        await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO).catch(() => {})
        ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
        captacaoFailedTerminal = false
        auditNoted = true
      } else if (
        cursoReallyAbsent ||
        missingArr.includes('curso') ||
        missing.includes('curso')
      ) {
        reply = buildAskCursoAfterFormReply({ pushName })
        aguardandoDistribuicaoStep = 'aguardando_curso'
        await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO).catch(() => {})
        ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
        captacaoFailedTerminal = false
        captacaoFailReason = cap.code || 'curso_ausente'
        await noteAtendimentoNaoConcluido(env, {
          leadId: idLead,
          executionId,
          code: cap.code,
          reason: 'curso pendente — pedindo nome ao lead',
          replyKind: 'pedir_curso',
        })
        auditNoted = true
      } else if (cap.code === 'MISSING_FIELDS') {
        // Faltam campos além do curso (ex.: CPF, data de nascimento) — pede
        // os dados diretamente, sem prometer consultor nem usar o redirect
        // da faculdade (que é reservado para falhas realmente terminais).
        reply = buildInscricaoFormFieldsIncompleteReply({ pushName, missingFields: missingArr })
        captacaoFailedTerminal = true
        captacaoFailReason = `${cap.code || 'sem_code'}:${missing || cap.error || 'sem_detalhe'}`
        await noteAtendimentoNaoConcluido(env, {
          leadId: idLead,
          executionId,
          code: cap.code,
          reason: 'campos obrigatórios ausentes — pedindo dados ao lead',
          detail: missing || cap.error,
          replyKind: 'pedir_campos',
        })
        auditNoted = true
      } else {
        reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
        captacaoFailedTerminal = true
        captacaoFailReason = `${cap.code || 'sem_code'}:${missing || cap.error || 'sem_detalhe'}`
        await noteAtendimentoNaoConcluido(env, {
          leadId: idLead,
          executionId,
          code: cap.code,
          reason: 'falha terminal na captação — redirect faculdade',
          detail: missing || cap.error,
          replyKind: 'faculty_redirect',
        })
        auditNoted = true
      }
      toolCalls.push({
        tool: 'sumare_captacao_contrato',
        args: { telefone, id_lead: idLead },
        result: cap.error || cap.code || 'falha',
        ok: false,
      })
    }
  }

  if (!matriculaOk && (shouldRunSalesbot49813(env) || !isSumareCaptacaoEnabled(env))) {
    const salesbotRes = await runKommoSalesbot(env, idLead, 'matricula_pos_form', {
      executionId,
      note: `Form Sumar recebido — salesbot matrícula ${MATRICULA_BOT_ID_DEFAULT} (agente IA) — ${executionId || ''}`.trim(),
    })
    if (salesbotRes.ok) skipSchedulerWhatsapp = true
    matriculaOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
    steps.push({
      type: 'inscricao_form_complete',
      ok: matriculaOk,
      bot_id: salesbotRes.botId,
    })
    toolCalls.push({
      tool: 'matricula_pos_form',
      args: { telefone, id_lead: idLead },
      result: matriculaOk ? `Salesbot ${salesbotRes.botId} disparado` : salesbotRes.text || 'falha',
      ok: matriculaOk,
    })
    if (matriculaOk) {
      // Captação pode ter falhado no texto (faculty redirect) e o salesbot 49813
      // "salvar" o fluxo — NÃO manter o reply de falha (Diego #24127679:
      // "Registramos transferência" + "não consegui concluir" na mesma bolha).
      captacaoFailedTerminal = false
      if (replyLooksLikeFacultyContactRedirect(reply) || !String(reply || '').trim()) {
        reply = buildInscricaoFormCompleteReply({ pushName, ok: true })
      }
      if (!isSumareCaptacaoEnabled(env)) {
        await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
        ctxForm = 'completed'
      } else if (
        ctxForm !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE &&
        ctxForm !== INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO
      ) {
        ctxForm = INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE
      }
    }
  }

  if (!isSumareCaptacaoEnabled(env) && !matriculaOk) {
    reply = buildInscricaoFormCompleteReply({ pushName, ok: false })
  }

  if (ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    // Após enviar o link, IA generativa fica em pausa operacional, mas o scheduler
    // continua drenando o buffer (decideHoldOnIaPause hold=false). tryHandleMatriculaAceitePagamentoFlow
    // responde reenvio de link, comprovante e dúvidas sobre próximos passos.
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE).catch(() => {})
    const pauseRes = await pauseAtendimentoIa(env, telefone)
    steps.unshift({ type: 'ia_paused', ok: pauseRes.ok, reason: 'aguardando_aceite_contrato' })
    if (idLead) {
      const funnelMove = await moveLeadToAguardandoPagamentoIfNeeded(env, idLead, {
        reason: 'pos_captacao_aguardando_aceite',
      }).catch(() => ({ ok: false }))
      steps.unshift({ type: 'move_lead_aguardando_pagamento', ...funnelMove })
    }
  } else if (ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO) {
    // Curso pendente (ausente) OU curso informado indisponível (com/sem alternativas).
    // Mantém a IA ativa e o status aguardando_distribuicao — NÃO executa captação/contrato.
    steps.unshift({ type: aguardandoDistribuicaoStep, ok: true, reason: captacaoFailReason })
  } else if (captacaoFailedTerminal && !matriculaOk) {
    // Plano_Inscricao_CardKommo — captação falhou definitivamente e o salesbot
    // fallback também não rodou. Estado terminal evita o loop do scheduler
    // (que ficava reprocessando o mesmo lead a cada tick — caso CAIO SILVA).
    const pauseRes = await pauseAtendimentoIa(env, telefone)
    steps.unshift({
      type: 'ia_paused',
      ok: pauseRes.ok,
      reason: `distribuir_consultor:${captacaoFailReason}`,
    })
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR).catch(() => {})
    ctxForm = INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR
    if (!auditNoted) {
      await noteAtendimentoNaoConcluido(env, {
        leadId: idLead,
        executionId,
        code: 'DISTRIBUIR_CONSULTOR',
        reason: captacaoFailReason || 'falha terminal — distribuir consultor',
        replyKind: 'falha_terminal',
      })
      auditNoted = true
    }
  } else {
    const pauseRes = await pauseAtendimentoIa(env, telefone)
    steps.unshift({ type: 'ia_paused', ok: pauseRes.ok })
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_CONCLUIDO).catch(() => {})
    ctxForm = INSCRICAO_FORM_STATUS_CONCLUIDO
  }

  return {
    ok: matriculaOk || ctxForm === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
    matriculaOk,
    reply,
    steps,
    toolCalls,
    ctxForm,
    skipSchedulerWhatsapp,
    contratoWhatsappSent,
  }
}

/**
 * Form preenchido → pergunta polo (se necessário) → API Captação → salesbot 49813 fallback.
 */
async function stepMatriculaPosForm(env, ctx) {
  const { telefone, idLead, executionId, model, pushName, t0, kommoFormDetected, userMessage } = ctx

  if (idLead != null && (await leadHasPostFormRegistradoNoteSinceLastFormSend(env, idLead))) {
    console.log(`[inscricaoPostForm] lead=${idLead} skip matricula_pos_form (nota pós-form após último Formulario_Sum)`)
    return { handled: false, reason: 'kommo_post_form_note_exists' }
  }

  const poloPrep = await preparePoloStepAfterForm(env, { telefone, leadId: idLead, pushName })

  if (poloPrep?.missingPolo) {
    await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_POLO).catch(() => {})
    await noteAtendimentoNaoConcluido(env, {
      leadId: idLead,
      executionId,
      code: 'POLO_AUSENTE_POS_FORM',
      reason: 'polo não localizado após form',
      replyKind: 'pedir_polo',
    })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply: poloPrep.reply,
        steps: [{ type: 'polo_ausente_pos_form', ok: false }],
        ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO },
      }),
    }
  }

  const claim = await claimMatriculaPosFormExclusive(env, telefone, { leadId: idLead, userMessage })
  if (!claim.claimed) {
    console.log(
      `[inscricaoPostForm] lead=${idLead} matricula_pos_form skip claim=${claim.reason} status=${claim.status || 'n/a'}`,
    )
    if (kommoFormDetected) {
      const pushFirst = pushName ? String(pushName).split(/\s+/)[0] : ''
      const nameBit = pushFirst ? `, ${pushFirst}` : ''
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply:
            `Obrigado${nameBit}! Recebemos seu formulário e já estamos processando sua inscrição no sistema. ` +
            `Em instantes você recebe aqui o link para aceitar o contrato e concluir o pagamento.`,
          steps: [{ type: 'matricula_claim_deferred', ok: false, reason: claim.reason }],
          ctxSnapshot: {
            inscricaoForm: claim.status || INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
            kommoFormDetected: true,
          },
        }),
      }
    }
    return { handled: false, reason: claim.reason || 'matricula_claim_failed' }
  }

  const capOut = await executeCaptacaoAfterFormResolved(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    snapshotOverride: poloPrep?.snapshotOverride,
  })

  await updateDadosCliente(env, {
    telefone,
    fields: { inscricao_form_recebido_at: new Date().toISOString() },
  }).catch(() => {})

  const steps = capOut.steps || []
  if (poloPrep?.poloResolved) {
    steps.unshift({
      type: 'polo_kommo_card',
      polo: poloPrep.poloResolved.polo?.nome,
      unidade: poloPrep.poloResolved.unidade,
      source: poloPrep.poloResolved.source,
    })
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: capOut.reply,
      steps,
      toolCalls: capOut.toolCalls,
      ctxSnapshot: {
        inscricaoForm: capOut.ctxForm,
        iaPaused: capOut.ctxForm !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
        sumareCaptacao: isSumareCaptacaoEnabled(env),
        contratoWhatsappSent: Boolean(capOut.contratoWhatsappSent),
        contratoLinkSent: Boolean(capOut.contratoWhatsappSent),
        skipSchedulerWhatsapp: capOut.skipSchedulerWhatsapp,
        kommoFormDetected,
      },
    }),
  }
}

/**
 * Pipeline pós-formulário: dispara 49813 assim que o formulário é detectado.
 * @param {boolean} [input.schedulerTick] — tick do scheduler (leads presos em aguardando_distribuicao)
 */
export async function tryProcessInscricaoPostFormPipeline(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0, schedulerTick } = input
  if (!telefone) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null

  if (matriculaPosFormAlreadyProcessed(row)) {
    console.log(
      `[inscricaoPostForm] skip telefone=${telefone} matricula_ja_processada status=${status || 'n/a'} recebido_at=${row?.inscricao_form_recebido_at || 'n/a'}`,
    )
    return null
  }

  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO) return null
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null
  if (status === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) return null
  if (status === INSCRICAO_FORM_STATUS_DISTRIBUIR_CONSULTOR) return null

  // Aguardando o NOME DO CURSO (pedimos após o form ter chegado sem essa
  // info): só reprocessa se o lead respondeu algo que pareça o curso. Sem
  // isso, kommoFormDone (nota do Kommo continua "detectável") ou schedulerTick
  // reentravam no pipeline sem curso — loop pedindo o curso de novo ou, em
  // builds antigas, redirect faculdade. Caso Thiago #24121875.
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO &&
    !looksLikeCursoAnswerForAguardandoDistribuicao(userMessage)
  ) {
    console.log(
      `[inscricaoPostForm] skip reprocess aguardando_curso telefone=${telefone} scheduler=${Boolean(schedulerTick)}`,
    )
    return null
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)

  if (
    idLead != null &&
    !messageSignalsFormSubmissionAck(userMessage) &&
    (await leadHasPostFormRegistradoNoteSinceLastFormSend(env, idLead))
  ) {
    console.log(`[inscricaoPostForm] lead=${idLead} skip pipeline (nota pós-form após último Formulario_Sum)`)
    return null
  }

  if (idLead != null && schedulerTick && (await leadHasCaptacaoContratoNote(env, idLead))) {
    console.log(
      `[inscricaoPostForm] lead=${idLead} skip pipeline scheduler (captação/contrato já registrado no Kommo)`,
    )
    return null
  }

  const waitingForForm = [
    INSCRICAO_FORM_STATUS_AGUARDANDO,
    INSCRICAO_FORM_STATUS_AGUARDANDO_DISTRIBUICAO,
  ].includes(status)

  let kommoFormDone = false
  let detectSource = ''
  const shouldScanKommoNotes =
    idLead &&
    (schedulerTick ||
      waitingForForm ||
      messageSignalsFormSubmissionAck(userMessage))

  if (shouldScanKommoNotes) {
    const sessionCutoff = getAgentQueueSessionCutoffIso(idLead)
    const recebidoAt = row?.inscricao_form_recebido_at || null
    const minNoteAfterIso =
      recebidoAt && sessionCutoff
        ? Date.parse(recebidoAt) >= Date.parse(sessionCutoff)
          ? recebidoAt
          : sessionCutoff
        : recebidoAt || sessionCutoff || null
    const det = await detectFormSumarRecebidoNoKommo(env, idLead, {
      minNoteAfterIso,
      schedulerTick: Boolean(schedulerTick),
    })
    kommoFormDone = Boolean(det.detected)
    detectSource = det.source || det.reason || ''
    if (kommoFormDone) {
      console.log(
        `[inscricaoPostForm] lead=${idLead} formulario_detectado source=${detectSource} scheduler=${Boolean(schedulerTick)} status=${status || 'n/a'}`,
      )
    }
  }

  // Atalho `schedulerTick && status === AGUARDANDO_DISTRIBUICAO` removido: o
  // early-return acima já bloqueia esse status sem resposta de curso do lead,
  // então manter o atalho aqui só reabriria o loop via schedulerTick.
  const trigger = shouldTriggerMatriculaPosForm(userMessage, status) || kommoFormDone

  if (!trigger) return null

  if (idLead == null) {
    if (schedulerTick) return { handled: false }
    await noteAtendimentoNaoConcluido(env, {
      leadId: leadIdHint,
      executionId,
      code: 'LEAD_NOT_FOUND',
      reason: 'lead não encontrado no Kommo após form',
      replyKind: 'faculty_redirect',
    })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        ok: false,
        reply: buildFacultyContactRedirectReply({ pushName }),
        steps: [{ type: 'inscricao_form_complete', ok: false, code: 'LEAD_NOT_FOUND' }],
      }),
    }
  }

  // B) Lead afirma ter enviado o formulário, mas nada foi detectado no
  // Kommo/DB: avisa que não recebemos e reenvia (forceResend). NUNCA por
  // "achismo" — exige claim explícito do lead (messageSignalsFormSubmissionAck)
  // + status pré-avanço + nada detectado no Kommo. Flow "Flow responses
  // received" / marcador interno NUNCA passam por aqui: são sinal de
  // conclusão real do Flow (mesmo que o snapshot ainda esteja frágil), e o
  // scheduler nunca reenvia por claim vazio (só avança com kommoFormDone).
  const isFlowCompletionSignal =
    messageIsFlowResponsesReceived(userMessage) ||
    messageIsFormularioSumarPreenchidoMarker(userMessage) ||
    messageLooksLikeEduitFlowFormReply(userMessage)

  if (
    !isFlowCompletionSignal &&
    !schedulerTick &&
    waitingForForm &&
    !kommoFormDone &&
    !inscricaoFormAlreadyFilled(row) &&
    !captacaoOrPosFormAdvanced(row) &&
    messageSignalsFormSubmissionAck(userMessage)
  ) {
    console.log(
      `[inscricaoPostForm] lead=${idLead} claim_sem_confirmacao_kommo status=${status || 'n/a'} — reenviando Formulario_Sum`,
    )
    const delivery = await deliverInscricaoForm(env, {
      telefone,
      leadId: idLead,
      executionId,
      forceResend: true,
    })
    const sendOk = Boolean(delivery.result?.ok)
    if (sendOk) {
      await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO).catch(() => {})
    }
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        ok: sendOk,
        reply: buildFormNotReceivedResendReply({ pushName }),
        steps: [
          {
            type: 'form_not_received_resend',
            ok: sendOk,
            delivery: delivery.delivery,
            code: delivery.result?.code,
          },
        ],
        ctxSnapshot: {
          inscricaoForm: sendOk ? INSCRICAO_FORM_STATUS_AGUARDANDO : status,
          formNotReceivedResent: true,
        },
      }),
    }
  }

  return stepMatriculaPosForm(env, {
    telefone,
    idLead,
    executionId,
    model,
    pushName,
    t0,
    kommoFormDetected: kommoFormDone,
    userMessage,
  })
}

/** Compat: agentRunner import antigo. */
export async function tryHandleInscricaoFormComplete(env, input) {
  return tryProcessInscricaoPostFormPipeline(env, input)
}

/** Liga o avanço pós-form legado no tick (extra além da detecção Kommo). */
export function isInscricaoPostFormSchedulerEnabled(env = process.env) {
  return String(env?.INSCRICAO_POST_FORM_SCHEDULER_ENABLED ?? 'false').trim().toLowerCase() === 'true'
}

/**
 * Scheduler: detecta formulário preenchido no Kommo (campos/eventos) mesmo sem
 * "Flow responses received" no buffer — roda após cada sync do poll.
 */
export async function tryAdvanceInscricaoPostFormScheduler(env, { telefone, leadId }) {
  return tryProcessInscricaoPostFormPipeline(env, {
    telefone,
    leadId,
    userMessage: '',
    executionId: `sched-insc-${Date.now()}`,
    model: 'scheduler',
    t0: Date.now(),
    schedulerTick: true,
  })
}
