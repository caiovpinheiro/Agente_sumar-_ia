/**
 * Fluxo inscrição Sumaré:
 *   início → salesbot Kommo "Formulario_Sum" (envia o formulário no WhatsApp)
 *   pós preenchimento → salesbot 49813 (matrícula) + pause IA
 *   (ver server/inscricaoPostFormPipeline.js)
 */

import {
  INSCRICAO_FORM_STATUS_AGUARDANDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM,
  INSCRICAO_FORM_STATUS_CONCLUIDO,
  INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO,
  inscricaoFormAlreadyFilled,
  messageConfirmsProceedToInscricaoForm,
  messageExpressesCourseInterestOnly,
  messageAsksForFormResend,
  messageIsCourseCatalogRequest,
  messageLooksLikeFormSumarResponse,
  messageLooksLikeFormFollowUp,
  buildInscricaoFormSentReply,
  lastAssistantText,
  assistantInEnrollmentStep,
  isShortEnrollmentConfirmation,
  shouldBlockFormularioSumResend,
} from '../libShared/inscricaoFormHeuristics.js'
import { messageLooksLikeOperationalChat } from '../libShared/scopeHeuristics.js'
import { messageAsksCoursePrice, sanitizeLeadInboundMessage } from '../libShared/inboundMessageSanitize.js'
import {
  buildPoloEscolhaPreFormMessage,
  matchPoloFromUserMessage,
  resolvePoloFromKommoSnapshot,
} from '../libShared/sumarePoloCatalog.js'
import { fetchLeadFormSnapshot } from './inscricaoKommoFields.js'
import { setSumCursoOnLead, syncSumPoloOnLeadQuiet } from './sumareLeadFields.js'
import { detectCursoConfirmadoPeloLead } from '../libShared/cursoConfirmation.js'
import { extractDiscussedCourseFromHistory } from '../libShared/conversationContextHeuristics.js'
import { sendFormSumarTemplate } from './whatsappTemplateSender.js'
import { runKommoSalesbot } from './kommoSalesbot.js'
import { isEduitBackend, resolveCrmLeadId } from './crmAdapter.js'
import {
  addDealTag,
  createDealNote as createEduitDealNote,
  isEduitCuid,
  resolveEduitFormularioTagId,
  resolveEduitStages,
  updateDealStage,
} from './eduitClient.js'
import { tryHandlePoloPreFormFlow } from './inscricaoPoloFlow.js'
import {
  updateDadosCliente,
  ensureDadosClienteRow,
  normalizeTelefone,
  fetchDadosClienteByTelefone,
  dadosClienteTelefoneOrFilter,
} from './dadosClienteStore.js'
import {
  filterHistoryMessagesForAgent,
  isAssistantFormSendPromiseOnly,
} from '../libShared/historySanitize.js'
import { DADOS_CLIENTE_FORM_GUARD_SELECT, DADOS_CLIENTE_INSCRICAO_SELECT } from './dadosClienteInscricaoFields.js'
import { gateMatriculaConfirmacaoBeforeForm } from './inscricaoMatriculaConfirmFlow.js'
import { moveLeadToInscricaoIfNeeded } from './kommoFunnelMoves.js'
import { buildFacultyContactRedirectReply } from '../libShared/humanHandoffHeuristics.js'

const FORM_STATUS_FIELD = 'inscricao_form_status'

/**
 * Lê status + inscricao_form_recebido_at para o guard de "formulário já preenchido".
 * @returns {Promise<{ inscricao_form_status: string|null, inscricao_form_recebido_at: string|null }|null>}
 */
async function getFormGuardRow(env, telefone) {
  return fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_INSCRICAO_SELECT)
}

function useWhatsappTemplateDelivery(env) {
  const mode = String(env.INSCRICAO_FORM_DELIVERY || 'kommo_salesbot').trim().toLowerCase()
  return mode === 'whatsapp_template' || mode === 'meta_template' || mode === 'template'
}

async function getFormStatus(env, telefone) {
  const row = await fetchDadosClienteByTelefone(env, telefone, FORM_STATUS_FIELD)
  return row?.[FORM_STATUS_FIELD] ?? null
}

function getSupabaseCfg(env) {
  return {
    url: (env.SUPABASE_URL || env.VITE_SUPABASE_URL || '').replace(/\/$/, ''),
    key: env.SUPABASE_KEY || env.VITE_SUPABASE_KEY || '',
    table: env.SUPABASE_DADOS_CLIENTE_TABLE || 'dados_cliente_sum',
  }
}

