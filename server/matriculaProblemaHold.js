/**
 * Hold temporário da matrícula: cadastro e Formulario seguem; só a captação/matrícula
 * é bloqueada. Aplica a tag Problema_Mat no deal EduIT; a automação do CRM avisa o lead.
 *
 * Desligar: MATRICULA_PROBLEMA_HOLD=false
 */

import { INSCRICAO_FORM_STATUS_PROBLEMA_MAT } from '../libShared/inscricaoFormHeuristics.js'
import { isEduitBackend, resolveCrmLeadId } from './crmAdapter.js'
import {
  addDealTag,
  createDealNote,
  isEduitCuid,
  isMatriculaProblemaHoldEnabled,
  resolveEduitProblemaMatTagId,
  resolveEduitProblemaMatAutomationId,
} from './eduitClient.js'
import {
  fetchDadosClienteByTelefone,
  updateDadosCliente,
} from './dadosClienteStore.js'

export const PROBLEMA_MAT_HOLD_CODE = 'PROBLEMA_MAT_HOLD'

export function isProblemaMatHoldDelivery(delivery) {
  return (
    delivery?.result?.code === PROBLEMA_MAT_HOLD_CODE ||
    delivery?.result?.hold === true ||
    delivery?.code === PROBLEMA_MAT_HOLD_CODE
  )
}

export function problemaMatHoldDeliveryResult({ tagId, dealId, already = false } = {}) {
  return {
    delivery: 'problema_mat_tag',
    result: {
      ok: true,
      skipped: false,
      hold: true,
      already,
      code: PROBLEMA_MAT_HOLD_CODE,
      tagId: tagId || null,
      dealId: dealId || null,
    },
  }
}

export function problemaMatHoldToolReturn(extra = {}) {
  return {
    ok: true,
    code: PROBLEMA_MAT_HOLD_CODE,
    text: 'Hold temporário da matrícula: tag Problema_Mat aplicada. A automação informa o lead.',
    replyOverride: '',
    skipLeadReply: true,
    ctxSnapshot: {
      inscricaoForm: INSCRICAO_FORM_STATUS_PROBLEMA_MAT,
      ...(extra.ctxSnapshot || {}),
    },
    steps: [
      {
        type: 'tool_action',
        tool: extra.tool || 'enviar_form_sumar_inscricao',
        ok: true,
        code: PROBLEMA_MAT_HOLD_CODE,
      },
    ],
  }
}

/**
 * Aplica a tag (se ainda não estiver em hold) e pausa a inscrição.
 * Não dispara POST /automations/run — a tag aciona cmubbe71p36zbld01z049vy8x no CRM.
 */
export async function applyMatriculaProblemaHold(env, input = {}) {
  const { telefone, leadId, executionId, reason = 'ready_for_enrollment' } = input
  if (!isMatriculaProblemaHoldEnabled(env)) {
    return { ok: false, skipped: true, code: 'HOLD_DISABLED' }
  }

  let dealId = isEduitCuid(leadId) ? String(leadId).trim() : null
  if (!dealId) {
    const resolved = await resolveCrmLeadId(env, telefone, leadId)
    if (isEduitCuid(resolved)) dealId = String(resolved).trim()
  }

  const row = telefone
    ? await fetchDadosClienteByTelefone(env, telefone, 'inscricao_form_status,atendimento_ia')
    : null
  const already = String(row?.inscricao_form_status || '').trim() === INSCRICAO_FORM_STATUS_PROBLEMA_MAT
  const tagId = resolveEduitProblemaMatTagId(env)

  if (!already && dealId && isEduitBackend(env)) {
    const tagged = await addDealTag(env, dealId, tagId)
    if (!tagged.ok) {
      console.warn(
        `[problema-mat] tag failed deal=${dealId} tag=${tagId} code=${tagged.code || 'n/a'} status=${tagged.status || 'n/a'}`,
      )
      return {
        ok: false,
        code: tagged.code || 'TAG_FAILED',
        error: tagged.error,
        dealId,
        tagId,
      }
    }
    await createDealNote(
      env,
      dealId,
      `Tag Problema_Mat aplicada (${tagId}) — hold temporário da matrícula (${reason}) ${executionId || ''}`.trim(),
    ).catch(() => {})
  }

  if (telefone) {
    await updateDadosCliente(env, {
      telefone,
      fields: {
        inscricao_form_status: INSCRICAO_FORM_STATUS_PROBLEMA_MAT,
        atendimento_ia: 'pause',
      },
    }).catch(() => {})
  }

  console.log(
    `[problema-mat] hold deal=${dealId || 'n/a'} already=${already} reason=${reason} telefone=${telefone || 'n/a'}`,
  )
  return {
    ok: true,
    already,
    code: PROBLEMA_MAT_HOLD_CODE,
    tagId,
    dealId,
    automationId: resolveEduitProblemaMatAutomationId(env),
  }
}

export { isMatriculaProblemaHoldEnabled }
