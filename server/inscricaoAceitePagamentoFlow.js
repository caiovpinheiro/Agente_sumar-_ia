/**
 * Pós link do contrato: reenvio do link, lembrete de comprovante e recebimento do print.
 * Roda antes do gate atendimento_ia=pause (matrícula com captacao não pausa a IA nesta etapa).
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE,
  INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
  messageAsksContratoLinkResend,
  messageLooksLikePaymentProof,
  buildContratoLinkResendReply,
  buildPagamentoSemComprovanteReply,
  buildComprovantePagamentoRecebidoReply,
  buildPosMatriculaAguardandoFinalizacaoReply,
  messageLooksLikePosMatriculaFollowUp,
  messageIsComprovanteShortcutAck,
  messageRelatesToComprovanteEmConferencia,
  lastAssistantText,
} from '../libShared/inscricaoFormHeuristics.js'
import {
  resolveFutureMatriculaPaymentDeferral,
  buildFutureMatriculaPaymentDeferralReply,
} from '../libShared/deferredPaymentEnrollmentHeuristics.js'
import { messageIsInboundMediaPlaceholder } from '../libShared/scopeHeuristics.js'
import { buildFacultyContactRedirectReply } from '../libShared/humanHandoffHeuristics.js'
import { conversationMentionsTransferencia } from './inscricaoTransferenciaFlow.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
} from './dadosClienteStore.js'
import { resolveCrmLeadId, createLeadNote, updateLeadPipelineStatus } from './crmAdapter.js'
import { fetchCandidatoStatus } from './matriculaCaptacaoPipeline.js'
import {
  consultarStatusCandidato,
  extractCandidatoStatusString,
  resolvePortalUrlForCandidato,
} from './sumareCaptacaoClient.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

/** Fila pós-matrícula no Kommo (alunos aguardando instruções de início de curso). */
const POS_MATRICULA_PIPELINE_DEFAULT = 13756724
const POS_MATRICULA_STATUS_DEFAULT = 106426128

export function resolvePosMatriculaTarget(env = process.env) {
  const pipelineId =
    Number(env?.KOMMO_POS_MATRICULA_PIPELINE_ID) || POS_MATRICULA_PIPELINE_DEFAULT
  const statusId =
    Number(env?.KOMMO_POS_MATRICULA_STATUS_ID) || POS_MATRICULA_STATUS_DEFAULT
  return { pipelineId, statusId }
}

/** Janela de recência do atalho pós-comprovante (default 7 dias). Ausente/inválido = dentro. */
export function isComprovanteWithinShortcutWindow(captacaoComprovanteAt, env = process.env) {
  const raw = Number(env?.INSCRICAO_COMPROVANTE_SHORTCUT_MAX_AGE_DAYS)
  const maxDays = Number.isFinite(raw) && raw > 0 ? raw : 7
  if (captacaoComprovanteAt == null || String(captacaoComprovanteAt).trim() === '') return true
  const ts = Date.parse(String(captacaoComprovanteAt))
  if (!Number.isFinite(ts)) return true
  return Date.now() - ts <= maxDays * 24 * 60 * 60 * 1000
}