async function setFormStatus(env, telefone, status, leadIdHint) {
  await ensureDadosClienteRow(env, {
    telefone,
    idLead: leadIdHint,
    fields: { [FORM_STATUS_FIELD]: status },
  }).catch(() => {})
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: status },
  })
}

/** Lead pediu (re)envio do Form Sumar — ignora guardas de pós-formulário antigo no Kommo. */
export function leadExplicitlyRequestsInscricaoForm(userMessage, historyMessages) {
  return (
    messageAsksForFormResend(userMessage) ||
    messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)
  )
}

/** Resposta do LLM que promete envio sem confirmar entrega (deve disparar salesbot no servidor). */
export function llmReplyImpliesPendingFormSend(llmReply) {
  return isAssistantFormSendPromiseOnly(String(llmReply || ''))
}

/**
 * Claim atômico no Supabase: só um processo/réplica dispara o Formulario_Sum.
 * PATCH só quando inscricao_form_status ainda é null.
 */
async function releaseInscricaoFormStartClaim(env, telefone) {
  return updateDadosCliente(env, {
    telefone,
    fields: { [FORM_STATUS_FIELD]: null },
  })
}

async function claimInscricaoFormStartExclusive(env, telefone, leadIdHint) {
  const { url, key, table } = getSupabaseCfg(env)
  if (!url || !key) return { claimed: false, reason: 'no_supabase' }
  const telFilter = dadosClienteTelefoneOrFilter(telefone)
  if (!telFilter) return { claimed: false, reason: 'invalid_phone' }
  await ensureDadosClienteRow(env, { telefone, idLead: leadIdHint }).catch(() => {})
  try {
    const res = await fetch(
      `${url}/rest/v1/${encodeURIComponent(table)}?${telFilter}&${FORM_STATUS_FIELD}=is.null`,
      {
        method: 'PATCH',
        headers: {
          apikey: key,
          Authorization: `Bearer ${key}`,
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        },
        body: JSON.stringify({ [FORM_STATUS_FIELD]: INSCRICAO_FORM_STATUS_AGUARDANDO }),
      },
    )
    if (!res.ok) return { claimed: false, reason: `patch_${res.status}` }
    const rows = await res.json()
    if (Array.isArray(rows) && rows.length > 0) {
      return { claimed: true, reason: 'claimed_null_status' }
    }
    const status = await getFormStatus(env, telefone)
    return { claimed: false, reason: 'already_started', status }
  } catch (err) {
    return { claimed: false, reason: `claim_error_${err.message}` }
  }
}

async function resolveLeadId(env, telefone, leadIdHint) {
  return resolveCrmLeadId(env, telefone, leadIdHint)
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

async function resolvePoloEscolhidoParaForm(env, telefone, leadId) {
  const row = await fetchDadosClienteByTelefone(
    env,
    telefone,
    `${FORM_STATUS_FIELD},polo_inscricao_escolhido,captacao_unidade`,
  )
  const poloNome = String(row?.polo_inscricao_escolhido || '').trim()
  const unidade = String(row?.captacao_unidade || '').trim()
  if (poloNome && unidade) {
    await syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome })
    return { ok: true, poloNome, unidade, source: 'supabase' }
  }
  if (leadId != null) {
    const snapRes = await fetchLeadFormSnapshot(env, leadId)
    if (snapRes.ok && snapRes.snapshot) {
      const resolved = resolvePoloFromKommoSnapshot(snapRes.snapshot, env)
      if (resolved) {
        await syncSumPoloOnLeadQuiet(env, { leadId, telefone, poloNome: resolved.polo.nome })
        return {
          ok: true,
          poloNome: resolved.polo.nome,
          unidade: resolved.unidade,
          source: resolved.source,
        }
      }
    }
  }
  return { ok: false }
}

async function resolveEduitDealIdForForm(env, { leadId, telefone }) {
  if (isEduitCuid(leadId)) return String(leadId).trim()
  if (!telefone) return null
  const row = await fetchDadosClienteByTelefone(env, telefone, 'eduit_deal_id,id_lead')
  const fromRow = row?.eduit_deal_id || row?.id_lead
  return isEduitCuid(fromRow) ? String(fromRow).trim() : null
}

async function deliverInscricaoFormViaEduitTag(env, { telefone, leadId, executionId }) {
  const dealId = await resolveEduitDealIdForForm(env, { leadId, telefone })
  if (!dealId) {
    return {
      delivery: 'eduit_tag',
      result: {
        ok: false,
        code: 'LEAD_NOT_FOUND',
        error: 'Deal EduIT não localizado — necessário para aplicar a tag Formulario.',
      },
    }
  }

  const tagId = resolveEduitFormularioTagId(env)
  const tagged = await addDealTag(env, dealId, tagId)
  const sendOk = Boolean(tagged.ok)
  if (sendOk) {
    const stages = resolveEduitStages(env)
    if (stages.inscricao) {
      await updateDealStage(env, dealId, stages.inscricao).catch(() => {})
    }
    const note = `Tag Formulario aplicada (${tagId}) — ${executionId || ''}`.trim()
    await createEduitDealNote(env, dealId, note).catch(() => {})
  } else {
    console.warn(
      `[inscricaoForm] eduit tag failed deal=${dealId} tag=${tagId} code=${tagged.code || 'n/a'} status=${tagged.status || 'n/a'}`,
    )
  }
  return {
    delivery: 'eduit_tag',
    result: {
      ok: sendOk,
      skipped: false,
      code: tagged.code || (sendOk ? 'FORMULARIO_TAG_APPLIED' : 'FORMULARIO_TAG_FAILED'),
      tagId,
      dealId,
      status: tagged.status,
      error: tagged.error || null,
    },
  }
}

/** Dispara salesbot Formulario_Sum, automação EduIT ou template Meta (fallback legado). */
export async function deliverInscricaoForm(env, { telefone, leadId, executionId, forceResend = false }) {
  if (!forceResend && telefone) {
    const guardRow = await fetchDadosClienteByTelefone(env, telefone, DADOS_CLIENTE_FORM_GUARD_SELECT)
    if (shouldBlockFormularioSumResend(guardRow)) {
      console.log(
        `[inscricaoForm] deliver BLOCKED telefone=${telefone} status=${guardRow?.inscricao_form_status || 'n/a'} candidato=${guardRow?.captacao_candidato_id || 'n/a'}`,
      )
      return {
        delivery: 'kommo_salesbot',
        result: {
          ok: false,
          skipped: true,
          code: 'FORM_ALREADY_SENT',
          reason: 'form_already_sent_or_past_form',
        },
      }
    }
  }

  if (useWhatsappTemplateDelivery(env)) {
    const result = await sendFormSumarTemplate(env, { to: telefone, leadId, executionId })
    if (result?.ok && leadId) {
      await moveLeadToInscricaoIfNeeded(env, leadId, { reason: 'formulario_sum_template' }).catch(() => {})
    }
    return { delivery: 'whatsapp_template', result }
  }

  if (isEduitBackend(env)) {
    return deliverInscricaoFormViaEduitTag(env, { telefone, leadId, executionId })
  }

  if (leadId == null) {
    return {
      delivery: 'kommo_salesbot',
      result: {
        ok: false,
        code: 'LEAD_NOT_FOUND',
        error: 'Lead não localizado no Kommo — necessário para ativar o salesbot Formulario_Sum.',
      },
    }
  }

  const salesbotRes = await runKommoSalesbot(env, leadId, 'formulario_sum', {
    executionId,
    force: forceResend,
    note: `Salesbot Formulario_Sum ativado (inscrição via agente IA) — ${executionId || ''}`.trim(),
  })
  const sendOk = Boolean(salesbotRes.ok && !salesbotRes.skipped)
  if (sendOk) {
    await moveLeadToInscricaoIfNeeded(env, leadId, { reason: 'formulario_sum_enviado' }).catch(() => {})
  }
  return {
    delivery: 'kommo_salesbot',
    result: {
      ok: sendOk,
      skipped: Boolean(salesbotRes.skipped),
      reason: salesbotRes.reason,
      code: salesbotRes.code || (salesbotRes.ok ? 'SALESBOT_STARTED' : 'SALESBOT_FAILED'),
      botId: salesbotRes.botId,
      status: salesbotRes.status,
      error: salesbotRes.error || salesbotRes.reason || salesbotRes.text,
    },
  }
}

/**
 * Lead pediu inscrição → ativa salesbot Formulario_Sum (formulário no WhatsApp).
 */