function normalizeReplyCompare(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
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

async function getClienteRow(env, telefone) {
  return fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},id_lead,captacao_contrato_link,captacao_candidato_id,captacao_comprovante_at,kommo_cpf`,
  )
}

async function claimComprovanteExclusive(env, telefone) {
  const row = await getClienteRow(env, telefone)
  if (row?.[FORM_STATUS_FIELD] !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) {
    return { claimed: false, reason: 'status_not_waiting', status: row?.[FORM_STATUS_FIELD], row }
  }
  const upd = await updateDadosCliente(env, {
    telefone,
    fields: {
      [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
      captacao_comprovante_at: new Date().toISOString(),
      atendimento_ia: 'pause',
    },
  })
  if (upd.ok && upd.matched) return { claimed: true, row }
  const again = await getClienteRow(env, telefone)
  if (again?.[FORM_STATUS_FIELD] === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) {
    return { claimed: false, reason: 'already_received', row: again }
  }
  return { claimed: false, reason: 'claim_update_failed', row: again }
}

function userClaimsPaidWithoutProof(text) {
  const t = String(text || '').toLowerCase()
  if (messageLooksLikePaymentProof(text)) return false
  return /\b(paguei|pagamento\s+feito|j[aá]\s+paguei|efetuei\s+o\s+pagamento)\b/i.test(t)
}

/**
 * @returns {Promise<{ handled: boolean, result?: object }|null>}
 */
export async function tryHandleMatriculaAceitePagamentoFlow(env, input) {
  const { telefone, userMessage, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  if (!telefone || !String(userMessage || '').trim()) return null

  const row = await getClienteRow(env, telefone)
  const status = row?.[FORM_STATUS_FIELD] ?? null
  let contractUrl = String(row?.captacao_contrato_link || '').trim()
  const candidatoId = String(row?.captacao_candidato_id || '').trim()

  if (status === INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO) {
    if (!isComprovanteWithinShortcutWindow(row?.captacao_comprovante_at, env)) {
      console.log(
        `[inscricaoAceite] telefone=${telefone} comprovante_shortcut_skip reason=stale_comprovante`,
      )
      return null
    }
    if (!messageRelatesToComprovanteEmConferencia(userMessage)) {
      console.log(
        `[inscricaoAceite] telefone=${telefone} comprovante_shortcut_skip reason=off_topic`,
      )
      return null
    }
    const followUp =
      messageLooksLikePosMatriculaFollowUp(userMessage) ||
      messageIsComprovanteShortcutAck(userMessage)
    const reply = followUp
      ? buildPosMatriculaAguardandoFinalizacaoReply({ pushName })
      : 'Já recebemos seu comprovante! Nossa equipe está conferindo e em breve você recebe as orientações por aqui, tudo bem?'
    const lastAssist = lastAssistantText(input.historyMessages || [])
    if (
      lastAssist &&
      normalizeReplyCompare(lastAssist) === normalizeReplyCompare(reply)
    ) {
      console.log(
        `[inscricaoAceite] telefone=${telefone} comprovante_shortcut_skip reason=repeat_reply`,
      )
      return null
    }
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: followUp ? 'pos_matricula_follow_up' : 'comprovante_already_received' }],
        ctxSnapshot: { inscricaoForm: status },
      }),
    }
  }

  if (status !== INSCRICAO_FORM_STATUS_AGUARDANDO_ACEITE) return null

  const historyMessages = input.historyMessages || []
  if (
    conversationMentionsTransferencia(historyMessages) &&
    !messageAsksContratoLinkResend(userMessage) &&
    !messageLooksLikePaymentProof(userMessage) &&
    !messageIsInboundMediaPlaceholder(userMessage)
  ) {
    return null
  }

  const idLead = await resolveCrmLeadId(env, telefone, leadIdHint)

  const sanitized = String(userMessage || '').trim()
  if (
    /\brecebi\s+o\s+link\b/i.test(sanitized) ||
    /\bobrigad[oa]\s+por\s+enviar\b/i.test(sanitized)
  ) {
    const reply = contractUrl
      ? buildContratoLinkResendReply({ pushName, contractUrl })
      : buildContratoLinkResendReply({ pushName, contractUrl: '' })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'contrato_link_clarify_resend', ok: Boolean(contractUrl) }],
        ctxSnapshot: { inscricaoForm: status, contractUrl: contractUrl || null },
      }),
    }
  }

  // Pagamento só em data futura: não reenvia link agora (antes do resend).
  // Comprovante / "já paguei" seguem o fluxo normal abaixo.
  if (
    !messageLooksLikePaymentProof(userMessage) &&
    !messageIsInboundMediaPlaceholder(userMessage) &&
    !userClaimsPaidWithoutProof(userMessage)
  ) {
    const deferral = resolveFutureMatriculaPaymentDeferral(userMessage, input.now)
    if (deferral) {
      const reply = buildFutureMatriculaPaymentDeferralReply({
        pushName,
        dateLabel: deferral.mentionedLabel,
      })
      if (idLead) {
        await createLeadNote(
          env,
          idLead,
          `Lead informou que só poderá pagar a matrícula em ${deferral.mentionedLabel}. ` +
            `Link do portal não reenviado neste turno; orientar retorno na data.`,
        ).catch(() => {})
      }
      console.log(
        `[inscricaoAceite] telefone=${telefone} pagamento_adiado date=${deferral.mentionedLabel}`,
      )
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [
            {
              type: 'contrato_pagamento_adiado',
              date_label: deferral.mentionedLabel,
              y: deferral.y,
              m: deferral.m,
              d: deferral.d,
            },
          ],
          ctxSnapshot: {
            inscricaoForm: status,
            pagamentoAdiado: true,
            dateLabel: deferral.mentionedLabel,
          },
        }),
      }
    }
  }

  if (messageAsksContratoLinkResend(userMessage)) {
    if (candidatoId) {
      const statusRes = await consultarStatusCandidato(env, candidatoId)
      const statusStr = extractCandidatoStatusString(statusRes.data)
      const portal = resolvePortalUrlForCandidato(env, candidatoId, statusStr, {
        cpf: row?.kommo_cpf || row?.cpf,
      })
      if (portal.url) contractUrl = portal.url

      const apiStatus = await fetchCandidatoStatus(env, candidatoId)
      if (apiStatus.alreadyEnrolled) {
        return {
          handled: true,
          result: buildAgentReturn({
            executionId,
            model,
            t0,
            reply:
              `Seu cadastro já consta como ${apiStatus.status || 'matriculado'} no sistema da Faculdade Sumaré. ` +
              buildFacultyContactRedirectReply({ pushName }),
            steps: [{ type: 'contrato_link_skip_already_enrolled', api_status: apiStatus.status }],
            ctxSnapshot: { inscricaoForm: status, apiStatus: apiStatus.status || null },
          }),
        }
      }
    }
    const portalPhase = /meiopagamento/i.test(contractUrl) ? 'pagamento' : 'contrato'
    const reply = buildContratoLinkResendReply({ pushName, contractUrl, portalPhase })
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'contrato_link_resend' }],
        ctxSnapshot: { inscricaoForm: status, contractUrl: contractUrl || null },
      }),
    }
  }

  const isProof =
    messageLooksLikePaymentProof(userMessage) || messageIsInboundMediaPlaceholder(userMessage)

  if (!isProof) {
    if (userClaimsPaidWithoutProof(userMessage)) {
      const reply = buildPagamentoSemComprovanteReply({ pushName, contractUrl })
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'pagamento_aguardando_comprovante' }],
          ctxSnapshot: { inscricaoForm: status },
        }),
      }
    }
    if (
      messageLooksLikePosMatriculaFollowUp(userMessage) ||
      /\bpr[oó]xim(os|as?)?\s+passos?\b/i.test(sanitized) ||
      /\b(o\s+que|como)\s+(fa[çc]o|prosseguir|continuar)\b/i.test(sanitized)
    ) {
      const portalPhase = /meiopagamento/i.test(contractUrl) ? 'pagamento' : 'contrato'
      const reply = contractUrl
        ? buildContratoLinkResendReply({ pushName, contractUrl, portalPhase })
        : buildPagamentoSemComprovanteReply({ pushName, contractUrl })
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'aceite_contrato_proximos_passos' }],
          ctxSnapshot: { inscricaoForm: status, contractUrl: contractUrl || null },
        }),
      }
    }
    return null
  }

  const claim = await claimComprovanteExclusive(env, telefone)
  if (!claim.claimed) {
    if (claim.reason === 'already_received') {
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply: buildPosMatriculaAguardandoFinalizacaoReply({ pushName }),
          steps: [{ type: 'comprovante_dedupe' }],
          ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO },
        }),
      }
    }
    return null
  }

  const reply = buildComprovantePagamentoRecebidoReply({ pushName })

  const toolCalls = []
  const steps = [
    { type: 'comprovante_pagamento_recebido', candidato_id: candidatoId || null },
  ]

  const { pipelineId, statusId } = resolvePosMatriculaTarget(env)

  if (idLead) {
    await createLeadNote(
      env,
      idLead,
      `Comprovante de pagamento recebido via WhatsApp (candidato ${candidatoId || 'n/a'}). ` +
        `Lead movido para fila pós-matrícula (pipeline ${pipelineId} / status ${statusId}) — ` +
        `aguardando instruções de início do curso.`,
    ).catch(() => {})

    const move = await updateLeadPipelineStatus(env, idLead, { pipelineId, statusId }).catch(
      (err) => ({ ok: false, error: err?.message || String(err) }),
    )
    steps.push({
      type: 'move_lead_pos_matricula',
      ok: Boolean(move?.ok),
      pipeline_id: pipelineId,
      status_id: statusId,
      error: move?.ok ? undefined : move?.error || move?.code,
    })
    toolCalls.push({
      tool: 'move_lead_pos_matricula',
      args: { id_lead: idLead, pipeline_id: pipelineId, status_id: statusId },
      result: move?.ok
        ? `Lead movido para pipeline=${pipelineId} status=${statusId}`
        : `Falha ao mover lead: ${move?.error || move?.code || 'unknown'}`,
      ok: Boolean(move?.ok),
    })
    console.log(
      `[inscricaoAceite] telefone=${telefone} lead=${idLead} comprovante_ok ` +
        `move_pos_matricula=${Boolean(move?.ok)} pipeline=${pipelineId} status=${statusId}`,
    )
  } else {
    steps.push({
      type: 'move_lead_pos_matricula',
      ok: false,
      pipeline_id: pipelineId,
      status_id: statusId,
      error: 'missing_lead_id',
    })
    console.warn(
      `[inscricaoAceite] telefone=${telefone} comprovante_ok mas sem id_lead — ` +
        `lead NÃO movido para pós-matrícula.`,
    )
  }

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply,
      steps,
      toolCalls,
      ctxSnapshot: {
        inscricaoForm: INSCRICAO_FORM_STATUS_COMPROVANTE_RECEBIDO,
        comprovanteRecebido: true,
        iaPaused: true,
        posMatriculaPipelineId: pipelineId,
        posMatriculaStatusId: statusId,
      },
    }),
  }
}