export async function tryHandleInscricaoFormStart(env, input) {
  const { telefone, userMessage: rawMsg, executionId, model, leadId: leadIdHint, pushName, t0 } = input
  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const userMessage = sanitizeLeadInboundMessage(rawMsg)
  if (messageAsksCoursePrice(userMessage)) return null
  const wantsForm = messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)
  const asksResend = messageAsksForFormResend(userMessage)
  if (!telefone || (!wantsForm && !asksResend)) return null
  if (messageLooksLikeOperationalChat(userMessage) && !asksResend) return null

  const guardRow = await getFormGuardRow(env, telefone)
  const status = guardRow?.[FORM_STATUS_FIELD] ?? null
  // Formulário já preenchido (status pós-form ou recebido_at setado) → NUNCA
  // reativa o salesbot Formulario_Sum. Sem isto, o lead que já preencheu e volta
  // a conversar reativa o template "preencha o formulário" em loop. Exceção: lead
  // confirmando explicitamente uma NOVA inscrição em outro curso.
  if (
    inscricaoFormAlreadyFilled(guardRow) &&
    status !== INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO
  ) {
    console.log(
      `[inscricaoForm] lead=${leadIdHint ?? 'n/a'} telefone=${telefone} formulário já preenchido (status=${status}) — NÃO reativa Formulario_Sum`,
    )
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO) {
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM) {
    if (wantsForm || asksResend || isShortEnrollmentConfirmation(userMessage)) {
      const reply = buildPoloEscolhaPreFormMessage({ pushName })
      console.log(
        `[inscricaoForm] lead=${leadIdHint ?? 'n/a'} reenvio_lista_polo status=${status} telefone=${telefone}`,
      )
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'polo_escolha_pre_form_reminder', ok: true }],
          ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM },
        }),
      }
    }
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_AGUARDANDO && !asksResend && !wantsForm) {
    if (
      messageExpressesCourseInterestOnly(userMessage, historyMessages) ||
      messageIsCourseCatalogRequest(userMessage)
    ) {
      return null
    }
    if (messageLooksLikeFormFollowUp(userMessage) || messageAsksForFormResend(userMessage)) {
      const reply =
        'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'inscricao_form_reminder', status }],
          ctxSnapshot: { inscricaoForm: 'aguardando' },
        }),
      }
    }
    return null
  }

  const idLead = await resolveLeadId(env, telefone, leadIdHint)
  const cursoEscolhido =
    detectCursoConfirmadoPeloLead(userMessage, historyMessages) ||
    extractDiscussedCourseFromHistory(historyMessages)
  if (cursoEscolhido) {
    const cursoWrite = await setSumCursoOnLead(env, {
      leadId: idLead,
      telefone,
      cursoNome: cursoEscolhido,
    }).catch((err) => ({ ok: false, error: err.message }))
    console.log(
      `[inscricaoForm] SUM_CURSO curso="${cursoEscolhido}" ok=${cursoWrite?.ok} code=${cursoWrite?.code || cursoWrite?.error || 'n/a'} lead=${idLead ?? 'n/a'}`,
    )
  }
  const poloEscolhido = matchPoloFromUserMessage(userMessage, historyMessages)
  if (poloEscolhido) {
    const poloWrite = await syncSumPoloOnLeadQuiet(env, {
      leadId: idLead,
      telefone,
      poloNome: poloEscolhido.nome,
    })
    console.log(
      `[inscricaoForm] SUM_POLO polo="${poloEscolhido.nome}" ok=${poloWrite?.ok} code=${poloWrite?.code || poloWrite?.error || 'n/a'} lead=${idLead ?? 'n/a'}`,
    )
  }

  if (!asksResend && (wantsForm || messageAsksForFormResend(userMessage))) {
    const poloOk = await resolvePoloEscolhidoParaForm(env, telefone, idLead)
    if (!poloOk.ok) {
      await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM, idLead)
      const reply = buildPoloEscolhaPreFormMessage({ pushName })
      console.log(`[inscricaoForm] lead=${idLead ?? 'n/a'} aguardando_polo_pre_form telefone=${telefone}`)
      return {
        handled: true,
        result: buildAgentReturn({
          executionId,
          model,
          t0,
          reply,
          steps: [{ type: 'polo_escolha_pre_form', ok: true }],
          ctxSnapshot: { inscricaoForm: INSCRICAO_FORM_STATUS_AGUARDANDO_POLO_PRE_FORM },
        }),
      }
    }
  }

  if (!asksResend) {
    const claim = await claimInscricaoFormStartExclusive(env, telefone, idLead)
    if (!claim.claimed) {
      const st = claim.status ?? (await getFormStatus(env, telefone))
      if (st === INSCRICAO_FORM_STATUS_AGUARDANDO) {
        const reply =
          'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
        return {
          handled: true,
          result: buildAgentReturn({
            executionId,
            model,
            t0,
            reply,
            steps: [{ type: 'inscricao_form_reminder', status: st, claim: claim.reason }],
            ctxSnapshot: { inscricaoForm: 'aguardando' },
          }),
        }
      }
      if (st === INSCRICAO_FORM_STATUS_CONCLUIDO) return null
    }
  }

  const matriculaGate = await gateMatriculaConfirmacaoBeforeForm(env, {
    telefone,
    userMessage,
    historyMessages,
    leadId: idLead,
    executionId,
    model,
    pushName,
    t0,
    asksResend,
  })
  if (!matriculaGate.proceed) {
    if (matriculaGate.handled) {
      console.log(`[inscricaoForm] lead=${idLead ?? 'n/a'} MATRICULA_RESUMO antes do form`)
      return { handled: true, result: matriculaGate.result }
    }
    return null
  }

  const delivery = await deliverInscricaoForm(env, {
    telefone,
    leadId: idLead,
    executionId,
    forceResend: asksResend,
  })
  const dedupeSkipped = Boolean(
    delivery.result?.skipped && delivery.delivery === 'kommo_salesbot',
  )
  const sendOk = Boolean(delivery.result?.ok)

  let statusUpdate = { ok: false, skipped: true }
  if (sendOk && asksResend) {
    statusUpdate = await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO, idLead)
  } else if (sendOk) {
    statusUpdate = { ok: true, skipped: false, matched: true }
  }

  if (dedupeSkipped && !asksResend) {
    const reply =
      'Já ativei o envio do formulário de inscrição por aqui. Quando terminar de preencher e enviar, nossa equipe segue com você automaticamente. Precisa de ajuda com algum campo?'
    return {
      handled: true,
      result: buildAgentReturn({
        executionId,
        model,
        t0,
        reply,
        steps: [{ type: 'inscricao_form_reminder', status: 'dedupe_salesbot' }],
        ctxSnapshot: { inscricaoForm: 'aguardando' },
      }),
    }
  }

  if (!sendOk && !asksResend) {
    await releaseInscricaoFormStartClaim(env, telefone).catch(() => {})
  }

  let whatsappReply = buildInscricaoFormSentReply({ pushName, resend: asksResend })
  if (!sendOk) {
    console.error(
      `[inscricaoForm] FALHA delivery=${delivery.delivery} telefone=${telefone} lead=${idLead ?? 'n/a'} err=${delivery.result?.error || delivery.result?.code}`,
    )
    // Falha técnica (bot não configurado, lead não localizado, etc.):
    // redirecionamento canônico — NUNCA prometer consultor ativo.
    whatsappReply = buildFacultyContactRedirectReply({ pushName })
  }

  const toolName = delivery.delivery === 'kommo_salesbot' ? 'formulario_sum_salesbot' : 'form_sumar_template'

  return {
    handled: true,
    result: buildAgentReturn({
      executionId,
      model,
      t0,
      reply: whatsappReply,
      steps: [
        {
          type: 'inscricao_form_start',
          delivery: delivery.delivery,
          ok: sendOk,
          bot_id: delivery.result?.botId,
          template: delivery.result?.template,
          status: delivery.result?.status,
        },
        { type: 'inscricao_form_status', ok: statusUpdate.ok, value: sendOk ? INSCRICAO_FORM_STATUS_AGUARDANDO : null },
      ],
      toolCalls: [
        {
          tool: toolName,
          args: { telefone, id_lead: idLead, delivery: delivery.delivery },
          result: sendOk ? 'Formulário disparado' : delivery.result?.error || delivery.result?.code,
          ok: sendOk,
        },
      ],
      ctxSnapshot: {
        inscricaoForm: sendOk ? 'form_started' : 'form_start_failed',
        delivery: delivery.delivery,
        salesbotId: delivery.result?.botId,
      },
    }),
  }
}

export { tryHandleInscricaoFormComplete } from './inscricaoPostFormPipeline.js'
export { tryHandleMatriculaAceitePagamentoFlow } from './inscricaoAceitePagamentoFlow.js'

export async function tryEnsureInscricaoFormSent(env, input) {
  const { telefone, userMessage: rawMsg, llmReply, leadId: leadIdHint } = input
  const historyMessages = filterHistoryMessagesForAgent(input.historyMessages || [])
  const userMessage = sanitizeLeadInboundMessage(rawMsg)
  if (!telefone) return null
  if (messageIsCourseCatalogRequest(userMessage)) return null

  const userConfirmed = messageConfirmsProceedToInscricaoForm(userMessage, historyMessages)
  const lastAssist = lastAssistantText(historyMessages)
  const llmPromisedForm =
    llmReply &&
    (llmReplyImpliesPendingFormSend(llmReply) ||
      (/\bformul[aá]rio\b/i.test(llmReply) &&
        /\b(enviad|enviar|mandar|enviando|whatsapp|instantes|ativar|preencher)\b/i.test(llmReply) &&
        !/\b(acabei de enviar|já enviei|já ativei)\b/i.test(llmReply))) &&
    (userConfirmed || assistantInEnrollmentStep(lastAssist))
  const should = userConfirmed || messageAsksForFormResend(userMessage) || llmPromisedForm
  if (!should) return null

  const guardRow = await getFormGuardRow(env, telefone)
  const status = guardRow?.[FORM_STATUS_FIELD] ?? null
  // Formulário já preenchido → não reativa o salesbot mesmo que o LLM tenha
  // prometido enviar (caminho pós-LLM). Cobre form-start E polo pré-form.
  if (
    inscricaoFormAlreadyFilled(guardRow) &&
    status !== INSCRICAO_FORM_STATUS_AGUARDANDO_CONFIRM_NOVA_INSCRICAO
  ) {
    console.log(
      `[inscricaoForm] tryEnsure lead=${leadIdHint ?? 'n/a'} telefone=${telefone} formulário já preenchido (status=${status}) — guarda contra reenvio`,
    )
    return null
  }
  if (status === INSCRICAO_FORM_STATUS_CONCLUIDO && !messageAsksForFormResend(userMessage)) return null
  if (
    status === INSCRICAO_FORM_STATUS_AGUARDANDO &&
    !messageAsksForFormResend(userMessage) &&
    !userConfirmed &&
    !llmPromisedForm
  ) {
    return null
  }

  const handled = await tryHandleInscricaoFormStart(env, {
    ...input,
    userMessage,
    historyMessages,
    leadId: leadIdHint,
  })
  if (handled?.handled) return handled

  const poloHandled = await tryHandlePoloPreFormFlow(env, {
    ...input,
    userMessage,
    historyMessages,
    leadId: leadIdHint,
  })
  if (poloHandled?.handled) return poloHandled

  if (llmPromisedForm) {
    console.warn(
      `[inscricaoForm] LLM prometeu formulário mas tryHandleInscricaoFormStart retornou null telefone=${telefone} status=${status || 'n/a'}`,
    )
  }
  return null
}

/** Tool/API: início do fluxo (salesbot Formulario_Sum por padrão). */
export async function runInscricaoFormStart(env, body) {
  const telefone = body?.telefone
  if (!telefone) return { ok: false, code: 'MISSING_TELEFONE' }
  const idLead = await resolveLeadId(env, telefone, body?.id_lead ?? body?.idLead)
  const forceResend = Boolean(body?.force || body?.resend)
  if (!forceResend) {
    const claim = await claimInscricaoFormStartExclusive(env, telefone, idLead)
    if (!claim.claimed) {
      const st = claim.status ?? (await getFormStatus(env, telefone))
      if (
        st === INSCRICAO_FORM_STATUS_AGUARDANDO ||
        st === INSCRICAO_FORM_STATUS_CONCLUIDO
      ) {
        return {
          ok: true,
          skipped: true,
          code: 'FORM_ALREADY_STARTED',
          message: 'Formulário já foi ativado para este lead.',
          status: st,
        }
      }
    }
  }
  const delivery = await deliverInscricaoForm(env, { telefone, leadId: idLead, forceResend })
  const sendOk = Boolean(delivery.result?.ok)
  const statusUpdate =
    sendOk && forceResend
      ? await setFormStatus(env, telefone, INSCRICAO_FORM_STATUS_AGUARDANDO, idLead)
      : sendOk
        ? { ok: true, skipped: false }
        : { ok: false, skipped: true }
  return {
    ok: sendOk,
    delivery: delivery.delivery,
    result: delivery.result,
    statusUpdate,
    message: sendOk
      ? 'Salesbot Formulario_Sum ativado (formulário enviado pelo Kommo).'
      : delivery.result?.error || delivery.result?.code,
  }
}
